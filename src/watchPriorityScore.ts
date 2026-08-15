/**
 * Per-profile WatchScore (0–100) with stagnation + volume-weighted decay.
 * Additive ranker for arm/trigger order — does not replace family arm predicates.
 */

import {
  evaluateVolumeIntelligence,
  VOLUME_INTEL_FAST_PROFILES,
  type VolumeDecayState,
} from './volumeIntelligence';
import { resolveTradeProfileDefinition } from './tradeProfiles';

export const DEFAULT_MAX_ARMED_WATCHES = 5;
export const WATCH_SCORE_FLOOR = 8;
export const WATCH_ARM_SCORE_FLOOR = 20;
export const FLOOR_EXPIRE_MS = 8 * 60_000;

export type WatchVolumeUiState =
  | 'expanding'
  | 'stable'
  | 'weakening'
  | 'collapsed';

export interface WatchScoreBreakdown {
  setup: number;
  timing: number;
  activity: number;
  risk: number;
  decay: number;
}

export interface WatchPriorityFields {
  watchScore?: number;
  watchScoreBreakdown?: WatchScoreBreakdown;
  volumeState?: WatchVolumeUiState | string;
  decayMultiplier?: number;
  lastImprovementAt?: number;
  scoreAtFloorSince?: number | null;
  watchScoreChips?: string[];
  watchRank?: number;
  watchScoreAtArm?: number;
  prevLevelDistancePct?: number | null;
  prevConfluenceCount?: number | null;
}

export interface WatchScoreInput {
  profileId: string;
  status?: string | null;
  createdAt?: number | null;
  armedAt?: number | null;
  lastImprovementAt?: number | null;
  nearSupport?: boolean | null;
  nearKeyFib?: boolean | null;
  nearMultiTfSupport?: boolean | null;
  supportPriceSol?: number | null;
  fib05PriceSol?: number | null;
  lastPriceSol?: number | null;
  extensionFromLevelPct?: number | null;
  lateChase?: boolean | null;
  confluenceCount?: number | null;
  srConfluenceScore?: number | null;
  dnaHits?: number | null;
  curveProgressPct?: number | null;
  volumeM5Usd?: number | null;
  volumeH1Usd?: number | null;
  holderGrowthPct?: number | null;
  buyPressureUsd?: number | null;
  movementActive?: boolean | null;
  liquidityUsd?: number | null;
  top10HoldPct?: number | null;
  tokenAgeHours?: number | null;
  dropFromPeakPct?: number | null;
  prevLevelDistancePct?: number | null;
  prevConfluenceCount?: number | null;
  prevVolumeState?: string | null;
}

export interface WatchScoreResult {
  score: number;
  breakdown: WatchScoreBreakdown;
  volumeState: WatchVolumeUiState;
  decayMultiplier: number;
  chips: string[];
  improved: boolean;
  lastImprovementAt: number;
  atFloor: boolean;
}

type WeightSet = {
  setup: number;
  timing: number;
  activity: number;
  risk: number;
};

const WEIGHTS: Record<string, WeightSet> = {
  dip_buyer: { setup: 0.4, timing: 0.15, activity: 0.3, risk: 0.15 },
  scalper: { setup: 0.35, timing: 0.15, activity: 0.35, risk: 0.15 },
  reversal_scalper: { setup: 0.38, timing: 0.18, activity: 0.28, risk: 0.16 },
  momentum_burst: { setup: 0.22, timing: 0.18, activity: 0.42, risk: 0.18 },
  trend_rider: { setup: 0.38, timing: 0.14, activity: 0.3, risk: 0.18 },
  migration_sniper: { setup: 0.28, timing: 0.32, activity: 0.28, risk: 0.12 },
  steady_compounder: { setup: 0.32, timing: 0.12, activity: 0.38, risk: 0.18 },
  high_win_rate: { setup: 0.46, timing: 0.12, activity: 0.18, risk: 0.24 },
  smart_money_mirror: { setup: 0.2, timing: 0.35, activity: 0.3, risk: 0.15 },
};

const GRACE_MS: Record<string, number> = {
  scalper: 3 * 60_000,
  reversal_scalper: 3 * 60_000,
  momentum_burst: 3 * 60_000,
  dip_buyer: 6 * 60_000,
  migration_sniper: 6 * 60_000,
  trend_rider: 10 * 60_000,
  steady_compounder: 10 * 60_000,
  high_win_rate: 6 * 60_000,
  smart_money_mirror: 8 * 60_000,
};

const DECAY_PER_MIN: Record<string, number> = {
  scalper: 2.6,
  reversal_scalper: 2.4,
  momentum_burst: 2.8,
  dip_buyer: 1.2,
  migration_sniper: 1.3,
  trend_rider: 0.7,
  steady_compounder: 0.5,
  high_win_rate: 1.15,
  smart_money_mirror: 1.0,
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function fin(n: unknown): number | null {
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

function weightsFor(profileId: string): WeightSet {
  return WEIGHTS[profileId] || WEIGHTS.dip_buyer;
}

function graceMsFor(profileId: string): number {
  return GRACE_MS[profileId] ?? 6 * 60_000;
}

function decayPerMinFor(profileId: string): number {
  return DECAY_PER_MIN[profileId] ?? 1.2;
}

export function getMaxArmedWatches(profileId: string | null | undefined): number {
  try {
    const n = Number(
      resolveTradeProfileDefinition(profileId).match.maxArmedWatches
    );
    if (Number.isFinite(n) && n > 0) return Math.max(1, Math.min(24, Math.floor(n)));
  } catch {
    /* catalog default */
  }
  return DEFAULT_MAX_ARMED_WATCHES;
}

function levelDistancePct(input: WatchScoreInput): number | null {
  const px = fin(input.lastPriceSol);
  const lvl =
    fin(input.supportPriceSol) ??
    fin(input.fib05PriceSol);
  if (px == null || lvl == null || lvl <= 0) return null;
  return (Math.abs(px - lvl) / lvl) * 100;
}

function volumeUiState(
  decay: VolumeDecayState,
  profileId: string
): WatchVolumeUiState {
  if (decay === 'expanding') return 'expanding';
  if (decay === 'stable') return 'stable';
  if (decay === 'collapsed') return 'collapsed';
  if (VOLUME_INTEL_FAST_PROFILES.has(profileId)) return 'weakening';
  return 'weakening';
}

function volumeDecayMultiplier(
  state: WatchVolumeUiState,
  profileId: string
): number {
  const fast = VOLUME_INTEL_FAST_PROFILES.has(profileId);
  if (state === 'expanding') return fast ? 0.45 : 0.6;
  if (state === 'stable') return 1;
  if (state === 'weakening') return fast ? 1.7 : 1.4;
  return fast ? 2.8 : 2.2;
}

function setupQuality(input: WatchScoreInput, chips: string[]): number {
  let s = 18;
  const dist = levelDistancePct(input);
  if (input.nearMultiTfSupport === true || input.nearKeyFib === true) {
    s += 28;
    chips.push(input.nearKeyFib ? 'near Fib' : 'near MTF S');
  } else if (input.nearSupport === true) {
    s += 18;
    chips.push('near S');
  }
  if (dist != null) {
    if (dist < 1) s += 22;
    else if (dist < 3) s += 14;
    else if (dist < 8) s += 6;
    else s -= Math.min(18, dist);
  }
  const conf = fin(input.confluenceCount);
  if (conf != null && conf > 0) s += Math.min(24, conf * 8);
  const sr = fin(input.srConfluenceScore);
  if (sr != null && sr > 0) s += Math.min(16, sr / 6);
  const dna = fin(input.dnaHits);
  if (dna != null && dna > 0) s += Math.min(24, dna * 6);
  const curve = fin(input.curveProgressPct);
  if (curve != null) {
    if (curve >= 88 && curve < 100) {
      s += 28;
      chips.push('fire band');
    } else if (curve >= 70) {
      s += 14;
      chips.push('curve watch');
    }
  }
  const drop = fin(input.dropFromPeakPct);
  if (drop != null && drop >= 8 && drop <= 40) s += 10;
  return clamp(s, 0, 100);
}

function timingScore(input: WatchScoreInput, now: number, chips: string[]): number {
  const created = fin(input.createdAt) ?? now;
  const ageMin = Math.max(0, (now - created) / 60_000);
  let s = clamp(36 * Math.exp(-ageMin / 25), 4, 36);
  const improved = fin(input.lastImprovementAt);
  if (improved != null) {
    const since = (now - improved) / 60_000;
    if (since < 3) s += 22;
    else if (since < 8) s += 10;
  }
  const curve = fin(input.curveProgressPct);
  if (curve != null && curve >= 88 && curve < 100) s += 18;
  if (input.status === 'armed') s += 8;
  if (ageMin > 90) {
    s -= 12;
    chips.push('stale');
  }
  return clamp(s, 0, 100);
}

function activityScore(
  input: WatchScoreInput,
  volState: WatchVolumeUiState,
  vol01: number,
  chips: string[]
): number {
  let s = vol01 * 70;
  if (volState === 'expanding') {
    s += 18;
    chips.push('vol↑');
  } else if (volState === 'stable') {
    chips.push('vol ok');
  } else if (volState === 'weakening') {
    s -= 10;
    chips.push('vol↓');
  } else {
    s -= 28;
    chips.push('dead vol');
  }
  const hg = fin(input.holderGrowthPct);
  if (hg != null && hg > 0) s += Math.min(12, hg);
  const press = fin(input.buyPressureUsd);
  if (press != null && press >= 400) s += 8;
  if (input.movementActive === true) s += 8;
  if (input.movementActive === false) s -= 16;
  return clamp(s, 0, 100);
}

function riskPenalty(input: WatchScoreInput, volState: WatchVolumeUiState, chips: string[]): number {
  let p = 0;
  const ext = fin(input.extensionFromLevelPct);
  const late =
    input.lateChase === true || (ext != null && ext >= 8);
  if (late) {
    p += 70;
    chips.push('late-chase');
  }
  if (volState === 'collapsed') p += 36;
  else if (volState === 'weakening') p += 12;
  if (input.movementActive === false) p += 22;
  const liq = fin(input.liquidityUsd);
  if (liq != null && liq > 0 && liq < 8_000) p += 10;
  const top10 = fin(input.top10HoldPct);
  if (top10 != null && top10 > 48) p += 8;
  return clamp(p, 0, 100);
}

export function computeWatchScore(
  input: WatchScoreInput,
  now = Date.now()
): WatchScoreResult {
  const pid = String(input.profileId || 'dip_buyer');
  const chips: string[] = [];
  let volState: WatchVolumeUiState = 'stable';
  let vol01 = 0.45;
  try {
    const snap = evaluateVolumeIntelligence({
      volumeM5Usd: input.volumeM5Usd,
      volumeH1Usd: input.volumeH1Usd,
      priceChangePct: input.dropFromPeakPct != null ? -Number(input.dropFromPeakPct) : null,
      profileId: pid,
    });
    volState = volumeUiState(snap.decayState, pid);
    vol01 = snap.score01;
  } catch {
    /* optional */
  }

  const w = weightsFor(pid);
  const setup = setupQuality(input, chips);
  const timing = timingScore(input, now, chips);
  const activity = activityScore(input, volState, vol01, chips);
  const risk = riskPenalty(input, volState, chips);
  let raw = setup * w.setup + timing * w.timing + activity * w.activity - risk * w.risk;
  raw = clamp(raw, 0, 100);

  const dist = levelDistancePct(input);
  const conf = fin(input.confluenceCount);
  const improved =
    input.status === 'armed' && (fin(input.armedAt) ?? 0) > (fin(input.lastImprovementAt) ?? 0) - 1
      ? true
      : (dist != null &&
          input.prevLevelDistancePct != null &&
          dist + 0.15 < input.prevLevelDistancePct) ||
        (conf != null &&
          input.prevConfluenceCount != null &&
          conf > input.prevConfluenceCount) ||
        (volState === 'expanding' && input.prevVolumeState !== 'expanding');

  const lastImp = improved ? now : (fin(input.lastImprovementAt) ?? fin(input.createdAt) ?? now);
  const idle = now - lastImp;
  const grace = graceMsFor(pid);
  const volMult = volumeDecayMultiplier(volState, pid);
  let decay = 0;
  if (idle > grace) {
    const mins = (idle - grace) / 60_000;
    const late =
      input.lateChase === true ||
      (fin(input.extensionFromLevelPct) != null &&
        Number(input.extensionFromLevelPct) >= 8);
    decay = mins * decayPerMinFor(pid) * volMult * (late ? 1.8 : 1);
    if (decay >= 8) chips.push(volState === 'collapsed' ? 'stagnant' : 'decaying');
  }
  const score = clamp(raw - decay, WATCH_SCORE_FLOOR, 100);
  return {
    score,
    breakdown: {
      setup: Math.round(setup),
      timing: Math.round(timing),
      activity: Math.round(activity),
      risk: Math.round(risk),
      decay: Math.round(decay),
    },
    volumeState: volState,
    decayMultiplier: volMult,
    chips: [...new Set(chips)].slice(0, 5),
    improved,
    lastImprovementAt: lastImp,
    atFloor: score <= WATCH_SCORE_FLOOR + 0.5,
  };
}

export function stampWatchPriority<T extends WatchPriorityFields>(
  profileId: string,
  row: T,
  extra: Omit<WatchScoreInput, 'profileId'> = {},
  now = Date.now()
): WatchScoreResult {
  const prevVol = row.volumeState != null ? String(row.volumeState) : null;
  const r = computeWatchScore(
    {
      profileId,
      lastImprovementAt: row.lastImprovementAt,
      prevLevelDistancePct: row.prevLevelDistancePct,
      prevConfluenceCount: row.prevConfluenceCount,
      prevVolumeState: prevVol,
      ...extra,
    },
    now
  );
  const dist = levelDistancePct({ ...extra, profileId });
  row.watchScore = Math.round(r.score);
  row.watchScoreBreakdown = r.breakdown;
  row.volumeState = r.volumeState;
  row.decayMultiplier = r.decayMultiplier;
  row.watchScoreChips = r.chips;
  row.lastImprovementAt = r.lastImprovementAt;
  row.prevLevelDistancePct = dist;
  if (extra.confluenceCount != null) {
    row.prevConfluenceCount = Number(extra.confluenceCount);
  }
  if (r.atFloor) {
    if (row.scoreAtFloorSince == null) row.scoreAtFloorSince = now;
  } else {
    row.scoreAtFloorSince = null;
  }
  try {
    const { noteWatchScoreDiagnostics } =
      require('./watchPipeline') as typeof import('./watchPipeline');
    noteWatchScoreDiagnostics({
      profileId,
      score: r.score,
      improved: r.improved,
      volumeState: r.volumeState,
      decayed: r.breakdown.decay > 0,
      savedByVolume: r.volumeState === 'expanding' && r.breakdown.decay > 0 && r.decayMultiplier < 1,
    });
  } catch {
    /* optional */
  }
  return r;
}

export function sortActiveWatchesByScore<
  T extends WatchPriorityFields & { status?: string; createdAt?: number },
>(rows: T[]): T[] {
  const active = rows.filter(
    (w) => w.status === 'watching' || w.status === 'armed'
  );
  active.sort((a, b) => {
    const ds = (b.watchScore ?? 0) - (a.watchScore ?? 0);
    if (ds !== 0) return ds;
    return (b.createdAt ?? 0) - (a.createdAt ?? 0);
  });
  active.forEach((w, i) => {
    w.watchRank = i + 1;
  });
  return active;
}

export function countArmedWatches(
  rows: Iterable<{ status?: string }>
): number {
  let n = 0;
  for (const w of rows) {
    if (w.status === 'armed') n += 1;
  }
  return n;
}

export function countArmedWatchesForProfile(
  rows: Iterable<{ status?: string; preferredProfileId?: string }>,
  profileId: string
): number {
  const pid = String(profileId || '');
  let n = 0;
  for (const w of rows) {
    if (w.status !== 'armed') continue;
    if (String(w.preferredProfileId || pid) === pid) n += 1;
  }
  return n;
}

export function shouldSkipArmForCap(
  profileId: string,
  armedCount: number
): boolean {
  return armedCount >= getMaxArmedWatches(profileId);
}

/** Keep only the top-K armed rows per profile (ordered desc by score). */
export function demoteArmedBeyondCap<
  T extends WatchPriorityFields & {
    status?: string;
    preferredProfileId?: string;
    lastReason?: string;
    updatedAt?: number;
    armedAt?: number | null;
  },
>(ordered: T[], fallbackProfileId: string, now = Date.now()): number {
  const byPid = new Map<string, T[]>();
  for (const w of ordered) {
    if (w.status !== 'armed') continue;
    const pid = String(w.preferredProfileId || fallbackProfileId);
    const list = byPid.get(pid) || [];
    list.push(w);
    byPid.set(pid, list);
  }
  let n = 0;
  for (const [pid, list] of byPid) {
    const max = getMaxArmedWatches(pid);
    if (list.length <= max) continue;
    for (const w of list.slice(max)) {
      w.status = 'watching';
      w.armedAt = null;
      w.lastReason = 'demoted_from_armed';
      w.updatedAt = now;
      n += 1;
    }
  }
  if (n > 0) {
    try {
      const { noteDemotedFromArmed } =
        require('./watchPipeline') as typeof import('./watchPipeline');
      for (let i = 0; i < n; i++) noteDemotedFromArmed();
    } catch {
      /* optional */
    }
  }
  return n;
}

export type WatchLifecycleAction =
  | 'ok'
  | 'demote'
  | 'expire_stagnant'
  | 'expire_volume';

export function watchLifecycleAction(
  row: WatchPriorityFields & { status?: string },
  profileId: string,
  now = Date.now()
): WatchLifecycleAction {
  const score = Number(row.watchScore);
  const vol = String(row.volumeState || '');
  const armed = row.status === 'armed';
  if (armed && (vol === 'collapsed' || (Number.isFinite(score) && score < WATCH_ARM_SCORE_FLOOR))) {
    return 'demote';
  }
  const floorSince = row.scoreAtFloorSince;
  if (
    floorSince != null &&
    now - floorSince >= FLOOR_EXPIRE_MS &&
    Number.isFinite(score) &&
    score <= WATCH_SCORE_FLOOR + 1
  ) {
    return vol === 'collapsed' ? 'expire_volume' : 'expire_stagnant';
  }
  return 'ok';
}

export function isLateChaseBlocked(input: {
  lateChase?: boolean | null;
  extensionFromLevelPct?: number | null;
}): boolean {
  if (input.lateChase === true) return true;
  const ext = Number(input.extensionFromLevelPct);
  return Number.isFinite(ext) && ext >= 8;
}
