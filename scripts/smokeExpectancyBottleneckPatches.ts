/**
 * Smoke: expectancy bottleneck patches (MS late-chase, event exits, Dip disc, MS partial).
 * Run: npx tsx scripts/smokeExpectancyBottleneckPatches.ts
 */
import {
  evaluateFreshMigrationEligibility,
  evaluateLaneEntryFloors,
  getTradeProfileDefinition,
  isSwingLaneMustKnowMc,
  swingLaneFillMinMarketCapUsd,
} from '../src/tradeProfiles';
import {
  getLateChaseMaxShare,
  isArmedReclaimRelief,
  shouldAbortMsLateChaseBuy,
  shouldBlockUnarmedDipDisc,
} from '../src/expectancyLift';
import { evaluateMigrationEventExit } from '../src/shortTermStrategies';
import { resolveExitPolicy } from '../src/profileTradeIntelligence';
import { shouldThrottleMigrationAdmit } from '../src/profileAttention';
import { isScannerSetupWatchHandoff } from '../src/marketScanner';
import {
  considerTrendWatchSetup,
  getTrendFunnelCounters,
  scoreTrendDna,
  trendWatchMinDnaHits,
} from '../src/trendSetupWatch';

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

check('late-chase share cap is 35%', getLateChaseMaxShare() === 0.35);

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

const neverMigStall = evaluateMigrationEventExit({
  ...slView,
  migrated: false,
  migratedAtMs: null,
  currentPriceSol: 0.94,
  nowMs: openedAt + 180_000,
  curveProgressPct: 93,
});
check(
  'pre-mig 180s red + curve not near 99 → never-mig stall',
  neverMigStall.type === 'full' && /never-mig stall/i.test(neverMigStall.reason),
  neverMigStall.type === 'full' ? neverMigStall.reason : neverMigStall.type
);

const neverMigNear = evaluateMigrationEventExit({
  ...slView,
  migrated: false,
  migratedAtMs: null,
  currentPriceSol: 0.94,
  nowMs: openedAt + 180_000,
  curveProgressPct: 99.2,
});
check(
  'pre-mig 180s red but curve ≥99 → hold for migrate',
  neverMigNear.type === 'none'
);

const neverMigEarly = evaluateMigrationEventExit({
  ...slView,
  migrated: false,
  migratedAtMs: null,
  currentPriceSol: 0.94,
  nowMs: openedAt + 60_000,
  curveProgressPct: 93,
});
check(
  'pre-mig 60s red → still hold',
  neverMigEarly.type === 'none'
);

const msShareCap = shouldThrottleMigrationAdmit({
  profileId: 'migration_sniper',
  familyState: 'restricted',
  migrationShare: 0.68,
  attentionTotal: 30,
});
check(
  'MS attention cap binds when family restricted and share 68%',
  msShareCap.throttle === true,
  msShareCap.reason
);

const msShareOk = shouldThrottleMigrationAdmit({
  profileId: 'migration_sniper',
  familyState: 'restricted',
  migrationShare: 0.2,
  attentionTotal: 30,
});
check(
  'MS attention cap idle under 32% even if restricted',
  msShareOk.throttle === false
);

const msShareNeutral = shouldThrottleMigrationAdmit({
  profileId: 'migration_sniper',
  familyState: 'neutral',
  migrationShare: 0.68,
  attentionTotal: 30,
});
check(
  'MS attention cap idle when family neutral',
  msShareNeutral.throttle === false
);

const dipDef = getTradeProfileDefinition('dip_buyer');
const dip350 = {
  ...dipDef,
  match: { ...dipDef.match, minMarketCapUsd: 350_000 },
};
const dipUnknown = evaluateLaneEntryFloors(dip350, {
  armedWatch: true,
  setupWatchFamily: 'dip',
  marketCapUsd: null,
});
check(
  'armed Dip unknown MC hard-fails',
  dipUnknown.ok === false && /mc unknown/i.test(String(dipUnknown.reason || '')),
  dipUnknown.reason
);

const dipLow = evaluateLaneEntryFloors(dip350, {
  armedWatch: true,
  setupWatchFamily: 'dip',
  marketCapUsd: 20_000,
});
check(
  'armed Dip $20k fails vs $350k lane min',
  dipLow.ok === false && /lane min/i.test(String(dipLow.reason || '')),
  dipLow.reason
);

const dipOk = evaluateLaneEntryFloors(dip350, {
  armedWatch: true,
  setupWatchFamily: 'dip',
  marketCapUsd: 400_000,
});
check(
  'armed Dip $400k passes MC floor',
  dipOk.ok === true ||
    (dipOk.ok === false &&
      !/mc unknown|lane min/i.test(String(dipOk.reason || ''))),
  dipOk.reason
);

const trendUnknown = evaluateLaneEntryFloors(
  getTradeProfileDefinition('trend_rider'),
  {
    armedWatch: true,
    setupWatchFamily: 'trend',
    marketCapUsd: null,
  }
);
check(
  'armed Trend unknown MC hard-fails',
  trendUnknown.ok === false &&
    /mc unknown/i.test(String(trendUnknown.reason || '')),
  trendUnknown.reason
);

const msDef = getTradeProfileDefinition('migration_sniper');
const msWithMin = {
  ...msDef,
  match: { ...msDef.match, minMarketCapUsd: 15_000 },
};
const msUnknown = evaluateLaneEntryFloors(msWithMin, {
  armedWatch: true,
  setupWatchFamily: 'grad',
  marketCapUsd: null,
  isMigration: true,
});
check(
  'armed Grad MS unknown MC still soft-pass',
  msUnknown.ok === true,
  msUnknown.reason
);

check(
  'isSwingLaneMustKnowMc dip + trend only',
  isSwingLaneMustKnowMc('dip_buyer') &&
    isSwingLaneMustKnowMc('trend_rider') &&
    !isSwingLaneMustKnowMc('migration_sniper') &&
    !isSwingLaneMustKnowMc('scalper')
);
check(
  'swingLaneFillMinMarketCapUsd MS is 0',
  swingLaneFillMinMarketCapUsd('migration_sniper') === 0
);
check(
  'swingLaneFillMinMarketCapUsd Dip ≥ $350k',
  swingLaneFillMinMarketCapUsd('dip_buyer') >= 350_000,
  String(swingLaneFillMinMarketCapUsd('dip_buyer'))
);

check(
  'isScannerSetupWatchHandoff trend_rider',
  isScannerSetupWatchHandoff('trend_rider', '') === true
);
check(
  'isScannerSetupWatchHandoff trend-watch:triggered',
  isScannerSetupWatchHandoff('scalper', 'trend-watch:triggered foo') === true
);
check(
  'isScannerSetupWatchHandoff random scanner false',
  isScannerSetupWatchHandoff('steady_compounder', 'scanner pick') === false
);

check(
  'trend DNA minHits 3 for Jupiter specialty',
  trendWatchMinDnaHits({ specialtyFeed: 'jupiter', marketCapUsd: 4_200_000 }) === 3
);
check(
  'trend DNA minHits 4 without specialty under $5M',
  trendWatchMinDnaHits({ marketCapUsd: 4_200_000 }) === 4
);
check(
  'trend DNA minHits 3 at ≥$5M',
  trendWatchMinDnaHits({ marketCapUsd: 6_000_000 }) === 3
);

const dna42jup = scoreTrendDna({
  marketCapUsd: 4_200_000,
  volumeH1Usd: 20_000,
  holderCount: 200,
  specialtyFeed: 'jupiter',
});
check(
  'trend DNA $4.2M Jupiter H1+holders = 3 hits',
  dna42jup.hits === 3,
  String(dna42jup.hits) + ' ' + dna42jup.reasons.join(',')
);

const blockedBefore = getTrendFunnelCounters().blocked;
const skip20k = considerTrendWatchSetup({
  mint: 'TrendSmoke20kMint111111111111111111111',
  symbol: 'T20K',
  marketCapUsd: 20_000,
  volumeH1Usd: 20_000,
  holderCount: 200,
  specialtyFeed: 'jupiter',
});
const skipNull = considerTrendWatchSetup({
  mint: 'TrendSmokeNullMint11111111111111111111',
  symbol: 'TNULL',
  marketCapUsd: undefined,
  volumeH1Usd: 20_000,
  holderCount: 200,
  specialtyFeed: 'jupiter',
});
check(
  'Trend watch $20k / unknown MC silent skip (blocked unchanged)',
  skip20k == null &&
    skipNull == null &&
    getTrendFunnelCounters().blocked === blockedBefore
);

const admit6m = considerTrendWatchSetup({
  mint: 'TrendSmoke6mMint1111111111111111111111',
  symbol: 'T6M',
  marketCapUsd: 6_000_000,
  volumeH1Usd: 20_000,
  holderCount: 200,
  specialtyFeed: 'jupiter',
});
check(
  'Trend watch $6M Jupiter H1+holders admits',
  admit6m != null &&
    (admit6m.status === 'watching' || admit6m.status === 'armed'),
  admit6m?.lastReason
);

const admit42 = considerTrendWatchSetup({
  mint: 'TrendSmoke42mMint111111111111111111111',
  symbol: 'T42J',
  marketCapUsd: 4_200_000,
  volumeH1Usd: 20_000,
  holderCount: 200,
  specialtyFeed: 'jupiter',
});
check(
  'Trend watch $4.2M Jupiter 3 DNA hits admits',
  admit42 != null,
  admit42?.lastReason
);

const blockedMid = getTrendFunnelCounters().blocked;
const deny42 = considerTrendWatchSetup({
  mint: 'TrendSmoke42nMint111111111111111111111',
  symbol: 'T42N',
  marketCapUsd: 4_200_000,
  volumeH1Usd: 20_000,
  holderCount: 200,
  priceChangeH1Pct: 10,
});
check(
  'Trend watch $4.2M without specialty 3 DNA hits blocked',
  deny42 == null && getTrendFunnelCounters().blocked === blockedMid + 1
);

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll expectancy bottleneck patch checks passed');
