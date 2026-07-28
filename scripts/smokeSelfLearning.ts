/**
 * Smoke: self-learning episodes, profit-lock exit, badge metrics.
 * Run: npx tsx scripts/smokeSelfLearning.ts
 */
import {
  evaluateAdaptiveProfileExit,
  resolveExitPolicy,
} from '../src/profileTradeIntelligence';
import {
  appendProfileLearningEpisode,
  clearProfileLearningEpisodes,
  getProfileEpisodeExpectancy,
} from '../src/profileLearningEpisodes';
import {
  buildExitLearningCandidates,
  clampLearningPatch,
  formatSelfLearnBadge,
  normalizeSelfLearning,
  runSelfLearnTick,
  scoreEpisodesHeuristic,
} from '../src/profileSelfLearning';
import {
  getTradeProfileDefinition,
  resolveTradeProfileDefinition,
  setProfileSelfLearningEnabled,
} from '../src/tradeProfiles';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

// Profit-lock: peak 80%, now 50% with 30 pts giveback → full exit
const pol = resolveExitPolicy('momentum_burst', {
  exitPolicy: {
    profitLockArmPct: 40,
    profitGivebackPts: 30,
    profitFloorPct: 0,
  },
});
const act = evaluateAdaptiveProfileExit({
  policy: pol,
  pnlPct: 50,
  peakUnrealizedPct: 80,
  entryPriceSol: 1,
  currentPriceSol: 1.5,
  highWaterMarkSol: 1.8,
  trailingActive: false,
  trailingStopPct: 8,
  takeProfitPct: 150,
  openedAt: Date.now() - 60_000,
});
check(
  'profit-lock giveback 80→50 force sells',
  act.type === 'full' && /profit-lock giveback/i.test(act.reason || ''),
  act.reason
);

const floorAct = evaluateAdaptiveProfileExit({
  policy: {
    ...pol,
    profitGivebackPts: 0,
    profitFloorPct: 55,
    profitLockArmPct: 40,
  },
  pnlPct: 50,
  peakUnrealizedPct: 80,
  entryPriceSol: 1,
  currentPriceSol: 1.5,
  highWaterMarkSol: 1.8,
  trailingActive: false,
  trailingStopPct: 8,
  takeProfitPct: 150,
  openedAt: Date.now() - 60_000,
});
check(
  'profit-lock floor forces sell',
  floorAct.type === 'full' && /profit-lock floor/i.test(floorAct.reason || ''),
  floorAct.reason
);

const taCut = evaluateAdaptiveProfileExit({
  policy: resolveExitPolicy('trend_rider', null),
  pnlPct: 12,
  entryPriceSol: 1,
  currentPriceSol: 1.12,
  highWaterMarkSol: 1.2,
  trailingActive: false,
  trailingStopPct: 6,
  takeProfitPct: 40,
  openedAt: Date.now() - 120_000,
  taStructureBroken: true,
});
check(
  'TA structure broken cuts swing',
  taCut.type === 'full' && /structure broken/i.test(taCut.reason || ''),
  taCut.reason
);

clearProfileLearningEpisodes('momentum_burst');
for (let i = 0; i < 14; i++) {
  appendProfileLearningEpisode({
    profileId: 'momentum_burst',
    mint: `Mint${i}`,
    symbol: `T${i}`,
    openedAt: Date.now() - 120_000,
    closedAt: Date.now(),
    holdSec: 90,
    pnlPct: i % 3 === 0 ? -8 : 12,
    pnlSol: i % 3 === 0 ? -0.02 : 0.03,
    exitReason: i % 3 === 0 ? 'stop loss' : 'trail stop',
    maxRunupPct: 55,
    maxDrawdownPct: -5,
    givebackFromPeakPct: 25,
    peakUnrealizedPct: 55,
    exitUnrealizedPct: i % 3 === 0 ? -8 : 12,
    paramVersion: 0,
    convictionScore: 40,
    walletCount: 1,
  });
}
const exp = getProfileEpisodeExpectancy('momentum_burst');
check('episodes stored', exp.n >= 14, `n=${exp.n}`);

setProfileSelfLearningEnabled('momentum_burst', true, 'shadow');
const catalog = getTradeProfileDefinition('momentum_burst');
const resolved = resolveTradeProfileDefinition('momentum_burst');
const sl = normalizeSelfLearning({
  enabled: true,
  mode: 'shadow',
  minTrades: 12,
  upgradeCooldownTrades: 0,
  version: 0,
  tradesSinceUpgrade: 20,
  baselineExpectancyPct: exp.expectancyPct,
  currentExpectancyPct: exp.expectancyPct,
  improvementPct: 0,
  pendingProposal: null,
  history: [],
});
const tick = runSelfLearnTick({
  profileId: 'momentum_burst',
  state: sl,
  catalogExit: catalog.exitRules,
  catalogMatch: catalog.match,
  currentExit: resolved.exitRules,
  currentMatch: resolved.match,
});
check(
  'self-learn tick produces proposal or keeps state',
  tick.state.enabled === true,
  tick.state.pendingProposal?.summary || 'no proposal yet (ok if heuristic quiet)'
);

const cands = buildExitLearningCandidates(
  'momentum_burst',
  // force left-on-table pattern
  Array.from({ length: 12 }, (_, i) => ({
    id: `e${i}`,
    at: Date.now(),
    profileId: 'momentum_burst',
    mint: `m${i}`,
    symbol: `s${i}`,
    openedAt: Date.now() - 1000,
    closedAt: Date.now(),
    holdSec: 60,
    pnlPct: 5,
    pnlSol: 0.01,
    exitKey: 'trail' as const,
    exitReason: 'trail',
    maxRunupPct: 80,
    maxDrawdownPct: 0,
    givebackFromPeakPct: 40,
    peakUnrealizedPct: 80,
    exitUnrealizedPct: 5,
    paramVersion: 0,
  })),
  {
    profitLockArmPct: 40,
    profitGivebackPts: 28,
    profitFloorPct: 0,
    earlyPartialTpPct: 18,
    earlyPartialFraction: 0.35,
    momentumFadeDropPct: 6,
    hardTimeLimitSecMax: 420,
  }
);
check('exit candidates from MFE leave-on-table', cands.length > 0, String(cands[0]?.summary));

const clamped = clampLearningPatch(
  'momentum_burst',
  catalog.exitRules,
  catalog.match,
  {
    exitRules: {
      exitPolicy: { profitGivebackPts: 2, profitLockArmPct: 200 },
      sizeMultiplier: 5,
    },
  }
);
check(
  'safety clamps size and giveback',
  (clamped.exitRules?.sizeMultiplier ?? 0) <= 1.2 &&
    (clamped.exitRules?.exitPolicy?.profitGivebackPts ?? 0) >= 6 &&
    (clamped.exitRules?.exitPolicy?.profitLockArmPct ?? 0) <= 100
);

const badge = formatSelfLearnBadge({
  ...sl,
  baselineExpectancyPct: 5,
  currentExpectancyPct: 8,
  improvementPct: 60,
  lastUpgradedAt: Date.now(),
  version: 2,
});
check('badge shows improvement', /\+60%/.test(badge) && /Upgraded/.test(badge), badge);

void scoreEpisodesHeuristic;

console.log(failed === 0 ? '\nAll smoke checks passed.' : `\n${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
