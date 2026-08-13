/**
 * Adaptive load control for Data-lane pressure (scanners / Favourites shed).
 * Never marks global STRESSED from public emergency alone.
 * Snapshot fields keep classic names for monitor/dashboard compatibility.
 */

import { getRpcGateSnapshot, type RpcGateRole } from './rpcGate';

export type RpcLoadControlSnapshot = {
  /** 1 = normal; higher = slower scanners. */
  scannerSlowFactor: number;
  /** Favourites/activity slowdown (maps from Data pressure). */
  utilitySlowFactor: number;
  /** True when background should yield for Trading. */
  shedBackground: boolean;
  reasons: string[];
  secondarySkipsRecent: number;
  updatedAt: number;
  /** Simple-model aliases */
  level: 'ok' | 'busy' | 'shed';
  cause: string | null;
  scannerMultiplier: number;
  favouritesDeferred: boolean;
  dataPressure: boolean;
};

let lastSignals = {
  tradingLatencyMs: null as number | null,
  dataLatencyMs: null as number | null,
  tradingOnEmergency: false,
  dataHealthy: true,
  primaryQueued: 0,
};

let lastSnapshot: RpcLoadControlSnapshot = {
  scannerSlowFactor: 1,
  utilitySlowFactor: 1,
  shedBackground: false,
  reasons: [],
  secondarySkipsRecent: 0,
  updatedAt: Date.now(),
  level: 'ok',
  cause: null,
  scannerMultiplier: 1,
  favouritesDeferred: false,
  dataPressure: false,
};

let lastLogAt = 0;

export function noteBackgroundRpcSkip(_role: RpcGateRole, _feature?: string): void {
  /* skips are counted live via getRpcGateSnapshot */
}

function recompute(): void {
  const gate = getRpcGateSnapshot();
  const dataQ = gate.lanes.secondary.queued;
  const dataSkips = gate.lanes.secondary.skipsPerMin;
  const dataLat = lastSignals.dataLatencyMs;
  const tradeLat = lastSignals.tradingLatencyMs;
  const latSpike = dataLat != null && dataLat >= 2_500;
  const reasons: string[] = [];

  let scannerSlowFactor = 1;
  let utilitySlowFactor = 1;
  let shedBackground = false;
  let level: 'ok' | 'busy' | 'shed' = 'ok';
  let cause: string | null = null;

  // Trading pressure → shed background (not emergency-alone).
  if (!lastSignals.tradingOnEmergency) {
    if (tradeLat != null && tradeLat >= 700) {
      shedBackground = true;
      scannerSlowFactor = Math.max(scannerSlowFactor, 3);
      utilitySlowFactor = Math.max(utilitySlowFactor, 2);
      reasons.push(`Trading latency ${Math.round(tradeLat)}ms → shed background`);
    } else if (tradeLat != null && tradeLat >= 450) {
      shedBackground = true;
      scannerSlowFactor = Math.max(scannerSlowFactor, 2);
      reasons.push(`Trading latency ${Math.round(tradeLat)}ms → reduce scanners`);
    }
  }
  if (lastSignals.primaryQueued > 0) {
    shedBackground = true;
    scannerSlowFactor = Math.max(scannerSlowFactor, 2);
    reasons.push('Trading queue > 0 → shed scanners/Favourites');
  }

  if (!lastSignals.dataHealthy || dataSkips > 30 || dataQ > 24 || latSpike) {
    level = 'shed';
    cause = !lastSignals.dataHealthy
      ? 'data lane unhealthy'
      : latSpike
        ? `data latency ${Math.round(dataLat!)}ms`
        : dataSkips > 30
          ? `data skips/min ${dataSkips}`
          : `data queue ${dataQ}`;
    scannerSlowFactor = Math.max(scannerSlowFactor, 4);
    utilitySlowFactor = Math.max(utilitySlowFactor, 3);
    reasons.push(cause);
  } else if (
    dataQ > 8 ||
    dataSkips > 10 ||
    (dataLat != null && dataLat >= 1_200)
  ) {
    level = 'busy';
    cause =
      dataQ > 8
        ? `data queue ${dataQ}`
        : dataSkips > 10
          ? `data skips/min ${dataSkips}`
          : `data latency ${Math.round(dataLat!)}ms`;
    scannerSlowFactor = Math.max(scannerSlowFactor, 2);
    utilitySlowFactor = Math.max(utilitySlowFactor, 2);
    reasons.push(cause);
  }

  if (dataLat != null && dataLat >= 600) {
    scannerSlowFactor = Math.max(scannerSlowFactor, 2);
    reasons.push(`Data latency ${Math.round(dataLat)}ms → slow scanners`);
  }

  const favouritesDeferred = utilitySlowFactor >= 2.5 || level === 'shed';
  if (shedBackground && level === 'ok') level = 'busy';
  if (shedBackground && scannerSlowFactor >= 3) level = 'shed';

  lastSnapshot = {
    scannerSlowFactor: Math.min(4, scannerSlowFactor),
    utilitySlowFactor: Math.min(4, utilitySlowFactor),
    shedBackground,
    reasons,
    secondarySkipsRecent: dataSkips,
    updatedAt: Date.now(),
    level,
    cause: cause || reasons[0] || null,
    scannerMultiplier: Math.min(4, scannerSlowFactor),
    favouritesDeferred,
    dataPressure: level !== 'ok',
  };

  if (reasons.length && Date.now() - lastLogAt > 20_000) {
    lastLogAt = Date.now();
    console.warn(
      `[rpc-load] adaptive backoff: scanner×${lastSnapshot.scannerSlowFactor} ` +
        `favourites×${lastSnapshot.utilitySlowFactor}` +
        (shedBackground ? ' shedBackground=ON' : '') +
        ` — ${reasons.join('; ')}`
    );
  }
}

export function updateRpcLoadSignals(s: {
  primaryLatencyMs?: number | null;
  secondaryLatencyMs?: number | null;
  utilityLatencyMs?: number | null;
  utilityWeakPublic?: boolean;
  utilityFailover?: boolean;
  tradingOnEmergency?: boolean;
  dataHealthy?: boolean;
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
  if (s.tradingOnEmergency !== undefined) {
    lastSignals.tradingOnEmergency = s.tradingOnEmergency;
  }
  if (s.dataHealthy !== undefined) {
    lastSignals.dataHealthy = s.dataHealthy;
  }
  if (s.primaryQueued !== undefined) {
    lastSignals.primaryQueued = s.primaryQueued;
  }
  // utilityWeakPublic / utilityFailover intentionally ignored — emergency
  // alone must not drive global stress.
  recompute();
}

export function getRpcLoadControlSnapshot(): RpcLoadControlSnapshot {
  recompute();
  return { ...lastSnapshot, reasons: [...lastSnapshot.reasons] };
}

export function adaptiveScannerIntervalMs(baseMs: number): number {
  const f = getRpcLoadControlSnapshot().scannerSlowFactor;
  return Math.round(Math.max(baseMs, baseMs * f));
}

export function shouldSkipScannerTick(subsystem: string): {
  skip: boolean;
  reason: string | null;
} {
  const snap = getRpcLoadControlSnapshot();
  if (snap.scannerSlowFactor >= 3) {
    return {
      skip: true,
      reason: snap.shedBackground
        ? `adaptive shed for Trading (${snap.reasons[0] || 'load'})`
        : `adaptive scanner×${snap.scannerSlowFactor} (${subsystem})`,
    };
  }
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
  return {
    cycleCapScale: 1 / f,
    gapScale: f,
    skipActivity: f >= 2.5,
  };
}

export function shouldDeferFavouritesWork(): boolean {
  return getRpcLoadControlSnapshot().favouritesDeferred;
}
