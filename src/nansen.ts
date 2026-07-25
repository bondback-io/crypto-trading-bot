/**
 * Nansen.ai Smart Money discovery for Solana.
 *
 * Primary discovery uses POST /api/v1/smart-money/dex-trades (~5 credits):
 * aggregates unique Smart Money trader addresses from the last 24h of DEX activity.
 *
 * Optional enrichment uses POST /api/v1/profiler/address/pnl-summary (~1 credit each)
 * for win rate / realized PnL — opt-in only to conserve free credits.
 *
 * Results are cached in memory + data/nansen-wallets-cache.json so CSV/JSON
 * export/import can reuse lists without burning credits while testing.
 */

import fs from 'fs';
import {
  atomicWriteJson,
  dataFile,
  ensureDataDir,
  readJsonFile,
} from './dataDir';
import { config, upsertSmartWallet } from './config';
import { isValidSolanaAddress, inferWalletCategory } from './walletStore';

const NANSEN_BASE = 'https://api.nansen.ai';
const CACHE_FILE = 'nansen-wallets-cache.json';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min — avoid accidental re-fetch

export type NansenSmartMoneyLabel =
  | 'Fund'
  | 'Smart Trader'
  | '30D Smart Trader'
  | '90D Smart Trader'
  | '180D Smart Trader'
  | 'Smart HL Perps Trader';

export const NANSEN_LABELS: NansenSmartMoneyLabel[] = [
  'Fund',
  'Smart Trader',
  '30D Smart Trader',
  '90D Smart Trader',
  '180D Smart Trader',
  'Smart HL Perps Trader',
];

export interface NansenFilterPreset {
  id: string;
  name: string;
  description: string;
  labels: NansenSmartMoneyLabel[];
  /** Min trade size USD (filters noise / dust) */
  minTradeUsd: number;
  /** Suggested result limit after aggregation */
  limit: number;
  /** Credits estimate for one dex-trades page */
  creditsEstimate: number;
}

/** Suggested presets for high win-rate / profitable Smart Money discovery */
export const NANSEN_FILTER_PRESETS: NansenFilterPreset[] = [
  {
    id: 'best_overall',
    name: 'Best overall (recommended)',
    description:
      'Smart Trader + 30D/90D labels, min $500 trades — balance of skill labels and recent activity',
    labels: ['Smart Trader', '30D Smart Trader', '90D Smart Trader'],
    minTradeUsd: 500,
    limit: 50,
    creditsEstimate: 5,
  },
  {
    id: 'high_win_recent',
    name: 'High win-rate recent',
    description:
      '30D + 90D Smart Traders only, min $1k — Nansen’s shorter-window top performers',
    labels: ['30D Smart Trader', '90D Smart Trader'],
    minTradeUsd: 1000,
    limit: 40,
    creditsEstimate: 5,
  },
  {
    id: 'proven_long_term',
    name: 'Proven long-term',
    description:
      'All-time Smart Trader + 90D/180D — historically profitable across cycles',
    labels: ['Smart Trader', '90D Smart Trader', '180D Smart Trader'],
    minTradeUsd: 500,
    limit: 40,
    creditsEstimate: 5,
  },
  {
    id: 'funds',
    name: 'Funds only',
    description: 'Institutional Fund wallets with larger trade sizes',
    labels: ['Fund'],
    minTradeUsd: 5000,
    limit: 30,
    creditsEstimate: 5,
  },
  {
    id: 'active_traders',
    name: 'Most active (24h)',
    description:
      'Smart Trader + 30D with lower min size — ranks by 24h trade count / volume',
    labels: ['Smart Trader', '30D Smart Trader'],
    minTradeUsd: 100,
    limit: 50,
    creditsEstimate: 5,
  },
];

export interface NansenWallet {
  address: string;
  name: string;
  /** Primary Nansen label string */
  label: string;
  /** All observed labels / tags */
  labels: string[];
  tradeCount24h: number;
  volumeUsd24h: number;
  lastTradeAt: number | null;
  recentTokens: string[];
  winRate?: number;
  realizedPnlUsd?: number;
  realizedPnlPercent?: number;
  tradedTimes?: number;
  alreadyTracked: boolean;
  notes?: string;
  source: 'nansen';
}

export interface NansenDiscoverOptions {
  presetId?: string;
  labels?: NansenSmartMoneyLabel[];
  minTradeUsd?: number;
  limit?: number;
  /** Max pages of dex-trades (each page ≈ 5 credits). Default 1. */
  maxPages?: number;
  perPage?: number;
  force?: boolean;
}

export interface NansenDiscoverResult {
  ok: boolean;
  wallets: NansenWallet[];
  fetchedAt: number;
  cached: boolean;
  creditsUsed?: number | null;
  creditsRemaining?: number | null;
  message?: string;
  error?: string;
  retryAfterSec?: number;
  filters: {
    labels: string[];
    minTradeUsd: number;
    limit: number;
    presetId?: string;
  };
  nansen: NansenStatus;
}

export interface NansenStatus {
  hasApiKey: boolean;
  ok: boolean;
  lastFetchAt: number | null;
  lastError: string | null;
  lastCreditsUsed: number | null;
  lastCreditsRemaining: number | null;
  cachedCount: number;
  cacheAgeMs: number | null;
  setupHint: string | null;
  presets: NansenFilterPreset[];
}

interface DexTradeRow {
  chain?: string;
  block_timestamp?: string;
  trader_address?: string;
  trader_address_label?: string;
  token_bought_symbol?: string;
  token_sold_symbol?: string;
  trade_value_usd?: number | null;
}

interface CachePayload {
  fetchedAt: number;
  wallets: NansenWallet[];
  filters: NansenDiscoverResult['filters'];
  creditsUsed?: number | null;
  creditsRemaining?: number | null;
}

let lastError: string | null = null;
let lastFetchAt: number | null = null;
let lastCreditsUsed: number | null = null;
let lastCreditsRemaining: number | null = null;
let memoryCache: CachePayload | null = null;

function getApiKey(): string {
  return (
    process.env.NANSEN_API_KEY?.trim() ||
    (config as { nansen?: { apiKey?: string } }).nansen?.apiKey?.trim() ||
    ''
  );
}

function shortAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function parseLabelList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  // Labels may come as "Smart Trader" or comma/pipe-separated
  return raw
    .split(/[,|;/]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function primaryLabel(labels: string[]): string {
  const priority: NansenSmartMoneyLabel[] = [
    '30D Smart Trader',
    '90D Smart Trader',
    '180D Smart Trader',
    'Smart Trader',
    'Fund',
    'Smart HL Perps Trader',
  ];
  for (const p of priority) {
    if (labels.some((l) => l.toLowerCase() === p.toLowerCase())) return p;
  }
  return labels[0] || 'Smart Money';
}

function resolvePreset(opts: NansenDiscoverOptions): {
  labels: NansenSmartMoneyLabel[];
  minTradeUsd: number;
  limit: number;
  presetId?: string;
} {
  const preset = NANSEN_FILTER_PRESETS.find((p) => p.id === opts.presetId);
  const labels =
    opts.labels && opts.labels.length > 0
      ? opts.labels
      : preset?.labels ?? ['Smart Trader', '30D Smart Trader', '90D Smart Trader'];
  const minTradeUsd =
    opts.minTradeUsd != null
      ? Math.max(0, Number(opts.minTradeUsd))
      : preset?.minTradeUsd ?? 500;
  const limit = Math.min(
    200,
    Math.max(5, opts.limit ?? preset?.limit ?? 50)
  );
  return { labels, minTradeUsd, limit, presetId: opts.presetId ?? preset?.id };
}

function trackedSet(): Set<string> {
  return new Set(config.smartWallets.map((w) => w.address));
}

function markTracked(wallets: NansenWallet[]): NansenWallet[] {
  const tracked = trackedSet();
  return wallets.map((w) => ({
    ...w,
    alreadyTracked: tracked.has(w.address),
  }));
}

function loadDiskCache(): CachePayload | null {
  try {
    ensureDataDir();
    const raw = readJsonFile<CachePayload>(dataFile(CACHE_FILE));
    if (!raw || !Array.isArray(raw.wallets) || !raw.fetchedAt) return null;
    return raw;
  } catch {
    return null;
  }
}

function saveDiskCache(payload: CachePayload): void {
  try {
    ensureDataDir();
    atomicWriteJson(dataFile(CACHE_FILE), payload);
  } catch (err) {
    console.warn(
      '[nansen] cache write failed:',
      err instanceof Error ? err.message : err
    );
  }
}

function getActiveCache(): CachePayload | null {
  if (memoryCache) return memoryCache;
  const disk = loadDiskCache();
  if (disk) memoryCache = disk;
  return memoryCache;
}

export function getNansenStatus(): NansenStatus {
  const key = getApiKey();
  const cache = getActiveCache();
  const cacheAgeMs = cache ? Date.now() - cache.fetchedAt : null;
  return {
    hasApiKey: Boolean(key),
    ok: Boolean(key) && !lastError,
    lastFetchAt: lastFetchAt ?? cache?.fetchedAt ?? null,
    lastError,
    lastCreditsUsed,
    lastCreditsRemaining,
    cachedCount: cache?.wallets.length ?? 0,
    cacheAgeMs,
    setupHint: key
      ? null
      : 'Set NANSEN_API_KEY on Render (Environment) or in .env. Get a key at https://app.nansen.ai',
    presets: NANSEN_FILTER_PRESETS,
  };
}

class NansenApiError extends Error {
  status: number;
  retryAfterSec?: number;
  creditsRemaining?: number | null;

  constructor(
    message: string,
    status: number,
    opts?: { retryAfterSec?: number; creditsRemaining?: number | null }
  ) {
    super(message);
    this.name = 'NansenApiError';
    this.status = status;
    this.retryAfterSec = opts?.retryAfterSec;
    this.creditsRemaining = opts?.creditsRemaining;
  }
}

async function nansenPost<T>(
  path: string,
  body: unknown
): Promise<{
  data: T;
  creditsUsed: number | null;
  creditsRemaining: number | null;
}> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new NansenApiError('NANSEN_API_KEY is not configured', 401);
  }

  const res = await fetch(`${NANSEN_BASE}${path}`, {
    method: 'POST',
    headers: {
      apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  const creditsUsed = parseCreditHeader(res.headers.get('x-nansen-credits-used'));
  const creditsRemaining = parseCreditHeader(
    res.headers.get('x-nansen-credits-remaining')
  );
  if (creditsUsed != null) lastCreditsUsed = creditsUsed;
  if (creditsRemaining != null) lastCreditsRemaining = creditsRemaining;

  if (res.status === 429) {
    const retry =
      Number(res.headers.get('retry-after')) ||
      Number((await res.json().catch(() => ({})) as { retry_after?: number }).retry_after) ||
      30;
    throw new NansenApiError('Nansen rate limit exceeded — wait and retry', 429, {
      retryAfterSec: retry,
      creditsRemaining,
    });
  }

  if (!res.ok) {
    let detail = '';
    try {
      const j = (await res.json()) as { detail?: unknown };
      detail =
        typeof j.detail === 'string'
          ? j.detail
          : j.detail != null
            ? JSON.stringify(j.detail)
            : '';
    } catch {
      detail = await res.text().catch(() => '');
    }
    const msg =
      res.status === 401
        ? 'Nansen API key invalid or missing'
        : res.status === 403
          ? 'Nansen forbidden — check subscription / credit balance'
          : detail || `Nansen HTTP ${res.status}`;
    throw new NansenApiError(msg, res.status, { creditsRemaining });
  }

  const data = (await res.json()) as T;
  return { data, creditsUsed, creditsRemaining };
}

function parseCreditHeader(raw: string | null): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function aggregateTrades(
  rows: DexTradeRow[],
  limit: number
): NansenWallet[] {
  type Agg = {
    address: string;
    name: string;
    labels: Set<string>;
    tradeCount24h: number;
    volumeUsd24h: number;
    lastTradeAt: number | null;
    tokens: Map<string, number>;
  };
  const byAddr = new Map<string, Agg>();

  for (const row of rows) {
    const address = String(row.trader_address ?? '').trim();
    if (!address || !isValidSolanaAddress(address)) continue;

    const labelParts = parseLabelList(row.trader_address_label);
    const ts = row.block_timestamp
      ? Date.parse(row.block_timestamp)
      : NaN;
    const tradeTs = Number.isFinite(ts) ? ts : null;
    const vol =
      typeof row.trade_value_usd === 'number' && Number.isFinite(row.trade_value_usd)
        ? row.trade_value_usd
        : 0;

    let agg = byAddr.get(address);
    if (!agg) {
      agg = {
        address,
        name: labelParts[0] || shortAddr(address),
        labels: new Set(labelParts),
        tradeCount24h: 0,
        volumeUsd24h: 0,
        lastTradeAt: null,
        tokens: new Map(),
      };
      byAddr.set(address, agg);
    }

    for (const l of labelParts) agg.labels.add(l);
    // Prefer a richer display name when label looks like a person/entity
    if (labelParts[0] && !labelParts[0].includes('…')) {
      agg.name = labelParts[0];
    }
    agg.tradeCount24h += 1;
    agg.volumeUsd24h += vol;
    if (tradeTs != null && (agg.lastTradeAt == null || tradeTs > agg.lastTradeAt)) {
      agg.lastTradeAt = tradeTs;
    }
    for (const sym of [row.token_bought_symbol, row.token_sold_symbol]) {
      if (!sym || sym === 'SOL' || sym === 'WSOL' || sym === 'USDC' || sym === 'USDT') {
        continue;
      }
      agg.tokens.set(sym, (agg.tokens.get(sym) ?? 0) + 1);
    }
  }

  const wallets: NansenWallet[] = [...byAddr.values()].map((a) => {
    const labels = [...a.labels];
    const recentTokens = [...a.tokens.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 5)
      .map(([s]) => s);
    const label = primaryLabel(labels);
    return {
      address: a.address,
      name: a.name || shortAddr(a.address),
      label,
      labels: labels.length ? labels : [label],
      tradeCount24h: a.tradeCount24h,
      volumeUsd24h: Math.round(a.volumeUsd24h * 100) / 100,
      lastTradeAt: a.lastTradeAt,
      recentTokens,
      alreadyTracked: false,
      notes: `Nansen · ${label} · ${a.tradeCount24h} trades / 24h`,
      source: 'nansen' as const,
    };
  });

  // Rank: more 24h volume + trades first (activity proxy for profitable smart money)
  wallets.sort((a, b) => {
    const score = (w: NansenWallet) =>
      w.volumeUsd24h * 0.001 + w.tradeCount24h * 10;
    return score(b) - score(a);
  });

  return wallets.slice(0, limit);
}

/**
 * Discover Smart Money wallets on Solana via dex-trades aggregation.
 * Uses cache unless force=true. Default maxPages=1 (~5 credits).
 */
export async function discoverNansenSmartWallets(
  opts: NansenDiscoverOptions = {}
): Promise<NansenDiscoverResult> {
  const resolved = resolvePreset(opts);
  const filters = {
    labels: resolved.labels,
    minTradeUsd: resolved.minTradeUsd,
    limit: resolved.limit,
    presetId: resolved.presetId,
  };

  const statusBase = () => getNansenStatus();

  if (!getApiKey()) {
    lastError = 'NANSEN_API_KEY is not configured';
    return {
      ok: false,
      wallets: [],
      fetchedAt: Date.now(),
      cached: false,
      message: lastError,
      error: lastError,
      filters,
      nansen: statusBase(),
    };
  }

  const existing = getActiveCache();
  if (
    !opts.force &&
    existing &&
    Date.now() - existing.fetchedAt < CACHE_TTL_MS &&
    existing.filters.minTradeUsd === filters.minTradeUsd &&
    existing.filters.limit === filters.limit &&
    JSON.stringify(existing.filters.labels) === JSON.stringify(filters.labels)
  ) {
    const wallets = markTracked(existing.wallets);
    return {
      ok: true,
      wallets,
      fetchedAt: existing.fetchedAt,
      cached: true,
      creditsUsed: 0,
      creditsRemaining: lastCreditsRemaining ?? existing.creditsRemaining ?? null,
      message: `Cached (${Math.round((Date.now() - existing.fetchedAt) / 1000)}s ago) — force refresh to spend credits`,
      filters,
      nansen: statusBase(),
    };
  }

  const maxPages = Math.min(3, Math.max(1, opts.maxPages ?? 1));
  const perPage = Math.min(1000, Math.max(50, opts.perPage ?? 200));
  const allRows: DexTradeRow[] = [];
  let totalCredits = 0;
  let creditsRemaining: number | null = null;

  try {
    for (let page = 1; page <= maxPages; page++) {
      const body = {
        chains: ['solana'],
        filters: {
          include_smart_money_labels: resolved.labels,
          ...(resolved.minTradeUsd > 0
            ? { trade_value_usd: { min: resolved.minTradeUsd } }
            : {}),
        },
        pagination: { page, per_page: perPage },
        order_by: [{ field: 'trade_value_usd', direction: 'DESC' }],
      };

      const { data, creditsUsed, creditsRemaining: rem } =
        await nansenPost<{
          data?: DexTradeRow[];
          pagination?: { is_last_page?: boolean };
        }>('/api/v1/smart-money/dex-trades', body);

      if (creditsUsed != null) totalCredits += creditsUsed;
      creditsRemaining = rem;
      const rows = Array.isArray(data.data) ? data.data : [];
      allRows.push(...rows);
      if (data.pagination?.is_last_page !== false || rows.length === 0) break;
    }

    const wallets = markTracked(aggregateTrades(allRows, resolved.limit));
    const fetchedAt = Date.now();
    const payload: CachePayload = {
      fetchedAt,
      wallets,
      filters,
      creditsUsed: totalCredits,
      creditsRemaining,
    };
    memoryCache = payload;
    saveDiskCache(payload);
    lastFetchAt = fetchedAt;
    lastError = null;

    return {
      ok: true,
      wallets,
      fetchedAt,
      cached: false,
      creditsUsed: totalCredits,
      creditsRemaining,
      message: `Fetched ${wallets.length} unique Smart Money wallets from ${allRows.length} trades (~${totalCredits} credits)`,
      filters,
      nansen: statusBase(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lastError = message;
    const retryAfterSec =
      err instanceof NansenApiError ? err.retryAfterSec : undefined;

    // Fall back to cache on failure
    if (existing?.wallets?.length) {
      return {
        ok: false,
        wallets: markTracked(existing.wallets),
        fetchedAt: existing.fetchedAt,
        cached: true,
        creditsUsed: totalCredits || null,
        creditsRemaining:
          err instanceof NansenApiError
            ? err.creditsRemaining ?? creditsRemaining
            : creditsRemaining,
        message: `API failed — showing cached list. ${message}`,
        error: message,
        retryAfterSec,
        filters: existing.filters,
        nansen: statusBase(),
      };
    }

    return {
      ok: false,
      wallets: [],
      fetchedAt: Date.now(),
      cached: false,
      creditsUsed: totalCredits || null,
      creditsRemaining:
        err instanceof NansenApiError
          ? err.creditsRemaining ?? creditsRemaining
          : creditsRemaining,
      message,
      error: message,
      retryAfterSec,
      filters,
      nansen: statusBase(),
    };
  }
}

export interface NansenEnrichResult {
  ok: boolean;
  wallets: NansenWallet[];
  enriched: number;
  failed: number;
  creditsUsed: number;
  creditsRemaining: number | null;
  message?: string;
  error?: string;
  nansen: NansenStatus;
}

/**
 * Enrich selected wallets with PnL summary (1 credit each). Cap at 10/call.
 */
export async function enrichNansenWalletsWithPnl(
  addresses: string[],
  options: { days?: number } = {}
): Promise<NansenEnrichResult> {
  const days = Math.min(180, Math.max(7, options.days ?? 30));
  const unique = [
    ...new Set(
      addresses.map((a) => a.trim()).filter((a) => isValidSolanaAddress(a))
    ),
  ].slice(0, 10);

  const cache = getActiveCache();
  const byAddr = new Map(
    (cache?.wallets ?? []).map((w) => [w.address, { ...w }])
  );

  if (!getApiKey()) {
    return {
      ok: false,
      wallets: markTracked([...byAddr.values()]),
      enriched: 0,
      failed: 0,
      creditsUsed: 0,
      creditsRemaining: null,
      error: 'NANSEN_API_KEY is not configured',
      message: 'NANSEN_API_KEY is not configured',
      nansen: getNansenStatus(),
    };
  }

  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const date = {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };

  let creditsUsed = 0;
  let creditsRemaining: number | null = null;
  let enriched = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const address of unique) {
    try {
      const { data, creditsUsed: used, creditsRemaining: rem } =
        await nansenPost<{
          win_rate?: number;
          realized_pnl_usd?: number;
          realized_pnl_percent?: number;
          traded_times?: number;
        }>('/api/v1/profiler/address/pnl-summary', {
          address,
          chain: 'solana',
          date,
        });

      if (used != null) creditsUsed += used;
      creditsRemaining = rem;

      const existing = byAddr.get(address) ?? {
        address,
        name: shortAddr(address),
        label: 'Smart Money',
        labels: ['Smart Money'],
        tradeCount24h: 0,
        volumeUsd24h: 0,
        lastTradeAt: null,
        recentTokens: [],
        alreadyTracked: false,
        source: 'nansen' as const,
      };

      // win_rate from Nansen is a ratio (0–1), convert to %
      const wrRaw = data.win_rate;
      const winRate =
        typeof wrRaw === 'number'
          ? wrRaw <= 1
            ? Math.round(wrRaw * 1000) / 10
            : Math.round(wrRaw * 10) / 10
          : undefined;

      byAddr.set(address, {
        ...existing,
        winRate,
        realizedPnlUsd:
          typeof data.realized_pnl_usd === 'number'
            ? Math.round(data.realized_pnl_usd)
            : existing.realizedPnlUsd,
        realizedPnlPercent:
          typeof data.realized_pnl_percent === 'number'
            ? Math.round(data.realized_pnl_percent * 1000) / 10
            : existing.realizedPnlPercent,
        tradedTimes:
          typeof data.traded_times === 'number'
            ? data.traded_times
            : existing.tradedTimes,
        notes: [
          existing.notes,
          winRate != null ? `WR ${winRate}%` : null,
          data.realized_pnl_usd != null
            ? `PnL $${Math.round(data.realized_pnl_usd).toLocaleString()}`
            : null,
        ]
          .filter(Boolean)
          .join(' · '),
      });
      enriched += 1;
    } catch (err) {
      failed += 1;
      errors.push(
        `${shortAddr(address)}: ${err instanceof Error ? err.message : String(err)}`
      );
      if (err instanceof NansenApiError && err.status === 429) {
        lastError = err.message;
        break;
      }
    }
  }

  const wallets = markTracked(
    [...byAddr.values()].sort((a, b) => {
      const wa = a.winRate ?? -1;
      const wb = b.winRate ?? -1;
      if (wb !== wa) return wb - wa;
      return (b.realizedPnlUsd ?? 0) - (a.realizedPnlUsd ?? 0);
    })
  );

  const payload: CachePayload = {
    fetchedAt: cache?.fetchedAt ?? Date.now(),
    wallets,
    filters: cache?.filters ?? {
      labels: ['imported'],
      minTradeUsd: 0,
      limit: wallets.length,
    },
    creditsUsed,
    creditsRemaining,
  };
  memoryCache = payload;
  saveDiskCache(payload);
  lastFetchAt = Date.now();
  if (!errors.length) lastError = null;

  return {
    ok: enriched > 0 || failed === 0,
    wallets,
    enriched,
    failed,
    creditsUsed,
    creditsRemaining,
    message: `Enriched ${enriched}/${unique.length} (~${creditsUsed} credits)${
      errors.length ? ` · ${errors[0]}` : ''
    }`,
    error: errors.length ? errors.join('; ') : undefined,
    nansen: getNansenStatus(),
  };
}

/** Replace in-memory/disk cache from imported CSV/JSON (no API credits). */
export function importNansenWalletList(
  wallets: Array<Partial<NansenWallet> & { address: string }>
): NansenDiscoverResult {
  const cleaned: NansenWallet[] = [];
  for (const raw of wallets) {
    const address = String(raw.address ?? '').trim();
    if (!isValidSolanaAddress(address)) continue;
    const labels = Array.isArray(raw.labels)
      ? raw.labels.map(String)
      : parseLabelList(String(raw.label ?? ''));
    const label = String(raw.label || primaryLabel(labels) || 'Smart Money');
    cleaned.push({
      address,
      name: String(raw.name || shortAddr(address)),
      label,
      labels: labels.length ? labels : [label],
      tradeCount24h: Number(raw.tradeCount24h) || 0,
      volumeUsd24h: Number(raw.volumeUsd24h) || 0,
      lastTradeAt:
        raw.lastTradeAt != null && Number.isFinite(Number(raw.lastTradeAt))
          ? Number(raw.lastTradeAt)
          : null,
      recentTokens: Array.isArray(raw.recentTokens)
        ? raw.recentTokens.map(String)
        : [],
      winRate:
        raw.winRate != null && Number.isFinite(Number(raw.winRate))
          ? Number(raw.winRate)
          : undefined,
      realizedPnlUsd:
        raw.realizedPnlUsd != null && Number.isFinite(Number(raw.realizedPnlUsd))
          ? Number(raw.realizedPnlUsd)
          : undefined,
      realizedPnlPercent:
        raw.realizedPnlPercent != null &&
        Number.isFinite(Number(raw.realizedPnlPercent))
          ? Number(raw.realizedPnlPercent)
          : undefined,
      tradedTimes:
        raw.tradedTimes != null && Number.isFinite(Number(raw.tradedTimes))
          ? Number(raw.tradedTimes)
          : undefined,
      alreadyTracked: false,
      notes: raw.notes != null ? String(raw.notes) : 'Imported (no API call)',
      source: 'nansen',
    });
  }

  const walletsMarked = markTracked(cleaned);
  const payload: CachePayload = {
    fetchedAt: Date.now(),
    wallets: walletsMarked,
    filters: {
      labels: ['imported'],
      minTradeUsd: 0,
      limit: walletsMarked.length,
      presetId: 'imported',
    },
  };
  memoryCache = payload;
  saveDiskCache(payload);
  lastFetchAt = payload.fetchedAt;
  lastError = null;

  return {
    ok: true,
    wallets: walletsMarked,
    fetchedAt: payload.fetchedAt,
    cached: true,
    creditsUsed: 0,
    creditsRemaining: lastCreditsRemaining,
    message: `Imported ${walletsMarked.length} wallets (0 credits)`,
    filters: payload.filters,
    nansen: getNansenStatus(),
  };
}

export function getCachedNansenWallets(): NansenWallet[] {
  return markTracked(getActiveCache()?.wallets ?? []);
}

export function clearNansenCache(): void {
  memoryCache = null;
  try {
    const p = dataFile(CACHE_FILE);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

export function nansenWalletsToCsv(wallets: NansenWallet[]): string {
  const header = [
    'address',
    'name',
    'label',
    'labels',
    'tradeCount24h',
    'volumeUsd24h',
    'lastTradeAt',
    'recentTokens',
    'winRate',
    'realizedPnlUsd',
    'realizedPnlPercent',
    'tradedTimes',
    'notes',
  ];
  const escape = (v: unknown): string => {
    const s = v == null ? '' : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [header.join(',')];
  for (const w of wallets) {
    lines.push(
      [
        w.address,
        w.name,
        w.label,
        (w.labels ?? []).join('|'),
        w.tradeCount24h,
        w.volumeUsd24h,
        w.lastTradeAt ?? '',
        (w.recentTokens ?? []).join('|'),
        w.winRate ?? '',
        w.realizedPnlUsd ?? '',
        w.realizedPnlPercent ?? '',
        w.tradedTimes ?? '',
        w.notes ?? '',
      ]
        .map(escape)
        .join(',')
    );
  }
  return lines.join('\n');
}

export function parseNansenCsv(text: string): Array<Partial<NansenWallet> & { address: string }> {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const parseRow = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') {
          inQ = false;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQ = true;
      } else if (ch === ',') {
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  };

  const header = parseRow(lines[0]).map((h) => h.trim().toLowerCase());
  const hasHeader = header.includes('address');
  const start = hasHeader ? 1 : 0;
  const idx = (name: string): number => header.indexOf(name);

  const results: Array<Partial<NansenWallet> & { address: string }> = [];
  for (let i = start; i < lines.length; i++) {
    const cols = parseRow(lines[i]);
    const address = hasHeader
      ? cols[idx('address')]?.trim()
      : cols[0]?.trim();
    if (!address) continue;
    if (hasHeader) {
      const labelsRaw = cols[idx('labels')] ?? '';
      results.push({
        address,
        name: cols[idx('name')] || undefined,
        label: cols[idx('label')] || undefined,
        labels: labelsRaw
          ? labelsRaw.split('|').map((s) => s.trim()).filter(Boolean)
          : undefined,
        tradeCount24h: numOrUndef(cols[idx('tradecount24h')]),
        volumeUsd24h: numOrUndef(cols[idx('volumeusd24h')]),
        lastTradeAt: numOrUndef(cols[idx('lasttradeat')]),
        recentTokens: (cols[idx('recenttokens')] || '')
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean),
        winRate: numOrUndef(cols[idx('winrate')]),
        realizedPnlUsd: numOrUndef(cols[idx('realizedpnlusd')]),
        realizedPnlPercent: numOrUndef(cols[idx('realizedpnlpercent')]),
        tradedTimes: numOrUndef(cols[idx('tradedtimes')]),
        notes: cols[idx('notes')] || undefined,
      });
    } else {
      // address[,name][,label]
      results.push({
        address,
        name: cols[1] || undefined,
        label: cols[2] || undefined,
      });
    }
  }
  return results;
}

function numOrUndef(v: string | undefined): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function parseNansenJson(
  text: string
): Array<Partial<NansenWallet> & { address: string }> {
  const parsed = JSON.parse(text) as
    | { wallets?: unknown[] }
    | unknown[];
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.wallets)
      ? parsed.wallets
      : [];
  return arr
    .map((row) => {
      const r = row as Record<string, unknown>;
      const address = String(r.address ?? '').trim();
      return {
        address,
        name: r.name != null ? String(r.name) : undefined,
        label: r.label != null ? String(r.label) : undefined,
        labels: Array.isArray(r.labels) ? r.labels.map(String) : undefined,
        tradeCount24h: numOrUndef(String(r.tradeCount24h ?? '')),
        volumeUsd24h: numOrUndef(String(r.volumeUsd24h ?? '')),
        lastTradeAt: numOrUndef(String(r.lastTradeAt ?? '')),
        recentTokens: Array.isArray(r.recentTokens)
          ? r.recentTokens.map(String)
          : undefined,
        winRate: numOrUndef(String(r.winRate ?? '')),
        realizedPnlUsd: numOrUndef(String(r.realizedPnlUsd ?? '')),
        realizedPnlPercent: numOrUndef(String(r.realizedPnlPercent ?? '')),
        tradedTimes: numOrUndef(String(r.tradedTimes ?? '')),
        notes: r.notes != null ? String(r.notes) : undefined,
      };
    })
    .filter((w) => Boolean(w.address));
}

/** Import selected Nansen wallets into tracked smart wallets */
export function importNansenToTracked(
  addresses: string[],
  options: { onlyNew?: boolean } = {}
): { added: string[]; skipped: string[]; updated: string[] } {
  const onlyNew = options.onlyNew !== false;
  const cache = getCachedNansenWallets();
  const byAddr = new Map(cache.map((w) => [w.address, w]));
  const added: string[] = [];
  const skipped: string[] = [];
  const updated: string[] = [];

  for (const addr of addresses) {
    const address = addr.trim();
    if (!isValidSolanaAddress(address)) {
      skipped.push(address);
      continue;
    }
    const w = byAddr.get(address);
    const tags = [
      'nansen',
      ...(w?.labels ?? []),
      w?.label,
    ].filter(Boolean) as string[];
    const uniqueTags = [...new Set(tags.map((t) => String(t)))];

    if (onlyNew && trackedSet().has(address)) {
      skipped.push(address);
      continue;
    }

    const result = upsertSmartWallet({
      name: w?.name || shortAddr(address),
      address,
      enabled: true,
      lastActive: w?.lastTradeAt ?? undefined,
      lastTradedAt: w?.lastTradeAt ?? undefined,
      winRate: w?.winRate,
      tradesLast7d: w?.tradeCount24h,
      notes: w?.notes ?? `Nansen · ${w?.label ?? 'Smart Money'}`,
      tags: uniqueTags,
      category: inferWalletCategory(uniqueTags, w?.tradeCount24h),
      source: 'nansen',
      discoveredAt: Date.now(),
    });

    if (result.added) added.push(address);
    else if (result.updated) updated.push(address);
    else skipped.push(address);
  }

  return { added, skipped, updated };
}
