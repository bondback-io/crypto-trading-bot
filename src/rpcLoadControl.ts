/**
 * Adaptive RPC load control — shed scanner/utility work when lanes stress,
 * without touching Critical trade-entry paths.
 *
 * Scanner slowdown is own-lane only (secondary skips / Scanners latency).
 * Critical stress still sheds Favourites/utility, never raises scanner×.
 * Utility weak public sheds Favourites hard without latching global STRESSED.
 */
import type { RpcGateRole } from './rpcGate';

export type DegradedBy = 'none' | 'critical' | 'scanners' | 'utility';

export type RpcLoadControlSnapshot = {
  /** 1 = normal; higher = slower (e.g. 2 = half rate). */
  scannerSlowFactor: number;
  utilitySlowFactor: number;
  /** True when background work should yield for Critical/Helius. */
  shedBackground: boolean;
  /**
   * True when shedBackground is protecting a paid Critical lane.
   * False when Critical is itself weak public — Favourites must not hard-stop
   * from Critical shed alone (utility hard-shed is separate).
   */
  shedProtectsPaidCritical: boolean;
  /**
   * True when scanner× > 1 and only secondary skips/latency drove it
   * (Critical/utility stress did not raise scanner×).
   */
  throttledByOwnLaneOnly: boolean;
  reasons: string[];
  criticalReasons: string[];
  utilityReasons: string[];
  scannerReasons: string[];
  degradedBy: DegradedBy;
  /** Utility-only hard shed (weak public / high utility×) — not Critical shed. */
  utilityShedHard: boolean;
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
  shedProtectsPaidCritical: false,
  throttledByOwnLaneOnly: false,
  reasons: [],
  criticalReasons: [],
  utilityReasons: [],
  scannerReasons: [],
  degradedBy: 'none',
  utilityShedHard: false,
  secondarySkipsRecent: 0,
  updatedAt: Date.now(),
};

let lastLogAt = 0;
let lastOwnLaneLogAt = 0;
let lastUtilityShedHardLogAt = 0;

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
  primaryFailover?: boolean;
  primaryQueued?: number;
  /** Preferred Critical is weak public (no paid Helius/Alchemy BACKUP). */
  primaryWeakPublic?: boolean;
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
  const criticalReasons: string[] = [];
  const utilityReasons: string[] = [];
  const scannerReasons: string[] = [];
  // When Critical is itself public, latency/failover must not kill Favourites —
  // there is no paid lane to protect.
  const paidCritical = external?.primaryWeakPublic !== true;

  // Only the rolling 60s window — never lifetime lane.skipped (that never resets
  // and permanently pinned scanner×3 after the first boot burst).
  const secSkip = secondarySkipsRecent;
  const laneIdle = external?.secondaryIdle === true;
  // Higher bars + idle heal: micro-skips must not pin scanners at ×3 while
  // Secondary is already empty.
  if (!laneIdle && secondarySkipsHot >= 6) {
    scannerSlowFactor = Math.max(scannerSlowFactor, 3);
    scannerReasons.push(`secondary skips ${secondarySkipsHot}/15s → scanner×3`);
  } else if (!laneIdle && secSkip >= 10) {
    scannerSlowFactor = Math.max(scannerSlowFactor, 3);
    scannerReasons.push(`secondary skips ${secSkip}/60s → scanner×3`);
  } else if (secSkip >= 4) {
    scannerSlowFactor = Math.max(scannerSlowFactor, laneIdle ? 1.5 : 2);
    scannerReasons.push(
      laneIdle
        ? `secondary idle — soft ×${scannerSlowFactor} (${secSkip}/60s)`
        : `secondary skips ${secSkip}/60s → scanner×2`
    );
  }

  const pLat = external?.primaryLatencyMs;
  if (pLat != null && pLat >= 700) {
    if (paidCritical) {
      shedBackground = true;
      criticalReasons.push(
        `Critical latency ${Math.round(pLat)}ms → shed background`
      );
    } else {
      criticalReasons.push(
        `Critical (public) latency ${Math.round(pLat)}ms → soft slow only`
      );
    }
    // Own-lane only: Critical latency must not raise scanner×.
    utilitySlowFactor = Math.max(utilitySlowFactor, 2);
  } else if (pLat != null && pLat >= 450) {
    if (paidCritical) {
      shedBackground = true;
      criticalReasons.push(
        `Critical latency ${Math.round(pLat)}ms → shed Favourites/utility`
      );
    } else {
      criticalReasons.push(
        `Critical (public) latency ${Math.round(pLat)}ms → soft slow only`
      );
    }
    if (!paidCritical) {
      utilitySlowFactor = Math.max(utilitySlowFactor, 1.75);
    }
  }

  // Queue backlog protects trade entry via Favourites/utility shed — not scanner×.
  if ((external?.primaryQueued ?? 0) > 0) {
    shedBackground = true;
    criticalReasons.push('Critical queue > 0 → shed Favourites/utility');
  }

  if (external?.primaryFailover) {
    if (paidCritical) {
      shedBackground = true;
      utilitySlowFactor = Math.max(utilitySlowFactor, 2);
      criticalReasons.push(
        'Critical emergency failover → shed Favourites/utility'
      );
    } else {
      utilitySlowFactor = Math.max(utilitySlowFactor, 1.75);
      criticalReasons.push('Critical public failover → soft slow only');
    }
  }

  const uLat = external?.utilityLatencyMs;
  let utilityShedHard = false;
  if (external?.utilityWeakPublic) {
    utilitySlowFactor = Math.max(utilitySlowFactor, 3.5);
    utilityReasons.push('Utility on weak public RPC → hard-shed Favourites/activity');
    utilityShedHard = true;
  }
  if (external?.utilityFailover) {
    utilitySlowFactor = Math.max(utilitySlowFactor, 2.5);
    utilityReasons.push('Utility failover → reduce utility workload');
  }
  if (uLat != null && uLat >= 800) {
    utilitySlowFactor = Math.max(utilitySlowFactor, 3);
    utilityReasons.push(`Utility latency ${Math.round(uLat)}ms → hard slow polls`);
    utilityShedHard = true;
  } else if (uLat != null && uLat >= 500) {
    utilitySlowFactor = Math.max(utilitySlowFactor, 2);
    utilityReasons.push(`Utility latency ${Math.round(uLat)}ms → soft slowdown`);
  }

  const sLat = external?.secondaryLatencyMs;
  if (sLat != null && sLat >= 600) {
    scannerSlowFactor = Math.max(scannerSlowFactor, 2);
    scannerReasons.push(`Scanners latency ${Math.round(sLat)}ms → slow scanners`);
  }

  if (utilitySlowFactor >= 3) utilityShedHard = true;

  const reasons = [
    ...criticalReasons,
    ...utilityReasons,
    ...scannerReasons,
  ];

  const shedProtectsPaidCritical = shedBackground && paidCritical;
  const throttledByOwnLaneOnly =
    scannerSlowFactor > 1 && scannerReasons.length > 0;

  let degradedBy: DegradedBy = 'none';
  if (shedBackground || (pLat != null && pLat >= 450 && paidCritical)) {
    degradedBy = 'critical';
  } else if (scannerSlowFactor >= 3) {
    degradedBy = 'scanners';
  } else if (utilityShedHard || utilitySlowFactor >= 2.5) {
    degradedBy = 'utility';
  }

  lastSnapshot = {
    scannerSlowFactor: Math.min(4, scannerSlowFactor),
    utilitySlowFactor: Math.min(4, utilitySlowFactor),
    shedBackground,
    shedProtectsPaidCritical,
    throttledByOwnLaneOnly,
    reasons,
    criticalReasons,
    utilityReasons,
    scannerReasons,
    degradedBy,
    utilityShedHard,
    secondarySkipsRecent: secSkip,
    updatedAt: now,
  };

  if (reasons.length && now - lastLogAt > 15_000) {
    lastLogAt = now;
    console.warn(
      `[background_rpc_throttled] scanner×${lastSnapshot.scannerSlowFactor} ` +
        `utility×${lastSnapshot.utilitySlowFactor}` +
        (shedBackground ? ' shedBackground=ON' : '') +
        (shedProtectsPaidCritical ? ' paidCritical' : '') +
        (throttledByOwnLaneOnly ? ' ownLaneOnly' : '') +
        (utilityShedHard ? ' utilityShedHard' : '') +
        ` degradedBy=${degradedBy}` +
        ` — ${reasons.join('; ')}`
    );
  }
  if (throttledByOwnLaneOnly && now - lastOwnLaneLogAt > 20_000) {
    lastOwnLaneLogAt = now;
    console.warn(
      `[scanner_throttled_own_lane_only] scanner×${lastSnapshot.scannerSlowFactor} ` +
        `— ${scannerReasons.join('; ')}`
    );
  }
  if (utilityShedHard && now - lastUtilityShedHardLogAt > 20_000) {
    lastUtilityShedHardLogAt = now;
    console.warn(
      `[utility_shed_hard] utility×${lastSnapshot.utilitySlowFactor} ` +
        `— ${utilityReasons.join('; ') || 'utility pressure'}`
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
  primaryFailover?: boolean;
  primaryQueued?: number;
  primaryWeakPublic?: boolean;
  secondarySkipped?: number;
  secondaryIdle?: boolean;
}): void {
  recompute(signals);
}

export function getRpcLoadControlSnapshot(): RpcLoadControlSnapshot {
  return {
    ...lastSnapshot,
    reasons: [...lastSnapshot.reasons],
    criticalReasons: [...lastSnapshot.criticalReasons],
    utilityReasons: [...lastSnapshot.utilityReasons],
    scannerReasons: [...lastSnapshot.scannerReasons],
  };
}

/**
 * Hard-stop Favourites when:
 * - paid Critical shed / Critical queue, OR
 * - utility-only hard shed (weak public / utility×≥3)
 */
export function shouldHardSkipFavouritesForShed(): boolean {
  const snap = getRpcLoadControlSnapshot();
  if (snap.utilityShedHard || snap.utilitySlowFactor >= 3) return true;
  if (!snap.shedBackground) return false;
  if (snap.shedProtectsPaidCritical) return true;
  return snap.criticalReasons.some((r) => /Critical queue > 0/i.test(r));
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
  // ×3+ means Secondary is already shedding — always skip the tick so we
  // do not keep acquiring (and re-noting skips) every 22s.
  if (snap.scannerSlowFactor >= 3) {
    return {
      skip: true,
      reason: snap.throttledByOwnLaneOnly
        ? `own-lane scanner×${snap.scannerSlowFactor} (${subsystem})`
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

/**
 * Under own-lane load, keep signal intake but drop nested Market side work
 * (Alpha / specialty / majors / watch ticks).
 */
export function shouldSkipScannerSideWork(): {
  skip: boolean;
  reason: string | null;
} {
  const snap = getRpcLoadControlSnapshot();
  if (snap.scannerSlowFactor >= 2) {
    return {
      skip: true,
      reason: `scanner×${snap.scannerSlowFactor} — keep signal intake`,
    };
  }
  try {
    const { getRpcGateSnapshot } =
      require('./rpcGate') as typeof import('./rpcGate');
    const g = getRpcGateSnapshot().lanes.secondary;
    if (g.inFlight >= Math.max(1, g.maxConcurrent - 1) || g.queued >= 2) {
      return {
        skip: true,
        reason: `Scanners saturated inFlight ${g.inFlight}/${g.maxConcurrent} q${g.queued}`,
      };
    }
  } catch {
    /* */
  }
  return { skip: false, reason: null };
}

export function utilityPollScale(): {
  cycleCapScale: number;
  gapScale: number;
  skipActivity: boolean;
} {
  const snap = getRpcLoadControlSnapshot();
  const f = snap.utilitySlowFactor;
  return {
    cycleCapScale: 1 / f,
    gapScale: f,
    skipActivity: f >= 2 || snap.utilityShedHard || snap.shedBackground,
  };
}
