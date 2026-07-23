/**
 * Strict Mode overlay — tightens wallet quality, conviction, clustering,
 * entry timing, volume filters, and exit discipline on top of the active
 * risk-level preset. Default OFF so existing settings keep working until
 * the user opts in.
 *
 * When ON, intensity (low / medium / high) scales how aggressive the overlay is.
 * Strict-Medium matches the original v1.1.33 single-level deltas.
 */

import { HARD_FILTER_FLOORS, config } from './config';

export type StrictModeIntensity = 'low' | 'medium' | 'high';

export const STRICT_MODE_WARNING =
  'Higher quality trades only – fewer but better setups';

export const STRICT_INTENSITY_META: Record<
  StrictModeIntensity,
  { label: string; shortLabel: string; description: string }
> = {
  low: {
    label: 'Strict-Low',
    shortLabel: 'Low',
    description: 'Most selective — highest quality bars, fewest trades',
  },
  medium: {
    label: 'Strict-Medium',
    shortLabel: 'Medium',
    description: 'Balanced strict overlay (default intensity)',
  },
  high: {
    label: 'Strict-High',
    shortLabel: 'High',
    description: 'Still strict but more active — lower bars than Low',
  },
};

/** Per-intensity deltas stacked on risk-level bases when Strict is ON. */
export const STRICT_INTENSITY_DELTAS: Record<
  StrictModeIntensity,
  {
    walletQualityAdd: number;
    convictionAdd: number;
    clusterMinAdd: number;
    entryAgeFactor: number;
    preferEntryFactor: number;
    volume24hAdd: number;
    recentVolumeAdd: number;
    recentBuyVolumeAdd: number;
    deadVolumeUsdFactor: number;
    deadVolumeHoursSubtract: number;
    deadVolumeHoldFactor: number;
    drawdownTighten: number;
    lowConvictionTrailAdd: number;
    lowConvictionTightenAdd: number;
  }
> = {
  // Most selective
  low: {
    walletQualityAdd: 15,
    convictionAdd: 18,
    clusterMinAdd: 2,
    entryAgeFactor: 0.55,
    preferEntryFactor: 0.55,
    volume24hAdd: 2_500,
    recentVolumeAdd: 250,
    recentBuyVolumeAdd: 200,
    deadVolumeUsdFactor: 0.6,
    deadVolumeHoursSubtract: 1,
    deadVolumeHoldFactor: 0.5,
    drawdownTighten: 12,
    lowConvictionTrailAdd: 12,
    lowConvictionTightenAdd: 4,
  },
  // Original v1.1.33 Strict deltas (default)
  medium: {
    walletQualityAdd: 10,
    convictionAdd: 12,
    clusterMinAdd: 1,
    entryAgeFactor: 0.67,
    preferEntryFactor: 0.7,
    volume24hAdd: 1_500,
    recentVolumeAdd: 150,
    recentBuyVolumeAdd: 120,
    deadVolumeUsdFactor: 0.75,
    deadVolumeHoursSubtract: 1,
    deadVolumeHoldFactor: 0.6,
    drawdownTighten: 8,
    lowConvictionTrailAdd: 8,
    lowConvictionTightenAdd: 3,
  },
  // Still strict, more active
  high: {
    walletQualityAdd: 5,
    convictionAdd: 6,
    clusterMinAdd: 0,
    entryAgeFactor: 0.8,
    preferEntryFactor: 0.85,
    volume24hAdd: 750,
    recentVolumeAdd: 75,
    recentBuyVolumeAdd: 60,
    deadVolumeUsdFactor: 0.85,
    deadVolumeHoursSubtract: 0,
    deadVolumeHoldFactor: 0.75,
    drawdownTighten: 4,
    lowConvictionTrailAdd: 4,
    lowConvictionTightenAdd: 2,
  },
};

export function isStrictModeIntensity(
  v: unknown
): v is StrictModeIntensity {
  return v === 'low' || v === 'medium' || v === 'high';
}

export function isStrictMode(): boolean {
  return config.strictMode === true;
}

/** Active intensity when Strict is ON; ignored when OFF. Default medium. */
export function getStrictModeIntensity(): StrictModeIntensity {
  const raw = config.strictModeIntensity;
  return isStrictModeIntensity(raw) ? raw : 'medium';
}

function deltas() {
  return STRICT_INTENSITY_DELTAS[getStrictModeIntensity()];
}

/** Min wallet quality — intensity bump (cap 85). */
export function effectiveMinWalletQualityScore(): number {
  const base = config.filters.minWalletQualityScore ?? 55;
  if (!isStrictMode()) return base;
  const d = deltas();
  return Math.min(85, Math.max(base, base + d.walletQualityAdd));
}

/** Min conviction — intensity bump (cap 80). */
export function effectiveMinConvictionScore(): number {
  const base = config.selective?.minConvictionScore ?? 40;
  if (!isStrictMode()) return base;
  const d = deltas();
  return Math.min(80, Math.max(base, base + d.convictionAdd));
}

/** Cluster / convergence wallet floor — intensity add (cap 5). */
export function effectiveClusterMinWallets(): number {
  const base = Math.max(
    1,
    config.filters.clusterMinWallets ?? 1,
    config.filters.convergenceRequired ?? 1,
    config.selective?.minWalletsForTrade ?? 1
  );
  if (!isStrictMode()) return base;
  const d = deltas();
  return Math.min(5, base + d.clusterMinAdd);
}

/** Max entry age minutes — shorter = stricter. */
export function effectiveMaxEntryAgeMinutes(): number {
  const base = config.filters.maxEntryAgeMinutes ?? 15;
  if (!isStrictMode()) return base;
  const d = deltas();
  return Math.max(5, Math.round(base * d.entryAgeFactor));
}

export function effectivePreferEntryWithinMinutes(): number {
  const base = config.filters.preferEntryWithinMinutes ?? 10;
  if (!isStrictMode()) return base;
  const d = deltas();
  return Math.max(3, Math.round(base * d.preferEntryFactor));
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
  const d = deltas();
  return Math.max(20, base - d.drawdownTighten);
}

/** Volume filters — intensity bump on top of risk-level / hard floors. */
export function effectiveStrictMinVolume24hUsd(): number {
  const base = Math.max(
    config.filters.minVolume24hUsd ?? 0,
    config.selective?.minVolume24hUsd ?? 0,
    HARD_FILTER_FLOORS.minVolume24hUsd
  );
  if (!isStrictMode()) return base;
  return base + deltas().volume24hAdd;
}

export function effectiveStrictMinRecentVolumeUsd(): number {
  const base = Math.max(
    config.filters.minRecentVolumeUsd ?? 0,
    HARD_FILTER_FLOORS.minRecentVolumeUsd
  );
  if (!isStrictMode()) return base;
  return base + deltas().recentVolumeAdd;
}

export function effectiveStrictMinRecentBuyVolumeUsd(): number {
  const base = Math.max(
    config.filters.minRecentBuyVolumeUsd ?? 0,
    HARD_FILTER_FLOORS.minRecentBuyVolumeUsd
  );
  if (!isStrictMode()) return base;
  return base + deltas().recentBuyVolumeAdd;
}

export function effectiveDeadVolumeUsdPerHour(): number {
  const base = config.risk.deadVolumeUsdPerHour ?? 60;
  if (!isStrictMode()) return base;
  const d = deltas();
  return Math.max(30, Math.round(base * d.deadVolumeUsdFactor));
}

export function effectiveDeadVolumeConsecutiveHours(): number {
  const base = config.risk.deadVolumeConsecutiveHours ?? 2;
  if (!isStrictMode()) return base;
  const d = deltas();
  return Math.max(1, base - d.deadVolumeHoursSubtract);
}

export function effectiveDeadVolumeMinHoldMinutes(): number {
  const base = config.risk.deadVolumeMinHoldMinutes ?? 15;
  if (!isStrictMode()) return base;
  const d = deltas();
  return Math.max(5, Math.round(base * d.deadVolumeHoldFactor));
}

/** Low-conviction trail threshold — Strict raises bar. */
export function effectiveLowConvictionTrailThreshold(): number {
  const base = config.risk.lowConvictionTrailThreshold ?? 50;
  if (!isStrictMode()) return base;
  const d = deltas();
  return Math.min(70, base + d.lowConvictionTrailAdd);
}

export function effectiveLowConvictionTrailTightenPct(): number {
  const base = config.risk.lowConvictionTrailTightenPct ?? 6;
  if (!isStrictMode()) return base;
  const d = deltas();
  return Math.min(15, base + d.lowConvictionTightenAdd);
}

export function getStrictModeStatus(): {
  enabled: boolean;
  intensity: StrictModeIntensity;
  intensityLabel: string;
  intensityDescription: string;
  warning: string | null;
  effective: {
    minWalletQualityScore: number;
    minConvictionScore: number;
    clusterMinWallets: number;
    maxEntryAgeMinutes: number;
    preferEntryWithinMinutes: number;
    requireMomentum: boolean;
    minVolume24hUsd: number;
    minRecentVolumeUsd: number;
    minRecentBuyVolumeUsd: number;
    deadVolumeUsdPerHour: number;
    deadVolumeConsecutiveHours: number;
    deadVolumeMinHoldMinutes: number;
  };
} {
  const enabled = isStrictMode();
  const intensity = getStrictModeIntensity();
  const meta = STRICT_INTENSITY_META[intensity];
  return {
    enabled,
    intensity,
    intensityLabel: meta.label,
    intensityDescription: meta.description,
    warning: enabled ? STRICT_MODE_WARNING : null,
    effective: {
      minWalletQualityScore: effectiveMinWalletQualityScore(),
      minConvictionScore: effectiveMinConvictionScore(),
      clusterMinWallets: effectiveClusterMinWallets(),
      maxEntryAgeMinutes: effectiveMaxEntryAgeMinutes(),
      preferEntryWithinMinutes: effectivePreferEntryWithinMinutes(),
      requireMomentum: effectiveRequireMomentumConfirmation(),
      minVolume24hUsd: effectiveStrictMinVolume24hUsd(),
      minRecentVolumeUsd: effectiveStrictMinRecentVolumeUsd(),
      minRecentBuyVolumeUsd: effectiveStrictMinRecentBuyVolumeUsd(),
      deadVolumeUsdPerHour: effectiveDeadVolumeUsdPerHour(),
      deadVolumeConsecutiveHours: effectiveDeadVolumeConsecutiveHours(),
      deadVolumeMinHoldMinutes: effectiveDeadVolumeMinHoldMinutes(),
    },
  };
}
