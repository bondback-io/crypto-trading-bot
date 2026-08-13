/**
 * On-chain + DexScreener/GMGN token metrics for buy filters.
 * Liquidity, holder concentration, mint/dev authority activity — with TTL cache.
 */

import { PublicKey } from '@solana/web3.js';
import {
  config,
  effectiveMinHolders,
  effectiveMinLiquidityUsd,
  effectiveMinMarketCapUsd,
  effectiveMinTop10HolderPct,
  effectiveMaxTop10HolderPct,
} from './config';
import { getBondingCurvePda } from './bondingCurve';
import { getConnection, runWithRpcRole } from './connection';
import { getRpcRoleFor } from './rpcRouting';
import { logger, errorToMeta, loggedFetch } from './logger';
import { effectiveStrictMinVolume24hUsd } from './filterEffective';
import {
  fetchJupiterTokenByMint,
  jupiterTopHoldersPercentage,
  lookupCachedJupiterToken,
} from './jupiterTokens';
import { isStrategyEnabled } from './strategies';

export interface HolderBucket {
  address: string;
  amountUi: number;
  pctOfSupply: number;
  isAuthority?: boolean;
}

export interface TokenMetrics {
  mint: string;
  symbol?: string;
  name?: string;
  /** USD liquidity from DexScreener (best pool) */
  liquidityUsd: number | null;
  /** Circulating market cap USD (never FDV — Dex may omit when circ unknown) */
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  /** DexScreener rolling 1h volume (15–60m activity proxy) */
  volumeH1Usd: number | null;
  /** DexScreener rolling 5m volume */
  volumeM5Usd: number | null;
  /** Estimated buy-side volume over h1 (share of volume × buys) */
  recentBuyVolumeUsd: number | null;
  buysH1: number | null;
  sellsH1: number | null;
  txnsH1: number | null;
  priceChangeH1Pct: number | null;
  priceChange24hPct: number | null;
  priceUsd: number | null;
  /** DexScreener pairCreatedAt (ms) when known — for token age */
  pairCreatedAtMs: number | null;
  /** Circulating / total supply (UI amount) */
  supplyUi: number | null;
  holderCountEstimate: number | null;
  /** Largest holder % of supply */
  topHolderPct: number | null;
  /** Sum of top-10 holders % */
  top10HoldPct: number | null;
  /** Mint authority pubkey if set */
  mintAuthority: string | null;
  /** Freeze authority pubkey if set */
  freezeAuthority: string | null;
  /** Best-effort "dev" = mint auth → freeze → largest holder */
  devWallet: string | null;
  /** Dev / authority share of supply if they hold tokens */
  devHoldPct: number | null;
  /** Recent signatures from dev wallet (count) */
  devRecentTxCount: number | null;
  /** True if dev traded in lookback window */
  devActiveRecently: boolean;
  topHolders: HolderBucket[];
  source: 'dexscreener+rpc' | 'rpc' | 'cache' | 'partial';
  fetchedAt: number;
  error?: string;
}

export interface TokenMetricsFilterResult {
  ok: boolean;
  reasons: string[];
  metrics: TokenMetrics;
}

interface CacheEntry {
  data: TokenMetrics;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<TokenMetrics>>();
/** Dex/Jupiter/GMGN-only results for UI panels — never used as full-metrics cache. */
const lightCache = new Map<string, CacheEntry>();
const lightInflight = new Map<string, Promise<TokenMetrics>>();

const DEFAULT_TTL_MS = 90_000;
const LIGHT_TTL_MS = 60_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function cacheTtlMs(): number {
  return config.tokenMetrics?.cacheTtlMs ?? DEFAULT_TTL_MS;
}

function isValidMint(m: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m);
}

function emptyMetrics(mint: string, error?: string): TokenMetrics {
  return {
    mint,
    liquidityUsd: null,
    marketCapUsd: null,
    volume24hUsd: null,
    volumeH1Usd: null,
    volumeM5Usd: null,
    recentBuyVolumeUsd: null,
    buysH1: null,
    sellsH1: null,
    txnsH1: null,
    priceChangeH1Pct: null,
    priceChange24hPct: null,
    priceUsd: null,
    pairCreatedAtMs: null,
    supplyUi: null,
    holderCountEstimate: null,
    topHolderPct: null,
    top10HoldPct: null,
    mintAuthority: null,
    freezeAuthority: null,
    devWallet: null,
    devHoldPct: null,
    devRecentTxCount: null,
    devActiveRecently: false,
    topHolders: [],
    source: 'partial',
    fetchedAt: Date.now(),
    error,
  };
}

/** Public cache peek (no network). Optionally return stale expired entries. */
export function getCachedTokenMetrics(
  mint: string,
  opts?: { allowStale?: boolean }
): TokenMetrics | null {
  const hit = cache.get(mint);
  if (!hit) return null;
  const expired = hit.expiresAt < Date.now();
  if (expired) {
    // Keep entry for allowStale / Dex-429 fallback — do not delete here
    if (!opts?.allowStale) return null;
    if (hit.data?.error) return null;
    return { ...hit.data, source: 'cache' };
  }
  return { ...hit.data, source: 'cache' };
}

/**
 * Resolve Jupiter-style top-10 hold % for entry gates.
 * Prefer Jupiter Terminal audit.topHoldersPercentage (matches UI Top 10 H.),
 * then caller-provided, metrics cache, then on-chain (curve/LP excluded).
 */
export async function resolveTop10HoldPctForEntry(
  mint: string,
  provided?: number | null
): Promise<number | null> {
  // Jupiter audit is authoritative vs Terminal — prefer over inflated on-chain.
  try {
    const jup =
      lookupCachedJupiterToken(mint) ?? (await fetchJupiterTokenByMint(mint));
    const jupTop = jupiterTopHoldersPercentage(jup);
    if (jupTop != null) {
      // Keep metrics cache aligned so monitor/anti-rug see the same value
      const cached = cache.get(mint);
      if (cached) {
        cached.data.top10HoldPct = jupTop;
      }
      return jupTop;
    }
  } catch {
    /* fall through */
  }

  if (provided != null && Number.isFinite(provided)) return provided;
  const cached = getCachedTokenMetrics(mint);
  if (cached?.top10HoldPct != null && Number.isFinite(cached.top10HoldPct)) {
    return cached.top10HoldPct;
  }
  try {
    const onchain = await fetchOnChainHolderMetrics(mint);
    if (
      onchain.top10HoldPct != null &&
      Number.isFinite(onchain.top10HoldPct)
    ) {
      return onchain.top10HoldPct;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function clearTokenMetricsCache(mint?: string): void {
  if (mint) {
    cache.delete(mint);
    lightCache.delete(mint);
  } else {
    cache.clear();
    lightCache.clear();
  }
}

function applyJupiterEnrichment(
  merged: TokenMetrics,
  jup: Awaited<ReturnType<typeof fetchJupiterTokenByMint>>
): void {
  if (!jup) return;
  const jupTop = jupiterTopHoldersPercentage(jup);
  if (jupTop != null) {
    merged.top10HoldPct = jupTop;
  }
  const jupMc = Number(jup.mcap ?? 0);
  if (
    (merged.marketCapUsd == null || !(merged.marketCapUsd > 0)) &&
    Number.isFinite(jupMc) &&
    jupMc > 0
  ) {
    merged.marketCapUsd = jupMc;
  }
  const jupHolders = Number(jup.holderCount ?? NaN);
  if (
    (merged.holderCountEstimate == null || !(merged.holderCountEstimate > 0)) &&
    Number.isFinite(jupHolders) &&
    jupHolders > 0
  ) {
    merged.holderCountEstimate = jupHolders;
  }
}

/**
 * Fast MC / holders path for dashboard panels (no largest-account RPC walk).
 * Reuses full cache when present; otherwise Dex + Jupiter + optional GMGN.
 */
async function fetchTokenMetricsLight(mint: string): Promise<TokenMetrics> {
  const pending = lightInflight.get(mint);
  if (pending) return pending;

  const job = (async () => {
    const base = emptyMetrics(mint);
    try {
      const cachedJup = lookupCachedJupiterToken(mint);
      const [dex, jup] = await Promise.all([
        fetchDexMetrics(mint),
        cachedJup
          ? Promise.resolve(cachedJup)
          : fetchJupiterTokenByMint(mint).catch(() => null),
      ]);
      const stale = getCachedTokenMetrics(mint, { allowStale: true });
      const dexEmpty =
        dex.marketCapUsd == null &&
        dex.liquidityUsd == null &&
        dex.volume24hUsd == null;

      const merged: TokenMetrics = {
        ...base,
        symbol: dex.symbol ?? jup?.symbol ?? stale?.symbol,
        name: dex.name ?? jup?.name ?? stale?.name,
        liquidityUsd:
          dex.liquidityUsd ??
          (Number(jup?.liquidity) > 0 ? Number(jup?.liquidity) : null) ??
          (dexEmpty ? stale?.liquidityUsd ?? null : null),
        marketCapUsd:
          dex.marketCapUsd ??
          (stale?.marketCapUsd != null && stale.marketCapUsd > 0
            ? stale.marketCapUsd
            : null),
        volume24hUsd:
          dex.volume24hUsd ??
          (dexEmpty ? stale?.volume24hUsd ?? null : null),
        volumeH1Usd:
          dex.volumeH1Usd ?? (dexEmpty ? stale?.volumeH1Usd ?? null : null),
        volumeM5Usd:
          dex.volumeM5Usd ?? (dexEmpty ? stale?.volumeM5Usd ?? null : null),
        recentBuyVolumeUsd:
          dex.recentBuyVolumeUsd ??
          (dexEmpty ? stale?.recentBuyVolumeUsd ?? null : null),
        buysH1: dex.buysH1 ?? (dexEmpty ? stale?.buysH1 ?? null : null),
        sellsH1: dex.sellsH1 ?? (dexEmpty ? stale?.sellsH1 ?? null : null),
        txnsH1: dex.txnsH1 ?? (dexEmpty ? stale?.txnsH1 ?? null : null),
        priceChangeH1Pct:
          dex.priceChangeH1Pct ??
          (dexEmpty ? stale?.priceChangeH1Pct ?? null : null),
        priceChange24hPct:
          dex.priceChange24hPct ??
          (dexEmpty ? stale?.priceChange24hPct ?? null : null),
        priceUsd:
          dex.priceUsd ?? (dexEmpty ? stale?.priceUsd ?? null : null),
        pairCreatedAtMs:
          dex.pairCreatedAtMs ??
          (dexEmpty ? stale?.pairCreatedAtMs ?? null : null),
        holderCountEstimate: stale?.holderCountEstimate ?? null,
        source: 'partial',
        fetchedAt: Date.now(),
      };
      applyJupiterEnrichment(merged, jup);

      if (config.gmgn?.apiKey || process.env.GMGN_API_KEY) {
        const gmgn = await fetchGmgnTokenHints(mint).catch(() => null);
        if (gmgn?.holderCount != null) {
          merged.holderCountEstimate = gmgn.holderCount;
        }
        if (gmgn?.liquidityUsd != null && (merged.liquidityUsd ?? 0) <= 0) {
          merged.liquidityUsd = gmgn.liquidityUsd;
        }
      }

      lightCache.set(mint, {
        data: merged,
        expiresAt: Date.now() + LIGHT_TTL_MS,
      });
      return merged;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const fail = emptyMetrics(mint, message);
      lightCache.set(mint, {
        data: fail,
        expiresAt: Date.now() + Math.min(LIGHT_TTL_MS, 20_000),
      });
      return fail;
    } finally {
      lightInflight.delete(mint);
    }
  })();

  lightInflight.set(mint, job);
  return job;
}

/**
 * Fetch liquidity, holders, and dev/authority activity for a mint.
 * Results are cached to respect RPC / DexScreener rate limits.
 * Pass `{ light: true }` for dashboard panels (skip slow on-chain holder walk).
 */
export async function fetchTokenMetrics(
  mint: string,
  options: { force?: boolean; light?: boolean } = {}
): Promise<TokenMetrics> {
  if (!isValidMint(mint)) {
    return emptyMetrics(mint, 'Invalid mint');
  }

  if (!options.force) {
    const cached = getCachedTokenMetrics(mint);
    if (cached) return cached;

    if (options.light) {
      const lc = lightCache.get(mint);
      if (lc && lc.expiresAt > Date.now()) return lc.data;
      return fetchTokenMetricsLight(mint);
    }

    const pending = inflight.get(mint);
    if (pending) return pending;
  } else if (options.light) {
    return fetchTokenMetricsLight(mint);
  }

  const job = (async () => {
    const base = emptyMetrics(mint);
    try {
      const [dex, onchain] = await Promise.all([
        fetchDexMetrics(mint),
        fetchOnChainHolderMetrics(mint),
      ]);

      // Dex 429 / empty: keep last good metrics rather than wiping MC/liq
      const stale = getCachedTokenMetrics(mint, { allowStale: true });
      const dexEmpty =
        dex.marketCapUsd == null &&
        dex.liquidityUsd == null &&
        dex.volume24hUsd == null;

      const merged: TokenMetrics = {
        ...base,
        ...onchain,
        symbol: dex.symbol ?? onchain.symbol ?? stale?.symbol,
        name: dex.name ?? onchain.name ?? stale?.name,
        liquidityUsd:
          dex.liquidityUsd ??
          onchain.liquidityUsd ??
          (dexEmpty ? stale?.liquidityUsd ?? null : null),
        marketCapUsd:
          dex.marketCapUsd ??
          (stale?.marketCapUsd != null && stale.marketCapUsd > 0
            ? stale.marketCapUsd
            : null),
        volume24hUsd:
          dex.volume24hUsd ??
          (dexEmpty ? stale?.volume24hUsd ?? null : null),
        volumeH1Usd:
          dex.volumeH1Usd ?? (dexEmpty ? stale?.volumeH1Usd ?? null : null),
        volumeM5Usd:
          dex.volumeM5Usd ?? (dexEmpty ? stale?.volumeM5Usd ?? null : null),
        recentBuyVolumeUsd:
          dex.recentBuyVolumeUsd ??
          (dexEmpty ? stale?.recentBuyVolumeUsd ?? null : null),
        buysH1: dex.buysH1 ?? (dexEmpty ? stale?.buysH1 ?? null : null),
        sellsH1: dex.sellsH1 ?? (dexEmpty ? stale?.sellsH1 ?? null : null),
        txnsH1: dex.txnsH1 ?? (dexEmpty ? stale?.txnsH1 ?? null : null),
        priceChangeH1Pct:
          dex.priceChangeH1Pct ??
          (dexEmpty ? stale?.priceChangeH1Pct ?? null : null),
        priceChange24hPct:
          dex.priceChange24hPct ??
          (dexEmpty ? stale?.priceChange24hPct ?? null : null),
        priceUsd:
          dex.priceUsd ?? (dexEmpty ? stale?.priceUsd ?? null : null),
        pairCreatedAtMs:
          dex.pairCreatedAtMs ??
          (dexEmpty ? stale?.pairCreatedAtMs ?? null : null),
        source: dexEmpty && stale ? 'cache' : 'dexscreener+rpc',
        fetchedAt: Date.now(),
      };

      // Optional GMGN enrichment
      if (config.gmgn?.apiKey || process.env.GMGN_API_KEY) {
        const gmgn = await fetchGmgnTokenHints(mint).catch(() => null);
        if (gmgn) {
          if (gmgn.holderCount != null) {
            merged.holderCountEstimate = gmgn.holderCount;
          }
          if (gmgn.liquidityUsd != null && (merged.liquidityUsd ?? 0) <= 0) {
            merged.liquidityUsd = gmgn.liquidityUsd;
          }
        }
      }

      // Prefer Jupiter Terminal Top-10 / mcap / holderCount when Dex/RPC omit
      try {
        const jup =
          lookupCachedJupiterToken(mint) ??
          (await fetchJupiterTokenByMint(mint));
        applyJupiterEnrichment(merged, jup);
      } catch {
        /* keep on-chain top10 */
      }

      // Dev recent activity
      if (merged.devWallet) {
        const activity = await fetchDevActivity(merged.devWallet);
        merged.devRecentTxCount = activity.count;
        merged.devActiveRecently = activity.active;
      }

      cache.set(mint, {
        data: merged,
        // Longer TTL when we had to reuse stale Dex fields (429 soft path)
        expiresAt:
          Date.now() +
          (dexEmpty && stale ? Math.max(cacheTtlMs(), 180_000) : cacheTtlMs()),
      });
      return merged;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const fail = emptyMetrics(mint, message);
      // Short negative cache
      cache.set(mint, {
        data: fail,
        expiresAt: Date.now() + Math.min(cacheTtlMs(), 30_000),
      });
      return fail;
    } finally {
      inflight.delete(mint);
    }
  })();

  inflight.set(mint, job);
  return job;
}

async function fetchDexMetrics(mint: string): Promise<Partial<TokenMetrics>> {
  try {
    const res = await loggedFetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      {
        context: 'DexScreener',
        label: 'token metrics',
        timeoutMs: 8_000,
        headers: { Accept: 'application/json' },
      }
    );
    if (!res.ok) {
      logger.warn('DexScreener', 'token metrics HTTP', {
        mint: mint.slice(0, 12),
        status: res.status,
      });
      // On rate-limit, prefer stale cache over empty (caller merges)
      if (res.status === 429) {
        const stale = getCachedTokenMetrics(mint, { allowStale: true });
        if (stale) {
          return {
            symbol: stale.symbol,
            name: stale.name,
            liquidityUsd: stale.liquidityUsd,
            marketCapUsd: stale.marketCapUsd,
            volume24hUsd: stale.volume24hUsd,
            volumeH1Usd: stale.volumeH1Usd,
            volumeM5Usd: stale.volumeM5Usd,
            recentBuyVolumeUsd: stale.recentBuyVolumeUsd,
            buysH1: stale.buysH1,
            sellsH1: stale.sellsH1,
            txnsH1: stale.txnsH1,
            priceChangeH1Pct: stale.priceChangeH1Pct,
            priceChange24hPct: stale.priceChange24hPct,
            priceUsd: stale.priceUsd,
            pairCreatedAtMs: stale.pairCreatedAtMs ?? null,
          };
        }
      }
      return {};
    }
    const data = (await res.json()) as {
      pairs?: Array<{
        chainId?: string;
        pairAddress?: string;
        liquidity?: { usd?: number };
        marketCap?: number;
        fdv?: number;
        volume?: { m5?: number; h1?: number; h24?: number };
        txns?: {
          m5?: { buys?: number; sells?: number };
          h1?: { buys?: number; sells?: number };
        };
        priceChange?: { m5?: number; h1?: number; h24?: number };
        priceUsd?: string;
        pairCreatedAt?: number;
        baseToken?: { symbol?: string; name?: string };
      }>;
    };
    const pairs = (data.pairs ?? []).filter((p) => p.chainId === 'solana');
    if (pairs.length === 0) return {};

    let best = pairs[0];
    let bestLiq = Number(best.liquidity?.usd ?? 0);
    for (const p of pairs) {
      const liq = Number(p.liquidity?.usd ?? 0);
      if (liq > bestLiq) {
        best = p;
        bestLiq = liq;
      }
    }

    const volumeH1Usd = Number(best.volume?.h1 ?? NaN);
    const volumeM5Usd = Number(best.volume?.m5 ?? NaN);
    const volume24hUsd = Number(best.volume?.h24 ?? NaN);
    const buysH1 = Number(best.txns?.h1?.buys ?? NaN);
    const sellsH1 = Number(best.txns?.h1?.sells ?? NaN);
    const buys = Number.isFinite(buysH1) ? buysH1 : 0;
    const sells = Number.isFinite(sellsH1) ? sellsH1 : 0;
    const txnsH1 = buys + sells;
    const h1Vol = Number.isFinite(volumeH1Usd) ? volumeH1Usd : null;
    let recentBuyVolumeUsd: number | null = null;
    if (h1Vol != null) {
      recentBuyVolumeUsd =
        txnsH1 > 0 ? h1Vol * (buys / txnsH1) : h1Vol > 0 ? h1Vol * 0.5 : 0;
    }
    const mcRaw = Number(best.marketCap ?? NaN);
    const fdvRaw = Number(best.fdv ?? NaN);
    let marketCapUsd: number | null = null;
    if (Number.isFinite(mcRaw) && mcRaw > 0) {
      // Dex often mirrors FDV into marketCap when circulating is unknown
      if (
        Number.isFinite(fdvRaw) &&
        fdvRaw > 0 &&
        mcRaw / fdvRaw >= 0.95 &&
        mcRaw / fdvRaw <= 1.05
      ) {
        marketCapUsd = null;
      } else {
        marketCapUsd = mcRaw;
      }
    }
    // Never fall back to FDV as circulating MC

    return {
      symbol: best.baseToken?.symbol,
      name: best.baseToken?.name,
      liquidityUsd: bestLiq > 0 ? bestLiq : null,
      marketCapUsd,
      volume24hUsd: Number.isFinite(volume24hUsd) && volume24hUsd > 0 ? volume24hUsd : null,
      volumeH1Usd: h1Vol,
      volumeM5Usd: Number.isFinite(volumeM5Usd) ? volumeM5Usd : null,
      recentBuyVolumeUsd,
      buysH1: Number.isFinite(buysH1) ? buysH1 : null,
      sellsH1: Number.isFinite(sellsH1) ? sellsH1 : null,
      txnsH1: txnsH1 > 0 || Number.isFinite(buysH1) ? txnsH1 : null,
      priceChangeH1Pct: Number.isFinite(Number(best.priceChange?.h1))
        ? Number(best.priceChange?.h1)
        : null,
      priceChange24hPct: Number.isFinite(Number(best.priceChange?.h24))
        ? Number(best.priceChange?.h24)
        : null,
      priceUsd: Number(best.priceUsd ?? 0) || null,
      pairCreatedAtMs: (() => {
        const t = Number(best.pairCreatedAt);
        return Number.isFinite(t) && t > 1_000_000_000_000 ? t : null;
      })(),
    };
  } catch (err) {
    logger.error('DexScreener', 'token metrics failed', {
      mint: mint.slice(0, 12),
      ...errorToMeta(err),
    });
    return {};
  }
}

/**
 * Jupiter-style Top-10 excludes bonding-curve + AMM/pool vaults.
 * Collect pool / vault owner addresses to skip when summing retail top-10.
 */
async function resolvePoolVaultExcludeOwners(
  mint: string
): Promise<Set<string>> {
  const exclude = new Set<string>();
  try {
    exclude.add(getBondingCurvePda(mint).toBase58());
  } catch {
    /* ignore */
  }

  try {
    const jup =
      lookupCachedJupiterToken(mint) ?? (await fetchJupiterTokenByMint(mint));
    const graduated = String(jup?.graduatedPool || '').trim();
    if (graduated) exclude.add(graduated);
    const firstPool = String(jup?.firstPool?.id || '').trim();
    // firstPool.id is sometimes the mint itself on Pump — only add if distinct
    if (firstPool && firstPool !== mint) exclude.add(firstPool);
  } catch {
    /* ignore */
  }

  try {
    const res = await loggedFetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      {
        context: 'DexScreener',
        label: 'pool vaults',
        timeoutMs: 6_000,
        headers: { Accept: 'application/json' },
      }
    );
    if (res.ok) {
      const data = (await res.json()) as {
        pairs?: Array<{ chainId?: string; pairAddress?: string }>;
      };
      for (const p of data.pairs ?? []) {
        if (p.chainId !== 'solana') continue;
        const addr = String(p.pairAddress || '').trim();
        if (addr) exclude.add(addr);
      }
    }
  } catch {
    /* ignore */
  }

  return exclude;
}

async function fetchOnChainHolderMetrics(
  mint: string
): Promise<Partial<TokenMetrics>> {
  // Share load: keep heavy holder RPCs off Utility (Favourites soft-watch).
  // Public utility was timing out ~15s on getTokenLargestAccounts.
  const role = getRpcRoleFor(
    'token_metrics',
    Boolean(config.rpc?.shareLoad)
  );
  return runWithRpcRole(role, () => fetchOnChainHolderMetricsInner(mint), 'token_metrics');
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

async function fetchOnChainHolderMetricsInner(
  mint: string
): Promise<Partial<TokenMetrics>> {
  const conn = getConnection();
  const mintKey = new PublicKey(mint);

  let supplyUi: number | null = null;
  let mintAuthority: string | null = null;
  let freezeAuthority: string | null = null;
  let decimals = 6;

  try {
    const supply = await withTimeout(
      conn.getTokenSupply(mintKey),
      4_000,
      'getTokenSupply'
    );
    decimals = supply.value.decimals;
    supplyUi = Number(supply.value.uiAmount ?? 0);
  } catch {
    // continue
  }

  try {
    const info = await withTimeout(
      conn.getParsedAccountInfo(mintKey),
      4_000,
      'getParsedAccountInfo'
    );
    const parsed = (info.value?.data as { parsed?: { info?: Record<string, unknown> } } | undefined)
      ?.parsed?.info;
    if (parsed) {
      const ma = parsed.mintAuthority as string | { address?: string } | null;
      const fa = parsed.freezeAuthority as string | { address?: string } | null;
      mintAuthority =
        typeof ma === 'string' ? ma : ma?.address ? String(ma.address) : null;
      freezeAuthority =
        typeof fa === 'string' ? fa : fa?.address ? String(fa.address) : null;
      if (typeof parsed.decimals === 'number') decimals = parsed.decimals;
    }
  } catch {
    // continue
  }

  const topHolders: HolderBucket[] = [];
  let topHolderPct: number | null = null;
  let top10HoldPct: number | null = null;

  // Jupiter-style top-10 excludes Pump bonding-curve vault + post-migration LP.
  const excludeOwners = await resolvePoolVaultExcludeOwners(mint);

  try {
    const largest = await withTimeout(
      conn.getTokenLargestAccounts(mintKey),
      3_000,
      'getTokenLargestAccounts'
    );
    const accounts = largest.value ?? [];
    const supply =
      supplyUi && supplyUi > 0
        ? supplyUi
        : accounts.reduce((s, a) => s + Number(a.uiAmount ?? 0), 0) || 1;

    // Resolve owners for top accounts (token account → owner). Pull up to 30 so
    // we still have 10 retail wallets after excluding curve / LP vaults.
    for (const acc of accounts.slice(0, 30)) {
      const amountUi = Number(acc.uiAmount ?? 0);
      const tokenAccount = acc.address.toBase58();
      let owner = tokenAccount;
      try {
        const tok = await withTimeout(
          conn.getParsedAccountInfo(acc.address),
          2_500,
          'getParsedAccountInfo(token)'
        );
        const info = (
          tok.value?.data as {
            parsed?: { info?: { owner?: string } };
          } | undefined
        )?.parsed?.info;
        if (info?.owner) owner = info.owner;
      } catch {
        // keep token account address
      }

      // Skip bonding-curve / AMM pool vaults (Jupiter Top-10 H. excludes these)
      if (excludeOwners.has(owner) || excludeOwners.has(tokenAccount)) {
        continue;
      }

      const pct = (amountUi / supply) * 100;
      const isAuthority =
        owner === mintAuthority || owner === freezeAuthority;
      topHolders.push({
        address: owner,
        amountUi,
        pctOfSupply: Math.round(pct * 100) / 100,
        isAuthority,
      });
      if (topHolders.length >= 10) break;
    }

    if (topHolders.length > 0) {
      topHolderPct = topHolders[0].pctOfSupply;
      top10HoldPct =
        Math.round(
          topHolders.reduce((s, h) => s + h.pctOfSupply, 0) * 100
        ) / 100;
    }

    if (supplyUi == null && supply > 0) supplyUi = supply;
  } catch (err) {
    console.warn(
      `[tokenMetrics] getTokenLargestAccounts failed for ${mint.slice(0, 8)}…:`,
      err instanceof Error ? err.message : err
    );
  }

  const authHold = topHolders.find((h) => h.isAuthority);
  const devWallet =
    mintAuthority || freezeAuthority || topHolders[0]?.address || null;
  let devHoldPct: number | null = authHold?.pctOfSupply ?? null;
  if (devHoldPct == null && devWallet) {
    const match = topHolders.find((h) => h.address === devWallet);
    if (match) devHoldPct = match.pctOfSupply;
  }

  void decimals;

  // Best-effort holder estimate from largest-accounts sample size when GMGN
  // hasn't provided a real count (null stays null — never invent a floor).
  const holderEstimate =
    topHolders.length >= 10 ? null : topHolders.length > 0 ? topHolders.length : null;

  return {
    supplyUi,
    mintAuthority,
    freezeAuthority,
    topHolders,
    topHolderPct,
    top10HoldPct,
    holderCountEstimate: holderEstimate,
    devWallet,
    devHoldPct,
    source: 'rpc',
  };
}

async function fetchDevActivity(
  address: string
): Promise<{ count: number; active: boolean }> {
  const lookbackMs = config.tokenMetrics?.devActivityLookbackMs ?? 2 * MS_PER_DAY;
  const role = getRpcRoleFor('token_metrics', Boolean(config.rpc?.shareLoad));
  return runWithRpcRole(
    role,
    async () => {
      try {
        const conn = getConnection();
        const sigs = await conn.getSignaturesForAddress(new PublicKey(address), {
          limit: 20,
        });
        const cutoff = Math.floor((Date.now() - lookbackMs) / 1000);
        const recent = sigs.filter(
          (s) => s.blockTime != null && s.blockTime >= cutoff && !s.err
        );
        return {
          count: recent.length,
          active: recent.length > 0,
        };
      } catch {
        return { count: 0, active: false };
      }
    },
    'token_metrics'
  );
}

async function fetchGmgnTokenHints(
  mint: string
): Promise<{ holderCount?: number; liquidityUsd?: number } | null> {
  try {
    const { isGmgnInCooldown, gmgnRequest } =
      require('./gmgn') as typeof import('./gmgn');
    if (isGmgnInCooldown()) return null;

    const res = await gmgnRequest(
      `/defi/quotation/v1/tokens/sol/${encodeURIComponent(mint)}`,
      6_000
    );
    if (!res.ok || !res.data) {
      if (res.status !== 404 && res.status !== 403 && res.status !== 401) {
        logger.warn('GMGN', 'token hints HTTP', {
          mint: mint.slice(0, 12),
          status: res.status,
        });
      }
      return null;
    }
    const json = res.data as { data?: Record<string, unknown> };
    const row = json.data ?? (json as Record<string, unknown>);
    return {
      holderCount: Number(row.holder_count ?? row.holders ?? 0) || undefined,
      liquidityUsd: Number(row.liquidity ?? row.liquidity_usd ?? 0) || undefined,
    };
  } catch (err) {
    logger.warn('GMGN', 'token hints failed', {
      mint: mint.slice(0, 12),
      ...errorToMeta(err),
    });
    return null;
  }
}

/**
 * Apply configured filters to metrics (liquidity, volume, holders, concentration).
 * Uses effective hard floors so High risk cannot undercut absolute mins.
 * Unknown MC is soft (Dex 429 / RPC gaps) — known MC below min still hard-rejects.
 * Min liq / min holders only hard-enforce when their strategy modules (or anti-rug) are ON.
 */
export function evaluateTokenMetricsFilters(
  metrics: TokenMetrics
): TokenMetricsFilterResult {
  // Risk OFF: no metrics floors — signal engines decide
  if (config.riskLevel === 'off') {
    return { ok: true, reasons: [], metrics };
  }

  const filters = config.filters;
  const reasons: string[] = [];
  const antiRugOn =
    isStrategyEnabled('anti_rug_honeypot') &&
    config.filters.enableAntiRug !== false;
  const enforceLiq =
    antiRugOn || isStrategyEnabled('volume_liquidity_filters');
  const enforceHolders =
    antiRugOn || isStrategyEnabled('min_holders_activity');

  const minLiq = effectiveMinLiquidityUsd();
  const liq = metrics.liquidityUsd;
  // Unknown liquidity must not fail-closed as $0
  if (enforceLiq && liq != null && liq < minLiq) {
    reasons.push(`liquidity $${liq.toFixed(0)} < min $${minLiq}`);
  }

  const minMc = effectiveMinMarketCapUsd();
  const mc = metrics.marketCapUsd;
  // Known-only: unknown MC soft-passes (Dex rate-limits must not zero all entries)
  if (minMc > 0 && mc != null && mc > 0 && mc < minMc) {
    reasons.push(`market cap $${Math.round(mc)} < min $${minMc}`);
  }

  const minVol = effectiveStrictMinVolume24hUsd();
  const vol = metrics.volume24hUsd;
  if (enforceLiq && minVol > 0 && vol != null && vol < minVol) {
    reasons.push(`volume24h $${vol.toFixed(0)} < min $${minVol}`);
  }

  const minHolders = effectiveMinHolders();
  if (
    enforceHolders &&
    minHolders > 0 &&
    metrics.holderCountEstimate != null &&
    metrics.holderCountEstimate < minHolders
  ) {
    reasons.push(
      `holders ${metrics.holderCountEstimate} < min ${minHolders}`
    );
  }

  const maxDev = filters.maxDevHoldPct ?? 0;
  const minDev = filters.minDevHoldPct ?? 0;
  if (metrics.devHoldPct != null) {
    if (maxDev > 0 && metrics.devHoldPct > maxDev) {
      reasons.push(
        `dev concentration ${metrics.devHoldPct.toFixed(1)}% > max ${maxDev}%`
      );
    } else if (minDev > 0 && metrics.devHoldPct < minDev) {
      reasons.push(
        `dev concentration ${metrics.devHoldPct.toFixed(1)}% < min ${minDev}%`
      );
    }
  }

  const maxTop = filters.maxTopHolderPct ?? 0;
  const minTop = filters.minTopHolderPct ?? 0;
  if (metrics.topHolderPct != null) {
    if (maxTop > 0 && metrics.topHolderPct > maxTop) {
      reasons.push(
        `top holder ${metrics.topHolderPct.toFixed(1)}% > max ${maxTop}%`
      );
    } else if (minTop > 0 && metrics.topHolderPct < minTop) {
      reasons.push(
        `top holder ${metrics.topHolderPct.toFixed(1)}% < min ${minTop}%`
      );
    }
  }

  const maxConc = effectiveMaxTop10HolderPct();
  if (maxConc > 0 && metrics.top10HoldPct != null) {
    if (metrics.top10HoldPct > maxConc) {
      reasons.push(
        `top10 concentration ${metrics.top10HoldPct.toFixed(0)}% > max ${maxConc}%`
      );
    }
  }

  const minTop10 = effectiveMinTop10HolderPct();
  // Enforce Top-10% band only when known — unknown must not fail-closed
  // (RPC gaps are common; hard floors still reject known out-of-band via
  // evaluateHolderConcentrationHardFloors).
  if (
    minTop10 > 0 &&
    metrics.top10HoldPct != null &&
    Number.isFinite(metrics.top10HoldPct)
  ) {
    if (metrics.top10HoldPct < minTop10) {
      reasons.push(
        `top10 concentration ${metrics.top10HoldPct.toFixed(1)}% < min ${minTop10}%`
      );
    }
  }

  if (filters.skipIfMintAuthority && metrics.mintAuthority) {
    reasons.push(`mint authority still set (${metrics.mintAuthority.slice(0, 8)}…)`);
  }

  return {
    ok: reasons.length === 0,
    reasons,
    metrics,
  };
}

/** Compact summary for dashboard / signals */
export function summarizeTokenMetrics(m: TokenMetrics): {
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  volumeH1Usd: number | null;
  volumeM5Usd: number | null;
  recentBuyVolumeUsd: number | null;
  txnsH1: number | null;
  buysH1: number | null;
  sellsH1: number | null;
  buySellRatio: number | null;
  priceUsd: number | null;
  priceChangeH1Pct: number | null;
  priceChange24hPct: number | null;
  holderCountEstimate: number | null;
  topHolderPct: number | null;
  top10HoldPct: number | null;
  devHoldPct: number | null;
  devActiveRecently: boolean;
  mintAuthority: string | null;
  source: string;
  /** ms epoch when known */
  pairCreatedAtMs?: number | null;
} {
  const buys = m.buysH1;
  const sells = m.sellsH1;
  const ratio =
    buys != null && sells != null && sells > 0
      ? buys / sells
      : buys != null && sells === 0 && buys > 0
        ? 99
        : null;
  return {
    liquidityUsd: m.liquidityUsd,
    marketCapUsd: m.marketCapUsd,
    volume24hUsd: m.volume24hUsd,
    volumeH1Usd: m.volumeH1Usd,
    volumeM5Usd: m.volumeM5Usd,
    recentBuyVolumeUsd: m.recentBuyVolumeUsd,
    txnsH1: m.txnsH1,
    buysH1: buys ?? null,
    sellsH1: sells ?? null,
    buySellRatio: ratio,
    priceUsd: m.priceUsd,
    priceChangeH1Pct: m.priceChangeH1Pct,
    priceChange24hPct: m.priceChange24hPct,
    holderCountEstimate: m.holderCountEstimate,
    topHolderPct: m.topHolderPct,
    top10HoldPct: m.top10HoldPct,
    devHoldPct: m.devHoldPct,
    devActiveRecently: m.devActiveRecently,
    mintAuthority: m.mintAuthority,
    source: m.source,
    pairCreatedAtMs: m.pairCreatedAtMs ?? null,
  };
}

export function getTokenMetricsCacheStats() {
  return {
    size: cache.size,
    ttlMs: cacheTtlMs(),
  };
}
