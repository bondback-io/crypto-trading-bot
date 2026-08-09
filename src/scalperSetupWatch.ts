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
  /** Phase A stamps — pass through trigger without rediscovery */
  entryStyle?: string;
  qualityScore?: number | null;
  sizePlanSol?: number | null;
}

const MAX_WATCHES = 24;
const DEFAULT_TTL_MS = 3 * 60 * 60_000; // 3h
const TRIGGER_RECLAIM_PCT = 0.9;
const UNWATCH_COOLDOWN_MS = 15 * 60_000;
const MC_REFRESH_MIN_MS = 15_000;
const TERMINAL_UI_MS = 60_000;
/** Dip mutual exclusion is by active dip watch — Scalper owns mid-band up to 800k. */
const SCALPER_MC_MIN = 150_000;
const SCALPER_MC_MAX = 800_000;
/** Below this → Migration / Reversal own microcaps (not Scalper). */
const SCALPER_MICROCAP_BELOW = 150_000;

const watches = new Map<string, ScalperWatchEntry>();
const lastMcRefreshAt = new Map<string, number>();
const unwatchCooldownUntil = new Map<string, number>();

/** Rolling Mode B admit funnel (session counters). */
const modeBFunnel = {
  offered: 0,
  rejected_cooldown: 0,
  rejected_dip: 0,
  rejected_majors: 0,
  rejected_mc: 0,
  rejected_band: 0,
  rejected_no_targets: 0,
  rejected_min_rank: 0,
  watching: 0,
  armed: 0,
};

function noteModeBFunnel(
  key: keyof typeof modeBFunnel,
  n = 1
): void {
  modeBFunnel[key] = (modeBFunnel[key] || 0) + n;
}

/** Public funnel counter for scanner / diagnostics. */
export function noteModeBFunnelReject(
  key: 'rejected_min_rank' | 'rejected_no_targets',
  n = 1
): void {
  noteModeBFunnel(key, n);
}

export function getModeBFunnelCounters(): typeof modeBFunnel & {
  watchingNow: number;
  armedNow: number;
} {
  let watchingNow = 0;
  let armedNow = 0;
  for (const w of watches.values()) {
    if (w.status === 'watching') watchingNow += 1;
    if (w.status === 'armed') armedNow += 1;
  }
  return { ...modeBFunnel, watchingNow, armedNow };
}

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

/** Stage 0–1: do not stamp Scalper from MC-band alone — reclaim only. */
function scalperStrictRecovery(): boolean {
  try {
    const {
      isFastProfileRecovering,
      getProfileRecoveryStage,
    } = require('./fastProfileRecovery') as typeof import('./fastProfileRecovery');
    if (!isFastProfileRecovering('scalper')) return false;
    return getProfileRecoveryStage('scalper') <= 1;
  } catch {
    return false;
  }
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
  const atReclaim = atSupportReclaimSetup(input);
  const strictRec = scalperStrictRecovery();

  if (
    input.honorExplicitPrefer !== false &&
    (pref === 'scalper' ||
      pref === 'momentum_burst' ||
      pref === 'reversal_scalper')
  ) {
    const mcEarly = input.marketCapUsd ?? 0;
    // Never keep sticky Scalper prefer on microcaps
    if (pref === 'scalper' && mcEarly > 0 && mcEarly < SCALPER_MICROCAP_BELOW) {
      /* fall through to microcap / playbook routing */
    } else {
      // Re-route mid-air MB stamps toward Scalper only at true reclaim in mid-band
      if (
        pref !== 'scalper' &&
        atReclaim &&
        mcEarly >= SCALPER_MC_MIN &&
        !isReversalDominant(input) &&
        !isMomentumBurstDominant(input)
      ) {
        return 'scalper';
      }
      // Drop sticky Scalper prefer mid-air while Stage 0–1 recovering.
      if (!(pref === 'scalper' && strictRec && !atReclaim)) {
        return pref as ScalperFamilyProfileId;
      }
    }
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

  // True support reclaim in Scalper mid-band → Scalper.
  // Microcap (<150k) → Reversal (or MB); never stamp Scalper from MC alone.
  const mc = input.marketCapUsd ?? 0;
  if (mc > 0 && mc < SCALPER_MICROCAP_BELOW) {
    if (isReversalDominant(input)) {
      try {
        if (
          (require('./config') as typeof import('./config')).config.tradeProfiles
            ?.profiles?.reversal_scalper !== false
        ) {
          return 'reversal_scalper';
        }
      } catch {
        /* fall through */
      }
    }
    return 'momentum_burst';
  }
  if (atReclaim && mc >= SCALPER_MC_MIN && mc <= SCALPER_MC_MAX) {
    return 'scalper';
  }
  if (
    !strictRec &&
    mc >= SCALPER_MC_MIN &&
    mc <= SCALPER_MC_MAX
  ) {
    return 'scalper';
  }
  return 'momentum_burst';
}

function stampWatchPlan(w: ScalperWatchEntry): void {
  const q =
    w.srConfluenceScore != null && Number.isFinite(Number(w.srConfluenceScore))
      ? Number(w.srConfluenceScore)
      : w.nearMultiTfSupport
        ? 75
        : w.nearSupport
          ? 55
          : 40;
  w.qualityScore = q;
  if (
    w.preferredProfileId === 'scalper' &&
    (w.nearMultiTfSupport || w.nearSupport)
  ) {
    w.entryStyle = 'scalp_reclaim_burst';
  } else if (w.preferredProfileId === 'reversal_scalper') {
    w.entryStyle = 'reversal_reclaim';
  } else if (w.preferredProfileId === 'momentum_burst') {
    w.entryStyle = 'level_momentum_expansion';
  } else {
    w.entryStyle = w.entryStyle || 'scalp_reclaim_burst';
  }
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
  nearKeyFib?: boolean;
}): ScalperWatchEntry | null {
  if (!isScalperFamilyEnabled()) return null;
  if (!input.mint) return null;
  if (isManualUnwatchCooldown(input.mint)) {
    noteModeBFunnel('rejected_cooldown');
    return null;
  }
  if (isMintOnActiveDipWatch(input.mint)) {
    noteModeBFunnel('rejected_dip');
    return null;
  }

  // Never route high-MC majors into Scalper Mode B
  if (String(input.source || '').toLowerCase() === 'majors') {
    noteModeBFunnel('rejected_majors');
    return null;
  }

  const mc = input.marketCapUsd;
  // Above Scalper mid-band ceiling — leave to Dip / quality lanes
  if (mc != null && mc > 0 && mc > SCALPER_MC_MAX) {
    noteModeBFunnel('rejected_mc');
    return null;
  }

  const midBand =
    mc != null && mc > 0 && mc >= SCALPER_MC_MIN && mc <= SCALPER_MC_MAX;
  const microcap = mc != null && mc > 0 && mc < SCALPER_MICROCAP_BELOW;
  const chg = input.priceChangeH1Pct ?? input.priceChangePct ?? 0;
  const mbOrReversal =
    chg >= 10 ||
    chg <= -8 ||
    /momentum|burst|reversal|dip_reclaim|break/i.test(
      String(input.playbook || '')
    );
  const hasTargets =
    (input.supportPriceSol != null && input.supportPriceSol > 0) ||
    (Array.isArray(input.supportTfHits) && input.supportTfHits.length > 0) ||
    input.nearSupport === true ||
    input.nearKeyFib === true ||
    (input.srConfluenceScore != null && Number(input.srConfluenceScore) >= 40);
  // Mid-band always parks (S/R resolved on tick). Microcap needs motion or levels.
  if (midBand) {
    /* admit */
  } else if (microcap && (mbOrReversal || hasTargets)) {
    /* admit */
  } else if (mbOrReversal && hasTargets) {
    /* admit */
  } else {
    if (!hasTargets) noteModeBFunnel('rejected_no_targets');
    else noteModeBFunnel('rejected_band');
    return null;
  }

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
    noteModeBFunnel('offered');
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
  if (nearArmed) stampWatchPlan(entry);
  watches.set(input.mint, entry);
  noteModeBFunnel('offered');
  console.log(
    `[scalper-watch] ${entry.status.toUpperCase()} ${entry.symbol} ` +
      `→ ${preferred} MC=${mc != null ? `$${Math.round(mc)}` : '?'} ` +
      `hits=${(input.supportTfHits || []).join(',') || '—'}`
  );
  if (nearArmed) {
    try {
      const { recordSetupWatchEvent } =
        require('./setupWatchEvents') as typeof import('./setupWatchEvents');
      recordSetupWatchEvent({
        kind: 'armed',
        family: 'scalper',
        mint: entry.mint,
        symbol: entry.symbol,
        profileId: preferred,
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
      'armedWatch',
      w.nearMultiTfSupport
        ? 'mtf-S conf'
        : w.nearSupport
          ? 'near support'
          : 'reclaim',
      reclaimPrefer
        ? 'scalp_reclaim_burst'
        : w.entryStyle || `profile:${w.preferredProfileId}`,
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
    srConfluenceScore: w.srConfluenceScore ?? w.qualityScore ?? undefined,
    supportTfHits: w.supportTfHits,
    resistanceTfHits: w.resistanceTfHits,
    supportPriceSol: w.supportPriceSol ?? null,
    resistancePriceSol: w.resistancePriceSol ?? null,
    lastPriceSol: w.lastPriceSol ?? null,
    candleSource: 'synthetic',
    armedWatch: true,
    entryStyleHint: w.entryStyle,
    qualityScoreHint: w.qualityScore ?? undefined,
    sizePlanSol: w.sizePlanSol ?? undefined,
    setupWatchFamily: 'scalper',
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
      try {
        const { clearOneSetupProfileLock } =
          require('./expectancyLift') as typeof import('./expectancyLift');
        clearOneSetupProfileLock(w.mint, 'invalidated');
      } catch {
        /* optional */
      }
      continue;
    }

    if (now >= w.expiresAt) {
      w.status = 'expired';
      w.updatedAt = now;
      w.lastReason = 'TTL expired';
      console.log(`[scalper-watch] EXPIRED ${w.symbol}`);
      try {
        const {
          recordSetupWatchEvent,
          noteSetupWatchExpiredUnused,
        } = require('./setupWatchEvents') as typeof import('./setupWatchEvents');
        noteSetupWatchExpiredUnused(w.mint);
        recordSetupWatchEvent({
          kind: 'watch_expired',
          family: 'scalper',
          mint: w.mint,
          symbol: w.symbol,
          profileId: w.preferredProfileId,
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
    w.targetEntries = buildTargetEntries(w);

    // Invalidate: graduated past Scalper mid-band ceiling
    if (w.marketCapUsd != null && w.marketCapUsd > SCALPER_MC_MAX) {
      w.status = 'invalidated';
      w.updatedAt = now;
      w.lastReason = 'MC > Scalper mid-band';
      console.log(`[scalper-watch] INVALIDATED ${w.symbol} — ${w.lastReason}`);
      try {
        const { clearOneSetupProfileLock } =
          require('./expectancyLift') as typeof import('./expectancyLift');
        clearOneSetupProfileLock(w.mint, 'invalidated');
      } catch {
        /* optional */
      }
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
      try {
        const { clearOneSetupProfileLock } =
          require('./expectancyLift') as typeof import('./expectancyLift');
        clearOneSetupProfileLock(w.mint, 'invalidated');
      } catch {
        /* optional */
      }
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
      stampWatchPlan(w);
      try {
        const { recordSetupWatchEvent } =
          require('./setupWatchEvents') as typeof import('./setupWatchEvents');
        recordSetupWatchEvent({
          kind: 'armed',
          family: 'scalper',
          mint: w.mint,
          symbol: w.symbol,
          profileId: w.preferredProfileId,
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
      let volumeHint = false;
      try {
        const volM5 = Number(w.volumeM5Usd);
        volumeHint = Number.isFinite(volM5) && volM5 > 0;
        const det = detectSupportReclaim({
          priceSol: px,
          supportPriceSol: w.supportPriceSol,
          mtfSupportPriceSol: w.supportPriceSol,
          nearSupport: w.nearSupport,
          nearMultiTfSupport: w.nearMultiTfSupport,
          reclaimTriggerPct: TRIGGER_RECLAIM_PCT,
          momentumStyle: w.preferredProfileId === 'momentum_burst',
          volumeConfirm: volumeHint,
        });
        reclaim = det.reclaimed === true;
        undercut = det.undercut === true;
        nearLevel = det.nearLevel === true;
        extensionFromLevelPct = det.extensionFromLevelPct;
        if (det.nearLevel) {
          w.nearSupport = true;
        }
        // Track touch/undercut so a failed bounce without reclaim does not fire
        if (undercut || nearLevel) {
          (w as { touchedLevel?: boolean }).touchedLevel = true;
        }
        // Touch-and-fail: deeper 1.8% undercut; disabled when openRate < 0.20
        // Admission Baseline v235: skip reject (keep reclaim % confirm)
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
              family: 'scalper',
              mint: w.mint,
              symbol: w.symbol,
              profileId: w.preferredProfileId,
              reason: 'touch-and-fail reject',
            });
          } catch {
            /* optional */
          }
          continue;
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
      // Prefer reclaim after touch/undercut; confluence hold only if still at level
      const holdOk =
        nearConfluence &&
        w.nearSupport !== false &&
        (undercut || nearLevel) &&
        !((w as { touchedLevel?: boolean }).touchedLevel && !reclaim && extensionFromLevelPct != null && extensionFromLevelPct > 6);
      const trigger = reclaim || (holdOk && (undercut || nearLevel));
      if (!trigger) continue;

      // Pre-vetted armed reclaim — bypass scanner mint cooldown (anti-spam is for discretionary offers)
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
      stampWatchPlan(w);
      w.lastReason = reclaim ? 'reclaim trigger' : 'confluence hold';
      const c = buildHandoff(w);
      if (handOffScannerCandidate(c, { bypassCooldown: true })) {
        w.status = 'triggered';
        w.updatedAt = now;
        handed += 1;
        try {
          const { recordSetupWatchEvent } =
            require('./setupWatchEvents') as typeof import('./setupWatchEvents');
          recordSetupWatchEvent({
            kind: 'triggered',
            family: 'scalper',
            mint: w.mint,
            symbol: w.symbol,
            profileId: w.preferredProfileId,
            reason: w.lastReason,
            qualityScore: w.qualityScore,
            entryStyle: w.entryStyle,
          });
        } catch {
          /* optional */
        }
        try {
          const { clearOneSetupProfileLock } =
            require('./expectancyLift') as typeof import('./expectancyLift');
          clearOneSetupProfileLock(w.mint, 'triggered');
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
            family: 'scalper',
            mint: w.mint,
            symbol: w.symbol,
            profileId: w.preferredProfileId,
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
  try {
    const { clearOneSetupProfileLock } =
      require('./expectancyLift') as typeof import('./expectancyLift');
    clearOneSetupProfileLock(key, 'unwatch');
  } catch {
    /* optional */
  }
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
    active: all.filter(
      (e) => e.status === 'watching' || e.status === 'armed'
    ).length,
    entries,
    recentTerminal,
  };
}

/** Offer scanner candidates into the scalper-family watchlist. Returns true if parked. */
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
}): boolean {
  const row = considerScalperWatchSetup({
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
    nearKeyFib: c.nearKeyFib,
  });
  return row != null;
}
