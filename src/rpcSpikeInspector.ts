/**
 * RPC spike telemetry / containment — classic no-op stubs.
 * No watchers gate role; containment and shed helpers always off.
 */

import type { RpcGateRole } from './rpcGate';

export type RpcSpikeLane = RpcGateRole;
export type RpcCallOutcome = 'success' | 'timeout' | '429' | 'other';
export type RpcSpikeClass =
  | 'provider_slowness'
  | 'app_queueing'
  | 'retry_amplification'
  | 'burst_fanout'
  | 'post_boot'
  | 'unknown';

export type RpcSpikeMethodStat = {
  method: string;
  count: number;
  avgMs: number;
};

export type RpcSpikeRecord = {
  id: string;
  lane: RpcSpikeLane;
  provider: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  peakP95: number;
  peakInFlight: number;
  topMethods: RpcSpikeMethodStat[];
  errorCounts: { timeout: number; rateLimited: number; other: number };
  class: RpcSpikeClass;
  containmentActions: string[];
  recoveredAt: number | null;
};

export type RpcLaneTelemetry = {
  lane: RpcSpikeLane;
  p50: number | null;
  p95: number | null;
  inFlight: number;
  timeoutCount: number;
  rateLimitedCount: number;
  samples: number;
  status: 'ok' | 'spike' | 'recovering';
  provider: string;
};

function emptyLane(lane: RpcSpikeLane): RpcLaneTelemetry {
  return {
    lane,
    p50: null,
    p95: null,
    inFlight: 0,
    timeoutCount: 0,
    rateLimitedCount: 0,
    samples: 0,
    status: 'ok',
    provider: '',
  };
}

export function isRpcContainmentEnabled(): boolean {
  return false;
}

export function safeProviderLabel(raw: string): string {
  return String(raw || '').slice(0, 64);
}

export function runWithSpikeCallContext<T>(
  _ctx: { method?: string; lane?: string },
  fn: () => T
): T {
  return fn();
}

export function currentSpikeCallContext(): {
  method: string | null;
  lane: string | null;
} {
  return { method: null, lane: null };
}

export function classifyRpcOutcome(opts: {
  ok: boolean;
  status?: number | null;
  error?: unknown;
}): RpcCallOutcome {
  const status = Number(opts.status);
  if (status === 429) return '429';
  const msg =
    opts.error instanceof Error ? opts.error.message : String(opts.error || '');
  if (/timeout|aborted|abort|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(msg)) {
    return 'timeout';
  }
  if (/429|rate.?limit/i.test(msg)) return '429';
  if (opts.ok) return 'success';
  return 'other';
}

export function noteRpcCall(_opts: {
  lane?: RpcSpikeLane | string;
  method?: string;
  totalMs?: number;
  networkMs?: number;
  queueWaitMs?: number;
  inFlight?: number;
  outcome?: RpcCallOutcome;
  provider?: string;
}): void {
  /* noop */
}

export function isLaneSpiking(_lane: RpcSpikeLane | string): boolean {
  void _lane;
  return false;
}

export function isLaneRecovering(_lane: RpcSpikeLane | string): boolean {
  void _lane;
  return false;
}

export function shouldSoftPauseNewEntries(): boolean {
  return false;
}

export function shouldShedPrimaryMonitoring(): boolean {
  return false;
}

export function shouldShedSecondaryTxEnrich(): boolean {
  return false;
}

export function getLastRpcSpikeRecoverReason(): string | null {
  return null;
}

export function withRpcAttemptCap(
  _critical: boolean,
  defaultMax: number,
  _opts?: { exitSend?: boolean; monitor?: boolean }
): number {
  void _critical;
  void _opts;
  return defaultMax;
}

export function laneTelemetry(lane: RpcSpikeLane): RpcLaneTelemetry {
  return emptyLane(lane);
}

export function getSpikeInspectorSnapshot(): {
  containmentEnabled: boolean;
  trading: RpcLaneTelemetry;
  watchers: RpcLaneTelemetry;
  scanners: RpcLaneTelemetry;
  utility: RpcLaneTelemetry;
  spikes: RpcSpikeRecord[];
  openSpikes: RpcSpikeRecord[];
  entryPauseActive: boolean;
  entry_pause_auto_cleared: number;
  lastRecoverReason: string | null;
  exit_lane_guard_trips: number;
} {
  return {
    containmentEnabled: false,
    trading: emptyLane('primary'),
    // UI still expects a watchers chip; classic maps that work to secondary.
    watchers: emptyLane('secondary'),
    scanners: emptyLane('secondary'),
    utility: emptyLane('utility'),
    spikes: [],
    openSpikes: [],
    entryPauseActive: false,
    entry_pause_auto_cleared: 0,
    lastRecoverReason: null,
    exit_lane_guard_trips: 0,
  };
}

export function buildRpcSpikeDiagnosis(): {
  generatedAt: string;
  cursorPackage: string;
  reportText: string;
} {
  const generatedAt = new Date().toISOString();
  return {
    generatedAt,
    cursorPackage: '',
    reportText: `# RPC Spike Diagnosis\n\n- time: ${generatedAt}\n- containment: OFF (classic stubs)\n- no spike samples\n`,
  };
}

export function __resetRpcSpikeInspectorForTests(): void {
  /* noop */
}

export function __setSpikeInspectorUptimeForTests(_ms: number): void {
  void _ms;
}

export function __forceSpikeRecoveringElapsedForTests(
  _lane: RpcSpikeLane,
  _ms: number
): void {
  void _lane;
  void _ms;
}

export function __ageLaneSamplesForTests(
  _lane: RpcSpikeLane,
  _ageMs: number
): void {
  void _lane;
  void _ageMs;
}

export function __ageOpenSpikeStartedAtForTests(
  _lane: RpcSpikeLane,
  _ageMs: number
): void {
  void _lane;
  void _ageMs;
}

export function __endOpenSpikeForTests(_lane: RpcSpikeLane): void {
  void _lane;
}

export function __clearHardCallCooldownForTests(_lane: RpcSpikeLane): void {
  void _lane;
}

export function __clearEntryPauseCooldownForTests(): void {
  /* noop */
}
