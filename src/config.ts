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

export type { SmartWallet, TradingWalletSlot, TradingWalletRole };
export { hasPersistedSettings };
export type TradingMode = 'paper' | 'live';

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
  normal: StrategyRiskRules;
  migration: StrategyRiskRules;
}

export const DEFAULT_RISK: RiskConfig = {
  enabled: true,
  useRiskSizing: true,
  riskPercentPerTrade: 1.5,
  maxTradeSol: 1,
  minTradeSol: 0.02,
  weeklyLossLimitSol: 5,
  maxDrawdownPct: 25,
  autoPauseOnLimit: true,
  tieredSellEnabled: true,
  trailingStopPct: 20,
  trailingStopPercent: 20,
  trailingActivationProfit: 30,
  normal: {
    riskPercentPerTrade: 1.5,
    trailingStopPct: 20,
    hardStopLossPct: -35,
    tiers: [
      { profitPct: 50, sellPct: 40 },
      { profitPct: 100, sellPct: 30 },
    ],
  },
  migration: {
    riskPercentPerTrade: 2,
    trailingStopPct: 25,
    hardStopLossPct: -40,
    sizeMultiplier: 1.25,
    tiers: [
      { profitPct: 50, sellPct: 40 },
      { profitPct: 100, sellPct: 30 },
    ],
  },
};

export interface TradeConfig {
  /** SOL per copy trade (~$10–20) */
  tradeAmountSol: number;
  /** Minimum take-profit % (bot picks random target in [min, max]) */
  minProfitPercent: number;
  maxProfitPercent: number;
  /** Stop-loss as negative % (e.g. -35 = sell at 35% loss) */
  stopLossPercent: number;
}

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

export const DEFAULT_PROFIT_STRATEGY: ProfitStrategyConfig = {
  enabled: true,
  takeInitialPercent: 100,
  partialSellAt: 80,
  partialSellPercent: 50,
  trailingStopAfter: 150,
  trailingStopPct: 25,
  bagPercent: 30,
  riskBasedAdjustment: true,
  highRiskScoreThreshold: 60,
};

export interface FilterConfig {
  /** Minimum wallet win-rate % to include in signals (0 = disabled) */
  minWinRate: number;
  /** Minimum pool liquidity USD (0 = disabled) */
  minLiquidity: number;
  /** Skip if estimated dev/authority hold % exceeds this (0 = disabled) */
  maxDevHoldPct: number;
  /** Preferred alias for maxDevHoldPct (anti-rug) */
  maxDevPercent: number;
  /** Skip if largest single holder % exceeds this (0 = disabled) */
  maxTopHolderPct: number;
  /** Skip if top-10 holders concentration % exceeds this (0 = disabled) */
  maxHolderConcentration: number;
  /** Master switch for comprehensive anti-rug checks */
  enableAntiRug: boolean;
  /** Require LP locked/burned (RugCheck / heuristics) */
  requireLiquidityLocked: boolean;
  /** Skip when recent token sells detected from dev wallet */
  skipIfDevRecentSells: boolean;
  /** Probe Jupiter buy→sell for honeypot / high tax */
  checkHoneypot: boolean;
  /** Max estimated round-trip loss % before skip (tax/slip proxy) */
  maxEstimatedTaxPct: number;
  /** Skip when composite risk score ≥ this (0–100) */
  maxRiskScore: number;
  /** Skip tokens that still have a mint authority */
  skipIfMintAuthority: boolean;
  /** Filter / score tokens with heavy GMGN sniper/bundler activity */
  enableSniperFilter: boolean;
  /** How strict sniper thresholds are */
  sniperSensitivity: 'low' | 'medium' | 'high';
  /** Override max sniper wallet count (0 = use sensitivity default) */
  maxSniperCount: number;
  /** Override max bundler volume % (0 = use sensitivity default) */
  maxBundlerPct: number;
  /** Override max insider/rat volume % (0 = use sensitivity default) */
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
}

export interface BotConfig {
  mode: TradingMode;
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

  /** Multi-source wallet discovery (GMGN / Birdeye / DexScreener / Kolscan / manual) */
  walletDiscovery: {
    defaultSource: 'gmgn' | 'birdeye' | 'dexscreener' | 'kolscan' | 'manual' | 'all';
    cacheTtlMs: number;
    birdeyeApiKey: string;
    birdeyeBaseUrl: string;
  };

  /** Multi-RPC + Jito + priority fees */
  rpc: {
    endpoints: { url: string; label: string; wsUrl?: string }[];
    healthIntervalMs: number;
    failureThreshold: number;
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

  /** Pump.fun bonding curve analysis */
  bondingCurve: {
    cacheTtlMs: number;
    /** Approx SOL raised when curve completes */
    migrationThresholdSol: number;
    /** Initial real token reserves (raw) for progress % */
    initialRealTokenReserves: number;
  };

  /** Time window (ms) for convergence detection */
  convergenceWindowMs: number;

  /** Paper trading simulation */
  paper: {
    startingBalanceSol: number;
    feeBps: number;
    slippageBps: number;
    positionCheckIntervalMs: number;
    /** Use DexScreener/GMGN prices for paper TP/SL & backtests */
    useLiveData: boolean;
  };

  pollIntervalMs: number;
  solMint: string;
  pumpFunProgramId: string;
  pumpSwapProgramId: string;
  port: number;
}

export const config: BotConfig = {
  mode: 'paper',
  smartWallets: [],
  tradingWallets: [],
  activeTradingWalletId: null,

  trade: {
    tradeAmountSol: 0.15,
    minProfitPercent: 50,
    maxProfitPercent: 100,
    stopLossPercent: -35,
  },

  filters: {
    minWinRate: 0,
    minLiquidity: 5_000,
    maxDevHoldPct: 15,
    maxDevPercent: 15,
    maxTopHolderPct: 40,
    maxHolderConcentration: 40,
    enableAntiRug: true,
    requireLiquidityLocked: false,
    skipIfDevRecentSells: true,
    checkHoneypot: true,
    maxEstimatedTaxPct: 25,
    maxRiskScore: 70,
    skipIfMintAuthority: false,
    enableSniperFilter: true,
    sniperSensitivity: 'medium',
    maxSniperCount: 0,
    maxBundlerPct: 0,
    maxInsiderPct: 0,
    maxSniperScore: 0,
    convergenceRequired: 2,
    maxConcurrentPositions: 5,
    dailyLossLimitSol: 2,
    minActivityDays: 7,
    minTradesLast30d: 5,
    enableActivityFilter: true,
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
    migrationSizeMultiplier: 1.5,
    migrationSlippageBps: 100,
    migrationVolumeSpikeSol: 40,
    reBuyEnabled: true,
    reBuyMinProfitPct: 100,
    reBuyDipPercent: -30,
    confirmationThreshold: 4,
    reBuyVolumeIncreasePct: 50,
    reBuyMaxPerMint: 2,
  },

  risk: { ...DEFAULT_RISK },

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

  gmgn: {
    apiKey: process.env.GMGN_API_KEY?.trim() || '',
    baseUrl: process.env.GMGN_BASE_URL?.trim() || 'https://gmgn.ai',
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
        s === 'all'
      ) {
        return s as
          | 'gmgn'
          | 'birdeye'
          | 'dexscreener'
          | 'kolscan'
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

  rpc: {
    endpoints: (() => {
      const primary = process.env.RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
      const fallbacks = (process.env.RPC_FALLBACKS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const list = [
        { url: primary, label: 'primary' },
        ...fallbacks.map((url, i) => ({ url, label: `fallback-${i + 1}` })),
      ];
      const seen = new Set<string>();
      return list.filter((e) => {
        if (seen.has(e.url)) return false;
        seen.add(e.url);
        return true;
      });
    })(),
    healthIntervalMs: 30_000,
    failureThreshold: 3,
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
  },

  convergenceWindowMs: 5 * 60 * 1000,

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
export function buildPersistedSettingsSnapshot(): PersistedBotSettings {
  return {
    version: SETTINGS_VERSION,
    updatedAt: Date.now(),
    mode: config.mode,
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
    paper: { ...config.paper },
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
  };
}

/** Persist current tunable settings without touching wallets or secrets. */
export function persistUserSettings(): void {
  savePersistedSettings(buildPersistedSettingsSnapshot());
}

/**
 * Apply data/bot-settings.json on top of code/env defaults.
 * Saved keys win; new keys from code updates keep their defaults.
 */
export function applyPersistedSettings(): boolean {
  const saved = loadPersistedSettings();
  if (!saved) {
    console.log('[settings] No bot-settings.json — using code/env defaults');
    return false;
  }

  if (saved.mode === 'paper' || saved.mode === 'live') {
    config.mode = saved.mode;
  }
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
  if (saved.paper) config.paper = deepMerge(config.paper, saved.paper);
  if (saved.mev) config.mev = deepMerge(config.mev, saved.mev);
  if (saved.gmgnDiscovery) {
    config.gmgn.discovery = deepMerge(
      config.gmgn.discovery,
      saved.gmgnDiscovery
    );
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
  if (saved.tokenMetrics) {
    config.tokenMetrics = deepMerge(config.tokenMetrics, saved.tokenMetrics);
  }
  if (saved.bondingCurve) {
    config.bondingCurve = deepMerge(config.bondingCurve, saved.bondingCurve);
  }
  if (typeof saved.convergenceWindowMs === 'number') {
    config.convergenceWindowMs = saved.convergenceWindowMs;
  }
  if (typeof saved.pollIntervalMs === 'number') {
    config.pollIntervalMs = saved.pollIntervalMs;
  }

  // Keep filter aliases in sync after merge
  if (config.filters.maxDevHoldPct != null) {
    config.filters.maxDevPercent = config.filters.maxDevHoldPct;
  }
  if (config.risk.trailingStopPercent != null) {
    config.risk.trailingStopPct = config.risk.trailingStopPercent;
  } else if (config.risk.trailingStopPct != null) {
    config.risk.trailingStopPercent = config.risk.trailingStopPct;
  }

  console.log(
    `[settings] Loaded bot-settings.json (updated ${new Date(saved.updatedAt || 0).toISOString()}) — saved values kept over code defaults`
  );
  return true;
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
    lastCheckedAt: w.lastCheckedAt,
  }));

  initTradingWallets();
  applyPersistedSettings();
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
        'envVar must be PRIVATE_KEY or TRADING_WALLET_* (e.g. TRADING_WALLET_3)',
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
 * Main role falls back to PRIVATE_KEY if TRADING_WALLET_1 empty.
 * NEVER log the returned value.
 */
export function resolveTradingWalletSecret(
  slot: TradingWalletSlot
): string | null {
  if (!isAllowedKeyEnvVar(slot.envVar)) return null;

  const primary = process.env[slot.envVar]?.trim();
  if (primary) return primary;

  // Legacy / convenience: main wallet may use PRIVATE_KEY
  if (
    (slot.role === 'main' || slot.envVar === 'TRADING_WALLET_1') &&
    process.env.PRIVATE_KEY?.trim()
  ) {
    return process.env.PRIVATE_KEY.trim();
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
      addedAt: prev?.addedAt ?? Date.now(),
    };
  });
  saveWalletsToDisk(records);
}

export function updateConfig(partial: Partial<BotConfig>): void {
  Object.assign(config, partial);
  persistUserSettings();
}

export function updateTradeConfig(partial: Partial<TradeConfig>): void {
  Object.assign(config.trade, partial);
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
  persistUserSettings();
}

export function updateStrategyConfig(partial: Partial<StrategyConfig>): void {
  Object.assign(config.strategy, partial);
  persistUserSettings();
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
  config.mode = mode;
  console.log(`[config] Trading mode set to: ${mode.toUpperCase()}`);
  if (options.persist !== false) {
    persistUserSettings();
  }
}

export function randomTakeProfitPct(): number {
  const { minProfitPercent, maxProfitPercent } = config.trade;
  return minProfitPercent + Math.random() * (maxProfitPercent - minProfitPercent);
}

/** Flat config snapshot for dashboard/API */
export function getConfigSnapshot() {
  return {
    mode: config.mode,
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
    paper: { ...config.paper },
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
    },
    rpc: {
      endpoints: config.rpc.endpoints.map((e) => ({
        label: e.label,
        url: e.url.replace(/\/\/.*@/, '//***@').slice(0, 60),
      })),
      jitoEnabled: config.rpc.jito.enabled,
      healthIntervalMs: config.rpc.healthIntervalMs,
    },
    mev: { ...config.mev },
    tokenMetrics: { ...config.tokenMetrics },
    bondingCurve: { ...config.bondingCurve },
    convergenceWindowMs: config.convergenceWindowMs,
    pollIntervalMs: config.pollIntervalMs,
    smartWallets: config.smartWallets,
  };
}
