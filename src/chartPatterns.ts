/**
 * Chart pattern recognition for Pump.fun — entry signals + confirmation filters.
 *
 * Uses the same in-memory price history as technicalLevels (Paper / Live Sim /
 * Backtester). Fail-open when history is thin. Each pattern is individually
 * toggleable via config.chartPatterns.patterns.*.enabled.
 */

import { config } from './config';
import { isStrategyEnabled, logStrategyDecision } from './strategies';
import {
  findSwingPivots,
  getPriceHistory,
  recordPriceTick,
  seedPriceHistoryFromCandles,
  type PricePoint,
  type TechnicalAnalyzeInput,
} from './technicalLevels';

export const CHART_PATTERN_IDS = [
  'falling_wedge',
  'ascending_triangle',
  'descending_triangle',
  'trend_continuation',
  'structured_pullback',
  'trendline_break',
  'volume_dryup_return',
  'holder_distribution',
  'capitulation',
  'bull_flag',
] as const;

export type ChartPatternId = (typeof CHART_PATTERN_IDS)[number];

/** Top-5 Pump.fun patterns — each has its own strategy toggle */
export const CORE_CHART_PATTERN_IDS = [
  'volume_dryup_return',
  'falling_wedge',
  'structured_pullback',
  'bull_flag',
  'trend_continuation',
] as const;

export type CoreChartPatternId = (typeof CORE_CHART_PATTERN_IDS)[number];

export const CORE_PATTERN_STRATEGY_KEY: Record<
  CoreChartPatternId,
  | 'pattern_volume_dryup_return'
  | 'pattern_falling_wedge'
  | 'pattern_structured_pullback'
  | 'pattern_bull_flag'
  | 'pattern_trend_continuation'
> = {
  volume_dryup_return: 'pattern_volume_dryup_return',
  falling_wedge: 'pattern_falling_wedge',
  structured_pullback: 'pattern_structured_pullback',
  bull_flag: 'pattern_bull_flag',
  trend_continuation: 'pattern_trend_continuation',
};

export type PatternBias = 'bullish' | 'bearish' | 'neutral';

export interface DetectedPattern {
  id: ChartPatternId;
  name: string;
  bias: PatternBias;
  /** 0–100 confidence */
  confidence: number;
  /** Fired as a fresh breakout / signal (vs forming only) */
  breakout: boolean;
  detail: string;
}

export interface ChartPatternReport {
  mint: string | null;
  price: number | null;
  patterns: DetectedPattern[];
  bullish: DetectedPattern[];
  bearish: DetectedPattern[];
  summary: string;
  source: 'history' | 'candles' | 'none';
  lookbackUsed: number;
}

export interface ChartPatternAnalyzeInput extends TechnicalAnalyzeInput {
  symbol?: string;
  holderCount?: number | null;
  holderCountPrev?: number | null;
  volumeH1Usd?: number | null;
  volumeM5Usd?: number | null;
  dropFromPeakPct?: number | null;
  priceChangeH1Pct?: number | null;
  priceChange24hPct?: number | null;
  marketCapUsd?: number | null;
  /** Prefer cleaner (higher-confidence / breakout) hits — High Win-Rate / large MC */
  preferClean?: boolean;
  /**
   * When true, evaluate config-enabled patterns without requiring strategy
   * toggles — so scanner ranking isn't empty when pattern strategies are OFF.
   */
  ignoreStrategyGates?: boolean;
}

const PATTERN_NAMES: Record<ChartPatternId, string> = {
  falling_wedge: 'Falling Wedge Breakout',
  ascending_triangle: 'Ascending Triangle Breakout',
  descending_triangle: 'Descending Triangle',
  trend_continuation: 'Trend Continuation',
  structured_pullback: 'Structured Pullback',
  trendline_break: 'Trendline Break',
  volume_dryup_return: 'Volume Dry-up then Return',
  holder_distribution: 'Holder Distribution',
  capitulation: 'Big Sell-off / Capitulation',
  bull_flag: 'Bull Flag / Pennant',
};

const DEFAULT_PATTERN_ON: Record<ChartPatternId, boolean> = {
  falling_wedge: true,
  ascending_triangle: false,
  descending_triangle: false,
  trend_continuation: true,
  structured_pullback: true,
  trendline_break: false,
  volume_dryup_return: true,
  holder_distribution: false,
  capitulation: false,
  bull_flag: true,
};

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pct(a: number, b: number): number {
  if (!(b > 0)) return 0;
  return ((a - b) / b) * 100;
}

function linSlope(ys: number[]): number {
  const n = ys.length;
  if (n < 2) return 0;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += ys[i]!;
    sumXY += i * ys[i]!;
    sumXX += i * i;
  }
  const den = n * sumXX - sumX * sumX;
  if (Math.abs(den) < 1e-12) return 0;
  return (n * sumXY - sumX * sumY) / den;
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Thread-local: set during analyzeChartPatterns when ignoreStrategyGates */
let _ignoreStrategyGates = false;

function patternEnabled(id: ChartPatternId): boolean {
  const p = config.chartPatterns?.patterns?.[id];
  const cfgOn = p && typeof p.enabled === 'boolean' ? p.enabled : DEFAULT_PATTERN_ON[id] !== false;
  if (!cfgOn) return false;
  if (_ignoreStrategyGates) return true;
  // Core patterns gated by their dedicated strategy toggles
  if ((CORE_CHART_PATTERN_IDS as readonly string[]).includes(id)) {
    const key = CORE_PATTERN_STRATEGY_KEY[id as CoreChartPatternId];
    return isStrategyEnabled(key);
  }
  // Extras require the chart_patterns umbrella
  return isStrategyEnabled('chart_patterns');
}

function sensScale(): number {
  const s = config.chartPatterns?.sensitivity;
  if (s === 'low') return 0.85;
  if (s === 'high') return 1.15;
  return 1;
}

/** Cleaner setups for higher MC / High Win-Rate — stricter confidence floor */
let _activeCleanMode = false;

function minConf(): number {
  const base = Number(config.chartPatterns?.minConfidence) || 55;
  const s = config.chartPatterns?.sensitivity;
  let floor = base;
  if (s === 'low') floor = Math.max(40, base - 8);
  if (s === 'high') floor = Math.min(80, base + 8);
  if (_activeCleanMode) floor = Math.min(88, floor + 12);
  return floor;
}

function wantsClean(input?: ChartPatternAnalyzeInput): boolean {
  if (input?.preferClean === true) return true;
  const mc = num(input?.marketCapUsd);
  // Higher MC Pump.fun tokens → prefer cleaner pattern versions
  return mc != null && mc >= 250_000;
}

function lookbackBars(): number {
  const n = Number(config.chartPatterns?.lookbackBars);
  return Number.isFinite(n) && n >= 12 ? Math.min(240, Math.round(n)) : 64;
}

function resolvePoints(input: ChartPatternAnalyzeInput): {
  points: PricePoint[];
  source: 'history' | 'candles' | 'none';
  price: number | null;
} {
  const mint = input.mint ? String(input.mint) : null;
  if (mint && input.candles?.length) {
    seedPriceHistoryFromCandles(mint, input.candles);
  }
  const price =
    num(input.priceSol) ??
    num(input.priceUsd) ??
    (mint && getPriceHistory(mint).length
      ? getPriceHistory(mint)[getPriceHistory(mint).length - 1]!.price
      : null);
  if (mint && price != null && price > 0) {
    recordPriceTick(mint, price, input.nowMs ?? Date.now());
  }
  let points: PricePoint[] = mint ? [...getPriceHistory(mint)] : [];
  let source: 'history' | 'candles' | 'none' =
    points.length >= 8 ? 'history' : 'none';
  if (points.length < 8 && input.candles?.length) {
    points = input.candles
      .map((c) => ({
        time: c.time,
        price: Number(c.priceSol ?? c.price) || 0,
        volume: c.volume,
      }))
      .filter((p) => p.price > 0);
    source = points.length >= 8 ? 'candles' : 'none';
  }
  const lb = lookbackBars();
  if (points.length > lb) points = points.slice(-lb);
  return { points, source, price };
}

function detectFallingWedge(
  points: PricePoint[],
  price: number
): DetectedPattern | null {
  if (points.length < 14) return null;
  const pivots = findSwingPivots(points, 2);
  const highs = pivots.highs.slice(-5);
  const lows = pivots.lows.slice(-5);
  if (highs.length < 3 || lows.length < 3) return null;
  const hY = highs.map((h) => h.price);
  const lY = lows.map((l) => l.price);
  const hSlope = linSlope(hY);
  const lSlope = linSlope(lY);
  // Both descending; range converging
  if (!(hSlope < 0 && lSlope < 0)) return null;
  const firstRange = hY[0]! - lY[0]!;
  const lastRange = hY[hY.length - 1]! - lY[lY.length - 1]!;
  if (!(firstRange > 0 && lastRange > 0 && lastRange < firstRange * 0.85)) {
    return null;
  }
  const upper = hY[hY.length - 1]!;
  const breakoutPct = Number(config.chartPatterns?.breakoutPct) || 1.2;
  const broke = price >= upper * (1 + (breakoutPct * sensScale()) / 100);
  const conf = clamp(
    50 +
      (broke ? 20 : 5) +
      Math.min(15, ((firstRange - lastRange) / firstRange) * 40),
    0,
    100
  );
  if (conf < minConf() && !broke) return null;
  return {
    id: 'falling_wedge',
    name: PATTERN_NAMES.falling_wedge,
    bias: 'bullish',
    confidence: Math.round(conf),
    breakout: broke,
    detail: broke
      ? `breakout above wedge @${upper.toExponential(3)}`
      : `forming wedge (range narrowing ${(
          (1 - lastRange / firstRange) *
          100
        ).toFixed(0)}%)`,
  };
}

function detectAscendingTriangle(
  points: PricePoint[],
  price: number
): DetectedPattern | null {
  if (points.length < 12) return null;
  const pivots = findSwingPivots(points, 2);
  const highs = pivots.highs.slice(-4);
  const lows = pivots.lows.slice(-4);
  if (highs.length < 2 || lows.length < 3) return null;
  const hY = highs.map((h) => h.price);
  const resistance = mean(hY);
  const hCv = stdev(hY) / resistance;
  if (hCv > 0.035 / sensScale()) return null;
  const lSlope = linSlope(lows.map((l) => l.price));
  if (!(lSlope > 0)) return null;
  const breakoutPct = Number(config.chartPatterns?.breakoutPct) || 1.2;
  const broke = price >= resistance * (1 + (breakoutPct * sensScale()) / 100);
  const conf = clamp(52 + (broke ? 22 : 8) + Math.min(12, lSlope * 5000), 0, 100);
  if (conf < minConf() && !broke) return null;
  return {
    id: 'ascending_triangle',
    name: PATTERN_NAMES.ascending_triangle,
    bias: 'bullish',
    confidence: Math.round(conf),
    breakout: broke,
    detail: broke
      ? `broke flat resistance @${resistance.toExponential(3)}`
      : `ascending triangle under ${resistance.toExponential(3)}`,
  };
}

function detectDescendingTriangle(
  points: PricePoint[],
  price: number
): DetectedPattern | null {
  if (points.length < 12) return null;
  const pivots = findSwingPivots(points, 2);
  const highs = pivots.highs.slice(-4);
  const lows = pivots.lows.slice(-4);
  if (highs.length < 3 || lows.length < 2) return null;
  const lY = lows.map((l) => l.price);
  const support = mean(lY);
  const lCv = stdev(lY) / support;
  if (lCv > 0.035 / sensScale()) return null;
  const hSlope = linSlope(highs.map((h) => h.price));
  if (!(hSlope < 0)) return null;
  const breakPct = Number(config.chartPatterns?.breakoutPct) || 1.2;
  const brokeDown =
    price <= support * (1 - (breakPct * sensScale()) / 100);
  const conf = clamp(
    50 + (brokeDown ? 25 : 10) + Math.min(12, Math.abs(hSlope) * 5000),
    0,
    100
  );
  if (conf < minConf()) return null;
  return {
    id: 'descending_triangle',
    name: PATTERN_NAMES.descending_triangle,
    bias: 'bearish',
    confidence: Math.round(conf),
    breakout: brokeDown,
    detail: brokeDown
      ? `broke support @${support.toExponential(3)} (bearish)`
      : `descending triangle on flat support ${support.toExponential(3)}`,
  };
}

function detectTrendContinuation(
  points: PricePoint[],
  price: number
): DetectedPattern | null {
  if (points.length < 16) return null;
  const pivots = findSwingPivots(points, 2);
  const highs = pivots.highs.slice(-4);
  const lows = pivots.lows.slice(-4);
  if (highs.length < 2 || lows.length < 2) return null;
  const hh = highs[highs.length - 1]!.price > highs[0]!.price;
  const hl = lows[lows.length - 1]!.price > lows[0]!.price;
  if (!(hh && hl)) return null;
  const lastLow = lows[lows.length - 1]!.price;
  const nearPct = (Number(config.chartPatterns?.pullbackNearPct) || 3) * sensScale();
  const nearPullback =
    price >= lastLow && pct(price, lastLow) <= nearPct * 1.5;
  const reclaim =
    price > lastLow * (1 + nearPct / 200) &&
    price < highs[highs.length - 1]!.price;
  if (!nearPullback && !reclaim) return null;
  const conf = clamp(55 + (reclaim ? 18 : 8) + (hh && hl ? 10 : 0), 0, 100);
  if (conf < minConf()) return null;
  return {
    id: 'trend_continuation',
    name: PATTERN_NAMES.trend_continuation,
    bias: 'bullish',
    confidence: Math.round(conf),
    breakout: reclaim,
    detail: reclaim
      ? `uptrend pullback reclaim above ${lastLow.toExponential(3)}`
      : `buy-the-dip in HH/HL uptrend near ${lastLow.toExponential(3)}`,
  };
}

function detectStructuredPullback(
  points: PricePoint[],
  price: number,
  dropFromPeakPct: number | null
): DetectedPattern | null {
  if (points.length < 12) return null;
  const prices = points.map((p) => p.price);
  let peak = prices[0]!;
  let peakIdx = 0;
  for (let i = 1; i < prices.length; i++) {
    if (prices[i]! > peak) {
      peak = prices[i]!;
      peakIdx = i;
    }
  }
  if (peakIdx < 4 || peakIdx > prices.length - 3) return null;
  const runPct = pct(peak, prices[0]!);
  const minRun = Number(config.chartPatterns?.minPoleRunPct) || 25;
  if (runPct < minRun / sensScale()) return null;
  const drop = dropFromPeakPct != null ? dropFromPeakPct : -pct(price, peak);
  const minDrop = Number(config.chartPatterns?.minStructuredDropPct) || 8;
  const maxDrop = Number(config.chartPatterns?.maxStructuredDropPct) || 35;
  if (drop < minDrop || drop > maxDrop) return null;
  // Orderly: pullback segment should not be a single vertical candle crash
  const after = prices.slice(peakIdx);
  const stepDrops = [];
  for (let i = 1; i < after.length; i++) {
    stepDrops.push(Math.abs(pct(after[i]!, after[i - 1]!)));
  }
  const maxStep = stepDrops.length ? Math.max(...stepDrops) : 99;
  if (maxStep > 22 / sensScale()) return null; // too violent = not structured
  const conf = clamp(50 + Math.min(20, runPct / 5) + Math.min(15, drop), 0, 100);
  if (conf < minConf()) return null;
  return {
    id: 'structured_pullback',
    name: PATTERN_NAMES.structured_pullback,
    bias: 'bullish',
    confidence: Math.round(conf),
    breakout: drop >= minDrop && price > peak * (1 - maxDrop / 100),
    detail: `orderly −${drop.toFixed(0)}% after +${runPct.toFixed(0)}% run`,
  };
}

function detectTrendlineBreak(
  points: PricePoint[],
  price: number
): DetectedPattern | null {
  if (points.length < 14) return null;
  const pivots = findSwingPivots(points, 2);
  const lows = pivots.lows.slice(-3);
  const highs = pivots.highs.slice(-3);
  const breakPct = (Number(config.chartPatterns?.breakoutPct) || 1.2) * sensScale();

  if (lows.length >= 2) {
    const slope = linSlope(lows.map((l) => l.price));
    const last = lows[lows.length - 1]!;
    const lastIdx = points.findIndex((p) => p.time === last.time);
    const steps = Math.max(1, points.length - (lastIdx >= 0 ? lastIdx : points.length - 1) - 1);
    const projected = last.price + slope * steps;
    if (price < projected * (1 - breakPct / 100) && slope >= 0) {
      const conf = clamp(58 + Math.min(20, Math.abs(pct(price, projected))), 0, 100);
      if (conf >= minConf()) {
        return {
          id: 'trendline_break',
          name: PATTERN_NAMES.trendline_break,
          bias: 'bearish',
          confidence: Math.round(conf),
          breakout: true,
          detail: `broke rising support TL @${projected.toExponential(3)}`,
        };
      }
    }
  }

  if (highs.length >= 2) {
    const slope = linSlope(highs.map((h) => h.price));
    const last = highs[highs.length - 1]!;
    const lastIdx = points.findIndex((p) => p.time === last.time);
    const steps = Math.max(1, points.length - (lastIdx >= 0 ? lastIdx : points.length - 1) - 1);
    const projected = last.price + slope * steps;
    if (price > projected * (1 + breakPct / 100) && slope <= 0) {
      const conf = clamp(58 + Math.min(20, Math.abs(pct(price, projected))), 0, 100);
      if (conf >= minConf()) {
        return {
          id: 'trendline_break',
          name: PATTERN_NAMES.trendline_break,
          bias: 'bullish',
          confidence: Math.round(conf),
          breakout: true,
          detail: `broke falling resistance TL @${projected.toExponential(3)}`,
        };
      }
    }
  }
  return null;
}

function detectVolumeDryupReturn(
  points: PricePoint[],
  price: number
): DetectedPattern | null {
  const withVol = points.filter((p) => p.volume != null && p.volume! > 0);
  if (withVol.length < 10) return null;
  const n = withVol.length;
  const early = withVol.slice(0, Math.floor(n * 0.4));
  const mid = withVol.slice(Math.floor(n * 0.4), Math.floor(n * 0.75));
  const late = withVol.slice(Math.floor(n * 0.75));
  const eVol = mean(early.map((p) => p.volume!));
  const mVol = mean(mid.map((p) => p.volume!));
  const lVol = mean(late.map((p) => p.volume!));
  if (!(eVol > 0 && mVol > 0 && lVol > 0)) return null;
  const dryRatio = Number(config.chartPatterns?.volumeDryupRatio) || 0.55;
  const returnRatio = Number(config.chartPatterns?.volumeReturnRatio) || 1.35;
  const dried = mVol <= eVol * dryRatio * sensScale();
  const returned = lVol >= mVol * returnRatio;
  if (!(dried && returned)) return null;
  const priceUp = price >= mid[mid.length - 1]!.price;
  if (!priceUp) return null;
  const conf = clamp(
    55 +
      Math.min(20, (1 - mVol / eVol) * 40) +
      Math.min(15, (lVol / mVol - 1) * 20),
    0,
    100
  );
  if (conf < minConf()) return null;
  return {
    id: 'volume_dryup_return',
    name: PATTERN_NAMES.volume_dryup_return,
    bias: 'bullish',
    confidence: Math.round(conf),
    breakout: true,
    detail: `vol dry ${(mVol / eVol).toFixed(2)}× then return ${(lVol / mVol).toFixed(2)}×`,
  };
}

function detectHolderDistribution(input: ChartPatternAnalyzeInput): DetectedPattern | null {
  const cur = num(input.holderCount);
  const prev = num(input.holderCountPrev);
  if (cur == null || prev == null || prev <= 0) return null;
  const dropPct = ((prev - cur) / prev) * 100;
  const minDrop = (Number(config.chartPatterns?.holderDropPct) || 8) / sensScale();
  if (dropPct < minDrop) return null;
  const priceChg = num(input.priceChangeH1Pct) ?? 0;
  // Distribution: holders leave while price flat/weak
  if (priceChg > 8) return null;
  const conf = clamp(50 + Math.min(30, dropPct * 2), 0, 100);
  if (conf < minConf()) return null;
  return {
    id: 'holder_distribution',
    name: PATTERN_NAMES.holder_distribution,
    bias: 'bearish',
    confidence: Math.round(conf),
    breakout: dropPct >= minDrop * 1.4,
    detail: `holders −${dropPct.toFixed(1)}% (prev ${prev} → ${cur})`,
  };
}

function detectCapitulation(
  points: PricePoint[],
  price: number,
  dropFromPeakPct: number | null
): DetectedPattern | null {
  if (points.length < 8) return null;
  const prices = points.map((p) => p.price);
  const peak = Math.max(...prices);
  const drop = dropFromPeakPct != null ? dropFromPeakPct : -pct(price, peak);
  const minCap = (Number(config.chartPatterns?.capitulationDropPct) || 28) / sensScale();
  if (drop < minCap) return null;
  const recent = points.slice(-5);
  const vols = recent.map((p) => p.volume ?? 0);
  const earlier = points.slice(0, Math.max(1, points.length - 5));
  const avgEarlier = mean(earlier.map((p) => p.volume ?? 0)) || 1;
  const volSpike = mean(vols) >= avgEarlier * 1.8;
  // Capitulation reclaim: bounce off the low
  const trough = Math.min(...prices.slice(-8));
  const reclaim = price > trough * 1.04 && price < peak * 0.9;
  const conf = clamp(
    48 + Math.min(25, drop / 2) + (volSpike ? 12 : 0) + (reclaim ? 10 : 0),
    0,
    100
  );
  if (conf < minConf()) return null;
  return {
    id: 'capitulation',
    name: PATTERN_NAMES.capitulation,
    bias: reclaim ? 'bullish' : 'bearish',
    confidence: Math.round(conf),
    breakout: reclaim,
    detail: reclaim
      ? `capitulation reclaim after −${drop.toFixed(0)}%` +
        (volSpike ? ' + vol spike' : '')
      : `capitulation dump −${drop.toFixed(0)}%` +
        (volSpike ? ' on volume' : ''),
  };
}

function detectBullFlag(
  points: PricePoint[],
  price: number
): DetectedPattern | null {
  if (points.length < 14) return null;
  const prices = points.map((p) => p.price);
  const mid = Math.floor(prices.length * 0.55);
  const pole = prices.slice(0, mid);
  const flag = prices.slice(mid);
  if (pole.length < 4 || flag.length < 5) return null;
  const poleRun = pct(pole[pole.length - 1]!, pole[0]!);
  const minPole = Number(config.chartPatterns?.minPoleRunPct) || 25;
  if (poleRun < minPole / sensScale()) return null;
  const flagHigh = Math.max(...flag);
  const flagLow = Math.min(...flag);
  const flagRange = pct(flagHigh, flagLow);
  const maxFlag = Number(config.chartPatterns?.maxFlagRangePct) || 18;
  if (flagRange > maxFlag * sensScale()) return null;
  // Flag should drift flat/slightly down after pole
  const flagSlope = linSlope(flag);
  if (flagSlope > poleRun * 0.02) return null;
  const breakoutPct = Number(config.chartPatterns?.breakoutPct) || 1.2;
  const broke = price >= flagHigh * (1 + (breakoutPct * sensScale()) / 100);
  const conf = clamp(
    52 +
      Math.min(20, poleRun / 4) +
      (broke ? 18 : 6) +
      Math.min(10, (maxFlag - flagRange) * 0.8),
    0,
    100
  );
  if (conf < minConf() && !broke) return null;
  return {
    id: 'bull_flag',
    name: PATTERN_NAMES.bull_flag,
    bias: 'bullish',
    confidence: Math.round(conf),
    breakout: broke,
    detail: broke
      ? `bull flag breakout after +${poleRun.toFixed(0)}% pole`
      : `bull flag/pennant consolidating (−${flagRange.toFixed(0)}% range)`,
  };
}

/** Core detector — safe to call from Paper / Live Sim / Backtester. */
export function analyzeChartPatterns(
  input: ChartPatternAnalyzeInput
): ChartPatternReport {
  const { points, source, price } = resolvePoints(input);
  const empty: ChartPatternReport = {
    mint: input.mint ? String(input.mint) : null,
    price,
    patterns: [],
    bullish: [],
    bearish: [],
    summary: 'no patterns',
    source,
    lookbackUsed: points.length,
  };
  if (source === 'none' || price == null || !(price > 0) || points.length < 8) {
    return { ...empty, summary: 'insufficient history' };
  }

  const prevIgnore = _ignoreStrategyGates;
  _ignoreStrategyGates = input.ignoreStrategyGates === true;
  try {
    return analyzeChartPatternsInner(input, points, source, price);
  } finally {
    _ignoreStrategyGates = prevIgnore;
  }
}

function analyzeChartPatternsInner(
  input: ChartPatternAnalyzeInput,
  points: PricePoint[],
  source: ChartPatternReport['source'],
  price: number
): ChartPatternReport {
  _activeCleanMode = wantsClean(input);
  const drop = num(input.dropFromPeakPct);
  const detectors: Array<() => DetectedPattern | null> = [
    () =>
      patternEnabled('falling_wedge')
        ? detectFallingWedge(points, price)
        : null,
    () =>
      patternEnabled('ascending_triangle')
        ? detectAscendingTriangle(points, price)
        : null,
    () =>
      patternEnabled('descending_triangle')
        ? detectDescendingTriangle(points, price)
        : null,
    () =>
      patternEnabled('trend_continuation')
        ? detectTrendContinuation(points, price)
        : null,
    () =>
      patternEnabled('structured_pullback')
        ? detectStructuredPullback(points, price, drop)
        : null,
    () =>
      patternEnabled('trendline_break')
        ? detectTrendlineBreak(points, price)
        : null,
    () =>
      patternEnabled('volume_dryup_return')
        ? detectVolumeDryupReturn(points, price)
        : null,
    () =>
      patternEnabled('holder_distribution')
        ? detectHolderDistribution(input)
        : null,
    () =>
      patternEnabled('capitulation')
        ? detectCapitulation(points, price, drop)
        : null,
    () => (patternEnabled('bull_flag') ? detectBullFlag(points, price) : null),
  ];

  const patterns: DetectedPattern[] = [];
  for (const d of detectors) {
    try {
      const hit = d();
      if (!hit) continue;
      // Higher MC / High Win-Rate: keep only cleaner (breakout or high-confidence) hits
      if (
        _activeCleanMode &&
        !hit.breakout &&
        hit.confidence < minConf() + 5
      ) {
        continue;
      }
      patterns.push(hit);
    } catch {
      /* fail-open per pattern */
    }
  }
  patterns.sort((a, b) => b.confidence - a.confidence);
  const bullish = patterns.filter((p) => p.bias === 'bullish');
  const bearish = patterns.filter((p) => p.bias === 'bearish');
  const top = patterns.slice(0, 3).map((p) => `${p.name.split(' ')[0]} ${p.confidence}`);
  return {
    mint: input.mint ? String(input.mint) : null,
    price,
    patterns,
    bullish,
    bearish,
    summary: top.length ? top.join(' · ') : 'no patterns',
    source,
    lookbackUsed: points.length,
  };
}

export function isChartPatternsEnabled(): boolean {
  if (config.chartPatterns?.enabled === false) {
    // Still allow if any dedicated core pattern strategy is ON
  }
  const anyCore = CORE_CHART_PATTERN_IDS.some((id) =>
    isStrategyEnabled(CORE_PATTERN_STRATEGY_KEY[id])
  );
  const extras = isStrategyEnabled('chart_patterns');
  return anyCore || extras;
}

export function resolveChartPatternsForSignal(
  input: ChartPatternAnalyzeInput
): {
  convictionDelta: number;
  influenced: boolean;
  skip: boolean;
  skipReason?: string;
  report: ChartPatternReport;
  logLine: string;
  activePatternIds: ChartPatternId[];
} | null {
  if (!isChartPatternsEnabled()) return null;

  const report = analyzeChartPatterns(input);
  if (report.source === 'none') {
    return {
      convictionDelta: 0,
      influenced: false,
      skip: false,
      report,
      logLine: 'patterns: no data (fail-open)',
      activePatternIds: [],
    };
  }

  const mode = config.chartPatterns?.mode || 'both';
  const allowEntry = mode === 'entry' || mode === 'both';
  const allowConfirm = mode === 'confirm' || mode === 'both';
  const clean = wantsClean(input);

  let delta = 0;
  const bits: string[] = [];
  const contributedKeys = new Set<string>();

  for (const p of report.bullish) {
    const entryBoost = p.breakout && allowEntry;
    const confirmBoost = allowConfirm && (!clean || p.breakout || p.confidence >= minConf());
    if (!entryBoost && !confirmBoost) continue;
    let pts =
      (p.breakout ? 8 : 4) +
      Math.round((p.confidence - 50) / 12) +
      (config.chartPatterns?.sensitivity === 'high' ? 1 : 0);
    if (clean && p.breakout) pts += 2;
    pts = Math.max(2, pts);
    delta += pts;
    bits.push(`${p.id}${p.breakout ? '!' : ''}+${pts}${clean ? '·clean' : ''}`);
    if ((CORE_CHART_PATTERN_IDS as readonly string[]).includes(p.id)) {
      contributedKeys.add(CORE_PATTERN_STRATEGY_KEY[p.id as CoreChartPatternId]);
    } else {
      contributedKeys.add('chart_patterns');
    }
  }

  const bearPenalty = Number(config.chartPatterns?.bearishPenalty) || 6;
  for (const p of report.bearish) {
    if (!allowConfirm && !allowEntry) continue;
    const pts = Math.min(
      bearPenalty + (p.breakout ? 4 : 0),
      14
    );
    delta -= pts;
    bits.push(`${p.id}-${pts}`);
    contributedKeys.add('chart_patterns');
  }

  delta = clamp(delta, -14, 14);

  let skip = false;
  let skipReason: string | undefined;
  if (
    config.chartPatterns?.hardFilter === true &&
    report.bullish.length === 0
  ) {
    skip = true;
    skipReason = 'pattern filter: no bullish setup';
  }
  if (
    config.chartPatterns?.blockOnBearish === true &&
    report.bearish.some((p) => p.breakout || p.confidence >= 70)
  ) {
    skip = true;
    skipReason =
      'pattern filter: bearish warning (' +
      report.bearish.map((p) => p.id).join(', ') +
      ')';
  }

  const influenced = delta !== 0 || skip || report.patterns.length > 0;
  const logLine =
    `patterns ${config.chartPatterns?.sensitivity || 'medium'}${
      clean ? '/clean' : ''
    }: Δconv=${delta > 0 ? '+' : ''}${delta}` +
    (skip ? ' SKIP' : '') +
    (bits.length ? ` · ${bits.join(' ')}` : '') +
    ` · ${report.summary}`;

  if (influenced && (delta !== 0 || skip)) {
    const logKey =
      (contributedKeys.values().next().value as
        | 'chart_patterns'
        | 'pattern_volume_dryup_return'
        | 'pattern_falling_wedge'
        | 'pattern_structured_pullback'
        | 'pattern_bull_flag'
        | 'pattern_trend_continuation') || 'chart_patterns';
    logStrategyDecision(
      logKey,
      skip ? 'skip' : delta >= 0 ? 'take' : 'gate',
      `${input.symbol || input.mint || 'token'}: ${logLine}`
    );
    console.log(
      `[patterns] ${skip ? 'SKIP' : delta >= 0 ? 'BOOST' : 'WARN'} ${
        input.symbol || input.mint
      } — ${logLine}`
    );
  }

  return {
    convictionDelta: delta,
    influenced,
    skip,
    skipReason,
    report,
    logLine,
    activePatternIds: report.patterns.map((p) => p.id),
  };
}

export function chartPatternsPublic(report: ChartPatternReport | null | undefined) {
  if (!report) return null;
  return {
    summary: report.summary,
    source: report.source,
    lookbackUsed: report.lookbackUsed,
    patterns: report.patterns.map((p) => ({
      id: p.id,
      name: p.name,
      bias: p.bias,
      confidence: p.confidence,
      breakout: p.breakout,
      detail: p.detail,
    })),
    bullishCount: report.bullish.length,
    bearishCount: report.bearish.length,
  };
}

export function chartPatternLabels(): Array<{
  id: ChartPatternId;
  name: string;
  bias: PatternBias;
}> {
  return CHART_PATTERN_IDS.map((id) => ({
    id,
    name: PATTERN_NAMES[id],
    bias:
      id === 'descending_triangle' || id === 'holder_distribution'
        ? 'bearish'
        : id === 'trendline_break' || id === 'capitulation'
          ? 'neutral'
          : 'bullish',
  }));
}
