/**
 * Per-profile RL soft agents — PPO-style clipped policy on setup-worth,
 * confidence, TA sensitivity, and exit-hint aggressiveness.
 * Never mutates TP/SL, Peak Protection, self-learn overrides, or MARL weights.
 */

import { config } from './config';
import type { ProfileLearningEpisode } from './profileLearningEpisodes';
import {
  getOrCreateProfileRlAgent,
  getProfileRlDecisions,
  loadProfileRlState,
  pushProfileRlDecision,
  pushProfileRlPolicyHistory,
  rollbackProfileRlPolicyTo,
  saveProfileRlState,
  setProfileRlAgentMode,
  type ProfileRlAgentState,
  type ProfileRlMode,
  type ProfileRlPolicy,
  type ProfileRlStrength,
} from './profileRlStore';

export type { ProfileRlMode, ProfileRlStrength };

export interface ProfileRlReadinessBreakdown {
  sample: number;
  rewardTrend: number;
  stability: number;
  baseline: number;
  diversity: number;
}

export interface ProfileRlReadinessResult {
  score: number;
  breakdown: ProfileRlReadinessBreakdown;
  plainFactors: string[];
}

export interface ProfileRlDifficulty {
  thresholdAdd: number;
  hybridFloor: number;
  leadFloor: number;
}

export const PROFILE_RL_DIFFICULTY: Record<string, ProfileRlDifficulty> = {
  scalper: { thresholdAdd: 8, hybridFloor: 40, leadFloor: 100 },
  momentum_burst: { thresholdAdd: 5, hybridFloor: 32, leadFloor: 85 },
  migration_sniper: { thresholdAdd: 3, hybridFloor: 28, leadFloor: 75 },
  dip_buyer: { thresholdAdd: 0, hybridFloor: 25, leadFloor: 65 },
  trend_rider: { thresholdAdd: 0, hybridFloor: 25, leadFloor: 65 },
  high_win_rate: { thresholdAdd: 0, hybridFloor: 25, leadFloor: 70 },
  steady_compounder: { thresholdAdd: 0, hybridFloor: 25, leadFloor: 70 },
};

export const DEFAULT_PROFILE_RL_DIFFICULTY: ProfileRlDifficulty = {
  thresholdAdd: 2,
  hybridFloor: 30,
  leadFloor: 80,
};

const SHADOW_TO_HYBRID_READINESS = 65;
const HYBRID_TO_LEAD_READINESS = 80;
const LEAD_DEMOTE_READINESS = 70;
const HYBRID_DEMOTE_READINESS = 55;
const MIN_STABILITY_FOR_PROMOTE = 50;

export interface ProfileRlConfig {
  enabled: boolean;
  strength: ProfileRlStrength;
}

export const DEFAULT_PROFILE_RL_CONFIG: ProfileRlConfig = {
  enabled: false,
  strength: 'medium',
};

export const KEY_PROFILE_RL_IDS = [
  'scalper',
  'momentum_burst',
  'dip_buyer',
  'trend_rider',
] as const;

const PPO_EPS = 0.08;
const MIN_TRADES_INFLUENCE = 8;
const SCORE_CAP = 6;
const SIZE_LO = 0.9;
const SIZE_HI = 1.1;
const TA_SENS_LO = 0.9;
const TA_SENS_HI = 1.1;
const REWARD_EMA_ALPHA = 0.12;
const ROLLBACK_EMA_DROP = 0.25;
const ROLLBACK_MIN_TRADES = 6;

export function getProfileRlConfig(): ProfileRlConfig {
  const m = (config as { profileRl?: Partial<ProfileRlConfig> }).profileRl;
  const strength =
    m?.strength === 'low' || m?.strength === 'high' || m?.strength === 'medium'
      ? m.strength
      : 'medium';
  return {
    enabled: m?.enabled === true,
    strength,
  };
}

export function setProfileRlConfig(patch: Partial<ProfileRlConfig>): ProfileRlConfig {
  const cur = getProfileRlConfig();
  const next: ProfileRlConfig = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
    strength:
      patch.strength === 'low' ||
      patch.strength === 'medium' ||
      patch.strength === 'high'
        ? patch.strength
        : cur.strength,
  };
  (config as { profileRl: ProfileRlConfig }).profileRl = next;
  try {
    const { persistUserSettings } = require('./config') as typeof import('./config');
    persistUserSettings();
  } catch {
    /* */
  }
  pushProfileRlDecision({
    kind: 'config',
    detail: `Profile RL ${next.enabled ? 'ON' : 'OFF'} · strength ${next.strength}`,
  });
  return next;
}

function strengthScale(s: ProfileRlStrength): number {
  if (s === 'low') return 0.35;
  if (s === 'high') return 1.6;
  return 1;
}

function modeScale(mode: ProfileRlMode): number {
  if (mode === 'lead') return 1.35;
  if (mode === 'hybrid') return 1;
  return 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function getProfileRlDifficulty(profileId: string): ProfileRlDifficulty {
  return PROFILE_RL_DIFFICULTY[profileId] ?? DEFAULT_PROFILE_RL_DIFFICULTY;
}

function computeSampleScore(trades: number, diff: ProfileRlDifficulty): number {
  if (trades <= 0) return 0;
  const { hybridFloor, leadFloor } = diff;
  if (trades <= hybridFloor) {
    return clamp((trades / hybridFloor) * 70, 0, 70);
  }
  if (trades <= leadFloor) {
    return clamp(70 + ((trades - hybridFloor) / (leadFloor - hybridFloor)) * 30, 70, 100);
  }
  return 100;
}

function computeRewardTrendScore(agent: ProfileRlAgentState): number {
  const ema = agent.rewardEma;
  const last = agent.lastReward;
  const prev = agent.prevRewardEma ?? ema;
  const slope = ema - prev;
  const levelScore = clamp(((ema + 0.5) / 1.5) * 60, 0, 60);
  const slopeScore = clamp(((slope + 0.2) / 0.4) * 25, 0, 25);
  const alignScore = last >= ema * 0.8 ? 15 : last >= 0 ? 8 : 0;
  return clamp(Math.round(levelScore + slopeScore + alignScore), 0, 100);
}

function countRecentRollbacks(profileId: string): number {
  return getProfileRlDecisions(30).filter(
    (d) =>
      d.profileId === profileId &&
      (d.kind === 'auto_rollback' || d.kind === 'rollback')
  ).length;
}

function computeStabilityScore(agent: ProfileRlAgentState): number {
  let score = 72;
  const emaDelta = Math.abs(agent.rewardEma - agent.preUpdateRewardEma);
  if (emaDelta > 0.3) score -= 35;
  else if (emaDelta > 0.15) score -= 18;
  else if (emaDelta <= 0.05 && agent.tradesSinceUpdate >= 4) score += 8;

  const recentRollbacks = countRecentRollbacks(agent.profileId);
  score -= recentRollbacks * 14;
  score -= Math.min(30, (agent.unstableCount || 0) * 8);

  if (agent.tradesSinceUpdate <= 2 && agent.trades > 8) score -= 6;
  return clamp(Math.round(score), 0, 100);
}

function computeBaselineOutperformanceScore(agent: ProfileRlAgentState): number {
  const baseline = agent.baselineRewardEma ?? 0;
  const diff = agent.rewardEma - baseline;
  if (diff >= 0.3) return 100;
  if (diff >= 0.15) return 82;
  if (diff >= 0.05) return 65;
  if (diff >= 0) return 50;
  if (diff >= -0.15) return 28;
  return 10;
}

function computeDiversityScore(profileId: string, agent: ProfileRlAgentState): number {
  try {
    const { getProfileLearningEpisodes } =
      require('./profileLearningEpisodes') as typeof import('./profileLearningEpisodes');
    const eps = getProfileLearningEpisodes(profileId, 40);
    if (eps.length >= 3) {
      const exitKeys = new Set(eps.map((e) => e.exitKey));
      const hours = new Set(
        eps.map((e) => e.hourUtc).filter((h): h is number => h != null)
      );
      const tools = new Set<string>();
      for (const e of eps) {
        for (const t of e.taToolsPassedAtEntry || e.taToolsAtOpen || []) {
          tools.add(t);
        }
      }
      const mix = exitKeys.size * 2 + hours.size + Math.min(tools.size, 6);
      return clamp(Math.round(mix * 7), 15, 100);
    }
  } catch {
    /* optional */
  }
  if (agent.trades <= 0) return 15;
  const winMix = agent.wins / agent.trades;
  return clamp(Math.round(35 + winMix * 35 + Math.min(agent.trades, 15)), 15, 72);
}

export function computeProfileRlReadiness(
  agent: ProfileRlAgentState
): ProfileRlReadinessResult {
  const diff = getProfileRlDifficulty(agent.profileId);
  const sample = computeSampleScore(agent.trades, diff);
  const rewardTrend = computeRewardTrendScore(agent);
  const stability = computeStabilityScore(agent);
  const baseline = computeBaselineOutperformanceScore(agent);
  const diversity = computeDiversityScore(agent.profileId, agent);

  const score = Math.round(
    0.25 * sample +
      0.25 * rewardTrend +
      0.2 * stability +
      0.2 * baseline +
      0.1 * diversity
  );

  const plainFactors: string[] = [];
  if (sample < 55) plainFactors.push('needs more sample trades');
  if (rewardTrend < 45) plainFactors.push('reward trend weak');
  if (stability < MIN_STABILITY_FOR_PROMOTE) plainFactors.push('policy still noisy');
  if (baseline < 40) plainFactors.push('below baseline performance');
  if (diversity < 35) plainFactors.push('limited trade diversity');
  if (rewardTrend >= 70 && stability >= 60) plainFactors.push('stable improvement');
  if (agent.rewardEma < -0.15) plainFactors.push('negative reward EMA');

  return {
    score: clamp(score, 0, 100),
    breakdown: { sample, rewardTrend, stability, baseline, diversity },
    plainFactors,
  };
}

function profileDisplayName(profileId: string): string {
  return profileId
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function agentInfluenceMinTrades(profileId: string): number {
  return Math.min(getProfileRlDifficulty(profileId).hybridFloor, MIN_TRADES_INFLUENCE);
}

function agentInfluenceActive(agent: ProfileRlAgentState, cfg: ProfileRlConfig): boolean {
  if (!cfg.enabled || !agent.enabled) return false;
  if (agent.mode === 'shadow') return false;
  if (agent.trades < agentInfluenceMinTrades(agent.profileId)) return false;
  return true;
}

/** Composite reward from closed episode (same family as MARL + timing quality). */
export function computeProfileRlReward(
  episode: ProfileLearningEpisode,
  costSol?: number | null
): {
  reward: number;
  parts: {
    pnl: number;
    entry: number;
    exit: number;
    dd: number;
    ta: number;
    replayBonus?: number;
    cfBonus?: number;
  };
} {
  const risk = Math.max(0.01, Number(costSol) || Math.abs(Number(episode.pnlSol)) || 0.1);
  const pnlPart = clamp(Number(episode.pnlSol) / risk, -3, 3);

  const entryQ = episode.entryQualityScore ?? 50;
  const entryPart = clamp((entryQ - 50) / 50, -1, 1) * 0.15;

  const exitQ = episode.exitQualityScore ?? 50;
  const giveback = Math.max(0, episode.givebackFromPeakPct || 0);
  const exitMix =
    ((exitQ - 50) / 50) * 0.12 - clamp(giveback / 40, 0, 1) * 0.08;
  const exitPart = clamp(exitMix, -0.2, 0.2);

  const ddPart = -clamp(Math.abs(episode.maxDrawdownPct || 0) / 30, 0, 1) * 0.1;

  let taPart = 0;
  if (episode.taExitBeatHold === true) taPart += 0.03;
  if (episode.taConditionsHeldIntoProfit === true) taPart += 0.02;
  if (episode.cfTighterPppBetter === true && episode.cfActualVsPeakGapPct != null) {
    taPart += clamp(episode.cfActualVsPeakGapPct / 50, 0, 0.02);
  }
  taPart = clamp(taPart, -0.05, 0.05);

  let replayBonus = 0;
  let cfBonus = 0;
  try {
    const { getReplayRewardBonus } =
      require('./learningReplayBuffer') as typeof import('./learningReplayBuffer');
    replayBonus = getReplayRewardBonus(episode.profileId) || 0;
  } catch {
    /* optional */
  }
  try {
    const { getCounterfactualRlBonus } =
      require('./learningCounterfactual') as typeof import('./learningCounterfactual');
    cfBonus = getCounterfactualRlBonus(episode) || 0;
  } catch {
    /* optional */
  }

  const reward = clamp(
    pnlPart * 0.5 +
      entryPart +
      exitPart +
      ddPart +
      taPart +
      replayBonus +
      cfBonus,
    -3,
    3
  );

  return {
    reward,
    parts: {
      pnl: Number((pnlPart * 0.5).toFixed(3)),
      entry: Number(entryPart.toFixed(3)),
      exit: Number(exitPart.toFixed(3)),
      dd: Number(ddPart.toFixed(3)),
      ta: Number(taPart.toFixed(3)),
      replayBonus: replayBonus ? Number(replayBonus.toFixed(3)) : undefined,
      cfBonus: cfBonus ? Number(cfBonus.toFixed(3)) : undefined,
    },
  };
}

function activePolicyDims(episode: ProfileLearningEpisode): Array<keyof ProfileRlPolicy> {
  const dims: Array<keyof ProfileRlPolicy> = ['setupWorthBias', 'confidenceBias'];
  if (episode.taConfluenceAtEntry != null || episode.taModeAtOpen !== 'off') {
    dims.push('taSensitivityBias');
  }
  if (
    episode.givebackFromPeakPct != null ||
    episode.exitQualityScore != null ||
    episode.peakProtectArmed != null
  ) {
    dims.push('exitAggressiveness');
  }
  if (episode.macdHistSlopeAtEntry === 'rising' && episode.haBiasAtEntry === 'bullish') {
    if (!dims.includes('confidenceBias')) dims.push('confidenceBias');
  }
  return dims;
}

function hasRecentPerformanceDrop(agent: ProfileRlAgentState): boolean {
  if (agent.rewardEma < -0.2 && agent.mode !== 'shadow') return true;
  const drop = agent.preUpdateRewardEma - agent.rewardEma;
  if (drop > ROLLBACK_EMA_DROP && agent.tradesSinceUpdate >= 3) return true;
  return countRecentRollbacks(agent.profileId) >= 2;
}

function maybeAutoAdjustMode(agent: ProfileRlAgentState): void {
  if (agent.modeLocked) return;

  const diff = getProfileRlDifficulty(agent.profileId);
  const readiness = computeProfileRlReadiness(agent);
  agent.readinessScore = readiness.score;
  agent.readinessUpdatedAt = Date.now();

  const promoteHybridThreshold = SHADOW_TO_HYBRID_READINESS + diff.thresholdAdd;
  const promoteLeadThreshold = HYBRID_TO_LEAD_READINESS + diff.thresholdAdd;
  const stableEnough = readiness.breakdown.stability >= MIN_STABILITY_FOR_PROMOTE;
  const perfDrop = hasRecentPerformanceDrop(agent);
  const unstable = readiness.breakdown.stability < MIN_STABILITY_FOR_PROMOTE;

  const fmtDetail = (
    from: ProfileRlMode,
    to: ProfileRlMode,
    kind: 'auto_promote' | 'auto_demote',
    reason: string
  ): void => {
    const b = readiness.breakdown;
    pushProfileRlDecision({
      kind,
      profileId: agent.profileId,
      detail: `${from}→${to} · readiness ${readiness.score} · sample ${b.sample} · trend ${b.rewardTrend} · stability ${b.stability} · ${reason}`,
    });
  };

  if (agent.mode === 'shadow') {
    if (
      readiness.score >= promoteHybridThreshold &&
      agent.trades >= diff.hybridFloor &&
      stableEnough &&
      !perfDrop &&
      agent.rewardEma >= -0.1
    ) {
      agent.mode = 'hybrid';
      fmtDetail('shadow', 'hybrid', 'auto_promote', `n=${agent.trades} EMA ${agent.rewardEma.toFixed(2)}`);
    }
    return;
  }

  if (agent.mode === 'hybrid') {
    if (
      readiness.score >= promoteLeadThreshold &&
      agent.trades >= diff.leadFloor &&
      stableEnough &&
      !perfDrop &&
      agent.rewardEma >= 0.05
    ) {
      agent.mode = 'lead';
      fmtDetail('hybrid', 'lead', 'auto_promote', `n=${agent.trades} EMA ${agent.rewardEma.toFixed(2)}`);
      return;
    }
    if (
      readiness.score < HYBRID_DEMOTE_READINESS ||
      unstable ||
      (perfDrop && agent.rewardEma < 0)
    ) {
      agent.mode = 'shadow';
      fmtDetail(
        'hybrid',
        'shadow',
        'auto_demote',
        perfDrop ? 'performance drop' : unstable ? 'instability' : 'readiness low'
      );
    }
    return;
  }

  if (agent.mode === 'lead') {
    if (
      readiness.score < LEAD_DEMOTE_READINESS ||
      perfDrop ||
      agent.rewardEma < -0.05
    ) {
      agent.mode = 'hybrid';
      fmtDetail(
        'lead',
        'hybrid',
        'auto_demote',
        perfDrop ? 'EMA drop / rollback' : 'readiness below lead floor'
      );
    }
  }
}

function maybeAutoRollback(agent: ProfileRlAgentState): void {
  if (agent.tradesSinceUpdate < ROLLBACK_MIN_TRADES) return;
  if (agent.preUpdateRewardEma <= 0 && agent.rewardEma <= 0) return;
  const drop = agent.preUpdateRewardEma - agent.rewardEma;
  if (drop > ROLLBACK_EMA_DROP) {
    const res = rollbackProfileRlPolicyTo(agent.profileId, 0);
    if (res.ok) {
      agent.unstableCount = (agent.unstableCount || 0) + 1;
      pushProfileRlDecision({
        kind: 'auto_rollback',
        profileId: agent.profileId,
        detail: `Auto-rollback — EMA dropped ${drop.toFixed(2)} vs baseline ${agent.preUpdateRewardEma.toFixed(2)}`,
      });
    }
  }
}

/** PPO-style clipped update on 4-dim policy vector. */
function applyPpoPolicyUpdate(
  agent: ProfileRlAgentState,
  reward: number,
  dims: Array<keyof ProfileRlPolicy>,
  cfg: ProfileRlConfig
): string | null {
  const scale = strengthScale(cfg.strength) * modeScale(agent.mode);
  if (scale <= 0) return null;

  const before = { ...agent.policy };
  let changed = false;
  for (const dim of dims) {
    const delta = clamp(reward * 0.03 * scale, -PPO_EPS, PPO_EPS);
    const next = clamp(agent.policy[dim] + delta, -1, 1);
    if (Math.abs(next - agent.policy[dim]) >= 0.005) {
      agent.policy[dim] = next;
      changed = true;
    }
  }
  if (!changed) return null;

  agent.preUpdateRewardEma = agent.rewardEma;
  agent.tradesSinceUpdate = 0;
  const summary = dims
    .map((d) => `${d}=${agent.policy[d].toFixed(2)}`)
    .join(' · ');
  pushProfileRlPolicyHistory(agent.profileId, {
    before,
    after: { ...agent.policy },
    summary,
    sampleSize: agent.trades,
    avgReward: agent.trades > 0 ? agent.sumReward / agent.trades : 0,
  });
  return summary;
}

export function notifyProfileRlTradeClosed(input: {
  episode: ProfileLearningEpisode;
  costSol?: number | null;
}): void {
  const pid = input.episode.profileId;
  if (!pid || pid === 'default' || pid === 'zion') return;

  const cfg = getProfileRlConfig();
  const { reward, parts } = computeProfileRlReward(input.episode, input.costSol);
  const agent = getOrCreateProfileRlAgent(pid, {
    defaultMode: KEY_PROFILE_RL_IDS.includes(pid as (typeof KEY_PROFILE_RL_IDS)[number])
      ? 'shadow'
      : 'shadow',
  });

  agent.trades += 1;
  if (reward > 0) agent.wins += 1;
  agent.sumReward += reward;
  agent.lastReward = reward;
  agent.prevRewardEma = agent.rewardEma;
  agent.rewardEma =
    agent.trades <= 1
      ? reward
      : agent.rewardEma * (1 - REWARD_EMA_ALPHA) + reward * REWARD_EMA_ALPHA;
  if (agent.trades === 10 && agent.baselineRewardEma == null) {
    agent.baselineRewardEma = agent.rewardEma;
  }
  agent.tradesSinceUpdate += 1;
  agent.updatedAt = Date.now();

  const dims = activePolicyDims(input.episode);
  let policySummary: string | null = null;
  if (cfg.enabled && agent.mode !== 'shadow') {
    policySummary = applyPpoPolicyUpdate(agent, reward, dims, cfg);
  } else if (cfg.enabled) {
    // Shadow still learns internally for observation
    const shadowAgent = { ...agent, mode: 'hybrid' as ProfileRlMode };
    policySummary = applyPpoPolicyUpdate(shadowAgent, reward, dims, cfg);
    if (policySummary) agent.policy = shadowAgent.policy;
  }

  saveProfileRlState();
  maybeAutoRollback(agent);
  maybeAutoAdjustMode(agent);
  if ((agent.unstableCount || 0) > 0 && agent.trades % 5 === 0) {
    agent.unstableCount = Math.max(0, (agent.unstableCount || 0) - 1);
  }
  saveProfileRlState();

  const partStr = [
    `pnl=${parts.pnl >= 0 ? '+' : ''}${parts.pnl.toFixed(2)}`,
    `entry=${parts.entry >= 0 ? '+' : ''}${parts.entry.toFixed(2)}`,
    `exit=${parts.exit >= 0 ? '+' : ''}${parts.exit.toFixed(2)}`,
    `dd=${parts.dd.toFixed(2)}`,
    `ta=${parts.ta >= 0 ? '+' : ''}${parts.ta.toFixed(2)}`,
  ].join(' · ');

  pushProfileRlDecision({
    kind: 'trade_result',
    mint: input.episode.mint,
    symbol: input.episode.symbol,
    profileId: pid,
    detail: `reward=${reward >= 0 ? '+' : ''}${reward.toFixed(2)} · ${partStr}${policySummary ? ` · policy ${policySummary}` : ''} · ${cfg.enabled ? agent.mode : 'frozen (RL off)'}`,
  });
}

export function profileRlLaneScoreDelta(profileId: string): {
  delta: number;
  note: string;
} {
  const cfg = getProfileRlConfig();
  const agent = getOrCreateProfileRlAgent(profileId);
  if (!agentInfluenceActive(agent, cfg)) return { delta: 0, note: '' };
  const scale = strengthScale(cfg.strength) * modeScale(agent.mode);
  const raw = agent.policy.setupWorthBias * SCORE_CAP * scale;
  const delta = clamp(raw, -SCORE_CAP, SCORE_CAP);
  if (Math.abs(delta) < 0.05) return { delta: 0, note: '' };
  const note = `RL ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`;
  return { delta: Math.round(delta * 10) / 10, note };
}

export function profileRlSizeMultiplier(profileId: string | null | undefined): {
  mult: number;
  note: string;
} {
  const cfg = getProfileRlConfig();
  if (!profileId) return { mult: 1, note: '' };
  const agent = getOrCreateProfileRlAgent(profileId);
  if (!agentInfluenceActive(agent, cfg)) return { mult: 1, note: '' };
  const scale = strengthScale(cfg.strength) * modeScale(agent.mode);
  const raw = 1 + agent.policy.confidenceBias * 0.1 * scale;
  const mult = clamp(raw, SIZE_LO, SIZE_HI);
  if (Math.abs(mult - 1) < 0.01) return { mult: 1, note: '' };
  return {
    mult: Math.round(mult * 1000) / 1000,
    note: `RL size×${mult.toFixed(2)}`,
  };
}

export function profileRlTaSensitivityScale(profileId: string | null | undefined): {
  scale: number;
  note: string;
} {
  const cfg = getProfileRlConfig();
  if (!profileId) return { scale: 1, note: '' };
  const agent = getOrCreateProfileRlAgent(profileId);
  if (!agentInfluenceActive(agent, cfg)) return { scale: 1, note: '' };
  const sscale = strengthScale(cfg.strength) * modeScale(agent.mode);
  const raw = 1 + agent.policy.taSensitivityBias * 0.1 * sscale;
  const scale = clamp(raw, TA_SENS_LO, TA_SENS_HI);
  if (Math.abs(scale - 1) < 0.01) return { scale: 1, note: '' };
  return {
    scale: Math.round(scale * 1000) / 1000,
    note: `RL TA×${scale.toFixed(2)}`,
  };
}

/** Threshold shift for exit hints — positive = more aggressive (lower bar). */
export function profileRlExitAggressivenessShift(profileId: string | null | undefined): {
  shift: number;
  note: string;
} {
  const cfg = getProfileRlConfig();
  if (!profileId) return { shift: 0, note: '' };
  const agent = getOrCreateProfileRlAgent(profileId);
  if (!agentInfluenceActive(agent, cfg)) return { shift: 0, note: '' };
  const scale = strengthScale(cfg.strength) * modeScale(agent.mode);
  const shift = agent.policy.exitAggressiveness * 0.15 * scale;
  if (Math.abs(shift) < 0.02) return { shift: 0, note: '' };
  return {
    shift: Math.round(shift * 1000) / 1000,
    note: `RL exit${shift >= 0 ? '+' : ''}${(shift * 100).toFixed(0)}%`,
  };
}

export function applyProfileRlLaneRanking<
  T extends { profileId: string; passed: boolean; score: number; reason: string },
>(results: T[]): T[] {
  const cfg = getProfileRlConfig();
  if (!cfg.enabled) return results;
  for (const row of results) {
    if (!row.passed) continue;
    const { delta, note } = profileRlLaneScoreDelta(row.profileId);
    if (!note) continue;
    row.score = Math.round((row.score + delta) * 10) / 10;
    row.reason = `${row.reason} · ${note}`;
  }
  results.sort(
    (a, b) =>
      Number(b.passed) - Number(a.passed) || b.score - a.score
  );
  return results;
}

export function formatProfileRlPlainLanguage(profileId: string): string {
  const cfg = getProfileRlConfig();
  const agent = getOrCreateProfileRlAgent(profileId);
  if (!cfg.enabled) return '';
  const name = profileDisplayName(profileId);
  const readiness = computeProfileRlReadiness(agent);
  const locked = agent.modeLocked ? ' (locked)' : '';

  if (agent.mode === 'shadow') {
    if (readiness.breakdown.stability < MIN_STABILITY_FOR_PROMOTE) {
      return `${name} remains in Shadow because noise is still high (readiness ${readiness.score}/100${locked}).`;
    }
    if (readiness.score >= SHADOW_TO_HYBRID_READINESS + getProfileRlDifficulty(profileId).thresholdAdd) {
      return `${name} in Shadow — readiness ${readiness.score}/100, nearing Hybrid promotion${locked}.`;
    }
    return `${name} observing in Shadow (${agent.trades} trades, readiness ${readiness.score}/100${locked}).`;
  }

  const p = agent.policy;
  const bits: string[] = [];
  if (Math.abs(p.setupWorthBias) >= 0.08) {
    bits.push(
      p.setupWorthBias > 0
        ? 'boosting setup-worth in lane ranking'
        : 'softly down-ranking marginal setups'
    );
  }
  if (Math.abs(p.confidenceBias) >= 0.08) {
    bits.push(
      p.confidenceBias > 0
        ? 'raising confidence when context aligns'
        : 'trimming size on weak alignment'
    );
  }
  if (Math.abs(p.taSensitivityBias) >= 0.08) {
    bits.push(
      p.taSensitivityBias > 0
        ? 'heightening TA confluence sensitivity'
        : 'easing TA confluence requirements'
    );
  }
  if (Math.abs(p.exitAggressiveness) >= 0.08) {
    bits.push(
      p.exitAggressiveness > 0
        ? 'favoring earlier exit hints on giveback'
        : 'allowing more patience on exit hints'
    );
  }

  const modeNote =
    agent.mode === 'lead'
      ? `${name} leading with soft RL influence`
      : `${name} in Hybrid after stable improvement`;

  if (!bits.length) {
    const minTr = agentInfluenceMinTrades(profileId);
    return agent.trades < minTr
      ? `${name} RL agent observing (${agent.trades}/${minTr} trades, readiness ${readiness.score}/100)`
      : `${modeNote} — neutral policy (readiness ${readiness.score}/100, EMA ${agent.rewardEma.toFixed(2)}${locked}).`;
  }
  return `${modeNote}: ${bits.join('; ')} (readiness ${readiness.score}/100, EMA ${agent.rewardEma.toFixed(2)}${locked}).`;
}

export function getProfileRlStatus(opts?: {
  /** Persist readiness refresh (default true). Chat paths should pass false. */
  persist?: boolean;
  /** Create missing key agents (default true). Chat paths can skip. */
  ensureKeyAgents?: boolean;
}): {
  enabled: boolean;
  strength: ProfileRlStrength;
  label: string;
  agents: Array<
    ProfileRlAgentState & {
      winRatePct: number;
      avgReward: number;
      readinessBreakdown: ProfileRlReadinessBreakdown;
      plainLanguage: string;
    }
  >;
  decisions: ReturnType<typeof getProfileRlDecisions>;
} {
  const persist = opts?.persist !== false;
  const ensureKey = opts?.ensureKeyAgents !== false;
  const cfg = getProfileRlConfig();
  const st = loadProfileRlState();
  const agents = Object.values(st.agents)
    .map((a) => {
      const readiness = computeProfileRlReadiness(a);
      if (persist) {
        a.readinessScore = readiness.score;
        a.readinessUpdatedAt = Date.now();
      }
      return {
        ...a,
        modeLocked: a.modeLocked === true,
        readinessScore: readiness.score,
        winRatePct:
          a.trades > 0 ? Math.round((a.wins / a.trades) * 1000) / 10 : 0,
        avgReward:
          a.trades > 0
            ? Math.round((a.sumReward / a.trades) * 1000) / 1000
            : 0,
        readinessBreakdown: readiness.breakdown,
        plainLanguage: formatProfileRlPlainLanguage(a.profileId),
      };
    })
    .sort((a, b) => b.rewardEma - a.rewardEma || b.trades - a.trades);

  if (ensureKey) {
    for (const id of KEY_PROFILE_RL_IDS) {
      if (!st.agents[id]) {
        const agent = getOrCreateProfileRlAgent(id);
        const readiness = computeProfileRlReadiness(agent);
        agents.push({
          ...agent,
          modeLocked: false,
          readinessScore: readiness.score,
          winRatePct: 0,
          avgReward: 0,
          readinessBreakdown: readiness.breakdown,
          plainLanguage: formatProfileRlPlainLanguage(id),
        });
      }
    }
  }

  if (persist) saveProfileRlState();

  return {
    ...cfg,
    label: cfg.enabled ? `Profile RL · ${cfg.strength}` : 'Profile RL OFF',
    agents,
    decisions: getProfileRlDecisions(40),
  };
}

export {
  rollbackProfileRlPolicyTo,
  setProfileRlAgentMode,
};
