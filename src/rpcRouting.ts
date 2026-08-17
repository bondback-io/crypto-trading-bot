/**
 * Feature → RPC lane routing for Share RPC load mode (classic 3-lane).
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
  | 'signal_safety'
  | 'anti_rug'
  | 'token_metrics'
  | 'bonding_curve'
  | 'default';

/**
 * Map a workload feature to an RPC lane.
 * Share OFF: mostly primary; Zion + activity stay secondary (legacy).
 * Share ON: critical→primary, scanners/Zion/setup→secondary, wallet/activity→utility.
 * Exclusive-era 'watchers' maps to secondary.
 */
export function getRpcRoleFor(
  feature: RpcFeature,
  shareLoad: boolean
): RpcRole {
  if (!shareLoad) {
    if (
      feature === 'zion' ||
      feature === 'activity' ||
      feature === 'setup_watch'
    ) {
      return 'secondary';
    }
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
    case 'setup_watch':
    case 'signal_safety':
    case 'anti_rug':
    case 'token_metrics':
    case 'bonding_curve':
      return 'secondary';
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
  return 'Utility';
}

/** Run watch/arm/trigger RPC on the secondary (classic) lane. */
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
