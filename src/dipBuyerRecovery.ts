/**
 * Dip Buyer Recovery Stages (0–4) — dip_buyer only.
 * Parallel to Fast Profiles Recovery; does not share FPR config/state.
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

export const DIP_BUYER_RECOVERY_ID = 'dip_buyer' as const;

export type DipBuyerRecoveryProfileId = typeof DIP_BUYER_RECOVERY_ID;
export type DipRecoveryStage = 0 | 1 | 2 | 3 | 4;

export const DIP_RECOVERY_STAGE_NAMES: Record<DipRecoveryStage, string> = {
  0: 'Full Recovery',
  1: 'Frequency Release',
  2: 'Size Release',
  3: 'Controlled Release',
  4: 'Normal Operation',
};

export interface DipBuyerRecoveryReadinessWeights {
  expectancyTrend: number;
  winRateTrend: number;
  givebackImprovement: number;
  bounceFollowThrough: number;
  lossStreakControl: number;
  sampleSufficiency: number;
}

export interface DipBuyerRecoveryConfig {
  enabled: boolean;
  autoTaper: boolean;
  stage: DipRecoveryStage;
  stageLocked: boolean;
  forcedStage?: DipRecoveryStage | null;
  learningModeOverride?: boolean;
  /** Mild reversible threshold tuning — default off */
  learningAdjustEnabled?: boolean;
  minTradesBeforePromote: number;
  minTradesBeforePromoteTo4: number;
  promoteReadinessByStage: Record<string, number>;
  demoteReadinessMax: number;
  readinessWeights: DipBuyerRecoveryReadinessWeights;
}

export interface DipBuyerRecoveryConstraints {
  active: boolean;
  stage: DipRecoveryStage;
  stageName: string;
  maxConcurrent: number;
  sizeMultiplier: number;
  minMsBetweenEntries: number;
  maxEntriesPerHour: number;
  minVolumeM5Usd: number;
  minVolumeH1Usd: number;
  peakProtectArmOfTpPct: number;
  peakProtectGivebackOfPeakPct: number;
  skipCollapsedVolume: boolean;
  /** Stages 0–1: required; 2–3: preferred soft gate */
  requireSupportFibConfluence: 'required' | 'preferred' | 'off';
  taModeMin: 'off' | 'soft_high' | 'hard' | 'any';
  blockLead: boolean;
  blockLearningMode: boolean;
  rlModeMax: 'shadow' | 'hybrid' | 'lead' | 'any';
  qualityWeightEpisodes: boolean;
}

interface StageRow {
  sizeMultiplier: number;
  maxConcurrent: number;
  minMsBetweenEntries: number;
  maxEntriesPerHour: number;
  minVolumeM5Usd: number;
  minVolumeH1Usd: number;
  peakProtectArmOfTpPct: number;
  peakProtectGivebackOfPeakPct: number;
  skipCollapsedVolume: boolean;
  requireSupportFibConfluence: 'required' | 'preferred' | 'off';
  taModeMin: 'off' | 'soft_high' | 'hard' | 'any';
}

/** Explicit stage table — Dip swing identity (minute gaps, no TP clamps). */
const STAGE_TABLE: Record<0 | 1 | 2 | 3, StageRow> = {
  0: {
    sizeMultiplier: 0.65,
    maxConcurrent: 1,
    minMsBetweenEntries: 15 * 60_000,
    maxEntriesPerHour: 2,
    minVolumeM5Usd: 2_500,
    minVolumeH1Usd: 12_000,
    peakProtectArmOfTpPct: 55,
    peakProtectGivebackOfPeakPct: 35,
    skipCollapsedVolume: true,
    requireSupportFibConfluence: 'required',
    taModeMin: 'hard',
  },
  1: {
    sizeMultiplier: 0.7,
    maxConcurrent: 1,
    minMsBetweenEntries: 10 * 60_000,
    maxEntriesPerHour: 3,
    minVolumeM5Usd: 4_000,
    minVolumeH1Usd: 25_000,
    peakProtectArmOfTpPct: 55,
    peakProtectGivebackOfPeakPct: 35,
    skipCollapsedVolume: true,
    requireSupportFibConfluence: 'required',
    taModeMin: 'soft_high',
  },
  2: {
    sizeMultiplier: 0.85,
    maxConcurrent: 1,
    minMsBetweenEntries: 8 * 60_000,
    maxEntriesPerHour: 4,
    minVolumeM5Usd: 4_000,
    minVolumeH1Usd: 25_000,
    peakProtectArmOfTpPct: 50,
    peakProtectGivebackOfPeakPct: 38,
    skipCollapsedVolume: true,
    requireSupportFibConfluence: 'preferred',
    taModeMin: 'soft_high',
  },
  3: {
    sizeMultiplier: 0.95,
    maxConcurrent: 2,
    minMsBetweenEntries: 6 * 60_000,
    maxEntriesPerHour: 4,
    minVolumeM5Usd: 3_000,
    minVolumeH1Usd: 20_000,
    peakProtectArmOfTpPct: 50,
    peakProtectGivebackOfPeakPct: 40,
    skipCollapsedVolume: false,
    requireSupportFibConfluence: 'preferred',
    taModeMin: 'any',
  },
};

export interface StageBaseline {
  expectancy: number;
  winRate: number;
  giveback: number;
  bounce: number;
  at: number;
}

export interface DipBuyerRecoveryRuntime {
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

interface DipBuyerRecoveryStateFile {
  version: 1;
  runtime: DipBuyerRecoveryRuntime | null;
  lastEntryAt: number;
  /** Rolling entry timestamps for max/hr gate */
  recentEntryAts: number[];
  history: Array<{
    at: number;
    from: DipRecoveryStage;
    to: DipRecoveryStage;
    reason: string;
  }>;
}

export interface GateStatus {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

export interface DipBuyerReadinessBreakdown {
  expectancyTrend: number;
  winRateTrend: number;
  givebackImprovement: number;
  bounceFollowThrough: number;
  lossStreakControl: number;
  sampleSufficiency: number;
}

export interface DipBuyerRecoveryStatus {
  profileId: string;
  enabled: boolean;
  recovering: boolean;
  stage: DipRecoveryStage;
  stageName: string;
  stageLocked: boolean;
  autoTaper: boolean;
  readinessScore: number;
  breakdown: DipBuyerReadinessBreakdown;
  weights: DipBuyerRecoveryReadinessWeights;
  gates: GateStatus[];
  canPromote: boolean;
  shouldDemote: boolean;
  plainLanguage: string;
  tradesInStage: number;
  windowMetrics: ReturnType<typeof computeWindowMetrics>;
  trendLabel: string;
  constraints: DipBuyerRecoveryConstraints;
  lastTransitionReason: string;
  learningModeOverride: boolean;
  lastSkipReason: string | null;
  lastSkipAt: number | null;
}

const FILE = () => dataFile('dip-buyer-recovery-state.json');

export const DEFAULT_DIP_BUYER_RECOVERY: DipBuyerRecoveryConfig = {
  enabled: true,
  autoTaper: true,
  stage: 0,
  stageLocked: false,
  forcedStage: null,
  learningModeOverride: false,
  learningAdjustEnabled: false,
  minTradesBeforePromote: 12,
  minTradesBeforePromoteTo4: 20,
  promoteReadinessByStage: { '0': 65, '1': 70, '2': 72, '3': 78 },
  demoteReadinessMax: 40,
  readinessWeights: {
    expectancyTrend: 0.25,
    winRateTrend: 0.15,
    givebackImprovement: 0.2,
    bounceFollowThrough: 0.2,
    lossStreakControl: 0.1,
    sampleSufficiency: 0.1,
  },
};

let stateCache: DipBuyerRecoveryStateFile | null = null;
let lastEntryAt = 0;
let recentEntryAts: number[] = [];
/** Last hard gate skip (session) — for DBR card / Entries hint. */
let lastSkipReason: string | null = null;
let lastSkipAt: number | null = null;

/** Drop in-memory DBR state so the next load reads DATA_DIR (e.g. after site restore). */
export function invalidateDipBuyerRecoveryCache(): void {
  stateCache = null;
  lastEntryAt = 0;
  recentEntryAts = [];
  lastSkipReason = null;
  lastSkipAt = null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function asStage(n: unknown): DipRecoveryStage {
  const v = Math.round(Number(n));
  if (v <= 0) return 0;
  if (v >= 4) return 4;
  return v as DipRecoveryStage;
}

export function isDipBuyerRecoveryProfileId(
  id: string | null | undefined
): id is DipBuyerRecoveryProfileId {
  return String(id || '') === DIP_BUYER_RECOVERY_ID;
}

function emptyState(): DipBuyerRecoveryStateFile {
  return {
    version: 1,
    runtime: null,
    lastEntryAt: 0,
    recentEntryAts: [],
    history: [],
  };
}

function loadState(): DipBuyerRecoveryStateFile {
  if (stateCache) return stateCache;
  try {
    ensureDataDir();
    if (!fs.existsSync(FILE())) {
      stateCache = emptyState();
      return stateCache;
    }
    const raw = JSON.parse(
      fs.readFileSync(FILE(), 'utf8')
    ) as DipBuyerRecoveryStateFile;
    stateCache = {
      version: 1,
      runtime:
        raw?.runtime && typeof raw.runtime === 'object' ? raw.runtime : null,
      lastEntryAt: Number(raw?.lastEntryAt) || 0,
      recentEntryAts: Array.isArray(raw?.recentEntryAts)
        ? raw.recentEntryAts.map(Number).filter((n) => Number.isFinite(n))
        : [],
      history: Array.isArray(raw?.history) ? raw.history.slice(-200) : [],
    };
    lastEntryAt = stateCache.lastEntryAt;
    recentEntryAts = [...stateCache.recentEntryAts];
  } catch (err) {
    logger.warn('DipBuyerRecovery', 'state load failed', errorToMeta(err));
    stateCache = emptyState();
  }
  return stateCache;
}

function persistState(): void {
  try {
    ensureDataDir();
    const s = loadState();
    s.lastEntryAt = lastEntryAt;
    s.recentEntryAts = recentEntryAts.slice(-40);
    atomicWriteJson(FILE(), s);
  } catch (err) {
    logger.warn('DipBuyerRecovery', 'state persist failed', errorToMeta(err));
  }
}

export function getDipBuyerRecoveryConfig(): DipBuyerRecoveryConfig {
  const raw = (config as { dipBuyerRecovery?: Partial<DipBuyerRecoveryConfig> })
    .dipBuyerRecovery;
  const d = DEFAULT_DIP_BUYER_RECOVERY;
  const w = raw?.readinessWeights || d.readinessWeights;
  const sum =
    Number(w.expectancyTrend) +
    Number(w.winRateTrend) +
    Number(w.givebackImprovement) +
    Number(w.bounceFollowThrough) +
    Number(w.lossStreakControl) +
    Number(w.sampleSufficiency);
  const norm = sum > 0.01 ? sum : 1;
  const forced =
    raw?.forcedStage != null && Number.isFinite(Number(raw.forcedStage))
      ? asStage(raw.forcedStage)
      : null;
  return {
    enabled: raw?.enabled !== false,
    autoTaper: raw?.autoTaper !== false,
    stage: asStage(forced != null ? forced : raw?.stage ?? d.stage),
    stageLocked: raw?.stageLocked === true,
    forcedStage: forced,
    learningModeOverride: raw?.learningModeOverride === true,
    learningAdjustEnabled: raw?.learningAdjustEnabled === true,
    minTradesBeforePromote: clamp(
      Number(raw?.minTradesBeforePromote ?? d.minTradesBeforePromote) || 12,
      6,
      40
    ),
    minTradesBeforePromoteTo4: clamp(
      Number(raw?.minTradesBeforePromoteTo4 ?? d.minTradesBeforePromoteTo4) ||
        20,
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
      bounceFollowThrough: Number(w.bounceFollowThrough) / norm,
      lossStreakControl: Number(w.lossStreakControl) / norm,
      sampleSufficiency: Number(w.sampleSufficiency) / norm,
    },
  };
}

export function setDipBuyerRecoveryConfig(
  patch: Partial<DipBuyerRecoveryConfig>
): DipBuyerRecoveryConfig {
  const cur = getDipBuyerRecoveryConfig();
  const wasOff = !cur.enabled;
  let stage = asStage(patch.stage != null ? patch.stage : cur.stage);
  if (patch.forcedStage != null) stage = asStage(patch.forcedStage);
  const enabled =
    typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled;
  const turningOn = enabled && wasOff;
  // Re-enable keeps persisted stage (already in `stage` from cur). Do not force 0.
  // First-ever enable uses DEFAULT stage 0 via getDipBuyerRecoveryConfig.

  const next: DipBuyerRecoveryConfig = {
    enabled,
    autoTaper:
      typeof patch.autoTaper === 'boolean' ? patch.autoTaper : cur.autoTaper,
    stage,
    stageLocked:
      typeof patch.stageLocked === 'boolean'
        ? patch.stageLocked
        : cur.stageLocked,
    forcedStage:
      patch.forcedStage !== undefined
        ? patch.forcedStage == null
          ? null
          : asStage(patch.forcedStage)
        : cur.forcedStage ?? null,
    learningModeOverride:
      typeof patch.learningModeOverride === 'boolean'
        ? patch.learningModeOverride
        : cur.learningModeOverride === true,
    learningAdjustEnabled:
      typeof patch.learningAdjustEnabled === 'boolean'
        ? patch.learningAdjustEnabled
        : cur.learningAdjustEnabled === true,
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

  if (turningOn || (patch.stage != null && patch.stage !== cur.stage)) {
    ensureRuntime(true);
  }
  if (turningOn) {
    logger.info(
      'DipBuyerRecovery',
      `Dip Buyer Recovery ON — stage ${stage} (persisted)`
    );
  }

  (config as { dipBuyerRecovery: DipBuyerRecoveryConfig }).dipBuyerRecovery =
    next;
  try {
    persistUserSettings();
  } catch {
    /* */
  }
  persistState();
  return getDipBuyerRecoveryConfig();
}

function ensureRuntime(resetStage = false): DipBuyerRecoveryRuntime {
  const s = loadState();
  if (!s.runtime || resetStage) {
    s.runtime = {
      stageEnteredAt: Date.now(),
      tradesInStage: 0,
      baseline: null,
      readinessAtLastPromote: null,
      lastTransitionReason: resetStage ? 'entered stage' : 'init',
    };
    persistState();
  }
  return s.runtime!;
}

export function getDipBuyerRecoveryStage(
  profileId?: string | null
): DipRecoveryStage {
  if (profileId != null && !isDipBuyerRecoveryProfileId(profileId)) return 4;
  const cfg = getDipBuyerRecoveryConfig();
  if (!cfg.enabled) return 4;
  if (cfg.forcedStage != null) return asStage(cfg.forcedStage);
  return asStage(cfg.stage);
}

export function isDipBuyerRecovering(
  profileId?: string | null
): boolean {
  if (profileId != null && !isDipBuyerRecoveryProfileId(profileId)) return false;
  const cfg = getDipBuyerRecoveryConfig();
  if (!cfg.enabled) return false;
  return getDipBuyerRecoveryStage(DIP_BUYER_RECOVERY_ID) < 4;
}

export function getDipBuyerRecoveryConstraints(
  profileId?: string | null
): DipBuyerRecoveryConstraints {
  const stage = getDipBuyerRecoveryStage(profileId ?? DIP_BUYER_RECOVERY_ID);
  const active = isDipBuyerRecovering(profileId ?? DIP_BUYER_RECOVERY_ID);
  const name = DIP_RECOVERY_STAGE_NAMES[stage];

  if (!active || stage >= 4) {
    return {
      active: false,
      stage: 4,
      stageName: DIP_RECOVERY_STAGE_NAMES[4],
      maxConcurrent: 99,
      sizeMultiplier: 1,
      minMsBetweenEntries: 0,
      maxEntriesPerHour: 0,
      minVolumeM5Usd: 0,
      minVolumeH1Usd: 0,
      peakProtectArmOfTpPct: 0,
      peakProtectGivebackOfPeakPct: 0,
      skipCollapsedVolume: false,
      requireSupportFibConfluence: 'off',
      taModeMin: 'any',
      blockLead: false,
      blockLearningMode: false,
      rlModeMax: 'any',
      qualityWeightEpisodes: false,
    };
  }

  const row = STAGE_TABLE[stage as 0 | 1 | 2 | 3];
  return {
    active: true,
    stage,
    stageName: name,
    maxConcurrent: row.maxConcurrent,
    sizeMultiplier: row.sizeMultiplier,
    minMsBetweenEntries: row.minMsBetweenEntries,
    maxEntriesPerHour: row.maxEntriesPerHour,
    minVolumeM5Usd: row.minVolumeM5Usd,
    minVolumeH1Usd: row.minVolumeH1Usd,
    peakProtectArmOfTpPct: row.peakProtectArmOfTpPct,
    peakProtectGivebackOfPeakPct: row.peakProtectGivebackOfPeakPct,
    skipCollapsedVolume: row.skipCollapsedVolume || stage <= 2,
    requireSupportFibConfluence: row.requireSupportFibConfluence,
    taModeMin: row.taModeMin,
    blockLead: true,
    blockLearningMode: true,
    rlModeMax: 'hybrid',
    qualityWeightEpisodes: true,
  };
}

export function noteDipBuyerRecoveryEntry(profileId?: string | null): void {
  if (profileId != null && !isDipBuyerRecoveryProfileId(profileId)) return;
  if (!isDipBuyerRecovering(DIP_BUYER_RECOVERY_ID) && !getDipBuyerRecoveryConfig().enabled) {
    return;
  }
  const now = Date.now();
  lastEntryAt = now;
  recentEntryAts = [...recentEntryAts.filter((t) => now - t < 3_600_000), now];
  persistState();
}

export function getLastDipBuyerRecoveryEntryAt(): number {
  loadState();
  return Number(lastEntryAt || 0);
}

function countEntriesLastHour(): number {
  loadState();
  const now = Date.now();
  recentEntryAts = recentEntryAts.filter((t) => now - t < 3_600_000);
  return recentEntryAts.length;
}

function noteDipBuyerRecoverySkip(reason: string): { ok: false; reason: string } {
  lastSkipReason = reason;
  lastSkipAt = Date.now();
  return { ok: false, reason };
}

export function getLastDipBuyerRecoverySkip(): {
  reason: string | null;
  at: number | null;
} {
  return { reason: lastSkipReason, at: lastSkipAt };
}

export function checkDipBuyerRecoveryEntryGates(input: {
  profileId?: string | null;
  openPositions: Array<{ tradeProfileId?: string | null }>;
  volumeM5Usd?: number | null;
  volumeH1Usd?: number | null;
  recentVolumeUsd?: number | null;
  volumeDecayState?: string | null;
  nearSupport?: boolean | null;
  nearFib?: boolean | null;
}): { ok: boolean; reason?: string } {
  if (
    input.profileId != null &&
    !isDipBuyerRecoveryProfileId(input.profileId)
  ) {
    return { ok: true };
  }
  const c = getDipBuyerRecoveryConstraints(DIP_BUYER_RECOVERY_ID);
  if (!c.active) return { ok: true };

  const openCount = input.openPositions.filter(
    (p) => p.tradeProfileId === DIP_BUYER_RECOVERY_ID
  ).length;
  if (openCount >= c.maxConcurrent) {
    return noteDipBuyerRecoverySkip(
      `Dip Buyer Recovery Stage ${c.stage}: max ${c.maxConcurrent} open`
    );
  }

  const last = getLastDipBuyerRecoveryEntryAt();
  if (last > 0 && Date.now() - last < c.minMsBetweenEntries) {
    const waitSec = Math.ceil(
      (c.minMsBetweenEntries - (Date.now() - last)) / 1000
    );
    return noteDipBuyerRecoverySkip(
      `Dip Buyer Recovery Stage ${c.stage}: cooldown ${waitSec}s remaining`
    );
  }

  if (c.maxEntriesPerHour > 0) {
    const n = countEntriesLastHour();
    if (n >= c.maxEntriesPerHour) {
      return noteDipBuyerRecoverySkip(
        `Dip Buyer Recovery Stage ${c.stage}: max ${c.maxEntriesPerHour}/hr (${n} in last hour)`
      );
    }
  }

  const volM5 = Number(input.volumeM5Usd ?? input.recentVolumeUsd ?? 0);
  if (c.minVolumeM5Usd > 0 && volM5 > 0 && volM5 < c.minVolumeM5Usd) {
    return noteDipBuyerRecoverySkip(
      `Dip Buyer Recovery Stage ${c.stage}: 5m volume $${Math.round(volM5)} < $${c.minVolumeM5Usd}`
    );
  }
  const volH1 = Number(input.volumeH1Usd ?? 0);
  if (c.minVolumeH1Usd > 0 && volH1 > 0 && volH1 < c.minVolumeH1Usd) {
    return noteDipBuyerRecoverySkip(
      `Dip Buyer Recovery Stage ${c.stage}: 1h volume $${Math.round(volH1)} < $${c.minVolumeH1Usd}`
    );
  }
  if (
    (input.recentVolumeUsd != null && Number(input.recentVolumeUsd) <= 0) ||
    (input.volumeM5Usd != null && Number(input.volumeM5Usd) <= 0)
  ) {
    return noteDipBuyerRecoverySkip(
      `Dip Buyer Recovery Stage ${c.stage}: near-zero volume skip`
    );
  }

  if (
    c.skipCollapsedVolume &&
    (input.volumeDecayState === 'collapsed' ||
      input.volumeDecayState === 'ultra_thin')
  ) {
    return noteDipBuyerRecoverySkip(
      `Dip Buyer Recovery Stage ${c.stage}: skip collapsed/ultra-thin volume`
    );
  }

  if (c.requireSupportFibConfluence === 'required') {
    const supportOk = input.nearSupport === true;
    const fibOk = input.nearFib === true;
    if (input.nearSupport != null || input.nearFib != null) {
      if (!supportOk || !fibOk) {
        return noteDipBuyerRecoverySkip(
          `Dip Buyer Recovery Stage ${c.stage}: need support + Fib confluence`
        );
      }
    }
  }

  return { ok: true };
}

export function applyDipBuyerRecoverySizeMultiplier(
  profileId: string | null | undefined,
  sizeSol: number
): number {
  if (!isDipBuyerRecoveryProfileId(profileId)) return sizeSol;
  const c = getDipBuyerRecoveryConstraints(profileId);
  if (!c.active) return sizeSol;
  return Math.max(0.001, sizeSol * c.sizeMultiplier);
}

function pickWindow(eps: ProfileLearningEpisode[]): ProfileLearningEpisode[] {
  if (eps.length >= 40) return eps.slice(-40);
  if (eps.length >= 25) return eps.slice(-25);
  return eps.slice(-Math.max(eps.length, 0));
}

/**
 * Bounce follow-through from episode MFE / entryQuality / exitTiming / giveback.
 * Healthy bounce: meaningful MFE with decent exit capture and non-knife exit.
 */
function bounceFollowThroughScore(eps: ProfileLearningEpisode[]): number {
  if (eps.length < 4) return 40;
  let sum = 0;
  let n = 0;
  for (const e of eps) {
    const mfe = Number(e.maxRunupPct) || 0;
    const giveback = Number(e.givebackFromPeakPct) || 0;
    const entryQ =
      e.entryQualityScore != null && Number.isFinite(Number(e.entryQualityScore))
        ? Number(e.entryQualityScore)
        : null;
    const exitQ =
      e.exitQualityScore != null && Number.isFinite(Number(e.exitQualityScore))
        ? Number(e.exitQualityScore)
        : null;
    const pnl = Number(e.pnlPct) || 0;

    // Capture ratio proxy: how much of MFE was kept
    const capture =
      mfe > 1 ? clamp(100 - (giveback / Math.max(mfe, 1)) * 100, 0, 100) : pnl > 0 ? 55 : 30;
    // Failed reclaim / knife: deep MAE with little MFE
    const mae = Number(e.maxDrawdownPct) || 0;
    const knifePen = mfe < 3 && mae >= 8 ? 25 : mfe < 5 && giveback > 20 ? 15 : 0;

    let score =
      clamp(mfe * 3, 0, 40) +
      capture * 0.35 +
      (entryQ != null ? entryQ * 0.15 : 8) +
      (exitQ != null ? exitQ * 0.15 : 8) -
      knifePen;
    if (pnl > 0 && mfe >= 8 && giveback <= 25) score += 8;
    if (pnl < 0 && mfe < 4) score -= 10;
    sum += clamp(score, 0, 100);
    n += 1;
  }
  return Math.round(sum / Math.max(n, 1));
}

function componentScores(
  stage: DipRecoveryStage,
  runtime: DipBuyerRecoveryRuntime,
  cfg: DipBuyerRecoveryConfig
): {
  breakdown: DipBuyerReadinessBreakdown;
  metrics: ReturnType<typeof computeWindowMetrics>;
  n: number;
} {
  const all = getProfileLearningEpisodes(DIP_BUYER_RECOVERY_ID) || [];
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
  const bounceFollowThrough = bounceFollowThroughScore(window);
  const lossStreakControl = clamp(
    100 -
      metrics.currentLossStreak * (100 / (lossTol + 1)) -
      Math.max(0, metrics.maxLossStreak - maxLossCap) * 8,
    0,
    100
  );
  const need =
    stage >= 3 ? cfg.minTradesBeforePromoteTo4 : cfg.minTradesBeforePromote;
  const sampleSufficiency = clamp(
    (runtime.tradesInStage / Math.max(need, 1)) * 100,
    0,
    100
  );

  let breakdown: DipBuyerReadinessBreakdown = {
    expectancyTrend,
    winRateTrend,
    givebackImprovement,
    bounceFollowThrough,
    lossStreakControl,
    sampleSufficiency,
  };
  if (stage === 0) {
    breakdown = {
      ...breakdown,
      bounceFollowThrough: clamp(breakdown.bounceFollowThrough * 1.05, 0, 100),
      givebackImprovement: clamp(breakdown.givebackImprovement * 1.05, 0, 100),
    };
  } else if (stage === 2) {
    breakdown = {
      ...breakdown,
      expectancyTrend: clamp(breakdown.expectancyTrend * 1.05, 0, 100),
    };
  }

  return { breakdown, metrics, n };
}

function weightedReadiness(
  b: DipBuyerReadinessBreakdown,
  w: DipBuyerRecoveryReadinessWeights
): number {
  return Math.round(
    b.expectancyTrend * w.expectancyTrend +
      b.winRateTrend * w.winRateTrend +
      b.givebackImprovement * w.givebackImprovement +
      b.bounceFollowThrough * w.bounceFollowThrough +
      b.lossStreakControl * w.lossStreakControl +
      b.sampleSufficiency * w.sampleSufficiency
  );
}

function evaluateGates(
  stage: DipRecoveryStage,
  cfg: DipBuyerRecoveryConfig,
  runtime: DipBuyerRecoveryRuntime,
  readiness: number,
  breakdown: DipBuyerReadinessBreakdown,
  metrics: ReturnType<typeof computeWindowMetrics>
): {
  gates: GateStatus[];
  canPromote: boolean;
  shouldDemote: boolean;
  reason: string;
} {
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
  let thresh = Number(cfg.promoteReadinessByStage[String(stage)] ?? 70);
  if (cfg.learningAdjustEnabled) {
    // Mild reversible: ±2 only when sample rich
    if (runtime.tradesInStage >= need + 4) thresh = Math.max(60, thresh - 2);
  }
  const lossTol = stage === 0 ? 3 : stage <= 2 ? 4 : 5;
  const trend = buildProfilePerformanceTrend(DIP_BUYER_RECOVERY_ID);
  const baseline = runtime.baseline;
  const expImproved =
    baseline == null
      ? metrics.avgPnlPct >= -0.5
      : metrics.avgPnlPct >= baseline.expectancy + 0.15 ||
        metrics.avgPnlPct >= 0;

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
      pass:
        metrics.currentLossStreak <= lossTol &&
        metrics.maxLossStreak <= lossTol + 2,
      detail: `cur ${metrics.currentLossStreak} max ${metrics.maxLossStreak} (tol ${lossTol})`,
    },
    {
      id: 'no_deterioration',
      label: 'No severe deterioration',
      pass:
        trend.label !== 'critical' &&
        !(trend.label === 'declining' && metrics.avgPnlPct < -2),
      detail: `trend ${trend.label}`,
    },
  ];

  if (stage === 0) {
    gates.push({
      id: 'bounce_0',
      label: 'Bounce follow-through (0→1)',
      pass: breakdown.bounceFollowThrough >= 45,
      detail: `bounce score ${Math.round(breakdown.bounceFollowThrough)}`,
    });
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
      id: 'bounce_2',
      label: 'Bounce holds after size (2→3)',
      pass: breakdown.bounceFollowThrough >= 55,
      detail: `bounce ${Math.round(breakdown.bounceFollowThrough)}`,
    });
  }
  if (stage === 3) {
    gates.push({
      id: 'sustained',
      label: 'Sustained near-normal (3→4)',
      pass:
        breakdown.winRateTrend >= 50 &&
        breakdown.expectancyTrend >= 55 &&
        breakdown.bounceFollowThrough >= 55 &&
        trend.label !== 'declining' &&
        trend.label !== 'critical',
      detail: `WR ${Math.round(breakdown.winRateTrend)} exp ${Math.round(breakdown.expectancyTrend)} bounce ${Math.round(breakdown.bounceFollowThrough)}`,
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
    reason = `Stage ${stage + 1} ready: readiness ${readiness} over ${runtime.tradesInStage} trades.`;
  } else {
    const failed = gates.filter((g) => !g.pass);
    const top = failed[0];
    reason =
      `Stage ${stage + 1} blocked: ${top?.label || 'gates'} — ${top?.detail || ''}`.trim();
    if (
      failed.some((g) => g.id === 'bounce_0' || g.id === 'bounce_2') &&
      gates.find((g) => g.id === 'expectancy')?.pass
    ) {
      reason = `Stage ${stage + 1} blocked: waiting on better bounce follow-through.`;
    }
  }
  if (shouldDemote) {
    reason = `Demote candidate: readiness ${readiness} or streak/giveback deteriorated.`;
  }

  return { gates, canPromote, shouldDemote, reason };
}

export function getDipBuyerRecoveryStatus(): DipBuyerRecoveryStatus {
  const cfg = getDipBuyerRecoveryConfig();
  const stage = getDipBuyerRecoveryStage(DIP_BUYER_RECOVERY_ID);
  const runtime = ensureRuntime(false);
  const { breakdown, metrics } = componentScores(stage, runtime, cfg);
  const readiness = weightedReadiness(breakdown, cfg.readinessWeights);
  const { gates, canPromote, shouldDemote, reason } = evaluateGates(
    stage,
    cfg,
    runtime,
    readiness,
    breakdown,
    metrics
  );
  const trend = buildProfilePerformanceTrend(DIP_BUYER_RECOVERY_ID);
  const constraints = getDipBuyerRecoveryConstraints(DIP_BUYER_RECOVERY_ID);

  let plain = reason;
  if (!cfg.enabled) {
    plain = 'Dip Buyer recovery disabled';
  } else if (stage === 0 && !canPromote) {
    plain = `Dip Buyer Stage 0 · readiness ${readiness} · still in full recovery`;
  } else if (!canPromote && stage < 4) {
    plain = `Dip Buyer Stage ${stage} · readiness ${readiness} · ${reason}`;
  } else if (stage < 4) {
    plain = `Dip Buyer Stage ${stage} · readiness ${readiness} · ${DIP_RECOVERY_STAGE_NAMES[stage]}`;
  } else {
    plain = 'Dip Buyer Stage 4 · Normal Operation';
  }

  return {
    profileId: DIP_BUYER_RECOVERY_ID,
    enabled: cfg.enabled,
    recovering: isDipBuyerRecovering(DIP_BUYER_RECOVERY_ID),
    stage,
    stageName: DIP_RECOVERY_STAGE_NAMES[stage],
    stageLocked: cfg.stageLocked === true,
    autoTaper: cfg.autoTaper,
    readinessScore: readiness,
    breakdown,
    weights: cfg.readinessWeights,
    gates,
    canPromote: canPromote && cfg.autoTaper && !cfg.stageLocked && stage < 4,
    shouldDemote:
      shouldDemote && cfg.autoTaper && !cfg.stageLocked && stage > 0,
    plainLanguage: plain,
    tradesInStage: runtime.tradesInStage,
    windowMetrics: metrics,
    trendLabel: trend.label,
    constraints,
    lastTransitionReason: runtime.lastTransitionReason || '',
    learningModeOverride: cfg.learningModeOverride === true,
    lastSkipReason,
    lastSkipAt,
  };
}

function setStageInternal(to: DipRecoveryStage, reason: string): void {
  const cfg = getDipBuyerRecoveryConfig();
  const from = getDipBuyerRecoveryStage(DIP_BUYER_RECOVERY_ID);
  if (from === to) return;
  // Never skip stages on auto path; manual force may jump
  (config as { dipBuyerRecovery: DipBuyerRecoveryConfig }).dipBuyerRecovery = {
    ...cfg,
    stage: to,
  };

  const runtime = ensureRuntime(true);
  runtime.tradesInStage = 0;
  runtime.stageEnteredAt = Date.now();
  runtime.lastTransitionReason = reason;
  runtime.baseline = null;
  if (to > from) runtime.readinessAtLastPromote = null;

  const s = loadState();
  s.history.push({ at: Date.now(), from, to, reason });
  s.history = s.history.slice(-200);
  persistState();
  try {
    persistUserSettings();
  } catch {
    /* */
  }

  const dir = to > from ? 'promoted' : 'demoted';
  logger.info(
    'DipBuyerRecovery',
    `Dip Buyer ${dir} Recovery Stage ${from} → ${to}: ${reason}`
  );
  try {
    const { recordAgentDecision } =
      require('./agentDecisionLog') as typeof import('./agentDecisionLog');
    recordAgentDecision({
      agent: 'DipBuyerRecovery',
      source: 'self_learn',
      decisionType: 'mode_change',
      profileId: DIP_BUYER_RECOVERY_ID,
      summary: `Dip Buyer ${dir} Recovery Stage ${from} → ${to}`,
      detail: reason,
      applied: 'applied',
      dedupeKey: `dip-buyer-recovery:${from}:${to}`,
    });
  } catch {
    /* optional */
  }

  if (to === 4) {
    restoreLearningSnapshot();
  } else if (from === 4 || to === 0) {
    captureLearningSnapshot();
  }
}

function captureLearningSnapshot(): void {
  try {
    const { getProfileTaPlaybook } =
      require('./profileTaPlaybookStore') as typeof import('./profileTaPlaybookStore');
    const { getOrCreateProfileRlAgent } =
      require('./profileRlStore') as typeof import('./profileRlStore');
    const rt = ensureRuntime(false);
    const pb = getProfileTaPlaybook(DIP_BUYER_RECOVERY_ID);
    const ag = getOrCreateProfileRlAgent(DIP_BUYER_RECOVERY_ID);
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

function restoreLearningSnapshot(): void {
  const rt = loadState().runtime;
  if (!rt?.snapshot) return;
  try {
    const { setProfileRlAgentMode } =
      require('./profileRlAgent') as typeof import('./profileRlAgent');
    if (rt.snapshot.rlMode) {
      setProfileRlAgentMode(
        DIP_BUYER_RECOVERY_ID,
        rt.snapshot.rlMode as 'shadow' | 'hybrid' | 'lead',
        { modeLocked: rt.snapshot.rlLocked === true }
      );
    }
  } catch {
    /* */
  }
}

export function forceDipBuyerRecoveryStage(
  stage: DipRecoveryStage,
  opts?: { lock?: boolean }
): void {
  setDipBuyerRecoveryConfig({
    stage,
    forcedStage: stage,
    stageLocked: opts?.lock === true,
    enabled: true,
  });
  setStageInternal(stage, `manual force stage ${stage}`);
}

export function promoteDipBuyerRecoveryStage(): DipRecoveryStage {
  const from = getDipBuyerRecoveryStage(DIP_BUYER_RECOVERY_ID);
  if (from >= 4) return from;
  const to = asStage(from + 1);
  forceDipBuyerRecoveryStage(to);
  return to;
}

export function demoteDipBuyerRecoveryStage(): DipRecoveryStage {
  const from = getDipBuyerRecoveryStage(DIP_BUYER_RECOVERY_ID);
  if (from <= 0) return from;
  const to = asStage(from - 1);
  forceDipBuyerRecoveryStage(to);
  return to;
}

/** Call after dip_buyer closes a trade — stamp-aware evaluate. */
export function evaluateDipBuyerRecoveryTransition(
  profileId: string,
  episode?: ProfileLearningEpisode
): void {
  if (!isDipBuyerRecoveryProfileId(profileId)) return;
  invalidateProfilePerformanceTrendCache(profileId);
  const cfg = getDipBuyerRecoveryConfig();
  if (!cfg.enabled) return;

  const stage = getDipBuyerRecoveryStage(profileId);
  const runtime = ensureRuntime(false);
  if (isDipBuyerRecovering(profileId) || stage < 4) {
    runtime.tradesInStage += 1;
    if (!runtime.baseline && runtime.tradesInStage >= 3) {
      const m = computeWindowMetrics(
        pickWindow(getProfileLearningEpisodes(profileId) || [])
      );
      runtime.baseline = {
        expectancy: m.avgPnlPct,
        winRate: m.winRate,
        giveback: m.avgGivebackPct,
        bounce: bounceFollowThroughScore(
          pickWindow(getProfileLearningEpisodes(profileId) || [])
        ),
        at: Date.now(),
      };
    }
    persistState();
  }

  void episode;
  maybeAutoAdjustDipBuyerRecoveryStage();
}

export function maybeAutoAdjustDipBuyerRecoveryStage(): void {
  const cfg = getDipBuyerRecoveryConfig();
  if (!cfg.enabled || !cfg.autoTaper) return;
  if (cfg.stageLocked) return;
  if (cfg.forcedStage != null) return;

  const status = getDipBuyerRecoveryStatus();
  const stage = status.stage;

  if (status.shouldDemote && stage > 0) {
    setStageInternal(
      asStage(stage - 1),
      status.plainLanguage || 'performance deteriorated'
    );
    return;
  }
  if (status.canPromote && stage < 4) {
    const runtime = ensureRuntime(false);
    runtime.readinessAtLastPromote = status.readinessScore;
    setStageInternal(
      asStage(stage + 1),
      status.plainLanguage ||
        `improved expectancy over ${status.tradesInStage} trades`
    );
  }
}

export function getDipBuyerRecoveryPublic(): {
  config: DipBuyerRecoveryConfig;
  status: DipBuyerRecoveryStatus;
  history: DipBuyerRecoveryStateFile['history'];
} {
  return {
    config: getDipBuyerRecoveryConfig(),
    status: getDipBuyerRecoveryStatus(),
    history: loadState().history.slice(-40),
  };
}

export function getDipBuyerRecoveryUiHints(): {
  enabled: boolean;
  stage: DipRecoveryStage;
  stageName: string;
  inRecovery: boolean;
  lastSkipReason: string | null;
  lastSkipAt: number | null;
} {
  const cfg = getDipBuyerRecoveryConfig();
  const st = getDipBuyerRecoveryStatus();
  const stage = st.stage;
  const inRecovery = cfg.enabled === true && stage >= 0 && stage <= 3;
  return {
    enabled: cfg.enabled === true,
    stage,
    stageName: st.stageName || DIP_RECOVERY_STAGE_NAMES[stage],
    inRecovery,
    lastSkipReason: st.lastSkipReason,
    lastSkipAt: st.lastSkipAt,
  };
}

export function formatDipBuyerRecoveryPlainLanguage(): string {
  try {
    return getDipBuyerRecoveryStatus().plainLanguage || '';
  } catch {
    return '';
  }
}

/** Raise TA mode floor while recovering — never forces scalper TF/tools. */
export function effectiveTaModeForDipBuyerRecovery(
  profileId: string,
  current: 'off' | 'soft' | 'hard'
): 'off' | 'soft' | 'hard' {
  if (!isDipBuyerRecoveryProfileId(profileId)) return current;
  const c = getDipBuyerRecoveryConstraints(profileId);
  if (!c.active) return current;
  if (c.taModeMin === 'hard') return current === 'off' ? 'hard' : current === 'soft' ? 'hard' : current;
  if (c.taModeMin === 'soft_high') {
    if (current === 'off') return 'soft';
    return current;
  }
  return current;
}

/** Soft raise confluence floor for soft_high stages. */
export function dipBuyerRecoveryConfluenceBump(
  profileId: string | null | undefined
): number {
  if (!isDipBuyerRecoveryProfileId(profileId)) return 0;
  const c = getDipBuyerRecoveryConstraints(profileId);
  if (!c.active) return 0;
  if (c.taModeMin === 'hard') return 8;
  if (c.taModeMin === 'soft_high') return 5;
  if (c.requireSupportFibConfluence === 'preferred') return 3;
  return 0;
}

export function shouldBlockDipBuyerLead(
  profileId: string | null | undefined
): boolean {
  if (!isDipBuyerRecoveryProfileId(profileId)) return false;
  return getDipBuyerRecoveryConstraints(profileId).blockLead;
}

export function shouldBlockLearningModeForDipBuyer(
  profileId?: string | null
): boolean {
  if (profileId != null && !isDipBuyerRecoveryProfileId(profileId)) return false;
  const cfg = getDipBuyerRecoveryConfig();
  if (cfg.learningModeOverride) return false;
  return getDipBuyerRecoveryConstraints(DIP_BUYER_RECOVERY_ID).blockLearningMode;
}

export function shouldQualityWeightDipBuyerEpisodes(
  profileId?: string | null
): boolean {
  if (profileId != null && !isDipBuyerRecoveryProfileId(profileId)) return false;
  return getDipBuyerRecoveryConstraints(DIP_BUYER_RECOVERY_ID)
    .qualityWeightEpisodes;
}

export function dipBuyerRecoverySupportFibMode(
  profileId?: string | null
): 'required' | 'preferred' | 'off' {
  if (profileId != null && !isDipBuyerRecoveryProfileId(profileId)) return 'off';
  return getDipBuyerRecoveryConstraints(DIP_BUYER_RECOVERY_ID)
    .requireSupportFibConfluence;
}
