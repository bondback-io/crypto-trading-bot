/**
 * Smoke: 1.2.388 waiting-arm lifecycle — hold reasons, vol-ok confluence, timeouts, revert.
 * Run: npx tsx scripts/smokeWaitingArmPipeline.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { canTriggerArmed, formatArmingParkFailedReason } from '../src/profileWatchRegistry';
import { watchVolumeOkFlag } from '../src/profileTaPlaybook';
import {
  applyArmLifecycleTimeout,
  inferWaitingArmHoldReason,
  isRetryableOpenFail,
  shouldPauseArmClocks,
  WAITING_ARM_TIMEOUT_MS,
  WAITING_OPEN_CONTAINMENT_PAUSE,
} from '../src/watchArmLifecycle';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

check(
  'watching without level is not_near_level',
  inferWaitingArmHoldReason({ status: 'watching' }) === 'not_near_level'
);

check(
  'H1 volume counts as vol ok',
  watchVolumeOkFlag({ volumeH1Usd: 8_000 }) === true
);

const dipGate = canTriggerArmed({
  profileId: 'dip_buyer',
  score: {
    toolsEvaluated: [],
    passedIds: [],
    confluenceCount: 0,
    hardLevelEvidence: true,
    lateChase: false,
  },
  watch: {
    status: 'armed',
    armed: true,
    nearSupport: true,
    volumeH1Usd: 10_000,
  },
});
check(
  'Dip min TA=2 can pass with level + vol ok (not stuck have 1)',
  dipGate.ok === true && dipGate.score.confluenceCount >= 2,
  `${dipGate.ok} ${dipGate.reason} have=${dipGate.score.confluenceCount}`
);

const aged = {
  status: 'watching',
  createdAt: Date.now() - WAITING_ARM_TIMEOUT_MS - 1_000,
  armClockPausedMs: 0,
};
if (shouldPauseArmClocks()) {
  check(
    'arm clock paused during RPC weather',
    applyArmLifecycleTimeout(aged, Date.now()) === null
  );
} else {
  check(
    'watching beyond 20m expires arm_timeout',
    applyArmLifecycleTimeout(aged, Date.now()) === 'arm_timeout'
  );
}

check(
  'containment buy fail is retryable',
  isRetryableOpenFail('rpc_containment_entry_pause') === true
);

check(
  'park-fail copy is not fake waiting arm',
  /park failed|watch_off/.test(formatArmingParkFailedReason('dip_buyer')) &&
    !/waiting arm$/.test(formatArmingParkFailedReason('dip_buyer'))
);

const dipTick = readSrc('src/dipSetupWatch.ts');
check(
  'Dip tick no longer returns 0 on Watchers isolate',
  !/if \(!isRpcWorkloadEnabled\('dip_setup_watch'\)\) return 0;/.test(dipTick)
);

const scalperTick = readSrc('src/scalperSetupWatch.ts');
check(
  'Scalper tick no longer returns 0 on isolate',
  !/if \(shouldIdleIsolate\?\.\(\)\) \{\s*pruneTerminal\(\);\s*return 0;/.test(
    scalperTick
  )
);

const registry = readSrc('src/profileWatchRegistry.ts');
const life = readSrc('src/watchArmLifecycle.ts');
check(
  'containment revert helper exists',
  /revertArmedWatchOpenFail/.test(registry) &&
    life.includes(WAITING_OPEN_CONTAINMENT_PAUSE)
);

const habitSrc = readSrc('src/profileAttention.ts');
check(
  'unarmed Scalper discretionary skip still in source',
  /scalper_discretionary_skipped/.test(habitSrc)
);

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nwaiting-arm pipeline smoke OK');
