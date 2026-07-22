/**
 * Pump.fun smart-money activity — early buyers on new launches,
 * bonding-curve / migration events, Birdeye-enriched scores.
 */

import { config } from './config';
import {
  getTrendingTokens,
  getSmartMoneySignal,
  summarizeBirdeye,
  type BirdeyeSmartMoneySignal,
} from './birdeye';
import { fetchBondingCurve, summarizeBondingCurve } from './bondingCurve';
import { logger, errorToMeta } from './logger';
import {
  findSmartWallets,
  type DiscoveredWallet,
  type DiscoveryResult,
} from './walletDiscovery';

export type PumpActivityKind =
  | 'early_buy'
  | 'curve_buy'
  | 'near_migration'
  | 'migration'
  | 'convergence';

export interface PumpEarlyBuyer {
  wallet: string;
  walletName: string;
  signature?: string;
  timestamp: number;
  progressPct: number | null;
}

export interface PumpSmartActivityEvent {
  id: string;
  kind: PumpActivityKind;
  mint: string;
  symbol: string;
  name: string;
  wallets: string[];
  walletNames: string[];
  timestamp: number;
  isPumpFun: boolean;
  isMigration: boolean;
  earlyBuy: boolean;
  priority: boolean;
  /** Distinct smart wallets seen on this mint (early window) */
  earlyBuyerCount: number;
  curveProgressPct: number | null;
  nearMigration: boolean;
  birdeye?: ReturnType<typeof summarizeBirdeye>;
  smartMoneyScore: number | null;
  notes?: string;
}

export interface PumpLaunchTrack {
  mint: string;
  symbol: string;
  name: string;
  firstSeenAt: number;
  earlyBuyers: PumpEarlyBuyer[];
  lastProgressPct: number | null;
  migrated: boolean;
  lastBirdeyeScore: number | null;
}

const MAX_EVENTS = 80;
const MAX_LAUNCHES = 60;
const EARLY_BUYER_CAP = 12;

const events: PumpSmartActivityEvent[] = [];
const launches = new Map<string, PumpLaunchTrack>();

function earlyMaxPct(): number {
  return config.strategy.earlyCurveMaxPct ?? 35;
}

function minSmScore(): number {
  return config.strategy.minEarlyBirdeyeSmartMoneyScore ?? 40;
}

export function isEarlyCurveBuy(
  progressPct: number | null | undefined
): boolean {
  // Unknown progress (curve fetch miss) — treat as early-eligible so
  // single smart-wallet Pump buys still form priority signals.
  if (progressPct == null || !Number.isFinite(progressPct)) return true;
  return progressPct >= 0 && progressPct <= earlyMaxPct();
}

/**
 * Whether a Pump.fun pre-migration buy should get priority sizing.
 * Early curve + (Birdeye SM / multi-wallet / pump-tagged wallet).
 */
export function shouldPrioritizeEarlyCurve(input: {
  isPumpFun: boolean;
  isMigration: boolean;
  progressPct: number | null | undefined;
  nearMigration?: boolean;
  smartMoneyScore?: number | null;
  earlyBuyerCount?: number;
  walletTags?: string[];
}): { prioritize: boolean; reason: string } {
  if (config.strategy.enableEarlyCurvePriority === false) {
    return { prioritize: false, reason: 'disabled' };
  }
  if (!input.isPumpFun || input.isMigration || input.nearMigration) {
    return { prioritize: false, reason: 'not_early_curve' };
  }
  if (!isEarlyCurveBuy(input.progressPct)) {
    return { prioritize: false, reason: 'above_early_pct' };
  }

  const sm = input.smartMoneyScore ?? 0;
  const buyers = input.earlyBuyerCount ?? 1;
  const minBuyers = config.strategy.earlyCurveMinSmartWallets ?? 1;
  const pumpTagged = (input.walletTags ?? []).some((t) =>
    /pump|migrat|launch/i.test(t)
  );
  const progressLabel =
    input.progressPct == null || !Number.isFinite(input.progressPct)
      ? 'unknown%'
      : `${input.progressPct.toFixed(0)}%`;

  if (buyers >= Math.max(2, minBuyers)) {
    return {
      prioritize: true,
      reason: `early_multi_wallet (${buyers}) @ ${progressLabel}`,
    };
  }
  if (minSmScore() > 0 && sm >= minSmScore()) {
    return {
      prioritize: true,
      reason: `early_birdeye_sm ${sm} @ ${progressLabel}`,
    };
  }
  if (pumpTagged && buyers >= minBuyers) {
    return {
      prioritize: true,
      reason: `early_pump_wallet @ ${progressLabel}`,
    };
  }
  if (minBuyers <= 1) {
    return {
      prioritize: true,
      reason: `early_smart_buy @ ${progressLabel}`,
    };
  }

  return { prioritize: false, reason: 'thresholds_not_met' };
}

function pushEvent(ev: PumpSmartActivityEvent): void {
  events.unshift(ev);
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
}

function getOrCreateLaunch(
  mint: string,
  symbol: string,
  name: string
): PumpLaunchTrack {
  let track = launches.get(mint);
  if (!track) {
    track = {
      mint,
      symbol,
      name,
      firstSeenAt: Date.now(),
      earlyBuyers: [],
      lastProgressPct: null,
      migrated: false,
      lastBirdeyeScore: null,
    };
    launches.set(mint, track);
    if (launches.size > MAX_LAUNCHES) {
      const oldest = [...launches.entries()].sort(
        (a, b) => a[1].firstSeenAt - b[1].firstSeenAt
      )[0];
      if (oldest) launches.delete(oldest[0]);
    }
  } else {
    if (symbol && symbol !== 'UNKNOWN') track.symbol = symbol;
    if (name) track.name = name;
  }
  return track;
}

/** Record early buyer; returns updated early-buyer count */
export function recordEarlyBuyer(input: {
  mint: string;
  symbol: string;
  name: string;
  wallet: string;
  walletName: string;
  signature?: string;
  progressPct: number | null;
}): number {
  const track = getOrCreateLaunch(input.mint, input.symbol, input.name);
  track.lastProgressPct = input.progressPct;

  if (!isEarlyCurveBuy(input.progressPct)) {
    return track.earlyBuyers.length;
  }

  if (!track.earlyBuyers.some((b) => b.wallet === input.wallet)) {
    track.earlyBuyers.push({
      wallet: input.wallet,
      walletName: input.walletName,
      signature: input.signature,
      timestamp: Date.now(),
      progressPct: input.progressPct,
    });
    if (track.earlyBuyers.length > EARLY_BUYER_CAP) {
      track.earlyBuyers = track.earlyBuyers.slice(-EARLY_BUYER_CAP);
    }
    logger.info('PumpSmart', 'early buyer', {
      mint: input.mint.slice(0, 12),
      wallet: input.walletName,
      progress: input.progressPct,
      count: track.earlyBuyers.length,
    });
  }
  return track.earlyBuyers.length;
}

export function markLaunchMigrated(mint: string): void {
  const track = launches.get(mint);
  if (track) track.migrated = true;
}

export function getLaunchTrack(mint: string): PumpLaunchTrack | null {
  return launches.get(mint) ?? null;
}

export function getEarlyBuyerCount(mint: string): number {
  return launches.get(mint)?.earlyBuyers.length ?? 0;
}

export function recordPumpSmartActivity(input: {
  kind: PumpActivityKind;
  mint: string;
  symbol: string;
  name: string;
  wallets: string[];
  walletNames: string[];
  isPumpFun: boolean;
  isMigration: boolean;
  priority?: boolean;
  curveProgressPct?: number | null;
  nearMigration?: boolean;
  birdeye?: ReturnType<typeof summarizeBirdeye>;
  notes?: string;
}): PumpSmartActivityEvent {
  const progress = input.curveProgressPct ?? null;
  const earlyBuy =
    input.kind === 'early_buy' ||
    (Boolean(input.isPumpFun) &&
      !input.isMigration &&
      isEarlyCurveBuy(progress));

  if (input.isMigration) markLaunchMigrated(input.mint);

  const earlyBuyerCount =
    launches.get(input.mint)?.earlyBuyers.length ??
    (earlyBuy ? input.wallets.length : 0);

  const sm =
    input.birdeye?.smartMoneyScore ??
    launches.get(input.mint)?.lastBirdeyeScore ??
    null;
  if (sm != null) {
    const t = launches.get(input.mint);
    if (t) t.lastBirdeyeScore = sm;
  }

  const ev: PumpSmartActivityEvent = {
    id: `${input.mint}:${input.kind}:${Date.now()}`,
    kind: earlyBuy && input.kind === 'curve_buy' ? 'early_buy' : input.kind,
    mint: input.mint,
    symbol: input.symbol,
    name: input.name,
    wallets: input.wallets,
    walletNames: input.walletNames,
    timestamp: Date.now(),
    isPumpFun: input.isPumpFun,
    isMigration: input.isMigration,
    earlyBuy,
    priority: Boolean(input.priority),
    earlyBuyerCount,
    curveProgressPct: progress,
    nearMigration: Boolean(input.nearMigration),
    birdeye: input.birdeye ?? null,
    smartMoneyScore: sm,
    notes: input.notes,
  };

  pushEvent(ev);
  return ev;
}

export function getPumpSmartActivity(options: {
  limit?: number;
  kind?: PumpActivityKind | 'all';
  onlyPriority?: boolean;
  minSmartMoneyScore?: number;
  earlyOnly?: boolean;
  nearMigrationOnly?: boolean;
  migrationOnly?: boolean;
} = {}): PumpSmartActivityEvent[] {
  const lim = Math.min(Math.max(options.limit ?? 40, 1), 100);
  let list = [...events];

  if (options.kind && options.kind !== 'all') {
    list = list.filter((e) => e.kind === options.kind);
  }
  if (options.onlyPriority) list = list.filter((e) => e.priority);
  if (options.earlyOnly) list = list.filter((e) => e.earlyBuy);
  if (options.nearMigrationOnly) {
    list = list.filter((e) => e.nearMigration || e.kind === 'near_migration');
  }
  if (options.migrationOnly) {
    list = list.filter((e) => e.isMigration || e.kind === 'migration');
  }
  if (
    options.minSmartMoneyScore != null &&
    options.minSmartMoneyScore > 0
  ) {
    list = list.filter(
      (e) => (e.smartMoneyScore ?? 0) >= options.minSmartMoneyScore!
    );
  }

  return list.slice(0, lim);
}

export function getPumpLaunchTracks(limit = 20): PumpLaunchTrack[] {
  return [...launches.values()]
    .sort((a, b) => b.firstSeenAt - a.firstSeenAt)
    .slice(0, limit);
}

export function getPumpSmartStatus() {
  const recent = events.slice(0, 20);
  return {
    eventCount: events.length,
    launchCount: launches.size,
    earlyBuys: recent.filter((e) => e.earlyBuy).length,
    nearMigration: recent.filter((e) => e.nearMigration).length,
    migrations: recent.filter((e) => e.isMigration).length,
    priority: recent.filter((e) => e.priority).length,
    enableEarlyCurvePriority:
      config.strategy.enableEarlyCurvePriority !== false,
    earlyCurveMaxPct: earlyMaxPct(),
    minEarlyBirdeyeSmartMoneyScore: minSmScore(),
    earlyCurveMinSmartWallets:
      config.strategy.earlyCurveMinSmartWallets ?? 1,
  };
}

/**
 * Pump.fun-focused wallet discovery: GMGN pump focus + Birdeye heat on
 * bonding-curve / trending launches.
 */
export async function discoverPumpFunSmartMoney(options: {
  limit?: number;
  force?: boolean;
} = {}): Promise<
  DiscoveryResult & {
    hotLaunches: Array<{
      mint: string;
      symbol: string;
      progressPct: number | null;
      smartMoneyScore: number | null;
      nearMigration: boolean;
      volume24hUsd: number | null;
    }>;
  }
> {
  const limit = options.limit ?? 20;

  let walletResult: DiscoveryResult;
  try {
    walletResult = await findSmartWallets({
      source: 'all',
      limit,
      force: options.force,
      pumpFunFocus: true,
    });
  } catch (err) {
    logger.warn('PumpSmart', 'GMGN pump discovery failed', errorToMeta(err));
    walletResult = await findSmartWallets({
      source: 'kolscan',
      limit,
      force: options.force,
    });
  }

  const wallets: DiscoveredWallet[] = walletResult.wallets.map((w) => ({
    ...w,
    tags: Array.from(
      new Set([...(w.tags || []), 'pump.fun', 'pump-smart'])
    ),
    notes:
      w.notes ||
      (w.smartFlowScore != null
        ? `Pump.fun focus · flow ${w.smartFlowScore}`
        : 'Pump.fun smart money'),
  }));

  const hotLaunches: Array<{
    mint: string;
    symbol: string;
    progressPct: number | null;
    smartMoneyScore: number | null;
    nearMigration: boolean;
    volume24hUsd: number | null;
  }> = [];

  try {
    const trend = await getTrendingTokens(Math.min(limit, 15), {
      force: options.force,
      interval: '1h',
    });
    for (const t of trend.tokens.slice(0, 10)) {
      let progressPct: number | null = null;
      let nearMigration = false;
      let sm: BirdeyeSmartMoneySignal | null = null;
      try {
        const [curve, signal] = await Promise.all([
          fetchBondingCurve(t.mint).catch(() => null),
          getSmartMoneySignal(t.mint).catch(() => null),
        ]);
        if (curve && curve.source !== 'none') {
          progressPct = curve.progressPct;
          nearMigration = curve.nearMigration;
          if (curve.complete && !nearMigration) continue;
        }
        sm = signal;
        if (sm && sm.source !== 'none') {
          const track = getOrCreateLaunch(t.mint, t.symbol, t.name);
          track.lastProgressPct = progressPct;
          track.lastBirdeyeScore = sm.smartMoneyScore;
        }
      } catch {
        /* soft */
      }

      hotLaunches.push({
        mint: t.mint,
        symbol: t.symbol,
        progressPct,
        smartMoneyScore: sm?.smartMoneyScore ?? null,
        nearMigration,
        volume24hUsd: t.volume24hUsd,
      });
    }
  } catch (err) {
    logger.warn('PumpSmart', 'hot launches scan failed', errorToMeta(err));
  }

  for (const track of getPumpLaunchTracks(10)) {
    if (hotLaunches.some((h) => h.mint === track.mint)) continue;
    if (track.earlyBuyers.length === 0 && !track.migrated) continue;
    hotLaunches.push({
      mint: track.mint,
      symbol: track.symbol,
      progressPct: track.lastProgressPct,
      smartMoneyScore: track.lastBirdeyeScore,
      nearMigration:
        (track.lastProgressPct ?? 0) >=
        (config.strategy.nearMigrationCurvePct ?? 80),
      volume24hUsd: null,
    });
  }

  hotLaunches.sort((a, b) => {
    const sa = (a.smartMoneyScore ?? 0) + (a.nearMigration ? 20 : 0);
    const sb = (b.smartMoneyScore ?? 0) + (b.nearMigration ? 20 : 0);
    return sb - sa;
  });

  return {
    ...walletResult,
    wallets,
    message:
      `Pump.fun smart money · ${wallets.length} wallets · ${hotLaunches.length} hot launches` +
      (walletResult.cached ? ' (cache)' : ''),
    relatedTokens: [
      ...(walletResult.relatedTokens || []),
      ...hotLaunches.map((h) => ({
        mint: h.mint,
        symbol: h.symbol,
        volumeUsd: h.volume24hUsd ?? undefined,
      })),
    ].slice(0, 20),
    hotLaunches: hotLaunches.slice(0, 12),
  };
}

export function clearPumpSmartActivity(): void {
  events.length = 0;
  launches.clear();
  logger.info('PumpSmart', 'activity cleared');
}

export { summarizeBondingCurve };
