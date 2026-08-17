/**
 * Exclusive Solana RPC service map — classic stubs (no BACKUP key assignment).
 * Callers that still import exclusive helpers get null / empty labels.
 */

export type RpcExclusiveService =
  | 'trading_critical'
  | 'favourites_watch'
  | 'setup_watch'
  | 'market_scanner'
  | 'zion'
  | 'migration'
  | 'alpha_scan'
  | 'signal_safety'
  | 'activity'
  | 'utility_light';

export type RpcExclusiveServiceDef = {
  service: RpcExclusiveService;
  label: string;
  envKey: string;
  gateRole: 'primary' | 'secondary' | 'utility';
  title: string;
  intensity: 'high' | 'med' | 'low';
  exclusive: true;
  blurb: string;
};

/** Classic: no exclusive preferred-key map. */
export const RPC_EXCLUSIVE_SERVICES: readonly RpcExclusiveServiceDef[] = [];

export const RPC_EMERGENCY_SERVICES = [] as const;

export const RPC_EMERGENCY_LABELS = [] as const;

export function exclusiveServiceForFeature(
  _feature: string | null | undefined
): RpcExclusiveServiceDef | null {
  void _feature;
  return null;
}

export function exclusiveServiceByLabel(
  _label: string | null | undefined
): RpcExclusiveServiceDef | null {
  void _label;
  return null;
}

export function isExclusiveEndpointLabel(
  _label: string | null | undefined
): boolean {
  void _label;
  return false;
}

export function isEmergencyEndpointLabel(
  _label: string | null | undefined
): boolean {
  void _label;
  return false;
}
