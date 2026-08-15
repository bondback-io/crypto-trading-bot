/**
 * Smoke: same-lane soft overflow (default OFF).
 * Run: npx tsx scripts/smokeSoftOverflow.ts
 */
import { config } from '../src/config';
import {
  clampSoftOverflowEwmaMs,
  evaluateSoftOverflowArm,
  isOverflowEligible,
  resetSoftOverflowForTests,
  shouldOverflowCall,
  shouldSpillThisCall,
  tickSoftOverflowLane,
} from '../src/rpcSoftOverflow';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

const prevEnabled = config.rpc.softOverflowEnabled;
const prevEwma = config.rpc.softOverflowEwmaMs;

try {
  check('clamp default', clampSoftOverflowEwmaMs(undefined) === 250);
  check('clamp 50 → 150', clampSoftOverflowEwmaMs(50) === 150);
  check('clamp 900 → 800', clampSoftOverflowEwmaMs(900) === 800);

  check('send never eligible on Trading', isOverflowEligible('trading', 'send') === false);
  check(
    'trade_entry never eligible on Trading',
    isOverflowEligible('trading', 'trade_entry') === false
  );
  check('migration eligible on Trading', isOverflowEligible('trading', 'migration') === true);
  check(
    'market_scanner eligible on Data',
    isOverflowEligible('data', 'market_scanner') === true
  );
  check(
    'wallet_poll eligible on Background',
    isOverflowEligible('background', 'wallet_poll') === true
  );

  const off = evaluateSoftOverflowArm({
    enabled: false,
    ewmaMs: 900,
    thresholdMs: 250,
    saturated: true,
    emergencyAssigned: true,
    emergencyUsable: true,
    now: 1,
    prev: { armed: false, pressureSince: 0, healthySince: 0 },
  });
  check('OFF never arms', off.armed === false && off.reason === 'off');

  const noEm = evaluateSoftOverflowArm({
    enabled: true,
    ewmaMs: 900,
    thresholdMs: 250,
    saturated: true,
    emergencyAssigned: false,
    emergencyUsable: false,
    now: 1,
    prev: { armed: false, pressureSince: 0, healthySince: 0 },
  });
  check('no Emergency assigned never arms', noEm.reason === 'no_emergency');

  const t0 = 1_000_000;
  let warm = evaluateSoftOverflowArm({
    enabled: true,
    ewmaMs: 400,
    thresholdMs: 250,
    saturated: false,
    emergencyAssigned: true,
    emergencyUsable: true,
    now: t0,
    prev: { armed: false, pressureSince: 0, healthySince: 0 },
  });
  check('EWMA hot needs sustain window', warm.armed === false && warm.reason === 'warming');
  warm = evaluateSoftOverflowArm({
    enabled: true,
    ewmaMs: 400,
    thresholdMs: 250,
    saturated: false,
    emergencyAssigned: true,
    emergencyUsable: true,
    now: t0 + 15_000,
    prev: warm,
  });
  check('EWMA hot for 15s arms', warm.armed === true && /ewma_250ms_15s/.test(warm.reason));

  const sat = evaluateSoftOverflowArm({
    enabled: true,
    ewmaMs: 100,
    thresholdMs: 250,
    saturated: true,
    emergencyAssigned: true,
    emergencyUsable: true,
    now: t0,
    prev: { armed: false, pressureSince: 0, healthySince: 0 },
  });
  check('saturated Main arms immediately', sat.armed === true && sat.reason === 'main_saturated');

  let rec = evaluateSoftOverflowArm({
    enabled: true,
    ewmaMs: 100,
    thresholdMs: 250,
    saturated: false,
    emergencyAssigned: true,
    emergencyUsable: true,
    now: t0 + 1,
    prev: { armed: true, pressureSince: 0, healthySince: 0 },
  });
  check('cool Main stays armed during hysteresis', rec.armed === true && rec.reason === 'hysteresis');
  rec = evaluateSoftOverflowArm({
    enabled: true,
    ewmaMs: 100,
    thresholdMs: 250,
    saturated: false,
    emergencyAssigned: true,
    emergencyUsable: true,
    now: t0 + 1 + 20_000,
    prev: rec,
  });
  check('recovers after 20s healthy', rec.armed === false && rec.reason === 'recovered');

  check(
    'spill only when armed + near-saturated + eligible',
    shouldSpillThisCall({
      armed: true,
      eligible: true,
      emergencyUsable: true,
      mainNearSaturated: true,
    }) === true
  );
  check(
    'armed but Main has spare slots stays on Main',
    shouldSpillThisCall({
      armed: true,
      eligible: true,
      emergencyUsable: true,
      mainNearSaturated: false,
    }) === false
  );

  resetSoftOverflowForTests();
  config.rpc.softOverflowEnabled = false;
  check(
    'shouldOverflowCall OFF is false even when saturated',
    shouldOverflowCall(
      'data',
      'market_scanner',
      { inFlight: 8, queued: 2, max: 8 },
      true
    ) === false
  );

  config.rpc.softOverflowEnabled = true;
  config.rpc.softOverflowEwmaMs = 250;
  resetSoftOverflowForTests();
  tickSoftOverflowLane('data', {
    ewmaMs: 100,
    inFlight: 8,
    queued: 0,
    max: 8,
    emergencyAssigned: true,
    emergencyUsable: true,
    now: t0,
  });
  check(
    'ON + saturated + scanner spills to Emergency',
    shouldOverflowCall(
      'data',
      'market_scanner',
      { inFlight: 8, queued: 0, max: 8 },
      true
    ) === true
  );
  tickSoftOverflowLane('trading', {
    ewmaMs: 100,
    inFlight: 8,
    queued: 0,
    max: 8,
    emergencyAssigned: true,
    emergencyUsable: true,
    now: t0,
  });
  check(
    'ON + saturated still keeps send on Main',
    shouldOverflowCall('trading', 'send', { inFlight: 8, queued: 0, max: 8 }, true) ===
      false
  );
} finally {
  config.rpc.softOverflowEnabled = prevEnabled;
  config.rpc.softOverflowEwmaMs = prevEwma;
  resetSoftOverflowForTests();
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll soft-overflow smoke checks passed');
