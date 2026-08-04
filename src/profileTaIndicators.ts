/**
 * Additive Profile TA indicators — MACD, Bollinger, ZigZag, RSI/volume divergence.
 * Pure candle math; fail-open when history is thin. Does not replace scanner indicators.ts.
 */

export const MACD_FAST = 12;
export const MACD_SLOW = 26;
export const MACD_SIGNAL = 9;
export const RSI_LEN = 14;
export const RSI_OB = 70;
export const RSI_OS = 30;
export const BB_PERIOD = 20;
export const BB_STD = 2;
export const ZIGZAG_MIN_PCT = 2.5;
export const MIN_CANDLES_MACD = MACD_SLOW + MACD_SIGNAL + 5;
export const MIN_CANDLES_BB = BB_PERIOD + 5;
export const MIN_CANDLES_ZZ = 24;

export type ProfileTaCandle = {
  time?: number;
  priceSol?: number;
  price?: number;
  volume?: number;
  high?: number;
  low?: number;
};

export type MacdCross = 'none' | 'bull' | 'bear';
export type HistSlope = 'rising' | 'flattening' | 'falling';
export type HistExpansion = 'expanding' | 'contracting' | 'steady';
export type ZigZagStructure = 'HH' | 'HL' | 'LH' | 'LL' | 'unknown';
export type DivergenceBias = 'bullish' | 'bearish' | 'none';

export interface MacdState {
  available: boolean;
  macd: number | null;
  signal: number | null;
  histogram: number | null;
  cross: MacdCross;
  histSlope: HistSlope;
  expansion: HistExpansion;
}

export interface BollingerState {
  available: boolean;
  mid: number | null;
  upper: number | null;
  lower: number | null;
  /** -1 below lower … 0 mid … +1 above upper */
  bandPos: number | null;
  squeeze: boolean;
  expansion: boolean;
  /** Soft prefer: price reclaiming mid from below or near lower band */
  bullishBias: boolean;
}

export interface ZigZagPivot {
  index: number;
  price: number;
  kind: 'high' | 'low';
  time: number;
}

export interface ZigZagState {
  available: boolean;
  pivots: ZigZagPivot[];
  structure: ZigZagStructure;
  intact: boolean;
  lastSwingHigh: number | null;
  lastSwingLow: number | null;
}

export interface DivergenceState {
  available: boolean;
  bias: DivergenceBias;
  detail: string;
}

export interface ProfileTaIndicatorReport {
  available: boolean;
  macd: MacdState;
  bollinger: BollingerState;
  zigzag: ZigZagState;
  rsiDivergence: DivergenceState;
  volumeDivergence: DivergenceState;
  summary: string;
}

function closes(candles: ProfileTaCandle[]): number[] {
  const out: number[] = [];
  for (const c of candles) {
    const p = Number(c.priceSol ?? c.price ?? 0);
    if (p > 0) out.push(p);
  }
  return out;
}

function volumes(candles: ProfileTaCandle[]): number[] {
  return candles.map((c) => {
    const v = Number(c.volume);
    return Number.isFinite(v) && v > 0 ? v : 0;
  });
}

function emaSeries(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < period - 1; i++) out.push(NaN);
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rsiSeries(values: number[], period = RSI_LEN): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (values.length < period + 1) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d >= 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss <= 1e-12 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss <= 1e-12 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function emptyMacd(): MacdState {
  return {
    available: false,
    macd: null,
    signal: null,
    histogram: null,
    cross: 'none',
    histSlope: 'flattening',
    expansion: 'steady',
  };
}

export function computeMacd(prices: number[]): MacdState {
  if (prices.length < MIN_CANDLES_MACD) return emptyMacd();
  const fast = emaSeries(prices, MACD_FAST);
  const slow = emaSeries(prices, MACD_SLOW);
  const macdLine: number[] = [];
  for (let i = 0; i < prices.length; i++) {
    if (!Number.isFinite(fast[i]) || !Number.isFinite(slow[i])) {
      macdLine.push(NaN);
    } else {
      macdLine.push(fast[i]! - slow[i]!);
    }
  }
  const validStart = macdLine.findIndex((v) => Number.isFinite(v));
  if (validStart < 0) return emptyMacd();
  const macdValid = macdLine.slice(validStart).filter((v) => Number.isFinite(v));
  if (macdValid.length < MACD_SIGNAL + 2) return emptyMacd();
  const signalValid = emaSeries(macdValid, MACD_SIGNAL);
  const n = macdValid.length;
  const macd = macdValid[n - 1]!;
  const signal = signalValid[n - 1]!;
  const prevMacd = macdValid[n - 2]!;
  const prevSignal = signalValid[n - 2]!;
  if (!Number.isFinite(macd) || !Number.isFinite(signal)) return emptyMacd();
  const hist = macd - signal;
  const prevHist = prevMacd - prevSignal;
  const hist2 =
    n >= 3 && Number.isFinite(macdValid[n - 3]) && Number.isFinite(signalValid[n - 3])
      ? macdValid[n - 3]! - signalValid[n - 3]!
      : prevHist;

  let cross: MacdCross = 'none';
  if (prevMacd <= prevSignal && macd > signal) cross = 'bull';
  else if (prevMacd >= prevSignal && macd < signal) cross = 'bear';

  const d1 = hist - prevHist;
  const d0 = prevHist - hist2;
  let histSlope: HistSlope = 'flattening';
  if (Math.abs(d1) < Math.abs(prevHist) * 0.05 + 1e-9) histSlope = 'flattening';
  else if (d1 > 0) histSlope = 'rising';
  else histSlope = 'falling';

  let expansion: HistExpansion = 'steady';
  const absH = Math.abs(hist);
  const absP = Math.abs(prevHist);
  if (absH > absP * 1.08) expansion = 'expanding';
  else if (absH < absP * 0.92) expansion = 'contracting';

  return {
    available: true,
    macd,
    signal,
    histogram: hist,
    cross,
    histSlope,
    expansion,
  };
}

function emptyBb(): BollingerState {
  return {
    available: false,
    mid: null,
    upper: null,
    lower: null,
    bandPos: null,
    squeeze: false,
    expansion: false,
    bullishBias: false,
  };
}

export function computeBollinger(prices: number[]): BollingerState {
  if (prices.length < MIN_CANDLES_BB) return emptyBb();
  const slice = prices.slice(-BB_PERIOD);
  const mid = slice.reduce((a, b) => a + b, 0) / BB_PERIOD;
  let varSum = 0;
  for (const p of slice) varSum += (p - mid) ** 2;
  const std = Math.sqrt(varSum / BB_PERIOD);
  const upper = mid + BB_STD * std;
  const lower = mid - BB_STD * std;
  const last = prices[prices.length - 1]!;
  const width = upper - lower;
  const bandPos =
    width > 1e-12 ? Math.max(-1, Math.min(1, (2 * (last - mid)) / width)) : 0;
  // Relative width vs prior window
  let squeeze = false;
  let expansion = false;
  if (prices.length >= BB_PERIOD * 2) {
    const prev = prices.slice(-BB_PERIOD * 2, -BB_PERIOD);
    const pMid = prev.reduce((a, b) => a + b, 0) / BB_PERIOD;
    let pVar = 0;
    for (const p of prev) pVar += (p - pMid) ** 2;
    const pStd = Math.sqrt(pVar / BB_PERIOD);
    const pWidth = 2 * BB_STD * pStd;
    if (pWidth > 1e-12) {
      squeeze = width < pWidth * 0.75;
      expansion = width > pWidth * 1.25;
    }
  }
  const prev = prices[prices.length - 2] ?? last;
  const bullishBias =
    last <= mid && last >= lower * 0.995
      ? true
      : last > mid && prev <= mid
        ? true
        : last <= lower * 1.01;
  return {
    available: true,
    mid,
    upper,
    lower,
    bandPos,
    squeeze,
    expansion,
    bullishBias,
  };
}

function emptyZz(): ZigZagState {
  return {
    available: false,
    pivots: [],
    structure: 'unknown',
    intact: false,
    lastSwingHigh: null,
    lastSwingLow: null,
  };
}

/**
 * Simple % ZigZag on closes — confirmed pivots only (not last unfinished leg).
 */
export function computeZigZag(
  prices: number[],
  times: number[],
  minPct = ZIGZAG_MIN_PCT
): ZigZagState {
  if (prices.length < MIN_CANDLES_ZZ) return emptyZz();
  const pivots: ZigZagPivot[] = [];
  let dir: 'up' | 'down' | null = null;
  let extreme = prices[0]!;
  let extremeIdx = 0;

  for (let i = 1; i < prices.length; i++) {
    const p = prices[i]!;
    if (dir == null) {
      const chg = ((p - extreme) / extreme) * 100;
      if (chg >= minPct) {
        dir = 'up';
        pivots.push({
          index: extremeIdx,
          price: extreme,
          kind: 'low',
          time: times[extremeIdx] || 0,
        });
        extreme = p;
        extremeIdx = i;
      } else if (chg <= -minPct) {
        dir = 'down';
        pivots.push({
          index: extremeIdx,
          price: extreme,
          kind: 'high',
          time: times[extremeIdx] || 0,
        });
        extreme = p;
        extremeIdx = i;
      }
      continue;
    }
    if (dir === 'up') {
      if (p >= extreme) {
        extreme = p;
        extremeIdx = i;
      } else {
        const pull = ((extreme - p) / extreme) * 100;
        if (pull >= minPct) {
          pivots.push({
            index: extremeIdx,
            price: extreme,
            kind: 'high',
            time: times[extremeIdx] || 0,
          });
          dir = 'down';
          extreme = p;
          extremeIdx = i;
        }
      }
    } else {
      if (p <= extreme) {
        extreme = p;
        extremeIdx = i;
      } else {
        const bounce = ((p - extreme) / extreme) * 100;
        if (bounce >= minPct) {
          pivots.push({
            index: extremeIdx,
            price: extreme,
            kind: 'low',
            time: times[extremeIdx] || 0,
          });
          dir = 'up';
          extreme = p;
          extremeIdx = i;
        }
      }
    }
  }

  if (pivots.length < 3) {
    return {
      available: pivots.length > 0,
      pivots,
      structure: 'unknown',
      intact: false,
      lastSwingHigh: pivots.filter((x) => x.kind === 'high').at(-1)?.price ?? null,
      lastSwingLow: pivots.filter((x) => x.kind === 'low').at(-1)?.price ?? null,
    };
  }

  const highs = pivots.filter((p) => p.kind === 'high');
  const lows = pivots.filter((p) => p.kind === 'low');
  let structure: ZigZagStructure = 'unknown';
  if (highs.length >= 2 && lows.length >= 1) {
    const h1 = highs[highs.length - 2]!;
    const h2 = highs[highs.length - 1]!;
    const lLast = lows[lows.length - 1]!;
    if (h2.price > h1.price && lLast.price >= (lows[lows.length - 2]?.price ?? lLast.price)) {
      structure = h2.index > lLast.index ? 'HH' : 'HL';
    } else if (h2.price < h1.price) {
      structure = 'LH';
    }
  }
  if (lows.length >= 2) {
    const l1 = lows[lows.length - 2]!;
    const l2 = lows[lows.length - 1]!;
    if (l2.price < l1.price && structure !== 'HH' && structure !== 'HL') {
      structure = 'LL';
    } else if (l2.price > l1.price && structure === 'unknown') {
      structure = 'HL';
    }
  }

  const intact = structure === 'HH' || structure === 'HL';
  return {
    available: true,
    pivots,
    structure,
    intact,
    lastSwingHigh: highs.at(-1)?.price ?? null,
    lastSwingLow: lows.at(-1)?.price ?? null,
  };
}

function emptyDiv(): DivergenceState {
  return { available: false, bias: 'none', detail: 'insufficient pivots' };
}

export function computeRsiDivergence(
  prices: number[],
  pivots: ZigZagPivot[]
): DivergenceState {
  if (prices.length < RSI_LEN + 10 || pivots.length < 4) return emptyDiv();
  const rsi = rsiSeries(prices, RSI_LEN);
  const lows = pivots.filter((p) => p.kind === 'low');
  const highs = pivots.filter((p) => p.kind === 'high');

  if (lows.length >= 2) {
    const a = lows[lows.length - 2]!;
    const b = lows[lows.length - 1]!;
    const ra = rsi[a.index];
    const rb = rsi[b.index];
    if (
      Number.isFinite(ra) &&
      Number.isFinite(rb) &&
      b.price < a.price &&
      (rb as number) > (ra as number)
    ) {
      return {
        available: true,
        bias: 'bullish',
        detail: `RSI bullish div LL price / HL RSI (${(ra as number).toFixed(0)}→${(rb as number).toFixed(0)})`,
      };
    }
  }
  if (highs.length >= 2) {
    const a = highs[highs.length - 2]!;
    const b = highs[highs.length - 1]!;
    const ra = rsi[a.index];
    const rb = rsi[b.index];
    if (
      Number.isFinite(ra) &&
      Number.isFinite(rb) &&
      b.price > a.price &&
      (rb as number) < (ra as number)
    ) {
      return {
        available: true,
        bias: 'bearish',
        detail: `RSI bearish div HH price / LH RSI (${(ra as number).toFixed(0)}→${(rb as number).toFixed(0)})`,
      };
    }
  }
  return { available: true, bias: 'none', detail: 'no RSI divergence' };
}

export function computeVolumeDivergence(
  prices: number[],
  vols: number[],
  pivots: ZigZagPivot[]
): DivergenceState {
  if (prices.length < 20 || pivots.length < 4) return emptyDiv();
  const lows = pivots.filter((p) => p.kind === 'low');
  const highs = pivots.filter((p) => p.kind === 'high');

  const volAt = (idx: number) => {
    const w = vols.slice(Math.max(0, idx - 2), idx + 1);
    const sum = w.reduce((a, b) => a + b, 0);
    return sum / Math.max(1, w.length);
  };

  if (lows.length >= 2) {
    const a = lows[lows.length - 2]!;
    const b = lows[lows.length - 1]!;
    const va = volAt(a.index);
    const vb = volAt(b.index);
    if (b.price < a.price && vb < va * 0.85 && va > 0) {
      return {
        available: true,
        bias: 'bullish',
        detail: 'volume bullish div (lower low on lighter volume)',
      };
    }
  }
  if (highs.length >= 2) {
    const a = highs[highs.length - 2]!;
    const b = highs[highs.length - 1]!;
    const va = volAt(a.index);
    const vb = volAt(b.index);
    if (b.price > a.price && vb < va * 0.85 && va > 0) {
      return {
        available: true,
        bias: 'bearish',
        detail: 'volume bearish div (higher high on lighter volume)',
      };
    }
  }

  // Relative volume trend
  const recent = vols.slice(-8);
  const prior = vols.slice(-16, -8);
  const rAvg = recent.reduce((a, b) => a + b, 0) / Math.max(1, recent.length);
  const pAvg = prior.reduce((a, b) => a + b, 0) / Math.max(1, prior.length);
  if (pAvg > 0 && rAvg > pAvg * 1.25) {
    return {
      available: true,
      bias: 'none',
      detail: 'relative volume rising',
    };
  }
  return { available: true, bias: 'none', detail: 'no volume divergence' };
}

/**
 * Full Profile TA indicator pack from OHLC-ish candles.
 */
export function evaluateProfileTaIndicators(
  candles: ProfileTaCandle[] | null | undefined
): ProfileTaIndicatorReport {
  const empty: ProfileTaIndicatorReport = {
    available: false,
    macd: emptyMacd(),
    bollinger: emptyBb(),
    zigzag: emptyZz(),
    rsiDivergence: emptyDiv(),
    volumeDivergence: emptyDiv(),
    summary: 'TA indicators unavailable',
  };
  if (!candles || candles.length < 20) return empty;

  const prices = closes(candles);
  if (prices.length < 20) return empty;
  const times = candles.map((c) => Number(c.time) || 0);
  const vols = volumes(candles);

  const macd = computeMacd(prices);
  const bollinger = computeBollinger(prices);
  const zigzag = computeZigZag(prices, times);
  const rsiDivergence = computeRsiDivergence(prices, zigzag.pivots);
  const volumeDivergence = computeVolumeDivergence(prices, vols, zigzag.pivots);

  const bits: string[] = [];
  if (macd.available) {
    bits.push(
      `MACD ${macd.cross !== 'none' ? macd.cross : 'flat'} hist ${macd.histSlope}`
    );
  }
  if (zigzag.available) bits.push(`ZZ ${zigzag.structure}${zigzag.intact ? ' intact' : ''}`);
  if (rsiDivergence.bias !== 'none') bits.push(`RSI ${rsiDivergence.bias} div`);
  if (volumeDivergence.bias !== 'none') bits.push(`Vol ${volumeDivergence.bias} div`);
  if (bollinger.available && bollinger.bullishBias) bits.push('BB soft-bull');

  return {
    available: macd.available || bollinger.available || zigzag.available,
    macd,
    bollinger,
    zigzag,
    rsiDivergence,
    volumeDivergence,
    summary: bits.length ? bits.join(' · ') : 'TA indicators quiet',
  };
}
