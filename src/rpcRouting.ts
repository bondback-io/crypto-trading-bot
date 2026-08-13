/**
 * Feature → RPC lane routing for sticky 2-lane mode.
 * Trading (primary) = ALCHEMY_API_KEY_BACKUP
 * Data (secondary) = ALCHEMY_API_KEY
 * Favourites/activity ride Data — never Trading.
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
 * Share OFF: Trading for most; Zion stays on Data.
 * Share ON: Trading vs Data only (no Utility lane).
 */
export function getRpcRoleFor(
  feature: RpcFeature,
  shareLoad: boolean
): RpcRole {
  if (!shareLoad) {
    if (
      feature === 'zion' ||
      feature === 'activity' ||
      feature === 'wallet_poll' ||
      feature === 'wallet_import' ||
      feature === 'market_scanner' ||
      feature === 'alpha_scan'
    ) {
      return 'secondary';
    }
    return 'primary';
  }

  switch (feature) {
    case 'trade_entry':
    case 'migration':
    case 'live_balance':
    case 'open_mark':
    case 'default':
      return 'primary';
    case 'market_scanner':
    case 'alpha_scan':
    case 'zion':
    case 'wallet_poll':
    case 'wallet_import':
    case 'activity':
      return 'secondary';
    default:
      return 'primary';
  }
}

/** Human labels for Config → RPC share chips / Status. */
export function shareLoadLaneTitle(role: RpcRole): string {
  if (role === 'primary') return 'Trading';
  if (role === 'secondary') return 'Data';
  // Legacy utility role — Favourites now ride Data; label for any leftover UI.
  return 'Data';
}
