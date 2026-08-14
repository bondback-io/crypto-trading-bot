/**
 * Post-boot heavy-job mutex: one HEAVY family per lane/provider at a time.
 * Trading-critical send/exit never waits. LIGHT jobs are not gated here.
 */

import { getRpcGateSnapshot } from './rpcGate';

export type HeavyJobFamily =
  | 'market_scanner'
  | 'zion_scanner'
  | 'token_metrics'
  | 'anti_rug'
  | 'alpha_scan'
  | 'migration'
  | 'favourites'
  | 'github_upload'
  | 'github_restore'
  | 'influencer_holdings';

export type HeavyJobLane = 'trading' | 'data' | 'background' | 'cpu';

const FAMILY_LANE: Record<HeavyJobFamily, HeavyJobLane> = {
  market_scanner: 'data',
  zion_scanner: 'data',
  token_metrics: 'data',
  anti_rug: 'data',
  alpha_scan: 'data',
  migration: 'trading',
  favourites: 'background',
  influencer_holdings: 'background',
  github_upload: 'cpu',
  github_restore: 'cpu',
};

/** Spread periodic ticks so jobs do not share the same second forever. */
const CADENCE_OFFSET_MS: Record<HeavyJobFamily, number> = {
  market_scanner: 0,
  alpha_scan: 7_000,
  favourites: 11_000,
  anti_rug: 13_000,
  zion_scanner: 17_000,
  migration: 23_000,
  influencer_holdings: 29_000,
  token_metrics: 5_000,
  github_upload: 41_000,
  github_restore: 0,
};

type Slot = {
  family: HeavyJobFamily;
  startedAt: number;
};

const slots = new Map<HeavyJobLane, Slot>();
let deferredCount = 0;
let lastCollisionAvoided: {
  at: number;
  running: HeavyJobFamily;
  deferred: HeavyJobFamily;
  lane: HeavyJobLane;
} | null = null;

const TRADING_DEFER_EWMA_MS = 700;
const GITHUB_DEFER_EWMA_MS = 400;
const DATA_DEFER_EWMA_MS = 900;
const MANUAL_WAIT_MS = 8_000;

function laneOf(family: HeavyJobFamily): HeavyJobLane {
  return FAMILY_LANE[family];
}

export function heavyJobCadenceOffsetMs(family: HeavyJobFamily): number {
  return CADENCE_OFFSET_MS[family] || 0;
}

function tradingBusyOrHot(thresholdMs = TRADING_DEFER_EWMA_MS): boolean {
  try {
    const gate = getRpcGateSnapshot();
    if (gate.lanes.primary.queued > 0 || gate.lanes.primary.inFlight > 0) {
      return true;
    }
  } catch {
    /* */
  }
  try {
    const { isTradingEwmaRecovered, getRpcStats } =
      require('./connection') as typeof import('./connection');
    if (!isTradingEwmaRecovered()) return false;
    const stats = getRpcStats({ lite: true });
    const ms = stats.lanes?.trading?.latencyMs;
    return ms != null && ms >= thresholdMs;
  } catch {
    return false;
  }
}

function dataLaneHot(): boolean {
  try {
    const { isDataEwmaRecovered, getRpcStats } =
      require('./connection') as typeof import('./connection');
    if (!isDataEwmaRecovered()) return false;
    const stats = getRpcStats({ lite: true });
    const ms = stats.lanes?.data?.latencyMs;
    return ms != null && ms >= DATA_DEFER_EWMA_MS;
  } catch {
    return false;
  }
}

function noteDefer(family: HeavyJobFamily, running: HeavyJobFamily | null): void {
  deferredCount += 1;
  if (running) {
    lastCollisionAvoided = {
      at: Date.now(),
      running,
      deferred: family,
      lane: laneOf(family),
    };
  }
}

export function tryAcquireHeavyJob(
  family: HeavyJobFamily,
  opts?: { ignoreEwma?: boolean }
): boolean {
  const lane = laneOf(family);
  const criticalScan =
    family === 'market_scanner' || family === 'zion_scanner' || family === 'alpha_scan';

  if (!opts?.ignoreEwma) {
    if (family === 'github_upload' || family === 'github_restore') {
      if (tradingBusyOrHot(GITHUB_DEFER_EWMA_MS)) {
        noteDefer(family, slots.get('trading')?.family || null);
        return false;
      }
    } else if (
      family === 'migration' ||
      family === 'favourites' ||
      family === 'influencer_holdings'
    ) {
      if (tradingBusyOrHot()) {
        noteDefer(family, slots.get('trading')?.family || null);
        return false;
      }
    }
    if (!criticalScan && (lane === 'data' || lane === 'background') && dataLaneHot()) {
      noteDefer(family, slots.get(lane)?.family || null);
      return false;
    }
  }

  const held = slots.get(lane);
  if (held) {
    noteDefer(family, held.family);
    return false;
  }
  slots.set(lane, { family, startedAt: Date.now() });
  return true;
}

export function releaseHeavyJob(family: HeavyJobFamily): void {
  const lane = laneOf(family);
  const held = slots.get(lane);
  if (held && held.family === family) slots.delete(lane);
}

export async function runHeavyJob<T>(
  family: HeavyJobFamily,
  fn: () => Promise<T>,
  opts?: { waitMs?: number; ignoreEwma?: boolean; forceAfterWait?: boolean }
): Promise<T | undefined> {
  const waitMs = opts?.waitMs ?? 0;
  const t0 = Date.now();
  for (;;) {
    const elapsed = Date.now() - t0;
    const ignoreEwma =
      opts?.ignoreEwma === true ||
      (opts?.forceAfterWait === true && elapsed >= waitMs);
    if (tryAcquireHeavyJob(family, { ignoreEwma })) break;
    if (!opts?.forceAfterWait && elapsed >= waitMs) return undefined;
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    return await fn();
  } finally {
    releaseHeavyJob(family);
  }
}

export function getHeavyJobSnapshot(): {
  heavy_job_running: string | null;
  heavy_job_deferred: number;
  last_heavy_collision_avoided: typeof lastCollisionAvoided;
  endpoint_pressure_by_lane: {
    trading: { inFlight: number; queued: number };
    data: { inFlight: number; queued: number };
    background: { inFlight: number; queued: number };
  };
  slots: Array<{ lane: HeavyJobLane; family: HeavyJobFamily; ageMs: number }>;
} {
  let pressure = {
    trading: { inFlight: 0, queued: 0 },
    data: { inFlight: 0, queued: 0 },
    background: { inFlight: 0, queued: 0 },
  };
  try {
    const g = getRpcGateSnapshot();
    pressure = {
      trading: { inFlight: g.lanes.primary.inFlight, queued: g.lanes.primary.queued },
      data: { inFlight: g.lanes.secondary.inFlight, queued: g.lanes.secondary.queued },
      background: {
        inFlight: g.lanes.background.inFlight,
        queued: g.lanes.background.queued,
      },
    };
  } catch {
    /* */
  }
  const now = Date.now();
  const running =
    slots.size > 0
      ? [...slots.values()].map((s) => s.family).join(',')
      : null;
  return {
    heavy_job_running: running,
    heavy_job_deferred: deferredCount,
    last_heavy_collision_avoided: lastCollisionAvoided,
    endpoint_pressure_by_lane: pressure,
    slots: [...slots.entries()].map(([lane, s]) => ({
      lane,
      family: s.family,
      ageMs: now - s.startedAt,
    })),
  };
}

export const GITHUB_MANUAL_WAIT_MS = MANUAL_WAIT_MS;
