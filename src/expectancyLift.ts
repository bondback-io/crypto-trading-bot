/**
 * Expectancy Lift / Entry Skill — expectancy-first governors, mix targets, permission.
 * Additive / soft-reversible except late_chase share ceiling (hard 5%).
 * Fail soft everywhere — never block hard safety.
 * Admission Baseline v235 = kill-switch (observe-only admit); governed = Entry Skill on.
 */

import fs from 'fs';
import { dataFile, ensureDataDir, atomicWriteJson } from './dataDir';
import { paperTrader } from './paperTrader';
import {
  getProfileLearningEpisodes,
  type ProfileLearningEpisode,
} from './profileLearningEpisodes';
import { TRADE_PROFILE_CATALOG } from './tradeProfiles';
import {
  isLossPnlSol,
  isScratchPnlSol,
  isWinPnlSol,
} from './tradeOutcome';

export const EXPECTANCY_LIFT_VERSION = 1;

/** v235 = observe-only expectancy (1.2.235 throughput); governed = full throttles. */
export type AdmissionBaseline = 'v235' | 'governed';

export type ExpectancyWindow = 20 | 50 | 100;

export const EXPECTANCY_WINDOWS = [20, 50, 100] as const;
export const DEFAULT_EXPECTANCY_WINDOW: ExpectancyWindow = 50;

export type ExpectancyFamily =
  | 'scalp_reclaim_burst'
  | 'reversal_reclaim'
  | 'level_momentum_expansion'
  | 'migration_hold_reclaim'
  | 'support_dip_reclaim'
  | 'trend_pullback_continuation'
  | 'quality_structure_reclaim'
  | 'smart_money_confirm'
  | 'late_chase'
  | 'discretionary_other';

export const EXPECTANCY_FAMILIES: readonly ExpectancyFamily[] = [
  'scalp_reclaim_burst',
  'reversal_reclaim',
  'level_momentum_expansion',
  'migration_hold_reclaim',
  'support_dip_reclaim',
  'trend_pullback_continuation',
  'quality_structure_reclaim',
  'smart_money_confirm',
  'late_chase',
  'discretionary_other',
] as const;

export type FamilyGovernorState =
  | 'promoted'
  | 'neutral'
  | 'down_ranked'
  | 'restricted';

const MIN_SAMPLES = 18;
/** Hard portfolio late-chase share ceiling (8% of last-50). */
const LATE_CHASE_MAX_SHARE = 0.08;
/** One-shot disable window after 1.2.257 ship. */
const LATE_CHASE_DISABLE_CLOSES = 125;
/** Late-chase permission floor after −18 penalty (quality gate). */
const LATE_CHASE_PERM_FLOOR = 55;
/** Default armed mix target (80%) — overridable via entrySkillArmedTargetPct. */
const DEFAULT_ARMED_TARGET_PCT = 80;
const ARMED_TARGET_PCT_LO = 60;
const ARMED_TARGET_PCT_HI = 90;
const DISC_RELIEF_EXTRA = 0.15;
/** Governed Entry Skill Scalper attention share target (~32%). */
const SCALPER_SHARE_TARGET = 0.32;
const ONE_SETUP_TTL_MS = 8 * 60_000;
const TOUCH_FAIL_ELEVATED = 0.35;
const STUCK_OPEN_RATE = 0.2;
/** Very-thin open book alone (without openRate evidence) — raised vs prior 15. */
const STUCK_VERY_THIN_OPEN_COUNT = 8;
const LOSS_STREAK_N = 8;
const LOSS_STREAK_K = 5;
/** Disc soft-skip permission floor (quality-first; raised 1.2.257). */
const PERM_FLOOR_DISC = 42;
const PERM_FLOOR_ARMED = 25;
const SIZE_MULT_LO = 0.7;
const SIZE_MULT_HI = 1.15;
const SCRATCH_PNL_PCT = 0.25;
const SCRATCH_PNL_SOL = 0.001;
const DISC_MIX_SIZE_PENALTY = 0.85;
/** When combined window E < 0, bump effective armed target to this (slider max). */
const ARMED_TARGET_E_BOOST_PCT = 90;
/** Strongly negative E — deny late-chase reclaim relief for primary chase. */
const LATE_CHASE_STRONG_NEG_E = -0.75;
/** Min samples for E-adaptive armed boost / late-chase E clamp. */
const E_ADAPT_MIN_SAMPLES = 12;
/** Min family n for Dip comparative soft-allow. */
const DIP_COMPARATIVE_MIN_N = 8;

/** Clamp operator armed-mix target pct (60–90). */
export function clampEntrySkillArmedTargetPct(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_ARMED_TARGET_PCT;
  return Math.min(
    ARMED_TARGET_PCT_HI,
    Math.max(ARMED_TARGET_PCT_LO, Math.round(n))
  );
}

export function getEntrySkillArmedTargetPct(): number {
  try {
    const { config } = require('./config') as typeof import('./config');
    const raw = (config as { entrySkillArmedTargetPct?: unknown })
      .entrySkillArmedTargetPct;
    if (raw == null) return DEFAULT_ARMED_TARGET_PCT;
    return clampEntrySkillArmedTargetPct(raw);
  } catch {
    return DEFAULT_ARMED_TARGET_PCT;
  }
}

export function setEntrySkillArmedTargetPct(raw: unknown): number {
  const pct = clampEntrySkillArmedTargetPct(raw);
  try {
    const {
      config,
      persistUserSettings,
    } = require('./config') as typeof import('./config');
    (config as { entrySkillArmedTargetPct: number }).entrySkillArmedTargetPct =
      pct;
    persistUserSettings();
  } catch {
    /* soft */
  }
  return pct;
}

/** Recent combined expectancy (last-50) for Entry Skill adaptive gates. */
function getRecentCombinedExpectancy(): {
  expectancyPct: number | null;
  tradeCount: number;
} {
  try {
    const trades = collectExpectancyTrades().slice(-50);
    const m = computeExpectancyMetrics(trades);
    return {
      expectancyPct: m.expectancyPct,
      tradeCount: m.tradeCount,
    };
  } catch {
    return { expectancyPct: null, tradeCount: 0 };
  }
}

/** True when combined E ≤ −0.75 (for DNA late-chase harden; avoids circular import weight). */
export function isStrongNegExpectancyForDna(): boolean {
  return isStronglyNegativeExpectancy(null);
}

/** True when combined E is negative enough to boost armed dominance. */
export function isArmedTargetEBoostActive(): boolean {
  if (isAdmissionBaselineV235()) return false;
  const { expectancyPct, tradeCount } = getRecentCombinedExpectancy();
  return (
    tradeCount >= E_ADAPT_MIN_SAMPLES &&
    expectancyPct != null &&
    expectancyPct < 0
  );
}

/** True when combined (or family) E is strongly negative for late-chase clamp. */
function isStronglyNegativeExpectancy(family?: ExpectancyFamily | null): boolean {
  if (isAdmissionBaselineV235()) return false;
  const { expectancyPct, tradeCount } = getRecentCombinedExpectancy();
  if (
    tradeCount >= E_ADAPT_MIN_SAMPLES &&
    expectancyPct != null &&
    expectancyPct <= LATE_CHASE_STRONG_NEG_E
  ) {
    return true;
  }
  if (family) {
    try {
      const st = getFamilyGovernorState(family);
      const trades = collectExpectancyTrades()
        .filter((t) => t.family === family)
        .slice(-40);
      const m = computeExpectancyMetrics(trades);
      if (
        m.tradeCount >= E_ADAPT_MIN_SAMPLES &&
        m.expectancyPct != null &&
        m.expectancyPct <= LATE_CHASE_STRONG_NEG_E
      ) {
        return true;
      }
      if (st === 'restricted' && m.expectancyPct != null && m.expectancyPct < 0) {
        return true;
      }
    } catch {
      /* soft */
    }
  }
  return false;
}

/** Armed share target 0–1 from operator slider (ignored under Baseline v235 admit).
 * When combined E < 0 under governed: effective target bumps to 90% (disc cap 10%). */
function armedShareTarget(): number {
  const base = getEntrySkillArmedTargetPct() / 100;
  if (isArmedTargetEBoostActive()) {
    return Math.max(base, ARMED_TARGET_E_BOOST_PCT / 100);
  }
  return base;
}

/** Disc share hard cap = 1 − armed target (e.g. 80% → 20%; E-boost → 10%). */
function discShareCap(): number {
  return 1 - armedShareTarget();
}

/** Fallback relief when arms empty/stuck = cap + 0.15. */
function discShareCapRelief(): number {
  return Math.min(0.95, discShareCap() + DISC_RELIEF_EXTRA);
}

/**
 * Entry Skill hard-skip late_chase primary even below the n≥20 share floor.
 * 1.2.248: all profiles under Entry Skill (not only quality/fast set).
 * Armed reclaim relief still bypasses via isArmedReclaimRelief.
 */
/** Match supportReclaim.DEFAULT_LATE_CHASE_EXT_PCT (avoid circular import). */
const LATE_CHASE_EXT_PCT_LIM = 8;
const QUALITY_LATE_CHASE_PROFILES = new Set([
  'dip_buyer',
  'trend_rider',
  'steady_compounder',
  'smart_money_mirror',
  'scalper',
  'migration_sniper',
  'momentum_burst',
  'reversal_scalper',
  'high_win_rate',
]);

/** When true, Entry Skill hard-skips late_chase for any profile id. */
const LATE_CHASE_HARD_SKIP_ALL_PROFILES = true;

const FILE = () => dataFile('expectancy-lift.json');

interface GovernorPersistRow {
  state: FamilyGovernorState;
  negWindows: number;
  tempRestrictUntilMs?: number;
  /** Fingerprint of last window that advanced negWindows / temp-restrict. */
  lastFingerprint?: string;
  updatedAt: number;
}

interface ExpectancyLiftPersist {
  version: number;
  governors: Record<string, GovernorPersistRow>;
  updatedAt: number;
  /** One-shot sticky restrict cleanup after poll-inflation bug (v1.2.238). */
  repairedV238?: boolean;
  /** One-shot: sticky migration_hold_reclaim restricted → down_ranked (v1.2.240). */
  repairedV239?: boolean;
  /** One-shot: clear sticky governors when Admission Baseline ships as v235. */
  clearedGovernorsForV235Baseline?: boolean;
  /** Remaining closes while late_chase is force-disabled (1.2.257). */
  lateChaseDisableRemainingCloses?: number;
  /** One-shot seed for late-chase disable countdown. */
  lateChaseDisableSeededV257?: boolean;
  /** Trade count snapshot for decrementing disable countdown. */
  lateChaseDisableLastTradeCount?: number;
  /** Performance regime marker — Last-N windows filter closes after this. */
  performanceRegimeMarkerAt?: number;
  performanceRegimeLabel?: string;
  /** One-shot: seed regime marker + late_chase sticky for 1.2.257. */
  seededPerfV257?: boolean;
}

const FAST_DISC_PROFILES = new Set([
  'scalper',
  'momentum_burst',
  'reversal_scalper',
]);

/** Quality profiles — hard soft-skip discretionary when arms live + over disc cap. */
const QUALITY_DISC_PROFILES = new Set([
  'dip_buyer',
  'trend_rider',
  'steady_compounder',
  'high_win_rate',
]);

function isMixThrottledDiscProfile(pid: string): boolean {
  return FAST_DISC_PROFILES.has(pid) || QUALITY_DISC_PROFILES.has(pid);
}

let persistCache: ExpectancyLiftPersist | null = null;
const oneSetupLocks = new Map<string, { profileId: string; untilMs: number }>();
/** Throttle [one-setup] mint held logs (per mint). */
const oneSetupHeldLogAt = new Map<string, number>();
const ONE_SETUP_HELD_LOG_MS = 60_000;
/** Session funnel: lock acquire → open / expire outcomes. */
const oneSetupLockFunnel = {
  acquired: 0,
  released: 0,
  opened: 0,
  expired: 0,
};
/** Armed hard-lock preferred lane failed floors (governed second-pass block). */
let blockedSecondPassCount = 0;
/** Historical zero-MFE pattern admit skips (session). */
let zeroMfeEntryBlockedCount = 0;
/** Zero-MFE early stall cuts noted from exit path (session, soft). */
let zeroMfeEarlyCutCount = 0;
/** Family governor soft-pass / skip counters (session). */
const govSoftAllowCounters = {
  softPassNative: 0,
  dipComparativeSoftAllow: 0,
  hardSkip: 0,
};

export function noteBlockedSecondPass(): void {
  blockedSecondPassCount += 1;
}

export function getBlockedSecondPassCount(): number {
  return blockedSecondPassCount;
}

export function noteZeroMfeEntryBlocked(): void {
  zeroMfeEntryBlockedCount += 1;
}

export function getZeroMfeEntryBlockedCount(): number {
  return zeroMfeEntryBlockedCount;
}

export function noteZeroMfeEarlyCut(): void {
  zeroMfeEarlyCutCount += 1;
}

export function getZeroMfeEarlyCutCount(): number {
  return zeroMfeEarlyCutCount;
}

export function noteGovSoftAllowGrant(
  kind: 'soft_pass_native' | 'dip_comparative' | 'hard_skip'
): void {
  if (kind === 'soft_pass_native') govSoftAllowCounters.softPassNative += 1;
  else if (kind === 'dip_comparative')
    govSoftAllowCounters.dipComparativeSoftAllow += 1;
  else govSoftAllowCounters.hardSkip += 1;
}

export function getGovSoftAllowCounters(): {
  softPassNative: number;
  dipComparativeSoftAllow: number;
  hardSkip: number;
} {
  return { ...govSoftAllowCounters };
}

const ZERO_MFE_PATTERN_MIN_N = 8;
const ZERO_MFE_PATTERN_SHARE = 0.45;

/** Skip admit when profile historically prints maxRunup≤0 at high rate. */
export function shouldBlockZeroMfePattern(input: {
  profileId?: string | null;
  entryStyle?: string | null;
  setupWatchFamily?: string | null;
  /** Armed / setup-watch reclaim — never hard-block the vetted path. */
  armedWatch?: boolean;
  entryPath?: string | null;
}): { block: boolean; reason?: string; share?: number; n?: number } {
  try {
    // Do not freeze armed trigger→open on historical DOA share (1.2.269).
    if (
      input.armedWatch === true ||
      String(input.entryPath || '') === 'armed_trigger'
    ) {
      return { block: false };
    }
    const pid = String(input.profileId || '');
    if (!pid) return { block: false };
    const trades = collectExpectancyTrades()
      .filter((t) => t.profileId === pid)
      .slice(-40);
    const n = trades.length;
    if (n < ZERO_MFE_PATTERN_MIN_N) return { block: false, n };
    // Prefer decided non-scratch outcomes when hold was meaningful
    const decided = trades.filter((t) => {
      const holdSec = Math.max(0, Number(t.holdMs) || 0) / 1000;
      const pnl = Number(t.pnlPct) || 0;
      // Ignore tiny scratch exits that inflate zero-MFE rate
      if (holdSec < 20 && pnl > -1 && pnl < 2) return false;
      return true;
    });
    const sample = decided.length >= ZERO_MFE_PATTERN_MIN_N ? decided : trades;
    const sn = sample.length;
    if (sn < ZERO_MFE_PATTERN_MIN_N) return { block: false, n: sn };
    const zero = sample.filter((t) => (Number(t.maxRunupPct) || 0) <= 0).length;
    const share = zero / sn;
    if (share >= ZERO_MFE_PATTERN_SHARE) {
      return {
        block: true,
        share,
        n: sn,
        reason: `zero_mfe_entry_blocked: ${(share * 100).toFixed(0)}% maxRunup≤0 over n=${sn}`,
      };
    }
    return { block: false, share, n: sn };
  } catch {
    return { block: false };
  }
}

export interface ExpectancyTradeRow {
  profileId: string;
  family: ExpectancyFamily;
  closedAt: number;
  openedAt: number;
  holdMs: number;
  pnlPct: number;
  pnlSol: number;
  win: boolean;
  armed: boolean;
  lateChase: boolean;
  firstPartial: boolean;
  mfeCapturePct: number | null;
  maxRunupPct: number;
  trailActive: boolean;
  entryStyle?: string;
  key: string;
  /** Present when source episode/closed had an entryMarketCapUsd field. */
  hasEntryMcField?: boolean;
  entryMarketCapUsd?: number | null;
}

export interface ExpectancyMetrics {
  winRate: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  winLossRatio: number | null;
  expectancyPct: number | null;
  expectancySol: number | null;
  profitFactor: number | null;
  mfeCapturePct: number | null;
  avgHoldMs: number | null;
  tradeCount: number;
}

export interface ExpectancyMix {
  armedShare: number | null;
  discretionaryShare: number | null;
  lateChaseShare: number | null;
  scalperAttentionShare: number | null;
  firstPartialRate: number | null;
  avgMfeCapture: number | null;
}

export interface FamilyGovernorRow {
  family: ExpectancyFamily;
  state: FamilyGovernorState;
  metrics: ExpectancyMetrics;
  metricsAlt?: ExpectancyMetrics;
  negWindows: number;
  note: string;
}

export interface ProfileExpectancyRow {
  profileId: string;
  name: string;
  metrics: ExpectancyMetrics;
  armedShare: number | null;
  lateChaseShare: number | null;
  firstPartialRate: number | null;
  quiet?: boolean;
  quietReason?: string;
}

export interface ArmedFunnelRow {
  offered: number;
  armed: number;
  triggered: number;
  opened: number;
  blocked: number;
  openRatePct: number | null;
  armToTriggerMs: number | null;
  /** armed → triggered conversion % */
  armToTriggerPct: number | null;
  /** triggered → opened conversion % */
  triggerToOpenPct: number | null;
  /** armed → opened conversion % */
  armToOpenPct: number | null;
}

/** Restricted/down_ranked family impact on native profiles (diagnostics). */
export interface FamilyRestrictionImpactRow {
  family: ExpectancyFamily;
  state: FamilyGovernorState;
  nativeProfiles: string[];
  expectancyPct: number | null;
  winRate: number | null;
  mfeCapturePct: number | null;
  tradeCount: number;
  note: string;
}

export interface ExpectancyLiftStatus {
  ok: boolean;
  window: ExpectancyWindow;
  mix: ExpectancyMix;
  targets: {
    armedShare: number;
    armedTargetPct: number;
    lateChaseShareMax: number;
    scalperShareMax: number;
    discShareMax: number;
  };
  profiles: ProfileExpectancyRow[];
  families: FamilyGovernorRow[];
  funnel: ArmedFunnelRow;
  chart: {
    tradeIndex: number[];
    rollingExpectancyPct: number[];
    rollingWinRatePct: number[];
    cumulativePnlPct: number[];
  };
  quietChips: Array<{ profileId: string; label: string; reason: string }>;
  plainLanguage: string;
  /** Discretionary mix throttle state for dashboard chip. */
  discMixThrottle: {
    active: boolean;
    discShare: number | null;
    liveArmed: number;
    liveTriggerableArmed: number;
    effectiveCap: number;
    /** True when disc fallback is allowed (no effective triggerable arms). */
    fallbackDiscAllowed: boolean;
    armedTargetPct?: number;
    liveArmedShare?: number | null;
  };
  /** 1.2.257 performance regime — Last-N filters closes after marker. */
  performanceRegime?: {
    at: number | null;
    label: string | null;
    lateChaseDisableRemaining: number;
  };
  /** Per-profile Entry Skill funnel + lock diagnostics. */
  entrySkillByProfile?: Record<
    string,
    {
      armed: number;
      triggered: number;
      opened: number;
      expired: number;
      locksHeld: number;
      fallbackDiscAllowed: boolean;
    }
  >;
  /** Operator Admission Baseline (`v235` | `governed`). */
  admissionBaseline: AdmissionBaseline;
  /** True when v235 observe-only throughput mode is active. */
  baselineActive: boolean;
  /** True when Entry Skill (governed) admit path is active. */
  entrySkillActive: boolean;
  /** Operator armed-mix target pct (60–90); observe-only under Baseline v235. */
  entrySkillArmedTargetPct?: number;
  /** Effective armed target after E&lt;0 boost (may be 90). */
  entrySkillArmedTargetEffectivePct?: number;
  /** Combined E < 0 → effective armed target bumped to 90%. */
  armedTargetEBoost?: boolean;
  /** Armed hard-lock preferred-lane floor fails (diagnostics chip only). */
  blockedSecondPass?: number;
  /** Session repair counters (1.2.268). */
  repairSession?: {
    zeroMfeEntryBlocked: number;
    zeroMfeEarlyCut: number;
    govSoftAllow: {
      softPassNative: number;
      dipComparativeSoftAllow: number;
      hardSkip: number;
    };
    softMovementGrants: number;
    softMovementArmsLive: number;
    zeroMfeShare: number | null;
    greenThenRedShare: number | null;
    topLossProfileId: string | null;
    topLossShare: number | null;
  };
  /** Per-family skill memory (WR / E / avg W/L / MFE / n + governor). */
  familySkillMemory: FamilySkillMemoryRow[];
  /** Performance Power Cell charge (visual-only). */
  performanceCharge: import('./performanceCharge').PerformanceChargeBundle | null;
  /** Restricted/down_ranked families vs native profile impact. */
  familyRestrictionImpact?: FamilyRestrictionImpactRow[];
}

export interface FamilySkillMemoryRow {
  family: ExpectancyFamily;
  winRate: number | null;
  expectancyPct: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  mfeCapturePct: number | null;
  n: number;
  state: FamilyGovernorState;
}

export interface EntrySelectivityCtx {
  profileId: string;
  profileName?: string;
  tradeProfileScore?: number | null;
  armedWatch?: boolean;
  entryStyle?: string | null;
  lateChase?: boolean;
  extensionFromLevelPct?: number | null;
  setupWatchFamily?: string | null;
  mint?: string | null;
  triggerConfirm?: boolean;
  detectedEntryStyle?: string | null;
  entryPath?: string | null;
}

export interface EntrySelectivityResult {
  admit: boolean;
  reasons: string[];
  permission: number;
  sizeMult: number;
  family: ExpectancyFamily;
  chips: string[];
  /** Structured Entry Skill / late-chase reason codes. */
  reasonCodes?: string[];
  governorState: FamilyGovernorState;
  softPassNative?: boolean;
  governorInfluenced: boolean;
}

export function normalizeAdmissionBaseline(raw: unknown): AdmissionBaseline {
  return raw === 'governed' ? 'governed' : 'v235';
}

export function getAdmissionBaseline(): AdmissionBaseline {
  try {
    const { config } = require('./config') as typeof import('./config');
    return normalizeAdmissionBaseline(
      (config as { admissionBaseline?: unknown }).admissionBaseline
    );
  } catch {
    return 'governed';
  }
}

export function isAdmissionBaselineV235(): boolean {
  return getAdmissionBaseline() === 'v235';
}

/** Reset sticky family governors so restricted state does not confuse the card. */
export function clearStickyGovernors(): void {
  const p = loadPersist();
  p.governors = {};
  p.updatedAt = Date.now();
  p.clearedGovernorsForV235Baseline = true;
  persistCache = p;
  try {
    savePersist();
  } catch {
    /* soft */
  }
}

export function setAdmissionBaseline(
  next: AdmissionBaseline | string
): AdmissionBaseline {
  const normalized = normalizeAdmissionBaseline(next);
  const prev = getAdmissionBaseline();
  try {
    const {
      config,
      persistUserSettings,
      noteAdmissionBaselineOperatorChoice,
    } = require('./config') as typeof import('./config');
    (config as { admissionBaseline: AdmissionBaseline }).admissionBaseline =
      normalized;
    try {
      noteAdmissionBaselineOperatorChoice();
    } catch {
      /* soft */
    }
    persistUserSettings();
  } catch {
    /* soft */
  }
  if (normalized === 'v235' && prev !== 'v235') {
    clearStickyGovernors();
  }
  return normalized;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

function emptyMetrics(): ExpectancyMetrics {
  return {
    winRate: null,
    avgWinPct: null,
    avgLossPct: null,
    winLossRatio: null,
    expectancyPct: null,
    expectancySol: null,
    profitFactor: null,
    mfeCapturePct: null,
    avgHoldMs: null,
    tradeCount: 0,
  };
}

/** Normalize legacy / alias family tags. Exact migration tag only — no broad /migration/. */
export function normalizeExpectancyFamily(
  raw: string | null | undefined
): ExpectancyFamily {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  if (s === 'momentum_continuation' || s === 'level_momentum_expansion') {
    return 'level_momentum_expansion';
  }
  if ((EXPECTANCY_FAMILIES as readonly string[]).includes(s)) {
    return s as ExpectancyFamily;
  }
  if (/late.?chase/.test(s)) return 'late_chase';
  if (/scalp.?reclaim/.test(s)) return 'scalp_reclaim_burst';
  if (/reversal.?reclaim/.test(s)) return 'reversal_reclaim';
  if (/support.?dip|dip.?reclaim/.test(s)) return 'support_dip_reclaim';
  if (/trend.?pullback|pullback.?cont/.test(s)) {
    return 'trend_pullback_continuation';
  }
  if (/quality.?structure/.test(s)) return 'quality_structure_reclaim';
  if (/smart.?money/.test(s)) return 'smart_money_confirm';
  return 'discretionary_other';
}

export function classifyTradeFamily(input: {
  entryStyle?: string | null;
  entryStyleSecondary?: string | null;
  lateChaseAtEntry?: boolean;
  profileId?: string | null;
  armedWatch?: boolean;
  entryPath?: string | null;
  setupWatchFamily?: string | null;
}): ExpectancyFamily {
  if (
    input.lateChaseAtEntry === true ||
    /late.?chase/i.test(String(input.entryStyle || '')) ||
    /late.?chase/i.test(String(input.entryStyleSecondary || ''))
  ) {
    return 'late_chase';
  }
  const rawStyle = String(input.entryStyle || '')
    .trim()
    .toLowerCase();
  // Exact migration hold/reclaim tag only
  if (rawStyle === 'migration_hold_reclaim') {
    return 'migration_hold_reclaim';
  }
  const style = normalizeExpectancyFamily(input.entryStyle);
  if (style !== 'discretionary_other' && style !== 'migration_hold_reclaim') {
    return style;
  }
  if (style === 'migration_hold_reclaim') {
    return 'migration_hold_reclaim';
  }

  const armed =
    input.armedWatch === true ||
    String(input.entryPath || '').toLowerCase() === 'armed_trigger';
  const setupFam = String(input.setupWatchFamily || '')
    .trim()
    .toLowerCase();
  const pid = String(input.profileId || '');

  // Armed grad / migration profile armed → migration_hold_reclaim
  if (
    setupFam === 'grad' &&
    (armed || String(input.entryPath || '').toLowerCase() === 'armed_trigger')
  ) {
    return 'migration_hold_reclaim';
  }
  if (
    (pid === 'migration_sniper' || pid === 'migration') &&
    armed
  ) {
    return 'migration_hold_reclaim';
  }
  // migration_sniper without style and not armed → discretionary_other
  if (pid === 'migration_sniper' || pid === 'migration') {
    return 'discretionary_other';
  }

  if (pid === 'scalper') return 'scalp_reclaim_burst';
  if (pid === 'reversal_scalper') return 'reversal_reclaim';
  if (pid === 'momentum_burst') return 'level_momentum_expansion';
  if (pid === 'dip_buyer') return 'support_dip_reclaim';
  if (pid === 'trend_rider') return 'trend_pullback_continuation';
  if (pid === 'high_win_rate' || pid === 'steady_compounder') {
    return 'quality_structure_reclaim';
  }
  if (pid === 'smart_money_mirror') return 'smart_money_confirm';
  return 'discretionary_other';
}

function tradeKey(t: {
  id?: string;
  mint?: string;
  openedAt?: number;
  closedAt?: number;
  pnlSol?: number;
}): string {
  if (t.id) return `id:${t.id}`;
  const mint = String(t.mint || '').slice(0, 32);
  const closed = Math.round(Number(t.closedAt) || 0);
  const opened = Math.round(Number(t.openedAt) || 0);
  const pnl = Number(t.pnlSol);
  const pnlR = Number.isFinite(pnl) ? pnl.toFixed(6) : '0';
  return `${mint}|${opened}|${closed}|${pnlR}`;
}

function mfeCaptureFrom(pnlPct: number, maxRunupPct: number): number | null {
  const mfe = Math.max(0, Number(maxRunupPct) || 0);
  if (!(mfe > 0)) return null;
  // Floor at 0 for Expectancy chips (avoid −25% “cap” noise); learning still sees wins/losses via pnl.
  return clamp((Number(pnlPct) || 0) / mfe, 0, 1.5) * 100;
}

function readEntryMcStamp(src: Record<string, unknown> | object): {
  hasEntryMcField: boolean;
  entryMarketCapUsd: number | null;
} {
  const o = src as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(o, 'entryMarketCapUsd')) {
    return { hasEntryMcField: false, entryMarketCapUsd: null };
  }
  const v = Number(o.entryMarketCapUsd);
  return {
    hasEntryMcField: true,
    entryMarketCapUsd: Number.isFinite(v) && v > 0 ? v : null,
  };
}

function isScratchPnl(pnlPct: number, pnlSol: number): boolean {
  return (
    Math.abs(pnlPct) < SCRATCH_PNL_PCT && Math.abs(pnlSol) < SCRATCH_PNL_SOL
  );
}

function isFinitePnl(pnlPct: number, pnlSol: number): boolean {
  return Number.isFinite(pnlPct) && Number.isFinite(pnlSol);
}

/** Trades eligible for family governor metrics / loss streak. */
function filterGovernorWindowTrades(
  family: ExpectancyFamily,
  trades: ExpectancyTradeRow[]
): ExpectancyTradeRow[] {
  return trades.filter((t) => {
    if (!isFinitePnl(t.pnlPct, t.pnlSol)) return false;
    if (isScratchPnl(t.pnlPct, t.pnlSol)) return false;
    // Migration family metrics: migration_sniper (+ armed grad) only —
    // exclude scalper/trend/dip DNA spillover that was mis-stamped.
    if (family === 'migration_hold_reclaim') {
      const pid = String(t.profileId || '');
      const isMigProfile = pid === 'migration_sniper' || pid === 'migration';
      if (!isMigProfile) return false;
      if (t.hasEntryMcField === true) {
        if (!(t.entryMarketCapUsd != null && t.entryMarketCapUsd > 0)) {
          return false;
        }
      }
    }
    return true;
  });
}

function windowFingerprint(
  trades: ExpectancyTradeRow[],
  exp: number | null
): string {
  const last = trades.length ? trades[trades.length - 1]! : null;
  const lastClosedAt = last ? Math.round(last.closedAt) : 0;
  const expR =
    exp != null && Number.isFinite(exp) ? Math.round(exp * 100) / 100 : 0;
  return `${lastClosedAt}|${trades.length}|${expR}`;
}

function fromEpisode(e: ProfileLearningEpisode): ExpectancyTradeRow | null {
  try {
    const {
      isLearningQuarantinedEpisode,
      isResetLearningQuarantineReason,
    } = require('./profileLearningEpisodes') as typeof import('./profileLearningEpisodes');
    let includeReset = false;
    try {
      const { config } = require('./config') as typeof import('./config');
      includeReset = config.learning?.includeDashboardResetEpisodes === true;
    } catch {
      includeReset = false;
    }
    if (
      !includeReset &&
      (isLearningQuarantinedEpisode(e) ||
        isResetLearningQuarantineReason(e.exitReason))
    ) {
      return null;
    }
  } catch {
    if (/dashboard_reset/i.test(String(e.exitReason || ''))) return null;
  }
  const profileId = String(e.profileId || '').trim();
  if (!profileId || profileId === 'default') return null;
  if (/^partial:/i.test(String(e.exitReason || ''))) return null;
  const closedAt = Number(e.closedAt);
  if (!Number.isFinite(closedAt) || closedAt <= 0) return null;
  const pnlPct = Number(e.pnlPct);
  const pnlSol = Number(e.pnlSol);
  if (!isFinitePnl(pnlPct, pnlSol)) return null;
  const maxRunup = Math.max(0, Number(e.maxRunupPct) || 0);
  const cap =
    e.mfeCaptureRatio != null && Number.isFinite(Number(e.mfeCaptureRatio))
      ? clamp(Number(e.mfeCaptureRatio), -0.5, 1.5) * 100
      : mfeCaptureFrom(pnlPct, maxRunup);
  const armed =
    e.armedWatch === true ||
    e.entryPath === 'armed_trigger' ||
    e.scalperWatchTriggered === true;
  const mc = readEntryMcStamp(e as unknown as Record<string, unknown>);
  const setupWatchFamily = String(
    (e as { setupWatchFamily?: string }).setupWatchFamily || ''
  );
  return {
    profileId,
    family: classifyTradeFamily({
      entryStyle: e.entryStyle,
      entryStyleSecondary: e.entryStyleSecondary,
      lateChaseAtEntry: e.lateChaseAtEntry,
      profileId,
      armedWatch: armed,
      entryPath: e.entryPath,
      setupWatchFamily: setupWatchFamily || undefined,
    }),
    closedAt,
    openedAt: Number(e.openedAt) || closedAt,
    holdMs: Math.max(0, (Number(e.holdSec) || 0) * 1000),
    pnlPct,
    pnlSol,
    win: isWinPnlSol(pnlSol),
    armed,
    lateChase:
      e.lateChaseAtEntry === true ||
      classifyTradeFamily({
        entryStyle: e.entryStyle,
        lateChaseAtEntry: e.lateChaseAtEntry,
        profileId,
      }) === 'late_chase',
    firstPartial: e.pclPartialTaken === true,
    mfeCapturePct: cap,
    maxRunupPct: maxRunup,
    trailActive: e.peakProtectArmed === true,
    entryStyle: e.entryStyle,
    key: tradeKey({
      id: e.id,
      mint: e.mint,
      openedAt: e.openedAt,
      closedAt: e.closedAt,
      pnlSol: e.pnlSol,
    }),
    hasEntryMcField: mc.hasEntryMcField,
    entryMarketCapUsd: mc.entryMarketCapUsd,
  };
}

function fromClosed(t: Record<string, unknown>): ExpectancyTradeRow | null {
  try {
    const { isResetLearningQuarantineReason } =
      require('./profileLearningEpisodes') as typeof import('./profileLearningEpisodes');
    let includeReset = false;
    try {
      const { config } = require('./config') as typeof import('./config');
      includeReset = config.learning?.includeDashboardResetEpisodes === true;
    } catch {
      includeReset = false;
    }
    if (
      !includeReset &&
      isResetLearningQuarantineReason(String(t.reason || ''))
    ) {
      return null;
    }
  } catch {
    if (/dashboard_reset/i.test(String(t.reason || ''))) return null;
  }
  if (/^partial:/i.test(String(t.reason || ''))) return null;
  const profileId = String(t.tradeProfileId || '').trim();
  if (!profileId || profileId === 'default') return null;
  const closedAt = Number(t.closedAt);
  if (!Number.isFinite(closedAt) || closedAt <= 0) return null;
  const pnlPct = Number(t.pnlPct);
  const pnlSol = Number(t.pnlSol);
  if (!isFinitePnl(pnlPct, pnlSol)) return null;
  const maxRunup = Math.max(
    0,
    Number(t.maxRunupPct ?? t.peakUnrealizedPct) || 0
  );
  const armed =
    t.armedWatch === true ||
    t.entryPath === 'armed_trigger' ||
    t.scalperWatchTriggered === true;
  const style = String(t.entryStyle || '');
  const mc = readEntryMcStamp(t);
  return {
    profileId,
    family: classifyTradeFamily({
      entryStyle: style,
      entryStyleSecondary: String(t.entryStyleSecondary || ''),
      lateChaseAtEntry: t.lateChaseAtEntry === true,
      profileId,
      armedWatch: armed,
      entryPath: String(t.entryPath || ''),
      setupWatchFamily: String(t.setupWatchFamily || '') || undefined,
    }),
    closedAt,
    openedAt: Number(t.openedAt) || closedAt,
    holdMs: Math.max(
      0,
      (Number(t.closedAt) || 0) - (Number(t.openedAt) || 0)
    ),
    pnlPct,
    pnlSol,
    win: isWinPnlSol(pnlSol),
    armed,
    lateChase:
      t.lateChaseAtEntry === true || /late.?chase/i.test(style),
    firstPartial: t.pclPartialTaken === true || t.partialTaken === true,
    mfeCapturePct: mfeCaptureFrom(pnlPct, maxRunup),
    maxRunupPct: maxRunup,
    trailActive: t.peakProtectArmed === true || t.trailActive === true,
    entryStyle: style || undefined,
    key: tradeKey({
      id: String(t.id || ''),
      mint: String(t.mint || ''),
      openedAt: Number(t.openedAt),
      closedAt,
      pnlSol,
    }),
    hasEntryMcField: mc.hasEntryMcField,
    entryMarketCapUsd: mc.entryMarketCapUsd,
  };
}

/** Merge closed ledger + learning episodes (closed wins on collision). */
export function collectExpectancyTrades(): ExpectancyTradeRow[] {
  const map = new Map<string, ExpectancyTradeRow>();
  try {
    for (const p of TRADE_PROFILE_CATALOG) {
      if (p.id === 'default' || p.id === 'zion') continue;
      const eps = getProfileLearningEpisodes(p.id, 400);
      for (const e of eps) {
        const row = fromEpisode(e);
        if (!row) continue;
        map.set(`${row.profileId}:${row.key}`, row);
      }
    }
  } catch {
    /* fail soft */
  }
  try {
    const closed = paperTrader.getClosedPositions?.() ?? [];
    for (const t of closed) {
      const row = fromClosed(t as unknown as Record<string, unknown>);
      if (!row) continue;
      const k = `${row.profileId}:${row.key}`;
      map.set(k, row);
      const alt = `${row.profileId}:${tradeKey({
        mint: (t as { mint?: string }).mint,
        openedAt: row.openedAt,
        closedAt: row.closedAt,
        pnlSol: row.pnlSol,
      })}`;
      if (alt !== k) map.set(alt, row);
    }
  } catch {
    /* fail soft */
  }
  const byStable = new Map<string, ExpectancyTradeRow>();
  for (const row of map.values()) {
    const sk = `${row.profileId}|${row.key}|${row.closedAt}|${row.pnlSol.toFixed(6)}`;
    byStable.set(sk, row);
  }
  return [...byStable.values()].sort((a, b) => a.closedAt - b.closedAt);
}

export function computeExpectancyMetrics(
  trades: ExpectancyTradeRow[]
): ExpectancyMetrics {
  // Display WR / expectancy: exclude scratch (≈0 SOL) from denominator
  const decided = trades.filter((t) => !isScratchPnlSol(t.pnlSol));
  const n = decided.length;
  if (!n) return emptyMetrics();
  const wins = decided.filter((t) => isWinPnlSol(t.pnlSol));
  const losses = decided.filter((t) => isLossPnlSol(t.pnlSol));
  const wr = wins.length / n;
  const avgWin = avg(wins.map((t) => t.pnlPct)) ?? 0;
  const avgLossAbs =
    avg(losses.map((t) => Math.abs(t.pnlPct))) ?? 0;
  const expectancyPct = wr * avgWin - (1 - wr) * avgLossAbs;
  const sumWinSol = wins.reduce((s, t) => s + Math.max(0, t.pnlSol), 0);
  const sumLossSolAbs = losses.reduce(
    (s, t) => s + Math.abs(Math.min(0, t.pnlSol)),
    0
  );
  const avgWinSol = avg(wins.map((t) => t.pnlSol)) ?? 0;
  const avgLossSolAbs =
    avg(losses.map((t) => Math.abs(t.pnlSol))) ?? 0;
  const expectancySol = wr * avgWinSol - (1 - wr) * avgLossSolAbs;
  const caps = decided
    .map((t) => t.mfeCapturePct)
    .filter((x): x is number => x != null && Number.isFinite(x));
  return {
    winRate: wr,
    avgWinPct: wins.length ? avgWin : null,
    avgLossPct: losses.length ? avgLossAbs : null,
    winLossRatio:
      avgLossAbs > 1e-9 && wins.length ? avgWin / avgLossAbs : null,
    expectancyPct,
    expectancySol,
    // Align with microBot: capped ∞ label (999) when wins and no losses
    profitFactor:
      sumLossSolAbs > 1e-9
        ? sumWinSol / sumLossSolAbs
        : wins.length
          ? 999
          : 0,
    mfeCapturePct: avg(caps),
    avgHoldMs: avg(decided.map((t) => t.holdMs)),
    tradeCount: n,
  };
}

function emptyPersist(): ExpectancyLiftPersist {
  return {
    version: EXPECTANCY_LIFT_VERSION,
    governors: {},
    updatedAt: 0,
    repairedV238: true,
    repairedV239: true,
    clearedGovernorsForV235Baseline: true,
    lateChaseDisableRemainingCloses: LATE_CHASE_DISABLE_CLOSES,
    lateChaseDisableSeededV257: true,
    lateChaseDisableLastTradeCount: 0,
    seededPerfV257: true,
    performanceRegimeMarkerAt: Date.now(),
    performanceRegimeLabel: 'v1.2.257-perf',
  };
}

/** Seed 1.2.257 late-chase disable + performance regime marker (one-shot). */
function applyPerfV257Seed(p: ExpectancyLiftPersist): boolean {
  if (p.seededPerfV257 === true) return false;
  p.seededPerfV257 = true;
  if (p.lateChaseDisableSeededV257 !== true) {
    p.lateChaseDisableSeededV257 = true;
    p.lateChaseDisableRemainingCloses = LATE_CHASE_DISABLE_CLOSES;
    p.lateChaseDisableLastTradeCount = 0;
  }
  if (p.performanceRegimeMarkerAt == null) {
    p.performanceRegimeMarkerAt = Date.now();
    p.performanceRegimeLabel = 'v1.2.257-perf';
  }
  // Keep late_chase sticky restricted during disable window
  const now = Date.now();
  const lc = p.governors?.late_chase;
  if (!lc || lc.state !== 'restricted') {
    p.governors = p.governors || {};
    p.governors.late_chase = {
      state: 'restricted',
      negWindows: Math.max(2, lc?.negWindows || 2),
      lastFingerprint: lc?.lastFingerprint,
      updatedAt: now,
    };
  }
  return true;
}

/** Decrement late-chase disable countdown as new closes appear. */
function syncLateChaseDisableCountdown(): number {
  const p = loadPersist();
  let rem =
    p.lateChaseDisableRemainingCloses != null &&
    Number.isFinite(p.lateChaseDisableRemainingCloses)
      ? Math.max(0, Math.floor(Number(p.lateChaseDisableRemainingCloses)))
      : 0;
  try {
    const n = collectExpectancyTrades().length;
    const last = p.lateChaseDisableLastTradeCount ?? n;
    const delta = n - last;
    if (delta > 0 && rem > 0) {
      rem = Math.max(0, rem - delta);
      p.lateChaseDisableRemainingCloses = rem;
      p.lateChaseDisableLastTradeCount = n;
      persistCache = p;
      try {
        savePersist();
      } catch {
        /* soft */
      }
    } else if (p.lateChaseDisableLastTradeCount == null) {
      p.lateChaseDisableLastTradeCount = n;
      persistCache = p;
    }
  } catch {
    /* soft */
  }
  return rem;
}

export function getLateChaseDisableRemainingCloses(): number {
  try {
    return syncLateChaseDisableCountdown();
  } catch {
    return 0;
  }
}

export function getPerformanceRegimeMarker(): {
  at: number | null;
  label: string | null;
} {
  try {
    const p = loadPersist();
    return {
      at:
        p.performanceRegimeMarkerAt != null &&
        Number.isFinite(p.performanceRegimeMarkerAt)
          ? Number(p.performanceRegimeMarkerAt)
          : null,
      label: p.performanceRegimeLabel ? String(p.performanceRegimeLabel) : null,
    };
  } catch {
    return { at: null, label: null };
  }
}

/** One-shot: clear sticky governors when shipping default v235 baseline. */
function applyV235BaselineGovernorClear(p: ExpectancyLiftPersist): boolean {
  if (p.clearedGovernorsForV235Baseline === true) return false;
  try {
    if (!isAdmissionBaselineV235()) {
      p.clearedGovernorsForV235Baseline = true;
      return true;
    }
  } catch {
    /* soft — still clear once */
  }
  p.governors = {};
  p.clearedGovernorsForV235Baseline = true;
  return true;
}

/** One-shot: sticky poll-inflation restricts → down_ranked. */
function applyPollInflationRepair(p: ExpectancyLiftPersist): boolean {
  if (p.repairedV238 === true) return false;
  const now = Date.now();
  for (const row of Object.values(p.governors || {})) {
    if (!row || row.state !== 'restricted') continue;
    row.state = 'down_ranked';
    row.tempRestrictUntilMs = undefined;
    row.updatedAt = now;
  }
  p.repairedV238 = true;
  return true;
}

/** One-shot: sticky migration_hold_reclaim restricted → down_ranked (v1.2.240). */
function applyMigrationHoldReclaimRepair(p: ExpectancyLiftPersist): boolean {
  if (p.repairedV239 === true) return false;
  const now = Date.now();
  const row = p.governors?.migration_hold_reclaim;
  if (row && row.state === 'restricted') {
    row.state = 'down_ranked';
    row.tempRestrictUntilMs = undefined;
    row.updatedAt = now;
  }
  p.repairedV239 = true;
  return true;
}

function loadPersist(): ExpectancyLiftPersist {
  if (persistCache) return persistCache;
  try {
    ensureDataDir();
    if (!fs.existsSync(FILE())) {
      persistCache = emptyPersist();
      return persistCache;
    }
    const raw = JSON.parse(
      fs.readFileSync(FILE(), 'utf8')
    ) as ExpectancyLiftPersist;
    persistCache = {
      version: EXPECTANCY_LIFT_VERSION,
      governors:
        raw?.governors && typeof raw.governors === 'object'
          ? raw.governors
          : {},
      updatedAt: Number(raw?.updatedAt) || 0,
      repairedV238: raw?.repairedV238 === true,
      repairedV239: raw?.repairedV239 === true,
      clearedGovernorsForV235Baseline:
        raw?.clearedGovernorsForV235Baseline === true,
      lateChaseDisableRemainingCloses:
        raw?.lateChaseDisableRemainingCloses != null
          ? Number(raw.lateChaseDisableRemainingCloses)
          : undefined,
      lateChaseDisableSeededV257: raw?.lateChaseDisableSeededV257 === true,
      lateChaseDisableLastTradeCount:
        raw?.lateChaseDisableLastTradeCount != null
          ? Number(raw.lateChaseDisableLastTradeCount)
          : undefined,
      performanceRegimeMarkerAt:
        raw?.performanceRegimeMarkerAt != null
          ? Number(raw.performanceRegimeMarkerAt)
          : undefined,
      performanceRegimeLabel: raw?.performanceRegimeLabel
        ? String(raw.performanceRegimeLabel)
        : undefined,
      seededPerfV257: raw?.seededPerfV257 === true,
    };
    let repaired = false;
    if (applyPollInflationRepair(persistCache)) repaired = true;
    if (applyMigrationHoldReclaimRepair(persistCache)) repaired = true;
    if (applyV235BaselineGovernorClear(persistCache)) repaired = true;
    if (applyPerfV257Seed(persistCache)) repaired = true;
    if (repaired) {
      try {
        persistCache.updatedAt = Date.now();
        atomicWriteJson(FILE(), persistCache);
      } catch {
        /* soft */
      }
    }
  } catch {
    persistCache = emptyPersist();
  }
  return persistCache;
}

function savePersist(): void {
  try {
    ensureDataDir();
    const s = loadPersist();
    s.updatedAt = Date.now();
    atomicWriteJson(FILE(), s);
  } catch {
    /* fail soft */
  }
}

function lossStreakBreaker(trades: ExpectancyTradeRow[]): boolean {
  if (trades.length < MIN_SAMPLES) return false;
  const last = trades.slice(-LOSS_STREAK_N);
  if (last.length < LOSS_STREAK_N) return false;
  const losses = last.filter((t) => !t.win).length;
  return losses >= LOSS_STREAK_K;
}

function updateGovernorForFamily(
  family: ExpectancyFamily,
  windowTrades: ExpectancyTradeRow[],
  altWindowTrades: ExpectancyTradeRow[]
): FamilyGovernorRow {
  const govTrades = filterGovernorWindowTrades(family, windowTrades);
  const govAlt = filterGovernorWindowTrades(family, altWindowTrades);
  const metrics = computeExpectancyMetrics(govTrades);
  const metricsAlt = computeExpectancyMetrics(govAlt);
  const p = loadPersist();
  const prev = p.governors[family] || {
    state: 'neutral' as FamilyGovernorState,
    negWindows: 0,
    updatedAt: 0,
  };
  let state: FamilyGovernorState = prev.state || 'neutral';
  let negWindows = prev.negWindows || 0;
  const now = Date.now();
  const n = metrics.tradeCount;
  const exp = metrics.expectancyPct;
  const expAlt = metricsAlt.expectancyPct;
  const fp = windowFingerprint(govTrades, exp);
  const sameFp =
    prev.lastFingerprint != null && prev.lastFingerprint === fp;
  const tempActive =
    prev.tempRestrictUntilMs != null && prev.tempRestrictUntilMs > now;

  if (tempActive) {
    // Do not refresh TTL on re-poll with same fingerprint
    state = 'restricted';
    if (!sameFp) {
      p.governors[family] = {
        ...prev,
        state,
        lastFingerprint: fp,
        updatedAt: now,
      };
    }
  } else if (lossStreakBreaker(govTrades) && !sameFp) {
    state = 'restricted';
    p.governors[family] = {
      state,
      negWindows,
      tempRestrictUntilMs: now + 30 * 60_000,
      lastFingerprint: fp,
      updatedAt: now,
    };
  } else if (n >= MIN_SAMPLES && exp != null) {
    if (!sameFp) {
      if (exp < 0) {
        negWindows = Math.min(4, negWindows + 1);
        if (
          negWindows >= 2 &&
          expAlt != null &&
          expAlt < 0 &&
          metricsAlt.tradeCount >= MIN_SAMPLES
        ) {
          state = 'restricted';
        } else {
          state = 'down_ranked';
        }
      } else {
        // Restore after improved window — never auto-promote late_chase during disable countdown
        const lcDisable =
          family === 'late_chase' ? syncLateChaseDisableCountdown() : 0;
        if (family === 'late_chase' && lcDisable > 0) {
          state = 'restricted';
          negWindows = Math.max(2, negWindows);
        } else if (state === 'restricted' || state === 'down_ranked') {
          if (exp > 0 && (expAlt == null || expAlt >= 0)) {
            state = exp >= 0.5 ? 'promoted' : 'neutral';
            negWindows = 0;
          } else if (exp > 0) {
            state = 'neutral';
            negWindows = Math.max(0, negWindows - 1);
          }
        } else if (exp >= 0.75 && n >= MIN_SAMPLES) {
          state = 'promoted';
          negWindows = 0;
        } else {
          state = 'neutral';
          negWindows = 0;
        }
      }
      p.governors[family] = {
        state,
        negWindows,
        tempRestrictUntilMs: undefined,
        lastFingerprint: fp,
        updatedAt: now,
      };
    } else {
      // Same window — keep prior governor decision (awaiting new closes)
      state = prev.state || state;
      negWindows = prev.negWindows || 0;
      if (state === 'restricted' && !tempActive) {
        // Sticky non-temp restrict with same fp stays until new closes
      }
    }
  } else {
    state =
      prev.state === 'restricted' && tempActive
        ? 'restricted'
        : state === 'restricted' && !tempActive && !prev.lastFingerprint
          ? 'neutral'
          : state;
  }

  persistCache = p;
  try {
    savePersist();
  } catch {
    /* soft */
  }

  let note = 'Insufficient samples';
  if (n >= MIN_SAMPLES && exp != null) {
    if (sameFp && (state === 'restricted' || state === 'down_ranked')) {
      note = `Awaiting new closes · negWindows=${negWindows}`;
    } else if (state === 'promoted') note = 'Positive expectancy — promoted';
    else if (state === 'restricted')
      note = `Negative expectancy (2+ windows) / streak breaker · negWindows=${negWindows} · restricted (soft for native profile)`;
    else if (state === 'down_ranked')
      note = `Negative expectancy — down-ranked · negWindows=${negWindows}`;
    else note = 'Neutral expectancy';
  } else if (lossStreakBreaker(govTrades)) {
    note = `Loss streak ${LOSS_STREAK_K}/${LOSS_STREAK_N} — temp restrict`;
  } else if (state === 'restricted') {
    note = 'restricted (soft for native profile)';
  }

  return {
    family,
    state,
    metrics,
    metricsAlt,
    negWindows,
    note,
  };
}

export function getFamilyGovernorState(
  family: ExpectancyFamily | string
): FamilyGovernorState {
  const f = normalizeExpectancyFamily(family);
  try {
    const p = loadPersist();
    const row = p.governors[f];
    if (!row) return 'neutral';
    if (
      row.tempRestrictUntilMs &&
      row.tempRestrictUntilMs > Date.now()
    ) {
      return 'restricted';
    }
    return row.state || 'neutral';
  } catch {
    return 'neutral';
  }
}

/**
 * Family used for governor admit/skip. Prefer profile-native DNA so scanner
 * DNA (e.g. migration_hold_reclaim on a Scalper/Dip winner) cannot alone force
 * a restricted migration family onto non-mig profiles. Armed grad / armed MS
 * still admit as migration_hold_reclaim.
 */
export function admitFamilyForGovernor(input: {
  profileId?: string | null;
  entryStyle?: string | null;
  armedWatch?: boolean;
  setupWatchFamily?: string | null;
  lateChase?: boolean;
  entryPath?: string | null;
}): ExpectancyFamily {
  const styleRaw = String(input.entryStyle || '')
    .trim()
    .toLowerCase();
  // Primary late_chase stamp only — lateChase flag alone does not override a
  // reclaim / profile-native admit (flag may be secondary metadata).
  if (styleRaw === 'late_chase' || /^late.?chase$/.test(styleRaw)) {
    return 'late_chase';
  }

  const armed =
    input.armedWatch === true ||
    String(input.entryPath || '').toLowerCase() === 'armed_trigger';
  const setupFam = String(input.setupWatchFamily || '')
    .trim()
    .toLowerCase();
  const pid = String(input.profileId || '');

  // Armed grad / armed migration_sniper → migration family
  if (
    armed &&
    (setupFam === 'grad' ||
      pid === 'migration_sniper' ||
      pid === 'migration')
  ) {
    return 'migration_hold_reclaim';
  }

  // Armed Dip → support_dip_reclaim (not late_chase rediscovery)
  if (
    armed &&
    (setupFam === 'dip' || pid === 'dip_buyer')
  ) {
    return 'support_dip_reclaim';
  }

  // Profile-native family for governor — ignore scanner DNA mig stamp on
  // non-migration winners (spillover that polluted migration metrics).
  try {
    const { PROFILE_ENTRY_STYLE_DNA } =
      require('./supportReclaim') as typeof import('./supportReclaim');
    const dna = PROFILE_ENTRY_STYLE_DNA[pid];
    const styleFam = normalizeExpectancyFamily(input.entryStyle);
    if (
      dna?.primary &&
      styleFam === 'migration_hold_reclaim' &&
      dna.primary !== 'migration_hold_reclaim' &&
      !dna.allowed.includes('migration_hold_reclaim')
    ) {
      return normalizeExpectancyFamily(dna.primary);
    }
    if (
      dna?.primary &&
      (!input.entryStyle || styleFam === 'discretionary_other')
    ) {
      return normalizeExpectancyFamily(dna.primary);
    }
  } catch {
    /* soft */
  }

  return classifyTradeFamily({
    entryStyle: input.entryStyle,
    // Do not let lateChase flag alone force late_chase when style is reclaim
    lateChaseAtEntry: false,
    profileId: input.profileId,
    armedWatch: input.armedWatch,
    entryPath: input.entryPath,
    setupWatchFamily: input.setupWatchFamily,
  });
}

function profileMatchesFamilyNative(
  profileId: string | null | undefined,
  family: ExpectancyFamily
): boolean {
  const pid = String(profileId || '');
  if (!pid) return false;
  try {
    const { PROFILE_ENTRY_STYLE_DNA } =
      require('./supportReclaim') as typeof import('./supportReclaim');
    const dna = PROFILE_ENTRY_STYLE_DNA[pid];
    if (!dna) return false;
    if (String(dna.primary) === family) return true;
    if (
      Array.isArray(dna.allowed) &&
      dna.allowed.some((s) => String(s) === family)
    ) {
      return true;
    }
  } catch {
    /* soft */
  }
  return false;
}

/** Soft-skip when family is restricted (late_chase always hard-skips when restricted). */
export function shouldSkipFamilyGovernor(input: {
  family?: string | null;
  entryStyle?: string | null;
  lateChase?: boolean;
  armedWatch?: boolean;
  profileId?: string | null;
  entryPath?: string | null;
  setupWatchFamily?: string | null;
}): {
  skip: boolean;
  reason?: string;
  state: FamilyGovernorState;
  softPassNative?: boolean;
  family?: ExpectancyFamily;
  reasonCode?: string;
} {
  const family = admitFamilyForGovernor({
    profileId: input.profileId,
    entryStyle: input.lateChase ? 'late_chase' : input.entryStyle,
    lateChase: input.lateChase === true,
    armedWatch: input.armedWatch,
    entryPath: input.entryPath,
    setupWatchFamily: input.setupWatchFamily,
  });
  // Honor explicit family override only when admit path had no profile context
  const effective =
    input.family &&
    input.profileId == null &&
    input.armedWatch == null &&
    input.setupWatchFamily == null
      ? normalizeExpectancyFamily(input.family)
      : family;
  const pid = String(input.profileId || '');
  const armed =
    input.armedWatch === true ||
    String(input.entryPath || '').toLowerCase() === 'armed_trigger' ||
    String(input.setupWatchFamily || '').toLowerCase() === 'grad';

  // MS disc harden: when migration_hold_reclaim is down_ranked/restricted,
  // only Grad/armed MS soft-passes — unarmed disc hard-skips.
  if (pid === 'migration_sniper') {
    const migGov = getFamilyGovernorState('migration_hold_reclaim');
    if (migGov === 'down_ranked' || migGov === 'restricted') {
      if (!armed) {
        return {
          skip: true,
          reason: `MS disc hard-skip: migration_hold_reclaim ${migGov} (Grad-armed only)`,
          state: migGov,
          family: 'migration_hold_reclaim',
          reasonCode: 'MS_DISC_GOV_HARD',
        };
      }
    }
  }

  const state = getFamilyGovernorState(effective);
  if (state === 'restricted') {
    // Hard-skip late_chase when restricted
    if (effective === 'late_chase') {
      return {
        skip: true,
        reason: `Expectancy governor: late_chase restricted`,
        state,
        family: effective,
        reasonCode: 'LC_GOV_RESTRICTED',
      };
    }
    // Armed reclaim may still pass soft restrict except late_chase
    if (input.armedWatch === true || armed) {
      return { skip: false, state, family: effective };
    }
    // Dip restricted + strongly negative E: unarmed discretionary soft-pass blocked
    // (learning: hard-SL bleed on disc support_dip_reclaim). Armed reclaim still ok above.
    if (
      effective === 'support_dip_reclaim' &&
      (pid === 'dip_buyer' ||
        profileMatchesFamilyNative(input.profileId, 'support_dip_reclaim')) &&
      isStronglyNegativeExpectancy('support_dip_reclaim')
    ) {
      return {
        skip: true,
        reason:
          'Dip: restricted support_dip_reclaim requires armed reclaim while Dip E strongly negative',
        state,
        family: effective,
        reasonCode: 'gov_dip_armed_required',
      };
    }
    // Native-style soft-pass: primary/allowed DNA — down-rank via permission/size only
    // MS unarmed already handled above when family gov is weak.
    if (profileMatchesFamilyNative(input.profileId, effective)) {
      noteGovSoftAllowGrant('soft_pass_native');
      return {
        skip: false,
        state,
        softPassNative: true,
        reason: `governor:restricted soft-pass native ${input.profileId}`,
        family: effective,
        reasonCode:
          effective === 'support_dip_reclaim' && pid === 'dip_buyer'
            ? 'gov_dip_native_soft_allow'
            : undefined,
      };
    }
    // Dip comparative soft-allow: when support_dip_reclaim is restricted but
    // Dip native metrics beat peer families, soft-pass Dip-native (and close
    // reclaim handoffs) instead of broad off-style kill.
    if (effective === 'support_dip_reclaim') {
      if (isStronglyNegativeExpectancy('support_dip_reclaim')) {
        return {
          skip: true,
          reason:
            'Dip: comparative soft-allow blocked — armed reclaim required while Dip E strongly negative',
          state,
          family: effective,
          reasonCode: 'gov_dip_armed_required',
        };
      }
      const cmp = evaluateDipComparativeSoftAllow();
      if (cmp.allow) {
        const dipNative =
          pid === 'dip_buyer' ||
          profileMatchesFamilyNative(input.profileId, 'support_dip_reclaim');
        if (dipNative || pid === 'dip_buyer') {
          noteGovSoftAllowGrant('dip_comparative');
          return {
            skip: false,
            state,
            softPassNative: true,
            reason: cmp.reason,
            family: effective,
            reasonCode: 'gov_dip_comparative_soft_allow',
          };
        }
      }
    }
    // Hard-skip only off-style / forbidden mismatch
    noteGovSoftAllowGrant('hard_skip');
    return {
      skip: true,
      reason: `Expectancy governor: ${effective} restricted`,
      state,
      family: effective,
    };
  }
  return { skip: false, state, family: effective };
}

/** When support_dip_reclaim is restricted but Dip E/WR/capture beats peer median — soft-allow. */
function evaluateDipComparativeSoftAllow(): {
  allow: boolean;
  reason: string;
} {
  try {
    const trades = collectExpectancyTrades().slice(-50);
    const byFam = new Map<ExpectancyFamily, ExpectancyTradeRow[]>();
    for (const t of trades) {
      const list = byFam.get(t.family) || [];
      list.push(t);
      byFam.set(t.family, list);
    }
    const dip = byFam.get('support_dip_reclaim') || [];
    const dipM = computeExpectancyMetrics(dip);
    if (
      dipM.tradeCount < DIP_COMPARATIVE_MIN_N ||
      dipM.expectancyPct == null
    ) {
      return { allow: false, reason: 'dip comparative: insufficient sample' };
    }
    const peerEs: number[] = [];
    const peerWrs: number[] = [];
    const peerCaps: number[] = [];
    for (const f of EXPECTANCY_FAMILIES) {
      if (f === 'support_dip_reclaim' || f === 'late_chase') continue;
      const m = computeExpectancyMetrics(byFam.get(f) || []);
      if (m.tradeCount < DIP_COMPARATIVE_MIN_N) continue;
      if (m.expectancyPct != null) peerEs.push(m.expectancyPct);
      if (m.winRate != null) peerWrs.push(m.winRate);
      if (m.mfeCapturePct != null) peerCaps.push(m.mfeCapturePct);
    }
    if (peerEs.length < 1) {
      // No peers — allow if Dip E is not deeply negative
      if (dipM.expectancyPct > -1.5) {
        return {
          allow: true,
          reason: `gov_dip_comparative_soft_allow: Dip E=${dipM.expectancyPct.toFixed(2)}% n=${dipM.tradeCount} (no peer sample)`,
        };
      }
      return { allow: false, reason: 'dip comparative: no peers + weak E' };
    }
    peerEs.sort((a, b) => a - b);
    peerWrs.sort((a, b) => a - b);
    peerCaps.sort((a, b) => a - b);
    const medE = peerEs[Math.floor(peerEs.length / 2)]!;
    const medWr =
      peerWrs.length > 0 ? peerWrs[Math.floor(peerWrs.length / 2)]! : null;
    const medCap =
      peerCaps.length > 0 ? peerCaps[Math.floor(peerCaps.length / 2)]! : null;
    const beatsE = dipM.expectancyPct >= medE;
    const beatsWr =
      medWr == null ||
      (dipM.winRate != null && dipM.winRate >= medWr - 0.02);
    const beatsCap =
      medCap == null ||
      (dipM.mfeCapturePct != null && dipM.mfeCapturePct >= medCap - 5);
    // Soft-allow when Dip beats median E and at least one of WR/capture
    if (beatsE && (beatsWr || beatsCap)) {
      return {
        allow: true,
        reason: `gov_dip_comparative_soft_allow: Dip E=${dipM.expectancyPct.toFixed(2)}% WR=${dipM.winRate != null ? (dipM.winRate * 100).toFixed(0) + '%' : '—'} vs peer med E=${medE.toFixed(2)}%`,
      };
    }
    return {
      allow: false,
      reason: `dip comparative: below peers E=${dipM.expectancyPct.toFixed(2)}% vs med ${medE.toFixed(2)}%`,
    };
  } catch {
    return { allow: false, reason: 'dip comparative: error' };
  }
}

/** Armed reclaim near level — not true late chase for ceiling / hard-skip.
 * Deny relief when detector fired, secondary is late_chase, or extension ≥ late-chase lim.
 * True near-level reclaim (ext in [−2, +4]) may still relief. */
function isArmedReclaimRelief(input: {
  armedWatch?: boolean;
  entryStyle?: string | null;
  entryStyleSecondary?: string | null;
  extensionFromLevelPct?: number | null;
  lateChase?: boolean;
  profileId?: string | null;
}): boolean {
  if (input.armedWatch !== true) return false;
  const style = String(input.entryStyle || '').toLowerCase();
  const secondary = String(input.entryStyleSecondary || '').toLowerCase();
  const ext =
    input.extensionFromLevelPct != null &&
    Number.isFinite(Number(input.extensionFromLevelPct))
      ? Number(input.extensionFromLevelPct)
      : null;
  const detectorLate = input.lateChase === true;
  const secondaryLate = /late.?chase/i.test(secondary);
  const styleLate = /late.?chase/i.test(style);
  const extLate =
    ext != null && ext >= LATE_CHASE_EXT_PCT_LIM;
  // Remapped Grad/MS reclaim with true late extension must not bypass bans
  if (detectorLate || secondaryLate || styleLate || extLate) {
    // Only true near-level reclaim may still relief
    if (ext != null && ext >= -2 && ext <= 4) return true;
    return false;
  }
  // Strongly negative E: only true near-level reclaim (ext ≤4%) may relief
  if (isStronglyNegativeExpectancy('late_chase')) {
    if (ext != null && ext >= -2 && ext <= 4) return true;
    return false;
  }
  if (/reclaim/i.test(style)) return true;
  // Extension ≤4% from level = reclaim / near-level, not chase
  if (ext != null && ext >= -2 && ext <= 4) return true;
  return false;
}

export function getRecentMixShares(
  limit = 50,
  opts?: { lateChaseCeilingWindow?: boolean }
): {
  armedShare: number;
  discShare: number;
  lateChaseShare: number;
  total: number;
} {
  // Late-chase portfolio cap uses last-50; other mix calls honor limit.
  const window = opts?.lateChaseCeilingWindow
    ? Math.max(20, Math.min(Math.max(limit, 50), 50))
    : Math.max(8, limit);
  const trades = collectExpectancyTrades().slice(-window);
  const total = trades.length || 1;
  const armed = trades.filter((t) => t.armed).length;
  // Armed reclaim mis-tags do not inflate the late-chase ceiling share —
  // but keep detector-true / lateChaseAtEntry rows in the share.
  const late = trades.filter((t) => {
    if (!(t.lateChase || t.family === 'late_chase')) return false;
    if (t.lateChase === true) return true;
    if (
      t.armed &&
      /reclaim/i.test(String(t.family || t.entryStyle || '')) &&
      !/late.?chase/i.test(String(t.entryStyle || ''))
    ) {
      return false;
    }
    return true;
  }).length;
  return {
    armedShare: armed / total,
    discShare: (total - armed) / Math.max(1, total),
    lateChaseShare: late / total,
    total: trades.length,
  };
}

/** Hard late_chase share ceiling (8% last-50). Require ≥20 closes. */
export function shouldLimitLateChaseShare(input: {
  lateChase?: boolean;
  family?: string | null;
  entryStyle?: string | null;
  entryStyleSecondary?: string | null;
  armedWatch?: boolean;
  extensionFromLevelPct?: number | null;
  profileId?: string | null;
}): { limit: boolean; reason?: string; reasonCode?: string } {
  // Armed reclaim does not hard-skip and does not count toward ceiling
  if (
    isArmedReclaimRelief({
      armedWatch: input.armedWatch,
      entryStyle: input.entryStyle,
      entryStyleSecondary: input.entryStyleSecondary,
      extensionFromLevelPct: input.extensionFromLevelPct,
      lateChase: input.lateChase,
      profileId: input.profileId,
    })
  ) {
    return { limit: false, reasonCode: 'LC_ARMED_RECLAIM_RELIEF' };
  }
  const isLate =
    input.lateChase === true ||
    String(input.entryStyle || '').toLowerCase() === 'late_chase' ||
    /late.?chase/i.test(String(input.entryStyleSecondary || '')) ||
    (input.extensionFromLevelPct != null &&
      Number.isFinite(Number(input.extensionFromLevelPct)) &&
      Number(input.extensionFromLevelPct) >= LATE_CHASE_EXT_PCT_LIM) ||
    normalizeExpectancyFamily(input.family || input.entryStyle) ===
      'late_chase';
  if (!isLate) return { limit: false };

  // Temporary disable countdown (1.2.257)
  const rem = syncLateChaseDisableCountdown();
  if (rem > 0 && !isAdmissionBaselineV235()) {
    return {
      limit: true,
      reason: `Entry Skill: late_chase disabled (${rem} closes left)`,
      reasonCode: 'LC_DISABLE_COUNTDOWN',
    };
  }

  // Entry Skill: hard-skip late_chase primary even below sample floor
  if (
    !isAdmissionBaselineV235() &&
    (LATE_CHASE_HARD_SKIP_ALL_PROFILES ||
      QUALITY_LATE_CHASE_PROFILES.has(String(input.profileId || '')))
  ) {
    return {
      limit: true,
      reason: `Entry Skill: hard-skip late_chase primary (${input.profileId || 'any'})`,
      reasonCode: 'LC_HARD_SKIP_ALL',
    };
  }
  const mix = getRecentMixShares(50, { lateChaseCeilingWindow: true });
  if (mix.total >= 20 && mix.lateChaseShare > LATE_CHASE_MAX_SHARE) {
    return {
      limit: true,
      reason: `Late-chase share ${(mix.lateChaseShare * 100).toFixed(0)}% > ${(LATE_CHASE_MAX_SHARE * 100).toFixed(0)}% ceiling`,
      reasonCode: 'LC_SHARE_CAP',
    };
  }
  return { limit: false };
}

function countLiveArmedWatches(): number {
  let n = 0;
  try {
    const { getScalperSetupWatchStatus } =
      require('./scalperSetupWatch') as typeof import('./scalperSetupWatch');
    const sw = getScalperSetupWatchStatus(40);
    n += (sw.entries || []).filter((e) => e.status === 'armed').length;
  } catch {
    /* soft */
  }
  try {
    const { getActiveDipWatchesSnapshot } =
      require('./dipSetupWatch') as typeof import('./dipSetupWatch');
    const dw = getActiveDipWatchesSnapshot();
    n += (dw.allActive || []).filter((e) => e.status === 'armed').length;
  } catch {
    /* soft */
  }
  try {
    const { getMigrationGradWatchStatus } =
      require('./migrationGradWatch') as typeof import('./migrationGradWatch');
    const gw = getMigrationGradWatchStatus(40);
    n += (gw.entries || []).filter((e) => e.status === 'armed').length;
  } catch {
    /* soft */
  }
  try {
    const { getTrendSetupWatchStatus } =
      require('./trendSetupWatch') as typeof import('./trendSetupWatch');
    const tw = getTrendSetupWatchStatus(40);
    n += (tw.entries || []).filter((e) => e.status === 'armed').length;
  } catch {
    /* soft */
  }
  return n;
}

function touchFailRateElevated(): boolean {
  try {
    const { setupWatchEventStats } =
      require('./setupWatchEvents') as typeof import('./setupWatchEvents');
    const stats = setupWatchEventStats();
    const rate = stats.touchFailRate;
    return rate != null && rate >= TOUCH_FAIL_ELEVATED;
  } catch {
    return false;
  }
}

/**
 * Armed funnel stuck → treat as no effective arms for hard-skip-all.
 * Require openRate evidence (known rate < 20%) or very-thin book without
 * rate samples — openCount&lt;15 alone no longer zeros arms.
 */
export function stuckArmedReliefActive(): boolean {
  let openCount = 0;
  try {
    const { paperTrader: pt } =
      require('./paperTrader') as typeof import('./paperTrader');
    openCount = pt.getOpenPositions().length;
  } catch {
    openCount = 0;
  }
  let armedOpenRate: number | null = null;
  try {
    const { setupWatchEventStats } =
      require('./setupWatchEvents') as typeof import('./setupWatchEvents');
    const stats = setupWatchEventStats();
    armedOpenRate = stats.openRate;
  } catch {
    armedOpenRate = null;
  }
  const poorOpenRate =
    armedOpenRate != null && armedOpenRate < STUCK_OPEN_RATE;
  const veryThinNoRateEvidence =
    openCount < STUCK_VERY_THIN_OPEN_COUNT && armedOpenRate == null;
  return poorOpenRate || veryThinNoRateEvidence || touchFailRateElevated();
}

/** Live armed watches that are still convertible (not stuck). */
export function countLiveTriggerableArmed(): number {
  const live = countLiveArmedWatches();
  if (live <= 0) return 0;
  if (stuckArmedReliefActive()) return 0;
  return live;
}

/**
 * Steady/HWR-relevant triggerable arms (Dip medium/majors parks preferring Steady,
 * or preferredProfileId steady/hwr). Used so Scalper/MS arms alone do not silence
 * Steady/HWR discretionary fallback.
 */
function countSteadyHwrTriggerableArmed(): number {
  if (stuckArmedReliefActive()) return 0;
  let n = 0;
  try {
    const { getActiveDipWatchesSnapshot } =
      require('./dipSetupWatch') as typeof import('./dipSetupWatch');
    const dw = getActiveDipWatchesSnapshot();
    for (const e of dw.allActive || []) {
      if (e.status !== 'armed') continue;
      const src = String(e.source || '').toLowerCase();
      const prefer = String(e.preferredProfileId || '').toLowerCase();
      if (
        src === 'medium' ||
        src === 'majors' ||
        prefer === 'steady_compounder' ||
        prefer === 'high_win_rate'
      ) {
        n += 1;
      }
    }
  } catch {
    /* soft */
  }
  return n;
}

/** Disc fallback allowed when no effective triggerable arms (never absolute freeze). */
export function isFallbackDiscAllowed(): boolean {
  return countLiveTriggerableArmed() === 0;
}

/**
 * Armed-or-fallback disc mix:
 * - Triggerable arms: hard-skip fast + quality disc when disc > cap (size penalty otherwise).
 * - Steady/HWR: only hard-skip disc when Steady/HWR arms themselves are live (Scalper/MS arms alone do not silence).
 * - No triggerable arms: limited cowboy fallback up to cap; fast relief (cap+15%) if still overtrading.
 * Never hard-skip all discretionary. Slider ignored under Baseline v235 (caller gates).
 */
export function shouldLimitDiscretionaryMix(input: {
  armedWatch?: boolean;
  profileId?: string | null;
}): { limit: boolean; reason?: string } {
  if (input.armedWatch === true) return { limit: false };
  const mix = getRecentMixShares(50);
  if (mix.total < 10) return { limit: false };
  const triggerable = countLiveTriggerableArmed();
  const pid = String(input.profileId || '');
  const cap = discShareCap();
  const relief = discShareCapRelief();
  const armedPct = Math.round(armedShareTarget() * 100);
  const isSteadyHwr =
    pid === 'steady_compounder' || pid === 'high_win_rate';

  if (triggerable > 0) {
    // Armed path: fast keeps strict DISC_SHARE_CAP; quality normally gets 20% floor.
    // Under E-boost (E<0 → 90% armed): quality also uses strict discShareCap (10%).
    if (!isMixThrottledDiscProfile(pid)) return { limit: false };
    // Steady/HWR: if their own arms are empty, allow limited quality disc fallback
    // rather than total silence while Scalper/MS arms occupy the book.
    // Keep this even under E-boost so quality parks are not frozen (1.2.269).
    const eBoost = isArmedTargetEBoostActive();
    if (isSteadyHwr && countSteadyHwrTriggerableArmed() === 0) {
      return { limit: false };
    }
    const kind = FAST_DISC_PROFILES.has(pid) ? 'fast' : 'quality';
    const effectiveCap =
      kind === 'quality' && !eBoost ? Math.max(cap, 0.2) : cap;
    if (mix.discShare <= effectiveCap) return { limit: false };
    return {
      limit: true,
      reason: `Discretionary mix ${(mix.discShare * 100).toFixed(0)}% > ${(effectiveCap * 100).toFixed(0)}% with ${triggerable} triggerable armed — skip ${kind} disc (armed target ${armedPct}%${eBoost ? ', E-boost' : ''})`,
    };
  }

  // Fallback: allow disc up to cap; relief only if still overtrading fast
  if (mix.discShare < cap) return { limit: false };
  if (!FAST_DISC_PROFILES.has(pid)) return { limit: false };
  if (mix.discShare < relief) {
    // Between cap–relief: allow (fallback room); size penalty handles quality
    return { limit: false };
  }
  return {
    limit: true,
    reason: `Discretionary mix ${(mix.discShare * 100).toFixed(0)}% ≥ ${(relief * 100).toFixed(0)}% fallback relief — skip fast disc (no triggerable arms)`,
  };
}

/** Size penalty for non-fast discretionary when disc share is elevated. */
export function expectancyLiftSizePenaltyForDiscMix(input: {
  armedWatch?: boolean;
  profileId?: string | null;
}): { mult: number; note: string } {
  if (input.armedWatch === true) return { mult: 1, note: '' };
  const pid = String(input.profileId || '');
  if (FAST_DISC_PROFILES.has(pid)) return { mult: 1, note: '' };
  try {
    const mix = getRecentMixShares(50);
    const triggerable = countLiveTriggerableArmed();
    const cap = discShareCap();
    if (mix.total >= 10 && mix.discShare >= cap) {
      return {
        mult: DISC_MIX_SIZE_PENALTY,
        note: `disc-mix×${DISC_MIX_SIZE_PENALTY.toFixed(2)} (disc ${(mix.discShare * 100).toFixed(0)}%≥${(cap * 100).toFixed(0)}%${triggerable === 0 ? ' · fallback' : ''})`,
      };
    }
  } catch {
    /* soft */
  }
  return { mult: 1, note: '' };
}

export function computeTradePermissionScore(input: {
  armedWatch?: boolean;
  triggerConfirm?: boolean;
  family?: string | null;
  entryStyle?: string | null;
  lateChase?: boolean;
  extensionFromLevelPct?: number | null;
  dnaMatch?: boolean | null;
  profileId?: string | null;
  tradeProfileScore?: number | null;
  /** Native Dip soft-pass under restricted governor — milder haircut. */
  softPassNative?: boolean;
}): number {
  let score = 50;
  const armed = input.armedWatch === true;
  if (armed) score += 18;
  else score -= 8;
  if (input.triggerConfirm === true) score += 12;
  else if (input.triggerConfirm === false) score -= 10;

  const family = normalizeExpectancyFamily(
    input.family || input.entryStyle || 'discretionary_other'
  );
  const gov = getFamilyGovernorState(family);
  if (gov === 'promoted') score += 10;
  else if (gov === 'down_ranked') score -= 12;
  else if (gov === 'restricted') {
    // Native Dip soft-allow: milder than generic −22 so identity can trade
    const dipNativeSoft =
      input.softPassNative === true &&
      (String(input.profileId || '') === 'dip_buyer' ||
        family === 'support_dip_reclaim');
    score -= dipNativeSoft ? 10 : 22;
  }

  const ext =
    input.extensionFromLevelPct != null &&
    Number.isFinite(Number(input.extensionFromLevelPct))
      ? Number(input.extensionFromLevelPct)
      : null;
  if (input.lateChase === true || family === 'late_chase') score -= 18;
  else if (ext != null) {
    if (ext >= 0 && ext <= 4) score += 10; // reclaim / near level
    else if (ext > 8) score -= 12; // chase extension
    else if (ext < 0 && ext >= -2) score += 6; // undercut reclaim path
  }

  if (input.dnaMatch === true) score += 10;
  else if (input.dnaMatch === false) score -= 14;
  if (
    input.tradeProfileScore != null &&
    Number.isFinite(Number(input.tradeProfileScore))
  ) {
    score += clamp((Number(input.tradeProfileScore) - 50) / 5, -8, 8);
  }

  const floor = armed ? PERM_FLOOR_ARMED : PERM_FLOOR_DISC;
  return Math.round(clamp(score, floor, 100));
}

export function shouldSoftSkipPermissionScore(score: number, armed: boolean): {
  skip: boolean;
  reason?: string;
} {
  const floor = armed ? PERM_FLOOR_ARMED + 5 : PERM_FLOOR_DISC;
  if (score < floor) {
    return {
      skip: true,
      reason: `Trade permission score ${score} < ${floor}`,
    };
  }
  return { skip: false };
}

/** Habit floor when Scalper WR/PF weak or MS family gov down (discretionary). */
const HABIT_SIZE_LO = 0.5;

/** Expectancy-weighted size multiplier 0.7–1.15 (habit cuts may go to 0.5). */
export function expectancySizeMultiplier(input: {
  profileId?: string | null;
  family?: string | null;
  armedWatch?: boolean;
  softPassNative?: boolean;
}): { mult: number; note: string } {
  if (isAdmissionBaselineV235()) {
    return { mult: 1, note: 'expectancy size baseline v235' };
  }
  try {
    const trades = collectExpectancyTrades();
    const pid = String(input.profileId || '');
    const family = normalizeExpectancyFamily(input.family);
    const slice = trades
      .filter((t) =>
        pid ? t.profileId === pid : t.family === family
      )
      .slice(-DEFAULT_EXPECTANCY_WINDOW);
    const m = computeExpectancyMetrics(slice);
    const notes: string[] = [];
    let mult = 1;
    if (m.tradeCount < 8 || m.expectancyPct == null) {
      const discPen = expectancyLiftSizePenaltyForDiscMix({
        armedWatch: input.armedWatch,
        profileId: input.profileId,
      });
      if (discPen.mult !== 1) {
        mult = discPen.mult;
        if (discPen.note) notes.push(discPen.note);
      } else {
        notes.push('expectancy size n/a');
      }
    } else {
      if (m.expectancyPct >= 1.0) mult = 1.12;
      else if (m.expectancyPct >= 0.4) mult = 1.05;
      else if (m.expectancyPct >= 0) mult = 1.0;
      else if (m.expectancyPct >= -0.5) mult = 0.9;
      else mult = 0.75;
      const gov = getFamilyGovernorState(family);
      if (gov === 'promoted') mult = Math.min(SIZE_MULT_HI, mult + 0.03);
      if (gov === 'down_ranked') mult = Math.max(SIZE_MULT_LO, mult - 0.08);
      if (gov === 'restricted') {
        // Native Dip soft-allow: milder than generic ×0.85
        const dipNativeSoft =
          input.softPassNative === true &&
          (pid === 'dip_buyer' || family === 'support_dip_reclaim');
        mult = Math.max(
          SIZE_MULT_LO,
          mult * (dipNativeSoft ? 0.9 : 0.85)
        );
        if (dipNativeSoft) notes.push('dip_gov_soft_allow size×0.9');
      }
      if (input.armedWatch === true) mult = Math.min(SIZE_MULT_HI, mult + 0.02);
      const discPen = expectancyLiftSizePenaltyForDiscMix({
        armedWatch: input.armedWatch,
        profileId: input.profileId,
      });
      if (discPen.mult !== 1) mult *= discPen.mult;
      mult = clamp(mult, SIZE_MULT_LO, SIZE_MULT_HI);
      notes.push(
        `expectancy×${mult.toFixed(2)} (E=${m.expectancyPct.toFixed(2)}%)`
      );
      if (discPen.note) notes.push(discPen.note);
    }

    // Scalper habit: discretionary only — cut size further when WR <25%, PF low, or E < 0
    if (pid === 'scalper' && input.armedWatch !== true) {
      const wr =
        m.tradeCount >= 6 && m.winRate != null ? m.winRate : null;
      const pf = m.profitFactor;
      const weakWr = wr != null && wr < 0.25;
      const weakPf = pf != null && Number.isFinite(pf) && pf < 0.85;
      const negE =
        m.expectancyPct != null &&
        Number.isFinite(m.expectancyPct) &&
        m.expectancyPct < 0;
      if (weakWr || weakPf || negE) {
        mult = clamp(mult * 0.65, HABIT_SIZE_LO, 0.7);
        const ePct = m.expectancyPct!;
        const note =
          `scalper_size_downrank_active (WR ${
            wr != null ? `${(wr * 100).toFixed(0)}%` : 'n/a'
          }${weakPf && pf != null ? ` · PF ${pf.toFixed(2)}` : ''}` +
          `${negE ? ` · E ${ePct.toFixed(2)}%` : ''})`;
        notes.push(note);
        console.log(`[expectancy] ${note}`);
      }
    }

    // MS habit: smaller size when migration_hold_reclaim weak OR MS E < 0
    if (pid === 'migration_sniper') {
      const migGov = getFamilyGovernorState('migration_hold_reclaim');
      if (migGov === 'down_ranked' || migGov === 'restricted') {
        mult = clamp(
          mult * (migGov === 'restricted' ? 0.5 : 0.6),
          HABIT_SIZE_LO,
          SIZE_MULT_HI
        );
        notes.push(`MS habit size↓ (${migGov} migration_hold_reclaim)`);
      }
      const negMsE =
        m.expectancyPct != null &&
        Number.isFinite(m.expectancyPct) &&
        m.expectancyPct < 0 &&
        m.tradeCount >= 6;
      if (negMsE && input.armedWatch !== true) {
        mult = clamp(mult * 0.7, HABIT_SIZE_LO, 0.65);
        notes.push(
          `MS size↓ E=${m.expectancyPct!.toFixed(2)}% (disc while E<0)`
        );
      } else if (negMsE) {
        mult = clamp(mult * 0.85, HABIT_SIZE_LO, SIZE_MULT_HI);
        notes.push(`MS size↓ E=${m.expectancyPct!.toFixed(2)}% (armed)`);
      }
    }

    // Dip top-loss habit: when Dip is ≥25% of abs losses and combined E < 0
    if (pid === 'dip_buyer') {
      try {
        const all = collectExpectancyTrades().slice(-50);
        const combined = computeExpectancyMetrics(all);
        let totalLossAbs = 0;
        let dipLossAbs = 0;
        for (const t of all) {
          const pnl = Number(t.pnlSol) || 0;
          if (pnl >= 0) continue;
          const abs = Math.abs(pnl);
          totalLossAbs += abs;
          if (t.profileId === 'dip_buyer') dipLossAbs += abs;
        }
        const share =
          totalLossAbs > 1e-12 ? dipLossAbs / totalLossAbs : 0;
        const negE =
          combined.expectancyPct != null &&
          combined.expectancyPct < 0 &&
          combined.tradeCount >= 8;
        if (negE && share >= 0.25) {
          if (input.armedWatch !== true) {
            mult = clamp(mult * 0.6, HABIT_SIZE_LO, 0.7);
          } else {
            mult = clamp(mult * 0.75, HABIT_SIZE_LO, SIZE_MULT_HI);
          }
          notes.push(
            `dip_top_loss_size_down share=${(share * 100).toFixed(0)}%`
          );
        }
      } catch {
        /* soft */
      }
    }

    return {
      mult: Math.round(mult * 100) / 100,
      note: notes.join(' · ') || 'expectancy size',
    };
  } catch {
    return { mult: 1, note: 'expectancy size fail-soft' };
  }
}

function oneSetupFamilyFromProfile(
  profileId: string
): 'scalper' | 'dip' | 'grad' | 'trend' {
  const p = String(profileId || '');
  if (p === 'scalper') return 'scalper';
  if (p === 'migration_sniper') return 'grad';
  if (p === 'trend_rider') return 'trend';
  return 'dip';
}

function recordOneSetupLockEvent(
  kind: 'lock_acquired' | 'lock_released',
  mint: string,
  profileId: string | undefined,
  reason?: string
): void {
  try {
    const { recordSetupWatchEvent } =
      require('./setupWatchEvents') as typeof import('./setupWatchEvents');
    recordSetupWatchEvent({
      kind,
      family: oneSetupFamilyFromProfile(profileId || 'dip_buyer'),
      mint,
      symbol: mint.slice(0, 8),
      profileId: profileId || null,
      reason: reason ? String(reason).slice(0, 120) : undefined,
    });
  } catch {
    /* optional */
  }
}

/** One-setup-one-profile: mint lock while preferred watch is active (TTL 8m). */
export function mintOneSetupProfileLock(
  mint: string,
  profileId: string,
  ttlMs = ONE_SETUP_TTL_MS
): void {
  const m = String(mint || '').trim();
  const p = String(profileId || '').trim();
  if (!m || !p) return;
  const prev = oneSetupLocks.get(m);
  const isNewMint = !prev;
  oneSetupLocks.set(m, { profileId: p, untilMs: Date.now() + ttlMs });
  // Log acquire only on NEW mint — remint-while-active must not spam.
  if (isNewMint) {
    oneSetupLockFunnel.acquired += 1;
    console.log(
      `[one-setup] acquired mint=${m.slice(0, 8)}… profile=${p}`
    );
    recordOneSetupLockEvent('lock_acquired', m, p, 'acquired');
  }
}

export function clearOneSetupProfileLock(
  mint: string,
  reason?: string
): void {
  const m = String(mint || '').trim();
  if (!m) return;
  const prev = oneSetupLocks.get(m);
  if (!prev) return;
  oneSetupLocks.delete(m);
  const why = reason ? String(reason).slice(0, 120) : undefined;
  oneSetupLockFunnel.released += 1;
  const whyLower = (why || '').toLowerCase();
  if (
    whyLower.includes('triggered') ||
    whyLower.includes('opened') ||
    whyLower === 'trigger'
  ) {
    oneSetupLockFunnel.opened += 1;
  } else if (
    whyLower.includes('expired') ||
    whyLower.includes('ttl')
  ) {
    oneSetupLockFunnel.expired += 1;
  }
  if (why) {
    console.log(`[one-setup] released ${m.slice(0, 8)}… · ${why}`);
  }
  recordOneSetupLockEvent('lock_released', m, prev.profileId, why);
}

/** Observe-only one-setup lock→open/expire funnel (session counters). */
export function getOneSetupLockFunnel(): typeof oneSetupLockFunnel & {
  held: number;
} {
  return { ...oneSetupLockFunnel, held: countOneSetupLocksHeld() };
}

export function getOneSetupPreferredProfile(
  mint: string
): string | null {
  const row = oneSetupLocks.get(String(mint || '').trim());
  if (!row) return null;
  if (row.untilMs < Date.now()) {
    clearOneSetupProfileLock(mint, 'ttl expired');
    return null;
  }
  return row.profileId;
}

export function countOneSetupLocksHeld(): number {
  const now = Date.now();
  let n = 0;
  for (const [mint, row] of [...oneSetupLocks.entries()]) {
    if (row.untilMs < now) {
      clearOneSetupProfileLock(mint, 'ttl expired');
      continue;
    }
    n += 1;
  }
  return n;
}

export function countOneSetupLocksForProfile(profileId: string): number {
  const pid = String(profileId || '');
  const now = Date.now();
  let n = 0;
  for (const [mint, row] of [...oneSetupLocks.entries()]) {
    if (row.untilMs < now) {
      clearOneSetupProfileLock(mint, 'ttl expired');
      continue;
    }
    if (row.profileId === pid) n += 1;
  }
  return n;
}

/** Block other-profile discretionary when mint is locked to preferred P. */
export function shouldBlockOtherProfileDiscretionary(input: {
  mint?: string | null;
  profileId?: string | null;
  armedWatch?: boolean;
}): { block: boolean; reason?: string; preferred?: string } {
  const mint = String(input.mint || '');
  const pid = String(input.profileId || '');
  if (!mint || !pid) return { block: false };
  // Refresh from live watches
  try {
    syncOneSetupLocksFromWatches();
  } catch {
    /* soft */
  }
  const preferred = getOneSetupPreferredProfile(mint);
  if (!preferred) return { block: false };
  if (preferred === pid) return { block: false, preferred };
  if (input.armedWatch === true && preferred === pid) {
    return { block: false, preferred };
  }
  // Other profile discretionary blocked; other-profile armed also blocked (one setup)
  const now = Date.now();
  const lastHeld = oneSetupHeldLogAt.get(mint) || 0;
  if (now - lastHeld >= ONE_SETUP_HELD_LOG_MS) {
    oneSetupHeldLogAt.set(mint, now);
    console.log(
      `[one-setup] mint held mint=${mint.slice(0, 8)}… preferred=${preferred} blocked=${pid}`
    );
  }
  return {
    block: true,
    preferred,
    reason: `One-setup lock: ${mint.slice(0, 6)}… reserved for ${preferred}`,
  };
}

function profileEnabledForOneSetup(profileId: string): boolean {
  try {
    const { config } = require('./config') as typeof import('./config');
    if (config.tradeProfiles?.profiles?.[profileId] === false) return false;
  } catch {
    /* soft */
  }
  return true;
}

/**
 * Sync locks from live *armed* watches only (1.2.248); watching no longer remints.
 * Prune inactive mints; clear when preferred profile is OFF.
 */
export function syncOneSetupLocksFromWatches(): void {
  const active = new Map<string, string>();
  try {
    const { getScalperSetupWatchStatus } =
      require('./scalperSetupWatch') as typeof import('./scalperSetupWatch');
    const sw = getScalperSetupWatchStatus(40);
    for (const e of sw.entries || []) {
      if (e.status !== 'armed') continue;
      const pref = String(e.preferredProfileId || 'scalper');
      if (!profileEnabledForOneSetup(pref)) {
        clearOneSetupProfileLock(e.mint, `profile off (${pref})`);
        continue;
      }
      active.set(e.mint, pref);
    }
  } catch {
    /* soft */
  }
  try {
    const { getActiveDipWatchesSnapshot } =
      require('./dipSetupWatch') as typeof import('./dipSetupWatch');
    const dw = getActiveDipWatchesSnapshot();
    for (const e of dw.allActive || []) {
      if (e.status !== 'armed') continue;
      const pref = String(
        (e as { preferredProfileId?: string }).preferredProfileId || 'dip_buyer'
      );
      if (!profileEnabledForOneSetup(pref)) {
        clearOneSetupProfileLock(e.mint, `profile off (${pref})`);
        continue;
      }
      active.set(e.mint, pref);
    }
  } catch {
    /* soft */
  }
  try {
    const { getMigrationGradWatchStatus } =
      require('./migrationGradWatch') as typeof import('./migrationGradWatch');
    const gw = getMigrationGradWatchStatus(40);
    for (const e of gw.entries || []) {
      if (e.status !== 'armed') continue;
      if (!profileEnabledForOneSetup('migration_sniper')) {
        clearOneSetupProfileLock(e.mint, 'profile off (migration_sniper)');
        continue;
      }
      active.set(e.mint, 'migration_sniper');
    }
  } catch {
    /* soft */
  }
  try {
    const { getTrendSetupWatchStatus } =
      require('./trendSetupWatch') as typeof import('./trendSetupWatch');
    const tw = getTrendSetupWatchStatus(40);
    for (const e of tw.entries || []) {
      if (e.status !== 'armed') continue;
      if (!profileEnabledForOneSetup('trend_rider')) {
        clearOneSetupProfileLock(e.mint, 'profile off (trend_rider)');
        continue;
      }
      active.set(e.mint, 'trend_rider');
    }
  } catch {
    /* soft */
  }
  for (const mint of [...oneSetupLocks.keys()]) {
    if (!active.has(mint)) {
      clearOneSetupProfileLock(mint, 'inactive mint prune');
    }
  }
  for (const [mint, pref] of active) {
    mintOneSetupProfileLock(mint, pref);
  }
}

/** Build per-profile Entry Skill funnel counters for status / Zion. */
export function buildEntrySkillByProfile(): Record<
  string,
  {
    armed: number;
    triggered: number;
    opened: number;
    expired: number;
    locksHeld: number;
    fallbackDiscAllowed: boolean;
  }
> {
  const fallback = isFallbackDiscAllowed();
  const out: Record<
    string,
    {
      armed: number;
      triggered: number;
      opened: number;
      expired: number;
      locksHeld: number;
      fallbackDiscAllowed: boolean;
    }
  > = {};
  const ensure = (id: string) => {
    if (!out[id]) {
      out[id] = {
        armed: 0,
        triggered: 0,
        opened: 0,
        expired: 0,
        locksHeld: 0,
        fallbackDiscAllowed: fallback,
      };
    }
    return out[id]!;
  };
  try {
    const { listSetupWatchEvents } =
      require('./setupWatchEvents') as typeof import('./setupWatchEvents');
    const since = Date.now() - 6 * 60 * 60_000;
    for (const e of listSetupWatchEvents(100)) {
      if (e.at < since) continue;
      const pid = String(
        e.profileId ||
          (e.family === 'dip'
            ? 'dip_buyer'
            : e.family === 'grad'
              ? 'migration_sniper'
              : e.family === 'trend'
                ? 'trend_rider'
                : 'scalper')
      );
      const row = ensure(pid);
      if (e.kind === 'triggered') row.triggered += 1;
      if (e.kind === 'trigger_opened') row.opened += 1;
      if (e.kind === 'watch_expired') row.expired += 1;
    }
  } catch {
    /* soft */
  }
  try {
    const { getScalperSetupWatchStatus } =
      require('./scalperSetupWatch') as typeof import('./scalperSetupWatch');
    const sw = getScalperSetupWatchStatus(40);
    for (const e of sw.entries || []) {
      if (e.status !== 'armed') continue;
      const id = String(e.preferredProfileId || 'scalper');
      ensure(id).armed += 1;
    }
  } catch {
    /* soft */
  }
  try {
    const { getActiveDipWatchesSnapshot } =
      require('./dipSetupWatch') as typeof import('./dipSetupWatch');
    const dw = getActiveDipWatchesSnapshot();
    const n = (dw.allActive || []).filter((e) => e.status === 'armed').length;
    if (n) ensure('dip_buyer').armed = n;
  } catch {
    /* soft */
  }
  try {
    const { getMigrationGradWatchStatus } =
      require('./migrationGradWatch') as typeof import('./migrationGradWatch');
    const gw = getMigrationGradWatchStatus(40);
    const n = (gw.entries || []).filter((e) => e.status === 'armed').length;
    if (n) ensure('migration_sniper').armed = n;
  } catch {
    /* soft */
  }
  try {
    const { getTrendSetupWatchStatus } =
      require('./trendSetupWatch') as typeof import('./trendSetupWatch');
    const tw = getTrendSetupWatchStatus(40);
    const n = (tw.entries || []).filter((e) => e.status === 'armed').length;
    if (n) ensure('trend_rider').armed = n;
  } catch {
    /* soft */
  }
  for (const id of Object.keys(out)) {
    out[id]!.locksHeld = countOneSetupLocksForProfile(id);
    out[id]!.fallbackDiscAllowed = fallback;
  }
  return out;
}

/**
 * Entry Skill admit facade — baseline gating + late-chase / disc-mix / governor /
 * one-setup / permission. v235 admits always (observe-only) but still stamps scores.
 */
export function evaluateEntrySelectivity(
  ctx: EntrySelectivityCtx
): EntrySelectivityResult {
  const baselineV235 = isAdmissionBaselineV235();
  const armedWatch = ctx.armedWatch === true;
  const entryStyle = String(ctx.entryStyle || '');
  const lateChase = ctx.lateChase === true || entryStyle === 'late_chase';
  const entryPath =
    ctx.entryPath || (armedWatch ? 'armed_trigger' : 'discretionary');
  const reasons: string[] = [];
  const chips: string[] = [];
  const reasonCodes: string[] = [];

  const family = admitFamilyForGovernor({
    entryStyle,
    lateChase,
    profileId: ctx.profileId,
    armedWatch,
    entryPath,
    setupWatchFamily: ctx.setupWatchFamily,
  });
  const passerLate = family === 'late_chase';
  // Broad late (boolean OR family) — closes flag-only bypass of Entry Skill hard-skip
  const broadLate = lateChase || passerLate;
  if (lateChase && !passerLate) reasonCodes.push('LC_FLAG_ONLY');

  if (!baselineV235) {
    const lateLim = shouldLimitLateChaseShare({
      lateChase: broadLate,
      family: broadLate ? 'late_chase' : family,
      entryStyle: broadLate ? 'late_chase' : entryStyle,
      armedWatch,
      extensionFromLevelPct: ctx.extensionFromLevelPct,
      profileId: ctx.profileId,
    });
    if (lateLim.limit) {
      reasons.push(lateLim.reason || 'Late-chase share ceiling');
      chips.push('late_chase');
      if (lateLim.reasonCode) {
        reasonCodes.push(lateLim.reasonCode);
        chips.push(lateLim.reasonCode);
      }
      return {
        admit: false,
        reasons,
        permission: 0,
        sizeMult: 1,
        family: broadLate ? 'late_chase' : family,
        chips,
        reasonCodes,
        governorState: getFamilyGovernorState(
          broadLate ? 'late_chase' : family
        ),
        governorInfluenced: true,
      };
    }

    // Historical zero-MFE / DOA pattern skip (profile last-40)
    const zm = shouldBlockZeroMfePattern({
      profileId: ctx.profileId,
      entryStyle,
      setupWatchFamily: ctx.setupWatchFamily,
      armedWatch,
      entryPath,
    });
    if (zm.block) {
      noteZeroMfeEntryBlocked();
      reasons.push(zm.reason || 'zero_mfe_entry_blocked');
      chips.push('zero_mfe_entry_blocked');
      reasonCodes.push('ZERO_MFE_PATTERN');
      return {
        admit: false,
        reasons,
        permission: 0,
        sizeMult: 1,
        family,
        chips,
        reasonCodes,
        governorState: getFamilyGovernorState(family),
        governorInfluenced: true,
      };
    }
  }

  const gov = shouldSkipFamilyGovernor({
    family,
    entryStyle: broadLate ? 'late_chase' : entryStyle,
    lateChase: broadLate,
    armedWatch,
    profileId: ctx.profileId,
    entryPath,
    setupWatchFamily: ctx.setupWatchFamily,
  });
  if (!baselineV235 && gov.softPassNative) {
    chips.push('gov_soft_pass');
    if (gov.reasonCode) {
      chips.push(gov.reasonCode);
      reasonCodes.push(gov.reasonCode);
    }
    reasons.push(
      gov.reason || `governor:restricted soft-pass native ${ctx.profileId}`
    );
  }
  if (!baselineV235 && gov.skip) {
    reasons.push(gov.reason || 'Family governor restrict');
    chips.push('governor');
    if (gov.reasonCode) {
      reasonCodes.push(gov.reasonCode);
      chips.push(gov.reasonCode);
    } else if (gov.family === 'late_chase') {
      reasonCodes.push('LC_GOV_RESTRICTED');
    }
    return {
      admit: false,
      reasons,
      permission: 0,
      sizeMult: 1,
      family: gov.family || family,
      chips,
      reasonCodes,
      governorState: gov.state,
      governorInfluenced: true,
    };
  }

  if (!baselineV235) {
    const discMix = shouldLimitDiscretionaryMix({
      armedWatch,
      profileId: ctx.profileId,
    });
    if (discMix.limit) {
      reasons.push(discMix.reason || 'Armed mix disc cap');
      chips.push('disc_mix');
      reasonCodes.push('ES_DISC_MIX');
      return {
        admit: false,
        reasons,
        permission: 0,
        sizeMult: 1,
        family: gov.family || family,
        chips,
        reasonCodes,
        governorState: gov.state,
        governorInfluenced: true,
      };
    }
    const lock = shouldBlockOtherProfileDiscretionary({
      mint: ctx.mint,
      profileId: ctx.profileId,
      armedWatch,
    });
    if (lock.block) {
      reasons.push(lock.reason || 'One-setup-one-profile');
      chips.push('one_setup');
      return {
        admit: false,
        reasons,
        permission: 0,
        sizeMult: 1,
        family: gov.family || family,
        chips,
        reasonCodes,
        governorState: gov.state,
        governorInfluenced: true,
      };
    }
  }

  const effectiveFamily = gov.family || family;
  let dnaMatch: boolean | null = null;
  if (ctx.detectedEntryStyle != null) {
    dnaMatch =
      classifyTradeFamily({
        entryStyle: ctx.detectedEntryStyle,
        profileId: ctx.profileId,
        armedWatch,
      }) === effectiveFamily ||
      String(ctx.detectedEntryStyle) === entryStyle;
  }
  const permission = computeTradePermissionScore({
    armedWatch,
    triggerConfirm: ctx.triggerConfirm === true,
    family: effectiveFamily,
    entryStyle,
    lateChase: broadLate,
    extensionFromLevelPct: ctx.extensionFromLevelPct,
    dnaMatch,
    profileId: ctx.profileId,
    tradeProfileScore: ctx.tradeProfileScore,
    softPassNative: gov.softPassNative === true,
  });

  // Late-chase quality floor (defense if hard-skip somehow off / Baseline edge)
  if (
    !baselineV235 &&
    broadLate &&
    permission < LATE_CHASE_PERM_FLOOR
  ) {
    reasons.push(
      `Entry Skill: late_chase permission ${permission} < ${LATE_CHASE_PERM_FLOOR}`
    );
    chips.push('late_chase');
    reasonCodes.push('LC_QUALITY_FLOOR');
    chips.push('LC_QUALITY_FLOOR');
    return {
      admit: false,
      reasons,
      permission,
      sizeMult: 1,
      family: 'late_chase',
      chips,
      reasonCodes,
      governorState: gov.state,
      governorInfluenced: true,
    };
  }

  if (!baselineV235) {
    const softPerm = shouldSoftSkipPermissionScore(permission, armedWatch);
    if (softPerm.skip) {
      reasons.push(softPerm.reason || 'Permission score');
      chips.push('permission');
      reasonCodes.push('ES_PERM_FLOOR');
      return {
        admit: false,
        reasons,
        permission,
        sizeMult: 1,
        family: effectiveFamily,
        chips,
        reasonCodes,
        governorState: gov.state,
        governorInfluenced: true,
      };
    }
  }

  const sz = expectancySizeMultiplier({
    profileId: ctx.profileId,
    family: effectiveFamily,
    armedWatch,
    softPassNative: gov.softPassNative === true,
  });
  if (baselineV235) chips.push('baseline_v235');
  else chips.push('entry_skill');
  if (armedWatch) chips.push('armed');
  if (ctx.triggerConfirm === true) chips.push('trigger_confirm');
  if (gov.softPassNative) chips.push('gov_dip_native_soft_allow');
  if (sz.note.includes('dip_top_loss_size_down')) chips.push('dip_top_loss_size_down');
  try {
    const pid = String(ctx.profileId || '');
    if (
      pid === 'scalper' ||
      pid === 'momentum_burst' ||
      pid === 'reversal_scalper'
    ) {
      chips.push('habit_fast');
    }
    if (pid === 'migration_sniper') chips.push('habit_ms');
    if (broadLate) chips.push('habit_late_chase');
  } catch {
    /* soft */
  }

  return {
    admit: true,
    reasons,
    permission,
    sizeMult: sz.mult,
    family: effectiveFamily,
    chips,
    reasonCodes: reasonCodes.length ? reasonCodes : undefined,
    governorState: gov.state,
    softPassNative: gov.softPassNative,
    governorInfluenced:
      !baselineV235 && (gov.state !== 'neutral' || permission < 55),
  };
}

function quietReasonForProfile(profileId: string): string | null {
  try {
    const {
      getSetupWatchDiagnostics,
      describeDipInactiveReason,
      describeTrendInactiveReason,
    } = require('./profileAttention') as typeof import('./profileAttention');
    if (profileId === 'dip_buyer') {
      try {
        const { getDipMinorLaneHealth } =
          require('./dipMinorLaneHealth') as typeof import('./dipMinorLaneHealth');
        const h = getDipMinorLaneHealth();
        if (h.starved) {
          return `Dip minors starved ${h.minorsArmedNow}/${h.minorsCap} armed`;
        }
      } catch {
        /* soft */
      }
      const r = describeDipInactiveReason();
      if (r === 'no_watches') return 'No dip watches';
      if (r === 'armed_no_trigger') return 'Armed — waiting reclaim';
      if (r === 'trigger_blocked') return 'Triggers blocked';
      if (r === 'recovery') return 'Recovery throttle';
      if (r === 'profile_off') return 'Profile off';
      if (r === 'marl') return 'MARL downrank';
      if (r === 'suppressed_by_scalper_attention') {
        return 'Suppressed by Scalper attention';
      }
    }
    if (
      profileId === 'trend_rider' ||
      profileId === 'steady_compounder' ||
      profileId === 'high_win_rate'
    ) {
      if (
        profileId === 'steady_compounder' ||
        profileId === 'high_win_rate'
      ) {
        try {
          const { getQualityParkLaneHealth } =
            require('./dipMinorLaneHealth') as typeof import('./dipMinorLaneHealth');
          const q = getQualityParkLaneHealth();
          const lane =
            profileId === 'high_win_rate' ? q.hwr : q.steady;
          if (lane.armedNow === 0 && lane.topDeny) {
            const deny = String(lane.topDeny);
            if (/low_movement|no_level|soft_allow/i.test(deny)) {
              return profileId === 'high_win_rate'
                ? `HWR waiting arms (${deny})`
                : `Steady waiting arms (${deny})`;
            }
            return profileId === 'high_win_rate'
              ? `HWR 0 arms: ${deny}`
              : `Steady 0 arms: ${deny}`;
          }
          if (lane.armedNow > 0) {
            return profileId === 'high_win_rate'
              ? `HWR armed ${lane.armedNow} — waiting trigger`
              : `Steady armed ${lane.armedNow} — waiting trigger`;
          }
          const exclLine = (q.plainLanguage || []).find((p) =>
            /Excluded \d+ stable\/major-asset/i.test(p)
          );
          if (exclLine) return exclLine;
          const medLine = (q.plainLanguage || []).find((p) =>
            /Steady medium now \$20M/i.test(p)
          );
          if (medLine && lane.armedNow === 0) return medLine;
          if (q.rotatedStaleSession > 0 && lane.armedNow === 0) {
            return `Low-movement rotate ×${q.rotatedStaleSession}`;
          }
        } catch {
          /* soft */
        }
      }
      const r = describeTrendInactiveReason(profileId);
      if (r === 'profile_off') return 'Profile off';
      if (r === 'recovery') return 'Recovery throttle (arms still eligible)';
      if (r === 'marl') return 'MARL downrank';
      if (r === 'blocked') return 'Triggers blocked';
      if (r === 'expired') return 'Watches expired';
      if (r === 'no_trigger') return 'Armed — waiting trigger';
      if (r === 'no_arms') return 'Waiting for arms (medium/majors movement)';
      if (r === 'few_trades') return 'Quiet — few recent trades (sample building)';
    }
    // HWR soft-allow deny / microcap NAP quiet hints
    if (profileId === 'high_win_rate' || profileId === 'steady_compounder') {
      try {
        const { getQualitySoftAllowCounters } =
          require('./tradeProfiles') as typeof import('./tradeProfiles');
        const c = getQualitySoftAllowCounters()[profileId];
        if (c && c.denied > 0 && c.granted === 0) {
          return `Soft-allow denies${c.lastDenyKey ? ` (${c.lastDenyKey})` : ''}`;
        }
      } catch {
        /* soft */
      }
    }
    const d = getSetupWatchDiagnostics();
    const armed = d.armedByProfile?.[profileId] || 0;
    if (
      (profileId === 'trend_rider' ||
        profileId === 'steady_compounder' ||
        profileId === 'high_win_rate') &&
      armed === 0
    ) {
      const recent = collectExpectancyTrades()
        .filter((t) => t.profileId === profileId)
        .slice(-20);
      if (recent.length < 2) return 'Quiet — few recent trades';
    }
  } catch {
    /* soft */
  }
  return null;
}

export function getQuietProfileChips(): Array<{
  profileId: string;
  label: string;
  reason: string;
}> {
  const ids = [
    'dip_buyer',
    'trend_rider',
    'steady_compounder',
    'high_win_rate',
  ] as const;
  const labels: Record<string, string> = {
    dip_buyer: 'Dip',
    trend_rider: 'Trend',
    steady_compounder: 'Steady',
    high_win_rate: 'HWR',
  };
  const out: Array<{ profileId: string; label: string; reason: string }> = [];
  for (const id of ids) {
    const reason = quietReasonForProfile(id);
    if (reason) out.push({ profileId: id, label: labels[id] || id, reason });
  }
  return out;
}

function buildArmedFunnel(): ArmedFunnelRow {
  const empty: ArmedFunnelRow = {
    offered: 0,
    armed: 0,
    triggered: 0,
    opened: 0,
    blocked: 0,
    openRatePct: null,
    armToTriggerMs: null,
    armToTriggerPct: null,
    triggerToOpenPct: null,
    armToOpenPct: null,
  };
  try {
    const { setupWatchEventStats, listSetupWatchEvents } =
      require('./setupWatchEvents') as typeof import('./setupWatchEvents');
    const stats = setupWatchEventStats();
    const events = listSetupWatchEvents(120);
    let offered = 0;
    for (const e of events) {
      // Approximate "offered" from armed + watching-adjacent kinds in the ring
      if (e.kind === 'armed' || e.kind === 'triggered') {
        offered += 1;
      }
    }
    try {
      const { getModeBFunnelCounters } =
        require('./scalperSetupWatch') as typeof import('./scalperSetupWatch');
      const fc = getModeBFunnelCounters() as Record<string, number>;
      if (fc && typeof fc === 'object') {
        offered = Math.max(offered, Number(fc.offered || fc.diverted || 0));
      }
    } catch {
      /* soft */
    }
    const { getSetupWatchDiagnostics } =
      require('./profileAttention') as typeof import('./profileAttention');
    const d = getSetupWatchDiagnostics();
    const denom =
      stats.triggered + stats.opened + stats.blockedSafety + stats.handoffFailed;
    const armed = stats.armed;
    const triggered = stats.triggered;
    const opened = stats.opened;
    const armToTriggerPct =
      armed > 0 ? Math.round((triggered / armed) * 1000) / 10 : null;
    const triggerToOpenPct =
      triggered > 0 ? Math.round((opened / triggered) * 1000) / 10 : null;
    const armToOpenPct =
      armed > 0 ? Math.round((opened / armed) * 1000) / 10 : null;
    return {
      offered,
      armed,
      triggered,
      opened,
      blocked: stats.blockedSafety + stats.handoffFailed,
      openRatePct:
        d.triggerSuccessPct != null
          ? d.triggerSuccessPct
          : denom > 0
            ? Math.round((stats.opened / denom) * 1000) / 10
            : null,
      armToTriggerMs: d.armToTriggerLatencyMs,
      armToTriggerPct,
      triggerToOpenPct,
      armToOpenPct,
    };
  } catch {
    return empty;
  }
}

/** Native profile ids for a family (DNA primary/allowed). */
function nativeProfilesForFamily(family: ExpectancyFamily): string[] {
  const out: string[] = [];
  try {
    const { PROFILE_ENTRY_STYLE_DNA } =
      require('./supportReclaim') as typeof import('./supportReclaim');
    for (const [pid, dna] of Object.entries(PROFILE_ENTRY_STYLE_DNA)) {
      if (!dna) continue;
      if (String(dna.primary) === family) {
        out.push(pid);
        continue;
      }
      if (
        Array.isArray(dna.allowed) &&
        dna.allowed.some((s) => String(s) === family)
      ) {
        out.push(pid);
      }
    }
  } catch {
    /* soft */
  }
  return out.sort();
}

function buildFamilyRestrictionImpact(
  families: FamilyGovernorRow[]
): FamilyRestrictionImpactRow[] {
  const rows: FamilyRestrictionImpactRow[] = [];
  for (const f of families) {
    if (f.state !== 'restricted' && f.state !== 'down_ranked') continue;
    const natives = nativeProfilesForFamily(f.family);
    const e = f.metrics.expectancyPct;
    const wr = f.metrics.winRate;
    const cap = f.metrics.mfeCapturePct;
    let note = f.note || f.state;
    if (
      f.family === 'support_dip_reclaim' &&
      e != null &&
      e > -0.25 &&
      (wr == null || wr >= 0.35)
    ) {
      note = `${f.state}: native Dip may deserve soft-allow (E=${e.toFixed(2)}%)`;
    }
    rows.push({
      family: f.family,
      state: f.state,
      nativeProfiles: natives,
      expectancyPct: e,
      winRate: wr,
      mfeCapturePct: cap,
      tradeCount: f.metrics.tradeCount,
      note,
    });
  }
  return rows;
}

function buildChart(trades: ExpectancyTradeRow[]): ExpectancyLiftStatus['chart'] {
  const tradeIndex: number[] = [];
  const rollingExpectancyPct: number[] = [];
  const rollingWinRatePct: number[] = [];
  const cumulativePnlPct: number[] = [];
  let cum = 0;
  const roll = 10;
  for (let i = 0; i < trades.length; i++) {
    tradeIndex.push(i + 1);
    cum += trades[i]!.pnlPct;
    cumulativePnlPct.push(Math.round(cum * 100) / 100);
    const slice = trades.slice(Math.max(0, i - roll + 1), i + 1);
    const m = computeExpectancyMetrics(slice);
    rollingExpectancyPct.push(
      m.expectancyPct != null ? Math.round(m.expectancyPct * 100) / 100 : 0
    );
    rollingWinRatePct.push(
      m.winRate != null ? Math.round(m.winRate * 1000) / 10 : 0
    );
  }
  return {
    tradeIndex,
    rollingExpectancyPct,
    rollingWinRatePct,
    cumulativePnlPct,
  };
}

export function parseExpectancyWindow(raw: unknown): ExpectancyWindow {
  const n = Number(raw);
  if (n === 20 || n === 50 || n === 100) return n;
  return DEFAULT_EXPECTANCY_WINDOW;
}

export function getExpectancyLiftStatus(
  window: ExpectancyWindow = DEFAULT_EXPECTANCY_WINDOW
): ExpectancyLiftStatus {
  try {
    syncOneSetupLocksFromWatches();
  } catch {
    /* soft */
  }
  try {
    syncLateChaseDisableCountdown();
  } catch {
    /* soft */
  }
  const allRaw = collectExpectancyTrades();
  const regime = getPerformanceRegimeMarker();
  const all =
    regime.at != null
      ? allRaw.filter((t) => t.closedAt >= Number(regime.at))
      : allRaw;
  // If regime filter empties the window, fall back to all (cold start)
  const tradesForWindow = all.length >= 5 ? all : allRaw;
  const windowTrades = tradesForWindow.slice(-window);
  const altN = window === 20 ? 50 : window === 50 ? 100 : 50;
  const altTrades = tradesForWindow.slice(-altN);

  const mixTrades = windowTrades;
  const armedN = mixTrades.filter((t) => t.armed).length;
  const lateN = mixTrades.filter(
    (t) => t.lateChase || t.family === 'late_chase'
  ).length;
  const partialN = mixTrades.filter((t) => t.firstPartial).length;
  const caps = mixTrades
    .map((t) => t.mfeCapturePct)
    .filter((x): x is number => x != null);
  let scalperAttentionShare: number | null = null;
  try {
    const { getProfileAttentionShare } =
      require('./profileAttention') as typeof import('./profileAttention');
    const att = getProfileAttentionShare();
    scalperAttentionShare =
      att.total >= 4 ? att.shares.scalper : null;
  } catch {
    /* soft */
  }

  const mix: ExpectancyMix = {
    armedShare: mixTrades.length ? armedN / mixTrades.length : null,
    discretionaryShare: mixTrades.length
      ? (mixTrades.length - armedN) / mixTrades.length
      : null,
    lateChaseShare: mixTrades.length ? lateN / mixTrades.length : null,
    scalperAttentionShare,
    firstPartialRate: mixTrades.length ? partialN / mixTrades.length : null,
    avgMfeCapture: avg(caps),
  };

  const profiles: ProfileExpectancyRow[] = [];
  for (const p of TRADE_PROFILE_CATALOG) {
    if (p.id === 'default' || p.id === 'zion') continue;
    const pt = windowTrades.filter((t) => t.profileId === p.id);
    const metrics = computeExpectancyMetrics(pt);
    const quiet = quietReasonForProfile(p.id);
    profiles.push({
      profileId: p.id,
      name: p.name,
      metrics,
      armedShare: pt.length
        ? pt.filter((t) => t.armed).length / pt.length
        : null,
      lateChaseShare: pt.length
        ? pt.filter((t) => t.lateChase).length / pt.length
        : null,
      firstPartialRate: pt.length
        ? pt.filter((t) => t.firstPartial).length / pt.length
        : null,
      quiet: quiet != null,
      quietReason: quiet || undefined,
    });
  }
  profiles.sort(
    (a, b) =>
      (b.metrics.expectancyPct ?? -999) - (a.metrics.expectancyPct ?? -999)
  );

  const families: FamilyGovernorRow[] = [];
  for (const f of EXPECTANCY_FAMILIES) {
    const ft = windowTrades.filter((t) => t.family === f);
    const fa = altTrades.filter((t) => t.family === f);
    families.push(updateGovernorForFamily(f, ft, fa));
  }

  const quietChips = getQuietProfileChips();
  const funnel = buildArmedFunnel();
  const familyRestrictionImpact = buildFamilyRestrictionImpact(families);
  const overall = computeExpectancyMetrics(windowTrades);
  const eStr =
    overall.expectancyPct != null
      ? `${overall.expectancyPct >= 0 ? '+' : ''}${overall.expectancyPct.toFixed(2)}%`
      : '—';
  const armedStr =
    mix.armedShare != null ? `${(mix.armedShare * 100).toFixed(0)}%` : '—';
  const lateStr =
    mix.lateChaseShare != null
      ? `${(mix.lateChaseShare * 100).toFixed(0)}%`
      : '—';
  const armedTargetPct = Math.round(armedShareTarget() * 100);
  const operatorArmedTargetPct = getEntrySkillArmedTargetPct();
  const eBoost = isArmedTargetEBoostActive();
  const plainLanguage = `Expectancy ${eStr} over last ${window} · armed ${armedStr} (target ${armedTargetPct}%${eBoost ? ', E-boost' : ''}) · late-chase ${lateStr} (≤5%).`;

  const liveArmed = countLiveArmedWatches();
  const liveTriggerableArmed = countLiveTriggerableArmed();
  const fallbackDiscAllowed = liveTriggerableArmed === 0;
  const cap = discShareCap();
  const relief = discShareCapRelief();
  // Cap for chip: triggerable → slider cap; fallback room → relief when overtrading
  const effectiveCap = fallbackDiscAllowed ? relief : cap;
  const discShare = mix.discretionaryShare;
  const discMixActive =
    discShare != null &&
    mixTrades.length >= 10 &&
    (fallbackDiscAllowed ? discShare >= relief : discShare > cap);
  const admissionBaseline = getAdmissionBaseline();
  const baselineActive = admissionBaseline === 'v235';
  const entrySkillActive = !baselineActive;
  let scalperShareMax = SCALPER_SHARE_TARGET;
  try {
    const { getScalperAttentionShareCap } =
      require('./profileAttention') as typeof import('./profileAttention');
    scalperShareMax = getScalperAttentionShareCap();
  } catch {
    scalperShareMax = baselineActive ? 0.35 : SCALPER_SHARE_TARGET;
  }
  const plainExtra = baselineActive
    ? ' · Baseline v235 kill-switch (Entry Skill admit throttles off).'
    : ' · Entry Skill On (armed-first selectivity).';

  const familySkillMemory: FamilySkillMemoryRow[] = families.map((f) => ({
    family: f.family,
    winRate: f.metrics.winRate,
    expectancyPct: f.metrics.expectancyPct,
    avgWinPct: f.metrics.avgWinPct,
    avgLossPct: f.metrics.avgLossPct,
    mfeCapturePct: f.metrics.mfeCapturePct,
    n: f.metrics.tradeCount,
    state: f.state,
  }));

  let performanceCharge: import('./performanceCharge').PerformanceChargeBundle | null =
    null;
  try {
    const { buildPerformanceChargeBundle } =
      require('./performanceCharge') as typeof import('./performanceCharge');
    const half = Math.floor(windowTrades.length / 2);
    const earlyTrades = half >= 4 ? windowTrades.slice(0, half) : [];
    const earlyOverall =
      earlyTrades.length >= 4 ? computeExpectancyMetrics(earlyTrades) : null;
    const earlyArmed =
      earlyTrades.length >= 4
        ? earlyTrades.filter((t) => t.armed).length / earlyTrades.length
        : null;
    const earlyLate =
      earlyTrades.length >= 4
        ? earlyTrades.filter(
            (t) => t.lateChase || t.family === 'late_chase'
          ).length / earlyTrades.length
        : null;

    let craftScore: number | null = null;
    try {
      const { buildTradeCraftPerformance } =
        require('./tradeCraftPerformance') as typeof import('./tradeCraftPerformance');
      craftScore = buildTradeCraftPerformance('all', window).craftScore ?? null;
    } catch {
      craftScore = null;
    }

    const attShares: Record<string, number> = {};
    try {
      const { getProfileAttentionShare } =
        require('./profileAttention') as typeof import('./profileAttention');
      const att = getProfileAttentionShare();
      if (att.total >= 4) {
        attShares.scalper = att.shares.scalper;
        attShares.dip_buyer = att.shares.dip;
        attShares.trend_rider = att.shares.trend;
        attShares.migration_sniper = att.shares.migration;
        attShares.momentum_burst = att.shares.scalper;
        attShares.reversal_scalper = att.shares.scalper;
      }
    } catch {
      /* soft */
    }

    performanceCharge = buildPerformanceChargeBundle({
      combined: {
        winRate: overall.winRate,
        expectancyPct: overall.expectancyPct,
        armedShare: mix.armedShare,
        mfeCapturePct: overall.mfeCapturePct ?? mix.avgMfeCapture,
        lateChaseShare: mix.lateChaseShare,
        tradeCount: overall.tradeCount,
      },
      priorCombined:
        earlyOverall != null
          ? {
              winRate: earlyOverall.winRate,
              expectancyPct: earlyOverall.expectancyPct,
              armedShare: earlyArmed,
              mfeCapturePct: earlyOverall.mfeCapturePct,
              lateChaseShare: earlyLate,
              tradeCount: earlyOverall.tradeCount,
            }
          : null,
      craftScore,
      combinedAttentionShare: mix.scalperAttentionShare,
      combinedAttentionCap: scalperShareMax,
      profiles: profiles.map((p) => {
        const ptEarly = earlyTrades.filter((t) => t.profileId === p.profileId);
        const earlyM =
          ptEarly.length >= 3 ? computeExpectancyMetrics(ptEarly) : null;
        const profileCap =
          p.profileId === 'scalper' ||
          p.profileId === 'momentum_burst' ||
          p.profileId === 'reversal_scalper'
            ? scalperShareMax
            : null;
        return {
          profileId: p.profileId,
          name: p.name,
          metrics: p.metrics,
          armedShare: p.armedShare,
          lateChaseShare: p.lateChaseShare,
          quiet: p.quiet,
          quietReason: p.quietReason,
          attentionShare: attShares[p.profileId] ?? null,
          attentionCap: profileCap,
          craftScore: null,
          prior:
            earlyM != null
              ? {
                  winRate: earlyM.winRate,
                  expectancyPct: earlyM.expectancyPct,
                  armedShare:
                    ptEarly.length > 0
                      ? ptEarly.filter((t) => t.armed).length / ptEarly.length
                      : null,
                  mfeCapturePct: earlyM.mfeCapturePct,
                  lateChaseShare:
                    ptEarly.length > 0
                      ? ptEarly.filter((t) => t.lateChase).length /
                        ptEarly.length
                      : null,
                  tradeCount: earlyM.tradeCount,
                }
              : null,
        };
      }),
    });
  } catch {
    performanceCharge = null;
  }

  let softMovementGrants = 0;
  let softMovementArmsLive = 0;
  try {
    const {
      getSoftMovementGrantCount,
      countSoftMovementArms,
    } = require('./qualityParkPlaybook') as typeof import('./qualityParkPlaybook');
    softMovementGrants = getSoftMovementGrantCount();
    softMovementArmsLive = countSoftMovementArms();
  } catch {
    /* soft */
  }

  const zeroMfeN = windowTrades.filter((t) => (Number(t.maxRunupPct) || 0) <= 0)
    .length;
  const greenThenRedN = windowTrades.filter(
    (t) => (Number(t.maxRunupPct) || 0) >= 1 && (Number(t.pnlPct) || 0) < 0
  ).length;
  let topLossProfileId: string | null = null;
  let topLossShare: number | null = null;
  {
    const lossBy = new Map<string, number>();
    let lossTotal = 0;
    for (const t of windowTrades) {
      const pnl = Number(t.pnlPct) || 0;
      if (!(pnl < 0)) continue;
      const abs = Math.abs(pnl);
      lossTotal += abs;
      const id = String(t.profileId || 'unknown');
      lossBy.set(id, (lossBy.get(id) || 0) + abs);
    }
    if (lossTotal > 0 && lossBy.size) {
      let bestId = '';
      let bestAbs = 0;
      for (const [id, abs] of lossBy) {
        if (abs > bestAbs) {
          bestAbs = abs;
          bestId = id;
        }
      }
      if (bestId) {
        topLossProfileId = bestId;
        topLossShare = bestAbs / lossTotal;
      }
    }
  }

  return {
    ok: true,
    window,
    mix,
    targets: {
      armedShare: armedShareTarget(),
      armedTargetPct,
      lateChaseShareMax: LATE_CHASE_MAX_SHARE,
      scalperShareMax,
      discShareMax: discShareCap(),
    },
    profiles,
    families,
    funnel,
    chart: buildChart(windowTrades),
    quietChips,
    plainLanguage: plainLanguage.replace(/\.$/, '') + plainExtra,
    discMixThrottle: {
      active: baselineActive ? false : discMixActive,
      discShare,
      liveArmed,
      liveTriggerableArmed,
      effectiveCap,
      fallbackDiscAllowed: baselineActive ? true : fallbackDiscAllowed,
      armedTargetPct,
      liveArmedShare: mix.armedShare,
    },
    performanceRegime: {
      at: regime.at,
      label: regime.label,
      lateChaseDisableRemaining: getLateChaseDisableRemainingCloses(),
    },
    admissionBaseline,
    baselineActive,
    entrySkillActive,
    entrySkillArmedTargetPct: operatorArmedTargetPct,
    entrySkillArmedTargetEffectivePct: armedTargetPct,
    blockedSecondPass: getBlockedSecondPassCount(),
    repairSession: {
      zeroMfeEntryBlocked: getZeroMfeEntryBlockedCount(),
      zeroMfeEarlyCut: getZeroMfeEarlyCutCount(),
      govSoftAllow: getGovSoftAllowCounters(),
      softMovementGrants,
      softMovementArmsLive,
      zeroMfeShare: windowTrades.length ? zeroMfeN / windowTrades.length : null,
      greenThenRedShare: windowTrades.length
        ? greenThenRedN / windowTrades.length
        : null,
      topLossProfileId,
      topLossShare,
    },
    familySkillMemory,
    performanceCharge,
    entrySkillByProfile: buildEntrySkillByProfile(),
    familyRestrictionImpact,
    armedTargetEBoost: eBoost,
  };
}

export function formatExpectancyLiftZionLines(
  window: ExpectancyWindow = DEFAULT_EXPECTANCY_WINDOW
): string[] {
  try {
    const st = getExpectancyLiftStatus(window);
    const lines: string[] = [];
    lines.push(st.plainLanguage);
    lines.push(
      st.entrySkillActive
        ? 'Entry Skill is On — prefer armed confirmed setups over discretionary chase.'
        : 'Baseline v235 kill-switch is On — Entry Skill admit throttles are off (1.2.235 throughput).'
    );
    const restricted = st.families.filter((f) => f.state === 'restricted');
    const down = st.families.filter((f) => f.state === 'down_ranked');
    if (restricted.length) {
      lines.push(
        `Restricted families: ${restricted.map((f) => f.family).join(', ')}.`
      );
    }
    if (down.length) {
      lines.push(
        `Down-ranked: ${down.map((f) => f.family).join(', ')}.`
      );
    }
    const skilled = (st.familySkillMemory || [])
      .filter((f) => f.n >= 5 && f.expectancyPct != null)
      .sort((a, b) => (b.expectancyPct ?? -999) - (a.expectancyPct ?? -999));
    if (skilled[0]) {
      const f = skilled[0];
      lines.push(
        `Top family skill: ${f.family} E=${(f.expectancyPct ?? 0).toFixed(2)}% WR=${f.winRate != null ? (f.winRate * 100).toFixed(0) + '%' : '—'} (n=${f.n}, ${f.state}).`
      );
    }
    const top = st.profiles.find((p) => (p.metrics.tradeCount || 0) >= 5);
    if (top && top.metrics.expectancyPct != null) {
      lines.push(
        `Best sample: ${top.name} E=${top.metrics.expectancyPct.toFixed(2)}% (n=${top.metrics.tradeCount}).`
      );
    }
    if (st.quietChips.length) {
      lines.push(
        `Quiet: ${st.quietChips.map((c) => `${c.label} (${c.reason})`).join('; ')}.`
      );
    }
    if (st.funnel.openRatePct != null) {
      lines.push(`Armed open rate ~${st.funnel.openRatePct}%.`);
    }
    const thr = st.discMixThrottle;
    if (thr) {
      const tgt =
        thr.armedTargetPct != null
          ? thr.armedTargetPct
          : getEntrySkillArmedTargetPct();
      const livePct =
        thr.liveArmedShare != null
          ? `${(thr.liveArmedShare * 100).toFixed(0)}%`
          : '—';
      lines.push(
        `Armed mix target ${tgt}%; live ${livePct}; fallback ${thr.fallbackDiscAllowed ? 'on' : 'off'} · triggerable=${thr.liveTriggerableArmed} disc=${thr.discShare != null ? (thr.discShare * 100).toFixed(0) + '%' : '—'} cap=${(thr.effectiveCap * 100).toFixed(0)}%.`
      );
    }
    try {
      const by = st.entrySkillByProfile || {};
      const chips = Object.entries(by)
        .slice(0, 6)
        .map(
          ([id, r]) =>
            `${id}:a${r.armed}/t${r.triggered}/o${r.opened}/x${r.expired}/L${r.locksHeld}`
        );
      if (chips.length) {
        lines.push(`Entry Skill chips: ${chips.join(' · ')}.`);
      }
      const bsp = getBlockedSecondPassCount();
      if (bsp > 0) {
        lines.push(`Armed hard-lock floor fails (blocked_second_pass)=${bsp}.`);
      }
    } catch {
      /* soft */
    }
    return lines;
  } catch {
    return ['Entry Skill / Expectancy Lift diagnostics unavailable.'];
  }
}

/** Lead-block synergy when profile expectancy is poor. */
export function shouldBlockLeadForPoorExpectancy(profileId: string): boolean {
  try {
    const pid = String(profileId || '');
    const trades = collectExpectancyTrades()
      .filter((t) => t.profileId === pid)
      .slice(-40);
    const m = computeExpectancyMetrics(trades);
    if (m.tradeCount < MIN_SAMPLES || m.expectancyPct == null) return false;
    if (m.expectancyPct <= -0.75 && (m.winRate ?? 1) < 0.35) return true;
    const fam = classifyTradeFamily({ profileId: pid });
    if (getFamilyGovernorState(fam) === 'restricted' && m.expectancyPct < 0) {
      return true;
    }
    // Habit 1.2.248: block Lead for weak fast bots (stall spam / WR collapse)
    const isFast =
      pid === 'scalper' ||
      pid === 'momentum_burst' ||
      pid === 'reversal_scalper' ||
      pid === 'migration_sniper';
    if (isFast && m.tradeCount >= 12) {
      const stallish = trades.filter((t) => {
        const r = String(
          (t as { exitReason?: string; exitKey?: string }).exitReason ||
            (t as { exitKey?: string }).exitKey ||
            t.family ||
            ''
        ).toLowerCase();
        return /stall|underwater|0.?mfe|never.?pop/i.test(r);
      }).length;
      const stallShare = stallish / trades.length;
      if ((m.winRate ?? 1) < 0.28 || stallShare >= 0.45) return true;
    }
    return false;
  } catch {
    return false;
  }
}
