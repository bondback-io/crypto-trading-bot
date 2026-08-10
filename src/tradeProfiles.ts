/**
 * Multi-Profile trade assignment layer.
 *
 * Upgrade on top of the existing single strategyProfile / Risk / Strict stack:
 * - Multiple named profiles can be ON at once
 * - At entry, the best-matching enabled profile is chosen and stamped on the Position
 * - Exit params (TP/SL/trail/timer) are frozen from that profile onto the trade
 * - Risk Level + Strict Mode remain global modifiers when resolving effective rules
 * - When multi-profile is OFF (or only Default is relevant), behaviour matches today
 *
 * Concrete profiles (Scalper / Dip Buyer / Trend Rider / Migration Sniper /
 * High Win-Rate / Momentum Burst / Steady Compounder / Reversal Scalper /
 * Smart Money Mirror) ship complete rule sets.
 * Add new profiles by extending TRADE_PROFILE_CATALOG.
 */

import { config, persistUserSettings, effectiveMinMarketCapUsd } from './config';
import type { ShortTermStrategyId } from './shortTermStrategies';
import type { StrategyKey } from './strategies';
import {
  combineAutoScore,
  computeFactorAffinities,
  DEFAULT_AUTO_SCORING,
  normalizeAutoScoringConfig,
  AUTO_SCORING_WEIGHT_LABELS,
  type AutoScoringConfig,
  type ProfileScoreBreakdown,
} from './autoProfileScoring';
import {
  DEFAULT_HWR_QUALITY_FILTER,
  evaluateHwrQualityFilter,
  logHwrQualityFilterReject,
  logHwrQualityFilterSoft,
  normalizeHwrQualityFilter,
  type HighWinRateQualityFilter,
} from './hwrQualityFilter';

/** Per-profile strategy-module allowlist (Smart Bot Profiles ON). */
export type TradeProfileModules = Partial<Record<StrategyKey, boolean>>;

/** Shared safety / sizing modules most micro-bots keep when selectively enabled. */
const CORE_SAFETY_MODULES: TradeProfileModules = {
  anti_rug_honeypot: true,
  sniper_bundler_filters: true,
  volume_liquidity_filters: true,
  dynamic_position_sizing: true,
  mev_protection: true,
  min_holders_activity: true,
  bonding_curve_health: true,
};

/** Fast scalp stack — skip heavy conviction / trend pattern modules. */
const SCALPER_STYLE_MODULES: TradeProfileModules = {
  ...CORE_SAFETY_MODULES,
  smart_money_copy: true,
  // Keep scanner module allowlisted so cascade gates never false-OFF the
  // global Market Scanner master (poll/status use global; specialty still gated).
  ta_market_scanner: true,
  dead_market_exit: true,
  tiered_profit_taking: true,
  volume_spike_filter: true,
  momentum_confirmation: true,
  time_based_entry: true,
  early_entry_only: true,
  quick_scalper: true,
  micro_scalper: true,
  wallet_quality_scoring: true,
};

/** Trend / hold stack — patterns + conviction; no short scalp engines. */
const TREND_STYLE_MODULES: TradeProfileModules = {
  ...CORE_SAFETY_MODULES,
  smart_money_copy: true,
  ta_market_scanner: true,
  wallet_convergence: true,
  wallet_quality_scoring: true,
  multi_factor_conviction: true,
  hard_quality_gate: true,
  confirmation_layer: true,
  technical_levels: true,
  chart_patterns: true,
  heikin_ashi: true,
  pattern_structured_pullback: true,
  pattern_bull_flag: true,
  pattern_trend_continuation: true,
  pattern_volume_dryup_return: true,
  tiered_profit_taking: true,
  dead_market_exit: true,
  rebuy_on_dip: true,
  smart_money_flow_weighting: true,
  market_session_filter: true,
  time_based_entry: true,
};

export type {
  AutoScoringConfig,
  AutoScoringWeights,
  ProfileScoreBreakdown,
} from './autoProfileScoring';

/** Default Turbo priority-fee multiplier vs dynamic estimate */
export const TURBO_DEFAULT_PRIORITY_FEE_MULT = 2.5;
/** Default Turbo Jito tip multiplier vs base tip */
export const TURBO_DEFAULT_TIP_MULT = 2.0;
/** Default Turbo buy slippage floor (bps) */
export const TURBO_DEFAULT_SLIPPAGE_BPS = 250;

/** Raise buy slippage to Turbo floor when turboMode is on. */
export function resolveTurboSlippageBps(
  baseSlippageBps: number,
  opts?: {
    turboMode?: boolean;
    turboSlippageBps?: number | null;
  }
): number {
  const base =
    Number.isFinite(baseSlippageBps) && baseSlippageBps > 0
      ? Math.floor(baseSlippageBps)
      : 150;
  if (!opts?.turboMode) return base;
  const floor =
    opts.turboSlippageBps != null &&
    Number.isFinite(opts.turboSlippageBps) &&
    opts.turboSlippageBps > 0
      ? Math.floor(opts.turboSlippageBps)
      : TURBO_DEFAULT_SLIPPAGE_BPS;
  return Math.max(base, floor);
}
export {
  DEFAULT_AUTO_SCORING,
  DEFAULT_AUTO_SCORING_WEIGHTS,
  AUTO_SCORING_WEIGHT_LABELS,
  AUTO_SCORING_WEIGHT_KEYS,
} from './autoProfileScoring';
export {
  DEFAULT_HWR_QUALITY_FILTER,
  normalizeHwrQualityFilter,
  type HighWinRateQualityFilter,
} from './hwrQualityFilter';

export type TradeProfileId =
  | 'default'
  | 'scalper'
  | 'dip_buyer'
  | 'trend_rider'
  | 'migration_sniper'
  /** @deprecated aliased to migration_sniper on hydrate */
  | 'migration'
  | 'high_win_rate'
  | 'momentum_burst'
  | 'steady_compounder'
  | 'reversal_scalper'
  | 'smart_money_mirror'
  /** Manual KOL / Place Trade micro-bot — catalog for Active chips; not auto lane-fight */
  | 'zion';

export interface TradeProfileExitRules {
  /** Freeze take-profit % on the position */
  takeProfitPct?: number;
  /** Randomize TP in [min, max] at assignment (inclusive) */
  takeProfitPctMin?: number;
  takeProfitPctMax?: number;
  /**
   * Concrete hard stop-loss % after materialize — always negative (e.g. -12).
   * Catalog / UI min–max are positive loss magnitudes; materializeExitRules
   * and applyTradeProfileExitRules normalize to negative for exit engines.
   */
  stopLossPct?: number;
  /** Positive loss magnitude min when stopLossPct unset (e.g. 9 → −9) */
  stopLossPctMin?: number;
  /** Positive loss magnitude max when stopLossPct unset (e.g. 14 → −14) */
  stopLossPctMax?: number;
  trailingStopPct?: number;
  /** When trail arms (% profit) — informational / future use on position */
  trailingActivationProfit?: number;
  /** Force scalp-style timed exit when assigned */
  forceScalp?: boolean;
  shortTermStrategyId?: ShortTermStrategyId;
  /** After seeding scalp, overwrite TP/SL/timer with profile values */
  overrideScalpParams?: boolean;
  /** Exact hard time limit (seconds) */
  hardTimeLimitSec?: number;
  hardTimeLimitSecMin?: number;
  hardTimeLimitSecMax?: number;
  /**
   * Exit if price drops this % from high-water before TP (Momentum Burst / scalp protect).
   * Frozen onto position.scalpMomentumFailDropPct.
   */
  momentumFailDropPct?: number;
  /** Optional size multiplier vs dynamic size (1 = unchanged) */
  sizeMultiplier?: number;
  /**
   * Fixed SOL size for every trade on this profile (UI: Max Trade Override).
   * When > 0: replaces dynamic sizing (baseSol × risk/conviction × Size ×).
   * When unset / 0 / null: normal sizing. Still clamped by global maxAllowedTradeSol.
   */
  maxTradeOverrideSol?: number;
  /**
   * Aggressive dead-market exit: shorter min-hold before dead-volume can fire.
   * Frozen onto the position when set.
   */
  aggressiveDeadMarket?: boolean;
  deadVolumeMinHoldMinutes?: number;
  /**
   * Turbo Mode — prefer Jito + higher priority fees + slightly wider buy slip.
   * Default ON for Scalper / Migration Sniper / Momentum Burst / Reversal Scalper.
   * Paper + live sim: stamp + log would-be tip/prio (no real bundles).
   */
  turboMode?: boolean;
  /** When turbo: multiply dynamic priority-fee estimate (default 2.5) */
  turboPriorityFeeMultiplier?: number;
  /** When turbo: multiply base Jito tip (default 2.0) */
  turboTipMultiplier?: number;
  /** When turbo: buy slippage floor in bps (default 250) */
  turboSlippageBps?: number;
  /**
   * Adaptive exit brain overrides (Smart Bot / profile micro-bot).
   * Merged with catalog defaults in profileTradeIntelligence.resolveExitPolicy.
   */
  exitPolicy?: {
    earlyPartialTpPct?: number;
    earlyPartialFraction?: number;
    trailTightenFactor?: number;
    momentumFadeDropPct?: number;
    aggressiveDeadMarket?: boolean;
    qualityBreakdownExit?: boolean;
    profitLockArmPct?: number;
    profitGivebackPts?: number;
    profitFloorPct?: number;
    /**
     * Peak Profit Protection — arm when peak reaches this % of target TP
     * (overrides global scalper/non-scalper defaults when set).
     */
    peakProtectArmOfTpPct?: number;
    /** Peak Profit Protection — exit when giveback reaches this % of peak. */
    peakProtectGivebackOfPeakPct?: number;
    extendHoldIfTaOk?: boolean;
    cutIfStructureBroken?: boolean;
    /** Swing: exit on confirmed Heikin-Ashi red flip after ≥2 green HA candles */
    heikinAshiExitEnabled?: boolean;
  };
}

export interface TradeProfileMatchRules {
  preferScalp?: boolean;
  preferDip?: boolean;
  preferMigration?: boolean;
  preferTrend?: boolean;
  preferHighWinRate?: boolean;
  preferMomentumBurst?: boolean;
  preferReversal?: boolean;
  preferSteadyCompounder?: boolean;
  preferSmartMoneyMirror?: boolean;
  always?: boolean;
  minConviction?: number;
  /** Prefer small-cap tokens (Scalper) */
  preferSmallMc?: boolean;
  /**
   * Lane Max MC USD — hard reject when known MC is above this.
   * Empty/unset = no lane max (global filters only).
   */
  maxMarketCapUsd?: number;
  /**
   * Lane Min MC Override USD — raises this profile’s min MC above Config Min MC.
   * Effective floor = max(global effectiveMinMarketCapUsd, this). Empty/0 = global only.
   */
  minMarketCapUsd?: number;
  /** Prefer volume-spike entries (Scalper / Momentum) */
  preferVolumeSpike?: boolean;
  /**
   * Min token age (hours) — hard lane floor when set (>0).
   * Clock: hours since Pump.fun graduation when migrationAgeMs is known,
   * otherwise Dex pairCreated / launch age (tokenAgeHours). Empty/0 = no gate.
   */
  minTokenAgeHours?: number;
  /**
   * Migration Sniper: max hours since launch/pair for a "fresh" graduation.
   * Older PumpSwap buys must not inherit Migration Sniper.
   */
  maxTokenAgeHours?: number;
  /**
   * Migration Sniper fire band — bonding curve progress % inclusive.
   * Default catalog: 95–98 (pre-grad scalp).
   */
  minCurveProgressPct?: number;
  maxCurveProgressPct?: number;
  /**
   * Graduation watchlist arm threshold (default 80).
   * Tokens at/above this % are watched until fire band.
   */
  gradWatchPct?: number;
  /**
   * Ultra-fresh post-grad fallback window (seconds). Default 30.
   * Only used when pre-grad 95–98% window was missed.
   */
  maxMigrationAgeSec?: number;
  minHolders?: number;
  /**
   * Lane max top-10 holder % — hard reject when known concentration is above this.
   * Empty/0 = no lane top-10 floor (global anti-rug still applies).
   */
  maxTop10HoldPct?: number;
  minVolumeH1Usd?: number;
  minVolumeM5Usd?: number;
  /** Lane min recent buy pressure USD (known-only gate/bonus) */
  minBuyPressureUsd?: number;
  /** Dip / reversal: peak drop */
  minDropFromPeakPct?: number;
  maxDropFromPeakPct?: number;
  /**
   * Steady Compounder: small pullback band from local high (positive %).
   * When set with preferSteadyCompounder, require pullback in [min, max] OR volume uptick.
   */
  minPullbackPct?: number;
  maxPullbackPct?: number;
  /** Dip: min prior run % (e.g. 80–120) */
  minPriceChange24hPct?: number;
  /** Prefer MC at or above this for soft bonus (not a hard floor — use minMarketCapUsd for hard) */
  preferMarketCapUsd?: number;
  /** Dip: bonus when near Fib 0.5/0.618 or support */
  preferFibOrSupport?: boolean;
  /** Bonus when bullish chart patterns are active */
  preferBullishPatterns?: boolean;
  /**
   * High Win-Rate: require pattern + Fib/S + confirmation concurrence.
   */
  requireMultiTaConfirm?: boolean;
  /** Soft-bonus when holder count is rising vs prior snapshot */
  preferHolderGrowth?: boolean;
  /**
   * @deprecated Prefer primaryPatternIds + secondaryPatternIds.
   * Still honored as primary-tier if primary/secondary unset.
   */
  preferPatternIds?: string[];
  /** Primary pattern ids — strongest affinity for this profile */
  primaryPatternIds?: string[];
  /** Secondary pattern ids — useful but lower weight */
  secondaryPatternIds?: string[];
  /** Soft penalty / skip preference when bearish patterns fire */
  avoidBearishPatterns?: boolean;
  /** Prefer cleaner (breakout / high-confidence) pattern hits */
  preferCleanPatterns?: boolean;
  /** Profile pattern sensitivity: high = looser (fast profiles), low = stricter */
  patternSensitivity?: 'low' | 'medium' | 'high';
  /** Min pattern confidence (0–100) to count a hit — High Win-Rate uses higher */
  patternMinConfidence?: number;
  /** Require breakout confirmation for pattern bonus */
  patternRequireBreakout?: boolean;
  /** Structured pullback / dip: also require near Fib or support */
  patternRequireFibOrSupport?: boolean;
  /** Min liquidity USD for pattern bonus (HWR / higher MC) */
  patternMinLiquidityUsd?: number;
  /** Min holders for pattern bonus */
  patternMinHolders?: number;
  /** Min 1h volume USD for pattern bonus */
  patternMinVolumeH1Usd?: number;
  /** Min market cap USD for pattern bonus */
  patternMinMarketCapUsd?: number;
  /**
   * High Win-Rate only — Quality Filter for technical patterns / Fib / support.
   * When set, overrides the corresponding patternMin* floors for HWR.
   */
  qualityFilter?: Partial<HighWinRateQualityFilter>;
  /** Optional smart-money score floor (bonus, not hard fail if missing) */
  preferSmartMoney?: boolean;
  /** Cluster / wallet quality */
  minWalletCount?: number;
  requireCluster?: boolean;
  /** Min average wallet quality score (0–100) */
  minWalletQuality?: number;
  /**
   * When true, this profile receives specialty token feed candidates
   * (Kolscan/KOL mint universe + optional Jupiter category×interval).
   */
  kolscanFeedEnabled?: boolean;
  /** Min distinct KOL wallets on a mint (specialty KOL feed gate). Clamp 1–20. */
  minKolWallets?: number;
  /** Jupiter Tokens v2 category for this profile’s specialty Jupiter slice */
  jupiterCategory?: 'toptraded' | 'toptrending' | 'toporganicscore';
  /** Jupiter interval / volume window paired with jupiterCategory */
  jupiterInterval?: '5m' | '1h' | '6h' | '24h';
  /**
   * Entry-style DNA — primary / allowed / forbidden tags for lane scoring.
   * Detected once per fight via resolveDetectedEntryStyle; applied in scoreProfile
   * before HMC soft ×0.85 and MARL.
   */
  primaryEntryStyle?: string;
  allowedEntryStyles?: string[];
  forbiddenEntryStyles?: string[];
  /** When true, late_chase hard-zeros this profile */
  hardLateChase?: boolean;
}

/** Persisted user edits on top of official catalog defaults */
export type TradeProfileParamOverride = {
  exitRules?: Partial<TradeProfileExitRules>;
  match?: Partial<TradeProfileMatchRules>;
  /**
   * Per-profile module mask (Smart Bot Profiles).
   * Merged onto catalog defaults. `true` = use when globally ON;
   * `false` = never for this profile. Empty/missing on Default = inherit all.
   */
  modules?: TradeProfileModules;
};

export interface TradeProfileDefinition {
  id: TradeProfileId;
  name: string;
  icon: string;
  color: string;
  /** Short blurb: what this profile is best for */
  description: string;
  /** Suggested Risk Level for the Strategies Risk control (display only) */
  recommendedRisk: string;
  /** Trading style label for overview table (display only) */
  style: string;
  /** Short bullet list shown in Strategies UI */
  rulesSummary: string[];
  priority: number;
  defaultEnabled: boolean;
  match: TradeProfileMatchRules;
  exitRules: TradeProfileExitRules;
  /**
   * Curated module allowlist for Smart Bot Profiles mode.
   * Empty/missing = inherit all globally ON modules (Default).
   * When set: only keys with `true` participate (∩ global master ON).
   */
  modules?: TradeProfileModules;
}

/**
 * Canonical profile colours — high-contrast on dark UI.
 * Keep in sync with dashboard PROFILE_VISUALS.
 */
export const TRADE_PROFILE_COLORS = {
  default: '#94a3b8',
  scalper: '#f97316', // Orange
  dip_buyer: '#60a5fa', // Blue
  trend_rider: '#34d399',
  migration_sniper: '#c084fc', // Purple
  high_win_rate: '#4ade80', // Green
  momentum_burst: '#22d3ee', // Teal / Cyan
  steady_compounder: '#8ba3c7', // Grey-Blue
  reversal_scalper: '#ff6b3d', // Red-Orange
  smart_money_mirror: '#fbbf24', // Gold / Yellow
  /** Manual KOL / Zion micro-bot entries — apricot accent (matches Zion nav tab) */
  zion: '#f2ae66',
  legacy: '#64748b',
  skipped: '#64748b',
} as const;

export function tradeProfileColorFor(
  id: string | null | undefined
): string {
  if (!id) return TRADE_PROFILE_COLORS.legacy;
  const key = id as keyof typeof TRADE_PROFILE_COLORS;
  return TRADE_PROFILE_COLORS[key] || TRADE_PROFILE_COLORS.legacy;
}

/**
 * Official default pattern → profile map (primary / secondary).
 * Catalog match rules encode this; overrides remain configurable.
 */
export const DEFAULT_PATTERN_PROFILE_ASSIGNMENTS: Record<
  string,
  {
    name: string;
    primary: TradeProfileId[];
    secondary: TradeProfileId[];
    styleNote: string;
  }
> = {
  volume_dryup_return: {
    name: 'Volume Dry-up + Return',
    primary: ['dip_buyer', 'high_win_rate', 'steady_compounder'],
    secondary: ['trend_rider'],
    styleNote:
      'Prefer cleaner, higher-volume versions for High Win-Rate and higher MC tokens',
  },
  falling_wedge: {
    name: 'Falling Wedge Breakout',
    primary: ['dip_buyer', 'high_win_rate', 'reversal_scalper'],
    secondary: ['smart_money_mirror'],
    styleNote:
      'High Win-Rate should only take well-formed wedges on higher liquidity tokens',
  },
  structured_pullback: {
    name: 'Structured Pullback Detection',
    primary: ['dip_buyer', 'high_win_rate', 'trend_rider'],
    secondary: ['steady_compounder'],
    styleNote:
      'High Win-Rate prefers pullbacks that also sit on Fib or strong support',
  },
  bull_flag: {
    name: 'Bull Flag / Pennant',
    primary: ['momentum_burst', 'trend_rider', 'migration_sniper'],
    secondary: ['high_win_rate'],
    styleNote: 'Use tighter filters for High Win-Rate (stronger, higher MC flags)',
  },
  trend_continuation: {
    name: 'Trend Continuation',
    primary: ['trend_rider', 'steady_compounder', 'smart_money_mirror'],
    secondary: ['high_win_rate'],
    styleNote:
      'High Win-Rate should require higher holders, better volume, and stronger structure',
  },
};

/** Catalog — official defaults; user overrides merge at runtime */
export const TRADE_PROFILE_CATALOG: readonly TradeProfileDefinition[] = [
  {
    id: 'default',
    name: 'Default',
    icon: '◆',
    color: TRADE_PROFILE_COLORS.default,
    description:
      'Current global Strategy Profile + Risk/Strict — backward-compatible fallback',
    recommendedRisk: 'Matches your global Risk Level',
    style: 'Legacy / Global',
    rulesSummary: [
      'Uses live global TP/SL/trail/scalp settings',
      'Risk Level + Strict Mode stack as usual',
    ],
    priority: 0,
    defaultEnabled: true,
    match: { always: true },
    exitRules: {},
    // Empty = inherit all globally ON modules (even when Smart Bot Profiles is ON)
  },

  // ── 1. Scalper ───────────────────────────────────────────────────────────
  {
    id: 'scalper',
    name: 'Scalper',
    icon: '⚡',
    color: TRADE_PROFILE_COLORS.scalper,
    description:
      'Support-reclaim scalps on mid-MC tokens with tight risk and quick harvest.',
    recommendedRisk: 'High / Medium',
    style: 'Quick Scalp',
    rulesSummary: [
      'TP 18–30% · SL 7–12%',
      'Max hold 1–3.5 minutes · trail after +12%',
      'Smaller position size (~65%)',
      'Focus: mid MC ($150k–$800k) · multi-TF support reclaim',
      'Mode B: watch → arm near S → trigger on reclaim/hold',
      'Microcaps <$150k leave to Migration / Reversal',
      'Aggressive dead-market exit · early stall cut',
      'Turbo Mode ON — Jito-prefer / elevated prio (live); stamped in live sim',
    ],
    priority: 80,
    defaultEnabled: true,
    match: {
      preferScalp: true,
      preferSmallMc: true,
      preferVolumeSpike: true,
      minMarketCapUsd: 150_000,
      maxMarketCapUsd: 800_000,
      minHolders: 40,
      maxTop10HoldPct: 48,
      minVolumeM5Usd: 800,
      minConviction: 32,
      minWalletQuality: 32,
      minWalletCount: 1,
      requireCluster: false,
      primaryEntryStyle: 'scalp_reclaim_burst',
      allowedEntryStyles: [
        'level_momentum_expansion',
        'reversal_reclaim',
        'support_dip_reclaim',
      ],
      forbiddenEntryStyles: ['late_chase'],
      hardLateChase: false,
    },
    exitRules: {
      forceScalp: true,
      shortTermStrategyId: 'quick_scalper',
      overrideScalpParams: true,
      takeProfitPctMin: 18,
      takeProfitPctMax: 30,
      stopLossPctMin: 7,
      stopLossPctMax: 12,
      trailingStopPct: 8,
      trailingActivationProfit: 12,
      hardTimeLimitSecMin: 55,
      hardTimeLimitSecMax: 220,
      momentumFailDropPct: 9,
      sizeMultiplier: 0.65,
      aggressiveDeadMarket: true,
      deadVolumeMinHoldMinutes: 3,
      turboMode: true,
    },
    modules: { ...SCALPER_STYLE_MODULES },
  },

  // ── 2. Dip Buyer ─────────────────────────────────────────────────────────
  {
    id: 'dip_buyer',
    name: 'Dip Buyer',
    icon: '↘',
    color: TRADE_PROFILE_COLORS.dip_buyer,
    description:
      'Buys quality dips after a strong run using Fibs & support.',
    recommendedRisk: 'Medium',
    style: 'Dip / Swing',
    rulesSummary: [
      'TP 35–60% (partial + runner via trail)',
      'SL 12–18%',
      'Key levels: Fib 0.5 & 0.618 or clear support',
      'Established tokens: MC ≥$500k (prefer ≥$2M) · holders ≥100 · top10 ≤38%',
      'Dip ≥8% from peak (max ~45%) · watchlist → trigger on Fib/S',
      'Overlap $500–800k with Scalper resolved by Fib dip watch vs support reclaim',
      'Size: normal / slightly larger on high conviction',
    ],
    priority: 85,
    defaultEnabled: true,
    match: {
      preferDip: true,
      preferFibOrSupport: true,
      preferSmartMoney: true,
      preferBullishPatterns: true,
      primaryPatternIds: [
        'volume_dryup_return',
        'falling_wedge',
        'structured_pullback',
      ],
      patternSensitivity: 'medium',
      minConviction: 36,
      minWalletQuality: 35,
      minWalletCount: 1,
      requireCluster: false,
      minMarketCapUsd: 500_000,
      preferMarketCapUsd: 2_000_000,
      minHolders: 100,
      maxTop10HoldPct: 38,
      minVolumeH1Usd: 8_000,
      minDropFromPeakPct: 8,
      maxDropFromPeakPct: 45,
      minPriceChange24hPct: 25,
      kolscanFeedEnabled: true,
      minKolWallets: 3,
      jupiterCategory: 'toporganicscore',
      jupiterInterval: '1h',
      primaryEntryStyle: 'support_dip_reclaim',
      allowedEntryStyles: [
        'quality_structure_reclaim',
        'reversal_reclaim',
      ],
      forbiddenEntryStyles: ['level_momentum_expansion', 'late_chase'],
      hardLateChase: true,
    },
    exitRules: {
      shortTermStrategyId: 'post_run_dip',
      overrideScalpParams: true,
      takeProfitPctMin: 35,
      takeProfitPctMax: 60,
      stopLossPctMin: 12,
      stopLossPctMax: 18,
      trailingStopPct: 14,
      trailingActivationProfit: 35,
      sizeMultiplier: 1.1,
    },
    modules: {
      ...CORE_SAFETY_MODULES,
      smart_money_copy: true,
      ta_market_scanner: true,
      wallet_quality_scoring: true,
      multi_factor_conviction: true,
      post_run_dip: true,
      technical_levels: true,
      chart_patterns: true,
      pattern_volume_dryup_return: true,
      pattern_falling_wedge: true,
      pattern_structured_pullback: true,
      confirmation_layer: true,
      smart_money_flow_weighting: true,
      tiered_profit_taking: true,
      dead_market_exit: true,
      rebuy_on_dip: true,
    },
  },

  // ── Trend Rider (kept; Steady Compounder is the close sibling) ───────────
  {
    id: 'trend_rider',
    name: 'Trend Rider',
    icon: '▲',
    color: TRADE_PROFILE_COLORS.trend_rider,
    description:
      'Rides longer-lived tokens with holders and volume for steady continuation. HA exit rides green Heikin-Ashi then sells on red flip.',
    recommendedRisk: 'Low / Medium',
    style: 'Trend Hold',
    rulesSummary: [
      'Quality continuation: age ≥1.5h · MC ≥$1M priority for Trend watch (≥$75k catalog floor)',
      'Holders + KOL presence · 1h vol floor + soft tiers; multi-TF vol preferred over 5m spike',
      'Targets 8–18% · tighter risk (~7–10% SL)',
      'Patterns: pullback / bull flag / trend continuation',
      'HA exit: ride green Heikin-Ashi, sell on red flip',
      'Lane floors: age ≥1.5h · holders ≥50 · top10 ≤40% · 1h vol ≥$4k',
      'Specialty Jupiter/KOL/majors can bypass Pump.fun-only + Require TA (global scanner still gated)',
      'Live tape: soft-skip collapsed/decaying discretionary unless M5 uptick or KOL/Jupiter specialty',
      'Trend setup watch (≥$1M): watch → arm → fire; late-chase forbidden',
    ],
    priority: 76,
    defaultEnabled: true,
    match: {
      preferTrend: true,
      preferBullishPatterns: true,
      preferHolderGrowth: true,
      primaryPatternIds: [
        'structured_pullback',
        'bull_flag',
        'trend_continuation',
      ],
      secondaryPatternIds: ['volume_dryup_return'],
      avoidBearishPatterns: true,
      patternSensitivity: 'medium',
      minConviction: 38,
      minWalletQuality: 40,
      minWalletCount: 1,
      requireCluster: false,
      minTokenAgeHours: 1.5,
      minMarketCapUsd: 75_000,
      preferMarketCapUsd: 1_000_000,
      minHolders: 50,
      maxTop10HoldPct: 40,
      minVolumeH1Usd: 4_000,
      kolscanFeedEnabled: true,
      minKolWallets: 3,
      jupiterCategory: 'toporganicscore',
      jupiterInterval: '6h',
      primaryEntryStyle: 'trend_pullback_continuation',
      allowedEntryStyles: [
        'quality_structure_reclaim',
        'support_dip_reclaim',
      ],
      forbiddenEntryStyles: ['scalp_reclaim_burst', 'late_chase'],
      hardLateChase: true,
    },
    exitRules: {
      forceScalp: false,
      takeProfitPctMin: 8,
      takeProfitPctMax: 18,
      stopLossPctMin: 7,
      stopLossPctMax: 10,
      trailingStopPct: 6,
      trailingActivationProfit: 6,
      sizeMultiplier: 1.0,
      exitPolicy: {
        heikinAshiExitEnabled: true,
      },
    },
    modules: { ...TREND_STYLE_MODULES },
  },

  // ── 3. Migration Sniper ──────────────────────────────────────────────────
  {
    id: 'migration_sniper',
    name: 'Migration Sniper',
    icon: '🚀',
    color: TRADE_PROFILE_COLORS.migration_sniper,
    description:
      'Event lane: arm in the pre-mig sweet spot (~80–90% curve), enter without TA, hold through migration, exit on first spike + volume.',
    recommendedRisk: 'High / Medium',
    style: 'Event / Momentum',
    rulesSummary: [
      'Watch ~80% curve · fire / enter from ~88% when armed (no TA setup)',
      'Hold through migration · exit on first spike + volume step-up',
      'SL ~15% · post-mig max hold ~4 min · total safety ~12 min',
      'Soft quality: holders / buy pressure / volume (not chart patterns)',
      'Fallback: ultra-fresh post-grad ≤180s if curve window missed',
      'MC cap ~$150k — microcap event lane (not mid-band Scalper)',
      'Turbo Mode ON — Jito-prefer / elevated prio (live); stamped in live sim',
    ],
    priority: 92,
    /** Enabled with conservative size — event lane (not the old 8–45s scalp). */
    defaultEnabled: true,
    match: {
      preferMigration: true,
      preferSmartMoney: true,
      preferHolderGrowth: true,
      primaryPatternIds: [],
      patternSensitivity: 'high',
      minVolumeH1Usd: 1_000,
      minBuyPressureUsd: 200,
      minConviction: 22,
      minWalletQuality: 25,
      minWalletCount: 1,
      requireCluster: false,
      minCurveProgressPct: 88,
      maxCurveProgressPct: 99,
      gradWatchPct: 80,
      maxMigrationAgeSec: 180,
      maxTokenAgeHours: 0.05, // ~3 min for any post-grad age gate
      maxMarketCapUsd: 150_000,
      minHolders: 20,
      maxTop10HoldPct: 55,
      primaryEntryStyle: 'migration_hold_reclaim',
      allowedEntryStyles: [
        'level_momentum_expansion',
        'scalp_reclaim_burst',
      ],
      forbiddenEntryStyles: ['late_chase', 'support_dip_reclaim'],
      hardLateChase: false,
    },
    exitRules: {
      takeProfitPctMin: 10,
      takeProfitPctMax: 18,
      stopLossPctMin: 12,
      stopLossPctMax: 18,
      trailingStopPct: 10,
      trailingActivationProfit: 12,
      hardTimeLimitSecMin: 480,
      hardTimeLimitSecMax: 720,
      momentumFailDropPct: 0,
      forceScalp: true,
      shortTermStrategyId: 'migration_event',
      overrideScalpParams: true,
      sizeMultiplier: 0.7,
      maxTradeOverrideSol: 0.15,
      turboMode: true,
    },
    modules: {
      ...CORE_SAFETY_MODULES,
      smart_money_copy: true,
      migration_priority: true,
      near_migration_curve: true,
      early_curve_smart_money: true,
      migration_sniper: true,
      post_migration_scalp: false,
      volume_spike_filter: false,
      momentum_confirmation: false,
      time_based_entry: true,
      early_entry_only: true,
      wallet_quality_scoring: true,
      smart_money_flow_weighting: true,
      chart_patterns: false,
      pattern_bull_flag: false,
      tiered_profit_taking: true,
      dead_market_exit: true,
      quick_scalper: false,
    },
  },

  // ── 4. High Win-Rate ─────────────────────────────────────────────────────
  {
    id: 'high_win_rate',
    name: 'High Win-Rate',
    icon: '◎',
    color: TRADE_PROFILE_COLORS.high_win_rate,
    description:
      'Extremely selective setups focused on maximum win rate. HA exit rides green Heikin-Ashi then sells on red flip.',
    recommendedRisk: 'Low / Medium',
    style: 'High Quality',
    rulesSummary: [
      'TP 40–70%+ · SL 11–16%',
      'Min conviction 55+ · established MC / holders via Quality Filter',
      'Multi-TA: pattern + Fib/S + confirmation',
      'KOL / specialty feed preferred for scanner entries',
      'HA exit: ride green Heikin-Ashi, sell on red flip',
      'Selective · smaller size — accuracy over volume',
      'Lane floors: holders ≥150 · top10 ≤32% (soft ≤65% if age≥90d + liq≥$20k; ≤70% age-unknown fallback) · 1h vol ≥$15k',
    ],
    priority: 72,
    defaultEnabled: true,
    match: {
      preferHighWinRate: true,
      preferBullishPatterns: true,
      preferCleanPatterns: true,
      preferFibOrSupport: true,
      requireMultiTaConfirm: true,
      primaryPatternIds: [
        'volume_dryup_return',
        'falling_wedge',
        'structured_pullback',
      ],
      secondaryPatternIds: ['bull_flag', 'trend_continuation'],
      avoidBearishPatterns: true,
      patternSensitivity: 'low',
      patternMinConfidence: DEFAULT_HWR_QUALITY_FILTER.minPatternConfidence,
      patternRequireBreakout: false,
      patternRequireFibOrSupport: true,
      patternMinLiquidityUsd: DEFAULT_HWR_QUALITY_FILTER.minLiquidityUsd,
      patternMinHolders: DEFAULT_HWR_QUALITY_FILTER.minHolders,
      patternMinVolumeH1Usd: DEFAULT_HWR_QUALITY_FILTER.minVolumeH1Usd,
      patternMinMarketCapUsd: DEFAULT_HWR_QUALITY_FILTER.minMarketCapUsd,
      qualityFilter: { ...DEFAULT_HWR_QUALITY_FILTER },
      minMarketCapUsd: 500_000,
      preferMarketCapUsd: 50_000_000,
      minHolders: 150,
      maxTop10HoldPct: 32,
      minVolumeH1Usd: 15_000,
      minConviction: 55,
      requireCluster: true,
      minWalletCount: 2,
      minWalletQuality: 55,
      preferSmartMoney: true,
      kolscanFeedEnabled: true,
      minKolWallets: 4,
      jupiterCategory: 'toporganicscore',
      jupiterInterval: '6h',
      primaryEntryStyle: 'quality_structure_reclaim',
      allowedEntryStyles: [
        'trend_pullback_continuation',
        'support_dip_reclaim',
      ],
      forbiddenEntryStyles: ['late_chase', 'scalp_reclaim_burst'],
      hardLateChase: true,
    },
    exitRules: {
      takeProfitPctMin: 40,
      takeProfitPctMax: 70,
      stopLossPctMin: 11,
      stopLossPctMax: 16,
      trailingStopPct: 10,
      trailingActivationProfit: 22,
      sizeMultiplier: 0.7,
      exitPolicy: {
        heikinAshiExitEnabled: true,
      },
    },
    modules: {
      ...CORE_SAFETY_MODULES,
      smart_money_copy: true,
      ta_market_scanner: true,
      wallet_convergence: true,
      wallet_quality_scoring: true,
      multi_factor_conviction: true,
      hard_quality_gate: true,
      elite_convergence: true,
      profit_protected: true,
      confirmation_layer: true,
      technical_levels: true,
      chart_patterns: true,
      heikin_ashi: true,
      pattern_volume_dryup_return: true,
      pattern_falling_wedge: true,
      pattern_structured_pullback: true,
      pattern_bull_flag: true,
      pattern_trend_continuation: true,
      smart_money_flow_weighting: true,
      market_session_filter: true,
      tiered_profit_taking: true,
      dead_market_exit: true,
    },
  },

  // ── 5. Momentum Burst ────────────────────────────────────────────────────
  {
    id: 'momentum_burst',
    name: 'Momentum Burst',
    icon: '💥',
    color: TRADE_PROFILE_COLORS.momentum_burst,
    description:
      'Rides sudden strong volume and buy pressure for quick gains.',
    recommendedRisk: 'Medium / High',
    style: 'Short Momentum',
    rulesSummary: [
      'TP 28–45% · SL 10–14%',
      'Entry: M5 vol ≥ $8k + buy pressure / bull flag · conviction ≥ 48',
      'MC band ≤$400k — volume expansion (not Scalper support-only reclaim)',
      'Max hold ~2.5–7 min · trail after +10%',
      'Exit on fade / stall / trail — timer is backstop',
      'Turbo Mode ON — Jito-prefer / elevated prio (live); stamped in live sim',
    ],
    priority: 82,
    defaultEnabled: true,
    match: {
      preferMomentumBurst: true,
      preferVolumeSpike: true,
      primaryPatternIds: ['bull_flag'],
      patternSensitivity: 'high',
      patternMinConfidence: 48,
      maxMarketCapUsd: 400_000,
      minHolders: 30,
      maxTop10HoldPct: 45,
      minVolumeM5Usd: 8_000,
      minConviction: 48,
      minWalletQuality: 35,
      minWalletCount: 1,
      requireCluster: false,
      primaryEntryStyle: 'level_momentum_expansion',
      allowedEntryStyles: [
        'scalp_reclaim_burst',
        'migration_hold_reclaim',
      ],
      forbiddenEntryStyles: ['support_dip_reclaim'],
      hardLateChase: false,
    },
    exitRules: {
      forceScalp: true,
      shortTermStrategyId: 'momentum_burst',
      overrideScalpParams: true,
      takeProfitPctMin: 28,
      takeProfitPctMax: 45,
      stopLossPctMin: 10,
      stopLossPctMax: 14,
      trailingStopPct: 9,
      trailingActivationProfit: 10,
      hardTimeLimitSecMin: 140,
      hardTimeLimitSecMax: 420,
      momentumFailDropPct: 6,
      sizeMultiplier: 0.9,
      turboMode: true,
    },
    modules: {
      ...SCALPER_STYLE_MODULES,
      momentum_burst: true,
      volume_spike_filter: true,
      chart_patterns: true,
      pattern_bull_flag: true,
    },
  },

  // ── 6. Steady Compounder ─────────────────────────────────────────────────
  {
    id: 'steady_compounder',
    name: 'Steady Compounder',
    icon: '◇',
    color: TRADE_PROFILE_COLORS.steady_compounder,
    description:
      'Small consistent gains on more established tokens. HA exit rides green Heikin-Ashi then sells on red flip.',
    recommendedRisk: 'Low / Medium',
    style: 'Steady / Compounding',
    rulesSummary: [
      'TP 5–10% · SL 4–7%',
      'MC ≥$450k (prefer $1M) · holders ≥80 · decent volume',
      'Small pullbacks 2–20% or volume uptick — deep knives leave to Dip',
      'Patient but disciplined · no hard timer',
      'HA exit: ride green Heikin-Ashi, sell on red flip',
      'Lane floors: age ≥3h · holders ≥80 · 1h vol ≥$4k · MC ≥$450k (prefer ≥$50M medium) · top10 ≤35% (soft ≤68% if age≥90d + liq≥$10k; ≤72% age-unknown fallback)',
      'Quality holder gate: known high insider still hard-skip; unknown insider soft-pass; RugCheck single-holder / correlation hard-skip; min pro-trader when known',
      'Specialty Jupiter/KOL/majors/medium can bypass Pump.fun-only + Require TA (anti-rug + stables denied remain)',
      'Medium $50–200M + Majors ≥$200M dips soft-prefer Steady quality reclaim; Dip Buyer remains for true reclaim DNA on minors',
      'Armed-only / near-zero discretionary · maxConcurrent 1 · PCL ~25%/50% · RL Shadow until proven',
    ],
    priority: 70,
    defaultEnabled: true,
    match: {
      preferSteadyCompounder: true,
      preferBullishPatterns: true,
      primaryPatternIds: ['volume_dryup_return', 'trend_continuation'],
      secondaryPatternIds: ['structured_pullback'],
      avoidBearishPatterns: true,
      patternSensitivity: 'medium',
      patternMinConfidence: 55,
      minConviction: 40,
      minWalletQuality: 42,
      minWalletCount: 1,
      requireCluster: false,
      minTokenAgeHours: 3,
      minMarketCapUsd: 450_000,
      preferMarketCapUsd: 50_000_000,
      minHolders: 80,
      maxTop10HoldPct: 35,
      minVolumeH1Usd: 4_000,
      minPullbackPct: 2,
      maxPullbackPct: 20,
      kolscanFeedEnabled: true,
      minKolWallets: 3,
      jupiterCategory: 'toptrending',
      jupiterInterval: '6h',
      primaryEntryStyle: 'quality_structure_reclaim',
      allowedEntryStyles: [
        'trend_pullback_continuation',
        'support_dip_reclaim',
      ],
      forbiddenEntryStyles: ['late_chase', 'scalp_reclaim_burst'],
      hardLateChase: true,
    },
    exitRules: {
      forceScalp: false,
      takeProfitPctMin: 5,
      takeProfitPctMax: 10,
      stopLossPctMin: 4,
      stopLossPctMax: 7,
      trailingStopPct: 4,
      trailingActivationProfit: 4,
      sizeMultiplier: 1.0,
      exitPolicy: {
        heikinAshiExitEnabled: true,
      },
    },
    modules: {
      ...TREND_STYLE_MODULES,
      hard_quality_gate: true,
      profit_protected: true,
      social_sentiment_filter: true,
    },
  },

  // ── 7. Reversal Scalper ──────────────────────────────────────────────────
  {
    id: 'reversal_scalper',
    name: 'Reversal Scalper',
    icon: '↺',
    color: TRADE_PROFILE_COLORS.reversal_scalper,
    description:
      'Microcap mean-reversion on sharp wicks and over-extensions (<$150k MC).',
    recommendedRisk: 'High',
    style: 'Mean Reversion',
    rulesSummary: [
      'TP 15–25% · SL 6–10%',
      'Entry: wick / over-extension (≥12% from peak) · MC ≤$150k',
      'Max hold 1–2.5 minutes · trail after +10%',
      'Fast mean-reversion · early stall cut',
      'Owns microcaps with Migration Sniper — not mid-band Scalper',
      'Turbo Mode ON — Jito-prefer / elevated prio (live); stamped in live sim',
    ],
    priority: 83,
    /** Microcap specialist — Fast recovery still throttles Stage 0–1. */
    defaultEnabled: true,
    match: {
      preferReversal: true,
      primaryPatternIds: ['falling_wedge'],
      patternSensitivity: 'high',
      patternMinConfidence: 52,
      maxMarketCapUsd: 150_000,
      minHolders: 25,
      maxTop10HoldPct: 50,
      minDropFromPeakPct: 14,
      minConviction: 42,
      minWalletQuality: 40,
      minWalletCount: 1,
      requireCluster: false,
      primaryEntryStyle: 'reversal_reclaim',
      allowedEntryStyles: ['scalp_reclaim_burst', 'support_dip_reclaim'],
      forbiddenEntryStyles: ['trend_pullback_continuation', 'late_chase'],
      hardLateChase: false,
    },
    exitRules: {
      forceScalp: true,
      shortTermStrategyId: 'reversal_scalp',
      overrideScalpParams: true,
      takeProfitPctMin: 15,
      takeProfitPctMax: 25,
      stopLossPctMin: 6,
      stopLossPctMax: 10,
      trailingStopPct: 7,
      trailingActivationProfit: 10,
      hardTimeLimitSecMin: 90,
      hardTimeLimitSecMax: 240,
      momentumFailDropPct: 8,
      sizeMultiplier: 0.5,
      turboMode: true,
    },
    modules: {
      ...SCALPER_STYLE_MODULES,
      reversal_scalp: true,
      chart_patterns: true,
      pattern_falling_wedge: true,
      technical_levels: true,
    },
  },

  // ── 8. Smart Money Mirror ────────────────────────────────────────────────
  {
    id: 'smart_money_mirror',
    name: 'Smart Money Mirror',
    icon: '⧉',
    color: TRADE_PROFILE_COLORS.smart_money_mirror,
    description:
      'Follows high-quality wallet activity with confirmation.',
    recommendedRisk: 'Medium',
    style: 'Copy / Smart Money',
    rulesSummary: [
      'TP 30–50% · trail arms after modest profit (~10%)',
      'SL 9–14%',
      'Need 2+ wallets or strong quality + conviction',
      'Skip late copies after wallet peak dump',
      'Clean copy style — no scalp timer / no forced 16m exit',
    ],
    priority: 65,
    defaultEnabled: true,
    match: {
      preferSmartMoneyMirror: true,
      primaryPatternIds: ['trend_continuation'],
      secondaryPatternIds: ['falling_wedge'],
      preferBullishPatterns: true,
      patternSensitivity: 'medium',
      patternMinConfidence: 52,
      minWalletCount: 2,
      requireCluster: true,
      preferSmartMoney: true,
      minWalletQuality: 50,
      minConviction: 48,
      primaryEntryStyle: 'smart_money_confirm',
      allowedEntryStyles: [
        'quality_structure_reclaim',
        'trend_pullback_continuation',
        'support_dip_reclaim',
      ],
      forbiddenEntryStyles: ['late_chase'],
      hardLateChase: true,
    },
    exitRules: {
      forceScalp: false,
      takeProfitPctMin: 30,
      takeProfitPctMax: 50,
      stopLossPctMin: 9,
      stopLossPctMax: 14,
      trailingStopPct: 11,
      /** Arm trail after modest green — don't wait for full TP or EOW */
      trailingActivationProfit: 10,
      sizeMultiplier: 1.0,
    },
    modules: {
      ...CORE_SAFETY_MODULES,
      smart_money_copy: true,
      wallet_convergence: true,
      wallet_quality_scoring: true,
      multi_factor_conviction: true,
      smart_money_flow_weighting: true,
      confirmation_layer: true,
      chart_patterns: true,
      pattern_trend_continuation: true,
      pattern_falling_wedge: true,
      tiered_profit_taking: true,
      dead_market_exit: true,
      time_based_entry: true,
    },
  },

  // ── 10. Zion (KOL / Place Trade) ─────────────────────────────────────────
  {
    id: 'zion',
    name: 'Zion',
    icon: '◈',
    color: TRADE_PROFILE_COLORS.zion,
    description:
      'Isolated KOL Token Scanner + manual Place Trade offers (not watch-list copy).',
    recommendedRisk: 'Medium / High',
    style: 'KOL / Manual',
    rulesSummary: [
      'Signals from Kolscan + GMGN universe (not Favourites watch list)',
      'Manual or tiered Place Trade offers — not auto lane fights',
      'Uses Zion tab size / risk / exit settings',
      'Optional Platinum → High Win-Rate cascade',
    ],
    priority: 70,
    defaultEnabled: true,
    match: {
      // No auto-match flags — Place Trade stamps zion; lane fight skips this id
    },
    exitRules: {},
    modules: {
      ...CORE_SAFETY_MODULES,
      smart_money_copy: true,
      wallet_quality_scoring: true,
      multi_factor_conviction: true,
      confirmation_layer: true,
      dead_market_exit: true,
    },
  },
] as const;

/** Master override: fixed TP% for every micro-bot / trade-profile exit. */
export interface GlobalMicroBotTakeProfit {
  /** Default false — profile TP min/max and tiered profit modules remain in control */
  enabled: boolean;
  /** Fixed take-profit percent (positive). Used only when enabled. */
  takeProfitPct: number;
}

export const DEFAULT_GLOBAL_MICRO_BOT_TAKE_PROFIT: GlobalMicroBotTakeProfit = {
  enabled: false,
  takeProfitPct: 25,
};

export interface TradeProfileRuntimeState {
  enabled: boolean;
  /**
   * When true, each profile uses its curated module allowlist ∩ global master ON.
   * Default false = legacy shared modules for all profiles.
   */
  smartBotProfiles: boolean;
  profiles: Record<TradeProfileId, boolean>;
  /** User edits on top of official catalog defaults (per profile) */
  overrides?: Partial<Record<TradeProfileId, TradeProfileParamOverride>>;
  /** Automatic profile scoring (weights, threshold, force override) */
  autoScoring?: AutoScoringConfig;
  /** Per-profile self-learning runtime (toggle, version, proposals) */
  selfLearning?: Partial<
    Record<
      TradeProfileId,
      import('./profileSelfLearning').ProfileSelfLearningState
    >
  >;
  /**
   * Per-profile Learning Mode participation (entry soften / fairness / stamps).
   * Requires global Learning Mode ON. Default true when missing.
   * Independent of selfLearning.enabled (delta patches).
   */
  learningModeOptIn?: Partial<Record<TradeProfileId, boolean>>;
  /**
   * Master override for all trade-profile micro-bots: force a single fixed TP%.
   * Overrides TP min/max, profile exitRules TP, scalp TP stamps, and tiered
   * profit-taking / profitStrategy take-profit paths for profile-stamped trades.
   */
  globalTakeProfit?: GlobalMicroBotTakeProfit;
}

export interface TradeProfileAssignment {
  profileId: TradeProfileId;
  name: string;
  icon: string;
  color: string;
  score: number;
  reason: string;
  exitRules: TradeProfileExitRules;
  legacy: boolean;
  /** True when auto-scoring rejected all profiles below min score */
  skipped?: boolean;
  skipReason?: string;
  /** Whether automatic scoring path was used */
  autoScored?: boolean;
  /** Forced by user override */
  forced?: boolean;
  /** Top scored profiles for transparency */
  topScores?: Array<{
    id: TradeProfileId;
    name: string;
    icon: string;
    score: number;
    reason: string;
  }>;
}

export interface TradeProfileMatchContext {
  isMigration?: boolean;
  nearMigration?: boolean;
  earlyBuy?: boolean;
  /**
   * True when migration listener marked this mint within TTL (true fresh grad).
   * PumpSwap venue alone does NOT imply freshness.
   */
  migrationFresh?: boolean;
  /** Ms since migration detected (when known) — ultra-fresh fallback uses ≤30s */
  migrationAgeMs?: number | null;
  /** Bonding curve progress 0–100 when known */
  curveProgressPct?: number | null;
  scalpMode?: boolean;
  shortTermStrategyId?: string | null;
  convictionScore?: number | null;
  dropFromPeakPct?: number | null;
  /** Local pullback % from recent high (often same source as dropFromPeak) */
  localPullbackPct?: number | null;
  /** Distinct KOL wallets on mint when known (Zion / specialty Kolscan) */
  kolCount?: number | null;
  /** Holder growth % vs prior snapshot when known */
  holderGrowthPct?: number | null;
  /** Confirmation layer level when evaluated for HWR multi-TA */
  confirmationLevel?: 'none' | 'soft' | 'strong' | null;
  strategyKind?: 'migration' | 'normal';
  symbol?: string;
  marketCapUsd?: number | null;
  holderCount?: number | null;
  /** Top-10 holder concentration % when known (lane Max Top-10 floor). */
  top10HoldPct?: number | null;
  volumeH1Usd?: number | null;
  volumeM5Usd?: number | null;
  recentBuyVolumeUsd?: number | null;
  tokenAgeHours?: number | null;
  /** Dex/pair created-at ms when known — soft-allow calendar age (not migration). */
  pairCreatedAtMs?: number | null;
  /** Scanner/launch epoch ms when known — soft-allow calendar age fallback. */
  launchedAt?: number | null;
  priceChange24hPct?: number | null;
  priceChangeH1Pct?: number | null;
  nearKeyFib?: boolean;
  nearSupport?: boolean;
  /** Multi-TF S/R confluence (from scanner / enrich) */
  nearMultiTfSupport?: boolean;
  nearMultiTfResistance?: boolean;
  srConfluenceScore?: number | null;
  supportTfHits?: string[] | null;
  supportPriceSol?: number | null;
  resistancePriceSol?: number | null;
  fib05PriceSol?: number | null;
  fib618PriceSol?: number | null;
  priceSol?: number | null;
  /** Detected once per fight — entry-style DNA */
  detectedEntryStyle?: string | null;
  lateChase?: boolean;
  /** Active chart pattern ids from chartPatterns detector */
  chartPatternIds?: string[] | null;
  chartPatternSummary?: string | null;
  /** Detailed hits for quality gating / auto-scoring */
  chartPatternHits?: Array<{
    id: string;
    confidence: number;
    breakout: boolean;
    bias?: string;
  }> | null;
  /** Prefer cleaner pattern versions (High Win-Rate / large MC) */
  preferCleanPatterns?: boolean;
  smartMoneyScore?: number | null;
  /** Distinct smart wallets in the signal cluster */
  walletCount?: number | null;
  /** Average wallet quality score (0–100) for wallets in the signal */
  walletQualityAvg?: number | null;
  liquidityUsd?: number | null;
  /** True when entry came from Market Scanner (not pure wallet copy) */
  scannerOrigin?: boolean;
  entrySource?: 'wallet' | 'scanner' | 'migration' | 'hybrid' | null;
  /**
   * Prefer this profile when stamping after a Smart Bot lane fight
   * (must still pass floors + match).
   */
  preferProfileId?: string | null;
  /** Specialty feed tag when candidate came from per-profile Kolscan/Jupiter pass */
  specialtyFeed?: 'jupiter' | 'kolscan' | 'alphascan' | 'majors' | 'medium' | null;
  /**
   * Volume Intelligence decay when known at lane fight — Trend uses for live-tape gates.
   */
  volumeDecayState?:
    | 'expanding'
    | 'stable'
    | 'decaying'
    | 'collapsed'
    | null;
  /**
   * HMC Setup Classifier class when available (e.g. 'dip') — used to ease
   * dip_buyer conversion floors on classified dip paths.
   */
  hmcSetup?: string | null;
  /** Armed setup-watch handoff */
  armedWatch?: boolean;
  /** scalper | dip | grad when from a setup watch */
  setupWatchFamily?: string | null;
  /** Dip watch fired this handoff */
  dipWatchTriggered?: boolean;
  /** Preferred entry style from armed watch / scanner */
  entryStyleHint?: string | null;
}

const ALL_IDS: TradeProfileId[] = TRADE_PROFILE_CATALOG.map((p) => p.id);

function randBetween(min: number, max: number): number {
  const a = Math.min(min, max);
  const b = Math.max(min, max);
  return a + Math.random() * (b - a);
}

/**
 * Exit engines compare `pnlPct <= stopLossPct` and expect a negative threshold.
 * Catalog / UI store loss magnitude as positive (e.g. 12); convert to −12.
 * Already-negative values and zero are left unchanged.
 */
export function normalizeStopLossPct(value: number): number {
  if (!Number.isFinite(value)) return value;
  return value > 0 ? -Math.abs(value) : value;
}

/**
 * Fixed SOL size when maxTradeOverrideSol > 0; else null (use normal sizing).
 * Caller must still apply global maxAllowedTradeSol clamp.
 */
export function resolveMaxTradeOverrideSol(
  exitRules?: TradeProfileExitRules | null
): number | null {
  const v = Number(exitRules?.maxTradeOverrideSol);
  if (!Number.isFinite(v) || v <= 0) return null;
  return Number(v.toFixed(6));
}

/**
 * Apply profile size: Max Trade Override (fixed) wins over Size ×.
 * Does not clamp to global maxAllowedTradeSol — caller must.
 */
export function applyTradeProfileSizing(
  currentSizeSol: number,
  exitRules?: TradeProfileExitRules | null
): {
  sizeSol: number;
  usedOverride: boolean;
  sizeNote?: string;
} {
  const override = resolveMaxTradeOverrideSol(exitRules);
  if (override != null) {
    return {
      sizeSol: override,
      usedOverride: true,
      sizeNote: `Max Trade Override ${override} SOL`,
    };
  }
  const mult = exitRules?.sizeMultiplier;
  if (mult != null && Number.isFinite(mult) && mult > 0) {
    const sizeSol = Number((currentSizeSol * mult).toFixed(6));
    return {
      sizeSol,
      usedOverride: false,
      sizeNote: mult !== 1 ? `size ×${mult}` : undefined,
    };
  }
  return { sizeSol: currentSizeSol, usedOverride: false };
}

/** Normalize + clamp global micro-bot TP master override. */
export function normalizeGlobalMicroBotTakeProfit(
  raw?: Partial<GlobalMicroBotTakeProfit> | null
): GlobalMicroBotTakeProfit {
  const enabled = raw?.enabled === true;
  const pct = Number(raw?.takeProfitPct);
  return {
    enabled,
    takeProfitPct: Number.isFinite(pct)
      ? Math.max(1, Math.min(5000, Math.round(pct * 10) / 10))
      : DEFAULT_GLOBAL_MICRO_BOT_TAKE_PROFIT.takeProfitPct,
  };
}

/**
 * When Global Micro-Bot Take Profit is ON, returns the fixed TP%.
 * Otherwise null (profile / settings TP paths remain active).
 */
export function getGlobalMicroBotTakeProfitPct(): number | null {
  const g = normalizeGlobalMicroBotTakeProfit(ensureState().globalTakeProfit);
  if (!g.enabled) return null;
  return g.takeProfitPct;
}

export function isGlobalMicroBotTakeProfitActive(): boolean {
  return getGlobalMicroBotTakeProfitPct() != null;
}

/** Force fixed TP onto exit rules when the master override is active. */
export function applyGlobalMicroBotTakeProfitToExitRules(
  rules: TradeProfileExitRules
): TradeProfileExitRules {
  const tp = getGlobalMicroBotTakeProfitPct();
  if (tp == null) return rules;
  return {
    ...rules,
    takeProfitPct: tp,
    takeProfitPctMin: tp,
    takeProfitPctMax: tp,
  };
}

/** Turn range fields into concrete frozen values for one trade */
export function materializeExitRules(
  rules: TradeProfileExitRules
): TradeProfileExitRules {
  const out: TradeProfileExitRules = { ...rules };
  if (
    out.takeProfitPct == null &&
    out.takeProfitPctMin != null &&
    out.takeProfitPctMax != null
  ) {
    out.takeProfitPct =
      Math.round(randBetween(out.takeProfitPctMin, out.takeProfitPctMax) * 10) /
      10;
  }
  if (
    out.stopLossPct == null &&
    out.stopLossPctMin != null &&
    out.stopLossPctMax != null
  ) {
    out.stopLossPct =
      Math.round(randBetween(out.stopLossPctMin, out.stopLossPctMax) * 10) / 10;
  }
  // Always stamp concrete SL as negative for exit engines (TP stays positive)
  if (out.stopLossPct != null && Number.isFinite(out.stopLossPct)) {
    out.stopLossPct = normalizeStopLossPct(out.stopLossPct);
  }
  if (
    out.hardTimeLimitSec == null &&
    out.hardTimeLimitSecMin != null &&
    out.hardTimeLimitSecMax != null
  ) {
    out.hardTimeLimitSec = Math.round(
      randBetween(out.hardTimeLimitSecMin, out.hardTimeLimitSecMax)
    );
  }
  // Master override last — wins over TP min/max and any profile TP stamp
  return applyGlobalMicroBotTakeProfitToExitRules(out);
}

function mergeExitRules(
  base: TradeProfileExitRules,
  overlay?: Partial<TradeProfileExitRules> | null
): TradeProfileExitRules {
  if (!overlay) return { ...base };
  const merged: TradeProfileExitRules = { ...base, ...overlay };
  if (base.exitPolicy || overlay.exitPolicy) {
    merged.exitPolicy = {
      ...(base.exitPolicy || {}),
      ...(overlay.exitPolicy || {}),
    };
  }
  return merged;
}

function mergeMatchRules(
  base: TradeProfileMatchRules,
  overlay?: Partial<TradeProfileMatchRules> | null
): TradeProfileMatchRules {
  if (!overlay) return { ...base };
  const merged: TradeProfileMatchRules = { ...base, ...overlay };
  // Deep-merge HWR Quality Filter so partial UI saves don't wipe defaults
  if (base.qualityFilter || overlay.qualityFilter) {
    merged.qualityFilter = normalizeHwrQualityFilter({
      ...(base.qualityFilter || {}),
      ...(overlay.qualityFilter || {}),
    });
  }
  return merged;
}

function mergeModules(
  base: TradeProfileModules | undefined,
  overlay?: TradeProfileModules | null
): TradeProfileModules | undefined {
  if (!base && !overlay) return undefined;
  const merged: TradeProfileModules = { ...(base || {}), ...(overlay || {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Official catalog entry + persisted user overrides */
export function resolveTradeProfileDefinition(
  id: TradeProfileId | string | null | undefined
): TradeProfileDefinition & { hasOverrides: boolean } {
  const catalog = getTradeProfileDefinition(id);
  const state = ensureState();
  const ov = state.overrides?.[catalog.id];
  const hasOverrides = Boolean(
    ov &&
      ((ov.exitRules && Object.keys(ov.exitRules).length > 0) ||
        (ov.match && Object.keys(ov.match).length > 0) ||
        (ov.modules && Object.keys(ov.modules).length > 0))
  );
  let match = mergeMatchRules(catalog.match, ov?.match);
  // HWR: Quality Filter is source of truth for technical floors when present
  if (catalog.id === 'high_win_rate' || match.preferHighWinRate) {
    const qf = normalizeHwrQualityFilter(match.qualityFilter);
    match = {
      ...match,
      qualityFilter: qf,
      patternMinMarketCapUsd: qf.minMarketCapUsd,
      patternMinLiquidityUsd: qf.minLiquidityUsd,
      patternMinVolumeH1Usd: qf.minVolumeH1Usd,
      patternMinHolders: qf.minHolders,
      patternMinConfidence: qf.minPatternConfidence,
      patternRequireFibOrSupport: qf.preferFibOrSupport,
    };
  }
  return {
    ...catalog,
    match,
    exitRules: mergeExitRules(catalog.exitRules, ov?.exitRules),
    modules: mergeModules(catalog.modules, ov?.modules),
    hasOverrides,
  };
}

function writeTradeProfilesState(state: TradeProfileRuntimeState): void {
  (config as { tradeProfiles: TradeProfileRuntimeState }).tradeProfiles = state;
}

function defaultRuntimeState(): TradeProfileRuntimeState {
  const profiles = {} as Record<TradeProfileId, boolean>;
  for (const p of TRADE_PROFILE_CATALOG) {
    profiles[p.id] = p.defaultEnabled;
  }
  return {
    enabled: true,
    smartBotProfiles: true,
    profiles,
    overrides: {},
    autoScoring: { ...DEFAULT_AUTO_SCORING, weights: { ...DEFAULT_AUTO_SCORING.weights } },
    globalTakeProfit: { ...DEFAULT_GLOBAL_MICRO_BOT_TAKE_PROFIT },
  };
}

function ensureState(): TradeProfileRuntimeState {
  const existing = config.tradeProfiles as TradeProfileRuntimeState | undefined;
  if (!existing || typeof existing !== 'object') {
    const fresh = defaultRuntimeState();
    writeTradeProfilesState(fresh);
    return fresh;
  }

  const enabled =
    typeof existing.enabled === 'boolean' ? existing.enabled : true;
  const smartBotProfiles =
    typeof existing.smartBotProfiles === 'boolean'
      ? existing.smartBotProfiles
      : true;
  const profiles: Record<string, boolean> =
    existing.profiles && typeof existing.profiles === 'object'
      ? { ...existing.profiles }
      : { ...(defaultRuntimeState().profiles as Record<string, boolean>) };

  // Migrate legacy "migration" key → migration_sniper
  if (
    typeof profiles.migration === 'boolean' &&
    typeof profiles.migration_sniper !== 'boolean'
  ) {
    profiles.migration_sniper = profiles.migration;
  }

  for (const id of ALL_IDS) {
    if (id === 'migration') continue; // not in catalog
    if (typeof profiles[id] !== 'boolean') {
      const def = TRADE_PROFILE_CATALOG.find((p) => p.id === id);
      profiles[id] = def?.defaultEnabled ?? true;
    }
  }

  const overrides: Partial<Record<TradeProfileId, TradeProfileParamOverride>> =
    existing.overrides && typeof existing.overrides === 'object'
      ? { ...(existing.overrides as Partial<
          Record<TradeProfileId, TradeProfileParamOverride>
        >) }
      : {};

  const autoScoring = normalizeAutoScoringConfig(
    (existing as TradeProfileRuntimeState).autoScoring
  );

  // Preserve per-profile self-learning toggles/versions across ensureState rebuilds
  const selfLearning =
    existing.selfLearning && typeof existing.selfLearning === 'object'
      ? ({
          ...(existing.selfLearning as NonNullable<
            TradeProfileRuntimeState['selfLearning']
          >),
        } as NonNullable<TradeProfileRuntimeState['selfLearning']>)
      : undefined;

  const learningModeOptIn =
    existing.learningModeOptIn &&
    typeof existing.learningModeOptIn === 'object'
      ? ({
          ...(existing.learningModeOptIn as NonNullable<
            TradeProfileRuntimeState['learningModeOptIn']
          >),
        } as NonNullable<TradeProfileRuntimeState['learningModeOptIn']>)
      : undefined;

  const globalTakeProfit = normalizeGlobalMicroBotTakeProfit(
    (existing as TradeProfileRuntimeState).globalTakeProfit
  );

  const state: TradeProfileRuntimeState = {
    enabled,
    smartBotProfiles,
    profiles: profiles as Record<TradeProfileId, boolean>,
    overrides,
    autoScoring,
    globalTakeProfit,
    ...(selfLearning ? { selfLearning } : {}),
    ...(learningModeOptIn ? { learningModeOptIn } : {}),
  };
  writeTradeProfilesState(state);
  return state;
}

export function getTradeProfileDefinition(
  id: TradeProfileId | string | null | undefined
): TradeProfileDefinition {
  const hit = TRADE_PROFILE_CATALOG.find((p) => p.id === id);
  return hit ?? TRADE_PROFILE_CATALOG[0];
}

/** Smart Bot Profiles master switch — default OFF = legacy shared modules. */
export function isSmartBotProfilesEnabled(): boolean {
  return ensureState().smartBotProfiles === true;
}

/** Lightweight enabled map — avoids full getTradeProfilesStatus(). */
export function getTradeProfileEnabledFlags(): Record<string, boolean> {
  const state = ensureState();
  const out: Record<string, boolean> = {};
  for (const p of TRADE_PROFILE_CATALOG) {
    out[p.id] = state.profiles[p.id] !== false;
  }
  return out;
}

export function setSmartBotProfilesEnabled(
  enabled: boolean
): TradeProfileRuntimeState {
  const state = ensureState();
  state.smartBotProfiles = Boolean(enabled);
  persistUserSettings();
  console.log(
    `[trade-profiles] Smart Bot Profiles ${state.smartBotProfiles ? 'ON (micro-bots)' : 'OFF (legacy shared modules)'}`
  );
  return state;
}

/**
 * Resolved module mask for a profile (catalog + overrides).
 * Empty / missing = inherit-all (Default behaviour).
 */
export function resolveProfileModules(
  profileId: string | null | undefined
): TradeProfileModules | undefined {
  if (!profileId) return undefined;
  return resolveTradeProfileDefinition(profileId).modules;
}

/**
 * Whether a profile allowlist permits this strategy key.
 * Inherit-all when mask empty/missing. Allowlist otherwise (`true` required).
 */
export function profileAllowsModule(
  profileId: string | null | undefined,
  key: StrategyKey
): boolean {
  const modules = resolveProfileModules(profileId);
  if (!modules || Object.keys(modules).length === 0) return true;
  return modules[key] === true;
}

/**
 * Designed modules for UI/tooltip (profile allowlist), with global ON/OFF per row.
 * Always returns the profile's curated set so chips can show micro-bot intent
 * even when Smart Bot Profiles is OFF. Inherit-all (Default) → empty list + mode.
 */
export function listEffectiveModulesForProfile(
  profileId: string | null | undefined
): {
  smartBotProfiles: boolean;
  mode: 'inherit_all' | 'allowlist';
  modules: Array<{ key: StrategyKey; name: string; enabled: boolean }>;
} {
  const smartBotProfiles = isSmartBotProfilesEnabled();
  let isEnabled: (key: StrategyKey) => boolean = () => true;
  let nameFor: (key: StrategyKey) => string = (k) => k;
  try {
    const strat = require('./strategies') as typeof import('./strategies');
    isEnabled = (k) => strat.isStrategyEnabledGlobal(k);
    nameFor = (k) => strat.getStrategyDefinition(k)?.name || k;
  } catch {
    /* bootstrap */
  }

  const mask = resolveProfileModules(profileId);
  if (!mask || Object.keys(mask).length === 0) {
    return { smartBotProfiles, mode: 'inherit_all', modules: [] };
  }

  const modules: Array<{ key: StrategyKey; name: string; enabled: boolean }> =
    [];
  for (const [rawKey, on] of Object.entries(mask)) {
    if (on !== true) continue;
    const key = rawKey as StrategyKey;
    modules.push({
      key,
      name: nameFor(key),
      enabled: isEnabled(key),
    });
  }
  modules.sort((a, b) => a.name.localeCompare(b.name));
  return { smartBotProfiles, mode: 'allowlist', modules };
}

/** Active profile gate for nested isStrategyEnabled calls (Smart Bot ON). */
const strategyProfileGateStack: Array<string | null | undefined> = [];

export function getActiveStrategyProfileGate(): string | null | undefined {
  if (strategyProfileGateStack.length === 0) return undefined;
  return strategyProfileGateStack[strategyProfileGateStack.length - 1];
}

export function pushStrategyProfileGate(
  profileId: string | null | undefined
): void {
  strategyProfileGateStack.push(profileId);
}

export function popStrategyProfileGate(): void {
  strategyProfileGateStack.pop();
}

export async function withStrategyProfileGateAsync<T>(
  profileId: string | null | undefined,
  fn: () => Promise<T>
): Promise<T> {
  pushStrategyProfileGate(profileId);
  try {
    return await fn();
  } finally {
    popStrategyProfileGate();
  }
}

/**
 * Style floors for cascade after a lane win (WQ / cluster / conviction).
 * When Smart Bot Profiles is ON and a specialty micro-bot gate is active,
 * these come from that profile's resolved match — not shared Settings.
 * Default / inherit-all / Smart Bot OFF → profileOwned=false (use global effective*).
 */
export type CascadeMatchFloors = {
  minWalletQuality: number;
  minWalletCount: number;
  requireCluster: boolean;
  minConviction: number;
  profileId: string | null;
  profileName: string | null;
  profileOwned: boolean;
};

export function getActiveCascadeMatchFloors(
  profileId?: string | null
): CascadeMatchFloors {
  const gate =
    profileId !== undefined ? profileId : getActiveStrategyProfileGate();
  if (
    isSmartBotProfilesEnabled() &&
    gate != null &&
    gate !== '' &&
    gate !== 'default'
  ) {
    const def = resolveTradeProfileDefinition(gate);
    const m = def.match;
    let minWalletQuality = Math.max(
      0,
      Math.min(100, Number(m.minWalletQuality ?? 40))
    );
    let minWalletCount = Math.max(
      1,
      Math.min(5, Number(m.minWalletCount ?? 1))
    );
    let minConviction = Math.max(
      0,
      Math.min(100, Number(m.minConviction ?? 40))
    );
    try {
      const { isLearningModeActive, applyLearningMinOverlay } =
        require('./learningMode') as typeof import('./learningMode');
      if (isLearningModeActive() && isProfileLearningModeOptedIn(def.id)) {
        minWalletQuality = applyLearningMinOverlay(
          minWalletQuality,
          'minWalletQuality'
        );
        minConviction = applyLearningMinOverlay(minConviction, 'minConviction');
        minWalletCount = applyLearningMinOverlay(minWalletCount, 'minCluster');
      }
    } catch {
      /* ignore */
    }
    return {
      minWalletQuality,
      minWalletCount,
      requireCluster: m.requireCluster === true,
      minConviction,
      profileId: def.id,
      profileName: def.name,
      profileOwned: true,
    };
  }
  return {
    minWalletQuality: 0,
    minWalletCount: 1,
    requireCluster: false,
    minConviction: 0,
    profileId: gate ?? null,
    profileName: null,
    profileOwned: false,
  };
}

/** Default true when unset — preserves prior Global LM behavior until operator opts out. */
export function isProfileLearningModeOptedIn(
  profileId: string | null | undefined
): boolean {
  if (!profileId || profileId === 'default') return false;
  try {
    const state = ensureState();
    const map = state.learningModeOptIn;
    if (!map || typeof map !== 'object') return true;
    const v = map[profileId as TradeProfileId];
    if (v === undefined) return true;
    return v === true;
  } catch {
    return true;
  }
}

export function setProfileLearningModeOptIn(
  profileId: string,
  optedIn: boolean
): boolean {
  const id = profileId as TradeProfileId;
  if (!ALL_IDS.includes(id) || id === 'default') return false;
  const state = ensureState();
  if (!state.learningModeOptIn) state.learningModeOptIn = {};
  state.learningModeOptIn[id] = optedIn === true;
  writeTradeProfilesState(state);
  persistUserSettings();
  try {
    const { saveTradeProfilesUserState } =
      require('./tradeProfilesUserStore') as typeof import('./tradeProfilesUserStore');
    saveTradeProfilesUserState(serializeTradeProfilesForPersist());
  } catch {
    /* optional */
  }
  try {
    const { appendLearningSave } =
      require('./profileLearningSaveLog') as typeof import('./profileLearningSaveLog');
    appendLearningSave({
      profileId: id,
      kind: 'learning_mode',
      summary: optedIn
        ? 'Participate in Learning Mode ON'
        : 'Participate in Learning Mode OFF',
    });
  } catch {
    /* optional */
  }
  return optedIn === true;
}

export function countLearningModeOptInProfiles(): {
  optedIn: number;
  total: number;
} {
  let optedIn = 0;
  const total = TRADE_PROFILE_CATALOG.length;
  for (const p of TRADE_PROFILE_CATALOG) {
    if (isProfileLearningModeOptedIn(p.id)) optedIn += 1;
  }
  return { optedIn, total };
}

/** LM-adjusted profile match mins (Middle/Looser never raise vs def.match). */
function learningAdjustedMatchMins(
  profileId: string,
  m: TradeProfileDefinition['match']
): {
  minConviction: number | null | undefined;
  minWalletQuality: number | null | undefined;
} {
  let minConviction = m.minConviction;
  let minWalletQuality = m.minWalletQuality;
  try {
    const { isLearningModeActive, applyLearningMinOverlay } =
      require('./learningMode') as typeof import('./learningMode');
    if (isLearningModeActive() && isProfileLearningModeOptedIn(profileId)) {
      if (minConviction != null && Number.isFinite(minConviction)) {
        minConviction = applyLearningMinOverlay(
          Number(minConviction),
          'minConviction'
        );
      }
      if (minWalletQuality != null && Number.isFinite(minWalletQuality)) {
        minWalletQuality = applyLearningMinOverlay(
          Number(minWalletQuality),
          'minWalletQuality'
        );
      }
    }
  } catch {
    /* ignore */
  }
  return { minConviction, minWalletQuality };
}

export function getTradeProfilesStatus(): {
  enabled: boolean;
  smartBotProfiles: boolean;
  globalTakeProfit: GlobalMicroBotTakeProfit;
  dipWatch?: { active: number; entries: unknown[] };
  gradWatch?: { active: number; entries: unknown[] };
  profiles: Array<
    TradeProfileDefinition & {
      enabled: boolean;
      active: boolean;
      hasOverrides: boolean;
      officialExitRules: TradeProfileExitRules;
      officialMatch: TradeProfileMatchRules;
      officialModules?: TradeProfileModules;
      effectiveModules: ReturnType<typeof listEffectiveModulesForProfile>;
      selfLearning: import('./profileSelfLearning').ProfileSelfLearningState;
      selfLearnBadge: string;
      /** Participate in Global Learning Mode (entry soften / fairness / stamps) */
      learningModeOptIn: boolean;
      learningProgress: import('./profileSelfLearning').LearningProgressSnapshot;
      laneFloorHints: Array<{
        summary: string;
        field: string;
        current: number | null;
        suggested: number;
      }>;
    }
  >;
  active: Array<{ id: TradeProfileId; name: string; icon: string; color: string }>;
  autoScoring: AutoScoringConfig;
  weightLabels: typeof AUTO_SCORING_WEIGHT_LABELS;
  /** Official pattern → profile map (defaults; match overrides remain editable) */
  patternAssignments: typeof DEFAULT_PATTERN_PROFILE_ASSIGNMENTS;
  /** High Win-Rate Quality Filter defaults (also on high_win_rate.match.qualityFilter) */
  hwrQualityFilter: typeof DEFAULT_HWR_QUALITY_FILTER;
  recentDecisions: TradeProfileDecisionLog[];
} {
  const state = ensureState();
  const {
    normalizeSelfLearning,
    formatSelfLearnBadge,
    refreshSelfLearnMetrics,
    getLearningProgressSnapshot,
  } = require('./profileSelfLearning') as typeof import('./profileSelfLearning');
  const profiles = TRADE_PROFILE_CATALOG.map((p) => {
    const resolved = resolveTradeProfileDefinition(p.id);
    let sl = normalizeSelfLearning(state.selfLearning?.[p.id]);
    if (sl.enabled) {
      sl = refreshSelfLearnMetrics(sl, p.id);
    }
    let laneFloorHints: ReturnType<typeof buildLaneFloorLearningHints> = [];
    try {
      laneFloorHints = buildLaneFloorLearningHints(p.id);
    } catch {
      laneFloorHints = [];
    }
    return {
      ...resolved,
      enabled: state.profiles[p.id] !== false,
      active: state.enabled && state.profiles[p.id] !== false,
      officialExitRules: { ...p.exitRules },
      officialMatch: { ...p.match },
      officialModules: p.modules ? { ...p.modules } : undefined,
      effectiveModules: listEffectiveModulesForProfile(p.id),
      selfLearning: sl,
      selfLearnBadge: formatSelfLearnBadge(sl),
      learningModeOptIn: isProfileLearningModeOptedIn(p.id),
      learningProgress: getLearningProgressSnapshot(p.id, sl, resolved.name),
      laneFloorHints,
    };
  });
  return {
    enabled: state.enabled,
    smartBotProfiles: state.smartBotProfiles === true,
    globalTakeProfit: normalizeGlobalMicroBotTakeProfit(state.globalTakeProfit),
    dipWatch: (() => {
      try {
        const { getDipSetupWatchStatus } =
          require('./dipSetupWatch') as typeof import('./dipSetupWatch');
        return getDipSetupWatchStatus(28);
      } catch {
        return {
          active: 0,
          entries: [],
          recentTerminal: [],
        };
      }
    })(),
    gradWatch: (() => {
      try {
        const { getMigrationGradWatchStatus } =
          require('./migrationGradWatch') as typeof import('./migrationGradWatch');
        return getMigrationGradWatchStatus(16);
      } catch {
        return { active: 0, entries: [], recentTerminal: [] };
      }
    })(),
    profiles,
    active: profiles
      .filter((p) => p.active)
      .map((p) => ({
        id: p.id,
        name: p.name,
        icon: p.icon,
        color: p.color,
      })),
    autoScoring: normalizeAutoScoringConfig(state.autoScoring),
    weightLabels: AUTO_SCORING_WEIGHT_LABELS,
    patternAssignments: DEFAULT_PATTERN_PROFILE_ASSIGNMENTS,
    hwrQualityFilter: DEFAULT_HWR_QUALITY_FILTER,
    recentDecisions: getRecentTradeProfileDecisions(),
  };
}

export interface TradeProfileDecisionLog {
  at: number;
  symbol: string;
  profileId: TradeProfileId | 'skipped';
  profileName: string;
  icon: string;
  score: number;
  reason: string;
  skipped: boolean;
  autoScored: boolean;
  forced: boolean;
  topScores: Array<{ id: string; name: string; score: number }>;
}

const DECISION_LOG_MAX = 40;
const recentDecisions: TradeProfileDecisionLog[] = [];

export function getRecentTradeProfileDecisions(): TradeProfileDecisionLog[] {
  return recentDecisions.slice(0, DECISION_LOG_MAX);
}

/** Synthetic lane-fight row for Zion Platinum → HWR (and similar external handoffs). */
export function recordSyntheticProfileDecision(input: {
  symbol: string;
  profileId: TradeProfileId;
  profileName: string;
  icon: string;
  score: number;
  reason: string;
}): void {
  pushDecision({
    at: Date.now(),
    symbol: input.symbol || 'token',
    profileId: input.profileId,
    profileName: input.profileName,
    icon: input.icon,
    score: input.score,
    reason: input.reason,
    skipped: false,
    autoScored: false,
    forced: true,
    topScores: [
      {
        id: input.profileId,
        name: input.profileName,
        score: input.score,
      },
    ],
  });
}

function pushDecision(entry: TradeProfileDecisionLog): void {
  recentDecisions.unshift(entry);
  if (recentDecisions.length > DECISION_LOG_MAX) {
    recentDecisions.length = DECISION_LOG_MAX;
  }
}

export function updateAutoScoringConfig(
  partial: Partial<AutoScoringConfig> & {
    weights?: Partial<AutoScoringConfig['weights']>;
  }
): ReturnType<typeof getTradeProfilesStatus> {
  const state = ensureState();
  const cur = normalizeAutoScoringConfig(state.autoScoring);
  const next = normalizeAutoScoringConfig({
    ...cur,
    ...partial,
    weights: { ...cur.weights, ...(partial.weights || {}) },
  });
  // Validate force id
  if (
    next.forceProfileId &&
    !ALL_IDS.includes(next.forceProfileId) &&
    next.forceProfileId !== ('migration' as TradeProfileId)
  ) {
    next.forceProfileId = null;
  }
  if (next.forceProfileId === 'default') {
    // allow default force
  }
  state.autoScoring = next;
  persistUserSettings();
  console.log(
    `[trade-profiles] Auto-scoring ${next.enabled ? 'ON' : 'OFF'}` +
      ` · min=${next.minScore}` +
      (next.forceProfileId ? ` · force=${next.forceProfileId}` : '')
  );
  return getTradeProfilesStatus();
}

export function isMultiProfileEnabled(): boolean {
  return ensureState().enabled !== false;
}

export function setMultiProfileEnabled(enabled: boolean): TradeProfileRuntimeState {
  const state = ensureState();
  state.enabled = Boolean(enabled);
  persistUserSettings();
  console.log(
    `[trade-profiles] Multi-profile ${state.enabled ? 'ENABLED' : 'DISABLED (legacy Default only)'}`
  );
  return state;
}

export function setTradeProfileEnabled(
  id: TradeProfileId,
  enabled: boolean
): TradeProfileRuntimeState {
  const state = ensureState();
  if (!ALL_IDS.includes(id)) return state;
  if (id === 'default' && !enabled) {
    console.log('[trade-profiles] Default profile cannot be fully disabled');
    state.profiles.default = true;
  } else {
    state.profiles[id] = Boolean(enabled);
  }
  persistUserSettings();
  console.log(`[trade-profiles] ${id} → ${state.profiles[id] ? 'ON' : 'OFF'}`);
  return state;
}

export function updateTradeProfilesConfig(partial: {
  enabled?: boolean;
  smartBotProfiles?: boolean;
  profiles?: Partial<Record<TradeProfileId, boolean>>;
  globalTakeProfit?: Partial<GlobalMicroBotTakeProfit>;
}): ReturnType<typeof getTradeProfilesStatus> {
  const state = ensureState();
  if (partial.enabled != null) state.enabled = Boolean(partial.enabled);
  if (partial.smartBotProfiles != null) {
    state.smartBotProfiles = Boolean(partial.smartBotProfiles);
    console.log(
      `[trade-profiles] Smart Bot Profiles ${state.smartBotProfiles ? 'ON (micro-bots)' : 'OFF (legacy shared modules)'}`
    );
  }
  if (partial.globalTakeProfit && typeof partial.globalTakeProfit === 'object') {
    state.globalTakeProfit = normalizeGlobalMicroBotTakeProfit({
      ...normalizeGlobalMicroBotTakeProfit(state.globalTakeProfit),
      ...partial.globalTakeProfit,
    });
    console.log(
      `[trade-profiles] Global Micro-Bot Take Profit ${
        state.globalTakeProfit.enabled
          ? `ON @ ${state.globalTakeProfit.takeProfitPct}% (master override)`
          : 'OFF'
      }`
    );
  }
  if (partial.profiles) {
    for (const [id, on] of Object.entries(partial.profiles)) {
      if (!ALL_IDS.includes(id as TradeProfileId)) continue;
      if (id === 'default' && on === false) {
        state.profiles.default = true;
        continue;
      }
      state.profiles[id as TradeProfileId] = Boolean(on);
    }
  }
  persistUserSettings();
  return getTradeProfilesStatus();
}

/** Merge user-editable params onto a profile (keeps official defaults underneath). */
export function updateTradeProfileParams(
  id: TradeProfileId,
  patch: TradeProfileParamOverride
): ReturnType<typeof getTradeProfilesStatus> {
  const state = ensureState();
  if (!ALL_IDS.includes(id) || id === 'default') {
    return getTradeProfilesStatus();
  }
  if (!state.overrides) state.overrides = {};
  const prev = state.overrides[id] || {};
  const nextExit = { ...(prev.exitRules || {}), ...(patch.exitRules || {}) };
  const nextMatch = { ...(prev.match || {}), ...(patch.match || {}) };
  const nextModules = {
    ...(prev.modules || {}),
    ...(patch.modules || {}),
  };
  // Deep-merge exitPolicy so partial profit-lock saves don't wipe other keys
  if (patch.exitRules?.exitPolicy || prev.exitRules?.exitPolicy) {
    nextExit.exitPolicy = {
      ...(prev.exitRules?.exitPolicy || {}),
      ...(patch.exitRules?.exitPolicy || {}),
    };
  }
  // Deep-merge qualityFilter nested object
  if (patch.match?.qualityFilter || prev.match?.qualityFilter) {
    nextMatch.qualityFilter = normalizeHwrQualityFilter({
      ...(prev.match?.qualityFilter || {}),
      ...(patch.match?.qualityFilter || {}),
    });
  }
  // Drop null/NaN keys so clearing a field falls back to official default
  for (const [k, v] of Object.entries(nextExit)) {
    if (v == null || (typeof v === 'number' && !Number.isFinite(v))) {
      delete (nextExit as Record<string, unknown>)[k];
      continue;
    }
    // Empty / 0 Max Trade Override → unset (use normal sizing)
    if (
      k === 'maxTradeOverrideSol' &&
      typeof v === 'number' &&
      v <= 0
    ) {
      delete (nextExit as Record<string, unknown>)[k];
    }
    // Empty / 0 fail-drop / trail → unset (catalog default)
    if (
      (k === 'momentumFailDropPct' ||
        k === 'trailingActivationProfit' ||
        k === 'trailingStopPct') &&
      typeof v === 'number' &&
      v <= 0
    ) {
      delete (nextExit as Record<string, unknown>)[k];
    }
  }
  for (const [k, v] of Object.entries(nextMatch)) {
    if (k === 'qualityFilter') continue;
    if (v == null || (typeof v === 'number' && !Number.isFinite(v))) {
      delete (nextMatch as Record<string, unknown>)[k];
      continue;
    }
    // Empty / 0 profile entry knobs → unset to official catalog defaults
    if (
      (k === 'minMarketCapUsd' ||
        k === 'maxMarketCapUsd' ||
        k === 'minTokenAgeHours' ||
        k === 'maxTokenAgeHours' ||
        k === 'minHolders' ||
        k === 'maxTop10HoldPct' ||
        k === 'minVolumeH1Usd' ||
        k === 'minVolumeM5Usd' ||
        k === 'minBuyPressureUsd' ||
        k === 'minDropFromPeakPct' ||
        k === 'maxDropFromPeakPct' ||
        k === 'minPullbackPct' ||
        k === 'maxPullbackPct' ||
        k === 'preferMarketCapUsd' ||
        k === 'minPriceChange24hPct' ||
        k === 'minWalletCount' ||
        k === 'minWalletQuality' ||
        k === 'minKolWallets' ||
        k === 'patternMinConfidence' ||
        k === 'gradWatchPct' ||
        k === 'minCurveProgressPct' ||
        k === 'maxCurveProgressPct' ||
        k === 'maxMigrationAgeSec') &&
      typeof v === 'number' &&
      v <= 0
    ) {
      delete (nextMatch as Record<string, unknown>)[k];
    }
    // Empty string category/interval → unset to catalog default
    if (
      (k === 'jupiterCategory' || k === 'jupiterInterval') &&
      typeof v === 'string' &&
      !String(v).trim()
    ) {
      delete (nextMatch as Record<string, unknown>)[k];
    }
  }
  for (const [k, v] of Object.entries(nextModules)) {
    if (v == null) delete (nextModules as Record<string, unknown>)[k];
  }
  state.overrides[id] = {
    exitRules: nextExit,
    match: nextMatch,
    modules: Object.keys(nextModules).length > 0 ? nextModules : undefined,
  };
  persistUserSettings();
  try {
    const { appendLearningSave } =
      require('./profileLearningSaveLog') as typeof import('./profileLearningSaveLog');
    appendLearningSave({
      profileId: id,
      kind: 'knobs',
      summary: 'Saved trade profile exit/match knobs',
    });
  } catch {
    /* optional */
  }
  console.log(`[trade-profiles] Updated params for ${id}`);
  return getTradeProfilesStatus();
}

/** Restore a profile to official catalog defaults (clears overrides). */
export function resetTradeProfileParams(
  id: TradeProfileId | 'all'
): ReturnType<typeof getTradeProfilesStatus> {
  const state = ensureState();
  if (!state.overrides) state.overrides = {};
  if (id === 'all') {
    state.overrides = {};
  } else if (ALL_IDS.includes(id)) {
    delete state.overrides[id];
  }
  persistUserSettings();
  console.log(
    `[trade-profiles] Reset params → ${id === 'all' ? 'all profiles' : id}`
  );
  return getTradeProfilesStatus();
}

/**
 * Full Trade Profiles stack → catalog defaults:
 * multi-profile ON, Smart Bot ON, default enable map, no overrides, default auto-scoring.
 */
export function resetTradeProfilesToCatalogDefaults(options?: {
  persist?: boolean;
}): ReturnType<typeof getTradeProfilesStatus> {
  writeTradeProfilesState(defaultRuntimeState());
  if (options?.persist !== false) persistUserSettings();
  console.log(
    '[trade-profiles] Reset to catalog defaults (multi-profile + Smart Bot + enable map + overrides cleared)'
  );
  return getTradeProfilesStatus();
}

/** Default freshness gates for Migration Sniper (pump.fun → DEX grads only). */
export const FRESH_MIGRATION_MAX_AGE_HOURS = 3;
export const FRESH_MIGRATION_MAX_MC_USD = 600_000;

/**
 * Migration Sniper eligibility — primary: pre-grad curve fire (≥ minCurve, still
 * on curve); fallback: ultra-fresh post-grad (≤ maxMigrationAgeSec, default 180s).
 *
 * Near-curve below fire band stays on the graduation watchlist (not a buy).
 * Mature PumpSwap / stale migrations are rejected.
 */
export function evaluateFreshMigrationEligibility(
  ctx: TradeProfileMatchContext,
  rules?: Pick<
    TradeProfileMatchRules,
    | 'maxTokenAgeHours'
    | 'maxMarketCapUsd'
    | 'minCurveProgressPct'
    | 'maxCurveProgressPct'
    | 'maxMigrationAgeSec'
  >
): { ok: boolean; reason: string } {
  const minCurve =
    rules?.minCurveProgressPct != null &&
    Number.isFinite(rules.minCurveProgressPct)
      ? Number(rules.minCurveProgressPct)
      : 88;
  const maxPostGradSec =
    rules?.maxMigrationAgeSec != null &&
    Number.isFinite(rules.maxMigrationAgeSec)
      ? Number(rules.maxMigrationAgeSec)
      : 180;
  const maxMc =
    rules?.maxMarketCapUsd != null && Number.isFinite(rules.maxMarketCapUsd)
      ? Number(rules.maxMarketCapUsd)
      : 100_000;

  const progress =
    ctx.curveProgressPct != null && Number.isFinite(ctx.curveProgressPct)
      ? Number(ctx.curveProgressPct)
      : null;
  const mc =
    ctx.marketCapUsd != null && Number.isFinite(ctx.marketCapUsd)
      ? Number(ctx.marketCapUsd)
      : null;

  if (mc != null && mc > maxMc) {
    return {
      ok: false,
      reason: `MC $${Math.round(mc)} too mature for Migration Sniper (max $${maxMc})`,
    };
  }

  // Primary: pre-grad fire — ≥ minCurve while not yet migrated (no upper miss)
  const inFireBand =
    progress != null &&
    progress >= minCurve &&
    progress < 100 &&
    ctx.isMigration !== true;

  if (inFireBand && (ctx.nearMigration === true || progress != null)) {
    return {
      ok: true,
      reason: `pre-grad curve ${progress!.toFixed(1)}% (fire ≥${minCurve}%)`,
    };
  }

  // Watching band — not yet a sniper buy
  if (
    ctx.isMigration !== true &&
    (ctx.nearMigration === true || (progress != null && progress >= 70))
  ) {
    if (progress != null && progress < minCurve) {
      return {
        ok: false,
        reason: `curve ${progress.toFixed(1)}% — watching, fire at ≥${minCurve}%`,
      };
    }
  }

  // Fallback: ultra-fresh post-grad
  if (ctx.isMigration === true && ctx.migrationFresh === true) {
    const ageMs =
      ctx.migrationAgeMs != null && Number.isFinite(ctx.migrationAgeMs)
        ? Number(ctx.migrationAgeMs)
        : null;
    if (ageMs == null) {
      return {
        ok: false,
        reason: `post-grad without ≤${maxPostGradSec}s age stamp — not sniper fallback`,
      };
    }
    if (ageMs > maxPostGradSec * 1000) {
      return {
        ok: false,
        reason: `post-grad ${Math.round(ageMs / 1000)}s > ${maxPostGradSec}s fallback window`,
      };
    }
    return {
      ok: true,
      reason: `ultra-fresh post-grad ${Math.round(ageMs / 1000)}s`,
    };
  }

  if (ctx.earlyBuy === true && !inFireBand) {
    return {
      ok: false,
      reason: 'early curve buy — not in sniper fire band',
    };
  }

  return { ok: false, reason: 'not a migration sniper setup' };
}

/** Soft category: fresh mig only — stale DEX tokens must compete as trend/dip/HWR. */
export function isFreshMigrationContext(
  ctx: TradeProfileMatchContext
): boolean {
  return evaluateFreshMigrationEligibility(ctx).ok;
}

/** True when fight has mig/curve signals so Migration Sniper floors apply. */
export function hasMigrationLaneSignals(
  ctx: TradeProfileMatchContext
): boolean {
  if (ctx.preferProfileId === 'migration_sniper') return true;
  if (ctx.isMigration === true || ctx.nearMigration === true) return true;
  if (ctx.migrationFresh === true) return true;
  if (String(ctx.setupWatchFamily || '').toLowerCase() === 'grad') return true;
  if (ctx.armedWatch === true && /grad|mig/i.test(String(ctx.setupWatchFamily || ''))) {
    return true;
  }
  const progress =
    ctx.curveProgressPct != null && Number.isFinite(ctx.curveProgressPct)
      ? Number(ctx.curveProgressPct)
      : null;
  if (progress != null && progress >= 70) return true;
  return false;
}

/**
 * True when fight has Momentum Burst signals so MB floors/score apply.
 * Random names without signals → silent not_applicable (like Migration).
 */
export function hasMomentumLaneSignals(
  ctx: TradeProfileMatchContext
): boolean {
  if (ctx.preferProfileId === 'momentum_burst') return true;
  if (ctx.shortTermStrategyId === 'momentum_burst') return true;
  const style = String(
    ctx.detectedEntryStyle || ctx.entryStyleHint || ''
  ).toLowerCase();
  if (
    style === 'level_momentum_expansion' ||
    style === 'scalp_reclaim_burst'
  ) {
    return true;
  }
  // Soft isMomentum shape: M5 vol + buy pressure / bull-flag (MB catalog floor).
  const minM5 = 8_000;
  const volM5 =
    ctx.volumeM5Usd != null && Number.isFinite(ctx.volumeM5Usd)
      ? Number(ctx.volumeM5Usd)
      : null;
  const buyPressureUsd =
    ctx.recentBuyVolumeUsd != null && Number.isFinite(ctx.recentBuyVolumeUsd)
      ? Number(ctx.recentBuyVolumeUsd)
      : null;
  if (volM5 == null || volM5 < minM5) return false;
  if (
    buyPressureUsd != null &&
    buyPressureUsd >= Math.min(800, minM5 * 0.4)
  ) {
    return true;
  }
  if (
    (ctx.chartPatternHits || []).some(
      (h) => h.id === 'bull_flag' && h.breakout === true
    )
  ) {
    return true;
  }
  if ((ctx.chartPatternIds || []).includes('bull_flag')) return true;
  return false;
}

/**
 * Hard lane entry floors (per-profile token targeting).
 * Cannot undercut global Risk On Min MC — only raise it via minMarketCapUsd.
 * Anti-rug / honeypot stay global outside this helper.
 */
/** Soft top10 ceiling for aged liquid Steady / HWR (quality checks still required). */
const TOP10_SOFT_CEILING_PCT: Partial<Record<string, number>> = {
  steady_compounder: 68,
  high_win_rate: 65,
};
/** Age-unknown Steady/HWR soft ceiling (stricter vol/liq/MC fallback still applies). */
const TOP10_SOFT_CEILING_AGE_UNKNOWN_PCT: Partial<Record<string, number>> = {
  steady_compounder: 72,
  high_win_rate: 70,
};
/** Silent not_applicable floor — stop HWR/Steady cascade skip spam on microcaps. */
const QUALITY_LANE_NOT_APPLICABLE_MC_USD = 5_000_000;
const TOP10_SOFT_MIN_LIQ_USD: Partial<Record<string, number>> = {
  steady_compounder: 10_000,
  high_win_rate: 20_000,
};
/** Stricter liq floors when age unknown (Steady/HWR fallback path). */
const TOP10_SOFT_FALLBACK_MIN_LIQ_USD: Partial<Record<string, number>> = {
  steady_compounder: 15_000,
  high_win_rate: 30_000,
};
const TOP10_SOFT_MIN_AGE_HOURS = 90 * 24;
/** Size haircut when Steady/HWR top10 soft-allow grants via known age. */
export const TOP10_SOFT_ALLOW_SIZE_MULT = 0.9;
/** Size haircut when Steady/HWR grants via age-unknown quality fallback. */
export const TOP10_SOFT_ALLOW_AGE_UNKNOWN_SIZE_MULT = 0.85;

export type Top10SoftAllowGrantTag =
  | 'top10_soft_allow_age_known'
  /** @deprecated alias — prefer top10_soft_allow_age_known */
  | 'top10_soft_allow'
  | 'top10_soft_allow_age_unknown_fallback';

export type LaneEntryFloorsResult = {
  ok: boolean;
  reason?: string;
  /** Steady/HWR aged-liquid soft pass between hard max and soft ceiling. */
  top10SoftAllow?: boolean;
  top10SoftAllowTag?: Top10SoftAllowGrantTag;
  sizeMult?: number;
};

/**
 * Calendar/pool age for Steady/HWR top10 soft-allow (≥90d gate).
 * Never uses migrationAgeMs — graduation clock must not gate aged soft-allow.
 * Returns max of available positive ages; null if none known.
 */
export function resolveTokenAgeHoursForSoftAllow(
  ctx: Pick<
    TradeProfileMatchContext,
    'tokenAgeHours' | 'pairCreatedAtMs' | 'launchedAt'
  >
): number | null {
  const ages: number[] = [];
  if (
    ctx.tokenAgeHours != null &&
    Number.isFinite(ctx.tokenAgeHours) &&
    ctx.tokenAgeHours >= 0
  ) {
    ages.push(Number(ctx.tokenAgeHours));
  }
  const pairMs =
    ctx.pairCreatedAtMs != null ? Number(ctx.pairCreatedAtMs) : NaN;
  if (Number.isFinite(pairMs) && pairMs > 0) {
    ages.push(Math.max(0, (Date.now() - pairMs) / 3_600_000));
  }
  const launched = ctx.launchedAt != null ? Number(ctx.launchedAt) : NaN;
  if (Number.isFinite(launched) && launched > 0) {
    const ms = launched < 1e12 ? launched * 1000 : launched;
    ages.push(Math.max(0, (Date.now() - ms) / 3_600_000));
  }
  if (ages.length === 0) return null;
  return Math.max(...ages);
}

/**
 * When known top10 exceeds the lane hard max, Steady/HWR may soft-allow if
 * age/volume/liquidity/holders/soft-ceiling all pass. Fast bots never enter.
 * Age unknown → stricter vol/liq fallback (not a hard age deny).
 */
export function resolveTop10SoftAllow(
  def: TradeProfileDefinition,
  ctx: TradeProfileMatchContext,
  top10: number,
  maxTop10: number
): {
  allow: boolean;
  rejectKey?:
    | 'age'
    | 'volume'
    | 'liquidity'
    | 'holders'
    | 'ceiling'
    | 'age_unknown_fallback'
    | 'market_cap';
  detail: string;
  grantTag?: Top10SoftAllowGrantTag;
  sizeMult?: number;
} {
  const softCeilAged = TOP10_SOFT_CEILING_PCT[def.id];
  if (softCeilAged == null) {
    return {
      allow: false,
      detail: `${def.name} top10 ${top10.toFixed(1)}% > max ${maxTop10}%`,
    };
  }
  const ageH = resolveTokenAgeHoursForSoftAllow(ctx);
  if (ageH != null && ageH < TOP10_SOFT_MIN_AGE_HOURS) {
    return {
      allow: false,
      rejectKey: 'age',
      detail: `${def.name} top10 soft-allow deny: age ${ageH.toFixed(1)}h < ${TOP10_SOFT_MIN_AGE_HOURS}h`,
    };
  }
  const ageUnknown = ageH == null;
  const viaAge = ageH != null && ageH >= TOP10_SOFT_MIN_AGE_HOURS;
  const softCeil =
    ageUnknown && TOP10_SOFT_CEILING_AGE_UNKNOWN_PCT[def.id] != null
      ? Number(TOP10_SOFT_CEILING_AGE_UNKNOWN_PCT[def.id])
      : softCeilAged;

  if (top10 > softCeil) {
    return {
      allow: false,
      rejectKey: ageUnknown ? 'age_unknown_fallback' : 'ceiling',
      detail: ageUnknown
        ? `${def.name} top10 soft-allow deny: age_unknown_fallback ceiling — ${top10.toFixed(1)}% > soft ceiling ${softCeil}%`
        : `${def.name} top10 soft-allow deny: ${top10.toFixed(1)}% > soft ceiling ${softCeil}%`,
    };
  }

  const minVolBase =
    def.match.minVolumeH1Usd != null &&
    Number.isFinite(def.match.minVolumeH1Usd) &&
    def.match.minVolumeH1Usd > 0
      ? Number(def.match.minVolumeH1Usd)
      : 0;
  const minVol = ageUnknown && minVolBase > 0 ? minVolBase * 1.5 : minVolBase;
  const volH1 =
    ctx.volumeH1Usd != null && Number.isFinite(ctx.volumeH1Usd)
      ? Number(ctx.volumeH1Usd)
      : null;
  if (minVol > 0 && (volH1 == null || volH1 < minVol)) {
    return {
      allow: false,
      rejectKey: ageUnknown ? 'age_unknown_fallback' : 'volume',
      detail:
        volH1 == null
          ? `${def.name} top10 soft-allow deny:${ageUnknown ? ' age_unknown_fallback volume —' : ''} volumeH1 unknown (need ≥$${Math.round(minVol)})`
          : `${def.name} top10 soft-allow deny:${ageUnknown ? ' age_unknown_fallback volume —' : ''} volumeH1 $${Math.round(volH1)} < $${Math.round(minVol)}`,
    };
  }

  const minLiq = ageUnknown
    ? TOP10_SOFT_FALLBACK_MIN_LIQ_USD[def.id] ?? 15_000
    : TOP10_SOFT_MIN_LIQ_USD[def.id] ?? 10_000;
  const liq =
    ctx.liquidityUsd != null && Number.isFinite(ctx.liquidityUsd)
      ? Number(ctx.liquidityUsd)
      : null;
  if (liq == null || liq < minLiq) {
    return {
      allow: false,
      rejectKey: ageUnknown ? 'age_unknown_fallback' : 'liquidity',
      detail:
        liq == null
          ? `${def.name} top10 soft-allow deny:${ageUnknown ? ' age_unknown_fallback liquidity —' : ''} liquidity unknown (need ≥$${Math.round(minLiq)})`
          : `${def.name} top10 soft-allow deny:${ageUnknown ? ' age_unknown_fallback liquidity —' : ''} liquidity $${Math.round(liq)} < $${Math.round(minLiq)}`,
    };
  }

  const minHolders =
    def.match.minHolders != null &&
    Number.isFinite(def.match.minHolders) &&
    def.match.minHolders > 0
      ? Number(def.match.minHolders)
      : 0;
  const holders =
    ctx.holderCount != null && Number.isFinite(ctx.holderCount)
      ? Number(ctx.holderCount)
      : null;
  if (minHolders > 0 && (holders == null || holders < minHolders)) {
    return {
      allow: false,
      rejectKey: ageUnknown ? 'age_unknown_fallback' : 'holders',
      detail:
        holders == null
          ? `${def.name} top10 soft-allow deny:${ageUnknown ? ' age_unknown_fallback holders —' : ''} holders unknown (need ≥${minHolders})`
          : `${def.name} top10 soft-allow deny:${ageUnknown ? ' age_unknown_fallback holders —' : ''} holders ${holders} < ${minHolders}`,
    };
  }

  // Age-unknown fallback: require profile MC floor when configured.
  if (ageUnknown) {
    const minMc =
      def.match.minMarketCapUsd != null &&
      Number.isFinite(def.match.minMarketCapUsd) &&
      def.match.minMarketCapUsd > 0
        ? Number(def.match.minMarketCapUsd)
        : 0;
    const maxMc =
      def.match.maxMarketCapUsd != null &&
      Number.isFinite(def.match.maxMarketCapUsd) &&
      def.match.maxMarketCapUsd > 0
        ? Number(def.match.maxMarketCapUsd)
        : 0;
    const mc =
      ctx.marketCapUsd != null && Number.isFinite(ctx.marketCapUsd)
        ? Number(ctx.marketCapUsd)
        : null;
    if (minMc > 0 && (mc == null || mc < minMc)) {
      return {
        allow: false,
        rejectKey: 'age_unknown_fallback',
        detail:
          mc == null
            ? `${def.name} top10 soft-allow deny: age_unknown_fallback market_cap — MC unknown (need ≥$${Math.round(minMc)})`
            : `${def.name} top10 soft-allow deny: age_unknown_fallback market_cap — MC $${Math.round(mc)} < $${Math.round(minMc)}`,
      };
    }
    if (maxMc > 0 && mc != null && mc > maxMc) {
      return {
        allow: false,
        rejectKey: 'age_unknown_fallback',
        detail: `${def.name} top10 soft-allow deny: age_unknown_fallback market_cap — MC $${Math.round(mc)} > $${Math.round(maxMc)}`,
      };
    }
  }

  if (viaAge) {
    return {
      allow: true,
      grantTag: 'top10_soft_allow_age_known',
      sizeMult: TOP10_SOFT_ALLOW_SIZE_MULT,
      detail: `${def.name} top10_soft_allow_age_known ${top10.toFixed(1)}% via age ${ageH!.toFixed(1)}h (hard max ${maxTop10}% · soft ≤${softCeil}%)`,
    };
  }
  // ageUnknown
  return {
    allow: true,
    grantTag: 'top10_soft_allow_age_unknown_fallback',
    sizeMult: TOP10_SOFT_ALLOW_AGE_UNKNOWN_SIZE_MULT,
    detail: `${def.name} top10_soft_allow_age_unknown_fallback ${top10.toFixed(1)}% (hard max ${maxTop10}% · soft ≤${softCeil}% · vol≥1.5× · liq≥$${Math.round(minLiq)})`,
  };
}

/** Apply Steady/HWR top10 soft-allow size haircut on exit rules when granted. */
export function applyTop10SoftAllowSizeHaircut(
  exitRules: TradeProfileExitRules,
  granted: boolean,
  sizeMult: number = TOP10_SOFT_ALLOW_SIZE_MULT
): TradeProfileExitRules {
  if (!granted) return exitRules;
  const haircut =
    sizeMult > 0 && Number.isFinite(sizeMult)
      ? Number(sizeMult)
      : TOP10_SOFT_ALLOW_SIZE_MULT;
  const base =
    exitRules.sizeMultiplier != null &&
    Number.isFinite(exitRules.sizeMultiplier) &&
    exitRules.sizeMultiplier > 0
      ? Number(exitRules.sizeMultiplier)
      : 1;
  return {
    ...exitRules,
    sizeMultiplier: Number((base * haircut).toFixed(4)),
  };
}

export function evaluateLaneEntryFloors(
  def: TradeProfileDefinition,
  ctx: TradeProfileMatchContext
): LaneEntryFloorsResult {
  const m = def.match;
  const mc =
    ctx.marketCapUsd != null && Number.isFinite(ctx.marketCapUsd)
      ? Number(ctx.marketCapUsd)
      : null;
  const holders =
    ctx.holderCount != null && Number.isFinite(ctx.holderCount)
      ? Number(ctx.holderCount)
      : null;
  // Armed Dip lane soft-pass: ease non-safety floors (holders / H1 soft).
  // Keep hard MC / max MC / top10 / age — global $8k + anti-rug stay final.
  const armedDipSoft =
    ctx.armedWatch === true &&
    (String(ctx.setupWatchFamily || '').toLowerCase() === 'dip' ||
      def.id === 'dip_buyer');

  const eased = dipBuyerEasedFloors(def, ctx);
  const profileMin =
    eased?.minMarketCapUsd ??
    (m.minMarketCapUsd != null &&
    Number.isFinite(m.minMarketCapUsd) &&
    m.minMarketCapUsd > 0
      ? Number(m.minMarketCapUsd)
      : 0);
  const globalMin = effectiveMinMarketCapUsd();
  const laneMinMc = Math.max(globalMin, profileMin);

  // Hard lane MC floor. Unknown MC + profile Min MC Override → hard fail
  // (migration / early enrich often lack MC; soft-pass let Trend stamp $19k
  // mints despite a $1M override). Soft-pass only when no profile min is set.
  if (laneMinMc > 0) {
    if (profileMin > 0 && (mc == null || mc <= 0)) {
      return {
        ok: false,
        reason: `${def.name} Min MC Override $${Math.round(profileMin)} — MC unknown`,
      };
    }
    if (mc != null && mc > 0 && mc < laneMinMc) {
      return {
        ok: false,
        reason: `${def.name} MC $${Math.round(mc)} < lane min $${Math.round(laneMinMc)}`,
      };
    }
  }

  if (
    m.maxMarketCapUsd != null &&
    Number.isFinite(m.maxMarketCapUsd) &&
    m.maxMarketCapUsd > 0
  ) {
    // Known-only: unknown MC does not fail Max MC (global gates still apply)
    if (mc != null && mc > 0 && mc > m.maxMarketCapUsd) {
      return {
        ok: false,
        reason: `${def.name} MC $${Math.round(mc)} > max $${Math.round(m.maxMarketCapUsd)}`,
      };
    }
  }

  if (
    !armedDipSoft &&
    m.minHolders != null &&
    Number.isFinite(m.minHolders) &&
    m.minHolders > 0
  ) {
    // Known-only: unknown holders do not fail the lane (metrics often arrive after enrich)
    if (holders != null && holders < m.minHolders) {
      return {
        ok: false,
        reason: `${def.name} holders ${holders} < ${m.minHolders}`,
      };
    }
  }

  const maxTop10 =
    m.maxTop10HoldPct != null &&
    Number.isFinite(m.maxTop10HoldPct) &&
    m.maxTop10HoldPct > 0
      ? Number(m.maxTop10HoldPct)
      : 0;
  if (maxTop10 > 0) {
    const top10 =
      ctx.top10HoldPct != null && Number.isFinite(ctx.top10HoldPct)
        ? Number(ctx.top10HoldPct)
        : null;
    // Known-only: unknown top-10 does not fail the lane
    if (top10 != null && top10 > maxTop10) {
      const soft = resolveTop10SoftAllow(def, ctx, top10, maxTop10);
      if (soft.allow) {
        const tag = soft.grantTag ?? 'top10_soft_allow_age_known';
        const mult =
          soft.sizeMult ??
          (tag === 'top10_soft_allow_age_unknown_fallback'
            ? TOP10_SOFT_ALLOW_AGE_UNKNOWN_SIZE_MULT
            : TOP10_SOFT_ALLOW_SIZE_MULT);
        const via =
          tag === 'top10_soft_allow_age_unknown_fallback'
            ? 'via age-unknown fallback'
            : 'via age known';
        console.log(
          `[trade-profiles] top10_soft_allow GRANT ${ctx.symbol || 'token'} · ${via} · ${soft.detail}` +
            ` · size ×${mult}`
        );
        return {
          ok: true,
          reason: tag,
          top10SoftAllow: true,
          top10SoftAllowTag: tag,
          sizeMult: mult,
        };
      }
      if (TOP10_SOFT_CEILING_PCT[def.id] != null) {
        console.log(
          `[trade-profiles] top10_soft_allow REJECT ${ctx.symbol || 'token'} · ${soft.detail}` +
            (soft.rejectKey ? ` · key=${soft.rejectKey}` : '')
        );
      } else {
        console.log(
          `[trade-profiles] top10 hard-block ${ctx.symbol || 'token'} · ${soft.detail}`
        );
      }
      return {
        ok: false,
        reason: soft.detail,
      };
    }
  }

  let minAgeH =
    m.minTokenAgeHours != null &&
    Number.isFinite(m.minTokenAgeHours) &&
    m.minTokenAgeHours > 0
      ? Number(m.minTokenAgeHours)
      : 0;
  try {
    if (
      minAgeH > 0 &&
      isProfileLearningModeOptedIn(def.id)
    ) {
      const { learningModeAdjustedMinTokenAgeHours } =
        require('./learningMode') as typeof import('./learningMode');
      minAgeH = learningModeAdjustedMinTokenAgeHours(minAgeH);
    }
  } catch {
    /* ignore */
  }
  if (minAgeH > 0) {
    const ageH = resolveTokenAgeHoursForGate(ctx);
    // Known-only: unknown age does not fail (Dex/grad gaps)
    if (ageH != null && ageH < minAgeH) {
      return {
        ok: false,
        reason: `${def.name} token age ${ageH.toFixed(1)}h < min ${minAgeH}h`,
      };
    }
  }

  return { ok: true };
}

/**
 * Hours since Pump.fun graduation when migrationAgeMs is known;
 * otherwise Dex/launch tokenAgeHours. null if unknown.
 */
export function resolveTokenAgeHoursForGate(
  ctx: Pick<TradeProfileMatchContext, 'migrationAgeMs' | 'tokenAgeHours'>
): number | null {
  if (
    ctx.migrationAgeMs != null &&
    Number.isFinite(ctx.migrationAgeMs) &&
    ctx.migrationAgeMs >= 0
  ) {
    return Math.max(0, Number(ctx.migrationAgeMs) / 3_600_000);
  }
  if (ctx.tokenAgeHours != null && Number.isFinite(ctx.tokenAgeHours)) {
    return Math.max(0, Number(ctx.tokenAgeHours));
  }
  return null;
}

/** Classified dip or clear structural dip context — ease dip_buyer floors. */
function isDipBuyerEasePath(ctx: TradeProfileMatchContext): boolean {
  if (String(ctx.hmcSetup || '').toLowerCase() === 'dip') return true;
  if (ctx.shortTermStrategyId === 'post_run_dip') return true;
  const drop =
    ctx.dropFromPeakPct != null && Number.isFinite(ctx.dropFromPeakPct)
      ? Number(ctx.dropFromPeakPct)
      : ctx.localPullbackPct != null && Number.isFinite(ctx.localPullbackPct)
        ? Number(ctx.localPullbackPct)
        : null;
  if (drop != null && drop >= 8) return true;
  if (ctx.nearKeyFib === true || ctx.nearSupport === true) return true;
  return false;
}

/** Eased MC / H1 floors for dip_buyer on classified or structural dip paths. */
function dipBuyerEasedFloors(
  def: TradeProfileDefinition,
  ctx: TradeProfileMatchContext
): { minMarketCapUsd: number; minVolumeH1Usd: number } | null {
  if (def.id !== 'dip_buyer' || !isDipBuyerEasePath(ctx)) return null;
  const m = def.match;
  const baseMc =
    m.minMarketCapUsd != null &&
    Number.isFinite(m.minMarketCapUsd) &&
    m.minMarketCapUsd > 0
      ? Number(m.minMarketCapUsd)
      : 500_000;
  const baseH1 =
    m.minVolumeH1Usd != null &&
    Number.isFinite(m.minVolumeH1Usd) &&
    m.minVolumeH1Usd > 0
      ? Number(m.minVolumeH1Usd)
      : 8_000;
  // ~30% ease so mid-MC classified dips convert instead of scalper-only.
  return {
    minMarketCapUsd: Math.round(baseMc * 0.7),
    minVolumeH1Usd: Math.round(baseH1 * 0.7),
  };
}

export interface TradeProfileLaneResult {
  profileId: TradeProfileId;
  name: string;
  icon: string;
  color: string;
  priority: number;
  score: number;
  reason: string;
  passed: boolean;
  failReason?: string;
  assignment?: TradeProfileAssignment;
}

/**
 * Evaluate every enabled profile with lane floors + match score (parallel compete).
 * Does not run module filters — caller gates the winner (or tries passers in order).
 */
export function evaluateTradeProfileLanes(
  ctx: TradeProfileMatchContext,
  opts?: {
    silent?: boolean;
    eligibleProfileIds?: string[] | null;
    /** Soft mode: preferred specialists score normally; others compete with penalty. */
    preferredProfileIds?: string[] | null;
    softEligibility?: boolean;
  }
): TradeProfileLaneResult[] {
  // Detect entry-style DNA once per fight (before scoreProfile / HMC soft / MARL)
  try {
    if (ctx.detectedEntryStyle == null || ctx.lateChase == null) {
      const { resolveDetectedEntryStyle } =
        require('./supportReclaim') as typeof import('./supportReclaim');
      const det = resolveDetectedEntryStyle(ctx);
      if (ctx.detectedEntryStyle == null) {
        ctx.detectedEntryStyle = det.detectedEntryStyle;
      }
      if (ctx.lateChase == null) ctx.lateChase = det.lateChase;
    }
  } catch {
    /* fail soft */
  }
  const state = ensureState();
  if (!state.enabled) {
    return [];
  }
  const softMode =
    opts?.softEligibility === true &&
    opts?.preferredProfileIds != null &&
    opts.preferredProfileIds.length > 0;
  const preferredSet = softMode
    ? new Set(opts!.preferredProfileIds!.map(String))
    : null;
  const eligibleSet =
    !softMode &&
    opts?.eligibleProfileIds != null &&
    opts.eligibleProfileIds.length > 0
      ? new Set(opts.eligibleProfileIds.map(String))
      : null;
  const results: TradeProfileLaneResult[] = [];
  for (const catalog of TRADE_PROFILE_CATALOG) {
    if (state.profiles[catalog.id] === false) continue;
    // Default = fallback only; Zion = manual KOL offers only (not copy/scanner lanes)
    if (catalog.id === 'default' || catalog.id === 'zion') continue;
    if (eligibleSet && !eligibleSet.has(catalog.id)) {
      const def = resolveTradeProfileDefinition(catalog.id);
      results.push({
        profileId: def.id,
        name: def.name,
        icon: def.icon,
        color: def.color,
        priority: def.priority,
        score: 0,
        reason: 'hmc_not_eligible',
        passed: false,
        failReason: 'hmc_not_eligible',
      });
      continue;
    }
    const def = resolveTradeProfileDefinition(catalog.id);
    // MS not_applicable in multi-lane fights without mig/curve signals (no cascade noise)
    if (
      def.id === 'migration_sniper' &&
      !hasMigrationLaneSignals(ctx)
    ) {
      results.push({
        profileId: def.id,
        name: def.name,
        icon: def.icon,
        color: def.color,
        priority: def.priority,
        score: 0,
        reason: 'not_applicable',
        passed: false,
        failReason: 'not_applicable',
      });
      continue;
    }
    // MB not_applicable without momentum signals (no cascade noise)
    if (def.id === 'momentum_burst' && !hasMomentumLaneSignals(ctx)) {
      results.push({
        profileId: def.id,
        name: def.name,
        icon: def.icon,
        color: def.color,
        priority: def.priority,
        score: 0,
        reason: 'not_applicable',
        passed: false,
        failReason: 'not_applicable',
      });
      continue;
    }
    // HWR/Steady: silent not_applicable on microcaps (stop MC-too-low cascade spam)
    if (
      (def.id === 'high_win_rate' || def.id === 'steady_compounder') &&
      ctx.armedWatch !== true
    ) {
      const mcNap =
        ctx.marketCapUsd != null && Number.isFinite(ctx.marketCapUsd)
          ? Number(ctx.marketCapUsd)
          : null;
      if (
        mcNap != null &&
        mcNap > 0 &&
        mcNap < QUALITY_LANE_NOT_APPLICABLE_MC_USD
      ) {
        results.push({
          profileId: def.id,
          name: def.name,
          icon: def.icon,
          color: def.color,
          priority: def.priority,
          score: 0,
          reason: 'not_applicable',
          passed: false,
          failReason: 'not_applicable',
        });
        continue;
      }
    }
    const floors = evaluateLaneEntryFloors(def, ctx);
    if (!floors.ok) {
      results.push({
        profileId: def.id,
        name: def.name,
        icon: def.icon,
        color: def.color,
        priority: def.priority,
        score: 0,
        reason: floors.reason || 'lane floors',
        passed: false,
        failReason: floors.reason,
      });
      continue;
    }
    const scored = scoreProfile(def, ctx);
    if (scored.score <= 0) {
      results.push({
        profileId: def.id,
        name: def.name,
        icon: def.icon,
        color: def.color,
        priority: def.priority,
        score: 0,
        reason: scored.reason,
        passed: false,
        failReason: scored.reason,
      });
      continue;
    }
    let laneScore = Math.round(scored.score * 10) / 10;
    let laneReason = scored.reason;
    if (floors.top10SoftAllow === true) {
      const softTag = floors.top10SoftAllowTag ?? 'top10_soft_allow_age_known';
      if (!/top10_soft_allow/i.test(laneReason)) {
        laneReason = `${laneReason} · ${softTag}`;
      }
    }
    try {
      const { isLearningModeActive, learningModeFairnessBump } =
        require('./learningMode') as typeof import('./learningMode');
      if (isLearningModeActive() && isProfileLearningModeOptedIn(def.id)) {
        let blockLm = false;
        try {
          const { shouldBlockLearningModeForDipBuyer } =
            require('./dipBuyerRecovery') as typeof import('./dipBuyerRecovery');
          blockLm = shouldBlockLearningModeForDipBuyer(def.id);
        } catch {
          /* optional */
        }
        if (!blockLm) {
          const { getProfileLearningEpisodes } =
            require('./profileLearningEpisodes') as typeof import('./profileLearningEpisodes');
          const eps = getProfileLearningEpisodes(def.id, 500);
          const bump = learningModeFairnessBump(eps.length);
          if (bump > 0) {
            laneScore = Math.round((laneScore + bump) * 10) / 10;
            laneReason = `${laneReason} · LM fairness +${bump}`;
          }
        }
      }
    } catch {
      /* ignore */
    }
    if (preferredSet && !preferredSet.has(def.id)) {
      laneScore = Math.round(laneScore * 0.85 * 10) / 10;
      laneReason = `${laneReason} · hmc_soft_deprioritized`;
    }
    const assignment = buildAssignmentFromDef(def, ctx, {
      score: laneScore,
      reason: laneReason,
      autoScored: false,
      top10SoftAllow: floors.top10SoftAllow === true,
      top10SoftAllowTag: floors.top10SoftAllowTag,
      top10SoftAllowSizeMult: floors.sizeMult,
    });
    results.push({
      profileId: def.id,
      name: def.name,
      icon: def.icon,
      color: def.color,
      priority: def.priority,
      score: assignment.score,
      reason: assignment.reason,
      passed: true,
      assignment,
    });
  }
  results.sort(
    (a, b) =>
      Number(b.passed) - Number(a.passed) ||
      b.score - a.score ||
      b.priority - a.priority
  );

  // Soft MARL ranking — additive only; never mutates TP/SL or learning overrides.
  try {
    const { applyMarlLaneRanking } =
      require('./marlCoordinator') as typeof import('./marlCoordinator');
    applyMarlLaneRanking(results);
  } catch {
    /* optional */
  }

  try {
    const { applyProfileRlLaneRanking } =
      require('./profileRlAgent') as typeof import('./profileRlAgent');
    applyProfileRlLaneRanking(results);
  } catch {
    /* optional */
  }

  // Grad-watch / preferred Migration Sniper: if stamped preferred and eligibility
  // would pass under post-grad / fire context, ensure the lane is a passer.
  if (ctx.preferProfileId === 'migration_sniper') {
    const migRow = results.find((r) => r.profileId === 'migration_sniper');
    if (migRow && !migRow.passed) {
      const def = resolveTradeProfileDefinition('migration_sniper');
      const fresh = evaluateFreshMigrationEligibility(ctx, {
        maxTokenAgeHours: def.match.maxTokenAgeHours,
        maxMarketCapUsd: def.match.maxMarketCapUsd,
        minCurveProgressPct: def.match.minCurveProgressPct,
        maxCurveProgressPct: def.match.maxCurveProgressPct,
        maxMigrationAgeSec: def.match.maxMigrationAgeSec,
      });
      if (fresh.ok) {
        const assignment = buildAssignmentFromDef(def, ctx, {
          score: 95,
          reason: `grad-watch force · ${fresh.reason}`,
          autoScored: false,
        });
        migRow.passed = true;
        migRow.score = assignment.score;
        migRow.reason = assignment.reason;
        migRow.failReason = undefined;
        migRow.assignment = assignment;
        results.sort(
          (a, b) =>
            Number(b.passed) - Number(a.passed) ||
            b.score - a.score ||
            b.priority - a.priority
        );
      }
    }
  }

  if (!opts?.silent && results.length) {
    const bits = results
      .filter((r) => r.failReason !== 'not_applicable')
      .slice(0, 8)
      .map(
        (r) =>
          `${r.passed ? '✓' : '✗'}${r.name}=${r.passed ? r.score.toFixed(1) : r.failReason || 'fail'}`
      );
    if (bits.length) {
      console.log(
        `[trade-profiles] Lane fight ${ctx.symbol || 'token'}: ${bits.join(' · ')}`
      );
    }
  }
  return results;
}

/** Best passing lane, or null if none passed floors+match. */
export function pickWinningTradeProfileLane(
  lanes: TradeProfileLaneResult[]
): TradeProfileLaneResult | null {
  return lanes.find((l) => l.passed && l.assignment) ?? null;
}

function scoreProfile(
  def: TradeProfileDefinition,
  ctx: TradeProfileMatchContext
): { score: number; reason: string } {
  const floors = evaluateLaneEntryFloors(def, ctx);
  if (!floors.ok) {
    return { score: 0, reason: floors.reason || 'lane floors' };
  }
  const m = def.match;
  const lmMatch = learningAdjustedMatchMins(def.id, m);
  const minConviction = lmMatch.minConviction;
  const minWalletQuality = lmMatch.minWalletQuality;
  let score = 0;
  const bits: string[] = [];

  // Entry-style DNA eligibility (before HMC soft ×0.85 / MARL)
  try {
    const { scoreEntryStyleDna, resolveDetectedEntryStyle } =
      require('./supportReclaim') as typeof import('./supportReclaim');
    if (ctx.detectedEntryStyle == null || ctx.lateChase == null) {
      const det = resolveDetectedEntryStyle(ctx);
      if (ctx.detectedEntryStyle == null) {
        ctx.detectedEntryStyle = det.detectedEntryStyle;
      }
      if (ctx.lateChase == null) ctx.lateChase = det.lateChase;
    }
    const armedDipLane =
      def.id === 'dip_buyer' &&
      (ctx.armedWatch === true ||
        ctx.dipWatchTriggered === true ||
        String(ctx.setupWatchFamily || '').toLowerCase() === 'dip');
    // Armed Dip: prefer support_dip_reclaim stamp over rediscovered late_chase
    if (
      armedDipLane &&
      (ctx.lateChase === true ||
        String(ctx.detectedEntryStyle || '') === 'late_chase') &&
      (String(ctx.entryStyleHint || '').toLowerCase() === 'support_dip_reclaim' ||
        String(ctx.setupWatchFamily || '').toLowerCase() === 'dip')
    ) {
      ctx.detectedEntryStyle = 'support_dip_reclaim';
      ctx.lateChase = false;
    }
    const dna = scoreEntryStyleDna({
      profileId: def.id,
      detectedEntryStyle: ctx.detectedEntryStyle,
      lateChase: ctx.lateChase === true,
      armedWatch: ctx.armedWatch === true,
      setupWatchFamily: ctx.setupWatchFamily,
      dipWatchTriggered: ctx.dipWatchTriggered === true,
    });
    // Catalog match DNA overrides when present
    const style = String(ctx.detectedEntryStyle || 'unknown');
    const late = ctx.lateChase === true || style === 'late_chase';
    if (m.hardLateChase === true && late && !armedDipLane) {
      return { score: 0, reason: 'late_chase forbidden' };
    }
    if (m.hardLateChase === true && late && armedDipLane) {
      score -= 22;
      bits.push('late_chase soft (armed dip)');
    } else if (
      Array.isArray(m.forbiddenEntryStyles) &&
      (m.forbiddenEntryStyles.includes(style) ||
        (late && m.forbiddenEntryStyles.includes('late_chase')))
    ) {
      const hard =
        m.hardLateChase === true ||
        def.id === 'high_win_rate' ||
        def.id === 'steady_compounder' ||
        def.id === 'trend_rider' ||
        def.id === 'smart_money_mirror' ||
        (def.id === 'dip_buyer' && !armedDipLane);
      if ((hard || style === 'late_chase') && !(armedDipLane && late)) {
        return {
          score: 0,
          reason: late ? 'late_chase forbidden' : `forbidden style ${style}`,
        };
      }
      score -= armedDipLane && late ? 22 : 35;
      bits.push(
        armedDipLane && late
          ? 'late_chase soft (armed dip)'
          : late
            ? 'late_chase penalty'
            : `forbidden style ${style}`
      );
    } else if (dna.hardZero) {
      return { score: 0, reason: dna.bits.join(', ') || 'style DNA zero' };
    } else {
      score += dna.scoreDelta;
      if (dna.bits.length) bits.push(...dna.bits);
    }
    if (m.primaryEntryStyle && style === m.primaryEntryStyle) {
      score += 4; // catalog primary nudge on top of DNA table
      if (!bits.some((b) => b.startsWith('primary'))) {
        bits.push(`primary ${style}`);
      }
    } else if (
      Array.isArray(m.allowedEntryStyles) &&
      m.allowedEntryStyles.length &&
      style !== 'unknown' &&
      style !== m.primaryEntryStyle &&
      !m.allowedEntryStyles.includes(style) &&
      !(
        Array.isArray(m.forbiddenEntryStyles) &&
        m.forbiddenEntryStyles.includes(style)
      )
    ) {
      score -= 8;
      bits.push(`off-style ${style}`);
    }
  } catch {
    /* fail soft — DNA optional */
  }

  const conv =
    ctx.convictionScore != null && Number.isFinite(ctx.convictionScore)
      ? Number(ctx.convictionScore)
      : null;
  // Known-only: unknown conviction does not hard-zero early lane fight (computed later in gate)
  if (minConviction != null && conv != null && conv < minConviction) {
    return { score: 0, reason: `conviction < ${minConviction}` };
  }

  const mc =
    ctx.marketCapUsd != null && Number.isFinite(ctx.marketCapUsd)
      ? Number(ctx.marketCapUsd)
      : null;
  const holders =
    ctx.holderCount != null && Number.isFinite(ctx.holderCount)
      ? Number(ctx.holderCount)
      : null;
  const volH1 =
    ctx.volumeH1Usd != null && Number.isFinite(ctx.volumeH1Usd)
      ? Number(ctx.volumeH1Usd)
      : null;
  // Real M5 only — do not fall back to recent buy-USD (that inflated MB scores)
  const volM5 =
    ctx.volumeM5Usd != null && Number.isFinite(ctx.volumeM5Usd)
      ? Number(ctx.volumeM5Usd)
      : null;
  const buyPressureUsd =
    ctx.recentBuyVolumeUsd != null && Number.isFinite(ctx.recentBuyVolumeUsd)
      ? Number(ctx.recentBuyVolumeUsd)
      : null;
  const ageH = resolveTokenAgeHoursForGate(ctx);
  const chg24 =
    ctx.priceChange24hPct != null && Number.isFinite(ctx.priceChange24hPct)
      ? Number(ctx.priceChange24hPct)
      : null;
  const drop =
    ctx.dropFromPeakPct != null && Number.isFinite(ctx.dropFromPeakPct)
      ? Number(ctx.dropFromPeakPct)
      : ctx.localPullbackPct != null && Number.isFinite(ctx.localPullbackPct)
        ? Number(ctx.localPullbackPct)
        : null;
  const pullback =
    ctx.localPullbackPct != null && Number.isFinite(ctx.localPullbackPct)
      ? Number(ctx.localPullbackPct)
      : drop;
  const kolN =
    ctx.kolCount != null && Number.isFinite(ctx.kolCount)
      ? Number(ctx.kolCount)
      : null;
  const holderGrowth =
    ctx.holderGrowthPct != null && Number.isFinite(ctx.holderGrowthPct)
      ? Number(ctx.holderGrowthPct)
      : null;
  const wallets =
    ctx.walletCount != null && Number.isFinite(ctx.walletCount)
      ? Number(ctx.walletCount)
      : null;
  const effectiveClusterWallets = Math.max(wallets ?? 0, kolN ?? 0);

  const feedPrefer =
    Boolean(ctx.preferProfileId) &&
    ctx.preferProfileId === def.id &&
    (m.kolscanFeedEnabled === true ||
      def.id === 'migration_sniper' ||
      ctx.specialtyFeed === 'majors' ||
      ctx.specialtyFeed === 'medium');

  const isDip =
    ctx.shortTermStrategyId === 'post_run_dip' ||
    (drop != null &&
      drop >= (m.minDropFromPeakPct ?? 12) &&
      !m.preferReversal);
  const isScalp =
    ctx.scalpMode === true &&
    ctx.shortTermStrategyId != null &&
    ctx.shortTermStrategyId !== 'post_run_dip';
  // Pre-grad fire band (~90%+) or ultra-fresh post-grad — owns Migration Sniper
  // and makes other lanes defer via isMig / hostileArmed.
  const freshMig = evaluateFreshMigrationEligibility(ctx, {
    maxTokenAgeHours: m.maxTokenAgeHours ?? FRESH_MIGRATION_MAX_AGE_HOURS,
    maxMarketCapUsd: m.maxMarketCapUsd ?? FRESH_MIGRATION_MAX_MC_USD,
    minCurveProgressPct: m.minCurveProgressPct,
    maxCurveProgressPct: m.maxCurveProgressPct,
    maxMigrationAgeSec: m.maxMigrationAgeSec,
  });
  const isMig = freshMig.ok;
  const isMomentum =
    ctx.shortTermStrategyId === 'momentum_burst' ||
    (volM5 != null &&
      m.minVolumeM5Usd != null &&
      volM5 >= m.minVolumeM5Usd &&
      !isDip &&
      !isMig &&
      // Buy pressure or bull-flag — volume alone is not a burst
      ((buyPressureUsd != null &&
        buyPressureUsd >= Math.min(800, m.minVolumeM5Usd * 0.4)) ||
        (ctx.chartPatternHits || []).some(
          (h) => h.id === 'bull_flag' && h.breakout === true
        ) ||
        (ctx.chartPatternIds || []).includes('bull_flag')));
  const isReversal =
    ctx.shortTermStrategyId === 'reversal_scalp' ||
    (Boolean(m.preferReversal) &&
      drop != null &&
      drop >= (m.minDropFromPeakPct ?? 18));

  // Hostile specialty engines that should own the mint over Trend/Compounder.
  // Soft dip-from-drop alone must NOT veto Trend — lane fight picks the winner.
  // Pattern-inferred "momentum" must NOT veto Trend Rider.
  const hostileArmed =
    isScalp ||
    isMig ||
    isReversal ||
    ctx.shortTermStrategyId === 'momentum_burst' ||
    ctx.shortTermStrategyId === 'post_run_dip';

  if (m.requireCluster && m.minWalletCount != null) {
    // Specialty stamp (feedPrefer): cluster already implied by the feed pick —
    // Jupiter handoffs have 1 scanner wallet and often no kolCount, so requiring
    // kolN >= minKolWallets made Trend Rider / Steady Compounder specialty dead.
    if (!feedPrefer && effectiveClusterWallets < m.minWalletCount) {
      return {
        score: 0,
        reason: `cluster ${effectiveClusterWallets} < ${m.minWalletCount} wallets`,
      };
    }
  }

  if (
    m.minBuyPressureUsd != null &&
    buyPressureUsd != null &&
    buyPressureUsd < m.minBuyPressureUsd
  ) {
    // Migration Sniper event lane: soft-fail low pressure on grad-watch / prefer path
    if (
      def.id === 'migration_sniper' &&
      (feedPrefer || ctx.preferProfileId === 'migration_sniper')
    ) {
      bits.push(
        `buy pressure soft $${Math.round(buyPressureUsd)}<$${m.minBuyPressureUsd}`
      );
    } else {
      return {
        score: 0,
        reason: `buy pressure $${Math.round(buyPressureUsd)} < $${m.minBuyPressureUsd}`,
      };
    }
  }

  if (m.preferDip) {
    // Armed-prefer (1.2.249): near-zero discretionary when quality arms live;
    // structural disc only under fallback. Fib/S arm path + watch handoffs stay.
    const dipArmed =
      ctx.armedWatch === true ||
      ctx.dipWatchTriggered === true ||
      String(ctx.setupWatchFamily || '').toLowerCase() === 'dip' ||
      /dip-watch:triggered|quality_structure_reclaim|support_dip_reclaim/i.test(
        String(ctx.detectedEntryStyle || '') +
          ' ' +
          String(ctx.entryStyleHint || '')
      ) ||
      feedPrefer;
    let fallbackDisc = true;
    try {
      const { isFallbackDiscAllowed, isAdmissionBaselineV235 } =
        require('./expectancyLift') as typeof import('./expectancyLift');
      if (!isAdmissionBaselineV235()) {
        fallbackDisc = isFallbackDiscAllowed();
      }
    } catch {
      fallbackDisc = true;
    }
    if (!dipArmed && !fallbackDisc && !feedPrefer) {
      return {
        score: 0,
        reason: 'dip habit: armed Fib/S reclaim only (near-zero disc)',
      };
    }
    const minDrop = m.minDropFromPeakPct ?? 8;
    const maxDrop = m.maxDropFromPeakPct;
    const dropOk =
      drop != null &&
      drop >= minDrop &&
      (maxDrop == null || drop <= maxDrop);
    const structuralDip =
      dropOk ||
      ((ctx.nearKeyFib || ctx.nearSupport) &&
        drop != null &&
        drop >= Math.min(5, minDrop));
    const watchOrFeed =
      feedPrefer ||
      ctx.shortTermStrategyId === 'post_run_dip' ||
      Boolean(isDip);
    if (!structuralDip && !watchOrFeed) {
      return { score: 0, reason: 'not a dip setup' };
    }
    // Fresh migrations belong to Migration Sniper, not Dip Buyer
    if (isMig) return { score: 0, reason: 'defer to fresh migration' };
    // Cascade flush past max dip — invalidate
    if (maxDrop != null && drop != null && drop > maxDrop) {
      return {
        score: 0,
        reason: `dip flush −${drop.toFixed(0)}% > max ${maxDrop}%`,
      };
    }
    score += 100;
    bits.push(structuralDip ? 'dip setup' : 'dip feed/watch');
    if (ctx.shortTermStrategyId === 'post_run_dip') {
      score += 25;
      bits.push('post_run_dip');
    }
    const strongRun =
      (chg24 != null && chg24 >= (m.minPriceChange24hPct ?? 12)) ||
      (drop != null && drop >= minDrop);
    if (strongRun) {
      score += 15;
      bits.push('prior strong run');
    }
    if (m.preferFibOrSupport && (ctx.nearKeyFib || ctx.nearSupport)) {
      score += 20;
      bits.push(ctx.nearKeyFib ? 'near Fib 0.5/0.618' : 'near support');
    }
    // Prefer primary/secondary pattern scoring below when configured
    if (
      m.preferBullishPatterns &&
      !(m.primaryPatternIds?.length || m.secondaryPatternIds?.length || m.preferPatternIds?.length) &&
      (ctx.chartPatternIds || []).length
    ) {
      const bullishIds = new Set([
        'falling_wedge',
        'ascending_triangle',
        'trend_continuation',
        'structured_pullback',
        'volume_dryup_return',
        'bull_flag',
      ]);
      const hits = (ctx.chartPatternIds || []).filter((id) => bullishIds.has(id));
      if (hits.length) {
        score += 12 + Math.min(10, hits.length * 4);
        bits.push(`patterns ${hits.join('+')}`);
      }
    }
    if (
      volH1 != null &&
      volH1 >=
        (dipBuyerEasedFloors(def, ctx)?.minVolumeH1Usd ??
          m.minVolumeH1Usd ??
          2000)
    ) {
      score += 8;
      bits.push('volume confirm');
    }
    if (mc != null && m.preferMarketCapUsd != null && mc >= m.preferMarketCapUsd) {
      score += 12;
      bits.push(`prefer MC $${Math.round(mc)}`);
    }
    if (
      m.preferSmartMoney &&
      ctx.smartMoneyScore != null &&
      ctx.smartMoneyScore >= 40
    ) {
      score += 10;
      bits.push(`SM ${ctx.smartMoneyScore}`);
    }
  }

  if (m.preferScalp) {
    // Hard gate: Scalper mid-band when preferSmallMc + max/min MC set
    if (m.preferSmallMc && m.maxMarketCapUsd != null) {
      if (mc == null || mc <= 0 || mc > m.maxMarketCapUsd) {
        return {
          score: 0,
          reason:
            mc == null
              ? 'need MC for scalper'
              : `MC $${Math.round(mc)} above scalper max $${m.maxMarketCapUsd}`,
        };
      }
      if (
        m.minMarketCapUsd != null &&
        Number.isFinite(m.minMarketCapUsd) &&
        m.minMarketCapUsd > 0 &&
        mc < m.minMarketCapUsd
      ) {
        return {
          score: 0,
          reason: `MC $${Math.round(mc)} below scalper min $${m.minMarketCapUsd}`,
        };
      }
    }
    const smallMc =
      mc != null &&
      m.maxMarketCapUsd != null &&
      mc > 0 &&
      mc <= m.maxMarketCapUsd;
    const genericScalp =
      isScalp &&
      (ctx.shortTermStrategyId === 'quick_scalper' ||
        ctx.shortTermStrategyId === 'micro_scalper');
    const atSupportReclaim =
      ctx.nearMultiTfSupport === true ||
      ctx.nearSupport === true ||
      (ctx.nearKeyFib === true &&
        ctx.srConfluenceScore != null &&
        Number(ctx.srConfluenceScore) >= 40);
    const styleTag = String(ctx.detectedEntryStyle || '');
    // Soft prefer reclaim / MTF support — never treat Dip Fib reclaim as Scalper DNA
    const reclaimDna =
      styleTag === 'scalp_reclaim_burst' ||
      (atSupportReclaim &&
        styleTag !== 'late_chase' &&
        styleTag !== 'support_dip_reclaim');
    // Specialty engines belong to other profiles — do not claim them as Scalper
    if (
      ctx.shortTermStrategyId === 'momentum_burst' ||
      ctx.shortTermStrategyId === 'reversal_scalp' ||
      ctx.shortTermStrategyId === 'post_migration_scalp'
    ) {
      return { score: 0, reason: `defer to ${ctx.shortTermStrategyId}` };
    }
    if (isMig) {
      return { score: 0, reason: 'defer to fresh migration' };
    }
    if (genericScalp && smallMc) {
      score += 80;
      bits.push(`scalp:${ctx.shortTermStrategyId}`);
      if (
        m.preferVolumeSpike &&
        volM5 != null &&
        volM5 >= (m.minVolumeM5Usd ?? 800)
      ) {
        score += 10;
        bits.push(`vol spike M5 $${Math.round(volM5)}`);
      }
    } else if (smallMc && !isDip && !isMig && !isMomentum && !isReversal) {
      // Untagged small-MC candidate (multi-profile path) — competitive but not automatic winner
      score += 52;
      bits.push(`small-MC scalp candidate $${Math.round(mc!)}`);
      if (
        m.preferVolumeSpike &&
        volM5 != null &&
        volM5 >= (m.minVolumeM5Usd ?? 800)
      ) {
        score += 12;
        bits.push('volume spike');
      } else if (volM5 == null && volH1 != null && volH1 >= 1_500) {
        score += 6;
        bits.push('vol1h confirm');
      }
    } else if (
      smallMc &&
      reclaimDna &&
      !isMig &&
      ctx.preferProfileId === 'scalper'
    ) {
      // Mode B watch handoff: support reclaim stamped to Scalper
      score += 70;
      bits.push('scalper watch reclaim');
    } else {
      return { score: 0, reason: 'not a scalp / small-MC setup' };
    }

    // Soft prefer: support reclaim / multi-TF confluence (Mode B sweet spot)
    if (reclaimDna || styleTag === 'scalp_reclaim_burst') {
      const reclaimBump =
        styleTag === 'scalp_reclaim_burst'
          ? 22
          : ctx.nearMultiTfSupport === true
            ? 18
            : 12;
      score += reclaimBump;
      bits.push(
        styleTag === 'scalp_reclaim_burst'
          ? 'scalp_reclaim_burst'
          : ctx.nearMultiTfSupport === true
            ? 'mtf support reclaim'
            : 'near support reclaim'
      );
    } else if (!atSupportReclaim && ctx.lateChase !== true) {
      // Mid-air / not near support — soft deprioritize vs reclaim setups
      score = Math.max(0, score - 16);
      bits.push('mid-air soft penalty');
    }
    if (ctx.lateChase === true || styleTag === 'late_chase') {
      // Tighten late-chase beyond DNA −40 when chasing without support
      score = Math.max(0, score - (atSupportReclaim ? 8 : 18));
      bits.push(
        atSupportReclaim ? 'late_chase soft' : 'late_chase mid-air'
      );
    }
    if (ctx.preferProfileId === 'scalper' && atSupportReclaim) {
      score += 14;
      bits.push('watch prefer scalper@S');
    }
    // Habit 1.2.247: soft-require Mode B when WR weak / recovery ≤1
    // (armed / watch-triggered bypass; expanding vol + near support exception)
    try {
      const armedModeB =
        ctx.armedWatch === true ||
        String(ctx.setupWatchFamily || '').toLowerCase() === 'scalper';
      if (!armedModeB) {
        const { shouldSoftSkipUnarmedScalperHabit } =
          require('./profileAttention') as typeof import('./profileAttention');
        const habit = shouldSoftSkipUnarmedScalperHabit({
          profileId: 'scalper',
          armedWatch: false,
          scannerReasons: null,
          volumeDecayState: ctx.volumeDecayState ?? null,
          nearSupport: atSupportReclaim || ctx.nearSupport === true,
          nearMultiTfSupport: ctx.nearMultiTfSupport === true,
        });
        if (habit.skip) {
          return {
            score: 0,
            reason: habit.reason || 'scalper habit: prefer armed Mode B',
          };
        }
      }
    } catch {
      /* optional */
    }
  }

  if (m.preferMigration) {
    if (!freshMig.ok) {
      return { score: 0, reason: freshMig.reason };
    }
    // Habit 1.2.247: dump / late-chase filters for discretionary MS (Grad-armed bypass)
    const gradArmed =
      ctx.armedWatch === true &&
      /grad|mig/i.test(String(ctx.setupWatchFamily || ''));
    if (!gradArmed) {
      const migStyle = String(ctx.detectedEntryStyle || '');
      // late_chase primary only — lateChase flag alone must not kill fire-band
      if (migStyle === 'late_chase') {
        return {
          score: 0,
          reason: 'migration habit: late_chase primary rejected (not Grad-armed)',
        };
      }
      const h1Pump =
        ctx.priceChangeH1Pct != null && Number.isFinite(ctx.priceChangeH1Pct)
          ? Number(ctx.priceChangeH1Pct)
          : null;
      // Already extended hard → post-entry dump pattern risk
      if (h1Pump != null && h1Pump >= 40) {
        return {
          score: 0,
          reason: `migration habit: already extended hard (+${h1Pump.toFixed(0)}% H1 dump risk)`,
        };
      }
      const holdReclaim =
        migStyle === 'migration_hold_reclaim' ||
        migStyle === 'scalp_reclaim_burst' ||
        ctx.nearSupport === true ||
        ctx.nearMultiTfSupport === true;
      const fireOrFresh =
        /pre-grad curve|ultra-fresh post-grad/i.test(freshMig.reason);
      // Discretionary MS without hold/reclaim confirm outside fire/fresh path
      if (!holdReclaim && !fireOrFresh) {
        return {
          score: 0,
          reason:
            'migration habit: missing hold/reclaim confirm (not Grad-armed)',
        };
      }
    }
    score += 92;
    bits.push(freshMig.reason);
    const curvePct =
      ctx.curveProgressPct != null && Number.isFinite(ctx.curveProgressPct)
        ? Number(ctx.curveProgressPct)
        : null;
    if (curvePct != null && curvePct >= 88 && curvePct < 100) {
      score += 14;
      bits.push(`fire-band ${curvePct.toFixed(1)}%`);
    }
    if (mc != null) {
      bits.push(`MC $${Math.round(mc)}`);
    }
    if (
      m.preferHolderGrowth &&
      holderGrowth != null &&
      holderGrowth > 0
    ) {
      const hAdd = Math.min(12, Math.round(holderGrowth / 4));
      if (hAdd > 0) {
        score += hAdd;
        bits.push(`holders +${holderGrowth.toFixed(0)}% (+${hAdd})`);
      }
    }
    if (buyPressureUsd != null && buyPressureUsd >= (m.minBuyPressureUsd ?? 400)) {
      const pAdd = Math.min(10, Math.round(buyPressureUsd / 1500));
      if (pAdd > 0) {
        score += pAdd;
        bits.push(`buy $${Math.round(buyPressureUsd)} (+${pAdd})`);
      }
    }
    if (volH1 != null && volH1 >= (m.minVolumeH1Usd ?? 1500)) {
      score += 10;
      bits.push(`vol $${Math.round(volH1)}`);
    } else if (
      volH1 != null &&
      m.minVolumeH1Usd != null &&
      volH1 < m.minVolumeH1Usd
    ) {
      score -= 10;
      bits.push('low migration volume');
    }
    if (
      m.preferSmartMoney &&
      ctx.smartMoneyScore != null &&
      ctx.smartMoneyScore >= 35
    ) {
      score += 10;
      bits.push(`SM ${ctx.smartMoneyScore}`);
    }
  }

  if (m.preferMomentumBurst) {
    if (ctx.shortTermStrategyId === 'momentum_burst') {
      score += 90;
      bits.push('momentum_burst armed');
    } else if (isMomentum && !isDip && !isMig) {
      // Soft volume/pressure match — leave headroom for Trend / HWR / Mirror
      score += 46;
      bits.push(
        volM5 != null
          ? `burst vol M5 $${Math.round(volM5)}`
          : 'momentum pressure'
      );
      if (buyPressureUsd != null && buyPressureUsd > 0) {
        bits.push(`buy $${Math.round(buyPressureUsd)}`);
        if (m.minBuyPressureUsd != null && buyPressureUsd >= m.minBuyPressureUsd) {
          score += 6;
          bits.push(`pressure ≥ $${Math.round(m.minBuyPressureUsd)}`);
        }
      }
      if ((ctx.chartPatternIds || []).includes('bull_flag')) {
        bits.push('bull_flag');
      }
    } else {
      return { score: 0, reason: 'not a momentum burst setup' };
    }
  }

  if (m.preferReversal) {
    if (ctx.shortTermStrategyId === 'reversal_scalp') {
      score += 95;
      bits.push('reversal_scalp armed');
    } else if (drop != null && drop >= (m.minDropFromPeakPct ?? 12) && !isMig) {
      score += 72;
      bits.push(`wick/over-extension −${drop.toFixed(0)}%`);
      if (buyPressureUsd != null && m.minBuyPressureUsd != null) {
        score += Math.min(
          10,
          Math.max(0, Math.round((buyPressureUsd - m.minBuyPressureUsd) / 250))
        );
      }
    } else {
      return { score: 0, reason: 'not a reversal / wick setup' };
    }
  }

  if (m.preferTrend) {
    // Fresh / priority migrations belong to Migration Sniper — not Trend Rider.
    if (
      (ctx.isMigration === true ||
        ctx.strategyKind === 'migration' ||
        ctx.entrySource === 'migration') &&
      !feedPrefer
    ) {
      return {
        score: 0,
        reason: 'trend_rider: defer migration to Migration Sniper',
      };
    }
    // Armed-prefer (1.2.249): near-zero discretionary when quality arms live
    const trendArmed =
      ctx.armedWatch === true ||
      String(ctx.setupWatchFamily || '').toLowerCase() === 'trend' ||
      /trend-watch:triggered|trend_pullback_continuation/i.test(
        String(ctx.detectedEntryStyle || '') +
          ' ' +
          String(ctx.entryStyleHint || '')
      ) ||
      feedPrefer;
    let fallbackDisc = true;
    try {
      const { isFallbackDiscAllowed, isAdmissionBaselineV235 } =
        require('./expectancyLift') as typeof import('./expectancyLift');
      if (!isAdmissionBaselineV235()) {
        fallbackDisc = isFallbackDiscAllowed();
      }
    } catch {
      fallbackDisc = true;
    }
    if (!trendArmed && !fallbackDisc && !feedPrefer) {
      return {
        score: 0,
        reason: 'trend habit: armed watch only (near-zero disc)',
      };
    }
    if (hostileArmed && !feedPrefer) {
      return { score: 0, reason: 'trend_rider: not a trend hold setup' };
    }
    if (conv != null && conv < (minConviction ?? 50)) {
      return { score: 0, reason: 'trend_rider: conviction too low' };
    }

    // Social / KOL specialty may hold quieter tape; discretionary needs live volume.
    const specialtyQuietOk =
      ctx.specialtyFeed === 'kolscan' ||
      ctx.specialtyFeed === 'jupiter' ||
      (kolN != null && kolN >= (m.minKolWallets ?? 3));
    const volUptick =
      volM5 != null &&
      volH1 != null &&
      volH1 > 0 &&
      volM5 >= volH1 * 0.1;
    let decay =
      ctx.volumeDecayState === 'expanding' ||
      ctx.volumeDecayState === 'stable' ||
      ctx.volumeDecayState === 'decaying' ||
      ctx.volumeDecayState === 'collapsed'
        ? ctx.volumeDecayState
        : null;
    if (!decay && (volM5 != null || volH1 != null)) {
      try {
        const { evaluateVolumeIntelligence } =
          require('./volumeIntelligence') as typeof import('./volumeIntelligence');
        const snap = evaluateVolumeIntelligence({
          volumeM5Usd: volM5,
          volumeH1Usd: volH1,
          profileId: 'trend_rider',
        });
        decay = snap.decayState;
      } catch {
        /* optional */
      }
    }
    if (!specialtyQuietOk) {
      if (decay === 'collapsed' && !volUptick) {
        return {
          score: 0,
          reason: 'trend_rider: volume collapsed (stale tape)',
        };
      }
      if (decay === 'decaying' && !volUptick) {
        return {
          score: 0,
          reason: 'trend_rider: volume decaying (soft-skip stale tape)',
        };
      }
      // Soft continuation / momentum: flat extension without pattern affinity
      const patterns = ctx.chartPatternIds || [];
      const hasContinuation = patterns.some((id) =>
        ['structured_pullback', 'bull_flag', 'trend_continuation'].includes(id)
      );
      const flatExt =
        (pullback != null && pullback < 2) ||
        (chg24 != null && Math.abs(chg24) < 2.5 && (pullback == null || pullback < 4));
      if (flatExt && !hasContinuation && !volUptick) {
        return {
          score: 0,
          reason: 'trend_rider: flat momentum without continuation pattern',
        };
      }
    } else if (decay === 'collapsed' || decay === 'decaying') {
      bits.push(
        specialtyQuietOk
          ? `quiet tape ok (${ctx.specialtyFeed || `${kolN} KOLs`})`
          : 'quiet tape'
      );
    }

    let quality = 0;
    // Established MC tokens can qualify earlier than pure age floors
    // Soft quality bonus (hard Min token age is in evaluateLaneEntryFloors)
    const ageFloor =
      mc != null && mc >= 300_000
        ? Math.min(m.minTokenAgeHours ?? 6, 1)
        : (m.minTokenAgeHours ?? 6);
    if (m.minTokenAgeHours != null && m.minTokenAgeHours > 0) {
      if (ageH != null && ageH >= ageFloor) {
        quality += 1;
        bits.push(`age ${ageH.toFixed(1)}h`);
      }
    }
    if (m.minHolders != null) {
      if (holders != null && holders >= m.minHolders) {
        quality += 1;
        bits.push(`${holders} holders`);
      } else if (holders != null && holders < m.minHolders) {
        return {
          score: 0,
          reason: `trend_rider: holders ${holders} < ${m.minHolders}`,
        };
      }
    }
    if (m.minVolumeH1Usd != null) {
      if (volH1 != null && volH1 >= m.minVolumeH1Usd) {
        quality += 1;
        bits.push(`1h vol $${Math.round(volH1)}`);
      } else if (volH1 != null && volH1 < m.minVolumeH1Usd) {
        return {
          score: 0,
          reason: `trend_rider: 1h vol $${Math.round(volH1)} < $${m.minVolumeH1Usd}`,
        };
      }
    }
    const convPart =
      conv != null ? Math.min(35, (conv - 42) * 0.7) : 0;
    score += 74 + convPart + quality * 8;
    bits.push(
      conv != null ? `trend conviction ${conv}` : 'trend conviction pending'
    );
    if (mc != null && mc >= 300_000) {
      score += 14;
      bits.push(`established MC $${Math.round(mc)}`);
    }
    if (mc != null && m.preferMarketCapUsd != null && mc >= m.preferMarketCapUsd) {
      score += 10;
      bits.push(`prefer MC $${Math.round(mc)}`);
    }
    // Soft H1 volume quality tiers (aspirational $50k / $100k / $500k)
    // Non-specialty: tighten mid tiers so dead mid-MC names score worse
    if (volH1 != null) {
      if (volH1 >= 500_000) {
        score += 22;
        bits.push('elite 1h vol');
      } else if (volH1 >= 100_000) {
        score += 14;
        bits.push('strong 1h vol');
      } else if (volH1 >= 50_000) {
        score += specialtyQuietOk ? 8 : 6;
        bits.push('good 1h vol');
      } else if (!specialtyQuietOk && volH1 < 50_000) {
        score -= 8;
        bits.push('soft 1h vol below $50k');
      }
    }
    if (volUptick) {
      score += 6;
      bits.push('M5/H1 volume uptick');
    }
    if (kolN != null && kolN >= (m.minKolWallets ?? 3)) {
      score += 12 + Math.min(10, (kolN - 2) * 2);
      bits.push(`${kolN} KOLs`);
    }
    if (m.preferHolderGrowth && holderGrowth != null && holderGrowth > 5) {
      score += Math.min(16, Math.round(holderGrowth / 2));
      bits.push(`holder growth +${holderGrowth.toFixed(0)}%`);
    }
  }

  if (m.preferSteadyCompounder) {
    // Armed-only doctrine (1.2.248): near-zero discretionary Steady
    const steadyArmed =
      ctx.armedWatch === true ||
      String(ctx.setupWatchFamily || '').toLowerCase() === 'dip' ||
      /dip-watch:triggered|quality_structure_reclaim/i.test(
        String(ctx.detectedEntryStyle || '')
      ) ||
      feedPrefer;
    if (!steadyArmed && !feedPrefer) {
      return {
        score: 0,
        reason: 'steady habit: armed quality reclaim only (near-zero disc)',
      };
    }
    if (hostileArmed && !feedPrefer) {
      return { score: 0, reason: 'not a compounder setup' };
    }
    if (conv != null && conv < (minConviction ?? 45)) {
      return { score: 0, reason: 'conviction too low for compounder' };
    }
    const ageFloor =
      mc != null && mc >= 300_000
        ? Math.min(m.minTokenAgeHours ?? 8, 1.5)
        : (m.minTokenAgeHours ?? 8);
    // Hard Min token age is in evaluateLaneEntryFloors; keep soft quality below
    if (m.minHolders != null && holders != null && holders < m.minHolders) {
      return { score: 0, reason: `holders ${holders} < ${m.minHolders}` };
    }
    if (m.minVolumeH1Usd != null && volH1 != null && volH1 < m.minVolumeH1Usd) {
      return {
        score: 0,
        reason: `1h vol $${Math.round(volH1)} < $${m.minVolumeH1Usd}`,
      };
    }
    // Small pullback band OR volume uptick — deep knives (>25%) leave to Dip
    const minPb = m.minPullbackPct;
    const maxPb = m.maxPullbackPct;
    if (minPb != null || maxPb != null) {
      const pb = pullback;
      const inBand =
        pb != null &&
        (minPb == null || pb >= minPb) &&
        (maxPb == null || pb <= maxPb);
      const volUptick =
        volM5 != null &&
        volH1 != null &&
        volH1 > 0 &&
        volM5 >= volH1 * 0.08;
      const knifeDip = pb != null && pb > 25;
      if (knifeDip && !feedPrefer) {
        return {
          score: 0,
          reason: `pullback −${pb!.toFixed(0)}% too deep for compounder`,
        };
      }
      if (inBand) {
        score += 18;
        bits.push(`small pullback −${pb!.toFixed(1)}%`);
      } else if (volUptick) {
        score += 12;
        bits.push('volume uptick');
      } else if (!feedPrefer && pb != null) {
        score -= 10;
        bits.push(
          `pullback −${pb.toFixed(1)}% outside ${minPb ?? 0}–${maxPb ?? 20}%`
        );
      }
    }
    let q = 0;
    if (ageH != null && m.minTokenAgeHours != null && ageH >= ageFloor) {
      q += 1;
      bits.push(`age ${ageH.toFixed(1)}h`);
    }
    if (holders != null && m.minHolders != null && holders >= m.minHolders) {
      q += 1;
      bits.push(`${holders} holders`);
    }
    if (volH1 != null && m.minVolumeH1Usd != null && volH1 >= m.minVolumeH1Usd) {
      q += 1;
      bits.push(`1h vol $${Math.round(volH1)}`);
    }
    const convPart =
      conv != null ? Math.min(25, (conv - 40) * 0.5) : 0;
    score += 72 + convPart + q * 10;
    bits.push(
      conv != null
        ? `compounder conviction ${conv}`
        : 'compounder conviction pending'
    );
    if (mc != null && mc >= 1_000_000) {
      score += 16;
      bits.push(`heavy MC $${Math.round(mc)}`);
    } else if (mc != null && mc >= 300_000) {
      score += 8;
      bits.push(`MC $${Math.round(mc)}`);
    }
    if (mc != null && m.preferMarketCapUsd != null && mc >= m.preferMarketCapUsd) {
      score += 10;
      bits.push(`prefer MC $${Math.round(mc)}`);
    }
    if (kolN != null && kolN >= (m.minKolWallets ?? 3)) {
      score += 12 + Math.min(10, (kolN - 2) * 2);
      bits.push(`${kolN} KOLs`);
    }
  }

  if (m.preferSmartMoneyMirror) {
    if (ctx.scannerOrigin && ctx.entrySource === 'scanner') {
      return { score: 0, reason: 'scanner-only — prefer TA profiles' };
    }
    if (isMig) return { score: 0, reason: 'defer to fresh migration' };
    // Soft volume "momentum" no longer vetoes Mirror — only hard specialty lanes
    if (
      isScalp ||
      isDip ||
      isReversal ||
      ctx.shortTermStrategyId === 'momentum_burst'
    ) {
      return { score: 0, reason: 'not a clean copy / mirror setup' };
    }
    if (conv != null && conv < (minConviction ?? 48)) {
      return { score: 0, reason: 'conviction too low for mirror' };
    }
    // Late fill after peak — copy already chasing; Mirror wants fresher entries
    if (drop != null && drop > 22) {
      return {
        score: 0,
        reason: `too late after peak (−${drop.toFixed(0)}%)`,
      };
    }
    const clusterFloor = m.minWalletCount ?? 3;
    const clusterOk = wallets != null && wallets >= clusterFloor;
    if (m.requireCluster && wallets != null && !clusterOk) {
      // Allow 2-wallet mirrors only when quality is known and strong
      const wqEarly =
        ctx.walletQualityAvg != null && Number.isFinite(ctx.walletQualityAvg)
          ? Number(ctx.walletQualityAvg)
          : null;
      if (
        wallets < 2 ||
        wqEarly == null ||
        (minWalletQuality != null && wqEarly < minWalletQuality)
      ) {
        return { score: 0, reason: 'need wallet convergence' };
      }
    }
    const wq =
      ctx.walletQualityAvg != null && Number.isFinite(ctx.walletQualityAvg)
        ? Number(ctx.walletQualityAvg)
        : null;
    if (minWalletQuality != null && wq != null && wq < minWalletQuality) {
      return {
        score: 0,
        reason: `wallet quality ${wq.toFixed(0)} < ${minWalletQuality}`,
      };
    }
    // Unknown WQ in BT: demand higher conviction + cluster (skip when conviction pending)
    if (
      wq == null &&
      conv != null &&
      (conv < 54 || (wallets != null && wallets < 2))
    ) {
      return {
        score: 0,
        reason: 'mirror needs WQ or 2+ wallets + conviction 54+',
      };
    }
    const mirrorConv =
      conv != null ? Math.min(25, (conv - 48) * 0.6) : 0;
    score += 60 + mirrorConv;
    bits.push(
      conv != null ? `mirror conviction ${conv}` : 'mirror conviction pending'
    );
    if (clusterOk) {
      score += 18;
      bits.push(`${wallets} wallets`);
    } else if (wallets != null && wallets >= 2) {
      score += 8;
      bits.push(`${wallets} wallets (quality OK)`);
    }
    if (wq != null && (minWalletQuality == null || wq >= minWalletQuality)) {
      score += 12;
      bits.push(`WQ ${wq.toFixed(0)}`);
    }
    if (
      m.preferSmartMoney &&
      ctx.smartMoneyScore != null &&
      ctx.smartMoneyScore >= 45
    ) {
      score += 14;
      bits.push(`SM ${ctx.smartMoneyScore}`);
    }
    if (drop != null && drop > 0 && drop <= 12) {
      score += 6;
      bits.push(`fresh −${drop.toFixed(0)}% from peak`);
    }
  }

  if (m.preferHighWinRate) {
    if (isMig) return { score: 0, reason: 'defer to fresh migration' };
    // Soft volume bursts no longer hard-veto HWR — only armed specialty engines
    // Soft isDip-from-drop alone does not veto when specialty feed prefers HWR
    if (
      isScalp ||
      isReversal ||
      ctx.shortTermStrategyId === 'momentum_burst' ||
      (ctx.shortTermStrategyId === 'post_run_dip' && !feedPrefer)
    ) {
      return { score: 0, reason: 'not high-win-rate selective' };
    }
    if (conv != null && conv < (minConviction ?? 55)) {
      return { score: 0, reason: 'conviction too low' };
    }
    if (
      m.requireCluster &&
      effectiveClusterWallets < (m.minWalletCount ?? 2) &&
      !(feedPrefer && (kolN ?? 0) >= (m.minKolWallets ?? 2))
    ) {
      return { score: 0, reason: 'need cluster for high win-rate' };
    }
    const wq =
      ctx.walletQualityAvg != null && Number.isFinite(ctx.walletQualityAvg)
        ? Number(ctx.walletQualityAvg)
        : null;
    if (minWalletQuality != null && wq != null && wq < minWalletQuality) {
      return {
        score: 0,
        reason: `wallet quality ${wq.toFixed(0)} < ${minWalletQuality}`,
      };
    }
    const hwrConv =
      conv != null ? Math.min(35, (conv - 55) * 0.8) : 0;
    score += 64 + hwrConv;
    bits.push(
      conv != null
        ? `high-quality conviction ${conv}`
        : 'high-quality conviction pending'
    );
    if (effectiveClusterWallets >= (m.minWalletCount ?? 2)) {
      score += 14;
      bits.push(`cluster ${effectiveClusterWallets}`);
    }
    if (wq != null && minWalletQuality != null && wq >= minWalletQuality) {
      score += 12;
      bits.push(`WQ ${wq.toFixed(0)}`);
    }
    if (kolN != null && kolN >= (m.minKolWallets ?? 4)) {
      score += 10;
      bits.push(`${kolN} KOLs`);
    }
    if (
      m.preferSmartMoney &&
      ctx.smartMoneyScore != null &&
      ctx.smartMoneyScore >= 50
    ) {
      score += 10;
      bits.push(`SM ${ctx.smartMoneyScore}`);
    }
    if (config.strategyProfile === 'high_win_rate') {
      score += 12;
      bits.push('high_win_rate preset');
    }
  }

  if (m.always) {
    score += 1;
    bits.push('fallback');
  }

  // Chart pattern preferences (primary / secondary + quality gates)
  const patternHits = Array.isArray(ctx.chartPatternHits)
    ? ctx.chartPatternHits
    : (Array.isArray(ctx.chartPatternIds)
        ? ctx.chartPatternIds.map((id) => ({
            id,
            confidence: 60,
            breakout: false,
            bias: undefined as string | undefined,
          }))
        : []);
  const primaryIds = new Set(
    m.primaryPatternIds?.length
      ? m.primaryPatternIds
      : m.preferPatternIds || []
  );
  const secondaryIds = new Set(m.secondaryPatternIds || []);

  // High Win-Rate Quality Filter — only for this profile, when technicals present
  let hwrQuality: ReturnType<typeof evaluateHwrQualityFilter> | null = null;
  if (m.preferHighWinRate) {
    const qf = normalizeHwrQualityFilter(m.qualityFilter);
    hwrQuality = evaluateHwrQualityFilter(
      {
        symbol: ctx.symbol,
        marketCapUsd: ctx.marketCapUsd,
        liquidityUsd: ctx.liquidityUsd,
        volumeH1Usd: ctx.volumeH1Usd,
        holderCount: ctx.holderCount,
        nearKeyFib: ctx.nearKeyFib,
        nearSupport: ctx.nearSupport,
        chartPatternIds: ctx.chartPatternIds,
        chartPatternHits: patternHits,
      },
      qf
    );
    if (hwrQuality.applicable && !hwrQuality.pass) {
      logHwrQualityFilterReject(ctx, hwrQuality, 'technical setup');
      if (qf.mode === 'reject') {
        return {
          score: 0,
          reason: `HWR Quality Filter: ${hwrQuality.summary}`,
        };
      }
      score = Math.max(0, score - qf.weakSetupPenalty);
      bits.push(`HWR Quality Filter penalty (${hwrQuality.summary})`);
    } else if (hwrQuality.applicable && hwrQuality.soft) {
      logHwrQualityFilterSoft(ctx, hwrQuality);
      score = Math.max(0, score - Math.round(qf.weakSetupPenalty / 2));
      bits.push(`HWR quality soft (${hwrQuality.summary})`);
    } else if (hwrQuality.applicable && hwrQuality.pass) {
      score += qf.cleanSetupBonus;
      bits.push('HWR Quality Filter OK');
    }
  }

  const sens = m.patternSensitivity || 'medium';
  const confFloor =
    m.patternMinConfidence != null
      ? Number(m.patternMinConfidence)
      : sens === 'high'
        ? 48
        : sens === 'low'
          ? 65
          : 55;

  const liq =
    ctx.liquidityUsd != null && Number.isFinite(ctx.liquidityUsd)
      ? Number(ctx.liquidityUsd)
      : null;
  const holdersN = holders;
  const volH1n = volH1;

  function patternPassesQuality(hit: {
    id: string;
    confidence: number;
    breakout: boolean;
    bias?: string;
  }): { ok: boolean; why?: string } {
    if (hit.confidence < confFloor) {
      return { ok: false, why: `conf ${hit.confidence}<${confFloor}` };
    }
    if (m.patternRequireBreakout && !hit.breakout) {
      // Pullback / dry-up setups are not breakout patterns — gate on quality instead
      if (
        hit.id !== 'structured_pullback' &&
        hit.id !== 'volume_dryup_return'
      ) {
        return { ok: false, why: 'need breakout' };
      }
    }
    // HWR structured pullbacks must sit on Fib / strong support
    if (
      m.patternRequireFibOrSupport &&
      hit.id === 'structured_pullback' &&
      !(ctx.nearKeyFib || ctx.nearSupport) &&
      (m.preferCleanPatterns || m.preferHighWinRate)
    ) {
      return { ok: false, why: 'need Fib/support' };
    }
    if (
      m.patternMinLiquidityUsd != null &&
      liq != null &&
      liq < m.patternMinLiquidityUsd
    ) {
      return { ok: false, why: `liq $${Math.round(liq)}` };
    }
    if (
      m.patternMinHolders != null &&
      holdersN != null &&
      holdersN < m.patternMinHolders
    ) {
      return { ok: false, why: `holders ${holdersN}` };
    }
    if (
      m.patternMinVolumeH1Usd != null &&
      volH1n != null &&
      volH1n < m.patternMinVolumeH1Usd
    ) {
      return { ok: false, why: `vol1h $${Math.round(volH1n)}` };
    }
    if (
      m.patternMinMarketCapUsd != null &&
      mc != null &&
      mc < m.patternMinMarketCapUsd
    ) {
      // Secondary HWR patterns (bull flag / trend cont) especially need MC floor
      if (
        secondaryIds.has(hit.id) ||
        m.preferCleanPatterns ||
        m.preferHighWinRate
      ) {
        return { ok: false, why: `MC $${Math.round(mc)}` };
      }
    }
    // Higher MC tokens: cleaner volume dry-up for HWR
    if (
      (m.preferCleanPatterns || m.preferHighWinRate) &&
      hit.id === 'volume_dryup_return' &&
      volH1n != null &&
      volH1n < (m.patternMinVolumeH1Usd ?? 6_000)
    ) {
      return { ok: false, why: 'need higher volume dry-up/return' };
    }
    return { ok: true };
  }

  if (patternHits.length && (primaryIds.size || secondaryIds.size || m.preferBullishPatterns)) {
    let primaryScore = 0;
    let secondaryScore = 0;
    const primaryHits: string[] = [];
    const secondaryHits: string[] = [];
    const rejected: string[] = [];

    for (const hit of patternHits) {
      const isPrimary = primaryIds.has(hit.id);
      const isSecondary = secondaryIds.has(hit.id);
      if (!isPrimary && !isSecondary) continue;
      const q = patternPassesQuality(hit);
      if (!q.ok) {
        rejected.push(`${hit.id}(${q.why})`);
        continue;
      }
      if (isPrimary) {
        primaryScore += 18 + Math.min(10, Math.round((hit.confidence - confFloor) / 4));
        if (hit.breakout) primaryScore += 6;
        primaryHits.push(hit.id);
      } else if (isSecondary) {
        secondaryScore += 8 + Math.min(6, Math.round((hit.confidence - confFloor) / 6));
        if (hit.breakout) secondaryScore += 3;
        secondaryHits.push(hit.id);
      }
    }

    if (primaryHits.length) {
      score += Math.min(42, primaryScore);
      bits.push(`primary patterns ${primaryHits.join('+')}`);
      if (m.preferCleanPatterns) {
        score += 6;
        bits.push('clean pattern bias');
      }
    }
    if (secondaryHits.length) {
      score += Math.min(22, secondaryScore);
      bits.push(`secondary patterns ${secondaryHits.join('+')}`);
    }
    if (
      !primaryHits.length &&
      !secondaryHits.length &&
      rejected.length &&
      (m.preferCleanPatterns || m.preferHighWinRate)
    ) {
      bits.push(`patterns gated: ${rejected.slice(0, 2).join(',')}`);
      if (m.preferHighWinRate) {
        console.log(
          `[hwr-quality] REJECTED ${ctx.symbol || 'token'} — patterns gated: ${rejected.slice(0, 4).join(', ')}`
        );
      }
    }
  } else if (m.preferBullishPatterns && patternHits.length && !m.preferDip) {
    const bullishIds = new Set([
      'falling_wedge',
      'ascending_triangle',
      'trend_continuation',
      'structured_pullback',
      'volume_dryup_return',
      'bull_flag',
      'trendline_break',
      'capitulation',
    ]);
    const hits = patternHits.filter((h) => bullishIds.has(h.id));
    if (hits.length) {
      score += 10 + Math.min(10, hits.length * 3);
      bits.push(`bullish patterns ${hits.map((h) => h.id).join('+')}`);
    }
  }
  if (m.avoidBearishPatterns && patternHits.length) {
    const bearish = patternHits.filter(
      (h) =>
        h.id === 'descending_triangle' ||
        h.id === 'holder_distribution' ||
        (h.id === 'capitulation' && h.bias === 'bearish')
    );
    if (bearish.length) {
      score = Math.max(0, score - 18);
      bits.push(`bearish warn ${bearish.map((h) => h.id).join('+')}`);
    }
  }

  if (score <= 0) return { score: 0, reason: 'no match' };

  // HWR multi-TA concurrence: pattern + Fib/S + confirmation (or specialty feed)
  if (m.preferHighWinRate && m.requireMultiTaConfirm === true && !feedPrefer) {
    const hasPattern =
      patternHits.length > 0 || (ctx.chartPatternIds || []).length > 0;
    const hasFibSr = ctx.nearKeyFib === true || ctx.nearSupport === true;
    const conf = ctx.confirmationLevel;
    const confOk =
      conf === 'soft' ||
      conf === 'strong' ||
      (conv != null && conv >= 62);
    if (!hasPattern || !hasFibSr || !confOk) {
      return {
        score: 0,
        reason: `HWR multi-TA need pattern+Fib/S+confirm (p=${hasPattern} fib=${hasFibSr} conf=${conf || 'none'})`,
      };
    }
    score += 14;
    bits.push('multi-TA confirm');
  } else if (m.preferHighWinRate && m.requireMultiTaConfirm === true && feedPrefer) {
    bits.push('multi-TA via specialty feed');
    score += 8;
  }

  // Specialty feed / grad-watch soft prefer — tagged higher-quality tokens
  if (
    ctx.preferProfileId &&
    ctx.preferProfileId === def.id &&
    (m.kolscanFeedEnabled === true ||
      def.id === 'migration_sniper' ||
      ctx.specialtyFeed === 'majors')
  ) {
    score += 38;
    bits.push(
      ctx.specialtyFeed
        ? `specialty feed ${ctx.specialtyFeed}`
        : def.id === 'migration_sniper'
          ? 'grad-watch prefer'
          : 'specialty feed prefer'
    );
  }

  return {
    score: score + def.priority * 0.01,
    reason: bits.join(', ') || def.name,
  };
}

function legacyDefaultAssignment(reason: string): TradeProfileAssignment {
  const def = getTradeProfileDefinition('default');
  const preset = String(config.strategyProfile || 'custom').replace(/_/g, ' ');
  return {
    profileId: def.id,
    name: def.name,
    icon: def.icon,
    color: def.color,
    score: 0,
    reason: `${reason} · global preset: ${preset}`,
    exitRules: {},
    legacy: true,
    autoScored: false,
  };
}

function finalizeExitRulesForWinner(
  def: TradeProfileDefinition,
  ctx: TradeProfileMatchContext
): TradeProfileExitRules {
  let exitRules = materializeExitRules({ ...def.exitRules });

  if (def.id === 'scalper') {
    exitRules.forceScalp = true;
    exitRules.overrideScalpParams = true;
    if (
      ctx.shortTermStrategyId &&
      ctx.shortTermStrategyId !== 'post_run_dip' &&
      ctx.shortTermStrategyId !== 'momentum_burst' &&
      ctx.shortTermStrategyId !== 'reversal_scalp' &&
      ctx.shortTermStrategyId !== 'post_migration_scalp'
    ) {
      exitRules.shortTermStrategyId =
        ctx.shortTermStrategyId as ShortTermStrategyId;
    } else {
      exitRules.shortTermStrategyId = 'quick_scalper';
    }
  }

  if (def.id === 'dip_buyer') {
    if (ctx.shortTermStrategyId === 'post_run_dip') {
      exitRules.forceScalp = true;
      exitRules.shortTermStrategyId = 'post_run_dip';
      exitRules.overrideScalpParams = true;
    } else {
      // Dip is a swing — clear any seeded post_migration_scalp / other scalp
      // so short migration timers cannot stick on a Dip Buyer winner.
      exitRules.forceScalp = false;
      exitRules.overrideScalpParams = false;
      delete (exitRules as { shortTermStrategyId?: string }).shortTermStrategyId;
      exitRules.hardTimeLimitSecMin = undefined;
      exitRules.hardTimeLimitSecMax = undefined;
      (exitRules as { hardTimeLimitSec?: number }).hardTimeLimitSec = undefined;
    }
  }

  // Quality swing lanes — never keep a migration scalp timer when they win.
  if (
    def.id === 'trend_rider' ||
    def.id === 'steady_compounder' ||
    def.id === 'high_win_rate'
  ) {
    exitRules.forceScalp = false;
    exitRules.overrideScalpParams = false;
    delete (exitRules as { shortTermStrategyId?: string }).shortTermStrategyId;
    exitRules.hardTimeLimitSecMin = undefined;
    exitRules.hardTimeLimitSecMax = undefined;
    (exitRules as { hardTimeLimitSec?: number }).hardTimeLimitSec = undefined;
  }

  if (def.id === 'migration_sniper') {
    exitRules.forceScalp = true;
    exitRules.overrideScalpParams = true;
    exitRules.shortTermStrategyId = 'migration_event';
  }

  if (def.id === 'momentum_burst') {
    exitRules.forceScalp = true;
    exitRules.overrideScalpParams = true;
    exitRules.shortTermStrategyId = 'momentum_burst';
  }

  if (def.id === 'reversal_scalper') {
    exitRules.forceScalp = true;
    exitRules.overrideScalpParams = true;
    exitRules.shortTermStrategyId = 'reversal_scalp';
  }

  return exitRules;
}

function buildAssignmentFromDef(
  def: TradeProfileDefinition,
  ctx: TradeProfileMatchContext,
  opts: {
    score: number;
    reason: string;
    autoScored?: boolean;
    forced?: boolean;
    topScores?: TradeProfileAssignment['topScores'];
    top10SoftAllow?: boolean;
    top10SoftAllowTag?: Top10SoftAllowGrantTag;
    top10SoftAllowSizeMult?: number;
  }
): TradeProfileAssignment {
  let exitRules = finalizeExitRulesForWinner(def, ctx);
  let reason =
    exitRules.turboMode === true && !/\bturbo\b/i.test(opts.reason)
      ? `${opts.reason} · turbo`
      : opts.reason;
  const floorsHint =
    opts.top10SoftAllow === true
      ? {
          top10SoftAllow: true as const,
          top10SoftAllowTag: opts.top10SoftAllowTag,
          sizeMult: opts.top10SoftAllowSizeMult,
        }
      : evaluateLaneEntryFloors(def, ctx);
  if (floorsHint.top10SoftAllow === true) {
    const softTag =
      floorsHint.top10SoftAllowTag ?? 'top10_soft_allow_age_known';
    const softMult =
      floorsHint.sizeMult ??
      (softTag === 'top10_soft_allow_age_unknown_fallback'
        ? TOP10_SOFT_ALLOW_AGE_UNKNOWN_SIZE_MULT
        : TOP10_SOFT_ALLOW_SIZE_MULT);
    exitRules = applyTop10SoftAllowSizeHaircut(exitRules, true, softMult);
    if (!/top10_soft_allow/i.test(reason)) {
      reason = `${reason} · ${softTag}`;
    }
  }
  return {
    profileId: def.id,
    name: def.name,
    icon: def.icon,
    color: def.color,
    score: opts.score,
    reason,
    exitRules,
    legacy: def.id === 'default',
    autoScored: opts.autoScored === true,
    forced: opts.forced === true,
    topScores: opts.topScores,
  };
}

/**
 * Choose which enabled profile owns this trade.
 * Does not mutate global config — exit rules are returned for freezing on Position.
 *
 * When auto-scoring is ON: weighted factor scores + min threshold (may skip).
 * When OFF: legacy match-rule ranking (no skip-below-min).
 * forceProfileId overrides scoring when that profile is ON.
 *
 * `silent: true` skips decision log / console (used for early Smart Bot soft-score).
 */
export function assignTradeProfile(
  ctx: TradeProfileMatchContext,
  opts?: { silent?: boolean }
): TradeProfileAssignment {
  const silent = opts?.silent === true;
  const finish = (a: TradeProfileAssignment): TradeProfileAssignment => {
    if (!silent) {
      logTradeProfileAssignment(a, ctx);
      recordAssignmentDecision(a, ctx);
    }
    return a;
  };

  const state = ensureState();
  const auto = normalizeAutoScoringConfig(state.autoScoring);

  if (!state.enabled) {
    return finish(legacyDefaultAssignment('multi-profile off'));
  }

  const candidates = TRADE_PROFILE_CATALOG.filter((p) => {
    if (state.profiles[p.id] === false) return false;
    if (p.id === 'default') return false;
    // Zion only when forced / preferred from Place Trade — never auto-scored
    if (
      p.id === 'zion' &&
      auto.forceProfileId !== 'zion' &&
      ctx.preferProfileId !== 'zion'
    ) {
      return false;
    }
    return true;
  }).map((p) => resolveTradeProfileDefinition(p.id));

  // Manual force override
  if (auto.forceProfileId) {
    const forced = candidates.find((p) => p.id === auto.forceProfileId);
    if (forced) {
      return finish(
        buildAssignmentFromDef(forced, ctx, {
          score: 100,
          reason: `forced profile · ${forced.name}`,
          autoScored: auto.enabled,
          forced: true,
          topScores: [
            {
              id: forced.id,
              name: forced.name,
              icon: forced.icon,
              score: 100,
              reason: 'forced',
            },
          ],
        })
      );
    }
    if (!silent) {
      console.log(
        `[trade-profiles] Force profile ${auto.forceProfileId} is OFF — falling back to scoring`
      );
    }
  }

  // Smart Bot lane-fight winner — stamp the same profile that gated filters.
  // Floors/modules already ran in the cascade; do not re-score into skipBelowMin.
  if (ctx.preferProfileId) {
    const preferred = candidates.find((p) => p.id === ctx.preferProfileId);
    if (preferred) {
      const scored = scoreProfile(preferred, ctx);
      const score =
        scored.score > 0
          ? Math.round(scored.score * 10) / 10
          : Math.max(1, preferred.priority || 1);
      return finish(
        buildAssignmentFromDef(preferred, ctx, {
          score,
          // Keep UI reason clean — never show a reject reason on a forced stamp
          reason:
            scored.score > 0
              ? `lane winner · ${scored.reason}`
              : `lane winner · ${preferred.name}`,
          autoScored: auto.enabled,
        })
      );
    }
  }

  if (!auto.enabled) {
    // Legacy path: match rules only, no min-score skip
    const scored = candidates
      .map((p) => {
        const s = scoreProfile(p, ctx);
        return { def: p, ...s };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.def.priority - a.def.priority);

    const topScores = scored.slice(0, 5).map((x) => ({
      id: x.def.id,
      name: x.def.name,
      icon: x.def.icon,
      score: Math.round(x.score * 10) / 10,
      reason: x.reason,
    }));
    if (!silent) logTopScores(ctx, topScores, false);

    const winner = scored[0];
    if (!winner) {
      const a = legacyDefaultAssignment('no profile matched');
      a.topScores = topScores;
      return finish(a);
    }

    return finish(
      buildAssignmentFromDef(winner.def, ctx, {
        score: Math.round(winner.score * 10) / 10,
        reason: winner.reason,
        autoScored: false,
        topScores,
      })
    );
  }

  // Automatic scoring path
  const breakdowns: ProfileScoreBreakdown[] = [];
  for (const def of candidates) {
    if (def.id === 'default') continue;
    const match = scoreProfile(def, ctx);
    if (match.score <= 0) {
      breakdowns.push({
        profileId: def.id,
        name: def.name,
        icon: def.icon,
        color: def.color,
        score: 0,
        reason: match.reason,
        matchRaw: 0,
        factors: {},
      });
      continue;
    }
    const factors = computeFactorAffinities(def, ctx);
    const combined = combineAutoScore(
      auto.weights,
      factors,
      match.score,
      match.reason
    );
    let score = combined.score;
    let reason = combined.reason;
    try {
      const { isLearningModeActive, learningModeFairnessBump } =
        require('./learningMode') as typeof import('./learningMode');
      if (
        isLearningModeActive() &&
        isProfileLearningModeOptedIn(def.id) &&
        score > 0
      ) {
        let blockLm = false;
        try {
          const { shouldBlockLearningModeForDipBuyer } =
            require('./dipBuyerRecovery') as typeof import('./dipBuyerRecovery');
          blockLm = shouldBlockLearningModeForDipBuyer(def.id);
        } catch {
          /* optional */
        }
        if (!blockLm) {
          const { getProfileLearningEpisodes } =
            require('./profileLearningEpisodes') as typeof import('./profileLearningEpisodes');
          const bump = learningModeFairnessBump(
            getProfileLearningEpisodes(def.id, 500).length
          );
          if (bump > 0) {
            score = Math.round((score + bump) * 10) / 10;
            reason = `${reason} · LM fairness +${bump}`;
          }
        }
      }
    } catch {
      /* ignore */
    }
    breakdowns.push({
      profileId: def.id,
      name: def.name,
      icon: def.icon,
      color: def.color,
      score,
      reason,
      matchRaw: match.score,
      factors: combined.factors,
    });
  }

  breakdowns.sort(
    (a, b) =>
      b.score - a.score ||
      (candidates.find((c) => c.id === b.profileId)?.priority ?? 0) -
        (candidates.find((c) => c.id === a.profileId)?.priority ?? 0)
  );

  const topScores = breakdowns.slice(0, 5).map((x) => ({
    id: x.profileId,
    name: x.name,
    icon: x.icon,
    score: x.score,
    reason: x.reason,
  }));
  if (!silent) logTopScores(ctx, topScores, true);

  const winner = breakdowns.find((b) => b.score > 0);
  if (!winner) {
    const a = legacyDefaultAssignment('no profile matched (auto)');
    a.topScores = topScores;
    a.autoScored = true;
    return finish(a);
  }

  let autoMinScore = auto.minScore;
  try {
    // LM-adjusted auto min-score only softens for opted-in winners
    if (isProfileLearningModeOptedIn(winner.profileId)) {
      const { learningModeAdjustedAutoMinScore } =
        require('./learningMode') as typeof import('./learningMode');
      autoMinScore = learningModeAdjustedAutoMinScore(autoMinScore);
    }
  } catch {
    /* ignore */
  }
  if (
    auto.skipBelowMin &&
    winner.score < autoMinScore &&
    config.riskLevel !== 'off'
  ) {
    const skip: TradeProfileAssignment = {
      profileId: 'default',
      name: 'Skipped',
      icon: '⊘',
      color: TRADE_PROFILE_COLORS.skipped,
      score: winner.score,
      reason: `best ${winner.name} scored ${winner.score} < min ${autoMinScore}`,
      exitRules: {},
      legacy: true,
      skipped: true,
      skipReason: `Auto-score ${winner.score} below minimum ${autoMinScore} (best: ${winner.name})`,
      autoScored: true,
      topScores,
    };
    if (!silent) {
      console.log(
        `[trade-profiles] SKIP ${ctx.symbol || 'token'} — ${skip.skipReason}`
      );
      logTopScores(ctx, topScores, true);
    }
    return finish(skip);
  }

  const def = resolveTradeProfileDefinition(winner.profileId);
  return finish(
    buildAssignmentFromDef(def, ctx, {
      score: winner.score,
      reason: winner.reason,
      autoScored: true,
      topScores,
    })
  );
}

function logTopScores(
  ctx: TradeProfileMatchContext,
  top: Array<{ id: string; name: string; score: number; reason?: string }>,
  auto: boolean
): void {
  if (!top.length) return;
  const line = top
    .map((t) => `${t.name}=${Number(t.score ?? 0).toFixed(1)}`)
    .join(' · ');
  console.log(
    `[trade-profiles] SCORES${auto ? ' (auto)' : ''} ${ctx.symbol || 'token'}: ${line}`
  );
}

function recordAssignmentDecision(
  a: TradeProfileAssignment,
  ctx: TradeProfileMatchContext
): void {
  pushDecision({
    at: Date.now(),
    symbol: ctx.symbol || 'token',
    profileId: a.skipped ? 'skipped' : a.profileId,
    profileName: a.skipped ? 'Skipped' : a.name,
    icon: a.icon,
    score: a.score,
    reason: a.skipReason || a.reason,
    skipped: a.skipped === true,
    autoScored: a.autoScored === true,
    forced: a.forced === true,
    topScores: (a.topScores || []).slice(0, 5).map((t) => ({
      id: t.id,
      name: t.name,
      score: t.score,
    })),
  });
}

function logTradeProfileAssignment(
  a: TradeProfileAssignment,
  ctx: TradeProfileMatchContext
): void {
  const sym = ctx.symbol || 'token';
  if (a.skipped) {
    console.log(
      `[trade-profiles] SKIP ${sym} · score=${a.score.toFixed(1)} · ${a.skipReason || a.reason}`
    );
    return;
  }
  const er = a.exitRules;
  const exitBits = [
    er.takeProfitPct != null ? `TP ${er.takeProfitPct}%` : null,
    er.stopLossPct != null ? `SL ${er.stopLossPct}%` : null,
    er.trailingStopPct != null ? `trail ${er.trailingStopPct}%` : null,
    er.hardTimeLimitSec != null ? `timer ${er.hardTimeLimitSec}s` : null,
    er.turboMode === true ? 'turbo' : null,
    er.maxTradeOverrideSol != null &&
    Number.isFinite(er.maxTradeOverrideSol) &&
    er.maxTradeOverrideSol > 0
      ? `override ${er.maxTradeOverrideSol} SOL`
      : er.sizeMultiplier != null && er.sizeMultiplier !== 1
        ? `size ×${er.sizeMultiplier}`
        : null,
  ]
    .filter(Boolean)
    .join(', ');
  console.log(
    `[trade-profiles] ASSIGN ${a.icon} ${a.name} (${a.profileId}) → ${sym}` +
      ` · score=${a.score.toFixed(1)} · ${a.reason}` +
      (exitBits ? ` · rules: ${exitBits}` : '') +
      (a.forced ? ' · FORCED' : '') +
      (a.autoScored ? ' · auto' : '') +
      (a.legacy ? ' · legacy' : '')
  );
}

export interface TradeProfileStamp {
  tradeProfileId: TradeProfileId;
  tradeProfileName: string;
  tradeProfileIcon: string;
  tradeProfileColor: string;
  tradeProfileScore?: number;
  tradeProfileReason?: string;
}

export function stampFromAssignment(
  a: TradeProfileAssignment
): TradeProfileStamp {
  return {
    tradeProfileId: a.profileId,
    tradeProfileName: a.name,
    tradeProfileIcon: a.icon,
    tradeProfileColor: a.color,
    tradeProfileScore: a.score,
    tradeProfileReason: a.reason,
  };
}

/** Buy-option fields written from profile exit rules (executeBuy → position). */
export interface ProfileExitBuyOpts {
  scalpMode?: boolean;
  shortTermStrategyId?: ShortTermStrategyId;
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
  /** Turbo Mode stamped from profile exitRules */
  profileTurboMode?: boolean;
  turboPriorityFeeMultiplier?: number;
  turboTipMultiplier?: number;
  turboSlippageBps?: number;
}

/**
 * Copy materialized profile exit rules onto buyOpts so simulateBuy /
 * registerLivePosition can freeze TP/SL/timer/forceScalp on the position.
 * When forceScalp is set, always overwrite shortTermStrategyId (mismatched
 * engines from resolveScalpBuyFlag must not stick).
 */
export function applyProfileExitRulesToBuyOpts(
  buyOpts: ProfileExitBuyOpts,
  er: TradeProfileExitRules | null | undefined
): void {
  if (!er) return;
  const rules = applyGlobalMicroBotTakeProfitToExitRules(er);
  if (rules.takeProfitPct != null) buyOpts.profileTakeProfitPct = rules.takeProfitPct;
  if (rules.stopLossPct != null) buyOpts.profileStopLossPct = rules.stopLossPct;
  if (rules.trailingStopPct != null) {
    buyOpts.profileTrailingStopPct = rules.trailingStopPct;
  }
  if (
    rules.trailingActivationProfit != null &&
    Number.isFinite(rules.trailingActivationProfit)
  ) {
    buyOpts.profileTrailingActivationProfit = rules.trailingActivationProfit;
  }
  if (rules.hardTimeLimitSec != null) {
    buyOpts.profileHardTimeLimitSec = rules.hardTimeLimitSec;
  }
  if (
    rules.momentumFailDropPct != null &&
    Number.isFinite(rules.momentumFailDropPct) &&
    rules.momentumFailDropPct > 0
  ) {
    buyOpts.profileMomentumFailDropPct = rules.momentumFailDropPct;
  }
  if (rules.overrideScalpParams) buyOpts.profileOverrideScalpParams = true;
  if (
    rules.deadVolumeMinHoldMinutes != null &&
    Number.isFinite(rules.deadVolumeMinHoldMinutes)
  ) {
    buyOpts.profileDeadVolumeMinHoldMinutes = rules.deadVolumeMinHoldMinutes;
  }
  if (rules.aggressiveDeadMarket) buyOpts.profileAggressiveDeadMarket = true;
  if (rules.turboMode === true) {
    buyOpts.profileTurboMode = true;
    if (
      rules.turboPriorityFeeMultiplier != null &&
      Number.isFinite(rules.turboPriorityFeeMultiplier) &&
      rules.turboPriorityFeeMultiplier > 0
    ) {
      buyOpts.turboPriorityFeeMultiplier = rules.turboPriorityFeeMultiplier;
    }
    if (
      rules.turboTipMultiplier != null &&
      Number.isFinite(rules.turboTipMultiplier) &&
      rules.turboTipMultiplier > 0
    ) {
      buyOpts.turboTipMultiplier = rules.turboTipMultiplier;
    }
    if (
      rules.turboSlippageBps != null &&
      Number.isFinite(rules.turboSlippageBps) &&
      rules.turboSlippageBps > 0
    ) {
      buyOpts.turboSlippageBps = Math.floor(rules.turboSlippageBps);
    }
  } else if (rules.turboMode === false) {
    buyOpts.profileTurboMode = false;
  }
  if (rules.forceScalp) {
    buyOpts.profileForceScalp = true;
    if (rules.shortTermStrategyId) {
      buyOpts.scalpMode = true;
      buyOpts.shortTermStrategyId = rules.shortTermStrategyId;
    }
  } else if (rules.forceScalp === false) {
    // Explicit clear — stop resolveScalpBuyFlag pollution (e.g. Dip Buyer
    // winning after post_migration_scalp was pre-tagged).
    buyOpts.profileForceScalp = false;
    buyOpts.scalpMode = false;
    if (
      buyOpts.shortTermStrategyId === 'post_migration_scalp' ||
      buyOpts.shortTermStrategyId === 'quick_scalper' ||
      buyOpts.shortTermStrategyId === 'micro_scalper' ||
      buyOpts.shortTermStrategyId === 'momentum_burst' ||
      buyOpts.shortTermStrategyId === 'reversal_scalp'
    ) {
      buyOpts.shortTermStrategyId = undefined;
    }
  }
}

/**
 * Apply profile exit overrides onto a freshly built position.
 * Scalp seed runs first when forced; then concrete TP/SL/timer overrides freeze.
 */
export function applyTradeProfileExitRules(
  position: {
    takeProfitPct: number;
    stopLossPct: number;
    trailingStopPct: number;
    trailingActivationProfit?: number;
    scalpMode?: boolean;
    shortTermStrategyId?: ShortTermStrategyId;
    scalpDeadlineMs?: number;
    scalpHardDeadlineMs?: number;
    scalpTpPct?: number;
    scalpSlPct?: number;
    scalpMomentumFailDropPct?: number;
    openedAt: number;
    deadVolumeMinHoldMinutes?: number;
    tradeProfileId?: string;
    profileExitPolicy?: import('./profileTradeIntelligence').ProfileExitPolicy;
    selfLearnVersion?: number;
    haExitEnabledAtOpen?: boolean;
    armedWatch?: boolean;
    entryStyle?: string;
    entryQualityScore?: number | null;
    qualityTier?: 'low' | 'medium' | 'high' | null;
  },
  rules: TradeProfileExitRules,
  seedShortTerm?: (
    id: ShortTermStrategyId,
    openedAt: number
  ) => Partial<{
    scalpMode: boolean;
    shortTermStrategyId: ShortTermStrategyId;
    scalpDeadlineMs: number;
    scalpHardDeadlineMs: number;
    scalpTpPct: number;
    scalpSlPct: number;
    scalpMomentumFailDropPct: number;
    takeProfitPct: number;
    stopLossPct: number;
  }>
): void {
  // Adaptive exit policy (catalog defaults ⊕ rules.exitPolicy)
  try {
    const { resolveExitPolicy } =
      require('./profileTradeIntelligence') as typeof import('./profileTradeIntelligence');
    const policy = resolveExitPolicy(position.tradeProfileId, rules, {
      armedWatch: position.armedWatch === true,
      entryStyle: position.entryStyle,
      entryQualityScore: position.entryQualityScore,
      qualityTier: position.qualityTier,
    });
    position.profileExitPolicy = policy;
    position.haExitEnabledAtOpen = policy.heikinAshiExitEnabled === true;
    if (policy.aggressiveDeadMarket && position.deadVolumeMinHoldMinutes == null) {
      position.deadVolumeMinHoldMinutes =
        rules.deadVolumeMinHoldMinutes != null
          ? Number(rules.deadVolumeMinHoldMinutes)
          : 2;
    }
  } catch {
    /* bootstrap */
  }
  // Stamp self-learn version for attribution
  try {
    if (position.tradeProfileId) {
      position.selfLearnVersion = getProfileSelfLearning(
        position.tradeProfileId
      ).version;
    }
  } catch {
    position.selfLearnVersion = 0;
  }
  // Stamp Learning Mode attribution (global ON + profile opted in)
  try {
    const { stampLearningModeFields } =
      require('./learningMode') as typeof import('./learningMode');
    const pid = position.tradeProfileId;
    if (pid && isProfileLearningModeOptedIn(pid)) {
      const lm = stampLearningModeFields();
      if (lm.learningMode) {
        (position as { learningMode?: boolean }).learningMode = true;
        (position as { learningStrictness?: string }).learningStrictness =
          lm.learningStrictness;
        (position as {
          learningFairnessApplied?: boolean;
        }).learningFairnessApplied = lm.learningFairnessApplied === true;
      }
    }
  } catch {
    /* ignore */
  }

  if (rules.forceScalp && rules.shortTermStrategyId && seedShortTerm) {
    // Always re-seed when the assigned profile wants a different engine.
    // Previously we kept an earlier scalpMode seed (e.g. post_migration_scalp)
    // even when Scalper profile required quick_scalper — causing wrong SL/timer labels
    // and instant exits on mismatched marks.
    if (
      !position.scalpMode ||
      position.shortTermStrategyId !== rules.shortTermStrategyId
    ) {
      Object.assign(
        position,
        seedShortTerm(rules.shortTermStrategyId, position.openedAt)
      );
    }
  } else if (rules.forceScalp === false) {
    // Dip Buyer / swing winners: strip polluted short scalp engines + timers
    position.scalpMode = false;
    if (
      position.shortTermStrategyId === 'post_migration_scalp' ||
      position.shortTermStrategyId === 'quick_scalper' ||
      position.shortTermStrategyId === 'micro_scalper' ||
      position.shortTermStrategyId === 'momentum_burst' ||
      position.shortTermStrategyId === 'reversal_scalp' ||
      (position.tradeProfileId === 'dip_buyer' &&
        String(position.shortTermStrategyId || '') !== 'post_run_dip')
    ) {
      position.shortTermStrategyId = undefined;
    }
    position.scalpDeadlineMs = undefined;
    position.scalpHardDeadlineMs = undefined;
    position.scalpSlPct = undefined;
    position.scalpTpPct = undefined;
  }

  // Belt-and-suspenders: Dip swing must never keep a migration scalp timer
  if (
    position.tradeProfileId === 'dip_buyer' &&
    String(position.shortTermStrategyId || '') !== 'post_run_dip'
  ) {
    position.scalpMode = false;
    position.shortTermStrategyId = undefined;
    position.scalpDeadlineMs = undefined;
    position.scalpHardDeadlineMs = undefined;
  }

  const exitRules = applyGlobalMicroBotTakeProfitToExitRules(rules);

  if (exitRules.takeProfitPct != null && Number.isFinite(exitRules.takeProfitPct)) {
    position.takeProfitPct = exitRules.takeProfitPct;
    if (
      position.scalpMode ||
      exitRules.overrideScalpParams ||
      getGlobalMicroBotTakeProfitPct() != null
    ) {
      position.scalpTpPct = exitRules.takeProfitPct;
    }
  }
  if (exitRules.stopLossPct != null && Number.isFinite(exitRules.stopLossPct)) {
    const sl = normalizeStopLossPct(exitRules.stopLossPct);
    position.stopLossPct = sl;
    if (position.scalpMode || exitRules.overrideScalpParams) {
      position.scalpSlPct = sl;
    }
  }
  if (exitRules.trailingStopPct != null && Number.isFinite(exitRules.trailingStopPct)) {
    position.trailingStopPct = exitRules.trailingStopPct;
  }
  if (
    exitRules.trailingActivationProfit != null &&
    Number.isFinite(exitRules.trailingActivationProfit) &&
    exitRules.trailingActivationProfit > 0
  ) {
    position.trailingActivationProfit = exitRules.trailingActivationProfit;
  }
  if (
    exitRules.momentumFailDropPct != null &&
    Number.isFinite(exitRules.momentumFailDropPct) &&
    exitRules.momentumFailDropPct > 0
  ) {
    position.scalpMomentumFailDropPct = Math.min(
      40,
      Number(exitRules.momentumFailDropPct)
    );
  }
  if (
    exitRules.hardTimeLimitSec != null &&
    Number.isFinite(exitRules.hardTimeLimitSec) &&
    exitRules.hardTimeLimitSec > 0 &&
    (position.scalpMode || exitRules.forceScalp)
  ) {
    position.scalpMode = true;
    const holdMs = Math.round(exitRules.hardTimeLimitSec) * 1000;
    position.scalpDeadlineMs = position.openedAt + holdMs;
    // Soft timer may defer a green trade; hard cap at 1.4× primary window
    position.scalpHardDeadlineMs = position.openedAt + Math.round(holdMs * 1.4);
  }
  if (
    (exitRules.aggressiveDeadMarket || exitRules.deadVolumeMinHoldMinutes != null) &&
    exitRules.deadVolumeMinHoldMinutes != null &&
    Number.isFinite(exitRules.deadVolumeMinHoldMinutes)
  ) {
    position.deadVolumeMinHoldMinutes = Math.max(
      0,
      Number(exitRules.deadVolumeMinHoldMinutes)
    );
  }
}

export function hydrateTradeProfilesFromSettings(
  saved: { tradeProfiles?: Partial<TradeProfileRuntimeState> } | null | undefined
): void {
  const prev = config.tradeProfiles as TradeProfileRuntimeState | undefined;
  const base = defaultRuntimeState();
  if (!saved?.tradeProfiles) {
    // Keep prior self-learning / overrides if a partial re-hydrate had no payload
    if (prev?.overrides) base.overrides = prev.overrides;
    if (prev?.selfLearning) base.selfLearning = prev.selfLearning;
    if (prev?.learningModeOptIn) base.learningModeOptIn = prev.learningModeOptIn;
    if (prev?.globalTakeProfit) {
      base.globalTakeProfit = normalizeGlobalMicroBotTakeProfit(
        prev.globalTakeProfit
      );
    }
    writeTradeProfilesState(base);
    return;
  }
  const s = saved.tradeProfiles;
  if (typeof s.enabled === 'boolean') base.enabled = s.enabled;
  if (typeof s.smartBotProfiles === 'boolean') {
    base.smartBotProfiles = s.smartBotProfiles;
  }
  if (s.profiles && typeof s.profiles === 'object') {
    const legacyMig = (s.profiles as Record<string, boolean>).migration;
    if (
      typeof legacyMig === 'boolean' &&
      typeof (s.profiles as Record<string, boolean>).migration_sniper !==
        'boolean'
    ) {
      (s.profiles as Record<string, boolean>).migration_sniper = legacyMig;
    }
    for (const id of ALL_IDS) {
      if (typeof s.profiles[id] === 'boolean') {
        base.profiles[id] = s.profiles[id]!;
      }
    }
  }
  if (s.overrides && typeof s.overrides === 'object') {
    // Deep-clone nested exitRules/match/modules so Max Trade Override etc. stick
    base.overrides = JSON.parse(JSON.stringify(s.overrides)) as Partial<
      Record<TradeProfileId, TradeProfileParamOverride>
    >;
  } else if (prev?.overrides) {
    base.overrides = prev.overrides;
  }
  if (s.autoScoring && typeof s.autoScoring === 'object') {
    base.autoScoring = normalizeAutoScoringConfig(s.autoScoring);
  }
  if (s.globalTakeProfit && typeof s.globalTakeProfit === 'object') {
    base.globalTakeProfit = normalizeGlobalMicroBotTakeProfit(s.globalTakeProfit);
  } else if (prev?.globalTakeProfit) {
    base.globalTakeProfit = normalizeGlobalMicroBotTakeProfit(prev.globalTakeProfit);
  }
  if (s.selfLearning && typeof s.selfLearning === 'object') {
    const {
      normalizeSelfLearning,
    } = require('./profileSelfLearning') as typeof import('./profileSelfLearning');
    base.selfLearning = {};
    for (const [id, raw] of Object.entries(s.selfLearning)) {
      if (!ALL_IDS.includes(id as TradeProfileId)) continue;
      base.selfLearning[id as TradeProfileId] = normalizeSelfLearning(
        raw as import('./profileSelfLearning').ProfileSelfLearningState
      );
    }
  } else if (prev?.selfLearning) {
    // Never drop learning state when caller omits the key (bake/import partials)
    base.selfLearning = prev.selfLearning;
  }
  if (s.learningModeOptIn && typeof s.learningModeOptIn === 'object') {
    base.learningModeOptIn = {};
    for (const [id, raw] of Object.entries(s.learningModeOptIn)) {
      if (!ALL_IDS.includes(id as TradeProfileId)) continue;
      base.learningModeOptIn[id as TradeProfileId] = raw === true;
    }
  } else if (prev?.learningModeOptIn) {
    base.learningModeOptIn = prev.learningModeOptIn;
  }
  base.profiles.default = true;
  migrateScalperMidbandCatalogDefaults(base);
  writeTradeProfilesState(base);
}

/**
 * One-shot: bump catalog-default Scalper/Migration/Reversal floors when user
 * overrides still equal the pre-midband catalog values (do not clobber customs).
 */
function migrateScalperMidbandCatalogDefaults(
  state: TradeProfileRuntimeState
): void {
  const ov = state.overrides || (state.overrides = {});
  const scalper = (ov.scalper ||= {});
  const sMatch = (scalper.match ||= {});
  if (sMatch.maxMarketCapUsd === 180_000) {
    sMatch.maxMarketCapUsd = 800_000;
  }
  if (sMatch.minMarketCapUsd == null && sMatch.maxMarketCapUsd === 800_000) {
    sMatch.minMarketCapUsd = 150_000;
  }
  const mig = (ov.migration_sniper ||= {});
  const mMatch = (mig.match ||= {});
  if (mMatch.maxMarketCapUsd === 175_000) {
    mMatch.maxMarketCapUsd = 150_000;
  }
  const rev = (ov.reversal_scalper ||= {});
  const rMatch = (rev.match ||= {});
  if (rMatch.maxMarketCapUsd == null) {
    rMatch.maxMarketCapUsd = 150_000;
  }
}

export function serializeTradeProfilesForPersist(): TradeProfileRuntimeState {
  return JSON.parse(JSON.stringify(ensureState())) as TradeProfileRuntimeState;
}

/**
 * Apply a learning suggestion patch (exit + match + optional entry tighten).
 * Never widens size above 1.2; respects existing override merge.
 */
export function applyTradeProfileLearning(
  profileId: TradeProfileId | string,
  suggestion: {
    patch?: {
      exitRules?: Partial<TradeProfileExitRules>;
      match?: Record<string, number | boolean>;
      pclFamilyOverride?: {
        family: 'fast' | 'dip_trend' | 'quality';
        permissionSec?: number;
        earlyPartialTpPct?: number;
      };
    };
    entryTighten?: Record<string, number | boolean>;
  }
): ReturnType<typeof getTradeProfilesStatus> {
  const { mergeLearningExitPatch } =
    require('./profileTradeIntelligence') as typeof import('./profileTradeIntelligence');
  const id = profileId as TradeProfileId;
  const resolved = resolveTradeProfileDefinition(id);
  const exitPatch = suggestion.patch?.exitRules
    ? mergeLearningExitPatch(resolved.exitRules, suggestion.patch.exitRules)
    : undefined;
  const matchPatch: Partial<TradeProfileMatchRules> = {
    ...(suggestion.patch?.match as Partial<TradeProfileMatchRules> | undefined),
    ...(suggestion.entryTighten as Partial<TradeProfileMatchRules> | undefined),
  };
  const status = updateTradeProfileParams(id, {
    exitRules: exitPatch,
    match: Object.keys(matchPatch).length ? matchPatch : undefined,
  });

  // Bounded PCL family override (permission / early partial) — ranking path only
  const fo = suggestion.patch?.pclFamilyOverride;
  if (fo && (fo.family === 'fast' || fo.family === 'dip_trend' || fo.family === 'quality')) {
    try {
      const {
        getProfitCaptureLayerConfig,
        setProfitCaptureLayerConfig,
        PCL_PERMISSION_SEC,
      } = require('./profitCaptureLayer') as typeof import('./profitCaptureLayer');
      const cur = getProfitCaptureLayerConfig();
      const prev = cur.familyOverrides?.[fo.family] || {};
      const basePerm =
        prev.permissionSec != null && Number.isFinite(Number(prev.permissionSec))
          ? Number(prev.permissionSec)
          : PCL_PERMISSION_SEC[fo.family];
      const nextOv: {
        permissionSec?: number;
        earlyPartialTpPct?: number;
      } = { ...prev };
      if (fo.permissionSec != null && Number.isFinite(Number(fo.permissionSec))) {
        const target = Number(fo.permissionSec);
        // ±10% step vs current family permission
        const lo = Math.max(20, Math.round(basePerm * 0.9));
        const hi = Math.min(180, Math.round(basePerm * 1.1));
        nextOv.permissionSec = Math.max(lo, Math.min(hi, Math.round(target)));
      }
      if (
        fo.earlyPartialTpPct != null &&
        Number.isFinite(Number(fo.earlyPartialTpPct))
      ) {
        const curPartial =
          prev.earlyPartialTpPct != null &&
          Number.isFinite(Number(prev.earlyPartialTpPct))
            ? Number(prev.earlyPartialTpPct)
            : 15;
        const target = Number(fo.earlyPartialTpPct);
        const lo = Math.max(8, Math.round(curPartial * 0.9));
        const hi = Math.min(60, Math.round(curPartial * 1.1));
        nextOv.earlyPartialTpPct = Math.max(lo, Math.min(hi, Math.round(target)));
      }
      setProfitCaptureLayerConfig({
        familyOverrides: {
          ...(cur.familyOverrides || {}),
          [fo.family]: nextOv,
        },
      });
    } catch {
      /* optional */
    }
  }

  return status;
}

/**
 * Auto-apply phase-4 entry tightenments for stabilized quality profiles
 * that are underperforming. Idempotent-ish (only raises floors).
 */
export function applyStabilizedQualityEntryTightenments(
  suggestions: Array<{
    profileId: string;
    entryTighten?: Record<string, number | boolean>;
  }>
): string[] {
  const applied: string[] = [];
  for (const s of suggestions) {
    if (!s.entryTighten) continue;
    if (
      s.profileId !== 'high_win_rate' &&
      s.profileId !== 'steady_compounder'
    ) {
      continue;
    }
    applyTradeProfileLearning(s.profileId, {
      entryTighten: s.entryTighten,
    });
    applied.push(s.profileId);
  }
  return applied;
}

export function getProfileSelfLearning(
  profileId: string
): import('./profileSelfLearning').ProfileSelfLearningState {
  const {
    normalizeSelfLearning,
    refreshSelfLearnMetrics,
  } = require('./profileSelfLearning') as typeof import('./profileSelfLearning');
  const state = ensureState();
  let sl = normalizeSelfLearning(
    state.selfLearning?.[profileId as TradeProfileId]
  );
  if (sl.enabled) sl = refreshSelfLearnMetrics(sl, profileId);
  return sl;
}

function writeProfileSelfLearning(
  profileId: TradeProfileId,
  sl: import('./profileSelfLearning').ProfileSelfLearningState,
  log?: {
    kind: import('./profileLearningSaveLog').LearningSaveKind;
    summary: string;
  }
): void {
  const state = ensureState();
  if (!state.selfLearning) state.selfLearning = {};
  state.selfLearning[profileId] = sl;
  persistUserSettings();
  try {
    const { saveTradeProfilesUserState } =
      require('./tradeProfilesUserStore') as typeof import('./tradeProfilesUserStore');
    saveTradeProfilesUserState(serializeTradeProfilesForPersist());
  } catch {
    /* optional second write */
  }
  if (log) {
    try {
      const { appendLearningSave } =
        require('./profileLearningSaveLog') as typeof import('./profileLearningSaveLog');
      appendLearningSave({
        profileId,
        kind: log.kind,
        summary: log.summary,
        version: sl.version,
      });
    } catch {
      /* optional journal */
    }
  }
}

/**
 * Seed every micro-bot (except Default) with self-learning ON when missing.
 * Does not flip profiles the user already explicitly disabled (enabled: false),
 * unless `forceEnableAll` is set (one-shot migration to default-ON).
 * Returns how many profiles were newly seeded / turned on.
 */
export function ensureSelfLearningDefaultsForAllProfiles(options?: {
  forceEnableUnset?: boolean;
  /** One-shot: turn ON even if previously stored as enabled:false (legacy default). */
  forceEnableAll?: boolean;
  persist?: boolean;
}): number {
  const {
    normalizeSelfLearning,
    DEFAULT_SELF_LEARNING,
  } = require('./profileSelfLearning') as typeof import('./profileSelfLearning');
  const state = ensureState();
  if (!state.selfLearning) state.selfLearning = {};
  let seeded = 0;
  const forceAll = options?.forceEnableAll === true;
  const forceUnset = options?.forceEnableUnset !== false;
  for (const id of ALL_IDS) {
    if (id === 'default' || id === 'migration') continue;
    const raw = state.selfLearning[id];
    const hasExplicit =
      raw &&
      typeof raw === 'object' &&
      Object.prototype.hasOwnProperty.call(raw, 'enabled');
    if (forceAll) {
      const wasOff = !hasExplicit || raw.enabled !== true;
      state.selfLearning[id] = normalizeSelfLearning({
        ...DEFAULT_SELF_LEARNING,
        ...(raw && typeof raw === 'object' ? raw : {}),
        enabled: true,
        mode:
          raw && typeof raw === 'object' && raw.mode === 'shadow'
            ? 'shadow'
            : 'auto',
      });
      if (wasOff) seeded += 1;
      continue;
    }
    if (hasExplicit) {
      // Keep explicit on/off; still normalize shape
      state.selfLearning[id] = normalizeSelfLearning(raw);
      continue;
    }
    if (!forceUnset && raw) {
      state.selfLearning[id] = normalizeSelfLearning(raw);
      continue;
    }
    state.selfLearning[id] = normalizeSelfLearning({
      ...DEFAULT_SELF_LEARNING,
      ...(raw && typeof raw === 'object' ? raw : {}),
      enabled: true,
      mode: 'auto',
    });
    seeded += 1;
  }
  if (seeded > 0 && options?.persist !== false) {
    persistUserSettings();
    try {
      const { saveTradeProfilesUserState } =
        require('./tradeProfilesUserStore') as typeof import('./tradeProfilesUserStore');
      saveTradeProfilesUserState(serializeTradeProfilesForPersist());
    } catch {
      /* optional */
    }
  }
  return seeded;
}

export function setProfileSelfLearningEnabled(
  profileId: TradeProfileId | string,
  enabled: boolean,
  mode?: 'shadow' | 'auto'
): ReturnType<typeof getTradeProfilesStatus> {
  const id = profileId as TradeProfileId;
  if (!ALL_IDS.includes(id) || id === 'default') {
    return getTradeProfilesStatus();
  }
  const {
    normalizeSelfLearning,
  } = require('./profileSelfLearning') as typeof import('./profileSelfLearning');
  const state = ensureState();
  const prev = normalizeSelfLearning(state.selfLearning?.[id]);
  const next = normalizeSelfLearning({
    ...prev,
    enabled: Boolean(enabled),
    mode:
      mode === 'auto' || mode === 'shadow'
        ? mode
        : prev.mode || 'auto',
  });
  writeProfileSelfLearning(id, next, {
    kind: 'toggle',
    summary: `Self-learning ${next.enabled ? 'ON' : 'OFF'} (${next.mode})`,
  });
  console.log(
    `[self-learn] ${id} ${next.enabled ? 'ON' : 'OFF'} mode=${next.mode}`
  );
  return getTradeProfilesStatus();
}

export function setProfileSelfLearningMlMode(
  profileId: TradeProfileId | string,
  mlMode: 'off' | 'shadow' | 'hybrid' | 'lead'
): ReturnType<typeof getTradeProfilesStatus> {
  const id = profileId as TradeProfileId;
  if (!ALL_IDS.includes(id) || id === 'default') {
    return getTradeProfilesStatus();
  }
  const {
    normalizeSelfLearning,
  } = require('./profileSelfLearning') as typeof import('./profileSelfLearning');
  const { normalizeMlMode } =
    require('./profileLearningMl') as typeof import('./profileLearningMl');
  const state = ensureState();
  const prev = normalizeSelfLearning(state.selfLearning?.[id]);
  const next = normalizeSelfLearning({
    ...prev,
    mlMode: normalizeMlMode(mlMode),
    mlModeSource: 'manual',
  });
  writeProfileSelfLearning(id, next, {
    kind: 'toggle',
    summary: `ML mode → ${next.mlMode} (manual)`,
  });
  return getTradeProfilesStatus();
}

/**
 * Raise-only lane floor suggestions from recent episode losers (soft hints for UI).
 * Never lowers floors automatically.
 */
export function buildLaneFloorLearningHints(
  profileId: TradeProfileId | string
): Array<{
  summary: string;
  field: string;
  current: number | null;
  suggested: number;
}> {
  const id = profileId as TradeProfileId;
  if (!ALL_IDS.includes(id) || id === 'default') return [];
  const { getProfileLearningEpisodes } =
    require('./profileLearningEpisodes') as typeof import('./profileLearningEpisodes');
  const eps = getProfileLearningEpisodes(id, 80);
  if (eps.length < 12) return [];
  const losers = eps.filter((e) => (e.pnlPct || 0) <= 0);
  if (losers.length < 5) return [];
  const def = resolveTradeProfileDefinition(id);
  const out: Array<{
    summary: string;
    field: string;
    current: number | null;
    suggested: number;
  }> = [];

  const lowMcLosers = losers.filter(
    (e) =>
      e.entryMarketCapUsd != null &&
      Number.isFinite(e.entryMarketCapUsd) &&
      e.entryMarketCapUsd > 0 &&
      e.entryMarketCapUsd < (def.match.minMarketCapUsd || def.match.preferMarketCapUsd || 50_000)
  );
  if (lowMcLosers.length / losers.length >= 0.4) {
    const cur = def.match.minMarketCapUsd || 0;
    const prefer = def.match.preferMarketCapUsd || cur;
    const suggested = Math.round(Math.max(cur, prefer * 0.85) * 1.15);
    if (suggested > cur) {
      out.push({
        summary: `${Math.round((lowMcLosers.length / losers.length) * 100)}% of losers below lane MC soft/hard — consider raising Min MC (raise-only)`,
        field: 'minMarketCapUsd',
        current: cur || null,
        suggested,
      });
    }
  }

  const lowConv = losers.filter(
    (e) => e.convictionScore != null && e.convictionScore < 45
  );
  if (lowConv.length / losers.length >= 0.4) {
    const cur = Number(def.match.minConviction) || 0;
    const suggested = Math.min(85, Math.max(cur + 5, 45));
    if (suggested > cur) {
      out.push({
        summary: `Weak-conviction losers (${lowConv.length}/${losers.length}) — raise min conviction (raise-only)`,
        field: 'minConviction',
        current: cur || null,
        suggested,
      });
    }
  }

  const lowWallets = losers.filter(
    (e) => e.walletCount != null && e.walletCount <= 1
  );
  if (lowWallets.length / losers.length >= 0.35) {
    const cur = Number(def.match.minWalletCount) || 1;
    const suggested = Math.min(5, Math.max(cur + 1, 2));
    if (suggested > cur) {
      out.push({
        summary: `Single-wallet losers (${lowWallets.length}/${losers.length}) — raise min wallet count (raise-only)`,
        field: 'minWalletCount',
        current: cur,
        suggested,
      });
    }
  }

  return out.slice(0, 3);
}

export function setProfileSelfLearningMinTrades(
  profileId: TradeProfileId | string,
  minTrades: number
): ReturnType<typeof getTradeProfilesStatus> {
  const id = profileId as TradeProfileId;
  if (!ALL_IDS.includes(id) || id === 'default') {
    return getTradeProfilesStatus();
  }
  const {
    normalizeSelfLearning,
  } = require('./profileSelfLearning') as typeof import('./profileSelfLearning');
  const state = ensureState();
  const prev = normalizeSelfLearning(state.selfLearning?.[id]);
  const next = normalizeSelfLearning({
    ...prev,
    minTrades: Math.max(6, Math.min(40, Math.round(Number(minTrades) || 8))),
  });
  writeProfileSelfLearning(id, next, {
    kind: 'min_trades',
    summary: `Min trades set to ${next.minTrades}`,
  });
  return getTradeProfilesStatus();
}

export function applyProfileSelfLearnProposal(
  profileId: TradeProfileId | string
): ReturnType<typeof getTradeProfilesStatus> {
  const id = profileId as TradeProfileId;
  const {
    normalizeSelfLearning,
    applySelfLearnUpgrade,
  } = require('./profileSelfLearning') as typeof import('./profileSelfLearning');
  const state = ensureState();
  const sl = normalizeSelfLearning(state.selfLearning?.[id]);
  const proposal = sl.pendingProposal;
  if (!proposal) return getTradeProfilesStatus();
  const prevOv = state.overrides?.[id]
    ? (JSON.parse(JSON.stringify(state.overrides[id])) as TradeProfileParamOverride)
    : null;
  applyTradeProfileLearning(id, {
    patch: proposal.patch as {
      exitRules?: Partial<TradeProfileExitRules>;
      match?: Record<string, number | boolean>;
    },
  });
  writeProfileSelfLearning(
    id,
    applySelfLearnUpgrade(sl, proposal, prevOv, { profileId: id }),
    {
      kind: 'upgrade',
      summary: String(proposal.summary || 'Applied self-learn upgrade').slice(
        0,
        200
      ),
    }
  );
  return getTradeProfilesStatus();
}

export function rejectProfileSelfLearnProposal(
  profileId: TradeProfileId | string
): ReturnType<typeof getTradeProfilesStatus> {
  const id = profileId as TradeProfileId;
  const {
    normalizeSelfLearning,
  } = require('./profileSelfLearning') as typeof import('./profileSelfLearning');
  const state = ensureState();
  const sl = normalizeSelfLearning(state.selfLearning?.[id]);
  sl.pendingProposal = null;
  writeProfileSelfLearning(id, sl);
  return getTradeProfilesStatus();
}

export function resetProfileSelfLearning(
  profileId: TradeProfileId | string,
  opts?: { wipeEpisodes?: boolean; resetParams?: boolean }
): ReturnType<typeof getTradeProfilesStatus> {
  const id = profileId as TradeProfileId;
  const {
    DEFAULT_SELF_LEARNING,
  } = require('./profileSelfLearning') as typeof import('./profileSelfLearning');
  if (opts?.resetParams) {
    resetTradeProfileParams(id);
  }
  if (opts?.wipeEpisodes) {
    const { clearProfileLearningEpisodes } =
      require('./profileLearningEpisodes') as typeof import('./profileLearningEpisodes');
    clearProfileLearningEpisodes(id);
  }
  writeProfileSelfLearning(id, {
    ...DEFAULT_SELF_LEARNING,
    history: [],
  }, {
    kind: 'reset',
    summary:
      'Reset learning' +
      (opts?.wipeEpisodes ? ' + wiped episodes' : '') +
      (opts?.resetParams ? ' + cleared params' : ''),
  });
  return getTradeProfilesStatus();
}

/**
 * After a final close — bump trade counters and run self-learn tick when enabled.
 */
export function onProfileTradeClosedForSelfLearn(profileId: string): void {
  const id = profileId as TradeProfileId;
  if (!ALL_IDS.includes(id) || id === 'default') return;
  try {
    const { maybeNudgeProfileTaFromEpisodes } =
      require('./profileTaPlaybookStore') as typeof import('./profileTaPlaybookStore');
    maybeNudgeProfileTaFromEpisodes(id);
  } catch {
    /* optional additive */
  }
  const {
    normalizeSelfLearning,
    runSelfLearnTick,
    applySelfLearnUpgrade,
    applySelfLearnMicro,
    refreshSelfLearnMetrics,
  } = require('./profileSelfLearning') as typeof import('./profileSelfLearning');
  const state = ensureState();
  let sl = normalizeSelfLearning(state.selfLearning?.[id]);
  if (!sl.enabled) return;
  sl.tradesSinceUpgrade = (sl.tradesSinceUpgrade || 0) + 1;
  sl.tradesSinceMicro = (sl.tradesSinceMicro || 0) + 1;
  sl = refreshSelfLearnMetrics(sl, id);

  const catalog = getTradeProfileDefinition(id);
  const resolved = resolveTradeProfileDefinition(id);
  const tick = runSelfLearnTick({
    profileId: id,
    state: sl,
    catalogExit: catalog.exitRules,
    catalogMatch: catalog.match,
    currentExit: resolved.exitRules,
    currentMatch: resolved.match,
  });
  sl = tick.state;

  if (tick.rollback) {
    // Multi-step rollback: pop from stack (fallback to previousOverrideSnapshot)
    const stack = Array.isArray(sl.previousOverrideStack)
      ? [...sl.previousOverrideStack]
      : [];
    const snap =
      stack.length > 0
        ? stack.pop()!
        : sl.previousOverrideSnapshot || null;
    if (snap) {
      if (!state.overrides) state.overrides = {};
      state.overrides[id] = JSON.parse(
        JSON.stringify(snap)
      ) as TradeProfileParamOverride;
    }
    sl.version = Math.max(0, sl.version - 1);
    sl.previousOverrideStack = stack;
    sl.previousOverrideSnapshot =
      stack.length > 0 ? stack[stack.length - 1]! : null;
    sl.tradesSinceUpgrade = 0;
    console.log(`[self-learn] ${id} rolled back to v${sl.version}`);
    writeProfileSelfLearning(id, sl, {
      kind: 'rollback',
      summary: `Rolled back to v${sl.version}`,
    });
    return;
  }

  if (tick.applyPatch && tick.applyKind === 'micro') {
    const proposal = sl.pendingProposal || {
      at: Date.now(),
      summary: 'Micro tweak',
      patch: tick.applyPatch,
      scoreBefore: 0,
      scoreAfter: 0,
      kind: 'exit' as const,
    };
    applyTradeProfileLearning(id, {
      patch: tick.applyPatch as {
        exitRules?: Partial<TradeProfileExitRules>;
        match?: Record<string, number | boolean>;
      },
    });
    sl = applySelfLearnMicro(sl, {
      ...proposal,
      patch: tick.applyPatch,
    });
    console.log(
      `[self-learn] ${id} micro v${sl.microVersion}: ${sl.lastMutation?.summary || ''}`
    );
    writeProfileSelfLearning(id, sl, {
      kind: 'micro',
      summary: sl.lastMutation?.summary || `Micro tweak m${sl.microVersion}`,
    });
    return;
  }

  if (tick.applyPatch && sl.pendingProposal) {
    const prevOv = state.overrides?.[id]
      ? (JSON.parse(
          JSON.stringify(state.overrides[id])
        ) as TradeProfileParamOverride)
      : null;
    applyTradeProfileLearning(id, {
      patch: tick.applyPatch as {
        exitRules?: Partial<TradeProfileExitRules>;
        match?: Record<string, number | boolean>;
      },
    });
    sl = applySelfLearnUpgrade(sl, sl.pendingProposal, prevOv, {
      profileId: id,
    });
    console.log(
      `[self-learn] ${id} auto-upgraded to v${sl.version}: ${sl.history[sl.history.length - 1]?.summary || ''}`
    );
    writeProfileSelfLearning(id, sl, {
      kind: 'upgrade',
      summary:
        sl.history[sl.history.length - 1]?.summary ||
        `Auto-upgraded to v${sl.version}`,
    });
    return;
  }

  writeProfileSelfLearning(id, sl);
}

/**
 * Manual evaluate against current episodes (e.g. after backup restore).
 * Shadow: may set pendingProposal only. Auto: may apply upgrade.
 * Bypasses upgrade cooldown so restored history can be re-checked.
 */
export function evaluateProfileSelfLearn(
  profileId: TradeProfileId | string
): {
  status: ReturnType<typeof getTradeProfilesStatus>;
  result:
    | 'disabled'
    | 'need_trades'
    | 'no_candidate'
    | 'proposal'
    | 'upgraded'
    | 'micro'
    | 'error';
  message: string;
  proposalSummary?: string;
  nearMiss?: import('./profileSelfLearning').SelfLearnNearMiss | null;
  lastMutation?: import('./profileSelfLearning').SelfLearnLastMutation | null;
  nextEligibleIn?: number;
  mlAdvice?: import('./profileLearningMl').MlAdvice | null;
  mlMode?: import('./profileLearningMl').MlLearnMode;
} {
  const id = profileId as TradeProfileId;
  if (!ALL_IDS.includes(id) || id === 'default') {
    return {
      status: getTradeProfilesStatus(),
      result: 'error',
      message: 'Invalid profile',
    };
  }
  const {
    normalizeSelfLearning,
    runSelfLearnTick,
    applySelfLearnUpgrade,
    applySelfLearnMicro,
    refreshSelfLearnMetrics,
    humanizeLearningPatch,
  } = require('./profileSelfLearning') as typeof import('./profileSelfLearning');
  const { getProfileLearningEpisodes } =
    require('./profileLearningEpisodes') as typeof import('./profileLearningEpisodes');

  const state = ensureState();
  let sl = normalizeSelfLearning(state.selfLearning?.[id]);
  const mlMeta = () => ({
    mlAdvice: sl.mlAdvice ?? null,
    mlMode: sl.mlMode || 'shadow',
  });
  if (!sl.enabled) {
    return {
      status: getTradeProfilesStatus(),
      result: 'disabled',
      message: 'Self-learning is OFF for this bot',
      nearMiss: sl.nearMiss,
      lastMutation: sl.lastMutation,
      nextEligibleIn: sl.nextEligibleIn,
      ...mlMeta(),
    };
  }

  const episodes = getProfileLearningEpisodes(id, 200);
  if (episodes.length < sl.minTrades) {
    return {
      status: getTradeProfilesStatus(),
      result: 'need_trades',
      message: `Need ${sl.minTrades - episodes.length} more closed trade(s) (min ${sl.minTrades}, have ${episodes.length}). Level counts applied upgrades — not episodes.`,
      nearMiss: sl.nearMiss,
      lastMutation: sl.lastMutation,
      nextEligibleIn: sl.nextEligibleIn,
      ...mlMeta(),
    };
  }

  sl = refreshSelfLearnMetrics(sl, id);
  // Bypass upgrade cooldown for manual checks (restore / user-triggered).
  // Do not force micro eligibility — micros apply on closes in auto mode.
  const tickState = normalizeSelfLearning({
    ...sl,
    tradesSinceUpgrade: Math.max(
      sl.tradesSinceUpgrade || 0,
      sl.upgradeCooldownTrades || 0
    ),
  });

  const catalog = getTradeProfileDefinition(id);
  const resolved = resolveTradeProfileDefinition(id);
  const tick = runSelfLearnTick({
    profileId: id,
    state: tickState,
    catalogExit: catalog.exitRules,
    catalogMatch: catalog.match,
    currentExit: resolved.exitRules,
    currentMatch: resolved.match,
  });
  sl = {
    ...tick.state,
    // Keep real counters from disk (don't invent closes).
    tradesSinceUpgrade: sl.tradesSinceUpgrade,
    tradesSinceMicro: sl.tradesSinceMicro,
  };

  if (tick.applyPatch && tick.applyKind === 'micro' && sl.pendingProposal) {
    applyTradeProfileLearning(id, {
      patch: tick.applyPatch as {
        exitRules?: Partial<TradeProfileExitRules>;
        match?: Record<string, number | boolean>;
      },
    });
    sl = applySelfLearnMicro(sl, {
      ...sl.pendingProposal,
      patch: tick.applyPatch,
    });
    writeProfileSelfLearning(id, sl, {
      kind: 'micro',
      summary: sl.lastMutation?.summary || `Micro tweak m${sl.microVersion}`,
    });
    return {
      status: getTradeProfilesStatus(),
      result: 'micro',
      message:
        sl.lastMutation?.summary ||
        `Applied micro tweak m${sl.microVersion} (Level unchanged)`,
      proposalSummary: sl.lastMutation?.summary,
      nearMiss: sl.nearMiss,
      lastMutation: sl.lastMutation,
      nextEligibleIn: sl.nextEligibleIn,
      ...mlMeta(),
    };
  }

  if (tick.applyPatch && sl.pendingProposal && tick.applyKind !== 'micro') {
    const prevOv = state.overrides?.[id]
      ? (JSON.parse(
          JSON.stringify(state.overrides[id])
        ) as TradeProfileParamOverride)
      : null;
    applyTradeProfileLearning(id, {
      patch: tick.applyPatch as {
        exitRules?: Partial<TradeProfileExitRules>;
        match?: Record<string, number | boolean>;
      },
    });
    sl = applySelfLearnUpgrade(sl, sl.pendingProposal, prevOv, {
      profileId: id,
    });
    writeProfileSelfLearning(id, sl, {
      kind: 'upgrade',
      summary:
        sl.history[sl.history.length - 1]?.summary ||
        `Upgraded to v${sl.version}`,
    });
    const last = sl.history[sl.history.length - 1];
    return {
      status: getTradeProfilesStatus(),
      result: 'upgraded',
      message: last?.summary || `Upgraded to Level ${sl.version}`,
      proposalSummary: last?.summary,
      nearMiss: null,
      lastMutation: sl.lastMutation,
      nextEligibleIn: sl.nextEligibleIn,
      ...mlMeta(),
    };
  }

  writeProfileSelfLearning(id, sl);
  if (sl.pendingProposal) {
    const changes = humanizeLearningPatch(sl.pendingProposal.patch);
    const delta =
      (sl.pendingProposal.scoreAfter || 0) - (sl.pendingProposal.scoreBefore || 0);
    return {
      status: getTradeProfilesStatus(),
      result: 'proposal',
      message:
        sl.pendingProposal.summary +
        (changes ? ` · ${changes}` : '') +
        ` · Δscore ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}` +
        ' — open the card and Apply to raise Level (Level = applied upgrades, not episodes)',
      proposalSummary: sl.pendingProposal.summary,
      nearMiss: sl.nearMiss,
      lastMutation: sl.lastMutation,
      nextEligibleIn: sl.nextEligibleIn,
      ...mlMeta(),
    };
  }

  const nm = sl.nearMiss;
  const nearLine = nm
    ? ` Near-miss: Δscore ${nm.scoreDelta >= 0 ? '+' : ''}${nm.scoreDelta.toFixed(2)} vs margin ${nm.scoreMargin.toFixed(2)} (need ${nm.needed.toFixed(2)} more) — ${nm.patternHint || nm.summary}`
    : ' No pattern cleared the softer score margin yet.';
  const lastLine = sl.lastMutation
    ? ` Last tweak (${sl.lastMutation.kind}${sl.lastMutation.source ? '/' + sl.lastMutation.source : ''}): ${sl.lastMutation.summary}`
    : '';
  const nextLine =
    sl.mode === 'auto'
      ? ` Next micro check in ${sl.nextEligibleIn} close(s).`
      : ' Mode is shadow — switch to auto for continuous micro-tweaks, or Apply proposals manually.';
  const mlLine = sl.mlAdvice?.summary ? ` ML: ${sl.mlAdvice.summary}` : '';

  return {
    status: getTradeProfilesStatus(),
    result: 'no_candidate',
    message:
      'No Level upgrade yet.' +
      nearLine +
      lastLine +
      nextLine +
      mlLine +
      ' Level counts applied upgrades — not episode count.',
    nearMiss: sl.nearMiss,
    lastMutation: sl.lastMutation,
    nextEligibleIn: sl.nextEligibleIn,
    ...mlMeta(),
  };
}

/**
 * One-shot: realign Trend Rider / Steady Compounder cluster gates with catalog
 * (scanner / Jupiter specialty handoffs are 1-wallet). Only rewrites the old
 * bake signature requireCluster:true + minWalletCount:2 — leaves intentional
 * custom cluster settings alone.
 */
export function migrateTrendCompounderClusterAlignV1(): boolean {
  const {
    hasSettingsMigration,
    completeSettingsMigration,
    persistUserSettings,
  } = require('./config') as typeof import('./config');
  const MIGRATION_ID = 'trScClusterAlign_v1';
  if (hasSettingsMigration(MIGRATION_ID)) return false;

  const state = ensureState();
  if (!state.overrides) state.overrides = {};

  const IDS = ['trend_rider', 'steady_compounder'] as const;
  let changed = 0;

  const patchMatch = (
    match: Record<string, unknown> | undefined
  ): boolean => {
    if (!match || typeof match !== 'object') return false;
    const req = match.requireCluster === true;
    const n = Number(match.minWalletCount);
    if (!req || !Number.isFinite(n) || Math.round(n) !== 2) return false;
    match.requireCluster = false;
    match.minWalletCount = 1;
    return true;
  };

  for (const id of IDS) {
    const ov = state.overrides[id];
    if (!ov?.match) continue;
    if (patchMatch(ov.match as Record<string, unknown>)) {
      changed += 1;
    }
  }

  try {
    const {
      loadTradeProfilesUserState,
      saveTradeProfilesUserState,
    } = require('./tradeProfilesUserStore') as typeof import('./tradeProfilesUserStore');
    const user = loadTradeProfilesUserState();
    if (user?.overrides) {
      let userChanged = false;
      for (const id of IDS) {
        const ov = user.overrides[id];
        if (!ov?.match) continue;
        if (patchMatch(ov.match as Record<string, unknown>)) {
          userChanged = true;
          changed += 1;
        }
      }
      if (userChanged) {
        saveTradeProfilesUserState({
          enabled: user.enabled,
          smartBotProfiles: user.smartBotProfiles,
          profiles: user.profiles,
          overrides: user.overrides,
          selfLearning: user.selfLearning,
          learningModeOptIn: user.learningModeOptIn,
        });
      }
    }
  } catch {
    /* optional */
  }

  writeTradeProfilesState(state);
  completeSettingsMigration(MIGRATION_ID);
  try {
    persistUserSettings();
  } catch {
    /* ignore */
  }
  if (changed > 0) {
    console.log(
      `[trade-profiles] Applied ${MIGRATION_ID} — Trend Rider / Steady Compounder cluster → off / minWallets 1 (${changed} patch(es))`
    );
  } else {
    console.log(
      `[trade-profiles] Applied ${MIGRATION_ID} — no old cluster bake signature found (feedPrefer bypass still active)`
    );
  }
  return changed > 0;
}

/**
 * One-shot: widen Trend Rider entry floors to catalog 1.5h / $75k when the user
 * still has the old bake signature (2h / $100k) and no other custom on those keys.
 */
export function migrateTrendEntryWidenV1105(): boolean {
  const {
    hasSettingsMigration,
    completeSettingsMigration,
    persistUserSettings,
  } = require('./config') as typeof import('./config');
  const MIGRATION_ID = 'trendEntryWiden_v1105';
  if (hasSettingsMigration(MIGRATION_ID)) return false;

  const state = ensureState();
  if (!state.overrides) state.overrides = {};

  const patchMatch = (
    match: Record<string, unknown> | undefined
  ): boolean => {
    if (!match || typeof match !== 'object') return false;
    let changed = false;
    const mc = Number(match.minMarketCapUsd);
    if (Number.isFinite(mc) && Math.round(mc) === 100_000) {
      match.minMarketCapUsd = 75_000;
      changed = true;
    }
    const age = Number(match.minTokenAgeHours);
    if (Number.isFinite(age) && Math.abs(age - 2) < 1e-9) {
      match.minTokenAgeHours = 1.5;
      changed = true;
    }
    return changed;
  };

  let changed = 0;
  const ov = state.overrides.trend_rider;
  if (ov?.match && patchMatch(ov.match as Record<string, unknown>)) {
    changed += 1;
  }

  try {
    const {
      loadTradeProfilesUserState,
      saveTradeProfilesUserState,
    } = require('./tradeProfilesUserStore') as typeof import('./tradeProfilesUserStore');
    const user = loadTradeProfilesUserState();
    if (user?.overrides?.trend_rider?.match) {
      if (
        patchMatch(user.overrides.trend_rider.match as Record<string, unknown>)
      ) {
        saveTradeProfilesUserState({
          enabled: user.enabled,
          smartBotProfiles: user.smartBotProfiles,
          profiles: user.profiles,
          overrides: user.overrides,
          selfLearning: user.selfLearning,
          learningModeOptIn: user.learningModeOptIn,
        });
        changed += 1;
      }
    }
  } catch {
    /* optional */
  }

  writeTradeProfilesState(state);
  completeSettingsMigration(MIGRATION_ID);
  try {
    persistUserSettings();
  } catch {
    /* ignore */
  }
  if (changed > 0) {
    console.log(
      `[trade-profiles] Applied ${MIGRATION_ID} — Trend Rider floors → 1.5h / $75k (${changed} patch(es))`
    );
  } else {
    console.log(
      `[trade-profiles] Applied ${MIGRATION_ID} — catalog defaults apply (no old 2h/$100k override)`
    );
  }
  return changed > 0;
}

/**
 * One-shot: pause bleeders (migration / reversal), favor dip size, tighten
 * scalper + momentum burst — based on Aug 2026 paper book (WR ~23%, migration PF ~0.1).
 */
export function migratePerformanceAllocV191(): boolean {
  const {
    hasSettingsMigration,
    completeSettingsMigration,
    persistUserSettings,
  } = require('./config') as typeof import('./config');
  const MIGRATION_ID = 'perfAlloc_v191';
  if (hasSettingsMigration(MIGRATION_ID)) return false;

  const state = ensureState();
  if (!state.profiles) state.profiles = {} as TradeProfileRuntimeState['profiles'];
  if (!state.overrides) state.overrides = {};

  state.profiles.migration_sniper = false;
  state.profiles.reversal_scalper = false;

  const mergeOv = (
    id: TradeProfileId,
    patch: TradeProfileParamOverride
  ): void => {
    const prev = state.overrides![id] || {};
    state.overrides![id] = {
      exitRules: { ...(prev.exitRules || {}), ...(patch.exitRules || {}) },
      match: { ...(prev.match || {}), ...(patch.match || {}) },
      modules: { ...(prev.modules || {}), ...(patch.modules || {}) },
    };
  };

  mergeOv('scalper', {
    exitRules: { sizeMultiplier: 0.45, maxTradeOverrideSol: 0.12 },
    match: { minConviction: 48, minWalletQuality: 40 },
  });
  mergeOv('dip_buyer', {
    exitRules: { sizeMultiplier: 1.25, maxTradeOverrideSol: 1.0 },
  });
  mergeOv('momentum_burst', {
    exitRules: { sizeMultiplier: 0.5, maxTradeOverrideSol: 0.25 },
    match: { minConviction: 55, minVolumeM5Usd: 8000, minWalletQuality: 40 },
  });
  mergeOv('migration_sniper', {
    exitRules: { sizeMultiplier: 0.7, maxTradeOverrideSol: 0.15 },
    match: { minConviction: 55, minWalletQuality: 45 },
  });
  mergeOv('reversal_scalper', {
    exitRules: {
      sizeMultiplier: 0.5,
      maxTradeOverrideSol: 0.12,
      hardTimeLimitSecMin: 90,
      hardTimeLimitSecMax: 240,
    },
    match: { minConviction: 42, minWalletQuality: 40 },
  });
  mergeOv('high_win_rate', {
    exitRules: { maxTradeOverrideSol: 1.0 },
  });

  try {
    const {
      loadTradeProfilesUserState,
      saveTradeProfilesUserState,
    } = require('./tradeProfilesUserStore') as typeof import('./tradeProfilesUserStore');
    const user = loadTradeProfilesUserState();
    if (user) {
      const nextProfiles = {
        ...(user.profiles || {}),
        migration_sniper: false,
        reversal_scalper: false,
      } as TradeProfileRuntimeState['profiles'];
      user.profiles = nextProfiles;
      user.overrides = {
        ...(user.overrides || {}),
        ...(state.overrides || {}),
      };
      saveTradeProfilesUserState({
        enabled: user.enabled,
        smartBotProfiles: user.smartBotProfiles,
        profiles: user.profiles,
        overrides: user.overrides,
        selfLearning: user.selfLearning,
        learningModeOptIn: user.learningModeOptIn,
      });
    }
  } catch {
    /* optional */
  }

  try {
    const { config: cfg } = require('./config') as typeof import('./config');
    if (cfg.filters && Number(cfg.filters.dailyLossLimitSol) > 0.5) {
      // Cap loose daily loss once at migration — never force when operator set 0 (off)
      cfg.filters.dailyLossLimitSol = 0.5;
    }
  } catch {
    /* ignore */
  }

  writeTradeProfilesState(state);
  completeSettingsMigration(MIGRATION_ID);
  try {
    persistUserSettings();
  } catch {
    /* ignore */
  }
  console.log(
    `[trade-profiles] Applied ${MIGRATION_ID} — paused migration_sniper + reversal_scalper; dip size↑; scalper/MB tightened; daily loss ≤0.5 SOL`
  );
  return true;
}

/**
 * Retune Migration Sniper to event lane: sweet-spot fire ~90%, no TA modules,
 * hold-through-migrate + spike exit, relax perfAlloc conviction floors.
 */
export function migrateMigSniperEventLaneV1(): boolean {
  const {
    hasSettingsMigration,
    completeSettingsMigration,
    persistUserSettings,
  } = require('./config') as typeof import('./config');
  const MIGRATION_ID = 'migSniperEventLane_v1';
  if (hasSettingsMigration(MIGRATION_ID)) return false;

  const state = ensureState();
  if (!state.profiles) state.profiles = {} as TradeProfileRuntimeState['profiles'];
  if (!state.overrides) state.overrides = {};

  state.profiles.migration_sniper = true;

  const prev = state.overrides.migration_sniper || {};
  state.overrides.migration_sniper = {
    exitRules: {
      ...(prev.exitRules || {}),
      sizeMultiplier: 0.7,
      maxTradeOverrideSol: 0.15,
      forceScalp: true,
      shortTermStrategyId: 'migration_event',
      overrideScalpParams: true,
      takeProfitPctMin: 10,
      takeProfitPctMax: 18,
      stopLossPctMin: 12,
      stopLossPctMax: 18,
      hardTimeLimitSecMin: 480,
      hardTimeLimitSecMax: 720,
      momentumFailDropPct: 0,
      trailingStopPct: 10,
      trailingActivationProfit: 12,
      turboMode: true,
    },
    match: {
      ...(prev.match || {}),
      minConviction: 22,
      minWalletQuality: 25,
      minCurveProgressPct: 90,
      maxCurveProgressPct: 99,
      gradWatchPct: 80,
      minBuyPressureUsd: 200,
      minVolumeH1Usd: 1_000,
      primaryPatternIds: [],
    },
    modules: {
      ...(prev.modules || {}),
      chart_patterns: false,
      pattern_bull_flag: false,
      volume_spike_filter: false,
      momentum_confirmation: false,
      post_migration_scalp: false,
      quick_scalper: false,
      migration_sniper: true,
    },
  };

  writeTradeProfilesState(state);
  completeSettingsMigration(MIGRATION_ID);
  try {
    persistUserSettings();
  } catch {
    /* ignore */
  }
  console.log(
    `[trade-profiles] Applied ${MIGRATION_ID} — Migration Sniper event lane (arm→hold→spike exit)`
  );
  return true;
}

/**
 * Widen Migration Sniper max MC when a persisted override still uses the old
 * ~$55k ceiling (rejects most mid-MC scanner names before Scalper/MB can win).
 * Match floors only — does not touch TP/SL/learning.
 */
export function migrateMigSniperWidenMaxMcV1(): boolean {
  const {
    hasSettingsMigration,
    completeSettingsMigration,
    persistUserSettings,
  } = require('./config') as typeof import('./config');
  const MIGRATION_ID = 'migSniperWidenMaxMc_v1';
  if (hasSettingsMigration(MIGRATION_ID)) return false;

  const TARGET_MAX_MC = 175_000;
  const state = ensureState();
  if (!state.overrides) state.overrides = {};

  const prev = state.overrides.migration_sniper || {};
  const curMax = Number(prev.match?.maxMarketCapUsd);
  const needsBump =
    !Number.isFinite(curMax) || curMax <= 0 || curMax < TARGET_MAX_MC;

  if (needsBump) {
    state.overrides.migration_sniper = {
      ...prev,
      match: {
        ...(prev.match || {}),
        maxMarketCapUsd: TARGET_MAX_MC,
        // Keep a sane lower bound if missing; do not raise an existing higher min.
        minMarketCapUsd:
          Number(prev.match?.minMarketCapUsd) > 0
            ? Number(prev.match?.minMarketCapUsd)
            : 17_500,
      },
    };
    writeTradeProfilesState(state);
  }

  completeSettingsMigration(MIGRATION_ID);
  try {
    persistUserSettings();
  } catch {
    /* ignore */
  }
  console.log(
    needsBump
      ? `[trade-profiles] Applied ${MIGRATION_ID} — Migration Sniper max MC → $${TARGET_MAX_MC}`
      : `[trade-profiles] Applied ${MIGRATION_ID} — max MC already ≥ $${TARGET_MAX_MC}`
  );
  return true;
}

/**
 * Re-apply $175k Migration Sniper max MC floor when override regresses
 * (backup restore / learning match patch) after v1 already completed.
 */
export function migrateMigSniperWidenMaxMcV2(): boolean {
  const {
    hasSettingsMigration,
    completeSettingsMigration,
    persistUserSettings,
  } = require('./config') as typeof import('./config');
  const MIGRATION_ID = 'migSniperWidenMaxMc_v2';
  if (hasSettingsMigration(MIGRATION_ID)) return false;

  const TARGET_MAX_MC = 175_000;
  const state = ensureState();
  if (!state.overrides) state.overrides = {};

  const prev = state.overrides.migration_sniper || {};
  const curMax = Number(prev.match?.maxMarketCapUsd);
  const needsBump =
    !Number.isFinite(curMax) || curMax <= 0 || curMax < TARGET_MAX_MC;

  if (needsBump) {
    state.overrides.migration_sniper = {
      ...prev,
      match: {
        ...(prev.match || {}),
        maxMarketCapUsd: TARGET_MAX_MC,
        minMarketCapUsd:
          Number(prev.match?.minMarketCapUsd) > 0
            ? Number(prev.match?.minMarketCapUsd)
            : 17_500,
      },
    };
    writeTradeProfilesState(state);
  }

  completeSettingsMigration(MIGRATION_ID);
  try {
    persistUserSettings();
  } catch {
    /* ignore */
  }
  console.log(
    needsBump
      ? `[trade-profiles] Applied ${MIGRATION_ID} — Migration Sniper max MC → $${TARGET_MAX_MC}`
      : `[trade-profiles] Applied ${MIGRATION_ID} — max MC already ≥ $${TARGET_MAX_MC}`
  );
  return true;
}

export function ensureTradeProfilesInitialized(): void {
  ensureState();
}
