/**
 * Migration Sniper graduation watchlist: watch (~80%) → arm → trigger (≥~90% fire
 * band until complete) → post-grad handoff on curve complete. Hands setups to the
 * Market Scanner with preferredProfileId: migration_sniper. Fast-polls bonding
 * curve on active watches.
 *
 * Event lane (not TA): enter in the pre-mig sweet spot when armed/quality, hold
 * through migration, exit on first spike + volume (see migration_event scalp).
 *
 * Historical choke points (pre-retune): profile Paused (perf), fire ≥95%, and
 * raised conviction/wallet floors from perfAlloc_v191.
 *
 * Low-MC grace: once watching, keep through volatile 25k↔10k swings; only
 * invalidate for MC after continuous < $8k for 5 minutes (curve rules still apply).
 */

import { fetchBondingCurve, summarizeBondingCurve, estimateBondingCurveMarketCapUsd } from './bondingCurve';
import type { LaunchEvent } from './marketData';
import { fetchLiveTokenSnapshot, getCachedSolUsdPrice } from './marketData';
import { markAsMigrated, getMigrationEvent } from './migrationListener';
import {
  handOffScannerCandidate,
  type ScannerCandidate,
} from './marketScanner';
import {
  isSmartBotProfilesEnabled,
  resolveTradeProfileDefinition,
  getMigrationSniperMaxMcUsd,
} from './tradeProfiles';
import { trimMapToCap, registerCacheSweep } from './mapCap';
import {
  stampWatchPriority,
  sortActiveWatchesByScore,
  shouldSkipArmForCap,
  countArmedWatches,
  demoteArmedBeyondCap,
  watchLifecycleAction,
  WATCH_ARM_SCORE_FLOOR,
} from './watchPriorityScore';

export type GradWatchStatus =
  | 'watching'
  | 'armed'
  | 'triggered'
  | 'expired'
  | 'invalidated';

export interface GradWatchEntry {
  mint: string;
  symbol: string;
  name: string;
  status: GradWatchStatus;
  createdAt: number;
  updatedAt: number;
  armedAt: number | null;
  expiresAt: number;
  curveProgressPct: number | null;
  marketCapUsd?: number;
  volumeH1Usd?: number;
  holderCount?: number;
  holderGrowthPct?: number | null;
  buyPressureUsd?: number | null;
  lastReason?: string;
  preferredProfileId?: string;
  eligibleProfileIds?: string[];
  confluenceCount?: number | null;
  playbookPassed?: string[];
  triggerBlockReason?: string;
  source?: string;
  /** Wall-clock when known MC first went below LOW_MC_USD (cleared when recovered) */
  belowLowMcSinceMs?: number | null;
  /** First time we observed curve complete (post-grad retry window) */
  completeSeenAtMs?: number | null;
  /** Touched fire band — used for touch→hold/reclaim confirm */
  touchedFireBand?: boolean;
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
}

const MAX_WATCHES = 32;
const DEFAULT_TTL_MS = 60 * 60_000; // 60 min
const FAST_POLL_MS = 1_500;
const REGRESS_INVALIDATE_PCT = 8; // hard dump from peak watched progress
/** Curve % points below fireMin after touch = touch-and-fail (Mode B parity) */
const FIRE_TOUCH_FAIL_PCT = 2.0;
/** Manual unwatch — bots may re-add only after this cooldown */
const UNWATCH_COOLDOWN_MS = 15 * 60_000;
/** Soft MC death — only after continuous time under this floor */
const LOW_MC_USD = 8_000;
const LOW_MC_GRACE_MS = 5 * 60_000;
const MC_REFRESH_MIN_MS = 15_000;
/** Terminal rows kept for UI breadcrumb (5 min) */
const TERMINAL_UI_MS = 5 * 60_000;

const watches = new Map<string, GradWatchEntry>();
let peakProgress = new Map<string, number>();
let lastMcRefreshAt = new Map<string, number>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** mint → earliest time bots may re-add after manual unwatch */
const unwatchCooldownUntil = new Map<string, number>();
const GRAD_SIDECAR_CAP = 500;

function capGradWatchSidecars(): Record<string, number> {
  trimMapToCap(unwatchCooldownUntil, GRAD_SIDECAR_CAP);
  trimMapToCap(lastMcRefreshAt, GRAD_SIDECAR_CAP);
  trimMapToCap(peakProgress, GRAD_SIDECAR_CAP);
  return { gradUnwatchCooldown: unwatchCooldownUntil.size };
}
registerCacheSweep(capGradWatchSidecars);

function stampGradWatchEligibility(
  w: GradWatchEntry,
  isNew = false
): void {
  try {
    const { stampEligibleOnWatchEntry, noteProfileWatchFunnel } =
      require('./profileWatchRegistry') as typeof import('./profileWatchRegistry');
    w.preferredProfileId = w.preferredProfileId || 'migration_sniper';
    const ids = stampEligibleOnWatchEntry('grad', w);
    if (isNew) {
      for (const id of ids) {
        noteProfileWatchFunnel(id, 'sent_to_watch', undefined, w.source);
      }
      if (w.status === 'armed') {
        for (const id of ids) {
          noteProfileWatchFunnel(id, 'armed', undefined, w.source);
        }
      }
    }
  } catch {
    w.eligibleProfileIds = ['migration_sniper'];
    w.preferredProfileId = w.preferredProfileId || 'migration_sniper';
  }
}

/** Live MS funnel tallies (process lifetime) — watch → arm → trigger → blockers */
export interface MigrationSniperFunnel {
  watchAdmit: number;
  armed: number;
  triggered: number;
  fireMissNotArmed: number;
  handoffFail: number;
  expired: number;
  invalidated: number;
  postGradTriggered: number;
}

const funnel: MigrationSniperFunnel = {
  watchAdmit: 0,
  armed: 0,
  triggered: 0,
  fireMissNotArmed: 0,
  handoffFail: 0,
  expired: 0,
  invalidated: 0,
  postGradTriggered: 0,
};

export function getMigrationSniperFunnel(): MigrationSniperFunnel & {
  activeWatching: number;
  activeArmed: number;
} {
  let activeWatching = 0;
  let activeArmed = 0;
  for (const w of watches.values()) {
    if (w.status === 'watching') activeWatching += 1;
    if (w.status === 'armed') activeArmed += 1;
  }
  return { ...funnel, activeWatching, activeArmed };
}

function isManualUnwatchCooldown(mint: string): boolean {
  const until = unwatchCooldownUntil.get(mint) ?? 0;
  if (until <= Date.now()) {
    if (until > 0) unwatchCooldownUntil.delete(mint);
    return false;
  }
  return true;
}

function migMatch() {
  return resolveTradeProfileDefinition('migration_sniper').match;
}

function isMigProfileEnabled(): boolean {
  if (!isSmartBotProfilesEnabled()) return false;
  const { config } = require('./config') as typeof import('./config');
  if (config.tradeProfiles?.enabled === false) return false;
  if (config.tradeProfiles?.profiles?.migration_sniper === false) return false;
  try {
    const { isProfileWatchEnabled } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    if (!isProfileWatchEnabled('migration_sniper')) return false;
  } catch {
    /* optional */
  }
  return true;
}

function watchPct(): number {
  const m = migMatch();
  return m.gradWatchPct != null && Number.isFinite(m.gradWatchPct)
    ? Number(m.gradWatchPct)
    : 80;
}

function fireMin(): number {
  const m = migMatch();
  return m.minCurveProgressPct != null && Number.isFinite(m.minCurveProgressPct)
    ? Number(m.minCurveProgressPct)
    : 88;
}

function fireMax(): number {
  const m = migMatch();
  return m.maxCurveProgressPct != null && Number.isFinite(m.maxCurveProgressPct)
    ? Number(m.maxCurveProgressPct)
    : 99;
}

function maxPostGradSec(): number {
  const m = migMatch();
  return m.maxMigrationAgeSec != null && Number.isFinite(m.maxMigrationAgeSec)
    ? Number(m.maxMigrationAgeSec)
    : 120;
}

function ttlMs(): number {
  return DEFAULT_TTL_MS;
}

function applyMcGrace(w: GradWatchEntry, now: number): boolean {
  const mc = w.marketCapUsd;
  if (mc == null || !Number.isFinite(mc) || mc <= 0) {
    // Unknown MC — do not start / advance low-MC clock
    return false;
  }
  if (mc >= LOW_MC_USD) {
    w.belowLowMcSinceMs = null;
    return false;
  }
  if (w.belowLowMcSinceMs == null || w.belowLowMcSinceMs <= 0) {
    w.belowLowMcSinceMs = now;
    w.lastReason = `MC $${Math.round(mc)} < $${LOW_MC_USD} — grace ${LOW_MC_GRACE_MS / 60_000}m`;
    return false;
  }
  if (now - w.belowLowMcSinceMs >= LOW_MC_GRACE_MS) {
    w.status = 'invalidated';
    w.updatedAt = now;
    w.lastReason = `MC < $${LOW_MC_USD} for ${LOW_MC_GRACE_MS / 60_000}m`;
    funnel.invalidated += 1;
    console.log(`[grad-watch] INVALIDATED ${w.symbol} — ${w.lastReason}`);
    return true;
  }
  return false;
}

async function refreshWatchMarket(w: GradWatchEntry, now: number): Promise<void> {
  const last = lastMcRefreshAt.get(w.mint) ?? 0;
  if (now - last < MC_REFRESH_MIN_MS) return;
  lastMcRefreshAt.set(w.mint, now);
  try {
    const snap = await fetchLiveTokenSnapshot(w.mint);
    if (snap?.marketCapUsd != null && snap.marketCapUsd > 0) {
      w.marketCapUsd = snap.marketCapUsd;
    }
    if (snap?.volumeH1Usd != null && snap.volumeH1Usd > 0) {
      w.volumeH1Usd = snap.volumeH1Usd;
    }
  } catch {
    /* keep last */
  }
  if (!(w.marketCapUsd != null && w.marketCapUsd > 0)) {
    try {
      const curve = await fetchBondingCurve(w.mint);
      if (curve.source !== 'none' && !curve.complete) {
        const mc = estimateBondingCurveMarketCapUsd(
          curve,
          getCachedSolUsdPrice()
        );
        if (mc != null && mc > 0) w.marketCapUsd = mc;
      }
    } catch {
      /* soft */
    }
  }
  if (!(w.marketCapUsd != null && w.marketCapUsd > 0)) {
    try {
      const { resolveSourceEntryMcUsd } =
        require('./trade') as typeof import('./trade');
      const mc = await resolveSourceEntryMcUsd(w.mint);
      if (mc != null && mc > 0) w.marketCapUsd = mc;
    } catch {
      /* soft */
    }
  }
}

function pruneTerminal(): void {
  const now = Date.now();
  for (const [mint, w] of watches) {
    if (
      w.status === 'triggered' ||
      w.status === 'expired' ||
      w.status === 'invalidated'
    ) {
      if (now - w.updatedAt > 20 * 60_000) {
        if (w.status === 'triggered') {
          try {
            const { mintHasOpenPaperOrLiveTrade } =
              require('./profileWatchRegistry') as typeof import('./profileWatchRegistry');
            if (mintHasOpenPaperOrLiveTrade(mint)) continue;
          } catch {
            /* optional */
          }
        }
        watches.delete(mint);
        peakProgress.delete(mint);
        lastMcRefreshAt.delete(mint);
      }
    }
  }
  const active = [...watches.values()]
    .filter((w) => w.status === 'watching' || w.status === 'armed')
    .sort((a, b) => a.createdAt - b.createdAt);
  while (active.length > MAX_WATCHES) {
    const oldest = active.shift();
    if (!oldest) break;
    watches.delete(oldest.mint);
    peakProgress.delete(oldest.mint);
    lastMcRefreshAt.delete(oldest.mint);
  }
}

function qualitySoftOk(input: {
  holderGrowthPct?: number | null;
  buyPressureUsd?: number | null;
  volumeH1Usd?: number;
  holderCount?: number;
}): boolean {
  const m = migMatch();
  const growth = input.holderGrowthPct;
  if (growth != null && growth > 0) return true;
  const press = input.buyPressureUsd;
  if (press != null && press >= (m.minBuyPressureUsd ?? 400)) return true;
  const vol = input.volumeH1Usd;
  if (vol != null && vol >= (m.minVolumeH1Usd ?? 1500)) return true;
  const holders = input.holderCount;
  if (holders != null && holders >= (m.minHolders ?? 20)) return true;
  // No unknown-metrics soft-pass — stay watching until a real quality metric arrives.
  return false;
}

/**
 * Offer a near-curve pump.fun mint onto the graduation watchlist.
 */
export function considerMigrationGradWatch(input: {
  mint: string;
  symbol: string;
  name?: string;
  curveProgressPct?: number | null;
  marketCapUsd?: number;
  volumeH1Usd?: number;
  holderCount?: number;
  holderGrowthPct?: number | null;
  buyPressureUsd?: number | null;
  source?: string;
  nearMigration?: boolean;
  scannerSources?: string[];
  scannerCategories?: string[];
  isPumpFun?: boolean;
  preferredProfileId?: string;
}): GradWatchEntry | null {
  if (!isMigProfileEnabled()) return null;
  if (!input.mint) return null;
  if (isManualUnwatchCooldown(input.mint)) return null;
  const tagged =
    input.nearMigration === true ||
    input.preferredProfileId === 'migration_sniper' ||
    input.isPumpFun === true ||
    (input.scannerSources || []).some(
      (s) =>
        s === 'graduating_feed' ||
        s === 'alphascan' ||
        s === 'pump_stream'
    ) ||
    (input.scannerCategories || []).some((c) =>
      /^(soon|graduating|graduated|bonded|near-grad|mig_fresh)$/i.test(
        String(c)
      )
    );
  // Pump.fun mint heuristic — tagged graduating names may not end with pump
  if (!String(input.mint).toLowerCase().endsWith('pump') && !tagged) {
    return null;
  }

  const progress =
    input.curveProgressPct != null && Number.isFinite(input.curveProgressPct)
      ? Number(input.curveProgressPct)
      : null;
  if (progress == null || progress < watchPct()) return null;

  const maxMc = getMigrationSniperMaxMcUsd();
  // Align soft watch admit with hard buy max so the list does not trigger
  // tokens Migration Sniper cannot buy (Dex MC is still noisy near curve).
  if (
    input.marketCapUsd != null &&
    input.marketCapUsd > 0 &&
    input.marketCapUsd > maxMc
  ) {
    return null;
  }

  // Already active — refresh metrics (keep through MC volatility)
  pruneTerminal();
  const existing = watches.get(input.mint);
  if (
    existing &&
    (existing.status === 'watching' || existing.status === 'armed')
  ) {
    existing.updatedAt = Date.now();
    existing.curveProgressPct = progress;
    existing.marketCapUsd = input.marketCapUsd ?? existing.marketCapUsd;
    existing.volumeH1Usd = input.volumeH1Usd ?? existing.volumeH1Usd;
    existing.holderCount = input.holderCount ?? existing.holderCount;
    existing.holderGrowthPct =
      input.holderGrowthPct ?? existing.holderGrowthPct;
    existing.buyPressureUsd = input.buyPressureUsd ?? existing.buyPressureUsd;
    const peak = Math.max(peakProgress.get(input.mint) ?? 0, progress);
    peakProgress.set(input.mint, peak);
    stampGradWatchEligibility(existing);
    return existing;
  }

  // Replacing a terminal row (trigger / invalidate / expire) — fresh watch
  if (existing) {
    watches.delete(input.mint);
    peakProgress.delete(input.mint);
    lastMcRefreshAt.delete(input.mint);
  }
  const now = Date.now();
  const quality = qualitySoftOk(input);
  const inFire = progress >= fireMin() && progress <= fireMax();
  const entry: GradWatchEntry = {
    mint: input.mint,
    symbol: input.symbol || input.mint.slice(0, 6),
    name: input.name || input.symbol || 'Grad watch',
    status: quality ? 'armed' : 'watching',
    createdAt: now,
    updatedAt: now,
    armedAt: quality ? now : null,
    expiresAt: now + ttlMs(),
    curveProgressPct: progress,
    marketCapUsd: input.marketCapUsd,
    volumeH1Usd: input.volumeH1Usd,
    holderCount: input.holderCount,
    holderGrowthPct: input.holderGrowthPct ?? null,
    buyPressureUsd: input.buyPressureUsd ?? null,
    source: input.source,
    belowLowMcSinceMs: null,
    lastReason: quality
      ? `armed @ ${progress.toFixed(0)}%`
      : inFire
        ? `in fire band ${progress.toFixed(0)}% — waiting quality arm`
        : `watching @ ${progress.toFixed(0)}%`,
    preferredProfileId: 'migration_sniper',
  };
  watches.set(input.mint, entry);
  stampGradWatchEligibility(entry, true);
  peakProgress.set(input.mint, progress);
  funnel.watchAdmit += 1;
  if (entry.status === 'armed') funnel.armed += 1;
  console.log(
    `[grad-watch] ${entry.status.toUpperCase()} ${entry.symbol} ` +
      `curve=${progress.toFixed(1)}%`
  );
  ensureFastPoll();
  return entry;
}

function buildHandoff(
  w: GradWatchEntry,
  opts?: { postGrad?: boolean }
): ScannerCandidate & { launch: LaunchEvent } {
  const now = Date.now();
  const postGrad = opts?.postGrad === true;
  const progress = w.curveProgressPct ?? (postGrad ? 100 : fireMin());
  const launch: LaunchEvent = {
    mint: w.mint,
    symbol: w.symbol,
    name: w.name,
    launchedAt: w.createdAt,
    migrated: postGrad,
    entryPriceSol: 0,
    lastPriceSol: 0,
    priceChangePct: 0,
    marketCapUsd: w.marketCapUsd,
    volumeH1Usd: w.volumeH1Usd,
    volumeUsd: w.volumeH1Usd,
    holderCount: w.holderCount,
    candles: [],
    source: 'kolscan',
    candleSource: 'synthetic',
    isPumpFun: true,
    preferredProfileId: 'migration_sniper',
    specialtyFeed: 'kolscan',
  };
  const reasons = postGrad
    ? [
        'grad-watch:triggered',
        'grad-watch:post-grad',
        'armedWatch',
        `curve ${progress.toFixed(1)}% complete`,
      ]
    : [
        'grad-watch:triggered',
        'armedWatch',
        `curve ${progress.toFixed(1)}%`,
        `fire ≥${fireMin()}%`,
      ];
  return {
    id: `grad-watch-${w.mint.slice(0, 8)}-${now}`,
    mint: w.mint,
    symbol: w.symbol,
    name: w.name,
    timestamp: now,
    status: 'seen',
    rankScore: postGrad ? 96 : 94,
    reasons,
    source: 'kolscan',
    migrated: postGrad,
    isPumpFun: true,
    marketCapUsd: w.marketCapUsd,
    volumeH1Usd: w.volumeH1Usd,
    holderCount: w.holderCount,
    preferredProfileId: 'migration_sniper',
    specialtyFeed: 'kolscan',
    nearMigration: !postGrad,
    curveProgressPct: progress,
    candleSource: 'synthetic',
    armedWatch: true,
    entryStyleHint: 'migration_hold_reclaim',
    setupWatchFamily: 'grad',
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
    launch,
  };
}

function tryPostGradHandoff(w: GradWatchEntry, now: number): boolean {
  markAsMigrated(w.mint, 'grad-watch-complete');
  const migEv = getMigrationEvent(w.mint);
  const ageMs =
    migEv?.detectedAt != null ? now - migEv.detectedAt : now - (w.completeSeenAtMs || now);
  const maxMs = maxPostGradSec() * 1000;
  if (ageMs > maxMs) {
    w.status = 'expired';
    w.updatedAt = now;
    w.lastReason = `expired — no buy (post-grad ${Math.round(ageMs / 1000)}s > ${maxPostGradSec()}s)`;
    console.log(`[grad-watch] EXPIRED ${w.symbol} — ${w.lastReason}`);
    return false;
  }
  if (w.status !== 'armed') {
    w.lastReason = 'migration_quality_reject — post-grad not armed';
    w.updatedAt = now;
    try {
      const { noteProfileWatchFunnel } =
        require('./profileWatchRegistry') as typeof import('./profileWatchRegistry');
      noteProfileWatchFunnel('migration_sniper', 'blocked', 'migration_quality_reject');
      const { noteTriggerOpenBlocked } =
        require('./watchPipeline') as typeof import('./watchPipeline');
      noteTriggerOpenBlocked('migration_quality_reject');
    } catch {
      /* optional */
    }
    return false;
  }
  const c = buildHandoff(w, { postGrad: true });
  try {
    const { prepareArmedWatchOpen } =
      require('./profileWatchRegistry') as typeof import('./profileWatchRegistry');
    const gate = prepareArmedWatchOpen({
      profileId: 'migration_sniper',
      status: w.status,
      marketCapUsd: w.marketCapUsd,
      entry: w,
    });
    if (!gate.ok) {
      w.lastReason = gate.reason || 'migration_quality_reject';
      return false;
    }
    if (gate.profileId !== 'migration_sniper') {
      w.preferredProfileId = gate.profileId;
      c.preferredProfileId = gate.profileId;
      if (c.launch) c.launch.preferredProfileId = gate.profileId;
    }
  } catch {
    /* fail-open */
  }
  if (handOffScannerCandidate(c, { bypassCooldown: true })) {
    w.status = 'triggered';
    w.updatedAt = now;
    w.lastReason = `post-grad handoff ${Math.round(ageMs / 1000)}s`;
    funnel.triggered += 1;
    funnel.postGradTriggered += 1;
    console.log(
      `[grad-watch] TRIGGERED ${w.symbol} → migration_sniper post-grad @ ${Math.round(ageMs / 1000)}s`
    );
    return true;
  }
  funnel.handoffFail += 1;
  w.lastReason = 'post-grad handoff failed — retrying';
  w.updatedAt = now;
  return false;
}

/**
 * Tick watches: refresh curve (force), arm on quality, trigger from fire min
 * until complete, then post-grad handoff. Returns number of triggered handoffs.
 */
export async function tickMigrationGradWatches(): Promise<number> {
  if ((tickMigrationGradWatches as { _lane?: boolean })._lane !== true) {
    (tickMigrationGradWatches as { _lane?: boolean })._lane = true;
    try {
      const { runSetupWatchLane } =
        require('./rpcRouting') as typeof import('./rpcRouting');
      return await runSetupWatchLane(() => tickMigrationGradWatches());
    } finally {
      (tickMigrationGradWatches as { _lane?: boolean })._lane = false;
    }
  }
  try {
    const { shouldIdleIsolate } = require('./rpcWorkloadControl') as {
      shouldIdleIsolate?: () => boolean;
    };
    if (shouldIdleIsolate?.()) {
      stopFastPoll();
      return 0;
    }
  } catch {
    /* */
  }
  if (!isMigProfileEnabled()) return 0;
  pruneTerminal();
  const now = Date.now();
  let handed = 0;
  const fMin = fireMin();

  const stampGrad = (w: GradWatchEntry) => {
    stampWatchPriority('migration_sniper', w, {
      status: w.status,
      createdAt: w.createdAt,
      armedAt: w.armedAt,
      lastImprovementAt: w.lastImprovementAt,
      curveProgressPct: w.curveProgressPct,
      volumeH1Usd: w.volumeH1Usd,
      holderGrowthPct: w.holderGrowthPct,
      buyPressureUsd: w.buyPressureUsd,
      confluenceCount: w.confluenceCount,
    }, now);
  };
  for (const row of watches.values()) {
    if (row.status === 'watching' || row.status === 'armed') stampGrad(row);
  }
  const orderedGrad = sortActiveWatchesByScore([...watches.values()]);
  demoteArmedBeyondCap(orderedGrad, 'migration_sniper', now);

  for (const w of orderedGrad) {
    if (w.status !== 'watching' && w.status !== 'armed') continue;

    if (now >= w.expiresAt) {
      w.status = 'expired';
      w.updatedAt = now;
      w.lastReason = 'TTL expired';
      funnel.expired += 1;
      console.log(`[grad-watch] EXPIRED ${w.symbol}`);
      try {
        const { noteSetupWatchExpiredUnused, recordSetupWatchEvent } =
          require('./setupWatchEvents') as typeof import('./setupWatchEvents');
        noteSetupWatchExpiredUnused(w.mint);
        recordSetupWatchEvent({
          kind: 'watch_expired',
          family: 'grad',
          mint: w.mint,
          symbol: w.symbol,
          profileId: 'migration_sniper',
          reason: 'TTL expired',
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
    if (applyMcGrace(w, now)) continue;

    let progress = w.curveProgressPct;
    let complete = false;
    try {
      const curve = await fetchBondingCurve(w.mint, { force: true });
      if (curve) {
        const sum = summarizeBondingCurve(curve);
        progress = sum.progressPct;
        w.curveProgressPct = progress;
        complete = sum.complete === true;
      }
    } catch {
      /* keep last progress */
    }

    if (complete) {
      if (w.completeSeenAtMs == null) w.completeSeenAtMs = now;
      w.curveProgressPct = progress ?? 100;
      if (tryPostGradHandoff(w, now)) handed += 1;
      continue;
    }

    if (progress == null || !Number.isFinite(progress)) continue;

    const peak = Math.max(peakProgress.get(w.mint) ?? progress, progress);
    peakProgress.set(w.mint, peak);

    // Invalidate: hard regression from peak
    if (peak - progress >= REGRESS_INVALIDATE_PCT) {
      w.status = 'invalidated';
      w.updatedAt = now;
      w.lastReason = `curve dump ${peak.toFixed(0)}→${progress.toFixed(0)}%`;
      funnel.invalidated += 1;
      try {
        const { clearOneSetupProfileLock } =
          require('./expectancyLift') as typeof import('./expectancyLift');
        clearOneSetupProfileLock(w.mint, 'invalidated');
      } catch {
        /* optional */
      }
      console.log(`[grad-watch] INVALIDATED ${w.symbol} — ${w.lastReason}`);
      continue;
    }

    // Below watch floor
    if (progress < watchPct() - 5) {
      w.status = 'invalidated';
      w.updatedAt = now;
      w.lastReason = `fell below watch (${progress.toFixed(0)}%)`;
      funnel.invalidated += 1;
      try {
        const { clearOneSetupProfileLock } =
          require('./expectancyLift') as typeof import('./expectancyLift');
        clearOneSetupProfileLock(w.mint, 'invalidated');
      } catch {
        /* optional */
      }
      console.log(`[grad-watch] INVALIDATED ${w.symbol} — ${w.lastReason}`);
      continue;
    }

    const quality = qualitySoftOk(w);
    stampGrad(w);
    const lifeG = watchLifecycleAction(w, 'migration_sniper', now);
    if (lifeG === 'demote' && w.status === 'armed') {
      w.status = 'watching';
      w.armedAt = null;
      w.lastReason = 'demoted_from_armed';
      try {
        require('./watchPipeline').noteDemotedFromArmed();
      } catch {
        /* optional */
      }
    } else if (lifeG === 'expire_stagnant' || lifeG === 'expire_volume') {
      w.status = 'expired';
      w.updatedAt = now;
      w.lastReason =
        lifeG === 'expire_volume'
          ? 'expired_from_volume_collapse'
          : 'stagnant_decay_expired';
      funnel.expired += 1;
      try {
        require('./watchPipeline').noteStagnantExpired(
          lifeG === 'expire_volume' ? 'volume' : 'stagnant'
        );
      } catch {
        /* optional */
      }
      continue;
    }
    if (w.status === 'watching' && quality) {
      if (
        shouldSkipArmForCap(
          'migration_sniper',
          countArmedWatches(watches.values())
        ) ||
        (w.watchScore ?? 0) < WATCH_ARM_SCORE_FLOOR
      ) {
        try {
          require('./watchPipeline').noteSkippedLowScore();
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
      w.lastReason = `armed @ ${progress.toFixed(0)}%`;
      funnel.armed += 1;
      console.log(`[grad-watch] ARMED ${w.symbol}`);
      }
    }

    // Fire: ≥ fireMin while still on curve (no upper-band miss before complete)
    const inFire = progress >= fMin;
    if (inFire) {
      w.touchedFireBand = true;
    }

    // Touch-and-fail: was in fire band, now dumped below without reclaim/hold
    // Admission Baseline v235: skip reject (keep fire-band confirm)
    // Disable when armed openRate < 0.20 (starvation relief)
    let skipTouchFail = false;
    let failPct = FIRE_TOUCH_FAIL_PCT;
    try {
      const { isAdmissionBaselineV235 } =
        require('./expectancyLift') as typeof import('./expectancyLift');
      skipTouchFail = isAdmissionBaselineV235();
    } catch {
      skipTouchFail = false;
    }
    try {
      const { setupWatchEventStats } =
        require('./setupWatchEvents') as typeof import('./setupWatchEvents');
      const st = setupWatchEventStats();
      if (st.openRate != null && st.openRate < 0.2) skipTouchFail = true;
    } catch {
      /* soft */
    }
    if (
      !skipTouchFail &&
      w.touchedFireBand === true &&
      !inFire &&
      progress < fMin - failPct
    ) {
      w.lastReason = 'touch-and-fail reject';
      w.updatedAt = now;
      try {
        const { recordSetupWatchEvent } =
          require('./setupWatchEvents') as typeof import('./setupWatchEvents');
        recordSetupWatchEvent({
          kind: 'touch_fail',
          family: 'grad',
          mint: w.mint,
          symbol: w.symbol,
          profileId: 'migration_sniper',
          reason: 'touch-and-fail reject',
        });
      } catch {
        /* optional */
      }
      continue;
    }

    if (!inFire) {
      w.updatedAt = now;
      continue;
    }

    // Require quality arm before fire — no naked curve free-fire
    if (w.status !== 'armed') {
      funnel.fireMissNotArmed += 1;
      w.lastReason = `fire ${progress.toFixed(0)}% — waiting quality arm`;
      w.updatedAt = now;
      continue;
    }

    // Prefer reclaim/hold after fire touch (touchedFireBand + still inFire)
    const reclaimHold = w.touchedFireBand === true && inFire;
    if (!reclaimHold) {
      w.updatedAt = now;
      continue;
    }

    w.status = 'triggered';
    w.updatedAt = now;
    w.lastReason = `fire reclaim ${progress.toFixed(1)}%`;
    try {
      const { prepareArmedWatchOpen } =
        require('./profileWatchRegistry') as typeof import('./profileWatchRegistry');
      const gate = prepareArmedWatchOpen({
        profileId: 'migration_sniper',
        status: 'armed',
        marketCapUsd: w.marketCapUsd,
        entry: w,
      });
      if (!gate.ok) {
        w.status = 'armed';
        w.lastReason = gate.reason || 'trigger blocked';
        continue;
      }
      if (gate.profileId !== 'migration_sniper') {
        w.preferredProfileId = gate.profileId;
      }
    } catch {
      /* fail-open */
    }
    const c = buildHandoff(w);
    if (handOffScannerCandidate(c, { bypassCooldown: true })) {
      handed += 1;
      funnel.triggered += 1;
      console.log(
        `[grad-watch] TRIGGERED ${w.symbol} → migration_sniper @ ${progress.toFixed(1)}%`
      );
      try {
        const { clearOneSetupProfileLock } =
          require('./expectancyLift') as typeof import('./expectancyLift');
        clearOneSetupProfileLock(w.mint, 'triggered');
      } catch {
        /* optional */
      }
    } else {
      funnel.handoffFail += 1;
      w.status = 'armed';
      w.lastReason = 'handoff failed — retrying';
    }
  }

  if (
    ![...watches.values()].some(
      (w) => w.status === 'watching' || w.status === 'armed'
    )
  ) {
    stopFastPoll();
  }

  return handed;
}

export function stopFastPoll(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function ensureFastPoll(): void {
  try {
    const { shouldIdleIsolate } = require('./rpcWorkloadControl') as {
      shouldIdleIsolate?: () => boolean;
    };
    if (shouldIdleIsolate?.()) {
      stopFastPoll();
      return;
    }
  } catch {
    /* */
  }
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void tickMigrationGradWatches().catch(() => undefined);
  }, FAST_POLL_MS);
}

/**
 * Manual unwatch — removes active watch and blocks bot re-add for 15 minutes.
 */
export function unwatchMigrationGrad(mint: string): {
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
    watches.delete(key);
  }
  peakProgress.delete(key);
  lastMcRefreshAt.delete(key);
  unwatchCooldownUntil.set(key, Date.now() + UNWATCH_COOLDOWN_MS);
  console.log(
    `[grad-watch] UNWATCH ${existing?.symbol || key.slice(0, 8)}… · cooldown 15m`
  );
  return { ok: true, cooldownMs: UNWATCH_COOLDOWN_MS };
}

export function getMigrationGradWatchStatus(limit = 20): {
  active: number;
  entries: GradWatchEntry[];
  recentTerminal: GradWatchEntry[];
} {
  pruneTerminal();
  const now = Date.now();
  const all = [...watches.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  const entries = all.slice(0, limit);
  const recentTerminal = all
    .filter((e) => {
      try {
        const { keepWatchTerminalForUi } =
          require('./profileWatchRegistry') as typeof import('./profileWatchRegistry');
        return keepWatchTerminalForUi({
          status: e.status,
          mint: e.mint,
          updatedAt: e.updatedAt,
          now,
          terminalMs: TERMINAL_UI_MS,
        });
      } catch {
        return (
          (e.status === 'triggered' ||
            e.status === 'expired' ||
            e.status === 'invalidated') &&
          now - e.updatedAt <= TERMINAL_UI_MS
        );
      }
    })
    .slice(0, 8);
  return {
    active: entries.filter(
      (e) => e.status === 'watching' || e.status === 'armed'
    ).length,
    entries,
    recentTerminal,
  };
}

/** Live curve % for an open MS position (never-mig stall). */
export function getGradWatchCurveProgressPct(mint: string): number | null {
  const w = watches.get(String(mint || '').trim());
  const p = w?.curveProgressPct;
  return p != null && Number.isFinite(Number(p)) ? Number(p) : null;
}

/** Offer from near-mig wallet / scanner candidates. */
export function offerMigrationGradWatchFromCandidate(c: {
  mint: string;
  symbol: string;
  name?: string;
  marketCapUsd?: number;
  volumeH1Usd?: number;
  holderCount?: number;
  curveProgressPct?: number | null;
  nearMigration?: boolean;
  preferredProfileId?: string;
  specialtyFeed?: string;
  scannerSources?: string[];
  scannerCategories?: string[];
  isPumpFun?: boolean;
}): boolean {
  try {
    const { noteWatchInsertAttempt } =
      require('./watchPipeline') as typeof import('./watchPipeline');
    noteWatchInsertAttempt();
  } catch {
    /* optional */
  }
  const tagged =
    c.nearMigration === true ||
    c.preferredProfileId === 'migration_sniper' ||
    c.isPumpFun === true ||
    (c.scannerSources || []).some(
      (s) =>
        s === 'graduating_feed' || s === 'alphascan' || s === 'pump_stream'
    ) ||
    (c.scannerCategories || []).some((cat) =>
      /^(soon|graduating|graduated|bonded|near-grad|mig_fresh)$/i.test(
        String(cat)
      )
    );
  const progress = c.curveProgressPct;
  if (
    progress == null &&
    !tagged &&
    c.nearMigration !== true &&
    c.preferredProfileId !== 'migration_sniper'
  ) {
    return false;
  }
  const row = considerMigrationGradWatch({
    mint: c.mint,
    symbol: c.symbol,
    name: c.name,
    curveProgressPct:
      progress ?? (tagged || c.nearMigration ? watchPct() : null),
    marketCapUsd: c.marketCapUsd,
    volumeH1Usd: c.volumeH1Usd,
    holderCount: c.holderCount,
    source:
      c.specialtyFeed ||
      (c.scannerSources || [])[0] ||
      'scanner',
    nearMigration: tagged || c.nearMigration,
    scannerSources: c.scannerSources,
    scannerCategories: c.scannerCategories,
    isPumpFun: c.isPumpFun,
    preferredProfileId: c.preferredProfileId,
  });
  if (!row) {
    try {
      const { noteWatchInsertReject } =
        require('./watchPipeline') as typeof import('./watchPipeline');
      noteWatchInsertReject('admit_failed');
    } catch {
      /* optional */
    }
  }
  return row != null;
}
