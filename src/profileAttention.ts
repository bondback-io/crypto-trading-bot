/**
 * Profile attention share — throttle Scalper monopoly when underperforming.
 * Armed setup-watch triggers bypass the share cap.
 * Admission Baseline v235 uses 1.2.235-era 35%/window 40; governed Entry Skill 32%/30.
 */

import { paperTrader } from './paperTrader';

const ATTENTION_WINDOW_GOVERNED = 30;
const ATTENTION_WINDOW_V235 = 40;
const SCALPER_WR_LOOKBACK = 20;
const WEAK_WR_PCT = 45;
const SCALPER_SHARE_CAP_GOVERNED = 0.32;
const SCALPER_SHARE_CAP_V235 = 0.35;

function isV235Baseline(): boolean {
  try {
    const { isAdmissionBaselineV235 } =
      require('./expectancyLift') as typeof import('./expectancyLift');
    return isAdmissionBaselineV235();
  } catch {
    return false;
  }
}

function attentionWindow(): number {
  return isV235Baseline() ? ATTENTION_WINDOW_V235 : ATTENTION_WINDOW_GOVERNED;
}

function scalperShareCap(): number {
  return isV235Baseline() ? SCALPER_SHARE_CAP_V235 : SCALPER_SHARE_CAP_GOVERNED;
}

export function getScalperAttentionShareCap(): number {
  return scalperShareCap();
}

export type AttentionBucket =
  | 'scalper'
  | 'dip'
  | 'trend'
  | 'migration'
  | 'other';

function bucketFor(profileId: string | null | undefined): AttentionBucket {
  const id = String(profileId || '');
  if (
    id === 'scalper' ||
    id === 'momentum_burst' ||
    id === 'reversal_scalper'
  ) {
    return 'scalper';
  }
  if (id === 'dip_buyer') return 'dip';
  if (id === 'trend_rider' || id === 'steady_compounder') return 'trend';
  if (id === 'migration_sniper' || id === 'migration') return 'migration';
  return 'other';
}

function recentOpenProfileIds(limit = attentionWindow()): string[] {
  try {
    const closed = paperTrader.getClosedPositions?.() ?? [];
    const open = paperTrader.getOpenPositions();
    const rows: Array<{ at: number; id: string }> = [];
    for (const p of open) {
      rows.push({
        at: Number(p.openedAt) || 0,
        id: String(p.tradeProfileId || ''),
      });
    }
    for (const t of closed.slice(-80)) {
      rows.push({
        at: Number((t as { openedAt?: number }).openedAt) || 0,
        id: String((t as { tradeProfileId?: string }).tradeProfileId || ''),
      });
    }
    rows.sort((a, b) => b.at - a.at);
    return rows
      .slice(0, limit)
      .map((r) => r.id)
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function getProfileAttentionShare(limit = attentionWindow()): {
  total: number;
  shares: Record<AttentionBucket, number>;
  counts: Record<AttentionBucket, number>;
  scalperWinRatePct: number | null;
} {
  const ids = recentOpenProfileIds(limit);
  const counts: Record<AttentionBucket, number> = {
    scalper: 0,
    dip: 0,
    trend: 0,
    migration: 0,
    other: 0,
  };
  for (const id of ids) counts[bucketFor(id)] += 1;
  const total = ids.length || 1;
  const shares: Record<AttentionBucket, number> = {
    scalper: counts.scalper / total,
    dip: counts.dip / total,
    trend: counts.trend / total,
    migration: counts.migration / total,
    other: counts.other / total,
  };
  return {
    total: ids.length,
    shares,
    counts,
    scalperWinRatePct: scalperRecentWinRate(),
  };
}

function scalperRecentWinRate(): number | null {
  try {
    const closed = paperTrader.getClosedPositions?.() ?? [];
    const family = closed
      .filter((t) => {
        const id = String((t as { tradeProfileId?: string }).tradeProfileId || '');
        return (
          id === 'scalper' ||
          id === 'momentum_burst' ||
          id === 'reversal_scalper'
        );
      })
      .slice(-SCALPER_WR_LOOKBACK);
    if (family.length < 6) return null;
    const wins = family.filter(
      (t) => Number((t as { pnlPct?: number }).pnlPct) > 0
    ).length;
    return (wins / family.length) * 100;
  } catch {
    return null;
  }
}

function scalperRecoveringStrict(): boolean {
  try {
    const {
      isFastProfileRecovering,
      getProfileRecoveryStage,
    } = require('./fastProfileRecovery') as typeof import('./fastProfileRecovery');
    if (!isFastProfileRecovering('scalper')) return false;
    return getProfileRecoveryStage('scalper') <= 1;
  } catch {
    return false;
  }
}

function countModeBLiveArmed(): number {
  try {
    const { getScalperSetupWatchStatus } =
      require('./scalperSetupWatch') as typeof import('./scalperSetupWatch');
    const sw = getScalperSetupWatchStatus(40);
    return (sw.entries || []).filter((e) => e.status === 'armed').length;
  } catch {
    return 0;
  }
}

/**
 * Concurrent Scalper open-position cap — skip discretionary scalper admits
 * when ≥1 open position already stamped tradeProfileId==='scalper'.
 * When Mode B liveArmed === 0: do NOT apply (starvation relief).
 * When Mode B arms exist: keep concurrent ≥1 for disc.
 */
export function shouldLimitScalperConcurrent(input: {
  profileId?: string | null;
  armedWatch?: boolean;
  scannerReasons?: string[] | null;
}): { limit: boolean; reason?: string } {
  if (isV235Baseline()) return { limit: false };
  const id = String(input.profileId || '');
  if (id !== 'scalper') return { limit: false };
  const reasons = (input.scannerReasons || []).join(' ');
  const armed =
    input.armedWatch === true ||
    /scalper-watch:triggered|dip-watch:triggered|armedWatch/i.test(reasons);
  if (armed) return { limit: false };
  // Zero Mode B arms → allow discretionary Scalper (no concurrent freeze)
  if (countModeBLiveArmed() === 0) return { limit: false };
  try {
    const open = paperTrader.getOpenPositions();
    const scalperOpen = open.filter(
      (p) => String(p.tradeProfileId || '') === 'scalper'
    ).length;
    if (scalperOpen >= 1) {
      return {
        limit: true,
        reason: `Scalper concurrent open ≥1 — skip discretionary admit`,
      };
    }
  } catch {
    /* fail soft */
  }
  return { limit: false };
}

/**
 * Habit (1.2.248): Steady maxConcurrent 1 — skip when already open.
 * Armed Medium/Majors quality reclaim bypasses.
 */
export function shouldLimitSteadyConcurrent(input: {
  profileId?: string | null;
  armedWatch?: boolean;
  scannerReasons?: string[] | null;
}): { limit: boolean; reason?: string } {
  if (isV235Baseline()) return { limit: false };
  const id = String(input.profileId || '');
  if (id !== 'steady_compounder') return { limit: false };
  const reasons = (input.scannerReasons || []).join(' ');
  const armed =
    input.armedWatch === true ||
    /dip-watch:triggered|armedWatch|quality_structure/i.test(reasons);
  // Still enforce concurrent 1 even when armed — doctrine maxConcurrent 1
  void armed;
  try {
    const open = paperTrader.getOpenPositions();
    const steadyOpen = open.filter(
      (p) => String(p.tradeProfileId || '') === 'steady_compounder'
    ).length;
    if (steadyOpen >= 1) {
      return {
        limit: true,
        reason: `Steady concurrent ≥1 — maxConcurrent 1`,
      };
    }
  } catch {
    /* fail soft */
  }
  return { limit: false };
}

/**
 * Habit (1.2.248): MS concurrent ≤1 while migration_hold_reclaim is
 * down_ranked/restricted — Grad-armed bypasses. Also hard size cut already
 * in expectancy size path.
 */
export function shouldLimitMigrationConcurrent(input: {
  profileId?: string | null;
  armedWatch?: boolean;
  scannerReasons?: string[] | null;
}): { limit: boolean; reason?: string } {
  if (isV235Baseline()) return { limit: false };
  const id = String(input.profileId || '');
  if (id !== 'migration_sniper') return { limit: false };
  const reasons = (input.scannerReasons || []).join(' ');
  const armed =
    input.armedWatch === true ||
    /grad-watch:triggered|armedWatch/i.test(reasons);
  if (armed) return { limit: false };
  let gov: string | null = null;
  try {
    const { getFamilyGovernorState } =
      require('./expectancyLift') as typeof import('./expectancyLift');
    gov = getFamilyGovernorState('migration_hold_reclaim');
  } catch {
    return { limit: false };
  }
  if (gov !== 'down_ranked' && gov !== 'restricted') return { limit: false };
  try {
    const open = paperTrader.getOpenPositions();
    const migOpen = open.filter(
      (p) => String(p.tradeProfileId || '') === 'migration_sniper'
    ).length;
    if (migOpen >= 1) {
      return {
        limit: true,
        reason: `MS concurrent ≥1 while ${gov} — skip discretionary admit`,
      };
    }
  } catch {
    /* fail soft */
  }
  return { limit: false };
}

/**
 * True when a discretionary (non-armed) Scalper-family admit should be skipped
 * to leave room for Dip/Trend/Migration.
 */
export function shouldThrottleScalperAdmit(input: {
  profileId?: string | null;
  armedWatch?: boolean;
  scannerReasons?: string[] | null;
}): { throttle: boolean; reason?: string } {
  const id = String(input.profileId || '');
  const isScalperFamily =
    id === 'scalper' ||
    id === 'momentum_burst' ||
    id === 'reversal_scalper';
  if (!isScalperFamily) return { throttle: false };

  const reasons = (input.scannerReasons || []).join(' ');
  // Armed reclaim (Scalper or Dip watch handoff) bypasses share cap
  const armed =
    input.armedWatch === true ||
    /scalper-watch:triggered|dip-watch:triggered|armedWatch/i.test(reasons);
  if (armed) return { throttle: false };

  const att = getProfileAttentionShare();
  const wr = att.scalperWinRatePct;
  const weak = wr != null && wr < WEAK_WR_PCT;
  const recovering = scalperRecoveringStrict();
  if (!weak && !recovering) return { throttle: false };

  const cap = scalperShareCap();
  if (att.shares.scalper >= cap && att.total >= 8) {
    return {
      throttle: true,
      reason: `Scalper attention ${(att.shares.scalper * 100).toFixed(0)}% ≥ ${(cap * 100).toFixed(0)}% cap` +
        (wr != null ? ` · WR ${wr.toFixed(0)}%` : '') +
        (recovering ? ' · recovery stage≤1' : ''),
    };
  }
  return { throttle: false };
}

/**
 * Habit (1.2.260): always prefer armed Mode B reclaim for Scalper.
 * Soft-skip discretionary (unarmed) unless volume expanding + near support.
 * Armed Mode B / watch-triggered always bypasses. Does not raise attention caps.
 */
export function shouldSoftSkipUnarmedScalperHabit(input: {
  profileId?: string | null;
  armedWatch?: boolean;
  scannerReasons?: string[] | null;
  volumeDecayState?: string | null;
  nearSupport?: boolean | null;
  nearMultiTfSupport?: boolean | null;
}): { skip: boolean; reason?: string } {
  if (isV235Baseline()) return { skip: false };
  if (String(input.profileId || '') !== 'scalper') return { skip: false };

  const reasons = (input.scannerReasons || []).join(' ');
  const armed =
    input.armedWatch === true ||
    /scalper-watch:triggered|dip-watch:triggered|grad-watch:triggered|armedWatch/i.test(
      reasons
    );
  if (armed) return { skip: false };

  const volExpanding = String(input.volumeDecayState || '') === 'expanding';
  const nearS =
    input.nearSupport === true || input.nearMultiTfSupport === true;
  if (volExpanding && nearS) return { skip: false };

  const wr = scalperRecentWinRate();
  const recovering = scalperRecoveringStrict();
  return {
    skip: true,
    reason:
      `scalper_discretionary_skipped · prefer armed Mode B reclaim` +
      (wr != null ? ` · WR ${wr.toFixed(0)}%` : '') +
      (recovering ? ' · recovery stage≤1' : '') +
      ' · need expanding vol + near support',
  };
}

/** Extra MARL downrank when Scalper expectancy is weak (beyond recovery). */
export function scalperExpectancyMarlDelta(profileId: string): number {
  const id = String(profileId || '');
  if (
    id !== 'scalper' &&
    id !== 'momentum_burst' &&
    id !== 'reversal_scalper'
  ) {
    return 0;
  }
  const wr = scalperRecentWinRate();
  if (wr == null) return 0;
  if (wr < 30) return -10;
  if (wr < WEAK_WR_PCT) return -6;
  if (wr < 55) return -3;
  return 0;
}

function dipMarlConstrained(): boolean {
  try {
    const { getMarlConfig } =
      require('./marlCoordinator') as typeof import('./marlCoordinator');
    const { getOrCreateAgent, getMarlDecisions } =
      require('./marlStore') as typeof import('./marlStore');
    const cfg = getMarlConfig();
    if (!cfg.enabled) return false;
    const agent = getOrCreateAgent('dip_buyer');
    if (agent.weight < -0.15) return true;
    const recent = getMarlDecisions(24).filter(
      (d) =>
        d.profileId === 'dip_buyer' &&
        /skip|size_down|downrank/i.test(`${d.kind} ${d.detail}`)
    );
    return recent.length >= 2;
  } catch {
    return false;
  }
}

export function describeDipInactiveReason():
  | 'no_watches'
  | 'armed_no_trigger'
  | 'trigger_blocked'
  | 'recovery'
  | 'marl'
  | 'suppressed_by_scalper_attention'
  | 'profile_off' {
  try {
    const { isStrategyEnabledGlobal } =
      require('./strategies') as typeof import('./strategies');
    const { config } = require('./config') as typeof import('./config');
    if (!isStrategyEnabledGlobal('ta_market_scanner')) return 'profile_off';
    if (config.tradeProfiles?.profiles?.dip_buyer === false) return 'profile_off';
    const { getActiveDipWatchesSnapshot } =
      require('./dipSetupWatch') as typeof import('./dipSetupWatch');
    const st = getActiveDipWatchesSnapshot();
    const armed = (st.allActive || []).filter((e) => e.status === 'armed');
    const watching = (st.allActive || []).filter((e) => e.status === 'watching');
    if (!st.active) return 'no_watches';
    try {
      const { isDipBuyerRecovering } =
        require('./dipBuyerRecovery') as typeof import('./dipBuyerRecovery');
      if (isDipBuyerRecovering?.()) return 'recovery';
    } catch {
      /* optional */
    }
    if (dipMarlConstrained()) return 'marl';
    try {
      const { listSetupWatchEvents } =
        require('./setupWatchEvents') as typeof import('./setupWatchEvents');
      const recent = listSetupWatchEvents(40).filter((e) => e.family === 'dip');
      if (recent.some((e) => e.kind === 'trigger_blocked_safety')) {
        return 'trigger_blocked';
      }
    } catch {
      /* optional */
    }
    try {
      const att = getProfileAttentionShare();
      const cap = scalperShareCap();
      if (
        att.total >= 8 &&
        att.shares.scalper >= cap &&
        (armed.length > 0 || watching.length > 0)
      ) {
        return 'suppressed_by_scalper_attention';
      }
    } catch {
      /* optional */
    }
    if (armed.length && !watching.length) return 'armed_no_trigger';
    if (armed.length || watching.length) return 'armed_no_trigger';
    return 'no_watches';
  } catch {
    return 'no_watches';
  }
}

export type TrendInactiveReason =
  | 'no_arms'
  | 'no_trigger'
  | 'expired'
  | 'blocked'
  | 'recovery'
  | 'marl'
  | 'profile_off'
  | 'few_trades';

/** Funnel-style quiet reason for Trend / Steady. */
export function describeTrendInactiveReason(
  profileId: string = 'trend_rider'
): TrendInactiveReason {
  const pid = String(profileId || 'trend_rider');
  try {
    const { isStrategyEnabledGlobal } =
      require('./strategies') as typeof import('./strategies');
    const { config } = require('./config') as typeof import('./config');
    if (!isStrategyEnabledGlobal('ta_market_scanner')) return 'profile_off';
    if (config.tradeProfiles?.profiles?.[pid] === false) return 'profile_off';
    try {
      const { isFastProfileRecovering } =
        require('./fastProfileRecovery') as typeof import('./fastProfileRecovery');
      if (isFastProfileRecovering?.(pid)) return 'recovery';
    } catch {
      /* optional */
    }
    try {
      const { getMarlConfig } =
        require('./marlCoordinator') as typeof import('./marlCoordinator');
      const { getOrCreateAgent, getMarlDecisions } =
        require('./marlStore') as typeof import('./marlStore');
      const cfg = getMarlConfig();
      if (cfg.enabled) {
        const agent = getOrCreateAgent(pid);
        if (agent.weight < -0.15) return 'marl';
        const recent = getMarlDecisions(24).filter(
          (d) =>
            d.profileId === pid &&
            /skip|size_down|downrank/i.test(`${d.kind} ${d.detail}`)
        );
        if (recent.length >= 2) return 'marl';
      }
    } catch {
      /* optional */
    }
    try {
      const { listSetupWatchEvents } =
        require('./setupWatchEvents') as typeof import('./setupWatchEvents');
      const recent = listSetupWatchEvents(50).filter(
        (e) => e.profileId === pid
      );
      if (
        recent.some(
          (e) =>
            e.kind === 'trigger_blocked_safety' ||
            e.kind === 'trigger_blocked_cooldown' ||
            e.kind === 'handoff_failed'
        )
      ) {
        return 'blocked';
      }
      if (recent.some((e) => e.kind === 'watch_expired')) {
        return 'expired';
      }
      if (recent.some((e) => e.kind === 'armed')) return 'no_trigger';
    } catch {
      /* optional */
    }
    let armed = 0;
    try {
      const { getScalperSetupWatchStatus } =
        require('./scalperSetupWatch') as typeof import('./scalperSetupWatch');
      const sw = getScalperSetupWatchStatus(24);
      for (const e of sw.entries || []) {
        if (e.status !== 'armed') continue;
        if (String(e.preferredProfileId || '') === pid) armed += 1;
      }
    } catch {
      /* optional */
    }
    if (armed > 0) return 'no_trigger';
    try {
      const closed = paperTrader.getClosedPositions?.() ?? [];
      const n = closed
        .filter(
          (t) =>
            String((t as { tradeProfileId?: string }).tradeProfileId || '') ===
            pid
        )
        .slice(-20).length;
      if (n < 2) return 'few_trades';
    } catch {
      /* optional */
    }
    return 'no_arms';
  } catch {
    return 'no_arms';
  }
}

/** Compact diagnostics payload for API / dashboard / Zion. */
export function getSetupWatchDiagnostics(): {
  armedByProfile: Record<string, number>;
  armToTriggerLatencyMs: number | null;
  triggerSuccessPct: number | null;
  scalperOpenRatePct: number | null;
  modeBFunnel: Record<string, number> | null;
  dipFunnel: Record<string, number> | null;
  softAllowCounters: Record<
    string,
    { granted: number; denied: number; lastDenyKey: string | null }
  > | null;
  dipMinorLane: {
    health: import('./dipMinorLaneHealth').DipMinorLaneHealth;
    laneCompare: import('./dipMinorLaneHealth').DipLaneCompareDiagnostics;
    qualityParks: ReturnType<
      typeof import('./dipMinorLaneHealth').getQualityParkLaneHealth
    >;
  } | null;
  blockReasons: Array<{ reason: string; count: number }>;
  scalperAttentionShare: number | null;
  dipInactiveReason:
    | 'no_watches'
    | 'armed_no_trigger'
    | 'trigger_blocked'
    | 'recovery'
    | 'marl'
    | 'suppressed_by_scalper_attention'
    | 'profile_off';
  stats: ReturnType<typeof import('./setupWatchEvents').setupWatchEventStats>;
  lastBlockReason: string | null;
  fallbackDiscAllowed: boolean;
  locksHeld: number;
  blockedSecondPass: number;
  entrySkillByProfile: Record<
    string,
    {
      armed: number;
      triggered: number;
      opened: number;
      expired: number;
      locksHeld: number;
      fallbackDiscAllowed: boolean;
    }
  >;
} {
  const { listSetupWatchEvents, setupWatchEventStats } =
    require('./setupWatchEvents') as typeof import('./setupWatchEvents');
  const stats = setupWatchEventStats();
  const events = listSetupWatchEvents(100);
  const armedByProfile: Record<string, number> = {};
  try {
    const { getScalperSetupWatchStatus } =
      require('./scalperSetupWatch') as typeof import('./scalperSetupWatch');
    const { getActiveDipWatchesSnapshot } =
      require('./dipSetupWatch') as typeof import('./dipSetupWatch');
    const sw = getScalperSetupWatchStatus(24);
    const dw = getActiveDipWatchesSnapshot();
    for (const e of sw.entries || []) {
      if (e.status !== 'armed' && e.status !== 'watching') continue;
      const id = String(e.preferredProfileId || 'scalper');
      armedByProfile[id] =
        (armedByProfile[id] || 0) + (e.status === 'armed' ? 1 : 0);
    }
    const dipArmed = (dw.allActive || []).filter((e) => e.status === 'armed')
      .length;
    if (dipArmed) armedByProfile.dip_buyer = dipArmed;
  } catch {
    /* optional */
  }

  const latencies: number[] = [];
  const armedAt = new Map<string, number>();
  for (const e of [...events].reverse()) {
    const key = `${e.family}:${e.mint}`;
    if (e.kind === 'armed') armedAt.set(key, e.at);
    if (e.kind === 'triggered' || e.kind === 'trigger_opened') {
      const a = armedAt.get(key);
      if (a != null && e.at >= a) latencies.push(e.at - a);
    }
  }
  const armToTriggerLatencyMs =
    latencies.length > 0
      ? Math.round(latencies.reduce((s, n) => s + n, 0) / latencies.length)
      : null;

  const blockReasonsMap = new Map<string, number>();
  for (const e of events) {
    if (
      e.kind === 'trigger_blocked_safety' ||
      e.kind === 'trigger_blocked_cooldown' ||
      e.kind === 'handoff_failed'
    ) {
      const r = String(e.reason || e.kind).slice(0, 80);
      blockReasonsMap.set(r, (blockReasonsMap.get(r) || 0) + 1);
    }
  }
  const blockReasons = [...blockReasonsMap.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  const lastBlock = events.find(
    (e) =>
      e.kind === 'trigger_blocked_safety' ||
      e.kind === 'trigger_blocked_cooldown' ||
      e.kind === 'handoff_failed'
  );

  let scalperAttentionShare: number | null = null;
  try {
    const att = getProfileAttentionShare();
    scalperAttentionShare =
      att.total >= 4 ? Math.round(att.shares.scalper * 1000) / 10 : null;
  } catch {
    /* optional */
  }

  const denom =
    stats.triggered + stats.opened + stats.blockedSafety + stats.handoffFailed;
  let modeBFunnel: Record<string, number> | null = null;
  let scalperOpenRatePct: number | null = null;
  try {
    const ss = setupWatchEventStats(6 * 60 * 60_000, 'scalper');
    scalperOpenRatePct =
      ss.openRate != null ? Math.round(ss.openRate * 1000) / 10 : null;
  } catch {
    /* optional */
  }
  try {
    const { getModeBFunnelCounters } =
      require('./scalperSetupWatch') as typeof import('./scalperSetupWatch');
    modeBFunnel = getModeBFunnelCounters() as unknown as Record<string, number>;
  } catch {
    /* optional */
  }
  let dipFunnel: Record<string, number> | null = null;
  try {
    const { getDipFunnelCounters } =
      require('./dipSetupWatch') as typeof import('./dipSetupWatch');
    dipFunnel = getDipFunnelCounters() as unknown as Record<string, number>;
  } catch {
    /* optional */
  }
  let fallbackDiscAllowed = true;
  let locksHeld = 0;
  let blockedSecondPass = 0;
  let entrySkillByProfile: Record<
    string,
    {
      armed: number;
      triggered: number;
      opened: number;
      expired: number;
      locksHeld: number;
      fallbackDiscAllowed: boolean;
    }
  > = {};
  try {
    const {
      isFallbackDiscAllowed,
      countOneSetupLocksHeld,
      getBlockedSecondPassCount,
      buildEntrySkillByProfile,
    } = require('./expectancyLift') as typeof import('./expectancyLift');
    fallbackDiscAllowed = isFallbackDiscAllowed();
    locksHeld = countOneSetupLocksHeld();
    blockedSecondPass = getBlockedSecondPassCount();
    entrySkillByProfile = buildEntrySkillByProfile();
  } catch {
    /* optional */
  }
  return {
    armedByProfile,
    armToTriggerLatencyMs,
    triggerSuccessPct:
      denom > 0 ? Math.round((stats.opened / denom) * 1000) / 10 : null,
    scalperOpenRatePct,
    modeBFunnel,
    dipFunnel,
    softAllowCounters: (() => {
      try {
        const { getQualitySoftAllowCounters } =
          require('./tradeProfiles') as typeof import('./tradeProfiles');
        return getQualitySoftAllowCounters();
      } catch {
        return null;
      }
    })(),
    dipMinorLane: (() => {
      try {
        const {
          getDipMinorLaneHealth,
          getDipLaneCompareDiagnostics,
          getQualityParkLaneHealth,
        } = require('./dipMinorLaneHealth') as typeof import('./dipMinorLaneHealth');
        return {
          health: getDipMinorLaneHealth(),
          laneCompare: getDipLaneCompareDiagnostics(),
          qualityParks: getQualityParkLaneHealth(),
        };
      } catch {
        return null;
      }
    })(),
    blockReasons,
    scalperAttentionShare,
    dipInactiveReason: describeDipInactiveReason(),
    stats,
    lastBlockReason: lastBlock?.reason || null,
    fallbackDiscAllowed,
    locksHeld,
    blockedSecondPass,
    entrySkillByProfile,
  };
}
