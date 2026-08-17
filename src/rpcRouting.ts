/**
 * Feature → RPC lane routing for Share RPC load mode.
 * Exclusive preferred keys live in rpcServiceMap; gate roles below stay for concurrency.
 */

import type { RpcRole } from './connection';
import { exclusiveServiceForFeature } from './rpcServiceMap';

export type RpcFeature =
  | 'trade_entry'
  | 'trade_exit'
  | 'send_tx'
  | 'migration'
  | 'market_scanner'
  | 'alpha_scan'
  | 'zion'
  | 'wallet_poll'
  | 'wallet_import'
  | 'activity'
  | 'setup_watch'
  | 'signal_safety'
  | 'default';

/**
 * Map a workload feature to a concurrency gate lane.
 * Preferred endpoint is the exclusive key from rpcServiceMap (not this role alone).
 */
export function getRpcRoleFor(
  feature: RpcFeature,
  _shareLoad: boolean
): RpcRole {
  const svc = exclusiveServiceForFeature(feature);
  if (svc) return svc.gateRole;
  switch (feature) {
    case 'setup_watch':
      return 'watchers';
    case 'wallet_poll':
    case 'wallet_import':
    case 'activity':
      return 'utility';
    case 'migration':
    case 'market_scanner':
    case 'alpha_scan':
    case 'zion':
    case 'signal_safety':
      return 'secondary';
    case 'trade_entry':
    case 'trade_exit':
    case 'send_tx':
    case 'default':
    default:
      return 'primary';
  }
}

/** Human labels for Config → RPC share chips. */
export function shareLoadLaneTitle(role: RpcRole): string {
  if (role === 'primary') return 'Trading';
  if (role === 'secondary') return 'Scanners';
  if (role === 'watchers') return 'Watchers';
  return 'Utility';
}

/** Run watch/arm/trigger RPC on the exclusive Setup-watches key. */
export async function runSetupWatchLane<T>(
  fn: () => Promise<T> | T
): Promise<T> {
  const { runWithRpcRole } =
    require('./connection') as typeof import('./connection');
  const { config } = require('./config') as typeof import('./config');
  return runWithRpcRole(
    getRpcRoleFor('setup_watch', Boolean(config.rpc?.shareLoad)),
    fn,
    'setup_watch'
  );
}
