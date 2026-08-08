/**
 * Profile attention share — throttle Scalper monopoly when underperforming.
 * Armed setup-watch triggers bypass the share cap.
 */

import { paperTrader } from './paperTrader';

const ATTENTION_WINDOW = 40;
const SCALPER_WR_LOOKBACK = 20;
const WEAK_WR_PCT = 45;
const SCALPER_SHARE_CAP = 0.35;

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

function recentOpenProfileIds(limit = ATTENTION_WINDOW): string[] {
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

export function getProfileAttentionShare(limit = ATTENTION_WINDOW): {
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

  if (att.shares.scalper >= SCALPER_SHARE_CAP && att.total >= 8) {
    return {
      throttle: true,
      reason: `Scalper attention ${(att.shares.scalper * 100).toFixed(0)}% ≥ ${(SCALPER_SHARE_CAP * 100).toFixed(0)}% cap` +
        (wr != null ? ` · WR ${wr.toFixed(0)}%` : '') +
        (recovering ? ' · recovery stage≤1' : ''),
    };
  }
  return { throttle: false };
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

export function describeDipInactiveReason():
  | 'no_watches'
  | 'armed_no_trigger'
  | 'trigger_blocked'
  | 'recovery'
  | 'marl'
  | 'profile_off' {
  try {
    const { isStrategyEnabledGlobal } =
      require('./strategies') as typeof import('./strategies');
    const { config } = require('./config') as typeof import('./config');
    if (!isStrategyEnabledGlobal('ta_market_scanner')) return 'profile_off';
    if (config.tradeProfiles?.profiles?.dip_buyer === false) return 'profile_off';
    const { getDipSetupWatchStatus } =
      require('./dipSetupWatch') as typeof import('./dipSetupWatch');
    const st = getDipSetupWatchStatus(30);
    const armed = (st.entries || []).filter((e) => e.status === 'armed');
    const watching = (st.entries || []).filter((e) => e.status === 'watching');
    if (!st.active) return 'no_watches';
    try {
      const { isDipBuyerRecovering } =
        require('./dipBuyerRecovery') as typeof import('./dipBuyerRecovery');
      if (isDipBuyerRecovering?.()) return 'recovery';
    } catch {
      /* optional */
    }
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
    if (armed.length && !watching.length) return 'armed_no_trigger';
    if (armed.length || watching.length) return 'armed_no_trigger';
    return 'no_watches';
  } catch {
    return 'no_watches';
  }
}

/** Compact diagnostics payload for API / dashboard / Zion. */
export function getSetupWatchDiagnostics(): {
  armedByProfile: Record<string, number>;
  armToTriggerLatencyMs: number | null;
  triggerSuccessPct: number | null;
  scalperOpenRatePct: number | null;
  modeBFunnel: Record<string, number> | null;
  blockReasons: Array<{ reason: string; count: number }>;
  scalperAttentionShare: number | null;
  dipInactiveReason:
    | 'no_watches'
    | 'armed_no_trigger'
    | 'trigger_blocked'
    | 'recovery'
    | 'marl'
    | 'profile_off';
  stats: ReturnType<typeof import('./setupWatchEvents').setupWatchEventStats>;
  lastBlockReason: string | null;
} {
  const { listSetupWatchEvents, setupWatchEventStats } =
    require('./setupWatchEvents') as typeof import('./setupWatchEvents');
  const stats = setupWatchEventStats();
  const events = listSetupWatchEvents(100);
  const armedByProfile: Record<string, number> = {};
  try {
    const { getScalperSetupWatchStatus } =
      require('./scalperSetupWatch') as typeof import('./scalperSetupWatch');
    const { getDipSetupWatchStatus } =
      require('./dipSetupWatch') as typeof import('./dipSetupWatch');
    const sw = getScalperSetupWatchStatus(24);
    const dw = getDipSetupWatchStatus(28);
    for (const e of sw.entries || []) {
      if (e.status !== 'armed' && e.status !== 'watching') continue;
      const id = String(e.preferredProfileId || 'scalper');
      armedByProfile[id] =
        (armedByProfile[id] || 0) + (e.status === 'armed' ? 1 : 0);
    }
    const dipArmed = (dw.entries || []).filter((e) => e.status === 'armed')
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
  return {
    armedByProfile,
    armToTriggerLatencyMs,
    triggerSuccessPct:
      denom > 0 ? Math.round((stats.opened / denom) * 1000) / 10 : null,
    scalperOpenRatePct,
    modeBFunnel,
    blockReasons,
    scalperAttentionShare,
    dipInactiveReason: describeDipInactiveReason(),
    stats,
    lastBlockReason: lastBlock?.reason || null,
  };
}
