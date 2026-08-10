/**
 * Mid-MC + high-MC discovery — Jupiter multi-category merge without pump filter.
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
  type JupiterCategory,
  type JupiterInterval,
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
/** Watch-list liquidity floor (1.2.261: $40k; trade anti-rug unchanged) */
export const MAJORS_MIN_LIQ_USD = 40_000;
/** Soft H1 volume floor for Medium Steady quality */
export const MEDIUM_MIN_VOL_H1_USD = 12_000;
/** Soft H1 volume floor for Majors Steady quality */
export const MAJORS_MIN_VOL_H1_USD = 20_000;
/** @deprecated Use MEDIUM_MIN_VOL_H1_USD / MAJORS_MIN_VOL_H1_USD */
export const MEDIUM_MAJORS_MIN_VOL_H1_USD = MAJORS_MIN_VOL_H1_USD;
/** Hard min age for Medium/Majors watch list — 30 days (1.2.261; was 60d) */
export const MEDIUM_MAJORS_MIN_AGE_HOURS = 30 * 24;
/** Soft prefer ranking bonus ≥ 90 days */
export const MEDIUM_MAJORS_PREFER_AGE_HOURS = 90 * 24;
const FETCH_LIMIT = 100;
/** Separate caps so majors do not starve medium (1.2.261: 80) */
const CYCLE_CAP_MEDIUM = 80;
const CYCLE_CAP_MAJORS = 80;
const REFRESH_MS = 5 * 60_000;
/** Time-gated no-levels: +1 streak every 20m without levels; rotate after 4 (~80m) */
export const NO_LEVELS_ROTATE_AFTER = 4;
const NO_LEVELS_STREAK_TICK_MS = 20 * 60_000;
/** Park mega-caps without Fib/S until watch TTL — do not rotate on no-levels */
export const NO_LEVELS_SKIP_ROTATE_MC_USD = 500_000_000;
/** Reserve ~40% of CYCLE seats for mid-MC bands (50m/100m) */
const MID_BAND_SEAT_FRAC = 0.4;

/** Jupiter feeds to merge (each ≤100). Wider discovery than single toptraded/organic. */
const DISCOVERY_FEEDS: Array<{
  category: JupiterCategory;
  interval: JupiterInterval;
}> = [
  { category: 'toptraded', interval: '1h' },
  { category: 'toptraded', interval: '24h' },
  { category: 'toptrending', interval: '1h' },
  { category: 'toptrending', interval: '6h' },
  { category: 'toporganicscore', interval: '6h' },
  { category: 'toporganicscore', interval: '24h' },
];

type RejectKey =
  | 'denied'
  | 'mc'
  | 'pump'
  | 'age_unknown'
  | 'age'
  | 'liq'
  | 'vol'
  | 'other';

const rejectCounters: Record<RejectKey, number> = {
  denied: 0,
  mc: 0,
  pump: 0,
  age_unknown: 0,
  age: 0,
  liq: 0,
  vol: 0,
  other: 0,
};

function resetRejectCounters(): void {
  for (const k of Object.keys(rejectCounters) as RejectKey[]) {
    rejectCounters[k] = 0;
  }
}

function noteReject(key: RejectKey): void {
  rejectCounters[key] = (rejectCounters[key] || 0) + 1;
}

let cache: { at: number; list: MajorsCandidate[] } | null = null;
let lastPassAt = 0;
let lastPassOffered = 0;
let lastError: string | null = null;
let lastRawMerged = 0;
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

function mergeJupiterToken(
  prev: JupiterTokenInfo,
  t: JupiterTokenInfo
): JupiterTokenInfo {
  return {
    ...prev,
    ...t,
    stats5m: t.stats5m ?? prev.stats5m,
    stats1h: t.stats1h ?? prev.stats1h,
    stats6h: t.stats6h ?? prev.stats6h,
    stats24h: t.stats24h ?? prev.stats24h,
    mcap: Number(t.mcap ?? 0) > Number(prev.mcap ?? 0) ? t.mcap : prev.mcap,
    liquidity:
      Number(t.liquidity ?? 0) > Number(prev.liquidity ?? 0)
        ? t.liquidity
        : prev.liquidity,
    firstPool: t.firstPool ?? prev.firstPool,
    createdAt: t.createdAt ?? prev.createdAt,
  };
}

function tokenToCandidate(token: JupiterTokenInfo): MajorsCandidate | null {
  const mint = String(token.id || '').trim();
  if (!mint) {
    noteReject('other');
    return null;
  }
  const sym = String(token.symbol || mint.slice(0, 6)).slice(0, 24);
  // Stables / quote assets never enter Medium/Majors CYCLE_CAP
  try {
    const solMint = String(config.solMint || '').trim() || undefined;
    if (isDeniedCopyMint(mint, solMint)) {
      noteReject('denied');
      return null;
    }
  } catch {
    if (isDeniedCopyMint(mint)) {
      noteReject('denied');
      return null;
    }
  }
  // Circulating MC only — never FDV
  const mc = readJupiterMarketCapUsd(token);
  if (mc == null || mc < MEDIUM_MIN_MC_USD) {
    noteReject('mc');
    return null;
  }
  const watchBand = universeWatchBand(mc);
  if (!watchBand) {
    noteReject('mc');
    return null;
  }
  const logPfx = watchlistLogPrefix(watchBand);

  // Hard reject pump.fun / launchpad for quality parks (Steady is organic majors)
  if (isPumpFunMintSuffix(mint) || isJupiterPumpFunToken(token)) {
    noteReject('pump');
    console.log(`${logPfx} reject pump ${sym} MC=$${Math.round(mc)}`);
    return null;
  }

  // Age: fail-open when unknown (rank lower). Hard floor 30d when known.
  const age = resolveJupiterTokenAgeHours(token);
  if (age && age.ageHours < MEDIUM_MAJORS_MIN_AGE_HOURS) {
    noteReject('age');
    console.log(
      `${logPfx} reject too_young ${sym} ageDays=${(age.ageHours / 24).toFixed(1)} ` +
        `MC=$${Math.round(mc)}`
    );
    return null;
  }
  if (!age) {
    noteReject('age_unknown');
    // fail-open into watch — do not return null
  }

  const liq = Number(token.liquidity ?? 0);
  if (!Number.isFinite(liq) || liq < MAJORS_MIN_LIQ_USD) {
    noteReject('liq');
    console.log(
      `${logPfx} reject liq_low ${sym} liq=$${Math.round(liq || 0)}`
    );
    return null;
  }

  // Total H1 for admit floor (avoid organic-only wipe); organic still in raw stats
  const ev = jupiterTokenToLaunchEvent(token, solUsd(), {
    preferOrganicVolume: false,
  });
  const circ = Number(ev.marketCapUsd ?? 0);
  if (!Number.isFinite(circ) || circ < MEDIUM_MIN_MC_USD) {
    noteReject('mc');
    return null;
  }
  const wb = universeWatchBand(circ);
  if (!wb) {
    noteReject('mc');
    return null;
  }

  const volH1 = Number(ev.volumeH1Usd ?? 0);
  const minVolH1 =
    wb === 'medium' ? MEDIUM_MIN_VOL_H1_USD : MAJORS_MIN_VOL_H1_USD;
  if (Number.isFinite(volH1) && volH1 > 0 && volH1 < minVolH1) {
    noteReject('vol');
    console.log(
      `${watchlistLogPrefix(wb)} reject vol_low ${sym} volH1=$${Math.round(volH1)} ` +
        `min=$${minVolH1}`
    );
    return null;
  }

  const band = majorsMcBand(circ);
  const preferAged =
    age != null && age.ageHours >= MEDIUM_MAJORS_PREFER_AGE_HOURS;
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
    pairCreatedAtMs: age?.pairCreatedAtMs,
    tokenAgeHours: age?.ageHours,
    reasons: [
      `${wb}:${band}`,
      `circMC:$${Math.round(circ)}`,
      `liq:$${Math.round(liq)}`,
      age
        ? `ageDays:${(age.ageHours / 24).toFixed(0)}`
        : 'age:unknown',
      ...(preferAged ? ['age≥90d'] : []),
    ],
  };
}

/**
 * Refresh medium+majors universe from Jupiter (cached ~5m).
 * Multi-category merge for wider ≥$50M / ≥$200M coverage.
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
    resetRejectCounters();
    const batches = await Promise.all(
      DISCOVERY_FEEDS.map((f) =>
        fetchJupiterTopTokens(f.category, f.interval, FETCH_LIMIT)
      )
    );
    const byMint = new Map<string, JupiterTokenInfo>();
    for (const batch of batches) {
      for (const t of batch) {
        const id = String(t?.id || '').trim();
        if (!id) continue;
        const prev = byMint.get(id);
        if (!prev) {
          byMint.set(id, t);
          continue;
        }
        byMint.set(id, mergeJupiterToken(prev, t));
      }
    }
    lastRawMerged = byMint.size;

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
    console.log(
      `[majors] refresh merged=${lastRawMerged} passed=${list.length} ` +
        `cycle=${capped.length} (med=${medium.length} maj=${majors.length}) ` +
        `reject pump=${rejectCounters.pump} age=${rejectCounters.age} ` +
        `ageUnk=${rejectCounters.age_unknown} liq=${rejectCounters.liq} ` +
        `vol=${rejectCounters.vol} mc=${rejectCounters.mc}`
    );
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
  lastRawMerged: number;
  rejects: Record<RejectKey, number>;
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
    lastRawMerged,
    rejects: { ...rejectCounters },
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
  _band: MajorsMcBand | UniverseWatchBand
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
    knownAge: c.tokenAgeHours != null ? 1 : 0,
  }));
  scored.sort((a, b) => {
    if (b.near !== a.near) return b.near - a.near;
    if (b.aged !== a.aged) return b.aged - a.aged;
    if (b.knownAge !== a.knownAge) return b.knownAge - a.knownAge;
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
