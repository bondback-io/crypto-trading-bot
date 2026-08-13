/**
 * Simple 2-lane RPC: Trading (Alchemy BACKUP) + Data (Alchemy) + Emergency (public).
 * Helius is never probed or routed. Facade preserved for callers.
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
import {
  rpcEndpointsSimple,
  isPublicRpcUrl,
  type SimpleRpcEndpoints,
} from './rpcUrl';
import {
  getRpcGateSnapshot,
  isRpcGateSkipError,
  runWithRpcFeatureGate,
  type RpcGateRole,
} from './rpcGate';
import { normalizeRpcRole } from './rpcRouting';

dotenv.config();

/** Workload lane — legacy roles map onto primary|secondary. */
export type RpcRole =
  | 'primary'
  | 'secondary'
  | 'utility'
  | 'scannersB'
  | 'metrics';

export interface RpcEndpoint {
  url: string;
  label: string;
  wsUrl?: string;
  role?: 'primary' | 'secondary' | 'utility';
}

export interface RpcEndpointStats {
  url: string;
  label: string;
  role: 'primary' | 'secondary' | 'utility';
  healthy: boolean;
  latencyMs: number | null;
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
  latencyMs: number | null;
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

type LaneId = 'trading' | 'data' | 'emergency';

const rpcRoleAls = new AsyncLocalStorage<RpcRole>();
const rpcFeatureAls = new AsyncLocalStorage<string>();
const rpcGateDepthAls = new AsyncLocalStorage<number>();

const keypairCache = new Map<string, Keypair>();
let healthTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

let simple: SimpleRpcEndpoints | null = null;
let trading: EndpointState | null = null;
let data: EndpointState | null = null;
let emergency: EndpointState | null = null;

/** Trading sticky vs emergency failover */
let tradingOnEmergency = false;
let tradingHardFailStreak = 0;
let tradingRecoverAt = 0;
const TRADING_HARD_FAIL_NEED = 3;
const TRADING_RECOVER_MS = 45_000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const HARD_FAIL_COOLDOWN_MS = 120_000;
const LATENCY_EWMA_ALPHA = 0.25;
const WITH_RPC_MAX_ATTEMPTS_CRITICAL = 3;
const WITH_RPC_MAX_ATTEMPTS_OTHER = 2;

export type RpcCallTrafficRow = {
  endpoint: string;
  feature: string;
  role: RpcRole | 'unknown';
  count: number;
  lastAt: number;
};

const callTraffic = new Map<string, RpcCallTrafficRow>();

function noteCallTraffic(endpoint: string, feature: string, role: RpcRole | 'unknown') {
  const key = `${endpoint}|${feature}|${role}`;
  const prev = callTraffic.get(key);
  if (prev) {
    prev.count += 1;
    prev.lastAt = Date.now();
  } else {
    callTraffic.set(key, {
      endpoint,
      feature,
      role,
      count: 1,
      lastAt: Date.now(),
    });
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

function makeConnection(url: string): Connection {
  return new Connection(url, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    confirmTransactionInitialTimeout: 60_000,
  });
}

function makeState(
  ep: { url: string; label: string },
  emergencyOnly = false
): EndpointState {
  return {
    endpoint: { url: ep.url, label: ep.label },
    connection: makeConnection(ep.url),
    healthy: true,
    latencyMs: null,
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

function ensureEndpoints(): void {
  if (trading || data || emergency) return;
  simple = rpcEndpointsSimple();
  if (simple.trading) trading = makeState(simple.trading);
  if (simple.data) data = makeState(simple.data);
  emergency = makeState(simple.emergency, true);

  // If Trading missing, fall back to Data then Emergency for primary work.
  if (!trading && data) {
    trading = makeState({ url: data.endpoint.url, label: data.endpoint.label + '-as-trading' });
  }
  if (!trading && emergency) {
    trading = makeState({ url: emergency.endpoint.url, label: emergency.endpoint.label });
  }
  if (!data && trading) {
    data = makeState({ url: trading.endpoint.url, label: trading.endpoint.label + '-as-data' });
  }
  if (!data && emergency) {
    data = makeState({ url: emergency.endpoint.url, label: emergency.endpoint.label });
  }

  console.log(
    `[rpc] Simple 2-lane: tradingEndpoint=${simple.trading?.label || trading?.endpoint.label || 'none'} ` +
      `dataEndpoint=${simple.data?.label || data?.endpoint.label || 'none'} ` +
      `helius=disabled emergency=${simple.emergency.label} (idle until Trading hard-fail)`
  );
}

export function resetRpcEndpointPool(): void {
  trading = null;
  data = null;
  emergency = null;
  simple = null;
  tradingOnEmergency = false;
  tradingHardFailStreak = 0;
  tradingRecoverAt = 0;
  callTraffic.clear();
  ensureEndpoints();
}

export function isWeakPublicUtilityUrl(url: string | null | undefined): boolean {
  return isPublicRpcUrl(url);
}

export function isUtilityOnWeakPublic(): boolean {
  ensureEndpoints();
  return tradingOnEmergency && isPublicRpcUrl(emergency?.endpoint.url);
}

export function shouldDeferHeavyRpc(): boolean {
  try {
    const { shouldDeferFavouritesWork } = require('./rpcLoadControl') as typeof import('./rpcLoadControl');
    return shouldDeferFavouritesWork();
  } catch {
    return false;
  }
}

export function isLaneRateLimited(role: RpcRole = 'primary'): boolean {
  ensureEndpoints();
  const st = laneState(normalizeRole(role));
  return Boolean(st && st.rateLimitedUntil > Date.now());
}

export function lanesShareEndpoint(): boolean {
  ensureEndpoints();
  if (!trading || !data) return true;
  return trading.endpoint.url === data.endpoint.url;
}

function normalizeRole(role: RpcRole | undefined): 'primary' | 'secondary' {
  return normalizeRpcRole(role);
}

function currentRole(): RpcRole {
  return rpcRoleAls.getStore() ?? 'primary';
}

export function hasRpcRoleContext(): boolean {
  return rpcRoleAls.getStore() != null;
}

function laneState(role: 'primary' | 'secondary'): EndpointState | null {
  ensureEndpoints();
  if (role === 'primary') {
    if (tradingOnEmergency && emergency) return emergency;
    return trading;
  }
  return data;
}

function preferredTrading(): EndpointState | null {
  ensureEndpoints();
  return trading;
}

function isRateLimited(st: EndpointState): boolean {
  return st.rateLimitedUntil > Date.now();
}

function isHardFailed(st: EndpointState): boolean {
  return st.hardFailUntil > Date.now();
}

function is429(message: string): boolean {
  return /429|too many requests|rate.?limit/i.test(message);
}

function isHardError(message: string): boolean {
  return (
    is429(message) ||
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|socket hang up|503|502|500|401|403/i.test(
      message
    )
  );
}

function recordSuccess(st: EndpointState, latencyMs: number): void {
  st.successCount += 1;
  st.consecutiveFailures = 0;
  st.lastCheckedAt = Date.now();
  st.lastError = undefined;
  st.lastCallLatencyMs = latencyMs;
  st.latencyMs =
    st.latencyMs == null
      ? latencyMs
      : LATENCY_EWMA_ALPHA * latencyMs + (1 - LATENCY_EWMA_ALPHA) * st.latencyMs;
  st.healthy = true;
  st.unhealthySince = null;
  if (st.hardFailUntil > 0 && Date.now() >= st.hardFailUntil) {
    st.hardFailUntil = 0;
    st.quarantineStreak = 0;
  }
}

function recordFailure(st: EndpointState, message: string): void {
  st.failureCount += 1;
  st.consecutiveFailures += 1;
  st.lastCheckedAt = Date.now();
  st.lastError = message.slice(0, 240);
  if (!st.unhealthySince) st.unhealthySince = Date.now();
  if (st.consecutiveFailures >= 2) st.healthy = false;

  if (is429(message)) {
    st.rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    st.healthy = false;
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
    if (tradingOnEmergency && trading && trading.healthy && !isHardFailed(trading) && !isRateLimited(trading)) {
      if (!tradingRecoverAt) tradingRecoverAt = Date.now() + TRADING_RECOVER_MS;
      if (Date.now() >= tradingRecoverAt) {
        tradingOnEmergency = false;
        tradingRecoverAt = 0;
        console.log('[rpc] Trading recovered → Alchemy BACKUP');
      }
    }
    return;
  }
  tradingRecoverAt = 0;
  if (message && (is429(message) || isHardError(message))) {
    tradingHardFailStreak += 1;
  } else {
    tradingHardFailStreak += 1;
  }
  if (
    !tradingOnEmergency &&
    (tradingHardFailStreak >= TRADING_HARD_FAIL_NEED || (message && is429(message)))
  ) {
    tradingOnEmergency = true;
    tradingHardFailStreak = 0;
    console.warn(
      `[rpc] Trading hard-fail → Emergency (${emergency?.endpoint.label || 'public'})`
    );
  }
}

export async function runWithRpcRole<T>(
  role: RpcRole,
  fn: () => Promise<T>,
  feature = 'rpc'
): Promise<T> {
  const norm = normalizeRole(role);
  const depth = rpcGateDepthAls.getStore() ?? 0;
  const run = () =>
    rpcRoleAls.run(norm, () =>
      rpcFeatureAls.run(feature, () =>
        rpcGateDepthAls.run(depth + 1, fn)
      )
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
  ensureEndpoints();
  const st = laneState(normalizeRole(role ?? currentRole()));
  if (!st) throw new Error('No RPC endpoint configured');
  const feature = rpcFeatureAls.getStore() || 'getConnection';
  noteCallTraffic(st.endpoint.label, feature, normalizeRole(role ?? currentRole()));
  return st.connection;
}

export function getActiveEndpointLabel(role?: RpcRole): string {
  ensureEndpoints();
  return laneState(normalizeRole(role ?? currentRole()))?.endpoint.label || 'none';
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
  const st = laneState(normalizeRole(role));
  if (st) recordFailure(st, msg);
  if (normalizeRole(role) === 'primary') noteTradingOutcome(false, msg);
}

async function probeState(st: EndpointState, timeoutMs = 8_000): Promise<boolean> {
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
    recordSuccess(st, Date.now() - start);
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
  const maxAttempts = critical
    ? WITH_RPC_MAX_ATTEMPTS_CRITICAL
    : WITH_RPC_MAX_ATTEMPTS_OTHER;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Data never borrows Trading; Trading may use Emergency after hard-fail.
    let st: EndpointState | null;
    if (r === 'primary') {
      if (attempt > 0 && trading && !tradingOnEmergency) {
        // force check preferred before escalating
        st = trading;
      } else {
        st = laneState('primary');
      }
      if (attempt >= 1 && tradingOnEmergency === false && emergency) {
        // After first hard failure in this call, allow emergency for critical.
        const pref = trading;
        if (
          pref &&
          (!pref.healthy || isHardFailed(pref) || isRateLimited(pref))
        ) {
          tradingOnEmergency = true;
          st = emergency;
        }
      }
    } else {
      st = data;
    }

    if (!st) {
      lastError = new Error(`No ${r} RPC endpoint`);
      break;
    }

    logger.info('RPC', `start: ${label}`, {
      role: r,
      active: st.endpoint.label,
      attempt: attempt + 1,
    });

    const start = Date.now();
    try {
      noteCallTraffic(st.endpoint.label, label, r);
      const result = await fn(st.connection);
      recordSuccess(st, Date.now() - start);
      if (r === 'primary') noteTradingOutcome(true);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = err;
      recordFailure(st, message);
      if (r === 'primary') noteTradingOutcome(false, message);
      logger.warn('RPC', `fail: ${label}`, {
        ...errorToMeta(err),
        endpoint: st.endpoint.label,
      });
      if (!critical && attempt + 1 >= maxAttempts) break;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
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
  role: 'primary' | 'secondary' | 'utility',
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
    details.push(`gate ${g.inFlight}/${g.max} q=${g.queued} skips/min=${g.skipsPerMin}`);
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
      cause: `Trading on Emergency (${st?.endpoint.label || 'public'})`,
      details,
    };
  }
  if (!st || (!st.healthy && st.consecutiveFailures >= 2)) {
    return {
      state: 'down',
      cause: st?.lastError || 'lane down',
      details,
    };
  }
  if (g && (g.queued > g.max || g.skipsPerMin > 20)) {
    return {
      state: 'congested',
      cause: g.topSkipReason || `queue ${g.queued}`,
      details,
    };
  }
  if (g && (g.queued > 4 || g.skipsPerMin > 8 || (st.latencyMs != null && st.latencyMs > 1500))) {
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

export function getRpcStats(): {
  mode: 'simple';
  multiLaneActive: false;
  shareLoad: boolean;
  active: string;
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
  scannersB: null;
  metrics: null;
  lanesShareEndpoint: boolean;
  supports: {
    classicShare: false;
    multiLane: false;
    simple2Lane: true;
  };
  endpoints: Array<RpcEndpointStats & { emergencyOnly?: boolean }>;
  jitoEnabled: boolean;
  priorityFeeLamports: number | null;
  ok: boolean;
  warning: string | null;
  callTraffic: ReturnType<typeof getRpcCallTraffic>;
  gate: ReturnType<typeof getRpcGateSnapshot>;
  quarantine: Array<{
    label: string;
    remainingMs: number;
    streak: number;
    lastError?: string;
  }>;
  loadControl: ReturnType<
    typeof import('./rpcLoadControl').getRpcLoadControlSnapshot
  > | null;
  utilityWeakPublic: boolean;
  heliusDisabled: true;
  lanes: {
    trading: {
      label: string;
      url: string;
      healthy: boolean;
      latencyMs: number | null;
      successRate: number;
      active: boolean;
      congestion: LaneCongestion;
    };
    data: {
      label: string;
      url: string;
      healthy: boolean;
      latencyMs: number | null;
      successRate: number;
      active: boolean;
      congestion: LaneCongestion;
    };
    emergency: {
      label: string;
      url: string;
      healthy: boolean;
      latencyMs: number | null;
      successRate: number;
      active: boolean;
      congestion: LaneCongestion;
    };
    helius: {
      disabled: true;
      congestion: LaneCongestion;
    };
  };
} {
  ensureEndpoints();
  const tActive = laneState('primary');
  const dActive = data;
  const eState = emergency;
  const tPref = trading;

  const downFor = (st: EndpointState | null) =>
    st?.unhealthySince ? Math.max(0, Date.now() - st.unhealthySince) : 0;

  const anyHealthy = [tActive, dActive].some(
    (s) => s && s.healthy && !isRateLimited(s) && !isHardFailed(s)
  );

  let warning: string | null = null;
  if (!anyHealthy) {
    warning =
      'Trading/Data RPC unhealthy — set ALCHEMY_API_KEY_BACKUP (Trading) and ALCHEMY_API_KEY (Data).';
  } else if (tradingOnEmergency) {
    warning = `Trading on Emergency (${eState?.endpoint.label || 'public'}) — Alchemy BACKUP recovering.`;
  } else if (lanesShareEndpoint()) {
    warning =
      'Trading and Data resolve to the same Alchemy endpoint — set distinct ALCHEMY_API_KEY_BACKUP vs ALCHEMY_API_KEY.';
  }

  const gate = getRpcGateSnapshot();
  if (!warning && gate.stressed) {
    warning =
      'Data lane gate stressed — scanners/Favourites may be queued or skipped.';
  }

  const quarantine = [trading, data, emergency]
    .filter((e): e is EndpointState => Boolean(e && isHardFailed(e)))
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
      primaryLatencyMs: tActive?.latencyMs ?? null,
      secondaryLatencyMs: dActive?.latencyMs ?? null,
      tradingOnEmergency,
      dataHealthy: Boolean(dActive?.healthy),
    });
    loadControl = getRpcLoadControlSnapshot();
    if (loadControl?.favouritesDeferred) {
      // surface in data congestion via loadControl.cause
    }
  } catch {
    /* optional */
  }

  const tradingCong = buildCongestion('trading', tActive, {
    onEmergency: tradingOnEmergency,
    recoverAt: tradingRecoverAt || undefined,
    gateRole: 'primary',
  });
  const dataCong = buildCongestion('data', dActive, { gateRole: 'secondary' });
  if (loadControl?.level === 'shed' || loadControl?.favouritesDeferred) {
    dataCong.details.push(
      `shed: scanners×${loadControl.scannerMultiplier}` +
        (loadControl.favouritesDeferred ? '; Favourites deferred' : '')
    );
    if (dataCong.state === 'ok') {
      dataCong.state = loadControl.level === 'shed' ? 'congested' : 'busy';
      dataCong.cause = loadControl.cause || dataCong.cause;
    }
  }
  const emergCong = buildCongestion('emergency', eState, {
    onEmergency: tradingOnEmergency,
  });

  const endpoints: Array<RpcEndpointStats & { emergencyOnly?: boolean }> = [];
  const tStats = toEndpointStats(
    tPref,
    'primary',
    !tradingOnEmergency && tActive === tPref,
    'primary'
  );
  if (tStats) endpoints.push(tStats);
  const dStats = toEndpointStats(dActive, 'secondary', true, 'secondary');
  if (dStats) endpoints.push(dStats);
  const eStats = toEndpointStats(
    eState,
    'utility',
    tradingOnEmergency,
    'utility'
  );
  if (eStats) {
    eStats.emergencyOnly = true;
    endpoints.push(eStats);
  }

  return {
    mode: 'simple',
    multiLaneActive: false,
    shareLoad: false,
    active: tActive?.endpoint.label || 'none',
    primary: {
      label: tActive?.endpoint.label || 'none',
      url: tActive?.endpoint.url || '',
      healthy: Boolean(tActive?.healthy),
      failover: tradingOnEmergency,
      downForMs: downFor(tPref),
    },
    secondary: {
      label: dActive?.endpoint.label || 'none',
      url: dActive?.endpoint.url || '',
      healthy: Boolean(dActive?.healthy),
      failover: false,
      downForMs: downFor(dActive),
    },
    utility: {
      label: eState?.endpoint.label || 'none',
      url: eState?.endpoint.url || '',
      healthy: Boolean(eState?.healthy),
      failover: tradingOnEmergency,
      downForMs: 0,
    },
    scannersB: null,
    metrics: null,
    lanesShareEndpoint: lanesShareEndpoint(),
    supports: {
      classicShare: false,
      multiLane: false,
      simple2Lane: true,
    },
    endpoints,
    jitoEnabled: Boolean(config.rpc?.jito?.enabled),
    priorityFeeLamports: lastPriorityFeeLamports,
    ok: anyHealthy,
    warning,
    callTraffic: getRpcCallTraffic(),
    gate,
    quarantine,
    loadControl,
    utilityWeakPublic: tradingOnEmergency,
    heliusDisabled: true,
    lanes: {
      trading: {
        label: tActive?.endpoint.label || 'none',
        url: tActive?.endpoint.url || '',
        healthy: Boolean(tActive?.healthy),
        latencyMs: tActive?.latencyMs ?? null,
        successRate: successRate(tActive),
        active: true,
        congestion: tradingCong,
      },
      data: {
        label: dActive?.endpoint.label || 'none',
        url: dActive?.endpoint.url || '',
        healthy: Boolean(dActive?.healthy),
        latencyMs: dActive?.latencyMs ?? null,
        successRate: successRate(dActive),
        active: true,
        congestion: dataCong,
      },
      emergency: {
        label: eState?.endpoint.label || 'none',
        url: eState?.endpoint.url || '',
        healthy: Boolean(eState?.healthy),
        latencyMs: eState?.latencyMs ?? null,
        successRate: successRate(eState),
        active: tradingOnEmergency,
        congestion: emergCong,
      },
      helius: {
        disabled: true,
        congestion: {
          state: 'disabled',
          cause: 'Helius disabled — never probed or routed',
          details: [],
        },
      },
    },
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
  return withRpc('sendRawTransaction', async (conn) => {
    const sig = await conn.sendRawTransaction(serialized, {
      skipPreflight: options.skipPreflight ?? false,
      maxRetries: options.maxRetries ?? 3,
      preflightCommitment: 'confirmed',
    });
    await conn.confirmTransaction(sig, 'confirmed');
    return sig;
  }, 'primary');
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
  if (walletId) {
    keypairCache.delete(walletId);
  } else {
    keypairCache.clear();
  }
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
    const lamports = await withRpc(
      'getBalance',
      (conn) => conn.getBalance(pubkey),
      'primary'
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
  const pref = preferredTrading();
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
  if (emergency) {
    const retry = await probeState(emergency, 6_000);
    if (retry) {
      tradingOnEmergency = true;
      console.log(
        `[connection] RPC OK after failover → ${emergency.endpoint.label}`
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
  if (trading) await probeState(trading, 8_000);
  await new Promise((r) => setTimeout(r, 200));
  if (data) await probeState(data, 8_000);
  if (tradingOnEmergency && emergency) {
    await new Promise((r) => setTimeout(r, 200));
    await probeState(emergency, 8_000);
  }
  if (
    tradingOnEmergency &&
    trading &&
    trading.healthy &&
    !isHardFailed(trading) &&
    !isRateLimited(trading)
  ) {
    tradingOnEmergency = false;
    tradingRecoverAt = 0;
    console.log('[rpc] Trading recovered via probe → Alchemy BACKUP');
  }
  return getRpcStats();
}

export function startRpcHealthMonitor(): void {
  if (started) return;
  started = true;
  ensureEndpoints();

  const interval = Math.max(45_000, config.rpc?.healthIntervalMs ?? 45_000);
  let healthCycle = 0;

  const tick = async () => {
    healthCycle += 1;
    try {
      if (trading && !isHardFailed(trading)) {
        await probeState(trading, 8_000);
      }
      if (data && !isHardFailed(data)) {
        await probeState(data, 8_000);
      }
      // Emergency only when active or recovering from failover
      if (emergency && (tradingOnEmergency || healthCycle % 6 === 0)) {
        await probeState(emergency, 8_000);
      }
      if (
        tradingOnEmergency &&
        trading &&
        trading.healthy &&
        !isHardFailed(trading) &&
        !isRateLimited(trading)
      ) {
        if (!tradingRecoverAt) tradingRecoverAt = Date.now() + TRADING_RECOVER_MS;
        if (Date.now() >= tradingRecoverAt) {
          tradingOnEmergency = false;
          tradingRecoverAt = 0;
          console.log('[rpc] Trading healthy again → leave Emergency');
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
  healthTimer = setInterval(() => void tick(), interval);
}

export function stopRpcHealthMonitor(): void {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  started = false;
}
