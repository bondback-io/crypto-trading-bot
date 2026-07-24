/**
 * Compatibility façade — delegates to technicalLevels.ts.
 * Existing imports of evaluateBasicTechnicals / prefersTechnicalEntry keep working.
 */

import {
  analyzeTechnicals,
  KEY_FIB_RATIOS,
  FIB_RATIOS,
  fibPriceFromHigh,
  findSwingPivots,
  isNearFibLevel,
  isNearFibZone,
  getFibZones,
  getNearestSupport,
  getNearestResistance,
  getTechnicalLevelsForStrategy,
  type FibLevel as TLFibLevel,
  type TechnicalSnapshot,
  type TechnicalAnalyzeInput,
  type PricePoint,
} from './technicalLevels';

export const FIB_LEVELS = FIB_RATIOS;
export type FibRatio = (typeof FIB_RATIOS)[number];
export type { PricePoint };
export {
  findSwingPivots,
  KEY_FIB_RATIOS,
  isNearFibLevel,
  isNearFibZone,
  getFibZones,
  getNearestSupport,
  getNearestResistance,
  getTechnicalLevelsForStrategy,
};

export function fibPrice(high: number, low: number, ratio: number): number {
  return fibPriceFromHigh(high, low, ratio);
}

export interface TechnicalRange {
  swingHigh: number;
  swingLow: number;
  price: number;
  dropFromHighPct: number;
  runPct: number;
  source: 'candles' | 'proxy' | 'history';
}

export interface FibLevel {
  ratio: FibRatio;
  price: number;
  zoneLow?: number;
  zoneHigh?: number;
  distancePct: number;
  near: boolean;
}

export interface TechnicalReport {
  range: TechnicalRange | null;
  support: number | null;
  fibs: FibLevel[];
  nearestKeyFib: FibLevel | null;
  nearSupport: boolean;
  nearKeyFib: boolean;
  snapshot?: TechnicalSnapshot;
  detail: string;
}

export type TechnicalSignalInput = TechnicalAnalyzeInput;

export function detectSwingLow(points: PricePoint[], lookback = 8): number | null {
  const slice = points.slice(-Math.max(3, lookback));
  if (!slice.length) return null;
  let low = slice[0]!.price;
  for (const p of slice) if (p.price < low) low = p.price;
  return low > 0 ? low : null;
}

export function detectSwingHigh(
  points: PricePoint[],
  lookback = 24
): number | null {
  const slice = points.slice(-Math.max(3, lookback));
  if (!slice.length) return null;
  let high = slice[0]!.price;
  for (const p of slice) if (p.price > high) high = p.price;
  return high > 0 ? high : null;
}

export function evaluateBasicTechnicals(
  input: TechnicalSignalInput
): TechnicalReport {
  const snap = analyzeTechnicals(input);
  if (snap.source === 'none' || snap.price == null) {
    return {
      range: null,
      support: null,
      fibs: [],
      nearestKeyFib: null,
      nearSupport: false,
      nearKeyFib: false,
      snapshot: snap,
      detail: snap.detail,
    };
  }
  const fib = snap.fib;
  const range: TechnicalRange | null = fib
    ? {
        swingHigh: fib.swingHigh,
        swingLow: fib.swingLow,
        price: snap.price,
        dropFromHighPct: ((fib.swingHigh - snap.price) / fib.swingHigh) * 100,
        runPct: fib.impulseRunPct,
        source:
          snap.source === 'history'
            ? 'history'
            : snap.source === 'candles'
              ? 'candles'
              : 'proxy',
      }
    : null;

  const fibs: FibLevel[] = (fib?.levels ?? []).map((l: TLFibLevel) => ({
    ratio: l.ratio,
    price: l.price,
    zoneLow: l.zoneLow,
    zoneHigh: l.zoneHigh,
    distancePct: l.distancePct,
    near: l.near,
  }));
  const nearestKeyFib =
    fib?.nearestKey != null
      ? {
          ratio: fib.nearestKey.ratio,
          price: fib.nearestKey.price,
          zoneLow: fib.nearestKey.zoneLow,
          zoneHigh: fib.nearestKey.zoneHigh,
          distancePct: fib.nearestKey.distancePct,
          near: fib.nearestKey.near,
        }
      : null;

  return {
    range,
    support: snap.nearestSupport?.mid ?? null,
    fibs,
    nearestKeyFib,
    nearSupport: snap.nearSupport,
    nearKeyFib: snap.nearKeyFib,
    snapshot: snap,
    detail: snap.detail,
  };
}

export function prefersTechnicalEntry(
  report: TechnicalReport,
  requireNear: boolean
): { ok: boolean; reason: string } {
  if (!report.range && report.snapshot?.source === 'none') {
    return { ok: !requireNear, reason: 'technicals unavailable (fail-open)' };
  }
  if (report.nearKeyFib || report.nearSupport) {
    const where = report.nearKeyFib
      ? `Fib ${report.nearestKeyFib?.ratio}`
      : 'swing support zone';
    return { ok: true, reason: `near ${where}` };
  }
  if (!requireNear) {
    return { ok: true, reason: 'technicals prefer soft (not near level)' };
  }
  return {
    ok: false,
    reason: `not near support/Fib (nearest ${
      report.nearestKeyFib
        ? `${report.nearestKeyFib.ratio} @ ${report.nearestKeyFib.distancePct.toFixed(1)}%`
        : 'n/a'
    })`,
  };
}
