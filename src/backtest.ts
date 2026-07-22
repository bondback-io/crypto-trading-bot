/**
 * Backtest / advanced paper simulation.
 * Replays recent Pump.fun-style launches through an isolated PaperTrader
 * with realistic candle-driven price paths.
 */

import { config, applyRiskLevel, getRiskLevelSummary, type RiskLevel } from './config';
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
import { calculateDynamicPositionSize } from './risk';
import {
  atomicWriteJson,
  dataFile,
  ensureDataDir,
  migrateLegacyFile,
  PERSIST_FILES,
  readJsonFile,
} from './dataDir';

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
  /**
   * Temporarily apply this risk-level preset for the run (not persisted).
   * Omit / 'current' = use whatever config is already loaded (saved settings).
   */
  riskLevel?: RiskLevel | 'current';
  /**
   * When true, run Low / Medium / High on the same events and attach comparison.
   * Primary result uses the selected riskLevel (or current).
   */
  compareRiskLevels?: boolean;
  /**
   * When filter overrides are 0/undefined, pull mins from saved config filters.
   * Default true.
   */
  useSavedConfigFilters?: boolean;
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
  /** Step-by-step exit debug lines for this trade */
  debugLog?: string[];
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
  /** Wins ÷ losses (∞ → 999 when no losses) */
  winLossRatio: number;
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
    riskLevel: RiskLevel | 'current';
    compareRiskLevels: boolean;
    useSavedConfigFilters: boolean;
  };
  /** Snapshot of trading knobs used for this run */
  configUsed: {
    riskLevel: RiskLevel;
    baseTradeAmountSol: number;
    stopLossPercent: number;
    maxProfitPercent: number;
    maxRiskScore: number;
    minLiquidity: number;
    convergenceRequired: number;
    maxConcurrentPositions: number;
    riskPercentPerTrade: number;
    maxDrawdownPct: number;
    minConvictionScore: number;
    profitStrategyEnabled: boolean;
    partialSellAt: number;
    trailingStopAfter: number;
    feeBps: number;
    slippageBps: number;
    label?: string;
  };
  /** Present when compareRiskLevels was requested */
  riskComparison?: Array<{
    riskLevel: RiskLevel;
    tradesExecuted: number;
    winRatePct: number;
    totalPnlSol: number;
    profitFactor: number;
    maxDrawdownPct: number;
    sharpeRatio: number;
    avgHoldMs: number;
    message: string;
  }>;
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
    /** Bankroll equity (starting balance + cumulative PnL) */
    equityCurve?: {
      labels: string[];
      values: number[];
      startingBalanceSol: number;
      points?: Array<{
        time: number;
        label: string;
        pnlSol: number;
        equity: number;
        symbol: string;
      }>;
    };
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
    /** Present when compareRiskLevels was run */
    riskComparison?: {
      labels: string[];
      pnlSol: number[];
      winRatePct: number[];
      profitFactor: number[];
      maxDrawdownPct: number[];
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
  migrateLegacyFile(
    dataFile(PERSIST_FILES.legacyBacktest),
    dataFile(PERSIST_FILES.backtestHistory)
  );
  return dataFile(PERSIST_FILES.backtestHistory);
}

type SlimBacktest = {
  id: string;
  ranAt: number;
  message: string;
  summary: BacktestSummary;
  period: BacktestResult['period'];
  dataSource: string;
  options?: BacktestResult['options'];
  tradesExecuted?: number;
};

function loadHistoryFromDisk(): void {
  try {
    const path = historyFilePath();
    const parsed = readJsonFile<SlimBacktest[]>(path);
    if (!parsed || !Array.isArray(parsed) || parsed.length === 0) return;
    history.length = 0;
    for (const row of parsed.slice(0, HISTORY_CAP)) {
      history.push(row as unknown as BacktestResult);
    }
    if (history.length > 0) {
      lastResult = history[0];
      console.log(
        `[backtest] Loaded ${history.length} run(s) from ${PERSIST_FILES.backtestHistory}`
      );
    }
  } catch (err) {
    logger.warn(
      'Backtest',
      'failed to load history',
      err instanceof Error ? { error: err.message } : {}
    );
  }
}

/** Clear in-memory + on-disk backtest history (used by Reset to Defaults). */
export function clearBacktestHistory(): void {
  history.length = 0;
  lastResult = null;
  try {
    atomicWriteJson(historyFilePath(), []);
  } catch {
    /* ignore */
  }
}

// Load persisted history once at module init
loadHistoryFromDisk();

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
    atomicWriteJson(historyFilePath(), slim);
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
    winLossRatio: Number(
      (losses.length > 0
        ? wins.length / losses.length
        : wins.length > 0
          ? 999
          : 0
      ).toFixed(2)
    ),
    reBuyTrades: trades.filter((t) => t.isReBuy).length,
    strategyBreakdown: [migration, normal],
  };
}

/** Equity curve from starting bankroll through closed trades (chronological). */
function buildEquityCurve(
  trades: BacktestTradeResult[],
  startingBalanceSol: number
): NonNullable<BacktestResult['charts']['equityCurve']> {
  const startLabel = 'Start';
  if (trades.length === 0) {
    return {
      labels: [startLabel],
      values: [Number(startingBalanceSol.toFixed(6))],
      startingBalanceSol,
      points: [
        {
          time: Date.now(),
          label: startLabel,
          pnlSol: 0,
          equity: startingBalanceSol,
          symbol: 'start',
        },
      ],
    };
  }

  const sorted = [...trades].sort(
    (a, b) => (a.closedAt ?? a.openedAt) - (b.closedAt ?? b.openedAt)
  );
  let equity = startingBalanceSol;
  const labels: string[] = [startLabel];
  const values: number[] = [Number(startingBalanceSol.toFixed(6))];
  const points: NonNullable<
    BacktestResult['charts']['equityCurve']
  >['points'] = [
    {
      time: sorted[0]?.openedAt ?? Date.now(),
      label: startLabel,
      pnlSol: 0,
      equity: startingBalanceSol,
      symbol: 'start',
    },
  ];

  for (const t of sorted) {
    equity += t.pnlSol;
    const time = t.closedAt ?? t.openedAt;
    const label = new Date(time).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    labels.push(label);
    values.push(Number(equity.toFixed(6)));
    points!.push({
      time,
      label,
      pnlSol: t.pnlSol,
      equity: Number(equity.toFixed(6)),
      symbol: t.symbol,
    });
  }

  return { labels, values, startingBalanceSol, points };
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
  const vol = event.volumeUsd;
  // Missing volume should not kill the candidate (Dex often omits it)
  if (
    options.minVolumeUsd > 0 &&
    vol != null &&
    vol > 0 &&
    vol < options.minVolumeUsd
  ) {
    return `low volume ($${vol.toFixed(0)} < $${options.minVolumeUsd})`;
  }
  const liqAtEntry =
    liquidityAtPrice(
      event.liquidityUsd,
      event.lastPriceSol,
      event.entryPriceSol
    ) ?? event.liquidityUsd;
  if (
    options.minLiquidityUsd > 0 &&
    liqAtEntry != null &&
    liqAtEntry > 0 &&
    liqAtEntry < options.minLiquidityUsd
  ) {
    return `low liquidity ($${liqAtEntry.toFixed(0)} < $${options.minLiquidityUsd})`;
  }
  const mcAtEntry =
    marketCapAtPrice(
      event.marketCapUsd,
      event.lastPriceSol,
      event.entryPriceSol
    ) ?? event.marketCapUsd;
  if (options.minMarketCapUsd > 0) {
    if (mcAtEntry == null || mcAtEntry <= 0) {
      // Don't reject solely for missing MC when other filters pass
    } else if (mcAtEntry < options.minMarketCapUsd) {
      return `low MC ($${mcAtEntry.toFixed(0)} < $${options.minMarketCapUsd})`;
    }
  }
  // Score risk from entry-scaled liquidity (fairer than last-price snapshot)
  const risk =
    estimateRiskScoreHint(
      liqAtEntry ?? event.liquidityUsd,
      vol ?? event.volumeUsd
    );
  // Soften inherited live maxRisk by +12 so backtests aren't starved by the heuristic
  const riskCap =
    options.maxRiskScore > 0 ? options.maxRiskScore + 12 : 0;
  if (riskCap > 0 && risk >= riskCap) {
    return `risk score ${risk} ≥ ${riskCap}`;
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
  if (/trailing stop/i.test(text)) {
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

function formatBacktestExitLog(
  symbol: string,
  markPnlPct: number,
  reason: string,
  kind: string
): string {
  const sign = markPnlPct >= 0 ? '+' : '';
  const pct = `${sign}${markPnlPct.toFixed(1)}%`;
  if (kind === 'arm_trail') {
    return `Armed trail on ${symbol} at ${pct}: ${reason}`;
  }
  if (kind === 'partial' || kind === 'tier') {
    return `Partial sell ${symbol} at ${pct}: ${reason}`;
  }
  if (kind === 'trail_exit') {
    return `Sold ${symbol} at ${pct} due to trailing stop — ${reason}`;
  }
  if (kind === 'hard_sl') {
    return `Sold ${symbol} at ${pct} due to stop-loss — ${reason}`;
  }
  if (kind === 'take_profit' || kind === 'full') {
    return `Sold ${symbol} at ${pct} due to take-profit — ${reason}`;
  }
  if (/end-of-window/i.test(reason)) {
    return `Forced exit ${symbol} at ${pct} (lookback ended)`;
  }
  return `Sold ${symbol} at ${pct}: ${reason}`;
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

    // Match paper/live costs exactly — no extra impact slippage
    const slipBps = config.paper.slippageBps ?? 150;
    const feeBps = config.paper.feeBps ?? 30;
    const roundTripCostBps = feeBps * 2 + slipBps * 2;

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
        // Same slippage as paper — omit override so config.paper.slippageBps applies
        antiRug:
          event.riskScoreHint != null
            ? {
                riskScore: event.riskScoreHint,
                riskLevel:
                  event.riskScoreHint >= 70
                    ? 'high'
                    : event.riskScoreHint >= 40
                      ? 'medium'
                      : 'low',
                flags: [],
                ok: event.riskScoreHint < 80,
              }
            : undefined,
      }
    );
    if (!position) return { trade: null, exitIdx: fromIdx };

    // Keep SL/TP/trail exactly as simulateBuy seeded them (matches paper/live)
    position.openedAt = openedAt;

    const debugLog: string[] = [];
    const entryMarkNote =
      `Opened ${event.symbol} @ ${position.entryPriceSol.toExponential(4)} SOL` +
      ` (mark ${botEntryPriceSol.toExponential(4)}, slip ${slipBps}bps, fee ${feeBps}bps)` +
      ` · size ${sizing.sizeSol.toFixed(4)} SOL` +
      ` · TP ${position.takeProfitPct.toFixed(0)}% / SL ${position.stopLossPct}%` +
      ` · trail ${position.trailingStopPct}%` +
      (config.profitStrategy?.enabled ? ' · profit strategy ON' : ' · legacy TP/SL/trail');
    debugLog.push(entryMarkNote);
    logger.info('Backtest', entryMarkNote, { mint: event.mint, simulation });

    let closed: Position | null = null;
    let exitIdx = event.candles.length - 1;
    let exitAtMs = openedAt;
    let maxDrawdownPct = 0;
    let maxRunupPct = 0;
    const sellReasons: string[] = [];
    const exitTakes: BacktestExitTake[] = [];
    let lastExitPrice = position.entryPriceSol;
    let takeCursor = {
      sol: position.solReturned ?? 0,
      pnl: position.realizedPnlSol ?? 0,
    };

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

    const stageFromReason = (reason: string): string | undefined => {
      if (/partial sell|Partial/i.test(reason) && !/recover/i.test(reason))
        return 'partial';
      if (/recover|initial investment/i.test(reason)) return 'recover_initial';
      if (/bag/i.test(reason)) return 'bag_trim';
      if (/tier/i.test(reason)) return 'partial';
      return undefined;
    };

    // Candle loop — exits via same sync rules as paperTrader.checkPositions
    for (let i = fromIdx + 1; i < event.candles.length; i++) {
      const c = event.candles[i];
      // Skip candles before our fill time (copy delay)
      if (c.time != null && c.time < openedAt) continue;

      trader.setTokenPrice(event.mint, c.priceSol);

      const open = trader.getOpenPositions().find((p) => p.id === position.id);
      if (!open) {
        markExit(Math.max(fromIdx, i - 1));
        break;
      }

      const pnlPct =
        ((c.priceSol - open.entryPriceSol) / open.entryPriceSol) * 100;
      if (pnlPct < maxDrawdownPct) maxDrawdownPct = pnlPct;
      if (pnlPct > maxRunupPct) maxRunupPct = pnlPct;

      const events = trader.runPositionTicksUntilIdle(position.id, c.priceSol, 12);
      for (const ev of events) {
        const line = formatBacktestExitLog(
          event.symbol,
          ev.markPnlPct,
          ev.reason,
          ev.kind
        );
        debugLog.push(line);
        logger.info('Backtest', line, {
          mint: event.mint,
          kind: ev.kind,
          markPnlPct: ev.markPnlPct,
        });
        sellReasons.push(ev.reason);

        if (
          ev.kind === 'partial' ||
          ev.kind === 'tier' ||
          ev.kind === 'full' ||
          ev.kind === 'hard_sl' ||
          ev.kind === 'trail_exit' ||
          ev.kind === 'take_profit'
        ) {
          const after =
            trader.getOpenPositions().find((p) => p.id === position.id) ??
            trader
              .getClosedPositions()
              .filter((p) => p.mint === event.mint)
              .slice(-1)[0] ??
            null;
          pushTake(stageFromReason(ev.reason), ev.reason, after);
          lastExitPrice = after?.exitPriceSol ?? c.priceSol;
        }

        if (!ev.stillOpen) {
          closed =
            trader
              .getClosedPositions()
              .filter((p) => p.id === position.id || p.mint === event.mint)
              .slice(-1)[0] ?? null;
          if (closed) closed.closedAt = c.time;
          markExit(i, c.time);
          break;
        }
      }

      if (closed || !trader.getOpenPositions().find((p) => p.id === position.id)) {
        if (!closed) {
          closed =
            trader
              .getClosedPositions()
              .filter((p) => p.mint === event.mint)
              .slice(-1)[0] ?? null;
        }
        markExit(i, c.time);
        break;
      }
    }

    // Still open when lookback candles run out — forced mark-to-market exit
    if (!closed && trader.getOpenPositions().find((p) => p.id === position.id)) {
      const last = event.candles[event.candles.length - 1];
      const markPnl =
        ((last.priceSol - position.entryPriceSol) / position.entryPriceSol) * 100;
      const forceReason = `${isReBuy ? 'rebuy ' : ''}backtest end-of-window`;
      closed = trader.simulateSell(position.id, last.priceSol, forceReason);
      if (closed) closed.closedAt = last.time;
      pushTake(undefined, closed?.reason ?? 'end-of-window', closed);
      lastExitPrice = closed?.exitPriceSol ?? last.priceSol;
      sellReasons.push(closed?.reason ?? 'end-of-window');
      const forceLine = formatBacktestExitLog(
        event.symbol,
        markPnl,
        forceReason,
        'full'
      );
      debugLog.push(forceLine);
      logger.info('Backtest', forceLine, { mint: event.mint });
      markExit(event.candles.length - 1, last.time);
    }

    if (!closed) {
      const slices = trader
        .getClosedPositions()
        .filter(
          (p) =>
            p.mint === event.mint &&
            (p.reason?.includes('Partial') ||
              p.reason?.includes('partial') ||
              p.reason?.includes('recovered') ||
              p.reason?.includes('Trailing') ||
              p.reason?.includes('trailing') ||
              p.reason?.includes('Max profit') ||
              p.reason?.includes('Hard stop') ||
              p.reason?.includes('hard stop') ||
              p.reason?.includes('take-profit') ||
              p.reason?.includes('tier') ||
              p.reason?.includes('backtest') ||
              p.reason?.includes('bag'))
        );
      if (slices.length === 0) return { trade: null, exitIdx };
      closed = slices[slices.length - 1];
    }

    const openGone = !trader.getOpenPositions().find((p) => p.id === position.id);
    if (!openGone && !closed) return { trade: null, exitIdx };

    // Accurate aggregate PnL vs initial cost (fee-aware SOL accounting)
    const entryPriceSol = position.entryPriceSol;
    const exitPriceSol =
      closed.exitPriceSol ?? lastExitPrice ?? entryPriceSol;
    const totalPnlSol =
      closed.realizedPnlSol != null && closed.status === 'closed'
        ? closed.realizedPnlSol
        : closed.pnlSol ?? 0;
    const pnlSol =
      typeof closed.pnlSol === 'number' && closed.id === position.id
        ? closed.pnlSol
        : totalPnlSol;
    const pnlPct =
      position.initialCostSol > 0
        ? (pnlSol / position.initialCostSol) * 100
        : 0;

    // Mark-to-entry price move (for debug — differs from fee-aware pnlPct)
    const markExitPct =
      entryPriceSol > 0
        ? ((exitPriceSol - entryPriceSol) / entryPriceSol) * 100
        : 0;
    debugLog.push(
      `PnL debug ${event.symbol}: realized ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL` +
        ` (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% vs cost)` +
        ` · mark exit ${markExitPct >= 0 ? '+' : ''}${markExitPct.toFixed(1)}%` +
        ` · RT cost ~${roundTripCostBps}bps` +
        ` · hold ${(Math.max(0, Math.max(openedAt, exitAtMs) - openedAt) / 60000).toFixed(1)}m`
    );

    const closedAt = Math.max(openedAt, exitAtMs);
    if (closed) closed.closedAt = closedAt;
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

    logger.info(
      'Backtest',
      `Closed ${event.symbol}: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL` +
        ` (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%) · ${described.reason}`,
      { mint: event.mint, reason: rawReason, steps: debugLog.length }
    );

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
      debugLog,
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

function captureTradingConfigSnapshot() {
  return {
    riskLevel: config.riskLevel,
    trade: { ...config.trade },
    filters: { ...config.filters },
    risk: {
      ...config.risk,
      normal: {
        ...config.risk.normal,
        tiers: config.risk.normal.tiers.map((t) => ({ ...t })),
      },
      migration: {
        ...config.risk.migration,
        tiers: config.risk.migration.tiers.map((t) => ({ ...t })),
      },
    },
    selective: { ...config.selective },
    profitStrategy: { ...config.profitStrategy },
    strategy: {
      migrationSizeMultiplier: config.strategy.migrationSizeMultiplier,
      confirmationThreshold: config.strategy.confirmationThreshold,
      reBuyMinProfitPct: config.strategy.reBuyMinProfitPct,
      reBuyEnabled: config.strategy.reBuyEnabled,
      enableMigrationOnly: config.strategy.enableMigrationOnly,
    },
  };
}

function restoreTradingConfigSnapshot(
  snap: ReturnType<typeof captureTradingConfigSnapshot>
): void {
  config.riskLevel = snap.riskLevel;
  Object.assign(config.trade, snap.trade);
  Object.assign(config.filters, snap.filters);
  config.risk = {
    ...snap.risk,
    normal: {
      ...snap.risk.normal,
      tiers: snap.risk.normal.tiers.map((t) => ({ ...t })),
    },
    migration: {
      ...snap.risk.migration,
      tiers: snap.risk.migration.tiers.map((t) => ({ ...t })),
    },
  };
  Object.assign(config.selective, snap.selective);
  Object.assign(config.profitStrategy, snap.profitStrategy);
  Object.assign(config.strategy, snap.strategy);
}

function buildConfigUsedSnapshot() {
  const sum = getRiskLevelSummary();
  return {
    riskLevel: (config.riskLevel || 'medium') as RiskLevel,
    baseTradeAmountSol:
      config.trade.baseTradeAmountSol ?? config.trade.tradeAmountSol,
    stopLossPercent: config.trade.stopLossPercent,
    maxProfitPercent: config.trade.maxProfitPercent,
    maxRiskScore: config.filters.maxRiskScore,
    minLiquidity: config.filters.minLiquidity,
    convergenceRequired: config.filters.convergenceRequired,
    maxConcurrentPositions: config.filters.maxConcurrentPositions,
    riskPercentPerTrade: config.risk.riskPercentPerTrade,
    maxDrawdownPct: config.risk.maxDrawdownPct,
    minConvictionScore: config.selective.minConvictionScore,
    profitStrategyEnabled: config.profitStrategy?.enabled !== false,
    partialSellAt: config.profitStrategy?.partialSellAt ?? 0,
    trailingStopAfter: config.profitStrategy?.trailingStopAfter ?? 0,
    feeBps: config.paper.feeBps,
    slippageBps: config.paper.slippageBps,
    label: sum.label,
  };
}

/** Run a full backtest over a time window */
export async function runBacktest(
  options: BacktestOptions = {}
): Promise<BacktestResult> {
  const savedSnap = captureTradingConfigSnapshot();
  const requestedLevel = options.riskLevel ?? 'current';
  const compareRiskLevels = Boolean(options.compareRiskLevels);
  const useSavedConfigFilters = options.useSavedConfigFilters !== false;

  try {
    // Optionally apply a risk-level preset for this run only (not persisted)
    if (
      requestedLevel === 'low' ||
      requestedLevel === 'medium' ||
      requestedLevel === 'high'
    ) {
      applyRiskLevel(requestedLevel, { persist: false });
    }

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
    const strategyType: BacktestStrategyType =
      options.strategyType ?? (migrationsOnly ? 'migration' : 'auto');
    const startingBalance =
      options.startingBalanceSol ?? config.paper.startingBalanceSol;

    // Prefer explicit overrides; otherwise inherit saved filter config
    const minVolumeUsd =
      options.minVolumeUsd != null && options.minVolumeUsd > 0
        ? options.minVolumeUsd
        : useSavedConfigFilters
          ? config.filters.minVolume24hUsd || 0
          : 0;
    const minLiquidityUsd =
      options.minLiquidityUsd != null && options.minLiquidityUsd > 0
        ? options.minLiquidityUsd
        : useSavedConfigFilters
          ? config.filters.minLiquidity || 0
          : 0;
    const minMarketCapUsd = options.minMarketCapUsd ?? 0;
    const maxRiskScore =
      options.maxRiskScore != null && options.maxRiskScore > 0
        ? options.maxRiskScore
        : useSavedConfigFilters
          ? config.filters.maxRiskScore || 0
          : 0;

    const solUsd = await fetchSolUsdPrice();
    const configUsed = buildConfigUsedSnapshot();

    setProgress({
      running: true,
      phase: 'loading',
      current: 0,
      total: simulations,
      pct: 0,
      message:
        `Using ${configUsed.riskLevel.toUpperCase()} risk config` +
        ` · base ${configUsed.baseTradeAmountSol} SOL` +
        ` · SL ${configUsed.stopLossPercent}%` +
        ` · fetching (SOL ≈ $${solUsd.toFixed(0)})`,
      startedAt: Date.now(),
      finishedAt: null,
    });
    await sleep(10);

    let events: LaunchEvent[] = [];
    let dataSource = 'synthetic';

    if (useLiveData) {
      const fetched = await fetchRecentLaunches({
        fromMs,
        toMs,
        allowSynthetic,
        maxResults: Math.max(maxTrades * 5, 80),
      });
      events = fetched.events;
      dataSource = fetched.source;
    } else {
      events = generateSyntheticLaunches(
        fromMs,
        toMs,
        Math.min(Math.max(maxTrades * 3, 24), 60)
      );
      dataSource = 'synthetic';
    }

    if (migrationsOnly || strategyType === 'migration') {
      events = events.filter((e) => e.migrated);
    }
    if (pumpFunOnly) {
      events = events.filter((e) => e.isPumpFun ?? !e.migrated);
    }

    const runOptsBase = {
      maxTrades,
      startingBalance,
      strategyType,
      minLiquidityUsd,
      minMarketCapUsd,
      maxRiskScore,
      minVolumeUsd,
      pumpFunOnly,
      reBuyEnabled,
      solUsd,
    };

    const executeSims = async (
      passEvents: LaunchEvent[],
      labelPrefix: string
    ) => {
      const allSkipped: { mint: string; reason: string }[] = [];
      const runStats: Array<ReturnType<PaperTrader['getStats']>> = [];
      let lastTrades: BacktestTradeResult[] = [];
      let lastTrader: PaperTrader | null = null;
      let considered = 0;
      let progressCursor = 0;

      setProgress({
        phase: 'simulating',
        message: `${labelPrefix} · ${passEvents.length} events × ${simulations} run(s)`,
        total: simulations * Math.max(passEvents.length, 1),
        current: 0,
      });

      for (let sim = 1; sim <= simulations; sim++) {
        let simEvents = passEvents;
        if (sim > 1 && dataSource === 'synthetic') {
          simEvents = generateSyntheticLaunches(
            fromMs,
            toMs,
            Math.min(maxTrades * 2, 30)
          );
          if (migrationsOnly || strategyType === 'migration') {
            simEvents = simEvents.filter((e) => e.migrated);
          }
          if (pumpFunOnly) {
            simEvents = simEvents.filter((e) => e.isPumpFun ?? !e.migrated);
          }
        } else if (sim > 1) {
          simEvents = [...passEvents].sort(() => Math.random() - 0.5);
        }

        const pass = runSinglePass(simEvents, {
          ...runOptsBase,
          simulation: sim,
          onProgress: (_cur, _tot, label) => {
            progressCursor += 1;
            setProgress({
              current: progressCursor,
              total: Math.max(
                simulations * Math.max(passEvents.length, 1),
                progressCursor
              ),
              message: `${labelPrefix} · Sim ${sim}/${simulations} · ${label}`,
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

      return { allSkipped, runStats, lastTrades, lastTrader, considered };
    };

    // Optional Low/Medium/High comparison on the same events
    let riskComparison: BacktestResult['riskComparison'];
    if (compareRiskLevels) {
      riskComparison = [];
      const compareSnap = captureTradingConfigSnapshot();
      for (const level of ['low', 'medium', 'high'] as RiskLevel[]) {
        applyRiskLevel(level, { persist: false });
        const cmp = await executeSims(events, `Compare ${level}`);
        const sum = buildSummary(
          cmp.lastTrades,
          solUsd,
          startingBalance
        );
        riskComparison.push({
          riskLevel: level,
          tradesExecuted: cmp.lastTrades.length,
          winRatePct: Number(sum.winRatePct.toFixed(1)),
          totalPnlSol: Number(sum.totalPnlSol.toFixed(4)),
          profitFactor: sum.profitFactor,
          maxDrawdownPct: sum.maxDrawdownPct,
          sharpeRatio: sum.sharpeRatio,
          avgHoldMs: sum.avgHoldingMs,
          message: `${level}: ${cmp.lastTrades.length} trades · WR ${sum.winRatePct.toFixed(0)}% · PnL ${sum.totalPnlSol.toFixed(3)} SOL · PF ${sum.profitFactor}`,
        });
      }
      restoreTradingConfigSnapshot(compareSnap);
      // Re-apply primary level for the main run
      if (
        requestedLevel === 'low' ||
        requestedLevel === 'medium' ||
        requestedLevel === 'high'
      ) {
        applyRiskLevel(requestedLevel, { persist: false });
      } else {
        restoreTradingConfigSnapshot(savedSnap);
      }
    }

    const primary = await executeSims(
      events,
      `Risk ${(config.riskLevel || 'medium').toUpperCase()}`
    );
    const trader =
      primary.lastTrader ??
      new PaperTrader(startingBalance, { mode: 'backtest' });
    const stats = trader.getStats();
    const baseCharts = trader.getChartData();
    const summary = buildSummary(primary.lastTrades, solUsd, startingBalance);
    if (!Number.isFinite(summary.returnPct) || summary.totalTrades === 0) {
      summary.returnPct = stats.returnPct;
    }

    const charts = {
      ...baseCharts,
      equityCurve: buildEquityCurve(primary.lastTrades, startingBalance),
      pnlDistribution: buildPnlDistribution(primary.lastTrades),
      strategyBreakdown: {
        labels: summary.strategyBreakdown.map((s) => s.strategyKind),
        pnlSol: summary.strategyBreakdown.map((s) => s.totalPnlSol),
        winRatePct: summary.strategyBreakdown.map((s) => s.winRatePct),
        trades: summary.strategyBreakdown.map((s) => s.trades),
      },
      riskComparison: riskComparison?.length
        ? {
            labels: riskComparison.map((r) => r.riskLevel),
            pnlSol: riskComparison.map((r) => r.totalPnlSol),
            winRatePct: riskComparison.map((r) => r.winRatePct),
            profitFactor: riskComparison.map((r) => r.profitFactor),
            maxDrawdownPct: riskComparison.map((r) => r.maxDrawdownPct),
            trades: riskComparison.map((r) => r.tradesExecuted),
          }
        : undefined,
    };

    const aggregate =
      simulations > 1
        ? {
            avgWinRatePct:
              primary.runStats.reduce((s, r) => s + r.winRatePct, 0) /
              primary.runStats.length,
            avgNetPnlSol:
              primary.runStats.reduce((s, r) => s + r.netPnlSol, 0) /
              primary.runStats.length,
            avgReturnPct:
              primary.runStats.reduce((s, r) => s + r.returnPct, 0) /
              primary.runStats.length,
            runs: simulations,
          }
        : undefined;

    const configUsedFinal = buildConfigUsedSnapshot();
    const message =
      primary.lastTrades.length === 0
        ? `No trades simulated (source=${dataSource}, events=${events.length}, risk=${configUsedFinal.riskLevel}). Widen window or loosen filters.`
        : `Backtest (${configUsedFinal.riskLevel} risk): ${primary.lastTrades.length} trades` +
          (simulations > 1 ? ` × ${simulations} sims` : '') +
          `, net ${stats.netPnlSol.toFixed(4)} SOL (~$${summary.totalPnlUsd.toFixed(0)}), WR ${stats.winRatePct.toFixed(0)}%` +
          ` · PF ${summary.profitFactor}` +
          ` · Sharpe ${summary.sharpeRatio}` +
          ` · maxDD ${summary.maxDrawdownPct}%` +
          ` · base ${configUsedFinal.baseTradeAmountSol} SOL / SL ${configUsedFinal.stopLossPercent}%` +
          (summary.reBuyTrades ? ` · ${summary.reBuyTrades} rebuys` : '') +
          (aggregate
            ? ` · avg WR ${aggregate.avgWinRatePct.toFixed(0)}%`
            : '');

    logger.info('Backtest', message, {
      trades: primary.lastTrades.length,
      simulations,
      dataSource,
      riskLevel: configUsedFinal.riskLevel,
    });

    const result: BacktestResult = {
      ok: primary.lastTrades.length > 0,
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
        riskLevel: requestedLevel,
        compareRiskLevels,
        useSavedConfigFilters,
      },
      configUsed: configUsedFinal,
      riskComparison,
      period: {
        fromMs,
        toMs,
        hours: (toMs - fromMs) / (60 * 60 * 1000),
      },
      dataSource,
      eventsConsidered: primary.considered,
      tradesExecuted: primary.lastTrades.length,
      simulationsRun: simulations,
      stats,
      summary,
      aggregate,
      charts,
      trades: primary.lastTrades,
      skipped: primary.allSkipped.slice(0, 40),
      message,
    };

    storeResult(result);
    setProgress({
      running: false,
      phase: 'done',
      pct: 100,
      current: progress.total || 1,
      message: message.slice(0, 140),
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
  } finally {
    // Always restore the user's live saved config after a backtest override
    restoreTradingConfigSnapshot(savedSnap);
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
    configUsed: lastResult.configUsed,
    riskComparison: lastResult.riskComparison,
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
      winLossRatio: lastResult.summary.winLossRatio,
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
    /** Flattened exit debug lines across trades */
    debugLog: lastResult.trades.flatMap((t) => [
      `── ${t.symbol} (${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct}%) ──`,
      ...(t.debugLog || []),
      '',
    ]),
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
