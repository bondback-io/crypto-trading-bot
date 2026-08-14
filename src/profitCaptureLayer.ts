/**
 * Profit Capture Layer (PCL) — additive post-entry harvest.
 * Grants a short permission window, retunes partial/runner + PPP timing,
 * and reshapes learning rewards. Never disables hard SL / anti-rug.
 */

import { config } from './config';
import { PEAK_PROTECT_FAST_PROFILES } from './peakProfitProtection';

export type PclProfileFamily = 'fast' | 'dip_trend' | 'quality' | 'default';

export interface ProfitCaptureFamilyOverride {
  permissionSec?: number;
  peakProtectArmOfTpPct?: number;
  peakProtectGivebackOfPeakPct?: number;
  earlyPartialTpPct?: number;
  earlyPartialFraction?: number;
}

export interface ProfitCaptureLayerConfig {
  enabled: boolean;
  /** 0–1 strength for learning boosts/penalties (default 0.35). */
  learningStrength: number;
  /** Optional per-family overrides (permission / PPP / partial). */
  familyOverrides?: Partial<
    Record<'fast' | 'dip_trend' | 'quality', ProfitCaptureFamilyOverride>
  >;
}

export const DEFAULT_PROFIT_CAPTURE_LAYER: ProfitCaptureLayerConfig = {
  enabled: true,
  learningStrength: 0.35,
  familyOverrides: {},
};

const DIP_TREND_PROFILES = new Set(['dip_buyer', 'trend_rider']);
const QUALITY_PROFILES = new Set([
  'high_win_rate',
  'steady_compounder',
  'smart_money_mirror',
]);

/** Base permission windows (seconds) by family. */
export const PCL_PERMISSION_SEC: Record<PclProfileFamily, number> = {
  fast: 35,
  dip_trend: 120,
  quality: 90,
  default: 60,
};

/** PPP arm / giveback / min-open / min-profit floors by family. */
export const PCL_PPP_BY_FAMILY: Record<
  Exclude<PclProfileFamily, 'default'>,
  {
    armOfTpPct: number;
    givebackOfPeakPct: number;
    minOpenSec: number;
    minProfitFloorPct: number;
  }
> = {
  fast: {
    armOfTpPct: 52,
    // Tighter giveback for low-capture fast/MS harvest (1.2.291)
    givebackOfPeakPct: 24,
    minOpenSec: 25,
    minProfitFloorPct: 4,
  },
  dip_trend: {
    armOfTpPct: 50,
    givebackOfPeakPct: 32,
    minOpenSec: 60,
    minProfitFloorPct: 6,
  },
  quality: {
    armOfTpPct: 50,
    givebackOfPeakPct: 42,
    minOpenSec: 45,
    minProfitFloorPct: 5,
  },
};

/** Default early-partial fraction (banked) / runner by family. */
export const PCL_PARTIAL_BY_FAMILY: Record<
  Exclude<PclProfileFamily, 'default'>,
  { earlyPartialTpPct: number; earlyPartialFraction: number }
> = {
  fast: { earlyPartialTpPct: 15, earlyPartialFraction: 0.55 },
  dip_trend: { earlyPartialTpPct: 25, earlyPartialFraction: 0.35 },
  quality: { earlyPartialTpPct: 22, earlyPartialFraction: 0.35 },
};

/** Tiny green scratch threshold (%). */
export const PCL_TINY_GREEN_SCRATCH_PCT = 3;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function resolvePclProfileFamily(
  profileId: string | null | undefined
): PclProfileFamily {
  const id = String(profileId || '');
  if (PEAK_PROTECT_FAST_PROFILES.has(id)) return 'fast';
  if (DIP_TREND_PROFILES.has(id)) return 'dip_trend';
  if (QUALITY_PROFILES.has(id)) return 'quality';
  return 'default';
}

export function getProfitCaptureLayerConfig(): ProfitCaptureLayerConfig {
  try {
    const raw = (
      config as { profitCaptureLayer?: Partial<ProfitCaptureLayerConfig> }
    ).profitCaptureLayer;
    const d = DEFAULT_PROFIT_CAPTURE_LAYER;
    if (!raw || typeof raw !== 'object') {
      return { ...d, familyOverrides: { ...(d.familyOverrides || {}) } };
    }
    return {
      enabled: raw.enabled !== false,
      learningStrength: clamp(
        Number(raw.learningStrength) || d.learningStrength,
        0,
        1
      ),
      familyOverrides:
        raw.familyOverrides && typeof raw.familyOverrides === 'object'
          ? { ...raw.familyOverrides }
          : { ...(d.familyOverrides || {}) },
    };
  } catch {
    console.warn('[pcl] config missing — fail soft (defaults)');
    return {
      ...DEFAULT_PROFIT_CAPTURE_LAYER,
      familyOverrides: { ...(DEFAULT_PROFIT_CAPTURE_LAYER.familyOverrides || {}) },
    };
  }
}

export function setProfitCaptureLayerConfig(
  patch: Partial<ProfitCaptureLayerConfig>
): ProfitCaptureLayerConfig {
  const cur = getProfitCaptureLayerConfig();
  const next: ProfitCaptureLayerConfig = {
    enabled:
      typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
    learningStrength:
      patch.learningStrength != null &&
      Number.isFinite(Number(patch.learningStrength))
        ? clamp(Number(patch.learningStrength), 0, 1)
        : cur.learningStrength,
    familyOverrides:
      patch.familyOverrides && typeof patch.familyOverrides === 'object'
        ? { ...(cur.familyOverrides || {}), ...patch.familyOverrides }
        : { ...(cur.familyOverrides || {}) },
  };
  (config as { profitCaptureLayer: ProfitCaptureLayerConfig }).profitCaptureLayer =
    next;
  try {
    const { persistUserSettings } =
      require('./config') as typeof import('./config');
    persistUserSettings();
  } catch {
    /* */
  }
  return next;
}

export function isProfitCaptureLayerEnabled(): boolean {
  try {
    return getProfitCaptureLayerConfig().enabled !== false;
  } catch {
    return true;
  }
}

/**
 * Entry quality 0–100 from conviction + HMC classifier confidence + lane score.
 */
export function computeEntryQualityScore(input: {
  convictionScore?: number | null;
  hmcConfidence?: number | null;
  tradeProfileScore?: number | null;
}): number {
  const conv =
    input.convictionScore != null && Number.isFinite(Number(input.convictionScore))
      ? clamp(Number(input.convictionScore), 0, 100)
      : null;
  const hmcRaw =
    input.hmcConfidence != null && Number.isFinite(Number(input.hmcConfidence))
      ? Number(input.hmcConfidence)
      : null;
  // Classifier conf may be 0–1 or 0–100
  const hmc =
    hmcRaw == null
      ? null
      : hmcRaw <= 1
        ? clamp(hmcRaw * 100, 0, 100)
        : clamp(hmcRaw, 0, 100);
  const lane =
    input.tradeProfileScore != null &&
    Number.isFinite(Number(input.tradeProfileScore))
      ? clamp(Number(input.tradeProfileScore), 0, 100)
      : null;

  let w = 0;
  let sum = 0;
  if (conv != null) {
    sum += conv * 0.45;
    w += 0.45;
  }
  if (hmc != null) {
    sum += hmc * 0.3;
    w += 0.3;
  }
  if (lane != null) {
    sum += lane * 0.25;
    w += 0.25;
  }
  if (w <= 0) return 50;
  return Math.round(clamp(sum / w, 0, 100));
}

export function resolvePermissionWindowSec(
  profileId: string | null | undefined,
  entryQualityScore?: number | null,
  opts?: {
    entryStyle?: string | null;
    lateChaseAtEntry?: boolean;
    armedWatch?: boolean;
  }
): number {
  const family = resolvePclProfileFamily(profileId);
  const cfg = getProfitCaptureLayerConfig();
  const ovKey =
    family === 'fast'
      ? 'fast'
      : family === 'dip_trend'
        ? 'dip_trend'
        : family === 'quality'
          ? 'quality'
          : null;
  const ov =
    ovKey && cfg.familyOverrides?.[ovKey]
      ? cfg.familyOverrides[ovKey]
      : undefined;
  let sec =
    ov?.permissionSec != null && Number.isFinite(Number(ov.permissionSec))
      ? Number(ov.permissionSec)
      : PCL_PERMISSION_SEC[family];
  const q =
    entryQualityScore != null && Number.isFinite(Number(entryQualityScore))
      ? Number(entryQualityScore)
      : null;
  if (q != null && q >= 70) {
    sec = Math.round(sec * 1.4);
  }
  // High-q valid style → stretch further; marginal / late_chase → shorter
  const late = opts?.lateChaseAtEntry === true;
  const style = String(opts?.entryStyle || '');
  const validStyle =
    style.length > 0 && style !== 'late_chase' && style !== 'unknown';
  const armed =
    opts?.armedWatch === true ||
    /scalp_reclaim|support_dip_reclaim/i.test(style);
  const mediumHigh =
    (q != null && q >= 55) ||
    /scalp_reclaim|support_dip_reclaim|reclaim/i.test(style);
  if (armed || (mediumHigh && !late && validStyle)) {
    sec = Math.round(sec * 1.5);
  } else if (!late && validStyle && q != null && q >= 70) {
    sec = Math.round(sec * 1.2);
  } else if (late || style === 'late_chase' || (q != null && q < 40)) {
    sec = Math.round(sec * 0.7);
  }
  return clamp(Math.round(sec), 5, 600);
}

export function computeProfitPermissionUntilMs(input: {
  openedAt: number;
  profileId?: string | null;
  entryQualityScore?: number | null;
  entryStyle?: string | null;
  lateChaseAtEntry?: boolean;
  armedWatch?: boolean;
}): number {
  const sec = resolvePermissionWindowSec(
    input.profileId,
    input.entryQualityScore,
    {
      entryStyle: input.entryStyle,
      lateChaseAtEntry: input.lateChaseAtEntry,
      armedWatch: input.armedWatch,
    }
  );
  return Number(input.openedAt) + sec * 1000;
}

export function isProfitPermissionActive(input: {
  profitPermissionUntilMs?: number | null;
  nowMs?: number;
}): boolean {
  if (!isProfitCaptureLayerEnabled()) return false;
  const until = Number(input.profitPermissionUntilMs) || 0;
  if (!(until > 0)) return false;
  const now = input.nowMs ?? Date.now();
  return now < until;
}

export function resolvePclPppDefaults(
  profileId: string | null | undefined
): {
  armOfTpPct: number;
  givebackOfPeakPct: number;
  minOpenSec: number;
  minProfitFloorPct: number;
} {
  const family = resolvePclProfileFamily(profileId);
  const base =
    family === 'default'
      ? PCL_PPP_BY_FAMILY.quality
      : PCL_PPP_BY_FAMILY[family];
  const cfg = getProfitCaptureLayerConfig();
  const ovKey =
    family === 'fast'
      ? 'fast'
      : family === 'dip_trend'
        ? 'dip_trend'
        : family === 'quality'
          ? 'quality'
          : null;
  const ov =
    ovKey && cfg.familyOverrides?.[ovKey]
      ? cfg.familyOverrides[ovKey]
      : undefined;
  return {
    armOfTpPct:
      ov?.peakProtectArmOfTpPct != null &&
      Number.isFinite(Number(ov.peakProtectArmOfTpPct))
        ? clamp(Number(ov.peakProtectArmOfTpPct), 10, 95)
        : base.armOfTpPct,
    givebackOfPeakPct:
      ov?.peakProtectGivebackOfPeakPct != null &&
      Number.isFinite(Number(ov.peakProtectGivebackOfPeakPct))
        ? clamp(Number(ov.peakProtectGivebackOfPeakPct), 10, 80)
        : base.givebackOfPeakPct,
    minOpenSec: base.minOpenSec,
    minProfitFloorPct: base.minProfitFloorPct,
  };
}

export function resolvePclPartialDefaults(
  profileId: string | null | undefined,
  opts?: {
    armedWatch?: boolean;
    entryStyle?: string | null;
    entryQualityScore?: number | null;
    qualityTier?: 'low' | 'medium' | 'high' | null;
  }
): { earlyPartialTpPct: number; earlyPartialFraction: number } {
  const family = resolvePclProfileFamily(profileId);
  // Fast profiles keep per-id nuance in DEFAULT_EXIT_POLICIES; family table is fallback.
  const id = String(profileId || '');
  let base =
    family === 'default'
      ? { earlyPartialTpPct: 15, earlyPartialFraction: 0.35 }
      : { ...PCL_PARTIAL_BY_FAMILY[family] };
  if (id === 'scalper' || id === 'reversal_scalper') {
    // Scalper family: 12–18% @ 0.50–0.70 (armed reclaim special-cased below)
    base = {
      earlyPartialTpPct: id === 'reversal_scalper' ? 12 : 15,
      earlyPartialFraction: id === 'reversal_scalper' ? 0.55 : 0.6,
    };
  } else if (id === 'momentum_burst') {
    // Disc MS/MB: slightly earlier bank (1.2.268) — armed path overrides below
    base = { earlyPartialTpPct: 14, earlyPartialFraction: 0.52 };
  } else if (id === 'migration_sniper') {
    // Migration: bank earlier while E weak — tighter than generic fast disc
    base = { earlyPartialTpPct: 10, earlyPartialFraction: 0.55 };
  } else if (id === 'trend_rider') {
    base = { earlyPartialTpPct: 25, earlyPartialFraction: 0.35 };
  } else if (id === 'dip_buyer') {
    base = { earlyPartialTpPct: 25, earlyPartialFraction: 0.35 };
  } else if (id === 'high_win_rate') {
    base = { earlyPartialTpPct: 22, earlyPartialFraction: 0.35 };
  } else if (id === 'steady_compounder') {
    // Steady harvest 1.2.258: PCL ~28% TP / ~40% fraction (larger runner)
    base = { earlyPartialTpPct: 28, earlyPartialFraction: 0.4 };
  } else if (id === 'smart_money_mirror') {
    base = { earlyPartialTpPct: 20, earlyPartialFraction: 0.4 };
  }
  const style = String(opts?.entryStyle || '');
  const q =
    opts?.entryQualityScore != null &&
    Number.isFinite(Number(opts.entryQualityScore))
      ? Number(opts.entryQualityScore)
      : null;
  const armed =
    opts?.armedWatch === true ||
    /scalp_reclaim|support_dip_reclaim|quality_structure_reclaim/i.test(style);
  const mediumHigh =
    opts?.qualityTier === 'medium' ||
    opts?.qualityTier === 'high' ||
    (q != null && q >= 55) ||
    /scalp_reclaim|support_dip_reclaim|reclaim/i.test(style);
  const isLowRiskHarvest =
    opts?.qualityTier !== 'low' &&
    !/late_chase/i.test(style);
  // Fast family: earlier PCL partial ONLY when armed (1.2.248) — not disc mediumHigh
  const isFastFamily =
    id === 'scalper' ||
    id === 'reversal_scalper' ||
    id === 'momentum_burst' ||
    id === 'migration_sniper' ||
    family === 'fast';
  if (isFastFamily) {
    if (armed) {
      // Migration armed: slightly earlier bank than generic fast 8%@0.45
      if (id === 'migration_sniper') {
        base = { earlyPartialTpPct: 6, earlyPartialFraction: 0.5 };
      } else {
        base = { earlyPartialTpPct: 8, earlyPartialFraction: 0.45 };
      }
    }
    // else keep base (15–18% / MS 12%) — do not pull forward on discretionary mediumHigh
  } else if (id === 'steady_compounder') {
    // Keep Steady harvest 28%/40% — do not pull to micro early bank
  } else if ((armed || mediumHigh) && isLowRiskHarvest) {
    // Quality / dip-trend: bank later, keep larger runner (1.2.258)
    base = {
      earlyPartialTpPct: 14,
      earlyPartialFraction: 0.35,
    };
  } else if (armed || mediumHigh) {
    // Low-tier / unusual: keep earlier bank
    base = {
      earlyPartialTpPct: clamp(base.earlyPartialTpPct, 8, 10),
      earlyPartialFraction: clamp(base.earlyPartialFraction, 0.4, 0.5),
    };
    if (armed) {
      base = { earlyPartialTpPct: 9, earlyPartialFraction: 0.45 };
    }
  }
  const cfg = getProfitCaptureLayerConfig();
  const ovKey =
    family === 'fast'
      ? 'fast'
      : family === 'dip_trend'
        ? 'dip_trend'
        : family === 'quality'
          ? 'quality'
          : null;
  const ov =
    ovKey && cfg.familyOverrides?.[ovKey]
      ? cfg.familyOverrides[ovKey]
      : undefined;
  return {
    earlyPartialTpPct:
      ov?.earlyPartialTpPct != null &&
      Number.isFinite(Number(ov.earlyPartialTpPct))
        ? Math.max(0, Number(ov.earlyPartialTpPct))
        : base.earlyPartialTpPct,
    earlyPartialFraction:
      ov?.earlyPartialFraction != null &&
      Number.isFinite(Number(ov.earlyPartialFraction))
        ? clamp(Number(ov.earlyPartialFraction), 0, 0.9)
        : base.earlyPartialFraction,
  };
}

/**
 * Block tiny green scratch exits while permission is active, or before first
 * partial on medium+ quality trades.
 */
export function shouldBlockTinyGreenScratch(input: {
  pnlPct: number;
  profitPermissionUntilMs?: number | null;
  pclPartialTaken?: boolean;
  qualityTier?: 'low' | 'medium' | 'high' | null;
  entryQualityScore?: number | null;
  maxRunupPct?: number | null;
  armedWatch?: boolean;
  entryStyle?: string | null;
  nowMs?: number;
}): boolean {
  if (!isProfitCaptureLayerEnabled()) return false;
  const pnl = Number(input.pnlPct) || 0;
  if (!(pnl > 0)) return false;
  const mfe = Math.max(0, Number(input.maxRunupPct) || 0);
  const tier = input.qualityTier || 'medium';
  const q =
    input.entryQualityScore != null &&
    Number.isFinite(Number(input.entryQualityScore))
      ? Number(input.entryQualityScore)
      : null;
  const mediumPlus =
    tier === 'medium' || tier === 'high' || (q != null && q >= 45);
  // Medium+ with real MFE: block soft-scratch up to ~4.5% green (1.2.268)
  const scratchCeil =
    mediumPlus && mfe >= 6
      ? Math.max(PCL_TINY_GREEN_SCRATCH_PCT, 4.5)
      : PCL_TINY_GREEN_SCRATCH_PCT;
  if (pnl >= scratchCeil) return false;
  const armed =
    input.armedWatch === true ||
    /scalp_reclaim|support_dip_reclaim/i.test(String(input.entryStyle || ''));
  // Armed / meaningful MFE: never scratch tiny green when MFE ≥ 6%
  if ((armed || mfe >= 6) && mfe >= 6) return true;
  // Strong MFE left on table: block scratchy soft-exit even below tiny threshold
  if (mfe >= 12 && pnl > 0 && pnl < 5) return true;
  const perm = isProfitPermissionActive({
    profitPermissionUntilMs: input.profitPermissionUntilMs,
    nowMs: input.nowMs,
  });
  if (perm) return true;
  if (input.pclPartialTaken) return false;
  return mediumPlus;
}

/** Soften fade threshold during permission (×1.5). */
export function permissionFadeThresholdMult(input: {
  profitPermissionUntilMs?: number | null;
  nowMs?: number;
}): number {
  if (
    isProfitPermissionActive({
      profitPermissionUntilMs: input.profitPermissionUntilMs,
      nowMs: input.nowMs,
    })
  ) {
    return 1.5;
  }
  return 1;
}

/** High quality → later PPP arm (+5–10 pts of TP%). Valid style stretches further.
 * Armed / medium-high reclaim → arm ~75% of TP. */
export function qualityPppArmBonusPts(
  entryQualityScore?: number | null,
  opts?: {
    entryStyle?: string | null;
    lateChaseAtEntry?: boolean;
    armedWatch?: boolean;
  }
): number {
  const q =
    entryQualityScore != null && Number.isFinite(Number(entryQualityScore))
      ? Number(entryQualityScore)
      : null;
  if (q == null && !opts?.armedWatch) return 0;
  const late = opts?.lateChaseAtEntry === true;
  const style = String(opts?.entryStyle || '');
  const validStyle =
    style.length > 0 &&
    style !== 'late_chase' &&
    style !== 'unknown' &&
    !late;
  const armed =
    opts?.armedWatch === true ||
    /scalp_reclaim|support_dip_reclaim/i.test(style);
  // Target ~75% of TP: base fast=60 → +15; dip/quality=65 → +10
  if (armed && !late) return 15;
  if (late || ((q == null || q < 45) && !validStyle)) return 0;
  if (q != null && q >= 80 && validStyle) return 12;
  if (q != null && q >= 80) return 10;
  if (q != null && q >= 70 && validStyle) return 8;
  if (q != null && q >= 70) return 5;
  if (q != null && q >= 55 && validStyle) return 10;
  return 0;
}

/** Post-partial runner: mild giveback tighten (1.2.258 harvest breath). */
export const PCL_POST_PARTIAL_GIVEBACK_MULT = 0.95;

/**
 * Trail activation nudge after partial — breakeven-ish (small green).
 * Gated to fast / low-tier / late-chase only — Steady/quality runners keep room.
 * Does not remove hard SL.
 */
export function applyPclPartialRunnerNudge(
  position: {
    trailingActivationProfit?: number;
    trailingActive?: boolean;
    pclPartialTaken?: boolean;
    pclRunnerFraction?: number;
    partialSellDone?: boolean;
    pclPartialAtPct?: number;
    pclPartialAtMs?: number;
    entryPriceSol?: number;
    highWaterMarkSol?: number;
    tradeProfileId?: string | null;
    qualityTier?: 'low' | 'medium' | 'high' | null;
    lateChaseAtEntry?: boolean;
    /** Expectancy Lift — runner still managed after first partial */
    postPartialSurvival?: boolean;
    /** Peak MFE % observed after partial (low-touch track) */
    postPartialPeakMfePct?: number;
  },
  opts?: {
    markPnlPct?: number;
    nowMs?: number;
    profileId?: string | null;
    qualityTier?: 'low' | 'medium' | 'high' | null;
    lateChaseAtEntry?: boolean;
  }
): void {
  if (!isProfitCaptureLayerEnabled()) return;
  const already = position.pclPartialTaken === true;
  position.pclPartialTaken = true;
  position.partialSellDone = true;
  position.postPartialSurvival = true;
  if (!already) {
    const now = opts?.nowMs ?? Date.now();
    position.pclPartialAtMs = now;
    if (opts?.markPnlPct != null && Number.isFinite(opts.markPnlPct)) {
      position.pclPartialAtPct = Number(opts.markPnlPct);
      position.postPartialPeakMfePct = Number(opts.markPnlPct);
    } else {
      const entry = Number(position.entryPriceSol) || 0;
      const hwm = Number(position.highWaterMarkSol) || entry;
      if (entry > 0 && hwm > 0) {
        position.pclPartialAtPct = ((hwm - entry) / entry) * 100;
        position.postPartialPeakMfePct = position.pclPartialAtPct;
      }
    }
  }
  const pid = String(
    opts?.profileId || position.tradeProfileId || ''
  );
  const family = resolvePclProfileFamily(pid);
  const tier =
    opts?.qualityTier ?? position.qualityTier ?? null;
  const late =
    opts?.lateChaseAtEntry === true ||
    position.lateChaseAtEntry === true;
  const allowBeNudge =
    family === 'fast' || tier === 'low' || late;
  if (
    allowBeNudge &&
    (position.trailingActivationProfit == null ||
      !Number.isFinite(Number(position.trailingActivationProfit)) ||
      Number(position.trailingActivationProfit) > 2)
  ) {
    position.trailingActivationProfit = 1.5;
  }
}

export function formatPclZionOneLiner(input: {
  profitPermissionUntilMs?: number | null;
  pclPartialTaken?: boolean;
  pclRunnerFraction?: number | null;
  peakProtectArmed?: boolean;
  nowMs?: number;
}): string | null {
  try {
    if (!isProfitCaptureLayerEnabled()) return null;
    const now = input.nowMs ?? Date.now();
    const until = Number(input.profitPermissionUntilMs) || 0;
    if (until > now) {
      const sec = Math.max(1, Math.ceil((until - now) / 1000));
      return `Permission window active (${sec}s left); PPP deferred`;
    }
    if (input.pclPartialTaken) {
      const runner =
        input.pclRunnerFraction != null &&
        Number.isFinite(Number(input.pclRunnerFraction))
          ? Math.round(Number(input.pclRunnerFraction) * 100)
          : null;
      const runnerBit =
        runner != null ? `Partial banked, runner ${runner}% on trail` : null;
      if (runnerBit) {
        return input.peakProtectArmed
          ? `${runnerBit}; PPP armed`
          : runnerBit;
      }
      return 'Partial banked, runner on trail';
    }
    if (
      until > 0 ||
      input.pclPartialTaken ||
      input.pclRunnerFraction != null ||
      input.peakProtectArmed
    ) {
      return input.peakProtectArmed
        ? 'PCL: PPP armed on runner'
        : 'PCL: permission expired; managing for harvest';
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Learning reshape delta applied to timingReward (additive).
 * Positive = boost; negative = penalty. Scaled by learningStrength.
 */
export function computePclLearningRewardDelta(input: {
  pnlPct: number;
  maxRunupPct: number;
  exitUnrealizedPct: number;
  holdSec?: number;
  entryQualityScore?: number | null;
  pclPartialTaken?: boolean;
  exitReason?: string;
  exitKey?: string;
  entryStyle?: string | null;
  lateChaseAtEntry?: boolean;
  learningTags?: string[] | null;
}): number {
  try {
    const cfg = getProfitCaptureLayerConfig();
    if (!cfg.enabled) return 0;
    const strength = cfg.learningStrength;
    if (!(strength > 0)) return 0;

    const pnl = Number(input.pnlPct) || 0;
    const mfe = Math.max(0, Number(input.maxRunupPct) || 0);
    const exitU = Number.isFinite(input.exitUnrealizedPct)
      ? Number(input.exitUnrealizedPct)
      : pnl;
    const capture = mfe > 0.5 ? Math.max(0, Math.min(1.2, exitU / mfe)) : 0;
    const reason = String(input.exitReason || '').toLowerCase();
    const key = String(input.exitKey || '').toLowerCase();
    const q =
      input.entryQualityScore != null &&
      Number.isFinite(Number(input.entryQualityScore))
        ? Number(input.entryQualityScore)
        : null;
    const late = input.lateChaseAtEntry === true;
    const style = String(input.entryStyle || '');
    const validStyle =
      style.length > 0 &&
      style !== 'late_chase' &&
      style !== 'unknown' &&
      !late;

    let delta = 0;
    // Boost: MFE capture (reward realised harvest, not just "closed OK")
    if (capture >= 0.55 && mfe >= 8) {
      delta += 5 * capture;
      if (validStyle) delta += 1.5;
    } else if (capture >= 0.4 && mfe >= 6) {
      delta += 2.5 * capture;
    }
    const armedTag =
      (Array.isArray(input.learningTags) &&
        input.learningTags.includes('armed_trigger')) ||
      /scalp_reclaim_burst|support_dip_reclaim/i.test(style);
    if (armedTag && capture >= 0.45 && mfe >= 6) delta += 2;
    // Boost: partial reached
    if (
      input.pclPartialTaken ||
      /partial\s*tp\s*\(pcl\)|early partial|partial:/i.test(reason)
    ) {
      delta += 3;
      if (validStyle) delta += 1;
      if (armedTag) delta += 1.5;
    }
    // Boost: runner continuation (exit after partial with positive remainder)
    if (input.pclPartialTaken && pnl > 1) delta += 2.5;
    // Penalize: zero-MFE / DOA (never popped)
    if (mfe < 1.5) {
      delta -= 5;
      if (pnl <= 0) delta -= 1.5;
    }
    // Penalize: green→red (had MFE, closed red)
    if (mfe >= 1 && pnl < 0) {
      delta -= 4.5;
      if (mfe >= 6) delta -= 2;
    }
    // Penalize: tiny scratch + high MFE (scratchy soft-exits that prevent harvest)
    if (pnl > 0 && pnl < PCL_TINY_GREEN_SCRATCH_PCT && mfe >= 12) {
      delta -= 7;
      if (validStyle && q != null && q >= 70) delta -= 2;
    } else if (pnl > 0 && pnl < 5 && mfe >= 10 && capture < 0.35) {
      delta -= 5;
    } else if (pnl > 0 && pnl < 4 && mfe >= 6 && capture < 0.4) {
      delta -= 3;
    }
    // Penalize: low capture on meaningful MFE
    if (mfe >= 10 && capture < 0.3 && pnl >= 0) {
      delta -= 3;
    }
    // Penalize: early exits on high quality
    const hold = Math.max(0, Number(input.holdSec) || 0);
    if (
      q != null &&
      q >= 70 &&
      hold > 0 &&
      hold < 40 &&
      (key === 'fade' ||
        key === 'stall' ||
        key === 'dead_market' ||
        /stall|fade|dead/i.test(reason))
    ) {
      delta -= 4;
      if (validStyle) delta -= 1.5;
    }
    // Penalize: defensive exits before first profit stage
    if (
      !input.pclPartialTaken &&
      mfe < 6 &&
      pnl >= 0 &&
      pnl < 4 &&
      (/stall|dead.market|momentum fade|scratch/i.test(reason) ||
        key === 'stall' ||
        key === 'dead_market' ||
        key === 'fade')
    ) {
      delta -= 2.5;
    }
    // Late-chase outcome tags for analytics / soft learn
    if (
      late ||
      (Array.isArray(input.learningTags) &&
        input.learningTags.includes('late_chase_fail'))
    ) {
      if (pnl <= 0 || (hold < 45 && pnl < 4)) delta -= 3;
      else if (pnl > 5) delta += 0.5; // survived late chase — mild credit
    }

    return Number((delta * strength).toFixed(3));
  } catch {
    return 0;
  }
}
