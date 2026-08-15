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

export const CANONICAL_SCANNER_SOURCES = [
  'dexscreener',
  'gmgn',
  'jupiter',
  'alphascan',
  'onchain_helius',
  'graduating_feed',
  'pump_stream',
  'kolscan',
  'majors',
  'medium',
] as const;

export type CanonicalScannerSource = (typeof CANONICAL_SCANNER_SOURCES)[number];

export type SourceFunnelStatus = 'ok' | 'zero' | 'stale' | 'off';

export interface SourceFunnelRow {
  source: string;
  enabled: boolean;
  status: SourceFunnelStatus;
  candidates_in: number;
  deduped: number;
  passed_gatekeeper: number;
  watch_inserted: number;
  watch_inserted_by_profile: Record<string, number>;
  armed: number;
  opened: number;
  drop_reasons: Record<string, number>;
  last_nonzero_at: number | null;
  source_to_watch_rate: number;
  watch_to_arm_rate: number;
  arm_to_open_rate: number;
}

export interface ConversionRateRow {
  source_to_watch: number;
  watch_to_arm: number;
  arm_to_open: number;
  candidates_in?: number;
  watch_inserted?: number;
  armed?: number;
  opened?: number;
}

export interface McGapOrphanExample {
  mint: string;
  mc: number;
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
  orphan_examples: McGapOrphanExample[];
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
  candidates_by_source: Record<string, number>;
  candidates_by_category: Record<string, number>;
  merge_deduped_count: number;
  dropped_pre_gate_by_reason: Record<string, number>;
  exclusive_route_counts?: Record<string, number>;
  duplicate_token_across_steady_hwr?: number;
  hwr_watch_rejects_by_reason?: Record<string, number>;
  source_funnel: SourceFunnelRow[];
  conversion_by_source: Record<string, ConversionRateRow>;
  conversion_by_profile: Record<string, ConversionRateRow>;
}

const WINDOW_MS = 60_000;
const STALE_MS = 12 * 60_000;
const ORPHAN_EXAMPLE_CAP = 5;
const sessionStartedAt = Date.now();
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
const orphanExamples: McGapOrphanExample[] = [];
let rejectedByAllMcBands = 0;

interface SourceFunnelState {
  candidates_in: number;
  deduped: number;
  passed_gatekeeper: number;
  watch_inserted: number;
  watch_inserted_by_profile: Record<string, number>;
  armed: number;
  opened: number;
  drop_reasons: Record<string, number>;
  last_nonzero_at: number | null;
}

const sourceFunnel = new Map<string, SourceFunnelState>();
const profileConversion: Record<
  string,
  { watch: number; armed: number; opened: number }
> = {};

function emptySourceState(): SourceFunnelState {
  return {
    candidates_in: 0,
    deduped: 0,
    passed_gatekeeper: 0,
    watch_inserted: 0,
    watch_inserted_by_profile: {},
    armed: 0,
    opened: 0,
    drop_reasons: {},
    last_nonzero_at: null,
  };
}

function funnelState(source: string): SourceFunnelState {
  const key = String(source || '').trim() || 'unknown';
  let row = sourceFunnel.get(key);
  if (!row) {
    row = emptySourceState();
    sourceFunnel.set(key, row);
  }
  return row;
}

/** Unique source keys from a candidate / launch / watch stamp. */
export function listScannerSources(input?: {
  source?: string | null;
  scannerSources?: string[] | null;
  specialtyFeed?: string | null;
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw?: string | null) => {
    const k = String(raw || '').trim();
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(k);
  };
  for (const s of input?.scannerSources || []) add(s);
  add(input?.source);
  add(input?.specialtyFeed);
  return out.length > 0 ? out : ['unknown'];
}

function isSourceEnabled(source: string): boolean {
  try {
    const { config } = require('./config') as typeof import('./config');
    const ms = config.marketScanner || {};
    const scannerOn = ms.enabled !== false;
    switch (source) {
      case 'dexscreener':
      case 'gmgn':
        return scannerOn;
      case 'jupiter':
        return scannerOn && ms.jupiterTrendingEnabled !== false;
      case 'alphascan':
        return config.alphaScan?.enabled === true;
      case 'onchain_helius':
        return ms.heliusOnchainDiscoveryEnabled === true;
      case 'graduating_feed':
        return scannerOn && ms.graduatingFeedEnabled !== false;
      case 'pump_stream':
        return scannerOn && ms.pumpStreamEnabled !== false;
      case 'kolscan':
      case 'majors':
      case 'medium':
        return scannerOn;
      default:
        return scannerOn;
    }
  } catch {
    return false;
  }
}

function rate(num: number, den: number): number {
  if (!(den > 0)) return 0;
  return num / den;
}

export function noteSourceCandidatesIn(
  sources: string | string[] | null | undefined,
  n = 1
): void {
  const count = Math.max(1, Math.floor(n));
  const now = Date.now();
  for (const src of Array.isArray(sources) ? sources : [sources || 'unknown']) {
    const row = funnelState(src);
    row.candidates_in += count;
    row.last_nonzero_at = now;
  }
}

export function noteSourceDeduped(
  sources: string | string[] | null | undefined,
  n = 1
): void {
  const count = Math.max(1, Math.floor(n));
  for (const src of Array.isArray(sources) ? sources : [sources || 'unknown']) {
    funnelState(src).deduped += count;
  }
}

export function noteSourceDrop(
  sources: string | string[] | null | undefined,
  reason: string,
  n = 1
): void {
  const count = Math.max(1, Math.floor(n));
  const why = String(reason || 'unknown').slice(0, 80);
  for (const src of Array.isArray(sources) ? sources : [sources || 'unknown']) {
    const row = funnelState(src);
    row.drop_reasons[why] = (row.drop_reasons[why] || 0) + count;
  }
}

export function noteSourceGatekeeper(
  sources: string | string[] | null | undefined,
  passed: boolean,
  reason?: string
): void {
  for (const src of Array.isArray(sources) ? sources : [sources || 'unknown']) {
    const row = funnelState(src);
    if (passed) row.passed_gatekeeper += 1;
    else if (reason) {
      const why = String(reason).slice(0, 80);
      row.drop_reasons[why] = (row.drop_reasons[why] || 0) + 1;
    }
  }
}

export function noteSourceWatchInsert(
  sources: string | string[] | null | undefined,
  profileId?: string | null
): void {
  const pid = String(profileId || '').trim() || 'unknown';
  const conv = profileConversion[pid] || { watch: 0, armed: 0, opened: 0 };
  conv.watch += 1;
  profileConversion[pid] = conv;
  for (const src of Array.isArray(sources) ? sources : [sources || 'unknown']) {
    const row = funnelState(src);
    row.watch_inserted += 1;
    row.watch_inserted_by_profile[pid] =
      (row.watch_inserted_by_profile[pid] || 0) + 1;
  }
}

export function noteSourceArmed(
  sources: string | string[] | null | undefined,
  profileId?: string | null
): void {
  const pid = String(profileId || '').trim();
  if (pid) {
    const conv = profileConversion[pid] || { watch: 0, armed: 0, opened: 0 };
    conv.armed += 1;
    profileConversion[pid] = conv;
  }
  for (const src of Array.isArray(sources) ? sources : [sources || 'unknown']) {
    funnelState(src).armed += 1;
  }
}

export function noteSourceOpened(
  sources: string | string[] | null | undefined,
  profileId?: string | null
): void {
  const pid = String(profileId || '').trim();
  if (pid) {
    const conv = profileConversion[pid] || { watch: 0, armed: 0, opened: 0 };
    conv.opened += 1;
    profileConversion[pid] = conv;
  }
  for (const src of Array.isArray(sources) ? sources : [sources || 'unknown']) {
    funnelState(src).opened += 1;
  }
}

function buildSourceFunnelRows(): SourceFunnelRow[] {
  const now = Date.now();
  const keys = new Set<string>(CANONICAL_SCANNER_SOURCES);
  for (const k of sourceFunnel.keys()) keys.add(k);
  const rows: SourceFunnelRow[] = [];
  for (const source of keys) {
    const st = sourceFunnel.get(source) || emptySourceState();
    const enabled = isSourceEnabled(source);
    const lastAt = st.last_nonzero_at;
    const silentFor =
      lastAt != null ? now - lastAt : now - sessionStartedAt;
    let status: SourceFunnelStatus = 'ok';
    if (!enabled) status = 'off';
    else if (st.candidates_in <= 0 && silentFor >= STALE_MS) status = 'stale';
    else if (st.candidates_in <= 0) status = 'zero';
    rows.push({
      source,
      enabled,
      status,
      candidates_in: st.candidates_in,
      deduped: st.deduped,
      passed_gatekeeper: st.passed_gatekeeper,
      watch_inserted: st.watch_inserted,
      watch_inserted_by_profile: { ...st.watch_inserted_by_profile },
      armed: st.armed,
      opened: st.opened,
      drop_reasons: { ...st.drop_reasons },
      last_nonzero_at: lastAt,
      source_to_watch_rate: rate(st.watch_inserted, st.candidates_in),
      watch_to_arm_rate: rate(st.armed, st.watch_inserted),
      arm_to_open_rate: rate(st.opened, st.armed),
    });
  }
  const order = new Map(
    CANONICAL_SCANNER_SOURCES.map((s, i) => [s, i] as const)
  );
  rows.sort(
    (a, b) =>
      (order.get(a.source as CanonicalScannerSource) ?? 100) -
        (order.get(b.source as CanonicalScannerSource) ?? 100) ||
      a.source.localeCompare(b.source)
  );
  return rows;
}
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

let lastFanInBySource: Record<string, number> = {};
let lastFanInByCategory: Record<string, number> = {};
let lastMergeDeduped = 0;
const droppedPreGateByReason: Record<string, number> = {};

export function noteDroppedPreGate(reason: string, n = 1): void {
  const count = Math.max(1, Math.floor(n));
  droppedPreGateByReason[reason] =
    (droppedPreGateByReason[reason] || 0) + count;
}

export function noteScannerFanIn(input: {
  bySource?: Record<string, number>;
  byCategory?: Record<string, number>;
  mergeDeduped?: number;
}): void {
  lastFanInBySource = { ...(input.bySource || {}) };
  lastFanInByCategory = { ...(input.byCategory || {}) };
  lastMergeDeduped = Number(input.mergeDeduped) || 0;
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
export function noteMcGapOrphan(
  mcUsd?: number | null,
  mint?: string | null
): void {
  mcGapOrphanCount += 1;
  rejectedByAllMcBands += 1;
  const n = Number(mcUsd);
  if (Number.isFinite(n) && n > 0) {
    orphanExampleMc = n;
    const id = String(mint || '').trim();
    if (id) {
      orphanExamples.unshift({ mint: id.slice(0, 12), mc: n });
      if (orphanExamples.length > ORPHAN_EXAMPLE_CAP) {
        orphanExamples.length = ORPHAN_EXAMPLE_CAP;
      }
    }
  }
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
  const sourceRows = buildSourceFunnelRows();
  const conversion_by_source: Record<string, ConversionRateRow> = {};
  for (const row of sourceRows) {
    conversion_by_source[row.source] = {
      source_to_watch: row.source_to_watch_rate,
      watch_to_arm: row.watch_to_arm_rate,
      arm_to_open: row.arm_to_open_rate,
      candidates_in: row.candidates_in,
      watch_inserted: row.watch_inserted,
      armed: row.armed,
      opened: row.opened,
    };
  }
  const conversion_by_profile: Record<string, ConversionRateRow> = {};
  for (const [pid, row] of Object.entries(profileConversion)) {
    conversion_by_profile[pid] = {
      source_to_watch: rate(row.watch, 1),
      watch_to_arm: rate(row.armed, row.watch),
      arm_to_open: rate(row.opened, row.armed),
      watch_inserted: row.watch,
      armed: row.armed,
      opened: row.opened,
    };
  }
  try {
    const { getProfileWatchFunnels } =
      require('./profileWatchRegistry') as typeof import('./profileWatchRegistry');
    const funnels = getProfileWatchFunnels();
    for (const [pid, f] of Object.entries(funnels)) {
      const watch = Number(f.sent_to_watch) || 0;
      const armed = Number(f.armed) || 0;
      const opened = Number(f.opened) || 0;
      if (watch <= 0 && armed <= 0 && opened <= 0) continue;
      conversion_by_profile[pid] = {
        source_to_watch: rate(watch, 1),
        watch_to_arm: rate(armed, watch),
        arm_to_open: rate(opened, armed),
        watch_inserted: watch,
        armed,
        opened,
      };
    }
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
    armed_to_open_conversion: openedSum / Math.max(armedSum, 1),
    mc_gap_orphan_count: mcGapOrphanCount,
    orphan_example_mc: orphanExampleMc,
    orphan_examples: orphanExamples.slice(),
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
    candidates_by_source: { ...lastFanInBySource },
    candidates_by_category: { ...lastFanInByCategory },
    merge_deduped_count: lastMergeDeduped,
    dropped_pre_gate_by_reason: { ...droppedPreGateByReason },
    exclusive_route_counts: (() => {
      try {
        const { getExclusiveRouteCounts } =
          require('./qualityParkPlaybook') as typeof import('./qualityParkPlaybook');
        return getExclusiveRouteCounts();
      } catch {
        return {};
      }
    })(),
    hwr_watch_rejects_by_reason: (() => {
      try {
        const { getQualityParkDenyCounters } =
          require('./qualityParkPlaybook') as typeof import('./qualityParkPlaybook');
        return getQualityParkDenyCounters().high_win_rate as unknown as Record<
          string,
          number
        >;
      } catch {
        return {};
      }
    })(),
    duplicate_token_across_steady_hwr: (() => {
      const inv = opts?.activeByProfile || {};
      void inv;
      try {
        const { getProfileWatchInventory } =
          require('./profileWatchRegistry') as typeof import('./profileWatchRegistry');
        const inventory = getProfileWatchInventory();
        const steady = new Set(
          (inventory.steady_compounder?.entries || [])
            .filter(
              (e: { status?: string }) =>
                e.status === 'watching' || e.status === 'armed'
            )
            .map((e: { mint?: string }) => String(e.mint || ''))
        );
        let dup = 0;
        for (const e of inventory.high_win_rate?.entries || []) {
          if (e.status !== 'watching' && e.status !== 'armed') continue;
          if (steady.has(String(e.mint || ''))) dup += 1;
        }
        return dup;
      } catch {
        return 0;
      }
    })(),
    source_funnel: sourceRows,
    conversion_by_source,
    conversion_by_profile,
  };
}
