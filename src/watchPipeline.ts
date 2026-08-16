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

export type SourceFunnelStatus = 'ok' | 'zero' | 'stale' | 'off' | 'derived';

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

export interface McOrphanFightExample {
  mint: string;
  mc: number;
  classifier?: string | null;
  rejects: Array<{ profileId: string; reason: string }>;
}

export interface ConversionDiagExample {
  mint: string;
  reason: string;
}

export interface ConversionDiagnosticsSnapshot {
  mc_gap_orphan_count: number;
  none_mc_gap_count: number;
  none_mc_gap_examples: McOrphanFightExample[];
  mc_orphan_examples: McOrphanFightExample[];
  migration_tagged_but_not_setup_count: number;
  migration_tagged_examples: ConversionDiagExample[];
  source_counts: Record<string, number>;
  source_funnel: SourceFunnelRow[];
  dip_win_then_pattern_fail_count: number;
  dip_pattern_fail_on_armed_reclaim: number;
  steady_block_reasons: Record<string, number>;
  hwr_block_reasons: Record<string, number>;
  resolved_min_holders: Record<string, number>;
  fake_holder_velocity_max_15m: number;
  effective_mc_bands: {
    dip_buyer: {
      min: number;
      max: number;
      source: string;
      minSource: string;
      maxSource: string;
    };
    scalper: {
      min: number;
      max: number;
      source: string;
      minSource: string;
      maxSource: string;
    };
  };
  scalper_watch: number;
  scalper_arm: number;
  scalper_trigger: number;
  scalper_open: number;
  dip_park: number;
  dip_waiting_arm: number;
  dip_arm: number;
  dip_open: number;
  watchers_isolate: boolean;
  trading_entry_pause: boolean;
  arm_timeout_total: number;
  open_fail_total: number;
  hybrid_fast_arm_opens: number;
  flow_fast_arm_opens: number;
  selective_arm_opens: number;
}

export interface WatchPipelineSnapshot {
  scanner_candidates_per_min: number;
  watch_insert_attempts: number;
  watch_insert_ok: number;
  watch_insert_ok_last_15m: number;
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
  none_mc_gap_count: number;
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
  conversion_diagnostics?: ConversionDiagnosticsSnapshot;
  arm_lifecycle?: Record<string, import('./profileWatchRegistry').WatchArmLifecycleCounts>;
  waiting_arm_stuck?: Array<{
    mint: string;
    symbol?: string;
    profileId?: string;
    ageMs: number;
    hold: string;
    lastArmEvalAt: number | null;
  }>;
  hybrid_fast_arm_opens?: number;
  flow_fast_arm_opens?: number;
  selective_arm_opens?: number;
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
let noneMcGapCount = 0;
const noneMcGapExamples: McOrphanFightExample[] = [];
let orphanExampleMc: number | null = null;
const orphanExamples: McGapOrphanExample[] = [];
const EXAMPLE_CAP = 8;
const orphanFightExamples: McOrphanFightExample[] = [];
let migrationTaggedNotSetupCount = 0;
const migrationTaggedExamples: ConversionDiagExample[] = [];
let dipWinThenPatternFailCount = 0;
let dipPatternFailOnArmedReclaimCount = 0;
const steadyBlockReasons: Record<string, number> = {};
const hwrBlockReasons: Record<string, number> = {};
let rejectedByAllMcBands = 0;
let hybridFastArmOpens = 0;
let flowFastArmOpens = 0;
let selectiveArmOpens = 0;

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

const CANONICAL_SOURCE_SET = new Set<string>(CANONICAL_SCANNER_SOURCES);

/** Map watch/monitor stamps onto Discovery Feeds keys. Never invent STALE fake feeds. */
export function canonicalizeScannerSource(raw?: string | null): string {
  const k = String(raw || '').trim().toLowerCase();
  if (!k) return 'other';
  if (CANONICAL_SOURCE_SET.has(k)) return k;
  if (
    k === 'lane-fight-ms-watch' ||
    k === 'curve-first' ||
    k === 'grad-watch' ||
    k === 'graduating'
  ) {
    return 'graduating_feed';
  }
  if (k === 'onchain' || k === 'helius' || k === 'new_pool') return 'onchain_helius';
  if (k === 'pump' || k === 'pumpportal' || k === 'pump_fun') return 'pump_stream';
  if (k === 'dex' || k === 'trending') return 'dexscreener';
  return 'other';
}

export function isCanonicalScannerSource(source: string): boolean {
  return CANONICAL_SOURCE_SET.has(source);
}

function funnelState(source: string): SourceFunnelState {
  const key = canonicalizeScannerSource(source);
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
    const k = canonicalizeScannerSource(raw);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(k);
  };
  for (const s of input?.scannerSources || []) add(s);
  add(input?.source);
  add(input?.specialtyFeed);
  return out.length > 0 ? out : ['other'];
}

/** Prefer a real feed key when parking a watch (avoid source=scanner). */
export function watchSourceFromCandidate(input?: {
  specialtyFeed?: string | null;
  scannerSources?: string[] | null;
  source?: string | null;
}): string {
  const list = listScannerSources(input);
  return list.find((s) => s !== 'other') || 'other';
}

export function isSourceEnabled(source: string): boolean {
  try {
    const { config } = require('./config') as typeof import('./config');
    const ms = config.marketScanner || {};
    const scannerOn = ms.enabled !== false;
    switch (source) {
      case 'dexscreener':
        return scannerOn;
      case 'gmgn':
        return false;
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
      case 'other':
        return true;
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

export function noteFastArmOpen(path?: string | null): void {
  const p = String(path || '').toLowerCase();
  if (p === 'flow_fast_arm') flowFastArmOpens += 1;
  else if (p === 'selective_arm') selectiveArmOpens += 1;
  else hybridFastArmOpens += 1;
}

function buildSourceFunnelRows(): SourceFunnelRow[] {
  const now = Date.now();
  const keys = new Set<string>(CANONICAL_SCANNER_SOURCES);
  const other = sourceFunnel.get('other');
  if (
    other &&
    (other.candidates_in > 0 ||
      other.watch_inserted > 0 ||
      other.armed > 0 ||
      other.opened > 0 ||
      other.passed_gatekeeper > 0)
  ) {
    keys.add('other');
  }
  const rows: SourceFunnelRow[] = [];
  for (const source of keys) {
    const st = sourceFunnel.get(source) || emptySourceState();
    const enabled = isSourceEnabled(source);
    const lastAt = st.last_nonzero_at;
    const silentFor =
      lastAt != null ? now - lastAt : now - sessionStartedAt;
    const hasDownstream =
      st.watch_inserted > 0 || st.armed > 0 || st.opened > 0;
    let status: SourceFunnelStatus = 'ok';
    if (source === 'other') status = 'derived';
    else if (!enabled) status = 'off';
    else if (st.candidates_in <= 0 && hasDownstream) status = 'derived';
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

const INSERT_OK_WINDOW_MS = 15 * 60_000;
const insertOkAt: number[] = [];
let insertOkCount = 0;

export function noteWatchInsertOk(info?: {
  mint?: string;
  symbol?: string;
  profile?: string;
}): void {
  insertOkCount += 1;
  insertOkAt.push(Date.now());
  const now = Date.now();
  while (insertOkAt.length && now - insertOkAt[0] > INSERT_OK_WINDOW_MS) {
    insertOkAt.shift();
  }
  void info;
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
  mint?: string | null,
  extra?: {
    classifier?: string | null;
    rejects?: Array<{ profileId: string; reason: string }>;
  }
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
  if (extra && (mint || extra.rejects?.length)) {
    orphanFightExamples.unshift({
      mint: String(mint || '').slice(0, 12),
      mc: Number.isFinite(n) ? n : 0,
      classifier: extra.classifier ? String(extra.classifier).slice(0, 48) : null,
      rejects: (extra.rejects || []).slice(0, 8).map((r) => ({
        profileId: String(r.profileId || '').slice(0, 32),
        reason: String(r.reason || '').slice(0, 120),
      })),
    });
    if (orphanFightExamples.length > EXAMPLE_CAP) {
      orphanFightExamples.length = EXAMPLE_CAP;
    }
  }
}

/**
 * Mid-band ($Scalper min–Dip catalog min) still exited as routing-none
 * with no Mode B row. Distinct from owner-none orphans.
 */
export function noteNoneMcGap(
  mcUsd?: number | null,
  mint?: string | null,
  extra?: {
    classifier?: string | null;
    rejects?: Array<{ profileId: string; reason: string }>;
  }
): void {
  noneMcGapCount += 1;
  const n = Number(mcUsd);
  noneMcGapExamples.unshift({
    mint: String(mint || '').slice(0, 12),
    mc: Number.isFinite(n) && n > 0 ? n : 0,
    classifier: extra?.classifier
      ? String(extra.classifier).slice(0, 48)
      : null,
    rejects: (extra?.rejects || []).slice(0, 8).map((r) => ({
      profileId: String(r.profileId || '').slice(0, 32),
      reason: String(r.reason || '').slice(0, 120),
    })),
  });
  if (noneMcGapExamples.length > EXAMPLE_CAP) {
    noneMcGapExamples.length = EXAMPLE_CAP;
  }
}

function pushExample(
  list: ConversionDiagExample[],
  mint: string | null | undefined,
  reason: string
): void {
  const id = String(mint || '').trim();
  if (!id) return;
  list.unshift({ mint: id.slice(0, 12), reason: String(reason || '').slice(0, 140) });
  if (list.length > EXAMPLE_CAP) list.length = EXAMPLE_CAP;
}

export function noteMcFightNone(input: {
  mint?: string | null;
  mc?: number | null;
  classifier?: string | null;
  rejects: Array<{ profileId: string; reason: string }>;
}): void {
  const n = Number(input.mc);
  orphanFightExamples.unshift({
    mint: String(input.mint || '').slice(0, 12),
    mc: Number.isFinite(n) ? n : 0,
    classifier: input.classifier ? String(input.classifier).slice(0, 48) : null,
    rejects: (input.rejects || []).slice(0, 8).map((r) => ({
      profileId: String(r.profileId || '').slice(0, 32),
      reason: String(r.reason || '').slice(0, 120),
    })),
  });
  if (orphanFightExamples.length > EXAMPLE_CAP) {
    orphanFightExamples.length = EXAMPLE_CAP;
  }
}

export function noteMigrationTaggedNotSetup(
  mint?: string | null,
  reason?: string | null
): void {
  migrationTaggedNotSetupCount += 1;
  pushExample(migrationTaggedExamples, mint, reason || 'ms_setup_stage_low');
}

export function noteDipWinThenPatternFail(n = 1): void {
  dipWinThenPatternFailCount += Math.max(1, Math.floor(n));
}

export function noteDipPatternFailOnArmedReclaim(n = 1): void {
  dipPatternFailOnArmedReclaimCount += Math.max(1, Math.floor(n));
}

export function noteSteadyBlockReason(reason: string): void {
  bump(steadyBlockReasons, reason);
}

export function noteHwrBlockReason(reason: string): void {
  bump(hwrBlockReasons, reason);
}

function topReasons(map: Record<string, number>, cap = 8): Record<string, number> {
  return Object.fromEntries(
    Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, cap)
  );
}

export function getConversionDiagnostics(): ConversionDiagnosticsSnapshot {
  let resolvedMinHolders: Record<string, number> = {};
  try {
    const { resolveTradeProfileDefinition } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    for (const pid of ['steady_compounder', 'high_win_rate'] as const) {
      const n = Number(resolveTradeProfileDefinition(pid).match.minHolders);
      if (Number.isFinite(n) && n > 0) resolvedMinHolders[pid] = n;
    }
  } catch {
    resolvedMinHolders = {};
  }
  try {
    const { config } = require('./config') as typeof import('./config');
    const g = Number(config.filters?.minHolders);
    if (Number.isFinite(g) && g > 0) resolvedMinHolders.global = g;
  } catch {
    /* optional */
  }
  let fakeHolderMax15m = 2_000;
  try {
    const { FAKE_HOLDER_VELOCITY_FLOORS } =
      require('./deadTokenFilters') as typeof import('./deadTokenFilters');
    const row = FAKE_HOLDER_VELOCITY_FLOORS.find(
      (f) => Number(f.maxAgeMs) <= 15 * 60_000
    );
    if (row && Number.isFinite(row.maxHolders)) {
      fakeHolderMax15m = Number(row.maxHolders);
    }
  } catch {
    /* catalog */
  }
  const sourceRows = buildSourceFunnelRows();
  const source_counts: Record<string, number> = {};
  for (const row of sourceRows) source_counts[row.source] = row.candidates_in;
  let effective_mc_bands: ConversionDiagnosticsSnapshot['effective_mc_bands'] = {
    dip_buyer: {
      min: 1_000_000,
      max: 500_000_000,
      source: 'catalog',
      minSource: 'catalog',
      maxSource: 'catalog',
    },
    scalper: {
      min: 150_000,
      max: 1_000_000,
      source: 'catalog',
      minSource: 'catalog',
      maxSource: 'catalog',
    },
  };
  try {
    const { getEffectiveMcBand } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    effective_mc_bands = {
      dip_buyer: getEffectiveMcBand('dip_buyer'),
      scalper: getEffectiveMcBand('scalper'),
    };
  } catch {
    /* catalog defaults above */
  }
  let scalper_watch = 0;
  let scalper_arm = 0;
  let scalper_trigger = 0;
  let scalper_open = 0;
  let dip_park = 0;
  let dip_arm = 0;
  let dip_open = 0;
  try {
    const { getProfileWatchFunnels } =
      require('./profileWatchRegistry') as typeof import('./profileWatchRegistry');
    const funnels = getProfileWatchFunnels();
    const s = funnels.scalper;
    if (s) {
      scalper_watch = s.sent_to_watch;
      scalper_arm = s.armed;
      scalper_trigger = s.trigger_ready;
      scalper_open = s.opened;
    }
    const d = funnels.dip_buyer;
    if (d) {
      dip_park = d.sent_to_watch;
      dip_arm = d.armed;
      dip_open = d.opened;
    }
  } catch {
    /* optional */
  }
  let dip_waiting_arm = 0;
  try {
    const { getDipSetupWatchStatus } =
      require('./dipSetupWatch') as typeof import('./dipSetupWatch');
    const st = getDipSetupWatchStatus(200);
    dip_waiting_arm = (st.entries || []).filter(
      (e: { status?: string }) => String(e.status || '') === 'watching'
    ).length;
  } catch {
    /* optional */
  }
  return {
    mc_gap_orphan_count: mcGapOrphanCount,
    none_mc_gap_count: noneMcGapCount,
    none_mc_gap_examples: noneMcGapExamples.slice(0, EXAMPLE_CAP),
    mc_orphan_examples: orphanFightExamples.slice(0, EXAMPLE_CAP),
    migration_tagged_but_not_setup_count: migrationTaggedNotSetupCount,
    migration_tagged_examples: migrationTaggedExamples.slice(0, EXAMPLE_CAP),
    source_counts,
    source_funnel: sourceRows,
    dip_win_then_pattern_fail_count: dipWinThenPatternFailCount,
    dip_pattern_fail_on_armed_reclaim: dipPatternFailOnArmedReclaimCount,
    steady_block_reasons: topReasons(steadyBlockReasons),
    hwr_block_reasons: topReasons(hwrBlockReasons),
    resolved_min_holders: resolvedMinHolders,
    fake_holder_velocity_max_15m: fakeHolderMax15m,
    effective_mc_bands,
    scalper_watch,
    scalper_arm,
    scalper_trigger,
    scalper_open,
    dip_park,
    dip_waiting_arm,
    dip_arm,
    dip_open,
    watchers_isolate: (() => {
      try {
        const { isWatchersIsolate } =
          require('./watchArmLifecycle') as typeof import('./watchArmLifecycle');
        return isWatchersIsolate();
      } catch {
        return false;
      }
    })(),
    trading_entry_pause: (() => {
      try {
        const { isTradingEntryPaused } =
          require('./watchArmLifecycle') as typeof import('./watchArmLifecycle');
        return isTradingEntryPaused();
      } catch {
        return false;
      }
    })(),
    arm_timeout_total: (() => {
      try {
        const { getWatchArmLifecycleSnapshot } =
          require('./profileWatchRegistry') as typeof import('./profileWatchRegistry');
        return Object.values(getWatchArmLifecycleSnapshot()).reduce(
          (n, r) => n + (r.arm_timeout_count || 0),
          0
        );
      } catch {
        return 0;
      }
    })(),
    open_fail_total: (() => {
      try {
        const { getWatchArmLifecycleSnapshot } =
          require('./profileWatchRegistry') as typeof import('./profileWatchRegistry');
        return Object.values(getWatchArmLifecycleSnapshot()).reduce(
          (n, r) => n + (r.open_fail_count || 0),
          0
        );
      } catch {
        return 0;
      }
    })(),
    hybrid_fast_arm_opens: hybridFastArmOpens,
    flow_fast_arm_opens: flowFastArmOpens,
    selective_arm_opens: selectiveArmOpens,
  };
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
    watch_insert_ok: insertOkCount,
    watch_insert_ok_last_15m: insertOkAt.filter(
      (t) => now - t <= INSERT_OK_WINDOW_MS
    ).length,
    watch_insert_rejected_by_reason: { ...rejectedByReason },
    watch_active_count_by_profile: { ...(opts?.activeByProfile || {}) },
    arm_count_by_profile: { ...(opts?.armedByProfile || {}) },
    trigger_ready_count: triggerReadyCount,
    trigger_to_open_blocked_by_reason: { ...triggerOpenBlocked },
    scanner_throttle_state: { ...throttle },
    watcher_lane_latency: watcherLaneLatency,
    armed_to_open_conversion: openedSum / Math.max(armedSum, 1),
    mc_gap_orphan_count: mcGapOrphanCount,
    none_mc_gap_count: noneMcGapCount,
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
    conversion_diagnostics: getConversionDiagnostics(),
    arm_lifecycle: (() => {
      try {
        const { getWatchArmLifecycleSnapshot } =
          require('./profileWatchRegistry') as typeof import('./profileWatchRegistry');
        return getWatchArmLifecycleSnapshot();
      } catch {
        return {};
      }
    })(),
    waiting_arm_stuck: (() => {
      try {
        const { getProfileWatchInventory } =
          require('./profileWatchRegistry') as typeof import('./profileWatchRegistry');
        const { inferWaitingArmHoldReason } =
          require('./watchArmLifecycle') as typeof import('./watchArmLifecycle');
        const inv = getProfileWatchInventory();
        const out: Array<{
          mint: string;
          symbol?: string;
          profileId?: string;
          ageMs: number;
          hold: string;
          lastArmEvalAt: number | null;
        }> = [];
        for (const [pid, bucket] of Object.entries(inv)) {
          for (const e of bucket?.entries || []) {
            if (String(e.status || '') !== 'watching') continue;
            const created = Number((e as { createdAt?: number }).createdAt) || now;
            out.push({
              mint: String(e.mint || ''),
              symbol: e.symbol,
              profileId: pid,
              ageMs: Math.max(0, now - created),
              hold: inferWaitingArmHoldReason(e),
              lastArmEvalAt:
                Number((e as { lastArmEvalAt?: number }).lastArmEvalAt) || null,
            });
          }
        }
        return out.slice(0, 24);
      } catch {
        return [];
      }
    })(),
    hybrid_fast_arm_opens: hybridFastArmOpens,
    flow_fast_arm_opens: flowFastArmOpens,
    selective_arm_opens: selectiveArmOpens,
  };
}
