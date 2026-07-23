/**
 * Strict Mode overlay — tightens wallet quality, conviction, clustering,
 * entry timing, and exit discipline on top of the active risk-level preset.
 * Default OFF so existing settings keep working until the user opts in.
 */

import { config } from './config';

export const STRICT_MODE_WARNING =
  'Higher quality trades only – fewer but better setups';

export function isStrictMode(): boolean {
  return config.strictMode === true;
}

/** Min wallet quality — Strict bumps +10 (cap 85). */
export function effectiveMinWalletQualityScore(): number {
  const base = config.filters.minWalletQualityScore ?? 55;
  if (!isStrictMode()) return base;
  return Math.min(85, Math.max(base, base + 10));
}

/** Min conviction — Strict bumps +12 (cap 80). */
export function effectiveMinConvictionScore(): number {
  const base = config.selective?.minConvictionScore ?? 40;
  if (!isStrictMode()) return base;
  return Math.min(80, Math.max(base, base + 12));
}

/** Cluster / convergence wallet floor — Strict +1 (cap 5). */
export function effectiveClusterMinWallets(): number {
  const base = Math.max(
    1,
    config.filters.clusterMinWallets ?? 1,
    config.filters.convergenceRequired ?? 1,
    config.selective?.minWalletsForTrade ?? 1
  );
  if (!isStrictMode()) return base;
  return Math.min(5, base + 1);
}

/** Max entry age minutes — Strict shortens by ~33%. */
export function effectiveMaxEntryAgeMinutes(): number {
  const base = config.filters.maxEntryAgeMinutes ?? 15;
  if (!isStrictMode()) return base;
  return Math.max(5, Math.round(base * 0.67));
}

export function effectivePreferEntryWithinMinutes(): number {
  const base = config.filters.preferEntryWithinMinutes ?? 10;
  if (!isStrictMode()) return base;
  return Math.max(3, Math.round(base * 0.7));
}

/** Require momentum when Strict is on (or when filter already requires it). */
export function effectiveRequireMomentumConfirmation(): boolean {
  if (isStrictMode()) return true;
  return config.filters.requireMomentumConfirmation === true;
}

export function effectiveRejectDumpingToken(): boolean {
  if (isStrictMode()) return true;
  return config.filters.rejectDumpingToken !== false;
}

export function effectiveMaxDrawdownFromRecentHighPct(): number {
  const base = config.filters.maxDrawdownFromRecentHighPct ?? 35;
  if (!isStrictMode()) return base;
  return Math.max(20, base - 8);
}

export function effectiveDeadVolumeUsdPerHour(): number {
  const base = config.risk.deadVolumeUsdPerHour ?? 60;
  if (!isStrictMode()) return base;
  return Math.max(30, Math.round(base * 0.75));
}

export function effectiveDeadVolumeConsecutiveHours(): number {
  const base = config.risk.deadVolumeConsecutiveHours ?? 2;
  if (!isStrictMode()) return base;
  return Math.max(1, base - 1);
}

export function effectiveDeadVolumeMinHoldMinutes(): number {
  const base = config.risk.deadVolumeMinHoldMinutes ?? 15;
  if (!isStrictMode()) return base;
  return Math.max(5, Math.round(base * 0.6));
}

/** Low-conviction trail threshold — Strict raises bar. */
export function effectiveLowConvictionTrailThreshold(): number {
  const base = config.risk.lowConvictionTrailThreshold ?? 50;
  if (!isStrictMode()) return base;
  return Math.min(70, base + 8);
}

export function effectiveLowConvictionTrailTightenPct(): number {
  const base = config.risk.lowConvictionTrailTightenPct ?? 6;
  if (!isStrictMode()) return base;
  return Math.min(15, base + 3);
}

export function getStrictModeStatus(): {
  enabled: boolean;
  warning: string | null;
  effective: {
    minWalletQualityScore: number;
    minConvictionScore: number;
    clusterMinWallets: number;
    maxEntryAgeMinutes: number;
    requireMomentum: boolean;
    deadVolumeUsdPerHour: number;
    deadVolumeConsecutiveHours: number;
    deadVolumeMinHoldMinutes: number;
  };
} {
  const enabled = isStrictMode();
  return {
    enabled,
    warning: enabled ? STRICT_MODE_WARNING : null,
    effective: {
      minWalletQualityScore: effectiveMinWalletQualityScore(),
      minConvictionScore: effectiveMinConvictionScore(),
      clusterMinWallets: effectiveClusterMinWallets(),
      maxEntryAgeMinutes: effectiveMaxEntryAgeMinutes(),
      requireMomentum: effectiveRequireMomentumConfirmation(),
      deadVolumeUsdPerHour: effectiveDeadVolumeUsdPerHour(),
      deadVolumeConsecutiveHours: effectiveDeadVolumeConsecutiveHours(),
      deadVolumeMinHoldMinutes: effectiveDeadVolumeMinHoldMinutes(),
    },
  };
}
