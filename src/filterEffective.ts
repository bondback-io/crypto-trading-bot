/**
 * Effective filter / gate helpers — config + optional quality-module overlays.
 * Used under Risk On; Risk Off bypasses hard floors via hardFilterFloorsActive().
 *
 * When Smart Bot Profiles is ON and a specialty micro-bot gate is active,
 * WQ / cluster / conviction style floors are profile-owned (not max(global, profile)).
 */

import { HARD_FILTER_FLOORS, config, hardFilterFloorsActive } from './config';

function activeProfileStyleFloors():
  | {
      minWalletQuality: number;
      minWalletCount: number;
      minConviction: number;
      profileOwned: true;
    }
  | null {
  try {
    const { getActiveCascadeMatchFloors } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    const floors = getActiveCascadeMatchFloors();
    if (!floors.profileOwned) return null;
    return {
      minWalletQuality: floors.minWalletQuality,
      minWalletCount: floors.minWalletCount,
      minConviction: floors.minConviction,
      profileOwned: true,
    };
  } catch {
    return null;
  }
}

/** Min wallet quality — profile-owned under Smart Bot gate, else config + overlays. */
export function effectiveMinWalletQualityScore(): number {
  const profile = activeProfileStyleFloors();
  let score: number;
  if (profile) {
    score = profile.minWalletQuality;
  } else {
    const base = config.filters.minWalletQualityScore ?? 55;
    score = base;
    try {
      const { getQualityModeOverlays } =
        require('./strategies') as typeof import('./strategies');
      const ov = getQualityModeOverlays().minWalletQualityScore;
      if (ov != null) score = Math.max(score, ov);
    } catch {
      /* ignore bootstrap */
    }
  }
  try {
    const { isLearningModeActive, applyLearningMinOverlay } =
      require('./learningMode') as typeof import('./learningMode');
    if (isLearningModeActive()) {
      score = applyLearningMinOverlay(score, 'minWalletQuality');
    }
  } catch {
    /* ignore bootstrap */
  }
  return Math.min(85, score);
}

/** Min conviction — profile-owned under Smart Bot gate, else config + overlays. */
export function effectiveMinConvictionScore(): number {
  const profile = activeProfileStyleFloors();
  let score: number;
  if (profile) {
    score = profile.minConviction;
  } else {
    const base = config.selective?.minConvictionScore ?? 40;
    score = base;
    try {
      const { getQualityModeOverlays } =
        require('./strategies') as typeof import('./strategies');
      const ov = getQualityModeOverlays().minConvictionScore;
      if (ov != null) score = Math.max(score, ov);
    } catch {
      /* ignore bootstrap */
    }
  }
  try {
    const { isLearningModeActive, applyLearningMinOverlay } =
      require('./learningMode') as typeof import('./learningMode');
    if (isLearningModeActive()) {
      score = applyLearningMinOverlay(score, 'minConviction');
    }
  } catch {
    /* ignore bootstrap */
  }
  return Math.min(80, score);
}

/** Cluster / convergence wallet floor — profile-owned under Smart Bot gate, else config + overlays. */
export function effectiveClusterMinWallets(): number {
  const profile = activeProfileStyleFloors();
  let floor: number;
  if (profile) {
    floor = profile.minWalletCount;
  } else {
    const base = Math.max(
      1,
      config.filters.clusterMinWallets ?? 1,
      config.filters.convergenceRequired ?? 1,
      config.selective?.minWalletsForTrade ?? 1
    );
    floor = base;
    try {
      const { getQualityModeOverlays } =
        require('./strategies') as typeof import('./strategies');
      const ov = getQualityModeOverlays().minClusterWallets;
      if (ov != null) floor = Math.max(floor, ov);
    } catch {
      /* ignore bootstrap */
    }
  }
  try {
    const { isLearningModeActive, applyLearningMinOverlay } =
      require('./learningMode') as typeof import('./learningMode');
    if (isLearningModeActive()) {
      floor = applyLearningMinOverlay(floor, 'minCluster');
    }
  } catch {
    /* ignore bootstrap */
  }
  return Math.min(5, Math.max(1, floor));
}

/** Max entry age minutes. */
export function effectiveMaxEntryAgeMinutes(): number {
  const base = config.filters.maxEntryAgeMinutes ?? 15;
  let age = base;
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

/**
 * Require momentum when filter / quality modes require it.
 * Short-term scalper modes override for speed.
 */
export function effectiveRequireMomentumConfirmation(): boolean {
  try {
    const { isAnyShortTermScalperActive } =
      require('./shortTermStrategies') as typeof import('./shortTermStrategies');
    if (isAnyShortTermScalperActive()) return false;
  } catch {
    /* ignore bootstrap */
  }
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
  return config.filters.rejectDumpingToken !== false;
}

export function effectiveMaxDrawdownFromRecentHighPct(): number {
  return config.filters.maxDrawdownFromRecentHighPct ?? 35;
}

/** Max entry market-cap USD from config only (0 = unlimited). */
export function effectiveMaxEntryMarketCapUsd(): number {
  const configured = Number(config.filters.maxEntryMarketCapUsd ?? 0);
  return Number.isFinite(configured) && configured > 0 ? configured : 0;
}

export function effectiveMomentumMinHoldPct(): number {
  return config.filters.momentumMinHoldPct ?? -5;
}

export function effectiveMinConvictionScoreForMc(
  _entryMarketCapUsd?: number | null
): number {
  return effectiveMinConvictionScore();
}

export function effectiveClusterMinWalletsForMc(
  _entryMarketCapUsd?: number | null
): number {
  return effectiveClusterMinWallets();
}

export function effectiveDeadVolumeUsdPerHour(): number {
  return config.risk.deadVolumeUsdPerHour ?? 60;
}

/** Volume floors — respect Risk Off bypass. */
export function effectiveStrictMinVolume24hUsd(): number {
  if (!hardFilterFloorsActive()) {
    return Math.max(
      0,
      config.filters.minVolume24hUsd ?? 0,
      config.selective?.minVolume24hUsd ?? 0
    );
  }
  return Math.max(
    config.filters.minVolume24hUsd ?? 0,
    config.selective?.minVolume24hUsd ?? 0,
    HARD_FILTER_FLOORS.minVolume24hUsd
  );
}

export function effectiveStrictMinRecentVolumeUsd(): number {
  if (!hardFilterFloorsActive()) {
    return Math.max(0, config.filters.minRecentVolumeUsd ?? 0);
  }
  return Math.max(
    config.filters.minRecentVolumeUsd ?? 0,
    HARD_FILTER_FLOORS.minRecentVolumeUsd
  );
}

export function effectiveStrictMinRecentBuyVolumeUsd(): number {
  if (!hardFilterFloorsActive()) {
    return Math.max(0, config.filters.minRecentBuyVolumeUsd ?? 0);
  }
  return Math.max(
    config.filters.minRecentBuyVolumeUsd ?? 0,
    HARD_FILTER_FLOORS.minRecentBuyVolumeUsd
  );
}

export function effectiveDeadVolumeConsecutiveHours(): number {
  let hours = config.risk.deadVolumeConsecutiveHours ?? 2;
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
  let mins = config.risk.deadVolumeMinHoldMinutes ?? 15;
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

export function effectiveLowConvictionTrailThreshold(): number {
  return config.risk.lowConvictionTrailThreshold ?? 50;
}

export function effectiveLowConvictionTrailTightenPct(): number {
  return config.risk.lowConvictionTrailTightenPct ?? 6;
}
