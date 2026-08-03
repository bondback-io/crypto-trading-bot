/**
 * Paper trading engine with realistic slippage/fee simulation,
 * position tracking, and automatic take-profit / stop-loss checks.
 */

import { config, randomTakeProfitPct, isScalperSuiteProfile, getScalperSuiteVariantLabel } from './config';
import { formatTokenLabel, mintPrefix } from './tokenMeta';
import { registerExitForReentry, getSellHistory } from './reBuy';
import {
  getStrategyRiskRules,
  computeEquitySol,
  evaluateRiskLimits,
  resetPeakEquity,
  clampToMaxAllowedTradeSol,
} from './risk';
import {
  evaluateProfitAction,
  adjustedStopLossPct,
  SWING_HARD_SL_GRACE_MS,
  SWING_HARD_SL_GRACE_PROFILES,
  SWING_HARD_SL_GRACE_RUG_PCT,
  type ProfitPositionView,
} from './profitStrategy';
import {
  marketCapAtPrice,
  getCachedSolUsdPrice,
  reconcileMarkPriceSol,
  resolveExitMarketCaps,
  isSaneMarkMarketCapUsd,
  alignClosedExitMarketCapsToFill,
} from './marketData';
import { recordScannerOutcome } from './scannerOutcomes';
import { loadPaperBalance, savePaperBalance } from './paperStateStore';
import {
  effectiveDeadVolumeConsecutiveHours,
  effectiveDeadVolumeMinHoldMinutes,
  effectiveDeadVolumeUsdPerHour,
  effectiveLowConvictionTrailThreshold,
  effectiveLowConvictionTrailTightenPct,
} from './filterEffective';
import {
  classifyExitKey,
  markPnlPct,
  type ExitMixKey,
  type SoakMetrics,
} from './soakMetrics';
import { isStrategyEnabledForProfile } from './strategies';
import {
  evaluateScalpProtectiveTrail,
  evaluateShortTermExit,
  seedShortTermPosition,
  shortTermExitLogTag,
  type ShortTermStrategyId,
} from './shortTermStrategies';
import { shouldInvalidatePostRunDipPosition } from './postRunDip';
import { recordPriceTick } from './technicalLevels';
import {
  applyTradeProfileExitRules,
  getGlobalMicroBotTakeProfitPct,
} from './tradeProfiles';

/**
 * Effective TP% for a position — Global Micro-Bot Take Profit master override
 * wins for any trade-profile-stamped (micro-bot) position.
 */
function effectivePositionTakeProfitPct(position: {
  takeProfitPct: number;
  scalpTpPct?: number;
  tradeProfileId?: string;
}): number {
  const g = getGlobalMicroBotTakeProfitPct();
  if (g != null && position.tradeProfileId) return g;
  return position.scalpTpPct ?? position.takeProfitPct;
}

function isGlobalMicroBotTpOverrideActive(position: {
  tradeProfileId?: string;
}): boolean {
  return (
    getGlobalMicroBotTakeProfitPct() != null && Boolean(position.tradeProfileId)
  );
}

/** Hard ceiling on realized exit multiple vs entry (last-resort balance guard). */
const MAX_EXIT_PRICE_MULTIPLE = 50;

/**
 * Max adverse gap beyond a hard stop-loss for paper / live-sim fills.
 * Discrete Dex marks often jump past SL (−48% → −90%); fill near the stop
 * instead of giving the full gap-through (realistic stop-limit + small slip).
 */
const HARD_SL_MAX_GAP_SLIPPAGE = 0.04; // 4% beyond SL threshold

/** Live Simulation polls marks more often so SL/TP see gaps sooner. */
const LIVE_SIM_CHECK_INTERVAL_MS = 2_000;

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
  /** Trough price since entry (MAE tracking for learning) */
  lowWaterMarkSol?: number;
  /** Max unrealized % seen (MFE) — updated on mark */
  maxRunupPct?: number;
  /** Worst unrealized % seen (MAE, ≤0) */
  maxDrawdownPct?: number;
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
  /** Realized PnL from partial sells so far (cost-basis of sells) */
  realizedPnlSol: number;
  openedAt: number;
  closedAt?: number;
  exitPriceSol?: number;
  pnlSol?: number;
  pnlPct?: number;
  status: PositionStatus;
  reason?: string;
  /**
   * When this closed row is a partial-take slice, links back to the open
   * (or final) position id for UI grouping. Display/history only.
   */
  parentPositionId?: string;
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
  /** Market cap USD at entry fill (curve/Dex, scaled to fill price when possible) */
  entryMarketCapUsd?: number;
  /** Market cap USD when the copied smart wallet bought (signal-time) */
  sourceEntryMcUsd?: number;
  /** Market cap USD at exit (fill-scaled from Buy MC × exit/entry — tracks PnL) */
  exitMarketCapUsd?: number;
  /** Fill-scaled exit MC (entry × exitFill/entryFill) — same basis as exitMarketCapUsd */
  impliedExitMarketCapUsd?: number;
  /** Live Dex MC at exit for tooltip when it disagrees with fill-scaled Exit MC */
  liveExitMarketCapUsd?: number;
  /** Turbo Mode was ON at open (Jito-prefer / elevated prio) */
  profileTurboMode?: boolean;
  /** Jupiter-style Top 10 Holders % resolved at entry (for audit / UI) */
  top10HoldPct?: number | null;
  /**
   * Token age hours at entry (post-grad / pair age). Used for learning episodes.
   */
  tokenAgeHoursAtEntry?: number | null;
  /**
   * Wall-clock ms when rolling 1h volume / tx activity first went "dead".
   * Cleared when activity recovers above thresholds.
   */
  deadMarketBelowSince?: number;
  /** Conviction score at entry (for exit discipline) */
  convictionScore?: number;
  /** Short-term / Quick Scalper timed exit mode */
  scalpMode?: boolean;
  shortTermStrategyId?: import('./shortTermStrategies').ShortTermStrategyId;
  scalpDeadlineMs?: number;
  /** Absolute max hold when soft timer defers a green scalp (1.4× primary) */
  scalpHardDeadlineMs?: number;
  scalpTpPct?: number;
  scalpSlPct?: number;
  scalpMomentumFailDropPct?: number;
  /**
   * Multi-profile stamp — which named trade profile owns this position.
   * Exit rules were frozen from that profile at open. Optional for legacy rows.
   */
  tradeProfileId?: string;
  tradeProfileName?: string;
  tradeProfileIcon?: string;
  tradeProfileColor?: string;
  /** Winning auto-score (0–100) when assigned */
  tradeProfileScore?: number;
  tradeProfileReason?: string;
  /** Profile-frozen aggressive dead-market min hold (minutes) */
  deadVolumeMinHoldMinutes?: number;
  /**
   * Profile-frozen trail arm threshold (% profit). When set, overrides global
   * risk.trailingActivationProfit / profitStrategy.trailingStopAfter for this position.
   */
  trailingActivationProfit?: number;
  /** Frozen adaptive exit policy from trade profile */
  profileExitPolicy?: import('./profileTradeIntelligence').ProfileExitPolicy;
  /** Trail already tightened once by adaptive policy */
  profileTrailTightened?: boolean;
  /** Quality tier derived from conviction at entry (drives dynamic TP) */
  qualityTier?: 'low' | 'medium' | 'high';
  /** Self-learn param version stamped at open */
  selfLearnVersion?: number;
  /** Learning Mode ON when this position opened */
  learningMode?: boolean;
  learningStrictness?: 'stricter' | 'middle' | 'looser';
  learningFairnessApplied?: boolean;
  /** Whether HA trend exit was enabled on the frozen exit policy at open */
  haExitEnabledAtOpen?: boolean;
  /** TA hints for swing hold/cut (optional; refreshed on mark when known) */
  nearKeyFib?: boolean;
  nearSupport?: boolean;
  chartPatternIds?: string[];
  /** How the entry was discovered */
  entrySource?: 'wallet' | 'scanner' | 'migration' | 'hybrid' | 'zion';
  /** Scanner playbook stamp */
  scannerPlaybook?: string;
  scannerConfluence?: number;
  candleSource?: 'real' | 'synthetic';
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

export type QualityTier = 'low' | 'medium' | 'high';

export function deriveQualityTier(conviction?: number | null): QualityTier {
  const c = Number(conviction) || 0;
  if (c < 35) return 'low';
  if (c > 60) return 'high';
  return 'medium';
}

export type FailureCategory =
  | 'missed_tp'
  | 'overhold'
  | 'early_sl'
  | 'fade_after_pump'
  | 'weak_entry'
  | 'normal_sl'
  | 'profitable';

export function computeFailureCategory(pos: Position): FailureCategory {
  const pnl = pos.pnlPct ?? 0;
  if (pnl > 0) return 'profitable';

  const mfe = pos.maxRunupPct ?? 0;
  const holdMs = (pos.closedAt ?? Date.now()) - pos.openedAt;
  const tp = pos.takeProfitPct ?? 15;

  if (holdMs < 30_000) return 'early_sl';
  if (mfe >= tp && pnl <= 0) return 'missed_tp';
  if (mfe >= 30 && pnl < 0) return 'fade_after_pump';
  if (mfe >= 20 && pnl < 5) return 'overhold';
  if ((pos.convictionScore ?? 100) < 30) return 'weak_entry';
  return 'normal_sl';
}

let logCounter = 0;

function nextId(prefix: string): string {
  logCounter += 1;
  return `${prefix}-${Date.now()}-${logCounter}`;
}

/** Record playbook outcome when a scanner/hybrid position fully closes. */
function maybeRecordScannerOutcome(
  position: Position,
  pnlPct: number
): void {
  const src = position.entrySource;
  if (src !== 'scanner' && src !== 'hybrid') return;
  const playbook = position.scannerPlaybook;
  if (!playbook) return;
  const holdSec =
    position.closedAt != null && position.openedAt > 0
      ? Math.max(0, Math.round((position.closedAt - position.openedAt) / 1000))
      : 0;
  try {
    recordScannerOutcome({
      playbook,
      pnlPct,
      win: pnlPct > 0,
      holdSec,
    });
  } catch {
    /* non-fatal */
  }
}

/** Join closed PnL onto the matching Smart Bot lane fight record. */
function maybeRecordLaneOutcome(
  position: Position,
  pnlSol: number,
  pnlPct?: number
): void {
  try {
    const { recordLaneFightClose } =
      require('./laneOutcomes') as typeof import('./laneOutcomes');
    const { classifyExitKey } =
      require('./soakMetrics') as typeof import('./soakMetrics');
    const entry = position.entryPriceSol || 0;
    const hwm = position.highWaterMarkSol || entry;
    const maxRunupPct =
      position.maxRunupPct != null
        ? position.maxRunupPct
        : entry > 0
          ? ((hwm - entry) / entry) * 100
          : 0;
    const holdSec =
      position.closedAt && position.openedAt
        ? (position.closedAt - position.openedAt) / 1000
        : 0;
    recordLaneFightClose({
      mint: position.mint,
      profileId: position.tradeProfileId,
      pnlSol,
      pnlPct,
      holdSec,
      exitKey: classifyExitKey(position.reason || '').key,
      maxRunupPct: Math.max(0, maxRunupPct),
    });
  } catch {
    /* non-fatal */
  }
}

/** Append learning episode + kick self-learn tick (final closes only). */
function maybeRecordLearningEpisode(
  position: Position,
  pnlSol: number,
  pnlPct: number
): void {
  if (/^partial:/i.test(String(position.reason || ''))) return;
  const profileId = position.tradeProfileId;
  if (!profileId || profileId === 'default') return;
  try {
    const {
      appendProfileLearningEpisode,
      deriveEpisodeMetrics,
    } = require('./profileLearningEpisodes') as typeof import('./profileLearningEpisodes');
    const entry = position.entryPriceSol || 0;
    const exit = position.exitPriceSol || entry;
    const hwm = position.highWaterMarkSol || entry;
    const metrics = deriveEpisodeMetrics({
      entryPriceSol: entry,
      exitPriceSol: exit,
      highWaterMarkSol: hwm,
      lowWaterMarkSol: position.lowWaterMarkSol ?? entry,
      pnlPct,
    });
    if (position.maxRunupPct != null) {
      metrics.maxRunupPct = Math.max(metrics.maxRunupPct, position.maxRunupPct);
      metrics.peakUnrealizedPct = Math.max(
        metrics.peakUnrealizedPct,
        position.maxRunupPct
      );
    }
    if (position.maxDrawdownPct != null) {
      metrics.maxDrawdownPct = Math.min(
        metrics.maxDrawdownPct,
        position.maxDrawdownPct
      );
    }
    const holdSec =
      position.closedAt && position.openedAt
        ? (position.closedAt - position.openedAt) / 1000
        : 0;
    let paramVersion = position.selfLearnVersion ?? 0;
    let microVersion = 0;
    try {
      const { getProfileSelfLearning } =
        require('./tradeProfiles') as typeof import('./tradeProfiles');
      const sl = getProfileSelfLearning(profileId);
      microVersion = sl.microVersion || 0;
      paramVersion =
        position.selfLearnVersion ?? sl.version ?? paramVersion;
    } catch {
      /* ignore */
    }
    const pol = (position.profileExitPolicy || {}) as {
      profitLockArmPct?: number;
      profitGivebackPts?: number;
    };
    const opened = position.openedAt || Date.now();
    appendProfileLearningEpisode({
      profileId,
      mint: position.mint,
      symbol: position.symbol,
      openedAt: position.openedAt,
      closedAt: position.closedAt || Date.now(),
      holdSec,
      pnlPct,
      pnlSol,
      exitReason: position.reason || 'unknown',
      ...metrics,
      convictionScore: position.convictionScore,
      walletCount: position.sourceWallets?.length,
      entryMarketCapUsd: position.entryMarketCapUsd,
      tradeProfileScore: position.tradeProfileScore,
      tradeProfileReason: position.tradeProfileReason,
      paramVersion,
      entrySource: position.entrySource,
      scannerPlaybook: position.scannerPlaybook,
      qualityTier: position.qualityTier,
      failureCategory: computeFailureCategory(position),
      trailStopPctAtOpen:
        position.trailingStopPct != null && Number.isFinite(position.trailingStopPct)
          ? Number(position.trailingStopPct)
          : undefined,
      trailingActivationProfitAtOpen:
        position.trailingActivationProfit != null &&
        Number.isFinite(position.trailingActivationProfit)
          ? Number(position.trailingActivationProfit)
          : undefined,
      profitLockArmAtOpen:
        pol.profitLockArmPct != null && Number.isFinite(Number(pol.profitLockArmPct))
          ? Number(pol.profitLockArmPct)
          : undefined,
      givebackPtsAtOpen:
        pol.profitGivebackPts != null &&
        Number.isFinite(Number(pol.profitGivebackPts))
          ? Number(pol.profitGivebackPts)
          : undefined,
      holdMinAtEntry:
        position.deadVolumeMinHoldMinutes != null &&
        Number.isFinite(position.deadVolumeMinHoldMinutes)
          ? Number(position.deadVolumeMinHoldMinutes)
          : undefined,
      hourUtc: new Date(opened).getUTCHours(),
      microVersion,
      laneScore:
        position.tradeProfileScore != null &&
        Number.isFinite(position.tradeProfileScore)
          ? Number(position.tradeProfileScore)
          : undefined,
      top10HoldPct:
        position.top10HoldPct != null && Number.isFinite(Number(position.top10HoldPct))
          ? Number(position.top10HoldPct)
          : null,
      tokenAgeHoursAtEntry:
        position.tokenAgeHoursAtEntry != null &&
        Number.isFinite(Number(position.tokenAgeHoursAtEntry))
          ? Number(position.tokenAgeHoursAtEntry)
          : undefined,
      haExitEnabledAtOpen:
        position.haExitEnabledAtOpen === true ||
        (position.profileExitPolicy as { heikinAshiExitEnabled?: boolean } | undefined)
          ?.heikinAshiExitEnabled === true,
      learningMode: position.learningMode === true ? true : undefined,
      learningStrictness: position.learningStrictness,
      learningFairnessApplied:
        position.learningFairnessApplied === true ? true : undefined,
    });
    const { onProfileTradeClosedForSelfLearn } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    onProfileTradeClosedForSelfLearn(profileId);
  } catch {
    /* non-fatal */
  }
}

/** Closed-history row for a partial take (not the final full exit). */
export function isPartialCloseSlice(p: {
  id?: string;
  reason?: string;
  parentPositionId?: string;
}): boolean {
  const reason = String(p.reason || '');
  if (/^partial:/i.test(reason)) return true;
  if (p.parentPositionId && String(p.id || '').startsWith('part-')) return true;
  return false;
}

/**
 * Group key for a trade lifecycle (entry → partials → final).
 * Prefer parentPositionId / original id; fall back to mint+openedAt.
 */
export function tradeGroupKey(p: {
  id?: string;
  mint?: string;
  openedAt?: number;
  parentPositionId?: string;
  reason?: string;
}): string {
  if (p.parentPositionId) return `pid:${p.parentPositionId}`;
  if (isPartialCloseSlice(p) && p.mint && p.openedAt) {
    return `mo:${p.mint}|${p.openedAt}`;
  }
  if (p.id && !String(p.id).startsWith('part-')) return `pid:${p.id}`;
  if (p.mint && p.openedAt) return `mo:${p.mint}|${p.openedAt}`;
  return `id:${p.id || 'unknown'}`;
}

/**
 * Realized PnL without double-counting partial slices once a final exit exists.
 * While a trade is still open, partial slice PnL is counted.
 */
export function realizedPnlFromClosedHistory(
  closed: Array<{
    id?: string;
    mint?: string;
    openedAt?: number;
    closedAt?: number;
    parentPositionId?: string;
    reason?: string;
    pnlSol?: number;
  }>
): number {
  const groups = new Map<string, typeof closed>();
  for (const p of closed) {
    const key = tradeGroupKey(p);
    const list = groups.get(key) || [];
    list.push(p);
    groups.set(key, list);
  }
  let total = 0;
  for (const list of groups.values()) {
    const finals = list.filter((p) => !isPartialCloseSlice(p));
    if (finals.length > 0) {
      finals.sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
      total += finals[finals.length - 1].pnlSol ?? 0;
    } else {
      for (const p of list) total += p.pnlSol ?? 0;
    }
  }
  return total;
}

/**
 * One representative closed trade per group (final if present, else last partial).
 * Used for win-rate / best-worst without double-counting partials.
 */
export function representativeClosedTrades<T extends {
  id?: string;
  mint?: string;
  openedAt?: number;
  closedAt?: number;
  parentPositionId?: string;
  reason?: string;
  pnlSol?: number;
}>(closed: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const p of closed) {
    const key = tradeGroupKey(p);
    const list = groups.get(key) || [];
    list.push(p);
    groups.set(key, list);
  }
  const out: T[] = [];
  for (const list of groups.values()) {
    const finals = list.filter((p) => !isPartialCloseSlice(p));
    if (finals.length > 0) {
      finals.sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
      out.push(finals[finals.length - 1]);
    } else {
      list.sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
      out.push(list[list.length - 1]);
    }
  }
  return out;
}

/**
 * Incremental realized PnL events that avoid double-counting partials
 * once a final exit (total PnL) is recorded.
 */
export function chronologicalRealizedDeltas<T extends {
  id?: string;
  mint?: string;
  openedAt?: number;
  closedAt?: number;
  parentPositionId?: string;
  reason?: string;
  pnlSol?: number;
}>(closed: T[]): Array<{ time: number; pnlSol: number; position: T }> {
  const sorted = [...closed].sort(
    (a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0)
  );
  const partialSumByKey = new Map<string, number>();
  const out: Array<{ time: number; pnlSol: number; position: T }> = [];
  for (const p of sorted) {
    const key = tradeGroupKey(p);
    const pnl = p.pnlSol ?? 0;
    const time = p.closedAt ?? p.openedAt ?? 0;
    if (isPartialCloseSlice(p)) {
      partialSumByKey.set(key, (partialSumByKey.get(key) ?? 0) + pnl);
      out.push({ time, pnlSol: pnl, position: p });
    } else {
      const prior = partialSumByKey.get(key) ?? 0;
      out.push({ time, pnlSol: pnl - prior, position: p });
      partialSumByKey.set(key, pnl);
    }
  }
  return out;
}

function applySlippage(price: number, bps: number, direction: 'buy' | 'sell'): number {
  const factor = bps / 10_000;
  return direction === 'buy' ? price * (1 + factor) : price * (1 - factor);
}

function applyFee(amountSol: number, bps: number): number {
  return amountSol * (bps / 10_000);
}

/**
 * Stop-limit style floor for paper / live-sim hard SL fills.
 * Caps adverse gap beyond the SL threshold (plus a small slippage allowance).
 */
function hardStopMinFillPriceSol(
  entryPriceSol: number,
  hardSlPct: number
): number | undefined {
  if (!(entryPriceSol > 0) || !Number.isFinite(hardSlPct) || hardSlPct >= 0) {
    return undefined;
  }
  const slPrice = entryPriceSol * (1 + hardSlPct / 100);
  if (!(slPrice > 0)) return undefined;
  return slPrice * (1 - HARD_SL_MAX_GAP_SLIPPAGE);
}

export class PaperTrader {
  private balanceSol: number;
  private startingBalanceSol: number;
  private mode: 'paper' | 'backtest';
  private positions: Map<string, Position> = new Map();
  private closedPositions: Position[] = [];
  private logs: TradeLog[] = [];
  private priceCache: Map<string, number> = new Map();
  /** Latest observed market-cap USD per mint (from Dex/curve refresh) */
  private marketCapCache: Map<string, number> = new Map();
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
        if (p.entryPriceSol > 0) {
          this.priceCache.set(p.mint, p.entryPriceSol);
        }
        if (
          p.entryMarketCapUsd != null &&
          Number.isFinite(p.entryMarketCapUsd) &&
          p.entryMarketCapUsd > 0
        ) {
          this.marketCapCache.set(p.mint, p.entryMarketCapUsd);
        }
      }
    }
    this.closedPositions = (saved.closedPositions || []).map((p) => ({ ...p }));
    // Historical Closed Trades: Exit MC used to prefer Dex while PnL used fill.
    // Align Exit MC to fill-scaled only — never rewrite pnlSol/pnlPct (overview stats).
    const aligned = alignClosedExitMarketCapsToFill(this.closedPositions);
    this.closedPositions = aligned.closed;
    if (aligned.fixed > 0) {
      console.log(
        `[paper] Aligned Exit MC to fill on ${aligned.fixed} closed trade(s) ` +
          `(PnL / Realized unchanged — MC column only)`
      );
      this.persistState();
    }
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

    const candidateMc =
      meta?.marketCapUsd != null &&
      Number.isFinite(meta.marketCapUsd) &&
      meta.marketCapUsd > 0
        ? meta.marketCapUsd
        : undefined;

    let mark = priceSol;
    let acceptedMc: number | undefined;
    let sawOpen = false;
    const prevMark = this.priceCache.get(mint);
    for (const pos of this.positions.values()) {
      if (pos.mint !== mint || pos.status === 'closed') continue;
      if (!(pos.entryPriceSol > 0)) break;
      sawOpen = true;
      const markMcForReconcile =
        candidateMc != null &&
        isSaneMarkMarketCapUsd(pos.entryMarketCapUsd, candidateMc)
          ? candidateMc
          : null;
      const reconciled = reconcileMarkPriceSol({
        entryPriceSol: pos.entryPriceSol,
        markPriceSol: priceSol,
        entryMarketCapUsd: pos.entryMarketCapUsd,
        markMarketCapUsd: markMcForReconcile,
        positionAgeMs: Math.max(0, Date.now() - (pos.openedAt || Date.now())),
        prevMarkPriceSol:
          prevMark != null && Number.isFinite(prevMark) && prevMark > 0
            ? prevMark
            : null,
      });
      if (reconciled.rejected) {
        console.warn(
          `[paper] Rejected absurd mark for ${mint.slice(0, 8)}… ` +
            `(${reconciled.reason}) — keeping prior price`
        );
        // Do not poison MC cache with a rejected feed
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
      if (
        candidateMc != null &&
        isSaneMarkMarketCapUsd(pos.entryMarketCapUsd, candidateMc)
      ) {
        acceptedMc = candidateMc;
      } else if (candidateMc != null) {
        console.warn(
          `[paper] Rejected absurd mark MC $${Math.round(candidateMc).toLocaleString()} ` +
            `for ${mint.slice(0, 8)}… (vs entry MC $${Math.round(pos.entryMarketCapUsd ?? 0).toLocaleString()})`
        );
      }
      break;
    }
    this.priceCache.set(mint, mark);
    recordPriceTick(mint, mark);
    if (acceptedMc != null) {
      this.marketCapCache.set(mint, acceptedMc);
    } else if (!sawOpen && candidateMc != null) {
      // No open position to sanity-check against — still cache for discovery UI
      this.marketCapCache.set(mint, candidateMc);
    }
  }

  /** Cache latest live market-cap USD for a mint (Live MC column / exit MC). */
  setMarkMarketCapUsd(mint: string, marketCapUsd: number | null | undefined): void {
    if (
      marketCapUsd == null ||
      !Number.isFinite(marketCapUsd) ||
      !(marketCapUsd > 0)
    ) {
      return;
    }
    for (const pos of this.positions.values()) {
      if (pos.mint !== mint || pos.status === 'closed') continue;
      if (!isSaneMarkMarketCapUsd(pos.entryMarketCapUsd, marketCapUsd)) {
        console.warn(
          `[paper] Rejected absurd mark MC $${Math.round(marketCapUsd).toLocaleString()} ` +
            `for ${mint.slice(0, 8)}… (vs entry MC $${Math.round(pos.entryMarketCapUsd ?? 0).toLocaleString()})`
        );
        return;
      }
      break;
    }
    this.marketCapCache.set(mint, marketCapUsd);
  }

  getMarkMarketCapUsd(mint: string): number | undefined {
    return this.marketCapCache.get(mint);
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

  /**
   * Portfolio breakdown for Overview:
   * Available (cash) + Positions Value (marks) = Total Equity.
   * Unrealized = marks − cost; Realized = sum of closed trade PnL.
   *
   * Paper / Live Sim: available = cash ledger (buy deducts, sell credits).
   * Live: pass `availableOverrideSol` = on-chain wallet SOL so Available
   * reflects funds not locked in tracked open positions' market value.
   */
  getPortfolioSummary(availableOverrideSol?: number | null): {
    availableBalanceSol: number;
    positionsValueSol: number;
    positionsCostSol: number;
    unrealizedPnlSol: number;
    realizedPnlSol: number;
    totalEquitySol: number;
    openCount: number;
    markedCount: number;
    startingBalanceSol: number;
    returnPct: number;
  } {
    let positionsCostSol = 0;
    let positionsValueSol = 0;
    let markedCount = 0;
    for (const p of this.positions.values()) {
      const cost = Number(p.costSol) || 0;
      positionsCostSol += cost;
      const px = this.priceCache.get(p.mint);
      if (
        px != null &&
        Number.isFinite(px) &&
        px > 0 &&
        Number(p.amountTokens) > 0
      ) {
        positionsValueSol += Number(p.amountTokens) * px;
        markedCount += 1;
      } else {
        // Unmarked: hold at cost so unrealized stays 0 until a mark arrives
        positionsValueSol += cost;
      }
    }
    const availableBalanceSol =
      availableOverrideSol != null && Number.isFinite(Number(availableOverrideSol))
        ? Math.max(0, Number(availableOverrideSol))
        : this.balanceSol;
    const unrealizedPnlSol = positionsValueSol - positionsCostSol;
    const totalEquitySol = availableBalanceSol + positionsValueSol;
    const realizedPnlSol = realizedPnlFromClosedHistory(this.closedPositions);
    const start = this.startingBalanceSol;
    return {
      availableBalanceSol,
      positionsValueSol,
      positionsCostSol,
      unrealizedPnlSol,
      realizedPnlSol,
      totalEquitySol,
      openCount: this.positions.size,
      markedCount,
      startingBalanceSol: start,
      returnPct:
        start > 0 ? ((totalEquitySol - start) / start) * 100 : 0,
    };
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
    initialCostUsd?: number;
    solUsd?: number;
    /** Current market cap (mark); falls back to entry MC scaled by mark/entry price */
    liveMarketCapUsd?: number | null;
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
    const initialCostUsd =
      position.initialCostSol > 0 && solUsd > 0
        ? Number((position.initialCostSol * solUsd).toFixed(2))
        : undefined;

    let liveMarketCapUsd: number | null =
      this.marketCapCache.get(position.mint) ?? null;
    if (
      liveMarketCapUsd != null &&
      !isSaneMarkMarketCapUsd(position.entryMarketCapUsd, liveMarketCapUsd)
    ) {
      liveMarketCapUsd = null;
    }
    if (
      (liveMarketCapUsd == null || !(liveMarketCapUsd > 0)) &&
      position.entryMarketCapUsd != null &&
      position.entryPriceSol > 0 &&
      current != null &&
      current > 0
    ) {
      liveMarketCapUsd =
        marketCapAtPrice(
          position.entryMarketCapUsd,
          position.entryPriceSol,
          current
        ) ?? null;
    }

    return {
      ...position,
      trailingStopPct: trailPct,
      trailingStopPriceSol: stopPrice,
      pnlPct: unrealizedPct ?? position.pnlPct,
      volumeH1Usd: activity ? activity.volumeH1Usd : null,
      txnsH1: activity ? activity.txnsH1 : null,
      costUsd,
      initialCostUsd,
      solUsd,
      liveMarketCapUsd:
        liveMarketCapUsd != null && liveMarketCapUsd > 0
          ? liveMarketCapUsd
          : null,
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
    sourceEntryMcUsd?: number;
    convictionScore?: number;
    scalpMode?: boolean;
    shortTermStrategyId?: ShortTermStrategyId;
    tradeProfileId?: string;
    tradeProfileName?: string;
    tradeProfileIcon?: string;
    tradeProfileColor?: string;
    tradeProfileScore?: number;
    tradeProfileReason?: string;
    profileTakeProfitPct?: number;
    profileStopLossPct?: number;
    profileTrailingStopPct?: number;
    profileTrailingActivationProfit?: number;
    profileForceScalp?: boolean;
    profileHardTimeLimitSec?: number;
    profileOverrideScalpParams?: boolean;
    profileMomentumFailDropPct?: number;
    profileDeadVolumeMinHoldMinutes?: number;
    profileAggressiveDeadMarket?: boolean;
    profileTurboMode?: boolean;
    entrySource?: Position['entrySource'];
    scannerPlaybook?: string;
    scannerConfluence?: number;
    candleSource?: 'real' | 'synthetic';
    top10HoldPct?: number | null;
    tokenAgeHours?: number | null;
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
      takeProfitPct:
        isStrategyEnabledForProfile('tiered_profit_taking', input.tradeProfileId) &&
        config.profitStrategy?.enabled
        ? config.trade.maxProfitPercent
        : randomTakeProfitPct(),
      stopLossPct: rules.hardStopLossPct ?? config.trade.stopLossPercent,
      highWaterMarkSol: input.entryPriceSol,
      lowWaterMarkSol: input.entryPriceSol,
      maxRunupPct: 0,
      maxDrawdownPct: 0,
      trailingStopPct:
        isStrategyEnabledForProfile('tiered_profit_taking', input.tradeProfileId) &&
        config.profitStrategy?.enabled
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
      sourceEntryMcUsd:
        input.sourceEntryMcUsd != null &&
        Number.isFinite(input.sourceEntryMcUsd) &&
        input.sourceEntryMcUsd > 0
          ? input.sourceEntryMcUsd
          : undefined,
      convictionScore: input.convictionScore,
      qualityTier: deriveQualityTier(input.convictionScore),
      tradeProfileId: input.tradeProfileId,
      tradeProfileName: input.tradeProfileName,
      tradeProfileIcon: input.tradeProfileIcon,
      tradeProfileColor: input.tradeProfileColor,
      tradeProfileScore: input.tradeProfileScore,
      tradeProfileReason: input.tradeProfileReason,
      profileTurboMode: input.profileTurboMode === true,
      entrySource: input.entrySource,
      scannerPlaybook: input.scannerPlaybook,
      scannerConfluence: input.scannerConfluence,
      candleSource: input.candleSource,
      top10HoldPct:
        input.top10HoldPct != null && Number.isFinite(input.top10HoldPct)
          ? input.top10HoldPct
          : undefined,
      tokenAgeHoursAtEntry:
        input.tokenAgeHours != null && Number.isFinite(input.tokenAgeHours)
          ? Math.max(0, Number(input.tokenAgeHours))
          : undefined,
    };

    if (input.scalpMode) {
      const id = input.shortTermStrategyId || 'quick_scalper';
      Object.assign(position, seedShortTermPosition(id, position.openedAt));
      const suiteTag = isScalperSuiteProfile(config.strategyProfile)
        ? ` [${getScalperSuiteVariantLabel(config.strategyProfile)}]`
        : '';
      this.log(
        'info',
        `${id}${suiteTag} armed on ${position.symbol} — TP +${position.scalpTpPct}% / SL ${position.scalpSlPct}% / timer ${Math.round(((position.scalpDeadlineMs ?? 0) - position.openedAt) / 1000)}s`
      );
    }

    applyTradeProfileExitRules(
      position,
      {
        takeProfitPct: input.profileTakeProfitPct,
        stopLossPct: input.profileStopLossPct,
        trailingStopPct: input.profileTrailingStopPct,
        trailingActivationProfit: input.profileTrailingActivationProfit,
        forceScalp: input.profileForceScalp,
        shortTermStrategyId: input.shortTermStrategyId,
        hardTimeLimitSec: input.profileHardTimeLimitSec,
        overrideScalpParams: input.profileOverrideScalpParams,
        momentumFailDropPct: input.profileMomentumFailDropPct,
        aggressiveDeadMarket: input.profileAggressiveDeadMarket,
        deadVolumeMinHoldMinutes: input.profileDeadVolumeMinHoldMinutes,
      },
      seedShortTermPosition
    );

    if (
      !position.scalpMode &&
      position.convictionScore != null &&
      position.convictionScore < effectiveLowConvictionTrailThreshold()
    ) {
      position.trailingStopPct = Math.max(
        6,
        position.trailingStopPct - effectiveLowConvictionTrailTightenPct()
      );
    }

    this.positions.set(position.id, position);
    this.priceCache.set(input.mint, input.entryPriceSol);
    if (position.entryMarketCapUsd != null) {
      this.marketCapCache.set(input.mint, position.entryMarketCapUsd);
    }
    const trailArm =
      position.trailingActivationProfit != null &&
      Number.isFinite(position.trailingActivationProfit)
        ? position.trailingActivationProfit
        : isStrategyEnabledForProfile(
              'tiered_profit_taking',
              position.tradeProfileId
            ) &&
            config.profitStrategy?.enabled
          ? config.profitStrategy.trailingStopAfter
          : config.risk.trailingActivationProfit;
    const profileBit = position.tradeProfileName
      ? ` · profile ${position.tradeProfileIcon || ''} ${position.tradeProfileName}`
      : '';
    this.log(
      'info',
      `Live position tracked ${formatTokenLabel(position.symbol, position.name, position.mint)} ` +
        `@ ${input.entryPriceSol.toExponential(4)} — trail arms at +${trailArm}%${profileBit}`
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
      sourceEntryMcUsd?: number;
      convictionScore?: number;
      scalpMode?: boolean;
      shortTermStrategyId?: ShortTermStrategyId;
      tradeProfileId?: string;
      tradeProfileName?: string;
      tradeProfileIcon?: string;
      tradeProfileColor?: string;
      tradeProfileScore?: number;
      tradeProfileReason?: string;
      profileTakeProfitPct?: number;
      profileStopLossPct?: number;
      profileTrailingStopPct?: number;
      profileTrailingActivationProfit?: number;
      profileForceScalp?: boolean;
      profileHardTimeLimitSec?: number;
      profileOverrideScalpParams?: boolean;
      profileMomentumFailDropPct?: number;
      profileDeadVolumeMinHoldMinutes?: number;
      profileAggressiveDeadMarket?: boolean;
      profileTurboMode?: boolean;
      entrySource?: Position['entrySource'];
      scannerPlaybook?: string;
      scannerConfluence?: number;
      candleSource?: 'real' | 'synthetic';
      top10HoldPct?: number | null;
      tokenAgeHours?: number | null;
    }
  ): Position | null {
    const spendSol = clampToMaxAllowedTradeSol(
      solAmount ??
        config.trade.baseTradeAmountSol ??
        config.trade.tradeAmountSol,
      meta?.entrySource
        ? `simulateBuy:${meta.entrySource}`
        : `simulateBuy:${meta?.strategyKind ?? 'normal'}`
    );
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
      const port = this.getPortfolioSummary();
      const reason =
        `Insufficient available funds: need ${spendSol.toFixed(4)} SOL, have ${this.balanceSol.toFixed(4)} SOL ` +
        `(equity ${port.totalEquitySol.toFixed(4)}, ${port.openCount} open)`;
      this.log('error', reason);
      try {
        const { logger } = require('./logger') as typeof import('./logger');
        logger.warn('Trade', reason, {
          neededSol: spendSol,
          availableSol: this.balanceSol,
          totalEquitySol: port.totalEquitySol,
          positionsCostSol: port.positionsCostSol,
          openCount: port.openCount,
          mint,
          symbol: tokenSymbol,
          mode: config.mode,
        });
        const {
          notifyInsufficientFunds,
          notifyLowEquity,
        } = require('./emailNotifications') as typeof import('./emailNotifications');
        void notifyInsufficientFunds({
          neededSol: spendSol,
          availableSol: this.balanceSol,
          totalEquitySol: port.totalEquitySol,
          positionsCostSol: port.positionsCostSol,
          positionsValueSol: port.positionsValueSol,
          openCount: port.openCount,
          mint,
          symbol: tokenSymbol,
          mode: config.mode,
        });
        const threshold = Number(config.notifications?.lowEquitySol) || 1;
        if (port.totalEquitySol < threshold) {
          void notifyLowEquity({
            totalEquitySol: port.totalEquitySol,
            availableSol: this.balanceSol,
            positionsSol: port.positionsValueSol,
            openCount: port.openCount,
            mode: config.mode,
          });
        }
      } catch {
        /* optional notify */
      }
      return null;
    }

    const feeBps = config.paper.feeBps;
    const slippageBps = meta?.slippageBps ?? config.paper.slippageBps;
    const fee = applyFee(spendSol, feeBps);
    const netSol = spendSol - fee;
    const entryPrice = applySlippage(priceSol, slippageBps, 'buy');
    const amountTokens = netSol / entryPrice;

    this.balanceSol -= spendSol;
    // Mark must match fill — seeding cache with raw quote instantly marks −slip%
    this.priceCache.set(mint, entryPrice);

    // Align Buy MC to the slipped fill price (MC was resolved at raw quote)
    let entryMarketCapUsd =
      meta?.entryMarketCapUsd != null &&
      Number.isFinite(meta.entryMarketCapUsd) &&
      meta.entryMarketCapUsd > 0
        ? meta.entryMarketCapUsd
        : undefined;
    if (
      entryMarketCapUsd != null &&
      priceSol > 0 &&
      entryPrice > 0 &&
      Math.abs(entryPrice - priceSol) / priceSol > 0.0005
    ) {
      entryMarketCapUsd =
        marketCapAtPrice(entryMarketCapUsd, priceSol, entryPrice) ??
        entryMarketCapUsd;
    }

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
      takeProfitPct:
        isStrategyEnabledForProfile('tiered_profit_taking', meta?.tradeProfileId) &&
        config.profitStrategy?.enabled
        ? config.trade.maxProfitPercent
        : randomTakeProfitPct(),
      stopLossPct: rules.hardStopLossPct ?? config.trade.stopLossPercent,
      highWaterMarkSol: entryPrice,
      lowWaterMarkSol: entryPrice,
      maxRunupPct: 0,
      maxDrawdownPct: 0,
      trailingStopPct:
        isStrategyEnabledForProfile('tiered_profit_taking', meta?.tradeProfileId) &&
        config.profitStrategy?.enabled
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
      entryMarketCapUsd,
      sourceEntryMcUsd:
        meta?.sourceEntryMcUsd != null &&
        Number.isFinite(meta.sourceEntryMcUsd) &&
        meta.sourceEntryMcUsd > 0
          ? meta.sourceEntryMcUsd
          : undefined,
      convictionScore: meta?.convictionScore,
      qualityTier: deriveQualityTier(meta?.convictionScore),
      tradeProfileId: meta?.tradeProfileId,
      tradeProfileName: meta?.tradeProfileName,
      tradeProfileIcon: meta?.tradeProfileIcon,
      tradeProfileColor: meta?.tradeProfileColor,
      tradeProfileScore: meta?.tradeProfileScore,
      tradeProfileReason: meta?.tradeProfileReason,
      profileTurboMode: meta?.profileTurboMode === true,
      entrySource: meta?.entrySource,
      scannerPlaybook: meta?.scannerPlaybook,
      scannerConfluence: meta?.scannerConfluence,
      candleSource: meta?.candleSource,
      top10HoldPct:
        meta?.top10HoldPct != null && Number.isFinite(meta.top10HoldPct)
          ? meta.top10HoldPct
          : undefined,
      tokenAgeHoursAtEntry:
        meta?.tokenAgeHours != null && Number.isFinite(meta.tokenAgeHours)
          ? Math.max(0, Number(meta.tokenAgeHours))
          : undefined,
    };

    if (meta?.scalpMode) {
      const id = meta.shortTermStrategyId || 'quick_scalper';
      Object.assign(position, seedShortTermPosition(id, position.openedAt));
      const suiteTag = isScalperSuiteProfile(config.strategyProfile)
        ? ` [${getScalperSuiteVariantLabel(config.strategyProfile)}]`
        : '';
      this.log(
        'info',
        `${id}${suiteTag} armed on ${label} — TP +${position.scalpTpPct}% / SL ${position.scalpSlPct}% / timer ${Math.round(((position.scalpDeadlineMs ?? 0) - position.openedAt) / 1000)}s`
      );
    }

    applyTradeProfileExitRules(
      position,
      {
        takeProfitPct: meta?.profileTakeProfitPct,
        stopLossPct: meta?.profileStopLossPct,
        trailingStopPct: meta?.profileTrailingStopPct,
        trailingActivationProfit: meta?.profileTrailingActivationProfit,
        forceScalp: meta?.profileForceScalp,
        shortTermStrategyId: meta?.shortTermStrategyId,
        hardTimeLimitSec: meta?.profileHardTimeLimitSec,
        overrideScalpParams: meta?.profileOverrideScalpParams,
        momentumFailDropPct: meta?.profileMomentumFailDropPct,
        aggressiveDeadMarket: meta?.profileAggressiveDeadMarket,
        deadVolumeMinHoldMinutes: meta?.profileDeadVolumeMinHoldMinutes,
      },
      seedShortTermPosition
    );

    // Low-conviction: tighten trail at open
    if (
      !position.scalpMode &&
      position.convictionScore != null &&
      position.convictionScore < effectiveLowConvictionTrailThreshold()
    ) {
      position.trailingStopPct = Math.max(
        6,
        position.trailingStopPct - effectiveLowConvictionTrailTightenPct()
      );
    }

    this.positions.set(position.id, position);
    if (position.entryMarketCapUsd != null) {
      this.marketCapCache.set(mint, position.entryMarketCapUsd);
    }
    const mcBit =
      position.entryMarketCapUsd != null
        ? ` MC~$${Math.round(position.entryMarketCapUsd).toLocaleString()}`
        : '';
    const profileBit = position.tradeProfileName
      ? ` · ${position.tradeProfileIcon || ''} ${position.tradeProfileName}`
      : '';
    const turboBit = position.profileTurboMode ? ' · TURBO' : '';
    this.log(
      'buy',
      `Bought ${label} (${mint.slice(0, 8)}…) — ${amountTokens.toFixed(2)} tokens @ ${entryPrice.toExponential(4)} SOL ` +
        `(${spendSol.toFixed(4)} SOL, ${strategyKind}, trail ${position.trailingStopPct}%${mcBit}${profileBit}${turboBit})`,
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
      /**
       * Paper/live-sim stop-limit floor: fill will not go below this price
       * (caps adverse gap-through on hard SL).
       */
      minFillPriceSol?: number;
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
    if (
      options?.minFillPriceSol != null &&
      options.minFillPriceSol > 0 &&
      Number.isFinite(options.minFillPriceSol)
    ) {
      if (safeMark < options.minFillPriceSol) {
        console.warn(
          `[paper] Cap SL gap fill ${safeMark.toExponential(3)} → ${options.minFillPriceSol.toExponential(3)} ` +
            `for ${position.symbol || position.mint.slice(0, 8)}`
        );
        safeMark = options.minFillPriceSol;
      }
    }
    if (position.entryPriceSol > 0 && currentPriceSol > 0) {
      const ratio = safeMark / position.entryPriceSol;
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
    const liveMc = this.marketCapCache.get(position.mint);
    // Display Exit MC is fill-scaled; live Dex kept for tooltip audit
    const exitCaps = resolveExitMarketCaps({
      entryMarketCapUsd: position.entryMarketCapUsd,
      entryPriceSol: position.entryPriceSol,
      exitPriceSol: safeMark > 0 ? safeMark : exitPrice,
      liveMarketCapUsd: liveMc,
    });
    const exitMc = exitCaps.displayUsd;
    const impliedExitMc = exitCaps.impliedFromFillUsd;
    const liveExitMc = exitCaps.liveUsd;

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

      // Record slice in closed history for tracking / UI grouping
      const slice: Position = {
        ...position,
        id: nextId('part'),
        parentPositionId: position.id,
        amountTokens: tokensToSell,
        costSol: costBasisSold,
        status: 'closed',
        closedAt: Date.now(),
        exitPriceSol: exitPrice,
        exitMarketCapUsd: exitMc,
        impliedExitMarketCapUsd: impliedExitMc,
        liveExitMarketCapUsd: liveExitMc,
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
    position.impliedExitMarketCapUsd = impliedExitMc;
    position.liveExitMarketCapUsd = liveExitMc;
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

    maybeRecordScannerOutcome(position, totalPct);
    maybeRecordLaneOutcome(position, totalPnl, totalPct);
    maybeRecordLearningEpisode(position, totalPnl, totalPct);
    try {
      const { notifyMarlTradeClosed } =
        require('./marlCoordinator') as typeof import('./marlCoordinator');
      notifyMarlTradeClosed({
        profileId: position.tradeProfileId,
        pnlSol: totalPnl,
        costSol: closedCostSol,
        mint: position.mint,
        symbol: position.symbol,
      });
    } catch {
      /* */
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

    if (totalPnl > 0) {
      try {
        const {
          notifyProfitableClose,
        } = require('./emailNotifications') as typeof import('./emailNotifications');
        const day = this.getDailyWinStats();
        const holdSeconds =
          position.closedAt && position.openedAt
            ? (position.closedAt - position.openedAt) / 1000
            : undefined;
        const breakdownParts: string[] = [];
        if (position.tradeProfileName) {
          breakdownParts.push(`Profile: ${position.tradeProfileName}`);
        }
        if (position.shortTermStrategyId) {
          breakdownParts.push(`Scalp engine: ${position.shortTermStrategyId}`);
        }
        if (Math.abs(totalPnl - pnlSol) > 1e-9) {
          breakdownParts.push(
            `Final slice ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL; total realized ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} SOL`
          );
        }
        void notifyProfitableClose({
          symbol: position.symbol,
          name: position.name,
          mint: position.mint,
          pnlSol: totalPnl,
          pnlPct: totalPct,
          costSol: closedCostSol,
          reason,
          holdSeconds,
          mode: config.mode,
          breakdown:
            breakdownParts.length > 0 ? breakdownParts.join('\n') : undefined,
          dailyWinRatePct: day.winRatePct,
          dailyPnlSol: day.pnlSol,
          dailyWins: day.wins,
          dailyLosses: day.losses,
          allTimeWinRatePct: this.getWinRatePct(),
        });
      } catch {
        /* optional notify */
      }
    }

    registerExitForReentry({
      mint: position.mint,
      symbol: position.symbol,
      name: position.name,
      positionId: position.id,
      soldAt: position.closedAt!,
      sellPriceSol: exitPrice,
      entryPriceSol: position.entryPriceSol,
      pnlPct: totalPct,
      pnlSol: totalPnl,
      reason,
      sourceWallets: position.sourceWallets,
      sourceNames: position.sourceNames,
    });

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
   * Clear closed-trade session history only.
   * Does not touch open positions, balance, logs, or learning / tradeProfiles.
   */
  clearClosedHistory(): { cleared: number } {
    const cleared = this.closedPositions.length;
    this.closedPositions = [];
    this.persistState();
    this.log('info', 'Closed trade history cleared (session)');
    return { cleared };
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
    currentPrice: number,
    nowMs: number = Date.now()
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
      | 'info'
      | 'scalp_tp'
      | 'scalp_sl'
      | 'scalp_timer'
      | 'scalp_signal_fail';
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
    if (
      position.lowWaterMarkSol == null ||
      !(position.lowWaterMarkSol > 0)
    ) {
      position.lowWaterMarkSol = position.entryPriceSol;
    }
    if (markPrice < position.lowWaterMarkSol) {
      position.lowWaterMarkSol = markPrice;
    }
    const markPnlPct =
      ((markPrice - position.entryPriceSol) / position.entryPriceSol) * 100;
    if (
      position.maxRunupPct == null ||
      markPnlPct > position.maxRunupPct
    ) {
      position.maxRunupPct = markPnlPct;
    }
    if (
      position.maxDrawdownPct == null ||
      markPnlPct < position.maxDrawdownPct
    ) {
      position.maxDrawdownPct = markPnlPct;
    }
    const label = formatTokenLabel(position.symbol, position.name, position.mint);

    // Adaptive profile exit (sync / backtest)
    // Skipped when Global Micro-Bot Take Profit master override is ON (fixed % only).
    if (
      !isGlobalMicroBotTpOverrideActive(position) &&
      (position.profileExitPolicy || position.tradeProfileId)
    ) {
      try {
        const {
          evaluateAdaptiveProfileExit,
          resolveExitPolicy,
        } = require('./profileTradeIntelligence') as typeof import('./profileTradeIntelligence');
        const policy =
          position.profileExitPolicy ||
          resolveExitPolicy(position.tradeProfileId, null);
        const peakUnrealizedPct =
          position.entryPriceSol > 0
            ? ((position.highWaterMarkSol - position.entryPriceSol) /
                position.entryPriceSol) *
              100
            : Math.max(0, markPnlPct);
        const taOk =
          position.nearKeyFib === true ||
          position.nearSupport === true ||
          (Array.isArray(position.chartPatternIds) &&
            position.chartPatternIds.length > 0) ||
          (position.convictionScore != null && position.convictionScore >= 45);
        const taBroken =
          position.convictionScore != null &&
          position.convictionScore < 30 &&
          !position.nearKeyFib &&
          !position.nearSupport;
        const adapt = evaluateAdaptiveProfileExit({
          policy,
          pnlPct: markPnlPct,
          entryPriceSol: position.entryPriceSol,
          currentPriceSol: markPrice,
          highWaterMarkSol: position.highWaterMarkSol,
          trailingActive: position.trailingActive === true,
          trailingStopPct: position.trailingStopPct ?? 0,
          partialSellDone: position.partialSellDone,
          bagTrimDone: position.bagTrimDone,
          takeProfitPct: position.takeProfitPct,
          convictionScore: position.convictionScore,
          openedAt: position.openedAt,
          nowMs,
          peakUnrealizedPct,
          taStructureOk: taOk,
          taStructureBroken: taBroken,
          qualityTier: position.qualityTier,
        });
        if (
          adapt.type === 'tighten_trail' &&
          adapt.newTrailingStopPct != null &&
          !position.profileTrailTightened
        ) {
          position.trailingStopPct = adapt.newTrailingStopPct;
          position.profileTrailTightened = true;
        } else if (adapt.type === 'partial' && adapt.fraction != null) {
          this.simulateSell(position.id, markPrice, adapt.reason || 'Profile early partial', {
            fraction: adapt.fraction,
          });
          position.partialSellDone = true;
          return {
            kind: 'partial',
            reason: adapt.reason || 'Profile early partial',
            markPnlPct,
            stillOpen: this.positions.has(positionId),
          };
        } else if (adapt.type === 'full' && adapt.reason) {
          this.simulateSell(position.id, markPrice, adapt.reason);
          return {
            kind: 'full',
            reason: adapt.reason,
            markPnlPct,
            stillOpen: this.positions.has(positionId),
          };
        }
      } catch {
        /* ignore */
      }
    }

    // Heikin-Ashi trend exit (sync / backtest) — fail-open without price history
    if (
      isStrategyEnabledForProfile('heikin_ashi', position.tradeProfileId) &&
      position.profileExitPolicy?.heikinAshiExitEnabled !== false
    ) {
      try {
        const { getPriceHistory } =
          require('./technicalLevels') as typeof import('./technicalLevels');
        const { evaluateHaTrendExit } =
          require('./heikinAshi') as typeof import('./heikinAshi');
        const hist = getPriceHistory(position.mint);
        if (hist.length >= 10) {
          const candles = hist.map((p) => ({
            time: p.time,
            priceSol: p.price,
          }));
          const haReason = evaluateHaTrendExit(candles);
          if (haReason) {
            this.simulateSell(position.id, markPrice, haReason);
            return {
              kind: 'full',
              reason: haReason,
              markPnlPct,
              stillOpen: this.positions.has(positionId),
            };
          }
        }
      } catch {
        /* fail-open */
      }
    }

    // —— Quick Scalper / short-term timed exits (before tiered profit) ——
    if (position.scalpMode && position.scalpDeadlineMs != null) {
      const scalpAction = evaluateShortTermExit({
        strategyId:
          (position.shortTermStrategyId as ShortTermStrategyId) || 'quick_scalper',
        entryPriceSol: position.entryPriceSol,
        currentPriceSol: markPrice,
        highWaterMarkSol: position.highWaterMarkSol,
        openedAt: position.openedAt,
        nowMs,
        deadlineMs: position.scalpDeadlineMs,
        hardDeadlineMs: position.scalpHardDeadlineMs,
        tpPct: effectivePositionTakeProfitPct(position),
        slPct: position.scalpSlPct ?? position.stopLossPct,
        momentumFailDropPct: position.scalpMomentumFailDropPct,
      });
      // Post-Run Dip: clear Fib/S zone break + volume invalidation
      if (
        scalpAction.type === 'none' &&
        position.shortTermStrategyId === 'post_run_dip'
      ) {
        const inv = shouldInvalidatePostRunDipPosition({
          mint: position.mint,
          priceSol: markPrice,
        });
        if (inv.invalidate && inv.reason) {
          const tag = 'SCALP_SIGNAL_FAIL';
          console.log(
            `[scalp] ${tag} strategy=post_run_dip ${label} — ${inv.reason}`
          );
          this.log('sell', `${label}: [${tag}|post_run_dip] ${inv.reason}`);
          this.simulateSell(position.id, markPrice, inv.reason);
          return {
            kind: 'scalp_signal_fail',
            reason: inv.reason,
            markPnlPct,
            stillOpen: this.positions.has(positionId),
          };
        }
      }
      if (scalpAction.type === 'full') {
        const strat =
          position.shortTermStrategyId || 'quick_scalper';
        // Swing-style: defer soft timer while TA structure still ok
        if (
          scalpAction.exitKind === 'scalp_timer' &&
          position.profileExitPolicy?.extendHoldIfTaOk === true
        ) {
          const taOk =
            position.nearKeyFib === true ||
            position.nearSupport === true ||
            (Array.isArray(position.chartPatternIds) &&
              position.chartPatternIds.length > 0) ||
            (position.convictionScore != null &&
              position.convictionScore >= 45);
          const hardMs =
            position.scalpHardDeadlineMs != null &&
            position.scalpHardDeadlineMs > position.scalpDeadlineMs!
              ? position.scalpHardDeadlineMs
              : position.openedAt +
                Math.round(
                  (position.scalpDeadlineMs! - position.openedAt) * 1.4
                );
          if (taOk && nowMs < hardMs && markPnlPct > -2) {
            return null;
          }
        }
        // Soft Timer on green/near-flat MB/migration: prefer trail / defer over dump
        if (
          scalpAction.exitKind === 'scalp_timer' &&
          (strat === 'momentum_burst' || strat === 'post_migration_scalp')
        ) {
          const softPnl =
            ((markPrice - position.entryPriceSol) / position.entryPriceSol) *
            100;
          const hardMs =
            position.scalpHardDeadlineMs != null &&
            position.scalpHardDeadlineMs > position.scalpDeadlineMs!
              ? position.scalpHardDeadlineMs
              : position.openedAt +
                Math.round(
                  (position.scalpDeadlineMs! - position.openedAt) * 1.4
                );
          if (softPnl >= -2 && nowMs < hardMs) {
            const trailAct = evaluateScalpProtectiveTrail({
              entryPriceSol: position.entryPriceSol,
              currentPriceSol: markPrice,
              highWaterMarkSol: position.highWaterMarkSol,
              trailingActive: position.trailingActive === true,
              trailingStopPct: position.trailingStopPct,
              trailingActivationProfit: position.trailingActivationProfit,
            });
            if (trailAct.type === 'arm_trail') {
              position.trailingActive = true;
              position.trailingActivatedAt = nowMs;
              position.trailingStopPct = trailAct.trailPct;
              position.trailingStopPriceSol =
                position.highWaterMarkSol * (1 - trailAct.trailPct / 100);
              this.log('info', `${label}: ${trailAct.reason}`);
              return {
                kind: 'arm_trail',
                reason: trailAct.reason,
                markPnlPct,
                stillOpen: true,
              };
            }
            if (trailAct.type === 'trail_exit') {
              this.simulateSell(position.id, markPrice, trailAct.reason);
              return {
                kind: 'trail_exit',
                reason: trailAct.reason,
                markPnlPct,
                stillOpen: this.positions.has(positionId),
              };
            }
            // Defer soft Timer — let hard deadline / fade / trail decide
            return {
              kind: 'none',
              reason: 'soft timer deferred (green/near-flat)',
              markPnlPct,
              stillOpen: true,
            };
          }
        }
        const tag = shortTermExitLogTag(scalpAction.exitKind);
        const minFill =
          scalpAction.exitKind === 'scalp_sl'
            ? hardStopMinFillPriceSol(
                position.entryPriceSol,
                position.scalpSlPct ?? position.stopLossPct
              )
            : undefined;
        console.log(
          `[scalp] ${tag} strategy=${strat} ${label} — ${scalpAction.reason}`
        );
        this.log(
          'sell',
          `${label}: [${tag}|${strat}] ${scalpAction.reason}`
        );
        this.simulateSell(position.id, markPrice, scalpAction.reason, {
          minFillPriceSol: minFill,
        });
        return {
          kind: scalpAction.exitKind,
          reason: scalpAction.reason,
          markPnlPct,
          stillOpen: this.positions.has(positionId),
        };
      }
      // Protective trail while waiting on soft timer / before primary deadline
      const trailAct = evaluateScalpProtectiveTrail({
        entryPriceSol: position.entryPriceSol,
        currentPriceSol: markPrice,
        highWaterMarkSol: position.highWaterMarkSol,
        trailingActive: position.trailingActive === true,
        trailingStopPct: position.trailingStopPct,
        trailingActivationProfit: position.trailingActivationProfit,
      });
      if (trailAct.type === 'arm_trail') {
        position.trailingActive = true;
        position.trailingActivatedAt = nowMs;
        position.trailingStopPct = trailAct.trailPct;
        position.trailingStopPriceSol =
          position.highWaterMarkSol * (1 - trailAct.trailPct / 100);
        this.log('info', `${label}: ${trailAct.reason}`);
        return {
          kind: 'arm_trail',
          reason: trailAct.reason,
          markPnlPct,
          stillOpen: true,
        };
      }
      if (trailAct.type === 'trail_exit') {
        this.simulateSell(position.id, markPrice, trailAct.reason);
        return {
          kind: 'trail_exit',
          reason: trailAct.reason,
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

    // —— Advanced profit strategy (same as applyProfitStrategyTick, sync) ——
    // Global Micro-Bot Take Profit master override → fixed % only (no tiered/partial)
    if (
      !isGlobalMicroBotTpOverrideActive(position) &&
      isStrategyEnabledForProfile('tiered_profit_taking', position.tradeProfileId) &&
      config.profitStrategy?.enabled
    ) {
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
        convictionScore: position.convictionScore,
        openedAt: position.openedAt,
        tradeProfileId: position.tradeProfileId,
        scalpMode: position.scalpMode === true,
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
        const minFill =
          action.type === 'hard_sl'
            ? hardStopMinFillPriceSol(
                position.entryPriceSol,
                adjustedStopLossPct(
                  position.stopLossPct,
                  position.antiRug?.riskScore,
                  position.convictionScore
                )
              )
            : undefined;
        this.simulateSell(position.id, markPrice, action.reason, {
          minFillPriceSol: minFill,
        });
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
    let hardSl = rules.hardStopLossPct ?? position.stopLossPct;
    if (hardSl > 0) hardSl = -Math.abs(hardSl);

    if (markPnlPct <= hardSl) {
      const ageMs = Math.max(0, Date.now() - (position.openedAt || Date.now()));
      const swingGrace =
        !position.scalpMode &&
        !!position.tradeProfileId &&
        SWING_HARD_SL_GRACE_PROFILES.has(position.tradeProfileId) &&
        ageMs < SWING_HARD_SL_GRACE_MS &&
        markPnlPct > SWING_HARD_SL_GRACE_RUG_PCT;
      if (!swingGrace) {
        const reason = `hard stop-loss ${hardSl}%`;
        this.simulateSell(position.id, markPrice, reason, {
          minFillPriceSol: hardStopMinFillPriceSol(
            position.entryPriceSol,
            hardSl
          ),
        });
        return {
          kind: 'hard_sl',
          reason,
          markPnlPct,
          stillOpen: this.positions.has(positionId),
        };
      }
    }

    if (
      !isGlobalMicroBotTpOverrideActive(position) &&
      risk.tieredSellEnabled &&
      rules.tiers?.length
    ) {
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
    } else if (markPnlPct >= effectivePositionTakeProfitPct(position)) {
      const tp = effectivePositionTakeProfitPct(position);
      const reason = `take-profit ${tp.toFixed(0)}%`;
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
    const activation =
      stillOpen.trailingActivationProfit != null &&
      Number.isFinite(stillOpen.trailingActivationProfit)
        ? stillOpen.trailingActivationProfit
        : (risk.trailingActivationProfit ?? 30);

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
    maxSteps = 4,
    nowMs: number = Date.now()
  ): Array<NonNullable<ReturnType<PaperTrader['evaluatePositionTickSync']>>> {
    const events: Array<
      NonNullable<ReturnType<PaperTrader['evaluatePositionTickSync']>>
    > = [];
    for (let step = 0; step < maxSteps; step++) {
      const ev = this.evaluatePositionTickSync(positionId, currentPrice, nowMs);
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
   * Update dead-market streak from DexScreener (live) or path-proxy (backtest) activity.
   * Uses Strict Mode effective thresholds. `nowMs` lets backtests use the candle clock.
   */
  private evaluateDeadMarketExit(
    position: Position,
    nowMs: number = Date.now()
  ): string | null {
    const risk = config.risk;
    if (
      !isStrategyEnabledForProfile('dead_market_exit', position.tradeProfileId) ||
      !risk.enableDeadVolumeExit
    ) {
      return null;
    }

    const minHoldMs =
      Math.max(
        0,
        position.deadVolumeMinHoldMinutes != null &&
          Number.isFinite(position.deadVolumeMinHoldMinutes)
          ? Number(position.deadVolumeMinHoldMinutes)
          : effectiveDeadVolumeMinHoldMinutes()
      ) * 60_000;
    const holdMs = nowMs - position.openedAt;
    if (holdMs < minHoldMs) return null;

    const activity = this.marketActivityCache.get(position.mint);
    if (!activity) return null;
    // Ignore stale samples (e.g. failed refresh) — don't reset or trip the streak
    if (nowMs - activity.updatedAt > 15 * 60_000) return null;

    const volThreshold = Math.max(0, effectiveDeadVolumeUsdPerHour());
    const needHours = Math.max(1, effectiveDeadVolumeConsecutiveHours());
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
      position.deadMarketBelowSince = nowMs;
      return null;
    }

    const deadForMs = nowMs - position.deadMarketBelowSince;
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

  /**
   * Backtest/sim helper — same dead-market gates as live paper, with candle clock.
   * Caller must setMarketActivity first. Returns sell reason or null.
   */
  tryDeadMarketExit(positionId: string, nowMs: number): string | null {
    const position = this.positions.get(positionId);
    if (!position || position.status === 'closed') return null;
    return this.evaluateDeadMarketExit(position, nowMs);
  }

  async checkPositionsAsync(): Promise<void> {
    if (!config.strategy.enableAutoSell) return;

    this.evaluateAndMaybeHaltRisk();
    try {
      const { maybeWarnLowEquity } = require('./fundGate') as typeof import('./fundGate');
      maybeWarnLowEquity();
    } catch {
      /* optional */
    }

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
      if (
        position.lowWaterMarkSol == null ||
        !(position.lowWaterMarkSol > 0)
      ) {
        position.lowWaterMarkSol = position.entryPriceSol;
      }
      if (currentPrice < position.lowWaterMarkSol) {
        position.lowWaterMarkSol = currentPrice;
      }
      const markPnlPctAsync =
        ((currentPrice - position.entryPriceSol) / position.entryPriceSol) * 100;
      if (
        position.maxRunupPct == null ||
        markPnlPctAsync > position.maxRunupPct
      ) {
        position.maxRunupPct = markPnlPctAsync;
      }
      if (
        position.maxDrawdownPct == null ||
        markPnlPctAsync < position.maxDrawdownPct
      ) {
        position.maxDrawdownPct = markPnlPctAsync;
      }

      const label = formatTokenLabel(position.symbol, position.name, position.mint);

      // Dead / inactive market force-exit (paper + live tracked)
      const deadReason = this.evaluateDeadMarketExit(position);
      if (deadReason) {
        const scalpTag = position.scalpMode
          ? ` [scalp=${position.shortTermStrategyId || 'scalp'}]`
          : '';
        console.log(`[dead-vol] 🔴 ${label}${scalpTag} — ${deadReason}`);
        this.log('sell', `${label}: [DEAD_MARKET]${scalpTag} ${deadReason}`);
        await this.closePositionByRules(position, currentPrice, deadReason);
        continue;
      }

      // Heikin-Ashi trend exit (swing profiles) — after dead-market, before adaptive
      if (
        isStrategyEnabledForProfile('heikin_ashi', position.tradeProfileId) &&
        position.profileExitPolicy?.heikinAshiExitEnabled !== false
      ) {
        try {
          const { fetchTokenOhlcvCandles } =
            require('./marketData') as typeof import('./marketData');
          const { evaluateHaTrendExit } =
            require('./heikinAshi') as typeof import('./heikinAshi');
          const ohlcv = await fetchTokenOhlcvCandles(position.mint);
          const haReason = evaluateHaTrendExit(ohlcv.candles);
          if (haReason) {
            console.log(`[ha-exit] 🔴 ${label} — ${haReason}`);
            this.log('sell', `${label}: [HEIKIN_ASHI] ${haReason}`);
            await this.closePositionByRules(position, currentPrice, haReason);
            continue;
          }
        } catch {
          /* fail-open */
        }
      }

      // Adaptive profile exit brain (early partial / trail tighten / momentum fade / profit-lock)
      // Skipped when Global Micro-Bot Take Profit master override is ON (fixed % only).
      if (
        !isGlobalMicroBotTpOverrideActive(position) &&
        (position.profileExitPolicy || position.tradeProfileId)
      ) {
        try {
          const {
            evaluateAdaptiveProfileExit,
            resolveExitPolicy,
          } = require('./profileTradeIntelligence') as typeof import('./profileTradeIntelligence');
          const policy =
            position.profileExitPolicy ||
            resolveExitPolicy(position.tradeProfileId, null);
          const pnlPct = markPnlPctAsync;
          const peakUnrealizedPct =
            position.entryPriceSol > 0
              ? ((position.highWaterMarkSol - position.entryPriceSol) /
                  position.entryPriceSol) *
                100
              : Math.max(0, pnlPct);
          const taOk =
            position.nearKeyFib === true ||
            position.nearSupport === true ||
            (Array.isArray(position.chartPatternIds) &&
              position.chartPatternIds.length > 0) ||
            (position.convictionScore != null && position.convictionScore >= 45);
          const taBroken =
            position.convictionScore != null &&
            position.convictionScore < 30 &&
            !position.nearKeyFib &&
            !position.nearSupport;
          const adapt = evaluateAdaptiveProfileExit({
            policy,
            pnlPct,
            entryPriceSol: position.entryPriceSol,
            currentPriceSol: currentPrice,
            highWaterMarkSol: position.highWaterMarkSol,
            trailingActive: position.trailingActive === true,
            trailingStopPct: position.trailingStopPct ?? 0,
            partialSellDone: position.partialSellDone,
            bagTrimDone: position.bagTrimDone,
            takeProfitPct: position.takeProfitPct,
            convictionScore: position.convictionScore,
            openedAt: position.openedAt,
            peakUnrealizedPct,
            taStructureOk: taOk,
            taStructureBroken: taBroken,
            qualityTier: position.qualityTier,
          });
          if (adapt.type === 'tighten_trail' && adapt.newTrailingStopPct != null) {
            if (!position.profileTrailTightened) {
              position.trailingStopPct = adapt.newTrailingStopPct;
              position.profileTrailTightened = true;
              console.log(
                `[profile-exit] ${label} — ${adapt.reason}`
              );
            }
          } else if (adapt.type === 'partial' && adapt.fraction != null) {
            this.simulateSell(position.id, currentPrice, adapt.reason || 'Profile early partial', {
              fraction: adapt.fraction,
            });
            position.partialSellDone = true;
            this.log('sell', `${label}: [PROFILE_EARLY_PARTIAL] ${adapt.reason}`);
            continue;
          } else if (adapt.type === 'full' && adapt.reason) {
            await this.closePositionByRules(position, currentPrice, adapt.reason);
            continue;
          }
        } catch (err) {
          console.warn('[profile-exit] adaptive eval failed:', err);
        }
      }

      // Quick Scalper / short-term timed exits (before tiered profit)
      if (position.scalpMode && position.scalpDeadlineMs != null) {
        const scalpAction = evaluateShortTermExit({
          strategyId:
            (position.shortTermStrategyId as ShortTermStrategyId) ||
            'quick_scalper',
          entryPriceSol: position.entryPriceSol,
          currentPriceSol: currentPrice,
          highWaterMarkSol: position.highWaterMarkSol,
          openedAt: position.openedAt,
          nowMs: Date.now(),
          deadlineMs: position.scalpDeadlineMs,
          hardDeadlineMs: position.scalpHardDeadlineMs,
          tpPct: effectivePositionTakeProfitPct(position),
          slPct: position.scalpSlPct ?? position.stopLossPct,
          momentumFailDropPct: position.scalpMomentumFailDropPct,
        });
        if (
          scalpAction.type === 'none' &&
          position.shortTermStrategyId === 'post_run_dip'
        ) {
          const inv = shouldInvalidatePostRunDipPosition({
            mint: position.mint,
            priceSol: currentPrice,
          });
          if (inv.invalidate && inv.reason) {
            console.log(
              `[scalp] SCALP_SIGNAL_FAIL strategy=post_run_dip ${label} — ${inv.reason}`
            );
            this.log(
              'sell',
              `${label}: [SCALP_SIGNAL_FAIL|post_run_dip] ${inv.reason}`
            );
            await this.closePositionByRules(position, currentPrice, inv.reason);
            continue;
          }
        }
        if (scalpAction.type === 'full') {
          const strat =
            position.shortTermStrategyId || 'quick_scalper';
          // Soft Timer on green/near-flat MB/migration: prefer trail / defer over dump
          if (
            scalpAction.exitKind === 'scalp_timer' &&
            (strat === 'momentum_burst' || strat === 'post_migration_scalp')
          ) {
            const softPnl =
              ((currentPrice - position.entryPriceSol) /
                position.entryPriceSol) *
              100;
            const hardMs =
              position.scalpHardDeadlineMs != null &&
              position.scalpHardDeadlineMs > position.scalpDeadlineMs!
                ? position.scalpHardDeadlineMs
                : position.openedAt +
                  Math.round(
                    (position.scalpDeadlineMs! - position.openedAt) * 1.4
                  );
            if (softPnl >= -2 && Date.now() < hardMs) {
              const trailAct = evaluateScalpProtectiveTrail({
                entryPriceSol: position.entryPriceSol,
                currentPriceSol: currentPrice,
                highWaterMarkSol: position.highWaterMarkSol,
                trailingActive: position.trailingActive === true,
                trailingStopPct: position.trailingStopPct,
                trailingActivationProfit: position.trailingActivationProfit,
              });
              if (trailAct.type === 'arm_trail') {
                position.trailingActive = true;
                position.trailingActivatedAt = Date.now();
                position.trailingStopPct = trailAct.trailPct;
                position.trailingStopPriceSol =
                  position.highWaterMarkSol * (1 - trailAct.trailPct / 100);
                this.log('info', `${label}: ${trailAct.reason}`);
                continue;
              }
              if (trailAct.type === 'trail_exit') {
                console.log(
                  `[scalp] TRAIL strategy=${strat} ${label} — ${trailAct.reason}`
                );
                this.log('sell', `${label}: [SCALP_TRAIL] ${trailAct.reason}`);
                await this.closePositionByRules(
                  position,
                  currentPrice,
                  trailAct.reason
                );
                continue;
              }
              continue; // defer soft Timer
            }
          }
          const tag = shortTermExitLogTag(scalpAction.exitKind);
          console.log(
            `[scalp] ${tag} strategy=${strat} ${label} — ${scalpAction.reason}`
          );
          this.log(
            'sell',
            `${label}: [${tag}|${strat}] ${scalpAction.reason}`
          );
          await this.closePositionByRules(
            position,
            currentPrice,
            scalpAction.reason,
            scalpAction.exitKind === 'scalp_sl'
              ? {
                  minFillPriceSol: hardStopMinFillPriceSol(
                    position.entryPriceSol,
                    position.scalpSlPct ?? position.stopLossPct
                  ),
                }
              : undefined
          );
          continue;
        }
        // Protective trail for scalp profiles (Migration / Momentum / Scalper)
        const trailAct = evaluateScalpProtectiveTrail({
          entryPriceSol: position.entryPriceSol,
          currentPriceSol: currentPrice,
          highWaterMarkSol: position.highWaterMarkSol,
          trailingActive: position.trailingActive === true,
          trailingStopPct: position.trailingStopPct,
          trailingActivationProfit: position.trailingActivationProfit,
        });
        if (trailAct.type === 'arm_trail') {
          position.trailingActive = true;
          position.trailingActivatedAt = Date.now();
          position.trailingStopPct = trailAct.trailPct;
          position.trailingStopPriceSol =
            position.highWaterMarkSol * (1 - trailAct.trailPct / 100);
          this.log('info', `${label}: ${trailAct.reason}`);
          continue;
        }
        if (trailAct.type === 'trail_exit') {
          console.log(
            `[scalp] TRAIL strategy=${position.shortTermStrategyId || 'scalp'} ${label} — ${trailAct.reason}`
          );
          this.log('sell', `${label}: [SCALP_TRAIL] ${trailAct.reason}`);
          await this.closePositionByRules(position, currentPrice, trailAct.reason);
          continue;
        }
        continue;
      }

      // Advanced profit strategy (paper + live)
      // Global Micro-Bot Take Profit → skip tiered/partial; use fixed % below
      if (
        !isGlobalMicroBotTpOverrideActive(position) &&
        isStrategyEnabledForProfile('tiered_profit_taking', position.tradeProfileId) &&
        config.profitStrategy?.enabled
      ) {
        await this.applyProfitStrategyTick(position, currentPrice, label);
        continue;
      }

      // —— Legacy path (profit strategy off) ——
      const pnlPct =
        ((currentPrice - position.entryPriceSol) / position.entryPriceSol) * 100;
      const rules = getStrategyRiskRules(position.strategyKind);
      const risk = config.risk;

      const hardSlRaw = rules.hardStopLossPct ?? position.stopLossPct;
      const hardSl =
        hardSlRaw > 0 ? -Math.abs(hardSlRaw) : hardSlRaw;
      if (pnlPct <= hardSl) {
        const ageMs = Math.max(0, Date.now() - (position.openedAt || Date.now()));
        const swingGrace =
          !position.scalpMode &&
          !!position.tradeProfileId &&
          SWING_HARD_SL_GRACE_PROFILES.has(position.tradeProfileId) &&
          ageMs < SWING_HARD_SL_GRACE_MS &&
          pnlPct > SWING_HARD_SL_GRACE_RUG_PCT;
        if (!swingGrace) {
          await this.closePositionByRules(
            position,
            currentPrice,
            `hard stop-loss ${hardSl}%`,
            {
              minFillPriceSol: hardStopMinFillPriceSol(
                position.entryPriceSol,
                hardSl
              ),
            }
          );
          continue;
        }
      }

      if (
        !isGlobalMicroBotTpOverrideActive(position) &&
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
        (isGlobalMicroBotTpOverrideActive(position) ||
          (position.tradeMode !== 'live' && !risk.tieredSellEnabled)) &&
        pnlPct >= effectivePositionTakeProfitPct(position)
      ) {
        const tp = effectivePositionTakeProfitPct(position);
        await this.closePositionByRules(
          position,
          currentPrice,
          `take-profit ${tp.toFixed(0)}%`
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
      const activation =
        stillOpen.trailingActivationProfit != null &&
        Number.isFinite(stillOpen.trailingActivationProfit)
          ? stillOpen.trailingActivationProfit
          : (risk.trailingActivationProfit ?? 30);

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
      convictionScore: position.convictionScore,
      openedAt: position.openedAt,
      tradeProfileId: position.tradeProfileId,
      scalpMode: position.scalpMode === true,
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
      const minFill =
        action.type === 'hard_sl'
          ? hardStopMinFillPriceSol(
              position.entryPriceSol,
              adjustedStopLossPct(
                position.stopLossPct,
                position.antiRug?.riskScore,
                position.convictionScore
              )
            )
          : undefined;
      await this.closePositionByRules(position, currentPrice, action.reason, {
        minFillPriceSol: minFill,
      });
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
            const parentId = position.id;
            const costBasisSold =
              position.costSol * (sellAmt / position.amountTokens);
            const estSol = sellAmt * currentPrice;
            const slicePnl = estSol - costBasisSold;
            const slicePct =
              costBasisSold > 0 ? (slicePnl / costBasisSold) * 100 : 0;
            position.amountTokens -= sellAmt;
            position.costSol -= costBasisSold;
            position.solReturned = (position.solReturned ?? 0) + estSol;
            position.realizedPnlSol += slicePnl;
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
              // Display/history slice so Closed Trades can group partial TPs
              const liveMc = this.marketCapCache.get(position.mint);
              const exitCaps = resolveExitMarketCaps({
                entryMarketCapUsd: position.entryMarketCapUsd,
                entryPriceSol: position.entryPriceSol,
                exitPriceSol: currentPrice,
                liveMarketCapUsd: liveMc,
              });
              this.closedPositions.push({
                ...position,
                id: nextId('part'),
                parentPositionId: parentId,
                amountTokens: sellAmt,
                costSol: costBasisSold,
                status: 'closed',
                closedAt: Date.now(),
                exitPriceSol: currentPrice,
                exitMarketCapUsd: exitCaps.displayUsd,
                impliedExitMarketCapUsd: exitCaps.impliedFromFillUsd,
                liveExitMarketCapUsd: exitCaps.liveUsd,
                pnlSol: slicePnl,
                pnlPct: slicePct,
                reason: `partial: ${action.reason}`,
              });
              if (this.closedPositions.length > 200) {
                this.closedPositions = this.closedPositions.slice(-200);
              }
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
    reason: string,
    options?: { minFillPriceSol?: number }
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
          const liveMc = this.marketCapCache.get(position.mint);
          const exitCaps = resolveExitMarketCaps({
            entryMarketCapUsd: position.entryMarketCapUsd,
            entryPriceSol: position.entryPriceSol,
            exitPriceSol: currentPriceSol,
            liveMarketCapUsd: liveMc,
          });
          position.exitMarketCapUsd = exitCaps.displayUsd;
          position.impliedExitMarketCapUsd = exitCaps.impliedFromFillUsd;
          position.liveExitMarketCapUsd = exitCaps.liveUsd;
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
          maybeRecordScannerOutcome(position, pnlPct);
          maybeRecordLaneOutcome(position, position.pnlSol ?? 0, pnlPct);
          maybeRecordLearningEpisode(position, position.pnlSol ?? 0, pnlPct);
          registerExitForReentry({
            mint: position.mint,
            symbol: position.symbol,
            name: position.name,
            positionId: position.id,
            soldAt: position.closedAt,
            sellPriceSol: currentPriceSol,
            entryPriceSol: position.entryPriceSol,
            pnlPct,
            pnlSol: position.pnlSol ?? 0,
            reason,
            sourceWallets: position.sourceWallets,
            sourceNames: position.sourceNames,
          });
        } else {
          console.error(`[trail] Live sell failed: ${result.error}`);
        }
      } catch (err) {
        console.error('[trail] Live sell error:', err);
      }
      return;
    }

    this.simulateSell(position.id, currentPriceSol, reason, {
      minFillPriceSol: options?.minFillPriceSol,
    });
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

    const baseInterval = config.paper.positionCheckIntervalMs;
    const interval =
      config.mode === 'liveSimulation'
        ? Math.min(baseInterval, LIVE_SIM_CHECK_INTERVAL_MS)
        : baseInterval;
    this.checkTimer = setInterval(() => {
      void (async () => {
        if (config.paper.useLiveData || config.mode === 'liveSimulation') {
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
        (config.mode === 'liveSimulation'
          ? ' [LIVE SIM]'
          : config.paper.useLiveData
            ? ' [live data ON]'
            : '')
    );
  }

  /** Sum of PnL from positions closed today (UTC) */
  getDailyPnlSol(): number {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();

    return chronologicalRealizedDeltas(this.closedPositions)
      .filter((d) => d.time >= startMs)
      .reduce((sum, d) => sum + d.pnlSol, 0);
  }

  /** Win/loss + PnL for closes that finished today (UTC). */
  getDailyWinStats(): {
    wins: number;
    losses: number;
    winRatePct: number;
    pnlSol: number;
  } {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();
    const reps = representativeClosedTrades(this.closedPositions).filter(
      (p) => (p.closedAt ?? 0) >= startMs
    );
    const wins = reps.filter((p) => (p.pnlSol ?? 0) > 0).length;
    const losses = reps.filter((p) => (p.pnlSol ?? 0) <= 0).length;
    const pnlSol = reps.reduce((s, p) => s + (p.pnlSol ?? 0), 0);
    return {
      wins,
      losses,
      winRatePct: reps.length > 0 ? (wins / reps.length) * 100 : 0,
      pnlSol,
    };
  }

  /** Simple win-rate % from closed positions (for filter checks) */
  getWinRatePct(): number {
    const reps = representativeClosedTrades(this.closedPositions);
    if (reps.length === 0) return 0;
    const wins = reps.filter((p) => (p.pnlSol ?? 0) > 0).length;
    return (wins / reps.length) * 100;
  }

  /** Soak / tuning baseline: opens/hr, exit mix, fee drag vs mark. */
  getSoakMetrics(maxConcurrentHint?: number): SoakMetrics {
    const now = Date.now();
    const hourAgo = now - 60 * 60 * 1000;
    const closed = representativeClosedTrades(this.closedPositions);
    const opensLastHour =
      [...this.positions.values()].filter((p) => p.openedAt >= hourAgo).length +
      closed.filter((p) => p.openedAt >= hourAgo).length;
    const closesLastHour = closed.filter(
      (p) => (p.closedAt ?? 0) >= hourAgo
    ).length;

    const mixCounts = new Map<
      string,
      { key: ExitMixKey; label: string; count: number }
    >();
    let realizedSum = 0;
    let feeDragSum = 0;
    let feeDragN = 0;
    for (const p of closed) {
      const { key, label } = classifyExitKey(p.reason);
      const prev = mixCounts.get(key);
      if (prev) prev.count += 1;
      else mixCounts.set(key, { key, label, count: 1 });
      realizedSum += p.pnlPct ?? 0;
      const mark = markPnlPct(p.entryPriceSol, p.exitPriceSol ?? 0);
      if (mark != null && p.pnlPct != null) {
        feeDragSum += mark - p.pnlPct;
        feeDragN += 1;
      }
    }
    const n = closed.length;
    const exitMix = [...mixCounts.values()]
      .map((b) => ({
        key: b.key,
        label: b.label,
        count: b.count,
        pct: n > 0 ? Number(((b.count / n) * 100).toFixed(1)) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      opensLastHour,
      closesLastHour,
      openCount: this.positions.size,
      maxConcurrentHint:
        maxConcurrentHint ?? config.filters.maxConcurrentPositions ?? 40,
      exitMix,
      avgRealizedPnlPct: n > 0 ? Number((realizedSum / n).toFixed(2)) : 0,
      avgFeeDragPct: feeDragN > 0 ? Number((feeDragSum / feeDragN).toFixed(2)) : 0,
      totalFeeDragPctPoints: Number(feeDragSum.toFixed(2)),
      closedSampleSize: n,
      feeDragSampleSize: feeDragN,
      capturedAt: now,
    };
  }

  /** Aggregate stats for dashboard / backtest */
  getStats() {
    const closedRaw = this.closedPositions;
    const closed = representativeClosedTrades(closedRaw);
    const wins = closed.filter((p) => (p.pnlSol ?? 0) > 0);
    const losses = closed.filter((p) => (p.pnlSol ?? 0) <= 0);
    const netPnlSol = realizedPnlFromClosedHistory(closedRaw);
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
    for (const d of chronologicalRealizedDeltas(closedRaw)) {
      equity += d.pnlSol;
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
      equitySol: this.getEquitySol(),
      returnPct: (() => {
        const eq = this.getEquitySol();
        return start > 0 ? ((eq - start) / start) * 100 : 0;
      })(),
      mode: this.mode,
      portfolio: this.getPortfolioSummary(),
      soak: this.getSoakMetrics(),
    };
  }

  /** Per-profile scoreboard + learning suggestions for Trade Profiles UI */
  getTradeProfileIntelligence(opts?: {
    performanceWindow?: import('./microBotPerformance').PerformanceWindow;
    /** Heavy — only when explicitly requested (Bot Performance tab). */
    includePerformance?: boolean;
  }) {
    const {
      buildTradeProfileScoreboard,
      buildProfileLearningSuggestions,
    } = require('./profileTradeIntelligence') as typeof import('./profileTradeIntelligence');
    const { TRADE_PROFILE_CATALOG } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    const { getLaneOutcomeStatsByProfile } =
      require('./laneOutcomes') as typeof import('./laneOutcomes');
    const catalog = TRADE_PROFILE_CATALOG.map((p) => ({
      id: p.id,
      name: p.name,
      icon: p.icon,
      color: p.color,
    }));
    const scoreboard = buildTradeProfileScoreboard(
      this.closedPositions,
      catalog
    );
    const suggestions = buildProfileLearningSuggestions(
      scoreboard,
      getLaneOutcomeStatsByProfile()
    );
    if (opts?.includePerformance) {
      return {
        scoreboard,
        suggestions,
        performance: this.getMicroBotPerformance(
          opts?.performanceWindow ?? '7d'
        ),
      };
    }
    return { scoreboard, suggestions };
  }

  /** Ranked micro-bot performance for a time window (closed + episodes). */
  getMicroBotPerformance(
    window: import('./microBotPerformance').PerformanceWindow = '7d'
  ) {
    const { buildMicroBotPerformance, parsePerformanceWindow } =
      require('./microBotPerformance') as typeof import('./microBotPerformance');
    const {
      TRADE_PROFILE_CATALOG,
      ensureTradeProfilesInitialized,
      isProfileLearningModeOptedIn,
      getTradeProfileEnabledFlags,
    } = require('./tradeProfiles') as typeof import('./tradeProfiles');
    const { isLearningModeActive } =
      require('./learningMode') as typeof import('./learningMode');
    const { getCachedSolUsdPrice } =
      require('./marketData') as typeof import('./marketData');
    ensureTradeProfilesInitialized();
    const win = parsePerformanceWindow(window, '7d');

    // Short TTL cache — episode merge is disk-heavy; avoid blocking the event loop
    // on every intelligence / strategies poll.
    const cacheKey = win;
    const now = Date.now();
    const cached = (this as { _mbpCache?: { key: string; at: number; value: unknown } })
      ._mbpCache;
    if (cached && cached.key === cacheKey && now - cached.at < 12_000) {
      return cached.value as ReturnType<typeof buildMicroBotPerformance>;
    }

    const enabledById = getTradeProfileEnabledFlags();
    const learningModeOptIn: Partial<Record<string, boolean>> = {};
    const catalog = TRADE_PROFILE_CATALOG.map((p) => {
      learningModeOptIn[p.id] = isProfileLearningModeOptedIn(p.id);
      return {
        id: p.id,
        name: p.name,
        icon: p.icon,
        color: p.color,
        enabled: enabledById[p.id] !== false,
      };
    });
    let solUsd: number | null = null;
    try {
      const px = getCachedSolUsdPrice();
      if (Number.isFinite(px) && px > 0) solUsd = px;
    } catch {
      /* optional */
    }
    const value = buildMicroBotPerformance({
      closed: this.closedPositions,
      catalog,
      window: win,
      solUsd,
      globalLearningMode: isLearningModeActive(),
      learningModeOptIn,
    });
    (this as { _mbpCache?: { key: string; at: number; value: unknown } })._mbpCache =
      { key: cacheKey, at: now, value };
    return value;
  }

  /**
   * Chart.js-ready series for the dashboard.
   * - cumulativePnl: equity curve over closed trades
   * - perWallet: PnL attributed to triggering smart wallets
   * - winLoss: win vs loss counts (and SOL totals)
   */
  getChartData() {
    const closedRaw = this.closedPositions;
    const closed = representativeClosedTrades(closedRaw);

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

    for (const d of chronologicalRealizedDeltas(closedRaw)) {
      const p = d.position;
      cumulative += d.pnlSol;
      const time = d.time;
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
        pnlSol: d.pnlSol,
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
