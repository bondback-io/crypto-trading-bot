/**
 * Smoke: Micro Bot Performance metrics, streaks, windows, PF-first ranking.
 * Run: npx tsx scripts/smokeMicroBotPerformance.ts
 */
import {
  buildMicroBotPerformance,
  filterTradesByWindow,
  mergePerformanceTrades,
  PROFIT_FACTOR_INF,
  type PerformanceTradeLike,
} from '../src/microBotPerformance';
import type { ProfileLearningEpisode } from '../src/profileLearningEpisodes';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

const now = Date.UTC(2026, 7, 2, 15, 0, 0); // Aug 2 2026 15:00 UTC

const catalog = [
  {
    id: 'scalper',
    name: 'Scalper',
    icon: '⚡',
    color: '#f59e0b',
    enabled: true,
  },
  {
    id: 'dip_buyer',
    name: 'Dip Buyer',
    icon: '↘',
    color: '#38bdf8',
    enabled: true,
  },
  {
    id: 'high_win_rate',
    name: 'High Win-Rate',
    icon: '🎯',
    color: '#a3e635',
    enabled: true,
  },
];

const closed: PerformanceTradeLike[] = [
  // Scalper: W W L → current L1, longest W2
  {
    tradeProfileId: 'scalper',
    mint: 'mintA',
    symbol: 'AAA',
    pnlSol: 0.1,
    pnlPct: 20,
    openedAt: now - 3 * 3600_000,
    closedAt: now - 2.5 * 3600_000,
    learningMode: true,
  },
  {
    tradeProfileId: 'scalper',
    mint: 'mintB',
    symbol: 'BBB',
    pnlSol: 0.2,
    pnlPct: 40,
    openedAt: now - 2 * 3600_000,
    closedAt: now - 1.5 * 3600_000,
    learningMode: true,
  },
  {
    tradeProfileId: 'scalper',
    mint: 'mintC',
    symbol: 'CCC',
    pnlSol: -0.05,
    pnlPct: -10,
    openedAt: now - 1 * 3600_000,
    closedAt: now - 0.5 * 3600_000,
    learningMode: false,
  },
  // Dip: all losses — low PF
  {
    tradeProfileId: 'dip_buyer',
    mint: 'mintD',
    symbol: 'DDD',
    pnlSol: -0.2,
    pnlPct: -25,
    openedAt: now - 5 * 3600_000,
    closedAt: now - 4 * 3600_000,
  },
  {
    tradeProfileId: 'dip_buyer',
    mint: 'mintE',
    symbol: 'EEE',
    pnlSol: -0.1,
    pnlPct: -15,
    openedAt: now - 4 * 3600_000,
    closedAt: now - 3 * 3600_000,
  },
  // HWR: perfect wins — PF = INF, should rank #1
  {
    tradeProfileId: 'high_win_rate',
    mint: 'mintF',
    symbol: 'FFF',
    pnlSol: 0.3,
    pnlPct: 50,
    openedAt: now - 6 * 3600_000,
    closedAt: now - 5 * 3600_000,
    learningMode: true,
  },
  {
    tradeProfileId: 'high_win_rate',
    mint: 'mintG',
    symbol: 'GGG',
    pnlSol: 0.15,
    pnlPct: 25,
    openedAt: now - 8 * 24 * 3600_000,
    closedAt: now - 8 * 24 * 3600_000 + 600_000,
  },
];

const episodes = new Map<string, ProfileLearningEpisode[]>();
episodes.set('scalper', [
  {
    id: 'ep-old',
    at: now - 10 * 24 * 3600_000,
    profileId: 'scalper',
    mint: 'mintOld',
    symbol: 'OLD',
    openedAt: now - 10 * 24 * 3600_000,
    closedAt: now - 10 * 24 * 3600_000 + 1000,
    holdSec: 1,
    pnlPct: 12,
    pnlSol: 0.08,
    exitKey: 'tp',
    exitReason: 'take-profit',
    maxRunupPct: 12,
    maxDrawdownPct: 0,
    givebackFromPeakPct: 0,
    peakUnrealizedPct: 12,
    exitUnrealizedPct: 12,
    paramVersion: 0,
    learningMode: false,
  } as ProfileLearningEpisode,
]);

const merged = mergePerformanceTrades(closed, episodes, 150);
check('merge includes closed + episode', merged.length >= 8, String(merged.length));

const last7 = filterTradesByWindow(merged, '7d', now);
check(
  '7d window drops 10d-old episode',
  !last7.some((t) => t.symbol === 'OLD'),
  String(last7.length)
);
check(
  '7d keeps today scalper trades',
  last7.filter((t) => t.profileId === 'scalper').length === 3
);

const report = buildMicroBotPerformance({
  closed,
  catalog,
  window: '7d',
  solUsd: 150,
  globalLearningMode: true,
  learningModeOptIn: {
    scalper: true,
    dip_buyer: false,
    high_win_rate: true,
  },
  episodesByProfile: episodes,
  nowMs: now,
});

const byId = Object.fromEntries(report.rows.map((r) => [r.profileId, r]));

check('HWR ranks #1 (perfect PF)', byId.high_win_rate?.rank === 1);
check(
  'HWR profit factor capped INF',
  byId.high_win_rate?.profitFactor === PROFIT_FACTOR_INF
);
check('Scalper ranks above Dip', (byId.scalper?.rank ?? 99) < (byId.dip_buyer?.rank ?? 0));
check(
  'Scalper current streak L1',
  byId.scalper?.currentStreak.kind === 'loss' &&
    byId.scalper?.currentStreak.length === 1
);
check('Scalper longest win 2', byId.scalper?.longestWinStreak === 2);
check(
  'Scalper LM trades = 2',
  byId.scalper?.learningModeTrades === 2,
  String(byId.scalper?.learningModeTrades)
);
check('Dip LM active false (opt-out)', byId.dip_buyer?.learningModeActive === false);
check('Scalper LM active true', byId.scalper?.learningModeActive === true);
check(
  'HWR band top',
  byId.high_win_rate?.band === 'top',
  String(byId.high_win_rate?.band)
);
check(
  'Scalper best is BBB +40%',
  byId.scalper?.bestTrade?.symbol === 'BBB' &&
    Math.round(byId.scalper?.bestTrade?.pnlPct || 0) === 40
);
check(
  'Max DD for Dip > 0',
  (byId.dip_buyer?.maxDrawdownSol || 0) > 0,
  String(byId.dip_buyer?.maxDrawdownSol)
);

const allReport = buildMicroBotPerformance({
  closed,
  catalog,
  window: 'all',
  solUsd: 150,
  globalLearningMode: true,
  learningModeOptIn: { scalper: true, dip_buyer: false, high_win_rate: true },
  episodesByProfile: episodes,
  nowMs: now,
});
const scalperAll = allReport.rows.find((r) => r.profileId === 'scalper');
check(
  'All-time includes OLD episode for scalper',
  (scalperAll?.trades || 0) >= 4,
  String(scalperAll?.trades)
);

console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
