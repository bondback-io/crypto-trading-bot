/**
 * Multi-RPC connection manager with Trading / Data sticky lanes + public emergency.
 * health monitoring, cross-lane failover, priority fees, and stats.
 */

import fs from 'fs';
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
  RPC_SHARE_LOAD_SUPPORTS,
  isPublicRpcUrl,
  isQuicknodeRpcUrl,
  isOfficialMainnetBetaRpcUrl,
  isEmergencyBackupLabel,
  type RpcLaneRole,
} from './rpcUrl';
import {
  acquireRpcLane,
  getRpcGateSnapshot,
  isRpcGateSkipError,
  getFeatureInFlightCounts,
  getFeatureSkipDedupeRates60s,
} from './rpcGate';
import { monitorEventLoopDelay } from 'perf_hooks';

dotenv.config();

const DEFAULT_RPC = PUBLIC_SOLANA_RPC;

/** Workload lane — primary=Trading; secondary=Data; utility=legacy alias → Data */
export type RpcRole = 'primary' | 'secondary' | 'utility';

export interface RpcEndpoint {
  url: string;
  label: string;
  /** Optional dedicated websocket URL */
  wsUrl?: string;
  role?: RpcLaneRole;
}

export interface RpcEndpointStats {
  url: string;
  label: string;
  role: RpcLaneRole;
  healthy: boolean;
  latencyMs: number | null;
  /** Latest single-call sample (may spike); UI prefers latencyMs EWMA */
  lastCallLatencyMs?: number | null;
  successCount: number;
  failureCount: number;
  successRate: number;
  lastError?: string;
  lastCheckedAt: number | null;
  unhealthySince: number | null;
  isActive: boolean;
  /** Lane tag for Multi-RPC table: trading | data | emergency */
  lane?: string | null;
}

interface EndpointState {
  endpoint: RpcEndpoint;
  connection: Connection;
  healthy: boolean;
  /** Smoothed latency (EWMA) — used for UI + latency soft-failover */
  latencyMs: number | null;
  /** Most recent single call latency (spikes included) */
  lastCallLatencyMs: number | null;
  successCount: number;
  failureCount: number;
  lastError?: string;
  lastCheckedAt: number | null;
  consecutiveFailures: number;
  unhealthySince: number | null;
  role: RpcLaneRole;
  /** Skip this endpoint until this time after a 429 (immediate failover). */
  rateLimitedUntil: number;
  /**
   * Hard-fail / quarantine until this time. Stop probe/retry storms
   * against dead QuickNode/fallbacks so healthy lanes stay clear.
   */
  hardFailUntil: number;
  /** Escalating quarantine streak (longer cooldown each re-entry). */
  quarantineStreak: number;
  /** Last time we logged quarantine enter/exit. */
  lastQuarantineLogAt: number;
  /** Last time we logged "marked unhealthy" for this endpoint. */
  lastUnhealthyLogAt: number;
  /** When EWMA first crossed LATENCY_STRESS_MS (null when not stressed). */
  latencyStressedSince: number | null;
  /** Last time we logged latency soft-failover. */
  lastLatencyFailoverLogAt: number;
}

let endpoints: EndpointState[] = [];
/** Preferred index for each lane */
let preferredPrimary = 0;
let preferredSecondary = 0;
let preferredUtility = 0;
/** Mid-tier paid failover (QuickNode); -1 when unset */
let preferredQuicknode = -1;
/** Emergency-only sibling indexes; -1 when unset. Never preferred lanes. */
let preferredHelius = -1;
let preferredHeliusBackup = -1;
let preferredAlchemyBackup = -1;
let preferredAlchemyBackup2 = -1;
/** Currently resolved index serving each lane (may differ after failover) */
let activePrimary = 0;
let activeSecondary = 0;
let activeUtility = 0;
/** Legacy single active pointer — mirrors primary lane for older callers */
let activeIndex = 0;

const rpcRoleAls = new AsyncLocalStorage<RpcRole>();
/** Optional feature tag for call metering (wallet_poll, health_probe, …). */
const rpcFeatureAls = new AsyncLocalStorage<string>();
/** >0 when already inside an acquired lane gate (nested runWithRpcRole). */
const rpcGateDepthAls = new AsyncLocalStorage<number>();

/** Cached keypairs by trading wallet id — secrets never leave process memory */
const keypairCache = new Map<string, Keypair>();
let healthTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

/** HTTP JSON-RPC call meter — counts real CU burn (getConnection path included). */
export type RpcCallTrafficRow = {
  endpoint: string;
  feature: string;
  method: string;
  role: RpcRole | 'unknown';
  calls: number;
  errors: number;
  totalMs: number;
  avgMs: number;
};

type CallMeterKey = string;
const callMeter = new Map<
  CallMeterKey,
  {
    endpoint: string;
    feature: string;
    method: string;
    role: RpcRole | 'unknown';
    calls: number;
    errors: number;
    totalMs: number;
  }
>();
let callMeterStartedAt = Date.now();

const CALL_WINDOW_MS = 60_000;
type RollingCallSample = {
  at: number;
  feature: string;
  method: string;
  role: string;
  ms: number;
  ok: boolean;
};
const rollingCallSamples: RollingCallSample[] = [];

let eventLoopDelay: ReturnType<typeof monitorEventLoopDelay> | null = null;
try {
  eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();
} catch {
  eventLoopDelay = null;
}

function callMeterKey(
  endpoint: string,
  feature: string,
  method: string,
  role: string
): CallMeterKey {
  return `${endpoint}|${feature}|${method}|${role}`;
}

function pruneRollingCalls(now: number): void {
  const cutoff = now - CALL_WINDOW_MS;
  let w = 0;
  for (let i = 0; i < rollingCallSamples.length; i++) {
    if (rollingCallSamples[i]!.at >= cutoff) {
      rollingCallSamples[w++] = rollingCallSamples[i]!;
    }
  }
  rollingCallSamples.length = w;
}

function recordHttpRpcCall(opts: {
  endpoint: string;
  method: string;
  ok: boolean;
  latencyMs: number;
}): void {
  const feature = rpcFeatureAls.getStore() || 'ungated';
  const role = rpcRoleAls.getStore() ?? 'unknown';
  const key = callMeterKey(opts.endpoint, feature, opts.method, role);
  let row = callMeter.get(key);
  if (!row) {
    row = {
      endpoint: opts.endpoint,
      feature,
      method: opts.method,
      role,
      calls: 0,
      errors: 0,
      totalMs: 0,
    };
    callMeter.set(key, row);
  }
  row.calls += 1;
  if (!opts.ok) row.errors += 1;
  row.totalMs += Math.max(0, opts.latencyMs);

  const now = Date.now();
  rollingCallSamples.push({
    at: now,
    feature,
    method: opts.method,
    role: String(role),
    ms: Math.max(0, opts.latencyMs),
    ok: opts.ok,
  });
  if (rollingCallSamples.length > 6_000) pruneRollingCalls(now);
}

export type RpcCallerInventoryRow = {
  feature: string;
  callsPerMin: number;
  inFlight: number;
  avgLatencyMs: number;
  skipsPerMin: number;
  dedupesPerMin: number;
};

/** Top RPC sources by rolling 60s calls/min (inventory for congestion diagnosis). */
export function getRpcCallerInventory(limit = 10): {
  windowMs: number;
  top: RpcCallerInventoryRow[];
} {
  const now = Date.now();
  pruneRollingCalls(now);
  const byFeat = new Map<
    string,
    { calls: number; totalMs: number }
  >();
  for (const s of rollingCallSamples) {
    const row = byFeat.get(s.feature) || { calls: 0, totalMs: 0 };
    row.calls += 1;
    row.totalMs += s.ms;
    byFeat.set(s.feature, row);
  }
  const inflight = getFeatureInFlightCounts();
  const rates = getFeatureSkipDedupeRates60s();
  const top: RpcCallerInventoryRow[] = [];
  for (const [feature, row] of byFeat) {
    top.push({
      feature,
      callsPerMin: Math.round((row.calls / (CALL_WINDOW_MS / 60_000)) * 10) / 10,
      inFlight: inflight[feature] || 0,
      avgLatencyMs: row.calls ? Math.round(row.totalMs / row.calls) : 0,
      skipsPerMin:
        Math.round(((rates.skips[feature] || 0) / (CALL_WINDOW_MS / 60_000)) * 10) /
        10,
      dedupesPerMin:
        Math.round(
          ((rates.dedupes[feature] || 0) / (CALL_WINDOW_MS / 60_000)) * 10
        ) / 10,
    });
  }
  // Include features that only appear as skips/inflight with zero calls.
  for (const feature of new Set([
    ...Object.keys(inflight),
    ...Object.keys(rates.skips),
    ...Object.keys(rates.dedupes),
  ])) {
    if (byFeat.has(feature)) continue;
    top.push({
      feature,
      callsPerMin: 0,
      inFlight: inflight[feature] || 0,
      avgLatencyMs: 0,
      skipsPerMin:
        Math.round(((rates.skips[feature] || 0) / (CALL_WINDOW_MS / 60_000)) * 10) /
        10,
      dedupesPerMin:
        Math.round(
          ((rates.dedupes[feature] || 0) / (CALL_WINDOW_MS / 60_000)) * 10
        ) / 10,
    });
  }
  top.sort(
    (a, b) =>
      b.callsPerMin - a.callsPerMin ||
      b.inFlight - a.inFlight ||
      b.skipsPerMin - a.skipsPerMin
  );
  return {
    windowMs: CALL_WINDOW_MS,
    top: top.slice(0, Math.max(1, limit)),
  };
}

const BOTTLENECK_DEBUG_SESSION = '06c3b9';
const bottleneckDebugRing: Array<Record<string, unknown>> = [];

function noteBottleneckDebug(entry: Record<string, unknown>): void {
  bottleneckDebugRing.push(entry);
  while (bottleneckDebugRing.length > 24) bottleneckDebugRing.shift();
  try {
    const { dataFile, ensureDataDir } =
      require('./dataDir') as typeof import('./dataDir');
    ensureDataDir();
    fs.appendFileSync(
      dataFile('rpc-bottleneck-debug.ndjson'),
      JSON.stringify(entry) + '\n',
      'utf8'
    );
  } catch {
    /* */
  }
  try {
    console.warn(
      `[rpc-debug] ${String(entry.message || 'snap')} ` +
        JSON.stringify(entry.data || {}).slice(0, 400)
    );
  } catch {
    /* */
  }
  fetch('http://127.0.0.1:7710/ingest/4a93e060-3c93-430c-865a-86d3cc897ce8', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Debug-Session-Id': BOTTLENECK_DEBUG_SESSION,
    },
    body: JSON.stringify(entry),
  }).catch(() => {});
}

export function getBottleneckDebugRing(limit = 12): Array<Record<string, unknown>> {
  return bottleneckDebugRing.slice(-Math.max(1, limit));
}

export function getProcessHealthSnapshot(): {
  queueDepth: number;
  backlog: number;
  bgSkips60s: number;
  loopDelayMs: number | null;
  scannersEwmaMs: number | null;
} {
  const gate = getRpcGateSnapshot();
  const rates = getFeatureSkipDedupeRates60s();
  let scannersEwmaMs: number | null = null;
  try {
    const { getLastSecondaryLatencyMs } =
      require('./rpcLoadControl') as typeof import('./rpcLoadControl');
    scannersEwmaMs = getLastSecondaryLatencyMs();
  } catch {
    /* */
  }
  let loopDelayMs: number | null = null;
  if (eventLoopDelay) {
    try {
      loopDelayMs = Math.round(eventLoopDelay.mean / 1e6);
      eventLoopDelay.reset();
    } catch {
      loopDelayMs = null;
    }
  }
  return {
    queueDepth:
      gate.lanes.primary.queued +
      gate.lanes.secondary.queued +
      gate.lanes.utility.queued,
    backlog: gate.backlog,
    bgSkips60s: rates.bgSkips60s,
    loopDelayMs,
    scannersEwmaMs,
  };
}

// #region agent log helper used by getRpcStats
function emitRpcBottleneckSnapshot(payload: {
  summary: string;
  degradedBy: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lanes: any;
  gate: ReturnType<typeof getRpcGateSnapshot>;
  loadControl: ReturnType<
    typeof import('./rpcLoadControl').getRpcLoadControlSnapshot
  > | null;
}): void {
  const nowDbg = Date.now();
  if (!(globalThis as { __dbgRpcSnapAt?: number }).__dbgRpcSnapAt) {
    (globalThis as { __dbgRpcSnapAt?: number }).__dbgRpcSnapAt = 0;
  }
  if (
    nowDbg - ((globalThis as { __dbgRpcSnapAt?: number }).__dbgRpcSnapAt || 0) >
    8_000
  ) {
    (globalThis as { __dbgRpcSnapAt?: number }).__dbgRpcSnapAt = nowDbg;
    const inv = getRpcCallerInventory(8);
    const ph = getProcessHealthSnapshot();
    const lanes = payload.lanes;
    const gate = payload.gate;
    const loadControl = payload.loadControl;
    noteBottleneckDebug({
      sessionId: BOTTLENECK_DEBUG_SESSION,
      runId: process.env.RENDER ? 'render-live' : 'post-fix',
      hypothesisId: 'H1-H5',
      location: 'connection.ts:getRpcStats',
      message: 'rpc_bottleneck_snapshot',
      data: {
        summary: payload.summary,
        degradedBy: payload.degradedBy,
        onRender: Boolean(process.env.RENDER),
        crit: {
          label: lanes.critical.activeLabel,
          pref: lanes.critical.preferredLabel,
          lat: lanes.critical.latencyMs,
          prefLat: lanes.critical.preferredLatencyMs,
          fo: lanes.critical.failover,
          configured: lanes.critical.configured,
        },
        scan: {
          label: lanes.scanners.activeLabel,
          lat: lanes.scanners.latencyMs,
          prefLat: lanes.scanners.preferredLatencyMs,
          configured: lanes.scanners.configured,
        },
        util: {
          label: lanes.utility.activeLabel,
          pref: lanes.utility.preferredLabel,
          lat: lanes.utility.latencyMs,
          prefLat: lanes.utility.preferredLatencyMs,
          fo: lanes.utility.failover,
        },
        gate: {
          p: `${gate.lanes.primary.inFlight}/${gate.lanes.primary.maxConcurrent}q${gate.lanes.primary.queued}sk${gate.lanes.primary.skipped}`,
          s: `${gate.lanes.secondary.inFlight}/${gate.lanes.secondary.maxConcurrent}q${gate.lanes.secondary.queued}sk${gate.lanes.secondary.skipped}rate${gate.lanes.secondary.hitRateLimit}`,
          u: `${gate.lanes.utility.inFlight}/${gate.lanes.utility.maxConcurrent}q${gate.lanes.utility.queued}`,
          secReasons: gate.lanes.secondary.skippedByReason,
        },
        top: inv.top.slice(0, 6),
        process: ph,
        signalsHealthy: loadControl?.signalsRpcHealthy ?? null,
        scannerX: loadControl?.scannerSlowFactor ?? null,
        utilityX: loadControl?.utilitySlowFactor ?? null,
      },
      timestamp: nowDbg,
    });
  }
}
// #endregion


export function getRpcCallTraffic(limit = 40): {
  sinceMs: number;
  totalCalls: number;
  byEndpoint: Record<string, number>;
  byFeature: Record<string, number>;
  top: RpcCallTrafficRow[];
} {
  const top: RpcCallTrafficRow[] = [];
  const byEndpoint: Record<string, number> = {};
  const byFeature: Record<string, number> = {};
  let totalCalls = 0;
  for (const row of callMeter.values()) {
    totalCalls += row.calls;
    byEndpoint[row.endpoint] = (byEndpoint[row.endpoint] || 0) + row.calls;
    byFeature[row.feature] = (byFeature[row.feature] || 0) + row.calls;
    top.push({
      ...row,
      avgMs: row.calls ? Math.round(row.totalMs / row.calls) : 0,
    });
  }
  top.sort((a, b) => b.calls - a.calls);
  return {
    sinceMs: Date.now() - callMeterStartedAt,
    totalCalls,
    byEndpoint,
    byFeature,
    top: top.slice(0, Math.max(1, limit)),
  };
}

function parseRpcMethodsFromBody(body: unknown): string[] {
  try {
    let raw = '';
    if (typeof body === 'string') raw = body;
    else if (body != null && typeof (body as { toString?: () => string }).toString === 'function') {
      raw = String(body);
    }
    if (!raw) return ['unknown'];
    const parsed = JSON.parse(raw) as
      | { method?: string }
      | Array<{ method?: string }>;
    if (Array.isArray(parsed)) {
      const methods = parsed
        .map((p) => p?.method)
        .filter((m): m is string => Boolean(m));
      return methods.length ? methods : ['batch'];
    }
    return [parsed?.method || 'unknown'];
  } catch {
    return ['unknown'];
  }
}

function rpcHttpTimeoutMs(): number {
  const raw = process.env.RPC_HTTP_TIMEOUT_MS;
  const n = raw != null && raw !== '' ? Number(raw) : NaN;
  if (Number.isFinite(n)) return Math.max(4_000, Math.min(30_000, Math.round(n)));
  return 12_000;
}

function mergeAbortSignals(signals: AbortSignal[]): AbortSignal {
  const filtered = signals.filter(Boolean);
  if (filtered.length === 1) return filtered[0]!;
  const anyFn = (
    AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }
  ).any;
  if (typeof anyFn === 'function') return anyFn.call(AbortSignal, filtered);
  const ctrl = new AbortController();
  for (const s of filtered) {
    if (s.aborted) {
      ctrl.abort((s as AbortSignal & { reason?: unknown }).reason);
      return ctrl.signal;
    }
    s.addEventListener(
      'abort',
      () => ctrl.abort((s as AbortSignal & { reason?: unknown }).reason),
      { once: true }
    );
  }
  return ctrl.signal;
}

function meteredFetch(endpointLabel: string) {
  const baseFetch = globalThis.fetch.bind(globalThis);
  return async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const methods = parseRpcMethodsFromBody(init?.body);
    const t0 = Date.now();
    const timeoutMs = rpcHttpTimeoutMs();
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal
      ? mergeAbortSignals([init.signal, timeoutSignal])
      : timeoutSignal;
    let ok = false;
    try {
      const res = await baseFetch(input, { ...init, signal });
      ok = res.ok;
      const latencyMs = Date.now() - t0;
      for (const method of methods) {
        recordHttpRpcCall({
          endpoint: endpointLabel,
          method,
          ok,
          latencyMs,
        });
      }
      // Drive lane EWMA from real JSON-RPC traffic (not only health probes).
      const idx = endpoints.findIndex(
        (e) => e.endpoint.label === endpointLabel
      );
      if (idx >= 0) {
        if (ok) recordSuccess(idx, latencyMs);
        else recordFailure(idx, `HTTP ${res.status}`);
      }
      return res;
    } catch (err) {
      const latencyMs = Date.now() - t0;
      for (const method of methods) {
        recordHttpRpcCall({
          endpoint: endpointLabel,
          method,
          ok: false,
          latencyMs,
        });
      }
      const idx = endpoints.findIndex(
        (e) => e.endpoint.label === endpointLabel
      );
      if (idx >= 0) {
        recordFailure(
          idx,
          err instanceof Error ? err.message : String(err)
        );
      }
      const name = err instanceof Error ? err.name : '';
      const msg = err instanceof Error ? err.message : String(err);
      if (
        timeoutSignal.aborted ||
        name === 'TimeoutError' ||
        name === 'AbortError' ||
        /aborted|timeout/i.test(msg)
      ) {
        throw new Error(
          `RPC timeout after ${Math.round(timeoutMs / 1000)}s (${endpointLabel})`
        );
      }
      throw err;
    }
  };
}

/** Default cross-lane piggyback grace — preferred must stay unhealthy this long. */
const DEFAULT_FAILOVER_DOWN_MS = 30_000;
/** Floor so env typos cannot collapse failover to zero. */
const MIN_FAILOVER_DOWN_MS = 5_000;
/** After a 429, leave the hot endpoint alone so failover can breathe. */
const RATE_LIMIT_COOLDOWN_MS = 60_000;
/** Dead/failing endpoints: base quarantine (escalates with streak). */
const HARD_FAIL_COOLDOWN_MS = 5 * 60_000;
const HARD_FAIL_COOLDOWN_MAX_MS = 20 * 60_000;
/** Cap withRpc endpoint walks — avoid retry storms across every fallback. */
const WITH_RPC_MAX_ATTEMPTS_CRITICAL = 4;
const WITH_RPC_MAX_ATTEMPTS_OTHER = 3;
/** Don't re-log "marked unhealthy" more often than this. */
const UNHEALTHY_LOG_THROTTLE_MS = 15_000;
/** EWMA weight for new samples — dampens single getTransaction spikes in the UI. */
const LATENCY_EWMA_ALPHA = 0.22;
/** EWMA above this → start latency-stress timer (matches rpcDiagnostic). */
const LATENCY_STRESS_MS = 500;
/** EWMA below this → clear latency stress (hysteresis). */
const LATENCY_RECOVER_MS = 320;
/**
 * Soft hop among Alchemy siblings only (never Helius) when Critical EWMA stays hot.
 * Helius requires hard failover (429 / unhealthy ≥ failoverDownMs).
 */
const ALCHEMY_SIBLING_STRESS_MS = 450;
const ALCHEMY_SIBLING_RECOVER_MS = 320;
const ALCHEMY_SIBLING_GRACE_MS = 8_000;
/**
 * Utility may soft-fail onto QuickNode only when preferred EWMA is this hot
 * (after public/fallback alternatives) and QN is not already serving Critical/Scanners.
 */
const UTILITY_QUICKNODE_STRESS_MS = 1000;
/** Prefer piggyback after preferred stays latency-stressed this long. */
const LATENCY_STRESS_GRACE_MS = 15_000;
/** Public Solana is often chronically slow from cloud hosts — fail over sooner. */
const LATENCY_STRESS_GRACE_PUBLIC_MS = 5_000;
/** Don't re-log latency piggyback more often than this. */
const LATENCY_FAILOVER_LOG_THROTTLE_MS = 45_000;

function hasAlchemySiblingFailover(): boolean {
  return (
    (preferredSecondary >= 0 && preferredSecondary !== preferredPrimary) ||
    preferredAlchemyBackup2 >= 0
  );
}

function isPreferredCriticalState(state: EndpointState | undefined): boolean {
  return Boolean(state && endpoints[preferredPrimary] === state);
}

function latencyStressThresholdMs(state: EndpointState | undefined): number {
  // Soft hop threshold only for Alchemy↔Alchemy sibling failover — never for Helius.
  if (hasAlchemySiblingFailover() && isPreferredCriticalState(state)) {
    const pref = endpoints[preferredPrimary];
    if (pref && isAlchemyEndpoint(pref) && !isHeliusEndpoint(pref)) {
      return ALCHEMY_SIBLING_STRESS_MS;
    }
  }
  return LATENCY_STRESS_MS;
}

function latencyRecoverThresholdMs(state: EndpointState | undefined): number {
  if (hasAlchemySiblingFailover() && isPreferredCriticalState(state)) {
    const pref = endpoints[preferredPrimary];
    if (pref && isAlchemyEndpoint(pref) && !isHeliusEndpoint(pref)) {
      return ALCHEMY_SIBLING_RECOVER_MS;
    }
  }
  return LATENCY_RECOVER_MS;
}

function latencyStressGraceMs(state: EndpointState | undefined): number {
  if (state && isPublicRpcUrl(state.endpoint.url)) {
    return LATENCY_STRESS_GRACE_PUBLIC_MS;
  }
  if (hasAlchemySiblingFailover() && isPreferredCriticalState(state)) {
    const pref = endpoints[preferredPrimary];
    if (pref && isAlchemyEndpoint(pref) && !isHeliusEndpoint(pref)) {
      return ALCHEMY_SIBLING_GRACE_MS;
    }
  }
  return LATENCY_STRESS_GRACE_MS;
}

/**
 * True 429 / provider rate-limit signals only.
 * Do NOT treat connect timeouts / generic "fetch failed" as rate limits —
 * that applied a 60s probe blackout and, combined with stressed-gate skip of
 * non-active endpoints, left preferred lanes sticky-DOWN for hours while
 * the hosts were fine.
 */
function isRpcRateLimitMessage(error: string): boolean {
  return /429|rate.?limit|-32429|too many requests/i.test(error);
}

function isEndpointRateLimited(state: EndpointState | undefined): boolean {
  return Boolean(state && state.rateLimitedUntil > Date.now());
}

function isEndpointHardFailed(state: EndpointState | undefined): boolean {
  return Boolean(state && state.hardFailUntil > Date.now());
}

function quarantineMsFor(state: EndpointState): number {
  const streak = Math.max(1, state.quarantineStreak || 1);
  return Math.min(
    HARD_FAIL_COOLDOWN_MAX_MS,
    HARD_FAIL_COOLDOWN_MS * Math.pow(2, Math.min(3, streak - 1))
  );
}

function enterQuarantine(state: EndpointState, reason: string): void {
  const wasQuarantined = state.hardFailUntil > Date.now();
  if (!wasQuarantined) {
    state.quarantineStreak = Math.min(8, (state.quarantineStreak || 0) + 1);
  }
  const ms = quarantineMsFor(state);
  state.hardFailUntil = Date.now() + ms;
  state.healthy = false;
  const now = Date.now();
  if (now - state.lastQuarantineLogAt >= 15_000) {
    state.lastQuarantineLogAt = now;
    console.warn(
      `[rpc-quarantine] ENTER ${state.endpoint.label} for ${Math.round(ms / 1000)}s ` +
        `(streak ${state.quarantineStreak}) — ${reason}`
    );
    try {
      const { requestZionSupervisionEventCheck } =
        require('./zionSupervision') as typeof import('./zionSupervision');
      requestZionSupervisionEventCheck('rpc_quarantine');
    } catch {
      /* optional */
    }
  }
}

/** Official mainnet-beta / publicnode — chronically slow from cloud hosts. */
export function isWeakPublicUtilityUrl(url: string | null | undefined): boolean {
  const u = (url || '').toLowerCase();
  if (!u) return true;
  if (isOfficialMainnetBetaRpcUrl(u)) return true;
  if (u.includes('publicnode.com')) return true;
  if (!isPublicRpcUrl(u)) return false;
  // Keyed / paid hosts are not "weak public" even if classified public by mistake.
  if (
    u.includes('helius') ||
    u.includes('alchemy') ||
    u.includes('quiknode') ||
    u.includes('quicknode') ||
    u.includes('triton') ||
    u.includes('rpcpool')
  ) {
    return false;
  }
  return true;
}

/**
 * True when the Utility lane is actively on a weak public endpoint
 * (favourites/activity should slow hard).
 */
export function isUtilityOnWeakPublic(): boolean {
  // Favourites ride Data (Alchemy) — weak-public Utility noise removed.
  return false;
}

/** Paid / emergency keys must never serve Utility (Favourites / soft-watch). */
function isForbiddenUtilityEndpoint(
  state: EndpointState | undefined,
  index: number
): boolean {
  if (!state) return true;
  if (index === preferredPrimary || index === preferredSecondary) return true;
  if (isHeliusEndpoint(state)) return true;
  if (isAlchemyEndpoint(state)) return true;
  if (isEmergencyBackupIndex(index) || isEmergencyBackupLabel(state.endpoint.label)) {
    return true;
  }
  if (
    state.endpoint.label === 'quicknode' ||
    isQuicknodeRpcUrl(state.endpoint.url)
  ) {
    return true;
  }
  return false;
}

/**
 * Stronger utility candidate: public / Triton rpc-url that is not weak —
 * never Helius, Alchemy, Critical, Scanners, or emergency backups.
 */
function isStrongUtilityEndpoint(
  state: EndpointState | undefined,
  index = -1
): boolean {
  if (!state) return false;
  if (index >= 0 && isForbiddenUtilityEndpoint(state, index)) return false;
  if (isHeliusEndpoint(state) || isAlchemyEndpoint(state)) return false;
  if (isWeakPublicUtilityUrl(state.endpoint.url)) return false;
  if (isEndpointHardFailed(state) || isEndpointRateLimited(state)) return false;
  const label = (state.endpoint.label || '').toLowerCase();
  if (state.role === 'utility') {
    // Dedicated utility must still be public-ish (not a mis-tagged paid key).
    return (
      isPublicRpcUrl(state.endpoint.url) ||
      label === 'rpc-url' ||
      label === 'publicnode' ||
      label === 'utility'
    );
  }
  if (label === 'rpc-url') {
    return (
      isPublicRpcUrl(state.endpoint.url) ||
      !state.endpoint.url.toLowerCase().includes('helius')
    ) && !isAlchemyEndpoint(state) && !isHeliusEndpoint(state);
  }
  // Never promote role=fallback (Helius/Alchemy/QN) into Utility.
  return false;
}

let loggedHeliusRemovedFromUtility = false;

function pickPreferredUtilityIndex(): number {
  const wouldHaveBeenHelius = (): boolean => {
    for (let i = 0; i < endpoints.length; i++) {
      const e = endpoints[i];
      if (!e) continue;
      if (isWeakPublicUtilityUrl(e.endpoint.url)) continue;
      if (isEndpointHardFailed(e) || isEndpointRateLimited(e)) continue;
      if (e.role === 'fallback' && isHeliusEndpoint(e)) return true;
      if (
        (e.endpoint.label === 'rpc-url' || e.role === 'fallback') &&
        isHeliusEndpoint(e)
      ) {
        return true;
      }
    }
    return false;
  };

  // 1) Dedicated utility role that is strong (non-weak public / Triton)
  for (let i = 0; i < endpoints.length; i++) {
    const e = endpoints[i];
    if (e?.role === 'utility' && isStrongUtilityEndpoint(e, i)) return i;
  }
  // 2) rpc-url only when public/usable and not paid emergency
  for (let i = 0; i < endpoints.length; i++) {
    const e = endpoints[i];
    if (!e) continue;
    const label = (e.endpoint.label || '').toLowerCase();
    if (label === 'rpc-url' && isStrongUtilityEndpoint(e, i)) {
      return i;
    }
  }
  // 3) Any other non-forbidden public
  for (let i = 0; i < endpoints.length; i++) {
    if (i === preferredPrimary || i === preferredSecondary) continue;
    const e = endpoints[i];
    if (!e || isForbiddenUtilityEndpoint(e, i)) continue;
    if (isPublicRpcUrl(e.endpoint.url) && !isWeakPublicUtilityUrl(e.endpoint.url)) {
      if (!isEndpointHardFailed(e) && !isEndpointRateLimited(e)) return i;
    }
  }
  // 4) Stay on role-utility even if weak public — never promote Helius
  const utilIdx = endpoints.findIndex((e) => e.role === 'utility');
  if (utilIdx >= 0 && !isForbiddenUtilityEndpoint(endpoints[utilIdx], utilIdx)) {
    if (wouldHaveBeenHelius() && !loggedHeliusRemovedFromUtility) {
      loggedHeliusRemovedFromUtility = true;
      console.warn(
        `[helius_removed_from_utility] keeping ${endpoints[utilIdx]?.endpoint.label} ` +
          `(public) — Helius stays emergency-only`
      );
    }
    return utilIdx;
  }
  const pub = endpoints.findIndex(
    (e, i) =>
      isPublicRpcUrl(e.endpoint.url) && !isForbiddenUtilityEndpoint(e, i)
  );
  if (pub >= 0) {
    if (wouldHaveBeenHelius() && !loggedHeliusRemovedFromUtility) {
      loggedHeliusRemovedFromUtility = true;
      console.warn(
        `[helius_removed_from_utility] keeping ${endpoints[pub]?.endpoint.label} ` +
          `(public) — Helius stays emergency-only`
      );
    }
    return pub;
  }
  // Last resort: role-utility index even if weak; never Critical/Scanners paid key
  if (utilIdx >= 0) return utilIdx;
  for (let i = 0; i < endpoints.length; i++) {
    if (i === preferredPrimary || i === preferredSecondary) continue;
    if (isPublicRpcUrl(endpoints[i]?.endpoint.url || '')) return i;
  }
  return utilIdx >= 0 ? utilIdx : preferredUtility >= 0 ? preferredUtility : 0;
}

/** Sticky window so Utility does not thrash between weak publics. */
const UTILITY_FAILOVER_STICKY_MS = 45_000;
let lastUtilityFailoverAt = 0;
let lastUtilityFailoverIdx = -1;

/**
 * True when every configured endpoint is in a 429 cooldown — callers should
 * skip non-critical RPC (migration parse, wallet seed) so /health stays alive.
 */
export function shouldDeferHeavyRpc(): boolean {
  ensureEndpoints();
  if (endpoints.length === 0) return false;
  return endpoints.every((e) => isEndpointRateLimited(e));
}

/** True when the lane's preferred (or active) endpoint is cooling after a 429. */
export function isLaneRateLimited(role: RpcRole = 'primary'): boolean {
  ensureEndpoints();
  const pref = endpoints[preferredIndexFor(role)];
  if (isEndpointRateLimited(pref)) return true;
  const active = endpoints[resolveIndexForRole(role)];
  return isEndpointRateLimited(active);
}

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
            : 'fallback');
    return {
      endpoint: { ...endpoint, role },
      connection: new Connection(endpoint.url, {
        commitment: 'confirmed',
        wsEndpoint: endpoint.wsUrl || toWsUrl(endpoint.url),
        disableRetryOnRateLimit: true,
        fetch: meteredFetch(endpoint.label || `rpc`),
      }),
      healthy: true,
      latencyMs: null,
      lastCallLatencyMs: null,
      successCount: 0,
      failureCount: 0,
      lastCheckedAt: null,
      consecutiveFailures: 0,
      unhealthySince: null,
      role,
      rateLimitedUntil: 0,
      hardFailUntil: 0,
      quarantineStreak: 0,
      lastQuarantineLogAt: 0,
      lastUnhealthyLogAt: 0,
      latencyStressedSince: null,
      lastLatencyFailoverLogAt: 0,
    };
  });

  preferredPrimary = Math.max(
    0,
    endpoints.findIndex((e) => e.role === 'primary')
  );
  const secIdx = endpoints.findIndex((e) => e.role === 'secondary');
  preferredSecondary = secIdx >= 0 ? secIdx : preferredPrimary;
  preferredQuicknode = endpoints.findIndex(
    (e) =>
      e.endpoint.label === 'quicknode' || isQuicknodeRpcUrl(e.endpoint.url)
  );
  preferredHelius = endpoints.findIndex(
    (e) => e.endpoint.label === 'helius'
  );
  preferredHeliusBackup = endpoints.findIndex(
    (e) => e.endpoint.label === 'helius-backup'
  );
  preferredAlchemyBackup = endpoints.findIndex(
    (e) =>
      e.endpoint.label === 'alchemy-critical' ||
      e.endpoint.label === 'alchemy-backup'
  );
  preferredAlchemyBackup2 = endpoints.findIndex(
    (e) => e.endpoint.label === 'alchemy-backup2'
  );
  // Public emergency index (Trading hard-fail only) — not a Favourites sticky lane.
  preferredUtility = endpoints.findIndex(
    (e, i) =>
      i !== preferredPrimary &&
      i !== preferredSecondary &&
      isPublicRpcUrl(e.endpoint.url) &&
      !isHeliusEndpoint(e) &&
      !isAlchemyEndpoint(e)
  );
  if (preferredUtility < 0) {
    preferredUtility = endpoints.findIndex(
      (e, i) =>
        i !== preferredPrimary &&
        i !== preferredSecondary &&
        (e.endpoint.label === 'publicnode' ||
          e.endpoint.label === 'mainnet-beta' ||
          e.endpoint.label === 'rpc-url')
    );
  }
  if (preferredUtility < 0) preferredUtility = preferredSecondary;
  activePrimary = preferredPrimary;
  activeSecondary = preferredSecondary;
  activeUtility = preferredUtility;
  activeIndex = activePrimary;

  console.log(
    `[rpc] Initialized ${endpoints.length} endpoint(s): ` +
      endpoints
        .map((e) => `${e.endpoint.label}[${e.role}]`)
        .join(', ')
  );
  console.log(
    `[rpc] Lanes — Trading→${endpoints[preferredPrimary]?.endpoint.label} ` +
      `(${maskUrlForLog(endpoints[preferredPrimary]?.endpoint.url)}) · ` +
      `Data→${endpoints[preferredSecondary]?.endpoint.label} ` +
      `(${maskUrlForLog(endpoints[preferredSecondary]?.endpoint.url)}) · ` +
      `Emergency→${endpoints[preferredUtility]?.endpoint.label} ` +
      `(${maskUrlForLog(endpoints[preferredUtility]?.endpoint.url)})` +
      ` · Helius disabled · sticky after ${formatFailoverGrace(failoverDownMs())} down` +
      (preferredPrimary === preferredSecondary ? ' · SHARED' : ' · distinct')
  );
  if (preferredPrimary === preferredSecondary) {
    console.warn(
      '[rpc] Trading and Data resolve to the same RPC — scanners share CU with entries. ' +
        'Set distinct ALCHEMY_API_KEY_BACKUP vs ALCHEMY_API_KEY.'
    );
  }
  if (
    Boolean(config.rpc?.shareLoad) &&
    preferredPrimary !== preferredSecondary
  ) {
    console.log(
      `[trading_data_isolated] Trading=${endpoints[preferredPrimary]?.endpoint.label} ` +
        `Data=${endpoints[preferredSecondary]?.endpoint.label} ` +
        `Emergency=${endpoints[preferredUtility]?.endpoint.label} · Helius disabled`
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
  const stored = rpcRoleAls.getStore();
  if (stored) return stored === 'utility' ? 'secondary' : stored;
  // Ungated getConnection() callers ride Data when Share is on (never Trading).
  if (Boolean(config.rpc?.shareLoad)) return 'secondary';
  return 'primary';
}

/** True when code is inside runWithRpcRole (or an explicit role was bound). */
export function hasRpcRoleContext(): boolean {
  return rpcRoleAls.getStore() != null;
}

/** Run work on the secondary (or primary) lane — nested getConnection() inherits the role. */
export async function runWithRpcRole<T>(
  role: RpcRole,
  fn: () => Promise<T> | T,
  feature?: string
): Promise<T> {
  // Legacy utility acquires map onto Data.
  if (role === 'utility') {
    return runWithRpcRole('secondary', fn, feature);
  }
  const depth = rpcGateDepthAls.getStore() ?? 0;
  const bind = async () => {
    const run = () => rpcRoleAls.run(role, async () => await fn());
    if (feature) return rpcFeatureAls.run(feature, run);
    return run();
  };

  // Nested callers already hold a lane slot — do not double-acquire.
  if (depth > 0 || feature === 'health_probe') {
    return bind();
  }

  let release: (() => void) | null = null;
  try {
    const gate = await acquireRpcLane(role, feature);
    release = gate.release;
  } catch (err) {
    if (isRpcGateSkipError(err)) throw err;
    throw err;
  }

  try {
    return await rpcGateDepthAls.run(depth + 1, bind);
  } finally {
    release?.();
  }
}

export { getRpcGateSnapshot, isRpcGateSkipError } from './rpcGate';
export type { RpcGateSnapshot, RpcLaneGateStats } from './rpcGate';
export {
  shouldDeferBackgroundForCritical,
  logBackgroundDeferred,
} from './rpcGate';

/** Tag current async context for HTTP call metering (health probes, etc.). */
export async function runWithRpcFeature<T>(
  feature: string,
  fn: () => Promise<T> | T
): Promise<T> {
  return rpcFeatureAls.run(feature, async () => await fn());
}

function preferredIndexFor(role: RpcRole): number {
  ensureEndpoints();
  if (role === 'secondary') return preferredSecondary;
  // Legacy utility → Data sticky (public emergency is Trading-only failover).
  if (role === 'utility') return preferredSecondary;
  return preferredPrimary;
}

function downForMs(state: EndpointState | undefined): number {
  if (!state || state.healthy || !state.unhealthySince) return 0;
  return Math.max(0, Date.now() - state.unhealthySince);
}

function setActiveForRole(role: RpcRole, index: number): void {
  const prev =
    role === 'primary'
      ? activePrimary
      : role === 'secondary'
        ? activeSecondary
        : activeUtility;
  if (role === 'primary') {
    activePrimary = index;
    activeIndex = index;
  } else if (role === 'secondary') {
    activeSecondary = index;
  } else {
    activeUtility = index;
  }
  if (prev === index) return;
  const pref = preferredIndexFor(role);
  const label = endpoints[index]?.endpoint.label || 'unknown';
  const laneTag =
    role === 'primary'
      ? 'rpc_lane_trading'
      : role === 'secondary'
        ? 'rpc_lane_data'
        : 'rpc_lane_emergency';
  const emergency =
    index !== pref &&
    (isPublicRpcUrl(endpoints[index]?.endpoint.url || '') ||
      role === 'primary' ||
      role === 'secondary');
  if (emergency && role === 'primary') {
    console.warn(
      `[rpc_emergency_failover] ${laneTag} → ${label} (preferred ${endpoints[pref]?.endpoint.label || pref})`
    );
  } else if (index === pref) {
    console.log(`[${laneTag}] sticky ${label}`);
  } else if (role === 'primary') {
    console.log(`[${laneTag}] public hop → ${label}`);
  }
}

function isEmergencyBackupIndex(index: number): boolean {
  if (index < 0) return false;
  if (index === preferredPrimary) return false;
  if (index === preferredHeliusBackup || index === preferredAlchemyBackup2) {
    return true;
  }
  if (index === preferredHelius && preferredHelius !== preferredPrimary) {
    return true;
  }
  return isEmergencyBackupLabel(endpoints[index]?.endpoint.label);
}

function isHeliusEndpoint(state: EndpointState | undefined): boolean {
  if (!state) return false;
  const label = (state.endpoint.label || '').toLowerCase();
  const u = (state.endpoint.url || '').toLowerCase();
  return label === 'helius' || label === 'helius-backup' || u.includes('helius');
}

function isAlchemyEndpoint(state: EndpointState | undefined): boolean {
  if (!state) return false;
  const label = (state.endpoint.label || '').toLowerCase();
  const u = (state.endpoint.url || '').toLowerCase();
  return (
    label === 'alchemy' ||
    label === 'alchemy-backup' ||
    label === 'alchemy-critical' ||
    label === 'alchemy-backup2' ||
    u.includes('alchemy')
  );
}

/** Never hop onto Helius (2-lane: Helius unused). Also block Data→Trading key. */
function shareBlocksHeliusForRole(_role: RpcRole, idx: number): boolean {
  if (isHeliusEndpoint(endpoints[idx])) return true;
  return false;
}

let lastNonCriticalBlockLogAt = 0;
let nonCriticalBlockedFromCritical = 0;

/** Block Scanners/Utility from landing on preferred Critical Alchemy key. */
function blocksCriticalKeyForRole(role: RpcRole, idx: number): boolean {
  if (role === 'primary') return false;
  if (idx !== preferredPrimary) return false;
  nonCriticalBlockedFromCritical += 1;
  const now = Date.now();
  if (now - lastNonCriticalBlockLogAt > 15_000) {
    lastNonCriticalBlockLogAt = now;
    console.warn(
      `[noncritical_blocked_from_critical_key] ${role} blocked from ` +
        `${endpoints[preferredPrimary]?.endpoint.label} (count=${nonCriticalBlockedFromCritical})`
    );
  }
  return true;
}

function piggybackOrder(role: RpcRole): RpcRole[] {
  // Critical: Helius → Alchemy → (QuickNode mid-tier) → public.
  // Scanners: Alchemy → (QuickNode) → public — never Helius under Share ON (resolve filters).
  // Utility: public → (QN only if ~1000ms stressed and not busy) → Alchemy → Helius.
  if (role === 'primary') return ['secondary'];
  if (role === 'secondary') return ['primary'];
  return ['secondary', 'primary'];
}

/** True when Critical or Scanners are already piggybacking on QuickNode. */
function isQuicknodeBusyAsPaidFailover(): boolean {
  if (preferredQuicknode < 0) return false;
  return (
    activePrimary === preferredQuicknode ||
    activeSecondary === preferredQuicknode
  );
}

/**
 * Utility soft-failover may use QuickNode when preferred is severely stressed,
 * QN is healthy/faster, and not already serving primary/secondary.
 */
function utilityMayUseQuicknodeSoft(pref: EndpointState): boolean {
  // Share ON: Favourites/activity never burn paid mid-tier / backups.
  if (Boolean(config.rpc?.shareLoad)) return false;
  if (preferredQuicknode < 0) return false;
  if ((pref.latencyMs ?? 0) < UTILITY_QUICKNODE_STRESS_MS) return false;
  if (isQuicknodeBusyAsPaidFailover()) return false;
  const qn = endpoints[preferredQuicknode];
  if (!qn?.healthy || isEndpointRateLimited(qn)) return false;
  return isFasterAlternate(pref, qn);
}

/** Accept a failover target if healthy / not rate-limited / (for latency) faster. */
function acceptFailoverTarget(
  role: RpcRole,
  preferred: number,
  pref: EndpointState | undefined,
  altIdx: number,
  latencySoft: boolean,
  rateLimited: boolean,
  downMs: number,
  avoidPublicForCritical: boolean
): boolean {
  if (altIdx < 0 || altIdx === preferred || altIdx >= endpoints.length) return false;
  if (blocksCriticalKeyForRole(role, altIdx)) return false;
  if (role === 'utility' && isForbiddenUtilityEndpoint(endpoints[altIdx], altIdx)) {
    return false;
  }
  const other = endpoints[altIdx];
  if (!other?.healthy || isEndpointRateLimited(other) || isEndpointHardFailed(other))
    return false;
  if (avoidPublicForCritical && isPublicRpcUrl(other.endpoint.url)) return false;
  if (latencySoft && pref && !isFasterAlternate(pref, other)) return false;
  const active =
    role === 'primary'
      ? activePrimary
      : role === 'secondary'
        ? activeSecondary
        : activeUtility;
  if (active !== altIdx) {
    const reason = rateLimited
      ? 'rate-limited'
      : latencySoft
        ? `latency EWMA ${pref?.latencyMs ?? '—'}ms ≥ ${latencyStressThresholdMs(pref)}ms for ${Math.round(latencyStressGraceMs(pref) / 1000)}s`
        : `preferred down ${Math.round(downMs / 1000)}s ≥ ${Math.round(failoverDownMs() / 1000)}s`;
    const now = Date.now();
    if (
      !latencySoft ||
      now - (pref?.lastLatencyFailoverLogAt || 0) >= LATENCY_FAILOVER_LOG_THROTTLE_MS
    ) {
      if (pref && latencySoft) pref.lastLatencyFailoverLogAt = now;
      console.warn(
        `[rpc] ${role} lane piggybacking on ${other.endpoint.label} (${reason})`
      );
    }
  }
  setActiveForRole(role, altIdx);
  return true;
}

/**
 * Resolve which endpoint index should serve a lane.
 * Preferred stays sticky until unhealthy for failoverDownMs, then piggybacks
 * on other lanes (or any healthy fallback).
 * Rate-limited preferred endpoints skip grace and fail over immediately.
 * Critical (primary) prefers non-public piggybacks when Share load is on.
 */
function resolveIndexForRole(role: RpcRole): number {
  ensureEndpoints();
  // Legacy utility → Data
  if (role === 'utility') {
    return resolveIndexForRole('secondary');
  }
  const preferred = preferredIndexFor(role);
  const pref = endpoints[preferred];
  const latencySoft = latencyFailoverReady(pref);

  // Soft latency: stay sticky (no Helius / BACKUP2 / sibling soft hops).
  if (pref?.healthy && !isEndpointRateLimited(pref) && !latencySoft) {
    setActiveForRole(role, preferred);
    return preferred;
  }

  const downMs = downForMs(pref);
  const rateLimited = isEndpointRateLimited(pref);
  if (
    !latencySoft &&
    !rateLimited &&
    downMs > 0 &&
    downMs < failoverDownMs()
  ) {
    return preferred;
  }

  if (latencySoft && !rateLimited) {
    setActiveForRole(role, preferred);
    return preferred;
  }

  // Trading hard-fail / 429 → public emergency only (never Helius/QN/BACKUP2).
  if (role === 'primary') {
    const emergOrder = [preferredUtility];
    for (let i = 0; i < endpoints.length; i++) {
      if (i === preferred || i === preferredUtility) continue;
      if (!isPublicRpcUrl(endpoints[i]?.endpoint.url || '')) continue;
      if (isHeliusEndpoint(endpoints[i]) || isAlchemyEndpoint(endpoints[i])) continue;
      emergOrder.push(i);
    }
    for (const alt of emergOrder) {
      if (
        acceptFailoverTarget(
          role,
          preferred,
          pref,
          alt,
          false,
          rateLimited,
          downMs,
          false
        )
      ) {
        return alt;
      }
    }
    setActiveForRole(role, preferred);
    return preferred;
  }

  // Data: never borrow Trading key; hard-fail may use public only.
  if (role === 'secondary') {
    for (let i = 0; i < endpoints.length; i++) {
      if (i === preferred) continue;
      if (blocksCriticalKeyForRole(role, i)) continue;
      if (isHeliusEndpoint(endpoints[i])) continue;
      if (i === preferredPrimary) continue;
      if (!isPublicRpcUrl(endpoints[i]?.endpoint.url || '')) continue;
      if (
        acceptFailoverTarget(
          role,
          preferred,
          pref,
          i,
          false,
          rateLimited,
          downMs,
          false
        )
      ) {
        return i;
      }
    }
    setActiveForRole(role, preferred);
    return preferred;
  }

  return preferred;
}

export function getRpcUrl(role?: RpcRole): string {
  ensureEndpoints();
  const r = role ?? currentRole();
  const idx = resolveIndexForRole(r);
  return endpoints[idx]?.endpoint.url || DEFAULT_RPC;
}

/** Observational URL for a lane — does not failover or mutate active indexes. */
export function peekRpcUrl(role?: RpcRole): string {
  ensureEndpoints();
  const r = role ?? currentRole();
  const clamp = (i: number, fallback: number) =>
    i >= 0 && i < endpoints.length ? i : fallback;
  const rr = r === 'utility' ? 'secondary' : r;
  const idx =
    rr === 'secondary'
      ? clamp(activeSecondary, preferredSecondary)
      : clamp(activePrimary, preferredPrimary);
  return endpoints[idx]?.endpoint.url || DEFAULT_RPC;
}

/** Observational EWMA latency for a lane (null if never sampled). */
export function peekRpcLatencyMs(role: RpcRole): number | null {
  ensureEndpoints();
  const clamp = (i: number, fallback: number) =>
    i >= 0 && i < endpoints.length ? i : fallback;
  const rr = role === 'utility' ? 'secondary' : role;
  const pref = rr === 'secondary' ? preferredSecondary : preferredPrimary;
  const active = rr === 'secondary' ? activeSecondary : activePrimary;
  const state = endpoints[clamp(pref, active)] || endpoints[clamp(active, pref)];
  const ms = state?.latencyMs;
  return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
}

export function getConnection(role?: RpcRole): Connection {
  ensureEndpoints();
  const r = role ?? currentRole();
  const idx = resolveIndexForRole(r);
  return endpoints[idx].connection;
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
  const sample = Math.max(0, latencyMs);
  state.lastCallLatencyMs = sample;
  const feature = rpcFeatureAls.getStore() || 'ungated';
  const isProbe = feature === 'health_probe';
  // Health probes: soft-seed EWMA only when empty so UI isn't blank before
  // first real call; they must not dominate sticky-lane latency after traffic.
  if (isProbe) {
    if (state.latencyMs == null) {
      state.latencyMs = sample;
    }
  } else {
    state.latencyMs =
      state.latencyMs == null
        ? sample
        : Math.round(
            LATENCY_EWMA_ALPHA * sample +
              (1 - LATENCY_EWMA_ALPHA) * state.latencyMs
          );
    updateLatencyStress(state);
  }
  // #region agent log
  if (
    sample >= 80 &&
    (index === preferredPrimary || index === preferredSecondary)
  ) {
    const nowS = Date.now();
    if (!(globalThis as { __dbgSlowAt?: number }).__dbgSlowAt) {
      (globalThis as { __dbgSlowAt?: number }).__dbgSlowAt = 0;
    }
    if (nowS - ((globalThis as { __dbgSlowAt?: number }).__dbgSlowAt || 0) > 4_000) {
      (globalThis as { __dbgSlowAt?: number }).__dbgSlowAt = nowS;
      fetch('http://127.0.0.1:7710/ingest/4a93e060-3c93-430c-865a-86d3cc897ce8', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Debug-Session-Id': '06c3b9',
        },
        body: JSON.stringify({
          sessionId: '06c3b9',
          runId: 'post-fix',
          hypothesisId: 'H4',
          location: 'connection.ts:recordSuccess',
          message: 'slow_lane_sample',
          data: {
            label: state.endpoint.label,
            lane:
              index === preferredPrimary
                ? 'critical'
                : index === preferredSecondary
                  ? 'scanners'
                  : 'other',
            sampleMs: sample,
            ewmaMs: state.latencyMs,
            feature,
            role: rpcRoleAls.getStore() ?? 'unknown',
            probeExcludedFromEwma: isProbe,
          },
          timestamp: nowS,
        }),
      }).catch(() => {});
    }
  }
  // #endregion
  state.healthy = true;
  state.consecutiveFailures = 0;
  state.unhealthySince = null;
  state.lastCheckedAt = Date.now();
  state.lastError = undefined;
  // Clear cooldowns after a real success (including mid-cooldown recovery).
  state.rateLimitedUntil = 0;
  if (state.hardFailUntil) {
    const wasQ = state.hardFailUntil > 0;
    if (wasQ) {
      const now = Date.now();
      if (now - state.lastQuarantineLogAt >= 5_000) {
        state.lastQuarantineLogAt = now;
        console.log(
          `[rpc-quarantine] EXIT ${state.endpoint.label} — probe/call succeeded` +
            (state.quarantineStreak
              ? ` (streak was ${state.quarantineStreak})`
              : '')
        );
      }
    }
    state.hardFailUntil = 0;
    // Decay streak on success so temporary blips don't lock forever.
    state.quarantineStreak = Math.max(0, (state.quarantineStreak || 0) - 1);
  }
}

function updateLatencyStress(state: EndpointState): void {
  const ewma = state.latencyMs;
  if (ewma == null) {
    state.latencyStressedSince = null;
    return;
  }
  if (ewma < latencyRecoverThresholdMs(state)) {
    state.latencyStressedSince = null;
    return;
  }
  if (ewma >= latencyStressThresholdMs(state)) {
    if (state.latencyStressedSince == null) {
      state.latencyStressedSince = Date.now();
      console.warn(
        `[rpc] ${state.endpoint.label} latency stressed (EWMA ${ewma}ms, last ${state.lastCallLatencyMs ?? '—'}ms) — soft failover in ${latencyStressGraceMs(state) / 1000}s if it stays high`
      );
    }
  }
}

/** Preferred is OK on errors but EWMA has stayed hot long enough to piggyback. */
function latencyFailoverReady(state: EndpointState | undefined): boolean {
  if (!state?.latencyStressedSince) return false;
  if (state.latencyMs == null || state.latencyMs < latencyStressThresholdMs(state))
    return false;
  return Date.now() - state.latencyStressedSince >= latencyStressGraceMs(state);
}

function isFasterAlternate(
  preferred: EndpointState,
  other: EndpointState
): boolean {
  const prefMs = preferred.latencyMs;
  const otherMs = other.latencyMs;
  if (prefMs == null) return false;
  if (otherMs == null) return other.healthy;
  return otherMs <= LATENCY_RECOVER_MS || otherMs < prefMs * 0.65;
}

function recordFailure(index: number, error: string): void {
  const state = endpoints[index];
  if (!state) return;

  const isRateLimit = isRpcRateLimitMessage(error);
  const alreadyCooling = isEndpointRateLimited(state);

  // Already in 429 cooldown — count quietly, never re-log / re-switch thrash.
  if (isRateLimit && alreadyCooling) {
    state.failureCount += 1;
    state.consecutiveFailures += 1;
    state.lastError = error;
    state.lastCheckedAt = Date.now();
    state.healthy = false;
    return;
  }

  state.failureCount += 1;
  state.consecutiveFailures += 1;
  state.lastError = error;
  state.lastCheckedAt = Date.now();

  if (isRateLimit) {
    state.rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
  } else if (
    /timeout|timed out|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up|fetch failed|probe timeout/i.test(
      error
    )
  ) {
    const isPrefPrimary = index === preferredPrimary;
    const isHealthProbe = rpcFeatureAls.getStore() === 'health_probe';
    // Preferred Critical: never quarantine on health-probe timeouts. Require
    // 3 consecutive real-traffic fails before quarantine; probe-only needs 2
    // consecutive probe fails before marking unhealthy (reduces false DOWN).
    if (isPrefPrimary && isHealthProbe) {
      /* mark unhealthy below only after streak; keep probing */
    } else if (state.consecutiveFailures >= (isPrefPrimary ? 3 : 2)) {
      enterQuarantine(state, error.slice(0, 120));
    }
  } else if (state.consecutiveFailures >= (config.rpc?.failureThreshold ?? 3)) {
    // Persistent hard failures (e.g. QuickNode 0% success) — quarantine too.
    enterQuarantine(state, error.slice(0, 120));
  }

  const threshold = isRateLimit
    ? 1
    : index === preferredPrimary &&
        rpcFeatureAls.getStore() === 'health_probe'
      ? 2
      : config.rpc?.failureThreshold ?? 3;
  if (state.consecutiveFailures < threshold) return;

  const wasHealthy = state.healthy;
  if (wasHealthy) {
    state.unhealthySince = Date.now();
  }
  state.healthy = false;

  const now = Date.now();
  const shouldLog =
    wasHealthy || now - state.lastUnhealthyLogAt >= UNHEALTHY_LOG_THROTTLE_MS;
  if (shouldLog) {
    state.lastUnhealthyLogAt = now;
    console.warn(
      `[rpc] ${state.endpoint.label} marked unhealthy after ${state.consecutiveFailures} failures` +
        (isRateLimit
          ? ` (rate limited — cooling ${RATE_LIMIT_COOLDOWN_MS / 1000}s, failing over)`
          : '')
    );
  }
  void maybeSwitchEndpoints();
}

/**
 * Record a failure against the lane's active endpoint (e.g. migration parse 429).
 * Rate limits mark the endpoint unhealthy immediately so failover can kick in.
 */
export function noteActiveRpcFailure(
  error: unknown,
  role: RpcRole = 'primary'
): void {
  ensureEndpoints();
  const index = resolveIndexForRole(role);
  const message = error instanceof Error ? error.message : String(error);
  recordFailure(index, message);
}

async function maybeSwitchEndpoints(): Promise<void> {
  ensureEndpoints();
  if (endpoints.length <= 1) return;
  resolveIndexForRole('primary');
  resolveIndexForRole('secondary');
  resolveIndexForRole('utility');
}

async function probeEndpoint(index: number, timeoutMs = 8_000): Promise<boolean> {
  const state = endpoints[index];
  if (!state) return false;

  // Don't probe a rate-limited endpoint — burns CU and re-triggers 429 storms.
  // Once the cooldown elapses, fall through so preferred lanes can recover.
  if (isEndpointRateLimited(state)) {
    state.healthy = false;
    state.lastCheckedAt = Date.now();
    return false;
  }
  if (state.rateLimitedUntil && Date.now() >= state.rateLimitedUntil) {
    state.rateLimitedUntil = 0;
  }
  // Hard-fail cooldown — skip aggressive retries on dead QuickNode/fallbacks.
  if (isEndpointHardFailed(state)) {
    state.lastCheckedAt = Date.now();
    return false;
  }

  const gate = getRpcGateSnapshot();
  // Unhealthy / recovering preferred needs a full budget — a 4s stress cap
  // false-fails public RPCs and keeps "preferred DOWN" forever.
  // Preferred Critical always gets the full timeout (never the stressed 4s cap).
  const recovering = !state.healthy || state.unhealthySince != null;
  const isPrefCritical = index === preferredPrimary;
  const effectiveTimeout =
    isPrefCritical || recovering || !(gate.stressed || gate.backlog > 0)
      ? timeoutMs
      : Math.min(timeoutMs, 4_000);

  return runWithRpcFeature('health_probe', async () => {
    const start = Date.now();
    try {
      await Promise.race([
        state.connection.getSlot('confirmed'),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`RPC probe timeout after ${effectiveTimeout}ms`)),
            effectiveTimeout
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
  });
}

/** Run a timed RPC call against the lane's active endpoint; failover on failure */
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
  const r = role ?? currentRole();
  const startIndex = resolveIndexForRole(r);
  let lastError: unknown;
  const critical =
    /trade|migrat|send|confirm|swap|buy|sell/i.test(label) ||
    r === 'primary';
  const maxAttempts = critical
    ? WITH_RPC_MAX_ATTEMPTS_CRITICAL
    : WITH_RPC_MAX_ATTEMPTS_OTHER;

  // Build attempt order: preferred → other paid → QuickNode → utility → remaining.
  // Share ON: never walk Scanners onto Helius.
  const shareLoad = Boolean(config.rpc?.shareLoad);
  const order: number[] = [];
  const pushUnique = (i: number) => {
    if (i < 0 || i >= endpoints.length || order.includes(i)) return;
    if (blocksCriticalKeyForRole(r, i)) return;
    if (shareBlocksHeliusForRole(r, i)) return;
    if (r === 'utility' && isForbiddenUtilityEndpoint(endpoints[i], i)) return;
    order.push(i);
  };
  pushUnique(startIndex);
  for (const other of piggybackOrder(r)) {
    if (shareLoad && r === 'secondary' && other === 'primary') continue;
    pushUnique(preferredIndexFor(other));
  }
  if (r === 'primary' || r === 'secondary') {
    pushUnique(preferredQuicknode);
    pushUnique(preferredUtility);
  }
  for (let i = 0; i < endpoints.length; i++) pushUnique(i);

  logger.info('RPC', `start: ${label}`, {
    role: r,
    active: endpoints[startIndex]?.endpoint.label,
    endpoints: endpoints.length,
  });

  let attempts = 0;
  for (let oi = 0; oi < order.length && attempts < maxAttempts; oi++) {
    const index = order[oi];
    const state = endpoints[index];
    if (!state) continue;

    // Skip cooling 429 / hard-fail hosts when another endpoint can take the call.
    if (
      (isEndpointRateLimited(state) || isEndpointHardFailed(state)) &&
      endpoints.some(
        (e, i) =>
          i !== index && !isEndpointRateLimited(e) && !isEndpointHardFailed(e)
      )
    ) {
      continue;
    }

    const pref = preferredIndexFor(r);
    const prefRateLimited = isEndpointRateLimited(endpoints[pref]);
    // Sticky grace only for transient errors — not 429 cooldowns.
    if (
      !prefRateLimited &&
      !state.healthy &&
      attempts > 0 &&
      downForMs(endpoints[pref]) < failoverDownMs()
    ) {
      if (index !== pref) continue;
    }

    attempts += 1;
    if (attempts > 1) {
      // Exponential backoff between endpoint attempts (non-critical: longer).
      const backoffMs = Math.min(
        critical ? 400 * attempts : 700 * attempts,
        critical ? 1_200 : 2_500
      );
      await new Promise((res) => setTimeout(res, backoffMs));
    }

    const t0 = Date.now();
    try {
      setActiveForRole(r, index);
      const result = await fn(state.connection);
      const latencyMs = Date.now() - t0;
      recordSuccess(index, latencyMs);
      logger.info('RPC', `${label} ok`, {
        role: r,
        endpoint: state.endpoint.label,
        latencyMs,
        attempt: attempts,
      });
      return result;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      recordFailure(index, message);
      logger.warn('RPC', `${label} failed`, {
        role: r,
        endpoint: state.endpoint.label,
        attempt: attempts,
        maxAttempts,
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
  utility: {
    label: string;
    url: string;
    healthy: boolean;
    failover: boolean;
    downForMs: number;
  };
  shareLoad: boolean;
  shareSupports: typeof RPC_SHARE_LOAD_SUPPORTS;
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
  /** Real HTTP JSON-RPC call traffic (includes getConnection path). */
  callTraffic: ReturnType<typeof getRpcCallTraffic>;
  /** Rolling 60s top RPC sources (calls/min, in-flight, latency, skip/dedupe). */
  callerInventory: ReturnType<typeof getRpcCallerInventory>;
  /** Queue / event-loop health proxy for congestion diagnosis. */
  processHealth: ReturnType<typeof getProcessHealthSnapshot>;
  /** Rolling bottleneck snapshots for Render/local debug (no secrets). */
  bottleneckDebug: {
    sessionId: string;
    recent: Array<Record<string, unknown>>;
  };
  /** Per-lane concurrency / rate-limit backlog (overload vs provider). */
  gate: ReturnType<typeof getRpcGateSnapshot>;
  /** Quarantined (hard-failed) endpoints — not probed until cooldown ends. */
  quarantine: Array<{
    label: string;
    remainingMs: number;
    streak: number;
    lastError?: string;
  }>;
  /** Adaptive scanner/utility backoff snapshot. */
  loadControl: ReturnType<
    typeof import('./rpcLoadControl').getRpcLoadControlSnapshot
  > | null;
  utilityWeakPublic: boolean;
  nonCriticalBlockedFromCritical: number;
  criticalKeyIsolated: boolean;
  summary: 'all_sticky' | 'degraded' | 'emergency_failover' | 'lane_down';
  degradedParts: {
    critical: boolean;
    scanners: boolean;
    utility: boolean;
  };
  degradedBy: 'none' | 'trading' | 'data' | 'critical' | 'scanners';
  plainLanguage: string;
  lanes: {
    trading: {
      preferredLabel: string;
      activeLabel: string;
      host: string;
      latencyMs: number | null;
      preferredLatencyMs: number | null;
      activeLatencyMs: number | null;
      healthy: boolean;
      failover: boolean;
      configured: boolean;
      mode: 'sticky' | 'emergency' | 'unset';
    };
    data: {
      preferredLabel: string;
      activeLabel: string;
      host: string;
      latencyMs: number | null;
      preferredLatencyMs: number | null;
      healthy: boolean;
      failover: boolean;
      configured: boolean;
      mode: 'sticky' | 'emergency' | 'unset';
    };
    critical: {
      preferredLabel: string;
      activeLabel: string;
      host: string;
      latencyMs: number | null;
      preferredLatencyMs: number | null;
      activeLatencyMs: number | null;
      healthy: boolean;
      failover: boolean;
      configured: boolean;
      mode: 'sticky' | 'emergency' | 'unset';
    };
    scanners: {
      preferredLabel: string;
      activeLabel: string;
      host: string;
      latencyMs: number | null;
      preferredLatencyMs: number | null;
      healthy: boolean;
      failover: boolean;
      configured: boolean;
      mode: 'sticky' | 'emergency' | 'unset';
    };
    utility: {
      preferredLabel: string;
      activeLabel: string;
      host: string;
      latencyMs: number | null;
      preferredLatencyMs: number | null;
      healthy: boolean;
      failover: boolean;
      configured: boolean;
      mode: 'sticky' | 'public_hop';
    };
    emergency: Array<{
      label: string;
      host: string;
      configured: boolean;
      inUse: boolean;
      disabled?: boolean;
    }>;
    helius: { disabled: boolean; configured: boolean; inUse: boolean };
  };
} {
  ensureEndpoints();
  // Observational only — do NOT resolve/failover or mutate adaptive load from
  // status polls (dashboard every 5s). Health monitor tick owns those side effects.
  const clampIdx = (i: number, fallback: number) =>
    i >= 0 && i < endpoints.length ? i : fallback;
  const pIdx = clampIdx(activePrimary, preferredPrimary);
  const sIdx = clampIdx(activeSecondary, preferredSecondary);
  const uIdx = clampIdx(activeUtility, preferredUtility);
  const pPref = endpoints[preferredPrimary];
  const sPref = endpoints[preferredSecondary];
  const uPref = endpoints[preferredUtility];
  const pActive = endpoints[pIdx];
  const sActive = endpoints[sIdx];
  const uActive = endpoints[uIdx];
  const anyHealthy = endpoints.some(
    (e) => e.healthy && !isEndpointRateLimited(e)
  );
  const share = lanesShareEndpoint();
  const shareLoad = Boolean(config.rpc?.shareLoad);
  let warning: string | null = null;
  if (!anyHealthy) {
    warning =
      'All RPC endpoints unhealthy — wallet buy detection is paused until RPC recovers. ' +
      'Set ALCHEMY_API_KEY_BACKUP + ALCHEMY_API_KEY on Render.';
  } else if (
    /mainnet-beta\.solana\.com|publicnode\.com/i.test(pActive?.endpoint.url || '')
  ) {
    warning =
      'Using a public Solana RPC on the Trading lane — rate limits can miss buys. Set ALCHEMY_API_KEY_BACKUP (+ ALCHEMY_API_KEY for Data).';
  } else if (pIdx !== preferredPrimary) {
    warning = `Trading lane emergency on ${pActive?.endpoint.label} (preferred ${pPref?.endpoint.label} down >${formatFailoverGrace(failoverDownMs())}).`;
  } else if (
    preferredSecondary !== preferredPrimary &&
    sIdx !== preferredSecondary
  ) {
    warning = `Data lane emergency on ${sActive?.endpoint.label} (preferred secondary down >${formatFailoverGrace(failoverDownMs())}).`;
  } else if (share) {
    warning =
      'Trading and Data resolve to the same RPC — scanners share CU with entries. Set distinct ALCHEMY_API_KEY vs ALCHEMY_API_KEY_BACKUP.';
  }

  const gate = getRpcGateSnapshot();
  if (!warning && gate.stressed) {
    warning =
      'Trading/Data gate live-stressed — background queued/skipped. ' +
      `Trading q${gate.lanes.primary.queued} inFlight ${gate.lanes.primary.inFlight}/${gate.lanes.primary.maxConcurrent}; ` +
      `Data q${gate.lanes.secondary.queued} inFlight ${gate.lanes.secondary.inFlight}/${gate.lanes.secondary.maxConcurrent}.`;
  } else if (!warning && gate.utilityStressed) {
    // Favourites ride Data — do not paint Utility STRESSED from public alone.
    warning = null;
  }
  // Lifetime skip counter is diagnostic only — do not warn/slow from it.

  const quarantine = endpoints
    .filter((e) => isEndpointHardFailed(e))
    // Idle Helius quarantine is expected under quota protect — do not surface as
    // "RPC endpoints quarantined" noise while Alchemy Critical is sticky healthy.
    .filter((e) => {
      if (!isHeliusEndpoint(e)) return true;
      const idx = endpoints.indexOf(e);
      return (
        idx === activePrimary ||
        idx === activeSecondary ||
        idx === preferredPrimary
      );
    })
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
    // Observational only — do NOT mutate adaptive load from /api/status polls.
    loadControl = getRpcLoadControlSnapshot();
    if (
      !warning &&
      loadControl &&
      loadControl.scannerSlowFactor >= 3 &&
      loadControl.secondarySkipsRecent >= 6
    ) {
      warning =
        `Scanners lane high skips (${loadControl.secondarySkipsRecent}/60s) — Market/Alpha/Zion auto-slowed.`;
    }
  } catch {
    /* */
  }

  const maskUrl = (url: string) => {
    try {
      const u = new URL(url);
      if (/api\.key|api-key|apikey/i.test(u.search)) u.search = '';
      const path = u.pathname.replace(
        /\/(v\d+\/)?[A-Za-z0-9_-]{20,}(\/|$)/g,
        '/***$2'
      );
      return `${u.protocol}//${u.host}${path}`.slice(0, 72);
    } catch {
      return url
        .replace(/\/\/.*@/, '//***@')
        .replace(/\/[A-Za-z0-9_-]{20,}/g, '/***')
        .slice(0, 72);
    }
  };

  const hostOf = (url: string) => {
    try {
      return new URL(url).host || maskUrl(url);
    } catch {
      return maskUrl(url);
    }
  };
  const critConfigured = Boolean(
    pPref &&
      (pPref.endpoint.label === 'alchemy-critical' ||
        pPref.endpoint.label === 'alchemy-backup' ||
        isHeliusEndpoint(pPref) ||
        isAlchemyEndpoint(pPref))
  );
  const scanConfigured = Boolean(
    sPref &&
      isAlchemyEndpoint(sPref) &&
      preferredSecondary !== preferredPrimary
  );
  const critFo = pIdx !== preferredPrimary;
  const scanFo =
    preferredSecondary !== preferredPrimary && sIdx !== preferredSecondary;
  const utilFo = false;
  // Honesty: emergency only when Trading left preferred sticky host.
  // Global degraded = Trading/Data pressure only — never utility/public alone.
  const primaryLiveStress =
    gate.lanes.primary.queued > 0 ||
    gate.lanes.primary.inFlight >= gate.lanes.primary.maxConcurrent;
  const scannersLiveStress =
    gate.lanes.secondary.queued > 2 ||
    gate.lanes.secondary.inFlight >= gate.lanes.secondary.maxConcurrent;
  const criticalDegraded = Boolean(
    primaryLiveStress ||
      (loadControl &&
        loadControl.shedBackground &&
        loadControl.shedProtectsPaidCritical) ||
      (pPref?.latencyMs != null && pPref.latencyMs >= 450)
  );
  const scannersDegraded = Boolean(
    scannersLiveStress ||
      (loadControl && loadControl.scannerSlowFactor >= 3)
  );
  const utilityDegraded = false;
  const degradedParts = {
    critical: criticalDegraded,
    scanners: scannersDegraded,
    utility: false,
    trading: criticalDegraded,
    data: scannersDegraded,
  };
  let summary: 'all_sticky' | 'degraded' | 'emergency_failover' | 'lane_down' =
    'all_sticky';
  if (!anyHealthy || pPref?.healthy === false) {
    summary = 'lane_down';
  } else if (critFo || scanFo) {
    summary = 'emergency_failover';
  } else if (criticalDegraded) {
    summary = 'degraded';
  }
  const mapDegraded = (
    v: string | undefined
  ): 'none' | 'trading' | 'data' | 'critical' | 'scanners' => {
    if (!v || v === 'none' || v === 'utility') return 'none';
    if (v === 'critical') return 'trading';
    if (v === 'scanners') return 'data';
    if (v === 'trading' || v === 'data') return v;
    return 'none';
  };
  const degradedByRaw =
    loadControl?.degradedBy && loadControl.degradedBy !== 'none'
      ? loadControl.degradedBy
      : criticalDegraded
        ? 'trading'
        : scannersDegraded
          ? 'data'
          : 'none';
  const degradedBy = mapDegraded(String(degradedByRaw));
  const tradingLane = {
    preferredLabel: pPref?.endpoint.label || 'unset',
    activeLabel: pActive?.endpoint.label || 'unset',
    host: hostOf(
      (critFo ? pActive : pPref)?.endpoint.url || pActive?.endpoint.url || ''
    ),
    latencyMs: critFo
      ? (pActive?.latencyMs ?? null)
      : (pPref?.latencyMs ?? pActive?.latencyMs ?? null),
    preferredLatencyMs: pPref?.latencyMs ?? null,
    activeLatencyMs: pActive?.latencyMs ?? null,
    healthy: Boolean(pPref?.healthy),
    failover: critFo,
    configured: critConfigured,
    mode: (!critConfigured
      ? 'unset'
      : critFo
        ? 'emergency'
        : 'sticky') as 'sticky' | 'emergency' | 'unset',
  };
  const dataLane = {
    preferredLabel: sPref?.endpoint.label || 'unset',
    activeLabel: sActive?.endpoint.label || 'unset',
    host: hostOf(sActive?.endpoint.url || ''),
    latencyMs: sActive?.latencyMs ?? null,
    preferredLatencyMs: sPref?.latencyMs ?? null,
    healthy: Boolean(sPref?.healthy),
    failover: scanFo,
    configured: scanConfigured,
    mode: (!scanConfigured
      ? 'unset'
      : scanFo
        ? 'emergency'
        : 'sticky') as 'sticky' | 'emergency' | 'unset',
  };
  const emergActive = critFo && isPublicRpcUrl(pActive?.endpoint.url || '');
  const lanes = {
    trading: tradingLane,
    data: dataLane,
    // Dual-write aliases for one release (dashboard may still read critical/scanners).
    critical: tradingLane,
    scanners: dataLane,
    utility: {
      preferredLabel: uPref?.endpoint.label || 'public',
      activeLabel: emergActive
        ? pActive?.endpoint.label || 'public'
        : uPref?.endpoint.label || 'public',
      host: hostOf(
        (emergActive ? pActive : uPref)?.endpoint.url || uPref?.endpoint.url || ''
      ),
      latencyMs: (emergActive ? pActive : uPref)?.latencyMs ?? null,
      preferredLatencyMs: uPref?.latencyMs ?? null,
      healthy: Boolean(uPref?.healthy),
      failover: emergActive,
      configured: preferredUtility >= 0,
      mode: (emergActive ? 'public_hop' : 'sticky') as 'sticky' | 'public_hop',
    },
    emergency: [
      {
        label: 'public',
        host: hostOf(uPref?.endpoint.url || ''),
        configured: preferredUtility >= 0,
        inUse: emergActive,
      },
      {
        label: 'helius',
        host: '',
        configured: false,
        inUse: false,
        disabled: true,
      },
    ],
    helius: { disabled: true, configured: false, inUse: false },
  };
  const plainLanguage = [
    `Trading ${lanes.trading.activeLabel}` +
      (lanes.trading.mode === 'emergency' ? ' EMERGENCY' : ' sticky') +
      (lanes.trading.latencyMs != null
        ? ` ${Math.round(lanes.trading.latencyMs)}ms`
        : ''),
    `Data ${lanes.data.activeLabel}` +
      (lanes.data.latencyMs != null
        ? ` ${Math.round(lanes.data.latencyMs)}ms`
        : ''),
    `Emergency public ${emergActive ? 'active' : 'idle'}`,
    'Helius disabled',
  ].join(' · ');

  // #region agent log
  emitRpcBottleneckSnapshot({
    summary,
    degradedBy,
    lanes,
    gate,
    loadControl,
  });
  // #endregion

  return {
    active: pActive?.endpoint.label || 'unknown',
    activeUrl: maskUrl(pActive?.endpoint.url || ''),
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
    utility: {
      label: uActive?.endpoint.label || 'utility',
      url: maskUrl(uActive?.endpoint.url || ''),
      healthy: Boolean(uPref?.healthy),
      failover: uIdx !== preferredUtility,
      downForMs: downForMs(uPref),
    },
    shareLoad,
    shareSupports: RPC_SHARE_LOAD_SUPPORTS,
    failoverDownMs: failoverDownMs(),
    lanesShareEndpoint: share,
    supports: RPC_LANE_SUPPORTS,
    endpoints: endpoints.map((s, i) => {
      const total = s.successCount + s.failureCount;
      let lane: string | null = null;
      if (i === preferredPrimary) {
        lane = 'trading';
      } else if (
        i === preferredSecondary &&
        preferredSecondary !== preferredPrimary
      ) {
        lane = 'data';
      } else if (
        i === preferredUtility &&
        preferredUtility !== preferredPrimary &&
        preferredUtility !== preferredSecondary
      ) {
        lane = 'emergency';
      } else if (isPublicRpcUrl(s.endpoint.url)) {
        lane = 'emergency';
      }
      return {
        url: maskUrl(s.endpoint.url),
        label: s.endpoint.label,
        role: s.role,
        healthy: s.healthy,
        latencyMs: s.latencyMs,
        lastCallLatencyMs: s.lastCallLatencyMs,
        successCount: s.successCount,
        failureCount: s.failureCount,
        successRate: total === 0 ? 100 : (s.successCount / total) * 100,
        lastError: s.lastError,
        lastCheckedAt: s.lastCheckedAt,
        unhealthySince: s.unhealthySince,
        isActive: i === pIdx || i === sIdx || i === uIdx,
        lane,
      };
    }),
    jitoEnabled: Boolean(config.rpc?.jito?.enabled),
    priorityFeeLamports: lastPriorityFeeLamports,
    ok: anyHealthy,
    warning,
    callTraffic: getRpcCallTraffic(40),
    callerInventory: getRpcCallerInventory(10),
    processHealth: getProcessHealthSnapshot(),
    bottleneckDebug: {
      sessionId: BOTTLENECK_DEBUG_SESSION,
      recent: getBottleneckDebugRing(12),
    },
    gate,
    quarantine,
    loadControl,
    utilityWeakPublic: false,
    nonCriticalBlockedFromCritical,
    criticalKeyIsolated:
      Boolean(config.rpc?.shareLoad) &&
      preferredPrimary !== preferredSecondary &&
      preferredPrimary !== preferredUtility &&
      !isHeliusEndpoint(uPref) &&
      !isAlchemyEndpoint(uPref),
    summary,
    degradedParts,
    degradedBy,
    plainLanguage,
    lanes,
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
    const feeRole: RpcRole = Boolean(config.rpc?.shareLoad)
      ? 'secondary'
      : 'primary';
    return await runWithRpcRole(
      feeRole,
      async () => {
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
            const estimated = Math.max(
              min,
              Math.min(max, sorted[idx] || fallback)
            );
            // Convert micro-lamports/CU → store approximate lamports for UI (assume 200k CU)
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

const LIVE_BALANCE_TTL_MS = 10_000;
const liveBalanceCache = new Map<string, { sol: number; at: number }>();
const liveBalanceInflight = new Map<string, Promise<number | null>>();

export async function getLiveBalanceSol(
  walletId?: string
): Promise<number | null> {
  const pubkey = getWalletPublicKey(walletId);
  if (!pubkey) return null;
  const cacheKey = pubkey.toBase58();
  const cached = liveBalanceCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.at < LIVE_BALANCE_TTL_MS) {
    return cached.sol;
  }
  if (liveBalanceInflight.has(cacheKey)) {
    return liveBalanceInflight.get(cacheKey)!;
  }

  const read = () =>
    withRpc('getBalance', (conn) => conn.getBalance(pubkey), 'primary');

  const job = (async (): Promise<number | null> => {
    try {
      const lamports = Boolean(config.rpc?.shareLoad)
        ? await runWithRpcRole('primary', read, 'live_balance')
        : await read();
      const sol = lamports / LAMPORTS_PER_SOL;
      liveBalanceCache.set(cacheKey, { sol, at: Date.now() });
      return sol;
    } catch (err) {
      console.error('[connection] Failed to fetch balance:', err);
      return cached?.sol ?? null;
    } finally {
      liveBalanceInflight.delete(cacheKey);
    }
  })();
  liveBalanceInflight.set(cacheKey, job);
  return job;
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

/**
 * Force-probe preferred (+ active) endpoints so sticky-DOWN lanes can recover
 * without waiting for the next health interval. Used by POST /api/rpc/probe.
 */
export async function probeRpcRecovery(): Promise<ReturnType<typeof getRpcStats>> {
  ensureEndpoints();
  startRpcHealthMonitor();
  const order: number[] = [];
  const push = (i: number) => {
    if (i >= 0 && i < endpoints.length && !order.includes(i)) order.push(i);
  };
  push(preferredPrimary);
  push(preferredSecondary);
  push(preferredUtility);
  push(preferredQuicknode);
  push(activePrimary);
  push(activeSecondary);
  push(activeUtility);
  for (const i of order) {
    await probeEndpoint(i, 8_000);
    await new Promise((r) => setTimeout(r, 200));
  }
  await maybeSwitchEndpoints();
  return getRpcStats();
}

/** Periodic health probes + auto-switch */
export function startRpcHealthMonitor(): void {
  if (started) return;
  started = true;
  ensureEndpoints();

  const interval = Math.max(
    45_000,
    config.rpc?.healthIntervalMs ?? 45_000
  );
  let healthCycle = 0;

  /** Share load: probe Trading + Data preferred; public only in emergency; never Helius. */
  function shouldProbeIndex(index: number, cycle: number): boolean {
    if (!Boolean(config.rpc?.shareLoad)) {
      const st = endpoints[index];
      if (st && isEndpointHardFailed(st)) return false;
      if (st && isHeliusEndpoint(st)) return false;
      return true;
    }
    const state = endpoints[index];
    if (!state) return false;
    if (isEndpointHardFailed(state)) return false;
    if (isHeliusEndpoint(state)) return false;
    if (
      isEmergencyBackupIndex(index) ||
      state.endpoint.label === 'quicknode' ||
      isQuicknodeRpcUrl(state.endpoint.url)
    ) {
      return false;
    }

    const isPublic = isPublicRpcUrl(state.endpoint.url);
    const isPrimary = index === preferredPrimary;
    const isSecondary =
      index === preferredSecondary && preferredSecondary !== preferredPrimary;
    const tradingOnEmergency = activePrimary !== preferredPrimary;
    const isEmerg =
      index === preferredUtility ||
      (isPublic && index === activePrimary && tradingOnEmergency);

    if (isPublic || index === preferredUtility) {
      if (isEmerg || tradingOnEmergency) return true;
      return cycle % 8 === 0;
    }
    if (isPrimary) {
      if (tradingOnEmergency && index !== activePrimary) return cycle % 4 === 0;
      if (!state.healthy || state.unhealthySince != null) return true;
      return cycle % 4 === 0;
    }
    if (isSecondary) {
      if (activeSecondary !== preferredSecondary && index !== activeSecondary) {
        return cycle % 8 === 0;
      }
      if (!state.healthy || state.unhealthySince != null) return true;
      return cycle % 2 === 0;
    }
    return false;
  }

  // Boot: Trading + Data preferred, then public emergency (never Helius).
  void (async () => {
    const order: number[] = [];
    const push = (i: number) => {
      if (i >= 0 && i < endpoints.length && !order.includes(i)) order.push(i);
    };
    push(preferredPrimary);
    push(preferredSecondary);
    push(preferredUtility);
    for (const i of order) {
      if (isHeliusEndpoint(endpoints[i])) continue;
      await probeEndpoint(i);
      await new Promise((r) => setTimeout(r, 400));
    }
  })();

  healthTimer = setInterval(() => {
    void (async () => {
      healthCycle += 1;
      const gateSnap = getRpcGateSnapshot();
      for (let i = 0; i < endpoints.length; i++) {
        if (!shouldProbeIndex(i, healthCycle)) continue;
        const isActive =
          i === activePrimary ||
          i === activeSecondary ||
          (i === preferredUtility && activePrimary !== preferredPrimary);
        const isPreferred =
          i === preferredPrimary ||
          i === preferredSecondary ||
          i === preferredUtility;
        if (gateSnap.stressed && !isActive && !isPreferred) {
          continue;
        }
        await probeEndpoint(i);
        await new Promise((r) => setTimeout(r, gateSnap.stressed ? 400 : 250));
      }
      await maybeSwitchEndpoints();
      try {
        const { updateRpcLoadSignals } =
          require('./rpcLoadControl') as typeof import('./rpcLoadControl');
        const pState = endpoints[preferredPrimary];
        const sState = endpoints[preferredSecondary];
        const gate = getRpcGateSnapshot();
        updateRpcLoadSignals({
          primaryLatencyMs: pState?.latencyMs ?? null,
          secondaryLatencyMs: sState?.latencyMs ?? null,
          utilityLatencyMs: null,
          utilityWeakPublic: false,
          utilityFailover: false,
          primaryFailover: activePrimary !== preferredPrimary,
          primaryQueued: gate.lanes.primary.queued,
          primaryWeakPublic: isWeakPublicUtilityUrl(pState?.endpoint.url),
          secondaryIdle:
            gate.lanes.secondary.inFlight === 0 &&
            gate.lanes.secondary.queued === 0,
        });
      } catch {
        /* optional */
      }
    })();
  }, interval);

  console.log(
    `[rpc] Health monitor started (every ${interval}ms` +
      (Boolean(config.rpc?.shareLoad)
        ? '; Trading+Data sticky; public emergency probes; Helius disabled'
        : '') +
      `) — endpoints: ` +
      endpoints.map((e) => `${e.endpoint.label}[${e.role}]`).join(', ') +
      ` · active primary=${getActiveEndpointLabel('primary')} secondary=${getActiveEndpointLabel('secondary')}`
  );
}

export function stopRpcHealthMonitor(): void {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  started = false;
}
