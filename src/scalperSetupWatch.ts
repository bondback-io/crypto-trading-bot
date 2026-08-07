/**
 * Scalper-family pre-entry watchlist (Mode B): watch → arm → trigger → expire / invalidate.
 * Parallel to Dip / Migration watches — does NOT hang on dipSetupWatch.
 * Hands triggered setups into Market Scanner with preferredProfileId in
 * {scalper, momentum_burst, reversal_scalper}.
 */

import type { LaunchEvent } from './marketData';
import { fetchLiveTokenSnapshot, fetchMultiTfOhlcv } from './marketData';
import {
  handOffScannerCandidate,
  isScannerMintOnCooldown,
  type ScannerCandidate,
} from './marketScanner';
import { isStrategyEnabledGlobal } from './strategies';
import {
  isSmartBotProfilesEnabled,
  resolveTradeProfileDefinition,
} from './tradeProfiles';
import {
  analyzeSrConfluenceFromCandles,
  type SrTimeframe,
} from './technicalLevels';
import { isMintOnActiveDipWatch } from './dipSetupWatch';
import { detectSupportReclaim } from './supportReclaim';

export type ScalperWatchStatus =
  | 'watching'
  | 'armed'
  | 'triggered'
  | 'expired'
  | 'invalidated';

export type ScalperFamilyProfileId =
  | 'scalper'
  | 'momentum_burst'
  | 'reversal_scalper';

export interface ScalperTargetEntry {
  label: string;
  priceSol: number;
  mcUsd: number;
}

export interface ScalperWatchEntry {
  mint: string;
  symbol: string;
  name: string;
  status: ScalperWatchStatus;
  createdAt: number;
  updatedAt: number;
  armedAt: number | null;
  expiresAt: number;
  preferredProfileId: ScalperFamilyProfileId;
  marketCapUsd?: number;
  volumeH1Usd?: number;
  volumeM5Usd?: number;
  holderCount?: number;
  lastPriceSol?: number | null;
  supportPriceSol?: number | null;
  resistancePriceSol?: number | null;
  nearSupport?: boolean;
  nearMultiTfSupport?: boolean;
  nearMultiTfResistance?: boolean;
  srConfluenceScore?: number;
  supportTfHits?: SrTimeframe[];
  resistanceTfHits?: SrTimeframe[];
  lastReason?: string;
  source?: string;
  targetEntries?: ScalperTargetEntry[];
}

const MAX_WATCHES = 24;
const DEFAULT_TTL_MS = 3 * 60 * 60_000; // 3h
const TRIGGER_RECLAIM_PCT = 1.2;
const UNWATCH_COOLDOWN_MS = 15 * 60_000;
const MC_REFRESH_MIN_MS = 15_000;
const TERMINAL_UI_MS = 60_000;
/** Stay below dip_buyer floor so we never fight Dip for the same mint. */
const DIP_FLOOR_MC = 500_000;
const SCALPER_MC_MAX = 180_000;

const watches = new Map<string, ScalperWatchEntry>();
const lastMcRefreshAt = new Map<string, number>();
const unwatchCooldownUntil = new Map<string, number>();

function isManualUnwatchCooldown(mint: string): boolean {
  const until = unwatchCooldownUntil.get(mint) ?? 0;
  if (until <= Date.now()) {
    if (until > 0) unwatchCooldownUntil.delete(mint);
    return false;
  }
  return true;
}

function isScalperFamilyEnabled(): boolean {
  if (!isSmartBotProfilesEnabled()) return false;
  if (!isStrategyEnabledGlobal('ta_market_scanner')) return false;
  const { config } = require('./config') as typeof import('./config');
  if (config.tradeProfiles?.enabled === false) return false;
  const p = config.tradeProfiles?.profiles;
  return (
    p?.scalper !== false ||
    p?.momentum_burst !== false ||
    p?.reversal_scalper !== false
  );
}

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

function buildTargetEntries(w: {
  marketCapUsd?: number;
  lastPriceSol?: number | null;
  supportPriceSol?: number | null;
  resistancePriceSol?: number | null;
}): ScalperTargetEntry[] {
  const out: ScalperTargetEntry[] = [];
  const push = (label: string, priceSol: number | null | undefined) => {
    const mc = mcAtPrice(w.marketCapUsd, w.lastPriceSol, priceSol);
    if (mc == null || priceSol == null) return;
    if (
      out.some(
        (e) =>
          Math.abs(e.priceSol - priceSol) / Math.max(e.priceSol, 1e-18) < 0.005
      )
    ) {
      return;
    }
    out.push({ label, priceSol, mcUsd: mc });
  };
  push('Support', w.supportPriceSol);
  push('Resistance', w.resistancePriceSol);
  return out;
}

function isReversalDominant(input: {
  playbook?: string;
  chartPatternIds?: string[];
  priceChangePct?: number;
  priceChangeH1Pct?: number;
}): boolean {
  const pb = String(input.playbook || '').toLowerCase();
  const pats = (input.chartPatternIds || []).join(' ').toLowerCase();
  const chg = input.priceChangeH1Pct ?? input.priceChangePct ?? 0;
  // Wick / reversal playbooks or deep dump + reclaim patterns dominate Scalper.
  if (
    pb.includes('reversal') ||
    pb.includes('wick') ||
    pb.includes('dip_reclaim') ||
    /hammer|shooting.?star|pin.?bar|wedge|double.?bottom|rsi/.test(pats)
  ) {
    return true;
  }
  return chg <= -12;
}

function isMomentumBurstDominant(input: {
  playbook?: string;
  chartPatternIds?: string[];
  priceChangePct?: number;
  priceChangeH1Pct?: number;
  volumeM5Usd?: number;
  nearSupport?: boolean;
  nearMultiTfSupport?: boolean;
  supportTfHits?: SrTimeframe[];
}): boolean {
  const pb = String(input.playbook || '').toLowerCase();
  const pats = (input.chartPatternIds || []).join(' ').toLowerCase();
  const chg = input.priceChangeH1Pct ?? input.priceChangePct ?? 0;
  const volM5 = input.volumeM5Usd ?? 0;
  const atSupport =
    input.nearMultiTfSupport === true ||
    input.nearSupport === true ||
    (Array.isArray(input.supportTfHits) && input.supportTfHits.length >= 2);
  // Volume-expansion / breakout mid-air — MB owns; at support Scalper reclaim wins.
  if (atSupport && chg < 22) return false;
  if (
    pb.includes('momentum') ||
    pb.includes('burst') ||
    pb.includes('break') ||
    /bull.?flag|volume.?expansion|breakout/.test(pats)
  ) {
    return chg >= 10 || volM5 >= 2_500;
  }
  return chg >= 18 || (chg >= 12 && volM5 >= 3_000 && !atSupport);
}

function atSupportReclaimSetup(input: {
  nearSupport?: boolean;
  nearMultiTfSupport?: boolean;
  supportTfHits?: SrTimeframe[];
  supportPriceSol?: number | null;
}): boolean {
  if (input.nearMultiTfSupport === true || input.nearSupport === true) {
    return true;
  }
  if (Array.isArray(input.supportTfHits) && input.supportTfHits.length >= 1) {
    return true;
  }
  return (
    input.supportPriceSol != null &&
    Number.isFinite(input.supportPriceSol) &&
    Number(input.supportPriceSol) > 0
  );
}

function pickPreferredProfile(input: {
  marketCapUsd?: number;
  volumeM5Usd?: number;
  priceChangePct?: number;
  priceChangeH1Pct?: number;
  playbook?: string;
  chartPatternIds?: string[];
  preferredProfileId?: string;
  nearSupport?: boolean;
  nearMultiTfSupport?: boolean;
  supportTfHits?: SrTimeframe[];
  supportPriceSol?: number | null;
  /** When true, honor explicit preferredProfileId from caller */
  honorExplicitPrefer?: boolean;
}): ScalperFamilyProfileId {
  const pref = String(input.preferredProfileId || '');
  if (
    input.honorExplicitPrefer !== false &&
    (pref === 'scalper' ||
      pref === 'momentum_burst' ||
      pref === 'reversal_scalper')
  ) {
    // Still re-route mid-air MB stamps toward Scalper when armed at support.
    if (
      pref !== 'scalper' &&
      atSupportReclaimSetup(input) &&
      !isReversalDominant(input) &&
      !isMomentumBurstDominant(input)
    ) {
      return 'scalper';
    }
    return pref as ScalperFamilyProfileId;
  }

  if (isReversalDominant(input)) {
    try {
      if (
        resolveTradeProfileDefinition('reversal_scalper') &&
        (require('./config') as typeof import('./config')).config.tradeProfiles
          ?.profiles?.reversal_scalper !== false
      ) {
        return 'reversal_scalper';
      }
    } catch {
      /* fall through */
    }
  }

  if (isMomentumBurstDominant(input)) {
    return 'momentum_burst';
  }

  // Default Mode B bias: small-MC at / near support → Scalper reclaim.
  const mc = input.marketCapUsd ?? 0;
  if (
    atSupportReclaimSetup(input) ||
    (mc > 0 && mc <= SCALPER_MC_MAX)
  ) {
    return 'scalper';
  }
  return 'momentum_burst';
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

async function refreshWatchMarket(
  w: ScalperWatchEntry,
  now: number
): Promise<void> {
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
    }
  } catch {
    /* keep last */
  }
  // Refresh multi-TF S/R confluence
  try {
    const multi = await fetchMultiTfOhlcv(w.mint, {
      solUsd: undefined,
    });
    if (Object.keys(multi.byTf).length > 0) {
      const conf = analyzeSrConfluenceFromCandles(w.mint, multi.byTf, {
        priceSol: w.lastPriceSol,
      });
      w.srConfluenceScore = conf.confluenceScore;
      w.supportTfHits = conf.supportTfHits;
      w.resistanceTfHits = conf.resistanceTfHits;
      w.nearMultiTfSupport = conf.nearMultiTfSupport;
      w.nearMultiTfResistance = conf.nearMultiTfResistance;
      w.nearSupport = conf.supportTfHits.length > 0;
      if (conf.primarySupport != null && conf.primarySupport > 0) {
        w.supportPriceSol = conf.primarySupport;
      }
      if (conf.primaryResistance != null && conf.primaryResistance > 0) {
        w.resistancePriceSol = conf.primaryResistance;
      }
    }
  } catch {
    /* keep last confluence */
  }
}

export function isMintOnActiveScalperWatch(mint: string): boolean {
  const w = watches.get(String(mint || '').trim());
  return w != null && (w.status === 'watching' || w.status === 'armed');
}

/**
 * Consider a candidate for the scalper-family watchlist (Mode B).
 */
export function considerScalperWatchSetup(input: {
  mint: string;
  symbol: string;
  name?: string;
  marketCapUsd?: number;
  volumeH1Usd?: number;
  volumeM5Usd?: number;
  holderCount?: number;
  lastPriceSol?: number | null;
  supportPriceSol?: number | null;
  resistancePriceSol?: number | null;
  nearSupport?: boolean;
  nearMultiTfSupport?: boolean;
  nearMultiTfResistance?: boolean;
  srConfluenceScore?: number;
  supportTfHits?: SrTimeframe[];
  resistanceTfHits?: SrTimeframe[];
  priceChangePct?: number;
  priceChangeH1Pct?: number;
  playbook?: string;
  chartPatternIds?: string[];
  preferredProfileId?: string;
  source?: string;
}): ScalperWatchEntry | null {
  if (!isScalperFamilyEnabled()) return null;
  if (!input.mint) return null;
  if (isManualUnwatchCooldown(input.mint)) return null;
  if (isMintOnActiveDipWatch(input.mint)) return null;

  // Never route high-MC majors into Scalper Mode B
  if (String(input.source || '').toLowerCase() === 'majors') return null;

  const mc = input.marketCapUsd;
  // Mutual exclusion with Dip: only admit below dip floor
  if (mc != null && mc > 0 && mc >= DIP_FLOOR_MC) return null;

  const scalperBand = mc != null && mc > 0 && mc <= SCALPER_MC_MAX;
  const chg = input.priceChangeH1Pct ?? input.priceChangePct ?? 0;
  const mbOrReversal =
    chg >= 10 ||
    chg <= -8 ||
    /momentum|burst|reversal|dip_reclaim|break/i.test(
      String(input.playbook || '')
    );
  if (!scalperBand && !mbOrReversal) return null;

  const hasTargets =
    (input.supportPriceSol != null && input.supportPriceSol > 0) ||
    (Array.isArray(input.supportTfHits) && input.supportTfHits.length > 0);
  if (!hasTargets) return null;

  pruneTerminal();
  const existing = watches.get(input.mint);
  if (
    existing &&
    (existing.status === 'watching' || existing.status === 'armed')
  ) {
    existing.updatedAt = Date.now();
    existing.marketCapUsd = input.marketCapUsd ?? existing.marketCapUsd;
    existing.volumeH1Usd = input.volumeH1Usd ?? existing.volumeH1Usd;
    existing.volumeM5Usd = input.volumeM5Usd ?? existing.volumeM5Usd;
    existing.holderCount = input.holderCount ?? existing.holderCount;
    existing.lastPriceSol = input.lastPriceSol ?? existing.lastPriceSol;
    existing.supportPriceSol =
      input.supportPriceSol ?? existing.supportPriceSol;
    existing.resistancePriceSol =
      input.resistancePriceSol ?? existing.resistancePriceSol;
    existing.nearSupport = input.nearSupport ?? existing.nearSupport;
    existing.nearMultiTfSupport =
      input.nearMultiTfSupport ?? existing.nearMultiTfSupport;
    existing.nearMultiTfResistance =
      input.nearMultiTfResistance ?? existing.nearMultiTfResistance;
    existing.srConfluenceScore =
      input.srConfluenceScore ?? existing.srConfluenceScore;
    existing.supportTfHits = input.supportTfHits ?? existing.supportTfHits;
    existing.resistanceTfHits =
      input.resistanceTfHits ?? existing.resistanceTfHits;
    // Soft re-prefer Scalper when armed / reclaiming at support
    const nextPref = pickPreferredProfile({
      ...input,
      marketCapUsd: existing.marketCapUsd,
      volumeM5Usd: existing.volumeM5Usd,
      nearSupport: existing.nearSupport,
      nearMultiTfSupport: existing.nearMultiTfSupport,
      supportTfHits: existing.supportTfHits,
      supportPriceSol: existing.supportPriceSol,
      preferredProfileId: existing.preferredProfileId,
      honorExplicitPrefer: false,
    });
    if (nextPref !== existing.preferredProfileId) {
      existing.preferredProfileId = nextPref;
      existing.lastReason = `prefer ${nextPref} at support`;
    }
    existing.targetEntries = buildTargetEntries(existing);
    return existing;
  }

  // Already at confluence — enrich path should buy immediately; skip watch
  if (input.nearMultiTfSupport === true) return null;

  const now = Date.now();
  const nearArmed =
    (Array.isArray(input.supportTfHits) && input.supportTfHits.length >= 2) ||
    input.nearSupport === true;
  const preferred = pickPreferredProfile(input);
  const entry: ScalperWatchEntry = {
    mint: input.mint,
    symbol: input.symbol || input.mint.slice(0, 6),
    name: input.name || input.symbol || 'Scalper watch',
    status: nearArmed ? 'armed' : 'watching',
    createdAt: now,
    updatedAt: now,
    armedAt: nearArmed ? now : null,
    expiresAt: now + DEFAULT_TTL_MS,
    preferredProfileId: preferred,
    marketCapUsd: mc,
    volumeH1Usd: input.volumeH1Usd,
    volumeM5Usd: input.volumeM5Usd,
    holderCount: input.holderCount,
    lastPriceSol: input.lastPriceSol ?? null,
    supportPriceSol: input.supportPriceSol ?? null,
    resistancePriceSol: input.resistancePriceSol ?? null,
    nearSupport: input.nearSupport,
    nearMultiTfSupport: input.nearMultiTfSupport,
    nearMultiTfResistance: input.nearMultiTfResistance,
    srConfluenceScore: input.srConfluenceScore,
    supportTfHits: input.supportTfHits,
    resistanceTfHits: input.resistanceTfHits,
    source: input.source,
    lastReason: nearArmed ? 'near multi-TF support' : 'watching for S/R',
  };
  entry.targetEntries = buildTargetEntries(entry);
  watches.set(input.mint, entry);
  console.log(
    `[scalper-watch] ${entry.status.toUpperCase()} ${entry.symbol} ` +
      `→ ${preferred} MC=${mc != null ? `$${Math.round(mc)}` : '?'} ` +
      `hits=${(input.supportTfHits || []).join(',') || '—'}`
  );
  return entry;
}

function buildHandoff(
  w: ScalperWatchEntry
): ScannerCandidate & { launch: LaunchEvent } {
  const now = Date.now();
  const launch: LaunchEvent = {
    mint: w.mint,
    symbol: w.symbol,
    name: w.name,
    launchedAt: w.createdAt,
    migrated: false,
    entryPriceSol: w.lastPriceSol || 0,
    lastPriceSol: w.lastPriceSol || 0,
    priceChangePct: 0,
    marketCapUsd: w.marketCapUsd,
    volumeH1Usd: w.volumeH1Usd,
    volumeM5Usd: w.volumeM5Usd,
    volumeUsd: w.volumeH1Usd,
    holderCount: w.holderCount,
    candles: [],
    source: 'dexscreener',
    candleSource: 'synthetic',
    preferredProfileId: w.preferredProfileId,
  };
  const reclaimPrefer =
    w.preferredProfileId === 'scalper' &&
    (w.nearMultiTfSupport === true ||
      w.nearSupport === true ||
      (Array.isArray(w.supportTfHits) && w.supportTfHits.length >= 2));
  return {
    id: `scalper-watch-${w.mint.slice(0, 8)}-${now}`,
    mint: w.mint,
    symbol: w.symbol,
    name: w.name,
    timestamp: now,
    status: 'seen',
    rankScore: reclaimPrefer ? 92 : 86,
    reasons: [
      'scalper-watch:triggered',
      w.nearMultiTfSupport
        ? 'mtf-S conf'
        : w.nearSupport
          ? 'near support'
          : 'reclaim',
      reclaimPrefer ? 'scalp_reclaim_burst' : `profile:${w.preferredProfileId}`,
      `profile:${w.preferredProfileId}`,
      w.supportTfHits?.length
        ? `hits:${w.supportTfHits.join('+')}`
        : 'setup',
    ],
    source: 'dexscreener',
    migrated: false,
    marketCapUsd: w.marketCapUsd,
    volumeH1Usd: w.volumeH1Usd,
    volumeM5Usd: w.volumeM5Usd,
    holderCount: w.holderCount,
    preferredProfileId: w.preferredProfileId,
    nearKeyFib: false,
    nearSupport: w.nearSupport ?? w.nearMultiTfSupport,
    nearResistance: w.nearMultiTfResistance,
    nearMultiTfSupport: w.nearMultiTfSupport,
    nearMultiTfResistance: w.nearMultiTfResistance,
    srConfluenceScore: w.srConfluenceScore,
    supportTfHits: w.supportTfHits,
    resistanceTfHits: w.resistanceTfHits,
    supportPriceSol: w.supportPriceSol ?? null,
    resistancePriceSol: w.resistancePriceSol ?? null,
    lastPriceSol: w.lastPriceSol ?? null,
    candleSource: 'synthetic',
    launch,
  };
}

/**
 * Tick watches: arm on multi-TF support, trigger on reclaim/hold, expire / invalidate.
 */
export async function tickScalperSetupWatches(opts?: {
  priceByMint?: Map<string, number>;
}): Promise<number> {
  if (!isScalperFamilyEnabled()) return 0;
  pruneTerminal();
  const now = Date.now();
  let handed = 0;

  for (const w of watches.values()) {
    if (w.status !== 'watching' && w.status !== 'armed') continue;

    if (isMintOnActiveDipWatch(w.mint)) {
      w.status = 'invalidated';
      w.updatedAt = now;
      w.lastReason = 'dip watch took mint';
      console.log(`[scalper-watch] INVALIDATED ${w.symbol} — dip watch`);
      continue;
    }

    if (now >= w.expiresAt) {
      w.status = 'expired';
      w.updatedAt = now;
      w.lastReason = 'TTL expired';
      console.log(`[scalper-watch] EXPIRED ${w.symbol}`);
      continue;
    }

    await refreshWatchMarket(w, now);

    const px = opts?.priceByMint?.get(w.mint) ?? w.lastPriceSol ?? null;
    if (px != null) w.lastPriceSol = px;
    w.targetEntries = buildTargetEntries(w);

    // Invalidate: graduated past dip floor or far above scalper band without MB signal
    if (w.marketCapUsd != null && w.marketCapUsd >= DIP_FLOOR_MC) {
      w.status = 'invalidated';
      w.updatedAt = now;
      w.lastReason = 'MC ≥ dip floor';
      console.log(`[scalper-watch] INVALIDATED ${w.symbol} — ${w.lastReason}`);
      continue;
    }

    // Support breach
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
      console.log(`[scalper-watch] INVALIDATED ${w.symbol} — support breach`);
      continue;
    }

    const nearConfluence =
      w.nearMultiTfSupport === true ||
      (Array.isArray(w.supportTfHits) && w.supportTfHits.length >= 2);

    if (w.status === 'watching' && nearConfluence) {
      w.status = 'armed';
      w.armedAt = now;
      w.updatedAt = now;
      w.lastReason = 'armed multi-TF support';
      // Armed at support → soft-prefer Scalper unless reversal wick / MB expansion dominate
      w.preferredProfileId = pickPreferredProfile({
        marketCapUsd: w.marketCapUsd,
        volumeM5Usd: w.volumeM5Usd,
        nearSupport: true,
        nearMultiTfSupport: w.nearMultiTfSupport,
        supportTfHits: w.supportTfHits,
        supportPriceSol: w.supportPriceSol,
        preferredProfileId: w.preferredProfileId,
        honorExplicitPrefer: false,
      });
      console.log(
        `[scalper-watch] ARMED ${w.symbol} → ${w.preferredProfileId}`
      );
    }

    if (w.status === 'armed') {
      // Shared reclaim detector (Scalper-family ~1.2%); fail soft if S/R missing
      let reclaim = false;
      try {
        const det = detectSupportReclaim({
          priceSol: px,
          supportPriceSol: w.supportPriceSol,
          mtfSupportPriceSol: w.supportPriceSol,
          nearSupport: w.nearSupport,
          nearMultiTfSupport: w.nearMultiTfSupport,
          reclaimTriggerPct: TRIGGER_RECLAIM_PCT,
          momentumStyle: w.preferredProfileId === 'momentum_burst',
        });
        reclaim = det.reclaimed === true;
        if (det.nearLevel) {
          w.nearSupport = true;
        }
      } catch {
        if (
          w.supportPriceSol != null &&
          w.supportPriceSol > 0 &&
          px != null &&
          px >= w.supportPriceSol * (1 + TRIGGER_RECLAIM_PCT / 100)
        ) {
          reclaim = true;
        }
      }
      const holdOk = nearConfluence && w.nearSupport !== false;
      const trigger = reclaim || holdOk;
      if (!trigger) continue;
      if (isScannerMintOnCooldown(w.mint)) {
        w.lastReason = 'cooldown';
        continue;
      }

      // Reclaim / hold at support → prefer Scalper handoff
      if (reclaim || holdOk) {
        w.preferredProfileId = pickPreferredProfile({
          marketCapUsd: w.marketCapUsd,
          volumeM5Usd: w.volumeM5Usd,
          nearSupport: true,
          nearMultiTfSupport: w.nearMultiTfSupport ?? nearConfluence,
          supportTfHits: w.supportTfHits,
          supportPriceSol: w.supportPriceSol,
          preferredProfileId: w.preferredProfileId,
          honorExplicitPrefer: false,
        });
      }

      w.status = 'triggered';
      w.updatedAt = now;
      w.lastReason = reclaim ? 'reclaim trigger' : 'confluence hold';
      const c = buildHandoff(w);
      if (handOffScannerCandidate(c)) {
        handed += 1;
        console.log(
          `[scalper-watch] TRIGGERED ${w.symbol} → ${w.preferredProfileId} (${w.lastReason})`
        );
      }
    }
  }

  return handed;
}

export function unwatchScalperSetup(mint: string): {
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
    `[scalper-watch] UNWATCH ${existing?.symbol || key.slice(0, 8)}… · cooldown 15m`
  );
  return { ok: true, cooldownMs: UNWATCH_COOLDOWN_MS };
}

export function getScalperSetupWatchStatus(limit = 20): {
  active: number;
  entries: ScalperWatchEntry[];
  recentTerminal: ScalperWatchEntry[];
} {
  pruneTerminal();
  const now = Date.now();
  const all = [...watches.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const e of all) {
    e.targetEntries = buildTargetEntries(e);
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

/** Offer scanner candidates into the scalper-family watchlist (non-blocking). */
export function offerScalperWatchFromCandidate(c: {
  mint: string;
  symbol: string;
  name?: string;
  marketCapUsd?: number;
  volumeH1Usd?: number;
  volumeM5Usd?: number;
  holderCount?: number;
  priceChangeH1Pct?: number;
  priceChangePct?: number;
  nearKeyFib?: boolean;
  nearSupport?: boolean;
  nearMultiTfSupport?: boolean;
  nearMultiTfResistance?: boolean;
  srConfluenceScore?: number;
  supportTfHits?: SrTimeframe[];
  resistanceTfHits?: SrTimeframe[];
  lastPriceSol?: number | null;
  supportPriceSol?: number | null;
  resistancePriceSol?: number | null;
  playbook?: string;
  chartPatternIds?: string[];
  preferredProfileId?: string;
  specialtyFeed?: string;
}): void {
  considerScalperWatchSetup({
    mint: c.mint,
    symbol: c.symbol,
    name: c.name,
    marketCapUsd: c.marketCapUsd,
    volumeH1Usd: c.volumeH1Usd,
    volumeM5Usd: c.volumeM5Usd,
    holderCount: c.holderCount,
    lastPriceSol: c.lastPriceSol ?? null,
    supportPriceSol: c.supportPriceSol ?? null,
    resistancePriceSol: c.resistancePriceSol ?? null,
    nearSupport: c.nearSupport,
    nearMultiTfSupport: c.nearMultiTfSupport,
    nearMultiTfResistance: c.nearMultiTfResistance,
    srConfluenceScore: c.srConfluenceScore,
    supportTfHits: c.supportTfHits,
    resistanceTfHits: c.resistanceTfHits,
    priceChangePct: c.priceChangePct,
    priceChangeH1Pct: c.priceChangeH1Pct,
    playbook: c.playbook,
    chartPatternIds: c.chartPatternIds,
    preferredProfileId: c.preferredProfileId,
    source: c.specialtyFeed || 'scanner',
  });
}
