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
  'Higher quality trades only – fewer but better setups. Intensity: Low = safest/most selective; High = more active (looser), not safer.';

export const STRICT_INTENSITY_META: Record<
  StrictModeIntensity,
  { label: string; shortLabel: string; description: string }
> = {
  low: {
    label: 'Strict-Low',
    shortLabel: 'Low',
    description:
      'Most selective / safest Strict — highest quality bars, fewest trades; forces Elite + hard quality + early entry + momentum + profit protection (NOT “low risk mode”)',
  },
  medium: {
    label: 'Strict-Medium',
    shortLabel: 'Medium',
    description:
      'Balanced strict overlay — momentum + bonding + profit protection on top of Risk recipe',
  },
  high: {
    label: 'Strict-High',
    shortLabel: 'High',
    description:
      'More active Strict — requires momentum confirmation; looser than Low/Medium (NOT safer than Strict-Low)',
  },
};

/** Per-intensity max entry MC (USD) when Strict is ON — blocks already-pumped dumps. */
export const STRICT_MAX_ENTRY_MC_USD: Record<StrictModeIntensity, number> = {
  low: 150_000,
  medium: 400_000,
  high: 800_000,
};

/** Above this MC under Strict, require extra conviction / cluster. */
export const STRICT_HIGH_MC_SOFT_USD = 100_000;

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
    /** Extra momentum hold floor (percentage points; more negative base becomes less permissive) */
    momentumMinHoldAdd: number;
    /** Extra conviction required when entry MC ≥ STRICT_HIGH_MC_SOFT_USD */
    highMcConvictionAdd: number;
    /** Extra cluster wallets when entry MC ≥ STRICT_HIGH_MC_SOFT_USD */
    highMcClusterAdd: number;
  }
> = {
  // Most selective — max quality / win-rate bias
  low: {
    walletQualityAdd: 18,
    convictionAdd: 20,
    clusterMinAdd: 2,
    entryAgeFactor: 0.5,
    preferEntryFactor: 0.5,
    volume24hAdd: 3_000,
    recentVolumeAdd: 350,
    recentBuyVolumeAdd: 250,
    deadVolumeUsdFactor: 0.55,
    deadVolumeHoursSubtract: 1,
    deadVolumeHoldFactor: 0.45,
    drawdownTighten: 14,
    lowConvictionTrailAdd: 14,
    lowConvictionTightenAdd: 5,
    momentumMinHoldAdd: 6,
    highMcConvictionAdd: 18,
    highMcClusterAdd: 2,
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
    momentumMinHoldAdd: 3,
    highMcConvictionAdd: 12,
    highMcClusterAdd: 1,
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
    drawdownTighten: 6,
    lowConvictionTrailAdd: 4,
    lowConvictionTightenAdd: 2,
    momentumMinHoldAdd: 2,
    highMcConvictionAdd: 10,
    highMcClusterAdd: 1,
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
  let score = base;
  if (isStrictMode()) {
    const d = deltas();
    score = Math.min(85, Math.max(base, base + d.walletQualityAdd));
  }
  try {
    const { getQualityModeOverlays } =
      require('./strategies') as typeof import('./strategies');
    const ov = getQualityModeOverlays().minWalletQualityScore;
    if (ov != null) score = Math.max(score, ov);
  } catch {
    /* ignore bootstrap */
  }
  return Math.min(85, score);
}

/** Min conviction — intensity bump (cap 80). */
export function effectiveMinConvictionScore(): number {
  const base = config.selective?.minConvictionScore ?? 40;
  let score = base;
  if (isStrictMode()) {
    const d = deltas();
    score = Math.min(80, Math.max(base, base + d.convictionAdd));
  }
  try {
    const { getQualityModeOverlays } =
      require('./strategies') as typeof import('./strategies');
    const ov = getQualityModeOverlays().minConvictionScore;
    if (ov != null) score = Math.max(score, ov);
  } catch {
    /* ignore bootstrap */
  }
  return Math.min(80, score);
}

/** Cluster / convergence wallet floor — intensity add (cap 5). */
export function effectiveClusterMinWallets(): number {
  const base = Math.max(
    1,
    config.filters.clusterMinWallets ?? 1,
    config.filters.convergenceRequired ?? 1,
    config.selective?.minWalletsForTrade ?? 1
  );
  let floor = base;
  if (isStrictMode()) {
    const d = deltas();
    floor = Math.min(5, base + d.clusterMinAdd);
  }
  try {
    const { getQualityModeOverlays } =
      require('./strategies') as typeof import('./strategies');
    const ov = getQualityModeOverlays().minClusterWallets;
    if (ov != null) floor = Math.max(floor, ov);
  } catch {
    /* ignore bootstrap */
  }
  return Math.min(5, floor);
}

/** Max entry age minutes — shorter = stricter. */
export function effectiveMaxEntryAgeMinutes(): number {
  const base = config.filters.maxEntryAgeMinutes ?? 15;
  let age = base;
  if (isStrictMode()) {
    const d = deltas();
    age = Math.max(5, Math.round(base * d.entryAgeFactor));
  }
  try {
    const { getQualityModeOverlays } =
      require('./strategies') as typeof import('./strategies');
    const ov = getQualityModeOverlays().maxEntryAgeMinutes;
    if (ov != null) age = Math.min(age, ov);
  } catch {
    /* ignore bootstrap */
  }
  return Math.max(3, age);
}

export function effectivePreferEntryWithinMinutes(): number {
  const base = config.filters.preferEntryWithinMinutes ?? 10;
  let pref = base;
  if (isStrictMode()) {
    const d = deltas();
    pref = Math.max(3, Math.round(base * d.preferEntryFactor));
  }
  try {
    const { getQualityModeOverlays } =
      require('./strategies') as typeof import('./strategies');
    const ov = getQualityModeOverlays().preferEntryWithinMinutes;
    if (ov != null) pref = Math.min(pref, ov);
  } catch {
    /* ignore bootstrap */
  }
  return Math.max(2, pref);
}

/** Require momentum when Strict is on (or when filter / quality modes require it).
 * Short-term scalper modes override for speed (still keeps hard safety floors elsewhere). */
export function effectiveRequireMomentumConfirmation(): boolean {
  try {
    const { isAnyShortTermScalperActive } =
      require('./shortTermStrategies') as typeof import('./shortTermStrategies');
    if (isAnyShortTermScalperActive()) return false;
  } catch {
    /* ignore bootstrap */
  }
  if (isStrictMode()) return true;
  if (config.filters.requireMomentumConfirmation === true) return true;
  try {
    const { getQualityModeOverlays } =
      require('./strategies') as typeof import('./strategies');
    return getQualityModeOverlays().forceMomentum === true;
  } catch {
    return false;
  }
}

export function effectiveRejectDumpingToken(): boolean {
  if (isStrictMode()) return true;
  return config.filters.rejectDumpingToken !== false;
}

export function effectiveMaxDrawdownFromRecentHighPct(): number {
  const base = config.filters.maxDrawdownFromRecentHighPct ?? 35;
  if (!isStrictMode()) return base;
  const d = deltas();
  return Math.max(18, base - d.drawdownTighten);
}

/**
 * Max entry market-cap USD. Strict intensity caps block already-pumped MCs
 * that tend to dump. Config `maxEntryMarketCapUsd` (when >0) is an additional
 * ceiling even when Strict is OFF.
 * Returns 0 when unlimited.
 */
export function effectiveMaxEntryMarketCapUsd(): number {
  const configured = Number(config.filters.maxEntryMarketCapUsd ?? 0);
  const configCap =
    Number.isFinite(configured) && configured > 0 ? configured : 0;
  if (!isStrictMode()) return configCap;
  const strictCap = STRICT_MAX_ENTRY_MC_USD[getStrictModeIntensity()];
  if (configCap > 0) return Math.min(configCap, strictCap);
  return strictCap;
}

/** Momentum hold floor — Strict raises the bar (less negative / more positive). */
export function effectiveMomentumMinHoldPct(): number {
  const base = config.filters.momentumMinHoldPct ?? -5;
  if (!isStrictMode()) return base;
  return base + deltas().momentumMinHoldAdd;
}

/**
 * Min conviction for a given entry MC. Under Strict, high-MC entries need
 * stronger conviction so High risk + Strict-High cannot freely chase pumps.
 */
export function effectiveMinConvictionScoreForMc(
  entryMarketCapUsd?: number | null
): number {
  let min = effectiveMinConvictionScore();
  if (
    isStrictMode() &&
    entryMarketCapUsd != null &&
    Number.isFinite(entryMarketCapUsd) &&
    entryMarketCapUsd >= STRICT_HIGH_MC_SOFT_USD
  ) {
    min = Math.min(85, min + deltas().highMcConvictionAdd);
  }
  return min;
}

/** Cluster floor for a given entry MC (Strict bumps further on high MC). */
export function effectiveClusterMinWalletsForMc(
  entryMarketCapUsd?: number | null
): number {
  let min = effectiveClusterMinWallets();
  if (
    isStrictMode() &&
    entryMarketCapUsd != null &&
    Number.isFinite(entryMarketCapUsd) &&
    entryMarketCapUsd >= STRICT_HIGH_MC_SOFT_USD
  ) {
    min = Math.min(5, min + deltas().highMcClusterAdd);
  }
  return min;
}

export function effectiveDeadVolumeUsdPerHour(): number {
  const base = config.risk.deadVolumeUsdPerHour ?? 60;
  if (!isStrictMode()) return base;
  const d = deltas();
  return Math.max(30, Math.round(base * d.deadVolumeUsdFactor));
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

export function effectiveDeadVolumeConsecutiveHours(): number {
  const base = config.risk.deadVolumeConsecutiveHours ?? 2;
  let hours = base;
  if (isStrictMode()) {
    const d = deltas();
    hours = Math.max(1, base - d.deadVolumeHoursSubtract);
  }
  try {
    const {
      getQualityModeOverlays,
      QUALITY_MODE_FLOORS,
    } = require('./strategies') as typeof import('./strategies');
    if (getQualityModeOverlays().aggressiveDeadExit) {
      const {
        HIGH_WIN_RATE_THRESHOLDS,
        WIN_RATE_55_60_THRESHOLDS,
      } = require('./strategies') as typeof import('./strategies');
      const { config: cfg } = require('./config') as typeof import('./config');
      const aggressiveHours =
        cfg.strategyProfile === 'high_win_rate'
          ? HIGH_WIN_RATE_THRESHOLDS.deadVolumeConsecutiveHours
          : cfg.strategyProfile === 'win_rate_55_60'
            ? WIN_RATE_55_60_THRESHOLDS.deadVolumeConsecutiveHours
            : QUALITY_MODE_FLOORS.profitProtected.deadVolumeConsecutiveHours;
      hours = Math.min(hours, aggressiveHours);
    }
  } catch {
    /* ignore */
  }
  return Math.max(1, hours);
}

export function effectiveDeadVolumeMinHoldMinutes(): number {
  const base = config.risk.deadVolumeMinHoldMinutes ?? 15;
  let mins = base;
  if (isStrictMode()) {
    const d = deltas();
    mins = Math.max(5, Math.round(base * d.deadVolumeHoldFactor));
  }
  try {
    const {
      getQualityModeOverlays,
      QUALITY_MODE_FLOORS,
    } = require('./strategies') as typeof import('./strategies');
    if (getQualityModeOverlays().aggressiveDeadExit) {
      const {
        HIGH_WIN_RATE_THRESHOLDS,
        WIN_RATE_55_60_THRESHOLDS,
      } = require('./strategies') as typeof import('./strategies');
      const { config: cfg } = require('./config') as typeof import('./config');
      const aggressiveHold =
        cfg.strategyProfile === 'high_win_rate'
          ? HIGH_WIN_RATE_THRESHOLDS.deadVolumeMinHoldMinutes
          : cfg.strategyProfile === 'win_rate_55_60'
            ? WIN_RATE_55_60_THRESHOLDS.deadVolumeMinHoldMinutes
            : QUALITY_MODE_FLOORS.profitProtected.deadVolumeMinHoldMinutes;
      mins = Math.min(mins, aggressiveHold);
    }
  } catch {
    /* ignore */
  }
  return Math.max(5, mins);
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
    maxEntryMarketCapUsd: number;
    momentumMinHoldPct: number;
    maxDrawdownFromRecentHighPct: number;
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
      maxEntryMarketCapUsd: effectiveMaxEntryMarketCapUsd(),
      momentumMinHoldPct: effectiveMomentumMinHoldPct(),
      maxDrawdownFromRecentHighPct: effectiveMaxDrawdownFromRecentHighPct(),
      minVolume24hUsd: effectiveStrictMinVolume24hUsd(),
      minRecentVolumeUsd: effectiveStrictMinRecentVolumeUsd(),
      minRecentBuyVolumeUsd: effectiveStrictMinRecentBuyVolumeUsd(),
      deadVolumeUsdPerHour: effectiveDeadVolumeUsdPerHour(),
      deadVolumeConsecutiveHours: effectiveDeadVolumeConsecutiveHours(),
      deadVolumeMinHoldMinutes: effectiveDeadVolumeMinHoldMinutes(),
    },
  };
}
