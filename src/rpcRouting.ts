/**
 * Feature → RPC lane map (simple 2-lane).
 * primary = Trading (Alchemy BACKUP)
 * secondary = Data (Alchemy primary)
 */

export type RpcFeature =
  | 'trade_entry'
  | 'migration'
  | 'live_balance'
  | 'open_mark'
  | 'market_scanner'
  | 'alpha_scan'
  | 'zion'
  | 'bonding_curve'
  | 'token_metrics'
  | 'anti_rug'
  | 'wallet_poll'
  | 'wallet_import'
  | 'activity'
  | 'default'
  | string;

export type RpcRole =
  | 'primary'
  | 'secondary'
  | 'utility'
  | 'scannersB'
  | 'metrics';

/**
 * Map feature → lane. Legacy utility/scannersB/metrics collapse to secondary.
 * Second arg (`shareLoad`) is ignored — kept so existing call sites compile.
 */
export function getRpcRoleFor(
  feature: RpcFeature,
  _shareLoad?: boolean
): RpcRole {
  switch (feature) {
    case 'trade_entry':
    case 'migration':
    case 'live_balance':
    case 'open_mark':
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
    case 'wallet_poll':
    case 'wallet_import':
    case 'activity':
    case 'favourites':
    case 'health_probe':
      return 'secondary';
    default:
      return 'primary';
  }
}

/** Normalize legacy roles onto the 2-lane model. */
export function normalizeRpcRole(role: RpcRole | string | undefined): 'primary' | 'secondary' {
  if (role === 'primary') return 'primary';
  return 'secondary';
}
