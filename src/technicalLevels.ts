/**
 * Fibonacci + Support/Resistance technical analysis.
 *
 * Clean API for other strategies:
 *  - getFibLevels(mint)
 *  - getNearestSupport(mint) / getNearestResistance(mint)
 *  - isNearFibLevel(price, level)
 *  - getTechnicalSnapshot(mint) / analyzeTechnicals(input)
 *
 * Efficient in-memory ring buffers per mint; candle/proxy fallbacks when
 * history is thin. Fail-open when data is insufficient.
 */

import { config } from './config';
import { isStrategyEnabled, logStrategyDecision } from './strategies';

export const FIB_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.786] as const;
export type FibRatio = (typeof FIB_RATIOS)[number];

/** Primary dip-buy Fibs (Pump.fun default) */
export const KEY_FIB_RATIOS: readonly FibRatio[] = [0.5, 0.618];
/** Secondary Fibs */
export const SECONDARY_FIB_RATIOS: readonly FibRatio[] = [0.382, 0.786];

export interface PricePoint {
  time: number;
  price: number;
  /** Optional USD (or relative) volume at this tick/candle */
  volume?: number;
}

export interface SrZone {
  kind: 'support' | 'resistance';
  /** Zone midpoint */
  mid: number;
  low: number;
  high: number;
  /** How many swing touches clustered into this zone */
  touches: number;
  /** 0–100 strength (touches + recency + reaction) */
  strength: number;
  distancePct: number;
  near: boolean;
  /** Last touch timestamp (ms) */
  lastTouchMs: number;
  /** Bounce / volume reaction score 0–100 */
  volumeReaction: number;
  /** Cleared by break + close beyond the zone */
  invalidated: boolean;
}

export interface FibLevel {
  ratio: FibRatio;
  /** Mid / exact Fib price */
  price: number;
  /** Zone band when treating Fib as zones (Pump.fun default) */
  zoneLow: number;
  zoneHigh: number;
  distancePct: number;
  near: boolean;
  /** True for primary key Fibs */
  key: boolean;
  prioritized: boolean;
}

export interface FibLadder {
  swingHigh: number;
  swingLow: number;
  /** Impulse that defined the ladder */
  direction: 'up_impulse' | 'down_impulse';
  impulseRunPct: number;
  levels: FibLevel[];
  nearestKey: FibLevel | null;
}

export interface TechnicalSnapshot {
  mint: string | null;
  price: number | null;
  supportZones: SrZone[];
  resistanceZones: SrZone[];
  nearestSupport: SrZone | null;
  nearestResistance: SrZone | null;
  fib: FibLadder | null;
  nearSupport: boolean;
  nearKeyFib: boolean;
  nearStrongSupport: boolean;
  source: 'history' | 'candles' | 'proxy' | 'none';
  lookbackUsed: number;
  detail: string;
  /** Compact line for dashboards */
  summary: string;
}

export interface TechnicalAnalyzeInput {
  mint?: string | null;
  priceUsd?: number | null;
  priceSol?: number | null;
  priceChangeH1Pct?: number | null;
  priceChange24hPct?: number | null;
  dropFromPeakPct?: number | null;
  candles?: Array<{
    time: number;
    priceSol?: number;
    price?: number;
    volume?: number;
  }>;
  nowMs?: number;
  /** Override config near % */
  nearPct?: number;
  lookback?: number;
}

export type TechnicalSensitivity = 'low' | 'medium' | 'high';
export type SwingStrength = 'low' | 'medium' | 'high';

const DEFAULTS = {
  lookbackHours: 4,
  lookbackHoursMin: 2,
  lookbackHoursMax: 6,
  lookbackBars: 96,
  pivotWindow: 2,
  clusterPct: 2,
  zoneWidthPct: 2,
  nearPct: 2,
  minImpulsePct: 50,
  preferRecentImpulse: true,
  minTouchesForValid: 2,
  minTouchesForStrong: 2,
  maxHistoryPoints: 240,
  prioritizeFibLevels: [0.5, 0.618] as FibRatio[],
  secondaryFibLevels: [0.382, 0.786] as FibRatio[],
  srLookbackHours: 2,
  srLookbackHoursMin: 1,
  srLookbackHoursMax: 4,
  srLookbackHoursHardMax: 6,
  swingStrength: 'medium' as SwingStrength,
  preferRecentSupport: true,
  favourVolumeReaction: true,
  requireBreakCloseInvalidation: true,
  fibTreatAsZones: true,
  srConfluenceMinHits: 2,
  srConfluenceRequireHigherTf: true,
};

/** Per-mint ring buffer (SOL or USD — consistent per mint). */
const priceHistory = new Map<string, PricePoint[]>();
/** Short-lived analysis cache */
const snapshotCache = new Map<
  string,
  { at: number; snap: TechnicalSnapshot }
>();
const CACHE_TTL_MS = 4_000;

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function pctDist(a: number, b: number): number {
  if (!(b > 0)) return Infinity;
  return (Math.abs(a - b) / b) * 100;
}

function parseFibList(
  raw: unknown,
  fallback: FibRatio[]
): FibRatio[] {
  if (!Array.isArray(raw)) return [...fallback];
  const out = raw
    .map(Number)
    .filter((r): r is FibRatio =>
      (FIB_RATIOS as readonly number[]).includes(r)
    );
  return out.length ? out : [...fallback];
}

function cfg() {
  const t = config.technicalLevels;
  const lookbackBars = Number(t?.lookbackBars);
  const lookbackHours = Number(t?.lookbackHours);
  const hoursMin = Number(t?.lookbackHoursMin);
  const hoursMax = Number(t?.lookbackHoursMax);
  const pivot = Number(t?.pivotWindow);
  const cluster = Number(t?.clusterPct);
  const zoneW = Number(t?.zoneWidthPct);
  const near = Number(t?.nearPct);
  const minImpulse = Number(t?.minImpulsePct);
  const minTouchesValid = Number(t?.minTouchesForValid);
  const minTouches = Number(t?.minTouchesForStrong);
  const maxPts = Number(t?.maxHistoryPoints);
  const srHours = Number(t?.srLookbackHours);
  const srMin = Number(t?.srLookbackHoursMin);
  const srMax = Number(t?.srLookbackHoursMax);
  const srHard = Number(t?.srLookbackHoursHardMax);
  const sens: TechnicalSensitivity =
    t?.sensitivity === 'low' || t?.sensitivity === 'high'
      ? t.sensitivity
      : 'medium';
  const swingStrength: SwingStrength =
    t?.swingStrength === 'low' || t?.swingStrength === 'high'
      ? t.swingStrength
      : 'medium';
  // Keep ±2% base; sensitivity only nudges slightly
  const nearScale = sens === 'low' ? 1.25 : sens === 'high' ? 0.85 : 1;
  const hMin =
    Number.isFinite(hoursMin) && hoursMin >= 0.5
      ? Math.min(24, hoursMin)
      : DEFAULTS.lookbackHoursMin;
  const hMax =
    Number.isFinite(hoursMax) && hoursMax >= hMin
      ? Math.min(48, hoursMax)
      : DEFAULTS.lookbackHoursMax;
  let hours =
    Number.isFinite(lookbackHours) && lookbackHours > 0
      ? lookbackHours
      : DEFAULTS.lookbackHours;
  hours = Math.max(hMin, Math.min(hMax, hours));

  const hardMax =
    Number.isFinite(srHard) && srHard >= 1
      ? Math.min(24, srHard)
      : DEFAULTS.srLookbackHoursHardMax;
  const srHMin =
    Number.isFinite(srMin) && srMin >= 0.5
      ? Math.min(hardMax, srMin)
      : DEFAULTS.srLookbackHoursMin;
  const srHMax =
    Number.isFinite(srMax) && srMax >= srHMin
      ? Math.min(hardMax, srMax)
      : Math.min(hardMax, DEFAULTS.srLookbackHoursMax);
  let srH =
    Number.isFinite(srHours) && srHours > 0
      ? srHours
      : DEFAULTS.srLookbackHours;
  srH = Math.max(srHMin, Math.min(srHMax, srH));

  const zoneWidth =
    Number.isFinite(zoneW) && zoneW > 0
      ? Math.min(8, zoneW)
      : Number.isFinite(cluster) && cluster > 0
        ? Math.min(8, cluster)
        : DEFAULTS.zoneWidthPct;

  return {
    lookbackHours: hours,
    lookbackHoursMin: hMin,
    lookbackHoursMax: hMax,
    lookbackBars:
      Number.isFinite(lookbackBars) && lookbackBars >= 8
        ? Math.min(400, Math.round(lookbackBars))
        : DEFAULTS.lookbackBars,
    pivotWindow:
      Number.isFinite(pivot) && pivot >= 1
        ? Math.min(6, Math.round(pivot))
        : DEFAULTS.pivotWindow,
    clusterPct: zoneWidth,
    zoneWidthPct: zoneWidth,
    nearPct:
      (Number.isFinite(near) && near > 0 ? near : DEFAULTS.nearPct) * nearScale,
    minImpulsePct:
      Number.isFinite(minImpulse) && minImpulse > 0
        ? Math.min(500, minImpulse)
        : DEFAULTS.minImpulsePct,
    preferRecentImpulse: t?.preferRecentImpulse !== false,
    minTouchesForValid:
      Number.isFinite(minTouchesValid) && minTouchesValid >= 1
        ? Math.min(8, Math.round(minTouchesValid))
        : DEFAULTS.minTouchesForValid,
    minTouchesForStrong:
      Number.isFinite(minTouches) && minTouches >= 1
        ? Math.min(8, Math.round(minTouches))
        : DEFAULTS.minTouchesForStrong,
    maxHistoryPoints:
      Number.isFinite(maxPts) && maxPts >= 32
        ? Math.min(500, Math.round(maxPts))
        : DEFAULTS.maxHistoryPoints,
    prioritizeFibLevels: parseFibList(
      t?.prioritizeFibLevels,
      DEFAULTS.prioritizeFibLevels
    ),
    secondaryFibLevels: parseFibList(
      t?.secondaryFibLevels,
      DEFAULTS.secondaryFibLevels
    ),
    sensitivity: sens,
    srLookbackHours: srH,
    srLookbackHoursMin: srHMin,
    srLookbackHoursMax: srHMax,
    srLookbackHoursHardMax: hardMax,
    swingStrength,
    preferRecentSupport: t?.preferRecentSupport !== false,
    favourVolumeReaction: t?.favourVolumeReaction !== false,
    requireBreakCloseInvalidation:
      t?.requireBreakCloseInvalidation !== false,
    fibTreatAsZones: t?.fibTreatAsZones !== false,
  };
}

/** Whether the technical filter strategy is active. */
export function isTechnicalLevelsEnabled(): boolean {
  if (!isStrategyEnabled('technical_levels')) return false;
  return config.technicalLevels?.enabled !== false;
}

export function recordPriceTick(
  mint: string,
  price: number,
  timeMs: number = Date.now(),
  volume?: number
): void {
  if (!mint || !(price > 0)) return;
  const c = cfg();
  let buf = priceHistory.get(mint);
  if (!buf) {
    buf = [];
    priceHistory.set(mint, buf);
  }
  const last = buf[buf.length - 1];
  // Dedupe near-identical ticks within 2s
  if (last && timeMs - last.time < 2_000 && pctDist(price, last.price) < 0.05) {
    last.price = price;
    last.time = timeMs;
    if (volume != null && Number.isFinite(volume)) last.volume = volume;
    return;
  }
  buf.push({
    time: timeMs,
    price,
    volume: volume != null && Number.isFinite(volume) ? volume : undefined,
  });
  if (buf.length > c.maxHistoryPoints) {
    buf.splice(0, buf.length - c.maxHistoryPoints);
  }
  snapshotCache.delete(mint);
}

/**
 * Seed / refresh ring buffer from candles (backtester + Post-Run Dip).
 * Efficient: only appends newer points; respects maxHistoryPoints.
 */
export function seedPriceHistoryFromCandles(
  mint: string,
  candles: Array<{
    time: number;
    priceSol?: number;
    price?: number;
    volume?: number;
  }> | null | undefined
): void {
  if (!mint || !candles?.length) return;
  for (const c of candles) {
    const px = num(c.price) ?? num(c.priceSol);
    if (px == null) continue;
    recordPriceTick(
      mint,
      px,
      Number(c.time) || Date.now(),
      c.volume != null && Number.isFinite(Number(c.volume))
        ? Number(c.volume)
        : undefined
    );
  }
}

export function getPriceHistory(mint: string): readonly PricePoint[] {
  return priceHistory.get(mint) ?? [];
}

export function clearPriceHistory(mint?: string): void {
  if (mint) {
    priceHistory.delete(mint);
    snapshotCache.delete(mint);
  } else {
    priceHistory.clear();
    snapshotCache.clear();
  }
}

export function fibPriceFromHigh(
  high: number,
  low: number,
  ratio: number
): number {
  return high - (high - low) * ratio;
}

export function fibPriceFromLow(
  high: number,
  low: number,
  ratio: number
): number {
  return low + (high - low) * ratio;
}

/**
 * Slack so a slight undercut (price a few % below support) still counts as
 * sitting on the level. Overhead Fib/S (reclaim / resistance) does not.
 */
export const SUPPORT_SIDE_SLACK_PCT = 4;

/** True when `level` is at or below live price (dip/support), not overhead. */
export function isSupportSideLevel(
  levelPrice: number | null | undefined,
  livePrice: number | null | undefined,
  slackPct: number = SUPPORT_SIDE_SLACK_PCT
): boolean {
  const lvl = Number(levelPrice);
  const live = Number(livePrice);
  if (!(lvl > 0) || !(live > 0)) return false;
  const slack = Math.max(0, Number(slackPct) || 0);
  return lvl <= live * (1 + slack / 100);
}

export function marketCapAtPriceLevel(
  marketCapUsd: number | undefined,
  lastPriceSol: number | null | undefined,
  levelPriceSol: number | null | undefined
): number | null {
  const mc = Number(marketCapUsd);
  const last = Number(lastPriceSol);
  const lvl = Number(levelPriceSol);
  if (!(mc > 0) || !(last > 0) || !(lvl > 0)) return null;
  return mc * (lvl / last);
}

export interface SupportSideMcTarget {
  label: string;
  priceSol: number;
  mcUsd: number;
}

/**
 * Build dashboard MC targets only for support-side prices (≤ live + slack).
 * Overhead Fib 0.5 after a dump is a reclaim, not a dip buy.
 */
export function buildSupportSideMcTargets(input: {
  marketCapUsd?: number;
  lastPriceSol?: number | null;
  levels: Array<{ label: string; priceSol: number | null | undefined }>;
}): SupportSideMcTarget[] {
  const live = input.lastPriceSol;
  const out: SupportSideMcTarget[] = [];
  for (const row of input.levels) {
    const priceSol = Number(row.priceSol);
    if (!isSupportSideLevel(priceSol, live)) continue;
    const mcUsd = marketCapAtPriceLevel(
      input.marketCapUsd,
      live,
      priceSol
    );
    if (mcUsd == null) continue;
    if (
      out.some(
        (e) =>
          Math.abs(e.priceSol - priceSol) / Math.max(e.priceSol, 1e-18) < 0.005
      )
    ) {
      continue;
    }
    out.push({ label: row.label, priceSol, mcUsd });
  }
  return out;
}

/**
 * Dip-buy Fib 0.5 / 0.618 are always retracements down from the swing high.
 * `down_impulse` ladders place 0.618 above the low (bounce), which is not a dip.
 */
export function pickDipRetracementLevels(opts: {
  livePrice?: number | null;
  swingHigh?: number | null;
  swingLow?: number | null;
  fib05?: number | null;
  fib618?: number | null;
}): { fib05: number | null; fib618: number | null } {
  const live = opts.livePrice;
  const high = Number(opts.swingHigh);
  const low = Number(opts.swingLow);
  let f05 = Number(opts.fib05);
  let f618 = Number(opts.fib618);
  if (high > 0 && low > 0 && high > low) {
    f05 = fibPriceFromHigh(high, low, 0.5);
    f618 = fibPriceFromHigh(high, low, 0.618);
  }
  return {
    fib05: isSupportSideLevel(f05, live) ? f05 : null,
    fib618: isSupportSideLevel(f618, live) ? f618 : null,
  };
}

export function isNearFibLevel(
  price: number,
  level: number | FibLevel,
  nearPct?: number
): boolean {
  const band = nearPct ?? cfg().nearPct;
  if (!(price > 0)) return false;
  if (typeof level === 'number') {
    if (!(level > 0)) return false;
    return pctDist(price, level) <= band;
  }
  // Prefer explicit zone band when present (treat Fib as zones)
  if (
    cfg().fibTreatAsZones &&
    level.zoneLow > 0 &&
    level.zoneHigh > 0
  ) {
    const pad = band / 100;
    return (
      price >= level.zoneLow * (1 - pad * 0.25) &&
      price <= level.zoneHigh * (1 + pad * 0.25)
    );
  }
  if (!(level.price > 0)) return false;
  return pctDist(price, level.price) <= band;
}

/** Convenience: near any Fib zone (primary/secondary preferred). */
export function isNearFibZone(
  price: number,
  fib: FibLadder | null | undefined,
  nearPct?: number
): boolean {
  if (!fib?.levels?.length || !(price > 0)) return false;
  return fib.levels.some(
    (l) => (l.key || l.prioritized) && isNearFibLevel(price, l, nearPct)
  );
}

export function isNearSupportZone(
  price: number,
  zone: SrZone,
  nearPct?: number
): boolean {
  const band = nearPct ?? cfg().nearPct;
  if (!(price > 0)) return false;
  if (price >= zone.low * (1 - band / 100) && price <= zone.high * (1 + band / 100)) {
    return true;
  }
  return pctDist(price, zone.mid) <= band;
}

/** Min local stick-out % required for a swing pivot by strength. */
export function minSwingExcursionPct(strength: SwingStrength): number {
  if (strength === 'low') return 1.5;
  if (strength === 'high') return 5;
  return 3; // medium
}

/** Local pivot highs/lows using a symmetric window + optional strength floor. */
export function findSwingPivots(
  points: PricePoint[],
  pivotWindow: number,
  swingStrength: SwingStrength = 'medium'
): { highs: PricePoint[]; lows: PricePoint[] } {
  const highs: PricePoint[] = [];
  const lows: PricePoint[] = [];
  const w = Math.max(1, pivotWindow);
  const minExc = minSwingExcursionPct(swingStrength);
  if (points.length < w * 2 + 1) {
    // Degenerate: use slice extrema
    if (points.length >= 2) {
      let hi = points[0]!;
      let lo = points[0]!;
      for (const p of points) {
        if (p.price > hi.price) hi = p;
        if (p.price < lo.price) lo = p;
      }
      if (hi.price > lo.price) {
        const run = ((hi.price - lo.price) / lo.price) * 100;
        if (run >= minExc) {
          highs.push(hi);
          lows.push(lo);
        }
      }
    }
    return { highs, lows };
  }
  for (let i = w; i < points.length - w; i++) {
    const p = points[i]!;
    let isHigh = true;
    let isLow = true;
    let nextHigh = -Infinity;
    let nextLow = Infinity;
    for (let j = i - w; j <= i + w; j++) {
      if (j === i) continue;
      const o = points[j]!;
      if (o.price >= p.price) isHigh = false;
      if (o.price <= p.price) isLow = false;
      if (o.price > nextHigh) nextHigh = o.price;
      if (o.price < nextLow) nextLow = o.price;
    }
    if (isHigh && nextHigh > 0) {
      const exc = ((p.price - nextHigh) / p.price) * 100;
      if (exc >= minExc * 0.35 || ((p.price - nextLow) / p.price) * 100 >= minExc) {
        highs.push(p);
      }
    }
    if (isLow && nextLow < Infinity && nextLow > 0) {
      const exc = ((nextLow - p.price) / p.price) * 100;
      if (exc >= minExc * 0.35 || ((nextHigh - p.price) / p.price) * 100 >= minExc) {
        lows.push(p);
      }
    }
  }
  return { highs, lows };
}

/**
 * Clear break + close invalidation: price breaks beyond the zone, then a
 * subsequent tick/close remains beyond (no immediate reclaim).
 */
export function isZoneInvalidatedByBreakClose(
  points: PricePoint[],
  zone: { low: number; high: number },
  kind: 'support' | 'resistance'
): boolean {
  let broke = false;
  for (const p of points) {
    const beyond =
      kind === 'support' ? p.price < zone.low : p.price > zone.high;
    if (!broke) {
      if (beyond) broke = true;
      continue;
    }
    if (beyond) return true; // break + close still beyond
    broke = false; // reclaimed — reset
  }
  return false;
}

/** Bounce / volume reaction at a prospective zone (0–100). */
export function estimateVolumeReaction(
  points: PricePoint[],
  zone: { low: number; high: number; mid: number },
  kind: 'support' | 'resistance'
): number {
  let best = 0;
  const pad = zone.mid * 0.005;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const inZone =
      p.price >= zone.low - pad && p.price <= zone.high + pad;
    if (!inZone) continue;

    const ahead = points.slice(i + 1, i + 9);
    if (!ahead.length) continue;
    let bouncePct = 0;
    if (kind === 'support') {
      const peak = Math.max(...ahead.map((a) => a.price));
      bouncePct = ((peak - p.price) / Math.max(p.price, 1e-12)) * 100;
    } else {
      const trough = Math.min(...ahead.map((a) => a.price));
      bouncePct = ((p.price - trough) / Math.max(p.price, 1e-12)) * 100;
    }

    let volBoost = 0;
    if (p.volume != null && Number.isFinite(p.volume) && p.volume > 0) {
      const window = points.slice(Math.max(0, i - 4), i + 5);
      const vols = window
        .map((x) => x.volume)
        .filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
      if (vols.length >= 2) {
        const avg = vols.reduce((a, b) => a + b, 0) / vols.length;
        if (avg > 0 && p.volume >= avg * 1.25) volBoost = 28;
        else if (avg > 0 && p.volume >= avg * 1.1) volBoost = 14;
      }
    }

    best = Math.max(best, Math.min(100, Math.round(bouncePct * 7 + volBoost)));
  }
  return best;
}

function rankSrZones(
  zones: SrZone[],
  options: {
    preferRecent: boolean;
    favourVolume: boolean;
    nowMs: number;
  }
): SrZone[] {
  return [...zones].sort((a, b) => {
    const score = (z: SrZone) => {
      let s = z.strength;
      if (options.favourVolume) s += z.volumeReaction * 0.4;
      if (options.preferRecent) {
        const ageH = Math.max(
          0,
          (options.nowMs - z.lastTouchMs) / 3_600_000
        );
        s += Math.max(0, 30 - ageH * 8);
      }
      s -= z.distancePct * 1.5;
      return s;
    };
    if (options.preferRecent) {
      const strongA = a.touches >= 2 ? 1 : 0;
      const strongB = b.touches >= 2 ? 1 : 0;
      if (strongA !== strongB) return strongB - strongA;
      if (a.lastTouchMs !== b.lastTouchMs) return b.lastTouchMs - a.lastTouchMs;
    }
    return score(b) - score(a);
  });
}

function clusterZones(
  pivots: PricePoint[],
  kind: 'support' | 'resistance',
  zoneWidthPct: number,
  price: number,
  nearPct: number,
  nowMs: number,
  allPoints: PricePoint[],
  options: {
    minTouchesForValid: number;
    favourVolumeReaction: boolean;
    preferRecentSupport: boolean;
    requireBreakCloseInvalidation: boolean;
  }
): SrZone[] {
  if (!pivots.length) return [];
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const clusters: PricePoint[][] = [];
  for (const p of sorted) {
    const last = clusters[clusters.length - 1];
    if (
      last &&
      pctDist(p.price, last[last.length - 1]!.price) <= zoneWidthPct
    ) {
      last.push(p);
    } else {
      clusters.push([p]);
    }
  }

  const zones: SrZone[] = [];
  for (const group of clusters) {
    const prices = group.map((g) => g.price);
    const touchMid =
      (Math.min(...prices) + Math.max(...prices)) / 2 || prices[0]!;
    // Zone width ±zoneWidthPct around mid (Pump.fun default ±2%)
    const half = touchMid * (zoneWidthPct / 100);
    const low = Math.min(Math.min(...prices), touchMid - half);
    const high = Math.max(Math.max(...prices), touchMid + half);
    const mid = (low + high) / 2;
    const touches = group.length;
    if (touches < options.minTouchesForValid) continue;

    const lastTouchMs = Math.max(...group.map((g) => g.time));
    const ageHours = Math.max(0, (nowMs - lastTouchMs) / 3_600_000);
    const recency = Math.max(0, 1 - ageHours / 24);
    const volumeReaction = estimateVolumeReaction(
      allPoints,
      { low, high, mid },
      kind
    );
    const invalidated = options.requireBreakCloseInvalidation
      ? isZoneInvalidatedByBreakClose(allPoints, { low, high }, kind)
      : false;
    if (invalidated) continue;

    const strength = Math.min(
      100,
      Math.round(
        touches * 26 +
          recency * 22 +
          (options.favourVolumeReaction ? volumeReaction * 0.28 : 0) +
          (kind === 'support' ? 5 : 0)
      )
    );
    const distancePct = pctDist(price, mid);
    zones.push({
      kind,
      mid,
      low,
      high,
      touches,
      strength,
      distancePct,
      near:
        distancePct <= nearPct ||
        (price >= low * (1 - nearPct / 100) &&
          price <= high * (1 + nearPct / 100)),
      lastTouchMs,
      volumeReaction,
      invalidated: false,
    });
  }

  return rankSrZones(zones, {
    preferRecent: options.preferRecentSupport,
    favourVolume: options.favourVolumeReaction,
    nowMs,
  });
}

/**
 * Pick the most relevant impulse in lookback for Pump.fun dip Fibs.
 * Prefer the most recent up-move with run ≥ minImpulsePct (strong pump);
 * fall back to the strongest recent pump if none meet the floor.
 */
export function selectImpulseSwing(
  points: PricePoint[],
  pivotWindow: number,
  options?: {
    minImpulsePct?: number;
    preferRecent?: boolean;
  }
): {
  high: PricePoint;
  low: PricePoint;
  direction: 'up_impulse' | 'down_impulse';
  runPct: number;
} | null {
  const minRun = options?.minImpulsePct ?? cfg().minImpulsePct;
  const preferRecent = options?.preferRecent !== false;
  const { highs, lows } = findSwingPivots(points, pivotWindow);

  type Cand = {
    high: PricePoint;
    low: PricePoint;
    direction: 'up_impulse' | 'down_impulse';
    run: number;
  };

  const candidates: Cand[] = [];

  if (highs.length && lows.length) {
    for (const lo of lows) {
      for (const hi of highs) {
        if (hi.time < lo.time) continue;
        if (hi.price <= lo.price) continue;
        const run = ((hi.price - lo.price) / lo.price) * 100;
        candidates.push({
          high: hi,
          low: lo,
          direction: 'up_impulse',
          run,
        });
      }
    }
  }

  if (!candidates.length && points.length >= 2) {
    let hi = points[0]!;
    let lo = points[0]!;
    for (const p of points) {
      if (p.price > hi.price) hi = p;
      if (p.price < lo.price) lo = p;
    }
    if (hi.price > lo.price) {
      candidates.push({
        high: hi,
        low: lo,
        direction: hi.time >= lo.time ? 'up_impulse' : 'down_impulse',
        run: ((hi.price - lo.price) / lo.price) * 100,
      });
    }
  }

  if (!candidates.length) return null;

  const strong = candidates.filter((c) => c.run >= minRun);
  const pool = strong.length ? strong : candidates;

  let best = pool[0]!;
  for (const c of pool) {
    if (preferRecent) {
      // Most recent pump peak; tie-break on stronger run
      if (
        c.high.time > best.high.time ||
        (c.high.time === best.high.time && c.run > best.run)
      ) {
        best = c;
      }
    } else if (c.run > best.run) {
      best = c;
    }
  }

  return {
    high: best.high,
    low: best.low,
    direction: best.direction,
    runPct: best.run,
  };
}

function buildFibLadder(
  high: number,
  low: number,
  price: number,
  direction: 'up_impulse' | 'down_impulse',
  nearPct: number,
  prioritize: FibRatio[],
  secondary: FibRatio[],
  treatAsZones: boolean
): FibLadder {
  const impulseRunPct = ((high - low) / Math.max(low, 1e-12)) * 100;
  const levels: FibLevel[] = FIB_RATIOS.map((ratio) => {
    const lvl =
      direction === 'up_impulse'
        ? fibPriceFromHigh(high, low, ratio)
        : fibPriceFromLow(high, low, ratio);
    const half = treatAsZones ? lvl * (nearPct / 100) : 0;
    const zoneLow = treatAsZones ? lvl - half : lvl;
    const zoneHigh = treatAsZones ? lvl + half : lvl;
    const inZone =
      treatAsZones &&
      price >= zoneLow &&
      price <= zoneHigh;
    const distancePct = inZone
      ? 0
      : Math.min(
          pctDist(price, lvl),
          pctDist(price, zoneLow),
          pctDist(price, zoneHigh)
        );
    const key = (KEY_FIB_RATIOS as readonly number[]).includes(ratio);
    const prioritized = prioritize.includes(ratio);
    const isSecondary = secondary.includes(ratio);
    return {
      ratio,
      price: lvl,
      zoneLow,
      zoneHigh,
      distancePct,
      near: inZone || distancePct <= nearPct,
      key: key || prioritized,
      prioritized: prioritized || isSecondary,
    };
  });
  // Nearest among primary first, then secondary
  const primaryLevels = levels.filter((l) => prioritize.includes(l.ratio));
  const secondaryLevels = levels.filter((l) => secondary.includes(l.ratio));
  const ranked = [...primaryLevels, ...secondaryLevels];
  let nearestKey: FibLevel | null = null;
  for (const l of ranked) {
    if (!nearestKey || l.distancePct < nearestKey.distancePct) nearestKey = l;
  }
  return {
    swingHigh: high,
    swingLow: low,
    direction,
    impulseRunPct,
    levels,
    nearestKey,
  };
}

function pointsFromCandles(
  candles: TechnicalAnalyzeInput['candles']
): PricePoint[] {
  return (candles ?? [])
    .map((c) => ({
      time: Number(c.time) || 0,
      price: num(c.price) ?? num(c.priceSol) ?? 0,
      volume:
        c.volume != null && Number.isFinite(Number(c.volume))
          ? Number(c.volume)
          : undefined,
    }))
    .filter((p) => p.price > 0);
}

function pointsFromProxy(input: TechnicalAnalyzeInput): PricePoint[] {
  const price = num(input.priceUsd) ?? num(input.priceSol);
  if (price == null) return [];
  const now = input.nowMs ?? Date.now();
  const chg1 = Number(input.priceChangeH1Pct);
  const chg24 = Number(input.priceChange24hPct);
  const drop = Number(input.dropFromPeakPct);

  let high = price;
  if (Number.isFinite(drop) && drop > 0 && drop < 95) {
    high = price / (1 - drop / 100);
  } else if (Number.isFinite(chg1) && chg1 < 0) {
    high = price / (1 + chg1 / 100);
  } else if (Number.isFinite(chg24) && chg24 > 20) {
    high = price * 1.1;
  }

  let low = price;
  if (Number.isFinite(chg24) && Math.abs(chg24) < 800) {
    low = Math.min(price, price / (1 + chg24 / 100));
  } else {
    low = price * 0.55;
  }
  if (high <= low) high = Math.max(price * 1.25, low * 1.5);
  if (low >= price) low = Math.min(price * 0.85, high * 0.55);

  // Synthetic path: low → high → current (enough for pivots/fib)
  return [
    { time: now - 3_600_000 * 6, price: low },
    { time: now - 3_600_000 * 2, price: high },
    { time: now - 1_800_000, price: (high + price) / 2 },
    { time: now, price },
  ];
}

function emptySnap(
  mint: string | null,
  detail: string
): TechnicalSnapshot {
  return {
    mint,
    price: null,
    supportZones: [],
    resistanceZones: [],
    nearestSupport: null,
    nearestResistance: null,
    fib: null,
    nearSupport: false,
    nearKeyFib: false,
    nearStrongSupport: false,
    source: 'none',
    lookbackUsed: 0,
    detail,
    summary: 'tech n/a',
  };
}

export function analyzeTechnicals(
  input: TechnicalAnalyzeInput
): TechnicalSnapshot {
  const c = cfg();
  const nearPct = input.nearPct ?? c.nearPct;
  const lookbackBars = input.lookback ?? c.lookbackBars;
  const mint = input.mint ?? null;
  const nowMs = input.nowMs ?? Date.now();
  const fibCutoff = nowMs - c.lookbackHours * 3_600_000;
  const srCutoff = nowMs - c.srLookbackHours * 3_600_000;

  let source: TechnicalSnapshot['source'] = 'none';
  let rawPoints: PricePoint[] = [];

  if (mint) {
    const hist = priceHistory.get(mint);
    if (hist && hist.length >= 4) {
      rawPoints = hist.slice();
      source = 'history';
    }
  }
  if (rawPoints.length < 4) {
    const fromCandles = pointsFromCandles(input.candles);
    if (fromCandles.length >= 3) {
      rawPoints = fromCandles;
      source = 'candles';
    }
  }
  if (rawPoints.length < 3) {
    rawPoints = pointsFromProxy(input);
    source = rawPoints.length ? 'proxy' : 'none';
  }

  if (rawPoints.length < 2) {
    return emptySnap(mint, 'insufficient price history');
  }

  const sliceLookback = (cutoff: number): PricePoint[] => {
    const byTime = rawPoints.filter((p) => !p.time || p.time >= cutoff);
    if (byTime.length >= 3) return byTime.slice(-lookbackBars);
    return rawPoints.slice(-lookbackBars);
  };

  const fibPoints = sliceLookback(fibCutoff);
  const srPoints = sliceLookback(srCutoff);

  const price =
    num(input.priceUsd) ??
    num(input.priceSol) ??
    rawPoints[rawPoints.length - 1]!.price;

  const { highs, lows } = findSwingPivots(
    srPoints,
    c.pivotWindow,
    c.swingStrength
  );
  const srOpts = {
    minTouchesForValid: c.minTouchesForValid,
    favourVolumeReaction: c.favourVolumeReaction,
    preferRecentSupport: c.preferRecentSupport,
    requireBreakCloseInvalidation: c.requireBreakCloseInvalidation,
  };
  const supportZones = clusterZones(
    lows,
    'support',
    c.zoneWidthPct,
    price,
    nearPct,
    nowMs,
    srPoints,
    srOpts
  );
  const resistanceZones = clusterZones(
    highs,
    'resistance',
    c.zoneWidthPct,
    price,
    nearPct,
    nowMs,
    srPoints,
    srOpts
  );

  const nearestSupport =
    supportZones.find((z) => isSupportSideLevel(z.mid, price)) ?? null;
  const nearestResistance = resistanceZones[0] ?? null;

  const impulse = selectImpulseSwing(fibPoints, c.pivotWindow, {
    minImpulsePct: c.minImpulsePct,
    preferRecent: c.preferRecentImpulse,
  });
  const fib = impulse
    ? buildFibLadder(
        impulse.high.price,
        impulse.low.price,
        price,
        impulse.direction,
        nearPct,
        c.prioritizeFibLevels,
        c.secondaryFibLevels,
        c.fibTreatAsZones
      )
    : null;

  const nearKeyFib =
    fib?.levels.some(
      (l) =>
        (c.prioritizeFibLevels.includes(l.ratio) ||
          c.secondaryFibLevels.includes(l.ratio) ||
          l.key) &&
        l.near &&
        isSupportSideLevel(l.price, price)
    ) === true;
  const nearSupport = nearestSupport?.near === true;
  const nearStrongSupport =
    nearSupport &&
    nearestSupport != null &&
    nearestSupport.touches >= c.minTouchesForStrong &&
    !nearestSupport.invalidated;

  const fibBit = fib?.nearestKey
    ? `Fib${fib.nearestKey.ratio}@${fib.nearestKey.distancePct.toFixed(1)}%`
    : 'Fib—';
  const supBit = nearestSupport
    ? `S×${nearestSupport.touches}@${nearestSupport.distancePct.toFixed(1)}%` +
      (nearestSupport.volumeReaction >= 20 ? ' vol✓' : '')
    : 'S—';
  const summary = `${fibBit} ${supBit}${nearKeyFib || nearSupport ? ' NEAR' : ''}`;

  const detail =
    `${source} n=${srPoints.length} fibLb=${c.lookbackHours}h srLb=${c.srLookbackHours}h ` +
    `swing=${c.swingStrength} zone±${c.zoneWidthPct}% ` +
    `px=${price} minImpulse=${c.minImpulsePct}% ` +
    `sup=${supportZones.length} res=${resistanceZones.length} ` +
    (fib
      ? `impulse=${fib.direction} run=${fib.impulseRunPct.toFixed(0)}% hi=${fib.swingHigh} lo=${fib.swingLow}`
      : 'no-impulse') +
    ` · ${summary}`;

  return {
    mint,
    price,
    supportZones,
    resistanceZones,
    nearestSupport,
    nearestResistance,
    fib,
    nearSupport,
    nearKeyFib,
    nearStrongSupport,
    source,
    lookbackUsed: srPoints.length,
    detail,
    summary,
  };
}

export function getTechnicalSnapshot(
  mint: string,
  input?: Omit<TechnicalAnalyzeInput, 'mint'>
): TechnicalSnapshot {
  const cached = snapshotCache.get(mint);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS && !input?.candles) {
    return cached.snap;
  }
  const hist = priceHistory.get(mint);
  const lastPx = hist?.[hist.length - 1]?.price;
  const snap = analyzeTechnicals({
    mint,
    priceSol: input?.priceSol ?? lastPx ?? null,
    priceUsd: input?.priceUsd,
    priceChangeH1Pct: input?.priceChangeH1Pct,
    priceChange24hPct: input?.priceChange24hPct,
    dropFromPeakPct: input?.dropFromPeakPct,
    candles: input?.candles,
    nowMs: input?.nowMs,
    nearPct: input?.nearPct,
    lookback: input?.lookback,
  });
  snapshotCache.set(mint, { at: Date.now(), snap });
  return snap;
}

export function getFibLevels(
  mint: string,
  input?: Omit<TechnicalAnalyzeInput, 'mint'>
): FibLevel[] {
  return getTechnicalSnapshot(mint, input).fib?.levels ?? [];
}

export function getNearestSupport(
  mint: string,
  price?: number | null
): SrZone | null {
  const snap = getTechnicalSnapshot(
    mint,
    price != null ? { priceSol: price } : undefined
  );
  return snap.nearestSupport;
}

export function getNearestResistance(
  mint: string,
  price?: number | null
): SrZone | null {
  const snap = getTechnicalSnapshot(
    mint,
    price != null ? { priceSol: price } : undefined
  );
  return snap.nearestResistance;
}

/** Primary + secondary Fib zones for strategy consumers (Post-Run Dip, etc.). */
export function getFibZones(
  mint: string,
  input?: Omit<TechnicalAnalyzeInput, 'mint'>
): FibLevel[] {
  const levels = getFibLevels(mint, input);
  return levels.filter((l) => l.key || l.prioritized);
}

/**
 * Unified levels helper — one call for strategies that need Fib + S/R.
 * Fail-open friendly; works in Paper / Live Sim / Backtester.
 */
export function getTechnicalLevelsForStrategy(
  input: TechnicalAnalyzeInput
): {
  snapshot: TechnicalSnapshot;
  nearFibZone: boolean;
  nearSupportZone: boolean;
  fibZones: FibLevel[];
  nearestSupport: SrZone | null;
  nearestResistance: SrZone | null;
} {
  if (input.mint && input.candles?.length) {
    seedPriceHistoryFromCandles(input.mint, input.candles);
  }
  const snapshot = analyzeTechnicals(input);
  return {
    snapshot,
    nearFibZone: snapshot.nearKeyFib,
    nearSupportZone: snapshot.nearSupport,
    fibZones: (snapshot.fib?.levels ?? []).filter(
      (l) => l.key || l.prioritized
    ),
    nearestSupport: snapshot.nearestSupport,
    nearestResistance: snapshot.nearestResistance,
  };
}

/** Soft conviction boost when near strong S/R or key Fib (strategy toggle ON). */
export function resolveTechnicalLevelsForSignal(
  input: TechnicalAnalyzeInput & { symbol?: string }
): {
  convictionDelta: number;
  influenced: boolean;
  skip: boolean;
  skipReason?: string;
  snapshot: TechnicalSnapshot;
  logLine: string;
} | null {
  if (!isTechnicalLevelsEnabled()) return null;

  if (input.mint && input.candles?.length) {
    seedPriceHistoryFromCandles(input.mint, input.candles);
  }

  const snapshot = analyzeTechnicals(input);
  if (snapshot.source === 'none') {
    return {
      convictionDelta: 0,
      influenced: false,
      skip: false,
      snapshot,
      logLine: 'technicals: no data (fail-open)',
    };
  }

  const c = cfg();
  let convictionDelta = 0;
  if (snapshot.nearKeyFib) {
    convictionDelta += c.sensitivity === 'high' ? 6 : c.sensitivity === 'low' ? 3 : 5;
  }
  if (snapshot.nearStrongSupport) {
    convictionDelta += c.sensitivity === 'high' ? 5 : 3;
  } else if (snapshot.nearSupport) {
    convictionDelta += 2;
  }
  convictionDelta = Math.min(12, convictionDelta);

  let skip = false;
  let skipReason: string | undefined;
  if (
    config.technicalLevels?.hardFilter === true &&
    !snapshot.nearKeyFib &&
    !snapshot.nearSupport
  ) {
    skip = true;
    skipReason = 'technical filter: not near Fib or support';
  }

  const influenced = convictionDelta > 0 || skip;
  const logLine =
    `technicals ${c.sensitivity}: Δconv=${
      convictionDelta > 0 ? '+' : ''
    }${convictionDelta}` +
    (skip ? ' SKIP' : '') +
    ` · ${snapshot.summary} · ${snapshot.detail}`;

  if (influenced) {
    logStrategyDecision(
      'technical_levels',
      skip ? 'skip' : 'take',
      `${input.symbol || input.mint || 'token'}: ${logLine}`
    );
    console.log(
      `[technicals] ${skip ? 'SKIP' : 'BOOST'} ${input.symbol || input.mint} — ${logLine}`
    );
  }

  return {
    convictionDelta,
    influenced,
    skip,
    skipReason,
    snapshot,
    logLine,
  };
}

export function formatTechnicalLevelsShort(
  snap: TechnicalSnapshot | null | undefined
): string {
  if (!snap || snap.source === 'none') return '';
  const parts: string[] = [];
  if (snap.fib?.nearestKey) {
    parts.push(
      `Fib ${snap.fib.nearestKey.ratio}${snap.nearKeyFib ? ' ✓' : ''}`
    );
  }
  if (snap.nearestSupport) {
    parts.push(
      `S×${snap.nearestSupport.touches}${snap.nearSupport ? ' ✓' : ''}`
    );
  }
  return parts.join(' · ');
}

/** Dashboard / API payload */
export function technicalLevelsPublic(
  snap: TechnicalSnapshot | null | undefined
): Record<string, unknown> | null {
  if (!snap || snap.source === 'none') return null;
  return {
    source: snap.source,
    summary: snap.summary,
    nearSupport: snap.nearSupport,
    nearKeyFib: snap.nearKeyFib,
    nearStrongSupport: snap.nearStrongSupport,
    nearestSupport: snap.nearestSupport
      ? {
          mid: snap.nearestSupport.mid,
          low: snap.nearestSupport.low,
          high: snap.nearestSupport.high,
          touches: snap.nearestSupport.touches,
          strength: snap.nearestSupport.strength,
          distancePct: snap.nearestSupport.distancePct,
          volumeReaction: snap.nearestSupport.volumeReaction,
          lastTouchMs: snap.nearestSupport.lastTouchMs,
        }
      : null,
    nearestResistance: snap.nearestResistance
      ? {
          mid: snap.nearestResistance.mid,
          touches: snap.nearestResistance.touches,
          distancePct: snap.nearestResistance.distancePct,
          volumeReaction: snap.nearestResistance.volumeReaction,
        }
      : null,
    keyFibs: (snap.fib?.levels ?? [])
      .filter((l) => l.key || l.prioritized)
      .map((l) => ({
        ratio: l.ratio,
        price: l.price,
        zoneLow: l.zoneLow,
        zoneHigh: l.zoneHigh,
        distancePct: l.distancePct,
        near: l.near,
      })),
    impulseRunPct: snap.fib?.impulseRunPct ?? null,
    lookbackHours: config.technicalLevels?.lookbackHours ?? 4,
    srLookbackHours: config.technicalLevels?.srLookbackHours ?? 2,
    nearPct: config.technicalLevels?.nearPct ?? 2,
    zoneWidthPct:
      config.technicalLevels?.zoneWidthPct ??
      config.technicalLevels?.clusterPct ??
      2,
    minImpulsePct: config.technicalLevels?.minImpulsePct ?? 50,
    swingStrength: config.technicalLevels?.swingStrength ?? 'medium',
    fibTreatAsZones: config.technicalLevels?.fibTreatAsZones !== false,
  };
}

/** Multi-TF S/R timeframe labels (aligned with OHLCV + Profile TA). */
export type SrTimeframe = '5m' | '15m' | '30m' | '1h' | '4h';

export const SR_TIMEFRAMES: readonly SrTimeframe[] = [
  '5m',
  '15m',
  '30m',
  '1h',
  '4h',
] as const;

/** Higher TFs that count toward Mode B confluence (not 5m-only). */
export const SR_HIGHER_TFS: readonly SrTimeframe[] = [
  '15m',
  '30m',
  '1h',
  '4h',
] as const;

const TF_RANK: Record<SrTimeframe, number> = {
  '5m': 1,
  '15m': 2,
  '30m': 3,
  '1h': 4,
  '4h': 5,
};

export interface PerTfTechnicalSnapshot {
  tf: SrTimeframe;
  snapshot: TechnicalSnapshot;
  nearSupport: boolean;
  nearResistance: boolean;
  nearestSupportMid: number | null;
  nearestResistanceMid: number | null;
}

export interface SrConfluenceResult {
  supportTfHits: SrTimeframe[];
  resistanceTfHits: SrTimeframe[];
  confluenceScore: number;
  nearMultiTfSupport: boolean;
  nearMultiTfResistance: boolean;
  primarySupport: number | null;
  primaryResistance: number | null;
  perTf: PerTfTechnicalSnapshot[];
}

function isSrTimeframe(t: string): t is SrTimeframe {
  return (SR_TIMEFRAMES as readonly string[]).includes(t);
}

/**
 * Analyze S/R independently on each TF candle series.
 * Fail-open per TF when history is thin.
 */
export function analyzeTechnicalsPerTf(
  mint: string | null | undefined,
  candlesByTf: Partial<Record<SrTimeframe | string, Array<{
    time: number;
    priceSol?: number;
    price?: number;
    volume?: number;
  }>>>,
  opts?: {
    priceSol?: number | null;
    nearPct?: number;
    nowMs?: number;
    /** Restrict to these TFs (default: all present) */
    timeframes?: SrTimeframe[];
  }
): PerTfTechnicalSnapshot[] {
  const want = opts?.timeframes?.length
    ? opts.timeframes.filter(isSrTimeframe)
    : SR_TIMEFRAMES.slice();
  const out: PerTfTechnicalSnapshot[] = [];
  for (const tf of want) {
    const candles = candlesByTf?.[tf];
    if (!candles || candles.length < 3) continue;
    const snap = analyzeTechnicals({
      mint: mint ?? null,
      priceSol: opts?.priceSol,
      candles,
      nearPct: opts?.nearPct,
      nowMs: opts?.nowMs,
    });
    const nearRes =
      snap.nearestResistance != null &&
      snap.nearestResistance.distancePct != null &&
      Math.abs(snap.nearestResistance.distancePct) <= (opts?.nearPct ?? cfg().nearPct) * 2;
    out.push({
      tf,
      snapshot: snap,
      nearSupport: snap.nearSupport,
      nearResistance: nearRes || Boolean(snap.nearestResistance?.near),
      nearestSupportMid:
        snap.nearestSupport?.mid != null && snap.nearestSupport.mid > 0
          ? snap.nearestSupport.mid
          : null,
      nearestResistanceMid:
        snap.nearestResistance?.mid != null && snap.nearestResistance.mid > 0
          ? snap.nearestResistance.mid
          : null,
    });
  }
  return out;
}

/**
 * Mode B ready confluence: ≥minHits TFs near support, including ≥1 higher TF
 * (15m/30m/1h/4h) when requireHigherTf is on.
 */
export function computeSrConfluence(
  perTf: PerTfTechnicalSnapshot[],
  opts?: {
    minHits?: number;
    requireHigherTf?: boolean;
  }
): SrConfluenceResult {
  const minHits = Math.max(
    1,
    Number(
      opts?.minHits ??
        config.technicalLevels?.srConfluenceMinHits ??
        DEFAULTS.srConfluenceMinHits
    ) || 2
  );
  const requireHigher =
    opts?.requireHigherTf ??
    config.technicalLevels?.srConfluenceRequireHigherTf !== false;

  const supportTfHits = perTf
    .filter((p) => p.nearSupport)
    .map((p) => p.tf);
  const resistanceTfHits = perTf
    .filter((p) => p.nearResistance)
    .map((p) => p.tf);

  const hasHigherSupport = supportTfHits.some((t) =>
    (SR_HIGHER_TFS as readonly string[]).includes(t)
  );
  const nearMultiTfSupport =
    supportTfHits.length >= minHits && (!requireHigher || hasHigherSupport);

  const hasHigherResist = resistanceTfHits.some((t) =>
    (SR_HIGHER_TFS as readonly string[]).includes(t)
  );
  const nearMultiTfResistance =
    resistanceTfHits.length >= minHits && (!requireHigher || hasHigherResist);

  const livePrice =
    perTf.find((p) => p.snapshot.price != null && p.snapshot.price > 0)
      ?.snapshot.price ?? null;

  // Prefer higher-TF agreement for primary levels
  const pickPrimary = (
    hits: SrTimeframe[],
    kind: 'support' | 'resistance'
  ): number | null => {
    const ok = (mid: number | null | undefined): mid is number => {
      if (mid == null || !(mid > 0)) return false;
      if (kind === 'support' && livePrice != null) {
        return isSupportSideLevel(mid, livePrice);
      }
      return true;
    };
    if (!hits.length) {
      // Fall back to strongest single TF mid even without confluence
      const ranked = [...perTf].sort(
        (a, b) => TF_RANK[b.tf] - TF_RANK[a.tf]
      );
      for (const p of ranked) {
        const mid =
          kind === 'support'
            ? p.nearestSupportMid
            : p.nearestResistanceMid;
        if (ok(mid)) return mid;
      }
      return null;
    }
    const ordered = [...hits].sort((a, b) => TF_RANK[b] - TF_RANK[a]);
    for (const tf of ordered) {
      const row = perTf.find((p) => p.tf === tf);
      const mid =
        kind === 'support'
          ? row?.nearestSupportMid
          : row?.nearestResistanceMid;
      if (ok(mid)) return mid;
    }
    return null;
  };

  const primarySupport = pickPrimary(supportTfHits, 'support');
  const primaryResistance = pickPrimary(resistanceTfHits, 'resistance');

  // Score: 0–100 from hit count + higher-TF bonus + resistance soft penalty later
  let confluenceScore = 0;
  if (supportTfHits.length) {
    confluenceScore += Math.min(55, supportTfHits.length * 18);
    if (hasHigherSupport) confluenceScore += 20;
    if (nearMultiTfSupport) confluenceScore += 15;
  }
  if (nearMultiTfResistance) {
    confluenceScore = Math.max(0, confluenceScore - 10);
  }
  confluenceScore = Math.max(0, Math.min(100, Math.round(confluenceScore)));

  return {
    supportTfHits,
    resistanceTfHits,
    confluenceScore,
    nearMultiTfSupport,
    nearMultiTfResistance,
    primarySupport,
    primaryResistance,
    perTf,
  };
}

/** Convenience: candlesByTf → confluence in one call. */
export function analyzeSrConfluenceFromCandles(
  mint: string | null | undefined,
  candlesByTf: Partial<Record<SrTimeframe | string, Array<{
    time: number;
    priceSol?: number;
    price?: number;
    volume?: number;
  }>>>,
  opts?: {
    priceSol?: number | null;
    nearPct?: number;
    nowMs?: number;
    timeframes?: SrTimeframe[];
    minHits?: number;
    requireHigherTf?: boolean;
  }
): SrConfluenceResult {
  const perTf = analyzeTechnicalsPerTf(mint, candlesByTf, opts);
  return computeSrConfluence(perTf, {
    minHits: opts?.minHits,
    requireHigherTf: opts?.requireHigherTf,
  });
}
