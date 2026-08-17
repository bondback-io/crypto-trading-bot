import { getActiveRpcLaneMap, isUpgradeEnabled } from '../registry';

export type UpgradeRpcRole = 'primary' | 'secondary' | 'utility' | 'data';

/** Wallet poll / Favourites activity. 1.2.21 default = secondary. */
export function activityRpcRole(): UpgradeRpcRole {
  if (isUpgradeEnabled('rpc_four_lane')) return 'utility';
  if (isUpgradeEnabled('rpc_classic_three_lane')) return 'utility';
  if (isUpgradeEnabled('rpc_load_mode_inventory')) return 'utility';
  if (isUpgradeEnabled('rpc_exclusive_keys')) return 'utility';
  return 'secondary';
}

/** Watch-list / token metrics. 4-lane Data slot; otherwise primary. */
export function metricsRpcRole(): UpgradeRpcRole {
  if (isUpgradeEnabled('rpc_four_lane')) return 'data';
  if (isUpgradeEnabled('rpc_exclusive_keys')) return 'data';
  return 'primary';
}

/** Market / Alpha / Zion / bonding. Lane map ON → scanner (secondary). */
export function scannerRpcRole(): UpgradeRpcRole {
  return getActiveRpcLaneMap() ? 'secondary' : 'primary';
}

export function shouldSkipIdleEmergencyProbes(): boolean {
  return (
    Boolean(getActiveRpcLaneMap()) || isUpgradeEnabled('rpc_containment_spike')
  );
}
