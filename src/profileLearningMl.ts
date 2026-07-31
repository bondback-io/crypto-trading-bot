/**
 * Pure-TypeScript tabular ML advisor for micro-bot self-learning.
 * Heuristics still propose patches; this module ranks / advises and can
 * propose tiny continuous deltas when mlMode === 'lead'.
 */

import fs from 'fs';
import path from 'path';
import { atomicWriteJson, dataFile, ensureDataDir } from './dataDir';
import {
  getProfileLearningEpisodes,
  type ProfileLearningEpisode,
} from './profileLearningEpisodes';
import type { LearningProposalPatch } from './profileSelfLearning';

export type MlLearnMode = 'off' | 'shadow' | 'hybrid' | 'lead';

export interface ProfileMlModel {
  version: 1;
  profileId: string;
  trainedAt: number;
  nTrain: number;
  nHoldout: number;
  /** Holdout accuracy (win/lose) 0–1 */
  holdoutAcc: number;
  /** Holdout AUC-ish (average pairwise) 0–1 */
  holdoutAuc: number;
  /** Mean |predicted − label| on holdout for pnl regression head */
  holdoutMae: number;
  featureNames: string[];
  /** Logistic weights for P(win) — length = features + 1 (bias last) */
  winWeights: number[];
  /** Ridge weights for expected pnlPct — length = features + 1 */
  pnlWeights: number[];
  /** Episodes counted when last trained */
  episodeCountAtTrain: number;
}

export interface MlAdvice {
  at: number;
  summary: string;
  preferredSummary?: string;
  predictedDelta: number;
  pImprove: number;
  weight: number;
  holdoutAuc: number;
  nTrain: number;
  stale: boolean;
}

export interface MlScoreResult {
  predictedDelta: number;
  pImprove: number;
  weight: number;
  model: ProfileMlModel | null;
}

const MODEL_DIR = () => dataFile('profile-learning-models');
const MIN_TRAIN = 40;
const RETRAIN_EVERY = 10;

const FEATURE_NAMES = [
  'bias_slot', // unused in vector — bias is separate
  'pnl_hist_mean',
  'win_rate',
  'avg_giveback',
  'avg_peak',
  'avg_hold',
  'loser_rate',
  'left_on_table',
  'avg_conviction',
  'avg_wallets',
  'avg_mc_log',
  'avg_lane',
  'ha_enabled_share',
  'patch_giveback_delta',
  'patch_arm_delta',
  'patch_partial_delta',
  'patch_conviction_delta',
  'patch_timer_delta',
  'patch_has_exit',
  'patch_has_match',
] as const;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function safeNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function modelPath(profileId: string): string {
  const safe = String(profileId || 'unknown').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(MODEL_DIR(), `${safe}.json`);
}

export function loadProfileMlModel(profileId: string): ProfileMlModel | null {
  try {
    const p = modelPath(profileId);
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as ProfileMlModel;
    if (!raw || raw.version !== 1 || !Array.isArray(raw.winWeights)) return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveProfileMlModel(model: ProfileMlModel): void {
  ensureDataDir();
  const dir = MODEL_DIR();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWriteJson(modelPath(model.profileId), model);
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Window-level features (no patch). */
export function buildWindowFeatures(
  episodes: ProfileLearningEpisode[]
): number[] {
  if (!episodes.length) {
    return new Array(FEATURE_NAMES.length - 1).fill(0);
  }
  const pnls = episodes.map((e) => safeNum(e.pnlPct));
  const wins = pnls.filter((p) => p > 0).length / episodes.length;
  const losers = pnls.filter((p) => p <= 0).length / episodes.length;
  const give = episodes.map((e) => safeNum(e.givebackFromPeakPct));
  const peaks = episodes.map((e) => safeNum(e.peakUnrealizedPct));
  const holds = episodes.map((e) => safeNum(e.holdSec));
  const left =
    episodes.filter(
      (e) =>
        safeNum(e.maxRunupPct) >= 35 &&
        safeNum(e.exitUnrealizedPct) < safeNum(e.maxRunupPct) * 0.4
    ).length / episodes.length;
  const conv = episodes
    .map((e) => e.convictionScore)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const wallets = episodes
    .map((e) => e.walletCount)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const mcs = episodes
    .map((e) => e.entryMarketCapUsd)
    .filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
  const lanes = episodes
    .map((e) => e.laneScore ?? e.tradeProfileScore)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const haShare =
    episodes.filter((e) => e.haExitEnabledAtOpen === true).length /
    episodes.length;

  return [
    mean(pnls) / 20, // scale
    wins,
    mean(give) / 40,
    mean(peaks) / 80,
    mean(holds) / 600,
    losers,
    left,
    conv.length ? mean(conv) / 100 : 0.45,
    wallets.length ? mean(wallets) / 5 : 0.3,
    mcs.length ? Math.log10(mean(mcs) + 1) / 7 : 0.5,
    lanes.length ? mean(lanes) / 100 : 0.5,
    haShare,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ];
}

/** Append patch deltas onto window features. */
export function buildPatchFeatures(
  episodes: ProfileLearningEpisode[],
  patch: LearningProposalPatch,
  current?: {
    profitGivebackPts?: number;
    profitLockArmPct?: number;
    earlyPartialTpPct?: number;
    minConviction?: number;
    hardTimeLimitSecMax?: number;
  }
): number[] {
  const base = buildWindowFeatures(episodes);
  const ep = patch.exitRules?.exitPolicy || {};
  const giveCur = safeNum(current?.profitGivebackPts, 25);
  const armCur = safeNum(current?.profitLockArmPct, 40);
  const partCur = safeNum(current?.earlyPartialTpPct, 15);
  const convCur = safeNum(current?.minConviction, 40);
  const timerCur = safeNum(current?.hardTimeLimitSecMax, 300);

  const giveNext =
    ep.profitGivebackPts != null ? Number(ep.profitGivebackPts) : giveCur;
  const armNext =
    ep.profitLockArmPct != null ? Number(ep.profitLockArmPct) : armCur;
  const partNext =
    ep.earlyPartialTpPct != null ? Number(ep.earlyPartialTpPct) : partCur;
  const convNext =
    patch.match?.minConviction != null
      ? Number(patch.match.minConviction)
      : convCur;
  const timerNext =
    patch.exitRules?.hardTimeLimitSecMax != null
      ? Number(patch.exitRules.hardTimeLimitSecMax)
      : timerCur;

  // indices 12..18 are patch slots in buildWindowFeatures (11 = ha_enabled_share)
  base[12] = (giveCur - giveNext) / 10; // tighten giveback → positive
  base[13] = (armCur - armNext) / 20;
  base[14] = (partCur - partNext) / 10;
  base[15] = (convNext - convCur) / 10;
  base[16] = (timerCur - timerNext) / 120;
  base[17] = patch.exitRules ? 1 : 0;
  base[18] = patch.match ? 1 : 0;
  return base;
}

function sigmoid(z: number): number {
  if (z > 20) return 1;
  if (z < -20) return 0;
  return 1 / (1 + Math.exp(-z));
}

function dot(w: number[], x: number[]): number {
  let s = w[w.length - 1] || 0; // bias
  const n = Math.min(w.length - 1, x.length);
  for (let i = 0; i < n; i++) s += (w[i] || 0) * (x[i] || 0);
  return s;
}

/** Train logistic (win) + ridge (pnl) on episode rows with synthetic patch=0 features. */
export function trainProfileMlModel(
  profileId: string,
  episodes?: ProfileLearningEpisode[]
): ProfileMlModel | null {
  const eps = episodes || getProfileLearningEpisodes(profileId, 400);
  if (eps.length < MIN_TRAIN) return null;

  // Time-split holdout: last 25%
  const holdN = Math.max(8, Math.floor(eps.length * 0.25));
  const train = eps.slice(0, Math.max(MIN_TRAIN - 4, eps.length - holdN));
  const hold = eps.slice(train.length);
  if (train.length < 20 || hold.length < 4) return null;

  const X: number[][] = [];
  const yWin: number[] = [];
  const yPnl: number[] = [];
  for (const e of train) {
    // Per-episode features: use singleton window + empty patch
    const feat = buildPatchFeatures([e], {});
    X.push(feat);
    yWin.push((e.pnlPct || 0) > 0 ? 1 : 0);
    yPnl.push(clamp((e.pnlPct || 0) / 20, -3, 3));
  }

  const dim = X[0].length;
  let winW = new Array(dim + 1).fill(0);
  let pnlW = new Array(dim + 1).fill(0);

  // Logistic SGD
  const lr = 0.08;
  const epochs = 80;
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = 0; i < X.length; i++) {
      const pred = sigmoid(dot(winW, X[i]));
      const err = pred - yWin[i];
      for (let j = 0; j < dim; j++) {
        winW[j] -= lr * err * X[i][j];
      }
      winW[dim] -= lr * err;
    }
  }

  // Ridge closed-form via iterative SGD
  const lambda = 0.05;
  for (let ep = 0; ep < 60; ep++) {
    for (let i = 0; i < X.length; i++) {
      const pred = dot(pnlW, X[i]);
      const err = pred - yPnl[i];
      for (let j = 0; j < dim; j++) {
        pnlW[j] -= lr * (err * X[i][j] + lambda * pnlW[j]);
      }
      pnlW[dim] -= lr * err;
    }
  }

  // Holdout metrics
  let correct = 0;
  let mae = 0;
  const holdScores: number[] = [];
  const holdLabels: number[] = [];
  for (const e of hold) {
    const feat = buildPatchFeatures([e], {});
    const pWin = sigmoid(dot(winW, feat));
    const predPnl = dot(pnlW, feat) * 20;
    if ((pWin >= 0.5 ? 1 : 0) === ((e.pnlPct || 0) > 0 ? 1 : 0)) correct += 1;
    mae += Math.abs(predPnl - (e.pnlPct || 0));
    holdScores.push(pWin);
    holdLabels.push((e.pnlPct || 0) > 0 ? 1 : 0);
  }
  const holdoutAcc = correct / hold.length;
  const holdoutMae = mae / hold.length;
  const holdoutAuc = pairwiseAuc(holdScores, holdLabels);

  const model: ProfileMlModel = {
    version: 1,
    profileId,
    trainedAt: Date.now(),
    nTrain: train.length,
    nHoldout: hold.length,
    holdoutAcc,
    holdoutAuc,
    holdoutMae,
    featureNames: [...FEATURE_NAMES.slice(1)],
    winWeights: winW,
    pnlWeights: pnlW,
    episodeCountAtTrain: eps.length,
  };
  saveProfileMlModel(model);
  return model;
}

function pairwiseAuc(scores: number[], labels: number[]): number {
  let pos = 0;
  let neg = 0;
  for (const y of labels) {
    if (y > 0) pos += 1;
    else neg += 1;
  }
  if (pos === 0 || neg === 0) return 0.5;
  let good = 0;
  for (let i = 0; i < scores.length; i++) {
    for (let j = 0; j < scores.length; j++) {
      if (labels[i] === 1 && labels[j] === 0) {
        if (scores[i] > scores[j]) good += 1;
        else if (scores[i] === scores[j]) good += 0.5;
      }
    }
  }
  return good / (pos * neg);
}

/**
 * Blend weight for hybrid scoring.
 * w=0 below 50 eps; ramp toward 0.35 by 120; cap 0.55 until lead mode.
 */
export function mlWeight(
  episodeCount: number,
  holdoutAuc: number,
  mlMode: MlLearnMode
): number {
  if (mlMode === 'off' || mlMode === 'shadow') return 0;
  const n = Math.max(0, episodeCount);
  if (n < 50) return 0;
  let base = 0;
  if (n < 120) base = ((n - 50) / 70) * 0.35;
  else if (n < 200) base = 0.35 + ((n - 120) / 80) * 0.2;
  else base = 0.55;
  // Gate on holdout quality
  const aucGate = clamp((holdoutAuc - 0.48) / 0.22, 0, 1);
  base *= 0.35 + 0.65 * aucGate;
  if (mlMode === 'lead' && n >= 200 && holdoutAuc >= 0.58) {
    return clamp(base + 0.25, 0, 0.8);
  }
  if (mlMode === 'hybrid') return clamp(base, 0, 0.55);
  return 0;
}

export function scorePatchWithMl(
  profileId: string,
  episodes: ProfileLearningEpisode[],
  patch: LearningProposalPatch,
  opts?: {
    mlMode?: MlLearnMode;
    current?: {
      profitGivebackPts?: number;
      profitLockArmPct?: number;
      earlyPartialTpPct?: number;
      minConviction?: number;
      hardTimeLimitSecMax?: number;
    };
  }
): MlScoreResult {
  const mlMode = opts?.mlMode || 'shadow';
  const model = loadProfileMlModel(profileId);
  if (!model || mlMode === 'off') {
    return { predictedDelta: 0, pImprove: 0.5, weight: 0, model: null };
  }
  const feat = buildPatchFeatures(episodes, patch, opts?.current);
  const pImprove = sigmoid(dot(model.winWeights, feat));
  // Predicted expectancy lift vs window mean (scaled)
  const predPnl = dot(model.pnlWeights, feat) * 20;
  const windowMean = mean(episodes.map((e) => safeNum(e.pnlPct)));
  const predictedDelta = predPnl - windowMean;
  const weight = mlWeight(episodes.length, model.holdoutAuc, mlMode);
  return { predictedDelta, pImprove, weight, model };
}

/** Soft stale if model older than 40 episodes of new data. */
export function isModelStale(
  model: ProfileMlModel | null,
  episodeCount: number
): boolean {
  if (!model) return true;
  return episodeCount - (model.episodeCountAtTrain || 0) >= 40;
}

/**
 * Retrain when enough new episodes accumulated. Non-blocking intent —
 * caller should not await heavy work on hot path beyond this sync train
 * (episode counts are small ≤400).
 */
export function maybeRetrainProfileMl(
  profileId: string,
  opts?: { force?: boolean }
): ProfileMlModel | null {
  const eps = getProfileLearningEpisodes(profileId, 400);
  if (eps.length < MIN_TRAIN) return loadProfileMlModel(profileId);
  const existing = loadProfileMlModel(profileId);
  if (
    !opts?.force &&
    existing &&
    eps.length - (existing.episodeCountAtTrain || 0) < RETRAIN_EVERY
  ) {
    return existing;
  }
  return trainProfileMlModel(profileId, eps) || existing;
}

export function buildMlAdvice(
  profileId: string,
  episodes: ProfileLearningEpisode[],
  candidates: Array<{ summary: string; patch: LearningProposalPatch }>,
  opts?: {
    mlMode?: MlLearnMode;
    current?: {
      profitGivebackPts?: number;
      profitLockArmPct?: number;
      earlyPartialTpPct?: number;
      minConviction?: number;
      hardTimeLimitSecMax?: number;
    };
  }
): MlAdvice | null {
  const mlMode = opts?.mlMode || 'shadow';
  if (mlMode === 'off') return null;
  let model = loadProfileMlModel(profileId);
  if (!model && episodes.length >= MIN_TRAIN) {
    model = trainProfileMlModel(profileId, episodes);
  }
  if (!model) {
    return {
      at: Date.now(),
      summary: `ML waiting for ≥${MIN_TRAIN} episodes (have ${episodes.length})`,
      predictedDelta: 0,
      pImprove: 0.5,
      weight: 0,
      holdoutAuc: 0,
      nTrain: 0,
      stale: true,
    };
  }

  let best: { summary: string; delta: number; p: number } | null = null;
  for (const c of candidates) {
    const scored = scorePatchWithMl(profileId, episodes, c.patch, {
      mlMode,
      current: opts?.current,
    });
    if (!best || scored.predictedDelta > best.delta) {
      best = {
        summary: c.summary,
        delta: scored.predictedDelta,
        p: scored.pImprove,
      };
    }
  }

  const w = mlWeight(episodes.length, model.holdoutAuc, mlMode);
  const stale = isModelStale(model, episodes.length);
  const deltaBit = best
    ? ` prefers “${best.summary.slice(0, 72)}” (Δ̂ ${best.delta >= 0 ? '+' : ''}${best.delta.toFixed(2)}, P(win) ${(best.p * 100).toFixed(0)}%)`
    : ' — no candidates to rank';
  return {
    at: Date.now(),
    summary: `ML ${mlMode} · n=${model.nTrain} holdoutAuc=${model.holdoutAuc.toFixed(2)} w=${w.toFixed(2)}${stale ? ' · stale' : ''}${deltaBit}`,
    preferredSummary: best?.summary,
    predictedDelta: best?.delta ?? 0,
    pImprove: best?.p ?? 0.5,
    weight: w,
    holdoutAuc: model.holdoutAuc,
    nTrain: model.nTrain,
    stale,
  };
}

/**
 * Tiny continuous ML-led deltas (lead mode only) — still must be clamped later.
 */
export function buildMlLedCandidates(
  episodes: ProfileLearningEpisode[],
  current: {
    profitGivebackPts: number;
    profitLockArmPct: number;
    earlyPartialTpPct: number;
    earlyPartialFraction: number;
    minConviction?: number;
    hardTimeLimitSecMax?: number;
  }
): Array<{ summary: string; patch: LearningProposalPatch }> {
  if (episodes.length < 80) return [];
  const exp = mean(episodes.map((e) => safeNum(e.pnlPct)));
  const left =
    episodes.filter(
      (e) =>
        safeNum(e.maxRunupPct) >= 35 &&
        safeNum(e.exitUnrealizedPct) < safeNum(e.maxRunupPct) * 0.4
    ).length / episodes.length;
  const out: Array<{ summary: string; patch: LearningProposalPatch }> = [];

  if (exp < 0 || left >= 0.18) {
    out.push({
      summary: `ML-led: tighten giveback ${current.profitGivebackPts}→${clamp(current.profitGivebackPts - 2, 8, 45)}`,
      patch: {
        exitRules: {
          exitPolicy: {
            profitGivebackPts: clamp(current.profitGivebackPts - 2, 8, 45),
            profitLockArmPct: clamp(
              Math.round(current.profitLockArmPct * 0.95),
              12,
              90
            ),
          },
        },
      },
    });
  }
  const losers = episodes.filter((e) => (e.pnlPct || 0) <= 0);
  const weak =
    losers.filter((e) => (e.convictionScore ?? 50) < 45).length /
    Math.max(1, losers.length);
  if (weak >= 0.35 && current.minConviction != null) {
    out.push({
      summary: `ML-led: raise conviction → ${clamp(current.minConviction + 3, 30, 85)}`,
      patch: {
        match: {
          minConviction: clamp(current.minConviction + 3, 30, 85),
        },
      },
    });
  }
  if (
    current.hardTimeLimitSecMax != null &&
    episodes.filter((e) => e.exitKey === 'timer' && (e.pnlPct || 0) <= 0)
      .length /
      episodes.length >=
      0.2
  ) {
    const next = Math.max(45, Math.round(current.hardTimeLimitSecMax * 0.9));
    out.push({
      summary: `ML-led: shorten timer → ${next}s`,
      patch: { exitRules: { hardTimeLimitSecMax: next } },
    });
  }
  return out.slice(0, 3);
}

/** Holdout gate: score candidate on last 25% of episodes. */
export function holdoutPatchPasses(
  episodes: ProfileLearningEpisode[],
  scoreBeforeFn: (eps: ProfileLearningEpisode[]) => number,
  scoreAfterFn: (eps: ProfileLearningEpisode[]) => number
): { ok: boolean; before: number; after: number } {
  if (episodes.length < 16) {
    return { ok: true, before: 0, after: 0 }; // too small — don't block
  }
  const holdN = Math.max(4, Math.floor(episodes.length * 0.25));
  const hold = episodes.slice(-holdN);
  const before = scoreBeforeFn(hold);
  const after = scoreAfterFn(hold);
  return { ok: after >= before, before, after };
}

export function normalizeMlMode(raw: unknown): MlLearnMode {
  if (raw === 'hybrid' || raw === 'lead' || raw === 'off' || raw === 'shadow') {
    return raw;
  }
  return 'shadow';
}
