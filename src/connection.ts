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
  inferRpcProvider,
  inferRpcPoolSlot,
  type RpcLaneRole,
  type RpcProviderKind,
  type RpcPoolSlot,
} from './rpcUrl';
import {
  acquireRpcLane,
  getRpcGateSnapshot,
  isRpcGateSkipError,
} from './rpcGate';

dotenv.config();

const DEFAULT_RPC = PUBLIC_SOLANA_RPC;

/** Workload lane — primary=critical; secondary=scanners/Zion; utility=import/activity */
export type RpcRole = 'primary' | 'secondary' | 'utility';

export interface RpcEndpoint {
  url: string;
  label: string;
  /** Optional dedicated websocket URL */
  wsUrl?: string;
  role?: RpcLaneRole;
  provider?: RpcProviderKind;
  slot?: RpcPoolSlot;
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
  /** Preferred endpoint for primary, secondary, utility, or pool backup / fallback */
  lane?: string | null;
  provider?: RpcProviderKind;
  slot?: RpcPoolSlot;
}

export type RpcMemberHealthState = 'healthy' | 'degraded' | 'down';
export type RpcLastErrorKind =
  | '429'
  | 'timeout'
  | '5xx'
  | 'quota'
  | 'auth'
  | 'none'
  | 'other';

export interface RpcPoolMemberStats {
  label: string;
  slot: RpcPoolSlot;
  host: string;
  state: RpcMemberHealthState;
  lastError: RpcLastErrorKind;
  lastErrorDetail?: string;
  lastSuccessAgeMs: number | null;
  latencyEwmaMs: number | null;
  isActive: boolean;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  /** Hard-fail / rate-limit cooldown remaining (ms). */
  cooldownRemainingMs: number;
}

/** How primary+backup are used within a provider pool. */
export type RpcPoolShareMode =
  | 'empty'
  | 'solo'
  | 'sharing'
  | 'primary_only'
  | 'failover'
  | 'down';

export interface RpcProviderPoolStats {
  provider: 'helius' | 'alchemy';
  members: RpcPoolMemberStats[];
  activeLabel: string | null;
  state: RpcMemberHealthState | 'empty';
  /** empty | solo | sharing (both healthy) | primary_only | failover (on backup) | down */
  shareMode: RpcPoolShareMode;
  /** Short operator line for Stats → RPC. */
  shareLabel: string;
  lastFailoverAt: number | null;
  failoverCountRecent: number;
  configured: boolean;
  hasBackup: boolean;
  primaryConfigured: boolean;
  backupConfigured: boolean;
  /** ready when a distinct backup endpoint is in the pool; else unset */
  backupStatus: 'ready' | 'unset';
  /** Env keys present (not values) — helps diagnose “not configured” when Render vars exist but are invalid. */
  envPrimaryPresent: boolean;
  envBackupPresent: boolean;
  /** Soft-sticky remaining for this provider (Critical/Scanners lanes). */
  softStickyRemainingMs: number;
  preferredDownForMs: number;
}

export type RpcHealthSummary =
  | 'all_healthy'
  | 'degraded'
  | 'failover_active'
  | 'provider_down';

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
  /** Consecutive successes while recovering (need ≥2 to clear quarantine / re-arm). */
  consecutiveSuccesses: number;
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
  provider: RpcProviderKind;
  slot: RpcPoolSlot;
  /** Last successful probe/call timestamp */
  lastSuccessAt: number | null;
}

let endpoints: EndpointState[] = [];
/** Preferred index for each lane */
let preferredPrimary = 0;
let preferredSecondary = 0;
let preferredUtility = 0;
/** Mid-tier paid failover (QuickNode); -1 when unset */
let preferredQuicknode = -1;
/** Currently resolved index serving each lane (may differ after failover) */
let activePrimary = 0;
let activeSecondary = 0;
let activeUtility = 0;
/** Legacy single active pointer — mirrors primary lane for older callers */
let activeIndex = 0;
/** Indices belonging to Helius / Alchemy dual pools */
let heliusPoolIndices: number[] = [];
let alchemyPoolIndices: number[] = [];
/** Round-robin cursors (read path) */
let heliusRrCursor = 0;
let alchemyRrCursor = 0;
/** Recent failover counters (rolling 10m window) */
const failoverEvents: Array<{ at: number; provider: string }> = [];
let lastHeliusFailoverAt: number | null = null;
let lastAlchemyFailoverAt: number | null = null;

const rpcRoleAls = new AsyncLocalStorage<RpcRole>();
/** Optional feature tag for call metering (wallet_poll, health_probe, …). */
const rpcFeatureAls = new AsyncLocalStorage<string>();
/** >0 when already inside an acquired lane gate (nested runWithRpcRole). */
const rpcGateDepthAls = new AsyncLocalStorage<number>();

/** Cached keypairs by trading wallet id — secrets never leave process memory */
const keypairCache = new Map<string, Keypair>();
let healthTimer: ReturnType<typeof setInterval> | null = null;
let started = false;
/** Prevent overlapping health probe cycles (boot / interval / probeRpcRecovery). */
let healthProbeRunning = false;
/** Successes required before clearing quarantine / unhealthy. */
const RECOVERY_SUCCESS_NEEDED = 2;

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
/** Soft sticky: stay on sibling after latency failover (key = role:provider). */
const softStickyUntil = new Map<string, number>();

function softStickyKey(role: RpcRole, provider: string): string {
  return `${role}:${provider}`;
}

function trimCallMeterIfNeeded(): void {
  if (callMeter.size <= CALL_METER_MAX_KEYS) return;
  callMeter.clear();
  callMeterStartedAt = Date.now();
}

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
  trimCallMeterIfNeeded();
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

function meteredFetch(endpointLabel: string) {
  const baseFetch = globalThis.fetch.bind(globalThis);
  return async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const methods = parseRpcMethodsFromBody(init?.body);
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
        });
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
      throw err;
    }
  };
}

/** Default cross-lane piggyback grace — preferred must stay unhealthy this long. */
const DEFAULT_FAILOVER_DOWN_MS = 30_000;
/** Floor so env typos cannot collapse failover to zero. */
const MIN_FAILOVER_DOWN_MS = 5_000;
/** After a 429, leave the hot endpoint alone so failover can breathe. */
function rateLimitCooldownMs(): number {
  const n = Number(process.env.RPC_HEALTH_COOLDOWN_MS);
  if (Number.isFinite(n) && n >= 5_000) return Math.min(300_000, n);
  return 60_000;
}
/** Dead/failing endpoints: base quarantine (escalates with streak). */
const HARD_FAIL_COOLDOWN_MS = 5 * 60_000;
const HARD_FAIL_COOLDOWN_MAX_MS = 20 * 60_000;
/** Cap withRpc endpoint walks — avoid retry storms across every fallback. */
function withRpcMaxAttemptsCritical(): number {
  const n = Number(process.env.RPC_MAX_RETRIES);
  if (Number.isFinite(n) && n >= 1) return Math.min(8, Math.floor(n) + 1);
  return 4;
}
function withRpcMaxAttemptsOther(): number {
  const n = Number(process.env.RPC_MAX_RETRIES);
  if (Number.isFinite(n) && n >= 1) return Math.min(6, Math.floor(n));
  return 3;
}
/** Don't re-log "marked unhealthy" more often than this. */
const UNHEALTHY_LOG_THROTTLE_MS = 15_000;
/** EWMA weight for new samples — dampens single getTransaction spikes in the UI. */
const LATENCY_EWMA_ALPHA = 0.22;
/**
 * Paid Helius/Alchemy from Render often sit ~800–1200ms. Old 500ms threshold
 * kept soft-failover armed forever and thrashed primary↔backup.
 */
const LATENCY_STRESS_MS_PAID = 1_400;
const LATENCY_STRESS_MS_PUBLIC = 500;
/** Hysteresis clear — must be below stress so a ~1s plateau can recover. */
const LATENCY_RECOVER_MS_PAID = 1_000;
const LATENCY_RECOVER_MS_PUBLIC = 320;
/**
 * Utility may soft-fail onto QuickNode only when preferred EWMA is this hot
 * (after public/fallback alternatives) and QN is not already serving Critical/Scanners.
 */
const UTILITY_QUICKNODE_STRESS_MS = 1000;
/** Prefer piggyback after preferred stays latency-stressed this long. */
const LATENCY_STRESS_GRACE_MS = 20_000;
/** Public Solana is often chronically slow from cloud hosts — fail over sooner. */
const LATENCY_STRESS_GRACE_PUBLIC_MS = 5_000;
/** Don't re-log latency / pool failover more often than this. */
const LATENCY_FAILOVER_LOG_THROTTLE_MS = 60_000;
/** Cap single samples so one 8s probe timeout cannot pin EWMA forever. */
const LATENCY_SAMPLE_CAP_MS = 2_500;
/** After a latency soft-failover to sibling, stay put this long (no RR flip-back). */
const LATENCY_SOFT_STICKY_MS = 90_000;
const FAILOVER_COUNT_WINDOW_MS = 10 * 60_000;
/** Reset call-meter map when it grows past this (unbounded feature×method keys). */
const CALL_METER_MAX_KEYS = 180;

function latencyStressMs(state: EndpointState | undefined): number {
  if (state && isPublicRpcUrl(state.endpoint.url)) return LATENCY_STRESS_MS_PUBLIC;
  return LATENCY_STRESS_MS_PAID;
}

function latencyRecoverMs(state: EndpointState | undefined): number {
  if (state && isPublicRpcUrl(state.endpoint.url)) return LATENCY_RECOVER_MS_PUBLIC;
  return LATENCY_RECOVER_MS_PAID;
}

function latencyStressGraceMs(state: EndpointState | undefined): number {
  if (state && isPublicRpcUrl(state.endpoint.url)) {
    return LATENCY_STRESS_GRACE_PUBLIC_MS;
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

function isRpcQuotaMessage(error: string): boolean {
  return /credit|quota|insufficient|payment.?required|exceeded.*limit|out of credits|usage limit/i.test(
    error
  );
}

function isRpc5xxMessage(error: string): boolean {
  return /\b5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout/i.test(
    error
  );
}

function classifyRpcError(error: string | undefined): RpcLastErrorKind {
  if (!error) return 'none';
  if (isRpcRateLimitMessage(error)) return '429';
  if (isRpcQuotaMessage(error)) return 'quota';
  if (
    /\b401\b|\b403\b|unauthorized|forbidden|invalid api|invalid.?key|api[- ]?key.*(invalid|missing|denied)/i.test(
      error
    )
  ) {
    return 'auth';
  }
  if (/timeout|timed out|probe timeout/i.test(error)) return 'timeout';
  if (isRpc5xxMessage(error)) return '5xx';
  if (
    /ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up|fetch failed/i.test(error)
  ) {
    return 'other';
  }
  return 'other';
}

function noteFailoverEvent(provider: string): void {
  const now = Date.now();
  failoverEvents.push({ at: now, provider });
  while (
    failoverEvents.length &&
    now - failoverEvents[0]!.at > FAILOVER_COUNT_WINDOW_MS
  ) {
    failoverEvents.shift();
  }
  if (provider === 'helius') lastHeliusFailoverAt = now;
  if (provider === 'alchemy') lastAlchemyFailoverAt = now;
}

function failoverCountRecent(provider?: string): number {
  const now = Date.now();
  return failoverEvents.filter(
    (e) =>
      now - e.at <= FAILOVER_COUNT_WINDOW_MS &&
      (!provider || e.provider === provider)
  ).length;
}

function slotLabel(slot: RpcPoolSlot): string {
  if (slot === 'backup') return 'backup';
  if (slot === 'primary') return 'primary';
  return 'solo';
}

function isEndpointUsable(state: EndpointState | undefined): boolean {
  if (!state) return false;
  if (isEndpointRateLimited(state) || isEndpointHardFailed(state)) return false;
  return state.healthy;
}

/** Preferred fully recovered after quarantine/unhealthy — needs repeated successes. */
function isFullyRecovered(state: EndpointState | undefined): boolean {
  if (!isEndpointUsable(state)) return false;
  return (state!.consecutiveSuccesses || 0) >= RECOVERY_SUCCESS_NEEDED;
}

function endpointCooldownRemainingMs(state: EndpointState): number {
  const now = Date.now();
  return Math.max(
    0,
    Math.max(state.hardFailUntil || 0, state.rateLimitedUntil || 0) - now
  );
}

function softStickyRemainingMsForProvider(
  provider: 'helius' | 'alchemy'
): number {
  const now = Date.now();
  let maxRem = 0;
  for (const role of ['primary', 'secondary'] as RpcRole[]) {
    const until = softStickyUntil.get(softStickyKey(role, provider)) || 0;
    maxRem = Math.max(maxRem, until - now);
  }
  return Math.max(0, maxRem);
}

function poolIndicesFor(provider: 'helius' | 'alchemy'): number[] {
  return provider === 'helius' ? heliusPoolIndices : alchemyPoolIndices;
}

/** Round-robin among healthy pool members (read path). */
function pickRoundRobinFromPool(provider: 'helius' | 'alchemy'): number {
  const idxs = poolIndicesFor(provider);
  if (!idxs.length) return -1;
  const cursor = provider === 'helius' ? heliusRrCursor : alchemyRrCursor;
  for (let step = 0; step < idxs.length; step++) {
    const i = idxs[(cursor + step) % idxs.length]!;
    if (isEndpointUsable(endpoints[i])) {
      if (provider === 'helius') heliusRrCursor = cursor + step + 1;
      else alchemyRrCursor = cursor + step + 1;
      return i;
    }
  }
  return -1;
}

/** Lowest EWMA among healthy (send / critical confirm path). */
function pickHealthiestFromPool(provider: 'helius' | 'alchemy'): number {
  const idxs = poolIndicesFor(provider);
  let best = -1;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const i of idxs) {
    const e = endpoints[i];
    if (!isEndpointUsable(e)) continue;
    const ms = e!.latencyMs ?? 9999;
    if (ms < bestMs) {
      bestMs = ms;
      best = i;
    }
  }
  return best;
}

function pickSibling(
  fromIndex: number,
  provider: 'helius' | 'alchemy'
): number {
  const idxs = poolIndicesFor(provider);
  for (const i of idxs) {
    if (i === fromIndex) continue;
    if (isEndpointUsable(endpoints[i])) return i;
  }
  return -1;
}

function logPoolFailover(
  provider: 'helius' | 'alchemy',
  fromIdx: number,
  toIdx: number,
  reason: string
): void {
  const from = endpoints[fromIdx];
  const to = endpoints[toIdx];
  if (!from || !to) return;
  const now = Date.now();
  const throttleMs =
    reason === 'latency'
      ? LATENCY_FAILOVER_LOG_THROTTLE_MS
      : Math.min(30_000, LATENCY_FAILOVER_LOG_THROTTLE_MS);
  const skipLog =
    now - (from.lastLatencyFailoverLogAt || 0) < throttleMs &&
    reason === 'latency';
  if (!skipLog) {
    from.lastLatencyFailoverLogAt = now;
    const toBackup =
      to.slot === 'backup' ||
      (from.provider === to.provider && from.slot !== to.slot);
    if (toBackup && from.provider === to.provider) {
      console.warn(
        `rpc_failover_to_backup provider=${provider} from=${slotLabel(from.slot)} to=${slotLabel(to.slot)} reason=${reason}`
      );
    } else {
      console.warn(
        `rpc_failover_to_provider from=${from.provider} to=${to.provider} reason=${reason}`
      );
    }
  }
  // Count at most once per throttle window for latency (stops UI ×38 spam).
  if (reason !== 'latency' || !skipLog) {
    noteFailoverEvent(provider);
  }
}

function logCrossProviderFailover(
  fromProvider: 'helius' | 'alchemy',
  toProvider: 'helius' | 'alchemy',
  reason: string
): void {
  console.warn(
    `rpc_failover_to_provider from=${fromProvider} to=${toProvider} reason=${reason}`
  );
  noteFailoverEvent(fromProvider);
}

function endpointHostMasked(url: string): string {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return url.slice(0, 40);
  }
}

function memberHealthState(state: EndpointState): RpcMemberHealthState {
  if (isEndpointHardFailed(state) || (!state.healthy && isEndpointRateLimited(state))) {
    return 'down';
  }
  if (
    !state.healthy ||
    isEndpointRateLimited(state) ||
    state.latencyStressedSince != null
  ) {
    return 'degraded';
  }
  return 'healthy';
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
  ensureEndpoints();
  // Observational only — do not resolve/failover from status/soft-watch checks.
  const idx =
    activeUtility >= 0 && activeUtility < endpoints.length
      ? activeUtility
      : preferredUtility;
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
    // Custom RPC_URL / mid-tier fallback — prefer over publicnode/mainnet-beta.
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
    const provider =
      endpoint.provider || inferRpcProvider(endpoint.url, endpoint.label);
    const slot =
      endpoint.slot || inferRpcPoolSlot(endpoint.label, provider);
    return {
      endpoint: { ...endpoint, role, provider, slot },
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
      consecutiveSuccesses: 0,
      unhealthySince: null,
      role,
      rateLimitedUntil: 0,
      hardFailUntil: 0,
      quarantineStreak: 0,
      lastQuarantineLogAt: 0,
      lastUnhealthyLogAt: 0,
      latencyStressedSince: null,
      lastLatencyFailoverLogAt: 0,
      provider,
      slot,
      lastSuccessAt: null,
    };
  });

  heliusPoolIndices = endpoints
    .map((e, i) => (e.provider === 'helius' ? i : -1))
    .filter((i) => i >= 0);
  alchemyPoolIndices = endpoints
    .map((e, i) => (e.provider === 'alchemy' ? i : -1))
    .filter((i) => i >= 0);

  preferredPrimary = Math.max(
    0,
    endpoints.findIndex((e) => e.role === 'primary')
  );
  // Prefer first Helius pool member as Critical preferred when present
  if (heliusPoolIndices.length) {
    preferredPrimary = heliusPoolIndices[0]!;
  }
  const secIdx = endpoints.findIndex((e) => e.role === 'secondary');
  preferredSecondary =
    alchemyPoolIndices.length > 0
      ? alchemyPoolIndices[0]!
      : secIdx >= 0
        ? secIdx
        : preferredPrimary;
  const utilIdx = endpoints.findIndex((e) => e.role === 'utility');
  preferredUtility = pickPreferredUtilityIndex();
  if (utilIdx >= 0 && preferredUtility !== utilIdx) {
    console.log(
      `[rpc] Utility preferred ${endpoints[preferredUtility]?.endpoint.label} ` +
        `(stronger than role-utility ${endpoints[utilIdx]?.endpoint.label})`
    );
  }
  preferredQuicknode = endpoints.findIndex(
    (e) =>
      e.endpoint.label === 'quicknode' || isQuicknodeRpcUrl(e.endpoint.url)
  );
  activePrimary = preferredPrimary;
  activeSecondary = preferredSecondary;
  activeUtility = preferredUtility;
  activeIndex = activePrimary;

  console.log(
    `[rpc] Initialized ${endpoints.length} endpoint(s): ` +
      endpoints
        .map((e) => `${e.endpoint.label}[${e.role}/${e.provider}]`)
        .join(', ')
  );
  console.log(
    `[rpc] Lanes — primary→${endpoints[preferredPrimary]?.endpoint.label} ` +
      `(${maskUrlForLog(endpoints[preferredPrimary]?.endpoint.url)}) · ` +
      `secondary→${endpoints[preferredSecondary]?.endpoint.label} ` +
      `(${maskUrlForLog(endpoints[preferredSecondary]?.endpoint.url)}) · ` +
      `utility→${endpoints[preferredUtility]?.endpoint.label} ` +
      `(${maskUrlForLog(endpoints[preferredUtility]?.endpoint.url)})` +
      (preferredQuicknode >= 0
        ? ` · mid-tier→${endpoints[preferredQuicknode]?.endpoint.label}`
        : '') +
      (heliusPoolIndices.length > 1
        ? ` · heliusPool×${heliusPoolIndices.length}`
        : '') +
      (alchemyPoolIndices.length > 1
        ? ` · alchemyPool×${alchemyPoolIndices.length}`
        : '') +
      ` · cross-lane failover after ${formatFailoverGrace(failoverDownMs())} down` +
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
  const stored = rpcRoleAls.getStore();
  if (stored) return stored;
  // Ungated getConnection() callers (curves, metrics, logs) must not burn
  // Helius/Alchemy when Share load is on — send them to public/utility.
  if (Boolean(config.rpc?.shareLoad)) return 'utility';
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
  if (role === 'utility') return preferredUtility;
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
  } else {
    activeUtility = index;
  }
}

function piggybackOrder(role: RpcRole): RpcRole[] {
  // Critical: Helius → Alchemy → (QuickNode mid-tier) → public.
  // Scanners: Alchemy → Helius → (QuickNode) → public.
  // Utility: public → (QN only if ~1000ms stressed and not busy) → Alchemy → Helius.
  // Paid cross-lane only here; QuickNode + utility are inserted after in resolve/withRpc.
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
        : activeUtility;
  if (active !== altIdx) {
    const reason = rateLimited
      ? 'rate-limited'
      : latencySoft
        ? `latency EWMA ${pref?.latencyMs ?? '—'}ms ≥ ${latencyStressMs(pref)}ms for ${Math.round(latencyStressGraceMs(pref) / 1000)}s`
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
  const preferred = preferredIndexFor(role);
  const pref = endpoints[preferred];
  const latencySoft = latencyFailoverReady(pref);
  const shareLoad = Boolean(config.rpc?.shareLoad);

  // In-provider pool: RR (reads) / healthiest (primary send-ish) while healthy
  const preferProvider: 'helius' | 'alchemy' | null =
    role === 'primary' && heliusPoolIndices.length
      ? 'helius'
      : role === 'secondary' && alchemyPoolIndices.length
        ? 'alchemy'
        : null;

  if (preferProvider && shareLoad) {
    const stickyKey = softStickyKey(role, preferProvider);
    const stickyUntil = softStickyUntil.get(stickyKey) || 0;
    const cur =
      role === 'primary'
        ? activePrimary
        : role === 'secondary'
          ? activeSecondary
          : activeUtility;
    const curUsableSibling =
      cur !== preferred &&
      cur >= 0 &&
      endpoints[cur] &&
      isEndpointUsable(endpoints[cur]) &&
      endpoints[cur]!.provider === preferProvider;

    if (stickyUntil > Date.now()) {
      // Stay on last active sibling during soft-sticky window (stops RR flip-back).
      if (curUsableSibling) {
        return cur;
      }
    } else if (stickyUntil) {
      softStickyUntil.delete(stickyKey);
    }

    // Prefer stay on backup/sibling until preferred fully recovers (2 successes).
    if (curUsableSibling && !isFullyRecovered(pref)) {
      return cur;
    }

    const feature = rpcFeatureAls.getStore() || '';
    const sendish = /send|confirm|rawTransaction|legacy/i.test(feature);
    const poolPick = sendish
      ? pickHealthiestFromPool(preferProvider)
      : pickRoundRobinFromPool(preferProvider);
    if (poolPick >= 0) {
      const picked = endpoints[poolPick]!;
      if (
        picked.healthy &&
        !isEndpointRateLimited(picked) &&
        !(poolPick === preferred && latencySoft)
      ) {
        // Soft latency on preferred: only RR to sibling if meaningfully faster
        if (latencySoft && poolPick === preferred) {
          const sib = pickSibling(preferred, preferProvider);
          if (sib >= 0 && isFasterAlternate(pref!, endpoints[sib]!)) {
            logPoolFailover(
              preferProvider,
              preferred,
              sib,
              'latency'
            );
            softStickyUntil.set(
              softStickyKey(role, preferProvider),
              Date.now() + LATENCY_SOFT_STICKY_MS
            );
            setActiveForRole(role, sib);
            return sib;
          }
          // Sibling not faster — stay on preferred (no thrash)
          setActiveForRole(role, preferred);
          return preferred;
        } else if (!latencySoft || poolPick !== preferred) {
          setActiveForRole(role, poolPick);
          return poolPick;
        }
      }
    }
  }

  // Utility: if preferred is weak public but a stronger non-public/rpc-url is healthy, prefer it.
  if (role === 'utility' && pref && isWeakPublicUtilityUrl(pref.endpoint.url)) {
    for (let i = 0; i < endpoints.length; i++) {
      if (i === preferred) continue;
      const e = endpoints[i];
      if (!e?.healthy || !isStrongUtilityEndpoint(e)) continue;
      setActiveForRole(role, i);
      return i;
    }
  }

  if (pref?.healthy && !isEndpointRateLimited(pref) && !latencySoft) {
    setActiveForRole(role, preferred);
    return preferred;
  }

  const downMs = downForMs(pref);
  const rateLimited = isEndpointRateLimited(pref);
  const avoidPublicForCritical = shareLoad && role === 'primary';

  // Sibling-first: same provider pool before sticky grace / cross-provider
  if (pref && preferProvider) {
    const hard = !pref.healthy || rateLimited || isEndpointHardFailed(pref);
    if (hard || latencySoft) {
      const sib = pickSibling(preferred, preferProvider);
      if (sib >= 0) {
        const sibState = endpoints[sib]!;
        // Latency soft-failover only when sibling is meaningfully faster —
        // otherwise both ~1s endpoints thrash forever with zero benefit.
        if (
          latencySoft &&
          !hard &&
          !isFasterAlternate(pref, sibState)
        ) {
          setActiveForRole(role, preferred);
          return preferred;
        }
        const reason = rateLimited
          ? '429'
          : isRpcQuotaMessage(pref.lastError || '')
            ? 'quota'
            : latencySoft
              ? 'latency'
              : classifyRpcError(pref.lastError);
        logPoolFailover(preferProvider, preferred, sib, String(reason));
        if (latencySoft && !hard) {
          softStickyUntil.set(
            softStickyKey(role, preferProvider),
            Date.now() + LATENCY_SOFT_STICKY_MS
          );
        }
        setActiveForRole(role, sib);
        return sib;
      }
      // Whole provider unhealthy — try other paid pool
      const otherProv: 'helius' | 'alchemy' =
        preferProvider === 'helius' ? 'alchemy' : 'helius';
      const cross =
        role === 'primary' || role === 'secondary'
          ? pickHealthiestFromPool(otherProv)
          : pickRoundRobinFromPool(otherProv);
      if (cross >= 0) {
        const reason = rateLimited
          ? '429'
          : isRpcQuotaMessage(pref.lastError || '')
            ? 'quota'
            : latencySoft
              ? 'latency'
              : classifyRpcError(pref.lastError);
        logCrossProviderFailover(preferProvider, otherProv, String(reason));
        setActiveForRole(role, cross);
        return cross;
      }
    }
  }

  // Sticky grace for hard failures only — latency soft-failover skips this wait.
  if (
    !latencySoft &&
    !rateLimited &&
    downMs > 0 &&
    downMs < failoverDownMs()
  ) {
    return preferred;
  }

  // Utility + public preferred is slow: try another public/fallback
  // before burning Alchemy/Helius/QuickNode CU on wallet polls.
  // Prefer stronger utility (rpc-url) over weak publicnode when both healthy.
  if (latencySoft && role === 'utility' && pref) {
    let bestIdx = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let i = 0; i < endpoints.length; i++) {
      if (i === preferred) continue;
      const e = endpoints[i];
      if (!e?.healthy || isEndpointRateLimited(e) || isEndpointHardFailed(e))
        continue;
      if (
        e.endpoint.label === 'quicknode' ||
        isQuicknodeRpcUrl(e.endpoint.url)
      ) {
        continue;
      }
      // Official mainnet-beta getSlot looks fast but wallet polls stay slow — never soft-pick it.
      if (isOfficialMainnetBetaRpcUrl(e.endpoint.url)) {
        continue;
      }
      const isAltPublic =
        isPublicRpcUrl(e.endpoint.url) ||
        e.role === 'fallback' ||
        e.role === 'utility';
      if (!isAltPublic) continue;
      if (!isFasterAlternate(pref, e) && isWeakPublicUtilityUrl(e.endpoint.url))
        continue;
      const weakPenalty = isWeakPublicUtilityUrl(e.endpoint.url) ? 450 : 0;
      const strongBonus = isStrongUtilityEndpoint(e) ? -300 : 0;
      const score = (e.latencyMs ?? 2_000) + weakPenalty + strongBonus;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      const other = endpoints[bestIdx]!;
      const now = Date.now();
      // Anti-thrash: stay on current weak failover instead of hopping publicnode↔mainnet-beta.
      if (
        isWeakPublicUtilityUrl(other.endpoint.url) &&
        isWeakPublicUtilityUrl(endpoints[activeUtility]?.endpoint.url || '') &&
        activeUtility !== preferred &&
        activeUtility >= 0 &&
        now - lastUtilityFailoverAt < UTILITY_FAILOVER_STICKY_MS
      ) {
        setActiveForRole(role, activeUtility);
        return activeUtility;
      }
      if (now - (pref.lastLatencyFailoverLogAt || 0) >= LATENCY_FAILOVER_LOG_THROTTLE_MS) {
        pref.lastLatencyFailoverLogAt = now;
        console.warn(
          `[rpc] utility lane failover → ${other.endpoint.label}` +
            (isWeakPublicUtilityUrl(other.endpoint.url)
              ? ' (weak public — Favourites/activity will slow)'
              : isStrongUtilityEndpoint(other)
                ? ' (strong utility preferred)'
                : '') +
            ` (from ${pref.endpoint.label} EWMA ${pref.latencyMs ?? '—'}ms)`
        );
      }
      lastUtilityFailoverAt = now;
      lastUtilityFailoverIdx = bestIdx;
      setActiveForRole(role, bestIdx);
      return bestIdx;
    }
    // No fast public: allow QuickNode only under severe load (~1000ms) when free.
    if (utilityMayUseQuicknodeSoft(pref)) {
      const qn = endpoints[preferredQuicknode]!;
      const now = Date.now();
      if (now - (pref.lastLatencyFailoverLogAt || 0) >= LATENCY_FAILOVER_LOG_THROTTLE_MS) {
        pref.lastLatencyFailoverLogAt = now;
        console.warn(
          `[rpc] utility lane piggybacking on ${qn.endpoint.label} ` +
            `(EWMA ${pref.latencyMs ?? '—'}ms ≥ ${UTILITY_QUICKNODE_STRESS_MS}ms — ` +
            `QuickNode free of Critical/Scanners failover)`
        );
      }
      setActiveForRole(role, preferredQuicknode);
      return preferredQuicknode;
    }
    // Share ON: stay sticky on preferred only while it is still usable.
    // Dead/quarantined publicnode must not pin Favourites forever.
    if (shareLoad && isEndpointUsable(pref)) {
      setActiveForRole(role, preferred);
      return preferred;
    }
  }

  // 1) Other paid free lane (Helius ↔ Alchemy)
  // Share+Utility: skip paid-lane piggyback (soft-watch must not burn Critical/Scanners).
  if (!(shareLoad && role === 'utility')) {
    for (const otherRole of piggybackOrder(role)) {
      const otherPreferred = preferredIndexFor(otherRole);
      if (
        acceptFailoverTarget(
          role,
          preferred,
          pref,
          otherPreferred,
          latencySoft,
          rateLimited,
          downMs,
          avoidPublicForCritical
        )
      ) {
        return otherPreferred;
      }
    }
  }

  // 2) QuickNode mid-tier (Critical + Scanners only; skip if unset/unhealthy)
  if (role === 'primary' || role === 'secondary') {
    if (
      acceptFailoverTarget(
        role,
        preferred,
        pref,
        preferredQuicknode,
        latencySoft,
        rateLimited,
        downMs,
        avoidPublicForCritical
      )
    ) {
      return preferredQuicknode;
    }
    // 3) Utility / public before remaining fallbacks
    if (
      acceptFailoverTarget(
        role,
        preferred,
        pref,
        preferredUtility,
        latencySoft,
        rateLimited,
        downMs,
        avoidPublicForCritical
      )
    ) {
      return preferredUtility;
    }
  }

  for (let i = 0; i < endpoints.length; i++) {
    if (!endpoints[i]?.healthy || isEndpointRateLimited(endpoints[i])) continue;
    if (avoidPublicForCritical && isPublicRpcUrl(endpoints[i].endpoint.url)) {
      continue;
    }
    // Share+Utility: only public/fallback/utility (or QN if severe) — never Helius/Alchemy.
    if (shareLoad && role === 'utility') {
      const e = endpoints[i]!;
      const isQn =
        e.endpoint.label === 'quicknode' || isQuicknodeRpcUrl(e.endpoint.url);
      const isAltPublic =
        isPublicRpcUrl(e.endpoint.url) ||
        e.role === 'fallback' ||
        e.role === 'utility';
      if (!isAltPublic && !(isQn && pref && utilityMayUseQuicknodeSoft(pref))) {
        continue;
      }
    }
    // Utility soft-failover: skip QuickNode unless severe stress and QN is free
    if (
      role === 'utility' &&
      latencySoft &&
      (endpoints[i]!.endpoint.label === 'quicknode' ||
        isQuicknodeRpcUrl(endpoints[i]!.endpoint.url)) &&
      !(pref && utilityMayUseQuicknodeSoft(pref))
    ) {
      continue;
    }
    if (latencySoft && pref && i !== preferred && !isFasterAlternate(pref, endpoints[i]!)) {
      continue;
    }
    setActiveForRole(role, i);
    return i;
  }

  // Last resort: any healthy endpoint (even public for critical)
  // Share+Utility: stay on preferred only when it is still usable — otherwise
  // allow any healthy host so Favourites are not pinned to a dead publicnode.
  if (shareLoad && role === 'utility' && isEndpointUsable(endpoints[preferred])) {
    setActiveForRole(role, preferred);
    return preferred;
  }
  for (let i = 0; i < endpoints.length; i++) {
    if (endpoints[i]?.healthy && !isEndpointRateLimited(endpoints[i])) {
      setActiveForRole(role, i);
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

export function getActiveEndpointLabel(role?: RpcRole): string {
  ensureEndpoints();
  const r = role ?? currentRole();
  const idx = resolveIndexForRole(r);
  return endpoints[idx]?.endpoint.label || 'unknown';
}

function recordSuccess(index: number, latencyMs: number): void {
  const state = endpoints[index];
  if (!state) return;
  const wasUnhealthy =
    !state.healthy ||
    state.rateLimitedUntil > Date.now() ||
    state.hardFailUntil > Date.now();
  state.successCount += 1;
  state.consecutiveSuccesses = (state.consecutiveSuccesses || 0) + 1;
  const sample = Math.min(LATENCY_SAMPLE_CAP_MS, Math.max(0, latencyMs));
  state.lastCallLatencyMs = sample;
  // EWMA so a single slow getTransaction does not paint the whole endpoint as 800ms+.
  state.latencyMs =
    state.latencyMs == null
      ? sample
      : Math.round(
          LATENCY_EWMA_ALPHA * sample + (1 - LATENCY_EWMA_ALPHA) * state.latencyMs
        );
  updateLatencyStress(state);
  state.consecutiveFailures = 0;
  state.lastCheckedAt = Date.now();
  state.lastSuccessAt = Date.now();
  state.lastError = undefined;

  // Recovery hysteresis: one lucky getSlot must not re-arm a bad primary.
  if (
    wasUnhealthy &&
    state.consecutiveSuccesses < RECOVERY_SUCCESS_NEEDED
  ) {
    return;
  }

  state.healthy = true;
  state.unhealthySince = null;
  // Clear cooldowns after repeated successes (including mid-cooldown recovery).
  state.rateLimitedUntil = 0;
  if (state.hardFailUntil) {
    const wasQ = state.hardFailUntil > 0;
    if (wasQ) {
      const now = Date.now();
      if (now - state.lastQuarantineLogAt >= 5_000) {
        state.lastQuarantineLogAt = now;
        console.log(
          `[rpc-quarantine] EXIT ${state.endpoint.label} — ${RECOVERY_SUCCESS_NEEDED} consecutive successes` +
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
  if (wasUnhealthy) {
    console.log(`rpc_recovered endpoint=${state.endpoint.label}`);
  }
}

function updateLatencyStress(state: EndpointState): void {
  const ewma = state.latencyMs;
  if (ewma == null) {
    state.latencyStressedSince = null;
    return;
  }
  if (ewma < latencyRecoverMs(state)) {
    state.latencyStressedSince = null;
    return;
  }
  if (ewma >= latencyStressMs(state)) {
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
  if (
    state.latencyMs == null ||
    state.latencyMs < latencyStressMs(state)
  ) {
    return false;
  }
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
  // Require clear win — ~same ~1s RTT must NOT flip.
  return (
    otherMs <= latencyRecoverMs(preferred) ||
    otherMs < prefMs * 0.7
  );
}

function recordFailure(index: number, error: string): void {
  const state = endpoints[index];
  if (!state) return;

  const isRateLimit = isRpcRateLimitMessage(error);
  const isQuota = isRpcQuotaMessage(error);
  const alreadyCooling = isEndpointRateLimited(state);
  const cooldownMs = rateLimitCooldownMs();

  // Already in 429 cooldown — count quietly, never re-log / re-switch thrash.
  if ((isRateLimit || isQuota) && alreadyCooling) {
    state.failureCount += 1;
    state.consecutiveFailures += 1;
    state.consecutiveSuccesses = 0;
    state.lastError = error;
    state.lastCheckedAt = Date.now();
    state.healthy = false;
    return;
  }

  state.failureCount += 1;
  state.consecutiveFailures += 1;
  state.consecutiveSuccesses = 0;
  state.lastError = error;
  state.lastCheckedAt = Date.now();

  if (isRateLimit || isQuota) {
    state.rateLimitedUntil = Date.now() + cooldownMs;
  } else if (
    /timeout|timed out|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up|fetch failed|probe timeout/i.test(
      error
    ) ||
    isRpc5xxMessage(error)
  ) {
    // Hard network/timeout/5xx failures — quarantine so health/withRpc stop hammering it.
    if (state.consecutiveFailures >= 2) {
      enterQuarantine(state, error.slice(0, 120));
    }
  } else if (state.consecutiveFailures >= (config.rpc?.failureThreshold ?? 3)) {
    // Persistent hard failures (e.g. QuickNode 0% success) — quarantine too.
    enterQuarantine(state, error.slice(0, 120));
  }

  const threshold =
    isRateLimit || isQuota ? 1 : config.rpc?.failureThreshold ?? 3;
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
        (isRateLimit || isQuota
          ? ` (${isQuota ? 'quota' : 'rate limited'} — cooling ${cooldownMs / 1000}s, failing over)`
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

  const envTimeout = Number(process.env.RPC_TIMEOUT_MS);
  const baseTimeout =
    Number.isFinite(envTimeout) && envTimeout >= 2_000
      ? Math.min(30_000, envTimeout)
      : timeoutMs;

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
  const recovering = !state.healthy || state.unhealthySince != null;
  const effectiveTimeout =
    recovering || !(gate.stressed || gate.backlog > 0)
      ? baseTimeout
      : Math.min(baseTimeout, 4_000);

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
    ? withRpcMaxAttemptsCritical()
    : withRpcMaxAttemptsOther();

  // Build attempt order: preferred → other paid → QuickNode → utility → remaining
  const order: number[] = [];
  const pushUnique = (i: number) => {
    if (i >= 0 && i < endpoints.length && !order.includes(i)) order.push(i);
  };
  pushUnique(startIndex);
  for (const other of piggybackOrder(r)) {
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
  pools: {
    helius: RpcProviderPoolStats;
    alchemy: RpcProviderPoolStats;
  };
  summary: RpcHealthSummary;
  plainLanguage: string;
} {
  ensureEndpoints();
  // Use last active indices — do NOT call resolveIndexForRole here.
  // Status polls every 5s were side-effecting soft-failover + log storms.
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
      'Set a real Helius/QuickNode RPC_URL on Render (not a placeholder).';
  } else if (
    /mainnet-beta\.solana\.com|publicnode\.com/i.test(pActive?.endpoint.url || '')
  ) {
    warning =
      'Using a public Solana RPC on the primary lane — fine for paper, but rate limits can miss buys. Set HELIUS_RPC_URL (+ backup) and ALCHEMY_RPC_URL (+ backup).';
  } else if (pIdx !== preferredPrimary) {
    const stickyRem = softStickyRemainingMsForProvider('helius');
    warning =
      stickyRem > 0 || pActive?.slot === 'backup'
        ? `Primary on ${pActive?.endpoint.label} (sticky backup / soft latency — preferred recovering).`
        : `Primary lane piggybacking on ${pActive?.endpoint.label} (preferred primary down >${formatFailoverGrace(failoverDownMs())}).`;
  } else if (
    preferredSecondary !== preferredPrimary &&
    sIdx !== preferredSecondary
  ) {
    const stickyRem = softStickyRemainingMsForProvider('alchemy');
    warning =
      stickyRem > 0 || sActive?.slot === 'backup'
        ? `Secondary on ${sActive?.endpoint.label} (sticky backup / soft latency — preferred recovering).`
        : `Secondary lane piggybacking on ${sActive?.endpoint.label} (preferred secondary down >${formatFailoverGrace(failoverDownMs())}).`;
  } else if (share) {
    warning =
      'Primary and secondary resolve to the same RPC — Zion KOL shares CU with copy/signals. Set a distinct RPC_SECONDARY.';
  }

  const buildPoolStats = (
    provider: 'helius' | 'alchemy'
  ): RpcProviderPoolStats => {
    const idxs = poolIndicesFor(provider);
    const activeIdx =
      provider === 'helius'
        ? idxs.includes(pIdx)
          ? pIdx
          : idxs.find((i) => isEndpointUsable(endpoints[i])) ?? idxs[0] ?? -1
        : idxs.includes(sIdx)
          ? sIdx
          : idxs.find((i) => isEndpointUsable(endpoints[i])) ?? idxs[0] ?? -1;
    const members: RpcPoolMemberStats[] = idxs.map((i) => {
      const s = endpoints[i]!;
      return {
        label: s.endpoint.label,
        slot: s.slot,
        host: endpointHostMasked(s.endpoint.url),
        state: memberHealthState(s),
        lastError: classifyRpcError(s.lastError),
        lastErrorDetail: s.lastError?.slice(0, 80),
        lastSuccessAgeMs:
          s.lastSuccessAt != null ? Date.now() - s.lastSuccessAt : null,
        latencyEwmaMs: s.latencyMs,
        isActive: i === activeIdx,
        consecutiveFailures: s.consecutiveFailures || 0,
        consecutiveSuccesses: s.consecutiveSuccesses || 0,
        cooldownRemainingMs: endpointCooldownRemainingMs(s),
      };
    });
    let state: RpcProviderPoolStats['state'] = 'empty';
    if (members.length) {
      if (members.every((m) => m.state === 'healthy')) state = 'healthy';
      else if (members.every((m) => m.state === 'down')) state = 'down';
      else state = 'degraded';
    }
    const primaryMem =
      members.find((m) => m.slot === 'primary') ||
      members.find((m) => m.slot === 'solo') ||
      null;
    const backupMem = members.find((m) => m.slot === 'backup') || null;
    const activeMem = members.find((m) => m.isActive) || null;
    const hasBackup = Boolean(backupMem);
    let shareMode: RpcPoolShareMode = 'empty';
    if (!members.length) shareMode = 'empty';
    else if (state === 'down') shareMode = 'down';
    else if (!hasBackup) shareMode = 'solo';
    else if (
      activeMem?.slot === 'backup' &&
      primaryMem &&
      primaryMem.state !== 'healthy'
    ) {
      shareMode = 'failover';
    } else if (
      primaryMem?.state === 'healthy' &&
      backupMem?.state === 'healthy'
    ) {
      shareMode = 'sharing';
    } else if (primaryMem?.state === 'healthy') {
      shareMode = 'primary_only';
    } else if (backupMem?.state === 'healthy' || (backupMem && backupMem.state !== 'down')) {
      shareMode = 'failover';
    } else {
      shareMode = 'down';
    }
    const errHint = (m: RpcPoolMemberStats | null) => {
      if (!m || !m.lastError || m.lastError === 'none') return '';
      return m.lastError === '429'
        ? 'rate-limited'
        : m.lastError === 'quota'
          ? 'out of credits'
          : m.lastError === 'auth'
            ? 'bad API key/URL'
            : m.lastError;
    };
    const envPrimaryPresent =
      provider === 'helius'
        ? Boolean(
            (process.env.HELIUS_RPC_URL || '').trim() ||
              (process.env.HELIUS_RPC_PRIMARY || '').trim() ||
              (process.env.HELIUS_API_KEY || '').trim()
          )
        : Boolean(
            (process.env.ALCHEMY_RPC_URL || '').trim() ||
              (process.env.ALCHEMY_RPC_PRIMARY || '').trim() ||
              (process.env.ALCHEMY_API_KEY || '').trim()
          );
    const envBackupPresent =
      provider === 'helius'
        ? Boolean(
            (process.env.HELIUS_RPC_URL_BACKUP || '').trim() ||
              (process.env.HELIUS_RPC_URLBACKUP || '').trim() ||
              (process.env.HELIUS_RPC_BACKUP || '').trim()
          )
        : Boolean(
            (process.env.ALCHEMY_RPC_URL_BACKUP || '').trim() ||
              (process.env.ALCHEMY_RPC_URLBACKUP || '').trim() ||
              (process.env.ALCHEMY_RPC_BACKUP || '').trim()
          );

    const stickyRem = softStickyRemainingMsForProvider(provider);
    const prefIdx =
      provider === 'helius' ? preferredPrimary : preferredSecondary;
    const preferredDownMs = downForMs(endpoints[prefIdx]);

    let shareLabel = 'not configured';
    if (shareMode === 'solo') {
      shareLabel = `primary configured · backup unset · solo · active ${activeMem?.label || '—'}`;
    } else if (shareMode === 'sharing') {
      shareLabel = `primary configured · backup ready · sharing load · active ${activeMem?.label || '—'}`;
    } else if (shareMode === 'primary_only') {
      shareLabel = `primary configured · backup ready (${backupMem?.state || 'down'}${
        errHint(backupMem) ? ` ${errHint(backupMem)}` : ''
      }) · active ${activeMem?.label || '—'}`;
    } else if (shareMode === 'failover') {
      const stickyBit =
        stickyRem > 0
          ? ` · sticky ${Math.ceil(stickyRem / 1000)}s`
          : activeMem?.slot === 'backup'
            ? ' · backup active (by design)'
            : '';
      const coolBit =
        primaryMem && primaryMem.cooldownRemainingMs > 0
          ? ` · primary cool ${Math.ceil(primaryMem.cooldownRemainingMs / 1000)}s`
          : preferredDownMs > 0
            ? ` · primary down ${Math.round(preferredDownMs / 1000)}s`
            : '';
      shareLabel = `FAILOVER on backup · primary ${
        errHint(primaryMem) || primaryMem?.state || 'down'
      } · backup ready${stickyBit}${coolBit} · active ${activeMem?.label || '—'}`;
    } else if (shareMode === 'down') {
      shareLabel = hasBackup
        ? 'pool down · backup was configured — traffic on other providers'
        : 'pool down · backup unset — traffic on other providers';
    } else if (shareMode === 'empty') {
      if (envPrimaryPresent) {
        shareLabel =
          'env set but not loaded — use full https URL or bare API key in HELIUS/ALCHEMY_RPC_URL (+ _BACKUP), then redeploy';
      } else {
        shareLabel =
          provider === 'helius'
            ? 'not configured — set HELIUS_RPC_URL (+ HELIUS_RPC_URL_BACKUP)'
            : 'not configured — set ALCHEMY_RPC_URL (+ ALCHEMY_RPC_URL_BACKUP)';
      }
    }
    return {
      provider,
      members,
      activeLabel:
        activeIdx >= 0 ? endpoints[activeIdx]?.endpoint.label ?? null : null,
      state,
      shareMode,
      shareLabel,
      lastFailoverAt:
        provider === 'helius' ? lastHeliusFailoverAt : lastAlchemyFailoverAt,
      failoverCountRecent: failoverCountRecent(provider),
      configured: members.length > 0,
      hasBackup,
      primaryConfigured: Boolean(primaryMem),
      backupConfigured: hasBackup,
      backupStatus: hasBackup ? 'ready' : 'unset',
      envPrimaryPresent,
      envBackupPresent,
      softStickyRemainingMs: stickyRem,
      preferredDownForMs: preferredDownMs,
    };
  };

  const heliusPoolStats = buildPoolStats('helius');
  const alchemyPoolStats = buildPoolStats('alchemy');

  let summary: RpcHealthSummary = 'all_healthy';
  const heliusDown = heliusPoolStats.state === 'down';
  const alchemyDown = alchemyPoolStats.state === 'down';
  const anyDegraded =
    heliusPoolStats.state === 'degraded' ||
    alchemyPoolStats.state === 'degraded';
  const anyFailover =
    heliusPoolStats.failoverCountRecent > 0 ||
    alchemyPoolStats.failoverCountRecent > 0 ||
    heliusPoolStats.softStickyRemainingMs > 0 ||
    alchemyPoolStats.softStickyRemainingMs > 0 ||
    heliusPoolStats.shareMode === 'failover' ||
    alchemyPoolStats.shareMode === 'failover' ||
    pIdx !== preferredPrimary ||
    (preferredSecondary !== preferredPrimary && sIdx !== preferredSecondary);
  // Red "Provider down" only when every configured paid pool is down.
  // One pool down + other serving → failover_active (expected, not total outage).
  const heliusConfigured = heliusPoolStats.configured;
  const alchemyConfigured = alchemyPoolStats.configured;
  const allPaidDown =
    (!heliusConfigured || heliusDown) &&
    (!alchemyConfigured || alchemyDown) &&
    (heliusConfigured || alchemyConfigured);
  if (allPaidDown) summary = 'provider_down';
  else if (heliusDown || alchemyDown || anyFailover) summary = 'failover_active';
  else if (anyDegraded) summary = 'degraded';

  const buildPlainLanguage = (): string => {
    if (
      heliusPoolStats.state === 'empty' &&
      alchemyPoolStats.state === 'empty'
    ) {
      if (heliusPoolStats.envPrimaryPresent || alchemyPoolStats.envPrimaryPresent) {
        return (
          'Helius/Alchemy env vars present but not loaded as pools — use a full https URL ' +
          'or bare API key in HELIUS_RPC_URL / ALCHEMY_RPC_URL (+ backups), then redeploy'
        );
      }
      return 'No Helius/Alchemy pools configured — using RPC_URL / public.';
    }
    if (heliusDown && alchemyPoolStats.state === 'healthy') {
      return 'Both Helius endpoints degraded — traffic on Alchemy';
    }
    if (alchemyDown && heliusPoolStats.state === 'healthy') {
      return 'Alchemy pool down — traffic on Helius';
    }
    if (heliusDown && alchemyDown) {
      return 'Helius and Alchemy pools down — on public / mid-tier fallback';
    }
    const hActive = heliusPoolStats.members.find((m) => m.isActive);
    if (
      heliusPoolStats.members.length > 1 &&
      hActive &&
      hActive.slot === 'backup' &&
      heliusPoolStats.members.some(
        (m) => m.slot === 'primary' && m.state !== 'healthy'
      )
    ) {
      const err =
        heliusPoolStats.members.find((m) => m.slot === 'primary')?.lastError ||
        'error';
      return `Helius primary ${err === '429' ? 'rate-limited' : err === 'quota' ? 'out of credits' : 'degraded'} — using Helius backup`;
    }
    const aActive = alchemyPoolStats.members.find((m) => m.isActive);
    if (
      alchemyPoolStats.members.length > 1 &&
      aActive &&
      aActive.slot === 'backup'
    ) {
      return 'Alchemy primary degraded — using Alchemy backup';
    }
    const parts: string[] = [];
    if (heliusPoolStats.configured) {
      if (heliusPoolStats.shareMode === 'sharing') {
        parts.push('Helius primary+backup sharing load');
      } else if (heliusPoolStats.shareMode === 'failover') {
        parts.push('Helius on backup (primary degraded)');
      } else if (heliusPoolStats.shareMode === 'solo') {
        parts.push('Helius primary configured · backup unset');
      } else if (heliusPoolStats.shareMode === 'primary_only') {
        parts.push('Helius primary up · backup ready but degraded');
      } else if (heliusPoolStats.shareMode === 'down') {
        parts.push('Helius pool down');
      } else {
        parts.push('Helius configured');
      }
    }
    if (alchemyPoolStats.configured) {
      if (alchemyPoolStats.shareMode === 'sharing') {
        parts.push('Alchemy primary+backup sharing load');
      } else if (alchemyPoolStats.shareMode === 'failover') {
        parts.push('Alchemy on backup (primary degraded)');
      } else if (alchemyPoolStats.shareMode === 'solo') {
        parts.push('Alchemy primary configured · backup unset');
      } else if (alchemyPoolStats.shareMode === 'primary_only') {
        parts.push('Alchemy primary up · backup ready but degraded');
      } else if (alchemyPoolStats.shareMode === 'down') {
        parts.push('Alchemy pool down');
      } else {
        parts.push('Alchemy configured');
      }
    }
    if (parts.length) return parts.join(' · ');
    return warning || 'RPC lanes operating';
  };
  const plainLanguage = buildPlainLanguage();

  const gate = getRpcGateSnapshot();
  if (!warning && gate.stressed) {
    warning =
      'RPC lane gate stressed — background work is being queued/skipped to protect Critical. ' +
      `Utility queue ${gate.lanes.utility.queued}, skipped ${gate.lanes.utility.skipped}.`;
  }
  // Lifetime skip counter is diagnostic only — do not warn/slow from it.

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

  return {
    active: pActive?.endpoint.label || 'primary',
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
      if (i === preferredPrimary) lane = 'primary';
      else if (
        i === preferredSecondary &&
        preferredSecondary !== preferredPrimary
      )
        lane = 'secondary';
      else if (
        i === preferredUtility &&
        preferredUtility !== preferredPrimary &&
        preferredUtility !== preferredSecondary
      )
        lane = 'utility';
      else if (
        s.slot === 'backup' &&
        (s.provider === 'helius' || s.provider === 'alchemy')
      )
        lane = 'backup';
      else if (s.role === 'fallback') lane = 'fallback';
      else lane = s.role || null;
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
        provider: s.provider,
        slot: s.slot,
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
    pools: { helius: heliusPoolStats, alchemy: alchemyPoolStats },
    summary,
    plainLanguage,
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
  return runWithRpcFeature('sendRawTransaction', async () => {
    // Prefer healthiest Helius (or Alchemy) member for live sends
    ensureEndpoints();
    if (heliusPoolIndices.length) {
      const best = pickHealthiestFromPool('helius');
      if (best >= 0) setActiveForRole('primary', best);
    } else if (alchemyPoolIndices.length) {
      const best = pickHealthiestFromPool('alchemy');
      if (best >= 0) setActiveForRole('primary', best);
    }
    return withRpc('sendRawTransaction', async (conn) => {
      const sig = await conn.sendRawTransaction(serialized, {
        skipPreflight: options.skipPreflight ?? false,
        maxRetries: options.maxRetries ?? 3,
        preflightCommitment: 'confirmed',
      });
      await conn.confirmTransaction(sig, 'confirmed');
      return sig;
    }, 'primary');
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

/**
 * Force-probe preferred (+ active) endpoints so sticky-DOWN lanes can recover
 * without waiting for the next health interval. Used by POST /api/rpc/probe.
 */
export async function probeRpcRecovery(): Promise<ReturnType<typeof getRpcStats>> {
  ensureEndpoints();
  startRpcHealthMonitor();
  if (healthProbeRunning) {
    return getRpcStats();
  }
  healthProbeRunning = true;
  try {
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
  } finally {
    healthProbeRunning = false;
  }
  return getRpcStats();
}

/** Periodic health probes + auto-switch */
export function startRpcHealthMonitor(): void {
  if (started) return;
  started = true;
  ensureEndpoints();

  const interval = Math.max(
    45_000,
    Number(process.env.RPC_HEALTH_PROBE_INTERVAL_MS) ||
      config.rpc?.healthIntervalMs ||
      45_000
  );
  let healthCycle = 0;

  /** Share load: keep public/utility hot for diagnostics; probe paid lanes sparsely. */
  function shouldProbeIndex(index: number, cycle: number): boolean {
    if (!Boolean(config.rpc?.shareLoad)) {
      // Non-share: never probe while quarantined (window must elapse first).
      const st = endpoints[index];
      if (st && isEndpointHardFailed(st)) return false;
      // Unhealthy / rate-limited: sparse probes only.
      if (
        st &&
        (!st.healthy || isEndpointRateLimited(st)) &&
        cycle % 8 !== 0
      ) {
        return false;
      }
      return true;
    }
    const state = endpoints[index];
    if (!state) return false;
    // Quarantine: no probes until cooldown elapses (prevents retry storms).
    if (isEndpointHardFailed(state)) return false;
    const downish = !state.healthy || isEndpointRateLimited(state);
    // Down preferred/backup: at most every 8th cycle; backups rarer if primary also down.
    if (downish) {
      const prefOfPool =
        state.provider === 'helius'
          ? preferredPrimary
          : state.provider === 'alchemy'
            ? preferredSecondary
            : -1;
      const prefDown =
        prefOfPool >= 0 &&
        endpoints[prefOfPool] &&
        (!endpoints[prefOfPool]!.healthy ||
          isEndpointRateLimited(endpoints[prefOfPool]!));
      if (state.slot === 'backup' && prefDown) {
        return cycle % 12 === 0;
      }
      return cycle % 8 === 0;
    }
    const isPublic = isPublicRpcUrl(state.endpoint.url);
    const isUtil = index === preferredUtility;
    const isPrimary = index === preferredPrimary;
    const isSecondary =
      index === preferredSecondary && preferredSecondary !== preferredPrimary;
    // Preferred / active utility: keep warm. Other public fallbacks (e.g. slow
    // official mainnet-beta): rare probes only — avoids painting the table with 1s+ spikes.
    if (isUtil || index === activeUtility) {
      // Preferred Utility already soft-failed elsewhere: probe it rarely so slow
      // Triton/rpc-url getSlot samples do not keep painting the Multi-RPC row.
      if (
        isUtil &&
        index !== activeUtility &&
        state.latencyStressedSince != null &&
        state.latencyMs != null &&
        state.latencyMs >= latencyStressMs(state)
      ) {
        return cycle % 4 === 0;
      }
      if (
        state.latencyStressedSince != null &&
        state.latencyMs != null &&
        state.latencyMs >= latencyStressMs(state)
      ) {
        return cycle % 2 === 0;
      }
      return true;
    }
    if (isPublic) {
      return cycle % 5 === 0;
    }
    // Helius pool: probe preferred every 3rd; rotate backup siblings
    if (heliusPoolIndices.includes(index)) {
      if (isPrimary || index === activePrimary) return cycle % 3 === 0;
      return cycle % 4 === (heliusPoolIndices.indexOf(index) % 4);
    }
    // Alchemy pool: preferred every 2nd; rotate siblings
    if (alchemyPoolIndices.includes(index)) {
      if (isSecondary || index === activeSecondary) return cycle % 2 === 0;
      return cycle % 5 === (alchemyPoolIndices.indexOf(index) % 5);
    }
    // Helius (critical): every 3rd cycle (~135s at 45s interval)
    if (isPrimary) return cycle % 3 === 0;
    // Alchemy (scanners): every 2nd cycle (~90s)
    if (isSecondary) return cycle % 2 === 0;
    // QuickNode: rare when failing; otherwise every 4th (~180s) — avoid retry storms
    if (
      index === preferredQuicknode ||
      state.endpoint.label === 'quicknode' ||
      isQuicknodeRpcUrl(state.endpoint.url)
    ) {
      if (!state.healthy) return cycle % 8 === 0;
      return cycle % 4 === 0;
    }
    // Inactive fallback: rare
    return cycle % 5 === 0;
  }

  async function runHealthProbeCycle(opts?: {
    boot?: boolean;
  }): Promise<void> {
    if (healthProbeRunning) return;
    healthProbeRunning = true;
    try {
      if (opts?.boot) {
        const order: number[] = [];
        const push = (i: number) => {
          if (i >= 0 && i < endpoints.length && !order.includes(i)) order.push(i);
        };
        if (Boolean(config.rpc?.shareLoad)) {
          push(preferredUtility);
          for (let i = 0; i < endpoints.length; i++) {
            if (isPublicRpcUrl(endpoints[i]?.endpoint.url || '')) push(i);
          }
          push(preferredPrimary);
          push(preferredSecondary);
          push(preferredQuicknode);
        } else {
          for (let i = 0; i < endpoints.length; i++) push(i);
        }
        for (const i of order) {
          await probeEndpoint(i);
          await new Promise((r) => setTimeout(r, 400));
        }
        return;
      }
      healthCycle += 1;
      const gateSnap = getRpcGateSnapshot();
      for (let i = 0; i < endpoints.length; i++) {
        if (!shouldProbeIndex(i, healthCycle)) continue;
        const isActive =
          i === activePrimary ||
          i === activeSecondary ||
          i === activeUtility;
        const isPreferred =
          i === preferredPrimary ||
          i === preferredSecondary ||
          i === preferredUtility ||
          i === preferredQuicknode;
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
        const gateAfter = getRpcGateSnapshot();
        const p = endpoints[activePrimary];
        const s = endpoints[activeSecondary];
        const u = endpoints[activeUtility];
        updateRpcLoadSignals({
          primaryLatencyMs: p?.latencyMs ?? null,
          secondaryLatencyMs: s?.latencyMs ?? null,
          utilityLatencyMs: u?.latencyMs ?? null,
          utilityWeakPublic: isWeakPublicUtilityUrl(u?.endpoint.url),
          utilityFailover: activeUtility !== preferredUtility,
          primaryQueued: gateAfter.lanes.primary.queued,
          secondaryIdle:
            gateAfter.lanes.secondary.inFlight === 0 &&
            gateAfter.lanes.secondary.queued === 0,
        });
      } catch {
        /* */
      }
    } finally {
      healthProbeRunning = false;
    }
  }

  // Boot: probe utility/public first, then preferred paid lanes once (not all fallbacks).
  void runHealthProbeCycle({ boot: true });

  healthTimer = setInterval(() => {
    void runHealthProbeCycle();
  }, interval);

  console.log(
    `[rpc] Health monitor started (every ${interval}ms` +
      (Boolean(config.rpc?.shareLoad)
        ? '; share-load: public/utility every tick, helius~3x, alchemy/quicknode~2x'
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
