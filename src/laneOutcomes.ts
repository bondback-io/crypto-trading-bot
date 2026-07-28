/**
 * Lane fight outcomes — ring buffer persisted to data/lane-outcomes.json.
 * Joins Smart Bot lane decisions to closed PnL for floor learning suggestions.
 */

import fs from 'fs';
import { dataFile, ensureDataDir, atomicWriteJson } from './dataDir';
import { logger, errorToMeta } from './logger';

export interface LaneOutcomeLaneSnap {
  id: string;
  name: string;
  passed: boolean;
  score: number;
  reason: string;
}

export interface LaneOutcomeRecord {
  id: string;
  at: number;
  mint: string;
  symbol: string;
  winnerId: string | null;
  lanes: LaneOutcomeLaneSnap[];
  /** true when cascade stamped a buy; false when cascade skipped */
  opened?: boolean;
  /** Why cascade rejected after a lane win (compact) */
  cascadeSkipReason?: string;
  /** Filled when the stamped position closes */
  closedAt?: number;
  pnlSol?: number;
  win?: boolean;
}

interface OutcomesFile {
  version: 1;
  ring: LaneOutcomeRecord[];
  updatedAt: number;
}

const MAX_RING = 200;
const OUTCOMES_FILE = () => dataFile('lane-outcomes.json');

let ring: LaneOutcomeRecord[] = [];
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    ensureDataDir();
    const p = OUTCOMES_FILE();
    if (!fs.existsSync(p)) return;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as OutcomesFile;
    if (Array.isArray(raw.ring)) {
      ring = raw.ring.slice(-MAX_RING);
    }
  } catch (err) {
    logger.warn('LaneOutcomes', 'load failed', errorToMeta(err));
  }
}

function persist(): void {
  try {
    ensureDataDir();
    const payload: OutcomesFile = {
      version: 1,
      ring: ring.slice(-MAX_RING),
      updatedAt: Date.now(),
    };
    atomicWriteJson(OUTCOMES_FILE(), payload);
  } catch (err) {
    logger.warn('LaneOutcomes', 'persist failed', errorToMeta(err));
  }
}

function nextId(): string {
  return `lane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Record a Smart Bot lane fight (open / skip — winner may later get PnL). */
export function recordLaneFightOpen(input: {
  mint: string;
  symbol: string;
  winnerId: string | null;
  lanes: LaneOutcomeLaneSnap[];
}): void {
  load();
  ring.push({
    id: nextId(),
    at: Date.now(),
    mint: input.mint,
    symbol: input.symbol,
    winnerId: input.winnerId,
    lanes: input.lanes,
  });
  if (ring.length > MAX_RING) ring = ring.slice(-MAX_RING);
  persist();
}

/**
 * Attach cascade outcome to the newest open lane record for this mint.
 */
export function recordLaneFightCascadeResult(input: {
  mint: string;
  opened: boolean;
  cascadeSkipReason?: string;
}): void {
  load();
  const mint = String(input.mint || '').trim();
  if (!mint) return;
  for (let i = ring.length - 1; i >= 0; i--) {
    const row = ring[i];
    if (row.mint !== mint) continue;
    if (row.opened != null || row.cascadeSkipReason != null) continue;
    if (row.closedAt != null) continue;
    row.opened = input.opened === true;
    if (!row.opened && input.cascadeSkipReason) {
      row.cascadeSkipReason = String(input.cascadeSkipReason).slice(0, 280);
    }
    persist();
    return;
  }
}

/**
 * Attach closed PnL to the newest open lane record for this mint + winner profile.
 */
export function recordLaneFightClose(input: {
  mint: string;
  profileId?: string | null;
  pnlSol: number;
}): void {
  load();
  const mint = String(input.mint || '').trim();
  if (!mint) return;
  const profileId = input.profileId ? String(input.profileId) : null;
  for (let i = ring.length - 1; i >= 0; i--) {
    const row = ring[i];
    if (row.mint !== mint) continue;
    if (row.closedAt != null) continue;
    if (profileId && row.winnerId && row.winnerId !== profileId) continue;
    row.closedAt = Date.now();
    row.pnlSol = Number(input.pnlSol) || 0;
    row.win = row.pnlSol > 0;
    persist();
    return;
  }
}

export function getLaneOutcomeRing(limit = 80): LaneOutcomeRecord[] {
  load();
  const n = Math.max(1, Math.min(MAX_RING, limit));
  return ring.slice(-n).reverse();
}

/** Closed lane-won samples grouped by winner profileId. */
export function getLaneOutcomeStatsByProfile(): Record<
  string,
  { n: number; wins: number; sumPnl: number }
> {
  load();
  const out: Record<string, { n: number; wins: number; sumPnl: number }> = {};
  for (const row of ring) {
    if (row.closedAt == null || !row.winnerId) continue;
    const id = row.winnerId;
    if (!out[id]) out[id] = { n: 0, wins: 0, sumPnl: 0 };
    out[id].n += 1;
    if (row.win) out[id].wins += 1;
    out[id].sumPnl += Number(row.pnlSol) || 0;
  }
  return out;
}
