/**
 * Trade Craft Progress — read-only harvest / hold / exit / TA / decision
 * skill scores from durable learning episodes. Diagnostics only.
 */

import {
  getProfileLearningEpisodes,
  type ProfileLearningEpisode,
} from './profileLearningEpisodes';
import { TRADE_PROFILE_CATALOG } from './tradeProfiles';
import { isProfitCaptureLayerEnabled } from './profitCaptureLayer';

export type CraftTrendLabel = 'improving' | 'stable' | 'declining';

export type CraftTraitId =
  | 'harvest'
  | 'hold'
  | 'profitTaking'
  | 'profitImprove'
  | 'exits'
  | 'ta'
  | 'decisions';

export interface TraitScore {
  id: CraftTraitId;
  label: string;
  score: number | null;
  earlyScore: number | null;
  lateScore: number | null;
  delta: number | null;
  n: number;
  plainLanguage: string;
  kpis: Record<string, number | string | null>;
}

export interface TradeFilmRow {
  id: string;
  profileId: string;
  symbol: string;
  closedAt: number;
  holdSec: number;
  pnlPct: number;
  exitReason: string;
  exitKey?: string;
  maxRunupPct: number;
  maxDrawdownPct: number;
  givebackFromPeakPct: number;
  mfeCaptureRatio: number | null;
  entryQualityScore?: number;
  exitQualityScore?: number;
  timingReward?: number;
  pclPartialTaken?: boolean;
  peakProtectArmed?: boolean;
  peakProtectBeatFullTp?: boolean;
  peakProtectNearMiss?: boolean;
  timeToArmSec?: number;
  peakAtArmPct?: number;
  givebackOfPeakAtExitPct?: number;
  pclPartialAtPct?: number;
  pclPostPartialMfePct?: number;
  pclFamily?: string;
  exitedDuringPermission?: boolean;
  pclScratchBlockedCount?: number;
  pclPppArmDeferred?: boolean;
  cfSummary?: string;
  cfTighterPppBetter?: boolean;
  cfLooserPppBetter?: boolean;
  cfLaterArmBetter?: boolean;
  cfSkipPartialBetter?: boolean;
  taModeAtOpen?: string;
  taConfluenceAtEntry?: number;
  nearSupportAtEntry?: boolean;
  nearResistanceAtEntry?: boolean;
  volumeStateAtEntry?: string;
  volumeStateAtExit?: string;
  hmcSetup?: string;
  hmcConfidence?: number;
  convictionScore?: number;
  tradeProfileScore?: number;
  entrySource?: string;
  profileTaPlainLanguage?: string;
}

export interface ExitMixBucket {
  key: string;
  n: number;
  pct: number;
}

export interface CraftChartSeries {
  window: number;
  tradeIndex: number[];
  rollingCraftScore: number[];
  rollingCapturePct: number[];
  rollingGivebackPct: number[];
  rollingScratchPct: number[];
  rollingTimingReward: number[];
  rollingHoldSec: number[];
  rollingAvgPnlPct: number[];
  cumulativePnlPct: number[];
}

export interface CraftBotRow {
  profileId: string;
  name: string;
  n: number;
  craftScore: number | null;
  harvestScore: number | null;
  holdScore: number | null;
  profitTakingScore: number | null;
  exitsScore: number | null;
  taScore: number | null;
  decisionsScore: number | null;
  trend: CraftTrendLabel;
  capturePct: number | null;
  scratchPct: number | null;
}

export interface TradeCraftPerformance {
  profileId: string;
  profileName: string;
  window: number;
  n: number;
  pclEnabled: boolean;
  craftScore: number | null;
  trend: CraftTrendLabel;
  earlyCraft: number | null;
  lateCraft: number | null;
  craftDelta: number | null;
  plainLanguage: string;
  traits: TraitScore[];
  exitMix: ExitMixBucket[];
  chart: CraftChartSeries;
  bots: CraftBotRow[];
  film: TradeFilmRow[];
}

const TRAIT_LABELS: Record<CraftTraitId, string> = {
  harvest: 'Harvest (PCL)',
  hold: 'Holding time',
  profitTaking: 'Profit-taking',
  profitImprove: 'Profit improvement',
  exits: 'Exit efficiency',
  ta: 'TA craft',
  decisions: 'Decision stack',
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const a = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2;
}

function isWin(ep: ProfileLearningEpisode): boolean {
  return Number(ep.pnlPct) > 0 || Number(ep.pnlSol) > 0;
}

function captureRatio(ep: ProfileLearningEpisode): number | null {
  if (ep.mfeCaptureRatio != null && Number.isFinite(Number(ep.mfeCaptureRatio))) {
    return clamp(Number(ep.mfeCaptureRatio), 0, 1.5);
  }
  const mfe = Math.max(0, Number(ep.maxRunupPct) || 0);
  const exitU = Number.isFinite(ep.exitUnrealizedPct)
    ? Number(ep.exitUnrealizedPct)
    : Number(ep.pnlPct) || 0;
  if (!(mfe > 0.5)) return null;
  return clamp(exitU / mfe, 0, 1.5);
}

function isScratchy(ep: ProfileLearningEpisode): boolean {
  const pnl = Number(ep.pnlPct) || 0;
  const mfe = Math.max(0, Number(ep.maxRunupPct) || 0);
  const hold = Number(ep.holdSec) || 0;
  const key = String(ep.exitKey || ep.exitReason || '').toLowerCase();
  const softExit =
    /fade|stall|dead|scratch|timer|soft/.test(key) ||
    /momentum fade|dead.?market|stall/.test(String(ep.exitReason || '').toLowerCase());
  if (pnl > 0 && pnl < 3 && (mfe >= 8 || (softExit && hold < 90))) return true;
  if (pnl > 0 && pnl < 3 && hold < 45 && mfe >= 5) return true;
  return false;
}

function isHardSl(ep: ProfileLearningEpisode): boolean {
  const key = String(ep.exitKey || ep.exitReason || '').toLowerCase();
  return /hard.?sl|stop.?loss|scalp_sl/.test(key);
}

function isSoftScaredExit(ep: ProfileLearningEpisode): boolean {
  const key = String(ep.exitKey || ep.exitReason || '').toLowerCase();
  return /fade|stall|dead|scratch|timer/.test(key) && !isHardSl(ep);
}

function profileName(id: string): string {
  if (id === 'all') return 'Combined';
  const hit = TRADE_PROFILE_CATALOG.find((p) => p.id === id);
  return hit?.name || id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function catalogIds(): string[] {
  return TRADE_PROFILE_CATALOG.map((p) => p.id).filter((id) => id !== 'default');
}

function loadEpisodes(profileId: string, limit: number): ProfileLearningEpisode[] {
  if (profileId === 'all') {
    const merged: ProfileLearningEpisode[] = [];
    for (const id of catalogIds()) {
      merged.push(...getProfileLearningEpisodes(id, 400));
    }
    merged.sort((a, b) => Number(a.closedAt || a.at) - Number(b.closedAt || b.at));
    return merged.slice(-Math.max(limit, 100));
  }
  return getProfileLearningEpisodes(profileId, Math.max(limit, 100));
}

function scoreHarvest(eps: ProfileLearningEpisode[]): {
  score: number | null;
  kpis: Record<string, number | string | null>;
} {
  if (!eps.length) return { score: null, kpis: {} };
  const caps = eps.map(captureRatio).filter((x): x is number => x != null);
  const givebacks = eps.map((e) => Math.max(0, Number(e.givebackFromPeakPct) || 0));
  const scratchN = eps.filter(isScratchy).length;
  const partialN = eps.filter((e) => e.pclPartialTaken === true).length;
  const timing = eps
    .map((e) => Number(e.timingReward))
    .filter((n) => Number.isFinite(n));
  const winHolds = eps.filter(isWin).map((e) => Number(e.holdSec) || 0);
  const avgCap = avg(caps);
  const avgGb = avg(givebacks) ?? 0;
  const scratchPct = scratchN / eps.length;
  const partialPct = partialN / eps.length;
  const avgTiming = avg(timing);
  let score = 50;
  if (avgCap != null) score += (avgCap - 0.55) * 50;
  score -= Math.min(25, avgGb * 0.45);
  score -= scratchPct * 30;
  score += partialPct * 12;
  if (avgTiming != null) score += clamp(avgTiming, -8, 12);
  return {
    score: clamp(Math.round(score * 10) / 10, 0, 100),
    kpis: {
      capturePct: avgCap != null ? Math.round(avgCap * 1000) / 10 : null,
      givebackPct: Math.round(avgGb * 10) / 10,
      scratchPct: Math.round(scratchPct * 1000) / 10,
      partialPct: Math.round(partialPct * 1000) / 10,
      avgTimingReward:
        avgTiming != null ? Math.round(avgTiming * 100) / 100 : null,
      avgWinHoldSec: avg(winHolds) != null ? Math.round(avg(winHolds)!) : null,
    },
  };
}

function scoreHold(eps: ProfileLearningEpisode[]): {
  score: number | null;
  kpis: Record<string, number | string | null>;
} {
  if (!eps.length) return { score: null, kpis: {} };
  const holds = eps.map((e) => Number(e.holdSec) || 0);
  const winH = eps.filter(isWin).map((e) => Number(e.holdSec) || 0);
  const loseH = eps.filter((e) => !isWin(e)).map((e) => Number(e.holdSec) || 0);
  const premature = eps.filter((e) => {
    const mfe = Math.max(0, Number(e.maxRunupPct) || 0);
    const cap = captureRatio(e);
    const hold = Number(e.holdSec) || 0;
    return mfe >= 10 && hold < 60 && (cap == null || cap < 0.4);
  }).length;
  const premPct = premature / eps.length;
  const avgHold = avg(holds) ?? 0;
  const medHold = median(holds) ?? 0;
  const winAvg = avg(winH) ?? 0;
  const loseAvg = avg(loseH) ?? 0;
  let score = 55;
  // Prefer winners held longer than losers
  if (winH.length && loseH.length) {
    score += clamp((winAvg - loseAvg) / 30, -15, 20);
  }
  score -= premPct * 35;
  if (avgHold > 180) score += 5;
  if (avgHold < 40) score -= 8;
  return {
    score: clamp(Math.round(score * 10) / 10, 0, 100),
    kpis: {
      avgHoldSec: Math.round(avgHold),
      medianHoldSec: Math.round(medHold),
      avgWinHoldSec: winH.length ? Math.round(winAvg) : null,
      avgLossHoldSec: loseH.length ? Math.round(loseAvg) : null,
      prematurePct: Math.round(premPct * 1000) / 10,
    },
  };
}

function scoreProfitTaking(eps: ProfileLearningEpisode[]): {
  score: number | null;
  kpis: Record<string, number | string | null>;
} {
  if (!eps.length) return { score: null, kpis: {} };
  const wins = eps.filter(isWin);
  const avgWin = avg(wins.map((e) => Number(e.pnlPct) || 0));
  const exitQ = avg(
    eps
      .map((e) => Number(e.exitQualityScore))
      .filter((n) => Number.isFinite(n))
  );
  const partialPct =
    eps.filter((e) => e.pclPartialTaken === true).length / eps.length;
  const pppBeat =
    eps.filter((e) => e.peakProtectBeatFullTp === true).length /
    Math.max(1, eps.filter((e) => e.peakProtectArmed === true).length);
  const leftOnTable =
    eps.filter((e) => {
      const mfe = Math.max(0, Number(e.maxRunupPct) || 0);
      const cap = captureRatio(e);
      return mfe >= 12 && (cap == null || cap < 0.35);
    }).length / eps.length;
  let score = 50;
  if (avgWin != null) score += clamp(avgWin * 1.2, -20, 25);
  if (exitQ != null) score += (exitQ - 50) * 0.35;
  score += partialPct * 15;
  score += clamp(pppBeat * 10, 0, 10);
  score -= leftOnTable * 25;
  return {
    score: clamp(Math.round(score * 10) / 10, 0, 100),
    kpis: {
      avgWinPct: avgWin != null ? Math.round(avgWin * 10) / 10 : null,
      avgExitQuality: exitQ != null ? Math.round(exitQ * 10) / 10 : null,
      partialPct: Math.round(partialPct * 1000) / 10,
      leftOnTablePct: Math.round(leftOnTable * 1000) / 10,
      pppBeatRate:
        eps.some((e) => e.peakProtectArmed)
          ? Math.round(pppBeat * 1000) / 10
          : null,
    },
  };
}

function scoreProfitImprove(eps: ProfileLearningEpisode[]): {
  score: number | null;
  kpis: Record<string, number | string | null>;
} {
  if (!eps.length) return { score: null, kpis: {} };
  const pnls = eps.map((e) => Number(e.pnlPct) || 0);
  const timings = eps
    .map((e) => Number(e.timingReward))
    .filter((n) => Number.isFinite(n));
  const wr = eps.filter(isWin).length / eps.length;
  const avgPnl = avg(pnls) ?? 0;
  const avgT = avg(timings);
  let score = 50 + clamp(avgPnl * 2.5, -30, 30) + (wr - 0.45) * 40;
  if (avgT != null) score += clamp(avgT, -10, 15);
  return {
    score: clamp(Math.round(score * 10) / 10, 0, 100),
    kpis: {
      avgPnlPct: Math.round(avgPnl * 100) / 100,
      winRatePct: Math.round(wr * 1000) / 10,
      avgTimingReward: avgT != null ? Math.round(avgT * 100) / 100 : null,
      sumPnlPct: Math.round(pnls.reduce((s, n) => s + n, 0) * 100) / 100,
    },
  };
}

function scoreExits(eps: ProfileLearningEpisode[]): {
  score: number | null;
  kpis: Record<string, number | string | null>;
  exitMix: ExitMixBucket[];
} {
  if (!eps.length) return { score: null, kpis: {}, exitMix: [] };
  const mixMap = new Map<string, number>();
  for (const e of eps) {
    const k = String(e.exitKey || e.exitReason || 'unknown').slice(0, 48);
    mixMap.set(k, (mixMap.get(k) || 0) + 1);
  }
  const exitMix = [...mixMap.entries()]
    .map(([key, n]) => ({ key, n, pct: Math.round((n / eps.length) * 1000) / 10 }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 8);

  const hardSl = eps.filter(isHardSl);
  const softScared = eps.filter(isSoftScaredExit);
  const deepSl = hardSl.filter((e) => Math.abs(Number(e.maxDrawdownPct) || 0) >= 12);
  const quickSl = hardSl.filter((e) => (Number(e.holdSec) || 0) < 40);
  const cfSurvive = eps.filter((e) => e.cfSlWiderWouldSurvive === true).length;
  const softPct = softScared.length / eps.length;
  const hardPct = hardSl.length / eps.length;
  let score = 60;
  score -= softPct * 25;
  score -= (quickSl.length / Math.max(1, eps.length)) * 15;
  score += (deepSl.length / Math.max(1, hardSl.length || 1)) * 5;
  score -= (cfSurvive / Math.max(1, eps.length)) * 10;
  return {
    score: clamp(Math.round(score * 10) / 10, 0, 100),
    kpis: {
      hardSlPct: Math.round(hardPct * 1000) / 10,
      softScaredPct: Math.round(softPct * 1000) / 10,
      quickSlPct: Math.round((quickSl.length / eps.length) * 1000) / 10,
      cfWiderWouldSurvivePct:
        eps.some((e) => e.cfSlWiderWouldSurvive != null)
          ? Math.round((cfSurvive / eps.length) * 1000) / 10
          : null,
    },
    exitMix,
  };
}

function scoreTa(eps: ProfileLearningEpisode[]): {
  score: number | null;
  kpis: Record<string, number | string | null>;
} {
  const withTa = eps.filter(
    (e) =>
      e.taModeAtOpen &&
      e.taModeAtOpen !== 'off' &&
      (e.taConfluenceAtEntry != null ||
        (e.taToolsAtOpen && e.taToolsAtOpen.length))
  );
  if (!withTa.length) {
    return {
      score: null,
      kpis: { sampleWithTa: 0, note: 'No TA-stamped episodes in window' },
    };
  }
  const conf = avg(
    withTa
      .map((e) => Number(e.taConfluenceAtEntry))
      .filter((n) => Number.isFinite(n))
  );
  let toolPass = 0;
  let toolN = 0;
  for (const e of withTa) {
    const tools = e.taToolsAtOpen || [];
    const passed = new Set(e.taToolsPassedAtEntry || []);
    if (tools.length) {
      toolN += tools.length;
      toolPass += tools.filter((t) => passed.has(t)).length;
    }
  }
  const passRate = toolN ? toolPass / toolN : null;
  const nearSup = withTa.filter((e) => e.nearSupportAtEntry === true);
  const nearRes = withTa.filter((e) => e.nearResistanceAtEntry === true);
  const supWin =
    nearSup.length > 0
      ? nearSup.filter(isWin).length / nearSup.length
      : null;
  const heldProfit =
    withTa.filter((e) => e.taConditionsHeldIntoProfit === true).length /
    withTa.length;
  const exitBeat =
    withTa.filter((e) => e.taExitBeatHold === true).length / withTa.length;
  const volRegret =
    withTa.filter((e) => e.volumeDecayedAfterEntry === true && !isWin(e))
      .length / withTa.length;
  let score = 50;
  if (conf != null) score += (conf - 50) * 0.35;
  if (passRate != null) score += (passRate - 0.5) * 30;
  if (supWin != null) score += (supWin - 0.45) * 20;
  score += heldProfit * 12;
  score += exitBeat * 8;
  score -= volRegret * 15;
  return {
    score: clamp(Math.round(score * 10) / 10, 0, 100),
    kpis: {
      sampleWithTa: withTa.length,
      avgConfluence: conf != null ? Math.round(conf * 10) / 10 : null,
      toolPassPct: passRate != null ? Math.round(passRate * 1000) / 10 : null,
      nearSupportWinPct: supWin != null ? Math.round(supWin * 1000) / 10 : null,
      nearResistanceN: nearRes.length,
      taHeldIntoProfitPct: Math.round(heldProfit * 1000) / 10,
      taExitBeatHoldPct: Math.round(exitBeat * 1000) / 10,
      volumeDecayRegretPct: Math.round(volRegret * 1000) / 10,
    },
  };
}

function scoreDecisions(eps: ProfileLearningEpisode[]): {
  score: number | null;
  kpis: Record<string, number | string | null>;
} {
  if (!eps.length) return { score: null, kpis: {} };
  const entryQ = avg(
    eps
      .map((e) => Number(e.entryQualityScore))
      .filter((n) => Number.isFinite(n))
  );
  const conv = avg(
    eps
      .map((e) => Number(e.convictionScore))
      .filter((n) => Number.isFinite(n))
  );
  const lane = avg(
    eps
      .map((e) => Number(e.tradeProfileScore ?? e.laneScore))
      .filter((n) => Number.isFinite(n))
  );
  const hmc = avg(
    eps
      .map((e) => Number(e.hmcConfidence))
      .filter((n) => Number.isFinite(n))
  );
  const highQ = eps.filter((e) => e.qualityTier === 'high');
  const highQWr =
    highQ.length >= 3 ? highQ.filter(isWin).length / highQ.length : null;
  const cfGap = avg(
    eps
      .map((e) => Number(e.cfActualVsPeakGapPct))
      .filter((n) => Number.isFinite(n))
  );
  let score = 55;
  if (entryQ != null) score += (entryQ - 50) * 0.3;
  if (conv != null) score += (conv - 55) * 0.15;
  if (lane != null) score += (lane - 50) * 0.1;
  if (hmc != null) score += (hmc - 0.5) * 15;
  if (highQWr != null) score += (highQWr - 0.45) * 20;
  if (cfGap != null) score -= clamp(cfGap * 0.4, 0, 15);
  return {
    score: clamp(Math.round(score * 10) / 10, 0, 100),
    kpis: {
      avgEntryQuality: entryQ != null ? Math.round(entryQ * 10) / 10 : null,
      avgConviction: conv != null ? Math.round(conv * 10) / 10 : null,
      avgLaneScore: lane != null ? Math.round(lane * 10) / 10 : null,
      avgHmcConfidence: hmc != null ? Math.round(hmc * 1000) / 1000 : null,
      highQualityWinPct:
        highQWr != null ? Math.round(highQWr * 1000) / 10 : null,
      avgCfPeakGapPct: cfGap != null ? Math.round(cfGap * 10) / 10 : null,
    },
  };
}

function blendCraft(traits: TraitScore[]): number | null {
  const weights: Record<CraftTraitId, number> = {
    harvest: 1.2,
    hold: 0.9,
    profitTaking: 1.1,
    profitImprove: 1.0,
    exits: 1.0,
    ta: 0.9,
    decisions: 0.8,
  };
  let sum = 0;
  let w = 0;
  for (const t of traits) {
    if (t.score == null) continue;
    const wt = weights[t.id] || 1;
    sum += t.score * wt;
    w += wt;
  }
  if (!(w > 0)) return null;
  return Math.round((sum / w) * 10) / 10;
}

function halfSplit(eps: ProfileLearningEpisode[]): {
  early: ProfileLearningEpisode[];
  late: ProfileLearningEpisode[];
} {
  if (eps.length < 4) return { early: eps, late: eps };
  const mid = Math.floor(eps.length / 2);
  return { early: eps.slice(0, mid), late: eps.slice(mid) };
}

function trendFromDelta(delta: number | null, n: number): CraftTrendLabel {
  if (delta == null || n < 6) return 'stable';
  if (delta >= 4) return 'improving';
  if (delta <= -4) return 'declining';
  return 'stable';
}

function buildTraits(eps: ProfileLearningEpisode[]): {
  traits: TraitScore[];
  exitMix: ExitMixBucket[];
} {
  const { early, late } = halfSplit(eps);
  const mk = (
    id: CraftTraitId,
    full: { score: number | null; kpis: Record<string, number | string | null> },
    earlyS: number | null,
    lateS: number | null,
    blurb: (t: TraitScore) => string
  ): TraitScore => {
    const delta =
      earlyS != null && lateS != null
        ? Math.round((lateS - earlyS) * 10) / 10
        : null;
    const row: TraitScore = {
      id,
      label: TRAIT_LABELS[id],
      score: full.score,
      earlyScore: earlyS,
      lateScore: lateS,
      delta,
      n: eps.length,
      plainLanguage: '',
      kpis: full.kpis,
    };
    row.plainLanguage = blurb(row);
    return row;
  };

  const h = scoreHarvest(eps);
  const hE = scoreHarvest(early).score;
  const hL = scoreHarvest(late).score;
  const hold = scoreHold(eps);
  const holdE = scoreHold(early).score;
  const holdL = scoreHold(late).score;
  const pt = scoreProfitTaking(eps);
  const ptE = scoreProfitTaking(early).score;
  const ptL = scoreProfitTaking(late).score;
  const pi = scoreProfitImprove(eps);
  const piE = scoreProfitImprove(early).score;
  const piL = scoreProfitImprove(late).score;
  const ex = scoreExits(eps);
  const exE = scoreExits(early).score;
  const exL = scoreExits(late).score;
  const ta = scoreTa(eps);
  const taE = scoreTa(early).score;
  const taL = scoreTa(late).score;
  const dec = scoreDecisions(eps);
  const decE = scoreDecisions(early).score;
  const decL = scoreDecisions(late).score;

  const traits: TraitScore[] = [
    mk('harvest', h, hE, hL, (t) => {
      const cap = t.kpis.capturePct;
      const scr = t.kpis.scratchPct;
      const d =
        t.delta != null
          ? t.delta >= 0
            ? `up ${t.delta}`
            : `down ${Math.abs(t.delta)}`
          : 'flat';
      return `Capture ${cap ?? '—'}% · scratchy ${scr ?? '—'}% · early→late ${d}.`;
    }),
    mk('hold', hold, holdE, holdL, (t) => {
      return `Avg hold ${t.kpis.avgHoldSec ?? '—'}s (wins ${t.kpis.avgWinHoldSec ?? '—'}s) · premature ${t.kpis.prematurePct ?? '—'}%.`;
    }),
    mk('profitTaking', pt, ptE, ptL, (t) => {
      return `Exit quality ${t.kpis.avgExitQuality ?? '—'} · partials ${t.kpis.partialPct ?? '—'}% · left on table ${t.kpis.leftOnTablePct ?? '—'}%.`;
    }),
    mk('profitImprove', pi, piE, piL, (t) => {
      return `Avg PnL ${t.kpis.avgPnlPct ?? '—'}% · WR ${t.kpis.winRatePct ?? '—'}% · timing ${t.kpis.avgTimingReward ?? '—'}.`;
    }),
    mk('exits', ex, exE, exL, (t) => {
      return `Hard SL ${t.kpis.hardSlPct ?? '—'}% · soft/scared ${t.kpis.softScaredPct ?? '—'}% · quick SL ${t.kpis.quickSlPct ?? '—'}%.`;
    }),
    mk('ta', ta, taE, taL, (t) => {
      if (!t.kpis.sampleWithTa) return 'Not enough TA-stamped film in this window.';
      return `Confluence ${t.kpis.avgConfluence ?? '—'} · tools pass ${t.kpis.toolPassPct ?? '—'}% · held into profit ${t.kpis.taHeldIntoProfitPct ?? '—'}%.`;
    }),
    mk('decisions', dec, decE, decL, (t) => {
      return `Entry Q ${t.kpis.avgEntryQuality ?? '—'} · conviction ${t.kpis.avgConviction ?? '—'} · HMC ${t.kpis.avgHmcConfidence ?? '—'}.`;
    }),
  ];
  return { traits, exitMix: ex.exitMix };
}

function buildChart(
  epsAsc: ProfileLearningEpisode[],
  window: number
): CraftChartSeries {
  const slice = epsAsc.slice(-window);
  const tradeIndex: number[] = [];
  const rollingCraftScore: number[] = [];
  const rollingCapturePct: number[] = [];
  const rollingGivebackPct: number[] = [];
  const rollingScratchPct: number[] = [];
  const rollingTimingReward: number[] = [];
  const rollingHoldSec: number[] = [];
  const rollingAvgPnlPct: number[] = [];
  const cumulativePnlPct: number[] = [];
  let cum = 0;
  const roll = Math.min(12, Math.max(5, Math.floor(window / 3)));
  for (let i = 0; i < slice.length; i++) {
    const start = Math.max(0, i - roll + 1);
    const sub = slice.slice(start, i + 1);
    const { traits } = buildTraits(sub);
    const craft = blendCraft(traits);
    const h = scoreHarvest(sub);
    cum += Number(slice[i]!.pnlPct || 0);
    tradeIndex.push(i + 1);
    rollingCraftScore.push(craft != null ? craft : 0);
    rollingCapturePct.push(
      h.kpis.capturePct != null ? Number(h.kpis.capturePct) : 0
    );
    rollingGivebackPct.push(
      h.kpis.givebackPct != null ? Number(h.kpis.givebackPct) : 0
    );
    rollingScratchPct.push(
      h.kpis.scratchPct != null ? Number(h.kpis.scratchPct) : 0
    );
    rollingTimingReward.push(
      h.kpis.avgTimingReward != null ? Number(h.kpis.avgTimingReward) : 0
    );
    rollingHoldSec.push(
      scoreHold(sub).kpis.avgHoldSec != null
        ? Number(scoreHold(sub).kpis.avgHoldSec)
        : 0
    );
    rollingAvgPnlPct.push(
      Math.round(((avg(sub.map((e) => Number(e.pnlPct) || 0)) || 0) * 100)) / 100
    );
    cumulativePnlPct.push(Math.round(cum * 100) / 100);
  }
  return {
    window,
    tradeIndex,
    rollingCraftScore,
    rollingCapturePct,
    rollingGivebackPct,
    rollingScratchPct,
    rollingTimingReward,
    rollingHoldSec,
    rollingAvgPnlPct,
    cumulativePnlPct,
  };
}

function toFilm(ep: ProfileLearningEpisode): TradeFilmRow {
  return {
    id: ep.id,
    profileId: ep.profileId,
    symbol: ep.symbol || ep.mint.slice(0, 8),
    closedAt: ep.closedAt || ep.at,
    holdSec: Math.round(Number(ep.holdSec) || 0),
    pnlPct: Math.round((Number(ep.pnlPct) || 0) * 100) / 100,
    exitReason: String(ep.exitReason || ''),
    exitKey: ep.exitKey,
    maxRunupPct: Math.round((Number(ep.maxRunupPct) || 0) * 10) / 10,
    maxDrawdownPct: Math.round((Number(ep.maxDrawdownPct) || 0) * 10) / 10,
    givebackFromPeakPct:
      Math.round((Number(ep.givebackFromPeakPct) || 0) * 10) / 10,
    mfeCaptureRatio: (() => {
      const c = captureRatio(ep);
      return c != null ? Math.round(c * 1000) / 1000 : null;
    })(),
    entryQualityScore: ep.entryQualityScore,
    exitQualityScore: ep.exitQualityScore,
    timingReward: ep.timingReward,
    pclPartialTaken: ep.pclPartialTaken,
    peakProtectArmed: ep.peakProtectArmed,
    peakProtectBeatFullTp: ep.peakProtectBeatFullTp,
    peakProtectNearMiss: ep.peakProtectNearMiss,
    timeToArmSec: ep.timeToArmSec,
    peakAtArmPct: ep.peakAtArmPct,
    givebackOfPeakAtExitPct: ep.givebackOfPeakAtExitPct,
    pclPartialAtPct: ep.pclPartialAtPct,
    pclPostPartialMfePct: ep.pclPostPartialMfePct,
    pclFamily: ep.pclFamily,
    exitedDuringPermission: ep.exitedDuringPermission,
    pclScratchBlockedCount: ep.pclScratchBlockedCount,
    pclPppArmDeferred: ep.pclPppArmDeferred,
    cfSummary: ep.cfSummary,
    cfTighterPppBetter: ep.cfTighterPppBetter,
    cfLooserPppBetter: ep.cfLooserPppBetter,
    cfLaterArmBetter: ep.cfLaterArmBetter,
    cfSkipPartialBetter: ep.cfSkipPartialBetter,
    taModeAtOpen: ep.taModeAtOpen,
    taConfluenceAtEntry: ep.taConfluenceAtEntry,
    nearSupportAtEntry: ep.nearSupportAtEntry,
    nearResistanceAtEntry: ep.nearResistanceAtEntry,
    volumeStateAtEntry: ep.volumeStateAtEntry,
    volumeStateAtExit: ep.volumeStateAtExit,
    hmcSetup: ep.hmcSetup,
    hmcConfidence: ep.hmcConfidence,
    convictionScore: ep.convictionScore,
    tradeProfileScore: ep.tradeProfileScore,
    entrySource: ep.entrySource,
    profileTaPlainLanguage: ep.profileTaPlainLanguage,
  };
}

function botRow(profileId: string, window: number): CraftBotRow {
  const eps = loadEpisodes(profileId, window).slice(-window);
  const { traits } = buildTraits(eps);
  const craft = blendCraft(traits);
  const harvest = traits.find((t) => t.id === 'harvest');
  const { early, late } = halfSplit(eps);
  const earlyC = blendCraft(buildTraits(early).traits);
  const lateC = blendCraft(buildTraits(late).traits);
  const delta =
    earlyC != null && lateC != null
      ? Math.round((lateC - earlyC) * 10) / 10
      : null;
  return {
    profileId,
    name: profileName(profileId),
    n: eps.length,
    craftScore: craft,
    harvestScore: harvest?.score ?? null,
    holdScore: traits.find((t) => t.id === 'hold')?.score ?? null,
    profitTakingScore:
      traits.find((t) => t.id === 'profitTaking')?.score ?? null,
    exitsScore: traits.find((t) => t.id === 'exits')?.score ?? null,
    taScore: traits.find((t) => t.id === 'ta')?.score ?? null,
    decisionsScore: traits.find((t) => t.id === 'decisions')?.score ?? null,
    trend: trendFromDelta(delta, eps.length),
    capturePct:
      harvest?.kpis.capturePct != null ? Number(harvest.kpis.capturePct) : null,
    scratchPct:
      harvest?.kpis.scratchPct != null ? Number(harvest.kpis.scratchPct) : null,
  };
}

function plainOverall(
  name: string,
  craft: number | null,
  trend: CraftTrendLabel,
  traits: TraitScore[],
  n: number
): string {
  if (!n || craft == null) {
    return `${name}: not enough closed learning episodes yet for Trade Craft scores.`;
  }
  const harvest = traits.find((t) => t.id === 'harvest');
  const hold = traits.find((t) => t.id === 'hold');
  const verb =
    trend === 'improving'
      ? 'improving'
      : trend === 'declining'
        ? 'slipping'
        : 'holding steady';
  return `${name} craft ${craft}/100 is ${verb} over the last ${n} closes — capture ${harvest?.kpis.capturePct ?? '—'}%, premature exits ${hold?.kpis.prematurePct ?? '—'}%.`;
}

export function buildTradeCraftPerformance(
  profileIdRaw: string,
  windowRaw: number
): TradeCraftPerformance {
  const profileId =
    String(profileIdRaw || 'all').trim() === ''
      ? 'all'
      : String(profileIdRaw || 'all').trim();
  const window = [20, 50, 100].includes(Number(windowRaw))
    ? Number(windowRaw)
    : Number(windowRaw) >= 80
      ? 100
      : Number(windowRaw) >= 35
        ? 50
        : 20;

  const allLoaded = loadEpisodes(profileId, Math.max(window, 100));
  const eps = allLoaded.slice(-window);
  const { traits, exitMix } = buildTraits(eps);
  const craftScore = blendCraft(traits);
  const { early, late } = halfSplit(eps);
  const earlyCraft = blendCraft(buildTraits(early).traits);
  const lateCraft = blendCraft(buildTraits(late).traits);
  const craftDelta =
    earlyCraft != null && lateCraft != null
      ? Math.round((lateCraft - earlyCraft) * 10) / 10
      : null;
  const trend = trendFromDelta(craftDelta, eps.length);
  const name = profileName(profileId);

  const bots =
    profileId === 'all'
      ? catalogIds()
          .map((id) => botRow(id, window))
          .filter((b) => b.n > 0)
          .sort((a, b) => (b.craftScore ?? -1) - (a.craftScore ?? -1))
      : [];

  const film = [...eps]
    .slice(-25)
    .reverse()
    .map(toFilm);

  let pclEnabled = false;
  try {
    pclEnabled = isProfitCaptureLayerEnabled();
  } catch {
    pclEnabled = false;
  }

  return {
    profileId,
    profileName: name,
    window,
    n: eps.length,
    pclEnabled,
    craftScore,
    trend,
    earlyCraft,
    lateCraft,
    craftDelta,
    plainLanguage: plainOverall(name, craftScore, trend, traits, eps.length),
    traits,
    exitMix,
    chart: buildChart(eps, window),
    bots,
    film,
  };
}
