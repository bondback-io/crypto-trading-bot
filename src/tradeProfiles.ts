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

import { config, persistUserSettings } from './config';
import type { ShortTermStrategyId } from './shortTermStrategies';
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

export type {
  AutoScoringConfig,
  AutoScoringWeights,
  ProfileScoreBreakdown,
} from './autoProfileScoring';
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
  | 'smart_money_mirror';

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
   * Aggressive dead-market exit: shorter min-hold before dead-volume can fire.
   * Frozen onto the position when set.
   */
  aggressiveDeadMarket?: boolean;
  deadVolumeMinHoldMinutes?: number;
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
  maxMarketCapUsd?: number;
  /** Prefer volume-spike entries (Scalper / Momentum) */
  preferVolumeSpike?: boolean;
  /** Prefer established tokens */
  minTokenAgeHours?: number;
  /**
   * Migration Sniper: max hours since launch/pair for a "fresh" graduation.
   * Older PumpSwap buys must not inherit Migration Sniper.
   */
  maxTokenAgeHours?: number;
  minHolders?: number;
  minVolumeH1Usd?: number;
  minVolumeM5Usd?: number;
  /** Dip / reversal: peak drop */
  minDropFromPeakPct?: number;
  maxDropFromPeakPct?: number;
  /** Dip: min prior run % (e.g. 80–120) */
  minPriceChange24hPct?: number;
  /** Dip: bonus when near Fib 0.5/0.618 or support */
  preferFibOrSupport?: boolean;
  /** Bonus when bullish chart patterns are active */
  preferBullishPatterns?: boolean;
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
}

/** Persisted user edits on top of official catalog defaults */
export type TradeProfileParamOverride = {
  exitRules?: Partial<TradeProfileExitRules>;
  match?: Partial<TradeProfileMatchRules>;
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
  },

  // ── 1. Scalper ───────────────────────────────────────────────────────────
  {
    id: 'scalper',
    name: 'Scalper',
    icon: '⚡',
    color: TRADE_PROFILE_COLORS.scalper,
    description:
      'Fast in-and-out trades on small MC tokens with tight risk.',
    recommendedRisk: 'High / Medium',
    style: 'Quick Scalp',
    rulesSummary: [
      'TP 18–30% · SL 7–12%',
      'Max hold 1–3.5 minutes · trail after +12%',
      'Smaller position size (~65%)',
      'Focus: small MC + volume spike',
      'Aggressive dead-market exit · early stall cut',
    ],
    priority: 80,
    defaultEnabled: true,
    match: {
      preferScalp: true,
      preferSmallMc: true,
      preferVolumeSpike: true,
      maxMarketCapUsd: 150_000,
      minVolumeM5Usd: 800,
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
    },
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
      'Min prior run +80–120% (max age ~12–24h)',
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
      minConviction: 40,
      minDropFromPeakPct: 12,
      minPriceChange24hPct: 80,
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
  },

  // ── Trend Rider (kept; Steady Compounder is the close sibling) ───────────
  {
    id: 'trend_rider',
    name: 'Trend Rider',
    icon: '▲',
    color: TRADE_PROFILE_COLORS.trend_rider,
    description:
      'Rides longer-lived tokens with holders and volume for steady continuation.',
    recommendedRisk: 'Low / Medium',
    style: 'Trend Hold',
    rulesSummary: [
      'Focuses on tokens that have been trading longer',
      'Prefers higher holders and volume',
      'Targets smaller consistent gains (5–12%)',
      'Tighter risk controls (~8% SL, ~6% trail)',
      'Allows longer hold times than Scalper (no hard timer)',
    ],
    priority: 55,
    defaultEnabled: true,
    match: {
      preferTrend: true,
      preferBullishPatterns: true,
      primaryPatternIds: [
        'structured_pullback',
        'bull_flag',
        'trend_continuation',
      ],
      secondaryPatternIds: ['volume_dryup_return'],
      avoidBearishPatterns: true,
      patternSensitivity: 'medium',
      minConviction: 50,
      minTokenAgeHours: 6,
      minHolders: 60,
      minVolumeH1Usd: 3_000,
    },
    exitRules: {
      forceScalp: false,
      takeProfitPctMin: 5,
      takeProfitPctMax: 12,
      stopLossPctMin: 6,
      stopLossPctMax: 9,
      trailingStopPct: 6,
      trailingActivationProfit: 5,
      sizeMultiplier: 1.0,
    },
  },

  // ── 3. Migration Sniper ──────────────────────────────────────────────────
  {
    id: 'migration_sniper',
    name: 'Migration Sniper',
    icon: '🚀',
    color: TRADE_PROFILE_COLORS.migration_sniper,
    description:
      'Only freshly graduated pump.fun → DEX migrations (not older PumpSwap trades).',
    recommendedRisk: 'High / Medium',
    style: 'Event / Momentum',
    rulesSummary: [
      'TP 25–45% · SL 10–15%',
      'Only fresh post-grad (≤2h / MC ≤$450K)',
      'Not for near-curve, early-buy, or mature DEX tokens',
      'Required: meaningful post-mig volume',
      'Hold: 1.5–7 min timer · trail arms at +15%',
      'Priority sizing (~1.15×) · early stall / fade exits',
    ],
    priority: 88,
    defaultEnabled: true,
    match: {
      preferMigration: true,
      preferSmartMoney: true,
      primaryPatternIds: ['bull_flag'],
      patternSensitivity: 'high',
      minVolumeH1Usd: 2_500,
      minConviction: 35,
      /** Fresh graduation window — older PumpSwap buys are not snipes */
      maxTokenAgeHours: 2,
      /** Mature / high-holder tokens belong to Trend / HWR / Dip */
      maxMarketCapUsd: 450_000,
    },
    exitRules: {
      takeProfitPctMin: 25,
      takeProfitPctMax: 45,
      stopLossPctMin: 10,
      stopLossPctMax: 15,
      trailingStopPct: 10,
      trailingActivationProfit: 15,
      hardTimeLimitSecMin: 90,
      hardTimeLimitSecMax: 420,
      momentumFailDropPct: 9,
      forceScalp: true,
      shortTermStrategyId: 'post_migration_scalp',
      overrideScalpParams: true,
      sizeMultiplier: 1.15,
    },
  },

  // ── 4. High Win-Rate ─────────────────────────────────────────────────────
  {
    id: 'high_win_rate',
    name: 'High Win-Rate',
    icon: '◎',
    color: TRADE_PROFILE_COLORS.high_win_rate,
    description:
      'Extremely selective setups focused on maximum win rate.',
    recommendedRisk: 'Low / Medium',
    style: 'High Quality',
    rulesSummary: [
      'TP 40–70%+ · SL 11–16%',
      'Min conviction 75+',
      'Min wallet quality 65%+',
      'Prefer 3+ quality wallets',
      'Quality Filter: higher MC / liq / volume / holders on technicals',
      'Very selective · smaller size',
    ],
    priority: 70,
    defaultEnabled: true,
    match: {
      preferHighWinRate: true,
      preferBullishPatterns: true,
      preferCleanPatterns: true,
      primaryPatternIds: [
        'volume_dryup_return',
        'falling_wedge',
        'structured_pullback',
      ],
      secondaryPatternIds: ['bull_flag', 'trend_continuation'],
      avoidBearishPatterns: true,
      patternSensitivity: 'low',
      patternMinConfidence: DEFAULT_HWR_QUALITY_FILTER.minPatternConfidence,
      patternRequireBreakout: true,
      patternRequireFibOrSupport: true,
      patternMinLiquidityUsd: DEFAULT_HWR_QUALITY_FILTER.minLiquidityUsd,
      patternMinHolders: DEFAULT_HWR_QUALITY_FILTER.minHolders,
      patternMinVolumeH1Usd: DEFAULT_HWR_QUALITY_FILTER.minVolumeH1Usd,
      patternMinMarketCapUsd: DEFAULT_HWR_QUALITY_FILTER.minMarketCapUsd,
      qualityFilter: { ...DEFAULT_HWR_QUALITY_FILTER },
      minConviction: 75,
      requireCluster: true,
      minWalletCount: 3,
      minWalletQuality: 65,
      preferSmartMoney: true,
    },
    exitRules: {
      takeProfitPctMin: 40,
      takeProfitPctMax: 70,
      stopLossPctMin: 11,
      stopLossPctMax: 16,
      trailingStopPct: 10,
      trailingActivationProfit: 22,
      sizeMultiplier: 0.7,
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
      'Entry: strong volume acceleration + buy dominance',
      'Max hold ~2.5–7 min · trail after +10%',
      'Exit on fade / stall / trail — timer is backstop',
    ],
    priority: 82,
    defaultEnabled: true,
    match: {
      preferMomentumBurst: true,
      preferVolumeSpike: true,
      primaryPatternIds: ['bull_flag'],
      patternSensitivity: 'high',
      patternMinConfidence: 48,
      minVolumeM5Usd: 1_500,
      minConviction: 40,
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
    },
  },

  // ── 6. Steady Compounder ─────────────────────────────────────────────────
  {
    id: 'steady_compounder',
    name: 'Steady Compounder',
    icon: '◇',
    color: TRADE_PROFILE_COLORS.steady_compounder,
    description:
      'Small consistent gains on more established tokens.',
    recommendedRisk: 'Low / Medium',
    style: 'Steady / Compounding',
    rulesSummary: [
      'TP 5–10% · SL 4–7%',
      'Focus: higher holders + sustained volume',
      'Patient but disciplined · no hard timer',
      'Small consistent gains',
    ],
    priority: 50,
    defaultEnabled: true,
    match: {
      preferSteadyCompounder: true,
      preferBullishPatterns: true,
      primaryPatternIds: ['volume_dryup_return', 'trend_continuation'],
      secondaryPatternIds: ['structured_pullback'],
      avoidBearishPatterns: true,
      patternSensitivity: 'medium',
      patternMinConfidence: 58,
      minConviction: 45,
      minTokenAgeHours: 18,
      minHolders: 120,
      minVolumeH1Usd: 8_000,
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
    },
  },

  // ── 7. Reversal Scalper ──────────────────────────────────────────────────
  {
    id: 'reversal_scalper',
    name: 'Reversal Scalper',
    icon: '↺',
    color: TRADE_PROFILE_COLORS.reversal_scalper,
    description:
      'Quick mean-reversion on sharp wicks and over-extensions.',
    recommendedRisk: 'High',
    style: 'Mean Reversion',
    rulesSummary: [
      'TP 15–25% · SL 6–10%',
      'Entry: sharp wick / over-extension',
      'Max hold 1–2.5 minutes · trail after +10%',
      'Fast mean-reversion · early stall cut',
    ],
    priority: 83,
    defaultEnabled: true,
    match: {
      preferReversal: true,
      primaryPatternIds: ['falling_wedge'],
      patternSensitivity: 'high',
      patternMinConfidence: 48,
      minDropFromPeakPct: 18,
      minConviction: 35,
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
      hardTimeLimitSecMin: 50,
      hardTimeLimitSecMax: 160,
      momentumFailDropPct: 8,
      sizeMultiplier: 0.7,
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
      'Need 3+ wallets or strong quality + conviction',
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
      patternMinConfidence: 55,
      minWalletCount: 3,
      requireCluster: true,
      preferSmartMoney: true,
      minWalletQuality: 58,
      minConviction: 52,
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
  },
] as const;

export interface TradeProfileRuntimeState {
  enabled: boolean;
  profiles: Record<TradeProfileId, boolean>;
  /** User edits on top of official catalog defaults (per profile) */
  overrides?: Partial<Record<TradeProfileId, TradeProfileParamOverride>>;
  /** Automatic profile scoring (weights, threshold, force override) */
  autoScoring?: AutoScoringConfig;
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
  scalpMode?: boolean;
  shortTermStrategyId?: string | null;
  convictionScore?: number | null;
  dropFromPeakPct?: number | null;
  strategyKind?: 'migration' | 'normal';
  symbol?: string;
  marketCapUsd?: number | null;
  holderCount?: number | null;
  volumeH1Usd?: number | null;
  volumeM5Usd?: number | null;
  recentBuyVolumeUsd?: number | null;
  tokenAgeHours?: number | null;
  priceChange24hPct?: number | null;
  priceChangeH1Pct?: number | null;
  nearKeyFib?: boolean;
  nearSupport?: boolean;
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
  return out;
}

function mergeExitRules(
  base: TradeProfileExitRules,
  overlay?: Partial<TradeProfileExitRules> | null
): TradeProfileExitRules {
  if (!overlay) return { ...base };
  return { ...base, ...overlay };
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
        (ov.match && Object.keys(ov.match).length > 0))
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
    profiles,
    overrides: {},
    autoScoring: { ...DEFAULT_AUTO_SCORING, weights: { ...DEFAULT_AUTO_SCORING.weights } },
  };
}

function ensureState(): TradeProfileRuntimeState {
  const existing = config.tradeProfiles;
  if (!existing || typeof existing !== 'object') {
    const fresh = defaultRuntimeState();
    writeTradeProfilesState(fresh);
    return fresh;
  }

  const enabled =
    typeof existing.enabled === 'boolean' ? existing.enabled : true;
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

  const state: TradeProfileRuntimeState = {
    enabled,
    profiles: profiles as Record<TradeProfileId, boolean>,
    overrides,
    autoScoring,
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

export function getTradeProfilesStatus(): {
  enabled: boolean;
  profiles: Array<
    TradeProfileDefinition & {
      enabled: boolean;
      active: boolean;
      hasOverrides: boolean;
      officialExitRules: TradeProfileExitRules;
      officialMatch: TradeProfileMatchRules;
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
  const profiles = TRADE_PROFILE_CATALOG.map((p) => {
    const resolved = resolveTradeProfileDefinition(p.id);
    return {
      ...resolved,
      enabled: state.profiles[p.id] !== false,
      active: state.enabled && state.profiles[p.id] !== false,
      officialExitRules: { ...p.exitRules },
      officialMatch: { ...p.match },
    };
  });
  return {
    enabled: state.enabled,
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
  profiles?: Partial<Record<TradeProfileId, boolean>>;
}): ReturnType<typeof getTradeProfilesStatus> {
  const state = ensureState();
  if (partial.enabled != null) state.enabled = Boolean(partial.enabled);
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
    }
  }
  for (const [k, v] of Object.entries(nextMatch)) {
    if (k === 'qualityFilter') continue;
    if (v == null || (typeof v === 'number' && !Number.isFinite(v))) {
      delete (nextMatch as Record<string, unknown>)[k];
    }
  }
  state.overrides[id] = {
    exitRules: nextExit,
    match: nextMatch,
  };
  persistUserSettings();
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

/** Default freshness gates for Migration Sniper (pump.fun → DEX grads only). */
export const FRESH_MIGRATION_MAX_AGE_HOURS = 2;
export const FRESH_MIGRATION_MAX_MC_USD = 450_000;

/**
 * True only for freshly graduated migrations — not older PumpSwap venue trades,
 * not near-curve, not early-buy alone.
 *
 * PumpSwap buys set isMigration on the wire forever. Age/MC alone is NOT enough
 * (young PumpSwap copies were over-assigned to Migration Sniper). Require an
 * explicit migrationFresh signal (listener TTL / backtest fresh-grad proxy),
 * then apply age + MC caps as additional filters.
 */
export function evaluateFreshMigrationEligibility(
  ctx: TradeProfileMatchContext,
  rules?: Pick<TradeProfileMatchRules, 'maxTokenAgeHours' | 'maxMarketCapUsd'>
): { ok: boolean; reason: string } {
  if (ctx.isMigration !== true) {
    if (ctx.nearMigration === true) {
      return {
        ok: false,
        reason: 'near-migration (pre-DEX) — not Migration Sniper',
      };
    }
    if (ctx.earlyBuy === true) {
      return {
        ok: false,
        reason: 'early curve buy — not a graduated migration',
      };
    }
    if (ctx.strategyKind === 'migration') {
      return {
        ok: false,
        reason: 'migration strategyKind without post-grad flag',
      };
    }
    return { ok: false, reason: 'not a graduated migration' };
  }

  // Hard gate: venue/isMigration alone never qualifies — need a fresh-grad stamp
  if (ctx.migrationFresh !== true) {
    return {
      ok: false,
      reason: 'PumpSwap / migrated venue without recent migration event',
    };
  }

  const maxAgeH =
    rules?.maxTokenAgeHours != null && Number.isFinite(rules.maxTokenAgeHours)
      ? Number(rules.maxTokenAgeHours)
      : FRESH_MIGRATION_MAX_AGE_HOURS;
  const maxMc =
    rules?.maxMarketCapUsd != null && Number.isFinite(rules.maxMarketCapUsd)
      ? Number(rules.maxMarketCapUsd)
      : FRESH_MIGRATION_MAX_MC_USD;

  const ageH =
    ctx.tokenAgeHours != null && Number.isFinite(ctx.tokenAgeHours)
      ? Number(ctx.tokenAgeHours)
      : null;
  const mc =
    ctx.marketCapUsd != null && Number.isFinite(ctx.marketCapUsd)
      ? Number(ctx.marketCapUsd)
      : null;

  if (ageH != null && ageH > maxAgeH) {
    return {
      ok: false,
      reason: `stale migration age ${ageH.toFixed(1)}h > ${maxAgeH}h`,
    };
  }
  if (mc != null && mc > maxMc) {
    return {
      ok: false,
      reason: `MC $${Math.round(mc)} too mature for Migration Sniper (max $${maxMc})`,
    };
  }

  return { ok: true, reason: 'fresh post-grad migration' };
}

/** Soft category: fresh mig only — stale DEX tokens must compete as trend/dip/HWR. */
export function isFreshMigrationContext(
  ctx: TradeProfileMatchContext
): boolean {
  return evaluateFreshMigrationEligibility(ctx).ok;
}

function scoreProfile(
  def: TradeProfileDefinition,
  ctx: TradeProfileMatchContext
): { score: number; reason: string } {
  const m = def.match;
  let score = 0;
  const bits: string[] = [];

  const conv =
    ctx.convictionScore != null && Number.isFinite(ctx.convictionScore)
      ? Number(ctx.convictionScore)
      : null;
  if (m.minConviction != null && (conv == null || conv < m.minConviction)) {
    return { score: 0, reason: `conviction < ${m.minConviction}` };
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
  const volM5 =
    ctx.volumeM5Usd != null && Number.isFinite(ctx.volumeM5Usd)
      ? Number(ctx.volumeM5Usd)
      : ctx.recentBuyVolumeUsd != null && Number.isFinite(ctx.recentBuyVolumeUsd)
        ? Number(ctx.recentBuyVolumeUsd)
        : null;
  const ageH =
    ctx.tokenAgeHours != null && Number.isFinite(ctx.tokenAgeHours)
      ? Number(ctx.tokenAgeHours)
      : null;
  const chg24 =
    ctx.priceChange24hPct != null && Number.isFinite(ctx.priceChange24hPct)
      ? Number(ctx.priceChange24hPct)
      : null;
  const drop =
    ctx.dropFromPeakPct != null && Number.isFinite(ctx.dropFromPeakPct)
      ? Number(ctx.dropFromPeakPct)
      : null;
  const wallets =
    ctx.walletCount != null && Number.isFinite(ctx.walletCount)
      ? Number(ctx.walletCount)
      : null;

  const isDip =
    ctx.shortTermStrategyId === 'post_run_dip' ||
    (drop != null &&
      drop >= (m.minDropFromPeakPct ?? 12) &&
      !m.preferReversal);
  const isScalp =
    ctx.scalpMode === true &&
    ctx.shortTermStrategyId != null &&
    ctx.shortTermStrategyId !== 'post_run_dip';
  // Only FRESH grads count as migration for profile routing.
  // Older PumpSwap venue trades must not block Trend / HWR / Dip.
  const freshMig = evaluateFreshMigrationEligibility(ctx, {
    maxTokenAgeHours: m.maxTokenAgeHours ?? FRESH_MIGRATION_MAX_AGE_HOURS,
    maxMarketCapUsd: m.maxMarketCapUsd ?? FRESH_MIGRATION_MAX_MC_USD,
  });
  const isMig = freshMig.ok;
  const isMomentum =
    ctx.shortTermStrategyId === 'momentum_burst' ||
    (volM5 != null &&
      m.minVolumeM5Usd != null &&
      volM5 >= m.minVolumeM5Usd &&
      !isDip &&
      !isMig);
  const isReversal =
    ctx.shortTermStrategyId === 'reversal_scalp' ||
    (Boolean(m.preferReversal) &&
      drop != null &&
      drop >= (m.minDropFromPeakPct ?? 18));

  if (m.requireCluster && m.minWalletCount != null) {
    if (wallets != null && wallets < m.minWalletCount) {
      return {
        score: 0,
        reason: `cluster ${wallets} < ${m.minWalletCount} wallets`,
      };
    }
  }

  if (m.preferDip) {
    if (!isDip) return { score: 0, reason: 'not a dip setup' };
    // Fresh migrations belong to Migration Sniper, not Dip Buyer
    if (isMig) return { score: 0, reason: 'defer to fresh migration' };
    score += 100;
    bits.push('dip setup');
    if (ctx.shortTermStrategyId === 'post_run_dip') {
      score += 25;
      bits.push('post_run_dip');
    }
    const strongRun =
      (chg24 != null && chg24 >= (m.minPriceChange24hPct ?? 12)) ||
      (drop != null && drop >= (m.minDropFromPeakPct ?? 12));
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
    if (volH1 != null && volH1 >= 2000) {
      score += 8;
      bits.push('volume confirm');
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
    // Hard gate: Scalper is for small-MC only when preferSmallMc is set
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
      score += 88;
      bits.push(`scalp:${ctx.shortTermStrategyId}`);
      if (
        m.preferVolumeSpike &&
        volM5 != null &&
        volM5 >= (m.minVolumeM5Usd ?? 800)
      ) {
        score += 12;
        bits.push(`vol spike M5 $${Math.round(volM5)}`);
      }
    } else if (smallMc && !isDip && !isMig && !isMomentum && !isReversal) {
      // Untagged small-MC candidate (multi-profile path) — competitive but not automatic winner
      score += 62;
      bits.push(`small-MC scalp candidate $${Math.round(mc!)}`);
      if (
        m.preferVolumeSpike &&
        volM5 != null &&
        volM5 >= (m.minVolumeM5Usd ?? 800)
      ) {
        score += 14;
        bits.push('volume spike');
      } else if (volM5 == null && volH1 != null && volH1 >= 1_500) {
        score += 6;
        bits.push('vol1h confirm');
      }
    } else {
      return { score: 0, reason: 'not a scalp / small-MC setup' };
    }
  }

  if (m.preferMigration) {
    if (!freshMig.ok) {
      return { score: 0, reason: freshMig.reason };
    }
    score += 90;
    bits.push('fresh post-grad migration');
    if (ageH != null) {
      bits.push(`age ${ageH.toFixed(2)}h`);
    }
    if (mc != null) {
      bits.push(`MC $${Math.round(mc)}`);
    }
    if (ctx.migrationFresh === true) {
      score += 8;
      bits.push('recent migration event');
    }
    if (volH1 != null && volH1 >= (m.minVolumeH1Usd ?? 2000)) {
      score += 12;
      bits.push(`vol $${Math.round(volH1)}`);
    } else if (
      volH1 != null &&
      m.minVolumeH1Usd != null &&
      volH1 < m.minVolumeH1Usd
    ) {
      score -= 15;
      bits.push('low migration volume');
    }
    if (
      m.preferSmartMoney &&
      ctx.smartMoneyScore != null &&
      ctx.smartMoneyScore >= 35
    ) {
      score += 12;
      bits.push(`SM ${ctx.smartMoneyScore}`);
    }
  }

  if (m.preferMomentumBurst) {
    if (ctx.shortTermStrategyId === 'momentum_burst') {
      score += 95;
      bits.push('momentum_burst armed');
    } else if (isMomentum && !isDip && !isMig) {
      score += 70;
      bits.push(
        volM5 != null
          ? `burst vol M5 $${Math.round(volM5)}`
          : 'momentum pressure'
      );
    } else {
      return { score: 0, reason: 'not a momentum burst setup' };
    }
  }

  if (m.preferReversal) {
    if (ctx.shortTermStrategyId === 'reversal_scalp') {
      score += 95;
      bits.push('reversal_scalp armed');
    } else if (drop != null && drop >= (m.minDropFromPeakPct ?? 18) && !isMig) {
      score += 72;
      bits.push(`wick/over-extension −${drop.toFixed(0)}%`);
    } else {
      return { score: 0, reason: 'not a reversal / wick setup' };
    }
  }

  if (m.preferTrend) {
    if (isScalp || isDip || isMig || isMomentum || isReversal) {
      return { score: 0, reason: 'not a trend hold setup' };
    }
    if (conv == null || conv < (m.minConviction ?? 50)) {
      return { score: 0, reason: 'conviction too low for trend' };
    }
    let quality = 0;
    // Established MC tokens can qualify earlier than pure age floors
    const ageFloor =
      mc != null && mc >= 300_000
        ? Math.min(m.minTokenAgeHours ?? 6, 1)
        : (m.minTokenAgeHours ?? 6);
    if (m.minTokenAgeHours != null) {
      if (ageH != null && ageH >= ageFloor) {
        quality += 1;
        bits.push(`age ${ageH.toFixed(1)}h`);
      } else if (ageH != null && ageH < ageFloor) {
        return { score: 0, reason: `token too young (${ageH.toFixed(1)}h)` };
      }
    }
    if (m.minHolders != null) {
      if (holders != null && holders >= m.minHolders) {
        quality += 1;
        bits.push(`${holders} holders`);
      } else if (holders != null && holders < m.minHolders) {
        return { score: 0, reason: `holders ${holders} < ${m.minHolders}` };
      }
    }
    if (m.minVolumeH1Usd != null) {
      if (volH1 != null && volH1 >= m.minVolumeH1Usd) {
        quality += 1;
        bits.push(`1h vol $${Math.round(volH1)}`);
      } else if (volH1 != null && volH1 < m.minVolumeH1Usd) {
        return {
          score: 0,
          reason: `1h vol $${Math.round(volH1)} < $${m.minVolumeH1Usd}`,
        };
      }
    }
    score += 50 + Math.min(35, (conv - 50) * 0.7) + quality * 8;
    bits.push(`trend conviction ${conv}`);
    if (mc != null && mc >= 300_000) {
      score += 14;
      bits.push(`established MC $${Math.round(mc)}`);
    }
  }

  if (m.preferSteadyCompounder) {
    if (isScalp || isDip || isMig || isMomentum || isReversal) {
      return { score: 0, reason: 'not a compounder setup' };
    }
    if (conv == null || conv < (m.minConviction ?? 45)) {
      return { score: 0, reason: 'conviction too low for compounder' };
    }
    const ageFloor =
      mc != null && mc >= 300_000
        ? Math.min(m.minTokenAgeHours ?? 8, 1.5)
        : (m.minTokenAgeHours ?? 8);
    if (m.minTokenAgeHours != null && ageH != null && ageH < ageFloor) {
      return { score: 0, reason: `token too young (${ageH.toFixed(1)}h)` };
    }
    if (m.minHolders != null && holders != null && holders < m.minHolders) {
      return { score: 0, reason: `holders ${holders} < ${m.minHolders}` };
    }
    if (m.minVolumeH1Usd != null && volH1 != null && volH1 < m.minVolumeH1Usd) {
      return {
        score: 0,
        reason: `1h vol $${Math.round(volH1)} < $${m.minVolumeH1Usd}`,
      };
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
    score += 48 + Math.min(25, (conv - 45) * 0.5) + q * 10;
    bits.push(`compounder conviction ${conv}`);
    if (mc != null && mc >= 300_000) {
      score += 10;
      bits.push(`established MC $${Math.round(mc)}`);
    }
  }

  if (m.preferSmartMoneyMirror) {
    if (ctx.scannerOrigin && ctx.entrySource === 'scanner') {
      return { score: 0, reason: 'scanner-only — prefer TA profiles' };
    }
    if (isMig) return { score: 0, reason: 'defer to fresh migration' };
    if (isScalp || isDip || isMomentum || isReversal) {
      return { score: 0, reason: 'not a clean copy / mirror setup' };
    }
    if (conv == null || conv < (m.minConviction ?? 52)) {
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
        (m.minWalletQuality != null && wqEarly < m.minWalletQuality)
      ) {
        return { score: 0, reason: 'need wallet convergence' };
      }
    }
    const wq =
      ctx.walletQualityAvg != null && Number.isFinite(ctx.walletQualityAvg)
        ? Number(ctx.walletQualityAvg)
        : null;
    if (m.minWalletQuality != null && wq != null && wq < m.minWalletQuality) {
      return {
        score: 0,
        reason: `wallet quality ${wq.toFixed(0)} < ${m.minWalletQuality}`,
      };
    }
    // Unknown WQ in BT: demand higher conviction + cluster
    if (wq == null && (conv < 58 || (wallets != null && wallets < 3))) {
      return {
        score: 0,
        reason: 'mirror needs WQ or 3+ wallets + conviction 58+',
      };
    }
    score += 58 + Math.min(25, (conv - 52) * 0.6);
    bits.push(`mirror conviction ${conv}`);
    if (clusterOk) {
      score += 18;
      bits.push(`${wallets} wallets`);
    } else if (wallets != null && wallets >= 2) {
      score += 8;
      bits.push(`${wallets} wallets (quality OK)`);
    }
    if (wq != null && (m.minWalletQuality == null || wq >= m.minWalletQuality)) {
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
    if (isScalp || isDip || isMomentum || isReversal) {
      return { score: 0, reason: 'not high-win-rate selective' };
    }
    if (conv == null || conv < (m.minConviction ?? 75)) {
      return { score: 0, reason: 'conviction too low' };
    }
    if (
      m.requireCluster &&
      wallets != null &&
      wallets < (m.minWalletCount ?? 3)
    ) {
      return { score: 0, reason: 'need cluster for high win-rate' };
    }
    const wq =
      ctx.walletQualityAvg != null && Number.isFinite(ctx.walletQualityAvg)
        ? Number(ctx.walletQualityAvg)
        : null;
    if (m.minWalletQuality != null && wq != null && wq < m.minWalletQuality) {
      return {
        score: 0,
        reason: `wallet quality ${wq.toFixed(0)} < ${m.minWalletQuality}`,
      };
    }
    score += 62 + Math.min(35, (conv - 75) * 0.8);
    bits.push(`high-quality conviction ${conv}`);
    if (wallets != null && wallets >= (m.minWalletCount ?? 3)) {
      score += 14;
      bits.push(`cluster ${wallets}`);
    }
    if (wq != null && m.minWalletQuality != null && wq >= m.minWalletQuality) {
      score += 12;
      bits.push(`WQ ${wq.toFixed(0)}`);
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
      exitRules.forceScalp = false;
    }
  }

  if (def.id === 'migration_sniper') {
    exitRules.forceScalp = true;
    exitRules.overrideScalpParams = true;
    exitRules.shortTermStrategyId = 'post_migration_scalp';
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
  }
): TradeProfileAssignment {
  return {
    profileId: def.id,
    name: def.name,
    icon: def.icon,
    color: def.color,
    score: opts.score,
    reason: opts.reason,
    exitRules: finalizeExitRulesForWinner(def, ctx),
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
 */
export function assignTradeProfile(
  ctx: TradeProfileMatchContext
): TradeProfileAssignment {
  const state = ensureState();
  const auto = normalizeAutoScoringConfig(state.autoScoring);

  if (!state.enabled) {
    const a = legacyDefaultAssignment('multi-profile off');
    logTradeProfileAssignment(a, ctx);
    recordAssignmentDecision(a, ctx);
    return a;
  }

  const candidates = TRADE_PROFILE_CATALOG.filter(
    (p) => state.profiles[p.id] !== false
  ).map((p) => resolveTradeProfileDefinition(p.id));

  // Manual force override
  if (auto.forceProfileId) {
    const forced = candidates.find((p) => p.id === auto.forceProfileId);
    if (forced) {
      const a = buildAssignmentFromDef(forced, ctx, {
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
      });
      logTradeProfileAssignment(a, ctx);
      recordAssignmentDecision(a, ctx);
      return a;
    }
    console.log(
      `[trade-profiles] Force profile ${auto.forceProfileId} is OFF — falling back to scoring`
    );
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
    logTopScores(ctx, topScores, false);

    const winner = scored[0];
    if (!winner) {
      const a = legacyDefaultAssignment('no profile matched');
      a.topScores = topScores;
      logTradeProfileAssignment(a, ctx);
      recordAssignmentDecision(a, ctx);
      return a;
    }

    const a = buildAssignmentFromDef(winner.def, ctx, {
      score: Math.round(winner.score * 10) / 10,
      reason: winner.reason,
      autoScored: false,
      topScores,
    });
    logTradeProfileAssignment(a, ctx);
    recordAssignmentDecision(a, ctx);
    return a;
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
    breakdowns.push({
      profileId: def.id,
      name: def.name,
      icon: def.icon,
      color: def.color,
      score: combined.score,
      reason: combined.reason,
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
  logTopScores(ctx, topScores, true);

  const winner = breakdowns.find((b) => b.score > 0);
  if (!winner) {
    const a = legacyDefaultAssignment('no profile matched (auto)');
    a.topScores = topScores;
    a.autoScored = true;
    logTradeProfileAssignment(a, ctx);
    recordAssignmentDecision(a, ctx);
    return a;
  }

  if (auto.skipBelowMin && winner.score < auto.minScore) {
    const skip: TradeProfileAssignment = {
      profileId: 'default',
      name: 'Skipped',
      icon: '⊘',
      color: TRADE_PROFILE_COLORS.skipped,
      score: winner.score,
      reason: `best ${winner.name} scored ${winner.score} < min ${auto.minScore}`,
      exitRules: {},
      legacy: true,
      skipped: true,
      skipReason: `Auto-score ${winner.score} below minimum ${auto.minScore} (best: ${winner.name})`,
      autoScored: true,
      topScores,
    };
    console.log(
      `[trade-profiles] SKIP ${ctx.symbol || 'token'} — ${skip.skipReason}`
    );
    logTopScores(ctx, topScores, true);
    recordAssignmentDecision(skip, ctx);
    return skip;
  }

  const def = resolveTradeProfileDefinition(winner.profileId);
  const a = buildAssignmentFromDef(def, ctx, {
    score: winner.score,
    reason: winner.reason,
    autoScored: true,
    topScores,
  });
  logTradeProfileAssignment(a, ctx);
  recordAssignmentDecision(a, ctx);
  return a;
}

function logTopScores(
  ctx: TradeProfileMatchContext,
  top: Array<{ id: string; name: string; score: number; reason?: string }>,
  auto: boolean
): void {
  if (!top.length) return;
  const line = top
    .map((t) => `${t.name}=${t.score.toFixed(1)}`)
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
    er.sizeMultiplier != null && er.sizeMultiplier !== 1
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
  }

  if (rules.takeProfitPct != null && Number.isFinite(rules.takeProfitPct)) {
    position.takeProfitPct = rules.takeProfitPct;
    if (position.scalpMode || rules.overrideScalpParams) {
      position.scalpTpPct = rules.takeProfitPct;
    }
  }
  if (rules.stopLossPct != null && Number.isFinite(rules.stopLossPct)) {
    const sl = normalizeStopLossPct(rules.stopLossPct);
    position.stopLossPct = sl;
    if (position.scalpMode || rules.overrideScalpParams) {
      position.scalpSlPct = sl;
    }
  }
  if (rules.trailingStopPct != null && Number.isFinite(rules.trailingStopPct)) {
    position.trailingStopPct = rules.trailingStopPct;
  }
  if (
    rules.trailingActivationProfit != null &&
    Number.isFinite(rules.trailingActivationProfit) &&
    rules.trailingActivationProfit > 0
  ) {
    position.trailingActivationProfit = rules.trailingActivationProfit;
  }
  if (
    rules.momentumFailDropPct != null &&
    Number.isFinite(rules.momentumFailDropPct) &&
    rules.momentumFailDropPct > 0
  ) {
    position.scalpMomentumFailDropPct = Math.min(
      40,
      Number(rules.momentumFailDropPct)
    );
  }
  if (
    rules.hardTimeLimitSec != null &&
    Number.isFinite(rules.hardTimeLimitSec) &&
    rules.hardTimeLimitSec > 0 &&
    (position.scalpMode || rules.forceScalp)
  ) {
    position.scalpMode = true;
    const holdMs = Math.round(rules.hardTimeLimitSec) * 1000;
    position.scalpDeadlineMs = position.openedAt + holdMs;
    // Soft timer may defer a green trade; hard cap at 1.4× primary window
    position.scalpHardDeadlineMs = position.openedAt + Math.round(holdMs * 1.4);
  }
  if (
    (rules.aggressiveDeadMarket || rules.deadVolumeMinHoldMinutes != null) &&
    rules.deadVolumeMinHoldMinutes != null &&
    Number.isFinite(rules.deadVolumeMinHoldMinutes)
  ) {
    position.deadVolumeMinHoldMinutes = Math.max(
      0,
      Number(rules.deadVolumeMinHoldMinutes)
    );
  }
}

export function hydrateTradeProfilesFromSettings(
  saved: { tradeProfiles?: Partial<TradeProfileRuntimeState> } | null | undefined
): void {
  const base = defaultRuntimeState();
  if (!saved?.tradeProfiles) {
    writeTradeProfilesState(base);
    return;
  }
  const s = saved.tradeProfiles;
  if (typeof s.enabled === 'boolean') base.enabled = s.enabled;
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
    base.overrides = { ...s.overrides };
  }
  if (s.autoScoring && typeof s.autoScoring === 'object') {
    base.autoScoring = normalizeAutoScoringConfig(s.autoScoring);
  }
  base.profiles.default = true;
  writeTradeProfilesState(base);
}

export function serializeTradeProfilesForPersist(): TradeProfileRuntimeState {
  return JSON.parse(JSON.stringify(ensureState())) as TradeProfileRuntimeState;
}

export function ensureTradeProfilesInitialized(): void {
  ensureState();
}
