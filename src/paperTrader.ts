/**
 * Paper trading engine with realistic slippage/fee simulation,
 * position tracking, and automatic take-profit / stop-loss checks.
 */

import { config, randomTakeProfitPct } from './config';
import { formatTokenLabel, mintPrefix } from './tokenMeta';
import { registerProfitSell, getSellHistory } from './reBuy';
import {
  getStrategyRiskRules,
  computeEquitySol,
  evaluateRiskLimits,
  resetPeakEquity,
} from './risk';
import {
  evaluateProfitAction,
  type ProfitPositionView,
} from './profitStrategy';
import { marketCapAtPrice, getCachedSolUsdPrice, reconcileMarkPriceSol } from './marketData';
import { loadPaperBalance, savePaperBalance } from './paperStateStore';

/** Hard ceiling on realized exit multiple vs entry (last-resort balance guard). */
const MAX_EXIT_PRICE_MULTIPLE = 50;

export type PositionStatus = 'open' | 'closed' | 'partial';

export interface Position {
  id: string;
  mint: string;
  /** Token ticker / ticket (e.g. BONK) */
  symbol: string;
  /** Full token name (e.g. Bonk) */
  name: string;
  entryPriceSol: number;
  amountTokens: number;
  costSol: number;
  /** Original size at open (for tiered % sells) */
  initialAmountTokens: number;
  initialCostSol: number;
  takeProfitPct: number;
  stopLossPct: number;
  /** Peak price since entry (trailing) */
  highWaterMarkSol: number;
  trailingStopPct: number;
  /** True once profit hit trailingActivationProfit */
  trailingActive: boolean;
  trailingActivatedAt?: number;
  /** Absolute stop price = peak * (1 - trail%) when active */
  trailingStopPriceSol?: number;
  /** Which tier indices have fired (legacy tiers) */
  tiersHit: number[];
  /** Advanced profit strategy stage flags */
  initialRecovered: boolean;
  partialSellDone: boolean;
  bagTrimDone: boolean;
  /** Cumulative net SOL returned from sells (for recover-initial) */
  solReturned: number;
  /** migration | normal risk rules */
  strategyKind: 'migration' | 'normal';
  /** Paper vs live-tracked (live sells via trade.executeSell) */
  tradeMode?: 'paper' | 'live';
  /** Live token amount string for Jupiter sells */
  liveTokenAmount?: string;
  /** Realized PnL from partial sells */
  realizedPnlSol: number;
  openedAt: number;
  closedAt?: number;
  exitPriceSol?: number;
  pnlSol?: number;
  pnlPct?: number;
  status: PositionStatus;
  reason?: string;
  /** Source wallets that triggered this copy trade */
  sourceWallets?: string[];
  sourceNames?: string[];
  /** Anti-rug snapshot at entry */
  antiRug?: {
    riskScore: number;
    riskLevel: string;
    flags: string[];
    ok: boolean;
  };
  /** Market cap USD at entry fill (DexScreener, scaled to fill price when possible) */
  entryMarketCapUsd?: number;
  /** Market cap USD at exit (scaled from entry MC by exit/entry price) */
  exitMarketCapUsd?: number;
  /**
   * Wall-clock ms when rolling 1h volume / tx activity first went "dead".
   * Cleared when activity recovers above thresholds.
   */
  deadMarketBelowSince?: number;
}

/** DexScreener short-window activity for dead-market exits */
export interface MarketActivitySample {
  volumeH1Usd: number;
  txnsH1: number;
  updatedAt: number;
}

export interface TradeLog {
  id: string;
  timestamp: number;
  type: 'buy' | 'sell' | 'signal' | 'info' | 'error';
  message: string;
  mint?: string;
  symbol?: string;
  name?: string;
  solAmount?: number;
  pnlSol?: number;
}

export interface PaperTraderState {
  balanceSol: number;
  positions: Position[];
  closedPositions: Position[];
  logs: TradeLog[];
}

let logCounter = 0;

function nextId(prefix: string): string {
  logCounter += 1;
  return `${prefix}-${Date.now()}-${logCounter}`;
}

function applySlippage(price: number, bps: number, direction: 'buy' | 'sell'): number {
  const factor = bps / 10_000;
  return direction === 'buy' ? price * (1 + factor) : price * (1 - factor);
}

function applyFee(amountSol: number, bps: number): number {
  return amountSol * (bps / 10_000);
}

export class PaperTrader {
  private balanceSol: number;
  private startingBalanceSol: number;
  private mode: 'paper' | 'backtest';
  private positions: Map<string, Position> = new Map();
  private closedPositions: Position[] = [];
  private logs: TradeLog[] = [];
  private priceCache: Map<string, number> = new Map();
  /** Latest DexScreener activity per mint (for dead-volume exits) */
  private marketActivityCache: Map<string, MarketActivitySample> = new Map();
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    startingBalance?: number,
    options: { mode?: 'paper' | 'backtest' } = {}
  ) {
    this.startingBalanceSol =
      startingBalance ?? config.paper.startingBalanceSol;
    this.balanceSol = this.startingBalanceSol;
    this.mode = options.mode ?? 'paper';
    resetPeakEquity(this.balanceSol);
    this.log(
      'info',
      `${this.mode === 'backtest' ? 'Backtest' : 'Paper'} trader initialized with ${this.balanceSol.toFixed(4)} SOL`
    );
  }

  getMode(): 'paper' | 'backtest' {
    return this.mode;
  }

  /** Persist paper balance + positions (no-op for backtest mode). */
  private persistState(): void {
    if (this.mode !== 'paper') return;
    savePaperBalance({
      balanceSol: this.balanceSol,
      startingBalanceSol: this.startingBalanceSol,
      positions: Array.from(this.positions.values()),
      closedPositions: this.closedPositions,
    });
  }

  /**
   * Load paperBalance.json after boot (call once from index after settings load).
   */
  loadPersistedState(): boolean {
    if (this.mode !== 'paper') return false;
    const saved = loadPaperBalance();
    if (!saved) {
      console.log('[paper] No paperBalance.json — using starting balance');
      this.persistState();
      return false;
    }
    this.balanceSol = saved.balanceSol;
    this.startingBalanceSol =
      saved.startingBalanceSol || config.paper.startingBalanceSol;
    this.positions.clear();
    for (const p of saved.positions) {
      if (p?.id && p.status !== 'closed') {
        this.positions.set(p.id, { ...p });
      }
    }
    this.closedPositions = (saved.closedPositions || []).map((p) => ({ ...p }));
    resetPeakEquity(this.getEquitySol());
    console.log(
      `[paper] Loaded paperBalance.json — balance ${this.balanceSol.toFixed(4)} SOL, ` +
        `${this.positions.size} open, ${this.closedPositions.length} closed`
    );
    return true;
  }

  getStartingBalance(): number {
    return this.startingBalanceSol;
  }

  /** Register or update a token price (SOL per token) for simulation */
  setTokenPrice(
    mint: string,
    priceSol: number,
    meta?: { marketCapUsd?: number | null }
  ): void {
    if (!(priceSol > 0) || !Number.isFinite(priceSol)) return;

    let mark = priceSol;
    for (const pos of this.positions.values()) {
      if (pos.mint !== mint || pos.status === 'closed') continue;
      if (!(pos.entryPriceSol > 0)) break;
      const reconciled = reconcileMarkPriceSol({
        entryPriceSol: pos.entryPriceSol,
        markPriceSol: priceSol,
        entryMarketCapUsd: pos.entryMarketCapUsd,
        markMarketCapUsd: meta?.marketCapUsd,
      });
      if (reconciled.rejected) {
        console.warn(
          `[paper] Rejected absurd mark for ${mint.slice(0, 8)}… ` +
            `(${reconciled.reason}) — keeping prior price`
        );
        return;
      }
      if (reconciled.adjusted) {
        console.warn(
          `[paper] Adjusted mark for ${mint.slice(0, 8)}… ` +
            `${priceSol.toExponential(3)} → ${reconciled.priceSol.toExponential(3)} ` +
            `(${reconciled.reason})`
        );
      }
      mark = reconciled.priceSol;
      break;
    }
    this.priceCache.set(mint, mark);
  }

  getTokenPrice(mint: string): number | undefined {
    return this.priceCache.get(mint);
  }

  /** Cache DexScreener 1h volume / txn activity for dead-market exits */
  setMarketActivity(
    mint: string,
    sample: { volumeH1Usd: number; txnsH1: number; updatedAt?: number }
  ): void {
    this.marketActivityCache.set(mint, {
      volumeH1Usd: Math.max(0, sample.volumeH1Usd),
      txnsH1: Math.max(0, Math.floor(sample.txnsH1)),
      updatedAt: sample.updatedAt ?? Date.now(),
    });
  }

  getMarketActivity(mint: string): MarketActivitySample | undefined {
    return this.marketActivityCache.get(mint);
  }

  getBalance(): number {
    return this.balanceSol;
  }

  /** True if any open/partial position already holds this mint */
  hasOpenMint(mint: string): boolean {
    for (const p of this.positions.values()) {
      if (p.mint === mint && p.status !== 'closed') return true;
    }
    return false;
  }

  getOpenPositions(): Position[] {
    return Array.from(this.positions.values()).map((p) =>
      this.withTrailSnapshot(p)
    );
  }

  /** Enrich position with current trailing stop price for UI / API */
  withTrailSnapshot(position: Position): Position & {
    volumeH1Usd?: number | null;
    txnsH1?: number | null;
    costUsd?: number;
    solUsd?: number;
  } {
    const trailPct =
      position.trailingStopPct ||
      config.risk.trailingStopPercent ||
      config.risk.trailingStopPct ||
      20;
    const stopPrice = position.trailingActive
      ? position.highWaterMarkSol * (1 - trailPct / 100)
      : undefined;
    const current = this.priceCache.get(position.mint);
    const unrealizedPct =
      current != null && position.entryPriceSol > 0
        ? ((current - position.entryPriceSol) / position.entryPriceSol) * 100
        : undefined;
    const activity = this.marketActivityCache.get(position.mint);
    const solUsd = getCachedSolUsdPrice();
    const costUsd =
      position.costSol > 0 && solUsd > 0
        ? Number((position.costSol * solUsd).toFixed(2))
        : undefined;
    return {
      ...position,
      trailingStopPct: trailPct,
      trailingStopPriceSol: stopPrice,
      pnlPct: unrealizedPct ?? position.pnlPct,
      volumeH1Usd: activity ? activity.volumeH1Usd : null,
      txnsH1: activity ? activity.txnsH1 : null,
      costUsd,
      solUsd,
    };
  }

  /**
   * Track a live trade for trailing / TP-SL without touching paper balance.
   */
  registerLivePosition(input: {
    mint: string;
    symbol: string;
    name?: string;
    entryPriceSol: number;
    costSol: number;
    amountTokens: number;
    tokenAmountRaw?: string;
    strategyKind?: 'migration' | 'normal';
    sourceWallets?: string[];
    sourceNames?: string[];
    antiRug?: Position['antiRug'];
    entryMarketCapUsd?: number;
  }): Position {
    if (this.hasOpenMint(input.mint)) {
      throw new Error(
        `Already holding open position on ${input.mint.slice(0, 8)}…`
      );
    }
    const strategyKind = input.strategyKind ?? 'normal';
    const rules = getStrategyRiskRules(strategyKind);
    const trailPct =
      rules.trailingStopPct ??
      config.risk.trailingStopPercent ??
      config.risk.trailingStopPct;

    const position: Position = {
      id: nextId('live'),
      mint: input.mint,
      symbol: input.symbol,
      name: (input.name || input.symbol).trim(),
      entryPriceSol: input.entryPriceSol,
      amountTokens: input.amountTokens,
      costSol: input.costSol,
      initialAmountTokens: input.amountTokens,
      initialCostSol: input.costSol,
      takeProfitPct: config.profitStrategy?.enabled
        ? config.trade.maxProfitPercent
        : randomTakeProfitPct(),
      stopLossPct: rules.hardStopLossPct ?? config.trade.stopLossPercent,
      highWaterMarkSol: input.entryPriceSol,
      trailingStopPct: config.profitStrategy?.enabled
        ? config.profitStrategy.trailingStopPct
        : trailPct,
      trailingActive: false,
      tiersHit: [],
      initialRecovered: false,
      partialSellDone: false,
      bagTrimDone: false,
      solReturned: 0,
      strategyKind,
      realizedPnlSol: 0,
      tradeMode: 'live',
      liveTokenAmount: input.tokenAmountRaw,
      openedAt: Date.now(),
      status: 'open',
      sourceWallets: input.sourceWallets,
      sourceNames: input.sourceNames,
      antiRug: input.antiRug,
      entryMarketCapUsd:
        input.entryMarketCapUsd != null &&
        Number.isFinite(input.entryMarketCapUsd) &&
        input.entryMarketCapUsd > 0
          ? input.entryMarketCapUsd
          : undefined,
    };

    this.positions.set(position.id, position);
    this.priceCache.set(input.mint, input.entryPriceSol);
    const trailArm = config.profitStrategy?.enabled
      ? config.profitStrategy.trailingStopAfter
      : config.risk.trailingActivationProfit;
    this.log(
      'info',
      `Live position tracked ${formatTokenLabel(position.symbol, position.name, position.mint)} ` +
        `@ ${input.entryPriceSol.toExponential(4)} — trail arms at +${trailArm}%`
    );
    return position;
  }

  getClosedPositions(): Position[] {
    const solUsd = getCachedSolUsdPrice();
    return this.closedPositions.map((p) => {
      const costBasis =
        p.costSol > 0
          ? p.costSol
          : p.initialCostSol > 0
            ? p.initialCostSol
            : 0;
      const costUsd =
        costBasis > 0 && solUsd > 0
          ? Number((costBasis * solUsd).toFixed(2))
          : undefined;
      return {
        ...p,
        costSol: costBasis,
        costUsd,
        solUsd,
      } as Position & { costUsd?: number; solUsd?: number };
    });
  }

  getLogs(limit = 100): TradeLog[] {
    return this.logs.slice(-limit);
  }

  getState(): PaperTraderState {
    return {
      balanceSol: this.balanceSol,
      positions: this.getOpenPositions(),
      closedPositions: this.getClosedPositions(),
      logs: this.getLogs(),
    };
  }

  /** Record a trade/info log (dashboard feed) */
  addLog(
    type: TradeLog['type'],
    message: string,
    extra?: Partial<TradeLog>
  ): void {
    this.log(type, message, extra);
  }

  private log(
    type: TradeLog['type'],
    message: string,
    extra?: Partial<TradeLog>
  ): void {
    const entry: TradeLog = {
      id: nextId('log'),
      timestamp: Date.now(),
      type,
      message,
      ...extra,
    };
    this.logs.push(entry);
    if (this.logs.length > 500) {
      this.logs = this.logs.slice(-500);
    }
    const prefix =
      type === 'error' ? '❌' : type === 'buy' ? '🟢' : type === 'sell' ? '🔴' : 'ℹ️';
    console.log(`[paper] ${prefix} ${message}`);
  }

  /**
   * Simulate a buy with slippage and fees.
   * Returns the opened position or null if insufficient balance.
   */
  simulateBuy(
    mint: string,
    symbol: string,
    priceSol: number,
    solAmount?: number,
    meta?: {
      sourceWallets?: string[];
      sourceNames?: string[];
      name?: string;
      slippageBps?: number;
      strategyKind?: 'migration' | 'normal';
      antiRug?: Position['antiRug'];
      entryMarketCapUsd?: number;
    }
  ): Position | null {
    const spendSol =
      solAmount ??
      config.trade.baseTradeAmountSol ??
      config.trade.tradeAmountSol;
    const tokenName = (meta?.name || symbol || mintPrefix(mint)).trim();
    const tokenSymbol = (symbol || mintPrefix(mint)).trim();
    const label = formatTokenLabel(tokenSymbol, tokenName, mint);
    const strategyKind = meta?.strategyKind ?? 'normal';
    const rules = getStrategyRiskRules(strategyKind);

    if (this.hasOpenMint(mint)) {
      this.log(
        'error',
        `Already holding open position on ${label} — refusing duplicate buy`
      );
      return null;
    }

    if (spendSol > this.balanceSol) {
      this.log('error', `Insufficient balance: need ${spendSol} SOL, have ${this.balanceSol.toFixed(4)}`);
      return null;
    }

    const feeBps = config.paper.feeBps;
    const slippageBps = meta?.slippageBps ?? config.paper.slippageBps;
    const fee = applyFee(spendSol, feeBps);
    const netSol = spendSol - fee;
    const entryPrice = applySlippage(priceSol, slippageBps, 'buy');
    const amountTokens = netSol / entryPrice;

    this.balanceSol -= spendSol;
    this.priceCache.set(mint, priceSol);

    const position: Position = {
      id: nextId('pos'),
      mint,
      symbol: tokenSymbol,
      name: tokenName,
      entryPriceSol: entryPrice,
      amountTokens,
      costSol: spendSol,
      initialAmountTokens: amountTokens,
      initialCostSol: spendSol,
      takeProfitPct: config.profitStrategy?.enabled
        ? config.trade.maxProfitPercent
        : randomTakeProfitPct(),
      stopLossPct: rules.hardStopLossPct ?? config.trade.stopLossPercent,
      highWaterMarkSol: entryPrice,
      trailingStopPct: config.profitStrategy?.enabled
        ? config.profitStrategy.trailingStopPct
        : rules.trailingStopPct ??
          config.risk.trailingStopPercent ??
          config.risk.trailingStopPct,
      trailingActive: false,
      trailingStopPriceSol: undefined,
      tiersHit: [],
      initialRecovered: false,
      partialSellDone: false,
      bagTrimDone: false,
      solReturned: 0,
      strategyKind,
      realizedPnlSol: 0,
      tradeMode: 'paper',
      openedAt: Date.now(),
      status: 'open',
      sourceWallets: meta?.sourceWallets,
      sourceNames: meta?.sourceNames,
      antiRug: meta?.antiRug,
      entryMarketCapUsd:
        meta?.entryMarketCapUsd != null &&
        Number.isFinite(meta.entryMarketCapUsd) &&
        meta.entryMarketCapUsd > 0
          ? meta.entryMarketCapUsd
          : undefined,
    };

    this.positions.set(position.id, position);
    const mcBit =
      position.entryMarketCapUsd != null
        ? ` MC~$${Math.round(position.entryMarketCapUsd).toLocaleString()}`
        : '';
    this.log(
      'buy',
      `Bought ${label} (${mint.slice(0, 8)}…) — ${amountTokens.toFixed(2)} tokens @ ${entryPrice.toExponential(4)} SOL ` +
        `(${spendSol.toFixed(4)} SOL, ${strategyKind}, trail ${position.trailingStopPct}%${mcBit})`,
      { mint, symbol: tokenSymbol, name: tokenName, solAmount: spendSol }
    );
    this.persistState();

    return position;
  }

  /**
   * Full or partial sell. `fraction` is share of *current* remaining tokens (0–1).
   * For tiered sells use `sellPctOfInitial` instead.
   */
  simulateSell(
    positionId: string,
    currentPriceSol: number,
    reason: string,
    options?: {
      fraction?: number;
      sellPctOfInitial?: number;
      tokensToSell?: number;
    }
  ): Position | null {
    const position = this.positions.get(positionId);
    if (!position) {
      this.log('error', `Position not found: ${positionId}`);
      return null;
    }

    let tokensToSell = position.amountTokens;
    if (options?.tokensToSell != null && options.tokensToSell > 0) {
      tokensToSell = Math.min(position.amountTokens, options.tokensToSell);
    } else if (options?.sellPctOfInitial != null) {
      tokensToSell = Math.min(
        position.amountTokens,
        position.initialAmountTokens * (options.sellPctOfInitial / 100)
      );
    } else if (options?.fraction != null) {
      tokensToSell = position.amountTokens * Math.min(1, Math.max(0, options.fraction));
    }

    if (tokensToSell <= 0) return null;

    const isPartial = tokensToSell < position.amountTokens * 0.999;

    const { feeBps, slippageBps } = config.paper;
    // Guard against unit-mismatch marks that would credit absurd SOL to paper balance
    let safeMark = currentPriceSol;
    if (position.entryPriceSol > 0 && currentPriceSol > 0) {
      const ratio = currentPriceSol / position.entryPriceSol;
      if (
        ratio > MAX_EXIT_PRICE_MULTIPLE ||
        ratio < 1 / MAX_EXIT_PRICE_MULTIPLE
      ) {
        const clamped = Math.min(
          MAX_EXIT_PRICE_MULTIPLE,
          Math.max(1 / MAX_EXIT_PRICE_MULTIPLE, ratio)
        );
        safeMark = position.entryPriceSol * clamped;
        console.warn(
          `[paper] Clamped exit mark ratio ${ratio.toExponential(2)} → ${clamped.toFixed(2)}x ` +
            `for ${position.symbol || position.mint.slice(0, 8)}`
        );
      }
    }
    const exitPrice = applySlippage(safeMark, slippageBps, 'sell');
    const grossSol = tokensToSell * exitPrice;
    const fee = applyFee(grossSol, feeBps);
    let netSol = grossSol - fee;

    const costBasisSold =
      position.costSol * (tokensToSell / position.amountTokens);
    // Second-line guard: proceeds cannot exceed cost × max multiple
    if (costBasisSold > 0 && netSol > costBasisSold * MAX_EXIT_PRICE_MULTIPLE) {
      netSol = costBasisSold * MAX_EXIT_PRICE_MULTIPLE;
      console.warn(
        `[paper] Clamped exit proceeds to ${MAX_EXIT_PRICE_MULTIPLE}× cost ` +
          `(${netSol.toFixed(4)} SOL) for ${position.symbol || position.mint.slice(0, 8)}`
      );
    }
    const pnlSol = netSol - costBasisSold;
    const pnlPct = costBasisSold > 0 ? (pnlSol / costBasisSold) * 100 : 0;

    this.balanceSol += netSol;
    position.realizedPnlSol += pnlSol;
    position.solReturned = (position.solReturned ?? 0) + netSol;
    position.amountTokens -= tokensToSell;
    position.costSol -= costBasisSold;

    // Keep live raw amount roughly in sync for partial live sells
    if (position.tradeMode === 'live' && position.liveTokenAmount) {
      try {
        const raw = BigInt(position.liveTokenAmount);
        const soldShare =
          position.initialAmountTokens > 0
            ? tokensToSell / position.initialAmountTokens
            : 1;
        const remain = raw - (raw * BigInt(Math.floor(soldShare * 1e6))) / 1_000_000n;
        position.liveTokenAmount = remain > 0n ? remain.toString() : '0';
      } catch {
        /* ignore */
      }
    }

    const label = formatTokenLabel(position.symbol, position.name, position.mint);
    const exitMc =
      position.entryMarketCapUsd != null && position.entryPriceSol > 0
        ? marketCapAtPrice(
            position.entryMarketCapUsd,
            position.entryPriceSol,
            exitPrice
          )
        : undefined;

    if (isPartial && position.amountTokens > 1e-12) {
      position.status = 'partial';
      const pctLabel =
        options?.sellPctOfInitial != null
          ? `${options.sellPctOfInitial}% of initial`
          : `${((options?.fraction ?? 1) * 100).toFixed(0)}% remaining`;
      this.log(
        'sell',
        `Partial sell ${label} — ${pctLabel} ` +
          `PnL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct.toFixed(1)}%) [${reason}] ` +
          `· remaining ${position.amountTokens.toFixed(2)} tokens`,
        {
          mint: position.mint,
          symbol: position.symbol,
          name: position.name,
          solAmount: netSol,
          pnlSol,
        }
      );

      // Record slice in closed history for tracking
      const slice: Position = {
        ...position,
        id: nextId('part'),
        amountTokens: tokensToSell,
        costSol: costBasisSold,
        status: 'closed',
        closedAt: Date.now(),
        exitPriceSol: exitPrice,
        exitMarketCapUsd: exitMc,
        pnlSol,
        pnlPct,
        reason: `partial: ${reason}`,
      };
      this.closedPositions.push(slice);
      if (this.closedPositions.length > 200) {
        this.closedPositions = this.closedPositions.slice(-200);
      }
      this.persistState();
      return slice;
    }

    // Full close
    const totalPnl = position.realizedPnlSol;
    const totalPct =
      position.initialCostSol > 0
        ? (totalPnl / position.initialCostSol) * 100
        : pnlPct;
    const closedCostSol =
      position.initialCostSol > 0 ? position.initialCostSol : costBasisSold;
    const closedTokens =
      position.initialAmountTokens > 0
        ? position.initialAmountTokens
        : tokensToSell;

    position.status = 'closed';
    position.closedAt = Date.now();
    position.exitPriceSol = exitPrice;
    position.exitMarketCapUsd = exitMc;
    position.pnlSol = totalPnl;
    position.pnlPct = totalPct;
    position.reason = reason;
    position.amountTokens = 0;
    position.costSol = 0;

    this.positions.delete(positionId);
    this.closedPositions.push({
      ...position,
      // Preserve buy-in for Closed Trades UI (open book zeros costSol)
      costSol: closedCostSol,
      amountTokens: closedTokens,
    });
    if (this.closedPositions.length > 200) {
      this.closedPositions = this.closedPositions.slice(-200);
    }

    const perf = this.getStats();
    this.log(
      'sell',
      `Sold ${label} — PnL: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} SOL (${totalPct.toFixed(1)}%) [${reason}] ` +
        `· WR ${perf.winRatePct.toFixed(0)}% · PF ${perf.profitFactor} · maxDD ${perf.maxDrawdownPct}%`,
      {
        mint: position.mint,
        symbol: position.symbol,
        name: position.name,
        solAmount: netSol,
        pnlSol: totalPnl,
      }
    );

    if (totalPct > 0) {
      registerProfitSell({
        mint: position.mint,
        symbol: position.symbol,
        name: position.name,
        positionId: position.id,
        soldAt: position.closedAt!,
        sellPriceSol: exitPrice,
        pnlPct: totalPct,
        pnlSol: totalPnl,
        reason,
        sourceWallets: position.sourceWallets,
        sourceNames: position.sourceNames,
      });
    }

    this.persistState();
    return position;
  }

  /** Sell history for a mint (or all), including re-buy watch metadata */
  getSellHistoryForMint(mint?: string) {
    return getSellHistory(mint);
  }

  getEquitySol(): number {
    let openCost = 0;
    let unrealized = 0;
    for (const p of this.positions.values()) {
      openCost += p.costSol;
      const px = this.priceCache.get(p.mint);
      if (px != null) {
        unrealized += p.amountTokens * px - p.costSol;
      }
    }
    return computeEquitySol(this.balanceSol, openCost, unrealized);
  }

  getWeeklyPnlSol(): number {
    const start = new Date();
    const day = start.getUTCDay();
    const diff = (day + 6) % 7; // Monday-based week
    start.setUTCDate(start.getUTCDate() - diff);
    start.setUTCHours(0, 0, 0, 0);
    const cut = start.getTime();
    return this.closedPositions
      .filter((p) => p.closedAt && p.closedAt >= cut)
      .reduce((sum, p) => sum + (p.pnlSol ?? 0), 0);
  }

  evaluateAndMaybeHaltRisk(): ReturnType<typeof evaluateRiskLimits> {
    return evaluateRiskLimits({
      equitySol: this.getEquitySol(),
      dailyPnlSol: this.getDailyPnlSol(),
      weeklyPnlSol: this.getWeeklyPnlSol(),
    });
  }

  /**
   * Add SOL to the paper balance (top-up / funding).
   * Returns the new balance.
   */
  topUp(amountSol: number): number {
    if (!Number.isFinite(amountSol) || amountSol <= 0) {
      this.log('error', `Top-up rejected: amount must be a positive number`);
      throw new Error('amountSol must be a positive number');
    }

    this.balanceSol += amountSol;
    this.log(
      'info',
      `Topped up +${amountSol.toFixed(4)} SOL → balance ${this.balanceSol.toFixed(4)} SOL`,
      { solAmount: amountSol }
    );
    this.persistState();
    return this.balanceSol;
  }

  /**
   * Reset paper balance to config.paper.startingBalanceSol and clear open positions.
   * Closed trade history is kept unless clearHistory is true.
   */
  reset(options?: { clearHistory?: boolean }): {
    balanceSol: number;
    clearedOpen: number;
    clearedHistory: boolean;
  } {
    const clearedOpen = this.positions.size;
    this.positions.clear();
    this.balanceSol = config.paper.startingBalanceSol;
    this.startingBalanceSol = config.paper.startingBalanceSol;

    const clearHistory = Boolean(options?.clearHistory);
    if (clearHistory) {
      this.closedPositions = [];
      this.logs = [];
    }

    resetPeakEquity(this.balanceSol);

    this.log(
      'info',
      `Paper reset → ${this.balanceSol.toFixed(4)} SOL` +
        (clearedOpen ? ` (closed ${clearedOpen} open position(s))` : '') +
        (clearHistory ? ' · history cleared' : ' · closed history kept')
    );

    this.persistState();

    return {
      balanceSol: this.balanceSol,
      clearedOpen,
      clearedHistory: clearHistory,
    };
  }

  /**
   * Synchronous exit evaluation for paper/backtest — same rules as checkPositions
   * (profit strategy OR legacy tiers/TP/trail). Skips live Jupiter path.
   * Returns one action's event, or null if nothing to do.
   */
  evaluatePositionTickSync(
    positionId: string,
    currentPrice: number
  ): {
    kind:
      | 'none'
      | 'arm_trail'
      | 'partial'
      | 'full'
      | 'hard_sl'
      | 'trail_exit'
      | 'take_profit'
      | 'tier'
      | 'info';
    reason: string;
    markPnlPct: number;
    stillOpen: boolean;
  } | null {
    if (!config.strategy.enableAutoSell && this.mode !== 'backtest') return null;

    const position = this.positions.get(positionId);
    if (!position || position.status === 'closed') return null;
    if (position.tradeMode === 'live') return null;

    this.setTokenPrice(position.mint, currentPrice);
    // Use reconciled cache mark (may reject/adjust absurd feeds)
    const markPrice = this.priceCache.get(position.mint) ?? currentPrice;
    if (!(markPrice > 0)) return null;

    if (position.initialAmountTokens == null) {
      position.initialAmountTokens = position.amountTokens;
      position.initialCostSol = position.costSol;
      position.highWaterMarkSol = position.entryPriceSol;
      position.trailingStopPct =
        getStrategyRiskRules(position.strategyKind ?? 'normal').trailingStopPct ??
        config.risk.trailingStopPercent;
      position.trailingActive = position.trailingActive ?? false;
      position.tiersHit = position.tiersHit ?? [];
      position.strategyKind = position.strategyKind ?? 'normal';
      position.realizedPnlSol = position.realizedPnlSol ?? 0;
    }
    position.initialRecovered = position.initialRecovered ?? false;
    position.partialSellDone = position.partialSellDone ?? false;
    position.bagTrimDone = position.bagTrimDone ?? false;
    position.solReturned = position.solReturned ?? 0;

    if (markPrice > position.highWaterMarkSol) {
      position.highWaterMarkSol = markPrice;
    }

    const markPnlPct =
      ((markPrice - position.entryPriceSol) / position.entryPriceSol) * 100;
    const label = formatTokenLabel(position.symbol, position.name, position.mint);

    // —— Advanced profit strategy (same as applyProfitStrategyTick, sync) ——
    if (config.profitStrategy?.enabled) {
      const view: ProfitPositionView = {
        entryPriceSol: position.entryPriceSol,
        currentPriceSol: markPrice,
        highWaterMarkSol: position.highWaterMarkSol,
        amountTokens: position.amountTokens,
        initialAmountTokens: position.initialAmountTokens,
        initialCostSol: position.initialCostSol,
        solReturned: position.solReturned ?? 0,
        trailingActive: position.trailingActive,
        trailingStopPct: position.trailingStopPct,
        stopLossPct: position.stopLossPct,
        maxProfitPct: Math.max(
          position.takeProfitPct,
          config.trade.maxProfitPercent
        ),
        initialRecovered: position.initialRecovered,
        partialSellDone: position.partialSellDone,
        bagTrimDone: position.bagTrimDone,
        riskScore: position.antiRug?.riskScore,
      };

      const action = evaluateProfitAction(view);
      if (action.type === 'none') {
        return {
          kind: 'none',
          reason: '',
          markPnlPct,
          stillOpen: true,
        };
      }

      if (action.type === 'arm_trail') {
        position.trailingActive = true;
        position.trailingActivatedAt = Date.now();
        position.trailingStopPct = action.trailPct;
        position.trailingStopPriceSol =
          position.highWaterMarkSol * (1 - action.trailPct / 100);
        this.log('info', `${label}: ${action.reason}`);
        return {
          kind: 'arm_trail',
          reason: action.reason,
          markPnlPct,
          stillOpen: true,
        };
      }

      if (
        action.type === 'hard_sl' ||
        action.type === 'trail_exit' ||
        action.type === 'full'
      ) {
        this.simulateSell(position.id, markPrice, action.reason);
        const kind =
          action.type === 'hard_sl'
            ? 'hard_sl'
            : action.type === 'trail_exit'
              ? 'trail_exit'
              : 'full';
        return {
          kind,
          reason: action.reason,
          markPnlPct,
          stillOpen: this.positions.has(positionId),
        };
      }

      if (action.type === 'partial') {
        if (
          (action.tokensToSell != null && action.tokensToSell <= 0) ||
          (action.sellPctOfInitial <= 0 && action.tokensToSell == null)
        ) {
          if (action.stage === 'recover_initial') position.initialRecovered = true;
          if (action.stage === 'partial') position.partialSellDone = true;
          if (action.stage === 'bag_trim') position.bagTrimDone = true;
          this.log('info', `${label}: ${action.reason}`);
          return {
            kind: 'info',
            reason: action.reason,
            markPnlPct,
            stillOpen: true,
          };
        }

        this.simulateSell(position.id, markPrice, action.reason, {
          tokensToSell: action.tokensToSell,
          sellPctOfInitial:
            action.tokensToSell == null ? action.sellPctOfInitial : undefined,
        });
        if (action.stage === 'partial') position.partialSellDone = true;
        if (action.stage === 'recover_initial') position.initialRecovered = true;
        if (action.stage === 'bag_trim') position.bagTrimDone = true;
        if (
          !position.initialRecovered &&
          (position.solReturned ?? 0) >= position.initialCostSol * 0.98
        ) {
          position.initialRecovered = true;
        }
        return {
          kind: 'partial',
          reason: action.reason,
          markPnlPct,
          stillOpen: this.positions.has(positionId),
        };
      }

      return null;
    }

    // —— Legacy path (profit strategy off) — same as checkPositions ——
    const rules = getStrategyRiskRules(position.strategyKind);
    const risk = config.risk;
    const hardSl = rules.hardStopLossPct ?? position.stopLossPct;

    if (markPnlPct <= hardSl) {
      const reason = `hard stop-loss ${hardSl}%`;
      this.simulateSell(position.id, markPrice, reason);
      return {
        kind: 'hard_sl',
        reason,
        markPnlPct,
        stillOpen: this.positions.has(positionId),
      };
    }

    if (risk.tieredSellEnabled && rules.tiers?.length) {
      for (let i = 0; i < rules.tiers.length; i++) {
        if (position.tiersHit.includes(i)) continue;
        const tier = rules.tiers[i];
        if (markPnlPct >= tier.profitPct) {
          position.tiersHit.push(i);
          const reason = `tier ${i + 1}: +${tier.profitPct}% → sell ${tier.sellPct}%`;
          this.simulateSell(position.id, markPrice, reason, {
            sellPctOfInitial: tier.sellPct,
          });
          return {
            kind: 'tier',
            reason,
            markPnlPct,
            stillOpen: this.positions.has(positionId),
          };
        }
      }
    } else if (markPnlPct >= position.takeProfitPct) {
      const reason = `take-profit ${position.takeProfitPct.toFixed(0)}%`;
      this.simulateSell(position.id, markPrice, reason);
      return {
        kind: 'take_profit',
        reason,
        markPnlPct,
        stillOpen: this.positions.has(positionId),
      };
    }

    const stillOpen = this.positions.get(positionId);
    if (!stillOpen) {
      return {
        kind: 'full',
        reason: 'closed',
        markPnlPct,
        stillOpen: false,
      };
    }

    const trailPct =
      stillOpen.trailingStopPct ||
      risk.trailingStopPercent ||
      risk.trailingStopPct ||
      20;
    const activation = risk.trailingActivationProfit ?? 30;

    if (!stillOpen.trailingActive && markPnlPct >= activation) {
      stillOpen.trailingActive = true;
      stillOpen.trailingActivatedAt = Date.now();
      stillOpen.trailingStopPct = trailPct;
      stillOpen.trailingStopPriceSol =
        stillOpen.highWaterMarkSol * (1 - trailPct / 100);
      const reason =
        `Trailing stop ACTIVATED at +${markPnlPct.toFixed(1)}% — ` +
        `${trailPct}% trail from peak`;
      this.log('info', `${label}: ${reason}`);
      return {
        kind: 'arm_trail',
        reason,
        markPnlPct,
        stillOpen: true,
      };
    }

    if (!stillOpen.trailingActive) {
      return {
        kind: 'none',
        reason: '',
        markPnlPct,
        stillOpen: true,
      };
    }

    stillOpen.trailingStopPriceSol =
      stillOpen.highWaterMarkSol * (1 - trailPct / 100);
    const trailTrigger = stillOpen.trailingStopPriceSol;

    if (markPrice <= trailTrigger) {
      const dropFromPeak =
        ((markPrice - stillOpen.highWaterMarkSol) /
          stillOpen.highWaterMarkSol) *
        100;
      const reason = `trailing stop ${trailPct}% (peak drop ${dropFromPeak.toFixed(1)}%)`;
      this.simulateSell(stillOpen.id, markPrice, reason);
      return {
        kind: 'trail_exit',
        reason,
        markPnlPct,
        stillOpen: this.positions.has(positionId),
      };
    }

    return {
      kind: 'none',
      reason: '',
      markPnlPct,
      stillOpen: true,
    };
  }

  /**
   * Run sync exit ticks at a fixed price until idle or closed
   * (staged partials that would fire on consecutive paper checks).
   */
  runPositionTicksUntilIdle(
    positionId: string,
    currentPrice: number,
    maxSteps = 4
  ): Array<NonNullable<ReturnType<PaperTrader['evaluatePositionTickSync']>>> {
    const events: Array<
      NonNullable<ReturnType<PaperTrader['evaluatePositionTickSync']>>
    > = [];
    for (let step = 0; step < maxSteps; step++) {
      const ev = this.evaluatePositionTickSync(positionId, currentPrice);
      if (!ev) break;
      if (ev.kind === 'none') break;
      events.push(ev);
      if (!ev.stillOpen) break;
    }
    return events;
  }

  /** Check all open positions — tiered sells, trailing stop, hard SL */
  checkPositions(): void {
    void this.checkPositionsAsync();
  }

  /**
   * Update dead-market streak from DexScreener activity.
   * Returns a force-sell reason when consecutive dead hours + min hold are met.
   */
  private evaluateDeadMarketExit(position: Position): string | null {
    const risk = config.risk;
    if (!risk.enableDeadVolumeExit) return null;
    if (this.mode === 'backtest') return null;

    const minHoldMs = Math.max(0, risk.deadVolumeMinHoldMinutes ?? 30) * 60_000;
    const holdMs = Date.now() - position.openedAt;
    if (holdMs < minHoldMs) return null;

    const activity = this.marketActivityCache.get(position.mint);
    if (!activity) return null;
    // Ignore stale samples (e.g. failed refresh) — don't reset or trip the streak
    if (Date.now() - activity.updatedAt > 15 * 60_000) return null;

    const volThreshold = Math.max(0, risk.deadVolumeUsdPerHour ?? 50);
    const needHours = Math.max(1, risk.deadVolumeConsecutiveHours ?? 3);
    const lowVolume = activity.volumeH1Usd < volThreshold;
    const noTrades = activity.txnsH1 <= 0;
    const isDead = lowVolume || noTrades;

    if (!isDead) {
      if (position.deadMarketBelowSince != null) {
        position.deadMarketBelowSince = undefined;
      }
      return null;
    }

    if (position.deadMarketBelowSince == null) {
      position.deadMarketBelowSince = Date.now();
      return null;
    }

    const deadForMs = Date.now() - position.deadMarketBelowSince;
    const needMs = needHours * 60 * 60_000;
    if (deadForMs < needMs) return null;

    const hoursHeld = (deadForMs / 3_600_000).toFixed(1);
    if (lowVolume && noTrades) {
      return (
        `Dead volume: <$${volThreshold}/hr & no trades for ${needHours}h` +
        ` (${hoursHeld}h)`
      );
    }
    if (lowVolume) {
      return `Dead volume: <$${volThreshold}/hr for ${needHours}h (${hoursHeld}h)`;
    }
    return `Dead market: no trades for ${needHours}h (${hoursHeld}h)`;
  }

  async checkPositionsAsync(): Promise<void> {
    if (!config.strategy.enableAutoSell) return;

    this.evaluateAndMaybeHaltRisk();

    for (const position of [...this.positions.values()]) {
      const currentPrice = this.priceCache.get(position.mint);
      if (currentPrice === undefined) continue;

      // Ensure legacy positions have risk / profit-strategy fields
      if (position.initialAmountTokens == null) {
        position.initialAmountTokens = position.amountTokens;
        position.initialCostSol = position.costSol;
        position.highWaterMarkSol = position.entryPriceSol;
        position.trailingStopPct =
          getStrategyRiskRules(position.strategyKind ?? 'normal').trailingStopPct ??
          config.risk.trailingStopPercent;
        position.trailingActive = position.trailingActive ?? false;
        position.tiersHit = position.tiersHit ?? [];
        position.strategyKind = position.strategyKind ?? 'normal';
        position.realizedPnlSol = position.realizedPnlSol ?? 0;
        position.tradeMode = position.tradeMode ?? 'paper';
      }
      position.initialRecovered = position.initialRecovered ?? false;
      position.partialSellDone = position.partialSellDone ?? false;
      position.bagTrimDone = position.bagTrimDone ?? false;
      position.solReturned = position.solReturned ?? 0;

      if (currentPrice > position.highWaterMarkSol) {
        position.highWaterMarkSol = currentPrice;
      }

      const label = formatTokenLabel(position.symbol, position.name, position.mint);

      // Dead / inactive market force-exit (paper + live tracked)
      const deadReason = this.evaluateDeadMarketExit(position);
      if (deadReason) {
        console.log(`[dead-vol] 🔴 ${label} — ${deadReason}`);
        this.log('sell', `${label}: ${deadReason}`);
        await this.closePositionByRules(position, currentPrice, deadReason);
        continue;
      }

      // Advanced profit strategy (paper + live)
      if (config.profitStrategy?.enabled) {
        await this.applyProfitStrategyTick(position, currentPrice, label);
        continue;
      }

      // —— Legacy path (profit strategy off) ——
      const pnlPct =
        ((currentPrice - position.entryPriceSol) / position.entryPriceSol) * 100;
      const rules = getStrategyRiskRules(position.strategyKind);
      const risk = config.risk;

      const hardSl = rules.hardStopLossPct ?? position.stopLossPct;
      if (pnlPct <= hardSl) {
        await this.closePositionByRules(
          position,
          currentPrice,
          `hard stop-loss ${hardSl}%`
        );
        continue;
      }

      if (
        position.tradeMode !== 'live' &&
        risk.tieredSellEnabled &&
        rules.tiers?.length
      ) {
        let soldTier = false;
        for (let i = 0; i < rules.tiers.length; i++) {
          if (position.tiersHit.includes(i)) continue;
          const tier = rules.tiers[i];
          if (pnlPct >= tier.profitPct) {
            position.tiersHit.push(i);
            console.log(
              `[risk] Tier ${i + 1}: sell ${tier.sellPct}% of ${position.symbol} at +${pnlPct.toFixed(0)}% (target +${tier.profitPct}%)`
            );
            this.simulateSell(
              position.id,
              currentPrice,
              `tier ${i + 1}: +${tier.profitPct}% → sell ${tier.sellPct}%`,
              { sellPctOfInitial: tier.sellPct }
            );
            soldTier = true;
            break;
          }
        }
        if (soldTier && !this.positions.has(position.id)) continue;
      } else if (
        position.tradeMode !== 'live' &&
        !risk.tieredSellEnabled &&
        pnlPct >= position.takeProfitPct
      ) {
        await this.closePositionByRules(
          position,
          currentPrice,
          `take-profit ${position.takeProfitPct.toFixed(0)}%`
        );
        continue;
      }

      const stillOpen = this.positions.get(position.id);
      if (!stillOpen) continue;

      const trailPct =
        stillOpen.trailingStopPct ||
        risk.trailingStopPercent ||
        risk.trailingStopPct ||
        20;
      const activation = risk.trailingActivationProfit ?? 30;

      if (!stillOpen.trailingActive && pnlPct >= activation) {
        stillOpen.trailingActive = true;
        stillOpen.trailingActivatedAt = Date.now();
        stillOpen.trailingStopPct = trailPct;
        stillOpen.trailingStopPriceSol =
          stillOpen.highWaterMarkSol * (1 - trailPct / 100);
        console.log(
          `[trail] 🟢 ACTIVATED ${label} at +${pnlPct.toFixed(1)}% ` +
            `(need +${activation}%) — trailing ${trailPct}% from peak ` +
            `stop=${stillOpen.trailingStopPriceSol.toExponential(3)} SOL`
        );
        this.log(
          'info',
          `Trailing stop ACTIVATED on ${label} at +${pnlPct.toFixed(1)}% — ` +
            `${trailPct}% trail from peak (stop ${stillOpen.trailingStopPriceSol.toExponential(3)})`
        );
      }

      if (!stillOpen.trailingActive) continue;

      stillOpen.trailingStopPriceSol =
        stillOpen.highWaterMarkSol * (1 - trailPct / 100);
      const trailTrigger = stillOpen.trailingStopPriceSol;

      if (currentPrice <= trailTrigger) {
        const dropFromPeak =
          ((currentPrice - stillOpen.highWaterMarkSol) /
            stillOpen.highWaterMarkSol) *
          100;
        console.log(
          `[trail] 🔴 TRIGGERED ${label} — price ${currentPrice.toExponential(3)} ` +
            `≤ stop ${trailTrigger.toExponential(3)} ` +
            `(peak drop ${dropFromPeak.toFixed(1)}%, trail ${trailPct}%)`
        );
        this.log(
          'sell',
          `Trailing stop TRIGGERED on ${label} — ${trailPct}% from peak ` +
            `(drop ${dropFromPeak.toFixed(1)}%)`
        );
        await this.closePositionByRules(
          stillOpen,
          currentPrice,
          `trailing stop ${trailPct}% (peak drop ${dropFromPeak.toFixed(1)}%)`
        );
      }
    }
  }

  /** One evaluation tick of the advanced profit strategy */
  private async applyProfitStrategyTick(
    position: Position,
    currentPrice: number,
    label: string
  ): Promise<void> {
    const view: ProfitPositionView = {
      entryPriceSol: position.entryPriceSol,
      currentPriceSol: currentPrice,
      highWaterMarkSol: position.highWaterMarkSol,
      amountTokens: position.amountTokens,
      initialAmountTokens: position.initialAmountTokens,
      initialCostSol: position.initialCostSol,
      solReturned: position.solReturned ?? 0,
      trailingActive: position.trailingActive,
      trailingStopPct: position.trailingStopPct,
      stopLossPct: position.stopLossPct,
      maxProfitPct: Math.max(
        position.takeProfitPct,
        config.trade.maxProfitPercent
      ),
      initialRecovered: position.initialRecovered,
      partialSellDone: position.partialSellDone,
      bagTrimDone: position.bagTrimDone,
      riskScore: position.antiRug?.riskScore,
    };

    const action = evaluateProfitAction(view);
    if (action.type === 'none') return;

    if (action.type === 'arm_trail') {
      position.trailingActive = true;
      position.trailingActivatedAt = Date.now();
      position.trailingStopPct = action.trailPct;
      position.trailingStopPriceSol =
        position.highWaterMarkSol * (1 - action.trailPct / 100);
      console.log(`[profit] 🟢 ${label} — ${action.reason}`);
      this.log('info', `${label}: ${action.reason}`);
      return;
    }

    if (action.type === 'hard_sl' || action.type === 'trail_exit' || action.type === 'full') {
      console.log(`[profit] 🔴 ${label} — ${action.reason}`);
      await this.closePositionByRules(position, currentPrice, action.reason);
      return;
    }

    if (action.type === 'partial') {
      // Zero-size stage markers (already recovered / bag floor)
      if (
        (action.tokensToSell != null && action.tokensToSell <= 0) ||
        (action.sellPctOfInitial <= 0 && action.tokensToSell == null)
      ) {
        if (action.stage === 'recover_initial') position.initialRecovered = true;
        if (action.stage === 'partial') position.partialSellDone = true;
        if (action.stage === 'bag_trim') position.bagTrimDone = true;
        console.log(`[profit] ✅ ${label} — ${action.reason}`);
        this.log('info', `${label}: ${action.reason}`);
        return;
      }

      console.log(`[profit] 💰 ${label} — ${action.reason}`);
      this.log('sell', `${label}: ${action.reason}`);

      if (position.tradeMode === 'live') {
        // Live: sell via Jupiter, then mirror size without touching paper balance
        try {
          const { executeSell } = await import('./trade');
          const raw = position.liveTokenAmount;
          let sellRaw = raw;
          if (raw && action.tokensToSell != null && position.amountTokens > 0) {
            const share = Math.min(
              1,
              Math.max(0, action.tokensToSell / position.amountTokens)
            );
            try {
              const total = BigInt(raw);
              sellRaw = (
                (total * BigInt(Math.max(1, Math.floor(share * 1e6)))) /
                1_000_000n
              ).toString();
            } catch {
              sellRaw = raw;
            }
          }
          const result = await executeSell(position.id, position.mint, sellRaw);
          if (!result.success) {
            this.log('error', `Live partial failed ${label}: ${result.error}`);
            return;
          }
          const tokensToSell =
            action.tokensToSell ??
            position.initialAmountTokens * (action.sellPctOfInitial / 100);
          const sellAmt = Math.min(position.amountTokens, tokensToSell);
          if (sellAmt > 0 && position.amountTokens > 0) {
            const costBasisSold =
              position.costSol * (sellAmt / position.amountTokens);
            const estSol = sellAmt * currentPrice;
            position.amountTokens -= sellAmt;
            position.costSol -= costBasisSold;
            position.solReturned = (position.solReturned ?? 0) + estSol;
            position.realizedPnlSol += estSol - costBasisSold;
            if (raw) {
              try {
                const remain = BigInt(raw) - BigInt(sellRaw || '0');
                position.liveTokenAmount =
                  remain > 0n ? remain.toString() : '0';
              } catch {
                /* ignore */
              }
            }
            if (position.amountTokens <= 1e-12) {
              this.positions.delete(position.id);
              position.status = 'closed';
              position.closedAt = Date.now();
              position.exitPriceSol = currentPrice;
              position.reason = action.reason;
              position.pnlSol = position.realizedPnlSol;
              position.pnlPct =
                position.initialCostSol > 0
                  ? (position.realizedPnlSol / position.initialCostSol) * 100
                  : 0;
              this.closedPositions.push(position);
            } else {
              position.status = 'partial';
            }
          }
        } catch (err) {
          this.log(
            'error',
            `Live partial error ${label}: ${err instanceof Error ? err.message : String(err)}`
          );
          return;
        }
      } else {
        this.simulateSell(position.id, currentPrice, action.reason, {
          tokensToSell: action.tokensToSell,
          sellPctOfInitial:
            action.tokensToSell == null ? action.sellPctOfInitial : undefined,
        });
      }

      if (action.stage === 'partial') position.partialSellDone = true;
      if (action.stage === 'recover_initial') position.initialRecovered = true;
      if (action.stage === 'bag_trim') position.bagTrimDone = true;

      // Auto-mark recover if we've returned ≥ initial cost
      if (
        !position.initialRecovered &&
        (position.solReturned ?? 0) >= position.initialCostSol * 0.98
      ) {
        position.initialRecovered = true;
      }
    }
  }

  private async closePositionByRules(
    position: Position,
    currentPriceSol: number,
    reason: string
  ): Promise<void> {
    if (position.tradeMode === 'live') {
      try {
        const { executeSell } = await import('./trade');
        const result = await executeSell(
          position.id,
          position.mint,
          position.liveTokenAmount ??
            String(Math.floor(position.amountTokens * 1e6))
        );
        if (result.success) {
          // Remove tracked live position (executeSell paper path won't own it)
          this.positions.delete(position.id);
          position.status = 'closed';
          position.closedAt = Date.now();
          position.exitPriceSol = currentPriceSol;
          position.exitMarketCapUsd =
            position.entryMarketCapUsd != null && position.entryPriceSol > 0
              ? marketCapAtPrice(
                  position.entryMarketCapUsd,
                  position.entryPriceSol,
                  currentPriceSol
                )
              : undefined;
          position.reason = reason;
          const pnlPct =
            ((currentPriceSol - position.entryPriceSol) /
              position.entryPriceSol) *
            100;
          position.pnlPct = pnlPct;
          this.closedPositions.push(position);
          this.log(
            'sell',
            `Live trailing/exit ${formatTokenLabel(position.symbol, position.name, position.mint)} [${reason}]`,
            { mint: position.mint, symbol: position.symbol, pnlSol: position.pnlSol }
          );
          if (pnlPct > 0) {
            registerProfitSell({
              mint: position.mint,
              symbol: position.symbol,
              name: position.name,
              positionId: position.id,
              soldAt: position.closedAt,
              sellPriceSol: currentPriceSol,
              pnlPct,
              pnlSol: position.pnlSol ?? 0,
              reason,
              sourceWallets: position.sourceWallets,
              sourceNames: position.sourceNames,
            });
          }
        } else {
          console.error(`[trail] Live sell failed: ${result.error}`);
        }
      } catch (err) {
        console.error('[trail] Live sell error:', err);
      }
      return;
    }

    this.simulateSell(position.id, currentPriceSol, reason);
  }

  /**
   * Manually close an open position (full size).
   * Paper: simulated sell. Live: on-chain sell then drop tracking.
   */
  async forceSellPosition(
    positionId: string,
    reason = 'manual force sell'
  ): Promise<{ ok: boolean; error?: string; position?: Position }> {
    const position = this.positions.get(positionId);
    if (!position || position.status === 'closed') {
      return { ok: false, error: 'Position not found or already closed' };
    }

    let price = this.priceCache.get(position.mint);
    if (price == null || !(price > 0)) {
      try {
        const { refreshPositionPrices } = await import('./trade');
        await refreshPositionPrices([position.mint]);
        price = this.priceCache.get(position.mint);
      } catch {
        // fall through
      }
    }
    if (price == null || !(price > 0)) {
      return { ok: false, error: 'No price available to sell' };
    }

    await this.closePositionByRules(position, price, reason);
    const closed =
      this.closedPositions.find((p) => p.id === positionId) ??
      (!this.positions.has(positionId) ? position : undefined);
    if (this.positions.has(positionId)) {
      return {
        ok: false,
        error: 'Sell did not close the position (check live wallet / logs)',
      };
    }
    return { ok: true, position: closed };
  }

  /** Start periodic TP/SL checks (optionally refreshes live prices) */
  startAutoCheck(): void {
    if (this.checkTimer) return;

    const interval = config.paper.positionCheckIntervalMs;
    this.checkTimer = setInterval(() => {
      void (async () => {
        if (config.paper.useLiveData) {
          try {
            const { refreshPaperPricesFromLive } = await import('./backtest');
            await refreshPaperPricesFromLive(this);
            return; // refresh already calls checkPositions
          } catch {
            // fall through to local check
          }
        }
        try {
          const { refreshOpenMarketActivity } = await import('./marketData');
          await refreshOpenMarketActivity(this);
        } catch {
          // best-effort
        }
        this.checkPositions();
      })();
    }, interval);

    console.log(
      `[paper] Auto position check started (every ${interval}ms)` +
        (config.paper.useLiveData ? ' [live data ON]' : '')
    );
  }

  /** Sum of PnL from positions closed today (UTC) */
  getDailyPnlSol(): number {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    return this.closedPositions
      .filter((p) => p.closedAt && p.closedAt >= startOfDay.getTime())
      .reduce((sum, p) => sum + (p.pnlSol ?? 0), 0);
  }

  /** Simple win-rate % from closed positions (for filter checks) */
  getWinRatePct(): number {
    if (this.closedPositions.length === 0) return 0;
    const wins = this.closedPositions.filter((p) => (p.pnlSol ?? 0) > 0).length;
    return (wins / this.closedPositions.length) * 100;
  }

  /** Aggregate stats for dashboard / backtest */
  getStats() {
    const closed = this.closedPositions;
    const wins = closed.filter((p) => (p.pnlSol ?? 0) > 0);
    const losses = closed.filter((p) => (p.pnlSol ?? 0) <= 0);
    const netPnlSol = closed.reduce((sum, p) => sum + (p.pnlSol ?? 0), 0);
    const avgWinPct =
      wins.length > 0
        ? wins.reduce((s, p) => s + (p.pnlPct ?? 0), 0) / wins.length
        : 0;
    const avgLossPct =
      losses.length > 0
        ? losses.reduce((s, p) => s + (p.pnlPct ?? 0), 0) / losses.length
        : 0;
    const avgWinSol =
      wins.length > 0
        ? wins.reduce((s, p) => s + (p.pnlSol ?? 0), 0) / wins.length
        : 0;
    const avgLossSol =
      losses.length > 0
        ? losses.reduce((s, p) => s + (p.pnlSol ?? 0), 0) / losses.length
        : 0;
    const bestTrade = closed.reduce<Position | null>((best, p) => {
      if (!best || (p.pnlPct ?? -Infinity) > (best.pnlPct ?? -Infinity)) {
        return p;
      }
      return best;
    }, null);
    const worstTrade = closed.reduce<Position | null>((worst, p) => {
      if (!worst || (p.pnlPct ?? Infinity) < (worst.pnlPct ?? Infinity)) {
        return p;
      }
      return worst;
    }, null);

    const start = this.startingBalanceSol;
    const grossWinSol = wins.reduce((s, p) => s + (p.pnlSol ?? 0), 0);
    const grossLossSol = Math.abs(
      losses.reduce((s, p) => s + (p.pnlSol ?? 0), 0)
    );
    const profitFactor =
      grossLossSol > 0
        ? grossWinSol / grossLossSol
        : grossWinSol > 0
          ? 999
          : 0;

    let peakEquity = start;
    let equity = start;
    let maxDrawdownPct = 0;
    const sortedClosed = [...closed].sort(
      (a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0)
    );
    for (const p of sortedClosed) {
      equity += p.pnlSol ?? 0;
      if (equity > peakEquity) peakEquity = equity;
      if (peakEquity > 0) {
        const dd = ((peakEquity - equity) / peakEquity) * 100;
        if (dd > maxDrawdownPct) maxDrawdownPct = dd;
      }
    }

    const holdTimes = closed
      .filter((p) => p.closedAt && p.openedAt)
      .map((p) => (p.closedAt! - p.openedAt) / 1000);
    const avgHoldSec =
      holdTimes.length > 0
        ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length
        : 0;

    return {
      totalTrades: closed.length + this.positions.size,
      closedTrades: closed.length,
      openTrades: this.positions.size,
      wins: wins.length,
      losses: losses.length,
      winRatePct: this.getWinRatePct(),
      profitFactor: Number(profitFactor.toFixed(2)),
      maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
      avgHoldSec: Number(avgHoldSec.toFixed(0)),
      netPnlSol,
      dailyPnlSol: this.getDailyPnlSol(),
      avgWinPct,
      avgLossPct,
      avgWinSol,
      avgLossSol,
      bestTrade: bestTrade
        ? {
            symbol: bestTrade.symbol,
            name: bestTrade.name,
            mint: bestTrade.mint,
            pnlPct: bestTrade.pnlPct ?? 0,
            pnlSol: bestTrade.pnlSol ?? 0,
          }
        : null,
      worstTrade: worstTrade
        ? {
            symbol: worstTrade.symbol,
            name: worstTrade.name,
            mint: worstTrade.mint,
            pnlPct: worstTrade.pnlPct ?? 0,
            pnlSol: worstTrade.pnlSol ?? 0,
          }
        : null,
      openCount: this.positions.size,
      balanceSol: this.balanceSol,
      startingBalanceSol: start,
      returnPct: start > 0 ? ((this.balanceSol - start) / start) * 100 : 0,
      mode: this.mode,
    };
  }

  /**
   * Chart.js-ready series for the dashboard.
   * - cumulativePnl: equity curve over closed trades
   * - perWallet: PnL attributed to triggering smart wallets
   * - winLoss: win vs loss counts (and SOL totals)
   */
  getChartData() {
    const closed = [...this.closedPositions].sort(
      (a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0)
    );

    let cumulative = 0;
    const cumulativePnl = {
      labels: [] as string[],
      values: [] as number[],
      points: [] as {
        time: number;
        label: string;
        pnlSol: number;
        cumulative: number;
        symbol: string;
        name: string;
      }[],
    };

    for (const p of closed) {
      const pnl = p.pnlSol ?? 0;
      cumulative += pnl;
      const time = p.closedAt ?? p.openedAt;
      const label = new Date(time).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      cumulativePnl.labels.push(label);
      cumulativePnl.values.push(Number(cumulative.toFixed(6)));
      cumulativePnl.points.push({
        time,
        label,
        pnlSol: pnl,
        cumulative,
        symbol: p.symbol,
        name: p.name || p.symbol,
      });
    }

    // Per-wallet attribution (split PnL evenly across signal wallets)
    const walletMap = new Map<
      string,
      { name: string; pnlSol: number; trades: number; wins: number; losses: number }
    >();

    for (const p of closed) {
      const names =
        p.sourceNames && p.sourceNames.length > 0
          ? p.sourceNames
          : ['Unknown'];
      const share = (p.pnlSol ?? 0) / names.length;
      const won = (p.pnlSol ?? 0) > 0;

      for (const name of names) {
        const cur = walletMap.get(name) ?? {
          name,
          pnlSol: 0,
          trades: 0,
          wins: 0,
          losses: 0,
        };
        cur.pnlSol += share;
        cur.trades += 1;
        if (won) cur.wins += 1;
        else cur.losses += 1;
        walletMap.set(name, cur);
      }
    }

    const perWalletSorted = Array.from(walletMap.values()).sort(
      (a, b) => b.pnlSol - a.pnlSol
    );

    const perWallet = {
      labels: perWalletSorted.map((w) => w.name),
      pnlSol: perWalletSorted.map((w) => Number(w.pnlSol.toFixed(6))),
      trades: perWalletSorted.map((w) => w.trades),
      wins: perWalletSorted.map((w) => w.wins),
      losses: perWalletSorted.map((w) => w.losses),
    };

    const wins = closed.filter((p) => (p.pnlSol ?? 0) > 0);
    const losses = closed.filter((p) => (p.pnlSol ?? 0) <= 0);

    const winLoss = {
      labels: ['Wins', 'Losses'],
      counts: [wins.length, losses.length],
      pnlSol: [
        Number(wins.reduce((s, p) => s + (p.pnlSol ?? 0), 0).toFixed(6)),
        Number(losses.reduce((s, p) => s + (p.pnlSol ?? 0), 0).toFixed(6)),
      ],
    };

    return {
      cumulativePnl,
      perWallet,
      winLoss,
      tradeCount: closed.length,
    };
  }

  stopAutoCheck(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /** Simulate price movement for demo/testing (optional) */
  simulatePriceTick(mint: string, changePct: number): void {
    const current = this.priceCache.get(mint);
    if (current === undefined) return;
    this.priceCache.set(mint, current * (1 + changePct / 100));
  }
}

/** Singleton instance used across the bot */
export const paperTrader = new PaperTrader();
