/**
 * Scanner → watch insert diagnostics (Phase 0).
 * In-memory session counters — never block the feed.
 */

export interface WatchPipelineThrottleState {
  slowFactor: number;
  crudeOnly: boolean;
  queueYield: boolean;
  criticalDefer: boolean;
}

export interface WatchPipelineSnapshot {
  scanner_candidates_per_min: number;
  watch_insert_attempts: number;
  watch_insert_rejected_by_reason: Record<string, number>;
  watch_active_count_by_profile: Record<string, number>;
  arm_count_by_profile: Record<string, number>;
  trigger_ready_count: number;
  trigger_to_open_blocked_by_reason: Record<string, number>;
  scanner_throttle_state: WatchPipelineThrottleState;
  watcher_lane_latency: number | string | null;
}

const WINDOW_MS = 60_000;
const candidateAt: number[] = [];
let insertAttempts = 0;
const rejectedByReason: Record<string, number> = {};
const triggerOpenBlocked: Record<string, number> = {};
let triggerReadyCount = 0;
const throttle: WatchPipelineThrottleState = {
  slowFactor: 1,
  crudeOnly: false,
  queueYield: false,
  criticalDefer: false,
};
let watcherLaneLatency: number | string | null = '—';

function bump(map: Record<string, number>, reason: string): void {
  const key = String(reason || 'unknown').slice(0, 80);
  map[key] = (map[key] || 0) + 1;
}

export function noteScannerCandidate(n = 1): void {
  const now = Date.now();
  const count = Math.max(1, Math.floor(n));
  for (let i = 0; i < count; i++) candidateAt.push(now);
  while (candidateAt.length && now - candidateAt[0] > WINDOW_MS) {
    candidateAt.shift();
  }
}

export function noteWatchInsertAttempt(n = 1): void {
  insertAttempts += Math.max(1, Math.floor(n));
}

export function noteWatchInsertReject(reason: string, n = 1): void {
  bump(rejectedByReason, reason);
  void n;
}

export function noteTriggerReady(n = 1): void {
  triggerReadyCount += Math.max(1, Math.floor(n));
}

export function noteTriggerOpenBlocked(reason: string): void {
  bump(triggerOpenBlocked, reason);
}

export function noteScannerThrottle(partial: Partial<WatchPipelineThrottleState>): void {
  Object.assign(throttle, partial);
}

export function setWatcherLaneLatency(ms: number | string | null): void {
  watcherLaneLatency = ms;
}

export function getWatchPipelineSnapshot(opts?: {
  activeByProfile?: Record<string, number>;
  armedByProfile?: Record<string, number>;
}): WatchPipelineSnapshot {
  const now = Date.now();
  while (candidateAt.length && now - candidateAt[0] > WINDOW_MS) {
    candidateAt.shift();
  }
  try {
    const { getRpcLoadControlSnapshot } =
      require('./rpcLoadControl') as typeof import('./rpcLoadControl');
    const snap = getRpcLoadControlSnapshot();
    throttle.slowFactor = Number(snap.scannerSlowFactor) || throttle.slowFactor;
    throttle.crudeOnly = (Number(snap.scannerSlowFactor) || 0) >= 3;
  } catch {
    /* optional */
  }
  return {
    scanner_candidates_per_min: candidateAt.length,
    watch_insert_attempts: insertAttempts,
    watch_insert_rejected_by_reason: { ...rejectedByReason },
    watch_active_count_by_profile: { ...(opts?.activeByProfile || {}) },
    arm_count_by_profile: { ...(opts?.armedByProfile || {}) },
    trigger_ready_count: triggerReadyCount,
    trigger_to_open_blocked_by_reason: { ...triggerOpenBlocked },
    scanner_throttle_state: { ...throttle },
    watcher_lane_latency: watcherLaneLatency,
  };
}
