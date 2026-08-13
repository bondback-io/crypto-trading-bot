/**
 * 2-lane RPC concurrency / RPS gate (Trading + Data).
 */

export type RpcGateRole = 'primary' | 'secondary';

export type RpcLaneGateStats = {
  inFlight: number;
  max: number;
  queued: number;
  skipped: number;
  skipsPerMin: number;
  topSkipReason: string | null;
  rps: number;
  maxRps: number;
};

export type RpcGateSnapshot = {
  stressed: boolean;
  backlog: number;
  lanes: {
    primary: RpcLaneGateStats;
    secondary: RpcLaneGateStats;
  };
};

type LaneState = {
  inFlight: number;
  queued: number;
  skipped: number;
  skipReasons: Map<string, number>;
  skipTimestamps: number[];
  recentStarts: number[];
  waiters: Array<{
    resolve: () => void;
    reject: (e: Error) => void;
    priority: number;
    reason: string;
  }>;
};

const PRIMARY_MAX = 8;
const PRIMARY_RPS = 40;
const SECONDARY_MAX = 12;
const SECONDARY_RPS = 60;
const SECONDARY_QUEUE_CAP = 48;
const PRIMARY_QUEUE_CAP = 24;

const lanes: Record<RpcGateRole, LaneState> = {
  primary: emptyLane(),
  secondary: emptyLane(),
};

function emptyLane(): LaneState {
  return {
    inFlight: 0,
    queued: 0,
    skipped: 0,
    skipReasons: new Map(),
    skipTimestamps: [],
    recentStarts: [],
    waiters: [],
  };
}

export class RpcGateSkipError extends Error {
  readonly kind: 'rate' | 'busy';
  readonly role: RpcGateRole;
  readonly feature?: string;

  constructor(kind: 'rate' | 'busy', role: RpcGateRole, feature?: string) {
    super(
      `RPC ${role} lane ${kind === 'rate' ? 'rate-limited' : 'busy'} — skipped ${feature || 'work'}`
    );
    this.name = 'RpcGateSkipError';
    this.kind = kind;
    this.role = role;
    this.feature = feature;
  }
}

export function isRpcGateSkipError(err: unknown): err is RpcGateSkipError {
  return (
    err instanceof RpcGateSkipError ||
    (err instanceof Error && err.name === 'RpcGateSkipError')
  );
}

function pruneTimestamps(arr: number[], windowMs: number): void {
  const cutoff = Date.now() - windowMs;
  while (arr.length && arr[0]! < cutoff) arr.shift();
}

function laneStats(role: RpcGateRole): RpcLaneGateStats {
  const L = lanes[role];
  pruneTimestamps(L.skipTimestamps, 60_000);
  pruneTimestamps(L.recentStarts, 1_000);
  let topSkipReason: string | null = null;
  let topN = 0;
  for (const [k, v] of L.skipReasons) {
    if (v > topN) {
      topN = v;
      topSkipReason = k;
    }
  }
  return {
    inFlight: L.inFlight,
    max: role === 'primary' ? PRIMARY_MAX : SECONDARY_MAX,
    queued: L.queued,
    skipped: L.skipped,
    skipsPerMin: L.skipTimestamps.length,
    topSkipReason,
    rps: L.recentStarts.length,
    maxRps: role === 'primary' ? PRIMARY_RPS : SECONDARY_RPS,
  };
}

export function getRpcGateSnapshot(): RpcGateSnapshot {
  const primary = laneStats('primary');
  const secondary = laneStats('secondary');
  const backlog = primary.queued + secondary.queued;
  const stressed =
    secondary.queued > SECONDARY_MAX ||
    secondary.skipsPerMin > 20 ||
    primary.queued > PRIMARY_MAX / 2;
  return {
    stressed,
    backlog,
    lanes: { primary, secondary },
  };
}

function noteSkip(role: RpcGateRole, reason: string): void {
  const L = lanes[role];
  L.skipped += 1;
  L.skipTimestamps.push(Date.now());
  L.skipReasons.set(reason, (L.skipReasons.get(reason) || 0) + 1);
}

function tryAcquire(role: RpcGateRole): boolean {
  const L = lanes[role];
  const max = role === 'primary' ? PRIMARY_MAX : SECONDARY_MAX;
  const maxRps = role === 'primary' ? PRIMARY_RPS : SECONDARY_RPS;
  pruneTimestamps(L.recentStarts, 1_000);
  if (L.inFlight >= max) return false;
  if (L.recentStarts.length >= maxRps) return false;
  L.inFlight += 1;
  L.recentStarts.push(Date.now());
  return true;
}

function release(role: RpcGateRole): void {
  const L = lanes[role];
  L.inFlight = Math.max(0, L.inFlight - 1);
  // Drain highest priority waiter
  L.waiters.sort((a, b) => b.priority - a.priority);
  while (L.waiters.length && tryAcquire(role)) {
    const w = L.waiters.shift()!;
    L.queued = Math.max(0, L.queued - 1);
    w.resolve();
    return;
  }
}

async function acquire(
  role: RpcGateRole,
  opts: { priority?: number; reason?: string; skippable?: boolean } = {}
): Promise<void> {
  const priority = opts.priority ?? 0;
  const reason = opts.reason || 'rpc';
  const skippable = opts.skippable ?? false;
  if (tryAcquire(role)) return;

  const L = lanes[role];
  const cap = role === 'primary' ? PRIMARY_QUEUE_CAP : SECONDARY_QUEUE_CAP;
  if (L.queued >= cap) {
    noteSkip(role, reason);
    if (skippable) {
      throw new RpcGateSkipError('busy', role, reason);
    }
    // Critical: wait briefly then retry once
  }

  if (skippable && L.queued > cap / 2) {
    noteSkip(role, reason);
    throw new RpcGateSkipError('busy', role, reason);
  }

  await new Promise<void>((resolve, reject) => {
    L.queued += 1;
    L.waiters.push({ resolve, reject, priority, reason });
  });
}

/**
 * Run work under the lane gate.
 * Favourites / activity: lowest priority, skippable on Data.
 */
export async function runThroughRpcGate<T>(
  role: RpcGateRole,
  fn: () => Promise<T>,
  opts: {
    priority?: number;
    reason?: string;
    skippable?: boolean;
  } = {}
): Promise<T> {
  await acquire(role, opts);
  try {
    return await fn();
  } finally {
    release(role);
  }
}

/** Feature-named entry used by connection / scanners. */
export async function runWithRpcFeatureGate<T>(
  feature: string,
  role: RpcGateRole,
  fn: () => Promise<T>
): Promise<T> {
  const favouritesLike = /favourit|activity|wallet_poll|wallet_import|soft.?watch/i.test(
    feature
  );
  const scannerLike = /scanner|alpha|zion|health_probe|bonding|metrics|anti.?rug/i.test(
    feature
  );
  return runThroughRpcGate(role, fn, {
    priority: role === 'primary' ? 100 : favouritesLike ? 0 : scannerLike ? 40 : 50,
    reason: feature,
    skippable: favouritesLike || (role === 'secondary' && scannerLike),
  });
}

const dedupeInflight = new Map<string, Promise<unknown>>();

/** Dedupe safe read-only jobs only (same key coalesces). */
export async function runDedupedRpcJob<T>(
  key: string,
  fn: () => Promise<T>,
  opts?: { /** If true, join the in-flight job; else skip with undefined */ join?: boolean }
): Promise<T | undefined> {
  const existing = dedupeInflight.get(key);
  if (existing) {
    if (opts?.join === false) return undefined;
    return existing as Promise<T>;
  }
  const p = fn().finally(() => {
    if (dedupeInflight.get(key) === p) dedupeInflight.delete(key);
  });
  dedupeInflight.set(key, p);
  return p;
}

/** Yield scanners/Favourites when Trading busy or Data saturated. */
export function shouldDeferBackgroundForCritical(
  kind: 'scanner' | 'utility' = 'scanner'
): { defer: boolean; reason: string | null } {
  const snap = getRpcGateSnapshot();
  const p = snap.lanes.primary;
  const s = snap.lanes.secondary;

  try {
    const { getRpcLoadControlSnapshot } =
      require('./rpcLoadControl') as typeof import('./rpcLoadControl');
    const load = getRpcLoadControlSnapshot();
    if (load.shedBackground && kind === 'scanner' && load.scannerSlowFactor >= 3) {
      return {
        defer: true,
        reason: load.reasons[0] || 'adaptive shed for Trading',
      };
    }
    if (kind === 'utility' && load.utilitySlowFactor >= 3) {
      return {
        defer: true,
        reason: `data adaptive×${load.utilitySlowFactor}`,
      };
    }
  } catch {
    /* */
  }

  if (p.queued > 0 || p.inFlight >= Math.max(1, p.max - 1)) {
    return {
      defer: true,
      reason: `Trading lane busy (inFlight ${p.inFlight}/${p.max}, queue ${p.queued})`,
    };
  }
  if (kind === 'scanner' && (s.queued >= 2 || s.inFlight >= s.max)) {
    return {
      defer: true,
      reason: `Data lane saturated (inFlight ${s.inFlight}/${s.max}, queue ${s.queued})`,
    };
  }
  if (kind === 'utility' && (s.queued >= 2 || snap.stressed)) {
    return {
      defer: true,
      reason: `Data lane stressed (inFlight ${s.inFlight}/${s.max}, queue ${s.queued})`,
    };
  }
  return { defer: false, reason: null };
}

const deferLogAt = new Map<string, number>();

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
      (extra && Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '')
  );
}

export function resetRpcGatesForTests(): void {
  lanes.primary = emptyLane();
  lanes.secondary = emptyLane();
  dedupeInflight.clear();
}
