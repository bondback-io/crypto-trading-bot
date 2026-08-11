/**
 * Read-only Learning Metrics panel for Stats.
 * Joins expectancy, Profile RL, trade craft, and learning diagnostics.
 * Does not mutate admits, ML/RL modes, or trading logic.
 */

import {
  getExpectancyLiftStatus,
  parseExpectancyWindow,
  type ExpectancyWindow,
  type FamilyGovernorState,
} from './expectancyLift';

export type LearningMetricsTone = 'healthy' | 'watch' | 'weak';

export interface LearningMetricsFunnel {
  candidates: number | null;
  armed: number | null;
  triggered: number | null;
  opened: number | null;
  closed: number | null;
}

export interface LearningMetricsProfileRow {
  profileId: string;
  name: string;
  enabled: boolean;
  /** Closed trades in expectancy window */
  n: number;
  /** Durable learning episodes (diagnostics) */
  episodes: number | null;
  rlMode: 'shadow' | 'hybrid' | 'lead' | null;
  readinessScore: number | null;
  rewardEma: number | null;
  rewardEmaDelta: number | null;
  modeLocked: boolean;
  winRate: number | null;
  expectancyPct: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  profitFactor: number | null;
  mfeCapturePct: number | null;
  craftCapturePct: number | null;
  givebackPct: number | null;
  softExitPct: number | null;
  armedShare: number | null;
  discretionaryShare: number | null;
  lateChaseShare: number | null;
  topEntryFamily: string | null;
  governorHints: Array<{ family: string; state: FamilyGovernorState }>;
  blockers: string[];
  funnel: LearningMetricsFunnel;
  tone: LearningMetricsTone;
  summary: string;
}

export interface LearningMetricsPanel {
  ok: true;
  window: ExpectancyWindow;
  updatedAt: number;
  profiles: LearningMetricsProfileRow[];
  plainLanguage: string;
  repairSummary?: {
    zeroMfeShare: number | null;
    greenThenRedShare: number | null;
    armedShare: number | null;
    govSoftPassNative: number;
    govDipComparativeSoftAllow: number;
    softMovementGrants: number;
    softMovementArmsLive: number;
    topLossProfileId: string | null;
    topLossShare: number | null;
  };
  funnelConversion?: {
    armed: number | null;
    triggered: number | null;
    opened: number | null;
    armToTriggerPct: number | null;
    triggerToOpenPct: number | null;
    armToOpenPct: number | null;
  };
  familyRestrictionImpact?: Array<{
    family: string;
    state: FamilyGovernorState;
    nativeProfiles: string[];
    expectancyPct: number | null;
    note: string;
  }>;
}

function pct(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

function synthesizeBlockers(input: {
  name: string;
  n: number;
  rlMode: 'shadow' | 'hybrid' | 'lead' | null;
  readinessScore: number | null;
  rewardEma: number | null;
  expectancyPct: number | null;
  craftCapturePct: number | null;
  mfeCapturePct: number | null;
  modeLocked: boolean;
  rlBlocker: string | null;
}): string[] {
  const out: string[] = [];
  if (input.rlBlocker) {
    // Prefer short operator-facing form
    const short = input.rlBlocker
      .replace(/^[^:]+:\s*/, '')
      .replace(/\.\s*$/, '');
    if (input.rlMode === 'shadow' && /EMA negative/i.test(short)) {
      out.push(`Stays Shadow: EMA negative`);
    } else if (input.rlMode === 'shadow' && /near Hybrid/i.test(short)) {
      out.push(`Ready for Hybrid: readiness stable`);
    } else if (input.rlMode === 'hybrid' && /Lead/i.test(short)) {
      out.push(
        /capture|EMA|readiness/i.test(short)
          ? `Not Lead: ${short.slice(0, 72)}`
          : `Not Lead: ${short.slice(0, 72)}`
      );
    } else if (input.modeLocked) {
      out.push(`Locked: auto promote/demote paused`);
    } else {
      out.push(short.length > 90 ? `${short.slice(0, 87)}…` : short);
    }
  }

  if (input.n <= 0) {
    out.push(`Quiet: 0 episodes in window`);
  } else if (
    input.rlMode === 'shadow' &&
    (input.readinessScore == null || input.readinessScore >= 55) &&
    (input.expectancyPct == null || input.expectancyPct >= 0) &&
    (input.rewardEma == null || input.rewardEma >= 0) &&
    !out.some((b) => /Ready for Hybrid|Stays Shadow/i.test(b))
  ) {
    out.push(`Ready for Hybrid: readiness stable, expectancy positive`);
  }

  const cap = input.craftCapturePct ?? input.mfeCapturePct;
  if (
    input.rlMode === 'hybrid' &&
    cap != null &&
    cap < 40 &&
    !out.some((b) => /Not Lead|capture/i.test(b))
  ) {
    out.push(`Not Lead: capture still weak`);
  }

  if (
    input.rewardEma != null &&
    input.rewardEma < -0.05 &&
    input.rlMode === 'shadow' &&
    !out.some((b) => /EMA negative/i.test(b))
  ) {
    out.push(`Stays Shadow: EMA negative`);
  }

  // Dedupe similar
  const seen = new Set<string>();
  return out.filter((b) => {
    const k = b.toLowerCase().slice(0, 28);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 3);
}

function toneFor(row: {
  n: number;
  rewardEma: number | null;
  expectancyPct: number | null;
  armedShare: number | null;
  lateChaseShare: number | null;
  craftCapturePct: number | null;
  mfeCapturePct: number | null;
}): LearningMetricsTone {
  if (row.n <= 0) return 'watch';
  const cap = row.craftCapturePct ?? row.mfeCapturePct;
  const late = row.lateChaseShare;
  const weak =
    (row.rewardEma != null && row.rewardEma < -0.08) ||
    (row.expectancyPct != null && row.expectancyPct < -0.5) ||
    (late != null && late >= 0.2) ||
    (cap != null && cap < 30 && row.n >= 12);
  if (weak) return 'weak';
  const healthy =
    (row.rewardEma == null || row.rewardEma >= 0) &&
    (row.expectancyPct == null || row.expectancyPct >= 0) &&
    (row.armedShare == null || row.armedShare >= 0.55) &&
    (late == null || late <= 0.1) &&
    (cap == null || cap >= 45 || row.n < 8);
  return healthy ? 'healthy' : 'watch';
}

function buildSummary(row: {
  name: string;
  n: number;
  tone: LearningMetricsTone;
  expectancyPct: number | null;
  armedShare: number | null;
  rewardEma: number | null;
  craftCapturePct: number | null;
  mfeCapturePct: number | null;
}): string {
  const short = row.name.replace(/\s+/g, ' ').trim();
  if (row.n <= 0) {
    return `${short} quiet: 0 episodes in window`;
  }
  const e =
    row.expectancyPct == null
      ? 'expectancy —'
      : row.expectancyPct >= 0
        ? 'expectancy positive'
        : 'expectancy negative';
  const armed =
    row.armedShare != null ? `armed ${pct(row.armedShare, 0)}` : null;
  const ema =
    row.rewardEma != null
      ? row.rewardEma >= 0
        ? 'EMA ok'
        : 'negative EMA'
      : null;
  const cap = row.craftCapturePct ?? row.mfeCapturePct;
  const capBit =
    cap != null ? (cap >= 45 ? 'capture ok' : 'low capture') : null;

  if (row.tone === 'healthy') {
    return `${short} learning healthy: n=${row.n}, ${e}${armed ? `, ${armed}` : ''}`;
  }
  if (row.tone === 'weak') {
    const bits = [ema, capBit, e].filter(Boolean).slice(0, 2);
    return `${short} still weak: high n=${row.n}${bits.length ? `, ${bits.join(', ')}` : ''}`;
  }
  return `${short} watch: n=${row.n}, ${e}${armed ? `, ${armed}` : ''}`;
}

export function getLearningMetricsPanel(
  windowRaw?: unknown
): LearningMetricsPanel {
  const window = parseExpectancyWindow(windowRaw ?? 50);
  const el = getExpectancyLiftStatus(window);

  let rlAgents: Array<{
    profileId: string;
    mode: 'shadow' | 'hybrid' | 'lead';
    readinessScore?: number;
    rewardEma: number;
    prevRewardEma?: number;
    preUpdateRewardEma?: number;
    modeLocked?: boolean;
    trades?: number;
    modeBlocker?: string;
  }> = [];
  try {
    const { getProfileRlStatus } =
      require('./profileRlAgent') as typeof import('./profileRlAgent');
    const st = getProfileRlStatus({ persist: false, ensureKeyAgents: true });
    rlAgents = (st.agents || []).map((a) => ({
      profileId: a.profileId,
      mode: a.mode,
      readinessScore: a.readinessScore,
      rewardEma: a.rewardEma,
      prevRewardEma: a.prevRewardEma,
      preUpdateRewardEma: a.preUpdateRewardEma,
      modeLocked: a.modeLocked === true,
      trades: a.trades,
      modeBlocker: a.modeBlocker,
    }));
  } catch {
    rlAgents = [];
  }

  let craftById = new Map<
    string,
    {
      capturePct: number | null;
      givebackPct: number | null;
      softExitPct: number | null;
      n: number;
    }
  >();
  try {
    const { buildTradeCraftPerformance } =
      require('./tradeCraftPerformance') as typeof import('./tradeCraftPerformance');
    const craft = buildTradeCraftPerformance('all', window);
    for (const b of craft.bots || []) {
      craftById.set(b.profileId, {
        capturePct: b.capturePct,
        givebackPct: b.givebackPct ?? null,
        softExitPct: b.softExitPct ?? null,
        n: b.n,
      });
    }
  } catch {
    craftById = new Map();
  }

  let diagById = new Map<
    string,
    { episodes: number; enabled: boolean; name: string }
  >();
  try {
    const { getLearningSystemDiagnostics } =
      require('./learningSystemDiagnostics') as typeof import('./learningSystemDiagnostics');
    const diag = getLearningSystemDiagnostics();
    for (const p of diag.profiles || []) {
      diagById.set(p.id, {
        episodes: p.episodes,
        enabled: p.botEnabled,
        name: p.name,
      });
    }
  } catch {
    diagById = new Map();
  }

  let enabledById = new Map<string, boolean>();
  try {
    const { getTradeProfilesStatus } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    const st = getTradeProfilesStatus();
    for (const p of st.profiles || []) {
      enabledById.set(p.id, p.enabled === true);
    }
  } catch {
    enabledById = new Map();
  }

  const governorHints = (el.families || [])
    .filter((f) => f.state === 'restricted' || f.state === 'down_ranked')
    .slice(0, 4)
    .map((f) => ({ family: f.family, state: f.state }));

  const rlById = new Map(rlAgents.map((a) => [a.profileId, a]));
  const skill = el.entrySkillByProfile || {};

  const profiles: LearningMetricsProfileRow[] = [];
  for (const p of el.profiles || []) {
    const n = Number(p.metrics?.tradeCount) || 0;
    const rl = rlById.get(p.profileId);
    const craft = craftById.get(p.profileId);
    const diag = diagById.get(p.profileId);
    const enabled =
      enabledById.has(p.profileId)
        ? enabledById.get(p.profileId) === true
        : diag?.enabled !== false;

    // Skip disabled with no sample (keep quiet enabled / any with data)
    if (!enabled && n <= 0 && !(diag && diag.episodes > 0) && !rl) continue;

    const armedShare = p.armedShare;
    const lateChaseShare = p.lateChaseShare;
    const discretionaryShare =
      armedShare != null ? Math.max(0, 1 - armedShare) : el.mix?.discretionaryShare ?? null;

    const skillRow = skill[p.profileId];
    const funnel: LearningMetricsFunnel = {
      candidates:
        skillRow != null
          ? (skillRow.armed || 0) + (skillRow.expired || 0)
          : el.funnel?.offered ?? null,
      armed: skillRow?.armed ?? el.funnel?.armed ?? null,
      triggered: skillRow?.triggered ?? el.funnel?.triggered ?? null,
      opened: skillRow?.opened ?? el.funnel?.opened ?? null,
      closed: n > 0 ? n : null,
    };

    const rewardEma = rl?.rewardEma ?? null;
    const prev =
      rl?.prevRewardEma != null && Number.isFinite(rl.prevRewardEma)
        ? rl.prevRewardEma
        : rl?.preUpdateRewardEma;
    const rewardEmaDelta =
      rewardEma != null && prev != null && Number.isFinite(prev)
        ? Math.round((rewardEma - prev) * 1000) / 1000
        : null;

    const topEntryFamily = (() => {
      const late = lateChaseShare ?? 0;
      const armed = armedShare ?? 0;
      const disc = discretionaryShare ?? 0;
      if (n <= 0) return null;
      if (late >= 0.15 && late >= armed && late >= disc) return 'late_chase';
      if (armed >= 0.55) return 'armed_reclaim';
      if (disc >= 0.4) return 'discretionary_other';
      const ranked = [
        { id: 'armed_reclaim', v: armed },
        { id: 'discretionary_other', v: disc },
        { id: 'late_chase', v: late },
      ].sort((a, b) => b.v - a.v);
      return ranked[0] && ranked[0].v > 0 ? ranked[0].id : null;
    })();

    const blockers = synthesizeBlockers({
      name: p.name,
      n,
      rlMode: rl?.mode ?? null,
      readinessScore: rl?.readinessScore ?? null,
      rewardEma,
      expectancyPct: p.metrics.expectancyPct,
      craftCapturePct: craft?.capturePct ?? null,
      mfeCapturePct: p.metrics.mfeCapturePct,
      modeLocked: rl?.modeLocked === true,
      rlBlocker: rl?.modeBlocker ?? null,
    });

    const tone = toneFor({
      n,
      rewardEma,
      expectancyPct: p.metrics.expectancyPct,
      armedShare,
      lateChaseShare,
      craftCapturePct: craft?.capturePct ?? null,
      mfeCapturePct: p.metrics.mfeCapturePct,
    });

    const rowBase = {
      name: p.name,
      n,
      tone,
      expectancyPct: p.metrics.expectancyPct,
      armedShare,
      rewardEma,
      craftCapturePct: craft?.capturePct ?? null,
      mfeCapturePct: p.metrics.mfeCapturePct,
    };

    profiles.push({
      profileId: p.profileId,
      name: p.name,
      enabled,
      n,
      episodes: diag?.episodes ?? rl?.trades ?? null,
      rlMode: rl?.mode ?? null,
      readinessScore: rl?.readinessScore ?? null,
      rewardEma,
      rewardEmaDelta,
      modeLocked: rl?.modeLocked === true,
      winRate: p.metrics.winRate,
      expectancyPct: p.metrics.expectancyPct,
      avgWinPct: p.metrics.avgWinPct,
      avgLossPct: p.metrics.avgLossPct,
      profitFactor: p.metrics.profitFactor,
      mfeCapturePct: p.metrics.mfeCapturePct,
      craftCapturePct: craft?.capturePct ?? null,
      givebackPct: craft?.givebackPct ?? null,
      softExitPct: craft?.softExitPct ?? null,
      armedShare,
      discretionaryShare,
      lateChaseShare,
      topEntryFamily,
      governorHints,
      blockers,
      funnel,
      tone,
      summary: buildSummary(rowBase),
    });
  }

  // Sort: weak first (needs attention), then watch, then healthy; within by n desc
  const toneRank = { weak: 0, watch: 1, healthy: 2 };
  profiles.sort(
    (a, b) =>
      toneRank[a.tone] - toneRank[b.tone] ||
      b.n - a.n ||
      a.name.localeCompare(b.name)
  );

  const healthyN = profiles.filter((p) => p.tone === 'healthy').length;
  const weakN = profiles.filter((p) => p.tone === 'weak').length;
  const quietN = profiles.filter((p) => p.n <= 0).length;
  const funnel = el.funnel;
  const convBits: string[] = [];
  if (funnel?.armToTriggerPct != null) {
    convBits.push(`arm→trig ${funnel.armToTriggerPct}%`);
  }
  if (funnel?.triggerToOpenPct != null) {
    convBits.push(`trig→open ${funnel.triggerToOpenPct}%`);
  }
  if (funnel?.armToOpenPct != null) {
    convBits.push(`arm→open ${funnel.armToOpenPct}%`);
  }
  const govImpact = (el.familyRestrictionImpact || [])
    .slice(0, 3)
    .map((r) => `${r.family}=${r.state}`)
    .join(', ');
  const rs = el.repairSession;
  const repairBits: string[] = [];
  if (rs?.zeroMfeShare != null) {
    repairBits.push(`0-MFE ${pct(rs.zeroMfeShare, 0)}`);
  }
  if (rs?.greenThenRedShare != null) {
    repairBits.push(`green→red ${pct(rs.greenThenRedShare, 0)}`);
  }
  if (rs?.topLossProfileId) {
    repairBits.push(
      `top-loss ${rs.topLossProfileId}${
        rs.topLossShare != null ? ` ${pct(rs.topLossShare, 0)}` : ''
      }`
    );
  }
  if ((rs?.govSoftAllow?.softPassNative ?? 0) > 0) {
    repairBits.push(`dip soft-allow ×${rs!.govSoftAllow.softPassNative}`);
  }
  if ((rs?.softMovementGrants ?? 0) > 0) {
    repairBits.push(`soft-move ×${rs!.softMovementGrants}`);
  }
  const plainLanguage =
    `Learning Metrics last ${window}: ${healthyN} healthy · ${weakN} weak · ${quietN} quiet` +
    (convBits.length ? ` · open-conv ${convBits.join(' · ')}` : '') +
    (govImpact ? ` · gov ${govImpact}` : '') +
    (repairBits.length ? ` · ${repairBits.join(' · ')}` : '') +
    ' (read-only).';

  return {
    ok: true,
    window,
    updatedAt: Date.now(),
    profiles,
    plainLanguage,
    repairSummary: {
      zeroMfeShare: rs?.zeroMfeShare ?? null,
      greenThenRedShare: rs?.greenThenRedShare ?? null,
      armedShare: el.mix?.armedShare ?? null,
      govSoftPassNative: rs?.govSoftAllow?.softPassNative ?? 0,
      govDipComparativeSoftAllow:
        rs?.govSoftAllow?.dipComparativeSoftAllow ?? 0,
      softMovementGrants: rs?.softMovementGrants ?? 0,
      softMovementArmsLive: rs?.softMovementArmsLive ?? 0,
      topLossProfileId: rs?.topLossProfileId ?? null,
      topLossShare: rs?.topLossShare ?? null,
    },
    funnelConversion: {
      armed: funnel?.armed ?? null,
      triggered: funnel?.triggered ?? null,
      opened: funnel?.opened ?? null,
      armToTriggerPct: funnel?.armToTriggerPct ?? null,
      triggerToOpenPct: funnel?.triggerToOpenPct ?? null,
      armToOpenPct: funnel?.armToOpenPct ?? null,
    },
    familyRestrictionImpact: el.familyRestrictionImpact ?? [],
  };
}

/** Compact lines for Zion context / answers. */
export function formatLearningMetricsForZion(
  windowRaw: unknown = 50,
  limit = 8
): string[] {
  try {
    const panel = getLearningMetricsPanel(windowRaw);
    const lines: string[] = [`Learning Metrics (last ${panel.window}): ${panel.plainLanguage}`];
    for (const p of panel.profiles.slice(0, limit)) {
      lines.push(`  ${p.summary}`);
      if (p.blockers[0]) lines.push(`    blocker: ${p.blockers[0]}`);
    }
    return lines;
  } catch (err) {
    return [
      `Learning Metrics unavailable: ${err instanceof Error ? err.message : String(err)}`,
    ];
  }
}
