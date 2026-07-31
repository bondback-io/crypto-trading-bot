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
