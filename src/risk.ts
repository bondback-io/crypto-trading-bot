/**
 * Advanced risk management — sizing, loss limits, drawdown, halt hooks.
 */

import {
  config,
  DEFAULT_RISK,
  StrategyRiskRules,
  RiskConfig,
  persistUserSettings,
} from './config';

export type { StrategyRiskRules, RiskConfig };
export { DEFAULT_RISK };

export type RiskHaltReason =
  | 'daily_loss'
  | 'weekly_loss'
  | 'max_drawdown'
  | null;

export interface RiskSnapshot {
  enabled: boolean;
  equitySol: number;
  peakEquitySol: number;
  drawdownPct: number;
  dailyPnlSol: number;
  weeklyPnlSol: number;
  dailyLossLimitSol: number;
  weeklyLossLimitSol: number;
  maxDrawdownPct: number;
  haltReason: RiskHaltReason;
  halted: boolean;
  useRiskSizing: boolean;
  tieredSellEnabled: boolean;
}

let peakEquitySol = 0;
let halted = false;
let haltReason: RiskHaltReason = null;
let pauseHandler: ((reason: string) => void) | null = null;

export function onRiskHalt(handler: (reason: string) => void): void {
  pauseHandler = handler;
}

export function clearRiskHalt(): void {
  halted = false;
  haltReason = null;
  console.log('[risk] Halt cleared — trading may resume');
}

export function isRiskHalted(): boolean {
  return halted;
}

export function getRiskHaltReason(): RiskHaltReason {
  return haltReason;
}

export function getStrategyRiskRules(
  kind: 'migration' | 'normal'
): StrategyRiskRules {
  const risk = config.risk ?? DEFAULT_RISK;
  return kind === 'migration' ? { ...risk.migration } : { ...risk.normal };
}

export function computeEquitySol(
  balanceSol: number,
  openCostSol: number,
  openUnrealizedPnlSol = 0
): number {
  return balanceSol + openCostSol + openUnrealizedPnlSol;
}

export function updatePeakEquity(equitySol: number): number {
  if (equitySol > peakEquitySol) peakEquitySol = equitySol;
  if (peakEquitySol <= 0) peakEquitySol = Math.max(equitySol, 0);
  return peakEquitySol;
}

export function resetPeakEquity(equitySol: number): void {
  peakEquitySol = equitySol;
}

export function getDrawdownPct(equitySol: number): number {
  const peak = peakEquitySol > 0 ? peakEquitySol : equitySol;
  if (peak <= 0) return 0;
  return Math.max(0, ((peak - equitySol) / peak) * 100);
}

/**
 * Size a trade from portfolio risk %.
 * Falls back to flat tradeAmountSol when risk sizing disabled.
 */
export function calculatePositionSizeSol(options: {
  equitySol: number;
  kind: 'migration' | 'normal';
  flatFallbackSol?: number;
}): number {
  const risk = config.risk ?? DEFAULT_RISK;
  const rules = getStrategyRiskRules(options.kind);
  const flat =
    options.flatFallbackSol ??
    config.trade.tradeAmountSol *
      (options.kind === 'migration'
        ? config.strategy.migrationSizeMultiplier ?? 1
        : 1);

  if (!risk.enabled || !risk.useRiskSizing) {
    return Math.max(risk.minTradeSol, flat);
  }

  const pct = rules.riskPercentPerTrade || risk.riskPercentPerTrade;
  let size = options.equitySol * (pct / 100);
  if (rules.sizeMultiplier) size *= rules.sizeMultiplier;

  size = Math.max(risk.minTradeSol, Math.min(risk.maxTradeSol, size));
  const hardCap = Math.max(risk.maxTradeSol, config.trade.tradeAmountSol * 3);
  return Math.min(size, hardCap);
}

export function evaluateRiskLimits(input: {
  equitySol: number;
  dailyPnlSol: number;
  weeklyPnlSol: number;
}): RiskSnapshot {
  const risk = config.risk ?? DEFAULT_RISK;
  updatePeakEquity(input.equitySol);
  const drawdownPct = getDrawdownPct(input.equitySol);
  const dailyLimit = config.filters.dailyLossLimitSol;
  const weeklyLimit = risk.weeklyLossLimitSol;

  let reason: RiskHaltReason = null;

  if (risk.enabled) {
    if (input.dailyPnlSol <= -dailyLimit) reason = 'daily_loss';
    else if (input.weeklyPnlSol <= -weeklyLimit) reason = 'weekly_loss';
    else if (drawdownPct >= risk.maxDrawdownPct) reason = 'max_drawdown';
  }

  if (reason && risk.autoPauseOnLimit) {
    triggerHalt(reason, input, drawdownPct);
  }

  return {
    enabled: risk.enabled,
    equitySol: input.equitySol,
    peakEquitySol,
    drawdownPct,
    dailyPnlSol: input.dailyPnlSol,
    weeklyPnlSol: input.weeklyPnlSol,
    dailyLossLimitSol: dailyLimit,
    weeklyLossLimitSol: weeklyLimit,
    maxDrawdownPct: risk.maxDrawdownPct,
    haltReason: halted ? haltReason : reason,
    halted,
    useRiskSizing: risk.useRiskSizing,
    tieredSellEnabled: risk.tieredSellEnabled,
  };
}

function triggerHalt(
  reason: RiskHaltReason,
  input: { equitySol: number; dailyPnlSol: number; weeklyPnlSol: number },
  drawdownPct: number
): void {
  if (!reason) return;
  if (halted && haltReason === reason) return;

  halted = true;
  haltReason = reason;

  const msg =
    reason === 'daily_loss'
      ? `Daily loss limit hit (${input.dailyPnlSol.toFixed(4)} SOL)`
      : reason === 'weekly_loss'
        ? `Weekly loss limit hit (${input.weeklyPnlSol.toFixed(4)} SOL)`
        : `Max drawdown ${drawdownPct.toFixed(1)}% ≥ ${config.risk.maxDrawdownPct}%`;

  console.warn(`[risk] ⛔ AUTO-PAUSE — ${msg}`);
  pauseHandler?.(msg);
}

export function getRiskStatus(input: {
  equitySol: number;
  dailyPnlSol: number;
  weeklyPnlSol: number;
}): RiskSnapshot {
  return evaluateRiskLimits(input);
}

export function updateRiskConfig(partial: Partial<RiskConfig>): RiskConfig {
  const next = { ...config.risk, ...partial };
  if (partial.normal) {
    next.normal = { ...config.risk.normal, ...partial.normal };
  }
  if (partial.migration) {
    next.migration = { ...config.risk.migration, ...partial.migration };
  }
  // Keep trailingStopPercent ↔ trailingStopPct aliases in sync
  if (partial.trailingStopPercent != null) {
    next.trailingStopPct = partial.trailingStopPercent;
    next.trailingStopPercent = partial.trailingStopPercent;
  } else if (partial.trailingStopPct != null) {
    next.trailingStopPercent = partial.trailingStopPct;
    next.trailingStopPct = partial.trailingStopPct;
  }
  config.risk = next;
  persistUserSettings();
  return config.risk;
}
