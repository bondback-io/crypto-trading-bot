/**
 * Episode quality weighting from 1.2.421. Optional stamps on older rings are ignored.
 */

import type { ProfileLearningEpisode } from '../../profileLearningEpisodes';

const WEIGHT_LO = 0.35;
const WEIGHT_HI = 1.5;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

type Film = ProfileLearningEpisode & {
  timingReward?: number;
  entryQualityScore?: number;
  exitQualityScore?: number;
  taConfluenceAtEntry?: number;
  taModeAtOpen?: string;
  taToolsPassedAtEntry?: string[];
  peakProtectArmed?: boolean;
  entryStyle?: string;
  armedWatch?: boolean;
  entryPath?: string;
  scalperWatchTriggered?: boolean;
  mfeCaptureRatio?: number;
  pclPartialTaken?: boolean;
};

export function computeEpisodeQualityWeight(episode: ProfileLearningEpisode): number {
  const e = episode as Film;
  let w = 1;

  const holdSec = Math.max(0, Number(e.holdSec) || 0);
  const pnlPct = Number(e.pnlPct) || 0;
  const giveback = Math.max(0, Number(e.givebackFromPeakPct) || 0);
  const maxRunup = Math.max(0, Number(e.maxRunupPct) || 0);

  if (e.timingReward != null && Number.isFinite(e.timingReward)) w += 0.12;
  if (e.entryQualityScore != null && Number.isFinite(e.entryQualityScore)) w += 0.08;
  if (e.exitQualityScore != null && Number.isFinite(e.exitQualityScore)) w += 0.08;
  if (e.peakProtectArmed === true && maxRunup >= 8) w += 0.05;

  if (maxRunup >= 12 && giveback >= 4 && giveback <= 35) w += 0.1;
  if (maxRunup >= 20 && pnlPct > 0 && giveback <= 15) w += 0.08;

  const style = String(e.entryStyle || '');
  const armed =
    e.armedWatch === true ||
    e.entryPath === 'armed_trigger' ||
    e.entryPath === 'hybrid_fast_arm' ||
    /scalp_reclaim|support_dip_reclaim/i.test(style);
  if (armed) w += 0.18;

  const mfeCap =
    e.mfeCaptureRatio != null && Number.isFinite(Number(e.mfeCaptureRatio))
      ? Number(e.mfeCaptureRatio)
      : maxRunup > 0.5
        ? clamp(pnlPct / maxRunup, 0, 1.5)
        : null;
  if (mfeCap != null && mfeCap >= 0.55 && pnlPct > 0) w += 0.1;
  else if (mfeCap != null && mfeCap < 0.25 && maxRunup >= 10) w -= 0.06;
  if (pnlPct > 0 && maxRunup >= 8) w += 0.05;
  if (pnlPct < -4 && maxRunup < 3) w -= 0.05;

  const pid = String(e.profileId || '');
  const scalperFamily =
    pid === 'scalper' || pid === 'momentum_burst' || pid === 'reversal_scalper';
  if (scalperFamily && !armed && maxRunup < 6 && holdSec < 90 && pnlPct > 0 && pnlPct < 4) {
    w -= 0.08;
  }

  if (holdSec >= 45 && holdSec <= 7200) w += 0.06;
  else if (holdSec < 8) w -= 0.12;

  if (/abort|manual|force|error/i.test(String(e.exitReason || ''))) w -= 0.15;
  if (e.exitKey === 'partial' || e.exitKey === 'dead_market') w -= 0.08;

  if (Math.abs(pnlPct) >= 80) w -= 0.1;
  if (giveback >= 50 && pnlPct < 0) w -= 0.06;
  if (pnlPct <= -5 || giveback >= 20) w = Math.max(WEIGHT_LO, w);

  return clamp(Number(w.toFixed(3)), WEIGHT_LO, WEIGHT_HI);
}

export function meanEpisodeQuality(episodes: ProfileLearningEpisode[]): number {
  if (!episodes.length) return 0;
  const sum = episodes.reduce((s, e) => s + computeEpisodeQualityWeight(e), 0);
  return Number((sum / episodes.length).toFixed(3));
}
