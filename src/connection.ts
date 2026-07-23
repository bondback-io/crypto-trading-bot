/**
 * Multi-RPC connection manager with health monitoring, auto-failover,
 * priority fee estimation, and latency/success stats.
 */

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
} from './rpcUrl';

dotenv.config();

const DEFAULT_RPC = PUBLIC_SOLANA_RPC;

export interface RpcEndpoint {
  url: string;
  label: string;
  /** Optional dedicated websocket URL */
  wsUrl?: string;
}

export interface RpcEndpointStats {
  url: string;
  label: string;
  healthy: boolean;
  latencyMs: number | null;
  successCount: number;
  failureCount: number;
  successRate: number;
  lastError?: string;
  lastCheckedAt: number | null;
  isActive: boolean;
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
}

let endpoints: EndpointState[] = [];
let activeIndex = 0;
/** Cached keypairs by trading wallet id — secrets never leave process memory */
const keypairCache = new Map<string, Keypair>();
let healthTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

function parseRpcList(): RpcEndpoint[] {
  const fromConfig = config.rpc?.endpoints ?? [];
  if (fromConfig.length > 0) {
    return normalizeRpcEndpoints(
      fromConfig.map((e, i) => ({
        url: e.url,
        label: e.label || `rpc-${i + 1}`,
        wsUrl: e.wsUrl,
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
  endpoints = list.map((endpoint) => ({
    endpoint,
    connection: new Connection(endpoint.url, {
      commitment: 'confirmed',
      wsEndpoint: endpoint.wsUrl || toWsUrl(endpoint.url),
    }),
    healthy: true,
    latencyMs: null,
    successCount: 0,
    failureCount: 0,
    lastCheckedAt: null,
    consecutiveFailures: 0,
  }));

  activeIndex = 0;
  console.log(
    `[rpc] Initialized ${endpoints.length} endpoint(s): ` +
      endpoints.map((e) => e.endpoint.label).join(', ')
  );
}

export function getRpcUrl(): string {
  ensureEndpoints();
  return endpoints[activeIndex]?.endpoint.url || DEFAULT_RPC;
}

export function getConnection(): Connection {
  ensureEndpoints();
  return endpoints[activeIndex].connection;
}

export function getActiveEndpointLabel(): string {
  ensureEndpoints();
  return endpoints[activeIndex]?.endpoint.label || 'unknown';
}

function recordSuccess(index: number, latencyMs: number): void {
  const state = endpoints[index];
  if (!state) return;
  state.successCount += 1;
  state.latencyMs = latencyMs;
  state.healthy = true;
  state.consecutiveFailures = 0;
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
    state.healthy = false;
    console.warn(
      `[rpc] ${state.endpoint.label} marked unhealthy after ${state.consecutiveFailures} failures`
    );
    void maybeSwitchEndpoint();
  }
}

async function maybeSwitchEndpoint(): Promise<void> {
  ensureEndpoints();
  if (endpoints.length <= 1) return;

  const current = endpoints[activeIndex];
  if (current?.healthy) return;

  for (let i = 0; i < endpoints.length; i++) {
    if (i === activeIndex) continue;
    const candidate = endpoints[i];
    const ok = await probeEndpoint(i);
    if (ok) {
      activeIndex = i;
      console.log(
        `[rpc] 🔄 Switched to ${candidate.endpoint.label} (${candidate.endpoint.url.slice(0, 40)}…)`
      );
      return;
    }
  }

  console.error('[rpc] All endpoints unhealthy — staying on current');
}

async function probeEndpoint(index: number): Promise<boolean> {
  const state = endpoints[index];
  if (!state) return false;

  const start = Date.now();
  try {
    await state.connection.getSlot('confirmed');
    recordSuccess(index, Date.now() - start);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordFailure(index, message);
    return false;
  }
}

/** Run a timed RPC call against the active endpoint; failover on failure */
export async function withRpc<T>(
  label: string,
  fn: (conn: Connection) => Promise<T>
): Promise<T> {
  ensureEndpoints();
  const startIndex = activeIndex;
  let lastError: unknown;

  logger.info('RPC', `start: ${label}`, {
    active: endpoints[activeIndex]?.endpoint.label,
    endpoints: endpoints.length,
  });

  for (let attempt = 0; attempt < endpoints.length; attempt++) {
    const index = (startIndex + attempt) % endpoints.length;
    const state = endpoints[index];
    if (!state.healthy && attempt > 0) continue;

    const t0 = Date.now();
    try {
      const prev = activeIndex;
      activeIndex = index;
      const result = await fn(state.connection);
      const latencyMs = Date.now() - t0;
      recordSuccess(index, latencyMs);
      if (prev !== index && state.healthy) {
        logger.info('RPC', `${label} succeeded after failover`, {
          endpoint: state.endpoint.label,
          latencyMs,
          attempt: attempt + 1,
        });
      } else {
        logger.info('RPC', `${label} ok`, {
          endpoint: state.endpoint.label,
          latencyMs,
        });
      }
      return result;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      recordFailure(index, message);
      logger.warn('RPC', `${label} failed`, {
        endpoint: state.endpoint.label,
        attempt: attempt + 1,
        maxAttempts: endpoints.length,
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
  endpoints: RpcEndpointStats[];
  jitoEnabled: boolean;
  priorityFeeLamports: number | null;
  /** True when at least one endpoint is currently healthy */
  ok: boolean;
  /** Human-readable warning when polling is likely broken */
  warning: string | null;
} {
  ensureEndpoints();
  const active = endpoints[activeIndex];
  const anyHealthy = endpoints.some((e) => e.healthy);
  let warning: string | null = null;
  if (!anyHealthy) {
    warning =
      'All RPC endpoints unhealthy — wallet buy detection is paused until RPC recovers. ' +
      'Set a real Helius/QuickNode RPC_URL on Render (not a placeholder).';
  } else if (
    /mainnet-beta\.solana\.com|publicnode\.com/i.test(active?.endpoint.url || '')
  ) {
    warning =
      'Using a public Solana RPC — fine for paper, but rate limits can miss buys. Prefer a paid Helius/QuickNode RPC_URL.';
  }
  return {
    active: getActiveEndpointLabel(),
    activeUrl: getRpcUrl(),
    endpoints: endpoints.map((s, i) => {
      const total = s.successCount + s.failureCount;
      return {
        url: s.endpoint.url,
        label: s.endpoint.label,
        healthy: s.healthy,
        latencyMs: s.latencyMs,
        successCount: s.successCount,
        failureCount: s.failureCount,
        successRate: total === 0 ? 100 : (s.successCount / total) * 100,
        lastError: s.lastError,
        lastCheckedAt: s.lastCheckedAt,
        isActive: i === activeIndex,
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
  const ok = await probeEndpoint(activeIndex);
  if (ok) {
    console.log(
      `[connection] RPC OK — ${getActiveEndpointLabel()} latency ${endpoints[activeIndex].latencyMs}ms`
    );
  } else {
    await maybeSwitchEndpoint();
    const retry = await probeEndpoint(activeIndex);
    if (retry) {
      console.log(`[connection] RPC OK after failover → ${getActiveEndpointLabel()}`);
      return true;
    }
    console.error('[connection] RPC health check failed on all endpoints');
  }
  return ok;
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
      if (!endpoints[activeIndex]?.healthy) {
        await maybeSwitchEndpoint();
      }
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
