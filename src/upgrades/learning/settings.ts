/**
 * Persisted 1.2.421 Bot Learning settings. Pack OFF ignores this file.
 */

import { atomicWriteJson, dataFile, readJsonFile } from '../../dataDir';
import { isUpgradeEnabled } from '../registry';

export type LearningModeStrictness = 'stricter' | 'middle' | 'looser';
export type MarlStrength = 'low' | 'medium' | 'high';

export interface BotLearningSettings {
  includeLiveModeEpisodes: boolean;
  includeDashboardResetEpisodes: boolean;
  learningMode: {
    enabled: boolean;
    strictness: LearningModeStrictness;
    fairnessBoost: boolean;
  };
  marl: {
    enabled: boolean;
    strength: MarlStrength;
    lowMcUsd: number;
    maxAgentsPerLowMc: number;
    laggingSupportEnabled: boolean;
  };
  profileRl: {
    enabled: boolean;
    strength: MarlStrength;
  };
  accelerators: {
    enabled: boolean;
    replayEnabled: boolean;
    counterfactualEnabled: boolean;
    teacherStudentEnabled: boolean;
    strength: MarlStrength;
  };
  enhancements: {
    enabled: boolean;
    schedulerEnabled: boolean;
    qualityWeightingEnabled: boolean;
    dualRewardEnabled: boolean;
    explorationEnabled: boolean;
    explorationRate: number;
    watchdogEnabled: boolean;
    schedulerIntervalMs: number;
  };
}

export const DEFAULT_BOT_LEARNING: BotLearningSettings = {
  includeLiveModeEpisodes: false,
  includeDashboardResetEpisodes: false,
  learningMode: {
    enabled: false,
    strictness: 'middle',
    fairnessBoost: true,
  },
  marl: {
    enabled: false,
    strength: 'medium',
    lowMcUsd: 175_000,
    maxAgentsPerLowMc: 1,
    laggingSupportEnabled: true,
  },
  profileRl: {
    enabled: false,
    strength: 'medium',
  },
  accelerators: {
    enabled: false,
    replayEnabled: false,
    counterfactualEnabled: true,
    teacherStudentEnabled: false,
    strength: 'low',
  },
  enhancements: {
    enabled: false,
    schedulerEnabled: true,
    qualityWeightingEnabled: true,
    dualRewardEnabled: true,
    explorationEnabled: true,
    explorationRate: 0.08,
    watchdogEnabled: true,
    schedulerIntervalMs: 120_000,
  },
};

const FILE = () => dataFile('upgrade-bot-learning.json');

let cached: BotLearningSettings | null = null;

function clampStrength(v: unknown, fallback: MarlStrength): MarlStrength {
  return v === 'low' || v === 'high' || v === 'medium' ? v : fallback;
}

function normalize(raw: Partial<BotLearningSettings> | null | undefined): BotLearningSettings {
  const d = DEFAULT_BOT_LEARNING;
  const r = raw && typeof raw === 'object' ? raw : {};
  const lm = r.learningMode || d.learningMode;
  const marl = r.marl || d.marl;
  const rl = r.profileRl || d.profileRl;
  const acc = r.accelerators || d.accelerators;
  const en = r.enhancements || d.enhancements;
  return {
    includeLiveModeEpisodes: r.includeLiveModeEpisodes === true,
    includeDashboardResetEpisodes: r.includeDashboardResetEpisodes === true,
    learningMode: {
      enabled: lm.enabled === true,
      strictness:
        lm.strictness === 'stricter' || lm.strictness === 'looser'
          ? lm.strictness
          : 'middle',
      fairnessBoost: lm.fairnessBoost !== false,
    },
    marl: {
      enabled: marl.enabled === true,
      strength: clampStrength(marl.strength, 'medium'),
      lowMcUsd: Number.isFinite(Number(marl.lowMcUsd))
        ? Math.max(10_000, Number(marl.lowMcUsd))
        : d.marl.lowMcUsd,
      maxAgentsPerLowMc: Math.max(
        1,
        Math.min(5, Math.round(Number(marl.maxAgentsPerLowMc) || 1))
      ),
      laggingSupportEnabled: marl.laggingSupportEnabled !== false,
    },
    profileRl: {
      enabled: rl.enabled === true,
      strength: clampStrength(rl.strength, 'medium'),
    },
    accelerators: {
      enabled: acc.enabled === true,
      replayEnabled: acc.replayEnabled === true,
      counterfactualEnabled: acc.counterfactualEnabled !== false,
      teacherStudentEnabled: acc.teacherStudentEnabled === true,
      strength: clampStrength(acc.strength, 'low'),
    },
    enhancements: {
      enabled: en.enabled === true,
      schedulerEnabled: en.schedulerEnabled !== false,
      qualityWeightingEnabled: en.qualityWeightingEnabled !== false,
      dualRewardEnabled: en.dualRewardEnabled !== false,
      explorationEnabled: en.explorationEnabled !== false,
      explorationRate: Math.max(
        0,
        Math.min(0.25, Number(en.explorationRate) || 0.08)
      ),
      watchdogEnabled: en.watchdogEnabled !== false,
      schedulerIntervalMs: Math.max(
        30_000,
        Math.min(600_000, Number(en.schedulerIntervalMs) || 120_000)
      ),
    },
  };
}

export function loadBotLearningSettings(): BotLearningSettings {
  if (cached) return cached;
  cached = normalize(readJsonFile<Partial<BotLearningSettings>>(FILE()));
  return cached;
}

export function saveBotLearningSettings(
  patch: Partial<BotLearningSettings>
): BotLearningSettings {
  const cur = loadBotLearningSettings();
  cached = normalize({
    ...cur,
    ...patch,
    learningMode: { ...cur.learningMode, ...(patch.learningMode || {}) },
    marl: { ...cur.marl, ...(patch.marl || {}) },
    profileRl: { ...cur.profileRl, ...(patch.profileRl || {}) },
    accelerators: { ...cur.accelerators, ...(patch.accelerators || {}) },
    enhancements: { ...cur.enhancements, ...(patch.enhancements || {}) },
  });
  atomicWriteJson(FILE(), cached);
  return cached;
}

export function isBotLearningPackOn(): boolean {
  return isUpgradeEnabled('bot_learning_421');
}

/** 1.2.421 ring size when pack is on; 1.2.21 core stays 400 either way. */
export function botLearningEpisodeCap(): number {
  return isBotLearningPackOn() ? 400 : 400;
}

export function botLearningTickEpisodeLimit(): number {
  return isBotLearningPackOn() ? 400 : 120;
}
