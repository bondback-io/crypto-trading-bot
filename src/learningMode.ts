/**
 * Micro-bot Learning Mode — global gate overlays, fairness boost, and snapshot/reset.
 * Default OFF. Does not change position *sizing* (SOL per trade).
 * Middle/Looser soften entry gates vs the live baseline and may raise effective
 * concurrent / rate floors at runtime (never persist over the Max Positions knob).
 */

import { config, HARD_FILTER_FLOORS } from './config';

function persist(): void {
  try {
    const { persistUserSettings } =
      require('./config') as typeof import('./config');
    persistUserSettings();
  } catch {
    /* bootstrap */
  }
}

export type LearningModeStrictness = 'stricter' | 'middle' | 'looser';

/** Absolute / relative gate overlays by strictness. */
export interface LearningModeGateOverlays {
  minConviction: number;
  minCluster: number;
  minWalletQuality: number;
  sniperCountMax: number;
  bundlerPctMax: number;
  top10MinPct: number;
  top10MaxPct: number;
  devHoldingsMaxPct: number;
  /** Multiplier vs baseline effective MC (1 = unchanged) */
  minMarketCapMult: number;
  /** Multiplier vs baseline effective liquidity */
  minLiquidityMult: number;
  /** Multiplier vs baseline min token age */
  minTokenAgeMult: number;
  /** Delta applied to auto-score minScore */
  autoScoreMinDelta: number;
}

export interface LearningModeFilterSnapshot {
  minMarketCapUsd?: number;
  minLiquidity?: number;
  maxDevHoldPct?: number;
  maxDevPercent?: number;
  minTop10HolderPct?: number;
  maxHolderConcentration?: number;
  maxSniperCount?: number;
  maxBundlerPct?: number;
  clusterMinWallets?: number;
  convergenceRequired?: number;
  minWalletQualityScore?: number;
  minConvictionScore?: number;
  autoScoreMinScore?: number;
}

export interface LearningModeSnapshot {
  capturedAt: number;
  strictness: LearningModeStrictness;
  filters: LearningModeFilterSnapshot;
}

export interface LearningModeConfig {
  enabled: boolean;
  strictness: LearningModeStrictness;
  /** Captured on first OFF→ON; restored by reset. null until first ON. */
  snapshot: LearningModeSnapshot | null;
  /** Always true when Learning Mode is ON (fairness boost among passers). */
  fairnessBoost: boolean;
}

export const DEFAULT_LEARNING_MODE: LearningModeConfig = {
  enabled: false,
  strictness: 'middle',
  snapshot: null,
  fairnessBoost: true,
};

const GATE_MATRIX: Record<LearningModeStrictness, LearningModeGateOverlays> = {
  stricter: {
    minConviction: 78,
    minCluster: 2,
    minWalletQuality: 62,
    sniperCountMax: 40,
    bundlerPctMax: 50,
    top10MinPct: 7,
    top10MaxPct: 26,
    devHoldingsMaxPct: 14,
    minMarketCapMult: 1.15,
    minLiquidityMult: 1.1,
    minTokenAgeMult: 1.2,
    autoScoreMinDelta: 4,
  },
  /** Soft ceilings for mins / floors for maxes — blended with live baseline. */
  middle: {
    minConviction: 68,
    minCluster: 1,
    minWalletQuality: 52,
    sniperCountMax: 58,
    bundlerPctMax: 62,
    top10MinPct: 5,
    top10MaxPct: 32,
    devHoldingsMaxPct: 18,
    minMarketCapMult: 0.95,
    minLiquidityMult: 0.95,
    minTokenAgeMult: 0.9,
    autoScoreMinDelta: -2,
  },
  looser: {
    minConviction: 60,
    minCluster: 1,
    minWalletQuality: 45,
    sniperCountMax: 70,
    bundlerPctMax: 72,
    top10MinPct: 4,
    top10MaxPct: 36,
    devHoldingsMaxPct: 24,
    minMarketCapMult: 0.9,
    minLiquidityMult: 0.9,
    minTokenAgeMult: 0.8,
    autoScoreMinDelta: -3,
  },
};

/** Floors when Learning Mode tightens (stricter). */
const ABSOLUTE_FLOORS = {
  minConviction: 55,
  minCluster: 1,
  minWalletQuality: 35,
  sniperCountMaxMin: 10,
  bundlerPctMaxMin: 15,
  top10MinPct: HARD_FILTER_FLOORS.minTop10HolderPct,
  top10MaxPct: 20,
  devHoldingsMaxPct: 8,
  minMarketCapUsd: HARD_FILTER_FLOORS.minMarketCapUsd,
  minLiquidityUsd: HARD_FILTER_FLOORS.minLiquidityUsd,
  minTokenAgeHours: 0,
} as const;

/** Soft path may go below stricter absolutes down to micro-bot match floors. */
const SOFT_ABS_FLOORS = {
  minConviction: 25,
  minCluster: 1,
  minWalletQuality: 25,
  top10MinPct: 0,
  sniperCountMaxMin: 10,
  bundlerPctMaxMin: 15,
  top10MaxPct: 20,
  devHoldingsMaxPct: 8,
} as const;

function isSoftenStrictness(s: LearningModeStrictness): boolean {
  return s === 'middle' || s === 'looser';
}

/** Max fairness score bump for zero-episode profiles. */
export const LEARNING_FAIRNESS_MAX_BUMP = 8;

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function isStrictness(v: unknown): v is LearningModeStrictness {
  return v === 'stricter' || v === 'middle' || v === 'looser';
}

export function normalizeLearningModeConfig(
  raw: Partial<LearningModeConfig> | null | undefined
): LearningModeConfig {
  const base: LearningModeConfig = {
    enabled: false,
    strictness: 'middle',
    snapshot: null,
    fairnessBoost: true,
  };
  if (!raw || typeof raw !== 'object') return base;
  base.enabled = raw.enabled === true;
  if (isStrictness(raw.strictness)) base.strictness = raw.strictness;
  base.fairnessBoost = raw.fairnessBoost !== false;
  if (raw.snapshot && typeof raw.snapshot === 'object') {
    const s = raw.snapshot;
    base.snapshot = {
      capturedAt: Number(s.capturedAt) || Date.now(),
      strictness: isStrictness(s.strictness) ? s.strictness : 'middle',
      filters:
        s.filters && typeof s.filters === 'object'
          ? { ...s.filters }
          : {},
    };
  }
  return base;
}

function ensureLearningMode(): LearningModeConfig {
  if (!config.learningMode || typeof config.learningMode !== 'object') {
    config.learningMode = { ...DEFAULT_LEARNING_MODE };
  }
  const normalized = normalizeLearningModeConfig(config.learningMode);
  config.learningMode = normalized;
  return normalized;
}

export function isLearningModeActive(): boolean {
  try {
    return ensureLearningMode().enabled === true;
  } catch {
    return false;
  }
}

export function getLearningModeStrictness(): LearningModeStrictness {
  return ensureLearningMode().strictness;
}

export function getLearningModeGateOverlays(): LearningModeGateOverlays | null {
  if (!isLearningModeActive()) return null;
  return { ...GATE_MATRIX[getLearningModeStrictness()] };
}

export function getLearningModeStatus(): {
  enabled: boolean;
  strictness: LearningModeStrictness;
  fairnessBoost: boolean;
  hasSnapshot: boolean;
  overlays: LearningModeGateOverlays | null;
  label: string;
  liveWarning: boolean;
} {
  const lm = ensureLearningMode();
  const overlays = lm.enabled ? { ...GATE_MATRIX[lm.strictness] } : null;
  const label = lm.enabled
    ? `Learning Mode · ${lm.strictness.charAt(0).toUpperCase()}${lm.strictness.slice(1)}`
    : 'Learning Mode OFF';
  return {
    enabled: lm.enabled,
    strictness: lm.strictness,
    fairnessBoost: lm.enabled ? true : lm.fairnessBoost !== false,
    hasSnapshot: lm.snapshot != null,
    overlays,
    label,
    liveWarning: lm.enabled && config.mode === 'live',
  };
}

function captureFilterSnapshot(): LearningModeFilterSnapshot {
  const f = config.filters || ({} as typeof config.filters);
  const sel = config.selective || ({} as typeof config.selective);
  const auto = config.tradeProfiles?.autoScoring;
  return {
    minMarketCapUsd: f.minMarketCapUsd,
    minLiquidity: f.minLiquidity,
    maxDevHoldPct: f.maxDevHoldPct,
    maxDevPercent: f.maxDevPercent,
    minTop10HolderPct: f.minTop10HolderPct,
    maxHolderConcentration: f.maxHolderConcentration,
    maxSniperCount: f.maxSniperCount,
    maxBundlerPct: f.maxBundlerPct,
    clusterMinWallets: f.clusterMinWallets,
    convergenceRequired: f.convergenceRequired,
    minWalletQualityScore: f.minWalletQualityScore,
    minConvictionScore: sel.minConvictionScore,
    autoScoreMinScore:
      auto?.minScore != null && Number.isFinite(Number(auto.minScore))
        ? Number(auto.minScore)
        : undefined,
  };
}

function restoreFilterSnapshot(snap: LearningModeFilterSnapshot): void {
  const f = config.filters;
  if (snap.minMarketCapUsd != null && Number.isFinite(snap.minMarketCapUsd)) {
    f.minMarketCapUsd = snap.minMarketCapUsd;
  }
  if (snap.minLiquidity != null && Number.isFinite(snap.minLiquidity)) {
    f.minLiquidity = snap.minLiquidity;
  }
  if (snap.maxDevHoldPct != null && Number.isFinite(snap.maxDevHoldPct)) {
    f.maxDevHoldPct = snap.maxDevHoldPct;
    f.maxDevPercent = snap.maxDevHoldPct;
  } else if (snap.maxDevPercent != null && Number.isFinite(snap.maxDevPercent)) {
    f.maxDevPercent = snap.maxDevPercent;
    f.maxDevHoldPct = snap.maxDevPercent;
  }
  if (snap.minTop10HolderPct != null && Number.isFinite(snap.minTop10HolderPct)) {
    f.minTop10HolderPct = snap.minTop10HolderPct;
  }
  if (
    snap.maxHolderConcentration != null &&
    Number.isFinite(snap.maxHolderConcentration)
  ) {
    f.maxHolderConcentration = snap.maxHolderConcentration;
  }
  if (snap.maxSniperCount != null && Number.isFinite(snap.maxSniperCount)) {
    f.maxSniperCount = snap.maxSniperCount;
  }
  if (snap.maxBundlerPct != null && Number.isFinite(snap.maxBundlerPct)) {
    f.maxBundlerPct = snap.maxBundlerPct;
  }
  if (snap.clusterMinWallets != null && Number.isFinite(snap.clusterMinWallets)) {
    f.clusterMinWallets = snap.clusterMinWallets;
  }
  if (
    snap.convergenceRequired != null &&
    Number.isFinite(snap.convergenceRequired)
  ) {
    f.convergenceRequired = snap.convergenceRequired;
  }
  if (
    snap.minWalletQualityScore != null &&
    Number.isFinite(snap.minWalletQualityScore)
  ) {
    f.minWalletQualityScore = snap.minWalletQualityScore;
  }
  if (
    snap.minConvictionScore != null &&
    Number.isFinite(snap.minConvictionScore) &&
    config.selective
  ) {
    config.selective.minConvictionScore = snap.minConvictionScore;
  }
  if (
    snap.autoScoreMinScore != null &&
    Number.isFinite(snap.autoScoreMinScore)
  ) {
    if (!config.tradeProfiles) return;
    if (!config.tradeProfiles.autoScoring) {
      config.tradeProfiles.autoScoring = {};
    }
    config.tradeProfiles.autoScoring.minScore = snap.autoScoreMinScore;
  }
}

export function setLearningModeEnabled(on: boolean): LearningModeConfig {
  const lm = ensureLearningMode();
  const next = on === true;
  if (next && !lm.enabled && lm.snapshot == null) {
    lm.snapshot = {
      capturedAt: Date.now(),
      strictness: lm.strictness,
      filters: captureFilterSnapshot(),
    };
  }
  lm.enabled = next;
  // Fairness is always on while Learning Mode is ON
  if (lm.enabled) lm.fairnessBoost = true;
  config.learningMode = lm;
  persist();
  try {
    const { appendLearningSave } =
      require('./profileLearningSaveLog') as typeof import('./profileLearningSaveLog');
    appendLearningSave({
      profileId: 'all',
      kind: 'learning_mode',
      summary: next
        ? `Learning Mode ON (${lm.strictness})`
        : 'Learning Mode OFF',
    });
  } catch {
    /* optional */
  }
  return { ...lm };
}

export function setLearningModeStrictness(
  s: LearningModeStrictness
): LearningModeConfig {
  const lm = ensureLearningMode();
  if (!isStrictness(s)) return lm;
  lm.strictness = s;
  config.learningMode = lm;
  persist();
  try {
    const { appendLearningSave } =
      require('./profileLearningSaveLog') as typeof import('./profileLearningSaveLog');
    appendLearningSave({
      profileId: 'all',
      kind: 'learning_mode',
      summary: `Learning Mode strictness → ${s}`,
    });
  } catch {
    /* optional */
  }
  return { ...lm };
}

/**
 * Restore Learning Mode–owned snapshot (strictness + filter baselines).
 * Does not touch episodes / ML. Turns Learning Mode OFF.
 */
export function resetLearningMode(): LearningModeConfig {
  const lm = ensureLearningMode();
  if (lm.snapshot) {
    lm.strictness = lm.snapshot.strictness;
    restoreFilterSnapshot(lm.snapshot.filters || {});
  } else {
    lm.strictness = 'middle';
  }
  lm.enabled = false;
  lm.fairnessBoost = true;
  // Clear snapshot so next ON re-captures a fresh baseline
  lm.snapshot = null;
  config.learningMode = lm;
  persist();
  try {
    const { appendLearningSave } =
      require('./profileLearningSaveLog') as typeof import('./profileLearningSaveLog');
    appendLearningSave({
      profileId: 'all',
      kind: 'learning_mode',
      summary: 'Learning Mode reset (snapshot restored, mode OFF)',
    });
  } catch {
    /* optional */
  }
  return { ...lm };
}

/**
 * Blend min-gate overlay with live baseline.
 * Stricter: max(baseline, overlay). Middle/Looser: min(baseline, overlay) — never raise.
 */
export function applyLearningMinOverlay(
  baseline: number,
  overlayKey:
    | 'minConviction'
    | 'minCluster'
    | 'minWalletQuality'
    | 'top10MinPct'
): number {
  const ov = getLearningModeGateOverlays();
  if (!ov) return baseline;
  const strictness = getLearningModeStrictness();
  const soften = isSoftenStrictness(strictness);
  const base = Number.isFinite(baseline) ? baseline : 0;

  // Disabled / Risk-Off zero floors stay disabled on soft path
  if (soften && overlayKey === 'top10MinPct' && base <= 0) return base;

  let overlay: number;
  let lo: number;
  let hi: number;
  if (overlayKey === 'minConviction') {
    overlay = ov.minConviction;
    lo = soften ? SOFT_ABS_FLOORS.minConviction : ABSOLUTE_FLOORS.minConviction;
    hi = 90;
  } else if (overlayKey === 'minCluster') {
    overlay = ov.minCluster;
    lo = soften ? SOFT_ABS_FLOORS.minCluster : ABSOLUTE_FLOORS.minCluster;
    hi = 5;
  } else if (overlayKey === 'minWalletQuality') {
    overlay = ov.minWalletQuality;
    lo = soften
      ? SOFT_ABS_FLOORS.minWalletQuality
      : ABSOLUTE_FLOORS.minWalletQuality;
    hi = 85;
  } else {
    overlay = ov.top10MinPct;
    lo = soften ? SOFT_ABS_FLOORS.top10MinPct : ABSOLUTE_FLOORS.top10MinPct;
    hi = 40;
  }

  const blended = soften ? Math.min(base, overlay) : Math.max(base, overlay);
  return clamp(blended, lo, hi);
}

/**
 * Blend max-gate overlay with live baseline.
 * Stricter: min(baseline, overlay). Middle/Looser: max(baseline, overlay) — never tighten.
 */
export function applyLearningMaxOverlay(
  baseline: number,
  overlayKey:
    | 'sniperCountMax'
    | 'bundlerPctMax'
    | 'top10MaxPct'
    | 'devHoldingsMaxPct'
): number {
  const ov = getLearningModeGateOverlays();
  if (!ov) return baseline;
  const strictness = getLearningModeStrictness();
  const soften = isSoftenStrictness(strictness);
  const base = Number.isFinite(baseline) ? baseline : 0;

  let overlay: number;
  let lo: number;
  let hi: number;
  if (overlayKey === 'sniperCountMax') {
    overlay = ov.sniperCountMax;
    lo = soften
      ? SOFT_ABS_FLOORS.sniperCountMaxMin
      : ABSOLUTE_FLOORS.sniperCountMaxMin;
    hi = 100;
  } else if (overlayKey === 'bundlerPctMax') {
    overlay = ov.bundlerPctMax;
    lo = soften
      ? SOFT_ABS_FLOORS.bundlerPctMaxMin
      : ABSOLUTE_FLOORS.bundlerPctMaxMin;
    hi = 90;
  } else if (overlayKey === 'top10MaxPct') {
    overlay = ov.top10MaxPct;
    lo = soften ? SOFT_ABS_FLOORS.top10MaxPct : ABSOLUTE_FLOORS.top10MaxPct;
    hi = 80;
  } else {
    overlay = ov.devHoldingsMaxPct;
    lo = soften
      ? SOFT_ABS_FLOORS.devHoldingsMaxPct
      : ABSOLUTE_FLOORS.devHoldingsMaxPct;
    hi = 40;
  }

  const blended = soften ? Math.max(base, overlay) : Math.min(base, overlay);
  return clamp(blended, lo, hi);
}

/**
 * Relative floor: multiply baseline.
 * Soft path: never re-impose hard floors when baseline is 0 (Risk Off bypass).
 */
export function applyLearningRelativeFloor(
  baseline: number,
  mult: number,
  hardFloor: number
): number {
  if (!Number.isFinite(baseline) || baseline <= 0) {
    return Math.max(0, Number.isFinite(baseline) ? baseline : 0);
  }
  const scaled = baseline * mult;
  if (!isLearningModeActive()) return Math.max(hardFloor, scaled);
  const soften = isSoftenStrictness(getLearningModeStrictness());
  if (soften) {
    // Soften toward scaled but never below hard safety when Risk On floors exist
    return Math.max(hardFloor, scaled);
  }
  return Math.max(hardFloor, scaled);
}

export function learningModeAdjustedMinMarketCap(baselineUsd: number): number {
  const ov = getLearningModeGateOverlays();
  if (!ov) return baselineUsd;
  return applyLearningRelativeFloor(
    baselineUsd,
    ov.minMarketCapMult,
    ABSOLUTE_FLOORS.minMarketCapUsd
  );
}

export function learningModeAdjustedMinLiquidity(baselineUsd: number): number {
  const ov = getLearningModeGateOverlays();
  if (!ov) return baselineUsd;
  return applyLearningRelativeFloor(
    baselineUsd,
    ov.minLiquidityMult,
    ABSOLUTE_FLOORS.minLiquidityUsd
  );
}

export function learningModeAdjustedMinTokenAgeHours(
  baselineHours: number
): number {
  const ov = getLearningModeGateOverlays();
  if (!ov) return baselineHours;
  if (!Number.isFinite(baselineHours) || baselineHours <= 0) return baselineHours;
  const scaled = baselineHours * ov.minTokenAgeMult;
  return Math.max(ABSOLUTE_FLOORS.minTokenAgeHours, scaled);
}

export function learningModeAdjustedAutoMinScore(baseline: number): number {
  const ov = getLearningModeGateOverlays();
  if (!ov) return baseline;
  return clamp(baseline + ov.autoScoreMinDelta, 20, 95);
}

/**
 * Runtime max concurrent opens — does not persist Max Positions slider.
 * Middle ≥16, Looser ≥24 vs baseline; Stricter unchanged.
 */
export function learningModeAdjustedMaxConcurrent(baseline: number): number {
  const b = Math.max(1, Number(baseline) || 1);
  if (!isLearningModeActive()) return b;
  const s = getLearningModeStrictness();
  if (s === 'stricter') return b;
  if (s === 'looser') return Math.max(b, 24);
  return Math.max(b, 16);
}

/** Runtime hourly trade cap floor while LM softens. 0 = unlimited stays unlimited. */
export function learningModeAdjustedMaxTradesPerHour(baseline: number): number {
  const b = Number(baseline) || 0;
  if (!isLearningModeActive() || b <= 0) return b;
  const s = getLearningModeStrictness();
  if (s === 'stricter') return b;
  if (s === 'looser') return Math.max(b, 24);
  return Math.max(b, 18);
}

/** Runtime cooldown ceiling (shorten) while LM softens. */
export function learningModeAdjustedMinMsBetweenTrades(baseline: number): number {
  const b = Number(baseline) || 0;
  if (!isLearningModeActive() || b <= 0) return b;
  const s = getLearningModeStrictness();
  if (s === 'stricter') return b;
  if (s === 'looser') return Math.min(b, 15_000);
  return Math.min(b, 20_000);
}

/**
 * Fairness score bump for low-episode profiles (Learning Mode ON).
 * Caps at LEARNING_FAIRNESS_MAX_BUMP; zero when at/above LEARNING_PROGRESS_GOAL.
 */
export function learningModeFairnessBump(episodeCount: number): number {
  if (!isLearningModeActive()) return 0;
  const lm = ensureLearningMode();
  if (lm.fairnessBoost === false) return 0;
  let goal = 400;
  try {
    const { LEARNING_PROGRESS_GOAL } =
      require('./profileSelfLearning') as typeof import('./profileSelfLearning');
    goal = LEARNING_PROGRESS_GOAL || 400;
  } catch {
    /* default */
  }
  const n = Math.max(0, Number(episodeCount) || 0);
  if (n >= goal) return 0;
  const frac = 1 - n / goal;
  return Math.round(LEARNING_FAIRNESS_MAX_BUMP * frac * 10) / 10;
}

export function stampLearningModeFields(): {
  learningMode?: boolean;
  learningStrictness?: LearningModeStrictness;
  learningFairnessApplied?: boolean;
} {
  if (!isLearningModeActive()) return {};
  return {
    learningMode: true,
    learningStrictness: getLearningModeStrictness(),
    learningFairnessApplied: true,
  };
}
