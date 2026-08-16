/**
 * Dip Buyer pre-entry watchlist: watch → arm → trigger → expire / invalidate.
 * Hands triggered setups into the Market Scanner handler with preferredProfileId.
 */

import type { LaunchEvent } from './marketData';
import { fetchLiveTokenSnapshot, fetchMultiTfOhlcv } from './marketData';
import {
  handOffScannerCandidate,
  type ScannerCandidate,
} from './marketScanner';
import { trimMapToCap, registerCacheSweep } from './mapCap';
import { isStrategyEnabledGlobal } from './strategies';
import {
  getEffectiveMcBand,
  isAboveDipBuyerMaxMc,
  isInDipBuyerMcBand,
  isSmartBotProfilesEnabled,
  resolveTradeProfileDefinition,
} from './tradeProfiles';
import { detectSupportReclaim } from './supportReclaim';
import {
  analyzeSrConfluenceFromCandles,
  buildSupportSideMcTargets,
  isSupportSideLevel,
  pickDipRetracementLevels,
} from './technicalLevels';
import { noteWatcherPoll } from './watcherPollMetrics';
import {
  stampWatchPriority,
  sortActiveWatchesByScore,
  shouldSkipArmForCap,
  countArmedWatchesForProfile,
  demoteArmedBeyondCap,
  watchLifecycleAction,
  WATCH_ARM_SCORE_FLOOR,
  WATCH_SCORE_FLOOR,
  FLOOR_EXPIRE_MS,
} from './watchPriorityScore';

import { isRpcWorkloadEnabled } from './rpcWorkloadControl';
import {
  applyArmLifecycleTimeout,
  hasDipFightDna,
  resetArmClockOnArm,
  stampCheapArmEval,
  stampWatchVolumeOk,
  watchHasLevelEvidence,
} from './watchArmLifecycle';

function stampDipPriority(w: DipWatchEntry, now: number): void {
  stampWatchPriority(
    w.preferredProfileId || 'dip_buyer',
    w,
    {
      status: w.status,
      createdAt: w.createdAt,
      armedAt: w.armedAt,
      lastImprovementAt: w.lastImprovementAt,
      nearSupport: w.nearSupport,
      nearKeyFib: w.nearKeyFib,
      supportPriceSol: w.supportPriceSol,
      fib05PriceSol: w.fib05PriceSol,
      lastPriceSol: w.lastPriceSol,
      confluenceCount: w.confluenceCount,
      volumeH1Usd: w.volumeH1Usd,
      movementActive: w.movementActive,
      liquidityUsd: w.liquidityUsd,
      dropFromPeakPct: w.dropFromPeakPct,
      tokenAgeHours: w.tokenAgeHours,
    },
    now
  );
}

export type DipWatchStatus =
  | 'watching'
  | 'armed'
  | 'triggered'
  | 'expired'
  | 'invalidated';

export interface DipTargetEntry {
  label: string;
  priceSol: number;
  mcUsd: number;
}

export interface DipWatchEntry {
  mint: string;
  symbol: string;
  name: string;
  status: DipWatchStatus;
  createdAt: number;
  updatedAt: number;
  armedAt: number | null;
  expiresAt: number;
  marketCapUsd?: number;
  volumeH1Usd?: number;
  liquidityUsd?: number;
  holderCount?: number;
  dropFromPeakPct?: number | null;
  nearKeyFib?: boolean;
  nearSupport?: boolean;
  supportPriceSol?: number | null;
  lastPriceSol?: number | null;
  fib05PriceSol?: number | null;
  fib618PriceSol?: number | null;
  lastReason?: string;
  kolCount?: number;
  source?: string;
  /** Soft MC band when source is medium/majors ($20M / $50M / $100M / $200M / $250M / $500M / $1B+) */
  majorsBand?: string;
  /** Soft prefer on handoff — dip_buyer inside $1M–$500M; Steady/HWR above Dip max */
  preferredProfileId?: string;
  /** Non-exclusive: profiles this row may appear under in the per-profile Watchlist. */
  eligibleProfileIds?: string[];
  confluenceCount?: number | null;
  playbookPassed?: string[];
  triggerBlockReason?: string;
  /** Fib / Support → approx MC at reclaim entry */
  targetDipEntries?: DipTargetEntry[];
  /** Phase A stamps — pass through trigger without rediscovery */
  entryStyle?: string;
  qualityScore?: number | null;
  sizePlanSol?: number | null;
  /** Live peak price for drop-from-peak refresh */
  peakPriceSol?: number | null;
  /** Real token/pool birth (Jupiter firstPool) — never watch createdAt */
  pairCreatedAtMs?: number;
  tokenAgeHours?: number;
  /** 1.2.263 quality park movement / arm tags */
  priceChangeH1Pct?: number | null;
  priceChangeH6Pct?: number | null;
  priceChange24hPct?: number | null;
  movementActive?: boolean;
  qualityChip?: string;
  armTag?: string;
  multiTfSupportHits?: number;
  /** Soft-movement arm (1.2.268) — size haircut + session cap */
  softMovement?: boolean;
  /** Pump.fun preferred in Medium/Majors inventory / UI */
  isPumpFun?: boolean;
  watchScore?: number;
  watchScoreBreakdown?: import('./watchPriorityScore').WatchScoreBreakdown;
  volumeState?: string;
  decayMultiplier?: number;
  lastImprovementAt?: number;
  scoreAtFloorSince?: number | null;
  watchScoreChips?: string[];
  watchRank?: number;
  watchScoreAtArm?: number;
  prevLevelDistancePct?: number | null;
  prevConfluenceCount?: number | null;
  exclusiveRouteReason?: string;
  volOk?: boolean;
  armClockPausedAt?: number | null;
  armClockPausedMs?: number;
  lastArmEvalAt?: number | null;
  fightDipDna?: boolean;
  hasLevel?: boolean;
  volumeM5Usd?: number;
}

/** Unified Dip-family inventory (1M–500M + above-max Steady/HWR parks). */
const MAX_DIP_WATCHES = 80;
const DEFAULT_TTL_MS = 4 * 60 * 60_000; // 4h
/** High-MC majors/medium wait longer for Fib/S setups (8–12h band → 10h) */
const MAJORS_TTL_MS = 10 * 60 * 60_000;
/** Min gap between H1-vol rotations per mint (quality buckets) */
const ROTATION_DEBOUNCE_MS = 10 * 60_000;
/** Incoming must beat weakest by this factor to rotate at cap */
const ROTATION_VOL_EDGE = 1.25;

type DipWatchBucket = 'majors' | 'medium' | 'minors';
const ARM_NEAR_DROP_MIN = 6;
/** Mode B parity — reclaim % off level / bounce */
const TRIGGER_RECLAIM_PCT = 0.9;
/** Manual unwatch — bots may re-add only after this cooldown */
const UNWATCH_COOLDOWN_MS = 15 * 60_000;
const MC_REFRESH_MIN_MS = 15_000;
/** Quality parks: snapshot less often — inventory is large and Dex/Gecko is HTTP-heavy */
const QUALITY_MC_REFRESH_MIN_MS = 45_000;
/** Full multi-TF OHLCV for quality parks at most this often (levels persist) */
const QUALITY_OHLCV_REFRESH_MIN_MS = 3 * 60_000;
/** Cap full market refreshes per tick to protect event loop / HTTP pools */
const MAX_FULL_REFRESH_PER_TICK = 4;
/** Ignore single-tick peak→price moves larger than this as feed glitches */
const PEAK_GLITCH_DROP_PCT = 70;
const PEAK_GLITCH_JUMP_MULT = 2.5;
/** Soft H1 fill must stay within this band (Dex can print wild outliers) */
const H1_SOFT_FILL_MAX_PCT = 55;
const TERMINAL_UI_MS = 60_000;

const watches = new Map<string, DipWatchEntry>();
let lastMcRefreshAt = new Map<string, number>();
/** mint → last multi-TF OHLCV refresh (quality parks) */
const lastOhlcvRefreshAt = new Map<string, number>();
/** Per-tick budget for expensive Dex/Gecko refreshes */
let fullRefreshBudget = 0;
/** Dedup no_levels funnel: last noted streak tick per mint */
const noLevelsFunnelNotedAt = new Map<string, number>();
const NO_LEVELS_FUNNEL_DEDUP_MS = 20 * 60_000;
/** mint → earliest time bots may re-add after manual unwatch */
const unwatchCooldownUntil = new Map<string, number>();
/** mint → last H1-vol rotation eviction/admit (debounce) */
const lastRotationAt = new Map<string, number>();
const WATCH_SIDECAR_CAP = 500;

function capDipWatchSidecars(): Record<string, number> {
  trimMapToCap(lastOhlcvRefreshAt, WATCH_SIDECAR_CAP);
  trimMapToCap(unwatchCooldownUntil, WATCH_SIDECAR_CAP);
  trimMapToCap(lastRotationAt, WATCH_SIDECAR_CAP);
  trimMapToCap(noLevelsFunnelNotedAt, WATCH_SIDECAR_CAP);
  return {
    dipOhlcvRefresh: lastOhlcvRefreshAt.size,
    dipUnwatchCooldown: unwatchCooldownUntil.size,
  };
}
registerCacheSweep(capDipWatchSidecars);

function stampDipWatchEligibility(w: DipWatchEntry, isNew = false): void {
  try {
    const { stampEligibleOnWatchEntry, noteProfileWatchFunnel } =
      require('./profileWatchRegistry') as typeof import('./profileWatchRegistry');
    const ids = stampEligibleOnWatchEntry('dip', w);
    if (ids.length === 1 && ids[0] === 'steady_compounder') {
      w.exclusiveRouteReason = 'routed_steady';
    } else if (ids.length === 1 && ids[0] === 'high_win_rate') {
      w.exclusiveRouteReason = 'routed_hwr';
    } else if (ids.length === 1 && ids[0] === 'dip_buyer') {
      w.exclusiveRouteReason = 'routed_dip_dump';
    }
    if (isNew) {
      for (const id of ids) noteProfileWatchFunnel(id, 'sent_to_watch', undefined, w.source);
      if (w.status === 'armed') {
        for (const id of ids) noteProfileWatchFunnel(id, 'armed', undefined, w.source);
      }
    }
  } catch {
    w.eligibleProfileIds = w.preferredProfileId
      ? [String(w.preferredProfileId)]
      : ['dip_buyer'];
  }
}

function noteDipProfileArmed(w: DipWatchEntry): void {
  try {
    const { noteProfileWatchFunnel } =
      require('./profileWatchRegistry') as typeof import('./profileWatchRegistry');
    for (const id of w.eligibleProfileIds || [w.preferredProfileId || 'dip_buyer']) {
      noteProfileWatchFunnel(id, 'armed');
    }
  } catch {
    /* optional */
  }
}

function noteDipProfileExpired(w: DipWatchEntry): void {
  try {
    const { noteProfileWatchFunnel } =
      require('./profileWatchRegistry') as typeof import('./profileWatchRegistry');
    const ids = w.eligibleProfileIds || [w.preferredProfileId || 'dip_buyer'];
    for (const id of ids) {
      noteProfileWatchFunnel(id, 'expired');
      if (w.armedAt) noteProfileWatchFunnel(id, 'blocked', 'false_arm_expired');
    }
  } catch {
    /* optional */
  }
}

/** Rolling Dip admit / fire funnel (session counters). */
const dipFunnel = {
  offered: 0,
  watching: 0,
  armed: 0,
  triggered: 0,
  handoff_failed: 0,
  no_levels: 0,
  /** Admit / rotate deny reasons (Dip/Steady inventory diagnostics) */
  mutual_exclude: 0,
  /** mutual_exclude tagged by blocker */
  mx_scalper: 0,
  mx_trend: 0,
  unwatch_cd: 0,
  no_levels_rotate: 0,
  /** Split former vol_liq_mc bucket */
  vol: 0,
  liq: 0,
  mc: 0,
  no_setup: 0,
  max_drop: 0,
  /** Legacy sum of vol+liq+mc+no_setup+max_drop (compat) */
  vol_liq_mc: 0,
  at_cap: 0,
  /** Medium/majors Steady park diagnostics */
  medium_candidates_seen: 0,
  majors_candidates_seen: 0,
  medium_armed: 0,
  majors_armed: 0,
  medium_triggered: 0,
  majors_triggered: 0,
  medium_opened: 0,
  majors_opened: 0,
  medium_expired: 0,
  majors_expired: 0,
  /** Dip minor-lane diagnostics (1.2.262) */
  minors_candidates_seen: 0,
  minors_armed: 0,
  minors_triggered: 0,
  minors_opened: 0,
  minors_expired: 0,
  minors_leak_prefer_remapped: 0,
  minors_leak_soft_allow_skipped: 0,
  /** Steady / HWR quality park funnel (1.2.263) */
  steady_candidates_seen: 0,
  steady_armed: 0,
  steady_triggered: 0,
  steady_opened: 0,
  steady_rotated_stale: 0,
  hwr_candidates_seen: 0,
  hwr_armed: 0,
  hwr_triggered: 0,
  hwr_opened: 0,
  hwr_rotated_stale: 0,
  quality_low_movement: 0,
  /** Name/class exclusions rotated from medium/majors */
  quality_excluded_proxy: 0,
  quality_excluded_stock: 0,
  /** Known MC fell outside medium/majors bands */
  quality_out_of_band_mc: 0,
};

let lastDipAdmitReject = '';
export function getLastDipAdmitReject(): string {
  return lastDipAdmitReject;
}

function noteDipFunnel(key: keyof typeof dipFunnel, n = 1): void {
  dipFunnel[key] = (dipFunnel[key] || 0) + n;
  if (
    key === 'mc' ||
    key === 'vol' ||
    key === 'liq' ||
    key === 'no_setup' ||
    key === 'max_drop' ||
    key === 'at_cap' ||
    key === 'unwatch_cd' ||
    key === 'mutual_exclude' ||
    key === 'mx_scalper' ||
    key === 'mx_trend' ||
    key === 'quality_excluded_stock' ||
    key === 'quality_excluded_proxy'
  ) {
    lastDipAdmitReject = String(key);
  }
}

function noteQualityBandFunnel(
  source: string | undefined,
  key:
    | 'candidates_seen'
    | 'armed'
    | 'triggered'
    | 'opened'
    | 'expired'
): void {
  if (isMediumSource(source)) {
    noteDipFunnel(
      key === 'candidates_seen'
        ? 'medium_candidates_seen'
        : (`medium_${key}` as keyof typeof dipFunnel)
    );
  } else if (isMajorsSource(source)) {
    noteDipFunnel(
      key === 'candidates_seen'
        ? 'majors_candidates_seen'
        : (`majors_${key}` as keyof typeof dipFunnel)
    );
  }
}

function noteMinorsFunnel(
  key: 'candidates_seen' | 'armed' | 'triggered' | 'opened' | 'expired'
): void {
  noteDipFunnel(
    key === 'candidates_seen'
      ? 'minors_candidates_seen'
      : (`minors_${key}` as keyof typeof dipFunnel)
  );
}

export function noteMinorsLeakSoftAllowSkipped(n = 1): void {
  noteDipFunnel('minors_leak_soft_allow_skipped', n);
}

export function getDipFunnelCounters(): typeof dipFunnel & {
  watchingNow: number;
  armedNow: number;
  mediumWatchingNow: number;
  mediumArmedNow: number;
  majorsWatchingNow: number;
  majorsArmedNow: number;
  minorsWatchingNow: number;
  minorsArmedNow: number;
  minorsCap: number;
} {
  let watchingNow = 0;
  let armedNow = 0;
  let mediumWatchingNow = 0;
  let mediumArmedNow = 0;
  let majorsWatchingNow = 0;
  let majorsArmedNow = 0;
  let minorsWatchingNow = 0;
  let minorsArmedNow = 0;
  for (const w of watches.values()) {
    const quality = isQualityBandSource(w.source);
    if (w.status === 'watching') {
      watchingNow += 1;
      if (isMediumSource(w.source)) mediumWatchingNow += 1;
      else if (isMajorsSource(w.source)) majorsWatchingNow += 1;
      else minorsWatchingNow += 1;
    }
    if (w.status === 'armed') {
      armedNow += 1;
      if (isMediumSource(w.source)) mediumArmedNow += 1;
      else if (isMajorsSource(w.source)) majorsArmedNow += 1;
      else minorsArmedNow += 1;
    }
    void quality;
  }
  return {
    ...dipFunnel,
    watchingNow,
    armedNow,
    mediumWatchingNow,
    mediumArmedNow,
    majorsWatchingNow,
    majorsArmedNow,
    minorsWatchingNow,
    minorsArmedNow,
    minorsCap: MAX_DIP_WATCHES,
  };
}

/** Honest specialtyFeed from watch source (never fake kolscan for scanner minors). */
export function specialtyFeedFromDipSource(
  source: string | undefined
): 'majors' | 'medium' | 'kolscan' | 'jupiter' | 'alphascan' | 'scanner' {
  const s = String(source || '').toLowerCase();
  if (s === 'majors') return 'majors';
  if (s === 'medium') return 'medium';
  if (s === 'kolscan') return 'kolscan';
  if (s === 'jupiter') return 'jupiter';
  if (s === 'alphascan') return 'alphascan';
  return 'scanner';
}

/**
 * Full active Dip inventory by band — no truncation.
 * Use for one-setup sync / inactive reason / readiness (1.2.262).
 */
export function getActiveDipWatchesSnapshot(): {
  majors: DipWatchEntry[];
  medium: DipWatchEntry[];
  minors: DipWatchEntry[];
  allActive: DipWatchEntry[];
  active: number;
  activeMajors: number;
  activeMedium: number;
  activeMinors: number;
} {
  pruneTerminal();
  const majors = activeWatches('majors').sort((a, b) => b.updatedAt - a.updatedAt);
  const medium = activeWatches('medium').sort((a, b) => b.updatedAt - a.updatedAt);
  const minors = activeWatches('minors').sort((a, b) => b.updatedAt - a.updatedAt);
  for (const e of [...majors, ...medium, ...minors]) {
    e.targetDipEntries = buildTargetDipEntries(e);
  }
  return {
    majors,
    medium,
    minors,
    allActive: [...medium, ...majors, ...minors],
    active: majors.length + medium.length + minors.length,
    activeMajors: majors.length,
    activeMedium: medium.length,
    activeMinors: minors.length,
  };
}

export function getDipMinorsCap(): number {
  return MAX_DIP_WATCHES;
}

function isMajorsSource(source: string | undefined): boolean {
  return String(source || '').toLowerCase() === 'majors';
}

function isMediumSource(source: string | undefined): boolean {
  return String(source || '').toLowerCase() === 'medium';
}

/** Medium or majors quality band (Steady/Dip parks — not memecoin minors). */
function isQualityBandSource(source: string | undefined): boolean {
  return isMajorsSource(source) || isMediumSource(source);
}

function watchBucket(source: string | undefined): DipWatchBucket {
  if (isMajorsSource(source)) return 'majors';
  if (isMediumSource(source)) return 'medium';
  return 'minors';
}

function isActiveWatch(w: DipWatchEntry): boolean {
  return w.status === 'watching' || w.status === 'armed';
}

function allActiveWatches(): DipWatchEntry[] {
  return [...watches.values()]
    .filter((w) => isActiveWatch(w))
    .sort((a, b) => a.createdAt - b.createdAt);
}

function enforceDipCap(max: number): void {
  const ranked = allActiveWatches()
    .map((w) => ({ w, score: qualityWatchScore(w) }))
    .sort((a, b) => a.score - b.score);
  while (ranked.length > max) {
    const weakest = ranked.shift();
    if (!weakest) break;
    deleteDipWatch(weakest.w.mint);
  }
}

function releaseQualitySoftArm(mint: string | null | undefined): void {
  try {
    const { releaseSoftMovementArm } =
      require('./qualityParkPlaybook') as typeof import('./qualityParkPlaybook');
    releaseSoftMovementArm(mint);
  } catch {
    /* optional */
  }
}

function deleteDipWatch(mint: string): void {
  releaseQualitySoftArm(mint);
  watches.delete(mint);
  lastMcRefreshAt.delete(mint);
  noLevelsFunnelNotedAt.delete(mint);
  lastOhlcvRefreshAt.delete(mint);
  lastRotationAt.delete(mint);
}

function activeWatches(bucket: DipWatchBucket): DipWatchEntry[] {
  return [...watches.values()]
    .filter((w) => {
      if (!isActiveWatch(w)) return false;
      return watchBucket(w.source) === bucket;
    })
    .sort((a, b) => a.createdAt - b.createdAt);
}

function qualityWatchScore(w: DipWatchEntry): number {
  const vol = Math.max(0, Number(w.volumeH1Usd) || 0);
  const ageDays =
    w.tokenAgeHours != null && Number.isFinite(w.tokenAgeHours)
      ? Number(w.tokenAgeHours) / 24
      : w.pairCreatedAtMs != null &&
          Number.isFinite(w.pairCreatedAtMs) &&
          w.pairCreatedAtMs > 0
        ? Math.max(0, (Date.now() - Number(w.pairCreatedAtMs)) / 86_400_000)
        : 0;
  const liqProxy =
    w.marketCapUsd != null && Number.isFinite(w.marketCapUsd)
      ? Math.min(Number(w.marketCapUsd) / 1_000_000, 50)
      : 0;
  const armedBoost = w.status === 'armed' ? 50_000 : 0;
  const nearBoost =
    w.nearKeyFib === true || w.nearSupport === true ? 15_000 : 0;
  const movBoost =
    w.movementActive === false || w.qualityChip === 'low_movement'
      ? -50_000
      : Math.abs(Number(w.priceChangeH1Pct) || 0) * 80 +
        Math.abs(Number(w.priceChange24hPct) || 0) * 40;
  const pumpBoost = w.isPumpFun === true ? 8_000 : 0;
  // Primary: armed/near → H1 vol + movement; pump preferred; soft age + MC; dead tape last
  return (
    armedBoost +
    nearBoost +
    vol +
    ageDays * 50 +
    liqProxy * 20 +
    movBoost +
    pumpBoost
  );
}

/**
 * Rotate medium/majors watches that are name-excluded or outside MC bands.
 * Returns true when the watch was expired/rotated (caller should stop).
 */
function maybeRotateExcludedOrOutOfBandQualityWatch(
  w: DipWatchEntry,
  now: number
): boolean {
  if (!isQualityBandSource(w.source)) return false;
  if (w.status !== 'watching' && w.status !== 'armed') return false;

  try {
    const { classifyQualityParkNameExclusion } =
      require('./qualityParkNameExclusions') as typeof import('./qualityParkNameExclusions');
    const excl = classifyQualityParkNameExclusion(w.symbol, w.name);
    if (excl) {
      const pid =
        w.preferredProfileId === 'high_win_rate'
          ? 'high_win_rate'
          : 'steady_compounder';
      try {
        const { noteQualityParkFunnel } =
          require('./qualityParkPlaybook') as typeof import('./qualityParkPlaybook');
        noteQualityParkFunnel(pid, 'rotated_stale');
      } catch {
        /* optional */
      }
      noteDipFunnel(
        pid === 'high_win_rate' ? 'hwr_rotated_stale' : 'steady_rotated_stale'
      );
      noteDipFunnel(
        excl === 'excluded_stock_name_token'
          ? 'quality_excluded_stock'
          : 'quality_excluded_proxy'
      );
      noteQualityBandFunnel(w.source, 'expired');
      releaseQualitySoftArm(w.mint);
      w.status = 'expired';
      w.updatedAt = now;
      w.lastReason = excl;
      w.qualityChip = 'rotated_stale';
      console.log(
        `[dip-watch] ROTATE ${w.symbol} [${w.source}] — ${excl}`
      );
      try {
        const { clearOneSetupProfileLock } =
          require('./expectancyLift') as typeof import('./expectancyLift');
        clearOneSetupProfileLock(w.mint, 'expired');
      } catch {
        /* optional */
      }
      return true;
    }
  } catch {
    /* optional */
  }

  const mc = Number(w.marketCapUsd);
  if (Number.isFinite(mc) && mc > 0) {
    try {
      const {
        universeWatchBand,
        majorsMcBand,
      } = require('./majorsUniverse') as typeof import('./majorsUniverse');
      if (!isInDipBuyerMcBand(mc) && !isAboveDipBuyerMaxMc(mc)) {
        const pid =
          w.preferredProfileId === 'high_win_rate'
            ? 'high_win_rate'
            : 'steady_compounder';
        try {
          const { noteQualityParkFunnel } =
            require('./qualityParkPlaybook') as typeof import('./qualityParkPlaybook');
          noteQualityParkFunnel(pid, 'rotated_stale');
        } catch {
          /* optional */
        }
        noteDipFunnel(
          pid === 'high_win_rate' ? 'hwr_rotated_stale' : 'steady_rotated_stale'
        );
        noteDipFunnel('quality_out_of_band_mc');
        noteQualityBandFunnel(w.source, 'expired');
        releaseQualitySoftArm(w.mint);
        w.status = 'expired';
        w.updatedAt = now;
        w.lastReason = `out_of_band_mc MC=$${Math.round(mc)}`;
        w.qualityChip = 'rotated_stale';
        console.log(
          `[dip-watch] ROTATE ${w.symbol} [${w.source}] — MC below Dip min ` +
            `MC=$${Math.round(mc)}`
        );
        try {
          const { clearOneSetupProfileLock } =
            require('./expectancyLift') as typeof import('./expectancyLift');
          clearOneSetupProfileLock(w.mint, 'expired');
        } catch {
          /* optional */
        }
        return true;
      }
      const band = universeWatchBand(mc);
      if (band) {
        w.source = band;
        w.majorsBand = majorsMcBand(mc);
      }
    } catch {
      /* optional */
    }
  }
  return false;
}

/**
 * True if a new admit is allowed under the unified Dip-family cap.
 * Rotate lowest score when incoming beats weakest H1 vol by ≥1.25×.
 */
function reserveAdmitSlot(
  _bucket: DipWatchBucket,
  incoming?: { mint?: string; volumeH1Usd?: number }
): boolean {
  const active = allActiveWatches();
  const now = Date.now();
  const watching = active.filter((w) => w.status === 'watching');
  if (
    watching.length > 0 &&
    watching.length <= 2 &&
    active.length < MAX_DIP_WATCHES
  ) {
    const inMint = String(incoming?.mint || '').trim();
    for (const w of watching) {
      if (inMint && w.mint === inMint) continue;
      const floor = (w.watchScore ?? 100) <= WATCH_SCORE_FLOOR;
      const stagnant =
        w.scoreAtFloorSince != null &&
        now - w.scoreAtFloorSince >= FLOOR_EXPIRE_MS;
      if (!floor && !stagnant) continue;
      w.status = 'expired';
      w.updatedAt = now;
      w.lastReason = 'expire_stagnant_rotate';
      console.log(
        `[watch_insert_ok] rotated stagnant ${w.symbol} for incoming ${inMint.slice(0, 8)}`
      );
    }
  }
  if (active.filter((w) => w.status === 'watching' || w.status === 'armed').length <
    MAX_DIP_WATCHES) {
    return true;
  }

  const ranked = [...allActiveWatches()]
    .map((w) => ({ w, score: qualityWatchScore(w) }))
    .sort((a, b) => a.score - b.score);
  const weakest = ranked[0];
  if (!weakest) return true;

  const inVol = Math.max(0, Number(incoming?.volumeH1Usd) || 0);
  const weakVol = Math.max(1, Number(weakest.w.volumeH1Usd) || 0);
  const watchingN = allActiveWatches().filter((w) => w.status === 'watching')
    .length;
  const stagnantWeak =
    (weakest.w.watchScore ?? 100) <= WATCH_SCORE_FLOOR ||
    (weakest.w.scoreAtFloorSince != null &&
      now - weakest.w.scoreAtFloorSince >= FLOOR_EXPIRE_MS);
  const skipVolBar = watchingN <= 2 && stagnantWeak;
  if (!skipVolBar && !(inVol >= weakVol * ROTATION_VOL_EDGE)) {
    return false;
  }

  const outMint = weakest.w.mint;
  const inMint = String(incoming?.mint || '').trim();
  const lastOut = lastRotationAt.get(outMint) ?? 0;
  const lastIn = inMint ? lastRotationAt.get(inMint) ?? 0 : 0;
  if (now - lastOut < ROTATION_DEBOUNCE_MS || now - lastIn < ROTATION_DEBOUNCE_MS) {
    return false;
  }

  deleteDipWatch(outMint);
  lastRotationAt.set(outMint, now);
  if (inMint) lastRotationAt.set(inMint, now);
  console.log(
    `[ROTATION] dip out=${weakest.w.symbol}(${outMint.slice(0, 6)}…) ` +
      `volH1=$${Math.round(weakVol)} score=${Math.round(weakest.score)} → ` +
      `in=${inMint ? inMint.slice(0, 6) + '…' : '?'} volH1=$${Math.round(inVol)}`
  );
  return true;
}

function isManualUnwatchCooldown(mint: string): boolean {
  const until = unwatchCooldownUntil.get(mint) ?? 0;
  if (until <= Date.now()) {
    if (until > 0) unwatchCooldownUntil.delete(mint);
    return false;
  }
  return true;
}

function dipMatch() {
  return resolveTradeProfileDefinition('dip_buyer').match;
}

function mintHasOpenTrade(mint: string): boolean {
  try {
    const { paperTrader } =
      require('./paperTrader') as typeof import('./paperTrader');
    const key = String(mint || '').trim().toLowerCase();
    if (!key) return false;
    return (paperTrader.getOpenPositions() || []).some(
      (p) =>
        p &&
        p.status !== 'closed' &&
        String(p.mint || '').trim().toLowerCase() === key
    );
  } catch {
    return false;
  }
}

function stampWatchPlan(w: DipWatchEntry): void {
  const q =
    w.nearKeyFib && w.nearSupport
      ? 80
      : w.nearKeyFib
        ? 72
        : w.nearSupport
          ? 65
          : w.dropFromPeakPct != null && w.dropFromPeakPct >= 12
            ? 55
            : 45;
  w.qualityScore = q;
  const inDipBand = isInDipBuyerMcBand(w.marketCapUsd);
  const preferHwr = !inDipBand && w.preferredProfileId === 'high_win_rate';
  const preferSteady =
    !inDipBand &&
    (preferHwr ||
      w.preferredProfileId === 'steady_compounder' ||
      isQualityBandSource(w.source));
  w.entryStyle = preferSteady
    ? 'quality_structure_reclaim'
    : 'support_dip_reclaim';
  try {
    const { calculateDynamicPositionSize } =
      require('./risk') as typeof import('./risk');
    const { paperTrader } =
      require('./paperTrader') as typeof import('./paperTrader');
    let sizeMult = preferSteady ? 0.85 : 1;
    if (w.softMovement === true) {
      sizeMult = Math.min(sizeMult, 0.85);
    }
    const sizing = calculateDynamicPositionSize({
      equitySol: paperTrader.getEquitySol(),
      kind: 'normal',
      openCount: paperTrader.getOpenPositions().length,
      sizeMultiplier: sizeMult,
    });
    w.sizePlanSol = sizing.sizeSol;
  } catch {
    w.sizePlanSol = w.sizePlanSol ?? null;
  }
}

function sanitizeDipWatchLevels(w: {
  lastPriceSol?: number | null;
  supportPriceSol?: number | null;
  fib05PriceSol?: number | null;
  fib618PriceSol?: number | null;
}): void {
  const picked = pickDipRetracementLevels({
    livePrice: w.lastPriceSol,
    fib05: w.fib05PriceSol,
    fib618: w.fib618PriceSol,
  });
  w.fib05PriceSol = picked.fib05;
  w.fib618PriceSol = picked.fib618;
  if (!isSupportSideLevel(w.supportPriceSol, w.lastPriceSol)) {
    w.supportPriceSol = null;
  }
}

function buildTargetDipEntries(w: {
  marketCapUsd?: number;
  lastPriceSol?: number | null;
  supportPriceSol?: number | null;
  fib05PriceSol?: number | null;
  fib618PriceSol?: number | null;
}): DipTargetEntry[] {
  sanitizeDipWatchLevels(w);
  return buildSupportSideMcTargets({
    marketCapUsd: w.marketCapUsd,
    lastPriceSol: w.lastPriceSol,
    levels: [
      { label: 'Fib 0.5', priceSol: w.fib05PriceSol },
      { label: 'Fib 0.618', priceSol: w.fib618PriceSol },
      { label: 'Support', priceSol: w.supportPriceSol },
    ],
  });
}

function isDipProfileEnabled(): boolean {
  if (!isSmartBotProfilesEnabled()) {
    lastDipAdmitReject = 'profile_off';
    return false;
  }
  if (!isStrategyEnabledGlobal('ta_market_scanner')) {
    lastDipAdmitReject = 'profile_off';
    return false;
  }
  const { config } = require('./config') as typeof import('./config');
  if (config.tradeProfiles?.enabled === false) {
    lastDipAdmitReject = 'profile_off';
    return false;
  }
  // Minors need Dip; medium/majors may run on Steady or HWR alone
  if (
    config.tradeProfiles?.profiles?.dip_buyer === false &&
    config.tradeProfiles?.profiles?.steady_compounder === false &&
    config.tradeProfiles?.profiles?.high_win_rate === false
  ) {
    lastDipAdmitReject = 'profile_off';
    return false;
  }
  try {
    const { isProfileWatchEnabled } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    if (
      !isProfileWatchEnabled('dip_buyer') &&
      !isProfileWatchEnabled('steady_compounder') &&
      !isProfileWatchEnabled('high_win_rate')
    ) {
      lastDipAdmitReject = 'watch_off';
      return false;
    }
  } catch {
    /* optional */
  }
  return true;
}

function pruneTerminal(): void {
  const now = Date.now();
  for (const [mint, w] of watches) {
    if (
      w.status === 'triggered' ||
      w.status === 'expired' ||
      w.status === 'invalidated'
    ) {
      if (now - w.updatedAt > 30 * 60_000) {
        if (w.status === 'triggered' && mintHasOpenTrade(mint)) continue;
        deleteDipWatch(mint);
      }
    }
  }
  enforceDipCap(MAX_DIP_WATCHES);
}

export function watchHasFibOrSupportLevels(w: DipWatchEntry): boolean {
  return (
    (w.fib05PriceSol != null && w.fib05PriceSol > 0) ||
    (w.fib618PriceSol != null && w.fib618PriceSol > 0) ||
    (w.supportPriceSol != null && w.supportPriceSol > 0) ||
    w.nearKeyFib === true ||
    w.nearSupport === true ||
    (w.multiTfSupportHits != null && w.multiTfSupportHits > 0)
  );
}

/** Quality parks use a slightly wider near-band (1.2.261). */
function qualityNearBands(w: DipWatchEntry): {
  nearBandPct: number;
  undercutBandPct: number;
  nearBand: number;
  undercut: number;
} {
  const quality = isQualityBandSource(w.source);
  return quality
    ? {
        nearBandPct: 5,
        undercutBandPct: 2,
        nearBand: 0.05,
        undercut: 0.02,
      }
    : {
        nearBandPct: 3.5,
        undercutBandPct: 1.5,
        nearBand: 0.035,
        undercut: 0.015,
      };
}

/**
 * Recompute nearKeyFib / nearSupport / level prices from stored Fib/S
 * (+ optional multi-TF) vs live price. Fail soft.
 */
function recomputeProximityFromLevels(w: DipWatchEntry): void {
  const px = w.lastPriceSol;
  if (px == null || !Number.isFinite(px) || px <= 0) return;
  sanitizeDipWatchLevels(w);
  const bands = qualityNearBands(w);
  const nearPx = (level: number | null | undefined): boolean => {
    if (level == null || !Number.isFinite(level) || level <= 0) return false;
    const d = (px - level) / level;
    return d >= -bands.undercut && d <= bands.nearBand;
  };
  w.nearKeyFib = nearPx(w.fib05PriceSol) || nearPx(w.fib618PriceSol);
  w.nearSupport = nearPx(w.supportPriceSol);
  try {
    const det = detectSupportReclaim({
      priceSol: px,
      supportPriceSol: w.supportPriceSol,
      fib05PriceSol: w.fib05PriceSol,
      fib618PriceSol: w.fib618PriceSol,
      nearSupport: w.nearSupport,
      nearKeyFib: w.nearKeyFib,
      reclaimTriggerPct: TRIGGER_RECLAIM_PCT,
      nearBandPct: bands.nearBandPct,
      undercutBandPct: bands.undercutBandPct,
    });
    if (det.nearLevel || det.undercut) {
      if (det.levelKind === 'fib') w.nearKeyFib = true;
      if (det.levelKind === 'support' || det.levelKind === 'mtf') {
        w.nearSupport = true;
      }
    }
  } catch {
    /* keep computed flags */
  }
}

function buildQualityParkEvalInput(w: DipWatchEntry) {
  return {
    mint: w.mint,
    source: w.source,
    marketCapUsd: w.marketCapUsd,
    liquidityUsd: w.liquidityUsd,
    volumeH1Usd: w.volumeH1Usd,
    holderCount: w.holderCount,
    supportPriceSol: w.supportPriceSol,
    fib05PriceSol: w.fib05PriceSol,
    fib618PriceSol: w.fib618PriceSol,
    nearKeyFib: w.nearKeyFib,
    nearSupport: w.nearSupport,
    multiTfSupportHits: w.multiTfSupportHits,
    movement: {
      priceChangeH1Pct: w.priceChangeH1Pct,
      priceChangeH6Pct: w.priceChangeH6Pct,
      priceChange24hPct: w.priceChange24hPct,
      range24hPct:
        w.priceChange24hPct != null
          ? Math.abs(Number(w.priceChange24hPct))
          : null,
      volumeH1Usd: w.volumeH1Usd,
    },
    softAllowDenied: null as boolean | null,
    lateChase: false,
  };
}

/**
 * Arm quality parks via Steady/HWR playbooks (1.2.263).
 * Steady may soft-arm on structure+movement; HWR needs near/confluence.
 */
function maybeArmQualityPark(
  w: DipWatchEntry,
  now: number,
  dropOk: boolean,
  opts?: { keepDipIdentity?: boolean }
): boolean {
  if (w.status !== 'watching') return false;
  if (!isQualityBandSource(w.source)) return false;
  try {
    const { classifyQualityParkNameExclusion } =
      require('./qualityParkNameExclusions') as typeof import('./qualityParkNameExclusions');
    if (classifyQualityParkNameExclusion(w.symbol, w.name)) {
      return false;
    }
  } catch {
    /* optional */
  }
  try {
    const {
      evaluateQualityParkArm,
      noteQualityParkFunnel,
      clearDeadTapeStreak,
      registerSoftMovementArm,
      noteSoftMovementGrant,
    } = require('./qualityParkPlaybook') as typeof import('./qualityParkPlaybook');
    const verdict = evaluateQualityParkArm({
      ...buildQualityParkEvalInput(w),
      exclusiveProfileId:
        w.preferredProfileId === 'high_win_rate' ||
        w.preferredProfileId === 'steady_compounder'
          ? w.preferredProfileId
          : undefined,
    });
    w.movementActive = verdict.movementActive;
    w.qualityChip = verdict.chip;
    if (!verdict.ok || !verdict.profileId) {
      if (verdict.denyKey === 'low_movement') {
        noteDipFunnel('quality_low_movement');
      }
      w.lastReason = verdict.reason;
      return false;
    }
    // HWR only arms when playbook ok (near/confluence); Steady softArmOk allows levels-ready
    if (verdict.profileId === 'high_win_rate' && !verdict.ok) return false;
    if (
      verdict.profileId === 'steady_compounder' &&
      !verdict.softArmOk &&
      !(w.nearKeyFib || w.nearSupport)
    ) {
      return false;
    }
    if (
      shouldSkipArmForCap(
        verdict.profileId,
        countArmedWatchesForProfile(watches.values(), verdict.profileId)
      ) ||
      (verdict.profileId === 'high_win_rate' &&
        (w.watchScore ?? 0) < WATCH_ARM_SCORE_FLOOR)
    ) {
      w.lastReason = 'skipped_low_score · arm cap';
      return false;
    }
    if (verdict.softMovement === true) {
      if (!registerSoftMovementArm(w.mint)) {
        noteDipFunnel('quality_low_movement');
        w.lastReason = 'soft_movement_cap';
        return false;
      }
      w.softMovement = true;
      noteSoftMovementGrant();
      noteQualityParkFunnel(verdict.profileId, 'soft_movement');
    } else {
      w.softMovement = false;
    }
    w.preferredProfileId =
      opts?.keepDipIdentity === true
        ? 'dip_buyer'
        : verdict.profileId;
    w.armTag = verdict.armTag || undefined;
    w.status = 'armed';
    w.armedAt = now;
    w.updatedAt = now;
    resetArmClockOnArm(w);
    const nearTa = w.nearKeyFib === true || w.nearSupport === true;
    w.lastReason = nearTa
      ? dropOk
        ? `${verdict.armTag} · near + dip`
        : `${verdict.armTag} · near`
      : `${verdict.armTag} · waiting reclaim`;
    stampWatchPlan(w);
    noteDipFunnel('armed');
    noteQualityBandFunnel(w.source, 'armed');
    stampDipWatchEligibility(w);
    noteDipProfileArmed(w);
    noteQualityParkFunnel(verdict.profileId, 'armed');
    if (verdict.profileId === 'steady_compounder') {
      noteDipFunnel('steady_armed');
    } else {
      noteDipFunnel('hwr_armed');
    }
    clearDeadTapeStreak(w.mint);
    console.log(
      `[dip-watch] ARMED ${w.symbol} [${verdict.profileId}] ${verdict.armTag}` +
        (verdict.softMovement ? ' · soft_movement' : '') +
        (nearTa ? '' : ' (soft · structure)')
    );
    if (verdict.profileId === 'steady_compounder') {
      console.log(`[STEADY-COMPOUNDER] arm ${w.symbol} [${w.source}]`);
    } else {
      console.log(`[HWR] arm ${w.symbol} [${w.source}]`);
    }
    try {
      const { recordSetupWatchEvent } =
        require('./setupWatchEvents') as typeof import('./setupWatchEvents');
      recordSetupWatchEvent({
        kind: 'armed',
        family: 'dip',
        mint: w.mint,
        symbol: w.symbol,
        profileId: verdict.profileId,
        reason: w.lastReason,
        qualityScore: w.qualityScore,
        watchScore: w.watchScore,
        entryStyle: w.entryStyle,
      });
    } catch {
      /* optional */
    }
    return true;
  } catch {
    return false;
  }
}

/** Eager Fib/S seed after parking so near-arm (minors) / quality playbook arm can happen ASAP. */
function scheduleEagerLevelSeed(w: DipWatchEntry): void {
  if (!isRpcWorkloadEnabled('dip_setup_watch')) return;
  void (async () => {
    try {
      await refreshWatchMarket(w, Date.now(), { force: true });
      if (w.status !== 'watching' && w.status !== 'armed') return;
      const dropOk =
        w.dropFromPeakPct != null &&
        w.dropFromPeakPct >= ARM_NEAR_DROP_MIN &&
        w.dropFromPeakPct <= 45;
      if (isQualityBandSource(w.source)) {
        maybeArmQualityPark(w, Date.now(), dropOk);
        return;
      }
      // Minors: arm only when near Fib/S after seed (no Steady soft-arm).
      const nearTa =
        w.nearKeyFib === true ||
        w.nearSupport === true ||
        (w.fightDipDna === true &&
          watchHasLevelEvidence(w) &&
          w.volOk === true);
      if (w.status === 'watching' && nearTa) {
        const now = Date.now();
        if (
          shouldSkipArmForCap(
            'dip_buyer',
            countArmedWatchesForProfile(watches.values(), 'dip_buyer')
          )
        ) {
          return;
        }
        w.status = 'armed';
        w.armedAt = now;
        w.updatedAt = now;
        resetArmClockOnArm(w);
        w.lastReason = dropOk ? 'armed near Fib/S + dip' : 'armed near Fib/S';
        stampWatchPlan(w);
        noteDipFunnel('armed');
        noteMinorsFunnel('armed');
        console.log(`[dip-watch] ARMED ${w.symbol} (eager minor seed)`);
      }
    } catch {
      /* fail soft */
    }
  })();
}

function refreshDropFromPeak(w: DipWatchEntry, h1ChangePct?: number | null): void {
  const px = w.lastPriceSol;
  if (px != null && Number.isFinite(px) && px > 0) {
    const prevPeak = w.peakPriceSol;
    if (prevPeak == null || !Number.isFinite(prevPeak) || prevPeak <= 0) {
      w.peakPriceSol = px;
    } else if (px > prevPeak * PEAK_GLITCH_JUMP_MULT) {
      // Feed unit glitch / pair switch — reset peak, do not invent a dump
      w.peakPriceSol = px;
      w.dropFromPeakPct = null;
    } else if (px > prevPeak) {
      w.peakPriceSol = px;
    } else {
      const peak = w.peakPriceSol!;
      const fromPeak = ((peak - px) / peak) * 100;
      if (Number.isFinite(fromPeak) && fromPeak > 0) {
        // One-tick cliff without confirming H1 → treat as bad mark, rebase peak
        const h1Abs =
          h1ChangePct != null && Number.isFinite(h1ChangePct)
            ? Math.abs(Number(h1ChangePct))
            : null;
        if (
          fromPeak >= PEAK_GLITCH_DROP_PCT &&
          (h1Abs == null || h1Abs < fromPeak * 0.5)
        ) {
          w.peakPriceSol = px;
          w.dropFromPeakPct = h1Abs != null && h1Abs > 1 ? h1Abs : null;
        } else {
          w.dropFromPeakPct = fromPeak;
        }
      }
    }
  }
  // Dex H1 change as soft fill when peak tracking is flat / missing
  if (
    h1ChangePct != null &&
    Number.isFinite(h1ChangePct) &&
    h1ChangePct < -1
  ) {
    const fromH1 = Math.abs(h1ChangePct);
    if (fromH1 > H1_SOFT_FILL_MAX_PCT) {
      // Ignore extreme H1 prints for invalidate math
      return;
    }
    if (w.dropFromPeakPct == null || fromH1 > w.dropFromPeakPct) {
      w.dropFromPeakPct = fromH1;
    }
  }
}

async function refreshWatchMarket(
  w: DipWatchEntry,
  now: number,
  opts?: { force?: boolean; allowOhlcv?: boolean }
): Promise<void> {
  if (!isRpcWorkloadEnabled('dip_setup_watch')) return;
  const isQuality = isQualityBandSource(w.source);
  const minGap = isQuality ? QUALITY_MC_REFRESH_MIN_MS : MC_REFRESH_MIN_MS;
  const last = lastMcRefreshAt.get(w.mint) ?? 0;
  if (!opts?.force && now - last < minGap) return;

  // Budget expensive HTTP (Dex snapshot + Gecko OHLCV) across large inventories
  if (!opts?.force) {
    if (fullRefreshBudget <= 0) return;
    fullRefreshBudget -= 1;
  }
  noteWatcherPoll('dip');

  lastMcRefreshAt.set(w.mint, now);
  let h1Change: number | null = null;
  try {
    const snap = await fetchLiveTokenSnapshot(w.mint);
    if (snap) {
      if (snap.marketCapUsd != null && snap.marketCapUsd > 0) {
        w.marketCapUsd = snap.marketCapUsd;
      }
      if (snap.volumeH1Usd != null && snap.volumeH1Usd > 0) {
        w.volumeH1Usd = snap.volumeH1Usd;
      }
      if (snap.priceSol != null && snap.priceSol > 0) {
        w.lastPriceSol = snap.priceSol;
      }
      if (
        snap.priceChangeH1Pct != null &&
        Number.isFinite(snap.priceChangeH1Pct)
      ) {
        h1Change = Number(snap.priceChangeH1Pct);
        w.priceChangeH1Pct = h1Change;
      }
      if (
        (snap as { priceChangeH6Pct?: number }).priceChangeH6Pct != null &&
        Number.isFinite((snap as { priceChangeH6Pct?: number }).priceChangeH6Pct)
      ) {
        w.priceChangeH6Pct = Number(
          (snap as { priceChangeH6Pct?: number }).priceChangeH6Pct
        );
      }
      if (
        (snap as { priceChange24hPct?: number }).priceChange24hPct != null &&
        Number.isFinite(
          (snap as { priceChange24hPct?: number }).priceChange24hPct
        )
      ) {
        w.priceChange24hPct = Number(
          (snap as { priceChange24hPct?: number }).priceChange24hPct
        );
      }
      if (
        (snap as { liquidityUsd?: number }).liquidityUsd != null &&
        Number.isFinite((snap as { liquidityUsd?: number }).liquidityUsd)
      ) {
        w.liquidityUsd = Number(
          (snap as { liquidityUsd?: number }).liquidityUsd
        );
      }
    }
  } catch {
    /* keep last */
  }

  const hasLevelsAlready = watchHasFibOrSupportLevels(w);
  const lastOhlcv = lastOhlcvRefreshAt.get(w.mint) ?? 0;
  const wantOhlcv =
    opts?.allowOhlcv !== false &&
    (opts?.force === true ||
      !isQuality ||
      !hasLevelsAlready ||
      now - lastOhlcv >= QUALITY_OHLCV_REFRESH_MIN_MS);

  // Multi-TF S/R confluence (Mode B parity) — fail soft; skip when throttled
  let multiByTf: Awaited<ReturnType<typeof fetchMultiTfOhlcv>>['byTf'] | null =
    null;
  if (wantOhlcv) {
    try {
      const multi = await fetchMultiTfOhlcv(w.mint, {
        solUsd: undefined,
        // Quality parks: 1h/4h support (12h not in OHLCV set). Minors keep 5m/15m/1h.
        tfs: isQuality ? ['15m', '1h', '4h'] : undefined,
      });
      lastOhlcvRefreshAt.set(w.mint, now);
      if (Object.keys(multi.byTf).length > 0) {
        multiByTf = multi.byTf;
        const conf = analyzeSrConfluenceFromCandles(w.mint, multi.byTf, {
          priceSol: w.lastPriceSol,
        });
        if (conf.primarySupport != null && conf.primarySupport > 0) {
          if (isSupportSideLevel(conf.primarySupport, w.lastPriceSol)) {
            w.supportPriceSol = conf.primarySupport;
          }
        }
        const hits = conf.supportTfHits?.length ?? 0;
        w.multiTfSupportHits = hits;
        if (conf.nearMultiTfSupport || hits > 0) {
          w.nearSupport = true;
        }
      }
    } catch {
      /* keep last levels */
    }
  }

  // Technical Fib / support refresh — seed candles for quality parks so Steady can arm
  try {
    const { getTechnicalLevelsForStrategy } =
      require('./technicalLevels') as typeof import('./technicalLevels');
    // Prefer 4h then 1h for quality parks; dip minors keep faster TFs
    const candlePick =
      (multiByTf &&
        (isQuality
          ? multiByTf['4h'] ||
            multiByTf['1h'] ||
            multiByTf['30m'] ||
            multiByTf['15m']
          : multiByTf['1h'] ||
            multiByTf['15m'] ||
            multiByTf['5m'] ||
            multiByTf['4h'] ||
            multiByTf['30m'])) ||
      null;
    const tech = getTechnicalLevelsForStrategy({
      mint: w.mint,
      priceSol: w.lastPriceSol ?? undefined,
      candles:
        candlePick && candlePick.length >= 8
          ? candlePick.map((c) => ({
              time: c.time,
              priceSol: c.priceSol,
              volume: c.volume,
            }))
          : undefined,
    });
    if (tech) {
      const live = w.lastPriceSol;
      const supPx = tech.nearestSupport?.mid;
      if (
        supPx != null &&
        Number.isFinite(supPx) &&
        supPx > 0 &&
        isSupportSideLevel(supPx, live)
      ) {
        w.supportPriceSol = Number(supPx);
      } else if (
        w.supportPriceSol != null &&
        !isSupportSideLevel(w.supportPriceSol, live)
      ) {
        w.supportPriceSol = null;
      }
      let raw05: number | null = null;
      let raw618: number | null = null;
      for (const z of [
        ...(tech.fibZones || []),
        ...(tech.snapshot?.fib?.levels || []),
      ]) {
        const ratio = Number(z.ratio);
        const px = Number(z.price);
        if (!Number.isFinite(px) || px <= 0) continue;
        if (raw05 == null && Math.abs(ratio - 0.5) < 0.001) raw05 = px;
        if (raw618 == null && Math.abs(ratio - 0.618) < 0.02) raw618 = px;
      }
      const picked = pickDipRetracementLevels({
        livePrice: live,
        swingHigh: tech.snapshot?.fib?.swingHigh,
        swingLow: tech.snapshot?.fib?.swingLow,
        fib05: raw05,
        fib618: raw618,
      });
      w.fib05PriceSol = picked.fib05;
      w.fib618PriceSol = picked.fib618;
    }
  } catch {
    /* optional TA */
  }

  refreshDropFromPeak(w, h1Change);
  recomputeProximityFromLevels(w);

  const hasLevels = watchHasFibOrSupportLevels(w);
  // Count once per mint per ~20m streak tick — avoid noLvl×1497 inflation
  if (!hasLevels) {
    const lastNoted = noLevelsFunnelNotedAt.get(w.mint) ?? 0;
    if (now - lastNoted >= NO_LEVELS_FUNNEL_DEDUP_MS) {
      noteDipFunnel('no_levels');
      noLevelsFunnelNotedAt.set(w.mint, now);
    }
  } else {
    noLevelsFunnelNotedAt.delete(w.mint);
  }

  // Medium/Majors: name/class + MC-band rotate, then dead-tape / no-levels
  if (isQualityBandSource(w.source)) {
    if (maybeRotateExcludedOrOutOfBandQualityWatch(w, now)) {
      return;
    }
    try {
      const {
        evaluateQualityMovement,
        noteDeadTapeObservation,
        clearDeadTapeStreak,
        noteQualityParkFunnel,
      } = require('./qualityParkPlaybook') as typeof import('./qualityParkPlaybook');
      const mov = evaluateQualityMovement(
        {
          priceChangeH1Pct: w.priceChangeH1Pct ?? h1Change,
          priceChangeH6Pct: w.priceChangeH6Pct,
          priceChange24hPct: w.priceChange24hPct,
          range24hPct:
            w.priceChange24hPct != null
              ? Math.abs(Number(w.priceChange24hPct))
              : null,
          volumeH1Usd: w.volumeH1Usd,
        },
        {
          watchBand: isMajorsSource(w.source) ? 'majors' : 'medium',
        }
      );
      w.movementActive = mov.active;
      if (!mov.active) {
        w.qualityChip = 'low_movement';
        const { rotate } = noteDeadTapeObservation(w.mint, true, now, {
          watchBand: isMajorsSource(w.source) ? 'majors' : 'medium',
        });
        if (rotate && w.status !== 'armed') {
          const pid =
            w.preferredProfileId === 'high_win_rate'
              ? 'high_win_rate'
              : 'steady_compounder';
          noteQualityParkFunnel(pid, 'rotated_stale');
          noteDipFunnel(
            pid === 'high_win_rate' ? 'hwr_rotated_stale' : 'steady_rotated_stale'
          );
          noteDipFunnel('quality_low_movement');
          noteQualityBandFunnel(w.source, 'expired');
          releaseQualitySoftArm(w.mint);
          w.status = 'expired';
          w.updatedAt = now;
          w.lastReason = 'rotated stale · dead tape';
          w.qualityChip = 'rotated_stale';
          console.log(
            `[dip-watch] ROTATE ${w.symbol} [${w.source}] — dead tape / low movement`
          );
          clearDeadTapeStreak(w.mint);
          try {
            const { clearOneSetupProfileLock } =
              require('./expectancyLift') as typeof import('./expectancyLift');
            clearOneSetupProfileLock(w.mint, 'expired');
          } catch {
            /* optional */
          }
          return;
        }
      } else {
        clearDeadTapeStreak(w.mint);
        if (w.qualityChip === 'low_movement' || w.qualityChip === 'rotated_stale') {
          w.qualityChip = 'active';
        }
        if (!hasLevels && w.qualityChip !== 'rotated_stale') {
          w.qualityChip = 'no_level';
        } else if (hasLevels && w.qualityChip === 'no_level') {
          w.qualityChip = 'active';
        }
      }
    } catch {
      /* optional */
    }
    try {
      const {
        noteMajorsLevelsPresence,
        clearMajorsNoLevelsStreak,
      } = require('./majorsUniverse') as typeof import('./majorsUniverse');
      // Armed or structure present → clear streak. Watching without levels rotates
      // (Steady/HWR no longer exempt — that pinned statues for 10h).
      if (hasLevels || w.status === 'armed') {
        clearMajorsNoLevelsStreak(w.mint);
      } else {
        const { rotate, streak } = noteMajorsLevelsPresence(
          w.mint,
          false,
          w.marketCapUsd,
          { watchBand: isMajorsSource(w.source) ? 'majors' : 'medium' }
        );
        if (rotate) {
          noteDipFunnel('no_levels_rotate');
          noteQualityBandFunnel(w.source, 'expired');
          const pid =
            w.preferredProfileId === 'high_win_rate'
              ? 'high_win_rate'
              : 'steady_compounder';
          try {
            const { noteQualityParkFunnel } =
              require('./qualityParkPlaybook') as typeof import('./qualityParkPlaybook');
            noteQualityParkFunnel(pid, 'rotated_stale');
          } catch {
            /* optional */
          }
          noteDipFunnel(
            pid === 'high_win_rate' ? 'hwr_rotated_stale' : 'steady_rotated_stale'
          );
          releaseQualitySoftArm(w.mint);
          w.status = 'expired';
          w.updatedAt = now;
          w.lastReason = `no levels ×${streak} (~20m) — rotate`;
          w.qualityChip = 'rotated_stale';
          console.log(
            `[dip-watch] ROTATE ${w.symbol} [${w.source}] — no Fib/S after ${streak}×20m ticks`
          );
          try {
            const { clearOneSetupProfileLock } =
              require('./expectancyLift') as typeof import('./expectancyLift');
            clearOneSetupProfileLock(w.mint, 'expired');
          } catch {
            /* optional */
          }
          clearMajorsNoLevelsStreak(w.mint);
          noLevelsFunnelNotedAt.delete(w.mint);
        }
      }
    } catch {
      /* optional */
    }
  }
}

/**
 * Consider a candidate for the Dip watchlist (specialty / scanner mature tokens).
 */
export function considerDipWatchSetup(input: {
  mint: string;
  symbol: string;
  name?: string;
  marketCapUsd?: number;
  volumeH1Usd?: number;
  holderCount?: number;
  dropFromPeakPct?: number | null;
  priceChangeH1Pct?: number | null;
  nearKeyFib?: boolean;
  nearSupport?: boolean;
  lastPriceSol?: number | null;
  supportPriceSol?: number | null;
  fib05PriceSol?: number | null;
  fib618PriceSol?: number | null;
  kolCount?: number;
  source?: string;
  majorsBand?: string;
  preferredProfileId?: string;
  pairCreatedAtMs?: number;
  tokenAgeHours?: number;
  isPumpFun?: boolean;
  scannerReasons?: string[] | string | null;
  volumeM5Usd?: number;
}): DipWatchEntry | null {
  lastDipAdmitReject = '';
  if (!isDipProfileEnabled()) {
    lastDipAdmitReject = 'profile_off';
    return null;
  }
  if (!input.mint) {
    lastDipAdmitReject = 'no_mint';
    return null;
  }
  if (isManualUnwatchCooldown(input.mint)) {
    noteDipFunnel('unwatch_cd');
    return null;
  }
  const m = dipMatch();
  const dipBand = getEffectiveMcBand('dip_buyer');
  const minMc = dipBand.min > 0 ? dipBand.min : 1_000_000;
  const maxMc = dipBand.max > 0 ? dipBand.max : 500_000_000;
  const minHolders = m.minHolders ?? 80;
  const minVol = m.minVolumeH1Usd ?? 8_000;
  const minDrop = m.minDropFromPeakPct ?? 8;
  const maxDrop = m.maxDropFromPeakPct ?? 45;
  const isMajors = isMajorsSource(input.source);
  const isMedium = isMediumSource(input.source);
  const isQuality = isMajors || isMedium;
  const bucket = watchBucket(input.source);
  const fightDna = hasDipFightDna(input.scannerReasons, {
    nearKeyFib: input.nearKeyFib,
    nearSupport: input.nearSupport,
  });
  if (fightDna && input.nearSupport !== true && input.nearKeyFib !== true) {
    input.nearSupport = true;
  }
  const nearTaEarly =
    input.nearKeyFib === true || input.nearSupport === true;
  const dropEarly = input.dropFromPeakPct;
  const dropStartedEarly =
    dropEarly != null && dropEarly >= Math.min(5, minDrop);
  if (isQuality) {
    noteQualityBandFunnel(input.source, 'candidates_seen');
    try {
      const { classifyQualityParkNameExclusion } =
        require('./qualityParkNameExclusions') as typeof import('./qualityParkNameExclusions');
      const excl = classifyQualityParkNameExclusion(
        input.symbol,
        input.name
      );
      if (excl) {
        noteDipFunnel(
          excl === 'excluded_stock_name_token'
            ? 'quality_excluded_stock'
            : 'quality_excluded_proxy'
        );
        console.log(
          `[WATCHLIST-${isMajors ? 'MAJOR' : 'MEDIUM'}] reject ${excl} ${input.symbol}`
        );
        return null;
      }
    } catch {
      /* optional */
    }
  } else {
    noteMinorsFunnel('candidates_seen');
  }

  // Scalper / Mode B: mutual-exclude only while a Mode B arm is live.
  // Stale watching-only Mode B parks must not starve Dip minors.
  try {
    const { isMintOnActiveScalperWatch, getModeBFunnelCounters } =
      require('./scalperSetupWatch') as typeof import('./scalperSetupWatch');
    if (isMintOnActiveScalperWatch(input.mint)) {
      const armedNow = Number(getModeBFunnelCounters().armedNow || 0);
      if (armedNow > 0) {
        noteDipFunnel('mutual_exclude');
        noteDipFunnel('mx_scalper');
        return null;
      }
    }
  } catch {
    /* optional */
  }
  // Trend: do not steal a live continuation (DNA≥4, drop<8%, H1 green).
  try {
    const {
      isMintOnActiveTrendWatch,
      expireTrendWatchForDipAdmit,
      getActiveTrendWatch,
      noteTrendFunnel,
    } = require('./trendSetupWatch') as typeof import('./trendSetupWatch');
    if (isMintOnActiveTrendWatch(input.mint)) {
      const tw = getActiveTrendWatch(input.mint);
      const trendHits = Number(tw?.dnaHits ?? 0);
      const drop = Number(input.dropFromPeakPct ?? 0);
      const h1 = Number(input.priceChangeH1Pct);
      const h1Green = Number.isFinite(h1) && h1 > 0;
      const dipDumpBeats =
        Number.isFinite(drop) && drop >= 8 && (nearTaEarly || dropStartedEarly);
      if (trendHits >= 4 && drop < 8 && h1Green && !dipDumpBeats) {
        noteTrendFunnel('trend_admitted_despite_dip_watching');
        noteDipFunnel('mutual_exclude');
        noteDipFunnel('mx_trend');
        return null;
      }
      if (isQuality) {
        if (trendHits >= 4 && drop < 8 && !dipDumpBeats) {
          noteTrendFunnel('trend_admitted_despite_dip_watching');
          noteDipFunnel('mutual_exclude');
          noteDipFunnel('mx_trend');
          return null;
        }
        expireTrendWatchForDipAdmit(
          input.mint,
          'Yielded to Dip/Steady quality park'
        );
      } else if (nearTaEarly && drop >= 8) {
        expireTrendWatchForDipAdmit(
          input.mint,
          'Yielded to Dip minor dump-reclaim'
        );
      } else {
        noteDipFunnel('mutual_exclude');
        noteDipFunnel('mx_trend');
        return null;
      }
    }
  } catch {
    /* optional */
  }

  pruneTerminal();
  const existing = watches.get(input.mint);
  if (existing && isActiveWatch(existing)) {
    // Already admitted — refresh metrics even if MC dipped under admit floor.
    // Do NOT bump updatedAt on bare quality re-offer — that starved the status
    // slice (sorted by updatedAt) of minors. Bump only when TA/metrics move.
    const dropChanged =
      input.dropFromPeakPct != null &&
      input.dropFromPeakPct !== existing.dropFromPeakPct;
    const taChanged =
      (input.nearKeyFib != null && input.nearKeyFib !== existing.nearKeyFib) ||
      (input.nearSupport != null &&
        input.nearSupport !== existing.nearSupport) ||
      (input.supportPriceSol != null &&
        input.supportPriceSol !== existing.supportPriceSol) ||
      (input.fib05PriceSol != null &&
        input.fib05PriceSol !== existing.fib05PriceSol) ||
      (input.fib618PriceSol != null &&
        input.fib618PriceSol !== existing.fib618PriceSol);
    existing.dropFromPeakPct = input.dropFromPeakPct ?? existing.dropFromPeakPct;
    existing.nearKeyFib = input.nearKeyFib ?? existing.nearKeyFib;
    existing.nearSupport = input.nearSupport ?? existing.nearSupport;
    existing.lastPriceSol = input.lastPriceSol ?? existing.lastPriceSol;
    existing.supportPriceSol =
      input.supportPriceSol ?? existing.supportPriceSol;
    existing.fib05PriceSol = input.fib05PriceSol ?? existing.fib05PriceSol;
    existing.fib618PriceSol = input.fib618PriceSol ?? existing.fib618PriceSol;
    existing.marketCapUsd = input.marketCapUsd ?? existing.marketCapUsd;
    existing.volumeH1Usd = input.volumeH1Usd ?? existing.volumeH1Usd;
    existing.holderCount = input.holderCount ?? existing.holderCount;
    existing.kolCount = input.kolCount ?? existing.kolCount;
    if (
      input.pairCreatedAtMs != null &&
      Number.isFinite(input.pairCreatedAtMs) &&
      input.pairCreatedAtMs > 0
    ) {
      existing.pairCreatedAtMs = input.pairCreatedAtMs;
    }
    if (
      input.tokenAgeHours != null &&
      Number.isFinite(input.tokenAgeHours) &&
      input.tokenAgeHours >= 0
    ) {
      existing.tokenAgeHours = input.tokenAgeHours;
    }
    if (isQuality) {
      existing.source = isMedium ? 'medium' : 'majors';
      existing.majorsBand = input.majorsBand ?? existing.majorsBand;
      const dumpReclaim =
        Number(existing.dropFromPeakPct ?? 0) >= 8 &&
        (existing.nearKeyFib === true || existing.nearSupport === true) &&
        isInDipBuyerMcBand(existing.marketCapUsd);
      if (dumpReclaim) {
        existing.preferredProfileId = 'dip_buyer';
      } else if (input.preferredProfileId) {
        existing.preferredProfileId = input.preferredProfileId;
      }
      // Keep quality TTL from sliding under 4h memecoin default on refresh
      const remain = existing.expiresAt - Date.now();
      if (remain < MAJORS_TTL_MS / 2) {
        existing.expiresAt = Date.now() + MAJORS_TTL_MS;
      }
      stampDipWatchEligibility(existing);
    } else {
      // Minors always stay Dip — never inherit Steady/HWR prefer from specialty.
      if (
        existing.preferredProfileId &&
        existing.preferredProfileId !== 'dip_buyer'
      ) {
        noteDipFunnel('minors_leak_prefer_remapped');
      }
      existing.preferredProfileId = 'dip_buyer';
    }
    if (dropChanged || taChanged || !isQuality) {
      existing.updatedAt = Date.now();
    }
    recomputeProximityFromLevels(existing);
    existing.targetDipEntries = buildTargetDipEntries(existing);
    stampDipWatchEligibility(existing);
    return existing;
  }

  const mc = input.marketCapUsd;
  const inDipBand = isInDipBuyerMcBand(mc);
  const aboveDipMax = isAboveDipBuyerMaxMc(mc);
  if (
    !isQuality &&
    (mc == null || !Number.isFinite(Number(mc)) || Number(mc) <= 0 || Number(mc) < minMc)
  ) {
    noteDipFunnel('mc');
    noteDipFunnel('vol_liq_mc');
    return null;
  }
  if (!isQuality && Number.isFinite(Number(mc)) && Number(mc) > maxMc) {
    noteDipFunnel('mc');
    noteDipFunnel('vol_liq_mc');
    return null;
  }
  if (
    !isQuality &&
    input.holderCount != null &&
    input.holderCount > 0 &&
    input.holderCount < minHolders
  ) {
    noteDipFunnel('liq');
    noteDipFunnel('vol_liq_mc');
    return null;
  }
  if (
    !isQuality &&
    input.volumeH1Usd != null &&
    input.volumeH1Usd > 0 &&
    input.volumeH1Usd < minVol
  ) {
    noteDipFunnel('vol');
    noteDipFunnel('vol_liq_mc');
    return null;
  }

  const drop = input.dropFromPeakPct;
  const nearTa = nearTaEarly;
  const dropStarted = drop != null && drop >= Math.min(5, minDrop);
  const h1Dip =
    input.priceChangeH1Pct != null && input.priceChangeH1Pct < -1;
  // Medium/Majors: admit to watching without force-buy when S/R thin (arm later).
  // Memecoins: need early dip signal OR Fib/S proximity OR fight DNA / H1 dip.
  if (!isQuality && !dropStarted && !nearTa && !fightDna && !h1Dip) {
    noteDipFunnel('no_setup');
    noteDipFunnel('vol_liq_mc');
    lastDipAdmitReject = 'no_setup';
    return null;
  }
  if (drop != null && drop > maxDrop) {
    noteDipFunnel('max_drop');
    noteDipFunnel('vol_liq_mc');
    return null;
  }

  const activeBefore = activeWatches(bucket).length;
  if (
    !reserveAdmitSlot(bucket, {
      mint: input.mint,
      volumeH1Usd: input.volumeH1Usd,
    })
  ) {
    noteDipFunnel('at_cap');
    return null;
  }
  void activeBefore;

  const now = Date.now();
  // Arm on Fib/S proximity; drop is soft preference (not forever AND-gated)
  const armed = nearTa;
  // Dip MC band owns dip_buyer identity. Above max, quality parks prefer Steady/HWR.
  let preferSafe: 'steady_compounder' | 'high_win_rate' | 'dip_buyer';
  if (inDipBand || !isQuality) {
    if (
      input.preferredProfileId &&
      input.preferredProfileId !== 'dip_buyer'
    ) {
      noteDipFunnel('minors_leak_prefer_remapped');
    }
    preferSafe = 'dip_buyer';
  } else {
    const prefer = input.preferredProfileId || 'steady_compounder';
    if (
      prefer === 'high_win_rate' ||
      prefer === 'steady_compounder' ||
      prefer === 'dip_buyer'
    ) {
      preferSafe = aboveDipMax && prefer === 'dip_buyer' ? 'steady_compounder' : prefer;
    } else {
      preferSafe = 'steady_compounder';
    }
    if (preferSafe === 'high_win_rate') noteDipFunnel('hwr_candidates_seen');
    else if (preferSafe === 'steady_compounder') {
      noteDipFunnel('steady_candidates_seen');
    }
  }
  const ageHours =
    input.tokenAgeHours != null && Number.isFinite(input.tokenAgeHours)
      ? Number(input.tokenAgeHours)
      : input.pairCreatedAtMs != null &&
          Number.isFinite(input.pairCreatedAtMs) &&
          input.pairCreatedAtMs > 0
        ? Math.max(0, (now - Number(input.pairCreatedAtMs)) / 3_600_000)
        : undefined;
  let isPumpFun = input.isPumpFun === true;
  if (!isPumpFun) {
    try {
      const { isPumpFunMintSuffix } =
        require('./deadTokenFilters') as typeof import('./deadTokenFilters');
      isPumpFun = isPumpFunMintSuffix(input.mint);
    } catch {
      isPumpFun = String(input.mint || '')
        .toLowerCase()
        .endsWith('pump');
    }
  }
  const entry: DipWatchEntry = {
    mint: input.mint,
    symbol: input.symbol || input.mint.slice(0, 6),
    name: input.name || input.symbol || 'Dip watch',
    status: armed ? 'armed' : 'watching',
    createdAt: now,
    updatedAt: now,
    armedAt: armed ? now : null,
    expiresAt: now + (isQuality ? MAJORS_TTL_MS : DEFAULT_TTL_MS),
    marketCapUsd: mc,
    volumeH1Usd: input.volumeH1Usd,
    holderCount: input.holderCount,
    dropFromPeakPct: drop,
    nearKeyFib: input.nearKeyFib,
    nearSupport: input.nearSupport,
    supportPriceSol: input.supportPriceSol ?? null,
    lastPriceSol: input.lastPriceSol ?? null,
    peakPriceSol: input.lastPriceSol ?? null,
    fib05PriceSol: input.fib05PriceSol ?? null,
    fib618PriceSol: input.fib618PriceSol ?? null,
    kolCount: input.kolCount,
    source: isMajors
      ? 'majors'
      : isMedium
        ? 'medium'
        : input.source || 'scanner',
    majorsBand: isQuality ? input.majorsBand : undefined,
    preferredProfileId: preferSafe,
    pairCreatedAtMs:
      input.pairCreatedAtMs != null &&
      Number.isFinite(input.pairCreatedAtMs) &&
      input.pairCreatedAtMs > 0
        ? Number(input.pairCreatedAtMs)
        : undefined,
    tokenAgeHours: ageHours,
    isPumpFun: isQuality ? isPumpFun : undefined,
    lastReason: armed
      ? dropStarted
        ? 'near Fib/S + dip'
        : 'near Fib/S'
      : isMajors
        ? 'majors watch'
        : isMedium
          ? 'medium watch'
          : 'watching for setup',
    fightDipDna: fightDna,
    hasLevel: fightDna || nearTa,
    volumeM5Usd: input.volumeM5Usd,
    lastArmEvalAt: now,
  };
  entry.targetDipEntries = buildTargetDipEntries(entry);
  if (armed) stampWatchPlan(entry);
  watches.set(input.mint, entry);
  stampDipWatchEligibility(entry, true);
  noteDipFunnel('offered');
  try {
    const { recordSetupWatchEvent } =
      require('./setupWatchEvents') as typeof import('./setupWatchEvents');
    recordSetupWatchEvent({
      kind: 'watch_admitted',
      family: 'dip',
      mint: entry.mint,
      symbol: entry.symbol,
      profileId: entry.preferredProfileId || 'dip_buyer',
      reason: entry.lastReason,
    });
  } catch {
    /* optional */
  }
  if (armed) {
    noteDipFunnel('armed');
    if (isQuality) noteQualityBandFunnel(entry.source, 'armed');
    else noteMinorsFunnel('armed');
  } else noteDipFunnel('watching');
  console.log(
    `[dip-watch] ${entry.status.toUpperCase()} ${entry.symbol}` +
      (isQuality
        ? ` [${entry.source}${entry.majorsBand ? `:${entry.majorsBand}` : ''}]`
        : '') +
      ` MC=${mc != null ? `$${Math.round(mc)}` : '?'} drop=${drop != null ? `${drop.toFixed(0)}%` : '?'}`
  );
  if (isQuality) {
    const ageDays =
      ageHours != null ? (ageHours / 24).toFixed(0) : '?';
    const pfx =
      isMajors ? '[WATCHLIST-MAJOR]' : '[WATCHLIST-MEDIUM]';
    console.log(
      `${pfx} soft-gate pass ${entry.symbol} ageDays=${ageDays} ` +
        `MC=${mc != null ? `$${Math.round(mc)}` : '?'} ` +
        `volH1=$${Math.round(input.volumeH1Usd || 0)} ` +
        `reason=admit_${entry.status}` +
        (preferSafe === 'steady_compounder'
          ? ' prefer:steady'
          : preferSafe === 'high_win_rate'
            ? ' prefer:hwr'
            : ' prefer:dip')
    );
    if (preferSafe === 'steady_compounder') {
      console.log(
        `[STEADY-COMPOUNDER] watch ${entry.symbol}` +
          (armed ? ' · arm' : '') +
          ` [${entry.source}]`
      );
    } else if (preferSafe === 'high_win_rate') {
      console.log(
        `[HWR] watch ${entry.symbol}` +
          (armed ? ' · arm' : '') +
          ` [${entry.source}]`
      );
    }
  }
  if (armed) {
    try {
      const { recordSetupWatchEvent } =
        require('./setupWatchEvents') as typeof import('./setupWatchEvents');
      recordSetupWatchEvent({
        kind: 'armed',
        family: 'dip',
        mint: entry.mint,
        symbol: entry.symbol,
        profileId: preferSafe,
        reason: entry.lastReason,
        qualityScore: entry.qualityScore,
        entryStyle: entry.entryStyle,
      });
    } catch {
      /* optional */
    }
  }
  if (isQuality) {
    // Playbook arm after levels seed (Steady soft / HWR near).
    scheduleEagerLevelSeed(entry);
  } else {
    scheduleEagerLevelSeed(entry);
  }
  return entry;
}

function buildHandoff(w: DipWatchEntry): ScannerCandidate & { launch: LaunchEvent } {
  const now = Date.now();
  const isMajors = isMajorsSource(w.source);
  const isMedium = isMediumSource(w.source);
  // Soft prefer: medium/majors stamp Steady or HWR; minors always Dip.
  const prefer =
    isMajors || isMedium
      ? w.preferredProfileId === 'high_win_rate'
        ? 'high_win_rate'
        : w.preferredProfileId === 'dip_buyer'
          ? 'dip_buyer'
          : 'steady_compounder'
      : 'dip_buyer';
  const feedRaw = specialtyFeedFromDipSource(w.source);
  const feed =
    feedRaw === 'scanner'
      ? 'jupiter'
      : (feedRaw as 'jupiter' | 'kolscan' | 'alphascan' | 'majors' | 'medium');
  try {
    const { triggerTagForProfile } =
      require('./qualityParkPlaybook') as typeof import('./qualityParkPlaybook');
    w.armTag = triggerTagForProfile(prefer);
  } catch {
    /* optional */
  }
  // Real token/pool birth — never watch createdAt (watch age contaminated Steady floors)
  const tokenBirthMs =
    w.pairCreatedAtMs != null &&
    Number.isFinite(w.pairCreatedAtMs) &&
    w.pairCreatedAtMs > 0
      ? Number(w.pairCreatedAtMs)
      : w.tokenAgeHours != null &&
          Number.isFinite(w.tokenAgeHours) &&
          w.tokenAgeHours >= 0
        ? now - Number(w.tokenAgeHours) * 3_600_000
        : undefined;
  const launch: LaunchEvent = {
    mint: w.mint,
    symbol: w.symbol,
    name: w.name,
    launchedAt: tokenBirthMs != null && tokenBirthMs > 0 ? tokenBirthMs : 0,
    migrated: true,
    entryPriceSol: w.lastPriceSol || 0,
    lastPriceSol: w.lastPriceSol || 0,
    priceChangePct: w.dropFromPeakPct != null ? -w.dropFromPeakPct : 0,
    marketCapUsd: w.marketCapUsd,
    volumeH1Usd: w.volumeH1Usd,
    volumeUsd: w.volumeH1Usd,
    holderCount: w.holderCount,
    candles: [],
    source: isMajors || isMedium ? 'jupiter' : feed === 'kolscan' ? 'kolscan' : 'jupiter',
    candleSource: 'synthetic',
    preferredProfileId: prefer,
    specialtyFeed: feed,
  };
  return {
    id: `dip-watch-${w.mint.slice(0, 8)}-${now}`,
    mint: w.mint,
    symbol: w.symbol,
    name: w.name,
    timestamp: now,
    status: 'seen',
    rankScore: isMajors || isMedium ? 90 : 88,
    reasons: [
      'dip-watch:triggered',
      'armedWatch',
      ...(isMajors
        ? [`majors${w.majorsBand ? `:${w.majorsBand}` : ''}`]
        : isMedium
          ? [`medium${w.majorsBand ? `:${w.majorsBand}` : ''}`]
          : ['minor']),
      prefer === 'high_win_rate'
        ? 'prefer:high_win_rate'
        : prefer === 'steady_compounder'
          ? 'prefer:steady_compounder'
          : 'prefer:dip_buyer',
      w.armTag ||
        (prefer === 'high_win_rate'
          ? 'hwr_reclaim_trigger'
          : prefer === 'steady_compounder'
            ? 'steady_reclaim_trigger'
            : 'reclaim'),
      w.nearKeyFib ? 'near Fib' : w.nearSupport ? 'near support' : 'reclaim',
      w.entryStyle ||
        (prefer === 'steady_compounder' || prefer === 'high_win_rate'
          ? 'quality_structure_reclaim'
          : 'support_dip_reclaim'),
      w.dropFromPeakPct != null
        ? `drop ${w.dropFromPeakPct.toFixed(0)}%`
        : 'setup',
      w.confluenceCount != null
        ? `taConfluences ${w.confluenceCount}`
        : '',
      ...(Array.isArray(w.playbookPassed) && w.playbookPassed.length
        ? [`taPassed ${w.playbookPassed.slice(0, 6).join('+')}`]
        : []),
    ].filter(Boolean),
    source: isMajors || isMedium ? 'jupiter' : feed === 'kolscan' ? 'kolscan' : 'jupiter',
    migrated: true,
    marketCapUsd: w.marketCapUsd,
    volumeH1Usd: w.volumeH1Usd,
    holderCount: w.holderCount,
    preferredProfileId: prefer,
    specialtyFeed: feed,
    kolCount: w.kolCount,
    nearKeyFib: w.nearKeyFib,
    nearSupport: w.nearSupport,
    candleSource: 'synthetic',
    armedWatch: true,
    dipWatchTriggered: true,
    entryStyleHint:
      prefer === 'steady_compounder' || prefer === 'high_win_rate'
        ? w.entryStyle || 'quality_structure_reclaim'
        : w.entryStyle || 'support_dip_reclaim',
    qualityScoreHint: w.qualityScore ?? undefined,
    sizePlanSol: w.sizePlanSol ?? undefined,
    setupWatchFamily: 'dip',
    playbookPassed: Array.isArray(w.playbookPassed) ? w.playbookPassed : undefined,
    confluenceCountAtTrigger:
      w.confluenceCount != null ? Number(w.confluenceCount) : undefined,
    watchToArmMs:
      w.armedAt != null && w.createdAt > 0 ? Math.max(0, w.armedAt - w.createdAt) : undefined,
    armToTriggerMs:
      w.armedAt != null ? Math.max(0, now - w.armedAt) : undefined,
    watchScoreAtArm: w.watchScoreAtArm,
    watchScoreAtTrigger: w.watchScore,
    watchScoreBreakdown: w.watchScoreBreakdown,
    volumeStateAtWatch: w.volumeState,
    supportPriceSol: w.supportPriceSol ?? null,
    fib05PriceSol: w.fib05PriceSol ?? null,
    fib618PriceSol: w.fib618PriceSol ?? null,
    lastPriceSol: w.lastPriceSol ?? null,
    launch,
  };
}

/**
 * Tick all watches: arm on Fib/S + dip band, trigger on reclaim, expire / invalidate.
 * Returns number of triggered handoffs.
 */
export async function tickDipSetupWatches(opts?: {
  priceByMint?: Map<string, number>;
}): Promise<number> {
  if ((tickDipSetupWatches as { _lane?: boolean })._lane !== true) {
    (tickDipSetupWatches as { _lane?: boolean })._lane = true;
    try {
      const { runSetupWatchLane } =
        require('./rpcRouting') as typeof import('./rpcRouting');
      return await runSetupWatchLane(() => tickDipSetupWatches(opts));
    } finally {
      (tickDipSetupWatches as { _lane?: boolean })._lane = false;
    }
  }
  if (!isDipProfileEnabled()) return 0;
  pruneTerminal();
  const m = dipMatch();
  const minDrop = m.minDropFromPeakPct ?? 8;
  const maxDrop = m.maxDropFromPeakPct ?? 45;
  const now = Date.now();
  let handed = 0;
  fullRefreshBudget = MAX_FULL_REFRESH_PER_TICK;

  for (const row of watches.values()) {
    if (row.status === 'watching' || row.status === 'armed') {
      stampDipPriority(row, now);
    }
  }
  const ordered = sortActiveWatchesByScore([...watches.values()]);
  demoteArmedBeyondCap(ordered, 'dip_buyer', now);

  for (const w of ordered) {
    if (w.status !== 'watching' && w.status !== 'armed') continue;

    if (now >= w.expiresAt) {
      releaseQualitySoftArm(w.mint);
      w.status = 'expired';
      w.updatedAt = now;
      w.lastReason = 'TTL expired';
      noteQualityBandFunnel(w.source, 'expired');
      if (!isQualityBandSource(w.source)) noteMinorsFunnel('expired');
      noteDipProfileExpired(w);
      console.log(`[dip-watch] EXPIRED ${w.symbol}`);
      try {
        const {
          recordSetupWatchEvent,
          noteSetupWatchExpiredUnused,
        } = require('./setupWatchEvents') as typeof import('./setupWatchEvents');
        noteSetupWatchExpiredUnused(w.mint);
        recordSetupWatchEvent({
          kind: w.armedAt != null ? 'false_arm_expired' : 'watch_expired',
          family: 'dip',
          mint: w.mint,
          symbol: w.symbol,
          profileId: 'dip_buyer',
          reason: 'TTL expired',
          qualityScore: w.qualityScore,
          entryStyle: w.entryStyle,
        });
      } catch {
        /* optional */
      }
      try {
        const { clearOneSetupProfileLock } =
          require('./expectancyLift') as typeof import('./expectancyLift');
        clearOneSetupProfileLock(w.mint, 'expired');
      } catch {
        /* optional */
      }
      continue;
    }
    try {
      const { maybeLoosenExpireUnusedTtl } =
        require('./setupWatchEvents') as typeof import('./setupWatchEvents');
      const loosened = maybeLoosenExpireUnusedTtl(w.mint, w.expiresAt, now);
      if (loosened != null) w.expiresAt = loosened;
    } catch {
      /* optional */
    }

    await refreshWatchMarket(w, now);

    const px = opts?.priceByMint?.get(w.mint) ?? w.lastPriceSol ?? null;
    if (px != null) w.lastPriceSol = px;
    recomputeProximityFromLevels(w);
    stampWatchVolumeOk(w);
    stampCheapArmEval(w, now);
    w.targetDipEntries = buildTargetDipEntries(w);
    stampDipPriority(w, now);
    const life = watchLifecycleAction(
      w,
      w.preferredProfileId || 'dip_buyer',
      now
    );
    if (life === 'demote' && w.status === 'armed') {
      w.status = 'watching';
      w.armedAt = null;
      w.lastReason = 'demoted_from_armed';
      try {
        const { noteDemotedFromArmed } =
          require('./watchPipeline') as typeof import('./watchPipeline');
        noteDemotedFromArmed();
      } catch {
        /* optional */
      }
    } else if (life === 'expire_stagnant' || life === 'expire_volume') {
      releaseQualitySoftArm(w.mint);
      w.status = 'expired';
      w.updatedAt = now;
      w.lastReason =
        life === 'expire_volume'
          ? 'expired_from_volume_collapse'
          : 'stagnant_decay_expired';
      try {
        const { noteStagnantExpired } =
          require('./watchPipeline') as typeof import('./watchPipeline');
        noteStagnantExpired(life === 'expire_volume' ? 'volume' : 'stagnant');
      } catch {
        /* optional */
      }
      continue;
    }

    const armLife = applyArmLifecycleTimeout(w, now);
    if (armLife && armLife !== 'promote_fast_arm') {
      releaseQualitySoftArm(w.mint);
      w.status = 'expired';
      w.updatedAt = now;
      w.lastReason = armLife;
      try {
        const { noteProfileWatchFunnel } =
          require('./profileWatchRegistry') as typeof import('./profileWatchRegistry');
        noteProfileWatchFunnel(w.preferredProfileId || 'dip_buyer', armLife);
      } catch {
        /* optional */
      }
      continue;
    }

    // Invalidate: flush past max dip — minors only.
    // Medium/Majors use dead-tape / name-exclude / MC-band rotate (flush % is
    // often a Dex/peak unit glitch and was mass-invalidating quality parks).
    if (
      !isQualityBandSource(w.source) &&
      w.dropFromPeakPct != null &&
      w.dropFromPeakPct > maxDrop
    ) {
      releaseQualitySoftArm(w.mint);
      w.status = 'invalidated';
      w.updatedAt = now;
      w.lastReason = `flush −${w.dropFromPeakPct.toFixed(0)}%`;
      console.log(`[dip-watch] INVALIDATED ${w.symbol} — ${w.lastReason}`);
      try {
        const { clearOneSetupProfileLock } =
          require('./expectancyLift') as typeof import('./expectancyLift');
        clearOneSetupProfileLock(w.mint, 'invalidated');
      } catch {
        /* optional */
      }
      continue;
    }

    // Zone break invalidation when support known
    if (
      w.supportPriceSol != null &&
      w.supportPriceSol > 0 &&
      px != null &&
      px > 0 &&
      px < w.supportPriceSol * 0.97
    ) {
      releaseQualitySoftArm(w.mint);
      w.status = 'invalidated';
      w.updatedAt = now;
      w.lastReason = 'support breach';
      console.log(`[dip-watch] INVALIDATED ${w.symbol} — support breach`);
      try {
        const { clearOneSetupProfileLock } =
          require('./expectancyLift') as typeof import('./expectancyLift');
        clearOneSetupProfileLock(w.mint, 'invalidated');
      } catch {
        /* optional */
      }
      continue;
    }

    const nearTa =
      w.nearKeyFib === true ||
      w.nearSupport === true ||
      (w.fightDipDna === true &&
        watchHasLevelEvidence(w) &&
        w.volOk === true);
    const dropOk =
      w.dropFromPeakPct != null &&
      w.dropFromPeakPct >= Math.min(ARM_NEAR_DROP_MIN, minDrop) &&
      w.dropFromPeakPct <= maxDrop;

    // Arm: quality parks via Steady/HWR playbook. Dump-reclaim in Dip band
    // stays Dip identity; medium compounder / A+ parks open as the routed profile.
    const aboveDipMax = isAboveDipBuyerMaxMc(w.marketCapUsd);
    const inDipBand = isInDipBuyerMcBand(w.marketCapUsd);
    const dumpReclaim =
      inDipBand &&
      (w.dropFromPeakPct ?? 0) >= 8 &&
      nearTa;
    stampDipWatchEligibility(w);
    if (
      w.status === 'watching' &&
      isQualityBandSource(w.source) &&
      (aboveDipMax || inDipBand) &&
      !dumpReclaim
    ) {
      maybeArmQualityPark(w, now, dropOk, { keepDipIdentity: false });
    }
    if (inDipBand && nearTa && (!isQualityBandSource(w.source) || dumpReclaim)) {
      w.preferredProfileId = 'dip_buyer';
      stampDipWatchEligibility(w);
      const ids = Array.isArray(w.eligibleProfileIds)
        ? w.eligibleProfileIds.slice()
        : [];
      if (!ids.includes('dip_buyer')) {
        w.eligibleProfileIds = ['dip_buyer', ...ids];
      }
    }
    if (w.status === 'watching' && nearTa) {
      if (!isQualityBandSource(w.source) || dumpReclaim) {
        w.preferredProfileId = 'dip_buyer';
      }
      const pid = w.preferredProfileId || 'dip_buyer';
      if (
        shouldSkipArmForCap(
          pid,
          countArmedWatchesForProfile(watches.values(), pid)
        ) ||
        (w.watchScore ?? 0) < WATCH_ARM_SCORE_FLOOR
      ) {
        try {
          const { noteSkippedLowScore } =
            require('./watchPipeline') as typeof import('./watchPipeline');
          noteSkippedLowScore();
        } catch {
          /* optional */
        }
        w.lastReason = 'skipped_low_score · arm cap';
      } else {
      w.status = 'armed';
      w.armedAt = now;
      w.updatedAt = now;
      w.watchScoreAtArm = w.watchScore;
      w.lastImprovementAt = now;
      resetArmClockOnArm(w);
      w.lastReason = dropOk ? 'armed near Fib/S + dip' : 'armed near Fib/S';
      stampWatchPlan(w);
      noteDipFunnel('armed');
      noteMinorsFunnel('armed');
      stampDipWatchEligibility(w);
      noteDipProfileArmed(w);
      console.log(`[dip-watch] ARMED ${w.symbol}`);
      try {
        const { recordSetupWatchEvent } =
          require('./setupWatchEvents') as typeof import('./setupWatchEvents');
        recordSetupWatchEvent({
          kind: 'armed',
          family: 'dip',
          mint: w.mint,
          symbol: w.symbol,
          profileId: w.preferredProfileId || 'dip_buyer',
          reason: w.lastReason,
          qualityScore: w.qualityScore,
          watchScore: w.watchScore,
          entryStyle: w.entryStyle,
        });
        const { noteArmedFromTopQuartile } =
          require('./watchPipeline') as typeof import('./watchPipeline');
        const n = ordered.length;
        noteArmedFromTopQuartile(
          w.watchRank != null && n > 0 && w.watchRank <= Math.max(1, Math.ceil(n * 0.25))
        );
      } catch {
        /* optional */
      }
      }
    }

    if (w.status === 'watching') stampCheapArmEval(w, now);

    if (w.status === 'armed') {
      // Stronger confirm: touch/undercut → reclaim; reject touch-and-fail
      let reclaim = false;
      let undercut = false;
      let nearLevel = false;
      let extensionFromLevelPct: number | null = null;
      let lateChase = false;
      try {
        const volHintRaw = Number(
          (w as { volumeM5Usd?: number }).volumeM5Usd ?? w.volumeH1Usd
        );
        const volumeHint = Number.isFinite(volHintRaw) && volHintRaw > 0;
        const det = detectSupportReclaim({
          priceSol: px,
          supportPriceSol: w.supportPriceSol,
          fib05PriceSol: w.fib05PriceSol,
          fib618PriceSol: w.fib618PriceSol,
          nearSupport: w.nearSupport,
          nearKeyFib: w.nearKeyFib,
          reclaimTriggerPct: TRIGGER_RECLAIM_PCT,
          volumeConfirm: volumeHint,
        });
        reclaim = det.reclaimed === true;
        undercut = det.undercut === true;
        nearLevel = det.nearLevel === true;
        extensionFromLevelPct = det.extensionFromLevelPct;
        lateChase = det.lateChase === true;
        if (det.nearLevel) {
          w.nearSupport = w.nearSupport || det.levelKind === 'support';
          w.nearKeyFib = w.nearKeyFib || det.levelKind === 'fib';
        }
        if (undercut || nearLevel) {
          (w as { touchedLevel?: boolean }).touchedLevel = true;
        }
        // Touch-and-fail: deeper 1.8% undercut; disabled when openRate < 0.20
        // Admission Baseline v235: skip touch-and-fail reject (keep reclaim %)
        let skipTouchFail = false;
        let undercutFailPct = 1.8;
        try {
          const { isAdmissionBaselineV235 } =
            require('./expectancyLift') as typeof import('./expectancyLift');
          skipTouchFail = isAdmissionBaselineV235();
        } catch {
          skipTouchFail = false;
        }
        try {
          const { touchFailUndercutPct } =
            require('./setupWatchEvents') as typeof import('./setupWatchEvents');
          undercutFailPct = touchFailUndercutPct();
        } catch {
          undercutFailPct = 1.8;
        }
        if (
          !skipTouchFail &&
          Number.isFinite(undercutFailPct) &&
          (w as { touchedLevel?: boolean }).touchedLevel &&
          !reclaim &&
          extensionFromLevelPct != null &&
          extensionFromLevelPct < -undercutFailPct
        ) {
          w.lastReason = 'touch-and-fail reject';
          try {
            const { recordSetupWatchEvent } =
              require('./setupWatchEvents') as typeof import('./setupWatchEvents');
            recordSetupWatchEvent({
              kind: 'touch_fail',
              family: 'dip',
              mint: w.mint,
              symbol: w.symbol,
              profileId: 'dip_buyer',
              reason: 'touch-and-fail reject',
            });
          } catch {
            /* optional */
          }
          continue;
        }
      } catch {
        /* fail soft — fall back to legacy level math */
        if (
          w.supportPriceSol != null &&
          w.supportPriceSol > 0 &&
          px != null &&
          px >= w.supportPriceSol * (1 + TRIGGER_RECLAIM_PCT / 100)
        ) {
          reclaim = true;
        }
      }
      // Prefer reclaim; legacy drop/KOL path only when still near level (not chase)
      const nearOk = undercut || nearLevel || nearTa;
      const trigger =
        reclaim ||
        (nearOk && dropOk && (nearTa || (w.kolCount ?? 0) >= (m.minKolWallets ?? 3)));

      if (!trigger) continue;

      stampWatchPlan(w);
      const dumpReclaimTrig =
        isInDipBuyerMcBand(w.marketCapUsd) &&
        (w.dropFromPeakPct ?? 0) >= 8 &&
        (w.nearKeyFib === true || w.nearSupport === true);
      const inDipBandTrig =
        dumpReclaimTrig || !isQualityBandSource(w.source);
      let preferPid = inDipBandTrig
        ? 'dip_buyer'
        : w.preferredProfileId || 'dip_buyer';
      if (preferPid === 'dip_buyer') {
        w.preferredProfileId = 'dip_buyer';
        stampDipWatchEligibility(w);
        const ids = Array.isArray(w.eligibleProfileIds)
          ? w.eligibleProfileIds.slice()
          : [];
        if (!ids.includes('dip_buyer')) {
          w.eligibleProfileIds = ['dip_buyer', ...ids];
        }
      }
      try {
        const { prepareArmedWatchOpen } =
          require('./profileWatchRegistry') as typeof import('./profileWatchRegistry');
        const gate = prepareArmedWatchOpen({
          profileId: preferPid,
          status: w.status,
          marketCapUsd: w.marketCapUsd,
          lateChase: lateChase,
          extensionFromLevelPct,
          nearLevel,
          entry: w,
        });
        preferPid = gate.profileId;
        if (!gate.ok) {
          w.lastReason = gate.reason || 'trigger blocked';
          if (gate.action === 'expire') {
            w.status = 'expired';
            w.updatedAt = now;
          }
          continue;
        }
      } catch {
        /* fail-open */
      }
      w.lastReason = reclaim ? 'reclaim trigger' : 'setup trigger';
      const c = buildHandoff(w);
      // Dump-reclaim / Dip minors stay dip_buyer; quality-park winners keep route.
      if (inDipBandTrig) {
        c.preferredProfileId = 'dip_buyer';
        if (c.launch) c.launch.preferredProfileId = 'dip_buyer';
        w.preferredProfileId = 'dip_buyer';
      }
      if (handOffScannerCandidate(c, { bypassCooldown: true })) {
        releaseQualitySoftArm(w.mint);
        w.status = 'triggered';
        w.updatedAt = now;
        handed += 1;
        noteDipFunnel('triggered');
        noteQualityBandFunnel(w.source, 'triggered');
        noteQualityBandFunnel(w.source, 'opened');
        if (!isQualityBandSource(w.source) || inDipBandTrig) {
          noteMinorsFunnel('triggered');
          noteMinorsFunnel('opened');
        } else {
          try {
            const { noteQualityParkFunnel, triggerTagForProfile } =
              require('./qualityParkPlaybook') as typeof import('./qualityParkPlaybook');
            const pid =
              w.preferredProfileId === 'high_win_rate'
                ? 'high_win_rate'
                : 'steady_compounder';
            noteQualityParkFunnel(pid, 'triggered');
            noteQualityParkFunnel(pid, 'opened');
            noteDipFunnel(
              pid === 'high_win_rate' ? 'hwr_triggered' : 'steady_triggered'
            );
            noteDipFunnel(
              pid === 'high_win_rate' ? 'hwr_opened' : 'steady_opened'
            );
            w.lastReason = `${triggerTagForProfile(pid)} · ${w.lastReason}`;
          } catch {
            /* optional */
          }
        }
        const prefer =
          inDipBandTrig || !isQualityBandSource(w.source)
            ? 'dip_buyer'
            : w.preferredProfileId === 'high_win_rate'
              ? 'high_win_rate'
              : w.preferredProfileId === 'dip_buyer'
                ? 'dip_buyer'
                : 'steady_compounder';
        console.log(
          `[dip-watch] TRIGGERED ${w.symbol} → ${prefer} (${w.lastReason})`
        );
        if (prefer === 'steady_compounder' && isQualityBandSource(w.source)) {
          console.log(
            `[STEADY-COMPOUNDER] trigger ${w.symbol} [${w.source}] → open`
          );
        } else if (prefer === 'high_win_rate' && isQualityBandSource(w.source)) {
          console.log(`[HWR] trigger ${w.symbol} [${w.source}] → open`);
        }
        try {
          const { clearOneSetupProfileLock } =
            require('./expectancyLift') as typeof import('./expectancyLift');
          clearOneSetupProfileLock(w.mint, 'triggered');
        } catch {
          /* optional */
        }
        try {
          const { recordSetupWatchEvent } =
            require('./setupWatchEvents') as typeof import('./setupWatchEvents');
          recordSetupWatchEvent({
            kind: 'triggered',
            family: 'dip',
            mint: w.mint,
            symbol: w.symbol,
            profileId: prefer,
            reason: w.lastReason,
            qualityScore: w.qualityScore,
            entryStyle: w.entryStyle,
          });
        } catch {
          /* optional */
        }
      } else {
        w.updatedAt = now;
        noteDipFunnel('handoff_failed');
        try {
          const { recordSetupWatchEvent } =
            require('./setupWatchEvents') as typeof import('./setupWatchEvents');
          recordSetupWatchEvent({
            kind: 'handoff_failed',
            family: 'dip',
            mint: w.mint,
            symbol: w.symbol,
            profileId: 'dip_buyer',
            reason: 'handOffScannerCandidate false',
          });
        } catch {
          /* optional */
        }
      }
    }
  }

  try {
    const { tickDipMinorLaneMonitor } =
      require('./dipMinorLaneHealth') as typeof import('./dipMinorLaneHealth');
    tickDipMinorLaneMonitor();
  } catch {
    /* optional */
  }

  return handed;
}

/** Cheap arm eval only — no TTL/stagnant expire, no clock reset. */
export function reevaluateDipWatchArmsCheap(): number {
  const now = Date.now();
  let n = 0;
  for (const w of watches.values()) {
    if (w.status !== 'watching' && w.status !== 'armed') continue;
    recomputeProximityFromLevels(w);
    stampCheapArmEval(w, now);
    n += 1;
  }
  return n;
}

/**
 * Manual unwatch — removes active watch and blocks bot re-add for 15 minutes.
 */
export function unwatchDipSetup(mint: string): {
  ok: boolean;
  error?: string;
  cooldownMs?: number;
} {
  const key = String(mint || '').trim();
  if (!key) return { ok: false, error: 'mint required' };
  const existing = watches.get(key);
  if (existing) {
    existing.status = 'invalidated';
    existing.updatedAt = Date.now();
    existing.lastReason = 'unwatched by user';
    deleteDipWatch(key);
  } else {
    lastMcRefreshAt.delete(key);
  }
  unwatchCooldownUntil.set(key, Date.now() + UNWATCH_COOLDOWN_MS);
  try {
    const { clearOneSetupProfileLock } =
      require('./expectancyLift') as typeof import('./expectancyLift');
    clearOneSetupProfileLock(key, 'unwatch');
  } catch {
    /* optional */
  }
  console.log(
    `[dip-watch] UNWATCH ${existing?.symbol || key.slice(0, 8)}… · cooldown 15m`
  );
  return { ok: true, cooldownMs: UNWATCH_COOLDOWN_MS };
}

/** Active counts only — no entry serialization (settings/status payloads). */
export function getDipSetupWatchCounts(): {
  active: number;
  activeMajors: number;
  activeMedium: number;
  activeMinors: number;
} {
  const allActive = allActiveWatches();
  return {
    active: allActive.length,
    activeMajors: allActive.filter((e) => watchBucket(e.source) === 'majors')
      .length,
    activeMedium: allActive.filter((e) => watchBucket(e.source) === 'medium')
      .length,
    activeMinors: allActive.filter((e) => watchBucket(e.source) === 'minors')
      .length,
  };
}

export function getDipSetupWatchStatus(limit = 200): {
  active: number;
  activeMajors: number;
  activeMedium: number;
  activeMinors: number;
  entries: DipWatchEntry[];
  recentTerminal: DipWatchEntry[];
} {
  pruneTerminal();
  const now = Date.now();
  const allActive = allActiveWatches().sort(
    (a, b) => b.updatedAt - a.updatedAt
  );
  const majorsActive = allActive.filter((e) => watchBucket(e.source) === 'majors');
  const mediumActive = allActive.filter((e) => watchBucket(e.source) === 'medium');
  const minorsActive = allActive.filter((e) => watchBucket(e.source) === 'minors');
  const entries = allActive.slice(0, limit);
  for (const e of entries) {
    e.targetDipEntries = buildTargetDipEntries(e);
  }
  const terminalPool = [...watches.values()]
    .filter((e) => {
      if (
        e.status !== 'triggered' &&
        e.status !== 'expired' &&
        e.status !== 'invalidated'
      ) {
        return false;
      }
      if (now - e.updatedAt <= TERMINAL_UI_MS) return true;
      return e.status === 'triggered' && mintHasOpenTrade(e.mint);
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const e of terminalPool) {
    e.targetDipEntries = buildTargetDipEntries(e);
  }
  return {
    active: allActive.length,
    activeMajors: majorsActive.length,
    activeMedium: mediumActive.length,
    activeMinors: minorsActive.length,
    entries,
    recentTerminal: terminalPool.slice(0, 8),
  };
}

/** True when mint is on an active (watching/armed) dip watch — mutual exclusion. */
export function isMintOnActiveDipWatch(mint: string): boolean {
  const w = watches.get(String(mint || '').trim());
  return w != null && (w.status === 'watching' || w.status === 'armed');
}

export function getDipWatchByMint(mint: string): DipWatchEntry | undefined {
  return watches.get(String(mint || '').trim());
}

/** Offer specialty / scanner candidates into the watchlist (non-blocking). */
export function offerDipWatchFromCandidate(c: {
  mint: string;
  symbol: string;
  name?: string;
  marketCapUsd?: number;
  volumeH1Usd?: number;
  holderCount?: number;
  priceChangeH1Pct?: number;
  priceChangeH6Pct?: number;
  priceChange24hPct?: number;
  dropFromPeakPct?: number | null;
  nearKeyFib?: boolean;
  nearSupport?: boolean;
  lastPriceSol?: number | null;
  supportPriceSol?: number | null;
  fib05PriceSol?: number | null;
  fib618PriceSol?: number | null;
  kolCount?: number;
  specialtyFeed?: string;
  preferredProfileId?: string;
  majorsBand?: string;
  pairCreatedAtMs?: number;
  tokenAgeHours?: number;
  isPumpFun?: boolean;
  scannerReasons?: string[] | string | null;
  scannerSources?: string[];
  source?: string;
}): boolean {
  try {
    const { noteWatchInsertAttempt, noteWatchInsertReject } =
      require('./watchPipeline') as typeof import('./watchPipeline');
    noteWatchInsertAttempt();
    if (!isRpcWorkloadEnabled('dip_setup_watch')) {
      lastDipAdmitReject = 'rpc_workload_off';
      noteWatchInsertReject('rpc_workload_off');
      console.warn(
        `[watch_insert_denied] reason=rpc_workload_off mint=${c.mint} symbol=${c.symbol}`
      );
      return false;
    }
  } catch {
    if (!isRpcWorkloadEnabled('dip_setup_watch')) return false;
  }
  if (
    c.preferredProfileId &&
    c.preferredProfileId !== 'dip_buyer' &&
    c.preferredProfileId !== 'steady_compounder' &&
    c.preferredProfileId !== 'high_win_rate' &&
    c.specialtyFeed !== 'kolscan' &&
    c.specialtyFeed !== 'jupiter' &&
    c.specialtyFeed !== 'majors' &&
    c.specialtyFeed !== 'medium'
  ) {
    // Still allow organic mature tokens from any specialty feed
  }
  const drop =
    c.dropFromPeakPct != null && Number.isFinite(Number(c.dropFromPeakPct))
      ? Number(c.dropFromPeakPct)
      : c.priceChangeH1Pct != null && c.priceChangeH1Pct < -1
        ? Math.abs(c.priceChangeH1Pct)
        : null;
  const { watchSourceFromCandidate } =
    require('./watchPipeline') as typeof import('./watchPipeline');
  const src = watchSourceFromCandidate({
    specialtyFeed: c.specialtyFeed,
    scannerSources: c.scannerSources,
    source: c.source,
  });
  const entry = considerDipWatchSetup({
    mint: c.mint,
    symbol: c.symbol,
    name: c.name,
    marketCapUsd: c.marketCapUsd,
    volumeH1Usd: c.volumeH1Usd,
    holderCount: c.holderCount,
    dropFromPeakPct: drop,
    nearKeyFib: c.nearKeyFib,
    nearSupport: c.nearSupport,
    lastPriceSol: c.lastPriceSol ?? null,
    supportPriceSol: c.supportPriceSol ?? null,
    fib05PriceSol: c.fib05PriceSol ?? null,
    fib618PriceSol: c.fib618PriceSol ?? null,
    kolCount: c.kolCount,
    source: src,
    majorsBand: c.majorsBand,
    preferredProfileId: c.preferredProfileId,
    pairCreatedAtMs: c.pairCreatedAtMs,
    tokenAgeHours: c.tokenAgeHours,
    isPumpFun: c.isPumpFun,
    priceChangeH1Pct: c.priceChangeH1Pct ?? null,
    scannerReasons: c.scannerReasons,
  });
  if (!entry) {
    const why = lastDipAdmitReject || 'admit_failed';
    try {
      const { noteWatchInsertReject } =
        require('./watchPipeline') as typeof import('./watchPipeline');
      noteWatchInsertReject(why);
    } catch {
      /* optional */
    }
    console.warn(
      `[watch_insert_denied] reason=${why} mint=${c.mint} symbol=${c.symbol} profile=${c.preferredProfileId || 'dip_buyer'}`
    );
    return false;
  }
  try {
    const { noteWatchInsertOk } =
      require('./watchPipeline') as typeof import('./watchPipeline');
    noteWatchInsertOk({
      mint: entry.mint,
      symbol: entry.symbol,
      profile: entry.preferredProfileId || 'dip_buyer',
    });
  } catch {
    /* optional */
  }
  console.log(
    `[watch_insert_ok] mint=${entry.mint} symbol=${entry.symbol} profile=${entry.preferredProfileId || 'dip_buyer'} status=${entry.status}`
  );
  if (entry && (src === 'medium' || src === 'majors')) {
    if (c.priceChangeH1Pct != null) entry.priceChangeH1Pct = c.priceChangeH1Pct;
    if (c.priceChangeH6Pct != null) entry.priceChangeH6Pct = c.priceChangeH6Pct;
    if (c.priceChange24hPct != null) {
      entry.priceChange24hPct = c.priceChange24hPct;
    }
    if (c.isPumpFun === true) entry.isPumpFun = true;
  }
  return true;
}
