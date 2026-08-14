/**
 * UI-assigned RPC pool:
 * Per lane (Trading / Data / Background): Main + optional Emergency.
 * Unassigned inventory never enters the hot pool.
 * Background Main only hot when background feature workloads ON.
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
import {
  config,
  getActiveTradingWallet,
  listTradingWalletSlots,
  resolveTradingWalletSecret,
} from './config';
import { logger, errorToMeta } from './logger';
import { isPublicRpcUrl, type RpcEndpointRef } from './rpcUrl';
import {
  getRpcLaneAssignments,
  rpcEndpointsFromAssignments,
} from './rpcInventory';
import {
  getRpcGateSnapshot,
  isRpcGateSkipError,
  runWithRpcFeatureGate,
  type RpcGateRole,
} from './rpcGate';
import { normalizeRpcRole, type NormalizedRpcRole } from './rpcRouting';
import {
  assertRpcWorkloadEnabled,
  anyBackgroundFeatureWorkloadEnabled,
  allFeatureWorkloadsOff,
  shouldIdleIsolate,
  RpcWorkloadDisabledError,
} from './rpcWorkloadControl';
import {
  noteIdleRpcCall,
  getIdleRpcTraceSnapshot,
} from './rpcIdleTrace';

dotenv.config();

export type RpcRole =
  | 'primary'
  | 'secondary'
  | 'background'
  | 'utility'
  | 'scannersB'
  | 'metrics';

export interface RpcEndpoint {
  url: string;
  label: string;
  wsUrl?: string;
  role?: NormalizedRpcRole | 'utility';
}

export interface RpcEndpointStats {
  url: string;
  label: string;
  role: NormalizedRpcRole | 'utility';
  healthy: boolean;
  latencyMs: number | null;
  /** Probe-only getSlot EWMA (preferred for Health display). */
  probeLatencyMs?: number | null;
  lastCallLatencyMs?: number | null;
  successCount: number;
  failureCount: number;
  successRate: number;
  lastError?: string;
  lastCheckedAt: number | null;
  unhealthySince: number | null;
  isActive: boolean;
  lane?: RpcRole | null;
  emergencyOnly?: boolean;
}

export type LaneCongestion = {
  state: 'ok' | 'busy' | 'congested' | 'failover' | 'down' | 'idle' | 'disabled';
  cause: string;
  details: string[];
};

interface EndpointState {
  endpoint: RpcEndpoint;
  connection: Connection;
  healthy: boolean;
  /** Mixed EWMA (probes + withRpc wall-clock — can be confirm-poisoned). */
  latencyMs: number | null;
  /** Probe-only EWMA from health getSlot (fair lane RTT). */
  probeLatencyMs: number | null;
  lastCallLatencyMs: number | null;
  successCount: number;
  failureCount: number;
  lastError?: string;
  lastCheckedAt: number | null;
  consecutiveFailures: number;
  unhealthySince: number | null;
  rateLimitedUntil: number;
  hardFailUntil: number;
  quarantineStreak: number;
  emergencyOnly: boolean;
}

type LaneId = 'trading' | 'data' | 'background' | 'emergency';

const rpcRoleAls = new AsyncLocalStorage<RpcRole>();
const rpcFeatureAls = new AsyncLocalStorage<string>();
const rpcGateDepthAls = new AsyncLocalStorage<number>();

const keypairCache = new Map<string, Keypair>();
let healthTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

let poolBuilt = false;
let hotIncludesBackground = false;
let tradingPref: EndpointState | null = null;
/** @deprecated mid-hops removed */
let tradingAlchemyFailover: EndpointState | null = null;
/** @deprecated mid-hops removed */
let tradingFailover: EndpointState | null = null;
let dataPref: EndpointState | null = null;
let dataFailover: EndpointState | null = null;
let backgroundPref: EndpointState | null = null;
/** Trading lane Emergency (assigned). Alias kept for probe/stats paths. */
let emergencyPublic: EndpointState | null = null;
let backgroundEmergency: EndpointState | null = null;
/** @deprecated — paid emergency unused */
let emergencyPaid: EndpointState | null = null;
let publics: EndpointState[] = [];
let heliusCold: RpcEndpointRef[] = [];

/** Trading: 0=Main, 1=Emergency */
let tradingHop = 0;
let dataOnFailover = false;
/** Background: 0=Main, 1=Emergency */
let backgroundIdx = 0;
let tradingHardFailStreak = 0;
let tradingRecoverAt = 0;
let lastHealthProbeAt = 0;
/** Consecutive Trading getSlot probes < 400ms (need 2 to heal ghost EWMA). */
let tradingFastProbeStreak = 0;
/** Consecutive Data getSlot probes < 400ms. */
let dataFastProbeStreak = 0;
let tradingEwmaRecovered = false;
let dataEwmaRecovered = false;
/** Hard pause of non-essential RPC when all feature workloads are OFF. */
let idleIsolationActive = false;
/** Migration was started this process and should resume when isolation ends. */
let migrationResumeWanted = false;

const TRADING_HARD_FAIL_NEED = 3;
const TRADING_RECOVER_MS = 45_000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const RATE_LIMIT_BACKOFF_BASE_MS = 15_000;
const RATE_LIMIT_BACKOFF_CAP_MS = 180_000;
const HARD_FAIL_COOLDOWN_MS = 120_000;
const LATENCY_EWMA_ALPHA = 0.25;
const WITH_RPC_MAX_ATTEMPTS_CRITICAL = 2;
const WITH_RPC_MAX_ATTEMPTS_OTHER = 1;
const HEALTH_PROBE_NORMAL_MS = 120_000;
const HEALTH_PROBE_FEATURES_OFF_MS = 300_000;
const HEALTH_TICK_CHECK_MS = 30_000;
const PER_MIN_BUCKET_CAP = 2_000;
const CALL_TRAFFIC_CAP = 256;
const RPC_STATS_CACHE_MS = 2_500;
const CONFIRM_POLL_MS = 1_500;
const CONFIRM_TIMEOUT_MS = 60_000;

/** Rolling 60s timestamps for control-plane diagnostics. */
const probeCallAts: number[] = [];
const featureCallAts: number[] = [];
const healthPageRefreshAts: number[] = [];

/** Per-endpoint 429 streak for exponential cooldown. */
const rateLimitStreakByLabel = new Map<string, number>();
let last429BackoffLogAt = 0;

function notePerMin(bucket: number[]): void {
  const now = Date.now();
  bucket.push(now);
  while (bucket.length && bucket[0]! < now - 60_000) bucket.shift();
  while (bucket.length > PER_MIN_BUCKET_CAP) bucket.shift();
}

function perMin(bucket: number[]): number {
  const now = Date.now();
  while (bucket.length && bucket[0]! < now - 60_000) bucket.shift();
  return bucket.length;
}

function wantBackgroundHot(): boolean {
  try {
    return anyBackgroundFeatureWorkloadEnabled();
  } catch {
    return true;
  }
}

function featuresOffNow(): boolean {
  try {
    return shouldIdleIsolate() || allFeatureWorkloadsOff();
  } catch {
    return false;
  }
}

export function isRpcIdleIsolationActive(): boolean {
  return idleIsolationActive;
}

export function markMigrationResumeWanted(wanted = true): void {
  migrationResumeWanted = wanted;
}

/** Pause probes + tear down migration WS when all feature workloads are OFF. */
export function enterRpcIdleIsolation(reason = 'all feature workloads OFF'): void {
  if (idleIsolationActive) {
    try {
      const { syncMigrationWorkloadGate } =
        require('./migrationListener') as typeof import('./migrationListener');
      syncMigrationWorkloadGate();
    } catch {
      /* */
    }
    try {
      const { stopMarketScanner } =
        require('./marketScanner') as typeof import('./marketScanner');
      stopMarketScanner();
    } catch {
      /* */
    }
    try {
      const { stopZionKolScanner } =
        require('./zionKolScanner') as typeof import('./zionKolScanner');
      stopZionKolScanner();
    } catch {
      /* */
    }
    try {
      const { stopFastPoll } =
        require('./migrationGradWatch') as typeof import('./migrationGradWatch');
      stopFastPoll();
    } catch {
      /* */
    }
    return;
  }
  idleIsolationActive = true;
  rpcStatsCache = null;
  console.warn(`[rpc] IDLE ISOLATION ON — ${reason}`);
  try {
    const { syncMigrationWorkloadGate } =
      require('./migrationListener') as typeof import('./migrationListener');
    syncMigrationWorkloadGate();
  } catch {
    /* */
  }
  try {
    const { stopMarketScanner } =
      require('./marketScanner') as typeof import('./marketScanner');
    stopMarketScanner();
  } catch {
    /* */
  }
  try {
    const { stopZionKolScanner } =
      require('./zionKolScanner') as typeof import('./zionKolScanner');
    stopZionKolScanner();
  } catch {
    /* */
  }
  try {
    const { stopFastPoll } =
      require('./migrationGradWatch') as typeof import('./migrationGradWatch');
    stopFastPoll();
  } catch {
    /* */
  }
  try {
    const { sweepBoundedCaches } =
      require('./cacheSweep') as typeof import('./cacheSweep');
    sweepBoundedCaches();
  } catch {
    /* */
  }
}

/** Resume probes; restart migration only if workload ON and previously wanted. */
export function exitRpcIdleIsolation(): void {
  if (!idleIsolationActive) {
    try {
      const { syncMigrationWorkloadGate } =
        require('./migrationListener') as typeof import('./migrationListener');
      syncMigrationWorkloadGate();
    } catch {
      /* */
    }
    return;
  }
  idleIsolationActive = false;
  lastHealthProbeAt = 0;
  console.log('[rpc] IDLE ISOLATION OFF — resuming control-plane');
  startRpcHealthMonitor();
  try {
    const { syncMigrationWorkloadGate } =
      require('./migrationListener') as typeof import('./migrationListener');
    syncMigrationWorkloadGate();
  } catch {
    /* */
  }
  try {
    const {
      isRpcWorkloadEnabled,
    } = require('./rpcWorkloadControl') as typeof import('./rpcWorkloadControl');
    if (isRpcWorkloadEnabled('market_scanner')) {
      const { config } = require('./config') as typeof import('./config');
      if (config.marketScanner?.enabled !== false) {
        const { startMarketScanner } =
          require('./marketScanner') as typeof import('./marketScanner');
        startMarketScanner();
      }
    }
    if (isRpcWorkloadEnabled('zion_scanner')) {
      const { syncZionKolScannerLifecycle } =
        require('./zionKolScanner') as typeof import('./zionKolScanner');
      syncZionKolScannerLifecycle();
    }
  } catch {
    /* */
  }
}

/** Call after workload toggles / settings apply. */
export function syncRpcIdleIsolation(): void {
  if (featuresOffNow()) enterRpcIdleIsolation();
  else exitRpcIdleIsolation();
}

export type RpcCallTrafficRow = {
  endpoint: string;
  feature: string;
  role: RpcRole | 'unknown';
  count: number;
  lastAt: number;
};

const callTraffic = new Map<string, RpcCallTrafficRow>();
/** Rolling events for last-60s callTraffic (not lifetime). */
const callTrafficEvents: Array<{
  at: number;
  endpoint: string;
  feature: string;
  role: RpcRole | 'unknown';
}> = [];
const CALL_TRAFFIC_EVENTS_CAP = 800;

const dashboardRefreshAts: number[] = [];
const probeRefreshAts: number[] = [];
let lastHealthProbeSuccessAt = 0;

function noteCallTraffic(
  endpoint: string,
  feature: string,
  role: RpcRole | 'unknown'
) {
  const key = `${endpoint}|${feature}|${role}`;
  const prev = callTraffic.get(key);
  const now = Date.now();
  if (prev) {
    prev.count += 1;
    prev.lastAt = now;
  } else {
    callTraffic.set(key, {
      endpoint,
      feature,
      role,
      count: 1,
      lastAt: now,
    });
  }
  callTrafficEvents.push({ at: now, endpoint, feature, role });
  while (
    callTrafficEvents.length &&
    callTrafficEvents[0]!.at < now - 60_000
  ) {
    callTrafficEvents.shift();
  }
  while (callTrafficEvents.length > CALL_TRAFFIC_EVENTS_CAP) {
    callTrafficEvents.shift();
  }
  if (callTraffic.size > CALL_TRAFFIC_CAP) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, row] of callTraffic) {
      if (row.lastAt < oldestAt) {
        oldestAt = row.lastAt;
        oldestKey = k;
      }
    }
    if (oldestKey) callTraffic.delete(oldestKey);
  }
}

export function getRpcCallTraffic(limit = 40): {
  rows: RpcCallTrafficRow[];
  total: number;
} {
  const rows = [...callTraffic.values()].sort((a, b) => b.count - a.count);
  const total = rows.reduce((s, r) => s + r.count, 0);
  return { rows: rows.slice(0, limit), total };
}

export function getRpcCallTrafficLast60s(limit = 15): {
  rows: Array<{
    endpoint: string;
    feature: string;
    role: RpcRole | 'unknown';
    count: number;
    lastAt: number;
  }>;
  total: number;
} {
  const now = Date.now();
  while (
    callTrafficEvents.length &&
    callTrafficEvents[0]!.at < now - 60_000
  ) {
    callTrafficEvents.shift();
  }
  const byKey = new Map<
    string,
    {
      endpoint: string;
      feature: string;
      role: RpcRole | 'unknown';
      count: number;
      lastAt: number;
    }
  >();
  for (const e of callTrafficEvents) {
    const key = `${e.endpoint}|${e.feature}|${e.role}`;
    const prev = byKey.get(key);
    if (prev) {
      prev.count += 1;
      prev.lastAt = Math.max(prev.lastAt, e.at);
    } else {
      byKey.set(key, {
        endpoint: e.endpoint,
        feature: e.feature,
        role: e.role,
        count: 1,
        lastAt: e.at,
      });
    }
  }
  const rows = [...byKey.values()].sort((a, b) => b.count - a.count);
  const total = rows.reduce((s, r) => s + r.count, 0);
  return { rows: rows.slice(0, limit), total };
}

export function noteStatusRequestSource(src: string | undefined): void {
  const s = String(src || '').toLowerCase();
  if (s === 'dashboard' || s === 'dashboard-refresh') {
    notePerMin(dashboardRefreshAts);
  } else if (s === 'probe') {
    notePerMin(probeRefreshAts);
  }
}

/** True if a health probe succeeded recently (skip duplicate testConnection). */
export function recentHealthProbeOk(withinMs = 30_000): boolean {
  return (
    lastHealthProbeSuccessAt > 0 &&
    Date.now() - lastHealthProbeSuccessAt < withinMs
  );
}

function hardenWsClient(conn: Connection): void {
  try {
    const ws = (
      conn as unknown as {
        _rpcWebSocket?: {
          max_reconnects?: number;
          reconnect?: boolean;
          close?: () => void;
        };
      }
    )._rpcWebSocket;
    if (ws) {
      ws.max_reconnects = 0;
      ws.reconnect = false;
    }
  } catch {
    /* web3.js internals */
  }
}

function makeConnection(url: string): Connection {
  const conn = new Connection(url, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    confirmTransactionInitialTimeout: 60_000,
  });
  hardenWsClient(conn);
  return conn;
}

/** HTTP-only confirm — never opens signatureSubscribe. */
export async function confirmSignatureHttp(
  conn: Connection,
  signature: string,
  timeoutMs = CONFIRM_TIMEOUT_MS
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const { value } = await conn.getSignatureStatuses([signature]);
      const st = value[0];
      if (st?.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(st.err)}`);
      }
      if (
        st?.confirmationStatus === 'confirmed' ||
        st?.confirmationStatus === 'finalized'
      ) {
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (is429(message)) {
        throw new Error(`confirm aborted: rate-limited (${message})`);
      }
      if (/Transaction failed/.test(message)) throw err;
    }
    await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS));
  }
  throw new Error(`confirm timeout after ${timeoutMs}ms: ${signature}`);
}

export function isRpc429Message(message: string): boolean {
  return is429(message);
}

function makeState(ep: RpcEndpointRef, emergencyOnly = false): EndpointState {
  return {
    endpoint: { url: ep.url, label: ep.label },
    connection: makeConnection(ep.url),
    healthy: true,
    latencyMs: null,
    probeLatencyMs: null,
    lastCallLatencyMs: null,
    successCount: 0,
    failureCount: 0,
    lastCheckedAt: null,
    consecutiveFailures: 0,
    unhealthySince: null,
    rateLimitedUntil: 0,
    hardFailUntil: 0,
    quarantineStreak: 0,
    emergencyOnly,
  };
}

function emergencyChain(): EndpointState[] {
  return emergencyPublic ? [emergencyPublic] : [];
}

function ensureEndpoints(): void {
  if (poolBuilt) return;
  const assigned = rpcEndpointsFromAssignments();
  heliusCold = [];
  tradingAlchemyFailover = null;
  tradingFailover = null;
  emergencyPaid = null;

  tradingPref = assigned.trading ? makeState(assigned.trading) : null;
  dataPref = assigned.data ? makeState(assigned.data) : null;
  dataFailover = assigned.dataEmergency
    ? makeState(assigned.dataEmergency, true)
    : null;
  emergencyPublic = assigned.tradingEmergency
    ? makeState(assigned.tradingEmergency, true)
    : null;
  backgroundEmergency = assigned.backgroundEmergency
    ? makeState(assigned.backgroundEmergency, true)
    : null;

  publics = [emergencyPublic, backgroundEmergency, dataFailover].filter(
    (e): e is EndpointState => Boolean(e)
  );

  hotIncludesBackground = wantBackgroundHot();
  if (hotIncludesBackground && assigned.background) {
    backgroundPref = makeState(assigned.background);
  } else {
    backgroundPref = null;
  }

  poolBuilt = true;
  const asg = getRpcLaneAssignments();
  console.log(
    `[rpc] lane pool: trading=${tradingPref?.endpoint.label || 'none'}` +
      (asg.trading.emergency ? `+em(${asg.trading.emergency})` : '') +
      ` data=${dataPref?.endpoint.label || 'none'}` +
      (asg.data.emergency ? `+em(${asg.data.emergency})` : '') +
      ` background=${hotIncludesBackground ? backgroundPref?.endpoint.label || 'on' : 'idle'}` +
      (asg.background.emergency ? `+em(${asg.background.emergency})` : '')
  );
  if (!tradingPref) {
    console.warn('[rpc] Trading Main unassigned — soft-fail until assigned in Stats → RPC');
  }
  if (!dataPref) {
    console.warn('[rpc] Data Main unassigned — soft-fail until assigned in Stats → RPC');
  }
  // Scanners (secondary) burn CU on Data — Alchemy as Data Main regularly 429s.
  const dataLabel = (dataPref?.endpoint.label || '').toLowerCase();
  if (dataLabel.includes('alchemy')) {
    console.warn(
      '[rpc] Data Main is Alchemy — Market/Alpha/Zion bonding_curve CU hits Alchemy. ' +
        'Prefer Data=Helius + Trading=Alchemy (or assign Data Emergency) in Stats → RPC.'
    );
  }
}

/** Rematerialize Background hot slot when feature workloads toggle. */
export function refreshRpcHotPool(): void {
  if (!poolBuilt) {
    ensureEndpoints();
    return;
  }
  const assigned = rpcEndpointsFromAssignments();
  const wantBg = wantBackgroundHot();
  if (wantBg === hotIncludesBackground) {
    if (!wantBg) backgroundPref = null;
    return;
  }
  if (!wantBg) {
    backgroundPref = null;
    backgroundIdx = 0;
    hotIncludesBackground = false;
    console.log('[rpc] Background → idle (feature workloads OFF)');
    return;
  }
  backgroundPref = assigned.background
    ? makeState(assigned.background)
    : null;
  if (!backgroundEmergency && assigned.backgroundEmergency) {
    backgroundEmergency = makeState(assigned.backgroundEmergency, true);
  }
  hotIncludesBackground = Boolean(backgroundPref);
  console.log(
    `[rpc] Background → hot (${backgroundPref?.endpoint.label || 'none'})`
  );
}

export function resetRpcEndpointPool(): void {
  tradingPref = null;
  tradingAlchemyFailover = null;
  tradingFailover = null;
  dataPref = null;
  dataFailover = null;
  backgroundPref = null;
  backgroundEmergency = null;
  emergencyPaid = null;
  emergencyPublic = null;
  publics = [];
  heliusCold = [];
  poolBuilt = false;
  hotIncludesBackground = false;
  tradingHop = 0;
  dataOnFailover = false;
  backgroundIdx = 0;
  tradingHardFailStreak = 0;
  tradingRecoverAt = 0;
  lastHealthProbeAt = 0;
  callTraffic.clear();
  callTrafficEvents.length = 0;
  lastHealthProbeSuccessAt = 0;
  probeCallAts.length = 0;
  featureCallAts.length = 0;
  healthPageRefreshAts.length = 0;
  ensureEndpoints();
}

/** Rebuild pool after UI lane assignment Apply. */
export function applyLaneAssignments(): void {
  resetRpcEndpointPool();
  try {
    syncRpcIdleIsolation();
  } catch {
    /* */
  }
}

export function isWeakPublicUtilityUrl(url: string | null | undefined): boolean {
  return isPublicRpcUrl(url);
}

export function isUtilityOnWeakPublic(): boolean {
  ensureEndpoints();
  if (!wantBackgroundHot()) return false;
  const st = laneState('background');
  return isPublicRpcUrl(st?.endpoint.url);
}

export function shouldDeferHeavyRpc(): boolean {
  try {
    const { shouldDeferFavouritesWork } =
      require('./rpcLoadControl') as typeof import('./rpcLoadControl');
    return shouldDeferFavouritesWork();
  } catch {
    return false;
  }
}

export function isLaneRateLimited(role: RpcRole = 'primary'): boolean {
  ensureEndpoints();
  const norm = normalizeRole(role);
  // Check preferred endpoints directly — active may be null while rate-limited.
  if (norm === 'primary') {
    if (tradingPref && isRateLimited(tradingPref)) return true;
    if (emergencyPublic && isRateLimited(emergencyPublic)) {
      return Boolean(!tradingPref || isRateLimited(tradingPref));
    }
    return false;
  }
  if (norm === 'secondary') {
    if (dataOnFailover && dataFailover) {
      return isRateLimited(dataFailover);
    }
    return Boolean(dataPref && isRateLimited(dataPref));
  }
  const bg = backgroundPref || backgroundEmergency;
  return Boolean(bg && isRateLimited(bg));
}

function rpcHostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function rpcKeyHint(url: string): string {
  try {
    const u = new URL(url);
    const q = u.searchParams.get('api-key') || u.searchParams.get('apiKey');
    if (q && q.length >= 8) return q;
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    return last.length >= 20 ? last : '';
  } catch {
    return '';
  }
}

export function lanesShareEndpoint(): boolean {
  ensureEndpoints();
  if (!tradingPref || !dataPref) return true;
  return tradingPref.endpoint.url === dataPref.endpoint.url;
}

/** Same URL, same host, or same API key reused across Trading and Data. */
export function lanesShareProviderOrKey(): boolean {
  if (lanesShareEndpoint()) return true;
  if (!tradingPref || !dataPref) return true;
  const th = rpcHostOf(tradingPref.endpoint.url);
  const dh = rpcHostOf(dataPref.endpoint.url);
  if (th && dh && th === dh) return true;
  const tk = rpcKeyHint(tradingPref.endpoint.url);
  const dk = rpcKeyHint(dataPref.endpoint.url);
  if (tk && dk && tk === dk) return true;
  return false;
}

function shouldSkipTradingGetSlot(): boolean {
  try {
    const { getProcessUptimeMs } =
      require('./rpcBootTimeline') as typeof import('./rpcBootTimeline');
    const { TRADING_GETSLOT_SKIP_MS } =
      require('./bootPhase') as typeof import('./bootPhase');
    return getProcessUptimeMs() < TRADING_GETSLOT_SKIP_MS;
  } catch {
    return false;
  }
}

export function isTradingEwmaRecovered(): boolean {
  return tradingEwmaRecovered;
}

export function isDataEwmaRecovered(): boolean {
  return dataEwmaRecovered;
}

function normalizeRole(role: RpcRole | undefined): NormalizedRpcRole {
  return normalizeRpcRole(role);
}

function currentRole(): RpcRole {
  return rpcRoleAls.getStore() ?? 'primary';
}

export function hasRpcRoleContext(): boolean {
  return rpcRoleAls.getStore() != null;
}

function usable(st: EndpointState | null): boolean {
  return Boolean(
    st && st.healthy && !isRateLimited(st) && !isHardFailed(st)
  );
}

function tradingActive(): EndpointState | null {
  ensureEndpoints();
  if (!tradingPref && !emergencyPublic) return null;
  // 0 Main → 1 Emergency (assigned only)
  if (tradingHop <= 0) {
    if (!tradingPref) {
      return usable(emergencyPublic) ? emergencyPublic : null;
    }
    if (usable(tradingPref)) return tradingPref;
    if (isRateLimited(tradingPref) || isHardFailed(tradingPref)) {
      // Fall through to emergency — never re-hit CU-limited Main.
    } else {
      return tradingPref;
    }
  }
  const chain = emergencyChain().filter((e) => usable(e));
  if (chain.length) {
    const idx = Math.min(Math.max(0, tradingHop - 1), chain.length - 1);
    return chain[idx]!;
  }
  // No usable emergency — refuse rate-limited Main (fail closed).
  return null;
}

function dataActive(): EndpointState | null {
  ensureEndpoints();
  if (!dataPref && !dataFailover) return null;
  if (dataOnFailover && dataFailover) {
    if (usable(dataFailover)) return dataFailover;
    if (usable(dataPref)) {
      dataOnFailover = false;
      return dataPref;
    }
    return null;
  }
  if (usable(dataPref)) return dataPref;
  if (dataPref && isRateLimited(dataPref)) {
    if (dataFailover && usable(dataFailover)) {
      dataOnFailover = true;
      return dataFailover;
    }
    // No Data Emergency — refuse Alchemy re-hit during CU cooldown.
    return null;
  }
  if (dataPref && !isHardFailed(dataPref)) {
    return dataPref;
  }
  if (dataFailover && usable(dataFailover)) {
    dataOnFailover = true;
    return dataFailover;
  }
  return null;
}

function backgroundActive(): EndpointState | null {
  ensureEndpoints();
  if (!wantBackgroundHot()) return null;
  if (!backgroundPref) {
    refreshRpcHotPool();
  }
  const chain: EndpointState[] = [];
  if (backgroundPref) chain.push(backgroundPref);
  if (
    backgroundEmergency &&
    backgroundEmergency !== backgroundPref
  ) {
    chain.push(backgroundEmergency);
  }
  if (!chain.length) return null;
  for (let i = 0; i < chain.length; i++) {
    const idx = (backgroundIdx + i) % chain.length;
    const candidate = chain[idx]!;
    if (usable(candidate)) {
      backgroundIdx = idx;
      return candidate;
    }
  }
  // Prefer non-rate-limited hard-failed? No — refuse CU storms.
  return null;
}

function laneState(role: NormalizedRpcRole): EndpointState | null {
  if (role === 'primary') return tradingActive();
  if (role === 'secondary') return dataActive();
  return backgroundActive();
}

function isRateLimited(st: EndpointState): boolean {
  return st.rateLimitedUntil > Date.now();
}

function isHardFailed(st: EndpointState): boolean {
  return st.hardFailUntil > Date.now();
}

function is429(message: string): boolean {
  return (
    /429|too many requests|rate.?limit/i.test(message) ||
    /compute units per second/i.test(message) ||
    /-32429/.test(message)
  );
}

function isHardError(message: string): boolean {
  return (
    is429(message) ||
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|socket hang up|503|502|500|401|403/i.test(
      message
    )
  );
}

function apply429Backoff(st: EndpointState): number {
  const label = st.endpoint.label || st.endpoint.url;
  const streak = (rateLimitStreakByLabel.get(label) || 0) + 1;
  rateLimitStreakByLabel.set(label, Math.min(8, streak));
  const cool = Math.min(
    RATE_LIMIT_BACKOFF_CAP_MS,
    RATE_LIMIT_BACKOFF_BASE_MS * Math.pow(2, streak - 1)
  );
  st.rateLimitedUntil = Date.now() + cool;
  st.healthy = false;
  if (Date.now() - last429BackoffLogAt > 15_000) {
    last429BackoffLogAt = Date.now();
    console.warn(
      `[rpc] rpc_429_backoff label=${label} cool=${Math.round(cool / 1000)}s streak=${streak}`
    );
  }
  return cool;
}

function recordSuccess(
  st: EndpointState,
  latencyMs: number,
  opts?: { fromProbe?: boolean }
): void {
  st.successCount += 1;
  st.consecutiveFailures = 0;
  st.lastCheckedAt = Date.now();
  st.lastError = undefined;
  st.lastCallLatencyMs = latencyMs;

  const tradingProbe = Boolean(opts?.fromProbe && tradingPref && st === tradingPref);
  const dataProbe = Boolean(opts?.fromProbe && dataPref && st === dataPref);
  const FAST_MS = 400;

  if (opts?.fromProbe && (tradingProbe || dataProbe)) {
    const fast = latencyMs < FAST_MS;
    if (tradingProbe) {
      tradingFastProbeStreak = fast ? tradingFastProbeStreak + 1 : 0;
      if (!tradingEwmaRecovered && tradingFastProbeStreak >= 2) {
        tradingEwmaRecovered = true;
        st.latencyMs = latencyMs;
        st.probeLatencyMs = latencyMs;
        st.healthy = true;
        st.unhealthySince = null;
        rateLimitStreakByLabel.delete(st.endpoint.label || st.endpoint.url);
        refreshRpcLoadSignalsFromLanes();
        console.log(
          `[rpc] Trading EWMA recovered after 2 probes <${FAST_MS}ms (${Math.round(latencyMs)}ms)`
        );
        return;
      }
      if (!tradingEwmaRecovered) {
        let settling = true;
        try {
          const { isBootSettling } =
            require('./bootPhase') as typeof import('./bootPhase');
          settling = isBootSettling();
        } catch {
          /* */
        }
        if (settling) {
          st.healthy = true;
          st.unhealthySince = null;
          rateLimitStreakByLabel.delete(st.endpoint.label || st.endpoint.url);
          refreshRpcLoadSignalsFromLanes();
          return;
        }
        tradingEwmaRecovered = true;
      }
    }
    if (dataProbe) {
      dataFastProbeStreak = fast ? dataFastProbeStreak + 1 : 0;
      if (!dataEwmaRecovered && dataFastProbeStreak >= 2) {
        dataEwmaRecovered = true;
        st.latencyMs = latencyMs;
        st.probeLatencyMs = latencyMs;
        st.healthy = true;
        st.unhealthySince = null;
        rateLimitStreakByLabel.delete(st.endpoint.label || st.endpoint.url);
        refreshRpcLoadSignalsFromLanes();
        console.log(
          `[rpc] Data EWMA recovered after 2 probes <${FAST_MS}ms (${Math.round(latencyMs)}ms)`
        );
        return;
      }
      if (!dataEwmaRecovered) {
        let settling = true;
        try {
          const { isBootSettling } =
            require('./bootPhase') as typeof import('./bootPhase');
          settling = isBootSettling();
        } catch {
          /* */
        }
        if (settling) {
          st.healthy = true;
          st.unhealthySince = null;
          rateLimitStreakByLabel.delete(st.endpoint.label || st.endpoint.url);
          refreshRpcLoadSignalsFromLanes();
          return;
        }
        dataEwmaRecovered = true;
      }
    }
  }

  st.latencyMs =
    st.latencyMs == null
      ? latencyMs
      : LATENCY_EWMA_ALPHA * latencyMs + (1 - LATENCY_EWMA_ALPHA) * st.latencyMs;
  if (opts?.fromProbe) {
    st.probeLatencyMs =
      st.probeLatencyMs == null
        ? latencyMs
        : LATENCY_EWMA_ALPHA * latencyMs +
          (1 - LATENCY_EWMA_ALPHA) * st.probeLatencyMs;
  }
  st.healthy = true;
  st.unhealthySince = null;
  rateLimitStreakByLabel.delete(st.endpoint.label || st.endpoint.url);
  if (st.hardFailUntil > 0 && Date.now() >= st.hardFailUntil) {
    st.hardFailUntil = 0;
    st.quarantineStreak = 0;
  }
  refreshRpcLoadSignalsFromLanes();
}

function recordFailure(st: EndpointState, message: string): void {
  st.failureCount += 1;
  st.consecutiveFailures += 1;
  st.lastCheckedAt = Date.now();
  st.lastError = message.slice(0, 240);
  if (!st.unhealthySince) st.unhealthySince = Date.now();
  if (st.consecutiveFailures >= 2) st.healthy = false;
  if (is429(message)) {
    apply429Backoff(st);
  }
  if (isHardError(message) && st.consecutiveFailures >= 2) {
    st.quarantineStreak += 1;
    const cool =
      HARD_FAIL_COOLDOWN_MS * Math.min(4, Math.max(1, st.quarantineStreak));
    st.hardFailUntil = Date.now() + cool;
  }
}

function noteTradingOutcome(ok: boolean, message?: string): void {
  if (ok) {
    tradingHardFailStreak = 0;
    if (tradingHop > 0 && usable(tradingPref)) {
      if (!tradingRecoverAt) tradingRecoverAt = Date.now() + TRADING_RECOVER_MS;
      if (Date.now() >= tradingRecoverAt) {
        tradingHop = 0;
        tradingRecoverAt = 0;
        console.log('[rpc] Trading recovered → Main');
      }
    }
    return;
  }
  tradingRecoverAt = 0;
  tradingHardFailStreak += 1;
  if (
    tradingHardFailStreak >= TRADING_HARD_FAIL_NEED ||
    (message && is429(message))
  ) {
    const maxHop = emergencyChain().length;
    if (tradingHop < maxHop) {
      tradingHop += 1;
      tradingHardFailStreak = 0;
      const st = tradingActive();
      console.warn(
        `[rpc] Trading hop → ${st?.endpoint.label || 'emergency'} (hop=${tradingHop})`
      );
    }
  }
}

function noteDataOutcome(ok: boolean): void {
  if (ok) {
    if (dataOnFailover && usable(dataPref)) dataOnFailover = false;
    return;
  }
  if (!dataOnFailover && dataFailover) {
    dataOnFailover = true;
    console.warn(`[rpc] Data failover → ${dataFailover.endpoint.label}`);
  }
}

function noteBackgroundOutcome(ok: boolean): void {
  if (ok) {
    if (backgroundIdx > 0 && usable(backgroundPref)) backgroundIdx = 0;
    return;
  }
  const max =
    (backgroundPref ? 1 : 0) +
    (backgroundEmergency && backgroundEmergency !== backgroundPref ? 1 : 0);
  if (backgroundIdx < max - 1) {
    backgroundIdx += 1;
    const st = backgroundActive();
    console.warn(
      `[rpc] Background → Emergency ${st?.endpoint.label || ''} (idx=${backgroundIdx})`
    );
  }
}

export async function runWithRpcRole<T>(
  role: RpcRole,
  fn: () => Promise<T>,
  feature = 'rpc'
): Promise<T> {
  assertRpcWorkloadEnabled(feature);
  try {
    const { isBootFeatureAllowed, bootPhaseSkipReason, noteBootPhaseIfChanged } =
      require('./bootPhase') as typeof import('./bootPhase');
    noteBootPhaseIfChanged();
    if (!isBootFeatureAllowed(feature)) {
      const { RpcGateSkipError } =
        require('./rpcGate') as typeof import('./rpcGate');
      const norm = normalizeRole(role);
      throw new RpcGateSkipError(
        'busy',
        norm as 'primary' | 'secondary' | 'background',
        bootPhaseSkipReason(feature) || feature
      );
    }
  } catch (err) {
    const { isRpcGateSkipError } =
      require('./rpcGate') as typeof import('./rpcGate');
    if (isRpcGateSkipError(err)) throw err;
    /* bootPhase optional — proceed if module missing */
  }
  if (feature !== 'health_probe') notePerMin(featureCallAts);
  const norm = normalizeRole(role);
  const depth = rpcGateDepthAls.getStore() ?? 0;
  const run = () =>
    rpcRoleAls.run(norm, () =>
      rpcFeatureAls.run(feature, () => rpcGateDepthAls.run(depth + 1, fn))
    );

  if (depth > 0) return run();
  return runWithRpcFeatureGate(feature, norm as RpcGateRole, run);
}

export { getRpcGateSnapshot, isRpcGateSkipError };
export type { RpcGateSnapshot, RpcLaneGateStats } from './rpcGate';
export {
  runDedupedRpcJob,
  runThroughRpcGate,
  RpcGateSkipError,
} from './rpcGate';

export async function runWithRpcFeature<T>(
  feature: string,
  fn: () => Promise<T>
): Promise<T> {
  const role = normalizeRole(currentRole());
  return runWithRpcRole(role, fn, feature);
}

export function getRpcUrl(role?: RpcRole): string {
  ensureEndpoints();
  return laneState(normalizeRole(role ?? currentRole()))?.endpoint.url || '';
}

export function getConnection(role?: RpcRole): Connection {
  const feature = rpcFeatureAls.getStore() || 'getConnection';
  try {
    if (feature === 'getConnection') {
      if (featuresOffNow() || idleIsolationActive) {
        throw new RpcWorkloadDisabledError('health_probe');
      }
    } else {
      assertRpcWorkloadEnabled(feature);
    }
  } catch (err) {
    if (err instanceof RpcWorkloadDisabledError) throw err;
    /* catalog optional during boot */
  }
  ensureEndpoints();
  const norm = normalizeRole(role ?? currentRole());
  const st = laneState(norm);
  if (!st) {
    if (norm === 'secondary' && isLaneRateLimited('secondary')) {
      throw new Error('rpc_data_rate_limited');
    }
    if (norm === 'primary' && isLaneRateLimited('primary')) {
      throw new Error('rpc_trading_rate_limited');
    }
    if (norm === 'background' && isLaneRateLimited('background')) {
      throw new Error('rpc_background_rate_limited');
    }
    throw new Error('No RPC endpoint configured');
  }
  noteCallTraffic(
    st.endpoint.label,
    feature,
    norm
  );
  return st.connection;
}

export function getActiveEndpointLabel(role?: RpcRole): string {
  ensureEndpoints();
  return (
    laneState(normalizeRole(role ?? currentRole()))?.endpoint.label || 'none'
  );
}

export function noteActiveRpcFailure(
  message: unknown,
  role: RpcRole = 'primary'
): void {
  ensureEndpoints();
  const msg =
    message instanceof Error
      ? message.message
      : typeof message === 'string'
        ? message
        : String(message);
  const norm = normalizeRole(role);
  const st = laneState(norm);
  if (st) recordFailure(st, msg);
  if (norm === 'primary') noteTradingOutcome(false, msg);
  else if (norm === 'secondary') noteDataOutcome(false);
  else noteBackgroundOutcome(false);
}

async function probeState(
  st: EndpointState,
  timeoutMs = 8_000
): Promise<boolean> {
  const off = featuresOffNow() || idleIsolationActive;
  noteIdleRpcCall({
    label: 'health_probe',
    endpoint: st.endpoint.label,
    method: 'getSlot',
    featuresOff: off,
  });
  notePerMin(probeCallAts);
  if (isRateLimited(st) || isHardFailed(st)) {
    st.lastCheckedAt = Date.now();
    return false;
  }
  const start = Date.now();
  try {
    await Promise.race([
      st.connection.getSlot('confirmed'),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`RPC probe timeout after ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ]);
    const ms = Date.now() - start;
    recordSuccess(st, ms, { fromProbe: true });
    lastHealthProbeSuccessAt = Date.now();
    try {
      const { noteBootTimeline } =
        require('./rpcBootTimeline') as typeof import('./rpcBootTimeline');
      noteBootTimeline({
        event: 'probe',
        feature: 'health_probe',
        method: 'getSlot',
        endpoint: st.endpoint.label,
        ms,
      });
    } catch {
      /* */
    }
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordFailure(st, message);
    return false;
  }
}

export async function withRpc<T>(
  label: string,
  fn: (conn: Connection) => Promise<T>,
  role?: RpcRole
): Promise<T> {
  return runWithRpcFeature(label, () => withRpcInner(label, fn, role));
}

async function withRpcInner<T>(
  label: string,
  fn: (conn: Connection) => Promise<T>,
  role?: RpcRole
): Promise<T> {
  ensureEndpoints();
  const r = normalizeRole(role ?? currentRole());
  const critical =
    /trade|migrat|send|confirm|swap|buy|sell/i.test(label) || r === 'primary';
  // Non-critical: single attempt (no tight 150ms retry storm under 429).
  const maxAttempts = critical
    ? WITH_RPC_MAX_ATTEMPTS_CRITICAL
    : WITH_RPC_MAX_ATTEMPTS_OTHER;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let st = laneState(r);
    if (!st) {
      lastError = new Error(`No ${r} RPC endpoint`);
      break;
    }

    // Never hammer a rate-limited / hard-failed endpoint in a tight loop.
    if (isRateLimited(st) || isHardFailed(st)) {
      if (critical && r === 'primary' && tradingHop < 1 && emergencyPublic) {
        noteTradingOutcome(false, '429');
        st = laneState(r);
        if (!st || isRateLimited(st) || isHardFailed(st)) {
          lastError = new Error(
            `RPC ${st?.endpoint.label || r} rate-limited — cooldown active`
          );
          break;
        }
      } else {
        lastError = new Error(
          `RPC ${st.endpoint.label} rate-limited — cooldown active`
        );
        break;
      }
    }

    logger.info('RPC', `start: ${label}`, {
      role: r,
      active: st.endpoint.label,
      attempt: attempt + 1,
    });

    const start = Date.now();
    try {
      noteCallTraffic(st.endpoint.label, label, r);
      noteIdleRpcCall({
        label,
        endpoint: st.endpoint.label,
        method: 'withRpc',
        featuresOff: featuresOffNow() || idleIsolationActive,
      });
      notePerMin(featureCallAts);
      const result = await fn(st.connection);
      const ms = Date.now() - start;
      recordSuccess(st, ms);
      try {
        const { noteBootTimeline } =
          require('./rpcBootTimeline') as typeof import('./rpcBootTimeline');
        if (ms >= 80 || /migrat|scanner|wallet_poll|bonding|open_mark/i.test(label)) {
          noteBootTimeline({
            event: 'withRpc',
            feature: label,
            method: 'withRpc',
            endpoint: st.endpoint.label,
            ms,
          });
        }
      } catch {
        /* */
      }
      if (r === 'primary') noteTradingOutcome(true);
      else if (r === 'secondary') noteDataOutcome(true);
      else noteBackgroundOutcome(true);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = err;
      recordFailure(st, message);
      if (r === 'primary') noteTradingOutcome(false, message);
      else if (r === 'secondary') noteDataOutcome(false);
      else noteBackgroundOutcome(false);
      logger.warn('RPC', `fail: ${label}`, {
        ...errorToMeta(err),
        endpoint: st.endpoint.label,
      });
      if (is429(message)) {
        // Wait out a slice of the cooldown — never 150ms tight retry.
        const waitMs = Math.min(
          5_000,
          Math.max(500, (st.rateLimitedUntil || Date.now()) - Date.now())
        );
        if (critical && attempt + 1 < maxAttempts) {
          await new Promise((res) => setTimeout(res, waitMs));
          continue;
        }
        break;
      }
      if (!critical || attempt + 1 >= maxAttempts) break;
      await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`RPC ${label} failed`);
}

function successRate(st: EndpointState | null): number {
  if (!st) return 0;
  const t = st.successCount + st.failureCount;
  if (t === 0) return 100;
  return Math.round((100 * st.successCount) / t);
}

function toEndpointStats(
  st: EndpointState | null,
  role: NormalizedRpcRole | 'utility',
  isActive: boolean,
  lane: RpcRole | null
): RpcEndpointStats | null {
  if (!st) return null;
  return {
    url: st.endpoint.url,
    label: st.endpoint.label,
    role,
    healthy: st.healthy && !isRateLimited(st) && !isHardFailed(st),
    latencyMs: st.latencyMs,
    probeLatencyMs: st.probeLatencyMs,
    lastCallLatencyMs: st.lastCallLatencyMs,
    successCount: st.successCount,
    failureCount: st.failureCount,
    successRate: successRate(st),
    lastError: st.lastError,
    lastCheckedAt: st.lastCheckedAt,
    unhealthySince: st.unhealthySince,
    isActive,
    lane,
    emergencyOnly: st.emergencyOnly,
  };
}

function buildCongestion(
  lane: LaneId,
  st: EndpointState | null,
  opts: {
    onEmergency?: boolean;
    recoverAt?: number;
    gateRole?: RpcGateRole;
  } = {}
): LaneCongestion {
  if (lane === 'emergency' && !opts.onEmergency) {
    return { state: 'idle', cause: 'idle until Trading hard-fail', details: [] };
  }
  const details: string[] = [];
  const gate = getRpcGateSnapshot();
  const g = opts.gateRole ? gate.lanes[opts.gateRole] : null;
  if (g) {
    details.push(
      `gate ${g.inFlight}/${g.max} q=${g.queued} skips/min=${g.skipsPerMin}`
    );
    if (g.topSkipReason) details.push(`top skip: ${g.topSkipReason}`);
  }
  if (st?.latencyMs != null) {
    details.push(`ewma ${Math.round(st.latencyMs)}ms`);
    if (
      st.lastCallLatencyMs != null &&
      st.latencyMs > 0 &&
      st.lastCallLatencyMs > st.latencyMs * 2.5 &&
      st.lastCallLatencyMs > 800
    ) {
      details.push(`spike ${Math.round(st.lastCallLatencyMs)}ms`);
    }
  }
  if (opts.onEmergency) {
    const left = opts.recoverAt ? Math.max(0, opts.recoverAt - Date.now()) : 0;
    details.push(
      left > 0
        ? `failover; recover in ${Math.ceil(left / 1000)}s`
        : 'failover active'
    );
    return {
      state: 'failover',
      cause: `Trading on ${st?.endpoint.label || 'emergency'}`,
      details,
    };
  }
  if (!st || (!st.healthy && st.consecutiveFailures >= 2)) {
    return { state: 'down', cause: st?.lastError || 'lane down', details };
  }
  if (g && (g.queued > g.max || g.skipsPerMin > 20)) {
    return {
      state: 'congested',
      cause: g.topSkipReason || `queue ${g.queued}`,
      details,
    };
  }
  if (
    g &&
    (g.queued > 4 ||
      g.skipsPerMin > 8 ||
      (st.latencyMs != null && st.latencyMs > 1500))
  ) {
    return {
      state: 'busy',
      cause:
        st.latencyMs != null && st.latencyMs > 1500
          ? `latency ${Math.round(st.latencyMs)}ms`
          : `queue ${g.queued}`,
      details,
    };
  }
  return { state: 'ok', cause: 'healthy', details };
}

function refreshRpcLoadSignalsFromLanes(): void {
  try {
    const { updateRpcLoadSignals } =
      require('./rpcLoadControl') as typeof import('./rpcLoadControl');
    const bgFeatureOn = wantBackgroundHot();
    const tActive = laneState('primary');
    const dActive = laneState('secondary');
    const bActive = bgFeatureOn ? laneState('background') : null;
    const gate = getRpcGateSnapshot();
    updateRpcLoadSignals({
      primaryLatencyMs: tradingEwmaRecovered ? tActive?.latencyMs ?? null : null,
      secondaryLatencyMs: dataEwmaRecovered ? dActive?.latencyMs ?? null : null,
      backgroundLatencyMs: bgFeatureOn ? bActive?.latencyMs ?? null : null,
      tradingOnEmergency: tradingHop >= 1 && Boolean(emergencyPublic),
      dataHealthy: Boolean(dActive?.healthy),
      dataRateLimited: Boolean(
        dActive && (dActive.rateLimitedUntil || 0) > Date.now()
      ),
      backgroundHealthy: bgFeatureOn ? Boolean(bActive?.healthy) : true,
      primaryQueued: gate.lanes.primary.queued,
    });
  } catch {
    /* */
  }
}

function heapUsedMb(): number {
  return Math.round((process.memoryUsage().heapUsed / (1024 * 1024)) * 10) / 10;
}

function activeTimersCount(): number | null {
  try {
    const proc = process as NodeJS.Process & {
      getActiveResourcesInfo?: () => string[];
    };
    if (typeof proc.getActiveResourcesInfo !== 'function') return null;
    return proc
      .getActiveResourcesInfo()
      .filter((t) => t === 'Timeout' || t === 'Immediate').length;
  } catch {
    return null;
  }
}

export function getRpcQueueSizeSnapshot(): Record<string, number> {
  pruneCallTrafficWindow();
  const out: Record<string, number> = {
    callTrafficEvents: callTrafficEvents.length,
    callTraffic: callTraffic.size,
    heap_used_mb: heapUsedMb(),
  };
  try {
    const { paperTrader } =
      require('./paperTrader') as typeof import('./paperTrader');
    out.paperClosedRing = paperTrader.closedRingSize();
  } catch {
    /* */
  }
  return out;
}

function pruneCallTrafficWindow(): void {
  const now = Date.now();
  while (
    callTrafficEvents.length &&
    callTrafficEvents[0]!.at < now - 60_000
  ) {
    callTrafficEvents.shift();
  }
}

export type GetRpcStatsOpts = {
  lite?: boolean;
  /** Count this read as a health-page refresh (Stats RPC tab only). */
  countHealthRefresh?: boolean;
};

let rpcStatsCache: { at: number; full: ReturnType<typeof buildRpcStats> } | null =
  null;

export function getRpcStats(opts?: GetRpcStatsOpts) {
  if (opts?.countHealthRefresh) notePerMin(healthPageRefreshAts);
  const now = Date.now();
  if (rpcStatsCache && now - rpcStatsCache.at < RPC_STATS_CACHE_MS) {
    const cached = rpcStatsCache.full;
    return opts?.lite ? slimRpcStats(cached) : cached;
  }
  const full = buildRpcStats();
  rpcStatsCache = { at: now, full };
  return opts?.lite ? slimRpcStats(full) : full;
}

function slimRpcStats(full: ReturnType<typeof buildRpcStats>) {
  const {
    callTraffic: _ct,
    callTrafficLast60s: _ct60,
    bootTimeline: _bt,
    ...slim
  } = full as typeof full & {
    callTraffic?: unknown;
    callTrafficLast60s?: unknown;
    bootTimeline?: unknown;
  };
  return {
    ...slim,
    callTraffic: {},
    callTrafficLast60s: {},
    bootTimeline: { processStartedAt: 0, uptimeMs: 0, recent: [] },
    lite: true as const,
  };
}

function buildRpcStats() {
  ensureEndpoints();
  const tActive = laneState('primary');
  const dActive = laneState('secondary');
  const bgFeatureOn = wantBackgroundHot();
  const bActive = bgFeatureOn ? laneState('background') : null;
  const tradingOnEmergency = tradingHop >= 1 && Boolean(emergencyPublic);
  const dataOnEmergency = dataOnFailover && Boolean(dataFailover);
  const backgroundOnEmergency =
    bgFeatureOn && backgroundIdx >= 1 && Boolean(backgroundEmergency);
  const eActive =
    tradingOnEmergency
      ? emergencyPublic
      : dataOnEmergency
        ? dataFailover
        : backgroundOnEmergency
          ? backgroundEmergency
          : emergencyPublic || dataFailover || backgroundEmergency || null;
  const backgroundIdleWhenWorkloadsOff = !bgFeatureOn;
  const asg = getRpcLaneAssignments();
  const probeCallsPerMin = perMin(probeCallAts);
  const featureCallsPerMin = perMin(featureCallAts);
  const healthPageRefreshCallsPerMin = perMin(healthPageRefreshAts);
  let watcherPolls = { dip: 0, trend: 0, majors: 0, total: 0 };
  try {
    const { getWatcherPollsPerMin } =
      require('./watcherPollMetrics') as typeof import('./watcherPollMetrics');
    watcherPolls = getWatcherPollsPerMin();
  } catch {
    /* optional */
  }
  const hotStates = [
    tradingPref,
    tradingOnEmergency ? emergencyPublic : null,
    dataPref,
    dataOnEmergency ? dataFailover : null,
    bgFeatureOn ? backgroundPref : null,
    backgroundOnEmergency ? backgroundEmergency : null,
  ].filter((e): e is EndpointState => Boolean(e));
  // Deduplicate by URL for count
  const activeEndpointsCount = new Set(
    hotStates.map((s) => s.endpoint.url.toLowerCase())
  ).size;
  const featuresOff = (() => {
    try {
      return shouldIdleIsolate() || allFeatureWorkloadsOff();
    } catch {
      return false;
    }
  })();
  let controlPlaneThrash: string | null = null;
  if (featuresOff && !idleIsolationActive && probeCallsPerMin >= 2) {
    controlPlaneThrash = 'probes_while_features_off';
  }
  if (idleIsolationActive) {
    try {
      const trace = getIdleRpcTraceSnapshot();
      if (trace.rpc_calls_last_60s > 0) {
        controlPlaneThrash = 'residual_rpc_while_idle_isolation';
      }
    } catch {
      /* */
    }
  }

  const downFor = (st: EndpointState | null) =>
    st?.unhealthySince ? Math.max(0, Date.now() - st.unhealthySince) : 0;

  const anyHealthy = [tActive, dActive].some(
    (s) => s && s.healthy && !isRateLimited(s) && !isHardFailed(s)
  );

  let warning: string | null = null;
  if (!tradingPref) {
    warning = 'Trading Main unassigned — assign in Stats → RPC.';
  } else if (!dataPref) {
    warning = 'Data Main unassigned — assign in Stats → RPC.';
  } else if (!anyHealthy) {
    warning =
      'Trading/Data unhealthy — check assigned Mains or hop to Emergency.';
  } else if (tradingOnEmergency) {
    warning = `Trading on Emergency (${tActive?.endpoint.label || 'em'}) — Main recovering.`;
  } else if (lanesShareProviderOrKey()) {
    warning =
      'Trading and Data share a provider or API key — assign distinct Alchemy vs Helius.';
  } else if (controlPlaneThrash) {
    warning =
      'Control-plane thrash: feature workloads OFF but probes still high — check health_probe rate.';
  }

  const gate = getRpcGateSnapshot();
  if (!warning && gate.stressed) {
    warning =
      'RPC gate stressed — Data scanners or Background Favourites may be queued/skipped.';
  }

  const allStates = hotStates;

  const quarantine = allStates
    .filter((e) => isHardFailed(e))
    .map((e) => ({
      label: e.endpoint.label,
      remainingMs: Math.max(0, e.hardFailUntil - Date.now()),
      streak: e.quarantineStreak || 0,
      lastError: e.lastError,
    }));

  let loadControl: ReturnType<
    typeof import('./rpcLoadControl').getRpcLoadControlSnapshot
  > | null = null;
  try {
    const { getRpcLoadControlSnapshot } =
      require('./rpcLoadControl') as typeof import('./rpcLoadControl');
    loadControl = getRpcLoadControlSnapshot();
  } catch {
    /* optional */
  }

  const tradingCong = buildCongestion('trading', tActive, {
    onEmergency: tradingOnEmergency,
    recoverAt: tradingRecoverAt || undefined,
    gateRole: 'primary',
  });
  const dataCong = buildCongestion('data', dActive, {
    onEmergency: dataOnEmergency,
    gateRole: 'secondary',
  });
  let bgCong = buildCongestion('background', bActive, {
    gateRole: 'background',
  });
  if (backgroundIdleWhenWorkloadsOff) {
    bgCong = {
      state: 'idle',
      cause: 'background feature workloads OFF',
      details: ['no polling', 'no Background probe'],
    };
  } else if (loadControl?.favouritesDeferred) {
    bgCong.details.push(
      `Favourites deferred; scanners×${loadControl.scannerMultiplier}`
    );
    if (bgCong.state === 'ok') {
      bgCong.state = 'busy';
      bgCong.cause = loadControl.cause || bgCong.cause;
    }
  }
  if (loadControl?.level === 'shed' || loadControl?.level === 'busy') {
    dataCong.details.push(`shed: scanners×${loadControl.scannerMultiplier}`);
    if (dataCong.state === 'ok' && loadControl.level === 'shed') {
      dataCong.state = 'congested';
      dataCong.cause = loadControl.cause || dataCong.cause;
    }
  }
  const emergCong = buildCongestion('emergency', eActive, {
    onEmergency: tradingOnEmergency,
  });

  const endpoints: Array<RpcEndpointStats & { emergencyOnly?: boolean }> = [];
  const pushEp = (
    st: EndpointState | null,
    role: NormalizedRpcRole | 'utility',
    active: boolean,
    lane: RpcRole | null
  ) => {
    const s = toEndpointStats(st, role, active, lane);
    if (s) endpoints.push(s);
  };
  pushEp(tradingPref, 'primary', tActive === tradingPref, 'primary');
  if (emergencyPublic) {
    pushEp(
      emergencyPublic,
      'utility',
      tActive === emergencyPublic,
      'utility'
    );
  }
  pushEp(
    dataPref,
    'secondary',
    tActive !== dataPref && dActive === dataPref,
    'secondary'
  );
  if (dataFailover) {
    pushEp(
      dataFailover,
      'secondary',
      dActive === dataFailover,
      'secondary'
    );
  }
  if (bgFeatureOn) {
    pushEp(
      backgroundPref,
      'background',
      bActive === backgroundPref,
      'background'
    );
    if (backgroundEmergency) {
      pushEp(
        backgroundEmergency,
        'background',
        bActive === backgroundEmergency,
        'background'
      );
    }
  }

  const idleBackups = heliusCold.map((h) => ({
    label: h.label,
    url: h.url,
    probed: false as const,
    role: 'cold-helius' as const,
  }));

  return {
    mode: 'slim3' as const,
    multiLaneActive: false as const,
    shareLoad: false,
    active: tActive?.endpoint.label || 'none',
    primary: {
      label: tActive?.endpoint.label || 'none',
      url: tActive?.endpoint.url || '',
      healthy: Boolean(tActive?.healthy),
      failover: tradingHop > 0,
      downForMs: downFor(tradingPref),
    },
    secondary: {
      label: dActive?.endpoint.label || 'none',
      url: dActive?.endpoint.url || '',
      healthy: Boolean(dActive?.healthy),
      failover: dataOnFailover,
      downForMs: downFor(dataPref),
    },
    utility: {
      label: backgroundIdleWhenWorkloadsOff
        ? 'idle'
        : bActive?.endpoint.label || 'none',
      url: backgroundIdleWhenWorkloadsOff ? '' : bActive?.endpoint.url || '',
      healthy: backgroundIdleWhenWorkloadsOff
        ? true
        : Boolean(bActive?.healthy),
      failover: backgroundIdx > 0,
      downForMs: downFor(backgroundPref),
    },
    scannersB: null,
    metrics: null,
    lanesShareEndpoint: lanesShareProviderOrKey(),
    supports: {
      classicShare: false as const,
      multiLane: false as const,
      simple2Lane: false as const,
      sixThree: false as const,
      slim3: true as const,
    },
    endpoints,
    idleBackups,
    jitoEnabled: Boolean(config.rpc?.jito?.enabled),
    priorityFeeLamports: lastPriorityFeeLamports,
    ok: anyHealthy,
    warning,
    callTraffic: getRpcCallTraffic(),
    callTrafficLast60s: getRpcCallTrafficLast60s(15),
    bootTimeline: (() => {
      try {
        const { getBootTimelineSnapshot } =
          require('./rpcBootTimeline') as typeof import('./rpcBootTimeline');
        return getBootTimelineSnapshot(80);
      } catch {
        return { processStartedAt: 0, uptimeMs: 0, recent: [] };
      }
    })(),
    bootPhase: (() => {
      try {
        const { getBootPhaseSnapshot, noteBootPhaseIfChanged } =
          require('./bootPhase') as typeof import('./bootPhase');
        noteBootPhaseIfChanged();
        return getBootPhaseSnapshot();
      } catch {
        return null;
      }
    })(),
    dashboard_refresh_per_min: perMin(dashboardRefreshAts),
    probe_status_refresh_per_min: perMin(probeRefreshAts),
    gate,
    quarantine,
    loadControl,
    utilityWeakPublic: isUtilityOnWeakPublic(),
    heliusDisabled: false as const,
    probe_calls_per_min: probeCallsPerMin,
    feature_calls_per_min: featureCallsPerMin,
    health_page_refresh_calls_per_min: healthPageRefreshCallsPerMin,
    watcher_polls_per_min: watcherPolls.total,
    dip_watcher_polls_per_min: watcherPolls.dip,
    trend_watcher_polls_per_min: watcherPolls.trend,
    majors_watcher_polls_per_min: watcherPolls.majors,
    active_endpoints_count: activeEndpointsCount,
    background_idle_when_workloads_off: backgroundIdleWhenWorkloadsOff,
    idleIsolationActive,
    bootSettling: (() => {
      try {
        const { isBootSettling } =
          require('./bootPhase') as typeof import('./bootPhase');
        return isBootSettling();
      } catch {
        return false;
      }
    })(),
    migration_boot_deferred: (() => {
      try {
        const { isBootFeatureAllowed } =
          require('./bootPhase') as typeof import('./bootPhase');
        return !isBootFeatureAllowed('migration');
      } catch {
        return false;
      }
    })(),
    rpc_calls_last_60s: (() => {
      pruneCallTrafficWindow();
      return callTrafficEvents.length;
    })(),
    heap_used_mb: heapUsedMb(),
    active_timers_count: activeTimersCount(),
    top_queue_sizes: Object.entries(getRpcQueueSizeSnapshot())
      .map(([name, size]) => ({ name, size: Number(size) || 0 }))
      .sort((a, b) => b.size - a.size)
      .slice(0, 8),
    ...(() => {
      try {
        const t = getIdleRpcTraceSnapshot();
        return {
          top_callers_when_workloads_off: t.top_callers_when_workloads_off,
        };
      } catch {
        return {
          top_callers_when_workloads_off: [] as Array<{
            label: string;
            count: number;
            method: string;
            lastAt: number;
          }>,
        };
      }
    })(),
    controlPlaneThrash,
    ...(() => {
      try {
        const { getHeavyJobSnapshot } =
          require('./heavyJobScheduler') as typeof import('./heavyJobScheduler');
        const h = getHeavyJobSnapshot();
        return {
          heavyJobs: h,
          heavy_job_running: h.heavy_job_running,
          heavy_job_deferred: h.heavy_job_deferred,
          last_heavy_collision_avoided: h.last_heavy_collision_avoided,
          endpoint_pressure_by_lane: h.endpoint_pressure_by_lane,
        };
      } catch {
        return {
          heavyJobs: null,
          heavy_job_running: null as string | null,
          heavy_job_deferred: 0,
          last_heavy_collision_avoided: null,
          endpoint_pressure_by_lane: null,
        };
      }
    })(),
    laneAssignments: asg,
    lanes: {
      trading: {
        label: tActive?.endpoint.label || (tradingPref ? tradingPref.endpoint.label : 'none'),
        url: tActive?.endpoint.url || '',
        healthy: tradingPref ? Boolean(tActive?.healthy) : false,
        latencyMs: tradingEwmaRecovered
          ? tActive?.probeLatencyMs ?? tActive?.latencyMs ?? null
          : null,
        callLatencyMs: tActive?.latencyMs ?? null,
        probeLatencyMs: tradingEwmaRecovered
          ? tActive?.probeLatencyMs ?? null
          : null,
        successRate: successRate(tActive),
        active: Boolean(tradingPref || emergencyPublic),
        mainId: asg.trading.main,
        emergencyId: asg.trading.emergency,
        onEmergency: tradingOnEmergency,
        congestion: !tradingPref
          ? {
              state: 'disabled' as const,
              cause: 'Trading Main unassigned',
              details: ['assign in Stats → RPC'],
            }
          : tradingCong,
      },
      data: {
        label: dActive?.endpoint.label || (dataPref ? dataPref.endpoint.label : 'none'),
        url: dActive?.endpoint.url || '',
        healthy: dataPref ? Boolean(dActive?.healthy) : false,
        latencyMs: dataEwmaRecovered
          ? dActive?.probeLatencyMs ?? dActive?.latencyMs ?? null
          : null,
        callLatencyMs: dActive?.latencyMs ?? null,
        probeLatencyMs: dataEwmaRecovered
          ? dActive?.probeLatencyMs ?? null
          : null,
        successRate: successRate(dActive),
        active: Boolean(dataPref || dataFailover),
        mainId: asg.data.main,
        emergencyId: asg.data.emergency,
        onEmergency: dataOnEmergency,
        congestion: !dataPref
          ? {
              state: 'disabled' as const,
              cause: 'Data Main unassigned',
              details: ['assign in Stats → RPC'],
            }
          : dataCong,
      },
      background: {
        label: backgroundIdleWhenWorkloadsOff
          ? 'idle'
          : bActive?.endpoint.label || (backgroundPref ? backgroundPref.endpoint.label : 'none'),
        url: backgroundIdleWhenWorkloadsOff ? '' : bActive?.endpoint.url || '',
        healthy: backgroundIdleWhenWorkloadsOff
          ? true
          : Boolean(bActive?.healthy),
        latencyMs: backgroundIdleWhenWorkloadsOff
          ? null
          : bActive?.probeLatencyMs ?? bActive?.latencyMs ?? null,
        callLatencyMs: backgroundIdleWhenWorkloadsOff
          ? null
          : bActive?.latencyMs ?? null,
        probeLatencyMs: backgroundIdleWhenWorkloadsOff
          ? null
          : bActive?.probeLatencyMs ?? null,
        successRate: backgroundIdleWhenWorkloadsOff
          ? 100
          : successRate(bActive),
        active: bgFeatureOn,
        mainId: asg.background.main,
        emergencyId: asg.background.emergency,
        onEmergency: backgroundOnEmergency,
        congestion: bgCong,
      },
      emergency: {
        label: (() => {
          const parts: string[] = [];
          if (tradingOnEmergency) parts.push('Trading');
          if (dataOnEmergency) parts.push('Data');
          if (backgroundOnEmergency) parts.push('Background');
          if (!parts.length) {
            return eActive?.endpoint.label
              ? `${eActive.endpoint.label} · idle`
              : 'none assigned';
          }
          return `active: ${parts.join(', ')}`;
        })(),
        url: eActive?.endpoint.url || '',
        healthy: Boolean(eActive?.healthy),
        latencyMs: eActive?.probeLatencyMs ?? eActive?.latencyMs ?? null,
        callLatencyMs: eActive?.latencyMs ?? null,
        probeLatencyMs: eActive?.probeLatencyMs ?? null,
        successRate: successRate(eActive),
        active: tradingOnEmergency || dataOnEmergency || backgroundOnEmergency,
        congestion: emergCong,
      },
      helius: {
        disabled: false as const,
        label: dataPref?.endpoint.label || 'data-main',
        congestion: {
          state: 'ok' as const,
          cause: 'Data lane = UI-assigned Main',
          details: [dataPref?.endpoint.label || asg.data.main || 'none'].filter(
            Boolean
          ),
        },
      },
    },
    workloads: (() => {
      try {
        const { getRpcWorkloadSnapshot } =
          require('./rpcWorkloadControl') as typeof import('./rpcWorkloadControl');
        return getRpcWorkloadSnapshot();
      } catch {
        return [];
      }
    })(),
    workloadGroups: (() => {
      try {
        const { getRpcWorkloadGroupSnapshot } =
          require('./rpcWorkloadControl') as typeof import('./rpcWorkloadControl');
        return getRpcWorkloadGroupSnapshot();
      } catch {
        return [];
      }
    })(),
  };
}

let lastPriorityFeeLamports: number | null = null;

export async function estimatePriorityFeeMicroLamports(
  sampleAccount?: PublicKey
): Promise<number> {
  const min = config.rpc?.priorityFee?.minMicroLamports ?? 1_000;
  const max = config.rpc?.priorityFee?.maxMicroLamports ?? 500_000;
  const fallback = config.rpc?.priorityFee?.defaultMicroLamports ?? 50_000;

  try {
    return await runWithRpcRole(
      'primary',
      async () => {
        const conn = getConnection();
        const account =
          sampleAccount ??
          getWalletPublicKey() ??
          new PublicKey('11111111111111111111111111111111');

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
            const idx = Math.min(
              sorted.length - 1,
              Math.floor(sorted.length * 0.75)
            );
            const estimated = Math.max(
              min,
              Math.min(max, sorted[idx] || fallback)
            );
            lastPriorityFeeLamports = Math.ceil(
              (estimated * 200_000) / 1_000_000
            );
            console.log(
              `[rpc] Priority fee ~${estimated} µLamports/CU (est. ${lastPriorityFeeLamports} lamports)`
            );
            return estimated;
          }
        }
        lastPriorityFeeLamports = Math.ceil((fallback * 200_000) / 1_000_000);
        return fallback;
      },
      'priority_fee'
    );
  } catch (err) {
    console.warn(
      '[rpc] Priority fee estimate failed, using default:',
      err instanceof Error ? err.message : err
    );
  }

  lastPriorityFeeLamports = Math.ceil((fallback * 200_000) / 1_000_000);
  return fallback;
}

export async function sendOptimizedTransaction(
  serialized: Uint8Array,
  options: SendOptions = {}
): Promise<string> {
  return withRpc(
    'sendRawTransaction',
    async (conn) => {
      const sig = await conn.sendRawTransaction(serialized, {
        skipPreflight: options.skipPreflight ?? false,
        maxRetries: options.maxRetries ?? 3,
        preflightCommitment: 'confirmed',
      });
      await confirmSignatureHttp(conn, sig);
      return sig;
    },
    'primary'
  );
}

export async function sendAndConfirmVersioned(
  vtx: VersionedTransaction
): Promise<string> {
  return sendOptimizedTransaction(vtx.serialize());
}

export async function sendAndConfirmLegacyTx(tx: Transaction): Promise<string> {
  return withRpc(
    'sendLegacy',
    async (conn) => {
      const { blockhash, lastValidBlockHeight } =
        await conn.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      const raw = tx.serialize();
      const sig = await conn.sendRawTransaction(raw, {
        skipPreflight: false,
        maxRetries: 3,
      });
      await confirmSignatureHttp(conn, sig);
      return sig;
    },
    'primary'
  );
}

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

export function clearKeypairCache(walletId?: string): void {
  if (walletId) keypairCache.delete(walletId);
  else keypairCache.clear();
}

export function getWalletPublicKey(walletId?: string): PublicKey | null {
  return getKeypair(walletId)?.publicKey ?? null;
}

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
    const lamports = await runWithRpcRole(
      'primary',
      () =>
        withRpc('getBalance', (conn) => conn.getBalance(pubkey), 'primary'),
      'live_balance'
    );
    return lamports / LAMPORTS_PER_SOL;
  } catch (err) {
    console.error('[connection] Failed to fetch balance:', err);
    return null;
  }
}

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
      if (publicKey) balanceSol = await getLiveBalanceSol(slot.id);
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
  try {
    const { isRpcWorkloadEnabled } =
      require('./rpcWorkloadControl') as typeof import('./rpcWorkloadControl');
    if (!isRpcWorkloadEnabled('health_probe') || featuresOffNow() || idleIsolationActive) {
      console.warn(
        '[connection] testConnection skipped — health_probe OFF or idle isolation'
      );
      return true;
    }
  } catch {
    /* */
  }
  if (shouldSkipTradingGetSlot()) {
    console.log('[connection] Skipping Trading getSlot — warming (uptime < 60s)');
    return true;
  }
  const pref = tradingPref;
  if (!pref) {
    console.error('[connection] No Trading RPC configured');
    return false;
  }
  const ok = await probeState(pref, 6_000);
  if (ok) {
    console.log(
      `[connection] RPC OK — ${pref.endpoint.label} latency ${pref.latencyMs}ms`
    );
    return true;
  }
  for (const st of emergencyChain()) {
    const retry = await probeState(st, 6_000);
    if (retry) {
      tradingHop = 1;
      console.log(
        `[connection] RPC OK after failover → ${st.endpoint.label}`
      );
      return true;
    }
  }
  console.error('[connection] RPC health check failed');
  return false;
}

export async function probeRpcRecovery(): Promise<ReturnType<typeof getRpcStats>> {
  ensureEndpoints();
  startRpcHealthMonitor();
  try {
    const { isRpcWorkloadEnabled } =
      require('./rpcWorkloadControl') as typeof import('./rpcWorkloadControl');
    if (
      !isRpcWorkloadEnabled('health_probe') ||
      featuresOffNow() ||
      idleIsolationActive
    ) {
      console.warn(
        '[rpc] probeRpcRecovery skipped — health_probe OFF or idle isolation'
      );
      return getRpcStats();
    }
  } catch {
    /* */
  }
  const probeList: EndpointState[] = [];
  if (tradingPref && !shouldSkipTradingGetSlot()) probeList.push(tradingPref);
  if (dataPref) probeList.push(dataPref);
  if (wantBackgroundHot() && backgroundPref) probeList.push(backgroundPref);
  if (tradingHop >= 1 && emergencyPublic) probeList.push(emergencyPublic);
  for (const st of probeList) {
    await probeState(st, 8_000);
    await new Promise((r) => setTimeout(r, 150));
  }
  if (tradingHop > 0 && usable(tradingPref)) {
    tradingHop = 0;
    tradingRecoverAt = 0;
    console.log('[rpc] Trading recovered via probe → Alchemy');
  }
  return getRpcStats();
}

function healthProbeDueMs(): number {
  try {
    if (allFeatureWorkloadsOff()) return HEALTH_PROBE_FEATURES_OFF_MS;
  } catch {
    /* */
  }
  return Math.max(
    HEALTH_PROBE_NORMAL_MS,
    config.rpc?.healthIntervalMs ?? HEALTH_PROBE_NORMAL_MS
  );
}

export function startRpcHealthMonitor(): void {
  if (started) return;
  started = true;
  ensureEndpoints();

  const tick = async () => {
    try {
      // Hard pause: all feature workloads OFF → zero probe traffic (even if health_probe ON).
      if (featuresOffNow() || idleIsolationActive) return;
      try {
        const { isRpcWorkloadEnabled } =
          require('./rpcWorkloadControl') as typeof import('./rpcWorkloadControl');
        if (!isRpcWorkloadEnabled('health_probe')) return;
      } catch {
        /* */
      }
      const due = healthProbeDueMs();
      const now = Date.now();
      if (lastHealthProbeAt && now - lastHealthProbeAt < due) return;
      lastHealthProbeAt = now;

      // One lightweight getSlot per active lane only — skip rate-limited endpoints.
      // Skip Trading getSlot for first 60s (cold TLS seeds a ghost EWMA / false panic).
      if (
        tradingPref &&
        !isHardFailed(tradingPref) &&
        !isRateLimited(tradingPref) &&
        !shouldSkipTradingGetSlot()
      ) {
        await probeState(tradingPref, 8_000);
      }
      if (dataPref && !isHardFailed(dataPref) && !isRateLimited(dataPref)) {
        await probeState(dataPref, 8_000);
      }
      if (
        wantBackgroundHot() &&
        backgroundPref &&
        !isHardFailed(backgroundPref) &&
        !isRateLimited(backgroundPref)
      ) {
        await probeState(backgroundPref, 8_000);
      }
      // Emergency only when Trading already failed over onto it.
      if (
        tradingHop >= 1 &&
        emergencyPublic &&
        !isHardFailed(emergencyPublic) &&
        !isRateLimited(emergencyPublic)
      ) {
        await probeState(emergencyPublic, 6_000);
      }
      if (tradingHop > 0 && usable(tradingPref)) {
        if (!tradingRecoverAt) tradingRecoverAt = Date.now() + TRADING_RECOVER_MS;
        if (Date.now() >= tradingRecoverAt) {
          tradingHop = 0;
          tradingRecoverAt = 0;
          console.log('[rpc] Trading healthy again → Alchemy');
        }
      }
    } catch (err) {
      console.warn(
        '[rpc] health tick error:',
        err instanceof Error ? err.message : err
      );
    }
  };

  void tick();
  healthTimer = setInterval(() => void tick(), HEALTH_TICK_CHECK_MS);
}

export function stopRpcHealthMonitor(): void {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  started = false;
}
