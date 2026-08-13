/**
 * Operator kill-switches for RPC-calling subsystems (Stats → RPC).
 * Used to isolate thrashing / latency without changing strategy code.
 */

export type RpcWorkloadLane = 'trading' | 'data' | 'background';

export type RpcWorkloadId =
  | 'trade_entry'
  | 'migration'
  | 'live_balance'
  | 'mev'
  | 'priority_fee'
  | 'market_scanner'
  | 'alpha_scan'
  | 'zion_scanner'
  | 'zion_place_trade'
  | 'token_metrics'
  | 'anti_rug'
  | 'open_mark'
  | 'bonding_curve'
  | 'wallet_poll'
  | 'activity'
  | 'influencer_holdings'
  | 'health_probe'
  | 'zion_wallet_read';

export type RpcWorkloadDef = {
  id: RpcWorkloadId;
  label: string;
  lane: RpcWorkloadLane;
  laneLabel: string;
  intensity: 'VERY HEAVY' | 'HEAVY' | 'MODERATE' | 'LIGHT';
  note: string;
};

/** Background feature workloads (excludes health_probe — probes must not keep Background hot). */
export const BACKGROUND_FEATURE_WORKLOAD_IDS: readonly RpcWorkloadId[] = [
  'wallet_poll',
  'activity',
  'influencer_holdings',
  'zion_wallet_read',
] as const;

export const RPC_WORKLOAD_CATALOG: readonly RpcWorkloadDef[] = [
  {
    id: 'trade_entry',
    label: 'Trade entry / buys',
    lane: 'trading',
    laneLabel: 'Trading (Alchemy BACKUP)',
    intensity: 'HEAVY',
    note: 'Buy orchestration + nested send path',
  },
  {
    id: 'migration',
    label: 'Migration listener',
    lane: 'trading',
    laneLabel: 'Trading (Alchemy BACKUP)',
    intensity: 'HEAVY',
    note: 'Program sig polls + parsed txs / WS',
  },
  {
    id: 'live_balance',
    label: 'Live wallet balance',
    lane: 'trading',
    laneLabel: 'Trading (Alchemy BACKUP)',
    intensity: 'LIGHT',
    note: 'getBalance for trading wallets',
  },
  {
    id: 'mev',
    label: 'MEV sandwich check',
    lane: 'trading',
    laneLabel: 'Trading (Alchemy BACKUP)',
    intensity: 'VERY HEAVY',
    note: 'Per-buy sigs + multi parse',
  },
  {
    id: 'priority_fee',
    label: 'Priority fee estimate',
    lane: 'trading',
    laneLabel: 'Trading (Alchemy BACKUP)',
    intensity: 'LIGHT',
    note: 'getRecentPrioritizationFees',
  },
  {
    id: 'zion_place_trade',
    label: 'Zion Place Trade',
    lane: 'trading',
    laneLabel: 'Trading (Alchemy BACKUP)',
    intensity: 'HEAVY',
    note: 'Manual Zion buy send path',
  },
  {
    id: 'market_scanner',
    label: 'Market Scanner',
    lane: 'data',
    laneLabel: 'Data (Alchemy)',
    intensity: 'HEAVY',
    note: 'Launch enrich / curve polls',
  },
  {
    id: 'alpha_scan',
    label: 'AlphaScan',
    lane: 'data',
    laneLabel: 'Data (Alchemy)',
    intensity: 'MODERATE',
    note: 'Curve enrich on recent tokens',
  },
  {
    id: 'zion_scanner',
    label: 'Zion KOL scanner',
    lane: 'data',
    laneLabel: 'Data (Alchemy)',
    intensity: 'HEAVY',
    note: 'Rotating wallet sigs/parses',
  },
  {
    id: 'token_metrics',
    label: 'Token metrics (on-chain)',
    lane: 'data',
    laneLabel: 'Data (Alchemy)',
    intensity: 'VERY HEAVY',
    note: 'Largest-accounts / holder fan-out',
  },
  {
    id: 'anti_rug',
    label: 'Anti-rug evaluation',
    lane: 'data',
    laneLabel: 'Data (Alchemy)',
    intensity: 'VERY HEAVY',
    note: 'Metrics + curve + dev-sell scans',
  },
  {
    id: 'open_mark',
    label: 'Open-trade on-chain marks',
    lane: 'data',
    laneLabel: 'Data (Alchemy)',
    intensity: 'MODERATE',
    note: 'Bonding fallback when Jupiter/Dex miss',
  },
  {
    id: 'bonding_curve',
    label: 'Bonding curve primitive',
    lane: 'data',
    laneLabel: 'Data (Alchemy)',
    intensity: 'MODERATE',
    note: 'Shared getAccountInfo (many callers)',
  },
  {
    id: 'wallet_poll',
    label: 'Favourites soft-watch',
    lane: 'background',
    laneLabel: 'Background (Alchemy BACKUP2 → public)',
    intensity: 'VERY HEAVY',
    note: 'Wallet getSignatures / parsed txs',
  },
  {
    id: 'activity',
    label: 'Wallet activity refresh',
    lane: 'background',
    laneLabel: 'Background (Alchemy BACKUP2 → public)',
    intensity: 'MODERATE',
    note: 'Periodic activity pass',
  },
  {
    id: 'influencer_holdings',
    label: 'Influencer holdings scan',
    lane: 'background',
    laneLabel: 'Background (Alchemy BACKUP2 → public)',
    intensity: 'VERY HEAVY',
    note: 'getParsedTokenAccountsByOwner × wallets',
  },
  {
    id: 'health_probe',
    label: 'RPC health probes',
    lane: 'background',
    laneLabel: 'Control-plane (rare getSlot)',
    intensity: 'LIGHT',
    note: 'One probe per active lane; Background only when feature bg workloads ON; 120s / 300s when features OFF',
  },
  {
    id: 'zion_wallet_read',
    label: 'Zion wallet balance / sigs',
    lane: 'background',
    laneLabel: 'Background (Alchemy BACKUP2 → public)',
    intensity: 'LIGHT',
    note: 'Read-only; send stays on Trading',
  },
] as const;

const enabled = new Map<RpcWorkloadId, boolean>(
  RPC_WORKLOAD_CATALOG.map((w) => [w.id, true])
);

const FEATURE_TO_WORKLOAD: Record<string, RpcWorkloadId> = {
  trade_entry: 'trade_entry',
  migration: 'migration',
  live_balance: 'live_balance',
  getBalance: 'live_balance',
  mev: 'mev',
  mev_sandwich: 'mev',
  priority_fee: 'priority_fee',
  zion_place_trade: 'zion_place_trade',
  market_scanner: 'market_scanner',
  alpha_scan: 'alpha_scan',
  zion: 'zion_scanner',
  token_metrics: 'token_metrics',
  anti_rug: 'anti_rug',
  open_mark: 'open_mark',
  bonding_curve: 'bonding_curve',
  wallet_poll: 'wallet_poll',
  favourites: 'wallet_poll',
  activity: 'activity',
  wallet_import: 'activity',
  health_probe: 'health_probe',
  zionWalletBalance: 'zion_wallet_read',
  zionWalletSigs: 'zion_wallet_read',
  influencer_holdings: 'influencer_holdings',
};

export class RpcWorkloadDisabledError extends Error {
  readonly workloadId: RpcWorkloadId;
  constructor(workloadId: RpcWorkloadId) {
    super(`RPC workload disabled for testing: ${workloadId}`);
    this.name = 'RpcWorkloadDisabledError';
    this.workloadId = workloadId;
  }
}

export function isRpcWorkloadDisabledError(err: unknown): err is RpcWorkloadDisabledError {
  return (
    err instanceof RpcWorkloadDisabledError ||
    (err instanceof Error && err.name === 'RpcWorkloadDisabledError')
  );
}

export function resolveWorkloadId(feature: string | undefined | null): RpcWorkloadId | null {
  if (!feature) return null;
  const key = String(feature).trim();
  if (!key) return null;
  if (FEATURE_TO_WORKLOAD[key]) return FEATURE_TO_WORKLOAD[key]!;
  for (const [k, id] of Object.entries(FEATURE_TO_WORKLOAD)) {
    if (key === k || key.startsWith(k)) return id;
  }
  return null;
}

export function isRpcWorkloadEnabled(id: RpcWorkloadId): boolean {
  return enabled.get(id) !== false;
}

export function anyBackgroundFeatureWorkloadEnabled(): boolean {
  return BACKGROUND_FEATURE_WORKLOAD_IDS.some((id) => isRpcWorkloadEnabled(id));
}

/** True when every catalog workload except health_probe is OFF. */
export function allFeatureWorkloadsOff(): boolean {
  return RPC_WORKLOAD_CATALOG.every(
    (w) => w.id === 'health_probe' || !isRpcWorkloadEnabled(w.id)
  );
}

export function assertRpcWorkloadEnabled(featureOrId: string): void {
  const id =
    (RPC_WORKLOAD_CATALOG.some((w) => w.id === featureOrId)
      ? (featureOrId as RpcWorkloadId)
      : null) || resolveWorkloadId(featureOrId);
  if (!id) return;
  if (!isRpcWorkloadEnabled(id)) {
    throw new RpcWorkloadDisabledError(id);
  }
}

function notifyHotPoolRefresh(): void {
  try {
    const { refreshRpcHotPool } =
      require('./connection') as typeof import('./connection');
    refreshRpcHotPool();
  } catch {
    /* boot order / circular */
  }
}

export function setRpcWorkloadEnabled(
  id: RpcWorkloadId,
  on: boolean
): boolean {
  if (!RPC_WORKLOAD_CATALOG.some((w) => w.id === id)) {
    throw new Error(`Unknown RPC workload: ${id}`);
  }
  enabled.set(id, Boolean(on));
  console.log(
    `[rpc-workload] ${id} → ${on ? 'ON' : 'OFF'} (test kill-switch)`
  );
  notifyHotPoolRefresh();
  return isRpcWorkloadEnabled(id);
}

export function setRpcWorkloads(
  patch: Partial<Record<RpcWorkloadId, boolean>>
): Record<RpcWorkloadId, boolean> {
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === 'boolean' && RPC_WORKLOAD_CATALOG.some((w) => w.id === k)) {
      enabled.set(k as RpcWorkloadId, v);
    }
  }
  notifyHotPoolRefresh();
  return getRpcWorkloadEnabledMap();
}

export function getRpcWorkloadEnabledMap(): Record<RpcWorkloadId, boolean> {
  const out = {} as Record<RpcWorkloadId, boolean>;
  for (const w of RPC_WORKLOAD_CATALOG) {
    out[w.id] = isRpcWorkloadEnabled(w.id);
  }
  return out;
}

export function applyRpcWorkloadSaved(
  saved: Partial<Record<string, boolean>> | null | undefined
): void {
  if (!saved || typeof saved !== 'object') return;
  for (const w of RPC_WORKLOAD_CATALOG) {
    if (typeof saved[w.id] === 'boolean') {
      enabled.set(w.id, saved[w.id] as boolean);
    }
  }
  notifyHotPoolRefresh();
}

export function getRpcWorkloadSnapshot(): Array<
  RpcWorkloadDef & { enabled: boolean }
> {
  return RPC_WORKLOAD_CATALOG.map((w) => ({
    ...w,
    enabled: isRpcWorkloadEnabled(w.id),
  }));
}
