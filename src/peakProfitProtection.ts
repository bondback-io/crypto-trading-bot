/**
 * Peak Profit Protection — soft additive exit layer.
 * Arms at a fraction of target TP; exits on proportional giveback from peak.
 * Never mutates hard TP/SL; legacy absolute profit-lock remains when PPP is off.
 */

import { config } from './config';

export interface PeakProfitProtectionConfig {
  enabled: boolean;
  /** Arm when peak PnL reaches this % of target TP (non-scalper default). */
  armOfTpPct: number;
  /** Exit when giveback from peak reaches this % of peak (non-scalper). */
  givebackOfPeakPct: number;
  /** More aggressive arm for fast/scalper-style profiles. */
  scalperArmOfTpPct: number;
  scalperGivebackOfPeakPct: number;
  /** After arm, if no new peak within this many seconds, tighten giveback (0 = off). */
  stalePeakTightenSec: number;
  /** Multiply giveback threshold by this when stale (e.g. 0.75 = tighter). */
  staleGivebackTightenMult: number;
}

export const DEFAULT_PEAK_PROFIT_PROTECTION: PeakProfitProtectionConfig = {
  enabled: true,
  armOfTpPct: 65,
  givebackOfPeakPct: 45,
  scalperArmOfTpPct: 60,
  scalperGivebackOfPeakPct: 40,
  stalePeakTightenSec: 45,
  staleGivebackTightenMult: 0.75,
};

/** Profiles that use scalper-strength defaults. */
export const PEAK_PROTECT_FAST_PROFILES = new Set([
  'scalper',
  'momentum_burst',
  'reversal_scalper',
  'migration_sniper',
]);

export function isPeakProtectFastProfile(
  profileId: string | null | undefined
): boolean {
  return PEAK_PROTECT_FAST_PROFILES.has(String(profileId || ''));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function getPeakProfitProtectionConfig(): PeakProfitProtectionConfig {
  const raw = (config as { peakProfitProtection?: Partial<PeakProfitProtectionConfig> })
    .peakProfitProtection;
  const d = DEFAULT_PEAK_PROFIT_PROTECTION;
  return {
    enabled: raw?.enabled !== false,
    armOfTpPct: clamp(Number(raw?.armOfTpPct) || d.armOfTpPct, 10, 95),
    givebackOfPeakPct: clamp(
      Number(raw?.givebackOfPeakPct) || d.givebackOfPeakPct,
      10,
      80
    ),
    scalperArmOfTpPct: clamp(
      Number(raw?.scalperArmOfTpPct) || d.scalperArmOfTpPct,
      10,
      95
    ),
    scalperGivebackOfPeakPct: clamp(
      Number(raw?.scalperGivebackOfPeakPct) || d.scalperGivebackOfPeakPct,
      10,
      80
    ),
    stalePeakTightenSec: clamp(
      Number(raw?.stalePeakTightenSec ?? d.stalePeakTightenSec),
      0,
      600
    ),
    staleGivebackTightenMult: clamp(
      Number(raw?.staleGivebackTightenMult) || d.staleGivebackTightenMult,
      0.4,
      1
    ),
  };
}

export function setPeakProfitProtectionConfig(
  patch: Partial<PeakProfitProtectionConfig>
): PeakProfitProtectionConfig {
  const cur = getPeakProfitProtectionConfig();
  const next: PeakProfitProtectionConfig = {
    enabled:
      typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
    armOfTpPct:
      patch.armOfTpPct != null && Number.isFinite(Number(patch.armOfTpPct))
        ? clamp(Number(patch.armOfTpPct), 10, 95)
        : cur.armOfTpPct,
    givebackOfPeakPct:
      patch.givebackOfPeakPct != null &&
      Number.isFinite(Number(patch.givebackOfPeakPct))
        ? clamp(Number(patch.givebackOfPeakPct), 10, 80)
        : cur.givebackOfPeakPct,
    scalperArmOfTpPct:
      patch.scalperArmOfTpPct != null &&
      Number.isFinite(Number(patch.scalperArmOfTpPct))
        ? clamp(Number(patch.scalperArmOfTpPct), 10, 95)
        : cur.scalperArmOfTpPct,
    scalperGivebackOfPeakPct:
      patch.scalperGivebackOfPeakPct != null &&
      Number.isFinite(Number(patch.scalperGivebackOfPeakPct))
        ? clamp(Number(patch.scalperGivebackOfPeakPct), 10, 80)
        : cur.scalperGivebackOfPeakPct,
    stalePeakTightenSec:
      patch.stalePeakTightenSec != null &&
      Number.isFinite(Number(patch.stalePeakTightenSec))
        ? clamp(Number(patch.stalePeakTightenSec), 0, 600)
        : cur.stalePeakTightenSec,
    staleGivebackTightenMult:
      patch.staleGivebackTightenMult != null &&
      Number.isFinite(Number(patch.staleGivebackTightenMult))
        ? clamp(Number(patch.staleGivebackTightenMult), 0.4, 1)
        : cur.staleGivebackTightenMult,
  };
  (config as { peakProfitProtection: PeakProfitProtectionConfig }).peakProfitProtection =
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

export interface ResolvedPeakProtect {
  enabled: boolean;
  armOfTpPct: number;
  givebackOfPeakPct: number;
  /** Absolute unrealized % at which protection arms */
  armAtPct: number;
  stalePeakTightenSec: number;
  staleGivebackTightenMult: number;
  fastProfile: boolean;
  /** Min seconds open before PPP may arm (PCL). */
  minOpenSec: number;
  /** Do not PPP full-exit below this unrealized % once armed (hard SL still wins). */
  minProfitFloorPct: number;
}

/**
 * Resolve effective Peak Profit Protection params for a profile.
 * Profile exitPolicy overrides win over global scalper/non-scalper defaults.
 * Recovery Stage overrides remain authoritative when active.
 */
export function resolvePeakProtectParams(input: {
  profileId?: string | null;
  takeProfitPct: number;
  policyArmOfTpPct?: number | null;
  policyGivebackOfPeakPct?: number | null;
  /** PCL: bump arm later for high entry quality */
  entryQualityScore?: number | null;
  entryStyle?: string | null;
  lateChaseAtEntry?: boolean;
}): ResolvedPeakProtect {
  const cfg = getPeakProfitProtectionConfig();
  const fast = isPeakProtectFastProfile(input.profileId);
  let policyArm = input.policyArmOfTpPct;
  let policyGiveback = input.policyGivebackOfPeakPct;
  let recoveryActive = false;
  try {
    const { getRecoveryConstraints } =
      require('./fastProfileRecovery') as typeof import('./fastProfileRecovery');
    const rc = getRecoveryConstraints(input.profileId);
    if (rc.active) {
      recoveryActive = true;
      policyArm = rc.peakProtectArmOfTpPct;
      policyGiveback = rc.peakProtectGivebackOfPeakPct;
    }
  } catch {
    /* optional */
  }
  try {
    const { getDipBuyerRecoveryConstraints } =
      require('./dipBuyerRecovery') as typeof import('./dipBuyerRecovery');
    const dc = getDipBuyerRecoveryConstraints(input.profileId);
    if (dc.active) {
      recoveryActive = true;
      policyArm = dc.peakProtectArmOfTpPct;
      policyGiveback = dc.peakProtectGivebackOfPeakPct;
    }
  } catch {
    /* optional */
  }

  let pclMinOpen = 0;
  let pclMinFloor = 0;
  let pclArmFallback: number | null = null;
  let pclGiveFallback: number | null = null;
  try {
    const {
      isProfitCaptureLayerEnabled,
      resolvePclPppDefaults,
      qualityPppArmBonusPts,
    } = require('./profitCaptureLayer') as typeof import('./profitCaptureLayer');
    if (isProfitCaptureLayerEnabled()) {
      const pcl = resolvePclPppDefaults(input.profileId);
      pclMinOpen = pcl.minOpenSec;
      pclMinFloor = pcl.minProfitFloorPct;
      pclArmFallback = pcl.armOfTpPct;
      pclGiveFallback = pcl.givebackOfPeakPct;
      if (!recoveryActive) {
        const bonus = qualityPppArmBonusPts(input.entryQualityScore, {
          entryStyle: input.entryStyle,
          lateChaseAtEntry: input.lateChaseAtEntry,
        });
        if (bonus > 0 && policyArm != null && Number(policyArm) > 0) {
          policyArm = clamp(Number(policyArm) + bonus, 10, 95);
        } else if (bonus > 0) {
          pclArmFallback = clamp(pclArmFallback + bonus, 10, 95);
        }
      }
    }
  } catch {
    /* fail soft */
  }

  const armOfTp =
    policyArm != null &&
    Number.isFinite(Number(policyArm)) &&
    Number(policyArm) > 0
      ? clamp(Number(policyArm), 10, 95)
      : pclArmFallback != null
        ? pclArmFallback
        : fast
          ? cfg.scalperArmOfTpPct
          : cfg.armOfTpPct;
  const giveback =
    policyGiveback != null &&
    Number.isFinite(Number(policyGiveback)) &&
    Number(policyGiveback) > 0
      ? clamp(Number(policyGiveback), 10, 80)
      : pclGiveFallback != null
        ? pclGiveFallback
        : fast
          ? cfg.scalperGivebackOfPeakPct
          : cfg.givebackOfPeakPct;
  const tp = Math.max(0, Number(input.takeProfitPct) || 0);
  return {
    enabled: cfg.enabled && tp > 0,
    armOfTpPct: armOfTp,
    givebackOfPeakPct: giveback,
    armAtPct: tp > 0 ? (tp * armOfTp) / 100 : 0,
    stalePeakTightenSec: cfg.stalePeakTightenSec,
    staleGivebackTightenMult: cfg.staleGivebackTightenMult,
    fastProfile: fast,
    minOpenSec: recoveryActive ? 0 : pclMinOpen,
    minProfitFloorPct: recoveryActive ? 0 : pclMinFloor,
  };
}

export interface PeakProtectEvalInput {
  peakUnrealizedPct: number;
  pnlPct: number;
  takeProfitPct: number;
  profileId?: string | null;
  policyArmOfTpPct?: number | null;
  policyGivebackOfPeakPct?: number | null;
  /** When protection first armed (ms) */
  peakProtectArmedAt?: number | null;
  /** Last time a new peak was made (ms) */
  peakProtectLastPeakAt?: number | null;
  nowMs?: number;
  /** Optional Volume Intelligence giveback multiplier (1 = no change). */
  volumeExitTightenMult?: number | null;
  /** Position open time — for PCL minOpenSec before arm. */
  openedAt?: number | null;
  /** Defer arming while profit permission window is active. */
  deferArm?: boolean;
  /** After first PCL partial — tighten giveback on runner. */
  pclPartialTaken?: boolean;
  entryQualityScore?: number | null;
  entryStyle?: string | null;
  lateChaseAtEntry?: boolean;
  /** Override min profit floor (absolute unrealized %). */
  minProfitFloorPct?: number | null;
}

export interface PeakProtectEvalResult {
  armed: boolean;
  armAtPct: number;
  givebackOfPeakPct: number;
  effectiveGivebackOfPeakPct: number;
  shouldExit: boolean;
  reason: string;
  resolved: ResolvedPeakProtect;
}

/**
 * Soft Peak Profit Protection check. Full exit only; never blocks TP/SL.
 */
export function evaluatePeakProfitProtection(
  input: PeakProtectEvalInput
): PeakProtectEvalResult {
  const resolved = resolvePeakProtectParams({
    profileId: input.profileId,
    takeProfitPct: input.takeProfitPct,
    policyArmOfTpPct: input.policyArmOfTpPct,
    policyGivebackOfPeakPct: input.policyGivebackOfPeakPct,
    entryQualityScore: input.entryQualityScore,
    entryStyle: input.entryStyle,
    lateChaseAtEntry: input.lateChaseAtEntry,
  });
  const peak = Math.max(0, Number(input.peakUnrealizedPct) || 0);
  const pnl = Number(input.pnlPct) || 0;
  const empty: PeakProtectEvalResult = {
    armed: false,
    armAtPct: resolved.armAtPct,
    givebackOfPeakPct: resolved.givebackOfPeakPct,
    effectiveGivebackOfPeakPct: resolved.givebackOfPeakPct,
    shouldExit: false,
    reason: '',
    resolved,
  };
  if (!resolved.enabled || resolved.armAtPct <= 0) return empty;

  const now = input.nowMs ?? Date.now();
  if (input.deferArm) {
    return { ...empty, armed: false };
  }
  if (resolved.minOpenSec > 0 && input.openedAt != null) {
    const openSec = (now - Number(input.openedAt)) / 1000;
    if (openSec < resolved.minOpenSec) {
      return { ...empty, armed: false };
    }
  }

  const armed = peak >= resolved.armAtPct;
  if (!armed) {
    return { ...empty, armed: false };
  }

  let effGive = resolved.givebackOfPeakPct;
  const armedAt = Number(input.peakProtectArmedAt) || 0;
  const lastPeak =
    Number(input.peakProtectLastPeakAt) || armedAt || now;
  if (
    resolved.stalePeakTightenSec > 0 &&
    armedAt > 0 &&
    now - lastPeak >= resolved.stalePeakTightenSec * 1000
  ) {
    effGive = clamp(
      resolved.givebackOfPeakPct * resolved.staleGivebackTightenMult,
      8,
      80
    );
  }

  // Additive Volume Intelligence — decay / bearish-div tighten (never loosens)
  const volTighten = Number(input.volumeExitTightenMult);
  if (Number.isFinite(volTighten) && volTighten > 0 && volTighten < 1) {
    effGive = clamp(effGive * volTighten, 8, 80);
  }

  // After first partial: stronger PPP on runner (giveback ×0.85)
  if (input.pclPartialTaken) {
    try {
      const { PCL_POST_PARTIAL_GIVEBACK_MULT, isProfitCaptureLayerEnabled } =
        require('./profitCaptureLayer') as typeof import('./profitCaptureLayer');
      if (isProfitCaptureLayerEnabled()) {
        effGive = clamp(effGive * PCL_POST_PARTIAL_GIVEBACK_MULT, 8, 80);
      }
    } catch {
      /* fail soft */
    }
  }

  if (peak <= 0) {
    return {
      ...empty,
      armed: true,
      effectiveGivebackOfPeakPct: effGive,
    };
  }

  const floor =
    input.minProfitFloorPct != null &&
    Number.isFinite(Number(input.minProfitFloorPct))
      ? Math.max(0, Number(input.minProfitFloorPct))
      : resolved.minProfitFloorPct;

  const givebackPctOfPeak = ((peak - pnl) / peak) * 100;
  if (givebackPctOfPeak >= effGive) {
    // PCL min profit floor — do not full-exit below floor (hard SL still wins)
    if (floor > 0 && pnl < floor) {
      return {
        armed: true,
        armAtPct: resolved.armAtPct,
        givebackOfPeakPct: resolved.givebackOfPeakPct,
        effectiveGivebackOfPeakPct: effGive,
        shouldExit: false,
        reason: '',
        resolved,
      };
    }
    const reason = `Peak protection exit from +${peak.toFixed(1)}% peak, giveback limit hit (mark +${pnl.toFixed(1)}%, giveback ${givebackPctOfPeak.toFixed(0)}% of peak ≥ ${effGive.toFixed(0)}%)`;
    return {
      armed: true,
      armAtPct: resolved.armAtPct,
      givebackOfPeakPct: resolved.givebackOfPeakPct,
      effectiveGivebackOfPeakPct: effGive,
      shouldExit: true,
      reason,
      resolved,
    };
  }

  return {
    armed: true,
    armAtPct: resolved.armAtPct,
    givebackOfPeakPct: resolved.givebackOfPeakPct,
    effectiveGivebackOfPeakPct: effGive,
    shouldExit: false,
    reason: '',
    resolved,
  };
}

/** Soft heuristic: did protection bank something vs never reaching TP? */
export function peakProtectBeatFullTpHeuristic(input: {
  exitReason?: string;
  peakUnrealizedPct: number;
  exitUnrealizedPct: number;
  takeProfitPct: number;
  peakProtectArmed?: boolean;
  givebackFromPeakPct?: number;
}): boolean | undefined {
  const peak = Number(input.peakUnrealizedPct) || 0;
  const exit = Number(input.exitUnrealizedPct) || 0;
  const tp = Number(input.takeProfitPct) || 0;
  const giveback = Math.max(0, Number(input.givebackFromPeakPct) || 0);
  const isPppExit = /peak\s*protection/i.test(String(input.exitReason || ''));

  if (isPppExit) {
    if (!(tp > 0)) return undefined;
    // Never reached TP — protection may have banked vs fade to SL
    if (peak < tp) return true;
    // Peaked at/above TP but exited below — left TP on table
    if (peak >= tp && exit < tp) return false;
    return undefined;
  }

  // Near-miss denser label: armed, large giveback, didn't exit via PPP
  if (
    input.peakProtectArmed === true &&
    giveback >= 12 &&
    peak >= Math.max(8, tp * 0.55) &&
    exit < peak * 0.75
  ) {
    return false;
  }
  return undefined;
}

/** Armed + large giveback without PPP exit — sparse signal densifier. */
export function peakProtectNearMissHeuristic(input: {
  exitReason?: string;
  peakProtectArmed?: boolean;
  givebackFromPeakPct?: number;
  peakUnrealizedPct?: number;
}): boolean | undefined {
  if (/peak\s*protection/i.test(String(input.exitReason || ''))) return false;
  if (input.peakProtectArmed !== true) return undefined;
  const giveback = Math.max(0, Number(input.givebackFromPeakPct) || 0);
  const peak = Math.max(0, Number(input.peakUnrealizedPct) || 0);
  if (giveback >= 12 && peak >= 8) return true;
  return undefined;
}
