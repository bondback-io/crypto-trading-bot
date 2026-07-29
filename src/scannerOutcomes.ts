/**
 * Scanner outcome feedback — light ring buffer persisted to data/scanner-outcomes.json.
 * Soft-weights playbooks with weak win rates (no ML).
 */

import fs from 'fs';
import { dataFile, ensureDataDir } from './dataDir';
import { logger, errorToMeta } from './logger';

export type ScannerPlaybookId =
  | 'dip_reclaim'
  | 'bull_flag_break'
  | 'curve_migration_sniper'
  | 'momentum_continuation'
  | 'failed_breakdown_reclaim';

export interface ScannerOutcomeRecord {
  playbook: ScannerPlaybookId;
  pnlPct: number;
  win: boolean;
  holdSec: number;
  at: number;
}

interface PlaybookStat {
  n: number;
  wins: number;
  sumPnl: number;
}

interface OutcomesFile {
  version: 1;
  ring: ScannerOutcomeRecord[];
  updatedAt: number;
}

const MAX_RING = 200;
const OUTCOMES_FILE = () => dataFile('scanner-outcomes.json');

let ring: ScannerOutcomeRecord[] = [];
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
    logger.warn('ScannerOutcomes', 'load failed', errorToMeta(err));
  }
}

export function invalidateScannerOutcomesCache(): void {
  loaded = false;
  ring = [];
}

function persist(): void {
  try {
    ensureDataDir();
    const payload: OutcomesFile = {
      version: 1,
      ring: ring.slice(-MAX_RING),
      updatedAt: Date.now(),
    };
    fs.writeFileSync(OUTCOMES_FILE(), JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    logger.warn('ScannerOutcomes', 'persist failed', errorToMeta(err));
  }
}

const ALL_PLAYBOOKS: ScannerPlaybookId[] = [
  'dip_reclaim',
  'bull_flag_break',
  'curve_migration_sniper',
  'momentum_continuation',
  'failed_breakdown_reclaim',
];

function isPlaybook(v: string): v is ScannerPlaybookId {
  return (ALL_PLAYBOOKS as string[]).includes(v);
}

export function recordScannerOutcome(input: {
  playbook: string;
  pnlPct: number;
  win: boolean;
  holdSec: number;
}): void {
  load();
  if (!isPlaybook(input.playbook)) return;
  ring.push({
    playbook: input.playbook,
    pnlPct: Number(input.pnlPct) || 0,
    win: Boolean(input.win),
    holdSec: Math.max(0, Math.round(Number(input.holdSec) || 0)),
    at: Date.now(),
  });
  if (ring.length > MAX_RING) ring = ring.slice(-MAX_RING);
  persist();
}

function statsByPlaybook(): Record<ScannerPlaybookId, PlaybookStat> {
  load();
  const out = {} as Record<ScannerPlaybookId, PlaybookStat>;
  for (const id of ALL_PLAYBOOKS) {
    out[id] = { n: 0, wins: 0, sumPnl: 0 };
  }
  for (const r of ring) {
    const s = out[r.playbook];
    if (!s) continue;
    s.n += 1;
    if (r.win) s.wins += 1;
    s.sumPnl += r.pnlPct;
  }
  return out;
}

/**
 * Soft weights for ranking. Default 1; down-weight WR < 40% after ≥5 samples.
 */
export function getPlaybookWeights(): Record<ScannerPlaybookId, number> {
  const stats = statsByPlaybook();
  const weights = {} as Record<ScannerPlaybookId, number>;
  for (const id of ALL_PLAYBOOKS) {
    const s = stats[id];
    if (s.n < 5) {
      weights[id] = 1;
      continue;
    }
    const wr = s.wins / s.n;
    if (wr < 0.3) weights[id] = 0.6;
    else if (wr < 0.4) weights[id] = 0.75;
    else if (wr >= 0.55) weights[id] = 1.1;
    else weights[id] = 1;
  }
  return weights;
}

export function getScannerOutcomeSummary(): {
  total: number;
  byPlaybook: Record<
    string,
    { n: number; winRatePct: number; avgPnlPct: number; weight: number }
  >;
} {
  const stats = statsByPlaybook();
  const weights = getPlaybookWeights();
  const byPlaybook: Record<
    string,
    { n: number; winRatePct: number; avgPnlPct: number; weight: number }
  > = {};
  let total = 0;
  for (const id of ALL_PLAYBOOKS) {
    const s = stats[id];
    total += s.n;
    byPlaybook[id] = {
      n: s.n,
      winRatePct: s.n > 0 ? Math.round((s.wins / s.n) * 1000) / 10 : 0,
      avgPnlPct: s.n > 0 ? Math.round((s.sumPnl / s.n) * 10) / 10 : 0,
      weight: weights[id],
    };
  }
  return { total, byPlaybook };
}
