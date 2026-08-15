/**
 * Per-profile watch inventory projection over family engines (Dip / Mode B / Trend / Grad).
 * Does not own tick loops or extra RPC — family Maps remain source of truth.
 */

import type { TradeProfileId } from './tradeProfiles';
import {
  getMinTaPlaybookConfluences,
  isProfileArmingEnabled,
  isProfileWatchEnabled,
  resolveWatchEligibleProfileIds,
  WATCH_FAMILY_PROFILE_IDS,
  type WatchFamilyId,
} from './tradeProfiles';
import { countPassedTools, evaluateProfileTaEntry } from './profileTaPlaybook';
import type { ProfileTaEntryContext } from './profileTaPlaybook';

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
  expiresAt?: number;
  lastReason?: string;
  confluenceCount?: number | null;
  playbookPassed?: string[];
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
  | 'blocked';

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

export function noteProfileWatchFunnel(
  profileId: string | null | undefined,
  kind: ProfileWatchFunnelKind,
  blockedReason?: string
): void {
  const id = String(profileId || '').trim();
  if (!id) return;
  const row = funnelFor(id);
  if (kind === 'blocked') {
    const reason = String(blockedReason || 'blocked').slice(0, 80);
    row.blocked[reason] = (row.blocked[reason] || 0) + 1;
    return;
  }
  row[kind] += 1;
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
    expiresAt: Number(raw.expiresAt) || undefined,
    lastReason: raw.lastReason != null ? String(raw.lastReason) : undefined,
    confluenceCount:
      raw.confluenceCount != null && Number.isFinite(Number(raw.confluenceCount))
        ? Number(raw.confluenceCount)
        : null,
    playbookPassed: Array.isArray(raw.playbookPassed)
      ? (raw.playbookPassed as string[])
      : undefined,
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
}

export interface WatchTriggerConfluenceResult {
  ok: boolean;
  count: number;
  minRequired: number;
  passed: string[];
  reason: string;
}

/**
 * Trigger-time integer confluence gate. 0 = off. Fail-open on throw.
 * Does not replace playbook minConfluenceScore / Hard mode on the buy path.
 */
export function evaluateWatchTriggerConfluence(
  input: WatchTriggerConfluenceInput
): WatchTriggerConfluenceResult {
  const profileId = String(input.profileId || '').trim();
  const minRequired = getMinTaPlaybookConfluences(profileId);
  if (minRequired <= 0) {
    return {
      ok: true,
      count: 0,
      minRequired: 0,
      passed: [],
      reason: 'confluence off',
    };
  }
  try {
    const { getProfileTaPlaybook } =
      require('./profileTaPlaybookStore') as typeof import('./profileTaPlaybookStore');
    const playbook = getProfileTaPlaybook(profileId);
    const ctx: ProfileTaEntryContext = {
      nearSupport: input.nearSupport === true,
      nearKeyFib: input.nearKeyFib === true,
      nearResistance: input.nearResistance === true,
      nearMultiTfSupport: input.nearMultiTfSupport === true,
      nearMultiTfResistance: input.nearMultiTfResistance === true,
      srConfluenceScore: input.srConfluenceScore,
      supportTfHits: input.supportTfHits,
      chartPatternIds: input.chartPatternIds,
      volumeExpanding: input.volumeExpanding === true,
    };
    const result = evaluateProfileTaEntry(playbook, ctx);
    const count = countPassedTools(result);
    const passed = result.passed.map(String);
    if (count >= minRequired) {
      return {
        ok: true,
        count,
        minRequired,
        passed,
        reason: `${count}/${minRequired} TA tools`,
      };
    }
    return {
      ok: false,
      count,
      minRequired,
      passed,
      reason: `need ${minRequired} TA confluences (have ${count})`,
    };
  } catch {
    return {
      ok: true,
      count: 0,
      minRequired,
      passed: [],
      reason: 'confluence eval fail-open',
    };
  }
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
  if (!isProfileWatchEnabled(id) || !isProfileArmingEnabled(id)) {
    return { park: false, reason: 'arming_off' };
  }
  return {
    park: true,
    reason: `Arming ON — ${id} waits for watch→arm→trigger`,
  };
}

/** Stamp eligibleProfileIds on a family watch row (lazy, no exclusive assign). */
export function stampEligibleOnWatchEntry(
  family: WatchFamilyId,
  entry: {
    preferredProfileId?: string | null;
    source?: string;
    marketCapUsd?: number | null;
    eligibleProfileIds?: string[];
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
  });
  entry.eligibleProfileIds = ids;
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
  entry: {
    preferredProfileId?: string | null;
    nearSupport?: boolean | null;
    nearKeyFib?: boolean | null;
    nearMultiTfSupport?: boolean | null;
    nearMultiTfResistance?: boolean | null;
    srConfluenceScore?: number | null;
    supportTfHits?: string[] | null;
    chartPatternIds?: string[] | null;
    confluenceCount?: number | null;
    playbookPassed?: string[];
    triggerBlockReason?: string;
    lastReason?: string;
  }
): boolean {
  const pid = String(
    profileId || entry.preferredProfileId || ''
  ).trim();
  const r = evaluateWatchTriggerConfluence({
    profileId: pid,
    nearSupport: entry.nearSupport,
    nearKeyFib: entry.nearKeyFib,
    nearMultiTfSupport: entry.nearMultiTfSupport,
    nearMultiTfResistance: entry.nearMultiTfResistance,
    srConfluenceScore: entry.srConfluenceScore,
    supportTfHits: Array.isArray(entry.supportTfHits)
      ? entry.supportTfHits.map(String)
      : null,
    chartPatternIds: Array.isArray(entry.chartPatternIds)
      ? (entry.chartPatternIds as string[])
      : null,
  });
  entry.confluenceCount = r.count;
  entry.playbookPassed = r.passed;
  if (!r.ok) {
    entry.triggerBlockReason = r.reason;
    entry.lastReason = r.reason;
    noteProfileWatchFunnel(pid, 'blocked', r.reason);
    try {
      const { noteTriggerOpenBlocked } =
        require('./watchPipeline') as typeof import('./watchPipeline');
      noteTriggerOpenBlocked(r.reason || 'confluence');
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
        preferredProfileId: pid,
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
