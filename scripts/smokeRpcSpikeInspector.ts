/**
 * Smoke: RPC Spike Inspector + containment (1.2.378 / 1.2.380 wires).
 * Run: npx tsx scripts/smokeRpcSpikeInspector.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config';
import {
  __ageLaneSamplesForTests,
  __clearHardCallCooldownForTests,
  __endOpenSpikeForTests,
  __forceSpikeRecoveringElapsedForTests,
  __resetRpcSpikeInspectorForTests,
  __setSpikeInspectorUptimeForTests,
  buildRpcSpikeDiagnosis,
  getLastRpcSpikeRecoverReason,
  getSpikeInspectorSnapshot,
  isLaneSpiking,
  noteRpcCall,
  shouldShedPrimaryMonitoring,
  shouldSoftPauseNewEntries,
  withRpcAttemptCap,
} from '../src/rpcSpikeInspector';
import {
  applyExitSendLaneGuard,
  getExitLaneGuardTrips,
  __resetExitLaneGuardTripsForTests,
} from '../src/connection';
import { runDedupedRpcJob, getRpcGateSnapshot } from '../src/rpcGate';
import {
  isRpcWorkloadEnabled,
  shouldIdleIsolate,
} from '../src/rpcWorkloadControl';
import {
  shouldDegradeScannerEnrich,
  shouldSkipScannerTick,
  utilityPollScale,
} from '../src/rpcLoadControl';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

const prevContainment = config.rpc.containmentEnabled;
config.rpc.containmentEnabled = true;
__resetRpcSpikeInspectorForTests();

noteRpcCall({
  lane: 'watchers',
  provider: 'https://solana-mainnet.g.alchemy.com/v2/SECRETKEY',
  method: 'getAccountInfo',
  queueWaitMs: 12,
  networkMs: 1800,
  totalMs: 1812,
  outcome: 'success',
  inFlight: 3,
});

check(
  'watchers hard call starts spike',
  isLaneSpiking('watchers'),
  `status=${getSpikeInspectorSnapshot().watchers.status}`
);
check(
  'watchers spike does not pause Trading entries',
  shouldSoftPauseNewEntries() === false
);
check(
  'watchers spike idles isolate / sheds enrich',
  shouldIdleIsolate() === true && isRpcWorkloadEnabled('dip_setup_watch') === false
);
check(
  'watchers spike does not cap Trading retries',
  withRpcAttemptCap(true, 4) === 4 && withRpcAttemptCap(false, 3) === 3
);

const snap1 = getSpikeInspectorSnapshot();
check(
  'provider labels never leak URLs',
  snap1.watchers.provider === 'Alchemy' ||
    snap1.watchers.provider === 'Alchemy-backup' ||
    snap1.spikes.every((s) => !/^https?:/i.test(s.provider)),
  snap1.watchers.provider
);

noteRpcCall({
  lane: 'primary',
  provider: 'Helius',
  method: 'sendTransaction',
  queueWaitMs: 20,
  networkMs: 2100,
  totalMs: 2120,
  outcome: 'timeout',
  inFlight: 5,
});

check('trading hard call starts spike', isLaneSpiking('primary'));
check(
  'trading spike soft-pauses new entries only',
  shouldSoftPauseNewEntries() === true
);
check(
  'trading spike retry cap 1–2',
  withRpcAttemptCap(true, 4) === 2 && withRpcAttemptCap(false, 3) === 1
);
check(
  'watchers isolate still independent of trading spike',
  shouldIdleIsolate() === true
);

const before = JSON.stringify(getSpikeInspectorSnapshot());
const diag1 = buildRpcSpikeDiagnosis();
const after = JSON.stringify(getSpikeInspectorSnapshot());
const diag2 = buildRpcSpikeDiagnosis();
check('diagnosis GET is side-effect free', before === after);
check(
  'diagnosis includes Cursor preamble',
  diag1.cursorPackage.startsWith('Plan mode only first.') &&
    diag1.cursorPackage.includes('# RPC Spike Diagnosis')
);
check(
  'diagnosis has no secret URLs',
  !/https?:\/\/[^\s]*api[_-]?key/i.test(diag1.reportText) &&
    !/SECRETKEY/i.test(diag1.reportText)
);
check(
  'second diagnosis is stable',
  diag2.reportText.includes('Last 10 spikes') &&
    diag2.cursorPackage.includes(diag1.reportText.slice(0, 40))
);

config.rpc.containmentEnabled = false;
check(
  'containment OFF still records spikes but does not pause/shed',
  isLaneSpiking('primary') &&
    shouldSoftPauseNewEntries() === false &&
    shouldIdleIsolate() === false &&
    isRpcWorkloadEnabled('dip_setup_watch') === true
);
config.rpc.containmentEnabled = true;

__resetRpcSpikeInspectorForTests();
noteRpcCall({
  lane: 'secondary',
  provider: 'Alchemy',
  method: 'getAccountInfo',
  queueWaitMs: 10,
  networkMs: 1800,
  totalMs: 1810,
  outcome: 'success',
  inFlight: 2,
});
check(
  'secondary spike degrades scanner enrich',
  isLaneSpiking('secondary') && shouldDegradeScannerEnrich() === true
);
check(
  'secondary spike does not skip Market/Alpha intake ticks',
  shouldSkipScannerTick('market_scanner').skip === false &&
    shouldSkipScannerTick('alpha_scan').skip === false
);
config.rpc.containmentEnabled = false;
check(
  'containment OFF: secondary spike does not force enrich degrade',
  isLaneSpiking('secondary') && shouldDegradeScannerEnrich() === false
);
config.rpc.containmentEnabled = true;
check(
  'secondary spike does not pause Trading entries',
  shouldSoftPauseNewEntries() === false
);

__resetRpcSpikeInspectorForTests();
noteRpcCall({
  lane: 'utility',
  provider: 'public',
  method: 'getSignaturesForAddress',
  queueWaitMs: 8,
  networkMs: 1800,
  totalMs: 1808,
  outcome: 'success',
  inFlight: 2,
});
const utilScaleOn = utilityPollScale();
check(
  'utility spike slows polls',
  isLaneSpiking('utility') &&
    utilScaleOn.skipActivity === true &&
    utilScaleOn.gapScale >= 2.5 &&
    utilScaleOn.cycleCapScale <= 0.4
);
check(
  'utility spike does not pause Trading entries',
  shouldSoftPauseNewEntries() === false
);
config.rpc.containmentEnabled = false;
const utilScaleOff = utilityPollScale();
check(
  'containment OFF: utility spike does not force poll slowdown',
  isLaneSpiking('utility') &&
    utilScaleOff.skipActivity === false &&
    utilScaleOff.gapScale < 2.5
);
config.rpc.containmentEnabled = true;

__resetRpcSpikeInspectorForTests();
noteRpcCall({
  lane: 'primary',
  provider: 'Helius',
  method: 'sendTransaction',
  queueWaitMs: 20,
  networkMs: 2100,
  totalMs: 2120,
  outcome: 'timeout',
  inFlight: 5,
});
check(
  'primary-only spike does not idle-isolate Watchers',
  isLaneSpiking('primary') && shouldIdleIsolate() === false
);

__resetRpcSpikeInspectorForTests();
config.rpc.containmentEnabled = true;
noteRpcCall({
  lane: 'watchers',
  provider: 'Alchemy',
  method: 'getAccountInfo',
  queueWaitMs: 12,
  networkMs: 1800,
  totalMs: 1812,
  outcome: 'success',
  inFlight: 2,
});
check(
  'boot window stamps post_boot',
  getSpikeInspectorSnapshot().spikes[0]?.class === 'post_boot'
);
__setSpikeInspectorUptimeForTests(130_000);
const hotSnap = getSpikeInspectorSnapshot();
const hotClass = hotSnap.spikes.find((s) => s.lane === 'watchers')?.class;
check(
  'after boot, hot post_boot reclassifies and stays open',
  isLaneSpiking('watchers') &&
    hotClass != null &&
    hotClass !== 'post_boot' &&
    shouldIdleIsolate() === true,
  `class=${hotClass}`
);

__resetRpcSpikeInspectorForTests();
config.rpc.containmentEnabled = true;
noteRpcCall({
  lane: 'primary',
  provider: 'Helius',
  method: 'getAccountInfo',
  queueWaitMs: 10,
  networkMs: 1800,
  totalMs: 1810,
  outcome: 'success',
  inFlight: 1,
});
check('primary post_boot pauses entries', shouldSoftPauseNewEntries() === true);
__ageLaneSamplesForTests('primary', 31_000);
__setSpikeInspectorUptimeForTests(130_000);
__forceSpikeRecoveringElapsedForTests('primary', 45_000);
const recoveredSnap = getSpikeInspectorSnapshot();
check(
  'post_boot stable clear ends spike without a new event',
  isLaneSpiking('primary') === false &&
    shouldSoftPauseNewEntries() === false &&
    recoveredSnap.spikes.some(
      (s) => s.lane === 'primary' && s.recoveredAt != null
    )
);
check(
  'recovered log reason is post_boot_stable_clear',
  readSrc('src/rpcSpikeInspector.ts').includes("reason: 'post_boot_stable_clear'") ||
    readSrc('src/rpcSpikeInspector.ts').includes('post_boot_stable_clear')
);

__resetRpcSpikeInspectorForTests();
config.rpc.containmentEnabled = false;
noteRpcCall({
  lane: 'watchers',
  provider: 'Alchemy',
  method: 'getAccountInfo',
  queueWaitMs: 12,
  networkMs: 1800,
  totalMs: 1812,
  outcome: 'success',
  inFlight: 2,
});
__setSpikeInspectorUptimeForTests(130_000);
getSpikeInspectorSnapshot();
check(
  'containment OFF reclassifies but does not shed',
  isLaneSpiking('watchers') &&
    getSpikeInspectorSnapshot().spikes[0]?.class !== 'post_boot' &&
    shouldIdleIsolate() === false &&
    shouldSoftPauseNewEntries() === false
);
config.rpc.containmentEnabled = true;

function feedUtilityCall(totalMs: number, method = 'getSlot'): void {
  noteRpcCall({
    lane: 'utility',
    provider: 'rpc-url',
    method,
    queueWaitMs: 2,
    networkMs: Math.max(0, totalMs - 2),
    totalMs,
    outcome: 'success',
    inFlight: 1,
  });
}

__resetRpcSpikeInspectorForTests();
config.rpc.containmentEnabled = true;
__setSpikeInspectorUptimeForTests(130_000);
for (let i = 0; i < 8; i++) feedUtilityCall(20);
feedUtilityCall(1800);
check(
  'lone hard call among fast recent samples does not start a utility spike',
  isLaneSpiking('utility') === false &&
    getSpikeInspectorSnapshot().spikes.length === 0
);
check(
  'false hard call does not slow utility polls',
  utilityPollScale().skipActivity === false
);

__resetRpcSpikeInspectorForTests();
config.rpc.containmentEnabled = true;
__setSpikeInspectorUptimeForTests(130_000);
for (let i = 0; i < 8; i++) feedUtilityCall(510);
const hotUtil = getSpikeInspectorSnapshot();
check(
  'sustained utility p95 starts spike as provider_slowness',
  isLaneSpiking('utility') === true &&
    hotUtil.spikes[0]?.class === 'provider_slowness' &&
    utilityPollScale().skipActivity === true,
  `class=${hotUtil.spikes[0]?.class}`
);

__ageLaneSamplesForTests('utility', 31_000);
__forceSpikeRecoveringElapsedForTests('utility', 45_000);
getSpikeInspectorSnapshot();
check('forced recover clears utility spike', isLaneSpiking('utility') === false);
feedUtilityCall(1800);
check(
  'hard-call-only within 30s cooldown does not reopen',
  isLaneSpiking('utility') === false
);
__clearHardCallCooldownForTests('utility');
__ageLaneSamplesForTests('utility', 31_000);
for (let i = 0; i < 8; i++) feedUtilityCall(20);
feedUtilityCall(1800);
check(
  'after cooldown, lone hard call among fast samples still does not reopen',
  isLaneSpiking('utility') === false
);
for (let i = 0; i < 8; i++) feedUtilityCall(510);
check(
  'after cooldown, recent p95 hot reopens utility spike',
  isLaneSpiking('utility') === true
);

__resetRpcSpikeInspectorForTests();
config.rpc.containmentEnabled = false;
__setSpikeInspectorUptimeForTests(130_000);
for (let i = 0; i < 8; i++) feedUtilityCall(510);
check(
  'containment OFF still records p95-hot utility spike but does not slow polls',
  isLaneSpiking('utility') === true &&
    getSpikeInspectorSnapshot().spikes[0]?.class === 'provider_slowness' &&
    utilityPollScale().skipActivity === false
);
config.rpc.containmentEnabled = true;

__resetRpcSpikeInspectorForTests();
config.rpc.containmentEnabled = true;
__setSpikeInspectorUptimeForTests(130_000);
noteRpcCall({
  lane: 'primary',
  provider: 'Helius',
  method: 'sendTransaction',
  queueWaitMs: 20,
  networkMs: 2100,
  totalMs: 2120,
  outcome: 'timeout',
  inFlight: 5,
});
check('history test: primary spike is open', isLaneSpiking('primary') === true);
for (let n = 0; n < 10; n++) {
  __endOpenSpikeForTests('utility');
  for (let i = 0; i < 8; i++) feedUtilityCall(510);
  check(
    'history test: utility p95 spike ' + (n + 1),
    isLaneSpiking('utility') === true
  );
  __endOpenSpikeForTests('utility');
}
const histSnap = getSpikeInspectorSnapshot();
check(
  'open primary spike remains in last-10 after utility churn',
  isLaneSpiking('primary') === true &&
    histSnap.spikes.some((s) => s.lane === 'primary' && s.recoveredAt == null)
);

const tradeSrc = readSrc('src/trade.ts');
check(
  'executeSell wraps live path on primary send_tx',
  /export async function executeSell[\s\S]*runWithRpcRole\(\s*'primary'[\s\S]{0,180}'send_tx'/.test(
    tradeSrc
  )
);
check(
  'executeSell paper path stays local before wrap',
  /export async function executeSell[\s\S]*usesPaperAccounting\(\)[\s\S]*simulateSell[\s\S]*hasRpcRoleContext/.test(
    tradeSrc
  )
);
check(
  'executeBuy pauses entries; executeSell does not',
  /shouldSoftPauseNewEntries/.test(tradeSrc) &&
    !/export async function executeSell[\s\S]*shouldSoftPauseNewEntries/.test(
      tradeSrc
    )
);

const dashSrc = readSrc('src/dashboard.ts');
check(
  'Spike Inspector lives on Stats → RPC panel',
  dashSrc.includes('id="botperf-panel-rpc"') &&
    dashSrc.includes('id="rpc-spike-inspector"') &&
    dashSrc.includes('id="rpc-spike-viewer"')
);
check(
  'diagnosis is generate/copy on-screen, not download-primary',
  dashSrc.includes('generateRpcSpikeDiagnosis') &&
    dashSrc.includes('copyRpcSpikeDiagnosis') &&
    !/rpc-spike[\s\S]{0,400}download/i.test(dashSrc)
);

const serverSrc = readSrc('src/server.ts');
check(
  'GET /api/rpc/spike-diagnosis is read-only',
  /app\.get\('\/api\/rpc\/spike-diagnosis'/.test(serverSrc) &&
    /buildRpcSpikeDiagnosis/.test(serverSrc)
);

const gateSrc = readSrc('src/rpcGate.ts');
check(
  'watchers counted in runDedupedRpcJob',
  /roleHint === 'watchers'/.test(gateSrc)
);
check(
  'acquireRpcLane returns queueWaitMs',
  /queueWaitMs: Math\.max\(0, Date\.now\(\) - waitStartedAt\)/.test(gateSrc)
);

const trendSrc = readSrc('src/trendSetupWatch.ts');
check(
  'trend tick idle-isolates on Watchers spike',
  /shouldIdleIsolate/.test(trendSrc)
);
const scalperSrc = readSrc('src/scalperSetupWatch.ts');
check(
  'scalper tick idle-isolates on Watchers spike',
  /shouldIdleIsolate/.test(scalperSrc)
);
const scannerSrc = readSrc('src/marketScanner.ts');
check(
  'grad-first curve enrich skipped when crudeOnly',
  /if \(!crudeOnly\)[\s\S]{0,180}offerGradWatchesCurveFirst/.test(scannerSrc)
);
const alphaSrc = readSrc('src/alphaScanFeed.ts');
check(
  'AlphaScan uses cache-only curve when degrading',
  /shouldDegradeScannerEnrich\(\)[\s\S]{0,80}fetchBondingCurve/.test(alphaSrc)
);
const connSrc = readSrc('src/connection.ts');
check(
  'utility spike throttles getSlot probes; Helius/Watchers branches unchanged',
  /isLaneSpiking\('utility'\)[\s\S]{0,80}cycle % 3/.test(connSrc) &&
    /Helius \(critical\): every 3rd cycle/.test(connSrc)
);

__resetRpcSpikeInspectorForTests();
config.rpc.containmentEnabled = true;
__setSpikeInspectorUptimeForTests(130_000);
noteRpcCall({
  lane: 'primary',
  provider: 'Helius',
  method: 'getAccountInfo',
  queueWaitMs: 10,
  networkMs: 1800,
  totalMs: 1810,
  outcome: 'success',
  inFlight: 2,
});
check('1.2.386 setup: primary spike open', isLaneSpiking('primary') === true);
__ageLaneSamplesForTests('primary', 31_000);
for (let i = 0; i < 8; i++) {
  noteRpcCall({
    lane: 'primary',
    provider: 'Helius',
    method: 'getSlot',
    queueWaitMs: 2,
    networkMs: 40,
    totalMs: 42,
    outcome: 'success',
    inFlight: 1,
  });
}
noteRpcCall({
  lane: 'primary',
  provider: 'Helius',
  method: 'getSignaturesForAddress',
  queueWaitMs: 2,
  networkMs: 1690,
  totalMs: 1692,
  outcome: 'success',
  inFlight: 1,
});
noteRpcCall({
  lane: 'primary',
  provider: 'Helius',
  method: 'sendRawTransaction',
  queueWaitMs: 5,
  networkMs: 2200,
  totalMs: 2205,
  outcome: 'success',
  inFlight: 1,
});
__forceSpikeRecoveringElapsedForTests('primary', 45_000);
getSpikeInspectorSnapshot();
check(
  'Trading recovers on 30s p95 despite one hard poll + slow send',
  isLaneSpiking('primary') === false &&
    shouldSoftPauseNewEntries() === false &&
    getLastRpcSpikeRecoverReason() === 'trading_p95_stable',
  String(getLastRpcSpikeRecoverReason())
);
check(
  'retry cap returns to configured defaults after recover',
  withRpcAttemptCap(true, 4) === 4 && withRpcAttemptCap(false, 3) === 3
);

__resetExitLaneGuardTripsForTests();
check(
  'watchers-context send pins to primary and trips guard',
  applyExitSendLaneGuard('sendRawTransaction', 'watchers') === 'primary' &&
    getExitLaneGuardTrips() >= 1
);
check(
  'utility-context send pins to primary',
  applyExitSendLaneGuard('sendLegacy', 'utility') === 'primary'
);
check(
  'primary send does not trip extra when already primary',
  applyExitSendLaneGuard('sendRawTransaction', 'primary') === 'primary'
);
check(
  'sendOptimizedTransaction forces primary role',
  /sendOptimizedTransaction[\s\S]{0,900}withRpc\([\s\S]{0,80}'sendRawTransaction'[\s\S]{0,900}'primary'/.test(
    connSrc
  )
);
check(
  'exit send attempt order skips utility/watchers failover',
  /if \(!exitSend\)[\s\S]{0,400}pushUnique\(preferredUtility\)/.test(connSrc)
);

__resetRpcSpikeInspectorForTests();
config.rpc.containmentEnabled = true;
__setSpikeInspectorUptimeForTests(130_000);
noteRpcCall({
  lane: 'primary',
  provider: 'Helius',
  method: 'getAccountInfo',
  queueWaitMs: 10,
  networkMs: 1800,
  totalMs: 1810,
  outcome: 'success',
  inFlight: 1,
});
check(
  'primary spike sheds non-exit monitoring',
  shouldShedPrimaryMonitoring() === true && shouldSoftPauseNewEntries() === true
);
let monitorRuns = 0;
const d1 = runDedupedRpcJob(
  'primary:monitor:getSignaturesForAddress:smoke',
  async () => {
    monitorRuns += 1;
    await new Promise((r) => setTimeout(r, 40));
    return 'a';
  },
  { join: true }
);
const d2 = runDedupedRpcJob(
  'primary:monitor:getSignaturesForAddress:smoke',
  async () => {
    monitorRuns += 1;
    return 'b';
  },
  { join: true }
);
void Promise.all([d1, d2]).then(([r1, r2]) => {
  check(
    'duplicate primary getSignatures joins in-flight (no extra storm)',
    monitorRuns === 1 &&
      r1 === 'a' &&
      r2 === 'a' &&
      getRpcGateSnapshot().lanes.primary.deduped >= 1,
    `runs=${monitorRuns} d1=${r1} d2=${r2}`
  );
  check(
    'meteredFetch dedupes primary monitor methods during spike',
    /PRIMARY_MONITOR_METHODS/.test(connSrc) && /runDedupedRpcJob/.test(connSrc)
  );
  const mevSrc = readSrc('src/mev.ts');
  check(
    'sandwich scan sheds during primary spike; sell path stays open',
    /rpc_containment_shed/.test(mevSrc) &&
      /shouldShedPrimaryMonitoring/.test(mevSrc)
  );

  __resetRpcSpikeInspectorForTests();
  config.rpc.containmentEnabled = prevContainment;

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll RPC spike inspector smoke checks passed.');
});
