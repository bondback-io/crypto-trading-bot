/**
 * Smoke: post-4min Trading lag / Favourites congestion patches.
 * Run: npx tsx scripts/smokePost4minRpcSpike.ts
 */
import {
  isMigrationSeedOnly,
  migrationPollWeight,
  MIGRATION_POST_START_SEED_MS,
  MIGRATION_PROBE_WARM_MS,
} from '../src/migrationListener';
import { isTradingLaneWedged, shouldDeferBackgroundForCritical } from '../src/rpcGate';
import {
  SIGNALS_RPC_HEALTHY_MS,
  isSignalsRpcHealthy,
  getRpcLoadControlSnapshot,
  updateRpcLoadSignals,
} from '../src/rpcLoadControl';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

const started = 1_000_000;
check(
  'seed-only for 90s after listener start',
  isMigrationSeedOnly({
    bootSettling: false,
    listenerStartedAt: started,
    now: started + MIGRATION_POST_START_SEED_MS - 1,
    allowParseAt: started,
  }) === true
);
check(
  'full polls allowed after 90s seed window',
  isMigrationSeedOnly({
    bootSettling: false,
    listenerStartedAt: started,
    now: started + MIGRATION_POST_START_SEED_MS,
    allowParseAt: started,
  }) === false
);
check(
  'boot settling stays seed-only even after 90s',
  isMigrationSeedOnly({
    bootSettling: true,
    listenerStartedAt: started,
    now: started + MIGRATION_POST_START_SEED_MS + 1,
    allowParseAt: started,
  }) === true
);

const seedW = migrationPollWeight({
  seedOnly: true,
  probeMs: 200,
  softRpc: false,
});
check('seed-only sigLimit is 1', seedW.sigLimit === 1);
check('seed-only parseCap is 0', seedW.parseCap === 0);

const hotW = migrationPollWeight({
  seedOnly: false,
  probeMs: 1196,
  softRpc: false,
});
check(
  'warm probe uses tiny poll (limit ≤3, parse 1)',
  hotW.probeWarm === true &&
    hotW.sigLimit <= 3 &&
    hotW.parseCap === 1 &&
    hotW.minGapMs >= 45_000,
  `limit=${hotW.sigLimit} parse=${hotW.parseCap} gap=${hotW.minGapMs}`
);
check('warm threshold is 400ms', MIGRATION_PROBE_WARM_MS === 400);

const coolW = migrationPollWeight({
  seedOnly: false,
  probeMs: 180,
  softRpc: false,
});
check(
  'cool probe keeps full poll',
  coolW.sigLimit === 15 && coolW.parseCap === 5,
  `limit=${coolW.sigLimit} parse=${coolW.parseCap}`
);

check(
  'idle Trading (q=0) is not wedged',
  isTradingLaneWedged({ inFlight: 0, queued: 0, max: 8 }) === false
);
check(
  'full in-flight + deep queue is wedged',
  isTradingLaneWedged({ inFlight: 8, queued: 8, max: 8 }) === true
);

const util = shouldDeferBackgroundForCritical('utility');
check(
  'Favourites not deferred when Trading queue is empty',
  util.defer === false,
  util.reason ?? 'ok'
);

updateRpcLoadSignals({
  primaryLatencyMs: 1196,
  primaryQueued: 0,
  dataHealthy: true,
  dataRateLimited: false,
  secondaryLatencyMs: 495,
});
const snap = getRpcLoadControlSnapshot();
check(
  '1196ms probe + q=0 does not shed Favourites',
  snap.shedBackground === false,
  snap.reasons.join('; ') || 'no shed'
);

check('SIGNALS healthy floor is 700ms', SIGNALS_RPC_HEALTHY_MS === 700);
check(
  '495ms Data probe is signals-healthy',
  isSignalsRpcHealthy(495) === true
);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll post-4min RPC spike smoke checks passed');
