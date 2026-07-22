/**
 * Backtest / advanced paper simulation.
 * Replays recent Pump.fun-style launches through an isolated PaperTrader
 * with realistic candle-driven price paths.
 */

import fs from 'fs';
import { config, randomTakeProfitPct } from './config';
import { PaperTrader, Position, paperTrader } from './paperTrader';
import {
  fetchRecentLaunches,
  fetchLivePriceSol,
  fetchSolUsdPrice,
  generateSyntheticLaunches,
  estimateRiskScoreHint,
  marketCapAtPrice,
  liquidityAtPrice,
  LaunchEvent,
} from './marketData';
import { cacheTokenMeta } from './tokenMeta';
import { logger } from './logger';
import {
  evaluateProfitAction,
  type ProfitPositionView,
} from './profitStrategy';
import { calculateDynamicPositionSize } from './risk';
import { dataFile, ensureDataDir } from './dataDir';

export type BacktestStrategyType =
  | 'convergence'
  | 'migration'
  | 'single'
  | 'auto';

export interface BacktestOptions {
  /** Start of window (ms). Default: now - 24h */
  fromMs?: number;
  /** End of window (ms). Default: now */
  toMs?: number;
  /** Hours lookback if from/to not set */
  hours?: number;
  /** Starting paper SOL */
  startingBalanceSol?: number;
  /** Max launches to simulate per run */
  maxTrades?: number;
  /** Independent simulation runs (Monte Carlo / reshuffle) */
  simulations?: number;
  /** Only trade migrated tokens */
  migrationsOnly?: boolean;
  /** Only Pump.fun / pre-migration curve tokens */
  pumpFunOnly?: boolean;
  /** Simulate dip re-entry after profitable TP */
  reBuyEnabled?: boolean;
  /** Min 24h volume USD (0 = off) */
  minVolumeUsd?: number;
  /** Strategy shaping wallet attribution */
  strategyType?: BacktestStrategyType;
  /** Min liquidity USD (0 = off) */
  minLiquidityUsd?: number;
  /** Min market cap / FDV USD (0 = off) */
  minMarketCapUsd?: number;
  /** Skip if risk hint ≥ this (0 = off) */
  maxRiskScore?: number;
  /** Use live DexScreener/GMGN data */
  useLiveData?: boolean;
  /** Allow synthetic fallback when live data empty */
  allowSynthetic?: boolean;
}

export type BacktestExitTakeStage =
  | 'partial'
  | 'recover_initial'
  | 'bag_trim'
  | 'trail'
  | 'take_profit'
  | 'stop_loss'
  | 'forced'
  | 'full'
  | 'other';

export interface BacktestExitTake {
  stage: BacktestExitTakeStage;
  label: string;
  /** SOL received from this sell slice (approx) */
  solOut?: number;
  pnlSol?: number;
}

export interface BacktestTradeResult {
  mint: string;
  symbol: string;
  name: string;
  source: string;
  migrated: boolean;
  isPumpFun: boolean;
  entryPriceSol: number;
  exitPriceSol: number;
  /** Cost basis (SOL) of the position */
  costSol: number;
  pnlSol: number;
  /** PnL in USD using solUsd rate */
  pnlUsd: number;
  /** SOL/USD rate used for this trade's $ display */
  solUsd: number;
  pnlPct: number;
  reason: string;
  /** Human-readable exit explanation (for UI tooltips) */
  reasonDetail?: string;
  /** Ordered staged takes: partial → recover initial → bag/remainder */
  exitTakes: BacktestExitTake[];
  /** Short path e.g. "Partial → Recovered initial → Trail bag" */
  profitPath: string;
  /** True if initial investment was recovered via staged sell */
  recoveredInitial: boolean;
  /** True if a partial milestone sell fired before final exit */
  partialTaken: boolean;
  launchedAt: number;
  /** When the smart wallet buy is modeled (signal time) */
  smartWalletEnteredAt: number;
  /** When this bot's copy buy fills (after copy delay) */
  openedAt: number;
  closedAt?: number;
  /** ms between smart-wallet entry and our copy fill */
  copyDelayMs: number;
  /** Hold duration in ms (our entry → exit) */
  holdingTimeMs: number;
  /** Worst unrealized % from entry during hold (≤ 0) */
  maxDrawdownPct: number;
  /** Best unrealized % from entry during hold */
  maxRunupPct: number;
  sourceNames: string[];
  smartWalletCount: number;
  /** Estimated liquidity USD at our entry */
  liquidityUsd?: number;
  /** Estimated liquidity when smart wallet entered */
  smartWalletLiquidityUsd?: number;
  /** Market cap USD at our entry (preferred display) */
  marketCapUsd?: number;
  entryMarketCapUsd?: number;
  exitMarketCapUsd?: number;
  /** Market cap when smart wallet entered (slightly before our copy) */
  smartWalletEntryMarketCapUsd?: number;
  /** Smart wallet fill price (SOL) */
  smartWalletEntryPriceSol?: number;
  volumeUsd?: number;
  riskScoreHint?: number;
  /** True if this was a re-buy after prior TP */
  isReBuy?: boolean;
  simulation?: number;
  /** Strategy bucket used for sizing / breakdown */
  strategyKind: 'migration' | 'normal';
  /** Effective fee+slippage bps modeled on this trade (round-trip estimate) */
  roundTripCostBps?: number;
}

export interface BacktestProgress {
  running: boolean;
  phase: string;
  current: number;
  total: number;
  pct: number;
  message: string;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface StrategyBreakdownMetrics {
  strategyKind: 'migration' | 'normal';
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  totalPnlSol: number;
  profitFactor: number;
  avgWinPct: number;
  avgLossPct: number;
  avgHoldMs: number;
  maxDrawdownPct: number;
}

export interface BacktestSummary {
  winRatePct: number;
  totalPnlSol: number;
  returnPct: number;
  avgWinPct: number;
  avgLossPct: number;
  avgWinSol: number;
  avgLossSol: number;
  avgHoldingMs: number;
  /** Average per-trade peak-to-trough drawdown while open */
  avgMaxDrawdownPct: number;
  /** Equity-curve max drawdown across the run */
  maxDrawdownPct: number;
  /** Gross wins ÷ gross losses (∞ → 999) */
  profitFactor: number;
  /**
   * Trade-return Sharpe: mean(pnlPct) / std(pnlPct).
   * Not annualized — useful for comparing runs of similar length.
   */
  sharpeRatio: number;
  /** Average PnL per trade in SOL */
  expectancySol: number;
  /** Estimated average round-trip fee+slip cost in bps */
  avgRoundTripCostBps: number;
  totalPnlUsd: number;
  solUsd: number;
  bestTrade: BacktestTradeResult | null;
  worstTrade: BacktestTradeResult | null;
  totalTrades: number;
  wins: number;
  losses: number;
  reBuyTrades: number;
  strategyBreakdown: StrategyBreakdownMetrics[];
}

export interface BacktestResult {
  ok: boolean;
  id: string;
  ranAt: number;
  options: {
    hours: number;
    maxTrades: number;
    simulations: number;
    migrationsOnly: boolean;
    pumpFunOnly: boolean;
    reBuyEnabled: boolean;
    minVolumeUsd: number;
    strategyType: BacktestStrategyType;
    minLiquidityUsd: number;
    minMarketCapUsd: number;
    maxRiskScore: number;
    useLiveData: boolean;
    allowSynthetic: boolean;
    startingBalanceSol: number;
  };
  period: { fromMs: number; toMs: number; hours: number };
  dataSource: string;
  eventsConsidered: number;
  tradesExecuted: number;
  simulationsRun: number;
  stats: ReturnType<PaperTrader['getStats']>;
  summary: BacktestSummary;
  aggregate?: {
    avgWinRatePct: number;
    avgNetPnlSol: number;
    avgReturnPct: number;
    runs: number;
  };
  charts: ReturnType<PaperTrader['getChartData']> & {
    pnlDistribution?: {
      labels: string[];
      counts: number[];
    };
    strategyBreakdown?: {
      labels: string[];
      pnlSol: number[];
      winRatePct: number[];
      trades: number[];
    };
  };
  trades: BacktestTradeResult[];
  skipped: { mint: string; reason: string }[];
  message: string;
}

const HISTORY_CAP = 20;
const history: BacktestResult[] = [];
let lastResult: BacktestResult | null = null;

let progress: BacktestProgress = {
  running: false,
  phase: 'idle',
  current: 0,
  total: 0,
  pct: 0,
  message: '',
  startedAt: null,
  finishedAt: null,
};

function setProgress(partial: Partial<BacktestProgress>): void {
  progress = { ...progress, ...partial };
  if (progress.total > 0) {
    progress.pct = Math.min(
      100,
      Math.round((progress.current / progress.total) * 100)
    );
  }
}

export function getBacktestProgress(): BacktestProgress {
  return { ...progress };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function historyFilePath(): string {
  return dataFile('backtest-history.json');
}

export function getLastBacktest(): BacktestResult | null {
  return lastResult;
}

export function getBacktestHistory(limit = 10): Array<{
  id: string;
  ranAt: number;
  message: string;
  summary: BacktestSummary;
  period: BacktestResult['period'];
  dataSource: string;
}> {
  return history.slice(0, limit).map((r) => ({
    id: r.id,
    ranAt: r.ranAt,
    message: r.message,
    summary: r.summary,
    period: r.period,
    dataSource: r.dataSource,
  }));
}

function persistHistory(): void {
  try {
    ensureDataDir();
    const slim = history.slice(0, HISTORY_CAP).map((r) => ({
      id: r.id,
      ranAt: r.ranAt,
      message: r.message,
      summary: r.summary,
      period: r.period,
      dataSource: r.dataSource,
      options: r.options,
      tradesExecuted: r.tradesExecuted,
    }));
    fs.writeFileSync(historyFilePath(), JSON.stringify(slim, null, 2), 'utf8');
  } catch (err) {
    logger.warn(
      'Backtest',
      'failed to persist history',
      err instanceof Error ? { error: err.message } : {}
    );
  }
}

function storeResult(result: BacktestResult): void {
  lastResult = result;
  history.unshift(result);
  if (history.length > HISTORY_CAP) history.length = HISTORY_CAP;
  persistHistory();
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function metricsForTrades(
  trades: BacktestTradeResult[],
  strategyKind: 'migration' | 'normal'
): StrategyBreakdownMetrics {
  const wins = trades.filter((t) => t.pnlSol > 0);
  const losses = trades.filter((t) => t.pnlSol <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlSol, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlSol, 0));
  const profitFactor =
    grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;

  // Equity-curve DD within this bucket (chronological)
  const sorted = [...trades].sort(
    (a, b) => (a.closedAt ?? a.openedAt) - (b.closedAt ?? b.openedAt)
  );
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of sorted) {
    equity += t.pnlSol;
    if (equity > peak) peak = equity;
    if (peak > 0) {
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
    }
  }

  return {
    strategyKind,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    totalPnlSol: Number(
      trades.reduce((s, t) => s + t.pnlSol, 0).toFixed(6)
    ),
    profitFactor: Number(profitFactor.toFixed(2)),
    avgWinPct: wins.length
      ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length
      : 0,
    avgLossPct: losses.length
      ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length
      : 0,
    avgHoldMs: trades.length
      ? trades.reduce((s, t) => s + t.holdingTimeMs, 0) / trades.length
      : 0,
    maxDrawdownPct: Number(maxDd.toFixed(2)),
  };
}

function buildSummary(
  trades: BacktestTradeResult[],
  solUsd = 150,
  startingBalanceSol = 10
): BacktestSummary {
  const wins = trades.filter((t) => t.pnlSol > 0);
  const losses = trades.filter((t) => t.pnlSol <= 0);
  const totalPnlSol = trades.reduce((s, t) => s + t.pnlSol, 0);
  const totalPnlUsd = trades.reduce(
    (s, t) => s + (t.pnlUsd ?? t.pnlSol * (t.solUsd || solUsd)),
    0
  );
  const best =
    trades.length === 0
      ? null
      : trades.reduce((a, b) => (b.pnlPct > a.pnlPct ? b : a));
  const worst =
    trades.length === 0
      ? null
      : trades.reduce((a, b) => (b.pnlPct < a.pnlPct ? b : a));

  const grossWin = wins.reduce((s, t) => s + t.pnlSol, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlSol, 0));
  const profitFactor =
    grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;

  // Equity-curve max drawdown from starting balance
  const sorted = [...trades].sort(
    (a, b) => (a.closedAt ?? a.openedAt) - (b.closedAt ?? b.openedAt)
  );
  let equity = startingBalanceSol;
  let peak = startingBalanceSol;
  let maxDrawdownPct = 0;
  for (const t of sorted) {
    equity += t.pnlSol;
    if (equity > peak) peak = equity;
    if (peak > 0) {
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }
  }

  const returns = trades.map((t) => t.pnlPct);
  const meanRet =
    returns.length > 0
      ? returns.reduce((a, b) => a + b, 0) / returns.length
      : 0;
  const sd = stdDev(returns);
  const sharpeRatio = sd > 1e-9 ? meanRet / sd : 0;

  const avgRoundTripCostBps =
    trades.length > 0
      ? trades.reduce((s, t) => s + (t.roundTripCostBps ?? 0), 0) /
        trades.length
      : 0;

  const migration = metricsForTrades(
    trades.filter((t) => t.strategyKind === 'migration' || t.migrated),
    'migration'
  );
  const normal = metricsForTrades(
    trades.filter((t) => t.strategyKind !== 'migration' && !t.migrated),
    'normal'
  );

  return {
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    totalPnlSol,
    returnPct:
      startingBalanceSol > 0
        ? (totalPnlSol / startingBalanceSol) * 100
        : 0,
    avgWinPct: wins.length
      ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length
      : 0,
    avgLossPct: losses.length
      ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length
      : 0,
    avgWinSol: wins.length
      ? wins.reduce((s, t) => s + t.pnlSol, 0) / wins.length
      : 0,
    avgLossSol: losses.length
      ? losses.reduce((s, t) => s + t.pnlSol, 0) / losses.length
      : 0,
    avgHoldingMs: trades.length
      ? trades.reduce((s, t) => s + t.holdingTimeMs, 0) / trades.length
      : 0,
    avgMaxDrawdownPct: trades.length
      ? trades.reduce((s, t) => s + t.maxDrawdownPct, 0) / trades.length
      : 0,
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
    profitFactor: Number(profitFactor.toFixed(2)),
    sharpeRatio: Number(sharpeRatio.toFixed(3)),
    expectancySol: trades.length
      ? Number((totalPnlSol / trades.length).toFixed(6))
      : 0,
    avgRoundTripCostBps: Number(avgRoundTripCostBps.toFixed(1)),
    totalPnlUsd: Number(totalPnlUsd.toFixed(2)),
    solUsd: Number(solUsd.toFixed(2)),
    bestTrade: best,
    worstTrade: worst,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    reBuyTrades: trades.filter((t) => t.isReBuy).length,
    strategyBreakdown: [migration, normal],
  };
}

function buildPnlDistribution(trades: BacktestTradeResult[]): {
  labels: string[];
  counts: number[];
} {
  const buckets = [
    { label: '≤-50%', min: -Infinity, max: -50 },
    { label: '-50…-20%', min: -50, max: -20 },
    { label: '-20…0%', min: -20, max: 0 },
    { label: '0…20%', min: 0, max: 20 },
    { label: '20…50%', min: 20, max: 50 },
    { label: '50…100%', min: 50, max: 100 },
    { label: '>100%', min: 100, max: Infinity },
  ];
  const counts = buckets.map(
    (b) =>
      trades.filter((t) => t.pnlPct > b.min && t.pnlPct <= b.max).length
  );
  // Fix first bucket to include exact -50 and below
  counts[0] = trades.filter((t) => t.pnlPct <= -50).length;
  counts[1] = trades.filter((t) => t.pnlPct > -50 && t.pnlPct <= -20).length;
  return { labels: buckets.map((b) => b.label), counts };
}

function passesFilters(
  event: LaunchEvent,
  options: {
    minLiquidityUsd: number;
    minMarketCapUsd: number;
    maxRiskScore: number;
    minVolumeUsd: number;
    pumpFunOnly: boolean;
  }
): string | null {
  if (options.pumpFunOnly) {
    const isPump = event.isPumpFun ?? !event.migrated;
    if (!isPump) return 'not Pump.fun';
  }
  const vol = event.volumeUsd ?? 0;
  if (options.minVolumeUsd > 0 && vol < options.minVolumeUsd) {
    return `low volume ($${vol.toFixed(0)} < $${options.minVolumeUsd})`;
  }
  const liqAtEntry =
    liquidityAtPrice(
      event.liquidityUsd,
      event.lastPriceSol,
      event.entryPriceSol
    ) ?? event.liquidityUsd ?? 0;
  if (options.minLiquidityUsd > 0 && liqAtEntry < options.minLiquidityUsd) {
    return `low liquidity ($${liqAtEntry.toFixed(0)} < $${options.minLiquidityUsd})`;
  }
  const mcAtEntry =
    marketCapAtPrice(
      event.marketCapUsd,
      event.lastPriceSol,
      event.entryPriceSol
    ) ?? event.marketCapUsd ?? 0;
  if (options.minMarketCapUsd > 0) {
    if (mcAtEntry <= 0) return 'missing market cap';
    if (mcAtEntry < options.minMarketCapUsd) {
      return `low MC ($${mcAtEntry.toFixed(0)} < $${options.minMarketCapUsd})`;
    }
  }
  const risk =
    event.riskScoreHint ??
    estimateRiskScoreHint(event.liquidityUsd, event.volumeUsd);
  if (options.maxRiskScore > 0 && risk >= options.maxRiskScore) {
    return `risk score ${risk} ≥ ${options.maxRiskScore}`;
  }
  return null;
}

/** Simulated detect → quote → land lag after smart-wallet buy */
function simulateCopyDelayMs(): number {
  const base = Math.max(2_000, Math.min(config.pollIntervalMs || 8_000, 20_000));
  const jitter = Math.floor(Math.random() * 5_000); // 0–5s
  return Math.round(base * 0.6 + jitter);
}

function priceAtTime(
  event: LaunchEvent,
  fromIdx: number,
  atMs: number
): number {
  const a = event.candles[fromIdx];
  const b = event.candles[fromIdx + 1] ?? a;
  if (!a) return event.entryPriceSol;
  if (b.time <= a.time) return a.priceSol;
  const t = Math.min(1, Math.max(0, (atMs - a.time) / (b.time - a.time)));
  return a.priceSol + (b.priceSol - a.priceSol) * t;
}

/** Short label + longer explanation for the Reason column */
export function describeExitReason(
  raw: string,
  ctx?: { holdingTimeMs?: number }
): { reason: string; detail: string } {
  const text = String(raw || '').trim();
  const hold =
    ctx?.holdingTimeMs != null
      ? ` Held ${formatDurationShort(ctx.holdingTimeMs)}.`
      : '';

  if (/end-of-window/i.test(text)) {
    return {
      reason: 'Lookback ended (forced exit)',
      detail:
        'The backtest lookback window finished while this position was still open — no take-profit, stop-loss, or trailing exit fired. Sold at the last candle price to close the sim.' +
        hold,
    };
  }
  if (/take-profit|Max profit/i.test(text)) {
    return {
      reason: text
        .replace(/^backtest\s+/i, '')
        .replace(/^rebuy\s+/i, 'Re-buy · '),
      detail: 'Hit the configured take-profit / max-profit target.' + hold,
    };
  }
  if (/stop-loss|Hard stop/i.test(text)) {
    return {
      reason: text
        .replace(/^backtest\s+/i, '')
        .replace(/^rebuy\s+/i, 'Re-buy · '),
      detail: 'Price fell to the stop-loss threshold.' + hold,
    };
  }
  if (/Trailing stop/i.test(text)) {
    return {
      reason: text,
      detail:
        'Trailing stop triggered after the peak — bag / remainder exited.' +
        hold,
    };
  }
  if (/Partial sell|recovered initial|bag/i.test(text)) {
    return {
      reason: text,
      detail:
        'Profit-strategy staged sell (partial / recover initial / bag trim).' +
        hold,
    };
  }
  if (/rebuy/i.test(text)) {
    return {
      reason: text,
      detail: 'Dip re-entry trade after a prior profitable exit.' + hold,
    };
  }
  return {
    reason: text || 'Exit',
    detail: text
      ? `Exit reason: ${text}.${hold}`
      : 'Closed by backtest rules.' + hold,
  };
}

function formatDurationShort(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function takeFromAction(
  stage: string | undefined,
  reason: string,
  slice?: { solReturned?: number; pnlSol?: number; realizedPnlSol?: number } | null
): BacktestExitTake {
  const r = reason || '';
  let st: BacktestExitTakeStage = 'other';
  let label = r.slice(0, 48) || 'Exit';

  if (stage === 'partial' || /Partial sell/i.test(r)) {
    st = 'partial';
    label = 'Partial profit';
  } else if (stage === 'recover_initial' || /recover|initial/i.test(r)) {
    st = 'recover_initial';
    label = 'Recovered initial';
  } else if (stage === 'bag_trim' || /bag/i.test(r)) {
    st = 'bag_trim';
    label = 'Bag trim';
  } else if (/Trailing stop/i.test(r)) {
    st = 'trail';
    label = 'Trail · remainder';
  } else if (/take-profit|Max profit/i.test(r)) {
    st = 'take_profit';
    label = 'Take-profit';
  } else if (/stop-loss|Hard stop/i.test(r)) {
    st = 'stop_loss';
    label = 'Stop-loss';
  } else if (/end-of-window/i.test(r)) {
    st = 'forced';
    label = 'Forced exit (lookback ended)';
  } else if (stage === 'max_profit') {
    st = 'take_profit';
    label = 'Max profit';
  }

  return {
    stage: st,
    label,
    solOut: slice?.solReturned,
    pnlSol: slice?.pnlSol ?? slice?.realizedPnlSol,
  };
}

function buildProfitPath(takes: BacktestExitTake[]): string {
  if (takes.length === 0) return 'Full exit';
  const labels = takes.map((t) => {
    switch (t.stage) {
      case 'partial':
        return 'Partial';
      case 'recover_initial':
        return 'Recovered initial';
      case 'bag_trim':
        return 'Bag trim';
      case 'trail':
        return 'Trail remainder';
      case 'take_profit':
        return 'Take-profit';
      case 'stop_loss':
        return 'Stop-loss';
      case 'forced':
        return 'Lookback ended';
      default:
        return t.label;
    }
  });
  // de-dupe consecutive
  const uniq: string[] = [];
  for (const l of labels) {
    if (uniq[uniq.length - 1] !== l) uniq.push(l);
  }
  return uniq.join(' → ');
}

function resolveSourceNames(
  event: LaunchEvent,
  strategyType: BacktestStrategyType,
  names: string[],
  index: number
): string[] {
  const strategy =
    strategyType === 'auto'
      ? event.migrated
        ? 'migration'
        : config.strategy.enableConvergence
          ? 'convergence'
          : 'single'
      : strategyType;

  if (strategy === 'migration') {
    return [names[index % names.length]];
  }
  if (strategy === 'convergence') {
    const n = Math.min(
      Math.max(config.filters.convergenceRequired, 2),
      names.length
    );
    let sourceNames = names.slice(0, n);
    if (sourceNames.length < 2 && names.length >= 1) {
      sourceNames = [names[0], names[0]];
    }
    return sourceNames;
  }
  return [names[index % names.length]];
}

function replayLaunch(
  trader: PaperTrader,
  event: LaunchEvent,
  sourceNames: string[],
  simulation: number,
  options: { reBuyEnabled: boolean; solUsd: number } = {
    reBuyEnabled: false,
    solUsd: 150,
  }
): BacktestTradeResult[] {
  if (event.candles.length < 2) return [];

  const results: BacktestTradeResult[] = [];
  const strategyKind: 'migration' | 'normal' = event.migrated
    ? 'migration'
    : 'normal';

  /** Extra adverse slippage when path is volatile (bps) */
  function impactSlippageBps(): number {
    const first = event.candles[0]?.priceSol ?? event.entryPriceSol;
    const last =
      event.candles[event.candles.length - 1]?.priceSol ?? event.lastPriceSol;
    const move =
      first > 0 ? Math.abs(last - first) / first : 0;
    // 0–120 bps extra impact for big path moves
    return Math.min(120, Math.round(move * 80));
  }

  const runOne = (
    fromIdx: number,
    isReBuy: boolean
  ): { trade: BacktestTradeResult | null; exitIdx: number } => {
    if (fromIdx >= event.candles.length - 1) {
      return { trade: null, exitIdx: fromIdx };
    }
    const signalCandle = event.candles[fromIdx];
    const smartWalletEnteredAt = signalCandle.time || event.launchedAt;
    const smartWalletEntryPriceSol = signalCandle.priceSol;
    const copyDelayMs = simulateCopyDelayMs();
    const openedAt = smartWalletEnteredAt + copyDelayMs;
    const botEntryPriceSol = priceAtTime(event, fromIdx, openedAt);

    const sizing = calculateDynamicPositionSize({
      equitySol: trader.getEquitySol(),
      kind: strategyKind,
      riskScore: event.riskScoreHint,
      convictionScore: event.migrated
        ? 70
        : Math.min(80, 40 + (sourceNames.length - 1) * 12),
    });
    const impactBps = impactSlippageBps();
    const effectiveSlipBps =
      (config.paper.slippageBps ?? 150) + impactBps;
    const roundTripCostBps =
      (config.paper.feeBps ?? 30) * 2 + effectiveSlipBps + (config.paper.slippageBps ?? 150);

    const position = trader.simulateBuy(
      event.mint,
      event.symbol,
      botEntryPriceSol,
      sizing.sizeSol,
      {
        sourceWallets: sourceNames.map(
          (_, i) => `bt-${simulation}-${isReBuy ? 'rb' : 'e'}-${i}`
        ),
        sourceNames,
        name: event.name || event.symbol,
        strategyKind,
        slippageBps: effectiveSlipBps,
      }
    );
    if (!position) return { trade: null, exitIdx: fromIdx };

    // Cap take-profit at configured max; profit strategy uses this as hard ceiling
    position.takeProfitPct = config.profitStrategy?.enabled
      ? config.trade.maxProfitPercent
      : randomTakeProfitPct();
    // Never exceed maxProfitPercent
    position.takeProfitPct = Math.min(
      position.takeProfitPct,
      config.trade.maxProfitPercent
    );
    position.stopLossPct = config.trade.stopLossPercent;
    if (config.profitStrategy?.enabled) {
      position.trailingStopPct = config.profitStrategy.trailingStopPct;
    }
    position.openedAt = openedAt;

    let closed: Position | null = null;
    let exitIdx = event.candles.length - 1;
    let exitAtMs = openedAt;
    let maxDrawdownPct = 0;
    let maxRunupPct = 0;
    const sellReasons: string[] = [];
    const exitTakes: BacktestExitTake[] = [];
    let lastExitPrice = position.entryPriceSol;
    let takeCursor = { sol: position.solReturned ?? 0, pnl: position.realizedPnlSol ?? 0 };

    const pushTake = (
      stage: string | undefined,
      reason: string,
      pos: Position | null | undefined
    ) => {
      if (!pos) return;
      const solOut = (pos.solReturned ?? 0) - takeCursor.sol;
      const pnlSlice = (pos.realizedPnlSol ?? 0) - takeCursor.pnl;
      exitTakes.push(
        takeFromAction(stage, reason, {
          solReturned: Number(solOut.toFixed(6)),
          pnlSol: Number(pnlSlice.toFixed(6)),
        })
      );
      takeCursor = {
        sol: pos.solReturned ?? 0,
        pnl: pos.realizedPnlSol ?? 0,
      };
    };

    const markExit = (idx: number, atMs?: number) => {
      exitIdx = idx;
      const candleTime = event.candles[idx]?.time;
      exitAtMs =
        atMs ??
        (candleTime != null && candleTime >= openedAt ? candleTime : openedAt);
    };

    for (let i = fromIdx + 1; i < event.candles.length; i++) {
      const c = event.candles[i];
      trader.setTokenPrice(event.mint, c.priceSol);

      const open = trader.getOpenPositions().find((p) => p.id === position.id);
      if (!open) {
        // Closed on a prior candle/sell — don't attribute hold to this candle
        markExit(Math.max(fromIdx, i - 1));
        break;
      }

      if (c.priceSol > open.highWaterMarkSol) {
        open.highWaterMarkSol = c.priceSol;
      }

      const pnlPct =
        ((c.priceSol - open.entryPriceSol) / open.entryPriceSol) * 100;
      if (pnlPct < maxDrawdownPct) maxDrawdownPct = pnlPct;
      if (pnlPct > maxRunupPct) maxRunupPct = pnlPct;

      if (config.profitStrategy?.enabled) {
        // Apply up to a few staged actions per candle (partial → recover → arm)
        for (let step = 0; step < 4; step++) {
          const still = trader.getOpenPositions().find((p) => p.id === position.id);
          if (!still) break;

          const view: ProfitPositionView = {
            entryPriceSol: still.entryPriceSol,
            currentPriceSol: c.priceSol,
            highWaterMarkSol: still.highWaterMarkSol,
            amountTokens: still.amountTokens,
            initialAmountTokens: still.initialAmountTokens,
            initialCostSol: still.initialCostSol,
            solReturned: still.solReturned ?? 0,
            trailingActive: still.trailingActive,
            trailingStopPct: still.trailingStopPct,
            stopLossPct: still.stopLossPct,
            maxProfitPct: Math.min(
              still.takeProfitPct,
              config.trade.maxProfitPercent
            ),
            initialRecovered: still.initialRecovered ?? false,
            partialSellDone: still.partialSellDone ?? false,
            bagTrimDone: still.bagTrimDone ?? false,
            riskScore: event.riskScoreHint,
          };

          const action = evaluateProfitAction(view);
          if (action.type === 'none') break;

          if (action.type === 'arm_trail') {
            still.trailingActive = true;
            still.trailingActivatedAt = Date.now();
            still.trailingStopPct = action.trailPct;
            still.trailingStopPriceSol =
              still.highWaterMarkSol * (1 - action.trailPct / 100);
            sellReasons.push(action.reason);
            continue;
          }

          if (
            action.type === 'hard_sl' ||
            action.type === 'trail_exit' ||
            action.type === 'full'
          ) {
            closed = trader.simulateSell(still.id, c.priceSol, action.reason);
            if (closed) closed.closedAt = c.time;
            pushTake(undefined, action.reason, closed);
            lastExitPrice = closed?.exitPriceSol ?? c.priceSol;
            sellReasons.push(action.reason);
            markExit(i, c.time);
            break;
          }

          if (action.type === 'partial') {
            if (
              (action.tokensToSell != null && action.tokensToSell <= 0) ||
              (action.sellPctOfInitial <= 0 && action.tokensToSell == null)
            ) {
              if (action.stage === 'recover_initial')
                still.initialRecovered = true;
              if (action.stage === 'partial') still.partialSellDone = true;
              if (action.stage === 'bag_trim') still.bagTrimDone = true;
              sellReasons.push(action.reason);
              continue;
            }

            const slice = trader.simulateSell(still.id, c.priceSol, action.reason, {
              tokensToSell: action.tokensToSell,
              sellPctOfInitial:
                action.tokensToSell == null
                  ? action.sellPctOfInitial
                  : undefined,
            });
            if (slice) slice.closedAt = c.time;
            // Prefer open position for cumulative solReturned after partial
            const after =
              trader.getOpenPositions().find((p) => p.id === position.id) ??
              slice;
            pushTake(action.stage, action.reason, after);
            lastExitPrice = slice?.exitPriceSol ?? c.priceSol;
            sellReasons.push(action.reason);
            if (action.stage === 'partial') still.partialSellDone = true;
            if (action.stage === 'recover_initial') still.initialRecovered = true;
            if (action.stage === 'bag_trim') still.bagTrimDone = true;
            if (
              !still.initialRecovered &&
              (still.solReturned ?? 0) >= still.initialCostSol * 0.98
            ) {
              still.initialRecovered = true;
            }
            // If fully closed by partial (sold everything)
            if (!trader.getOpenPositions().find((p) => p.id === position.id)) {
              closed = slice;
              markExit(i, c.time);
              break;
            }
          }
        }
        if (closed || !trader.getOpenPositions().find((p) => p.id === position.id)) {
          if (!closed) {
            // Fully closed via last partial — use last closed slice from trader
            const hist = trader
              .getClosedPositions()
              .filter((p) => p.mint === event.mint)
              .slice(-1)[0];
            closed = hist ?? null;
          }
          markExit(i, c.time);
          break;
        }
        continue;
      }

      // Legacy TP / SL path
      if (pnlPct >= position.takeProfitPct) {
        closed = trader.simulateSell(
          position.id,
          c.priceSol,
          `${isReBuy ? 'rebuy ' : ''}backtest take-profit ${position.takeProfitPct.toFixed(0)}% (cap ${config.trade.maxProfitPercent}%)`
        );
        if (closed) closed.closedAt = c.time;
        pushTake(undefined, closed?.reason ?? 'take-profit', closed);
        lastExitPrice = closed?.exitPriceSol ?? c.priceSol;
        sellReasons.push(closed?.reason ?? 'take-profit');
        markExit(i, c.time);
        break;
      }
      if (pnlPct <= position.stopLossPct) {
        closed = trader.simulateSell(
          position.id,
          c.priceSol,
          `${isReBuy ? 'rebuy ' : ''}backtest stop-loss ${position.stopLossPct}%`
        );
        if (closed) closed.closedAt = c.time;
        pushTake(undefined, closed?.reason ?? 'stop-loss', closed);
        lastExitPrice = closed?.exitPriceSol ?? c.priceSol;
        sellReasons.push(closed?.reason ?? 'stop-loss');
        markExit(i, c.time);
        break;
      }
    }

    // Still open when lookback candles run out — forced mark-to-market exit
    if (!closed && trader.getOpenPositions().find((p) => p.id === position.id)) {
      const last = event.candles[event.candles.length - 1];
      closed = trader.simulateSell(
        position.id,
        last.priceSol,
        `${isReBuy ? 'rebuy ' : ''}backtest end-of-window`
      );
      if (closed) closed.closedAt = last.time;
      pushTake(undefined, closed?.reason ?? 'end-of-window', closed);
      lastExitPrice = closed?.exitPriceSol ?? last.priceSol;
      sellReasons.push(closed?.reason ?? 'end-of-window');
      markExit(event.candles.length - 1, last.time);
    }

    if (!closed) {
      // Aggregate from closed slices for this mint in this run
      const slices = trader
        .getClosedPositions()
        .filter(
          (p) =>
            p.mint === event.mint &&
            (p.reason?.includes('Partial') ||
              p.reason?.includes('partial') ||
              p.reason?.includes('recovered') ||
              p.reason?.includes('Trailing') ||
              p.reason?.includes('Max profit') ||
              p.reason?.includes('Hard stop') ||
              p.reason?.includes('backtest') ||
              p.reason?.includes('bag'))
        );
      if (slices.length === 0) return { trade: null, exitIdx };
      closed = slices[slices.length - 1];
    }

    const openGone = !trader.getOpenPositions().find((p) => p.id === position.id);
    if (!openGone && !closed) return { trade: null, exitIdx };

    // Accurate aggregate PnL vs initial cost
    const entryPriceSol = position.entryPriceSol;
    const exitPriceSol =
      closed.exitPriceSol ?? lastExitPrice ?? entryPriceSol;
    const totalPnlSol =
      closed.realizedPnlSol != null && closed.status === 'closed'
        ? closed.realizedPnlSol
        : closed.pnlSol ?? 0;
    // Prefer position-level realized if we still have the original id closed
    const pnlSol =
      typeof closed.pnlSol === 'number' && closed.id === position.id
        ? closed.pnlSol
        : totalPnlSol;
    // Always report realized PnL% vs cost — never cap or invent from price alone
    const pnlPct =
      position.initialCostSol > 0
        ? (pnlSol / position.initialCostSol) * 100
        : 0;

    // Prefer explicit exit timestamp from the candle where we sold
    const closedAt = Math.max(openedAt, exitAtMs);
    if (closed) closed.closedAt = closedAt;
    // event.marketCapUsd / liquidityUsd are DexScreener snapshots at lastPriceSol
    const refMc = event.marketCapUsd;
    const refLiq = event.liquidityUsd;
    const refPrice = event.lastPriceSol > 0 ? event.lastPriceSol : exitPriceSol;
    const smartWalletEntryMarketCapUsd = marketCapAtPrice(
      refMc,
      refPrice,
      smartWalletEntryPriceSol
    );
    const entryMarketCapUsd = marketCapAtPrice(refMc, refPrice, entryPriceSol);
    const exitMarketCapUsd = marketCapAtPrice(refMc, refPrice, exitPriceSol);
    const smartWalletLiquidityUsd = liquidityAtPrice(
      refLiq,
      refPrice,
      smartWalletEntryPriceSol
    );
    const liquidityUsd = liquidityAtPrice(refLiq, refPrice, entryPriceSol);

    const rawReason =
      sellReasons.length > 0
        ? sellReasons[sellReasons.length - 1]
        : closed.reason ?? 'backtest';
    const holdingTimeMs = Math.max(0, closedAt - openedAt);
    const described = describeExitReason(
      isReBuy ? `rebuy ${rawReason}` : rawReason,
      { holdingTimeMs }
    );

    if (exitTakes.length === 0) {
      for (const r of sellReasons.length ? sellReasons : [rawReason]) {
        exitTakes.push(takeFromAction(undefined, r));
      }
    }

    const recoveredInitial =
      Boolean(position.initialRecovered) ||
      exitTakes.some((t) => t.stage === 'recover_initial');
    const partialTaken =
      Boolean(position.partialSellDone) ||
      exitTakes.some((t) => t.stage === 'partial');
    const profitPath = buildProfitPath(exitTakes);
    const solUsd =
      options.solUsd > 0
        ? options.solUsd
        : event.solUsd && event.solUsd > 0
          ? event.solUsd
          : 150;
    const costSol = position.initialCostSol || config.trade.tradeAmountSol;
    const pnlUsd = Number((pnlSol * solUsd).toFixed(2));

    const trade: BacktestTradeResult = {
      mint: event.mint,
      symbol: event.symbol,
      name: event.name || event.symbol,
      source: event.source,
      migrated: event.migrated,
      isPumpFun: event.isPumpFun ?? !event.migrated,
      entryPriceSol,
      exitPriceSol,
      costSol: Number(costSol.toFixed(6)),
      pnlSol: Number(pnlSol.toFixed(6)),
      pnlUsd,
      solUsd: Number(solUsd.toFixed(2)),
      pnlPct: Number(pnlPct.toFixed(2)),
      reason: described.reason,
      reasonDetail: described.detail,
      exitTakes,
      profitPath,
      recoveredInitial,
      partialTaken,
      launchedAt: event.launchedAt,
      smartWalletEnteredAt,
      openedAt,
      closedAt,
      copyDelayMs,
      holdingTimeMs,
      maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
      maxRunupPct: Number(maxRunupPct.toFixed(2)),
      sourceNames,
      smartWalletCount: sourceNames.length,
      liquidityUsd:
        liquidityUsd != null ? Math.round(liquidityUsd) : undefined,
      smartWalletLiquidityUsd:
        smartWalletLiquidityUsd != null
          ? Math.round(smartWalletLiquidityUsd)
          : undefined,
      marketCapUsd: entryMarketCapUsd,
      entryMarketCapUsd:
        entryMarketCapUsd != null ? Math.round(entryMarketCapUsd) : undefined,
      exitMarketCapUsd:
        exitMarketCapUsd != null ? Math.round(exitMarketCapUsd) : undefined,
      smartWalletEntryMarketCapUsd:
        smartWalletEntryMarketCapUsd != null
          ? Math.round(smartWalletEntryMarketCapUsd)
          : undefined,
      smartWalletEntryPriceSol,
      volumeUsd: event.volumeUsd,
      riskScoreHint:
        event.riskScoreHint ??
        estimateRiskScoreHint(liquidityUsd ?? event.liquidityUsd, event.volumeUsd),
      isReBuy,
      simulation,
      strategyKind,
      roundTripCostBps,
    };
    return { trade, exitIdx };
  };

  const first = runOne(0, false);
  if (first.trade) results.push(first.trade);

  // Optional dip re-entry after profitable TP
  if (
    options.reBuyEnabled &&
    first.trade &&
    first.trade.pnlPct > 0 &&
    /take-profit/i.test(first.trade.reason)
  ) {
    const dipPct = Math.abs(config.strategy.reBuyDipPercent ?? 30);
    const peak = first.trade.exitPriceSol;
    let dipArmed = false;
    let rebuyIdx = -1;
    for (let i = first.exitIdx + 1; i < event.candles.length; i++) {
      const price = event.candles[i].priceSol;
      const dipFromPeak = ((price - peak) / peak) * 100;
      if (dipFromPeak <= -dipPct) dipArmed = true;
      if (dipArmed && dipFromPeak >= -dipPct * 0.5) {
        rebuyIdx = i;
        break;
      }
    }
    if (rebuyIdx >= 0) {
      const second = runOne(rebuyIdx, true);
      if (second.trade) results.push(second.trade);
    }
  }

  return results;
}

function runSinglePass(
  events: LaunchEvent[],
  options: {
    maxTrades: number;
    startingBalance: number;
    strategyType: BacktestStrategyType;
    simulation: number;
    minLiquidityUsd: number;
    minMarketCapUsd: number;
    maxRiskScore: number;
    minVolumeUsd: number;
    pumpFunOnly: boolean;
    reBuyEnabled: boolean;
    solUsd: number;
    onProgress?: (current: number, total: number, label: string) => void;
  }
): {
  trader: PaperTrader;
  trades: BacktestTradeResult[];
  skipped: { mint: string; reason: string }[];
  considered: number;
} {
  const trader = new PaperTrader(options.startingBalance, { mode: 'backtest' });
  const skipped: { mint: string; reason: string }[] = [];
  const trades: BacktestTradeResult[] = [];
  const walletPool = config.smartWallets
    .filter((w) => w.enabled)
    .map((w) => w.name);
  const names =
    walletPool.length >= 1 ? walletPool : ['Cented', 'Theo', 'Decu'];

  let considered = 0;
  const total = Math.min(events.length, options.maxTrades * 3);
  for (const event of events) {
    if (trades.length >= options.maxTrades) break;
    considered += 1;
    options.onProgress?.(considered, Math.max(total, 1), event.symbol);

    const filterFail = passesFilters(event, options);
    if (filterFail) {
      skipped.push({ mint: event.mint, reason: filterFail });
      continue;
    }

    cacheTokenMeta(event.mint, event.symbol, event.name);

    if (options.strategyType === 'migration' && !event.migrated) {
      skipped.push({ mint: event.mint, reason: 'strategy=migration only' });
      continue;
    }

    const sourceNames = resolveSourceNames(
      event,
      options.strategyType,
      names,
      considered
    );

    if (
      trader.getOpenPositions().length >= config.filters.maxConcurrentPositions
    ) {
      skipped.push({ mint: event.mint, reason: 'max concurrent positions' });
      continue;
    }

    const batch = replayLaunch(trader, event, sourceNames, options.simulation, {
      reBuyEnabled: options.reBuyEnabled,
      solUsd: options.solUsd || event.solUsd || 150,
    });
    if (batch.length === 0) {
      skipped.push({
        mint: event.mint,
        reason: 'insufficient balance or bad path',
      });
      continue;
    }
    for (const t of batch) {
      if (trades.length >= options.maxTrades) break;
      trades.push(t);
    }
  }

  return { trader, trades, skipped, considered };
}

/** Run a full backtest over a time window */
export async function runBacktest(
  options: BacktestOptions = {}
): Promise<BacktestResult> {
  const toMs = options.toMs ?? Date.now();
  const hours = options.hours ?? 24;
  const fromMs = options.fromMs ?? toMs - hours * 60 * 60 * 1000;
  const useLiveData = options.useLiveData ?? config.paper.useLiveData;
  const allowSynthetic = options.allowSynthetic !== false;
  const maxTrades = options.maxTrades ?? 20;
  const simulations = Math.min(Math.max(options.simulations ?? 1, 1), 20);
  const migrationsOnly =
    options.migrationsOnly ?? config.strategy.enableMigrationOnly;
  const pumpFunOnly = Boolean(options.pumpFunOnly);
  const reBuyEnabled =
    options.reBuyEnabled ?? config.strategy.reBuyEnabled ?? false;
  const minVolumeUsd = options.minVolumeUsd ?? 0;
  const strategyType: BacktestStrategyType =
    options.strategyType ?? (migrationsOnly ? 'migration' : 'auto');
  const startingBalance =
    options.startingBalanceSol ?? config.paper.startingBalanceSol;
  const minLiquidityUsd = options.minLiquidityUsd ?? 0;
  const minMarketCapUsd = options.minMarketCapUsd ?? 0;
  const maxRiskScore = options.maxRiskScore ?? 0;

  const solUsd = await fetchSolUsdPrice();

  setProgress({
    running: true,
    phase: 'loading',
    current: 0,
    total: simulations,
    pct: 0,
    message: `Fetching market data… (SOL ≈ $${solUsd.toFixed(0)})`,
    startedAt: Date.now(),
    finishedAt: null,
  });
  await sleep(10);

  let events: LaunchEvent[] = [];
  let dataSource = 'synthetic';

  try {
    if (useLiveData) {
      const fetched = await fetchRecentLaunches({
        fromMs,
        toMs,
        allowSynthetic,
        maxResults: maxTrades * 3,
      });
      events = fetched.events;
      dataSource = fetched.source;
    } else {
      events = generateSyntheticLaunches(
        fromMs,
        toMs,
        Math.min(maxTrades * 2, 30)
      );
      dataSource = 'synthetic';
    }

    if (migrationsOnly || strategyType === 'migration') {
      events = events.filter((e) => e.migrated);
    }
    if (pumpFunOnly) {
      events = events.filter((e) => e.isPumpFun ?? !e.migrated);
    }

    setProgress({
      phase: 'simulating',
      message: `Simulating ${events.length} events × ${simulations} run(s)…`,
      total: simulations * Math.max(events.length, 1),
      current: 0,
    });

    const allSkipped: { mint: string; reason: string }[] = [];
    const runStats: Array<ReturnType<PaperTrader['getStats']>> = [];
    let lastTrades: BacktestTradeResult[] = [];
    let lastTrader: PaperTrader | null = null;
    let considered = 0;
    let progressCursor = 0;

    for (let sim = 1; sim <= simulations; sim++) {
      let passEvents = events;
      if (sim > 1 && dataSource === 'synthetic') {
        passEvents = generateSyntheticLaunches(
          fromMs,
          toMs,
          Math.min(maxTrades * 2, 30)
        );
        if (migrationsOnly || strategyType === 'migration') {
          passEvents = passEvents.filter((e) => e.migrated);
        }
        if (pumpFunOnly) {
          passEvents = passEvents.filter((e) => e.isPumpFun ?? !e.migrated);
        }
      } else if (sim > 1) {
        passEvents = [...events].sort(() => Math.random() - 0.5);
      }

      const pass = runSinglePass(passEvents, {
        maxTrades,
        startingBalance,
        strategyType,
        simulation: sim,
        minLiquidityUsd,
        minMarketCapUsd,
        maxRiskScore,
        minVolumeUsd,
        pumpFunOnly,
        reBuyEnabled,
        solUsd,
        onProgress: (_cur, _tot, label) => {
          progressCursor += 1;
          setProgress({
            current: progressCursor,
            total: Math.max(
              simulations * Math.max(events.length, 1),
              progressCursor
            ),
            message: `Sim ${sim}/${simulations} · ${label}`,
            phase: 'simulating',
          });
        },
      });

      considered = Math.max(considered, pass.considered);
      allSkipped.push(...pass.skipped);
      runStats.push(pass.trader.getStats());
      lastTrades = pass.trades;
      lastTrader = pass.trader;
      await sleep(5);
    }

    const trader =
      lastTrader ?? new PaperTrader(startingBalance, { mode: 'backtest' });
    const stats = trader.getStats();
    const baseCharts = trader.getChartData();
    const summary = buildSummary(lastTrades, solUsd, startingBalance);
    // Prefer summary return (trade-based); fall back to paper equity return
    if (!Number.isFinite(summary.returnPct) || summary.totalTrades === 0) {
      summary.returnPct = stats.returnPct;
    }

    const charts = {
      ...baseCharts,
      pnlDistribution: buildPnlDistribution(lastTrades),
      strategyBreakdown: {
        labels: summary.strategyBreakdown.map((s) => s.strategyKind),
        pnlSol: summary.strategyBreakdown.map((s) => s.totalPnlSol),
        winRatePct: summary.strategyBreakdown.map((s) => s.winRatePct),
        trades: summary.strategyBreakdown.map((s) => s.trades),
      },
    };

    const aggregate =
      simulations > 1
        ? {
            avgWinRatePct:
              runStats.reduce((s, r) => s + r.winRatePct, 0) / runStats.length,
            avgNetPnlSol:
              runStats.reduce((s, r) => s + r.netPnlSol, 0) / runStats.length,
            avgReturnPct:
              runStats.reduce((s, r) => s + r.returnPct, 0) / runStats.length,
            runs: simulations,
          }
        : undefined;

    const message =
      lastTrades.length === 0
        ? `No trades simulated (source=${dataSource}, events=${events.length}, sims=${simulations}). Widen window or loosen filters.`
        : `Backtest complete: ${lastTrades.length} trades` +
          (simulations > 1 ? ` × ${simulations} sims` : '') +
          `, net ${stats.netPnlSol.toFixed(4)} SOL (~$${summary.totalPnlUsd.toFixed(0)} @ $${solUsd.toFixed(0)}/SOL), win rate ${stats.winRatePct.toFixed(0)}%` +
          ` · PF ${summary.profitFactor}` +
          ` · Sharpe ${summary.sharpeRatio}` +
          ` · maxDD ${summary.maxDrawdownPct}%` +
          (summary.reBuyTrades ? ` · ${summary.reBuyTrades} rebuys` : '') +
          (aggregate
            ? ` · avg WR ${aggregate.avgWinRatePct.toFixed(0)}%`
            : '');

    logger.info('Backtest', message, {
      trades: lastTrades.length,
      simulations,
      dataSource,
    });

    const result: BacktestResult = {
      ok: lastTrades.length > 0,
      id: `bt-${Date.now()}`,
      ranAt: Date.now(),
      options: {
        hours,
        maxTrades,
        simulations,
        migrationsOnly: Boolean(migrationsOnly),
        pumpFunOnly,
        reBuyEnabled: Boolean(reBuyEnabled),
        minVolumeUsd,
        strategyType,
        minLiquidityUsd,
        minMarketCapUsd,
        maxRiskScore,
        useLiveData: Boolean(useLiveData),
        allowSynthetic,
        startingBalanceSol: startingBalance,
      },
      period: {
        fromMs,
        toMs,
        hours: (toMs - fromMs) / (60 * 60 * 1000),
      },
      dataSource,
      eventsConsidered: considered,
      tradesExecuted: lastTrades.length,
      simulationsRun: simulations,
      stats,
      summary,
      aggregate,
      charts,
      trades: lastTrades,
      skipped: allSkipped.slice(0, 40),
      message,
    };

    storeResult(result);
    setProgress({
      running: false,
      phase: 'done',
      pct: 100,
      current: progress.total || 1,
      message: message.slice(0, 120),
      finishedAt: Date.now(),
    });
    return result;
  } catch (err) {
    setProgress({
      running: false,
      phase: 'error',
      message: err instanceof Error ? err.message : String(err),
      finishedAt: Date.now(),
    });
    throw err;
  }
}

/** CSV export of trades */
export function tradesToCsv(trades: BacktestTradeResult[]): string {
  const headers = [
    'symbol',
    'name',
    'mint',
    'migrated',
    'isPumpFun',
    'smartWalletEntryPriceSol',
    'entryPriceSol',
    'exitPriceSol',
    'smartWalletEntryMarketCapUsd',
    'entryMarketCapUsd',
    'exitMarketCapUsd',
    'pnlPct',
    'pnlSol',
    'pnlUsd',
    'solUsd',
    'costSol',
    'profitPath',
    'recoveredInitial',
    'partialTaken',
    'maxDrawdownPct',
    'maxRunupPct',
    'copyDelayMs',
    'holdingTimeMs',
    'holdingMinutes',
    'reason',
    'reasonDetail',
    'smartWalletEnteredAt',
    'openedAt',
    'closedAt',
    'smartWalletLiquidityUsd',
    'liquidityUsd',
    'volumeUsd',
    'riskScore',
    'smartWalletCount',
    'wallets',
    'isReBuy',
    'source',
    'strategyKind',
    'roundTripCostBps',
  ];
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = trades.map((t) =>
    [
      t.symbol,
      t.name,
      t.mint,
      t.migrated,
      t.isPumpFun,
      t.smartWalletEntryPriceSol ?? '',
      t.entryPriceSol,
      t.exitPriceSol,
      t.smartWalletEntryMarketCapUsd ?? '',
      t.entryMarketCapUsd ?? t.marketCapUsd ?? '',
      t.exitMarketCapUsd ?? '',
      t.pnlPct,
      t.pnlSol,
      t.pnlUsd ?? '',
      t.solUsd ?? '',
      t.costSol ?? '',
      t.profitPath ?? '',
      t.recoveredInitial ? 1 : 0,
      t.partialTaken ? 1 : 0,
      t.maxDrawdownPct,
      t.maxRunupPct,
      t.copyDelayMs ?? '',
      t.holdingTimeMs,
      (t.holdingTimeMs / 60000).toFixed(1),
      t.reason,
      t.reasonDetail ?? '',
      t.smartWalletEnteredAt
        ? new Date(t.smartWalletEnteredAt).toISOString()
        : '',
      t.openedAt ? new Date(t.openedAt).toISOString() : '',
      t.closedAt ? new Date(t.closedAt).toISOString() : '',
      t.smartWalletLiquidityUsd ?? '',
      t.liquidityUsd ?? '',
      t.volumeUsd ?? '',
      t.riskScoreHint ?? '',
      t.smartWalletCount,
      (t.sourceNames || []).join('|'),
      t.isReBuy ?? false,
      t.source,
      t.strategyKind ?? (t.migrated ? 'migration' : 'normal'),
      t.roundTripCostBps ?? '',
    ]
      .map(esc)
      .join(',')
  );
  return [headers.join(','), ...rows].join('\n');
}

export function exportLastBacktestCsv(): string | null {
  if (!lastResult) return null;
  return tradesToCsv(lastResult.trades);
}

/** Full backtest report as JSON (metrics + trades + options) */
export function exportLastBacktestJson(): string | null {
  if (!lastResult) return null;
  const report = {
    id: lastResult.id,
    ranAt: lastResult.ranAt,
    message: lastResult.message,
    options: lastResult.options,
    period: lastResult.period,
    dataSource: lastResult.dataSource,
    eventsConsidered: lastResult.eventsConsidered,
    tradesExecuted: lastResult.tradesExecuted,
    simulationsRun: lastResult.simulationsRun,
    metrics: {
      winRatePct: lastResult.summary.winRatePct,
      profitFactor: lastResult.summary.profitFactor,
      totalPnlSol: lastResult.summary.totalPnlSol,
      totalPnlUsd: lastResult.summary.totalPnlUsd,
      returnPct: lastResult.summary.returnPct,
      maxDrawdownPct: lastResult.summary.maxDrawdownPct,
      avgMaxDrawdownPct: lastResult.summary.avgMaxDrawdownPct,
      sharpeRatio: lastResult.summary.sharpeRatio,
      avgWinPct: lastResult.summary.avgWinPct,
      avgLossPct: lastResult.summary.avgLossPct,
      avgWinSol: lastResult.summary.avgWinSol,
      avgLossSol: lastResult.summary.avgLossSol,
      expectancySol: lastResult.summary.expectancySol,
      avgHoldingMs: lastResult.summary.avgHoldingMs,
      avgRoundTripCostBps: lastResult.summary.avgRoundTripCostBps,
      totalTrades: lastResult.summary.totalTrades,
      wins: lastResult.summary.wins,
      losses: lastResult.summary.losses,
      reBuyTrades: lastResult.summary.reBuyTrades,
      strategyBreakdown: lastResult.summary.strategyBreakdown,
      bestTrade: lastResult.summary.bestTrade
        ? {
            symbol: lastResult.summary.bestTrade.symbol,
            pnlPct: lastResult.summary.bestTrade.pnlPct,
            pnlSol: lastResult.summary.bestTrade.pnlSol,
          }
        : null,
      worstTrade: lastResult.summary.worstTrade
        ? {
            symbol: lastResult.summary.worstTrade.symbol,
            pnlPct: lastResult.summary.worstTrade.pnlPct,
            pnlSol: lastResult.summary.worstTrade.pnlSol,
          }
        : null,
    },
    stats: lastResult.stats,
    aggregate: lastResult.aggregate,
    trades: lastResult.trades,
    skipped: lastResult.skipped,
  };
  return JSON.stringify(report, null, 2);
}

/**
 * Refresh open paper positions with live DexScreener prices
 * when config.paper.useLiveData is enabled.
 */
export async function refreshPaperPricesFromLive(
  trader: PaperTrader = paperTrader
): Promise<number> {
  if (!config.paper.useLiveData) return 0;

  const open = trader.getOpenPositions();
  let updated = 0;

  for (const pos of open) {
    const price = await fetchLivePriceSol(pos.mint);
    if (price != null) {
      trader.setTokenPrice(pos.mint, price);
      updated += 1;
    }
  }

  if (updated > 0 && config.strategy.enableAutoSell) {
    trader.checkPositions();
  }

  return updated;
}
