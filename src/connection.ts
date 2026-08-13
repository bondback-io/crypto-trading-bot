/**
 * 6 paid + 3 public RPC pool:
 * Trading (Helius → Helius BACKUP → Emergency)
 * Data (Alchemy → Alchemy BACKUP)
 * Background (Alchemy BACKUP2 → publics)
 * Emergency (Helius BACKUP2 → publics) — Trading hard-fail only
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
  type RpcEndpointRef,
} from './rpcUrl';
import {
  getRpcGateSnapshot,
  isRpcGateSkipError,
  runWithRpcFeatureGate,
  type RpcGateRole,
} from './rpcGate';
import { normalizeRpcRole, type NormalizedRpcRole } from './rpcRouting';
import { assertRpcWorkloadEnabled } from './rpcWorkloadControl';

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

type LaneId = 'trading' | 'data' | 'background' | 'emergency';

const rpcRoleAls = new AsyncLocalStorage<RpcRole>();
const rpcFeatureAls = new AsyncLocalStorage<string>();
const rpcGateDepthAls = new AsyncLocalStorage<number>();

const keypairCache = new Map<string, Keypair>();
let healthTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

let simple: SimpleRpcEndpoints | null = null;
let tradingPref: EndpointState | null = null;
let tradingAlchemyFailover: EndpointState | null = null;
let tradingFailover: EndpointState | null = null;
let dataPref: EndpointState | null = null;
let dataFailover: EndpointState | null = null;
let backgroundPref: EndpointState | null = null;
let emergencyPaid: EndpointState | null = null;
let publics: EndpointState[] = [];

/** Trading: 0=helius, 1=alchemy-backup, 2=helius-backup, 3+=emergency */
let tradingHop = 0;
let dataOnFailover = false;
let backgroundIdx = 0;
let tradingHardFailStreak = 0;
let tradingRecoverAt = 0;

const TRADING_HARD_FAIL_NEED = 3;
const TRADING_RECOVER_MS = 45_000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const HARD_FAIL_COOLDOWN_MS = 120_000;
const LATENCY_EWMA_ALPHA = 0.25;
const WITH_RPC_MAX_ATTEMPTS_CRITICAL = 4;
const WITH_RPC_MAX_ATTEMPTS_OTHER = 2;

export type RpcCallTrafficRow = {
  endpoint: string;
  feature: string;
  role: RpcRole | 'unknown';
  count: number;
  lastAt: number;
};

const callTraffic = new Map<string, RpcCallTrafficRow>();

function noteCallTraffic(
  endpoint: string,
  feature: string,
  role: RpcRole | 'unknown'
) {
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

function makeState(ep: RpcEndpointRef, emergencyOnly = false): EndpointState {
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

function emergencyChain(): EndpointState[] {
  const out: EndpointState[] = [];
  if (emergencyPaid) out.push(emergencyPaid);
  for (const p of publics) out.push(p);
  return out;
}

function ensureEndpoints(): void {
  if (tradingPref || dataPref || backgroundPref || publics.length) return;
  simple = rpcEndpointsSimple();
  if (simple.trading) tradingPref = makeState(simple.trading);
  if (simple.tradingAlchemyFailover) {
    tradingAlchemyFailover = makeState(simple.tradingAlchemyFailover);
  }
  if (simple.tradingFailover) tradingFailover = makeState(simple.tradingFailover);
  if (simple.data) dataPref = makeState(simple.data);
  if (simple.dataFailover) dataFailover = makeState(simple.dataFailover);
  if (simple.background) backgroundPref = makeState(simple.background);
  if (simple.emergencyPaid) emergencyPaid = makeState(simple.emergencyPaid, true);
  publics = simple.publics.map((p) => makeState(p, true));

  // Fallbacks so lanes always resolve
  if (!tradingPref && tradingAlchemyFailover) tradingPref = tradingAlchemyFailover;
  if (!tradingPref && tradingFailover) tradingPref = tradingFailover;
  if (!tradingPref && dataPref) {
    tradingPref = makeState({
      url: dataPref.endpoint.url,
      label: dataPref.endpoint.label + '-as-trading',
    });
  }
  if (!tradingPref && publics[0]) tradingPref = makeState(publics[0].endpoint as RpcEndpointRef);

  if (!dataPref && dataFailover) dataPref = dataFailover;
  if (!dataPref && tradingPref) {
    dataPref = makeState({
      url: tradingPref.endpoint.url,
      label: tradingPref.endpoint.label + '-as-data',
    });
  }

  if (!backgroundPref && publics[0]) {
    backgroundPref = makeState(publics[0].endpoint as RpcEndpointRef);
  }

  console.log(
    `[rpc] 6+3 lanes: trading=${simple.trading?.label || tradingPref?.endpoint.label || 'none'}` +
      ` (failover1=${simple.tradingAlchemyFailover?.label || 'none'}` +
      ` failover2=${simple.tradingFailover?.label || 'none'})` +
      ` data=${simple.data?.label || dataPref?.endpoint.label || 'none'}` +
      ` (failover=${simple.dataFailover?.label || 'none'})` +
      ` background=${simple.background?.label || 'publics'}` +
      ` emergency=${simple.emergencyPaid?.label || 'publics'} (idle until Trading hard-fail)` +
      ` publics=${publics.map((p) => p.endpoint.label).join(',')}`
  );
}

export function resetRpcEndpointPool(): void {
  tradingPref = null;
  tradingAlchemyFailover = null;
  tradingFailover = null;
  dataPref = null;
  dataFailover = null;
  backgroundPref = null;
  emergencyPaid = null;
  publics = [];
  simple = null;
  tradingHop = 0;
  dataOnFailover = false;
  backgroundIdx = 0;
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
  const st = laneState(normalizeRole(role));
  return Boolean(st && st.rateLimitedUntil > Date.now());
}

export function lanesShareEndpoint(): boolean {
  ensureEndpoints();
  if (!tradingPref || !dataPref) return true;
  return tradingPref.endpoint.url === dataPref.endpoint.url;
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
  // 0 Helius → 1 Alchemy BACKUP → 2 Helius BACKUP → 3+ Emergency
  if (tradingHop <= 0) {
    if (usable(tradingPref)) return tradingPref;
    if (tradingPref && !isHardFailed(tradingPref) && !isRateLimited(tradingPref)) {
      return tradingPref;
    }
  }
  if (tradingHop <= 1) {
    if (usable(tradingAlchemyFailover)) return tradingAlchemyFailover;
    if (tradingAlchemyFailover) return tradingAlchemyFailover;
  }
  if (tradingHop <= 2) {
    if (usable(tradingFailover)) return tradingFailover;
    if (tradingFailover) return tradingFailover;
  }
  const chain = emergencyChain();
  const idx = Math.max(0, tradingHop - 3);
  return chain[idx] || chain[0] || tradingPref;
}

function dataActive(): EndpointState | null {
  ensureEndpoints();
  if (dataOnFailover && dataFailover) return dataFailover;
  if (usable(dataPref)) return dataPref;
  if (dataFailover) {
    dataOnFailover = true;
    return dataFailover;
  }
  return dataPref;
}

function backgroundActive(): EndpointState | null {
  ensureEndpoints();
  const chain: EndpointState[] = [];
  if (backgroundPref) chain.push(backgroundPref);
  for (const p of publics) chain.push(p);
  if (!chain.length) return null;
  const idx = Math.min(backgroundIdx, chain.length - 1);
  const preferred = chain[idx]!;
  if (usable(preferred)) return preferred;
  for (let i = 0; i < chain.length; i++) {
    if (usable(chain[i]!)) {
      backgroundIdx = i;
      return chain[i]!;
    }
  }
  return preferred;
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
    if (tradingHop > 0 && usable(tradingPref)) {
      if (!tradingRecoverAt) tradingRecoverAt = Date.now() + TRADING_RECOVER_MS;
      if (Date.now() >= tradingRecoverAt) {
        tradingHop = 0;
        tradingRecoverAt = 0;
        console.log('[rpc] Trading recovered → Helius');
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
    const maxHop = 2 + emergencyChain().length;
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
  if (ok) return;
  const max = (backgroundPref ? 1 : 0) + publics.length;
  if (backgroundIdx < max - 1) {
    backgroundIdx += 1;
    const st = backgroundActive();
    console.warn(
      `[rpc] Background overflow → ${st?.endpoint.label || 'public'} (idx=${backgroundIdx})`
    );
  }
}

export async function runWithRpcRole<T>(
  role: RpcRole,
  fn: () => Promise<T>,
  feature = 'rpc'
): Promise<T> {
  assertRpcWorkloadEnabled(feature);
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
  ensureEndpoints();
  const st = laneState(normalizeRole(role ?? currentRole()));
  if (!st) throw new Error('No RPC endpoint configured');
  const feature = rpcFeatureAls.getStore() || 'getConnection';
  noteCallTraffic(
    st.endpoint.label,
    feature,
    normalizeRole(role ?? currentRole())
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
    let st = laneState(r);
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
      if (!critical && attempt + 1 >= maxAttempts) break;
      await new Promise((res) => setTimeout(res, 150 * (attempt + 1)));
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

export function getRpcStats() {
  ensureEndpoints();
  const tActive = laneState('primary');
  const dActive = laneState('secondary');
  const bActive = laneState('background');
  const eActive = emergencyChain()[0] || publics[0] || null;
  const tradingOnEmergency = tradingHop >= 3;

  const downFor = (st: EndpointState | null) =>
    st?.unhealthySince ? Math.max(0, Date.now() - st.unhealthySince) : 0;

  const anyHealthy = [tActive, dActive, bActive].some(
    (s) => s && s.healthy && !isRateLimited(s) && !isHardFailed(s)
  );

  let warning: string | null = null;
  if (!anyHealthy) {
    warning =
      'Trading/Data/Background unhealthy — set HELIUS_API_KEY, ALCHEMY_API_KEY, ALCHEMY_API_KEY_BACKUP2.';
  } else if (tradingOnEmergency) {
    warning = `Trading on Emergency (${tActive?.endpoint.label || 'public'}) — Helius recovering.`;
  } else if (tradingHop === 1) {
    warning = `Trading on Alchemy BACKUP failover (${tActive?.endpoint.label}).`;
  } else if (tradingHop === 2) {
    warning = `Trading on Helius BACKUP (${tActive?.endpoint.label}).`;
  } else if (lanesShareEndpoint()) {
    warning =
      'Trading and Data share a URL — set distinct HELIUS_API_KEY vs ALCHEMY_API_KEY.';
  }

  const gate = getRpcGateSnapshot();
  if (!warning && gate.stressed) {
    warning =
      'RPC gate stressed — Data scanners or Background Favourites may be queued/skipped.';
  }

  const allStates = [
    tradingPref,
    tradingAlchemyFailover,
    tradingFailover,
    dataPref,
    dataFailover,
    backgroundPref,
    emergencyPaid,
    ...publics,
  ].filter((e): e is EndpointState => Boolean(e));

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
    const {
      updateRpcLoadSignals,
      getRpcLoadControlSnapshot,
    } = require('./rpcLoadControl') as typeof import('./rpcLoadControl');
    updateRpcLoadSignals({
      primaryLatencyMs: tActive?.latencyMs ?? null,
      secondaryLatencyMs: dActive?.latencyMs ?? null,
      backgroundLatencyMs: bActive?.latencyMs ?? null,
      tradingOnEmergency,
      dataHealthy: Boolean(dActive?.healthy),
      backgroundHealthy: Boolean(bActive?.healthy),
      primaryQueued: gate.lanes.primary.queued,
    });
    loadControl = getRpcLoadControlSnapshot();
  } catch {
    /* optional */
  }

  const tradingCong = buildCongestion('trading', tActive, {
    onEmergency: tradingOnEmergency,
    recoverAt: tradingRecoverAt || undefined,
    gateRole: 'primary',
  });
  const dataCong = buildCongestion('data', dActive, { gateRole: 'secondary' });
  const bgCong = buildCongestion('background', bActive, {
    gateRole: 'background',
  });
  if (loadControl?.favouritesDeferred) {
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
  pushEp(
    tradingAlchemyFailover,
    'primary',
    tActive === tradingAlchemyFailover,
    'primary'
  );
  pushEp(
    tradingFailover,
    'primary',
    tActive === tradingFailover,
    'primary'
  );
  pushEp(dataPref, 'secondary', tActive !== dataPref && dActive === dataPref, 'secondary');
  pushEp(
    dataFailover,
    'secondary',
    dActive === dataFailover,
    'secondary'
  );
  pushEp(
    backgroundPref,
    'background',
    bActive === backgroundPref,
    'background'
  );
  pushEp(emergencyPaid, 'utility', tActive === emergencyPaid, 'utility');
  for (const p of publics) {
    pushEp(
      p,
      'utility',
      tActive === p || bActive === p,
      bActive === p ? 'background' : 'utility'
    );
  }

  return {
    mode: 'sixThree' as const,
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
      label: bActive?.endpoint.label || 'none',
      url: bActive?.endpoint.url || '',
      healthy: Boolean(bActive?.healthy),
      failover: backgroundIdx > 0,
      downForMs: downFor(backgroundPref),
    },
    scannersB: null,
    metrics: null,
    lanesShareEndpoint: lanesShareEndpoint(),
    supports: {
      classicShare: false as const,
      multiLane: false as const,
      simple2Lane: false as const,
      sixThree: true as const,
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
    utilityWeakPublic: isUtilityOnWeakPublic(),
    heliusDisabled: false as const,
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
      background: {
        label: bActive?.endpoint.label || 'none',
        url: bActive?.endpoint.url || '',
        healthy: Boolean(bActive?.healthy),
        latencyMs: bActive?.latencyMs ?? null,
        successRate: successRate(bActive),
        active: true,
        congestion: bgCong,
      },
      emergency: {
        label: eActive?.endpoint.label || 'none',
        url: eActive?.endpoint.url || '',
        healthy: Boolean(eActive?.healthy),
        latencyMs: eActive?.latencyMs ?? null,
        successRate: successRate(eActive),
        active: tradingOnEmergency,
        congestion: emergCong,
      },
      helius: {
        disabled: false as const,
        label: tradingPref?.endpoint.label || 'helius',
        congestion: {
          state: 'ok' as const,
          cause: 'Trading: Helius → Alchemy BACKUP → Helius BACKUP → Emergency',
          details: [
            tradingPref?.endpoint.label || 'helius',
            tradingAlchemyFailover?.endpoint.label || 'alchemy-backup',
            tradingFailover?.endpoint.label || 'helius-backup',
            emergencyPaid?.endpoint.label || 'helius-backup2',
          ].filter(Boolean),
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
  const failoverOrder = [
    tradingAlchemyFailover,
    tradingFailover,
    ...emergencyChain(),
  ];
  for (let i = 0; i < failoverOrder.length; i++) {
    const st = failoverOrder[i];
    if (!st) continue;
    const retry = await probeState(st, 6_000);
    if (retry) {
      tradingHop = i + 1;
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
  // Prefer Background lane for probe CU; still recover Trading when down.
  const probeList: EndpointState[] = [];
  if (backgroundPref) probeList.push(backgroundPref);
  if (tradingPref) probeList.push(tradingPref);
  if (dataPref) probeList.push(dataPref);
  if (tradingHop >= 1 && tradingAlchemyFailover) {
    probeList.push(tradingAlchemyFailover);
  }
  if (tradingHop >= 2 && tradingFailover) probeList.push(tradingFailover);
  if (dataOnFailover && dataFailover) probeList.push(dataFailover);
  if (tradingHop >= 2) {
    for (const e of emergencyChain()) probeList.push(e);
  }
  for (const st of probeList) {
    await probeState(st, 8_000);
    await new Promise((r) => setTimeout(r, 150));
  }
  if (tradingHop > 0 && usable(tradingPref)) {
    tradingHop = 0;
    tradingRecoverAt = 0;
    console.log('[rpc] Trading recovered via probe → Helius');
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
      try {
        const { isRpcWorkloadEnabled } =
          require('./rpcWorkloadControl') as typeof import('./rpcWorkloadControl');
        if (!isRpcWorkloadEnabled('health_probe')) return;
      } catch {
        /* */
      }
      // Probe CU via Background preference: background + data each tick;
      // Trading preferred every tick; Emergency only when active / sparse.
      if (backgroundPref && !isHardFailed(backgroundPref)) {
        await probeState(backgroundPref, 8_000);
      } else if (publics[0] && healthCycle % 2 === 0) {
        await probeState(publics[0], 8_000);
      }
      if (tradingPref && !isHardFailed(tradingPref)) {
        await probeState(tradingPref, 8_000);
      }
      if (dataPref && !isHardFailed(dataPref)) {
        await probeState(dataPref, 8_000);
      }
      if (tradingHop >= 1 && tradingFailover && !isHardFailed(tradingFailover)) {
        await probeState(tradingFailover, 8_000);
      }
      if (dataOnFailover && dataFailover && !isHardFailed(dataFailover)) {
        await probeState(dataFailover, 8_000);
      }
      if (tradingHop >= 1 && tradingAlchemyFailover && !isHardFailed(tradingAlchemyFailover)) {
        await probeState(tradingAlchemyFailover, 8_000);
      }
      if (tradingHop >= 2 && tradingFailover && !isHardFailed(tradingFailover)) {
        await probeState(tradingFailover, 8_000);
      }
      if (tradingHop >= 3 || healthCycle % 6 === 0) {
        for (const e of emergencyChain().slice(0, 2)) {
          await probeState(e, 6_000);
        }
      }
      if (tradingHop > 0 && usable(tradingPref)) {
        if (!tradingRecoverAt) tradingRecoverAt = Date.now() + TRADING_RECOVER_MS;
        if (Date.now() >= tradingRecoverAt) {
          tradingHop = 0;
          tradingRecoverAt = 0;
          console.log('[rpc] Trading healthy again → Helius');
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
