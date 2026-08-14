/**
 * Central heap sweep — drop-oldest on registered mint/wallet caches.
 * Called from idle isolation and the heap watchdog.
 */

import { runRegisteredCacheSweeps } from './mapCap';

export function sweepBoundedCaches(): Record<string, number> {
  const sizes = runRegisteredCacheSweeps();
  try {
    const { getRpcQueueSizeSnapshot } =
      require('./connection') as typeof import('./connection');
    Object.assign(sizes, getRpcQueueSizeSnapshot());
  } catch {
    /* */
  }
  try {
    const { getRpcGateSnapshot } =
      require('./rpcGate') as typeof import('./rpcGate');
    const g = getRpcGateSnapshot();
    sizes.rpcGate_primary_queued = g.lanes.primary.queued;
    sizes.rpcGate_secondary_queued = g.lanes.secondary.queued;
    sizes.rpcGate_background_queued = g.lanes.background.queued;
  } catch {
    /* */
  }
  return sizes;
}

export function topQueueSizes(limit = 8): Array<{ name: string; size: number }> {
  const sizes = sweepBoundedCaches();
  return Object.entries(sizes)
    .map(([name, size]) => ({ name, size: Number(size) || 0 }))
    .sort((a, b) => b.size - a.size)
    .slice(0, limit);
}
