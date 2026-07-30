/**
 * Per-profile trade episode memory for micro-bot self-learning.
 * Dual-writes beyond the global closed-positions cap.
 */

import fs from 'fs';
import path from 'path';
import { dataFile, ensureDataDir, atomicWriteJson } from './dataDir';
import { logger, errorToMeta } from './logger';
import { classifyExitKey, type ExitMixKey } from './soakMetrics';

export interface ProfileLearningEpisode {
  id: string;
  at: number;
  profileId: string;
  mint: string;
  symbol: string;
  openedAt: number;
  closedAt: number;
  holdSec: number;
  pnlPct: number;
  pnlSol: number;
  exitKey: ExitMixKey;
  exitReason: string;
  /** MFE — max unrealized % from entry → HWM */
  maxRunupPct: number;
  /** MAE — worst unrealized % from entry (0 if never tracked) */
  maxDrawdownPct: number;
  /** Price drop from HWM at exit: (HWM − exit) / HWM × 100 */
  givebackFromPeakPct: number;
  peakUnrealizedPct: number;
  exitUnrealizedPct: number;
  convictionScore?: number;
  walletCount?: number;
  entryMarketCapUsd?: number;
  tradeProfileScore?: number;
  tradeProfileReason?: string;
  /** Self-learn version active when the trade opened */
  paramVersion: number;
  entrySource?: string;
  scannerPlaybook?: string;
  qualityTier?: 'low' | 'medium' | 'high';
  failureCategory?: string;
  /** Tabular ML features (optional — denser than path replay) */
  entryLiquidityUsd?: number;
  holdMinAtEntry?: number;
  trailStopPctAtOpen?: number;
  trailingActivationProfitAtOpen?: number;
  profitLockArmAtOpen?: number;
  givebackPtsAtOpen?: number;
  /** UTC hour 0–23 at open */
  hourUtc?: number;
  microVersion?: number;
  /** Lane fight / auto-score at stamp */
  laneScore?: number;
  top10HoldPct?: number | null;
  /** Hours since grad/pair at entry (for raise-only min token age learning) */
  tokenAgeHoursAtEntry?: number;
}

interface EpisodesFile {
  version: 1;
  profileId: string;
  ring: ProfileLearningEpisode[];
  updatedAt: number;
}

const MAX_PER_PROFILE = 400;
const DIR = () => dataFile('profile-learning');

const cache = new Map<string, ProfileLearningEpisode[]>();
const loaded = new Set<string>();

/** Drop episode caches so next read reloads from disk (e.g. after site restore). */
export function invalidateProfileLearningEpisodeCache(): void {
  cache.clear();
  loaded.clear();
}

function fileFor(profileId: string): string {
  const safe = String(profileId || 'unknown').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(DIR(), `${safe}.json`);
}

function loadProfile(profileId: string): ProfileLearningEpisode[] {
  if (loaded.has(profileId)) return cache.get(profileId) || [];
  loaded.add(profileId);
  try {
    ensureDataDir();
    const dir = DIR();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const p = fileFor(profileId);
    if (!fs.existsSync(p)) {
      cache.set(profileId, []);
      return [];
    }
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as EpisodesFile;
    const ring = Array.isArray(raw.ring) ? raw.ring.slice(-MAX_PER_PROFILE) : [];
    cache.set(profileId, ring);
    return ring;
  } catch (err) {
    logger.warn('ProfileLearning', 'load failed', {
      profileId,
      ...errorToMeta(err),
    });
    cache.set(profileId, []);
    return [];
  }
}

function persistProfile(profileId: string): void {
  try {
    ensureDataDir();
    const dir = DIR();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ring = (cache.get(profileId) || []).slice(-MAX_PER_PROFILE);
    const payload: EpisodesFile = {
      version: 1,
      profileId,
      ring,
      updatedAt: Date.now(),
    };
    atomicWriteJson(fileFor(profileId), payload);
  } catch (err) {
    logger.warn('ProfileLearning', 'persist failed', {
      profileId,
      ...errorToMeta(err),
    });
  }
}

export function deriveEpisodeMetrics(input: {
  entryPriceSol: number;
  exitPriceSol: number;
  highWaterMarkSol: number;
  lowWaterMarkSol?: number;
  pnlPct: number;
}): {
  maxRunupPct: number;
  maxDrawdownPct: number;
  givebackFromPeakPct: number;
  peakUnrealizedPct: number;
  exitUnrealizedPct: number;
} {
  const entry = Number(input.entryPriceSol) || 0;
  const exit = Number(input.exitPriceSol) || 0;
  const hwm = Number(input.highWaterMarkSol) || entry;
  const lwm =
    input.lowWaterMarkSol != null && Number.isFinite(input.lowWaterMarkSol)
      ? Number(input.lowWaterMarkSol)
      : entry;
  const peakUnrealizedPct =
    entry > 0 && hwm > 0 ? ((hwm - entry) / entry) * 100 : 0;
  const maxDrawdownPct =
    entry > 0 && lwm > 0 && lwm < entry
      ? ((lwm - entry) / entry) * 100
      : 0;
  const givebackFromPeakPct =
    hwm > 0 && exit > 0 ? ((hwm - exit) / hwm) * 100 : 0;
  const exitUnrealizedPct = Number.isFinite(input.pnlPct)
    ? Number(input.pnlPct)
    : entry > 0 && exit > 0
      ? ((exit - entry) / entry) * 100
      : 0;
  return {
    maxRunupPct: Math.max(0, peakUnrealizedPct),
    maxDrawdownPct: Math.min(0, maxDrawdownPct),
    givebackFromPeakPct: Math.max(0, givebackFromPeakPct),
    peakUnrealizedPct: Math.max(0, peakUnrealizedPct),
    exitUnrealizedPct,
  };
}

export function appendProfileLearningEpisode(
  episode: Omit<ProfileLearningEpisode, 'id' | 'at' | 'exitKey'> & {
    exitReason: string;
  }
): ProfileLearningEpisode | null {
  const profileId = String(episode.profileId || '').trim();
  if (!profileId || profileId === 'default') return null;
  // Skip partial slices
  if (/^partial:/i.test(String(episode.exitReason || ''))) return null;

  const ring = loadProfile(profileId);
  const row: ProfileLearningEpisode = {
    ...episode,
    id: `ep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    exitKey: classifyExitKey(episode.exitReason).key,
    profileId,
  };
  ring.push(row);
  if (ring.length > MAX_PER_PROFILE) {
    cache.set(profileId, ring.slice(-MAX_PER_PROFILE));
  } else {
    cache.set(profileId, ring);
  }
  persistProfile(profileId);
  try {
    const { appendLearningSave } =
      require('./profileLearningSaveLog') as typeof import('./profileLearningSaveLog');
    const ring = cache.get(profileId) || [];
    appendLearningSave({
      profileId,
      kind: 'episode',
      summary: `Closed trade episode · ${row.symbol || row.mint.slice(0, 8)} · ${
        Number.isFinite(row.pnlPct) ? `${row.pnlPct.toFixed(1)}%` : 'n/a'
      } · ${row.exitKey}`,
      episodeCount: ring.length,
      version: row.paramVersion,
    });
  } catch {
    /* optional journal */
  }
  return row;
}

export function getProfileLearningEpisodes(
  profileId: string,
  limit = 200
): ProfileLearningEpisode[] {
  const ring = loadProfile(profileId);
  const n = Math.max(1, Math.min(MAX_PER_PROFILE, limit));
  return ring.slice(-n);
}

export function getProfileEpisodeExpectancy(
  profileId: string,
  opts?: { lastN?: number; version?: number | null }
): {
  n: number;
  expectancyPct: number;
  winRatePct: number;
  avgHoldSec: number;
  riskAdjustedExpectancyPct: number;
} {
  let eps = getProfileLearningEpisodes(profileId, 500);
  if (opts?.version != null) {
    eps = eps.filter((e) => e.paramVersion === opts.version);
  }
  if (opts?.lastN != null && opts.lastN > 0) {
    eps = eps.slice(-opts.lastN);
  }
  if (eps.length === 0) {
    return {
      n: 0,
      expectancyPct: 0,
      winRatePct: 0,
      avgHoldSec: 0,
      riskAdjustedExpectancyPct: 0,
    };
  }
  const sumPct = eps.reduce((s, e) => s + (e.pnlPct || 0), 0);
  const wins = eps.filter((e) => (e.pnlPct || 0) > 0).length;
  const avgHold =
    eps.reduce((s, e) => s + (e.holdSec || 0), 0) / Math.max(1, eps.length);
  const expectancyPct = sumPct / eps.length;
  // Penalize large losers and very long dead holds
  let penalty = 0;
  for (const e of eps) {
    if ((e.pnlPct || 0) < -15) penalty += Math.abs(e.pnlPct) * 0.15;
    if ((e.holdSec || 0) > 900 && (e.pnlPct || 0) < 2) penalty += 1.5;
  }
  const riskAdjustedExpectancyPct =
    expectancyPct - penalty / Math.max(1, eps.length);
  return {
    n: eps.length,
    expectancyPct,
    winRatePct: (wins / eps.length) * 100,
    avgHoldSec: avgHold,
    riskAdjustedExpectancyPct,
  };
}

export function clearProfileLearningEpisodes(profileId: string): void {
  cache.set(profileId, []);
  loaded.add(profileId);
  persistProfile(profileId);
}
