/**
 * Multi-RPC connection manager with dual lanes (primary / secondary),
 * health monitoring, 30s cross-lane failover, priority fees, and stats.
 */

import { AsyncLocalStorage } from 'async_hooks';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  VersionedTransaction,
  SendOptions,
} from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import { config, getActiveTradingWallet, listTradingWalletSlots, resolveTradingWalletSecret } from './config';
import { logger, errorToMeta } from './logger';
import {
  PUBLIC_SOLANA_RPC,
  normalizeRpcEndpoints,
  rpcEndpointsFromEnv,
  RPC_LANE_SUPPORTS,
  type RpcLaneRole,
} from './rpcUrl';

dotenv.config();

const DEFAULT_RPC = PUBLIC_SOLANA_RPC;

/** Workload lane — primary = trading/copy; secondary = Zion/scanner; utility/data used by RPC upgrades */
export type RpcRole = 'primary' | 'secondary' | 'utility' | 'data';

export interface RpcEndpoint {
  url: string;
  label: string;
  /** Optional dedicated websocket URL */
  wsUrl?: string;
  role?: RpcLaneRole;
  emergency?: boolean;
}

export interface RpcEndpointStats {
  url: string;
  label: string;
  role: RpcLaneRole;
  healthy: boolean;
  latencyMs: number | null;
  successCount: number;
  failureCount: number;
  successRate: number;
  lastError?: string;
  lastCheckedAt: number | null;
  unhealthySince: number | null;
  isActive: boolean;
  /** Preferred endpoint for primary/secondary/utility/data */
  lane?: RpcRole | null;
  emergency?: boolean;
}

interface EndpointState {
  endpoint: RpcEndpoint;
  connection: Connection;
  healthy: boolean;
  latencyMs: number | null;
  successCount: number;
  failureCount: number;
  lastError?: string;
  lastCheckedAt: number | null;
  consecutiveFailures: number;
  unhealthySince: number | null;
  role: RpcLaneRole;
  emergency?: boolean;
}

let endpoints: EndpointState[] = [];
/** Preferred index for each lane */
let preferredPrimary = 0;
let preferredSecondary = 0;
let preferredUtility = -1;
let preferredData = -1;
/** Currently resolved index serving each lane (may differ after failover) */
let activePrimary = 0;
let activeSecondary = 0;
/** Legacy single active pointer — mirrors primary lane for older callers */
let activeIndex = 0;

const rpcRoleAls = new AsyncLocalStorage<RpcRole>();

/** Cached keypairs by trading wallet id — secrets never leave process memory */
const keypairCache = new Map<string, Keypair>();
let healthTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

/** Default cross-lane piggyback grace — preferred must stay unhealthy this long. */
const DEFAULT_FAILOVER_DOWN_MS = 30_000;
/** Floor so env typos cannot collapse failover to zero. */
const MIN_FAILOVER_DOWN_MS = 5_000;

function failoverDownMs(): number {
  const fromEnv = Number(process.env.RPC_FAILOVER_DOWN_MS);
  if (Number.isFinite(fromEnv) && fromEnv >= MIN_FAILOVER_DOWN_MS) return fromEnv;
  const fromCfg = Number(
    (config.rpc as { failoverDownMs?: number } | undefined)?.failoverDownMs
  );
  if (Number.isFinite(fromCfg) && fromCfg >= MIN_FAILOVER_DOWN_MS) return fromCfg;
  return DEFAULT_FAILOVER_DOWN_MS;
}

function formatFailoverGrace(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function parseRpcList(): RpcEndpoint[] {
  try {
    const { getUpgradeRpcInventory } =
      require('./upgrades/rpc/inventory') as typeof import('./upgrades/rpc/inventory');
    const alt = getUpgradeRpcInventory();
    if (alt && alt.length > 0) {
      return normalizeRpcEndpoints(alt, { skipPublicFallbacks: true });
    }
  } catch {
    /* no RPC upgrade pack */
  }
  const fromConfig = config.rpc?.endpoints ?? [];
  if (fromConfig.length > 0) {
    return normalizeRpcEndpoints(
      fromConfig.map((e, i) => ({
        url: e.url,
        label: e.label || `rpc-${i + 1}`,
        wsUrl: e.wsUrl,
        role: (e as { role?: RpcLaneRole }).role,
      }))
    );
  }
  return rpcEndpointsFromEnv();
}

function toWsUrl(httpUrl: string): string {
  return httpUrl.replace('https://', 'wss://').replace('http://', 'ws://');
}

function ensureEndpoints(): void {
  if (endpoints.length > 0) return;

  const list = parseRpcList();
  endpoints = list.map((endpoint) => {
    const role: RpcLaneRole =
      endpoint.role ||
      (endpoint.label === 'primary'
        ? 'primary'
        : endpoint.label === 'secondary'
          ? 'secondary'
          : endpoint.label === 'utility'
            ? 'utility'
            : endpoint.label === 'data'
              ? 'data'
              : 'fallback');
    return {
      endpoint: { ...endpoint, role },
      connection: new Connection(endpoint.url, {
        commitment: 'confirmed',
        wsEndpoint: endpoint.wsUrl || toWsUrl(endpoint.url),
        disableRetryOnRateLimit: true,
      }),
      healthy: true,
      latencyMs: null,
      successCount: 0,
      failureCount: 0,
      lastCheckedAt: null,
      consecutiveFailures: 0,
      unhealthySince: null,
      role,
      emergency: endpoint.emergency === true,
    };
  });

  preferredPrimary = Math.max(
    0,
    endpoints.findIndex((e) => e.role === 'primary')
  );
  const secIdx = endpoints.findIndex((e) => e.role === 'secondary');
  preferredSecondary = secIdx >= 0 ? secIdx : preferredPrimary;
  preferredUtility = endpoints.findIndex((e) => e.role === 'utility');
  preferredData = endpoints.findIndex((e) => e.role === 'data');
  activePrimary = preferredPrimary;
  activeSecondary = preferredSecondary;
  activeIndex = activePrimary;

  console.log(
    `[rpc] Initialized ${endpoints.length} endpoint(s): ` +
      endpoints
        .map((e) => `${e.endpoint.label}[${e.role}]`)
        .join(', ')
  );
  console.log(
    `[rpc] Lanes — primary→${endpoints[preferredPrimary]?.endpoint.label} ` +
      `(${maskUrlForLog(endpoints[preferredPrimary]?.endpoint.url)}) · ` +
      `secondary→${endpoints[preferredSecondary]?.endpoint.label} ` +
      `(${maskUrlForLog(endpoints[preferredSecondary]?.endpoint.url)}) · ` +
      `cross-lane failover after ${formatFailoverGrace(failoverDownMs())} down` +
      (preferredPrimary === preferredSecondary ? ' · SHARED' : ' · distinct')
  );
  if (preferredPrimary === preferredSecondary) {
    console.warn(
      '[rpc] Primary and secondary resolve to the same RPC — Zion KOL shares CU with copy/signals. ' +
        'Set a distinct RPC_SECONDARY (must differ from RPC_URL).'
    );
  }
}

function maskUrlForLog(url: string | undefined): string {
  if (!url) return '—';
  try {
    const u = new URL(url);
    const host = u.host || 'rpc';
    return host.length > 40 ? host.slice(0, 38) + '…' : host;
  } catch {
    return url.replace(/\/\/.*@/, '//***@').slice(0, 40);
  }
}

/** True when both lanes prefer the same endpoint index / URL (no distinct secondary). */
export function lanesShareEndpoint(): boolean {
  ensureEndpoints();
  if (preferredPrimary === preferredSecondary) return true;
  const pUrl = endpoints[preferredPrimary]?.endpoint.url;
  const sUrl = endpoints[preferredSecondary]?.endpoint.url;
  return Boolean(pUrl && sUrl && pUrl === sUrl);
}

function currentRole(): RpcRole {
  return rpcRoleAls.getStore() ?? 'primary';
}

/** Run work on the secondary (or primary) lane — nested getConnection() inherits the role. */
export async function runWithRpcRole<T>(
  role: RpcRole,
  fn: () => Promise<T> | T
): Promise<T> {
  return rpcRoleAls.run(role, async () => await fn());
}

function preferredIndexFor(role: RpcRole): number {
  ensureEndpoints();
  if (role === 'primary') return preferredPrimary;
  if (role === 'utility') {
    return preferredUtility >= 0 ? preferredUtility : preferredSecondary;
  }
  if (role === 'data') {
    return preferredData >= 0 ? preferredData : preferredSecondary;
  }
  return preferredSecondary;
}

function downForMs(state: EndpointState | undefined): number {
  if (!state || state.healthy || !state.unhealthySince) return 0;
  return Math.max(0, Date.now() - state.unhealthySince);
}

/**
 * Resolve which endpoint index should serve a lane.
 * Preferred stays sticky until unhealthy for failoverDownMs, then piggybacks
 * on the other lane (or any healthy fallback).
 */
function resolveIndexForRole(role: RpcRole): number {
  ensureEndpoints();
  const preferred = preferredIndexFor(role);
  const pref = endpoints[preferred];
  if (pref?.healthy) {
    if (role === 'primary') {
      activePrimary = preferred;
      activeIndex = preferred;
    } else if (role === 'secondary') {
      activeSecondary = preferred;
    }
    return preferred;
  }

  const downMs = downForMs(pref);
  if (downMs > 0 && downMs < failoverDownMs()) {
    // Still within grace — keep hammering preferred (health monitor will recover).
    return preferred;
  }

  const otherPreferred = preferredIndexFor(
    role === 'primary' ? 'secondary' : 'primary'
  );
  if (
    otherPreferred !== preferred &&
    endpoints[otherPreferred]?.healthy
  ) {
    if (
      (role === 'primary' ? activePrimary : activeSecondary) !== otherPreferred
    ) {
      console.warn(
        `[rpc] ${role} lane piggybacking on ${endpoints[otherPreferred].endpoint.label} ` +
          `(preferred down ${Math.round(downMs / 1000)}s ≥ ${Math.round(failoverDownMs() / 1000)}s)`
      );
    }
    if (role === 'primary') {
      activePrimary = otherPreferred;
      activeIndex = otherPreferred;
    } else {
      activeSecondary = otherPreferred;
    }
    return otherPreferred;
  }

  for (let i = 0; i < endpoints.length; i++) {
    if (endpoints[i]?.healthy) {
      if (role === 'primary') {
        activePrimary = i;
        activeIndex = i;
      } else {
        activeSecondary = i;
      }
      return i;
    }
  }

  return preferred;
}

export function getRpcUrl(role?: RpcRole): string {
  ensureEndpoints();
  const r = role ?? currentRole();
  const idx = resolveIndexForRole(r);
  return endpoints[idx]?.endpoint.url || DEFAULT_RPC;
}

export function getConnection(role?: RpcRole): Connection {
  ensureEndpoints();
  const r = role ?? currentRole();
  const idx = resolveIndexForRole(r);
  return endpoints[idx].connection;
}

/** Rebuild lanes after an RPC upgrade pack is toggled. */
export function rebuildRpcEndpoints(): void {
  endpoints = [];
  ensureEndpoints();
}

export function getActiveEndpointLabel(role?: RpcRole): string {
  ensureEndpoints();
  const r = role ?? currentRole();
  const idx = resolveIndexForRole(r);
  return endpoints[idx]?.endpoint.label || 'unknown';
}

function recordSuccess(index: number, latencyMs: number): void {
  const state = endpoints[index];
  if (!state) return;
  state.successCount += 1;
  state.latencyMs = latencyMs;
  state.healthy = true;
  state.consecutiveFailures = 0;
  state.unhealthySince = null;
  state.lastCheckedAt = Date.now();
  state.lastError = undefined;
}

function recordFailure(index: number, error: string): void {
  const state = endpoints[index];
  if (!state) return;
  state.failureCount += 1;
  state.consecutiveFailures += 1;
  state.lastError = error;
  state.lastCheckedAt = Date.now();

  const threshold = config.rpc?.failureThreshold ?? 3;
  if (state.consecutiveFailures >= threshold) {
    if (state.healthy) {
      state.unhealthySince = Date.now();
    }
    state.healthy = false;
    console.warn(
      `[rpc] ${state.endpoint.label} marked unhealthy after ${state.consecutiveFailures} failures`
    );
    void maybeSwitchEndpoints();
  }
}

async function maybeSwitchEndpoints(): Promise<void> {
  ensureEndpoints();
  if (endpoints.length <= 1) return;
  // Re-resolve lanes (may piggyback after grace).
  resolveIndexForRole('primary');
  resolveIndexForRole('secondary');
  if (preferredUtility >= 0) resolveIndexForRole('utility');
  if (preferredData >= 0) resolveIndexForRole('data');
}

async function probeEndpoint(index: number, timeoutMs = 8_000): Promise<boolean> {
  const state = endpoints[index];
  if (!state) return false;
  if (state.emergency) {
    try {
      const { shouldSkipIdleEmergencyProbes } =
        require('./upgrades/rpc/facade') as typeof import('./upgrades/rpc/facade');
      if (shouldSkipIdleEmergencyProbes()) {
        const pref = endpoints[preferredPrimary];
        if (pref?.healthy || downForMs(pref) < failoverDownMs()) {
          return state.healthy;
        }
      }
    } catch {
      /* core path */
    }
  }

  const start = Date.now();
  try {
    await Promise.race([
      state.connection.getSlot('confirmed'),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`RPC probe timeout after ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ]);
    recordSuccess(index, Date.now() - start);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordFailure(index, message);
    return false;
  }
}

/** Run a timed RPC call against the lane's active endpoint; failover on failure */
export async function withRpc<T>(
  label: string,
  fn: (conn: Connection) => Promise<T>,
  role?: RpcRole
): Promise<T> {
  ensureEndpoints();
  const r = role ?? currentRole();
  const startIndex = resolveIndexForRole(r);
  let lastError: unknown;

  // Build attempt order: lane preferred → other lane → remaining
  const order: number[] = [];
  const pushUnique = (i: number) => {
    if (i >= 0 && i < endpoints.length && !order.includes(i)) order.push(i);
  };
  pushUnique(startIndex);
  pushUnique(preferredIndexFor(r === 'primary' ? 'secondary' : 'primary'));
  for (let i = 0; i < endpoints.length; i++) pushUnique(i);

  logger.info('RPC', `start: ${label}`, {
    role: r,
    active: endpoints[startIndex]?.endpoint.label,
    endpoints: endpoints.length,
  });

  for (let attempt = 0; attempt < order.length; attempt++) {
    const index = order[attempt];
    const state = endpoints[index];
    if (!state) continue;
    if (state.emergency) {
      try {
        const { shouldSkipIdleEmergencyProbes } =
          require('./upgrades/rpc/facade') as typeof import('./upgrades/rpc/facade');
        if (shouldSkipIdleEmergencyProbes()) {
          const pref = endpoints[preferredIndexFor(r)];
          if (pref?.healthy || downForMs(pref) < failoverDownMs()) continue;
        }
      } catch {
        /* core path */
      }
    }

    // Before failover grace, stay on preferred even if flaky (first attempt only).
    const pref = preferredIndexFor(r);
    if (
      attempt > 0 &&
      index !== pref &&
      downForMs(endpoints[pref]) < failoverDownMs() &&
      endpoints[pref] &&
      !endpoints[pref].healthy
    ) {
      // Prefer not to jump early — but if preferred is hard-failing this call, allow next.
    }
    if (!state.healthy && attempt > 0 && downForMs(endpoints[pref]) < failoverDownMs()) {
      // Skip known-unhealthy others until preferred has been down long enough
      if (index !== pref) continue;
    }

    const t0 = Date.now();
    try {
      if (r === 'primary') {
        activePrimary = index;
        activeIndex = index;
      } else {
        activeSecondary = index;
      }
      const result = await fn(state.connection);
      const latencyMs = Date.now() - t0;
      recordSuccess(index, latencyMs);
      logger.info('RPC', `${label} ok`, {
        role: r,
        endpoint: state.endpoint.label,
        latencyMs,
        attempt: attempt + 1,
      });
      return result;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      recordFailure(index, message);
      logger.warn('RPC', `${label} failed`, {
        role: r,
        endpoint: state.endpoint.label,
        attempt: attempt + 1,
        maxAttempts: order.length,
        latencyMs: Date.now() - t0,
        ...errorToMeta(err),
      });
    }
  }

  logger.error('RPC', `${label} all endpoints failed`, errorToMeta(lastError));
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? 'All RPC endpoints failed'));
}

export function getRpcStats(): {
  active: string;
  activeUrl: string;
  primary: {
    label: string;
    url: string;
    healthy: boolean;
    failover: boolean;
    downForMs: number;
  };
  secondary: {
    label: string;
    url: string;
    healthy: boolean;
    failover: boolean;
    downForMs: number;
  };
  failoverDownMs: number;
  /** True when primary and secondary prefer the same endpoint (Zion shares CU with copy). */
  lanesShareEndpoint: boolean;
  supports: typeof RPC_LANE_SUPPORTS;
  endpoints: RpcEndpointStats[];
  jitoEnabled: boolean;
  priorityFeeLamports: number | null;
  /** True when at least one endpoint is currently healthy */
  ok: boolean;
  /** Human-readable warning when polling is likely broken */
  warning: string | null;
} {
  ensureEndpoints();
  const pIdx = resolveIndexForRole('primary');
  const sIdx = resolveIndexForRole('secondary');
  const pPref = endpoints[preferredPrimary];
  const sPref = endpoints[preferredSecondary];
  const pActive = endpoints[pIdx];
  const sActive = endpoints[sIdx];
  const anyHealthy = endpoints.some((e) => e.healthy);
  const share = lanesShareEndpoint();
  let warning: string | null = null;
  if (!anyHealthy) {
    warning =
      'All RPC endpoints unhealthy — wallet buy detection is paused until RPC recovers. ' +
      'Set a real Helius/QuickNode RPC_URL on Render (not a placeholder).';
  } else if (
    /mainnet-beta\.solana\.com|publicnode\.com/i.test(pActive?.endpoint.url || '')
  ) {
    warning =
      'Using a public Solana RPC on the primary lane — fine for paper, but rate limits can miss buys. Prefer a paid Helius/QuickNode RPC_URL.';
  } else if (pIdx !== preferredPrimary) {
    warning = `Primary lane piggybacking on ${pActive?.endpoint.label} (preferred primary down >${formatFailoverGrace(failoverDownMs())}).`;
  } else if (
    preferredSecondary !== preferredPrimary &&
    sIdx !== preferredSecondary
  ) {
    warning = `Secondary lane piggybacking on ${sActive?.endpoint.label} (preferred secondary down >${formatFailoverGrace(failoverDownMs())}).`;
  } else if (share) {
    warning =
      'Primary and secondary resolve to the same RPC — Zion KOL shares CU with copy/signals. Set a distinct RPC_SECONDARY.';
  }

  const maskUrl = (url: string) =>
    url.replace(/\/\/.*@/, '//***@').slice(0, 72);

  return {
    active: getActiveEndpointLabel('primary'),
    activeUrl: getRpcUrl('primary'),
    primary: {
      label: pActive?.endpoint.label || 'primary',
      url: maskUrl(pActive?.endpoint.url || ''),
      healthy: Boolean(pPref?.healthy),
      failover: pIdx !== preferredPrimary,
      downForMs: downForMs(pPref),
    },
    secondary: {
      label: sActive?.endpoint.label || 'secondary',
      url: maskUrl(sActive?.endpoint.url || ''),
      healthy: Boolean(sPref?.healthy),
      failover: sIdx !== preferredSecondary,
      downForMs: downForMs(sPref),
    },
    failoverDownMs: failoverDownMs(),
    lanesShareEndpoint: share,
    supports: RPC_LANE_SUPPORTS,
    endpoints: endpoints.map((s, i) => {
      const total = s.successCount + s.failureCount;
      let lane: RpcRole | null = null;
      if (i === preferredPrimary) lane = 'primary';
      else if (i === preferredSecondary && preferredSecondary !== preferredPrimary)
        lane = 'secondary';
      else if (i === preferredUtility && preferredUtility >= 0) lane = 'utility';
      else if (i === preferredData && preferredData >= 0) lane = 'data';
      return {
        url: s.endpoint.url,
        label: s.endpoint.label,
        role: s.role,
        healthy: s.healthy,
        latencyMs: s.latencyMs,
        successCount: s.successCount,
        failureCount: s.failureCount,
        successRate: total === 0 ? 100 : (s.successCount / total) * 100,
        lastError: s.lastError,
        lastCheckedAt: s.lastCheckedAt,
        unhealthySince: s.unhealthySince,
        isActive: i === pIdx || i === sIdx,
        lane,
        emergency: s.emergency === true,
      };
    }),
    jitoEnabled: Boolean(config.rpc?.jito?.enabled),
    priorityFeeLamports: lastPriorityFeeLamports,
    ok: anyHealthy,
    warning,
  };
}

let lastPriorityFeeLamports: number | null = null;

/**
 * Dynamic priority fee based on recent prioritization fees for a sample account.
 * Falls back to config defaults.
 */
export async function estimatePriorityFeeMicroLamports(
  sampleAccount?: PublicKey
): Promise<number> {
  const min = config.rpc?.priorityFee?.minMicroLamports ?? 1_000;
  const max = config.rpc?.priorityFee?.maxMicroLamports ?? 500_000;
  const fallback = config.rpc?.priorityFee?.defaultMicroLamports ?? 50_000;

  try {
    const conn = getConnection();
    const account =
      sampleAccount ??
      getWalletPublicKey() ??
      new PublicKey('11111111111111111111111111111111');

    // getRecentPrioritizationFees available on newer web3.js
    const fees = await (
      conn as Connection & {
        getRecentPrioritizationFees?: (args: {
          lockedWritableAccounts: PublicKey[];
        }) => Promise<{ prioritizationFee: number }[]>;
      }
    ).getRecentPrioritizationFees?.({
      lockedWritableAccounts: [account],
    });

    if (fees && fees.length > 0) {
      const sorted = fees
        .map((f) => f.prioritizationFee)
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b);

      if (sorted.length > 0) {
        // Use ~75th percentile for competitive landing
        const idx = Math.min(
          sorted.length - 1,
          Math.floor(sorted.length * 0.75)
        );
        const estimated = Math.max(min, Math.min(max, sorted[idx] || fallback));
        // Convert micro-lamports/CU → store approximate lamports for UI (assume 200k CU)
        lastPriorityFeeLamports = Math.ceil((estimated * 200_000) / 1_000_000);
        console.log(
          `[rpc] Priority fee ~${estimated} µLamports/CU (est. ${lastPriorityFeeLamports} lamports)`
        );
        return estimated;
      }
    }
  } catch (err) {
    console.warn(
      '[rpc] Priority fee estimate failed, using default:',
      err instanceof Error ? err.message : err
    );
  }

  lastPriorityFeeLamports = Math.ceil((fallback * 200_000) / 1_000_000);
  return fallback;
}

/** Optimized send for versioned transactions with retries */
export async function sendOptimizedTransaction(
  serialized: Uint8Array,
  options: SendOptions = {}
): Promise<string> {
  return withRpc('sendRawTransaction', async (conn) => {
    const sig = await conn.sendRawTransaction(serialized, {
      skipPreflight: options.skipPreflight ?? false,
      maxRetries: options.maxRetries ?? 3,
      preflightCommitment: 'confirmed',
    });
    await conn.confirmTransaction(sig, 'confirmed');
    return sig;
  });
}

export async function sendAndConfirmVersioned(
  vtx: VersionedTransaction
): Promise<string> {
  return sendOptimizedTransaction(vtx.serialize());
}

export async function sendAndConfirmLegacyTx(tx: Transaction): Promise<string> {
  return withRpc('sendLegacy', async (conn) => {
    const { blockhash, lastValidBlockHeight } =
      await conn.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    const raw = tx.serialize();
    const sig = await conn.sendRawTransaction(raw, {
      skipPreflight: false,
      maxRetries: 3,
    });
    await conn.confirmTransaction(sig, 'confirmed');
    return sig;
  });
}

/**
 * Load keypair for the active trading wallet (or a specific slot id).
 * Secrets come only from env vars (TRADING_WALLET_* / PRIVATE_KEY) — never from API/disk.
 */
export function getKeypair(walletId?: string): Keypair | null {
  const id =
    walletId ??
    config.activeTradingWalletId ??
    getActiveTradingWallet()?.id ??
    null;

  if (!id) {
    console.warn(
      '[connection] No active trading wallet configured — live trading disabled'
    );
    return null;
  }

  const cached = keypairCache.get(id);
  if (cached) return cached;

  const slot =
    listTradingWalletSlots().find((w) => w.id === id) ??
    getActiveTradingWallet();
  if (!slot) {
    console.warn(`[connection] Trading wallet slot not found: ${id}`);
    return null;
  }

  const secret = resolveTradingWalletSecret(slot);
  if (!secret) {
    console.warn(
      `[connection] No key in env for ${slot.name} — set ${slot.envVar}` +
        (slot.role === 'main' ? ' (or PRIVATE_KEY)' : '')
    );
    return null;
  }

  try {
    const kp = Keypair.fromSecretKey(bs58.decode(secret));
    keypairCache.set(id, kp);
    console.log(
      `[connection] Loaded trading wallet "${slot.name}" → ${kp.publicKey.toBase58()}`
    );
    return kp;
  } catch (err) {
    console.error(
      `[connection] Failed to parse key for ${slot.name} (${slot.envVar}):`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/** Drop cached keypairs (e.g. after switching active wallet or removing a slot) */
export function clearKeypairCache(walletId?: string): void {
  if (walletId) {
    keypairCache.delete(walletId);
  } else {
    keypairCache.clear();
  }
}

export function getWalletPublicKey(walletId?: string): PublicKey | null {
  return getKeypair(walletId)?.publicKey ?? null;
}

/** Derive public key for a slot without selecting it as active */
export function peekTradingWalletPublicKey(walletId: string): string | null {
  try {
    return getKeypair(walletId)?.publicKey.toBase58() ?? null;
  } catch {
    return null;
  }
}

export async function getLiveBalanceSol(
  walletId?: string
): Promise<number | null> {
  const pubkey = getWalletPublicKey(walletId);
  if (!pubkey) return null;

  try {
    const lamports = await withRpc('getBalance', (conn) =>
      conn.getBalance(pubkey)
    );
    return lamports / LAMPORTS_PER_SOL;
  } catch (err) {
    console.error('[connection] Failed to fetch balance:', err);
    return null;
  }
}

/** Public-safe list of trading wallets with pubkeys + balances (no secrets) */
export async function getTradingWalletsStatus(): Promise<{
  activeId: string | null;
  wallets: Array<{
    id: string;
    name: string;
    role: string;
    envVar: string;
    enabled: boolean;
    hasKey: boolean;
    publicKey: string | null;
    balanceSol: number | null;
    isActive: boolean;
  }>;
}> {
  const wallets = [];
  for (const slot of listTradingWalletSlots()) {
    const hasKey = Boolean(resolveTradingWalletSecret(slot));
    let publicKey: string | null = null;
    let balanceSol: number | null = null;
    if (hasKey) {
      publicKey = peekTradingWalletPublicKey(slot.id);
      if (publicKey) {
        balanceSol = await getLiveBalanceSol(slot.id);
      }
    }
    wallets.push({
      id: slot.id,
      name: slot.name,
      role: slot.role,
      envVar: slot.envVar,
      enabled: slot.enabled,
      hasKey,
      publicKey,
      balanceSol,
      isActive: slot.id === config.activeTradingWalletId,
    });
  }

  return { activeId: config.activeTradingWalletId, wallets };
}

export async function testConnection(): Promise<boolean> {
  ensureEndpoints();
  startRpcHealthMonitor();
  const primaryIdx = resolveIndexForRole('primary');
  const ok = await probeEndpoint(primaryIdx, 6_000);
  if (ok) {
    console.log(
      `[connection] RPC OK — ${getActiveEndpointLabel('primary')} latency ${endpoints[primaryIdx].latencyMs}ms`
    );
    return true;
  }

  await maybeSwitchEndpoints();
  const retryIdx = resolveIndexForRole('primary');
  const retry = await probeEndpoint(retryIdx, 6_000);
  if (retry) {
    console.log(
      `[connection] RPC OK after failover → ${getActiveEndpointLabel('primary')}`
    );
    return true;
  }
  console.error('[connection] RPC health check failed on all endpoints');
  return false;
}

/** Periodic health probes + auto-switch */
export function startRpcHealthMonitor(): void {
  if (started) return;
  started = true;
  ensureEndpoints();

  const interval = config.rpc?.healthIntervalMs ?? 30_000;
  void Promise.all(endpoints.map((_, i) => probeEndpoint(i)));

  healthTimer = setInterval(() => {
    void (async () => {
      for (let i = 0; i < endpoints.length; i++) {
        await probeEndpoint(i);
      }
      await maybeSwitchEndpoints();
    })();
  }, interval);

  console.log(`[rpc] Health monitor started (every ${interval}ms)`);
}

export function stopRpcHealthMonitor(): void {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  started = false;
}
