/**
 * Read-only Learning Report for Stats → Export Data.
 * Last 50/100 closed trades as an evaluation package for Cursor.
 * No trading-logic side effects.
 */

import { config } from './config';
import { paperTrader } from './paperTrader';
import {
  classifyTradeFamily,
  collectExpectancyTrades,
  computeExpectancyMetrics,
  getExpectancyLiftStatus,
  parseExpectancyWindow,
  type ExpectancyWindow,
} from './expectancyLift';
import { getLearningMetricsPanel } from './learningMetricsPanel';
import { getLearningModeStatus } from './learningMode';
import {
  getProfileLearningEpisodes,
  type ProfileLearningEpisode,
} from './profileLearningEpisodes';
import { TRADE_PROFILE_CATALOG } from './tradeProfiles';
import { MEDIUM_MIN_MC_USD, MAJORS_MIN_MC_USD } from './majorsUniverse';

export type LearningReportWindow = 50 | 100;

export const CURSOR_LEARNING_REPORT_PREAMBLE = `Evaluate this learning report carefully.
Propose only small additive improvements toward higher expectancy and more stable 40–45% WR, with stretch path to 60%+.
Do not rewrite architecture.
Do not loosen late-chase bans.
Do not re-open Scalper spam.
Prefer profile-specific habit fixes, harvest/capture improvements, and quiet-profile arming quality.
Return exact Cursor-ready patch prompts only if changes are justified by the data.

---
`;

export interface LearningTradeSampleRow {
  profile: string;
  token: string;
  mint: string;
  entryStyle: string | null;
  family: string;
  armed: boolean;
  lateChase: boolean;
  openedAt: number;
  closedAt: number;
  holdMs: number;
  maxRunupPct: number;
  maxDrawdownPct: number;
  exitReason: string;
  pnlPct: number;
  pnlSol: number;
  mfeCapturePct: number | null;
}

export interface LearningReportProfileRow {
  profileId: string;
  name: string;
  n: number;
  winRate: number | null;
  expectancyPct: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  profitFactor: number | null;
  mfeCapturePct: number | null;
  armedShare: number | null;
  lateChaseShare: number | null;
  rlMode: string | null;
  readinessScore: number | null;
  quiet: boolean;
  quietReason: string | null;
}

export interface LearningReportJson {
  summary: {
    window: LearningReportWindow;
    mode: string;
    generatedAt: number;
    tradeCount: number;
    openCount: number;
    closedCountApprox: number;
    winRate: number | null;
    expectancyPct: number | null;
    profitFactor: number | null;
    armedShare: number | null;
    lateChaseShare: number | null;
    mfeCapturePct: number | null;
    plainLanguage: string | null;
  };
  profiles: LearningReportProfileRow[];
  trades: LearningTradeSampleRow[];
  diagnostics: {
    topExitReasons: Array<{ reason: string; count: number; share: number }>;
    topSkipNotes: string[];
    starvedNotes: string[];
  };
  configSnapshot: Record<string, unknown>;
}

export interface LearningReportResult {
  ok: true;
  generatedAt: number;
  mode: string;
  window: LearningReportWindow;
  reportText: string;
  reportJson: LearningReportJson;
  cursorPackageText: string;
  meta: {
    tradeCount: number;
    profileCount: number;
    openCount: number;
  };
}

function modeLabel(): string {
  const m = String(config.mode || 'paper');
  if (m === 'liveSimulation') return 'live_sim';
  if (m === 'live') return 'live';
  return 'paper';
}

/** Learning Report only supports 50/100 (20 coerced to 50). */
export function parseLearningReportWindow(raw: unknown): LearningReportWindow {
  const w = parseExpectancyWindow(raw);
  return w === 100 ? 100 : 50;
}

function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return Number(n).toFixed(digits);
}

function fmtSignedPct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const v = Number(n);
  const s = v >= 0 ? '+' : '';
  return `${s}${v.toFixed(digits)}%`;
}

function holdLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h${rem}m` : `${h}h`;
}

function iso(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  try {
    return new Date(ts).toISOString();
  } catch {
    return '—';
  }
}

function collectWindowEpisodes(window: number): ProfileLearningEpisode[] {
  const all: ProfileLearningEpisode[] = [];
  for (const p of TRADE_PROFILE_CATALOG) {
    if (p.id === 'default' || p.id === 'zion') continue;
    try {
      const eps = getProfileLearningEpisodes(p.id, Math.max(window * 2, 100));
      all.push(...eps);
    } catch {
      /* soft */
    }
  }
  all.sort((a, b) => Number(a.closedAt || 0) - Number(b.closedAt || 0));
  // Prefer non-partial finals
  const finals = all.filter((e) => !/^partial:/i.test(String(e.exitReason || '')));
  const src = finals.length >= Math.min(10, window) ? finals : all;
  return src.slice(-window);
}

function episodeToSample(e: ProfileLearningEpisode): LearningTradeSampleRow {
  const armed =
    e.armedWatch === true ||
    e.entryPath === 'armed_trigger' ||
    e.scalperWatchTriggered === true;
  const lateChase =
    e.lateChaseAtEntry === true ||
    classifyTradeFamily({
      entryStyle: e.entryStyle,
      lateChaseAtEntry: e.lateChaseAtEntry,
      profileId: e.profileId,
    }) === 'late_chase';
  const family = classifyTradeFamily({
    entryStyle: e.entryStyle,
    entryStyleSecondary: e.entryStyleSecondary,
    lateChaseAtEntry: e.lateChaseAtEntry,
    profileId: e.profileId,
    armedWatch: armed,
    entryPath: e.entryPath,
  });
  const maxRunup = Math.max(0, Number(e.maxRunupPct) || 0);
  const pnlPct = Number(e.pnlPct) || 0;
  let mfeCapturePct: number | null = null;
  if (e.mfeCaptureRatio != null && Number.isFinite(Number(e.mfeCaptureRatio))) {
    mfeCapturePct = Number(e.mfeCaptureRatio) * 100;
  } else if (maxRunup > 1e-6) {
    mfeCapturePct = (pnlPct / maxRunup) * 100;
  }
  return {
    profile: String(e.profileId || ''),
    token: String(e.symbol || '').trim() || String(e.mint || '').slice(0, 8),
    mint: String(e.mint || ''),
    entryStyle: e.entryStyle || null,
    family,
    armed,
    lateChase,
    openedAt: Number(e.openedAt) || 0,
    closedAt: Number(e.closedAt) || 0,
    holdMs: Math.max(0, (Number(e.holdSec) || 0) * 1000),
    maxRunupPct: maxRunup,
    maxDrawdownPct: Number(e.maxDrawdownPct) || 0,
    exitReason: String(e.exitReason || e.exitKey || '—'),
    pnlPct,
    pnlSol: Number(e.pnlSol) || 0,
    mfeCapturePct,
  };
}

/** Fallback sample from expectancy ledger when episodes are thin. */
function expectancyFallbackSample(window: LearningReportWindow): LearningTradeSampleRow[] {
  try {
    const rows = collectExpectancyTrades().slice(-window);
    return rows.map((t) => ({
      profile: t.profileId,
      token: t.profileId.slice(0, 8),
      mint: '',
      entryStyle: t.entryStyle || null,
      family: t.family,
      armed: t.armed,
      lateChase: t.lateChase,
      openedAt: t.openedAt,
      closedAt: t.closedAt,
      holdMs: t.holdMs,
      maxRunupPct: t.maxRunupPct,
      maxDrawdownPct: 0,
      exitReason: '—',
      pnlPct: t.pnlPct,
      pnlSol: t.pnlSol,
      mfeCapturePct: t.mfeCapturePct,
    }));
  } catch {
    return [];
  }
}

function buildTradeSample(window: LearningReportWindow): LearningTradeSampleRow[] {
  const fromEps = collectWindowEpisodes(window).map(episodeToSample);
  if (fromEps.length >= Math.min(5, window)) return fromEps;
  const fb = expectancyFallbackSample(window);
  return fb.length > fromEps.length ? fb : fromEps;
}

function topExitReasons(
  trades: LearningTradeSampleRow[],
  limit = 8
): Array<{ reason: string; count: number; share: number }> {
  const counts = new Map<string, number>();
  for (const t of trades) {
    const r = String(t.exitReason || '—').trim() || '—';
    // Collapse long reasons
    const key = r.length > 64 ? r.slice(0, 61) + '…' : r;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const n = trades.length || 1;
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count, share: count / n }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function buildConfigSnapshot(el: ReturnType<typeof getExpectancyLiftStatus>): Record<string, unknown> {
  let lmStatus: ReturnType<typeof getLearningModeStatus> | null = null;
  try {
    lmStatus = getLearningModeStatus();
  } catch {
    lmStatus = null;
  }

  let scalperCap: number | null = null;
  let scalperShare: number | null = null;
  try {
    const { getScalperAttentionShareCap, getProfileAttentionShare } =
      require('./profileAttention') as typeof import('./profileAttention');
    scalperCap = getScalperAttentionShareCap();
    const att = getProfileAttentionShare();
    scalperShare = att?.shares?.scalper ?? el.mix?.scalperAttentionShare ?? null;
  } catch {
    scalperShare = el.mix?.scalperAttentionShare ?? null;
  }

  let qualityPark: ReturnType<
    typeof import('./dipMinorLaneHealth').getQualityParkLaneHealth
  > | null = null;
  try {
    const { getQualityParkLaneHealth } =
      require('./dipMinorLaneHealth') as typeof import('./dipMinorLaneHealth');
    qualityPark = getQualityParkLaneHealth();
  } catch {
    qualityPark = null;
  }

  return {
    mode: modeLabel(),
    learningMode: lmStatus
      ? {
          enabled: lmStatus.enabled,
          strictness: lmStatus.strictness,
          label: lmStatus.label,
          optIn: `${lmStatus.optInCount}/${lmStatus.optInTotal}`,
          liveWarning: lmStatus.liveWarning,
          fairnessBoost: lmStatus.fairnessBoost,
        }
      : null,
    entrySkill: {
      admissionBaseline: el.admissionBaseline ?? null,
      armedTargetPct: el.entrySkillArmedTargetPct ?? el.targets?.armedTargetPct ?? null,
      armedTargetEffectivePct:
        el.entrySkillArmedTargetEffectivePct ?? el.targets?.armedTargetPct ?? null,
      armedTargetEBoost: el.armedTargetEBoost === true,
      lateChaseShareMax: el.targets?.lateChaseShareMax ?? null,
      lateChaseDisableRemaining:
        el.performanceRegime?.lateChaseDisableRemaining ?? null,
    },
    scalper: {
      attentionShareCap: scalperCap,
      attentionShare: scalperShare,
      shareMaxTarget: el.targets?.scalperShareMax ?? null,
    },
    steadyMediumBracket: {
      mediumMinMcUsd: MEDIUM_MIN_MC_USD,
      majorsMinMcUsd: MAJORS_MIN_MC_USD,
      steadyArmedNow: qualityPark?.steady?.armedNow ?? null,
      steadyWatchingNow: qualityPark?.steady?.watchingNow ?? null,
      hwrArmedNow: qualityPark?.hwr?.armedNow ?? null,
      hwrWatchingNow: qualityPark?.hwr?.watchingNow ?? null,
      topDenySteady: qualityPark?.steady?.topDeny ?? null,
      topDenyHwr: qualityPark?.hwr?.topDeny ?? null,
      plainLanguage: qualityPark?.plainLanguage ?? [],
    },
    risk: {
      riskEnabled: Boolean(config.risk?.enabled),
      riskPercentPerTrade: config.risk?.riskPercentPerTrade ?? null,
      maxDrawdownPct: config.risk?.maxDrawdownPct ?? null,
    },
  };
}

function renderMarkdown(json: LearningReportJson): string {
  const lines: string[] = [];
  const s = json.summary;
  lines.push('# Learning Report');
  lines.push('');
  lines.push(`Generated: ${iso(s.generatedAt)}`);
  lines.push(`Mode: ${s.mode} · Window: last ${s.window} closed`);
  lines.push('');
  lines.push('## A. Summary');
  lines.push('');
  lines.push(`- Window size: ${s.window}`);
  lines.push(`- Combined WR: ${fmtPct(s.winRate)}`);
  lines.push(`- Expectancy: ${fmtSignedPct(s.expectancyPct)}`);
  lines.push(`- Profit factor: ${fmtNum(s.profitFactor)}`);
  lines.push(`- MFE capture: ${fmtNum(s.mfeCapturePct, 1)}%`);
  lines.push(`- Armed share: ${fmtPct(s.armedShare)}`);
  lines.push(`- Late-chase rate: ${fmtPct(s.lateChaseShare)}`);
  lines.push(`- Sample trades: ${s.tradeCount}`);
  lines.push(`- Open positions: ${s.openCount}`);
  if (s.plainLanguage) lines.push(`- Note: ${s.plainLanguage}`);
  lines.push('');

  lines.push('## B. Per-profile');
  lines.push('');
  lines.push(
    '| Profile | n | WR | E% | AvgW | AvgL | MFE cap | Armed | Late | RL | Ready |'
  );
  lines.push(
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|'
  );
  for (const p of json.profiles) {
    const quiet = p.quiet ? ' (quiet)' : '';
    lines.push(
      `| ${p.name || p.profileId}${quiet} | ${p.n} | ${fmtPct(p.winRate)} | ${fmtSignedPct(p.expectancyPct)} | ${fmtNum(p.avgWinPct)} | ${fmtNum(p.avgLossPct)} | ${fmtNum(p.mfeCapturePct, 1)}% | ${fmtPct(p.armedShare)} | ${fmtPct(p.lateChaseShare)} | ${p.rlMode || '—'} | ${p.readinessScore != null ? Math.round(p.readinessScore) : '—'} |`
    );
  }
  lines.push('');

  lines.push('## C. Trade sample');
  lines.push('');
  for (let i = 0; i < json.trades.length; i++) {
    const t = json.trades[i]!;
    lines.push(
      `${i + 1}. **${t.token}** · ${t.profile} · ${t.family}${t.entryStyle ? ` / ${t.entryStyle}` : ''}`
    );
    lines.push(
      `   - ${t.armed ? 'armed' : 'discretionary'}${t.lateChase ? ' · lateChase' : ''} · hold ${holdLabel(t.holdMs)} · PnL ${fmtSignedPct(t.pnlPct)}`
    );
    lines.push(
      `   - MFE ${fmtNum(t.maxRunupPct, 1)}% · MAE ${fmtNum(t.maxDrawdownPct, 1)}% · capture ${fmtNum(t.mfeCapturePct, 1)}%`
    );
    lines.push(
      `   - exit: ${t.exitReason} · ${iso(t.openedAt)} → ${iso(t.closedAt)}`
    );
  }
  if (!json.trades.length) {
    lines.push('_No closed trades in window._');
  }
  lines.push('');

  lines.push('## D. Quality diagnostics');
  lines.push('');
  lines.push('### Top exit reasons');
  if (json.diagnostics.topExitReasons.length) {
    for (const r of json.diagnostics.topExitReasons) {
      lines.push(
        `- ${r.reason}: ${r.count} (${fmtPct(r.share, 0)})`
      );
    }
  } else {
    lines.push('- —');
  }
  lines.push('');
  lines.push('### Skip / starve notes');
  const notes = [
    ...json.diagnostics.topSkipNotes,
    ...json.diagnostics.starvedNotes,
  ];
  if (notes.length) {
    for (const n of notes) lines.push(`- ${n}`);
  } else {
    lines.push('- —');
  }
  lines.push('');

  lines.push('## E. Config snapshot (learning-relevant, read-only)');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(json.configSnapshot, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('=== END LEARNING REPORT ===');
  return lines.join('\n');
}

/**
 * Build a Learning Report (markdown + JSON + Cursor package). Read-only.
 */
export function buildLearningReport(windowRaw: unknown = 50): LearningReportResult {
  const window = parseLearningReportWindow(windowRaw);
  const generatedAt = Date.now();
  const mode = modeLabel();

  const el = getExpectancyLiftStatus(window as ExpectancyWindow);
  let lm: ReturnType<typeof getLearningMetricsPanel> | null = null;
  try {
    lm = getLearningMetricsPanel(window as ExpectancyWindow);
  } catch {
    lm = null;
  }

  const trades = buildTradeSample(window);

  let overall = {
    winRate: null as number | null,
    expectancyPct: null as number | null,
    profitFactor: null as number | null,
    avgWinPct: null as number | null,
    avgLossPct: null as number | null,
    mfeCapturePct: null as number | null,
    tradeCount: 0,
  };
  try {
    const ledger = collectExpectancyTrades().slice(-window);
    const m = computeExpectancyMetrics(ledger);
    overall = {
      winRate: m.winRate,
      expectancyPct: m.expectancyPct,
      profitFactor: m.profitFactor,
      avgWinPct: m.avgWinPct,
      avgLossPct: m.avgLossPct,
      mfeCapturePct: m.mfeCapturePct,
      tradeCount: m.tradeCount,
    };
  } catch {
    /* soft — fall back to sample size */
    overall.tradeCount = trades.length;
  }

  const stats = paperTrader.getStats();
  const openCount = Number(stats.openCount ?? stats.openTrades) || 0;
  const closedCountApprox =
    Number((stats as { closedCount?: number }).closedCount) ||
    Number(stats.totalTrades) ||
    overall.tradeCount;

  const lmById = new Map(
    (lm?.profiles || []).map((p) => [p.profileId, p] as const)
  );

  const profiles: LearningReportProfileRow[] = (el.profiles || []).map((p) => {
    const row = lmById.get(p.profileId);
    return {
      profileId: p.profileId,
      name: p.name || p.profileId,
      n: p.metrics?.tradeCount ?? row?.n ?? 0,
      winRate: p.metrics?.winRate ?? row?.winRate ?? null,
      expectancyPct: p.metrics?.expectancyPct ?? row?.expectancyPct ?? null,
      avgWinPct: p.metrics?.avgWinPct ?? row?.avgWinPct ?? null,
      avgLossPct: p.metrics?.avgLossPct ?? row?.avgLossPct ?? null,
      profitFactor: p.metrics?.profitFactor ?? row?.profitFactor ?? null,
      mfeCapturePct: p.metrics?.mfeCapturePct ?? row?.mfeCapturePct ?? null,
      armedShare: p.armedShare ?? row?.armedShare ?? null,
      lateChaseShare: p.lateChaseShare ?? row?.lateChaseShare ?? null,
      rlMode: row?.rlMode ?? null,
      readinessScore: row?.readinessScore ?? null,
      quiet: p.quiet === true,
      quietReason: p.quietReason || null,
    };
  });

  const starvedNotes: string[] = [];
  for (const p of profiles) {
    if (p.quiet && p.quietReason) {
      starvedNotes.push(`${p.name}: ${p.quietReason}`);
    } else if (p.quiet) {
      starvedNotes.push(`${p.name}: quiet in window`);
    }
  }
  for (const c of el.quietChips || []) {
    if (
      c.profileId === 'steady_compounder' ||
      c.profileId === 'high_win_rate' ||
      /steady|hwr|high.?win/i.test(String(c.label || ''))
    ) {
      starvedNotes.push(`${c.label}: ${c.reason}`);
    }
  }
  try {
    const { getQualityParkLaneHealth } =
      require('./dipMinorLaneHealth') as typeof import('./dipMinorLaneHealth');
    const q = getQualityParkLaneHealth();
    for (const line of q.plainLanguage || []) {
      if (line) starvedNotes.push(line);
    }
  } catch {
    /* soft */
  }

  const topSkipNotes: string[] = [];
  if (el.mix?.lateChaseShare != null && el.mix.lateChaseShare > 0.05) {
    topSkipNotes.push(
      `Late-chase share elevated at ${fmtPct(el.mix.lateChaseShare)} (target ≤5%)`
    );
  }
  if (
    el.mix?.scalperAttentionShare != null &&
    el.targets?.scalperShareMax != null &&
    el.mix.scalperAttentionShare > el.targets.scalperShareMax
  ) {
    topSkipNotes.push(
      `Scalper attention ${fmtPct(el.mix.scalperAttentionShare)} above cap ${fmtPct(el.targets.scalperShareMax)}`
    );
  }
  for (const r of el.familyRestrictionImpact || []) {
    if (r.state === 'restricted' || r.state === 'down_ranked') {
      topSkipNotes.push(
        `Family ${r.family} ${r.state}: ${r.note || 'see EL governors'}`
      );
    }
  }

  const reportJson: LearningReportJson = {
    summary: {
      window,
      mode,
      generatedAt,
      tradeCount: overall.tradeCount || trades.length,
      openCount,
      closedCountApprox,
      winRate: overall.winRate,
      expectancyPct: overall.expectancyPct,
      profitFactor: overall.profitFactor,
      armedShare: el.mix?.armedShare ?? null,
      lateChaseShare: el.mix?.lateChaseShare ?? null,
      mfeCapturePct: overall.mfeCapturePct ?? el.mix?.avgMfeCapture ?? null,
      plainLanguage: el.plainLanguage || lm?.plainLanguage || null,
    },
    profiles,
    trades,
    diagnostics: {
      topExitReasons: topExitReasons(trades),
      topSkipNotes: [...new Set(topSkipNotes)].slice(0, 12),
      starvedNotes: [...new Set(starvedNotes)].slice(0, 12),
    },
    configSnapshot: buildConfigSnapshot(el),
  };

  const reportText = renderMarkdown(reportJson);
  const cursorPackageText = CURSOR_LEARNING_REPORT_PREAMBLE + reportText;

  return {
    ok: true,
    generatedAt,
    mode,
    window,
    reportText,
    reportJson,
    cursorPackageText,
    meta: {
      tradeCount: reportJson.summary.tradeCount,
      profileCount: profiles.length,
      openCount,
    },
  };
}
