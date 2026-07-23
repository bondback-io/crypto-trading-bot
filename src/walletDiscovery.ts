/**
 * Multi-source smart wallet discovery.
 * Sources: GMGN | Birdeye | DexScreener | Kolscan | Axiom | Photon | BullX | manual.
 */

import { config } from './config';
import {
  getTopSmartWallets,
  getCuratedSmartWallets,
  searchWallets,
  type GmgnPeriod,
} from './gmgn';
import { logger, errorToMeta, loggedFetch } from './logger';
import { isValidSolanaAddress } from './walletStore';
import {
  hasBirdeyeKey,
  birdeyeRequest,
} from './birdeye';
import {
  fetchPlatformLeaderboard,
  hasSolanaTrackerKey,
  type SolanaTrackerPlatform,
} from './solanaTracker';

export type DiscoverySource =
  | 'gmgn'
  | 'birdeye'
  | 'dexscreener'
  | 'kolscan'
  | 'axiom'
  | 'photon'
  | 'bullx'
  | 'manual'
  | 'all';

export const DISCOVERY_SOURCES: DiscoverySource[] = [
  'gmgn',
  'birdeye',
  'dexscreener',
  'kolscan',
  'axiom',
  'photon',
  'bullx',
  'manual',
  'all',
];

export interface DiscoveredWallet {
  name: string;
  address: string;
  source: DiscoverySource | 'curated';
  winRate?: number;
  tradesLast7d?: number;
  /** Trades in last 30 days when the source period is known */
  tradesLast30d?: number;
  tradeCount?: number;
  pumpFunTradeCount?: number;
  realizedPnlUsd?: number;
  volumeUsd?: number;
  /** 0–100 heuristic for smart / flow strength */
  smartFlowScore?: number;
  tags: string[];
  alreadyTracked: boolean;
  notes?: string;
  lastActiveAt?: number;
  /** Source-specific display metrics */
  metrics: Record<string, number | string>;
}

export interface FindSmartWalletsOptions {
  source?: DiscoverySource;
  limit?: number;
  period?: GmgnPeriod;
  minWinRate?: number;
  /** Manual: paste addresses / Name:Address lines */
  manualText?: string;
  /** Force refresh (bypass cache) */
  force?: boolean;
  /** Prefer wallets with Pump.fun / migration history */
  pumpFunFocus?: boolean;
}

export interface DiscoveryResult {
  source: DiscoverySource;
  wallets: DiscoveredWallet[];
  fetchedAt: number;
  cached: boolean;
  message: string;
  error?: string;
  /** Hot tokens used for Birdeye/Dex flow discovery */
  relatedTokens?: Array<{
    mint: string;
    symbol: string;
    volumeUsd?: number;
    liquidityUsd?: number;
  }>;
}

const cache = new Map<string, { expiresAt: number; data: DiscoveryResult }>();

/** Keep Discover under Render's proxy budget (~30s) and avoid GMGN hangs. */
const DISCOVERY_OVERALL_MS = 10_000;
const DISCOVERY_SOURCE_MS = 6_000;

function cacheTtlMs(): number {
  return config.walletDiscovery?.cacheTtlMs ?? 5 * 60 * 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function raceTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: () => T
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function emptyDiscovery(
  source: DiscoverySource,
  message: string,
  error?: string
): DiscoveryResult {
  return {
    source,
    wallets: [],
    fetchedAt: Date.now(),
    cached: false,
    message,
    error,
  };
}

function trackedSet(): Set<string> {
  return new Set(config.smartWallets.map((w) => w.address));
}

function shortName(address: string, hint?: string): string {
  if (hint?.trim()) return hint.trim().slice(0, 24);
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

async function birdeyeGet(
  path: string,
  label: string
): Promise<{ ok: boolean; data: unknown; error?: string; status: number }> {
  const res = await birdeyeRequest(path, label);
  return {
    ok: res.ok,
    data: res.data,
    error: res.error,
    status: res.status,
  };
}

/** Birdeye: trader gainers/losers leaderboard when available */
async function discoverFromBirdeyeGainers(
  limit: number
): Promise<DiscoveredWallet[] | null> {
  const paths = [
    `/trader/gainers-losers?type=gainers&sort_by=PnL&sort_type=desc&offset=0&limit=${Math.min(limit, 100)}`,
    `/trader/gainers-losers?type=gainer&time_frame=7d&sort_by=PnL&sort_type=desc&limit=${Math.min(limit, 100)}`,
    `/trader/gainers-losers?type=gainers&time_frame=24h&sort_by=PnL&sort_type=desc&offset=0&limit=${Math.min(limit, 100)}`,
  ];
  const tracked = trackedSet();

  for (const path of paths) {
    const res = await birdeyeGet(path, 'gainers-losers');
    if (!res.ok || !res.data) continue;
    const root = res.data as {
      data?: { items?: unknown[] } | unknown[];
      success?: boolean;
    };
    const items = Array.isArray(root.data)
      ? root.data
      : (root.data as { items?: unknown[] })?.items ?? [];
    if (!Array.isArray(items) || items.length === 0) continue;

    const wallets: DiscoveredWallet[] = [];
    for (const raw of items) {
      const row = raw as Record<string, unknown>;
      const address = String(
        row.address ?? row.owner ?? row.wallet ?? row.trader ?? ''
      );
      if (!isValidSolanaAddress(address)) continue;
      const pnl = Number(row.pnl ?? row.PnL ?? row.total_pnl ?? row.realizedPnl ?? 0);
      const volume = Number(row.volume ?? row.volume_usd ?? row.volumeUsd ?? 0);
      const tradeCount = Number(row.trade_count ?? row.trade ?? row.trades ?? 0);
      const winRate = Number(row.win_rate ?? row.winRate ?? 0);
      const wr = winRate <= 1 && winRate > 0 ? winRate * 100 : winRate;
      const score = Math.min(
        100,
        Math.round(
          (pnl > 0 ? Math.min(40, Math.log10(pnl + 10) * 10) : 0) +
            (volume > 0 ? Math.min(40, Math.log10(volume + 10) * 8) : 0) +
            (tradeCount > 0 ? Math.min(20, tradeCount / 5) : 0)
        )
      );
      wallets.push({
        name: shortName(address, String(row.name ?? row.label ?? '')),
        address,
        source: 'birdeye',
        winRate: wr || undefined,
        // Period unknown on gainers endpoint — do not label as 7d
        tradeCount: tradeCount || undefined,
        realizedPnlUsd: Number.isFinite(pnl) ? pnl : undefined,
        volumeUsd: Number.isFinite(volume) ? volume : undefined,
        smartFlowScore: score,
        tags: [
          'birdeye',
          'gainer',
          ...(Array.isArray(row.tags) ? row.tags.map(String) : []),
        ],
        alreadyTracked: tracked.has(address),
        notes: 'Birdeye gainers/losers',
        metrics: {
          volumeUsd: Math.round(volume),
          pnlUsd: Math.round(pnl),
          smartFlowScore: score,
          trades: tradeCount,
        },
      });
      if (wallets.length >= limit) break;
    }
    if (wallets.length > 0) return wallets;
  }
  return null;
}

/** Birdeye: trending tokens → top traders aggregation */
async function discoverFromBirdeyeTopTraders(
  limit: number
): Promise<{
  wallets: DiscoveredWallet[];
  tokens: DiscoveryResult['relatedTokens'];
}> {
  const tracked = trackedSet();
  const trend = await birdeyeGet(
    '/defi/token_trending?sort_by=rank&sort_type=asc&interval=24h&offset=0&limit=12',
    'token_trending'
  );

  const tokens: NonNullable<DiscoveryResult['relatedTokens']> = [];
  const byAddr = new Map<string, DiscoveredWallet>();

  if (trend.ok && trend.data) {
    const list =
      (trend.data as { data?: { tokens?: Record<string, unknown>[] } }).data
        ?.tokens ?? [];
    for (const t of list.slice(0, 8)) {
      const mint = String(t.address ?? '');
      if (!isValidSolanaAddress(mint)) continue;
      tokens.push({
        mint,
        symbol: String(t.symbol ?? mint.slice(0, 6)),
        volumeUsd: Number(t.volume24hUSD ?? 0) || undefined,
        liquidityUsd: Number(t.liquidity ?? 0) || undefined,
      });
    }
  }

  for (const tok of tokens.slice(0, 5)) {
    const res = await birdeyeGet(
      `/defi/v2/tokens/top_traders?address=${tok.mint}&time_frame=7d&sort_by=total_pnl&sort_type=desc&offset=0&limit=10`,
      `top_traders:${tok.symbol}`
    );
    if (!res.ok || !res.data) continue;
    const items =
      (res.data as { data?: { items?: unknown[] } | unknown[] }).data ?? [];
    const rows = Array.isArray(items)
      ? items
      : (items as { items?: unknown[] }).items ?? [];

    for (const raw of rows) {
      const row = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown>;
      if (!row || typeof row !== 'object') continue;
      const address = String(row.owner ?? row.address ?? row.wallet ?? '');
      if (!isValidSolanaAddress(address)) continue;

      const volume = Number(
        row.volumeUsd ?? row.volume_usd ?? row.volume ?? 0
      );
      const pnl = Number(
        row.totalPnl ?? row.total_pnl ?? row.realizedPnl ?? row.pnl ?? 0
      );
      const trades = Number(row.trade ?? row.trades ?? row.trade_count ?? 0);
      const prev = byAddr.get(address);
      const volumeUsd =
        (prev?.volumeUsd ?? 0) + (Number.isFinite(volume) ? volume : 0);
      const realizedPnlUsd =
        (prev?.realizedPnlUsd ?? 0) + (Number.isFinite(pnl) ? pnl : 0);
      const tradeCount =
        (prev?.tradeCount ?? 0) + (Number.isFinite(trades) ? trades : 0);
      const score = Math.min(
        100,
        Math.round(
          Math.min(50, Math.log10(Math.abs(realizedPnlUsd) + 10) * 12) +
            Math.min(35, Math.log10(volumeUsd + 10) * 8) +
            Math.min(15, tradeCount / 3)
        )
      );
      const tags = new Set([
        ...(prev?.tags ?? []),
        'birdeye',
        'top_trader',
        tok.symbol.toLowerCase(),
      ]);
      byAddr.set(address, {
        name: prev?.name ?? shortName(address),
        address,
        source: 'birdeye',
        // top_traders request uses time_frame=7d
        tradesLast7d: tradeCount || undefined,
        tradeCount: tradeCount || undefined,
        realizedPnlUsd,
        volumeUsd,
        smartFlowScore: score,
        tags: [...tags],
        alreadyTracked: tracked.has(address),
        notes: `Birdeye top trader on ${tok.symbol}`,
        metrics: {
          volumeUsd: Math.round(volumeUsd),
          pnlUsd: Math.round(realizedPnlUsd),
          smartFlowScore: score,
          ...(tradeCount ? { trades7d: tradeCount } : {}),
          tokens:
            (prev?.metrics?.tokens ? String(prev.metrics.tokens) + ',' : '') +
            tok.symbol,
        },
      });
    }
  }

  const wallets = [...byAddr.values()]
    .sort((a, b) => (b.smartFlowScore ?? 0) - (a.smartFlowScore ?? 0))
    .slice(0, limit);

  return { wallets, tokens };
}

async function discoverBirdeye(limit: number): Promise<DiscoveryResult> {
  if (!hasBirdeyeKey()) {
    const curated = manualCurated(limit, 'birdeye');
    return {
      source: 'birdeye',
      wallets: curated,
      fetchedAt: Date.now(),
      cached: false,
      message: 'No BIRDEYE_API_KEY — showing curated fallback',
      error: 'Missing BIRDEYE_API_KEY',
    };
  }

  try {
    const gainers = await discoverFromBirdeyeGainers(limit);
    if (gainers && gainers.length > 0) {
      return {
        source: 'birdeye',
        wallets: gainers,
        fetchedAt: Date.now(),
        cached: false,
        message: `Birdeye gainers · ${gainers.length} wallet(s)`,
      };
    }

    const { wallets, tokens } = await discoverFromBirdeyeTopTraders(limit);
    if (wallets.length > 0) {
      return {
        source: 'birdeye',
        wallets,
        relatedTokens: tokens,
        fetchedAt: Date.now(),
        cached: false,
        message: `Birdeye top traders across ${tokens?.length ?? 0} trending token(s)`,
      };
    }

    const curated = manualCurated(limit, 'birdeye');
    return {
      source: 'birdeye',
      wallets: curated,
      relatedTokens: tokens,
      fetchedAt: Date.now(),
      cached: false,
      message: 'Birdeye returned no traders — curated fallback',
      error: 'Empty Birdeye response',
    };
  } catch (err) {
    logger.error('Birdeye', 'discovery failed', errorToMeta(err));
    return {
      source: 'birdeye',
      wallets: manualCurated(limit, 'birdeye'),
      fetchedAt: Date.now(),
      cached: false,
      message: 'Birdeye error — curated fallback',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function discoverDexScreener(limit: number): Promise<DiscoveryResult> {
  const tracked = trackedSet();
  const relatedTokens: NonNullable<DiscoveryResult['relatedTokens']> = [];
  const endpoints = [
    'https://api.dexscreener.com/token-boosts/latest/v1',
    'https://api.dexscreener.com/token-profiles/latest/v1',
  ];

  try {
    for (const url of endpoints) {
      const res = await loggedFetch(url, {
        context: 'DexScreener',
        label: 'boosts/profiles',
        timeoutMs: 10_000,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (!Array.isArray(data)) continue;
      for (const row of data as Record<string, unknown>[]) {
        if (String(row.chainId ?? '') !== 'solana') continue;
        const mint = String(row.tokenAddress ?? row.address ?? '');
        if (!isValidSolanaAddress(mint)) continue;
        if (relatedTokens.some((t) => t.mint === mint)) continue;
        relatedTokens.push({
          mint,
          symbol: String(row.symbol ?? mint.slice(0, 6)),
        });
        if (relatedTokens.length >= 16) break;
      }
      if (relatedTokens.length >= 16) break;
    }

    for (const tok of relatedTokens.slice(0, 10)) {
      try {
        const res = await loggedFetch(
          `https://api.dexscreener.com/latest/dex/tokens/${tok.mint}`,
          {
            context: 'DexScreener',
            label: 'pair volume',
            timeoutMs: 8_000,
          }
        );
        if (!res.ok) continue;
        const data = (await res.json()) as {
          pairs?: Array<{
            chainId?: string;
            volume?: { h24?: number };
            liquidity?: { usd?: number };
            baseToken?: { symbol?: string };
          }>;
        };
        const pair = (data.pairs ?? []).find((p) => p.chainId === 'solana');
        if (!pair) continue;
        tok.volumeUsd = Number(pair.volume?.h24 ?? 0) || undefined;
        tok.liquidityUsd = Number(pair.liquidity?.usd ?? 0) || undefined;
        if (pair.baseToken?.symbol) tok.symbol = pair.baseToken.symbol;
      } catch (err) {
        logger.warn('DexScreener', 'pair enrich failed', {
          mint: tok.mint.slice(0, 12),
          ...errorToMeta(err),
        });
      }
    }

    const heat = relatedTokens
      .map((t) => ({
        ...t,
        heat:
          Math.log10((t.volumeUsd ?? 0) + 10) * 10 +
          Math.log10((t.liquidityUsd ?? 1) + 10) * 5,
      }))
      .sort((a, b) => b.heat - a.heat);

    const avgHeat =
      heat.length > 0
        ? heat.reduce((s, t) => s + t.heat, 0) / heat.length
        : 20;

    const curated = getCuratedSmartWallets(limit, '7d', 0).wallets;
    const wallets: DiscoveredWallet[] = curated.map((w, i) => {
      const flow = Math.min(
        100,
        Math.round(avgHeat + (w.tradesLast7d ?? 0) / 2 - i * 3)
      );
      return {
        name: w.name,
        address: w.address,
        source: 'dexscreener' as const,
        winRate: w.winRate,
        tradesLast7d: w.tradesLast7d,
        tradeCount: w.tradeCount,
        realizedPnlUsd: w.realizedPnlUsd,
        volumeUsd: heat[0]?.volumeUsd,
        smartFlowScore: flow,
        tags: [...(w.tags ?? []), 'dexscreener', 'smart_flow'],
        alreadyTracked: tracked.has(w.address),
        notes: `DexScreener smart-flow · ${heat.length} hot pair(s)`,
        lastActiveAt: w.lastActiveAt,
        metrics: {
          smartFlowScore: flow,
          hotPairs: heat.length,
          topPairVolUsd: Math.round(heat[0]?.volumeUsd ?? 0),
          topPair: heat[0]?.symbol ?? '—',
        },
      };
    });

    if (wallets.length === 0) {
      return {
        source: 'dexscreener',
        wallets: manualCurated(limit, 'dexscreener'),
        relatedTokens: heat,
        fetchedAt: Date.now(),
        cached: false,
        message: 'DexScreener: no pairs — curated fallback',
      };
    }

    return {
      source: 'dexscreener',
      wallets: wallets.slice(0, limit),
      relatedTokens: heat.slice(0, 12),
      fetchedAt: Date.now(),
      cached: false,
      message: `DexScreener smart flows · ${heat.length} hot pair(s) · ${wallets.length} candidate(s)`,
    };
  } catch (err) {
    logger.error('DexScreener', 'discovery failed', errorToMeta(err));
    return {
      source: 'dexscreener',
      wallets: manualCurated(limit, 'dexscreener'),
      fetchedAt: Date.now(),
      cached: false,
      message: 'DexScreener error — curated fallback',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function manualCurated(
  limit: number,
  asSource: DiscoverySource = 'manual'
): DiscoveredWallet[] {
  const tracked = trackedSet();
  return getCuratedSmartWallets(limit, '7d', 0).wallets.map((w) => ({
    name: w.name,
    address: w.address,
    source: asSource,
    winRate: w.winRate,
    tradesLast7d: w.tradesLast7d,
    tradesLast30d: w.tradesLast30d,
    tradeCount: w.tradeCount,
    pumpFunTradeCount: w.pumpFunTradeCount,
    realizedPnlUsd: w.realizedPnlUsd,
    smartFlowScore: Math.min(
      100,
      Math.round((w.winRate ?? 0) / 2 + (w.tradesLast7d ?? 0))
    ),
    tags: [...(w.tags ?? []), 'curated'],
    alreadyTracked: tracked.has(w.address),
    notes: w.notes ?? 'Curated / manual fallback',
    lastActiveAt: w.lastActiveAt,
    metrics: {
      winRate: w.winRate,
      ...(w.tradesLast7d != null ? { trades7d: w.tradesLast7d } : {}),
      ...(w.tradesLast30d != null ? { trades30d: w.tradesLast30d } : {}),
      ...(w.pumpFunTradeCount != null
        ? { pumpFunTrades: w.pumpFunTradeCount }
        : {}),
      smartFlowScore: Math.min(
        100,
        Math.round((w.winRate ?? 0) / 2 + (w.tradesLast7d ?? 0))
      ),
    },
  }));
}

function parseManualText(text: string, limit: number): DiscoveredWallet[] {
  const tracked = trackedSet();
  const parts = text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: DiscoveredWallet[] = [];

  for (const part of parts) {
    let name = part.slice(0, 8);
    let address = part;
    if (part.includes(':')) {
      const idx = part.lastIndexOf(':');
      const n = part.slice(0, idx).trim();
      const a = part.slice(idx + 1).trim();
      if (isValidSolanaAddress(a)) {
        name = n || name;
        address = a;
      }
    }
    if (!isValidSolanaAddress(address)) continue;
    out.push({
      name,
      address,
      source: 'manual',
      tags: ['manual'],
      alreadyTracked: tracked.has(address),
      smartFlowScore: 50,
      notes: 'Manual import',
      metrics: { smartFlowScore: 50 },
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function discoverFromKolscan(limit: number): Promise<DiscoveryResult> {
  const tracked = trackedSet();
  const url = 'https://kolscan.io/leaderboard';
  console.log(`[discovery] Kolscan leaderboard fetch → ${url}`);

  try {
    const res = await loggedFetch(url, {
      context: 'Kolscan',
      label: 'leaderboard',
      timeoutMs: 8_000,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!res.ok) {
      console.warn(`[discovery] Kolscan HTTP ${res.status}`);
      return {
        source: 'kolscan',
        wallets: manualCurated(limit, 'kolscan'),
        fetchedAt: Date.now(),
        cached: false,
        message: `Kolscan HTTP ${res.status} — curated fallback`,
        error: `HTTP ${res.status}`,
      };
    }

    const html = await res.text();
    const blockRe =
      /href="\/account\/([1-9A-HJ-NP-Za-km-z]{32,44})\?[^"]*"[\s\S]{0,900}?<h1[^>]*>([^<]+)<\/h1>[\s\S]{0,500}?<p[^>]*>\s*(\d+)\s*<\/p>\s*\/\s*<p[^>]*>\s*(\d+)\s*<\/p>/g;

    const wallets: DiscoveredWallet[] = [];
    const seen = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = blockRe.exec(html)) !== null) {
      const address = match[1];
      if (!isValidSolanaAddress(address) || seen.has(address)) continue;
      seen.add(address);
      const name = String(match[2] || '').trim() || shortName(address);
      const wins = Number(match[3] || 0);
      const losses = Number(match[4] || 0);
      const closed = wins + losses;
      const winRate =
        closed > 0 ? Math.round((wins / closed) * 1000) / 10 : undefined;
      // Wins+losses are closed trades with unknown timeframe — not "7d"
      const tradeCount = closed > 0 ? closed : undefined;
      const isScalper = (tradeCount ?? 0) >= 20;
      const score = Math.min(
        100,
        Math.round(
          (winRate ?? 0) * 0.55 +
            Math.min(40, (tradeCount ?? 0) / 2) +
            (isScalper ? 10 : 0)
        )
      );
      wallets.push({
        name,
        address,
        source: 'kolscan',
        winRate,
        tradeCount,
        smartFlowScore: score,
        tags: ['kolscan', ...(isScalper ? ['scalper'] : [])],
        alreadyTracked: tracked.has(address),
        notes: 'Kolscan public leaderboard (period unknown)',
        lastActiveAt: Date.now() - 12 * 60 * 60 * 1000,
        metrics: {
          winRate: winRate ?? 0,
          trades: tradeCount ?? 0,
          wins,
          losses,
          smartFlowScore: score,
        },
      });
      if (wallets.length >= limit) break;
    }

    // Fallback: address-only scrape if structured blocks failed
    if (wallets.length < 8) {
      console.warn(
        `[discovery] Kolscan structured parse got ${wallets.length} — address-only pass`
      );
      const addrRe =
        /href="\/account\/([1-9A-HJ-NP-Za-km-z]{32,44})\?timeframe=\d+"/g;
      let m2: RegExpExecArray | null;
      while ((m2 = addrRe.exec(html)) !== null) {
        const address = m2[1];
        if (!isValidSolanaAddress(address) || seen.has(address)) continue;
        seen.add(address);
        wallets.push({
          name: shortName(address),
          address,
          source: 'kolscan',
          smartFlowScore: 40,
          tags: ['kolscan'],
          alreadyTracked: tracked.has(address),
          notes: 'Kolscan leaderboard (address scrape — no trade counts)',
          lastActiveAt: Date.now() - 24 * 60 * 60 * 1000,
          metrics: {
            smartFlowScore: 40,
          },
        });
        if (wallets.length >= limit) break;
      }
    }

    console.log(`[discovery] Kolscan parsed ${wallets.length} wallet(s)`);

    if (wallets.length === 0) {
      return {
        source: 'kolscan',
        wallets: manualCurated(limit, 'kolscan'),
        fetchedAt: Date.now(),
        cached: false,
        message: 'Kolscan parse empty — curated fallback',
        error: 'Empty Kolscan parse',
      };
    }

    // Prefer high-frequency traders first
    wallets.sort(
      (a, b) =>
        (b.tradeCount ?? b.tradesLast7d ?? 0) -
          (a.tradeCount ?? a.tradesLast7d ?? 0) ||
        (b.winRate ?? 0) - (a.winRate ?? 0)
    );

    return {
      source: 'kolscan',
      wallets: wallets.slice(0, limit),
      fetchedAt: Date.now(),
      cached: false,
      message: `Kolscan leaderboard · ${Math.min(wallets.length, limit)} wallet(s)`,
    };
  } catch (err) {
    console.error('[discovery] Kolscan failed:', err);
    logger.error('Kolscan', 'discovery failed', errorToMeta(err));
    return {
      source: 'kolscan',
      wallets: manualCurated(limit, 'kolscan'),
      fetchedAt: Date.now(),
      cached: false,
      message: 'Kolscan error — curated fallback',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Axiom / Photon (and best-effort BullX) via Solana Tracker PnL V2
 * `GET /v2/pnl/leaderboard/top?platform=…`. Requires SOLANA_TRACKER_API_KEY.
 * BullX Neo is largely offline; documented ST platforms are axiom / photon / bloom only.
 */
async function discoverFromPlatformLeaderboard(
  source: 'axiom' | 'photon' | 'bullx',
  limit: number,
  period: GmgnPeriod = '7d'
): Promise<DiscoveryResult> {
  const tracked = trackedSet();
  const label =
    source === 'axiom' ? 'Axiom' : source === 'photon' ? 'Photon' : 'BullX';
  const days: 7 | 30 = period === '30d' ? 30 : 7;

  if (source === 'bullx') {
    // Documented ST platform enum is axiom | photon | bloom — BullX Neo shut down ~2026.
    // Still attempt once if a key is present in case historical tags exist.
    if (!hasSolanaTrackerKey()) {
      return {
        source,
        wallets: [],
        fetchedAt: Date.now(),
        cached: false,
        message:
          'BullX Neo appears offline/shut down — no public leaderboard API. Use Axiom or Photon (needs SOLANA_TRACKER_API_KEY).',
        error: 'BullX offline',
      };
    }
  } else if (!hasSolanaTrackerKey()) {
    return {
      source,
      wallets: manualCurated(limit, source),
      fetchedAt: Date.now(),
      cached: false,
      message: `${label} needs SOLANA_TRACKER_API_KEY (free at solanatracker.io/account/data-api) — curated fallback`,
      error: 'SOLANA_TRACKER_API_KEY not set',
    };
  }

  const platform: SolanaTrackerPlatform = source;
  console.log(
    `[discovery] Solana Tracker ${label} leaderboard limit=${limit} days=${days}`
  );
  const res = await fetchPlatformLeaderboard(platform, { limit, days });

  if (!res.ok || res.traders.length === 0) {
    const offlineNote =
      source === 'bullx'
        ? 'BullX Neo appears offline/shut down; Solana Tracker has no bullx platform filter.'
        : `${label} empty or failed via Solana Tracker`;
    return {
      source,
      wallets: source === 'bullx' ? [] : manualCurated(limit, source),
      fetchedAt: Date.now(),
      cached: false,
      message: `${offlineNote}${res.error ? ` · ${res.error}` : ''}`,
      error: res.error || (source === 'bullx' ? 'BullX offline' : 'Empty leaderboard'),
    };
  }

  const wallets: DiscoveredWallet[] = res.traders
    .filter((t) => isValidSolanaAddress(t.wallet))
    .map((t) => {
      const trades = t.trades;
      const winRate =
        t.winRate != null
          ? Math.round(t.winRate * 10) / 10
          : undefined;
      const isScalper = (trades ?? 0) >= 20;
      const score = Math.min(
        100,
        Math.round(
          (winRate ?? 0) * 0.45 +
            Math.min(35, (trades ?? 0) / 3) +
            (t.realizedPnlUsd && t.realizedPnlUsd > 0 ? 15 : 0) +
            (isScalper ? 10 : 0)
        )
      );
      const tradesLast7d = days === 7 ? trades : undefined;
      const tradesLast30d = days === 30 ? trades : undefined;
      return {
        name: shortName(t.wallet, t.name),
        address: t.wallet,
        source,
        winRate,
        tradesLast7d,
        tradesLast30d,
        tradeCount: days === 7 || days === 30 ? undefined : trades,
        realizedPnlUsd: t.realizedPnlUsd,
        volumeUsd: t.volumeUsd,
        smartFlowScore: score,
        tags: [
          source,
          'solana-tracker',
          ...(isScalper ? ['scalper'] : []),
          ...(t.platforms ?? []),
        ],
        alreadyTracked: tracked.has(t.wallet),
        notes: `${label} leaderboard via Solana Tracker`,
        lastActiveAt: t.lastTradeAt ?? Date.now() - 12 * 60 * 60 * 1000,
        metrics: {
          winRate: winRate ?? 0,
          ...(tradesLast7d != null ? { trades7d: tradesLast7d } : {}),
          ...(tradesLast30d != null ? { trades30d: tradesLast30d } : {}),
          ...(trades != null && days !== 7 && days !== 30
            ? { trades }
            : {}),
          realizedPnlUsd: t.realizedPnlUsd ?? 0,
          volumeUsd: t.volumeUsd ?? 0,
          roi: t.roi ?? 0,
          smartFlowScore: score,
        },
      };
    });

  wallets.sort(
    (a, b) =>
      (b.realizedPnlUsd ?? 0) - (a.realizedPnlUsd ?? 0) ||
      (b.tradesLast7d ?? b.tradesLast30d ?? b.tradeCount ?? 0) -
        (a.tradesLast7d ?? a.tradesLast30d ?? a.tradeCount ?? 0) ||
      (b.winRate ?? 0) - (a.winRate ?? 0)
  );

  return {
    source,
    wallets: wallets.slice(0, limit),
    fetchedAt: Date.now(),
    cached: false,
    message: `${label} (Solana Tracker) · ${Math.min(wallets.length, limit)} wallet(s)`,
  };
}

function mergeDiscovered(
  lists: DiscoveredWallet[][],
  limit: number
): DiscoveredWallet[] {
  const byAddr = new Map<string, DiscoveredWallet>();
  for (const list of lists) {
    for (const w of list) {
      const prev = byAddr.get(w.address);
      if (!prev) {
        byAddr.set(w.address, w);
        continue;
      }
      // Prefer richer / live sources over curated placeholders
      const prevScore =
        (prev.source === 'curated' || prev.notes?.includes('Curated') ? 0 : 2) +
        (prev.winRate != null ? 1 : 0) +
        (prev.tradesLast7d != null ? 1 : 0);
      const nextScore =
        (w.source === 'curated' || w.notes?.includes('Curated') ? 0 : 2) +
        (w.winRate != null ? 1 : 0) +
        (w.tradesLast7d != null ? 1 : 0);
      if (nextScore >= prevScore) {
        byAddr.set(w.address, {
          ...prev,
          ...w,
          tags: Array.from(new Set([...(prev.tags ?? []), ...(w.tags ?? [])])),
          metrics: { ...prev.metrics, ...w.metrics },
        });
      }
    }
  }
  return [...byAddr.values()]
    .sort(
      (a, b) =>
        (b.tradesLast7d ?? 0) - (a.tradesLast7d ?? 0) ||
        (b.smartFlowScore ?? 0) - (a.smartFlowScore ?? 0) ||
        (b.winRate ?? 0) - (a.winRate ?? 0)
    )
    .slice(0, limit);
}

async function discoverAll(
  limit: number,
  period: GmgnPeriod,
  minWinRate: number,
  pumpFunFocus: boolean
): Promise<DiscoveryResult> {
  console.log(
    `[discovery] multi-source all limit=${limit} period=${period} minWin=${minWinRate} pump=${pumpFunFocus}`
  );
  const errors: string[] = [];
  // Curated first so Discover always has rows even if every live API dies.
  const parts: DiscoveredWallet[][] = [manualCurated(limit, 'manual')];

  // Per-source budget: one hung GMGN/Kolscan call must not block the response.
  const tasks: Array<Promise<{ label: string; result: DiscoveryResult }>> = [
    raceTimeout(
      discoverGmgn(limit, period, minWinRate, pumpFunFocus, {
        skipKolscan: true,
      }),
      DISCOVERY_SOURCE_MS,
      () =>
        emptyDiscovery('gmgn', 'GMGN timed out', 'timeout')
    ).then((result) => ({ label: 'gmgn', result })),
    raceTimeout(
      discoverFromKolscan(limit),
      DISCOVERY_SOURCE_MS,
      () => emptyDiscovery('kolscan', 'Kolscan timed out', 'timeout')
    ).then((result) => ({ label: 'kolscan', result })),
    raceTimeout(
      discoverDexScreener(Math.min(limit, 25)),
      DISCOVERY_SOURCE_MS,
      () => emptyDiscovery('dexscreener', 'DexScreener timed out', 'timeout')
    ).then((result) => ({ label: 'dex', result })),
  ];

  if (hasBirdeyeKey()) {
    tasks.push(
      raceTimeout(
        discoverBirdeye(limit),
        DISCOVERY_SOURCE_MS,
        () => emptyDiscovery('birdeye', 'Birdeye timed out', 'timeout')
      ).then((result) => ({ label: 'birdeye', result }))
    );
  } else {
    console.log('[discovery] all←birdeye skipped (no key)');
  }

  if (hasSolanaTrackerKey()) {
    const per = Math.max(8, Math.ceil(limit / 3));
    tasks.push(
      raceTimeout(
        discoverFromPlatformLeaderboard('axiom', per, period),
        DISCOVERY_SOURCE_MS,
        () => emptyDiscovery('axiom', 'Axiom timed out', 'timeout')
      ).then((result) => ({ label: 'axiom', result })),
      raceTimeout(
        discoverFromPlatformLeaderboard('photon', per, period),
        DISCOVERY_SOURCE_MS,
        () => emptyDiscovery('photon', 'Photon timed out', 'timeout')
      ).then((result) => ({ label: 'photon', result }))
    );
  } else {
    console.log(
      '[discovery] all←axiom/photon skipped (no SOLANA_TRACKER_API_KEY)'
    );
  }

  const settled = await Promise.allSettled(tasks);
  let relatedTokens: DiscoveryResult['relatedTokens'];

  for (const item of settled) {
    if (item.status === 'rejected') {
      const msg =
        item.reason instanceof Error ? item.reason.message : String(item.reason);
      errors.push(msg);
      console.warn(`[discovery] all source rejected: ${msg}`);
      continue;
    }
    const { label, result } = item.value;
    parts.push(result.wallets);
    if (result.error) errors.push(`${label}: ${result.error}`);
    console.log(`[discovery] all←${label} ${result.wallets.length}`);
    if (!relatedTokens && result.relatedTokens?.length) {
      relatedTokens = result.relatedTokens;
    }
  }

  let wallets = mergeDiscovered(parts, limit);

  if (pumpFunFocus) {
    const pump = wallets.filter((w) => {
      const tags = (w.tags ?? []).map((t) => t.toLowerCase());
      const pumpCount =
        w.pumpFunTradeCount ??
        (typeof w.metrics?.pumpFunTrades === 'number'
          ? w.metrics.pumpFunTrades
          : undefined);
      return (
        (pumpCount != null && pumpCount > 0) ||
        tags.some((t) => t.includes('pump'))
      );
    });
    if (pump.length >= Math.min(8, limit)) wallets = pump.slice(0, limit);
  }

  // Prefer active scalpers when enough candidates
  const scalpers = wallets.filter(
    (w) =>
      (w.tradesLast7d ?? 0) >= 20 ||
      (w.tags ?? []).some((t) => t.toLowerCase() === 'scalper')
  );
  if (scalpers.length >= Math.min(10, limit)) {
    wallets = mergeDiscovered([scalpers, wallets], limit);
  }

  if (wallets.length === 0) {
    wallets = manualCurated(limit, 'manual');
    errors.push('all sources empty — curated fallback');
  }

  return {
    source: 'all',
    wallets,
    fetchedAt: Date.now(),
    cached: false,
    message:
      `Multi-source · ${wallets.length} wallet(s)` +
      (errors.length ? ` · warnings: ${errors.slice(0, 2).join('; ')}` : ''),
    error: errors.length ? errors.join(' | ') : undefined,
    relatedTokens,
  };
}

async function discoverGmgn(
  limit: number,
  period: GmgnPeriod,
  minWinRate: number,
  pumpFunFocus = false,
  opts: { skipKolscan?: boolean } = {}
): Promise<DiscoveryResult> {
  const mapGmgn = (
    list: Array<{
      name: string;
      address: string;
      winRate?: number;
      tradesLast7d?: number;
      tradesLast30d?: number;
      tradeCount?: number;
      pumpFunTradeCount?: number;
      realizedPnlUsd?: number;
      realizedPnl7d?: number;
      tags?: string[];
      alreadyTracked: boolean;
      notes?: string;
      lastActiveAt?: number;
    }>,
    extraTags: string[] = []
  ): DiscoveredWallet[] =>
    list.map((w) => ({
      name: w.name,
      address: w.address,
      source: 'gmgn' as const,
      winRate: w.winRate,
      tradesLast7d: w.tradesLast7d,
      tradesLast30d: w.tradesLast30d,
      tradeCount: w.tradeCount,
      pumpFunTradeCount: w.pumpFunTradeCount,
      realizedPnlUsd: w.realizedPnlUsd ?? w.realizedPnl7d,
      smartFlowScore: Math.min(
        100,
        Math.round(
          (w.winRate ?? 0) * 0.6 + Math.min(40, (w.tradesLast7d ?? 0) / 2)
        )
      ),
      tags: Array.from(new Set([...(w.tags ?? []), ...extraTags])),
      alreadyTracked: w.alreadyTracked,
      notes: w.notes,
      lastActiveAt: w.lastActiveAt,
      metrics: {
        winRate: w.winRate ?? 0,
        pnlUsd: Math.round(w.realizedPnlUsd ?? w.realizedPnl7d ?? 0),
        ...(w.tradesLast7d != null ? { trades7d: w.tradesLast7d } : {}),
        ...(w.tradesLast30d != null ? { trades30d: w.tradesLast30d } : {}),
        ...(w.pumpFunTradeCount != null
          ? { pumpFunTrades: w.pumpFunTradeCount }
          : {}),
        smartFlowScore: Math.min(
          100,
          Math.round(
            (w.winRate ?? 0) * 0.6 + Math.min(40, (w.tradesLast7d ?? 0) / 2)
          )
        ),
      },
    }));

  try {
    console.log(
      `[discovery] GMGN start limit=${limit} period=${period} minWin=${minWinRate} pump=${pumpFunFocus}`
    );
    if (pumpFunFocus) {
      let wallets: DiscoveredWallet[] = [];
      let searchMsg = '';
      let searchSource: string = 'curated';
      try {
        const search = await raceTimeout(
          searchWallets({
            limit,
            period,
            minWinRate,
            pumpFunFocus: true,
            minTrades7d: config.gmgn?.discovery?.minTrades7d,
            maxDaysInactive: config.gmgn?.discovery?.activityDays,
          }),
          DISCOVERY_SOURCE_MS,
          () => null as null
        );
        if (search) {
          wallets = mapGmgn(search.candidates, ['pump.fun', 'pump-smart']);
          searchMsg = search.message ?? '';
          searchSource = search.source;
        }
      } catch (err) {
        searchMsg = err instanceof Error ? err.message : String(err);
      }
      console.log(`[discovery] GMGN pump focus → ${wallets.length}`);
      if (
        !opts.skipKolscan &&
        wallets.length < Math.min(12, limit)
      ) {
        const kol = await raceTimeout(
          discoverFromKolscan(limit),
          2_500,
          () => emptyDiscovery('kolscan', 'Kolscan skip', 'timeout')
        );
        wallets = mergeDiscovered(
          [wallets, kol.wallets, manualCurated(limit, 'gmgn')],
          limit
        );
      } else if (wallets.length === 0) {
        wallets = manualCurated(limit, 'gmgn');
      }
      return {
        source: 'gmgn',
        wallets,
        fetchedAt: Date.now(),
        cached: false,
        message: `GMGN Pump.fun · ${searchSource} · ${wallets.length} wallet(s)`,
        error: searchMsg.includes('warning') ? searchMsg : undefined,
      };
    }

    const top = await raceTimeout(
      getTopSmartWallets(limit, period, minWinRate),
      DISCOVERY_SOURCE_MS,
      () => {
        const curated = getCuratedSmartWallets(limit, period, 0);
        curated.error = 'GMGN timed out — curated fallback';
        return curated;
      }
    );
    let wallets = mapGmgn(top.wallets);

    console.log(
      `[discovery] GMGN top source=${top.source} count=${wallets.length} err=${top.error ?? 'none'}`
    );

    // Short optional Kolscan top-up only for standalone GMGN (not multi-source).
    if (
      !opts.skipKolscan &&
      (wallets.length < Math.min(15, limit) || top.source === 'curated')
    ) {
      const kol = await raceTimeout(
        discoverFromKolscan(limit),
        2_500,
        () => emptyDiscovery('kolscan', 'Kolscan skip', 'timeout')
      );
      wallets = mergeDiscovered(
        [wallets, kol.wallets, manualCurated(limit, 'gmgn')],
        limit
      );
      return {
        source: 'gmgn',
        wallets,
        fetchedAt: Date.now(),
        cached: false,
        message: `GMGN ${top.source} + fallbacks · ${wallets.length} wallet(s)`,
        error: top.error ?? kol.error,
      };
    }

    if (wallets.length === 0) {
      wallets = manualCurated(limit, 'gmgn');
    }

    return {
      source: 'gmgn',
      wallets,
      fetchedAt: Date.now(),
      cached: top.cached,
      message: `GMGN ${top.source}${top.cached ? ' (cache)' : ''} · ${wallets.length} wallet(s)`,
      error: top.error,
    };
  } catch (err) {
    console.error('[discovery] GMGN failed:', err);
    return {
      source: 'gmgn',
      wallets: manualCurated(limit, 'gmgn'),
      fetchedAt: Date.now(),
      cached: false,
      message: 'GMGN failed — curated fallback',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

let lastDiscovery: DiscoveryResult | null = null;

/**
 * Unified smart-wallet discovery across platforms.
 */
export async function findSmartWallets(
  options: FindSmartWalletsOptions = {}
): Promise<DiscoveryResult> {
  const source: DiscoverySource =
    options.source ??
    config.walletDiscovery?.defaultSource ??
    'gmgn';
  const limit = Math.min(Math.max(options.limit ?? 40, 1), 100);
  const period: GmgnPeriod = options.period ?? '30d';
  const minWinRate =
    options.minWinRate ?? config.gmgn?.discovery?.minWinRate ?? 40;
  const pumpFunFocus = Boolean(
    options.pumpFunFocus ?? config.gmgn?.discovery?.pumpFunFocus
  );

  const cacheKey = `${source}:${limit}:${period}:${minWinRate}:${pumpFunFocus}:${(options.manualText ?? '').slice(0, 40)}`;
  if (!options.force) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      console.log(`[discovery] cache hit ${cacheKey}`);
      return { ...hit.data, cached: true };
    }
  }

  console.log(
    `[discovery] findSmartWallets source=${source} limit=${limit} period=${period} minWin=${minWinRate} pump=${pumpFunFocus} force=${!!options.force}`
  );
  logger.info('System', `findSmartWallets source=${source}`, {
    limit,
    period,
    pumpFunFocus,
  });

  const curatedNow = (): DiscoveryResult => ({
    source,
    wallets: manualCurated(limit, source === 'manual' ? 'manual' : source),
    fetchedAt: Date.now(),
    cached: false,
    message: `Discovery budget ${DISCOVERY_OVERALL_MS}ms exceeded — curated fallback`,
    error: 'timeout',
  });

  const work = (async (): Promise<DiscoveryResult> => {
    let result: DiscoveryResult;
    switch (source) {
      case 'birdeye':
        result = await discoverBirdeye(limit);
        if (result.wallets.length < Math.min(10, limit)) {
          const kol = await raceTimeout(
            discoverFromKolscan(limit),
            2_500,
            () => emptyDiscovery('kolscan', 'Kolscan skip', 'timeout')
          );
          result = {
            ...result,
            wallets: mergeDiscovered(
              [result.wallets, kol.wallets, manualCurated(limit, 'birdeye')],
              limit
            ),
            message: `${result.message} · topped up via Kolscan/curated`,
          };
        }
        break;
      case 'dexscreener':
        result = await discoverDexScreener(limit);
        if (result.wallets.length < Math.min(10, limit)) {
          const kol = await raceTimeout(
            discoverFromKolscan(limit),
            2_500,
            () => emptyDiscovery('kolscan', 'Kolscan skip', 'timeout')
          );
          result = {
            ...result,
            wallets: mergeDiscovered(
              [
                result.wallets,
                kol.wallets,
                manualCurated(limit, 'dexscreener'),
              ],
              limit
            ),
            message: `${result.message} · topped up via Kolscan/curated`,
          };
        }
        break;
      case 'kolscan':
        result = await discoverFromKolscan(limit);
        break;
      case 'axiom':
        result = await discoverFromPlatformLeaderboard('axiom', limit, period);
        break;
      case 'photon':
        result = await discoverFromPlatformLeaderboard('photon', limit, period);
        break;
      case 'bullx':
        result = await discoverFromPlatformLeaderboard('bullx', limit, period);
        break;
      case 'all':
        result = await discoverAll(limit, period, minWinRate, pumpFunFocus);
        break;
      case 'manual': {
        const fromText = options.manualText
          ? parseManualText(options.manualText, limit)
          : [];
        const wallets =
          fromText.length > 0 ? fromText : manualCurated(limit, 'manual');
        result = {
          source: 'manual',
          wallets,
          fetchedAt: Date.now(),
          cached: false,
          message:
            fromText.length > 0
              ? `Manual import · ${fromText.length} address(es)`
              : `Manual curated · ${wallets.length} wallet(s)`,
        };
        break;
      }
      case 'gmgn':
      default:
        result = await discoverGmgn(limit, period, minWinRate, pumpFunFocus);
        break;
    }

    console.log(
      `[discovery] done source=${result.source} count=${result.wallets.length} msg=${result.message}`
    );

    // Last-resort guarantee: never hand the dashboard an empty Discover table.
    if (!result.wallets.length && source !== 'bullx') {
      const curated = manualCurated(
        limit,
        source === 'manual' ? 'manual' : source
      );
      result = {
        ...result,
        wallets: curated,
        message: `${result.message || result.source} · curated fallback (${curated.length})`,
        error: result.error || 'No live wallets — curated fallback',
      };
      console.warn(
        `[discovery] empty result for ${source} — injected ${curated.length} curated wallet(s)`
      );
    }

    return result;
  })();

  work.catch((err) => {
    console.warn(
      '[discovery] background work error after budget:',
      err instanceof Error ? err.message : err
    );
  });

  // Manual is sync/curated — no need to race.
  const result =
    source === 'manual'
      ? await work
      : await raceTimeout(work, DISCOVERY_OVERALL_MS, curatedNow);

  cache.set(cacheKey, {
    data: result,
    expiresAt: Date.now() + cacheTtlMs(),
  });

  lastDiscovery = result;
  return result;
}

export function getLastDiscovery(): DiscoveryResult | null {
  return lastDiscovery;
}

export function clearDiscoveryCache(): void {
  cache.clear();
  logger.info('System', 'wallet discovery cache cleared');
}

export function getDiscoveryStatus() {
  return {
    defaultSource: config.walletDiscovery?.defaultSource ?? 'gmgn',
    hasBirdeyeKey: hasBirdeyeKey(),
    hasSolanaTrackerKey: hasSolanaTrackerKey(),
    cacheSize: cache.size,
    cacheTtlMs: cacheTtlMs(),
    last: lastDiscovery
      ? {
          source: lastDiscovery.source,
          count: lastDiscovery.wallets.length,
          fetchedAt: lastDiscovery.fetchedAt,
          cached: lastDiscovery.cached,
          message: lastDiscovery.message,
          error: lastDiscovery.error ?? null,
        }
      : null,
  };
}
