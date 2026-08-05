/**
 * Overview window trade import — hydrate session closed + open lists from
 * durable closed positions + learning episodes for the selected stats window.
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
  /** Full open positions for session overlay (not display-only). */
  opens: Position[];
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

function openRowToPosition(p: Partial<Position> & {
  id?: string;
  mint?: string;
  symbol?: string;
  name?: string;
  openedAt?: number;
  tradeMode?: string;
  status?: string;
}): Position {
  const mint = String(p.mint || '');
  const cost =
    Number(p.costSol) > 0
      ? Number(p.costSol)
      : Number(p.initialCostSol) > 0
        ? Number(p.initialCostSol)
        : 0.05;
  const entry = Number(p.entryPriceSol) > 0 ? Number(p.entryPriceSol) : 1;
  return {
    id: String(p.id || `open-${mint.slice(0, 8)}-${Number(p.openedAt) || 0}`),
    mint,
    symbol: String(p.symbol || mint.slice(0, 6) || '—'),
    name: String(p.name || p.symbol || ''),
    entryPriceSol: entry,
    amountTokens: Number(p.amountTokens) || 0,
    costSol: cost,
    initialAmountTokens: Number(p.initialAmountTokens) || Number(p.amountTokens) || 0,
    initialCostSol: Number(p.initialCostSol) || cost,
    takeProfitPct: Number(p.takeProfitPct) || 0,
    stopLossPct: Number(p.stopLossPct) || 0,
    highWaterMarkSol: Number(p.highWaterMarkSol) || entry,
    trailingStopPct: Number(p.trailingStopPct) || 0,
    trailingActive: p.trailingActive === true,
    tiersHit: Array.isArray(p.tiersHit) ? p.tiersHit : [],
    initialRecovered: p.initialRecovered === true,
    partialSellDone: p.partialSellDone === true,
    bagTrimDone: p.bagTrimDone === true,
    solReturned: Number(p.solReturned) || 0,
    strategyKind: p.strategyKind === 'migration' ? 'migration' : 'normal',
    tradeMode: p.tradeMode === 'live' ? 'live' : 'paper',
    realizedPnlSol: Number(p.realizedPnlSol) || 0,
    openedAt: Number(p.openedAt) || Date.now(),
    status: p.status === 'partial' ? 'partial' : 'open',
    tradeProfileId: p.tradeProfileId,
    tradeProfileName: p.tradeProfileName,
    tradeProfileIcon: p.tradeProfileIcon,
    tradeProfileColor: p.tradeProfileColor,
    entryMarketCapUsd: p.entryMarketCapUsd,
    convictionScore: p.convictionScore,
    entrySource: p.entrySource,
    liveTokenAmount: p.liveTokenAmount,
  };
}

/**
 * Build closed Position rows for the selected overview window from
 * in-memory closed + durable learning episodes. Hard-capped at 1000.
 * Also returns open positions that fall in the window for session overlay.
 */
export function collectOverviewWindowTrades(input: {
  closed: PerformanceTradeLike[];
  open: Array<Partial<Position> & {
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

  const openFiltered = (input.open || []).filter((p) => {
    const opened = Number(p.openedAt) || 0;
    if (window !== 'all' && opened < start) return false;
    if (usesRealFunds()) return p.tradeMode === 'live' || !p.tradeMode;
    return p.tradeMode !== 'live';
  });

  const opens = openFiltered.map((p) => openRowToPosition(p));
  const openHints: OverviewImportOpenHint[] = opens.map((p) => ({
    id: p.id,
    mint: p.mint,
    symbol: p.symbol,
    openedAt: p.openedAt,
    tradeMode: p.tradeMode,
  }));

  return {
    ok: true,
    window,
    importedClosed: closed.length,
    openInWindow: opens.length,
    capped,
    closed,
    opens,
    openHints,
  };
}

export { episodeToPosition };
