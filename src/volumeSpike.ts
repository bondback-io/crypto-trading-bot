/**
 * Volume Spike Filter — hard gate + soft conviction boost.
 *
 * Recommended defaults (Medium):
 *  - Surge multiplier 3× short-term vs recent average
 *  - Time window 1–5 minutes (default 3)
 *  - Buy-side dominance ≥ 65%
 *  - Prefer / require volume acceleration (by sensitivity)
 *  - Meaningful absolute volume floor (reject near-zero)
 *  - Relative volume Medium–High vs token’s own history
 *
 * Post-migration + spike: extra soft boost and slightly relaxed hard gates.
 * Fail-open when volume metrics are unavailable (non-blocking).
 */

import { config } from './config';
import { isStrategyEnabled, logStrategyDecision } from './strategies';

export type VolumeSpikeSensitivity = 'low' | 'medium' | 'high';

export type VolumeSpikeSource = 'none' | 'proxy';

export interface VolumeSpikeFlags {
  suddenSurge: boolean;
  buyDominance: boolean;
  acceleration: boolean;
  relativeVolume: boolean;
  absoluteFloor: boolean;
}

export interface VolumeSpikeReport {
  source: VolumeSpikeSource;
  flags: VolumeSpikeFlags;
  /** How many spike signals fired (0–5) */
  hitCount: number;
  /** 0–100 composite spike strength */
  strength: number;
  recentVolUsd: number | null;
  vol24Usd: number | null;
  buySidePct: number | null;
  relativeMult: number | null;
  detail: string;
  isMigration: boolean;
}

export interface VolumeSpikeVerdict {
  convictionDelta: number;
  skip: boolean;
  skipReason?: string;
  influenced: boolean;
  report: VolumeSpikeReport;
  logLine: string;
}

const EMPTY_FLAGS: VolumeSpikeFlags = {
  suddenSurge: false,
  buyDominance: false,
  acceleration: false,
  relativeVolume: false,
  absoluteFloor: false,
};

/** Recommended defaults — Medium sensitivity profile */
export const VOLUME_SPIKE_DEFAULTS = {
  sensitivity: 'medium' as VolumeSpikeSensitivity,
  windowMinutes: 3,
  multiplier: 3,
  buySidePct: 65,
  minUsd: 2_500,
  boostPoints: 8,
  hardFilter: true,
} as const;

type SignalLike = {
  mint?: string;
  symbol?: string;
  isMigration?: boolean;
  nearMigration?: boolean;
  metrics?: {
    volume24hUsd?: number | null;
    volumeH1Usd?: number | null;
    volumeM5Usd?: number | null;
    recentVolumeUsd?: number | null;
    recentBuyVolumeUsd?: number | null;
    volumeBuy24hUsd?: number | null;
    volumeSell24hUsd?: number | null;
    buySellRatio?: number | null;
  } | null;
  birdeye?: {
    volume24hUsd?: number | null;
    volumeBuy24hUsd?: number | null;
    volumeSell24hUsd?: number | null;
    buySellRatio?: number | null;
  } | null;
  antiRug?: {
    volume24hUsd?: number | null;
    volumeH1Usd?: number | null;
    buySellRatio?: number | null;
    birdeye?: {
      volume24hUsd?: number | null;
      buySellRatio?: number | null;
    } | null;
  } | null;
};

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function sensitivity(): VolumeSpikeSensitivity {
  const s = config.filters.volumeSpikeSensitivity;
  return s === 'low' || s === 'high' ? s : 'medium';
}

/** Configurable window; recommended band is 1–5 minutes. */
function windowMinutes(): number {
  const w = Number(config.filters.volumeSpikeWindowMinutes);
  if (!Number.isFinite(w)) return VOLUME_SPIKE_DEFAULTS.windowMinutes;
  return Math.max(1, Math.min(15, Math.round(w)));
}

function surgeMultiplier(level: VolumeSpikeSensitivity): number {
  const configured = Number(config.filters.volumeSpikeMultiplier);
  const base =
    Number.isFinite(configured) && configured > 1
      ? configured
      : VOLUME_SPIKE_DEFAULTS.multiplier;
  const scale = level === 'low' ? 0.85 : level === 'high' ? 1.15 : 1;
  return Math.max(1.5, Math.min(8, base * scale));
}

function buySideThresholdPct(level: VolumeSpikeSensitivity): number {
  const configured = Number(config.filters.volumeSpikeBuySidePct);
  const base =
    Number.isFinite(configured) && configured >= 50
      ? configured
      : VOLUME_SPIKE_DEFAULTS.buySidePct;
  const adj = level === 'low' ? -5 : level === 'high' ? 5 : 0;
  return Math.max(50, Math.min(90, base + adj));
}

function absoluteFloorUsd(
  level: VolumeSpikeSensitivity,
  migration: boolean
): number {
  const configured = Number(config.filters.volumeSpikeMinUsd);
  const base =
    Number.isFinite(configured) && configured >= 0
      ? configured
      : VOLUME_SPIKE_DEFAULTS.minUsd;
  const sensMult = level === 'low' ? 0.75 : level === 'high' ? 1.25 : 1;
  // Near migration: slightly lower floor (fresh books)
  const migMult = migration ? 0.8 : 1;
  return Math.max(0, Math.round(base * sensMult * migMult));
}

function boostPoints(level: VolumeSpikeSensitivity, migration: boolean): number {
  const configured = Number(config.filters.volumeSpikeBoostPoints);
  const base =
    Number.isFinite(configured) && configured > 0
      ? configured
      : VOLUME_SPIKE_DEFAULTS.boostPoints;
  const sensMult = level === 'low' ? 0.65 : level === 'high' ? 1.35 : 1;
  // Extra weight when spike is near migration
  const migBonus = migration ? 1.4 : 1;
  return Math.max(1, Math.min(20, Math.round(base * sensMult * migBonus)));
}

function hardFilterEnabled(): boolean {
  return config.filters.volumeSpikeHardFilter !== false;
}

/**
 * Relative-volume threshold: Medium–High vs token history.
 * Medium ≈ full surge multiplier; High stricter; Low slightly looser.
 */
function relativeVolumeNeed(
  mult: number,
  level: VolumeSpikeSensitivity
): number {
  const scale = level === 'low' ? 0.9 : level === 'high' ? 1.2 : 1.05;
  return mult * scale;
}

/** Acceleration pace threshold (m5×12 / h1). */
function accelerationNeed(level: VolumeSpikeSensitivity): number {
  return level === 'high' ? 2.0 : level === 'low' ? 1.35 : 1.6;
}

export function evaluateVolumeSpike(signal: SignalLike): VolumeSpikeReport {
  const isMigration =
    signal.isMigration === true || signal.nearMigration === true;
  const vol24 =
    num(signal.metrics?.volume24hUsd) ??
    num(signal.birdeye?.volume24hUsd) ??
    num(signal.antiRug?.volume24hUsd) ??
    num(signal.antiRug?.birdeye?.volume24hUsd);
  const volH1 =
    num(signal.metrics?.volumeH1Usd) ??
    num(signal.antiRug?.volumeH1Usd) ??
    num(signal.metrics?.recentVolumeUsd);
  const volM5 = num(signal.metrics?.volumeM5Usd);
  const recentBuy =
    num(signal.metrics?.recentBuyVolumeUsd) ??
    num(signal.metrics?.volumeBuy24hUsd) ??
    num(signal.birdeye?.volumeBuy24hUsd);
  const sell24 =
    num(signal.metrics?.volumeSell24hUsd) ??
    num(signal.birdeye?.volumeSell24hUsd);
  const buy24 =
    num(signal.metrics?.volumeBuy24hUsd) ??
    num(signal.birdeye?.volumeBuy24hUsd);
  const ratio =
    num(signal.metrics?.buySellRatio) ??
    num(signal.birdeye?.buySellRatio) ??
    num(signal.antiRug?.buySellRatio) ??
    num(signal.antiRug?.birdeye?.buySellRatio);

  const winMin = windowMinutes();
  // Prefer short-window volume for 1–5m settings (scale m5 → window)
  let recentVol: number | null = null;
  if (winMin <= 5 && volM5 != null) {
    recentVol = volM5 * (winMin / 5);
  } else if (volH1 != null) {
    recentVol = volH1 * (winMin / 60);
  } else if (volM5 != null) {
    recentVol = volM5 * (winMin / 5);
  } else if (volH1 != null) {
    recentVol = volH1;
  }

  const hasAny =
    vol24 != null ||
    recentVol != null ||
    volM5 != null ||
    recentBuy != null ||
    ratio != null;

  if (!hasAny) {
    return {
      source: 'none',
      flags: { ...EMPTY_FLAGS },
      hitCount: 0,
      strength: 0,
      recentVolUsd: null,
      vol24Usd: vol24,
      buySidePct: null,
      relativeMult: null,
      detail: 'volume spike data unavailable',
      isMigration,
    };
  }

  const level = sensitivity();
  const mult = surgeMultiplier(level);
  const buyPctNeed = buySideThresholdPct(level);
  const floor = absoluteFloorUsd(level, isMigration);
  const relNeed = relativeVolumeNeed(mult, level);
  const flags: VolumeSpikeFlags = { ...EMPTY_FLAGS };

  // Relative volume + sudden surge (short window vs 24h-implied average)
  let relativeMult: number | null = null;
  if (recentVol != null && vol24 != null && vol24 > 0) {
    const expectedInWindow = vol24 * (winMin / (24 * 60));
    relativeMult =
      expectedInWindow > 0 ? recentVol / Math.max(expectedInWindow, 1) : null;
    if (relativeMult != null && relativeMult >= relNeed) {
      flags.relativeVolume = true;
    }
    if (relativeMult != null && relativeMult >= mult) {
      flags.suddenSurge = true;
    }
  } else if (volM5 != null && volH1 != null && volH1 > 0) {
    relativeMult = (volM5 * 12) / volH1;
    if (relativeMult >= relNeed) flags.relativeVolume = true;
    if (relativeMult >= mult * 0.95) flags.suddenSurge = true;
  }

  // Absolute floor — reject near-zero / thin books
  const floorProbe = recentVol ?? volM5 ?? recentBuy ?? volH1;
  if (floorProbe != null && floorProbe >= floor) {
    flags.absoluteFloor = true;
  } else if (floor <= 0) {
    flags.absoluteFloor = true;
  }

  // Buy-side dominance (≥ 65% at Medium default)
  let buySidePct: number | null = null;
  if (buy24 != null && sell24 != null && buy24 + sell24 > 0) {
    buySidePct = (buy24 / (buy24 + sell24)) * 100;
  } else if (ratio != null && ratio > 0) {
    buySidePct = (ratio / (1 + ratio)) * 100;
  } else if (recentBuy != null && recentVol != null && recentVol > 0) {
    buySidePct = Math.min(100, (recentBuy / recentVol) * 100);
  }
  if (buySidePct != null && buySidePct >= buyPctNeed) {
    flags.buyDominance = true;
  } else if (ratio != null && ratio >= buyPctNeed / (100 - buyPctNeed)) {
    // e.g. 65% → ratio ≥ 65/35 ≈ 1.86
    flags.buyDominance = true;
  }

  // Volume acceleration (prefer / require by sensitivity)
  const accelNeed = accelerationNeed(level);
  if (volM5 != null && volH1 != null && volH1 > 0) {
    const accel = (volM5 * 12) / volH1;
    if (accel >= accelNeed) flags.acceleration = true;
  } else if (recentVol != null && vol24 != null && vol24 > 0) {
    const expectedHour = vol24 / 24;
    const windowAsHour = recentVol * (60 / winMin);
    const accel = windowAsHour / Math.max(expectedHour, 1);
    if (accel >= accelNeed) flags.acceleration = true;
  }

  const hitCount = Object.values(flags).filter(Boolean).length;
  let strength = hitCount * 15;
  if (relativeMult != null) {
    // Medium–High relative volume contributes more
    strength += Math.min(28, Math.round((relativeMult / mult) * 14));
  }
  if (buySidePct != null) {
    strength += Math.min(16, Math.round((buySidePct - 50) * 0.55));
  }
  if (flags.acceleration) strength += 8;
  else if (level !== 'low') strength -= 6; // prefer acceleration
  if (isMigration && hitCount >= 2) strength += 14; // near-migration weight
  strength = Math.max(0, Math.min(100, strength));

  const detail =
    `hits=${hitCount}/5 strength=${strength} win=${winMin}m ` +
    `recent=${recentVol != null ? Math.round(recentVol) : '—'} ` +
    `rel×${relativeMult != null ? relativeMult.toFixed(2) : '—'} ` +
    `(need×${relNeed.toFixed(2)}) buy%=${buySidePct != null ? buySidePct.toFixed(0) : '—'} ` +
    `floor=$${floor}` +
    (isMigration ? ' [migration]' : '') +
    ` [${Object.entries(flags)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(',') || 'none'}]`;

  return {
    source: 'proxy',
    flags,
    hitCount,
    strength,
    recentVolUsd: recentVol,
    vol24Usd: vol24,
    buySidePct,
    relativeMult,
    detail,
    isMigration,
  };
}

export function applyVolumeSpikeVerdict(
  report: VolumeSpikeReport,
  options?: { sensitivity?: VolumeSpikeSensitivity }
): VolumeSpikeVerdict {
  if (report.source === 'none') {
    return {
      convictionDelta: 0,
      skip: false,
      influenced: false,
      report,
      logLine: 'volume spike: no data (fail-open)',
    };
  }

  const level = options?.sensitivity ?? sensitivity();
  const hardOn = hardFilterEnabled();
  const minHitsHard = level === 'high' ? 3 : level === 'low' ? 1 : 2;
  // Near migration: slightly fewer hits to pass (combo-friendly)
  const hitsNeeded = report.isMigration
    ? Math.max(1, minHitsHard - 1)
    : minHitsHard;

  let skip = false;
  let skipReason: string | undefined;

  if (hardOn) {
    const floorOk = report.flags.absoluteFloor;
    let qualityOk = report.hitCount >= hitsNeeded;
    const weakStrength = level === 'low' ? 22 : level === 'high' ? 42 : 35;

    // Prefer acceleration (Medium); require it (High) unless near migration
    if (!report.flags.acceleration) {
      if (level === 'high' && !report.isMigration) {
        qualityOk = false;
        if (floorOk) {
          skip = true;
          skipReason = 'volume spike missing acceleration (High sensitivity)';
        }
      } else if (level === 'medium' && !report.isMigration) {
        // Prefer: need one extra hit or stronger composite without accel
        qualityOk =
          report.hitCount >= hitsNeeded + 1 || report.strength >= weakStrength + 12;
      }
    }

    if (!skip) {
      if (!floorOk) {
        skip = true;
        skipReason = `volume spike floor fail (need ≥$${absoluteFloorUsd(level, report.isMigration)})`;
      } else if (!qualityOk && report.strength < weakStrength) {
        skip = true;
        skipReason = `volume spike weak (${report.hitCount}/${hitsNeeded} signals, strength ${report.strength})`;
      }
    }
  }

  let convictionDelta = 0;
  const strongHits = level === 'high' ? 3 : 2;
  const strongStrength = level === 'high' ? 58 : level === 'low' ? 38 : 48;
  const accelOk =
    report.flags.acceleration ||
    level === 'low' ||
    report.isMigration;
  const strongEnough =
    (report.hitCount >= strongHits ||
      report.strength >= strongStrength ||
      (report.isMigration && report.hitCount >= 2)) &&
    accelOk;

  if (strongEnough) {
    convictionDelta = boostPoints(level, report.isMigration);
    if (report.isMigration && report.hitCount >= 2) {
      // Extra weight for post-migration / near-migration + spike
      convictionDelta = Math.min(20, convictionDelta + 3);
    }
    if (report.flags.acceleration && report.flags.relativeVolume) {
      convictionDelta = Math.min(20, convictionDelta + 1);
    }
  }

  const influenced = skip || convictionDelta > 0;
  const logLine =
    `volume spike ${level}: Δconv=${
      convictionDelta > 0 ? '+' : ''
    }${convictionDelta}` +
    (skip ? ' SKIP' : '') +
    (report.isMigration && convictionDelta > 0 ? ' POST-MIG-COMBO' : '') +
    ` · ${report.detail}`;

  return {
    convictionDelta,
    skip,
    skipReason,
    influenced,
    report,
    logLine,
  };
}

export function resolveVolumeSpikeForSignal(
  signal: SignalLike
): VolumeSpikeVerdict | null {
  if (!isStrategyEnabled('volume_spike_filter')) return null;
  if (config.filters.enableVolumeSpikeFilter === false) return null;

  const report = evaluateVolumeSpike(signal);
  return applyVolumeSpikeVerdict(report);
}

export function logVolumeSpikeDecision(
  symbol: string,
  verdict: VolumeSpikeVerdict,
  outcome: 'boost' | 'skip' | 'neutral'
): void {
  if (!verdict.influenced && outcome === 'neutral') return;
  logStrategyDecision(
    'volume_spike_filter',
    outcome === 'skip' ? 'skip' : 'take',
    `${symbol}: ${verdict.logLine}`
  );
  const tag =
    outcome === 'skip' ? 'SKIP' : outcome === 'boost' ? 'BOOST' : 'INFO';
  console.log(`[vol-spike] ${tag} ${symbol} — ${verdict.logLine}`);
}
