/**
 * Process heap watchdog — sweep caches and idle-isolate on OOM-risk.
 * Runtime only; does not persist workload toggles.
 */

import { sweepBoundedCaches } from './cacheSweep';

const SAMPLE_MS = 15_000;
const HEAP_HIGH_MB = 400;
const GROWTH_STREAK_NEED = 2;

let timer: ReturnType<typeof setInterval> | null = null;
let lastHeapMb = 0;
let growthStreak = 0;
let lastShedAt = 0;

function heapUsedMb(): number {
  return Math.round((process.memoryUsage().heapUsed / (1024 * 1024)) * 10) / 10;
}

function tick(): void {
  const heap = heapUsedMb();
  const growing = heap > lastHeapMb + 8;
  lastHeapMb = heap;
  if (growing) growthStreak += 1;
  else growthStreak = Math.max(0, growthStreak - 1);

  if (heap < HEAP_HIGH_MB) return;
  const sizes = sweepBoundedCaches();
  const queueGrowth =
    (sizes.callTrafficEvents || 0) > 400 ||
    (sizes.ohlcvCache || 0) > 300 ||
    (sizes.tokenMeta || 0) > 800 ||
    growthStreak >= GROWTH_STREAK_NEED;
  if (!queueGrowth) return;
  if (Date.now() - lastShedAt < 60_000) return;
  lastShedAt = Date.now();
  console.warn(
    `[heap-watchdog] oom_shed heap=${heap}MB queues=${JSON.stringify(sizes)}`
  );
  try {
    const { enterRpcIdleIsolation } =
      require('./connection') as typeof import('./connection');
    enterRpcIdleIsolation(`oom_shed heap=${heap}MB`);
  } catch (err) {
    console.warn(
      '[heap-watchdog] idle isolation failed:',
      err instanceof Error ? err.message : err
    );
  }
}

export function startHeapWatchdog(): void {
  if (timer) return;
  lastHeapMb = heapUsedMb();
  timer = setInterval(() => {
    try {
      tick();
    } catch {
      /* */
    }
  }, SAMPLE_MS);
  timer.unref?.();
  console.log(
    `[heap-watchdog] started — shed at ≥${HEAP_HIGH_MB}MB with queue growth`
  );
}

export function stopHeapWatchdog(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function getHeapWatchdogSnapshot(): {
  heap_used_mb: number;
  growthStreak: number;
  lastShedAt: number;
} {
  return {
    heap_used_mb: heapUsedMb(),
    growthStreak,
    lastShedAt,
  };
}
