/**
 * Persist dashboard / runtime bot settings to data/config.json.
 *
 * Load order: code defaults + env → deep-merge saved file (saved wins).
 * New keys added in code updates keep their defaults; existing saved values
 * are never wiped by a redeploy or code change.
 *
 * Migrates legacy data/bot-settings.json → data/config.json once.
 */

import {
  atomicWriteJson,
  dataFile,
  ensureDataDir,
  migrateLegacyFile,
  PERSIST_FILES,
  readJsonFile,
} from './dataDir';

const SETTINGS_FILE = dataFile(PERSIST_FILES.config);
const LEGACY_SETTINGS_FILE = dataFile(PERSIST_FILES.legacyConfig);

export const SETTINGS_VERSION = 2 as const;

/** Serializable user settings (no secrets, no wallets) */
export interface PersistedBotSettings {
  version: number;
  updatedAt: number;
  mode?: 'paper' | 'liveSimulation' | 'live';
  /** Canonical on|off; legacy low|medium|high|degen accepted on load then migrated */
  riskLevel?: 'on' | 'off' | 'low' | 'medium' | 'high' | 'degen';
  trade?: Record<string, unknown>;
  filters?: Record<string, unknown>;
  strategy?: Record<string, unknown>;
  risk?: Record<string, unknown>;
  profitStrategy?: Record<string, unknown>;
  selective?: Record<string, unknown>;
  quickScalper?: Record<string, unknown>;
  microScalper?: Record<string, unknown>;
  momentumBurst?: Record<string, unknown>;
  postMigrationScalp?: Record<string, unknown>;
  reversalScalp?: Record<string, unknown>;
  postRunDip?: Record<string, unknown>;
  technicalLevels?: Record<string, unknown>;
  chartPatterns?: Record<string, unknown>;
  /** Strategies tab master toggles */
  strategyToggles?: Record<string, boolean>;
  strategyProfile?:
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
  highWinRatePresetActive?: boolean;
  /** synced = Risk owns modules; custom = manual/pack override */
  strategyRecipeMode?: 'synced' | 'custom';
  strategyRecipeRiskLevel?: 'on' | 'off' | 'low' | 'medium' | 'high' | 'degen' | null;
  /** Per-risk overlays from Risk Recipe Optimizer */
  riskRecipeOptimizations?: Record<string, unknown>;
  strategyProfileSnapshot?: Record<string, unknown> | null;
  /** Concurrent trade profile ON/OFF map + optional param overrides */
  tradeProfiles?: {
    enabled?: boolean;
    smartBotProfiles?: boolean;
    profiles?: Record<string, boolean>;
    overrides?: Record<
      string,
      {
        exitRules?: Record<string, unknown>;
        match?: Record<string, unknown>;
        modules?: Record<string, boolean>;
      }
    >;
    autoScoring?: {
      enabled?: boolean;
      minScore?: number;
      skipBelowMin?: boolean;
      forceProfileId?: string | null;
      weights?: Record<string, number>;
    };
    selfLearning?: Record<string, unknown>;
    /** Per-profile Participate in Learning Mode (default true when unset). */
    learningModeOptIn?: Record<string, boolean>;
    globalTakeProfit?: {
      enabled?: boolean;
      takeProfitPct?: number;
    };
  };
    paper?: Record<string, unknown>;
  /** Email notification preferences (no SMTP secrets) */
  notifications?: {
    enabled?: boolean;
    email?: string;
    lowEquitySol?: number;
    lowEquityEnabled?: boolean;
    lowEquityCooldownMs?: number;
    insufficientFundsEnabled?: boolean;
    insufficientFundsCooldownMs?: number;
    profitableCloseEnabled?: boolean;
    profitEmailMode?: 'instant' | 'cluster' | 'both';
    profitEmailClusterInterval?: '1h' | '2h' | '4h' | '12h' | '24h';
    profitEmailTo?: string;
    dashboardEnabled?: boolean;
    tradeRequestSound?: boolean;
    profitCloseSound?: boolean;
    zionPlaceTradeSound?: boolean;
    tradeRequestPopups?: boolean;
  };
  marketScanner?: Record<string, unknown>;
  /** AlphaScan-style New/Soon/Bonded discovery (additive) */
  alphaScan?: Record<string, unknown>;
  /** Zion micro-bot (KOL scanner + manual trade offers) */
  zion?: Record<string, unknown>;
  mev?: Record<string, unknown>;
  gmgnDiscovery?: Record<string, unknown>;
  walletDiscovery?: {
    defaultSource?: string;
    cacheTtlMs?: number;
  };
  tokenMetrics?: Record<string, unknown>;
  bondingCurve?: Record<string, unknown>;
  convergenceWindowMs?: number;
  pollIntervalMs?: number;
  /** Share RPC load across Helius / Alchemy / public */
  rpcShareLoad?: boolean;
  /** Favourites soft-watch wallet cap (0 = pause) */
  rpcSoftWatchCap?: number | null;
  /** Micro-bot Learning Mode (global gate overlays + fairness) */
  learningMode?: {
    enabled?: boolean;
    strictness?: 'stricter' | 'middle' | 'looser';
    snapshot?: Record<string, unknown> | null;
    fairnessBoost?: boolean;
  };
  /** Episode learning sources (Live Mode inclusion) */
  learning?: {
    includeLiveModeEpisodes?: boolean;
  };
  /** Soft MARL coordinator */
  marl?: {
    enabled?: boolean;
    strength?: 'low' | 'medium' | 'high';
    lowMcUsd?: number;
    lowMcWindowMin?: number;
    maxAgentsPerLowMc?: number;
    laggingSupportEnabled?: boolean;
  };
  /** Per-profile RL soft agents */
  profileRl?: {
    enabled?: boolean;
    strength?: 'low' | 'medium' | 'high';
  };
  /** Learning accelerators trio */
  learningAccelerators?: {
    enabled?: boolean;
    replayEnabled?: boolean;
    counterfactualEnabled?: boolean;
    counterfactualApplyHints?: boolean;
    teacherStudentEnabled?: boolean;
    strength?: 'low' | 'medium' | 'high';
    replayBatchSize?: number;
    replayMaxPerHour?: number;
  };
  /** Additive learning enhancements */
  learningEnhancements?: {
    enabled?: boolean;
    schedulerEnabled?: boolean;
    qualityWeightingEnabled?: boolean;
    dualRewardEnabled?: boolean;
    explorationEnabled?: boolean;
    explorationRate?: number;
    watchdogEnabled?: boolean;
    schedulerIntervalMs?: number;
  };
  zionAgent?: {
    semiAutonomous?: boolean;
    personalityEnabled?: boolean;
    supervisionEnabled?: boolean;
    fightLogCommentsEnabled?: boolean;
    supervisionEmailEnabled?: boolean;
    healthCheckIntervalMsHealthy?: number;
    healthCheckIntervalMsWatch?: number;
    healthCheckIntervalMsAction?: number;
  };
  /** Soft Peak Profit Protection (TP-relative arm + proportional giveback) */
  peakProfitProtection?: {
    enabled?: boolean;
    armOfTpPct?: number;
    givebackOfPeakPct?: number;
    scalperArmOfTpPct?: number;
    scalperGivebackOfPeakPct?: number;
    stalePeakTightenSec?: number;
    staleGivebackTightenMult?: number;
  };
  /** Additive Volume Intelligence (strength / decay / divergence) */
  volumeIntelligence?: {
    enabled?: boolean;
    blockCollapsedOnFastProfiles?: boolean;
    fastMinVolumeM5Usd?: number;
    fastMinVolumeH1Usd?: number;
    healthyM5Usd?: number;
    healthyH1Usd?: number;
    strongM5Usd?: number;
    strongH1Usd?: number;
    shortTermDecayRatio?: number;
    postSpikeDropRatio?: number;
    collapseAbsM5Usd?: number;
    collapseAbsH1Usd?: number;
    decayTightenMult?: number;
    collapseTightenMult?: number;
    exitUrgencyOnDecay?: boolean;
    divergenceEnabled?: boolean;
    divergenceVolDropRatio?: number;
    divergenceMinSwingPct?: number;
    exitUrgencyOnBearishDivergence?: boolean;
    learningAdjustEnabled?: boolean;
    profileSoft?: Record<
      string,
      {
        decaySensitivity?: number;
        entryDecayWeight?: number;
        exitUrgencyMult?: number;
        divergenceWeight?: number;
      }
    >;
  };
  /** HMC Phase 1 Gatekeeper (allow/block before lane fight) */
  hierarchicalCoordination?: {
    enabled?: boolean;
    gatekeeperEnabled?: boolean;
    gatekeeperStrictness?: 'low' | 'medium' | 'high';
    softBlocksEnforced?: boolean;
    minVolumeM5Usd?: number;
    minVolumeH1Usd?: number;
    minLiquidityUsd?: number;
    debugLogging?: 'off' | 'normal' | 'verbose';
    classifierEnabled?: boolean;
    unknownSetupsCanTrade?: boolean;
  };
  /** Fast Profiles Recovery Stages 0–4 (no secrets) */
  fastProfileRecovery?: {
    enabled?: boolean;
    autoTaper?: boolean;
    profiles?: Record<
      string,
      {
        enabled?: boolean;
        stage?: number;
        stageLocked?: boolean;
        forcedStage?: number | null;
        learningModeOverride?: boolean;
      }
    >;
    stage0?: {
      maxConcurrent?: number;
      sizeMultiplier?: number;
      minMsBetweenEntries?: number;
      peakProtectArmOfTpPct?: number;
      peakProtectGivebackOfPeakPct?: number;
      minVolumeM5Usd?: number;
    };
    minTradesBeforePromote?: number;
    minTradesBeforePromoteTo4?: number;
    promoteReadinessByStage?: Record<string, number>;
    demoteReadinessMax?: number;
    readinessWeights?: {
      expectancyTrend?: number;
      winRateTrend?: number;
      givebackImprovement?: number;
      lossStreakControl?: number;
      stability?: number;
      sampleSufficiency?: number;
    };
  };
  /** Dip Buyer Recovery Stages 0–4 (no secrets) */
  dipBuyerRecovery?: {
    enabled?: boolean;
    autoTaper?: boolean;
    stage?: number;
    stageLocked?: boolean;
    forcedStage?: number | null;
    learningModeOverride?: boolean;
    learningAdjustEnabled?: boolean;
    minTradesBeforePromote?: number;
    minTradesBeforePromoteTo4?: number;
    promoteReadinessByStage?: Record<string, number>;
    demoteReadinessMax?: number;
    readinessWeights?: {
      expectancyTrend?: number;
      winRateTrend?: number;
      givebackImprovement?: number;
      bounceFollowThrough?: number;
      lossStreakControl?: number;
      sampleSufficiency?: number;
    };
  };
  /** Zion whitelist transfers (no password secrets) */
  zionTransfers?: {
    enabled?: boolean;
    savedWallets?: Array<{
      id?: string;
      name?: string;
      address?: string;
      aliases?: string[];
      allowSendTo?: boolean;
    }>;
    defaultSavingsWalletId?: string;
    confirmThresholdSol?: number;
    maxSingleTransferSol?: number;
    dailyTransferCapSol?: number;
    cooldownMs?: number;
  };
  /** One-shot migrations already applied (e.g. paperSignalRelax_v2) */
  migrations?: Record<string, boolean>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deep-merge overlay onto base. Overlay wins for primitives/arrays;
 * nested plain objects are merged recursively so new default keys survive.
 */
export function deepMerge<T>(base: T, overlay: unknown): T {
  if (overlay === undefined || overlay === null) return base;
  if (!isPlainObject(base) || !isPlainObject(overlay)) {
    return overlay as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    const prev = out[key];
    if (isPlainObject(prev) && isPlainObject(value)) {
      out[key] = deepMerge(prev, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

function ensureMigrated(): void {
  migrateLegacyFile(LEGACY_SETTINGS_FILE, SETTINGS_FILE);
}

export function settingsFilePath(): string {
  ensureMigrated();
  return SETTINGS_FILE;
}

export function loadPersistedSettings(): PersistedBotSettings | null {
  try {
    ensureDataDir();
    ensureMigrated();
    const parsed = readJsonFile<PersistedBotSettings>(SETTINGS_FILE);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    console.error(
      '[settings] Failed to load config.json — using code defaults:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

export function savePersistedSettings(settings: PersistedBotSettings): boolean {
  try {
    ensureDataDir();
    ensureMigrated();
    const payload: PersistedBotSettings = {
      ...settings,
      version: SETTINGS_VERSION,
      updatedAt: Date.now(),
    };
    atomicWriteJson(SETTINGS_FILE, payload);
    return true;
  } catch (err) {
    console.error(
      '[settings] Failed to save config.json:',
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

export function hasPersistedSettings(): boolean {
  ensureMigrated();
  return (
    require('fs').existsSync(SETTINGS_FILE) ||
    require('fs').existsSync(LEGACY_SETTINGS_FILE)
  );
}
