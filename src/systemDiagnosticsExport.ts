/**
 * Read-only system diagnostics export for AI agents (Grok / Cursor).
 * Aggregates Expectancy Lift, Learning Metrics, Trade Craft, funnel, governors.
 * No trading-logic side effects.
 */

import { config } from './config';
import { paperTrader } from './paperTrader';
import {
  getExpectancyLiftStatus,
  parseExpectancyWindow,
  type ExpectancyWindow,
} from './expectancyLift';
import { getLearningMetricsPanel } from './learningMetricsPanel';
import { buildTradeCraftPerformance } from './tradeCraftPerformance';

function pad(s: string, n: number): string {
  const t = String(s ?? '');
  if (t.length >= n) return t.slice(0, n);
  return t + ' '.repeat(n - t.length);
}

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return Number(n).toFixed(digits);
}

function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

function fmtSignedPct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const v = Number(n);
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

function modeLabel(): string {
  const m = String(config.mode || 'paper');
  if (m === 'liveSimulation') return 'live_sim';
  if (m === 'live') return 'live';
  return 'paper';
}

function deriveOperatorFlags(input: {
  expectancyPct: number | null;
  armedShare: number | null;
  armedTarget: number;
  lateChaseShare: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  armToOpenPct: number | null;
  triggerToOpenPct: number | null;
  maxDrawdownPct: number | null;
  quietSteadyHwr: string[];
  restrictedPositiveNative: string[];
}): string[] {
  const flags: string[] = [];
  if (input.expectancyPct != null && input.expectancyPct < 0) {
    flags.push(`negative_expectancy E=${fmtSignedPct(input.expectancyPct)}`);
  }
  if (
    input.armedShare != null &&
    input.armedShare * 100 < input.armedTarget - 5
  ) {
    flags.push(
      `armed_below_target ${(input.armedShare * 100).toFixed(0)}% < ${input.armedTarget}%`
    );
  }
  if (input.lateChaseShare != null && input.lateChaseShare > 0.05) {
    flags.push(
      `late_chase_above_target ${(input.lateChaseShare * 100).toFixed(0)}% > 5%`
    );
  }
  if (
    input.avgWinPct != null &&
    input.avgLossPct != null &&
    Math.abs(input.avgLossPct) > Math.abs(input.avgWinPct)
  ) {
    flags.push(
      `avg_loss_gt_avg_win avgW=${fmtNum(input.avgWinPct, 1)}% avgL=${fmtNum(input.avgLossPct, 1)}%`
    );
  }
  for (const q of input.quietSteadyHwr) {
    flags.push(`quiet_steady_hwr ${q}`);
  }
  for (const r of input.restrictedPositiveNative) {
    flags.push(`restricted_positive_native ${r}`);
  }
  if (input.maxDrawdownPct != null && input.maxDrawdownPct > 100.5) {
    flags.push(`max_dd_anomaly ${fmtNum(input.maxDrawdownPct, 1)}%`);
  }
  if (
    (input.triggerToOpenPct != null && input.triggerToOpenPct < 15) ||
    (input.armToOpenPct != null && input.armToOpenPct < 10)
  ) {
    flags.push(
      `weak_open_conversion trig→open=${input.triggerToOpenPct ?? '—'}% arm→open=${input.armToOpenPct ?? '—'}%`
    );
  }
  return flags;
}

export interface SystemDiagnosticsExportResult {
  ok: true;
  generatedAt: number;
  mode: string;
  window: ExpectancyWindow;
  reportText: string;
  meta: {
    profileCount: number;
    familyCount: number;
    flagCount: number;
  };
}

/**
 * Build a full AI-readable plain-text system report (read-only).
 */
export function buildSystemDiagnosticsExport(
  windowRaw: unknown = 50
): SystemDiagnosticsExportResult {
  const window = parseExpectancyWindow(windowRaw);
  const generatedAt = Date.now();
  const el = getExpectancyLiftStatus(window);
  const lm = getLearningMetricsPanel(window);
  let craft: ReturnType<typeof buildTradeCraftPerformance> | null = null;
  try {
    craft = buildTradeCraftPerformance('all', window);
  } catch {
    craft = null;
  }

  const stats = paperTrader.getStats();
  const balance = Number(stats.balanceSol) || 0;
  const equity =
    Number((stats as { equitySol?: number }).equitySol) ||
    balance + (Number((stats as { unrealizedPnlSol?: number }).unrealizedPnlSol) || 0);
  const available =
    Number((stats as { availableSol?: number }).availableSol) || balance;
  const openCount = Number(stats.openCount ?? stats.openTrades) || 0;
  const realized =
    Number((stats as { realizedPnlSol?: number }).realizedPnlSol) ||
    Number(stats.netPnlSol) ||
    0;
  const unrealized =
    Number((stats as { unrealizedPnlSol?: number }).unrealizedPnlSol) || 0;
  const daily = Number(stats.dailyPnlSol) || 0;

  const overall = el.profiles.length
    ? {
        // Use mix + family skill; overall metrics from status plain / compute via profiles aggregate
        winRate: null as number | null,
        expectancyPct: null as number | null,
        profitFactor: null as number | null,
        avgWinPct: null as number | null,
        avgLossPct: null as number | null,
        mfeCapturePct: null as number | null,
        tradeCount: 0,
      }
    : null;

  // Prefer combined craft + expectancy from status chart window trades via family skill memory
  try {
    const { collectExpectancyTrades, computeExpectancyMetrics } =
      require('./expectancyLift') as typeof import('./expectancyLift');
    const trades = collectExpectancyTrades().slice(-window);
    const m = computeExpectancyMetrics(trades);
    if (overall) {
      overall.winRate = m.winRate;
      overall.expectancyPct = m.expectancyPct;
      overall.profitFactor = m.profitFactor;
      overall.avgWinPct = m.avgWinPct;
      overall.avgLossPct = m.avgLossPct;
      overall.mfeCapturePct = m.mfeCapturePct;
      overall.tradeCount = m.tradeCount;
    }
  } catch {
    /* soft */
  }

  const mix = el.mix;
  const funnel = el.funnel;
  const armedTarget =
    el.entrySkillArmedTargetEffectivePct ??
    el.targets?.armedTargetPct ??
    el.entrySkillArmedTargetPct ??
    80;

  const quietSteadyHwr = (el.quietChips || [])
    .filter(
      (c) =>
        c.profileId === 'steady_compounder' || c.profileId === 'high_win_rate'
    )
    .map((c) => `${c.label}: ${c.reason}`);

  const restrictedPositiveNative = (el.familyRestrictionImpact || [])
    .filter(
      (r) =>
        r.state === 'restricted' &&
        r.expectancyPct != null &&
        r.expectancyPct > -0.5 &&
        (r.winRate == null || r.winRate >= 0.3)
    )
    .map(
      (r) =>
        `${r.family} E=${fmtSignedPct(r.expectancyPct)} natives=${(r.nativeProfiles || []).join('/')}`
    );

  const flags = deriveOperatorFlags({
    expectancyPct: overall?.expectancyPct ?? null,
    armedShare: mix.armedShare,
    armedTarget,
    lateChaseShare: mix.lateChaseShare,
    avgWinPct: overall?.avgWinPct ?? null,
    avgLossPct: overall?.avgLossPct ?? null,
    armToOpenPct: funnel.armToOpenPct ?? null,
    triggerToOpenPct: funnel.triggerToOpenPct ?? null,
    maxDrawdownPct: Number(stats.maxDrawdownPct) || null,
    quietSteadyHwr,
    restrictedPositiveNative,
  });

  const harvestTrait = craft?.traits?.find((t) => t.id === 'harvest');
  const exitsTrait = craft?.traits?.find((t) => t.id === 'exits');
  const captureCombined =
    harvestTrait?.kpis?.capturePct != null
      ? Number(harvestTrait.kpis.capturePct)
      : overall?.mfeCapturePct ?? mix.avgMfeCapture;
  const givebackCombined =
    harvestTrait?.kpis?.givebackPct != null
      ? Number(harvestTrait.kpis.givebackPct)
      : null;
  const scratchyCombined =
    harvestTrait?.kpis?.scratchPct != null
      ? Number(harvestTrait.kpis.scratchPct)
      : null;

  const lines: string[] = [];
  lines.push('=== CRYPTO BOT SYSTEM DIAGNOSTICS EXPORT ===');
  lines.push(`generatedAt: ${new Date(generatedAt).toISOString()}`);
  lines.push(`window: last_${window}`);
  lines.push(`mode: ${modeLabel()}`);
  lines.push(
    `admission: ${el.admissionBaseline}${el.armedTargetEBoost ? ' · armed_target_e_boost' : ''}`
  );
  lines.push('');
  lines.push('--- 1. SNAPSHOT HEADER ---');
  lines.push(
    `equity=${fmtNum(equity, 4)} SOL · available=${fmtNum(available, 4)} · positions=${openCount} · openCount=${openCount}`
  );
  lines.push(
    `realized=${fmtNum(realized, 4)} · unrealized=${fmtNum(unrealized, 4)} · dailyPnL=${fmtNum(daily, 4)} SOL`
  );
  lines.push(
    `combined WR=${fmtPct(overall?.winRate ?? null, 1)} n=${overall?.tradeCount ?? 0} E=${fmtSignedPct(overall?.expectancyPct)} PF=${fmtNum(overall?.profitFactor, 2)} avgW=${fmtNum(overall?.avgWinPct, 1)}% avgL=${fmtNum(overall?.avgLossPct, 1)}%`
  );
  lines.push(
    `capture=${fmtNum(captureCombined, 0)}% giveback=${fmtNum(givebackCombined, 0)}% scratchy=${fmtNum(scratchyCombined, 0)}% softExit=${fmtNum(exitsTrait?.kpis?.softExitPct != null ? Number(exitsTrait.kpis.softExitPct) : null, 0)}% partial=${fmtPct(mix.firstPartialRate, 0)}`
  );
  lines.push(
    `armed=${fmtPct(mix.armedShare, 0)} (target ${armedTarget}%) disc=${fmtPct(mix.discretionaryShare, 0)} late-chase=${fmtPct(mix.lateChaseShare, 0)}`
  );
  lines.push(
    `funnel armed=${funnel.armed} trig=${funnel.triggered} open=${funnel.opened} blocked=${funnel.blocked} · arm→trig=${funnel.armToTriggerPct ?? '—'}% trig→open=${funnel.triggerToOpenPct ?? '—'}% arm→open=${funnel.armToOpenPct ?? '—'}% openRate=${funnel.openRatePct ?? '—'}%`
  );
  lines.push(`maxDD=${fmtNum(stats.maxDrawdownPct, 1)}% · 2nd-pass=${el.blockedSecondPass ?? 0}`);
  lines.push('');

  lines.push('--- 2. PROFILE TABLE ---');
  lines.push(
    pad('profile', 18) +
      pad('n', 5) +
      pad('WR', 7) +
      pad('E%', 8) +
      pad('PF', 6) +
      pad('avgW', 7) +
      pad('avgL', 7) +
      pad('cap%', 6) +
      pad('gb%', 6) +
      pad('soft%', 6) +
      pad('arm%', 6) +
      pad('disc%', 6) +
      pad('late%', 6) +
      pad('RL', 8) +
      pad('ready', 6) +
      pad('EMA', 7) +
      pad('status', 8) +
      'blocker / funnel'
  );

  const lmById = new Map(lm.profiles.map((p) => [p.profileId, p]));
  const craftRows = craft?.bots || [];
  const craftById = new Map(craftRows.map((p) => [p.profileId, p]));

  const profilesSorted = [...el.profiles].sort((a, b) =>
    a.profileId.localeCompare(b.profileId)
  );
  for (const p of profilesSorted) {
    const lmP = lmById.get(p.profileId);
    const cr = craftById.get(p.profileId);
    const n = p.metrics.tradeCount;
    const status =
      p.quiet
        ? 'quiet'
        : lmP?.tone === 'weak'
          ? 'weak'
          : lmP?.tone === 'watch'
            ? 'watch'
            : n >= 5 && (p.metrics.expectancyPct ?? -1) >= 0
              ? 'healthy'
              : n > 0
                ? 'watch'
                : 'quiet';
    const disc =
      p.armedShare != null ? Math.max(0, 1 - p.armedShare) : null;
    const skill = el.entrySkillByProfile?.[p.profileId];
    const funnelStr = skill
      ? `a${skill.armed}/t${skill.triggered}/o${skill.opened}/x${skill.expired}`
      : lmP?.funnel
        ? `c${lmP.funnel.candidates ?? '—'}/a${lmP.funnel.armed ?? '—'}/t${lmP.funnel.triggered ?? '—'}/o${lmP.funnel.opened ?? '—'}/cl${lmP.funnel.closed ?? '—'}`
        : '—';
    const blocker = (lmP?.blockers || [])[0] || p.quietReason || '—';
    lines.push(
      pad(p.profileId, 18) +
        pad(String(n), 5) +
        pad(fmtPct(p.metrics.winRate, 0), 7) +
        pad(fmtSignedPct(p.metrics.expectancyPct), 8) +
        pad(fmtNum(p.metrics.profitFactor, 2), 6) +
        pad(fmtNum(p.metrics.avgWinPct, 1), 7) +
        pad(fmtNum(p.metrics.avgLossPct, 1), 7) +
        pad(fmtNum(cr?.capturePct ?? p.metrics.mfeCapturePct, 0), 6) +
        pad(fmtNum(cr?.givebackPct ?? lmP?.givebackPct, 0), 6) +
        pad(fmtNum(cr?.softExitPct ?? lmP?.softExitPct, 0), 6) +
        pad(fmtPct(p.armedShare, 0), 6) +
        pad(fmtPct(disc, 0), 6) +
        pad(fmtPct(p.lateChaseShare, 0), 6) +
        pad(String(lmP?.rlMode ?? '—'), 8) +
        pad(fmtNum(lmP?.readinessScore, 0), 6) +
        pad(fmtNum(lmP?.rewardEma, 2), 7) +
        pad(status, 8) +
        `${blocker} · ${funnelStr}`
    );
  }
  lines.push('');

  lines.push('--- 3. FAMILY GOVERNOR TABLE ---');
  lines.push(
    pad('family', 28) +
      pad('gov', 12) +
      pad('n', 5) +
      pad('WR', 7) +
      pad('E%', 8) +
      pad('avgW', 7) +
      pad('avgL', 7) +
      pad('cap%', 6) +
      'note'
  );
  const fams = [...(el.families || [])].sort((a, b) =>
    a.family.localeCompare(b.family)
  );
  for (const f of fams) {
    lines.push(
      pad(f.family, 28) +
        pad(f.state, 12) +
        pad(String(f.metrics.tradeCount), 5) +
        pad(fmtPct(f.metrics.winRate, 0), 7) +
        pad(fmtSignedPct(f.metrics.expectancyPct), 8) +
        pad(fmtNum(f.metrics.avgWinPct, 1), 7) +
        pad(fmtNum(f.metrics.avgLossPct, 1), 7) +
        pad(fmtNum(f.metrics.mfeCapturePct, 0), 6) +
        String(f.note || '—').slice(0, 80)
    );
  }
  if (el.familyRestrictionImpact?.length) {
    lines.push('restriction_impact:');
    for (const r of el.familyRestrictionImpact) {
      lines.push(
        `  ${r.family}=${r.state} natives=[${(r.nativeProfiles || []).join(', ')}] E=${fmtSignedPct(r.expectancyPct)} · ${r.note}`
      );
    }
  }
  lines.push('');

  lines.push('--- 4. TOP SKIP REASONS ---');
  try {
    const { getSetupWatchDiagnostics } =
      require('./profileAttention') as typeof import('./profileAttention');
    const d = getSetupWatchDiagnostics();
    const reasons = (d.blockReasons || []).slice(0, 15);
    if (!reasons.length) {
      lines.push('(none recorded in window)');
    } else {
      reasons.forEach((r: { reason: string; count: number }, i: number) => {
        lines.push(`${i + 1}. ${r.count}× ${String(r.reason).slice(0, 120)}`);
      });
    }
  } catch {
    lines.push('(diagnostics unavailable)');
  }
  lines.push('');

  lines.push('--- 5. TRADE CRAFT SUMMARY ---');
  if (craft) {
    lines.push(
      `combined craftScore=${fmtNum(craft.craftScore, 1)} trend=${craft.trend ?? '—'} n=${craft.n}`
    );
    lines.push(
      `capture=${fmtNum(captureCombined, 0)}% giveback=${fmtNum(givebackCombined, 0)}% scratchy=${fmtNum(scratchyCombined, 0)}%`
    );
    lines.push(craft.plainLanguage || '');
    const byP = [...(craft.bots || [])]
      .filter((p) => (p.n ?? 0) > 0 || p.craftScore != null)
      .sort((a, b) => String(a.profileId).localeCompare(String(b.profileId)));
    for (const p of byP) {
      lines.push(
        `  ${pad(p.profileId, 18)} craft=${fmtNum(p.craftScore, 1)} cap=${fmtNum(p.capturePct, 0)}% gb=${fmtNum(p.givebackPct, 0)}% soft=${fmtNum(p.softExitPct, 0)}% n=${p.n ?? 0}`
      );
    }
  } else {
    lines.push('(trade craft unavailable)');
  }
  lines.push('');

  lines.push('--- 6. KNOWN ISSUES / OPERATOR FLAGS ---');
  if (!flags.length) {
    lines.push('(none auto-derived)');
  } else {
    flags.forEach((f, i) => lines.push(`${i + 1}. ${f}`));
  }
  lines.push('');
  lines.push('--- FOOTER ---');
  lines.push(
    'Read-only export. No trading side effects. Paste into Grok/Cursor for next-upgrade prompts.'
  );
  lines.push(
    'Episode CSV offline: npx tsx scripts/exportLearningDataset.ts'
  );
  lines.push('=== END EXPORT ===');

  const reportText = lines.join('\n');
  return {
    ok: true,
    generatedAt,
    mode: modeLabel(),
    window,
    reportText,
    meta: {
      profileCount: profilesSorted.length,
      familyCount: fams.length,
      flagCount: flags.length,
    },
  };
}
