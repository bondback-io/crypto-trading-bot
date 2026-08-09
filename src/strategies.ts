/**
 * Strategy registry — master ON/OFF layer for entry, filters, exit, risk, advanced.
 *
 * When OFF, the mapped logic is skipped entirely.
 * When ON, Risk On/Off baseline + manual module toggles apply.
 * Hard floors remain when Risk is On.
 *
 * Profiles: high_win_rate | win_rate_55_60 | balanced | aggressive | quick_scalper |
 * micro_scalper | momentum_burst | post_migration_scalp | reversal_scalp |
 * scalper_suite | aggressive_scalper | conservative_scalper | custom.
 * Named presets set strategy toggles + quality thresholds and leave Risk recipe
 * sync (custom). When strategyRecipeMode is synced, Risk On/Off applies
 * RISK_STRATEGY_RECIPES (lean On or ops-only Off). No Strict overlay.
 */

import {
  config,
  persistUserSettings,
  HARD_FILTER_FLOORS,
  normalizeRiskLevel,
  applyImportedSettingsSnapshot,
  buildPersistedSettingsSnapshot,
  type RiskLevel,
  DEFAULT_QUICK_SCALPER,
  DEFAULT_MICRO_SCALPER,
  DEFAULT_MOMENTUM_BURST,
  DEFAULT_POST_MIGRATION_SCALP,
  DEFAULT_REVERSAL_SCALP,
  DEFAULT_POST_RUN_DIP,
  DEFAULT_CHART_PATTERNS,
} from './config';
import type { PersistedBotSettings } from './settingsStore';
import { SETTINGS_VERSION } from './settingsStore';
import { SHORT_TERM_STRATEGIES } from './shortTermStrategies';

export type StrategyGroup =
  | 'entry'
  | 'filters'
  | 'exit'
  | 'risk'
  | 'advanced';

export type StrategyKey =
  | 'smart_money_copy'
  | 'ta_market_scanner'
  | 'wallet_convergence'
  | 'migration_priority'
  | 'near_migration_curve'
  | 'early_curve_smart_money'
  | 'rebuy_on_dip'
  | 'elite_convergence'
  | 'migration_sniper'
  | 'anti_rug_honeypot'
  | 'bonding_curve_health'
  | 'min_holders_activity'
  | 'volume_liquidity_filters'
  | 'dead_market_exit'
  | 'dynamic_position_sizing'
  | 'tiered_profit_taking'
  | 'wallet_quality_scoring'
  | 'multi_factor_conviction'
  | 'time_based_entry'
  | 'hard_quality_gate'
  | 'early_entry_only'
  | 'sniper_bundler_filters'
  | 'mev_protection'
  | 'momentum_confirmation'
  | 'smart_money_flow_weighting'
  | 'profit_protected'
  | 'social_sentiment_filter'
  | 'trending_narrative_boost'
  | 'volume_spike_filter'
  | 'confirmation_layer'
  | 'market_session_filter'
  | 'post_run_dip'
  | 'technical_levels'
  | 'chart_patterns'
  | 'heikin_ashi'
  | 'pattern_volume_dryup_return'
  | 'pattern_falling_wedge'
  | 'pattern_structured_pullback'
  | 'pattern_bull_flag'
  | 'pattern_trend_continuation'
  | 'quick_scalper'
  | 'micro_scalper'
  | 'momentum_burst'
  | 'post_migration_scalp'
  | 'reversal_scalp';

export type TradeFrequencyImpact =
  | 'none'
  | 'slightly_fewer'
  | 'fewer'
  | 'much_fewer'
  | 'slightly_more'
  | 'more';

/**
 * Which entry signal source this module mainly gates.
 * - copy: tracked smart-wallet copy path (weak/no effect if Smart Money Copy is OFF)
 * - scanner: Market Scanner / TA / AlphaScan path
 * - both: shared entry filters that apply to copy and scanner buys
 * - mgmt: exits, sizing, profit — not tied to how the signal arrived
 */
export type StrategySignalLane = 'copy' | 'scanner' | 'both' | 'mgmt';

/** Per-module signal-source affinity for Settings → Modules icons. */
export const STRATEGY_SIGNAL_LANE: Record<StrategyKey, StrategySignalLane> = {
  smart_money_copy: 'copy',
  wallet_convergence: 'copy',
  wallet_quality_scoring: 'copy',
  elite_convergence: 'copy',
  early_curve_smart_money: 'copy',
  smart_money_flow_weighting: 'copy',
  hard_quality_gate: 'copy',
  min_holders_activity: 'copy', // wallet activity poll filter

  ta_market_scanner: 'scanner',
  technical_levels: 'scanner',
  chart_patterns: 'scanner',
  heikin_ashi: 'scanner',
  pattern_volume_dryup_return: 'scanner',
  pattern_falling_wedge: 'scanner',
  pattern_structured_pullback: 'scanner',
  pattern_bull_flag: 'scanner',
  pattern_trend_continuation: 'scanner',
  volume_spike_filter: 'scanner',
  momentum_confirmation: 'scanner',
  market_session_filter: 'scanner',
  post_run_dip: 'scanner',

  anti_rug_honeypot: 'both',
  bonding_curve_health: 'both',
  volume_liquidity_filters: 'both',
  sniper_bundler_filters: 'both',
  mev_protection: 'both',
  multi_factor_conviction: 'both',
  confirmation_layer: 'both',
  time_based_entry: 'both',
  early_entry_only: 'both',
  migration_priority: 'both',
  near_migration_curve: 'both',
  migration_sniper: 'both',
  rebuy_on_dip: 'both',
  social_sentiment_filter: 'both',
  trending_narrative_boost: 'both',
  quick_scalper: 'both',
  micro_scalper: 'both',
  momentum_burst: 'both',
  post_migration_scalp: 'both',
  reversal_scalp: 'both',

  dead_market_exit: 'mgmt',
  dynamic_position_sizing: 'mgmt',
  tiered_profit_taking: 'mgmt',
  profit_protected: 'mgmt',
};

export function strategySignalLane(key: StrategyKey): StrategySignalLane {
  return STRATEGY_SIGNAL_LANE[key] ?? 'both';
}

export type StrategyProfileId =
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

export type NamedStrategyProfileId = Exclude<StrategyProfileId, 'custom'>;

export const NAMED_STRATEGY_PROFILES: readonly NamedStrategyProfileId[] = [
  'high_win_rate',
  'win_rate_55_60',
  'balanced',
  'aggressive',
  'quick_scalper',
  'micro_scalper',
  'momentum_burst',
  'post_migration_scalp',
  'reversal_scalp',
  'scalper_suite',
  'aggressive_scalper',
  'conservative_scalper',
] as const;

export function isNamedStrategyProfile(
  value: string | null | undefined
): value is NamedStrategyProfileId {
  return (
    value === 'high_win_rate' ||
    value === 'win_rate_55_60' ||
    value === 'balanced' ||
    value === 'aggressive' ||
    value === 'quick_scalper' ||
    value === 'micro_scalper' ||
    value === 'momentum_burst' ||
    value === 'post_migration_scalp' ||
    value === 'reversal_scalp' ||
    value === 'scalper_suite' ||
    value === 'aggressive_scalper' ||
    value === 'conservative_scalper'
  );
}

export function isStrategyProfileId(
  value: string | null | undefined
): value is StrategyProfileId {
  return value === 'custom' || isNamedStrategyProfile(value);
}

export type StrategySource = 'core' | 'risk' | 'optional';

export interface StrategyDefinition {
  key: StrategyKey;
  name: string;
  group: StrategyGroup;
  description: string;
  /** Default ON to match pre-1.1.40 always-on behaviour where applicable */
  defaultEnabled: boolean;
  /** Disabling requires explicit confirm in the UI */
  criticalSafety: boolean;
  /** Rough trade-frequency impact when this strategy is ON */
  frequencyWhenOn: TradeFrequencyImpact;
  /** Soft/optional advanced feature */
  placeholder?: boolean;
  /** core = always-on must-have; risk = driven by Risk Level recipe; optional = manual/advanced */
  source: StrategySource;
}

export const STRATEGY_GROUP_LABELS: Record<StrategyGroup, string> = {
  entry: 'Entry',
  filters: 'Filters',
  exit: 'Exit',
  risk: 'Risk',
  advanced: 'Advanced',
};

export const STRATEGY_GROUP_ORDER: StrategyGroup[] = [
  'entry',
  'filters',
  'exit',
  'risk',
  'advanced',
];

export const HIGH_WIN_RATE_WARNING =
  'Fewer trades expected – prioritises high win rate';

export const WIN_RATE_55_60_DESCRIPTION =
  'Balanced high-quality profile – more trades than 60%+ version';

export const BALANCED_PRESET_DESCRIPTION =
  'Best overall risk/reward balance';

export const AGGRESSIVE_PRESET_DESCRIPTION =
  'More opportunities, still protected';

export const QUICK_SCALPER_PRESET_DESCRIPTION =
  'Fast timed scalps: volume/pressure entries, fixed TP, tight SL, hard time limit';

export const MICRO_SCALPER_PRESET_DESCRIPTION =
  'Ultra-fast 30–90s spikes: small TP, very tight SL, hard timer';

export const MOMENTUM_BURST_PRESET_DESCRIPTION =
  'Burst entries on buy momentum: 1–5 min holds, higher TP, fade exit';

export const POST_MIGRATION_SCALP_PRESET_DESCRIPTION =
  'Fresh migration scalps: post-grad volatility, 1–4 min timed exits';

export const REVERSAL_SCALP_PRESET_DESCRIPTION =
  'Selective mean-reversion on sharp wicks: tight stops, quick snap-back targets';

export const SCALPER_SUITE_PRESET_DESCRIPTION =
  'Fast scalping suite (Standard) – quick profits and tight risk';

export const AGGRESSIVE_SCALPER_PRESET_DESCRIPTION =
  'Aggressive Scalper – faster timers, higher TP targets, looser volume';

export const CONSERVATIVE_SCALPER_PRESET_DESCRIPTION =
  'Conservative Scalper – tighter stops, stricter volume, aggressive dead-market exit';

export const STRATEGY_PRESET_META: Record<
  NamedStrategyProfileId,
  { id: NamedStrategyProfileId; label: string; description: string; warning?: string }
> = {
  high_win_rate: {
    id: 'high_win_rate',
    label: '60%+ Win Rate Profile',
    description: HIGH_WIN_RATE_WARNING,
    warning: HIGH_WIN_RATE_WARNING,
  },
  win_rate_55_60: {
    id: 'win_rate_55_60',
    label: '55–60% Win Rate Profile',
    description: WIN_RATE_55_60_DESCRIPTION,
    warning: WIN_RATE_55_60_DESCRIPTION,
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    description: BALANCED_PRESET_DESCRIPTION,
  },
  aggressive: {
    id: 'aggressive',
    label: 'Aggressive',
    description: AGGRESSIVE_PRESET_DESCRIPTION,
  },
  quick_scalper: {
    id: 'quick_scalper',
    label: 'Quick Scalper',
    description: QUICK_SCALPER_PRESET_DESCRIPTION,
    warning: QUICK_SCALPER_PRESET_DESCRIPTION,
  },
  micro_scalper: {
    id: 'micro_scalper',
    label: 'Micro-Scalper',
    description: MICRO_SCALPER_PRESET_DESCRIPTION,
    warning: MICRO_SCALPER_PRESET_DESCRIPTION,
  },
  momentum_burst: {
    id: 'momentum_burst',
    label: 'Momentum Burst',
    description: MOMENTUM_BURST_PRESET_DESCRIPTION,
    warning: MOMENTUM_BURST_PRESET_DESCRIPTION,
  },
  post_migration_scalp: {
    id: 'post_migration_scalp',
    label: 'Post-Migration Scalp',
    description: POST_MIGRATION_SCALP_PRESET_DESCRIPTION,
    warning: POST_MIGRATION_SCALP_PRESET_DESCRIPTION,
  },
  reversal_scalp: {
    id: 'reversal_scalp',
    label: 'Reversal Scalp',
    description: REVERSAL_SCALP_PRESET_DESCRIPTION,
    warning: REVERSAL_SCALP_PRESET_DESCRIPTION,
  },
  scalper_suite: {
    id: 'scalper_suite',
    label: 'Scalper Suite (Standard)',
    description: SCALPER_SUITE_PRESET_DESCRIPTION,
    warning: SCALPER_SUITE_PRESET_DESCRIPTION,
  },
  aggressive_scalper: {
    id: 'aggressive_scalper',
    label: 'Aggressive Scalper',
    description: AGGRESSIVE_SCALPER_PRESET_DESCRIPTION,
    warning: AGGRESSIVE_SCALPER_PRESET_DESCRIPTION,
  },
  conservative_scalper: {
    id: 'conservative_scalper',
    label: 'Conservative Scalper',
    description: CONSERVATIVE_SCALPER_PRESET_DESCRIPTION,
    warning: CONSERVATIVE_SCALPER_PRESET_DESCRIPTION,
  },
};

export const STRATEGY_REGISTRY: readonly StrategyDefinition[] = [
  {
    key: 'smart_money_copy',
    name: 'Smart Money Copy',
    group: 'entry',
    description:
      'Core copy-trading of tracked smart wallets. OFF skips all new copy entries (Market Scanner can still trade).',
    defaultEnabled: true,
    criticalSafety: false,
    frequencyWhenOn: 'more',
    source: 'core',
  },
  {
    key: 'ta_market_scanner',
    name: 'Market Scanner (TA)',
    group: 'entry',
    description:
      'Autonomous Pump.fun / Dex opportunity scan using Fib, patterns, volume, and indicators — no wallet buy required. Hybrid with Smart Money Copy when both are ON.',
    defaultEnabled: true,
    criticalSafety: false,
    frequencyWhenOn: 'more',
    source: 'risk',
  },
  {
    key: 'wallet_convergence',
    name: 'Wallet Convergence / Clustering',
    group: 'entry',
    description:
      'Require multiple distinct smart wallets before entering (cluster / convergence).',
    defaultEnabled: true,
    criticalSafety: false,
    frequencyWhenOn: 'fewer',
    source: 'core',
  },
  {
    key: 'migration_priority',
    name: 'Migration Priority',
    group: 'entry',
    description:
      'Boost size and priority when smart money hits a freshly migrated token.',
    defaultEnabled: true,
    criticalSafety: false,
    frequencyWhenOn: 'slightly_more',
    source: 'core',
  },
  {
    key: 'near_migration_curve',
    name: 'Near-Migration Curve Priority',
    group: 'entry',
    description:
      'Prioritize Pump.fun tokens nearing bonding-curve completion (e.g. 80%+).',
    defaultEnabled: true,
    criticalSafety: false,
    frequencyWhenOn: 'slightly_more',
    source: 'core',
  },
  {
    key: 'early_curve_smart_money',
    name: 'Early-Curve Smart Money',
    group: 'entry',
    description:
      'Prioritize early-curve buys when quality smart wallets pile in pre-migration.',
    defaultEnabled: true,
    criticalSafety: false,
    frequencyWhenOn: 'slightly_more',
    source: 'core',
  },
  {
    key: 'rebuy_on_dip',
    name: 'Re-Buy on Dip',
    group: 'entry',
    description:
      'After profitable exit (and optional post-stop reclaim), watch for dip / reclaim re-entry.',
    defaultEnabled: true,
    criticalSafety: false,
    frequencyWhenOn: 'slightly_more',
    source: 'risk',
  },
  {
    key: 'elite_convergence',
    name: 'Elite Convergence Only',
    group: 'entry',
    description:
      'Only enter when a strong multi-wallet cluster forms (raises cluster/conviction floors; blocks single-wallet). Fewer trades, higher quality. Off by default on lean Risk On; enable manually for fewer, higher-quality entries.',
    defaultEnabled: false,
    criticalSafety: false,
    frequencyWhenOn: 'much_fewer',
    source: 'risk',
  },
  {
    key: 'migration_sniper',
    name: 'Migration Sniper Mode',
    group: 'entry',
    description:
      'Legacy exclusive filter: only migration / near-migration entries when Multi-Profile is OFF. With Multi-Profile ON (default), the Migration Sniper trade profile owns fresh grads — this toggle does not block Mirror / Trend / Scalper / Dip.',
    defaultEnabled: false,
    criticalSafety: false,
    frequencyWhenOn: 'much_fewer',
    source: 'risk',
  },
  {
    key: 'anti_rug_honeypot',
    name: 'Anti-Rug + Honeypot',
    group: 'filters',
    description:
      'Rug / holder / LP safety checks and honeypot / tax probes before entry.',
    defaultEnabled: true,
    criticalSafety: true,
    frequencyWhenOn: 'fewer',
    source: 'core',
  },
  {
    key: 'bonding_curve_health',
    name: 'Bonding Curve Health',
    group: 'filters',
    description:
      'Reject dead or stalled Pump bonding curves when health data is available.',
    defaultEnabled: false,
    criticalSafety: true,
    frequencyWhenOn: 'fewer',
    source: 'risk',
  },
  {
    key: 'min_holders_activity',
    name: 'Min Holders + Activity',
    group: 'filters',
    description:
      'Token holder floors + soft wallet activity poll filter. Deprioritizes inactive wallets for polling; does not permanently disable them (use explicit prune to remove).',
    defaultEnabled: true,
    criticalSafety: true,
    frequencyWhenOn: 'fewer',
    source: 'core',
  },
  {
    key: 'volume_liquidity_filters',
    name: 'Volume / Liquidity Filters',
    group: 'filters',
    description:
      'Enforce volume and liquidity gates (hard floors for MC / liq still always apply).',
    defaultEnabled: true,
    criticalSafety: true,
    frequencyWhenOn: 'fewer',
    source: 'core',
  },
  {
    key: 'dead_market_exit',
    name: 'Dead Market Exit',
    group: 'exit',
    description:
      'Force-sell stuck positions when Dex volume stays dead for consecutive hours.',
    defaultEnabled: true,
    criticalSafety: true,
    frequencyWhenOn: 'none',
    source: 'core',
  },
  {
    key: 'dynamic_position_sizing',
    name: 'Dynamic Position Sizing',
    group: 'risk',
    description:
      'Size buys from risk % of bankroll / conviction instead of fixed SOL only.',
    defaultEnabled: true,
    criticalSafety: false,
    frequencyWhenOn: 'none',
    source: 'core',
  },
  {
    key: 'tiered_profit_taking',
    name: 'Tiered Profit Taking + Bag + Trailing',
    group: 'exit',
    description:
      'Partial → recover initial → bag runner with trailing stop (profit strategy).',
    defaultEnabled: true,
    criticalSafety: false,
    frequencyWhenOn: 'none',
    source: 'core',
  },
  {
    key: 'wallet_quality_scoring',
    name: 'Wallet Quality Scoring',
    group: 'filters',
    description:
      'Hard-gate entries when source wallets fail the quality / inactivity score.',
    defaultEnabled: true,
    criticalSafety: true,
    frequencyWhenOn: 'fewer',
    source: 'core',
  },
  {
    key: 'multi_factor_conviction',
    name: 'Multi-Factor Conviction Score',
    group: 'filters',
    description:
      'Selective trading: min conviction score, rate limits, and size scaling by risk.',
    defaultEnabled: true,
    criticalSafety: true,
    frequencyWhenOn: 'much_fewer',
    source: 'core',
  },
  {
    key: 'time_based_entry',
    name: 'Time-Based Entry Window',
    group: 'filters',
    description:
      'Skip late signals outside the preferred entry-age window.',
    defaultEnabled: true,
    criticalSafety: false,
    frequencyWhenOn: 'fewer',
    source: 'core',
  },
  {
    key: 'hard_quality_gate',
    name: 'Hard Quality Score Gate',
    group: 'filters',
    description:
      'Raise the minimum wallet quality floor (hard gate) so weak / inactive wallets cannot open trades.',
    defaultEnabled: false,
    criticalSafety: false,
    frequencyWhenOn: 'fewer',
    source: 'risk',
  },
  {
    key: 'early_entry_only',
    name: 'Early Entry Window Only',
    group: 'filters',
    description:
      'Only enter in the first minutes after smart money buys — cuts late/dumping entries.',
    defaultEnabled: false,
    criticalSafety: false,
    frequencyWhenOn: 'much_fewer',
    source: 'risk',
  },
  {
    key: 'sniper_bundler_filters',
    name: 'Sniper / Bundler Filters',
    group: 'filters',
    description:
      'Block tokens with high sniper / bundler / insider launch risk.',
    defaultEnabled: true,
    criticalSafety: true,
    frequencyWhenOn: 'fewer',
    source: 'core',
  },
  {
    key: 'social_sentiment_filter',
    name: 'Social Sentiment Filter',
    group: 'filters',
    description:
      'Supporting filter (not a primary signal): when social/proxy data is available, boosts conviction on positive heat/KOL activity or reduces/skips on very negative / dead sentiment. Gracefully ignored when data is unavailable.',
    defaultEnabled: false,
    criticalSafety: false,
    frequencyWhenOn: 'slightly_fewer',
    source: 'optional',
  },
  {
    key: 'trending_narrative_boost',
    name: 'Trending Narrative Boost',
    group: 'filters',
    description:
      'Boosts tokens tied to currently hot narratives – used as confirmation, not a primary signal. Soft conviction boost only; ignored when narrative data is unavailable.',
    defaultEnabled: false,
    criticalSafety: false,
    frequencyWhenOn: 'slightly_more',
    source: 'optional',
  },
  {
    key: 'volume_spike_filter',
    name: 'Volume Spike Filter',
    group: 'filters',
    description:
      'Advanced volume spike detection (3× surge default, 1–5m window, ≥65% buy-side, prefer/require acceleration, relative volume, absolute floor). Hard-blocks weak volume; boosts conviction on strong spikes. Extra weight near migration. Fail-open when volume data is unavailable.',
    defaultEnabled: false,
    criticalSafety: false,
    frequencyWhenOn: 'slightly_fewer',
    source: 'optional',
  },
  {
    key: 'confirmation_layer',
    name: 'Volume + Sentiment + Narrative Confirmation',
    group: 'filters',
    description:
      'Combined confirmation from Volume Spike, Social Sentiment, and Trending Narrative (Weak→Very Strong). Soft conviction boost when Strong+; optional hard filter when Very Weak. Volume weighted highest by default. Missing sentiment/narrative never blocks. Fail-open when no usable data.',
    defaultEnabled: false,
    criticalSafety: false,
    frequencyWhenOn: 'slightly_fewer',
    source: 'optional',
  },
  {
    key: 'market_session_filter',
    name: 'Market Session Filter',
    group: 'filters',
    description:
      'Allow or block entries by UTC session (Asia, Europe, US, overlaps). Preferred sessions get a soft conviction boost. Off-hours blocked by default when enabled.',
    defaultEnabled: false,
    criticalSafety: false,
    frequencyWhenOn: 'slightly_fewer',
    source: 'optional',
  },
  {
    key: 'post_run_dip',
    name: 'Post-Run Dip / Rotation Buy',
    group: 'advanced',
    description:
      'Standard / Conservative / Aggressive profiles. Dip-phase smart wallet confirmation (HQ buys, buybacks, Fib cluster, net flow) boosts conviction; optional Conservative hard-require. Soft boost by default. Default OFF.',
    defaultEnabled: false,
    criticalSafety: false,
    frequencyWhenOn: 'slightly_fewer',
    source: 'optional',
  },
  {
    key: 'technical_levels',
    name: 'Technical Levels (Fib + S/R)',
    group: 'filters',
    description:
      'Pump.fun defaults — Fib: 2–6h, recent ≥50% impulse, 0.5/0.618 (+0.382/0.786) as ±2% zones. S&R: 1–4h (max 6), medium swings, ≥2 touches, zone ±2%, recent strong supports, volume reaction, break+close invalidation. Soft boost; optional hard filter. Paper / Live Sim / Backtester. Fail-open with thin history.',
    defaultEnabled: false,
    criticalSafety: false,
    frequencyWhenOn: 'slightly_fewer',
    source: 'optional',
  },
  {
    key: 'chart_patterns',
    name: 'Chart Patterns (extras)',
    group: 'filters',
    description:
      'Optional secondary patterns (triangles, trendline break, holder distribution, capitulation). Core Pump.fun patterns have their own toggles below. Soft boost; configurable sensitivity. Paper / Live Sim / Backtester.',
    defaultEnabled: false,
    criticalSafety: false,
    frequencyWhenOn: 'slightly_fewer',
    source: 'optional',
  },
  {
    key: 'heikin_ashi',
    name: 'Heikin-Ashi Trend',
    group: 'filters',
    description:
      'Soft-prefer HA-green entries and exit on confirmed HA red flip after ≥2 green candles. For Trend Rider / Steady Compounder / High Win-Rate. Opt-in master; profile allowlist ON for those three. Does not replace trailing stop. Fail-open with thin history.',
    defaultEnabled: false,
    criticalSafety: false,
    frequencyWhenOn: 'slightly_fewer',
    source: 'optional',
  },
  {
    key: 'pattern_volume_dryup_return',
    name: 'Volume Dry-up + Return',
    group: 'filters',
    description:
      'Highest-value Pump.fun setup: volume dries up then returns with price. Entry + confirmation. Best for Dip Buyer, High Win-Rate, Steady Compounder.',
    defaultEnabled: false,
    criticalSafety: false,
    frequencyWhenOn: 'slightly_fewer',
    source: 'optional',
  },
  {
    key: 'pattern_falling_wedge',
    name: 'Falling Wedge Breakout',
    group: 'filters',
    description:
      'Converging lower highs/lows then bullish breakout. Entry + confirmation. Best for Dip Buyer, Reversal Scalper, High Win-Rate.',
    defaultEnabled: false,
    criticalSafety: false,
    frequencyWhenOn: 'slightly_fewer',
    source: 'optional',
  },
  {
    key: 'pattern_structured_pullback',
    name: 'Structured Pullback',
    group: 'filters',
    description:
      'Orderly pullback after a strong run (not a crash). Entry + confirmation. Best for Dip Buyer, Trend Rider, High Win-Rate.',
    defaultEnabled: false,
    criticalSafety: false,
    frequencyWhenOn: 'slightly_fewer',
    source: 'optional',
  },
  {
    key: 'pattern_bull_flag',
    name: 'Bull Flag / Pennant',
    group: 'filters',
    description:
      'Sharp pole + tight consolidation then continuation breakout. Entry + confirmation. Best for Momentum Burst, Trend Rider, Migration Sniper.',
    defaultEnabled: false,
    criticalSafety: false,
    frequencyWhenOn: 'slightly_fewer',
    source: 'optional',
  },
  {
    key: 'pattern_trend_continuation',
    name: 'Trend Continuation',
    group: 'filters',
    description:
      'Buy pullbacks in an established HH/HL uptrend. Entry + confirmation. Best for Trend Rider, Steady Compounder, Smart Money Mirror.',
    defaultEnabled: false,
    criticalSafety: false,
    frequencyWhenOn: 'slightly_fewer',
    source: 'optional',
  },
  {
    key: 'mev_protection',
    name: 'MEV Protection',
    group: 'advanced',
    description:
      'Jito / sandwich-aware live send path (no effect on paper fills).',
    defaultEnabled: false,
    criticalSafety: false,
    frequencyWhenOn: 'slightly_fewer',
    source: 'risk',
  },
  {
    key: 'momentum_confirmation',
    name: 'Momentum Confirmation',
    group: 'advanced',
    description:
      'Require short-term hold / momentum confirmation before entry (selective).',
    defaultEnabled: false,
    criticalSafety: false,
    frequencyWhenOn: 'fewer',
    source: 'risk',
  },
  {
    key: 'smart_money_flow_weighting',
    name: 'Smart Money Flow Weighting',
    group: 'advanced',
    description:
      'Weight conviction by Birdeye / smart-money flow strength on the token.',
    defaultEnabled: true,
    criticalSafety: false,
    frequencyWhenOn: 'slightly_fewer',
    source: 'core',
  },
  {
    key: 'profit_protected',
    name: 'Profit-Protected Profile',
    group: 'exit',
    description:
      'Protect winners: forces tiered takes + aggressive dead-market exits, raises quality/conviction floors. Targets fewer losers, keeps strong runners.',
    defaultEnabled: false,
    criticalSafety: false,
    frequencyWhenOn: 'fewer',
    source: 'risk',
  },
  {
    key: 'quick_scalper',
    name: 'Quick Scalper',
    group: 'exit',
    description:
      'Fast entries on volume / buy pressure / smart money. Fixed TP, tight SL, hard time limit — auto-closes if neither hit.',
    defaultEnabled: false,
    criticalSafety: false,
    frequencyWhenOn: 'more',
    source: 'risk',
  },
  {
    key: 'micro_scalper',
    name: 'Micro-Scalper',
    group: 'exit',
    description:
      'Ultra-fast entries on volume/buy spikes. 30–90s hard timer, small TP (12–25%), very tight SL. Best for fleeting spikes.',
    defaultEnabled: false,
    criticalSafety: false,
    frequencyWhenOn: 'more',
    source: 'risk',
  },
  {
    key: 'momentum_burst',
    name: 'Momentum Burst',
    group: 'exit',
    description:
      'Enter on sudden buy volume / momentum. Hold 1–5 min with higher TP; exit on TP, SL, timer, or momentum failure.',
    defaultEnabled: false,
    criticalSafety: false,
    frequencyWhenOn: 'more',
    source: 'risk',
  },
  {
    key: 'post_migration_scalp',
    name: 'Post-Migration Scalp',
    group: 'exit',
    description:
      'Only on fresh migrations with volume. Short 1–4 min hold for post-graduation volatility — quick TP, tight SL.',
    defaultEnabled: false,
    criticalSafety: false,
    frequencyWhenOn: 'more',
    source: 'risk',
  },
  {
    key: 'reversal_scalp',
    name: 'Reversal Scalp',
    group: 'exit',
    description:
      'Mean-reversion on sharp wicks / over-extensions. Selective entries; tight stops; quick target when price snaps back.',
    defaultEnabled: false,
    criticalSafety: false,
    frequencyWhenOn: 'slightly_fewer',
    source: 'risk',
  },
] as const;

export type StrategyToggleMap = Record<StrategyKey, boolean>;

const STRATEGY_KEYS = STRATEGY_REGISTRY.map((s) => s.key);

/** Tunable knobs captured for High Win-Rate apply / restore. */
export interface StrategyProfileKnobs {
  strategyToggles: StrategyToggleMap;
  filters: {
    enableAntiRug: boolean;
    checkHoneypot: boolean;
    enableSniperFilter: boolean;
    sniperSensitivity: 'low' | 'medium' | 'high';
    enableSocialSentimentFilter: boolean;
    socialSentimentSensitivity: 'low' | 'medium' | 'high';
    enableTrendingNarrativeBoost: boolean;
    trendingNarrativeSensitivity: 'low' | 'medium' | 'high';
    trendingNarrativeBoostPoints: number;
    enableVolumeSpikeFilter: boolean;
    volumeSpikeSensitivity: 'low' | 'medium' | 'high';
    volumeSpikeWindowMinutes: number;
    volumeSpikeMultiplier: number;
    volumeSpikeBuySidePct: number;
    volumeSpikeMinUsd: number;
    volumeSpikeBoostPoints: number;
    volumeSpikeHardFilter: boolean;
    enableConfirmationLayer: boolean;
    confirmationSensitivity: 'low' | 'medium' | 'high';
    confirmationVolumeWeight: number;
    confirmationSentimentWeight: number;
    confirmationNarrativeWeight: number;
    confirmationBoostPoints: number;
    confirmationHardFilter: boolean;
    enableActivityFilter: boolean;
    enableWalletQualityGate: boolean;
    minWalletQualityScore: number;
    enableEntryTimingGate: boolean;
    maxEntryAgeMinutes: number;
    preferEntryWithinMinutes: number;
    requireMomentumConfirmation: boolean;
    smartMoneyFlowWeight: number;
    convergenceRequired: number;
    clusterMinWallets: number;
    allowSingleWalletTopPerformerMigration: boolean;
    minLiquidity: number;
    minMarketCapUsd: number;
    minVolume24hUsd: number;
    minRecentVolumeUsd: number;
    minHolders: number;
    minHolderCount: number;
    minRecentActivity: number;
    maxRiskScore: number;
    maxDevHoldPct: number;
    maxHolderConcentration: number;
    skipIfDevRecentSells: boolean;
    maxConcurrentPositions: number;
  };
  selective: {
    enabled: boolean;
    minConvictionScore: number;
    minWalletsForTrade: number;
    requireConvergenceForNormal: boolean;
    allowSingleWalletMigration: boolean;
    maxTradesPerHour: number;
    minMsBetweenTrades: number;
  };
  strategy: {
    enableConvergence: boolean;
    enableMigrationPriority: boolean;
    enableBondingCurvePriority: boolean;
    enableEarlyCurvePriority: boolean;
    reBuyEnabled: boolean;
    postStopReentryEnabled: boolean;
    confirmationThreshold: number;
  };
  risk: {
    enableDeadVolumeExit: boolean;
    deadVolumeUsdPerHour: number;
    deadVolumeConsecutiveHours: number;
    deadVolumeMinHoldMinutes: number;
    enabled: boolean;
    useRiskSizing: boolean;
  };
  bondingCurve: {
    requireHealthyCurve: boolean;
    requireRecentCurveActivity: boolean;
  };
  profitStrategy: {
    enabled: boolean;
    takeInitialPercent: number;
    partialSellAt: number;
    partialSellPercent: number;
    trailingStopAfter: number;
    trailingStopPct: number;
    bagPercent: number;
  };
  mev: { enableMEVProtection: boolean };
  quickScalper: {
    enabled: boolean;
    timeLimitMinutes: 1 | 2 | 3;
    takeProfitPct: number;
    stopLossPct: number;
    minVolumeUsd: number;
    minBuyPressureUsd: number;
  };
  microScalper: {
    enabled: boolean;
    timeLimitSeconds: number;
    takeProfitPct: number;
    stopLossPct: number;
    minVolumeUsd: number;
    minBuyPressureUsd: number;
  };
  momentumBurst: {
    enabled: boolean;
    timeLimitSeconds: number;
    takeProfitPct: number;
    stopLossPct: number;
    minVolumeUsd: number;
    minBuyPressureUsd: number;
    momentumFailDropPct: number;
  };
  postMigrationScalp: {
    enabled: boolean;
    timeLimitSeconds: number;
    takeProfitPct: number;
    stopLossPct: number;
    minVolumeUsd: number;
    minBuyPressureUsd: number;
  };
  reversalScalp: {
    enabled: boolean;
    timeLimitSeconds: number;
    takeProfitPct: number;
    stopLossPct: number;
    minVolumeUsd: number;
    minBuyPressureUsd: number;
    minDropFromPeakPct: number;
    minConvictionScore: number;
  };
  postRunDip: {
    enabled: boolean;
    sensitivity: 'low' | 'medium' | 'high';
    timeLimitMinutes: number;
    takeProfitPct: number;
    stopLossPct: number;
    minRunPct: number;
    minDipFromPeakPct: number;
    maxDipFromPeakPct: number;
    preferNearTechnicals: boolean;
    requireNearTechnicals: boolean;
    hardRequireSetup: boolean;
    boostPoints: number;
  };
}

export interface StrategyProfileSnapshot {
  savedAt: number;
  fromProfile: StrategyProfileId;
  knobs: StrategyProfileKnobs;
}

/**
 * Shared threshold pack for named strategy presets.
 * Applied on top of Risk Level / Strict Mode (Strict can still tighten further).
 */
export interface StrategyPresetThresholds {
  minWalletQualityScore: number;
  minConvictionScore: number;
  convergenceRequired: number;
  clusterMinWallets: number;
  minWalletsForTrade: number;
  allowSingleWalletMigration: boolean;
  allowSingleWalletTopPerformerMigration: boolean;
  requireConvergenceForNormal: boolean;
  minLiquidity: number;
  minMarketCapUsd: number;
  minVolume24hUsd: number;
  minRecentVolumeUsd: number;
  minHolders: number;
  minHolderCount: number;
  minRecentActivity: number;
  maxRiskScore: number;
  maxDevHoldPct: number;
  maxHolderConcentration: number;
  sniperSensitivity: 'low' | 'medium' | 'high';
  maxEntryAgeMinutes: number;
  preferEntryWithinMinutes: number;
  requireMomentumConfirmation: boolean;
  smartMoneyFlowWeight: number;
  confirmationThreshold: number;
  deadVolumeUsdPerHour: number;
  deadVolumeConsecutiveHours: number;
  deadVolumeMinHoldMinutes: number;
  maxTradesPerHour: number;
  minMsBetweenTrades: number;
  requireHealthyCurve: boolean;
  requireRecentCurveActivity: boolean;
  enableEarlyCurvePriority: boolean;
  reBuyEnabled: boolean;
  postStopReentryEnabled: boolean;
}

/**
 * 60%+ Win Rate Profile — exact recipe:
 * quality ≥65, conviction ≥75, cluster ≥3, entry window 8–10m,
 * liq ≥$8k, meaningful recent volume, holders ≥50, healthy curve + momentum.
 */
export const HIGH_WIN_RATE_THRESHOLDS: StrategyPresetThresholds = {
  minWalletQualityScore: 65,
  minConvictionScore: 75,
  convergenceRequired: 3,
  clusterMinWallets: 3,
  minWalletsForTrade: 3,
  allowSingleWalletMigration: false,
  allowSingleWalletTopPerformerMigration: false,
  requireConvergenceForNormal: true,
  minLiquidity: 8_000,
  minMarketCapUsd: 8_000,
  minVolume24hUsd: 25_000,
  /** Meaningful recent (15–60m) volume — reject near-zero */
  minRecentVolumeUsd: 2_500,
  minHolders: 150,
  minHolderCount: 150,
  minRecentActivity: 12,
  maxRiskScore: 55,
  maxDevHoldPct: 10,
  maxHolderConcentration: 45,
  sniperSensitivity: 'high',
  /** Max time after first smart buy: 8–10 minutes */
  maxEntryAgeMinutes: 10,
  preferEntryWithinMinutes: 8,
  requireMomentumConfirmation: true,
  smartMoneyFlowWeight: 1.55,
  confirmationThreshold: 3,
  /** Aggressive dead-market exit */
  deadVolumeUsdPerHour: 80,
  deadVolumeConsecutiveHours: 1,
  deadVolumeMinHoldMinutes: 8,
  maxTradesPerHour: 5,
  minMsBetweenTrades: 90_000,
  requireHealthyCurve: true,
  requireRecentCurveActivity: true,
  enableEarlyCurvePriority: false,
  reBuyEnabled: false,
  postStopReentryEnabled: false,
};

/** Exit / sizing defaults applied with the 60%+ Win Rate Profile. */
export const HIGH_WIN_RATE_DEFAULTS = {
  maxConcurrentPositions: 2,
  /** Partial take-profit starts in the +40–60% band */
  partialSellAt: 50,
  partialSellPercent: 40,
  /** Trail 20–25% from peak after profit */
  trailingStopAfter: 90,
  trailingStopPct: 22,
  /** Leave a small bag for 100–500%+ runners */
  bagPercent: 28,
  takeInitialPercent: 95,
} as const;

/**
 * 55–60% Win Rate Profile — relaxed vs 60%+:
 * quality ~60, conviction ~68, cluster 2–3, entry 10–15m,
 * liq ~$6k, moderate recent volume, holders ~40, curve preferred,
 * momentum preferred (not mandatory).
 */
export const WIN_RATE_55_60_THRESHOLDS: StrategyPresetThresholds = {
  minWalletQualityScore: 60,
  minConvictionScore: 68,
  convergenceRequired: 2,
  clusterMinWallets: 2,
  minWalletsForTrade: 2,
  allowSingleWalletMigration: true,
  allowSingleWalletTopPerformerMigration: true,
  requireConvergenceForNormal: true,
  minLiquidity: 8_000,
  minMarketCapUsd: 8_000,
  minVolume24hUsd: 20_000,
  /** Moderate recent volume — still reject near-zero */
  minRecentVolumeUsd: 2_000,
  minHolders: 120,
  minHolderCount: 120,
  minRecentActivity: 10,
  maxRiskScore: 62,
  maxDevHoldPct: 12,
  maxHolderConcentration: 50,
  sniperSensitivity: 'medium',
  maxEntryAgeMinutes: 15,
  preferEntryWithinMinutes: 12,
  requireMomentumConfirmation: false,
  smartMoneyFlowWeight: 1.4,
  confirmationThreshold: 2,
  /** Medium-aggressive dead-market exit */
  deadVolumeUsdPerHour: 70,
  deadVolumeConsecutiveHours: 1,
  deadVolumeMinHoldMinutes: 12,
  maxTradesPerHour: 10,
  minMsBetweenTrades: 45_000,
  requireHealthyCurve: true,
  requireRecentCurveActivity: true,
  enableEarlyCurvePriority: true,
  reBuyEnabled: true,
  postStopReentryEnabled: true,
};

/** Exit / sizing defaults for the 55–60% Win Rate Profile. */
export const WIN_RATE_55_60_DEFAULTS = {
  maxConcurrentPositions: 3,
  /** Partial take-profit starts in the +35–50% band */
  partialSellAt: 42,
  partialSellPercent: 40,
  /** Trail 22–28% from peak */
  trailingStopAfter: 85,
  trailingStopPct: 25,
  /** Leave a bag for larger runners */
  bagPercent: 30,
  takeInitialPercent: 90,
} as const;

/** Best overall risk/reward balance (Medium-like quality gates). */
export const BALANCED_THRESHOLDS: StrategyPresetThresholds = {
  minWalletQualityScore: 55,
  minConvictionScore: 45,
  convergenceRequired: 2,
  clusterMinWallets: 2,
  minWalletsForTrade: 2,
  allowSingleWalletMigration: true,
  allowSingleWalletTopPerformerMigration: true,
  requireConvergenceForNormal: true,
  minLiquidity: 10_000,
  minMarketCapUsd: 8_000,
  minVolume24hUsd: 25_000,
  minRecentVolumeUsd: 2_500,
  minHolders: 120,
  minHolderCount: 120,
  minRecentActivity: 10,
  maxRiskScore: 70,
  maxDevHoldPct: 14,
  maxHolderConcentration: 55,
  sniperSensitivity: 'medium',
  maxEntryAgeMinutes: 15,
  preferEntryWithinMinutes: 10,
  requireMomentumConfirmation: false,
  smartMoneyFlowWeight: 1.35,
  confirmationThreshold: 3,
  deadVolumeUsdPerHour: 60,
  deadVolumeConsecutiveHours: 2,
  deadVolumeMinHoldMinutes: 20,
  maxTradesPerHour: 12,
  minMsBetweenTrades: 45_000,
  requireHealthyCurve: false,
  requireRecentCurveActivity: true,
  enableEarlyCurvePriority: true,
  reBuyEnabled: true,
  postStopReentryEnabled: true,
};

/** Minimal selective floors — Risk OFF (entry engines only; no hard floors). */
export const OFF_RISK_THRESHOLDS: StrategyPresetThresholds = {
  minWalletQualityScore: 0,
  minConvictionScore: 0,
  convergenceRequired: 1,
  clusterMinWallets: 1,
  minWalletsForTrade: 1,
  allowSingleWalletMigration: true,
  allowSingleWalletTopPerformerMigration: true,
  requireConvergenceForNormal: false,
  minLiquidity: 0,
  minMarketCapUsd: 0,
  minVolume24hUsd: 0,
  minRecentVolumeUsd: 0,
  minHolders: 0,
  minHolderCount: 0,
  minRecentActivity: 0,
  maxRiskScore: 100,
  maxDevHoldPct: 0,
  maxHolderConcentration: 0,
  sniperSensitivity: 'low',
  maxEntryAgeMinutes: 0,
  preferEntryWithinMinutes: 0,
  requireMomentumConfirmation: false,
  smartMoneyFlowWeight: 1.0,
  confirmationThreshold: 1,
  deadVolumeUsdPerHour: 80,
  deadVolumeConsecutiveHours: 3,
  deadVolumeMinHoldMinutes: 25,
  maxTradesPerHour: 50,
  minMsBetweenTrades: 5_000,
  requireHealthyCurve: false,
  requireRecentCurveActivity: false,
  enableEarlyCurvePriority: true,
  reBuyEnabled: false,
  postStopReentryEnabled: false,
};

/** More opportunities, still protected (not Degen). */
export const AGGRESSIVE_THRESHOLDS: StrategyPresetThresholds = {
  minWalletQualityScore: 48,
  minConvictionScore: 32,
  convergenceRequired: 2,
  clusterMinWallets: 2,
  minWalletsForTrade: 1,
  allowSingleWalletMigration: true,
  allowSingleWalletTopPerformerMigration: true,
  requireConvergenceForNormal: false,
  minLiquidity: 8_000,
  minMarketCapUsd: 8_000,
  minVolume24hUsd: 20_000,
  minRecentVolumeUsd: 2_000,
  minHolders: 120,
  minHolderCount: 120,
  minRecentActivity: 10,
  maxRiskScore: 78,
  maxDevHoldPct: 18,
  maxHolderConcentration: 70,
  sniperSensitivity: 'medium',
  maxEntryAgeMinutes: 20,
  preferEntryWithinMinutes: 12,
  requireMomentumConfirmation: false,
  smartMoneyFlowWeight: 1.2,
  confirmationThreshold: 2,
  deadVolumeUsdPerHour: 70,
  deadVolumeConsecutiveHours: 2,
  deadVolumeMinHoldMinutes: 15,
  maxTradesPerHour: 20,
  minMsBetweenTrades: 20_000,
  requireHealthyCurve: false,
  requireRecentCurveActivity: false,
  enableEarlyCurvePriority: true,
  reBuyEnabled: true,
  postStopReentryEnabled: true,
};

export type StrategyRecipeMode = 'synced' | 'custom';

export type RiskLevelId = RiskLevel; // 'on' | 'off'

/** Per-engine scalp numerics applied with a Risk recipe (when those engines are ON). */
export interface RiskRecipeScalpParams {
  microScalper?: Partial<{
    timeLimitSeconds: number;
    takeProfitPct: number;
    stopLossPct: number;
    minVolumeUsd: number;
    minBuyPressureUsd: number;
  }>;
  momentumBurst?: Partial<{
    timeLimitSeconds: number;
    takeProfitPct: number;
    stopLossPct: number;
    minVolumeUsd: number;
    minBuyPressureUsd: number;
    momentumFailDropPct: number;
  }>;
  postMigrationScalp?: Partial<{
    timeLimitSeconds: number;
    takeProfitPct: number;
    stopLossPct: number;
    minVolumeUsd: number;
    minBuyPressureUsd: number;
  }>;
  reversalScalp?: Partial<{
    timeLimitSeconds: number;
    takeProfitPct: number;
    stopLossPct: number;
    minVolumeUsd: number;
    minBuyPressureUsd: number;
    minDropFromPeakPct: number;
    minConvictionScore: number;
  }>;
  quickScalper?: Partial<{
    timeLimitMinutes: number;
    takeProfitPct: number;
    stopLossPct: number;
    minVolumeUsd: number;
    minBuyPressureUsd: number;
  }>;
}

export interface RiskStrategyRecipe {
  toggles: StrategyToggleMap;
  thresholds: StrategyPresetThresholds;
  summary: string;
  maxConcurrentPositions?: number;
  profitStrategy?: Partial<{
    takeInitialPercent: number;
    partialSellAt: number;
    partialSellPercent: number;
    trailingStopAfter: number;
    trailingStopPct: number;
    bagPercent: number;
  }>;
  scalp?: RiskRecipeScalpParams;
}

function buildRecipeToggles(
  overrides: Partial<StrategyToggleMap>
): StrategyToggleMap {
  const out = {} as StrategyToggleMap;
  for (const s of STRATEGY_REGISTRY) {
    if (s.source === 'core') {
      out[s.key] = true;
    } else {
      out[s.key] = false;
    }
  }
  // Overrides win last — Degen (and others) can turn core modules OFF
  for (const [key, value] of Object.entries(overrides)) {
    if (isStrategyKey(key) && typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

function applyRiskRecipeScalpParams(scalp: RiskRecipeScalpParams | undefined): void {
  if (!scalp) return;
  if (scalp.microScalper) {
    Object.assign(config.microScalper, scalp.microScalper);
  }
  if (scalp.momentumBurst) {
    Object.assign(config.momentumBurst, scalp.momentumBurst);
  }
  if (scalp.postMigrationScalp) {
    Object.assign(config.postMigrationScalp, scalp.postMigrationScalp);
  }
  if (scalp.reversalScalp) {
    Object.assign(config.reversalScalp, scalp.reversalScalp);
  }
  if (scalp.quickScalper) {
    Object.assign(config.quickScalper, scalp.quickScalper);
  }
}

function applyRiskRecipeExtras(recipe: RiskStrategyRecipe): void {
  if (recipe.maxConcurrentPositions != null) {
    config.filters.maxConcurrentPositions = Math.max(
      1,
      Math.min(80, recipe.maxConcurrentPositions)
    );
  }
  if (recipe.profitStrategy) {
    Object.assign(config.profitStrategy, recipe.profitStrategy);
    if (recipe.profitStrategy.trailingStopPct != null) {
      config.risk.trailingStopPct = recipe.profitStrategy.trailingStopPct;
      config.risk.trailingStopPercent = recipe.profitStrategy.trailingStopPct;
    }
  }
  applyRiskRecipeScalpParams(recipe.scalp);
}

/** Risk On/Off → strategy module ON/OFF + thresholds + profit packs. */
export const RISK_STRATEGY_RECIPES: Record<RiskLevelId, RiskStrategyRecipe> = {
  on: {
    summary:
      'Lean On — Smart Money Copy + Market Scanner; quality/conviction/anti-rug/scalps OFF until enabled manually',
    thresholds: BALANCED_THRESHOLDS,
    maxConcurrentPositions: 24,
    profitStrategy: {
      takeInitialPercent: 90,
      partialSellAt: 50,
      partialSellPercent: 42,
      trailingStopAfter: 110,
      trailingStopPct: 20,
      bagPercent: 28,
    },
    toggles: buildRecipeToggles({
      ta_market_scanner: true,
      anti_rug_honeypot: false,
      rebuy_on_dip: false,
      elite_convergence: false,
      migration_sniper: false,
      bonding_curve_health: false,
      hard_quality_gate: false,
      early_entry_only: false,
      momentum_confirmation: false,
      profit_protected: false,
      multi_factor_conviction: false,
      wallet_quality_scoring: false,
      time_based_entry: false,
      wallet_convergence: false,
      volume_liquidity_filters: false,
      min_holders_activity: false,
      sniper_bundler_filters: false,
      smart_money_flow_weighting: false,
      mev_protection: true,
      quick_scalper: false,
      micro_scalper: false,
      momentum_burst: false,
      post_migration_scalp: false,
      reversal_scalp: false,
    }),
  },
  off: {
    summary:
      'Risk OFF — Smart Money Copy + Market Scanner ON; anti-rug / risk-linked modules OFF; hard floors bypassed; maxConcurrent 40; small size for soak',
    thresholds: OFF_RISK_THRESHOLDS,
    maxConcurrentPositions: 40,
    profitStrategy: {
      takeInitialPercent: 120,
      partialSellAt: 70,
      partialSellPercent: 35,
      trailingStopAfter: 150,
      trailingStopPct: 30,
      bagPercent: 40,
    },
    toggles: buildRecipeToggles({
      ta_market_scanner: true,
      anti_rug_honeypot: false,
      rebuy_on_dip: false,
      elite_convergence: false,
      migration_sniper: false,
      bonding_curve_health: false,
      hard_quality_gate: false,
      early_entry_only: false,
      momentum_confirmation: false,
      profit_protected: false,
      mev_protection: false,
      wallet_quality_scoring: false,
      multi_factor_conviction: false,
      time_based_entry: false,
      wallet_convergence: false,
      volume_liquidity_filters: false,
      min_holders_activity: false,
      sniper_bundler_filters: false,
      smart_money_flow_weighting: false,
      quick_scalper: false,
      micro_scalper: false,
      momentum_burst: false,
      post_migration_scalp: false,
      reversal_scalp: false,
    }),
  },
};

export function getRiskStrategyRecipe(level: RiskLevelId): RiskStrategyRecipe {
  const canonical = normalizeRiskLevel(level);
  return RISK_STRATEGY_RECIPES[canonical] ?? RISK_STRATEGY_RECIPES.on;
}

/**
 * Recommended one-by-one module enable order after bare rebuild soak.
 * Entry engines stay on; enable these next and keep/drop by soak metrics.
 */
export const MODULE_TUNE_ORDER: Array<{
  key: StrategyKey;
  label: string;
  why: string;
}> = [
  {
    key: 'anti_rug_honeypot',
    label: 'Anti-rug / honeypot',
    why: 'Cut obvious rugs; measure open-rate drop vs disasters',
  },
  {
    key: 'dead_market_exit',
    label: 'Dead-market exit',
    why: 'Exit hygiene before more entry filters',
  },
  {
    key: 'volume_liquidity_filters',
    label: 'Volume / liquidity floors',
    why: 'Cut dead books; watch if opens crater',
  },
  {
    key: 'min_holders_activity',
    label: 'Min holders / activity',
    why: 'Companion floor to volume/liq',
  },
  {
    key: 'wallet_quality_scoring',
    label: 'Wallet quality',
    why: 'Smarter copy-wallet gating',
  },
  {
    key: 'multi_factor_conviction',
    label: 'Multi-factor conviction',
    why: 'Easy to over-gate — enable only after floors/quality',
  },
  {
    key: 'time_based_entry',
    label: 'Time-based entry',
    why: 'Entry age / timing selectivity',
  },
  {
    key: 'wallet_convergence',
    label: 'Wallet convergence',
    why: 'Require multi-wallet confirmation',
  },
];

export function getModuleTuneStatus() {
  const toggles = ensureStrategyToggles();
  const steps = MODULE_TUNE_ORDER.map((step, index) => ({
    ...step,
    index: index + 1,
    enabled: toggles[step.key] === true,
  }));
  const next = steps.find((s) => !s.enabled) ?? null;
  const enabledTune = steps.filter((s) => s.enabled).map((s) => s.key);
  return {
    order: steps,
    next,
    enabledTune,
    hint: next
      ? `Next: enable ${next.label} (${next.key}) — ${next.why}`
      : 'All recommended tune modules are ON — evaluate keep/drop via soak metrics',
  };
}

/** Enable the next OFF module in MODULE_TUNE_ORDER (marks recipe custom). */
export function enableNextTuneModule(): {
  enabled: StrategyKey | null;
  status: ReturnType<typeof getModuleTuneStatus>;
} {
  const status = getModuleTuneStatus();
  if (!status.next) {
    return { enabled: null, status };
  }
  updateStrategyToggles({ [status.next.key]: true }, { markCustom: true });
  return {
    enabled: status.next.key,
    status: getModuleTuneStatus(),
  };
}

export function ensureStrategyRecipeMode(): StrategyRecipeMode {
  if (
    config.strategyRecipeMode !== 'synced' &&
    config.strategyRecipeMode !== 'custom'
  ) {
    config.strategyRecipeMode = 'synced';
  }
  return config.strategyRecipeMode;
}

export function markStrategyRecipeCustom(options?: {
  persist?: boolean;
}): void {
  config.strategyRecipeMode = 'custom';
  if (options?.persist !== false) persistUserSettings();
}

/**
 * Apply Risk Level strategy recipe (toggles + quality thresholds + profit/scalp packs).
 * Sets recipe mode to synced. Does not change Risk knobs (size/SL/floors) — those come from applyRiskLevel.
 */
export function applyRiskStrategyRecipe(
  level: RiskLevelId,
  options?: { persist?: boolean }
): {
  toggles: StrategyToggleMap;
  mode: StrategyRecipeMode;
  riskLevel: RiskLevelId;
  summary: string;
  enabledCore: number;
  enabledRisk: number;
  enabledOptional: number;
} {
  const canonical = normalizeRiskLevel(level);
  const recipe = getRiskStrategyRecipe(canonical);
  ensureStrategyToggles();
  updateStrategyToggles(
    { ...recipe.toggles },
    { persist: false, syncUnderlying: true, markCustom: false }
  );
  applyStrategyPresetThresholds(recipe.thresholds);
  applyRiskRecipeExtras(recipe);
  syncUnderlyingFlagsFromToggles(config.strategyToggles as StrategyToggleMap);
  config.strategyRecipeMode = 'synced';
  config.strategyRecipeRiskLevel = canonical;
  config.strategyProfile = 'custom';
  config.highWinRatePresetActive = false;
  if (options?.persist !== false) persistUserSettings();
  const toggles = config.strategyToggles as StrategyToggleMap;
  let enabledCore = 0;
  let enabledRisk = 0;
  let enabledOptional = 0;
  for (const s of STRATEGY_REGISTRY) {
    if (toggles[s.key] !== true) continue;
    if (s.source === 'core') enabledCore += 1;
    else if (s.source === 'risk') enabledRisk += 1;
    else enabledOptional += 1;
  }
  console.log(
    `[strategies] Risk recipe → ${canonical.toUpperCase()} (synced) — ${recipe.summary}`
  );
  return {
    toggles: { ...toggles },
    mode: 'synced',
    riskLevel: canonical,
    summary: recipe.summary,
    enabledCore,
    enabledRisk,
    enabledOptional,
  };
}

/** Re-sync modules to the current Risk Level recipe. */
export function resetStrategyRecipeToRisk(options?: { persist?: boolean }) {
  const level = normalizeRiskLevel(config.riskLevel);
  return applyRiskStrategyRecipe(level, options);
}

export function getStrategyRecipeStatus() {
  const mode = ensureStrategyRecipeMode();
  const level = normalizeRiskLevel(config.riskLevel);
  const recipe = getRiskStrategyRecipe(level);
  const toggles = ensureStrategyToggles();
  let enabledCore = 0;
  let enabledRisk = 0;
  let enabledOptional = 0;
  let divergedRisk = 0;
  for (const s of STRATEGY_REGISTRY) {
    const on = toggles[s.key] === true;
    if (on) {
      if (s.source === 'core') enabledCore += 1;
      else if (s.source === 'risk') enabledRisk += 1;
      else enabledOptional += 1;
    }
    if (s.source === 'risk' || s.source === 'optional') {
      const expected = recipe.toggles[s.key] === true;
      if (on !== expected) divergedRisk += 1;
    }
  }
  return {
    mode,
    riskLevel: level,
    recipeRiskLevel: config.strategyRecipeRiskLevel || level,
    summary: recipe.summary,
    enabledCore,
    enabledRisk,
    enabledOptional,
    divergedFromRecipe: mode === 'custom' ? divergedRisk : 0,
    recipeToggles: { ...recipe.toggles },
  };
}

export function isStrategyKey(value: string): value is StrategyKey {
  return (STRATEGY_KEYS as string[]).includes(value);
}

export function defaultStrategyToggles(): StrategyToggleMap {
  const out = {} as StrategyToggleMap;
  for (const s of STRATEGY_REGISTRY) {
    out[s.key] = s.defaultEnabled;
  }
  // MEV default follows env/config at seed time
  out.mev_protection = config.mev?.enableMEVProtection === true;
  return out;
}

/**
 * Seed toggles from current config flags so upgrades keep ≈ current behaviour.
 */
export function deriveStrategyTogglesFromConfig(): StrategyToggleMap {
  const d = defaultStrategyToggles();
  d.smart_money_copy = true;
  d.wallet_convergence = config.strategy.enableConvergence !== false;
  d.migration_priority = config.strategy.enableMigrationPriority !== false;
  d.near_migration_curve =
    config.strategy.enableBondingCurvePriority !== false;
  d.early_curve_smart_money =
    config.strategy.enableEarlyCurvePriority !== false;
  d.rebuy_on_dip =
    config.strategy.reBuyEnabled !== false ||
    config.strategy.postStopReentryEnabled !== false;
  d.anti_rug_honeypot = config.filters.enableAntiRug !== false;
  d.bonding_curve_health = config.bondingCurve.requireHealthyCurve === true;
  d.min_holders_activity = config.filters.enableActivityFilter !== false;
  d.volume_liquidity_filters = true;
  d.dead_market_exit = config.risk.enableDeadVolumeExit !== false;
  d.dynamic_position_sizing =
    config.risk.enabled !== false && config.risk.useRiskSizing !== false;
  d.tiered_profit_taking = config.profitStrategy?.enabled !== false;
  d.wallet_quality_scoring =
    config.filters.enableWalletQualityGate !== false;
  d.multi_factor_conviction = config.selective?.enabled !== false;
  d.time_based_entry = config.filters.enableEntryTimingGate !== false;
  d.sniper_bundler_filters = config.filters.enableSniperFilter !== false;
  d.social_sentiment_filter =
    config.filters.enableSocialSentimentFilter === true;
  d.trending_narrative_boost =
    config.filters.enableTrendingNarrativeBoost === true;
  d.volume_spike_filter = config.filters.enableVolumeSpikeFilter === true;
  d.confirmation_layer = config.filters.enableConfirmationLayer === true;
  d.market_session_filter =
    config.filters.enableMarketSessionFilter === true;
  d.post_run_dip = config.postRunDip?.enabled === true;
  d.technical_levels = config.technicalLevels?.enabled === true;
  d.chart_patterns = config.chartPatterns?.enabled === true &&
    (config.chartPatterns?.patterns?.ascending_triangle?.enabled === true ||
      config.chartPatterns?.patterns?.descending_triangle?.enabled === true ||
      config.chartPatterns?.patterns?.trendline_break?.enabled === true ||
      config.chartPatterns?.patterns?.holder_distribution?.enabled === true ||
      config.chartPatterns?.patterns?.capitulation?.enabled === true);
  d.pattern_volume_dryup_return =
    config.chartPatterns?.patterns?.volume_dryup_return?.enabled === true;
  d.pattern_falling_wedge =
    config.chartPatterns?.patterns?.falling_wedge?.enabled === true;
  d.pattern_structured_pullback =
    config.chartPatterns?.patterns?.structured_pullback?.enabled === true;
  d.pattern_bull_flag =
    config.chartPatterns?.patterns?.bull_flag?.enabled === true;
  d.pattern_trend_continuation =
    config.chartPatterns?.patterns?.trend_continuation?.enabled === true;
  d.mev_protection = config.mev.enableMEVProtection === true;
  d.momentum_confirmation =
    config.filters.requireMomentumConfirmation === true;
  d.smart_money_flow_weighting =
    (config.filters.smartMoneyFlowWeight ?? 1) > 1;
  d.ta_market_scanner = config.marketScanner?.enabled !== false;
  // New quality modes default OFF so upgrades stay non-breaking
  d.elite_convergence = false;
  d.migration_sniper = false;
  d.hard_quality_gate = false;
  d.early_entry_only = false;
  d.profit_protected = false;
  return d;
}

export function ensureStrategyToggles(): StrategyToggleMap {
  if (
    !config.strategyToggles ||
    typeof config.strategyToggles !== 'object' ||
    Object.keys(config.strategyToggles).length === 0
  ) {
    config.strategyToggles = deriveStrategyTogglesFromConfig();
  } else {
    const defaults = defaultStrategyToggles();
    for (const key of STRATEGY_KEYS) {
      if (typeof config.strategyToggles[key] !== 'boolean') {
        config.strategyToggles[key] = defaults[key];
      }
    }
  }
  if (!isStrategyProfileId(config.strategyProfile)) {
    config.strategyProfile = 'custom';
  }
  if (config.highWinRatePresetActive == null) {
    config.highWinRatePresetActive = config.strategyProfile === 'high_win_rate';
  }
  return config.strategyToggles as StrategyToggleMap;
}

export function isStrategyEnabledGlobal(key: StrategyKey): boolean {
  const toggles = ensureStrategyToggles();
  return toggles[key] !== false;
}

/**
 * Global master toggle only — unless Smart Bot Profiles is ON and a profile
 * gate is active on the stack (entry filter evaluation), in which case the
 * profile allowlist is also applied. When Smart Bot is OFF this is always
 * the legacy global check.
 */
export function isStrategyEnabled(key: StrategyKey): boolean {
  if (!isStrategyEnabledGlobal(key)) return false;
  try {
    const {
      isSmartBotProfilesEnabled,
      profileAllowsModule,
      getActiveStrategyProfileGate,
    } = require('./tradeProfiles') as typeof import('./tradeProfiles');
    if (!isSmartBotProfilesEnabled()) return true;
    const gated = getActiveStrategyProfileGate();
    // undefined = no gate active → global only (legacy short-circuit for callers
    // outside profile-scoped evaluation)
    if (gated === undefined) return true;
    return profileAllowsModule(gated, key);
  } catch {
    return true;
  }
}

/**
 * Explicit profile-aware gate.
 * OFF Smart Bot → identical to global. ON → global ∩ profile allowlist.
 */
export function isStrategyEnabledForProfile(
  key: StrategyKey,
  profileId?: string | null
): boolean {
  if (!isStrategyEnabledGlobal(key)) return false;
  try {
    const { isSmartBotProfilesEnabled, profileAllowsModule } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    if (!isSmartBotProfilesEnabled()) return true;
    return profileAllowsModule(profileId, key);
  } catch {
    return true;
  }
}

export function getStrategyDefinition(
  key: StrategyKey
): StrategyDefinition | undefined {
  return STRATEGY_REGISTRY.find((s) => s.key === key);
}

export function frequencyImpactLabel(impact: TradeFrequencyImpact): string {
  switch (impact) {
    case 'none':
      return 'No frequency change';
    case 'slightly_fewer':
      return 'Slightly fewer trades';
    case 'fewer':
      return 'Fewer trades';
    case 'much_fewer':
      return 'Much fewer trades';
    case 'slightly_more':
      return 'Slightly more trades';
    case 'more':
      return 'More trade opportunities';
    default:
      return '';
  }
}

/**
 * 60%+ Win Rate toggles — forced ON/OFF when profile is activated.
 * Single-wallet heavily restricted via elite + selective flags.
 * hard_quality_gate / early_entry_only off so overlays don't override the
 * exact recipe floors (65 / 75 / 3 / 8–10m).
 */
export const HIGH_WIN_RATE_PRESET: StrategyToggleMap = {
  smart_money_copy: true,
  // User master preference — do not force Market Scanner OFF via this pack.
  ta_market_scanner: true,
  wallet_convergence: true,
  migration_priority: true,
  near_migration_curve: true,
  early_curve_smart_money: false,
  rebuy_on_dip: false,
  elite_convergence: true,
  migration_sniper: false,
  anti_rug_honeypot: true,
  bonding_curve_health: true,
  min_holders_activity: true,
  volume_liquidity_filters: true,
  dead_market_exit: true,
  dynamic_position_sizing: true,
  tiered_profit_taking: true,
  wallet_quality_scoring: true,
  multi_factor_conviction: true,
  time_based_entry: true,
  hard_quality_gate: false,
  early_entry_only: false,
  sniper_bundler_filters: true,
  mev_protection: true,
  momentum_confirmation: true,
  smart_money_flow_weighting: true,
  profit_protected: true,
  social_sentiment_filter: false,
  trending_narrative_boost: false,
  volume_spike_filter: false,
  confirmation_layer: false,
  market_session_filter: false,
  post_run_dip: false,
  technical_levels: false,
  chart_patterns: false,
  heikin_ashi: false,
  pattern_volume_dryup_return: false,
  pattern_falling_wedge: false,
  pattern_structured_pullback: false,
  pattern_bull_flag: false,
  pattern_trend_continuation: false,
  quick_scalper: false,
  micro_scalper: false,
  momentum_burst: false,
  post_migration_scalp: false,
  reversal_scalp: false,
};

/**
 * 55–60% Win Rate toggles — quality ON, convergence flexible (not elite),
 * momentum preferred-off (not mandatory), rebuy selective/optional ON,
 * single-wallet restricted via requireConvergenceForNormal but migration
 * top-performer path still allowed.
 */
export const WIN_RATE_55_60_PRESET: StrategyToggleMap = {
  smart_money_copy: true,
  ta_market_scanner: true,
  wallet_convergence: true,
  migration_priority: true,
  near_migration_curve: true,
  early_curve_smart_money: true,
  rebuy_on_dip: true,
  elite_convergence: false,
  migration_sniper: false,
  anti_rug_honeypot: true,
  bonding_curve_health: true,
  min_holders_activity: true,
  volume_liquidity_filters: true,
  dead_market_exit: true,
  dynamic_position_sizing: true,
  tiered_profit_taking: true,
  wallet_quality_scoring: true,
  multi_factor_conviction: true,
  time_based_entry: true,
  hard_quality_gate: false,
  early_entry_only: false,
  sniper_bundler_filters: true,
  mev_protection: true,
  momentum_confirmation: false,
  smart_money_flow_weighting: true,
  profit_protected: false,
  social_sentiment_filter: false,
  trending_narrative_boost: false,
  volume_spike_filter: false,
  confirmation_layer: false,
  market_session_filter: false,
  post_run_dip: false,
  technical_levels: false,
  chart_patterns: false,
  heikin_ashi: false,
  pattern_volume_dryup_return: false,
  pattern_falling_wedge: false,
  pattern_structured_pullback: false,
  pattern_bull_flag: false,
  pattern_trend_continuation: false,
  quick_scalper: false,
  micro_scalper: false,
  momentum_burst: false,
  post_migration_scalp: false,
  reversal_scalp: false,
};

/** Balanced = quality + frequency mix (≈ Medium defaults). */
export const BALANCED_PRESET: StrategyToggleMap = {
  smart_money_copy: true,
  ta_market_scanner: true,
  wallet_convergence: true,
  migration_priority: true,
  near_migration_curve: true,
  early_curve_smart_money: true,
  rebuy_on_dip: true,
  elite_convergence: false,
  migration_sniper: false,
  anti_rug_honeypot: true,
  bonding_curve_health: false,
  min_holders_activity: true,
  volume_liquidity_filters: true,
  dead_market_exit: true,
  dynamic_position_sizing: true,
  tiered_profit_taking: true,
  wallet_quality_scoring: true,
  multi_factor_conviction: true,
  time_based_entry: true,
  hard_quality_gate: false,
  early_entry_only: false,
  sniper_bundler_filters: true,
  mev_protection: true,
  momentum_confirmation: false,
  smart_money_flow_weighting: true,
  profit_protected: false,
  social_sentiment_filter: false,
  trending_narrative_boost: false,
  volume_spike_filter: false,
  confirmation_layer: false,
  market_session_filter: false,
  post_run_dip: false,
  technical_levels: false,
  chart_patterns: false,
  heikin_ashi: false,
  pattern_volume_dryup_return: false,
  pattern_falling_wedge: false,
  pattern_structured_pullback: false,
  pattern_bull_flag: false,
  pattern_trend_continuation: false,
  quick_scalper: false,
  micro_scalper: false,
  momentum_burst: false,
  post_migration_scalp: false,
  reversal_scalp: false,
};

/** Aggressive = more entries, core safety still ON. */
export const AGGRESSIVE_PRESET: StrategyToggleMap = {
  smart_money_copy: true,
  ta_market_scanner: true,
  wallet_convergence: true,
  migration_priority: true,
  near_migration_curve: true,
  early_curve_smart_money: true,
  rebuy_on_dip: true,
  elite_convergence: false,
  migration_sniper: false,
  anti_rug_honeypot: true,
  bonding_curve_health: false,
  min_holders_activity: true,
  volume_liquidity_filters: true,
  dead_market_exit: true,
  dynamic_position_sizing: true,
  tiered_profit_taking: true,
  wallet_quality_scoring: true,
  multi_factor_conviction: true,
  time_based_entry: true,
  hard_quality_gate: false,
  early_entry_only: false,
  sniper_bundler_filters: true,
  mev_protection: true,
  momentum_confirmation: false,
  smart_money_flow_weighting: true,
  profit_protected: false,
  social_sentiment_filter: false,
  trending_narrative_boost: false,
  volume_spike_filter: false,
  confirmation_layer: false,
  market_session_filter: false,
  post_run_dip: false,
  technical_levels: false,
  chart_patterns: false,
  heikin_ashi: false,
  pattern_volume_dryup_return: false,
  pattern_falling_wedge: false,
  pattern_structured_pullback: false,
  pattern_bull_flag: false,
  pattern_trend_continuation: false,
  quick_scalper: false,
  micro_scalper: false,
  momentum_burst: false,
  post_migration_scalp: false,
  reversal_scalp: false,
};

/** Quick Scalper = timed TP/SL holds; looser entry gates for speed. */
export const QUICK_SCALPER_PRESET: StrategyToggleMap = {
  smart_money_copy: true,
  ta_market_scanner: true,
  wallet_convergence: true,
  migration_priority: true,
  near_migration_curve: true,
  early_curve_smart_money: true,
  rebuy_on_dip: false,
  elite_convergence: false,
  migration_sniper: false,
  anti_rug_honeypot: true,
  bonding_curve_health: false,
  min_holders_activity: true,
  volume_liquidity_filters: true,
  dead_market_exit: false,
  dynamic_position_sizing: true,
  tiered_profit_taking: false,
  wallet_quality_scoring: true,
  multi_factor_conviction: true,
  time_based_entry: true,
  hard_quality_gate: false,
  early_entry_only: false,
  sniper_bundler_filters: true,
  mev_protection: true,
  momentum_confirmation: false,
  smart_money_flow_weighting: true,
  profit_protected: false,
  social_sentiment_filter: false,
  trending_narrative_boost: false,
  volume_spike_filter: false,
  confirmation_layer: false,
  market_session_filter: false,
  post_run_dip: false,
  technical_levels: false,
  chart_patterns: false,
  heikin_ashi: false,
  pattern_volume_dryup_return: false,
  pattern_falling_wedge: false,
  pattern_structured_pullback: false,
  pattern_bull_flag: false,
  pattern_trend_continuation: false,
  quick_scalper: true,
  micro_scalper: false,
  momentum_burst: false,
  post_migration_scalp: false,
  reversal_scalp: false,
};

const SHORT_TERM_SCALP_OFF: Pick<
  StrategyToggleMap,
  | 'quick_scalper'
  | 'micro_scalper'
  | 'momentum_burst'
  | 'post_migration_scalp'
  | 'reversal_scalp'
> = {
  quick_scalper: false,
  micro_scalper: false,
  momentum_burst: false,
  post_migration_scalp: false,
  reversal_scalp: false,
};

/** Micro-Scalper = 30–90s ultra-fast spikes. */
export const MICRO_SCALPER_PRESET: StrategyToggleMap = {
  ...QUICK_SCALPER_PRESET,
  ...SHORT_TERM_SCALP_OFF,
  micro_scalper: true,
};

/** Momentum Burst = 1–5 min momentum holds with fade exit. */
export const MOMENTUM_BURST_PRESET: StrategyToggleMap = {
  ...QUICK_SCALPER_PRESET,
  ...SHORT_TERM_SCALP_OFF,
  momentum_burst: true,
};

/** Post-Migration Scalp = fresh migration timed holds. */
export const POST_MIGRATION_SCALP_PRESET: StrategyToggleMap = {
  ...QUICK_SCALPER_PRESET,
  ...SHORT_TERM_SCALP_OFF,
  post_migration_scalp: true,
};

/** Reversal Scalp = selective mean-reversion on sharp wicks. */
export const REVERSAL_SCALP_PRESET: StrategyToggleMap = {
  ...QUICK_SCALPER_PRESET,
  ...SHORT_TERM_SCALP_OFF,
  reversal_scalp: true,
};

/**
 * Scalper Suite = Micro + Momentum Burst + Post-Migration (+ Reversal secondary).
 * Combined short-term stack for quick in-and-out trades.
 */
export const SCALPER_SUITE_PRESET: StrategyToggleMap = {
  ...QUICK_SCALPER_PRESET,
  ...SHORT_TERM_SCALP_OFF,
  micro_scalper: true,
  momentum_burst: true,
  post_migration_scalp: true,
  reversal_scalp: true,
  // Suite extras — aggressive dead market; keep core safety/volume ON
  dead_market_exit: true,
  anti_rug_honeypot: true,
  volume_liquidity_filters: true,
};

/** Suite members enabled by Scalper Suite (for resolve / logging). */
export const SCALPER_SUITE_MEMBERS = [
  'post_migration_scalp',
  'micro_scalper',
  'momentum_burst',
  'reversal_scalp',
] as const;

/** Suite-optimised defaults (Standard). */
export const SCALPER_SUITE_DEFAULTS = {
  microScalper: {
    timeLimitSeconds: 75,
    takeProfitPct: 18,
    stopLossPct: -8,
    minVolumeUsd: 12_000,
    minBuyPressureUsd: 800,
  },
  momentumBurst: {
    timeLimitSeconds: 180,
    takeProfitPct: 32,
    stopLossPct: -12,
    minVolumeUsd: 15_000,
    minBuyPressureUsd: 1_200,
    momentumFailDropPct: 8,
  },
  postMigrationScalp: {
    timeLimitSeconds: 120,
    takeProfitPct: 30,
    stopLossPct: -11,
    minVolumeUsd: 10_000,
    minBuyPressureUsd: 600,
  },
  reversalScalp: {
    timeLimitSeconds: 90,
    takeProfitPct: 22,
    stopLossPct: -9,
    minVolumeUsd: 8_000,
    minBuyPressureUsd: 400,
    minDropFromPeakPct: 32,
    minConvictionScore: 52,
  },
  maxConcurrentPositions: 3,
  deadVolumeUsdPerHour: 80,
  deadVolumeConsecutiveHours: 1,
  deadVolumeMinHoldMinutes: 4,
  /** Soft size nudge vs current trade knobs (1 = unchanged) */
  sizeMultiplier: 1,
} as const;

/** Aggressive Scalper defaults — faster / higher targets / looser volume. */
export const AGGRESSIVE_SCALPER_DEFAULTS = {
  microScalper: {
    timeLimitSeconds: 60,
    takeProfitPct: 23,
    stopLossPct: -10,
    minVolumeUsd: 8_000,
    minBuyPressureUsd: 500,
  },
  momentumBurst: {
    timeLimitSeconds: 150,
    takeProfitPct: 42,
    stopLossPct: -14,
    minVolumeUsd: 10_000,
    minBuyPressureUsd: 800,
    momentumFailDropPct: 10,
  },
  postMigrationScalp: {
    timeLimitSeconds: 105,
    takeProfitPct: 37,
    stopLossPct: -13,
    minVolumeUsd: 7_000,
    minBuyPressureUsd: 400,
  },
  reversalScalp: {
    timeLimitSeconds: 68,
    takeProfitPct: 27,
    stopLossPct: -11,
    minVolumeUsd: 6_000,
    minBuyPressureUsd: 300,
    minDropFromPeakPct: 28,
    minConvictionScore: 45,
  },
  maxConcurrentPositions: 3,
  deadVolumeUsdPerHour: 60,
  deadVolumeConsecutiveHours: 1,
  deadVolumeMinHoldMinutes: 5,
  sizeMultiplier: 1.2,
} as const;

/** Conservative Scalper defaults — tighter risk / stricter filters. */
export const CONSERVATIVE_SCALPER_DEFAULTS = {
  microScalper: {
    timeLimitSeconds: 85,
    takeProfitPct: 15,
    stopLossPct: -6,
    minVolumeUsd: 16_000,
    minBuyPressureUsd: 1_200,
  },
  momentumBurst: {
    timeLimitSeconds: 195,
    takeProfitPct: 27,
    stopLossPct: -9,
    minVolumeUsd: 20_000,
    minBuyPressureUsd: 1_500,
    momentumFailDropPct: 6,
  },
  postMigrationScalp: {
    timeLimitSeconds: 135,
    takeProfitPct: 25,
    stopLossPct: -8,
    minVolumeUsd: 14_000,
    minBuyPressureUsd: 900,
  },
  reversalScalp: {
    timeLimitSeconds: 90,
    takeProfitPct: 18,
    stopLossPct: -7,
    minVolumeUsd: 12_000,
    minBuyPressureUsd: 600,
    minDropFromPeakPct: 35,
    minConvictionScore: 58,
  },
  maxConcurrentPositions: 2,
  deadVolumeUsdPerHour: 100,
  deadVolumeConsecutiveHours: 1,
  deadVolumeMinHoldMinutes: 3,
  sizeMultiplier: 0.75,
} as const;

/** Fast scalp thresholds — still respect hard floors; Risk/Strict stack. */
export const QUICK_SCALPER_THRESHOLDS: StrategyPresetThresholds = {
  minWalletQualityScore: 45,
  minConvictionScore: 28,
  convergenceRequired: 1,
  clusterMinWallets: 1,
  minWalletsForTrade: 1,
  allowSingleWalletMigration: true,
  allowSingleWalletTopPerformerMigration: true,
  requireConvergenceForNormal: false,
  minLiquidity: 8_000,
  minMarketCapUsd: 8_000,
  minVolume24hUsd: 15_000,
  minRecentVolumeUsd: 1_500,
  minHolders: 120,
  minHolderCount: 120,
  minRecentActivity: 10,
  maxRiskScore: 82,
  maxDevHoldPct: 18,
  maxHolderConcentration: 72,
  sniperSensitivity: 'medium',
  maxEntryAgeMinutes: 12,
  preferEntryWithinMinutes: 8,
  requireMomentumConfirmation: false,
  smartMoneyFlowWeight: 1.15,
  confirmationThreshold: 2,
  deadVolumeUsdPerHour: 40,
  deadVolumeConsecutiveHours: 2,
  deadVolumeMinHoldMinutes: 8,
  maxTradesPerHour: 30,
  minMsBetweenTrades: 10_000,
  requireHealthyCurve: false,
  requireRecentCurveActivity: false,
  enableEarlyCurvePriority: true,
  reBuyEnabled: false,
  postStopReentryEnabled: false,
};

/** Micro-Scalper thresholds — lower conviction, volume via config. */
export const MICRO_SCALPER_THRESHOLDS: StrategyPresetThresholds = {
  ...QUICK_SCALPER_THRESHOLDS,
  minConvictionScore: 25,
  minVolume24hUsd: 15_000,
  minRecentVolumeUsd: 1_500,
};

/** Momentum Burst thresholds — similar to quick, slightly higher buy pressure. */
export const MOMENTUM_BURST_THRESHOLDS: StrategyPresetThresholds = {
  ...QUICK_SCALPER_THRESHOLDS,
  smartMoneyFlowWeight: 1.25,
  minRecentVolumeUsd: 1_800,
};

/** Post-Migration Scalp thresholds — migration-friendly single-wallet entries. */
export const POST_MIGRATION_SCALP_THRESHOLDS: StrategyPresetThresholds = {
  ...QUICK_SCALPER_THRESHOLDS,
  allowSingleWalletMigration: true,
  allowSingleWalletTopPerformerMigration: true,
  requireConvergenceForNormal: false,
  convergenceRequired: 1,
  clusterMinWallets: 1,
  minWalletsForTrade: 1,
};

/** Reversal Scalp thresholds — higher conviction, more selective. */
export const REVERSAL_SCALP_THRESHOLDS: StrategyPresetThresholds = {
  ...QUICK_SCALPER_THRESHOLDS,
  minConvictionScore: 48,
  minWalletQualityScore: 50,
  convergenceRequired: 2,
  clusterMinWallets: 2,
  minWalletsForTrade: 2,
  requireConvergenceForNormal: true,
};

/** Scalper Suite thresholds — Standard (balanced speed). */
export const SCALPER_SUITE_THRESHOLDS: StrategyPresetThresholds = {
  ...QUICK_SCALPER_THRESHOLDS,
  minConvictionScore: 26,
  minVolume24hUsd: 15_000,
  minRecentVolumeUsd: 1_500,
  maxTradesPerHour: 36,
  minMsBetweenTrades: 8_000,
  allowSingleWalletMigration: true,
  requireConvergenceForNormal: false,
};

/** Aggressive Scalper — relaxed volume / liquidity (still above hard floors). */
export const AGGRESSIVE_SCALPER_THRESHOLDS: StrategyPresetThresholds = {
  ...SCALPER_SUITE_THRESHOLDS,
  minConvictionScore: 22,
  minLiquidity: 8_000,
  minVolume24hUsd: 15_000,
  minRecentVolumeUsd: 1_500,
  minHolders: 120,
  minHolderCount: 120,
  maxTradesPerHour: 48,
  minMsBetweenTrades: 6_000,
  deadVolumeUsdPerHour: 60,
  deadVolumeConsecutiveHours: 1,
  deadVolumeMinHoldMinutes: 5,
};

/** Conservative Scalper — stricter volume/liquidity + aggressive dead-market. */
export const CONSERVATIVE_SCALPER_THRESHOLDS: StrategyPresetThresholds = {
  ...SCALPER_SUITE_THRESHOLDS,
  minConvictionScore: 32,
  minWalletQualityScore: 50,
  minLiquidity: 10_000,
  minVolume24hUsd: 20_000,
  minRecentVolumeUsd: 2_000,
  minHolders: 150,
  minHolderCount: 150,
  maxTradesPerHour: 20,
  minMsBetweenTrades: 15_000,
  deadVolumeUsdPerHour: 100,
  deadVolumeConsecutiveHours: 1,
  deadVolumeMinHoldMinutes: 3,
};

function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function captureStrategyProfileKnobs(): StrategyProfileKnobs {
  ensureStrategyToggles();
  return {
    strategyToggles: { ...config.strategyToggles } as StrategyToggleMap,
    filters: {
      enableAntiRug: config.filters.enableAntiRug !== false,
      checkHoneypot: config.filters.checkHoneypot !== false,
      enableSniperFilter: config.filters.enableSniperFilter !== false,
      sniperSensitivity:
        config.filters.sniperSensitivity === 'low' ||
        config.filters.sniperSensitivity === 'high'
          ? config.filters.sniperSensitivity
          : 'medium',
      enableSocialSentimentFilter:
        config.filters.enableSocialSentimentFilter === true,
      socialSentimentSensitivity:
        config.filters.socialSentimentSensitivity === 'low' ||
        config.filters.socialSentimentSensitivity === 'high'
          ? config.filters.socialSentimentSensitivity
          : 'medium',
      enableTrendingNarrativeBoost:
        config.filters.enableTrendingNarrativeBoost === true,
      trendingNarrativeSensitivity:
        config.filters.trendingNarrativeSensitivity === 'low' ||
        config.filters.trendingNarrativeSensitivity === 'high'
          ? config.filters.trendingNarrativeSensitivity
          : 'medium',
      trendingNarrativeBoostPoints: Math.max(
        1,
        Math.min(20, Number(config.filters.trendingNarrativeBoostPoints) || 6)
      ),
      enableVolumeSpikeFilter:
        config.filters.enableVolumeSpikeFilter === true,
      volumeSpikeSensitivity:
        config.filters.volumeSpikeSensitivity === 'low' ||
        config.filters.volumeSpikeSensitivity === 'high'
          ? config.filters.volumeSpikeSensitivity
          : 'medium',
      volumeSpikeWindowMinutes: Math.max(
        1,
        Math.min(15, Number(config.filters.volumeSpikeWindowMinutes) || 3)
      ),
      volumeSpikeMultiplier: Math.max(
        1.5,
        Math.min(8, Number(config.filters.volumeSpikeMultiplier) || 3)
      ),
      volumeSpikeBuySidePct: Math.max(
        50,
        Math.min(90, Number(config.filters.volumeSpikeBuySidePct) || 65)
      ),
      volumeSpikeMinUsd: Math.max(
        0,
        Number(config.filters.volumeSpikeMinUsd) || 2_500
      ),
      volumeSpikeBoostPoints: Math.max(
        1,
        Math.min(20, Number(config.filters.volumeSpikeBoostPoints) || 8)
      ),
      volumeSpikeHardFilter: config.filters.volumeSpikeHardFilter !== false,
      enableConfirmationLayer:
        config.filters.enableConfirmationLayer === true,
      confirmationSensitivity:
        config.filters.confirmationSensitivity === 'low' ||
        config.filters.confirmationSensitivity === 'high'
          ? config.filters.confirmationSensitivity
          : 'medium',
      confirmationVolumeWeight: Math.max(
        0,
        Math.min(100, Number(config.filters.confirmationVolumeWeight) || 50)
      ),
      confirmationSentimentWeight: Math.max(
        0,
        Math.min(100, Number(config.filters.confirmationSentimentWeight) || 25)
      ),
      confirmationNarrativeWeight: Math.max(
        0,
        Math.min(100, Number(config.filters.confirmationNarrativeWeight) || 25)
      ),
      confirmationBoostPoints: Math.max(
        1,
        Math.min(22, Number(config.filters.confirmationBoostPoints) || 10)
      ),
      confirmationHardFilter: config.filters.confirmationHardFilter === true,
      enableActivityFilter: config.filters.enableActivityFilter !== false,
      enableWalletQualityGate:
        config.filters.enableWalletQualityGate !== false,
      minWalletQualityScore: config.filters.minWalletQualityScore ?? 55,
      enableEntryTimingGate: config.filters.enableEntryTimingGate !== false,
      maxEntryAgeMinutes: config.filters.maxEntryAgeMinutes ?? 15,
      preferEntryWithinMinutes: config.filters.preferEntryWithinMinutes ?? 10,
      requireMomentumConfirmation:
        config.filters.requireMomentumConfirmation === true,
      smartMoneyFlowWeight: config.filters.smartMoneyFlowWeight ?? 1.35,
      convergenceRequired: config.filters.convergenceRequired ?? 2,
      clusterMinWallets: config.filters.clusterMinWallets ?? 2,
      allowSingleWalletTopPerformerMigration:
        config.filters.allowSingleWalletTopPerformerMigration !== false,
      minLiquidity: config.filters.minLiquidity ?? 10_000,
      minMarketCapUsd: config.filters.minMarketCapUsd ?? 8_000,
      minVolume24hUsd: config.filters.minVolume24hUsd ?? 25_000,
      minRecentVolumeUsd: config.filters.minRecentVolumeUsd ?? 2_500,
      minHolders: config.filters.minHolders ?? 120,
      minHolderCount: config.filters.minHolderCount ?? 120,
      minRecentActivity: config.filters.minRecentActivity ?? 10,
      maxRiskScore: config.filters.maxRiskScore ?? 78,
      maxDevHoldPct: config.filters.maxDevHoldPct ?? 14,
      maxHolderConcentration: config.filters.maxHolderConcentration ?? 70,
      skipIfDevRecentSells: config.filters.skipIfDevRecentSells !== false,
      maxConcurrentPositions: config.filters.maxConcurrentPositions ?? 5,
    },
    selective: {
      enabled: config.selective.enabled !== false,
      minConvictionScore: config.selective.minConvictionScore ?? 40,
      minWalletsForTrade: config.selective.minWalletsForTrade ?? 2,
      requireConvergenceForNormal:
        config.selective.requireConvergenceForNormal !== false,
      allowSingleWalletMigration:
        config.selective.allowSingleWalletMigration !== false,
      maxTradesPerHour: config.selective.maxTradesPerHour ?? 16,
      minMsBetweenTrades: config.selective.minMsBetweenTrades ?? 25_000,
    },
    strategy: {
      enableConvergence: config.strategy.enableConvergence !== false,
      enableMigrationPriority:
        config.strategy.enableMigrationPriority !== false,
      enableBondingCurvePriority:
        config.strategy.enableBondingCurvePriority !== false,
      enableEarlyCurvePriority:
        config.strategy.enableEarlyCurvePriority !== false,
      reBuyEnabled: config.strategy.reBuyEnabled !== false,
      postStopReentryEnabled: config.strategy.postStopReentryEnabled !== false,
      confirmationThreshold: config.strategy.confirmationThreshold ?? 3,
    },
    risk: {
      enableDeadVolumeExit: config.risk.enableDeadVolumeExit !== false,
      deadVolumeUsdPerHour: config.risk.deadVolumeUsdPerHour ?? 50,
      deadVolumeConsecutiveHours: config.risk.deadVolumeConsecutiveHours ?? 3,
      deadVolumeMinHoldMinutes: config.risk.deadVolumeMinHoldMinutes ?? 30,
      enabled: config.risk.enabled !== false,
      useRiskSizing: config.risk.useRiskSizing !== false,
    },
    bondingCurve: {
      requireHealthyCurve: config.bondingCurve.requireHealthyCurve === true,
      requireRecentCurveActivity:
        config.bondingCurve.requireRecentCurveActivity !== false,
    },
    profitStrategy: {
      enabled: config.profitStrategy.enabled !== false,
      takeInitialPercent: config.profitStrategy.takeInitialPercent ?? 95,
      partialSellAt: config.profitStrategy.partialSellAt ?? 55,
      partialSellPercent: config.profitStrategy.partialSellPercent ?? 42,
      trailingStopAfter: config.profitStrategy.trailingStopAfter ?? 110,
      trailingStopPct: config.profitStrategy.trailingStopPct ?? 21,
      bagPercent: config.profitStrategy.bagPercent ?? 28,
    },
    mev: { enableMEVProtection: config.mev.enableMEVProtection === true },
    quickScalper: {
      enabled: config.quickScalper?.enabled === true,
      timeLimitMinutes:
        config.quickScalper?.timeLimitMinutes === 1 ||
        config.quickScalper?.timeLimitMinutes === 3
          ? config.quickScalper.timeLimitMinutes
          : 2,
      takeProfitPct:
        config.quickScalper?.takeProfitPct ?? DEFAULT_QUICK_SCALPER.takeProfitPct,
      stopLossPct:
        config.quickScalper?.stopLossPct ?? DEFAULT_QUICK_SCALPER.stopLossPct,
      minVolumeUsd:
        config.quickScalper?.minVolumeUsd ?? DEFAULT_QUICK_SCALPER.minVolumeUsd,
      minBuyPressureUsd:
        config.quickScalper?.minBuyPressureUsd ??
        DEFAULT_QUICK_SCALPER.minBuyPressureUsd,
    },
    microScalper: {
      enabled: config.microScalper?.enabled === true,
      timeLimitSeconds:
        config.microScalper?.timeLimitSeconds ??
        DEFAULT_MICRO_SCALPER.timeLimitSeconds,
      takeProfitPct:
        config.microScalper?.takeProfitPct ?? DEFAULT_MICRO_SCALPER.takeProfitPct,
      stopLossPct:
        config.microScalper?.stopLossPct ?? DEFAULT_MICRO_SCALPER.stopLossPct,
      minVolumeUsd:
        config.microScalper?.minVolumeUsd ?? DEFAULT_MICRO_SCALPER.minVolumeUsd,
      minBuyPressureUsd:
        config.microScalper?.minBuyPressureUsd ??
        DEFAULT_MICRO_SCALPER.minBuyPressureUsd,
    },
    momentumBurst: {
      enabled: config.momentumBurst?.enabled === true,
      timeLimitSeconds: (() => {
        const sec = Number(config.momentumBurst?.timeLimitSeconds);
        if (Number.isFinite(sec) && sec >= 60) return Math.min(300, Math.round(sec));
        const mins = Number(config.momentumBurst?.timeLimitMinutes);
        if ([2, 3, 4].includes(mins)) return mins * 60;
        return DEFAULT_MOMENTUM_BURST.timeLimitSeconds;
      })(),
      takeProfitPct:
        config.momentumBurst?.takeProfitPct ??
        DEFAULT_MOMENTUM_BURST.takeProfitPct,
      stopLossPct:
        config.momentumBurst?.stopLossPct ?? DEFAULT_MOMENTUM_BURST.stopLossPct,
      minVolumeUsd:
        config.momentumBurst?.minVolumeUsd ?? DEFAULT_MOMENTUM_BURST.minVolumeUsd,
      minBuyPressureUsd:
        config.momentumBurst?.minBuyPressureUsd ??
        DEFAULT_MOMENTUM_BURST.minBuyPressureUsd,
      momentumFailDropPct:
        config.momentumBurst?.momentumFailDropPct ??
        DEFAULT_MOMENTUM_BURST.momentumFailDropPct,
    },
    postMigrationScalp: {
      enabled: config.postMigrationScalp?.enabled === true,
      timeLimitSeconds: (() => {
        const sec = Number(config.postMigrationScalp?.timeLimitSeconds);
        if (Number.isFinite(sec) && sec >= 90) return Math.min(180, Math.round(sec));
        const mins = Number(config.postMigrationScalp?.timeLimitMinutes);
        if ([1, 2, 3].includes(mins)) return mins * 60;
        return DEFAULT_POST_MIGRATION_SCALP.timeLimitSeconds;
      })(),
      takeProfitPct:
        config.postMigrationScalp?.takeProfitPct ??
        DEFAULT_POST_MIGRATION_SCALP.takeProfitPct,
      stopLossPct:
        config.postMigrationScalp?.stopLossPct ??
        DEFAULT_POST_MIGRATION_SCALP.stopLossPct,
      minVolumeUsd:
        config.postMigrationScalp?.minVolumeUsd ??
        DEFAULT_POST_MIGRATION_SCALP.minVolumeUsd,
      minBuyPressureUsd:
        config.postMigrationScalp?.minBuyPressureUsd ??
        DEFAULT_POST_MIGRATION_SCALP.minBuyPressureUsd,
    },
    reversalScalp: {
      enabled: config.reversalScalp?.enabled === true,
      timeLimitSeconds: (() => {
        const sec = Number(config.reversalScalp?.timeLimitSeconds);
        if (Number.isFinite(sec) && sec >= 60) return Math.min(150, Math.round(sec));
        const mins = Number(config.reversalScalp?.timeLimitMinutes);
        if ([1, 2].includes(mins)) return mins * 60;
        return DEFAULT_REVERSAL_SCALP.timeLimitSeconds;
      })(),
      takeProfitPct:
        config.reversalScalp?.takeProfitPct ?? DEFAULT_REVERSAL_SCALP.takeProfitPct,
      stopLossPct:
        config.reversalScalp?.stopLossPct ?? DEFAULT_REVERSAL_SCALP.stopLossPct,
      minVolumeUsd:
        config.reversalScalp?.minVolumeUsd ?? DEFAULT_REVERSAL_SCALP.minVolumeUsd,
      minBuyPressureUsd:
        config.reversalScalp?.minBuyPressureUsd ??
        DEFAULT_REVERSAL_SCALP.minBuyPressureUsd,
      minDropFromPeakPct:
        config.reversalScalp?.minDropFromPeakPct ??
        DEFAULT_REVERSAL_SCALP.minDropFromPeakPct,
      minConvictionScore:
        config.reversalScalp?.minConvictionScore ??
        DEFAULT_REVERSAL_SCALP.minConvictionScore,
    },
    postRunDip: {
      enabled: config.postRunDip?.enabled === true,
      sensitivity:
        config.postRunDip?.sensitivity === 'low' ||
        config.postRunDip?.sensitivity === 'high'
          ? config.postRunDip.sensitivity
          : 'medium',
      timeLimitMinutes: Math.max(
        30,
        Math.min(240, Number(config.postRunDip?.timeLimitMinutes) || 90)
      ),
      takeProfitPct:
        config.postRunDip?.takeProfitPct ?? DEFAULT_POST_RUN_DIP.takeProfitPct,
      stopLossPct:
        config.postRunDip?.stopLossPct ?? DEFAULT_POST_RUN_DIP.stopLossPct,
      minRunPct: config.postRunDip?.minRunPct ?? DEFAULT_POST_RUN_DIP.minRunPct,
      minDipFromPeakPct:
        config.postRunDip?.minDipFromPeakPct ??
        DEFAULT_POST_RUN_DIP.minDipFromPeakPct,
      maxDipFromPeakPct:
        config.postRunDip?.maxDipFromPeakPct ??
        DEFAULT_POST_RUN_DIP.maxDipFromPeakPct,
      preferNearTechnicals: config.postRunDip?.preferNearTechnicals !== false,
      requireNearTechnicals: config.postRunDip?.requireNearTechnicals === true,
      hardRequireSetup: config.postRunDip?.hardRequireSetup === true,
      boostPoints:
        config.postRunDip?.boostPoints ?? DEFAULT_POST_RUN_DIP.boostPoints,
    },
  };
}

function applyStrategyProfileKnobs(knobs: StrategyProfileKnobs): void {
  config.strategyToggles = { ...knobs.strategyToggles };
  Object.assign(config.filters, knobs.filters);
  const preserveTradeCaps = ensureStrategyRecipeMode() === 'custom';
  const preservedMaxTradesPerHour = config.selective.maxTradesPerHour;
  const preservedMinMsBetweenTrades = config.selective.minMsBetweenTrades;
  Object.assign(config.selective, knobs.selective);
  if (preserveTradeCaps) {
    config.selective.maxTradesPerHour = preservedMaxTradesPerHour;
    config.selective.minMsBetweenTrades = preservedMinMsBetweenTrades;
  }
  Object.assign(config.strategy, knobs.strategy);
  Object.assign(config.risk, knobs.risk);
  Object.assign(config.bondingCurve, knobs.bondingCurve);
  if (knobs.profitStrategy) {
    Object.assign(config.profitStrategy, knobs.profitStrategy);
  }
  config.mev.enableMEVProtection = knobs.mev.enableMEVProtection;
  if (knobs.quickScalper) {
    Object.assign(config.quickScalper, knobs.quickScalper);
  }
  if (knobs.microScalper) {
    Object.assign(config.microScalper, knobs.microScalper);
  }
  if (knobs.momentumBurst) {
    Object.assign(config.momentumBurst, knobs.momentumBurst);
  }
  if (knobs.postMigrationScalp) {
    Object.assign(config.postMigrationScalp, knobs.postMigrationScalp);
  }
  if (knobs.reversalScalp) {
    Object.assign(config.reversalScalp, knobs.reversalScalp);
  }
  if (knobs.postRunDip) {
    Object.assign(config.postRunDip, knobs.postRunDip);
  }
  // Never undercut absolute floors (Risk OFF may zero floors intentionally)
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
  config.filters.minHolders = Math.max(
    config.filters.minHolders ?? 0,
    HARD_FILTER_FLOORS.minHolders
  );
  config.filters.minHolderCount = Math.max(
    config.filters.minHolderCount ?? 0,
    HARD_FILTER_FLOORS.minHolders
  );
  }
}

/**
 * Sync underlying config flags so legacy checks stay aligned with the
 * strategy master toggles (Risk Level / Strict still set thresholds).
 */
export function syncUnderlyingFlagsFromToggles(
  toggles: StrategyToggleMap
): void {
  config.strategy.enableConvergence =
    toggles.wallet_convergence || toggles.elite_convergence;
  config.strategy.enableMigrationPriority = toggles.migration_priority;
  config.strategy.enableBondingCurvePriority = toggles.near_migration_curve;
  config.strategy.enableEarlyCurvePriority = toggles.early_curve_smart_money;
  config.strategy.reBuyEnabled = toggles.rebuy_on_dip;
  config.strategy.postStopReentryEnabled = toggles.rebuy_on_dip;
  config.filters.enableAntiRug = toggles.anti_rug_honeypot;
  if (toggles.anti_rug_honeypot) {
    config.filters.checkHoneypot = true;
  }
  config.bondingCurve.requireHealthyCurve = toggles.bonding_curve_health;
  config.filters.enableActivityFilter = toggles.min_holders_activity;
  config.risk.enableDeadVolumeExit =
    toggles.dead_market_exit || toggles.profit_protected;
  if (toggles.dynamic_position_sizing) {
    config.risk.enabled = true;
    config.risk.useRiskSizing = true;
  } else {
    config.risk.useRiskSizing = false;
  }
  config.profitStrategy.enabled =
    toggles.tiered_profit_taking || toggles.profit_protected;
  config.filters.enableWalletQualityGate =
    toggles.wallet_quality_scoring ||
    toggles.hard_quality_gate ||
    toggles.elite_convergence ||
    toggles.profit_protected;
  config.selective.enabled =
    toggles.multi_factor_conviction ||
    toggles.elite_convergence ||
    toggles.profit_protected;
  config.filters.enableEntryTimingGate =
    toggles.time_based_entry ||
    toggles.early_entry_only ||
    toggles.elite_convergence;
  config.filters.enableSniperFilter = toggles.sniper_bundler_filters;
  config.filters.enableSocialSentimentFilter = toggles.social_sentiment_filter;
  config.filters.enableTrendingNarrativeBoost =
    toggles.trending_narrative_boost;
  config.filters.enableVolumeSpikeFilter = toggles.volume_spike_filter;
  config.filters.enableConfirmationLayer = toggles.confirmation_layer;
  config.filters.enableMarketSessionFilter = toggles.market_session_filter;
  config.postRunDip.enabled = toggles.post_run_dip === true;
  config.filters.enablePostRunDip = toggles.post_run_dip === true;
  config.technicalLevels.enabled = toggles.technical_levels === true;
  if (!config.chartPatterns) {
    config.chartPatterns = {
      ...DEFAULT_CHART_PATTERNS,
      patterns: { ...DEFAULT_CHART_PATTERNS.patterns },
    };
  }
  const corePatternMap: Array<[keyof typeof config.chartPatterns.patterns, StrategyKey]> = [
    ['volume_dryup_return', 'pattern_volume_dryup_return'],
    ['falling_wedge', 'pattern_falling_wedge'],
    ['structured_pullback', 'pattern_structured_pullback'],
    ['bull_flag', 'pattern_bull_flag'],
    ['trend_continuation', 'pattern_trend_continuation'],
  ];
  for (const [id, key] of corePatternMap) {
    if (!config.chartPatterns.patterns[id]) {
      config.chartPatterns.patterns[id] = { enabled: false };
    }
    config.chartPatterns.patterns[id].enabled = toggles[key] === true;
  }
  // Extras umbrella (triangles, TL break, distribution, capitulation)
  const extrasOn = toggles.chart_patterns === true;
  for (const id of [
    'ascending_triangle',
    'descending_triangle',
    'trendline_break',
    'holder_distribution',
    'capitulation',
  ] as const) {
    if (!config.chartPatterns.patterns[id]) {
      config.chartPatterns.patterns[id] = { enabled: false };
    }
    config.chartPatterns.patterns[id].enabled = extrasOn;
  }
  const anyCore = corePatternMap.some(([, key]) => toggles[key] === true);
  config.chartPatterns.enabled = anyCore || extrasOn;
  config.mev.enableMEVProtection = toggles.mev_protection;
  config.filters.requireMomentumConfirmation =
    toggles.momentum_confirmation ||
    toggles.elite_convergence ||
    toggles.profit_protected;
  if (toggles.smart_money_flow_weighting) {
    if ((config.filters.smartMoneyFlowWeight ?? 1) <= 1) {
      config.filters.smartMoneyFlowWeight = 1.35;
    }
  } else {
    config.filters.smartMoneyFlowWeight = 1;
  }
  config.quickScalper.enabled = toggles.quick_scalper === true;
  config.microScalper.enabled = toggles.micro_scalper === true;
  config.momentumBurst.enabled = toggles.momentum_burst === true;
  config.postMigrationScalp.enabled = toggles.post_migration_scalp === true;
  config.reversalScalp.enabled = toggles.reversal_scalp === true;
  if (config.marketScanner) {
    config.marketScanner.enabled = toggles.ta_market_scanner !== false;
  }
  const anyShortTermScalp =
    toggles.quick_scalper ||
    toggles.micro_scalper ||
    toggles.momentum_burst ||
    toggles.post_migration_scalp ||
    toggles.reversal_scalp;
  // Scalps use fixed TP/SL/timer — disable tiered profit when a short-term mode owns exits
  if (
    anyShortTermScalp &&
    !toggles.tiered_profit_taking &&
    !toggles.profit_protected
  ) {
    config.profitStrategy.enabled = false;
  }
}

/** Floors applied when high-quality mode toggles are ON (stack with Risk/Strict). */
export const QUALITY_MODE_FLOORS = {
  eliteConvergence: {
    clusterMinWallets: 4,
    minConvictionScore: 65,
    minWalletQualityScore: 62,
  },
  hardQualityGate: {
    minWalletQualityScore: 68,
  },
  earlyEntryOnly: {
    maxEntryAgeMinutes: 8,
    preferEntryWithinMinutes: 5,
  },
  profitProtected: {
    minConvictionScore: 58,
    minWalletQualityScore: 60,
    deadVolumeConsecutiveHours: 1,
    deadVolumeMinHoldMinutes: 12,
  },
} as const;

export interface QualityModeOverlays {
  minClusterWallets: number | null;
  minWalletQualityScore: number | null;
  minConvictionScore: number | null;
  maxEntryAgeMinutes: number | null;
  preferEntryWithinMinutes: number | null;
  requireMigrationOrNear: boolean;
  blockSingleWalletEntries: boolean;
  forceMomentum: boolean;
  aggressiveDeadExit: boolean;
}

/** Live overlays from Elite Convergence / Hard Quality / Early Entry / Profit-Protected / Migration Sniper. */
export function getQualityModeOverlays(): QualityModeOverlays {
  ensureStrategyToggles();
  const elite = isStrategyEnabled('elite_convergence');
  const hardQ = isStrategyEnabled('hard_quality_gate');
  const early = isStrategyEnabled('early_entry_only');
  const profit = isStrategyEnabled('profit_protected');
  const migSniper = isStrategyEnabled('migration_sniper');
  const winRateProfile = config.strategyProfile === 'high_win_rate';
  const winRate55Profile = config.strategyProfile === 'win_rate_55_60';

  let minCluster: number | null = null;
  let minQuality: number | null = null;
  let minConviction: number | null = null;
  let maxAge: number | null = null;
  let preferWithin: number | null = null;

  if (elite) {
    if (winRateProfile) {
      minCluster = HIGH_WIN_RATE_THRESHOLDS.clusterMinWallets;
      minConviction = HIGH_WIN_RATE_THRESHOLDS.minConvictionScore;
      minQuality = HIGH_WIN_RATE_THRESHOLDS.minWalletQualityScore;
    } else if (winRate55Profile) {
      minCluster = WIN_RATE_55_60_THRESHOLDS.clusterMinWallets;
      minConviction = WIN_RATE_55_60_THRESHOLDS.minConvictionScore;
      minQuality = WIN_RATE_55_60_THRESHOLDS.minWalletQualityScore;
    } else {
      minCluster = QUALITY_MODE_FLOORS.eliteConvergence.clusterMinWallets;
      minConviction = QUALITY_MODE_FLOORS.eliteConvergence.minConvictionScore;
      minQuality = QUALITY_MODE_FLOORS.eliteConvergence.minWalletQualityScore;
    }
  }
  if (hardQ) {
    minQuality = Math.max(
      minQuality ?? 0,
      QUALITY_MODE_FLOORS.hardQualityGate.minWalletQualityScore
    );
  }
  if (profit) {
    minConviction = Math.max(
      minConviction ?? 0,
      winRateProfile
        ? HIGH_WIN_RATE_THRESHOLDS.minConvictionScore
        : winRate55Profile
          ? WIN_RATE_55_60_THRESHOLDS.minConvictionScore
          : QUALITY_MODE_FLOORS.profitProtected.minConvictionScore
    );
    minQuality = Math.max(
      minQuality ?? 0,
      winRateProfile
        ? HIGH_WIN_RATE_THRESHOLDS.minWalletQualityScore
        : winRate55Profile
          ? WIN_RATE_55_60_THRESHOLDS.minWalletQualityScore
          : QUALITY_MODE_FLOORS.profitProtected.minWalletQualityScore
    );
  }
  if (early) {
    if (winRateProfile) {
      maxAge = HIGH_WIN_RATE_THRESHOLDS.maxEntryAgeMinutes;
      preferWithin = HIGH_WIN_RATE_THRESHOLDS.preferEntryWithinMinutes;
    } else if (winRate55Profile) {
      maxAge = WIN_RATE_55_60_THRESHOLDS.maxEntryAgeMinutes;
      preferWithin = WIN_RATE_55_60_THRESHOLDS.preferEntryWithinMinutes;
    } else {
      maxAge = QUALITY_MODE_FLOORS.earlyEntryOnly.maxEntryAgeMinutes;
      preferWithin = QUALITY_MODE_FLOORS.earlyEntryOnly.preferEntryWithinMinutes;
    }
  }

  // Multi-Profile ON: Migration Sniper trade profile owns fresh grads — do not
  // hard-filter every entry to migration/near (that forced only 🚀 stamps).
  const multiProfileOn = config.tradeProfiles?.enabled !== false;
  return {
    minClusterWallets: minCluster,
    minWalletQualityScore: minQuality && minQuality > 0 ? minQuality : null,
    minConvictionScore:
      minConviction && minConviction > 0 ? minConviction : null,
    maxEntryAgeMinutes: maxAge,
    preferEntryWithinMinutes: preferWithin,
    requireMigrationOrNear: migSniper && !multiProfileOn,
    // Elite blocks single-wallet; 55–60 keeps convergence flexible (elite off)
    blockSingleWalletEntries: elite && !winRate55Profile,
    // Momentum mandatory only for strict 60%+ / elite / profit-protected
    forceMomentum: (elite || profit || winRateProfile) && !winRate55Profile,
    aggressiveDeadExit: profit || winRateProfile || winRate55Profile,
  };
}

function applyStrategyPresetThresholds(t: StrategyPresetThresholds): void {
  const floorsOff = config.riskLevel === 'off';
  config.filters.minWalletQualityScore = t.minWalletQualityScore;
  config.filters.enableWalletQualityGate = !floorsOff;
  config.selective.enabled = !floorsOff;
  config.selective.minConvictionScore = t.minConvictionScore;
  config.selective.minWalletsForTrade = t.minWalletsForTrade;
  config.selective.requireConvergenceForNormal = t.requireConvergenceForNormal;
  config.selective.allowSingleWalletMigration = t.allowSingleWalletMigration;
  // Custom recipe: do not overwrite operator Trade Caps from bake/preset thresholds.
  if (ensureStrategyRecipeMode() !== 'custom') {
  config.selective.maxTradesPerHour = t.maxTradesPerHour;
  config.selective.minMsBetweenTrades = t.minMsBetweenTrades;
  }
  config.filters.convergenceRequired = t.convergenceRequired;
  config.filters.clusterMinWallets = t.clusterMinWallets;
  config.filters.allowSingleWalletTopPerformerMigration =
    t.allowSingleWalletTopPerformerMigration;
  config.strategy.enableConvergence = !floorsOff;
  config.strategy.confirmationThreshold = t.confirmationThreshold;
  if (floorsOff) {
    config.filters.minLiquidity = Math.max(0, t.minLiquidity);
    config.filters.minMarketCapUsd = Math.max(0, t.minMarketCapUsd);
    config.filters.minVolume24hUsd = Math.max(0, t.minVolume24hUsd);
    config.filters.minRecentVolumeUsd = Math.max(0, t.minRecentVolumeUsd);
    config.filters.minHolders = Math.max(0, t.minHolders);
    config.filters.minHolderCount = Math.max(0, t.minHolderCount);
    config.filters.minRecentActivity = Math.max(0, t.minRecentActivity);
  } else {
  config.filters.minLiquidity = Math.max(
    t.minLiquidity,
    HARD_FILTER_FLOORS.minLiquidityUsd
  );
  config.filters.minMarketCapUsd = Math.max(
    t.minMarketCapUsd,
    HARD_FILTER_FLOORS.minMarketCapUsd
  );
  config.filters.minVolume24hUsd = Math.max(
    t.minVolume24hUsd,
    HARD_FILTER_FLOORS.minVolume24hUsd
  );
  config.filters.minRecentVolumeUsd = Math.max(
    t.minRecentVolumeUsd,
    HARD_FILTER_FLOORS.minRecentVolumeUsd
  );
  config.filters.minHolders = Math.max(
    t.minHolders,
    HARD_FILTER_FLOORS.minHolders
  );
  config.filters.minHolderCount = Math.max(
    t.minHolderCount,
    HARD_FILTER_FLOORS.minHolders
  );
  config.filters.minRecentActivity = Math.max(
    t.minRecentActivity,
    HARD_FILTER_FLOORS.minRecentActivityTxns
  );
  }
  config.filters.maxRiskScore = t.maxRiskScore;
  config.filters.maxDevHoldPct = t.maxDevHoldPct;
  config.filters.maxDevPercent = t.maxDevHoldPct;
  config.filters.maxHolderConcentration = t.maxHolderConcentration;
  config.filters.enableAntiRug = !floorsOff;
  config.filters.checkHoneypot = !floorsOff;
  config.filters.skipIfDevRecentSells = !floorsOff;
  config.filters.enableSniperFilter = !floorsOff;
  config.filters.sniperSensitivity = t.sniperSensitivity;
  config.filters.enableEntryTimingGate = !floorsOff;
  config.filters.maxEntryAgeMinutes = t.maxEntryAgeMinutes;
  config.filters.preferEntryWithinMinutes = t.preferEntryWithinMinutes;
  config.filters.requireMomentumConfirmation = t.requireMomentumConfirmation;
  config.filters.smartMoneyFlowWeight = t.smartMoneyFlowWeight;
  config.bondingCurve.requireHealthyCurve = t.requireHealthyCurve;
  config.bondingCurve.requireRecentCurveActivity =
    t.requireRecentCurveActivity;
  config.risk.enableDeadVolumeExit = !floorsOff;
  config.risk.deadVolumeUsdPerHour = t.deadVolumeUsdPerHour;
  config.risk.deadVolumeConsecutiveHours = t.deadVolumeConsecutiveHours;
  config.risk.deadVolumeMinHoldMinutes = t.deadVolumeMinHoldMinutes;
  config.risk.enabled = true;
  config.risk.useRiskSizing = true;
  config.profitStrategy.enabled = true;
  config.mev.enableMEVProtection = true;
  config.strategy.enableEarlyCurvePriority = t.enableEarlyCurvePriority;
  config.strategy.reBuyEnabled = t.reBuyEnabled;
  config.strategy.postStopReentryEnabled = t.postStopReentryEnabled;
}

/**
 * Snapshot current knobs before applying a named preset.
 * Hopping between named presets keeps an existing custom snapshot so
 * Restore Previous still returns to the last manual overrides.
 */
function snapshotBeforeNamedPreset(target: NamedStrategyProfileId): void {
  if (config.strategyProfile === target) return;
  const leavingNamed = isNamedStrategyProfile(config.strategyProfile);
  const hasSnap = Boolean(config.strategyProfileSnapshot?.knobs);
  if (leavingNamed && hasSnap) return;
  config.strategyProfileSnapshot = {
    savedAt: Date.now(),
    fromProfile: (config.strategyProfile || 'custom') as StrategyProfileId,
    knobs: captureStrategyProfileKnobs() as unknown as Record<string, unknown>,
  };
}

function applyNamedStrategyPreset(
  profile: NamedStrategyProfileId,
  toggles: StrategyToggleMap,
  thresholds: StrategyPresetThresholds,
  options?: { persist?: boolean }
): {
  toggles: StrategyToggleMap;
  profile: NamedStrategyProfileId;
  description: string;
  warning: string | null;
  thresholds: StrategyPresetThresholds;
  restoredAvailable: boolean;
} {
  ensureStrategyToggles();
  snapshotBeforeNamedPreset(profile);
  updateStrategyToggles(
    { ...toggles },
    { persist: false, syncUnderlying: true, markCustom: false }
  );
  applyStrategyPresetThresholds(thresholds);
  // Re-sync toggles after threshold writes that touch overlapping flags
  syncUnderlyingFlagsFromToggles(config.strategyToggles as StrategyToggleMap);
  config.strategyProfile = profile;
  config.highWinRatePresetActive = profile === 'high_win_rate';
  // Packs are advanced overrides — leave Risk recipe sync
  config.strategyRecipeMode = 'custom';
  if (options?.persist !== false) persistUserSettings();
  const meta = STRATEGY_PRESET_META[profile];
  console.log(
    `[strategies] ${meta.label} preset ON — conviction≥${thresholds.minConvictionScore} ` +
      `wallets≥${thresholds.clusterMinWallets} quality≥${thresholds.minWalletQualityScore}` +
      ` · recipe mode → custom` +
      (meta.warning ? ` · ${meta.warning}` : '')
  );
  return {
    toggles: { ...config.strategyToggles } as StrategyToggleMap,
    profile,
    description: meta.description,
    warning: meta.warning ?? null,
    thresholds: { ...thresholds },
    restoredAvailable: Boolean(config.strategyProfileSnapshot),
  };
}

export function updateStrategyToggles(
  partial: Partial<StrategyToggleMap>,
  options?: { persist?: boolean; syncUnderlying?: boolean; markCustom?: boolean }
): StrategyToggleMap {
  const toggles = ensureStrategyToggles();
  for (const [key, value] of Object.entries(partial)) {
    if (!isStrategyKey(key) || typeof value !== 'boolean') continue;
    toggles[key] = value;
  }
  config.strategyToggles = { ...toggles };
  if (options?.syncUnderlying !== false) {
    syncUnderlyingFlagsFromToggles(config.strategyToggles as StrategyToggleMap);
  }
  if (options?.markCustom !== false) {
    config.strategyProfile = 'custom';
    config.highWinRatePresetActive = false;
    config.strategyRecipeMode = 'custom';
  }
  if (options?.persist !== false) {
    persistUserSettings();
  }
  return { ...config.strategyToggles } as StrategyToggleMap;
}

export function setAllStrategyToggles(
  enabled: boolean,
  options?: { persist?: boolean }
): StrategyToggleMap {
  const next = {} as StrategyToggleMap;
  for (const s of STRATEGY_REGISTRY) {
    next[s.key] = enabled;
  }
  return updateStrategyToggles(next, options);
}

/**
 * Apply 60%+ Win Rate Profile: selective toggles, exact quality thresholds,
 * aggressive dead-market exit, capped concurrency, runner-friendly profit
 * strategy, and soft Risk/Strict recommendations. User can fine-tune after.
 */
export function applyHighWinRatePreset(options?: {
  persist?: boolean;
}) {
  const result = applyNamedStrategyPreset(
    'high_win_rate',
    HIGH_WIN_RATE_PRESET,
    HIGH_WIN_RATE_THRESHOLDS,
    options
  );

  const d = HIGH_WIN_RATE_DEFAULTS;
  const t = HIGH_WIN_RATE_THRESHOLDS;

  // Cap concurrent positions (2–3 band; default 2 for fewer simultaneous bets)
  config.filters.maxConcurrentPositions = Math.max(
    2,
    Math.min(3, d.maxConcurrentPositions)
  );

  // Aggressive dead-market exit (also reinforced by profit_protected overlay)
  config.risk.enableDeadVolumeExit = true;
  config.risk.deadVolumeUsdPerHour = t.deadVolumeUsdPerHour;
  config.risk.deadVolumeConsecutiveHours = t.deadVolumeConsecutiveHours;
  config.risk.deadVolumeMinHoldMinutes = t.deadVolumeMinHoldMinutes;

  // Tiered profit: partial at +40–60%, trail 20–25% from peak, leave small bag
  config.profitStrategy.enabled = true;
  config.profitStrategy.partialSellAt = d.partialSellAt;
  config.profitStrategy.partialSellPercent = d.partialSellPercent;
  config.profitStrategy.trailingStopAfter = d.trailingStopAfter;
  config.profitStrategy.trailingStopPct = d.trailingStopPct;
  config.profitStrategy.bagPercent = d.bagPercent;
  config.profitStrategy.takeInitialPercent = d.takeInitialPercent;
  // Keep legacy trail knobs aligned when tiered path is temporarily off
  config.risk.trailingStopPct = d.trailingStopPct;
  config.risk.trailingStopPercent = d.trailingStopPct;

  const tips: string[] = [];
  config.riskLevel = normalizeRiskLevel(config.riskLevel);
  if (config.riskLevel === 'off') {
    tips.push('Risk is Off — named profile knobs applied; switch On for floors');
  } else {
    tips.push('Risk On — profile modules/thresholds applied');
  }

  if (options?.persist !== false) persistUserSettings();
  console.log(
    `[strategies] 60%+ Win Rate Profile ON — quality≥${t.minWalletQualityScore} ` +
      `conviction≥${t.minConvictionScore} cluster≥${t.clusterMinWallets} ` +
      `entry≤${t.maxEntryAgeMinutes}m liq≥$${t.minLiquidity} holders≥${t.minHolders} ` +
      `partial@+${d.partialSellAt}% trail ${d.trailingStopPct}% bag ${d.bagPercent}% ` +
      `maxPos=${config.filters.maxConcurrentPositions} · ` +
      tips.join(' · ')
  );
  return result;
}

/**
 * Apply 55–60% Win Rate Profile — more trades than strict 60%+, still quality-first.
 * Soft Risk Medium + Strict Medium/Low. Fine-tune after apply.
 */
export function applyWinRate55_60Preset(options?: { persist?: boolean }) {
  const result = applyNamedStrategyPreset(
    'win_rate_55_60',
    WIN_RATE_55_60_PRESET,
    WIN_RATE_55_60_THRESHOLDS,
    options
  );

  const d = WIN_RATE_55_60_DEFAULTS;
  const t = WIN_RATE_55_60_THRESHOLDS;

  config.filters.maxConcurrentPositions = Math.max(
    3,
    Math.min(4, d.maxConcurrentPositions)
  );

  config.risk.enableDeadVolumeExit = true;
  config.risk.deadVolumeUsdPerHour = t.deadVolumeUsdPerHour;
  config.risk.deadVolumeConsecutiveHours = t.deadVolumeConsecutiveHours;
  config.risk.deadVolumeMinHoldMinutes = t.deadVolumeMinHoldMinutes;

  config.profitStrategy.enabled = true;
  config.profitStrategy.partialSellAt = d.partialSellAt;
  config.profitStrategy.partialSellPercent = d.partialSellPercent;
  config.profitStrategy.trailingStopAfter = d.trailingStopAfter;
  config.profitStrategy.trailingStopPct = d.trailingStopPct;
  config.profitStrategy.bagPercent = d.bagPercent;
  config.profitStrategy.takeInitialPercent = d.takeInitialPercent;
  config.risk.trailingStopPct = d.trailingStopPct;
  config.risk.trailingStopPercent = d.trailingStopPct;

  const tips: string[] = [];
  config.riskLevel = normalizeRiskLevel(config.riskLevel);
  tips.push(
    `Risk ${config.riskLevel.toUpperCase()} — 55–60% profile knobs applied`
  );

  if (options?.persist !== false) persistUserSettings();
  console.log(
    `[strategies] 55–60% Win Rate Profile ON — quality≥${t.minWalletQualityScore} ` +
      `conviction≥${t.minConvictionScore} cluster≥${t.clusterMinWallets} ` +
      `entry≤${t.maxEntryAgeMinutes}m liq≥$${t.minLiquidity} holders≥${t.minHolders} ` +
      `partial@+${d.partialSellAt}% trail ${d.trailingStopPct}% bag ${d.bagPercent}% ` +
      `maxPos=${config.filters.maxConcurrentPositions} · ` +
      tips.join(' · ')
  );
  return result;
}

/** Restore knobs saved before the last named preset (custom overrides). */
export function restorePreviousStrategyProfile(options?: {
  persist?: boolean;
}): {
  ok: boolean;
  profile: StrategyProfileId;
  message: string;
} {
  const snap = config.strategyProfileSnapshot;
  if (!snap?.knobs) {
    return {
      ok: false,
      profile: config.strategyProfile || 'custom',
      message: 'No previous strategy snapshot to restore',
    };
  }
  applyStrategyProfileKnobs(
    cloneJson(snap.knobs) as unknown as StrategyProfileKnobs
  );
  const restored = isStrategyProfileId(snap.fromProfile)
    ? snap.fromProfile
    : 'custom';
  config.strategyProfile = restored;
  config.highWinRatePresetActive = restored === 'high_win_rate';
  config.strategyRecipeMode = 'custom';
  config.strategyProfileSnapshot = null;
  if (options?.persist !== false) persistUserSettings();
  console.log(
    `[strategies] Restored previous strategy profile (${config.strategyProfile})`
  );
  return {
    ok: true,
    profile: config.strategyProfile,
    message: 'Restored previous strategy settings',
  };
}

/** Balanced preset — quality + frequency mix. */
export function applyBalancedPreset(options?: { persist?: boolean }) {
  return applyNamedStrategyPreset(
    'balanced',
    BALANCED_PRESET,
    BALANCED_THRESHOLDS,
    options
  );
}

/** Aggressive preset — more trades, core filters kept. */
export function applyAggressivePreset(options?: { persist?: boolean }) {
  return applyNamedStrategyPreset(
    'aggressive',
    AGGRESSIVE_PRESET,
    AGGRESSIVE_THRESHOLDS,
    options
  );
}

/** Quick Scalper preset — timed holds with fixed TP / tight SL. */
export function applyQuickScalperPreset(options?: { persist?: boolean }) {
  const result = applyNamedStrategyPreset(
    'quick_scalper',
    QUICK_SCALPER_PRESET,
    QUICK_SCALPER_THRESHOLDS,
    options
  );
  config.quickScalper.enabled = true;
  if (
    config.quickScalper.timeLimitMinutes !== 1 &&
    config.quickScalper.timeLimitMinutes !== 2 &&
    config.quickScalper.timeLimitMinutes !== 3
  ) {
    config.quickScalper.timeLimitMinutes = DEFAULT_QUICK_SCALPER.timeLimitMinutes;
  }
  if (!(config.quickScalper.takeProfitPct > 0)) {
    config.quickScalper.takeProfitPct = DEFAULT_QUICK_SCALPER.takeProfitPct;
  }
  if (!(config.quickScalper.stopLossPct < 0)) {
    config.quickScalper.stopLossPct = DEFAULT_QUICK_SCALPER.stopLossPct;
  }
  if (options?.persist !== false) persistUserSettings();
  console.log(
    `[strategies] Quick Scalper — ${config.quickScalper.timeLimitMinutes}m ` +
      `TP +${config.quickScalper.takeProfitPct}% / SL ${config.quickScalper.stopLossPct}%`
  );
  return result;
}

/** Micro-Scalper preset — 30–90s ultra-fast timed holds. */
export function applyMicroScalperPreset(options?: { persist?: boolean }) {
  const result = applyNamedStrategyPreset(
    'micro_scalper',
    MICRO_SCALPER_PRESET,
    MICRO_SCALPER_THRESHOLDS,
    options
  );
  config.microScalper.enabled = true;
  let sec = Number(config.microScalper.timeLimitSeconds);
  if (!Number.isFinite(sec) || sec < 60 || sec > 90) {
    config.microScalper.timeLimitSeconds = DEFAULT_MICRO_SCALPER.timeLimitSeconds;
  }
  if (!(config.microScalper.takeProfitPct > 0)) {
    config.microScalper.takeProfitPct = DEFAULT_MICRO_SCALPER.takeProfitPct;
  }
  if (!(config.microScalper.stopLossPct < 0)) {
    config.microScalper.stopLossPct = DEFAULT_MICRO_SCALPER.stopLossPct;
  }
  if (options?.persist !== false) persistUserSettings();
  console.log(
    `[strategies] Micro-Scalper — ${config.microScalper.timeLimitSeconds}s ` +
      `TP +${config.microScalper.takeProfitPct}% / SL ${config.microScalper.stopLossPct}%`
  );
  return result;
}

/** Momentum Burst preset — timed momentum holds with fade exit. */
export function applyMomentumBurstPreset(options?: { persist?: boolean }) {
  const result = applyNamedStrategyPreset(
    'momentum_burst',
    MOMENTUM_BURST_PRESET,
    MOMENTUM_BURST_THRESHOLDS,
    options
  );
  config.momentumBurst.enabled = true;
  let sec = Number(config.momentumBurst.timeLimitSeconds);
  if (!Number.isFinite(sec) || sec < 60) {
    const legacy = Number(config.momentumBurst.timeLimitMinutes);
    sec = [2, 3, 4].includes(legacy)
      ? legacy * 60
      : DEFAULT_MOMENTUM_BURST.timeLimitSeconds;
  }
  config.momentumBurst.timeLimitSeconds = Math.max(90, Math.min(240, Math.round(sec)));
  if (!(config.momentumBurst.takeProfitPct > 0)) {
    config.momentumBurst.takeProfitPct = DEFAULT_MOMENTUM_BURST.takeProfitPct;
  }
  if (!(config.momentumBurst.stopLossPct < 0)) {
    config.momentumBurst.stopLossPct = DEFAULT_MOMENTUM_BURST.stopLossPct;
  }
  if (options?.persist !== false) persistUserSettings();
  console.log(
    `[strategies] Momentum Burst — ${config.momentumBurst.timeLimitSeconds}s ` +
      `TP +${config.momentumBurst.takeProfitPct}% / SL ${config.momentumBurst.stopLossPct}%`
  );
  return result;
}

/** Post-Migration Scalp preset — fresh migration timed holds. */
export function applyPostMigrationScalpPreset(options?: { persist?: boolean }) {
  const result = applyNamedStrategyPreset(
    'post_migration_scalp',
    POST_MIGRATION_SCALP_PRESET,
    POST_MIGRATION_SCALP_THRESHOLDS,
    options
  );
  config.postMigrationScalp.enabled = true;
  let pmsSec = Number(config.postMigrationScalp.timeLimitSeconds);
  if (!Number.isFinite(pmsSec) || pmsSec < 90) {
    const legacy = Number(config.postMigrationScalp.timeLimitMinutes);
    pmsSec = [1, 2, 3].includes(legacy)
      ? legacy * 60
      : DEFAULT_POST_MIGRATION_SCALP.timeLimitSeconds;
  }
  config.postMigrationScalp.timeLimitSeconds = Math.max(90, Math.min(180, pmsSec));
  if (!(config.postMigrationScalp.takeProfitPct > 0)) {
    config.postMigrationScalp.takeProfitPct =
      DEFAULT_POST_MIGRATION_SCALP.takeProfitPct;
  }
  if (!(config.postMigrationScalp.stopLossPct < 0)) {
    config.postMigrationScalp.stopLossPct =
      DEFAULT_POST_MIGRATION_SCALP.stopLossPct;
  }
  if (options?.persist !== false) persistUserSettings();
  console.log(
    `[strategies] Post-Migration Scalp — ${config.postMigrationScalp.timeLimitSeconds}s ` +
      `TP +${config.postMigrationScalp.takeProfitPct}% / SL ${config.postMigrationScalp.stopLossPct}%`
  );
  return result;
}

/** Reversal Scalp preset — selective mean-reversion on sharp wicks. */
export function applyReversalScalpPreset(options?: { persist?: boolean }) {
  const result = applyNamedStrategyPreset(
    'reversal_scalp',
    REVERSAL_SCALP_PRESET,
    REVERSAL_SCALP_THRESHOLDS,
    options
  );
  config.reversalScalp.enabled = true;
  let rsSec = Number(config.reversalScalp.timeLimitSeconds);
  if (!Number.isFinite(rsSec) || rsSec < 60) {
    const legacy = Number(config.reversalScalp.timeLimitMinutes);
    rsSec = [1, 2].includes(legacy)
      ? legacy * 60
      : DEFAULT_REVERSAL_SCALP.timeLimitSeconds;
  }
  config.reversalScalp.timeLimitSeconds = Math.max(60, Math.min(150, rsSec));
  if (!(config.reversalScalp.takeProfitPct > 0)) {
    config.reversalScalp.takeProfitPct = DEFAULT_REVERSAL_SCALP.takeProfitPct;
  }
  if (!(config.reversalScalp.stopLossPct < 0)) {
    config.reversalScalp.stopLossPct = DEFAULT_REVERSAL_SCALP.stopLossPct;
  }
  if (options?.persist !== false) persistUserSettings();
  console.log(
    `[strategies] Reversal Scalp — ${config.reversalScalp.timeLimitSeconds}s ` +
      `TP +${config.reversalScalp.takeProfitPct}% / SL ${config.reversalScalp.stopLossPct}%`
  );
  return result;
}

type ScalperSuiteDefaultsBundle =
  | typeof SCALPER_SUITE_DEFAULTS
  | typeof AGGRESSIVE_SCALPER_DEFAULTS
  | typeof CONSERVATIVE_SCALPER_DEFAULTS;

function applyScalperSuiteVariant(
  profile: 'scalper_suite' | 'aggressive_scalper' | 'conservative_scalper',
  thresholds: StrategyPresetThresholds,
  defaults: ScalperSuiteDefaultsBundle,
  options?: { persist?: boolean }
) {
  const { getScalperSuiteVariantLabel } =
    require('./config') as typeof import('./config');
  const label = getScalperSuiteVariantLabel(profile);
  const result = applyNamedStrategyPreset(
    profile,
    SCALPER_SUITE_PRESET,
    thresholds,
    options
  );

  const d = defaults;
  Object.assign(config.microScalper, {
    enabled: true,
    ...d.microScalper,
  });
  Object.assign(config.momentumBurst, {
    enabled: true,
    ...d.momentumBurst,
  });
  Object.assign(config.postMigrationScalp, {
    enabled: true,
    ...d.postMigrationScalp,
  });
  Object.assign(config.reversalScalp, {
    enabled: true,
    ...d.reversalScalp,
  });
  config.quickScalper.enabled = false;

  // Dead-market exit (aggressive on all variants; conservative is most aggressive)
  config.risk.enableDeadVolumeExit = true;
  config.risk.deadVolumeUsdPerHour = d.deadVolumeUsdPerHour;
  config.risk.deadVolumeConsecutiveHours = d.deadVolumeConsecutiveHours;
  config.risk.deadVolumeMinHoldMinutes = d.deadVolumeMinHoldMinutes;

  // Keep anti-rug + volume filters ON in all variants
  config.filters.enableAntiRug = true;
  config.filters.checkHoneypot = true;
  if (!config.strategyToggles) config.strategyToggles = {};
  config.strategyToggles.anti_rug_honeypot = true;
  config.strategyToggles.volume_liquidity_filters = true;
  config.strategyToggles.dead_market_exit = true;

  config.filters.maxConcurrentPositions = Math.max(
    2,
    Math.min(3, d.maxConcurrentPositions)
  );

  // Soft position-size allowance (aggressive ↑ / conservative ↓)
  const sizeMult = Number(d.sizeMultiplier) || 1;
  if (sizeMult !== 1) {
    const base =
      Number(config.trade.baseTradeAmountSol) ||
      Number(config.trade.tradeAmountSol) ||
      0.1;
    const next = Math.max(0.02, Math.min(2, base * sizeMult));
    config.trade.baseTradeAmountSol = Number(next.toFixed(4));
    config.trade.tradeAmountSol = config.trade.baseTradeAmountSol;
    if (config.risk.riskPercentPerTrade != null) {
      config.risk.riskPercentPerTrade = Math.max(
        0.25,
        Math.min(8, config.risk.riskPercentPerTrade * sizeMult)
      );
    }
  }

  const riskTips: string[] = [];
  config.riskLevel = normalizeRiskLevel(config.riskLevel);
  riskTips.push(`Risk ${config.riskLevel.toUpperCase()} — scalp suite modules applied`);

  if (options?.persist !== false) persistUserSettings();
  console.log(
    `[strategies] ${label} ON — Micro ${d.microScalper.timeLimitSeconds}s ` +
      `TP+${d.microScalper.takeProfitPct}%/SL${d.microScalper.stopLossPct}% · ` +
      `Momentum ${d.momentumBurst.timeLimitSeconds}s TP+${d.momentumBurst.takeProfitPct}% · ` +
      `Post-Mig ${d.postMigrationScalp.timeLimitSeconds}s · Reversal ${d.reversalScalp.timeLimitSeconds}s · ` +
      `maxPos=${config.filters.maxConcurrentPositions} · size×${sizeMult} · ` +
      riskTips.join(' · ')
  );
  return result;
}

/**
 * Scalper Suite (Standard) — Micro + Momentum + Post-Migration (+ Reversal).
 */
export function applyScalperSuitePreset(options?: { persist?: boolean }) {
  return applyScalperSuiteVariant(
    'scalper_suite',
    SCALPER_SUITE_THRESHOLDS,
    SCALPER_SUITE_DEFAULTS,
    options
  );
}

/** Aggressive Scalper suite variant. */
export function applyAggressiveScalperPreset(options?: { persist?: boolean }) {
  return applyScalperSuiteVariant(
    'aggressive_scalper',
    AGGRESSIVE_SCALPER_THRESHOLDS,
    AGGRESSIVE_SCALPER_DEFAULTS,
    options
  );
}

/** Conservative Scalper suite variant. */
export function applyConservativeScalperPreset(options?: {
  persist?: boolean;
}) {
  return applyScalperSuiteVariant(
    'conservative_scalper',
    CONSERVATIVE_SCALPER_THRESHOLDS,
    CONSERVATIVE_SCALPER_DEFAULTS,
    options
  );
}

export function applyStrategyPreset(
  profile: NamedStrategyProfileId,
  options?: { persist?: boolean }
) {
  switch (profile) {
    case 'high_win_rate':
      return applyHighWinRatePreset(options);
    case 'win_rate_55_60':
      return applyWinRate55_60Preset(options);
    case 'balanced':
      return applyBalancedPreset(options);
    case 'aggressive':
      return applyAggressivePreset(options);
    case 'quick_scalper':
      return applyQuickScalperPreset(options);
    case 'micro_scalper':
      return applyMicroScalperPreset(options);
    case 'momentum_burst':
      return applyMomentumBurstPreset(options);
    case 'post_migration_scalp':
      return applyPostMigrationScalpPreset(options);
    case 'reversal_scalp':
      return applyReversalScalpPreset(options);
    case 'scalper_suite':
      return applyScalperSuitePreset(options);
    case 'aggressive_scalper':
      return applyAggressiveScalperPreset(options);
    case 'conservative_scalper':
      return applyConservativeScalperPreset(options);
  }
}

export function logStrategyDecision(
  key: StrategyKey,
  action: 'take' | 'skip' | 'gate',
  detail: string
): void {
  const def = getStrategyDefinition(key);
  const name = def?.name ?? key;
  const tag =
    action === 'take'
      ? 'STRATEGY_TAKE'
      : action === 'skip'
        ? 'STRATEGY_SKIP'
        : 'STRATEGY_GATE';
  console.log(`[monitor] ${tag} strategy=${key} (${name}) — ${detail}`);
}

export function getStrategiesStatus() {
  const toggles = ensureStrategyToggles();
  const enabledCount = STRATEGY_KEYS.filter((k) => toggles[k]).length;
  const profile = (config.strategyProfile || 'custom') as StrategyProfileId;
  const recipeStatus = getStrategyRecipeStatus();
  const recipe = getRiskStrategyRecipe(
    normalizeRiskLevel(config.riskLevel)
  );
  return {
    toggles: { ...toggles },
    recipe: recipeStatus,
    registry: STRATEGY_REGISTRY.map((s) => {
      const enabled = toggles[s.key] !== false;
      const recipeExpected = recipe.toggles[s.key] === true;
      let badge: 'core' | 'risk' | 'optional' | 'custom' = s.source;
      if (
        recipeStatus.mode === 'custom' &&
        s.source !== 'core' &&
        enabled !== recipeExpected
      ) {
        badge = 'custom';
      } else if (
        recipeStatus.mode === 'synced' &&
        s.source === 'risk' &&
        enabled
      ) {
        badge = 'risk';
      }
      return {
      ...s,
        enabled,
      frequencyLabel: frequencyImpactLabel(s.frequencyWhenOn),
        status: enabled ? 'ON' : 'OFF',
        badge,
        recipeExpected,
        signalLane: strategySignalLane(s.key),
      };
    }),
    groups: STRATEGY_GROUP_ORDER.map((g) => ({
      id: g,
      label: STRATEGY_GROUP_LABELS[g],
      strategies: STRATEGY_REGISTRY.filter((s) => s.group === g).map(
        (s) => s.key
      ),
    })),
    presets: NAMED_STRATEGY_PROFILES.map((id) => ({
      ...STRATEGY_PRESET_META[id],
      active: profile === id,
    })),
    highWinRatePreset: { ...HIGH_WIN_RATE_PRESET },
    highWinRateThresholds: { ...HIGH_WIN_RATE_THRESHOLDS },
    highWinRateDefaults: { ...HIGH_WIN_RATE_DEFAULTS },
    highWinRateWarning: HIGH_WIN_RATE_WARNING,
    winRate55_60Preset: { ...WIN_RATE_55_60_PRESET },
    winRate55_60Thresholds: { ...WIN_RATE_55_60_THRESHOLDS },
    winRate55_60Defaults: { ...WIN_RATE_55_60_DEFAULTS },
    winRate55_60Description: WIN_RATE_55_60_DESCRIPTION,
    highWinRatePresetActive: config.highWinRatePresetActive === true,
    balancedThresholds: { ...BALANCED_THRESHOLDS },
    moduleTune: getModuleTuneStatus(),
    aggressiveThresholds: { ...AGGRESSIVE_THRESHOLDS },
    quickScalperThresholds: { ...QUICK_SCALPER_THRESHOLDS },
    microScalperThresholds: { ...MICRO_SCALPER_THRESHOLDS },
    momentumBurstThresholds: { ...MOMENTUM_BURST_THRESHOLDS },
    postMigrationScalpThresholds: { ...POST_MIGRATION_SCALP_THRESHOLDS },
    reversalScalpThresholds: { ...REVERSAL_SCALP_THRESHOLDS },
    scalperSuiteThresholds: { ...SCALPER_SUITE_THRESHOLDS },
    scalperSuiteDefaults: { ...SCALPER_SUITE_DEFAULTS },
    aggressiveScalperDefaults: { ...AGGRESSIVE_SCALPER_DEFAULTS },
    conservativeScalperDefaults: { ...CONSERVATIVE_SCALPER_DEFAULTS },
    aggressiveScalperThresholds: { ...AGGRESSIVE_SCALPER_THRESHOLDS },
    conservativeScalperThresholds: { ...CONSERVATIVE_SCALPER_THRESHOLDS },
    scalperSuiteMembers: [...SCALPER_SUITE_MEMBERS],
    scalperSuiteDescription: SCALPER_SUITE_PRESET_DESCRIPTION,
    aggressiveScalperDescription: AGGRESSIVE_SCALPER_PRESET_DESCRIPTION,
    conservativeScalperDescription: CONSERVATIVE_SCALPER_PRESET_DESCRIPTION,
    scalpParamRanges: (() => {
      const { getActiveScalpParamRanges, getScalperSuiteVariantFromProfile } =
        require('./config') as typeof import('./config');
      return {
        active: getActiveScalpParamRanges(profile),
        variant: getScalperSuiteVariantFromProfile(profile),
      };
    })(),
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
    shortTermStrategies: SHORT_TERM_STRATEGIES.map((s) => ({
      id: s.id,
      label: s.label,
      description: s.description,
      frequencyNote: s.frequencyNote,
    })),
    strategyProfile: profile,
    canRestorePrevious: Boolean(config.strategyProfileSnapshot?.knobs),
    previousSnapshotAt: config.strategyProfileSnapshot?.savedAt ?? null,
    enabledCount,
    totalCount: STRATEGY_KEYS.length,
    riskLevel: normalizeRiskLevel(config.riskLevel),
    maxConcurrentPositions: config.filters.maxConcurrentPositions,
    deadVolumeMinHoldMinutes: config.risk.deadVolumeMinHoldMinutes,
    deadVolumeUsdPerHour: config.risk.deadVolumeUsdPerHour,
    deadVolumeConsecutiveHours: config.risk.deadVolumeConsecutiveHours,
    enableDeadVolumeExit: config.risk.enableDeadVolumeExit !== false,
  };
}

/** Strategy Control Center Import/Export JSON schema version. */
export const STRATEGY_MODULES_SCHEMA_VERSION = 2 as const;
export const STRATEGY_MODULES_KIND = 'strategy-modules' as const;

export type StrategyModulesExport = {
  schemaVersion: typeof STRATEGY_MODULES_SCHEMA_VERSION;
  kind: typeof STRATEGY_MODULES_KIND;
  exportedAt: string;
  /** Stable id for boot migration stamps (bump when shipping new defaults). */
  defaultsId?: string;
  label?: string;
  riskLevel: RiskLevel;
  strategyRecipeMode: StrategyRecipeMode;
  strategyRecipeRiskLevel: RiskLevel | null;
  strategyProfile: StrategyProfileId;
  highWinRatePresetActive: boolean;
  /** Master ON/OFF map for every registered module. */
  toggles: StrategyToggleMap;
  /**
   * Per-module summary (enabled + dedicated settings when present).
   * Shared filter/risk/trade knobs also live under `settings` for full restore.
   */
  modules: Array<{
    key: StrategyKey;
    name: string;
    group: StrategyGroup;
    source: StrategySource;
    enabled: boolean;
    settings?: Record<string, unknown>;
  }>;
  /**
   * Trade Profiles (Scalper, Trend Rider, etc.) — full runtime snapshot including
   * per-profile overrides (TP/SL/hold/Size ×/maxTradeOverrideSol/trail/fail-drop,
   * minMarketCapUsd/maxMarketCapUsd/minHolders/maxTop10HoldPct/minVolumeM5Usd/
   * minConviction/match/modules).
   * Also mirrored under `settings.tradeProfiles` for v1 compatibility.
   */
  tradeProfiles?: PersistedBotSettings['tradeProfiles'];
  /**
   * Full internal knobs needed to restore Strategy Control Center state
   * (filters, scalp engines, trade profiles, etc.).
   */
  settings: {
    trade: Record<string, unknown>;
    filters: Record<string, unknown>;
    strategy: Record<string, unknown>;
    risk: Record<string, unknown>;
    profitStrategy: Record<string, unknown>;
    selective: Record<string, unknown>;
    quickScalper: Record<string, unknown>;
    microScalper: Record<string, unknown>;
    momentumBurst: Record<string, unknown>;
    postMigrationScalp: Record<string, unknown>;
    reversalScalp: Record<string, unknown>;
    postRunDip: Record<string, unknown>;
    technicalLevels: Record<string, unknown>;
    chartPatterns: Record<string, unknown>;
    bondingCurve: Record<string, unknown>;
    mev: Record<string, unknown>;
    marketScanner: Record<string, unknown>;
    tradeProfiles?: PersistedBotSettings['tradeProfiles'];
    tokenMetrics?: Record<string, unknown>;
    convergenceWindowMs?: number;
  };
};

function cloneModuleSettings<T>(value: T): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

/** Dedicated config blob for a module when it owns its own settings object. */
function dedicatedModuleSettings(
  key: StrategyKey
): Record<string, unknown> | undefined {
  switch (key) {
    case 'quick_scalper':
      return cloneModuleSettings(config.quickScalper);
    case 'micro_scalper':
      return cloneModuleSettings(config.microScalper);
    case 'momentum_burst':
      return cloneModuleSettings(config.momentumBurst);
    case 'post_migration_scalp':
      return cloneModuleSettings(config.postMigrationScalp);
    case 'reversal_scalp':
      return cloneModuleSettings(config.reversalScalp);
    case 'post_run_dip':
      return cloneModuleSettings(config.postRunDip);
    case 'technical_levels':
      return cloneModuleSettings(config.technicalLevels);
    case 'chart_patterns':
    case 'pattern_volume_dryup_return':
    case 'pattern_falling_wedge':
    case 'pattern_structured_pullback':
    case 'pattern_bull_flag':
    case 'pattern_trend_continuation':
      return cloneModuleSettings({
        ...config.chartPatterns,
        patterns: { ...(config.chartPatterns?.patterns || {}) },
      });
    case 'mev_protection':
      return cloneModuleSettings(config.mev);
    case 'ta_market_scanner':
      return cloneModuleSettings(config.marketScanner);
    case 'bonding_curve_health':
      return cloneModuleSettings(config.bondingCurve);
    default:
      return undefined;
  }
}

/**
 * Build a complete Strategy Control Center export (toggles + internal settings).
 * Safe to re-import and fine to send to Cursor when updating Risk On defaults.
 */
export function exportStrategyModulesBundle(options?: {
  label?: string;
}): StrategyModulesExport {
  const toggles = ensureStrategyToggles();
  const snap = buildPersistedSettingsSnapshot();
  // Prefer live runtime serialize so Max Trade Override / nested exitRules are current
  let tradeProfiles: PersistedBotSettings['tradeProfiles'];
  try {
    const { serializeTradeProfilesForPersist, ensureTradeProfilesInitialized } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    ensureTradeProfilesInitialized();
    tradeProfiles = serializeTradeProfilesForPersist() as PersistedBotSettings['tradeProfiles'];
  } catch {
    tradeProfiles = snap.tradeProfiles
      ? (cloneModuleSettings(
          snap.tradeProfiles
        ) as PersistedBotSettings['tradeProfiles'])
      : undefined;
  }
  const modules = STRATEGY_REGISTRY.map((s) => {
    const dedicated = dedicatedModuleSettings(s.key);
    return {
      key: s.key,
      name: s.name,
      group: s.group,
      source: s.source,
      enabled: toggles[s.key] === true,
      ...(dedicated ? { settings: dedicated } : {}),
    };
  });
  return {
    schemaVersion: STRATEGY_MODULES_SCHEMA_VERSION,
    kind: STRATEGY_MODULES_KIND,
    exportedAt: new Date().toISOString(),
    ...(options?.label ? { label: options.label } : {}),
    riskLevel: normalizeRiskLevel(config.riskLevel),
    strategyRecipeMode: ensureStrategyRecipeMode(),
    strategyRecipeRiskLevel:
      config.strategyRecipeRiskLevel == null
        ? null
        : normalizeRiskLevel(config.strategyRecipeRiskLevel),
    strategyProfile: (config.strategyProfile || 'custom') as StrategyProfileId,
    highWinRatePresetActive: config.highWinRatePresetActive === true,
    toggles: { ...toggles },
    modules,
    tradeProfiles: tradeProfiles
      ? (cloneModuleSettings(
          tradeProfiles
        ) as PersistedBotSettings['tradeProfiles'])
      : undefined,
    settings: {
      trade: cloneModuleSettings(snap.trade ?? {}),
      filters: cloneModuleSettings(snap.filters ?? {}),
      strategy: cloneModuleSettings(snap.strategy ?? {}),
      risk: cloneModuleSettings(snap.risk ?? {}),
      profitStrategy: cloneModuleSettings(snap.profitStrategy ?? {}),
      selective: cloneModuleSettings(snap.selective ?? {}),
      quickScalper: cloneModuleSettings(snap.quickScalper ?? {}),
      microScalper: cloneModuleSettings(snap.microScalper ?? {}),
      momentumBurst: cloneModuleSettings(snap.momentumBurst ?? {}),
      postMigrationScalp: cloneModuleSettings(snap.postMigrationScalp ?? {}),
      reversalScalp: cloneModuleSettings(snap.reversalScalp ?? {}),
      postRunDip: cloneModuleSettings(snap.postRunDip ?? {}),
      technicalLevels: cloneModuleSettings(snap.technicalLevels ?? {}),
      chartPatterns: cloneModuleSettings(snap.chartPatterns ?? {}),
      bondingCurve: cloneModuleSettings(snap.bondingCurve ?? {}),
      mev: cloneModuleSettings(snap.mev ?? {}),
      marketScanner: cloneModuleSettings(snap.marketScanner ?? {}),
      tradeProfiles: tradeProfiles
        ? (cloneModuleSettings(
            tradeProfiles
          ) as PersistedBotSettings['tradeProfiles'])
        : undefined,
      tokenMetrics: snap.tokenMetrics
        ? cloneModuleSettings(snap.tokenMetrics)
        : undefined,
      convergenceWindowMs: snap.convergenceWindowMs,
    },
  };
}

export type StrategyModulesImportResult = {
  ok: true;
  appliedToggles: number;
  appliedProfileOverrides: number;
  enabledCount: number;
  totalCount: number;
  riskLevel: RiskLevel;
  strategyRecipeMode: StrategyRecipeMode;
  strategyProfile: StrategyProfileId;
  tradeProfilesEnabled: boolean;
  smartBotProfiles: boolean;
  message: string;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function countProfileOverrides(
  overrides: unknown
): number {
  if (!isPlainObject(overrides)) return 0;
  let n = 0;
  for (const ov of Object.values(overrides)) {
    if (!isPlainObject(ov)) continue;
    const exitRules = ov.exitRules;
    const match = ov.match;
    const modules = ov.modules;
    const hasExit =
      isPlainObject(exitRules) && Object.keys(exitRules).length > 0;
    const hasMatch = isPlainObject(match) && Object.keys(match).length > 0;
    const hasMods = isPlainObject(modules) && Object.keys(modules).length > 0;
    if (hasExit || hasMatch || hasMods) n += 1;
  }
  return n;
}

/**
 * Validate + apply a Strategy Control Center JSON export.
 * Applies settings via the same persisted-settings path, then toggles,
 * without calling applyRiskLevel (so imported knobs are not overwritten).
 */
export function importStrategyModulesBundle(
  raw: unknown,
  options?: { persist?: boolean; label?: string }
): StrategyModulesImportResult {
  if (!isPlainObject(raw)) {
    throw new Error('Import JSON must be an object');
  }
  const schemaVersion = Number(raw.schemaVersion);
  if (
    !Number.isFinite(schemaVersion) ||
    schemaVersion < 1 ||
    schemaVersion > STRATEGY_MODULES_SCHEMA_VERSION
  ) {
    throw new Error(
      `Unsupported schemaVersion (expected 1–${STRATEGY_MODULES_SCHEMA_VERSION})`
    );
  }
  if (raw.kind != null && raw.kind !== STRATEGY_MODULES_KIND) {
    throw new Error(
      `Unexpected kind "${String(raw.kind)}" (expected "${STRATEGY_MODULES_KIND}")`
    );
  }

  const togglesRaw = raw.toggles;
  const settingsRaw = raw.settings;
  const modulesRaw = raw.modules;
  // v2 top-level tradeProfiles preferred; fall back to settings.tradeProfiles (v1)
  const tradeProfilesRaw = isPlainObject(raw.tradeProfiles)
    ? raw.tradeProfiles
    : isPlainObject(settingsRaw) && isPlainObject(settingsRaw.tradeProfiles)
      ? settingsRaw.tradeProfiles
      : null;

  if (
    !isPlainObject(togglesRaw) &&
    !isPlainObject(settingsRaw) &&
    !Array.isArray(modulesRaw) &&
    !tradeProfilesRaw
  ) {
    throw new Error(
      'Import JSON must include toggles, settings, modules, and/or tradeProfiles'
    );
  }

  // Build toggle map: prefer top-level toggles; fall back to modules[].enabled
  const partialToggles: Partial<StrategyToggleMap> = {};
  if (isPlainObject(togglesRaw)) {
    for (const [k, v] of Object.entries(togglesRaw)) {
      if (isStrategyKey(k) && typeof v === 'boolean') partialToggles[k] = v;
    }
  } else if (Array.isArray(modulesRaw)) {
    for (const row of modulesRaw) {
      if (!isPlainObject(row)) continue;
      const key = String(row.key || '');
      if (isStrategyKey(key) && typeof row.enabled === 'boolean') {
        partialToggles[key] = row.enabled;
      }
    }
  }

  // Apply internal settings first (replace present sections), then toggles.
  // Do not set trading mode / paper / discovery — strategy control center only.
  if (isPlainObject(settingsRaw) || tradeProfilesRaw) {
    const snap: PersistedBotSettings = {
      version: SETTINGS_VERSION,
      updatedAt: Date.now(),
    };
    if (isPlainObject(settingsRaw)) {
      const copyIfObj = (key: keyof PersistedBotSettings) => {
        const v = settingsRaw[key as string];
        if (isPlainObject(v)) {
          (snap as unknown as Record<string, unknown>)[key as string] = v;
        }
      };
      for (const key of [
        'trade',
        'filters',
        'strategy',
        'risk',
        'profitStrategy',
        'selective',
        'quickScalper',
        'microScalper',
        'momentumBurst',
        'postMigrationScalp',
        'reversalScalp',
        'postRunDip',
        'technicalLevels',
        'chartPatterns',
        'bondingCurve',
        'mev',
        'marketScanner',
        'tradeProfiles',
        'tokenMetrics',
      ] as const) {
        copyIfObj(key);
      }
      if (typeof settingsRaw.convergenceWindowMs === 'number') {
        snap.convergenceWindowMs = settingsRaw.convergenceWindowMs;
      }
    }
    // Top-level tradeProfiles wins over settings.tradeProfiles
    if (tradeProfilesRaw) {
      snap.tradeProfiles =
        tradeProfilesRaw as PersistedBotSettings['tradeProfiles'];
    }
    applyImportedSettingsSnapshot(snap, 'merge');

    // Hydrate runtime Trade Profiles state from the applied snapshot
    try {
      const { hydrateTradeProfilesFromSettings, ensureTradeProfilesInitialized } =
        require('./tradeProfiles') as typeof import('./tradeProfiles');
      ensureTradeProfilesInitialized();
      hydrateTradeProfilesFromSettings({
        tradeProfiles: config.tradeProfiles as unknown as Partial<
          import('./tradeProfiles').TradeProfileRuntimeState
        >,
      });
    } catch (err) {
      console.warn(
        '[strategies] tradeProfiles hydrate skipped:',
        err instanceof Error ? err.message : err
      );
    }
  }

  // Risk level field only — do not re-run applyRiskLevel (would wipe knobs/toggles).
  if (raw.riskLevel != null) {
    config.riskLevel = normalizeRiskLevel(raw.riskLevel as RiskLevel);
  }

  const importedToggleCount = Object.keys(partialToggles).length;
  if (importedToggleCount > 0) {
    // Always mark custom when toggles are imported so a later Risk On/Off
    // (or reset_recipe) cannot silently replace the imported ON/OFF map with
    // the lean recipe. Previously markCustom:false + strategyRecipeMode:synced
    // from the export left imports fragile / looking like they "didn't stick".
    updateStrategyToggles(partialToggles, {
      persist: false,
      syncUnderlying: true,
      markCustom: true,
    });
  } else {
    syncUnderlyingFlagsFromToggles(ensureStrategyToggles());
    if (raw.strategyRecipeMode === 'synced' || raw.strategyRecipeMode === 'custom') {
      config.strategyRecipeMode = raw.strategyRecipeMode;
    }
  }

  if (raw.strategyRecipeRiskLevel === null) {
    config.strategyRecipeRiskLevel = null;
  } else if (raw.strategyRecipeRiskLevel != null) {
    config.strategyRecipeRiskLevel = normalizeRiskLevel(
      raw.strategyRecipeRiskLevel as RiskLevel
    );
  }

  if (isStrategyProfileId(String(raw.strategyProfile || ''))) {
    config.strategyProfile = raw.strategyProfile as StrategyProfileId;
  }
  // Imported toggles already force custom + clear HWR; only honor file flags
  // when no toggle map was applied.
  if (importedToggleCount === 0) {
    if (typeof raw.highWinRatePresetActive === 'boolean') {
      config.highWinRatePresetActive = raw.highWinRatePresetActive;
    }
  }

  if (options?.persist !== false) persistUserSettings();

  const toggles = ensureStrategyToggles();
  const enabledCount = STRATEGY_KEYS.filter((k) => toggles[k]).length;
  const appliedToggles = importedToggleCount;
  const appliedProfileOverrides = countProfileOverrides(
    config.tradeProfiles?.overrides
  );
  const tradeProfilesEnabled = config.tradeProfiles?.enabled !== false;
  const smartBotProfiles = config.tradeProfiles?.smartBotProfiles === true;
  const label = options?.label || (typeof raw.label === 'string' ? raw.label : '');
  const message =
    `Imported · ${enabledCount}/${STRATEGY_KEYS.length} modules ON` +
    (appliedToggles
      ? ` (${appliedToggles} toggle values applied)`
      : ' (no toggle map in file)') +
    ` · ${appliedProfileOverrides} profile override(s)` +
    ` · multi-profile ${tradeProfilesEnabled ? 'ON' : 'OFF'}` +
    ` · smart bot ${smartBotProfiles ? 'ON' : 'OFF'}` +
    (label ? ` (${label})` : '') +
    ` · Risk ${normalizeRiskLevel(config.riskLevel).toUpperCase()}` +
    ` · recipe ${ensureStrategyRecipeMode()}`;

  console.log(`[strategies] ${message}`);
  return {
    ok: true,
    appliedToggles,
    appliedProfileOverrides,
    enabledCount,
    totalCount: STRATEGY_KEYS.length,
    riskLevel: normalizeRiskLevel(config.riskLevel),
    strategyRecipeMode: ensureStrategyRecipeMode(),
    strategyProfile: (config.strategyProfile || 'custom') as StrategyProfileId,
    tradeProfilesEnabled,
    smartBotProfiles,
    message,
  };
}

/**
 * Strategy-scoped reset: restore Control Center + Trade Profiles from the baked
 * default export ([src/defaults/strategyModulesDefault.json]).
 * Does not wipe wallets, paper balance, or backtest history.
 */
export function getBakedStrategyModulesDefault(): StrategyModulesExport {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const candidates = [
    path.join(__dirname, 'defaults', 'strategyModulesDefault.json'),
    path.join(__dirname, '..', 'src', 'defaults', 'strategyModulesDefault.json'),
    path.join(process.cwd(), 'src', 'defaults', 'strategyModulesDefault.json'),
    path.join(process.cwd(), 'dist', 'defaults', 'strategyModulesDefault.json'),
  ];
  let baked: StrategyModulesExport | null = null;
  let lastErr: string | null = null;
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      baked = JSON.parse(fs.readFileSync(file, 'utf8')) as StrategyModulesExport;
      break;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  if (!baked || baked.kind !== STRATEGY_MODULES_KIND) {
    throw new Error(
      `Baked strategyModulesDefault.json missing or invalid` +
        (lastErr ? ` (${lastErr})` : '')
    );
  }
  return JSON.parse(JSON.stringify(baked)) as StrategyModulesExport;
}

/** Migration stamp for the current baked defaults file. */
export function bakedStrategyModulesDefaultStamp(
  baked?: StrategyModulesExport
): string {
  const b = baked ?? getBakedStrategyModulesDefault();
  const id =
    (typeof b.defaultsId === 'string' && b.defaultsId.trim()) ||
    (typeof b.exportedAt === 'string' && b.exportedAt.trim()) ||
    'v1';
  const {
    STRATEGY_MODULES_DEFAULT_MIGRATION_PREFIX,
  } = require('./config') as typeof import('./config');
  return `${STRATEGY_MODULES_DEFAULT_MIGRATION_PREFIX}${id}`;
}

/**
 * On boot / deploy: if this build's baked strategy+trade-profile defaults have
 * not been applied yet, import them (once per defaultsId). Does not wipe wallets
 * or paper. Re-runs automatically when defaultsId / exportedAt in the JSON changes.
 *
 * User-owned trade profile overrides + self-learning are never overwritten —
 * they are snapshotted before import and restored afterward (and again from
 * data/trade-profiles-user.json in initWallets).
 */
export function applyBakedStrategyModulesDefaultOnBoot(): boolean {
  try {
    const {
      hasSettingsMigration,
      completeSettingsMigration,
      clearPriorStrategyModulesDefaultMigrations,
      persistUserSettings,
    } = require('./config') as typeof import('./config');
    const {
      serializeTradeProfilesForPersist,
      hydrateTradeProfilesFromSettings,
      ensureTradeProfilesInitialized,
    } = require('./tradeProfiles') as typeof import('./tradeProfiles');

    const baked = getBakedStrategyModulesDefault();
    const stamp = bakedStrategyModulesDefaultStamp(baked);
    if (hasSettingsMigration(stamp)) {
      return false;
    }

    ensureTradeProfilesInitialized();
    const before = serializeTradeProfilesForPersist();
    const savedOverrides = before.overrides
      ? (JSON.parse(JSON.stringify(before.overrides)) as typeof before.overrides)
      : undefined;
    const savedSelfLearning = before.selfLearning
      ? (JSON.parse(
          JSON.stringify(before.selfLearning)
        ) as typeof before.selfLearning)
      : undefined;
    const savedProfiles = before.profiles
      ? (JSON.parse(JSON.stringify(before.profiles)) as typeof before.profiles)
      : undefined;
    const hadUserOverrides =
      !!savedOverrides && Object.keys(savedOverrides).length > 0;
    const hadSelfLearning =
      !!savedSelfLearning && Object.keys(savedSelfLearning).length > 0;
    // Custom recipe: preserve module toggles across bake (trade-profile restore still runs).
    const preserveCustomToggles = config.strategyRecipeMode === 'custom';
    const savedCustomToggles = preserveCustomToggles
      ? ({ ...(config.strategyToggles || {}) } as StrategyToggleMap)
      : null;

    clearPriorStrategyModulesDefaultMigrations(stamp);
    const result = importStrategyModulesBundle(baked, {
      persist: false,
      label: 'boot-default',
    });

    if (preserveCustomToggles && savedCustomToggles) {
      updateStrategyToggles(savedCustomToggles, {
        persist: false,
        syncUnderlying: true,
        markCustom: true,
      });
      console.log(
        '[settings] Preserved custom strategy module toggles across bake'
      );
    }

    // Restore user-owned micro-bot knobs — bake must never wipe learning / custom cards
    {
      const after = serializeTradeProfilesForPersist();
      hydrateTradeProfilesFromSettings({
        tradeProfiles: {
          ...after,
          profiles: savedProfiles || after.profiles,
          overrides: hadUserOverrides ? savedOverrides : after.overrides,
          selfLearning: hadSelfLearning
            ? savedSelfLearning
            : after.selfLearning || savedSelfLearning,
        },
      });
      if (hadUserOverrides || hadSelfLearning) {
        console.log(
          `[settings] Preserved user trade-profile knobs across bake` +
            ` (overrides=${hadUserOverrides ? Object.keys(savedOverrides!).length : 0}` +
            `, selfLearn=${hadSelfLearning ? Object.keys(savedSelfLearning!).length : 0})`
        );
      }
    }

    try {
      const { ensureSelfLearningDefaultsForAllProfiles } =
        require('./tradeProfiles') as typeof import('./tradeProfiles');
      // Seed unset only — do not override user disables mid-bake; migration handles default-ON
      ensureSelfLearningDefaultsForAllProfiles({
        forceEnableUnset: true,
        persist: false,
      });
    } catch {
      /* optional */
    }

    completeSettingsMigration(stamp);
    persistUserSettings();
    try {
      const { saveTradeProfilesUserState } =
        require('./tradeProfilesUserStore') as typeof import('./tradeProfilesUserStore');
      saveTradeProfilesUserState(serializeTradeProfilesForPersist());
    } catch {
      /* persistUserSettings already mirrors; belt-and-suspenders */
    }
    console.log(
      `[settings] Applied baked strategy defaults (${stamp}) · ` +
        `${result.enabledCount}/${result.totalCount} modules ON · ` +
        `${result.appliedProfileOverrides} profile override(s) · ` +
        `recipe ${result.strategyRecipeMode}`
    );
    return true;
  } catch (err) {
    console.warn(
      '[settings] Baked strategy defaults boot apply skipped:',
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

export function resetStrategyModulesToDefaults(options?: {
  persist?: boolean;
}): {
  ok: true;
  message: string;
  enabledCount: number;
  totalCount: number;
  riskLevel: RiskLevel;
  strategyRecipeMode: StrategyRecipeMode;
  strategyProfile: StrategyProfileId;
  tradeProfilesEnabled: boolean;
  smartBotProfiles: boolean;
} {
  const baked = getBakedStrategyModulesDefault();
  const result = importStrategyModulesBundle(baked, {
    persist: options?.persist !== false,
    label: 'code-default-reset',
  });
  try {
    const {
      clearPriorStrategyModulesDefaultMigrations,
      completeSettingsMigration,
    } = require('./config') as typeof import('./config');
    const stamp = bakedStrategyModulesDefaultStamp(baked);
    clearPriorStrategyModulesDefaultMigrations(stamp);
    completeSettingsMigration(stamp);
  } catch {
    /* migration bookkeeping best-effort */
  }
  const message =
    `Reset Strategy to baked defaults (${baked.defaultsId || baked.exportedAt || 'shipped'})` +
    ` · ${result.enabledCount}/${result.totalCount} modules ON` +
    ` · ${result.appliedProfileOverrides} profile override(s)` +
    ` · multi-profile ${result.tradeProfilesEnabled ? 'ON' : 'OFF'}` +
    ` · smart bot ${result.smartBotProfiles ? 'ON' : 'OFF'}` +
    ` · Risk ${result.riskLevel.toUpperCase()}` +
    ` · recipe ${result.strategyRecipeMode}`;
  console.log(`[strategies] ${message}`);
  return {
    ok: true,
    message,
    enabledCount: result.enabledCount,
    totalCount: result.totalCount,
    riskLevel: result.riskLevel,
    strategyRecipeMode: result.strategyRecipeMode,
    strategyProfile: result.strategyProfile,
    tradeProfilesEnabled: result.tradeProfilesEnabled,
    smartBotProfiles: result.smartBotProfiles,
  };
}

