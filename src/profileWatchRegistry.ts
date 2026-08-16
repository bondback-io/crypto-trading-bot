/**
 * Per-profile watch inventory projection over family engines (Dip / Mode B / Trend / Grad).
 * Does not own tick loops or extra RPC — family Maps remain source of truth.
 */

import type { TradeProfileId } from './tradeProfiles';
import {
  getMinTaPlaybookConfluences,
  isProfileArmingEnabled,
  isProfileWatchEnabled,
  remapPreferredToMcBandOwner,
  resolveWatchEligibleProfileIds,
  WATCH_FAMILY_PROFILE_IDS,
  type WatchFamilyId,
} from './tradeProfiles';
import { DEFAULT_LATE_CHASE_EXT_PCT } from './supportReclaim';
import { scoreTaConfluence, watchVolumeOkFlag } from './profileTaPlaybook';
import type {
  ConfluenceScore,
  ConfluenceToolResult,
  WatchConfluenceInput,
} from './profileTaPlaybook';
import {
  inferWaitingArmHoldReason,
  isRetryableOpenFail,
  WAITING_OPEN_CONTAINMENT_PAUSE,
} from './watchArmLifecycle';

export type ProfileWatchState =
  | 'watching'
  | 'armed'
  | 'triggered'
  | 'expired'
  | 'invalidated'
  | 'blocked';

export interface ProfileWatchRow {
  mint: string;
  symbol: string;
  name?: string;
  profileId: string;
  status: ProfileWatchState;
  family: WatchFamilyId | 'mirror';
  preferredProfileId?: string | null;
  eligibleProfileIds: string[];
  armedAt?: number | null;
  createdAt?: number;
  lastArmEvalAt?: number | null;
  expiresAt?: number;
  lastReason?: string;
  confluenceCount?: number | null;
  playbookPassed?: string[];
  toolsPassed?: string[];
  toolsEvaluated?: ConfluenceToolResult[];
  minTaPlaybookConfluences?: number | null;
  hardLevelEvidence?: boolean;
  fallbackUsed?: boolean;
  blockedReason?: string;
  source?: string;
  majorsBand?: string;
  marketCapUsd?: number;
  holderCount?: number;
  dropFromPeakPct?: number | null;
  curveProgressPct?: number | null;
  srConfluenceScore?: number | null;
  supportTfHits?: string[] | null;
  dnaHits?: number | null;
  nearKeyFib?: boolean;
  nearSupport?: boolean;
  fib05PriceSol?: number | null;
  fib618PriceSol?: number | null;
  supportPriceSol?: number | null;
  multiTfSupportHits?: number;
  movementActive?: boolean;
  qualityChip?: string;
  isPumpFun?: boolean;
  [key: string]: unknown;
}

export interface ProfileWatchBucket {
  active: number;
  entries: ProfileWatchRow[];
}

export type ProfileWatchInventory = Partial<
  Record<TradeProfileId | string, ProfileWatchBucket>
>;

export type ProfileWatchFunnelKind =
  | 'sent_to_watch'
  | 'armed'
  | 'trigger_ready'
  | 'opened'
  | 'expired'
  | 'blocked'
  | 'arm_timeout'
  | 'trigger_timeout'
  | 'open_fail';

export interface ProfileWatchFunnel {
  sent_to_watch: number;
  armed: number;
  trigger_ready: number;
  opened: number;
  expired: number;
  blocked: Record<string, number>;
  lateChaseArmedOpens: number;
  armedOpens: number;
  zeroMfeArmed: number;
  zeroMfeNonArmed: number;
  arm_timeout: number;
  trigger_timeout: number;
  open_fail: number;
}

const EMPTY_FUNNEL = (): ProfileWatchFunnel => ({
  sent_to_watch: 0,
  armed: 0,
  trigger_ready: 0,
  opened: 0,
  expired: 0,
  blocked: {},
  lateChaseArmedOpens: 0,
  armedOpens: 0,
  zeroMfeArmed: 0,
  zeroMfeNonArmed: 0,
  arm_timeout: 0,
  trigger_timeout: 0,
  open_fail: 0,
});

const funnels = new Map<string, ProfileWatchFunnel>();

function funnelFor(profileId: string): ProfileWatchFunnel {
  const id = String(profileId || '').trim() || 'unknown';
  let row = funnels.get(id);
  if (!row) {
    row = EMPTY_FUNNEL();
    funnels.set(id, row);
  }
  return row;
}

const BLOCKED_DEBOUNCE_MS = 60_000;
const blockedFunnelSeen = new Map<string, number>();

export function noteProfileWatchFunnel(
  profileId: string | null | undefined,
  kind: ProfileWatchFunnelKind,
  blockedReason?: string,
  source?: string | string[] | null,
  mint?: string | null
): void {
  const id = String(profileId || '').trim();
  if (!id) return;
  const row = funnelFor(id);
  if (kind === 'blocked') {
    const reason = String(blockedReason || 'blocked').slice(0, 80);
    const mintKey = String(mint || '').trim();
    if (mintKey) {
      const seenKey = `${id}|${mintKey}|${reason}`;
      const now = Date.now();
      const prev = blockedFunnelSeen.get(seenKey) || 0;
      if (now - prev < BLOCKED_DEBOUNCE_MS) return;
      blockedFunnelSeen.set(seenKey, now);
      if (blockedFunnelSeen.size > 400) {
        for (const [k, ts] of blockedFunnelSeen) {
          if (now - ts > BLOCKED_DEBOUNCE_MS * 2) blockedFunnelSeen.delete(k);
        }
      }
    }
    row.blocked[reason] = (row.blocked[reason] || 0) + 1;
    return;
  }
  const rec = row as unknown as Record<string, number>;
  rec[kind] = (Number(rec[kind]) || 0) + 1;
  try {
    const {
      noteSourceWatchInsert,
      noteSourceArmed,
      noteSourceOpened,
    } = require('./watchPipeline') as typeof import('./watchPipeline');
    if (kind === 'sent_to_watch') noteSourceWatchInsert(source, id);
    else if (kind === 'armed') noteSourceArmed(source, id);
    else if (kind === 'opened') noteSourceOpened(source, id);
  } catch {
    /* optional */
  }
}

export function noteProfileWatchOpenQuality(opts: {
  profileId?: string | null;
  armedWatch?: boolean;
  lateChase?: boolean;
  maxRunupPct?: number | null;
}): void {
  const id = String(opts.profileId || '').trim();
  if (!id) return;
  const row = funnelFor(id);
  if (opts.armedWatch) {
    row.armedOpens += 1;
    if (opts.lateChase) row.lateChaseArmedOpens += 1;
    if ((Number(opts.maxRunupPct) || 0) <= 0.05) row.zeroMfeArmed += 1;
  } else if ((Number(opts.maxRunupPct) || 0) <= 0.05) {
    row.zeroMfeNonArmed += 1;
  }
}

export function getProfileWatchFunnels(): Record<string, ProfileWatchFunnel> {
  const out: Record<string, ProfileWatchFunnel> = {};
  for (const id of PROFILE_ORDER) {
    const row = funnels.get(id) || EMPTY_FUNNEL();
    out[id] = { ...row, blocked: { ...row.blocked } };
  }
  for (const [id, row] of funnels) {
    if (out[id]) continue;
    out[id] = { ...row, blocked: { ...row.blocked } };
  }
  return out;
}

export function getProfileWatchFunnel(
  profileId: string
): ProfileWatchFunnel {
  const row = funnels.get(String(profileId || '').trim());
  return row
    ? { ...row, blocked: { ...row.blocked } }
    : EMPTY_FUNNEL();
}

export interface WatchArmLifecycleCounts {
  park_count: number;
  waiting_arm_count: number;
  arm_count: number;
  trigger_count: number;
  open_count: number;
  arm_timeout_count: number;
  trigger_timeout_count: number;
  open_fail_count: number;
}

export function getWatchArmLifecycleSnapshot(): Record<
  string,
  WatchArmLifecycleCounts
> {
  const inv = getProfileWatchInventory();
  const out: Record<string, WatchArmLifecycleCounts> = {};
  for (const id of PROFILE_ORDER) {
    const f = funnels.get(id) || EMPTY_FUNNEL();
    const entries = inv[id]?.entries || [];
    out[id] = {
      park_count: f.sent_to_watch,
      waiting_arm_count: entries.filter((e) => e.status === 'watching').length,
      arm_count: f.armed,
      trigger_count: f.trigger_ready,
      open_count: f.opened,
      arm_timeout_count: f.arm_timeout || 0,
      trigger_timeout_count: f.trigger_timeout || 0,
      open_fail_count: f.open_fail || 0,
    };
  }
  return out;
}

function lookupLiveWatch(mint: string): {
  family: string;
  profileId: string;
  row: {
    status?: string;
    lastReason?: string;
    nearKeyFib?: boolean;
    nearSupport?: boolean;
    nearMultiTfSupport?: boolean;
    supportTfHits?: unknown;
    supportPriceSol?: number | null;
    volumeState?: string;
    volumeH1Usd?: number;
    volumeM5Usd?: number;
    preferredProfileId?: string | null;
  };
} | null {
  const key = String(mint || '').trim();
  if (!key) return null;
  try {
    const { getDipWatchByMint } =
      require('./dipSetupWatch') as typeof import('./dipSetupWatch');
    const d = getDipWatchByMint(key);
    if (d && (d.status === 'watching' || d.status === 'armed' || d.status === 'triggered')) {
      return {
        family: 'dip',
        profileId: String(d.preferredProfileId || 'dip_buyer'),
        row: d,
      };
    }
  } catch {
    /* optional */
  }
  try {
    const { getScalperWatchByMint } =
      require('./scalperSetupWatch') as typeof import('./scalperSetupWatch');
    const s = getScalperWatchByMint(key);
    if (s && (s.status === 'watching' || s.status === 'armed' || s.status === 'triggered')) {
      const pid = String(s.preferredProfileId || 'scalper');
      const family =
        pid === 'momentum_burst' ? 'mb' : pid === 'reversal_scalper' ? 'reversal' : 'scalper';
      return { family, profileId: pid, row: s };
    }
  } catch {
    /* optional */
  }
  try {
    const { getTrendWatchByMint } =
      require('./trendSetupWatch') as typeof import('./trendSetupWatch');
    const t = getTrendWatchByMint(key);
    if (t && (t.status === 'watching' || t.status === 'armed' || t.status === 'triggered')) {
      return { family: 'trend', profileId: 'trend_rider', row: t };
    }
  } catch {
    /* optional */
  }
  try {
    const { getGradWatchByMint } =
      require('./migrationGradWatch') as typeof import('./migrationGradWatch');
    const g = getGradWatchByMint(key);
    if (g && (g.status === 'watching' || g.status === 'armed' || g.status === 'triggered')) {
      return { family: 'migration', profileId: 'migration_sniper', row: g };
    }
  } catch {
    /* optional */
  }
  return null;
}

export function getOwnedWatchHoldReason(mint: string): string | null {
  const found = lookupLiveWatch(mint);
  if (!found) return null;
  return inferWaitingArmHoldReason(found.row);
}

export function formatOwnedWatchWaitingArm(
  family: string,
  mint: string
): string {
  const hold = getOwnedWatchHoldReason(mint);
  const base = `owned_${family}_watch: waiting arm`;
  return hold ? `${base} (${hold})` : base;
}

type MutWatch = {
  status: string;
  updatedAt: number;
  lastReason?: string;
  armedAt?: number | null;
  preferredProfileId?: string | null;
};

function mutateLiveWatch(
  mint: string,
  fn: (w: MutWatch, profileId: string) => void
): boolean {
  const found = lookupLiveWatch(mint);
  if (!found) return false;
  fn(found.row as MutWatch, found.profileId);
  return true;
}

/**
 * Queued handoff marked triggered before executeBuy. On containment / retryable
 * fail, restore armed. On hard fail, expire with open_fail reason.
 */
export function revertArmedWatchOpenFail(
  mint: string,
  err: string | null | undefined
): { ok: boolean; action: 'rearmed' | 'expired' | 'none' } {
  const key = String(mint || '').trim();
  if (!key) return { ok: false, action: 'none' };
  const retry = isRetryableOpenFail(err);
  const now = Date.now();
  let action: 'rearmed' | 'expired' | 'none' = 'none';
  mutateLiveWatch(key, (w, pid) => {
    if (w.status !== 'triggered' && w.status !== 'armed') return;
    if (retry) {
      w.status = 'armed';
      w.updatedAt = now;
      w.lastReason = WAITING_OPEN_CONTAINMENT_PAUSE;
      if (w.armedAt == null) w.armedAt = now;
      action = 'rearmed';
      noteProfileWatchFunnel(pid, 'blocked', WAITING_OPEN_CONTAINMENT_PAUSE, undefined, key);
    } else {
      w.status = 'expired';
      w.updatedAt = now;
      w.lastReason = `open_fail:${String(err || 'executeBuy failed').slice(0, 60)}`;
      action = 'expired';
      noteProfileWatchFunnel(pid, 'open_fail', undefined, undefined, key);
    }
  });
  return { ok: action !== 'none', action };
}

function asState(status: unknown): ProfileWatchState {
  const s = String(status || 'watching');
  if (
    s === 'watching' ||
    s === 'armed' ||
    s === 'triggered' ||
    s === 'expired' ||
    s === 'invalidated' ||
    s === 'blocked'
  ) {
    return s;
  }
  return 'watching';
}

function isActiveStatus(status: ProfileWatchState): boolean {
  return status === 'watching' || status === 'armed';
}

function rowFromFamily(
  family: WatchFamilyId,
  raw: Record<string, unknown>,
  profileId: string,
  eligible: string[]
): ProfileWatchRow {
  const mint = String(raw.mint || '').trim();
  return {
    ...raw,
    mint,
    symbol: String(raw.symbol || mint.slice(0, 6)),
    name: raw.name != null ? String(raw.name) : undefined,
    profileId,
    status: asState(raw.status),
    family,
    preferredProfileId:
      raw.preferredProfileId != null ? String(raw.preferredProfileId) : null,
    eligibleProfileIds: eligible,
    armedAt: (raw.armedAt as number | null | undefined) ?? null,
    createdAt: Number(raw.createdAt) || undefined,
    lastArmEvalAt:
      raw.lastArmEvalAt != null && Number.isFinite(Number(raw.lastArmEvalAt))
        ? Number(raw.lastArmEvalAt)
        : undefined,
    expiresAt: Number(raw.expiresAt) || undefined,
    lastReason: raw.lastReason != null ? String(raw.lastReason) : undefined,
    confluenceCount:
      raw.confluenceCount != null && Number.isFinite(Number(raw.confluenceCount))
        ? Number(raw.confluenceCount)
        : null,
    playbookPassed: Array.isArray(raw.playbookPassed)
      ? (raw.playbookPassed as string[])
      : Array.isArray(raw.toolsPassed)
        ? (raw.toolsPassed as string[])
        : undefined,
    toolsPassed: Array.isArray(raw.toolsPassed)
      ? (raw.toolsPassed as string[])
      : Array.isArray(raw.playbookPassed)
        ? (raw.playbookPassed as string[])
        : undefined,
    toolsEvaluated: Array.isArray(raw.toolsEvaluated)
      ? (raw.toolsEvaluated as ConfluenceToolResult[])
      : undefined,
    minTaPlaybookConfluences:
      raw.minTaPlaybookConfluences != null &&
      Number.isFinite(Number(raw.minTaPlaybookConfluences))
        ? Number(raw.minTaPlaybookConfluences)
        : getMinTaPlaybookConfluences(profileId),
    hardLevelEvidence: raw.hardLevelEvidence === true,
    fallbackUsed: raw.fallbackUsed === true,
    blockedReason:
      raw.triggerBlockReason != null
        ? String(raw.triggerBlockReason)
        : raw.blockedReason != null
          ? String(raw.blockedReason)
          : undefined,
  };
}

function profilesForFamilyRow(
  family: WatchFamilyId,
  raw: Record<string, unknown>
): string[] {
  const tagged = Array.isArray(raw.eligibleProfileIds)
    ? (raw.eligibleProfileIds as unknown[]).map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  if (tagged.length) return tagged;
  const pref = String(raw.preferredProfileId || '').trim();
  const familyIds = [...WATCH_FAMILY_PROFILE_IDS[family]];
  if (pref && (familyIds as string[]).includes(pref) && family !== 'dip') return [pref];
  try {
    return resolveWatchEligibleProfileIds({
      family,
      preferredProfileId: pref || null,
      dipQualityPark:
        family === 'dip' &&
        (String(raw.source || '') === 'majors' ||
          String(raw.source || '') === 'medium'),
      marketCapUsd:
        raw.marketCapUsd != null ? Number(raw.marketCapUsd) : null,
      source: raw.source != null ? String(raw.source) : undefined,
      liquidityUsd:
        raw.liquidityUsd != null ? Number(raw.liquidityUsd) : null,
      volumeH1Usd:
        raw.volumeH1Usd != null ? Number(raw.volumeH1Usd) : null,
      holderCount:
        raw.holderCount != null ? Number(raw.holderCount) : null,
      nearKeyFib: raw.nearKeyFib === true,
      nearSupport: raw.nearSupport === true,
      dropFromPeakPct:
        raw.dropFromPeakPct != null ? Number(raw.dropFromPeakPct) : null,
      symbol: raw.symbol != null ? String(raw.symbol) : null,
      name: raw.name != null ? String(raw.name) : null,
    });
  } catch {
    return pref ? [pref] : familyIds.slice(0, 1);
  }
}

const PROFILE_ORDER: string[] = [
  'dip_buyer',
  'steady_compounder',
  'high_win_rate',
  'scalper',
  'momentum_burst',
  'reversal_scalper',
  'trend_rider',
  'migration_sniper',
  'smart_money_mirror',
];

function emptyInventory(): ProfileWatchInventory {
  const out: ProfileWatchInventory = {};
  for (const id of PROFILE_ORDER) {
    out[id] = { active: 0, entries: [] };
  }
  return out;
}

/**
 * Project family watch statuses into per-profile buckets.
 * Same mint may appear under every eligible profile.
 */
export function getProfileWatchInventory(): ProfileWatchInventory {
  const out = emptyInventory();

  const push = (
    family: WatchFamilyId,
    entries: unknown[],
    terminal?: unknown[]
  ) => {
    const all = [...(entries || []), ...(terminal || [])];
    for (const rawUnknown of all) {
      const raw = (rawUnknown || {}) as Record<string, unknown>;
      const mint = String(raw.mint || '').trim();
      if (!mint) continue;
      const eligible = profilesForFamilyRow(family, raw);
      for (const profileId of eligible) {
        const bucket = out[profileId] || { active: 0, entries: [] };
        const row = rowFromFamily(family, raw, profileId, eligible);
        if (isActiveStatus(row.status) && row.fallbackUsed !== true) {
          try {
            const score = scoreTaConfluence({
              profileId,
              watch: raw as WatchConfluenceInput,
            });
            row.confluenceCount = score.confluenceCount;
            row.playbookPassed = score.passedIds;
            row.toolsPassed = score.passedIds;
            row.toolsEvaluated = score.toolsEvaluated;
            row.hardLevelEvidence = score.hardLevelEvidence;
            row.minTaPlaybookConfluences = getMinTaPlaybookConfluences(profileId);
          } catch {
            /* keep stamped */
          }
        }
        bucket.entries.push(row);
        if (isActiveStatus(row.status)) bucket.active += 1;
        out[profileId] = bucket;
      }
    }
  };

  try {
    const { getDipSetupWatchStatus } =
      require('./dipSetupWatch') as typeof import('./dipSetupWatch');
    const dw = getDipSetupWatchStatus(200);
    push('dip', dw.entries || [], dw.recentTerminal || []);
  } catch {
    /* optional */
  }
  try {
    const { getScalperSetupWatchStatus } =
      require('./scalperSetupWatch') as typeof import('./scalperSetupWatch');
    const sw = getScalperSetupWatchStatus(40);
    push('scalper', sw.entries || [], sw.recentTerminal || []);
  } catch {
    /* optional */
  }
  try {
    const { getTrendSetupWatchStatus } =
      require('./trendSetupWatch') as typeof import('./trendSetupWatch');
    const tw = getTrendSetupWatchStatus(24);
    push('trend', tw.entries || [], tw.recentTerminal || []);
  } catch {
    /* optional */
  }
  try {
    const { getMigrationGradWatchStatus } =
      require('./migrationGradWatch') as typeof import('./migrationGradWatch');
    const gw = getMigrationGradWatchStatus(24);
    push('grad', gw.entries || [], gw.recentTerminal || []);
  } catch {
    /* optional */
  }

  return out;
}

export interface WatchTriggerConfluenceInput {
  profileId?: string | null;
  nearSupport?: boolean | null;
  nearKeyFib?: boolean | null;
  nearResistance?: boolean | null;
  nearMultiTfSupport?: boolean | null;
  nearMultiTfResistance?: boolean | null;
  srConfluenceScore?: number | null;
  supportTfHits?: string[] | null;
  chartPatternIds?: string[] | null;
  volumeExpanding?: boolean | null;
  volOk?: boolean | null;
  volumeState?: string | null;
  nearLevel?: boolean | null;
  touchedLevel?: boolean | null;
  hasLevel?: boolean | null;
  nearFib?: boolean | null;
  lateChase?: boolean | null;
  armedLateChase?: boolean | null;
  extensionFromLevelPct?: number | null;
  status?: string | null;
  armed?: boolean | null;
  mint?: string | null;
}

export interface WatchTriggerConfluenceResult {
  ok: boolean;
  count: number;
  minRequired: number;
  passed: string[];
  reason: string;
  score?: ConfluenceScore;
}

export type WatchConfluenceStamp = {
  preferredProfileId?: string | null;
  nearSupport?: boolean | null;
  nearKeyFib?: boolean | null;
  nearFib?: boolean | null;
  nearMultiTfSupport?: boolean | null;
  nearMultiTfResistance?: boolean | null;
  nearLevel?: boolean | null;
  touchedLevel?: boolean | null;
  hasLevel?: boolean | null;
  volOk?: boolean | null;
  volumeState?: string | null;
  volumeExpanding?: boolean | null;
  srConfluenceScore?: number | null;
  supportTfHits?: string[] | null;
  chartPatternIds?: string[] | null;
  lateChase?: boolean | null;
  armedLateChase?: boolean | null;
  extensionFromLevelPct?: number | null;
  status?: string | null;
  armed?: boolean | null;
  mint?: string | null;
  confluenceCount?: number | null;
  playbookPassed?: string[];
  toolsPassed?: string[];
  toolsEvaluated?: ConfluenceToolResult[];
  minTaPlaybookConfluences?: number | null;
  hardLevelEvidence?: boolean;
  fallbackUsed?: boolean;
  triggerBlockReason?: string;
  lastReason?: string;
};

function stampConfluenceScore(
  entry: WatchConfluenceStamp,
  score: ConfluenceScore,
  profileId: string
): void {
  entry.confluenceCount = score.confluenceCount;
  entry.playbookPassed = score.passedIds;
  entry.toolsPassed = score.passedIds;
  entry.toolsEvaluated = score.toolsEvaluated;
  entry.hardLevelEvidence = score.hardLevelEvidence;
  entry.fallbackUsed = score.fallbackUsed === true;
  entry.minTaPlaybookConfluences = getMinTaPlaybookConfluences(profileId);
}

export const ARMED_LATE_CHASE_BLOCK = 'armed_late_chase_blocked';

export function canTriggerArmed(opts: {
  profileId: string;
  score: ConfluenceScore;
  watch: WatchConfluenceInput;
}): { ok: boolean; reason: string; score: ConfluenceScore } {
  const watch = opts.watch || {};
  const score = opts.score;
  const status = String(watch.status || '').toLowerCase();
  const armed = watch.armed === true || status === 'armed';
  if (!armed && status && status !== 'armed') {
    return { ok: false, reason: 'not_armed', score };
  }
  if (score.lateChase) {
    return { ok: false, reason: ARMED_LATE_CHASE_BLOCK, score };
  }
  const min = getMinTaPlaybookConfluences(opts.profileId);
  if (min <= 0) return { ok: true, reason: 'min_confluence_off', score };
  if (score.confluenceCount >= min) {
    return { ok: true, reason: 'confluence_met', score };
  }
  const hasLevel =
    score.hardLevelEvidence ||
    watch.nearSupport === true ||
    watch.hasLevel === true ||
    watch.nearMultiTfSupport === true ||
    watch.nearLevel === true ||
    watch.touchedLevel === true ||
    (Number(watch.supportPriceSol) > 0 &&
      Number.isFinite(Number(watch.supportPriceSol))) ||
    (Array.isArray(watch.supportTfHits) && watch.supportTfHits.length >= 1);
  if (hasLevel && !score.lateChase) {
    const extraFib =
      watch.nearFib === true || watch.nearKeyFib === true ? 1 : 0;
    const extraVol = watchVolumeOkFlag(watch) ? 1 : 0;
    const withLevel = Math.max(score.confluenceCount, 1 + extraFib + extraVol);
    if (withLevel >= min) {
      return {
        ok: true,
        reason: 'confluence_fallback_level_evidence',
        score: {
          ...score,
          confluenceCount: withLevel,
          fallbackUsed: true,
        },
      };
    }
    if (score.confluenceCount === 0) {
      return {
        ok: false,
        reason: `need ${min} TA confluences (have ${withLevel})`,
        score: {
          ...score,
          confluenceCount: withLevel,
          fallbackUsed: true,
        },
      };
    }
  }
  return {
    ok: false,
    reason: `need ${min} TA confluences (have ${score.confluenceCount})`,
    score,
  };
}

/**
 * Trigger-time integer confluence gate. Same ConfluenceScore as UI.
 * Does not replace playbook minConfluenceScore / Hard mode on the buy path.
 */
export function evaluateWatchTriggerConfluence(
  input: WatchTriggerConfluenceInput
): WatchTriggerConfluenceResult {
  const profileId = String(input.profileId || '').trim();
  const minRequired = getMinTaPlaybookConfluences(profileId);
  const score = scoreTaConfluence({
    profileId,
    watch: input,
  });
  const gate = canTriggerArmed({
    profileId,
    score,
    watch: { ...input, status: input.status || 'armed', armed: true },
  });
  return {
    ok: gate.ok,
    count: gate.score.confluenceCount,
    minRequired,
    passed: gate.score.passedIds,
    reason: gate.reason,
    score: gate.score,
  };
}

/**
 * When Arming is ON, unarmed scanner/copy assignment must park instead of open.
 * Armed watch handoffs and Arming OFF (legacy spot) pass through.
 */
export function shouldParkUnarmedOpen(opts: {
  profileId?: string | null;
  armedWatch?: boolean;
  reentry?: boolean;
}): { park: boolean; reason: string } {
  if (opts.reentry === true) {
    return { park: false, reason: 'reentry' };
  }
  if (opts.armedWatch === true) {
    return { park: false, reason: 'armed_handoff' };
  }
  const id = String(opts.profileId || '').trim();
  if (!id || id === 'default' || id === 'zion') {
    return { park: false, reason: 'no_arming_profile' };
  }
  if (!isProfileWatchEnabled(id)) {
    return { park: false, reason: 'watch_off' };
  }
  if (!isProfileArmingEnabled(id)) {
    return { park: false, reason: 'arming_off' };
  }
  return {
    park: true,
    reason: `Arming ON — ${id} waits for watch→arm→trigger`,
  };
}

/**
 * Precise park-failed copy: watch_off, or last Dip/Scalper admit reject.
 * Never a silent false.
 */
export function formatArmingParkFailedReason(
  profileId: string | null | undefined
): string {
  const pid = String(profileId || '').trim();
  if (pid && !isProfileWatchEnabled(pid)) {
    return `Arming ON — watch_off for ${pid}`;
  }
  let why = 'admit_failed';
  try {
    if (
      pid === 'dip_buyer' ||
      pid === 'steady_compounder' ||
      pid === 'high_win_rate'
    ) {
      const { getLastDipAdmitReject } =
        require('./dipSetupWatch') as typeof import('./dipSetupWatch');
      why = getLastDipAdmitReject() || why;
    } else if (
      pid === 'scalper' ||
      pid === 'momentum_burst' ||
      pid === 'reversal_scalper'
    ) {
      const { getLastScalperAdmitReject } =
        require('./scalperSetupWatch') as typeof import('./scalperSetupWatch');
      why = getLastScalperAdmitReject() || why;
    }
  } catch {
    /* keep admit_failed */
  }
  return `Arming ON — park failed for ${pid || 'profile'} (${why})`;
}

/** Stamp eligibleProfileIds on a family watch row (exclusive Steady/HWR). */
export function stampEligibleOnWatchEntry(
  family: WatchFamilyId,
  entry: {
    preferredProfileId?: string | null;
    source?: string;
    marketCapUsd?: number | null;
    eligibleProfileIds?: string[];
    liquidityUsd?: number | null;
    volumeH1Usd?: number | null;
    holderCount?: number | null;
    top10HoldPct?: number | null;
    nearKeyFib?: boolean;
    nearSupport?: boolean;
    dropFromPeakPct?: number | null;
    supportPriceSol?: number | null;
    fib05PriceSol?: number | null;
    fib618PriceSol?: number | null;
    multiTfSupportHits?: number;
    priceChangeH1Pct?: number | null;
    priceChangeH6Pct?: number | null;
    priceChange24hPct?: number | null;
    tokenAgeHours?: number | null;
    symbol?: string | null;
    name?: string | null;
    exclusiveRouteReason?: string;
  }
): string[] {
  const ids = resolveWatchEligibleProfileIds({
    family,
    preferredProfileId: entry.preferredProfileId,
    dipQualityPark:
      family === 'dip' &&
      (String(entry.source || '') === 'majors' ||
        String(entry.source || '') === 'medium'),
    marketCapUsd: entry.marketCapUsd,
    source: entry.source,
    liquidityUsd: entry.liquidityUsd,
    volumeH1Usd: entry.volumeH1Usd,
    holderCount: entry.holderCount,
    top10HoldPct: entry.top10HoldPct,
    nearKeyFib: entry.nearKeyFib,
    nearSupport: entry.nearSupport,
    dropFromPeakPct: entry.dropFromPeakPct,
    supportPriceSol: entry.supportPriceSol,
    fib05PriceSol: entry.fib05PriceSol,
    fib618PriceSol: entry.fib618PriceSol,
    multiTfSupportHits: entry.multiTfSupportHits,
    priceChangeH1Pct: entry.priceChangeH1Pct,
    priceChangeH6Pct: entry.priceChangeH6Pct,
    priceChange24hPct: entry.priceChange24hPct,
    tokenAgeHours: entry.tokenAgeHours,
    symbol: entry.symbol,
    name: entry.name,
  });
  entry.eligibleProfileIds = ids;
  if (family === 'dip' && ids.length === 1) {
    const only = ids[0];
    if (
      only === 'steady_compounder' ||
      only === 'high_win_rate' ||
      only === 'dip_buyer'
    ) {
      entry.preferredProfileId = only;
    }
  }
  return ids;
}

export function keepWatchTerminalForUi(opts: {
  status: string;
  mint: string;
  updatedAt: number;
  now?: number;
  terminalMs: number;
}): boolean {
  const st = String(opts.status || '');
  if (st !== 'triggered' && st !== 'expired' && st !== 'invalidated') {
    return false;
  }
  const now = opts.now ?? Date.now();
  if (now - opts.updatedAt <= opts.terminalMs) return true;
  return st === 'triggered' && mintHasOpenPaperOrLiveTrade(opts.mint);
}

export function mintHasOpenPaperOrLiveTrade(mint: string): boolean {
  try {
    const { paperTrader } =
      require('./paperTrader') as typeof import('./paperTrader');
    const key = String(mint || '').trim().toLowerCase();
    if (!key) return false;
    return (paperTrader.getOpenPositions() || []).some(
      (p) =>
        p &&
        p.status !== 'closed' &&
        String(p.mint || '').trim().toLowerCase() === key
    );
  } catch {
    return false;
  }
}

/** Apply trigger confluence onto a watch row. Returns false when the count gate blocks. */
export function applyTriggerConfluenceToWatch(
  profileId: string | null | undefined,
  entry: WatchConfluenceStamp,
  extra?: {
    lateChase?: boolean;
    extensionFromLevelPct?: number | null;
    status?: string | null;
    armed?: boolean;
  }
): boolean {
  const pid = String(profileId || entry.preferredProfileId || '').trim();
  try {
    const watch: WatchConfluenceInput = {
      ...entry,
      lateChase: extra?.lateChase ?? entry.lateChase,
      extensionFromLevelPct:
        extra?.extensionFromLevelPct ?? entry.extensionFromLevelPct,
      status: extra?.status ?? entry.status,
      armed: extra?.armed ?? entry.armed,
    };
    const score = scoreTaConfluence({ profileId: pid, watch });
    const gate = canTriggerArmed({ profileId: pid, score, watch });
    stampConfluenceScore(entry, gate.score, pid);
    if (String(watch.status || '').toLowerCase() === 'armed' || watch.armed === true) {
      try {
        const { logger } = require('./logger') as typeof import('./logger');
        logger.info('ta_confluence', 'armed eval', {
          mint: watch.mint,
          profile: pid,
          min: getMinTaPlaybookConfluences(pid),
          have: gate.score.confluenceCount,
          passed: gate.score.passedIds,
          hardLevelEvidence: gate.score.hardLevelEvidence,
          lateChase: gate.score.lateChase,
        });
      } catch {
        /* optional */
      }
    }
    if (!gate.ok) {
      entry.triggerBlockReason = gate.reason;
      entry.lastReason = gate.reason;
      noteProfileWatchFunnel(pid, 'blocked', gate.reason, undefined, watch.mint);
      try {
        const { noteTriggerOpenBlocked } =
          require('./watchPipeline') as typeof import('./watchPipeline');
        noteTriggerOpenBlocked(gate.reason || 'confluence');
      } catch {
        /* optional */
      }
      return false;
    }
    entry.triggerBlockReason = undefined;
    noteProfileWatchFunnel(pid, 'trigger_ready');
    try {
      const { noteTriggerReady } =
        require('./watchPipeline') as typeof import('./watchPipeline');
      noteTriggerReady();
    } catch {
      /* optional */
    }
    return true;
  } catch {
    /* fail-closed on confluence eval throw */
    entry.triggerBlockReason = 'confluence_eval_error';
    noteProfileWatchFunnel(pid, 'blocked', 'confluence_eval_error', undefined, entry.mint);
    return false;
  }
}

export function isExtensionLateChase(
  lateChase?: boolean,
  extensionFromLevelPct?: number | null
): boolean {
  if (lateChase === true) return true;
  const ext = Number(extensionFromLevelPct);
  return Number.isFinite(ext) && ext >= DEFAULT_LATE_CHASE_EXT_PCT;
}

function noteTriggerBlock(profileId: string, reason: string, mint?: string | null): void {
  noteProfileWatchFunnel(profileId, 'blocked', reason, undefined, mint);
  try {
    const { noteTriggerOpenBlocked } =
      require('./watchPipeline') as typeof import('./watchPipeline');
    noteTriggerOpenBlocked(reason);
  } catch {
    /* optional */
  }
}

/**
 * Last-step gate before armed handoff/open: still armed, not late-chase,
 * live MC remap (MS-over-max → Scalper), then TA confluence.
 * Confluence eval throw fail-closes; a real min-TA miss still blocks.
 */
export function prepareArmedWatchOpen(opts: {
  profileId: string;
  status?: string | null;
  marketCapUsd?: number | null;
  lateChase?: boolean;
  extensionFromLevelPct?: number | null;
  nearLevel?: boolean;
  entry: Parameters<typeof applyTriggerConfluenceToWatch>[1];
}): {
  ok: boolean;
  profileId: string;
  action?: 'keep_watching' | 'expire';
  reason?: string;
} {
  let pid = remapPreferredToMcBandOwner(opts.profileId, opts.marketCapUsd);
  const status = String(opts.status || '').toLowerCase();
  if (status && status !== 'armed') {
    noteTriggerBlock(
      pid,
      'trigger_not_armed',
      (opts.entry as { mint?: string }).mint
    );
    return { ok: false, profileId: pid, reason: 'trigger_not_armed' };
  }
  if (isExtensionLateChase(opts.lateChase, opts.extensionFromLevelPct)) {
    noteTriggerBlock(pid, ARMED_LATE_CHASE_BLOCK);
    return {
      ok: false,
      profileId: pid,
      action: opts.nearLevel ? 'keep_watching' : 'expire',
      reason: ARMED_LATE_CHASE_BLOCK,
    };
  }
  try {
    if (
      !applyTriggerConfluenceToWatch(pid, opts.entry, {
        lateChase: opts.lateChase,
        extensionFromLevelPct: opts.extensionFromLevelPct,
        status: opts.status || 'armed',
        armed: true,
      })
    ) {
      return {
        ok: false,
        profileId: pid,
        reason:
          (opts.entry as { triggerBlockReason?: string }).triggerBlockReason ||
          'confluence',
      };
    }
  } catch {
    /* fail-closed on confluence eval throw */
    return {
      ok: false,
      profileId: pid,
      reason: 'confluence_eval_error',
    };
  }
  return { ok: true, profileId: pid };
}

/** Offer a parked mint onto the family watch that serves this profile. */
export function parkSignalOnProfileWatch(opts: {
  profileId?: string | null;
  mint: string;
  symbol?: string;
  name?: string;
  marketCapUsd?: number | null;
  volumeH1Usd?: number | null;
  volumeM5Usd?: number | null;
  holderCount?: number | null;
  nearKeyFib?: boolean;
  nearSupport?: boolean;
  nearMultiTfSupport?: boolean;
  srConfluenceScore?: number | null;
  supportTfHits?: string[] | null;
  curveProgressPct?: number | null;
  dropFromPeakPct?: number | null;
  lastPriceSol?: number | null;
  supportPriceSol?: number | null;
  fib05PriceSol?: number | null;
  fib618PriceSol?: number | null;
  volumeState?: string | null;
  priceChangeH1Pct?: number | null;
  scannerReasons?: string[] | string | null;
}): boolean {
  const pid = String(opts.profileId || '').trim();
  const mint = String(opts.mint || '').trim();
  if (!mint) return false;
  if (pid && !isProfileWatchEnabled(pid)) {
    try {
      const { noteWatchInsertReject } =
        require('./watchPipeline') as typeof import('./watchPipeline');
      noteWatchInsertReject('watch_off');
    } catch {
      /* optional */
    }
    return false;
  }
  try {
    if (
      pid === 'dip_buyer' ||
      pid === 'steady_compounder' ||
      pid === 'high_win_rate'
    ) {
      let specialtyFeed: string | undefined;
      if (pid === 'steady_compounder' || pid === 'high_win_rate') {
        try {
          const { universeWatchBand } =
            require('./majorsUniverse') as typeof import('./majorsUniverse');
          const mc = Number(opts.marketCapUsd);
          specialtyFeed = universeWatchBand(mc) || 'medium';
        } catch {
          specialtyFeed = 'medium';
        }
      }
      const { offerDipWatchFromCandidate } =
        require('./dipSetupWatch') as typeof import('./dipSetupWatch');
      const ok = offerDipWatchFromCandidate({
        mint,
        symbol: opts.symbol || mint.slice(0, 6),
        name: opts.name,
        marketCapUsd: opts.marketCapUsd ?? undefined,
        volumeH1Usd: opts.volumeH1Usd ?? undefined,
        holderCount: opts.holderCount ?? undefined,
        nearKeyFib: opts.nearKeyFib,
        nearSupport: opts.nearSupport,
        dropFromPeakPct: opts.dropFromPeakPct,
        priceChangeH1Pct: opts.priceChangeH1Pct ?? undefined,
        preferredProfileId: pid,
        lastPriceSol: opts.lastPriceSol ?? undefined,
        supportPriceSol: opts.supportPriceSol ?? undefined,
        fib05PriceSol: opts.fib05PriceSol ?? undefined,
        fib618PriceSol: opts.fib618PriceSol ?? undefined,
        specialtyFeed,
        scannerReasons: opts.scannerReasons,
      });
      if (!ok) {
        try {
          const { noteWatchInsertReject } =
            require('./watchPipeline') as typeof import('./watchPipeline');
          noteWatchInsertReject('park_unverified');
        } catch {
          /* optional */
        }
      }
      return Boolean(ok);
    }
    if (
      pid === 'scalper' ||
      pid === 'momentum_burst' ||
      pid === 'reversal_scalper'
    ) {
      const { offerScalperWatchFromCandidate } =
        require('./scalperSetupWatch') as typeof import('./scalperSetupWatch');
      return offerScalperWatchFromCandidate({
        mint,
        symbol: opts.symbol || mint.slice(0, 6),
        name: opts.name,
        marketCapUsd: opts.marketCapUsd ?? undefined,
        volumeH1Usd: opts.volumeH1Usd ?? undefined,
        volumeM5Usd: opts.volumeM5Usd ?? undefined,
        holderCount: opts.holderCount ?? undefined,
        nearKeyFib: opts.nearKeyFib,
        nearSupport: opts.nearSupport,
        nearMultiTfSupport: opts.nearMultiTfSupport,
        srConfluenceScore: opts.srConfluenceScore ?? undefined,
        supportTfHits: opts.supportTfHits as import('./technicalLevels').SrTimeframe[] | undefined,
        lastPriceSol: opts.lastPriceSol ?? undefined,
        supportPriceSol: opts.supportPriceSol ?? undefined,
        preferredProfileId: pid,
      });
    }
    if (pid === 'trend_rider') {
      const { offerTrendWatchFromCandidate } =
        require('./trendSetupWatch') as typeof import('./trendSetupWatch');
      return offerTrendWatchFromCandidate({
        mint,
        symbol: opts.symbol || mint.slice(0, 6),
        name: opts.name,
        marketCapUsd: opts.marketCapUsd ?? undefined,
        volumeH1Usd: opts.volumeH1Usd ?? undefined,
        holderCount: opts.holderCount ?? undefined,
        nearKeyFib: opts.nearKeyFib,
        nearSupport: opts.nearSupport,
      });
    }
    if (pid === 'migration_sniper' || pid === 'migration') {
      const { offerMigrationGradWatchFromCandidate } =
        require('./migrationGradWatch') as typeof import('./migrationGradWatch');
      return Boolean(
        offerMigrationGradWatchFromCandidate({
          mint,
          symbol: opts.symbol || mint.slice(0, 6),
          name: opts.name,
          marketCapUsd: opts.marketCapUsd ?? undefined,
          volumeH1Usd: opts.volumeH1Usd ?? undefined,
          holderCount: opts.holderCount ?? undefined,
          curveProgressPct: opts.curveProgressPct,
        })
      );
    }
  } catch {
    return false;
  }
  return false;
}

/** Cheap proximity / vol-ok / hold-reason refresh. Does not expire or disarm. */
export function reevaluateWatchArmsCheap(): {
  ok: true;
  rows: number;
} {
  let rows = 0;
  try {
    const { reevaluateDipWatchArmsCheap } =
      require('./dipSetupWatch') as typeof import('./dipSetupWatch');
    rows += reevaluateDipWatchArmsCheap();
  } catch {
    /* */
  }
  try {
    const { reevaluateScalperWatchArmsCheap } =
      require('./scalperSetupWatch') as typeof import('./scalperSetupWatch');
    rows += reevaluateScalperWatchArmsCheap();
  } catch {
    /* */
  }
  try {
    const { reevaluateTrendWatchArmsCheap } =
      require('./trendSetupWatch') as typeof import('./trendSetupWatch');
    rows += reevaluateTrendWatchArmsCheap();
  } catch {
    /* */
  }
  try {
    const { reevaluateGradWatchArmsCheap } =
      require('./migrationGradWatch') as typeof import('./migrationGradWatch');
    rows += reevaluateGradWatchArmsCheap();
  } catch {
    /* */
  }
  return { ok: true, rows };
}
