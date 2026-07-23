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
  mode?: 'paper' | 'live';
  riskLevel?: 'low' | 'medium' | 'high' | 'degen';
  trade?: Record<string, unknown>;
  filters?: Record<string, unknown>;
  strategy?: Record<string, unknown>;
  risk?: Record<string, unknown>;
  profitStrategy?: Record<string, unknown>;
  selective?: Record<string, unknown>;
  paper?: Record<string, unknown>;
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
