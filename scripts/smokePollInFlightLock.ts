/**
 * Smoke: hung pollInFlight lock + withTimeout.
 * Run: npx tsx scripts/smokePollInFlightLock.ts
 */
import {
  createPollInFlightLock,
  getSignalIntakeStats,
  withTimeout,
} from '../src/signalIntakeStats';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const lock = createPollInFlightLock('smoke', 15);
  check('idle is not in-flight', lock.isInFlight() === false);

  const t1 = lock.begin();
  check('begin marks in-flight', lock.isInFlight() === true);
  check('token is positive', t1 > 0);
  check('not hung immediately', lock.forceUnlockIfHung() === false);

  await sleep(25);
  const unlocked = lock.forceUnlockIfHung();
  check('force-unlock after hangMs', unlocked === true);
  check('unlocked is not in-flight', lock.isInFlight() === false);
  const afterUnlock = getSignalIntakeStats();
  check(
    'hung unlock notes a gate block',
    afterUnlock.signalsBlockedByGate15m >= 1,
    `blocked=${afterUnlock.signalsBlockedByGate15m}`
  );

  const t2 = lock.begin();
  lock.end(t1);
  check('late finally cannot clear a newer poll', lock.isInFlight() === true);
  lock.end(t2);
  check('matching end clears lock', lock.isInFlight() === false);

  lock.begin();
  lock.reset();
  check('reset clears lock', lock.isInFlight() === false);

  const ok = await withTimeout(Promise.resolve(7), 200, 'ok');
  check('withTimeout resolves in time', ok === 7);

  let timedOut = false;
  try {
    await withTimeout(new Promise<void>(() => {}), 20, 'hang');
  } catch (err) {
    timedOut = /timeout/i.test(err instanceof Error ? err.message : String(err));
  }
  check('withTimeout rejects hung work', timedOut);

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll poll-lock smoke checks passed');
}

void main();
