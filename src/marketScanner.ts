/**
 * Market Scanner — autonomous Pump.fun / Dex opportunity discovery.
 *
 * Polls recent launches + trending tokens, ranks by multi-TF TA / playbooks /
 * regime / volume, and feeds candidates into the monitor as non-wallet signals.
 * Wallet copy stays independent; hybrid when tracked wallets also appear.
 */

import { config, HARD_FILTER_FLOORS } from './config';
import { logger, errorToMeta } from './logger';
import {
  enrichLaunchWithRealCandles,
  fetchSolUsdPrice,
  mapPool,
  type LaunchEvent,
} from './marketData';
import { fetchRecentLaunches } from './marketData';
import { fetchBondingCurve, summarizeBondingCurve } from './bondingCurve';
import { isStrategyEnabled } from './strategies';
import { seedPriceHistoryFromCandles } from './technicalLevels';
import { analyzeChartPatterns } from './chartPatterns';
import {
  getTechnicalLevelsForStrategy,
} from './technicalLevels';
import { evaluateIndicators } from './indicators';
import { evaluatePostRunDip } from './postRunDip';
import { classifyScannerPlaybook } from './scannerPlaybooks';
import {
  effectiveMinConfluence,
  effectiveMinRankScore,
  getCachedMarketRegime,
  getMarketRegime,
  isMomentumPlaybookDisabled,
} from './marketRegime';
import { getScannerOutcomeSummary } from './scannerOutcomes';
import {
  fetchJupiterPumpTrending,
  getJupiterTokensStatus,
} from './jupiterTokens';

export const MARKET_SCANNER_WALLET = 'market-scanner';
export const MARKET_SCANNER_NAME = 'Market Scanner';

export type ScannerCandidateStatus = 'seen' | 'queued' | 'skipped' | 'taken';

export interface ScannerCandidate {
  id: string;
  mint: string;
  symbol: string;
  name: string;
  timestamp: number;
  status: ScannerCandidateStatus;
  rankScore: number;
  reasons: string[];
  skipReason?: string;
  source: LaunchEvent['source'] | 'trending';
  migrated: boolean;
  liquidityUsd?: number;
  marketCapUsd?: number;
  volumeUsd?: number;
  volumeH1Usd?: number;
  volumeM5Usd?: number;
  volumeH6Usd?: number;
  priceChangeH1Pct?: number;
  priceChangePct?: number;
  holderCount?: number;
  isPumpFun?: boolean;
  organicScore?: number;
  jupiterCategory?: string;
  /** Soft prefer this Smart Bot profile when specialty feed tagged the mint */
  preferredProfileId?: string;
  specialtyFeed?: 'jupiter' | 'kolscan';
  /** Distinct KOL wallets when from Kolscan specialty feed */
  kolCount?: number;
  /** Graduation watch / near-mig */
  nearMigration?: boolean;
  curveProgressPct?: number | null;
  nearKeyFib?: boolean;
  nearSupport?: boolean;
  nearResistance?: boolean;
  /** Nearest support / Fib price (SOL) when known — for dip reclaim */
  supportPriceSol?: number | null;
  lastPriceSol?: number | null;
  chartPatternIds?: string[];
  indicatorSummary?: string;
  candleSource?: 'real' | 'synthetic';
  playbook?: string;
  confluence?: number;
  mtfAligned?: boolean;
  veto?: string;
}

export interface ScannerStatus {
  running: boolean;
  lastPollAt: number | null;
  lastPollMs: number | null;
  candidatesInFeed: number;
  lastError: string | null;
  enabled: boolean;
  regime?: {
    regime: string;
    solChangeH1: number;
    solChangeH24: number;
    rsHint?: string;
  };
  outcomes?: ReturnType<typeof getScannerOutcomeSummary>;
  jupiter?: ReturnType<typeof getJupiterTokensStatus>;
  skipBuckets?: Array<{ reason: string; count: number }>;
  degenRelaxed?: boolean;
  /** True when Risk Off relaxes TA/volume floors for soak testing */
  riskOffRelaxed?: boolean;
  /** Times poll/enrich was skipped because wallet buy queue exceeded threshold */
  skippedForBuyQueue?: number;
  lastSkipReason?: string | null;
  buyQueueYieldThreshold?: number;
}

type ScannerHandler = (candidate: ScannerCandidate & { launch: LaunchEvent }) => Promise<void>;

const MAX_FEED = 120;
const feed: ScannerCandidate[] = [];
const cooldowns = new Map<string, number>(); // mint → earliest retry ms
const seenThisSession = new Set<string>();

let pollTimer: ReturnType<typeof setInterval> | null = null;
let running = false;
let pollInFlight = false;
let lastPollAt: number | null = null;
let lastPollMs: number | null = null;
let lastError: string | null = null;
let handler: ScannerHandler | null = null;

function baseScannerCfg() {
  return (
    config.marketScanner ?? {
      pollIntervalMs: 15_000,
      lookbackHours: 6,
      maxCandidatesPerPoll: 15,
      cooldownMs: 45 * 60_000,
      minRankScore: 42,
      requireTaSetup: true,
      minPatternConfidence: 55,
      preferRealCandles: true,
      syntheticPenalty: 8,
      minConfluenceScore: 40,
      playbookMode: 'auto' as const,
      pauseScannerOnlyInRiskOff: true,
      requireRsForMomentum: true,
      requireMtfAligned: false,
      minLiquidityUsd: 8000,
      minOrganicScore: 0,
      preferOrganicVolume: true,
      jupiterTrendingEnabled: true,
      jupiterCategory: 'toptraded' as const,
      jupiterPumpFunOnly: true,
      jupiterLimit: 100,
      jupiterMergeIntervals: true,
      minVolumeM5Usd: 1000,
      minVolumeH1Usd: 5000,
      minVolumeH6Usd: 10000,
      minVolumeH24Usd: 15_000,
    }
  );
}

/**
 * Effective scanner knobs. Risk Off auto-relax TA/vol gates so ops-only
 * soak mode is not silently vetoed by Market Scanner thresholds.
 */
function scannerCfg() {
  const cfg = { ...baseScannerCfg() };
  if (config.riskLevel === 'off') {
    cfg.requireTaSetup = false;
    cfg.minRankScore = Math.min(cfg.minRankScore ?? 42, 20);
    cfg.minConfluenceScore = Math.min(cfg.minConfluenceScore ?? 40, 10);
    cfg.minLiquidityUsd = 0;
    cfg.minVolumeM5Usd = 0;
    cfg.minVolumeH1Usd = 0;
    cfg.minVolumeH6Usd = 0;
    cfg.minVolumeH24Usd = 0;
    cfg.minOrganicScore = 0;
    cfg.pauseScannerOnlyInRiskOff = false;
  }
  return cfg;
}

/** Optional hook — monitor sets this so scanner yields while wallet buys drain. */
let pendingBuyQueueDepth: () => number = () => 0;
/** Soften: only skip whole poll / enrich when wallet buy queue is truly backed up. */
const SCANNER_YIELD_QUEUE_DEPTH = 12;
/** Mid-enrich: abort individual enrich when drain is moderately busy. */
const SCANNER_MID_ENRICH_YIELD_DEPTH = 4;
let skippedForBuyQueue = 0;
let lastSkipReason: string | null = null;

export function setScannerBuyQueueDepthFn(fn: () => number): void {
  pendingBuyQueueDepth = fn;
}

export function isMarketScannerAddress(addr: string | undefined | null): boolean {
  return String(addr || '') === MARKET_SCANNER_WALLET;
}

export function isMarketScannerSignal(signal: {
  wallets?: string[];
  entrySource?: string | null;
  walletNames?: string[];
}): boolean {
  if (signal.entrySource === 'scanner' || signal.entrySource === 'hybrid') {
    return true;
  }
  const wallets = signal.wallets ?? [];
  if (wallets.some((w) => isMarketScannerAddress(w))) return true;
  const names = signal.walletNames ?? [];
  return names.some((n) => /market\s*scanner/i.test(String(n)));
}

export function onScannerCandidate(cb: ScannerHandler): void {
  handler = cb;
}

export function getScannerFeed(limit = 40): ScannerCandidate[] {
  const n = Math.max(1, Math.min(MAX_FEED, limit));
  // Strip nested launch (candles payload) — pushFeed may store the full object
  return feed.slice(0, n).map((row) => {
    const { launch: _launch, ...plain } = row as ScannerCandidate & {
      launch?: unknown;
    };
    return plain;
  });
}

export function getScannerSkipBuckets(limit = 8): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of feed) {
    const key =
      row.status === 'skipped'
        ? String(row.skipReason || 'skipped').slice(0, 80)
        : row.status === 'taken'
          ? 'taken'
          : row.status === 'queued'
            ? 'queued'
            : 'seen';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(1, limit));
}

export function getScannerStatus(): ScannerStatus {
  const regime = getCachedMarketRegime();
  return {
    running,
    lastPollAt,
    lastPollMs,
    candidatesInFeed: feed.length,
    lastError,
    enabled: isStrategyEnabled('ta_market_scanner'),
    regime: {
      regime: regime.regime,
      solChangeH1: regime.solChangeH1,
      solChangeH24: regime.solChangeH24,
      rsHint: regime.rsHint,
    },
    outcomes: getScannerOutcomeSummary(),
    jupiter: getJupiterTokensStatus(),
    skipBuckets: getScannerSkipBuckets(8),
    degenRelaxed: false,
    riskOffRelaxed: config.riskLevel === 'off',
    skippedForBuyQueue,
    lastSkipReason,
    buyQueueYieldThreshold: SCANNER_YIELD_QUEUE_DEPTH,
  };
}

export function annotateScannerCandidate(
  mint: string,
  patch: Partial<Pick<ScannerCandidate, 'status' | 'skipReason'>>
): void {
  for (const row of feed) {
    if (row.mint === mint && (row.status === 'seen' || row.status === 'queued')) {
      Object.assign(row, patch);
      break;
    }
  }
}

function pushFeed(row: ScannerCandidate): void {
  feed.unshift(row);
  if (feed.length > MAX_FEED) feed.length = MAX_FEED;
}

function hardFloorsOk(event: LaunchEvent): boolean {
  // Risk OFF: scanner candidates are not volume/liq gated here
  if (config.riskLevel === 'off') return true;

  const cfg = scannerCfg();
  const minLiqGlobal = config.filters.minLiquidity ?? 0;
  const minLiqLocal =
    cfg.minLiquidityUsd != null && cfg.minLiquidityUsd > 0
      ? cfg.minLiquidityUsd
      : 0;
  const minLiq = Math.max(minLiqGlobal, minLiqLocal);
  const minMc = config.filters.minMarketCapUsd ?? 0;
  const liq = event.liquidityUsd ?? 0;
  const mc = event.marketCapUsd ?? 0;
  if (minLiq > 0 && liq > 0 && liq < minLiq) return false;
  if (minMc > 0 && mc > 0 && mc < minMc) return false;

  const preferOrg = cfg.preferOrganicVolume !== false;
  const volM5 =
    preferOrg && event.volumeOrganicM5Usd != null && event.volumeOrganicM5Usd > 0
      ? event.volumeOrganicM5Usd
      : (event.volumeM5Usd ?? 0);
  const volH1 =
    preferOrg && event.volumeOrganicH1Usd != null && event.volumeOrganicH1Usd > 0
      ? event.volumeOrganicH1Usd
      : (event.volumeH1Usd ?? 0);
  const volH6 =
    preferOrg && event.volumeOrganicH6Usd != null && event.volumeOrganicH6Usd > 0
      ? event.volumeOrganicH6Usd
      : (event.volumeH6Usd ?? 0);
  const volH24 =
    preferOrg && event.volumeOrganicUsd != null && event.volumeOrganicUsd > 0
      ? event.volumeOrganicUsd
      : (event.volumeUsd ?? 0);

  const floorM5 = cfg.minVolumeM5Usd ?? 0;
  const floorH1 = cfg.minVolumeH1Usd ?? 0;
  const floorH6 = cfg.minVolumeH6Usd ?? 0;
  const floorH24 = cfg.minVolumeH24Usd ?? 0;
  // Only enforce a window floor when we have a reading for that window
  // (or a 24h proxy). Missing data does not hard-fail Dex-only launches.
  if (floorM5 > 0 && volM5 > 0 && volM5 < floorM5) return false;
  if (floorH1 > 0 && volH1 > 0 && volH1 < floorH1) return false;
  if (floorH6 > 0 && volH6 > 0 && volH6 < floorH6) return false;
  if (floorH24 > 0 && volH24 > 0 && volH24 < floorH24) return false;

  // Jupiter-sourced tokens with known organicScore must clear the floor
  const minOrg = cfg.minOrganicScore ?? 0;
  if (
    minOrg > 0 &&
    event.organicScore != null &&
    Number.isFinite(event.organicScore) &&
    event.organicScore < minOrg
  ) {
    return false;
  }

  return true;
}

function crudeLiqVolScore(event: LaunchEvent): number {
  return (event.liquidityUsd ?? 0) / 1000 + (event.volumeUsd ?? 0) / 5000;
}

/** Multi-TF: entry = last ~32 bars; structure = every 3rd bar. */
function analyzeMultiTf(closes: number[]): {
  mtfAligned: boolean;
  structureBearish: boolean;
  structureHh: boolean;
  entryEmaBull: boolean;
} {
  if (closes.length < 16) {
    return {
      mtfAligned: false,
      structureBearish: false,
      structureHh: false,
      entryEmaBull: false,
    };
  }
  const entry = closes.slice(-Math.min(32, closes.length));
  const structure: number[] = [];
  for (let i = closes.length - 1; i >= 0 && structure.length < 24; i -= 3) {
    structure.unshift(closes[i]!);
  }
  const ema = (vals: number[], period: number): number | null => {
    if (vals.length < period) return null;
    const k = 2 / (period + 1);
    let prev = vals.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < vals.length; i++) {
      prev = vals[i]! * k + prev * (1 - k);
    }
    return prev;
  };
  const eFast = ema(entry, 8);
  const eSlow = ema(entry, 21);
  const entryEmaBull =
    eFast != null && eSlow != null && eFast >= eSlow * 0.995;
  const sFast = ema(structure, 5);
  const sSlow = ema(structure, 12);
  const structureEmaBull =
    sFast != null && sSlow != null && sFast >= sSlow * 0.99;
  let hh = 0;
  for (let i = 1; i < structure.length; i++) {
    if (structure[i]! > structure[i - 1]!) hh += 1;
  }
  const structureHh = structure.length >= 4 && hh >= Math.ceil(structure.length * 0.45);
  const structureBearish = !structureEmaBull && !structureHh;
  const mtfAligned = entryEmaBull && !structureBearish;
  return { mtfAligned, structureBearish, structureHh, entryEmaBull };
}

export interface RankLaunchResult {
  score: number;
  reasons: string[];
  nearKeyFib: boolean;
  nearSupport: boolean;
  nearResistance: boolean;
  chartPatternIds: string[];
  indicatorSummary?: string;
  taSetup: boolean;
  candleSource: 'real' | 'synthetic';
  playbook?: string;
  confluence?: number;
  mtfAligned?: boolean;
  veto?: string;
  supportPriceSol?: number | null;
  lastPriceSol?: number | null;
}

/** Rank a launch for scanner entry — higher is better. */
export function rankLaunchForScanner(event: LaunchEvent): RankLaunchResult {
  const cfg = scannerCfg();
  const reasons: string[] = [];
  let score = 20;
  let veto: string | undefined;

  const liq = event.liquidityUsd ?? 0;
  const vol = event.volumeUsd ?? 0;
  const mc = event.marketCapUsd ?? 0;
  const candleSource: 'real' | 'synthetic' =
    event.candleSource === 'real' ? 'real' : 'synthetic';

  if (candleSource === 'synthetic') {
    const pen = Number(cfg.syntheticPenalty) || 8;
    score -= pen;
    reasons.push(`synth-${pen}`);
  } else {
    score += 4;
    reasons.push('real OHLCV');
  }

  if (liq >= 25_000) {
    score += 12;
    reasons.push('liq>=25k');
  } else if (liq >= 10_000) {
    score += 8;
    reasons.push('liq>=10k');
  } else if (liq >= 8_000) {
    score += 4;
    reasons.push('liq ok');
  }

  // Volume — prefer H1/M5 when available
  const volH1 = event.volumeH1Usd;
  const volM5 = event.volumeM5Usd;
  if (volH1 != null && Number.isFinite(volH1)) {
    if (volH1 >= 40_000) {
      score += 14;
      reasons.push('h1 vol spike');
    } else if (volH1 >= 15_000) {
      score += 9;
      reasons.push('h1 vol ok');
    } else if (volH1 < 800) {
      score -= 8;
      reasons.push('dead h1 vol');
    }
    if (volM5 != null && volH1 > 0 && volM5 / (volH1 / 12) >= 2.2) {
      score += 6;
      reasons.push('m5 spike');
    }
  } else if (vol >= 50_000) {
    score += 14;
    reasons.push('vol>=50k');
  } else if (vol >= 20_000) {
    score += 9;
    reasons.push('vol>=20k');
  } else if (vol >= 10_000) {
    score += 5;
    reasons.push('vol ok');
  } else if (vol > 0 && vol < 2_000) {
    score -= 6;
    reasons.push('dead vol');
  }

  if (mc > 0 && mc < 80_000) {
    score += 6;
    reasons.push('early MC');
  } else if (mc >= 80_000 && mc <= 450_000) {
    score += 8;
    reasons.push('sweet MC');
  }

  if (event.migrated) {
    score += 5;
    reasons.push('migrated');
  }
  if (event.isPumpFun) {
    score += 3;
    reasons.push('pump');
  }

  if (event.candles?.length) {
    seedPriceHistoryFromCandles(event.mint, event.candles);
  }

  let nearKeyFib = false;
  let nearSupport = false;
  let nearResistance = false;
  let supportPriceSol: number | null = null;
  const lastPriceSol =
    event.lastPriceSol > 0
      ? event.lastPriceSol
      : event.entryPriceSol > 0
        ? event.entryPriceSol
        : null;
  const chartPatternIds: string[] = [];
  let indicatorSummary: string | undefined;
  let taSetup = false;
  let techSnap = null as ReturnType<typeof getTechnicalLevelsForStrategy> | null;
  let patterns = null as ReturnType<typeof analyzeChartPatterns> | null;
  let ind = null as ReturnType<typeof evaluateIndicators> | null;

  const closes = (event.candles ?? [])
    .map((c) => Number(c.priceSol ?? 0))
    .filter((p) => p > 0);
  const mtf = analyzeMultiTf(closes);

  try {
    techSnap = getTechnicalLevelsForStrategy({
      mint: event.mint,
      priceSol: event.lastPriceSol || event.entryPriceSol,
      candles: event.candles,
    });
    nearKeyFib = Boolean(techSnap.nearFibZone);
    nearSupport = Boolean(techSnap.nearSupportZone);
    const res = techSnap.nearestResistance;
    nearResistance =
      res != null &&
      res.distancePct != null &&
      Math.abs(res.distancePct) <= 4;
    const supPx = techSnap.nearestSupport?.mid;
    const fibPx = techSnap.fibZones?.[0]?.price;
    if (supPx != null && Number.isFinite(supPx) && supPx > 0) {
      supportPriceSol = Number(supPx);
    } else if (fibPx != null && Number.isFinite(fibPx) && fibPx > 0) {
      supportPriceSol = Number(fibPx);
    }
    if (nearKeyFib) {
      score += 12;
      reasons.push('near Fib');
      taSetup = true;
    }
    if (nearSupport) {
      score += 10;
      reasons.push('near support');
      taSetup = true;
    }
    if (nearResistance) {
      const dist = Math.abs(res?.distancePct ?? 99);
      // Penalize sitting under resistance without breakout evidence later
      score -= dist <= 2 ? 8 : 4;
      reasons.push('near resist');
    }
  } catch {
    /* thin history */
  }

  try {
    patterns = analyzeChartPatterns({
      mint: event.mint,
      priceSol: event.lastPriceSol || event.entryPriceSol,
      candles: event.candles,
      volumeH1Usd: event.volumeH1Usd ?? (event.volumeUsd != null ? event.volumeUsd / 18 : null),
      volumeM5Usd: event.volumeM5Usd ?? null,
      priceChange24hPct: event.priceChangePct ?? null,
      priceChangeH1Pct: event.priceChangeH1Pct ?? null,
      marketCapUsd: event.marketCapUsd ?? null,
      ignoreStrategyGates: true,
    });
    const minConf = cfg.minPatternConfidence ?? 55;
    for (const hit of patterns.bullish ?? []) {
      if (hit.confidence >= minConf) {
        chartPatternIds.push(hit.id);
        score += Math.min(14, Math.round(hit.confidence / 8));
        reasons.push(`pat:${hit.id}`);
        taSetup = true;
        if (hit.breakout) {
          score += 4;
          reasons.push('breakout');
          // Relieve resistance penalty on confirmed breakout
          if (nearResistance) score += 6;
        }
      }
    }
    const hardFloor = minConf + 10;
    for (const hit of patterns.bearish ?? []) {
      if (hit.confidence >= hardFloor) {
        veto = `bearish:${hit.id}`;
        score -= 18;
        reasons.push(`veto:${hit.id}`);
        break;
      } else if (hit.confidence >= minConf) {
        score -= 8;
        reasons.push(`bear:${hit.id}`);
      }
    }
  } catch {
    /* ignore */
  }

  try {
    ind = evaluateIndicators({
      mint: event.mint,
      candles: event.candles,
      priceSol: event.lastPriceSol || event.entryPriceSol,
    });
    if (ind.available) {
      indicatorSummary = ind.summary;
      score += ind.scoreDelta;
      if (ind.setup) {
        taSetup = true;
        reasons.push(...ind.flags.slice(0, 3));
      }
    }
  } catch {
    /* ignore */
  }

  // Post-run dip boost (lightweight — does not require strategy ON)
  let postRunDipQualifies = false;
  try {
    const prd = evaluatePostRunDip({
      mint: event.mint,
      symbol: event.symbol,
      isMigration: event.migrated,
      candles: event.candles,
      metrics: {
        priceChange24hPct: event.priceChangePct ?? null,
        priceChangeH1Pct: event.priceChangeH1Pct ?? null,
        volume24hUsd: event.volumeUsd ?? null,
        volumeH1Usd: event.volumeH1Usd ?? null,
        volumeM5Usd: event.volumeM5Usd ?? null,
        liquidityUsd: event.liquidityUsd ?? null,
        holderCountEstimate: event.holderCount ?? null,
        pairCreatedAtMs: event.launchedAt ?? null,
      },
      tokenAgeHours:
        event.launchedAt > 0
          ? (Date.now() - event.launchedAt) / 3_600_000
          : null,
    });
    if (prd.qualifies) {
      postRunDipQualifies = true;
      score += 10;
      taSetup = true;
      reasons.push('prd');
    }
  } catch {
    /* ignore */
  }

  const chg = event.priceChangePct ?? 0;
  if (chg >= 15 && chg <= 120) {
    score += 6;
    reasons.push('momentum');
  } else if (chg < -25 && chg > -55) {
    score += 7;
    reasons.push('pullback');
    taSetup = true;
  }

  // Multi-TF structure gates for breakout/momentum
  if (mtf.mtfAligned) {
    score += 6;
    reasons.push('mtf');
  }

  const rsiReset =
    ind?.flags?.includes('rsi_reset') === true ||
    ind?.flags?.includes('rsi_oversold') === true;

  const pb = classifyScannerPlaybook({
    migrated: event.migrated,
    isPumpFun: event.isPumpFun,
    priceChangePct: event.priceChangePct,
    priceChangeH1Pct: event.priceChangeH1Pct,
    nearKeyFib,
    nearSupport,
    nearResistance,
    tech: techSnap?.snapshot ?? null,
    patterns,
    indicators: ind,
    postRunDipQualifies,
    mtfAligned: mtf.mtfAligned,
    structureBearish: mtf.structureBearish,
    rsiReset,
    minConfluence: effectiveMinConfluence(cfg.minConfluenceScore ?? 40),
  });

  if (pb.playbook === 'momentum_continuation' && isMomentumPlaybookDisabled()) {
    score -= 15;
    reasons.push('mom blocked risk_off');
    if (!veto) veto = 'momentum_disabled_risk_off';
  }

  if (
    pb.playbook === 'momentum_continuation' &&
    cfg.requireRsForMomentum !== false
  ) {
    const regime = getCachedMarketRegime();
    const tokH1 = event.priceChangeH1Pct ?? event.priceChangePct ?? 0;
    const rel = tokH1 - regime.solChangeH1;
    if (rel < 2) {
      score -= 10;
      reasons.push('weak RS');
    } else {
      score += 5;
      reasons.push('RS ok');
    }
  }

  // Breakout / momentum need non-bearish structure; dip_reclaim allows soft-bear + RSI
  if (
    (pb.playbook === 'bull_flag_break' ||
      pb.playbook === 'momentum_continuation') &&
    mtf.structureBearish
  ) {
    score -= 12;
    reasons.push('struct bear');
    if (!veto) veto = 'structure_bearish';
  }
  if (pb.playbook === 'dip_reclaim' && mtf.structureBearish && !rsiReset) {
    score -= 6;
    reasons.push('dip needs rsi');
  }

  if (pb.playbook) {
    reasons.push(...pb.reasons.filter((r) => !reasons.includes(r)).slice(0, 3));
    score += Math.round((pb.confluence - 50) / 8);
  }

  const minConfluence = effectiveMinConfluence(cfg.minConfluenceScore ?? 40);
  if (!pb.allowed || (pb.confluence ?? 0) < minConfluence) {
    if (cfg.requireTaSetup !== false) {
      // Quality gate — treat as weak / skip later
      if (!veto) veto = veto ?? `confluence<${minConfluence}`;
      score -= 8;
    }
  }

  // Regime score adjust
  const regime = getCachedMarketRegime().regime;
  if (regime === 'risk_off') {
    score -= 6;
    reasons.push('risk_off');
  } else if (regime === 'risk_on') {
    score += 3;
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons,
    nearKeyFib,
    nearSupport,
    nearResistance,
    chartPatternIds,
    indicatorSummary,
    taSetup,
    candleSource,
    playbook: pb.playbook ?? undefined,
    confluence: pb.confluence,
    mtfAligned: mtf.mtfAligned,
    veto,
    supportPriceSol,
    lastPriceSol,
  };
}

async function enrichCurve(event: LaunchEvent): Promise<{
  bonus: number;
  nearMigration: boolean;
  progressPct: number | null;
}> {
  try {
    const curve = await fetchBondingCurve(event.mint);
    if (!curve) return { bonus: 0, nearMigration: false, progressPct: null };
    const sum = summarizeBondingCurve(curve);
    let bonus = 0;
    if (sum.nearMigration) bonus += 10;
    if ((sum.progressPct ?? 0) >= 70 && (sum.progressPct ?? 0) < 99) {
      bonus += 6;
    }
    return {
      bonus,
      nearMigration: Boolean(sum.nearMigration),
      progressPct: sum.progressPct ?? null,
    };
  } catch {
    return { bonus: 0, nearMigration: false, progressPct: null };
  }
}

export async function collectScannerUniverse(): Promise<LaunchEvent[]> {
  const cfg = scannerCfg();
  const toMs = Date.now();
  const fromMs = toMs - Math.max(1, cfg.lookbackHours) * 3_600_000;
  const { events } = await fetchRecentLaunches({
    fromMs,
    toMs,
    maxResults: 80,
    allowSynthetic: false,
  });

  const byMint = new Map<string, LaunchEvent>();
  for (const e of events) {
    if (e?.mint) byMint.set(e.mint, e);
  }
  const dexCount = byMint.size;

  if (cfg.jupiterTrendingEnabled !== false) {
    try {
      const solUsd = await fetchSolUsdPrice();
      const jup = await fetchJupiterPumpTrending({
        category: cfg.jupiterCategory ?? 'toptraded',
        limit: cfg.jupiterLimit ?? 50,
        pumpFunOnly: cfg.jupiterPumpFunOnly !== false,
        mergeIntervals: cfg.jupiterMergeIntervals !== false,
        preferOrganicVolume: cfg.preferOrganicVolume !== false,
        solUsd,
      });
      let added = 0;
      for (const e of jup) {
        if (!e?.mint) continue;
        if (!byMint.has(e.mint)) {
          byMint.set(e.mint, e);
          added += 1;
        }
      }
      console.log(
        `[marketScanner] universe dex/gmgn=${dexCount} + jupiter=${jup.length} (new ${added}) → ${byMint.size}`
      );
    } catch (err) {
      logger.warn('MarketScanner', 'Jupiter trending merge failed', errorToMeta(err));
    }
  }

  return [...byMint.values()];
}

/**
 * Score + filter universe; returns top candidates ready for monitor.
 * Enriches only a crude top-N (early-cap) with bounded parallelism.
 */
export async function selectScannerCandidates(
  events: LaunchEvent[]
): Promise<Array<ScannerCandidate & { launch: LaunchEvent }>> {
  const cfg = scannerCfg();
  const now = Date.now();
  const maxOut = Math.max(1, cfg.maxCandidatesPerPoll);
  // Enrich budget: 2× final cap, hard ceiling 40 to protect shared APIs
  const enrichBudget = Math.min(40, Math.max(maxOut * 2, maxOut));

  // Prefetch regime (cached)
  try {
    await getMarketRegime();
  } catch {
    /* ignore */
  }

  // Yield to wallet buy drain only when the queue is truly backed up
  const qDepth = pendingBuyQueueDepth();
  if (qDepth > SCANNER_YIELD_QUEUE_DEPTH) {
    skippedForBuyQueue += 1;
    lastSkipReason = `defer enrich — ${qDepth} wallet buy(s) queued (threshold ${SCANNER_YIELD_QUEUE_DEPTH})`;
    console.log(
      `[marketScanner] Deferring enrich — ${qDepth} wallet buy(s) queued ` +
        `(threshold ${SCANNER_YIELD_QUEUE_DEPTH})`
    );
    return [];
  }

  const minRank = effectiveMinRankScore(cfg.minRankScore);
  const minConfluence = effectiveMinConfluence(cfg.minConfluenceScore ?? 40);
  const requireTa = cfg.requireTaSetup !== false;

  // Crude pre-sort + hard floors before any enrich
  const prefiltered = [...events]
    .filter((raw) => {
      if (!raw.mint) return false;
      const cd = cooldowns.get(raw.mint) ?? 0;
      if (cd > now) return false;
      return hardFloorsOk(raw);
    })
    .sort((a, b) => crudeLiqVolScore(b) - crudeLiqVolScore(a))
    .slice(0, enrichBudget);

  type Enriched = ScannerCandidate & { launch: LaunchEvent };
  const enriched = await mapPool(prefiltered, 3, async (raw) => {
    // Re-check queue mid-enrich so wallet path stays priority under real backlog
    if (pendingBuyQueueDepth() > SCANNER_MID_ENRICH_YIELD_DEPTH) return null;

    let event: LaunchEvent = raw;
    try {
      event = await enrichLaunchWithRealCandles(raw);
    } catch {
      event = { ...raw, candleSource: raw.candleSource ?? 'synthetic' };
    }

    const ranked = rankLaunchForScanner(event);
    const curve = await enrichCurve(event);
    let score = Math.min(100, ranked.score + curve.bonus);
    if (curve.bonus > 0) ranked.reasons.push('curve');
    if (curve.nearMigration && ranked.playbook !== 'curve_migration_sniper') {
      score = Math.min(100, score + 4);
    }

    // Curve-first watch offer — even if TA / rank gates reject this mint below
    if (
      !event.migrated &&
      (curve.nearMigration ||
        (curve.progressPct != null && curve.progressPct >= 70))
    ) {
      try {
        const { offerMigrationGradWatchFromCandidate } =
          require('./migrationGradWatch') as typeof import('./migrationGradWatch');
        offerMigrationGradWatchFromCandidate({
          mint: event.mint,
          symbol: event.symbol,
          name: event.name,
          marketCapUsd: event.marketCapUsd,
          volumeH1Usd: event.volumeH1Usd,
          holderCount: event.holderCount,
          curveProgressPct: curve.progressPct,
          nearMigration: curve.nearMigration,
        });
      } catch {
        /* non-fatal */
      }
    }

    if (ranked.veto?.startsWith('bearish:')) return null;
    if (score < minRank) return null;
    if (requireTa && !ranked.taSetup) return null;
    if (cfg.requireMtfAligned === true && !ranked.mtfAligned) return null;
    if (
      requireTa &&
      (ranked.confluence == null || ranked.confluence < minConfluence)
    ) {
      return null;
    }
    if (requireTa && !ranked.playbook) return null;

    const id = `scan-${event.mint.slice(0, 8)}-${now}`;
    const row: Enriched = {
      id,
      mint: event.mint,
      symbol: event.symbol,
      name: event.name,
      timestamp: now,
      status: 'seen',
      rankScore: score,
      reasons: ranked.reasons,
      source: event.source,
      migrated: Boolean(event.migrated),
      liquidityUsd: event.liquidityUsd,
      marketCapUsd: event.marketCapUsd,
      volumeUsd: event.volumeUsd,
      volumeH1Usd: event.volumeH1Usd,
      volumeM5Usd: event.volumeM5Usd,
      volumeH6Usd: event.volumeH6Usd,
      priceChangeH1Pct: event.priceChangeH1Pct,
      priceChangePct: event.priceChangePct,
      holderCount: event.holderCount,
      isPumpFun: event.isPumpFun,
      organicScore: event.organicScore,
      jupiterCategory:
        event.source === 'jupiter' ? cfg.jupiterCategory : undefined,
      nearMigration: curve.nearMigration,
      curveProgressPct: curve.progressPct,
      nearKeyFib: ranked.nearKeyFib,
      nearSupport: ranked.nearSupport,
      nearResistance: ranked.nearResistance,
      supportPriceSol: ranked.supportPriceSol ?? null,
      lastPriceSol: ranked.lastPriceSol ?? null,
      chartPatternIds: ranked.chartPatternIds,
      indicatorSummary: ranked.indicatorSummary,
      candleSource: ranked.candleSource,
      playbook: ranked.playbook,
      confluence: ranked.confluence,
      mtfAligned: ranked.mtfAligned,
      veto: ranked.veto,
      launch: event,
    };
    return row;
  });

  enriched.sort((a, b) => b.rankScore - a.rankScore);
  const out = enriched.slice(0, maxOut);
  console.log(
    `[marketScanner] enrich ${prefiltered.length}/${events.length} → ` +
      `${enriched.length} ranked → ${out.length} capped` +
      (config.riskLevel === 'off' ? ' (risk-off-relaxed)' : '')
  );
  return out;
}

/**
 * Curve-first graduation watch pass — does NOT require TA / Fib / rank gates.
 * Scans pump.fun (and Jupiter pump) universe mints for bonding-curve ≥ watch %,
 * so near-mig setups can land on the Micro Bots graduation list even when the
 * scanner enrich path rejects them for missing playbook/confluence.
 */
async function offerGradWatchesCurveFirst(
  events: LaunchEvent[]
): Promise<{ scanned: number; offered: number; triggered: number }> {
  const {
    considerMigrationGradWatch,
    tickMigrationGradWatches,
  } = require('./migrationGradWatch') as typeof import('./migrationGradWatch');

  const pumpish = events.filter((e) => {
    if (!e?.mint) return false;
    if (e.migrated) return false;
    const mint = String(e.mint).toLowerCase();
    return mint.endsWith('pump') || e.isPumpFun === true;
  });

  // Broader than TA enrich budget; still capped for RPC health
  const budget = Math.min(64, Math.max(28, Math.min(pumpish.length, 64)));
  const sample = [...pumpish]
    .sort((a, b) => crudeLiqVolScore(b) - crudeLiqVolScore(a))
    .slice(0, budget);

  let offered = 0;
  await mapPool(sample, 4, async (event) => {
    if (pendingBuyQueueDepth() > SCANNER_MID_ENRICH_YIELD_DEPTH) return;
    const curve = await enrichCurve(event);
    const progress = curve.progressPct;
    // Below useful near-mig band — skip RPC noise
    if (progress != null && progress < 70 && !curve.nearMigration) return;
    if (progress == null && !curve.nearMigration) return;

    const entry = considerMigrationGradWatch({
      mint: event.mint,
      symbol: event.symbol,
      name: event.name,
      marketCapUsd: event.marketCapUsd,
      volumeH1Usd: event.volumeH1Usd,
      holderCount: event.holderCount,
      curveProgressPct:
        progress ?? (curve.nearMigration ? 80 : null),
      source: event.source === 'jupiter' ? 'jupiter' : 'curve-first',
    });
    if (entry) offered += 1;
  });

  const triggered = await tickMigrationGradWatches();
  return { scanned: sample.length, offered, triggered };
}

export function markScannerCooldown(mint: string, taken: boolean): void {
  const cfg = scannerCfg();
  const base = cfg.cooldownMs ?? 45 * 60_000;
  cooldowns.set(mint, Date.now() + (taken ? base * 2 : base));
  seenThisSession.add(mint);
}

/** Whether mint is in scanner cooldown (shared with specialty feed). */
export function isScannerMintOnCooldown(mint: string): boolean {
  const cd = cooldowns.get(mint) ?? 0;
  return cd > Date.now();
}

/**
 * Hand a pre-built candidate to the monitor handler (global or specialty feed).
 * Respects cooldown; does not re-run enrich/rank.
 */
export function handOffScannerCandidate(
  c: ScannerCandidate & { launch: LaunchEvent }
): boolean {
  if (!handler) return false;
  if (!c?.mint) return false;
  if (isScannerMintOnCooldown(c.mint)) return false;
  pushFeed({ ...c });
  c.status = 'queued';
  annotateScannerCandidate(c.mint, { status: 'queued' });
  const h = handler;
  void Promise.resolve()
    .then(() => h(c))
    .catch((err) => {
      annotateScannerCandidate(c.mint, {
        status: 'skipped',
        skipReason: err instanceof Error ? err.message : 'handler error',
      });
      markScannerCooldown(c.mint, false);
      logger.warn('MarketScanner', 'Candidate handler failed', {
        mint: c.mint,
        ...errorToMeta(err),
      });
    });
  return true;
}

export async function runScannerPollOnce(): Promise<number> {
  if (!isStrategyEnabled('ta_market_scanner')) return 0;
  if (pollInFlight) return 0;
  const qDepth = pendingBuyQueueDepth();
  if (qDepth > SCANNER_YIELD_QUEUE_DEPTH) {
    skippedForBuyQueue += 1;
    lastSkipReason = `skip poll — ${qDepth} wallet buy(s) pending (threshold ${SCANNER_YIELD_QUEUE_DEPTH})`;
    console.log(
      `[marketScanner] Skipping poll — ${qDepth} wallet buy(s) pending ` +
        `(threshold ${SCANNER_YIELD_QUEUE_DEPTH})`
    );
    return 0;
  }
  pollInFlight = true;
  const t0 = Date.now();
  try {
    lastError = null;
    const universe = await collectScannerUniverse();
    const picked = await selectScannerCandidates(universe);
    let handed = 0;
    // Non-blocking hand-off: fire handlers without serial await so the
    // scanner poll lock releases quickly; mint locks still serialize buys.
    for (const c of picked) {
      pushFeed({ ...c });
      if (!handler) continue;
      c.status = 'queued';
      annotateScannerCandidate(c.mint, { status: 'queued' });
      handed += 1;
      const h = handler;
      void Promise.resolve()
        .then(() => h(c))
        .catch((err) => {
          annotateScannerCandidate(c.mint, {
            status: 'skipped',
            skipReason: err instanceof Error ? err.message : 'handler error',
          });
          markScannerCooldown(c.mint, false);
          logger.warn('MarketScanner', 'Candidate handler failed', {
            mint: c.mint,
            ...errorToMeta(err),
          });
        });
    }
    lastPollAt = Date.now();
    lastPollMs = lastPollAt - t0;
    console.log(
      `[marketScanner] poll ${universe.length} launches → ${picked.length} candidates ` +
        `(handed ${handed}) in ${lastPollMs}ms`
    );
    // Curve-first graduation watches (no TA gate) — pump / Jupiter universe
    try {
      const grad = await offerGradWatchesCurveFirst(universe);
      if (grad.offered > 0 || grad.triggered > 0) {
        console.log(
          `[marketScanner] grad-watch curve-first scanned ${grad.scanned} ` +
            `→ offered ~${grad.offered}` +
            (grad.triggered > 0 ? ` · triggered ${grad.triggered}` : '')
        );
      }
    } catch (err) {
      logger.warn(
        'MarketScanner',
        'Grad watch curve-first pass failed',
        errorToMeta(err)
      );
    }
    try {
      const { runProfileSpecialtyFeedPass } =
        require('./profileSpecialtyFeeds') as typeof import('./profileSpecialtyFeeds');
      const fed = await runProfileSpecialtyFeedPass();
      if (fed > 0) {
        console.log(`[marketScanner] specialty feed handed ${fed} candidate(s)`);
      }
    } catch (err) {
      logger.warn(
        'MarketScanner',
        'Specialty feed pass failed',
        errorToMeta(err)
      );
    }
    try {
      const {
        offerDipWatchFromCandidate,
        tickDipSetupWatches,
      } = require('./dipSetupWatch') as typeof import('./dipSetupWatch');
      for (const c of picked) {
        offerDipWatchFromCandidate({
          mint: c.mint,
          symbol: c.symbol,
          name: c.name,
          marketCapUsd: c.marketCapUsd,
          volumeH1Usd: c.volumeH1Usd,
          holderCount: c.holderCount,
          priceChangeH1Pct: c.priceChangeH1Pct,
          nearKeyFib: c.nearKeyFib,
          nearSupport: c.nearSupport,
          lastPriceSol: c.lastPriceSol ?? null,
          supportPriceSol: c.supportPriceSol ?? null,
          kolCount: c.kolCount,
        });
      }
      const triggered = await tickDipSetupWatches();
      if (triggered > 0) {
        console.log(
          `[marketScanner] dip-watch triggered ${triggered} candidate(s)`
        );
      }
    } catch (err) {
      logger.warn('MarketScanner', 'Dip watch tick failed', errorToMeta(err));
    }
    try {
      const {
        offerMigrationGradWatchFromCandidate,
        tickMigrationGradWatches,
      } = require('./migrationGradWatch') as typeof import('./migrationGradWatch');
      for (const c of picked) {
        offerMigrationGradWatchFromCandidate({
          mint: c.mint,
          symbol: c.symbol,
          name: c.name,
          marketCapUsd: c.marketCapUsd,
          volumeH1Usd: c.volumeH1Usd,
          holderCount: c.holderCount,
          curveProgressPct: c.curveProgressPct,
          nearMigration: c.nearMigration,
          preferredProfileId: c.preferredProfileId,
          specialtyFeed: c.specialtyFeed,
        });
      }
      const gTriggered = await tickMigrationGradWatches();
      if (gTriggered > 0) {
        console.log(
          `[marketScanner] grad-watch triggered ${gTriggered} candidate(s)`
        );
      }
    } catch (err) {
      logger.warn('MarketScanner', 'Grad watch tick failed', errorToMeta(err));
    }
    return handed;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    logger.warn('MarketScanner', 'Poll failed', errorToMeta(err));
    return 0;
  } finally {
    pollInFlight = false;
  }
}

export function startMarketScanner(): void {
  if (running) return;
  running = true;
  const cfg = scannerCfg();
  console.log(
    `[marketScanner] Starting — poll every ${cfg.pollIntervalMs}ms, ` +
      `lookback ${cfg.lookbackHours}h, minScore ${cfg.minRankScore}`
  );
  setTimeout(() => {
    void runScannerPollOnce();
  }, 12_000);
  pollTimer = setInterval(() => {
    void runScannerPollOnce();
  }, Math.max(15_000, cfg.pollIntervalMs));
}

export function stopMarketScanner(): void {
  running = false;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Re-read pollIntervalMs / thresholds after config save. */
export function restartMarketScanner(): void {
  const wasRunning = running;
  stopMarketScanner();
  if (wasRunning) {
    startMarketScanner();
  }
}

/** Backtest helper: build a scanner-ranked view of a launch event. */
export function scoreLaunchForBacktestScanner(event: LaunchEvent): {
  ok: boolean;
  score: number;
  reasons: string[];
  nearKeyFib: boolean;
  nearSupport: boolean;
  chartPatternIds: string[];
  playbook?: string;
  confluence?: number;
  candleSource?: 'real' | 'synthetic';
} {
  if (!hardFloorsOk(event)) {
    return {
      ok: false,
      score: 0,
      reasons: ['floors'],
      nearKeyFib: false,
      nearSupport: false,
      chartPatternIds: [],
    };
  }
  // BT: skip network enrich; use candles already on the event
  const ranked = rankLaunchForScanner({
    ...event,
    candleSource: event.candleSource ?? (event.source === 'synthetic' ? 'synthetic' : event.candleSource),
  });
  const cfg = scannerCfg();
  const minRank = effectiveMinRankScore(cfg.minRankScore);
  const minConfluence = effectiveMinConfluence(cfg.minConfluenceScore ?? 40);
  const confluenceOk =
    ranked.confluence != null && ranked.confluence >= minConfluence;
  const ok =
    ranked.score >= minRank &&
    (!cfg.requireTaSetup || ranked.taSetup) &&
    (!cfg.requireTaSetup || confluenceOk) &&
    !ranked.veto?.startsWith('bearish:');
  return {
    ok,
    score: ranked.score,
    reasons: ranked.reasons,
    nearKeyFib: ranked.nearKeyFib,
    nearSupport: ranked.nearSupport,
    chartPatternIds: ranked.chartPatternIds,
    playbook: ranked.playbook,
    confluence: ranked.confluence,
    candleSource: ranked.candleSource,
  };
}
