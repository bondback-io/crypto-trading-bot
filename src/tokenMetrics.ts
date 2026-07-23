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
  effectiveMinVolume24hUsd,
} from './config';
import { getBondingCurvePda } from './bondingCurve';
import { getConnection } from './connection';
import { logger, errorToMeta, loggedFetch } from './logger';

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
  /** Circulating / FDV market cap USD from DexScreener */
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

const DEFAULT_TTL_MS = 90_000;
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

/** Public cache peek (no network) */
export function getCachedTokenMetrics(mint: string): TokenMetrics | null {
  const hit = cache.get(mint);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(mint);
    return null;
  }
  return { ...hit.data, source: 'cache' };
}

/**
 * Resolve Jupiter-style top-10 hold % for entry gates.
 * Prefers a caller-provided value, then cache, then a best-effort on-chain fetch.
 */
export async function resolveTop10HoldPctForEntry(
  mint: string,
  provided?: number | null
): Promise<number | null> {
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
  if (mint) cache.delete(mint);
  else cache.clear();
}

/**
 * Fetch liquidity, holders, and dev/authority activity for a mint.
 * Results are cached to respect RPC / DexScreener rate limits.
 */
export async function fetchTokenMetrics(
  mint: string,
  options: { force?: boolean } = {}
): Promise<TokenMetrics> {
  if (!isValidMint(mint)) {
    return emptyMetrics(mint, 'Invalid mint');
  }

  if (!options.force) {
    const cached = getCachedTokenMetrics(mint);
    if (cached) return cached;

    const pending = inflight.get(mint);
    if (pending) return pending;
  }

  const job = (async () => {
    const base = emptyMetrics(mint);
    try {
      const [dex, onchain] = await Promise.all([
        fetchDexMetrics(mint),
        fetchOnChainHolderMetrics(mint),
      ]);

      const merged: TokenMetrics = {
        ...base,
        ...onchain,
        symbol: dex.symbol ?? onchain.symbol,
        name: dex.name ?? onchain.name,
        liquidityUsd: dex.liquidityUsd ?? onchain.liquidityUsd ?? null,
        marketCapUsd: dex.marketCapUsd ?? null,
        volume24hUsd: dex.volume24hUsd ?? null,
        volumeH1Usd: dex.volumeH1Usd ?? null,
        volumeM5Usd: dex.volumeM5Usd ?? null,
        recentBuyVolumeUsd: dex.recentBuyVolumeUsd ?? null,
        buysH1: dex.buysH1 ?? null,
        sellsH1: dex.sellsH1 ?? null,
        txnsH1: dex.txnsH1 ?? null,
        priceChangeH1Pct: dex.priceChangeH1Pct ?? null,
        priceChange24hPct: dex.priceChange24hPct ?? null,
        priceUsd: dex.priceUsd ?? null,
        source: 'dexscreener+rpc',
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

      // Dev recent activity
      if (merged.devWallet) {
        const activity = await fetchDevActivity(merged.devWallet);
        merged.devRecentTxCount = activity.count;
        merged.devActiveRecently = activity.active;
      }

      cache.set(mint, {
        data: merged,
        expiresAt: Date.now() + cacheTtlMs(),
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
      return {};
    }
    const data = (await res.json()) as {
      pairs?: Array<{
        chainId?: string;
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
    const marketCapUsd =
      Number.isFinite(mcRaw) && mcRaw > 0
        ? mcRaw
        : Number.isFinite(fdvRaw) && fdvRaw > 0
          ? fdvRaw
          : null;

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
    };
  } catch (err) {
    logger.error('DexScreener', 'token metrics failed', {
      mint: mint.slice(0, 12),
      ...errorToMeta(err),
    });
    return {};
  }
}

async function fetchOnChainHolderMetrics(
  mint: string
): Promise<Partial<TokenMetrics>> {
  const conn = getConnection();
  const mintKey = new PublicKey(mint);

  let supplyUi: number | null = null;
  let mintAuthority: string | null = null;
  let freezeAuthority: string | null = null;
  let decimals = 6;

  try {
    const supply = await conn.getTokenSupply(mintKey);
    decimals = supply.value.decimals;
    supplyUi = Number(supply.value.uiAmount ?? 0);
  } catch {
    // continue
  }

  try {
    const info = await conn.getParsedAccountInfo(mintKey);
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

  // Jupiter-style top-10 excludes the Pump bonding-curve vault. Including it
  // inflates concentration (~80–99%) and makes minTop10HolderPct meaningless.
  let curveOwner: string | null = null;
  try {
    curveOwner = getBondingCurvePda(mint).toBase58();
  } catch {
    curveOwner = null;
  }

  try {
    const largest = await conn.getTokenLargestAccounts(mintKey);
    const accounts = largest.value ?? [];
    const supply =
      supplyUi && supplyUi > 0
        ? supplyUi
        : accounts.reduce((s, a) => s + Number(a.uiAmount ?? 0), 0) || 1;

    // Resolve owners for top accounts (token account → owner). Pull up to 20 so
    // we still have 10 retail wallets after excluding the bonding-curve vault.
    for (const acc of accounts.slice(0, 20)) {
      const amountUi = Number(acc.uiAmount ?? 0);
      let owner = acc.address.toBase58();
      try {
        const tok = await conn.getParsedAccountInfo(acc.address);
        const info = (
          tok.value?.data as {
            parsed?: { info?: { owner?: string } };
          } | undefined
        )?.parsed?.info;
        if (info?.owner) owner = info.owner;
      } catch {
        // keep token account address
      }

      // Skip bonding-curve vault (Jupiter Top-10 H. excludes pool/curve)
      if (curveOwner && owner === curveOwner) continue;

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
}

async function fetchGmgnTokenHints(
  mint: string
): Promise<{ holderCount?: number; liquidityUsd?: number } | null> {
  const base = (config.gmgn?.baseUrl || 'https://gmgn.ai').replace(/\/$/, '');
  const key = config.gmgn?.apiKey || process.env.GMGN_API_KEY || '';
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (key) headers['Authorization'] = `Bearer ${key}`;

  try {
    const res = await loggedFetch(`${base}/defi/quotation/v1/tokens/sol/${mint}`, {
      context: 'GMGN',
      label: 'token hints',
      timeoutMs: 6_000,
      headers,
    });
    if (!res.ok) {
      logger.warn('GMGN', 'token hints HTTP', {
        mint: mint.slice(0, 12),
        status: res.status,
      });
      return null;
    }
    const json = (await res.json()) as {
      data?: Record<string, unknown>;
    };
    const row = json.data ?? {};
    return {
      holderCount: Number(row.holder_count ?? row.holders ?? 0) || undefined,
      liquidityUsd: Number(row.liquidity ?? row.liquidity_usd ?? 0) || undefined,
    };
  } catch (err) {
    logger.error('GMGN', 'token hints failed', {
      mint: mint.slice(0, 12),
      ...errorToMeta(err),
    });
    return null;
  }
}

/**
 * Apply configured filters to metrics (liquidity, volume, holders, concentration).
 * Uses effective hard floors so High risk cannot undercut absolute mins.
 */
export function evaluateTokenMetricsFilters(
  metrics: TokenMetrics
): TokenMetricsFilterResult {
  const filters = config.filters;
  const reasons: string[] = [];

  const minLiq = effectiveMinLiquidityUsd();
  const liq = metrics.liquidityUsd;
  // Unknown liquidity must not fail-closed as $0
  if (liq != null && liq < minLiq) {
    reasons.push(`liquidity $${liq.toFixed(0)} < min $${minLiq}`);
  }

  const minMc = effectiveMinMarketCapUsd();
  const mc = metrics.marketCapUsd;
  if (mc != null && mc > 0) {
    if (mc < minMc) {
      reasons.push(
        `market cap $${Math.round(mc)} < min $${minMc}`
      );
    }
  } else {
    reasons.push(`market cap unknown (min $${minMc})`);
  }

  const minVol = effectiveMinVolume24hUsd();
  const vol = metrics.volume24hUsd;
  if (vol != null && vol < minVol) {
    reasons.push(`volume24h $${vol.toFixed(0)} < min $${minVol}`);
  }

  const minHolders = effectiveMinHolders();
  if (
    metrics.holderCountEstimate != null &&
    metrics.holderCountEstimate < minHolders
  ) {
    reasons.push(
      `holders ${metrics.holderCountEstimate} < min ${minHolders}`
    );
  }

  const maxDev = filters.maxDevHoldPct ?? 0;
  if (maxDev > 0 && metrics.devHoldPct != null) {
    if (metrics.devHoldPct > maxDev) {
      reasons.push(
        `dev concentration ${metrics.devHoldPct.toFixed(1)}% > max ${maxDev}%`
      );
    }
  }

  const maxTop = filters.maxTopHolderPct ?? 0;
  if (maxTop > 0 && metrics.topHolderPct != null) {
    if (metrics.topHolderPct > maxTop) {
      reasons.push(
        `top holder ${metrics.topHolderPct.toFixed(1)}% > max ${maxTop}%`
      );
    }
  }

  const maxConc = filters.maxHolderConcentration ?? 0;
  if (maxConc > 0 && metrics.top10HoldPct != null) {
    if (metrics.top10HoldPct > maxConc) {
      reasons.push(
        `top10 concentration ${metrics.top10HoldPct.toFixed(0)}% > max ${maxConc}%`
      );
    }
  }

  const minTop10 = effectiveMinTop10HolderPct();
  if (metrics.top10HoldPct != null && Number.isFinite(metrics.top10HoldPct)) {
    if (metrics.top10HoldPct < minTop10) {
      reasons.push(
        `top10 concentration ${metrics.top10HoldPct.toFixed(1)}% < min ${minTop10}%`
      );
    }
  } else {
    reasons.push(`top 10 holders unknown (min ${minTop10}%)`);
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
  priceChangeH1Pct: number | null;
  priceChange24hPct: number | null;
  holderCountEstimate: number | null;
  topHolderPct: number | null;
  top10HoldPct: number | null;
  devHoldPct: number | null;
  devActiveRecently: boolean;
  mintAuthority: string | null;
  source: string;
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
    priceChangeH1Pct: m.priceChangeH1Pct,
    priceChange24hPct: m.priceChange24hPct,
    holderCountEstimate: m.holderCountEstimate,
    topHolderPct: m.topHolderPct,
    top10HoldPct: m.top10HoldPct,
    devHoldPct: m.devHoldPct,
    devActiveRecently: m.devActiveRecently,
    mintAuthority: m.mintAuthority,
    source: m.source,
  };
}

export function getTokenMetricsCacheStats() {
  return {
    size: cache.size,
    ttlMs: cacheTtlMs(),
  };
}
