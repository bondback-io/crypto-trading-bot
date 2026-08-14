/**
 * Adaptive load control for Data + Background pressure.
 *
 * Signal intake (Market/Alpha/Zion scanners) is isolated from Trading shed:
 * Trading latency/queue may defer Favourites, but must not starve scanners.
 * When Data RPC looks healthy, never whole-tick-skip scanners (1.2.313 restore).
 */

import { getRpcGateSnapshot, type RpcGateRole } from './rpcGate';

/** Data-lane EWMA below this → treat scanners as healthy for intake protect. */
export const SIGNALS_RPC_HEALTHY_MS = 400;

export type RpcLoadControlSnapshot = {
  scannerSlowFactor: number;
  utilitySlowFactor: number;
  shedBackground: boolean;
  /** True when scanner× is driven only by Data-lane pressure (not Trading). */
  throttledByOwnLaneOnly: boolean;
  signalsRpcHealthy: boolean;
  reasons: string[];
  secondarySkipsRecent: number;
  backgroundSkipsRecent: number;
  updatedAt: number;
  level: 'ok' | 'busy' | 'shed';
  cause: string | null;
  scannerMultiplier: number;
  favouritesDeferred: boolean;
  dataPressure: boolean;
  backgroundPressure: boolean;
  bootSettling: boolean;
};

let lastSignals = {
  tradingLatencyMs: null as number | null,
  dataLatencyMs: null as number | null,
  backgroundLatencyMs: null as number | null,
  tradingOnEmergency: false,
  dataHealthy: true,
  /** True when Data Main is only in 429 cooldown (not hard-down). */
  dataRateLimited: false,
  backgroundHealthy: true,
  primaryQueued: 0,
  secondaryIdle: false,
};

let lastSnapshot: RpcLoadControlSnapshot = {
  scannerSlowFactor: 1,
  utilitySlowFactor: 1,
  shedBackground: false,
  throttledByOwnLaneOnly: false,
  signalsRpcHealthy: false,
  reasons: [],
  secondarySkipsRecent: 0,
  backgroundSkipsRecent: 0,
  updatedAt: Date.now(),
  level: 'ok',
  cause: null,
  scannerMultiplier: 1,
  favouritesDeferred: false,
  dataPressure: false,
  backgroundPressure: false,
  bootSettling: false,
};

let lastLogAt = 0;
let lastTickBypassLogAt = 0;

export function noteBackgroundRpcSkip(_role: RpcGateRole, _feature?: string): void {
  /* skips counted via gate snapshot */
}

/** True when Data/Scanners preferred looks fast enough to keep intake flowing. */
export function isSignalsRpcHealthy(
  secondaryLatencyMs: number | null = lastSignals.dataLatencyMs
): boolean {
  // CU/s cooldown wins over EWMA — do not keep hammering Alchemy during 429.
  if (lastSignals.dataRateLimited) return false;
  if (!lastSignals.dataHealthy) return false;
  if (secondaryLatencyMs == null || !Number.isFinite(secondaryLatencyMs)) {
    return true;
  }
  return secondaryLatencyMs < SIGNALS_RPC_HEALTHY_MS;
}

function recompute(): void {
  const gate = getRpcGateSnapshot();
  const dataQ = gate.lanes.secondary.queued;
  const dataSkips = gate.lanes.secondary.skipsPerMin;
  const bgQ = gate.lanes.background.queued;
  const bgSkips = gate.lanes.background.skipsPerMin;
  const dataLat = lastSignals.dataLatencyMs;
  const bgLat = lastSignals.backgroundLatencyMs;
  const tradeLat = lastSignals.tradingLatencyMs;
  const latSpike = dataLat != null && dataLat >= 2_500;
  const reasons: string[] = [];
  const scannerReasons: string[] = [];

  let scannerSlowFactor = 1;
  let utilitySlowFactor = 1;
  let shedBackground = false;
  let level: 'ok' | 'busy' | 'shed' = 'ok';
  let cause: string | null = null;

  let bootSettling = false;
  try {
    const { isBootSettling } =
      require('./bootPhase') as typeof import('./bootPhase');
    bootSettling = isBootSettling();
  } catch {
    /* */
  }

  // Trading pressure → Favourites/Background only (NOT scanner×).
  // 1.2.350: ignore Trading latency/queue during post-deploy settle (0–180s)
  // so a cold getSlot EWMA cannot pin shedBackground for 5–10 minutes.
  if (!bootSettling && !lastSignals.tradingOnEmergency) {
    if (tradeLat != null && tradeLat >= 700) {
      shedBackground = true;
      utilitySlowFactor = Math.max(utilitySlowFactor, 2);
      reasons.push(
        `Trading latency ${Math.round(tradeLat)}ms → shed Favourites (scanners free)`
      );
    } else if (tradeLat != null && tradeLat >= 450) {
      shedBackground = true;
      reasons.push(
        `Trading latency ${Math.round(tradeLat)}ms → defer Favourites (scanners free)`
      );
    }
  }
  if (!bootSettling && lastSignals.primaryQueued > 0) {
    shedBackground = true;
    reasons.push('Trading queue > 0 → shed Favourites (scanners free)');
  }
  if (bootSettling) {
    reasons.push('boot settling — Trading shed grace (migration deferred)');
  }

  // Scanner slowdown only from Data-lane pressure (own lane).
  // CU rate-limit → hard ×3 (pause scanners); hard-down / queue / latency same.
  const dataHardDown = !lastSignals.dataHealthy && !lastSignals.dataRateLimited;
  if (
    lastSignals.dataRateLimited ||
    dataHardDown ||
    dataSkips > 40 ||
    dataQ > 32 ||
    latSpike
  ) {
    level = 'shed';
    cause = lastSignals.dataRateLimited
      ? 'data lane rate-limited (CU cooldown)'
      : dataHardDown
        ? 'data lane unhealthy'
        : latSpike
          ? `data latency ${Math.round(dataLat!)}ms`
          : dataSkips > 40
            ? `data skips/min ${dataSkips}`
            : `data queue ${dataQ}`;
    scannerSlowFactor = Math.max(scannerSlowFactor, 3);
    scannerReasons.push(cause);
    reasons.push(cause);
  } else if (
    dataQ > 16 ||
    dataSkips > 20 ||
    (dataLat != null && dataLat >= 1_800)
  ) {
    level = 'busy';
    cause =
      dataQ > 16
        ? `data queue ${dataQ}`
        : dataSkips > 20
          ? `data skips/min ${dataSkips}`
          : `data latency ${Math.round(dataLat!)}ms`;
    scannerSlowFactor = Math.max(scannerSlowFactor, 2);
    scannerReasons.push(cause);
    reasons.push(cause);
  } else if (dataLat != null && dataLat >= 900) {
    scannerSlowFactor = Math.max(scannerSlowFactor, 1.5);
    scannerReasons.push(
      `Data latency ${Math.round(dataLat)}ms → soft slow scanners`
    );
    reasons.push(scannerReasons[scannerReasons.length - 1]!);
  }

  if (
    !lastSignals.backgroundHealthy ||
    bgSkips > 25 ||
    bgQ > 16 ||
    (bgLat != null && bgLat >= 2_500)
  ) {
    utilitySlowFactor = Math.max(utilitySlowFactor, 3);
    reasons.push(
      !lastSignals.backgroundHealthy
        ? 'background lane unhealthy'
        : bgSkips > 25
          ? `background skips/min ${bgSkips}`
          : bgQ > 16
            ? `background queue ${bgQ}`
            : `background latency ${Math.round(bgLat!)}ms`
    );
    if (level === 'ok') level = 'busy';
  } else if (bgQ > 6 || bgSkips > 10 || (bgLat != null && bgLat >= 1_200)) {
    utilitySlowFactor = Math.max(utilitySlowFactor, 2);
    reasons.push(
      bgQ > 6
        ? `background queue ${bgQ}`
        : bgSkips > 10
          ? `background skips/min ${bgSkips}`
          : `background latency ${Math.round(bgLat!)}ms`
    );
  }

  const scannersHealthy = isSignalsRpcHealthy(dataLat);
  // Healthy Data: never hard-lock scanner×3 — keep intake flowing.
  if (scannersHealthy && scannerSlowFactor >= 3) {
    scannerSlowFactor = 1.5;
    scannerReasons.push(
      `healed ×3→×1.5 — Data healthy (${Math.round(dataLat ?? 0)}ms)`
    );
  }

  const favouritesDeferred = utilitySlowFactor >= 2.5 || shedBackground;
  if (shedBackground && level === 'ok') level = 'busy';

  const throttledByOwnLaneOnly =
    scannerSlowFactor > 1 && scannerReasons.length > 0;

  lastSnapshot = {
    scannerSlowFactor: Math.min(4, scannerSlowFactor),
    utilitySlowFactor: Math.min(4, utilitySlowFactor),
    shedBackground,
    throttledByOwnLaneOnly,
    signalsRpcHealthy: scannersHealthy,
    reasons,
    secondarySkipsRecent: dataSkips,
    backgroundSkipsRecent: bgSkips,
    updatedAt: Date.now(),
    level,
    cause: cause || reasons[0] || null,
    scannerMultiplier: Math.min(4, scannerSlowFactor),
    favouritesDeferred,
    dataPressure: level !== 'ok',
    backgroundPressure: utilitySlowFactor >= 2,
    bootSettling,
  };

  if (reasons.length && Date.now() - lastLogAt > 20_000) {
    lastLogAt = Date.now();
    console.warn(
      `[rpc-load] adaptive backoff: scanner×${lastSnapshot.scannerSlowFactor} ` +
        `favourites×${lastSnapshot.utilitySlowFactor}` +
        (shedBackground ? ' shedFavourites=ON' : '') +
        (scannersHealthy ? ' signalsRpcHealthy' : '') +
        ` — ${reasons.join('; ')}`
    );
  }
}

export function updateRpcLoadSignals(s: {
  primaryLatencyMs?: number | null;
  secondaryLatencyMs?: number | null;
  utilityLatencyMs?: number | null;
  backgroundLatencyMs?: number | null;
  utilityWeakPublic?: boolean;
  utilityFailover?: boolean;
  tradingOnEmergency?: boolean;
  dataHealthy?: boolean;
  dataRateLimited?: boolean;
  backgroundHealthy?: boolean;
  primaryQueued?: number;
  secondarySkipped?: number;
  secondaryIdle?: boolean;
}): void {
  if (s.primaryLatencyMs !== undefined) {
    lastSignals.tradingLatencyMs = s.primaryLatencyMs;
  }
  if (s.secondaryLatencyMs !== undefined) {
    lastSignals.dataLatencyMs = s.secondaryLatencyMs;
  }
  if (s.backgroundLatencyMs !== undefined) {
    lastSignals.backgroundLatencyMs = s.backgroundLatencyMs;
  } else if (s.utilityLatencyMs !== undefined) {
    lastSignals.backgroundLatencyMs = s.utilityLatencyMs;
  }
  if (s.tradingOnEmergency !== undefined) {
    lastSignals.tradingOnEmergency = s.tradingOnEmergency;
  }
  if (s.dataHealthy !== undefined) {
    lastSignals.dataHealthy = s.dataHealthy;
  }
  if (s.dataRateLimited !== undefined) {
    lastSignals.dataRateLimited = s.dataRateLimited;
  }
  if (s.backgroundHealthy !== undefined) {
    lastSignals.backgroundHealthy = s.backgroundHealthy;
  }
  if (s.primaryQueued !== undefined) {
    lastSignals.primaryQueued = s.primaryQueued;
  }
  if (s.secondaryIdle !== undefined) {
    lastSignals.secondaryIdle = s.secondaryIdle;
  }
  recompute();
}

export function getRpcLoadControlSnapshot(): RpcLoadControlSnapshot {
  recompute();
  return { ...lastSnapshot, reasons: [...lastSnapshot.reasons] };
}

export function adaptiveScannerIntervalMs(baseMs: number): number {
  const f = getRpcLoadControlSnapshot().scannerSlowFactor;
  // Healthy Data: never stretch poll more than ×1.5.
  const capped = isSignalsRpcHealthy() ? Math.min(f, 1.5) : f;
  return Math.round(Math.max(baseMs, baseMs * capped));
}

export function shouldSkipScannerTick(subsystem: string): {
  skip: boolean;
  reason: string | null;
} {
  const snap = getRpcLoadControlSnapshot();
  // CU cooldown: always hard-skip — never bypass via stale healthy EWMA.
  if (lastSignals.dataRateLimited) {
    return {
      skip: true,
      reason: `data rate-limited (CU cooldown) (${subsystem})`,
    };
  }
  // Healthy Data RPC: never whole-tick skip — keep signal intake flowing.
  if (snap.signalsRpcHealthy || isSignalsRpcHealthy()) {
    if (snap.scannerSlowFactor >= 2) {
      const now = Date.now();
      if (now - lastTickBypassLogAt > 20_000) {
        lastTickBypassLogAt = now;
        console.warn(
          `[scanner_tick_skip_bypassed_healthy_rpc] ${subsystem} ` +
            `scanner×${snap.scannerSlowFactor} dataEwma=${lastSignals.dataLatencyMs ?? '—'}ms`
        );
      }
    }
    return { skip: false, reason: null };
  }
  if (snap.scannerSlowFactor >= 3) {
    return {
      skip: true,
      reason: snap.throttledByOwnLaneOnly
        ? `own-lane scanner×${snap.scannerSlowFactor} (${subsystem})`
        : `adaptive scanner×${snap.scannerSlowFactor} (${subsystem})`,
    };
  }
  if (snap.scannerSlowFactor >= 2) {
    const skipChance = Math.min(0.25, 1 - 1 / snap.scannerSlowFactor);
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
 * Under Data-lane load, keep core handoffs but drop nested side work.
 */
export function shouldSkipScannerSideWork(): {
  skip: boolean;
  reason: string | null;
} {
  const snap = getRpcLoadControlSnapshot();
  if (snap.signalsRpcHealthy || isSignalsRpcHealthy()) {
    return { skip: false, reason: null };
  }
  if (snap.scannerSlowFactor >= 2) {
    return {
      skip: true,
      reason: `scanner×${snap.scannerSlowFactor} — keep signal intake`,
    };
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

export function shouldDeferFavouritesWork(): boolean {
  return getRpcLoadControlSnapshot().favouritesDeferred;
}
