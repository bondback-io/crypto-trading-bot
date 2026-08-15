/**
 * Optional same-lane Main → Emergency soft overflow.
 * OFF by default. Never hops lanes or uses unassigned inventory.
 * Hard-fail failover in connection.ts is unchanged.
 */

export type SoftOverflowLane = 'trading' | 'data' | 'background';

export const SOFT_OVERFLOW_SUSTAIN_MS = 15_000;
export const SOFT_OVERFLOW_RECOVER_MS = 20_000;
export const SOFT_OVERFLOW_EWMA_DEFAULT = 250;
export const SOFT_OVERFLOW_EWMA_MIN = 150;
export const SOFT_OVERFLOW_EWMA_MAX = 800;

const TRADING_OVERFLOW = new Set(['migration', 'live_balance']);
const TRADING_NEVER = new Set([
  'send',
  'trade_entry',
  'zion_place_trade',
  'priority_fee',
  'mev',
]);
const DATA_OVERFLOW = new Set([
  'market_scanner',
  'alpha_scan',
  'zion',
  'bonding_curve',
  'token_metrics',
  'anti_rug',
  'open_mark',
]);

export function clampSoftOverflowEwmaMs(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return SOFT_OVERFLOW_EWMA_DEFAULT;
  return Math.max(
    SOFT_OVERFLOW_EWMA_MIN,
    Math.min(SOFT_OVERFLOW_EWMA_MAX, Math.round(n))
  );
}

export function roleToOverflowLane(
  role: 'primary' | 'secondary' | 'background'
): SoftOverflowLane {
  if (role === 'primary') return 'trading';
  if (role === 'secondary') return 'data';
  return 'background';
}

export function isOverflowEligible(
  lane: SoftOverflowLane,
  feature: string
): boolean {
  const f = String(feature || '')
    .trim()
    .toLowerCase();
  if (!f) return false;
  if (lane === 'trading') {
    if (TRADING_NEVER.has(f)) return false;
    return TRADING_OVERFLOW.has(f);
  }
  if (lane === 'data') return DATA_OVERFLOW.has(f);
  return true;
}

export type SoftOverflowArmPrev = {
  armed: boolean;
  pressureSince: number;
  healthySince: number;
};

export function evaluateSoftOverflowArm(input: {
  enabled: boolean;
  ewmaMs: number | null;
  thresholdMs: number;
  saturated: boolean;
  emergencyAssigned: boolean;
  emergencyUsable: boolean;
  now: number;
  sustainMs?: number;
  recoverMs?: number;
  prev: SoftOverflowArmPrev;
}): {
  armed: boolean;
  reason: string;
  pressureSince: number;
  healthySince: number;
} {
  const sustainMs = input.sustainMs ?? SOFT_OVERFLOW_SUSTAIN_MS;
  const recoverMs = input.recoverMs ?? SOFT_OVERFLOW_RECOVER_MS;
  if (!input.enabled) {
    return { armed: false, reason: 'off', pressureSince: 0, healthySince: 0 };
  }
  if (!input.emergencyAssigned || !input.emergencyUsable) {
    return {
      armed: false,
      reason: 'no_emergency',
      pressureSince: 0,
      healthySince: 0,
    };
  }
  const ewmaHot =
    input.ewmaMs != null &&
    Number.isFinite(input.ewmaMs) &&
    input.ewmaMs > input.thresholdMs;
  const pressure = ewmaHot || input.saturated;
  let { armed, pressureSince, healthySince } = input.prev;

  if (pressure) {
    healthySince = 0;
    if (pressureSince <= 0) pressureSince = input.now;
    const sustained = input.now - pressureSince >= sustainMs;
    if (input.saturated || sustained) {
      return {
        armed: true,
        reason: input.saturated
          ? 'main_saturated'
          : `ewma_${input.thresholdMs}ms_15s`,
        pressureSince,
        healthySince,
      };
    }
    return {
      armed,
      reason: armed ? 'hysteresis' : 'warming',
      pressureSince,
      healthySince,
    };
  }

  pressureSince = 0;
  if (!armed) {
    return { armed: false, reason: 'ok', pressureSince: 0, healthySince: 0 };
  }
  if (healthySince <= 0) healthySince = input.now;
  if (input.now - healthySince >= recoverMs) {
    return { armed: false, reason: 'recovered', pressureSince: 0, healthySince: 0 };
  }
  return { armed: true, reason: 'hysteresis', pressureSince: 0, healthySince };
}

export function shouldSpillThisCall(input: {
  armed: boolean;
  eligible: boolean;
  emergencyUsable: boolean;
  mainNearSaturated: boolean;
}): boolean {
  return (
    input.armed &&
    input.eligible &&
    input.emergencyUsable &&
    input.mainNearSaturated
  );
}

export function isMainNearSaturated(p: {
  inFlight: number;
  queued: number;
  max: number;
}): boolean {
  const max = Math.max(1, Number(p.max) || 0);
  return p.inFlight >= Math.max(1, max - 1) || p.queued > 0;
}

export function isMainSaturated(p: {
  inFlight: number;
  queued: number;
  max: number;
}): boolean {
  const max = Math.max(1, Number(p.max) || 0);
  return p.inFlight >= max;
}

type LaneRuntime = SoftOverflowArmPrev & {
  reason: string;
  mainAt: number[];
  emergencyAt: number[];
};

function emptyLane(): LaneRuntime {
  return {
    armed: false,
    reason: 'off',
    pressureSince: 0,
    healthySince: 0,
    mainAt: [],
    emergencyAt: [],
  };
}

const runtime: Record<SoftOverflowLane, LaneRuntime> = {
  trading: emptyLane(),
  data: emptyLane(),
  background: emptyLane(),
};

const CALL_WINDOW_MS = 60_000;

function prune(arr: number[], now: number): void {
  const cutoff = now - CALL_WINDOW_MS;
  let w = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i]! >= cutoff) arr[w++] = arr[i]!;
  }
  arr.length = w;
}

export function resetSoftOverflowForTests(): void {
  runtime.trading = emptyLane();
  runtime.data = emptyLane();
  runtime.background = emptyLane();
}

function readEnabled(): boolean {
  try {
    const { config } = require('./config') as typeof import('./config');
    return config.rpc?.softOverflowEnabled === true;
  } catch {
    return false;
  }
}

function readThreshold(): number {
  try {
    const { config } = require('./config') as typeof import('./config');
    return clampSoftOverflowEwmaMs(config.rpc?.softOverflowEwmaMs);
  } catch {
    return SOFT_OVERFLOW_EWMA_DEFAULT;
  }
}

export function tickSoftOverflowLane(
  lane: SoftOverflowLane,
  sample: {
    ewmaMs: number | null;
    inFlight: number;
    queued: number;
    max: number;
    emergencyAssigned: boolean;
    emergencyUsable: boolean;
    now?: number;
  }
): void {
  const now = sample.now ?? Date.now();
  const next = evaluateSoftOverflowArm({
    enabled: readEnabled(),
    ewmaMs: sample.ewmaMs,
    thresholdMs: readThreshold(),
    saturated: isMainSaturated(sample),
    emergencyAssigned: sample.emergencyAssigned,
    emergencyUsable: sample.emergencyUsable,
    now,
    prev: runtime[lane],
  });
  runtime[lane].armed = next.armed;
  runtime[lane].reason = next.reason;
  runtime[lane].pressureSince = next.pressureSince;
  runtime[lane].healthySince = next.healthySince;
}

export function isSoftOverflowArmed(lane: SoftOverflowLane): boolean {
  return readEnabled() && runtime[lane].armed;
}

export function shouldOverflowCall(
  lane: SoftOverflowLane,
  feature: string,
  gate: { inFlight: number; queued: number; max: number },
  emergencyUsable: boolean
): boolean {
  if (!readEnabled()) return false;
  return shouldSpillThisCall({
    armed: runtime[lane].armed,
    eligible: isOverflowEligible(lane, feature),
    emergencyUsable,
    mainNearSaturated: isMainNearSaturated(gate),
  });
}

export function noteSoftOverflowDest(
  lane: SoftOverflowLane,
  dest: 'main' | 'emergency'
): void {
  const now = Date.now();
  const row = runtime[lane];
  if (dest === 'emergency') row.emergencyAt.push(now);
  else row.mainAt.push(now);
  prune(row.mainAt, now);
  prune(row.emergencyAt, now);
}

export function getSoftOverflowSnapshot(now = Date.now()): {
  enabled: boolean;
  ewmaMs: number;
  sustainMs: number;
  recoverMs: number;
  lanes: Record<
    SoftOverflowLane,
    {
      overflow_active: boolean;
      overflow_reason: string;
      main_vs_emergency: { main: number; emergency: number };
    }
  >;
} {
  const enabled = readEnabled();
  const ewmaMs = readThreshold();
  const pack = (lane: SoftOverflowLane) => {
    const row = runtime[lane];
    prune(row.mainAt, now);
    prune(row.emergencyAt, now);
    return {
      overflow_active: enabled && row.armed,
      overflow_reason: enabled ? row.reason : 'off',
      main_vs_emergency: {
        main: row.mainAt.length,
        emergency: row.emergencyAt.length,
      },
    };
  };
  return {
    enabled,
    ewmaMs,
    sustainMs: SOFT_OVERFLOW_SUSTAIN_MS,
    recoverMs: SOFT_OVERFLOW_RECOVER_MS,
    lanes: {
      trading: pack('trading'),
      data: pack('data'),
      background: pack('background'),
    },
  };
}
