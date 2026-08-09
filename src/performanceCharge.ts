/**
 * Performance Charge — pure blend for Power Cell visuals (no trading side effects).
 * Weights: WR 35% · expectancy 20% · armed 20% · MFE capture 15% · late-chase 10%.
 * Fallback: craftScore (0–100) when EL blend inputs are too thin.
 */

export const TARGET_WR_PCT = 45;
export const TARGET_ARMED_SHARE = 0.7;
export const LATE_CHASE_SOFT_CAP = 0.05;

export const CHARGE_WEIGHTS = {
  wr: 0.35,
  expectancy: 0.2,
  armedShare: 0.2,
  mfeCapture: 0.15,
  lateChase: 0.1,
} as const;

export type PerformanceChargeBand =
  | 'critical'
  | 'weak'
  | 'charging'
  | 'strong'
  | 'max';

export interface PerformanceChargeInputs {
  winRate: number | null; // 0–1
  expectancyPct: number | null;
  armedShare: number | null; // 0–1
  mfeCapturePct: number | null; // 0–100
  lateChaseShare: number | null; // 0–1
  craftScore?: number | null;
  /** Attention share for this profile (0–1); combined uses scalper share. */
  attentionShare?: number | null;
  attentionCap?: number | null;
  quiet?: boolean;
  quietReason?: string;
  profileId?: string;
  name?: string;
  /** Prior charge for delta (e.g. early-half charge). */
  priorChargePct?: number | null;
}

export interface PerformanceChargeBreakdown {
  wrScore: number | null;
  expectancyScore: number | null;
  armedScore: number | null;
  mfeScore: number | null;
  lateChaseScore: number | null;
  craftFallback: number | null;
  usedCraftFallback: boolean;
  attentionPenalty: number;
  winRatePct: number | null;
  expectancyPct: number | null;
  armedSharePct: number | null;
  mfeCapturePct: number | null;
  lateChaseSharePct: number | null;
}

export interface PerformanceChargeResult {
  chargePct: number;
  band: PerformanceChargeBand;
  statusLabel: string;
  deltaPct: number | null;
  breakdown: PerformanceChargeBreakdown;
  targetWrMarker: typeof TARGET_WR_PCT;
  profileId?: string;
  name?: string;
  quiet?: boolean;
  capped?: boolean;
}

export interface PerformanceChargeBundle {
  combined: PerformanceChargeResult;
  profiles: PerformanceChargeResult[];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** WR vs 45% target: 20%→0, 45%→62.5, 60%→100. */
export function scoreWinRate(winRate: number | null): number | null {
  if (winRate == null || !Number.isFinite(winRate)) return null;
  const wrPct = winRate * 100;
  return clamp(((wrPct - 20) / 40) * 100, 0, 100);
}

/** Expectancy health: 0%→50, +2%→100, −2%→0. */
export function scoreExpectancy(expectancyPct: number | null): number | null {
  if (expectancyPct == null || !Number.isFinite(expectancyPct)) return null;
  return clamp(50 + expectancyPct * 25, 0, 100);
}

/** Armed share vs 70%: full score at target. */
export function scoreArmedShare(armedShare: number | null): number | null {
  if (armedShare == null || !Number.isFinite(armedShare)) return null;
  return clamp((armedShare / TARGET_ARMED_SHARE) * 100, 0, 100);
}

/** MFE capture already ~0–100. */
export function scoreMfeCapture(mfeCapturePct: number | null): number | null {
  if (mfeCapturePct == null || !Number.isFinite(mfeCapturePct)) return null;
  return clamp(mfeCapturePct, 0, 100);
}

/**
 * Late-chase component (higher = better): 0%→100, 5%→50, ≥10%→0.
 */
export function scoreLateChase(lateChaseShare: number | null): number | null {
  if (lateChaseShare == null || !Number.isFinite(lateChaseShare)) return null;
  return clamp(100 - (lateChaseShare / LATE_CHASE_SOFT_CAP) * 50, 0, 100);
}

/**
 * Penalty when attention share exceeds cap (up to 18 pts).
 */
export function attentionPenaltyPts(
  attentionShare: number | null | undefined,
  attentionCap: number | null | undefined
): number {
  if (
    attentionShare == null ||
    attentionCap == null ||
    !Number.isFinite(attentionShare) ||
    !Number.isFinite(attentionCap) ||
    attentionCap <= 0
  ) {
    return 0;
  }
  if (attentionShare <= attentionCap) return 0;
  const over = (attentionShare - attentionCap) / attentionCap;
  return clamp(over * 18, 0, 18);
}

export function bandFromCharge(chargePct: number): PerformanceChargeBand {
  if (chargePct >= 90) return 'max';
  if (chargePct >= 75) return 'strong';
  if (chargePct >= 50) return 'charging';
  if (chargePct >= 25) return 'weak';
  return 'critical';
}

export function statusLabelFor(opts: {
  chargePct: number;
  band: PerformanceChargeBand;
  deltaPct: number | null;
  quiet?: boolean;
  capped?: boolean;
}): string {
  if (opts.quiet) return 'Quiet';
  if (opts.capped) return 'Capped';
  const flat =
    opts.deltaPct == null || Math.abs(opts.deltaPct) < 0.75;
  if (flat && (opts.band === 'charging' || opts.band === 'strong')) {
    return 'Stable';
  }
  switch (opts.band) {
    case 'critical':
      return 'Critical';
    case 'weak':
      return 'Weak';
    case 'charging':
      return 'Charging';
    case 'strong':
      return 'Strong';
    case 'max':
      return 'Max';
    default:
      return 'Weak';
  }
}

function blendWeighted(
  parts: Array<{ score: number | null; weight: number }>
): { blended: number | null; weightSum: number } {
  let sum = 0;
  let wSum = 0;
  for (const p of parts) {
    if (p.score == null || !Number.isFinite(p.score) || p.weight <= 0) continue;
    sum += p.score * p.weight;
    wSum += p.weight;
  }
  if (wSum < 0.15) return { blended: null, weightSum: wSum };
  return { blended: sum / wSum, weightSum: wSum };
}

export function computePerformanceCharge(
  input: PerformanceChargeInputs
): PerformanceChargeResult {
  const wrScore = scoreWinRate(input.winRate);
  const expectancyScore = scoreExpectancy(input.expectancyPct);
  const armedScore = scoreArmedShare(input.armedShare);
  const mfeScore = scoreMfeCapture(input.mfeCapturePct);
  const lateChaseScore = scoreLateChase(input.lateChaseShare);
  const craftFallback =
    input.craftScore != null && Number.isFinite(input.craftScore)
      ? clamp(input.craftScore, 0, 100)
      : null;

  const { blended, weightSum } = blendWeighted([
    { score: wrScore, weight: CHARGE_WEIGHTS.wr },
    { score: expectancyScore, weight: CHARGE_WEIGHTS.expectancy },
    { score: armedScore, weight: CHARGE_WEIGHTS.armedShare },
    { score: mfeScore, weight: CHARGE_WEIGHTS.mfeCapture },
    { score: lateChaseScore, weight: CHARGE_WEIGHTS.lateChase },
  ]);

  const usedCraftFallback = blended == null;
  let charge =
    blended != null
      ? blended
      : craftFallback != null
        ? craftFallback
        : 0;

  // Soft confidence: thin EL weight sum pulls toward craft if available.
  if (
    blended != null &&
    craftFallback != null &&
    weightSum < 0.55 &&
    weightSum >= 0.15
  ) {
    const craftW = clamp(0.55 - weightSum, 0.1, 0.4);
    charge = (blended * weightSum + craftFallback * craftW) / (weightSum + craftW);
  }

  const penalty = attentionPenaltyPts(input.attentionShare, input.attentionCap);
  charge = clamp(charge - penalty, 0, 100);
  const chargePct = round1(charge);

  const deltaPct =
    input.priorChargePct != null && Number.isFinite(input.priorChargePct)
      ? round1(chargePct - input.priorChargePct)
      : null;

  const quiet = input.quiet === true;
  const capped = penalty > 0.5;
  const band = bandFromCharge(chargePct);
  const statusLabel = statusLabelFor({
    chargePct,
    band,
    deltaPct,
    quiet,
    capped,
  });

  return {
    chargePct,
    band,
    statusLabel,
    deltaPct,
    breakdown: {
      wrScore: wrScore != null ? round1(wrScore) : null,
      expectancyScore:
        expectancyScore != null ? round1(expectancyScore) : null,
      armedScore: armedScore != null ? round1(armedScore) : null,
      mfeScore: mfeScore != null ? round1(mfeScore) : null,
      lateChaseScore: lateChaseScore != null ? round1(lateChaseScore) : null,
      craftFallback: craftFallback != null ? round1(craftFallback) : null,
      usedCraftFallback,
      attentionPenalty: round1(penalty),
      winRatePct:
        input.winRate != null ? round1(input.winRate * 100) : null,
      expectancyPct:
        input.expectancyPct != null ? round1(input.expectancyPct) : null,
      armedSharePct:
        input.armedShare != null ? round1(input.armedShare * 100) : null,
      mfeCapturePct:
        input.mfeCapturePct != null ? round1(input.mfeCapturePct) : null,
      lateChaseSharePct:
        input.lateChaseShare != null
          ? round1(input.lateChaseShare * 100)
          : null,
    },
    targetWrMarker: TARGET_WR_PCT,
    profileId: input.profileId,
    name: input.name,
    quiet,
    capped,
  };
}

export interface AggregateChargeSource {
  winRate: number | null;
  expectancyPct: number | null;
  armedShare: number | null;
  mfeCapturePct: number | null;
  lateChaseShare: number | null;
  tradeCount?: number;
}

/** Build combined + per-profile charges from EL-shaped rows. */
export function buildPerformanceChargeBundle(opts: {
  combined: AggregateChargeSource;
  priorCombined?: AggregateChargeSource | null;
  profiles: Array<{
    profileId: string;
    name: string;
    metrics: {
      winRate: number | null;
      expectancyPct: number | null;
      mfeCapturePct: number | null;
      tradeCount?: number;
    };
    armedShare: number | null;
    lateChaseShare: number | null;
    quiet?: boolean;
    quietReason?: string;
    attentionShare?: number | null;
    attentionCap?: number | null;
    prior?: AggregateChargeSource | null;
    craftScore?: number | null;
  }>;
  craftScore?: number | null;
  combinedAttentionShare?: number | null;
  combinedAttentionCap?: number | null;
}): PerformanceChargeBundle {
  const priorCombinedCharge =
    opts.priorCombined != null
      ? computePerformanceCharge({
          winRate: opts.priorCombined.winRate,
          expectancyPct: opts.priorCombined.expectancyPct,
          armedShare: opts.priorCombined.armedShare,
          mfeCapturePct: opts.priorCombined.mfeCapturePct,
          lateChaseShare: opts.priorCombined.lateChaseShare,
          craftScore: opts.craftScore,
        }).chargePct
      : null;

  const combined = computePerformanceCharge({
    winRate: opts.combined.winRate,
    expectancyPct: opts.combined.expectancyPct,
    armedShare: opts.combined.armedShare,
    mfeCapturePct: opts.combined.mfeCapturePct,
    lateChaseShare: opts.combined.lateChaseShare,
    craftScore: opts.craftScore,
    attentionShare: opts.combinedAttentionShare,
    attentionCap: opts.combinedAttentionCap,
    priorChargePct: priorCombinedCharge,
    name: 'Combined',
    profileId: 'all',
  });

  const profiles = opts.profiles.map((p) => {
    const priorPct =
      p.prior != null
        ? computePerformanceCharge({
            winRate: p.prior.winRate,
            expectancyPct: p.prior.expectancyPct,
            armedShare: p.prior.armedShare,
            mfeCapturePct: p.prior.mfeCapturePct,
            lateChaseShare: p.prior.lateChaseShare,
            craftScore: p.craftScore,
          }).chargePct
        : null;
    return computePerformanceCharge({
      winRate: p.metrics.winRate,
      expectancyPct: p.metrics.expectancyPct,
      armedShare: p.armedShare,
      mfeCapturePct: p.metrics.mfeCapturePct,
      lateChaseShare: p.lateChaseShare,
      craftScore: p.craftScore,
      attentionShare: p.attentionShare,
      attentionCap: p.attentionCap,
      quiet: p.quiet,
      quietReason: p.quietReason,
      profileId: p.profileId,
      name: p.name,
      priorChargePct: priorPct,
    });
  });

  return { combined, profiles };
}
