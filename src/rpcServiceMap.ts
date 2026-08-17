/**
 * Exclusive Solana RPC service → preferred env key map.
 * Preferred keys never share with each other; failover is RPC_URL → PUBLICNODE_URL
 * (PUBLICNODE is Utility light's preferred public endpoint).
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
  /** Endpoint label registered in rpcEndpointsFromEnv */
  label: string;
  /** Env var holding API key or full URL (PUBLICNODE_URL / RPC_URL are URLs) */
  envKey: string;
  /** Gate lane for concurrency (legacy 4-lane gate) */
  gateRole: 'primary' | 'secondary' | 'utility' | 'watchers';
  title: string;
  /** Relative CU pressure */
  intensity: 'high' | 'med' | 'low';
  /** Preferred key is never shared with another service */
  exclusive: true;
  blurb: string;
};

/** Locked Render assignment — one preferred key per service. */
export const RPC_EXCLUSIVE_SERVICES: readonly RpcExclusiveServiceDef[] = [
  {
    service: 'trading_critical',
    label: 'alchemy',
    envKey: 'ALCHEMY_API_KEY',
    gateRole: 'primary',
    title: 'Trading Critical + MEV',
    intensity: 'high',
    exclusive: true,
    blurb: 'Buys, sells, confirms, sandwich check',
  },
  {
    service: 'favourites_watch',
    label: 'alchemy-backup',
    envKey: 'ALCHEMY_API_KEY_BACKUP',
    gateRole: 'utility',
    title: 'Favourites soft-watch',
    intensity: 'high',
    exclusive: true,
    blurb: 'Wallet signature poll → copy signals',
  },
  {
    service: 'setup_watch',
    label: 'alchemy-backup2',
    envKey: 'ALCHEMY_API_KEY_BACKUP2',
    gateRole: 'watchers',
    title: 'Setup watches',
    intensity: 'high',
    exclusive: true,
    blurb: 'Dip / Trend / Scalper / Grad arm + trigger',
  },
  {
    service: 'market_scanner',
    label: 'alchemy-backup3',
    envKey: 'ALCHEMY_API_KEY_BACKUP3',
    gateRole: 'secondary',
    title: 'Market Scanner',
    intensity: 'high',
    exclusive: true,
    blurb: 'Universe + bonding-curve enrich',
  },
  {
    service: 'zion',
    label: 'alchemy-backup4',
    envKey: 'ALCHEMY_API_KEY_BACKUP4',
    gateRole: 'secondary',
    title: 'Zion KOL Scanner',
    intensity: 'med',
    exclusive: true,
    blurb: 'KOL signature rotate + parse buys',
  },
  {
    service: 'migration',
    label: 'alchemy-backup5',
    envKey: 'ALCHEMY_API_KEY_BACKUP5',
    gateRole: 'secondary',
    title: 'Migration listener',
    intensity: 'med',
    exclusive: true,
    blurb: 'Program sig polls / graduation parses',
  },
  {
    service: 'alpha_scan',
    label: 'alchemy-backup6',
    envKey: 'ALCHEMY_API_KEY_BACKUP6',
    gateRole: 'secondary',
    title: 'AlphaScan',
    intensity: 'med',
    exclusive: true,
    blurb: 'Jupiter recent + curve enrich',
  },
  {
    service: 'signal_safety',
    label: 'alchemy-backup7',
    envKey: 'ALCHEMY_API_KEY_BACKUP7',
    gateRole: 'secondary',
    title: 'Signal safety',
    intensity: 'med',
    exclusive: true,
    blurb: 'Anti-rug / holders / on-chain metrics',
  },
  {
    service: 'activity',
    label: 'helius',
    envKey: 'HELIUS_API_KEY',
    gateRole: 'utility',
    title: 'Activity refresh',
    intensity: 'med',
    exclusive: true,
    blurb: 'Periodic wallet activity (not soft-watch)',
  },
  {
    service: 'utility_light',
    label: 'publicnode',
    envKey: 'PUBLICNODE_URL',
    gateRole: 'utility',
    title: 'Utility light',
    intensity: 'low',
    exclusive: true,
    blurb: 'Health probes, priority fees, ungated reads (PUBLICNODE)',
  },
] as const;

export const RPC_EMERGENCY_SERVICES = [
  {
    label: 'rpc-url',
    envKey: 'RPC_URL',
    title: 'Emergency RPC_URL',
    intensity: 'emergency' as const,
    exclusive: false,
    blurb: 'Emergency failover for exclusives (often slow from Render)',
  },
  {
    label: 'publicnode',
    envKey: 'PUBLICNODE_URL',
    title: 'PUBLICNODE (Utility light + emergency)',
    intensity: 'emergency' as const,
    exclusive: false,
    blurb: 'Preferred for Utility light; emergency failover after RPC_URL',
  },
] as const;

/**
 * Failover labels for non-utility exclusives.
 * `publicnode` is also Utility light's preferred key (shared only on emergency).
 */
export const RPC_EMERGENCY_LABELS = ['rpc-url', 'publicnode'] as const;

const FEATURE_TO_SERVICE: Record<string, RpcExclusiveService> = {
  trade_entry: 'trading_critical',
  trade_exit: 'trading_critical',
  send_tx: 'trading_critical',
  mev_sandwich: 'trading_critical',
  wallet_poll: 'favourites_watch',
  wallet_import: 'favourites_watch',
  setup_watch: 'setup_watch',
  market_scanner: 'market_scanner',
  alpha_scan: 'alpha_scan',
  zion: 'zion',
  migration: 'migration',
  signal_safety: 'signal_safety',
  anti_rug: 'signal_safety',
  token_metrics: 'signal_safety',
  bonding_curve: 'market_scanner',
  activity: 'activity',
  utility_light: 'utility_light',
  health_probe: 'utility_light',
  ungated: 'utility_light',
  default: 'trading_critical',
};

export function exclusiveServiceForFeature(
  feature: string | null | undefined
): RpcExclusiveServiceDef | null {
  const f = String(feature || '').trim() || 'ungated';
  const svc = FEATURE_TO_SERVICE[f] || FEATURE_TO_SERVICE.ungated;
  return RPC_EXCLUSIVE_SERVICES.find((s) => s.service === svc) || null;
}

export function exclusiveServiceByLabel(
  label: string | null | undefined
): RpcExclusiveServiceDef | null {
  const l = String(label || '').toLowerCase();
  return RPC_EXCLUSIVE_SERVICES.find((s) => s.label === l) || null;
}

export function isExclusiveEndpointLabel(
  label: string | null | undefined
): boolean {
  return exclusiveServiceByLabel(label) != null;
}

export function isEmergencyEndpointLabel(
  label: string | null | undefined
): boolean {
  const l = String(label || '').toLowerCase();
  return (RPC_EMERGENCY_LABELS as readonly string[]).includes(l);
}
