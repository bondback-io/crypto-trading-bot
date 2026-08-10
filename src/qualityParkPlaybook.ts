/**
 * Steady / HWR medium-major quality park playbooks (1.2.263).
 * Movement gate + arm eligibility — not Dip-minor Fib/S DNA.
 */

import { DEFAULT_HWR_QUALITY_FILTER } from './hwrQualityFilter';

/** Mirror majorsUniverse floors — avoid circular import. */
const MEDIUM_MIN_MC_USD = 50_000_000;
const MAJORS_MIN_MC_USD = 200_000_000;
const MEDIUM_MIN_VOL_H1_USD = 12_000;
const MAJORS_MIN_VOL_H1_USD = 20_000;
const MAJORS_MIN_LIQ_USD = 40_000;

/** Arm / trigger tags */
export const STEADY_STRUCTURE_ARM = 'steady_structure_arm';
export const STEADY_RECLAIM_TRIGGER = 'steady_reclaim_trigger';
export const HWR_QUALITY_ARM = 'hwr_quality_arm';
export const HWR_RECLAIM_TRIGGER = 'hwr_reclaim_trigger';

/** Movement thresholds (module constants — no new UI knobs). */
export const QUALITY_MIN_RANGE_24H_PCT = 3;
export const QUALITY_MIN_SWING_H1_PCT = 1.2;
export const QUALITY_MIN_SWING_H6_PCT = 2;
export const QUALITY_DEAD_RANGE_MS = 50 * 60_000;
export const QUALITY_MIN_VOL_ALIVE_MULT = 1.0;
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
  | 'late_chase';

export type QualityParkProfileId = 'steady_compounder' | 'high_win_rate';

export type QualityMovementChip =
  | 'active'
  | 'low_movement'
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
  },
  high_win_rate: {
    candidates_seen: 0,
    armed: 0,
    triggered: 0,
    opened: 0,
    expired: 0,
    rotated_stale: 0,
    low_movement: 0,
  },
};

const deadTapeSince = new Map<string, number>();

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
  now = Date.now()
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
  return {
    rotate: deadForMs >= QUALITY_DEAD_RANGE_MS,
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
): { active: boolean; reason: string; score: number } {
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

  if (knownTiny && deadVol) {
    return {
      active: false,
      reason: `low_movement range=${range?.toFixed(1) ?? '?'}% h1=${h1?.toFixed(1) ?? '?'}%`,
      score: 0,
    };
  }
  if (knownTiny && !volOk) {
    return {
      active: false,
      reason: `low_movement range=${range?.toFixed(1) ?? '?'}%`,
      score: Math.min(range ?? 0, 2),
    };
  }

  const active = rangeOk || swingOk || atrOk || (volOk && !knownTiny);
  if (!active && range == null && h1 == null && h6 == null) {
    return { active: true, reason: 'movement_unknown_pass', score: 1 };
  }
  if (!active) {
    return { active: false, reason: 'low_movement', score: 0 };
  }
  const score =
    (range ?? 0) +
    (h1 ?? 0) * 1.5 +
    (h6 ?? 0) +
    Math.min((vol ?? 0) / 50_000, 8);
  return { active: true, reason: 'active', score };
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
  movementActive: boolean
): QualityParkEvalResult {
  const chip: QualityMovementChip = movementActive ? 'active' : 'low_movement';
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
  if (!Number.isFinite(mc) || mc < MEDIUM_MIN_MC_USD) {
    noteQualityParkDeny('steady_compounder', 'mc_band');
    return {
      ok: false,
      profileId: 'steady_compounder',
      armTag: null,
      denyKey: 'mc_band',
      reason: 'MC below medium band',
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
  const vol = Number(input.volumeH1Usd);
  if (Number.isFinite(vol) && vol > 0 && vol < volFloor) {
    noteQualityParkDeny('steady_compounder', 'vol');
    return {
      ok: false,
      profileId: 'steady_compounder',
      armTag: null,
      denyKey: 'vol',
      reason: `volH1 $${Math.round(vol)} < $${volFloor}`,
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
    chip: 'active',
    softArmOk: true,
  };
}

function evaluateHwrArm(
  input: QualityParkEvalInput,
  movementActive: boolean
): QualityParkEvalResult {
  const chip: QualityMovementChip = movementActive ? 'active' : 'low_movement';
  const qf = DEFAULT_HWR_QUALITY_FILTER;
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
  if (!Number.isFinite(mc) || mc < MEDIUM_MIN_MC_USD) {
    noteQualityParkDeny('high_win_rate', 'mc_band');
    return {
      ok: false,
      profileId: 'high_win_rate',
      armTag: null,
      denyKey: 'mc_band',
      reason: 'MC below medium band',
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
    noteQualityParkDeny('high_win_rate', 'low_movement');
    noteQualityParkFunnel('high_win_rate', 'low_movement');
    return {
      ok: false,
      profileId: 'high_win_rate',
      armTag: null,
      denyKey: 'low_movement',
      reason: 'low movement / dead tape',
      movementActive: false,
      chip: 'low_movement',
      softArmOk: false,
    };
  }
  if (!hasQualityStructure(input)) {
    noteQualityParkDeny('high_win_rate', 'no_level');
    return {
      ok: false,
      profileId: 'high_win_rate',
      armTag: null,
      denyKey: 'no_level',
      reason: 'no structure level',
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
    noteQualityParkDeny('high_win_rate', 'liq');
    return {
      ok: false,
      profileId: 'high_win_rate',
      armTag: null,
      denyKey: 'liq',
      reason: `HWR liq $${Math.round(liq)} low`,
      movementActive,
      chip,
      softArmOk: false,
    };
  }
  const vol = Number(input.volumeH1Usd);
  if (Number.isFinite(vol) && vol > 0 && vol < qf.minVolumeH1Usd) {
    noteQualityParkDeny('high_win_rate', 'vol');
    return {
      ok: false,
      profileId: 'high_win_rate',
      armTag: null,
      denyKey: 'vol',
      reason: `HWR volH1 $${Math.round(vol)} < $${qf.minVolumeH1Usd}`,
      movementActive,
      chip,
      softArmOk: false,
    };
  }
  const holders = Number(input.holderCount);
  if (Number.isFinite(holders) && holders > 0 && holders < qf.minHolders) {
    noteQualityParkDeny('high_win_rate', 'safety');
    return {
      ok: false,
      profileId: 'high_win_rate',
      armTag: null,
      denyKey: 'safety',
      reason: `holders ${holders} < ${qf.minHolders}`,
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
    chip: 'active',
    softArmOk: false,
  };
}

export function evaluateQualityParkArm(
  input: QualityParkEvalInput
): QualityParkEvalResult {
  const band =
    String(input.source || '').toLowerCase() === 'majors' ? 'majors' : 'medium';
  const mov2 = evaluateQualityMovement(input.movement, {
    watchBand: band,
    volumeFloorUsd: steadyVolFloor(input.source),
  });

  const hwr = evaluateHwrArm(input, mov2.active);
  if (hwr.ok) return hwr;

  const steady = evaluateSteadyArm(input, mov2.active);
  if (steady.ok) return steady;

  if (!mov2.active) {
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
