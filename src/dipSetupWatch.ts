/**
 * Dip Buyer pre-entry watchlist: watch → arm → trigger → expire / invalidate.
 * Hands triggered setups into the Market Scanner handler with preferredProfileId.
 */

import type { LaunchEvent } from './marketData';
import { fetchLiveTokenSnapshot } from './marketData';
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
  /** Soft MC band when source is majors ($100M / $250M / $500M / $1B+) */
  majorsBand?: string;
  /** Fib / Support → approx MC at reclaim entry */
  targetDipEntries?: DipTargetEntry[];
  /** Phase A stamps — pass through trigger without rediscovery */
  entryStyle?: string;
  qualityScore?: number | null;
  sizePlanSol?: number | null;
}

/**
 * Separate caps so majors (liberal admit + 10h TTL + frequent refresh)
 * cannot starve memecoin / scanner minors. Shared pool previously was 24
 * with majors CYCLE_CAP 18 + API slice-by-updatedAt → UI showed majors only.
 */
const MAX_MAJORS_WATCHES = 12;
const MAX_MINORS_WATCHES = 16;
const DEFAULT_TTL_MS = 4 * 60 * 60_000; // 4h
/** High-MC majors wait longer for Fib/S setups (8–12h band → 10h) */
const MAJORS_TTL_MS = 10 * 60 * 60_000;
const ARM_NEAR_DROP_MIN = 6;
const TRIGGER_RECLAIM_PCT = 1.5; // reclaim % off trough / bounce
/** Manual unwatch — bots may re-add only after this cooldown */
const UNWATCH_COOLDOWN_MS = 15 * 60_000;
const MC_REFRESH_MIN_MS = 15_000;
const TERMINAL_UI_MS = 60_000;

const watches = new Map<string, DipWatchEntry>();
let lastMcRefreshAt = new Map<string, number>();
/** mint → earliest time bots may re-add after manual unwatch */
const unwatchCooldownUntil = new Map<string, number>();

function isMajorsSource(source: string | undefined): boolean {
  return String(source || '').toLowerCase() === 'majors';
}

function isActiveWatch(w: DipWatchEntry): boolean {
  return w.status === 'watching' || w.status === 'armed';
}

function activeWatches(bucket: 'majors' | 'minors'): DipWatchEntry[] {
  return [...watches.values()]
    .filter((w) => {
      if (!isActiveWatch(w)) return false;
      const maj = isMajorsSource(w.source);
      return bucket === 'majors' ? maj : !maj;
    })
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Evict oldest within a bucket until at/under cap. */
function enforceBucketCap(bucket: 'majors' | 'minors', max: number): void {
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
function reserveAdmitSlot(isMajors: boolean): boolean {
  const bucket = isMajors ? 'majors' : 'minors';
  const max = isMajors ? MAX_MAJORS_WATCHES : MAX_MINORS_WATCHES;
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
  w.entryStyle = 'support_dip_reclaim';
  try {
    const { calculateDynamicPositionSize } =
      require('./risk') as typeof import('./risk');
    const { paperTrader } =
      require('./paperTrader') as typeof import('./paperTrader');
    const sizing = calculateDynamicPositionSize({
      equitySol: paperTrader.getEquitySol(),
      kind: 'normal',
      openCount: paperTrader.getOpenPositions().length,
      sizeMultiplier: 1,
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
  if (config.tradeProfiles?.profiles?.dip_buyer === false) return false;
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
  // Cap per bucket — never let majors eviction steal minor slots (or vice versa)
  enforceBucketCap('majors', MAX_MAJORS_WATCHES);
  enforceBucketCap('minors', MAX_MINORS_WATCHES);
}

async function refreshWatchMarket(w: DipWatchEntry, now: number): Promise<void> {
  const last = lastMcRefreshAt.get(w.mint) ?? 0;
  if (now - last < MC_REFRESH_MIN_MS) return;
  lastMcRefreshAt.set(w.mint, now);
  try {
    const snap = await fetchLiveTokenSnapshot(w.mint);
    if (!snap) return;
    if (snap.marketCapUsd != null && snap.marketCapUsd > 0) {
      w.marketCapUsd = snap.marketCapUsd;
    }
    if (snap.volumeH1Usd != null && snap.volumeH1Usd > 0) {
      w.volumeH1Usd = snap.volumeH1Usd;
    }
    if (snap.priceSol != null && snap.priceSol > 0) {
      w.lastPriceSol = snap.priceSol;
    }
  } catch {
    /* keep last */
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
}): DipWatchEntry | null {
  if (!isDipProfileEnabled()) return null;
  if (!input.mint) return null;
  if (isManualUnwatchCooldown(input.mint)) return null;
  try {
    const { isMintOnActiveScalperWatch } =
      require('./scalperSetupWatch') as typeof import('./scalperSetupWatch');
    if (isMintOnActiveScalperWatch(input.mint)) return null;
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

  pruneTerminal();
  const existing = watches.get(input.mint);
  if (existing && isActiveWatch(existing)) {
    // Already admitted — refresh metrics even if MC dipped under admit floor.
    // Do NOT bump updatedAt on bare majors re-offer — that starved the status
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
    if (isMajors) {
      existing.source = 'majors';
      existing.majorsBand = input.majorsBand ?? existing.majorsBand;
      // Keep majors TTL from sliding under 4h memecoin default on refresh
      const remain = existing.expiresAt - Date.now();
      if (remain < MAJORS_TTL_MS / 2) {
        existing.expiresAt = Date.now() + MAJORS_TTL_MS;
      }
    }
    if (dropChanged || taChanged || !isMajors) {
      existing.updatedAt = Date.now();
    }
    existing.targetDipEntries = buildTargetDipEntries(existing);
    return existing;
  }

  const mc = input.marketCapUsd;
  if (mc != null && mc > 0 && mc < minMc) return null;
  if (
    !isMajors &&
    input.holderCount != null &&
    input.holderCount > 0 &&
    input.holderCount < minHolders
  ) {
    return null;
  }
  if (
    !isMajors &&
    input.volumeH1Usd != null &&
    input.volumeH1Usd > 0 &&
    input.volumeH1Usd < minVol
  ) {
    return null;
  }

  const drop = input.dropFromPeakPct;
  const nearTa = input.nearKeyFib === true || input.nearSupport === true;
  const dropStarted = drop != null && drop >= Math.min(5, minDrop);
  // Majors: admit to watching without force-buy when S/R thin (arm later).
  // Memecoins: need early dip signal OR Fib/S proximity.
  if (!isMajors && !dropStarted && !nearTa) return null;
  if (drop != null && drop > maxDrop) return null;

  reserveAdmitSlot(isMajors);

  const now = Date.now();
  const armed = nearTa && dropStarted;
  const entry: DipWatchEntry = {
    mint: input.mint,
    symbol: input.symbol || input.mint.slice(0, 6),
    name: input.name || input.symbol || 'Dip watch',
    status: armed ? 'armed' : 'watching',
    createdAt: now,
    updatedAt: now,
    armedAt: armed ? now : null,
    expiresAt: now + (isMajors ? MAJORS_TTL_MS : DEFAULT_TTL_MS),
    marketCapUsd: mc,
    volumeH1Usd: input.volumeH1Usd,
    holderCount: input.holderCount,
    dropFromPeakPct: drop,
    nearKeyFib: input.nearKeyFib,
    nearSupport: input.nearSupport,
    supportPriceSol: input.supportPriceSol ?? null,
    lastPriceSol: input.lastPriceSol ?? null,
    fib05PriceSol: input.fib05PriceSol ?? null,
    fib618PriceSol: input.fib618PriceSol ?? null,
    kolCount: input.kolCount,
    source: isMajors ? 'majors' : input.source || 'scanner',
    majorsBand: isMajors ? input.majorsBand : undefined,
    lastReason: armed
      ? 'near Fib/S'
      : isMajors
        ? 'majors watch'
        : 'watching for setup',
  };
  entry.targetDipEntries = buildTargetDipEntries(entry);
  if (armed) stampWatchPlan(entry);
  watches.set(input.mint, entry);
  console.log(
    `[dip-watch] ${entry.status.toUpperCase()} ${entry.symbol}` +
      (isMajors ? ` [majors${entry.majorsBand ? `:${entry.majorsBand}` : ''}]` : '') +
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
        profileId: 'dip_buyer',
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
  const isMajors = String(w.source || '').toLowerCase() === 'majors';
  // Soft prefer Dip Buyer; Steady/Trend/HWR still compete via lane fight.
  // Never stamp Scalper — majors stay on quality lanes only.
  const feed = isMajors ? 'majors' : 'kolscan';
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
    source: isMajors ? 'jupiter' : 'kolscan',
    candleSource: 'synthetic',
    preferredProfileId: 'dip_buyer',
    specialtyFeed: feed,
  };
  return {
    id: `dip-watch-${w.mint.slice(0, 8)}-${now}`,
    mint: w.mint,
    symbol: w.symbol,
    name: w.name,
    timestamp: now,
    status: 'seen',
    rankScore: isMajors ? 90 : 88,
    reasons: [
      'dip-watch:triggered',
      'armedWatch',
      ...(isMajors
        ? [`majors${w.majorsBand ? `:${w.majorsBand}` : ''}`]
        : []),
      w.nearKeyFib ? 'near Fib' : w.nearSupport ? 'near support' : 'reclaim',
      w.entryStyle || 'support_dip_reclaim',
      w.dropFromPeakPct != null
        ? `drop ${w.dropFromPeakPct.toFixed(0)}%`
        : 'setup',
    ],
    source: isMajors ? 'jupiter' : 'kolscan',
    migrated: true,
    marketCapUsd: w.marketCapUsd,
    volumeH1Usd: w.volumeH1Usd,
    holderCount: w.holderCount,
    preferredProfileId: 'dip_buyer',
    specialtyFeed: feed,
    kolCount: w.kolCount,
    nearKeyFib: w.nearKeyFib,
    nearSupport: w.nearSupport,
    candleSource: 'synthetic',
    armedWatch: true,
    entryStyleHint: w.entryStyle || 'support_dip_reclaim',
    qualityScoreHint: w.qualityScore ?? undefined,
    sizePlanSol: w.sizePlanSol ?? undefined,
    setupWatchFamily: 'dip',
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
        const { recordSetupWatchEvent } =
          require('./setupWatchEvents') as typeof import('./setupWatchEvents');
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
      continue;
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
      continue;
    }

    const nearTa = w.nearKeyFib === true || w.nearSupport === true;
    const dropOk =
      w.dropFromPeakPct != null &&
      w.dropFromPeakPct >= Math.min(ARM_NEAR_DROP_MIN, minDrop) &&
      w.dropFromPeakPct <= maxDrop;

    if (w.status === 'watching' && nearTa && dropOk) {
      w.status = 'armed';
      w.armedAt = now;
      w.updatedAt = now;
      w.lastReason = 'armed near Fib/S';
      stampWatchPlan(w);
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
      // Shared reclaim detector (Dip ~1.5%); fail soft if S/R missing
      let reclaim = false;
      try {
        const det = detectSupportReclaim({
          priceSol: px,
          supportPriceSol: w.supportPriceSol,
          fib05PriceSol: w.fib05PriceSol,
          fib618PriceSol: w.fib618PriceSol,
          nearSupport: w.nearSupport,
          nearKeyFib: w.nearKeyFib,
          reclaimTriggerPct: TRIGGER_RECLAIM_PCT,
        });
        reclaim = det.reclaimed === true;
        if (det.nearLevel) {
          w.nearSupport = w.nearSupport || det.levelKind === 'support';
          w.nearKeyFib = w.nearKeyFib || det.levelKind === 'fib';
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
      const trigger =
        reclaim ||
        (nearTa && dropOk) ||
        (dropOk && (w.kolCount ?? 0) >= (m.minKolWallets ?? 3));

      if (!trigger) continue;

      stampWatchPlan(w);
      w.lastReason = reclaim ? 'reclaim trigger' : 'setup trigger';
      const c = buildHandoff(w);
      if (handOffScannerCandidate(c, { bypassCooldown: true })) {
        w.status = 'triggered';
        w.updatedAt = now;
        handed += 1;
        console.log(
          `[dip-watch] TRIGGERED ${w.symbol} → dip_buyer (${w.lastReason})`
        );
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
  console.log(
    `[dip-watch] UNWATCH ${existing?.symbol || key.slice(0, 8)}… · cooldown 15m`
  );
  return { ok: true, cooldownMs: UNWATCH_COOLDOWN_MS };
}

export function getDipSetupWatchStatus(limit = 32): {
  active: number;
  activeMajors: number;
  activeMinors: number;
  entries: DipWatchEntry[];
  recentTerminal: DipWatchEntry[];
} {
  pruneTerminal();
  const now = Date.now();
  const majorsActive = activeWatches('majors').sort(
    (a, b) => b.updatedAt - a.updatedAt
  );
  const minorsActive = activeWatches('minors').sort(
    (a, b) => b.updatedAt - a.updatedAt
  );
  // Interleave so a single limit never returns majors-only when minors exist
  const interleaved: DipWatchEntry[] = [];
  const maxMaj = Math.min(majorsActive.length, MAX_MAJORS_WATCHES);
  const maxMin = Math.min(minorsActive.length, MAX_MINORS_WATCHES);
  let i = 0;
  let j = 0;
  while (interleaved.length < limit && (i < maxMaj || j < maxMin)) {
    if (j < maxMin) interleaved.push(minorsActive[j++]);
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
    active: majorsActive.length + minorsActive.length,
    activeMajors: majorsActive.length,
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
    c.specialtyFeed !== 'kolscan' &&
    c.specialtyFeed !== 'jupiter' &&
    c.specialtyFeed !== 'majors'
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
  });
}
