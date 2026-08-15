/**
 * Smoke: expectancy bottleneck patches (MS late-chase, event exits, Dip disc, MS partial).
 * Run: npx tsx scripts/smokeExpectancyBottleneckPatches.ts
 */
import { evaluateFreshMigrationEligibility } from '../src/tradeProfiles';
import {
  getLateChaseMaxShare,
  isArmedReclaimRelief,
  shouldAbortMsLateChaseBuy,
  shouldBlockUnarmedDipDisc,
} from '../src/expectancyLift';
import { evaluateMigrationEventExit } from '../src/shortTermStrategies';
import { resolveExitPolicy } from '../src/profileTradeIntelligence';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

const postGradBase = {
  isMigration: true,
  migrationFresh: true,
  migrationAgeMs: 40_000,
  marketCapUsd: 50_000,
};

const cold = evaluateFreshMigrationEligibility(postGradBase);
check(
  'post-grad fallback denied without armed grad watch',
  cold.ok === false,
  cold.reason
);

const armedCont = evaluateFreshMigrationEligibility({
  ...postGradBase,
  armedWatch: true,
  setupWatchFamily: 'grad',
});
check(
  'post-grad fallback allowed with armed grad continuity',
  armedCont.ok === true,
  armedCont.reason
);

check('late-chase share cap is 5%', getLateChaseMaxShare() === 0.05);

check(
  'armed reclaim relief denied when lateChase even if ext in [-2,+4]',
  isArmedReclaimRelief({
    armedWatch: true,
    lateChase: true,
    entryStyle: 'migration_hold_reclaim',
    extensionFromLevelPct: 0,
  }) === false
);

check(
  'armed reclaim relief still allowed for non-late near-level',
  isArmedReclaimRelief({
    armedWatch: true,
    lateChase: false,
    entryStyle: 'migration_hold_reclaim',
    extensionFromLevelPct: 1,
  }) === true
);

const msAbort = shouldAbortMsLateChaseBuy({
  profileId: 'migration_sniper',
  lateChaseAtEntry: true,
});
check(
  'MS buy re-gate aborts remapped lateChaseAtEntry',
  msAbort.abort === true,
  msAbort.reason
);

const openedAt = 1_000_000;
const slView = {
  entryPriceSol: 1,
  currentPriceSol: 0.78,
  openedAt,
  nowMs: openedAt + 5_000,
  deadlineMs: openedAt + 12 * 60_000,
  slPct: -15,
  migrated: true,
  migratedAtMs: openedAt,
};
const slCut = evaluateMigrationEventExit(slView);
check(
  't=5s mark -22% → SL exit (no 15s/-35 hold)',
  slCut.type === 'full' && slCut.exitKind === 'scalp_sl',
  slCut.type === 'full' ? slCut.reason : slCut.type
);

const slHold = evaluateMigrationEventExit({
  ...slView,
  currentPriceSol: 0.92,
});
check(
  't=5s mark -8% → no exit (not at SL)',
  slHold.type === 'none'
);

const noPop = evaluateMigrationEventExit({
  ...slView,
  currentPriceSol: 0.99,
  nowMs: openedAt + 75_000,
  highWaterMarkSol: 1,
});
check(
  'post-mig 75s MFE 0 → no-pop exit',
  noPop.type === 'full' && /no-pop/i.test(noPop.reason),
  noPop.type === 'full' ? noPop.reason : noPop.type
);

const holdPop = evaluateMigrationEventExit({
  ...slView,
  currentPriceSol: 1.05,
  nowMs: openedAt + 75_000,
  highWaterMarkSol: 1.05,
  volumeUsd: 1000,
  volumeBaselineUsd: 1000,
});
check(
  'post-mig 75s MFE +5% no spike yet → hold',
  holdPop.type === 'none',
  holdPop.type === 'full' ? holdPop.reason : undefined
);

const flatVol = evaluateMigrationEventExit({
  ...slView,
  currentPriceSol: 1.13,
  nowMs: openedAt + 10_000,
  volumeUsd: 1000,
  volumeBaselineUsd: 1000,
});
check(
  '+13% banks first-spike even when vol is flat',
  flatVol.type === 'full' && flatVol.exitKind === 'mig_first_spike',
  flatVol.type === 'full' ? flatVol.reason : flatVol.type
);

const dipBlock = shouldBlockUnarmedDipDisc({
  profileId: 'dip_buyer',
  armedWatch: false,
  restricted: true,
  expectancyNegative: true,
});
check(
  'unarmed Dip skipped when support_dip_reclaim restricted + E<0',
  dipBlock.skip === true,
  dipBlock.reasonCode
);

const dipArmed = shouldBlockUnarmedDipDisc({
  profileId: 'dip_buyer',
  armedWatch: true,
  restricted: true,
  expectancyNegative: true,
});
check(
  'armed Dip still allowed while restricted',
  dipArmed.skip === false
);

const armedPartial = resolveExitPolicy(
  'migration_sniper',
  { exitPolicy: { earlyPartialTpPct: 14.25 } },
  { armedWatch: true }
);
check(
  'armed MS partial threshold resolves to 6% (not 14.25)',
  armedPartial.earlyPartialTpPct === 6,
  String(armedPartial.earlyPartialTpPct)
);

const discPartial = resolveExitPolicy(
  'migration_sniper',
  { exitPolicy: { earlyPartialTpPct: 14.25 } },
  { armedWatch: false }
);
check(
  'disc MS partial threshold capped at 10%',
  discPartial.earlyPartialTpPct === 10,
  String(discPartial.earlyPartialTpPct)
);

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll expectancy bottleneck patch checks passed');
