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
} from './tradeProfiles';

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
  source?: string;
  /** Wall-clock when known MC first went below LOW_MC_USD (cleared when recovered) */
  belowLowMcSinceMs?: number | null;
  /** First time we observed curve complete (post-grad retry window) */
  completeSeenAtMs?: number | null;
}

const MAX_WATCHES = 32;
const DEFAULT_TTL_MS = 60 * 60_000; // 60 min
const FAST_POLL_MS = 1_500;
const REGRESS_INVALIDATE_PCT = 8; // hard dump from peak watched progress
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
    : 90;
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
  // Soft-pass when metrics unknown (latency path) — arm only with curve + pump mint
  return (
    growth == null &&
    press == null &&
    (vol == null || vol <= 0) &&
    (holders == null || holders <= 0)
  );
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
}): GradWatchEntry | null {
  if (!isMigProfileEnabled()) return null;
  if (!input.mint) return null;
  if (isManualUnwatchCooldown(input.mint)) return null;
  // Pump.fun mint heuristic
  if (!String(input.mint).toLowerCase().endsWith('pump')) return null;

  const progress =
    input.curveProgressPct != null && Number.isFinite(input.curveProgressPct)
      ? Number(input.curveProgressPct)
      : null;
  if (progress == null || progress < watchPct()) return null;

  const m = migMatch();
  const maxMc = m.maxMarketCapUsd ?? 200_000;
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
    status: quality || inFire ? 'armed' : 'watching',
    createdAt: now,
    updatedAt: now,
    armedAt: quality || inFire ? now : null,
    expiresAt: now + ttlMs(),
    curveProgressPct: progress,
    marketCapUsd: input.marketCapUsd,
    volumeH1Usd: input.volumeH1Usd,
    holderCount: input.holderCount,
    holderGrowthPct: input.holderGrowthPct ?? null,
    buyPressureUsd: input.buyPressureUsd ?? null,
    source: input.source,
    belowLowMcSinceMs: null,
    lastReason: inFire
      ? `in fire band ${progress.toFixed(0)}%`
      : quality
        ? `armed @ ${progress.toFixed(0)}%`
        : `watching @ ${progress.toFixed(0)}%`,
  };
  watches.set(input.mint, entry);
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
  const c = buildHandoff(w, { postGrad: true });
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
  if (!isMigProfileEnabled()) return 0;
  pruneTerminal();
  const now = Date.now();
  let handed = 0;
  const fMin = fireMin();

  for (const w of watches.values()) {
    if (w.status !== 'watching' && w.status !== 'armed') continue;

    if (now >= w.expiresAt) {
      w.status = 'expired';
      w.updatedAt = now;
      w.lastReason = 'TTL expired';
      funnel.expired += 1;
      console.log(`[grad-watch] EXPIRED ${w.symbol}`);
      continue;
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
      console.log(`[grad-watch] INVALIDATED ${w.symbol} — ${w.lastReason}`);
      continue;
    }

    // Below watch floor
    if (progress < watchPct() - 5) {
      w.status = 'invalidated';
      w.updatedAt = now;
      w.lastReason = `fell below watch (${progress.toFixed(0)}%)`;
      funnel.invalidated += 1;
      console.log(`[grad-watch] INVALIDATED ${w.symbol} — ${w.lastReason}`);
      continue;
    }

    const quality = qualitySoftOk(w);
    if (w.status === 'watching' && quality && progress < fMin) {
      w.status = 'armed';
      w.armedAt = now;
      w.updatedAt = now;
      w.lastReason = `armed @ ${progress.toFixed(0)}%`;
      funnel.armed += 1;
      console.log(`[grad-watch] ARMED ${w.symbol}`);
    }

    // Fire: ≥ fireMin while still on curve (no upper-band miss before complete)
    const inFire = progress >= fMin;
    if (!inFire) {
      w.updatedAt = now;
      continue;
    }

    // Require armed OR quality soft-ok (junk watches in fire band do not buy)
    if (w.status !== 'armed' && !quality) {
      funnel.fireMissNotArmed += 1;
      w.lastReason = `fire ${progress.toFixed(0)}% — waiting quality arm`;
      w.updatedAt = now;
      continue;
    }
    if (w.status === 'watching' && quality) {
      w.status = 'armed';
      w.armedAt = w.armedAt ?? now;
      funnel.armed += 1;
    }

    w.status = 'triggered';
    w.updatedAt = now;
    w.lastReason = `fire ${progress.toFixed(1)}%`;
    const c = buildHandoff(w);
    if (handOffScannerCandidate(c, { bypassCooldown: true })) {
      handed += 1;
      funnel.triggered += 1;
      console.log(
        `[grad-watch] TRIGGERED ${w.symbol} → migration_sniper @ ${progress.toFixed(1)}%`
      );
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

function ensureFastPoll(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void tickMigrationGradWatches().catch(() => undefined);
  }, FAST_POLL_MS);
}

function stopFastPoll(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
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
    .filter(
      (e) =>
        (e.status === 'triggered' ||
          e.status === 'expired' ||
          e.status === 'invalidated') &&
        now - e.updatedAt <= TERMINAL_UI_MS
    )
    .slice(0, 8);
  return {
    active: entries.filter(
      (e) => e.status === 'watching' || e.status === 'armed'
    ).length,
    entries,
    recentTerminal,
  };
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
}): void {
  const progress = c.curveProgressPct;
  if (
    progress == null &&
    c.nearMigration !== true &&
    c.preferredProfileId !== 'migration_sniper'
  ) {
    return;
  }
  considerMigrationGradWatch({
    mint: c.mint,
    symbol: c.symbol,
    name: c.name,
    curveProgressPct: progress ?? (c.nearMigration ? watchPct() : null),
    marketCapUsd: c.marketCapUsd,
    volumeH1Usd: c.volumeH1Usd,
    holderCount: c.holderCount,
    source: c.specialtyFeed || 'scanner',
  });
}
