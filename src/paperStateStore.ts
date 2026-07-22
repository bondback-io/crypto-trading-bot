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
  };
}

export function savePaperBalance(state: {
  balanceSol: number;
  startingBalanceSol: number;
  positions: Position[];
  closedPositions: Position[];
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
    };
    atomicWriteJson(PAPER_FILE, payload);
  } catch (err) {
    console.error(
      '[paper] Failed to save paperBalance.json:',
      err instanceof Error ? err.message : err
    );
  }
}
