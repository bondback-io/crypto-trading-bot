/**
 * Steady / HWR medium-major quality park playbooks (1.2.263).
 * Movement gate + arm eligibility — not Dip-minor Fib/S DNA.
 */

import { DEFAULT_HWR_QUALITY_FILTER } from './hwrQualityFilter';

/** Mirror majorsUniverse floors — avoid circular import. */
const MEDIUM_MIN_MC_USD = 20_000_000;
const MAJORS_MIN_MC_USD = 200_000_000;
const MEDIUM_MIN_VOL_H1_USD = 12_000;
const MAJORS_MIN_VOL_H1_USD = 20_000;
const MAJORS_MIN_LIQ_USD = 40_000;

/** Exclusive watch bands (catalog match knobs may override). */
export const STEADY_WATCH_MIN_MC_USD = 20_000_000;
export const STEADY_WATCH_MAX_MC_USD = 150_000_000;
export const HWR_WATCH_MIN_MC_USD = 80_000_000;
export const HWR_WATCH_MAX_MC_USD = 500_000_000;
export const QUALITY_DUMP_RECLAIM_DROP_PCT = 8;

/** Arm / trigger tags */
export const STEADY_STRUCTURE_ARM = 'steady_structure_arm';
export const STEADY_RECLAIM_TRIGGER = 'steady_reclaim_trigger';
export const HWR_QUALITY_ARM = 'hwr_quality_arm';
export const HWR_RECLAIM_TRIGGER = 'hwr_reclaim_trigger';

/** Movement thresholds (module constants — no new UI knobs). */
export const QUALITY_MIN_RANGE_24H_PCT = 2.5;
export const QUALITY_MIN_SWING_H1_PCT = 1.0;
export const QUALITY_MIN_SWING_H6_PCT = 1.75;
export const QUALITY_DEAD_RANGE_MS = 50 * 60_000;
/** Medium dead-tape rotates sooner so Steady inventory stays hot */
export const QUALITY_DEAD_RANGE_MEDIUM_MS = 40 * 60_000;
export const QUALITY_MIN_VOL_ALIVE_MULT = 0.9;
/** Soft-movement tier (1.2.268): below hard floor but not dead tape */
export const QUALITY_SOFT_RANGE_24H_PCT = 1.5;
export const QUALITY_SOFT_SWING_H1_PCT = 0.7;
export const QUALITY_SOFT_ARM_CAP = 3;
export const QUALITY_SOFT_ARM_SIZE_MULT = 0.85;
/** Soft HWR rank boost above this MC */
export const HWR_PREFER_MC_USD = 100_000_000;

export type QualityParkDenyKey =
  | 'no_level'
  | 'low_movement'
  | 'liq'
  | 'vol'
  | 'mc_band'
  | 'soft_allow_preview'
  | 'confluence'
  | 'safety'
  | 'late_chase'
  | 'hwr_mc_band'
  | 'hwr_low_movement'
  | 'hwr_low_liquidity'
  | 'hwr_no_structure'
  | 'hwr_holder_risk'
  | 'hwr_asset_proxy_excluded';

export type QualityParkProfileId = 'steady_compounder' | 'high_win_rate';

export type QualityMovementChip =
  | 'active'
  | 'low_movement'
  | 'soft_movement'
  | 'no_level'
  | 'soft_allow_denied'
  | 'rotated_stale';

export interface QualityMovementSnapshot {
  priceChange24hPct?: number | null;
  priceChangeH1Pct?: number | null;
  priceChangeH6Pct?: number | null;
  range24hPct?: number | null;
  volumeH1Usd?: number | null;
  atrPct?: number | null;
}

export interface QualityParkEvalInput {
  source?: string;
  marketCapUsd?: number | null;
  liquidityUsd?: number | null;
  volumeH1Usd?: number | null;
  holderCount?: number | null;
  supportPriceSol?: number | null;
  fib05PriceSol?: number | null;
  fib618PriceSol?: number | null;
  nearKeyFib?: boolean;
  nearSupport?: boolean;
  multiTfSupportHits?: number;
  taConfluence?: number | null;
  movement: QualityMovementSnapshot;
  softAllowDenied?: boolean | null;
  lateChase?: boolean;
  top10HoldPct?: number | null;
  tokenAgeHours?: number | null;
  dropFromPeakPct?: number | null;
  symbol?: string | null;
  name?: string | null;
}

export interface QualityParkEvalResult {
  ok: boolean;
  profileId: QualityParkProfileId | null;
  armTag: string | null;
  denyKey: QualityParkDenyKey | null;
  reason: string;
  movementActive: boolean;
  chip: QualityMovementChip;
  softArmOk: boolean;
  /** Soft-movement grant (size haircut + session cap) */
  softMovement?: boolean;
  sizeMult?: number;
}

type DenyBucket = Record<QualityParkDenyKey, number>;

const emptyDeny = (): DenyBucket => ({
  no_level: 0,
  low_movement: 0,
  liq: 0,
  vol: 0,
  mc_band: 0,
  soft_allow_preview: 0,
  confluence: 0,
  safety: 0,
  late_chase: 0,
  hwr_mc_band: 0,
  hwr_low_movement: 0,
  hwr_low_liquidity: 0,
  hwr_no_structure: 0,
  hwr_holder_risk: 0,
  hwr_asset_proxy_excluded: 0,
});

const denyByProfile: Record<QualityParkProfileId, DenyBucket> = {
  steady_compounder: emptyDeny(),
  high_win_rate: emptyDeny(),
};

const funnelByProfile = {
  steady_compounder: {
    candidates_seen: 0,
    armed: 0,
    triggered: 0,
    opened: 0,
    expired: 0,
    rotated_stale: 0,
    low_movement: 0,
    soft_movement: 0,
    insert_denied: 0,
    trigger_denied: 0,
  },
  high_win_rate: {
    candidates_seen: 0,
    armed: 0,
    triggered: 0,
    opened: 0,
    expired: 0,
    rotated_stale: 0,
    low_movement: 0,
    soft_movement: 0,
    insert_denied: 0,
    trigger_denied: 0,
  },
};

export type ExclusiveRouteReason =
  | 'routed_steady'
  | 'routed_hwr'
  | 'both_eligible_but_split'
  | 'rejected_both'
  | 'routed_dip_dump'
  | 'overlap';

export interface ExclusiveRouteResult {
  eligibleProfileIds: string[];
  preferredProfileId: string | null;
  reason: ExclusiveRouteReason;
}

const exclusiveRouteCounts: Record<ExclusiveRouteReason, number> = {
  routed_steady: 0,
  routed_hwr: 0,
  both_eligible_but_split: 0,
  rejected_both: 0,
  routed_dip_dump: 0,
  overlap: 0,
};

export function noteExclusiveRoute(reason: ExclusiveRouteReason, n = 1): void {
  exclusiveRouteCounts[reason] =
    (exclusiveRouteCounts[reason] || 0) + Math.max(1, Math.floor(n));
}

export function getExclusiveRouteCounts(): Record<ExclusiveRouteReason, number> {
  return { ...exclusiveRouteCounts };
}

const deadTapeSince = new Map<string, number>();
/** Concurrent soft-movement arms (Steady+HWR combined). */
const softArmedMints = new Set<string>();
let softMovementGrantCount = 0;

export function noteSoftMovementGrant(n = 1): void {
  softMovementGrantCount += Math.max(1, Math.floor(n));
}

export function getSoftMovementGrantCount(): number {
  return softMovementGrantCount;
}

export function countSoftMovementArms(): number {
  return softArmedMints.size;
}

export function canGrantSoftMovementArm(mint?: string | null): boolean {
  const key = String(mint || '').trim();
  if (key && softArmedMints.has(key)) return true;
  return softArmedMints.size < QUALITY_SOFT_ARM_CAP;
}

export function registerSoftMovementArm(mint: string | null | undefined): boolean {
  const key = String(mint || '').trim();
  if (!key) return false;
  if (softArmedMints.has(key)) return true;
  if (softArmedMints.size >= QUALITY_SOFT_ARM_CAP) return false;
  softArmedMints.add(key);
  return true;
}

export function releaseSoftMovementArm(mint: string | null | undefined): void {
  const key = String(mint || '').trim();
  if (!key) return;
  softArmedMints.delete(key);
}

export function noteQualityParkDeny(
  profileId: QualityParkProfileId,
  key: QualityParkDenyKey,
  n = 1
): void {
  denyByProfile[profileId][key] =
    (denyByProfile[profileId][key] || 0) + Math.max(1, Math.floor(n));
}

export function noteQualityParkFunnel(
  profileId: QualityParkProfileId,
  key: keyof (typeof funnelByProfile)['steady_compounder'],
  n = 1
): void {
  funnelByProfile[profileId][key] =
    (funnelByProfile[profileId][key] || 0) + Math.max(1, Math.floor(n));
}

export function getQualityParkDenyCounters(): Record<
  QualityParkProfileId,
  DenyBucket
> {
  return {
    steady_compounder: { ...denyByProfile.steady_compounder },
    high_win_rate: { ...denyByProfile.high_win_rate },
  };
}

export function getQualityParkFunnelCounters(): typeof funnelByProfile {
  return {
    steady_compounder: { ...funnelByProfile.steady_compounder },
    high_win_rate: { ...funnelByProfile.high_win_rate },
  };
}

export function clearDeadTapeStreak(mint: string): void {
  deadTapeSince.delete(String(mint || '').trim());
}

export function noteDeadTapeObservation(
  mint: string,
  isDead: boolean,
  now = Date.now(),
  opts?: { watchBand?: 'medium' | 'majors' }
): { rotate: boolean; deadForMs: number } {
  const key = String(mint || '').trim();
  if (!key) return { rotate: false, deadForMs: 0 };
  if (!isDead) {
    deadTapeSince.delete(key);
    return { rotate: false, deadForMs: 0 };
  }
  const prev = deadTapeSince.get(key);
  if (prev == null) {
    deadTapeSince.set(key, now);
    return { rotate: false, deadForMs: 0 };
  }
  const deadForMs = now - prev;
  const threshold =
    opts?.watchBand === 'medium'
      ? QUALITY_DEAD_RANGE_MEDIUM_MS
      : QUALITY_DEAD_RANGE_MS;
  return {
    rotate: deadForMs >= threshold,
    deadForMs,
  };
}

function isQualitySource(source?: string): boolean {
  const s = String(source || '').toLowerCase();
  return s === 'medium' || s === 'majors';
}

export function hasQualityStructure(input: {
  supportPriceSol?: number | null;
  fib05PriceSol?: number | null;
  fib618PriceSol?: number | null;
  nearKeyFib?: boolean;
  nearSupport?: boolean;
  multiTfSupportHits?: number;
}): boolean {
  if (input.nearKeyFib === true || input.nearSupport === true) return true;
  if (
    input.supportPriceSol != null &&
    Number.isFinite(input.supportPriceSol) &&
    input.supportPriceSol > 0
  ) {
    return true;
  }
  if (
    input.fib05PriceSol != null &&
    Number.isFinite(input.fib05PriceSol) &&
    input.fib05PriceSol > 0
  ) {
    return true;
  }
  if (
    input.fib618PriceSol != null &&
    Number.isFinite(input.fib618PriceSol) &&
    input.fib618PriceSol > 0
  ) {
    return true;
  }
  return (input.multiTfSupportHits ?? 0) > 0;
}

export function evaluateQualityMovement(
  movement: QualityMovementSnapshot,
  opts?: { watchBand?: 'medium' | 'majors'; volumeFloorUsd?: number }
): {
  active: boolean;
  softEligible: boolean;
  reason: string;
  score: number;
} {
  const volFloor =
    opts?.volumeFloorUsd ??
    (opts?.watchBand === 'majors'
      ? MAJORS_MIN_VOL_H1_USD
      : MEDIUM_MIN_VOL_H1_USD);
  const range =
    movement.range24hPct != null && Number.isFinite(movement.range24hPct)
      ? Math.abs(Number(movement.range24hPct))
      : movement.priceChange24hPct != null &&
          Number.isFinite(movement.priceChange24hPct)
        ? Math.abs(Number(movement.priceChange24hPct))
        : null;
  const h1 =
    movement.priceChangeH1Pct != null &&
    Number.isFinite(movement.priceChangeH1Pct)
      ? Math.abs(Number(movement.priceChangeH1Pct))
      : null;
  const h6 =
    movement.priceChangeH6Pct != null &&
    Number.isFinite(movement.priceChangeH6Pct)
      ? Math.abs(Number(movement.priceChangeH6Pct))
      : null;
  const vol =
    movement.volumeH1Usd != null && Number.isFinite(movement.volumeH1Usd)
      ? Number(movement.volumeH1Usd)
      : null;
  const atr =
    movement.atrPct != null && Number.isFinite(movement.atrPct)
      ? Math.abs(Number(movement.atrPct))
      : null;

  const rangeOk = range != null && range >= QUALITY_MIN_RANGE_24H_PCT;
  const swingOk =
    (h1 != null && h1 >= QUALITY_MIN_SWING_H1_PCT) ||
    (h6 != null && h6 >= QUALITY_MIN_SWING_H6_PCT);
  const volOk = vol != null && vol >= volFloor * QUALITY_MIN_VOL_ALIVE_MULT;
  const atrOk = atr != null && atr >= QUALITY_MIN_SWING_H1_PCT;

  const knownTiny =
    range != null &&
    range < QUALITY_MIN_RANGE_24H_PCT &&
    (h1 == null || h1 < QUALITY_MIN_SWING_H1_PCT) &&
    (h6 == null || h6 < QUALITY_MIN_SWING_H6_PCT);
  const deadVol = vol == null || vol < volFloor * QUALITY_MIN_VOL_ALIVE_MULT;
  const softRangeOk =
    range != null && range >= QUALITY_SOFT_RANGE_24H_PCT;
  const softSwingOk = h1 != null && h1 >= QUALITY_SOFT_SWING_H1_PCT;
  // Soft tier: vol alive + mild range/H1, never knownTiny+deadVol
  const softEligible =
    volOk &&
    !(knownTiny && deadVol) &&
    (softRangeOk || softSwingOk);

  if (knownTiny && deadVol) {
    return {
      active: false,
      softEligible: false,
      reason: `low_movement range=${range?.toFixed(1) ?? '?'}% h1=${h1?.toFixed(1) ?? '?'}%`,
      score: 0,
    };
  }
  if (knownTiny && !volOk) {
    return {
      active: false,
      softEligible: false,
      reason: `low_movement range=${range?.toFixed(1) ?? '?'}%`,
      score: Math.min(range ?? 0, 2),
    };
  }

  const active = rangeOk || swingOk || atrOk || (volOk && !knownTiny);
  if (!active && range == null && h1 == null && h6 == null) {
    return {
      active: true,
      softEligible: false,
      reason: 'movement_unknown_pass',
      score: 1,
    };
  }
  if (!active) {
    return {
      active: false,
      softEligible,
      reason: softEligible ? 'soft_movement' : 'low_movement',
      score: softEligible ? Math.min((range ?? 0) + (h1 ?? 0), 3) : 0,
    };
  }
  const score =
    (range ?? 0) +
    (h1 ?? 0) * 1.5 +
    (h6 ?? 0) +
    Math.min((vol ?? 0) / 50_000, 8);
  return { active: true, softEligible: false, reason: 'active', score };
}

export function qualityMovementRankScore(
  movement: QualityMovementSnapshot,
  watchBand?: 'medium' | 'majors'
): number {
  return evaluateQualityMovement(movement, { watchBand }).score;
}

export function movementFromJupiterToken(token: {
  stats1h?: { priceChange?: number } | null;
  stats6h?: { priceChange?: number } | null;
  stats24h?: { priceChange?: number } | null;
  volumeH1Usd?: number | null;
}): QualityMovementSnapshot {
  const pc1 = Number(token.stats1h?.priceChange);
  const pc6 = Number(token.stats6h?.priceChange);
  const pc24 = Number(token.stats24h?.priceChange);
  return {
    priceChangeH1Pct: Number.isFinite(pc1) ? pc1 : null,
    priceChangeH6Pct: Number.isFinite(pc6) ? pc6 : null,
    priceChange24hPct: Number.isFinite(pc24) ? pc24 : null,
    range24hPct: Number.isFinite(pc24) ? Math.abs(pc24) : null,
    volumeH1Usd:
      token.volumeH1Usd != null && Number.isFinite(token.volumeH1Usd)
        ? Number(token.volumeH1Usd)
        : null,
  };
}

function steadyVolFloor(source?: string): number {
  return String(source || '').toLowerCase() === 'majors'
    ? MAJORS_MIN_VOL_H1_USD
    : MEDIUM_MIN_VOL_H1_USD;
}

function evaluateSteadyArm(
  input: QualityParkEvalInput,
  movementActive: boolean,
  opts?: { softMovement?: boolean }
): QualityParkEvalResult {
  const softMovement = opts?.softMovement === true;
  const chip: QualityMovementChip = movementActive
    ? softMovement
      ? 'soft_movement'
      : 'active'
    : 'low_movement';
  if (!isQualitySource(input.source)) {
    return {
      ok: false,
      profileId: null,
      armTag: null,
      denyKey: 'mc_band',
      reason: 'not quality band',
      movementActive,
      chip: 'no_level',
      softArmOk: false,
    };
  }
  const mc = Number(input.marketCapUsd);
  if (!Number.isFinite(mc) || mc < STEADY_WATCH_MIN_MC_USD || mc > STEADY_WATCH_MAX_MC_USD) {
    noteQualityParkDeny('steady_compounder', 'mc_band');
    return {
      ok: false,
      profileId: 'steady_compounder',
      armTag: null,
      denyKey: 'mc_band',
      reason: 'MC outside Steady $20M–$150M watch band',
      movementActive,
      chip,
      softArmOk: false,
    };
  }
  if (input.lateChase) {
    noteQualityParkDeny('steady_compounder', 'late_chase');
    return {
      ok: false,
      profileId: 'steady_compounder',
      armTag: null,
      denyKey: 'late_chase',
      reason: 'late-chase forbidden',
      movementActive,
      chip,
      softArmOk: false,
    };
  }
  if (!movementActive) {
    noteQualityParkDeny('steady_compounder', 'low_movement');
    noteQualityParkFunnel('steady_compounder', 'low_movement');
    return {
      ok: false,
      profileId: 'steady_compounder',
      armTag: null,
      denyKey: 'low_movement',
      reason: 'low movement / dead tape',
      movementActive: false,
      chip: 'low_movement',
      softArmOk: false,
    };
  }
  if (!hasQualityStructure(input)) {
    noteQualityParkDeny('steady_compounder', 'no_level');
    return {
      ok: false,
      profileId: 'steady_compounder',
      armTag: null,
      denyKey: 'no_level',
      reason: 'no structure level',
      movementActive,
      chip: 'no_level',
      softArmOk: false,
    };
  }
  const liq = Number(input.liquidityUsd);
  if (Number.isFinite(liq) && liq > 0 && liq < MAJORS_MIN_LIQ_USD) {
    noteQualityParkDeny('steady_compounder', 'liq');
    return {
      ok: false,
      profileId: 'steady_compounder',
      armTag: null,
      denyKey: 'liq',
      reason: `liq $${Math.round(liq)} < $${MAJORS_MIN_LIQ_USD}`,
      movementActive,
      chip,
      softArmOk: false,
    };
  }
  const volFloor = steadyVolFloor(input.source);
  // Soft-movement uses same vol alive floor as softEligible (0.9×)
  const effectiveVolFloor = softMovement
    ? volFloor * QUALITY_MIN_VOL_ALIVE_MULT
    : volFloor;
  const vol = Number(input.volumeH1Usd);
  if (Number.isFinite(vol) && vol > 0 && vol < effectiveVolFloor) {
    noteQualityParkDeny('steady_compounder', 'vol');
    return {
      ok: false,
      profileId: 'steady_compounder',
      armTag: null,
      denyKey: 'vol',
      reason: `volH1 $${Math.round(vol)} < $${Math.round(effectiveVolFloor)}`,
      movementActive,
      chip,
      softArmOk: false,
    };
  }
  if (input.softAllowDenied === true) {
    noteQualityParkDeny('steady_compounder', 'soft_allow_preview');
    return {
      ok: false,
      profileId: 'steady_compounder',
      armTag: null,
      denyKey: 'soft_allow_preview',
      reason: 'soft-allow denied',
      movementActive,
      chip: 'soft_allow_denied',
      softArmOk: false,
    };
  }
  return {
    ok: true,
    profileId: 'steady_compounder',
    armTag: STEADY_STRUCTURE_ARM,
    denyKey: null,
    reason: STEADY_STRUCTURE_ARM,
    movementActive: true,
    chip: softMovement ? 'soft_movement' : 'active',
    softArmOk: true,
  };
}

function evaluateHwrArm(
  input: QualityParkEvalInput,
  movementActive: boolean,
  opts?: { softMovement?: boolean }
): QualityParkEvalResult {
  const softMovement = opts?.softMovement === true;
  const chip: QualityMovementChip = movementActive
    ? softMovement
      ? 'soft_movement'
      : 'active'
    : 'low_movement';
  const qf = DEFAULT_HWR_QUALITY_FILTER;
  const band = readWatchBand('high_win_rate');
  const mc = Number(input.marketCapUsd);
  const inBand =
    Number.isFinite(mc) && mc >= band.min && mc <= band.max;
  if (!isQualitySource(input.source) && !inBand) {
    return {
      ok: false,
      profileId: null,
      armTag: null,
      denyKey: 'mc_band',
      reason: 'not quality band',
      movementActive,
      chip: 'no_level',
      softArmOk: false,
    };
  }
  if (!inBand) {
    noteQualityParkDeny('high_win_rate', 'hwr_mc_band');
    return {
      ok: false,
      profileId: 'high_win_rate',
      armTag: null,
      denyKey: 'hwr_mc_band',
      reason: 'MC outside HWR $80M–$500M watch band',
      movementActive,
      chip,
      softArmOk: false,
    };
  }
  if (input.lateChase) {
    noteQualityParkDeny('high_win_rate', 'late_chase');
    return {
      ok: false,
      profileId: 'high_win_rate',
      armTag: null,
      denyKey: 'late_chase',
      reason: 'late-chase forbidden',
      movementActive,
      chip,
      softArmOk: false,
    };
  }
  if (!movementActive) {
    noteQualityParkDeny('high_win_rate', 'hwr_low_movement');
    noteQualityParkFunnel('high_win_rate', 'low_movement');
    return {
      ok: false,
      profileId: 'high_win_rate',
      armTag: null,
      denyKey: 'hwr_low_movement',
      reason: 'HWR low movement / dead tape',
      movementActive: false,
      chip: 'low_movement',
      softArmOk: false,
    };
  }
  if (!hasQualityStructure(input)) {
    noteQualityParkDeny('high_win_rate', 'hwr_no_structure');
    return {
      ok: false,
      profileId: 'high_win_rate',
      armTag: null,
      denyKey: 'hwr_no_structure',
      reason: 'HWR no structure level',
      movementActive,
      chip: 'no_level',
      softArmOk: false,
    };
  }
  const liq = Number(input.liquidityUsd);
  if (
    Number.isFinite(liq) &&
    liq > 0 &&
    liq < Math.max(qf.minLiquidityUsd, MAJORS_MIN_LIQ_USD)
  ) {
    noteQualityParkDeny('high_win_rate', 'hwr_low_liquidity');
    return {
      ok: false,
      profileId: 'high_win_rate',
      armTag: null,
      denyKey: 'hwr_low_liquidity',
      reason: `HWR liq $${Math.round(liq)} low`,
      movementActive,
      chip,
      softArmOk: false,
    };
  }
  const vol = Number(input.volumeH1Usd);
  const hwrVolFloor = softMovement
    ? qf.minVolumeH1Usd * QUALITY_MIN_VOL_ALIVE_MULT
    : qf.minVolumeH1Usd;
  if (Number.isFinite(vol) && vol > 0 && vol < hwrVolFloor) {
    noteQualityParkDeny('high_win_rate', 'vol');
    return {
      ok: false,
      profileId: 'high_win_rate',
      armTag: null,
      denyKey: 'vol',
      reason: `HWR volH1 $${Math.round(vol)} < $${Math.round(hwrVolFloor)}`,
      movementActive,
      chip,
      softArmOk: false,
    };
  }
  const holders = Number(input.holderCount);
  if (Number.isFinite(holders) && holders > 0 && holders < qf.minHolders) {
    noteQualityParkDeny('high_win_rate', 'hwr_holder_risk');
    return {
      ok: false,
      profileId: 'high_win_rate',
      armTag: null,
      denyKey: 'hwr_holder_risk',
      reason: `holders ${holders} < ${qf.minHolders}`,
      movementActive,
      chip,
      softArmOk: false,
    };
  }
  const top10 = Number(input.top10HoldPct);
  if (Number.isFinite(top10) && top10 > 32) {
    noteQualityParkDeny('high_win_rate', 'hwr_holder_risk');
    return {
      ok: false,
      profileId: 'high_win_rate',
      armTag: null,
      denyKey: 'hwr_holder_risk',
      reason: `top10 ${top10.toFixed(0)}% > 32%`,
      movementActive,
      chip,
      softArmOk: false,
    };
  }
  if (input.softAllowDenied === true) {
    noteQualityParkDeny('high_win_rate', 'soft_allow_preview');
    return {
      ok: false,
      profileId: 'high_win_rate',
      armTag: null,
      denyKey: 'soft_allow_preview',
      reason: 'soft-allow denied',
      movementActive,
      chip: 'soft_allow_denied',
      softArmOk: false,
    };
  }
  const nearBoth = input.nearKeyFib === true && input.nearSupport === true;
  const mtf = (input.multiTfSupportHits ?? 0) >= 2;
  const conf =
    input.taConfluence != null && Number.isFinite(input.taConfluence)
      ? Number(input.taConfluence)
      : null;
  const confOk = conf != null && conf >= 65;
  const nearEither = input.nearKeyFib === true || input.nearSupport === true;
  if (!nearBoth && !mtf && !confOk && !nearEither) {
    noteQualityParkDeny('high_win_rate', 'confluence');
    return {
      ok: false,
      profileId: 'high_win_rate',
      armTag: null,
      denyKey: 'confluence',
      reason: 'HWR needs near Fib/S or confluence',
      movementActive,
      chip: 'active',
      softArmOk: false,
    };
  }
  return {
    ok: true,
    profileId: 'high_win_rate',
    armTag: HWR_QUALITY_ARM,
    denyKey: null,
    reason: HWR_QUALITY_ARM,
    movementActive: true,
    chip: softMovement ? 'soft_movement' : 'active',
    softArmOk: false,
  };
}

export function evaluateQualityParkArm(
  input: QualityParkEvalInput & {
    mint?: string | null;
    exclusiveProfileId?: string | null;
  }
): QualityParkEvalResult {
  const band =
    String(input.source || '').toLowerCase() === 'majors' ? 'majors' : 'medium';
  const mov2 = evaluateQualityMovement(input.movement, {
    watchBand: band,
    volumeFloorUsd: steadyVolFloor(input.source),
  });

  const softCandidate =
    !mov2.active &&
    mov2.softEligible &&
    hasQualityStructure(input) &&
    canGrantSoftMovementArm(input.mint);
  const movementForArm = mov2.active || softCandidate;
  const softOpts = softCandidate ? { softMovement: true } : undefined;
  const exclusive = String(input.exclusiveProfileId || '').trim();

  const hwr = evaluateHwrArm(input, movementForArm, softOpts);
  const steady = evaluateSteadyArm(input, movementForArm, softOpts);

  const pick = (res: QualityParkEvalResult): QualityParkEvalResult => {
    if (res.ok && softCandidate) return applySoftMovementGrant(res, input.mint);
    return res;
  };

  if (exclusive === 'high_win_rate') return pick(hwr);
  if (exclusive === 'steady_compounder') return pick(steady);

  if (hwr.ok && steady.ok) {
    const winner = pickOverlapWinner(input);
    return pick(winner === 'high_win_rate' ? hwr : steady);
  }
  if (hwr.ok) return pick(hwr);
  if (steady.ok) return pick(steady);

  // Prefer the real deny (vol/liq/confluence) over generic low_movement
  if (!mov2.active) {
    const prefer = steady.denyKey && steady.denyKey !== 'low_movement'
      ? steady
      : hwr.denyKey && hwr.denyKey !== 'hwr_low_movement' && hwr.denyKey !== 'low_movement'
        ? hwr
        : null;
    if (prefer) return prefer;
    return {
      ok: false,
      profileId: 'steady_compounder',
      armTag: null,
      denyKey: 'low_movement',
      reason: mov2.reason,
      movementActive: false,
      chip: 'low_movement',
      softArmOk: false,
    };
  }
  return steady.denyKey ? steady : hwr;
}

function applySoftMovementGrant(
  base: QualityParkEvalResult,
  mint?: string | null
): QualityParkEvalResult {
  if (!base.ok || !base.profileId) return base;
  if (!canGrantSoftMovementArm(mint)) {
    noteQualityParkDeny(base.profileId, 'low_movement');
    noteQualityParkFunnel(base.profileId, 'low_movement');
    return {
      ...base,
      ok: false,
      armTag: null,
      denyKey: 'low_movement',
      reason: 'soft_movement_cap',
      movementActive: false,
      chip: 'low_movement',
      softArmOk: false,
      softMovement: false,
    };
  }
  // Slot reserved by caller on successful arm (dipSetupWatch.registerSoftMovementArm)
  return {
    ...base,
    movementActive: true,
    chip: 'soft_movement',
    softMovement: true,
    sizeMult: QUALITY_SOFT_ARM_SIZE_MULT,
    reason: `${base.reason} · soft_movement`,
  };
}

export function isQualityDumpReclaim(input: {
  dropFromPeakPct?: number | null;
  nearKeyFib?: boolean;
  nearSupport?: boolean;
}): boolean {
  const drop = Number(input.dropFromPeakPct);
  return (
    Number.isFinite(drop) &&
    drop >= QUALITY_DUMP_RECLAIM_DROP_PCT &&
    (input.nearKeyFib === true || input.nearSupport === true)
  );
}

function readWatchBand(
  profileId: 'steady_compounder' | 'high_win_rate'
): { min: number; max: number } {
  const fallback =
    profileId === 'high_win_rate'
      ? { min: HWR_WATCH_MIN_MC_USD, max: HWR_WATCH_MAX_MC_USD }
      : { min: STEADY_WATCH_MIN_MC_USD, max: STEADY_WATCH_MAX_MC_USD };
  try {
    const { resolveTradeProfileDefinition } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    const m = resolveTradeProfileDefinition(profileId).match;
    const min = Number(m?.preferMarketCapUsd ?? m?.minMarketCapUsd);
    const max = Number(m?.maxMarketCapUsd);
    return {
      min:
        profileId === 'high_win_rate'
          ? Number.isFinite(min) && min >= HWR_WATCH_MIN_MC_USD
            ? min
            : fallback.min
          : Number.isFinite(Number(m?.minMarketCapUsd)) &&
              Number(m?.minMarketCapUsd) >= STEADY_WATCH_MIN_MC_USD
            ? Number(m.minMarketCapUsd)
            : fallback.min,
      max: Number.isFinite(max) && max > 0 ? max : fallback.max,
    };
  } catch {
    return fallback;
  }
}

function overlapAllowed(): boolean {
  try {
    const { resolveTradeProfileDefinition } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    const s = resolveTradeProfileDefinition('steady_compounder').match
      ?.allowSteadyHwrOverlap;
    const h = resolveTradeProfileDefinition('high_win_rate').match
      ?.allowSteadyHwrOverlap;
    return s === true || h === true;
  } catch {
    return false;
  }
}

function nameExcluded(input: QualityParkEvalInput): boolean {
  try {
    const { classifyQualityParkNameExclusion } =
      require('./qualityParkNameExclusions') as typeof import('./qualityParkNameExclusions');
    return Boolean(
      classifyQualityParkNameExclusion(input.symbol, input.name)
    );
  } catch {
    return false;
  }
}

export function evaluateSteadyWatchElig(input: QualityParkEvalInput): {
  ok: boolean;
  denyKey: QualityParkDenyKey | null;
} {
  if (!isQualitySource(input.source)) {
    return { ok: false, denyKey: 'mc_band' };
  }
  const mc = Number(input.marketCapUsd);
  const band = readWatchBand('steady_compounder');
  if (!Number.isFinite(mc) || mc < band.min || mc > band.max) {
    noteQualityParkDeny('steady_compounder', 'mc_band');
    noteQualityParkFunnel('steady_compounder', 'insert_denied');
    return { ok: false, denyKey: 'mc_band' };
  }
  if (nameExcluded(input)) {
    noteQualityParkDeny('steady_compounder', 'safety');
    noteQualityParkFunnel('steady_compounder', 'insert_denied');
    return { ok: false, denyKey: 'safety' };
  }
  const mov = evaluateQualityMovement(input.movement, {
    watchBand:
      String(input.source || '').toLowerCase() === 'majors' ? 'majors' : 'medium',
    volumeFloorUsd: steadyVolFloor(input.source),
  });
  if (!mov.active && !mov.softEligible) {
    noteQualityParkDeny('steady_compounder', 'low_movement');
    noteQualityParkFunnel('steady_compounder', 'insert_denied');
    return { ok: false, denyKey: 'low_movement' };
  }
  return { ok: true, denyKey: null };
}

export function evaluateHwrWatchElig(input: QualityParkEvalInput): {
  ok: boolean;
  denyKey: QualityParkDenyKey | null;
} {
  const mc = Number(input.marketCapUsd);
  const band = readWatchBand('high_win_rate');
  if (!Number.isFinite(mc) || mc < band.min || mc > band.max) {
    noteQualityParkDeny('high_win_rate', 'hwr_mc_band');
    noteQualityParkFunnel('high_win_rate', 'insert_denied');
    return { ok: false, denyKey: 'hwr_mc_band' };
  }
  if (nameExcluded(input)) {
    noteQualityParkDeny('high_win_rate', 'hwr_asset_proxy_excluded');
    noteQualityParkFunnel('high_win_rate', 'insert_denied');
    return { ok: false, denyKey: 'hwr_asset_proxy_excluded' };
  }
  const liq = Number(input.liquidityUsd);
  if (
    Number.isFinite(liq) &&
    liq > 0 &&
    liq < Math.max(DEFAULT_HWR_QUALITY_FILTER.minLiquidityUsd, MAJORS_MIN_LIQ_USD)
  ) {
    noteQualityParkDeny('high_win_rate', 'hwr_low_liquidity');
    noteQualityParkFunnel('high_win_rate', 'insert_denied');
    return { ok: false, denyKey: 'hwr_low_liquidity' };
  }
  if (!hasQualityStructure(input)) {
    noteQualityParkDeny('high_win_rate', 'hwr_no_structure');
    noteQualityParkFunnel('high_win_rate', 'insert_denied');
    return { ok: false, denyKey: 'hwr_no_structure' };
  }
  const holders = Number(input.holderCount);
  const top10 = Number(input.top10HoldPct);
  if (
    (Number.isFinite(holders) &&
      holders > 0 &&
      holders < DEFAULT_HWR_QUALITY_FILTER.minHolders) ||
    (Number.isFinite(top10) && top10 > 32)
  ) {
    noteQualityParkDeny('high_win_rate', 'hwr_holder_risk');
    noteQualityParkFunnel('high_win_rate', 'insert_denied');
    return { ok: false, denyKey: 'hwr_holder_risk' };
  }
  return { ok: true, denyKey: null };
}

function pickOverlapWinner(
  input: QualityParkEvalInput
): QualityParkProfileId {
  try {
    const { computeWatchScore } =
      require('./watchPriorityScore') as typeof import('./watchPriorityScore');
    const base = {
      nearSupport: input.nearSupport,
      nearKeyFib: input.nearKeyFib,
      nearMultiTfSupport: (input.multiTfSupportHits ?? 0) >= 2,
      supportPriceSol: input.supportPriceSol,
      fib05PriceSol: input.fib05PriceSol,
      volumeH1Usd: input.volumeH1Usd,
      liquidityUsd: input.liquidityUsd,
      top10HoldPct: input.top10HoldPct,
      tokenAgeHours: input.tokenAgeHours,
      dropFromPeakPct: input.dropFromPeakPct,
      lateChase: input.lateChase,
      movementActive: true,
    };
    const s = computeWatchScore({ ...base, profileId: 'steady_compounder' }).score;
    const h = computeWatchScore({ ...base, profileId: 'high_win_rate' }).score;
    if (h > s) return 'high_win_rate';
    if (s > h) return 'steady_compounder';
  } catch {
    /* score optional */
  }
  const mc = Number(input.marketCapUsd);
  if (Number.isFinite(mc) && mc >= 100_000_000) return 'high_win_rate';
  return 'steady_compounder';
}

export function routeExclusiveQualityPark(input: QualityParkEvalInput & {
  inDipBand?: boolean;
  dumpReclaim?: boolean;
}): ExclusiveRouteResult {
  if (input.dumpReclaim === true && input.inDipBand === true) {
    noteExclusiveRoute('routed_dip_dump');
    return {
      eligibleProfileIds: ['dip_buyer'],
      preferredProfileId: 'dip_buyer',
      reason: 'routed_dip_dump',
    };
  }

  const steady = evaluateSteadyWatchElig(input);
  const hwr = evaluateHwrWatchElig(input);

  if (overlapAllowed() && (steady.ok || hwr.ok)) {
    noteExclusiveRoute('overlap');
    const ids: string[] = [];
    if (steady.ok) ids.push('steady_compounder');
    if (hwr.ok) ids.push('high_win_rate');
    return {
      eligibleProfileIds: ids,
      preferredProfileId: ids[0] || null,
      reason: 'overlap',
    };
  }

  if (steady.ok && !hwr.ok) {
    noteExclusiveRoute('routed_steady');
    return {
      eligibleProfileIds: ['steady_compounder'],
      preferredProfileId: 'steady_compounder',
      reason: 'routed_steady',
    };
  }
  if (hwr.ok && !steady.ok) {
    noteExclusiveRoute('routed_hwr');
    return {
      eligibleProfileIds: ['high_win_rate'],
      preferredProfileId: 'high_win_rate',
      reason: 'routed_hwr',
    };
  }
  if (steady.ok && hwr.ok) {
    const winner = pickOverlapWinner(input);
    noteExclusiveRoute('both_eligible_but_split');
    noteExclusiveRoute(winner === 'high_win_rate' ? 'routed_hwr' : 'routed_steady');
    return {
      eligibleProfileIds: [winner],
      preferredProfileId: winner,
      reason: 'both_eligible_but_split',
    };
  }
  noteExclusiveRoute('rejected_both');
  return {
    eligibleProfileIds: [],
    preferredProfileId: null,
    reason: 'rejected_both',
  };
}

export function resolveQualityParkPrefer(
  input: QualityParkEvalInput
): QualityParkProfileId {
  const active = evaluateQualityMovement(input.movement, {
    watchBand:
      String(input.source || '').toLowerCase() === 'majors'
        ? 'majors'
        : 'medium',
    volumeFloorUsd: steadyVolFloor(input.source),
  }).active;
  const hwr = evaluateHwrArm(input, active);
  if (hwr.ok) return 'high_win_rate';
  return 'steady_compounder';
}

export function triggerTagForProfile(
  profileId: string | null | undefined
): string {
  if (profileId === 'high_win_rate') return HWR_RECLAIM_TRIGGER;
  return STEADY_RECLAIM_TRIGGER;
}

export function topQualityParkDeny(
  profileId: QualityParkProfileId
): string | null {
  const b = denyByProfile[profileId];
  let best: { k: string; n: number } | null = null;
  for (const [k, n] of Object.entries(b)) {
    if (n <= 0) continue;
    if (!best || n > best.n) best = { k, n };
  }
  return best ? `${best.k}×${best.n}` : null;
}

export function hwrMcRankBoost(mc: number | null | undefined): number {
  if (mc == null || !Number.isFinite(mc)) return 0;
  if (Number(mc) >= MAJORS_MIN_MC_USD) return 30;
  if (Number(mc) >= HWR_PREFER_MC_USD) return 18;
  return 0;
}
