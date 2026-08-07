/**
 * Counterfactual TP/SL / exit evaluation — evaluation-only rows stamped on episodes.
 * Soft hints only; never writes catalog TP/SL or Peak Protect cores.
 */

import type { ProfileLearningEpisode } from './profileLearningEpisodes';
import { getLearningAcceleratorsConfig, pushAccelDecisionRef } from './learningReplayBuffer';

export interface CounterfactualStamp {
  cfPeakExitPnlPct?: number;
  cfActualVsPeakGapPct?: number;
  cfTighterPppBetter?: boolean;
  cfLooserPppBetter?: boolean;
  cfLaterArmBetter?: boolean;
  cfSkipPartialBetter?: boolean;
  cfEarlierTpBetter?: boolean;
  cfSlWiderWouldSurvive?: boolean;
  cfSummary?: string;
}

const cfDecisions: Array<{ at: number; profileId?: string; detail: string }> = [];

function pushCfDecision(profileId: string, detail: string): void {
  cfDecisions.unshift({ at: Date.now(), profileId, detail });
  if (cfDecisions.length > 60) cfDecisions.pop();
  pushAccelDecisionRef('counterfactual', profileId, detail);
}

/** Export for replay buffer to share decision ring — avoid circular init issues */
export function getCounterfactualDecisions(limit = 30): typeof cfDecisions {
  return cfDecisions.slice(0, limit);
}

export function computeCounterfactuals(input: {
  episode: ProfileLearningEpisode;
  takeProfitPct?: number | null;
  stopLossPct?: number | null;
  peakProtectGivebackOfPeakPct?: number | null;
}): CounterfactualStamp {
  const ep = input.episode;
  const actual = ep.pnlPct;
  const peak = ep.maxRunupPct;
  const giveback = ep.givebackFromPeakPct || 0;
  const mae = Math.abs(ep.maxDrawdownPct || 0);

  const cfPeakExitPnlPct = Math.max(0, peak * 0.97);
  const cfActualVsPeakGapPct =
    peak > 0 ? Math.max(0, peak - actual) : 0;

  const tighterGivebackPct = Math.max(
    8,
    (input.peakProtectGivebackOfPeakPct ?? 33) * 0.7
  );
  const tighterExitProxy =
    peak > 0 ? peak * (1 - tighterGivebackPct / 100) : actual;
  const cfTighterPppBetter =
    giveback >= 10 && tighterExitProxy > actual + 1.5;

  const looserGivebackPct = Math.min(
    80,
    (input.peakProtectGivebackOfPeakPct ?? 33) * 1.25
  );
  const looserExitProxy =
    peak > 0 ? peak * (1 - looserGivebackPct / 100) : actual;
  // Scratched too early into a still-running peak → slightly looser PPP might help
  const cfLooserPppBetter =
    giveback < 6 &&
    peak >= 12 &&
    actual > 0 &&
    actual < peak * 0.55 &&
    /fade|stall|scratch|timer|permission/i.test(
      String(ep.exitReason || ep.exitKey || '')
    ) &&
    looserExitProxy > actual + 2;

  const timeToArm = Number(ep.timeToArmSec);
  const cfLaterArmBetter =
    Number.isFinite(timeToArm) &&
    timeToArm >= 0 &&
    timeToArm < 25 &&
    peak >= 15 &&
    giveback >= 10 &&
    actual < peak * 0.6;

  const partialAt = Number(ep.pclPartialAtPct);
  const postPartial = Number(ep.pclPostPartialMfePct);
  const cfSkipPartialBetter =
    ep.pclPartialTaken === true &&
    Number.isFinite(partialAt) &&
    Number.isFinite(postPartial) &&
    postPartial < 2 &&
    actual < partialAt * 0.85 &&
    giveback >= 8;

  const tp = input.takeProfitPct ?? null;
  const cfEarlierTpBetter =
    tp != null &&
    peak >= tp &&
    actual < tp * 0.85 &&
    giveback >= 8;

  const sl = input.stopLossPct != null ? Math.abs(input.stopLossPct) : 30;
  const cfSlWiderWouldSurvive =
    mae >= sl * 0.85 &&
    mae < sl * 1.15 &&
    actual > -sl * 0.5 &&
    ep.exitKey !== 'sl';

  const bits: string[] = [];
  if (cfActualVsPeakGapPct >= 5) {
    bits.push(`peak gap ${cfActualVsPeakGapPct.toFixed(1)}%`);
  }
  if (cfTighterPppBetter) bits.push('tighter PPP may help');
  if (cfLooserPppBetter) bits.push('looser PPP may help');
  if (cfLaterArmBetter) bits.push('later PPP arm may help');
  if (cfSkipPartialBetter) bits.push('skip/delay partial may help');
  if (cfEarlierTpBetter) bits.push('earlier TP may help');
  if (cfSlWiderWouldSurvive) bits.push('wider SL might have survived');

  const cfSummary =
    bits.length > 0
      ? bits.join(' · ')
      : 'CF neutral';

  return {
    cfPeakExitPnlPct: Number(cfPeakExitPnlPct.toFixed(2)),
    cfActualVsPeakGapPct: Number(cfActualVsPeakGapPct.toFixed(2)),
    cfTighterPppBetter,
    cfLooserPppBetter: cfLooserPppBetter || undefined,
    cfLaterArmBetter: cfLaterArmBetter || undefined,
    cfSkipPartialBetter: cfSkipPartialBetter || undefined,
    cfEarlierTpBetter,
    cfSlWiderWouldSurvive,
    cfSummary,
  };
}

export function computeAndStampCounterfactuals(input: {
  episode: ProfileLearningEpisode;
  takeProfitPct?: number | null;
  stopLossPct?: number | null;
  peakProtectGivebackOfPeakPct?: number | null;
}): CounterfactualStamp | null {
  const cfg = getLearningAcceleratorsConfig();
  if (!cfg.enabled || !cfg.counterfactualEnabled) return null;

  const stamp = computeCounterfactuals(input);
  try {
    const { patchProfileLearningEpisode } =
      require('./profileLearningEpisodes') as typeof import('./profileLearningEpisodes');
    patchProfileLearningEpisode(input.episode.profileId, input.episode.id, stamp);
  } catch {
    /* optional persist */
  }

  Object.assign(input.episode, stamp);
  pushCfDecision(
    input.episode.profileId,
    `${input.episode.symbol || input.episode.mint.slice(0, 8)} · ${stamp.cfSummary}`
  );
  return stamp;
}

export interface CounterfactualHints {
  preferTightenGiveback: boolean;
  preferLoosenGiveback: boolean;
  preferLaterArm: boolean;
  preferSkipPartial: boolean;
  preferTighterTrail: boolean;
  preferEarlierTp: boolean;
  weightBoost: number;
  summary: string;
}

const cfHintCache = new Map<string, CounterfactualHints>();

export function buildCounterfactualHints(
  episodes: ProfileLearningEpisode[]
): CounterfactualHints {
  const withCf = episodes.filter((e) => e.cfSummary != null);
  if (withCf.length < 3) {
    return {
      preferTightenGiveback: false,
      preferLoosenGiveback: false,
      preferLaterArm: false,
      preferSkipPartial: false,
      preferTighterTrail: false,
      preferEarlierTp: false,
      weightBoost: 1,
      summary: '',
    };
  }
  const n = withCf.length;
  const tighterRate =
    withCf.filter((e) => e.cfTighterPppBetter === true).length / n;
  const looserRate =
    withCf.filter((e) => e.cfLooserPppBetter === true).length / n;
  const laterArmRate =
    withCf.filter((e) => e.cfLaterArmBetter === true).length / n;
  const skipPartialRate =
    withCf.filter((e) => e.cfSkipPartialBetter === true).length / n;
  const earlierTpRate =
    withCf.filter((e) => e.cfEarlierTpBetter === true).length / n;
  const avgGap =
    withCf.reduce((s, e) => s + (e.cfActualVsPeakGapPct || 0), 0) / n;

  const cfg = getLearningAcceleratorsConfig();
  const apply = cfg.counterfactualApplyHints;
  const boost =
    apply &&
    (tighterRate >= 0.25 ||
      looserRate >= 0.22 ||
      laterArmRate >= 0.2 ||
      avgGap >= 6)
      ? 1.2
      : 1;

  const bits: string[] = [];
  if (avgGap >= 4) bits.push(`avg peak gap ${avgGap.toFixed(1)}%`);
  if (tighterRate >= 0.2) bits.push(`tighter PPP ${(tighterRate * 100).toFixed(0)}%`);
  if (looserRate >= 0.18) bits.push(`looser PPP ${(looserRate * 100).toFixed(0)}%`);
  if (laterArmRate >= 0.15) bits.push(`later arm ${(laterArmRate * 100).toFixed(0)}%`);
  if (skipPartialRate >= 0.15) bits.push(`skip partial ${(skipPartialRate * 100).toFixed(0)}%`);

  return {
    preferTightenGiveback: apply && tighterRate >= 0.28 && looserRate < tighterRate,
    preferLoosenGiveback: apply && looserRate >= 0.22 && looserRate > tighterRate,
    preferLaterArm: apply && laterArmRate >= 0.2,
    preferSkipPartial: apply && skipPartialRate >= 0.18,
    preferTighterTrail: apply && (tighterRate >= 0.22 || avgGap >= 8),
    preferEarlierTp: apply && earlierTpRate >= 0.2,
    weightBoost: boost,
    summary: bits.length ? `CF ${bits.join(' · ')}` : '',
  };
}

export function refreshCounterfactualHints(
  profileId: string,
  episodes: ProfileLearningEpisode[]
): CounterfactualHints {
  const prev = cfHintCache.get(profileId);
  const hints = buildCounterfactualHints(episodes);
  cfHintCache.set(profileId, hints);
  if (hints.summary && prev) {
    const flips: string[] = [];
    if (prev.preferTightenGiveback !== hints.preferTightenGiveback) {
      flips.push(
        hints.preferTightenGiveback
          ? 'now prefers tighter PPP giveback'
          : 'dropped tighter PPP preference'
      );
    }
    if (prev.preferLoosenGiveback !== hints.preferLoosenGiveback) {
      flips.push(
        hints.preferLoosenGiveback
          ? 'now prefers looser PPP giveback'
          : 'dropped looser PPP preference'
      );
    }
    if (prev.preferLaterArm !== hints.preferLaterArm) {
      flips.push(
        hints.preferLaterArm
          ? 'now prefers later PPP arm'
          : 'dropped later PPP arm preference'
      );
    }
    if (prev.preferSkipPartial !== hints.preferSkipPartial) {
      flips.push(
        hints.preferSkipPartial
          ? 'now prefers skip/delay partial'
          : 'dropped skip-partial preference'
      );
    }
    if (prev.preferTighterTrail !== hints.preferTighterTrail) {
      flips.push(
        hints.preferTighterTrail
          ? 'now prefers tighter trail'
          : 'dropped tighter trail preference'
      );
    }
    if (prev.preferEarlierTp !== hints.preferEarlierTp) {
      flips.push(
        hints.preferEarlierTp
          ? 'now prefers earlier TP'
          : 'dropped earlier TP preference'
      );
    }
    if (
      Math.abs((prev.weightBoost || 1) - (hints.weightBoost || 1)) >= 0.05
    ) {
      flips.push(`weight boost ${(hints.weightBoost || 1).toFixed(2)}`);
    }
    if (flips.length) {
      try {
        const { recordCfPreferenceFlip } =
          require('./agentDecisionLog') as typeof import('./agentDecisionLog');
        recordCfPreferenceFlip({
          profileId,
          summary: flips.join('; '),
          detail: hints.summary,
        });
      } catch {
        /* optional */
      }
    }
  }
  return hints;
}

export function getCounterfactualHints(profileId: string): CounterfactualHints | null {
  return cfHintCache.get(profileId) ?? null;
}

export function getCounterfactualRlBonus(episode: ProfileLearningEpisode): number {
  const cfg = getLearningAcceleratorsConfig();
  if (!cfg.enabled || !cfg.counterfactualApplyHints) return 0;
  let bonus = 0;
  if (episode.cfTighterPppBetter === false && (episode.givebackFromPeakPct || 0) < 8) {
    bonus += 0.02;
  }
  if (episode.cfLooserPppBetter === true) bonus -= 0.01;
  if (episode.cfLaterArmBetter === true) bonus -= 0.01;
  if (episode.taExitBeatHold === true && (episode.cfActualVsPeakGapPct || 0) < 6) {
    bonus += 0.02;
  }
  return bonus;
}

export function formatCounterfactualPlainLanguage(profileId: string): string {
  const h = cfHintCache.get(profileId);
  if (!h?.summary) return '';
  return `${profileId} counterfactual review: ${h.summary}.`;
}
