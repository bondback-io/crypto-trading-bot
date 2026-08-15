/**
 * Smoke: scanner timeout-partial + healthy enrich headroom.
 * Run: npx tsx scripts/smokeSignalThroughput.ts
 */
import { mapPool } from '../src/marketData';
import {
  scannerEnrichLimits,
  shouldStampScannerLastPollAt,
} from '../src/marketScanner';
import { withTimeoutFallback } from '../src/signalIntakeStats';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const healthy = scannerEnrichLimits(true);
  check(
    'healthy enrich is 10 / concurrency 3',
    healthy.enrichBudget === 10 && healthy.enrichConcurrency === 3,
    `${healthy.enrichBudget}/${healthy.enrichConcurrency}`
  );
  const sick = scannerEnrichLimits(false);
  check(
    'unhealthy enrich stays 6 / concurrency 2',
    sick.enrichBudget === 6 && sick.enrichConcurrency === 2,
    `${sick.enrichBudget}/${sick.enrichConcurrency}`
  );

  const ok = await withTimeoutFallback(Promise.resolve([1, 2]), 200, [], 'ok');
  check('withTimeoutFallback resolves in time', ok.timedOut === false && ok.value.length === 2);

  const hung = await withTimeoutFallback(
    new Promise<number[]>((resolve) => {
      setTimeout(() => resolve([9]), 200);
    }),
    25,
    [1],
    'hang'
  );
  check(
    'withTimeoutFallback returns fallback instead of throwing',
    hung.timedOut === true && hung.value.length === 1 && hung.value[0] === 1
  );

  const deadlineAt = Date.now() + 40;
  const partial = await mapPool(
    [10, 80, 80, 80],
    1,
    async (ms) => {
      await sleep(ms);
      return ms;
    },
    { deadlineAt }
  );
  check(
    'mapPool deadline returns already-finished items',
    partial.length >= 1 && partial[0] === 10,
    `got ${partial.join(',')}`
  );

  check(
    'stamp lastPollAt when universe made progress',
    shouldStampScannerLastPollAt({ universeN: 3, pickedN: 0, ticksRan: false }) ===
      true
  );
  check(
    'stamp lastPollAt when watch ticks ran',
    shouldStampScannerLastPollAt({ universeN: 0, pickedN: 0, ticksRan: true }) ===
      true
  );
  check(
    'do not stamp lastPollAt on empty timeout with no ticks',
    shouldStampScannerLastPollAt({ universeN: 0, pickedN: 0, ticksRan: false }) ===
      false
  );

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll signal-throughput smoke checks passed');
}

void main();
