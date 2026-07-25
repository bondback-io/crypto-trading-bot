/**
 * Market Scanner — autonomous Pump.fun / Dex opportunity discovery.
 *
 * Polls recent launches + trending tokens, ranks by TA / volume / curve /
 * liquidity, and feeds candidates into the monitor as non-wallet signals.
 * Wallet copy stays independent; hybrid when tracked wallets also appear.
 */

import { config } from './config';
import { logger, errorToMeta } from './logger';
import {
  fetchRecentLaunches,
  type LaunchEvent,
} from './marketData';
import { fetchBondingCurve, summarizeBondingCurve } from './bondingCurve';
import { isStrategyEnabled } from './strategies';
import { seedPriceHistoryFromCandles } from './technicalLevels';
import { analyzeChartPatterns } from './chartPatterns';
import { analyzeTechnicals } from './technicalLevels';
import { evaluateIndicators } from './indicators';

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
  nearKeyFib?: boolean;
  nearSupport?: boolean;
  chartPatternIds?: string[];
  indicatorSummary?: string;
}

export interface ScannerStatus {
  running: boolean;
  lastPollAt: number | null;
  lastPollMs: number | null;
  candidatesInFeed: number;
  lastError: string | null;
  enabled: boolean;
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

function scannerCfg() {
  return (
    config.marketScanner ?? {
      pollIntervalMs: 45_000,
      lookbackHours: 6,
      maxCandidatesPerPoll: 15,
      cooldownMs: 45 * 60_000,
      minRankScore: 42,
      requireTaSetup: true,
      minPatternConfidence: 55,
    }
  );
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
  return feed.slice(0, n);
}

export function getScannerStatus(): ScannerStatus {
  return {
    running,
    lastPollAt,
    lastPollMs,
    candidatesInFeed: feed.length,
    lastError,
    enabled: isStrategyEnabled('ta_market_scanner'),
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
  const minLiq = config.filters.minLiquidity ?? 0;
  const minMc = config.filters.minMarketCapUsd ?? 0;
  const liq = event.liquidityUsd ?? 0;
  const mc = event.marketCapUsd ?? 0;
  if (minLiq > 0 && liq > 0 && liq < minLiq) return false;
  if (minMc > 0 && mc > 0 && mc < minMc) return false;
  return true;
}

/** Rank a launch for scanner entry — higher is better. */
export function rankLaunchForScanner(event: LaunchEvent): {
  score: number;
  reasons: string[];
  nearKeyFib: boolean;
  nearSupport: boolean;
  chartPatternIds: string[];
  indicatorSummary?: string;
  taSetup: boolean;
} {
  const reasons: string[] = [];
  let score = 20;

  const liq = event.liquidityUsd ?? 0;
  const vol = event.volumeUsd ?? 0;
  const mc = event.marketCapUsd ?? 0;

  if (liq >= 25_000) {
    score += 12;
    reasons.push('liq≥25k');
  } else if (liq >= 10_000) {
    score += 8;
    reasons.push('liq≥10k');
  } else if (liq >= 8_000) {
    score += 4;
    reasons.push('liq ok');
  }

  if (vol >= 50_000) {
    score += 14;
    reasons.push('vol≥50k');
  } else if (vol >= 20_000) {
    score += 9;
    reasons.push('vol≥20k');
  } else if (vol >= 10_000) {
    score += 5;
    reasons.push('vol ok');
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

  // Seed TA history from candles
  if (event.candles?.length) {
    seedPriceHistoryFromCandles(event.mint, event.candles);
  }

  let nearKeyFib = false;
  let nearSupport = false;
  const chartPatternIds: string[] = [];
  let indicatorSummary: string | undefined;
  let taSetup = false;

  try {
    const tech = analyzeTechnicals({
      mint: event.mint,
      priceSol: event.lastPriceSol || event.entryPriceSol,
      candles: event.candles,
    });
    nearKeyFib = Boolean(tech.nearKeyFib);
    nearSupport = Boolean(tech.nearSupport);
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
  } catch {
    /* thin history */
  }

  try {
    const patterns = analyzeChartPatterns({
      mint: event.mint,
      priceSol: event.lastPriceSol || event.entryPriceSol,
      candles: event.candles,
      volumeH1Usd: event.volumeUsd != null ? event.volumeUsd / 18 : null,
      priceChange24hPct: event.priceChangePct ?? null,
      marketCapUsd: event.marketCapUsd ?? null,
    });
    const minConf = scannerCfg().minPatternConfidence ?? 55;
    for (const hit of patterns.bullish ?? []) {
      if (hit.confidence >= minConf) {
        chartPatternIds.push(hit.id);
        score += Math.min(14, Math.round(hit.confidence / 8));
        reasons.push(`pat:${hit.id}`);
        taSetup = true;
        if (hit.breakout) {
          score += 4;
          reasons.push('breakout');
        }
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const ind = evaluateIndicators({
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

  // Mild momentum from path
  const chg = event.priceChangePct ?? 0;
  if (chg >= 15 && chg <= 120) {
    score += 6;
    reasons.push('momentum');
  } else if (chg < -25 && chg > -55) {
    score += 7;
    reasons.push('pullback');
    taSetup = true;
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons,
    nearKeyFib,
    nearSupport,
    chartPatternIds,
    indicatorSummary,
    taSetup,
  };
}

async function enrichCurve(event: LaunchEvent): Promise<number> {
  try {
    const curve = await fetchBondingCurve(event.mint);
    if (!curve) return 0;
    const sum = summarizeBondingCurve(curve);
    let bonus = 0;
    if (sum.nearMigration) {
      bonus += 10;
    }
    if ((sum.progressPct ?? 0) >= 70 && (sum.progressPct ?? 0) < 99) {
      bonus += 6;
    }
    return bonus;
  } catch {
    return 0;
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
  return events;
}

/**
 * Score + filter universe; returns top candidates ready for monitor.
 */
export async function selectScannerCandidates(
  events: LaunchEvent[]
): Promise<Array<ScannerCandidate & { launch: LaunchEvent }>> {
  const cfg = scannerCfg();
  const now = Date.now();
  const out: Array<ScannerCandidate & { launch: LaunchEvent }> = [];

  for (const event of events) {
    if (!event.mint) continue;
    const cd = cooldowns.get(event.mint) ?? 0;
    if (cd > now) continue;
    if (!hardFloorsOk(event)) continue;

    const ranked = rankLaunchForScanner(event);
    const curveBonus = await enrichCurve(event);
    const score = Math.min(100, ranked.score + curveBonus);
    if (curveBonus > 0) ranked.reasons.push('curve');

    if (score < cfg.minRankScore) continue;
    if (cfg.requireTaSetup && !ranked.taSetup) continue;

    const id = `scan-${event.mint.slice(0, 8)}-${now}`;
    out.push({
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
      nearKeyFib: ranked.nearKeyFib,
      nearSupport: ranked.nearSupport,
      chartPatternIds: ranked.chartPatternIds,
      indicatorSummary: ranked.indicatorSummary,
      launch: event,
    });
  }

  out.sort((a, b) => b.rankScore - a.rankScore);
  return out.slice(0, Math.max(1, cfg.maxCandidatesPerPoll));
}

export function markScannerCooldown(mint: string, taken: boolean): void {
  const cfg = scannerCfg();
  const base = cfg.cooldownMs ?? 45 * 60_000;
  cooldowns.set(mint, Date.now() + (taken ? base * 2 : base));
  seenThisSession.add(mint);
}

export async function runScannerPollOnce(): Promise<number> {
  if (!isStrategyEnabled('ta_market_scanner')) return 0;
  if (pollInFlight) return 0;
  pollInFlight = true;
  const t0 = Date.now();
  try {
    lastError = null;
    const universe = await collectScannerUniverse();
    const picked = await selectScannerCandidates(universe);
    let handed = 0;
    for (const c of picked) {
      pushFeed({ ...c });
      if (!handler) continue;
      try {
        c.status = 'queued';
        annotateScannerCandidate(c.mint, { status: 'queued' });
        await handler(c);
        handed += 1;
      } catch (err) {
        annotateScannerCandidate(c.mint, {
          status: 'skipped',
          skipReason: err instanceof Error ? err.message : 'handler error',
        });
        markScannerCooldown(c.mint, false);
        logger.warn('MarketScanner', 'Candidate handler failed', {
          mint: c.mint,
          ...errorToMeta(err),
        });
      }
    }
    lastPollAt = Date.now();
    lastPollMs = lastPollAt - t0;
    console.log(
      `[marketScanner] poll ${universe.length} launches → ${picked.length} candidates ` +
        `(handed ${handed}) in ${lastPollMs}ms`
    );
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

/** Backtest helper: build a scanner-ranked view of a launch event. */
export function scoreLaunchForBacktestScanner(event: LaunchEvent): {
  ok: boolean;
  score: number;
  reasons: string[];
  nearKeyFib: boolean;
  nearSupport: boolean;
  chartPatternIds: string[];
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
  const ranked = rankLaunchForScanner(event);
  const cfg = scannerCfg();
  const ok =
    ranked.score >= cfg.minRankScore &&
    (!cfg.requireTaSetup || ranked.taSetup);
  return {
    ok,
    score: ranked.score,
    reasons: ranked.reasons,
    nearKeyFib: ranked.nearKeyFib,
    nearSupport: ranked.nearSupport,
    chartPatternIds: ranked.chartPatternIds,
  };
}
