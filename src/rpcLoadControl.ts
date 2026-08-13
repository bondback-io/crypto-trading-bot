/**
 * Adaptive RPC load control — shed scanner/Favourites work when lanes stress,
 * without touching Trading trade-entry paths.
 *
 * Scanner slowdown is own-lane only (secondary skips / Data latency).
 * When Data RPC is healthy (~low EWMA), low-pri enrich skips must NOT
 * latch scanner×3 and starve Market/Alpha/Zion signal intake.
 * Trading stress still sheds Favourites first, never raises scanner×.
 * Favourites ride Data — shed-first under Data pressure (no utilityWeakPublic).
 */
import type { RpcGateRole } from './rpcGate';

export type DegradedBy = 'none' | 'trading' | 'data' | 'critical' | 'scanners';

export type RpcLoadControlSnapshot = {
  /** 1 = normal; higher = slower (e.g. 2 = half rate). */
  scannerSlowFactor: number;
  /** Favourites soft-watch slow factor (legacy name utilitySlowFactor). */
  utilitySlowFactor: number;
  /** Alias for Favourites shed factor. */
  favouritesSlowFactor: number;
  /** True when background work should yield for Trading. */
  shedBackground: boolean;
  /**
   * True when shedBackground is protecting a paid Trading lane.
   * False when Trading is itself weak public — Favourites must not hard-stop
   * from Trading shed alone (favourites hard-shed is separate).
   */
  shedProtectsPaidCritical: boolean;
  /**
   * True when scanner× > 1 and only secondary skips/latency drove it
   * (Trading stress did not raise scanner×).
   */
  throttledByOwnLaneOnly: boolean;
  /** Data preferred latency healthy enough to protect core signal intake. */
  signalsRpcHealthy: boolean;
  reasons: string[];
  criticalReasons: string[];
  utilityReasons: string[];
  scannerReasons: string[];
  degradedBy: DegradedBy;
  /** Favourites hard shed — legacy utilityShedHard alias. */
  utilityShedHard: boolean;
  favouritesShedHard: boolean;
  secondarySkipsRecent: number;
  updatedAt: number;
};

type SkipSample = {
  at: number;
  role: RpcGateRole;
  feature?: string;
  lowPri?: boolean;
};

const skipSamples: SkipSample[] = [];
const SKIP_WINDOW_MS = 60_000;
/** Cap how often skip samples can refresh the adaptive window (per role). */
const SKIP_NOTE_MIN_GAP_MS = 2_500;
/** Low-pri enrich samples while Scanners healthy — much sparser. */
const LOW_PRI_HEALTHY_GAP_MS = 10_000;
const lastSkipNoteAt: Partial<Record<RpcGateRole, number>> = {};
const lastLowPriSkipNoteAt: Partial<Record<RpcGateRole, number>> = {};

/** Scanners EWMA below this = protect core signal intake from enrich shed. */
export const SIGNALS_RPC_HEALTHY_MS = 280;

const LOW_PRI_FEATURES = new Set(['bonding_curve', 'token_metrics']);

function isLowPriFeature(feature?: string): boolean {
  if (!feature) return false;
  const f = feature.toLowerCase();
  if (LOW_PRI_FEATURES.has(f)) return true;
  if (f.includes('bonding_curve')) return true;
  if (f.includes('token_metrics') || f.includes('holder')) return true;
  return false;
}

/** Last known Scanners latency from health monitor (for skip sampling). */
let lastSecondaryLatencyMs: number | null = null;
let lastSecondaryIdle = false;
let lastSignalsIntakeProtectLogAt = 0;
let lastTickBypassLogAt = 0;

let lastSnapshot: RpcLoadControlSnapshot = {
  scannerSlowFactor: 1,
  utilitySlowFactor: 1,
  favouritesSlowFactor: 1,
  shedBackground: false,
  shedProtectsPaidCritical: false,
  throttledByOwnLaneOnly: false,
  signalsRpcHealthy: false,
  reasons: [],
  criticalReasons: [],
  utilityReasons: [],
  scannerReasons: [],
  degradedBy: 'none',
  utilityShedHard: false,
  favouritesShedHard: false,
  secondarySkipsRecent: 0,
  updatedAt: Date.now(),
};

let lastLogAt = 0;
let lastOwnLaneLogAt = 0;
let lastUtilityShedHardLogAt = 0;

function secondaryLaneNotSaturated(): boolean {
  try {
    const { getRpcGateSnapshot } =
      require('./rpcGate') as typeof import('./rpcGate');
    const g = getRpcGateSnapshot().lanes.secondary;
    return g.inFlight < Math.max(1, g.maxConcurrent) && g.queued < 2;
  } catch {
    return lastSecondaryIdle;
  }
}

/** True when Scanners preferred looks fast and not jammed. */
export function isSignalsRpcHealthy(
  secondaryLatencyMs: number | null = lastSecondaryLatencyMs
): boolean {
  if (secondaryLatencyMs == null || !Number.isFinite(secondaryLatencyMs)) {
    return false;
  }
  if (secondaryLatencyMs >= SIGNALS_RPC_HEALTHY_MS) {
    // #region agent log
    {
      const nowH = Date.now();
      if (!(globalThis as { __dbgSigHAt?: number }).__dbgSigHAt) {
        (globalThis as { __dbgSigHAt?: number }).__dbgSigHAt = 0;
      }
      if (
        nowH - ((globalThis as { __dbgSigHAt?: number }).__dbgSigHAt || 0) >
        8_000
      ) {
        (globalThis as { __dbgSigHAt?: number }).__dbgSigHAt = nowH;
        fetch(
          'http://127.0.0.1:7710/ingest/4a93e060-3c93-430c-865a-86d3cc897ce8',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Debug-Session-Id': '06c3b9',
            },
            body: JSON.stringify({
              sessionId: '06c3b9',
              runId: 'post-fix',
              hypothesisId: 'H3',
              location: 'rpcLoadControl.ts:isSignalsRpcHealthy',
              message: 'signals_rpc_unhealthy_latency',
              data: {
                secondaryLatencyMs,
                threshold: SIGNALS_RPC_HEALTHY_MS,
                laneOk: secondaryLaneNotSaturated(),
              },
              timestamp: nowH,
            }),
          }
        ).catch(() => {});
      }
    }
    // #endregion
    return false;
  }
  return secondaryLaneNotSaturated() || lastSecondaryIdle;
}

/** Record a non-critical skip so adaptive backoff can react. */
export function noteBackgroundRpcSkip(role: RpcGateRole, feature?: string): void {
  const now = Date.now();
  const lowPri = role === 'secondary' && isLowPriFeature(feature);
  const scannersHealthy = isSignalsRpcHealthy();

  // While Scanners RPC is healthy, ignore / sparsify low-pri enrich skips so
  // bonding_curve shed cannot latch scanner×3 and starve signal intake.
  if (lowPri && scannersHealthy) {
    const lastLp = lastLowPriSkipNoteAt[role] || 0;
    if (now - lastLp < LOW_PRI_HEALTHY_GAP_MS) {
      return;
    }
    lastLowPriSkipNoteAt[role] = now;
    if (now - lastSignalsIntakeProtectLogAt > 20_000) {
      lastSignalsIntakeProtectLogAt = now;
      console.warn(
        `[signals_intake_protected_scanners_healthy] ignored low-pri skip ` +
          `feature=${feature || 'ungated'} scannersEwma=${lastSecondaryLatencyMs ?? '—'}ms`
      );
    }
    // Do not push into adaptive window while healthy.
    return;
  }

  const last = lastSkipNoteAt[role] || 0;
  // bonding_curve / token_metrics can skip dozens of times in one enrich burst —
  // one sample per gap keeps adaptive from locking ×3 forever.
  if (now - last < SKIP_NOTE_MIN_GAP_MS) {
    return;
  }
  lastSkipNoteAt[role] = now;
  skipSamples.push({ at: now, role, feature, lowPri });
  while (skipSamples.length && now - skipSamples[0].at > SKIP_WINDOW_MS) {
    skipSamples.shift();
  }
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
  if (external?.secondaryLatencyMs !== undefined) {
    lastSecondaryLatencyMs = external.secondaryLatencyMs;
  }
  if (external?.secondaryIdle !== undefined) {
    lastSecondaryIdle = external.secondaryIdle === true;
  }

  const sLat = lastSecondaryLatencyMs;
  const scannersHealthy = isSignalsRpcHealthy(sLat);
  const laneIdle = lastSecondaryIdle === true;

  // Count only samples that should drive scanner× (exclude low-pri when healthy).
  const countable = skipSamples.filter((s) => {
    if (s.role !== 'secondary') return false;
    if (scannersHealthy && s.lowPri) return false;
    return true;
  });
  const secondarySkipsRecent = countable.filter(
    (s) => now - s.at <= SKIP_WINDOW_MS
  ).length;
  const secondarySkipsHot = countable.filter(
    (s) => now - s.at <= 15_000
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
  // Higher bars + idle/healthy heal: micro-skips must not pin scanners at ×3 while
  // Secondary is empty or Scanners RPC is already fast.
  if (scannersHealthy && (laneIdle || secondaryLaneNotSaturated())) {
    // Fast heal: at most soft ×1.5 from residual countable skips.
    if (secSkip >= 10 && !laneIdle) {
      scannerSlowFactor = Math.max(scannerSlowFactor, 1.5);
      scannerReasons.push(
        `Scanners healthy (${Math.round(sLat ?? 0)}ms) — soft ×1.5 only (${secSkip}/60s)`
      );
    }
  } else if (!laneIdle && secondarySkipsHot >= 6) {
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
  // Favourites ride Data — shed-first under Data pressure (no weak-public Utility lane).
  if (scannerSlowFactor >= 2 || (sLat != null && sLat >= 400)) {
    utilitySlowFactor = Math.max(utilitySlowFactor, scannerSlowFactor >= 3 ? 3 : 2);
    utilityReasons.push(
      `Data pressure (scanner×${scannerSlowFactor}` +
        (sLat != null ? ` ewma ${Math.round(sLat)}ms` : '') +
        ') → shed Favourites first'
    );
    if (scannerSlowFactor >= 3) utilityShedHard = true;
  }
  if (external?.utilityWeakPublic) {
    // Legacy signal ignored — Favourites no longer on public sticky.
  }
  if (uLat != null && uLat >= 800) {
    utilitySlowFactor = Math.max(utilitySlowFactor, 2);
    utilityReasons.push(`Favourites host latency ${Math.round(uLat)}ms → soft slow`);
  }

  if (sLat != null && sLat >= 600) {
    scannerSlowFactor = Math.max(scannerSlowFactor, 2);
    scannerReasons.push(`Data latency ${Math.round(sLat)}ms → slow scanners`);
  }

  // Absolute heal: healthy Data + not saturated → never hard ×3.
  if (scannersHealthy && scannerSlowFactor >= 3) {
    scannerSlowFactor = 1.5;
    scannerReasons.push(
      `healed ×3→×1.5 — Data healthy (${Math.round(sLat ?? 0)}ms)`
    );
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
    degradedBy = 'trading';
  } else if (scannerSlowFactor >= 3) {
    degradedBy = 'data';
  }
  // Never degradedBy=utility — public weakness alone must not paint STRESSED.

  lastSnapshot = {
    scannerSlowFactor: Math.min(4, scannerSlowFactor),
    utilitySlowFactor: Math.min(4, utilitySlowFactor),
    favouritesSlowFactor: Math.min(4, utilitySlowFactor),
    shedBackground,
    shedProtectsPaidCritical,
    throttledByOwnLaneOnly,
    signalsRpcHealthy: scannersHealthy,
    reasons,
    criticalReasons,
    utilityReasons,
    scannerReasons,
    degradedBy,
    utilityShedHard,
    favouritesShedHard: utilityShedHard,
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
        (scannersHealthy ? ' signalsRpcHealthy' : '') +
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
      `[favourites_shed_hard] fav×${lastSnapshot.utilitySlowFactor} ` +
        `— ${utilityReasons.join('; ') || 'Data/Favourites pressure'}`
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

export function getLastSecondaryLatencyMs(): number | null {
  return lastSecondaryLatencyMs;
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
  // Healthy Scanners: never stretch poll more than ×1.5.
  const capped = isSignalsRpcHealthy() ? Math.min(f, 1.5) : f;
  return Math.round(Math.max(baseMs, baseMs * capped));
}

/** True if this scanner tick should skip under adaptive load. */
export function shouldSkipScannerTick(subsystem: string): {
  skip: boolean;
  reason: string | null;
} {
  const snap = getRpcLoadControlSnapshot();
  // Healthy Scanners RPC: never whole-tick skip — keep signal intake flowing.
  if (snap.signalsRpcHealthy || isSignalsRpcHealthy()) {
    if (snap.scannerSlowFactor >= 2) {
      const now = Date.now();
      if (now - lastTickBypassLogAt > 20_000) {
        lastTickBypassLogAt = now;
        console.warn(
          `[scanner_tick_skip_bypassed_healthy_rpc] ${subsystem} ` +
            `scanner×${snap.scannerSlowFactor} scannersEwma=${lastSecondaryLatencyMs ?? '—'}ms`
        );
      }
    }
    return { skip: false, reason: null };
  }
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
 * Trips earlier when Scanners EWMA is elevated (~200ms+) or Critical budget tight.
 */
export function shouldSkipScannerSideWork(): {
  skip: boolean;
  reason: string | null;
} {
  const snap = getRpcLoadControlSnapshot();
  if (snap.scannerSlowFactor >= 1.5) {
    return {
      skip: true,
      reason: `scanner×${snap.scannerSlowFactor} — keep signal intake`,
    };
  }
  if (
    lastSecondaryLatencyMs != null &&
    lastSecondaryLatencyMs >= 200
  ) {
    return {
      skip: true,
      reason: `Scanners EWMA ${Math.round(lastSecondaryLatencyMs)}ms — drop side work`,
    };
  }
  try {
    const { getRpcGateSnapshot, isCriticalLaneBudgetTight } =
      require('./rpcGate') as typeof import('./rpcGate');
    const g = getRpcGateSnapshot().lanes.secondary;
    if (g.inFlight >= Math.max(1, g.maxConcurrent - 1) || g.queued >= 2) {
      return {
        skip: true,
        reason: `Scanners saturated inFlight ${g.inFlight}/${g.maxConcurrent} q${g.queued}`,
      };
    }
    if (isCriticalLaneBudgetTight()) {
      return {
        skip: true,
        reason: 'Critical budget tight — drop scanner side work',
      };
    }
  } catch {
    /* */
  }
  return { skip: false, reason: null };
}

/** True when Scanners look congested — cut enrich fanout at the source. */
export function scannersUnderPressure(): boolean {
  if (!isSignalsRpcHealthy()) return true;
  if (lastSecondaryLatencyMs != null && lastSecondaryLatencyMs >= 200) {
    return true;
  }
  const snap = getRpcLoadControlSnapshot();
  return snap.scannerSlowFactor >= 1.5;
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
