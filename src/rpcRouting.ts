/**
 * Feature → RPC lane routing for classic Share and Multi-lane modes.
 */

import type { RpcRole } from './connection';
import { getRpcMode } from './config';

export type RpcFeature =
  | 'trade_entry'
  | 'migration'
  | 'market_scanner'
  | 'alpha_scan'
  | 'zion'
  | 'wallet_poll'
  | 'wallet_import'
  | 'activity'
  | 'token_metrics'
  | 'anti_rug'
  | 'bonding_curve'
  | 'default';

/**
 * Map a workload feature to an RPC lane.
 * Share OFF: mostly primary; Zion + activity stay secondary (legacy).
 * Share ON classic: critical→primary (Helius), scanners/Zion→secondary (Alchemy),
 * wallet poll + import/activity→utility (public).
 * Multi-lane: typed sticky buckets — ScannersA=secondary, ScannersB/Metrics distinct.
 */
export function getRpcRoleFor(
  feature: RpcFeature,
  shareLoad: boolean
): RpcRole {
  if (getRpcMode() === 'multiLane' && shareLoad) {
    return getMultiLaneRoleFor(feature);
  }

  if (!shareLoad) {
    if (feature === 'zion' || feature === 'activity') return 'secondary';
    return 'primary';
  }

  switch (feature) {
    case 'trade_entry':
    case 'migration':
      return 'primary';
    case 'market_scanner':
    case 'alpha_scan':
    case 'zion':
    case 'token_metrics':
    case 'anti_rug':
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

/** Multi-lane typed sticky buckets (Share ON + mode=multiLane). */
function getMultiLaneRoleFor(feature: RpcFeature): RpcRole {
  switch (feature) {
    case 'trade_entry':
    case 'migration':
    case 'default':
      return 'primary';
    case 'market_scanner':
    case 'bonding_curve':
      return 'secondary';
    case 'alpha_scan':
    case 'zion':
      return 'scannersB';
    case 'token_metrics':
    case 'anti_rug':
      return 'metrics';
    case 'wallet_poll':
    case 'wallet_import':
    case 'activity':
      return 'utility';
    default:
      return 'primary';
  }
}

/** Human labels for Config → RPC share chips / Multi-lane cards. */
export function shareLoadLaneTitle(role: RpcRole): string {
  if (role === 'primary') return 'Critical';
  if (role === 'secondary') return 'Scanners';
  if (role === 'scannersB') return 'Scanners B';
  if (role === 'metrics') return 'Metrics';
  return 'Utility';
}
