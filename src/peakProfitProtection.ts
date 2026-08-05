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
  armOfTpPct: 50,
  givebackOfPeakPct: 33,
  scalperArmOfTpPct: 40,
  scalperGivebackOfPeakPct: 30,
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
}

/**
 * Resolve effective Peak Profit Protection params for a profile.
 * Profile exitPolicy overrides win over global scalper/non-scalper defaults.
 */
export function resolvePeakProtectParams(input: {
  profileId?: string | null;
  takeProfitPct: number;
  policyArmOfTpPct?: number | null;
  policyGivebackOfPeakPct?: number | null;
}): ResolvedPeakProtect {
  const cfg = getPeakProfitProtectionConfig();
  const fast = isPeakProtectFastProfile(input.profileId);
  let policyArm = input.policyArmOfTpPct;
  let policyGiveback = input.policyGivebackOfPeakPct;
  try {
    const { getRecoveryConstraints } =
      require('./fastProfileRecovery') as typeof import('./fastProfileRecovery');
    const rc = getRecoveryConstraints(input.profileId);
    if (rc.active) {
      policyArm = rc.peakProtectArmOfTpPct;
      policyGiveback = rc.peakProtectGivebackOfPeakPct;
    }
  } catch {
    /* optional */
  }
  const armOfTp =
    policyArm != null &&
    Number.isFinite(Number(policyArm)) &&
    Number(policyArm) > 0
      ? clamp(Number(policyArm), 10, 95)
      : fast
        ? cfg.scalperArmOfTpPct
        : cfg.armOfTpPct;
  const giveback =
    policyGiveback != null &&
    Number.isFinite(Number(policyGiveback)) &&
    Number(policyGiveback) > 0
      ? clamp(Number(policyGiveback), 10, 80)
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

  const armed = peak >= resolved.armAtPct;
  if (!armed) {
    return { ...empty, armed: false };
  }

  let effGive = resolved.givebackOfPeakPct;
  const now = input.nowMs ?? Date.now();
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

  if (peak <= 0) {
    return {
      ...empty,
      armed: true,
      effectiveGivebackOfPeakPct: effGive,
    };
  }

  const givebackPctOfPeak = ((peak - pnl) / peak) * 100;
  if (givebackPctOfPeak >= effGive) {
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
}): boolean | undefined {
  if (!/peak\s*protection/i.test(String(input.exitReason || ''))) {
    return undefined;
  }
  const peak = Number(input.peakUnrealizedPct) || 0;
  const exit = Number(input.exitUnrealizedPct) || 0;
  const tp = Number(input.takeProfitPct) || 0;
  if (!(tp > 0)) return undefined;
  // Never reached TP — protection may have banked vs fade to SL
  if (peak < tp) return true;
  // Peaked at/above TP but exited below — left TP on table
  if (peak >= tp && exit < tp) return false;
  return undefined;
}
