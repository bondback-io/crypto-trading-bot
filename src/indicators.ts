/**
 * Classic technical indicators (RSI, EMA cross, momentum / ATR-style).
 * Feeds Market Scanner ranking and signal conviction.
 */

export interface IndicatorCandle {
  time: number;
  priceSol?: number;
  price?: number;
  volume?: number;
  high?: number;
  low?: number;
}

export interface IndicatorInput {
  mint?: string | null;
  candles?: IndicatorCandle[] | null;
  priceSol?: number | null;
}

export interface IndicatorReport {
  available: boolean;
  rsi14: number | null;
  emaFast: number | null;
  emaSlow: number | null;
  emaBullishCross: boolean;
  momentumPct: number | null;
  atrPct: number | null;
  vwap: number | null;
  vwapBias: 'above_vwap' | 'below_vwap' | null;
  setup: boolean;
  scoreDelta: number;
  flags: string[];
  summary: string;
}

function pricesFromCandles(candles: IndicatorCandle[]): number[] {
  const out: number[] = [];
  for (const c of candles) {
    const p = Number(c.priceSol ?? c.price ?? 0);
    if (p > 0) out.push(p);
  }
  return out;
}

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
  }
  return prev;
}

/** Wilder's RSI (smoothed average gain/loss). */
function rsiWilder(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d >= 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss <= 1e-12) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * True ATR% when high/low present; else close-to-close range %.
 */
function atrPctFromCandles(
  candles: IndicatorCandle[],
  prices: number[],
  period = 10
): number | null {
  if (prices.length < period + 1) return null;
  const hasHl = candles.some(
    (c) =>
      c.high != null &&
      c.low != null &&
      Number(c.high) > 0 &&
      Number(c.low) > 0
  );
  if (hasHl && candles.length >= period + 1) {
    const trs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i]!;
      const prev = candles[i - 1]!;
      const close = Number(c.priceSol ?? c.price ?? 0);
      const prevClose = Number(prev.priceSol ?? prev.price ?? 0);
      const high = Number(c.high ?? close);
      const low = Number(c.low ?? close);
      if (!(close > 0) || !(prevClose > 0)) continue;
      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trs.push(tr / prevClose);
    }
    if (trs.length < period) return null;
    const slice = trs.slice(-period);
    return (slice.reduce((a, b) => a + b, 0) / slice.length) * 100;
  }
  let sum = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    sum += Math.abs(prices[i]! - prices[i - 1]!) / prices[i - 1]!;
  }
  return (sum / period) * 100;
}

/** Session VWAP from candles that carry volume. */
function computeVwap(
  candles: IndicatorCandle[],
  lastPrice: number
): { vwap: number | null; bias: 'above_vwap' | 'below_vwap' | null } {
  let pv = 0;
  let vol = 0;
  for (const c of candles) {
    const p = Number(c.priceSol ?? c.price ?? 0);
    const v = Number(c.volume ?? 0);
    if (!(p > 0) || !(v > 0)) continue;
    pv += p * v;
    vol += v;
  }
  if (!(vol > 0)) return { vwap: null, bias: null };
  const vwap = pv / vol;
  if (!(vwap > 0) || !(lastPrice > 0)) return { vwap, bias: null };
  const bias =
    lastPrice >= vwap * 0.998 ? ('above_vwap' as const) : ('below_vwap' as const);
  return { vwap, bias };
}

/**
 * Evaluate RSI / EMA / momentum for a mint path.
 * Fail-open (available=false) when history is too thin.
 */
export function evaluateIndicators(input: IndicatorInput): IndicatorReport {
  const empty: IndicatorReport = {
    available: false,
    rsi14: null,
    emaFast: null,
    emaSlow: null,
    emaBullishCross: false,
    momentumPct: null,
    atrPct: null,
    vwap: null,
    vwapBias: null,
    setup: false,
    scoreDelta: 0,
    flags: [],
    summary: 'indicators: insufficient history',
  };

  const candles = input.candles ?? [];
  const prices = pricesFromCandles(candles);
  if (input.priceSol != null && input.priceSol > 0) {
    const last = prices[prices.length - 1];
    if (last == null || Math.abs(last - input.priceSol) / last > 0.002) {
      prices.push(input.priceSol);
    }
  }
  if (prices.length < 16) return empty;

  const rsi14 = rsiWilder(prices, 14);
  const emaFast = ema(prices, 8);
  const emaSlow = ema(prices, 21);
  const look = Math.min(12, prices.length - 1);
  const momentumPct =
    look > 0
      ? ((prices[prices.length - 1]! - prices[prices.length - 1 - look]!) /
          prices[prices.length - 1 - look]!) *
        100
      : null;
  const atr = atrPctFromCandles(candles, prices, 10);
  const lastPx = prices[prices.length - 1]!;
  const { vwap, bias: vwapBias } = computeVwap(candles, lastPx);

  const flags: string[] = [];
  let scoreDelta = 0;
  let setup = false;

  const emaBullishCross =
    emaFast != null &&
    emaSlow != null &&
    emaFast > emaSlow &&
    prices[prices.length - 1]! >= emaFast * 0.998;

  if (rsi14 != null) {
    if (rsi14 >= 35 && rsi14 <= 55) {
      flags.push('rsi_reset');
      scoreDelta += 6;
      setup = true;
    } else if (rsi14 < 32) {
      flags.push('rsi_oversold');
      scoreDelta += 8;
      setup = true;
    } else if (rsi14 > 72) {
      flags.push('rsi_overbought');
      scoreDelta -= 6;
    }
  }

  if (emaBullishCross) {
    flags.push('ema_bull');
    scoreDelta += 7;
    setup = true;
  } else if (emaFast != null && emaSlow != null && emaFast < emaSlow * 0.99) {
    flags.push('ema_bear');
    scoreDelta -= 3;
  }

  if (momentumPct != null) {
    if (momentumPct >= 8 && momentumPct <= 45) {
      flags.push('mom_up');
      scoreDelta += 5;
      setup = true;
    } else if (momentumPct <= -12 && momentumPct >= -40) {
      flags.push('mom_dip');
      scoreDelta += 6;
      setup = true;
    } else if (momentumPct > 80) {
      flags.push('mom_extended');
      scoreDelta -= 5;
    }
  }

  if (atr != null) {
    if (atr >= 1.5 && atr <= 8) {
      flags.push('vol_ok');
      scoreDelta += 2;
    } else if (atr > 14) {
      flags.push('vol_wild');
      scoreDelta -= 4;
    }
  }

  if (vwapBias === 'above_vwap') {
    flags.push('above_vwap');
    scoreDelta += 3;
    setup = true;
  } else if (vwapBias === 'below_vwap') {
    flags.push('below_vwap');
    scoreDelta -= 1;
  }

  const summaryParts = [
    rsi14 != null ? `RSI ${rsi14.toFixed(0)}` : null,
    emaBullishCross
      ? 'EMA↑'
      : emaFast != null && emaSlow != null && emaFast < emaSlow
        ? 'EMA↓'
        : null,
    momentumPct != null ? `mom ${momentumPct.toFixed(0)}%` : null,
    vwapBias,
  ].filter(Boolean);

  return {
    available: true,
    rsi14,
    emaFast,
    emaSlow,
    emaBullishCross,
    momentumPct,
    atrPct: atr,
    vwap,
    vwapBias,
    setup,
    scoreDelta: Math.max(-15, Math.min(20, scoreDelta)),
    flags,
    summary: summaryParts.length
      ? `ind: ${summaryParts.join(' · ')}`
      : 'indicators: neutral',
  };
}

/** Conviction soft boost from indicators (scanner + copy). */
export function resolveIndicatorsForSignal(input: IndicatorInput): {
  convictionDelta: number;
  skip: boolean;
  skipReason?: string;
  report: IndicatorReport;
  logLine: string;
} {
  const report = evaluateIndicators(input);
  if (!report.available) {
    return {
      convictionDelta: 0,
      skip: false,
      report,
      logLine: 'indicators: no data (fail-open)',
    };
  }
  return {
    convictionDelta: report.scoreDelta,
    skip: false,
    report,
    logLine: report.summary,
  };
}
