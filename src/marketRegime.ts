/**
 * Light market regime from SOL trend / vol (DexScreener).
 * Used by Market Scanner to raise bars in risk_off and gate momentum.
 */

import {
  fetchSolUsdPrice,
  getCachedSolUsdPrice,
} from './marketData';
import { config } from './config';
import { logger, errorToMeta, loggedFetch } from './logger';

export type MarketRegime = 'risk_on' | 'neutral' | 'risk_off';

export interface MarketRegimeSnapshot {
  regime: MarketRegime;
  solChangeH1: number;
  solChangeH24: number;
  /** Token vs SOL relative-strength hint when provided */
  rsHint?: 'strong' | 'weak' | 'neutral';
  fetchedAt: number;
}

const CACHE_TTL_MS = 3 * 60_000;
let cached: MarketRegimeSnapshot | null = null;

async function fetchSolChanges(): Promise<{
  h1: number;
  h24: number;
}> {
  await fetchSolUsdPrice();
  const res = await loggedFetch(
    'https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112',
    {
      context: 'MarketRegime',
      label: 'sol-pairs',
      timeoutMs: 10_000,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'solana-smart-copy-bot/1.0',
      },
    }
  );
  if (!res.ok) return { h1: 0, h24: 0 };
  const data = (await res.json()) as { pairs?: Record<string, unknown>[] };
  const pairs = data.pairs ?? [];
  const usdc = pairs.find((p) => {
    const q = String(
      (p.quoteToken as { symbol?: string } | undefined)?.symbol ?? ''
    ).toUpperCase();
    return q === 'USDC' || q === 'USDT';
  });
  const best = usdc ?? pairs[0];
  const pc = (best?.priceChange ?? {}) as { h1?: number; h24?: number };
  return {
    h1: Number(pc.h1) || 0,
    h24: Number(pc.h24) || 0,
  };
}

function classifyRegime(h1: number, h24: number): MarketRegime {
  // Soft vol proxy: large absolute 1h moves = choppy / risk-off lean
  const wildH1 = Math.abs(h1) >= 4.5;
  if (h1 <= -2.5 || h24 <= -6 || (h24 <= -3 && h1 < 0) || (wildH1 && h1 < 0)) {
    return 'risk_off';
  }
  if (h1 >= 1.5 && h24 >= 0.5) return 'risk_on';
  if (h24 >= 3 && h1 >= 0) return 'risk_on';
  return 'neutral';
}

/**
 * Cached SOL regime (~2–5 min).
 */
export async function getMarketRegime(opts?: {
  force?: boolean;
  tokenChangeH1Pct?: number | null;
}): Promise<MarketRegimeSnapshot> {
  if (!opts?.force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return withRs(cached, opts?.tokenChangeH1Pct);
  }
  try {
    const { h1, h24 } = await fetchSolChanges();
    cached = {
      regime: classifyRegime(h1, h24),
      solChangeH1: h1,
      solChangeH24: h24,
      fetchedAt: Date.now(),
    };
  } catch (err) {
    logger.warn('MarketRegime', 'fetch failed', errorToMeta(err));
    if (!cached) {
      cached = {
        regime: 'neutral',
        solChangeH1: 0,
        solChangeH24: 0,
        fetchedAt: Date.now(),
      };
    }
  }
  void getCachedSolUsdPrice();
  return withRs(cached!, opts?.tokenChangeH1Pct);
}

function withRs(
  snap: MarketRegimeSnapshot,
  tokenChangeH1Pct?: number | null
): MarketRegimeSnapshot {
  if (tokenChangeH1Pct == null || !Number.isFinite(tokenChangeH1Pct)) {
    return { ...snap, rsHint: undefined };
  }
  const rel = tokenChangeH1Pct - snap.solChangeH1;
  let rsHint: MarketRegimeSnapshot['rsHint'] = 'neutral';
  if (rel >= 3) rsHint = 'strong';
  else if (rel <= -3) rsHint = 'weak';
  return { ...snap, rsHint };
}

/** Sync last-known regime (neutral if never fetched). */
export function getCachedMarketRegime(): MarketRegimeSnapshot {
  return (
    cached ?? {
      regime: 'neutral',
      solChangeH1: 0,
      solChangeH24: 0,
      fetchedAt: 0,
    }
  );
}

/**
 * Scanner-only entries may be paused in risk_off when configured.
 * Hybrid still allowed (caller checks hybrid separately).
 */
export function shouldAllowScannerOnly(): boolean {
  const pause =
    config.marketScanner?.pauseScannerOnlyInRiskOff !== false;
  if (!pause) return true;
  const regime = getCachedMarketRegime().regime;
  return regime !== 'risk_off';
}

/** Effective min rank under current regime. */
export function effectiveMinRankScore(base: number): number {
  const regime = getCachedMarketRegime().regime;
  if (regime === 'risk_off') return Math.min(100, base + 10);
  return base;
}

/** Higher confluence floor for scanner-only in risk_off. */
export function effectiveMinConfluence(base: number): number {
  const regime = getCachedMarketRegime().regime;
  if (regime === 'risk_off') return Math.min(100, base + 10);
  return base;
}

export function isMomentumPlaybookDisabled(): boolean {
  return getCachedMarketRegime().regime === 'risk_off';
}
