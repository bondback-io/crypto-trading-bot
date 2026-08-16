/**
 * Smoke: 1.2.388 / 1.2.390 waiting-arm lifecycle, Dip inserts, refresh UI.
 * Run: npx tsx scripts/smokeWaitingArmPipeline.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { canTriggerArmed, formatArmingParkFailedReason } from '../src/profileWatchRegistry';
import { watchVolumeOkFlag } from '../src/profileTaPlaybook';
import {
  applyArmLifecycleTimeout,
  hasDipFightDna,
  inferWaitingArmHoldReason,
  isRetryableOpenFail,
  WAITING_ARM_TIMEOUT_MS,
  WAITING_OPEN_CONTAINMENT_PAUSE,
} from '../src/watchArmLifecycle';
import { offerDipWatchFromCandidate, getDipSetupWatchStatus } from '../src/dipSetupWatch';

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

check(
  'confluence hold uses real have-count (not confluence_0)',
  inferWaitingArmHoldReason({
    status: 'armed',
    lastReason: 'need 2 TA confluences (have 1)',
  }) === 'confluence_1'
);

check(
  'support_dip_reclaim is fight DNA',
  hasDipFightDna(['support_dip_reclaim']) === true
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
check(
  'watching beyond 20m expires arm_timeout even if isolate was on',
  applyArmLifecycleTimeout(aged, Date.now()) === 'arm_timeout'
);

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

const monitorSrc = readSrc('src/monitor.ts');
check(
  'Arming-ON park stamps lastPriceSol',
  /maybeParkArmingOpen[\s\S]{0,2500}lastPriceSol: signal\.lastPriceSol/.test(
    monitorSrc
  )
);
check(
  'disc-skip parks Mode B instead of opening',
  /scalper_discretionary_skipped[\s\S]{0,1200}tryParkModeBFromFight/.test(
    monitorSrc
  )
);

const dash = readSrc('src/dashboard.ts');
check(
  'Watchlist has Refresh all and per-tab Refresh',
  /Refresh all watchlists/.test(dash) &&
    /onclick="refreshSetupWatches\(true\)"/.test(dash)
);
check(
  'Re-evaluate arms now is a separate POST',
  /reevaluateWatchArmsNow/.test(dash) &&
    /\/api\/setup-watches\/reevaluate/.test(readSrc('src/server.ts'))
);
check(
  'reevaluate is cheap (no tick*SetupWatches expire path)',
  /reevaluateWatchArmsCheap/.test(registry) &&
    !/app\.post\('\/api\/setup-watches\/reevaluate'[\s\S]{0,400}tickDipSetupWatches/.test(
      readSrc('src/server.ts')
    )
);

const aOk = offerDipWatchFromCandidate({
  mint: 'SmokeDipA11111111111111111111111111111111111',
  symbol: 'SMOKEA',
  marketCapUsd: 2_000_000,
  volumeH1Usd: 25_000,
  holderCount: 200,
  scannerReasons: ['support_dip_reclaim'],
  lastPriceSol: 0.0012,
  supportPriceSol: 0.0011,
  nearSupport: true,
});
const bOk = offerDipWatchFromCandidate({
  mint: 'SmokeDipB22222222222222222222222222222222222',
  symbol: 'SMOKEB',
  marketCapUsd: 3_500_000,
  volumeH1Usd: 18_000,
  holderCount: 150,
  priceChangeH1Pct: -6,
  lastPriceSol: 0.002,
  supportPriceSol: 0.0019,
});
const dipStatus = getDipSetupWatchStatus(20);
check(
  'two eligible Dip parks can insert (active ≥ 2 or both offers true)',
  (aOk && bOk) || dipStatus.active >= 2,
  `a=${aOk} b=${bOk} active=${dipStatus.active}`
);

check(
  'watch_insert_ok / denied logs exist',
  /watch_insert_ok/.test(dipTick) && /watch_insert_denied/.test(dipTick)
);

check(
  'late_chase still forbidden at trigger',
  /ARMED_LATE_CHASE_BLOCK/.test(registry)
);
check(
  'executeSell still has no entry pause',
  !/export async function executeSell[\s\S]*shouldSoftPauseNewEntries/.test(
    readSrc('src/trade.ts')
  )
);

const adm = readSrc('src/admissionMode.ts');
check(
  'admissionMode helper exists with hybrid default',
  /shouldFastArmOpen/.test(adm) && /normalizeAdmissionMode/.test(adm)
);
check(
  'Watchlist Ready now / Waiting chips exist',
  /Ready now/.test(dash) && /is-waiting/.test(dash)
);

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nwaiting-arm pipeline smoke OK');
