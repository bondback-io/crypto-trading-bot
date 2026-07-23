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
import { getConnection, getRpcUrl } from './connection';
import { isPublicRpcUrl } from './rpcUrl';

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

const subIds: number[] = [];

let onMigrationHandler: MigrationHandler | null = null;
let onPriorityHandler: MigrationHandler | null = null;

const MIGRATION_TTL_MS = 30 * 60 * 1000;
const POLL_MS = 12_000;
const MAX_PROCESSED_SIGS = 800;
const WS_STALE_MS = 4 * 60 * 1000;
const HEALTH_CHECK_MS = 45_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

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

export function startMigrationListener(): void {
  if (running) return;
  running = true;
  reconnectAttempts = 0;

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

  // Public RPCs cannot handle program-wide onLogs (flood → OOM / crash loop on Render).
  const rpcUrl = getRpcUrl();
  if (isPublicRpcUrl(rpcUrl)) {
    console.warn(
      '[migration] Public RPC detected — WebSocket program logs DISABLED (poll-only). ' +
        'Set a paid Helius/QuickNode RPC_URL for real-time migration WS.'
    );
    wsMode = false;
  } else {
    const subscribed = subscribeWebSocket();
    if (!subscribed) {
      console.warn(
        '[migration] WebSocket subscribe failed — poll-only until reconnect'
      );
      scheduleReconnect('initial subscribe failed');
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
  let conn: Connection | null = null;
  try {
    conn = getConnection();
  } catch {
    // ignore
  }

  for (const id of subIds) {
    try {
      conn?.removeOnLogsListener(id).catch(() => undefined);
    } catch {
      // ignore
    }
  }
  subIds.length = 0;
}

function subscribeWebSocket(): boolean {
  try {
    unsubscribeAll();
    const conn = getConnection();
    subscribedRpcUrl = conn.rpcEndpoint;
    lastSubscribeAt = Date.now();

    const programs: { id: string; label: MigrationEvent['program'] }[] = [
      { id: config.pumpFunProgramId, label: 'pumpfun' },
      { id: config.pumpSwapProgramId, label: 'pumpswap' },
      { id: RAYDIUM_AMM_V4, label: 'raydium' },
    ];

    for (const { id, label } of programs) {
      const subId = conn.onLogs(
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

    wsMode = true;
    reconnectAttempts = 0;
    // Treat subscribe as a heartbeat so we don't immediately stale-reconnect
    lastWsEventAt = Date.now();
    console.log(
      `[migration] ✅ WebSocket subscriptions active (${programs.length} programs)`
    );
    return true;
  } catch (err) {
    console.error('[migration] WebSocket subscription error:', err);
    wsMode = false;
    return false;
  }
}

function scheduleReconnect(reason: string): void {
  if (!running) return;
  if (reconnectTimer) return;
  // Never reconnect WS against public RPC — it crash-loops the host.
  try {
    if (isPublicRpcUrl(getRpcUrl())) {
      wsMode = false;
      return;
    }
  } catch {
    return;
  }

  const delay = Math.min(
    MAX_RECONNECT_DELAY_MS,
    1_000 * Math.pow(2, reconnectAttempts)
  );
  reconnectAttempts += 1;

  console.warn(
    `[migration] Reconnect scheduled in ${Math.round(delay / 1000)}s ` +
      `(attempt ${reconnectAttempts}) — ${reason}`
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!running) return;
    console.log('[migration] Reconnecting WebSocket subscriptions…');
    const ok = subscribeWebSocket();
    if (!ok) {
      scheduleReconnect('resubscribe failed');
    }
  }, delay);
}

function checkSubscriptionHealth(): void {
  if (!running) return;

  // Stay poll-only on public RPCs — never try to (re)open program log websockets.
  try {
    if (isPublicRpcUrl(getRpcUrl())) {
      wsMode = false;
      return;
    }
  } catch {
    return;
  }

  // Active RPC may have failed over — resubscribe on new endpoint
  try {
    const current = getConnection().rpcEndpoint;
    if (wsMode && subscribedRpcUrl && current !== subscribedRpcUrl) {
      console.warn(
        '[migration] RPC endpoint changed — resubscribing WebSocket'
      );
      scheduleReconnect('RPC failover');
      return;
    }
  } catch {
    scheduleReconnect('connection unavailable');
    return;
  }

  if (!wsMode) {
    scheduleReconnect('websocket not active');
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

  const signature = logs.signature;
  if (!signature || processedSigs.has(signature)) return;

  const logText = (logs.logs ?? []).join('\n').toLowerCase();
  if (!looksLikeMigrationLogs(logText, program)) return;

  await processMigrationTx(signature, 'websocket', program);
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
    // PumpSwap sees pool creates + early swaps after migrate
    return (
      migrateHints ||
      logText.includes('create') ||
      logText.includes('buy') ||
      logText.includes('deposit')
    );
  }

  // Raydium — only pool init style logs (high volume otherwise)
  return (
    logText.includes('initialize') ||
    logText.includes('init_pc_amount') ||
    logText.includes('migrat') ||
    logText.includes('ray_log')
  );
}

async function pollMigrations(): Promise<void> {
  if (!running) return;

  try {
    const conn = getConnection();
    // Poll both PumpSwap (post-migrate venue) and Pump.fun (migrate ix)
    const targets = [
      { id: config.pumpSwapProgramId, label: 'pumpswap' as const },
      { id: config.pumpFunProgramId, label: 'pumpfun' as const },
    ];

    for (const target of targets) {
      const signatures = await conn.getSignaturesForAddress(
        new PublicKey(target.id),
        { limit: 10 }
      );
      if (signatures.length === 0) continue;

      const newSigs: string[] = [];
      for (const sig of signatures) {
        if (processedSigs.has(sig.signature)) continue;
        // Cheap pre-filter for pump.fun poll — only recent
        newSigs.push(sig.signature);
      }

      if (newSigs.length === 0) continue;
      if (!lastMigrationSig) {
        lastMigrationSig = signatures[0].signature;
      }

      for (const sig of newSigs.slice(0, 3).reverse()) {
        await processMigrationTx(sig, 'poll', target.label);
      }
    }

    pruneExpired();
  } catch (err) {
    console.error('[migration] Poll error:', err);
  }
}

async function processMigrationTx(
  signature: string,
  source: MigrationEvent['source'],
  programHint: MigrationEvent['program']
): Promise<void> {
  if (processedSigs.has(signature)) return;
  rememberSig(signature);

  try {
    const conn = getConnection();
    const tx = await conn.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx?.meta || tx.meta.err) return;

    const parsed = parseMigrationTransaction(tx, signature, source, programHint);
    for (const event of parsed) {
      await recordAndEmit(event);
    }
  } catch (err) {
    if (Math.random() < 0.08) {
      console.warn('[migration] Tx parse failed:', err);
    }
  }
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
        .filter((m) => m && m !== config.solMint)
    ),
  ];

  if (mints.length === 0) return [];

  const volumeSol = estimateVolumeSol(tx);
  const spikeThreshold =
    config.strategy.migrationVolumeSpikeSol ?? DEFAULT_VOLUME_SPIKE_SOL;
  const volumeSpike = volumeSol >= spikeThreshold;

  // Migration gate: Pump.fun present, or PumpSwap+Raydium, or large PumpSwap pool create
  const isLikelyMigrate =
    involvesPumpFun ||
    (involvesPumpSwap && involvesRaydium) ||
    (involvesPumpSwap && involvesPumpFun) ||
    (involvesPumpSwap && volumeSpike && mints.length <= 2) ||
    (involvesPumpFun && involvesRaydium);

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
