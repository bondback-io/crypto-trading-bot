/**
 * Expectancy Lift Layer — expectancy-first governors, mix targets, permission score.
 * Additive / soft-reversible except late_chase share ceiling (hard 5%).
 * Fail soft everywhere — never block hard safety.
 */

import fs from 'fs';
import { dataFile, ensureDataDir, atomicWriteJson } from './dataDir';
import { paperTrader } from './paperTrader';
import {
  getProfileLearningEpisodes,
  type ProfileLearningEpisode,
} from './profileLearningEpisodes';
import { TRADE_PROFILE_CATALOG } from './tradeProfiles';

export const EXPECTANCY_LIFT_VERSION = 1;

export type ExpectancyWindow = 20 | 50 | 100;

export const EXPECTANCY_WINDOWS = [20, 50, 100] as const;
export const DEFAULT_EXPECTANCY_WINDOW: ExpectancyWindow = 50;

export type ExpectancyFamily =
  | 'scalp_reclaim_burst'
  | 'reversal_reclaim'
  | 'level_momentum_expansion'
  | 'migration_hold_reclaim'
  | 'support_dip_reclaim'
  | 'trend_pullback_continuation'
  | 'quality_structure_reclaim'
  | 'smart_money_confirm'
  | 'late_chase'
  | 'discretionary_other';

export const EXPECTANCY_FAMILIES: readonly ExpectancyFamily[] = [
  'scalp_reclaim_burst',
  'reversal_reclaim',
  'level_momentum_expansion',
  'migration_hold_reclaim',
  'support_dip_reclaim',
  'trend_pullback_continuation',
  'quality_structure_reclaim',
  'smart_money_confirm',
  'late_chase',
  'discretionary_other',
] as const;

export type FamilyGovernorState =
  | 'promoted'
  | 'neutral'
  | 'down_ranked'
  | 'restricted';

const MIN_SAMPLES = 18;
const LATE_CHASE_MAX_SHARE = 0.05;
const ARMED_SHARE_TARGET = 0.7;
const DISC_SHARE_CAP = 0.3;
const DISC_SHARE_CAP_RELIEF = 0.45;
const SCALPER_SHARE_TARGET = 0.3;
const LOSS_STREAK_N = 8;
const LOSS_STREAK_K = 5;
const PERM_FLOOR_DISC = 35;
const PERM_FLOOR_ARMED = 25;
const SIZE_MULT_LO = 0.7;
const SIZE_MULT_HI = 1.15;
const SCRATCH_PNL_PCT = 0.25;
const SCRATCH_PNL_SOL = 0.001;
const DISC_MIX_SIZE_PENALTY = 0.85;

const FILE = () => dataFile('expectancy-lift.json');

interface GovernorPersistRow {
  state: FamilyGovernorState;
  negWindows: number;
  tempRestrictUntilMs?: number;
  /** Fingerprint of last window that advanced negWindows / temp-restrict. */
  lastFingerprint?: string;
  updatedAt: number;
}

interface ExpectancyLiftPersist {
  version: number;
  governors: Record<string, GovernorPersistRow>;
  updatedAt: number;
  /** One-shot sticky restrict cleanup after poll-inflation bug (v1.2.238). */
  repairedV238?: boolean;
}

const FAST_DISC_PROFILES = new Set([
  'scalper',
  'momentum_burst',
  'reversal_scalper',
]);

let persistCache: ExpectancyLiftPersist | null = null;
const oneSetupLocks = new Map<string, { profileId: string; untilMs: number }>();

export interface ExpectancyTradeRow {
  profileId: string;
  family: ExpectancyFamily;
  closedAt: number;
  openedAt: number;
  holdMs: number;
  pnlPct: number;
  pnlSol: number;
  win: boolean;
  armed: boolean;
  lateChase: boolean;
  firstPartial: boolean;
  mfeCapturePct: number | null;
  maxRunupPct: number;
  trailActive: boolean;
  entryStyle?: string;
  key: string;
  /** Present when source episode/closed had an entryMarketCapUsd field. */
  hasEntryMcField?: boolean;
  entryMarketCapUsd?: number | null;
}

export interface ExpectancyMetrics {
  winRate: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  winLossRatio: number | null;
  expectancyPct: number | null;
  expectancySol: number | null;
  profitFactor: number | null;
  mfeCapturePct: number | null;
  avgHoldMs: number | null;
  tradeCount: number;
}

export interface ExpectancyMix {
  armedShare: number | null;
  discretionaryShare: number | null;
  lateChaseShare: number | null;
  scalperAttentionShare: number | null;
  firstPartialRate: number | null;
  avgMfeCapture: number | null;
}

export interface FamilyGovernorRow {
  family: ExpectancyFamily;
  state: FamilyGovernorState;
  metrics: ExpectancyMetrics;
  metricsAlt?: ExpectancyMetrics;
  negWindows: number;
  note: string;
}

export interface ProfileExpectancyRow {
  profileId: string;
  name: string;
  metrics: ExpectancyMetrics;
  armedShare: number | null;
  lateChaseShare: number | null;
  firstPartialRate: number | null;
  quiet?: boolean;
  quietReason?: string;
}

export interface ArmedFunnelRow {
  offered: number;
  armed: number;
  triggered: number;
  opened: number;
  blocked: number;
  openRatePct: number | null;
  armToTriggerMs: number | null;
}

export interface ExpectancyLiftStatus {
  ok: boolean;
  window: ExpectancyWindow;
  mix: ExpectancyMix;
  targets: {
    armedShare: number;
    lateChaseShareMax: number;
    scalperShareMax: number;
    discShareMax: number;
  };
  profiles: ProfileExpectancyRow[];
  families: FamilyGovernorRow[];
  funnel: ArmedFunnelRow;
  chart: {
    tradeIndex: number[];
    rollingExpectancyPct: number[];
    rollingWinRatePct: number[];
    cumulativePnlPct: number[];
  };
  quietChips: Array<{ profileId: string; label: string; reason: string }>;
  plainLanguage: string;
  /** Discretionary mix throttle state for dashboard chip. */
  discMixThrottle: {
    active: boolean;
    discShare: number | null;
    liveArmed: number;
    effectiveCap: number;
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

function emptyMetrics(): ExpectancyMetrics {
  return {
    winRate: null,
    avgWinPct: null,
    avgLossPct: null,
    winLossRatio: null,
    expectancyPct: null,
    expectancySol: null,
    profitFactor: null,
    mfeCapturePct: null,
    avgHoldMs: null,
    tradeCount: 0,
  };
}

/** Normalize legacy / alias family tags. Exact migration tag only — no broad /migration/. */
export function normalizeExpectancyFamily(
  raw: string | null | undefined
): ExpectancyFamily {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  if (s === 'momentum_continuation' || s === 'level_momentum_expansion') {
    return 'level_momentum_expansion';
  }
  if ((EXPECTANCY_FAMILIES as readonly string[]).includes(s)) {
    return s as ExpectancyFamily;
  }
  if (/late.?chase/.test(s)) return 'late_chase';
  if (/scalp.?reclaim/.test(s)) return 'scalp_reclaim_burst';
  if (/reversal.?reclaim/.test(s)) return 'reversal_reclaim';
  if (/support.?dip|dip.?reclaim/.test(s)) return 'support_dip_reclaim';
  if (/trend.?pullback|pullback.?cont/.test(s)) {
    return 'trend_pullback_continuation';
  }
  if (/quality.?structure/.test(s)) return 'quality_structure_reclaim';
  if (/smart.?money/.test(s)) return 'smart_money_confirm';
  return 'discretionary_other';
}

export function classifyTradeFamily(input: {
  entryStyle?: string | null;
  entryStyleSecondary?: string | null;
  lateChaseAtEntry?: boolean;
  profileId?: string | null;
  armedWatch?: boolean;
  entryPath?: string | null;
  setupWatchFamily?: string | null;
}): ExpectancyFamily {
  if (
    input.lateChaseAtEntry === true ||
    /late.?chase/i.test(String(input.entryStyle || '')) ||
    /late.?chase/i.test(String(input.entryStyleSecondary || ''))
  ) {
    return 'late_chase';
  }
  const rawStyle = String(input.entryStyle || '')
    .trim()
    .toLowerCase();
  // Exact migration hold/reclaim tag only
  if (rawStyle === 'migration_hold_reclaim') {
    return 'migration_hold_reclaim';
  }
  const style = normalizeExpectancyFamily(input.entryStyle);
  if (style !== 'discretionary_other' && style !== 'migration_hold_reclaim') {
    return style;
  }
  if (style === 'migration_hold_reclaim') {
    return 'migration_hold_reclaim';
  }

  const armed =
    input.armedWatch === true ||
    String(input.entryPath || '').toLowerCase() === 'armed_trigger';
  const setupFam = String(input.setupWatchFamily || '')
    .trim()
    .toLowerCase();
  const pid = String(input.profileId || '');

  // Armed grad / migration profile armed → migration_hold_reclaim
  if (
    setupFam === 'grad' &&
    (armed || String(input.entryPath || '').toLowerCase() === 'armed_trigger')
  ) {
    return 'migration_hold_reclaim';
  }
  if (
    (pid === 'migration_sniper' || pid === 'migration') &&
    armed
  ) {
    return 'migration_hold_reclaim';
  }
  // migration_sniper without style and not armed → discretionary_other
  if (pid === 'migration_sniper' || pid === 'migration') {
    return 'discretionary_other';
  }

  if (pid === 'scalper') return 'scalp_reclaim_burst';
  if (pid === 'reversal_scalper') return 'reversal_reclaim';
  if (pid === 'momentum_burst') return 'level_momentum_expansion';
  if (pid === 'dip_buyer') return 'support_dip_reclaim';
  if (pid === 'trend_rider') return 'trend_pullback_continuation';
  if (pid === 'high_win_rate' || pid === 'steady_compounder') {
    return 'quality_structure_reclaim';
  }
  if (pid === 'smart_money_mirror') return 'smart_money_confirm';
  return 'discretionary_other';
}

function tradeKey(t: {
  id?: string;
  mint?: string;
  openedAt?: number;
  closedAt?: number;
  pnlSol?: number;
}): string {
  if (t.id) return `id:${t.id}`;
  const mint = String(t.mint || '').slice(0, 32);
  const closed = Math.round(Number(t.closedAt) || 0);
  const opened = Math.round(Number(t.openedAt) || 0);
  const pnl = Number(t.pnlSol);
  const pnlR = Number.isFinite(pnl) ? pnl.toFixed(6) : '0';
  return `${mint}|${opened}|${closed}|${pnlR}`;
}

function mfeCaptureFrom(pnlPct: number, maxRunupPct: number): number | null {
  const mfe = Math.max(0, Number(maxRunupPct) || 0);
  if (!(mfe > 0)) return null;
  return clamp((Number(pnlPct) || 0) / mfe, -0.5, 1.5) * 100;
}

function readEntryMcStamp(src: Record<string, unknown> | object): {
  hasEntryMcField: boolean;
  entryMarketCapUsd: number | null;
} {
  const o = src as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(o, 'entryMarketCapUsd')) {
    return { hasEntryMcField: false, entryMarketCapUsd: null };
  }
  const v = Number(o.entryMarketCapUsd);
  return {
    hasEntryMcField: true,
    entryMarketCapUsd: Number.isFinite(v) && v > 0 ? v : null,
  };
}

function isScratchPnl(pnlPct: number, pnlSol: number): boolean {
  return (
    Math.abs(pnlPct) < SCRATCH_PNL_PCT && Math.abs(pnlSol) < SCRATCH_PNL_SOL
  );
}

function isFinitePnl(pnlPct: number, pnlSol: number): boolean {
  return Number.isFinite(pnlPct) && Number.isFinite(pnlSol);
}

/** Trades eligible for family governor metrics / loss streak. */
function filterGovernorWindowTrades(
  family: ExpectancyFamily,
  trades: ExpectancyTradeRow[]
): ExpectancyTradeRow[] {
  return trades.filter((t) => {
    if (!isFinitePnl(t.pnlPct, t.pnlSol)) return false;
    if (isScratchPnl(t.pnlPct, t.pnlSol)) return false;
    if (family === 'migration_hold_reclaim' && t.hasEntryMcField === true) {
      if (!(t.entryMarketCapUsd != null && t.entryMarketCapUsd > 0)) {
        return false;
      }
    }
    return true;
  });
}

function windowFingerprint(
  trades: ExpectancyTradeRow[],
  exp: number | null
): string {
  const last = trades.length ? trades[trades.length - 1]! : null;
  const lastClosedAt = last ? Math.round(last.closedAt) : 0;
  const expR =
    exp != null && Number.isFinite(exp) ? Math.round(exp * 100) / 100 : 0;
  return `${lastClosedAt}|${trades.length}|${expR}`;
}

function fromEpisode(e: ProfileLearningEpisode): ExpectancyTradeRow | null {
  const profileId = String(e.profileId || '').trim();
  if (!profileId || profileId === 'default') return null;
  if (/^partial:/i.test(String(e.exitReason || ''))) return null;
  const closedAt = Number(e.closedAt);
  if (!Number.isFinite(closedAt) || closedAt <= 0) return null;
  const pnlPct = Number(e.pnlPct);
  const pnlSol = Number(e.pnlSol);
  if (!isFinitePnl(pnlPct, pnlSol)) return null;
  const maxRunup = Math.max(0, Number(e.maxRunupPct) || 0);
  const cap =
    e.mfeCaptureRatio != null && Number.isFinite(Number(e.mfeCaptureRatio))
      ? clamp(Number(e.mfeCaptureRatio), -0.5, 1.5) * 100
      : mfeCaptureFrom(pnlPct, maxRunup);
  const armed =
    e.armedWatch === true ||
    e.entryPath === 'armed_trigger' ||
    e.scalperWatchTriggered === true;
  const mc = readEntryMcStamp(e as unknown as Record<string, unknown>);
  const setupWatchFamily = String(
    (e as { setupWatchFamily?: string }).setupWatchFamily || ''
  );
  return {
    profileId,
    family: classifyTradeFamily({
      entryStyle: e.entryStyle,
      entryStyleSecondary: e.entryStyleSecondary,
      lateChaseAtEntry: e.lateChaseAtEntry,
      profileId,
      armedWatch: armed,
      entryPath: e.entryPath,
      setupWatchFamily: setupWatchFamily || undefined,
    }),
    closedAt,
    openedAt: Number(e.openedAt) || closedAt,
    holdMs: Math.max(0, (Number(e.holdSec) || 0) * 1000),
    pnlPct,
    pnlSol,
    win: pnlPct > 0 || pnlSol > 0,
    armed,
    lateChase:
      e.lateChaseAtEntry === true ||
      classifyTradeFamily({
        entryStyle: e.entryStyle,
        lateChaseAtEntry: e.lateChaseAtEntry,
        profileId,
      }) === 'late_chase',
    firstPartial: e.pclPartialTaken === true,
    mfeCapturePct: cap,
    maxRunupPct: maxRunup,
    trailActive: e.peakProtectArmed === true,
    entryStyle: e.entryStyle,
    key: tradeKey({
      id: e.id,
      mint: e.mint,
      openedAt: e.openedAt,
      closedAt: e.closedAt,
      pnlSol: e.pnlSol,
    }),
    hasEntryMcField: mc.hasEntryMcField,
    entryMarketCapUsd: mc.entryMarketCapUsd,
  };
}

function fromClosed(t: Record<string, unknown>): ExpectancyTradeRow | null {
  if (/^partial:/i.test(String(t.reason || ''))) return null;
  const profileId = String(t.tradeProfileId || '').trim();
  if (!profileId || profileId === 'default') return null;
  const closedAt = Number(t.closedAt);
  if (!Number.isFinite(closedAt) || closedAt <= 0) return null;
  const pnlPct = Number(t.pnlPct);
  const pnlSol = Number(t.pnlSol);
  if (!isFinitePnl(pnlPct, pnlSol)) return null;
  const maxRunup = Math.max(
    0,
    Number(t.maxRunupPct ?? t.peakUnrealizedPct) || 0
  );
  const armed =
    t.armedWatch === true ||
    t.entryPath === 'armed_trigger' ||
    t.scalperWatchTriggered === true;
  const style = String(t.entryStyle || '');
  const mc = readEntryMcStamp(t);
  return {
    profileId,
    family: classifyTradeFamily({
      entryStyle: style,
      entryStyleSecondary: String(t.entryStyleSecondary || ''),
      lateChaseAtEntry: t.lateChaseAtEntry === true,
      profileId,
      armedWatch: armed,
      entryPath: String(t.entryPath || ''),
      setupWatchFamily: String(t.setupWatchFamily || '') || undefined,
    }),
    closedAt,
    openedAt: Number(t.openedAt) || closedAt,
    holdMs: Math.max(
      0,
      (Number(t.closedAt) || 0) - (Number(t.openedAt) || 0)
    ),
    pnlPct,
    pnlSol,
    win: pnlPct > 0 || pnlSol > 0,
    armed,
    lateChase:
      t.lateChaseAtEntry === true || /late.?chase/i.test(style),
    firstPartial: t.pclPartialTaken === true || t.partialTaken === true,
    mfeCapturePct: mfeCaptureFrom(pnlPct, maxRunup),
    maxRunupPct: maxRunup,
    trailActive: t.peakProtectArmed === true || t.trailActive === true,
    entryStyle: style || undefined,
    key: tradeKey({
      id: String(t.id || ''),
      mint: String(t.mint || ''),
      openedAt: Number(t.openedAt),
      closedAt,
      pnlSol,
    }),
    hasEntryMcField: mc.hasEntryMcField,
    entryMarketCapUsd: mc.entryMarketCapUsd,
  };
}

/** Merge closed ledger + learning episodes (closed wins on collision). */
export function collectExpectancyTrades(): ExpectancyTradeRow[] {
  const map = new Map<string, ExpectancyTradeRow>();
  try {
    for (const p of TRADE_PROFILE_CATALOG) {
      if (p.id === 'default' || p.id === 'zion') continue;
      const eps = getProfileLearningEpisodes(p.id, 400);
      for (const e of eps) {
        const row = fromEpisode(e);
        if (!row) continue;
        map.set(`${row.profileId}:${row.key}`, row);
      }
    }
  } catch {
    /* fail soft */
  }
  try {
    const closed = paperTrader.getClosedPositions?.() ?? [];
    for (const t of closed) {
      const row = fromClosed(t as unknown as Record<string, unknown>);
      if (!row) continue;
      const k = `${row.profileId}:${row.key}`;
      map.set(k, row);
      const alt = `${row.profileId}:${tradeKey({
        mint: (t as { mint?: string }).mint,
        openedAt: row.openedAt,
        closedAt: row.closedAt,
        pnlSol: row.pnlSol,
      })}`;
      if (alt !== k) map.set(alt, row);
    }
  } catch {
    /* fail soft */
  }
  const byStable = new Map<string, ExpectancyTradeRow>();
  for (const row of map.values()) {
    const sk = `${row.profileId}|${row.key}|${row.closedAt}|${row.pnlSol.toFixed(6)}`;
    byStable.set(sk, row);
  }
  return [...byStable.values()].sort((a, b) => a.closedAt - b.closedAt);
}

export function computeExpectancyMetrics(
  trades: ExpectancyTradeRow[]
): ExpectancyMetrics {
  const n = trades.length;
  if (!n) return emptyMetrics();
  const wins = trades.filter((t) => t.win);
  const losses = trades.filter((t) => !t.win);
  const wr = wins.length / n;
  const avgWin = avg(wins.map((t) => t.pnlPct)) ?? 0;
  const avgLossAbs =
    avg(losses.map((t) => Math.abs(t.pnlPct))) ?? 0;
  const expectancyPct = wr * avgWin - (1 - wr) * avgLossAbs;
  const sumWinSol = wins.reduce((s, t) => s + Math.max(0, t.pnlSol), 0);
  const sumLossSolAbs = losses.reduce(
    (s, t) => s + Math.abs(Math.min(0, t.pnlSol)),
    0
  );
  const avgWinSol = avg(wins.map((t) => t.pnlSol)) ?? 0;
  const avgLossSolAbs =
    avg(losses.map((t) => Math.abs(t.pnlSol))) ?? 0;
  const expectancySol = wr * avgWinSol - (1 - wr) * avgLossSolAbs;
  const caps = trades
    .map((t) => t.mfeCapturePct)
    .filter((x): x is number => x != null && Number.isFinite(x));
  return {
    winRate: wr,
    avgWinPct: wins.length ? avgWin : null,
    avgLossPct: losses.length ? avgLossAbs : null,
    winLossRatio:
      avgLossAbs > 1e-9 && wins.length ? avgWin / avgLossAbs : null,
    expectancyPct,
    expectancySol,
    profitFactor:
      sumLossSolAbs > 1e-9
        ? sumWinSol / sumLossSolAbs
        : wins.length
          ? null
          : 0,
    mfeCapturePct: avg(caps),
    avgHoldMs: avg(trades.map((t) => t.holdMs)),
    tradeCount: n,
  };
}

function emptyPersist(): ExpectancyLiftPersist {
  return {
    version: EXPECTANCY_LIFT_VERSION,
    governors: {},
    updatedAt: 0,
    repairedV238: true,
  };
}

/** One-shot: sticky poll-inflation restricts → down_ranked. */
function applyPollInflationRepair(p: ExpectancyLiftPersist): boolean {
  if (p.repairedV238 === true) return false;
  const now = Date.now();
  for (const row of Object.values(p.governors || {})) {
    if (!row || row.state !== 'restricted') continue;
    row.state = 'down_ranked';
    row.tempRestrictUntilMs = undefined;
    row.updatedAt = now;
  }
  p.repairedV238 = true;
  return true;
}

function loadPersist(): ExpectancyLiftPersist {
  if (persistCache) return persistCache;
  try {
    ensureDataDir();
    if (!fs.existsSync(FILE())) {
      persistCache = emptyPersist();
      return persistCache;
    }
    const raw = JSON.parse(
      fs.readFileSync(FILE(), 'utf8')
    ) as ExpectancyLiftPersist;
    persistCache = {
      version: EXPECTANCY_LIFT_VERSION,
      governors:
        raw?.governors && typeof raw.governors === 'object'
          ? raw.governors
          : {},
      updatedAt: Number(raw?.updatedAt) || 0,
      repairedV238: raw?.repairedV238 === true,
    };
    if (applyPollInflationRepair(persistCache)) {
      try {
        persistCache.updatedAt = Date.now();
        atomicWriteJson(FILE(), persistCache);
      } catch {
        /* soft */
      }
    }
  } catch {
    persistCache = emptyPersist();
  }
  return persistCache;
}

function savePersist(): void {
  try {
    ensureDataDir();
    const s = loadPersist();
    s.updatedAt = Date.now();
    atomicWriteJson(FILE(), s);
  } catch {
    /* fail soft */
  }
}

function lossStreakBreaker(trades: ExpectancyTradeRow[]): boolean {
  if (trades.length < MIN_SAMPLES) return false;
  const last = trades.slice(-LOSS_STREAK_N);
  if (last.length < LOSS_STREAK_N) return false;
  const losses = last.filter((t) => !t.win).length;
  return losses >= LOSS_STREAK_K;
}

function updateGovernorForFamily(
  family: ExpectancyFamily,
  windowTrades: ExpectancyTradeRow[],
  altWindowTrades: ExpectancyTradeRow[]
): FamilyGovernorRow {
  const govTrades = filterGovernorWindowTrades(family, windowTrades);
  const govAlt = filterGovernorWindowTrades(family, altWindowTrades);
  const metrics = computeExpectancyMetrics(govTrades);
  const metricsAlt = computeExpectancyMetrics(govAlt);
  const p = loadPersist();
  const prev = p.governors[family] || {
    state: 'neutral' as FamilyGovernorState,
    negWindows: 0,
    updatedAt: 0,
  };
  let state: FamilyGovernorState = prev.state || 'neutral';
  let negWindows = prev.negWindows || 0;
  const now = Date.now();
  const n = metrics.tradeCount;
  const exp = metrics.expectancyPct;
  const expAlt = metricsAlt.expectancyPct;
  const fp = windowFingerprint(govTrades, exp);
  const sameFp =
    prev.lastFingerprint != null && prev.lastFingerprint === fp;
  const tempActive =
    prev.tempRestrictUntilMs != null && prev.tempRestrictUntilMs > now;

  if (tempActive) {
    // Do not refresh TTL on re-poll with same fingerprint
    state = 'restricted';
    if (!sameFp) {
      p.governors[family] = {
        ...prev,
        state,
        lastFingerprint: fp,
        updatedAt: now,
      };
    }
  } else if (lossStreakBreaker(govTrades) && !sameFp) {
    state = 'restricted';
    p.governors[family] = {
      state,
      negWindows,
      tempRestrictUntilMs: now + 30 * 60_000,
      lastFingerprint: fp,
      updatedAt: now,
    };
  } else if (n >= MIN_SAMPLES && exp != null) {
    if (!sameFp) {
      if (exp < 0) {
        negWindows = Math.min(4, negWindows + 1);
        if (
          negWindows >= 2 &&
          expAlt != null &&
          expAlt < 0 &&
          metricsAlt.tradeCount >= MIN_SAMPLES
        ) {
          state = 'restricted';
        } else {
          state = 'down_ranked';
        }
      } else {
        // Restore after improved window
        if (state === 'restricted' || state === 'down_ranked') {
          if (exp > 0 && (expAlt == null || expAlt >= 0)) {
            state = exp >= 0.5 ? 'promoted' : 'neutral';
            negWindows = 0;
          } else if (exp > 0) {
            state = 'neutral';
            negWindows = Math.max(0, negWindows - 1);
          }
        } else if (exp >= 0.75 && n >= MIN_SAMPLES) {
          state = 'promoted';
          negWindows = 0;
        } else {
          state = 'neutral';
          negWindows = 0;
        }
      }
      p.governors[family] = {
        state,
        negWindows,
        tempRestrictUntilMs: undefined,
        lastFingerprint: fp,
        updatedAt: now,
      };
    } else {
      // Same window — keep prior governor decision (awaiting new closes)
      state = prev.state || state;
      negWindows = prev.negWindows || 0;
      if (state === 'restricted' && !tempActive) {
        // Sticky non-temp restrict with same fp stays until new closes
      }
    }
  } else {
    state =
      prev.state === 'restricted' && tempActive
        ? 'restricted'
        : state === 'restricted' && !tempActive && !prev.lastFingerprint
          ? 'neutral'
          : state;
  }

  persistCache = p;
  try {
    savePersist();
  } catch {
    /* soft */
  }

  let note = 'Insufficient samples';
  if (n >= MIN_SAMPLES && exp != null) {
    if (sameFp && (state === 'restricted' || state === 'down_ranked')) {
      note = `Awaiting new closes · negWindows=${negWindows}`;
    } else if (state === 'promoted') note = 'Positive expectancy — promoted';
    else if (state === 'restricted')
      note = `Negative expectancy (2+ windows) / streak breaker · negWindows=${negWindows}`;
    else if (state === 'down_ranked')
      note = `Negative expectancy — down-ranked · negWindows=${negWindows}`;
    else note = 'Neutral expectancy';
  } else if (lossStreakBreaker(govTrades)) {
    note = `Loss streak ${LOSS_STREAK_K}/${LOSS_STREAK_N} — temp restrict`;
  }

  return {
    family,
    state,
    metrics,
    metricsAlt,
    negWindows,
    note,
  };
}

export function getFamilyGovernorState(
  family: ExpectancyFamily | string
): FamilyGovernorState {
  const f = normalizeExpectancyFamily(family);
  try {
    const p = loadPersist();
    const row = p.governors[f];
    if (!row) return 'neutral';
    if (
      row.tempRestrictUntilMs &&
      row.tempRestrictUntilMs > Date.now()
    ) {
      return 'restricted';
    }
    return row.state || 'neutral';
  } catch {
    return 'neutral';
  }
}

/** Soft-skip when family is restricted (late_chase always respects share ceiling). */
export function shouldSkipFamilyGovernor(input: {
  family?: string | null;
  entryStyle?: string | null;
  lateChase?: boolean;
  armedWatch?: boolean;
  profileId?: string | null;
  entryPath?: string | null;
  setupWatchFamily?: string | null;
}): { skip: boolean; reason?: string; state: FamilyGovernorState } {
  const family =
    input.profileId != null ||
    input.armedWatch != null ||
    input.entryPath != null ||
    input.setupWatchFamily != null
      ? classifyTradeFamily({
          entryStyle: input.lateChase ? 'late_chase' : input.entryStyle,
          lateChaseAtEntry: input.lateChase === true,
          profileId: input.profileId,
          armedWatch: input.armedWatch,
          entryPath: input.entryPath,
          setupWatchFamily: input.setupWatchFamily,
        })
      : normalizeExpectancyFamily(
          input.family ||
            (input.lateChase ? 'late_chase' : input.entryStyle) ||
            'discretionary_other'
        );
  const state = getFamilyGovernorState(family);
  if (state === 'restricted') {
    // Armed reclaim may still pass soft restrict except late_chase
    if (input.armedWatch === true && family !== 'late_chase') {
      return { skip: false, state };
    }
    return {
      skip: true,
      reason: `Expectancy governor: ${family} restricted`,
      state,
    };
  }
  return { skip: false, state };
}

/** Armed reclaim near level — not true late chase for ceiling / hard-skip. */
function isArmedReclaimRelief(input: {
  armedWatch?: boolean;
  entryStyle?: string | null;
  extensionFromLevelPct?: number | null;
}): boolean {
  if (input.armedWatch !== true) return false;
  const style = String(input.entryStyle || '').toLowerCase();
  if (/reclaim/i.test(style) && !/late.?chase/i.test(style)) return true;
  const ext =
    input.extensionFromLevelPct != null &&
    Number.isFinite(Number(input.extensionFromLevelPct))
      ? Number(input.extensionFromLevelPct)
      : null;
  // Extension ≤4% from level = reclaim / near-level, not chase
  if (ext != null && ext >= -2 && ext <= 4) return true;
  return false;
}

export function getRecentMixShares(
  limit = 50,
  opts?: { lateChaseCeilingWindow?: boolean }
): {
  armedShare: number;
  discShare: number;
  lateChaseShare: number;
  total: number;
} {
  const window = opts?.lateChaseCeilingWindow
    ? Math.max(20, Math.min(limit, 20))
    : Math.max(8, limit);
  const trades = collectExpectancyTrades().slice(-window);
  const total = trades.length || 1;
  const armed = trades.filter((t) => t.armed).length;
  // Armed reclaim mis-tags do not inflate the late-chase ceiling share
  const late = trades.filter((t) => {
    if (!(t.lateChase || t.family === 'late_chase')) return false;
    if (
      t.armed &&
      /reclaim/i.test(String(t.family || t.entryStyle || '')) &&
      !/late.?chase/i.test(String(t.entryStyle || ''))
    ) {
      return false;
    }
    return true;
  }).length;
  return {
    armedShare: armed / total,
    discShare: (total - armed) / Math.max(1, total),
    lateChaseShare: late / total,
    total: trades.length,
  };
}

/** Hard late_chase share ceiling (5%). Require ≥20 closes; fresher last-20 window. */
export function shouldLimitLateChaseShare(input: {
  lateChase?: boolean;
  family?: string | null;
  entryStyle?: string | null;
  armedWatch?: boolean;
  extensionFromLevelPct?: number | null;
}): { limit: boolean; reason?: string } {
  // Armed reclaim does not hard-skip and does not count toward ceiling
  if (
    isArmedReclaimRelief({
      armedWatch: input.armedWatch,
      entryStyle: input.entryStyle,
      extensionFromLevelPct: input.extensionFromLevelPct,
    })
  ) {
    return { limit: false };
  }
  const isLate =
    input.lateChase === true ||
    normalizeExpectancyFamily(input.family || input.entryStyle) ===
      'late_chase';
  if (!isLate) return { limit: false };
  const mix = getRecentMixShares(20, { lateChaseCeilingWindow: true });
  if (mix.total >= 20 && mix.lateChaseShare >= LATE_CHASE_MAX_SHARE) {
    return {
      limit: true,
      reason: `Late-chase share ${(mix.lateChaseShare * 100).toFixed(0)}% ≥ ${(LATE_CHASE_MAX_SHARE * 100).toFixed(0)}% ceiling`,
    };
  }
  return { limit: false };
}

function countLiveArmedWatches(): number {
  let n = 0;
  try {
    const { getScalperSetupWatchStatus } =
      require('./scalperSetupWatch') as typeof import('./scalperSetupWatch');
    const sw = getScalperSetupWatchStatus(40);
    n += (sw.entries || []).filter((e) => e.status === 'armed').length;
  } catch {
    /* soft */
  }
  try {
    const { getDipSetupWatchStatus } =
      require('./dipSetupWatch') as typeof import('./dipSetupWatch');
    const dw = getDipSetupWatchStatus(40);
    n += (dw.entries || []).filter((e) => e.status === 'armed').length;
  } catch {
    /* soft */
  }
  try {
    const { getMigrationGradWatchStatus } =
      require('./migrationGradWatch') as typeof import('./migrationGradWatch');
    const gw = getMigrationGradWatchStatus(40);
    n += (gw.entries || []).filter((e) => e.status === 'armed').length;
  } catch {
    /* soft */
  }
  return n;
}

/** True when armed funnel is stuck (poor open-rate) or book is thin. */
function stuckArmedReliefActive(): boolean {
  let openCount = 0;
  try {
    const { paperTrader } =
      require('./paperTrader') as typeof import('./paperTrader');
    openCount = paperTrader.getOpenPositions().length;
  } catch {
    openCount = 0;
  }
  let armedOpenRate: number | null = null;
  try {
    const { setupWatchEventStats } =
      require('./setupWatchEvents') as typeof import('./setupWatchEvents');
    const stats = setupWatchEventStats();
    armedOpenRate = stats.openRate;
  } catch {
    armedOpenRate = null;
  }
  // Thin book + poor armed conversion → relieve disc cap so flow isn't starved
  const poorArmed =
    armedOpenRate != null && armedOpenRate < 0.12;
  return openCount < 15 && (poorArmed || armedOpenRate == null);
}

/** Armed dominance ~70/30 — hard soft-skip only fast discretionary when disc high. */
export function shouldLimitDiscretionaryMix(input: {
  armedWatch?: boolean;
  profileId?: string | null;
}): { limit: boolean; reason?: string } {
  if (input.armedWatch === true) return { limit: false };
  const mix = getRecentMixShares(50);
  if (mix.total < 10) return { limit: false };
  const liveArmed = countLiveArmedWatches();
  const relief =
    liveArmed === 0 || stuckArmedReliefActive();
  const cap = relief ? DISC_SHARE_CAP_RELIEF : DISC_SHARE_CAP;
  if (mix.discShare < cap) return { limit: false };
  const pid = String(input.profileId || '');
  if (!FAST_DISC_PROFILES.has(pid)) {
    // Non-fast: size penalty only (see expectancyLiftSizePenaltyForDiscMix)
    return { limit: false };
  }
  return {
    limit: true,
    reason: `Discretionary mix ${(mix.discShare * 100).toFixed(0)}% ≥ ${(cap * 100).toFixed(0)}% — skip fast disc (armed target ${(ARMED_SHARE_TARGET * 100).toFixed(0)}%)`,
  };
}

/** Size penalty for non-fast discretionary when disc share is elevated. */
export function expectancyLiftSizePenaltyForDiscMix(input: {
  armedWatch?: boolean;
  profileId?: string | null;
}): { mult: number; note: string } {
  if (input.armedWatch === true) return { mult: 1, note: '' };
  const pid = String(input.profileId || '');
  if (FAST_DISC_PROFILES.has(pid)) return { mult: 1, note: '' };
  try {
    const mix = getRecentMixShares(50);
    const liveArmed = countLiveArmedWatches();
    const relief = liveArmed === 0 || stuckArmedReliefActive();
    const cap = relief ? DISC_SHARE_CAP_RELIEF : DISC_SHARE_CAP;
    if (mix.total >= 10 && mix.discShare >= DISC_SHARE_CAP) {
      return {
        mult: DISC_MIX_SIZE_PENALTY,
        note: `disc-mix×${DISC_MIX_SIZE_PENALTY.toFixed(2)} (disc ${(mix.discShare * 100).toFixed(0)}%≥${(cap * 100).toFixed(0)}%)`,
      };
    }
  } catch {
    /* soft */
  }
  return { mult: 1, note: '' };
}

export function computeTradePermissionScore(input: {
  armedWatch?: boolean;
  triggerConfirm?: boolean;
  family?: string | null;
  entryStyle?: string | null;
  lateChase?: boolean;
  extensionFromLevelPct?: number | null;
  dnaMatch?: boolean | null;
  profileId?: string | null;
  tradeProfileScore?: number | null;
}): number {
  let score = 50;
  const armed = input.armedWatch === true;
  if (armed) score += 18;
  else score -= 8;
  if (input.triggerConfirm === true) score += 12;
  else if (input.triggerConfirm === false) score -= 10;

  const family = normalizeExpectancyFamily(
    input.family || input.entryStyle || 'discretionary_other'
  );
  const gov = getFamilyGovernorState(family);
  if (gov === 'promoted') score += 10;
  else if (gov === 'down_ranked') score -= 12;
  else if (gov === 'restricted') score -= 22;

  const ext =
    input.extensionFromLevelPct != null &&
    Number.isFinite(Number(input.extensionFromLevelPct))
      ? Number(input.extensionFromLevelPct)
      : null;
  if (input.lateChase === true || family === 'late_chase') score -= 18;
  else if (ext != null) {
    if (ext >= 0 && ext <= 4) score += 10; // reclaim / near level
    else if (ext > 8) score -= 12; // chase extension
    else if (ext < 0 && ext >= -2) score += 6; // undercut reclaim path
  }

  if (input.dnaMatch === true) score += 10;
  else if (input.dnaMatch === false) score -= 14;
  if (
    input.tradeProfileScore != null &&
    Number.isFinite(Number(input.tradeProfileScore))
  ) {
    score += clamp((Number(input.tradeProfileScore) - 50) / 5, -8, 8);
  }

  const floor = armed ? PERM_FLOOR_ARMED : PERM_FLOOR_DISC;
  return Math.round(clamp(score, floor, 100));
}

export function shouldSoftSkipPermissionScore(score: number, armed: boolean): {
  skip: boolean;
  reason?: string;
} {
  const floor = armed ? PERM_FLOOR_ARMED + 5 : PERM_FLOOR_DISC;
  if (score < floor) {
    return {
      skip: true,
      reason: `Trade permission score ${score} < ${floor}`,
    };
  }
  return { skip: false };
}

/** Expectancy-weighted size multiplier 0.7–1.15. */
export function expectancySizeMultiplier(input: {
  profileId?: string | null;
  family?: string | null;
  armedWatch?: boolean;
}): { mult: number; note: string } {
  try {
    const trades = collectExpectancyTrades();
    const pid = String(input.profileId || '');
    const family = normalizeExpectancyFamily(input.family);
    const slice = trades
      .filter((t) =>
        pid ? t.profileId === pid : t.family === family
      )
      .slice(-DEFAULT_EXPECTANCY_WINDOW);
    const m = computeExpectancyMetrics(slice);
    if (m.tradeCount < 8 || m.expectancyPct == null) {
      const discPen = expectancyLiftSizePenaltyForDiscMix({
        armedWatch: input.armedWatch,
        profileId: input.profileId,
      });
      if (discPen.mult !== 1) {
        return {
          mult: discPen.mult,
          note: discPen.note || 'disc mix size penalty',
        };
      }
      return { mult: 1, note: 'expectancy size n/a' };
    }
    let mult = 1;
    if (m.expectancyPct >= 1.0) mult = 1.12;
    else if (m.expectancyPct >= 0.4) mult = 1.05;
    else if (m.expectancyPct >= 0) mult = 1.0;
    else if (m.expectancyPct >= -0.5) mult = 0.9;
    else mult = 0.75;
    const gov = getFamilyGovernorState(family);
    if (gov === 'promoted') mult = Math.min(SIZE_MULT_HI, mult + 0.03);
    if (gov === 'down_ranked') mult = Math.max(SIZE_MULT_LO, mult - 0.08);
    if (gov === 'restricted') mult = Math.max(SIZE_MULT_LO, mult * 0.85);
    if (input.armedWatch === true) mult = Math.min(SIZE_MULT_HI, mult + 0.02);
    const discPen = expectancyLiftSizePenaltyForDiscMix({
      armedWatch: input.armedWatch,
      profileId: input.profileId,
    });
    if (discPen.mult !== 1) mult *= discPen.mult;
    mult = clamp(mult, SIZE_MULT_LO, SIZE_MULT_HI);
    const notes = [`expectancy×${mult.toFixed(2)} (E=${m.expectancyPct.toFixed(2)}%)`];
    if (discPen.note) notes.push(discPen.note);
    return {
      mult: Math.round(mult * 100) / 100,
      note: notes.join(' · '),
    };
  } catch {
    return { mult: 1, note: 'expectancy size fail-soft' };
  }
}

/** One-setup-one-profile: mint lock while preferred watch is active. */
export function mintOneSetupProfileLock(
  mint: string,
  profileId: string,
  ttlMs = 12 * 60_000
): void {
  const m = String(mint || '').trim();
  const p = String(profileId || '').trim();
  if (!m || !p) return;
  oneSetupLocks.set(m, { profileId: p, untilMs: Date.now() + ttlMs });
}

export function clearOneSetupProfileLock(mint: string): void {
  oneSetupLocks.delete(String(mint || '').trim());
}

export function getOneSetupPreferredProfile(
  mint: string
): string | null {
  const row = oneSetupLocks.get(String(mint || '').trim());
  if (!row) return null;
  if (row.untilMs < Date.now()) {
    oneSetupLocks.delete(String(mint || '').trim());
    return null;
  }
  return row.profileId;
}

/** Block other-profile discretionary when mint is locked to preferred P. */
export function shouldBlockOtherProfileDiscretionary(input: {
  mint?: string | null;
  profileId?: string | null;
  armedWatch?: boolean;
}): { block: boolean; reason?: string; preferred?: string } {
  const mint = String(input.mint || '');
  const pid = String(input.profileId || '');
  if (!mint || !pid) return { block: false };
  // Refresh from live watches
  try {
    syncOneSetupLocksFromWatches();
  } catch {
    /* soft */
  }
  const preferred = getOneSetupPreferredProfile(mint);
  if (!preferred) return { block: false };
  if (preferred === pid) return { block: false, preferred };
  if (input.armedWatch === true && preferred === pid) {
    return { block: false, preferred };
  }
  // Other profile discretionary blocked; other-profile armed also blocked (one setup)
  return {
    block: true,
    preferred,
    reason: `One-setup lock: ${mint.slice(0, 6)}… reserved for ${preferred}`,
  };
}

export function syncOneSetupLocksFromWatches(): void {
  try {
    const { getScalperSetupWatchStatus } =
      require('./scalperSetupWatch') as typeof import('./scalperSetupWatch');
    const sw = getScalperSetupWatchStatus(40);
    for (const e of sw.entries || []) {
      if (e.status !== 'armed' && e.status !== 'watching') continue;
      const pref = String(e.preferredProfileId || 'scalper');
      mintOneSetupProfileLock(e.mint, pref);
    }
  } catch {
    /* soft */
  }
  try {
    const { getDipSetupWatchStatus } =
      require('./dipSetupWatch') as typeof import('./dipSetupWatch');
    const dw = getDipSetupWatchStatus(40);
    for (const e of dw.entries || []) {
      if (e.status !== 'armed' && e.status !== 'watching') continue;
      mintOneSetupProfileLock(e.mint, 'dip_buyer');
    }
  } catch {
    /* soft */
  }
}

function quietReasonForProfile(profileId: string): string | null {
  try {
    const {
      getSetupWatchDiagnostics,
      describeDipInactiveReason,
    } = require('./profileAttention') as typeof import('./profileAttention');
    if (profileId === 'dip_buyer') {
      const r = describeDipInactiveReason();
      if (r === 'no_watches') return 'No dip watches';
      if (r === 'armed_no_trigger') return 'Armed — waiting reclaim';
      if (r === 'trigger_blocked') return 'Triggers blocked';
      if (r === 'recovery') return 'Recovery throttle';
      if (r === 'profile_off') return 'Profile off';
      if (r === 'marl') return 'MARL downrank';
    }
    const d = getSetupWatchDiagnostics();
    const armed = d.armedByProfile?.[profileId] || 0;
    if (
      (profileId === 'trend_rider' || profileId === 'steady_compounder') &&
      armed === 0
    ) {
      const recent = collectExpectancyTrades()
        .filter((t) => t.profileId === profileId)
        .slice(-20);
      if (recent.length < 2) return 'Quiet — few recent trades';
    }
  } catch {
    /* soft */
  }
  return null;
}

export function getQuietProfileChips(): Array<{
  profileId: string;
  label: string;
  reason: string;
}> {
  const ids = ['dip_buyer', 'trend_rider', 'steady_compounder'] as const;
  const labels: Record<string, string> = {
    dip_buyer: 'Dip',
    trend_rider: 'Trend',
    steady_compounder: 'Steady',
  };
  const out: Array<{ profileId: string; label: string; reason: string }> = [];
  for (const id of ids) {
    const reason = quietReasonForProfile(id);
    if (reason) out.push({ profileId: id, label: labels[id] || id, reason });
  }
  return out;
}

function buildArmedFunnel(): ArmedFunnelRow {
  const empty: ArmedFunnelRow = {
    offered: 0,
    armed: 0,
    triggered: 0,
    opened: 0,
    blocked: 0,
    openRatePct: null,
    armToTriggerMs: null,
  };
  try {
    const { setupWatchEventStats, listSetupWatchEvents } =
      require('./setupWatchEvents') as typeof import('./setupWatchEvents');
    const stats = setupWatchEventStats();
    const events = listSetupWatchEvents(120);
    let offered = 0;
    for (const e of events) {
      // Approximate "offered" from armed + watching-adjacent kinds in the ring
      if (e.kind === 'armed' || e.kind === 'triggered') {
        offered += 1;
      }
    }
    try {
      const { getModeBFunnelCounters } =
        require('./scalperSetupWatch') as typeof import('./scalperSetupWatch');
      const fc = getModeBFunnelCounters() as Record<string, number>;
      if (fc && typeof fc === 'object') {
        offered = Math.max(offered, Number(fc.offered || fc.diverted || 0));
      }
    } catch {
      /* soft */
    }
    const { getSetupWatchDiagnostics } =
      require('./profileAttention') as typeof import('./profileAttention');
    const d = getSetupWatchDiagnostics();
    const denom =
      stats.triggered + stats.opened + stats.blockedSafety + stats.handoffFailed;
    return {
      offered,
      armed: stats.armed,
      triggered: stats.triggered,
      opened: stats.opened,
      blocked: stats.blockedSafety + stats.handoffFailed,
      openRatePct:
        d.triggerSuccessPct != null
          ? d.triggerSuccessPct
          : denom > 0
            ? Math.round((stats.opened / denom) * 1000) / 10
            : null,
      armToTriggerMs: d.armToTriggerLatencyMs,
    };
  } catch {
    return empty;
  }
}

function buildChart(trades: ExpectancyTradeRow[]): ExpectancyLiftStatus['chart'] {
  const tradeIndex: number[] = [];
  const rollingExpectancyPct: number[] = [];
  const rollingWinRatePct: number[] = [];
  const cumulativePnlPct: number[] = [];
  let cum = 0;
  const roll = 10;
  for (let i = 0; i < trades.length; i++) {
    tradeIndex.push(i + 1);
    cum += trades[i]!.pnlPct;
    cumulativePnlPct.push(Math.round(cum * 100) / 100);
    const slice = trades.slice(Math.max(0, i - roll + 1), i + 1);
    const m = computeExpectancyMetrics(slice);
    rollingExpectancyPct.push(
      m.expectancyPct != null ? Math.round(m.expectancyPct * 100) / 100 : 0
    );
    rollingWinRatePct.push(
      m.winRate != null ? Math.round(m.winRate * 1000) / 10 : 0
    );
  }
  return {
    tradeIndex,
    rollingExpectancyPct,
    rollingWinRatePct,
    cumulativePnlPct,
  };
}

export function parseExpectancyWindow(raw: unknown): ExpectancyWindow {
  const n = Number(raw);
  if (n === 20 || n === 50 || n === 100) return n;
  return DEFAULT_EXPECTANCY_WINDOW;
}

export function getExpectancyLiftStatus(
  window: ExpectancyWindow = DEFAULT_EXPECTANCY_WINDOW
): ExpectancyLiftStatus {
  try {
    syncOneSetupLocksFromWatches();
  } catch {
    /* soft */
  }
  const all = collectExpectancyTrades();
  const windowTrades = all.slice(-window);
  const altN = window === 20 ? 50 : window === 50 ? 100 : 50;
  const altTrades = all.slice(-altN);

  const mixTrades = windowTrades;
  const armedN = mixTrades.filter((t) => t.armed).length;
  const lateN = mixTrades.filter(
    (t) => t.lateChase || t.family === 'late_chase'
  ).length;
  const partialN = mixTrades.filter((t) => t.firstPartial).length;
  const caps = mixTrades
    .map((t) => t.mfeCapturePct)
    .filter((x): x is number => x != null);
  let scalperAttentionShare: number | null = null;
  try {
    const { getProfileAttentionShare } =
      require('./profileAttention') as typeof import('./profileAttention');
    const att = getProfileAttentionShare();
    scalperAttentionShare =
      att.total >= 4 ? att.shares.scalper : null;
  } catch {
    /* soft */
  }

  const mix: ExpectancyMix = {
    armedShare: mixTrades.length ? armedN / mixTrades.length : null,
    discretionaryShare: mixTrades.length
      ? (mixTrades.length - armedN) / mixTrades.length
      : null,
    lateChaseShare: mixTrades.length ? lateN / mixTrades.length : null,
    scalperAttentionShare,
    firstPartialRate: mixTrades.length ? partialN / mixTrades.length : null,
    avgMfeCapture: avg(caps),
  };

  const profiles: ProfileExpectancyRow[] = [];
  for (const p of TRADE_PROFILE_CATALOG) {
    if (p.id === 'default' || p.id === 'zion') continue;
    const pt = windowTrades.filter((t) => t.profileId === p.id);
    const metrics = computeExpectancyMetrics(pt);
    const quiet = quietReasonForProfile(p.id);
    profiles.push({
      profileId: p.id,
      name: p.name,
      metrics,
      armedShare: pt.length
        ? pt.filter((t) => t.armed).length / pt.length
        : null,
      lateChaseShare: pt.length
        ? pt.filter((t) => t.lateChase).length / pt.length
        : null,
      firstPartialRate: pt.length
        ? pt.filter((t) => t.firstPartial).length / pt.length
        : null,
      quiet: quiet != null,
      quietReason: quiet || undefined,
    });
  }
  profiles.sort(
    (a, b) =>
      (b.metrics.expectancyPct ?? -999) - (a.metrics.expectancyPct ?? -999)
  );

  const families: FamilyGovernorRow[] = [];
  for (const f of EXPECTANCY_FAMILIES) {
    const ft = windowTrades.filter((t) => t.family === f);
    const fa = altTrades.filter((t) => t.family === f);
    families.push(updateGovernorForFamily(f, ft, fa));
  }

  const quietChips = getQuietProfileChips();
  const funnel = buildArmedFunnel();
  const overall = computeExpectancyMetrics(windowTrades);
  const eStr =
    overall.expectancyPct != null
      ? `${overall.expectancyPct >= 0 ? '+' : ''}${overall.expectancyPct.toFixed(2)}%`
      : '—';
  const armedStr =
    mix.armedShare != null ? `${(mix.armedShare * 100).toFixed(0)}%` : '—';
  const lateStr =
    mix.lateChaseShare != null
      ? `${(mix.lateChaseShare * 100).toFixed(0)}%`
      : '—';
  const plainLanguage = `Expectancy ${eStr} over last ${window} · armed ${armedStr} (target 70%) · late-chase ${lateStr} (≤5%).`;

  const liveArmed = countLiveArmedWatches();
  const effectiveCap =
    liveArmed === 0 ? DISC_SHARE_CAP_RELIEF : DISC_SHARE_CAP;
  const discShare = mix.discretionaryShare;
  const discMixActive =
    discShare != null &&
    mixTrades.length >= 10 &&
    discShare >= effectiveCap;

  return {
    ok: true,
    window,
    mix,
    targets: {
      armedShare: ARMED_SHARE_TARGET,
      lateChaseShareMax: LATE_CHASE_MAX_SHARE,
      scalperShareMax: SCALPER_SHARE_TARGET,
      discShareMax: DISC_SHARE_CAP,
    },
    profiles,
    families,
    funnel,
    chart: buildChart(windowTrades),
    quietChips,
    plainLanguage,
    discMixThrottle: {
      active: discMixActive,
      discShare,
      liveArmed,
      effectiveCap,
    },
  };
}

export function formatExpectancyLiftZionLines(
  window: ExpectancyWindow = DEFAULT_EXPECTANCY_WINDOW
): string[] {
  try {
    const st = getExpectancyLiftStatus(window);
    const lines: string[] = [];
    lines.push(st.plainLanguage);
    const restricted = st.families.filter((f) => f.state === 'restricted');
    const down = st.families.filter((f) => f.state === 'down_ranked');
    if (restricted.length) {
      lines.push(
        `Restricted families: ${restricted.map((f) => f.family).join(', ')}.`
      );
    }
    if (down.length) {
      lines.push(
        `Down-ranked: ${down.map((f) => f.family).join(', ')}.`
      );
    }
    const top = st.profiles.find((p) => (p.metrics.tradeCount || 0) >= 5);
    if (top && top.metrics.expectancyPct != null) {
      lines.push(
        `Best sample: ${top.name} E=${top.metrics.expectancyPct.toFixed(2)}% (n=${top.metrics.tradeCount}).`
      );
    }
    if (st.quietChips.length) {
      lines.push(
        `Quiet: ${st.quietChips.map((c) => `${c.label} (${c.reason})`).join('; ')}.`
      );
    }
    if (st.funnel.openRatePct != null) {
      lines.push(`Armed open rate ~${st.funnel.openRatePct}%.`);
    }
    return lines;
  } catch {
    return ['Expectancy Lift diagnostics unavailable.'];
  }
}

/** Lead-block synergy when profile expectancy is poor. */
export function shouldBlockLeadForPoorExpectancy(profileId: string): boolean {
  try {
    const trades = collectExpectancyTrades()
      .filter((t) => t.profileId === String(profileId || ''))
      .slice(-40);
    const m = computeExpectancyMetrics(trades);
    if (m.tradeCount < MIN_SAMPLES || m.expectancyPct == null) return false;
    if (m.expectancyPct <= -0.75 && (m.winRate ?? 1) < 0.35) return true;
    const fam = classifyTradeFamily({ profileId });
    return getFamilyGovernorState(fam) === 'restricted' && m.expectancyPct < 0;
  } catch {
    return false;
  }
}
