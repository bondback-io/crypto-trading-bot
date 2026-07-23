/**
 * Performance Score Card — 0–100 + letter grade from trading stats.
 * Shared by Live Simulation (paper ledger) and Backtester.
 */

export interface PerformanceScoreInputs {
  winRatePct: number;
  profitFactor: number;
  maxDrawdownPct: number;
  avgWinPct?: number;
  avgLossPct?: number;
  /** |avgWinSol| / |avgLossSol| when % not available */
  avgWinLossRatio?: number;
  closedTrades: number;
}

export type PerformanceGrade = 'A' | 'B' | 'C' | 'D' | 'F';
export type PerformanceTone = 'good' | 'average' | 'poor' | 'neutral';

export interface PerformanceScoreCard {
  score: number;
  grade: PerformanceGrade;
  tone: PerformanceTone;
  color: string;
  label: string;
  components: {
    winRate: number;
    profitFactor: number;
    drawdown: number;
    winLossRatio: number;
    sampleSize: number;
  };
  weights: typeof SCORE_WEIGHTS;
  tip: string;
}

export const SCORE_WEIGHTS = {
  winRate: 0.3,
  profitFactor: 0.25,
  drawdown: 0.2,
  winLossRatio: 0.15,
  sampleSize: 0.1,
} as const;

export const PERFORMANCE_SCORE_TIP =
  'Score 0–100 from weighted Win Rate (30%), Profit Factor (25%), Max Drawdown inverted (20%), Avg Win/Loss ratio (15%), and sample-size confidence (10%). Tiny samples are penalized. A≥80, B≥65, C≥50, D≥35, else F.';

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function scoreWinRate(wr: number): number {
  // 35% → ~40, 50% → 60, 60% → 75, 70%+ → 90+
  return clamp(((wr - 20) / 55) * 100, 0, 100);
}

function scoreProfitFactor(pf: number): number {
  if (!(pf > 0) || !Number.isFinite(pf)) return 0;
  // 0.8 → weak, 1.0 → ~45, 1.5 → ~70, 2.5+ → 95+
  return clamp(((Math.min(pf, 4) - 0.5) / 2.5) * 100, 0, 100);
}

function scoreDrawdown(dd: number): number {
  // Lower is better: 5% → ~90, 15% → ~70, 30% → ~40, 50%+ → poor
  const d = Math.max(0, dd);
  return clamp(100 - d * 2.2, 0, 100);
}

function scoreWinLossRatio(ratio: number): number {
  // 1.0 → ~50, 1.5 → ~70, 2.5+ → 90+
  if (!(ratio > 0) || !Number.isFinite(ratio)) return 40;
  return clamp(((Math.min(ratio, 4) - 0.4) / 2.6) * 100, 0, 100);
}

function scoreSampleSize(n: number): number {
  // Full confidence by ~25 closed trades
  if (n <= 0) return 0;
  if (n >= 25) return 100;
  return clamp((n / 25) * 100, 8, 100);
}

export function gradeFromScore(score: number): PerformanceGrade {
  if (score >= 80) return 'A';
  if (score >= 65) return 'B';
  if (score >= 50) return 'C';
  if (score >= 35) return 'D';
  return 'F';
}

export function toneFromScore(score: number): PerformanceTone {
  if (!(score > 0) || !Number.isFinite(score)) return 'neutral';
  if (score >= 65) return 'good';
  if (score >= 45) return 'average';
  return 'poor';
}

export function colorFromTone(tone: PerformanceTone): string {
  switch (tone) {
    case 'good':
      return '#34d399';
    case 'average':
      return '#fbbf24';
    case 'poor':
      return '#f87171';
    default:
      return '#94a3b8';
  }
}

export function computePerformanceScore(
  input: PerformanceScoreInputs
): PerformanceScoreCard {
  const closed = Math.max(0, Math.floor(input.closedTrades || 0));
  if (closed <= 0) {
    return {
      score: 0,
      grade: 'F',
      tone: 'neutral',
      color: colorFromTone('neutral'),
      label: 'No closed trades yet',
      components: {
        winRate: 0,
        profitFactor: 0,
        drawdown: 0,
        winLossRatio: 0,
        sampleSize: 0,
      },
      weights: SCORE_WEIGHTS,
      tip: PERFORMANCE_SCORE_TIP,
    };
  }

  let wlRatio = input.avgWinLossRatio;
  if (wlRatio == null || !Number.isFinite(wlRatio)) {
    const aw = Math.abs(input.avgWinPct ?? 0);
    const al = Math.abs(input.avgLossPct ?? 0);
    wlRatio = al > 0 ? aw / al : aw > 0 ? 2 : 1;
  }

  const components = {
    winRate: scoreWinRate(input.winRatePct || 0),
    profitFactor: scoreProfitFactor(input.profitFactor || 0),
    drawdown: scoreDrawdown(input.maxDrawdownPct || 0),
    winLossRatio: scoreWinLossRatio(wlRatio),
    sampleSize: scoreSampleSize(closed),
  };

  const score = clamp(
    components.winRate * SCORE_WEIGHTS.winRate +
      components.profitFactor * SCORE_WEIGHTS.profitFactor +
      components.drawdown * SCORE_WEIGHTS.drawdown +
      components.winLossRatio * SCORE_WEIGHTS.winLossRatio +
      components.sampleSize * SCORE_WEIGHTS.sampleSize,
    0,
    100
  );
  const rounded = Math.round(score);
  const grade = gradeFromScore(rounded);
  const tone = toneFromScore(rounded);

  return {
    score: rounded,
    grade,
    tone,
    color: colorFromTone(tone),
    label: `Grade ${grade} · ${rounded}/100`,
    components: {
      winRate: Math.round(components.winRate),
      profitFactor: Math.round(components.profitFactor),
      drawdown: Math.round(components.drawdown),
      winLossRatio: Math.round(components.winLossRatio),
      sampleSize: Math.round(components.sampleSize),
    },
    weights: SCORE_WEIGHTS,
    tip: PERFORMANCE_SCORE_TIP,
  };
}

export function performanceScoreFromStats(stats: {
  winRatePct?: number;
  profitFactor?: number;
  maxDrawdownPct?: number;
  avgWinPct?: number;
  avgLossPct?: number;
  avgWinSol?: number;
  avgLossSol?: number;
  closedTrades?: number;
}): PerformanceScoreCard {
  const avgLossAbs = Math.abs(stats.avgLossSol ?? 0);
  const avgWinAbs = Math.abs(stats.avgWinSol ?? 0);
  const avgWinLossRatio =
    avgLossAbs > 0 ? avgWinAbs / avgLossAbs : avgWinAbs > 0 ? 2 : undefined;
  return computePerformanceScore({
    winRatePct: stats.winRatePct ?? 0,
    profitFactor: stats.profitFactor ?? 0,
    maxDrawdownPct: stats.maxDrawdownPct ?? 0,
    avgWinPct: stats.avgWinPct,
    avgLossPct: stats.avgLossPct,
    avgWinLossRatio,
    closedTrades: stats.closedTrades ?? 0,
  });
}
