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
  /** Soft MC band when source is medium/majors ($50M / $100M / $200M / $250M / $500M / $1B+) */
  majorsBand?: string;
  /** Soft prefer on handoff — dip_buyer default; medium/majors prefer steady_compounder */
  preferredProfileId?: string;
  /** Fib / Support → approx MC at reclaim entry */
  targetDipEntries?: DipTargetEntry[];
  /** Phase A stamps — pass through trigger without rediscovery */
  entryStyle?: string;
  qualityScore?: number | null;
  sizePlanSol?: number | null;
  /** Live peak price for drop-from-peak refresh */
  peakPriceSol?: number | null;
}

/**
 * Separate caps so majors/medium (liberal admit + 10h TTL + frequent refresh)
 * cannot starve memecoin / scanner minors. Medium ≤25 is its own bucket so
 * majors do not starve $50–200M Steady parks.
 */
const MAX_MAJORS_WATCHES = 25;
const MAX_MEDIUM_WATCHES = 25;
const MAX_MINORS_WATCHES = 16;
const DEFAULT_TTL_MS = 4 * 60 * 60_000; // 4h
/** High-MC majors/medium wait longer for Fib/S setups (8–12h band → 10h) */
const MAJORS_TTL_MS = 10 * 60 * 60_000;

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
  unwatch_cd: 0,
  no_levels_rotate: 0,
  vol_liq_mc: 0,
  at_cap: 0,
};

function noteDipFunnel(key: keyof typeof dipFunnel, n = 1): void {
  dipFunnel[key] = (dipFunnel[key] || 0) + n;
}

export function getDipFunnelCounters(): typeof dipFunnel & {
  watchingNow: number;
  armedNow: number;
} {
  let watchingNow = 0;
  let armedNow = 0;
  for (const w of watches.values()) {
    if (w.status === 'watching') watchingNow += 1;
    if (w.status === 'armed') armedNow += 1;
  }
  return { ...dipFunnel, watchingNow, armedNow };
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
    watches.delete(oldest.mint);
    lastMcRefreshAt.delete(oldest.mint);
  }
}

/**
 * True if a new admit for this bucket is allowed. When at cap, drop the
 * oldest same-bucket watch so fresh candidates can rotate in.
 */
function reserveAdmitSlot(bucket: DipWatchBucket): boolean {
  const max = bucketCap(bucket);
  const active = activeWatches(bucket);
  if (active.length < max) return true;
  const oldest = active[0];
  if (!oldest) return true;
  watches.delete(oldest.mint);
  lastMcRefreshAt.delete(oldest.mint);
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
  const preferSteady =
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
    const sizing = calculateDynamicPositionSize({
      equitySol: paperTrader.getEquitySol(),
      kind: 'normal',
      openCount: paperTrader.getOpenPositions().length,
      sizeMultiplier: preferSteady ? 0.85 : 1,
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
  // Minors need Dip; medium/majors may run on Steady alone
  if (
    config.tradeProfiles?.profiles?.dip_buyer === false &&
    config.tradeProfiles?.profiles?.steady_compounder === false
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
        watches.delete(mint);
        lastMcRefreshAt.delete(mint);
      }
    }
  }
  // Cap per bucket — never let majors/medium eviction steal minor slots
  enforceBucketCap('majors', MAX_MAJORS_WATCHES);
  enforceBucketCap('medium', MAX_MEDIUM_WATCHES);
  enforceBucketCap('minors', MAX_MINORS_WATCHES);
}

/**
 * Recompute nearKeyFib / nearSupport / level prices from stored Fib/S
 * (+ optional multi-TF) vs live price. Fail soft.
 */
function recomputeProximityFromLevels(w: DipWatchEntry): void {
  const px = w.lastPriceSol;
  if (px == null || !Number.isFinite(px) || px <= 0) return;
  try {
    const det = detectSupportReclaim({
      priceSol: px,
      supportPriceSol: w.supportPriceSol,
      fib05PriceSol: w.fib05PriceSol,
      fib618PriceSol: w.fib618PriceSol,
      nearSupport: w.nearSupport,
      nearKeyFib: w.nearKeyFib,
      reclaimTriggerPct: TRIGGER_RECLAIM_PCT,
      nearBandPct: 3.5,
      undercutBandPct: 1.5,
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
    const nearBand = 0.035;
    const undercut = 0.015;
    const nearPx = (level: number | null | undefined): boolean => {
      if (level == null || !Number.isFinite(level) || level <= 0) return false;
      const d = (px - level) / level;
      return d >= -undercut && d <= nearBand;
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

async function refreshWatchMarket(w: DipWatchEntry, now: number): Promise<void> {
  const last = lastMcRefreshAt.get(w.mint) ?? 0;
  if (now - last < MC_REFRESH_MIN_MS) return;
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
      if (conf.nearMultiTfSupport || (conf.supportTfHits?.length ?? 0) > 0) {
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

  const hasLevels =
    (w.fib05PriceSol != null && w.fib05PriceSol > 0) ||
    (w.fib618PriceSol != null && w.fib618PriceSol > 0) ||
    (w.supportPriceSol != null && w.supportPriceSol > 0) ||
    w.nearKeyFib === true ||
    w.nearSupport === true;
  if (!hasLevels) noteDipFunnel('no_levels');

  // Medium/Majors: time-gated no-levels rotate (~20m ticks ×4 ≈80m); skip MC≥$500M
  if (isQualityBandSource(w.source)) {
    try {
      const {
        noteMajorsLevelsPresence,
        clearMajorsNoLevelsStreak,
      } = require('./majorsUniverse') as typeof import('./majorsUniverse');
      if (hasLevels) {
        clearMajorsNoLevelsStreak(w.mint);
      } else {
        const { rotate, streak } = noteMajorsLevelsPresence(
          w.mint,
          false,
          w.marketCapUsd
        );
        if (rotate) {
          noteDipFunnel('no_levels_rotate');
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
}): DipWatchEntry | null {
  if (!isDipProfileEnabled()) return null;
  if (!input.mint) return null;
  if (isManualUnwatchCooldown(input.mint)) {
    noteDipFunnel('unwatch_cd');
    return null;
  }
  try {
    const { isMintOnActiveScalperWatch } =
      require('./scalperSetupWatch') as typeof import('./scalperSetupWatch');
    if (isMintOnActiveScalperWatch(input.mint)) {
      noteDipFunnel('mutual_exclude');
      return null;
    }
  } catch {
    /* optional */
  }
  try {
    const { isMintOnActiveTrendWatch } =
      require('./trendSetupWatch') as typeof import('./trendSetupWatch');
    if (isMintOnActiveTrendWatch(input.mint)) {
      noteDipFunnel('mutual_exclude');
      return null;
    }
  } catch {
    /* optional */
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
    noteDipFunnel('vol_liq_mc');
    return null;
  }
  if (
    !isQuality &&
    input.holderCount != null &&
    input.holderCount > 0 &&
    input.holderCount < minHolders
  ) {
    noteDipFunnel('vol_liq_mc');
    return null;
  }
  if (
    !isQuality &&
    input.volumeH1Usd != null &&
    input.volumeH1Usd > 0 &&
    input.volumeH1Usd < minVol
  ) {
    noteDipFunnel('vol_liq_mc');
    return null;
  }

  const drop = input.dropFromPeakPct;
  const nearTa = input.nearKeyFib === true || input.nearSupport === true;
  const dropStarted = drop != null && drop >= Math.min(5, minDrop);
  // Medium/Majors: admit to watching without force-buy when S/R thin (arm later).
  // Memecoins: need early dip signal OR Fib/S proximity.
  if (!isQuality && !dropStarted && !nearTa) {
    noteDipFunnel('vol_liq_mc');
    return null;
  }
  if (drop != null && drop > maxDrop) {
    noteDipFunnel('vol_liq_mc');
    return null;
  }

  const activeBefore = activeWatches(bucket).length;
  if (activeBefore >= bucketCap(bucket)) {
    noteDipFunnel('at_cap');
  }
  reserveAdmitSlot(bucket);

  const now = Date.now();
  // Arm on Fib/S proximity; drop is soft preference (not forever AND-gated)
  const armed = nearTa;
  const prefer =
    input.preferredProfileId ||
    (isQuality ? 'steady_compounder' : 'dip_buyer');
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
    preferredProfileId: prefer,
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
  if (armed) noteDipFunnel('armed');
  else noteDipFunnel('watching');
  console.log(
    `[dip-watch] ${entry.status.toUpperCase()} ${entry.symbol}` +
      (isQuality
        ? ` [${entry.source}${entry.majorsBand ? `:${entry.majorsBand}` : ''}]`
        : '') +
      ` MC=${mc != null ? `$${Math.round(mc)}` : '?'} drop=${drop != null ? `${drop.toFixed(0)}%` : '?'}`
  );
  if (armed) {
    try {
      const { recordSetupWatchEvent } =
        require('./setupWatchEvents') as typeof import('./setupWatchEvents');
      recordSetupWatchEvent({
        kind: 'armed',
        family: 'dip',
        mint: entry.mint,
        symbol: entry.symbol,
        profileId: prefer,
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

function buildHandoff(w: DipWatchEntry): ScannerCandidate & { launch: LaunchEvent } {
  const now = Date.now();
  const isMajors = isMajorsSource(w.source);
  const isMedium = isMediumSource(w.source);
  // Soft prefer: medium/majors stamp steady_compounder; Dip still competes on minors.
  // Never stamp Scalper — quality bands stay on Steady/Dip lanes only.
  const prefer =
    w.preferredProfileId === 'steady_compounder'
      ? 'steady_compounder'
      : 'dip_buyer';
  const feed = isMajors ? 'majors' : isMedium ? 'medium' : 'kolscan';
  const launch: LaunchEvent = {
    mint: w.mint,
    symbol: w.symbol,
    name: w.name,
    launchedAt: w.createdAt,
    migrated: true,
    entryPriceSol: w.lastPriceSol || 0,
    lastPriceSol: w.lastPriceSol || 0,
    priceChangePct: w.dropFromPeakPct != null ? -w.dropFromPeakPct : 0,
    marketCapUsd: w.marketCapUsd,
    volumeH1Usd: w.volumeH1Usd,
    volumeUsd: w.volumeH1Usd,
    holderCount: w.holderCount,
    candles: [],
    source: isMajors || isMedium ? 'jupiter' : 'kolscan',
    candleSource: 'synthetic',
    preferredProfileId: prefer,
    specialtyFeed: feed as 'jupiter' | 'kolscan' | 'alphascan' | 'majors' | 'medium',
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
          : []),
      prefer === 'steady_compounder' ? 'prefer:steady_compounder' : 'prefer:dip_buyer',
      w.nearKeyFib ? 'near Fib' : w.nearSupport ? 'near support' : 'reclaim',
      w.entryStyle ||
        (prefer === 'steady_compounder'
          ? 'quality_structure_reclaim'
          : 'support_dip_reclaim'),
      w.dropFromPeakPct != null
        ? `drop ${w.dropFromPeakPct.toFixed(0)}%`
        : 'setup',
    ],
    source: isMajors || isMedium ? 'jupiter' : 'kolscan',
    migrated: true,
    marketCapUsd: w.marketCapUsd,
    volumeH1Usd: w.volumeH1Usd,
    holderCount: w.holderCount,
    preferredProfileId: prefer,
    specialtyFeed: feed as 'jupiter' | 'kolscan' | 'alphascan' | 'majors' | 'medium',
    kolCount: w.kolCount,
    nearKeyFib: w.nearKeyFib,
    nearSupport: w.nearSupport,
    candleSource: 'synthetic',
    armedWatch: true,
    dipWatchTriggered: true,
    entryStyleHint:
      prefer === 'steady_compounder'
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
      w.status = 'expired';
      w.updatedAt = now;
      w.lastReason = 'TTL expired';
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

    // Arm on Fib/S proximity (near target band); drop is soft preference
    if (w.status === 'watching' && nearTa) {
      w.status = 'armed';
      w.armedAt = now;
      w.updatedAt = now;
      w.lastReason = dropOk ? 'armed near Fib/S + dip' : 'armed near Fib/S';
      stampWatchPlan(w);
      noteDipFunnel('armed');
      console.log(`[dip-watch] ARMED ${w.symbol}`);
      try {
        const { recordSetupWatchEvent } =
          require('./setupWatchEvents') as typeof import('./setupWatchEvents');
        recordSetupWatchEvent({
          kind: 'armed',
          family: 'dip',
          mint: w.mint,
          symbol: w.symbol,
          profileId: 'dip_buyer',
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
      if (handOffScannerCandidate(c, { bypassCooldown: true })) {
        w.status = 'triggered';
        w.updatedAt = now;
        handed += 1;
        noteDipFunnel('triggered');
        console.log(
          `[dip-watch] TRIGGERED ${w.symbol} → dip_buyer (${w.lastReason})`
        );
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
            profileId: 'dip_buyer',
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
    watches.delete(key);
  }
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
    `[dip-watch] UNWATCH ${existing?.symbol || key.slice(0, 8)}… · cooldown 15m`
  );
  return { ok: true, cooldownMs: UNWATCH_COOLDOWN_MS };
}

export function getDipSetupWatchStatus(limit = 32): {
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
  // Interleave so a single limit never returns one band only
  const interleaved: DipWatchEntry[] = [];
  const maxMaj = Math.min(majorsActive.length, MAX_MAJORS_WATCHES);
  const maxMed = Math.min(mediumActive.length, MAX_MEDIUM_WATCHES);
  const maxMin = Math.min(minorsActive.length, MAX_MINORS_WATCHES);
  let i = 0;
  let j = 0;
  let k = 0;
  while (
    interleaved.length < limit &&
    (i < maxMaj || j < maxMed || k < maxMin)
  ) {
    if (k < maxMin) interleaved.push(minorsActive[k++]);
    if (interleaved.length >= limit) break;
    if (j < maxMed) interleaved.push(mediumActive[j++]);
    if (interleaved.length >= limit) break;
    if (i < maxMaj) interleaved.push(majorsActive[i++]);
  }
  for (const e of interleaved) {
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
    entries: interleaved,
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
}): void {
  if (
    c.preferredProfileId &&
    c.preferredProfileId !== 'dip_buyer' &&
    c.preferredProfileId !== 'steady_compounder' &&
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
  considerDipWatchSetup({
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
  });
}
