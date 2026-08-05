/**
 * Fast Profiles Recovery Stages (0–4) — Scalper, Reversal Scalper,
 * Momentum Burst, Migration Sniper. Additive overlays only.
 */

import fs from 'fs';
import { dataFile, ensureDataDir, atomicWriteJson } from './dataDir';
import { config, persistUserSettings } from './config';
import { logger, errorToMeta } from './logger';
import {
  getProfileLearningEpisodes,
  type ProfileLearningEpisode,
} from './profileLearningEpisodes';
import {
  buildProfilePerformanceTrend,
  computeWindowMetrics,
  invalidateProfilePerformanceTrendCache,
} from './profilePerformanceTrend';
import { PEAK_PROTECT_FAST_PROFILES } from './peakProfitProtection';

export const FAST_RECOVERY_PROFILE_IDS = [
  'scalper',
  'reversal_scalper',
  'momentum_burst',
  'migration_sniper',
] as const;

export type FastRecoveryProfileId = (typeof FAST_RECOVERY_PROFILE_IDS)[number];
export type RecoveryStage = 0 | 1 | 2 | 3 | 4;

export const RECOVERY_STAGE_NAMES: Record<RecoveryStage, string> = {
  0: 'Full Recovery',
  1: 'Frequency Release',
  2: 'Size Release',
  3: 'Controlled Release',
  4: 'Normal Operation',
};

export interface FastRecoveryStage0Defaults {
  maxConcurrent: number;
  sizeMultiplier: number;
  minMsBetweenEntries: number;
  peakProtectArmOfTpPct: number;
  peakProtectGivebackOfPeakPct: number;
  minVolumeM5Usd: number;
}

export interface FastRecoveryReadinessWeights {
  expectancyTrend: number;
  winRateTrend: number;
  givebackImprovement: number;
  lossStreakControl: number;
  stability: number;
  sampleSufficiency: number;
}

export interface FastRecoveryProfileConfig {
  enabled: boolean;
  stage: RecoveryStage;
  stageLocked: boolean;
  forcedStage?: RecoveryStage | null;
  learningModeOverride?: boolean;
}

export interface FastProfileRecoveryConfig {
  enabled: boolean;
  autoTaper: true | boolean;
  profiles: Record<string, FastRecoveryProfileConfig>;
  stage0: FastRecoveryStage0Defaults;
  minTradesBeforePromote: number;
  minTradesBeforePromoteTo4: number;
  promoteReadinessByStage: Record<string, number>;
  demoteReadinessMax: number;
  readinessWeights: FastRecoveryReadinessWeights;
}

export interface RecoveryConstraints {
  active: boolean;
  stage: RecoveryStage;
  stageName: string;
  maxConcurrent: number;
  sizeMultiplier: number;
  minMsBetweenEntries: number;
  minVolumeM5Usd: number;
  peakProtectArmOfTpPct: number;
  peakProtectGivebackOfPeakPct: number;
  tpPctMaxSoft: number | null;
  stopLossPctTight: number | null;
  blockLead: boolean;
  blockLearningMode: boolean;
  taModeMax: 'off' | 'soft' | 'any';
  marlDownrank: number;
  skipExtendedPump: boolean;
  requireVolumeExpansion: boolean;
  migrationFreshOnly: boolean;
}

export interface StageBaseline {
  expectancy: number;
  winRate: number;
  giveback: number;
  at: number;
}

export interface ProfileRecoveryRuntime {
  stageEnteredAt: number;
  tradesInStage: number;
  baseline: StageBaseline | null;
  readinessAtLastPromote: number | null;
  lastTransitionReason: string;
  snapshot?: {
    taMode?: string;
    rlMode?: string;
    rlLocked?: boolean;
  };
}

interface RecoveryStateFile {
  version: 1;
  runtime: Record<string, ProfileRecoveryRuntime>;
  lastEntryAtByProfile: Record<string, number>;
  history: Array<{
    at: number;
    profileId: string;
    from: RecoveryStage;
    to: RecoveryStage;
    reason: string;
  }>;
}

export interface GateStatus {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

export interface ReadinessBreakdown {
  expectancyTrend: number;
  winRateTrend: number;
  givebackImprovement: number;
  lossStreakControl: number;
  stability: number;
  sampleSufficiency: number;
}

export interface ProfileRecoveryStatus {
  profileId: string;
  enabled: boolean;
  recovering: boolean;
  stage: RecoveryStage;
  stageName: string;
  stageLocked: boolean;
  autoTaper: boolean;
  readinessScore: number;
  breakdown: ReadinessBreakdown;
  weights: FastRecoveryReadinessWeights;
  gates: GateStatus[];
  canPromote: boolean;
  shouldDemote: boolean;
  plainLanguage: string;
  tradesInStage: number;
  windowMetrics: ReturnType<typeof computeWindowMetrics>;
  trendLabel: string;
  constraints: RecoveryConstraints;
  lastTransitionReason: string;
}

const FILE = () => dataFile('fast-profile-recovery-state.json');

export const DEFAULT_FAST_PROFILE_RECOVERY: FastProfileRecoveryConfig = {
  enabled: false,
  autoTaper: true,
  profiles: Object.fromEntries(
    FAST_RECOVERY_PROFILE_IDS.map((id) => [
      id,
      {
        enabled: true,
        stage: 0 as RecoveryStage,
        stageLocked: false,
        forcedStage: null,
        learningModeOverride: false,
      },
    ])
  ),
  stage0: {
    maxConcurrent: 1,
    sizeMultiplier: 0.65,
    minMsBetweenEntries: 120_000,
    peakProtectArmOfTpPct: 45,
    peakProtectGivebackOfPeakPct: 30,
    minVolumeM5Usd: 1200,
  },
  minTradesBeforePromote: 12,
  minTradesBeforePromoteTo4: 20,
  promoteReadinessByStage: { '0': 65, '1': 70, '2': 72, '3': 78 },
  demoteReadinessMax: 40,
  readinessWeights: {
    expectancyTrend: 0.25,
    winRateTrend: 0.2,
    givebackImprovement: 0.2,
    lossStreakControl: 0.15,
    stability: 0.1,
    sampleSufficiency: 0.1,
  },
};

let stateCache: RecoveryStateFile | null = null;
const lastEntryAtByProfile: Record<string, number> = {};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function asStage(n: unknown): RecoveryStage {
  const v = Math.round(Number(n));
  if (v <= 0) return 0;
  if (v >= 4) return 4;
  return v as RecoveryStage;
}

export function isFastRecoveryProfileId(
  id: string | null | undefined
): id is FastRecoveryProfileId {
  return FAST_RECOVERY_PROFILE_IDS.includes(id as FastRecoveryProfileId);
}

function emptyState(): RecoveryStateFile {
  return { version: 1, runtime: {}, lastEntryAtByProfile: {}, history: [] };
}

function loadState(): RecoveryStateFile {
  if (stateCache) return stateCache;
  try {
    ensureDataDir();
    if (!fs.existsSync(FILE())) {
      stateCache = emptyState();
      return stateCache;
    }
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8')) as RecoveryStateFile;
    stateCache = {
      version: 1,
      runtime: raw?.runtime && typeof raw.runtime === 'object' ? raw.runtime : {},
      lastEntryAtByProfile:
        raw?.lastEntryAtByProfile && typeof raw.lastEntryAtByProfile === 'object'
          ? raw.lastEntryAtByProfile
          : {},
      history: Array.isArray(raw?.history) ? raw.history.slice(-200) : [],
    };
    Object.assign(lastEntryAtByProfile, stateCache.lastEntryAtByProfile);
  } catch (err) {
    logger.warn('FastRecovery', 'state load failed', errorToMeta(err));
    stateCache = emptyState();
  }
  return stateCache;
}

function persistState(): void {
  try {
    ensureDataDir();
    const s = loadState();
    s.lastEntryAtByProfile = { ...lastEntryAtByProfile };
    atomicWriteJson(FILE(), s);
  } catch (err) {
    logger.warn('FastRecovery', 'state persist failed', errorToMeta(err));
  }
}

function defaultProfileCfg(): FastRecoveryProfileConfig {
  return {
    enabled: true,
    stage: 0,
    stageLocked: false,
    forcedStage: null,
    learningModeOverride: false,
  };
}

export function getFastProfileRecoveryConfig(): FastProfileRecoveryConfig {
  const raw = (config as { fastProfileRecovery?: Partial<FastProfileRecoveryConfig> })
    .fastProfileRecovery;
  const d = DEFAULT_FAST_PROFILE_RECOVERY;
  const profiles: Record<string, FastRecoveryProfileConfig> = {};
  for (const id of FAST_RECOVERY_PROFILE_IDS) {
    const p = raw?.profiles?.[id];
    profiles[id] = {
      enabled: p?.enabled !== false,
      stage: asStage(p?.forcedStage != null ? p.forcedStage : p?.stage ?? 0),
      stageLocked: p?.stageLocked === true,
      forcedStage:
        p?.forcedStage != null && Number.isFinite(Number(p.forcedStage))
          ? asStage(p.forcedStage)
          : null,
      learningModeOverride: p?.learningModeOverride === true,
    };
  }
  const w = raw?.readinessWeights || d.readinessWeights;
  const sum =
    Number(w.expectancyTrend) +
    Number(w.winRateTrend) +
    Number(w.givebackImprovement) +
    Number(w.lossStreakControl) +
    Number(w.stability) +
    Number(w.sampleSufficiency);
  const norm = sum > 0.01 ? sum : 1;
  return {
    enabled: raw?.enabled === true,
    autoTaper: raw?.autoTaper !== false,
    profiles,
    stage0: {
      maxConcurrent: clamp(
        Number(raw?.stage0?.maxConcurrent ?? d.stage0.maxConcurrent) || 1,
        1,
        3
      ),
      sizeMultiplier: clamp(
        Number(raw?.stage0?.sizeMultiplier ?? d.stage0.sizeMultiplier) || 0.65,
        0.3,
        1
      ),
      minMsBetweenEntries: clamp(
        Number(raw?.stage0?.minMsBetweenEntries ?? d.stage0.minMsBetweenEntries) ||
          120_000,
        15_000,
        600_000
      ),
      peakProtectArmOfTpPct: clamp(
        Number(
          raw?.stage0?.peakProtectArmOfTpPct ?? d.stage0.peakProtectArmOfTpPct
        ) || 45,
        25,
        70
      ),
      peakProtectGivebackOfPeakPct: clamp(
        Number(
          raw?.stage0?.peakProtectGivebackOfPeakPct ??
            d.stage0.peakProtectGivebackOfPeakPct
        ) || 30,
        15,
        50
      ),
      minVolumeM5Usd: clamp(
        Number(raw?.stage0?.minVolumeM5Usd ?? d.stage0.minVolumeM5Usd) || 1200,
        400,
        20_000
      ),
    },
    minTradesBeforePromote: clamp(
      Number(raw?.minTradesBeforePromote ?? d.minTradesBeforePromote) || 12,
      6,
      40
    ),
    minTradesBeforePromoteTo4: clamp(
      Number(raw?.minTradesBeforePromoteTo4 ?? d.minTradesBeforePromoteTo4) || 20,
      10,
      60
    ),
    promoteReadinessByStage: {
      '0': Number(raw?.promoteReadinessByStage?.['0'] ?? 65),
      '1': Number(raw?.promoteReadinessByStage?.['1'] ?? 70),
      '2': Number(raw?.promoteReadinessByStage?.['2'] ?? 72),
      '3': Number(raw?.promoteReadinessByStage?.['3'] ?? 78),
    },
    demoteReadinessMax: clamp(
      Number(raw?.demoteReadinessMax ?? d.demoteReadinessMax) || 40,
      15,
      60
    ),
    readinessWeights: {
      expectancyTrend: Number(w.expectancyTrend) / norm,
      winRateTrend: Number(w.winRateTrend) / norm,
      givebackImprovement: Number(w.givebackImprovement) / norm,
      lossStreakControl: Number(w.lossStreakControl) / norm,
      stability: Number(w.stability) / norm,
      sampleSufficiency: Number(w.sampleSufficiency) / norm,
    },
  };
}

export function setFastProfileRecoveryConfig(
  patch: Partial<FastProfileRecoveryConfig> & {
    profiles?: Record<string, Partial<FastRecoveryProfileConfig>>;
  }
): FastProfileRecoveryConfig {
  const cur = getFastProfileRecoveryConfig();
  const nextProfiles = { ...cur.profiles };
  if (patch.profiles) {
    for (const id of FAST_RECOVERY_PROFILE_IDS) {
      const p = patch.profiles[id];
      if (!p) continue;
      const prev = nextProfiles[id] || defaultProfileCfg();
      const wasOff = !cur.enabled || !prev.enabled;
      const enabled = typeof p.enabled === 'boolean' ? p.enabled : prev.enabled;
      let stage = asStage(p.stage != null ? p.stage : prev.stage);
      if (p.forcedStage != null) stage = asStage(p.forcedStage);
      const turningOn =
        (patch.enabled === true || (patch.enabled == null && cur.enabled)) &&
        enabled &&
        wasOff;
      if (turningOn && p.stage == null && p.forcedStage == null) stage = 0;
      nextProfiles[id] = {
        enabled,
        stage,
        stageLocked:
          typeof p.stageLocked === 'boolean' ? p.stageLocked : prev.stageLocked,
        forcedStage:
          p.forcedStage !== undefined
            ? p.forcedStage == null
              ? null
              : asStage(p.forcedStage)
            : prev.forcedStage ?? null,
        learningModeOverride:
          typeof p.learningModeOverride === 'boolean'
            ? p.learningModeOverride
            : prev.learningModeOverride === true,
      };
      if (turningOn || (p.stage != null && p.stage !== prev.stage)) {
        ensureRuntime(id, true);
      }
    }
  }
  const next: FastProfileRecoveryConfig = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
    autoTaper:
      typeof patch.autoTaper === 'boolean' ? patch.autoTaper : cur.autoTaper,
    profiles: nextProfiles,
    stage0: { ...cur.stage0, ...(patch.stage0 || {}) },
    minTradesBeforePromote:
      patch.minTradesBeforePromote ?? cur.minTradesBeforePromote,
    minTradesBeforePromoteTo4:
      patch.minTradesBeforePromoteTo4 ?? cur.minTradesBeforePromoteTo4,
    promoteReadinessByStage: {
      ...cur.promoteReadinessByStage,
      ...(patch.promoteReadinessByStage || {}),
    },
    demoteReadinessMax: patch.demoteReadinessMax ?? cur.demoteReadinessMax,
    readinessWeights: {
      ...cur.readinessWeights,
      ...(patch.readinessWeights || {}),
    },
  };
  if (patch.enabled === true && !cur.enabled) {
    for (const id of FAST_RECOVERY_PROFILE_IDS) {
      if (next.profiles[id]?.enabled !== false && next.profiles[id]?.forcedStage == null) {
        next.profiles[id]!.stage = 0;
        ensureRuntime(id, true);
      }
    }
    logger.info(
      'FastRecovery',
      'Fast Profiles Recovery ON — default Stage 0 for enabled fast profiles'
    );
  }
  (config as { fastProfileRecovery: FastProfileRecoveryConfig }).fastProfileRecovery =
    next;
  try {
    persistUserSettings();
  } catch {
    /* */
  }
  persistState();
  return getFastProfileRecoveryConfig();
}

function ensureRuntime(profileId: string, resetStage = false): ProfileRecoveryRuntime {
  const s = loadState();
  if (!s.runtime[profileId] || resetStage) {
    s.runtime[profileId] = {
      stageEnteredAt: Date.now(),
      tradesInStage: 0,
      baseline: null,
      readinessAtLastPromote: null,
      lastTransitionReason: resetStage ? 'entered stage' : 'init',
    };
    persistState();
  }
  return s.runtime[profileId]!;
}

export function getProfileRecoveryStage(
  profileId: string | null | undefined
): RecoveryStage {
  if (!isFastRecoveryProfileId(profileId)) return 4;
  const cfg = getFastProfileRecoveryConfig();
  if (!cfg.enabled) return 4;
  const p = cfg.profiles[profileId];
  if (!p || p.enabled === false) return 4;
  if (p.forcedStage != null) return asStage(p.forcedStage);
  return asStage(p.stage);
}

export function isFastProfileRecovering(
  profileId: string | null | undefined
): boolean {
  if (!isFastRecoveryProfileId(profileId)) return false;
  const cfg = getFastProfileRecoveryConfig();
  if (!cfg.enabled) return false;
  const p = cfg.profiles[profileId];
  if (!p || p.enabled === false) return false;
  return getProfileRecoveryStage(profileId) < 4;
}

/** Stage-scaled constraints. Stage 4 / inactive → inactive overlay. */
export function getRecoveryConstraints(
  profileId: string | null | undefined
): RecoveryConstraints {
  const stage = getProfileRecoveryStage(profileId);
  const active = isFastProfileRecovering(profileId);
  const cfg = getFastProfileRecoveryConfig();
  const s0 = cfg.stage0;
  const name = RECOVERY_STAGE_NAMES[stage];

  if (!active) {
    return {
      active: false,
      stage: 4,
      stageName: RECOVERY_STAGE_NAMES[4],
      maxConcurrent: 99,
      sizeMultiplier: 1,
      minMsBetweenEntries: 0,
      minVolumeM5Usd: 0,
      peakProtectArmOfTpPct: 0,
      peakProtectGivebackOfPeakPct: 0,
      tpPctMaxSoft: null,
      stopLossPctTight: null,
      blockLead: false,
      blockLearningMode: false,
      taModeMax: 'any',
      marlDownrank: 0,
      skipExtendedPump: false,
      requireVolumeExpansion: false,
      migrationFreshOnly: false,
    };
  }

  // Taper: frequency → size → concurrency → exit strictness
  const cooldownMult = stage === 0 ? 1 : stage === 1 ? 0.75 : stage <= 2 ? 0.75 : 0.55;
  const sizeMult =
    stage === 0
      ? s0.sizeMultiplier
      : stage === 1
        ? s0.sizeMultiplier
        : stage === 2
          ? Math.min(0.9, s0.sizeMultiplier + 0.2)
          : Math.min(0.95, s0.sizeMultiplier + 0.28);
  const maxConcurrent = stage >= 3 ? 2 : 1;
  const volMult = stage <= 1 ? 1 : stage === 2 ? 0.9 : 0.8;
  const arm =
    stage <= 1
      ? s0.peakProtectArmOfTpPct
      : stage === 2
        ? s0.peakProtectArmOfTpPct + 3
        : s0.peakProtectArmOfTpPct + 8;
  const giveback =
    stage <= 1
      ? s0.peakProtectGivebackOfPeakPct
      : stage === 2
        ? s0.peakProtectGivebackOfPeakPct + 3
        : s0.peakProtectGivebackOfPeakPct + 6;

  const pid = String(profileId || '');
  const strictBank = pid === 'scalper' || pid === 'reversal_scalper';

  return {
    active: true,
    stage,
    stageName: name,
    maxConcurrent,
    sizeMultiplier: strictBank ? sizeMult * 0.95 : sizeMult,
    minMsBetweenEntries: Math.round(s0.minMsBetweenEntries * cooldownMult),
    minVolumeM5Usd: Math.round(s0.minVolumeM5Usd * volMult * (strictBank ? 1.1 : 1)),
    peakProtectArmOfTpPct: clamp(arm, 30, 70),
    peakProtectGivebackOfPeakPct: clamp(giveback, 20, 45),
    tpPctMaxSoft: stage <= 1 ? 22 : stage === 2 ? 26 : null,
    stopLossPctTight: stage <= 1 ? -8 : stage === 2 ? -10 : null,
    blockLead: true,
    blockLearningMode: stage < 4,
    taModeMax: pid === 'momentum_burst' ? 'soft' : 'soft',
    marlDownrank: stage === 0 ? -6 : stage === 1 ? -4 : stage === 2 ? -3 : -2,
    skipExtendedPump: stage <= 2,
    requireVolumeExpansion: pid === 'momentum_burst' || stage <= 1,
    migrationFreshOnly: pid === 'migration_sniper' && stage <= 2,
  };
}

export function noteFastProfileEntry(profileId: string): void {
  if (!isFastRecoveryProfileId(profileId)) return;
  lastEntryAtByProfile[profileId] = Date.now();
  persistState();
}

export function getLastFastProfileEntryAt(profileId: string): number {
  loadState();
  return Number(lastEntryAtByProfile[profileId] || 0);
}

export function checkFastRecoveryEntryGates(input: {
  profileId: string;
  openPositions: Array<{ tradeProfileId?: string | null }>;
  volumeM5Usd?: number | null;
  recentVolumeUsd?: number | null;
  extensionPct?: number | null;
  tokenAgeMin?: number | null;
}): { ok: boolean; reason?: string } {
  const c = getRecoveryConstraints(input.profileId);
  if (!c.active) return { ok: true };

  const openCount = input.openPositions.filter(
    (p) => p.tradeProfileId === input.profileId
  ).length;
  if (openCount >= c.maxConcurrent) {
    return {
      ok: false,
      reason: `Fast Recovery Stage ${c.stage}: max ${c.maxConcurrent} ${input.profileId} open`,
    };
  }

  const last = getLastFastProfileEntryAt(input.profileId);
  if (last > 0 && Date.now() - last < c.minMsBetweenEntries) {
    const waitSec = Math.ceil((c.minMsBetweenEntries - (Date.now() - last)) / 1000);
    return {
      ok: false,
      reason: `Fast Recovery Stage ${c.stage}: cooldown ${waitSec}s remaining`,
    };
  }

  const vol = Number(input.volumeM5Usd ?? input.recentVolumeUsd ?? 0);
  if (c.minVolumeM5Usd > 0 && vol > 0 && vol < c.minVolumeM5Usd) {
    return {
      ok: false,
      reason: `Fast Recovery Stage ${c.stage}: volume $${Math.round(vol)} < $${c.minVolumeM5Usd}`,
    };
  }
  if (
    (input.recentVolumeUsd != null && Number(input.recentVolumeUsd) <= 0) ||
    (input.volumeM5Usd != null && Number(input.volumeM5Usd) <= 0)
  ) {
    return {
      ok: false,
      reason: `Fast Recovery Stage ${c.stage}: near-zero volume skip`,
    };
  }

  if (
    c.skipExtendedPump &&
    input.extensionPct != null &&
    Number(input.extensionPct) >= 35
  ) {
    return {
      ok: false,
      reason: `Fast Recovery Stage ${c.stage}: skip extended pump (${Number(input.extensionPct).toFixed(0)}%)`,
    };
  }

  if (
    c.migrationFreshOnly &&
    input.tokenAgeMin != null &&
    Number(input.tokenAgeMin) > 12
  ) {
    return {
      ok: false,
      reason: `Fast Recovery Stage ${c.stage}: migration not fresh (${Number(input.tokenAgeMin).toFixed(1)}m)`,
    };
  }

  return { ok: true };
}

export function applyRecoverySizeMultiplier(
  profileId: string | null | undefined,
  sizeSol: number
): number {
  const c = getRecoveryConstraints(profileId);
  if (!c.active) return sizeSol;
  return Math.max(0.001, sizeSol * c.sizeMultiplier);
}

function pickWindow(eps: ProfileLearningEpisode[]): ProfileLearningEpisode[] {
  if (eps.length >= 40) return eps.slice(-40);
  if (eps.length >= 25) return eps.slice(-25);
  return eps.slice(-Math.max(eps.length, 0));
}

function stabilityScore(eps: ProfileLearningEpisode[]): number {
  if (eps.length < 6) return 40;
  const pnls = eps.map((e) => Number(e.pnlPct || 0));
  const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const variance =
    pnls.reduce((s, x) => s + (x - mean) * (x - mean), 0) / pnls.length;
  const std = Math.sqrt(variance);
  const mid = Math.floor(eps.length / 2);
  const a = computeWindowMetrics(eps.slice(0, mid));
  const b = computeWindowMetrics(eps.slice(mid));
  const wrSwing = Math.abs(a.winRate - b.winRate);
  const varScore = clamp(100 - std * 4, 0, 100);
  const swingScore = clamp(100 - wrSwing * 200, 0, 100);
  return Math.round(varScore * 0.6 + swingScore * 0.4);
}

function componentScores(
  profileId: string,
  stage: RecoveryStage,
  runtime: ProfileRecoveryRuntime,
  cfg: FastProfileRecoveryConfig
): {
  breakdown: ReadinessBreakdown;
  metrics: ReturnType<typeof computeWindowMetrics>;
  stability: number;
  n: number;
} {
  const all = getProfileLearningEpisodes(profileId) || [];
  const staged = all.filter(
    (e) =>
      (e as { recoveryStageAtClose?: number }).recoveryStageAtClose === stage ||
      (e as { recoveryStageAtClose?: number }).recoveryStageAtClose == null
  );
  const prefer =
    staged.filter(
      (e) =>
        (e as { recoveryStageAtClose?: number }).recoveryStageAtClose === stage
    ).length >= 8
      ? staged.filter(
          (e) =>
            (e as { recoveryStageAtClose?: number }).recoveryStageAtClose ===
            stage
        )
      : all;
  const window = pickWindow(
    [...prefer].sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0))
  );
  const metrics = computeWindowMetrics(window);
  const n = window.length;
  const half = Math.floor(n / 2);
  const recent = computeWindowMetrics(window.slice(half));
  const prior = computeWindowMetrics(window.slice(0, Math.max(half, 1)));
  const baseline = runtime.baseline;

  const expDelta = recent.avgPnlPct - (baseline?.expectancy ?? prior.avgPnlPct);
  const wrDelta = recent.winRate - (baseline?.winRate ?? prior.winRate);
  const givebackBase = baseline?.giveback ?? prior.avgGivebackPct;
  const givebackDelta = givebackBase - recent.avgGivebackPct;

  const lossTol = stage === 0 ? 3 : stage <= 2 ? 4 : 5;
  const maxLossCap = stage === 0 ? 5 : stage <= 2 ? 6 : 7;

  const expectancyTrend = clamp(50 + expDelta * 8, 0, 100);
  const winRateTrend = clamp(50 + wrDelta * 200, 0, 100);
  const givebackImprovement = clamp(50 + givebackDelta * 4, 0, 100);
  const lossStreakControl = clamp(
    100 -
      metrics.currentLossStreak * (100 / (lossTol + 1)) -
      Math.max(0, metrics.maxLossStreak - maxLossCap) * 8,
    0,
    100
  );
  const stability = stabilityScore(window);
  const need =
    stage >= 3 ? cfg.minTradesBeforePromoteTo4 : cfg.minTradesBeforePromote;
  const sampleSufficiency = clamp(
    (runtime.tradesInStage / Math.max(need, 1)) * 100,
    0,
    100
  );

  // Stage-specific emphasis boosts
  let breakdown: ReadinessBreakdown = {
    expectancyTrend,
    winRateTrend,
    givebackImprovement,
    lossStreakControl,
    stability,
    sampleSufficiency,
  };
  if (stage === 0) {
    breakdown = {
      ...breakdown,
      lossStreakControl: clamp(breakdown.lossStreakControl * 1.05, 0, 100),
      givebackImprovement: clamp(breakdown.givebackImprovement * 1.05, 0, 100),
    };
  } else if (stage === 2) {
    breakdown = {
      ...breakdown,
      stability: clamp(breakdown.stability * 1.08, 0, 100),
    };
  }

  return { breakdown, metrics, stability, n };
}

function weightedReadiness(
  b: ReadinessBreakdown,
  w: FastRecoveryReadinessWeights
): number {
  return Math.round(
    b.expectancyTrend * w.expectancyTrend +
      b.winRateTrend * w.winRateTrend +
      b.givebackImprovement * w.givebackImprovement +
      b.lossStreakControl * w.lossStreakControl +
      b.stability * w.stability +
      b.sampleSufficiency * w.sampleSufficiency
  );
}

function evaluateGates(
  profileId: string,
  stage: RecoveryStage,
  cfg: FastProfileRecoveryConfig,
  runtime: ProfileRecoveryRuntime,
  readiness: number,
  breakdown: ReadinessBreakdown,
  metrics: ReturnType<typeof computeWindowMetrics>
): { gates: GateStatus[]; canPromote: boolean; shouldDemote: boolean; reason: string } {
  if (stage >= 4) {
    return {
      gates: [],
      canPromote: false,
      shouldDemote: false,
      reason: 'Normal operation (stage 4)',
    };
  }

  const need =
    stage >= 3 ? cfg.minTradesBeforePromoteTo4 : cfg.minTradesBeforePromote;
  const thresh = Number(cfg.promoteReadinessByStage[String(stage)] ?? 70);
  const lossTol = stage === 0 ? 3 : stage <= 2 ? 4 : 5;
  const trend = buildProfilePerformanceTrend(profileId);
  const baseline = runtime.baseline;
  const expImproved =
    baseline == null
      ? metrics.avgPnlPct >= -0.5
      : metrics.avgPnlPct >= baseline.expectancy + 0.15 || metrics.avgPnlPct >= 0;

  const gates: GateStatus[] = [
    {
      id: 'min_trades',
      label: 'Min trades in stage',
      pass: runtime.tradesInStage >= need,
      detail: `${runtime.tradesInStage}/${need}`,
    },
    {
      id: 'readiness',
      label: 'Readiness score',
      pass: readiness >= thresh,
      detail: `${readiness} / ${thresh}`,
    },
    {
      id: 'expectancy',
      label: 'Expectancy vs baseline',
      pass: expImproved,
      detail: `avg ${metrics.avgPnlPct.toFixed(2)}% vs base ${(baseline?.expectancy ?? 0).toFixed(2)}%`,
    },
    {
      id: 'streak',
      label: 'Loss streak controlled',
      pass: metrics.currentLossStreak <= lossTol && metrics.maxLossStreak <= lossTol + 2,
      detail: `cur ${metrics.currentLossStreak} max ${metrics.maxLossStreak} (tol ${lossTol})`,
    },
    {
      id: 'no_deterioration',
      label: 'No severe deterioration',
      pass: trend.label !== 'critical' && !(trend.label === 'declining' && metrics.avgPnlPct < -2),
      detail: `trend ${trend.label}`,
    },
  ];

  // Stage emphasis extra gates
  if (stage === 0) {
    gates.push({
      id: 'giveback_0',
      label: 'Giveback improving (0→1)',
      pass: breakdown.givebackImprovement >= 45,
      detail: `giveback score ${Math.round(breakdown.givebackImprovement)}`,
    });
  }
  if (stage === 1) {
    gates.push({
      id: 'expectancy_hold',
      label: 'Stable expectancy (1→2)',
      pass: breakdown.expectancyTrend >= 50 && metrics.avgPnlPct >= -0.25,
      detail: `exp trend ${Math.round(breakdown.expectancyTrend)}`,
    });
  }
  if (stage === 2) {
    gates.push({
      id: 'stability_2',
      label: 'Stability after size (2→3)',
      pass: breakdown.stability >= 55,
      detail: `stability ${Math.round(breakdown.stability)}`,
    });
  }
  if (stage === 3) {
    gates.push({
      id: 'sustained',
      label: 'Sustained near-normal (3→4)',
      pass:
        breakdown.winRateTrend >= 50 &&
        breakdown.expectancyTrend >= 55 &&
        trend.label !== 'declining' &&
        trend.label !== 'critical',
      detail: `WR trend ${Math.round(breakdown.winRateTrend)} exp ${Math.round(breakdown.expectancyTrend)}`,
    });
  }

  const sampleOk = metrics.n >= 15 || runtime.tradesInStage >= need;
  if (!sampleOk) {
    gates.push({
      id: 'sample',
      label: 'Sample sufficiency',
      pass: false,
      detail: `window n=${metrics.n} (need ≥15 or stage trades)`,
    });
  }

  const canPromote = gates.every((g) => g.pass);

  const demoteFloor = cfg.demoteReadinessMax;
  const dropFromPromote =
    runtime.readinessAtLastPromote != null &&
    readiness <= runtime.readinessAtLastPromote - 15;
  const shouldDemote =
    stage > 0 &&
    (readiness <= demoteFloor ||
      dropFromPromote ||
      metrics.currentLossStreak >= lossTol + 2 ||
      (baseline != null && metrics.avgPnlPct <= baseline.expectancy - 2) ||
      (baseline != null &&
        metrics.avgGivebackPct >= baseline.giveback + 8) ||
      trend.label === 'critical');

  let reason: string;
  if (canPromote) {
    reason = `Stage ${stage + 1} ready: win rate and giveback both improved over ${runtime.tradesInStage} trades.`;
    const failed = gates.filter((g) => !g.pass);
    if (failed.length === 0 && metrics.winRate > 0) {
      reason = `Stage ${stage + 1} ready: readiness ${readiness} over ${runtime.tradesInStage} trades.`;
    }
  } else {
    const failed = gates.filter((g) => !g.pass);
    const top = failed[0];
    reason = `Stage ${stage + 1} blocked: ${top?.label || 'gates'} — ${top?.detail || ''}`.trim();
    if (failed.some((g) => g.id === 'streak') && gates.find((g) => g.id === 'expectancy')?.pass) {
      reason = `Stage ${stage + 1} blocked: expectancy improved, but loss streak still too high.`;
    }
  }
  if (shouldDemote) {
    reason = `Demote candidate: readiness ${readiness} or streak/giveback deteriorated.`;
  }

  return { gates, canPromote, shouldDemote, reason };
}

export function getProfileRecoveryStatus(
  profileId: string
): ProfileRecoveryStatus | null {
  if (!isFastRecoveryProfileId(profileId)) return null;
  const cfg = getFastProfileRecoveryConfig();
  const p = cfg.profiles[profileId] || defaultProfileCfg();
  const stage = getProfileRecoveryStage(profileId);
  const runtime = ensureRuntime(profileId, false);
  const { breakdown, metrics } = componentScores(profileId, stage, runtime, cfg);
  const readiness = weightedReadiness(breakdown, cfg.readinessWeights);
  const { gates, canPromote, shouldDemote, reason } = evaluateGates(
    profileId,
    stage,
    cfg,
    runtime,
    readiness,
    breakdown,
    metrics
  );
  const trend = buildProfilePerformanceTrend(profileId);
  const constraints = getRecoveryConstraints(profileId);

  let plain = reason;
  if (!cfg.enabled || !p.enabled) {
    plain = `${profileId} recovery disabled`;
  } else if (stage === 0 && !canPromote) {
    plain = `${profileName(profileId)} · Stage 0 · still in full recovery`;
  } else if (!canPromote && stage < 4) {
    plain = `${profileName(profileId)} · Stage ${stage} · readiness ${readiness} · ${reason}`;
  }

  return {
    profileId,
    enabled: cfg.enabled && p.enabled !== false,
    recovering: isFastProfileRecovering(profileId),
    stage,
    stageName: RECOVERY_STAGE_NAMES[stage],
    stageLocked: p.stageLocked === true,
    autoTaper: cfg.autoTaper,
    readinessScore: readiness,
    breakdown,
    weights: cfg.readinessWeights,
    gates,
    canPromote: canPromote && cfg.autoTaper && !p.stageLocked && stage < 4,
    shouldDemote: shouldDemote && cfg.autoTaper && !p.stageLocked && stage > 0,
    plainLanguage: plain,
    tradesInStage: runtime.tradesInStage,
    windowMetrics: metrics,
    trendLabel: trend.label,
    constraints,
    lastTransitionReason: runtime.lastTransitionReason || '',
  };
}

function profileName(id: string): string {
  return id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function setStageInternal(
  profileId: FastRecoveryProfileId,
  to: RecoveryStage,
  reason: string
): void {
  const cfg = getFastProfileRecoveryConfig();
  const from = getProfileRecoveryStage(profileId);
  if (from === to) return;
  const profiles = { ...cfg.profiles };
  profiles[profileId] = {
    ...(profiles[profileId] || defaultProfileCfg()),
    stage: to,
  };
  (config as { fastProfileRecovery: FastProfileRecoveryConfig }).fastProfileRecovery =
    { ...cfg, profiles };

  const runtime = ensureRuntime(profileId, true);
  runtime.tradesInStage = 0;
  runtime.stageEnteredAt = Date.now();
  runtime.lastTransitionReason = reason;
  runtime.baseline = null;
  if (to > from) runtime.readinessAtLastPromote = null;

  const s = loadState();
  s.history.push({ at: Date.now(), profileId, from, to, reason });
  s.history = s.history.slice(-200);
  persistState();
  try {
    persistUserSettings();
  } catch {
    /* */
  }

  const dir = to > from ? 'promoted' : 'demoted';
  logger.info(
    'FastRecovery',
    `${profileName(profileId)} ${dir} Recovery Stage ${from} → ${to}: ${reason}`
  );
  try {
    const { recordAgentDecision } =
      require('./agentDecisionLog') as typeof import('./agentDecisionLog');
    recordAgentDecision({
      agent: 'FastRecovery',
      source: 'self_learn',
      decisionType: 'mode_change',
      profileId,
      summary: `${profileName(profileId)} ${dir} Recovery Stage ${from} → ${to}`,
      detail: reason,
      applied: 'applied',
      dedupeKey: `fast-recovery:${profileId}:${from}:${to}`,
    });
  } catch {
    /* optional */
  }

  if (to === 4) {
    restoreLearningSnapshot(profileId);
  } else if (from === 4 || to === 0) {
    captureLearningSnapshot(profileId);
  }
}

function captureLearningSnapshot(profileId: string): void {
  try {
    const { getProfileTaPlaybook } =
      require('./profileTaPlaybookStore') as typeof import('./profileTaPlaybookStore');
    const { getOrCreateProfileRlAgent } =
      require('./profileRlStore') as typeof import('./profileRlStore');
    const rt = ensureRuntime(profileId, false);
    const pb = getProfileTaPlaybook(profileId);
    const ag = getOrCreateProfileRlAgent(profileId);
    rt.snapshot = {
      taMode: pb?.taMode,
      rlMode: ag?.mode,
      rlLocked: ag?.modeLocked,
    };
    persistState();
  } catch {
    /* */
  }
}

function restoreLearningSnapshot(profileId: string): void {
  const rt = loadState().runtime[profileId];
  if (!rt?.snapshot) return;
  try {
    const { setProfileRlAgentMode } =
      require('./profileRlAgent') as typeof import('./profileRlAgent');
    if (rt.snapshot.rlMode) {
      setProfileRlAgentMode(
        profileId,
        rt.snapshot.rlMode as 'shadow' | 'hybrid' | 'lead',
        { modeLocked: rt.snapshot.rlLocked === true }
      );
    }
  } catch {
    /* */
  }
}

export function forceProfileRecoveryStage(
  profileId: string,
  stage: RecoveryStage,
  opts?: { lock?: boolean }
): void {
  if (!isFastRecoveryProfileId(profileId)) return;
  const cfg = getFastProfileRecoveryConfig();
  setFastProfileRecoveryConfig({
    profiles: {
      [profileId]: {
        ...cfg.profiles[profileId],
        stage,
        forcedStage: stage,
        stageLocked: opts?.lock === true,
        enabled: true,
      },
    },
  });
  setStageInternal(profileId, stage, `manual force stage ${stage}`);
}

/** Call after a recovering profile closes a trade. */
export function onFastRecoveryEpisodeClosed(
  profileId: string,
  episode: ProfileLearningEpisode
): void {
  if (!isFastRecoveryProfileId(profileId)) return;
  invalidateProfilePerformanceTrendCache(profileId);
  if (!isFastProfileRecovering(profileId) && getProfileRecoveryStage(profileId) === 4) {
    // Still track if enabled at stage 4 for re-entry? skip engine
    const cfg = getFastProfileRecoveryConfig();
    if (!cfg.enabled || cfg.profiles[profileId]?.enabled === false) return;
  }

  const stage = getProfileRecoveryStage(profileId);
  const runtime = ensureRuntime(profileId, false);
  if (isFastProfileRecovering(profileId) || stage < 4) {
    runtime.tradesInStage += 1;
    if (!runtime.baseline && runtime.tradesInStage >= 3) {
      const m = computeWindowMetrics(
        pickWindow(getProfileLearningEpisodes(profileId) || [])
      );
      runtime.baseline = {
        expectancy: m.avgPnlPct,
        winRate: m.winRate,
        giveback: m.avgGivebackPct,
        at: Date.now(),
      };
    }
    persistState();
  }

  void episode;
  maybeAutoAdjustRecoveryStage(profileId);
}

export function maybeAutoAdjustRecoveryStage(profileId: string): void {
  if (!isFastRecoveryProfileId(profileId)) return;
  const cfg = getFastProfileRecoveryConfig();
  if (!cfg.enabled || !cfg.autoTaper) return;
  const p = cfg.profiles[profileId];
  if (!p || p.enabled === false || p.stageLocked) return;
  if (p.forcedStage != null) return;

  const status = getProfileRecoveryStatus(profileId);
  if (!status) return;
  const stage = status.stage;

  if (status.shouldDemote && stage > 0) {
    setStageInternal(
      profileId,
      asStage(stage - 1),
      status.plainLanguage || 'performance deteriorated'
    );
    return;
  }
  if (status.canPromote && stage < 4) {
    const runtime = ensureRuntime(profileId, false);
    runtime.readinessAtLastPromote = status.readinessScore;
    setStageInternal(
      profileId,
      asStage(stage + 1),
      status.plainLanguage ||
        `improved expectancy over ${status.tradesInStage} trades`
    );
  }
}

export function getFastProfileRecoveryPublic(): {
  config: FastProfileRecoveryConfig;
  profiles: ProfileRecoveryStatus[];
  history: RecoveryStateFile['history'];
} {
  const config_ = getFastProfileRecoveryConfig();
  const profiles = FAST_RECOVERY_PROFILE_IDS.map(
    (id) => getProfileRecoveryStatus(id)!
  ).filter(Boolean);
  return {
    config: config_,
    profiles,
    history: loadState().history.slice(-40),
  };
}

export function formatFastRecoveryPlainLanguage(): string[] {
  try {
    const { profiles } = getFastProfileRecoveryPublic();
    return profiles
      .filter((p) => p.enabled)
      .map((p) => p.plainLanguage)
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function effectiveTaModeForRecovery(
  profileId: string,
  current: 'off' | 'soft' | 'hard'
): 'off' | 'soft' | 'hard' {
  const c = getRecoveryConstraints(profileId);
  if (!c.active) return current;
  if (profileId === 'momentum_burst') return 'soft';
  if (current === 'hard') return 'soft';
  return current;
}

export function shouldBlockProfileLead(profileId: string): boolean {
  return getRecoveryConstraints(profileId).blockLead;
}

export function shouldBlockLearningModeForProfile(
  profileId: string | null | undefined
): boolean {
  if (!isFastRecoveryProfileId(profileId)) return false;
  const cfg = getFastProfileRecoveryConfig();
  const p = cfg.profiles[profileId];
  if (p?.learningModeOverride) return false;
  return getRecoveryConstraints(profileId).blockLearningMode;
}

/** Guard: PEAK_PROTECT_FAST_PROFILES aligns with recovery targets */
export function assertFastRecoveryTargetsAligned(): boolean {
  for (const id of FAST_RECOVERY_PROFILE_IDS) {
    if (!PEAK_PROTECT_FAST_PROFILES.has(id)) return false;
  }
  return true;
}
