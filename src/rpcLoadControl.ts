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
}): void {
  const now = Date.now();
  while (skipSamples.length && now - skipSamples[0].at > SKIP_WINDOW_MS) {
    skipSamples.shift();
  }
  const secondarySkipsRecent = skipSamples.filter(
    (s) => s.role === 'secondary' && now - s.at <= SKIP_WINDOW_MS
  ).length;

  let scannerSlowFactor = 1;
  let utilitySlowFactor = 1;
  let shedBackground = false;
  const reasons: string[] = [];

  // Only the rolling 60s window — never lifetime lane.skipped (that never resets
  // and permanently pinned scanner×3 after the first boot burst).
  const lifetimeSecSkip = external?.secondarySkipped ?? 0;
  const secSkip = secondarySkipsRecent;
  // #region agent log
  if (lifetimeSecSkip > 0 || secondarySkipsRecent > 0 || secSkip >= 3) {
    try {
      const { agentDebugLog } =
        require('./agentDebugLog') as typeof import('./agentDebugLog');
      const nowLog = Date.now();
      const last = (recompute as { _dbgAt?: number })._dbgAt || 0;
      if (nowLog - last > 8_000) {
        (recompute as { _dbgAt?: number })._dbgAt = nowLog;
        agentDebugLog('A', 'rpcLoadControl.ts:recompute', 'skip window vs lifetime', {
          runId: 'post-fix',
          secondarySkipsRecent,
          lifetimeSecSkip,
          secSkipUsed: secSkip,
          lifetimeIgnored: true,
          lifetimeDominates: false,
          primaryLatencyMs: external?.primaryLatencyMs ?? null,
          secondaryLatencyMs: external?.secondaryLatencyMs ?? null,
          utilityLatencyMs: external?.utilityLatencyMs ?? null,
          utilityWeakPublic: external?.utilityWeakPublic ?? false,
          utilityFailover: external?.utilityFailover ?? false,
          primaryQueued: external?.primaryQueued ?? 0,
          sampleCount: skipSamples.length,
        });
      }
    } catch {
      /* */
    }
  }
  // #endregion
  if (secSkip >= 8) {
    scannerSlowFactor = Math.max(scannerSlowFactor, 3);
    reasons.push(`secondary skips ${secSkip}/60s → scanner×3`);
  } else if (secSkip >= 3) {
    scannerSlowFactor = Math.max(scannerSlowFactor, 2);
    reasons.push(`secondary skips ${secSkip}/60s → scanner×2`);
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
    reasons.push('Utility on weak public RPC → cut Favourites/activity');
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
}): void {
  recompute(signals);
}

export function getRpcLoadControlSnapshot(): RpcLoadControlSnapshot {
  return { ...lastSnapshot, reasons: [...lastSnapshot.reasons] };
}

/** Effective scanner poll interval after adaptive slowdown. */
export function adaptiveScannerIntervalMs(baseMs: number): number {
  const f = getRpcLoadControlSnapshot().scannerSlowFactor;
  return Math.round(Math.max(baseMs, baseMs * f));
}

/** True if this scanner tick should skip under adaptive load. */
export function shouldSkipScannerTick(subsystem: string): {
  skip: boolean;
  reason: string | null;
} {
  const snap = getRpcLoadControlSnapshot();
  if (snap.shedBackground && snap.scannerSlowFactor >= 3) {
    return {
      skip: true,
      reason: `adaptive shed for Critical (${snap.reasons[0] || 'load'})`,
    };
  }
  // Probabilistic skip only when mild slowdown (×2). Full shed uses defer gate.
  // Cap skip chance so Market Scanner cannot go quiet for long stretches.
  if (snap.scannerSlowFactor >= 2 && snap.scannerSlowFactor < 3) {
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
  return {
    cycleCapScale: 1 / f,
    gapScale: f,
    skipActivity: f >= 2.5,
  };
}
