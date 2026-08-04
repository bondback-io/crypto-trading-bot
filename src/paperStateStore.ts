/**
 * Persist paper trading balance + positions to data/paperBalance.json.
 * Survives redeploys / idle restarts when DATA_DIR is on a volume.
 */

import type { Position } from './paperTrader';
import {
  atomicWriteJson,
  dataFile,
  ensureDataDir,
  PERSIST_FILES,
  readJsonFile,
} from './dataDir';

const PAPER_FILE = dataFile(PERSIST_FILES.paperBalance);

export interface PersistedPaperState {
  version: 1;
  updatedAt: number;
  balanceSol: number;
  startingBalanceSol: number;
  positions: Position[];
  closedPositions: Position[];
  /** Lifetime representative closed trade counts (survive 200-row list rotation). */
  lifetimeClosed?: number;
  lifetimeWins?: number;
  lifetimeLosses?: number;
}

export function paperBalanceFilePath(): string {
  return PAPER_FILE;
}

export function loadPaperBalance(): PersistedPaperState | null {
  ensureDataDir();
  const parsed = readJsonFile<PersistedPaperState>(PAPER_FILE);
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.balanceSol !== 'number') return null;
  return {
    version: 1,
    updatedAt: parsed.updatedAt ?? Date.now(),
    balanceSol: parsed.balanceSol,
    startingBalanceSol:
      typeof parsed.startingBalanceSol === 'number'
        ? parsed.startingBalanceSol
        : parsed.balanceSol,
    positions: Array.isArray(parsed.positions) ? parsed.positions : [],
    closedPositions: Array.isArray(parsed.closedPositions)
      ? parsed.closedPositions
      : [],
    lifetimeClosed:
      typeof parsed.lifetimeClosed === 'number' ? parsed.lifetimeClosed : undefined,
    lifetimeWins:
      typeof parsed.lifetimeWins === 'number' ? parsed.lifetimeWins : undefined,
    lifetimeLosses:
      typeof parsed.lifetimeLosses === 'number' ? parsed.lifetimeLosses : undefined,
  };
}

export function savePaperBalance(state: {
  balanceSol: number;
  startingBalanceSol: number;
  positions: Position[];
  closedPositions: Position[];
  lifetimeClosed?: number;
  lifetimeWins?: number;
  lifetimeLosses?: number;
}): void {
  try {
    ensureDataDir();
    const payload: PersistedPaperState = {
      version: 1,
      updatedAt: Date.now(),
      balanceSol: state.balanceSol,
      startingBalanceSol: state.startingBalanceSol,
      positions: state.positions,
      // Cap closed history on disk
      closedPositions: state.closedPositions.slice(-200),
      lifetimeClosed: state.lifetimeClosed ?? 0,
      lifetimeWins: state.lifetimeWins ?? 0,
      lifetimeLosses: state.lifetimeLosses ?? 0,
    };
    atomicWriteJson(PAPER_FILE, payload);
  } catch (err) {
    console.error(
      '[paper] Failed to save paperBalance.json:',
      err instanceof Error ? err.message : err
    );
  }
}
