/**
 * 1.2.421 learning enhancements scheduler — soft paths only.
 * Never applies Level upgrades (those stay on trade-close).
 */

import { logger } from '../../logger';
import { isBotLearningPackOn, loadBotLearningSettings } from './settings';
import { meanEpisodeQuality } from './episodeQuality';

let timer: ReturnType<typeof setInterval> | null = null;
let lastTickAt = 0;
let lastQualityAvg = 0;
let lastWarning = '';

export function getEnhancementsStatus(): {
  running: boolean;
  lastTickAt: number;
  lastQualityAvg: number;
  lastWarning: string;
} {
  return { running: timer != null, lastTickAt, lastQualityAvg, lastWarning };
}

function tick(): void {
  if (!isBotLearningPackOn()) return;
  const s = loadBotLearningSettings();
  if (!s.enhancements.enabled || !s.enhancements.schedulerEnabled) return;
  lastTickAt = Date.now();
  try {
    const { getTradeProfilesStatus } =
      require('../../tradeProfiles') as typeof import('../../tradeProfiles');
    const { getProfileLearningEpisodes } =
      require('../../profileLearningEpisodes') as typeof import('../../profileLearningEpisodes');
    const profiles = getTradeProfilesStatus().profiles;
    let qSum = 0;
    let qN = 0;
    let stalled = 0;
    for (const p of profiles) {
      if (!p?.id || p.id === 'default') continue;
      const eps = getProfileLearningEpisodes(p.id, 80);
      if (!eps.length) continue;
      qSum += meanEpisodeQuality(eps);
      qN += 1;
      const last = eps[eps.length - 1];
      if (s.enhancements.watchdogEnabled && last && Date.now() - last.closedAt > 36 * 3600_000) {
        stalled += 1;
      }
    }
    lastQualityAvg = qN ? Number((qSum / qN).toFixed(3)) : 0;
    lastWarning =
      s.enhancements.watchdogEnabled && stalled > 0
        ? `${stalled} profile(s) with no close in 36h`
        : '';
    if (s.accelerators.enabled && s.accelerators.replayEnabled) {
      logger.info('Learning', 'replay hint pass (soft)', {
        profiles: qN,
        quality: lastQualityAvg,
      });
    }
  } catch (err) {
    lastWarning = err instanceof Error ? err.message : String(err);
  }
}

export function startBotLearningEnhancements(): void {
  stopBotLearningEnhancements();
  const s = loadBotLearningSettings();
  if (!s.enhancements.enabled || !s.enhancements.schedulerEnabled) {
    console.log('[upgrades] bot_learning_421 scheduler idle (enhancements off)');
    return;
  }
  const ms = s.enhancements.schedulerIntervalMs;
  timer = setInterval(() => tick(), ms);
  setTimeout(() => tick(), 8_000);
  console.log(`[upgrades] bot_learning_421 enhancements scheduler every ${ms}ms`);
}

export function stopBotLearningEnhancements(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
