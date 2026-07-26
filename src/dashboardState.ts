/**
 * Persist Overview dashboard session metadata (last reset time).
 * Survives refresh / restart when DATA_DIR is durable.
 *
 * On a new build (commit / BUILD_ID change), lastDashboardResetAt is bumped
 * so the Overview elapsed timer starts from deploy — without wiping trades.
 */

import {
  atomicWriteJson,
  dataFile,
  ensureDataDir,
  PERSIST_FILES,
  readJsonFile,
} from './dataDir';
import { getBuildId } from './version';

const STATE_FILE = dataFile(PERSIST_FILES.dashboardState);

export interface DashboardState {
  version: 1;
  updatedAt: number;
  /** Epoch ms of last Overview Reset; null if never reset */
  lastDashboardResetAt: number | null;
  /** Build identity when the reset timer was last aligned to a deploy */
  lastBuildId: string | null;
  /**
   * When true, skip boot-time Import Favourites auto-load
   * (set by Reset Wallet Tracker until user runs Import Favourites again).
   */
  skipFavouritesAutoImport?: boolean;
}

let cached: DashboardState | null = null;
let buildEnsureDone = false;

function normalize(raw: Partial<DashboardState> | null): DashboardState {
  const ts =
    raw && typeof raw.lastDashboardResetAt === 'number' && Number.isFinite(raw.lastDashboardResetAt)
      ? Math.floor(raw.lastDashboardResetAt)
      : null;
  const lastBuildId =
    raw && typeof raw.lastBuildId === 'string' && raw.lastBuildId.trim()
      ? raw.lastBuildId.trim()
      : null;
  return {
    version: 1,
    updatedAt:
      raw && typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
        ? Math.floor(raw.updatedAt)
        : Date.now(),
    lastDashboardResetAt: ts,
    lastBuildId,
    skipFavouritesAutoImport: raw?.skipFavouritesAutoImport === true,
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

/**
 * Align the Overview reset timer with the current build.
 * - New build id → set lastDashboardResetAt = now (does not wipe trades)
 * - Missing timestamp (first run) → initialize to now
 * Idempotent for the same process + same persisted build id.
 */
export function ensureDashboardResetTimerForBuild(
  buildId: string = getBuildId()
): number {
  const state = loadDashboardState();
  const buildChanged = state.lastBuildId !== buildId;
  const missingTs = state.lastDashboardResetAt == null;

  if (buildChanged || missingTs) {
    const ts = Date.now();
    saveDashboardState({
      version: 1,
      updatedAt: ts,
      lastDashboardResetAt: ts,
      lastBuildId: buildId,
      skipFavouritesAutoImport: state.skipFavouritesAutoImport === true,
    });
    if (!buildEnsureDone) {
      const reason = missingTs && !buildChanged ? 'first-run' : 'new-build';
      console.log(
        `[dashboard] Overview reset timer started (${reason}, build=${buildId.slice(0, 12)})`
      );
    }
    buildEnsureDone = true;
    return ts;
  }

  buildEnsureDone = true;
  return state.lastDashboardResetAt as number;
}

/** Epoch ms of last Overview Reset (after build-align). Never null once ensured. */
export function getLastDashboardResetAt(): number | null {
  return ensureDashboardResetTimerForBuild();
}

/** Record a successful Overview Reset and persist. Returns the new timestamp. */
export function markDashboardReset(atMs: number = Date.now()): number {
  const ts = Math.floor(atMs);
  const prev = loadDashboardState();
  saveDashboardState({
    version: 1,
    updatedAt: ts,
    lastDashboardResetAt: ts,
    lastBuildId: prev.lastBuildId ?? getBuildId(),
    skipFavouritesAutoImport: prev.skipFavouritesAutoImport === true,
  });
  return ts;
}

export function getSkipFavouritesAutoImport(): boolean {
  return loadDashboardState().skipFavouritesAutoImport === true;
}

export function setSkipFavouritesAutoImport(skip: boolean): void {
  const prev = loadDashboardState();
  saveDashboardState({
    ...prev,
    updatedAt: Date.now(),
    skipFavouritesAutoImport: skip === true,
  });
}

/** Drop in-memory cache (e.g. after wipe of data files). */
export function clearDashboardStateCache(): void {
  cached = null;
  buildEnsureDone = false;
}
