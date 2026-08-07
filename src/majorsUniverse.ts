/**
 * High-MC majors discovery — Jupiter toptraded / toporganicscore without pump filter.
 * Circulating MC only (≥$100M). Feeds Dip support-dip watch; never Scalper Mode B.
 * Additive: launch/pump scanner for Scalper-family stays unchanged.
 */

import { config } from './config';
import { readJupiterMarketCapUsd } from './marketData';
import {
  fetchJupiterTopTokens,
  hasJupiterApiKey,
  jupiterTokenToLaunchEvent,
  type JupiterTokenInfo,
} from './jupiterTokens';
import { isStrategyEnabledGlobal } from './strategies';
import { isSmartBotProfilesEnabled } from './tradeProfiles';

export type MajorsMcBand = '100m' | '250m' | '500m' | '1b+';

export interface MajorsCandidate {
  mint: string;
  symbol: string;
  name: string;
  marketCapUsd: number;
  liquidityUsd?: number;
  volumeH1Usd?: number;
  holderCount?: number;
  priceChangeH1Pct?: number;
  lastPriceSol?: number;
  band: MajorsMcBand;
  reasons: string[];
}

/** Circulating MC floor for majors admit */
export const MAJORS_MIN_MC_USD = 100_000_000;
/** Min liquidity — mid of ~$50k–$100k band */
export const MAJORS_MIN_LIQ_USD = 75_000;
const FETCH_LIMIT = 80;
const CYCLE_CAP = 18;
const REFRESH_MS = 5 * 60_000;

let cache: { at: number; list: MajorsCandidate[] } | null = null;
let lastPassAt = 0;
let lastPassOffered = 0;
let lastError: string | null = null;

export function majorsMcBand(mc: number): MajorsMcBand {
  if (mc >= 1_000_000_000) return '1b+';
  if (mc >= 500_000_000) return '500m';
  if (mc >= 250_000_000) return '250m';
  return '100m';
}

function solUsd(): number {
  return 150;
}

function tokenToCandidate(token: JupiterTokenInfo): MajorsCandidate | null {
  const mint = String(token.id || '').trim();
  if (!mint) return null;
  // Circulating MC only — never FDV
  const mc = readJupiterMarketCapUsd(token);
  if (mc == null || mc < MAJORS_MIN_MC_USD) return null;
  const liq = Number(token.liquidity ?? 0);
  if (!Number.isFinite(liq) || liq < MAJORS_MIN_LIQ_USD) return null;

  const ev = jupiterTokenToLaunchEvent(token, solUsd(), {
    preferOrganicVolume: config.marketScanner?.preferOrganicVolume !== false,
  });
  // Guard: launch event must also carry circulating mcap (no FDV fallback)
  const circ = Number(ev.marketCapUsd ?? 0);
  if (!Number.isFinite(circ) || circ < MAJORS_MIN_MC_USD) return null;

  const band = majorsMcBand(circ);
  return {
    mint,
    symbol: ev.symbol,
    name: ev.name,
    marketCapUsd: circ,
    liquidityUsd: ev.liquidityUsd,
    volumeH1Usd: ev.volumeH1Usd,
    holderCount: ev.holderCount,
    priceChangeH1Pct: ev.priceChangeH1Pct,
    lastPriceSol: ev.lastPriceSol > 0 ? ev.lastPriceSol : undefined,
    band,
    reasons: [`majors:${band}`, `circMC:$${Math.round(circ)}`, `liq:$${Math.round(liq)}`],
  };
}

/**
 * Refresh majors universe from Jupiter (cached ~5m).
 * No pump-only filter — large-cap Solana names included.
 */
export async function refreshMajorsUniverse(force = false): Promise<MajorsCandidate[]> {
  if (!force && cache && Date.now() - cache.at < REFRESH_MS) {
    return cache.list;
  }
  if (!hasJupiterApiKey()) {
    lastError = 'No JUPITER_API_KEY';
    return cache?.list ?? [];
  }

  try {
    const [traded, organic] = await Promise.all([
      fetchJupiterTopTokens('toptraded', '1h', FETCH_LIMIT),
      fetchJupiterTopTokens('toporganicscore', '6h', FETCH_LIMIT),
    ]);
    const byMint = new Map<string, JupiterTokenInfo>();
    for (const t of [...traded, ...organic]) {
      const id = String(t?.id || '').trim();
      if (!id) continue;
      const prev = byMint.get(id);
      if (!prev) {
        byMint.set(id, t);
        continue;
      }
      byMint.set(id, {
        ...prev,
        ...t,
        stats5m: t.stats5m ?? prev.stats5m,
        stats1h: t.stats1h ?? prev.stats1h,
        stats6h: t.stats6h ?? prev.stats6h,
        stats24h: t.stats24h ?? prev.stats24h,
        // Prefer higher circulating mcap when merging
        mcap:
          Number(t.mcap ?? 0) > Number(prev.mcap ?? 0) ? t.mcap : prev.mcap,
      });
    }

    const list: MajorsCandidate[] = [];
    for (const t of byMint.values()) {
      const c = tokenToCandidate(t);
      if (c) list.push(c);
    }
    list.sort((a, b) => b.marketCapUsd - a.marketCapUsd);
    const capped = list.slice(0, CYCLE_CAP);
    cache = { at: Date.now(), list: capped };
    lastError = null;
    return capped;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.warn('[majors] refresh failed:', lastError);
    return cache?.list ?? [];
  }
}

export function getMajorsUniverseStatus(): {
  count: number;
  lastRefreshAt: number | null;
  lastPassAt: number | null;
  lastPassOffered: number;
  lastError: string | null;
  bands: Record<MajorsMcBand, number>;
  sample: Array<{ symbol: string; mc: number; band: MajorsMcBand }>;
} {
  const list = cache?.list ?? [];
  const bands: Record<MajorsMcBand, number> = {
    '100m': 0,
    '250m': 0,
    '500m': 0,
    '1b+': 0,
  };
  for (const c of list) bands[c.band] += 1;
  return {
    count: list.length,
    lastRefreshAt: cache?.at ?? null,
    lastPassAt: lastPassAt || null,
    lastPassOffered,
    lastError,
    bands,
    sample: list.slice(0, 8).map((c) => ({
      symbol: c.symbol,
      mc: c.marketCapUsd,
      band: c.band,
    })),
  };
}

/**
 * Specialty-pass hook: offer majors into Dip setup watch (source: majors).
 * Does not hand to Scalper Mode B. Returns number offered this cycle.
 */
export async function runMajorsUniversePass(): Promise<number> {
  if (!isStrategyEnabledGlobal('ta_market_scanner')) return 0;
  if (!isSmartBotProfilesEnabled()) return 0;
  if (config.tradeProfiles?.enabled === false) return 0;
  if (config.tradeProfiles?.profiles?.dip_buyer === false) return 0;

  const list = await refreshMajorsUniverse();
  if (!list.length) {
    lastPassAt = Date.now();
    lastPassOffered = 0;
    return 0;
  }

  let offered = 0;
  try {
    const { offerDipWatchFromCandidate } =
      require('./dipSetupWatch') as typeof import('./dipSetupWatch');
    for (const c of list) {
      offerDipWatchFromCandidate({
        mint: c.mint,
        symbol: c.symbol,
        name: c.name,
        marketCapUsd: c.marketCapUsd,
        volumeH1Usd: c.volumeH1Usd,
        holderCount: c.holderCount,
        priceChangeH1Pct: c.priceChangeH1Pct,
        lastPriceSol: c.lastPriceSol ?? null,
        preferredProfileId: 'dip_buyer',
        specialtyFeed: 'majors',
        majorsBand: c.band,
      });
      offered += 1;
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.warn('[majors] dip-watch offer failed:', lastError);
  }

  lastPassAt = Date.now();
  lastPassOffered = offered;
  if (offered > 0) {
    const bands = getMajorsUniverseStatus().bands;
    console.log(
      `[majors] offered ${offered} → dip-watch ` +
        `(100m:${bands['100m']} 250m:${bands['250m']} ` +
        `500m:${bands['500m']} 1b+:${bands['1b+']})`
    );
  }
  return offered;
}
