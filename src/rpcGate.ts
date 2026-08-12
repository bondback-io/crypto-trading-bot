/**
 * Per-lane RPC concurrency + rate limits + in-flight job dedupe.
 * Prevents unbounded parallel calls that choke providers a few minutes after boot.
 *
 * Global STRESSED is live Critical+Scanners only — never lifetime utility.skipped.
 */

/** Mirrors connection.RpcRole — kept local to avoid circular imports. */
export type RpcGateRole = 'primary' | 'secondary' | 'utility';

export type RpcGateDecision = 'run' | 'queued' | 'skipped_rate' | 'skipped_busy' | 'deduped';

export type RpcSkipReason =
  | 'rate'
  | 'queue_full'
  | 'wait_timeout'
  | 'busy'
  | 'stale'
  | 'evicted_low_pri';

export type RpcLaneGateStats = {
  role: RpcGateRole;
  inFlight: number;
  maxConcurrent: number;
  queued: number;
  maxQueue: number;
  tokens: number;
  maxRps: number;
  hitConcurrency: number;
  hitRateLimit: number;
  skipped: number;
  deduped: number;
  skippedByReason: Record<string, number>;
};

export type RpcGateSnapshot = {
  lanes: Record<RpcGateRole, RpcLaneGateStats>;
  backlog: number;
  /** Live Critical+Scanners pressure only (clears when those lanes quiet). */
  stressed: boolean;
  /** Live utility queue/inFlight — Favourites defer, not global STRESSED. */
  utilityStressed: boolean;
  stressedSince: number | null;
};

type Waiter = {
  resolve: () => void;
  reject: (err: Error) => void;
  feature: string;
  enqueuedAt: number;
};

type LaneState = {
  inFlight: number;
  waiters: Waiter[];
  /** Token-bucket tokens (refill to maxRps each second). */
  tokens: number;
  lastRefillAt: number;
  hitConcurrency: number;
  hitRateLimit: number;
  skipped: number;
  deduped: number;
  lastLogAt: number;
  skippedByReason: Record<string, number>;
};

const CRITICAL_FEATURES = new Set([
  'trade_entry',
  'migration',
  'mev_sandwich',
  'send_tx',
  'confirm_tx',
]);

/** Low-priority secondary enrich — drop these first under queue pressure. */
const LOW_PRI_SECONDARY = new Set(['bonding_curve', 'token_metrics']);

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function laneLimits(role: RpcGateRole): {
  maxConcurrent: number;
  maxRps: number;
  maxQueue: number;
  /** Non-critical wait budget before skip (ms). Critical waits longer. */
  maxWaitMs: number;
} {
  if (role === 'primary') {
    return {
      maxConcurrent: envInt('RPC_LANE_CONCURRENCY_PRIMARY', 8, 1, 32),
      maxRps: envInt('RPC_LANE_RPS_PRIMARY', 20, 1, 120),
      maxQueue: envInt('RPC_LANE_QUEUE_PRIMARY', 24, 0, 200),
      maxWaitMs: 8_000,
    };
  }
  if (role === 'secondary') {
    return {
      maxConcurrent: envInt('RPC_LANE_CONCURRENCY_SECONDARY', 3, 1, 24),
      maxRps: envInt('RPC_LANE_RPS_SECONDARY', 6, 1, 80),
      maxQueue: envInt('RPC_LANE_QUEUE_SECONDARY', 6, 0, 100),
      maxWaitMs: 3_000,
    };
  }
  return {
    maxConcurrent: envInt('RPC_LANE_CONCURRENCY_UTILITY', 2, 1, 12),
    maxRps: envInt('RPC_LANE_RPS_UTILITY', 4, 1, 40),
    maxQueue: envInt('RPC_LANE_QUEUE_UTILITY', 4, 0, 80),
    maxWaitMs: 2_000,
  };
}

const lanes: Record<RpcGateRole, LaneState> = {
  primary: emptyLane(),
  secondary: emptyLane(),
  utility: emptyLane(),
};

function emptyLane(): LaneState {
  return {
    inFlight: 0,
    waiters: [],
    tokens: 100, // full bucket until first refill caps to maxRps
    lastRefillAt: Date.now(),
    hitConcurrency: 0,
    hitRateLimit: 0,
    skipped: 0,
    deduped: 0,
    lastLogAt: 0,
    skippedByReason: {},
  };
}

function refill(lane: LaneState, role: RpcGateRole): void {
  const { maxRps } = laneLimits(role);
  const now = Date.now();
  const elapsed = Math.max(0, now - lane.lastRefillAt);
  if (elapsed <= 0) return;
  lane.tokens = Math.min(maxRps, lane.tokens + (elapsed / 1000) * maxRps);
  lane.lastRefillAt = now;
}

function isCritical(feature?: string): boolean {
  if (!feature) return false;
  return CRITICAL_FEATURES.has(feature) || feature.startsWith('trade_');
}

function featureBucket(feature?: string): string {
  const f = (feature || 'other').toLowerCase();
  if (f.includes('bonding_curve')) return 'bonding_curve';
  if (f.includes('token_metrics') || f.includes('holder')) return 'token_metrics';
  if (f.includes('market_scanner') || f === 'market_scanner') return 'market_scanner';
  if (f.includes('zion') || f === 'zion') return 'zion';
  if (f.includes('alpha')) return 'alpha_scan';
  return 'other';
}

function isLowPriSecondary(feature?: string): boolean {
  return LOW_PRI_SECONDARY.has(featureBucket(feature));
}

function enrichStaleMs(feature?: string): number {
  return isLowPriSecondary(feature) ? 1_500 : 3_000;
}

let lastSkipReasonLogAt = 0;
let lastStaleDropLogAt = 0;
let stressedSince: number | null = null;
let lastDegradedClearedLogAt = 0;

function bumpSkip(
  role: RpcGateRole,
  reason: RpcSkipReason,
  feature?: string
): void {
  const lane = lanes[role];
  lane.skipped += 1;
  lane.skippedByReason[reason] = (lane.skippedByReason[reason] || 0) + 1;
  const bucket = featureBucket(feature);
  lane.skippedByReason[`feature:${bucket}`] =
    (lane.skippedByReason[`feature:${bucket}`] || 0) + 1;
  if (role === 'secondary') {
    const now = Date.now();
    if (now - lastSkipReasonLogAt > 12_000) {
      lastSkipReasonLogAt = now;
      console.warn(
        `[secondary_skip_reason] reason=${reason} feature=${feature || 'ungated'} ` +
          `bucket=${bucket}`
      );
    }
  }
}

function noteSkipSample(role: RpcGateRole, feature?: string): void {
  try {
    const { noteBackgroundRpcSkip } =
      require('./rpcLoadControl') as typeof import('./rpcLoadControl');
    noteBackgroundRpcSkip(role, feature);
  } catch {
    /* */
  }
}

function logGate(
  role: RpcGateRole,
  message: string,
  data: Record<string, unknown>
): void {
  const lane = lanes[role];
  const now = Date.now();
  if (now - lane.lastLogAt < 8_000) return;
  lane.lastLogAt = now;
  console.warn(`[rpc-gate] ${role}: ${message}`, data);
}

let lastScannerCappedAt = 0;
function logScannerCapped(
  kind: 'rate' | 'busy',
  feature: string | undefined,
  lane: LaneState,
  limits: ReturnType<typeof laneLimits>
): void {
  const now = Date.now();
  if (now - lastScannerCappedAt < 12_000) return;
  lastScannerCappedAt = now;
  console.warn(
    `[scanner_rpc_capped] ${kind} feature=${feature || 'ungated'} ` +
      `inFlight=${lane.inFlight}/${limits.maxConcurrent} q=${lane.waiters.length} ` +
      `rps=${limits.maxRps}`
  );
}

/** Reject and remove aged waiters; returns how many dropped. */
function pruneStaleWaiters(role: RpcGateRole): number {
  const lane = lanes[role];
  const limits = laneLimits(role);
  const now = Date.now();
  let dropped = 0;
  const keep: Waiter[] = [];
  for (const w of lane.waiters) {
    const ttl =
      role === 'secondary' ? enrichStaleMs(w.feature) : limits.maxWaitMs;
    if (now - w.enqueuedAt > ttl) {
      dropped += 1;
      bumpSkip(role, 'stale', w.feature);
      noteSkipSample(role, w.feature);
      try {
        w.reject(new RpcGateSkipError('busy', role, w.feature));
      } catch {
        /* */
      }
    } else {
      keep.push(w);
    }
  }
  lane.waiters = keep;
  if (dropped > 0 && now - lastStaleDropLogAt > 12_000) {
    lastStaleDropLogAt = now;
    console.warn(
      `[background_job_dropped_stale] role=${role} dropped=${dropped} remaining=${lane.waiters.length}`
    );
  }
  return dropped;
}

/** Evict oldest low-priority secondary waiters to free a slot. */
function evictLowPriSecondaryWaiters(need = 1): number {
  const lane = lanes.secondary;
  let evicted = 0;
  for (let i = 0; i < lane.waiters.length && evicted < need; ) {
    const w = lane.waiters[i]!;
    if (isLowPriSecondary(w.feature)) {
      lane.waiters.splice(i, 1);
      bumpSkip('secondary', 'evicted_low_pri', w.feature);
      noteSkipSample('secondary', w.feature);
      try {
        w.reject(new RpcGateSkipError('busy', 'secondary', w.feature));
      } catch {
        /* */
      }
      evicted += 1;
    } else {
      i += 1;
    }
  }
  return evicted;
}

/**
 * Acquire a lane slot (concurrency + rate). Critical work waits; non-critical
 * may skip when the lane is saturated so background polls cannot pile up.
 */
export async function acquireRpcLane(
  role: RpcGateRole,
  feature?: string
): Promise<{ release: () => void; decision: RpcGateDecision }> {
  const limits = laneLimits(role);
  const lane = lanes[role];
  const critical = isCritical(feature);

  refill(lane, role);
  if (role === 'secondary') pruneStaleWaiters(role);

  // Rate limit: critical waits briefly for a token; non-critical may skip.
  if (lane.tokens < 1) {
    lane.hitRateLimit += 1;
    if (!critical) {
      bumpSkip(role, 'rate', feature);
      noteSkipSample(role, feature);
      logGate(role, 'background delayed (rate limit / load protection)', {
        feature: feature || 'ungated',
        inFlight: lane.inFlight,
        queued: lane.waiters.length,
        tokens: Number(lane.tokens.toFixed(2)),
        maxRps: limits.maxRps,
        lifetimeSkipped: lane.skipped,
      });
      if (role === 'secondary') {
        logScannerCapped('rate', feature, lane, limits);
      }
      throw new RpcGateSkipError('rate', role, feature);
    }
    const waitForTokenMs = Math.min(1_500, limits.maxWaitMs);
    const deadline = Date.now() + waitForTokenMs;
    while (lane.tokens < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 40));
      refill(lane, role);
    }
    if (lane.tokens < 1) {
      // Allow critical through anyway — trade path must not die on token starvation.
      lane.tokens = 1;
    }
  }

  // Concurrency: wait in queue or skip.
  if (lane.inFlight >= limits.maxConcurrent) {
    lane.hitConcurrency += 1;

    // Secondary: free space by dropping stale / low-pri before refusing signal work.
    if (role === 'secondary' && !critical) {
      pruneStaleWaiters(role);
      if (
        lane.waiters.length >= Math.max(0, limits.maxQueue - 1) ||
        lane.inFlight >= limits.maxConcurrent
      ) {
        evictLowPriSecondaryWaiters(1);
      }
    }

    if (!critical && lane.waiters.length >= limits.maxQueue) {
      // Last chance: evict low-pri if incoming is higher priority.
      if (
        role === 'secondary' &&
        !isLowPriSecondary(feature) &&
        evictLowPriSecondaryWaiters(1) > 0
      ) {
        /* fall through to enqueue */
      } else {
        bumpSkip(role, 'queue_full', feature);
        noteSkipSample(role, feature);
        logGate(role, 'background delayed (concurrency / load protection)', {
          feature: feature || 'ungated',
          inFlight: lane.inFlight,
          queued: lane.waiters.length,
          maxConcurrent: limits.maxConcurrent,
        });
        if (role === 'secondary') {
          logScannerCapped('busy', feature, lane, limits);
        }
        throw new RpcGateSkipError('busy', role, feature);
      }
    }
    if (!critical && limits.maxQueue <= 0) {
      bumpSkip(role, 'busy', feature);
      noteSkipSample(role, feature);
      throw new RpcGateSkipError('busy', role, feature);
    }

    // Still full after eviction attempts — skip low-pri immediately.
    if (
      role === 'secondary' &&
      !critical &&
      isLowPriSecondary(feature) &&
      lane.waiters.length >= Math.max(0, limits.maxQueue - 1)
    ) {
      bumpSkip(role, 'busy', feature);
      noteSkipSample(role, feature);
      throw new RpcGateSkipError('busy', role, feature);
    }

    const maxWait = critical ? Math.max(limits.maxWaitMs, 12_000) : limits.maxWaitMs;
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        feature: feature || 'ungated',
        enqueuedAt: Date.now(),
      };
      lane.waiters.push(waiter);
      logGate(role, 'queued', {
        feature: waiter.feature,
        inFlight: lane.inFlight,
        queued: lane.waiters.length,
        maxConcurrent: limits.maxConcurrent,
      });
      const timer = setTimeout(() => {
        const idx = lane.waiters.indexOf(waiter);
        if (idx >= 0) lane.waiters.splice(idx, 1);
        if (critical) {
          // Critical: proceed anyway (may briefly exceed cap) rather than fail entry.
          resolve();
        } else {
          bumpSkip(role, 'wait_timeout', feature);
          noteSkipSample(role, feature);
          reject(new RpcGateSkipError('busy', role, feature));
        }
      }, maxWait);
      const origResolve = waiter.resolve;
      const origReject = waiter.reject;
      waiter.resolve = () => {
        clearTimeout(timer);
        origResolve();
      };
      waiter.reject = (err) => {
        clearTimeout(timer);
        origReject(err);
      };
    });
  }

  lane.tokens -= 1;
  lane.inFlight += 1;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    lane.inFlight = Math.max(0, lane.inFlight - 1);
    if (role === 'secondary') pruneStaleWaiters(role);
    const next = lane.waiters.shift();
    if (next) next.resolve();
  };

  return { release, decision: 'run' };
}

export class RpcGateSkipError extends Error {
  readonly kind: 'rate' | 'busy';
  readonly role: RpcGateRole;
  readonly feature?: string;

  constructor(kind: 'rate' | 'busy', role: RpcGateRole, feature?: string) {
    super(`RPC ${role} lane ${kind === 'rate' ? 'rate-limited' : 'busy'} — skipped ${feature || 'work'}`);
    this.name = 'RpcGateSkipError';
    this.kind = kind;
    this.role = role;
    this.feature = feature;
  }
}

export function isRpcGateSkipError(err: unknown): err is RpcGateSkipError {
  return err instanceof RpcGateSkipError;
}

/** In-flight dedupe: same key shares one promise; later callers await or skip. */
const inflightJobs = new Map<string, Promise<unknown>>();
let lastDedupLogAt = 0;

export async function runDedupedRpcJob<T>(
  key: string,
  fn: () => Promise<T>,
  opts?: { /** If true, join the in-flight job; else skip with undefined */ join?: boolean }
): Promise<T | undefined> {
  const existing = inflightJobs.get(key);
  if (existing) {
    const roleHint = key.split(':')[0];
    if (roleHint === 'primary' || roleHint === 'secondary' || roleHint === 'utility') {
      lanes[roleHint].deduped += 1;
    } else {
      lanes.utility.deduped += 1;
    }
    if (Date.now() - lastDedupLogAt > 15_000) {
      lastDedupLogAt = Date.now();
      const tag =
        roleHint === 'secondary' ? 'scanner_deduped' : 'duplicate_rpc_suppressed';
      console.warn(`[${tag}] ${String(key).slice(0, 96)}`);
    }
    if (opts?.join === false) return undefined;
    return (await existing) as T;
  }
  const promise = (async () => {
    try {
      return await fn();
    } finally {
      inflightJobs.delete(key);
    }
  })();
  inflightJobs.set(key, promise);
  return promise;
}

export function getRpcGateSnapshot(): RpcGateSnapshot {
  const roles: RpcGateRole[] = ['primary', 'secondary', 'utility'];
  const out = {} as Record<RpcGateRole, RpcLaneGateStats>;
  let backlog = 0;
  for (const role of roles) {
    const lane = lanes[role];
    const limits = laneLimits(role);
    refill(lane, role);
    backlog +=
      lane.waiters.length +
      Math.max(0, lane.inFlight - Math.floor(limits.maxConcurrent * 0.75));
    out[role] = {
      role,
      inFlight: lane.inFlight,
      maxConcurrent: limits.maxConcurrent,
      queued: lane.waiters.length,
      maxQueue: limits.maxQueue,
      tokens: Number(lane.tokens.toFixed(2)),
      maxRps: limits.maxRps,
      hitConcurrency: lane.hitConcurrency,
      hitRateLimit: lane.hitRateLimit,
      skipped: lane.skipped,
      deduped: lane.deduped,
      skippedByReason: { ...lane.skippedByReason },
    };
  }
  // Live Critical+Scanners only — never lifetime utility.skipped / hitConcurrency.
  const stressed =
    out.primary.queued > 0 ||
    out.primary.inFlight >= out.primary.maxConcurrent ||
    out.secondary.queued > 2 ||
    out.secondary.inFlight >= out.secondary.maxConcurrent;
  const utilityStressed =
    out.utility.queued > 0 ||
    out.utility.inFlight >= out.utility.maxConcurrent;

  const now = Date.now();
  if (stressed) {
    if (stressedSince == null) stressedSince = now;
  } else if (stressedSince != null) {
    const heldMs = now - stressedSince;
    if (now - lastDegradedClearedLogAt > 15_000) {
      lastDegradedClearedLogAt = now;
      console.warn(
        `[degraded_cleared_critical_healthy] gate STRESSED cleared after ${Math.round(heldMs / 1000)}s ` +
          `(Critical+Scanners live pressure gone)`
      );
    }
    stressedSince = null;
  }

  return {
    lanes: out,
    backlog,
    stressed,
    utilityStressed,
    stressedSince,
  };
}

/**
 * Scanners defer only on own-lane saturation / own-lane ×3.
 * Utility yields when Critical busy or utility lane itself stressed.
 */
export function shouldDeferBackgroundForCritical(kind: 'scanner' | 'utility' = 'scanner'): {
  defer: boolean;
  reason: string | null;
} {
  const snap = getRpcGateSnapshot();
  const p = snap.lanes.primary;
  const s = snap.lanes.secondary;
  const u = snap.lanes.utility;

  try {
    const { getRpcLoadControlSnapshot } =
      require('./rpcLoadControl') as typeof import('./rpcLoadControl');
    const load = getRpcLoadControlSnapshot();
    // Own-lane ×3: hard-defer scanners (not Critical shed).
    if (kind === 'scanner' && load.scannerSlowFactor >= 3) {
      return {
        defer: true,
        reason: load.throttledByOwnLaneOnly
          ? load.reasons.find((r) => /secondary|Scanners/i.test(r)) ||
            `own-lane scanner×${load.scannerSlowFactor}`
          : `scanner×${load.scannerSlowFactor}`,
      };
    }
    if (kind === 'utility' && load.utilitySlowFactor >= 3) {
      return {
        defer: true,
        reason: `utility adaptive×${load.utilitySlowFactor}`,
      };
    }
  } catch {
    /* */
  }

  // Utility yields to Critical busy; scanners do not (isolation / freer Scanners).
  if (
    kind === 'utility' &&
    (p.queued > 0 || p.inFlight >= Math.max(1, p.maxConcurrent - 1))
  ) {
    return {
      defer: true,
      reason: `Critical lane busy (inFlight ${p.inFlight}/${p.maxConcurrent}, queue ${p.queued})`,
    };
  }
  // Use in-flight/queue only — lane.skipped is a lifetime counter and must NOT
  // permanently disable scanners after a few early gate skips.
  if (
    kind === 'scanner' &&
    (s.queued >= 2 || s.inFlight >= s.maxConcurrent)
  ) {
    return {
      defer: true,
      reason: `Scanners lane saturated (inFlight ${s.inFlight}/${s.maxConcurrent}, queue ${s.queued})`,
    };
  }
  if (kind === 'utility' && (u.queued >= 2 || snap.utilityStressed)) {
    return {
      defer: true,
      reason: `Utility lane stressed (inFlight ${u.inFlight}/${u.maxConcurrent}, queue ${u.queued})`,
    };
  }
  return { defer: false, reason: null };
}

const deferLogAt = new Map<string, number>();

/** Throttled operator-visible log when background work yields to load protection. */
export function logBackgroundDeferred(
  subsystem: string,
  reason: string,
  extra?: Record<string, unknown>
): void {
  const key = `${subsystem}:${reason.slice(0, 48)}`;
  const now = Date.now();
  const last = deferLogAt.get(key) || 0;
  if (now - last < 12_000) return;
  deferLogAt.set(key, now);
  console.warn(
    `[rpc-load] ${subsystem} delayed — load protection: ${reason}` +
      (extra && Object.keys(extra).length
        ? ` ${JSON.stringify(extra)}`
        : '')
  );
}
