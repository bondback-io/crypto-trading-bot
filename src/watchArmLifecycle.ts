/**
 * Shared waiting-arm clocks, hold reasons, and vol-ok stamping.
 * Family Maps stay source of truth — this module does not own ticks or RPC.
 */

import { watchVolumeOkFlag, type WatchConfluenceInput } from './profileTaPlaybook';

export const WAITING_ARM_TIMEOUT_MS = 20 * 60_000;
export const ARMED_TRIGGER_TIMEOUT_MS = 20 * 60_000;
export const WAITING_OPEN_CONTAINMENT_PAUSE = 'waiting_open_containment_pause';

export type ArmLifecycleRow = {
  status?: string;
  createdAt?: number;
  armedAt?: number | null;
  lastReason?: string;
  nearKeyFib?: boolean;
  nearSupport?: boolean;
  nearMultiTfSupport?: boolean;
  nearLevel?: boolean;
  hasLevel?: boolean;
  supportTfHits?: unknown;
  supportPriceSol?: number | null;
  volumeState?: string;
  volumeH1Usd?: number;
  volumeM5Usd?: number;
  volOk?: boolean;
  volumeExpanding?: boolean;
  armClockPausedAt?: number | null;
  armClockPausedMs?: number;
  preferredProfileId?: string | null;
  lastArmEvalAt?: number | null;
  fightDipDna?: boolean;
  lastPriceSol?: number | null;
  fib05PriceSol?: number | null;
  fib618PriceSol?: number | null;
};

export function isWatchersIsolate(): boolean {
  try {
    const { shouldIdleIsolate } =
      require('./rpcWorkloadControl') as typeof import('./rpcWorkloadControl');
    return shouldIdleIsolate() === true;
  } catch {
    return false;
  }
}

export function isTradingEntryPaused(): boolean {
  try {
    const { shouldSoftPauseNewEntries } =
      require('./rpcSpikeInspector') as typeof import('./rpcSpikeInspector');
    return shouldSoftPauseNewEntries() === true;
  } catch {
    return false;
  }
}

/** Armed trigger clocks pause only while new entries are containment-paused. */
export function shouldPauseArmClocks(): boolean {
  return isTradingEntryPaused();
}

export function watchHasLevelEvidence(w: ArmLifecycleRow): boolean {
  if (
    w.nearKeyFib === true ||
    w.nearSupport === true ||
    w.nearMultiTfSupport === true ||
    w.nearLevel === true ||
    w.hasLevel === true
  ) {
    return true;
  }
  const px = Number(w.supportPriceSol);
  if (Number.isFinite(px) && px > 0) return true;
  return Array.isArray(w.supportTfHits) && w.supportTfHits.length >= 1;
}

export function stampWatchVolumeOk(w: ArmLifecycleRow): void {
  const asWatch = w as WatchConfluenceInput;
  if (!watchVolumeOkFlag(asWatch)) return;
  w.volOk = true;
  const st = String(w.volumeState || '').toLowerCase();
  if (
    st !== 'expanding' &&
    st !== 'stable' &&
    st !== 'ok' &&
    st !== 'weakening'
  ) {
    w.volumeState = 'ok';
  }
}

function slugHold(raw: string): string {
  const s = String(raw || '')
    .trim()
    .replace(/^waiting_arm:\s*/i, '')
    .slice(0, 64);
  if (/skipped_low_score/i.test(s)) return 'skipped_low_score';
  const have = s.match(/have\s+(\d+)/i);
  if (/need \d+\s*TA|confluence/i.test(s)) {
    return have ? `confluence_${have[1]}` : 'confluence';
  }
  if (/waiting_open_containment|containment_pause/i.test(s)) {
    return 'containment_pause';
  }
  if (/not_near_level|no level|no_level/i.test(s)) return 'not_near_level';
  if (/watchers_isolate|rpc_workload/i.test(s)) return 'watchers_isolate';
  if (/arm_timeout/i.test(s)) return 'arm_timeout';
  if (/trigger_timeout/i.test(s)) return 'trigger_timeout';
  return s.replace(/\s+/g, '_').slice(0, 40) || 'waiting_setup';
}

export function inferWaitingArmHoldReason(w: ArmLifecycleRow): string {
  if (isTradingEntryPaused() && String(w.status || '') === 'armed') {
    return 'containment_pause';
  }
  const lr = String(w.lastReason || '');
  if (/skipped_low_score/i.test(lr)) return 'skipped_low_score';
  if (/waiting_open_containment/i.test(lr)) return 'containment_pause';
  const have = lr.match(/have\s+(\d+)/i);
  if (/need \d+\s*TA|confluence/i.test(lr)) {
    return have ? `confluence_${have[1]}` : 'confluence';
  }
  if (String(w.status || '') === 'watching' && !watchHasLevelEvidence(w)) {
    return 'not_near_level';
  }
  if (String(w.status || '') === 'watching') {
    return lr ? slugHold(lr) : 'waiting_setup';
  }
  if (String(w.status || '') === 'armed') {
    return lr ? slugHold(lr) : 'waiting_trigger';
  }
  return lr ? slugHold(lr) : 'waiting_arm';
}

export function stampWatchingHoldReason(w: ArmLifecycleRow): void {
  if (String(w.status || '') !== 'watching') return;
  w.lastReason = 'waiting_arm: ' + inferWaitingArmHoldReason(w);
}

export function stampCheapArmEval(w: ArmLifecycleRow, now = Date.now()): void {
  w.lastArmEvalAt = now;
  stampWatchVolumeOk(w);
  if (String(w.status || '') === 'watching') stampWatchingHoldReason(w);
}

export function resetArmClockOnArm(w: ArmLifecycleRow): void {
  w.armClockPausedAt = null;
  w.armClockPausedMs = 0;
}

export function applyArmLifecycleTimeout(
  w: ArmLifecycleRow,
  now: number
): 'arm_timeout' | 'trigger_timeout' | 'promote_fast_arm' | null {
  const status = String(w.status || '');
  if (status === 'armed' && isTradingEntryPaused()) {
    if (w.armClockPausedAt == null) w.armClockPausedAt = now;
    return null;
  }
  if (w.armClockPausedAt != null) {
    w.armClockPausedMs = (w.armClockPausedMs || 0) + (now - w.armClockPausedAt);
    w.armClockPausedAt = null;
  }
  const paused = Number(w.armClockPausedMs) || 0;
  if (status === 'watching') {
    let waitMs = WAITING_ARM_TIMEOUT_MS;
    try {
      const { waitingArmTimeoutMs, shouldFastArmOpen } =
        require('./admissionMode') as typeof import('./admissionMode');
      waitMs = waitingArmTimeoutMs(w.preferredProfileId);
      if (now - (Number(w.createdAt) || now) >= waitMs) {
        const fa = shouldFastArmOpen({
          profileId: w.preferredProfileId,
          lateChase: /late.?chase/i.test(String(w.lastReason || '')),
          lastPriceSol: w.lastPriceSol,
          supportPriceSol: w.supportPriceSol,
          fib05PriceSol: w.fib05PriceSol,
          fib618PriceSol: w.fib618PriceSol,
          nearKeyFib: w.nearKeyFib === true,
          nearSupport: w.nearSupport === true,
          nearMultiTfSupport: w.nearMultiTfSupport === true,
          hasLevelEvidence: watchHasLevelEvidence(w),
        });
        if (fa.fastArm) {
          w.status = 'armed';
          w.armedAt = now;
          w.lastReason = 'timeout_fast_arm';
          w.lastArmEvalAt = now;
          return 'promote_fast_arm';
        }
        return 'arm_timeout';
      }
      return null;
    } catch {
      if (now - (Number(w.createdAt) || now) >= WAITING_ARM_TIMEOUT_MS) {
        return 'arm_timeout';
      }
      return null;
    }
  }
  if (status === 'armed') {
    const t0 = Number(w.armedAt) || Number(w.createdAt) || now;
    if (now - t0 - paused >= ARMED_TRIGGER_TIMEOUT_MS) return 'trigger_timeout';
  }
  return null;
}

export function isRetryableOpenFail(err: string | null | undefined): boolean {
  return /rpc_containment_entry_pause|rpc_workload|429|ETIMEDOUT|ECONNRESET|fetch failed|timeout/i.test(
    String(err || '')
  );
}

/** Near-support from last price vs stored S (Mode B / Trend cheap ticks). */
export function recomputeNearSupportFromPrice(w: {
  lastPriceSol?: number | null;
  supportPriceSol?: number | null;
  nearSupport?: boolean;
}): void {
  const px = Number(w.lastPriceSol);
  const s = Number(w.supportPriceSol);
  if (!(px > 0) || !(s > 0)) return;
  const d = (px - s) / s;
  if (d >= -0.02 && d <= 0.035) w.nearSupport = true;
}

export function hasDipFightDna(
  reasons?: string[] | string | null,
  flags?: { nearKeyFib?: boolean; nearSupport?: boolean; nearMultiTfSupport?: boolean }
): boolean {
  const bits = Array.isArray(reasons)
    ? reasons.join(' ')
    : String(reasons || '');
  if (/support_dip_reclaim/i.test(bits)) return true;
  return (
    flags?.nearKeyFib === true ||
    flags?.nearSupport === true ||
    flags?.nearMultiTfSupport === true
  );
}
