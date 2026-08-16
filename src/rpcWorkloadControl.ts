/**
 * Watchers-lane idle isolation during RPC containment.
 * Callers fail-open if this module is missing; when present, Watchers spike
 * sheds enrich / fast-poll / setup-watch ticks. Never pauses exits.
 */

import { isLaneSpiking, isRpcContainmentEnabled } from './rpcSpikeInspector';

/** True when containment is ON and the Watchers lane is in an open spike. */
export function shouldIdleIsolate(): boolean {
  return isRpcContainmentEnabled() && isLaneSpiking('watchers');
}

/** Inverse of shouldIdleIsolate — used by dip / majors watch ticks. */
export function isRpcWorkloadEnabled(_id?: string): boolean {
  void _id;
  return !shouldIdleIsolate();
}
