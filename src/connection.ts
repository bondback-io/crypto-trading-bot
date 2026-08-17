/**
 * Multi-RPC connection manager with primary / secondary / utility lanes,
 * health monitoring, cross-lane failover, priority fees, and stats.
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
  RPC_SHARE_LOAD_SUPPORTS,
  isPublicRpcUrl,
  isQuicknodeRpcUrl,
  isOfficialMainnetBetaRpcUrl,
  buildAlchemyRpcUrl,
  type RpcLaneRole,
} from './rpcUrl';
import {
  acquireRpcLane,
  acquireSpikeAccountInfoCap,
  getRpcGateSnapshot,
  isRpcGateSkipError,
  runDedupedRpcJob,
  RpcGateSkipError,
} from './rpcGate';
import {
  classifyRpcOutcome,
  currentSpikeCallContext,
  getSpikeInspectorSnapshot,
  noteRpcCall,
  runWithSpikeCallContext,
  shouldShedPrimaryMonitoring,
  withRpcAttemptCap,
} from './rpcSpikeInspector';
import {
  classifyCreditsProvider,
  isInsufficientCreditsBody,
  logCreditsRequest,
  noteCreditsExhausted,
  shouldSkipCreditsProvider,
} from './creditsGuard';
import { guardRpcWebSocket } from './rpcWsGuard';
import { QuietLogGate } from './httpProviderGate';
import {
  acquireAlchemyPaceSlot,
  getAlchemyPaceStatus,
  isAlchemyCuLimitMessage,
  isAlchemyRpcUrl,
  noteAlchemyCuLimit,
  noteAlchemyOk,
  shouldSkipAlchemyRpc,
} from './rpcProviderPace';
import {
  exclusiveServiceForFeature,
  RPC_EMERGENCY_LABELS,
  RPC_EXCLUSIVE_SERVICES,
  RPC_EMERGENCY_SERVICES,
} from './rpcServiceMap';

const softRpcFailLog = new QuietLogGate(60_000);

dotenv.config();

const DEFAULT_RPC = PUBLIC_SOLANA_RPC;

/** Workload lane â€” primary=critical; secondary=scanners/Zion; utility=import/activity */
export type RpcRole = 'primary' | 'secondary' | 'utility' | 'watchers';

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
  /** Preferred endpoint for primary, secondary, or utility lane */
  lane?: RpcRole | null;
  serviceTitle?: string | null;
  intensity?: string | null;
  exclusive?: boolean;
}

interface EndpointState {
  endpoint: RpcEndpoint;
  connection: Connection;
  healthy: boolean;
  /** Smoothed latency (EWMA) â€” used for UI + latency soft-failover */
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
let preferredWatchers = 0;
/** Mid-tier paid failover (QuickNode); -1 when unset */
let preferredQuicknode = -1;
/** Lazy extra Critical failover (BACKUP2/public). -1 until toggle ON + Helius failing. */
let extraCriticalIdx = -1;
/** Currently resolved index serving each lane (may differ after failover) */
let activePrimary = 0;
let activeSecondary = 0;
let activeUtility = 0;
let activeWatchers = 0;
/** Legacy single active pointer â€” mirrors primary lane for older callers */
let activeIndex = 0;

const rpcRoleAls = new AsyncLocalStorage<RpcRole>();
/** Optional feature tag for call metering (wallet_poll, health_probe, â€¦). */
const rpcFeatureAls = new AsyncLocalStorage<string>();
/** >0 when already inside an acquired lane gate (nested runWithRpcRole). */
const rpcGateDepthAls = new AsyncLocalStorage<number>();

/** Cached keypairs by trading wallet id â€” secrets never leave process memory */
const keypairCache = new Map<string, Keypair>();
let healthTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

/** HTTP JSON-RPC call meter â€” counts real CU burn (getConnection path included). */
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

function callMeterKey(
  endpoint: string,
  feature: string,
  method: string,
  role: string
): CallMeterKey {
  return `${endpoint}|${feature}|${method}|${role}`;
}

function recordHttpRpcCall(opts: {
  endpoint: string;
  method: string;
  ok: boolean;
  latencyMs: number;
  status?: number | null;
  error?: unknown;
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
  // Health probes must not inflate utility spike / containment meters.
  if (feature === 'health_probe') return;
  const ctx = currentSpikeCallContext();
  const queueWaitMs = ctx?.queueWaitMs ?? 0;
  noteRpcCall({
    lane: role === 'unknown' ? undefined : role,
    provider: opts.endpoint,
    method: opts.method,
    queueWaitMs,
    networkMs: opts.latencyMs,
    totalMs: queueWaitMs + opts.latencyMs,
    outcome: classifyRpcOutcome({
      ok: opts.ok,
      status: opts.status,
      error: opts.error,
    }),
    inFlight: ctx?.inFlight,
  });
}

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

const PRIMARY_MONITOR_METHODS = new Set([
  'getSignaturesForAddress',
  'getTransaction',
  'getParsedTransaction',
  'getAccountInfo',
]);
const PRIMARY_TX_MONITOR_METHODS = new Set([
  'getSignaturesForAddress',
  'getTransaction',
  'getParsedTransaction',
]);

function isExitRpcFeature(feature: string): boolean {
  return /send_tx|sendRawTransaction|sendLegacy|trade_exit|confirm_tx|confirmTransaction/i.test(
    feature
  );
}

function isExitSendLabel(label: string, feature?: string): boolean {
  return isExitRpcFeature(`${label} ${feature || ''}`);
}

let exitLaneGuardTrips = 0;

export function getExitLaneGuardTrips(): number {
  return exitLaneGuardTrips;
}

export function __resetExitLaneGuardTripsForTests(): void {
  exitLaneGuardTrips = 0;
}

/** Pin send/confirm onto Trading/Helius. Never Watchers or Utility. */
export function applyExitSendLaneGuard(
  label: string,
  role: RpcRole,
  feature?: string
): RpcRole {
  if (!isExitSendLabel(label, feature)) return role;
  if (role === 'watchers' || role === 'utility') {
    exitLaneGuardTrips += 1;
    console.warn('[exit_lane_guard]', {
      from: role,
      to: 'primary',
      label,
      trips: exitLaneGuardTrips,
    });
  }
  return 'primary';
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return String(input);
}

function meteredFetch(endpointLabel: string) {
  const baseFetch = globalThis.fetch.bind(globalThis);
  const doFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const methods = parseRpcMethodsFromBody(init?.body);
    const url = fetchInputUrl(input);
    const provider = classifyCreditsProvider(url);
    const alchemy = isAlchemyRpcUrl(url);
    const source = `rpc:${methods[0] || endpointLabel}`;
    const feature = rpcFeatureAls.getStore() || 'ungated';
    if (
      provider === 'helius' &&
      !isExitRpcFeature(feature) &&
      shouldSkipCreditsProvider('helius')
    ) {
      throw new Error('Insufficient credits for this request');
    }
    if (alchemy && shouldSkipAlchemyRpc(feature, url)) {
      throw new RpcGateSkipError(
        'rate',
        rpcRoleAls.getStore() || 'secondary',
        feature
      );
    }
    const pace = alchemy
      ? acquireAlchemyPaceSlot(feature, url)
      : { allowed: true, release: () => undefined };
    if (alchemy && !pace.allowed) {
      throw new RpcGateSkipError(
        'rate',
        rpcRoleAls.getStore() || 'secondary',
        feature
      );
    }
    const t0 = Date.now();
    let ok = false;
    try {
      const res = await baseFetch(input, init);
      ok = res.ok;
      const latencyMs = Date.now() - t0;
      for (const method of methods) {
        recordHttpRpcCall({
          endpoint: endpointLabel,
          method,
          ok,
          latencyMs,
          status: res.status,
        });
      }
      if (!res.ok && provider === 'helius') {
        logCreditsRequest(source, 'helius', url);
        let peek = '';
        try {
          peek = await res.clone().text();
        } catch {
          peek = '';
        }
        if (isInsufficientCreditsBody(peek) || res.status === 402) {
          noteCreditsExhausted(source, 'helius', url);
        }
      }
      if (!res.ok && alchemy) {
        let peek = '';
        try {
          peek = await res.clone().text();
        } catch {
          peek = '';
        }
        if (
          res.status === 429 ||
          isAlchemyCuLimitMessage(peek) ||
          isAlchemyCuLimitMessage(`${res.status} ${peek}`)
        ) {
          noteAlchemyCuLimit(url);
        }
      } else if (res.ok && alchemy) {
        noteAlchemyOk(url);
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
          error: err,
        });
      }
      throw err;
    } finally {
      pace.release();
    }
  };
  return async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const methods = parseRpcMethodsFromBody(init?.body);
    const role = rpcRoleAls.getStore();
    const feature = rpcFeatureAls.getStore() || 'ungated';
    const monitor = methods.some((m) => PRIMARY_MONITOR_METHODS.has(m));
    const txMonitor = methods.some((m) => PRIMARY_TX_MONITOR_METHODS.has(m));
    const accountCap = acquireSpikeAccountInfoCap(role, methods, feature);
    if (!accountCap.allowed) {
      throw new RpcGateSkipError('busy', role || 'watchers', feature);
    }
    try {
      if (
        role === 'primary' &&
        txMonitor &&
        !isExitRpcFeature(feature) &&
        shouldShedPrimaryMonitoring()
      ) {
        const raw =
          typeof init?.body === 'string'
            ? init.body
            : String(init?.body || '');
        const key = `primary:monitor:${methods.slice().sort().join('+')}:${raw.slice(0, 240)}`;
        const joined = await runDedupedRpcJob(key, () => doFetch(input, init), {
          join: true,
          startIfMissing: false,
        });
        if (joined) return joined;
        throw new RpcGateSkipError('busy', 'primary', feature);
      }
      if (
        role === 'primary' &&
        monitor &&
        !txMonitor &&
        !isExitRpcFeature(feature) &&
        shouldShedPrimaryMonitoring()
      ) {
        const raw =
          typeof init?.body === 'string'
            ? init.body
            : String(init?.body || '');
        const key = `primary:monitor:${methods.slice().sort().join('+')}:${raw.slice(0, 240)}`;
        const joined = await runDedupedRpcJob(key, () => doFetch(input, init), {
          join: true,
        });
        if (joined) return joined;
      }
      return await doFetch(input, init);
    } finally {
      accountCap.release();
    }
  };
}

/** Default cross-lane piggyback grace â€” preferred must stay unhealthy this long. */
const DEFAULT_FAILOVER_DOWN_MS = 30_000;
/** Floor so env typos cannot collapse failover to zero. */
const MIN_FAILOVER_DOWN_MS = 5_000;
/** After a 429, leave the hot endpoint alone so failover can breathe. */
const RATE_LIMIT_COOLDOWN_MS = 60_000;
/** Dead/failing endpoints: base quarantine (escalates with streak). */
const HARD_FAIL_COOLDOWN_MS = 5 * 60_000;
const HARD_FAIL_COOLDOWN_MAX_MS = 20 * 60_000;
/** Cap withRpc endpoint walks â€” avoid retry storms across every fallback. */
const WITH_RPC_MAX_ATTEMPTS_CRITICAL = 4;
const WITH_RPC_MAX_ATTEMPTS_OTHER = 3;
/** Don't re-log "marked unhealthy" more often than this. */
const UNHEALTHY_LOG_THROTTLE_MS = 15_000;
/** EWMA weight for new samples â€” dampens single getTransaction spikes in the UI. */
const LATENCY_EWMA_ALPHA = 0.22;
/** EWMA above this â†’ start latency-stress timer (matches rpcDiagnostic). */
const LATENCY_STRESS_MS = 500;
/** EWMA below this â†’ clear latency stress (hysteresis). */
const LATENCY_RECOVER_MS = 320;
/**
 * Utility may soft-fail onto QuickNode only when preferred EWMA is this hot
 * (after public/fallback alternatives) and QN is not already serving Critical/Scanners.
 */
const UTILITY_QUICKNODE_STRESS_MS = 1000;
/** Prefer piggyback after preferred stays latency-stressed this long. */
const LATENCY_STRESS_GRACE_MS = 15_000;
/** Public Solana is often chronically slow from cloud hosts â€” fail over sooner. */
const LATENCY_STRESS_GRACE_PUBLIC_MS = 5_000;
/** Don't re-log latency piggyback more often than this. */
const LATENCY_FAILOVER_LOG_THROTTLE_MS = 45_000;

function latencyStressGraceMs(state: EndpointState | undefined): number {
  if (state && isPublicRpcUrl(state.endpoint.url)) {
    return LATENCY_STRESS_GRACE_PUBLIC_MS;
  }
  return LATENCY_STRESS_GRACE_MS;
}

/**
 * True 429 / provider rate-limit signals only.
 * Do NOT treat connect timeouts / generic "fetch failed" as rate limits â€”
 * that applied a 60s probe blackout and, combined with stressed-gate skip of
 * non-active endpoints, left preferred lanes sticky-DOWN for hours while
 * the hosts were fine.
 */
function isRpcRateLimitMessage(error: string): boolean {
  return /429|rate.?limit|-32429|too many requests|insufficient credits|credit usage limit|compute units per second/i.test(
    error
  );
}

/** Provider soft-block (Helius 403 / -32602 Request blocked) â€” not a hard outage. */
export function isRpcSoftBlockedMessage(error: string): boolean {
  const s = String(error || '');
  if (!s) return false;
  return (
    /request blocked/i.test(s) ||
    /-32602/.test(s) ||
    (/403/.test(s) && /forbidden|blocked|jsonrpc/i.test(s))
  );
}

/** Soft RPC failure suitable for warn-once (not Trading-critical dump). */
export function isRpcSoftFailureMessage(error: string): boolean {
  return isRpcRateLimitMessage(error) || isRpcSoftBlockedMessage(error);
}

/** True when err is soft 429 / CU/s / 403 blocked / gate-skip. */
export function isRpcSoftFailureError(err: unknown): boolean {
  if (isRpcGateSkipError(err)) return true;
  try {
    const { isAlchemyCuLimitMessage } =
      require('./rpcProviderPace') as typeof import('./rpcProviderPace');
    const msg = err instanceof Error ? err.message : String(err ?? '');
    if (isAlchemyCuLimitMessage(msg)) return true;
    return isRpcSoftFailureMessage(msg);
  } catch {
    const msg = err instanceof Error ? err.message : String(err ?? '');
    return isRpcSoftFailureMessage(msg);
  }
}

/** Short soft-fail text for stdout â€” never JSON / never the word "error". */
export function formatSoftRpcFailBrief(err: unknown): string {
  if (isRpcGateSkipError(err)) return 'gate skip';
  const msg = err instanceof Error ? err.message : String(err ?? '');
  try {
    const { isAlchemyCuLimitMessage } =
      require('./rpcProviderPace') as typeof import('./rpcProviderPace');
    if (isAlchemyCuLimitMessage(msg)) return '429 CU/s capacity';
  } catch {
    /* optional */
  }
  if (isRpcSoftBlockedMessage(msg)) return '403 soft blocked';
  if (isRpcRateLimitMessage(msg) || /\b429\b/.test(msg)) return '429 rate limited';
  if (isRpcSoftFailureMessage(msg)) return 'soft RPC limited';
  const flat = msg.replace(/\s+/g, ' ').replace(/[{}"]/g, '').slice(0, 80);
  return flat || 'soft RPC limited';
}

/** Throttled stdout log for soft RPC failures (Render level:error ignores stdout). */
export function logSoftRpcFailure(tag: string, err: unknown): void {
  if (!softRpcFailLog.allow()) return;
  console.log(`[${tag}] soft RPC fail (no stack) ${formatSoftRpcFailBrief(err)}`);
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
        `(streak ${state.quarantineStreak}) â€” ${reason}`
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

/** Official mainnet-beta / publicnode â€” chronically slow from cloud hosts. */
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
  ensureEndpoints();
  const idx = resolveIndexForRole('utility');
  const state = endpoints[idx];
  if (!state) return true;
  return isWeakPublicUtilityUrl(state.endpoint.url);
}

/** Stronger utility candidate: configured rpc-url / utility role that is not weak public. */
function isStrongUtilityEndpoint(state: EndpointState | undefined): boolean {
  if (!state) return false;
  if (isWeakPublicUtilityUrl(state.endpoint.url)) return false;
  if (isEndpointHardFailed(state) || isEndpointRateLimited(state)) return false;
  const label = (state.endpoint.label || '').toLowerCase();
  if (state.role === 'utility') return true;
  if (label === 'rpc-url' || state.role === 'fallback') {
    // Custom RPC_URL / mid-tier fallback â€” prefer over publicnode/mainnet-beta.
    return !isPublicRpcUrl(state.endpoint.url) || label === 'rpc-url';
  }
  return false;
}

function pickPreferredUtilityIndex(): number {
  // 1) Dedicated utility role that is not weak public
  for (let i = 0; i < endpoints.length; i++) {
    const e = endpoints[i];
    if (e?.role === 'utility' && isStrongUtilityEndpoint(e)) return i;
  }
  // 2) rpc-url / non-public fallback
  for (let i = 0; i < endpoints.length; i++) {
    const e = endpoints[i];
    if (!e) continue;
    const label = (e.endpoint.label || '').toLowerCase();
    if (
      (label === 'rpc-url' || e.role === 'fallback') &&
      isStrongUtilityEndpoint(e)
    ) {
      return i;
    }
  }
  // 3) Any non-weak, non-primary/secondary public-ish
  for (let i = 0; i < endpoints.length; i++) {
    if (i === preferredPrimary || i === preferredSecondary) continue;
    if (isStrongUtilityEndpoint(endpoints[i])) return i;
  }
  // 4) Classic: first utility role, else first public
  const utilIdx = endpoints.findIndex((e) => e.role === 'utility');
  if (utilIdx >= 0) return utilIdx;
  const pub = endpoints.findIndex((e) => isPublicRpcUrl(e.endpoint.url));
  if (pub >= 0) return pub;
  return preferredSecondary;
}

/** Sticky window so Utility does not thrash between weak publics. */
const UTILITY_FAILOVER_STICKY_MS = 45_000;
let lastUtilityFailoverAt = 0;
let lastUtilityFailoverIdx = -1;

/**
 * True when every configured endpoint is in a 429 cooldown â€” callers should
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

function createGuardedConnection(
  url: string,
  label: string,
  wsUrl?: string
): Connection {
  const connection = new Connection(url, {
    commitment: 'confirmed',
    wsEndpoint: wsUrl || toWsUrl(url),
    disableRetryOnRateLimit: true,
    fetch: meteredFetch(label || 'rpc'),
  });
  guardRpcWebSocket(connection, { url, label });
  return connection;
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
            : endpoint.label === 'watchers' || endpoint.label === 'alchemy-backup'
              ? 'watchers'
              : 'fallback');
    return {
      endpoint: { ...endpoint, role },
      connection: createGuardedConnection(
        endpoint.url,
        endpoint.label || `rpc`,
        endpoint.wsUrl
      ),
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
    endpoints.findIndex((e) => e.endpoint.label === 'alchemy') >= 0
      ? endpoints.findIndex((e) => e.endpoint.label === 'alchemy')
      : endpoints.findIndex((e) => e.role === 'primary')
  );
  const secIdx = endpoints.findIndex(
    (e) => e.endpoint.label === 'alchemy-backup3'
  );
  preferredSecondary =
    secIdx >= 0
      ? secIdx
      : (() => {
          const i = endpoints.findIndex((e) => e.role === 'secondary');
          return i >= 0 ? i : preferredPrimary;
        })();
  preferredUtility = (() => {
    const fav = endpoints.findIndex((e) => e.endpoint.label === 'alchemy-backup');
    if (fav >= 0) return fav;
    const light = endpoints.findIndex(
      (e) => e.endpoint.label === 'helius-backup'
    );
    if (light >= 0) return light;
    return pickPreferredUtilityIndex();
  })();
  const watchIdx = endpoints.findIndex(
    (e) =>
      e.endpoint.label === 'alchemy-backup2' ||
      e.role === 'watchers'
  );
  preferredWatchers = watchIdx >= 0 ? watchIdx : preferredUtility;
  preferredQuicknode = endpoints.findIndex(
    (e) =>
      e.endpoint.label === 'quicknode' || isQuicknodeRpcUrl(e.endpoint.url)
  );
  activePrimary = preferredPrimary;
  activeSecondary = preferredSecondary;
  activeUtility = preferredUtility;
  activeWatchers = preferredWatchers;
  activeIndex = activePrimary;

  console.log(
    `[rpc] Initialized ${endpoints.length} endpoint(s): ` +
      endpoints
        .map((e) => `${e.endpoint.label}[${e.role}]`)
        .join(', ')
  );
  console.log(
    `[rpc] Lanes â€” primaryâ†’${endpoints[preferredPrimary]?.endpoint.label} ` +
      `(${maskUrlForLog(endpoints[preferredPrimary]?.endpoint.url)}) Â· ` +
      `secondaryâ†’${endpoints[preferredSecondary]?.endpoint.label} ` +
      `(${maskUrlForLog(endpoints[preferredSecondary]?.endpoint.url)}) Â· ` +
      `utilityâ†’${endpoints[preferredUtility]?.endpoint.label} ` +
      `(${maskUrlForLog(endpoints[preferredUtility]?.endpoint.url)}) Â· ` +
      `watchersâ†’${endpoints[preferredWatchers]?.endpoint.label} ` +
      `(${maskUrlForLog(endpoints[preferredWatchers]?.endpoint.url)})` +
      (preferredQuicknode >= 0
        ? ` Â· mid-tierâ†’${endpoints[preferredQuicknode]?.endpoint.label}`
        : '') +
      ` Â· cross-lane failover after ${formatFailoverGrace(failoverDownMs())} down` +
      (preferredPrimary === preferredSecondary ? ' Â· SHARED' : ' Â· distinct')
  );
  if (preferredPrimary === preferredSecondary) {
    console.warn(
      '[rpc] Primary and secondary resolve to the same RPC â€” Zion KOL shares CU with copy/signals. ' +
        'Set a distinct RPC_SECONDARY (must differ from RPC_URL).'
    );
  }
}

/**
 * Lazy extra Critical piggyback. Does not register/probe until toggle is ON
 * and this is called from the existing Helius-fail failover path.
 */
function ensureHeliusExtraFallbackEndpoint(): number {
  if (config.rpc?.heliusExtraFallbackEnabled !== true) return -1;
  if (extraCriticalIdx >= 0 && extraCriticalIdx < endpoints.length) {
    return extraCriticalIdx;
  }
  ensureEndpoints();
  const target =
    config.rpc.heliusExtraFallbackTarget === 'public' ? 'public' : 'backup2';
  let url: string | null = null;
  let label = 'helius-extra';
  if (target === 'backup2') {
    url = buildAlchemyRpcUrl(process.env.ALCHEMY_API_KEY_BACKUP2);
    label = 'alchemy-backup2';
  } else {
    url = PUBLIC_SOLANA_RPC;
    label = 'publicnode-extra';
  }
  if (!url) return -1;
  const existing = endpoints.findIndex((e) => e.endpoint.url === url);
  if (existing >= 0) {
    extraCriticalIdx = existing;
    return existing;
  }
  extraCriticalIdx = endpoints.length;
  endpoints.push({
    endpoint: { url, label, role: 'fallback' },
    connection: createGuardedConnection(url, label),
    healthy: true,
    latencyMs: null,
    lastCallLatencyMs: null,
    successCount: 0,
    failureCount: 0,
    lastCheckedAt: null,
    consecutiveFailures: 0,
    unhealthySince: null,
    role: 'fallback',
    rateLimitedUntil: 0,
    hardFailUntil: 0,
    quarantineStreak: 0,
    lastQuarantineLogAt: 0,
    lastUnhealthyLogAt: 0,
    latencyStressedSince: null,
    lastLatencyFailoverLogAt: 0,
  });
  console.log(
    `[rpc] Helius extra fallback registered â†’ ${label} (lazy, after paid failover)`
  );
  return extraCriticalIdx;
}

function maskUrlForLog(url: string | undefined): string {
  if (!url) return 'â€”';
  try {
    const u = new URL(url);
    const host = u.host || 'rpc';
    return host.length > 40 ? host.slice(0, 38) + 'â€¦' : host;
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
  if (stored) return stored;
  // Ungated getConnection() — prefer Trading lane; exclusive map binds features elsewhere.
  return 'primary';
}

/** True when code is inside runWithRpcRole (or an explicit role was bound). */
export function hasRpcRoleContext(): boolean {
  return rpcRoleAls.getStore() != null;
}

/** Current RPC feature tag (exclusive service map), or null if unbound. */
export function getCurrentRpcFeature(): string | null {
  return rpcFeatureAls.getStore() ?? null;
}

/** Run work on the secondary (or primary) lane â€” nested getConnection() inherits the role. */
export async function runWithRpcRole<T>(
  role: RpcRole,
  fn: () => Promise<T> | T,
  feature?: string
): Promise<T> {
  const depth = rpcGateDepthAls.getStore() ?? 0;
  const bind = async () => {
    const run = () => rpcRoleAls.run(role, async () => await fn());
    if (feature) return rpcFeatureAls.run(feature, run);
    return run();
  };

  // Nested callers already hold a lane slot â€” do not double-acquire.
  if (depth > 0 || feature === 'health_probe') {
    return bind();
  }

  let release: (() => void) | null = null;
  let queueWaitMs = 0;
  let inFlight = 0;
  try {
    const gate = await acquireRpcLane(role, feature);
    release = gate.release;
    queueWaitMs = gate.queueWaitMs ?? 0;
    inFlight = gate.inFlight ?? 0;
  } catch (err) {
    if (isRpcGateSkipError(err)) throw err;
    throw err;
  }

  try {
    return await rpcGateDepthAls.run(depth + 1, () =>
      runWithSpikeCallContext({ queueWaitMs, inFlight }, bind)
    );
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
  if (role === 'utility') return preferredUtility;
  if (role === 'watchers') return preferredWatchers;
  return preferredPrimary;
}

function downForMs(state: EndpointState | undefined): number {
  if (!state || state.healthy || !state.unhealthySince) return 0;
  return Math.max(0, Date.now() - state.unhealthySince);
}

function setActiveForRole(role: RpcRole, index: number): void {
  if (role === 'primary') {
    activePrimary = index;
    activeIndex = index;
  } else if (role === 'secondary') {
    activeSecondary = index;
  } else if (role === 'watchers') {
    activeWatchers = index;
  } else {
    activeUtility = index;
  }
}

function piggybackOrder(role: RpcRole): RpcRole[] {
  // Critical: Helius â†’ Alchemy â†’ (QuickNode mid-tier) â†’ public.
  // Scanners: Alchemy â†’ Helius â†’ (QuickNode) â†’ public.
  // Utility: public â†’ (QN only if ~1000ms stressed and not busy) â†’ Alchemy â†’ Helius.
  // Paid cross-lane only here; QuickNode + utility are inserted after in resolve/withRpc.
  if (role === 'primary') return ['secondary'];
  if (role === 'secondary') return ['primary'];
  if (role === 'watchers') return ['utility'];
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
        : role === 'watchers'
          ? activeWatchers
          : activeUtility;
  if (active !== altIdx) {
    const reason = rateLimited
      ? 'rate-limited'
      : latencySoft
        ? `latency EWMA ${pref?.latencyMs ?? 'â€”'}ms â‰¥ ${LATENCY_STRESS_MS}ms for ${Math.round(latencyStressGraceMs(pref) / 1000)}s`
        : `preferred down ${Math.round(downMs / 1000)}s â‰¥ ${Math.round(failoverDownMs() / 1000)}s`;
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
 * Exclusive service preferred index, else -1.
 * Failover only to emergency labels (rpc-url â†’ publicnode) â€” never another exclusive key.
 */
function resolveExclusiveServiceIndex(feature: string): number {
  ensureEndpoints();
  const svc = exclusiveServiceForFeature(feature);
  if (!svc) return -1;
  const preferred = endpoints.findIndex((e) => e.endpoint.label === svc.label);
  if (preferred < 0) {
    // Preferred key unset â€” go straight to emergency.
    for (const lab of RPC_EMERGENCY_LABELS) {
      const i = endpoints.findIndex((e) => e.endpoint.label === lab);
      if (i < 0) continue;
      const e = endpoints[i]!;
      if (!e.healthy || isEndpointRateLimited(e) || isEndpointHardFailed(e)) {
        continue;
      }
      return i;
    }
    return -1;
  }
  const pref = endpoints[preferred]!;
  const cooling =
    isAlchemyRpcUrl(pref.endpoint.url) &&
    shouldSkipAlchemyRpc(feature, pref.endpoint.url);
  // Stay on exclusive preferred despite mild EWMA — emergency publics from Render
  // are usually slower and caused the latency cascade. Fail over only on
  // rate-limit / hard-fail / unhealthy / Alchemy cooling.
  if (
    pref.healthy &&
    !isEndpointRateLimited(pref) &&
    !isEndpointHardFailed(pref) &&
    !cooling
  ) {
    return preferred;
  }
  const downMs = downForMs(pref);
  if (
    !isEndpointRateLimited(pref) &&
    !cooling &&
    downMs > 0 &&
    downMs < failoverDownMs()
  ) {
    return preferred;
  }
  for (const lab of RPC_EMERGENCY_LABELS) {
    const i = endpoints.findIndex((e) => e.endpoint.label === lab);
    if (i < 0 || i === preferred) continue;
    const e = endpoints[i]!;
    if (!e.healthy || isEndpointRateLimited(e) || isEndpointHardFailed(e)) {
      continue;
    }
    return i;
  }
  return preferred;
}

/**
 * Resolve which endpoint index should serve a lane.
 * When a feature is bound, use exclusive service preferred key with emergency-only failover.
 */
function resolveIndexForRole(role: RpcRole): number {
  ensureEndpoints();
  const feature = rpcFeatureAls.getStore() || 'ungated';
  const exclusiveIdx = resolveExclusiveServiceIndex(feature);
  if (exclusiveIdx >= 0) {
    setActiveForRole(role, exclusiveIdx);
    return exclusiveIdx;
  }

  const preferred = preferredIndexFor(role);
  const pref = endpoints[preferred];
  const latencySoft = latencyFailoverReady(pref);
  const prefAlchemyCooling =
    Boolean(pref) &&
    isAlchemyRpcUrl(pref!.endpoint.url) &&
    shouldSkipAlchemyRpc(feature, pref!.endpoint.url);

  if (
    pref?.healthy &&
    !isEndpointRateLimited(pref) &&
    !latencySoft &&
    !prefAlchemyCooling
  ) {
    setActiveForRole(role, preferred);
    return preferred;
  }

  const downMs = downForMs(pref);
  const rateLimited = isEndpointRateLimited(pref);
  if (
    !latencySoft &&
    !rateLimited &&
    !prefAlchemyCooling &&
    downMs > 0 &&
    downMs < failoverDownMs()
  ) {
    return preferred;
  }

  // Exclusive-mode fallback: never piggyback another service's key â€” emergency only.
  for (const lab of RPC_EMERGENCY_LABELS) {
    const i = endpoints.findIndex((e) => e.endpoint.label === lab);
    if (i < 0) continue;
    const e = endpoints[i]!;
    if (!e.healthy || isEndpointRateLimited(e) || isEndpointHardFailed(e)) {
      continue;
    }
    setActiveForRole(role, i);
    return i;
  }

  setActiveForRole(role, preferred);
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
  // EWMA so a single slow getTransaction does not paint the whole endpoint as 800ms+.
  state.latencyMs =
    state.latencyMs == null
      ? sample
      : Math.round(
          LATENCY_EWMA_ALPHA * sample + (1 - LATENCY_EWMA_ALPHA) * state.latencyMs
        );
  updateLatencyStress(state);
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
          `[rpc-quarantine] EXIT ${state.endpoint.label} â€” probe/call succeeded` +
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
  if (ewma < LATENCY_RECOVER_MS) {
    state.latencyStressedSince = null;
    return;
  }
  if (ewma >= LATENCY_STRESS_MS) {
    if (state.latencyStressedSince == null) {
      state.latencyStressedSince = Date.now();
      console.warn(
        `[rpc] ${state.endpoint.label} latency stressed (EWMA ${ewma}ms, last ${state.lastCallLatencyMs ?? 'â€”'}ms) â€” soft failover in ${latencyStressGraceMs(state) / 1000}s if it stays high`
      );
    }
  }
}

/** Preferred is OK on errors but EWMA has stayed hot long enough to piggyback. */
function latencyFailoverReady(state: EndpointState | undefined): boolean {
  if (!state?.latencyStressedSince) return false;
  if (state.latencyMs == null || state.latencyMs < LATENCY_STRESS_MS) return false;
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

  const provider = classifyCreditsProvider(state.endpoint.url);
  if (
    provider !== 'other' &&
    isInsufficientCreditsBody(error) &&
    !shouldSkipCreditsProvider(provider)
  ) {
    noteCreditsExhausted(
      `rpc:${state.endpoint.label}`,
      provider,
      state.endpoint.url
    );
  }

  const isRateLimit = isRpcRateLimitMessage(error);
  const alreadyCooling = isEndpointRateLimited(state);

  // Already in 429 cooldown â€” count quietly, never re-log / re-switch thrash.
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
    if (isAlchemyRpcUrl(state.endpoint.url) && isAlchemyCuLimitMessage(error)) {
      noteAlchemyCuLimit(state.endpoint.url);
    }
  } else if (
    /timeout|timed out|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up|fetch failed|probe timeout/i.test(
      error
    )
  ) {
    // Hard network/timeout failures â€” quarantine so health/withRpc stop hammering it.
    if (state.consecutiveFailures >= 2) {
      enterQuarantine(state, error.slice(0, 120));
    }
  } else if (state.consecutiveFailures >= (config.rpc?.failureThreshold ?? 3)) {
    // Persistent hard failures (e.g. QuickNode 0% success) â€” quarantine too.
    enterQuarantine(state, error.slice(0, 120));
  }

  const threshold = isRateLimit ? 1 : config.rpc?.failureThreshold ?? 3;
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
          ? ` (rate limited â€” cooling ${RATE_LIMIT_COOLDOWN_MS / 1000}s, failing over)`
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

  // Don't probe a rate-limited endpoint â€” burns CU and re-triggers 429 storms.
  // Once the cooldown elapses, fall through so preferred lanes can recover.
  if (isEndpointRateLimited(state)) {
    state.healthy = false;
    state.lastCheckedAt = Date.now();
    return false;
  }
  if (state.rateLimitedUntil && Date.now() >= state.rateLimitedUntil) {
    state.rateLimitedUntil = 0;
  }
  // Hard-fail cooldown â€” skip aggressive retries on dead QuickNode/fallbacks.
  if (isEndpointHardFailed(state)) {
    state.lastCheckedAt = Date.now();
    return false;
  }

  const gate = getRpcGateSnapshot();
  // Unhealthy / recovering preferred needs a full budget â€” a 4s stress cap
  // false-fails public RPCs and keeps "preferred DOWN" forever.
  const recovering = !state.healthy || state.unhealthySince != null;
  const effectiveTimeout =
    recovering || !(gate.stressed || gate.backlog > 0)
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
  const feature = rpcFeatureAls.getStore() || label;
  const exitSend = isExitSendLabel(label, feature);
  let r = applyExitSendLaneGuard(label, role ?? currentRole(), feature);
  const startIndex = resolveIndexForRole(r);
  let lastError: unknown;
  const critical =
    exitSend ||
    r === 'primary' ||
    /trade|send|confirm|swap|buy|sell/i.test(`${label} ${feature}`);
  const defaultMax = critical
    ? WITH_RPC_MAX_ATTEMPTS_CRITICAL
    : WITH_RPC_MAX_ATTEMPTS_OTHER;
  const monitorCall =
    !exitSend &&
    /getTransaction|getParsedTransaction|getSignaturesForAddress/i.test(
      `${label} ${feature}`
    );
  const maxAttempts = withRpcAttemptCap(critical, defaultMax, {
    exitSend,
    monitor: monitorCall,
  });

  // Build attempt order: exclusive preferred → emergency only (never other exclusives).
  const order: number[] = [];
  const pushUnique = (i: number) => {
    if (i >= 0 && i < endpoints.length && !order.includes(i)) order.push(i);
  };
  pushUnique(startIndex);
  if (!exitSend) {
    const excl = resolveExclusiveServiceIndex(feature);
    if (excl >= 0) pushUnique(excl);
    for (const lab of RPC_EMERGENCY_LABELS) {
      const i = endpoints.findIndex((e) => e.endpoint.label === lab);
      pushUnique(i);
    }
    // Do not append other exclusive keys or cross-lane piggybacks.
  }

  logger.info('RPC', `start: ${label}`, {
    role: r,
    active: endpoints[startIndex]?.endpoint.label,
    endpoints: exitSend ? 1 : endpoints.length,
    exitPinned: exitSend,
  });

  let attempts = 0;
  let rateLimitHits = 0;
  let skippedAlchemyCooling = 0;
  for (let oi = 0; oi < order.length && attempts < maxAttempts; oi++) {
    const index = order[oi];
    const state = endpoints[index];
    if (!state) continue;

    if (
      !exitSend &&
      isAlchemyRpcUrl(state.endpoint.url) &&
      shouldSkipAlchemyRpc(feature, state.endpoint.url)
    ) {
      skippedAlchemyCooling += 1;
      continue;
    }

    // Skip cooling 429 / hard-fail hosts when another endpoint can take the call.
    // Exit sends stay on Helius â€” never skip the only Trading endpoint.
    if (
      !exitSend &&
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
    // Sticky grace only for transient errors â€” not 429 cooldowns.
    if (
      !exitSend &&
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
      if (isRpcGateSkipError(err)) break;
      const message = err instanceof Error ? err.message : String(err);
      const alreadyCooling = isEndpointRateLimited(state);
      recordFailure(index, message);
      const softAttempt =
        !exitSend &&
        (isRpcSoftFailureMessage(message) || isAlchemyCuLimitMessage(message));
      if (softAttempt) {
        if (!(isRpcRateLimitMessage(message) && alreadyCooling) && softRpcFailLog.allow()) {
          console.log(
            `[rpc] soft fail ${label} endpoint=${state.endpoint.label} ` +
              `attempt=${attempts}/${maxAttempts} ${message.slice(0, 140)}`
          );
        }
      } else if (!(isRpcRateLimitMessage(message) && alreadyCooling)) {
        logger.warn('RPC', `${label} failed`, {
          role: r,
          endpoint: state.endpoint.label,
          attempt: attempts,
          maxAttempts,
          latencyMs: Date.now() - t0,
          errorMessage: message.slice(0, 180),
        });
      }
      if (!exitSend && isRpcRateLimitMessage(message)) {
        rateLimitHits += 1;
        if (
          isAlchemyCuLimitMessage(message) &&
          isAlchemyRpcUrl(state.endpoint.url)
        ) {
          noteAlchemyCuLimit(state.endpoint.url);
        }
        if (rateLimitHits >= 2) break;
      }
    }
  }

  if (attempts === 0 && skippedAlchemyCooling > 0 && lastError == null) {
    throw new RpcGateSkipError('rate', r, feature);
  }

  if (isRpcGateSkipError(lastError)) {
    throw lastError;
  }

  const failMsg =
    lastError instanceof Error ? lastError.message : String(lastError ?? '');
  // Soft 429/403/CU must not require !critical â€” primary-lane soft work
  // (migration Share OFF, mirror holdings, polls) was still logger.error.
  const soft =
    !exitSend &&
    (isRpcSoftFailureMessage(failMsg) || isAlchemyCuLimitMessage(failMsg));

  if (soft) {
    if (softRpcFailLog.allow()) {
      console.log(
        `[rpc] soft fail ${label} role=${r} (no stack) ${formatSoftRpcFailBrief(lastError)}`
      );
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError ?? 'All RPC endpoints failed'));
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
  watchers: {
    label: string;
    url: string;
    healthy: boolean;
    failover: boolean;
    downForMs: number;
    configured: boolean;
  };
  exclusiveServices: Array<{
    service: string;
    title: string;
    intensity: 'high' | 'med' | 'low';
    exclusive: true;
    envKey: string;
    label: string;
    gateRole: string;
    blurb: string;
    configured: boolean;
    healthy: boolean;
    latencyMs: number | null;
    cooling: boolean;
  }>;
  emergencyFallbacks: Array<{
    title: string;
    intensity: 'emergency';
    exclusive: false;
    envKey: string;
    label: string;
    blurb: string;
    configured: boolean;
    healthy: boolean;
    latencyMs: number | null;
  }>;
  shareLoad: boolean;
  heliusExtraFallbackEnabled: boolean;
  heliusExtraFallbackTarget: 'backup2' | 'public';
  alchemyPace: ReturnType<typeof getAlchemyPaceStatus>;
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
  /** Per-lane concurrency / rate-limit backlog (overload vs provider). */
  gate: ReturnType<typeof getRpcGateSnapshot>;
  /** Quarantined (hard-failed) endpoints â€” not probed until cooldown ends. */
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
  containmentEnabled: boolean;
  spikeInspector: ReturnType<typeof getSpikeInspectorSnapshot> | null;
} {
  ensureEndpoints();
  // Preferred sticky indices — do NOT resolveIndex without a feature (ungated → utility_light).
  const pPref = endpoints[preferredPrimary];
  const sPref = endpoints[preferredSecondary];
  const uPref = endpoints[preferredUtility];
  const wPref = endpoints[preferredWatchers];
  const pActive = pPref;
  const sActive = sPref;
  const uActive = uPref;
  const wActive = wPref;
  const pIdx = preferredPrimary;
  const sIdx = preferredSecondary;
  const uIdx = preferredUtility;
  const wIdx = preferredWatchers;
  const anyHealthy = endpoints.some(
    (e) => e.healthy && !isEndpointRateLimited(e)
  );
  const share = lanesShareEndpoint();
  const shareLoad = Boolean(config.rpc?.shareLoad);
  let warning: string | null = null;
  if (!anyHealthy) {
    warning =
      'All RPC endpoints unhealthy — wallet buy detection is paused until RPC recovers. ' +
      'Set exclusive Alchemy/Helius keys on Render (plus RPC_URL / PUBLICNODE_URL emergency).';
  } else if (
    /mainnet-beta\.solana\.com|publicnode\.com/i.test(pActive?.endpoint.url || '')
  ) {
    warning =
      'Trading preferred is on a public RPC — set ALCHEMY_API_KEY for exclusive Trading Critical.';
  } else if (share) {
    warning =
      'Multiple services resolve to the same preferred URL — check exclusive env keys are distinct.';
  }

  const gate = getRpcGateSnapshot();
  if (!warning && gate.stressed) {
    warning =
      'RPC lane gate stressed — background work is being queued/skipped to protect Trading. ' +
      `Utility queue ${gate.lanes.utility.queued}, skipped ${gate.lanes.utility.skipped}.`;
  }

  const quarantine = endpoints
    .filter((e) => isEndpointHardFailed(e))
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
    const {
      updateRpcLoadSignals,
      getRpcLoadControlSnapshot,
    } = require('./rpcLoadControl') as typeof import('./rpcLoadControl');
    updateRpcLoadSignals({
      primaryLatencyMs: pActive?.latencyMs ?? null,
      secondaryLatencyMs: sActive?.latencyMs ?? null,
      utilityLatencyMs: uActive?.latencyMs ?? null,
      utilityWeakPublic: isWeakPublicUtilityUrl(uActive?.endpoint.url),
      utilityFailover: false,
      primaryQueued: gate.lanes.primary.queued,
      secondaryIdle:
        gate.lanes.secondary.inFlight === 0 &&
        gate.lanes.secondary.queued === 0,
    });
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

  const exclusiveServices = RPC_EXCLUSIVE_SERVICES.map((svc) => {
    const idx = endpoints.findIndex((e) => e.endpoint.label === svc.label);
    const ep = idx >= 0 ? endpoints[idx] : null;
    return {
      service: svc.service,
      title: svc.title,
      intensity: svc.intensity,
      exclusive: true as const,
      envKey: svc.envKey,
      label: svc.label,
      gateRole: svc.gateRole,
      blurb: svc.blurb,
      configured: idx >= 0,
      healthy: Boolean(ep?.healthy && !isEndpointRateLimited(ep)),
      latencyMs: ep?.latencyMs ?? null,
      cooling: Boolean(
        ep &&
          isAlchemyRpcUrl(ep.endpoint.url) &&
          shouldSkipAlchemyRpc(svc.service, ep.endpoint.url)
      ),
    };
  });

  const emergencyFallbacks = RPC_EMERGENCY_SERVICES.map((svc) => {
    const idx = endpoints.findIndex((e) => e.endpoint.label === svc.label);
    const ep = idx >= 0 ? endpoints[idx] : null;
    return {
      title: svc.title,
      intensity: svc.intensity,
      exclusive: false as const,
      envKey: svc.envKey,
      label: svc.label,
      blurb: svc.blurb,
      configured: idx >= 0,
      healthy: Boolean(ep?.healthy && !isEndpointRateLimited(ep)),
      latencyMs: ep?.latencyMs ?? null,
    };
  });

  const stats = {
    active: pPref?.endpoint.label || '—',
    activeUrl: maskUrl(pPref?.endpoint.url || ''),
    primary: {
      label: pPref?.endpoint.label || 'alchemy',
      url: maskUrl(pPref?.endpoint.url || ''),
      healthy: Boolean(pPref?.healthy),
      failover: false,
      downForMs: downForMs(pPref),
    },
    secondary: {
      label: sPref?.endpoint.label || 'alchemy-backup3',
      url: maskUrl(sPref?.endpoint.url || ''),
      healthy: Boolean(sPref?.healthy),
      failover: false,
      downForMs: downForMs(sPref),
    },
    utility: {
      label: uPref?.endpoint.label || 'alchemy-backup',
      url: maskUrl(uPref?.endpoint.url || ''),
      healthy: Boolean(uPref?.healthy),
      failover: false,
      downForMs: downForMs(uPref),
    },
    watchers: {
      label: wPref?.endpoint.label || 'alchemy-backup2',
      url: maskUrl(wPref?.endpoint.url || ''),
      healthy: Boolean(wPref?.healthy),
      failover: false,
      downForMs: downForMs(wPref),
      configured: preferredWatchers >= 0,
    },
    exclusiveServices,
    emergencyFallbacks,
    shareLoad,
    heliusExtraFallbackEnabled: false,
    heliusExtraFallbackTarget: 'backup2' as const,
    alchemyPace: getAlchemyPaceStatus(),
    shareSupports: RPC_SHARE_LOAD_SUPPORTS,
    failoverDownMs: failoverDownMs(),
    lanesShareEndpoint: share,
    supports: RPC_LANE_SUPPORTS,
    endpoints: endpoints.map((s, i) => {
      const total = s.successCount + s.failureCount;
      const svc = RPC_EXCLUSIVE_SERVICES.find(
        (x) => x.label === s.endpoint.label
      );
      const emerg = RPC_EMERGENCY_SERVICES.find(
        (x) => x.label === s.endpoint.label
      );
      let lane: RpcRole | null = svc?.gateRole ?? null;
      if (!lane && emerg) lane = null;
      else if (!lane) {
        if (i === preferredPrimary) lane = 'primary';
        else if (i === preferredSecondary) lane = 'secondary';
        else if (i === preferredUtility) lane = 'utility';
        else if (i === preferredWatchers) lane = 'watchers';
      }
      return {
        url: maskUrl(s.endpoint.url),
        label: s.endpoint.label,
        role: s.role,
        serviceTitle: svc?.title || emerg?.title || null,
        intensity: svc?.intensity || emerg?.intensity || null,
        exclusive: Boolean(svc?.exclusive),
        healthy: s.healthy,
        latencyMs: s.latencyMs,
        lastCallLatencyMs: s.lastCallLatencyMs,
        successCount: s.successCount,
        failureCount: s.failureCount,
        successRate: total === 0 ? 100 : (s.successCount / total) * 100,
        lastError: s.lastError,
        lastCheckedAt: s.lastCheckedAt,
        unhealthySince: s.unhealthySince,
        isActive: i === pIdx || i === sIdx || i === uIdx || i === wIdx,
        lane,
      };
    }),
    jitoEnabled: Boolean(config.rpc?.jito?.enabled),
    priorityFeeLamports: lastPriorityFeeLamports,
    ok: anyHealthy,
    warning,
    callTraffic: getRpcCallTraffic(40),
    gate,
    quarantine,
    loadControl,
    utilityWeakPublic: isWeakPublicUtilityUrl(uActive?.endpoint.url),
    containmentEnabled: Boolean(config.rpc?.containmentEnabled === true),
    spikeInspector: null as ReturnType<typeof getSpikeInspectorSnapshot> | null,
  };
  try {
    const snap = getSpikeInspectorSnapshot();
    stats.spikeInspector = snap;
    stats.containmentEnabled = snap.containmentEnabled;
  } catch {
    /* */
  }
  try {
    const { setWatcherLaneLatency } =
      require('./watchPipeline') as typeof import('./watchPipeline');
    setWatcherLaneLatency(
      wActive?.latencyMs != null && Number.isFinite(wActive.latencyMs)
        ? wActive.latencyMs
        : 'â€”'
    );
  } catch {
    /* optional */
  }
  return stats;
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
      ? 'utility'
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
            // Convert micro-lamports/CU â†’ store approximate lamports for UI (assume 200k CU)
            lastPriorityFeeLamports = Math.ceil(
              (estimated * 200_000) / 1_000_000
            );
            console.log(
              `[rpc] Priority fee ~${estimated} ÂµLamports/CU (est. ${lastPriorityFeeLamports} lamports)`
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
  return withRpc(
    'sendRawTransaction',
    async (conn) => {
      const sig = await conn.sendRawTransaction(serialized, {
        skipPreflight: options.skipPreflight ?? false,
        maxRetries: options.maxRetries ?? 3,
        preflightCommitment: 'confirmed',
      });
      await conn.confirmTransaction(sig, 'confirmed');
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
      await conn.confirmTransaction(sig, 'confirmed');
      return sig;
    },
    'primary'
  );
}

/**
 * Load keypair for the active trading wallet (or a specific slot id).
 * Secrets come only from env vars (TRADING_WALLET_* / PRIVATE_KEY) â€” never from API/disk.
 */
export function getKeypair(walletId?: string): Keypair | null {
  const id =
    walletId ??
    config.activeTradingWalletId ??
    getActiveTradingWallet()?.id ??
    null;

  if (!id) {
    console.warn(
      '[connection] No active trading wallet configured â€” live trading disabled'
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
      `[connection] No key in env for ${slot.name} â€” set ${slot.envVar}` +
        (slot.role === 'main' ? ' (or PRIVATE_KEY)' : '')
    );
    return null;
  }

  try {
    const kp = Keypair.fromSecretKey(bs58.decode(secret));
    keypairCache.set(id, kp);
    console.log(
      `[connection] Loaded trading wallet "${slot.name}" â†’ ${kp.publicKey.toBase58()}`
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
      `[connection] RPC OK â€” ${getActiveEndpointLabel('primary')} latency ${endpoints[primaryIdx].latencyMs}ms`
    );
    return true;
  }

  await maybeSwitchEndpoints();
  const retryIdx = resolveIndexForRole('primary');
  const retry = await probeEndpoint(retryIdx, 6_000);
  if (retry) {
    console.log(
      `[connection] RPC OK after failover â†’ ${getActiveEndpointLabel('primary')}`
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
  push(preferredWatchers);
  push(preferredQuicknode);
  push(activePrimary);
  push(activeSecondary);
  push(activeUtility);
  push(activeWatchers);
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

  /** Sparse probes — exclusive keys stay warm without getSlot storms. */
  function shouldProbeIndex(index: number, cycle: number): boolean {
    const state = endpoints[index];
    if (!state) return false;
    if (isEndpointHardFailed(state)) return false;
    const isPublic = isPublicRpcUrl(state.endpoint.url);
    const isActive =
      index === activePrimary ||
      index === activeSecondary ||
      index === activeUtility ||
      index === activeWatchers;
    const isPreferred =
      index === preferredPrimary ||
      index === preferredSecondary ||
      index === preferredUtility ||
      index === preferredWatchers;
    // Active / preferred exclusive keys: every 2nd cycle (~90s).
    if (isActive || isPreferred) {
      if (
        state.latencyStressedSince != null &&
        state.latencyMs != null &&
        state.latencyMs >= LATENCY_STRESS_MS
      ) {
        return cycle % 3 === 0;
      }
      return cycle % 2 === 0;
    }
    // Emergency publics / idle fallbacks: rare.
    if (isPublic) return cycle % 5 === 0;
    if (
      index === preferredQuicknode ||
      state.endpoint.label === 'quicknode' ||
      isQuicknodeRpcUrl(state.endpoint.url)
    ) {
      if (!state.healthy) return cycle % 8 === 0;
      return cycle % 4 === 0;
    }
    return cycle % 5 === 0;
  }

  // Boot: preferred exclusives first, then emergency publics (sparse).
  void (async () => {
    const order: number[] = [];
    const push = (i: number) => {
      if (i >= 0 && i < endpoints.length && !order.includes(i)) order.push(i);
    };
    push(preferredPrimary);
    push(preferredSecondary);
    push(preferredWatchers);
    push(preferredUtility);
    push(preferredQuicknode);
    for (let i = 0; i < endpoints.length; i++) {
      if (!isPublicRpcUrl(endpoints[i]?.endpoint.url || '')) push(i);
    }
    for (let i = 0; i < endpoints.length; i++) {
      if (isPublicRpcUrl(endpoints[i]?.endpoint.url || '')) push(i);
    }
    for (const i of order) {
      await probeEndpoint(i);
      await new Promise((r) => setTimeout(r, 350));
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
          i === activeUtility ||
          i === activeWatchers;
        const isPreferred =
          i === preferredPrimary ||
          i === preferredSecondary ||
          i === preferredUtility ||
          i === preferredWatchers ||
          i === preferredQuicknode;
        if (gateSnap.stressed && !isActive && !isPreferred) {
          continue;
        }
        await probeEndpoint(i);
        await new Promise((r) => setTimeout(r, gateSnap.stressed ? 400 : 250));
      }
      await maybeSwitchEndpoints();
    })();
  }, interval);

  console.log(
    `[rpc] Health monitor started (every ${interval}ms; exclusive keys ~2x, emergency publics rare) — endpoints: ` +
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
