/**
 * Learning Enhancements — additive soft layer for micro-bots.
 *
 * Integration priority (never bypass):
 *   Safety → hard bot rules → MARL → soft coaches/accelerators/enhancements → clamped self-learn
 *
 * Master toggle default OFF. Feeds existing channels only — no parallel hard mutation paths.
 * Scheduler does NOT apply Level upgrades or hard self-learn mutations; those stay on trade-close path.
 */

import { config } from './config';
import type { ProfileLearningEpisode } from './profileLearningEpisodes';
import {
  computeEpisodeQualityWeight,
  meanEpisodeQuality,
} from './episodeQuality';
import { logger } from './logger';

export interface LearningEnhancementsConfig {
  enabled: boolean;
  schedulerEnabled: boolean;
  qualityWeightingEnabled: boolean;
  dualRewardEnabled: boolean;
  explorationEnabled: boolean;
  explorationRate: number;
  watchdogEnabled: boolean;
  schedulerIntervalMs: number;
}

export const DEFAULT_LEARNING_ENHANCEMENTS_CONFIG: LearningEnhancementsConfig = {
  enabled: false,
  schedulerEnabled: true,
  qualityWeightingEnabled: true,
  dualRewardEnabled: true,
  explorationEnabled: true,
  explorationRate: 0.08,
  watchdogEnabled: true,
  schedulerIntervalMs: 120_000,
};

interface SchedulerActivityEntry {
  at: number;
  profileId: string;
  action: string;
  detail: string;
}

interface ProfileTickState {
  lastEpisodeCount: number;
  lastClosedAt: number;
  lastTickAt: number;
}

interface WatchdogState {
  lastSchedulerTickAt: number;
  profileEpisodeCounts: Record<string, { count: number; at: number }>;
  sustainedWarnings: Record<string, { count: number; firstAt: number }>;
  lastEmailAt: number;
}

const MAX_ACTIVITY_RING = 80;
const activityRing: SchedulerActivityEntry[] = [];
const profileTicks = new Map<string, ProfileTickState>();
const watchdog: WatchdogState = {
  lastSchedulerTickAt: 0,
  profileEpisodeCounts: {},
  sustainedWarnings: {},
  lastEmailAt: 0,
};

let explorationUsedCount = 0;
let lastSchedulerTickAt = 0;
let lastQualityAvg = 0;
let watchdogWarnings: string[] = [];
let schedulerTimer: ReturnType<typeof setInterval> | null = null;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function pushActivity(profileId: string, action: string, detail: string): void {
  activityRing.push({ at: Date.now(), profileId, action, detail });
  while (activityRing.length > MAX_ACTIVITY_RING) activityRing.shift();
}

export function getLearningEnhancementsConfig(): LearningEnhancementsConfig {
  const m = (config as { learningEnhancements?: Partial<LearningEnhancementsConfig> })
    .learningEnhancements;
  return {
    enabled: m?.enabled === true,
    schedulerEnabled: m?.schedulerEnabled !== false,
    qualityWeightingEnabled: m?.qualityWeightingEnabled !== false,
    dualRewardEnabled: m?.dualRewardEnabled !== false,
    explorationEnabled: m?.explorationEnabled !== false,
    explorationRate: clamp(Number(m?.explorationRate) || 0.08, 0.01, 0.25),
    watchdogEnabled: m?.watchdogEnabled !== false,
    schedulerIntervalMs: clamp(
      Math.round(Number(m?.schedulerIntervalMs) || 120_000),
      60_000,
      600_000
    ),
  };
}

export function setLearningEnhancementsConfig(
  patch: Partial<LearningEnhancementsConfig>
): LearningEnhancementsConfig {
  const cur = getLearningEnhancementsConfig();
  const next: LearningEnhancementsConfig = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
    schedulerEnabled:
      typeof patch.schedulerEnabled === 'boolean'
        ? patch.schedulerEnabled
        : cur.schedulerEnabled,
    qualityWeightingEnabled:
      typeof patch.qualityWeightingEnabled === 'boolean'
        ? patch.qualityWeightingEnabled
        : cur.qualityWeightingEnabled,
    dualRewardEnabled:
      typeof patch.dualRewardEnabled === 'boolean'
        ? patch.dualRewardEnabled
        : cur.dualRewardEnabled,
    explorationEnabled:
      typeof patch.explorationEnabled === 'boolean'
        ? patch.explorationEnabled
        : cur.explorationEnabled,
    explorationRate:
      patch.explorationRate != null
        ? clamp(Number(patch.explorationRate), 0.01, 0.25)
        : cur.explorationRate,
    watchdogEnabled:
      typeof patch.watchdogEnabled === 'boolean'
        ? patch.watchdogEnabled
        : cur.watchdogEnabled,
    schedulerIntervalMs:
      patch.schedulerIntervalMs != null
        ? clamp(Math.round(Number(patch.schedulerIntervalMs)), 60_000, 600_000)
        : cur.schedulerIntervalMs,
  };
  (config as { learningEnhancements: LearningEnhancementsConfig }).learningEnhancements = next;
  try {
    const { persistUserSettings } = require('./config') as typeof import('./config');
    persistUserSettings();
  } catch {
    /* */
  }
  pushActivity('*', 'config', `Learning Enhancements ${next.enabled ? 'ON' : 'OFF'}`);
  if (next.enabled && next.schedulerEnabled) {
    restartLearningEnhancementsScheduler();
  } else if (!next.enabled) {
    stopLearningEnhancementsScheduler();
  }
  return next;
}

/** Scale base Profile RL reward by episode quality when enhancements + quality weighting ON. */
export function scaleRewardByEpisodeQuality(
  baseReward: number,
  episode: ProfileLearningEpisode
): { reward: number; qualityWeight: number } {
  const cfg = getLearningEnhancementsConfig();
  let forceQw = false;
  try {
    const { shouldQualityWeightDipBuyerEpisodes } =
      require('./dipBuyerRecovery') as typeof import('./dipBuyerRecovery');
    forceQw = shouldQualityWeightDipBuyerEpisodes(episode.profileId);
  } catch {
    /* optional */
  }
  if ((!cfg.enabled || !cfg.qualityWeightingEnabled) && !forceQw) {
    return { reward: baseReward, qualityWeight: 1 };
  }
  const qw = computeEpisodeQualityWeight(episode);
  const scaled = clamp(baseReward * qw, -3, 3);
  return { reward: scaled, qualityWeight: qw };
}

/**
 * Dual-objective reward shaping — enriches (never replaces) primary risk-adjusted PnL.
 * Adds profile-aware consistency bonuses and drawdown/giveback penalties.
 */
export function applyDualObjectiveRewardShaping(input: {
  baseReward: number;
  parts: {
    pnl: number;
    entry: number;
    exit: number;
    dd: number;
    ta: number;
    replayBonus?: number;
    cfBonus?: number;
    dualBonus?: number;
    dualPenalty?: number;
    qualityWeight?: number;
  };
  episode: ProfileLearningEpisode;
  profileId: string;
}): {
  reward: number;
  parts: typeof input.parts;
} {
  const cfg = getLearningEnhancementsConfig();
  const parts = { ...input.parts };
  if (!cfg.enabled || !cfg.dualRewardEnabled) {
    return { reward: input.baseReward, parts };
  }

  let bonus = 0;
  let penalty = 0;
  const pid = input.profileId;
  const ep = input.episode;
  const giveback = Math.max(0, ep.givebackFromPeakPct || 0);
  const dd = Math.abs(ep.maxDrawdownPct || 0);
  const pnlPct = Number(ep.pnlPct) || 0;
  const holdSec = Number(ep.holdSec) || 0;

  // Penalties: drawdown, excessive giveback
  if (dd >= 18) penalty += clamp((dd - 18) / 40, 0, 0.12);
  if (giveback >= 22 && pnlPct < ep.maxRunupPct * 0.4) {
    penalty += clamp((giveback - 22) / 50, 0, 0.1);
  }

  // Bonuses: scalper / momentum consistency
  if (pid === 'scalper' || pid === 'momentum_burst' || pid === 'micro_scalper') {
    if (holdSec >= 20 && holdSec <= 420 && pnlPct > 0 && giveback <= 12) bonus += 0.06;
    if (ep.timingReward != null && ep.timingReward >= 1.5) bonus += 0.04;
  }

  // Bonuses: trend / dip clean runners
  if (pid === 'trend_rider' || pid === 'dip_buyer' || pid === 'post_run_dip') {
    if (ep.maxRunupPct >= 15 && giveback <= 18 && pnlPct >= 5) bonus += 0.07;
    if (ep.taConditionsHeldIntoProfit === true && pnlPct > 0) bonus += 0.03;
  }

  // High-win-rate / steady profiles — reward stable small wins
  if (pid === 'high_win_rate' || pid === 'steady_compounder') {
    if (pnlPct >= 3 && pnlPct <= 25 && giveback <= 10) bonus += 0.05;
  }

  bonus = clamp(bonus, 0, 0.15);
  penalty = clamp(penalty, 0, 0.15);

  let reward = clamp(input.baseReward + bonus - penalty, -3, 3);

  // Quality weighting applied after dual shaping
  const { reward: qwReward, qualityWeight } = scaleRewardByEpisodeQuality(reward, ep);
  reward = qwReward;

  if (bonus > 0) parts.dualBonus = Number(bonus.toFixed(3));
  if (penalty > 0) parts.dualPenalty = Number(penalty.toFixed(3));
  if (qualityWeight !== 1) parts.qualityWeight = qualityWeight;

  return { reward, parts };
}

/**
 * Controlled exploration — soft nudge toward mild alternative policy bias.
 * Never bypasses safety / anti-rug / hard filters.
 */
export function maybeApplyExplorationNudge(profileId: string): {
  applied: boolean;
  detail: string;
} {
  const cfg = getLearningEnhancementsConfig();
  if (!cfg.enabled || !cfg.explorationEnabled) {
    return { applied: false, detail: '' };
  }
  if (Math.random() >= cfg.explorationRate) {
    return { applied: false, detail: '' };
  }

  try {
    const { getProfileRlConfig } =
      require('./profileRlAgent') as typeof import('./profileRlAgent');
    const { getOrCreateProfileRlAgent, saveProfileRlState } =
      require('./profileRlStore') as typeof import('./profileRlStore');
    if (!getProfileRlConfig().enabled) return { applied: false, detail: '' };

    const agent = getOrCreateProfileRlAgent(profileId);
    if (agent.mode === 'shadow' && agent.trades < 6) {
      return { applied: false, detail: '' };
    }

    const dir = Math.random() < 0.5 ? -1 : 1;
    const delta = dir * 0.015;
    agent.policy.setupWorthBias = clamp(agent.policy.setupWorthBias + delta, -1, 1);
    agent.policy.confidenceBias = clamp(
      agent.policy.confidenceBias - delta * 0.5,
      -1,
      1
    );
    agent.updatedAt = Date.now();
    saveProfileRlState();
    explorationUsedCount += 1;
    const detail = `Explore nudge ${profileId}: setupWorth ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}`;
    pushActivity(profileId, 'explore', detail);
    return { applied: true, detail };
  } catch {
    return { applied: false, detail: '' };
  }
}

/** Tag episode for explore-priority replay (soft hint only). */
export function tagEpisodeForExploration(episodeId: string, profileId: string): void {
  const cfg = getLearningEnhancementsConfig();
  if (!cfg.enabled || !cfg.explorationEnabled) return;
  if (Math.random() >= cfg.explorationRate * 0.5) return;
  pushActivity(profileId, 'explore_tag', `Tagged ${episodeId.slice(0, 8)} for explore replay`);
}

function listLearningProfileIds(): string[] {
  try {
    const { getTradeProfilesStatus } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    const tp = getTradeProfilesStatus();
    return (tp.profiles || [])
      .map((p: { id: string }) => p.id)
      .filter((id: string) => id && id !== 'default' && id !== 'zion');
  } catch {
    return [];
  }
}

/**
 * Scheduler tick — soft batches only. Does NOT run Level upgrades or hard self-learn mutations.
 * Safe paths: quality weights, replay/CF soft hints, Profile RL readiness refresh, TA nudge.
 */
export function runLearningEnhancementsSchedulerTick(): void {
  const cfg = getLearningEnhancementsConfig();
  if (!cfg.enabled || !cfg.schedulerEnabled) return;

  const now = Date.now();
  lastSchedulerTickAt = now;
  watchdog.lastSchedulerTickAt = now;

  const { getProfileLearningEpisodes } =
    require('./profileLearningEpisodes') as typeof import('./profileLearningEpisodes');

  let tickActions = 0;
  const profileIds = listLearningProfileIds();

  for (const profileId of profileIds) {
    const episodes = getProfileLearningEpisodes(profileId, 80);
    const epCount = episodes.length;
    const lastClosed = episodes.length ? episodes[episodes.length - 1].closedAt : 0;

    const prev = profileTicks.get(profileId) || {
      lastEpisodeCount: 0,
      lastClosedAt: 0,
      lastTickAt: 0,
    };

    const hasNew = epCount > prev.lastEpisodeCount || lastClosed > prev.lastClosedAt;
    profileTicks.set(profileId, {
      lastEpisodeCount: epCount,
      lastClosedAt: lastClosed,
      lastTickAt: now,
    });

    watchdog.profileEpisodeCounts[profileId] = { count: epCount, at: now };

    if (!hasNew) continue;

    // Soft replay / CF hints via accelerators (existing channel)
    try {
      const { getLearningAcceleratorsConfig, maybeRunReplayBatch } =
        require('./learningReplayBuffer') as typeof import('./learningReplayBuffer');
      const acc = getLearningAcceleratorsConfig();
      if (acc.enabled && acc.replayEnabled) {
        maybeRunReplayBatch(profileId);
        pushActivity(profileId, 'replay', 'Scheduler replay batch check');
        tickActions += 1;
      }
    } catch {
      /* optional */
    }

    // TA nudge from episodes (existing — never TP/SL)
    try {
      const { maybeNudgeProfileTaFromEpisodes } =
        require('./profileTaPlaybookStore') as typeof import('./profileTaPlaybookStore');
      const ta = maybeNudgeProfileTaFromEpisodes(profileId);
      if (ta.applied && ta.summary) {
        pushActivity(profileId, 'ta_nudge', ta.summary);
        tickActions += 1;
      }
    } catch {
      /* optional */
    }

    // Profile RL readiness refresh (observation only — no hard mutations)
    try {
      const { getProfileRlConfig, computeProfileRlReadiness } =
        require('./profileRlAgent') as typeof import('./profileRlAgent');
      const { getOrCreateProfileRlAgent, saveProfileRlState } =
        require('./profileRlStore') as typeof import('./profileRlStore');
      if (getProfileRlConfig().enabled) {
        const agent = getOrCreateProfileRlAgent(profileId);
        const readiness = computeProfileRlReadiness(agent);
        agent.readinessScore = readiness.score;
        agent.readinessUpdatedAt = now;
        saveProfileRlState();
        pushActivity(
          profileId,
          'rl_readiness',
          `Readiness refresh ${readiness.score}/100`
        );
        tickActions += 1;
      }
    } catch {
      /* optional */
    }

    // Controlled exploration nudge (soft)
    const explore = maybeApplyExplorationNudge(profileId);
    if (explore.applied) tickActions += 1;

    // NOTE: Hard self-learn (runSelfLearnTick / Level upgrades) intentionally NOT called here.
    // Those remain on trade-close path via onProfileTradeClosedForSelfLearn only.
  }

  if (cfg.qualityWeightingEnabled && profileIds.length) {
    const allEps: ProfileLearningEpisode[] = [];
    for (const pid of profileIds.slice(0, 12)) {
      allEps.push(...getProfileLearningEpisodes(pid, 20));
    }
    lastQualityAvg = meanEpisodeQuality(allEps.slice(-60));
  }

  if (cfg.watchdogEnabled) {
    watchdogWarnings = runLearningHealthWatchdog();
  }

  if (tickActions === 0) {
    pushActivity('*', 'idle', 'No new episode data');
  } else {
    logger.info(
      'LearningEnhancements',
      `Scheduler tick: ${tickActions} soft action(s) across ${profileIds.length} profiles`
    );
  }
}

/** Detect sustained learning health issues. Read-only except internal watchdog state. */
export function runLearningHealthWatchdog(): string[] {
  const cfg = getLearningEnhancementsConfig();
  if (!cfg.enabled || !cfg.watchdogEnabled) return [];

  const warnings: string[] = [];
  const now = Date.now();

  try {
    const { getTradeProfilesStatus, getGlobalMicroBotTakeProfitPct } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    const tp = getTradeProfilesStatus();
    const globalTp = getGlobalMicroBotTakeProfitPct();
    const enabledBots = (tp.profiles || []).filter(
      (p: { enabled: boolean; id: string }) => p.enabled && p.id !== 'default'
    );

    if (globalTp != null) {
      warnings.push('Self-learn exit deltas paused by Global TP.');
    }

    // No new episodes while bots running
    for (const p of enabledBots) {
      const st = watchdog.profileEpisodeCounts[p.id];
      const prev = profileTicks.get(p.id);
      if (st && prev && now - prev.lastTickAt > 30 * 60_000 && st.count === prev.lastEpisodeCount) {
        warnings.push(`${p.id}: no new closes in ~30+ min while bot enabled.`);
      }
    }

    // Accelerators ON but apply hints off
    try {
      const { getLearningAcceleratorsConfig } =
        require('./learningReplayBuffer') as typeof import('./learningReplayBuffer');
      const acc = getLearningAcceleratorsConfig();
      if (acc.enabled && acc.counterfactualEnabled && !acc.counterfactualApplyHints) {
        warnings.push('Accelerators ON but CF apply-hints OFF — counterfactuals computed but not applied.');
      }
    } catch {
      /* */
    }

    // Profile RL stuck Shadow with high readiness
    try {
      const { getProfileRlConfig, getProfileRlStatus } =
        require('./profileRlAgent') as typeof import('./profileRlAgent');
      if (getProfileRlConfig().enabled) {
        const prl = getProfileRlStatus({ persist: false, ensureKeyAgents: false });
        for (const a of prl.agents) {
          if (
            a.mode === 'shadow' &&
            (a.readinessScore ?? 0) >= 70 &&
            (a.trades ?? 0) >= 12
          ) {
            warnings.push(
              `${a.profileId}: Profile RL stuck Shadow despite readiness ${a.readinessScore}/100 (n=${a.trades}).`
            );
          }
        }
      }
    } catch {
      /* */
    }

    // One profile monopolising samples
    const counts = Object.values(watchdog.profileEpisodeCounts);
    if (counts.length >= 3) {
      const total = counts.reduce((s, c) => s + c.count, 0);
      const max = Math.max(...counts.map((c) => c.count));
      if (total >= 40 && max / total > 0.65) {
        warnings.push('One profile monopolising episode samples (>65%).');
      }
    }

    // Scheduler freeze
    if (cfg.schedulerEnabled && lastSchedulerTickAt > 0 && now - lastSchedulerTickAt > cfg.schedulerIntervalMs * 3) {
      warnings.push('Learning Enhancements scheduler may be frozen (no recent ticks).');
    }
  } catch {
    /* fail-open */
  }

  // Track sustained warnings for optional email
  for (const w of warnings) {
    const st = watchdog.sustainedWarnings[w] || { count: 0, firstAt: now };
    st.count += 1;
    watchdog.sustainedWarnings[w] = st;
  }

  // Optional email with heavy cooldown (4h) on sustained action-needed
  const sustained = warnings.filter((w) => (watchdog.sustainedWarnings[w]?.count ?? 0) >= 3);
  if (
    sustained.length >= 2 &&
    now - watchdog.lastEmailAt > 4 * 3_600_000 &&
    config.zionAgent?.supervisionEmailEnabled !== false
  ) {
    try {
      const { sendCustomEmail } =
        require('./emailNotifications') as typeof import('./emailNotifications');
      const to =
        String(config.notifications?.email || '').trim() ||
        'bondback2026@gmail.com';
      void sendCustomEmail({
        to,
        subject: '[Bot] Learning Enhancements — action suggested',
        text: `Watchdog detected sustained issues:\n\n${sustained.map((s) => `• ${s}`).join('\n')}\n\nCheck Micro Bots → Learning Enhancements diagnostics.`,
        html: (() => {
          try {
            const {
              renderDarkEmail,
              emailCard,
              emailListItems,
              emailParagraphsFromText,
            } = require('./emailTheme') as typeof import('./emailTheme');
            return renderDarkEmail({
              eyebrow: 'Learning Enhancements',
              title: 'Action suggested',
              subtitle: 'Watchdog sustained warnings',
              bodyHtml:
                emailCard({
                  title: 'Issues',
                  bodyHtml: emailListItems(sustained),
                }) +
                emailParagraphsFromText(
                  'Check Micro Bots → Learning Enhancements diagnostics.'
                ),
            });
          } catch {
            return undefined;
          }
        })(),
      });
      watchdog.lastEmailAt = now;
    } catch {
      /* optional */
    }
  }

  return warnings.slice(0, 8);
}

export function getLearningEnhancementsStatus(): {
  config: LearningEnhancementsConfig;
  label: string;
  lastSchedulerTickAt: number;
  lastQualityAvg: number;
  explorationUsedCount: number;
  watchdogWarnings: string[];
  activity: SchedulerActivityEntry[];
  schedulerRunning: boolean;
} {
  const cfg = getLearningEnhancementsConfig();
  const parts: string[] = [];
  if (cfg.enabled) {
    parts.push('ON');
    if (cfg.schedulerEnabled) parts.push('scheduler');
    if (cfg.qualityWeightingEnabled) parts.push('quality');
    if (cfg.dualRewardEnabled) parts.push('dual-reward');
    if (cfg.explorationEnabled) parts.push(`explore ${(cfg.explorationRate * 100).toFixed(0)}%`);
    if (cfg.watchdogEnabled) parts.push('watchdog');
  }
  return {
    config: cfg,
    label: cfg.enabled ? `Learning Enhancements ${parts.join(' · ')}` : 'Learning Enhancements OFF',
    lastSchedulerTickAt,
    lastQualityAvg,
    explorationUsedCount,
    watchdogWarnings,
    activity: [...activityRing].slice(-20),
    schedulerRunning: schedulerTimer != null,
  };
}

export function formatLearningEnhancementsPlainLanguage(): string {
  const st = getLearningEnhancementsStatus();
  if (!st.config.enabled) return 'Learning Enhancements OFF — additive scheduler/quality/explore/watchdog idle.';
  const tick =
    st.lastSchedulerTickAt > 0
      ? `${Math.round((Date.now() - st.lastSchedulerTickAt) / 1000)}s ago`
      : 'never';
  const warn =
    st.watchdogWarnings.length > 0
      ? ` · ${st.watchdogWarnings.length} watchdog warn`
      : '';
  return `Enhancements ON — last tick ${tick} · quality avg ${st.lastQualityAvg.toFixed(2)} · explore used ${st.explorationUsedCount}${warn}`;
}

export function restartLearningEnhancementsScheduler(): void {
  stopLearningEnhancementsScheduler();
  startLearningEnhancementsScheduler();
}

export function startLearningEnhancementsScheduler(): void {
  const cfg = getLearningEnhancementsConfig();
  if (!cfg.enabled || !cfg.schedulerEnabled) return;
  if (schedulerTimer) return;

  setTimeout(() => {
    try {
      runLearningEnhancementsSchedulerTick();
    } catch (err) {
      logger.warn('LearningEnhancements', 'initial tick failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }, 12_000);

  schedulerTimer = setInterval(() => {
    try {
      runLearningEnhancementsSchedulerTick();
    } catch (err) {
      logger.warn('LearningEnhancements', 'scheduler tick failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }, cfg.schedulerIntervalMs);

  logger.info(
    'LearningEnhancements',
    `Scheduler started (interval ${cfg.schedulerIntervalMs}ms)`
  );
}

export function stopLearningEnhancementsScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}
