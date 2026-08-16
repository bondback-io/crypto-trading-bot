/**
 * Feature → RPC lane routing for Share RPC load mode.
 */

import type { RpcRole } from './connection';

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
  | 'default';

/**
 * Map a workload feature to an RPC lane.
 * Share OFF: mostly primary; Zion + activity stay secondary (legacy).
 * Share ON: critical→primary (Helius), scanners/Zion→secondary (Alchemy),
 * wallet poll + import/activity→utility (public).
 */
export function getRpcRoleFor(
  feature: RpcFeature,
  shareLoad: boolean
): RpcRole {
  if (!shareLoad) {
    if (feature === 'setup_watch') return 'watchers';
    if (feature === 'zion' || feature === 'activity') return 'secondary';
    return 'primary';
  }

  switch (feature) {
    case 'trade_entry':
    case 'trade_exit':
    case 'send_tx':
    case 'migration':
      return 'primary';
    case 'market_scanner':
    case 'alpha_scan':
    case 'zion':
      return 'secondary';
    case 'setup_watch':
      return 'watchers';
    case 'wallet_poll':
    case 'wallet_import':
    case 'activity':
      return 'utility';
    case 'default':
    default:
      return 'primary';
  }
}

/** Human labels for Config → RPC share chips. */
export function shareLoadLaneTitle(role: RpcRole): string {
  if (role === 'primary') return 'Critical';
  if (role === 'secondary') return 'Scanners';
  if (role === 'watchers') return 'Watchers';
  return 'Utility';
}

/** Run watch/arm/trigger RPC on the exclusive Watchers lane. */
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
