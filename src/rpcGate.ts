/**
 * Per-lane RPC concurrency + rate limits + in-flight job dedupe.
 * Prevents unbounded parallel calls that choke providers a few minutes after boot.
 */

/** Mirrors connection.RpcRole — kept local to avoid circular imports. */
export type RpcGateRole = 'primary' | 'secondary' | 'utility' | 'watchers';

export type RpcGateDecision = 'run' | 'queued' | 'skipped_rate' | 'skipped_busy' | 'deduped';

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
};

export type RpcGateSnapshot = {
  lanes: Record<RpcGateRole, RpcLaneGateStats>;
  backlog: number;
  stressed: boolean;
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
};

const CRITICAL_FEATURES = new Set([
  'trade_entry',
  'trade_exit',
  'mev_sandwich',
  'send_tx',
  'confirm_tx',
]);

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
      // Five exclusive scanner services share this gate — keep headroom.
      maxConcurrent: envInt('RPC_LANE_CONCURRENCY_SECONDARY', 10, 1, 32),
      maxRps: envInt('RPC_LANE_RPS_SECONDARY', 20, 1, 120),
      maxQueue: envInt('RPC_LANE_QUEUE_SECONDARY', 16, 0, 100),
      maxWaitMs: 4_000,
    };
  }
  if (role === 'watchers') {
    return {
      maxConcurrent: envInt('RPC_LANE_CONCURRENCY_WATCHERS', 6, 1, 24),
      maxRps: envInt('RPC_LANE_RPS_WATCHERS', 12, 1, 80),
      maxQueue: envInt('RPC_LANE_QUEUE_WATCHERS', 10, 0, 80),
      maxWaitMs: 3_000,
    };
  }
  return {
    // Favourites + activity + utility_light share this gate.
    maxConcurrent: envInt('RPC_LANE_CONCURRENCY_UTILITY', 6, 1, 24),
    maxRps: envInt('RPC_LANE_RPS_UTILITY', 12, 1, 80),
    maxQueue: envInt('RPC_LANE_QUEUE_UTILITY', 10, 0, 80),
    maxWaitMs: 3_000,
  };
}

const lanes: Record<RpcGateRole, LaneState> = {
  primary: emptyLane(),
  secondary: emptyLane(),
  utility: emptyLane(),
  watchers: emptyLane(),
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

/**
 * Acquire a lane slot (concurrency + rate). Critical work waits; non-critical
 * may skip when the lane is saturated so background polls cannot pile up.
 */
export async function acquireRpcLane(
  role: RpcGateRole,
  feature?: string
): Promise<{
  release: () => void;
  decision: RpcGateDecision;
  queueWaitMs: number;
  inFlight: number;
}> {
  const limits = laneLimits(role);
  const lane = lanes[role];
  const critical = isCritical(feature);
  const waitStartedAt = Date.now();

  refill(lane, role);

  // Rate limit: critical waits briefly for a token; non-critical may skip.
  if (lane.tokens < 1) {
    lane.hitRateLimit += 1;
    if (!critical) {
      lane.skipped += 1;
      try {
        const { noteBackgroundRpcSkip } =
          require('./rpcLoadControl') as typeof import('./rpcLoadControl');
        noteBackgroundRpcSkip(role, feature);
      } catch {
        /* */
      }
      logGate(role, 'background delayed (rate limit / load protection)', {
        feature: feature || 'ungated',
        inFlight: lane.inFlight,
        queued: lane.waiters.length,
        tokens: Number(lane.tokens.toFixed(2)),
        maxRps: limits.maxRps,
        lifetimeSkipped: lane.skipped,
      });
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
    if (!critical && lane.waiters.length >= limits.maxQueue) {
      lane.skipped += 1;
      try {
        const { noteBackgroundRpcSkip } =
          require('./rpcLoadControl') as typeof import('./rpcLoadControl');
        noteBackgroundRpcSkip(role, feature);
      } catch {
        /* */
      }
      logGate(role, 'background delayed (concurrency / load protection)', {
        feature: feature || 'ungated',
        inFlight: lane.inFlight,
        queued: lane.waiters.length,
        maxConcurrent: limits.maxConcurrent,
      });
      throw new RpcGateSkipError('busy', role, feature);
    }
    if (!critical && limits.maxQueue <= 0) {
      lane.skipped += 1;
      try {
        const { noteBackgroundRpcSkip } =
          require('./rpcLoadControl') as typeof import('./rpcLoadControl');
        noteBackgroundRpcSkip(role, feature);
      } catch {
        /* */
      }
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
          lane.skipped += 1;
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
    const next = lane.waiters.shift();
    if (next) next.resolve();
  };

  return {
    release,
    decision: 'run',
    queueWaitMs: Math.max(0, Date.now() - waitStartedAt),
    inFlight: lane.inFlight,
  };
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

const SPIKE_ACCOUNTINFO_ENRICH_CAP = 1;
const SPIKE_ACCOUNTINFO_TOTAL_CAP = 2;
const accountInfoInFlight: Record<'watchers' | 'secondary', number> = {
  watchers: 0,
  secondary: 0,
};

function isAccountInfoCapLane(
  role: RpcGateRole | undefined
): role is 'watchers' | 'secondary' {
  return role === 'watchers' || role === 'secondary';
}

/** Enrich/reprice/curve — droppable when the lane is already at the spike cap. */
function isAccountInfoEnrichFeature(feature?: string): boolean {
  const f = String(feature || 'ungated');
  if (CRITICAL_FEATURES.has(f) || f.startsWith('trade_')) return false;
  if (/send_tx|confirm_tx|trade_exit|health_probe|arm_|trigger_/i.test(f)) {
    return false;
  }
  return true;
}

export function getSpikeAccountInfoInFlight(
  role: 'watchers' | 'secondary'
): number {
  return accountInfoInFlight[role];
}

export function __resetSpikeAccountInfoCapForTests(): void {
  accountInfoInFlight.watchers = 0;
  accountInfoInFlight.secondary = 0;
}

/**
 * During a Watchers/secondary spike, cap concurrent getAccountInfo (enrich 1, total 2).
 * Prefer arm/trigger over optional enrich. Exits are never dropped.
 * Engages on lane spike even when containment is OFF (mirrors always-on getTx caps).
 */
export function acquireSpikeAccountInfoCap(
  role: RpcGateRole | undefined,
  methods: string[],
  feature?: string
): { allowed: boolean; release: () => void } {
  const noop = { allowed: true, release: () => {} };
  if (!isAccountInfoCapLane(role)) return noop;
  if (!methods.some((m) => m === 'getAccountInfo')) return noop;
  try {
    const { isLaneSpiking } =
      require('./rpcSpikeInspector') as typeof import('./rpcSpikeInspector');
    if (!isLaneSpiking(role)) return noop;
  } catch {
    return noop;
  }
  const enrich = isAccountInfoEnrichFeature(feature);
  const cap = enrich ? SPIKE_ACCOUNTINFO_ENRICH_CAP : SPIKE_ACCOUNTINFO_TOTAL_CAP;
  if (accountInfoInFlight[role] >= cap) {
    lanes[role].skipped += 1;
    try {
      const { noteBackgroundRpcSkip } =
        require('./rpcLoadControl') as typeof import('./rpcLoadControl');
      noteBackgroundRpcSkip(role, feature);
    } catch {
      /* */
    }
    logGate(
      role,
      enrich
        ? 'getAccountInfo enrich dropped (spike cap 1)'
        : 'getAccountInfo arm/trigger dropped (spike cap 2)',
      {
        feature: feature || 'ungated',
        inFlight: accountInfoInFlight[role],
      }
    );
    return { allowed: false, release: () => {} };
  }
  accountInfoInFlight[role] += 1;
  let released = false;
  return {
    allowed: true,
    release: () => {
      if (released) return;
      released = true;
      accountInfoInFlight[role] = Math.max(0, accountInfoInFlight[role] - 1);
    },
  };
}

const PARSED_TX_ENRICH_CAP = envInt('RPC_PARSED_TX_ENRICH_CAP', 1, 1, 4);
const PARSED_TX_TOTAL_CAP = envInt('RPC_PARSED_TX_TOTAL_CAP', 2, 1, 8);
const parsedTxInFlight: Record<'secondary' | 'utility', number> = {
  secondary: 0,
  utility: 0,
};

function isParsedTxCapLane(
  role: RpcGateRole | undefined
): role is 'secondary' | 'utility' {
  return role === 'secondary' || role === 'utility';
}

function isParsedTxMethod(methods: string[]): boolean {
  return methods.some(
    (m) => m === 'getParsedTransaction' || m === 'getTransaction'
  );
}

/**
 * Droppable enrich/history getTx — anti-rug, Favourites parse, ungated.
 * Discovery (migration/zion/market/alpha) uses the higher total cap.
 */
export function isParsedTxEnrichFeature(feature?: string): boolean {
  const f = String(feature || 'ungated');
  if (CRITICAL_FEATURES.has(f) || f.startsWith('trade_')) return false;
  if (/send_tx|confirm_tx|trade_exit|health_probe/i.test(f)) return false;
  if (
    /^(migration|zion|market_scanner|alpha_scan|bonding_curve)$/i.test(f)
  ) {
    return false;
  }
  return true;
}

export function getParsedTxInFlight(role: 'secondary' | 'utility'): number {
  return parsedTxInFlight[role];
}

export function __resetParsedTxCapForTests(): void {
  parsedTxInFlight.secondary = 0;
  parsedTxInFlight.utility = 0;
}

/**
 * Always-on cap for concurrent getParsedTransaction / getTransaction on
 * secondary + utility. Primary / exits are never gated here.
 */
export function acquireParsedTxCap(
  role: RpcGateRole | undefined,
  methods: string[],
  feature?: string
): { allowed: boolean; release: () => void } {
  const noop = { allowed: true, release: () => {} };
  if (!isParsedTxCapLane(role)) return noop;
  if (!isParsedTxMethod(methods)) return noop;
  const enrich = isParsedTxEnrichFeature(feature);
  const cap = enrich ? PARSED_TX_ENRICH_CAP : PARSED_TX_TOTAL_CAP;
  if (parsedTxInFlight[role] >= cap) {
    lanes[role].skipped += 1;
    try {
      const { noteBackgroundRpcSkip } =
        require('./rpcLoadControl') as typeof import('./rpcLoadControl');
      noteBackgroundRpcSkip(role, feature);
    } catch {
      /* */
    }
    logGate(
      role,
      enrich
        ? `getParsedTransaction enrich dropped (cap ${cap})`
        : `getParsedTransaction discovery dropped (cap ${cap})`,
      {
        feature: feature || 'ungated',
        inFlight: parsedTxInFlight[role],
      }
    );
    return { allowed: false, release: () => {} };
  }
  parsedTxInFlight[role] += 1;
  let released = false;
  return {
    allowed: true,
    release: () => {
      if (released) return;
      released = true;
      parsedTxInFlight[role] = Math.max(0, parsedTxInFlight[role] - 1);
    },
  };
}

/** In-flight dedupe: same key shares one promise; later callers await or skip. */
const inflightJobs = new Map<string, Promise<unknown>>();

export async function runDedupedRpcJob<T>(
  key: string,
  fn: () => Promise<T>,
  opts?: {
    /** If true, join the in-flight job; else skip with undefined */
    join?: boolean;
    /** If false and nothing is in-flight, do not start a new job. */
    startIfMissing?: boolean;
  }
): Promise<T | undefined> {
  const existing = inflightJobs.get(key);
  if (existing) {
    const roleHint = key.split(':')[0];
    if (
      roleHint === 'primary' ||
      roleHint === 'secondary' ||
      roleHint === 'utility' ||
      roleHint === 'watchers'
    ) {
      lanes[roleHint].deduped += 1;
    } else {
      lanes.utility.deduped += 1;
    }
    if (opts?.join === false) return undefined;
    return (await existing) as T;
  }
  if (opts?.startIfMissing === false) return undefined;
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
  const roles: RpcGateRole[] = ['primary', 'secondary', 'utility', 'watchers'];
  const out = {} as Record<RpcGateRole, RpcLaneGateStats>;
  let backlog = 0;
  for (const role of roles) {
    const lane = lanes[role];
    const limits = laneLimits(role);
    refill(lane, role);
    backlog += lane.waiters.length + Math.max(0, lane.inFlight - Math.floor(limits.maxConcurrent * 0.75));
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
    };
  }
  const stressed =
    out.utility.queued > 0 ||
    out.utility.skipped > 0 ||
    out.secondary.queued > 2 ||
    out.primary.hitConcurrency > 0 ||
    out.primary.queued > 0;
  return { lanes: out, backlog, stressed };
}

/**
 * Exclusive map: each service has its own paid key — do not stall scanners/
 * Favourites because Trading's gate is briefly busy.
 */
export function shouldDeferBackgroundForCritical(_kind: 'scanner' | 'utility' = 'scanner'): {
  defer: boolean;
  reason: string | null;
} {
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
