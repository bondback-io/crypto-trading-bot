import {
  startBotLearningEnhancements,
  stopBotLearningEnhancements,
} from '../learning/enhancements';
import { loadBotLearningSettings } from '../learning/settings';

export function enableBotLearning421(): void {
  const s = loadBotLearningSettings();
  startBotLearningEnhancements();
  console.log(
    `[upgrades] bot_learning_421 ON — 400-ep film · live=${s.includeLiveModeEpisodes} · ` +
      `resetEps=${s.includeDashboardResetEpisodes} · learningMode=${s.learningMode.enabled ? s.learningMode.strictness : 'off'} · ` +
      `MARL=${s.marl.enabled} · RL=${s.profileRl.enabled} · accel=${s.accelerators.enabled} · enh=${s.enhancements.enabled}`
  );
}

export function disableBotLearning421(): void {
  stopBotLearningEnhancements();
  console.log('[upgrades] bot_learning_421 OFF — 1.2.21 self-learn path');
}
