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
import { isStrategyEnabledGlobal } from './strategies';
import {
  isSmartBotProfilesEnabled,
  resolveTradeProfileDefinition,
} from './tradeProfiles';
import { detectSupportReclaim } from './supportReclaim';
import { analyzeSrConfluenceFromCandles } from './technicalLevels';

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
  /** Soft prefer on handoff — dip_buyer default; medium/majors prefer steady_compounder / high_win_rate */
  preferredProfileId?: string;
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
}

/**
 * Separate caps so majors/medium (liberal admit + 10h TTL + frequent refresh)
 * cannot starve memecoin / scanner minors. Medium/Majors ≤80 (1.2.261).
 */
const MAX_MAJORS_WATCHES = 80;
const MAX_MEDIUM_WATCHES = 80;
const MAX_MINORS_WATCHES = 16;
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
const TERMINAL_UI_MS = 60_000;

const watches = new Map<string, DipWatchEntry>();
let lastMcRefreshAt = new Map<string, number>();
/** mint → earliest time bots may re-add after manual unwatch */
const unwatchCooldownUntil = new Map<string, number>();
/** mint → last H1-vol rotation eviction/admit (debounce) */
const lastRotationAt = new Map<string, number>();

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

function noteDipFunnel(key: keyof typeof dipFunnel, n = 1): void {
  dipFunnel[key] = (dipFunnel[key] || 0) + n;
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
    minorsCap: MAX_MINORS_WATCHES,
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
  return MAX_MINORS_WATCHES;
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

function bucketCap(bucket: DipWatchBucket): number {
  if (bucket === 'majors') return MAX_MAJORS_WATCHES;
  if (bucket === 'medium') return MAX_MEDIUM_WATCHES;
  return MAX_MINORS_WATCHES;
}

function isActiveWatch(w: DipWatchEntry): boolean {
  return w.status === 'watching' || w.status === 'armed';
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
}

function activeWatches(bucket: DipWatchBucket): DipWatchEntry[] {
  return [...watches.values()]
    .filter((w) => {
      if (!isActiveWatch(w)) return false;
      return watchBucket(w.source) === bucket;
    })
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Evict oldest within a bucket until at/under cap. */
function enforceBucketCap(bucket: DipWatchBucket, max: number): void {
  const active = activeWatches(bucket);
  while (active.length > max) {
    const oldest = active.shift();
    if (!oldest) break;
    deleteDipWatch(oldest.mint);
  }
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
  // Primary: armed/near → H1 vol + movement; soft age + MC proxy; dead tape last
  return armedBoost + nearBoost + vol + ageDays * 50 + liqProxy * 20 + movBoost;
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
        MEDIUM_MIN_MC_USD,
        universeWatchBand,
        majorsMcBand,
      } = require('./majorsUniverse') as typeof import('./majorsUniverse');
      if (mc < MEDIUM_MIN_MC_USD) {
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
          `[dip-watch] ROTATE ${w.symbol} [${w.source}] — MC below medium floor ` +
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
 * True if a new admit for this bucket is allowed. Minors: drop oldest.
 * Medium/Majors: rotate lowest H1-vol score when incoming beats by ≥1.25×.
 */
function reserveAdmitSlot(
  bucket: DipWatchBucket,
  incoming?: { mint?: string; volumeH1Usd?: number }
): boolean {
  const max = bucketCap(bucket);
  const active = activeWatches(bucket);
  if (active.length < max) return true;

  if (bucket === 'minors') {
    const oldest = active[0];
    if (!oldest) return true;
    deleteDipWatch(oldest.mint);
    return true;
  }

  const now = Date.now();
  const ranked = [...active]
    .map((w) => ({ w, score: qualityWatchScore(w) }))
    .sort((a, b) => a.score - b.score);
  const weakest = ranked[0];
  if (!weakest) return true;

  const inVol = Math.max(0, Number(incoming?.volumeH1Usd) || 0);
  const weakVol = Math.max(1, Number(weakest.w.volumeH1Usd) || 0);
  if (!(inVol >= weakVol * ROTATION_VOL_EDGE)) {
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
    `[ROTATION] ${bucket} out=${weakest.w.symbol}(${outMint.slice(0, 6)}…) ` +
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
  const preferHwr = w.preferredProfileId === 'high_win_rate';
  const preferSteady =
    preferHwr ||
    w.preferredProfileId === 'steady_compounder' ||
    isQualityBandSource(w.source);
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

/** MC at a price level assuming constant supply: MC_now * (P_level / P_now). */
function mcAtPrice(
  marketCapUsd: number | undefined,
  lastPriceSol: number | null | undefined,
  levelPriceSol: number | null | undefined
): number | null {
  if (
    marketCapUsd == null ||
    !Number.isFinite(marketCapUsd) ||
    marketCapUsd <= 0
  ) {
    return null;
  }
  if (
    lastPriceSol == null ||
    !Number.isFinite(lastPriceSol) ||
    lastPriceSol <= 0
  ) {
    return null;
  }
  if (
    levelPriceSol == null ||
    !Number.isFinite(levelPriceSol) ||
    levelPriceSol <= 0
  ) {
    return null;
  }
  return marketCapUsd * (levelPriceSol / lastPriceSol);
}

function buildTargetDipEntries(w: {
  marketCapUsd?: number;
  lastPriceSol?: number | null;
  supportPriceSol?: number | null;
  fib05PriceSol?: number | null;
  fib618PriceSol?: number | null;
}): DipTargetEntry[] {
  const out: DipTargetEntry[] = [];
  const push = (label: string, priceSol: number | null | undefined) => {
    const mc = mcAtPrice(w.marketCapUsd, w.lastPriceSol, priceSol);
    if (mc == null || priceSol == null) return;
    // Dedupe near-identical prices
    if (
      out.some(
        (e) => Math.abs(e.priceSol - priceSol) / Math.max(e.priceSol, 1e-18) < 0.005
      )
    ) {
      return;
    }
    out.push({ label, priceSol, mcUsd: mc });
  };
  push('Fib 0.5', w.fib05PriceSol);
  push('Fib 0.618', w.fib618PriceSol);
  push('Support', w.supportPriceSol);
  return out;
}

function isDipProfileEnabled(): boolean {
  if (!isSmartBotProfilesEnabled()) return false;
  if (!isStrategyEnabledGlobal('ta_market_scanner')) return false;
  const { config } = require('./config') as typeof import('./config');
  if (config.tradeProfiles?.enabled === false) return false;
  // Minors need Dip; medium/majors may run on Steady or HWR alone
  if (
    config.tradeProfiles?.profiles?.dip_buyer === false &&
    config.tradeProfiles?.profiles?.steady_compounder === false &&
    config.tradeProfiles?.profiles?.high_win_rate === false
  ) {
    return false;
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
        deleteDipWatch(mint);
      }
    }
  }
  // Cap per bucket — never let majors/medium eviction steal minor slots
  enforceBucketCap('majors', MAX_MAJORS_WATCHES);
  enforceBucketCap('medium', MAX_MEDIUM_WATCHES);
  enforceBucketCap('minors', MAX_MINORS_WATCHES);
}

function watchHasFibOrSupportLevels(w: DipWatchEntry): boolean {
  return (
    (w.fib05PriceSol != null && w.fib05PriceSol > 0) ||
    (w.fib618PriceSol != null && w.fib618PriceSol > 0) ||
    (w.supportPriceSol != null && w.supportPriceSol > 0) ||
    w.nearKeyFib === true ||
    w.nearSupport === true
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
  const bands = qualityNearBands(w);
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
      // When level kind ambiguous, mark both if either field was the pick
      if (det.levelKind === 'fib' || det.levelKind === 'support') {
        /* already set */
      }
    }
    // Also distance-check each stored level independently (targets may differ)
    const nearPx = (level: number | null | undefined): boolean => {
      if (level == null || !Number.isFinite(level) || level <= 0) return false;
      const d = (px - level) / level;
      return d >= -bands.undercut && d <= bands.nearBand;
    };
    if (nearPx(w.fib05PriceSol) || nearPx(w.fib618PriceSol)) {
      w.nearKeyFib = true;
    }
    if (nearPx(w.supportPriceSol)) {
      w.nearSupport = true;
    }
  } catch {
    /* keep prior flags */
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
  dropOk: boolean
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
    } = require('./qualityParkPlaybook') as typeof import('./qualityParkPlaybook');
    const verdict = evaluateQualityParkArm(buildQualityParkEvalInput(w));
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
    if (verdict.softMovement === true) {
      if (!registerSoftMovementArm(w.mint)) {
        noteDipFunnel('quality_low_movement');
        w.lastReason = 'soft_movement_cap';
        return false;
      }
      w.softMovement = true;
    } else {
      w.softMovement = false;
    }
    w.preferredProfileId = verdict.profileId;
    w.armTag = verdict.armTag || undefined;
    w.status = 'armed';
    w.armedAt = now;
    w.updatedAt = now;
    const nearTa = w.nearKeyFib === true || w.nearSupport === true;
    w.lastReason = nearTa
      ? dropOk
        ? `${verdict.armTag} · near + dip`
        : `${verdict.armTag} · near`
      : `${verdict.armTag} · waiting reclaim`;
    stampWatchPlan(w);
    noteDipFunnel('armed');
    noteQualityBandFunnel(w.source, 'armed');
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
      const nearTa = w.nearKeyFib === true || w.nearSupport === true;
      if (w.status === 'watching' && nearTa) {
        const now = Date.now();
        w.status = 'armed';
        w.armedAt = now;
        w.updatedAt = now;
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
    if (prevPeak == null || !Number.isFinite(prevPeak) || px > prevPeak) {
      w.peakPriceSol = px;
    }
    const peak = w.peakPriceSol;
    if (peak != null && peak > 0 && px < peak) {
      const fromPeak = ((peak - px) / peak) * 100;
      if (Number.isFinite(fromPeak) && fromPeak > 0) {
        w.dropFromPeakPct = fromPeak;
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
    if (w.dropFromPeakPct == null || fromH1 > w.dropFromPeakPct) {
      w.dropFromPeakPct = fromH1;
    }
  }
}

async function refreshWatchMarket(
  w: DipWatchEntry,
  now: number,
  opts?: { force?: boolean }
): Promise<void> {
  const last = lastMcRefreshAt.get(w.mint) ?? 0;
  if (!opts?.force && now - last < MC_REFRESH_MIN_MS) return;
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

  // Multi-TF S/R confluence (Mode B parity) — fail soft
  try {
    const multi = await fetchMultiTfOhlcv(w.mint, { solUsd: undefined });
    if (Object.keys(multi.byTf).length > 0) {
      const conf = analyzeSrConfluenceFromCandles(w.mint, multi.byTf, {
        priceSol: w.lastPriceSol,
      });
      if (conf.primarySupport != null && conf.primarySupport > 0) {
        w.supportPriceSol = conf.primarySupport;
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

  // Technical Fib / support refresh when candles available — fail soft
  try {
    const { getTechnicalLevelsForStrategy } =
      require('./technicalLevels') as typeof import('./technicalLevels');
    const tech = getTechnicalLevelsForStrategy({
      mint: w.mint,
      priceSol: w.lastPriceSol ?? undefined,
    });
    if (tech) {
      if (tech.nearFibZone) w.nearKeyFib = true;
      if (tech.nearSupportZone) w.nearSupport = true;
      const supPx = tech.nearestSupport?.mid;
      if (
        (w.supportPriceSol == null || w.supportPriceSol <= 0) &&
        supPx != null &&
        Number.isFinite(supPx) &&
        supPx > 0
      ) {
        w.supportPriceSol = Number(supPx);
      }
      for (const z of tech.fibZones || []) {
        const ratio = Number(z.ratio);
        const px = Number(z.price);
        if (!Number.isFinite(px) || px <= 0) continue;
        if (Math.abs(ratio - 0.5) < 0.001) w.fib05PriceSol = px;
        if (Math.abs(ratio - 0.618) < 0.02) w.fib618PriceSol = px;
      }
      for (const z of tech.snapshot?.fib?.levels || []) {
        const ratio = Number(z.ratio);
        const px = Number(z.price);
        if (!Number.isFinite(px) || px <= 0) continue;
        if (
          (w.fib05PriceSol == null || w.fib05PriceSol <= 0) &&
          Math.abs(ratio - 0.5) < 0.001
        ) {
          w.fib05PriceSol = px;
        }
        if (
          (w.fib618PriceSol == null || w.fib618PriceSol <= 0) &&
          Math.abs(ratio - 0.618) < 0.02
        ) {
          w.fib618PriceSol = px;
        }
      }
    }
  } catch {
    /* optional TA */
  }

  refreshDropFromPeak(w, h1Change);
  recomputeProximityFromLevels(w);

  const hasLevels = watchHasFibOrSupportLevels(w);
  if (!hasLevels) noteDipFunnel('no_levels');

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
        const { rotate } = noteDeadTapeObservation(w.mint, true, now);
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
      }
    } catch {
      /* optional */
    }
    try {
      const {
        noteMajorsLevelsPresence,
        clearMajorsNoLevelsStreak,
      } = require('./majorsUniverse') as typeof import('./majorsUniverse');
      if (hasLevels) {
        clearMajorsNoLevelsStreak(w.mint);
      } else if (
        w.preferredProfileId === 'steady_compounder' ||
        w.preferredProfileId === 'high_win_rate'
      ) {
        clearMajorsNoLevelsStreak(w.mint);
      } else {
        const { rotate, streak } = noteMajorsLevelsPresence(
          w.mint,
          false,
          w.marketCapUsd
        );
        if (rotate) {
          noteDipFunnel('no_levels_rotate');
          noteQualityBandFunnel(w.source, 'expired');
          releaseQualitySoftArm(w.mint);
          w.status = 'expired';
          w.updatedAt = now;
          w.lastReason = `no levels ×${streak} (~20m) — rotate`;
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
}): DipWatchEntry | null {
  if (!isDipProfileEnabled()) return null;
  if (!input.mint) return null;
  if (isManualUnwatchCooldown(input.mint)) {
    noteDipFunnel('unwatch_cd');
    return null;
  }
  const m = dipMatch();
  const minMc = m.minMarketCapUsd ?? 500_000;
  const minHolders = m.minHolders ?? 80;
  const minVol = m.minVolumeH1Usd ?? 8_000;
  const minDrop = m.minDropFromPeakPct ?? 8;
  const maxDrop = m.maxDropFromPeakPct ?? 45;
  const isMajors = isMajorsSource(input.source);
  const isMedium = isMediumSource(input.source);
  const isQuality = isMajors || isMedium;
  const bucket = watchBucket(input.source);
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

  // Scalper / Mode B: always mutual-exclude (protect mid-band spam).
  try {
    const { isMintOnActiveScalperWatch } =
      require('./scalperSetupWatch') as typeof import('./scalperSetupWatch');
    if (isMintOnActiveScalperWatch(input.mint)) {
      noteDipFunnel('mutual_exclude');
      noteDipFunnel('mx_scalper');
      return null;
    }
  } catch {
    /* optional */
  }
  // Trend: quality parks prefer Dip/Steady; minors yield on drop OR near Fib/S.
  try {
    const {
      isMintOnActiveTrendWatch,
      expireTrendWatchForDipAdmit,
    } = require('./trendSetupWatch') as typeof import('./trendSetupWatch');
    if (isMintOnActiveTrendWatch(input.mint)) {
      if (isQuality) {
        expireTrendWatchForDipAdmit(
          input.mint,
          'Yielded to Dip/Steady quality park'
        );
      } else if (nearTaEarly || dropStartedEarly) {
        expireTrendWatchForDipAdmit(
          input.mint,
          nearTaEarly
            ? 'Yielded to Dip minor near Fib/S'
            : 'Yielded to Dip minor dip DNA'
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
      if (input.preferredProfileId) {
        existing.preferredProfileId = input.preferredProfileId;
      }
      // Keep quality TTL from sliding under 4h memecoin default on refresh
      const remain = existing.expiresAt - Date.now();
      if (remain < MAJORS_TTL_MS / 2) {
        existing.expiresAt = Date.now() + MAJORS_TTL_MS;
      }
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
    return existing;
  }

  const mc = input.marketCapUsd;
  if (mc != null && mc > 0 && mc < minMc && !isQuality) {
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
  // Medium/Majors: admit to watching without force-buy when S/R thin (arm later).
  // Memecoins: need early dip signal OR Fib/S proximity.
  if (!isQuality && !dropStarted && !nearTa) {
    noteDipFunnel('no_setup');
    noteDipFunnel('vol_liq_mc');
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
  // Soft-gate: Medium/Majors → Steady/HWR/Dip; minors always dip_buyer (1.2.262/263).
  let preferSafe: 'steady_compounder' | 'high_win_rate' | 'dip_buyer';
  if (!isQuality) {
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
      preferSafe = prefer;
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
    lastReason: armed
      ? dropStarted
        ? 'near Fib/S + dip'
        : 'near Fib/S'
      : isMajors
        ? 'majors watch'
        : isMedium
          ? 'medium watch'
          : 'watching for setup',
  };
  entry.targetDipEntries = buildTargetDipEntries(entry);
  if (armed) stampWatchPlan(entry);
  watches.set(input.mint, entry);
  noteDipFunnel('offered');
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
    ],
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
  if (!isDipProfileEnabled()) return 0;
  pruneTerminal();
  const m = dipMatch();
  const minDrop = m.minDropFromPeakPct ?? 8;
  const maxDrop = m.maxDropFromPeakPct ?? 45;
  const now = Date.now();
  let handed = 0;

  for (const w of watches.values()) {
    if (w.status !== 'watching' && w.status !== 'armed') continue;

    if (now >= w.expiresAt) {
      releaseQualitySoftArm(w.mint);
      w.status = 'expired';
      w.updatedAt = now;
      w.lastReason = 'TTL expired';
      noteQualityBandFunnel(w.source, 'expired');
      if (!isQualityBandSource(w.source)) noteMinorsFunnel('expired');
      console.log(`[dip-watch] EXPIRED ${w.symbol}`);
      try {
        const {
          recordSetupWatchEvent,
          noteSetupWatchExpiredUnused,
        } = require('./setupWatchEvents') as typeof import('./setupWatchEvents');
        noteSetupWatchExpiredUnused(w.mint);
        recordSetupWatchEvent({
          kind: 'watch_expired',
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
    w.targetDipEntries = buildTargetDipEntries(w);

    // Invalidate: flush past max dip
    if (w.dropFromPeakPct != null && w.dropFromPeakPct > maxDrop) {
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

    const nearTa = w.nearKeyFib === true || w.nearSupport === true;
    const dropOk =
      w.dropFromPeakPct != null &&
      w.dropFromPeakPct >= Math.min(ARM_NEAR_DROP_MIN, minDrop) &&
      w.dropFromPeakPct <= maxDrop;

    // Arm: quality parks via Steady/HWR playbook; minors near Fib/S.
    if (w.status === 'watching' && isQualityBandSource(w.source)) {
      maybeArmQualityPark(w, now, dropOk);
    } else if (w.status === 'watching' && nearTa) {
      w.status = 'armed';
      w.armedAt = now;
      w.updatedAt = now;
      w.lastReason = dropOk ? 'armed near Fib/S + dip' : 'armed near Fib/S';
      stampWatchPlan(w);
      noteDipFunnel('armed');
      noteMinorsFunnel('armed');
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
          entryStyle: w.entryStyle,
        });
      } catch {
        /* optional */
      }
    }

    if (w.status === 'armed') {
      // Stronger confirm: touch/undercut → reclaim; reject touch-and-fail
      let reclaim = false;
      let undercut = false;
      let nearLevel = false;
      let extensionFromLevelPct: number | null = null;
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
      w.lastReason = reclaim ? 'reclaim trigger' : 'setup trigger';
      const c = buildHandoff(w);
      // Force Dip floors on minor handoffs (never Steady soft-allow path).
      if (!isQualityBandSource(w.source)) {
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
        if (!isQualityBandSource(w.source)) {
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
          isQualityBandSource(w.source)
            ? w.preferredProfileId === 'high_win_rate'
              ? 'high_win_rate'
              : w.preferredProfileId === 'dip_buyer'
                ? 'dip_buyer'
                : 'steady_compounder'
            : 'dip_buyer';
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
  const majorsActive = activeWatches('majors').sort(
    (a, b) => b.updatedAt - a.updatedAt
  );
  const mediumActive = activeWatches('medium').sort(
    (a, b) => b.updatedAt - a.updatedAt
  );
  const minorsActive = activeWatches('minors').sort(
    (a, b) => b.updatedAt - a.updatedAt
  );
  // Reserve room for minors so quality parks cannot starve the status slice.
  const minorReserve = Math.min(MAX_MINORS_WATCHES, minorsActive.length, limit);
  const qualityBudget = Math.max(0, limit - minorReserve);
  const entries: DipWatchEntry[] = [];
  for (const e of mediumActive) {
    if (entries.length >= qualityBudget) break;
    entries.push(e);
  }
  for (const e of majorsActive) {
    if (entries.length >= qualityBudget) break;
    entries.push(e);
  }
  for (const e of minorsActive) {
    if (entries.length >= limit) break;
    entries.push(e);
  }
  for (const e of entries) {
    e.targetDipEntries = buildTargetDipEntries(e);
  }
  const terminalPool = [...watches.values()]
    .filter(
      (e) =>
        (e.status === 'triggered' ||
          e.status === 'expired' ||
          e.status === 'invalidated') &&
        now - e.updatedAt <= TERMINAL_UI_MS
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const e of terminalPool) {
    e.targetDipEntries = buildTargetDipEntries(e);
  }
  return {
    active:
      majorsActive.length + mediumActive.length + minorsActive.length,
    activeMajors: majorsActive.length,
    activeMedium: mediumActive.length,
    activeMinors: minorsActive.length,
    entries,
    recentTerminal: terminalPool.slice(0, 4),
  };
}

/** True when mint is on an active (watching/armed) dip watch — mutual exclusion. */
export function isMintOnActiveDipWatch(mint: string): boolean {
  const w = watches.get(String(mint || '').trim());
  return w != null && (w.status === 'watching' || w.status === 'armed');
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
}): void {
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
    c.priceChangeH1Pct != null && c.priceChangeH1Pct < -1
      ? Math.abs(c.priceChangeH1Pct)
      : null;
  const src =
    c.specialtyFeed === 'majors'
      ? 'majors'
      : c.specialtyFeed === 'medium'
        ? 'medium'
        : c.specialtyFeed || 'scanner';
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
  });
  if (entry && (src === 'medium' || src === 'majors')) {
    if (c.priceChangeH1Pct != null) entry.priceChangeH1Pct = c.priceChangeH1Pct;
    if (c.priceChangeH6Pct != null) entry.priceChangeH6Pct = c.priceChangeH6Pct;
    if (c.priceChange24hPct != null) {
      entry.priceChange24hPct = c.priceChange24hPct;
    }
  }
}
