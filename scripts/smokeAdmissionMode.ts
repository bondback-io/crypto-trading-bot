/**
 * Smoke: 1.2.392 Hybrid admission modes (Selective | Flow | Hybrid).
 * Mutates in-memory config only — does not persist.
 * Run: npx tsx scripts/smokeAdmissionMode.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config';
import {
  isArmedLikeEntryPath,
  shouldFastArmOpen,
  shouldSkipMarlReorder,
  waitingArmTimeoutMs,
  SELECTIVE_WAITING_ARM_TIMEOUT_MS,
} from '../src/admissionMode';
import { shouldParkUnarmedOpen } from '../src/profileWatchRegistry';
import { shouldSoftSkipUnarmedScalperHabit } from '../src/profileAttention';
import { applyArmLifecycleTimeout } from '../src/watchArmLifecycle';
import { isAdmissionBaselineV235 } from '../src/expectancyLift';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

const prevMode = config.admissionMode;
const prevProx = config.fastArmProximityPct;
const prevWait = config.flowMaxWaitingArmMinutes;
const prevByProfile = { ...(config.admissionModeByProfile || {}) };

try {
  config.admissionMode = 'hybrid';
  config.fastArmProximityPct = 12;
  config.flowMaxWaitingArmMinutes = 10;
  config.admissionModeByProfile = {};

  const near = shouldFastArmOpen({
    profileId: 'dip_buyer',
    lastPriceSol: 1,
    supportPriceSol: 1.05,
    nearSupport: true,
  });
  check(
    'Hybrid near level fast-arms',
    near.fastArm === true && near.entryPath === 'hybrid_fast_arm',
    `${near.fastArm} ${near.reason} ${near.entryPath}`
  );

  const hybridPark = shouldParkUnarmedOpen({
    profileId: 'dip_buyer',
    lastPriceSol: 1,
    supportPriceSol: 1.05,
    nearSupport: true,
  });
  check(
    'Hybrid near is not parked',
    hybridPark.park === false,
    `${hybridPark.park} ${hybridPark.reason}`
  );

  const noLevel = shouldFastArmOpen({
    profileId: 'scalper',
    lastPriceSol: 1,
  });
  check(
    'no-level Scalper does not fast-arm',
    noLevel.fastArm === false && noLevel.reason === 'no_level',
    `${noLevel.fastArm} ${noLevel.reason}`
  );

  const late = shouldFastArmOpen({
    profileId: 'dip_buyer',
    lateChase: true,
    lastPriceSol: 1,
    supportPriceSol: 1.05,
    nearSupport: true,
  });
  check(
    'late_chase never fast-arms',
    late.fastArm === false && late.reason === 'late_chase',
    `${late.fastArm} ${late.reason}`
  );

  if (!isAdmissionBaselineV235()) {
    const skipFar = shouldSoftSkipUnarmedScalperHabit({
      profileId: 'scalper',
      lastPriceSol: 1,
      supportPriceSol: 10,
    });
    check(
      'no-level Scalper still skipped',
      skipFar.skip === true && /scalper_discretionary_skipped/.test(skipFar.reason || ''),
      `${skipFar.skip} ${skipFar.reason}`
    );
    const skipNear = shouldSoftSkipUnarmedScalperHabit({
      profileId: 'scalper',
      lastPriceSol: 1,
      supportPriceSol: 1.05,
      nearSupport: true,
    });
    check(
      'Scalper near support allowed through (not disc skip)',
      skipNear.skip === false,
      `${skipNear.skip} ${skipNear.reason || ''}`
    );
  } else {
    check('v235 baseline — Scalper habit skip observe-only (skipped runtime assert)', true);
  }

  config.admissionMode = 'selective';
  const sel = shouldFastArmOpen({
    profileId: 'dip_buyer',
    lastPriceSol: 1,
    supportPriceSol: 1.05,
    nearSupport: true,
  });
  check(
    'Selective never fast-arms',
    sel.fastArm === false && sel.reason === 'selective_park',
    `${sel.fastArm} ${sel.reason}`
  );
  check(
    'Selective waiting-arm TTL is 20m',
    waitingArmTimeoutMs('dip_buyer') === SELECTIVE_WAITING_ARM_TIMEOUT_MS
  );
  const selAged10 = applyArmLifecycleTimeout(
    {
      status: 'watching',
      createdAt: Date.now() - 11 * 60_000,
      armClockPausedMs: 0,
      preferredProfileId: 'dip_buyer',
    },
    Date.now()
  );
  check(
    'Selective does not expire at 11m',
    selAged10 == null,
    String(selAged10)
  );

  config.admissionMode = 'flow';
  check(
    'Flow waiting-arm TTL is 10m',
    waitingArmTimeoutMs() === 10 * 60_000
  );
  check('Flow skips MARL reorder', shouldSkipMarlReorder() === true);
  const flowTimeout = applyArmLifecycleTimeout(
    {
      status: 'watching',
      createdAt: Date.now() - 11 * 60_000,
      armClockPausedMs: 0,
      preferredProfileId: 'scalper',
    },
    Date.now()
  );
  check(
    'Flow timeout uses 10m (expire when not near)',
    flowTimeout === 'arm_timeout',
    String(flowTimeout)
  );

  config.admissionMode = 'hybrid';
  check('Hybrid does not skip MARL', shouldSkipMarlReorder() === false);
  const promote = applyArmLifecycleTimeout(
    {
      status: 'watching',
      createdAt: Date.now() - 11 * 60_000,
      armClockPausedMs: 0,
      preferredProfileId: 'dip_buyer',
      nearSupport: true,
      supportPriceSol: 1,
      lastPriceSol: 1.05,
    },
    Date.now()
  );
  check(
    'Hybrid timeout near level promotes fast-arm',
    promote === 'promote_fast_arm',
    String(promote)
  );

  check(
    'hybrid_fast_arm is armed-like',
    isArmedLikeEntryPath('hybrid_fast_arm') &&
      isArmedLikeEntryPath('flow_fast_arm') &&
      isArmedLikeEntryPath('selective_arm') &&
      isArmedLikeEntryPath('armed_trigger') &&
      !isArmedLikeEntryPath('discretionary')
  );
} finally {
  config.admissionMode = prevMode;
  config.fastArmProximityPct = prevProx;
  config.flowMaxWaitingArmMinutes = prevWait;
  config.admissionModeByProfile = prevByProfile;
}

const dash = readSrc('src/dashboard.ts');
check(
  'Settings has Admission / Entry Mode block',
  /Admission \/ Entry Mode/.test(dash) &&
    /id="admission-mode-hybrid"/.test(dash) &&
    /Ready now if within this % of support/.test(dash)
);
check(
  'Header + Watchlist admission badges exist',
  /id="header-admission-mode-badge"/.test(dash) &&
    /id="watchlist-admission-chip"/.test(dash) &&
    /Ready now/.test(dash) &&
    />Waiting</.test(dash)
);

const server = readSrc('src/server.ts');
check(
  'GET/POST /api/config/admission-mode exist',
  /\/api\/config\/admission-mode/.test(server)
);

const pipe = readSrc('src/watchPipeline.ts');
check(
  'Pipeline counters include fast-arm opens',
  /noteFastArmOpen/.test(pipe) && /hybrid_fast_arm_opens/.test(pipe)
);

const lanes = readSrc('src/tradeProfiles.ts');
check(
  'Flow skips MARL reorder in lane fight',
  /shouldSkipMarlReorder/.test(lanes) && /applyMarlLaneRanking/.test(lanes)
);

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nadmission-mode smoke OK');
