/**
 * Persist dashboard / runtime bot settings to data/bot-settings.json.
 *
 * Load order: code defaults + env → deep-merge saved file (saved wins).
 * New keys added in code updates keep their defaults; existing saved values
 * are never wiped by a redeploy or code change.
 *
 * On Render: attach a persistent disk (Starter+) or files are wiped each deploy.
 */

import fs from 'fs';
import { dataFile, ensureDataDir } from './dataDir';

const SETTINGS_FILE = dataFile('bot-settings.json');

export const SETTINGS_VERSION = 1 as const;

/** Serializable user settings (no secrets, no wallets) */
export interface PersistedBotSettings {
  version: typeof SETTINGS_VERSION;
  updatedAt: number;
  mode?: 'paper' | 'live';
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

export function settingsFilePath(): string {
  return SETTINGS_FILE;
}

export function loadPersistedSettings(): PersistedBotSettings | null {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return null;
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as PersistedBotSettings;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    console.error(
      '[settings] Failed to load bot-settings.json — using code defaults:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

export function savePersistedSettings(settings: PersistedBotSettings): void {
  try {
    ensureDataDir();
    const payload: PersistedBotSettings = {
      ...settings,
      version: SETTINGS_VERSION,
      updatedAt: Date.now(),
    };
    const tmp = `${SETTINGS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tmp, SETTINGS_FILE);
  } catch (err) {
    console.error(
      '[settings] Failed to save bot-settings.json:',
      err instanceof Error ? err.message : err
    );
  }
}

export function hasPersistedSettings(): boolean {
  return fs.existsSync(SETTINGS_FILE);
}
