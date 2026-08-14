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
  | 'dip_setup_watch'
  | 'trend_setup_watch'
  | 'majors_armed_watch'
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
    laneLabel: 'Trading (Alchemy)',
    intensity: 'HEAVY',
    note: 'Buy orchestration + nested send path',
  },
  {
    id: 'migration',
    label: 'Migration listener',
    lane: 'trading',
    laneLabel: 'Trading (Alchemy)',
    intensity: 'HEAVY',
    note: 'Program sig polls + parsed txs; WS logsSubscribe only if supported (else poll-only)',
  },
  {
    id: 'live_balance',
    label: 'Live wallet balance',
    lane: 'trading',
    laneLabel: 'Trading (Alchemy)',
    intensity: 'LIGHT',
    note: 'getBalance for trading wallets',
  },
  {
    id: 'mev',
    label: 'MEV sandwich check',
    lane: 'trading',
    laneLabel: 'Trading (Alchemy)',
    intensity: 'VERY HEAVY',
    note: 'Per-buy sigs + multi parse',
  },
  {
    id: 'priority_fee',
    label: 'Priority fee estimate',
    lane: 'trading',
    laneLabel: 'Trading (Alchemy)',
    intensity: 'LIGHT',
    note: 'getRecentPrioritizationFees',
  },
  {
    id: 'zion_place_trade',
    label: 'Zion Place Trade',
    lane: 'trading',
    laneLabel: 'Trading (Alchemy)',
    intensity: 'HEAVY',
    note: 'Manual Zion buy send path',
  },
  {
    id: 'market_scanner',
    label: 'Market Scanner',
    lane: 'data',
    laneLabel: 'Data (Helius)',
    intensity: 'HEAVY',
    note: 'Launch enrich / curve polls',
  },
  {
    id: 'dip_setup_watch',
    label: 'Dip/Steady setup watches',
    lane: 'data',
    laneLabel: 'Data (HTTP fanout)',
    intensity: 'VERY HEAVY',
    note: 'A/B: OFF = no Dip/Steady token fanout, structure refresh, or eager recheck (Dex/Gecko). Entry rules unchanged.',
  },
  {
    id: 'trend_setup_watch',
    label: 'Trend Rider setup watches',
    lane: 'data',
    laneLabel: 'Data (HTTP fanout)',
    intensity: 'HEAVY',
    note: 'A/B: OFF = no Trend Rider watch ticks / Dex refreshes. Entry rules unchanged.',
  },
  {
    id: 'majors_armed_watch',
    label: 'Medium/Majors armed-watch feed',
    lane: 'data',
    laneLabel: 'Data (HTTP fanout)',
    intensity: 'HEAVY',
    note: 'A/B: OFF = no Jupiter majors universe pass into Dip/Steady parks.',
  },
  {
    id: 'alpha_scan',
    label: 'AlphaScan',
    lane: 'data',
    laneLabel: 'Data (Helius)',
    intensity: 'MODERATE',
    note: 'Curve enrich on recent tokens',
  },
  {
    id: 'zion_scanner',
    label: 'Zion KOL scanner',
    lane: 'data',
    laneLabel: 'Data (Helius)',
    intensity: 'HEAVY',
    note: 'Rotating wallet sigs/parses',
  },
  {
    id: 'token_metrics',
    label: 'Token metrics (on-chain)',
    lane: 'data',
    laneLabel: 'Data (Helius)',
    intensity: 'VERY HEAVY',
    note: 'Largest-accounts / holder fan-out',
  },
  {
    id: 'anti_rug',
    label: 'Anti-rug evaluation',
    lane: 'data',
    laneLabel: 'Data (Helius)',
    intensity: 'VERY HEAVY',
    note: 'Metrics + curve + dev-sell scans',
  },
  {
    id: 'open_mark',
    label: 'Open-trade on-chain marks',
    lane: 'data',
    laneLabel: 'Data (Helius)',
    intensity: 'MODERATE',
    note: 'Bonding fallback when Jupiter/Dex miss',
  },
  {
    id: 'bonding_curve',
    label: 'Bonding curve primitive',
    lane: 'data',
    laneLabel: 'Data (Helius)',
    intensity: 'MODERATE',
    note: 'Shared getAccountInfo (many callers)',
  },
  {
    id: 'wallet_poll',
    label: 'Favourites soft-watch',
    lane: 'background',
    laneLabel: 'Background (public)',
    intensity: 'VERY HEAVY',
    note: 'Wallet getSignatures / parsed txs',
  },
  {
    id: 'activity',
    label: 'Wallet activity refresh',
    lane: 'background',
    laneLabel: 'Background (public)',
    intensity: 'MODERATE',
    note: 'Periodic activity pass',
  },
  {
    id: 'influencer_holdings',
    label: 'Influencer holdings scan',
    lane: 'background',
    laneLabel: 'Background (public)',
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
    laneLabel: 'Background (public)',
    intensity: 'LIGHT',
    note: 'Read-only; send stays on Trading',
  },
] as const;

const CORE_DEFAULT_ON: ReadonlySet<RpcWorkloadId> = new Set([
  'trade_entry',
  'live_balance',
  'priority_fee',
  'zion_place_trade',
  'open_mark',
  'health_probe',
  'bonding_curve',
]);

const enabled = new Map<RpcWorkloadId, boolean>(
  RPC_WORKLOAD_CATALOG.map((w) => [w.id, CORE_DEFAULT_ON.has(w.id)])
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
  sendRawTransaction: 'trade_entry',
  sendLegacy: 'trade_entry',
  zionTransferSend: 'zion_place_trade',
  market_scanner: 'market_scanner',
  dip_setup_watch: 'dip_setup_watch',
  trend_setup_watch: 'trend_setup_watch',
  majors_armed_watch: 'majors_armed_watch',
  alpha_scan: 'alpha_scan',
  zion: 'zion_scanner',
  zion_scanner: 'zion_scanner',
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

export const CORE_RPC_WORKLOAD_IDS: readonly RpcWorkloadId[] = [
  'trade_entry',
  'zion_place_trade',
  'priority_fee',
  'live_balance',
  'open_mark',
] as const;

const CORE_SET = new Set<RpcWorkloadId>(CORE_RPC_WORKLOAD_IDS);

export function isCoreRpcWorkload(id: RpcWorkloadId): boolean {
  return CORE_SET.has(id);
}

export function resolveWorkloadId(feature: string | undefined | null): RpcWorkloadId | null {
  if (!feature) return null;
  const key = String(feature).trim();
  if (!key) return null;
  if (FEATURE_TO_WORKLOAD[key]) return FEATURE_TO_WORKLOAD[key]!;
  if (RPC_WORKLOAD_CATALOG.some((w) => w.id === key)) return key as RpcWorkloadId;
  // Longest exact-prefix first; skip short keys like "zion" / "mev" that collide.
  const keys = Object.keys(FEATURE_TO_WORKLOAD).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (k.length < 8) continue;
    if (key.startsWith(k)) return FEATURE_TO_WORKLOAD[k]!;
  }
  return null;
}

export function isRpcWorkloadEnabled(id: RpcWorkloadId): boolean {
  return enabled.get(id) !== false;
}

export function anyBackgroundFeatureWorkloadEnabled(): boolean {
  return BACKGROUND_FEATURE_WORKLOAD_IDS.some((id) => isRpcWorkloadEnabled(id));
}

export function allWorkloadGroupsOff(): boolean {
  return (Object.keys(RPC_WORKLOAD_GROUPS) as RpcWorkloadGroupId[]).every(
    (id) => getRpcWorkloadGroupState(id) === 'off'
  );
}

/** True when every catalog workload except health_probe is OFF. */
export function allFeatureWorkloadsOff(): boolean {
  return RPC_WORKLOAD_CATALOG.every(
    (w) => w.id === 'health_probe' || !isRpcWorkloadEnabled(w.id)
  );
}

/** Idle when UI groups are all OFF, or every non-core catalog id is OFF. */
export function shouldIdleIsolate(): boolean {
  if (allWorkloadGroupsOff()) return true;
  return RPC_WORKLOAD_CATALOG.every(
    (w) => isCoreRpcWorkload(w.id) || w.id === 'health_probe' || !isRpcWorkloadEnabled(w.id)
  );
}

export function isRpcWorkloadEffectivelyEnabled(id: RpcWorkloadId): boolean {
  if (shouldIdleIsolate() && !isCoreRpcWorkload(id)) return false;
  return isRpcWorkloadEnabled(id);
}

export function assertRpcWorkloadEnabled(featureOrId: string): void {
  const id =
    (RPC_WORKLOAD_CATALOG.some((w) => w.id === featureOrId)
      ? (featureOrId as RpcWorkloadId)
      : null) || resolveWorkloadId(featureOrId);
  if (!id) {
    if (shouldIdleIsolate()) {
      throw new RpcWorkloadDisabledError('health_probe');
    }
    return;
  }
  if (!isRpcWorkloadEffectivelyEnabled(id)) {
    throw new RpcWorkloadDisabledError(id);
  }
}

function syncScannerTimersForWorkloads(): void {
  const isolated = shouldIdleIsolate();
  const marketOn = !isolated && isRpcWorkloadEnabled('market_scanner');
  const zionOn = !isolated && isRpcWorkloadEnabled('zion_scanner');
  try {
    const { stopMarketScanner, startMarketScanner } =
      require('./marketScanner') as typeof import('./marketScanner');
    if (!marketOn) {
      stopMarketScanner();
    } else {
      try {
        const { config } = require('./config') as typeof import('./config');
        if (config.marketScanner?.enabled !== false) startMarketScanner();
      } catch {
        /* */
      }
    }
  } catch {
    /* */
  }
  try {
    const { stopZionKolScanner, syncZionKolScannerLifecycle } =
      require('./zionKolScanner') as typeof import('./zionKolScanner');
    if (!zionOn) stopZionKolScanner();
    else syncZionKolScannerLifecycle();
  } catch {
    /* */
  }
}

function notifyRpcControlPlane(): void {
  try {
    const { refreshRpcHotPool, syncRpcIdleIsolation } =
      require('./connection') as typeof import('./connection');
    refreshRpcHotPool();
    syncRpcIdleIsolation();
  } catch {
    /* boot order / circular */
  }
  try {
    const { syncMigrationWorkloadGate } =
      require('./migrationListener') as typeof import('./migrationListener');
    syncMigrationWorkloadGate();
  } catch {
    /* */
  }
  syncScannerTimersForWorkloads();
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
  notifyRpcControlPlane();
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
  notifyRpcControlPlane();
  return getRpcWorkloadEnabledMap();
}

/** Master kill-switch groups for Stats → RPC → Other. */
export type RpcWorkloadGroupId =
  | 'setup_watches'
  | 'scanners'
  | 'favourites_background'
  | 'migration_mev';

export const RPC_WORKLOAD_GROUPS: Record<
  RpcWorkloadGroupId,
  { label: string; note: string; ids: readonly RpcWorkloadId[] }
> = {
  setup_watches: {
    label: 'Setup watches',
    note: 'Dip/Steady, Trend Rider, Medium/Majors armed watches',
    ids: ['dip_setup_watch', 'trend_setup_watch', 'majors_armed_watch'],
  },
  scanners: {
    label: 'Scanners',
    note: 'Market Scanner, Alpha Scan, Zion scanner',
    ids: ['market_scanner', 'alpha_scan', 'zion_scanner'],
  },
  favourites_background: {
    label: 'Favourites / Background reads',
    note: 'Wallet poll, activity, influencer holdings, Zion wallet read',
    ids: [
      'wallet_poll',
      'activity',
      'influencer_holdings',
      'zion_wallet_read',
    ],
  },
  migration_mev: {
    label: 'Migration + MEV',
    note: 'Migration listener + MEV sandwich check',
    ids: ['migration', 'mev'],
  },
};

export function getRpcWorkloadGroupState(
  groupId: RpcWorkloadGroupId
): 'on' | 'off' | 'mixed' {
  const g = RPC_WORKLOAD_GROUPS[groupId];
  if (!g) return 'off';
  let onN = 0;
  for (const id of g.ids) {
    if (isRpcWorkloadEnabled(id)) onN += 1;
  }
  if (onN === 0) return 'off';
  if (onN === g.ids.length) return 'on';
  return 'mixed';
}

export function setRpcWorkloadGroup(
  groupId: RpcWorkloadGroupId,
  enabledOn: boolean
): Record<RpcWorkloadId, boolean> {
  const g = RPC_WORKLOAD_GROUPS[groupId];
  if (!g) throw new Error(`Unknown RPC workload group: ${groupId}`);
  const patch: Partial<Record<RpcWorkloadId, boolean>> = {};
  for (const id of g.ids) patch[id] = enabledOn;
  console.log(
    `[rpc-workload] group ${groupId} → ${enabledOn ? 'ON' : 'OFF'} (${g.ids.join(', ')})`
  );
  return setRpcWorkloads(patch);
}

export function getRpcWorkloadGroupSnapshot(): Array<{
  id: RpcWorkloadGroupId;
  label: string;
  note: string;
  ids: RpcWorkloadId[];
  state: 'on' | 'off' | 'mixed';
  enabled: boolean;
}> {
  return (Object.keys(RPC_WORKLOAD_GROUPS) as RpcWorkloadGroupId[]).map(
    (id) => {
      const g = RPC_WORKLOAD_GROUPS[id];
      const state = getRpcWorkloadGroupState(id);
      return {
        id,
        label: g.label,
        note: g.note,
        ids: [...g.ids],
        state,
        enabled: state !== 'off',
      };
    }
  );
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
  notifyRpcControlPlane();
}

export function getRpcWorkloadSnapshot(): Array<
  RpcWorkloadDef & { enabled: boolean }
> {
  return RPC_WORKLOAD_CATALOG.map((w) => ({
    ...w,
    enabled: isRpcWorkloadEnabled(w.id),
  }));
}
