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
  /** Soft MARL team-manager thoughts for this fight (optional). */
  marl?: {
    enabled: boolean;
    strength?: string;
    thoughts: string[];
  };
  /** HMC Gatekeeper snapshot (Phase 1, optional). */
  hmcGate?: {
    decision: 'allow' | 'block';
    severity: 'soft' | 'hard';
    reasonCodes: string[];
    plainLanguage: string;
    advisory?: boolean;
  };
  /** HMC Setup Classifier snapshot (Phase 2, optional). */
  hmcClassifier?: {
    setup: string;
    confidence: number;
    reasonCodes: string[];
    plainLanguage: string;
    eligibleProfileIds: string[];
    blocked?: boolean;
  };
  /** true when cascade stamped a buy; false when cascade skipped */
  opened?: boolean;
  /** Why cascade rejected after a lane win (compact) */
  cascadeSkipReason?: string;
  /** Filled when the stamped position closes */
  closedAt?: number;
  pnlSol?: number;
  pnlPct?: number;
  holdSec?: number;
  exitKey?: string;
  maxRunupPct?: number;
  win?: boolean;
}

interface OutcomesFile {
  version: 1;
  ring: LaneOutcomeRecord[];
  updatedAt: number;
}

/** Larger ring so multi-hour holds (dip/swing) still find their fight. */
const MAX_RING = 800;
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

export function invalidateLaneOutcomesCache(): void {
  loaded = false;
  ring = [];
}

function isPendingOpen(row: LaneOutcomeRecord): boolean {
  return row.opened === true && row.closedAt == null;
}

/** Trim oldest disposable rows; never drop opened-but-not-yet-closed fights. */
function trimRing(): void {
  while (ring.length > MAX_RING) {
    const dropIdx = ring.findIndex((r) => !isPendingOpen(r));
    if (dropIdx < 0) break;
    ring.splice(dropIdx, 1);
  }
}

function persist(): void {
  try {
    ensureDataDir();
    const payload: OutcomesFile = {
      version: 1,
      ring: ring.slice(-Math.max(MAX_RING, ring.length)),
      updatedAt: Date.now(),
    };
    // Cap only disposable rows if somehow overfilled with pending opens
    if (payload.ring.length > MAX_RING * 2) {
      const pending = payload.ring.filter(isPendingOpen);
      const rest = payload.ring.filter((r) => !isPendingOpen(r));
      payload.ring = [...rest.slice(-(MAX_RING - pending.length)), ...pending];
    }
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
  marl?: {
    enabled: boolean;
    strength?: string;
    thoughts: string[];
  };
  hmcGate?: LaneOutcomeRecord['hmcGate'];
  hmcClassifier?: LaneOutcomeRecord['hmcClassifier'];
}): void {
  load();
  ring.push({
    id: nextId(),
    at: Date.now(),
    mint: input.mint,
    symbol: input.symbol,
    winnerId: input.winnerId,
    lanes: input.lanes,
    marl: input.marl,
    hmcGate: input.hmcGate,
    hmcClassifier: input.hmcClassifier,
  });
  trimRing();
  persist();
}

/** Append a MARL thought to the newest open fight for this mint. */
export function appendLaneFightMarlThought(input: {
  mint: string;
  thought: string;
}): void {
  load();
  const mint = String(input.mint || '').trim();
  const thought = String(input.thought || '').trim().slice(0, 200);
  if (!mint || !thought) return;
  for (let i = ring.length - 1; i >= 0; i--) {
    const row = ring[i];
    if (row.mint !== mint) continue;
    if (row.closedAt != null) continue;
    if (!row.marl) row.marl = { enabled: true, thoughts: [] };
    row.marl.enabled = true;
    if (!row.marl.thoughts.includes(thought)) {
      row.marl.thoughts.push(thought);
      if (row.marl.thoughts.length > 10) {
        row.marl.thoughts = row.marl.thoughts.slice(-10);
      }
    }
    persist();
    return;
  }
}

/** Append a Zion personality comment (prefixed) to the newest open fight for this mint. */
export function appendLaneFightZionThought(input: {
  mint: string;
  thought: string;
}): void {
  load();
  const mint = String(input.mint || '').trim();
  let thought = String(input.thought || '').trim().slice(0, 200);
  if (!mint || !thought) return;
  if (!/^Zion:\s/i.test(thought)) thought = `Zion: ${thought}`;
  for (let i = ring.length - 1; i >= 0; i--) {
    const row = ring[i];
    if (row.mint !== mint) continue;
    if (row.closedAt != null) continue;
    if (!row.marl) row.marl = { enabled: true, thoughts: [] };
    row.marl.enabled = true;
    if (!row.marl.thoughts.includes(thought)) {
      row.marl.thoughts.push(thought);
      if (row.marl.thoughts.length > 12) {
        row.marl.thoughts = row.marl.thoughts.slice(-12);
      }
    }
    persist();
    return;
  }
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
 * Attach closed PnL to the matching lane record for this mint + winner profile.
 * Prefers opened-unclosed rows; requires winnerId === profileId when profile known.
 */
export function recordLaneFightClose(input: {
  mint: string;
  profileId?: string | null;
  pnlSol: number;
  pnlPct?: number;
  holdSec?: number;
  exitKey?: string;
  maxRunupPct?: number;
}): void {
  load();
  const mint = String(input.mint || '').trim();
  if (!mint) return;
  const profileId = input.profileId ? String(input.profileId) : null;

  const apply = (row: LaneOutcomeRecord): void => {
    row.closedAt = Date.now();
    row.pnlSol = Number(input.pnlSol) || 0;
    if (input.pnlPct != null && Number.isFinite(input.pnlPct)) {
      row.pnlPct = Number(input.pnlPct);
    }
    if (input.holdSec != null && Number.isFinite(input.holdSec)) {
      row.holdSec = Number(input.holdSec);
    }
    if (input.exitKey) row.exitKey = String(input.exitKey).slice(0, 40);
    if (input.maxRunupPct != null && Number.isFinite(input.maxRunupPct)) {
      row.maxRunupPct = Number(input.maxRunupPct);
    }
    row.win = row.pnlSol > 0;
    if (row.opened == null) row.opened = true;
    persist();
  };

  const matchesProfile = (row: LaneOutcomeRecord): boolean => {
    if (!profileId) return true;
    return row.winnerId === profileId;
  };

  // 1) Newest opened + unclosed + matching winner
  for (let i = ring.length - 1; i >= 0; i--) {
    const row = ring[i];
    if (row.mint !== mint || row.closedAt != null) continue;
    if (!matchesProfile(row)) continue;
    if (row.opened === true) {
      apply(row);
      return;
    }
  }

  // 2) Newest unclosed + matching winner (opened flag may still be unset)
  for (let i = ring.length - 1; i >= 0; i--) {
    const row = ring[i];
    if (row.mint !== mint || row.closedAt != null) continue;
    if (!matchesProfile(row)) continue;
    apply(row);
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
    if (row.pnlSol == null || !Number.isFinite(row.pnlSol)) continue;
    const id = row.winnerId;
    if (!out[id]) out[id] = { n: 0, wins: 0, sumPnl: 0 };
    out[id].n += 1;
    if (row.win) out[id].wins += 1;
    out[id].sumPnl += Number(row.pnlSol) || 0;
  }
  return out;
}
