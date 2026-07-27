/**
 * Block new buys when available SOL (or total equity) cannot fund a trade.
 * Used by paper + liveSimulation; live also benefits from a clear pre-check log.
 */

import { config, usesPaperAccounting } from './config';
import { logger } from './logger';
import { paperTrader } from './paperTrader';
import {
  notifyInsufficientFunds,
  notifyLowEquity,
} from './emailNotifications';

export type FundGateResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      neededSol: number;
      availableSol: number;
      totalEquitySol: number;
      positionsCostSol: number;
      positionsValueSol: number;
      openCount: number;
    };

/**
 * Ensure we can afford `neededSol` from available balance.
 * Also blocks when total equity is ~0 (nothing left to trade with).
 */
export function evaluateAffordability(neededSol: number): FundGateResult {
  const port = paperTrader.getPortfolioSummary();
  const availableSol = port.availableBalanceSol;
  const totalEquitySol = port.totalEquitySol;
  const need = Math.max(0, Number(neededSol) || 0);
  const minTrade = Math.max(
    0.001,
    Number(config.risk?.minTradeSol) || 0.01
  );

  if (!(totalEquitySol > 0) || totalEquitySol < minTrade * 0.5) {
    return {
      ok: false,
      reason: `No equity to open trades (equity ${totalEquitySol.toFixed(4)} SOL)`,
      neededSol: need,
      availableSol,
      totalEquitySol,
      positionsCostSol: port.positionsCostSol,
      positionsValueSol: port.positionsValueSol,
      openCount: port.openCount,
    };
  }

  if (!(availableSol >= need) || !(availableSol >= minTrade && need > 0)) {
    const reason =
      need > 0 && availableSol < need
        ? `Insufficient available funds: need ${need.toFixed(4)} SOL, have ${availableSol.toFixed(4)} SOL ` +
          `(equity ${totalEquitySol.toFixed(4)}, ${port.openCount} open)`
        : `Insufficient available funds: ${availableSol.toFixed(4)} SOL free ` +
          `(equity ${totalEquitySol.toFixed(4)}, ${port.openCount} open) — top up or close trades`;
    return {
      ok: false,
      reason,
      neededSol: need > 0 ? need : minTrade,
      availableSol,
      totalEquitySol,
      positionsCostSol: port.positionsCostSol,
      positionsValueSol: port.positionsValueSol,
      openCount: port.openCount,
    };
  }

  return { ok: true };
}

/** Log + email side effects for a failed fund gate (deduped in email layer). */
export async function reportFundGateFailure(
  gate: Extract<FundGateResult, { ok: false }>,
  meta?: { mint?: string; symbol?: string }
): Promise<void> {
  logger.warn('Trade', gate.reason, {
    neededSol: gate.neededSol,
    availableSol: gate.availableSol,
    totalEquitySol: gate.totalEquitySol,
    positionsCostSol: gate.positionsCostSol,
    positionsValueSol: gate.positionsValueSol,
    openCount: gate.openCount,
    mint: meta?.mint,
    symbol: meta?.symbol,
    mode: config.mode,
  });

  // Always attempt insufficient-funds notify when the buy was blocked for funds
  void notifyInsufficientFunds({
    neededSol: gate.neededSol,
    availableSol: gate.availableSol,
    totalEquitySol: gate.totalEquitySol,
    positionsCostSol: gate.positionsCostSol,
    positionsValueSol: gate.positionsValueSol,
    openCount: gate.openCount,
    mint: meta?.mint,
    symbol: meta?.symbol,
    mode: config.mode,
  });

  // Also surface low-equity rule when under threshold
  const threshold = Number(config.notifications?.lowEquitySol) || 1;
  if (gate.totalEquitySol < threshold) {
    void notifyLowEquity({
      totalEquitySol: gate.totalEquitySol,
      availableSol: gate.availableSol,
      positionsSol: gate.positionsValueSol,
      openCount: gate.openCount,
      mode: config.mode,
    });
  }
}

/** Optional periodic equity check (call from position loop / status). */
export function maybeWarnLowEquity(): void {
  if (!usesPaperAccounting() && config.mode !== 'live') return;
  const port = paperTrader.getPortfolioSummary();
  const threshold = Number(config.notifications?.lowEquitySol) || 1;
  if (port.totalEquitySol < threshold) {
    void notifyLowEquity({
      totalEquitySol: port.totalEquitySol,
      availableSol: port.availableBalanceSol,
      positionsSol: port.positionsValueSol,
      openCount: port.openCount,
      mode: config.mode,
    });
  }
}
