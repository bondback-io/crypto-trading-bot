/**
 * Real-time Pump.fun → PumpSwap / Raydium migration listener.
 *
 * Subscribes to program logs via Solana WebSocket (`onLogs`) for migrate /
 * graduation events, with polling fallback and automatic reconnection.
 *
 * Priority signals fire when a tracked smart wallet is involved or when
 * migration tx SOL volume spikes above threshold.
 */

import {
  Logs,
  Context,
  PublicKey,
  ParsedTransactionWithMeta,
  Connection,
} from '@solana/web3.js';
import { config } from './config';
import { isDeniedCopyMint } from './deniedMints';
import {
  getActiveEndpointLabel,
  getConnection,
  getRpcGateSnapshot,
  getRpcStats,
  getRpcUrl,
  noteActiveRpcFailure,
  runWithRpcRole,
  shouldDeferHeavyRpc,
} from './connection';
import { isPublicRpcUrl, isSoftThrottleRpcUrl } from './rpcUrl';
import { getRpcRoleFor } from './rpcRouting';

/** Raydium AMM v4 — common post-migration venue */
const RAYDIUM_AMM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

/** Known system / token program accounts to skip when guessing pool */
const SKIP_ACCOUNTS = new Set([
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'ComputeBudget111111111111111111111111111111',
  'SysvarRent111111111111111111111111111111111',
  'SysvarC1ock11111111111111111111111111111111',
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
]);

export interface MigrationEvent {
  mint: string;
  /** AMM / pool account when identifiable */
  poolAddress: string | null;
  signature: string;
  /** On-chain block time (ms) */
  timestamp: number;
  /** Wall-clock detection time (ms) */
  detectedAt: number;
  source: 'websocket' | 'poll' | 'manual';
  program: 'pumpfun' | 'pumpswap' | 'raydium' | 'unknown';
  smartWalletsInvolved: string[];
  smartWalletNames: string[];
  /** Approx SOL moved in the tx (lamports → SOL) */
  volumeSol: number;
  volumeSpike: boolean;
  /** Priority when smart wallet involved and/or volume spike */
  priority: boolean;
  priorityReason?: string;
}

export type MigrationHandler = (event: MigrationEvent) => void | Promise<void>;

const recentMigrations = new Map<string, MigrationEvent>();
const processedSigs = new Set<string>();

let migrationTimer: ReturnType<typeof setInterval> | null = null;
let healthTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

let lastMigrationSig: string | null = null;
let running = false;
let wsMode = false;
let reconnectAttempts = 0;
let lastWsEventAt = 0;
let lastSubscribeAt = 0;
let subscribedRpcUrl = '';

/**
 * Dedicated Connection for migration onLogs only — never share Trading HTTP
 * pool's WS (web3.js retries failed logsSubscribe forever → Render thrash).
 */
let migrationWsConn: Connection | null = null;

/** HTTP RPC URL for which logsSubscribe returned method-not-found (-32601). */
let logsSubscribeUnsupportedUrl: string | null = null;
/** Session hard-disable until endpoint URL changes. */
let logsSubscribeHardDisabled = false;
let logsSubscribeUnsupportedLogged = false;

const subIds: number[] = [];

let onMigrationHandler: MigrationHandler | null = null;
let onPriorityHandler: MigrationHandler | null = null;

const MIGRATION_TTL_MS = 30 * 60 * 1000;
const POLL_MS = 12_000;
/** When Critical is warm/hot or the gate is stressed, back off polls (still Critical lane). */
const POLL_MS_WARM = 30_000;
const POLL_MS_STRESSED = 45_000;
const MAX_PROCESSED_SIGS = 800;
const WS_STALE_MS = 4 * 60 * 1000;
const HEALTH_CHECK_MS = 45_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
/** After RPC 429, pause migration polls so we don't amplify rate limits */
const RATE_LIMIT_BACKOFF_MS = 45_000;
/** At most one getParsedTransaction from WS at a time on free RPCs */
let migrationParseInFlight = 0;
const MAX_WS_PARSE_IN_FLIGHT = 1;

/** Programs whose signature cursors have been seeded (no historical replay) */
const seededPollPrograms = new Set<string>();
let rateLimitedUntil = 0;
let lastRateLimitLogAt = 0;
let lastMigrationPollAt = 0;
let lastTimeoutLogAt = 0;

/** True 429 / provider rate-limit only — timeouts must not mark Helius unhealthy. */
function isRpcRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|rate.?limit|-32429|too many requests/i.test(msg);
}

function isRpcTimeoutOrFetchError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|timed out|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up|fetch failed|UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|probe timeout/i.test(
    msg
  );
}

function rpcHostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '(invalid)';
  }
}

/**
 * Opt-in only: MIGRATION_WS=1 (or true/on/yes) enables logsSubscribe.
 * Default OFF — web3.js retries -32601 forever (max_reconnects: Infinity) and
 * thrashes Alchemy/Render when the endpoint has no WS logsSubscribe.
 */
function isMigrationWsEnvEnabled(): boolean {
  const v = (process.env.MIGRATION_WS || process.env.MIGRATION_LOGS_SUBSCRIBE || '')
    .trim()
    .toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

function isLogsSubscribeMethodNotFound(err: unknown): boolean {
  if (err == null) return false;
  const any = err as { code?: unknown; message?: unknown };
  if (any.code === -32601 || any.code === '-32601') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /-32601/.test(msg) ||
    /method ['`]?logsSubscribe['`]? not found/i.test(msg) ||
    (/not found/i.test(msg) && /logsSubscribe/i.test(msg)) ||
    /method not found/i.test(msg)
  );
}

function migrationWsAllowedForUrl(url: string): boolean {
  if (!url) return false;
  if (!isMigrationWsEnvEnabled()) return false;
  if (logsSubscribeHardDisabled && logsSubscribeUnsupportedUrl === url) {
    return false;
  }
  if (isPublicRpcUrl(url) || isSoftThrottleRpcUrl(url)) return false;
  return true;
}

type MigrationWsConnInternal = {
  _subscriptionsByHash?: Record<
    string,
    { callbacks?: { clear?: () => void; size?: number } }
  >;
  _subscriptionHashByClientSubscriptionId?: Record<number, string>;
  _subscriptionDisposeFunctionsByClientSubscriptionId?: Record<
    number,
    () => Promise<void>
  >;
  _subscriptionCallbacksByServerSubscriptionId?: Record<string | number, unknown>;
  _rpcWebSocketConnected?: boolean;
  _rpcWebSocketIdleTimeout?: ReturnType<typeof setTimeout> | null;
  _rpcWebSocketHeartbeat?: ReturnType<typeof setInterval> | null;
  _updateSubscriptions?: () => Promise<void>;
  _rpcWebSocket?: {
    close?: (code?: number, reason?: string) => void;
    call?: (method: string, args?: unknown) => Promise<unknown>;
    connect?: (...a: unknown[]) => unknown;
    removeAllListeners?: (...a: unknown[]) => unknown;
    max_reconnects?: number;
    reconnect?: boolean;
    readyState?: number;
  };
};

/**
 * Hard-kill web3.js subscription state + WS client.
 * Must stop `_updateSubscriptions` pending→retry and `max_reconnects: Infinity`.
 */
function destroyMigrationWsConn(conn: Connection | null): void {
  if (!conn) return;
  const c = conn as unknown as MigrationWsConnInternal;
  try {
    // Block further subscribe retries even if something restores a hash.
    c._updateSubscriptions = async () => undefined;
  } catch {
    /* */
  }
  try {
    if (c._subscriptionsByHash) {
      for (const hash of Object.keys(c._subscriptionsByHash)) {
        c._subscriptionsByHash[hash]?.callbacks?.clear?.();
        delete c._subscriptionsByHash[hash];
      }
    }
    c._subscriptionHashByClientSubscriptionId = {};
    c._subscriptionDisposeFunctionsByClientSubscriptionId = {};
    c._subscriptionCallbacksByServerSubscriptionId = {};
  } catch {
    /* */
  }
  try {
    if (c._rpcWebSocketIdleTimeout) {
      clearTimeout(c._rpcWebSocketIdleTimeout);
      c._rpcWebSocketIdleTimeout = null;
    }
    if (c._rpcWebSocketHeartbeat) {
      clearInterval(c._rpcWebSocketHeartbeat);
      c._rpcWebSocketHeartbeat = null;
    }
    c._rpcWebSocketConnected = false;
  } catch {
    /* */
  }
  const ws = c._rpcWebSocket;
  if (ws) {
    try {
      ws.max_reconnects = 0;
      (ws as { reconnect?: boolean }).reconnect = false;
    } catch {
      /* */
    }
    try {
      ws.connect = () => undefined;
    } catch {
      /* */
    }
    try {
      ws.call = async () => {
        throw Object.assign(new Error('migration_ws_destroyed'), {
          code: -32601,
        });
      };
    } catch {
      /* */
    }
    try {
      ws.removeAllListeners?.();
    } catch {
      /* */
    }
    try {
      // 1000 = normal close → web3 skips auto-resubscribe path
      ws.close?.(1000, 'migration_ws_disabled');
    } catch {
      try {
        ws.close?.();
      } catch {
        /* */
      }
    }
  }
}

function disableLogsSubscribeUnsupported(url: string, detail?: string): void {
  logsSubscribeHardDisabled = true;
  logsSubscribeUnsupportedUrl = url;
  wsMode = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const conn = migrationWsConn;
  subIds.length = 0;
  migrationWsConn = null;
  destroyMigrationWsConn(conn);
  if (!logsSubscribeUnsupportedLogged) {
    logsSubscribeUnsupportedLogged = true;
    console.warn(
      `[migration] logsSubscribe_unsupported_disabled host=${rpcHostOf(url)}` +
        (detail ? ` detail=${String(detail).slice(0, 120)}` : '') +
        ' — poll-only (WS destroyed, no reconnect)'
    );
  }
}

function wrapWsCallForMethodNotFound(conn: Connection, httpUrl: string): void {
  const c = conn as unknown as MigrationWsConnInternal;
  const ws = c._rpcWebSocket;
  if (!ws || typeof ws.call !== 'function') return;
  if ((ws as { __migrationLogsGuard?: boolean }).__migrationLogsGuard) return;
  const origCall = ws.call.bind(ws);
  (ws as { __migrationLogsGuard?: boolean }).__migrationLogsGuard = true;
  // Stop infinite socket reconnect storms from the client itself.
  try {
    ws.max_reconnects = 0;
  } catch {
    /* */
  }
  ws.call = async (method: string, args?: unknown) => {
    if (logsSubscribeHardDisabled) {
      throw Object.assign(new Error('logsSubscribe_hard_disabled'), {
        code: -32601,
      });
    }
    try {
      return await origCall(method, args);
    } catch (err) {
      if (method === 'logsSubscribe' && isLogsSubscribeMethodNotFound(err)) {
        disableLogsSubscribeUnsupported(
          httpUrl,
          err instanceof Error
            ? err.message
            : typeof err === 'object' && err && 'message' in err
              ? String((err as { message: unknown }).message)
              : String(err)
        );
      }
      throw err;
    }
  };
}

function noteMigrationTimeout(err: unknown): void {
  if (Date.now() - lastTimeoutLogAt < 15_000) return;
  lastTimeoutLogAt = Date.now();
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(
    `[migration] RPC timeout/fetch failed — skipping this cycle (not marking Helius unhealthy): ${String(msg).slice(0, 120)}`
  );
}

function armRateLimitBackoff(err: unknown): void {
  rateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
  noteActiveRpcFailure(err, 'primary');
  if (Date.now() - lastRateLimitLogAt > 15_000) {
    lastRateLimitLogAt = Date.now();
    console.warn(
      `[migration] RPC rate-limited — pausing polls ${RATE_LIMIT_BACKOFF_MS / 1000}s ` +
        `and marking active endpoint for failover. Check ALCHEMY_API_KEY / HELIUS_API_KEY.`
    );
  }
}

/** Default SOL moved in migrate tx to count as volume spike */
const DEFAULT_VOLUME_SPIKE_SOL = 40;

export function onMigration(handler: MigrationHandler): void {
  onMigrationHandler = handler;
}

/**
 * Called for priority migrations (smart wallet and/or volume spike)
 * when `enableMigrationPriority` is on.
 */
export function onMigrationPriority(handler: MigrationHandler): void {
  onPriorityHandler = handler;
}

/** True after boot requested migration — used to resume after idle isolation. */
let bootRequested = false;

export function startMigrationListener(): void {
  bootRequested = true;
  try {
    const {
      isRpcWorkloadEnabled,
      allFeatureWorkloadsOff,
    } = require('./rpcWorkloadControl') as typeof import('./rpcWorkloadControl');
    if (!isRpcWorkloadEnabled('migration') || allFeatureWorkloadsOff()) {
      console.warn(
        '[migration] start skipped — migration workload OFF or idle isolation (all features OFF)'
      );
      try {
        const { markMigrationResumeWanted } =
          require('./connection') as typeof import('./connection');
        markMigrationResumeWanted(true);
      } catch {
        /* */
      }
      return;
    }
  } catch {
    /* */
  }
  if (running) return;
  running = true;
  reconnectAttempts = 0;
  seededPollPrograms.clear();
  try {
    const { markMigrationResumeWanted } =
      require('./connection') as typeof import('./connection');
    markMigrationResumeWanted(true);
  } catch {
    /* */
  }

  console.log('[migration] ═══════════════════════════════════════');
  console.log('[migration] Starting real-time migration listener');
  console.log(`[migration]   Pump.fun:  ${config.pumpFunProgramId}`);
  console.log(`[migration]   PumpSwap:  ${config.pumpSwapProgramId}`);
  console.log(`[migration]   Raydium:   ${RAYDIUM_AMM_V4}`);
  console.log(
    `[migration]   Priority:  ${config.strategy.enableMigrationPriority ? 'ON' : 'OFF'}`
  );
  console.log(
    `[migration]   Vol spike: ≥${config.strategy.migrationVolumeSpikeSol ?? DEFAULT_VOLUME_SPIKE_SOL} SOL`
  );
  console.log('[migration] ═══════════════════════════════════════');

  // HTTP reads (poll) vs WS logsSubscribe are separate — never storm WS reconnects.
  const rpcUrl = getRpcUrl();
  if (!isMigrationWsEnvEnabled()) {
    console.warn(
      '[migration] poll-only — logsSubscribe OFF by default (set MIGRATION_WS=1 to opt in)'
    );
    wsMode = false;
  } else if (!migrationWsAllowedForUrl(rpcUrl)) {
    if (
      logsSubscribeHardDisabled &&
      logsSubscribeUnsupportedUrl === rpcUrl
    ) {
      // one-shot log already emitted
      wsMode = false;
    } else {
      console.warn(
        `[migration] WebSocket program logs DISABLED (poll-only) host=${rpcHostOf(rpcUrl)} — ` +
          'public/soft-throttle RPC or logsSubscribe unsupported. Paid WS-capable RPC required for real-time.'
      );
      wsMode = false;
    }
  } else {
    const subscribed = subscribeWebSocket();
    if (!subscribed) {
      // Do NOT scheduleReconnect on hard-disable / method-not-found.
      if (!logsSubscribeHardDisabled) {
        console.warn(
          '[migration] WebSocket subscribe failed — poll-only (no auto-reconnect storm)'
        );
      }
    }
  }

  void pollMigrations();
  migrationTimer = setInterval(() => {
    void pollMigrations();
  }, POLL_MS);

  healthTimer = setInterval(() => {
    checkSubscriptionHealth();
  }, HEALTH_CHECK_MS);
}

export function stopMigrationListener(): void {
  running = false;
  wsMode = false;

  if (migrationTimer) {
    clearInterval(migrationTimer);
    migrationTimer = null;
  }
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  unsubscribeAll();
  console.log('[migration] Listener stopped');
}

/**
 * Tear down WS/timers when migration OFF or all feature workloads OFF;
 * restart when migration ON again and boot previously requested it.
 */
export function syncMigrationWorkloadGate(): void {
  let migrationOn = true;
  let featuresOff = false;
  try {
    const {
      isRpcWorkloadEnabled,
      allFeatureWorkloadsOff,
    } = require('./rpcWorkloadControl') as typeof import('./rpcWorkloadControl');
    migrationOn = isRpcWorkloadEnabled('migration');
    featuresOff = allFeatureWorkloadsOff();
  } catch {
    return;
  }
  if (!migrationOn || featuresOff) {
    if (running) {
      console.warn(
        '[migration] quiescing — ' +
          (!migrationOn ? 'migration workload OFF' : 'idle isolation')
      );
      stopMigrationListener();
      // Keep resume intent after quiesce from isolation / toggle.
      bootRequested = true;
      try {
        const { markMigrationResumeWanted } =
          require('./connection') as typeof import('./connection');
        markMigrationResumeWanted(true);
      } catch {
        /* */
      }
    } else {
      // Even if not "running", drop any stray WS/reconnect.
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      unsubscribeAll();
      wsMode = false;
    }
    return;
  }
  if (bootRequested && !running) {
    console.log('[migration] resuming after workload/isolation gate');
    startMigrationListener();
  }
}

export function isMigrationListenerRunning(): boolean {
  return running;
}

export function isRecentlyMigrated(mint: string): boolean {
  const event = recentMigrations.get(mint);
  if (!event) return false;
  if (Date.now() - event.detectedAt > MIGRATION_TTL_MS) {
    recentMigrations.delete(mint);
    return false;
  }
  return true;
}

export function getMigrationEvent(mint: string): MigrationEvent | undefined {
  return recentMigrations.get(mint);
}

export function getRecentMigrations(limit = 20): MigrationEvent[] {
  pruneExpired();
  return Array.from(recentMigrations.values())
    .sort((a, b) => b.detectedAt - a.detectedAt)
    .slice(0, limit);
}

export function getMigrationStatus() {
  pruneExpired();
  return {
    running,
    wsMode,
    logsSubscribeHardDisabled,
    logsSubscribeUnsupportedHost: logsSubscribeUnsupportedUrl
      ? rpcHostOf(logsSubscribeUnsupportedUrl)
      : null,
    migrationWsEnvEnabled: isMigrationWsEnvEnabled(),
    recentCount: recentMigrations.size,
    lastSignature: lastMigrationSig,
    lastWsEventAt: lastWsEventAt || null,
    reconnectAttempts,
    subscribedRpcUrl: subscribedRpcUrl
      ? subscribedRpcUrl.replace(/\/\/.*@/, '//***@').slice(0, 64)
      : null,
    priorityEnabled: config.strategy.enableMigrationPriority,
    volumeSpikeSol:
      config.strategy.migrationVolumeSpikeSol ?? DEFAULT_VOLUME_SPIKE_SOL,
  };
}

function unsubscribeAll(): void {
  const conn = migrationWsConn;
  for (const id of subIds) {
    try {
      conn?.removeOnLogsListener(id).catch(() => undefined);
    } catch {
      // ignore
    }
  }
  subIds.length = 0;
  migrationWsConn = null;
  wsMode = false;
  destroyMigrationWsConn(conn);
}

function subscribeWebSocket(): boolean {
  try {
    try {
      const {
        isRpcWorkloadEnabled,
        allFeatureWorkloadsOff,
      } = require('./rpcWorkloadControl') as typeof import('./rpcWorkloadControl');
      if (!isRpcWorkloadEnabled('migration') || allFeatureWorkloadsOff()) {
        return false;
      }
    } catch {
      /* */
    }
    if (!isMigrationWsEnvEnabled()) return false;

    const httpUrl = getRpcUrl();
    if (
      logsSubscribeUnsupportedUrl &&
      logsSubscribeUnsupportedUrl !== httpUrl
    ) {
      // New HTTP endpoint after failover — allow one fresh attempt.
      logsSubscribeHardDisabled = false;
      logsSubscribeUnsupportedLogged = false;
      logsSubscribeUnsupportedUrl = null;
    }
    if (!migrationWsAllowedForUrl(httpUrl)) {
      wsMode = false;
      return false;
    }

    unsubscribeAll();

    // Dedicated WS connection (HTTP URL; web3 maps to wss). Isolates retry storms.
    migrationWsConn = new Connection(httpUrl, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true,
      confirmTransactionInitialTimeout: 60_000,
    });
    wrapWsCallForMethodNotFound(migrationWsConn, httpUrl);
    subscribedRpcUrl = httpUrl;
    lastSubscribeAt = Date.now();
    try {
      const { noteIdleRpcCall } =
        require('./rpcIdleTrace') as typeof import('./rpcIdleTrace');
      const { allFeatureWorkloadsOff } =
        require('./rpcWorkloadControl') as typeof import('./rpcWorkloadControl');
      noteIdleRpcCall({
        label: 'migration_ws_subscribe',
        endpoint: getActiveEndpointLabel('primary'),
        method: 'onLogs',
        featuresOff: allFeatureWorkloadsOff(),
      });
    } catch {
      /* */
    }

    const programs: { id: string; label: MigrationEvent['program'] }[] = [
      { id: config.pumpFunProgramId, label: 'pumpfun' },
      { id: config.pumpSwapProgramId, label: 'pumpswap' },
      { id: RAYDIUM_AMM_V4, label: 'raydium' },
    ];

    for (const { id, label } of programs) {
      if (logsSubscribeHardDisabled) break;
      const subId = migrationWsConn.onLogs(
        new PublicKey(id),
        (logs: Logs, ctx: Context) => {
          lastWsEventAt = Date.now();
          void handleLogsNotification(logs, ctx, label);
        },
        'confirmed'
      );
      subIds.push(subId);
      console.log(`[migration] WS subscribed → ${label} (sub #${subId})`);
    }

    if (logsSubscribeHardDisabled) {
      unsubscribeAll();
      return false;
    }

    wsMode = true;
    reconnectAttempts = 0;
    lastWsEventAt = Date.now();
    console.log(
      `[migration] ✅ WebSocket subscriptions active (${programs.length} programs) host=${rpcHostOf(httpUrl)}`
    );
    return true;
  } catch (err) {
    if (isLogsSubscribeMethodNotFound(err)) {
      try {
        disableLogsSubscribeUnsupported(
          getRpcUrl(),
          err instanceof Error ? err.message : String(err)
        );
      } catch {
        /* */
      }
      return false;
    }
    console.error('[migration] WebSocket subscription error:', err);
    wsMode = false;
    unsubscribeAll();
    return false;
  }
}

function scheduleReconnect(reason: string): void {
  if (!running) return;
  if (logsSubscribeHardDisabled) return;
  try {
    const {
      isRpcWorkloadEnabled,
      allFeatureWorkloadsOff,
    } = require('./rpcWorkloadControl') as typeof import('./rpcWorkloadControl');
    if (!isRpcWorkloadEnabled('migration') || allFeatureWorkloadsOff()) return;
  } catch {
    /* */
  }
  if (reconnectTimer) return;
  if (!isMigrationWsEnvEnabled()) {
    wsMode = false;
    return;
  }
  try {
    const url = getRpcUrl();
    if (!migrationWsAllowedForUrl(url)) {
      wsMode = false;
      return;
    }
  } catch {
    return;
  }

  // Cap attempts — never infinite reconnect storms.
  if (reconnectAttempts >= 5) {
    console.warn(
      `[migration] WS reconnect cap reached (${reconnectAttempts}) — staying poll-only (${reason})`
    );
    wsMode = false;
    return;
  }

  const delay = Math.min(
    MAX_RECONNECT_DELAY_MS,
    5_000 * Math.pow(2, reconnectAttempts)
  );
  reconnectAttempts += 1;

  console.warn(
    `[migration] Reconnect scheduled in ${Math.round(delay / 1000)}s ` +
      `(attempt ${reconnectAttempts}) — ${reason}`
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!running || logsSubscribeHardDisabled) return;
    console.log('[migration] Reconnecting WebSocket subscriptions…');
    const ok = subscribeWebSocket();
    if (!ok && !logsSubscribeHardDisabled) {
      scheduleReconnect('resubscribe failed');
    }
  }, delay);
}

function checkSubscriptionHealth(): void {
  if (!running) return;
  try {
    const {
      isRpcWorkloadEnabled,
      allFeatureWorkloadsOff,
    } = require('./rpcWorkloadControl') as typeof import('./rpcWorkloadControl');
    if (!isRpcWorkloadEnabled('migration') || allFeatureWorkloadsOff()) return;
  } catch {
    /* */
  }

  if (!isMigrationWsEnvEnabled() || logsSubscribeHardDisabled) {
    wsMode = false;
    return;
  }

  let current = '';
  try {
    current = getRpcUrl();
  } catch {
    return;
  }

  if (!migrationWsAllowedForUrl(current)) {
    wsMode = false;
    return;
  }

  // Active RPC may have failed over — allow WS on the new endpoint once.
  if (
    logsSubscribeUnsupportedUrl &&
    current !== logsSubscribeUnsupportedUrl
  ) {
    logsSubscribeHardDisabled = false;
    logsSubscribeUnsupportedLogged = false;
    logsSubscribeUnsupportedUrl = null;
  }

  if (wsMode && subscribedRpcUrl && current !== subscribedRpcUrl) {
    console.warn(
      '[migration] RPC endpoint changed — resubscribing WebSocket once'
    );
    scheduleReconnect('RPC failover');
    return;
  }

  // If WS never came up, do NOT spin reconnect every health tick.
  if (!wsMode) {
    return;
  }

  const idleFor = Date.now() - (lastWsEventAt || lastSubscribeAt);
  if (idleFor > WS_STALE_MS) {
    console.warn(
      `[migration] WebSocket stale (${Math.round(idleFor / 1000)}s idle) — reconnecting`
    );
    scheduleReconnect('stale subscription');
  }
}

async function handleLogsNotification(
  logs: Logs,
  _ctx: Context,
  program: MigrationEvent['program']
): Promise<void> {
  if (!running) return;
  if (logs.err) return;
  // Free-tier 429 cooldown — skip WS parses so we don't burn the failover RPC too
  if (Date.now() < rateLimitedUntil) return;
  if (shouldDeferHeavyRpc()) return;
  if (migrationParseInFlight >= MAX_WS_PARSE_IN_FLIGHT) return;

  const signature = logs.signature;
  if (!signature || processedSigs.has(signature)) return;

  const logText = (logs.logs ?? []).join('\n').toLowerCase();
  if (!looksLikeMigrationLogs(logText, program)) return;

  migrationParseInFlight += 1;
  try {
    const role = getRpcRoleFor('migration', Boolean(config.rpc?.shareLoad));
    await runWithRpcRole(
      role,
      () => processMigrationTx(signature, 'websocket', program),
      'migration'
    );
  } finally {
    migrationParseInFlight -= 1;
  }
}

function looksLikeMigrationLogs(
  logText: string,
  program: MigrationEvent['program']
): boolean {
  // Pump.fun graduation / migrate instruction keywords
  const migrateHints =
    logText.includes('migrat') ||
    logText.includes('migrate') ||
    logText.includes('graduation') ||
    logText.includes('complete') ||
    logText.includes('withdraw') ||
    logText.includes('create_pool') ||
    logText.includes('initialize2') ||
    logText.includes('initialize');

  if (program === 'pumpfun') {
    return (
      logText.includes('migrat') ||
      logText.includes('migrate') ||
      logText.includes('complete') ||
      logText.includes('withdraw')
    );
  }

  if (program === 'pumpswap') {
    // Do NOT match bare "buy"/"create"/"deposit" — that fires on every swap and
    // burns free Helius/Alchemy CU with getParsedTransaction storms.
    return (
      logText.includes('migrat') ||
      logText.includes('graduation') ||
      logText.includes('create_pool') ||
      logText.includes('initialize2') ||
      (logText.includes('initialize') && logText.includes('pool')) ||
      (logText.includes('create') && logText.includes('pool'))
    );
  }

  // Raydium — only clear pool-init / migrate (ray_log alone is every swap)
  return (
    logText.includes('migrat') ||
    logText.includes('init_pc_amount') ||
    logText.includes('initialize2') ||
    (logText.includes('initialize') &&
      (logText.includes('pool') || logText.includes('amm')))
  );
}

async function pollMigrations(): Promise<void> {
  if (!running) return;
  if (Date.now() < rateLimitedUntil) return;
  try {
    const {
      isRpcWorkloadEnabled,
      allFeatureWorkloadsOff,
    } = require('./rpcWorkloadControl') as typeof import('./rpcWorkloadControl');
    if (!isRpcWorkloadEnabled('migration') || allFeatureWorkloadsOff()) {
      // Tear down residual WS while poll is gated OFF.
      if (wsMode || subIds.length) {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        unsubscribeAll();
        wsMode = false;
      }
      return;
    }
  } catch {
    /* */
  }
  let gateStressed = false;
  try {
    gateStressed = Boolean(getRpcGateSnapshot().stressed);
  } catch {
    gateStressed = false;
  }
  const primaryMs = (() => {
    try {
      const stats = getRpcStats();
      const active =
        stats.endpoints.find((e) => e.lane === 'primary' && e.isActive) ||
        stats.endpoints.find((e) => e.isActive);
      return active?.latencyMs ?? null;
    } catch {
      return null;
    }
  })();
  const primaryWarm = primaryMs != null && primaryMs >= 200;
  const primaryHot = primaryMs != null && primaryMs >= 500;
  const minGap =
    gateStressed || primaryHot
      ? POLL_MS_STRESSED
      : primaryWarm
        ? POLL_MS_WARM
        : POLL_MS;
  if (lastMigrationPollAt && Date.now() - lastMigrationPollAt < minGap) return;
  lastMigrationPollAt = Date.now();

  const role = getRpcRoleFor('migration', Boolean(config.rpc?.shareLoad));
  return runWithRpcRole(role, async () => {
  try {
    const conn = getConnection();
    const softRpc = isSoftThrottleRpcUrl(conn.rpcEndpoint);
    // Poll both PumpSwap (post-migrate venue) and Pump.fun (migrate ix)
    const targets = [
      { id: config.pumpSwapProgramId, label: 'pumpswap' as const },
      { id: config.pumpFunProgramId, label: 'pumpfun' as const },
    ];

    for (const target of targets) {
      if (Date.now() < rateLimitedUntil) break;
      const signatures = await conn.getSignaturesForAddress(
        new PublicKey(target.id),
        { limit: softRpc ? 8 : 15 }
      );
      if (signatures.length === 0) continue;

      // First sight: seed cursor only — never replay historical program txs
      // as migrations (same pattern as wallet poll in v1.1.26).
      if (!seededPollPrograms.has(target.id)) {
        for (const sig of signatures) {
          rememberSig(sig.signature);
        }
        seededPollPrograms.add(target.id);
        lastMigrationSig = signatures[0].signature;
        console.log(
          `[migration] Seeded poll cursor for ${target.label} ` +
            `(${signatures.length} sigs) — watching for new migrations only`
        );
        continue;
      }

      const newSigs: string[] = [];
      for (const sig of signatures) {
        if (processedSigs.has(sig.signature)) continue;
        newSigs.push(sig.signature);
      }

      if (newSigs.length === 0) continue;

      // Newest first for latency; tighter cap on free/public RPCs to avoid 429 storms
      const parseCap = softRpc ? 2 : 5;
      for (const sig of newSigs.slice(0, parseCap)) {
        if (Date.now() < rateLimitedUntil) break;
        const ok = await processMigrationTx(sig, 'poll', target.label);
        if (!ok && Date.now() < rateLimitedUntil) break;
      }
    }

    pruneExpired();
  } catch (err) {
    if (isRpcRateLimitError(err)) {
      armRateLimitBackoff(err);
      return;
    }
    if (isRpcTimeoutOrFetchError(err)) {
      noteMigrationTimeout(err);
      return;
    }
    console.error('[migration] Poll error:', err);
  }
  }, 'migration');
}

/** @returns false when rate-limited (caller should abort this poll cycle) */
async function processMigrationTx(
  signature: string,
  source: MigrationEvent['source'],
  programHint: MigrationEvent['program']
): Promise<boolean> {
  if (processedSigs.has(signature)) return true;

  try {
    const conn = getConnection();
    const tx = await conn.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx?.meta || tx.meta.err) {
      // Confirmed miss / failed tx — don't retry forever
      rememberSig(signature);
      return true;
    }

    const logText = (tx.meta.logMessages ?? []).join('\n').toLowerCase();
    // Cheap reject before mint extraction — pump.fun program is extremely busy
    if (
      programHint === 'pumpfun' &&
      !looksLikeMigrationLogs(logText, 'pumpfun') &&
      !logText.includes('pumpswap') &&
      !accountKeysInclude(tx, config.pumpSwapProgramId) &&
      !accountKeysInclude(tx, RAYDIUM_AMM_V4)
    ) {
      rememberSig(signature);
      return true;
    }

    const parsed = parseMigrationTransaction(tx, signature, source, programHint);
    rememberSig(signature);
    for (const event of parsed) {
      await recordAndEmit(event);
    }
    return true;
  } catch (err) {
    if (isRpcRateLimitError(err)) {
      armRateLimitBackoff(err);
      return false;
    }
    if (isRpcTimeoutOrFetchError(err)) {
      noteMigrationTimeout(err);
      return true;
    }
    // Leave sig unmarked so a transient RPC miss can retry next poll
    if (Math.random() < 0.08) {
      console.warn('[migration] Tx parse failed:', err);
    }
    return true;
  }
}

function accountKeysInclude(
  tx: ParsedTransactionWithMeta,
  programId: string
): boolean {
  return tx.transaction.message.accountKeys.some((k) => {
    const key = typeof k === 'string' ? k : k.pubkey.toBase58();
    return key === programId;
  });
}

function estimateVolumeSol(tx: ParsedTransactionWithMeta): number {
  const pre = tx.meta?.preBalances ?? [];
  const post = tx.meta?.postBalances ?? [];
  let maxDelta = 0;
  const n = Math.min(pre.length, post.length);
  for (let i = 0; i < n; i++) {
    const delta = Math.abs(post[i] - pre[i]);
    if (delta > maxDelta) maxDelta = delta;
  }
  return maxDelta / 1e9;
}

function extractPoolAddress(
  accountKeys: string[],
  mint: string,
  tx: ParsedTransactionWithMeta
): string | null {
  const postBalances = tx.meta?.postTokenBalances ?? [];

  // Prefer token-balance owner that isn't a tracked wallet and holds the mint
  const tracked = new Set(
    config.smartWallets.filter((w) => w.enabled).map((w) => w.address)
  );

  for (const bal of postBalances) {
    if (bal.mint !== mint || !bal.owner) continue;
    if (tracked.has(bal.owner)) continue;
    if (SKIP_ACCOUNTS.has(bal.owner)) continue;
    if (bal.owner === mint) continue;
    // Pool / vault owners often appear with large amounts
    const ui = bal.uiTokenAmount?.uiAmount ?? 0;
    if (ui > 0) {
      return bal.owner;
    }
  }

  // Fallback: first writable-looking non-system account that isn't the mint
  for (const key of accountKeys) {
    if (SKIP_ACCOUNTS.has(key)) continue;
    if (key === mint) continue;
    if (key === config.pumpFunProgramId) continue;
    if (key === config.pumpSwapProgramId) continue;
    if (key === RAYDIUM_AMM_V4) continue;
    if (key === config.solMint) continue;
    if (isDeniedCopyMint(key, config.solMint)) continue;
    if (tracked.has(key)) continue;
    // Likely pool/state account (base58 length typical of pubkeys)
    if (key.length >= 32 && key.length <= 44) {
      return key;
    }
  }

  return null;
}

function parseMigrationTransaction(
  tx: ParsedTransactionWithMeta,
  signature: string,
  source: MigrationEvent['source'],
  programHint: MigrationEvent['program']
): MigrationEvent[] {
  const accountKeys = tx.transaction.message.accountKeys.map((k) =>
    typeof k === 'string' ? k : k.pubkey.toBase58()
  );

  const involvesPumpFun = accountKeys.includes(config.pumpFunProgramId);
  const involvesPumpSwap = accountKeys.includes(config.pumpSwapProgramId);
  const involvesRaydium = accountKeys.includes(RAYDIUM_AMM_V4);

  const postBalances = tx.meta?.postTokenBalances ?? [];
  const mints = [
    ...new Set(
      postBalances
        .map((b) => b.mint)
        .filter((m) => m && !isDeniedCopyMint(m, config.solMint))
    ),
  ];

  if (mints.length === 0) return [];

  const volumeSol = estimateVolumeSol(tx);
  const spikeThreshold =
    config.strategy.migrationVolumeSpikeSol ?? DEFAULT_VOLUME_SPIKE_SOL;
  const volumeSpike = volumeSol >= spikeThreshold;

  const logText = (tx.meta?.logMessages ?? []).join('\n').toLowerCase();
  const migrateLog =
    logText.includes('migrat') ||
    logText.includes('graduation') ||
    logText.includes('complete') ||
    logText.includes('withdraw') ||
    logText.includes('create_pool') ||
    logText.includes('initialize2');

  // Migration gate: require migrate evidence — Pump.fun alone is NOT enough
  // (program is flooded with curve buys that must not be tracked as migrations).
  const isLikelyMigrate =
    (involvesPumpFun && migrateLog) ||
    (involvesPumpFun && involvesPumpSwap) ||
    (involvesPumpSwap && involvesRaydium) ||
    (involvesPumpFun && involvesRaydium) ||
    (involvesPumpSwap && volumeSpike && mints.length <= 2 && migrateLog);

  if (!isLikelyMigrate) {
    return [];
  }

  // Avoid noisy multi-mint swap txs unless Pump.fun is clearly involved
  if (!involvesPumpFun && mints.length > 3) return [];

  const tracked = config.smartWallets.filter((w) => w.enabled);
  const trackedSet = new Set(tracked.map((w) => w.address));

  const involved = accountKeys.filter((k) => trackedSet.has(k));
  for (const bal of postBalances) {
    if (bal.owner && trackedSet.has(bal.owner) && !involved.includes(bal.owner)) {
      involved.push(bal.owner);
    }
  }

  const smartWalletNames = involved.map((addr) => {
    const w = tracked.find((sw) => sw.address === addr);
    return w?.name ?? addr.slice(0, 8);
  });

  let program: MigrationEvent['program'] = programHint;
  if (involvesPumpSwap) program = 'pumpswap';
  else if (involvesRaydium) program = 'raydium';
  else if (involvesPumpFun) program = 'pumpfun';

  const hasSmart = involved.length > 0;
  const priorityEnabled = config.strategy.enableMigrationPriority;
  // Volume-spike-only priority requires a clearer migrate venue (Pump.fun in tx)
  const spikePriority = volumeSpike && (involvesPumpFun || hasSmart);
  const priority = priorityEnabled && (hasSmart || spikePriority);

  let priorityReason: string | undefined;
  if (priority) {
    if (hasSmart && volumeSpike) {
      priorityReason = 'smart-wallet + volume-spike';
    } else if (hasSmart) {
      priorityReason = 'smart-wallet';
    } else {
      priorityReason = 'volume-spike';
    }
  }

  const timestamp = (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000;
  const candidateMints = mints.slice(0, 2);

  return candidateMints.map((mint) => ({
    mint,
    poolAddress: extractPoolAddress(accountKeys, mint, tx),
    signature,
    timestamp,
    detectedAt: Date.now(),
    source,
    program,
    smartWalletsInvolved: involved,
    smartWalletNames,
    volumeSol: Math.round(volumeSol * 1000) / 1000,
    volumeSpike,
    priority,
    priorityReason,
  }));
}

async function recordAndEmit(event: MigrationEvent): Promise<void> {
  const existing = recentMigrations.get(event.mint);

  if (existing) {
    const upgraded =
      (event.smartWalletsInvolved.length > 0 &&
        existing.smartWalletsInvolved.length === 0) ||
      (event.volumeSpike && !existing.volumeSpike) ||
      (event.priority && !existing.priority);

    if (upgraded) {
      recentMigrations.set(event.mint, {
        ...existing,
        ...event,
        smartWalletsInvolved: [
          ...new Set([
            ...existing.smartWalletsInvolved,
            ...event.smartWalletsInvolved,
          ]),
        ],
        smartWalletNames: [
          ...new Set([
            ...existing.smartWalletNames,
            ...event.smartWalletNames,
          ]),
        ],
        poolAddress: event.poolAddress ?? existing.poolAddress,
      });
      logMigration(recentMigrations.get(event.mint)!, true);
      await emitHandlers(recentMigrations.get(event.mint)!);
    }
    return;
  }

  recentMigrations.set(event.mint, event);
  lastMigrationSig = event.signature;
  logMigration(event, false);
  await emitHandlers(event);
}

async function emitHandlers(event: MigrationEvent): Promise<void> {
  try {
    await onMigrationHandler?.(event);
  } catch (err) {
    console.error('[migration] onMigration handler error:', err);
  }

  if (event.priority) {
    console.log(
      `[migration] ⚡ PRIORITY (${event.priorityReason}) — ` +
        `mint=${event.mint.slice(0, 8)}… ` +
        (event.smartWalletNames.length
          ? `wallets=${event.smartWalletNames.join(', ')} `
          : '') +
        `vol=${event.volumeSol} SOL`
    );
    try {
      await onPriorityHandler?.(event);
    } catch (err) {
      console.error('[migration] Priority handler error:', err);
    }
  }
}

function logMigration(event: MigrationEvent, upgraded: boolean): void {
  const tag = event.priority ? '🚀⚡' : '🚀';
  const time = new Date(event.timestamp || event.detectedAt).toISOString();
  const pool = event.poolAddress
    ? `pool=${event.poolAddress.slice(0, 8)}…`
    : 'pool=?';
  const wallets =
    event.smartWalletNames.length > 0
      ? `smart=${event.smartWalletNames.join(',')}`
      : 'smart=none';
  const upgradeNote = upgraded ? ' [upgraded→priority]' : '';

  console.log(
    `[migration] ${tag} MIGRATION detected` +
      `\n           mint=${event.mint}` +
      `\n           ${pool}` +
      `\n           time=${time}` +
      `\n           program=${event.program} via=${event.source} vol=${event.volumeSol}SOL` +
      `\n           ${wallets} spike=${event.volumeSpike}` +
      `\n           sig=${event.signature}${upgradeNote}`
  );
}

function rememberSig(signature: string): void {
  processedSigs.add(signature);
  if (processedSigs.size > MAX_PROCESSED_SIGS) {
    const first = processedSigs.values().next().value;
    if (first) processedSigs.delete(first);
  }
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [mint, event] of recentMigrations.entries()) {
    if (now - event.detectedAt > MIGRATION_TTL_MS) {
      recentMigrations.delete(mint);
    }
  }
}

/** Manually register a mint as migrated (from wallet buy detection) */
export function markAsMigrated(
  mint: string,
  signature?: string,
  smartWallets?: { address: string; name: string }[],
  poolAddress?: string | null
): void {
  if (recentMigrations.has(mint)) {
    const existing = recentMigrations.get(mint)!;
    if (
      smartWallets &&
      smartWallets.length > 0 &&
      existing.smartWalletsInvolved.length === 0
    ) {
      existing.smartWalletsInvolved = smartWallets.map((w) => w.address);
      existing.smartWalletNames = smartWallets.map((w) => w.name);
      existing.priority =
        config.strategy.enableMigrationPriority && smartWallets.length > 0;
      existing.priorityReason = existing.priority
        ? 'smart-wallet'
        : existing.priorityReason;
      if (poolAddress) existing.poolAddress = poolAddress;
    }
    return;
  }

  const involved = smartWallets ?? [];
  recentMigrations.set(mint, {
    mint,
    poolAddress: poolAddress ?? null,
    signature: signature ?? 'manual',
    timestamp: Date.now(),
    detectedAt: Date.now(),
    source: 'manual',
    program: 'unknown',
    smartWalletsInvolved: involved.map((w) => w.address),
    smartWalletNames: involved.map((w) => w.name),
    volumeSol: 0,
    volumeSpike: false,
    priority:
      config.strategy.enableMigrationPriority && involved.length > 0,
    priorityReason:
      involved.length > 0 && config.strategy.enableMigrationPriority
        ? 'smart-wallet'
        : undefined,
  });
}
