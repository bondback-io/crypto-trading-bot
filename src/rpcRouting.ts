/**
 * Feature → RPC lane routing for System Load Mode inventory.
 * Trading=primary (Alchemy BACKUP), Scanner=secondary (BACKUP2),
 * Watcher=utility (Helius). shareLoad is ignored (always split).
 */

import { runWithRpcRole, type RpcRole } from './connection';

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
 * Trading never shares a preferred key with Scanner or Watcher.
 */
export function getRpcRoleFor(
  feature: RpcFeature,
  _shareLoad?: boolean
): RpcRole {
  void _shareLoad;
  switch (feature) {
    case 'trade_entry':
    case 'trade_exit':
    case 'send_tx':
    case 'migration':
      return 'primary';
    case 'market_scanner':
    case 'alpha_scan':
    case 'zion':
    case 'signal_safety':
    case 'anti_rug':
    case 'token_metrics':
    case 'bonding_curve':
      return 'secondary';
    case 'setup_watch':
    case 'wallet_poll':
    case 'wallet_import':
    case 'activity':
      return 'utility';
    case 'default':
    default:
      return 'primary';
  }
}

/** Human labels for Stats → RPC chips. */
export function shareLoadLaneTitle(role: RpcRole): string {
  if (role === 'primary') return 'Trading';
  if (role === 'secondary') return 'Scanners';
  return 'Watcher';
}

/** Run watch/arm/trigger RPC on the Watcher (Helius) lane. */
export async function runSetupWatchLane<T>(
  fn: () => Promise<T> | T
): Promise<T> {
  return runWithRpcRole('utility', fn, 'setup_watch');
}
