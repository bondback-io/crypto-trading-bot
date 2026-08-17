/**
 * Smoke: RPC Spike Inspector + containment (1.2.378 / 1.2.380 wires).
 * Run: npx tsx scripts/smokeRpcSpikeInspector.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config';
import {
  __ageLaneSamplesForTests,
  __ageOpenSpikeStartedAtForTests,
  __clearEntryPauseCooldownForTests,
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
import {
  acquireSpikeAccountInfoCap,
  getRpcGateSnapshot,
  getSpikeAccountInfoInFlight,
  runDedupedRpcJob,
  __resetSpikeAccountInfoCapForTests,
} from '../src/rpcGate';
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
  method: 'getTransaction',
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
  'trading spike retry cap 1–2 on monitor only; exits uncapped',
  withRpcAttemptCap(true, 4) === 4 &&
    withRpcAttemptCap(false, 3) === 2 &&
    withRpcAttemptCap(true, 4, { monitor: true }) === 2 &&
    withRpcAttemptCap(true, 4, { exitSend: true }) === 4
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
  'containment OFF: secondary spike still degrades enrich (independent of containment)',
  isLaneSpiking('secondary') && shouldDegradeScannerEnrich() === true
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
  method: 'getTransaction',
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
  method: 'getTransaction',
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
    getLastRpcSpikeRecoverReason() === 'p95_stable',
  String(getLastRpcSpikeRecoverReason())
);
check(
  'retry cap returns to configured defaults after recover',
  withRpcAttemptCap(true, 4) === 4 && withRpcAttemptCap(false, 3) === 3
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
__ageLaneSamplesForTests('primary', 31_000);
for (let i = 0; i < 8; i++) {
  noteRpcCall({
    lane: 'primary',
    provider: 'Helius',
    method: 'getSlot',
    queueWaitMs: 4,
    networkMs: 246,
    totalMs: 250,
    outcome: 'success',
    inFlight: 1,
  });
}
__forceSpikeRecoveringElapsedForTests('primary', 45_000);
const snap250 = getSpikeInspectorSnapshot();
check(
  '1.2.389 ~250ms window recovers as p95_stable',
  isLaneSpiking('primary') === false &&
    shouldSoftPauseNewEntries() === false &&
    getLastRpcSpikeRecoverReason() === 'p95_stable' &&
    snap250.entryPauseActive === false,
  String(getLastRpcSpikeRecoverReason())
);

__resetRpcSpikeInspectorForTests();
config.rpc.containmentEnabled = true;
__setSpikeInspectorUptimeForTests(130_000);
noteRpcCall({
  lane: 'primary',
  provider: 'Helius',
  method: 'getSignaturesForAddress',
  queueWaitMs: 10,
  networkMs: 1800,
  totalMs: 1810,
  outcome: 'success',
  inFlight: 2,
});
for (let i = 0; i < 8; i++) {
  noteRpcCall({
    lane: 'primary',
    provider: 'Helius',
    method: 'getSlot',
    queueWaitMs: 8,
    networkMs: 400,
    totalMs: 408,
    outcome: 'success',
    inFlight: 2,
  });
}
for (let i = 0; i < 5; i++) {
  noteRpcCall({
    lane: 'primary',
    provider: 'Helius',
    method: 'getSlot',
    queueWaitMs: 4,
    networkMs: 246,
    totalMs: 250,
    outcome: 'success',
    inFlight: 1,
  });
}
__ageOpenSpikeStartedAtForTests('primary', 91_000);
getSpikeInspectorSnapshot();
check(
  '1.2.389 max_age recovers when last 5 probes are under the clear bar',
  isLaneSpiking('primary') === false &&
    getLastRpcSpikeRecoverReason() === 'max_age',
  String(getLastRpcSpikeRecoverReason())
);

__resetRpcSpikeInspectorForTests();
config.rpc.containmentEnabled = true;
__setSpikeInspectorUptimeForTests(130_000);
for (let i = 0; i < 8; i++) {
  noteRpcCall({
    lane: 'primary',
    provider: 'Helius',
    method: 'getSlot',
    queueWaitMs: 8,
    networkMs: 397,
    totalMs: 405,
    outcome: 'success',
    inFlight: 1,
  });
}
check(
  '1.2.393 p95 ~400ms does not start a Trading spike or pause',
  isLaneSpiking('primary') === false &&
    shouldSoftPauseNewEntries() === false &&
    getSpikeInspectorSnapshot().trading.status === 'ok',
  `spike=${isLaneSpiking('primary')} pause=${shouldSoftPauseNewEntries()} status=${getSpikeInspectorSnapshot().trading.status} p95=${getSpikeInspectorSnapshot().trading.p95}`
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
check(
  'hard Trading call pauses entries while p95 is still hot',
  shouldSoftPauseNewEntries() === true
);
for (let i = 0; i < 8; i++) {
  noteRpcCall({
    lane: 'primary',
    provider: 'Helius',
    method: 'getSlot',
    queueWaitMs: 8,
    networkMs: 400,
    totalMs: 408,
    outcome: 'success',
    inFlight: 2,
  });
}
check(
  '1.2.393 ~400ms p95 does not hold entry pause',
  shouldSoftPauseNewEntries() === false,
  `pause=${shouldSoftPauseNewEntries()} spike=${isLaneSpiking('primary')}`
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
for (let i = 0; i < 8; i++) {
  noteRpcCall({
    lane: 'primary',
    provider: 'Helius',
    method: 'getSlot',
    queueWaitMs: 8,
    networkMs: 692,
    totalMs: 700,
    outcome: 'success',
    inFlight: 2,
  });
}
check(
  'pause off at ~700ms (below enter, above clear) while spike can stay open',
  shouldSoftPauseNewEntries() === false && isLaneSpiking('primary') === true
);
__ageOpenSpikeStartedAtForTests('primary', 91_000);
const snapPause = getSpikeInspectorSnapshot();
check(
  '1.2.389 entry pause auto-clears after 90s with 0 timeouts/429s',
  isLaneSpiking('primary') === true &&
    shouldSoftPauseNewEntries() === false &&
    snapPause.entryPauseActive === false &&
    snapPause.entry_pause_auto_cleared >= 1,
  `spike=${isLaneSpiking('primary')} pause=${shouldSoftPauseNewEntries()} cleared=${snapPause.entry_pause_auto_cleared}`
);
__endOpenSpikeForTests('primary');
__clearHardCallCooldownForTests('primary');
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
check(
  '1.2.393 re-pause cooldown blocks immediate re-pause after max_age/auto_clear',
  shouldSoftPauseNewEntries() === false,
  `pause=${shouldSoftPauseNewEntries()} spike=${isLaneSpiking('primary')}`
);
__endOpenSpikeForTests('primary');
__clearHardCallCooldownForTests('primary');
__clearEntryPauseCooldownForTests();
for (let i = 0; i < 8; i++) {
  noteRpcCall({
    lane: 'primary',
    provider: 'Helius',
    method: 'getSlot',
    queueWaitMs: 10,
    networkMs: 940,
    totalMs: 950,
    outcome: 'success',
    inFlight: 2,
  });
}
check(
  '1.2.393 sustained p95 > enter re-pauses after cooldown',
  shouldSoftPauseNewEntries() === true && isLaneSpiking('primary') === true,
  `pause=${shouldSoftPauseNewEntries()} spike=${isLaneSpiking('primary')} p95=${getSpikeInspectorSnapshot().trading.p95}`
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
check(
  'snapshot exposes exit_lane_guard_trips',
  getSpikeInspectorSnapshot().exit_lane_guard_trips >= 1
);
check(
  'primary monitor join includes getAccountInfo and never send_tx',
  (() => {
    const block = connSrc.match(
      /PRIMARY_MONITOR_METHODS = new Set\(\[([\s\S]*?)\]\)/
    );
    const body = block ? block[1] : '';
    return (
      /getAccountInfo/.test(body) &&
      !/sendTransaction/.test(body) &&
      !/sendRaw/.test(body) &&
      !/confirmTransaction/.test(body)
    );
  })()
);

__resetSpikeAccountInfoCapForTests();
__resetRpcSpikeInspectorForTests();
config.rpc.containmentEnabled = true;
noteRpcCall({
  lane: 'watchers',
  provider: 'Alchemy',
  method: 'getAccountInfo',
  queueWaitMs: 10,
  networkMs: 1800,
  totalMs: 1810,
  outcome: 'success',
  inFlight: 3,
});
const gaiA = acquireSpikeAccountInfoCap(
  'watchers',
  ['getAccountInfo'],
  'bonding_curve'
);
const gaiB = acquireSpikeAccountInfoCap(
  'watchers',
  ['getAccountInfo'],
  'token_metrics'
);
const gaiArm = acquireSpikeAccountInfoCap(
  'watchers',
  ['getAccountInfo'],
  'arm_dip'
);
const gaiArm2 = acquireSpikeAccountInfoCap(
  'watchers',
  ['getAccountInfo'],
  'trigger_scalper'
);
check(
  'watchers spike: enrich cap 1, arm/trigger can use 2nd slot, 3rd dropped',
  gaiA.allowed === true &&
    gaiB.allowed === false &&
    gaiArm.allowed === true &&
    gaiArm2.allowed === false &&
    getSpikeAccountInfoInFlight('watchers') === 2,
  `a=${gaiA.allowed} b=${gaiB.allowed} arm=${gaiArm.allowed} arm2=${gaiArm2.allowed} inflight=${getSpikeAccountInfoInFlight('watchers')}`
);
gaiA.release();
gaiB.release();
gaiArm.release();
gaiArm2.release();
check(
  'executeSell still has no containment pause',
  !/export async function executeSell[\s\S]*shouldSoftPauseNewEntries/.test(
    readSrc('src/trade.ts')
  )
);

__resetSpikeAccountInfoCapForTests();
__resetRpcSpikeInspectorForTests();
config.rpc.containmentEnabled = false;
noteRpcCall({
  lane: 'secondary',
  provider: 'alchemy-backup3',
  method: 'getAccountInfo',
  queueWaitMs: 10,
  networkMs: 1800,
  totalMs: 1810,
  outcome: 'success',
  inFlight: 3,
});
const secOffA = acquireSpikeAccountInfoCap(
  'secondary',
  ['getAccountInfo'],
  'bonding_curve'
);
const secOffB = acquireSpikeAccountInfoCap(
  'secondary',
  ['getAccountInfo'],
  'market_scanner'
);
check(
  'containment OFF: secondary spike still sheds enrich getAccountInfo',
  isLaneSpiking('secondary') &&
    secOffA.allowed === true &&
    secOffB.allowed === false,
  `spike=${isLaneSpiking('secondary')} a=${secOffA.allowed} b=${secOffB.allowed}`
);
secOffA.release();
secOffB.release();
check(
  'diagnosis labels Trading/Alchemy not Helius',
  (() => {
    const d = buildRpcSpikeDiagnosis();
    return (
      /Trading \/ Alchemy/.test(d.reportText) &&
      !/Trading \/ Helius/.test(d.reportText) &&
      /Watchers \/ Alchemy-backup2/.test(d.reportText) &&
      /Utility \/ RPC_URL/.test(d.reportText)
    );
  })()
);
check(
  'safeProviderLabel distinguishes backup3',
  (() => {
    const { safeProviderLabel } =
      require('../src/rpcSpikeInspector') as typeof import('../src/rpcSpikeInspector');
    return (
      safeProviderLabel('alchemy-backup3') === 'Alchemy-backup3' &&
      safeProviderLabel('alchemy-backup7') === 'Alchemy-backup7' &&
      safeProviderLabel('alchemy-backup') === 'Alchemy-backup' &&
      safeProviderLabel('alchemy-backup2') === 'Alchemy-backup2'
    );
  })()
);
check(
  'pause_on / pause_off logs include p95 and reason',
  /\[rpc_entry_pause\]/.test(readSrc('src/rpcSpikeInspector.ts')) &&
    /pause_on/.test(readSrc('src/rpcSpikeInspector.ts')) &&
    /pause_off/.test(readSrc('src/rpcSpikeInspector.ts'))
);
check(
  'primary tx monitor skips new polls during shed (join in-flight only)',
  /PRIMARY_TX_MONITOR_METHODS/.test(connSrc) &&
    /startIfMissing:\s*false/.test(connSrc)
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
void Promise.all([d1, d2]).then(async ([r1, r2]) => {
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
  const skipped = await runDedupedRpcJob(
    'primary:monitor:getTransaction:skip-new',
    async () => 'should-not-run',
    { join: true, startIfMissing: false }
  );
  check(
    'shed skips a new getTransaction when none is in-flight',
    skipped === undefined
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
