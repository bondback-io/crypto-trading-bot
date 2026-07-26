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
  };
  paper?: Record<string, unknown>;
  marketScanner?: Record<string, unknown>;
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

export function savePersistedSettings(settings: PersistedBotSettings): void {
  try {
    ensureDataDir();
    ensureMigrated();
    const payload: PersistedBotSettings = {
      ...settings,
      version: SETTINGS_VERSION,
      updatedAt: Date.now(),
    };
    atomicWriteJson(SETTINGS_FILE, payload);
  } catch (err) {
    console.error(
      '[settings] Failed to save config.json:',
      err instanceof Error ? err.message : err
    );
  }
}

export function hasPersistedSettings(): boolean {
  ensureMigrated();
  return (
    require('fs').existsSync(SETTINGS_FILE) ||
    require('fs').existsSync(LEGACY_SETTINGS_FILE)
  );
}
