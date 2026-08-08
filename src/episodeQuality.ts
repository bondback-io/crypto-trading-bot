/**
 * Episode quality weighting for soft learning prioritisation.
 * Integration priority: Safety → hard rules → MARL → soft coaches/accelerators/enhancements → clamped self-learn.
 * Never zeroes safety-relevant losses (floor ~0.35).
 */

import type { ProfileLearningEpisode } from './profileLearningEpisodes';

const WEIGHT_LO = 0.35;
const WEIGHT_HI = 1.5;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Composite quality weight for an episode (~0.35–1.5). */
export function computeEpisodeQualityWeight(episode: ProfileLearningEpisode): number {
  let w = 1;

  const holdSec = Math.max(0, Number(episode.holdSec) || 0);
  const pnlPct = Number(episode.pnlPct) || 0;
  const giveback = Math.max(0, Number(episode.givebackFromPeakPct) || 0);
  const maxRunup = Math.max(0, Number(episode.maxRunupPct) || 0);

  // Rich timing / quality stamps
  if (episode.timingReward != null && Number.isFinite(episode.timingReward)) w += 0.12;
  if (episode.entryQualityScore != null && Number.isFinite(episode.entryQualityScore)) w += 0.08;
  if (episode.exitQualityScore != null && Number.isFinite(episode.exitQualityScore)) w += 0.08;
  if (episode.taConfluenceAtEntry != null && episode.taModeAtOpen && episode.taModeAtOpen !== 'off') {
    w += 0.06;
  }
  if (episode.taToolsPassedAtEntry?.length) w += 0.04;
  if (episode.peakProtectArmed === true && maxRunup >= 8) w += 0.05;

  // Clear peak / giveback path (informative for learning)
  if (maxRunup >= 12 && giveback >= 4 && giveback <= 35) w += 0.1;
  if (maxRunup >= 20 && pnlPct > 0 && giveback <= 15) w += 0.08;

  // Up-weight armed reclaim / Mode B harvest film
  const style = String(episode.entryStyle || '');
  const armed =
    episode.armedWatch === true ||
    episode.entryPath === 'armed_trigger' ||
    episode.scalperWatchTriggered === true ||
    /scalp_reclaim_burst|support_dip_reclaim/i.test(style);
  if (armed) w += 0.18;
  else if (/scalp_reclaim|support_dip_reclaim|reclaim/i.test(style)) w += 0.1;

  // Down-weight Scalper scratch spam (low MFE non-armed)
  const pid = String(episode.profileId || '');
  const scalperFamily =
    pid === 'scalper' ||
    pid === 'momentum_burst' ||
    pid === 'reversal_scalper';
  if (
    scalperFamily &&
    !armed &&
    maxRunup < 6 &&
    holdSec < 90 &&
    pnlPct > 0 &&
    pnlPct < 4
  ) {
    w -= 0.04; // −3% to −5% band
  }

  // Non-trivial hold
  if (holdSec >= 45 && holdSec <= 7200) w += 0.06;
  else if (holdSec < 8) w -= 0.12;

  // Lower: aborted / noise / partial-ish exits
  const exitKey = String(episode.exitKey || '');
  if (/abort|manual|force|error/i.test(String(episode.exitReason || ''))) w -= 0.15;
  if (exitKey === 'partial' || exitKey === 'dead_market') w -= 0.08;
  if (!episode.taModeAtOpen || episode.taModeAtOpen === 'off') w -= 0.06;

  // Missing TA on profiles that usually stamp it
  if (
    episode.taConfluenceAtEntry == null &&
    episode.taModeAtOpen !== 'off' &&
    episode.taModeAtOpen != null
  ) {
    w -= 0.05;
  }

  // Extreme outliers (likely one-off noise)
  if (Math.abs(pnlPct) >= 80) w -= 0.1;
  if (giveback >= 50 && pnlPct < 0) w -= 0.06;

  // Safety floor for meaningful losses — never drop to zero
  if (pnlPct <= -5 || giveback >= 20) {
    w = Math.max(WEIGHT_LO, w);
  }

  return clamp(Number(w.toFixed(3)), WEIGHT_LO, WEIGHT_HI);
}

export interface WeightedEpisode {
  episode: ProfileLearningEpisode;
  weight: number;
}

/** Attach quality weights to episode list. */
export function weightEpisodeList(episodes: ProfileLearningEpisode[]): WeightedEpisode[] {
  return episodes.map((episode) => ({
    episode,
    weight: computeEpisodeQualityWeight(episode),
  }));
}

/** Mean quality weight across episodes (0 if empty). */
export function meanEpisodeQuality(episodes: ProfileLearningEpisode[]): number {
  if (!episodes.length) return 0;
  const sum = episodes.reduce((s, e) => s + computeEpisodeQualityWeight(e), 0);
  return Number((sum / episodes.length).toFixed(3));
}

/**
 * Weighted sample for TA nudge / correlation — higher-quality episodes count more.
 * Returns episodes sorted by weight×|timingReward| for prioritised sampling.
 */
export function prioritizeEpisodesByQuality(
  episodes: ProfileLearningEpisode[],
  limit = 40
): ProfileLearningEpisode[] {
  const weighted = weightEpisodeList(episodes);
  return weighted
    .sort((a, b) => {
      const sa =
        a.weight * Math.abs(a.episode.timingReward ?? a.episode.pnlPct ?? 0);
      const sb =
        b.weight * Math.abs(b.episode.timingReward ?? b.episode.pnlPct ?? 0);
      return sb - sa || b.episode.closedAt - a.episode.closedAt;
    })
    .slice(0, limit)
    .map((w) => w.episode);
}

/** Replay buffer prioritisation multiplier (combines with existing surprise weight). */
export function replayQualityMultiplier(episode: ProfileLearningEpisode): number {
  return computeEpisodeQualityWeight(episode);
}
