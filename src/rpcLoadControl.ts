/**
 * Adaptive RPC load control — shed scanner/utility work when lanes stress,
 * without touching Critical trade-entry paths.
 */
import type { RpcGateRole } from './rpcGate';

export type RpcLoadControlSnapshot = {
  /** 1 = normal; higher = slower (e.g. 2 = half rate). */
  scannerSlowFactor: number;
  utilitySlowFactor: number;
  /** True when background work should yield for Critical/Helius. */
  shedBackground: boolean;
  reasons: string[];
  secondarySkipsRecent: number;
  updatedAt: number;
};

type SkipSample = { at: number; role: RpcGateRole };

const skipSamples: SkipSample[] = [];
const SKIP_WINDOW_MS = 60_000;
/** Cap how often skip samples can refresh the adaptive window (per role). */
const SKIP_NOTE_MIN_GAP_MS = 2_500;
const lastSkipNoteAt: Partial<Record<RpcGateRole, number>> = {};

let lastSnapshot: RpcLoadControlSnapshot = {
  scannerSlowFactor: 1,
  utilitySlowFactor: 1,
  shedBackground: false,
  reasons: [],
  secondarySkipsRecent: 0,
  updatedAt: Date.now(),
};

let lastLogAt = 0;

/** Record a non-critical skip so adaptive backoff can react. */
export function noteBackgroundRpcSkip(role: RpcGateRole, feature?: string): void {
  const now = Date.now();
  const last = lastSkipNoteAt[role] || 0;
  // bonding_curve / token_metrics can skip dozens of times in one enrich burst —
  // one sample per gap keeps adaptive from locking ×3 forever.
  if (now - last < SKIP_NOTE_MIN_GAP_MS) {
    void feature;
    return;
  }
  lastSkipNoteAt[role] = now;
  skipSamples.push({ at: now, role });
  while (skipSamples.length && now - skipSamples[0].at > SKIP_WINDOW_MS) {
    skipSamples.shift();
  }
  void feature;
  recompute();
}

function recompute(external?: {
  primaryLatencyMs?: number | null;
  secondaryLatencyMs?: number | null;
  utilityLatencyMs?: number | null;
  utilityWeakPublic?: boolean;
  utilityFailover?: boolean;
  primaryQueued?: number;
  /** @deprecated Lifetime gate skips — ignored (was locking scanner×3 forever). */
  secondarySkipped?: number;
  /** Secondary lane currently idle (heal skip-based ×3). */
  secondaryIdle?: boolean;
}): void {
  const now = Date.now();
  while (skipSamples.length && now - skipSamples[0].at > SKIP_WINDOW_MS) {
    skipSamples.shift();
  }
  const secondarySkipsRecent = skipSamples.filter(
    (s) => s.role === 'secondary' && now - s.at <= SKIP_WINDOW_MS
  ).length;
  const secondarySkipsHot = skipSamples.filter(
    (s) => s.role === 'secondary' && now - s.at <= 15_000
  ).length;

  let scannerSlowFactor = 1;
  let utilitySlowFactor = 1;
  let shedBackground = false;
  const reasons: string[] = [];

  // Only the rolling 60s window — never lifetime lane.skipped (that never resets
  // and permanently pinned scanner×3 after the first boot burst).
  const secSkip = secondarySkipsRecent;
  const laneIdle = external?.secondaryIdle === true;
  // Higher bars + idle heal: micro-skips must not pin scanners at ×3 while
  // Secondary is already empty.
  if (!laneIdle && secondarySkipsHot >= 6) {
    scannerSlowFactor = Math.max(scannerSlowFactor, 3);
    reasons.push(`secondary skips ${secondarySkipsHot}/15s → scanner×3`);
  } else if (!laneIdle && secSkip >= 10) {
    scannerSlowFactor = Math.max(scannerSlowFactor, 3);
    reasons.push(`secondary skips ${secSkip}/60s → scanner×3`);
  } else if (secSkip >= 4) {
    scannerSlowFactor = Math.max(scannerSlowFactor, laneIdle ? 1.5 : 2);
    reasons.push(
      laneIdle
        ? `secondary idle — soft ×${scannerSlowFactor} (${secSkip}/60s)`
        : `secondary skips ${secSkip}/60s → scanner×2`
    );
  }

  const pLat = external?.primaryLatencyMs;
  if (pLat != null && pLat >= 700) {
    shedBackground = true;
    scannerSlowFactor = Math.max(scannerSlowFactor, 3);
    utilitySlowFactor = Math.max(utilitySlowFactor, 2);
    reasons.push(`Critical latency ${Math.round(pLat)}ms → shed background`);
  } else if (pLat != null && pLat >= 450) {
    shedBackground = true;
    scannerSlowFactor = Math.max(scannerSlowFactor, 2);
    reasons.push(`Critical latency ${Math.round(pLat)}ms → reduce scanners`);
  }

  if ((external?.primaryQueued ?? 0) > 0) {
    shedBackground = true;
    scannerSlowFactor = Math.max(scannerSlowFactor, 2);
    reasons.push('Critical queue > 0 → shed scanners/utility');
  }

  const uLat = external?.utilityLatencyMs;
  if (external?.utilityWeakPublic) {
    utilitySlowFactor = Math.max(utilitySlowFactor, 2.5);
    reasons.push('Utility on weak public RPC → slow Favourites only');
  }
  if (external?.utilityFailover) {
    utilitySlowFactor = Math.max(utilitySlowFactor, 2);
    reasons.push('Utility failover → reduce utility workload');
  }
  if (uLat != null && uLat >= 800) {
    utilitySlowFactor = Math.max(utilitySlowFactor, 2.5);
    reasons.push(`Utility latency ${Math.round(uLat)}ms → slow polls`);
  } else if (uLat != null && uLat >= 500) {
    utilitySlowFactor = Math.max(utilitySlowFactor, 1.75);
    reasons.push(`Utility latency ${Math.round(uLat)}ms → soft slowdown`);
  }

  const sLat = external?.secondaryLatencyMs;
  if (sLat != null && sLat >= 600) {
    scannerSlowFactor = Math.max(scannerSlowFactor, 2);
    reasons.push(`Scanners latency ${Math.round(sLat)}ms → slow scanners`);
  }

  try {
    const { alchemyCooldownRemainingMs } =
      require('./rpcProviderPace') as typeof import('./rpcProviderPace');
    const cool = alchemyCooldownRemainingMs(now);
    if (cool > 0) {
      scannerSlowFactor = Math.max(scannerSlowFactor, 2);
      shedBackground = true;
      reasons.push(`alchemy CU/s cooldown ${Math.round(cool / 1000)}s`);
    }
  } catch {
    /* optional */
  }

  lastSnapshot = {
    scannerSlowFactor: Math.min(4, scannerSlowFactor),
    utilitySlowFactor: Math.min(4, utilitySlowFactor),
    shedBackground,
    reasons,
    secondarySkipsRecent: secSkip,
    updatedAt: now,
  };

  if (reasons.length && now - lastLogAt > 20_000) {
    lastLogAt = now;
    console.warn(
      `[rpc-load] adaptive backoff: scanner×${lastSnapshot.scannerSlowFactor} ` +
        `utility×${lastSnapshot.utilitySlowFactor}` +
        (shedBackground ? ' shedBackground=ON' : '') +
        ` — ${reasons.join('; ')}`
    );
  }
}

/** Feed live latency / failover signals from connection (call periodically). */
export function updateRpcLoadSignals(signals: {
  primaryLatencyMs?: number | null;
  secondaryLatencyMs?: number | null;
  utilityLatencyMs?: number | null;
  utilityWeakPublic?: boolean;
  utilityFailover?: boolean;
  primaryQueued?: number;
  secondarySkipped?: number;
  secondaryIdle?: boolean;
}): void {
  recompute(signals);
}

export function getRpcLoadControlSnapshot(): RpcLoadControlSnapshot {
  return { ...lastSnapshot, reasons: [...lastSnapshot.reasons] };
}

/** Effective scanner poll interval after adaptive slowdown. */
export function adaptiveScannerIntervalMs(baseMs: number): number {
  const f = getRpcLoadControlSnapshot().scannerSlowFactor;
  let ms = Math.round(Math.max(baseMs, baseMs * f));
  try {
    const { alchemyCooldownRemainingMs } =
      require('./rpcProviderPace') as typeof import('./rpcProviderPace');
    const cool = alchemyCooldownRemainingMs();
    if (cool > 0) ms = Math.max(ms, Math.min(90_000, cool + 5_000));
  } catch {
    /* optional */
  }
  return ms;
}

function secondarySpikeDegradesEnrich(): boolean {
  try {
    const { isRpcContainmentEnabled, isLaneSpiking } =
      require('./rpcSpikeInspector') as typeof import('./rpcSpikeInspector');
    return isRpcContainmentEnabled() && isLaneSpiking('secondary');
  } catch {
    return false;
  }
}

function utilitySpikeSlowsPolls(): boolean {
  try {
    const { isRpcContainmentEnabled, isLaneSpiking } =
      require('./rpcSpikeInspector') as typeof import('./rpcSpikeInspector');
    return isRpcContainmentEnabled() && isLaneSpiking('utility');
  } catch {
    return false;
  }
}

/** True when scanners should skip heavy enrich/curve and use crude rank. */
export function shouldDegradeScannerEnrich(): boolean {
  if (getRpcLoadControlSnapshot().scannerSlowFactor >= 3) return true;
  return secondarySpikeDegradesEnrich();
}

/** True if this scanner tick should skip under adaptive load. */
export function shouldSkipScannerTick(subsystem: string): {
  skip: boolean;
  reason: string | null;
} {
  const snap = getRpcLoadControlSnapshot();
  const id = String(subsystem || '').toLowerCase();
  // Market / Alpha / Zion must keep ticking — degrade enrich at ×3, never drop.
  // Slow Favourites via utilitySlowFactor — do not zero signal intake.
  const intakeCritical =
    id.includes('market') || id.includes('zion') || id.includes('alpha');
  if (intakeCritical) {
    return { skip: false, reason: null };
  }
  // Non-intake scanners: ×3+ still skips.
  if (snap.scannerSlowFactor >= 3) {
    return {
      skip: true,
      reason: snap.shedBackground
        ? `adaptive shed for Critical (${snap.reasons[0] || 'load'})`
        : `adaptive scanner×${snap.scannerSlowFactor} (${subsystem})`,
    };
  }
  // Probabilistic skip when mild slowdown (×2). Cap so Market Scanner cannot
  // go quiet for long stretches.
  if (snap.scannerSlowFactor >= 2) {
    const skipChance = Math.min(0.35, 1 - 1 / snap.scannerSlowFactor);
    if (Math.random() < skipChance) {
      return {
        skip: true,
        reason: `adaptive scanner×${snap.scannerSlowFactor} (${subsystem})`,
      };
    }
  }
  return { skip: false, reason: null };
}

export function utilityPollScale(): {
  cycleCapScale: number;
  gapScale: number;
  skipActivity: boolean;
} {
  const f = getRpcLoadControlSnapshot().utilitySlowFactor;
  let cycleCapScale = 1 / f;
  let gapScale = f;
  let skipActivity = f >= 2.5;
  if (utilitySpikeSlowsPolls()) {
    gapScale = Math.max(gapScale, 2.5);
    cycleCapScale = Math.min(cycleCapScale, 0.4);
    skipActivity = true;
  }
  return { cycleCapScale, gapScale, skipActivity };
}
