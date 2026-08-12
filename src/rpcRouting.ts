/**
 * Feature → RPC lane routing for Share RPC load mode.
 */

import type { RpcRole } from './connection';

export type RpcFeature =
  | 'trade_entry'
  | 'migration'
  | 'live_balance'
  | 'open_mark'
  | 'market_scanner'
  | 'alpha_scan'
  | 'zion'
  | 'wallet_poll'
  | 'wallet_import'
  | 'activity'
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
    if (feature === 'zion' || feature === 'activity') return 'secondary';
    return 'primary';
  }

  switch (feature) {
    case 'trade_entry':
    case 'migration':
    case 'live_balance':
    case 'open_mark':
      return 'primary';
    case 'market_scanner':
    case 'alpha_scan':
    case 'zion':
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
