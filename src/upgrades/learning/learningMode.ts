/**
 * 1.2.421 Learning Mode overlays. Pack OFF → null overlays (1.2.21 gates).
 */

import { HARD_FILTER_FLOORS } from '../../config';
import {
  isBotLearningPackOn,
  loadBotLearningSettings,
  type LearningModeStrictness,
} from './settings';

export interface LearningModeGateOverlays {
  minConviction: number;
  minCluster: number;
  minWalletQuality: number;
  minMarketCapMult: number;
  minLiquidityMult: number;
  autoScoreMinDelta: number;
}

const GATE_MATRIX: Record<LearningModeStrictness, LearningModeGateOverlays> = {
  stricter: {
    minConviction: 78,
    minCluster: 2,
    minWalletQuality: 62,
    minMarketCapMult: 1.15,
    minLiquidityMult: 1.1,
    autoScoreMinDelta: 4,
  },
  middle: {
    minConviction: 68,
    minCluster: 1,
    minWalletQuality: 52,
    minMarketCapMult: 0.95,
    minLiquidityMult: 0.95,
    autoScoreMinDelta: -2,
  },
  looser: {
    minConviction: 60,
    minCluster: 1,
    minWalletQuality: 45,
    minMarketCapMult: 0.9,
    minLiquidityMult: 0.9,
    autoScoreMinDelta: -3,
  },
};

export function isLearningModeActive(): boolean {
  if (!isBotLearningPackOn()) return false;
  return loadBotLearningSettings().learningMode.enabled === true;
}

export function getLearningModeGateOverlays(): LearningModeGateOverlays | null {
  if (!isLearningModeActive()) return null;
  return { ...GATE_MATRIX[loadBotLearningSettings().learningMode.strictness] };
}

function applyRelativeFloor(baseline: number, mult: number, absFloor: number): number {
  if (!Number.isFinite(baseline) || baseline <= 0) return baseline;
  return Math.max(absFloor, baseline * mult);
}

export function learningModeAdjustedMinMarketCap(baselineUsd: number): number {
  const o = getLearningModeGateOverlays();
  if (!o) return baselineUsd;
  return applyRelativeFloor(
    baselineUsd,
    o.minMarketCapMult,
    HARD_FILTER_FLOORS.minMarketCapUsd
  );
}

export function learningModeAdjustedMinLiquidity(baselineUsd: number): number {
  const o = getLearningModeGateOverlays();
  if (!o) return baselineUsd;
  return applyRelativeFloor(
    baselineUsd,
    o.minLiquidityMult,
    HARD_FILTER_FLOORS.minLiquidityUsd
  );
}

export function learningModeFairnessBump(episodeCount: number): number {
  if (!isLearningModeActive()) return 0;
  if (!loadBotLearningSettings().learningMode.fairnessBoost) return 0;
  const n = Math.max(0, episodeCount);
  if (n >= 40) return 0;
  return Math.round(((40 - n) / 40) * 8);
}
