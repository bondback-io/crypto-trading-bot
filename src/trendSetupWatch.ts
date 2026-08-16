/**
 * Trend Rider pre-entry watchlist: watch → arm → trigger → expire / invalidate.
 * Priority MC ≥ $1M trending DNA — does NOT share Mode B microcap band or
 * Steady Medium/Majors quality parks unless Trend DNA clearly wins.
 */

import type { LaunchEvent } from './marketData';
import { fetchLiveTokenSnapshot } from './marketData';
import { isDeniedCopyMint } from './deniedMints';
import {
  handOffScannerCandidate,
  type ScannerCandidate,
} from './marketScanner';
import { isStrategyEnabledGlobal } from './strategies';
import {
  isSmartBotProfilesEnabled,
} from './tradeProfiles';
import { detectSupportReclaim } from './supportReclaim';
import {
  stampWatchPriority,
  sortActiveWatchesByScore,
  shouldSkipArmForCap,
  countArmedWatches,
  demoteArmedBeyondCap,
  watchLifecycleAction,
  WATCH_ARM_SCORE_FLOOR,
} from './watchPriorityScore';
import {
  applyArmLifecycleTimeout,
  recomputeNearSupportFromPrice,
  resetArmClockOnArm,
  stampWatchVolumeOk,
  stampWatchingHoldReason,
} from './watchArmLifecycle';

export type TrendWatchStatus =
  | 'watching'
  | 'armed'
  | 'triggered'
  | 'expired'
  | 'invalidated';

export interface TrendWatchEntry {
  mint: string;
  symbol: string;
  name: string;
  status: TrendWatchStatus;
  createdAt: number;
  updatedAt: number;
  armedAt: number | null;
  expiresAt: number;
  marketCapUsd?: number;
  volumeH1Usd?: number;
  volumeM5Usd?: number;
  holderCount?: number;
  holderGrowthPct?: number | null;
  priceChangeH1Pct?: number | null;
  nearSupport?: boolean;
  nearKeyFib?: boolean;
  supportPriceSol?: number | null;
  lastPriceSol?: number | null;
  lastReason?: string;
  kolCount?: number;
  source?: string;
  specialtyFeed?: string;
  chartPatternIds?: string[];
  preferredProfileId?: string;
  eligibleProfileIds?: string[];
  confluenceCount?: number | null;
  playbookPassed?: string[];
  triggerBlockReason?: string;
  entryStyle?: string;
  qualityScore?: number | null;
  sizePlanSol?: number | null;
  dnaHits?: number;
  volumeDecayState?: string | null;
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
  volOk?: boolean;
  armClockPausedAt?: number | null;
  armClockPausedMs?: number;
}

const MAX_WATCHES = 12;
/** Hard exclude microcaps — leave to Mode B / Migration / Reversal */
export const TREND_WATCH_MIN_MC_USD = 1_000_000;
/** Soft prefer when vol/holders strong */
export const TREND_WATCH_SOFT_MC_USD = 5_000_000;
const DEFAULT_TTL_MS = 6 * 60 * 60_000;
const UNWATCH_COOLDOWN_MS = 15 * 60_000;
const MC_REFRESH_MIN_MS = 20_000;
const TERMINAL_UI_MS = 60_000;
const TRIGGER_RECLAIM_PCT = 1.0;

const watches = new Map<string, TrendWatchEntry>();
let lastMcRefreshAt = new Map<string, number>();
const unwatchCooldownUntil = new Map<string, number>();

const trendFunnel = {
  offered: 0,
  watching: 0,
  armed: 0,
  triggered: 0,
  expired: 0,
  invalidated: 0,
  blocked: 0,
  trend_yield_to_dip_armed: 0,
  trend_expired_by_dip_admit: 0,
  trend_admitted_despite_dip_watching: 0,
};

export function noteTrendFunnel(key: keyof typeof trendFunnel, n = 1): void {
  trendFunnel[key] = (trendFunnel[key] || 0) + n;
}

function stampTrendWatchEligibility(
  w: TrendWatchEntry,
  isNew = false
): void {
  try {
    const { stampEligibleOnWatchEntry, noteProfileWatchFunnel } =
      require('./profileWatchRegistry') as typeof import('./profileWatchRegistry');
    w.preferredProfileId = w.preferredProfileId || 'trend_rider';
    const ids = stampEligibleOnWatchEntry('trend', w);
    if (isNew) {
      for (const id of ids) noteProfileWatchFunnel(id, 'sent_to_watch', undefined, w.source);
      if (w.status === 'armed') {
        for (const id of ids) noteProfileWatchFunnel(id, 'armed', undefined, w.source);
      }
    }
  } catch {
    w.eligibleProfileIds = ['trend_rider'];
  }
}

export function getTrendFunnelCounters(): typeof trendFunnel & {
  watchingNow: number;
  armedNow: number;
} {
  let watchingNow = 0;
  let armedNow = 0;
  for (const w of watches.values()) {
    if (w.status === 'watching') watchingNow += 1;
    if (w.status === 'armed') armedNow += 1;
  }
  return { ...trendFunnel, watchingNow, armedNow };
}

function isActiveWatch(w: TrendWatchEntry): boolean {
  return w.status === 'watching' || w.status === 'armed';
}

function isTrendProfileEnabled(): boolean {
  if (!isSmartBotProfilesEnabled()) return false;
  if (!isStrategyEnabledGlobal('ta_market_scanner')) return false;
  const { config } = require('./config') as typeof import('./config');
  if (config.tradeProfiles?.enabled === false) return false;
  if (config.tradeProfiles?.profiles?.trend_rider === false) return false;
  try {
    const { isProfileWatchEnabled } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    if (!isProfileWatchEnabled('trend_rider')) return false;
  } catch {
    /* optional */
  }
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

function pruneTerminal(): void {
  const now = Date.now();
  for (const [mint, w] of watches) {
    if (
      w.status === 'triggered' ||
      w.status === 'expired' ||
      w.status === 'invalidated'
    ) {
      if (now - w.updatedAt > 30 * 60_000) {
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
        lastMcRefreshAt.delete(mint);
      }
    }
  }
  const active = [...watches.values()]
    .filter(isActiveWatch)
    .sort((a, b) => a.createdAt - b.createdAt);
  while (active.length > MAX_WATCHES) {
    const oldest = active.shift();
    if (!oldest) break;
    watches.delete(oldest.mint);
    lastMcRefreshAt.delete(oldest.mint);
  }
}

function stampWatchPlan(w: TrendWatchEntry): void {
  const hits = w.dnaHits ?? 0;
  w.qualityScore = Math.min(88, 50 + hits * 8);
  w.entryStyle = 'trend_pullback_continuation';
  try {
    const { calculateDynamicPositionSize } =
      require('./risk') as typeof import('./risk');
    const { paperTrader } =
      require('./paperTrader') as typeof import('./paperTrader');
    const sizing = calculateDynamicPositionSize({
      equitySol: paperTrader.getEquitySol(),
      kind: 'normal',
      openCount: paperTrader.getOpenPositions().length,
      sizeMultiplier: 0.95,
    });
    w.sizePlanSol = sizing.sizeSol;
  } catch {
    w.sizePlanSol = w.sizePlanSol ?? null;
  }
}

/** Score Trend DNA — several of: longer TF vol, holders up, MC growth, social, chart. */
export function scoreTrendDna(input: {
  marketCapUsd?: number;
  volumeH1Usd?: number;
  volumeM5Usd?: number;
  volumeH6Usd?: number;
  holderCount?: number;
  holderGrowthPct?: number | null;
  priceChangeH1Pct?: number | null;
  priceChangePct?: number | null;
  kolCount?: number;
  specialtyFeed?: string;
  chartPatternIds?: string[];
  nearSupport?: boolean;
  nearKeyFib?: boolean;
  volumeDecayState?: string | null;
}): { hits: number; reasons: string[]; softPreferMc: boolean } {
  const reasons: string[] = [];
  let hits = 0;
  const mc = Number(input.marketCapUsd ?? 0);
  const volH1 = Number(input.volumeH1Usd ?? 0);
  const volM5 = Number(input.volumeM5Usd ?? 0);
  const volH6 = Number(input.volumeH6Usd ?? 0);
  const softPreferMc = mc >= TREND_WATCH_SOFT_MC_USD;

  // Longer-window volume expand (not 5m spike alone)
  if (volH1 >= 15_000) {
    hits += 1;
    reasons.push('H1 vol');
  }
  if (volH6 >= 40_000 || (volH1 >= 25_000 && volM5 > 0 && volM5 < volH1 * 0.35)) {
    hits += 1;
    reasons.push('multi-TF vol');
  }
  if (String(input.volumeDecayState || '') === 'expanding') {
    hits += 1;
    reasons.push('vol expanding');
  }

  const hg = input.holderGrowthPct;
  if (hg != null && Number.isFinite(hg) && hg > 2) {
    hits += 1;
    reasons.push(`holders +${hg.toFixed(0)}%`);
  } else if (
    input.holderCount != null &&
    input.holderCount >= 120
  ) {
    hits += 1;
    reasons.push('holders base');
  }

  const h1 = input.priceChangeH1Pct;
  if (h1 != null && Number.isFinite(h1) && h1 > 3 && h1 < 80) {
    hits += 1;
    reasons.push(`MC/price +${h1.toFixed(0)}% H1`);
  }

  const feed = String(input.specialtyFeed || '').toLowerCase();
  if (
    feed === 'jupiter' ||
    feed === 'kolscan' ||
    (input.kolCount != null && input.kolCount >= 2)
  ) {
    hits += 1;
    reasons.push(feed === 'kolscan' || (input.kolCount ?? 0) >= 2 ? 'KOL heat' : 'Jupiter heat');
  }

  const pats = input.chartPatternIds || [];
  const trendPat = pats.some((p) =>
    /trend_continuation|bull_flag/i.test(String(p))
  );
  if (trendPat) {
    hits += 1;
    reasons.push('trend chart');
  }

  if (softPreferMc) {
    hits += 1;
    reasons.push('MC≥$5M soft');
  }

  return { hits, reasons, softPreferMc };
}

/** Specialty Jupiter/KOL (and ≥$5M) need 2 DNA hits; scanner micros still need 3. */
export function trendWatchMinDnaHits(input: {
  marketCapUsd?: number;
  specialtyFeed?: string;
}): number {
  const feed = String(input.specialtyFeed || '').toLowerCase();
  if (feed === 'jupiter' || feed === 'kolscan') return 2;
  const mc = Number(input.marketCapUsd ?? 0);
  if (mc >= TREND_WATCH_SOFT_MC_USD) return 2;
  return 3;
}

function mutualExclusionBlocked(mint: string): string | null {
  try {
    const { isMintOnActiveScalperWatch } =
      require('./scalperSetupWatch') as typeof import('./scalperSetupWatch');
    if (isMintOnActiveScalperWatch(mint)) return 'Mode B active';
  } catch {
    /* optional */
  }
  try {
    const { isMintOnActiveDipWatch, getActiveDipWatchesSnapshot } =
      require('./dipSetupWatch') as typeof import('./dipSetupWatch');
    if (isMintOnActiveDipWatch(mint)) {
      const dw = getActiveDipWatchesSnapshot();
      const row = (dw.allActive || []).find(
        (e) =>
          e.mint === mint &&
          (e.status === 'watching' || e.status === 'armed')
      );
      if (!row) return null;
      const src = String(row?.source || '');
      const dumpBand =
        Number(row.dropFromPeakPct ?? 0) >= 8 &&
        (row.nearKeyFib === true || row.nearSupport === true);
      if (row.status === 'armed') {
        noteTrendFunnel('trend_yield_to_dip_armed');
        return 'Dip armed';
      }
      if (dumpBand) return 'Dip dump-reclaim';
      // Yield to Steady quality park only when Trend DNA is weak
      if (src === 'medium' || src === 'majors') {
        const dna = scoreTrendDna({
          marketCapUsd: row.marketCapUsd,
          volumeH1Usd: row.volumeH1Usd,
          nearSupport: row.nearSupport,
          nearKeyFib: row.nearKeyFib,
        });
        if (dna.hits < 4) return 'Steady quality park';
        noteTrendFunnel('trend_admitted_despite_dip_watching');
        return null;
      }
    }
  } catch {
    /* optional */
  }
  return null;
}

/**
 * Consider a candidate for the Trend Rider watchlist.
 */
let lastTrendAdmitReject = '';
export function getLastTrendAdmitReject(): string {
  return lastTrendAdmitReject;
}

export function considerTrendWatchSetup(input: {
  mint: string;
  symbol: string;
  name?: string;
  marketCapUsd?: number;
  volumeH1Usd?: number;
  volumeM5Usd?: number;
  volumeH6Usd?: number;
  holderCount?: number;
  holderGrowthPct?: number | null;
  priceChangeH1Pct?: number | null;
  priceChangePct?: number | null;
  nearKeyFib?: boolean;
  nearSupport?: boolean;
  lastPriceSol?: number | null;
  supportPriceSol?: number | null;
  kolCount?: number;
  source?: string;
  specialtyFeed?: string;
  chartPatternIds?: string[];
  volumeDecayState?: string | null;
}): TrendWatchEntry | null {
  lastTrendAdmitReject = '';
  if (!isTrendProfileEnabled()) {
    lastTrendAdmitReject = 'profile_off';
    return null;
  }
  if (!input.mint) {
    lastTrendAdmitReject = 'no_mint';
    return null;
  }
  if (isManualUnwatchCooldown(input.mint)) {
    lastTrendAdmitReject = 'unwatch_cd';
    return null;
  }

  try {
    const { config } = require('./config') as typeof import('./config');
    if (isDeniedCopyMint(input.mint, config.solMint)) {
      noteTrendFunnel('blocked');
      lastTrendAdmitReject = 'denied_mint';
      return null;
    }
  } catch {
    if (isDeniedCopyMint(input.mint)) {
      noteTrendFunnel('blocked');
      lastTrendAdmitReject = 'denied_mint';
      return null;
    }
  }

  const mc = Number(input.marketCapUsd ?? 0);
  if (!(mc >= TREND_WATCH_MIN_MC_USD)) {
    lastTrendAdmitReject = 'mc';
    return null;
  }
  // Hard exclude Mode B band (Scalper owns up to Dip catalog min $1M)
  if (mc > 0 && mc < TREND_WATCH_MIN_MC_USD) {
    return null;
  }

  const block = mutualExclusionBlocked(input.mint);
  if (block) {
    noteTrendFunnel('blocked');
    lastTrendAdmitReject = 'mutual_exclude';
    return null;
  }

  const dna = scoreTrendDna(input);
  const minHits = trendWatchMinDnaHits(input);
  if (dna.hits < minHits) {
    noteTrendFunnel('blocked');
    lastTrendAdmitReject = 'dna_hits';
    return null;
  }

  pruneTerminal();
  const existing = watches.get(input.mint);
  if (existing && isActiveWatch(existing)) {
    existing.marketCapUsd = input.marketCapUsd ?? existing.marketCapUsd;
    existing.volumeH1Usd = input.volumeH1Usd ?? existing.volumeH1Usd;
    existing.volumeM5Usd = input.volumeM5Usd ?? existing.volumeM5Usd;
    existing.holderCount = input.holderCount ?? existing.holderCount;
    existing.holderGrowthPct =
      input.holderGrowthPct ?? existing.holderGrowthPct;
    existing.priceChangeH1Pct =
      input.priceChangeH1Pct ?? existing.priceChangeH1Pct;
    existing.nearSupport = input.nearSupport ?? existing.nearSupport;
    existing.nearKeyFib = input.nearKeyFib ?? existing.nearKeyFib;
    existing.lastPriceSol = input.lastPriceSol ?? existing.lastPriceSol;
    existing.supportPriceSol =
      input.supportPriceSol ?? existing.supportPriceSol;
    existing.kolCount = input.kolCount ?? existing.kolCount;
    existing.chartPatternIds =
      input.chartPatternIds ?? existing.chartPatternIds;
    existing.dnaHits = dna.hits;
    existing.volumeDecayState =
      input.volumeDecayState ?? existing.volumeDecayState;
    existing.updatedAt = Date.now();
    stampTrendWatchEligibility(existing);
    return existing;
  }

  const now = Date.now();
  const nearArm =
    input.nearSupport === true ||
    input.nearKeyFib === true ||
    dna.hits >= minHits + 1;
  const entry: TrendWatchEntry = {
    mint: input.mint,
    symbol: input.symbol || input.mint.slice(0, 6),
    name: input.name || input.symbol || 'Trend watch',
    status: nearArm ? 'armed' : 'watching',
    createdAt: now,
    updatedAt: now,
    armedAt: nearArm ? now : null,
    expiresAt: now + DEFAULT_TTL_MS,
    marketCapUsd: mc,
    volumeH1Usd: input.volumeH1Usd,
    volumeM5Usd: input.volumeM5Usd,
    holderCount: input.holderCount,
    holderGrowthPct: input.holderGrowthPct ?? null,
    priceChangeH1Pct: input.priceChangeH1Pct ?? null,
    nearSupport: input.nearSupport,
    nearKeyFib: input.nearKeyFib,
    supportPriceSol: input.supportPriceSol ?? null,
    lastPriceSol: input.lastPriceSol ?? null,
    kolCount: input.kolCount,
    source: input.source || input.specialtyFeed || 'scanner',
    specialtyFeed: input.specialtyFeed,
    chartPatternIds: input.chartPatternIds,
    preferredProfileId: 'trend_rider',
    dnaHits: dna.hits,
    volumeDecayState: input.volumeDecayState ?? null,
    lastReason: nearArm
      ? `armed · ${dna.reasons.slice(0, 3).join('+')}`
      : `watching · ${dna.reasons.slice(0, 3).join('+')}`,
  };
  if (nearArm) stampWatchPlan(entry);
  watches.set(input.mint, entry);
  stampTrendWatchEligibility(entry, true);
  noteTrendFunnel('offered');
  if (nearArm) noteTrendFunnel('armed');
  else noteTrendFunnel('watching');
  console.log(
    `[trend-watch] ${entry.status.toUpperCase()} ${entry.symbol} ` +
      `MC=$${Math.round(mc)} dna=${dna.hits} [${dna.reasons.slice(0, 4).join(',')}]`
  );
  if (nearArm) {
    try {
      const { recordSetupWatchEvent } =
        require('./setupWatchEvents') as typeof import('./setupWatchEvents');
      recordSetupWatchEvent({
        kind: 'armed',
        family: 'trend',
        mint: entry.mint,
        symbol: entry.symbol,
        profileId: 'trend_rider',
        reason: entry.lastReason,
        qualityScore: entry.qualityScore,
        entryStyle: entry.entryStyle,
      });
    } catch {
      /* optional */
    }
  }
  return entry;
}

function buildHandoff(
  w: TrendWatchEntry
): ScannerCandidate & { launch: LaunchEvent } {
  const now = Date.now();
  const feed =
    w.specialtyFeed === 'jupiter' ||
    w.specialtyFeed === 'kolscan' ||
    w.specialtyFeed === 'majors' ||
    w.specialtyFeed === 'medium'
      ? w.specialtyFeed
      : 'jupiter';
  const launch: LaunchEvent = {
    mint: w.mint,
    symbol: w.symbol,
    name: w.name,
    launchedAt: w.createdAt,
    migrated: true,
    entryPriceSol: w.lastPriceSol || 0,
    lastPriceSol: w.lastPriceSol || 0,
    priceChangePct: w.priceChangeH1Pct ?? 0,
    marketCapUsd: w.marketCapUsd,
    volumeH1Usd: w.volumeH1Usd,
    volumeUsd: w.volumeH1Usd,
    holderCount: w.holderCount,
    candles: [],
    source: 'jupiter',
    candleSource: 'synthetic',
    preferredProfileId: 'trend_rider',
    specialtyFeed: feed as LaunchEvent['specialtyFeed'],
  };
  return {
    id: `trend-watch-${w.mint.slice(0, 8)}-${now}`,
    mint: w.mint,
    symbol: w.symbol,
    name: w.name,
    timestamp: now,
    status: 'seen',
    rankScore: 91,
    reasons: [
      'trend-watch:triggered',
      'armedWatch',
      'prefer:trend_rider',
      w.entryStyle || 'trend_pullback_continuation',
      `dna:${w.dnaHits ?? 0}`,
    ],
    source: 'jupiter',
    migrated: true,
    marketCapUsd: w.marketCapUsd,
    volumeH1Usd: w.volumeH1Usd,
    volumeM5Usd: w.volumeM5Usd,
    holderCount: w.holderCount,
    preferredProfileId: 'trend_rider',
    specialtyFeed: feed as ScannerCandidate['specialtyFeed'],
    kolCount: w.kolCount,
    nearKeyFib: w.nearKeyFib,
    nearSupport: w.nearSupport,
    candleSource: 'synthetic',
    armedWatch: true,
    entryStyleHint: w.entryStyle || 'trend_pullback_continuation',
    qualityScoreHint: w.qualityScore ?? undefined,
    sizePlanSol: w.sizePlanSol ?? undefined,
    setupWatchFamily: 'trend' as ScannerCandidate['setupWatchFamily'],
    supportPriceSol: w.supportPriceSol ?? null,
    lastPriceSol: w.lastPriceSol ?? null,
    chartPatternIds: w.chartPatternIds,
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

async function refreshWatchMarket(w: TrendWatchEntry, now: number): Promise<void> {
  try {
    const { shouldIdleIsolate } = require('./rpcWorkloadControl') as {
      shouldIdleIsolate?: () => boolean;
    };
    if (shouldIdleIsolate?.()) return;
  } catch {
    /* fail-open */
  }
  const last = lastMcRefreshAt.get(w.mint) ?? 0;
  if (now - last < MC_REFRESH_MIN_MS) return;
  lastMcRefreshAt.set(w.mint, now);
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
        w.priceChangeH1Pct = Number(snap.priceChangeH1Pct);
      }
    }
  } catch {
    /* keep last */
  }
}

export async function tickTrendSetupWatches(opts?: {
  priceByMint?: Map<string, number>;
}): Promise<number> {
  if ((tickTrendSetupWatches as { _lane?: boolean })._lane !== true) {
    (tickTrendSetupWatches as { _lane?: boolean })._lane = true;
    try {
      const { runSetupWatchLane } =
        require('./rpcRouting') as typeof import('./rpcRouting');
      return await runSetupWatchLane(() => tickTrendSetupWatches(opts));
    } finally {
      (tickTrendSetupWatches as { _lane?: boolean })._lane = false;
    }
  }
  if (!isTrendProfileEnabled()) return 0;
  pruneTerminal();
  const now = Date.now();
  let handed = 0;

  const stampTrend = (w: TrendWatchEntry) => {
    stampWatchPriority('trend_rider', w, {
      status: w.status,
      createdAt: w.createdAt,
      armedAt: w.armedAt,
      lastImprovementAt: w.lastImprovementAt,
      nearSupport: w.nearSupport,
      nearKeyFib: w.nearKeyFib,
      supportPriceSol: w.supportPriceSol,
      lastPriceSol: w.lastPriceSol,
      confluenceCount: w.confluenceCount,
      dnaHits: w.dnaHits,
      volumeM5Usd: w.volumeM5Usd,
      volumeH1Usd: w.volumeH1Usd,
      holderGrowthPct: w.holderGrowthPct,
    }, now);
  };
  for (const row of watches.values()) {
    if (row.status === 'watching' || row.status === 'armed') stampTrend(row);
  }
  const orderedTrend = sortActiveWatchesByScore([...watches.values()]);
  demoteArmedBeyondCap(orderedTrend, 'trend_rider', now);

  for (const w of orderedTrend) {
    if (w.status !== 'watching' && w.status !== 'armed') continue;

    if (now >= w.expiresAt) {
      w.status = 'expired';
      w.updatedAt = now;
      w.lastReason = 'TTL expired';
      noteTrendFunnel('expired');
      try {
        const { clearOneSetupProfileLock } =
          require('./expectancyLift') as typeof import('./expectancyLift');
        clearOneSetupProfileLock(w.mint, 'expired');
      } catch {
        /* optional */
      }
      continue;
    }

    await refreshWatchMarket(w, now);
    const px = opts?.priceByMint?.get(w.mint) ?? w.lastPriceSol ?? null;
    if (px != null) w.lastPriceSol = px;
    recomputeNearSupportFromPrice(w);
    stampWatchVolumeOk(w);
    stampTrend(w);
    const lifeT = watchLifecycleAction(w, 'trend_rider', now);
    if (lifeT === 'demote' && w.status === 'armed') {
      w.status = 'watching';
      w.armedAt = null;
      w.lastReason = 'demoted_from_armed';
      try {
        require('./watchPipeline').noteDemotedFromArmed();
      } catch {
        /* optional */
      }
    } else if (lifeT === 'expire_stagnant' || lifeT === 'expire_volume') {
      w.status = 'expired';
      w.updatedAt = now;
      w.lastReason =
        lifeT === 'expire_volume'
          ? 'expired_from_volume_collapse'
          : 'stagnant_decay_expired';
      noteTrendFunnel('expired');
      try {
        require('./watchPipeline').noteStagnantExpired(
          lifeT === 'expire_volume' ? 'volume' : 'stagnant'
        );
      } catch {
        /* optional */
      }
      continue;
    }

    const armLife = applyArmLifecycleTimeout(w, now);
    if (armLife) {
      w.status = 'expired';
      w.updatedAt = now;
      w.lastReason = armLife;
      noteTrendFunnel('expired');
      try {
        const { noteProfileWatchFunnel } =
          require('./profileWatchRegistry') as typeof import('./profileWatchRegistry');
        noteProfileWatchFunnel('trend_rider', armLife);
      } catch {
        /* optional */
      }
      continue;
    }

    // Invalidate: MC collapsed under floor
    if (w.marketCapUsd != null && w.marketCapUsd < TREND_WATCH_MIN_MC_USD * 0.7) {
      w.status = 'invalidated';
      w.updatedAt = now;
      w.lastReason = 'MC under Trend floor';
      noteTrendFunnel('invalidated');
      try {
        const { clearOneSetupProfileLock } =
          require('./expectancyLift') as typeof import('./expectancyLift');
        clearOneSetupProfileLock(w.mint, 'invalidated');
      } catch {
        /* optional */
      }
      continue;
    }

    // Live tape: don't fire into collapsed volume
    if (
      w.status === 'armed' &&
      String(w.volumeDecayState || '') === 'collapsed'
    ) {
      w.lastReason = 'armed · waiting live tape';
      continue;
    }

    if (
      w.status === 'watching' &&
      (w.nearSupport === true ||
        w.nearKeyFib === true ||
        (w.dnaHits ?? 0) >= 4)
    ) {
      if (
        shouldSkipArmForCap('trend_rider', countArmedWatches(watches.values())) ||
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
      resetArmClockOnArm(w);
      w.lastReason = 'armed trend continuation';
      stampWatchPlan(w);
      stampTrendWatchEligibility(w);
      try {
        const { noteProfileWatchFunnel } =
          require('./profileWatchRegistry') as typeof import('./profileWatchRegistry');
        noteProfileWatchFunnel('trend_rider', 'armed');
      } catch {
        /* optional */
      }
      noteTrendFunnel('armed');
      }
    }

    if (w.status === 'watching') stampWatchingHoldReason(w);

    if (w.status === 'armed') {
      let reclaim = false;
      let lateChase = false;
      let nearLevel = false;
      let extensionFromLevelPct: number | null = null;
      try {
        const det = detectSupportReclaim({
          priceSol: px,
          supportPriceSol: w.supportPriceSol,
          nearSupport: w.nearSupport,
          nearKeyFib: w.nearKeyFib,
          reclaimTriggerPct: TRIGGER_RECLAIM_PCT,
          nearBandPct: 3.5,
          undercutBandPct: 1.5,
        });
        reclaim =
          det.reclaimed === true ||
          (det.nearLevel === true &&
            (w.nearSupport === true || w.nearKeyFib === true));
        lateChase = det.lateChase === true;
        nearLevel = det.nearLevel === true;
        extensionFromLevelPct = det.extensionFromLevelPct;
      } catch {
        reclaim =
          w.nearSupport === true ||
          w.nearKeyFib === true ||
          (w.dnaHits ?? 0) >= 4;
      }

      // Continuation confirm without level: DNA 4+ + live vol not collapsed
      if (
        !reclaim &&
        (w.dnaHits ?? 0) >= 4 &&
        String(w.volumeDecayState || '') !== 'collapsed'
      ) {
        reclaim = true;
      }

      if (reclaim) {
        try {
          const { prepareArmedWatchOpen } =
            require('./profileWatchRegistry') as typeof import('./profileWatchRegistry');
          const gate = prepareArmedWatchOpen({
            profileId: 'trend_rider',
            status: w.status,
            marketCapUsd: w.marketCapUsd,
            lateChase,
            extensionFromLevelPct,
            nearLevel,
            entry: w,
          });
          if (!gate.ok) {
            w.lastReason = gate.reason || 'trigger blocked';
            if (gate.action === 'expire') {
              w.status = 'expired';
              w.updatedAt = now;
              noteTrendFunnel('expired');
            }
            continue;
          }
        } catch {
          /* fail-open */
        }
        w.status = 'triggered';
        w.updatedAt = now;
        w.lastReason = 'triggered trend handoff';
        stampWatchPlan(w);
        noteTrendFunnel('triggered');
        try {
          const handoff = buildHandoff(w);
          await handOffScannerCandidate(handoff);
          handed += 1;
          console.log(`[trend-watch] TRIGGERED ${w.symbol} → trend_rider`);
        } catch (err) {
          w.status = 'armed';
          w.lastReason =
            'handoff failed: ' +
            (err instanceof Error ? err.message : String(err));
          console.warn(`[trend-watch] handoff failed ${w.symbol}:`, err);
        }
        try {
          const { clearOneSetupProfileLock } =
            require('./expectancyLift') as typeof import('./expectancyLift');
          clearOneSetupProfileLock(w.mint, 'triggered');
        } catch {
          /* optional */
        }
      }
    }
  }
  return handed;
}

export function getTrendSetupWatchStatus(limit = 16): {
  active: number;
  entries: TrendWatchEntry[];
  recentTerminal: TrendWatchEntry[];
  funnel: ReturnType<typeof getTrendFunnelCounters>;
} {
  pruneTerminal();
  const now = Date.now();
  const active = [...watches.values()]
    .filter(isActiveWatch)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
  const terminal = [...watches.values()]
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
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 4);
  return {
    active: active.length,
    entries: active,
    recentTerminal: terminal,
    funnel: getTrendFunnelCounters(),
  };
}

export function isMintOnActiveTrendWatch(mint: string): boolean {
  const w = watches.get(String(mint || '').trim());
  return w != null && isActiveWatch(w);
}

export function getActiveTrendWatch(mint: string): TrendWatchEntry | undefined {
  const w = watches.get(String(mint || '').trim());
  return w != null && isActiveWatch(w) ? w : undefined;
}

export function getTrendWatchByMint(mint: string): TrendWatchEntry | undefined {
  return watches.get(String(mint || '').trim());
}

/**
 * Expire an active Trend watch so Dip/Steady can park the mint.
 * No unwatch cooldown (bots may re-admit Trend later if DNA wins).
 */
export function expireTrendWatchForDipAdmit(
  mint: string,
  reason = 'Yielded to Dip/Steady park'
): boolean {
  const key = String(mint || '').trim();
  if (!key) return false;
  const w = watches.get(key);
  if (!w || !isActiveWatch(w)) return false;
  const now = Date.now();
  w.status = 'expired';
  w.updatedAt = now;
  w.lastReason = reason;
  noteTrendFunnel('expired');
  noteTrendFunnel('trend_expired_by_dip_admit');
  try {
    const { clearOneSetupProfileLock } =
      require('./expectancyLift') as typeof import('./expectancyLift');
    clearOneSetupProfileLock(key, 'expired');
  } catch {
    /* optional */
  }
  console.log(
    `[trend-watch] EXPIRE→Dip ${w.symbol || key.slice(0, 8)}… · ${reason}`
  );
  return true;
}

export function unwatchTrendSetup(mint: string): {
  ok: boolean;
  cooldownMs?: number;
} {
  const key = String(mint || '').trim();
  if (!key) return { ok: false };
  const existing = watches.get(key);
  watches.delete(key);
  lastMcRefreshAt.delete(key);
  unwatchCooldownUntil.set(key, Date.now() + UNWATCH_COOLDOWN_MS);
  try {
    const { clearOneSetupProfileLock } =
      require('./expectancyLift') as typeof import('./expectancyLift');
    clearOneSetupProfileLock(key, 'unwatch');
  } catch {
    /* optional */
  }
  console.log(
    `[trend-watch] UNWATCH ${existing?.symbol || key.slice(0, 8)}… · cooldown 15m`
  );
  return { ok: true, cooldownMs: UNWATCH_COOLDOWN_MS };
}

export function offerTrendWatchFromCandidate(c: {
  mint: string;
  symbol: string;
  name?: string;
  marketCapUsd?: number;
  volumeH1Usd?: number;
  volumeM5Usd?: number;
  volumeH6Usd?: number;
  holderCount?: number;
  holderGrowthPct?: number | null;
  priceChangeH1Pct?: number | null;
  priceChangePct?: number | null;
  nearKeyFib?: boolean;
  nearSupport?: boolean;
  lastPriceSol?: number | null;
  supportPriceSol?: number | null;
  kolCount?: number;
  specialtyFeed?: string;
  chartPatternIds?: string[];
  volumeDecayState?: string | null;
}): boolean {
  try {
    const { noteWatchInsertAttempt } =
      require('./watchPipeline') as typeof import('./watchPipeline');
    noteWatchInsertAttempt();
  } catch {
    /* optional */
  }
  let decay = c.volumeDecayState ?? null;
  if (!decay && (c.volumeM5Usd != null || c.volumeH1Usd != null)) {
    try {
      const { evaluateVolumeIntelligence } =
        require('./volumeIntelligence') as typeof import('./volumeIntelligence');
      decay =
        evaluateVolumeIntelligence({
          volumeM5Usd: c.volumeM5Usd,
          volumeH1Usd: c.volumeH1Usd,
          profileId: 'trend_rider',
        }).decayState ?? null;
    } catch {
      /* optional */
    }
  }
  const row = considerTrendWatchSetup({
    mint: c.mint,
    symbol: c.symbol,
    name: c.name,
    marketCapUsd: c.marketCapUsd,
    volumeH1Usd: c.volumeH1Usd,
    volumeM5Usd: c.volumeM5Usd,
    volumeH6Usd: c.volumeH6Usd,
    holderCount: c.holderCount,
    holderGrowthPct: c.holderGrowthPct,
    priceChangeH1Pct: c.priceChangeH1Pct,
    priceChangePct: c.priceChangePct,
    nearKeyFib: c.nearKeyFib,
    nearSupport: c.nearSupport,
    lastPriceSol: c.lastPriceSol ?? null,
    supportPriceSol: c.supportPriceSol ?? null,
    kolCount: c.kolCount,
    specialtyFeed: c.specialtyFeed,
    source: c.specialtyFeed || 'scanner',
    chartPatternIds: c.chartPatternIds,
    volumeDecayState: decay,
  });
  if (!row) {
    try {
      const { noteWatchInsertReject } =
        require('./watchPipeline') as typeof import('./watchPipeline');
      noteWatchInsertReject(lastTrendAdmitReject || 'admit_failed');
    } catch {
      /* optional */
    }
  }
  return row != null;
}
