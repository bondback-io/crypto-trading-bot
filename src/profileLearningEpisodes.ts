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
  /** Whether Heikin-Ashi exit was enabled on frozen policy at open */
  haExitEnabledAtOpen?: boolean;
  /** Profile TA playbook snapshot at entry */
  taModeAtOpen?: 'off' | 'soft' | 'hard';
  taToolsAtOpen?: string[];
  taToolsPassedAtEntry?: string[];
  taToolScoresAtEntry?: Record<string, number>;
  taConfluenceAtEntry?: number;
  haBiasAtEntry?: string | null;
  haConsecutiveAtEntry?: number;
  nearSupportAtEntry?: boolean;
  nearResistanceAtEntry?: boolean;
  whaleStateAtEntry?: string;
  profileTaPlainLanguage?: string;
  zigzagStructureAtEntry?: string;
  macdCrossAtEntry?: string;
  macdHistSlopeAtEntry?: string;
      rsiDivergenceAtEntry?: string;
  volumeDivergenceAtEntry?: string;
  /** Volume Intelligence at entry / exit */
  volumeStateAtEntry?: string;
  volumeStateAtExit?: string;
  volumeDecayedAfterEntry?: boolean;
  volumeM5UsdAtEntry?: number | null;
  volumeH1UsdAtEntry?: number | null;
  volumeScoreAtEntry?: number;
  volumeDivergenceStateAtEntry?: string;
  volumeDivergenceStateAtExit?: string;
  /** Whether TA/whale conditions still looked favorable while trade was green */
  taConditionsHeldIntoProfit?: boolean;
  /** Soft heuristic: TA exit banked vs holding longer */
  taExitBeatHold?: boolean;
  /** Learning Mode attribution at open */
  learningMode?: boolean;
  learningStrictness?: 'stricter' | 'middle' | 'looser';
  learningFairnessApplied?: boolean;
  /**
   * Trade mode when the episode was recorded.
   * Live Mode episodes are filtered out of RL/playbook unless
   * config.learning.includeLiveModeEpisodes is ON.
   */
  tradeMode?: 'paper' | 'live';
  /**
   * Entry timing quality 0–100 (cheap proxy from MAE depth vs hold / MFE path).
   * Optional — older episode rings omit this.
   */
  entryQualityScore?: number;
  /**
   * Exit timing quality 0–100 (MFE capture ratio minus giveback penalty).
   * Optional — older episode rings omit this.
   */
  exitQualityScore?: number;
  /**
   * Risk-adjusted timing reward: pnl + MFE-capture − MAE − giveback penalties.
   * Optional — older episode rings omit this; scorers fall back to pnl/MFE.
   */
  timingReward?: number;
  /** Peak Profit Protection — arm threshold (% unrealized) at open / resolved */
  peakProtectArmAtPct?: number;
  /** Peak Profit Protection — giveback % of peak configured at open */
  peakProtectGivebackOfPeakPct?: number;
  /** Whether protection was armed during the trade */
  peakProtectArmed?: boolean;
  /**
   * Soft heuristic: protection exit banked vs never-hit-TP (true),
   * or left TP on table after peaking at/above TP (false).
   */
  peakProtectBeatFullTp?: boolean;
  /** Profit Capture Layer — first partial banked */
  pclPartialTaken?: boolean;
  pclRunnerFraction?: number;
  /** Explicit exit/MFE capture ratio (0–1.2+), stamped at close */
  mfeCaptureRatio?: number;
  /** Permission window end (ms) at open */
  profitPermissionUntilMs?: number;
  /** Permission window length (sec) */
  profitPermissionSec?: number;
  /** Closed while permission window still active */
  exitedDuringPermission?: boolean;
  /** Times PCL blocked a tiny-green soft scratch */
  pclScratchBlockedCount?: number;
  /** PPP arm was deferred at least once due to permission */
  pclPppArmDeferred?: boolean;
  /** PCL family at open */
  pclFamily?: 'fast' | 'dip_trend' | 'quality' | 'default';
  /** Timing-reward delta from computePclLearningRewardDelta */
  pclLearningDelta?: number;
  hmcSetup?: string;
  hmcConfidence?: number;
  gateDecision?: string;
  /** Fast Profiles Recovery stage active when the trade closed (0–4). */
  recoveryStageAtClose?: number;
  /** Counterfactual exit evaluation (additive — learning accelerators) */
  cfPeakExitPnlPct?: number;
  cfActualVsPeakGapPct?: number;
  cfTighterPppBetter?: boolean;
  cfEarlierTpBetter?: boolean;
  cfSlWiderWouldSurvive?: boolean;
  cfSummary?: string;
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

/**
 * Cheap entry/exit quality + risk-adjusted timing reward from MFE/MAE/giveback.
 * No candle replay — safe for Paper / Live Sim / Live close path.
 */
export function computeEpisodeTimingQuality(input: {
  pnlPct: number;
  maxRunupPct: number;
  maxDrawdownPct: number;
  givebackFromPeakPct: number;
  exitUnrealizedPct: number;
  holdSec?: number;
  convictionScore?: number | null;
  /** Stamped PCL entry quality (preferred over derived). */
  entryQualityScoreAtOpen?: number | null;
  pclPartialTaken?: boolean;
  exitReason?: string;
  exitKey?: string;
}): {
  entryQualityScore: number;
  exitQualityScore: number;
  timingReward: number;
} {
  const pnl = Number(input.pnlPct) || 0;
  const mfe = Math.max(0, Number(input.maxRunupPct) || 0);
  const mae = Math.min(0, Number(input.maxDrawdownPct) || 0); // ≤0
  const giveback = Math.max(0, Number(input.givebackFromPeakPct) || 0);
  const exitU = Number.isFinite(input.exitUnrealizedPct)
    ? Number(input.exitUnrealizedPct)
    : pnl;
  const holdSec = Math.max(0, Number(input.holdSec) || 0);
  const conv =
    input.convictionScore != null && Number.isFinite(input.convictionScore)
      ? Number(input.convictionScore)
      : null;

  // Entry quality: shallow MAE + decent conviction → higher. Deep MAE early → lower.
  let entryQ = 72;
  if (
    input.entryQualityScoreAtOpen != null &&
    Number.isFinite(Number(input.entryQualityScoreAtOpen))
  ) {
    entryQ = Math.max(
      0,
      Math.min(100, Math.round(Number(input.entryQualityScoreAtOpen)))
    );
  } else {
    const maeAbs = Math.abs(mae);
    entryQ -= Math.min(40, maeAbs * 1.15);
    if (holdSec > 0 && holdSec < 45 && maeAbs >= 8) entryQ -= 12;
    if (mfe >= 15 && maeAbs <= 4) entryQ += 8;
    if (conv != null) {
      if (conv >= 55) entryQ += 6;
      else if (conv < 30) entryQ -= 10;
    }
    entryQ = Math.max(0, Math.min(100, Math.round(entryQ)));
  }

  // Exit quality: capture of MFE; punish giveback after peak
  const capture =
    mfe > 0.5 ? Math.max(0, Math.min(1.2, exitU / mfe)) : exitU > 0 ? 1 : 0.4;
  let exitQ = capture * 85;
  exitQ -= Math.min(35, giveback * 0.85);
  if (mfe >= 25 && exitU < mfe * 0.35) exitQ -= 15;
  if (pnl > 0 && giveback < 5) exitQ += 5;
  if (input.pclPartialTaken && pnl > 0) exitQ += 4;
  exitQ = Math.max(0, Math.min(100, Math.round(exitQ)));

  // Risk-adjusted timing reward (same units-ish as pnl %)
  const mfeCapturePts = mfe > 0 ? Math.min(mfe, Math.max(0, exitU)) * 0.35 : 0;
  const maePenalty = Math.abs(mae) * 0.25;
  const givebackPenalty = Math.min(20, giveback * 0.2);
  let timingReward =
    pnl + mfeCapturePts - maePenalty - givebackPenalty + (exitQ - 50) * 0.04;

  try {
    const { computePclLearningRewardDelta } =
      require('./profitCaptureLayer') as typeof import('./profitCaptureLayer');
    timingReward += computePclLearningRewardDelta({
      pnlPct: pnl,
      maxRunupPct: mfe,
      exitUnrealizedPct: exitU,
      holdSec,
      entryQualityScore: entryQ,
      pclPartialTaken: input.pclPartialTaken === true,
      exitReason: input.exitReason,
      exitKey: input.exitKey,
    });
  } catch {
    /* fail soft */
  }

  return {
    entryQualityScore: entryQ,
    exitQualityScore: exitQ,
    timingReward: Number(timingReward.toFixed(3)),
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
      } · ${row.exitKey} · ${
        row.learningMode === true
          ? `LM ${
              row.learningStrictness
                ? row.learningStrictness.charAt(0).toUpperCase() +
                  row.learningStrictness.slice(1)
                : 'Middle'
            }`
          : 'non-LM'
      }`,
      episodeCount: ring.length,
      version: row.paramVersion,
      learningMode: row.learningMode === true ? true : undefined,
      learningStrictness: row.learningStrictness,
    });
  } catch {
    /* optional journal */
  }
  return row;
}

/** Patch fields on an existing episode (e.g. counterfactual stamps). */
export function patchProfileLearningEpisode(
  profileId: string,
  episodeId: string,
  patch: Partial<ProfileLearningEpisode>
): boolean {
  const ring = loadProfile(profileId);
  const idx = ring.findIndex((e) => e.id === episodeId);
  if (idx < 0) return false;
  ring[idx] = { ...ring[idx]!, ...patch, id: episodeId, profileId };
  cache.set(profileId, ring);
  persistProfile(profileId);
  return true;
}

export function getProfileLearningEpisodes(
  profileId: string,
  limit = 200,
  opts?: { includeLiveMode?: boolean }
): ProfileLearningEpisode[] {
  const ring = loadProfile(profileId);
  const n = Math.max(1, Math.min(MAX_PER_PROFILE, limit));
  let out = ring.slice(-n);
  // Default: exclude Live Mode episodes from learning consumers unless toggled on
  let includeLive = opts?.includeLiveMode;
  if (includeLive == null) {
    try {
      const { config } = require('./config') as typeof import('./config');
      includeLive = config.learning?.includeLiveModeEpisodes === true;
    } catch {
      includeLive = false;
    }
  }
  if (!includeLive) {
    out = out.filter((e) => e.tradeMode !== 'live');
  }
  return out;
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
  // Winsorize one extreme win + one extreme loss so a LOOP-style outlier
  // cannot dominate self-learn upgrades (keep raw n / winRate on full sample).
  let scored = eps;
  if (eps.length >= 12) {
    const byPnl = [...eps].sort(
      (a, b) => (a.pnlPct || 0) - (b.pnlPct || 0)
    );
    const drop = new Set([byPnl[0]!.id, byPnl[byPnl.length - 1]!.id]);
    const trimmed = eps.filter((e) => !drop.has(e.id));
    if (trimmed.length >= 8) scored = trimmed;
  }
  const sumPct = scored.reduce((s, e) => s + (e.pnlPct || 0), 0);
  const wins = eps.filter((e) => (e.pnlPct || 0) > 0).length;
  const avgHold =
    eps.reduce((s, e) => s + (e.holdSec || 0), 0) / Math.max(1, eps.length);
  const expectancyPct = sumPct / scored.length;
  // Penalize large losers and very long dead holds
  let penalty = 0;
  for (const e of scored) {
    if ((e.pnlPct || 0) < -15) penalty += Math.abs(e.pnlPct) * 0.15;
    if ((e.holdSec || 0) > 900 && (e.pnlPct || 0) < 2) penalty += 1.5;
  }
  const riskAdjustedExpectancyPct =
    expectancyPct - penalty / Math.max(1, scored.length);
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
