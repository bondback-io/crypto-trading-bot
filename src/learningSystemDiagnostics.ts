/**
 * Read-only Learning Progress & System Diagnostics snapshot.
 * Does not mutate Self-Learn, ML mode, MARL, Learning Mode, or exits.
 */

import {
  getProfileLearningEpisodes,
  type ProfileLearningEpisode,
} from './profileLearningEpisodes';

export type LearningDiagStatus =
  | 'Active'
  | 'Advisor-only'
  | 'Frozen'
  | 'Paused';

export type LearningDiagTrend = 'Improving' | 'Stable' | 'Declining';

export interface ProfileLearningDiag {
  id: string;
  name: string;
  botEnabled: boolean;
  selfLearnEnabled: boolean;
  mode: 'shadow' | 'auto';
  mlMode: string;
  mlModeSource: 'auto' | 'manual';
  level: number;
  progressPct: number;
  episodes: number;
  wins: number;
  losses: number;
  goal: number;
  status: LearningDiagStatus;
  trend: LearningDiagTrend;
  lastActivity: string | null;
  avgTimingReward: number | null;
  improvementPct: number;
  spark: number[];
  learnedSummary: string;
}

export interface LearningSystemDiagnostics {
  generatedAt: number;
  healthScore: number;
  healthLabel: string;
  healthBlurb: string;
  setupLines: string[];
  warnings: string[];
  profiles: ProfileLearningDiag[];
}

const CACHE_MS = 20_000;
let cache: { at: number; snap: LearningSystemDiagnostics } | null = null;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function episodeScore(e: ProfileLearningEpisode): number {
  if (e.timingReward != null && Number.isFinite(e.timingReward)) {
    return Number(e.timingReward);
  }
  return Number(e.pnlPct) || 0;
}

function buildSpark(episodes: ProfileLearningEpisode[], buckets = 12): number[] {
  if (!episodes.length) return [];
  const recent = episodes.slice(-Math.min(episodes.length, 48));
  const n = recent.length;
  const out: number[] = [];
  const size = Math.max(1, Math.ceil(n / buckets));
  for (let i = 0; i < buckets; i++) {
    const slice = recent.slice(i * size, (i + 1) * size);
    if (!slice.length) break;
    out.push(Number(mean(slice.map(episodeScore)).toFixed(2)));
  }
  return out;
}

function deriveStatus(input: {
  selfLearnEnabled: boolean;
  episodes: number;
  minTrades: number;
  mode: 'shadow' | 'auto';
  mlMode: string;
}): LearningDiagStatus {
  if (!input.selfLearnEnabled) return 'Paused';
  if (input.episodes < Math.max(1, input.minTrades)) return 'Frozen';
  if (input.mode === 'shadow' || input.mlMode === 'shadow' || input.mlMode === 'off') {
    return 'Advisor-only';
  }
  return 'Active';
}

function deriveTrend(
  improvementPct: number,
  episodes: ProfileLearningEpisode[]
): LearningDiagTrend {
  if (episodes.length >= 8) {
    const mid = Math.floor(episodes.length / 2);
    const older = mean(episodes.slice(0, mid).map(episodeScore));
    const newer = mean(episodes.slice(mid).map(episodeScore));
    const delta = newer - older;
    if (delta >= 1.5 || improvementPct >= 8) return 'Improving';
    if (delta <= -1.5 || improvementPct <= -8) return 'Declining';
  }
  if (improvementPct >= 5) return 'Improving';
  if (improvementPct <= -5) return 'Declining';
  return 'Stable';
}

function plainLearnedSummary(input: {
  name: string;
  episodes: number;
  status: LearningDiagStatus;
  lastSummary: string;
  lastChanges: string;
  mlMode: string;
}): string {
  const name = input.name;
  if (input.episodes < 8) {
    return `${name} still has limited data and is in early learning.`;
  }
  if (input.status === 'Paused') {
    return `${name} self-learning is paused — knobs stay fixed until learning is turned back on.`;
  }
  const blob = `${input.lastSummary} ${input.lastChanges}`.toLowerCase();
  if (/giveback|profit.?lock|profit.?floor/.test(blob)) {
    return `${name} is learning to lock profits a bit sooner after a run-up.`;
  }
  if (/trail|tighten|momentum.?fade|activation/.test(blob)) {
    return `${name} is improving at trailing winners and cutting giveback after peaks.`;
  }
  if (/partial/.test(blob)) {
    return `${name} is learning to bank partial profits earlier on strong moves.`;
  }
  if (/conviction|min.?score|wallet/.test(blob)) {
    return `${name} is getting pickier about weak entries.`;
  }
  if (/timer|hold|dead.?volume|dead.?market/.test(blob)) {
    return `${name} is learning to leave quiet or stalled trades sooner.`;
  }
  if (/ta playbook|macd|zigzag|divergence|hist slope|tool weight|minconf/i.test(blob)) {
    return `${name} is fine-tuning TA tool weights and confluence from closed trades.`;
  }
  if (/timing:/.test(blob)) {
    return `${name} is fine-tuning when trails arm and tighten after green.`;
  }
  if (input.mlMode === 'lead') {
    return `${name} is letting ML lead small exit tweaks, with heuristics as backup.`;
  }
  if (input.mlMode === 'hybrid') {
    return `${name} is blending ML advice with heuristics on recent closed trades.`;
  }
  if (input.episodes < 50) {
    return `${name} is soaking trades in advisor mode while the sample grows.`;
  }
  return `${name} is adjusting exits from recent closed trades.`;
}

function lastActivityLine(sl: {
  lastMutation?: { summary?: string } | null;
  pendingProposal?: { summary?: string } | null;
  nearMiss?: { summary?: string; patternHint?: string } | null;
}): string | null {
  if (sl.lastMutation?.summary) return String(sl.lastMutation.summary).slice(0, 140);
  if (sl.pendingProposal?.summary) {
    return `Pending: ${String(sl.pendingProposal.summary).slice(0, 120)}`;
  }
  if (sl.nearMiss?.summary) {
    return `Near-miss: ${String(sl.nearMiss.summary).slice(0, 120)}`;
  }
  if (sl.nearMiss?.patternHint) {
    return `Near-miss: ${String(sl.nearMiss.patternHint).slice(0, 120)}`;
  }
  return null;
}

/**
 * Build diagnostics snapshot (cached ~20s). Read-only.
 */
export function getLearningSystemDiagnostics(opts?: {
  force?: boolean;
}): LearningSystemDiagnostics {
  const now = Date.now();
  if (
    !opts?.force &&
    cache &&
    now - cache.at < CACHE_MS
  ) {
    return cache.snap;
  }

  const {
    getTradeProfilesStatus,
    getGlobalMicroBotTakeProfitPct,
  } = require('./tradeProfiles') as typeof import('./tradeProfiles');
  const { humanizeLearningPatch } =
    require('./profileSelfLearning') as typeof import('./profileSelfLearning');
  const { getLearningModeStatus } =
    require('./learningMode') as typeof import('./learningMode');
  const { getMarlStatus } =
    require('./marlCoordinator') as typeof import('./marlCoordinator');
  let profileRlLabel = 'Profile RL OFF';
  let accelLabel = 'Accelerators OFF';
  try {
    const { getProfileRlStatus } =
      require('./profileRlAgent') as typeof import('./profileRlAgent');
    const prl = getProfileRlStatus();
    profileRlLabel = prl.enabled
      ? `Profile RL ON (${prl.strength}) — soft lane/confidence/TA/exit hints only`
      : 'Profile RL OFF';
  } catch {
    /* optional */
  }
  try {
    const { getLearningAcceleratorsStatus } =
      require('./learningReplayBuffer') as typeof import('./learningReplayBuffer');
    const acc = getLearningAcceleratorsStatus();
    accelLabel = acc.config.enabled
      ? `Accelerators ON — replay ${acc.config.replayEnabled ? 'ON' : 'OFF'} · CF ${acc.config.counterfactualEnabled ? 'ON' : 'OFF'} · teacher ${acc.config.teacherStudentEnabled ? 'ON' : 'OFF'}`
      : 'Learning Accelerators OFF';
  } catch {
    /* optional */
  }

  const tp = getTradeProfilesStatus();
  const lm = getLearningModeStatus();
  const marl = getMarlStatus();
  const globalTp = getGlobalMicroBotTakeProfitPct();

  const profiles: ProfileLearningDiag[] = [];
  for (const p of tp.profiles || []) {
    if (p.id === 'default') continue;
    const sl = p.selfLearning || {};
    const prog = p.learningProgress || {
      episodes: 0,
      wins: 0,
      losses: 0,
      goal: 400,
      pct: 0,
      level: 0,
    };
    const episodes = getProfileLearningEpisodes(p.id, 80);
    const rewards = episodes
      .map((e) => e.timingReward)
      .filter((v): v is number => v != null && Number.isFinite(v));
    const selfLearnEnabled = sl.enabled !== false;
    const mode = sl.mode === 'shadow' ? 'shadow' : 'auto';
    const mlMode = String(sl.mlMode || 'shadow');
    const status = deriveStatus({
      selfLearnEnabled,
      episodes: prog.episodes || 0,
      minTrades: Number(sl.minTrades) || 8,
      mode,
      mlMode,
    });
    const lastSummary = String(sl.lastMutation?.summary || '');
    const lastChanges =
      String(sl.lastMutation?.changes || '') ||
      humanizeLearningPatch(sl.pendingProposal?.patch) ||
      '';
    const name = String(p.name || p.id);
    let taLearnLine = '';
    try {
      const { formatProfileTaLearnedPlainLanguage } =
        require('./profileTaPlaybookStore') as typeof import('./profileTaPlaybookStore');
      taLearnLine = formatProfileTaLearnedPlainLanguage(p.id) || '';
    } catch {
      /* optional */
    }
    profiles.push({
      id: p.id,
      name,
      botEnabled: p.enabled !== false,
      selfLearnEnabled,
      mode,
      mlMode,
      mlModeSource: sl.mlModeSource === 'auto' ? 'auto' : 'manual',
      level: Math.max(0, Number(prog.level ?? sl.version) || 0),
      progressPct: Number(prog.pct) || 0,
      episodes: Number(prog.episodes) || 0,
      wins: Number(prog.wins) || 0,
      losses: Number(prog.losses) || 0,
      goal: Number(prog.goal) || 400,
      status,
      trend: deriveTrend(Number(sl.improvementPct) || 0, episodes),
      lastActivity: lastActivityLine(sl),
      avgTimingReward: rewards.length
        ? Number(mean(rewards).toFixed(2))
        : null,
      improvementPct: Number(sl.improvementPct) || 0,
      spark: buildSpark(episodes),
      learnedSummary: plainLearnedSummary({
        name,
        episodes: Number(prog.episodes) || 0,
        status,
        lastSummary: [lastSummary, taLearnLine].filter(Boolean).join(' '),
        lastChanges,
        mlMode,
      }),
    });
  }

  const enabledBots = profiles.filter((p) => p.botEnabled);
  const enabledSl = enabledBots.filter((p) => p.selfLearnEnabled);
  const mlHybridOrLead = enabledSl.filter(
    (p) => p.mlMode === 'hybrid' || p.mlMode === 'lead'
  );
  const mlShadow = enabledSl.filter((p) => p.mlMode === 'shadow');
  const mlLead = enabledSl.filter((p) => p.mlMode === 'lead');
  const autoMl = enabledSl.filter((p) => p.mlModeSource === 'auto');
  const activeCount = enabledSl.filter((p) => p.status === 'Active').length;
  const enoughData = enabledBots.filter((p) => p.episodes >= 8).length;
  const totalEps = profiles.reduce((s, p) => s + p.episodes, 0);

  const setupLines: string[] = [];
  setupLines.push(
    lm.enabled
      ? `Learning Mode is ON (${lm.strictness}) — softens entry floors for opted-in bots (${lm.optInCount}/${lm.optInTotal}).`
      : 'Learning Mode is OFF — bots use normal entry floors.'
  );
  setupLines.push(
    marl.enabled
      ? `MARL is ON at ${marl.strength} influence — soft lane ranking / size / low-MC limits only (never TP/SL).`
      : 'MARL is OFF — lane order and size are not soft-coordinated.'
  );
  setupLines.push(profileRlLabel);
  setupLines.push(accelLabel);
  setupLines.push(
    mlHybridOrLead.length
      ? `ML delta learning is active on ${mlHybridOrLead.length} bot(s) (hybrid ${mlHybridOrLead.filter((p) => p.mlMode === 'hybrid').length}, lead ${mlLead.length}).`
      : enabledSl.length
        ? 'ML is in shadow/advisor mode on learning bots — advice only until hybrid/lead.'
        : 'No bots have Self-Learning ON — ML is idle.'
  );
  if (autoMl.length) {
    setupLines.push(
      `${autoMl.length} bot(s) have ML mode auto-promoted from sample quality.`
    );
  }
  setupLines.push(
    'Together: Self-Learn mutates exit/entry knobs from closed trades; ML ranks those ideas; MARL coordinates lanes; Profile RL nudges per-bot quality; Accelerators add offline replay/CF/teacher hints; Learning Mode only softens entries.'
  );
  if (globalTp != null) {
    setupLines.push(
      `Global Micro-Bot take-profit (${globalTp}%) is set — exit delta learning is paused while it is on.`
    );
  }

  const warnings: string[] = [];
  if (totalEps < 8) {
    warnings.push('Not enough closed trades yet for meaningful learning.');
  }
  if (enabledBots.length && enoughData < Math.ceil(enabledBots.length * 0.4)) {
    warnings.push('Most enabled bots still need more closed trades (≥8) before upgrades.');
  }
  if (enabledBots.length && enabledSl.length === 0) {
    warnings.push('Self-Learning is OFF on all enabled bots.');
  }
  if (enabledSl.length && mlHybridOrLead.length === 0 && mlShadow.length > 0) {
    warnings.push('All learning bots are still on ML shadow (advisor-only).');
  }
  if (!marl.enabled) {
    warnings.push('MARL influence is off.');
  } else if (marl.strength === 'low') {
    warnings.push('MARL influence is Low.');
  }
  if (!lm.enabled) {
    warnings.push('Learning Mode is Off.');
  }
  if (globalTp != null) {
    warnings.push('Global take-profit is pausing Self-Learn exit deltas.');
  }

  // Health score (plan formula)
  let score = 35;
  if (mlHybridOrLead.length >= 1) score += 15;
  if (marl.enabled) {
    score += 10;
    if (marl.strength === 'medium') score += 5;
    else if (marl.strength === 'high') score += 8;
  }
  if (enabledBots.length) {
    const dataMean =
      mean(
        enabledBots.map((p) => Math.min(p.episodes, 50) / 50)
      ) || 0;
    score += Math.round(dataMean * 20);
    const activeShare =
      enabledSl.length > 0
        ? activeCount / enabledSl.length
        : enoughData / enabledBots.length;
    score += Math.round(clamp(activeShare, 0, 1) * 10);
  }
  if (lm.enabled) score += 5;

  const majorWarnings = warnings.filter(
    (w) =>
      /Not enough closed|Self-Learning is OFF on all|Global take-profit|All learning bots are still on ML shadow/.test(
        w
      )
  );
  score -= Math.min(24, majorWarnings.length * 12);
  score = Math.round(clamp(score, 0, 100));

  let healthLabel =
    score >= 75 ? 'Healthy' : score >= 50 ? 'Partially active' : 'Needs more data';
  if (majorWarnings.length >= 2 && score >= 50) {
    healthLabel = 'Partially active';
  }

  const healthBlurb = (() => {
    const mlBit = mlHybridOrLead.length
      ? 'ML is active'
      : enabledSl.length
        ? 'ML is still advisor-only'
        : 'Self-Learn is mostly off';
    const marlBit = marl.enabled
      ? `MARL is providing ${marl.strength} influence`
      : 'MARL is off';
    const dataBit =
      enoughData >= Math.max(1, Math.ceil(enabledBots.length * 0.5))
        ? 'most profiles have enough data to keep learning'
        : 'several profiles still need more closed trades';
    return `${mlBit}, ${marlBit}, and ${dataBit}.`;
  })();

  const snap: LearningSystemDiagnostics = {
    generatedAt: now,
    healthScore: score,
    healthLabel,
    healthBlurb,
    setupLines,
    warnings,
    profiles,
  };
  cache = { at: now, snap };
  return snap;
}

/** Compact multi-line pack for Zion context. */
export function formatLearningDiagnosticsForZion(
  snap?: LearningSystemDiagnostics
): string[] {
  const d = snap || getLearningSystemDiagnostics();
  const lines: string[] = [
    `Learning health: ${d.healthScore}/100 — ${d.healthLabel}`,
    `  ${d.healthBlurb}`,
  ];
  for (const w of d.warnings.slice(0, 5)) {
    lines.push(`  warn: ${w}`);
  }
  for (const p of d.profiles.slice(0, 12)) {
    if (!p.botEnabled && p.episodes < 1) continue;
    lines.push(
      `  learn ${p.name}: ${p.status} · ${p.progressPct}% · L${p.level} · ML ${p.mlMode} · ${p.trend} — ${p.learnedSummary}`
    );
  }
  return lines;
}
