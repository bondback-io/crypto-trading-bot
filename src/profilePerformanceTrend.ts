/**
 * Profile performance trend analysis + chart series (Scalper-first, reusable).
 * Visualisation / diagnostics only — does not mutate strategy.
 */

import { getProfileLearningEpisodes, type ProfileLearningEpisode } from './profileLearningEpisodes';

export type TrendLabel = 'improving' | 'stable' | 'declining' | 'critical';

export interface WindowMetrics {
  n: number;
  winRate: number;
  avgPnlPct: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number | null;
  avgGivebackPct: number;
  avgHoldSec: number;
  currentLossStreak: number;
  currentWinStreak: number;
  maxLossStreak: number;
}

export interface ConditionBucket {
  key: string;
  label: string;
  n: number;
  winRate: number;
  avgPnlPct: number;
}

export interface ProfilePerformanceTrend {
  profileId: string;
  label: TrendLabel;
  windows: Record<'10' | '20' | '50', WindowMetrics>;
  streakKind: 'win' | 'loss' | 'none';
  streakLen: number;
  helpful: ConditionBucket[];
  harmful: ConditionBucket[];
  plainLanguage: string;
  recoveryRecommend: boolean;
  chart: ProfileChartSeries;
}

export interface ProfileChartSeries {
  window: number;
  tradeIndex: number[];
  rollingWinRatePct: number[];
  rollingAvgPnlPct: number[];
  cumulativePnlPct: number[];
  rollingGivebackPct: number[];
  markers: Array<{ i: number; win: boolean; pnlPct: number }>;
}

const WINDOW_SIZES = [10, 20, 50] as const;

const seriesCache = new Map<
  string,
  { lastId: string; at: number; trend: ProfilePerformanceTrend }
>();

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function isWin(ep: ProfileLearningEpisode): boolean {
  return Number(ep.pnlPct) > 0 || Number(ep.pnlSol) > 0;
}

function computeWindowMetrics(eps: ProfileLearningEpisode[]): WindowMetrics {
  const n = eps.length;
  if (!n) {
    return {
      n: 0,
      winRate: 0,
      avgPnlPct: 0,
      avgWinPct: 0,
      avgLossPct: 0,
      profitFactor: null,
      avgGivebackPct: 0,
      avgHoldSec: 0,
      currentLossStreak: 0,
      currentWinStreak: 0,
      maxLossStreak: 0,
    };
  }
  const wins = eps.filter(isWin);
  const losses = eps.filter((e) => !isWin(e));
  const sumWin = wins.reduce((s, e) => s + Number(e.pnlPct || 0), 0);
  const sumLossAbs = losses.reduce(
    (s, e) => s + Math.abs(Number(e.pnlPct || 0)),
    0
  );
  let curLoss = 0;
  let curWin = 0;
  let maxLoss = 0;
  let runLoss = 0;
  for (let i = eps.length - 1; i >= 0; i--) {
    if (!isWin(eps[i]!)) {
      runLoss++;
      maxLoss = Math.max(maxLoss, runLoss);
    } else {
      runLoss = 0;
    }
  }
  for (let i = eps.length - 1; i >= 0; i--) {
    if (!isWin(eps[i]!)) {
      if (curWin === 0) curLoss++;
      else break;
    } else {
      if (curLoss === 0) curWin++;
      else break;
    }
  }
  return {
    n,
    winRate: wins.length / n,
    avgPnlPct: eps.reduce((s, e) => s + Number(e.pnlPct || 0), 0) / n,
    avgWinPct: wins.length ? sumWin / wins.length : 0,
    avgLossPct: losses.length
      ? losses.reduce((s, e) => s + Number(e.pnlPct || 0), 0) / losses.length
      : 0,
    profitFactor:
      sumLossAbs > 1e-9 ? sumWin / sumLossAbs : wins.length ? null : 0,
    avgGivebackPct:
      eps.reduce((s, e) => s + Math.max(0, Number(e.givebackFromPeakPct || 0)), 0) /
      n,
    avgHoldSec: eps.reduce((s, e) => s + Number(e.holdSec || 0), 0) / n,
    currentLossStreak: curLoss,
    currentWinStreak: curWin,
    maxLossStreak: maxLoss,
  };
}

function classifyTrend(
  w10: WindowMetrics,
  w20: WindowMetrics,
  w50: WindowMetrics
): TrendLabel {
  if (
    w10.currentLossStreak >= 5 ||
    (w10.n >= 8 && w10.winRate <= 0.15 && w10.avgPnlPct < 0)
  ) {
    return 'critical';
  }
  if (w10.n < 5 && w20.n < 8) return 'stable';
  const recent = w10.n >= 5 ? w10 : w20;
  const prior = w20.n >= 10 ? w20 : w50;
  if (prior.n < 5) return 'stable';
  const wrDelta = recent.winRate - prior.winRate;
  const expDelta = recent.avgPnlPct - prior.avgPnlPct;
  if (wrDelta >= 0.05 && expDelta >= 0.3) return 'improving';
  if (wrDelta <= -0.05 || expDelta <= -1.0) return 'declining';
  if (wrDelta <= -0.03 && expDelta < 0) return 'declining';
  return 'stable';
}

function mcBucket(mc: number | undefined): string {
  if (mc == null || !(mc > 0)) return 'mc_unknown';
  if (mc < 50_000) return 'mc_<50k';
  if (mc < 100_000) return 'mc_50-100k';
  if (mc < 180_000) return 'mc_100-180k';
  if (mc < 500_000) return 'mc_180-500k';
  return 'mc_500k+';
}

function segmentBuckets(
  eps: ProfileLearningEpisode[]
): { helpful: ConditionBucket[]; harmful: ConditionBucket[] } {
  const maps = new Map<string, ProfileLearningEpisode[]>();
  const add = (key: string, label: string, e: ProfileLearningEpisode) => {
    const k = `${key}::${label}`;
    const arr = maps.get(k) || [];
    arr.push(e);
    maps.set(k, arr);
  };
  for (const e of eps) {
    add('mc', mcBucket(e.entryMarketCapUsd), e);
    if (e.qualityTier) add('quality', e.qualityTier, e);
    if (e.hourUtc != null) {
      const h = Number(e.hourUtc);
      const session =
        h >= 13 && h < 21 ? 'session_US' : h >= 7 && h < 13 ? 'session_EU' : 'session_Asia';
      add('session', session, e);
    }
    if (e.exitKey) add('exit', String(e.exitKey), e);
    else if (e.exitReason) add('exit', String(e.exitReason).slice(0, 40), e);
    if (e.entrySource) add('source', String(e.entrySource), e);
    if (e.scannerPlaybook) add('playbook', String(e.scannerPlaybook), e);
    if (e.entryStyle) add('entryStyle', String(e.entryStyle), e);
    if (e.lateChaseAtEntry === true) add('late_chase', 'late_chase', e);
    else if (
      Array.isArray(e.learningTags) &&
      e.learningTags.includes('late_chase_fail')
    ) {
      add('late_chase', 'late_chase_fail', e);
    }
  }
  const buckets: ConditionBucket[] = [];
  for (const [k, list] of maps) {
    if (list.length < 3) continue;
    const [, label] = k.split('::');
    const m = computeWindowMetrics(list);
    buckets.push({
      key: k,
      label: label || k,
      n: m.n,
      winRate: m.winRate,
      avgPnlPct: m.avgPnlPct,
    });
  }
  buckets.sort((a, b) => b.avgPnlPct - a.avgPnlPct);
  return {
    helpful: buckets.filter((b) => b.avgPnlPct > 0).slice(0, 3),
    harmful: buckets
      .filter((b) => b.avgPnlPct < 0)
      .sort((a, b) => a.avgPnlPct - b.avgPnlPct)
      .slice(0, 3),
  };
}

function buildChartSeries(
  epsAsc: ProfileLearningEpisode[],
  window: number
): ProfileChartSeries {
  const slice = epsAsc.slice(-window);
  const tradeIndex: number[] = [];
  const rollingWinRatePct: number[] = [];
  const rollingAvgPnlPct: number[] = [];
  const cumulativePnlPct: number[] = [];
  const rollingGivebackPct: number[] = [];
  const markers: ProfileChartSeries['markers'] = [];
  let cum = 0;
  for (let i = 0; i < slice.length; i++) {
    const start = Math.max(0, i - window + 1);
    const sub = slice.slice(start, i + 1);
    const m = computeWindowMetrics(sub);
    cum += Number(slice[i]!.pnlPct || 0);
    tradeIndex.push(i + 1);
    rollingWinRatePct.push(Math.round(m.winRate * 1000) / 10);
    rollingAvgPnlPct.push(Math.round(m.avgPnlPct * 100) / 100);
    cumulativePnlPct.push(Math.round(cum * 100) / 100);
    rollingGivebackPct.push(Math.round(m.avgGivebackPct * 100) / 100);
    markers.push({
      i: i + 1,
      win: isWin(slice[i]!),
      pnlPct: Number(slice[i]!.pnlPct || 0),
    });
  }
  return {
    window,
    tradeIndex,
    rollingWinRatePct,
    rollingAvgPnlPct,
    cumulativePnlPct,
    rollingGivebackPct,
    markers,
  };
}

function plainLanguage(
  profileId: string,
  label: TrendLabel,
  w10: WindowMetrics,
  w20: WindowMetrics
): string {
  const name =
    profileId === 'scalper'
      ? 'Scalper'
      : profileId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const wr20 = Math.round(w20.winRate * 100);
  const wr10 = Math.round(w10.winRate * 100);
  if (label === 'critical') {
    return `${name} is in a losing streak (${w10.currentLossStreak}); average giveback remains high (${w10.avgGivebackPct.toFixed(1)}%).`;
  }
  if (label === 'improving') {
    return `${name} win rate improved toward ${wr10}% over recent trades (rolling 20 ≈ ${wr20}%),${
      w20.avgPnlPct < 0 ? ' but expectancy is still negative.' : ' with improving expectancy.'
    }`;
  }
  if (label === 'declining') {
    return `${name} rolling 20-trade win rate is ${wr20}% and declining.`;
  }
  if (w10.n >= 5 && w10.avgGivebackPct < w20.avgGivebackPct - 2) {
    return `Last 10 trades show reduced giveback, early stabilisation signs.`;
  }
  return `${name} looks stable — rolling 20-trade WR ${wr20}%, expectancy ${w20.avgPnlPct.toFixed(1)}%.`;
}

export function getProfileEpisodesAsc(profileId: string): ProfileLearningEpisode[] {
  const raw = getProfileLearningEpisodes(profileId) || [];
  return [...raw].sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0));
}

export function buildProfilePerformanceTrend(
  profileId: string,
  chartWindow = 20
): ProfilePerformanceTrend {
  const asc = getProfileEpisodesAsc(profileId);
  const lastId = asc.length ? String(asc[asc.length - 1]!.id || asc.length) : '0';
  const cacheKey = `${profileId}:${chartWindow}`;
  const hit = seriesCache.get(cacheKey);
  if (hit && hit.lastId === lastId && Date.now() - hit.at < 15_000) {
    return hit.trend;
  }

  const take = (n: number) => asc.slice(-n);
  const w10 = computeWindowMetrics(take(10));
  const w20 = computeWindowMetrics(take(20));
  const w50 = computeWindowMetrics(take(50));
  const label = classifyTrend(w10, w20, w50);
  const segs = segmentBuckets(take(50));
  const streakLen =
    w10.currentLossStreak > 0
      ? w10.currentLossStreak
      : w10.currentWinStreak > 0
        ? w10.currentWinStreak
        : 0;
  const trend: ProfilePerformanceTrend = {
    profileId,
    label,
    windows: { '10': w10, '20': w20, '50': w50 },
    streakKind:
      w10.currentLossStreak > 0
        ? 'loss'
        : w10.currentWinStreak > 0
          ? 'win'
          : 'none',
    streakLen,
    helpful: segs.helpful,
    harmful: segs.harmful,
    plainLanguage: plainLanguage(profileId, label, w10, w20),
    recoveryRecommend: label === 'declining' || label === 'critical',
    chart: buildChartSeries(asc, clamp(chartWindow, 10, 50)),
  };
  seriesCache.set(cacheKey, { lastId, at: Date.now(), trend });
  return trend;
}

export function buildProfilePerformanceChartSeries(
  profileId: string,
  window: number
): ProfileChartSeries {
  return buildProfilePerformanceTrend(profileId, window).chart;
}

export function formatScalperWinRateTrendPlainLanguage(): string {
  try {
    return buildProfilePerformanceTrend('scalper').plainLanguage;
  } catch {
    return '';
  }
}

export function invalidateProfilePerformanceTrendCache(
  profileId?: string
): void {
  if (!profileId) {
    seriesCache.clear();
    return;
  }
  for (const k of [...seriesCache.keys()]) {
    if (k.startsWith(`${profileId}:`)) seriesCache.delete(k);
  }
}

export { computeWindowMetrics, WINDOW_SIZES };
