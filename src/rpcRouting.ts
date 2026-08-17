/**
 * Feature → RPC lane routing for Share RPC load mode.
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
 * Share OFF: mostly primary; Zion + activity + setup_watch stay secondary (legacy).
 * Share ON: critical→primary (Helius), scanners/Zion/setup→secondary (Alchemy),
 * wallet poll + import/activity→utility (public).
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

/** Run watch/arm/trigger RPC on the classic secondary (Alchemy scanners) lane. */
export async function runSetupWatchLane<T>(
  fn: () => Promise<T> | T
): Promise<T> {
  return runWithRpcRole('secondary', fn, 'setup_watch');
}
