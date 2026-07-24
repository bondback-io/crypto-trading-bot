/**
 * Strategy registry — master ON/OFF layer for entry, filters, exit, risk, advanced.
 *
 * When OFF, the mapped logic is skipped entirely.
 * When ON, Risk Level + Strict Mode intensity still apply to thresholds/params.
 * Hard floors (pump.fun-only, $5k MC, min top-10) remain always-on.
 *
 * Profiles: balanced (defaults), high_win_rate (selective ≥60% WR target),
 * custom (manual toggles). High Win-Rate snapshots prior knobs for Restore.
 */

import { config, persistUserSettings, HARD_FILTER_FLOORS } from './config';

export type StrategyGroup =
  | 'entry'
  | 'filters'
  | 'exit'
  | 'risk'
  | 'advanced';

export type StrategyKey =
  | 'smart_money_copy'
  | 'wallet_convergence'
  | 'migration_priority'
  | 'near_migration_curve'
  | 'early_curve_smart_money'
  | 'rebuy_on_dip'
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
  | 'sniper_bundler_filters'
  | 'mev_protection'
  | 'momentum_confirmation'
  | 'smart_money_flow_weighting';

export type TradeFrequencyImpact =
  | 'none'
  | 'slightly_fewer'
  | 'fewer'
  | 'much_fewer'
  | 'slightly_more'
  | 'more';

export type StrategyProfileId = 'balanced' | 'high_win_rate' | 'custom';

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
  'Fewer trades expected – prioritises win rate over frequency';

export const STRATEGY_REGISTRY: readonly StrategyDefinition[] = [
  {
    key: 'smart_money_copy',
    name: 'Smart Money Copy',
    group: 'entry',
    description:
      'Core copy-trading of tracked smart wallets. OFF skips all new copy entries.',
    defaultEnabled: true,
    criticalSafety: false,
    frequencyWhenOn: 'more',
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
  },
  {
    key: 'min_holders_activity',
    name: 'Min Holders + Activity',
    group: 'filters',
    description:
      'Require minimum holders and source-wallet activity / trade-count filters.',
    defaultEnabled: true,
    criticalSafety: true,
    frequencyWhenOn: 'fewer',
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
  profitStrategy: { enabled: boolean };
  mev: { enableMEVProtection: boolean };
}

export interface StrategyProfileSnapshot {
  savedAt: number;
  fromProfile: StrategyProfileId;
  knobs: StrategyProfileKnobs;
}

/**
 * High Win-Rate threshold pack — applied on top of Risk Level / Strict Mode.
 * Strict Mode can still tighten further when ON.
 */
export const HIGH_WIN_RATE_THRESHOLDS = {
  minWalletQualityScore: 72,
  minConvictionScore: 68,
  convergenceRequired: 3,
  clusterMinWallets: 3,
  minWalletsForTrade: 3,
  allowSingleWalletMigration: false,
  allowSingleWalletTopPerformerMigration: false,
  requireConvergenceForNormal: true,
  minLiquidity: 12_000,
  minMarketCapUsd: 8_000,
  minVolume24hUsd: 25_000,
  minRecentVolumeUsd: 2_000,
  minHolders: 60,
  minHolderCount: 60,
  minRecentActivity: 8,
  maxRiskScore: 55,
  maxDevHoldPct: 10,
  maxHolderConcentration: 45,
  sniperSensitivity: 'high' as const,
  maxEntryAgeMinutes: 8,
  preferEntryWithinMinutes: 5,
  requireMomentumConfirmation: true,
  smartMoneyFlowWeight: 1.6,
  confirmationThreshold: 3,
  deadVolumeUsdPerHour: 80,
  deadVolumeConsecutiveHours: 2,
  deadVolumeMinHoldMinutes: 20,
  maxTradesPerHour: 4,
  minMsBetweenTrades: 120_000,
  requireHealthyCurve: true,
  requireRecentCurveActivity: true,
} as const;

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
  d.mev_protection = config.mev.enableMEVProtection === true;
  d.momentum_confirmation =
    config.filters.requireMomentumConfirmation === true;
  d.smart_money_flow_weighting =
    (config.filters.smartMoneyFlowWeight ?? 1) > 1;
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
  if (
    config.strategyProfile !== 'balanced' &&
    config.strategyProfile !== 'high_win_rate' &&
    config.strategyProfile !== 'custom'
  ) {
    config.strategyProfile = 'custom';
  }
  if (config.highWinRatePresetActive == null) {
    config.highWinRatePresetActive = config.strategyProfile === 'high_win_rate';
  }
  return config.strategyToggles as StrategyToggleMap;
}

export function isStrategyEnabled(key: StrategyKey): boolean {
  const toggles = ensureStrategyToggles();
  return toggles[key] !== false;
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

/** Most selective combo aimed at ≥60% win rate (still respects Risk/Strict). */
export const HIGH_WIN_RATE_PRESET: StrategyToggleMap = {
  smart_money_copy: true,
  wallet_convergence: true,
  migration_priority: true,
  near_migration_curve: true,
  early_curve_smart_money: false,
  rebuy_on_dip: false,
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
  sniper_bundler_filters: true,
  mev_protection: true,
  momentum_confirmation: true,
  smart_money_flow_weighting: true,
};

/** Balanced = registry defaults (≈ pre-1.1.40 always-on behaviour). */
export const BALANCED_PRESET: StrategyToggleMap = defaultStrategyToggles();

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
      minLiquidity: config.filters.minLiquidity ?? 5_000,
      minMarketCapUsd: config.filters.minMarketCapUsd ?? 5_000,
      minVolume24hUsd: config.filters.minVolume24hUsd ?? 10_000,
      minRecentVolumeUsd: config.filters.minRecentVolumeUsd ?? 800,
      minHolders: config.filters.minHolders ?? 30,
      minHolderCount: config.filters.minHolderCount ?? 30,
      minRecentActivity: config.filters.minRecentActivity ?? 3,
      maxRiskScore: config.filters.maxRiskScore ?? 78,
      maxDevHoldPct: config.filters.maxDevHoldPct ?? 14,
      maxHolderConcentration: config.filters.maxHolderConcentration ?? 70,
      skipIfDevRecentSells: config.filters.skipIfDevRecentSells !== false,
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
    profitStrategy: { enabled: config.profitStrategy.enabled !== false },
    mev: { enableMEVProtection: config.mev.enableMEVProtection === true },
  };
}

function applyStrategyProfileKnobs(knobs: StrategyProfileKnobs): void {
  config.strategyToggles = { ...knobs.strategyToggles };
  Object.assign(config.filters, knobs.filters);
  Object.assign(config.selective, knobs.selective);
  Object.assign(config.strategy, knobs.strategy);
  Object.assign(config.risk, knobs.risk);
  Object.assign(config.bondingCurve, knobs.bondingCurve);
  config.profitStrategy.enabled = knobs.profitStrategy.enabled;
  config.mev.enableMEVProtection = knobs.mev.enableMEVProtection;
  // Never undercut absolute floors
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

/**
 * Sync underlying config flags so legacy checks stay aligned with the
 * strategy master toggles (Risk Level / Strict still set thresholds).
 */
export function syncUnderlyingFlagsFromToggles(
  toggles: StrategyToggleMap
): void {
  config.strategy.enableConvergence = toggles.wallet_convergence;
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
  config.risk.enableDeadVolumeExit = toggles.dead_market_exit;
  if (toggles.dynamic_position_sizing) {
    config.risk.enabled = true;
    config.risk.useRiskSizing = true;
  } else {
    config.risk.useRiskSizing = false;
  }
  config.profitStrategy.enabled = toggles.tiered_profit_taking;
  config.filters.enableWalletQualityGate = toggles.wallet_quality_scoring;
  config.selective.enabled = toggles.multi_factor_conviction;
  config.filters.enableEntryTimingGate = toggles.time_based_entry;
  config.filters.enableSniperFilter = toggles.sniper_bundler_filters;
  config.mev.enableMEVProtection = toggles.mev_protection;
  config.filters.requireMomentumConfirmation = toggles.momentum_confirmation;
  if (toggles.smart_money_flow_weighting) {
    if ((config.filters.smartMoneyFlowWeight ?? 1) <= 1) {
      config.filters.smartMoneyFlowWeight = 1.35;
    }
  } else {
    config.filters.smartMoneyFlowWeight = 1;
  }
}

function applyHighWinRateThresholds(): void {
  const t = HIGH_WIN_RATE_THRESHOLDS;
  config.filters.minWalletQualityScore = t.minWalletQualityScore;
  config.filters.enableWalletQualityGate = true;
  config.selective.enabled = true;
  config.selective.minConvictionScore = t.minConvictionScore;
  config.selective.minWalletsForTrade = t.minWalletsForTrade;
  config.selective.requireConvergenceForNormal = t.requireConvergenceForNormal;
  config.selective.allowSingleWalletMigration = t.allowSingleWalletMigration;
  config.selective.maxTradesPerHour = t.maxTradesPerHour;
  config.selective.minMsBetweenTrades = t.minMsBetweenTrades;
  config.filters.convergenceRequired = t.convergenceRequired;
  config.filters.clusterMinWallets = t.clusterMinWallets;
  config.filters.allowSingleWalletTopPerformerMigration =
    t.allowSingleWalletTopPerformerMigration;
  config.strategy.enableConvergence = true;
  config.strategy.confirmationThreshold = t.confirmationThreshold;
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
  config.filters.maxRiskScore = t.maxRiskScore;
  config.filters.maxDevHoldPct = t.maxDevHoldPct;
  config.filters.maxDevPercent = t.maxDevHoldPct;
  config.filters.maxHolderConcentration = t.maxHolderConcentration;
  config.filters.enableAntiRug = true;
  config.filters.checkHoneypot = true;
  config.filters.skipIfDevRecentSells = true;
  config.filters.enableSniperFilter = true;
  config.filters.sniperSensitivity = t.sniperSensitivity;
  config.filters.enableEntryTimingGate = true;
  config.filters.maxEntryAgeMinutes = t.maxEntryAgeMinutes;
  config.filters.preferEntryWithinMinutes = t.preferEntryWithinMinutes;
  config.filters.requireMomentumConfirmation = t.requireMomentumConfirmation;
  config.filters.smartMoneyFlowWeight = t.smartMoneyFlowWeight;
  config.bondingCurve.requireHealthyCurve = t.requireHealthyCurve;
  config.bondingCurve.requireRecentCurveActivity =
    t.requireRecentCurveActivity;
  config.risk.enableDeadVolumeExit = true;
  config.risk.deadVolumeUsdPerHour = t.deadVolumeUsdPerHour;
  config.risk.deadVolumeConsecutiveHours = t.deadVolumeConsecutiveHours;
  config.risk.deadVolumeMinHoldMinutes = t.deadVolumeMinHoldMinutes;
  config.risk.enabled = true;
  config.risk.useRiskSizing = true;
  config.profitStrategy.enabled = true;
  config.mev.enableMEVProtection = true;
  config.strategy.enableEarlyCurvePriority = false;
  config.strategy.reBuyEnabled = false;
  config.strategy.postStopReentryEnabled = false;
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
 * Apply High Win-Rate profile: snapshot current knobs, enable selective
 * strategies, raise quality thresholds. Works on top of Risk Level / Strict.
 */
export function applyHighWinRatePreset(options?: {
  persist?: boolean;
}): {
  toggles: StrategyToggleMap;
  warning: string;
  thresholds: typeof HIGH_WIN_RATE_THRESHOLDS;
  restoredAvailable: boolean;
} {
  ensureStrategyToggles();
  // Snapshot only when leaving a non-high profile (keep original for restore)
  if (config.strategyProfile !== 'high_win_rate') {
    config.strategyProfileSnapshot = {
      savedAt: Date.now(),
      fromProfile: config.strategyProfile || 'custom',
      knobs: captureStrategyProfileKnobs() as unknown as Record<string, unknown>,
    };
  }
  updateStrategyToggles(
    { ...HIGH_WIN_RATE_PRESET },
    { persist: false, syncUnderlying: true, markCustom: false }
  );
  applyHighWinRateThresholds();
  config.strategyProfile = 'high_win_rate';
  config.highWinRatePresetActive = true;
  if (options?.persist !== false) persistUserSettings();
  console.log(
    `[strategies] High Win-Rate Preset ON — conviction≥${HIGH_WIN_RATE_THRESHOLDS.minConvictionScore} ` +
      `wallets≥${HIGH_WIN_RATE_THRESHOLDS.clusterMinWallets} quality≥${HIGH_WIN_RATE_THRESHOLDS.minWalletQualityScore} · ${HIGH_WIN_RATE_WARNING}`
  );
  return {
    toggles: { ...config.strategyToggles } as StrategyToggleMap,
    warning: HIGH_WIN_RATE_WARNING,
    thresholds: { ...HIGH_WIN_RATE_THRESHOLDS },
    restoredAvailable: Boolean(config.strategyProfileSnapshot),
  };
}

/** Restore knobs saved before High Win-Rate (or last snapshot). */
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
  config.strategyProfile =
    snap.fromProfile === 'high_win_rate' ? 'custom' : snap.fromProfile;
  config.highWinRatePresetActive = false;
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

/** Balanced preset — registry defaults + Medium-like quality knobs (no risk-level overwrite). */
export function applyBalancedPreset(options?: {
  persist?: boolean;
}): StrategyToggleMap {
  ensureStrategyToggles();
  if (config.strategyProfile === 'high_win_rate') {
    config.strategyProfileSnapshot = {
      savedAt: Date.now(),
      fromProfile: 'high_win_rate',
      knobs: captureStrategyProfileKnobs() as unknown as Record<string, unknown>,
    };
  }
  const balanced = defaultStrategyToggles();
  updateStrategyToggles(balanced, {
    persist: false,
    syncUnderlying: true,
    markCustom: false,
  });
  // Soft balanced thresholds (do not clobber risk-level extremes aggressively)
  config.filters.minWalletQualityScore = Math.min(
    config.filters.minWalletQualityScore ?? 55,
    55
  );
  if ((config.filters.minWalletQualityScore ?? 0) < 55) {
    config.filters.minWalletQualityScore = 55;
  }
  config.selective.minConvictionScore = Math.min(
    Math.max(config.selective.minConvictionScore ?? 40, 40),
    55
  );
  config.filters.convergenceRequired = Math.min(
    Math.max(config.filters.convergenceRequired ?? 2, 2),
    2
  );
  config.filters.clusterMinWallets = Math.min(
    Math.max(config.filters.clusterMinWallets ?? 2, 2),
    2
  );
  config.selective.minWalletsForTrade = Math.min(
    Math.max(config.selective.minWalletsForTrade ?? 2, 2),
    2
  );
  config.selective.allowSingleWalletMigration = true;
  config.filters.allowSingleWalletTopPerformerMigration = true;
  config.filters.sniperSensitivity = 'medium';
  config.filters.requireMomentumConfirmation = false;
  config.bondingCurve.requireHealthyCurve = false;
  config.strategy.enableEarlyCurvePriority = true;
  config.strategy.reBuyEnabled = true;
  config.strategy.postStopReentryEnabled = true;
  config.risk.deadVolumeConsecutiveHours = 3;
  config.risk.deadVolumeUsdPerHour = 50;
  config.risk.deadVolumeMinHoldMinutes = 30;
  config.strategyProfile = 'balanced';
  config.highWinRatePresetActive = false;
  if (options?.persist !== false) persistUserSettings();
  console.log('[strategies] Balanced preset applied');
  return { ...config.strategyToggles } as StrategyToggleMap;
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
  return {
    toggles: { ...toggles },
    registry: STRATEGY_REGISTRY.map((s) => ({
      ...s,
      enabled: toggles[s.key] !== false,
      frequencyLabel: frequencyImpactLabel(s.frequencyWhenOn),
      status: toggles[s.key] !== false ? 'ON' : 'OFF',
    })),
    groups: STRATEGY_GROUP_ORDER.map((g) => ({
      id: g,
      label: STRATEGY_GROUP_LABELS[g],
      strategies: STRATEGY_REGISTRY.filter((s) => s.group === g).map(
        (s) => s.key
      ),
    })),
    highWinRatePreset: { ...HIGH_WIN_RATE_PRESET },
    highWinRateThresholds: { ...HIGH_WIN_RATE_THRESHOLDS },
    highWinRateWarning: HIGH_WIN_RATE_WARNING,
    highWinRatePresetActive: config.highWinRatePresetActive === true,
    strategyProfile: config.strategyProfile || 'custom',
    canRestorePrevious: Boolean(config.strategyProfileSnapshot?.knobs),
    previousSnapshotAt: config.strategyProfileSnapshot?.savedAt ?? null,
    enabledCount,
    totalCount: STRATEGY_KEYS.length,
    riskLevel: config.riskLevel,
    strictMode: config.strictMode === true,
    strictModeIntensity: config.strictModeIntensity,
  };
}
