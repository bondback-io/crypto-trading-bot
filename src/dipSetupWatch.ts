/**
 * Dip Buyer pre-entry watchlist: watch → arm → trigger → expire / invalidate.
 * Hands triggered setups into the Market Scanner handler with preferredProfileId.
 */

import type { LaunchEvent } from './marketData';
import { fetchLiveTokenSnapshot } from './marketData';
import {
  handOffScannerCandidate,
  isScannerMintOnCooldown,
  type ScannerCandidate,
} from './marketScanner';
import { isStrategyEnabled } from './strategies';
import {
  isSmartBotProfilesEnabled,
  resolveTradeProfileDefinition,
} from './tradeProfiles';

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
  /** Fib / Support → approx MC at reclaim entry */
  targetDipEntries?: DipTargetEntry[];
}

const MAX_WATCHES = 24;
const DEFAULT_TTL_MS = 4 * 60 * 60_000; // 4h
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
  if (!isStrategyEnabled('ta_market_scanner')) return false;
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
  // Cap active watches
  const active = [...watches.values()]
    .filter((w) => w.status === 'watching' || w.status === 'armed')
    .sort((a, b) => a.createdAt - b.createdAt);
  while (active.length > MAX_WATCHES) {
    const oldest = active.shift();
    if (!oldest) break;
    watches.delete(oldest.mint);
    lastMcRefreshAt.delete(oldest.mint);
  }
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
}): DipWatchEntry | null {
  if (!isDipProfileEnabled()) return null;
  if (!input.mint) return null;
  if (isManualUnwatchCooldown(input.mint)) return null;

  const m = dipMatch();
  const minMc = m.minMarketCapUsd ?? 500_000;
  const minHolders = m.minHolders ?? 80;
  const minVol = m.minVolumeH1Usd ?? 8_000;
  const minDrop = m.minDropFromPeakPct ?? 8;
  const maxDrop = m.maxDropFromPeakPct ?? 45;
  const maxMcBand = m.maxMarketCapUsd;

  pruneTerminal();
  const existing = watches.get(input.mint);
  if (
    existing &&
    (existing.status === 'watching' || existing.status === 'armed')
  ) {
    // Already admitted — refresh metrics even if MC dipped under admit floor
    existing.updatedAt = Date.now();
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
    existing.targetDipEntries = buildTargetDipEntries(existing);
    return existing;
  }

  const mc = input.marketCapUsd;
  try {
    const { isUpgradeEnabled } =
      require('./upgrades/registry') as typeof import('./upgrades/registry');
    const { majorsDipWatchAllows } =
      require('./upgrades/packs/majorsDipWatch') as typeof import('./upgrades/packs/majorsDipWatch');
    if (majorsDipWatchAllows({ marketCapUsd: mc, source: input.source })) {
      // majors pack: skip low-MC floor (high-MC names)
    } else if (isUpgradeEnabled('expectancy_entry_skill') && (mc == null || mc <= 0)) {
      // unknown MC soft-pass
    } else if (mc != null && mc > 0 && mc < minMc) {
      return null;
    }
    if (
      isUpgradeEnabled('microbot_mc_bands') &&
      maxMcBand != null &&
      maxMcBand > 0 &&
      mc != null &&
      mc > maxMcBand
    ) {
      return null;
    }
  } catch {
    if (mc != null && mc > 0 && mc < minMc) return null;
  }
  if (
    input.holderCount != null &&
    input.holderCount > 0 &&
    input.holderCount < minHolders
  ) {
    return null;
  }
  if (
    input.volumeH1Usd != null &&
    input.volumeH1Usd > 0 &&
    input.volumeH1Usd < minVol
  ) {
    return null;
  }

  const drop = input.dropFromPeakPct;
  let nearTa = input.nearKeyFib === true || input.nearSupport === true;
  let hybrid = false;
  try {
    const { isUpgradeEnabled } =
      require('./upgrades/registry') as typeof import('./upgrades/registry');
    if (isUpgradeEnabled('scalper_mode_b') && input.nearSupport === true) {
      nearTa = true;
    }
    hybrid = isUpgradeEnabled('hybrid_admission');
    if (isUpgradeEnabled('watch_arm_ownership')) {
      for (const w of watches.values()) {
        if (
          (w.status === 'watching' || w.status === 'armed') &&
          Date.now() - w.createdAt > 20 * 60_000
        ) {
          w.status = 'expired';
          w.lastReason = 'arm_timeout';
          w.updatedAt = Date.now();
        }
      }
    }
  } catch {
    /* core path */
  }
  const dropStarted = drop != null && drop >= Math.min(5, minDrop);
  // Need early dip signal OR Fib/S proximity on established token
  if (!dropStarted && !nearTa) return null;
  if (drop != null && drop > maxDrop) return null;

  const now = Date.now();
  const armNow = hybrid ? nearTa : nearTa && dropStarted;
  let ttlMs = DEFAULT_TTL_MS;
  try {
    const { isUpgradeEnabled } =
      require('./upgrades/registry') as typeof import('./upgrades/registry');
    if (
      isUpgradeEnabled('steady_hwr_majors') &&
      mc != null &&
      mc >= 100_000_000
    ) {
      ttlMs = Math.max(ttlMs, 6 * 60 * 60_000);
    }
  } catch {
    /* core */
  }
  const entry: DipWatchEntry = {
    mint: input.mint,
    symbol: input.symbol || input.mint.slice(0, 6),
    name: input.name || input.symbol || 'Dip watch',
    status: armNow ? 'armed' : 'watching',
    createdAt: now,
    updatedAt: now,
    armedAt: armNow ? now : null,
    expiresAt: now + ttlMs,
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
    source: input.source,
    lastReason: nearTa ? 'near Fib/S' : 'watching for setup',
  };
  entry.targetDipEntries = buildTargetDipEntries(entry);
  watches.set(input.mint, entry);
  console.log(
    `[dip-watch] ${entry.status.toUpperCase()} ${entry.symbol} ` +
      `MC=${mc != null ? `$${Math.round(mc)}` : '?'} drop=${drop != null ? `${drop.toFixed(0)}%` : '?'}`
  );
  return entry;
}

function buildHandoff(w: DipWatchEntry): ScannerCandidate & { launch: LaunchEvent } {
  const now = Date.now();
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
    source: 'kolscan',
    candleSource: 'synthetic',
    preferredProfileId: 'dip_buyer',
    specialtyFeed: 'kolscan',
  };
  return {
    id: `dip-watch-${w.mint.slice(0, 8)}-${now}`,
    mint: w.mint,
    symbol: w.symbol,
    name: w.name,
    timestamp: now,
    status: 'seen',
    rankScore: 88,
    reasons: [
      'dip-watch:triggered',
      w.nearKeyFib ? 'near Fib' : w.nearSupport ? 'near support' : 'reclaim',
      w.dropFromPeakPct != null
        ? `drop ${w.dropFromPeakPct.toFixed(0)}%`
        : 'setup',
    ],
    source: 'kolscan',
    migrated: true,
    marketCapUsd: w.marketCapUsd,
    volumeH1Usd: w.volumeH1Usd,
    holderCount: w.holderCount,
    preferredProfileId: 'dip_buyer',
    specialtyFeed: 'kolscan',
    kolCount: w.kolCount,
    nearKeyFib: w.nearKeyFib,
    nearSupport: w.nearSupport,
    candleSource: 'synthetic',
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
      console.log(`[dip-watch] ARMED ${w.symbol}`);
    }

    if (w.status === 'armed') {
      // Trigger: bounce reclaim or still near Fib/S with drop in band
      let reclaim = false;
      if (
        w.supportPriceSol != null &&
        w.supportPriceSol > 0 &&
        px != null &&
        px >= w.supportPriceSol * (1 + TRIGGER_RECLAIM_PCT / 100)
      ) {
        reclaim = true;
      }
      const trigger =
        reclaim ||
        (nearTa && dropOk) ||
        (dropOk && (w.kolCount ?? 0) >= (m.minKolWallets ?? 3));

      if (!trigger) continue;
      if (isScannerMintOnCooldown(w.mint)) {
        w.lastReason = 'cooldown';
        continue;
      }

      w.status = 'triggered';
      w.updatedAt = now;
      w.lastReason = reclaim ? 'reclaim trigger' : 'setup trigger';
      const c = buildHandoff(w);
      if (handOffScannerCandidate(c)) {
        handed += 1;
        console.log(
          `[dip-watch] TRIGGERED ${w.symbol} → dip_buyer (${w.lastReason})`
        );
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

export function getDipSetupWatchStatus(limit = 20): {
  active: number;
  entries: DipWatchEntry[];
  recentTerminal: DipWatchEntry[];
} {
  pruneTerminal();
  const now = Date.now();
  const all = [...watches.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const e of all) {
    e.targetDipEntries = buildTargetDipEntries(e);
  }
  const entries = all.slice(0, limit);
  const recentTerminal = all
    .filter(
      (e) =>
        (e.status === 'triggered' ||
          e.status === 'expired' ||
          e.status === 'invalidated') &&
        now - e.updatedAt <= TERMINAL_UI_MS
    )
    .slice(0, 4);
  return {
    active: entries.filter(
      (e) => e.status === 'watching' || e.status === 'armed'
    ).length,
    entries,
    recentTerminal,
  };
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
}): void {
  if (
    c.preferredProfileId &&
    c.preferredProfileId !== 'dip_buyer' &&
    c.specialtyFeed !== 'kolscan' &&
    c.specialtyFeed !== 'jupiter'
  ) {
    // Still allow organic mature tokens from any specialty feed
  }
  const drop =
    c.priceChangeH1Pct != null && c.priceChangeH1Pct < -1
      ? Math.abs(c.priceChangeH1Pct)
      : null;
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
    source: c.specialtyFeed || 'scanner',
  });
}
