import type { MlLearnMode } from '../../profileLearningMl';

/**
 * Auto-promote shadow→hybrid→lead from episode/model gates (1.2.421).
 * Soft-demotes lead→hybrid only; never auto-sets off.
 */
export function maybeAutoAdvanceMlMode(input: {
  enabled: boolean;
  mlMode: MlLearnMode;
  mlValidatedInPaper: boolean;
  level: number;
  episodeCount: number;
  holdoutAuc: number;
  hasModel: boolean;
  stale: boolean;
}): { mlMode: MlLearnMode; from: MlLearnMode; reason: string } | null {
  if (!input.enabled || input.mlMode === 'off') return null;

  const n = Math.max(0, Math.round(Number(input.episodeCount) || 0));
  const auc = Number(input.holdoutAuc) || 0;
  const level = Math.max(0, Math.round(Number(input.level) || 0));
  const from = input.mlMode;

  if (from === 'lead') {
    if (!input.hasModel || input.stale || auc < 0.52) {
      return {
        mlMode: 'hybrid',
        from,
        reason: !input.hasModel
          ? 'model missing'
          : input.stale
            ? 'model stale'
            : 'holdout AUC < 0.52',
      };
    }
    return null;
  }

  if (from === 'hybrid') {
    if (
      input.hasModel &&
      !input.stale &&
      auc >= 0.58 &&
      n >= 80 &&
      level >= 2 &&
      input.mlValidatedInPaper
    ) {
      return { mlMode: 'lead', from, reason: 'AUC≥0.58 · 80+ eps · L2+ · paper-validated' };
    }
    return null;
  }

  if (from === 'shadow') {
    if (input.hasModel && auc >= 0.54 && n >= 40 && (level >= 1 || input.mlValidatedInPaper)) {
      return { mlMode: 'hybrid', from, reason: 'AUC≥0.54 · 40+ eps' };
    }
  }
  return null;
}
