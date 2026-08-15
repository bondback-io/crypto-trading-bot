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
  /** opened / max(armed, 1) from per-profile funnels */
  armed_to_open_conversion: number;
  mc_gap_orphan_count: number;
  orphan_example_mc: number | null;
  rejected_by_all_mc_bands: number;
  avg_watch_score_by_profile: Record<string, number>;
  armed_from_top_quartile_rate: number;
  skipped_low_score_count: number;
  expired_stagnant_count: number;
  decay_events_count: number;
  demoted_from_armed_count: number;
  expired_from_volume_collapse_count: number;
  saved_from_decay_by_volume_expansion_count: number;
  avg_time_to_decay_by_profile: Record<string, number>;
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
let mcGapOrphanCount = 0;
let orphanExampleMc: number | null = null;
let rejectedByAllMcBands = 0;
const scoreSumByProfile: Record<string, { sum: number; n: number }> = {};
let armedTopQuartileHits = 0;
let armedTopQuartileN = 0;
let skippedLowScoreCount = 0;
let expiredStagnantCount = 0;
let decayEventsCount = 0;
let demotedFromArmedCount = 0;
let expiredFromVolumeCollapseCount = 0;
let savedFromDecayByVolumeExpansionCount = 0;
const decayTimeByProfile: Record<string, { sum: number; n: number }> = {};

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

/** ≥3 lanes failed only on MC band and nobody passed. */
export function noteMcGapOrphan(mcUsd?: number | null): void {
  mcGapOrphanCount += 1;
  rejectedByAllMcBands += 1;
  const n = Number(mcUsd);
  if (Number.isFinite(n) && n > 0) orphanExampleMc = n;
}

export function noteWatchScoreDiagnostics(input: {
  profileId?: string | null;
  score?: number;
  improved?: boolean;
  volumeState?: string;
  decayed?: boolean;
  savedByVolume?: boolean;
}): void {
  const pid = String(input.profileId || '').trim() || 'unknown';
  const score = Number(input.score);
  if (Number.isFinite(score)) {
    const row = scoreSumByProfile[pid] || { sum: 0, n: 0 };
    row.sum += score;
    row.n += 1;
    scoreSumByProfile[pid] = row;
  }
  if (input.decayed) decayEventsCount += 1;
  if (input.savedByVolume) savedFromDecayByVolumeExpansionCount += 1;
}

export function noteArmedFromTopQuartile(hit: boolean): void {
  armedTopQuartileN += 1;
  if (hit) armedTopQuartileHits += 1;
}

export function noteSkippedLowScore(): void {
  skippedLowScoreCount += 1;
}

export function noteStagnantExpired(kind: 'stagnant' | 'volume' = 'stagnant'): void {
  expiredStagnantCount += 1;
  if (kind === 'volume') expiredFromVolumeCollapseCount += 1;
}

export function noteDemotedFromArmed(): void {
  demotedFromArmedCount += 1;
}

export function noteTimeToDecay(profileId: string, ms: number): void {
  const pid = String(profileId || 'unknown');
  const row = decayTimeByProfile[pid] || { sum: 0, n: 0 };
  row.sum += Math.max(0, ms);
  row.n += 1;
  decayTimeByProfile[pid] = row;
}

export function getWatchPipelineSnapshot(opts?: {
  activeByProfile?: Record<string, number>;
  armedByProfile?: Record<string, number>;
  funnels?: Record<string, { armed?: number; opened?: number }>;
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
  let armedSum = 0;
  let openedSum = 0;
  for (const row of Object.values(opts?.funnels || {})) {
    armedSum += Number(row?.armed) || 0;
    openedSum += Number(row?.opened) || 0;
  }
  const avgScore: Record<string, number> = {};
  for (const [pid, row] of Object.entries(scoreSumByProfile)) {
    avgScore[pid] = row.n > 0 ? Math.round((row.sum / row.n) * 10) / 10 : 0;
  }
  const avgDecay: Record<string, number> = {};
  for (const [pid, row] of Object.entries(decayTimeByProfile)) {
    avgDecay[pid] = row.n > 0 ? Math.round(row.sum / row.n) : 0;
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
    armed_to_open_conversion: openedSum / Math.max(armedSum, 1),
    mc_gap_orphan_count: mcGapOrphanCount,
    orphan_example_mc: orphanExampleMc,
    rejected_by_all_mc_bands: rejectedByAllMcBands,
    avg_watch_score_by_profile: avgScore,
    armed_from_top_quartile_rate:
      armedTopQuartileN > 0 ? armedTopQuartileHits / armedTopQuartileN : 0,
    skipped_low_score_count: skippedLowScoreCount,
    expired_stagnant_count: expiredStagnantCount,
    decay_events_count: decayEventsCount,
    demoted_from_armed_count: demotedFromArmedCount,
    expired_from_volume_collapse_count: expiredFromVolumeCollapseCount,
    saved_from_decay_by_volume_expansion_count:
      savedFromDecayByVolumeExpansionCount,
    avg_time_to_decay_by_profile: avgDecay,
  };
}
