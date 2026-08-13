/**
 * 3-lane RPC concurrency / RPS gate (Trading + Data + Background).
 */

export type RpcGateRole = 'primary' | 'secondary' | 'background';

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
    background: RpcLaneGateStats;
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

const LIMITS: Record<
  RpcGateRole,
  { max: number; rps: number; queueCap: number }
> = {
  primary: { max: 8, rps: 40, queueCap: 24 },
  secondary: { max: 12, rps: 60, queueCap: 48 },
  background: { max: 6, rps: 30, queueCap: 32 },
};

const lanes: Record<RpcGateRole, LaneState> = {
  primary: emptyLane(),
  secondary: emptyLane(),
  background: emptyLane(),
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
  const lim = LIMITS[role];
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
    max: lim.max,
    queued: L.queued,
    skipped: L.skipped,
    skipsPerMin: L.skipTimestamps.length,
    topSkipReason,
    rps: L.recentStarts.length,
    maxRps: lim.rps,
  };
}

export function getRpcGateSnapshot(): RpcGateSnapshot {
  const primary = laneStats('primary');
  const secondary = laneStats('secondary');
  const background = laneStats('background');
  const backlog = primary.queued + secondary.queued + background.queued;
  const stressed =
    secondary.queued > LIMITS.secondary.max ||
    secondary.skipsPerMin > 20 ||
    background.queued > LIMITS.background.max ||
    background.skipsPerMin > 25 ||
    primary.queued > LIMITS.primary.max / 2;
  return {
    stressed,
    backlog,
    lanes: { primary, secondary, background },
  };
}

const SKIP_TIMESTAMPS_CAP = 2_000;
const SKIP_REASONS_CAP = 64;

function noteSkip(role: RpcGateRole, reason: string): void {
  const L = lanes[role];
  L.skipped += 1;
  L.skipTimestamps.push(Date.now());
  pruneTimestamps(L.skipTimestamps, 60_000);
  while (L.skipTimestamps.length > SKIP_TIMESTAMPS_CAP) L.skipTimestamps.shift();
  L.skipReasons.set(reason, (L.skipReasons.get(reason) || 0) + 1);
  if (L.skipReasons.size > SKIP_REASONS_CAP) {
    let worstKey: string | null = null;
    let worstN = Infinity;
    for (const [k, v] of L.skipReasons) {
      if (v < worstN) {
        worstN = v;
        worstKey = k;
      }
    }
    if (worstKey) L.skipReasons.delete(worstKey);
  }
}

function tryAcquire(role: RpcGateRole): boolean {
  const L = lanes[role];
  const lim = LIMITS[role];
  pruneTimestamps(L.recentStarts, 1_000);
  if (L.inFlight >= lim.max) return false;
  if (L.recentStarts.length >= lim.rps) return false;
  L.inFlight += 1;
  L.recentStarts.push(Date.now());
  return true;
}

function release(role: RpcGateRole): void {
  const L = lanes[role];
  L.inFlight = Math.max(0, L.inFlight - 1);
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
  const cap = LIMITS[role].queueCap;
  // Hard cap for ALL roles — never enqueue past queueCap (OOM under thrash).
  if (L.queued >= cap) {
    noteSkip(role, reason);
    throw new RpcGateSkipError('busy', role, reason);
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

export async function runWithRpcFeatureGate<T>(
  feature: string,
  role: RpcGateRole,
  fn: () => Promise<T>
): Promise<T> {
  const favouritesLike =
    /favourit|activity|wallet_poll|wallet_import|soft.?watch|health_probe|zionWalletBalance|zionWalletSigs/i.test(
      feature
    );
  const scannerLike =
    /scanner|alpha|zion|bonding|metrics|anti.?rug|open_mark/i.test(feature);
  const priority =
    role === 'primary'
      ? 100
      : role === 'background'
        ? favouritesLike
          ? 0
          : 20
        : favouritesLike
          ? 0
          : scannerLike
            ? 40
            : 50;
  return runThroughRpcGate(role, fn, {
    priority,
    reason: feature,
    skippable:
      role === 'background' ||
      favouritesLike ||
      (role === 'secondary' && scannerLike),
  });
}

const dedupeInflight = new Map<string, Promise<unknown>>();

export async function runDedupedRpcJob<T>(
  key: string,
  fn: () => Promise<T>,
  opts?: { join?: boolean }
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

export function shouldDeferBackgroundForCritical(
  kind: 'scanner' | 'utility' = 'scanner'
): { defer: boolean; reason: string | null } {
  const snap = getRpcGateSnapshot();
  const p = snap.lanes.primary;
  const s = snap.lanes.secondary;
  const b = snap.lanes.background;

  try {
    const { getRpcLoadControlSnapshot, isSignalsRpcHealthy } =
      require('./rpcLoadControl') as typeof import('./rpcLoadControl');
    const load = getRpcLoadControlSnapshot();
    // Own-lane ×3 only — Trading shed must not silence Market/Alpha intake.
    if (
      kind === 'scanner' &&
      load.scannerSlowFactor >= 3 &&
      !load.signalsRpcHealthy &&
      !isSignalsRpcHealthy()
    ) {
      return {
        defer: true,
        reason: load.throttledByOwnLaneOnly
          ? load.reasons.find((r) => /data|Scanners|secondary/i.test(r)) ||
            `own-lane scanner×${load.scannerSlowFactor}`
          : `scanner×${load.scannerSlowFactor}`,
      };
    }
    if (kind === 'utility' && load.utilitySlowFactor >= 3) {
      return {
        defer: true,
        reason: `background adaptive×${load.utilitySlowFactor}`,
      };
    }
  } catch {
    /* */
  }

  // Favourites/utility yield to Trading busy; scanners stay free (signal intake).
  if (
    kind === 'utility' &&
    (p.queued > 0 || p.inFlight >= Math.max(1, p.max - 1))
  ) {
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
  if (kind === 'utility' && (b.queued >= 2 || b.skipsPerMin > 15 || snap.stressed)) {
    return {
      defer: true,
      reason: `Background lane stressed (inFlight ${b.inFlight}/${b.max}, queue ${b.queued})`,
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
  lanes.background = emptyLane();
  dedupeInflight.clear();
}
