/**
 * Micro Bot Performance — per-profile metrics, streaks, time windows, PF-first ranking.
 * Merges closed-position finals with durable learning episodes (survives closed-list ring cap).
 */

import type { ProfileLearningEpisode } from './profileLearningEpisodes';
import { getProfileLearningEpisodes } from './profileLearningEpisodes';
import {
  classifyTradeOutcomePnlSol,
  isLossPnlSol,
  isWinPnlSol,
  winRatePctFromWl,
  wrDisplayConsistent,
} from './tradeOutcome';

export type PerformanceWindow = '1h' | 'today' | '24h' | '7d' | '30d' | 'all';

export const PERFORMANCE_WINDOWS: readonly PerformanceWindow[] = [
  '1h',
  'today',
  '24h',
  '7d',
  '30d',
  'all',
] as const;

/** Overview strip windows (same pill pattern as Micro Bot Performance). */
export type OverviewStatsWindow =
  | 'now'
  | '1h'
  | '24h'
  | '7d'
  | '30d'
  | 'all';

export const OVERVIEW_STATS_WINDOWS: readonly OverviewStatsWindow[] = [
  'now',
  '1h',
  '24h',
  '7d',
  '30d',
  'all',
] as const;

/** Cap displayed profit factor when there are wins and zero losses. */
export const PROFIT_FACTOR_INF = 999;

export interface PerformanceTradeLike {
  tradeProfileId?: string;
  tradeProfileName?: string;
  tradeProfileIcon?: string;
  tradeProfileColor?: string;
  mint?: string;
  symbol?: string;
  pnlSol?: number;
  pnlPct?: number;
  pnlUsd?: number | null;
  solUsd?: number | null;
  openedAt?: number;
  closedAt?: number;
  reason?: string;
  learningMode?: boolean;
  /** Stable-ish dedupe key when merging closed + episodes */
  id?: string;
}

export interface PerformanceStreak {
  kind: 'win' | 'loss' | 'flat';
  length: number;
}

export interface PerformanceExtremeTrade {
  symbol: string;
  mint?: string;
  pnlPct: number;
  pnlSol: number;
  closedAt: number;
}

export type PerformanceBand = 'top' | 'mid' | 'under' | 'none';

export interface MicroBotPerformanceRow {
  profileId: string;
  name: string;
  icon: string;
  color: string;
  enabled: boolean;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgPnlPct: number;
  avgPnlPctWinners: number | null;
  avgPnlPctLosers: number | null;
  netPnlSol: number;
  netPnlUsd: number | null;
  profitFactor: number;
  maxDrawdownSol: number;
  maxDrawdownPct: number;
  avgHoldSec: number;
  bestTrade: PerformanceExtremeTrade | null;
  worstTrade: PerformanceExtremeTrade | null;
  currentStreak: PerformanceStreak;
  longestWinStreak: number;
  longestLossStreak: number;
  learningModeOptIn: boolean;
  learningModeTrades: number;
  learningModeActive: boolean;
  /** Present when WR/W-L classifier check was computed. */
  diagnostics?: { wrConsistent: boolean; decidedTrades: number };
  /** 1-based rank among profiles with trades; null if unranked */
  rank: number | null;
  band: PerformanceBand;
}

export interface MicroBotPerformanceReport {
  window: PerformanceWindow;
  rows: MicroBotPerformanceRow[];
  rankedAt: number;
  solUsd: number | null;
  globalLearningMode: boolean;
}

type CatalogEntry = {
  id: string;
  name: string;
  icon: string;
  color: string;
  enabled?: boolean;
};

type InternalTrade = {
  profileId: string;
  mint: string;
  symbol: string;
  pnlSol: number;
  pnlPct: number;
  pnlUsd: number | null;
  openedAt: number;
  closedAt: number;
  learningMode: boolean;
  key: string;
};

function isPartialReason(reason?: string): boolean {
  return /^partial:/i.test(String(reason || ''));
}

export function parsePerformanceWindow(
  raw: unknown,
  fallback: PerformanceWindow = '7d'
): PerformanceWindow {
  const s = String(raw || '').trim().toLowerCase();
  if (
    s === '1h' ||
    s === 'today' ||
    s === '24h' ||
    s === '7d' ||
    s === '30d' ||
    s === 'all'
  ) {
    return s;
  }
  if (s === 'hourly' || s === 'hour') return '1h';
  if (s === 'monthly' || s === '30day' || s === 'month') return '30d';
  return fallback;
}

export function parseOverviewStatsWindow(
  raw: unknown,
  fallback: OverviewStatsWindow = 'all'
): OverviewStatsWindow {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (s === 'now' || s === 'session' || s === 'live') return 'now';
  const w = parsePerformanceWindow(raw, fallback === 'now' ? 'all' : fallback);
  if (w === '1h' || w === '24h' || w === '7d' || w === '30d' || w === 'all') {
    return w;
  }
  // Map Micro Bot "today" → calendar day ≈ closer to 24h for overview
  if (w === 'today') return '24h';
  return fallback;
}

export function windowStartMs(
  window: PerformanceWindow,
  nowMs = Date.now()
): number | null {
  if (window === 'all') return null;
  if (window === '1h') return nowMs - 60 * 60 * 1000;
  if (window === '24h') return nowMs - 24 * 60 * 60 * 1000;
  if (window === '7d') return nowMs - 7 * 24 * 60 * 60 * 1000;
  if (window === '30d') return nowMs - 30 * 24 * 60 * 60 * 1000;
  // today — UTC calendar day
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function tradeKey(t: {
  mint?: string;
  closedAt?: number;
  openedAt?: number;
  pnlSol?: number;
  id?: string;
}): string {
  if (t.id) return `id:${t.id}`;
  const mint = String(t.mint || '').slice(0, 32);
  const closed = Math.round(Number(t.closedAt) || 0);
  const opened = Math.round(Number(t.openedAt) || 0);
  const pnl = Number(t.pnlSol);
  const pnlR = Number.isFinite(pnl) ? pnl.toFixed(6) : '0';
  return `${mint}|${opened}|${closed}|${pnlR}`;
}

function toInternalFromClosed(
  t: PerformanceTradeLike,
  solUsdFallback: number | null,
  opts?: { allowMissingProfile?: boolean }
): InternalTrade | null {
  if (isPartialReason(t.reason)) return null;
  const profileId = String(t.tradeProfileId || '').trim();
  if (!opts?.allowMissingProfile && (!profileId || profileId === 'default')) {
    return null;
  }
  const closedAt = Number(t.closedAt);
  if (!Number.isFinite(closedAt) || closedAt <= 0) return null;
  const pnlSol = Number(t.pnlSol);
  const pnlPct = Number(t.pnlPct);
  let pnlUsd: number | null =
    t.pnlUsd != null && Number.isFinite(Number(t.pnlUsd))
      ? Number(t.pnlUsd)
      : null;
  if (pnlUsd == null && Number.isFinite(pnlSol)) {
    const rate =
      t.solUsd != null && Number.isFinite(Number(t.solUsd)) && Number(t.solUsd) > 0
        ? Number(t.solUsd)
        : solUsdFallback;
    if (rate != null && rate > 0) pnlUsd = pnlSol * rate;
  }
  return {
    profileId: profileId || '_session',
    mint: String(t.mint || ''),
    symbol: String(t.symbol || t.mint || '—').slice(0, 24),
    pnlSol: Number.isFinite(pnlSol) ? pnlSol : 0,
    pnlPct: Number.isFinite(pnlPct) ? pnlPct : 0,
    pnlUsd,
    openedAt: Number(t.openedAt) || closedAt,
    closedAt,
    learningMode: t.learningMode === true,
    key: tradeKey(t),
  };
}

/** Session-only closed rows for Overview "Now" (no learning-episode merge). */
function sessionClosedTrades(
  closed: PerformanceTradeLike[],
  solUsd: number | null
): InternalTrade[] {
  const byStable = new Map<string, InternalTrade>();
  for (const t of closed || []) {
    const row = toInternalFromClosed(t, solUsd, { allowMissingProfile: true });
    if (!row) continue;
    const sk = `${row.mint}|${row.closedAt}|${row.pnlSol.toFixed(6)}|${row.key}`;
    const prev = byStable.get(sk);
    if (!prev || (prev.pnlUsd == null && row.pnlUsd != null)) {
      byStable.set(sk, row);
    }
  }
  return [...byStable.values()].sort((a, b) => a.closedAt - b.closedAt);
}

function toInternalFromEpisode(
  e: ProfileLearningEpisode,
  solUsdFallback: number | null
): InternalTrade | null {
  const profileId = String(e.profileId || '').trim();
  if (!profileId || profileId === 'default') return null;
  if (/^partial:/i.test(String(e.exitReason || ''))) return null;
  const closedAt = Number(e.closedAt);
  if (!Number.isFinite(closedAt) || closedAt <= 0) return null;
  const pnlSol = Number(e.pnlSol);
  const pnlPct = Number(e.pnlPct);
  let pnlUsd: number | null = null;
  if (Number.isFinite(pnlSol) && solUsdFallback != null && solUsdFallback > 0) {
    pnlUsd = pnlSol * solUsdFallback;
  }
  return {
    profileId,
    mint: String(e.mint || ''),
    symbol: String(e.symbol || e.mint || '—').slice(0, 24),
    pnlSol: Number.isFinite(pnlSol) ? pnlSol : 0,
    pnlPct: Number.isFinite(pnlPct) ? pnlPct : 0,
    pnlUsd,
    openedAt: Number(e.openedAt) || closedAt,
    closedAt,
    learningMode: e.learningMode === true,
    key: tradeKey({
      id: e.id,
      mint: e.mint,
      openedAt: e.openedAt,
      closedAt: e.closedAt,
      pnlSol: e.pnlSol,
    }),
  };
}

/** Prefer closed-ledger rows when keys collide (richer USD / stamps). */
export function mergePerformanceTrades(
  closed: PerformanceTradeLike[],
  episodesByProfile: Map<string, ProfileLearningEpisode[]>,
  solUsd: number | null
): InternalTrade[] {
  const map = new Map<string, InternalTrade>();

  for (const [, eps] of episodesByProfile) {
    for (const e of eps) {
      const row = toInternalFromEpisode(e, solUsd);
      if (!row) continue;
      map.set(`${row.profileId}:${row.key}`, row);
    }
  }

  for (const t of closed) {
    const row = toInternalFromClosed(t, solUsd);
    if (!row) continue;
    // Prefer closed over episode for same mint/time/pnl; also try episode id-less key
    const k = `${row.profileId}:${row.key}`;
    const altKey = `${row.profileId}:${tradeKey({
      mint: row.mint,
      openedAt: row.openedAt,
      closedAt: row.closedAt,
      pnlSol: row.pnlSol,
    })}`;
    map.set(k, row);
    if (altKey !== k) map.set(altKey, row);
  }

  // Deduplicate by profile+mint+closedAt+pnl after merge (closed may overwrite)
  const byStable = new Map<string, InternalTrade>();
  for (const row of map.values()) {
    const sk = `${row.profileId}|${row.mint}|${row.closedAt}|${row.pnlSol.toFixed(6)}`;
    const prev = byStable.get(sk);
    if (!prev || (prev.pnlUsd == null && row.pnlUsd != null)) {
      byStable.set(sk, row);
    }
  }
  return [...byStable.values()].sort((a, b) => a.closedAt - b.closedAt);
}

export function filterTradesByWindow(
  trades: InternalTrade[],
  window: PerformanceWindow,
  nowMs = Date.now()
): InternalTrade[] {
  const start = windowStartMs(window, nowMs);
  if (start == null) return trades;
  return trades.filter((t) => t.closedAt >= start && t.closedAt <= nowMs);
}

function computeStreaks(sortedAsc: InternalTrade[]): {
  current: PerformanceStreak;
  longestWin: number;
  longestLoss: number;
} {
  if (sortedAsc.length === 0) {
    return { current: { kind: 'flat', length: 0 }, longestWin: 0, longestLoss: 0 };
  }
  let longestWin = 0;
  let longestLoss = 0;
  let runKind: 'win' | 'loss' | null = null;
  let runLen = 0;
  for (const t of sortedAsc) {
    const outcome = classifyTradeOutcomePnlSol(t.pnlSol);
    if (outcome === 'scratch') continue;
    const kind: 'win' | 'loss' = outcome;
    if (kind === runKind) runLen += 1;
    else {
      runKind = kind;
      runLen = 1;
    }
    if (kind === 'win') longestWin = Math.max(longestWin, runLen);
    else longestLoss = Math.max(longestLoss, runLen);
  }
  // Current streak = from most recent backward (skip scratches)
  let curKind: 'win' | 'loss' | null = null;
  let curLen = 0;
  for (let i = sortedAsc.length - 1; i >= 0; i--) {
    const outcome = classifyTradeOutcomePnlSol(sortedAsc[i].pnlSol);
    if (outcome === 'scratch') continue;
    if (curKind == null) {
      curKind = outcome;
      curLen = 1;
      continue;
    }
    if (outcome !== curKind) break;
    curLen += 1;
  }
  return {
    current: {
      kind: curKind ?? 'flat',
      length: curLen,
    },
    longestWin,
    longestLoss,
  };
}

function computeMaxDrawdown(sortedAsc: InternalTrade[]): {
  maxDrawdownSol: number;
  maxDrawdownPct: number;
} {
  // Align with Overview (paperTrader): trough floored at 0, DD capped at 100%.
  // Starting equity from 0 produced absurd % when early peak was tiny vs later losses.
  let equity = 0;
  let peak = 0;
  let maxDdSol = 0;
  let maxDrawdownPct = 0;
  for (const t of sortedAsc) {
    equity += t.pnlSol;
    if (equity > peak) peak = equity;
    const trough = Math.max(0, equity);
    const ddSol = peak - trough;
    if (ddSol > maxDdSol) maxDdSol = ddSol;
    if (peak > 1e-9) {
      const ddPct = (ddSol / peak) * 100;
      if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
    }
  }
  maxDrawdownPct = Math.min(100, maxDrawdownPct);
  return { maxDrawdownSol: maxDdSol, maxDrawdownPct };
}

function profitFactor(grossWins: number, grossLossesAbs: number): number {
  if (grossLossesAbs <= 1e-12) {
    return grossWins > 0 ? PROFIT_FACTOR_INF : 0;
  }
  return grossWins / grossLossesAbs;
}

function metricsForTrades(
  profileId: string,
  meta: CatalogEntry,
  trades: InternalTrade[],
  opts: {
    learningModeOptIn: boolean;
    globalLearningMode: boolean;
  }
): Omit<MicroBotPerformanceRow, 'rank' | 'band'> {
  const wins = trades.filter((t) => isWinPnlSol(t.pnlSol));
  const losses = trades.filter((t) => isLossPnlSol(t.pnlSol));
  const winPcts = wins.map((t) => t.pnlPct);
  const lossPcts = losses.map((t) => t.pnlPct);
  const netPnlSol = trades.reduce((s, t) => s + t.pnlSol, 0);
  const usdParts = trades
    .map((t) => t.pnlUsd)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const netPnlUsd =
    usdParts.length === trades.length && trades.length > 0
      ? usdParts.reduce((a, b) => a + b, 0)
      : usdParts.length > 0
        ? usdParts.reduce((a, b) => a + b, 0)
        : null;
  const grossWins = wins.reduce((s, t) => s + t.pnlSol, 0);
  const grossLossesAbs = Math.abs(
    losses.reduce((s, t) => s + Math.min(0, t.pnlSol), 0)
  );
  const holds = trades
    .filter((t) => t.closedAt > t.openedAt)
    .map((t) => (t.closedAt - t.openedAt) / 1000);
  const avgHoldSec =
    holds.length > 0 ? holds.reduce((a, b) => a + b, 0) / holds.length : 0;
  const avgPnlPct =
    trades.length > 0
      ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length
      : 0;
  const avgPnlPctWinners =
    winPcts.length > 0
      ? winPcts.reduce((a, b) => a + b, 0) / winPcts.length
      : null;
  const avgPnlPctLosers =
    lossPcts.length > 0
      ? lossPcts.reduce((a, b) => a + b, 0) / lossPcts.length
      : null;

  let best: PerformanceExtremeTrade | null = null;
  let worst: PerformanceExtremeTrade | null = null;
  for (const t of trades) {
    const ex: PerformanceExtremeTrade = {
      symbol: t.symbol,
      mint: t.mint || undefined,
      pnlPct: t.pnlPct,
      pnlSol: t.pnlSol,
      closedAt: t.closedAt,
    };
    if (!best || t.pnlPct > best.pnlPct) best = ex;
    if (!worst || t.pnlPct < worst.pnlPct) worst = ex;
  }

  const streaks = computeStreaks(trades);
  const dd = computeMaxDrawdown(trades);
  const lmTrades = trades.filter((t) => t.learningMode).length;
  const decided = wins.length + losses.length;

  return {
    profileId,
    name: meta.name,
    icon: meta.icon,
    color: meta.color,
    enabled: meta.enabled !== false,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: winRatePctFromWl(wins.length, losses.length),
    avgPnlPct,
    avgPnlPctWinners,
    avgPnlPctLosers,
    netPnlSol,
    netPnlUsd,
    profitFactor: profitFactor(grossWins, grossLossesAbs),
    maxDrawdownSol: dd.maxDrawdownSol,
    maxDrawdownPct: dd.maxDrawdownPct,
    avgHoldSec,
    bestTrade: best,
    worstTrade: worst,
    currentStreak: streaks.current,
    longestWinStreak: streaks.longestWin,
    longestLossStreak: streaks.longestLoss,
    learningModeOptIn: opts.learningModeOptIn,
    learningModeTrades: lmTrades,
    learningModeActive: opts.globalLearningMode && opts.learningModeOptIn,
    diagnostics: {
      wrConsistent: wrDisplayConsistent({
        wins: wins.length,
        losses: losses.length,
        winRatePct: winRatePctFromWl(wins.length, losses.length),
      }),
      decidedTrades: decided,
    },
  };
}

function compareRankRows(
  a: Omit<MicroBotPerformanceRow, 'rank' | 'band'>,
  b: Omit<MicroBotPerformanceRow, 'rank' | 'band'>
): number {
  if (b.profitFactor !== a.profitFactor) return b.profitFactor - a.profitFactor;
  if (b.winRatePct !== a.winRatePct) return b.winRatePct - a.winRatePct;
  if (b.netPnlSol !== a.netPnlSol) return b.netPnlSol - a.netPnlSol;
  if (a.maxDrawdownSol !== b.maxDrawdownSol) {
    return a.maxDrawdownSol - b.maxDrawdownSol;
  }
  return a.name.localeCompare(b.name);
}

export function assignRanksAndBands(
  rows: Array<Omit<MicroBotPerformanceRow, 'rank' | 'band'>>
): MicroBotPerformanceRow[] {
  const withTrades = rows
    .filter((r) => r.trades > 0)
    .slice()
    .sort(compareRankRows);
  const rankMap = new Map<string, number>();
  withTrades.forEach((r, i) => rankMap.set(r.profileId, i + 1));

  const n = withTrades.length;
  const underStart = n >= 3 ? Math.max(n - Math.ceil(n / 3) + 1, 4) : n + 1;

  return rows
    .map((r) => {
      const rank = rankMap.get(r.profileId) ?? null;
      let band: PerformanceBand = 'none';
      if (rank != null) {
        if (rank <= 3) band = 'top';
        else if (rank >= underStart) band = 'under';
        else band = 'mid';
      }
      return { ...r, rank, band };
    })
    .sort((a, b) => {
      if (a.rank == null && b.rank == null) {
        return a.name.localeCompare(b.name);
      }
      if (a.rank == null) return 1;
      if (b.rank == null) return -1;
      return a.rank - b.rank;
    });
}

export function buildMicroBotPerformance(opts: {
  closed: PerformanceTradeLike[];
  catalog: CatalogEntry[];
  window?: PerformanceWindow;
  solUsd?: number | null;
  globalLearningMode?: boolean;
  learningModeOptIn?: Partial<Record<string, boolean>>;
  /** Inject episodes for tests; default loads from disk per catalog id */
  episodesByProfile?: Map<string, ProfileLearningEpisode[]>;
  nowMs?: number;
}): MicroBotPerformanceReport {
  const window = parsePerformanceWindow(opts.window, '7d');
  const nowMs = opts.nowMs ?? Date.now();
  const solUsd =
    opts.solUsd != null && Number.isFinite(opts.solUsd) && opts.solUsd > 0
      ? Number(opts.solUsd)
      : null;
  const globalLm = opts.globalLearningMode === true;

  const episodesByProfile =
    opts.episodesByProfile ??
    (() => {
      const m = new Map<string, ProfileLearningEpisode[]>();
      for (const p of opts.catalog) {
        if (p.id === 'default') continue;
        try {
          m.set(p.id, getProfileLearningEpisodes(p.id, 400));
        } catch {
          m.set(p.id, []);
        }
      }
      return m;
    })();

  const merged = mergePerformanceTrades(
    opts.closed,
    episodesByProfile,
    solUsd
  );
  const filtered = filterTradesByWindow(merged, window, nowMs);

  const byProfile = new Map<string, InternalTrade[]>();
  for (const t of filtered) {
    const list = byProfile.get(t.profileId) || [];
    list.push(t);
    byProfile.set(t.profileId, list);
  }

  const rawRows: Array<Omit<MicroBotPerformanceRow, 'rank' | 'band'>> = [];
  for (const p of opts.catalog) {
    if (p.id === 'default') continue;
    const trades = (byProfile.get(p.id) || []).slice().sort(
      (a, b) => a.closedAt - b.closedAt
    );
    const optIn =
      opts.learningModeOptIn?.[p.id] === undefined
        ? true
        : opts.learningModeOptIn[p.id] === true;
    rawRows.push(
      metricsForTrades(p.id, p, trades, {
        learningModeOptIn: optIn,
        globalLearningMode: globalLm,
      })
    );
  }

  // Include orphan profiles that appear in trades but not catalog
  for (const [pid, trades] of byProfile) {
    if (opts.catalog.some((c) => c.id === pid)) continue;
    if (pid === 'default') continue;
    const sample = trades[0];
    rawRows.push(
      metricsForTrades(
        pid,
        {
          id: pid,
          name: pid,
          icon: '•',
          color: '#94a3b8',
          enabled: true,
        },
        trades.slice().sort((a, b) => a.closedAt - b.closedAt),
        {
          learningModeOptIn: true,
          globalLearningMode: globalLm,
        }
      )
    );
    void sample;
  }

  return {
    window,
    rows: assignRanksAndBands(rawRows),
    rankedAt: nowMs,
    solUsd,
    globalLearningMode: globalLm,
  };
}

export interface OverviewWindowStats {
  window: OverviewStatsWindow;
  winRatePct: number;
  wins: number;
  losses: number;
  closedTrades: number;
  /** Closed in window + currently open (open only counted on `all`). */
  totalTrades: number;
  openTrades: number;
  maxDrawdownPct: number;
  avgHoldSec: number;
  profitFactor: number;
  avgWinPct: number;
  avgLossPct: number;
  netPnlSol: number;
  sampleSize: number;
  rankedAt: number;
  /** True when All window W/L/WR use lifetime counters over the sample ring. */
  lifetimeOverlay?: boolean;
  diagnostics?: {
    wrConsistent: boolean;
    note?: string;
  };
}

/**
 * Aggregate overview strip metrics for a time window (closed + durable episodes).
 */
export function buildOverviewWindowStats(opts: {
  closed: PerformanceTradeLike[];
  openCount?: number;
  window?: OverviewStatsWindow | string;
  solUsd?: number | null;
  catalogIds?: string[];
  episodesByProfile?: Map<string, ProfileLearningEpisode[]>;
  nowMs?: number;
  /** When window=all, prefer these lifetime counters if larger than sample. */
  lifetime?: { closed: number; wins: number; losses: number } | null;
}): OverviewWindowStats {
  const window = parseOverviewStatsWindow(opts.window, 'all');
  const nowMs = opts.nowMs ?? Date.now();
  const solUsd =
    opts.solUsd != null && Number.isFinite(opts.solUsd) && opts.solUsd > 0
      ? Number(opts.solUsd)
      : null;
  const openTrades = Math.max(0, Math.round(Number(opts.openCount) || 0));

  let filtered: InternalTrade[];

  if (window === 'now') {
    // Live session view: current on-screen closed only — no episode overlay,
    // no historical time window, no lifetime counter substitution.
    filtered = sessionClosedTrades(opts.closed || [], solUsd);
  } else {
    const catalogIds =
      opts.catalogIds && opts.catalogIds.length
        ? opts.catalogIds
        : Array.from(
            new Set(
              (opts.closed || [])
                .map((t) => String(t.tradeProfileId || '').trim())
                .filter(Boolean)
            )
          );

    const episodesByProfile =
      opts.episodesByProfile ??
      (() => {
        const m = new Map<string, ProfileLearningEpisode[]>();
        for (const id of catalogIds) {
          if (!id || id === 'default') continue;
          try {
            m.set(id, getProfileLearningEpisodes(id, 400));
          } catch {
            m.set(id, []);
          }
        }
        return m;
      })();

    const merged = mergePerformanceTrades(
      opts.closed || [],
      episodesByProfile,
      solUsd
    );
    filtered = filterTradesByWindow(
      merged,
      window as '1h' | '24h' | '7d' | '30d' | 'all',
      nowMs
    ).sort((a, b) => a.closedAt - b.closedAt);
  }

  const wins = filtered.filter((t) => isWinPnlSol(t.pnlSol));
  const losses = filtered.filter((t) => isLossPnlSol(t.pnlSol));
  let winCount = wins.length;
  let lossCount = losses.length;
  let closedTrades = filtered.length;
  let lifetimeOverlay = false;
  const sampleSize = filtered.length;

  if (
    window === 'all' &&
    opts.lifetime &&
    opts.lifetime.closed > closedTrades
  ) {
    closedTrades = Math.max(0, Math.round(opts.lifetime.closed));
    winCount = Math.max(0, Math.round(opts.lifetime.wins));
    lossCount = Math.max(0, Math.round(opts.lifetime.losses));
    lifetimeOverlay = true;
  }

  const winRatePct = winRatePctFromWl(winCount, lossCount);
  const netPnlSol = filtered.reduce((s, t) => s + t.pnlSol, 0);
  const grossWins = wins.reduce((s, t) => s + t.pnlSol, 0);
  const grossLossesAbs = Math.abs(
    losses.reduce((s, t) => s + Math.min(0, t.pnlSol), 0)
  );
  const avgWinPct =
    wins.length > 0
      ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length
      : 0;
  const avgLossPct =
    losses.length > 0
      ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length
      : 0;
  const holdTimes = filtered
    .filter((t) => t.closedAt > t.openedAt)
    .map((t) => (t.closedAt - t.openedAt) / 1000);
  const avgHoldSec =
    holdTimes.length > 0
      ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length
      : 0;
  const { maxDrawdownPct } = computeMaxDrawdown(filtered);
  const includeOpen = window === 'all' || window === 'now';
  const wrOk = wrDisplayConsistent({
    wins: winCount,
    losses: lossCount,
    winRatePct,
  });

  return {
    window,
    winRatePct,
    wins: winCount,
    losses: lossCount,
    closedTrades,
    totalTrades: closedTrades + (includeOpen ? openTrades : 0),
    openTrades,
    maxDrawdownPct,
    avgHoldSec,
    profitFactor: profitFactor(grossWins, grossLossesAbs),
    avgWinPct,
    avgLossPct,
    netPnlSol,
    sampleSize,
    rankedAt: nowMs,
    lifetimeOverlay,
    diagnostics: {
      wrConsistent: wrOk,
      note: wrOk
        ? undefined
        : `WR ${Math.round(winRatePct)}% ≠ ${winCount}W/(${winCount}+${lossCount})L`,
    },
  };
}
