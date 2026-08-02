/**
 * Central configuration for the smart money copy trading bot.
 * Organized into trade, filters, and strategy sections.
 */

import dotenv from 'dotenv';
dotenv.config();

import {
  loadWalletsFromDisk,
  saveWalletsToDisk,
  WalletRecord,
  SmartWallet,
  inferWalletCategory,
} from './walletStore';
export type { WalletCategory } from './walletStore';
import {
  loadTradingWalletsFile,
  saveTradingWalletsFile,
  makeTradingWalletId,
  isAllowedKeyEnvVar,
  normalizeEnvVarName,
  TradingWalletSlot,
  TradingWalletRole,
} from './tradingWalletStore';
import {
  deepMerge,
  loadPersistedSettings,
  savePersistedSettings,
  hasPersistedSettings,
  SETTINGS_VERSION,
  type PersistedBotSettings,
} from './settingsStore';
import { resetAllPersistedData } from './dataDir';
import { clearDashboardStateCache } from './dashboardState';
import { rpcEndpointsFromEnv } from './rpcUrl';

export type { SmartWallet, TradingWalletSlot, TradingWalletRole };
export { hasPersistedSettings };
/**
 * paper — virtual fills, optional live marks
 * liveSimulation — virtual fills + forced live market data / live filter path (no real funds)
 * live — real swaps with trading wallet keys
 */
export type TradingMode = 'paper' | 'liveSimulation' | 'live';
export type RiskLevel = 'on' | 'off';

/** Legacy multi-tier values migrated → 'on' on load. */
export type LegacyRiskLevel = 'low' | 'medium' | 'high' | 'degen';

export function isTradingMode(v: unknown): v is TradingMode {
  return v === 'paper' || v === 'liveSimulation' || v === 'live';
}

export const RISK_LEVELS: readonly RiskLevel[] = ['on', 'off'] as const;

export function isRiskLevel(value: string): value is RiskLevel {
  return (RISK_LEVELS as readonly string[]).includes(value);
}

/** Map stored low|medium|high|degen|on|off → canonical RiskLevel. */
export function normalizeRiskLevel(value: unknown): RiskLevel {
  if (value === 'off') return 'off';
  if (
    value === 'on' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'degen'
  ) {
    return 'on';
  }
  return 'on';
}

export const OFF_RISK_WARNING =
  '⚠️ Risk OFF — ops-only (Copy + Market Scanner). No hard liq/volume/MC/holder floors. Risk-linked modules and selective gates are off. Operational limits (already holding, max concurrent, balance, denied mints) still apply.';

/** Human labels for dashboard */
export const RISK_LEVEL_LABELS: Record<RiskLevel, string> = {
  on: 'On — lean baseline (hard floors + Copy/Scanner; quality modules manual)',
  off: 'Off — ops-only, no hard floors',
};

export interface SellTier {
  profitPct: number;
  sellPct: number;
}

export interface StrategyRiskRules {
  riskPercentPerTrade: number;
  trailingStopPct: number;
  hardStopLossPct: number;
  tiers: SellTier[];
  sizeMultiplier?: number;
}

export interface RiskConfig {
  enabled: boolean;
  useRiskSizing: boolean;
  riskPercentPerTrade: number;
  maxTradeSol: number;
  minTradeSol: number;
  weeklyLossLimitSol: number;
  maxDrawdownPct: number;
  autoPauseOnLimit: boolean;
  tieredSellEnabled: boolean;
  /**
   * Trailing stop distance from peak (%).
   * Alias: trailingStopPercent (kept in sync).
   */
  trailingStopPct: number;
  /** Same as trailingStopPct — preferred config name */
  trailingStopPercent: number;
  /** Unrealized profit % required before trailing arms (e.g. 30) */
  trailingActivationProfit: number;
  /**
   * Force-sell when DexScreener rolling 1h volume stays below threshold
   * (and/or no trades) for deadVolumeConsecutiveHours.
   */
  enableDeadVolumeExit: boolean;
  /** USD volume over the last hour below which the market is "dead" */
  deadVolumeUsdPerHour: number;
  /** Consecutive hours of dead samples before force-selling */
  deadVolumeConsecutiveHours: number;
  /** Do not apply dead-volume exit until position has been open this long */
  deadVolumeMinHoldMinutes: number;
  /**
   * Tighten trailing stop % when entry conviction is below this score.
   * 0 = disabled.
   */
  lowConvictionTrailThreshold?: number;
  /** Extra trail tightness (subtract from trail %) for low-conviction trades */
  lowConvictionTrailTightenPct?: number;
  normal: StrategyRiskRules;
  migration: StrategyRiskRules;
}

/** Defaults match Medium risk preset (recommended). */
export const DEFAULT_RISK: RiskConfig = {
  enabled: true,
  useRiskSizing: true,
  riskPercentPerTrade: 1.35,
  maxTradeSol: 0.9,
  minTradeSol: 0.02,
  weeklyLossLimitSol: 5,
  maxDrawdownPct: 22,
  autoPauseOnLimit: true,
  tieredSellEnabled: true,
  trailingStopPct: 19,
  trailingStopPercent: 19,
  trailingActivationProfit: 22,
  enableDeadVolumeExit: true,
  deadVolumeUsdPerHour: 60,
  deadVolumeConsecutiveHours: 2,
  deadVolumeMinHoldMinutes: 15,
  lowConvictionTrailThreshold: 50,
  lowConvictionTrailTightenPct: 6,
  normal: {
    riskPercentPerTrade: 1.35,
    trailingStopPct: 19,
    hardStopLossPct: -30,
    tiers: [
      { profitPct: 40, sellPct: 35 },
      { profitPct: 80, sellPct: 30 },
    ],
  },
  migration: {
    riskPercentPerTrade: 2.0,
    trailingStopPct: 23,
    hardStopLossPct: -34,
    sizeMultiplier: 1.2,
    tiers: [
      { profitPct: 40, sellPct: 35 },
      { profitPct: 80, sellPct: 30 },
    ],
  },
};

export interface TradeConfig {
  /**
   * Base SOL per copy trade before risk/conviction scaling.
   * Alias: tradeAmountSol (kept in sync for older dashboard/API clients).
   */
  baseTradeAmountSol: number;
  /** Same as baseTradeAmountSol — preferred legacy name */
  tradeAmountSol: number;
  /**
   * Hard ceiling on final entry size (SOL) after all sizing math
   * (risk/conviction/profile/concurrent). Clamps — does not reject.
   * Persists across Risk On/Off (not overwritten by presets).
   */
  maxAllowedTradeSol: number;
  /**
   * Floor size multiplier applied at max risk score (e.g. 0.4 = 40% of base).
   * Lower = smaller positions on high-risk tokens.
   */
  riskMultiplier: number;
  /**
   * Ceiling size multiplier at max conviction (e.g. 1.5 = +50% on strong signals).
   * 1 = no conviction boost.
   */
  convictionMultiplier: number;
  /** Minimum take-profit % (bot picks random target in [min, max]) */
  minProfitPercent: number;
  maxProfitPercent: number;
  /** Stop-loss as negative % (e.g. -35 = sell at 35% loss) */
  stopLossPercent: number;
}

/** Default hard cap on final buy size (SOL). Above normal base×multipliers. */
export const DEFAULT_MAX_ALLOWED_TRADE_SOL = 1.5;

/** Advanced tiered profit-taking (recover initial → partial → trail + bag) */
export interface ProfitStrategyConfig {
  enabled: boolean;
  /** Profit % at which we sell enough to recover initial SOL (e.g. 100) */
  takeInitialPercent: number;
  /** Profit % that triggers the milestone partial sell (e.g. 80) */
  partialSellAt: number;
  /** % of *initial* tokens to sell at the partial milestone (e.g. 50) */
  partialSellPercent: number;
  /** Profit % that arms the trailing stop (e.g. 150) */
  trailingStopAfter: number;
  /** Trail distance from peak once armed (e.g. 25) */
  trailingStopPct: number;
  /** % of initial position to leave running after recover/partials (e.g. 30) */
  bagPercent: number;
  /** Tighten SL / arm trail earlier on high-risk tokens */
  riskBasedAdjustment: boolean;
  /** Risk score at/above which adjustments apply (0–100) */
  highRiskScoreThreshold: number;
}

/** Defaults match Medium risk preset (recommended). */
export const DEFAULT_PROFIT_STRATEGY: ProfitStrategyConfig = {
  enabled: true,
  takeInitialPercent: 95,
  partialSellAt: 55,
  partialSellPercent: 42,
  trailingStopAfter: 110,
  trailingStopPct: 21,
  bagPercent: 28,
  riskBasedAdjustment: true,
  highRiskScoreThreshold: 55,
};

/** Quick Scalper — short timed holds with fixed TP / tight SL */
export interface QuickScalperConfig {
  enabled: boolean;
  /** Hard hold limit in minutes (1 / 2 / 3) */
  timeLimitMinutes: 1 | 2 | 3;
  /** Fixed take-profit % */
  takeProfitPct: number;
  /** Tight stop-loss % (negative) */
  stopLossPct: number;
  /** Min volume USD for scalp entry */
  minVolumeUsd: number;
  /** Min recent buy volume USD (buy pressure); 0 = off */
  minBuyPressureUsd: number;
}

export const DEFAULT_QUICK_SCALPER: QuickScalperConfig = {
  enabled: false,
  timeLimitMinutes: 2,
  takeProfitPct: 35,
  stopLossPct: -12,
  minVolumeUsd: 8_000,
  minBuyPressureUsd: 500,
};

/** Micro-Scalper — 60–90s ultra-fast spikes */
export interface MicroScalperConfig {
  enabled: boolean;
  /** Hard hold limit in seconds (60–90) */
  timeLimitSeconds: number;
  takeProfitPct: number;
  stopLossPct: number;
  minVolumeUsd: number;
  minBuyPressureUsd: number;
}

export const DEFAULT_MICRO_SCALPER: MicroScalperConfig = {
  enabled: false,
  timeLimitSeconds: 75,
  takeProfitPct: 18,
  stopLossPct: -8,
  minVolumeUsd: 12_000,
  minBuyPressureUsd: 800,
};

/** Momentum Burst — timed momentum holds with fade exit */
export interface MomentumBurstConfig {
  enabled: boolean;
  /** Hold limit in seconds (preferred; supports fractional-minute windows). */
  timeLimitSeconds: number;
  /** @deprecated legacy minutes — converted to seconds if seconds missing */
  timeLimitMinutes?: 2 | 3 | 4;
  takeProfitPct: number;
  stopLossPct: number;
  minVolumeUsd: number;
  minBuyPressureUsd: number;
  /** Exit if price drops this % from peak before TP */
  momentumFailDropPct: number;
}

export const DEFAULT_MOMENTUM_BURST: MomentumBurstConfig = {
  enabled: false,
  timeLimitSeconds: 180,
  timeLimitMinutes: 3,
  takeProfitPct: 32,
  stopLossPct: -12,
  minVolumeUsd: 15_000,
  minBuyPressureUsd: 1_200,
  /** Tighter fade so burst dies before the flat timer dump */
  momentumFailDropPct: 6,
};

/** Post-Migration Scalp — fresh migrations only (90s–3m) */
export interface PostMigrationScalpConfig {
  enabled: boolean;
  /** Hold limit in seconds (90–180). Preferred. */
  timeLimitSeconds: number;
  /** @deprecated legacy minutes — converted to seconds if seconds missing */
  timeLimitMinutes?: 1 | 2 | 3 | 4;
  takeProfitPct: number;
  stopLossPct: number;
  minVolumeUsd: number;
  minBuyPressureUsd: number;
}

export const DEFAULT_POST_MIGRATION_SCALP: PostMigrationScalpConfig = {
  enabled: false,
  timeLimitSeconds: 120,
  takeProfitPct: 30,
  stopLossPct: -11,
  minVolumeUsd: 10_000,
  minBuyPressureUsd: 600,
};

/** Reversal Scalp — mean-reversion on sharp wicks (60–150s) */
export interface ReversalScalpConfig {
  enabled: boolean;
  /** Hold limit in seconds (60–150). Preferred. */
  timeLimitSeconds: number;
  /** @deprecated legacy minutes */
  timeLimitMinutes?: 1 | 2 | 3 | 4 | 5;
  takeProfitPct: number;
  stopLossPct: number;
  minVolumeUsd: number;
  minBuyPressureUsd: number;
  /** Min drop from recent peak % to qualify (wick / over-extension) */
  minDropFromPeakPct: number;
  /** Min conviction for selective entries */
  minConvictionScore: number;
}

export const DEFAULT_REVERSAL_SCALP: ReversalScalpConfig = {
  enabled: false,
  timeLimitSeconds: 90,
  takeProfitPct: 22,
  stopLossPct: -9,
  minVolumeUsd: 8_000,
  minBuyPressureUsd: 400,
  minDropFromPeakPct: 32,
  minConvictionScore: 52,
};

/**
 * Post-Run Dip / Rotation — higher-timeframe dip buy after a strong early run.
 * Longer holds than scalps; uses Fib/support + session awareness.
 * Profiles: Standard | Conservative Post-Run Dip | Aggressive Post-Run Dip.
 */
export type PostRunDipProfile = 'standard' | 'conservative' | 'aggressive';

export interface PostRunDipConfig {
  enabled: boolean;
  /** Active Post-Run Dip profile label */
  profile: PostRunDipProfile;
  sensitivity: 'low' | 'medium' | 'high';
  /** Max hold minutes before timer exit (Standard hold ~90m) */
  timeLimitMinutes: number;
  /**
   * Max minutes to wait for a dip setup after the run/peak
   * (Standard band 45–90, default 60).
   */
  setupWatchMinutes: number;
  takeProfitPct: number;
  /** Negative stop / soft invalidation % */
  stopLossPct: number;
  /** Min estimated run % (Standard band 80–150, default 80) */
  minRunPct: number;
  /** Soft max run % — prefer setups in the Standard band */
  maxRunPct: number;
  /** Min pullback % from swing high to qualify as a dip */
  minDipFromPeakPct: number;
  /** Max pullback % (avoid knives) */
  maxDipFromPeakPct: number;
  /** Run age window hours (Standard 12–24) */
  minTokenAgeHours: number;
  maxTokenAgeHours: number;
  preferNearTechnicals: boolean;
  requireNearTechnicals: boolean;
  /** Preferred Fib ratios for dip (default 0.5, 0.618) */
  preferredFibLevels: number[];
  /** Soft prefer smart money — boost, do not hard-require */
  preferSmartMoney: boolean;
  /** Conservative: larger score penalty / higher bar without SM */
  stronglyPreferSmartMoney: boolean;
  requireSmartMoney: boolean;
  /** When true, only take trades that qualify as post-run dip setups */
  hardRequireSetup: boolean;
  minVolumeUsd: number;
  /** Strategy-local liquidity floor (Standard $8k–$12k, default $10k) */
  minLiquidityUsd: number;
  /** Strategy-local holder floor (Standard 60+) */
  minHolders: number;
  /**
   * Conviction boost when setup qualifies (Standard +10–20,
   * extra when near key Fib/S + volume confirmation).
   */
  boostPoints: number;
  /** Max boost cap */
  boostPointsMax: number;
  /** Proximity % to Fib/support (Standard ±2–3, default 2.5) */
  nearTechnicalPct: number;
  /** Exit on clear break below Fib/support zone */
  invalidateOnZoneBreak: boolean;
  /** Require elevated volume with zone-break invalidation */
  invalidateRequireVolume: boolean;
  /** Require clear volume dry-up then return (Conservative) */
  requireClearVolumeDryUp: boolean;
  /** Aggressive: floor / soft interest enough — skip strict dry-up pattern */
  flexibleVolumeConfirmation: boolean;
  /** Prefer / require peak US + overlap sessions */
  preferredSessions: string[];
  /** When true, setups outside preferred sessions do not qualify */
  requirePreferredSession: boolean;
  /** Extra score gate overlay (Conservative raises / Aggressive lowers) */
  minQualifyScore: number;
  /**
   * Dip-phase smart wallet confirmation sensitivity
   * (HQ buys, buybacks, Fib cluster, net flow).
   */
  smartWalletDipSensitivity: 'low' | 'medium' | 'high';
  /** Max conviction boost from dip smart-wallet confirmation */
  smartWalletDipBoostPoints: number;
  /**
   * Conservative: when true, require active dip SM to qualify
   * (optional hard requirement — default off).
   */
  hardRequireSmartMoneyInConservative: boolean;
}

export const DEFAULT_POST_RUN_DIP: PostRunDipConfig = {
  enabled: false,
  profile: 'standard',
  sensitivity: 'medium',
  timeLimitMinutes: 90,
  setupWatchMinutes: 60,
  takeProfitPct: 35,
  stopLossPct: -14,
  minRunPct: 80,
  maxRunPct: 150,
  minDipFromPeakPct: 25,
  maxDipFromPeakPct: 65,
  minTokenAgeHours: 12,
  maxTokenAgeHours: 24,
  preferNearTechnicals: true,
  requireNearTechnicals: false,
  preferredFibLevels: [0.5, 0.618],
  preferSmartMoney: true,
  stronglyPreferSmartMoney: false,
  requireSmartMoney: false,
  hardRequireSetup: false,
  minVolumeUsd: 5_000,
  minLiquidityUsd: 10_000,
  minHolders: 60,
  boostPoints: 12,
  boostPointsMax: 20,
  nearTechnicalPct: 2.5,
  invalidateOnZoneBreak: true,
  invalidateRequireVolume: true,
  requireClearVolumeDryUp: false,
  flexibleVolumeConfirmation: false,
  preferredSessions: ['us', 'europe_us'],
  requirePreferredSession: false,
  minQualifyScore: 55,
  smartWalletDipSensitivity: 'medium',
  smartWalletDipBoostPoints: 8,
  hardRequireSmartMoneyInConservative: false,
};

/**
 * Conservative Post-Run Dip — higher quality, fewer trades.
 * Stricter run/age/Fib distance, liq/holders, volume, session, invalidation.
 */
export const CONSERVATIVE_POST_RUN_DIP: PostRunDipConfig = {
  ...DEFAULT_POST_RUN_DIP,
  profile: 'conservative',
  sensitivity: 'high',
  timeLimitMinutes: 55,
  setupWatchMinutes: 45,
  takeProfitPct: 32,
  stopLossPct: -10,
  minRunPct: 120,
  maxRunPct: 400,
  minDipFromPeakPct: 28,
  maxDipFromPeakPct: 55,
  minTokenAgeHours: 8,
  maxTokenAgeHours: 18,
  preferNearTechnicals: true,
  requireNearTechnicals: true,
  preferredFibLevels: [0.5, 0.618],
  preferSmartMoney: true,
  stronglyPreferSmartMoney: true,
  requireSmartMoney: false,
  hardRequireSetup: false,
  minVolumeUsd: 8_000,
  minLiquidityUsd: 12_000,
  minHolders: 80,
  boostPoints: 15,
  boostPointsMax: 20,
  nearTechnicalPct: 1.75,
  invalidateOnZoneBreak: true,
  /** Faster invalidation — don't wait for volume confirmation */
  invalidateRequireVolume: false,
  requireClearVolumeDryUp: true,
  flexibleVolumeConfirmation: false,
  preferredSessions: ['us', 'europe_us'],
  requirePreferredSession: true,
  minQualifyScore: 72,
  smartWalletDipSensitivity: 'high',
  smartWalletDipBoostPoints: 10,
  /** Optional — enable in UI for Conservative hard SM gate */
  hardRequireSmartMoneyInConservative: false,
};

/**
 * Aggressive Post-Run Dip — more opportunities, looser thresholds.
 * Softer run/age/Fib distance, liq/holders, flexible volume, SM optional.
 */
export const AGGRESSIVE_POST_RUN_DIP: PostRunDipConfig = {
  ...DEFAULT_POST_RUN_DIP,
  profile: 'aggressive',
  sensitivity: 'low',
  timeLimitMinutes: 120,
  setupWatchMinutes: 90,
  takeProfitPct: 38,
  stopLossPct: -16,
  minRunPct: 60,
  maxRunPct: 100,
  minDipFromPeakPct: 18,
  maxDipFromPeakPct: 70,
  minTokenAgeHours: 6,
  maxTokenAgeHours: 36,
  preferNearTechnicals: true,
  requireNearTechnicals: false,
  preferredFibLevels: [0.382, 0.5, 0.618],
  preferSmartMoney: false,
  stronglyPreferSmartMoney: false,
  requireSmartMoney: false,
  hardRequireSetup: false,
  minVolumeUsd: 3_000,
  minLiquidityUsd: 6_500,
  minHolders: 40,
  boostPoints: 10,
  boostPointsMax: 18,
  nearTechnicalPct: 3.5,
  invalidateOnZoneBreak: true,
  /** More patient — wait for volume on zone break */
  invalidateRequireVolume: true,
  requireClearVolumeDryUp: false,
  flexibleVolumeConfirmation: true,
  preferredSessions: ['asia', 'europe', 'us', 'asia_europe', 'europe_us'],
  requirePreferredSession: false,
  minQualifyScore: 45,
  smartWalletDipSensitivity: 'low',
  smartWalletDipBoostPoints: 5,
  hardRequireSmartMoneyInConservative: false,
};

export const POST_RUN_DIP_PROFILE_LABEL: Record<PostRunDipProfile, string> = {
  standard: 'Standard (Recommended)',
  conservative: 'Conservative Post-Run Dip',
  aggressive: 'Aggressive Post-Run Dip',
};

/** Fibonacci + Support/Resistance module settings (Pump.fun–optimised defaults) */
export interface TechnicalLevelsConfig {
  enabled: boolean;
  sensitivity: 'low' | 'medium' | 'high';
  /**
   * Fib lookback hours (Pump.fun default band 2–6h).
   * Preferred over lookbackBars when ticks have timestamps.
   */
  lookbackHours: number;
  /** Min / max clamp for Fib lookbackHours */
  lookbackHoursMin: number;
  lookbackHoursMax: number;
  /** Bars / ticks cap when history is dense (secondary) */
  lookbackBars: number;
  /** Pivot half-window for swing detection */
  pivotWindow: number;
  /**
   * Cluster nearby swings / zone half-width ±% (S&R zone width).
   * Pump.fun default ±2%.
   */
  clusterPct: number;
  /** Alias kept in sync with clusterPct — zone width ±% */
  zoneWidthPct: number;
  /** Entry tolerance ±% for “near” Fib / support (default 2) */
  nearPct: number;
  /** Min impulse run % to use a swing for Fib (default 50 = strong pump) */
  minImpulsePct: number;
  /** Prefer most recent qualifying pump over older larger ones */
  preferRecentImpulse: boolean;
  /** Min touches for a valid S/R level (Pump.fun default 2) */
  minTouchesForValid: number;
  /** Min touches to treat support as strong (boost) */
  minTouchesForStrong: number;
  maxHistoryPoints: number;
  /** Primary Fib ratios for dip buys (default 0.5, 0.618) */
  prioritizeFibLevels: number[];
  /** Secondary Fib ratios (default 0.382, 0.786) */
  secondaryFibLevels: number[];
  /** When true with strategy ON, block entries not near Fib/support */
  hardFilter: boolean;

  // ── Support & Resistance (Pump.fun defaults) ──────────────────────────
  /** S&R lookback hours (preferred band 1–4h, absolute max 6) */
  srLookbackHours: number;
  srLookbackHoursMin: number;
  srLookbackHoursMax: number;
  /** Absolute hard cap on S&R lookback (default 6) */
  srLookbackHoursHardMax: number;
  /** Required swing strength for pivots used in S&R */
  swingStrength: 'low' | 'medium' | 'high';
  /** Prefer most recent strong supports when ranking */
  preferRecentSupport: boolean;
  /** Favour levels that showed a bounce / volume reaction */
  favourVolumeReaction: boolean;
  /** Invalidate level after clear break + close beyond the zone */
  requireBreakCloseInvalidation: boolean;
  /**
   * Treat Fib levels as price zones (±nearPct / entry tolerance),
   * not single tick prices. Pump.fun default: true.
   */
  fibTreatAsZones: boolean;
}

export const DEFAULT_TECHNICAL_LEVELS: TechnicalLevelsConfig = {
  enabled: false,
  sensitivity: 'medium',
  lookbackHours: 4,
  lookbackHoursMin: 2,
  lookbackHoursMax: 6,
  lookbackBars: 96,
  pivotWindow: 2,
  clusterPct: 2,
  zoneWidthPct: 2,
  nearPct: 2,
  minImpulsePct: 50,
  preferRecentImpulse: true,
  minTouchesForValid: 2,
  minTouchesForStrong: 2,
  maxHistoryPoints: 240,
  prioritizeFibLevels: [0.5, 0.618],
  secondaryFibLevels: [0.382, 0.786],
  hardFilter: false,
  srLookbackHours: 2,
  srLookbackHoursMin: 1,
  srLookbackHoursMax: 4,
  srLookbackHoursHardMax: 6,
  swingStrength: 'medium',
  preferRecentSupport: true,
  favourVolumeReaction: true,
  requireBreakCloseInvalidation: true,
  fibTreatAsZones: true,
};

/** Chart pattern recognition (entry + confirmation). Default OFF. */
export type ChartPatternId =
  | 'falling_wedge'
  | 'ascending_triangle'
  | 'descending_triangle'
  | 'trend_continuation'
  | 'structured_pullback'
  | 'trendline_break'
  | 'volume_dryup_return'
  | 'holder_distribution'
  | 'capitulation'
  | 'bull_flag';

export interface ChartPatternToggle {
  enabled: boolean;
}

export interface ChartPatternsConfig {
  enabled: boolean;
  sensitivity: 'low' | 'medium' | 'high';
  /** How patterns affect entries: confirmation only, entry signal, or both */
  mode: 'confirm' | 'entry' | 'both';
  lookbackBars: number;
  minConfidence: number;
  breakoutPct: number;
  pullbackNearPct: number;
  minPoleRunPct: number;
  maxFlagRangePct: number;
  minStructuredDropPct: number;
  maxStructuredDropPct: number;
  volumeDryupRatio: number;
  volumeReturnRatio: number;
  holderDropPct: number;
  capitulationDropPct: number;
  bearishPenalty: number;
  /** Require at least one bullish pattern when strategy ON */
  hardFilter: boolean;
  /** Skip when strong bearish pattern fires */
  blockOnBearish: boolean;
  patterns: Record<ChartPatternId, ChartPatternToggle>;
}

export const DEFAULT_CHART_PATTERNS: ChartPatternsConfig = {
  enabled: false,
  sensitivity: 'medium',
  mode: 'both',
  lookbackBars: 64,
  minConfidence: 55,
  breakoutPct: 1.2,
  pullbackNearPct: 3,
  minPoleRunPct: 25,
  maxFlagRangePct: 18,
  minStructuredDropPct: 8,
  maxStructuredDropPct: 35,
  volumeDryupRatio: 0.55,
  volumeReturnRatio: 1.35,
  holderDropPct: 8,
  capitulationDropPct: 28,
  bearishPenalty: 6,
  hardFilter: false,
  blockOnBearish: false,
  patterns: {
    falling_wedge: { enabled: true },
    ascending_triangle: { enabled: false },
    descending_triangle: { enabled: false },
    trend_continuation: { enabled: true },
    structured_pullback: { enabled: true },
    trendline_break: { enabled: false },
    volume_dryup_return: { enabled: true },
    holder_distribution: { enabled: false },
    capitulation: { enabled: false },
    bull_flag: { enabled: true },
  },
};

/** Recommended param band (Strategies UI + clamp on save). */
export type ScalpParamBand = { min: number; max: number; default: number };

export type ScalpStrategyRanges = {
  micro_scalper: {
    timerSec: ScalpParamBand;
    takeProfitPct: ScalpParamBand;
    stopLossAbs: ScalpParamBand;
  };
  momentum_burst: {
    timerSec: ScalpParamBand;
    takeProfitPct: ScalpParamBand;
    stopLossAbs: ScalpParamBand;
  };
  post_migration_scalp: {
    timerSec: ScalpParamBand;
    takeProfitPct: ScalpParamBand;
    stopLossAbs: ScalpParamBand;
  };
  reversal_scalp: {
    timerSec: ScalpParamBand;
    takeProfitPct: ScalpParamBand;
    stopLossAbs: ScalpParamBand;
  };
};

export type ScalperSuiteVariantId =
  | 'standard'
  | 'aggressive'
  | 'conservative';

/** Standard Scalper Suite ranges (default recipe). */
export const SCALP_PARAM_RANGES_STANDARD: ScalpStrategyRanges = {
  micro_scalper: {
    timerSec: { min: 60, max: 90, default: 75 },
    takeProfitPct: { min: 15, max: 22, default: 18 },
    stopLossAbs: { min: 6, max: 10, default: 8 },
  },
  momentum_burst: {
    timerSec: { min: 140, max: 360, default: 210 },
    takeProfitPct: { min: 28, max: 45, default: 32 },
    stopLossAbs: { min: 10, max: 14, default: 12 },
  },
  post_migration_scalp: {
    timerSec: { min: 90, max: 360, default: 180 },
    takeProfitPct: { min: 25, max: 45, default: 30 },
    stopLossAbs: { min: 9, max: 15, default: 11 },
  },
  reversal_scalp: {
    timerSec: { min: 60, max: 150, default: 90 },
    takeProfitPct: { min: 18, max: 28, default: 22 },
    stopLossAbs: { min: 7, max: 11, default: 9 },
  },
};

/** Aggressive Scalper — faster timers, higher TP/SL, looser volume. */
export const SCALP_PARAM_RANGES_AGGRESSIVE: ScalpStrategyRanges = {
  micro_scalper: {
    timerSec: { min: 45, max: 75, default: 60 },
    takeProfitPct: { min: 18, max: 28, default: 23 },
    stopLossAbs: { min: 8, max: 12, default: 10 },
  },
  momentum_burst: {
    timerSec: { min: 90, max: 300, default: 160 },
    takeProfitPct: { min: 35, max: 50, default: 42 },
    stopLossAbs: { min: 12, max: 16, default: 14 },
  },
  post_migration_scalp: {
    timerSec: { min: 60, max: 300, default: 140 },
    takeProfitPct: { min: 30, max: 45, default: 37 },
    stopLossAbs: { min: 11, max: 15, default: 13 },
  },
  reversal_scalp: {
    timerSec: { min: 45, max: 90, default: 68 },
    takeProfitPct: { min: 22, max: 32, default: 27 },
    stopLossAbs: { min: 9, max: 13, default: 11 },
  },
};

/** Conservative Scalper — slower timers, tighter TP/SL, stricter filters. */
export const SCALP_PARAM_RANGES_CONSERVATIVE: ScalpStrategyRanges = {
  micro_scalper: {
    timerSec: { min: 70, max: 100, default: 85 },
    takeProfitPct: { min: 12, max: 18, default: 15 },
    stopLossAbs: { min: 5, max: 8, default: 6 },
  },
  momentum_burst: {
    timerSec: { min: 150, max: 360, default: 220 },
    takeProfitPct: { min: 22, max: 32, default: 27 },
    stopLossAbs: { min: 8, max: 11, default: 9 },
  },
  post_migration_scalp: {
    timerSec: { min: 90, max: 300, default: 180 },
    takeProfitPct: { min: 20, max: 30, default: 25 },
    stopLossAbs: { min: 7, max: 10, default: 8 },
  },
  reversal_scalp: {
    timerSec: { min: 60, max: 120, default: 90 },
    takeProfitPct: { min: 15, max: 22, default: 18 },
    stopLossAbs: { min: 6, max: 9, default: 7 },
  },
};

/** Alias for Standard ranges (legacy imports). Prefer getActiveScalpParamRanges(). */
export const SCALP_PARAM_RANGES = SCALP_PARAM_RANGES_STANDARD;

export function getScalperSuiteVariantFromProfile(
  profile?: string | null
): ScalperSuiteVariantId | null {
  if (profile === 'scalper_suite') return 'standard';
  if (profile === 'aggressive_scalper') return 'aggressive';
  if (profile === 'conservative_scalper') return 'conservative';
  return null;
}

export function isScalperSuiteProfile(
  profile?: string | null
): boolean {
  return getScalperSuiteVariantFromProfile(profile) != null;
}

/** Variant-aware clamp ranges for UI + save. Falls back to Standard. */
export function getActiveScalpParamRanges(
  profile?: string | null
): ScalpStrategyRanges {
  const v = getScalperSuiteVariantFromProfile(
    profile ?? config.strategyProfile
  );
  if (v === 'aggressive') return SCALP_PARAM_RANGES_AGGRESSIVE;
  if (v === 'conservative') return SCALP_PARAM_RANGES_CONSERVATIVE;
  return SCALP_PARAM_RANGES_STANDARD;
}

export function getScalperSuiteVariantLabel(
  profileOrVariant?: string | null
): string {
  const v =
    profileOrVariant === 'standard' ||
    profileOrVariant === 'aggressive' ||
    profileOrVariant === 'conservative'
      ? profileOrVariant
      : getScalperSuiteVariantFromProfile(profileOrVariant);
  if (v === 'aggressive') return 'Aggressive Scalper';
  if (v === 'conservative') return 'Conservative Scalper';
  if (v === 'standard') return 'Scalper Suite (Standard)';
  return 'Scalper Suite';
}

/** Selective entry gating — high-conviction setups only */
export interface SelectiveTradingConfig {
  enabled: boolean;
  /** Minimum conviction score 0–100 to execute */
  minConvictionScore: number;
  /** Block single-wallet entries unless migration/near-migration priority */
  requireConvergenceForNormal: boolean;
  /** Allow 1-wallet buys on migration / near-migration events */
  allowSingleWalletMigration: boolean;
  /** Floor on distinct smart wallets (before convergenceRequired) */
  minWalletsForTrade: number;
  /** Min 24h volume USD (also checked in anti-rug when set on filters) */
  minVolume24hUsd: number;
  /** Min holder count from Birdeye/metrics */
  minHolderCount: number;
  /** Max buys per rolling hour (0 = unlimited) */
  maxTradesPerHour: number;
  /** Min ms between any two buys */
  minMsBetweenTrades: number;
  /** Risk score at/above which position size scales down */
  riskScoreSizeCutoff: number;
  /** Size multiplier at maxRiskScore (e.g. 0.3 = 30% of normal) */
  minRiskSizeMultiplier: number;
  /** Extra wallets required when risk score is high */
  extraConvergenceAboveRisk: number;
  /** Risk score threshold for extra convergence requirement */
  highRiskConvergenceThreshold: number;
}

/** Defaults match Medium risk preset (recommended). */
export const DEFAULT_SELECTIVE: SelectiveTradingConfig = {
  enabled: true,
  minConvictionScore: 40,
  requireConvergenceForNormal: true,
  allowSingleWalletMigration: true,
  minWalletsForTrade: 2,
  minVolume24hUsd: 25_000,
  minHolderCount: 120,
  maxTradesPerHour: 16,
  minMsBetweenTrades: 25_000,
  riskScoreSizeCutoff: 50,
  minRiskSizeMultiplier: 0.4,
  extraConvergenceAboveRisk: 1,
  highRiskConvergenceThreshold: 60,
};

/**
 * Recommended parameter packs applied when the user picks a risk level.
 * Covers trade sizing, filters, risk engine, selective gating, and profit strategy.
 */
export interface RiskLevelPreset {
  label: string;
  description: string;
  warning?: string;
  trade: Partial<TradeConfig>;
  filters: Partial<FilterConfig>;
  risk: Partial<RiskConfig> & {
    normal?: Partial<StrategyRiskRules>;
    migration?: Partial<StrategyRiskRules>;
  };
  selective: Partial<SelectiveTradingConfig>;
  profitStrategy: Partial<ProfitStrategyConfig>;
  strategy: Partial<StrategyConfig>;
  /** Optional bonding-curve gate overrides (e.g. requireHealthyCurve) */
  bondingCurve?: Partial<{
    requireHealthyCurve: boolean;
    requireRecentCurveActivity: boolean;
  }>;
}

export const RISK_LEVEL_PRESETS: Record<RiskLevel, RiskLevelPreset> = {
  on: {
    label: 'On',
    description:
      'Lean baseline — hard floors + Smart Money Copy / Market Scanner. Quality, conviction, and scalp modules stay OFF until you enable them.',
    trade: {
      baseTradeAmountSol: 0.06,
      tradeAmountSol: 0.06,
      riskMultiplier: 0.45,
      convictionMultiplier: 1.5,
      minProfitPercent: 42,
      maxProfitPercent: 1000,
      stopLossPercent: -30,
    },
    filters: {
      minLiquidity: 10_000,
      minMarketCapUsd: 8_000,
      minDevHoldPct: 0,
      maxDevHoldPct: 14,
      maxDevPercent: 14,
      minTopHolderPct: 0,
      maxTopHolderPct: 70,
      maxHolderConcentration: 70,
      minTop10HolderPct: 8,
      minEstimatedTaxPct: 0,
      maxEstimatedTaxPct: 24,
      minRiskScore: 0,
      maxRiskScore: 78,
      skipIfMintAuthority: false,
      sniperSensitivity: 'medium',
      convergenceRequired: 2,
      maxConcurrentPositions: 24,
      dailyLossLimitSol: 2.5,
      minVolume24hUsd: 25_000,
      minRecentVolumeUsd: 2_500,
      minRecentBuyVolumeUsd: 1_500,
      minHolderCount: 120,
      minHolders: 120,
      minRecentActivity: 10,
      maxEntryAgeMinutes: 15,
      requireMomentumConfirmation: false,
      enableWalletQualityGate: false,
      minWalletQualityScore: 55,
      enableEntryTimingGate: false,
      clusterMinWallets: 2,
      enableAntiRug: false,
      checkHoneypot: false,
      enableSniperFilter: false,
      skipIfDevRecentSells: false,
    },
    risk: {
      riskPercentPerTrade: 1.0,
      maxTradeSol: 0.35,
      minTradeSol: 0.02,
      weeklyLossLimitSol: 5,
      maxDrawdownPct: 22,
      trailingStopPct: 19,
      trailingStopPercent: 19,
      trailingActivationProfit: 22,
      deadVolumeUsdPerHour: 50,
      deadVolumeConsecutiveHours: 2,
      deadVolumeMinHoldMinutes: 12,
      lowConvictionTrailThreshold: 50,
      lowConvictionTrailTightenPct: 6,
      normal: {
        riskPercentPerTrade: 1.0,
        trailingStopPct: 19,
        hardStopLossPct: -30,
        tiers: [
          { profitPct: 42, sellPct: 40 },
          { profitPct: 80, sellPct: 30 },
        ],
      },
      migration: {
        riskPercentPerTrade: 1.2,
        trailingStopPct: 21,
        hardStopLossPct: -34,
        sizeMultiplier: 1.2,
        tiers: [
          { profitPct: 42, sellPct: 40 },
          { profitPct: 80, sellPct: 30 },
        ],
      },
    },
    selective: {
      enabled: false,
      minConvictionScore: 32,
      requireConvergenceForNormal: false,
      allowSingleWalletMigration: true,
      minWalletsForTrade: 2,
      minVolume24hUsd: 25_000,
      minHolderCount: 120,
      maxTradesPerHour: 16,
      minMsBetweenTrades: 25_000,
      riskScoreSizeCutoff: 50,
      minRiskSizeMultiplier: 0.4,
      extraConvergenceAboveRisk: 1,
      highRiskConvergenceThreshold: 60,
    },
    profitStrategy: {
      takeInitialPercent: 90,
      partialSellAt: 50,
      partialSellPercent: 42,
      trailingStopAfter: 110,
      trailingStopPct: 20,
      bagPercent: 28,
      riskBasedAdjustment: true,
      highRiskScoreThreshold: 70,
    },
    strategy: {
      enableMigrationOnly: false,
      migrationSizeMultiplier: 1.55,
      confirmationThreshold: 2,
      reBuyMinProfitPct: 90,
      postStopReentryEnabled: true,
      reEntryMaxPerMint: 2,
      reEntryWatchMinutes: 90,
      reEntryMinReclaimPct: 8,
      reEntryMinVolumeIncreasePct: 50,
      reEntryConfirmationWallets: 2,
      reEntrySizeMultiplier: 0.65,
      reEntryCooldownMinutes: 8,
      reEntryAfterMaxProfitEnabled: false,
    },
  },
  off: {
    label: 'Off',
    description:
      'Entry engines only — Smart Money Copy + Market Scanner. No risk-linked modules, selective gates, or hard liq/volume/MC floors.',
    warning: OFF_RISK_WARNING,
    trade: {
      baseTradeAmountSol: 0.05,
      tradeAmountSol: 0.05,
      riskMultiplier: 0.55,
      convictionMultiplier: 1.5,
      minProfitPercent: 35,
      maxProfitPercent: 200,
      stopLossPercent: -40,
    },
    filters: {
      minLiquidity: 0,
      minMarketCapUsd: 0,
      minDevHoldPct: 0,
      maxDevHoldPct: 0,
      maxDevPercent: 0,
      minTopHolderPct: 0,
      maxTopHolderPct: 0,
      maxHolderConcentration: 0,
      minTop10HolderPct: 0,
      minEstimatedTaxPct: 0,
      maxEstimatedTaxPct: 100,
      minRiskScore: 0,
      maxRiskScore: 100,
      skipIfMintAuthority: false,
      sniperSensitivity: 'low',
      convergenceRequired: 1,
      maxConcurrentPositions: 40,
      dailyLossLimitSol: 12,
      minVolume24hUsd: 0,
      minRecentVolumeUsd: 0,
      minRecentBuyVolumeUsd: 0,
      minHolderCount: 0,
      minHolders: 0,
      minRecentActivity: 0,
      requireLiquidityLocked: false,
      checkHoneypot: false,
      skipIfDevRecentSells: false,
      enableAntiRug: false,
      enableSniperFilter: false,
      clusterMinWallets: 1,
      enableWalletQualityGate: false,
      minWalletQualityScore: 0,
      maxEntryAgeMinutes: 0,
      requireMomentumConfirmation: false,
      enableEntryTimingGate: false,
    },
    risk: {
      enabled: true,
      useRiskSizing: true,
      riskPercentPerTrade: 1.2,
      maxTradeSol: 0.25,
      minTradeSol: 0.02,
      weeklyLossLimitSol: 15,
      maxDrawdownPct: 55,
      trailingStopPct: 28,
      trailingStopPercent: 28,
      trailingActivationProfit: 30,
      deadVolumeUsdPerHour: 40,
      deadVolumeConsecutiveHours: 2,
      deadVolumeMinHoldMinutes: 10,
      lowConvictionTrailThreshold: 35,
      lowConvictionTrailTightenPct: 4,
      normal: {
        riskPercentPerTrade: 1.2,
        trailingStopPct: 28,
        hardStopLossPct: -40,
        tiers: [
          { profitPct: 50, sellPct: 35 },
          { profitPct: 100, sellPct: 30 },
        ],
      },
      migration: {
        riskPercentPerTrade: 1.5,
        trailingStopPct: 30,
        hardStopLossPct: -45,
        sizeMultiplier: 1.2,
        tiers: [
          { profitPct: 50, sellPct: 35 },
          { profitPct: 100, sellPct: 30 },
        ],
      },
    },
    selective: {
      enabled: false,
      minConvictionScore: 0,
      requireConvergenceForNormal: false,
      allowSingleWalletMigration: true,
      minWalletsForTrade: 1,
      minVolume24hUsd: 0,
      minHolderCount: 0,
      maxTradesPerHour: 40,
      minMsBetweenTrades: 5_000,
      riskScoreSizeCutoff: 100,
      minRiskSizeMultiplier: 0.8,
      extraConvergenceAboveRisk: 0,
      highRiskConvergenceThreshold: 100,
    },
    profitStrategy: {
      takeInitialPercent: 120,
      partialSellAt: 70,
      partialSellPercent: 35,
      trailingStopAfter: 150,
      trailingStopPct: 30,
      bagPercent: 40,
      riskBasedAdjustment: false,
      highRiskScoreThreshold: 90,
    },
    strategy: {
      enableMigrationOnly: false,
      migrationSizeMultiplier: 1.8,
      confirmationThreshold: 1,
      reBuyMinProfitPct: 40,
      postStopReentryEnabled: false,
      reEntryMaxPerMint: 2,
      reEntryWatchMinutes: 90,
      reEntryMinReclaimPct: 3,
      reEntryMinVolumeIncreasePct: 20,
      reEntryConfirmationWallets: 1,
      reEntrySizeMultiplier: 0.9,
      reEntryCooldownMinutes: 3,
      reEntryAfterMaxProfitEnabled: false,
    },
    bondingCurve: {
      requireHealthyCurve: false,
      requireRecentCurveActivity: false,
    },
  },
};

export const HARD_FILTER_FLOORS = {
  /** Absolute min pool liquidity USD — Risk On cannot go below */
  minLiquidityUsd: 8_000,
  /**
   * Absolute min entry / buy market-cap USD — non-bypassable across all
   * risk levels (when floors active). Rejects post-dump ghosts under ~$8k MC.
   */
  minMarketCapUsd: 8_000,
  /**
   * MC below this + near-zero recent (h1) volume → hard reject combo
   * (catches thin post-selloff tokens that clear the $5k floor alone).
   */
  lowMcNearZeroVolumeComboUsd: 10_000,
  /** Dex h1 / m5 volume at/below this counts as near-zero for MC combo */
  nearZeroRecentVolumeUsd: 25,
  /** Absolute min 24h USD volume (mature / non-early entries) */
  minVolume24hUsd: 15_000,
  /** Absolute min DexScreener h1 total volume USD (15–60m proxy) */
  minRecentVolumeUsd: 1_500,
  /** Absolute min estimated recent buy-side volume USD */
  minRecentBuyVolumeUsd: 800,
  /** Absolute min holder count */
  minHolders: 30,
  /** Absolute min buys+sells in DexScreener h1 window */
  minRecentActivityTxns: 3,
  /** Holders at/below this + dead activity → hard reject */
  extremeLowHolders: 12,
  /**
   * Early pump / migration alternate path: use recent activity + these floors
   * instead of full 24h volume (brand-new launches often have low 24h vol).
   */
  earlyMinLiquidityUsd: 1_500,
  /** Soft 24h floor for early path when recent volume is missing */
  earlyMinVolume24hUsd: 1_000,
  /**
   * Early/migration recent (h1) volume floor — Dex often under-reports
   * brand-new grads; only near-zero stays a hard reject.
   */
  earlyMinRecentVolumeUsd: 150,
  /** Early/migration recent buy-side floor (soft unless near-zero) */
  earlyMinRecentBuyVolumeUsd: 75,
  /** Holder floor for early/migration when recent activity is healthy */
  earlyMinHolders: 12,
  /** Curve progress at/below this counts as "very low" when volume is dead */
  deadBondingCurveMaxPct: 12,
  /** Buy/sell volume ratio below this = heavily negative net flow */
  maxNegativeBuySellRatio: 0.5,
  /** 1h or 24h price change at/below this + negative net volume → reject */
  priceCrashPct: -35,
  /**
   * Absolute min top-10 holder concentration %.
   * Suspiciously dispersed holdings (<5%) are a common honeypot pattern.
   * Config default is stricter (8%); High cannot go below this floor.
   */
  minTop10HolderPct: 5,
  /**
   * Absolute max insider / rat / extreme-dev hold %.
   * Reject when insiderPct (or extreme dev hold) ≥ this — non-bypassable.
   */
  maxInsiderPct: 50,
  /**
   * Max Dex/Jupiter buy÷sell txn ratio (h1). Buy-heavy honeypots often show
   * hundreds of buys vs few sells. Requires minSellsForBuyHeavyGate sells.
   */
  maxBuySellTxnRatio: 15,
  /** Min sells in window before buy-heavy ratio gate applies */
  minSellsForBuyHeavyGate: 10,
  /**
   * Jupiter organicScore floor (0–100) when score is known.
   * Proxy for organic / pro-quality — Terminal Pro Traders % is not in the
   * Jupiter Tokens API. Unknown score does not hard-skip (early Pump often has no Jupiter card).
   */
  minOrganicScore: 30,
} as const;

export interface FilterConfig {
  /** Minimum wallet win-rate % to include in signals (0 = disabled) */
  minWinRate: number;
  /**
   * Minimum pool liquidity USD.
   * Clamped to HARD_FILTER_FLOORS.minLiquidityUsd ($8k). Recommended band $8k–$15k.
   */
  minLiquidity: number;
  /**
   * Minimum entry / buy market-cap USD.
   * Clamped to HARD_FILTER_FLOORS.minMarketCapUsd ($8k). Non-bypassable.
   */
  minMarketCapUsd: number;
  /**
   * Optional max entry / buy market-cap USD (0 = unlimited when Strict OFF).
   * Strict Mode always applies an intensity cap via effectiveMaxEntryMarketCapUsd().
   */
  maxEntryMarketCapUsd: number;
  /**
   * Min deployer hold % (pair with maxDevHoldPct). 0 = no floor.
   * Known values below min skip when gate active.
   */
  minDevHoldPct: number;
  /** Skip if estimated dev/authority hold % exceeds this (0 = disabled) */
  maxDevHoldPct: number;
  /** Preferred alias for maxDevHoldPct (anti-rug) */
  maxDevPercent: number;
  /**
   * Min single-wallet hold % (pair with maxTopHolderPct). 0 = no floor.
   * Independent of Top-10% band (minTop10HolderPct / maxHolderConcentration).
   */
  minTopHolderPct: number;
  /** Skip if largest single holder % exceeds this (0 = disabled) */
  maxTopHolderPct: number;
  /**
   * Max Top-10% holder concentration (pair with minTop10HolderPct).
   * 0 = disabled. Default 70. Independent of maxTopHolderPct (single wallet).
   * Known values above max hard-skip; unknown is soft-only.
   */
  maxHolderConcentration: number;
  /**
   * Min Top-10% holder concentration (honeypot dispersion floor).
   * Clamped to HARD_FILTER_FLOORS.minTop10HolderPct (5) when Risk On. Default 8.
   * Pair with maxHolderConcentration for a valid band (e.g. 8–70%).
   * Known values below min hard-skip; unknown is soft-only (does not block entry).
   */
  minTop10HolderPct: number;
  /** Master switch for comprehensive anti-rug checks */
  enableAntiRug: boolean;
  /** Require LP locked/burned (RugCheck / heuristics) */
  requireLiquidityLocked: boolean;
  /** Skip when recent token sells detected from dev wallet */
  skipIfDevRecentSells: boolean;
  /** Probe Jupiter buy→sell for honeypot / high tax */
  checkHoneypot: boolean;
  /**
   * Min estimated round-trip tax/loss % (pair with maxEstimatedTaxPct).
   * 0 = no floor.
   */
  minEstimatedTaxPct: number;
  /** Max estimated round-trip loss % before skip (tax/slip proxy) */
  maxEstimatedTaxPct: number;
  /**
   * Min composite risk score (pair with maxRiskScore). 0 = no floor.
   * Value must fall in [min, max] when gate active.
   */
  minRiskScore: number;
  /** Skip when composite risk score ≥ this (0–100) */
  maxRiskScore: number;
  /** Skip tokens that still have a mint authority */
  skipIfMintAuthority: boolean;
  /** Filter / score tokens with heavy GMGN sniper/bundler activity */
  enableSniperFilter: boolean;
  /** How strict sniper thresholds are */
  sniperSensitivity: 'low' | 'medium' | 'high';
  /**
   * Supporting social sentiment filter (not a primary signal).
   * When OFF or data unavailable, entries are unchanged (fail-open).
   */
  enableSocialSentimentFilter: boolean;
  /** How reactive social sentiment boost / skip is */
  socialSentimentSensitivity: 'low' | 'medium' | 'high';
  /**
   * Soft boost for tokens tied to hot narratives (confirmation only).
   * When OFF or data unavailable, entries are unchanged (fail-open).
   */
  enableTrendingNarrativeBoost: boolean;
  /** How strong the narrative conviction bump is */
  trendingNarrativeSensitivity: 'low' | 'medium' | 'high';
  /** Base conviction points added when a hot narrative matches (1–20) */
  trendingNarrativeBoostPoints: number;
  /** Optional extra theme → keywords map merged with built-ins */
  trendingNarrativeKeywords?: Record<string, string[]>;
  /**
   * Advanced volume spike filter (hard gate + soft boost).
   * When OFF or volume data unavailable, entries are unchanged (fail-open).
   */
  enableVolumeSpikeFilter: boolean;
  /** How strict hard skips / strong boosts are */
  volumeSpikeSensitivity: 'low' | 'medium' | 'high';
  /** Short-term window for surge / relative checks (minutes; 1–5 recommended) */
  volumeSpikeWindowMinutes: number;
  /** Short-term volume vs expected average multiplier (default 3×) */
  volumeSpikeMultiplier: number;
  /** Buy-side share % required for dominance (default 65) */
  volumeSpikeBuySidePct: number;
  /** Absolute minimum short-window volume USD floor (reject near-zero) */
  volumeSpikeMinUsd: number;
  /** Conviction points added on a strong spike (1–20) */
  volumeSpikeBoostPoints: number;
  /** When true, weak / below-floor volume can hard-block entries */
  volumeSpikeHardFilter: boolean;
  /**
   * Combined Volume + Sentiment + Narrative confirmation layer.
   * Soft boost when Strong+; optional hard filter when Weak.
   * Missing sentiment/narrative never blocks (fail-open).
   */
  enableConfirmationLayer: boolean;
  confirmationSensitivity: 'low' | 'medium' | 'high';
  /** Relative weight for volume spike component (usually highest) */
  confirmationVolumeWeight: number;
  confirmationSentimentWeight: number;
  confirmationNarrativeWeight: number;
  /** Base conviction points for Strong confirmation (1–22) */
  confirmationBoostPoints: number;
  /** When true, Very Weak confirmation can hard-block (volume data required) */
  confirmationHardFilter: boolean;
  /**
   * Market session filter — allow/block Asia, Europe, US, overlaps.
   * Preferred sessions get a soft conviction boost.
   */
  enableMarketSessionFilter: boolean;
  marketSessionAllowAsia: boolean;
  marketSessionAllowEurope: boolean;
  marketSessionAllowUs: boolean;
  marketSessionAllowOverlap: boolean;
  marketSessionAllowOffHours: boolean;
  /** Preferred session ids: asia, europe, us, asia_europe, europe_us, overlap */
  marketSessionPreferred: string[];
  marketSessionPreferBoostPoints: number;
  /** Mirror of postRunDip.enabled for filter API convenience */
  enablePostRunDip: boolean;
  postRunDipSensitivity: 'low' | 'medium' | 'high';
  /** Override max sniper wallet count (0 = use sensitivity default) */
  maxSniperCount: number;
  /** Override max bundler volume % (0 = use sensitivity default) */
  maxBundlerPct: number;
  /**
   * Override max insider/rat volume % for sniper sensitivity (0 = use sensitivity default).
   * Independent hard ceiling HARD_FILTER_FLOORS.maxInsiderPct (50) always applies.
   */
  maxInsiderPct: number;
  /** Override max sniper score 0–100 (0 = use sensitivity default) */
  maxSniperScore: number;
  /** Distinct wallets required for convergence signal */
  convergenceRequired: number;
  /** Max open positions at once */
  maxConcurrentPositions: number;
  /** Halt new trades after this daily loss in SOL */
  dailyLossLimitSol: number;
  /** Only copy wallets active within this many days */
  minActivityDays: number;
  /** Minimum on-chain txs in last 30 days to stay enabled */
  minTradesLast30d: number;
  /** Auto-disable / prune wallets that fail activity checks */
  enableActivityFilter: boolean;
  /**
   * Min 24h volume USD — clamped to HARD_FILTER_FLOORS ($15k+).
   */
  minVolume24hUsd: number;
  /**
   * Min DexScreener ~1h volume USD (recent activity proxy).
   * Clamped to HARD_FILTER_FLOORS.minRecentVolumeUsd.
   */
  minRecentVolumeUsd: number;
  /**
   * Min estimated recent buy-side volume USD (h1 buy share × volume).
   * Clamped to HARD_FILTER_FLOORS.minRecentBuyVolumeUsd.
   */
  minRecentBuyVolumeUsd: number;
  /** Min holder count — alias of minHolders (kept for older clients) */
  minHolderCount: number;
  /**
   * Preferred min holders (30–50+ recommended).
   * Clamped to HARD_FILTER_FLOORS.minHolders.
   */
  minHolders: number;
  /**
   * Min recent trades (DexScreener h1 buys+sells).
   * Clamped to HARD_FILTER_FLOORS.minRecentActivityTxns.
   */
  minRecentActivity: number;
  /**
   * When true, only open buys on Pump.fun mints whose address ends with `pump`
   * (case-sensitive). Hard floor — non-bypassable by soft-pass / early / Degen.
   */
  buyPumpFunOnly: boolean;

  // --- Wallet quality gate (Prompt 1) ---
  /** Skip copying wallets below minWalletQualityScore */
  enableWalletQualityGate: boolean;
  /** Minimum quality score 0–100 to allow copy (default 55) */
  minWalletQualityScore: number;
  /** Penalize / prune wallets with no activity for this many days */
  walletQualityInactiveDays: number;
  /** Auto unwatch/down-weight low-quality wallets (no hard delete) */
  enableWalletQualityAutoPrune: boolean;

  // --- Entry timing + dump rejection (Prompt 3) ---
  /** Reject copy if oldest smart-wallet buy in cluster is older than this */
  maxEntryAgeMinutes: number;
  /** Soft prefer / conviction boost when signal age ≤ this */
  preferEntryWithinMinutes: number;
  /** Reject tokens dumping hard from recent highs */
  rejectDumpingToken: boolean;
  /** Max adverse short-term % move (drawdown proxy) before reject */
  maxDrawdownFromRecentHighPct: number;
  /** Master switch for max-age / dump timing gates */
  enableEntryTimingGate: boolean;

  // --- Wallet clustering (Prompt 5) ---
  /** Min distinct high-quality wallets in cluster window (unifies with convergence) */
  clusterMinWallets: number;
  /** Cluster time window minutes (also drives convergenceWindowMs soft sync) */
  clusterWindowMinutes: number;
  /** Allow 1-wallet only for proven top performers on migration */
  allowSingleWalletTopPerformerMigration: boolean;

  // --- Smart money flow + momentum (Prompt 7) ---
  /** Multiplier on Birdeye/GMGN smart-money contribution to conviction */
  smartMoneyFlowWeight: number;
  /** Require momentum confirmation before entry */
  requireMomentumConfirmation: boolean;
  /** Minutes of price action to judge momentum hold */
  momentumLookbackMinutes: number;
  /** Min price change % vs lookback to pass momentum (e.g. -5 = allow mild dip) */
  momentumMinHoldPct: number;
}

export interface StrategyConfig {
  /** Require multi-wallet convergence before trading */
  enableConvergence: boolean;
  /** Only trade tokens that migrated from Pump.fun */
  enableMigrationOnly: boolean;
  /** Prioritize buys when smart money hits a freshly migrated token */
  enableMigrationPriority: boolean;
  /** Prioritize Pump.fun tokens nearing bonding-curve migration (e.g. 80%+) */
  enableBondingCurvePriority: boolean;
  /** Curve progress % at which near-migration priority arms (e.g. 80) */
  nearMigrationCurvePct: number;
  /** Prioritize early-curve smart wallet buys (pre-migration launches) */
  enableEarlyCurvePriority: boolean;
  /** Progress % at/below which a buy counts as early (e.g. 35) */
  earlyCurveMaxPct: number;
  /** Min Birdeye smart-money score to boost early-curve priority (0 = off) */
  minEarlyBirdeyeSmartMoneyScore: number;
  /** Min distinct smart wallets on early curve to force priority */
  earlyCurveMinSmartWallets: number;
  /** Automatically sell at take-profit / stop-loss */
  enableAutoSell: boolean;
  /** Size multiplier for migration-priority buys (e.g. 1.5 = 50% larger) */
  migrationSizeMultiplier: number;
  /** Tighter slippage (bps) for migration-priority live quotes */
  migrationSlippageBps: number;
  /** SOL moved in migrate tx to treat as volume spike */
  migrationVolumeSpikeSol: number;
  /** After profitable sell, watch for dip re-entry */
  reBuyEnabled: boolean;
  /** Min realized PnL % on sell to start dip watch (e.g. 100) */
  reBuyMinProfitPct: number;
  /** Dip from post-sell peak required before confirmation (e.g. -30) */
  reBuyDipPercent: number;
  /** Min distinct smart wallets buying during dip to confirm */
  confirmationThreshold: number;
  /** Alternate confirmation: volume increase % vs baseline */
  reBuyVolumeIncreasePct: number;
  /** Max successful re-buys per mint */
  reBuyMaxPerMint: number;
  /**
   * After hard stop-loss / early defensive exit, arm reclaim re-entry watch.
   * Default ON — does not re-enter after max-profit bag close unless
   * reEntryAfterMaxProfitEnabled is also ON.
   */
  postStopReentryEnabled: boolean;
  /** Cap successful re-entries per mint (profit-dip + stop re-entry combined) */
  reEntryMaxPerMint: number;
  /** Minutes to keep watching after exit before expiring */
  reEntryWatchMinutes: number;
  /** Min % reclaim from post-stop trough (or sell/entry zone) before arming */
  reEntryMinReclaimPct: number;
  /** Volume increase % vs baseline to confirm stop re-entry */
  reEntryMinVolumeIncreasePct: number;
  /** Smart wallets needed to confirm stop re-entry (falls back to confirmationThreshold) */
  reEntryConfirmationWallets: number;
  /** Position size multiplier for re-entries (usually < 1) */
  reEntrySizeMultiplier: number;
  /** Cooldown minutes between re-entry attempts on the same mint */
  reEntryCooldownMinutes: number;
  /** Optional: also arm profit-dip watch after successful max-profit / runner close */
  reEntryAfterMaxProfitEnabled: boolean;
}

/** Zion micro-bot settings (KOL scanner + manual offers). Isolated from strategy toggles. */
export interface ZionConfig {
  enabled: boolean;
  scanner: {
    enabled: boolean;
    pollIntervalMs: number;
    universeSize: number;
    activityLookbackMinutes: number;
    /** Wallets to RPC-scan per poll (rotation) */
    batchSize: number;
  };
  minKolWallets: number;
  minWalletQuality: number;
  minMcUsd: number;
  maxMcUsd: number;
  offerTtlMinutes: number;
  mintCooldownMinutes: number;
  useTrackedWalletsAsBoost: boolean;
  /** When true, qualifying scanner candidates become pending offers (still manual buy) */
  autoOfferFromScanner: boolean;
  /**
   * When true, Platinum offers (score ≥85, ≥10 KOL, 1h vol ≥$750k) auto-execute
   * into High Win-Rate. Gold/Green/default stay manual. Default OFF.
   */
  autoSendPlatinumToHwr?: boolean;
  defaults: {
    sizeMode: 'sol' | 'usd';
    solAmount: number;
    usdAmount: number;
    takeProfitPct: number;
    stopLossPct: number;
    trailingStopPct: number;
    trailingActivationProfit: number;
    useExitPresets: boolean;
  };
  notifyEmailOnOffer: boolean;
  notifyEmailOnPlaced: boolean;
}

export interface BotConfig {
  mode: TradingMode;
  /** Overall aggression preset — drives recommended trade/filter/risk knobs */
  riskLevel: RiskLevel;
  smartWallets: SmartWallet[];
  /** Live execution wallets (keys via env only) */
  tradingWallets: TradingWalletSlot[];
  /** Active live trading wallet id */
  activeTradingWalletId: string | null;
  trade: TradeConfig;
  filters: FilterConfig;
  strategy: StrategyConfig;
  /** Advanced risk / profit maximization */
  risk: RiskConfig;
  /** Tiered profit-taking: recover initial → partials → trail + bag */
  profitStrategy: ProfitStrategyConfig;
  /** Quick Scalper timed TP/SL/timer exits */
  quickScalper: QuickScalperConfig;
  microScalper: MicroScalperConfig;
  momentumBurst: MomentumBurstConfig;
  postMigrationScalp: PostMigrationScalpConfig;
  reversalScalp: ReversalScalpConfig;
  postRunDip: PostRunDipConfig;
  /** Fib + Support/Resistance analysis */
  technicalLevels: TechnicalLevelsConfig;
  chartPatterns: ChartPatternsConfig;
  /** High-conviction entry gating and trade-rate limits */
  selective: SelectiveTradingConfig;

  /**
   * Master strategy ON/OFF map (Strategies tab). When a key is false, that
   * logic is skipped entirely. Defaults match pre-1.1.40 always-on behaviour.
   */
  strategyToggles: Record<string, boolean>;
  /** Active strategy profile */
  strategyProfile:
    | 'high_win_rate'
    | 'win_rate_55_60'
    | 'balanced'
    | 'aggressive'
    | 'quick_scalper'
    | 'micro_scalper'
    | 'momentum_burst'
    | 'post_migration_scalp'
    | 'reversal_scalp'
    | 'scalper_suite'
    | 'aggressive_scalper'
    | 'conservative_scalper'
    | 'custom';
  /** True when High Win-Rate Preset thresholds + toggles are active */
  highWinRatePresetActive: boolean;
  /**
   * Risk→strategy recipe sync. synced = Risk Level owns module toggles;
   * custom = user/pack overrode modules (Risk knobs still apply).
   */
  strategyRecipeMode: 'synced' | 'custom';
  /** Last Risk Level whose strategy recipe was applied (UI) */
  strategyRecipeRiskLevel: RiskLevel | null;
  /**
   * Per-risk overlays from Risk Recipe Optimizer (applied after synced recipe).
   */
  riskRecipeOptimizations?: Partial<
    Record<
      Exclude<RiskLevel, 'off'>,
      {
        overlay: import('./backtestAdvisor').AdvisorOverlay;
        label: string;
        candidateId: string;
        appliedAt: number;
        metrics?: {
          trades: number;
          winRatePct: number;
          expectancySol: number;
          profitFactor: number;
          maxDrawdownPct: number;
          totalPnlSol: number;
          performanceScore: number;
        };
      }
    >
  >;
  /** Snapshot taken before applying a named preset (preserves custom overrides) */
  strategyProfileSnapshot: {
    savedAt: number;
    fromProfile:
      | 'high_win_rate'
      | 'win_rate_55_60'
      | 'balanced'
      | 'aggressive'
      | 'quick_scalper'
      | 'micro_scalper'
      | 'momentum_burst'
      | 'post_migration_scalp'
      | 'reversal_scalp'
      | 'scalper_suite'
      | 'aggressive_scalper'
      | 'conservative_scalper'
      | 'custom';
    knobs: Record<string, unknown>;
  } | null;

  /**
   * Multi-profile trade assignment (concurrent named profiles).
   * When enabled=false, all trades stamp Default (legacy single-stack behaviour).
   */
  tradeProfiles: {
    enabled: boolean;
    /** When true, profiles use curated module allowlists ∩ global master. Default false. */
    smartBotProfiles?: boolean;
    profiles: Record<string, boolean>;
    overrides?: Record<string, {
      exitRules?: Record<string, unknown>;
      match?: Record<string, unknown>;
      modules?: Record<string, boolean>;
    }>;
    autoScoring?: {
      enabled?: boolean;
      minScore?: number;
      skipBelowMin?: boolean;
      forceProfileId?: string | null;
      weights?: Record<string, number>;
    };
    selfLearning?: Record<string, unknown>;
    /** Master fixed-TP% override for all micro-bot / trade-profile exits */
    globalTakeProfit?: {
      enabled?: boolean;
      takeProfitPct?: number;
    };
  };

  /** GMGN API settings */
  gmgn: {
    apiKey: string;
    baseUrl: string;
    cacheTtlMs: number;
    minRequestGapMs: number;
    /** Prefer GMGN over on-chain for activity checks */
    preferGmgnActivity: boolean;
    /** Wallet discovery defaults */
    discovery: {
      minTrades7d: number;
      minWinRate: number;
      pumpFunFocus: boolean;
      activityDays: number;
      maxSniperScore: number;
      /** 0 = disabled; otherwise re-warm GMGN cache on this interval */
      autoRefreshMs: number;
    };
  };

  /** Birdeye token overview / smart-money signals */
  birdeye: {
    apiKey: string;
    baseUrl: string;
    cacheTtlMs: number;
  };

  /** Multi-source wallet discovery (GMGN / Birdeye / Dex / Kolscan / Axiom / Photon / BullX / manual) */
  walletDiscovery: {
    defaultSource:
      | 'gmgn'
      | 'birdeye'
      | 'dexscreener'
      | 'kolscan'
      | 'axiom'
      | 'photon'
      | 'bullx'
      | 'manual'
      | 'all';
    cacheTtlMs: number;
    birdeyeApiKey: string;
    birdeyeBaseUrl: string;
  };

  /** Solana Tracker Data API (Axiom / Photon platform leaderboards) */
  solanaTracker: {
    apiKey: string;
    baseUrl: string;
  };

  /** Multi-RPC + Jito + priority fees */
  rpc: {
    endpoints: { url: string; label: string; wsUrl?: string; role?: string }[];
    healthIntervalMs: number;
    failureThreshold: number;
    /** Prefer other lane only after preferred endpoint is unhealthy this long (ms). */
    failoverDownMs: number;
    /**
     * When true, split workloads: Helius=critical, Alchemy=scanners/Zion,
     * public=utility (import/activity).
     */
    shareLoad: boolean;
    priorityFee: {
      minMicroLamports: number;
      maxMicroLamports: number;
      defaultMicroLamports: number;
    };
    jito: {
      enabled: boolean;
      blockEngineUrl: string;
      tipLamports: number;
      uuid: string;
    };
  };

  /** MEV protection (Jito bundles + sandwich checks) */
  mev: {
    enableMEVProtection: boolean;
    useJitoBundles: boolean;
    sandwichProtection: boolean;
    sandwichMaxRecentBuys: number;
    sandwichWindowMs: number;
    sandwichLookbackTxs: number;
    priorityFeeMultiplier: number;
    tipMultiplier: number;
    abortOnSandwichRisk: boolean;
  };

  /** On-chain / DexScreener token metrics cache */
  tokenMetrics: {
    cacheTtlMs: number;
    devActivityLookbackMs: number;
  };

  /** Pump.fun bonding curve analysis + health gates */
  bondingCurve: {
    cacheTtlMs: number;
    /** Approx SOL raised when curve completes */
    migrationThresholdSol: number;
    /** Initial real token reserves (raw) for progress % */
    initialRealTokenReserves: number;
    /**
     * When true, reject dead/stalled curves — non-bypassable across all
     * risk levels. Default OFF.
     */
    requireHealthyCurve: boolean;
    /**
     * Optional min curve progress % to enter (0 = off beyond dead-curve floor).
     * Dead curves still rejected via requireHealthyCurve.
     */
    minCurveProgress: number;
    /**
     * Skip entries above this progress % (e.g. 98 = avoid completed curves).
     * 0 = disabled.
     */
    maxCurveProgressForEntry: number;
    /** Prefer near-migration band for soft score boost (lower bound) */
    preferNearMigrationMinPct: number;
    /** Prefer near-migration band for soft score boost (upper bound) */
    preferNearMigrationMaxPct: number;
    /** Require recent Dex volume/txns when evaluating curve health */
    requireRecentCurveActivity: boolean;
  };

  /** Time window (ms) for convergence detection */
  convergenceWindowMs: number;

  /**
   * AlphaScan-style New/Soon/Bonded discovery (Jupiter /recent + bonding curve).
   * Additive specialty feed — default OFF; does not alter Jupiter trending.
   */
  alphaScan: {
    enabled: boolean;
    pollIntervalMs: number;
    feedNew: boolean;
    feedSoon: boolean;
    feedBonded: boolean;
    routeSoonToMigrationSniper: boolean;
    routeBondedToScalper: boolean;
    routeBondedToReversalScalper: boolean;
    /** Min bonding-curve % to treat as Soon (default 70) */
    soonMinCurvePct: number;
    /** Max age since graduatedAt for Bonded scalp handoffs (minutes) */
    bondedMaxAgeMinutes: number;
    /**
     * Min market-cap USD for Bonded (true graduation / off-curve).
     * Blocks missing-curve false positives at low MC (default $25k).
     */
    bondedMinMarketCapUsd: number;
    maxHandOffPerPoll: number;
    /** Soft-merge New column into scanner universe (default false) */
    includeNewInScannerUniverse: boolean;
    /** Recent list fetch size */
    recentLimit: number;
  };

  /** Autonomous Market Scanner (TA / Pump.fun / Dex) */
  marketScanner: {
    /** Soft preference when seeding toggles (strategy toggle is source of truth) */
    enabled: boolean;
    pollIntervalMs: number;
    lookbackHours: number;
    maxCandidatesPerPoll: number;
    cooldownMs: number;
    minRankScore: number;
    /** Scanner-only entries must show a Fib/support/pattern/indicator setup */
    requireTaSetup: boolean;
    minPatternConfidence: number;
    /** Prefer Birdeye/GeckoTerminal OHLCV over synthetic paths */
    preferRealCandles: boolean;
    /** Rank penalty when candles remain synthetic */
    syntheticPenalty: number;
    /** Min playbook confluence (0–100) for scanner quality */
    minConfluenceScore: number;
    /** Playbook classifier mode (auto only for now) */
    playbookMode: 'auto';
    /** Skip scanner-only entries in risk_off (hybrid still allowed) */
    pauseScannerOnlyInRiskOff: boolean;
    /** Momentum playbooks need SOL relative-strength hint */
    requireRsForMomentum: boolean;
    /** When true, require mtfAligned for scanner-only quality gate */
    requireMtfAligned: boolean;
    /** Scanner-local liquidity floor USD (0 = use global filters only) */
    minLiquidityUsd: number;
    /** Jupiter organicScore floor when available (0 = disabled) */
    minOrganicScore: number;
    /** Prefer buyOrganicVolume+sellOrganicVolume for vol gates when present */
    preferOrganicVolume: boolean;
    /** Merge Jupiter Tokens API trending into scanner universe */
    jupiterTrendingEnabled: boolean;
    jupiterCategory: 'toptraded' | 'toptrending' | 'toporganicscore';
    /** Filter to pump.fun mints (suffix / tags / launchpad) */
    jupiterPumpFunOnly: boolean;
    /** Jupiter category list size (10–100) */
    jupiterLimit: number;
    /** Fetch 5m+1h+6h+24h top lists and union by mint */
    jupiterMergeIntervals: boolean;
    /** Volume window floors USD (0 = disabled for that window) */
    minVolumeM5Usd: number;
    minVolumeH1Usd: number;
    minVolumeH6Usd: number;
    minVolumeH24Usd: number;
  };

  /** Paper trading simulation */
  paper: {
    startingBalanceSol: number;
    feeBps: number;
    slippageBps: number;
    positionCheckIntervalMs: number;
    /** Use DexScreener/GMGN prices for paper TP/SL & backtests */
    useLiveData: boolean;
  };

  /**
   * Email notification preferences (SMTP credentials stay in env).
   * Default recipient: bondback2026@gmail.com
   */
  notifications: {
    enabled: boolean;
    email: string;
    /** Alert when total equity < this SOL (default 1) */
    lowEquitySol: number;
    lowEquityEnabled: boolean;
    lowEquityCooldownMs: number;
    /** Alert when a buy is blocked for insufficient available SOL */
    insufficientFundsEnabled: boolean;
    insufficientFundsCooldownMs: number;
    /** Alert when a full close finishes in profit */
    profitableCloseEnabled: boolean;
    /** In-app notification bell feed (default ON) */
    dashboardEnabled: boolean;
    /** Soft chime when a new Zion trade request arrives (default ON) */
    tradeRequestSound: boolean;
    /** Soft cash sound when a profitable close hits the bell (default ON) */
    profitCloseSound: boolean;
    /** Soft confirm sound when user clicks Place Trade on a Zion offer (default ON) */
    zionPlaceTradeSound: boolean;
    /** Auto-popup Zion trade request cards (default ON) */
    tradeRequestPopups: boolean;
  };

  /**
   * Zion micro-bot — isolated KOL Token Scanner + manual trade offers.
   * Disabled by default; does not alter copy trading or Market/Pump scanners.
   */
  zion: ZionConfig;

  pollIntervalMs: number;
  solMint: string;
  pumpFunProgramId: string;
  pumpSwapProgramId: string;
  port: number;

  /**
   * Micro-bot Learning Mode — global gate overlays + fairness boost.
   * Default OFF. Does not change position sizing.
   */
  learningMode: import('./learningMode').LearningModeConfig;
}

export const config: BotConfig = {
  mode: 'liveSimulation',
  riskLevel: 'on',
  smartWallets: [],
  tradingWallets: [],
  activeTradingWalletId: null,

  trade: {
    // Match On RISK_LEVEL_PRESETS (lean baseline)
    baseTradeAmountSol: 0.14,
    tradeAmountSol: 0.14,
    maxAllowedTradeSol: DEFAULT_MAX_ALLOWED_TRADE_SOL,
    riskMultiplier: 0.45,
    convictionMultiplier: 1.5,
    minProfitPercent: 42,
    maxProfitPercent: 1000,
    stopLossPercent: -30,
  },

  filters: {
    minWinRate: 0,
    minLiquidity: 10_000,
    minMarketCapUsd: 8_000,
    maxEntryMarketCapUsd: 0,
    minDevHoldPct: 0,
    maxDevHoldPct: 14,
    maxDevPercent: 14,
    minTopHolderPct: 0,
    maxTopHolderPct: 70,
    maxHolderConcentration: 70,
    minTop10HolderPct: 8,
    enableAntiRug: true,
    requireLiquidityLocked: false,
    skipIfDevRecentSells: true,
    checkHoneypot: true,
    minEstimatedTaxPct: 0,
    maxEstimatedTaxPct: 24,
    minRiskScore: 0,
    maxRiskScore: 78,
    // Pump.fun bonding-curve tokens keep mint authority until migration —
    // hard-skipping them blocks almost all early copy signals.
    skipIfMintAuthority: false,
    enableSniperFilter: true,
    sniperSensitivity: 'medium',
    enableSocialSentimentFilter: false,
    socialSentimentSensitivity: 'medium',
    enableTrendingNarrativeBoost: false,
    trendingNarrativeSensitivity: 'medium',
    trendingNarrativeBoostPoints: 6,
    enableVolumeSpikeFilter: false,
    volumeSpikeSensitivity: 'medium',
    volumeSpikeWindowMinutes: 3,
    volumeSpikeMultiplier: 3,
    volumeSpikeBuySidePct: 65,
    volumeSpikeMinUsd: 2_500,
    volumeSpikeBoostPoints: 8,
    volumeSpikeHardFilter: true,
    enableConfirmationLayer: false,
    confirmationSensitivity: 'medium',
    confirmationVolumeWeight: 50,
    confirmationSentimentWeight: 25,
    confirmationNarrativeWeight: 25,
    confirmationBoostPoints: 10,
    confirmationHardFilter: false,
    enableMarketSessionFilter: false,
    marketSessionAllowAsia: true,
    marketSessionAllowEurope: true,
    marketSessionAllowUs: true,
    marketSessionAllowOverlap: true,
    marketSessionAllowOffHours: false,
    marketSessionPreferred: ['us', 'europe_us'],
    marketSessionPreferBoostPoints: 3,
    enablePostRunDip: false,
    postRunDipSensitivity: 'medium',
    maxSniperCount: 0,
    maxBundlerPct: 0,
    maxInsiderPct: 0,
    maxSniperScore: 0,
    convergenceRequired: 2,
    maxConcurrentPositions: 12,
    dailyLossLimitSol: 2.5,
    minActivityDays: 14,
    minTradesLast30d: 3,
    enableActivityFilter: true,
    minVolume24hUsd: 25_000,
    minRecentVolumeUsd: 2_500,
    minRecentBuyVolumeUsd: 1_500,
    minHolderCount: 120,
    minHolders: 120,
    minRecentActivity: 10,
    buyPumpFunOnly: true,
    enableWalletQualityGate: true,
    minWalletQualityScore: 55,
    walletQualityInactiveDays: 5,
    enableWalletQualityAutoPrune: false,
    maxEntryAgeMinutes: 15,
    preferEntryWithinMinutes: 10,
    rejectDumpingToken: true,
    maxDrawdownFromRecentHighPct: 35,
    enableEntryTimingGate: true,
    clusterMinWallets: 2,
    clusterWindowMinutes: 5,
    allowSingleWalletTopPerformerMigration: true,
    smartMoneyFlowWeight: 1.35,
    requireMomentumConfirmation: false,
    momentumLookbackMinutes: 15,
    momentumMinHoldPct: -5,
  },

  strategy: {
    enableConvergence: true,
    enableMigrationOnly: false,
    enableMigrationPriority: true,
    enableBondingCurvePriority: true,
    nearMigrationCurvePct: 80,
    enableEarlyCurvePriority: true,
    earlyCurveMaxPct: Number(process.env.EARLY_CURVE_MAX_PCT) || 35,
    minEarlyBirdeyeSmartMoneyScore:
      Number(process.env.MIN_EARLY_BIRDEYE_SM) || 40,
    earlyCurveMinSmartWallets:
      Number(process.env.EARLY_CURVE_MIN_WALLETS) || 1,
    enableAutoSell: true,
    migrationSizeMultiplier: 1.55,
    migrationSlippageBps: 100,
    migrationVolumeSpikeSol: 40,
    reBuyEnabled: true,
    reBuyMinProfitPct: 90,
    reBuyDipPercent: -30,
    confirmationThreshold: 3,
    reBuyVolumeIncreasePct: 50,
    reBuyMaxPerMint: 2,
    postStopReentryEnabled: true,
    reEntryMaxPerMint: 2,
    reEntryWatchMinutes: 90,
    reEntryMinReclaimPct: 8,
    reEntryMinVolumeIncreasePct: 50,
    reEntryConfirmationWallets: 3,
    reEntrySizeMultiplier: 0.65,
    reEntryCooldownMinutes: 8,
    reEntryAfterMaxProfitEnabled: false,
  },

  risk: { ...DEFAULT_RISK },

  selective: { ...DEFAULT_SELECTIVE },

  strategyToggles: {},
  strategyProfile: 'custom',
  highWinRatePresetActive: false,
  strategyRecipeMode: 'synced',
  strategyRecipeRiskLevel: 'on',
  riskRecipeOptimizations: {},
  strategyProfileSnapshot: null,
  tradeProfiles: {
    enabled: true,
    smartBotProfiles: true,
    profiles: {
      default: true,
      scalper: true,
      dip_buyer: true,
      trend_rider: true,
      migration_sniper: true,
      high_win_rate: true,
      momentum_burst: true,
      steady_compounder: true,
      reversal_scalper: true,
      smart_money_mirror: true,
      zion: true,
    },
    globalTakeProfit: {
      enabled: false,
      takeProfitPct: 25,
    },
  },

  learningMode: {
    enabled: false,
    strictness: 'middle',
    snapshot: null,
    fairnessBoost: true,
  },

  profitStrategy: {
    ...DEFAULT_PROFIT_STRATEGY,
    enabled:
      process.env.PROFIT_STRATEGY_ENABLED !== '0' &&
      process.env.PROFIT_STRATEGY_ENABLED !== 'false',
    takeInitialPercent:
      Number(process.env.PROFIT_TAKE_INITIAL_PCT) ||
      DEFAULT_PROFIT_STRATEGY.takeInitialPercent,
    partialSellAt:
      Number(process.env.PROFIT_PARTIAL_AT) ||
      DEFAULT_PROFIT_STRATEGY.partialSellAt,
    partialSellPercent:
      Number(process.env.PROFIT_PARTIAL_SELL_PCT) ||
      DEFAULT_PROFIT_STRATEGY.partialSellPercent,
    trailingStopAfter:
      Number(process.env.PROFIT_TRAIL_AFTER) ||
      DEFAULT_PROFIT_STRATEGY.trailingStopAfter,
    trailingStopPct:
      Number(process.env.PROFIT_TRAIL_PCT) ||
      DEFAULT_PROFIT_STRATEGY.trailingStopPct,
    bagPercent:
      Number(process.env.PROFIT_BAG_PCT) || DEFAULT_PROFIT_STRATEGY.bagPercent,
    riskBasedAdjustment:
      process.env.PROFIT_RISK_ADJUST !== '0' &&
      process.env.PROFIT_RISK_ADJUST !== 'false',
  },

  quickScalper: { ...DEFAULT_QUICK_SCALPER },
  microScalper: { ...DEFAULT_MICRO_SCALPER },
  momentumBurst: { ...DEFAULT_MOMENTUM_BURST },
  postMigrationScalp: { ...DEFAULT_POST_MIGRATION_SCALP },
  reversalScalp: { ...DEFAULT_REVERSAL_SCALP },
  postRunDip: { ...DEFAULT_POST_RUN_DIP },
  technicalLevels: { ...DEFAULT_TECHNICAL_LEVELS },
  chartPatterns: {
    ...DEFAULT_CHART_PATTERNS,
    patterns: { ...DEFAULT_CHART_PATTERNS.patterns },
  },

  gmgn: {
    apiKey: process.env.GMGN_API_KEY?.trim() || '',
    baseUrl: process.env.GMGN_BASE_URL?.trim() || 'https://openapi.gmgn.ai',
    cacheTtlMs: 5 * 60 * 1000,
    minRequestGapMs: 350,
    preferGmgnActivity: true,
    discovery: {
      minTrades7d: Number(process.env.GMGN_MIN_TRADES_7D) || 20,
      minWinRate: Number(process.env.GMGN_MIN_WIN_RATE) || 45,
      pumpFunFocus:
        process.env.GMGN_PUMP_FOCUS === '1' ||
        process.env.GMGN_PUMP_FOCUS === 'true',
      activityDays: Number(process.env.GMGN_ACTIVITY_DAYS) || 7,
      maxSniperScore: Number(process.env.GMGN_MAX_SNIPER_SCORE) || 50,
      autoRefreshMs: Number(process.env.GMGN_AUTO_REFRESH_MS) || 15 * 60 * 1000,
    },
  },

  birdeye: {
    apiKey: process.env.BIRDEYE_API_KEY?.trim() || '',
    baseUrl:
      process.env.BIRDEYE_BASE_URL?.trim() || 'https://public-api.birdeye.so',
    cacheTtlMs: Number(process.env.BIRDEYE_CACHE_MS) || 90_000,
  },

  walletDiscovery: {
    defaultSource: (() => {
      const s = (process.env.WALLET_DISCOVERY_SOURCE || 'all').toLowerCase();
      if (
        s === 'birdeye' ||
        s === 'dexscreener' ||
        s === 'manual' ||
        s === 'gmgn' ||
        s === 'kolscan' ||
        s === 'axiom' ||
        s === 'photon' ||
        s === 'bullx' ||
        s === 'all'
      ) {
        return s as
          | 'gmgn'
          | 'birdeye'
          | 'dexscreener'
          | 'kolscan'
          | 'axiom'
          | 'photon'
          | 'bullx'
          | 'manual'
          | 'all';
      }
      return 'all';
    })(),
    cacheTtlMs: Number(process.env.WALLET_DISCOVERY_CACHE_MS) || 5 * 60 * 1000,
    birdeyeApiKey: process.env.BIRDEYE_API_KEY?.trim() || '',
    birdeyeBaseUrl:
      process.env.BIRDEYE_BASE_URL?.trim() || 'https://public-api.birdeye.so',
  },

  solanaTracker: {
    apiKey: process.env.SOLANA_TRACKER_API_KEY?.trim() || '',
    baseUrl:
      process.env.SOLANA_TRACKER_BASE_URL?.trim() ||
      'https://data.solanatracker.io',
  },

  rpc: {
    endpoints: rpcEndpointsFromEnv(),
    healthIntervalMs: 30_000,
    failureThreshold: 3,
    failoverDownMs: Number(process.env.RPC_FAILOVER_DOWN_MS) || 30_000,
    shareLoad:
      process.env.RPC_SHARE_LOAD === '0' ||
      process.env.RPC_SHARE_LOAD === 'false'
        ? false
        : process.env.RPC_SHARE_LOAD === '1' ||
          process.env.RPC_SHARE_LOAD === 'true' ||
          // Default ON when both free provider keys exist (survives Render disk wipe).
          Boolean(
            process.env.HELIUS_API_KEY?.trim() &&
              process.env.ALCHEMY_API_KEY?.trim()
          ),
    priorityFee: {
      minMicroLamports: 1_000,
      maxMicroLamports: 500_000,
      defaultMicroLamports: 50_000,
    },
    jito: {
      enabled: process.env.JITO_ENABLED === '1' || process.env.JITO_ENABLED === 'true',
      blockEngineUrl:
        process.env.JITO_BLOCK_ENGINE?.trim() ||
        'https://mainnet.block-engine.jito.wtf',
      tipLamports: Number(process.env.JITO_TIP_LAMPORTS) || 10_000,
      uuid: process.env.JITO_UUID?.trim() || '',
    },
  },

  mev: {
    enableMEVProtection:
      process.env.ENABLE_MEV_PROTECTION === '1' ||
      process.env.ENABLE_MEV_PROTECTION === 'true' ||
      process.env.JITO_ENABLED === '1' ||
      process.env.JITO_ENABLED === 'true',
    useJitoBundles: true,
    sandwichProtection: true,
    sandwichMaxRecentBuys: 3,
    sandwichWindowMs: 12_000,
    sandwichLookbackTxs: 16,
    priorityFeeMultiplier: 1.5,
    tipMultiplier: 1.5,
    abortOnSandwichRisk: true,
  },

  tokenMetrics: {
    cacheTtlMs: 90_000,
    devActivityLookbackMs: 2 * 24 * 60 * 60 * 1000,
  },

  bondingCurve: {
    cacheTtlMs: 12_000,
    migrationThresholdSol: 85,
    initialRealTokenReserves: 793_100_000_000_000,
    requireHealthyCurve: false,
    minCurveProgress: 0,
    maxCurveProgressForEntry: 98,
    preferNearMigrationMinPct: 70,
    preferNearMigrationMaxPct: 95,
    requireRecentCurveActivity: true,
  },

  convergenceWindowMs: 5 * 60 * 1000,

  alphaScan: {
    enabled: false,
    pollIntervalMs: 45_000,
    feedNew: true,
    feedSoon: true,
    feedBonded: true,
    routeSoonToMigrationSniper: true,
    routeBondedToScalper: true,
    routeBondedToReversalScalper: true,
    soonMinCurvePct: 70,
    bondedMaxAgeMinutes: 45,
    bondedMinMarketCapUsd: 25_000,
    maxHandOffPerPoll: 8,
    includeNewInScannerUniverse: false,
    recentLimit: 40,
  },

  marketScanner: {
    enabled: true,
    pollIntervalMs: 15_000,
    lookbackHours: 6,
    maxCandidatesPerPoll: 15,
    cooldownMs: 45 * 60_000,
    minRankScore: 42,
    requireTaSetup: true,
    minPatternConfidence: 55,
    preferRealCandles: true,
    syntheticPenalty: 8,
    minConfluenceScore: 40,
    playbookMode: 'auto',
    pauseScannerOnlyInRiskOff: true,
    requireRsForMomentum: true,
    requireMtfAligned: false,
    minLiquidityUsd: 8000,
    minOrganicScore: 0,
    preferOrganicVolume: true,
    jupiterTrendingEnabled: true,
    jupiterCategory: 'toptraded',
    jupiterPumpFunOnly: true,
    jupiterLimit: 100,
    jupiterMergeIntervals: true,
    minVolumeM5Usd: 1000,
    minVolumeH1Usd: 5000,
    minVolumeH6Usd: 10000,
    minVolumeH24Usd: 15_000,
  },

  notifications: {
    enabled: true,
    email:
      process.env.NOTIFY_EMAIL?.trim() || 'bondback2026@gmail.com',
    lowEquitySol: Number(process.env.NOTIFY_LOW_EQUITY_SOL) || 1,
    lowEquityEnabled: process.env.NOTIFY_LOW_EQUITY !== '0',
    lowEquityCooldownMs: Number(process.env.NOTIFY_LOW_EQUITY_COOLDOWN_MS) || 6 * 3600_000,
    insufficientFundsEnabled: process.env.NOTIFY_INSUFFICIENT_FUNDS !== '0',
    insufficientFundsCooldownMs:
      Number(process.env.NOTIFY_INSUFFICIENT_FUNDS_COOLDOWN_MS) || 30 * 60_000,
    profitableCloseEnabled: process.env.NOTIFY_PROFITABLE_CLOSE !== '0',
    dashboardEnabled: true,
    tradeRequestSound: true,
    profitCloseSound: true,
    zionPlaceTradeSound: true,
    tradeRequestPopups: true,
  },

  zion: {
    enabled: true,
    scanner: {
      enabled: true,
      pollIntervalMs: 30_000,
      universeSize: 60,
      activityLookbackMinutes: 45,
      batchSize: 6,
    },
    minKolWallets: 5,
    minWalletQuality: 40,
    minMcUsd: 50_000,
    maxMcUsd: 500_000_000,
    offerTtlMinutes: 60,
    mintCooldownMinutes: 120,
    useTrackedWalletsAsBoost: true,
    autoOfferFromScanner: true,
    autoSendPlatinumToHwr: false,
    defaults: {
      sizeMode: 'sol',
      solAmount: 0.25,
      usdAmount: 50,
      takeProfitPct: 80,
      stopLossPct: -25,
      trailingStopPct: 18,
      trailingActivationProfit: 35,
      useExitPresets: true,
    },
    notifyEmailOnOffer: true,
    notifyEmailOnPlaced: true,
  },

  paper: {
    startingBalanceSol: 10,
    feeBps: 30,
    slippageBps: 150,
    positionCheckIntervalMs: 5_000,
    useLiveData: true,
  },

  pollIntervalMs: 8_000,
  solMint: 'So11111111111111111111111111111111111111112',
  pumpFunProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  pumpSwapProgramId: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  port: Number(process.env.PORT) || 3000,
};

/**
 * Snapshot of user-tunable settings (no API keys / wallets).
 * Written whenever dashboard/API saves config so restarts keep values.
 */
/** One-shot: older defaults hard-blocked almost all pre-migration Pump copies. */
const PAPER_SIGNAL_RELAX_MIGRATION = 'paperSignalRelax_v2';
/** One-shot: undo migrationFocus_v1 — keep Migration Only OFF by default. */
const MIGRATION_FOCUS_OFF_V1 = 'migrationFocus_off_v1';
/** One-shot: turn requireHealthyCurve OFF (was default ON from dead-token work). */
const REQUIRE_HEALTHY_CURVE_OFF_V1 = 'requireHealthyCurve_off_v1';
/** One-shot: raise volume/liquidity/holder floors after paper-relax loosened them. */
const HARD_VOLUME_LIQ_FLOORS_V113 = 'hardVolumeLiquidityFloors_v113';
/** One-shot: re-apply selected riskLevel presets onto persisted knobs (Medium sync). */
const RISK_LEVEL_SYNC_V1 = 'riskLevelSync_v1';
/**
 * One-shot: bump maxProfitPercent to 1000 when still on an old default (100/500),
 * and clamp any value above the new 5000% ceiling.
 */
const MAX_PROFIT_DEFAULT_V1123 = 'maxProfitDefault_v1123';
/** One-shot: seed min top-10 concentration floor (honeypot dispersion gate). */
const HOLDER_CONCENTRATION_FLOORS_V1124 = 'holderConcentrationFloors_v1124';
/**
 * One-shot: restore Medium-viable entry knobs after overly-tight persisted
 * maxTopHolderPct / conviction / maxRiskScore blocked migrations + copies.
 */
const MEDIUM_ENTRY_RESTORE_V1125 = 'mediumEntryRestore_v1125';
/** One-shot: seed min entry market-cap floor ($5k, non-bypassable). */
const MIN_MARKET_CAP_FLOOR_V1129 = 'minMarketCapFloor_v1129';
/** One-shot: turn buyPumpFunOnly ON (Pump.fun mint suffix hard floor). */
const BUY_PUMP_FUN_ONLY_ON_V1131 = 'buyPumpFunOnly_on_v1131';
/** One-shot: seed wallet quality + entry timing + cluster defaults (1.1.33). */
const WALLET_QUALITY_ENTRY_V1133 = 'walletQualityEntry_v1133';
/** One-shot: prefer live-parity simulation for persisted users still on plain paper. */
const TRADING_MODE_LIVE_SIM_V1143 = 'tradingMode_liveSim_v1143';
/**
 * One-shot: re-assert Live Sim as default over stale plain Paper after deploy.
 * v1143 could already be marked while mode later reverted to paper (or never
 * changed because migration ran when already non-paper). Does not touch live.
 */
const TRADING_MODE_LIVE_SIM_DEFAULT_V2 = 'tradingMode_liveSimDefault_v2';
/**
 * One-shot: raise absolute vol/liq/MC hard floors ($8k liq / $8k MC / $15k 24h / $1.5k recent).
 * Prior v113 floors were $5k liq / $5k MC / $10k 24h / $800 recent.
 */
const HARD_VOLUME_LIQ_FLOORS_V1144 = 'hardVolumeLiquidityFloors_v1144';
/** One-shot: Smart Bot Profiles ON by default (micro-bots). */
const SMART_BOT_DEFAULT_ON_V1 = 'smartBotDefaultOn_v1';
/** One-shot: Zion micro-bot ON by default (KOL scanner + offers). */
const ZION_DEFAULT_ON_V1 = 'zionDefaultOn_v1';
/** One-shot: Zion safeguards MC band + quality/poll defaults. */
const ZION_SAFEGUARDS_V1 = 'zionSafeguards_v1';
const ZION_MIN_KOL_V2 = 'zionMinKol_v2';
const SELF_LEARNING_DEFAULT_ON_V1 = 'selfLearningDefaultOn_v1';
const NOTIFY_EMAIL_BONDBACK_V1 = 'notifyEmailBondback_v1';
/** Prefix for baked strategy-modules default stamps (strategyModulesDefault@<id>). */
export const STRATEGY_MODULES_DEFAULT_MIGRATION_PREFIX =
  'strategyModulesDefault@';
const OLD_MAX_PROFIT_DEFAULTS = new Set([100, 500]);
const NEW_MAX_PROFIT_DEFAULT = 1000;
const MAX_PROFIT_PERCENT_CEILING = 5000;
let settingsMigrations: Record<string, boolean> = {};

/** True when a one-shot settings migration id has already run. */
export function hasSettingsMigration(id: string): boolean {
  return settingsMigrations[id] === true;
}

/** Mark a migration complete and persist (keeps redeploys from re-running it). */
export function completeSettingsMigration(id: string): void {
  settingsMigrations[id] = true;
  persistUserSettings();
}

/** Drop older strategyModulesDefault@* stamps when applying a newer baked default. */
export function clearPriorStrategyModulesDefaultMigrations(
  keepId: string
): void {
  for (const key of Object.keys(settingsMigrations)) {
    if (
      key.startsWith(STRATEGY_MODULES_DEFAULT_MIGRATION_PREFIX) &&
      key !== keepId
    ) {
      delete settingsMigrations[key];
    }
  }
}

export function buildPersistedSettingsSnapshot(): PersistedBotSettings {
  return {
    version: SETTINGS_VERSION,
    updatedAt: Date.now(),
    mode: config.mode,
    riskLevel: normalizeRiskLevel(config.riskLevel),
    trade: { ...config.trade },
    filters: { ...config.filters },
    strategy: { ...config.strategy },
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
    profitStrategy: { ...config.profitStrategy },
    quickScalper: { ...config.quickScalper },
    microScalper: { ...config.microScalper },
    momentumBurst: { ...config.momentumBurst },
    postMigrationScalp: { ...config.postMigrationScalp },
    reversalScalp: { ...config.reversalScalp },
    postRunDip: { ...config.postRunDip },
    technicalLevels: { ...config.technicalLevels },
    chartPatterns: {
      ...config.chartPatterns,
      patterns: { ...(config.chartPatterns?.patterns || {}) },
    },
    selective: { ...config.selective },
    strategyToggles: { ...(config.strategyToggles || {}) },
    strategyProfile:
      config.strategyProfile === 'balanced' ||
      config.strategyProfile === 'high_win_rate' ||
      config.strategyProfile === 'win_rate_55_60' ||
      config.strategyProfile === 'aggressive' ||
      config.strategyProfile === 'quick_scalper' ||
      config.strategyProfile === 'micro_scalper' ||
      config.strategyProfile === 'momentum_burst' ||
      config.strategyProfile === 'post_migration_scalp' ||
      config.strategyProfile === 'reversal_scalp' ||
      config.strategyProfile === 'scalper_suite' ||
      config.strategyProfile === 'aggressive_scalper' ||
      config.strategyProfile === 'conservative_scalper'
        ? config.strategyProfile
        : 'custom',
    highWinRatePresetActive: config.highWinRatePresetActive === true,
    strategyRecipeMode:
      config.strategyRecipeMode === 'custom' ? 'custom' : 'synced',
    strategyRecipeRiskLevel:
      config.strategyRecipeRiskLevel == null
        ? normalizeRiskLevel(config.riskLevel)
        : normalizeRiskLevel(config.strategyRecipeRiskLevel),
    riskRecipeOptimizations: config.riskRecipeOptimizations
      ? (JSON.parse(JSON.stringify(config.riskRecipeOptimizations)) as PersistedBotSettings['riskRecipeOptimizations'])
      : {},
    strategyProfileSnapshot: config.strategyProfileSnapshot
      ? (cloneJson(config.strategyProfileSnapshot) as PersistedBotSettings['strategyProfileSnapshot'])
      : null,
    // Deep-clone nested exitRules/match/modules (shallow spread dropped Max Trade Override etc.)
    tradeProfiles: config.tradeProfiles
      ? (cloneJson({
          enabled: config.tradeProfiles.enabled !== false,
          smartBotProfiles: config.tradeProfiles.smartBotProfiles === true,
          profiles: { ...(config.tradeProfiles.profiles || {}) },
          overrides: config.tradeProfiles.overrides
            ? cloneJson(config.tradeProfiles.overrides)
            : {},
          autoScoring: config.tradeProfiles.autoScoring
            ? cloneJson(config.tradeProfiles.autoScoring)
            : undefined,
          selfLearning: (config.tradeProfiles as { selfLearning?: unknown })
            .selfLearning
            ? cloneJson(
                (config.tradeProfiles as { selfLearning?: unknown }).selfLearning
              )
            : undefined,
          globalTakeProfit: config.tradeProfiles.globalTakeProfit
            ? cloneJson(config.tradeProfiles.globalTakeProfit)
            : { enabled: false, takeProfitPct: 25 },
        }) as PersistedBotSettings['tradeProfiles'])
      : undefined,
    paper: { ...config.paper },
    notifications: { ...config.notifications },
    marketScanner: { ...config.marketScanner },
    alphaScan: { ...config.alphaScan },
    zion: cloneJson(config.zion) as unknown as PersistedBotSettings['zion'],
    mev: { ...config.mev },
    gmgnDiscovery: { ...config.gmgn.discovery },
    walletDiscovery: {
      defaultSource: config.walletDiscovery.defaultSource,
      cacheTtlMs: config.walletDiscovery.cacheTtlMs,
    },
    tokenMetrics: { ...config.tokenMetrics },
    bondingCurve: { ...config.bondingCurve },
    convergenceWindowMs: config.convergenceWindowMs,
    pollIntervalMs: config.pollIntervalMs,
    rpcShareLoad: Boolean(config.rpc.shareLoad),
    learningMode: config.learningMode
      ? (cloneJson(config.learningMode) as PersistedBotSettings['learningMode'])
      : {
          enabled: false,
          strictness: 'middle',
          snapshot: null,
          fairnessBoost: true,
        },
    migrations: { ...settingsMigrations },
  };
}

/** Persist current tunable settings without touching wallets or secrets. */
export function persistUserSettings(): boolean {
  const ok = savePersistedSettings(buildPersistedSettingsSnapshot());
  try {
    const { serializeTradeProfilesForPersist } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    const { saveTradeProfilesUserState } =
      require('./tradeProfilesUserStore') as typeof import('./tradeProfilesUserStore');
    saveTradeProfilesUserState(serializeTradeProfilesForPersist());
  } catch {
    /* tradeProfiles may not be ready during early bootstrap */
  }
  return ok;
}

function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Code/env defaults captured before any data/config.json merge.
 * Used by Reset to Defaults to restore in-memory settings after files are wiped.
 */
const CODE_DEFAULT_SETTINGS: PersistedBotSettings = cloneJson(
  buildPersistedSettingsSnapshot()
);

/** Snapshot of code/env defaults captured at module load (before config.json merge). */
export function getCodeDefaultSettings(): PersistedBotSettings {
  return cloneJson(CODE_DEFAULT_SETTINGS);
}

function syncConfigAliases(): void {
  if (config.filters.maxDevHoldPct != null) {
    config.filters.maxDevPercent = config.filters.maxDevHoldPct;
  }
  // maxTopHolderPct = single largest wallet; maxHolderConcentration = Top-10%.
  // Do NOT sync them — they are independent metrics.
  // Keep minHolders ↔ minHolderCount in sync (prefer whichever was set higher)
  const holders = Math.max(
    config.filters.minHolders ?? 0,
    config.filters.minHolderCount ?? 0
  );
  if (holders > 0) {
    config.filters.minHolders = holders;
    config.filters.minHolderCount = holders;
  }
  // Clamp Top-10% band: min ≤ max when both enabled
  clampTop10HolderBand();
  // Risk OFF intentionally zeros floors — do not re-apply absolute clamps
  if (config.riskLevel === 'off') {
    if (config.filters.minRecentVolumeUsd == null) {
      config.filters.minRecentVolumeUsd = 0;
    }
    if (config.filters.minRecentBuyVolumeUsd == null) {
      config.filters.minRecentBuyVolumeUsd = 0;
    }
    if (config.filters.minRecentActivity == null) {
      config.filters.minRecentActivity = 0;
    }
    if (
      config.filters.minMarketCapUsd == null ||
      !Number.isFinite(Number(config.filters.minMarketCapUsd))
    ) {
      config.filters.minMarketCapUsd = 0;
    }
    if (
      config.filters.minTop10HolderPct == null ||
      !Number.isFinite(Number(config.filters.minTop10HolderPct))
    ) {
      config.filters.minTop10HolderPct = 0;
    }
  } else {
    if (config.filters.minRecentVolumeUsd == null) {
      config.filters.minRecentVolumeUsd = HARD_FILTER_FLOORS.minRecentVolumeUsd;
    }
    if (config.filters.minRecentBuyVolumeUsd == null) {
      config.filters.minRecentBuyVolumeUsd =
        HARD_FILTER_FLOORS.minRecentBuyVolumeUsd;
    }
    if (config.filters.minRecentActivity == null) {
      config.filters.minRecentActivity = HARD_FILTER_FLOORS.minRecentActivityTxns;
    }
    if (
      config.filters.minMarketCapUsd == null ||
      !Number.isFinite(Number(config.filters.minMarketCapUsd)) ||
      Number(config.filters.minMarketCapUsd) <= 0
    ) {
      config.filters.minMarketCapUsd = HARD_FILTER_FLOORS.minMarketCapUsd;
    } else {
      config.filters.minMarketCapUsd = Math.max(
        Number(config.filters.minMarketCapUsd),
        HARD_FILTER_FLOORS.minMarketCapUsd
      );
    }
    if (
      config.filters.minTop10HolderPct == null ||
      !Number.isFinite(Number(config.filters.minTop10HolderPct)) ||
      Number(config.filters.minTop10HolderPct) <= 0
    ) {
      config.filters.minTop10HolderPct = 8;
    } else {
      config.filters.minTop10HolderPct = Math.max(
        Number(config.filters.minTop10HolderPct),
        HARD_FILTER_FLOORS.minTop10HolderPct
      );
    }
  }
  if (
    config.filters.maxEntryMarketCapUsd == null ||
    !Number.isFinite(Number(config.filters.maxEntryMarketCapUsd)) ||
    Number(config.filters.maxEntryMarketCapUsd) < 0
  ) {
    config.filters.maxEntryMarketCapUsd = 0;
  }
  if (config.filters.buyPumpFunOnly == null) {
    config.filters.buyPumpFunOnly = true;
  }
  if (config.filters.enableWalletQualityGate == null) {
    config.filters.enableWalletQualityGate = true;
  }
  if (
    config.filters.minWalletQualityScore == null ||
    !Number.isFinite(Number(config.filters.minWalletQualityScore))
  ) {
    config.filters.minWalletQualityScore = 55;
  }
  if (
    config.filters.walletQualityInactiveDays == null ||
    !Number.isFinite(Number(config.filters.walletQualityInactiveDays))
  ) {
    config.filters.walletQualityInactiveDays = 5;
  }
  if (config.filters.enableWalletQualityAutoPrune == null) {
    config.filters.enableWalletQualityAutoPrune = false;
  }
  if (
    config.filters.maxEntryAgeMinutes == null ||
    !Number.isFinite(Number(config.filters.maxEntryAgeMinutes))
  ) {
    config.filters.maxEntryAgeMinutes = 15;
  }
  if (
    config.filters.preferEntryWithinMinutes == null ||
    !Number.isFinite(Number(config.filters.preferEntryWithinMinutes))
  ) {
    config.filters.preferEntryWithinMinutes = 10;
  }
  if (config.filters.rejectDumpingToken == null) {
    config.filters.rejectDumpingToken = true;
  }
  if (
    config.filters.maxDrawdownFromRecentHighPct == null ||
    !Number.isFinite(Number(config.filters.maxDrawdownFromRecentHighPct))
  ) {
    config.filters.maxDrawdownFromRecentHighPct = 35;
  }
  if (config.filters.enableEntryTimingGate == null) {
    config.filters.enableEntryTimingGate = true;
  }
  if (
    config.filters.clusterMinWallets == null ||
    !Number.isFinite(Number(config.filters.clusterMinWallets))
  ) {
    config.filters.clusterMinWallets = 2;
  }
  if (
    config.filters.clusterWindowMinutes == null ||
    !Number.isFinite(Number(config.filters.clusterWindowMinutes))
  ) {
    config.filters.clusterWindowMinutes = 5;
  }
  if (config.filters.allowSingleWalletTopPerformerMigration == null) {
    config.filters.allowSingleWalletTopPerformerMigration = true;
  }
  if (
    config.filters.smartMoneyFlowWeight == null ||
    !Number.isFinite(Number(config.filters.smartMoneyFlowWeight))
  ) {
    config.filters.smartMoneyFlowWeight = 1.35;
  }
  if (config.filters.requireMomentumConfirmation == null) {
    config.filters.requireMomentumConfirmation = false;
  }
  if (
    config.filters.momentumLookbackMinutes == null ||
    !Number.isFinite(Number(config.filters.momentumLookbackMinutes))
  ) {
    config.filters.momentumLookbackMinutes = 15;
  }
  if (
    config.filters.momentumMinHoldPct == null ||
    !Number.isFinite(Number(config.filters.momentumMinHoldPct))
  ) {
    config.filters.momentumMinHoldPct = -5;
  }
  if (config.bondingCurve.requireHealthyCurve == null) {
    config.bondingCurve.requireHealthyCurve = false;
  }
  if (config.bondingCurve.minCurveProgress == null) {
    config.bondingCurve.minCurveProgress = 0;
  }
  if (config.bondingCurve.maxCurveProgressForEntry == null) {
    config.bondingCurve.maxCurveProgressForEntry = 98;
  }
  if (config.bondingCurve.preferNearMigrationMinPct == null) {
    config.bondingCurve.preferNearMigrationMinPct = 70;
  }
  if (config.bondingCurve.preferNearMigrationMaxPct == null) {
    config.bondingCurve.preferNearMigrationMaxPct = 95;
  }
  if (config.bondingCurve.requireRecentCurveActivity == null) {
    config.bondingCurve.requireRecentCurveActivity = true;
  }
  if (config.trade.baseTradeAmountSol != null) {
    config.trade.tradeAmountSol = config.trade.baseTradeAmountSol;
  } else if (config.trade.tradeAmountSol != null) {
    config.trade.baseTradeAmountSol = config.trade.tradeAmountSol;
  }
  if (
    config.trade.maxAllowedTradeSol == null ||
    !Number.isFinite(Number(config.trade.maxAllowedTradeSol)) ||
    Number(config.trade.maxAllowedTradeSol) <= 0
  ) {
    config.trade.maxAllowedTradeSol = DEFAULT_MAX_ALLOWED_TRADE_SOL;
  }
  if (config.trade.riskMultiplier == null) {
    config.trade.riskMultiplier = 0.45;
  }
  if (config.trade.convictionMultiplier == null) {
    config.trade.convictionMultiplier = 1.5;
  }
  if (
    Number.isFinite(config.trade.maxProfitPercent) &&
    config.trade.maxProfitPercent > MAX_PROFIT_PERCENT_CEILING
  ) {
    config.trade.maxProfitPercent = MAX_PROFIT_PERCENT_CEILING;
  }
  if (config.risk.trailingStopPercent != null) {
    config.risk.trailingStopPct = config.risk.trailingStopPercent;
  } else if (config.risk.trailingStopPct != null) {
    config.risk.trailingStopPercent = config.risk.trailingStopPct;
  }
  // Fill dead-volume defaults for older persisted risk blobs
  if (config.risk.enableDeadVolumeExit == null) {
    config.risk.enableDeadVolumeExit = DEFAULT_RISK.enableDeadVolumeExit;
  }
  if (config.risk.deadVolumeUsdPerHour == null) {
    config.risk.deadVolumeUsdPerHour = DEFAULT_RISK.deadVolumeUsdPerHour;
  }
  if (config.risk.deadVolumeConsecutiveHours == null) {
    config.risk.deadVolumeConsecutiveHours =
      DEFAULT_RISK.deadVolumeConsecutiveHours;
  }
  if (config.risk.deadVolumeMinHoldMinutes == null) {
    config.risk.deadVolumeMinHoldMinutes =
      DEFAULT_RISK.deadVolumeMinHoldMinutes;
  }
  if (config.risk.lowConvictionTrailThreshold == null) {
    config.risk.lowConvictionTrailThreshold =
      DEFAULT_RISK.lowConvictionTrailThreshold;
  }
  if (config.risk.lowConvictionTrailTightenPct == null) {
    config.risk.lowConvictionTrailTightenPct =
      DEFAULT_RISK.lowConvictionTrailTightenPct;
  }
  // Post-exit re-entry defaults (v1.1.39+) for older persisted strategy blobs
  if (config.strategy.postStopReentryEnabled == null) {
    config.strategy.postStopReentryEnabled = true;
  }
  if (config.strategy.reEntryMaxPerMint == null) {
    config.strategy.reEntryMaxPerMint = config.strategy.reBuyMaxPerMint ?? 2;
  }
  if (config.strategy.reEntryWatchMinutes == null) {
    config.strategy.reEntryWatchMinutes = 90;
  }
  if (config.strategy.reEntryMinReclaimPct == null) {
    config.strategy.reEntryMinReclaimPct = 8;
  }
  if (config.strategy.reEntryMinVolumeIncreasePct == null) {
    config.strategy.reEntryMinVolumeIncreasePct =
      config.strategy.reBuyVolumeIncreasePct ?? 50;
  }
  if (config.strategy.reEntryConfirmationWallets == null) {
    config.strategy.reEntryConfirmationWallets =
      config.strategy.confirmationThreshold ?? 3;
  }
  if (config.strategy.reEntrySizeMultiplier == null) {
    config.strategy.reEntrySizeMultiplier = 0.65;
  }
  if (config.strategy.reEntryCooldownMinutes == null) {
    config.strategy.reEntryCooldownMinutes = 8;
  }
  if (config.strategy.reEntryAfterMaxProfitEnabled == null) {
    config.strategy.reEntryAfterMaxProfitEnabled = false;
  }
}

export type ApplySettingsSnapshotOptions = {
  /**
   * When true, strategyToggles are replaced from the snapshot (or cleared so
   * they can be re-derived). Used for site-backup restore so pre-restore
   * in-memory toggles cannot linger.
   */
  replaceStrategyToggles?: boolean;
};

/**
 * Apply a settings snapshot onto `config`.
 * - merge: saved keys win; missing keys keep current (code updates survive)
 * - replace: overwrite tunable sections from the snapshot (Reset to Defaults)
 */
function applySettingsSnapshot(
  saved: PersistedBotSettings,
  mode: 'merge' | 'replace',
  options?: ApplySettingsSnapshotOptions
): void {
  if (
    saved.mode === 'paper' ||
    saved.mode === 'liveSimulation' ||
    saved.mode === 'live'
  ) {
    config.mode = saved.mode;
  }
  if (saved.riskLevel != null) {
    config.riskLevel = normalizeRiskLevel(saved.riskLevel);
  }

  if (mode === 'replace') {
    if (saved.trade)
      config.trade = cloneJson(saved.trade) as unknown as typeof config.trade;
    if (saved.filters)
      config.filters = cloneJson(
        saved.filters
      ) as unknown as typeof config.filters;
    if (saved.strategy)
      config.strategy = cloneJson(
        saved.strategy
      ) as unknown as typeof config.strategy;
    if (saved.risk)
      config.risk = cloneJson(saved.risk) as unknown as typeof config.risk;
    if (saved.profitStrategy) {
      config.profitStrategy = cloneJson(
        saved.profitStrategy
      ) as unknown as typeof config.profitStrategy;
    }
    if (saved.quickScalper) {
      config.quickScalper = cloneJson(
        saved.quickScalper
      ) as unknown as typeof config.quickScalper;
    }
    if (saved.microScalper) {
      config.microScalper = cloneJson(
        saved.microScalper
      ) as unknown as typeof config.microScalper;
    }
    if (saved.momentumBurst) {
      config.momentumBurst = cloneJson(
        saved.momentumBurst
      ) as unknown as typeof config.momentumBurst;
    }
    if (saved.postMigrationScalp) {
      config.postMigrationScalp = cloneJson(
        saved.postMigrationScalp
      ) as unknown as typeof config.postMigrationScalp;
    }
    if (saved.reversalScalp) {
      config.reversalScalp = cloneJson(
        saved.reversalScalp
      ) as unknown as typeof config.reversalScalp;
    }
    if (saved.postRunDip) {
      config.postRunDip = deepMerge(
        { ...DEFAULT_POST_RUN_DIP },
        saved.postRunDip
      ) as unknown as typeof config.postRunDip;
    }
    if (saved.technicalLevels) {
      config.technicalLevels = deepMerge(
        { ...DEFAULT_TECHNICAL_LEVELS },
        saved.technicalLevels
      ) as unknown as typeof config.technicalLevels;
    }
    if (saved.chartPatterns) {
      config.chartPatterns = deepMerge(
        {
          ...DEFAULT_CHART_PATTERNS,
          patterns: { ...DEFAULT_CHART_PATTERNS.patterns },
        },
        saved.chartPatterns
      ) as unknown as typeof config.chartPatterns;
    }
    if (saved.selective) {
      config.selective = cloneJson(
        saved.selective
      ) as unknown as typeof config.selective;
    }
    if (saved.paper)
      config.paper = cloneJson(saved.paper) as unknown as typeof config.paper;
    if (saved.notifications) {
      config.notifications = cloneJson(
        saved.notifications
      ) as unknown as typeof config.notifications;
    }
    if (saved.mev)
      config.mev = cloneJson(saved.mev) as unknown as typeof config.mev;
    if (saved.gmgnDiscovery) {
      config.gmgn.discovery = cloneJson(
        saved.gmgnDiscovery
      ) as unknown as typeof config.gmgn.discovery;
    }
    if (saved.tokenMetrics) {
      config.tokenMetrics = cloneJson(
        saved.tokenMetrics
      ) as unknown as typeof config.tokenMetrics;
    }
    if (saved.bondingCurve) {
      config.bondingCurve = cloneJson(
        saved.bondingCurve
      ) as unknown as typeof config.bondingCurve;
    }
  } else {
    if (saved.trade) config.trade = deepMerge(config.trade, saved.trade);
    if (saved.filters) config.filters = deepMerge(config.filters, saved.filters);
    if (saved.strategy)
      config.strategy = deepMerge(config.strategy, saved.strategy);
    if (saved.risk) config.risk = deepMerge(config.risk, saved.risk);
    if (saved.profitStrategy) {
      config.profitStrategy = deepMerge(
        config.profitStrategy,
        saved.profitStrategy
      );
    }
    if (saved.quickScalper) {
      config.quickScalper = deepMerge(
        config.quickScalper,
        saved.quickScalper
      );
    }
    if (saved.microScalper) {
      config.microScalper = deepMerge(config.microScalper, saved.microScalper);
    }
    if (saved.momentumBurst) {
      config.momentumBurst = deepMerge(
        config.momentumBurst,
        saved.momentumBurst
      );
    }
    if (saved.postMigrationScalp) {
      config.postMigrationScalp = deepMerge(
        config.postMigrationScalp,
        saved.postMigrationScalp
      );
    }
    if (saved.reversalScalp) {
      config.reversalScalp = deepMerge(
        config.reversalScalp,
        saved.reversalScalp
      );
    }
    if (saved.postRunDip) {
      config.postRunDip = deepMerge(config.postRunDip, saved.postRunDip);
    }
    if (saved.technicalLevels) {
      config.technicalLevels = deepMerge(
        config.technicalLevels,
        saved.technicalLevels
      );
    }
    if (saved.chartPatterns) {
      config.chartPatterns = deepMerge(
        config.chartPatterns,
        saved.chartPatterns
      );
    }
    if (saved.selective) {
      config.selective = deepMerge(config.selective, saved.selective);
    }
    if (saved.paper) config.paper = deepMerge(config.paper, saved.paper);
    if (saved.notifications) {
      config.notifications = deepMerge(
        config.notifications,
        saved.notifications
      );
    }
    if (saved.marketScanner) {
      config.marketScanner = deepMerge(
        config.marketScanner,
        saved.marketScanner as typeof config.marketScanner
      );
    }
    if (saved.alphaScan) {
      config.alphaScan = deepMerge(
        config.alphaScan,
        saved.alphaScan as typeof config.alphaScan
      );
    }
    if (saved.zion) {
      config.zion = deepMerge(
        config.zion,
        saved.zion as unknown as typeof config.zion
      );
    }
    if (saved.mev) config.mev = deepMerge(config.mev, saved.mev);
    if (saved.gmgnDiscovery) {
      config.gmgn.discovery = deepMerge(
        config.gmgn.discovery,
        saved.gmgnDiscovery
      );
    }
    if (saved.tokenMetrics) {
      config.tokenMetrics = deepMerge(config.tokenMetrics, saved.tokenMetrics);
    }
    if (saved.bondingCurve) {
      config.bondingCurve = deepMerge(config.bondingCurve, saved.bondingCurve);
    }
  }

  if (saved.walletDiscovery) {
    if (saved.walletDiscovery.defaultSource) {
      config.walletDiscovery.defaultSource = saved.walletDiscovery
        .defaultSource as typeof config.walletDiscovery.defaultSource;
    }
    if (saved.walletDiscovery.cacheTtlMs != null) {
      config.walletDiscovery.cacheTtlMs = Number(
        saved.walletDiscovery.cacheTtlMs
      );
    }
  }
  if (typeof saved.convergenceWindowMs === 'number') {
    config.convergenceWindowMs = saved.convergenceWindowMs;
  }
  if (typeof saved.pollIntervalMs === 'number') {
    config.pollIntervalMs = saved.pollIntervalMs;
  }
  if (typeof saved.rpcShareLoad === 'boolean') {
    config.rpc.shareLoad = saved.rpcShareLoad;
  }

  if (saved.strategyToggles && typeof saved.strategyToggles === 'object') {
    if (options?.replaceStrategyToggles) {
      // Full replace — do not keep pre-restore in-memory keys absent from backup
      config.strategyToggles = { ...saved.strategyToggles };
    } else {
      config.strategyToggles = {
        ...(config.strategyToggles || {}),
        ...saved.strategyToggles,
      };
    }
  } else if (options?.replaceStrategyToggles) {
    // No toggles in snapshot — clear so ensureStrategyToggles can derive from
    // restored underlying filter/strategy flags.
    config.strategyToggles = {};
  }
  if (
    saved.strategyProfile === 'balanced' ||
    saved.strategyProfile === 'high_win_rate' ||
    saved.strategyProfile === 'win_rate_55_60' ||
    saved.strategyProfile === 'aggressive' ||
    saved.strategyProfile === 'quick_scalper' ||
    saved.strategyProfile === 'micro_scalper' ||
    saved.strategyProfile === 'momentum_burst' ||
    saved.strategyProfile === 'post_migration_scalp' ||
    saved.strategyProfile === 'reversal_scalp' ||
    saved.strategyProfile === 'scalper_suite' ||
    saved.strategyProfile === 'aggressive_scalper' ||
    saved.strategyProfile === 'conservative_scalper' ||
    saved.strategyProfile === 'custom'
  ) {
    config.strategyProfile = saved.strategyProfile;
  }
  if (typeof saved.highWinRatePresetActive === 'boolean') {
    config.highWinRatePresetActive = saved.highWinRatePresetActive;
  }
  // Missing field = existing install → custom (don't silently rewrite toggles).
  // Fresh installs keep code default 'synced'.
  if (saved.strategyRecipeMode === 'synced' || saved.strategyRecipeMode === 'custom') {
    config.strategyRecipeMode = saved.strategyRecipeMode;
  } else if (
    saved.strategyToggles &&
    typeof saved.strategyToggles === 'object' &&
    Object.keys(saved.strategyToggles).length > 0
  ) {
    config.strategyRecipeMode = 'custom';
  }
  if (saved.strategyRecipeRiskLevel === null) {
    config.strategyRecipeRiskLevel = null;
  } else if (saved.strategyRecipeRiskLevel != null) {
    config.strategyRecipeRiskLevel = normalizeRiskLevel(saved.strategyRecipeRiskLevel);
  }
  if (
    saved.riskRecipeOptimizations &&
    typeof saved.riskRecipeOptimizations === 'object'
  ) {
    config.riskRecipeOptimizations = JSON.parse(
      JSON.stringify(saved.riskRecipeOptimizations)
    ) as typeof config.riskRecipeOptimizations;
  }
  if (saved.tradeProfiles && typeof saved.tradeProfiles === 'object') {
    const tp = saved.tradeProfiles;
    if (!config.tradeProfiles) {
      config.tradeProfiles = {
        enabled: true,
        smartBotProfiles: true,
        profiles: {
          default: true,
          scalper: true,
          dip_buyer: true,
          trend_rider: true,
          migration_sniper: true,
          high_win_rate: true,
          momentum_burst: true,
          steady_compounder: true,
          reversal_scalper: true,
          smart_money_mirror: true,
          zion: true,
        },
      };
    }
    if (typeof tp.enabled === 'boolean') {
      config.tradeProfiles.enabled = tp.enabled;
    }
    if (typeof (tp as { smartBotProfiles?: boolean }).smartBotProfiles === 'boolean') {
      config.tradeProfiles.smartBotProfiles = (
        tp as { smartBotProfiles: boolean }
      ).smartBotProfiles;
    }
    if (tp.profiles && typeof tp.profiles === 'object') {
      config.tradeProfiles.profiles = {
        ...config.tradeProfiles.profiles,
        ...tp.profiles,
        default: true,
      };
    }
    // Deep-replace overrides when present so nested exitRules/match/modules
    // (e.g. maxTradeOverrideSol) are not lost to shallow per-profile merges.
    if (tp.overrides && typeof tp.overrides === 'object') {
      config.tradeProfiles.overrides = cloneJson(tp.overrides) as NonNullable<
        typeof config.tradeProfiles.overrides
      >;
    }
    if (tp.autoScoring && typeof tp.autoScoring === 'object') {
      config.tradeProfiles.autoScoring = cloneJson({
        ...(config.tradeProfiles.autoScoring || {}),
        ...tp.autoScoring,
        weights: {
          ...(config.tradeProfiles.autoScoring?.weights || {}),
          ...((tp.autoScoring as { weights?: Record<string, number> }).weights ||
            {}),
        },
      }) as NonNullable<typeof config.tradeProfiles.autoScoring>;
    }
    if (
      (tp as { selfLearning?: unknown }).selfLearning &&
      typeof (tp as { selfLearning?: unknown }).selfLearning === 'object'
    ) {
      (config.tradeProfiles as { selfLearning?: unknown }).selfLearning =
        cloneJson((tp as { selfLearning: unknown }).selfLearning);
    }
    if (
      (tp as { globalTakeProfit?: unknown }).globalTakeProfit &&
      typeof (tp as { globalTakeProfit?: unknown }).globalTakeProfit === 'object'
    ) {
      const g = (tp as {
        globalTakeProfit: { enabled?: boolean; takeProfitPct?: number };
      }).globalTakeProfit;
      config.tradeProfiles.globalTakeProfit = {
        enabled: g.enabled === true,
        takeProfitPct:
          g.takeProfitPct != null && Number.isFinite(Number(g.takeProfitPct))
            ? Math.max(1, Math.min(5000, Number(g.takeProfitPct)))
            : 25,
      };
    }
  }
  if (saved.learningMode && typeof saved.learningMode === 'object') {
    try {
      const { normalizeLearningModeConfig } =
        require('./learningMode') as typeof import('./learningMode');
      config.learningMode = normalizeLearningModeConfig(
        saved.learningMode as import('./learningMode').LearningModeConfig
      );
    } catch {
      config.learningMode = {
        enabled: saved.learningMode.enabled === true,
        strictness:
          saved.learningMode.strictness === 'stricter' ||
          saved.learningMode.strictness === 'looser' ||
          saved.learningMode.strictness === 'middle'
            ? saved.learningMode.strictness
            : 'middle',
        snapshot:
          saved.learningMode.snapshot &&
          typeof saved.learningMode.snapshot === 'object'
            ? (cloneJson(saved.learningMode.snapshot) as unknown as import('./learningMode').LearningModeConfig['snapshot'])
            : null,
        fairnessBoost: saved.learningMode.fairnessBoost !== false,
      };
    }
  }
  // Momentum Burst: prefer timeLimitSeconds (migrate legacy minutes)
  {
    const mb = config.momentumBurst;
    let sec = Number(mb?.timeLimitSeconds);
    if (!Number.isFinite(sec) || sec < 60) {
      const mins = Number(mb?.timeLimitMinutes);
      sec = [2, 3, 4].includes(mins) ? mins * 60 : DEFAULT_MOMENTUM_BURST.timeLimitSeconds;
    }
    config.momentumBurst.timeLimitSeconds = Math.max(60, Math.min(300, Math.round(sec)));
  }
  if (saved.strategyProfileSnapshot === null) {
    config.strategyProfileSnapshot = null;
  } else if (
    saved.strategyProfileSnapshot &&
    typeof saved.strategyProfileSnapshot === 'object'
  ) {
    config.strategyProfileSnapshot = cloneJson(
      saved.strategyProfileSnapshot
    ) as typeof config.strategyProfileSnapshot;
  }

  syncConfigAliases();
}

/**
 * Apply a settings snapshot from Strategy Control Center Import JSON
 * (or similar). Does not load from disk — caller persists when ready.
 */
export function applyImportedSettingsSnapshot(
  saved: PersistedBotSettings,
  mode: 'merge' | 'replace' = 'replace'
): void {
  applySettingsSnapshot(saved, mode);
}

/**
 * After restore: fill any new module keys from defaults, then push toggles
 * into underlying filter/strategy enabled flags so Settings + gates agree.
 */
function syncStrategyTogglesFromRestoredSettings(): void {
  try {
    const {
      ensureStrategyToggles,
      syncUnderlyingFlagsFromToggles,
    } = require('./strategies') as typeof import('./strategies');
    const toggles = ensureStrategyToggles();
    syncUnderlyingFlagsFromToggles(toggles);
    console.log(
      `[settings] Restored strategy toggles synced (${Object.keys(toggles).filter((k) => toggles[k as keyof typeof toggles]).length} ON)`
    );
  } catch (err) {
    console.warn(
      '[settings] strategy toggle sync after restore failed:',
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Apply data/config.json on top of code/env defaults.
 * Saved keys win; new keys from code updates keep their defaults.
 *
 * Pass `{ replaceStrategyToggles: true }` after site-backup restore so module
 * ON/OFF state matches disk (no leftover in-memory toggles).
 */
export function applyPersistedSettings(opts?: {
  replaceStrategyToggles?: boolean;
}): boolean {
  const saved = loadPersistedSettings();
  if (!saved) {
    console.log('[settings] No config.json — using code/env defaults');
    return false;
  }

  applySettingsSnapshot(saved, 'merge', {
    replaceStrategyToggles: opts?.replaceStrategyToggles === true,
  });
  settingsMigrations = { ...(saved.migrations ?? {}) };

  if (applyTradingModeLiveSimMigration()) {
    settingsMigrations[TRADING_MODE_LIVE_SIM_V1143] = true;
    persistUserSettings();
    console.log(
      `[settings] Applied tradingMode_liveSim_v1143 — mode=${config.mode}`
    );
  }

  if (applyTradingModeLiveSimDefaultV2()) {
    settingsMigrations[TRADING_MODE_LIVE_SIM_DEFAULT_V2] = true;
    persistUserSettings();
    console.log(
      `[settings] Applied tradingMode_liveSimDefault_v2 — mode=${config.mode}`
    );
  }

  if (applyPaperSignalRelaxMigration()) {
    settingsMigrations[PAPER_SIGNAL_RELAX_MIGRATION] = true;
    persistUserSettings();
    console.log(
      '[settings] Applied paperSignalRelax_v2 — loosened mint-authority / liq / vol / holder gates so early Pump.fun paper signals can fire'
    );
  }

  if (applyMigrationFocusOffMigration()) {
    settingsMigrations[MIGRATION_FOCUS_OFF_V1] = true;
    persistUserSettings();
    console.log(
      '[settings] Applied migrationFocus_off_v1 — enableMigrationOnly OFF (default)'
    );
  }

  if (applyRequireHealthyCurveOffMigration()) {
    settingsMigrations[REQUIRE_HEALTHY_CURVE_OFF_V1] = true;
    persistUserSettings();
    console.log(
      '[settings] Applied requireHealthyCurve_off_v1 — requireHealthyCurve OFF (default)'
    );
  }

  if (applyHardVolumeLiquidityFloorsMigration()) {
    settingsMigrations[HARD_VOLUME_LIQ_FLOORS_V113] = true;
    persistUserSettings();
    console.log(
      '[settings] Applied hardVolumeLiquidityFloors_v113 — absolute liq/vol/holder floors (non-bypassable)'
    );
  }

  if (applyHardVolumeLiquidityFloorsV1144Migration()) {
    settingsMigrations[HARD_VOLUME_LIQ_FLOORS_V1144] = true;
    persistUserSettings();
    console.log(
      `[settings] Applied hardVolumeLiquidityFloors_v1144 — liq≥$${HARD_FILTER_FLOORS.minLiquidityUsd} ` +
        `mc≥$${HARD_FILTER_FLOORS.minMarketCapUsd} vol24h≥$${HARD_FILTER_FLOORS.minVolume24hUsd} ` +
        `recent≥$${HARD_FILTER_FLOORS.minRecentVolumeUsd}`
    );
  }

  if (applyRiskLevelSyncMigration()) {
    settingsMigrations[RISK_LEVEL_SYNC_V1] = true;
    persistUserSettings();
    console.log(
      `[settings] Applied riskLevelSync_v1 — re-applied ${normalizeRiskLevel(config.riskLevel).toUpperCase()} risk presets onto live knobs`
    );
  }

  if (applyMaxProfitDefaultMigration()) {
    settingsMigrations[MAX_PROFIT_DEFAULT_V1123] = true;
    persistUserSettings();
    console.log(
      `[settings] Applied maxProfitDefault_v1123 — maxProfitPercent now ${config.trade.maxProfitPercent}% (default ${NEW_MAX_PROFIT_DEFAULT}, ceiling ${MAX_PROFIT_PERCENT_CEILING})`
    );
  }

  if (applyHolderConcentrationFloorsMigration()) {
    settingsMigrations[HOLDER_CONCENTRATION_FLOORS_V1124] = true;
    persistUserSettings();
    console.log(
      `[settings] Applied holderConcentrationFloors_v1124 — minTop10HolderPct=${config.filters.minTop10HolderPct}% (hard floor ${HARD_FILTER_FLOORS.minTop10HolderPct}%), maxInsider hard cap ${HARD_FILTER_FLOORS.maxInsiderPct}%`
    );
  }

  if (applyMediumEntryRestoreMigration()) {
    settingsMigrations[MEDIUM_ENTRY_RESTORE_V1125] = true;
    persistUserSettings();
    console.log(
      `[settings] Applied mediumEntryRestore_v1125 — maxTopHold=${config.filters.maxTopHolderPct}% ` +
        `maxRisk=${config.filters.maxRiskScore} conviction≥${config.selective.minConvictionScore} ` +
        `maxPos=${config.filters.maxConcurrentPositions} riskLevel=${config.riskLevel}`
    );
  }

  if (applyMinMarketCapFloorMigration()) {
    settingsMigrations[MIN_MARKET_CAP_FLOOR_V1129] = true;
    persistUserSettings();
    console.log(
      `[settings] Applied minMarketCapFloor_v1129 — minMarketCapUsd=${config.filters.minMarketCapUsd} (hard floor $${HARD_FILTER_FLOORS.minMarketCapUsd})`
    );
  }

  if (applyBuyPumpFunOnlyOnMigration()) {
    settingsMigrations[BUY_PUMP_FUN_ONLY_ON_V1131] = true;
    persistUserSettings();
    console.log(
      '[settings] Applied buyPumpFunOnly_on_v1131 — buyPumpFunOnly ON (only mints ending in pump)'
    );
  }

  if (applyWalletQualityEntryMigration()) {
    settingsMigrations[WALLET_QUALITY_ENTRY_V1133] = true;
    persistUserSettings();
    console.log(
      `[settings] Applied walletQualityEntry_v1133 — quality gate ON (min ${config.filters.minWalletQualityScore}), ` +
        `cluster≥${config.filters.clusterMinWallets}, entry age≤${config.filters.maxEntryAgeMinutes}m, ` +
        `conviction≥${config.selective.minConvictionScore}`
    );
  }

  console.log(
    `[settings] Loaded config.json (updated ${new Date(saved.updatedAt || 0).toISOString()}) — saved values kept over code defaults`
  );

  // Seed strategy toggles from persisted map or derive from current flags
  try {
    // Lazy import avoids circular init with strategies ↔ config
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ensureStrategyToggles } = require('./strategies') as typeof import('./strategies');
    ensureStrategyToggles();
  } catch (err) {
    console.warn(
      '[settings] strategy toggles seed skipped:',
      err instanceof Error ? err.message : err
    );
  }

  if (!settingsMigrations[SMART_BOT_DEFAULT_ON_V1]) {
    if (!config.tradeProfiles) {
      (config as { tradeProfiles?: { smartBotProfiles?: boolean } }).tradeProfiles =
        { smartBotProfiles: true };
    } else {
      config.tradeProfiles.smartBotProfiles = true;
    }
    settingsMigrations[SMART_BOT_DEFAULT_ON_V1] = true;
    try {
      const { setSmartBotProfilesEnabled, ensureTradeProfilesInitialized } =
        require('./tradeProfiles') as typeof import('./tradeProfiles');
      ensureTradeProfilesInitialized();
      setSmartBotProfilesEnabled(true);
    } catch {
      /* tradeProfiles may not be ready */
    }
    persistUserSettings();
    console.log(
      '[settings] Applied smartBotDefaultOn_v1 — Smart Bot Profiles ON by default'
    );
  }

  if (!settingsMigrations[ZION_DEFAULT_ON_V1]) {
    if (!config.zion) {
      // Should already exist from code defaults; keep defensive.
      (config as { zion?: { enabled?: boolean; scanner?: { enabled?: boolean } } }).zion =
        { enabled: true, scanner: { enabled: true } };
    } else {
      config.zion.enabled = true;
      if (!config.zion.scanner) {
        config.zion.scanner = {
          enabled: true,
          pollIntervalMs: 30_000,
          universeSize: 60,
          activityLookbackMinutes: 45,
          batchSize: 6,
        };
      } else {
        config.zion.scanner.enabled = true;
      }
      if (config.zion.autoOfferFromScanner == null) {
        config.zion.autoOfferFromScanner = true;
      }
    }
    settingsMigrations[ZION_DEFAULT_ON_V1] = true;
    persistUserSettings();
    console.log(
      '[settings] Applied zionDefaultOn_v1 — Zion + KOL scanner ON by default'
    );
  }

  if (!settingsMigrations[ZION_SAFEGUARDS_V1]) {
    config.zion.minKolWallets = 5;
    config.zion.minWalletQuality = 40;
    config.zion.minMcUsd = 50_000;
    config.zion.maxMcUsd = 500_000_000;
    config.zion.offerTtlMinutes = 60;
    config.zion.mintCooldownMinutes = 120;
    if (!config.zion.scanner) {
      config.zion.scanner = {
        enabled: true,
        pollIntervalMs: 30_000,
        universeSize: 60,
        activityLookbackMinutes: 45,
        batchSize: 6,
      };
    } else {
      config.zion.scanner.pollIntervalMs = 30_000;
      config.zion.scanner.universeSize = 60;
    }
    settingsMigrations[ZION_SAFEGUARDS_V1] = true;
    settingsMigrations[ZION_MIN_KOL_V2] = true;
    persistUserSettings();
    console.log(
      '[settings] Applied zionSafeguards_v1 — Min MC $50k / Max MC $500M, quality 40, min KOLs 5, poll 30s'
    );
  }

  if (!settingsMigrations[ZION_MIN_KOL_V2]) {
    // Raise default floor from legacy 2 → 5 (skip if user already customized above 2)
    if (
      config.zion.minKolWallets == null ||
      Number(config.zion.minKolWallets) <= 2
    ) {
      config.zion.minKolWallets = 5;
    }
    settingsMigrations[ZION_MIN_KOL_V2] = true;
    persistUserSettings();
    console.log(
      `[settings] Applied zionMinKol_v2 — Min KOL wallets default ${config.zion.minKolWallets}`
    );
  }

  if (!settingsMigrations[SELF_LEARNING_DEFAULT_ON_V1]) {
    try {
      const { ensureSelfLearningDefaultsForAllProfiles, ensureTradeProfilesInitialized } =
        require('./tradeProfiles') as typeof import('./tradeProfiles');
      ensureTradeProfilesInitialized();
      // Force ON once: older builds defaulted to off and may have persisted enabled:false
      const seeded = ensureSelfLearningDefaultsForAllProfiles({
        forceEnableAll: true,
        persist: true,
      });
      settingsMigrations[SELF_LEARNING_DEFAULT_ON_V1] = true;
      persistUserSettings();
      console.log(
        `[settings] Applied selfLearningDefaultOn_v1 — self-learning ON by default` +
          (seeded ? ` (seeded ${seeded} profile(s))` : '')
      );
    } catch (err) {
      console.warn(
        '[settings] selfLearningDefaultOn_v1 failed:',
        err instanceof Error ? err.message : err
      );
    }
  }

  if (!settingsMigrations[NOTIFY_EMAIL_BONDBACK_V1]) {
    const prev = String(config.notifications?.email || '').trim().toLowerCase();
    // Migrate only the previous built-in default (or empty) — keep custom addresses
    if (
      !prev ||
      prev === 'isaacpascua87@gmail.com' ||
      prev === 'bondback2026@gmail.com'
    ) {
      config.notifications.email =
        process.env.NOTIFY_EMAIL?.trim() || 'bondback2026@gmail.com';
    }
    settingsMigrations[NOTIFY_EMAIL_BONDBACK_V1] = true;
    persistUserSettings();
    console.log(
      `[settings] Applied notifyEmailBondback_v1 — notify email ${config.notifications.email}`
    );
  }

  if (opts?.replaceStrategyToggles) {
    syncStrategyTogglesFromRestoredSettings();
  }

  return true;
}

/** Migrate plain-paper installs once; never replace an existing live selection. */
function applyTradingModeLiveSimMigration(): boolean {
  if (settingsMigrations[TRADING_MODE_LIVE_SIM_V1143]) return false;
  if (config.mode === 'paper') config.mode = 'liveSimulation';
  return true;
}

/**
 * Re-assert Live Sim over stale Paper (deploy / wiped-disk default).
 * Skips real `live`. Safe to run even if v1143 already fired.
 */
function applyTradingModeLiveSimDefaultV2(): boolean {
  if (settingsMigrations[TRADING_MODE_LIVE_SIM_DEFAULT_V2]) return false;
  if (config.mode === 'paper') {
    config.mode = 'liveSimulation';
    config.paper.useLiveData = true;
  }
  return true;
}

function applyPaperSignalRelaxMigration(): boolean {
  if (settingsMigrations[PAPER_SIGNAL_RELAX_MIGRATION]) return false;

  let changed = false;
  if (config.filters.skipIfMintAuthority) {
    config.filters.skipIfMintAuthority = false;
    changed = true;
  }
  if ((config.filters.minLiquidity ?? 0) >= 8_000) {
    config.filters.minLiquidity = 2_000;
    changed = true;
  }
  if ((config.filters.minVolume24hUsd ?? 0) >= 5_000) {
    config.filters.minVolume24hUsd = 1_000;
    changed = true;
  }
  if ((config.filters.minHolderCount ?? 0) >= 30) {
    config.filters.minHolderCount = 10;
    changed = true;
  }
  if ((config.filters.convergenceRequired ?? 3) >= 3) {
    config.filters.convergenceRequired = 2;
    changed = true;
  }
  if ((config.filters.maxConcurrentPositions ?? 0) < 5) {
    config.filters.maxConcurrentPositions = 5;
    changed = true;
  }
  if ((config.filters.maxRiskScore ?? 0) > 0 && config.filters.maxRiskScore < 65) {
    config.filters.maxRiskScore = 65;
    changed = true;
  }
  if ((config.selective.minWalletsForTrade ?? 2) > 1) {
    config.selective.minWalletsForTrade = 1;
    changed = true;
  }
  if ((config.selective.minConvictionScore ?? 55) >= 55) {
    config.selective.minConvictionScore = 45;
    changed = true;
  }
  if ((config.selective.minVolume24hUsd ?? 0) >= 5_000) {
    config.selective.minVolume24hUsd = 1_000;
    changed = true;
  }
  if ((config.selective.minHolderCount ?? 0) >= 30) {
    config.selective.minHolderCount = 10;
    changed = true;
  }
  if (
    (config.selective.maxTradesPerHour ?? 0) > 0 &&
    (config.selective.maxTradesPerHour ?? 0) < 12
  ) {
    config.selective.maxTradesPerHour = 12;
    changed = true;
  }
  if ((config.selective.minMsBetweenTrades ?? 0) >= 90_000) {
    config.selective.minMsBetweenTrades = 45_000;
    changed = true;
  }
  return changed;
}

/** Undo migrationFocus_v1 force-on so redeploys keep Migration Only OFF by default. */
function applyMigrationFocusOffMigration(): boolean {
  if (settingsMigrations[MIGRATION_FOCUS_OFF_V1]) return false;
  if (!config.strategy.enableMigrationOnly) return true;
  config.strategy.enableMigrationOnly = false;
  return true;
}

/** Undo dead-token default ON so redeploys keep requireHealthyCurve OFF by default. */
function applyRequireHealthyCurveOffMigration(): boolean {
  if (settingsMigrations[REQUIRE_HEALTHY_CURVE_OFF_V1]) return false;
  if (!config.bondingCurve.requireHealthyCurve) return true;
  config.bondingCurve.requireHealthyCurve = false;
  return true;
}

/**
 * Raise persisted filters to absolute hard floors after paperSignalRelax lowered them.
 * Always marks the migration done so it runs once.
 */
function applyHardVolumeLiquidityFloorsMigration(): boolean {
  if (settingsMigrations[HARD_VOLUME_LIQ_FLOORS_V113]) return false;
  return applyHardVolumeLiquidityFloorClamp();
}

/**
 * Re-clamp persisted filters after hard floors were raised (v1144).
 * Runtime effective floors already use HARD_FILTER_FLOORS; this keeps UI/saved knobs in sync.
 */
function applyHardVolumeLiquidityFloorsV1144Migration(): boolean {
  if (settingsMigrations[HARD_VOLUME_LIQ_FLOORS_V1144]) return false;
  return applyHardVolumeLiquidityFloorClamp();
}

function applyHardVolumeLiquidityFloorClamp(): boolean {
  config.filters.minLiquidity = Math.max(
    config.filters.minLiquidity ?? 0,
    HARD_FILTER_FLOORS.minLiquidityUsd
  );
  config.filters.minMarketCapUsd = Math.max(
    config.filters.minMarketCapUsd ?? 0,
    HARD_FILTER_FLOORS.minMarketCapUsd
  );
  config.filters.minVolume24hUsd = Math.max(
    config.filters.minVolume24hUsd ?? 0,
    HARD_FILTER_FLOORS.minVolume24hUsd
  );
  config.filters.minRecentVolumeUsd = Math.max(
    config.filters.minRecentVolumeUsd ?? 0,
    HARD_FILTER_FLOORS.minRecentVolumeUsd
  );
  config.filters.minRecentBuyVolumeUsd = Math.max(
    config.filters.minRecentBuyVolumeUsd ?? 0,
    HARD_FILTER_FLOORS.minRecentBuyVolumeUsd
  );
  const holders = Math.max(
    config.filters.minHolders ?? 0,
    config.filters.minHolderCount ?? 0,
    HARD_FILTER_FLOORS.minHolders
  );
  config.filters.minHolders = holders;
  config.filters.minHolderCount = holders;
  config.filters.minRecentActivity = Math.max(
    config.filters.minRecentActivity ?? 0,
    HARD_FILTER_FLOORS.minRecentActivityTxns
  );
  config.selective.minVolume24hUsd = Math.max(
    config.selective.minVolume24hUsd ?? 0,
    HARD_FILTER_FLOORS.minVolume24hUsd
  );
  config.selective.minHolderCount = Math.max(
    config.selective.minHolderCount ?? 0,
    HARD_FILTER_FLOORS.minHolders
  );
  if (config.bondingCurve.requireHealthyCurve == null) {
    config.bondingCurve.requireHealthyCurve = false;
  }
  if (config.bondingCurve.requireRecentCurveActivity == null) {
    config.bondingCurve.requireRecentCurveActivity = true;
  }
  syncConfigAliases();
  return true;
}

/**
 * One-shot: persisted configs often kept riskLevel=medium while knobs stayed on
 * older defaults (max pos 5, base 0.12, etc.). Re-apply the selected preset once.
 */
function applyRiskLevelSyncMigration(): boolean {
  if (settingsMigrations[RISK_LEVEL_SYNC_V1]) return false;
  const level = normalizeRiskLevel(config.riskLevel);
  applyRiskLevel(level, { persist: false });
  return true;
}

/**
 * One-shot: raise maxProfitPercent to the new 1000% default when still on an old
 * shipped default (100 or 500). Custom values are left alone unless above the
 * new 5000% ceiling (then clamped). Always marks done so it runs once.
 */
function applyMaxProfitDefaultMigration(): boolean {
  if (settingsMigrations[MAX_PROFIT_DEFAULT_V1123]) return false;
  const cur = Number(config.trade.maxProfitPercent);
  if (!Number.isFinite(cur) || OLD_MAX_PROFIT_DEFAULTS.has(cur)) {
    config.trade.maxProfitPercent = NEW_MAX_PROFIT_DEFAULT;
  } else if (cur > MAX_PROFIT_PERCENT_CEILING) {
    config.trade.maxProfitPercent = MAX_PROFIT_PERCENT_CEILING;
  }
  return true;
}

/**
 * One-shot: ensure min top-10 holder concentration floor (default 8%, hard ≥5%).
 * Always marks done so it runs once after upgrade to 1.1.24.
 */
function applyHolderConcentrationFloorsMigration(): boolean {
  if (settingsMigrations[HOLDER_CONCENTRATION_FLOORS_V1124]) return false;
  const cur = Number(config.filters.minTop10HolderPct);
  if (!Number.isFinite(cur) || cur <= 0) {
    config.filters.minTop10HolderPct = 8;
  } else {
    config.filters.minTop10HolderPct = Math.max(
      cur,
      HARD_FILTER_FLOORS.minTop10HolderPct
    );
  }
  syncConfigAliases();
  return true;
}

/**
 * One-shot: persisted configs often kept maxTopHolderPct~40 / maxRiskScore~70 /
 * low maxConcurrent after older defaults — blocking Medium migration + copy buys
 * while the PF migration feed still looked "live". Restore Medium-viable knobs
 * without wiping custom Risk On choices.
 */
function applyMediumEntryRestoreMigration(): boolean {
  if (settingsMigrations[MEDIUM_ENTRY_RESTORE_V1125]) return false;
  // Legacy Low/Med/Risk On restore retired — On/Off presets own knobs.
  return true;
}

/**
 * One-shot: ensure min entry market-cap floor (default $5k, hard ≥$5k).
 * Always marks done so it runs once after upgrade to 1.1.29+.
 * Gate enforcement (curve MC + fail-closed unknown) ships in 1.1.30.
 */
function applyMinMarketCapFloorMigration(): boolean {
  if (settingsMigrations[MIN_MARKET_CAP_FLOOR_V1129]) return false;
  const cur = Number(config.filters.minMarketCapUsd);
  if (!Number.isFinite(cur) || cur <= 0) {
    config.filters.minMarketCapUsd = HARD_FILTER_FLOORS.minMarketCapUsd;
  } else {
    config.filters.minMarketCapUsd = Math.max(
      cur,
      HARD_FILTER_FLOORS.minMarketCapUsd
    );
  }
  syncConfigAliases();
  return true;
}

/**
 * One-shot: enable buyPumpFunOnly on upgrade to 1.1.31+.
 * Always marks done so it runs once; user can turn OFF afterward.
 */
function applyBuyPumpFunOnlyOnMigration(): boolean {
  if (settingsMigrations[BUY_PUMP_FUN_ONLY_ON_V1131]) return false;
  config.filters.buyPumpFunOnly = true;
  return true;
}

/**
 * One-shot: seed wallet quality / clustering / entry-timing defaults for 1.1.33.
 * Does not wipe custom Risk On knobs beyond filling nulls + Medium conviction floor.
 */
function applyWalletQualityEntryMigration(): boolean {
  if (settingsMigrations[WALLET_QUALITY_ENTRY_V1133]) return false;

  if (config.filters.enableWalletQualityGate == null) {
    config.filters.enableWalletQualityGate = true;
  }
  if (
    config.filters.minWalletQualityScore == null ||
    Number(config.filters.minWalletQualityScore) <= 0
  ) {
    config.filters.minWalletQualityScore = 55;
  }
  if (config.filters.walletQualityInactiveDays == null) {
    config.filters.walletQualityInactiveDays = 5;
  }
  if (config.filters.enableWalletQualityAutoPrune == null) {
    config.filters.enableWalletQualityAutoPrune = false;
  }
  if (config.filters.enableEntryTimingGate == null) {
    config.filters.enableEntryTimingGate = true;
  }
  if (config.filters.maxEntryAgeMinutes == null) {
    config.filters.maxEntryAgeMinutes = 15;
  }
  if (
    config.filters.maxEntryMarketCapUsd == null ||
    !Number.isFinite(Number(config.filters.maxEntryMarketCapUsd)) ||
    Number(config.filters.maxEntryMarketCapUsd) < 0
  ) {
    config.filters.maxEntryMarketCapUsd = 0;
  }
  if (config.filters.preferEntryWithinMinutes == null) {
    config.filters.preferEntryWithinMinutes = 10;
  }
  if (config.filters.rejectDumpingToken == null) {
    config.filters.rejectDumpingToken = true;
  }
  if (config.filters.maxDrawdownFromRecentHighPct == null) {
    config.filters.maxDrawdownFromRecentHighPct = 35;
  }
  if (config.filters.clusterMinWallets == null) {
    config.filters.clusterMinWallets = 2;
  }
  if (config.filters.clusterWindowMinutes == null) {
    config.filters.clusterWindowMinutes = 5;
  }
  if (config.filters.allowSingleWalletTopPerformerMigration == null) {
    config.filters.allowSingleWalletTopPerformerMigration = true;
  }
  if (config.filters.smartMoneyFlowWeight == null) {
    config.filters.smartMoneyFlowWeight = 1.35;
  }
  if (config.filters.requireMomentumConfirmation == null) {
    config.filters.requireMomentumConfirmation = false;
  }
  if (config.filters.momentumLookbackMinutes == null) {
    config.filters.momentumLookbackMinutes = 15;
  }
  if (config.filters.momentumMinHoldPct == null) {
    config.filters.momentumMinHoldPct = -5;
  }

  if ((config.filters.clusterMinWallets ?? 0) < 2) {
    config.filters.clusterMinWallets = 2;
  }
  if ((config.risk.deadVolumeConsecutiveHours ?? 99) > 2) {
    config.risk.deadVolumeConsecutiveHours = 2;
  }
  if ((config.risk.deadVolumeMinHoldMinutes ?? 99) > 15) {
    config.risk.deadVolumeMinHoldMinutes = 15;
  }
  if ((config.risk.deadVolumeUsdPerHour ?? 0) > 60) {
    config.risk.deadVolumeUsdPerHour = 60;
  }

  syncConfigAliases();
  return true;
}

/** Effective floors — risk presets may be stricter, never below HARD_FILTER_FLOORS (except Risk OFF). */
export function hardFilterFloorsActive(): boolean {
  return config.riskLevel !== 'off';
}

export function effectiveMinLiquidityUsd(): number {
  let base: number;
  if (!hardFilterFloorsActive()) {
    base = Math.max(0, config.filters.minLiquidity ?? 0);
  } else {
    base = Math.max(
      config.filters.minLiquidity ?? 0,
      HARD_FILTER_FLOORS.minLiquidityUsd
    );
  }
  try {
    const { learningModeAdjustedMinLiquidity } =
      require('./learningMode') as typeof import('./learningMode');
    return learningModeAdjustedMinLiquidity(base);
  } catch {
    return base;
  }
}

export function effectiveMinMarketCapUsd(): number {
  let base: number;
  if (!hardFilterFloorsActive()) {
    base = Math.max(0, config.filters.minMarketCapUsd ?? 0);
  } else {
    base = Math.max(
      config.filters.minMarketCapUsd ?? 0,
      HARD_FILTER_FLOORS.minMarketCapUsd
    );
  }
  try {
    const { learningModeAdjustedMinMarketCap } =
      require('./learningMode') as typeof import('./learningMode');
    return learningModeAdjustedMinMarketCap(base);
  } catch {
    return base;
  }
}

export function effectiveMinVolume24hUsd(): number {
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

export function effectiveMinRecentVolumeUsd(): number {
  if (!hardFilterFloorsActive()) {
    return Math.max(0, config.filters.minRecentVolumeUsd ?? 0);
  }
  return Math.max(
    config.filters.minRecentVolumeUsd ?? 0,
    HARD_FILTER_FLOORS.minRecentVolumeUsd
  );
}

export function effectiveMinRecentBuyVolumeUsd(): number {
  if (!hardFilterFloorsActive()) {
    return Math.max(0, config.filters.minRecentBuyVolumeUsd ?? 0);
  }
  return Math.max(
    config.filters.minRecentBuyVolumeUsd ?? 0,
    HARD_FILTER_FLOORS.minRecentBuyVolumeUsd
  );
}

export function effectiveMinHolders(): number {
  if (!hardFilterFloorsActive()) {
    return Math.max(
      0,
      config.filters.minHolders ?? 0,
      config.filters.minHolderCount ?? 0,
      config.selective?.minHolderCount ?? 0
    );
  }
  return Math.max(
    config.filters.minHolders ?? 0,
    config.filters.minHolderCount ?? 0,
    config.selective?.minHolderCount ?? 0,
    HARD_FILTER_FLOORS.minHolders
  );
}

export function effectiveMinRecentActivity(): number {
  if (!hardFilterFloorsActive()) {
    return Math.max(0, config.filters.minRecentActivity ?? 0);
  }
  return Math.max(
    config.filters.minRecentActivity ?? 0,
    HARD_FILTER_FLOORS.minRecentActivityTxns
  );
}

/** Min top-10 concentration — never below HARD_FILTER_FLOORS (5%), default 8%. Risk OFF → configured (0 when soak). */
export function effectiveMinTop10HolderPct(): number {
  let base: number;
  if (!hardFilterFloorsActive()) {
    const configured = Number(config.filters.minTop10HolderPct);
    base = Number.isFinite(configured) && configured > 0 ? configured : 0;
  } else {
    const configured = Number(config.filters.minTop10HolderPct);
    const preferred = Number.isFinite(configured) && configured > 0 ? configured : 8;
    base = Math.max(preferred, HARD_FILTER_FLOORS.minTop10HolderPct);
  }
  try {
    const { isLearningModeActive, applyLearningMinOverlay } =
      require('./learningMode') as typeof import('./learningMode');
    if (isLearningModeActive()) {
      return applyLearningMinOverlay(base, 'top10MinPct');
    }
  } catch {
    /* ignore */
  }
  return base;
}

/**
 * Max Top-10% concentration (filters.maxHolderConcentration).
 * 0 = disabled. Independent of maxTopHolderPct (single wallet).
 */
export function effectiveMaxTop10HolderPct(): number {
  const configured = Number(config.filters.maxHolderConcentration);
  let base =
    !Number.isFinite(configured) || configured <= 0
      ? 0
      : Math.min(100, configured);
  try {
    const { isLearningModeActive, applyLearningMaxOverlay } =
      require('./learningMode') as typeof import('./learningMode');
    if (isLearningModeActive()) {
      // Learning Mode always supplies a top10 max when ON
      return applyLearningMaxOverlay(base > 0 ? base : 29, 'top10MaxPct');
    }
  } catch {
    /* ignore */
  }
  return base;
}

/** Ensure minTop10 ≤ maxHolderConcentration when both are enabled. */
export function clampTop10HolderBand(): void {
  clampMinMaxBand('minTop10HolderPct', 'maxHolderConcentration');
}

/** Ensure min ≤ max for a filter band when both sides are enabled (>0). */
function clampMinMaxBand(
  minKey: 'minTop10HolderPct' | 'minDevHoldPct' | 'minTopHolderPct' | 'minRiskScore' | 'minEstimatedTaxPct',
  maxKey:
    | 'maxHolderConcentration'
    | 'maxDevHoldPct'
    | 'maxTopHolderPct'
    | 'maxRiskScore'
    | 'maxEstimatedTaxPct'
): void {
  const min = Number(config.filters[minKey]);
  const max = Number(config.filters[maxKey]);
  if (
    Number.isFinite(min) &&
    min > 0 &&
    Number.isFinite(max) &&
    max > 0 &&
    min > max
  ) {
    (config.filters as unknown as Record<string, number>)[maxKey] = min;
  }
}

/** Clamp all holder/risk min–max bands so min ≤ max when both enabled. */
export function clampHolderRiskFilterBands(): void {
  clampTop10HolderBand();
  clampMinMaxBand('minDevHoldPct', 'maxDevHoldPct');
  clampMinMaxBand('minTopHolderPct', 'maxTopHolderPct');
  clampMinMaxBand('minRiskScore', 'maxRiskScore');
  clampMinMaxBand('minEstimatedTaxPct', 'maxEstimatedTaxPct');
  // Keep maxDevPercent alias in sync after possible maxDevHoldPct bump
  if (config.filters.maxDevHoldPct != null) {
    config.filters.maxDevPercent = config.filters.maxDevHoldPct;
  }
}

/** Hard max insider / extreme-dev hold % — non-bypassable across risk levels (OFF → disabled). */
export function effectiveMaxInsiderPct(): number {
  if (!hardFilterFloorsActive()) return 100;
  return HARD_FILTER_FLOORS.maxInsiderPct;
}

/**
 * Wipe persisted JSON files and restore code/env defaults in memory.
 * Recreates default wallets.json / trading-wallets.json / paperBalance.json.
 * Caller should also reset paper trader + backtest history + refresh monitor.
 */
export function resetToDefaults(): {
  deleted: string[];
  dataDir: string;
} {
  const result = resetAllPersistedData();
  clearDashboardStateCache();
  applySettingsSnapshot(CODE_DEFAULT_SETTINGS, 'replace');
  // Fresh install / reset: no tracked smart wallets (discover & add as needed)
  config.smartWallets = [];
  saveWalletsToDisk([]);
  initTradingWallets();
  console.log('[settings] Reset to code/env defaults (0 tracked wallets)');
  return result;
}

/**
 * Optional one-shot wipe of tracked smart wallets when
 * CLEAR_WATCHED_WALLETS_ON_BOOT=1 (true/yes/on). Does not wipe other data.
 * Unset the env after the deploy that needs the clear.
 */
export function maybeClearWatchedWalletsOnBoot(): number {
  const raw = (process.env.CLEAR_WATCHED_WALLETS_ON_BOOT || '')
    .trim()
    .toLowerCase();
  if (!['1', 'true', 'yes', 'on'].includes(raw)) return 0;
  const n = clearAllSmartWallets();
  try {
    const { setSkipFavouritesAutoImport } =
      require('./dashboardState') as typeof import('./dashboardState');
    setSkipFavouritesAutoImport(true);
  } catch {
    /* ignore */
  }
  console.log(
    `[wallets] CLEAR_WATCHED_WALLETS_ON_BOOT — cleared ${n} tracked wallet(s). ` +
      'Unset this env after deploy so later boots keep wallets you add.'
  );
  return n;
}

/** Load persisted wallets into config on startup */
export function initWallets(): void {
  const loaded = loadWalletsFromDisk();
  config.smartWallets = loaded.map((w) => ({
    name: w.name,
    address: w.address,
    enabled: w.enabled,
    lastTradedAt: w.lastTradedAt ?? w.lastActive,
    lastActive: w.lastActive ?? w.lastTradedAt,
    winRate: w.winRate,
    notes: w.notes,
    tradesLast30d: w.tradesLast30d,
    tradesLast7d: w.tradesLast7d,
    pumpFunTradeCount: w.pumpFunTradeCount,
    tags: w.tags,
    category: w.category,
    source: w.source,
    discoveredAt: w.discoveredAt,
    lastCheckedAt: w.lastCheckedAt,
    qualityScore: w.qualityScore,
    qualityStatus: w.qualityStatus,
    copyWeight: w.copyWeight,
    qualityScoredAt: w.qualityScoredAt,
    avgHoldTimeSec: w.avgHoldTimeSec,
  }));

  maybeClearWatchedWalletsOnBoot();

  initTradingWallets();
  applyPersistedSettings();
  // Ship baked strategy module + Trade Profile defaults on first boot / when
  // defaultsId changes in src/defaults/strategyModulesDefault.json (new deploy).
  try {
    const { applyBakedStrategyModulesDefaultOnBoot } =
      require('./strategies') as typeof import('./strategies');
    applyBakedStrategyModulesDefaultOnBoot();
  } catch (err) {
    console.warn(
      '[config] Baked strategy defaults boot hook failed:',
      err instanceof Error ? err.message : err
    );
  }
  // User-owned micro-bot knobs always win over bake (separate durable file).
  try {
    const { applyTradeProfilesUserStateOnBoot } =
      require('./tradeProfilesUserStore') as typeof import('./tradeProfilesUserStore');
    applyTradeProfilesUserStateOnBoot();
  } catch (err) {
    console.warn(
      '[config] trade-profiles-user boot restore failed:',
      err instanceof Error ? err.message : err
    );
  }
}

/** Load live trading wallet slots (metadata only) */
export function initTradingWallets(): void {
  const file = loadTradingWalletsFile();
  config.tradingWallets = file.wallets;
  config.activeTradingWalletId = file.activeId;
  console.log(
    `[config] Trading wallets: ${file.wallets.length} slot(s), active=${file.activeId ?? 'none'}`
  );
}

function persistTradingWallets(): void {
  saveTradingWalletsFile({
    activeId: config.activeTradingWalletId,
    wallets: config.tradingWallets,
  });
}

export function getActiveTradingWallet(): TradingWalletSlot | null {
  const id = config.activeTradingWalletId;
  if (!id) return null;
  return config.tradingWallets.find((w) => w.id === id && w.enabled) ?? null;
}

export function setActiveTradingWallet(id: string): {
  ok: boolean;
  error?: string;
} {
  const slot = config.tradingWallets.find((w) => w.id === id);
  if (!slot) return { ok: false, error: 'Wallet not found' };
  if (!slot.enabled) return { ok: false, error: 'Wallet is disabled' };
  config.activeTradingWalletId = id;
  persistTradingWallets();
  console.log(
    `[config] Active trading wallet → ${slot.name} (${slot.envVar})`
  );
  return { ok: true };
}

export function addTradingWallet(input: {
  name: string;
  envVar: string;
  role?: TradingWalletRole;
}): { ok: boolean; wallet?: TradingWalletSlot; error?: string } {
  const name = input.name.trim();
  const envVar = normalizeEnvVarName(input.envVar);
  if (!name) return { ok: false, error: 'name required' };
  if (!isAllowedKeyEnvVar(envVar)) {
    return {
      ok: false,
      error:
        'envVar must be PRIVATE_KEY, WALLET_PRIVATE_KEY, or TRADING_WALLET_* (e.g. TRADING_WALLET_3)',
    };
  }
  if (config.tradingWallets.some((w) => w.envVar === envVar)) {
    return { ok: false, error: 'A wallet already uses that env var' };
  }

  const wallet: TradingWalletSlot = {
    id: makeTradingWalletId(name),
    name,
    role: input.role ?? 'custom',
    envVar,
    enabled: true,
    createdAt: Date.now(),
  };
  config.tradingWallets.push(wallet);
  if (!config.activeTradingWalletId) {
    config.activeTradingWalletId = wallet.id;
  }
  persistTradingWallets();
  return { ok: true, wallet };
}

export function removeTradingWallet(id: string): {
  ok: boolean;
  error?: string;
} {
  const slot = config.tradingWallets.find((w) => w.id === id);
  if (!slot) return { ok: false, error: 'Wallet not found' };
  if (slot.role === 'main' && config.tradingWallets.filter((w) => w.role === 'main').length <= 1) {
    // Allow removing main if user wants, but keep at least one wallet
  }
  if (config.tradingWallets.length <= 1) {
    return { ok: false, error: 'Keep at least one trading wallet slot' };
  }

  config.tradingWallets = config.tradingWallets.filter((w) => w.id !== id);
  if (config.activeTradingWalletId === id) {
    config.activeTradingWalletId = config.tradingWallets[0]?.id ?? null;
  }
  persistTradingWallets();
  return { ok: true };
}

/** Safe public snapshot metadata — keys resolved in connection layer */
export function listTradingWalletSlots(): TradingWalletSlot[] {
  return [...config.tradingWallets];
}

/**
 * Resolve secret material for a slot from env only.
 * Main role falls back to PRIVATE_KEY / WALLET_PRIVATE_KEY if TRADING_WALLET_1 empty.
 * NEVER log the returned value.
 */
export function resolveTradingWalletSecret(
  slot: TradingWalletSlot
): string | null {
  if (!isAllowedKeyEnvVar(slot.envVar)) return null;

  const primary = process.env[slot.envVar]?.trim();
  if (primary) return primary;

  // Legacy / convenience aliases for the main trading key
  if (slot.role === 'main' || slot.envVar === 'TRADING_WALLET_1') {
    const alias =
      process.env.PRIVATE_KEY?.trim() ||
      process.env.WALLET_PRIVATE_KEY?.trim();
    if (alias) return alias;
  }

  return null;
}

export function persistWallets(options: { activeOnly?: boolean } = {}): void {
  const existing = loadWalletsFromDisk();
  const existingMap = new Map(existing.map((w) => [w.address, w]));

  let wallets = config.smartWallets;
  if (options.activeOnly) {
    wallets = wallets.filter((w) => w.enabled);
  }

  const records: WalletRecord[] = wallets.map((w) => {
    const prev = existingMap.get(w.address);
    const lastActive = w.lastActive ?? w.lastTradedAt ?? prev?.lastActive ?? prev?.lastTradedAt;
    return {
      name: w.name,
      address: w.address,
      enabled: w.enabled,
      lastTradedAt: w.lastTradedAt ?? lastActive,
      lastActive,
      winRate: w.winRate ?? prev?.winRate,
      notes: w.notes ?? prev?.notes,
      tradesLast30d: w.tradesLast30d ?? prev?.tradesLast30d,
      tradesLast7d: w.tradesLast7d ?? prev?.tradesLast7d,
      pumpFunTradeCount: w.pumpFunTradeCount ?? prev?.pumpFunTradeCount,
      tags: w.tags ?? prev?.tags,
      category: w.category ?? prev?.category,
      source: w.source ?? prev?.source,
      discoveredAt: w.discoveredAt ?? prev?.discoveredAt,
      lastCheckedAt: w.lastCheckedAt ?? prev?.lastCheckedAt,
      qualityScore: w.qualityScore ?? prev?.qualityScore,
      qualityStatus: w.qualityStatus ?? prev?.qualityStatus,
      copyWeight: w.copyWeight ?? prev?.copyWeight,
      qualityScoredAt: w.qualityScoredAt ?? prev?.qualityScoredAt,
      avgHoldTimeSec: w.avgHoldTimeSec ?? prev?.avgHoldTimeSec,
      addedAt: prev?.addedAt ?? Date.now(),
    };
  });
  saveWalletsToDisk(records);
}

export function updateConfig(partial: Partial<BotConfig>): void {
  Object.assign(config, partial);
  persistUserSettings();
}

/** Enable/disable Share RPC load mode (Helius/Alchemy/public workload split). */
export function setRpcShareLoad(enabled: boolean): boolean {
  config.rpc.shareLoad = Boolean(enabled);
  persistUserSettings();
  console.log(
    `[rpc] Share RPC load ${config.rpc.shareLoad ? 'ON' : 'OFF'} — ` +
      (config.rpc.shareLoad
        ? 'critical→Helius, scanners/Zion→Alchemy, wallet-watch+utility→public'
        : 'legacy primary/secondary routing')
  );
  return config.rpc.shareLoad;
}

export function updateTradeConfig(partial: Partial<TradeConfig>): void {
  Object.assign(config.trade, partial);
  // Keep base ↔ legacy tradeAmount aliases in sync
  if (partial.baseTradeAmountSol != null) {
    config.trade.tradeAmountSol = partial.baseTradeAmountSol;
    config.trade.baseTradeAmountSol = partial.baseTradeAmountSol;
  } else if (partial.tradeAmountSol != null) {
    config.trade.baseTradeAmountSol = partial.tradeAmountSol;
    config.trade.tradeAmountSol = partial.tradeAmountSol;
  }
  if (partial.maxAllowedTradeSol != null) {
    const n = Number(partial.maxAllowedTradeSol);
    config.trade.maxAllowedTradeSol = Number.isFinite(n) && n > 0
      ? Math.min(50, Math.max(0.01, n))
      : DEFAULT_MAX_ALLOWED_TRADE_SOL;
  }
  if (partial.riskMultiplier != null) {
    config.trade.riskMultiplier = Math.min(
      1,
      Math.max(0.1, Number(partial.riskMultiplier))
    );
  }
  if (partial.convictionMultiplier != null) {
    config.trade.convictionMultiplier = Math.min(
      3,
      Math.max(1, Number(partial.convictionMultiplier))
    );
  }
  if (partial.maxProfitPercent != null) {
    config.trade.maxProfitPercent = Math.min(
      MAX_PROFIT_PERCENT_CEILING,
      Math.max(20, Number(partial.maxProfitPercent))
    );
  }
  if (partial.minProfitPercent != null) {
    config.trade.minProfitPercent = Math.min(
      MAX_PROFIT_PERCENT_CEILING,
      Math.max(10, Number(partial.minProfitPercent))
    );
  }
  persistUserSettings();
}

export function updateFilterConfig(partial: Partial<FilterConfig>): void {
  Object.assign(config.filters, partial);
  // Keep maxDevPercent ↔ maxDevHoldPct aliases in sync
  if (partial.maxDevPercent != null) {
    config.filters.maxDevHoldPct = partial.maxDevPercent;
    config.filters.maxDevPercent = partial.maxDevPercent;
  } else if (partial.maxDevHoldPct != null) {
    config.filters.maxDevPercent = partial.maxDevHoldPct;
    config.filters.maxDevHoldPct = partial.maxDevHoldPct;
  }
  if (partial.minHolders != null || partial.minHolderCount != null) {
    const holders =
      config.riskLevel === 'off'
        ? Math.max(partial.minHolders ?? 0, partial.minHolderCount ?? 0)
        : Math.max(
            partial.minHolders ?? 0,
            partial.minHolderCount ?? 0,
            HARD_FILTER_FLOORS.minHolders
          );
    config.filters.minHolders = holders;
    config.filters.minHolderCount = holders;
  }
  // Never allow dashboard to undercut absolute floors (except Risk OFF)
  if (config.riskLevel !== 'off') {
    config.filters.minLiquidity = Math.max(
      config.filters.minLiquidity ?? 0,
      HARD_FILTER_FLOORS.minLiquidityUsd
    );
    config.filters.minMarketCapUsd = Math.max(
      config.filters.minMarketCapUsd ?? 0,
      HARD_FILTER_FLOORS.minMarketCapUsd
    );
    config.filters.minVolume24hUsd = Math.max(
      config.filters.minVolume24hUsd ?? 0,
      HARD_FILTER_FLOORS.minVolume24hUsd
    );
    config.filters.minRecentVolumeUsd = Math.max(
      config.filters.minRecentVolumeUsd ?? 0,
      HARD_FILTER_FLOORS.minRecentVolumeUsd
    );
    config.filters.minRecentBuyVolumeUsd = Math.max(
      config.filters.minRecentBuyVolumeUsd ?? 0,
      HARD_FILTER_FLOORS.minRecentBuyVolumeUsd
    );
    config.filters.minRecentActivity = Math.max(
      config.filters.minRecentActivity ?? 0,
      HARD_FILTER_FLOORS.minRecentActivityTxns
    );
    const minTop10 = Number(config.filters.minTop10HolderPct);
    config.filters.minTop10HolderPct = Math.max(
      Number.isFinite(minTop10) && minTop10 > 0 ? minTop10 : 8,
      HARD_FILTER_FLOORS.minTop10HolderPct
    );
  }
  clampHolderRiskFilterBands();
  persistUserSettings();
}

export function updateStrategyConfig(partial: Partial<StrategyConfig>): void {
  Object.assign(config.strategy, partial);
  persistUserSettings();
}

export function updateSelectiveConfig(
  partial: Partial<SelectiveTradingConfig>
): SelectiveTradingConfig {
  config.selective = { ...config.selective, ...partial };
  persistUserSettings();
  return { ...config.selective };
}

export function updatePaperConfig(
  partial: Partial<BotConfig['paper']>
): BotConfig['paper'] {
  Object.assign(config.paper, partial);
  persistUserSettings();
  return { ...config.paper };
}

export function addSmartWallet(wallet: SmartWallet): boolean {
  if (config.smartWallets.some((w) => w.address === wallet.address)) {
    return false;
  }
  const now = Date.now();
  config.smartWallets.push({
    ...wallet,
    discoveredAt: wallet.discoveredAt ?? now,
    source: wallet.source ?? 'manual',
    category:
      wallet.category ??
      inferWalletCategory(wallet.tags, wallet.tradesLast7d),
  });
  persistWallets();
  return true;
}

/**
 * Add or merge metadata onto an existing tracked wallet (does not drop tags).
 * Returns whether a new wallet was created.
 */
export function upsertSmartWallet(wallet: SmartWallet): {
  added: boolean;
  updated: boolean;
} {
  const existing = config.smartWallets.find((w) => w.address === wallet.address);
  if (!existing) {
    const ok = addSmartWallet(wallet);
    return { added: ok, updated: false };
  }

  const mergedTags = [
    ...new Set([...(existing.tags ?? []), ...(wallet.tags ?? [])]),
  ];
  Object.assign(existing, {
    name: wallet.name || existing.name,
    winRate: wallet.winRate ?? existing.winRate,
    notes: wallet.notes ?? existing.notes,
    tradesLast7d: wallet.tradesLast7d ?? existing.tradesLast7d,
    tradesLast30d: wallet.tradesLast30d ?? existing.tradesLast30d,
    pumpFunTradeCount: wallet.pumpFunTradeCount ?? existing.pumpFunTradeCount,
    lastActive: wallet.lastActive ?? wallet.lastTradedAt ?? existing.lastActive,
    lastTradedAt:
      wallet.lastTradedAt ?? wallet.lastActive ?? existing.lastTradedAt,
    tags: mergedTags.length ? mergedTags : existing.tags,
    category:
      wallet.category ??
      existing.category ??
      inferWalletCategory(mergedTags, wallet.tradesLast7d ?? existing.tradesLast7d),
    source: existing.source ?? wallet.source ?? 'manual',
    discoveredAt: existing.discoveredAt ?? wallet.discoveredAt ?? Date.now(),
    lastCheckedAt: wallet.lastCheckedAt ?? existing.lastCheckedAt,
    avgHoldTimeSec: wallet.avgHoldTimeSec ?? existing.avgHoldTimeSec,
    qualityScore: wallet.qualityScore ?? existing.qualityScore,
    qualityStatus: wallet.qualityStatus ?? existing.qualityStatus,
    copyWeight: wallet.copyWeight ?? existing.copyWeight,
  });
  persistWallets();
  return { added: false, updated: true };
}

export function removeSmartWallet(address: string): boolean {
  const before = config.smartWallets.length;
  config.smartWallets = config.smartWallets.filter((w) => w.address !== address);
  if (config.smartWallets.length < before) {
    persistWallets();
    return true;
  }
  return false;
}

/** Clear every tracked smart wallet (Watch list). */
export function clearAllSmartWallets(): number {
  const n = config.smartWallets.length;
  config.smartWallets = [];
  saveWalletsToDisk([]);
  return n;
}

export function toggleSmartWallet(address: string, enabled: boolean): void {
  const wallet = config.smartWallets.find((w) => w.address === address);
  if (wallet) {
    wallet.enabled = enabled;
    persistWallets();
  }
}

export function setMode(
  mode: TradingMode,
  options: { persist?: boolean } = {}
): void {
  if (!isTradingMode(mode)) {
    throw new Error(`Invalid trading mode: ${String(mode)}`);
  }
  // Safety: never silently land on live from a bad cast
  if (mode === 'liveSimulation') {
    config.paper.useLiveData = true;
  }
  config.mode = mode;
  const label =
    mode === 'liveSimulation'
      ? 'LIVE SIMULATION (no real funds)'
      : mode.toUpperCase();
  console.log(`[config] Trading mode set to: ${label}`);
  if (options.persist !== false) {
    persistUserSettings();
  }
}

/** Real on-chain swaps — the only mode that spends funds. */
export function usesRealFunds(mode?: TradingMode): boolean {
  return (mode ?? config.mode) === 'live';
}

/** Paper ledger (balance/positions/PnL) — paper and liveSimulation. */
export function usesPaperAccounting(mode?: TradingMode): boolean {
  const m = mode ?? config.mode;
  return m === 'paper' || m === 'liveSimulation';
}

export function isLiveSimulationMode(mode?: TradingMode): boolean {
  return (mode ?? config.mode) === 'liveSimulation';
}

/** Force Dex/GMGN marks + live-parity filter path. */
export function forcesLiveMarketData(mode?: TradingMode): boolean {
  const m = mode ?? config.mode;
  return m === 'live' || m === 'liveSimulation';
}

/**
 * Apply On / Off risk preset — overwrites recommended knobs across trade,
 * filters, risk, selective, and profit strategy. Synced recipe sets lean
 * module toggles (On) or ops-only (Off).
 */
export function applyRiskLevel(
  level: RiskLevel,
  options: { persist?: boolean; skipOptimizerOverlay?: boolean } = {}
): {
  riskLevel: RiskLevel;
  warning: string | null;
  summary: ReturnType<typeof getRiskLevelSummary>;
} {
  const canonical = normalizeRiskLevel(level);
  if (!isRiskLevel(canonical)) {
    throw new Error(`Invalid riskLevel: ${level}`);
  }
  const preset = RISK_LEVEL_PRESETS[canonical];
  config.riskLevel = canonical;

  // Keep user hard size cap across Risk On/Off — presets do not set it.
  const preservedMaxAllowed = config.trade.maxAllowedTradeSol;

  Object.assign(config.trade, preset.trade);
  if (preset.trade.baseTradeAmountSol != null) {
    config.trade.tradeAmountSol = preset.trade.baseTradeAmountSol;
    config.trade.baseTradeAmountSol = preset.trade.baseTradeAmountSol;
  } else if (preset.trade.tradeAmountSol != null) {
    config.trade.baseTradeAmountSol = preset.trade.tradeAmountSol;
    config.trade.tradeAmountSol = preset.trade.tradeAmountSol;
  }
  if (
    preservedMaxAllowed != null &&
    Number.isFinite(Number(preservedMaxAllowed)) &&
    Number(preservedMaxAllowed) > 0
  ) {
    config.trade.maxAllowedTradeSol = Number(preservedMaxAllowed);
  } else if (
    config.trade.maxAllowedTradeSol == null ||
    !Number.isFinite(Number(config.trade.maxAllowedTradeSol)) ||
    Number(config.trade.maxAllowedTradeSol) <= 0
  ) {
    config.trade.maxAllowedTradeSol = DEFAULT_MAX_ALLOWED_TRADE_SOL;
  }

  Object.assign(config.filters, preset.filters);
  if (preset.filters.maxDevPercent != null) {
    config.filters.maxDevHoldPct = preset.filters.maxDevPercent;
  } else if (preset.filters.maxDevHoldPct != null) {
    config.filters.maxDevPercent = preset.filters.maxDevHoldPct;
  }
  // maxTopHolderPct (single) and maxHolderConcentration (Top-10%) stay independent.
  // Object.assign already copied both from the preset when present.

  if (canonical === 'off') {
    config.filters.minHolders = Math.max(0, config.filters.minHolders ?? 0);
    config.filters.minHolderCount = Math.max(
      0,
      config.filters.minHolderCount ?? 0
    );
    config.filters.minLiquidity = Math.max(0, config.filters.minLiquidity ?? 0);
    config.filters.minMarketCapUsd = Math.max(
      0,
      config.filters.minMarketCapUsd ?? 0
    );
    config.filters.minVolume24hUsd = Math.max(
      0,
      config.filters.minVolume24hUsd ?? 0
    );
    config.filters.minRecentVolumeUsd = Math.max(
      0,
      config.filters.minRecentVolumeUsd ?? 0
    );
    config.filters.minRecentBuyVolumeUsd = Math.max(
      0,
      config.filters.minRecentBuyVolumeUsd ?? 0
    );
    config.filters.minTop10HolderPct = Math.max(
      0,
      Number(config.filters.minTop10HolderPct) || 0
    );
  } else {
    const holders = Math.max(
      config.filters.minHolders ?? 0,
      config.filters.minHolderCount ?? 0,
      HARD_FILTER_FLOORS.minHolders
    );
    config.filters.minHolders = holders;
    config.filters.minHolderCount = holders;
    config.filters.minLiquidity = Math.max(
      config.filters.minLiquidity ?? 0,
      HARD_FILTER_FLOORS.minLiquidityUsd
    );
    config.filters.minMarketCapUsd = Math.max(
      config.filters.minMarketCapUsd ?? 0,
      HARD_FILTER_FLOORS.minMarketCapUsd
    );
    config.filters.minVolume24hUsd = Math.max(
      config.filters.minVolume24hUsd ?? 0,
      HARD_FILTER_FLOORS.minVolume24hUsd
    );
    config.filters.minRecentVolumeUsd = Math.max(
      config.filters.minRecentVolumeUsd ?? 0,
      HARD_FILTER_FLOORS.minRecentVolumeUsd
    );
    config.filters.minRecentBuyVolumeUsd = Math.max(
      config.filters.minRecentBuyVolumeUsd ?? 0,
      HARD_FILTER_FLOORS.minRecentBuyVolumeUsd
    );
    config.filters.minTop10HolderPct = Math.max(
      Number(config.filters.minTop10HolderPct) > 0
        ? Number(config.filters.minTop10HolderPct)
        : 8,
      HARD_FILTER_FLOORS.minTop10HolderPct
    );
  }

  const { normal, migration, ...riskRest } = preset.risk;
  Object.assign(config.risk, riskRest);
  if (normal) {
    config.risk.normal = {
      ...config.risk.normal,
      ...normal,
      tiers: normal.tiers
        ? normal.tiers.map((t) => ({ ...t }))
        : config.risk.normal.tiers,
    };
  }
  if (migration) {
    config.risk.migration = {
      ...config.risk.migration,
      ...migration,
      tiers: migration.tiers
        ? migration.tiers.map((t) => ({ ...t }))
        : config.risk.migration.tiers,
    };
  }
  if (config.risk.trailingStopPercent != null) {
    config.risk.trailingStopPct = config.risk.trailingStopPercent;
  }

  Object.assign(config.selective, preset.selective);
  if (canonical === 'off') {
    config.selective.minVolume24hUsd = Math.max(
      0,
      config.selective.minVolume24hUsd ?? 0
    );
    config.selective.minHolderCount = Math.max(
      0,
      config.selective.minHolderCount ?? 0
    );
  } else {
    config.selective.minVolume24hUsd = Math.max(
      config.selective.minVolume24hUsd ?? 0,
      HARD_FILTER_FLOORS.minVolume24hUsd
    );
    config.selective.minHolderCount = Math.max(
      config.selective.minHolderCount ?? 0,
      HARD_FILTER_FLOORS.minHolders
    );
  }
  Object.assign(config.profitStrategy, preset.profitStrategy);
  Object.assign(config.strategy, preset.strategy);

  if (preset.bondingCurve) {
    Object.assign(config.bondingCurve, preset.bondingCurve);
  }

  syncConfigAliases();

  // Always apply on/off module baseline when switching risk (lean On / ops-only Off).
  try {
    const { applyRiskStrategyRecipe } =
      require('./strategies') as typeof import('./strategies');
    config.strategyRecipeMode = 'synced';
    applyRiskStrategyRecipe(canonical, { persist: false });

    if (canonical === 'off') {
      Object.assign(config.filters, {
        minLiquidity: 0,
        minMarketCapUsd: 0,
        minVolume24hUsd: 0,
        minRecentVolumeUsd: 0,
        minRecentBuyVolumeUsd: 0,
        minHolders: 0,
        minHolderCount: 0,
        minRecentActivity: 0,
        minTop10HolderPct: 0,
        minDevHoldPct: 0,
        maxDevHoldPct: 0,
        maxDevPercent: 0,
        minTopHolderPct: 0,
        maxTopHolderPct: 0,
        maxHolderConcentration: 0,
        minEstimatedTaxPct: 0,
        maxEstimatedTaxPct: 100,
        minRiskScore: 0,
        maxRiskScore: 100,
        enableAntiRug: false,
        checkHoneypot: false,
        skipIfMintAuthority: false,
        enableWalletQualityGate: false,
        enableEntryTimingGate: false,
        requireMomentumConfirmation: false,
        enableSniperFilter: false,
        skipIfDevRecentSells: false,
        convergenceRequired: 1,
        clusterMinWallets: 1,
        maxConcurrentPositions: preset.filters.maxConcurrentPositions ?? 40,
        maxEntryAgeMinutes: 0,
      });
      Object.assign(config.selective, {
        enabled: false,
        minConvictionScore: 0,
        requireConvergenceForNormal: false,
        minWalletsForTrade: 1,
        minVolume24hUsd: 0,
        minHolderCount: 0,
      });
      if (config.tradeProfiles?.autoScoring) {
        config.tradeProfiles.autoScoring.skipBelowMin = false;
        config.tradeProfiles.autoScoring.minScore = Math.min(
          config.tradeProfiles.autoScoring.minScore ?? 45,
          20
        );
      }
      if (config.marketScanner) {
        config.marketScanner.requireTaSetup = false;
        config.marketScanner.minLiquidityUsd = 0;
        config.marketScanner.minVolumeM5Usd = 0;
        config.marketScanner.minVolumeH1Usd = 0;
        config.marketScanner.minVolumeH6Usd = 0;
        config.marketScanner.minVolumeH24Usd = 0;
        config.marketScanner.minOrganicScore = 0;
        config.marketScanner.minRankScore = Math.min(
          config.marketScanner.minRankScore ?? 42,
          20
        );
        config.marketScanner.minConfluenceScore = Math.min(
          config.marketScanner.minConfluenceScore ?? 40,
          10
        );
        config.marketScanner.pauseScannerOnlyInRiskOff = false;
      }
      syncConfigAliases();
    }
  } catch {
    // Ignore during early bootstrap if strategies is not ready
  }

  if (options.skipOptimizerOverlay !== true) {
    try {
      const { applyStoredRiskRecipeOptimization } =
        require('./backtestOptimizer') as typeof import('./backtestOptimizer');
      applyStoredRiskRecipeOptimization(canonical);
    } catch {
      /* ignore during bootstrap */
    }
  }

  if (options.persist !== false) {
    persistUserSettings();
  }

  console.log(
    `[config] Risk level → ${canonical.toUpperCase()}` +
      (preset.warning ? ` · ${preset.warning}` : '')
  );

  return {
    riskLevel: canonical,
    warning: preset.warning ?? null,
    summary: getRiskLevelSummary(),
  };
}

export function getRiskLevelSummary() {
  const level = normalizeRiskLevel(config.riskLevel);
  const preset = RISK_LEVEL_PRESETS[level];
  let recipeSummary: string | null = null;
  let recipeMode: 'synced' | 'custom' =
    config.strategyRecipeMode === 'custom' ? 'custom' : 'synced';
  let recipeCounts: {
    enabledCore: number;
    enabledRisk: number;
    enabledOptional: number;
  } | null = null;
  try {
    const { getRiskStrategyRecipe, getStrategyRecipeStatus } =
      require('./strategies') as typeof import('./strategies');
    const recipe = getRiskStrategyRecipe(level);
    recipeSummary = recipe.summary;
    const st = getStrategyRecipeStatus();
    recipeMode = st.mode;
    recipeCounts = {
      enabledCore: st.enabledCore,
      enabledRisk: st.enabledRisk,
      enabledOptional: st.enabledOptional,
    };
  } catch {
    // strategies may not be ready during early bootstrap
  }
  return {
    riskLevel: level,
    label: preset.label,
    description: preset.description,
    recipeSummary,
    recipeMode,
    recipeCounts,
    warning: level === 'off' ? OFF_RISK_WARNING : null,
    active: {
      baseTradeAmountSol:
        config.trade.baseTradeAmountSol ?? config.trade.tradeAmountSol,
      riskMultiplier: config.trade.riskMultiplier,
      convictionMultiplier: config.trade.convictionMultiplier,
      stopLossPercent: config.trade.stopLossPercent,
      maxRiskScore: config.filters.maxRiskScore,
      minLiquidity: effectiveMinLiquidityUsd(),
      minMarketCapUsd: effectiveMinMarketCapUsd(),
      maxEntryMarketCapUsd: Number(config.filters.maxEntryMarketCapUsd ?? 0) || 0,
      convergenceRequired: config.filters.convergenceRequired,
      maxConcurrentPositions: config.filters.maxConcurrentPositions,
      dailyLossLimitSol: config.filters.dailyLossLimitSol,
      minVolume24hUsd: effectiveMinVolume24hUsd(),
      minHolderCount: effectiveMinHolders(),
      minHolders: effectiveMinHolders(),
      minRecentVolumeUsd: effectiveMinRecentVolumeUsd(),
      minRecentBuyVolumeUsd: effectiveMinRecentBuyVolumeUsd(),
      minRecentActivity: effectiveMinRecentActivity(),
      minTop10HolderPct: effectiveMinTop10HolderPct(),
      maxTop10HolderPct: effectiveMaxTop10HolderPct(),
      maxInsiderPctHard: effectiveMaxInsiderPct(),
      requireHealthyCurve: config.bondingCurve.requireHealthyCurve === true,
      buyPumpFunOnly: config.filters.buyPumpFunOnly === true,
      riskPercentPerTrade: config.risk.riskPercentPerTrade,
      maxDrawdownPct: config.risk.maxDrawdownPct,
      maxTradeSol: config.risk.maxTradeSol,
      weeklyLossLimitSol: config.risk.weeklyLossLimitSol,
      minConvictionScore: config.selective.minConvictionScore,
      maxTradesPerHour: config.selective.maxTradesPerHour,
      hardStopNormal: config.risk.normal.hardStopLossPct,
      hardStopMigration: config.risk.migration.hardStopLossPct,
      hardFloors: { ...HARD_FILTER_FLOORS },
    },
  };
}

export function randomTakeProfitPct(): number {
  const { minProfitPercent, maxProfitPercent } = config.trade;
  return minProfitPercent + Math.random() * (maxProfitPercent - minProfitPercent);
}

/** Flat config snapshot for dashboard/API */
export function getConfigSnapshot() {
  return {
    mode: config.mode,
    riskLevel: normalizeRiskLevel(config.riskLevel),
    riskLevelSummary: getRiskLevelSummary(),
    trade: { ...config.trade },
    filters: { ...config.filters },
    strategy: { ...config.strategy },
    risk: {
      ...config.risk,
      normal: { ...config.risk.normal, tiers: [...config.risk.normal.tiers] },
      migration: {
        ...config.risk.migration,
        tiers: [...config.risk.migration.tiers],
      },
    },
    profitStrategy: { ...config.profitStrategy },
    quickScalper: { ...config.quickScalper },
    microScalper: { ...config.microScalper },
    momentumBurst: { ...config.momentumBurst },
    postMigrationScalp: { ...config.postMigrationScalp },
    reversalScalp: { ...config.reversalScalp },
    postRunDip: { ...config.postRunDip },
    technicalLevels: { ...config.technicalLevels },
    chartPatterns: {
      ...config.chartPatterns,
      patterns: { ...(config.chartPatterns?.patterns || {}) },
    },
    selective: { ...config.selective },
    strategyToggles: { ...(config.strategyToggles || {}) },
    strategyProfile: config.strategyProfile || 'custom',
    highWinRatePresetActive: config.highWinRatePresetActive === true,
    strategyRecipeMode:
      config.strategyRecipeMode === 'custom' ? 'custom' : 'synced',
    strategyRecipeRiskLevel: config.strategyRecipeRiskLevel ?? normalizeRiskLevel(config.riskLevel),
    tradeProfiles: config.tradeProfiles
      ? (cloneJson({
          enabled: config.tradeProfiles.enabled !== false,
          smartBotProfiles: config.tradeProfiles.smartBotProfiles === true,
          profiles: config.tradeProfiles.profiles || {},
          overrides: config.tradeProfiles.overrides || {},
          autoScoring: config.tradeProfiles.autoScoring,
          globalTakeProfit: config.tradeProfiles.globalTakeProfit || {
            enabled: false,
            takeProfitPct: 25,
          },
        }) as typeof config.tradeProfiles)
      : undefined,
    paper: { ...config.paper },
    notifications: { ...config.notifications },
    marketScanner: { ...config.marketScanner },
    alphaScan: { ...config.alphaScan },
    zion: cloneJson(config.zion as unknown as Record<string, unknown>),
    trading: {
      activeId: config.activeTradingWalletId,
      wallets: config.tradingWallets.map((w) => ({
        id: w.id,
        name: w.name,
        role: w.role,
        envVar: w.envVar,
        enabled: w.enabled,
        isActive: w.id === config.activeTradingWalletId,
        // hasKey filled by API layer — never secrets
      })),
    },
    gmgn: {
      hasApiKey: Boolean(config.gmgn.apiKey || process.env.GMGN_API_KEY),
      baseUrl: config.gmgn.baseUrl,
      preferGmgnActivity: config.gmgn.preferGmgnActivity,
      cacheTtlMs: config.gmgn.cacheTtlMs,
      discovery: { ...config.gmgn.discovery },
    },
    birdeye: {
      hasApiKey: Boolean(
        config.birdeye.apiKey ||
          config.walletDiscovery.birdeyeApiKey ||
          process.env.BIRDEYE_API_KEY
      ),
      baseUrl: config.birdeye.baseUrl,
      cacheTtlMs: config.birdeye.cacheTtlMs,
    },
    walletDiscovery: {
      defaultSource: config.walletDiscovery.defaultSource,
      cacheTtlMs: config.walletDiscovery.cacheTtlMs,
      hasBirdeyeKey: Boolean(
        config.birdeye.apiKey ||
          config.walletDiscovery.birdeyeApiKey ||
          process.env.BIRDEYE_API_KEY
      ),
      hasSolanaTrackerKey: Boolean(
        config.solanaTracker.apiKey || process.env.SOLANA_TRACKER_API_KEY
      ),
    },
    solanaTracker: {
      hasApiKey: Boolean(
        config.solanaTracker.apiKey || process.env.SOLANA_TRACKER_API_KEY
      ),
      baseUrl: config.solanaTracker.baseUrl,
    },
    rpc: {
      endpoints: config.rpc.endpoints.map((e) => ({
        label: e.label,
        url: e.url.replace(/\/\/.*@/, '//***@').slice(0, 60),
        role: (e as { role?: string }).role,
      })),
      jitoEnabled: config.rpc.jito.enabled,
      healthIntervalMs: config.rpc.healthIntervalMs,
      failoverDownMs: config.rpc.failoverDownMs,
      shareLoad: Boolean(config.rpc.shareLoad),
    },
    mev: { ...config.mev },
    tokenMetrics: { ...config.tokenMetrics },
    bondingCurve: { ...config.bondingCurve },
    convergenceWindowMs: config.convergenceWindowMs,
    pollIntervalMs: config.pollIntervalMs,
    smartWallets: config.smartWallets,
    learningMode: (() => {
      try {
        const { getLearningModeStatus } =
          require('./learningMode') as typeof import('./learningMode');
        return getLearningModeStatus();
      } catch {
        return {
          enabled: config.learningMode?.enabled === true,
          strictness: config.learningMode?.strictness || 'middle',
          fairnessBoost: true,
          hasSnapshot: config.learningMode?.snapshot != null,
          overlays: null,
          label:
            config.learningMode?.enabled === true
              ? `Learning Mode · ${String(config.learningMode.strictness || 'middle')}`
              : 'Learning Mode OFF',
          liveWarning:
            config.learningMode?.enabled === true && config.mode === 'live',
        };
      }
    })(),
  };
}
