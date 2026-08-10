/**
 * Mid-MC + high-MC discovery — Jupiter toptraded / toporganicscore without pump filter.
 * Medium $50M–$200M + Majors ≥$200M → Dip/Steady watch (prefer Steady quality reclaim).
 * Never Scalper Mode B. Additive: launch/pump scanner for Scalper-family stays unchanged.
 */

import { config } from './config';
import { isDeniedCopyMint } from './deniedMints';
import { isPumpFunMintSuffix } from './deadTokenFilters';
import { readJupiterMarketCapUsd } from './marketData';
import {
  fetchJupiterTopTokens,
  hasJupiterApiKey,
  isJupiterPumpFunToken,
  jupiterTokenToLaunchEvent,
  type JupiterTokenInfo,
} from './jupiterTokens';
import { isStrategyEnabledGlobal } from './strategies';
import { isSmartBotProfilesEnabled } from './tradeProfiles';

/** UI / watch source band */
export type UniverseWatchBand = 'medium' | 'majors';

/** Soft MC sub-band for badges / prefer logic */
export type MajorsMcBand = '50m' | '100m' | '200m' | '250m' | '500m' | '1b+';

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
  /** medium = $50–200M; majors = ≥$200M */
  watchBand: UniverseWatchBand;
  reasons: string[];
  /** Jupiter firstPool / createdAt ms — real token age (never watch birth) */
  pairCreatedAtMs?: number;
  tokenAgeHours?: number;
}

/** Medium floor (Steady quality band) */
export const MEDIUM_MIN_MC_USD = 50_000_000;
/** Majors floor — Steady prefer threshold (raised from prior soft $250M prefer) */
export const MAJORS_MIN_MC_USD = 200_000_000;
/** Legacy alias: circulating MC floor for any mid/majors admit */
export const UNIVERSE_MIN_MC_USD = MEDIUM_MIN_MC_USD;
/** Min liquidity — mid of ~$50k–$100k band */
export const MAJORS_MIN_LIQ_USD = 75_000;
/** Soft H1 volume floor for Medium Steady quality (1.2.258: $12k) */
export const MEDIUM_MIN_VOL_H1_USD = 12_000;
/** Soft H1 volume floor for Majors Steady quality (1.2.258: $20k) */
export const MAJORS_MIN_VOL_H1_USD = 20_000;
/** @deprecated Use MEDIUM_MIN_VOL_H1_USD / MAJORS_MIN_VOL_H1_USD */
export const MEDIUM_MAJORS_MIN_VOL_H1_USD = MAJORS_MIN_VOL_H1_USD;
/** Hard min age for Medium/Majors universe — 60 days */
export const MEDIUM_MAJORS_MIN_AGE_HOURS = 60 * 24;
/** Soft prefer ranking bonus ≥ 90 days */
export const MEDIUM_MAJORS_PREFER_AGE_HOURS = 90 * 24;
const FETCH_LIMIT = 100;
/** Separate caps so majors do not starve medium */
const CYCLE_CAP_MEDIUM = 25;
const CYCLE_CAP_MAJORS = 25;
const REFRESH_MS = 5 * 60_000;
/** Time-gated no-levels: +1 streak every 20m without levels; rotate after 4 (~80m) */
export const NO_LEVELS_ROTATE_AFTER = 4;
const NO_LEVELS_STREAK_TICK_MS = 20 * 60_000;
/** Park mega-caps without Fib/S until watch TTL — do not rotate on no-levels */
export const NO_LEVELS_SKIP_ROTATE_MC_USD = 500_000_000;
/** Reserve ~40% of CYCLE seats for mid-MC bands (50m/100m) */
const MID_BAND_SEAT_FRAC = 0.4;

let cache: { at: number; list: MajorsCandidate[] } | null = null;
let lastPassAt = 0;
let lastPassOffered = 0;
let lastError: string | null = null;
/** mint → time-gated no-levels streak (+1 per 20m without levels) */
const noLevelsStreak = new Map<
  string,
  { streak: number; lastTickAt: number }
>();

function watchlistLogPrefix(band: UniverseWatchBand): string {
  return band === 'majors' ? '[WATCHLIST-MAJOR]' : '[WATCHLIST-MEDIUM]';
}

/** Resolve Jupiter pool/token created age in hours; null if unknown. */
export function resolveJupiterTokenAgeHours(
  token: JupiterTokenInfo
): { ageHours: number; pairCreatedAtMs: number } | null {
  const raw = token.firstPool?.createdAt || token.createdAt;
  if (!raw) return null;
  const ms = Date.parse(String(raw));
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return {
    pairCreatedAtMs: ms,
    ageHours: Math.max(0, (Date.now() - ms) / 3_600_000),
  };
}

export function majorsMcBand(mc: number): MajorsMcBand {
  if (mc >= 1_000_000_000) return '1b+';
  if (mc >= 500_000_000) return '500m';
  if (mc >= 250_000_000) return '250m';
  if (mc >= 200_000_000) return '200m';
  if (mc >= 100_000_000) return '100m';
  return '50m';
}

export function universeWatchBand(mc: number): UniverseWatchBand | null {
  if (!(mc > 0) || !Number.isFinite(mc)) return null;
  if (mc >= MAJORS_MIN_MC_USD) return 'majors';
  if (mc >= MEDIUM_MIN_MC_USD) return 'medium';
  return null;
}

function solUsd(): number {
  return 150;
}

function tokenToCandidate(token: JupiterTokenInfo): MajorsCandidate | null {
  const mint = String(token.id || '').trim();
  if (!mint) return null;
  const sym = String(token.symbol || mint.slice(0, 6)).slice(0, 24);
  // Stables / quote assets never enter Medium/Majors CYCLE_CAP
  try {
    const solMint = String(config.solMint || '').trim() || undefined;
    if (isDeniedCopyMint(mint, solMint)) {
      return null;
    }
  } catch {
    if (isDeniedCopyMint(mint)) return null;
  }
  // Circulating MC only — never FDV
  const mc = readJupiterMarketCapUsd(token);
  if (mc == null || mc < MEDIUM_MIN_MC_USD) return null;
  const watchBand = universeWatchBand(mc);
  if (!watchBand) return null;
  const logPfx = watchlistLogPrefix(watchBand);

  // Hard reject pump.fun / launchpad for quality parks (Steady is organic majors)
  if (isPumpFunMintSuffix(mint) || isJupiterPumpFunToken(token)) {
    console.log(
      `${logPfx} reject pump ${sym} MC=$${Math.round(mc)}`
    );
    return null;
  }

  const age = resolveJupiterTokenAgeHours(token);
  if (!age) {
    console.log(`${logPfx} reject age_unknown ${sym} MC=$${Math.round(mc)}`);
    return null;
  }
  if (age.ageHours < MEDIUM_MAJORS_MIN_AGE_HOURS) {
    console.log(
      `${logPfx} reject too_young ${sym} ageDays=${(age.ageHours / 24).toFixed(1)} ` +
        `MC=$${Math.round(mc)}`
    );
    return null;
  }

  const liq = Number(token.liquidity ?? 0);
  if (!Number.isFinite(liq) || liq < MAJORS_MIN_LIQ_USD) {
    console.log(
      `${logPfx} reject liq_low ${sym} liq=$${Math.round(liq || 0)}`
    );
    return null;
  }

  const ev = jupiterTokenToLaunchEvent(token, solUsd(), {
    preferOrganicVolume: config.marketScanner?.preferOrganicVolume !== false,
  });
  // Guard: launch event must also carry circulating mcap (no FDV fallback)
  const circ = Number(ev.marketCapUsd ?? 0);
  if (!Number.isFinite(circ) || circ < MEDIUM_MIN_MC_USD) return null;
  const wb = universeWatchBand(circ);
  if (!wb) return null;

  const volH1 = Number(ev.volumeH1Usd ?? 0);
  const minVolH1 =
    wb === 'medium' ? MEDIUM_MIN_VOL_H1_USD : MAJORS_MIN_VOL_H1_USD;
  if (Number.isFinite(volH1) && volH1 > 0 && volH1 < minVolH1) {
    console.log(
      `${watchlistLogPrefix(wb)} reject vol_low ${sym} volH1=$${Math.round(volH1)} ` +
        `min=$${minVolH1}`
    );
    return null;
  }

  const band = majorsMcBand(circ);
  const preferAged = age.ageHours >= MEDIUM_MAJORS_PREFER_AGE_HOURS;
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
    watchBand: wb,
    pairCreatedAtMs: age.pairCreatedAtMs,
    tokenAgeHours: age.ageHours,
    reasons: [
      `${wb}:${band}`,
      `circMC:$${Math.round(circ)}`,
      `liq:$${Math.round(liq)}`,
      `ageDays:${(age.ageHours / 24).toFixed(0)}`,
      ...(preferAged ? ['age≥90d'] : []),
    ],
  };
}

/**
 * Refresh medium+majors universe from Jupiter (cached ~5m).
 * No pump-only filter — large-cap Solana names included.
 */
export async function refreshMajorsUniverse(
  force = false
): Promise<MajorsCandidate[]> {
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
    const medium = pickCycleWithMidSeats(
      list.filter((c) => c.watchBand === 'medium'),
      CYCLE_CAP_MEDIUM
    );
    const majors = sortPreferNearLevels(
      list.filter((c) => c.watchBand === 'majors')
    ).slice(0, CYCLE_CAP_MAJORS);
    const capped = [...medium, ...majors].sort(
      (a, b) => b.marketCapUsd - a.marketCapUsd
    );
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
  mediumCount: number;
  majorsCount: number;
  lastRefreshAt: number | null;
  lastPassAt: number | null;
  lastPassOffered: number;
  lastError: string | null;
  bands: Record<MajorsMcBand, number>;
  sample: Array<{
    symbol: string;
    mc: number;
    band: MajorsMcBand;
    watchBand: UniverseWatchBand;
  }>;
} {
  const list = cache?.list ?? [];
  const bands: Record<MajorsMcBand, number> = {
    '50m': 0,
    '100m': 0,
    '200m': 0,
    '250m': 0,
    '500m': 0,
    '1b+': 0,
  };
  let mediumCount = 0;
  let majorsCount = 0;
  for (const c of list) {
    bands[c.band] += 1;
    if (c.watchBand === 'medium') mediumCount += 1;
    else majorsCount += 1;
  }
  return {
    count: list.length,
    mediumCount,
    majorsCount,
    lastRefreshAt: cache?.at ?? null,
    lastPassAt: lastPassAt || null,
    lastPassOffered,
    lastError,
    bands,
    sample: list.slice(0, 8).map((c) => ({
      symbol: c.symbol,
      mc: c.marketCapUsd,
      band: c.band,
      watchBand: c.watchBand,
    })),
  };
}

/**
 * Soft prefer: Medium + Majors → Steady Compounder when enabled;
 * Steady-off → Dip Buyer. Never Scalper.
 */
export function majorsPreferredProfileId(
  band: MajorsMcBand | UniverseWatchBand
): string {
  try {
    if (config.tradeProfiles?.profiles?.steady_compounder !== false) {
      return 'steady_compounder';
    }
  } catch {
    /* soft */
  }
  return 'dip_buyer';
}

/** Soft boost when Fib/S levels already known (prefer near-level parks in CYCLE). */
function candidateNearKnownLevels(c: MajorsCandidate): boolean {
  try {
    const { getTechnicalLevelsForStrategy } =
      require('./technicalLevels') as typeof import('./technicalLevels');
    const tech = getTechnicalLevelsForStrategy({
      mint: c.mint,
      priceSol: c.lastPriceSol ?? undefined,
    });
    if (!tech) return false;
    return tech.nearFibZone === true || tech.nearSupportZone === true;
  } catch {
    return false;
  }
}

function sortPreferNearLevels(list: MajorsCandidate[]): MajorsCandidate[] {
  const scored = list.map((c) => ({
    c,
    near: candidateNearKnownLevels(c) ? 1 : 0,
    aged:
      c.tokenAgeHours != null &&
      c.tokenAgeHours >= MEDIUM_MAJORS_PREFER_AGE_HOURS
        ? 1
        : 0,
  }));
  scored.sort((a, b) => {
    if (b.near !== a.near) return b.near - a.near;
    if (b.aged !== a.aged) return b.aged - a.aged;
    return b.c.marketCapUsd - a.c.marketCapUsd;
  });
  return scored.map((x) => x.c);
}

/**
 * Fill CYCLE seats with ~40% reserved for mid-MC bands (50m/100m), rest by top MC.
 * Prefer candidates already near Fib/S when levels are known; still allow level-less park.
 */
function pickCycleWithMidSeats(
  candidates: MajorsCandidate[],
  cap: number
): MajorsCandidate[] {
  if (cap <= 0 || !candidates.length) return [];
  const midReserve = Math.max(1, Math.floor(cap * MID_BAND_SEAT_FRAC));
  const mid = sortPreferNearLevels(
    candidates.filter((c) => c.band === '50m' || c.band === '100m')
  );
  const rest = sortPreferNearLevels(
    candidates.filter((c) => c.band !== '50m' && c.band !== '100m')
  );
  const picked: MajorsCandidate[] = [];
  const used = new Set<string>();
  for (const c of mid) {
    if (picked.length >= midReserve) break;
    picked.push(c);
    used.add(c.mint);
  }
  for (const c of [...rest, ...mid]) {
    if (picked.length >= cap) break;
    if (used.has(c.mint)) continue;
    picked.push(c);
    used.add(c.mint);
  }
  return picked;
}

/**
 * Time-gated no-levels rotate: +1 streak every 20 min without levels; rotate after 4 (~80m).
 * MC ≥ $500M: never rotate on no-levels (park until watch TTL).
 */
export function noteMajorsLevelsPresence(
  mint: string,
  hasLevels: boolean,
  marketCapUsd?: number | null
): { rotate: boolean; streak: number } {
  const key = String(mint || '').trim();
  if (!key) return { rotate: false, streak: 0 };
  if (hasLevels) {
    noLevelsStreak.delete(key);
    return { rotate: false, streak: 0 };
  }
  const mc = Number(marketCapUsd);
  if (Number.isFinite(mc) && mc >= NO_LEVELS_SKIP_ROTATE_MC_USD) {
    return { rotate: false, streak: noLevelsStreak.get(key)?.streak || 0 };
  }
  const now = Date.now();
  const prev = noLevelsStreak.get(key);
  if (!prev) {
    noLevelsStreak.set(key, { streak: 1, lastTickAt: now });
    return { rotate: false, streak: 1 };
  }
  if (now - prev.lastTickAt < NO_LEVELS_STREAK_TICK_MS) {
    return {
      rotate: prev.streak >= NO_LEVELS_ROTATE_AFTER,
      streak: prev.streak,
    };
  }
  const next = prev.streak + 1;
  noLevelsStreak.set(key, { streak: next, lastTickAt: now });
  return { rotate: next >= NO_LEVELS_ROTATE_AFTER, streak: next };
}

export function clearMajorsNoLevelsStreak(mint: string): void {
  noLevelsStreak.delete(String(mint || '').trim());
}

/**
 * Specialty-pass hook: offer medium + majors into Dip/Steady setup watch.
 * Does not hand to Scalper Mode B. Returns number offered this cycle.
 */
export async function runMajorsUniversePass(): Promise<number> {
  if (!isStrategyEnabledGlobal('ta_market_scanner')) return 0;
  if (!isSmartBotProfilesEnabled()) return 0;
  if (config.tradeProfiles?.enabled === false) return 0;
  if (
    config.tradeProfiles?.profiles?.dip_buyer === false &&
    config.tradeProfiles?.profiles?.steady_compounder === false
  ) {
    return 0;
  }

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
      const prefer = majorsPreferredProfileId(c.watchBand);
      offerDipWatchFromCandidate({
        mint: c.mint,
        symbol: c.symbol,
        name: c.name,
        marketCapUsd: c.marketCapUsd,
        volumeH1Usd: c.volumeH1Usd,
        holderCount: c.holderCount,
        priceChangeH1Pct: c.priceChangeH1Pct,
        lastPriceSol: c.lastPriceSol ?? null,
        preferredProfileId: prefer,
        specialtyFeed: c.watchBand === 'medium' ? 'medium' : 'majors',
        majorsBand: c.band,
        pairCreatedAtMs: c.pairCreatedAtMs,
        tokenAgeHours: c.tokenAgeHours,
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
    const st = getMajorsUniverseStatus();
    console.log(
      `[majors] offered ${offered} → dip/steady-watch ` +
        `(medium:${st.mediumCount} majors:${st.majorsCount} ` +
        `50m:${st.bands['50m']} 100m:${st.bands['100m']} ` +
        `200m:${st.bands['200m']} 250m:${st.bands['250m']} ` +
        `500m:${st.bands['500m']} 1b+:${st.bands['1b+']})`
    );
  }
  return offered;
}
