/**
 * Overview window trade import — hydrate session closed list from durable
 * closed positions + learning episodes for the selected stats window.
 * Cap 1000 for All (and as a hard ceiling for any window).
 */

import {
  filterTradesByWindow,
  mergePerformanceTrades,
  parseOverviewStatsWindow,
  type OverviewStatsWindow,
  type PerformanceTradeLike,
} from './microBotPerformance';
import { getProfileLearningEpisodes } from './profileLearningEpisodes';
import type { Position } from './paperTrader';
import { usesRealFunds } from './config';

export const OVERVIEW_IMPORT_MAX_TRADES = 1000;

export interface OverviewImportOpenHint {
  id: string;
  mint: string;
  symbol: string;
  openedAt: number;
  tradeMode?: string;
}

export interface OverviewImportResult {
  ok: true;
  window: OverviewStatsWindow;
  importedClosed: number;
  openInWindow: number;
  capped: boolean;
  closed: Position[];
  openHints: OverviewImportOpenHint[];
}

function episodeToPosition(e: {
  id?: string;
  profileId: string;
  mint: string;
  symbol: string;
  openedAt: number;
  closedAt: number;
  holdSec?: number;
  pnlPct: number;
  pnlSol: number;
  exitReason?: string;
  entryMarketCapUsd?: number;
  convictionScore?: number;
  entrySource?: string;
  learningMode?: boolean;
}): Position {
  const openedAt = Number(e.openedAt) || Number(e.closedAt) || Date.now();
  const closedAt = Number(e.closedAt) || openedAt;
  const costSol = Math.max(0.001, Math.abs(Number(e.pnlSol) || 0) * 2 || 0.05);
  const entry = 1;
  const exit =
    Number.isFinite(e.pnlPct) && e.pnlPct !== 0
      ? entry * (1 + Number(e.pnlPct) / 100)
      : entry;
  return {
    id: String(e.id || `imp-${e.mint.slice(0, 8)}-${closedAt}`),
    mint: e.mint,
    symbol: e.symbol || e.mint.slice(0, 6),
    name: e.symbol || '',
    entryPriceSol: entry,
    amountTokens: 0,
    costSol,
    initialAmountTokens: 0,
    initialCostSol: costSol,
    takeProfitPct: 0,
    stopLossPct: 0,
    highWaterMarkSol: Math.max(entry, exit),
    trailingStopPct: 0,
    trailingActive: false,
    tiersHit: [],
    initialRecovered: false,
    partialSellDone: false,
    bagTrimDone: false,
    solReturned: 0,
    strategyKind: 'normal',
    tradeMode: usesRealFunds() ? 'live' : 'paper',
    realizedPnlSol: Number(e.pnlSol) || 0,
    openedAt,
    closedAt,
    exitPriceSol: exit,
    pnlSol: Number(e.pnlSol) || 0,
    pnlPct: Number(e.pnlPct) || 0,
    status: 'closed',
    reason: e.exitReason || 'imported',
    tradeProfileId: e.profileId,
    convictionScore: e.convictionScore,
    entryMarketCapUsd: e.entryMarketCapUsd,
    entrySource: (e.entrySource as Position['entrySource']) || undefined,
    learningMode: e.learningMode === true ? true : undefined,
  };
}

function tradeLikeToPosition(
  t: PerformanceTradeLike & { exitReason?: string; key?: string }
): Position {
  const openedAt = Number(t.openedAt) || Number(t.closedAt) || Date.now();
  const closedAt = Number(t.closedAt) || openedAt;
  const costSol = Math.max(0.001, Math.abs(Number(t.pnlSol) || 0) * 2 || 0.05);
  const entry = 1;
  const exit =
    Number.isFinite(Number(t.pnlPct)) && Number(t.pnlPct) !== 0
      ? entry * (1 + Number(t.pnlPct) / 100)
      : entry;
  return {
    id: String(t.id || `imp-${String(t.mint || '').slice(0, 8)}-${closedAt}`),
    mint: String(t.mint || ''),
    symbol: String(t.symbol || '').slice(0, 24) || '—',
    name: String(t.symbol || ''),
    entryPriceSol: entry,
    amountTokens: 0,
    costSol,
    initialAmountTokens: 0,
    initialCostSol: costSol,
    takeProfitPct: 0,
    stopLossPct: 0,
    highWaterMarkSol: Math.max(entry, exit),
    trailingStopPct: 0,
    trailingActive: false,
    tiersHit: [],
    initialRecovered: false,
    partialSellDone: false,
    bagTrimDone: false,
    solReturned: 0,
    strategyKind: 'normal',
    tradeMode: usesRealFunds() ? 'live' : 'paper',
    realizedPnlSol: Number(t.pnlSol) || 0,
    openedAt,
    closedAt,
    exitPriceSol: exit,
    pnlSol: Number(t.pnlSol) || 0,
    pnlPct: Number(t.pnlPct) || 0,
    status: 'closed',
    reason: 'imported',
    tradeProfileId: t.tradeProfileId,
    tradeProfileName: t.tradeProfileName,
    tradeProfileIcon: t.tradeProfileIcon,
    tradeProfileColor: t.tradeProfileColor,
    learningMode: t.learningMode === true ? true : undefined,
  };
}

/**
 * Build closed Position rows for the selected overview window from
 * in-memory closed + durable learning episodes. Hard-capped at 1000.
 */
export function collectOverviewWindowTrades(input: {
  closed: PerformanceTradeLike[];
  open: Array<{
    id?: string;
    mint?: string;
    symbol?: string;
    openedAt?: number;
    tradeMode?: string;
    status?: string;
  }>;
  window: string;
  catalogIds?: string[];
  solUsd?: number | null;
  nowMs?: number;
  /** Extra closed rows (e.g. live wallet history) */
  extraClosed?: PerformanceTradeLike[];
}): OverviewImportResult {
  const window = parseOverviewStatsWindow(input.window, 'all');
  const nowMs = input.nowMs ?? Date.now();
  const catalogIds =
    input.catalogIds && input.catalogIds.length
      ? input.catalogIds
      : Array.from(
          new Set(
            (input.closed || [])
              .map((t) => String(t.tradeProfileId || '').trim())
              .filter((id) => id && id !== 'default')
          )
        );

  const episodesByProfile = new Map<
    string,
    ReturnType<typeof getProfileLearningEpisodes>
  >();
  for (const id of catalogIds) {
    if (!id || id === 'default') continue;
    try {
      episodesByProfile.set(id, getProfileLearningEpisodes(id, 400));
    } catch {
      episodesByProfile.set(id, []);
    }
  }

  const baseClosed = [
    ...(input.closed || []),
    ...(input.extraClosed || []),
  ];

  // Live mode: never pull paper/sim closed into the import set
  const modeFiltered = usesRealFunds()
    ? baseClosed.filter((t) => {
        const mode = (t as { tradeMode?: string }).tradeMode;
        return mode == null || mode === 'live';
      })
    : baseClosed.filter((t) => {
        const mode = (t as { tradeMode?: string }).tradeMode;
        return mode !== 'live';
      });

  const merged = mergePerformanceTrades(
    modeFiltered,
    episodesByProfile,
    input.solUsd ?? null
  );
  let filtered = filterTradesByWindow(merged, window, nowMs).sort(
    (a, b) => b.closedAt - a.closedAt
  );

  const capped = filtered.length > OVERVIEW_IMPORT_MAX_TRADES;
  if (capped) {
    filtered = filtered.slice(0, OVERVIEW_IMPORT_MAX_TRADES);
  }

  const closed = filtered.map((t) =>
    tradeLikeToPosition({
      id: t.key,
      mint: t.mint,
      symbol: t.symbol,
      pnlSol: t.pnlSol,
      pnlPct: t.pnlPct,
      openedAt: t.openedAt,
      closedAt: t.closedAt,
      tradeProfileId: t.profileId,
      learningMode: t.learningMode,
    })
  );

  const start =
    window === 'all'
      ? 0
      : window === '1h'
        ? nowMs - 3600_000
        : window === '24h'
          ? nowMs - 86400_000
          : window === '7d'
            ? nowMs - 7 * 86400_000
            : nowMs - 30 * 86400_000;

  const openHints: OverviewImportOpenHint[] = (input.open || [])
    .filter((p) => {
      const opened = Number(p.openedAt) || 0;
      if (window !== 'all' && opened < start) return false;
      if (usesRealFunds()) return p.tradeMode === 'live' || !p.tradeMode;
      return p.tradeMode !== 'live';
    })
    .map((p) => ({
      id: String(p.id || p.mint || ''),
      mint: String(p.mint || ''),
      symbol: String(p.symbol || ''),
      openedAt: Number(p.openedAt) || 0,
      tradeMode: p.tradeMode,
    }));

  return {
    ok: true,
    window,
    importedClosed: closed.length,
    openInWindow: openHints.length,
    capped,
    closed,
    openHints,
  };
}

export { episodeToPosition };
