/**
 * Advanced risk management — sizing, loss limits, drawdown, halt hooks.
 */

import {
  config,
  DEFAULT_RISK,
  DEFAULT_MAX_ALLOWED_TRADE_SOL,
  StrategyRiskRules,
  RiskConfig,
  persistUserSettings,
} from './config';
import { isStrategyEnabled } from './strategies';

export type { StrategyRiskRules, RiskConfig };
export { DEFAULT_RISK, DEFAULT_MAX_ALLOWED_TRADE_SOL };

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
/** After Clear halt, suppress re-arming the same reason until this time. */
let haltRearmBlockedUntil = 0;
let haltRearmBlockedReason: RiskHaltReason = null;

const HALT_REARM_GRACE_MS = 20 * 60_000;

export function onRiskHalt(handler: (reason: string) => void): void {
  pauseHandler = handler;
}

export function clearRiskHalt(): void {
  const prior = haltReason;
  halted = false;
  haltReason = null;
  if (prior) {
    haltRearmBlockedReason = prior;
    haltRearmBlockedUntil = Date.now() + HALT_REARM_GRACE_MS;
    console.log(
      `[risk] Halt cleared — trading may resume ` +
        `(${prior} re-arm grace ${Math.round(HALT_REARM_GRACE_MS / 60_000)}m)`
    );
  } else {
    console.log('[risk] Halt cleared — trading may resume');
  }
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
 * Prefer calculateDynamicPositionSize for risk/conviction-aware sizing.
 */
export function calculatePositionSizeSol(options: {
  equitySol: number;
  kind: 'migration' | 'normal';
  flatFallbackSol?: number;
  riskScore?: number;
  sizeMultiplier?: number;
}): number {
  return calculateDynamicPositionSize(options).sizeSol;
}

export interface DynamicSizeResult {
  sizeSol: number;
  baseSol: number;
  riskFactor: number;
  convictionFactor: number;
  migrationFactor: number;
  reason: string;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Hard ceiling on final entry size (SOL). Applies after all sizing math.
 * Clamps — never rejects. Shared choke for paper, live, and backtest.
 */
export function clampToMaxAllowedTradeSol(
  sizeSol: number,
  source = 'entry'
): number {
  const raw = Number(sizeSol);
  if (!Number.isFinite(raw) || raw <= 0) return raw;
  const cap = Number(config.trade?.maxAllowedTradeSol);
  const maxAllowed =
    Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_MAX_ALLOWED_TRADE_SOL;
  if (raw <= maxAllowed) return raw;
  const capped = Number(maxAllowed.toFixed(6));
  console.log(
    `[risk] Max Allowed Trade clamp (${source}): ${raw.toFixed(4)} → ${capped.toFixed(4)} SOL (cap ${maxAllowed})`
  );
  return capped;
}

/**
 * Dynamic position sizing from baseTradeAmountSol × risk × conviction.
 * High anti-rug risk score → smaller (down to riskMultiplier × base).
 * High conviction → larger (up to convictionMultiplier × base).
 */
export function calculateDynamicPositionSize(options: {
  equitySol: number;
  kind: 'migration' | 'normal';
  flatFallbackSol?: number;
  riskScore?: number;
  convictionScore?: number;
  sizeMultiplier?: number;
  /** Open positions — when set, size scales down as book fills toward maxConcurrent */
  openCount?: number;
}): DynamicSizeResult {
  const risk = config.risk ?? DEFAULT_RISK;
  const trade = config.trade;
  const rules = getStrategyRiskRules(options.kind);

  const baseSol =
    options.flatFallbackSol ??
    (trade.baseTradeAmountSol ?? trade.tradeAmountSol ?? 0.14);

  const riskFloor = trade.riskMultiplier ?? 0.4;
  const convCeil = trade.convictionMultiplier ?? 1.45;
  const maxRisk = config.filters.maxRiskScore || 70;

  // Risk factor: 1.0 at score 0 → riskFloor at maxRiskScore
  let riskFactor = 1;
  const riskScore = options.riskScore;
  if (riskScore != null && Number.isFinite(riskScore)) {
    const t = clamp01(riskScore / Math.max(1, maxRisk));
    riskFactor = 1 - t * (1 - riskFloor);
  }

  // Conviction factor: 1.0 below 50 → convCeil at 100
  let convictionFactor = 1;
  const conviction = options.convictionScore;
  if (conviction != null && Number.isFinite(conviction) && convCeil > 1) {
    const t = clamp01((conviction - 50) / 50);
    convictionFactor = 1 + t * (convCeil - 1);
  }

  // Optional external multiplier (selective sizing) — fold into risk side
  if (options.sizeMultiplier != null && options.sizeMultiplier > 0) {
    riskFactor *= options.sizeMultiplier;
  }

  const migrationFactor =
    options.kind === 'migration'
      ? config.strategy.migrationSizeMultiplier ?? 1
      : 1;

  let size = baseSol * riskFactor * convictionFactor * migrationFactor;

  // Concurrent-aware scale: shrink toward minTradeSol as open book fills
  let maxConc = Math.max(1, config.filters.maxConcurrentPositions || 1);
  try {
    const { learningModeAdjustedMaxConcurrent } =
      require('./learningMode') as typeof import('./learningMode');
    maxConc = learningModeAdjustedMaxConcurrent(maxConc);
  } catch {
    /* ignore */
  }
  const openCount =
    options.openCount != null && Number.isFinite(options.openCount)
      ? Math.max(0, options.openCount)
      : 0;
  let concurrentFactor = 1;
  if (maxConc >= 8 && openCount > 0) {
    const util = clamp01(openCount / maxConc);
    // At 0% util → 1.0; at 100% util → 0.35 (still above min clamp later)
    concurrentFactor = 1 - util * 0.65;
    size *= concurrentFactor;
  }

  // Optional portfolio %-of-equity override when risk engine sizing is on
  if (
    isStrategyEnabled('dynamic_position_sizing') &&
    risk.enabled &&
    risk.useRiskSizing &&
    options.equitySol > 0
  ) {
    const pct = rules.riskPercentPerTrade || risk.riskPercentPerTrade;
    let equitySize = options.equitySol * (pct / 100);
    if (rules.sizeMultiplier) equitySize *= rules.sizeMultiplier;
    // Blend: take the more conservative of equity sizing and dynamic base sizing
    size = Math.min(size, equitySize * riskFactor * convictionFactor);
  }

  size = Math.max(risk.minTradeSol, Math.min(risk.maxTradeSol, size));
  const hardCap = Math.max(risk.maxTradeSol, baseSol * 3);
  size = Math.min(size, hardCap);
  size = Math.max(risk.minTradeSol, Number(size.toFixed(4)));
  size = clampToMaxAllowedTradeSol(size, 'dynamicSizing');

  const parts: string[] = [];
  if (riskScore != null) {
    if (riskFactor < 0.75) {
      parts.push(`high risk score (${Math.round(riskScore)})`);
    } else if (riskFactor < 0.95) {
      parts.push(`moderate risk (${Math.round(riskScore)})`);
    } else {
      parts.push(`low risk (${Math.round(riskScore)})`);
    }
  }
  if (conviction != null && convictionFactor > 1.05) {
    parts.push(`high conviction (${Math.round(conviction)})`);
  } else if (conviction != null && conviction < 55) {
    parts.push(`low conviction (${Math.round(conviction)})`);
  }
  if (options.kind === 'migration' && migrationFactor > 1) {
    parts.push('migration priority');
  }
  if (concurrentFactor < 0.97) {
    parts.push(`concurrent ${openCount}/${maxConc}`);
  }
  if (parts.length === 0) parts.push('base size');

  const reason = `Dynamic size: ${size.toFixed(4)} SOL - ${parts.join(' + ')}`;

  return {
    sizeSol: size,
    baseSol,
    riskFactor: Number(riskFactor.toFixed(3)),
    convictionFactor: Number(convictionFactor.toFixed(3)),
    migrationFactor,
    reason,
  };
}

export function evaluateRiskLimits(input: {
  equitySol: number;
  dailyPnlSol: number;
  weeklyPnlSol: number;
}): RiskSnapshot {
  const risk = config.risk ?? DEFAULT_RISK;
  updatePeakEquity(input.equitySol);
  const drawdownPct = getDrawdownPct(input.equitySol);
  const dailyLimit = Number(config.filters?.dailyLossLimitSol) || 0;
  const weeklyLimit = Number(risk.weeklyLossLimitSol) || 0;

  let reason: RiskHaltReason = null;

  if (risk.enabled) {
    if (dailyLimit > 0 && input.dailyPnlSol <= -dailyLimit) reason = 'daily_loss';
    else if (weeklyLimit > 0 && input.weeklyPnlSol <= -weeklyLimit)
      reason = 'weekly_loss';
    else if (drawdownPct >= risk.maxDrawdownPct) reason = 'max_drawdown';
  }

  if (reason && risk.autoPauseOnLimit) {
    const now = Date.now();
    const graceActive =
      haltRearmBlockedReason === reason && now < haltRearmBlockedUntil;
    if (!graceActive) {
      triggerHalt(reason, input, drawdownPct);
    }
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
