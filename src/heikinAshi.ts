/**
 * Heikin-Ashi helpers for Trend Rider / Steady Compounder / High Win-Rate.
 * Soft entry prefer (green HA) + trend exit on confirmed red flip.
 * Fail-open when candle history is thin.
 */

export interface HaCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Raw close used as source (priceSol) */
  sourceClose: number;
}

const MIN_CANDLES = 10;
/** Soft conviction boost when latest HA is bullish */
export const HA_ENTRY_BOOST_DELTA = 4;

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Build OHLC from MarketCandle-like rows. When high/low missing, approximate
 * with close-only (O=H=L=C = priceSol).
 */
export function toOhlc(c: {
  time?: number;
  priceSol?: number;
  price?: number;
  high?: number;
  low?: number;
}): { time: number; open: number; high: number; low: number; close: number } | null {
  const close = num(c.priceSol) ?? num(c.price);
  if (close == null) return null;
  const high = num(c.high) ?? close;
  const low = num(c.low) ?? close;
  // No explicit open on MarketCandle — use close as open when approximating
  const open = close;
  const hi = Math.max(high, open, close);
  const lo = Math.min(low, open, close);
  return { time: Number(c.time) || 0, open, high: hi, low: lo, close };
}

export type HaCandleInput = {
  time?: number;
  priceSol?: number;
  price?: number;
  high?: number;
  low?: number;
  volume?: number;
};

/** Standard Heikin-Ashi conversion (oldest → newest). */
export function toHeikinAshi(candles: HaCandleInput[]): HaCandle[] {
  const ohlc: Array<{
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
  }> = [];
  for (const c of candles) {
    const row = toOhlc(c);
    if (row) ohlc.push(row);
  }
  if (ohlc.length === 0) return [];

  const out: HaCandle[] = [];
  for (let i = 0; i < ohlc.length; i++) {
    const cur = ohlc[i]!;
    const haClose = (cur.open + cur.high + cur.low + cur.close) / 4;
    let haOpen: number;
    if (i === 0) {
      haOpen = (cur.open + cur.close) / 2;
    } else {
      const prev = out[i - 1]!;
      haOpen = (prev.open + prev.close) / 2;
    }
    const haHigh = Math.max(cur.high, haOpen, haClose);
    const haLow = Math.min(cur.low, haOpen, haClose);
    out.push({
      time: cur.time,
      open: haOpen,
      high: haHigh,
      low: haLow,
      close: haClose,
      sourceClose: cur.close,
    });
  }
  return out;
}

export function isHaBullish(c: HaCandle): boolean {
  return c.close >= c.open;
}

export function isHaBearish(c: HaCandle): boolean {
  return c.close < c.open;
}

/** Prior candle green → current red. */
export function haFlipToBearish(series: HaCandle[]): boolean {
  if (series.length < 2) return false;
  const prev = series[series.length - 2]!;
  const cur = series[series.length - 1]!;
  return isHaBullish(prev) && isHaBearish(cur);
}

/** Prior candle red → current green. */
export function haFlipToBullish(series: HaCandle[]): boolean {
  if (series.length < 2) return false;
  const prev = series[series.length - 2]!;
  const cur = series[series.length - 1]!;
  return isHaBearish(prev) && isHaBullish(cur);
}

export type HaBias = 'bullish' | 'bearish' | 'neutral';
export type HaMomentum = 'strengthening' | 'weakening' | 'steady';
export type HaFlip = 'none' | 'to_bull' | 'to_bear';

export interface HaState {
  available: boolean;
  bias: HaBias;
  momentum: HaMomentum;
  flip: HaFlip;
  consecutiveBull: number;
  consecutiveBear: number;
  /** Body size vs prior body — crude strength proxy */
  bodyStrengthPct: number | null;
}

function countConsecutive(
  series: HaCandle[],
  pred: (c: HaCandle) => boolean
): number {
  let n = 0;
  for (let i = series.length - 1; i >= 0; i--) {
    if (!pred(series[i]!)) break;
    n++;
  }
  return n;
}

/**
 * Rich HA state for Profile TA Playbooks.
 * Fail-open: available=false when history is thin.
 */
export function evaluateHaState(
  candles: HaCandleInput[] | null | undefined,
  minCandles = MIN_CANDLES
): HaState {
  const empty: HaState = {
    available: false,
    bias: 'neutral',
    momentum: 'steady',
    flip: 'none',
    consecutiveBull: 0,
    consecutiveBear: 0,
    bodyStrengthPct: null,
  };
  if (!candles || candles.length < minCandles) return empty;
  const series = toHeikinAshi(candles);
  if (series.length < minCandles) return empty;

  const last = series[series.length - 1]!;
  const consecutiveBull = countConsecutive(series, isHaBullish);
  const consecutiveBear = countConsecutive(series, isHaBearish);

  let bias: HaBias = 'neutral';
  if (isHaBullish(last) && consecutiveBull >= 1) bias = 'bullish';
  else if (isHaBearish(last) && consecutiveBear >= 1) bias = 'bearish';

  let flip: HaFlip = 'none';
  if (haFlipToBearish(series)) flip = 'to_bear';
  else if (haFlipToBullish(series)) flip = 'to_bull';

  let momentum: HaMomentum = 'steady';
  let bodyStrengthPct: number | null = null;
  if (series.length >= 2) {
    const prev = series[series.length - 2]!;
    const body = Math.abs(last.close - last.open);
    const prevBody = Math.abs(prev.close - prev.open);
    const mid = (last.open + last.close) / 2 || last.close;
    if (mid > 0) bodyStrengthPct = (body / mid) * 100;
    if (prevBody > 1e-12) {
      const ratio = body / prevBody;
      if (bias === 'bullish') {
        momentum = ratio >= 1.05 ? 'strengthening' : ratio <= 0.85 ? 'weakening' : 'steady';
      } else if (bias === 'bearish') {
        momentum = ratio >= 1.05 ? 'strengthening' : ratio <= 0.85 ? 'weakening' : 'steady';
      } else {
        momentum = 'steady';
      }
    }
  }

  return {
    available: true,
    bias,
    momentum,
    flip,
    consecutiveBull,
    consecutiveBear,
    bodyStrengthPct,
  };
}

export interface HaEntryBoostResult {
  ok: boolean;
  flags: string[];
  delta: number;
}

/**
 * Soft prefer: small conviction boost when latest HA is green.
 * Fail-open (ok=false, delta=0) when history is thin.
 */
export function evaluateHaEntryBoost(
  candles: HaCandleInput[] | null | undefined
): HaEntryBoostResult {
  if (!candles || candles.length < MIN_CANDLES) {
    return { ok: false, flags: [], delta: 0 };
  }
  const series = toHeikinAshi(candles);
  if (series.length < MIN_CANDLES) {
    return { ok: false, flags: [], delta: 0 };
  }
  const last = series[series.length - 1]!;
  if (!isHaBullish(last)) {
    return { ok: false, flags: ['ha_bearish'], delta: 0 };
  }
  return {
    ok: true,
    flags: ['heikin_ashi'],
    delta: HA_ENTRY_BOOST_DELTA,
  };
}

/**
 * Exit on first confirmed HA red after ≥2 prior consecutive green HA candles.
 * Returns reason `'Heikin-Ashi red flip'` or null (fail-open).
 */
export function evaluateHaTrendExit(
  candles: HaCandleInput[] | null | undefined
): string | null {
  if (!candles || candles.length < MIN_CANDLES) return null;
  const series = toHeikinAshi(candles);
  if (series.length < MIN_CANDLES) return null;

  const n = series.length;
  const cur = series[n - 1]!;
  if (!isHaBearish(cur)) return null;

  // Need ≥2 prior consecutive greens immediately before current red
  if (n < 3) return null;
  const p1 = series[n - 2]!;
  const p2 = series[n - 3]!;
  if (!isHaBullish(p1) || !isHaBullish(p2)) return null;

  // Confirmed flip: prior green → current red (redundant with above but explicit)
  if (!haFlipToBearish(series)) return null;

  return 'Heikin-Ashi red flip';
}
