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
  type RpcLaneRole,
} from './rpcUrl';

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
/** Currently resolved index serving each lane (may differ after failover) */
let activePrimary = 0;
let activeSecondary = 0;
let activeUtility = 0;
/** Legacy single active pointer — mirrors primary lane for older callers */
let activeIndex = 0;

const rpcRoleAls = new AsyncLocalStorage<RpcRole>();
/** Optional feature tag for call metering (wallet_poll, health_probe, …). */
const rpcFeatureAls = new AsyncLocalStorage<string>();

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
const RATE_LIMIT_COOLDOWN_MS = 60_000;
/** Don't re-log "marked unhealthy" more often than this. */
const UNHEALTHY_LOG_THROTTLE_MS = 15_000;
/** EWMA weight for new samples — dampens single getTransaction spikes in the UI. */
const LATENCY_EWMA_ALPHA = 0.22;
/** EWMA above this → start latency-stress timer (matches rpcDiagnostic). */
const LATENCY_STRESS_MS = 500;
/** EWMA below this → clear latency stress (hysteresis). */
const LATENCY_RECOVER_MS = 320;
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

function latencyStressGraceMs(state: EndpointState | undefined): number {
  if (state && isPublicRpcUrl(state.endpoint.url)) {
    return LATENCY_STRESS_GRACE_PUBLIC_MS;
  }
  return LATENCY_STRESS_GRACE_MS;
}

function isRpcRateLimitMessage(error: string): boolean {
  return (
    /429|rate.?limit|-32429|too many requests/i.test(error) ||
    /connect.?timeout|UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|fetch failed/i.test(
      error
    )
  );
}

function isEndpointRateLimited(state: EndpointState | undefined): boolean {
  return Boolean(state && state.rateLimitedUntil > Date.now());
}

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
  const utilIdx = endpoints.findIndex((e) => e.role === 'utility');
  preferredUtility =
    utilIdx >= 0
      ? utilIdx
      : endpoints.findIndex((e) => isPublicRpcUrl(e.endpoint.url)) >= 0
        ? endpoints.findIndex((e) => isPublicRpcUrl(e.endpoint.url))
        : preferredSecondary;
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
        .map((e) => `${e.endpoint.label}[${e.role}]`)
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
  const run = () => rpcRoleAls.run(role, async () => await fn());
  if (feature) return rpcFeatureAls.run(feature, run);
  return run();
}

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
  if (!other?.healthy || isEndpointRateLimited(other)) return false;
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
        ? `latency EWMA ${pref?.latencyMs ?? '—'}ms ≥ ${LATENCY_STRESS_MS}ms for ${Math.round(latencyStressGraceMs(pref) / 1000)}s`
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
  if (pref?.healthy && !isEndpointRateLimited(pref) && !latencySoft) {
    setActiveForRole(role, preferred);
    return preferred;
  }

  const downMs = downForMs(pref);
  const rateLimited = isEndpointRateLimited(pref);
  // Sticky grace for hard failures only — latency soft-failover skips this wait.
  if (
    !latencySoft &&
    !rateLimited &&
    downMs > 0 &&
    downMs < failoverDownMs()
  ) {
    return preferred;
  }

  const shareLoad = Boolean(config.rpc?.shareLoad);
  const avoidPublicForCritical = shareLoad && role === 'primary';

  // Utility + public preferred is slow: try another public/fallback (e.g. publicnode)
  // before burning Alchemy/Helius/QuickNode CU on wallet polls.
  if (latencySoft && role === 'utility' && pref) {
    let bestIdx = -1;
    let bestMs = Number.POSITIVE_INFINITY;
    for (let i = 0; i < endpoints.length; i++) {
      if (i === preferred) continue;
      const e = endpoints[i];
      if (!e?.healthy || isEndpointRateLimited(e)) continue;
      if (
        e.endpoint.label === 'quicknode' ||
        isQuicknodeRpcUrl(e.endpoint.url)
      ) {
        continue;
      }
      const isAltPublic =
        isPublicRpcUrl(e.endpoint.url) ||
        e.role === 'fallback' ||
        e.role === 'utility';
      if (!isAltPublic) continue;
      if (!isFasterAlternate(pref, e)) continue;
      const ms = e.latencyMs ?? Number.POSITIVE_INFINITY;
      if (ms < bestMs) {
        bestMs = ms;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      const other = endpoints[bestIdx]!;
      const now = Date.now();
      if (now - (pref.lastLatencyFailoverLogAt || 0) >= LATENCY_FAILOVER_LOG_THROTTLE_MS) {
        pref.lastLatencyFailoverLogAt = now;
        console.warn(
          `[rpc] utility lane piggybacking on ${other.endpoint.label} ` +
            `(public rpc-url EWMA ${pref.latencyMs ?? '—'}ms — prefer faster public/fallback before paid)`
        );
      }
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
  }

  // 1) Other paid free lane (Helius ↔ Alchemy)
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
  // Clear cooldown only after a real success (probe after cooldown window).
  if (state.rateLimitedUntil && Date.now() >= state.rateLimitedUntil) {
    state.rateLimitedUntil = 0;
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
        `[rpc] ${state.endpoint.label} latency stressed (EWMA ${ewma}ms, last ${state.lastCallLatencyMs ?? '—'}ms) — soft failover in ${latencyStressGraceMs(state) / 1000}s if it stays high`
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
  if (isEndpointRateLimited(state)) {
    state.healthy = false;
    state.lastCheckedAt = Date.now();
    return false;
  }

  return runWithRpcFeature('health_probe', async () => {
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

  for (let attempt = 0; attempt < order.length; attempt++) {
    const index = order[attempt];
    const state = endpoints[index];
    if (!state) continue;

    // Skip cooling 429 hosts when another endpoint can take the call.
    if (
      isEndpointRateLimited(state) &&
      endpoints.some((e, i) => i !== index && !isEndpointRateLimited(e))
    ) {
      continue;
    }

    const pref = preferredIndexFor(r);
    const prefRateLimited = isEndpointRateLimited(endpoints[pref]);
    // Sticky grace only for transient errors — not 429 cooldowns.
    if (
      !prefRateLimited &&
      !state.healthy &&
      attempt > 0 &&
      downForMs(endpoints[pref]) < failoverDownMs()
    ) {
      if (index !== pref) continue;
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
} {
  ensureEndpoints();
  const pIdx = resolveIndexForRole('primary');
  const sIdx = resolveIndexForRole('secondary');
  const uIdx = resolveIndexForRole('utility');
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
      'Using a public Solana RPC on the primary lane — fine for paper, but rate limits can miss buys. Set HELIUS_API_KEY (+ ALCHEMY_API_KEY) for free faster failover.';
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
    active: getActiveEndpointLabel('primary'),
    activeUrl: maskUrl(getRpcUrl('primary')),
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
      let lane: RpcRole | null = null;
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
  let healthCycle = 0;

  /** Share load: keep public/utility hot for diagnostics; probe paid lanes sparsely. */
  function shouldProbeIndex(index: number, cycle: number): boolean {
    if (!Boolean(config.rpc?.shareLoad)) return true;
    const state = endpoints[index];
    if (!state) return false;
    const isPublic = isPublicRpcUrl(state.endpoint.url);
    const isUtil = index === preferredUtility;
    const isPrimary = index === preferredPrimary;
    const isSecondary =
      index === preferredSecondary && preferredSecondary !== preferredPrimary;
    // Preferred / active utility: keep warm. Other public fallbacks (e.g. slow
    // official mainnet-beta): rare probes only — avoids painting the table with 1s+ spikes.
    if (isUtil || index === activeUtility) {
      if (
        state.latencyStressedSince != null &&
        state.latencyMs != null &&
        state.latencyMs >= LATENCY_STRESS_MS
      ) {
        return cycle % 2 === 0;
      }
      return true;
    }
    if (isPublic) {
      return cycle % 4 === 0;
    }
    // Helius (critical): every 3rd cycle (~90s at 30s interval)
    if (isPrimary) return cycle % 3 === 0;
    // Alchemy (scanners): every 2nd cycle (~60s)
    if (isSecondary) return cycle % 2 === 0;
    // QuickNode mid-tier: keep warm for failover (~60s), same cadence as Alchemy
    if (
      index === preferredQuicknode ||
      state.endpoint.label === 'quicknode' ||
      isQuicknodeRpcUrl(state.endpoint.url)
    ) {
      return cycle % 2 === 0;
    }
    // Inactive fallback: rare
    return cycle % 4 === 0;
  }

  // Boot: probe utility/public first, then preferred paid lanes once (not all fallbacks).
  void (async () => {
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
      await new Promise((r) => setTimeout(r, 250));
    }
  })();

  healthTimer = setInterval(() => {
    void (async () => {
      healthCycle += 1;
      for (let i = 0; i < endpoints.length; i++) {
        if (!shouldProbeIndex(i, healthCycle)) continue;
        await probeEndpoint(i);
        await new Promise((r) => setTimeout(r, 200));
      }
      await maybeSwitchEndpoints();
    })();
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
