/**
 * Zion performance analyst — read-only briefs + advisory suggestions.
 * Never mutates ML mode, TP/SL, or profile self-learning. Change Requests
 * stay allowlisted globals only (queued by zionAgent when Semi-Autonomous).
 */

import type { ZionChangeRequest } from './zionAgentStore';

export type AnalystActionKind =
  | 'profile'
  | 'ml_mode'
  | 'marl'
  | 'gate'
  | 'learning_mode'
  | 'experiment';

export interface AnalystAction {
  kind: AnalystActionKind;
  title: string;
  detail: string;
  /** Spoken advice only — never auto-applied */
  advisoryOnly?: boolean;
  /** Allowlisted CR payload when Semi-Autonomous is ON */
  changeRequest?: Omit<ZionChangeRequest, 'id' | 'createdAt' | 'status'>;
}

export interface ZionAnalystBrief {
  generatedAt: number;
  observe: string[];
  explain: string[];
  strengths: string[];
  weaknesses: string[];
  actions: AnalystAction[];
  /** Compact context lines for LLM / local pack */
  contextLines: string[];
}

const CACHE_MS = 25_000;
let cache: { at: number; brief: ZionAnalystBrief } | null = null;

function friendlyName(id: string, fallback?: string): string {
  const map: Record<string, string> = {
    scalper: 'Scalper',
    momentum_burst: 'Momentum Burst',
    migration_sniper: 'Migration Sniper',
    dip_buyer: 'Dip Buyer',
    trend_rider: 'Trend Rider',
    steady_compounder: 'Steady Compounder',
    high_win_rate: 'High Win-Rate',
    reversal_scalper: 'Reversal Scalper',
  };
  return fallback || map[id] || id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Build a deep performance / learning brief for Zion (cached ~25s).
 */
export function buildZionAnalystBrief(opts?: {
  force?: boolean;
}): ZionAnalystBrief {
  const now = Date.now();
  if (!opts?.force && cache && now - cache.at < CACHE_MS) {
    return cache.brief;
  }

  const observe: string[] = [];
  const explain: string[] = [];
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const actions: AnalystAction[] = [];
  const contextLines: string[] = [];

  // --- Learning diagnostics ---
  let healthScore = 0;
  let healthLabel = '—';
  let healthBlurb = '';
  let diagProfiles: Array<{
    id: string;
    name: string;
    status: string;
    trend: string;
    mlMode: string;
    episodes: number;
    progressPct: number;
    learnedSummary: string;
    avgTimingReward: number | null;
    botEnabled: boolean;
    improvementPct: number;
  }> = [];
  try {
    const { getLearningSystemDiagnostics } =
      require('./learningSystemDiagnostics') as typeof import('./learningSystemDiagnostics');
    const d = getLearningSystemDiagnostics();
    healthScore = d.healthScore;
    healthLabel = d.healthLabel;
    healthBlurb = d.healthBlurb;
    diagProfiles = d.profiles.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      trend: p.trend,
      mlMode: p.mlMode,
      episodes: p.episodes,
      progressPct: p.progressPct,
      learnedSummary: p.learnedSummary,
      avgTimingReward: p.avgTimingReward,
      botEnabled: p.botEnabled,
      improvementPct: p.improvementPct,
    }));
    observe.push(
      `System Health ${d.healthScore}/100 — ${d.healthLabel}.`
    );
    explain.push(d.healthBlurb);
    contextLines.push(
      `Analyst health: ${d.healthScore}/100 ${d.healthLabel} — ${d.healthBlurb}`
    );
    for (const w of d.warnings.slice(0, 5)) {
      weaknesses.push(w);
      contextLines.push(`  analyst-warn: ${w}`);
    }
    try {
      const { formatFastRecoveryPlainLanguage } =
        require('./fastProfileRecovery') as typeof import('./fastProfileRecovery');
      for (const line of formatFastRecoveryPlainLanguage().slice(0, 3)) {
        explain.push(line);
        contextLines.push(`  recovery: ${line}`);
      }
    } catch {
      /* optional */
    }
    try {
      const { formatDipBuyerRecoveryPlainLanguage } =
        require('./dipBuyerRecovery') as typeof import('./dipBuyerRecovery');
      const dbrLine = formatDipBuyerRecoveryPlainLanguage();
      if (dbrLine) {
        explain.push(dbrLine);
        contextLines.push(`  dip-buyer-recovery: ${dbrLine}`);
      }
    } catch {
      /* optional */
    }
    try {
      const { formatScalperWinRateTrendPlainLanguage } =
        require('./profilePerformanceTrend') as typeof import('./profilePerformanceTrend');
      const scalperLine = formatScalperWinRateTrendPlainLanguage();
      if (scalperLine) {
        explain.push(scalperLine);
        contextLines.push(`  scalper-trend: ${scalperLine}`);
      }
    } catch {
      /* optional */
    }
  } catch {
    observe.push('Learning diagnostics unavailable.');
  }

  // --- Micro-bot performance (7d) ---
  type PerfRow = {
    profileId: string;
    name: string;
    enabled: boolean;
    trades: number;
    winRatePct: number;
    profitFactor: number;
    netPnlSol: number;
    avgPnlPct: number;
    currentStreak?: { kind: string; length: number };
  };
  let perfRows: PerfRow[] = [];
  try {
    const { paperTrader } =
      require('./paperTrader') as typeof import('./paperTrader');
    const perf = paperTrader.getMicroBotPerformance?.('7d');
    perfRows = (perf?.rows || []) as PerfRow[];
    const ranked = [...perfRows]
      .filter((r) => r.trades > 0)
      .sort((a, b) => (b.profitFactor || 0) - (a.profitFactor || 0));
    contextLines.push('Analyst perf 7d (PF / WR / trades / net SOL):');
    for (const r of ranked.slice(0, 10)) {
      contextLines.push(
        `  perf ${friendlyName(r.profileId, r.name)}: PF ${Number(r.profitFactor).toFixed(2)} WR ${Number(r.winRatePct).toFixed(0)}% n=${r.trades} net=${Number(r.netPnlSol).toFixed(3)}`
      );
    }
    if (ranked[0] && ranked[0].trades >= 3) {
      strengths.push(
        `${friendlyName(ranked[0].profileId, ranked[0].name)} leads 7d (PF ${ranked[0].profitFactor.toFixed(2)}, WR ${ranked[0].winRatePct.toFixed(0)}%, ${ranked[0].trades} trades).`
      );
      observe.push(
        `Top 7d lane: ${friendlyName(ranked[0].profileId, ranked[0].name)}.`
      );
    }
    const weak = ranked.filter(
      (r) =>
        r.enabled &&
        r.trades >= 5 &&
        (r.profitFactor < 0.85 || r.winRatePct < 35 || r.netPnlSol < -0.05)
    );
    for (const w of weak.slice(0, 3)) {
      weaknesses.push(
        `${friendlyName(w.profileId, w.name)} is soft on 7d (PF ${w.profitFactor.toFixed(2)}, WR ${w.winRatePct.toFixed(0)}%, net ${w.netPnlSol.toFixed(3)} SOL).`
      );
      actions.push({
        kind: 'profile',
        title: `Review ${friendlyName(w.profileId, w.name)}`,
        detail:
          w.winRatePct < 35
            ? `Raise entry pickiness or pause Learning Mode participate until WR recovers — recent closes look noisy.`
            : `Check giveback / trail timing on Micro Bots; PF under 1 suggests exits need attention.`,
        advisoryOnly: true,
      });
    }
  } catch {
    contextLines.push('Analyst perf: unavailable');
  }

  // --- Timing quality from recent episodes ---
  try {
    const { getProfileLearningEpisodes } =
      require('./profileLearningEpisodes') as typeof import('./profileLearningEpisodes');
    const { TRADE_PROFILE_CATALOG } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    contextLines.push('Analyst timing (recent avg timingReward / entryQ / exitQ):');
    for (const cat of TRADE_PROFILE_CATALOG.slice(0, 10)) {
      const eps = getProfileLearningEpisodes(cat.id, 24);
      if (eps.length < 4) continue;
      const rewards = eps
        .map((e) => e.timingReward)
        .filter((v): v is number => v != null && Number.isFinite(v));
      const entryQs = eps
        .map((e) => e.entryQualityScore)
        .filter((v): v is number => v != null && Number.isFinite(v));
      const exitQs = eps
        .map((e) => e.exitQualityScore)
        .filter((v): v is number => v != null && Number.isFinite(v));
      const avgR =
        rewards.length > 0
          ? rewards.reduce((a, b) => a + b, 0) / rewards.length
          : null;
      const avgEntry =
        entryQs.length > 0
          ? entryQs.reduce((a, b) => a + b, 0) / entryQs.length
          : null;
      const avgExit =
        exitQs.length > 0
          ? exitQs.reduce((a, b) => a + b, 0) / exitQs.length
          : null;
      contextLines.push(
        `  timing ${friendlyName(cat.id, cat.name)}: n=${eps.length}` +
          (avgR != null ? ` reward=${avgR.toFixed(1)}` : '') +
          (avgEntry != null ? ` entryQ=${avgEntry.toFixed(0)}` : '') +
          (avgExit != null ? ` exitQ=${avgExit.toFixed(0)}` : '')
      );
      if (avgExit != null && avgExit < 40 && eps.length >= 8) {
        weaknesses.push(
          `${friendlyName(cat.id, cat.name)} exit quality is low (~${avgExit.toFixed(0)}) — leaving MFE on the table.`
        );
        actions.push({
          kind: 'profile',
          title: `${friendlyName(cat.id, cat.name)} exit capture`,
          detail:
            'Watch Self-Learn timing deltas (trail arm / tighten). Keep ML on hybrid+ once sample is solid so exits can tighten from giveback.',
          advisoryOnly: true,
        });
      }
      if (avgEntry != null && avgEntry < 40 && eps.length >= 8) {
        actions.push({
          kind: 'gate',
          title: 'Consider a slightly higher conviction floor',
          detail: `${friendlyName(cat.id, cat.name)} entries look late/noisy (entry quality ~${avgEntry.toFixed(0)}). A modest global conviction bump may help — reviewable only.`,
          changeRequest: {
            title: 'Nudge global conviction floor',
            what: 'Raise selective.minConvictionScore modestly to cut weak entries.',
            why: `${friendlyName(cat.id, cat.name)} recent entry quality is soft (~${avgEntry.toFixed(0)}).`,
            expectedBenefit: 'Fewer weak opens; slightly fewer fills.',
            target: 'global_gates',
            payload: { path: 'selective.minConvictionScore', value: 55 },
          },
        });
      }
    }
  } catch {
    /* optional */
  }

  // --- ML mode advice (advisory only — never CR that applies mlMode) ---
  for (const p of diagProfiles) {
    if (!p.botEnabled) continue;
    contextLines.push(
      `  ml ${p.name}: ${p.mlMode} · ${p.status} · ${p.episodes} eps · ${p.trend} · ${p.learnedSummary}`
    );
    if (
      p.mlMode === 'shadow' &&
      p.episodes >= 50 &&
      p.status !== 'Paused'
    ) {
      actions.push({
        kind: 'ml_mode',
        title: `${p.name}: ready to consider Hybrid`,
        detail: `${p.episodes} closed trades — enough sample for Hybrid blend. Auto-promote may already move it; if stuck on Shadow, check holdout / validated badge on Micro Bots. Do not force Lead yet.`,
        advisoryOnly: true,
      });
    }
    if (p.mlMode === 'hybrid' && p.episodes >= 200 && p.trend === 'Improving') {
      actions.push({
        kind: 'ml_mode',
        title: `${p.name}: Lead candidate`,
        detail:
          'Strong sample + improving trend — Lead is the healthy end-state when holdout stays ≥0.58. Auto-promote handles this; Isaac can confirm ML=lead on the card if needed.',
        advisoryOnly: true,
      });
    }
    if (p.mlMode === 'lead' && p.trend === 'Declining' && p.episodes >= 40) {
      actions.push({
        kind: 'ml_mode',
        title: `${p.name}: consider Hybrid (not Lead)`,
        detail:
          'Lead with a declining trend — soft-demote may return to Hybrid. Prefer Hybrid until holdout recovers. Zion will not change ML for you.',
        advisoryOnly: true,
      });
    }
    if (p.trend === 'Improving' && p.episodes >= 12) {
      strengths.push(`${p.name} learning trend is Improving (${p.learnedSummary})`);
    }
  }

  // --- MARL ---
  try {
    const { getMarlStatus } =
      require('./marlCoordinator') as typeof import('./marlCoordinator');
    const m = getMarlStatus();
    observe.push(`MARL ${m.enabled ? 'ON' : 'OFF'} · ${m.strength} · ${m.label}`);
    contextLines.push(`Analyst MARL: ${m.label}`);
    for (const d of (m.decisions || []).slice(0, 5)) {
      contextLines.push(`  marl-dec: ${d.kind} — ${d.detail}`);
    }
    if (!m.enabled) {
      actions.push({
        kind: 'marl',
        title: 'Turn on MARL soft coordination',
        detail:
          'MARL only reorders lanes / trims size / limits low-MC pile-ins — never TP/SL. Medium is a sensible start.',
        changeRequest: {
          title: 'Enable MARL at medium strength',
          what: 'Turn Multi-Agent RL on with medium influence.',
          why: 'Lane coordination is off — bots may pile into the same mint without soft ranking.',
          expectedBenefit: 'Clearer lane priority and fewer low-MC pile-ins.',
          target: 'global_gates',
          payload: { path: 'marl.enabled', value: true },
        },
      });
      actions.push({
        kind: 'marl',
        title: 'Set MARL strength medium',
        detail: 'After enable, keep strength at medium unless Isaac wants gentler/harsher coordination.',
        changeRequest: {
          title: 'MARL strength → medium',
          what: 'Set marl.strength to medium.',
          why: 'Balanced soft influence without aggressive size cuts.',
          expectedBenefit: 'Smoother multi-bot coordination.',
          target: 'global_gates',
          payload: { path: 'marl.strength', value: 'medium' },
        },
      });
    } else if (m.strength === 'low') {
      actions.push({
        kind: 'marl',
        title: 'Raise MARL influence to medium',
        detail: 'Low influence is gentle — medium usually matches a multi-bot book better.',
        changeRequest: {
          title: 'MARL strength → medium',
          what: 'Increase marl.strength from low to medium.',
          why: 'Soft coordination is barely steering lane order / size.',
          expectedBenefit: 'Clearer priority without touching exits.',
          target: 'global_gates',
          payload: { path: 'marl.strength', value: 'medium' },
        },
      });
    } else {
      strengths.push(`MARL is active (${m.strength}) — soft lane/size coordination only.`);
    }
  } catch {
    /* */
  }

  // --- Profile RL + Learning Accelerators ---
  try {
    const { getProfileRlStatus, formatProfileRlPlainLanguage } =
      require('./profileRlAgent') as typeof import('./profileRlAgent');
    const prl = getProfileRlStatus({ persist: false, ensureKeyAgents: false });
    contextLines.push(`Analyst Profile RL: ${prl.label}`);
    for (const a of prl.agents.slice(0, 5)) {
      const plain =
        a.plainLanguage || formatProfileRlPlainLanguage(a.profileId);
      const ready = a.readinessScore != null ? `${a.readinessScore}/100` : '—';
      const lock = a.modeLocked ? ' locked' : '';
      contextLines.push(
        `  prl ${a.profileId}: ${a.mode} · ready ${ready}${lock} · ${String(plain).slice(0, 90)}`
      );
    }
    if (!prl.enabled) {
      actions.push({
        kind: 'profile',
        title: 'Consider Profile RL (soft)',
        detail:
          'Per-lane confidence/size and TA sensitivity — shadow first. Never TP/SL. Enable on Micro Bots → Profile RL.',
        advisoryOnly: true,
      });
    }
  } catch {
    /* optional */
  }
  try {
    const { getLearningAcceleratorsStatus, formatReplayPlainLanguage } =
      require('./learningReplayBuffer') as typeof import('./learningReplayBuffer');
    const { formatCounterfactualPlainLanguage } =
      require('./learningCounterfactual') as typeof import('./learningCounterfactual');
    const { formatTeacherStudentPlainLanguage } =
      require('./learningTeacherStudent') as typeof import('./learningTeacherStudent');
    const acc = getLearningAcceleratorsStatus();
    contextLines.push(`Analyst Accelerators: ${acc.label}`);
    for (const pid of ['scalper', 'dip_buyer', 'trend_rider', 'momentum_burst']) {
      const bits = [
        formatReplayPlainLanguage(pid),
        formatCounterfactualPlainLanguage(pid),
        formatTeacherStudentPlainLanguage(pid),
      ].filter(Boolean);
      if (bits.length) {
        contextLines.push(`  accel ${pid}: ${bits.join(' · ').slice(0, 120)}`);
      }
    }
  } catch {
    /* optional */
  }

  // --- Learning Enhancements ---
  try {
    const { getLearningEnhancementsStatus, formatLearningEnhancementsPlainLanguage } =
      require('./learningEnhancements') as typeof import('./learningEnhancements');
    const le = getLearningEnhancementsStatus();
    contextLines.push(`Analyst Enhancements: ${le.label}`);
    contextLines.push(`  ${formatLearningEnhancementsPlainLanguage()}`);
    if (le.config.enabled && !le.config.schedulerEnabled) {
      actions.push({
        kind: 'profile',
        title: 'Enable enhancement scheduler',
        detail: 'Continuous soft learning ticks when new episodes arrive — no hard mutations.',
        advisoryOnly: true,
      });
    }
    for (const w of le.watchdogWarnings.slice(0, 3)) {
      observe.push(`Enhancement watchdog: ${w}`);
    }
  } catch {
    /* optional */
  }

  // --- Skips ---
  try {
    const { getSkipReasonCounts } =
      require('./monitor') as typeof import('./monitor');
    const skips = getSkipReasonCounts?.() || [];
    contextLines.push('Analyst top skips:');
    for (const s of skips.slice(0, 8)) {
      contextLines.push(`  skip ${s.reason}: ${s.count}`);
    }
    const top = skips[0];
    if (top && Number(top.count) >= 5) {
      observe.push(`Top skip: ${top.reason} (${top.count}).`);
      explain.push(
        `Many declines on “${top.reason}” — either the filter is doing its job or the floor is too tight for the current book.`
      );
      if (/conviction|score/i.test(String(top.reason))) {
        actions.push({
          kind: 'gate',
          title: 'Review conviction vs skip pressure',
          detail:
            'If fills dried up, ease conviction slightly; if junk opens rose, keep or raise it. Change Request is review-only.',
          changeRequest: {
            title: 'Review conviction floor vs skips',
            what: 'Revisit selective.minConvictionScore against the top skip reason.',
            why: `Top skip is ${top.reason} (${top.count}).`,
            expectedBenefit: 'Better balance of fills vs quality.',
            target: 'global_gates',
            payload: { path: 'selective.minConvictionScore', value: 50 },
          },
        });
      }
      if (/ta|setup/i.test(String(top.reason))) {
        actions.push({
          kind: 'gate',
          title: 'Require TA is blocking many entries',
          detail:
            'Keep Require TA for safety on most lanes; Scalper/specialty already bypass when they win. Don’t disable casually.',
          advisoryOnly: true,
        });
      }
    }
  } catch {
    /* */
  }

  // --- Learning Mode ---
  try {
    const { getLearningModeStatus } =
      require('./learningMode') as typeof import('./learningMode');
    const lm = getLearningModeStatus();
    contextLines.push(`Analyst LM: ${lm.label}`);
    if (!lm.enabled && healthScore < 60) {
      actions.push({
        kind: 'learning_mode',
        title: 'Learning Mode is optional throughput',
        detail:
          'LM softens entry floors — it is not required for Self-Learn. Leave OFF if Isaac wants higher-quality fewer trades; turn on only to soak more samples.',
        advisoryOnly: true,
      });
    }
  } catch {
    /* */
  }

  // --- Experiments (advisory) ---
  if (diagProfiles.some((p) => p.episodes < 20 && p.botEnabled)) {
    actions.push({
      kind: 'experiment',
      title: 'Let thin bots soak more closes',
      detail:
        'Several bots are still early — avoid heavy knob changes until ≥20–50 closes. Timing reward fields already enrich learning; no new settings needed.',
      advisoryOnly: true,
    });
  }
  if (healthScore >= 75) {
    strengths.push('Overall learning stack looks healthy enough to keep compounding.');
  }

  // Dedupe actions by title
  const seen = new Set<string>();
  const uniqActions = actions.filter((a) => {
    if (seen.has(a.title)) return false;
    seen.add(a.title);
    return true;
  });

  const brief: ZionAnalystBrief = {
    generatedAt: now,
    observe: observe.slice(0, 8),
    explain: explain.slice(0, 6),
    strengths: [...new Set(strengths)].slice(0, 6),
    weaknesses: [...new Set(weaknesses)].slice(0, 6),
    actions: uniqActions.slice(0, 8),
    contextLines: contextLines.slice(0, 80),
  };
  cache = { at: now, brief };
  return brief;
}

/** Format brief as natural Zion reply (local fallback / proactive). */
export function formatAnalystReply(
  brief: ZionAnalystBrief,
  opts?: { greet?: string; focus?: string }
): string {
  const greet = opts?.greet || 'Hey Isaac — here’s the performance read.';
  const lines: string[] = [greet, ''];
  lines.push('**Observe**');
  for (const o of brief.observe.slice(0, 4)) lines.push(`· ${o}`);
  if (brief.explain.length) {
    lines.push('', '**Explain**');
    for (const e of brief.explain.slice(0, 3)) lines.push(`· ${e}`);
  }
  if (brief.strengths.length) {
    lines.push('', '**Strengths**');
    for (const s of brief.strengths.slice(0, 3)) lines.push(`· ${s}`);
  }
  if (brief.weaknesses.length) {
    lines.push('', '**Weak spots**');
    for (const w of brief.weaknesses.slice(0, 3)) lines.push(`· ${w}`);
  }
  if (brief.actions.length) {
    lines.push('', '**Next actions**');
    for (const a of brief.actions.slice(0, 4)) {
      const tag = a.advisoryOnly ? ' (advice only)' : ' (reviewable request if Semi-Autonomous)';
      lines.push(`· ${a.title}: ${a.detail}${tag}`);
    }
  }
  if (opts?.focus) {
    lines.push('', `Focus: ${opts.focus}`);
  }
  lines.push(
    '',
    'I won’t change micro-bot ML or TP/SL myself — approve any Change Request if you want a global tweak.'
  );
  return lines.join('\n');
}

/** Pick best allowlisted Change Request from the brief. */
export function pickAnalystChangeRequest(
  brief: ZionAnalystBrief
): Omit<ZionChangeRequest, 'id' | 'createdAt' | 'status'> | null {
  for (const a of brief.actions) {
    if (a.advisoryOnly || !a.changeRequest) continue;
    const path = String(a.changeRequest.payload?.path || '');
    if (!path) continue;
    // Hard block: never queue ML / profile exit payloads
    if (
      /mlMode|selfLearning|exitRules|takeProfit|stopLoss/i.test(
        JSON.stringify(a.changeRequest.payload || {})
      )
    ) {
      continue;
    }
    return a.changeRequest;
  }
  return null;
}

export function wantsPerformanceAnalysis(q: string): boolean {
  return /performance|analys[ea]|how.*(bot|system|we|learning)|health score|what should|suggest|recommend|improve|weak|strength|diagnos|review (the )?bots|proactive|next (step|action)/i.test(
    q
  );
}
