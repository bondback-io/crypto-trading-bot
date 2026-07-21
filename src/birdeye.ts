/**
 * Birdeye Data API client — token overview, trending, smart-money signals.
 * Falls back gracefully when API key is missing or requests fail.
 */

import { config } from './config';
import { logger, errorToMeta, loggedFetch } from './logger';

export interface BirdeyeTokenOverview {
  mint: string;
  symbol: string | null;
  name: string | null;
  price: number | null;
  priceChange24hPct: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  volumeBuy24hUsd: number | null;
  volumeSell24hUsd: number | null;
  holder: number | null;
  trade24h: number | null;
  buy24h: number | null;
  sell24h: number | null;
  uniqueWallet24h: number | null;
  uniqueWallet24hChangePct: number | null;
  marketCap: number | null;
  /** Buy volume / sell volume (1 = balanced) */
  buySellRatio: number | null;
  source: 'birdeye' | 'cache' | 'none';
  fetchedAt: number;
  error?: string;
}

export interface BirdeyeSmartMoneySignal {
  mint: string;
  symbol: string | null;
  /** 0–100 composite from volume, unique wallets, buy pressure, liquidity */
  smartMoneyScore: number;
  trendingRank: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  uniqueWallet24hChangePct: number | null;
  buySellRatio: number | null;
  flags: string[];
  source: 'birdeye' | 'none';
  fetchedAt: number;
  error?: string;
}

export interface BirdeyeTrendingToken {
  mint: string;
  symbol: string;
  name: string;
  rank: number;
  price: number | null;
  priceChange24hPct: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  marketCap: number | null;
}

const overviewCache = new Map<
  string,
  { data: BirdeyeTokenOverview; expiresAt: number }
>();
const signalCache = new Map<
  string,
  { data: BirdeyeSmartMoneySignal; expiresAt: number }
>();
const trendingCache: {
  data: BirdeyeTrendingToken[] | null;
  expiresAt: number;
} = { data: null, expiresAt: 0 };

function cacheTtlMs(): number {
  return config.birdeye?.cacheTtlMs ?? 90_000;
}

export function getBirdeyeApiKey(): string {
  return (
    process.env.BIRDEYE_API_KEY?.trim() ||
    config.birdeye?.apiKey?.trim() ||
    config.walletDiscovery?.birdeyeApiKey?.trim() ||
    ''
  );
}

export function getBirdeyeBaseUrl(): string {
  return (
    process.env.BIRDEYE_BASE_URL?.trim() ||
    config.birdeye?.baseUrl ||
    config.walletDiscovery?.birdeyeBaseUrl ||
    'https://public-api.birdeye.so'
  ).replace(/\/$/, '');
}

export function hasBirdeyeKey(): boolean {
  return Boolean(getBirdeyeApiKey());
}

export function getBirdeyeStatus() {
  return {
    hasApiKey: hasBirdeyeKey(),
    baseUrl: getBirdeyeBaseUrl(),
    cacheTtlMs: cacheTtlMs(),
    overviewCacheSize: overviewCache.size,
    signalCacheSize: signalCache.size,
  };
}

function emptyOverview(
  mint: string,
  extra: Partial<BirdeyeTokenOverview> = {}
): BirdeyeTokenOverview {
  return {
    mint,
    symbol: null,
    name: null,
    price: null,
    priceChange24hPct: null,
    liquidityUsd: null,
    volume24hUsd: null,
    volumeBuy24hUsd: null,
    volumeSell24hUsd: null,
    holder: null,
    trade24h: null,
    buy24h: null,
    sell24h: null,
    uniqueWallet24h: null,
    uniqueWallet24hChangePct: null,
    marketCap: null,
    buySellRatio: null,
    source: 'none',
    fetchedAt: Date.now(),
    ...extra,
  };
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Low-level Birdeye GET with auth + logging + retries */
export async function birdeyeRequest(
  path: string,
  label: string,
  timeoutMs = 10_000
): Promise<{ ok: boolean; status: number; data: unknown; error?: string }> {
  const key = getBirdeyeApiKey();
  if (!key) {
    console.warn(`[birdeye] ${label}: missing API key`);
    return { ok: false, status: 0, data: null, error: 'No BIRDEYE_API_KEY' };
  }

  const url = `${getBirdeyeBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
  const maxAttempts = 3;
  let lastError = 'Unknown error';
  let lastStatus = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(
        `[birdeye] ${label} attempt ${attempt}/${maxAttempts} ${path.slice(0, 100)}`
      );
      const res = await loggedFetch(url, {
        context: 'Birdeye',
        label,
        timeoutMs,
        headers: {
          Accept: 'application/json',
          'X-API-KEY': key,
          'x-chain': 'solana',
        },
      });
      if (res.status === 429 || res.status >= 500) {
        lastStatus = res.status;
        lastError = `HTTP ${res.status}`;
        console.warn(`[birdeye] ${label} ${lastError} — retrying`);
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        lastStatus = res.status;
        lastError = `HTTP ${res.status}: ${body.slice(0, 160)}`;
        console.warn(`[birdeye] ${label} ${lastError}`);
        return { ok: false, status: res.status, data: null, error: lastError };
      }
      const data = await res.json();
      console.log(`[birdeye] ${label} OK`);
      return { ok: true, status: res.status, data };
    } catch (err) {
      lastStatus = 0;
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`[birdeye] ${label} fetch failed:`, lastError);
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }

  return {
    ok: false,
    status: lastStatus,
    data: null,
    error: lastError,
  };
}

function parseOverviewRow(
  mint: string,
  row: Record<string, unknown>
): BirdeyeTokenOverview {
  const volBuy = num(row.vBuy24hUSD);
  const volSell = num(row.vSell24hUSD);
  const ratio =
    volBuy != null && volSell != null && volSell > 0
      ? Math.round((volBuy / volSell) * 100) / 100
      : null;

  return {
    mint,
    symbol: row.symbol != null ? String(row.symbol) : null,
    name: row.name != null ? String(row.name) : null,
    price: num(row.price),
    priceChange24hPct: num(row.priceChange24hPercent),
    liquidityUsd: num(row.liquidity),
    volume24hUsd: num(row.v24hUSD),
    volumeBuy24hUsd: volBuy,
    volumeSell24hUsd: volSell,
    holder: num(row.holder),
    trade24h: num(row.trade24h),
    buy24h: num(row.buy24h),
    sell24h: num(row.sell24h),
    uniqueWallet24h: num(row.uniqueWallet24h),
    uniqueWallet24hChangePct: num(row.uniqueWallet24hChangePercent),
    marketCap: num(row.marketCap ?? row.mc ?? row.realMc),
    buySellRatio: ratio,
    source: 'birdeye',
    fetchedAt: Date.now(),
  };
}

/**
 * Token overview: liquidity, holders, 24h volume, price, unique wallets.
 */
export async function getTokenOverview(
  mint: string,
  options: { force?: boolean } = {}
): Promise<BirdeyeTokenOverview> {
  const address = mint.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    return emptyOverview(address, { error: 'Invalid mint' });
  }

  if (!options.force) {
    const hit = overviewCache.get(address);
    if (hit && hit.expiresAt > Date.now()) {
      return { ...hit.data, source: 'cache' };
    }
  }

  if (!hasBirdeyeKey()) {
    return emptyOverview(address, {
      error: 'No BIRDEYE_API_KEY — Birdeye overview skipped',
    });
  }

  const res = await birdeyeRequest(
    `/defi/token_overview?address=${encodeURIComponent(address)}`,
    'token_overview'
  );

  if (!res.ok || !res.data) {
    logger.warn('Birdeye', 'token_overview failed', {
      mint: address.slice(0, 12),
      error: res.error,
      status: res.status,
    });
    return emptyOverview(address, { error: res.error ?? 'Request failed' });
  }

  const root = res.data as { success?: boolean; data?: Record<string, unknown> };
  const row = root.data ?? (res.data as Record<string, unknown>);
  if (!row || typeof row !== 'object') {
    return emptyOverview(address, { error: 'Empty overview payload' });
  }

  const overview = parseOverviewRow(address, row);
  overviewCache.set(address, {
    data: overview,
    expiresAt: Date.now() + cacheTtlMs(),
  });
  return overview;
}

/**
 * Trending Solana tokens (Birdeye rank list).
 */
export async function getTrendingTokens(
  limit = 20,
  options: { force?: boolean; interval?: '1h' | '4h' | '24h' } = {}
): Promise<{
  tokens: BirdeyeTrendingToken[];
  source: 'birdeye' | 'cache' | 'none';
  error?: string;
}> {
  const lim = Math.min(Math.max(limit, 1), 50);
  if (!options.force && trendingCache.data && trendingCache.expiresAt > Date.now()) {
    return {
      tokens: trendingCache.data.slice(0, lim),
      source: 'cache',
    };
  }

  if (!hasBirdeyeKey()) {
    return {
      tokens: [],
      source: 'none',
      error: 'No BIRDEYE_API_KEY',
    };
  }

  const interval = options.interval ?? '24h';
  const res = await birdeyeRequest(
    `/defi/token_trending?sort_by=rank&sort_type=asc&interval=${interval}&offset=0&limit=${lim}`,
    'token_trending'
  );

  if (!res.ok || !res.data) {
    return {
      tokens: [],
      source: 'none',
      error: res.error ?? 'Trending request failed',
    };
  }

  const list =
    (res.data as { data?: { tokens?: Record<string, unknown>[] } }).data
      ?.tokens ?? [];
  const tokens: BirdeyeTrendingToken[] = [];
  for (const t of list) {
    const mint = String(t.address ?? '');
    if (!mint) continue;
    tokens.push({
      mint,
      symbol: String(t.symbol ?? mint.slice(0, 6)),
      name: String(t.name ?? t.symbol ?? ''),
      rank: Number(t.rank ?? tokens.length + 1),
      price: num(t.price),
      priceChange24hPct: num(t.priceChange24hPercent),
      volume24hUsd: num(t.volume24hUSD),
      liquidityUsd: num(t.liquidity),
      marketCap: num(t.marketcap ?? t.marketCap),
    });
  }

  trendingCache.data = tokens;
  trendingCache.expiresAt = Date.now() + Math.min(cacheTtlMs(), 120_000);
  return { tokens, source: 'birdeye' };
}

/**
 * Smart-money / flow signal for a mint — uses overview + trending context.
 */
export async function getSmartMoneySignal(
  mint: string,
  options: { force?: boolean } = {}
): Promise<BirdeyeSmartMoneySignal> {
  const address = mint.trim();
  if (!options.force) {
    const hit = signalCache.get(address);
    if (hit && hit.expiresAt > Date.now()) return hit.data;
  }

  const overview = await getTokenOverview(address, { force: options.force });
  const flags: string[] = [];
  let score = 0;
  let trendingRank: number | null = null;

  if (overview.source === 'none' || overview.error) {
    const empty: BirdeyeSmartMoneySignal = {
      mint: address,
      symbol: null,
      smartMoneyScore: 0,
      trendingRank: null,
      volume24hUsd: null,
      liquidityUsd: null,
      uniqueWallet24hChangePct: null,
      buySellRatio: null,
      flags: ['birdeye_unavailable'],
      source: 'none',
      fetchedAt: Date.now(),
      error: overview.error,
    };
    return empty;
  }

  const liq = overview.liquidityUsd ?? 0;
  const vol = overview.volume24hUsd ?? 0;
  const uwChange = overview.uniqueWallet24hChangePct ?? 0;
  const ratio = overview.buySellRatio ?? 1;

  if (liq >= 50_000) {
    score += 20;
    flags.push('liq_ok');
  } else if (liq >= 10_000) {
    score += 10;
  } else if (liq > 0 && liq < 5_000) {
    flags.push('thin_liq');
    score -= 10;
  }

  if (vol >= 100_000) {
    score += 25;
    flags.push('high_volume');
  } else if (vol >= 20_000) {
    score += 15;
  } else if (vol >= 5_000) {
    score += 8;
  }

  if (uwChange >= 30) {
    score += 20;
    flags.push('wallet_inflow');
  } else if (uwChange >= 10) {
    score += 10;
  } else if (uwChange <= -20) {
    score -= 10;
    flags.push('wallet_outflow');
  }

  if (ratio >= 1.25) {
    score += 15;
    flags.push('buy_pressure');
  } else if (ratio <= 0.75) {
    score -= 10;
    flags.push('sell_pressure');
  }

  if ((overview.holder ?? 0) >= 500) {
    score += 10;
  }

  // Boost if mint is on Birdeye trending list
  try {
    const trend = await getTrendingTokens(30);
    const hit = trend.tokens.find((t) => t.mint === address);
    if (hit) {
      trendingRank = hit.rank;
      score += Math.max(5, 25 - hit.rank);
      flags.push(`trending_#${hit.rank}`);
    }
  } catch (err) {
    logger.warn('Birdeye', 'trending lookup for signal failed', errorToMeta(err));
  }

  // Optional: smart-money token list membership
  try {
    const sm = await birdeyeRequest(
      `/smart-money/v1/token/list?limit=50`,
      'smart_money_token_list',
      8_000
    );
    if (sm.ok && sm.data) {
      const items =
        (sm.data as { data?: { items?: unknown[] } | unknown[] }).data ?? [];
      const rows = Array.isArray(items)
        ? items
        : (items as { items?: unknown[] }).items ?? [];
      const found = rows.some((raw) => {
        const row = raw as Record<string, unknown>;
        const addr = String(
          row.address ?? row.token_address ?? row.tokenAddress ?? ''
        );
        return addr === address;
      });
      if (found) {
        score += 20;
        flags.push('smart_money_list');
      }
    }
  } catch {
    /* optional endpoint — ignore */
  }

  const signal: BirdeyeSmartMoneySignal = {
    mint: address,
    symbol: overview.symbol,
    smartMoneyScore: Math.max(0, Math.min(100, Math.round(score))),
    trendingRank,
    volume24hUsd: overview.volume24hUsd,
    liquidityUsd: overview.liquidityUsd,
    uniqueWallet24hChangePct: overview.uniqueWallet24hChangePct,
    buySellRatio: overview.buySellRatio,
    flags,
    source: 'birdeye',
    fetchedAt: Date.now(),
  };

  signalCache.set(address, {
    data: signal,
    expiresAt: Date.now() + cacheTtlMs(),
  });
  return signal;
}

/** Compact fields for dashboard / activity */
export function summarizeBirdeye(
  overview: BirdeyeTokenOverview | null | undefined,
  signal?: BirdeyeSmartMoneySignal | null
): {
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  price: number | null;
  priceChange24hPct: number | null;
  holder: number | null;
  uniqueWallet24h: number | null;
  buySellRatio: number | null;
  smartMoneyScore: number | null;
  flags: string[];
  source: string;
} | null {
  if (!overview && !signal) return null;
  return {
    liquidityUsd: overview?.liquidityUsd ?? signal?.liquidityUsd ?? null,
    volume24hUsd: overview?.volume24hUsd ?? signal?.volume24hUsd ?? null,
    price: overview?.price ?? null,
    priceChange24hPct: overview?.priceChange24hPct ?? null,
    holder: overview?.holder ?? null,
    uniqueWallet24h: overview?.uniqueWallet24h ?? null,
    buySellRatio: overview?.buySellRatio ?? signal?.buySellRatio ?? null,
    smartMoneyScore: signal?.smartMoneyScore ?? null,
    flags: signal?.flags ?? [],
    source: overview?.source ?? signal?.source ?? 'none',
  };
}

export function clearBirdeyeCache(): void {
  overviewCache.clear();
  signalCache.clear();
  trendingCache.data = null;
  trendingCache.expiresAt = 0;
  logger.info('Birdeye', 'cache cleared');
}
