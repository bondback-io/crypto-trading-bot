/**
 * Persist Overview dashboard session metadata (last reset time).
 * Survives refresh / restart when DATA_DIR is durable.
 */

import {
  atomicWriteJson,
  dataFile,
  ensureDataDir,
  PERSIST_FILES,
  readJsonFile,
} from './dataDir';

const STATE_FILE = dataFile(PERSIST_FILES.dashboardState);

export interface DashboardState {
  version: 1;
  updatedAt: number;
  /** Epoch ms of last Overview Reset; null if never reset */
  lastDashboardResetAt: number | null;
}

let cached: DashboardState | null = null;

function normalize(raw: Partial<DashboardState> | null): DashboardState {
  const ts =
    raw && typeof raw.lastDashboardResetAt === 'number' && Number.isFinite(raw.lastDashboardResetAt)
      ? Math.floor(raw.lastDashboardResetAt)
      : null;
  return {
    version: 1,
    updatedAt:
      raw && typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
        ? Math.floor(raw.updatedAt)
        : Date.now(),
    lastDashboardResetAt: ts,
  };
}

export function loadDashboardState(): DashboardState {
  if (cached) return cached;
  ensureDataDir();
  const parsed = readJsonFile<Partial<DashboardState>>(STATE_FILE);
  cached = normalize(parsed);
  return cached;
}

function saveDashboardState(state: DashboardState): void {
  try {
    ensureDataDir();
    cached = state;
    atomicWriteJson(STATE_FILE, state);
  } catch (err) {
    console.error(
      '[dashboard] Failed to save dashboardState.json:',
      err instanceof Error ? err.message : err
    );
  }
}

/** Epoch ms of last Overview Reset, or null if never reset. */
export function getLastDashboardResetAt(): number | null {
  return loadDashboardState().lastDashboardResetAt;
}

/** Record a successful Overview Reset and persist. Returns the new timestamp. */
export function markDashboardReset(atMs: number = Date.now()): number {
  const ts = Math.floor(atMs);
  saveDashboardState({
    version: 1,
    updatedAt: ts,
    lastDashboardResetAt: ts,
  });
  return ts;
}

/** Drop in-memory cache (e.g. after wipe of data files). */
export function clearDashboardStateCache(): void {
  cached = null;
}
