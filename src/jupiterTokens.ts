/**
 * Jupiter Tokens API v2 — trending / toptraded / toporganicscore universe.
 * Requires JUPITER_API_KEY (https://developers.jup.ag/portal).
 */

import { logger, errorToMeta, loggedFetch } from './logger';
import type { LaunchEvent } from './marketData';

export type JupiterCategory = 'toptraded' | 'toptrending' | 'toporganicscore';
export type JupiterInterval = '5m' | '1h' | '6h' | '24h';

export interface JupiterSwapStats {
  priceChange?: number;
  holderChange?: number;
  liquidityChange?: number;
  volumeChange?: number;
  buyVolume?: number;
  sellVolume?: number;
  buyOrganicVolume?: number;
  sellOrganicVolume?: number;
  numBuys?: number;
  numSells?: number;
  numTraders?: number;
  numOrganicBuyers?: number;
  numNetBuyers?: number;
}

export interface JupiterTokenAudit {
  mintAuthorityDisabled?: boolean;
  freezeAuthorityDisabled?: boolean;
  /** Jupiter Terminal–style Top 10 Holders % (pool/curve excluded) */
  topHoldersPercentage?: number;
  devBalancePercentage?: number;
  devMigrations?: number;
  devMints?: number;
  isSus?: boolean;
}

export interface JupiterTokenInfo {
  id: string;
  name?: string;
  symbol?: string;
  icon?: string | null;
  decimals?: number;
  usdPrice?: number | null;
  mcap?: number | null;
  fdv?: number | null;
  liquidity?: number | null;
  holderCount?: number | null;
  organicScore?: number;
  organicScoreLabel?: string;
  isVerified?: boolean | null;
  tags?: string[] | null;
  launchpad?: string | null;
  createdAt?: string;
  graduatedPool?: string | null;
  graduatedAt?: string | null;
  firstPool?: { id?: string; createdAt?: string } | null;
  audit?: JupiterTokenAudit | null;
  stats5m?: JupiterSwapStats | null;
  stats1h?: JupiterSwapStats | null;
  stats6h?: JupiterSwapStats | null;
  stats24h?: JupiterSwapStats | null;
  updatedAt?: string;
}

const CACHE_TTL_MS = 75_000;
const MINT_LOOKUP_TTL_MS = 60_000;
const cache = new Map<
  string,
  { tokens: JupiterTokenInfo[]; expiresAt: number }
>();
const mintLookupCache = new Map<
  string,
  { token: JupiterTokenInfo | null; expiresAt: number }
>();

let lastError: string | null = null;
let lastFetchAt: number | null = null;
let lastCount = 0;

export function getJupiterApiKey(): string {
  return process.env.JUPITER_API_KEY?.trim() || '';
}

export function hasJupiterApiKey(): boolean {
  return Boolean(getJupiterApiKey());
}

export function getJupiterTokensStatus(): {
  hasApiKey: boolean;
  lastError: string | null;
  lastFetchAt: number | null;
  lastCount: number;
} {
  return {
    hasApiKey: hasJupiterApiKey(),
    lastError,
    lastFetchAt,
    lastCount,
  };
}

/**
 * Best-effort lookup from in-memory Jupiter category / mint caches (no network).
 * Used to enrich anti-rug hard floors with organicScore / buy-sell txn counts.
 */
export function lookupCachedJupiterToken(
  mint: string
): JupiterTokenInfo | null {
  const key = String(mint || '').trim();
  if (!key) return null;
  const now = Date.now();
  const mintHit = mintLookupCache.get(key);
  if (mintHit && mintHit.expiresAt > now && mintHit.token) {
    return mintHit.token;
  }
  let best: JupiterTokenInfo | null = null;
  for (const hit of cache.values()) {
    if (hit.expiresAt <= now) continue;
    const found = hit.tokens.find((t) => t?.id === key);
    if (!found) continue;
    if (!best) {
      best = found;
      continue;
    }
    // Prefer entry with organicScore / richer 1h stats / audit top10
    const bestOrg = best.organicScore != null ? 1 : 0;
    const foundOrg = found.organicScore != null ? 1 : 0;
    const bestTop = best.audit?.topHoldersPercentage != null ? 1 : 0;
    const foundTop = found.audit?.topHoldersPercentage != null ? 1 : 0;
    const bestBuys = best.stats1h?.numBuys != null ? 1 : 0;
    const foundBuys = found.stats1h?.numBuys != null ? 1 : 0;
    if (foundOrg + foundTop + foundBuys > bestOrg + bestTop + bestBuys) {
      best = found;
    }
  }
  return best;
}

/** Jupiter Terminal–style Top 10 Holders % from cached/fetched token audit. */
export function jupiterTopHoldersPercentage(
  token: JupiterTokenInfo | null | undefined
): number | null {
  const n = Number(token?.audit?.topHoldersPercentage);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Fetch a single mint via Tokens v2 search (includes audit.topHoldersPercentage).
 * Short TTL cache; returns null when API key missing or mint not found.
 */
export async function fetchJupiterTokenByMint(
  mint: string
): Promise<JupiterTokenInfo | null> {
  const key = String(mint || '').trim();
  if (!key) return null;

  const now = Date.now();
  const cached = mintLookupCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.token;
  }

  const fromCategory = (() => {
    let best: JupiterTokenInfo | null = null;
    for (const hit of cache.values()) {
      if (hit.expiresAt <= now) continue;
      const found = hit.tokens.find((t) => t?.id === key);
      if (!found) continue;
      if (
        !best ||
        (found.audit?.topHoldersPercentage != null &&
          best.audit?.topHoldersPercentage == null)
      ) {
        best = found;
      }
    }
    return best;
  })();

  if (fromCategory && jupiterTopHoldersPercentage(fromCategory) != null) {
    mintLookupCache.set(key, {
      token: fromCategory,
      expiresAt: now + MINT_LOOKUP_TTL_MS,
    });
    return fromCategory;
  }

  const apiKey = getJupiterApiKey();
  if (!apiKey) {
    mintLookupCache.set(key, {
      token: fromCategory,
      expiresAt: now + Math.min(MINT_LOOKUP_TTL_MS, 15_000),
    });
    return fromCategory;
  }

  const url = `https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(key)}`;
  try {
    const res = await loggedFetch(url, {
      context: 'Jupiter',
      label: 'token by mint',
      timeoutMs: 12_000,
      headers: {
        Accept: 'application/json',
        'x-api-key': apiKey,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      lastError = `HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`;
      logger.warn('Jupiter', 'Mint search failed', {
        mint: key.slice(0, 12),
        status: res.status,
      });
      mintLookupCache.set(key, {
        token: fromCategory,
        expiresAt: now + 15_000,
      });
      return fromCategory;
    }
    const data = (await res.json()) as unknown;
    const list = Array.isArray(data)
      ? (data as JupiterTokenInfo[])
      : Array.isArray((data as { tokens?: JupiterTokenInfo[] })?.tokens)
        ? (data as { tokens: JupiterTokenInfo[] }).tokens
        : [];
    const exact =
      list.find((t) => t && String(t.id || '').trim() === key) ?? null;
    mintLookupCache.set(key, {
      token: exact,
      expiresAt: now + MINT_LOOKUP_TTL_MS,
    });
    if (exact) {
      lastError = null;
      lastFetchAt = now;
    }
    return exact ?? fromCategory;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    logger.warn('Jupiter', 'Mint search error', {
      mint: key.slice(0, 12),
      ...errorToMeta(err),
    });
    mintLookupCache.set(key, {
      token: fromCategory,
      expiresAt: now + 15_000,
    });
    return fromCategory;
  }
}

function volumeFromStats(
  stats: JupiterSwapStats | null | undefined,
  preferOrganic: boolean
): { total: number; organic: number } {
  const buy = Number(stats?.buyVolume ?? 0);
  const sell = Number(stats?.sellVolume ?? 0);
  const buyOrg = Number(stats?.buyOrganicVolume ?? 0);
  const sellOrg = Number(stats?.sellOrganicVolume ?? 0);
  const total =
    (Number.isFinite(buy) ? buy : 0) + (Number.isFinite(sell) ? sell : 0);
  const organic =
    (Number.isFinite(buyOrg) ? buyOrg : 0) +
    (Number.isFinite(sellOrg) ? sellOrg : 0);
  if (preferOrganic && organic > 0) {
    return { total: organic, organic };
  }
  return { total, organic };
}

function isPumpFunToken(token: JupiterTokenInfo): boolean {
  const mint = String(token.id || '').trim();
  if (mint.toLowerCase().endsWith('pump')) return true;

  const tags = Array.isArray(token.tags)
    ? token.tags.map((t) => String(t).toLowerCase())
    : [];
  if (
    tags.some(
      (t) =>
        t.includes('pump') ||
        t === 'pump.fun' ||
        t === 'pumpfun'
    )
  ) {
    return true;
  }

  const launchpad = String(token.launchpad || '').toLowerCase();
  if (
    launchpad.includes('pump') ||
    launchpad === 'pump.fun' ||
    launchpad === 'pumpfun'
  ) {
    return true;
  }

  const sym = String(token.symbol || '').toLowerCase();
  const name = String(token.name || '').toLowerCase();
  if (
    /\bpump\.?fun\b/.test(sym) ||
    /\bpump\.?fun\b/.test(name) ||
    sym.includes('pumpfun') ||
    name.includes('pumpfun')
  ) {
    return true;
  }

  return false;
}

export function jupiterTokenToLaunchEvent(
  token: JupiterTokenInfo,
  solUsd: number,
  opts?: { preferOrganicVolume?: boolean }
): LaunchEvent {
  const preferOrganic = opts?.preferOrganicVolume !== false;
  const mint = String(token.id || '').trim();
  const sol = solUsd > 0 ? solUsd : 150;
  const usdPrice = Number(token.usdPrice ?? 0);
  const priceSol =
    usdPrice > 0 && sol > 0 && Number.isFinite(usdPrice) ? usdPrice / sol : 0;

  const vol5 = volumeFromStats(token.stats5m, preferOrganic);
  const vol1h = volumeFromStats(token.stats1h, preferOrganic);
  const vol6h = volumeFromStats(token.stats6h, preferOrganic);
  const vol24 = volumeFromStats(token.stats24h, preferOrganic);

  const organic5 = volumeFromStats(token.stats5m, false).organic;
  const organic1h = volumeFromStats(token.stats1h, false).organic;
  const organic6h = volumeFromStats(token.stats6h, false).organic;
  const organic24 = volumeFromStats(token.stats24h, false).organic;

  const pc1h = Number(token.stats1h?.priceChange);
  const pc24 = Number(token.stats24h?.priceChange);
  const priceChangePct = Number.isFinite(pc1h)
    ? pc1h
    : Number.isFinite(pc24)
      ? pc24
      : 0;

  const isPump = mint.toLowerCase().endsWith('pump') || isPumpFunToken(token);
  const launchedAt = token.firstPool?.createdAt
    ? Date.parse(token.firstPool.createdAt)
    : token.createdAt
      ? Date.parse(token.createdAt)
      : Date.now();

  // Liquidity ≠ migration event. Only stamp migrated for real graduation evidence
  // (graduatedAt) or ultra-fresh pump-with-liq. Prevents Jupiter trending majors
  // from lighting MIG_FLAG / signalKind=migration and wasting Migration Sniper.
  const graduatedAtMs = token.graduatedAt
    ? Date.parse(String(token.graduatedAt))
    : NaN;
  const ageMs = Number.isFinite(launchedAt)
    ? Math.max(0, Date.now() - launchedAt)
    : Number.POSITIVE_INFINITY;
  const FRESH_MIG_MS = 6 * 60 * 60_000;
  const migrated = Number.isFinite(graduatedAtMs)
    ? Date.now() - graduatedAtMs <= FRESH_MIG_MS
    : Boolean(
        isPump &&
          token.liquidity != null &&
          Number(token.liquidity) > 0 &&
          ageMs <= FRESH_MIG_MS
      );

  const event: LaunchEvent = {
    mint,
    symbol: String(token.symbol || mint.slice(0, 6)).slice(0, 24),
    name: String(token.name || token.symbol || 'Unknown').slice(0, 64),
    launchedAt: Number.isFinite(launchedAt) ? launchedAt : Date.now(),
    migrated,
    entryPriceSol: priceSol,
    lastPriceSol: priceSol,
    priceChangePct,
    liquidityUsd:
      token.liquidity != null && Number.isFinite(Number(token.liquidity))
        ? Number(token.liquidity)
        : undefined,
    volumeUsd: vol24.total > 0 ? vol24.total : undefined,
    volumeM5Usd: vol5.total > 0 ? vol5.total : undefined,
    volumeH1Usd: vol1h.total > 0 ? vol1h.total : undefined,
    volumeH6Usd: vol6h.total > 0 ? vol6h.total : undefined,
    volumeOrganicM5Usd: organic5 > 0 ? organic5 : undefined,
    volumeOrganicH1Usd: organic1h > 0 ? organic1h : undefined,
    volumeOrganicH6Usd: organic6h > 0 ? organic6h : undefined,
    volumeOrganicUsd: organic24 > 0 ? organic24 : undefined,
    marketCapUsd:
      token.mcap != null && Number.isFinite(Number(token.mcap))
        ? Number(token.mcap)
        : undefined,
    holderCount:
      token.holderCount != null && Number.isFinite(Number(token.holderCount))
        ? Number(token.holderCount)
        : undefined,
    organicScore:
      token.organicScore != null && Number.isFinite(Number(token.organicScore))
        ? Number(token.organicScore)
        : undefined,
    isPumpFun: isPump,
    candles: [],
    source: 'jupiter',
    solUsd: sol,
    priceChangeH1Pct: Number.isFinite(pc1h) ? pc1h : undefined,
    candleSource: 'synthetic',
  };
  return event;
}

/**
 * Recently listed tokens (first pool creation) — AlphaScan-style "New" source.
 * Does not alter trending category fetches.
 */
export async function fetchJupiterRecentTokens(
  limit = 30
): Promise<JupiterTokenInfo[]> {
  const key = getJupiterApiKey();
  if (!key) {
    lastError = 'No JUPITER_API_KEY';
    return [];
  }

  const lim = Math.max(10, Math.min(100, Math.round(limit) || 30));
  const cacheKey = `recent:${lim}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.tokens;
  }

  const url = `https://api.jup.ag/tokens/v2/recent`;
  try {
    const res = await loggedFetch(url, {
      context: 'Jupiter',
      label: 'tokens recent',
      timeoutMs: 20_000,
      headers: {
        Accept: 'application/json',
        'x-api-key': key,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      lastError = `HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`;
      logger.warn('Jupiter', 'Recent fetch failed', { status: res.status });
      return hit?.tokens ?? [];
    }
    const data = (await res.json()) as unknown;
    const list = Array.isArray(data)
      ? (data as JupiterTokenInfo[])
      : Array.isArray((data as { tokens?: JupiterTokenInfo[] })?.tokens)
        ? (data as { tokens: JupiterTokenInfo[] }).tokens
        : [];
    let tokens = list.filter((t) => t && typeof t.id === 'string' && t.id);
    if (tokens.length > lim) tokens = tokens.slice(0, lim);
    cache.set(cacheKey, {
      tokens,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    lastError = null;
    lastFetchAt = Date.now();
    lastCount = tokens.length;
    return tokens;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    logger.warn('Jupiter', 'Recent fetch error', errorToMeta(err));
    return hit?.tokens ?? [];
  }
}

/** Pump.fun / pump launchpad heuristic on a Jupiter token row. */
export function isJupiterPumpFunToken(token: JupiterTokenInfo): boolean {
  return isPumpFunToken(token);
}

export async function fetchJupiterTopTokens(
  category: JupiterCategory,
  interval: JupiterInterval,
  limit: number
): Promise<JupiterTokenInfo[]> {
  const key = getJupiterApiKey();
  if (!key) {
    lastError = 'No JUPITER_API_KEY';
    return [];
  }

  const lim = Math.max(10, Math.min(100, Math.round(limit) || 50));
  const cacheKey = `${category}:${interval}:${lim}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.tokens;
  }

  const url = `https://api.jup.ag/tokens/v2/${category}/${interval}?limit=${lim}`;
  try {
    const res = await loggedFetch(url, {
      context: 'Jupiter',
      label: `tokens ${category}/${interval}`,
      timeoutMs: 20_000,
      headers: {
        Accept: 'application/json',
        'x-api-key': key,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      lastError = `HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`;
      logger.warn('Jupiter', 'Category fetch failed', {
        category,
        interval,
        status: res.status,
      });
      return hit?.tokens ?? [];
    }
    const data = (await res.json()) as unknown;
    const list = Array.isArray(data)
      ? (data as JupiterTokenInfo[])
      : Array.isArray((data as { tokens?: JupiterTokenInfo[] })?.tokens)
        ? (data as { tokens: JupiterTokenInfo[] }).tokens
        : [];
    const tokens = list.filter((t) => t && typeof t.id === 'string' && t.id);
    cache.set(cacheKey, {
      tokens,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    lastError = null;
    lastFetchAt = Date.now();
    lastCount = tokens.length;
    return tokens;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    logger.warn('Jupiter', 'Category fetch error', {
      category,
      interval,
      ...errorToMeta(err),
    });
    return hit?.tokens ?? [];
  }
}

export async function fetchJupiterPumpTrending(opts: {
  category?: JupiterCategory;
  limit?: number;
  pumpFunOnly?: boolean;
  mergeIntervals?: boolean;
  preferOrganicVolume?: boolean;
  solUsd?: number;
}): Promise<LaunchEvent[]> {
  if (!hasJupiterApiKey()) {
    lastError = lastError || 'No JUPITER_API_KEY';
    return [];
  }

  const category: JupiterCategory = opts.category ?? 'toptraded';
  const limit = Math.max(10, Math.min(100, Math.round(opts.limit ?? 50)));
  const pumpFunOnly = opts.pumpFunOnly !== false;
  const mergeIntervals = opts.mergeIntervals !== false;
  const preferOrganic = opts.preferOrganicVolume !== false;
  const solUsd = opts.solUsd && opts.solUsd > 0 ? opts.solUsd : 150;

  const intervals: JupiterInterval[] = mergeIntervals
    ? ['5m', '1h', '6h', '24h']
    : ['1h'];

  const byMint = new Map<string, JupiterTokenInfo>();
  await Promise.all(
    intervals.map(async (interval) => {
      const tokens = await fetchJupiterTopTokens(category, interval, limit);
      for (const t of tokens) {
        const mint = String(t.id || '').trim();
        if (!mint) continue;
        const prev = byMint.get(mint);
        if (!prev) {
          byMint.set(mint, t);
          continue;
        }
        // Prefer richer stats when merging windows
        byMint.set(mint, {
          ...prev,
          ...t,
          stats5m: t.stats5m ?? prev.stats5m,
          stats1h: t.stats1h ?? prev.stats1h,
          stats6h: t.stats6h ?? prev.stats6h,
          stats24h: t.stats24h ?? prev.stats24h,
        });
      }
    })
  );

  let tokens = [...byMint.values()];
  if (pumpFunOnly) {
    tokens = tokens.filter(isPumpFunToken);
  }

  lastFetchAt = Date.now();
  lastCount = tokens.length;

  return tokens.map((t) =>
    jupiterTokenToLaunchEvent(t, solUsd, { preferOrganicVolume: preferOrganic })
  );
}
