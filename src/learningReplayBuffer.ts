/**
 * Experience replay buffer — offline batch hints from closed episodes.
 * Never forces live trades; caps per-profile and shared rings.
 */

import fs from 'fs';
import path from 'path';
import { config } from './config';
import { dataFile, ensureDataDir, atomicWriteJson } from './dataDir';
import type { ProfileLearningEpisode } from './profileLearningEpisodes';

export type LearningAccelStrength = 'low' | 'medium' | 'high';

export interface LearningAcceleratorsConfig {
  enabled: boolean;
  replayEnabled: boolean;
  counterfactualEnabled: boolean;
  counterfactualApplyHints: boolean;
  teacherStudentEnabled: boolean;
  strength: LearningAccelStrength;
  replayBatchSize: number;
  replayMaxPerHour: number;
}

export const DEFAULT_LEARNING_ACCELERATORS_CONFIG: LearningAcceleratorsConfig = {
  enabled: false,
  replayEnabled: false,
  counterfactualEnabled: true,
  counterfactualApplyHints: false,
  teacherStudentEnabled: false,
  strength: 'low',
  replayBatchSize: 12,
  replayMaxPerHour: 6,
};

export interface ReplayTransition {
  id: string;
  at: number;
  profileId: string;
  episodeId: string;
  convictionScore?: number;
  laneScore?: number;
  taConfluence?: number;
  taToolsPassed?: string[];
  entryMarketCapUsd?: number;
  hourUtc?: number;
  exitKey: string;
  holdSec: number;
  maxRunupPct: number;
  givebackFromPeakPct: number;
  peakProtectArmed?: boolean;
  pnlPct: number;
  win: boolean;
  timingReward?: number;
  rewardWeight: number;
}

interface ReplayFile {
  version: 1;
  profileId: string;
  ring: ReplayTransition[];
  closesSinceBatch: number;
  lastBatchAt: number;
  batchesThisHour: number;
  hourWindowStart: number;
  updatedAt: number;
}

export interface ReplayBatchHint {
  profileId: string;
  n: number;
  avgTimingReward: number;
  preferTightenGiveback: boolean;
  preferTighterTrail: boolean;
  replayWeightBoost: number;
  summary: string;
}

const MAX_PER_PROFILE = 200;
const MAX_SHARED = 400;
const DIR = () => dataFile('learning-replay');
const SHARED_ID = 'shared';

const cache = new Map<string, ReplayFile>();
const lastBatchHint = new Map<string, ReplayBatchHint>();
const replayBonusByProfile = new Map<string, number>();

let decisions: Array<{ at: number; kind: string; profileId?: string; detail: string }> = [];

export function getLearningAcceleratorsConfig(): LearningAcceleratorsConfig {
  const m = (config as { learningAccelerators?: Partial<LearningAcceleratorsConfig> })
    .learningAccelerators;
  const strength =
    m?.strength === 'low' || m?.strength === 'high' || m?.strength === 'medium'
      ? m.strength
      : 'low';
  return {
    enabled: m?.enabled === true,
    replayEnabled: m?.replayEnabled === true,
    counterfactualEnabled: m?.counterfactualEnabled !== false,
    counterfactualApplyHints: m?.counterfactualApplyHints === true,
    teacherStudentEnabled: m?.teacherStudentEnabled === true,
    strength,
    replayBatchSize: Math.max(4, Math.min(24, Math.round(Number(m?.replayBatchSize) || 12))),
    replayMaxPerHour: Math.max(1, Math.min(12, Math.round(Number(m?.replayMaxPerHour) || 6))),
  };
}

export function setLearningAcceleratorsConfig(
  patch: Partial<LearningAcceleratorsConfig>
): LearningAcceleratorsConfig {
  const cur = getLearningAcceleratorsConfig();
  const next: LearningAcceleratorsConfig = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
    replayEnabled:
      typeof patch.replayEnabled === 'boolean' ? patch.replayEnabled : cur.replayEnabled,
    counterfactualEnabled:
      typeof patch.counterfactualEnabled === 'boolean'
        ? patch.counterfactualEnabled
        : cur.counterfactualEnabled,
    counterfactualApplyHints:
      typeof patch.counterfactualApplyHints === 'boolean'
        ? patch.counterfactualApplyHints
        : cur.counterfactualApplyHints,
    teacherStudentEnabled:
      typeof patch.teacherStudentEnabled === 'boolean'
        ? patch.teacherStudentEnabled
        : cur.teacherStudentEnabled,
    strength:
      patch.strength === 'low' ||
      patch.strength === 'medium' ||
      patch.strength === 'high'
        ? patch.strength
        : cur.strength,
    replayBatchSize:
      patch.replayBatchSize != null
        ? Math.max(4, Math.min(24, Math.round(Number(patch.replayBatchSize))))
        : cur.replayBatchSize,
    replayMaxPerHour:
      patch.replayMaxPerHour != null
        ? Math.max(1, Math.min(12, Math.round(Number(patch.replayMaxPerHour))))
        : cur.replayMaxPerHour,
  };
  (config as { learningAccelerators: LearningAcceleratorsConfig }).learningAccelerators = next;
  try {
    const { persistUserSettings } = require('./config') as typeof import('./config');
    persistUserSettings();
  } catch {
    /* */
  }
  pushAccelDecision('config', undefined, `Accelerators ${next.enabled ? 'ON' : 'OFF'} · replay ${next.replayEnabled ? 'ON' : 'OFF'} · CF ${next.counterfactualEnabled ? 'ON' : 'OFF'}`);
  return next;
}

function pushAccelDecision(kind: string, profileId: string | undefined, detail: string): void {
  decisions.unshift({ at: Date.now(), kind, profileId, detail });
  if (decisions.length > 80) decisions = decisions.slice(0, 80);
}

/** Shared decision ring hook for CF / teacher-student modules. */
export function pushAccelDecisionRef(
  kind: string,
  profileId: string | undefined,
  detail: string
): void {
  pushAccelDecision(kind, profileId, detail);
}

function fileFor(profileId: string): string {
  const safe = String(profileId || 'unknown').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(DIR(), `${safe}.json`);
}

function emptyFile(profileId: string): ReplayFile {
  return {
    version: 1,
    profileId,
    ring: [],
    closesSinceBatch: 0,
    lastBatchAt: 0,
    batchesThisHour: 0,
    hourWindowStart: Date.now(),
    updatedAt: Date.now(),
  };
}

function loadReplayFile(profileId: string): ReplayFile {
  if (cache.has(profileId)) return cache.get(profileId)!;
  try {
    ensureDataDir();
    const dir = DIR();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const p = fileFor(profileId);
    if (!fs.existsSync(p)) {
      const f = emptyFile(profileId);
      cache.set(profileId, f);
      return f;
    }
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as ReplayFile;
    const f: ReplayFile = {
      version: 1,
      profileId,
      ring: Array.isArray(raw.ring) ? raw.ring : [],
      closesSinceBatch: Number(raw.closesSinceBatch) || 0,
      lastBatchAt: Number(raw.lastBatchAt) || 0,
      batchesThisHour: Number(raw.batchesThisHour) || 0,
      hourWindowStart: Number(raw.hourWindowStart) || Date.now(),
      updatedAt: Number(raw.updatedAt) || Date.now(),
    };
    cache.set(profileId, f);
    return f;
  } catch {
    const f = emptyFile(profileId);
    cache.set(profileId, f);
    return f;
  }
}

function persistReplayFile(profileId: string): void {
  const f = loadReplayFile(profileId);
  f.updatedAt = Date.now();
  const cap = profileId === SHARED_ID ? MAX_SHARED : MAX_PER_PROFILE;
  f.ring = f.ring.slice(-cap);
  try {
    atomicWriteJson(fileFor(profileId), f);
  } catch {
    /* */
  }
}

function surpriseWeight(ep: ProfileLearningEpisode): number {
  const tr = ep.timingReward ?? ep.pnlPct;
  const giveback = ep.givebackFromPeakPct || 0;
  const peakGap = ep.maxRunupPct - ep.pnlPct;
  let w = 1;
  if (Math.abs(tr) >= 8) w += 0.3;
  if (giveback >= 15) w += 0.25;
  if (peakGap >= 12) w += 0.2;
  return Math.min(1.5, w);
}

export function recordReplayTransition(episode: ProfileLearningEpisode): void {
  const cfg = getLearningAcceleratorsConfig();
  if (!cfg.enabled || !cfg.replayEnabled) return;
  const profileId = episode.profileId;
  if (!profileId || profileId === 'default') return;

  const row: ReplayTransition = {
    id: `rp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    at: Date.now(),
    profileId,
    episodeId: episode.id,
    convictionScore: episode.convictionScore,
    laneScore: episode.laneScore ?? episode.tradeProfileScore,
    taConfluence: episode.taConfluenceAtEntry,
    taToolsPassed: episode.taToolsPassedAtEntry,
    entryMarketCapUsd: episode.entryMarketCapUsd,
    hourUtc: episode.hourUtc,
    exitKey: episode.exitKey,
    holdSec: episode.holdSec,
    maxRunupPct: episode.maxRunupPct,
    givebackFromPeakPct: episode.givebackFromPeakPct,
    peakProtectArmed: episode.peakProtectArmed,
    pnlPct: episode.pnlPct,
    win: episode.pnlPct > 0,
    timingReward: episode.timingReward,
    rewardWeight: surpriseWeight(episode),
  };

  // Episode quality weighting for replay prioritisation (Learning Enhancements)
  try {
    const { getLearningEnhancementsConfig } =
      require('./learningEnhancements') as typeof import('./learningEnhancements');
    const { replayQualityMultiplier } =
      require('./episodeQuality') as typeof import('./episodeQuality');
    if (getLearningEnhancementsConfig().enabled && getLearningEnhancementsConfig().qualityWeightingEnabled) {
      row.rewardWeight = Math.min(1.5, row.rewardWeight * replayQualityMultiplier(episode));
    }
  } catch {
    /* optional */
  }

  for (const pid of [profileId, SHARED_ID]) {
    const f = loadReplayFile(pid);
    if (f.ring.some((r) => r.episodeId === episode.id)) continue;
    f.ring.push(row);
    f.closesSinceBatch += 1;
    cache.set(pid, f);
    persistReplayFile(pid);
  }
}

function strengthMult(s: LearningAccelStrength): number {
  if (s === 'high') return 1.4;
  if (s === 'medium') return 1;
  return 0.6;
}

function sampleBatch(profileId: string, batchSize: number): ReplayTransition[] {
  const f = loadReplayFile(profileId);
  const ring = f.ring;
  if (ring.length < 4) return [];
  const recent = ring.slice(-Math.min(ring.length, batchSize * 2));
  const scored = [...recent].sort((a, b) => {
    const sa = Math.abs(a.timingReward ?? a.pnlPct) * a.rewardWeight;
    const sb = Math.abs(b.timingReward ?? b.pnlPct) * b.rewardWeight;
    return sb - sa || b.at - a.at;
  });
  return scored.slice(0, batchSize);
}

function runReplayBatchForProfile(profileId: string): ReplayBatchHint | null {
  const cfg = getLearningAcceleratorsConfig();
  if (!cfg.enabled || !cfg.replayEnabled) return null;

  const f = loadReplayFile(profileId);
  const now = Date.now();
  if (now - f.hourWindowStart > 3_600_000) {
    f.batchesThisHour = 0;
    f.hourWindowStart = now;
  }
  if (f.batchesThisHour >= cfg.replayMaxPerHour) return null;
  if (f.closesSinceBatch < 4) return null;

  const batch = sampleBatch(profileId, cfg.replayBatchSize);
  if (batch.length < 4) return null;

  const avgTr =
    batch.reduce((s, r) => s + (r.timingReward ?? r.pnlPct), 0) / batch.length;
  const largeGiveback =
    batch.filter((r) => r.givebackFromPeakPct >= 12).length / batch.length;
  const sm = strengthMult(cfg.strength);
  const boost = Math.min(1.5, 1 + (largeGiveback >= 0.3 ? 0.35 : 0.15) * sm);

  const hint: ReplayBatchHint = {
    profileId,
    n: batch.length,
    avgTimingReward: Number(avgTr.toFixed(2)),
    preferTightenGiveback: largeGiveback >= 0.28,
    preferTighterTrail: largeGiveback >= 0.22 || avgTr < 0,
    replayWeightBoost: boost,
    summary: `Replayed ${batch.length} trades · avg reward ${avgTr.toFixed(1)} · giveback ${(largeGiveback * 100).toFixed(0)}%`,
  };

  f.closesSinceBatch = 0;
  f.lastBatchAt = now;
  f.batchesThisHour += 1;
  cache.set(profileId, f);
  persistReplayFile(profileId);
  lastBatchHint.set(profileId, hint);
  replayBonusByProfile.set(profileId, Math.min(0.08, 0.02 * sm));

  pushAccelDecision('replay_batch', profileId, hint.summary);
  return hint;
}

/** Called after close — max 1 batch / profile / 4 closes. */
export function maybeRunReplayBatch(profileId: string): void {
  runReplayBatchForProfile(profileId);
}

export function applyReplayBatchHints(profileId: string): ReplayBatchHint | null {
  return lastBatchHint.get(profileId) ?? null;
}

export function getReplayRewardBonus(profileId: string): number {
  return replayBonusByProfile.get(profileId) ?? 0;
}

export function getReplayEpisodeWeightMultiplier(profileId: string): number {
  const hint = lastBatchHint.get(profileId);
  return hint?.replayWeightBoost ?? 1;
}

export function getLearningAcceleratorsStatus(): {
  config: LearningAcceleratorsConfig;
  label: string;
  profiles: Array<{
    profileId: string;
    transitions: number;
    lastBatchAt: number;
    lastHint: ReplayBatchHint | null;
  }>;
  decisions: typeof decisions;
} {
  const cfg = getLearningAcceleratorsConfig();
  const profiles: Array<{
    profileId: string;
    transitions: number;
    lastBatchAt: number;
    lastHint: ReplayBatchHint | null;
  }> = [];

  try {
    ensureDataDir();
    const dir = DIR();
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        const pid = name.replace(/\.json$/, '');
        if (pid === SHARED_ID) continue;
        const f = loadReplayFile(pid);
        profiles.push({
          profileId: pid,
          transitions: f.ring.length,
          lastBatchAt: f.lastBatchAt,
          lastHint: lastBatchHint.get(pid) ?? null,
        });
      }
    }
  } catch {
    /* */
  }

  return {
    config: cfg,
    label: cfg.enabled ? `Accelerators · ${cfg.strength}` : 'Accelerators OFF',
    profiles: profiles.sort((a, b) => b.transitions - a.transitions),
    decisions: decisions.slice(0, 40),
  };
}

export function formatReplayPlainLanguage(profileId: string): string {
  const hint = lastBatchHint.get(profileId);
  if (!hint) return '';
  return `${profileId} replayed ${hint.n} recent trades to refine exit timing (avg reward ${hint.avgTimingReward}).`;
}
