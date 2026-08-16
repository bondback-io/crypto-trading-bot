/**
 * RPC spike telemetry, last-10 history, containment flags, and Cursor diagnosis.
 * Additive — does not change lane map or trade strategy.
 */

import { AsyncLocalStorage } from 'async_hooks';
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

type Sample = {
  ts: number;
  method: string;
  provider: string;
  queueWaitMs: number;
  networkMs: number;
  totalMs: number;
  outcome: RpcCallOutcome;
  inFlight: number;
};

type LaneBuf = {
  samples: Sample[];
  timeouts: number;
  rateLimited: number;
  last429At: number[];
  provider: string;
  inFlight: number;
  openSpike: RpcSpikeRecord | null;
  recoveringSince: number | null;
  /** Ignore hard_call-only starts until this ts (p95Hot / 429_burst still start). */
  hardCallCooldownUntil: number;
};

const SAMPLE_CAP = 96;
const SPIKE_CAP = 10;
const BOOT_MS = 120_000;
const RECOVER_STABLE_MS = 45_000;
const RECENT_WINDOW_MS = 30_000;
const P95_TRADING_MS = 200;
const P95_WATCHERS_MS = 350;
const P95_OTHER_MS = 400;
/** Trading recover bar — a stable ~250ms Helius window is healthy. */
const RECOVER_TRADING_MS = 280;
const HARD_SPIKE_MS = 1_500;
const HARD_CALL_COOLDOWN_MS = 30_000;
const MAX_SPIKE_AGE_MS = 90_000;
const MAX_SPIKE_AGE_PROBES = 5;
const SOFT_PAUSE_MAX_MS = 90_000;
const BURST_429_N = 3;
const BURST_429_MS = 10_000;
const EXIT_CRITICAL_METHOD_RE =
  /sendRawTransaction|sendTransaction|sendLegacy|confirmTransaction/i;
let startedAt = Date.now();
let lastRecoverReason: string | null = null;
let entryPauseAutoCleared = 0;
/** Spike id whose entry pause already auto-cleared — stays off until a new spike. */
let entryPauseClearedSpikeId: string | null = null;

const lanes: Record<RpcSpikeLane, LaneBuf> = {
  primary: emptyBuf(),
  secondary: emptyBuf(),
  watchers: emptyBuf(),
  utility: emptyBuf(),
};

const history: RpcSpikeRecord[] = [];
let spikeSeq = 0;
const containmentActionsLog: string[] = [];

const callCtxAls = new AsyncLocalStorage<{
  queueWaitMs: number;
  inFlight: number;
}>();

function emptyBuf(): LaneBuf {
  return {
    samples: [],
    timeouts: 0,
    rateLimited: 0,
    last429At: [],
    provider: '—',
    inFlight: 0,
    openSpike: null,
    recoveringSince: null,
    hardCallCooldownUntil: 0,
  };
}

function pctl(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(p * (sorted.length - 1)))
  );
  return sorted[idx];
}

function thresholdFor(lane: RpcSpikeLane): number {
  if (lane === 'primary') return P95_TRADING_MS;
  if (lane === 'watchers') return P95_WATCHERS_MS;
  return P95_OTHER_MS;
}

function recoverThreshold(lane: RpcSpikeLane): number {
  if (lane === 'primary') return RECOVER_TRADING_MS;
  return thresholdFor(lane);
}

function isContainmentOn(): boolean {
  try {
    const { config } = require('./config') as typeof import('./config');
    return config.rpc?.containmentEnabled !== false;
  } catch {
    return true;
  }
}

export function isRpcContainmentEnabled(): boolean {
  return isContainmentOn();
}

function safeProviderLabel(raw: string): string {
  const s = String(raw || '').trim();
  if (!s) return '—';
  if (/helius/i.test(s)) return 'Helius';
  if (/alchemy/i.test(s)) {
    if (/backup2/i.test(s)) return 'Alchemy-backup2';
    if (/backup/i.test(s)) return 'Alchemy-backup';
    return 'Alchemy';
  }
  if (/quicknode/i.test(s)) return 'QuickNode';
  if (/public/i.test(s) || /mainnet-beta/i.test(s) || /api\.mainnet/i.test(s)) {
    return 'public';
  }
  if (/^https?:/i.test(s) || /api[_-]?key/i.test(s) || /@/.test(s)) return 'rpc';
  return s.slice(0, 40);
}

export function runWithSpikeCallContext<T>(
  ctx: { queueWaitMs: number; inFlight: number },
  fn: () => T
): T {
  return callCtxAls.run(ctx, fn);
}

export function currentSpikeCallContext(): {
  queueWaitMs: number;
  inFlight: number;
} | undefined {
  return callCtxAls.getStore();
}

export function classifyRpcOutcome(opts: {
  ok: boolean;
  status?: number | null;
  error?: unknown;
}): RpcCallOutcome {
  const status = Number(opts.status);
  if (status === 429) return '429';
  const msg = opts.error instanceof Error ? opts.error.message : String(opts.error || '');
  if (/timeout|aborted|abort|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(msg)) {
    return 'timeout';
  }
  if (/429|rate.?limit/i.test(msg)) return '429';
  if (opts.ok) return 'success';
  return 'other';
}

function classifySpike(lane: RpcSpikeLane, window: Sample[]): RpcSpikeClass {
  const uptime = Date.now() - startedAt;
  if (uptime < BOOT_MS) return 'post_boot';
  if (!window.length) return 'unknown';
  const avgQ =
    window.reduce((s, x) => s + x.queueWaitMs, 0) / Math.max(1, window.length);
  const avgN =
    window.reduce((s, x) => s + x.networkMs, 0) / Math.max(1, window.length);
  const timeouts = window.filter((x) => x.outcome === 'timeout').length;
  const rl = window.filter((x) => x.outcome === '429').length;
  const peakInf = window.reduce((m, x) => Math.max(m, x.inFlight), 0);
  const methods = new Set(window.map((x) => x.method)).size;
  if (avgQ > avgN * 1.25 && avgQ >= 80) return 'app_queueing';
  if (timeouts + rl >= Math.max(3, Math.floor(window.length * 0.25))) {
    return 'retry_amplification';
  }
  if (peakInf >= 6 && methods >= 4) return 'burst_fanout';
  if (avgN >= 180 && avgQ < 60) return 'provider_slowness';
  const maxMs = window.reduce((m, x) => Math.max(m, x.totalMs), 0);
  const winP95 = pctl(
    window.map((s) => s.totalMs),
    0.95
  );
  if (
    maxMs >= HARD_SPIKE_MS ||
    (winP95 != null && winP95 > thresholdFor(lane))
  ) {
    return 'provider_slowness';
  }
  return 'unknown';
}

function topMethods(window: Sample[]): RpcSpikeMethodStat[] {
  const by = new Map<string, { count: number; totalMs: number }>();
  for (const s of window) {
    const row = by.get(s.method) || { count: 0, totalMs: 0 };
    row.count += 1;
    row.totalMs += s.totalMs;
    by.set(s.method, row);
  }
  return [...by.entries()]
    .map(([method, v]) => ({
      method,
      count: v.count,
      avgMs: v.count ? Math.round(v.totalMs / v.count) : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
}

function noteContainment(action: string, rec: RpcSpikeRecord | null): void {
  if (!action) return;
  if (rec && !rec.containmentActions.includes(action)) {
    rec.containmentActions.push(action);
  }
  containmentActionsLog.push(action);
  while (containmentActionsLog.length > 40) containmentActionsLog.shift();
  console.warn('[rpc_containment_action]', action);
}

function applyContainment(lane: RpcSpikeLane, rec: RpcSpikeRecord): void {
  if (!isContainmentOn()) return;
  if (lane === 'watchers') {
    noteContainment('watchers_shed_enrich_slow_reprice', rec);
  } else if (lane === 'primary') {
    noteContainment('trading_soft_pause_new_entries', rec);
    noteContainment('trading_retry_cap_1_2', rec);
  } else if (lane === 'secondary') {
    noteContainment('scanners_degrade_enrich', rec);
  } else {
    noteContainment('utility_slow_polls', rec);
  }
}

function startSpike(
  lane: RpcSpikeLane,
  buf: LaneBuf,
  now: number,
  reason: string
): void {
  if (buf.openSpike) return;
  const window = buf.samples.filter((s) => now - s.ts <= 30_000);
  const p95 = pctl(window.map((s) => s.totalMs), 0.95) ?? 0;
  const rec: RpcSpikeRecord = {
    id: `spk-${lane}-${++spikeSeq}`,
    lane,
    provider: buf.provider || '—',
    startedAt: now,
    endedAt: null,
    durationMs: null,
    peakP95: p95,
    peakInFlight: buf.inFlight,
    topMethods: topMethods(window),
    errorCounts: {
      timeout: window.filter((s) => s.outcome === 'timeout').length,
      rateLimited: window.filter((s) => s.outcome === '429').length,
      other: window.filter((s) => s.outcome === 'other').length,
    },
    class: classifySpike(lane, window),
    containmentActions: [],
    recoveredAt: null,
  };
  buf.openSpike = rec;
  buf.recoveringSince = null;
  if (lane === 'primary') entryPauseClearedSpikeId = null;
  history.push(rec);
  trimHistory();
  console.warn('[rpc_spike_start]', {
    id: rec.id,
    lane,
    provider: rec.provider,
    class: rec.class,
    reason,
    p95,
  });
  console.warn('[rpc_spike_class]', { id: rec.id, class: rec.class });
  applyContainment(lane, rec);
}

function trimHistory(): void {
  while (history.length > SPIKE_CAP) {
    const idx = history.findIndex((s) => s.endedAt != null);
    if (idx < 0) return;
    history.splice(idx, 1);
  }
}

function recentSamples(buf: LaneBuf, now: number): Sample[] {
  return buf.samples.filter((s) => now - s.ts <= RECENT_WINDOW_MS);
}

function recentP95(buf: LaneBuf, now: number): number | null {
  const window = recentSamples(buf, now);
  if (!window.length) return null;
  return pctl(window.map((s) => s.totalMs), 0.95);
}

function isExitCriticalMethod(method: string): boolean {
  return EXIT_CRITICAL_METHOD_RE.test(String(method || ''));
}

/** 30s recover window — exit sends do not keep entry pause pinned. */
function recoverSamples(buf: LaneBuf, now: number): Sample[] {
  return recentSamples(buf, now).filter((s) => !isExitCriticalMethod(s.method));
}

/**
 * Healthy when idle, under the recover bar, or only one hard outlier remains
 * (same lone-hard-call idea as spike start).
 */
function recoverHealth(
  lane: RpcSpikeLane,
  buf: LaneBuf,
  now: number
): { p95: number | null; healthy: boolean } {
  const recoverAt = recoverThreshold(lane);
  const window = recoverSamples(buf, now);
  if (!window.length) return { p95: null, healthy: true };
  const hardOutliers = window.filter((s) => s.totalMs >= HARD_SPIKE_MS);
  if (hardOutliers.length === 1 && window.length >= 2) {
    const rest = window.filter((s) => s !== hardOutliers[0]);
    const restP95 = pctl(
      rest.map((s) => s.totalMs),
      0.95
    );
    if (restP95 == null || restP95 <= recoverAt) {
      return { p95: restP95, healthy: true };
    }
  }
  const p95 = pctl(
    window.map((s) => s.totalMs),
    0.95
  );
  return { p95, healthy: p95 == null || p95 <= recoverAt };
}

function endOpenSpike(
  lane: RpcSpikeLane,
  buf: LaneBuf,
  now: number,
  reason: string
): void {
  const rec = buf.openSpike;
  if (!rec) return;
  rec.endedAt = now;
  rec.recoveredAt = now;
  rec.durationMs = now - rec.startedAt;
  rec.topMethods = topMethods(buf.samples.filter((s) => s.ts >= rec.startedAt));
  buf.openSpike = null;
  buf.recoveringSince = null;
  buf.hardCallCooldownUntil = now + HARD_CALL_COOLDOWN_MS;
  lastRecoverReason = reason;
  console.warn('[rpc_spike_recovered]', {
    id: rec.id,
    lane,
    durationMs: rec.durationMs,
    class: rec.class,
    reason,
  });
}

function lastNonExitProbes(buf: LaneBuf, n: number): Sample[] {
  const out: Sample[] = [];
  for (let i = buf.samples.length - 1; i >= 0 && out.length < n; i--) {
    if (!isExitCriticalMethod(buf.samples[i].method)) {
      out.push(buf.samples[i]);
    }
  }
  return out.reverse();
}

function lastProbesUnderRecoverBar(
  lane: RpcSpikeLane,
  buf: LaneBuf,
  n: number
): boolean {
  const probes = lastNonExitProbes(buf, n);
  if (probes.length < n) return false;
  const bar = recoverThreshold(lane);
  return probes.every((s) => s.totalMs <= bar);
}

function maybeRecover(lane: RpcSpikeLane, buf: LaneBuf, now: number): void {
  const rec = buf.openSpike;
  if (!rec) {
    buf.recoveringSince = null;
    return;
  }
  const { healthy } = recoverHealth(lane, buf, now);
  if (healthy) {
    if (buf.recoveringSince == null) buf.recoveringSince = now;
    if (now - buf.recoveringSince >= RECOVER_STABLE_MS) {
      const reason =
        rec.class === 'post_boot' ? 'post_boot_stable_clear' : 'p95_stable';
      endOpenSpike(lane, buf, now, reason);
      return;
    }
  } else {
    buf.recoveringSince = null;
  }
  if (
    now - rec.startedAt >= MAX_SPIKE_AGE_MS &&
    lastProbesUnderRecoverBar(lane, buf, MAX_SPIKE_AGE_PROBES)
  ) {
    endOpenSpike(lane, buf, now, 'max_age');
  }
}

/** After boot: relabel stuck post_boot if still hot; recover from recent p95. */
function tickLaneHygiene(lane: RpcSpikeLane, buf: LaneBuf, now: number): void {
  const rec = buf.openSpike;
  if (!rec) return;
  const p95 = recentP95(buf, now);
  const pastBoot = now - startedAt >= BOOT_MS;
  if (pastBoot && rec.class === 'post_boot') {
    const recoverAt = recoverThreshold(lane);
    const hot = p95 != null && p95 > recoverAt;
    if (hot) {
      const next = classifySpike(lane, recentSamples(buf, now));
      rec.class = next;
      console.warn('[rpc_spike_class]', {
        id: rec.id,
        class: rec.class,
        reason: 'post_boot_reclass',
      });
    }
  }
  maybeRecover(lane, buf, now);
}

function tickAllLaneHygiene(): void {
  const now = Date.now();
  (['primary', 'secondary', 'watchers', 'utility'] as RpcSpikeLane[]).forEach(
    (lane) => tickLaneHygiene(lane, lanes[lane], now)
  );
}

export function noteRpcCall(opts: {
  lane?: string | null;
  provider: string;
  method: string;
  queueWaitMs?: number;
  networkMs: number;
  totalMs?: number;
  outcome: RpcCallOutcome;
  inFlight?: number;
}): void {
  const lane = (opts.lane === 'primary' ||
  opts.lane === 'secondary' ||
  opts.lane === 'watchers' ||
  opts.lane === 'utility'
    ? opts.lane
    : 'utility') as RpcSpikeLane;
  const ctx = currentSpikeCallContext();
  const queueWaitMs = Math.max(
    0,
    Math.round(opts.queueWaitMs ?? ctx?.queueWaitMs ?? 0)
  );
  const networkMs = Math.max(0, Math.round(opts.networkMs));
  const totalMs = Math.max(
    0,
    Math.round(opts.totalMs ?? queueWaitMs + networkMs)
  );
  const inFlight = Math.max(0, Math.round(opts.inFlight ?? ctx?.inFlight ?? 0));
  const buf = lanes[lane];
  buf.provider = safeProviderLabel(opts.provider || buf.provider || '—');
  buf.inFlight = inFlight;
  const now = Date.now();
  buf.samples.push({
    ts: now,
    method: String(opts.method || 'unknown').slice(0, 64),
    provider: buf.provider,
    queueWaitMs,
    networkMs,
    totalMs,
    outcome: opts.outcome,
    inFlight,
  });
  while (buf.samples.length > SAMPLE_CAP) buf.samples.shift();
  if (opts.outcome === 'timeout') buf.timeouts += 1;
  if (opts.outcome === '429') {
    buf.rateLimited += 1;
    buf.last429At.push(now);
    while (buf.last429At.length && now - buf.last429At[0] > BURST_429_MS) {
      buf.last429At.shift();
    }
  }

  const thr = thresholdFor(lane);
  const recentWin = recentSamples(buf, now);
  const recent = recentWin.length
    ? pctl(
        recentWin.map((s) => s.totalMs),
        0.95
      )
    : null;
  const recoverAt = recoverThreshold(lane);
  const recentHealthy = recent == null || recent <= recoverAt;
  const hard = totalMs >= Math.max(HARD_SPIKE_MS, thr * 3);
  const burst429 = buf.last429At.length >= BURST_429_N;
  const p95Hot = recentWin.length >= 8 && recent != null && recent > thr;

  if (buf.openSpike) {
    buf.openSpike.peakP95 = Math.max(buf.openSpike.peakP95, recent ?? 0);
    buf.openSpike.peakInFlight = Math.max(buf.openSpike.peakInFlight, inFlight);
    if (opts.outcome === 'timeout') buf.openSpike.errorCounts.timeout += 1;
    if (opts.outcome === '429') buf.openSpike.errorCounts.rateLimited += 1;
    if (opts.outcome === 'other') buf.openSpike.errorCounts.other += 1;
    tickLaneHygiene(lane, buf, now);
  } else if (burst429) {
    startSpike(lane, buf, now, '429_burst');
  } else if (p95Hot) {
    startSpike(lane, buf, now, 'p95');
  } else if (hard) {
    const inHardCooldown = now < (buf.hardCallCooldownUntil || 0);
    if (!inHardCooldown && !recentHealthy) {
      startSpike(lane, buf, now, 'hard_call');
    }
  }
}

export function isLaneSpiking(lane: RpcSpikeLane): boolean {
  return lanes[lane].openSpike != null;
}

export function isLaneRecovering(lane: RpcSpikeLane): boolean {
  return lanes[lane].openSpike != null && lanes[lane].recoveringSince != null;
}

function recentWindowHasTimeoutOr429(buf: LaneBuf, now: number): boolean {
  return recentSamples(buf, now).some(
    (s) => s.outcome === 'timeout' || s.outcome === '429'
  );
}

/**
 * Pause new entries while a primary spike is open, but not for the whole uptime.
 * After 90s with no timeouts/429s, auto-clear for this spike. A new spike re-pauses.
 */
function refreshPrimaryEntryPause(now: number): boolean {
  if (!isContainmentOn()) return false;
  const rec = lanes.primary.openSpike;
  if (!rec) return false;
  if (entryPauseClearedSpikeId === rec.id) return false;
  if (now - rec.startedAt < SOFT_PAUSE_MAX_MS) return true;
  if (recentWindowHasTimeoutOr429(lanes.primary, now)) return true;
  entryPauseClearedSpikeId = rec.id;
  entryPauseAutoCleared += 1;
  if (!rec.containmentActions.includes('entry_pause_auto_cleared')) {
    rec.containmentActions.push('entry_pause_auto_cleared');
  }
  console.warn('[rpc_containment_action]', 'entry_pause_auto_cleared', {
    spikeId: rec.id,
    count: entryPauseAutoCleared,
  });
  return false;
}

export function shouldSoftPauseNewEntries(): boolean {
  return refreshPrimaryEntryPause(Date.now());
}

/** Shed non-exit getSignatures/getTransaction on Trading while a primary spike is open. */
export function shouldShedPrimaryMonitoring(): boolean {
  return isContainmentOn() && isLaneSpiking('primary');
}

export function getLastRpcSpikeRecoverReason(): string | null {
  return lastRecoverReason;
}

export function withRpcAttemptCap(critical: boolean, defaultMax: number): number {
  if (!isContainmentOn() || !isLaneSpiking('primary')) return defaultMax;
  return critical ? Math.min(defaultMax, 2) : Math.min(defaultMax, 1);
}

export function laneTelemetry(lane: RpcSpikeLane): RpcLaneTelemetry {
  const buf = lanes[lane];
  const now = Date.now();
  const recent = recentSamples(buf, now);
  const totals = recent.map((s) => s.totalMs);
  let status: RpcLaneTelemetry['status'] = 'ok';
  if (buf.openSpike && buf.recoveringSince) status = 'recovering';
  else if (buf.openSpike) status = 'spike';
  return {
    lane,
    p50: pctl(totals, 0.5),
    p95: pctl(totals, 0.95),
    inFlight: buf.inFlight,
    timeoutCount: buf.timeouts,
    rateLimitedCount: buf.rateLimited,
    samples: recent.length,
    status,
    provider: buf.provider,
  };
}

function readExitLaneGuardTrips(): number {
  try {
    return (
      require('./connection') as typeof import('./connection')
    ).getExitLaneGuardTrips();
  } catch {
    return 0;
  }
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
  tickAllLaneHygiene();
  const now = Date.now();
  const entryPauseActive = refreshPrimaryEntryPause(now);
  return {
    containmentEnabled: isContainmentOn(),
    trading: laneTelemetry('primary'),
    watchers: laneTelemetry('watchers'),
    scanners: laneTelemetry('secondary'),
    utility: laneTelemetry('utility'),
    spikes: history.slice().reverse(),
    openSpikes: history.filter((s) => !s.recoveredAt),
    entryPauseActive,
    entry_pause_auto_cleared: entryPauseAutoCleared,
    lastRecoverReason,
    exit_lane_guard_trips: readExitLaneGuardTrips(),
  };
}

const CURSOR_PREAMBLE = `Plan mode only first.
Do not edit files yet.
Evaluate this RPC Spike Diagnosis carefully and return:
1) top bottlenecks ranked by impact
2) which are safe to patch now
3) exact Cursor-ready prompts for only the safe patches

Rules:
- Propose only small additive RPC/reliability fixes
- Do not rewrite trading strategy
- Do not break lane isolation (Trading Helius vs Watchers Alchemy)
- Prefer containment, retry caps, dedupe, shedding, sticky-state recovery
- Return patch prompts only if justified by the diagnosis data

`;

function fmtMs(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${Math.round(n)}ms`;
}

function rankCauses(snap: ReturnType<typeof getSpikeInspectorSnapshot>): string[] {
  const counts = new Map<string, number>();
  for (const s of snap.spikes) {
    counts.set(s.class, (counts.get(s.class) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) {
    if (snap.trading.status === 'ok' && snap.watchers.status === 'ok') {
      return ['No recent spikes — lanes look stable. Prefer watch-and-wait over patches.'];
    }
    return ['Active stress without a closed spike yet — wait for class + recovery before patching.'];
  }
  return ranked.map(([cls, n], i) => {
    const hint =
      cls === 'provider_slowness'
        ? 'provider cooldown + retry cap, do not flap failover'
        : cls === 'app_queueing'
          ? 'shed Watchers/Utility; keep Critical exits uncapped-skip'
          : cls === 'retry_amplification'
            ? 'cap withRpc attempts 1–2 during Trading spike'
            : cls === 'burst_fanout'
              ? 'dedupe identical in-flight reads; slow watch reprice'
              : cls === 'post_boot'
                ? 'ignore boot burst unless it persists past 2 min'
                : 'inspect top methods before changing lanes';
    return `${i + 1}. ${cls} ×${n} — ${hint}`;
  });
}

export function buildRpcSpikeDiagnosis(): {
  generatedAt: string;
  cursorPackage: string;
  reportText: string;
} {
  const snap = getSpikeInspectorSnapshot();
  let mode = '—';
  try {
    const { config } = require('./config') as typeof import('./config');
    mode = String(config.mode || '—');
  } catch {
    /* */
  }
  const uptimeSec = Math.round((Date.now() - startedAt) / 1000);
  const methodCounts = new Map<string, number>();
  for (const s of snap.spikes) {
    for (const m of s.topMethods) {
      methodCounts.set(m.method, (methodCounts.get(m.method) || 0) + m.count);
    }
  }
  const topMethodsAll = [...methodCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([m, n]) => `${m} ×${n}`);

  const lines: string[] = [];
  lines.push('# RPC Spike Diagnosis');
  lines.push('');
  lines.push('## 1. Snapshot');
  lines.push(`- time: ${new Date().toISOString()}`);
  lines.push(`- mode: ${mode}`);
  lines.push(`- uptime: ${uptimeSec}s`);
  lines.push(
    `- containment: ${snap.containmentEnabled ? 'ON' : 'OFF'}`
  );
  lines.push(
    `- entry pause: ${snap.entryPauseActive ? 'active' : 'off'} · auto_cleared ${snap.entry_pause_auto_cleared} · last recover: ${snap.lastRecoverReason || '—'}`
  );
  lines.push(`- exit_lane_guard_trips: ${snap.exit_lane_guard_trips}`);
  lines.push(
    `- Trading / Helius: status ${snap.trading.status} · p50 ${fmtMs(snap.trading.p50)} · p95 ${fmtMs(snap.trading.p95)} · inFlight ${snap.trading.inFlight} · 429 ${snap.trading.rateLimitedCount} · timeout ${snap.trading.timeoutCount}`
  );
  lines.push(
    `- Watchers / Alchemy-backup: status ${snap.watchers.status} · p50 ${fmtMs(snap.watchers.p50)} · p95 ${fmtMs(snap.watchers.p95)} · inFlight ${snap.watchers.inFlight} · 429 ${snap.watchers.rateLimitedCount} · timeout ${snap.watchers.timeoutCount}`
  );
  lines.push(
    `- Scanners / Alchemy: status ${snap.scanners.status} · p95 ${fmtMs(snap.scanners.p95)}`
  );
  lines.push(
    `- Utility / public: status ${snap.utility.status} · p95 ${fmtMs(snap.utility.p95)}`
  );
  lines.push('');
  lines.push('## 2. Last 10 spikes');
  if (!snap.spikes.length) {
    lines.push('- none yet');
  } else {
    for (const s of snap.spikes) {
      const dur =
        s.durationMs != null
          ? `${Math.round(s.durationMs / 1000)}s`
          : 'open';
      lines.push(
        `- ${s.id} · ${s.lane} · ${s.provider} · ${s.class} · ${dur} · peak p95 ${fmtMs(s.peakP95)} · inFlight ${s.peakInFlight} · recovered ${s.recoveredAt ? 'yes' : 'no'}`
      );
      if (s.topMethods.length) {
        lines.push(
          `  methods: ${s.topMethods.map((m) => `${m.method}×${m.count}@${m.avgMs}ms`).join(', ')}`
        );
      }
      if (s.containmentActions.length) {
        lines.push(`  actions: ${s.containmentActions.join(', ')}`);
      }
    }
  }
  lines.push('');
  lines.push('## 3. Top spike classes + methods');
  const classCounts = new Map<string, number>();
  for (const s of snap.spikes) {
    classCounts.set(s.class, (classCounts.get(s.class) || 0) + 1);
  }
  lines.push(
    classCounts.size
      ? [...classCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([c, n]) => `${c}×${n}`)
          .join(', ')
      : '- none'
  );
  lines.push(topMethodsAll.length ? topMethodsAll.join(', ') : '- no method samples');
  lines.push('');
  lines.push('## 4. Likely root causes (ranked)');
  for (const row of rankCauses(snap)) lines.push(`- ${row}`);
  lines.push('');
  lines.push('## 5. Safe additive recommendations');
  lines.push('- Keep Trading exits on Critical/Helius (`send_tx`); never route sells onto Watchers/Utility.');
  lines.push('- During Watchers spike: shed enrich / slow reprice; do not pause SL / peak-protection / exits.');
  lines.push('- During Trading spike: soft-pause new entries only; cap retries at 1–2 with backoff.');
  lines.push('- Dedupe identical in-flight reads; keep 429 provider cooldown sticky (do not shorten).');
  lines.push('- Reversible via Stats → RPC containment toggle.');
  lines.push('');
  lines.push('## 6. Non-goals');
  lines.push('- Do not rewrite RPC architecture or merge Trading Helius with Watchers Alchemy.');
  lines.push('- Do not loosen trade strategy, late-chase, or profile floors.');
  lines.push('- Do not auto-commit, auto-deploy, or mutate open trades from this report.');

  const reportText = lines.join('\n');
  return {
    generatedAt: new Date().toISOString(),
    cursorPackage: CURSOR_PREAMBLE + reportText,
    reportText,
  };
}

/** Test helper — not used in production paths. */
export function __resetRpcSpikeInspectorForTests(): void {
  startedAt = Date.now();
  (['primary', 'secondary', 'watchers', 'utility'] as RpcSpikeLane[]).forEach(
    (lane) => {
      lanes[lane] = emptyBuf();
    }
  );
  history.length = 0;
  spikeSeq = 0;
  containmentActionsLog.length = 0;
  lastRecoverReason = null;
  entryPauseAutoCleared = 0;
  entryPauseClearedSpikeId = null;
}

/** Pretend the inspector has been up for `ms` (post-boot hygiene tests). */
export function __setSpikeInspectorUptimeForTests(ms: number): void {
  startedAt = Date.now() - Math.max(0, Math.round(ms));
}

/** Mark an open spike as recovering for `elapsedMs` so the next tick can clear. */
export function __forceSpikeRecoveringElapsedForTests(
  lane: RpcSpikeLane,
  elapsedMs: number
): void {
  const buf = lanes[lane];
  if (!buf.openSpike) return;
  buf.recoveringSince = Date.now() - Math.max(0, Math.round(elapsedMs));
}

/** Age lane samples so they fall out of the 30s recovery window. */
export function __ageLaneSamplesForTests(lane: RpcSpikeLane, ageMs: number): void {
  const buf = lanes[lane];
  const d = Math.max(0, Math.round(ageMs));
  for (const s of buf.samples) s.ts -= d;
}

/** Age an open spike's start so max-age / pause-cap tests can fire. */
export function __ageOpenSpikeStartedAtForTests(
  lane: RpcSpikeLane,
  ageMs: number
): void {
  const rec = lanes[lane].openSpike;
  if (!rec) return;
  rec.startedAt -= Math.max(0, Math.round(ageMs));
}

/** End an open spike so tests can open the next one (sets hard-call cooldown). */
export function __endOpenSpikeForTests(lane: RpcSpikeLane): void {
  endOpenSpike(lane, lanes[lane], Date.now(), 'test_end');
}

/** Expire hard-call-only cooldown so a later lone hard call can be evaluated again. */
export function __clearHardCallCooldownForTests(lane: RpcSpikeLane): void {
  lanes[lane].hardCallCooldownUntil = 0;
}
