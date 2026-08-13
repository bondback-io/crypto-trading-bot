/**
 * Feature → RPC lane map (3-lane + legacy aliases).
 * primary = Trading (Helius)
 * secondary = Data (Alchemy)
 * background = Background (Alchemy BACKUP2 → publics)
 */

export type RpcFeature =
  | 'trade_entry'
  | 'migration'
  | 'live_balance'
  | 'open_mark'
  | 'market_scanner'
  | 'alpha_scan'
  | 'zion'
  | 'zion_place_trade'
  | 'bonding_curve'
  | 'token_metrics'
  | 'anti_rug'
  | 'wallet_poll'
  | 'wallet_import'
  | 'activity'
  | 'favourites'
  | 'health_probe'
  | 'default'
  | string;

export type RpcRole =
  | 'primary'
  | 'secondary'
  | 'background'
  | 'utility'
  | 'scannersB'
  | 'metrics';

export type NormalizedRpcRole = 'primary' | 'secondary' | 'background';

/**
 * Map feature → lane.
 * Second arg (`shareLoad`) ignored — kept for call-site compatibility.
 */
export function getRpcRoleFor(
  feature: RpcFeature,
  _shareLoad?: boolean
): RpcRole {
  switch (feature) {
    case 'trade_entry':
    case 'zion_place_trade':
    case 'migration':
    case 'live_balance':
    case 'priority_fee':
    case 'mev':
    case 'send':
      return 'primary';
    case 'market_scanner':
    case 'alpha_scan':
    case 'zion':
    case 'bonding_curve':
    case 'token_metrics':
    case 'anti_rug':
    case 'open_mark':
      return 'secondary';
    case 'wallet_poll':
    case 'wallet_import':
    case 'activity':
    case 'favourites':
    case 'health_probe':
      return 'background';
    default:
      return 'primary';
  }
}

/** Normalize legacy roles onto the 3-lane model. */
export function normalizeRpcRole(
  role: RpcRole | string | undefined
): NormalizedRpcRole {
  if (role === 'primary') return 'primary';
  if (role === 'secondary' || role === 'scannersB' || role === 'metrics') {
    return 'secondary';
  }
  if (role === 'background' || role === 'utility') return 'background';
  return 'primary';
}
