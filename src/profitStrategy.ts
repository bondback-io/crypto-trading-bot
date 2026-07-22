/**
 * Advanced profit-taking strategy — shared by paper, live, and backtest.
 *
 * Stages (when enabled):
 *  1. Partial sell at +partialSellAt% (sell partialSellPercent of initial)
 *  2. Recover initial investment at +takeInitialPercent%
 *  3. Trim to bagPercent of initial (leave a runner)
 *  4. Arm trailing stop at +trailingStopAfter%
 *  5. Exit bag on trailing stop (or hard SL / max profit cap)
 */

import {
  config,
  type ProfitStrategyConfig,
  DEFAULT_PROFIT_STRATEGY,
  persistUserSettings,
} from './config';

export type { ProfitStrategyConfig };
export { DEFAULT_PROFIT_STRATEGY };

export interface ProfitPositionView {
  entryPriceSol: number;
  currentPriceSol: number;
  highWaterMarkSol: number;
  amountTokens: number;
  initialAmountTokens: number;
  initialCostSol: number;
  /** Net SOL returned from sells so far (for recover-initial calc) */
  solReturned: number;
  trailingActive: boolean;
  trailingStopPct: number;
  stopLossPct: number;
  /** Hard max profit % (from trade.maxProfitPercent) */
  maxProfitPct: number;
  initialRecovered: boolean;
  partialSellDone: boolean;
  bagTrimDone: boolean;
  riskScore?: number;
}

export type ProfitAction =
  | { type: 'none' }
  | { type: 'hard_sl'; reason: string }
  | {
      type: 'partial';
      sellPctOfInitial: number;
      tokensToSell?: number;
      reason: string;
      stage: 'partial' | 'recover_initial' | 'bag_trim' | 'max_profit';
    }
  | { type: 'full'; reason: string }
  | { type: 'arm_trail'; trailPct: number; reason: string }
  | { type: 'trail_exit'; reason: string };

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Effective parameters after optional risk-based tightening */
export function effectiveProfitParams(
  riskScore?: number
): ProfitStrategyConfig & { stopLossTightenPct: number } {
  const base = { ...config.profitStrategy };
  const highRisk =
    base.riskBasedAdjustment &&
    riskScore != null &&
    riskScore >= (base.highRiskScoreThreshold ?? 60);

  if (!highRisk) {
    return { ...base, stopLossTightenPct: 0 };
  }

  // High-risk: take profits earlier, tighter trail, harsher SL
  return {
    ...base,
    takeInitialPercent: Math.max(35, base.takeInitialPercent * 0.8),
    partialSellAt: Math.max(25, base.partialSellAt * 0.75),
    trailingStopAfter: Math.max(50, base.trailingStopAfter * 0.75),
    trailingStopPct: Math.max(8, base.trailingStopPct - 6),
    bagPercent: Math.max(15, base.bagPercent - 5),
    stopLossTightenPct: 0.25,
  };
}

export function adjustedStopLossPct(
  baseStopLossPct: number,
  riskScore?: number
): number {
  const params = effectiveProfitParams(riskScore);
  if (!params.stopLossTightenPct) return baseStopLossPct;
  // baseStopLossPct is negative; tighten = less room (closer to 0)
  return baseStopLossPct * (1 - params.stopLossTightenPct);
}

/**
 * Decide the next profit action for a position at the current price.
 * Caller applies one action per tick, then re-evaluates.
 */
export function evaluateProfitAction(pos: ProfitPositionView): ProfitAction {
  const ps = config.profitStrategy;
  if (!ps?.enabled) return { type: 'none' };

  const params = effectiveProfitParams(pos.riskScore);
  const entry = pos.entryPriceSol;
  if (!(entry > 0) || !(pos.currentPriceSol > 0)) return { type: 'none' };

  const pnlPct = ((pos.currentPriceSol - entry) / entry) * 100;
  const hardSl = adjustedStopLossPct(pos.stopLossPct, pos.riskScore);

  // 1) Hard stop-loss
  if (pnlPct <= hardSl) {
    return {
      type: 'hard_sl',
      reason: `Hard stop-loss ${hardSl.toFixed(0)}% (pnl ${pnlPct.toFixed(1)}%)`,
    };
  }

  const initialTokens = Math.max(pos.initialAmountTokens, 1e-12);
  const bagTokens = initialTokens * (params.bagPercent / 100);
  const remainingPctOfInitial = (pos.amountTokens / initialTokens) * 100;

  // 2) Milestone partial sell (e.g. +80% → sell 50% of initial)
  if (!pos.partialSellDone && pnlPct >= params.partialSellAt) {
    const sellPct = clamp(params.partialSellPercent, 1, 90);
    // Don't sell past bag floor in one go
    const maxSellPct = Math.max(0, remainingPctOfInitial - params.bagPercent);
    const effectiveSell = Math.min(sellPct, maxSellPct);
    if (effectiveSell >= 1) {
      return {
        type: 'partial',
        sellPctOfInitial: effectiveSell,
        stage: 'partial',
        reason: `Partial sell at +${params.partialSellAt.toFixed(0)}% — sold ${effectiveSell.toFixed(0)}% of initial (pnl +${pnlPct.toFixed(0)}%)`,
      };
    }
  }

  // 3) Recover initial investment (sell enough SOL ≈ unrecovered cost)
  if (!pos.initialRecovered && pnlPct >= params.takeInitialPercent) {
    const needSol = Math.max(0, pos.initialCostSol - (pos.solReturned || 0));
    if (needSol <= 1e-9) {
      // Already recovered via prior partials
      return {
        type: 'partial',
        sellPctOfInitial: 0,
        tokensToSell: 0,
        stage: 'recover_initial',
        reason: `Initial recovered (already returned ≥ cost) at +${pnlPct.toFixed(0)}%`,
      };
    }
    const price = pos.currentPriceSol;
    let tokensNeeded = needSol / price;
    // Leave bag running
    const maxSell = Math.max(0, pos.amountTokens - bagTokens);
    tokensNeeded = Math.min(tokensNeeded, maxSell, pos.amountTokens);
    if (tokensNeeded > 1e-9) {
      const sellPctOfInitial = (tokensNeeded / initialTokens) * 100;
      return {
        type: 'partial',
        sellPctOfInitial,
        tokensToSell: tokensNeeded,
        stage: 'recover_initial',
        reason: `Partial sell at +${params.takeInitialPercent.toFixed(0)}% — recovered initial (need ${needSol.toFixed(4)} SOL, pnl +${pnlPct.toFixed(0)}%)`,
      };
    }
    // Can't sell more without eating bag — mark recovered conceptually
    return {
      type: 'partial',
      sellPctOfInitial: 0,
      tokensToSell: 0,
      stage: 'recover_initial',
      reason: `Initial recover skipped (bag floor) at +${pnlPct.toFixed(0)}%`,
    };
  }

  // 4) Trim down to bag if still oversized after recover/partial
  if (
    pos.initialRecovered &&
    pos.partialSellDone &&
    !pos.bagTrimDone &&
    pos.amountTokens > bagTokens * 1.05
  ) {
    const excess = pos.amountTokens - bagTokens;
    const sellPctOfInitial = (excess / initialTokens) * 100;
    if (sellPctOfInitial >= 0.5) {
      return {
        type: 'partial',
        sellPctOfInitial,
        tokensToSell: excess,
        stage: 'bag_trim',
        reason: `Bag to ${params.bagPercent.toFixed(0)}% bag — sold excess runner fat (pnl +${pnlPct.toFixed(0)}%)`,
      };
    }
  }

  // 5) Max profit cap — close remaining if we hit the hard ceiling without trail
  const maxCap = pos.maxProfitPct;
  if (
    Number.isFinite(maxCap) &&
    maxCap > 0 &&
    pnlPct >= maxCap &&
    !pos.trailingActive
  ) {
    return {
      type: 'full',
      reason: `Max profit cap +${maxCap.toFixed(0)}% hit (pnl +${pnlPct.toFixed(0)}%) — closing remaining`,
    };
  }

  // 6) Arm trailing stop
  if (!pos.trailingActive && pnlPct >= params.trailingStopAfter) {
    return {
      type: 'arm_trail',
      trailPct: params.trailingStopPct,
      reason: `Trailing armed at +${params.trailingStopAfter.toFixed(0)}% — trail ${params.trailingStopPct.toFixed(0)}% from peak (pnl +${pnlPct.toFixed(0)}%)`,
    };
  }

  // 7) Trailing exit
  if (pos.trailingActive) {
    const trailPct = pos.trailingStopPct || params.trailingStopPct;
    const stop = pos.highWaterMarkSol * (1 - trailPct / 100);
    if (pos.currentPriceSol <= stop) {
      const drop =
        ((pos.currentPriceSol - pos.highWaterMarkSol) / pos.highWaterMarkSol) *
        100;
      return {
        type: 'trail_exit',
        reason: `Trailing stop ${trailPct.toFixed(0)}% (peak drop ${drop.toFixed(1)}%) — bag exit`,
      };
    }
  }

  return { type: 'none' };
}

export function updateProfitStrategyConfig(
  partial: Partial<ProfitStrategyConfig>
): ProfitStrategyConfig {
  config.profitStrategy = { ...config.profitStrategy, ...partial };
  // Keep risk trail activation loosely aligned when strategy enabled
  if (config.profitStrategy.enabled) {
    if (partial.trailingStopAfter != null) {
      config.risk.trailingActivationProfit = partial.trailingStopAfter;
    }
    if (partial.trailingStopPct != null) {
      config.risk.trailingStopPct = partial.trailingStopPct;
      config.risk.trailingStopPercent = partial.trailingStopPct;
    }
  }
  persistUserSettings();
  return { ...config.profitStrategy };
}
