/**
 * Smart wallet monitor — polls on-chain activity, detects buys,
 * applies filters/strategy toggles, and emits trade signals.
 */

import {
  ParsedInstruction,
  ParsedTransactionWithMeta,
  PartiallyDecodedInstruction,
  PublicKey,
} from '@solana/web3.js';
import { config, SmartWallet, persistWallets } from './config';
import { getConnection } from './connection';
import { executeBuy, refreshPositionPrices } from './trade';
import { paperTrader } from './paperTrader';
import { getDiscoveryStatus } from './walletDiscovery';
import {
  getTokenOverview,
  getSmartMoneySignal,
  summarizeBirdeye,
  getBirdeyeStatus,
} from './birdeye';
import {
  recordEarlyBuyer,
  recordPumpSmartActivity,
  shouldPrioritizeEarlyCurve,
  getPumpSmartStatus,
  markLaunchMigrated,
  isEarlyCurveBuy,
} from './pumpSmartActivity';
import {
  getWalletActivity,
  formatActivityLabel,
  getTokenSniperActivity,
  summarizeSniper,
  getGmgnStatus,
} from './gmgn';
import {
  isRecentlyMigrated,
  markAsMigrated,
  getMigrationStatus,
  onMigrationPriority,
  MigrationEvent,
} from './migrationListener';
import {
  resolveTokenMeta,
  formatTokenLabel,
  mintPrefix,
  cacheTokenMeta,
} from './tokenMeta';
import {
  isReBuyWatching,
  recordConfirmationBuy,
  evaluateConfirmation,
  markReBought,
  refreshCandidateMarketData,
  getReBuyCandidates,
  updateCandidatePrice,
  getReBuyStatus,
} from './reBuy';
import {
  calculateDynamicPositionSize,
  isRiskHalted,
  onRiskHalt,
  getRiskStatus,
  clearRiskHalt,
  type DynamicSizeResult,
} from './risk';
import {
  fetchTokenMetrics,
  summarizeTokenMetrics,
} from './tokenMetrics';
import {
  evaluateAntiRug,
  summarizeAntiRug,
  formatAntiRugSkipLog,
  type AntiRugReport,
} from './antiRug';
import {
  fetchBondingCurve,
  summarizeBondingCurve,
  formatBondingCurveLog,
} from './bondingCurve';
import {
  evaluateSignalConviction,
  canExecuteTradeNow,
  recordTradeExecuted,
  getTradeRateStatus,
} from './signalQuality';

export interface WalletBuyEvent {
  wallet: string;
  walletName: string;
  mint: string;
  /** Token ticker */
  symbol: string;
  /** Full token name */
  name: string;
  signature: string;
  timestamp: number;
  isPumpFun: boolean;
  isMigration: boolean;
  solSpent?: number;
  /** Cached on-chain / Dex metrics when available */
  metrics?: ReturnType<typeof summarizeTokenMetrics>;
  /** Anti-rug risk summary for dashboard */
  antiRug?: ReturnType<typeof summarizeAntiRug>;
  /** Pump.fun bonding curve progress */
  bondingCurve?: ReturnType<typeof summarizeBondingCurve>;
  /** GMGN sniper / bundler metrics */
  sniper?: ReturnType<typeof summarizeSniper>;
  /** Birdeye liquidity / volume / smart-money summary */
  birdeye?: ReturnType<typeof summarizeBirdeye>;
  /** Early bonding-curve buy (low progress %) */
  earlyBuy?: boolean;
  /** Early buyer count on this mint */
  earlyBuyerCount?: number;
}

export interface WalletLastActivity {
  timestamp: number;
  signature?: string;
  symbol?: string;
  name?: string;
  type: 'buy' | 'poll' | 'onchain';
  tradesLast30d?: number;
}

export interface WalletActivityReport {
  address: string;
  name: string;
  lastTradedAt: number | null;
  tradesLast30d: number;
  daysSinceTrade: number | null;
  isActive: boolean;
  reason?: string;
}

export interface TradeSignal {
  mint: string;
  symbol: string;
  name: string;
  wallets: string[];
  walletNames: string[];
  isMigration: boolean;
  timestamp: number;
  metrics?: ReturnType<typeof summarizeTokenMetrics>;
  antiRug?: ReturnType<typeof summarizeAntiRug>;
  bondingCurve?: ReturnType<typeof summarizeBondingCurve>;
  sniper?: ReturnType<typeof summarizeSniper>;
  /** Birdeye liquidity / volume / smart-money summary */
  birdeye?: ReturnType<typeof summarizeBirdeye>;
  /** Near-migration bonding curve priority (pre-graduation) */
  nearMigration?: boolean;
  /** Early bonding-curve smart money priority */
  earlyBuy?: boolean;
  earlyBuyerCount?: number;
  /** High-conviction score 0–100 from selective gating */
  convictionScore?: number;
  /** Position size multiplier from risk/conviction scoring */
  sizeMultiplier?: number;
  /** Calculated dynamic buy size in SOL */
  dynamicSizeSol?: number;
  /** Human-readable sizing reason for logs / dashboard */
  dynamicSizeReason?: string;
}

type SignalHandler = (signal: TradeSignal) => void;

const recentBuys = new Map<string, WalletBuyEvent[]>();
const lastSignature = new Map<string, string>();
const walletLastActivity = new Map<string, WalletLastActivity>();
/** Mints we already bought (or intentionally blocked from re-entry). */
const tradedMints = new Set<string>();
/** In-flight buy claims — prevents concurrent duplicate opens while filters await. */
const pendingBuys = new Set<string>();
/** Recent evaluated signals with dynamic size (for dashboard). */
const recentSignals: Array<{
  mint: string;
  symbol: string;
  name: string;
  timestamp: number;
  wallets: string[];
  walletNames: string[];
  isMigration: boolean;
  nearMigration?: boolean;
  earlyBuy?: boolean;
  convictionScore?: number;
  riskScore?: number;
  dynamicSizeSol?: number;
  dynamicSizeReason?: string;
  accepted: boolean;
}> = [];
const MAX_RECENT_SIGNALS = 40;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let activityTimer: ReturnType<typeof setInterval> | null = null;
let running = false;
let paused = false;
let pollInFlight = false;
let onSignalHandler: SignalHandler | null = null;

/**
 * Atomically reserve a mint before any slow await on the buy path.
 * Returns false if already pending, already held, or previously traded
 * (unless allowRetrade for the post-TP re-buy path).
 */
function beginBuy(
  mint: string,
  opts?: { allowRetrade?: boolean }
): boolean {
  if (pendingBuys.has(mint)) return false;
  if (paperTrader.hasOpenMint(mint)) {
    tradedMints.add(mint);
    return false;
  }
  if (!opts?.allowRetrade && tradedMints.has(mint)) return false;
  pendingBuys.add(mint);
  return true;
}

function finishBuy(mint: string, success: boolean): void {
  pendingBuys.delete(mint);
  if (success) tradedMints.add(mint);
}

/** Clear traded/pending mint locks (e.g. after paper reset). */
export function clearTradedMints(): void {
  tradedMints.clear();
  pendingBuys.clear();
}

const ACTIVITY_REFRESH_MS = 15 * 60 * 1000; // re-check activity every 15 min
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function onSignal(handler: SignalHandler): void {
  onSignalHandler = handler;
}

export function startMonitor(): void {
  if (running) return;
  running = true;
  paused = false;

  console.log(
    `[monitor] Starting — poll every ${config.pollIntervalMs}ms, activity filter: ${config.filters.enableActivityFilter}`
  );

  // Restore wallets that were auto-disabled after failed RPC/GMGN scans
  recoverDisabledWallets();

  // If activity filter wiped the watch list, re-enable all tracked imports
  const enabledCount = config.smartWallets.filter((w) => w.enabled).length;
  if (enabledCount === 0 && config.smartWallets.length > 0) {
    console.warn(
      `[monitor] ⚠ ${config.smartWallets.length} tracked wallet(s) but 0 enabled — ` +
        `force-enabling all for monitoring`
    );
    forceRefreshMonitoring();
  } else {
    // Ensure every enabled tracked wallet is on the poll list (imported wallets)
    const bootSync = syncWalletsToMonitoring(
      config.smartWallets.filter((w) => w.enabled).map((w) => w.address),
      'monitor-start'
    );
    console.log(
      `[monitor] Boot watch list: ${bootSync.watching}/${bootSync.tracked} — ` +
        bootSync.wallets
          .slice(0, 20)
          .map((w) => w.name)
          .join(', ') +
        (bootSync.wallets.length > 20
          ? ` … +${bootSync.wallets.length - 20} more`
          : '')
    );
  }

  // Start polling immediately so trading isn't blocked behind slow GMGN/RPC
  // activity scans. Refresh activity in the background, then apply filter.
  void pollAllWallets();

  void (async () => {
    if (config.filters.enableActivityFilter) {
      await refreshAllWalletActivity();
      filterActiveWallets({ persistActiveOnly: false });
      const watching = getWalletsForPolling().length;
      if (watching === 0 && config.smartWallets.length > 0) {
        console.warn(
          `[monitor] ⚠ 0 wallets eligible to poll after activity refresh — ` +
            `recovering recently-active disabled wallets`
        );
        recoverDisabledWallets();
      }
    }
  })();

  pollTimer = setInterval(() => {
    void pollAllWallets();
  }, config.pollIntervalMs);

  activityTimer = setInterval(() => {
    if (paused || !config.filters.enableActivityFilter) return;
    void (async () => {
      await refreshAllWalletActivity();
      filterActiveWallets({ persistActiveOnly: false });
      if (getWalletsForPolling().length === 0 && config.smartWallets.length > 0) {
        recoverDisabledWallets();
      }
    })();
  }, ACTIVITY_REFRESH_MS);

  // When migration listener sees a tracked wallet in a migrate tx → priority buy
  onMigrationPriority((event) => {
    void handleMigrationPriorityEvent(event);
  });

  onRiskHalt((reason) => {
    console.warn(`[monitor] Risk halt → pausing: ${reason}`);
    pauseMonitor();
  });
}

export function stopMonitor(): void {
  running = false;
  paused = false;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (activityTimer) {
    clearInterval(activityTimer);
    activityTimer = null;
  }
  console.log('[monitor] Stopped');
}

export function pauseMonitor(): void {
  if (!running) return;
  paused = true;
  console.log('[monitor] Paused');
}

export function resumeMonitor(): void {
  if (!running) return;
  if (isRiskHalted()) {
    console.warn(
      '[monitor] Resume blocked — clear risk halt first (POST /api/risk/clear-halt)'
    );
    return;
  }
  paused = false;
  console.log('[monitor] Resumed');
}

export function isMonitorPaused(): boolean {
  return paused;
}

async function pollAllWallets(): Promise<void> {
  if (paused) return;
  if (pollInFlight) {
    console.log('[monitor] Skipping poll — previous cycle still running');
    return;
  }
  pollInFlight = true;
  try {
    const wallets = getWalletsForPolling();
    // Cap concurrent RPC polls so bulk imports don't freeze the API
    const batchSize = 12;
    for (let i = 0; i < wallets.length; i += batchSize) {
      const batch = wallets.slice(i, i + batchSize);
      await Promise.allSettled(batch.map((wallet) => pollWallet(wallet)));
    }

    const openMints = paperTrader.getOpenPositions().map((p) => p.mint);
    if (openMints.length > 0) {
      await refreshPositionPrices(openMints);
      paperTrader.checkPositions();
    }

    // After sells / price updates — evaluate dip re-buy opportunities
    await evaluateReBuyOpportunities();

    pruneOldBuys();
  } finally {
    pollInFlight = false;
  }
}

/**
 * Check last trade time + recent tx count for a wallet (on-chain).
 * Uses getSignaturesForAddress — works without GMGN.
 */
export async function checkWalletLastTrade(
  address: string
): Promise<{
  lastTradedAt: number | null;
  tradesLast30d: number;
  signature?: string;
  failed?: boolean;
}> {
  try {
    const pubkey = new PublicKey(address);
    const conn = getConnection();
    const cutoff30d = Math.floor((Date.now() - 30 * MS_PER_DAY) / 1000);

    const signatures = await conn.getSignaturesForAddress(pubkey, {
      limit: 100,
    });

    if (signatures.length === 0) {
      return { lastTradedAt: null, tradesLast30d: 0 };
    }

    const newest = signatures[0];
    const lastTradedAt = newest.blockTime
      ? newest.blockTime * 1000
      : Date.now();

    const tradesLast30d = signatures.filter(
      (s) => s.blockTime != null && s.blockTime >= cutoff30d
    ).length;

    return {
      lastTradedAt,
      tradesLast30d,
      signature: newest.signature,
    };
  } catch (err) {
    console.warn(`[monitor] Activity check failed for ${address.slice(0, 8)}…:`, err);
    // Do NOT invent zeros — callers must keep prior lastTradedAt / tradesLast30d
    return { lastTradedAt: null, tradesLast30d: 0, failed: true };
  }
}

/** Refresh activity metadata for one wallet (GMGN first, on-chain fallback) */
export async function refreshWalletActivity(
  wallet: SmartWallet
): Promise<WalletActivityReport> {
  let lastTradedAt: number | null = null;
  let tradesLast30d = 0;
  let signature: string | undefined;
  let source: 'gmgn' | 'onchain' | 'mixed' = 'onchain';
  let fetchFailed = false;

  // Prefer GMGN when configured — skip when no key / circuit open (avoids 403 storms)
  let gmgnWinRate: number | undefined;
  let tradesLast7d: number | undefined;
  const gmgnStatus = getGmgnStatus();
  const gmgnUsable =
    config.gmgn.preferGmgnActivity &&
    gmgnStatus.hasApiKey &&
    (gmgnStatus.rateLimitedUntil == null ||
      gmgnStatus.rateLimitedUntil <= Date.now()) &&
    (gmgnStatus.discovery?.consecutiveFailures ?? 0) < 8;

  if (gmgnUsable) {
    try {
      const gmgn = await getWalletActivity(wallet.address);
      if (gmgn.lastTradeTime != null) {
        lastTradedAt = gmgn.lastTradeTime;
        source = 'gmgn';
      }
      if (gmgn.tradeCount != null) {
        tradesLast30d = gmgn.tradeCount ?? 0;
      }
      if (gmgn.tradeCount7d != null) {
        tradesLast7d = gmgn.tradeCount7d;
        if (tradesLast30d === 0) tradesLast30d = gmgn.tradeCount7d;
      }
      if (gmgn.winRate != null) {
        gmgnWinRate = gmgn.winRate;
      }
      if (gmgn.name && wallet.name.startsWith(wallet.address.slice(0, 4))) {
        wallet.name = gmgn.name;
      }
    } catch (err) {
      console.warn(
        `[monitor] GMGN activity failed for ${wallet.name}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  // On-chain fallback / enrichment when GMGN missing or incomplete
  if (lastTradedAt == null || tradesLast30d === 0) {
    const onchain = await checkWalletLastTrade(wallet.address);
    if (onchain.failed) {
      fetchFailed = true;
    } else {
      if (lastTradedAt == null) {
        lastTradedAt = onchain.lastTradedAt;
        signature = onchain.signature;
        source = source === 'gmgn' ? 'mixed' : 'onchain';
      }
      if (tradesLast30d === 0) {
        tradesLast30d = onchain.tradesLast30d;
      }
      if (!signature) signature = onchain.signature;
    }
  }

  const target = config.smartWallets.find((w) => w.address === wallet.address);

  // On fetch failure keep prior activity so we don't auto-disable everyone
  if (fetchFailed && target) {
    lastTradedAt = target.lastTradedAt ?? target.lastActive ?? null;
    tradesLast30d = target.tradesLast30d ?? 0;
    console.warn(
      `[monitor] Keeping prior activity for ${wallet.name} ` +
        `(last=${lastTradedAt ? new Date(lastTradedAt).toISOString() : 'unknown'}, ` +
        `txs30d=${tradesLast30d}) — RPC/GMGN check failed`
    );
  }

  const daysSinceTrade =
    lastTradedAt != null
      ? (Date.now() - lastTradedAt) / MS_PER_DAY
      : null;

  const { minActivityDays, minTradesLast30d } = config.filters;
  let isActive = true;
  let reason: string | undefined;

  if (fetchFailed && lastTradedAt == null) {
    // Unknown — don't mark inactive
    isActive = true;
    reason = 'activity check failed — status unknown';
  } else if (lastTradedAt == null) {
    isActive = false;
    reason = 'no activity found';
  } else if (daysSinceTrade != null && daysSinceTrade > minActivityDays) {
    isActive = false;
    reason = `inactive ${daysSinceTrade.toFixed(1)}d > ${minActivityDays}d`;
  } else if (
    tradesLast30d > 0 &&
    tradesLast30d < minTradesLast30d
  ) {
    // Only enforce trade-count when we have a meaningful count
    isActive = false;
    reason = `only ${tradesLast30d} txs (need ${minTradesLast30d})`;
  }

  if (target) {
    if (!fetchFailed) {
      target.lastTradedAt = lastTradedAt ?? undefined;
      target.lastActive = lastTradedAt ?? undefined;
      target.tradesLast30d = tradesLast30d;
      if (tradesLast7d != null) target.tradesLast7d = tradesLast7d;
      if (gmgnWinRate != null) target.winRate = gmgnWinRate;
      target.lastCheckedAt = Date.now();
    }
    // On failure: leave prior fields alone (do not stamp lastCheckedAt with zeros)
  }

  if (lastTradedAt != null) {
    walletLastActivity.set(wallet.address, {
      timestamp: lastTradedAt,
      signature,
      type: source === 'gmgn' ? 'buy' : 'onchain',
      tradesLast30d,
    });
  }

  return {
    address: wallet.address,
    name: wallet.name,
    lastTradedAt,
    tradesLast30d,
    daysSinceTrade,
    isActive,
    reason,
  };
}

/** Refresh activity for all tracked wallets */
export async function refreshAllWalletActivity(): Promise<WalletActivityReport[]> {
  console.log(`[monitor] Refreshing activity for ${config.smartWallets.length} wallet(s)…`);
  const reports: WalletActivityReport[] = [];

  for (const wallet of config.smartWallets) {
    const report = await refreshWalletActivity(wallet);
    reports.push(report);
  }

  return reports;
}

/**
 * True when wallet looks active enough to poll.
 * tradesLast30d === 0 is treated as "unknown" (RPC/GMGN often wipe this on failure),
 * so a recent lastTradedAt alone is enough to stay eligible.
 * Newly imported wallets keep a grace period so they stay on the watch list
 * until we have a real inactivity signal.
 */
function importGraceActive(wallet: SmartWallet): boolean {
  const discovered = wallet.discoveredAt ?? 0;
  if (!discovered) return false;
  // 14 days after import/discovery — keep watching even if activity is unknown
  return Date.now() - discovered < 14 * MS_PER_DAY;
}

function passesActivityRules(wallet: SmartWallet): boolean {
  const { minActivityDays, minTradesLast30d } = config.filters;
  // Not yet checked — allow until first successful activity scan
  if (wallet.lastCheckedAt == null) return true;

  const last = wallet.lastTradedAt ?? wallet.lastActive;
  // Unknown activity after a check: keep watching during import grace
  // (imported GMGN/Birdeye/manual wallets often have no on-chain hit yet)
  if (last == null) {
    return importGraceActive(wallet);
  }

  const daysSince = (Date.now() - last) / MS_PER_DAY;
  if (daysSince > minActivityDays) return false;
  const trades = wallet.tradesLast30d ?? 0;
  // 0 = unknown / failed fetch — don't treat as inactive
  if (trades > 0 && trades < minTradesLast30d) return false;
  return true;
}

/**
 * Re-enable wallets that still look recently active but were disabled after
 * failed activity scans (common when public RPC is 429'd).
 */
export function recoverDisabledWallets(): { recovered: number } {
  let recovered = 0;
  const maxDays = config.filters.minActivityDays;
  for (const wallet of config.smartWallets) {
    if (wallet.enabled) continue;
    const last = wallet.lastTradedAt ?? wallet.lastActive;
    if (last == null) continue;
    const daysSince = (Date.now() - last) / MS_PER_DAY;
    if (daysSince > maxDays) continue;
    // Recent last trade — re-enable even if tradesLast30d was wiped to 0
    wallet.enabled = true;
    recovered += 1;
    console.log(
      `[monitor] Re-enabled ${wallet.name} (${wallet.address.slice(0, 8)}…) — ` +
        `last trade ${daysSince.toFixed(1)}d ago`
    );
  }
  if (recovered > 0) {
    persistWallets();
    console.log(`[monitor] Recovered ${recovered} wallet(s) for polling`);
  }
  return { recovered };
}

/**
 * Auto-filter: disable wallets that fail activity rules.
 * Set pruneInactive=true to remove disabled wallets and persist active only.
 */
export function filterActiveWallets(
  options: { persistActiveOnly?: boolean; pruneInactive?: boolean } = {}
): { kept: number; disabled: number; removed: number } {
  if (!config.filters.enableActivityFilter) {
    return {
      kept: config.smartWallets.filter((w) => w.enabled).length,
      disabled: 0,
      removed: 0,
    };
  }

  let disabled = 0;

  for (const wallet of config.smartWallets) {
    // Skip wallets not yet successfully checked — don't disable blindly
    if (wallet.lastCheckedAt == null) continue;
    // Never auto-disable freshly imported wallets still in grace
    if (importGraceActive(wallet) && (wallet.lastTradedAt == null && wallet.lastActive == null)) {
      continue;
    }

    const active = passesActivityRules(wallet);
    const last = wallet.lastTradedAt ?? wallet.lastActive;
    const daysSince =
      last != null ? (Date.now() - last) / MS_PER_DAY : Infinity;
    const trades = wallet.tradesLast30d ?? 0;

    if (!active && wallet.enabled) {
      wallet.enabled = false;
      disabled += 1;
      console.log(
        `[monitor] Auto-disabled ${wallet.name} (${wallet.address.slice(0, 8)}…) — ` +
          `last trade ${daysSince === Infinity ? 'never' : daysSince.toFixed(0) + 'd ago'}, ` +
          `${trades} txs/30d`
      );
    } else if (active && !wallet.enabled) {
      // Re-enable if they became active again / were falsely disabled
      wallet.enabled = true;
      console.log(
        `[monitor] Re-enabled ${wallet.name} (${wallet.address.slice(0, 8)}…) — activity OK`
      );
    }
  }

  let removed = 0;
  if (options.pruneInactive || options.persistActiveOnly) {
    const before = config.smartWallets.length;
    config.smartWallets = config.smartWallets.filter((w) => w.enabled);
    removed = before - config.smartWallets.length;
    persistWallets({ activeOnly: true });
  } else {
    persistWallets();
  }

  const kept = config.smartWallets.filter((w) => w.enabled).length;
  console.log(
    `[monitor] Activity filter: ${kept} active, ${disabled} disabled, ${removed} pruned`
  );
  return { kept, disabled, removed };
}

/** Wallets that are enabled and pass activity filter (for polling).
 *  Prioritizes wallets with more recent activity. */
export function getWalletsForPolling(): SmartWallet[] {
  const enabled = config.smartWallets.filter((w) => w.enabled);
  let list = enabled;

  if (config.filters.enableActivityFilter) {
    const filtered = enabled.filter((w) => passesActivityRules(w));
    // Never drop to an empty poll set while enabled wallets exist —
    // fall back to all enabled (imported wallets must stay watched)
    list = filtered.length > 0 ? filtered : enabled;
    if (filtered.length === 0 && enabled.length > 0) {
      console.warn(
        `[monitor] Activity filter would watch 0/${enabled.length} — ` +
          `falling back to all enabled wallets`
      );
    }
  }

  // Recent activity first so monitor polls hot wallets sooner
  return list.slice().sort((a, b) => {
    const aT = a.lastTradedAt ?? a.lastActive ?? 0;
    const bT = b.lastTradedAt ?? b.lastActive ?? 0;
    return bT - aT;
  });
}

/**
 * Ensure wallets are enabled and subscribed to the monitoring poll loop.
 * Call after GMGN / Birdeye / manual / bulk import with the new addresses.
 * Pass no addresses to only refresh the poll loop / status.
 */
export function syncWalletsToMonitoring(
  addresses?: string[],
  reason = 'import'
): {
  addedToWatch: string[];
  watching: number;
  tracked: number;
  enabled: number;
  wallets: Array<{ name: string; address: string; source?: string }>;
} {
  const targets = (addresses ?? []).map((a) => a.trim()).filter(Boolean);
  const addedToWatch: string[] = [];
  const now = Date.now();

  for (const address of targets) {
    const wallet = config.smartWallets.find((w) => w.address === address);
    if (!wallet) {
      console.warn(
        `[monitor] sync skipped — ${address.slice(0, 8)}… not in tracked list (${reason})`
      );
      continue;
    }

    const wasDisabled = !wallet.enabled;
    wallet.enabled = true;
    if (wallet.discoveredAt == null) {
      wallet.discoveredAt = now;
    }
    // Fresh import: allow grace until a real activity sample exists
    if (wallet.lastTradedAt == null && wallet.lastActive == null) {
      wallet.lastCheckedAt = undefined;
    }

    addedToWatch.push(wallet.address);
    console.log(
      `[monitor] ✅ Added to monitoring: ${wallet.name} (${wallet.address.slice(0, 8)}…)` +
        (wasDisabled ? ' [re-enabled]' : '') +
        ` · source=${wallet.source ?? 'unknown'} · reason=${reason}`
    );
  }

  if (addedToWatch.length > 0) {
    persistWallets();
  }

  const watchingList = getWalletsForPolling();
  console.log(
    `[monitor] Watching ${watchingList.length}/${config.smartWallets.length} wallet(s)` +
      ` after ${reason}` +
      (addedToWatch.length
        ? ` · synced ${addedToWatch.length} address(es)`
        : ' · poll refresh only')
  );

  // Kick the poll loop so new wallets are picked up immediately
  if (running && !paused && watchingList.length > 0) {
    void pollAllWallets();
  } else if (!running && addedToWatch.length > 0) {
    console.warn(
      '[monitor] Wallets synced but monitor is not running — start the bot to begin polling'
    );
  }

  return {
    addedToWatch,
    watching: watchingList.length,
    tracked: config.smartWallets.length,
    enabled: config.smartWallets.filter((w) => w.enabled).length,
    wallets: watchingList.map((w) => ({
      name: w.name,
      address: w.address,
      source: w.source,
    })),
  };
}

/**
 * Force re-subscribe: re-enable all tracked wallets, recover disabled,
 * refresh poll set, and run an immediate poll cycle.
 */
export function forceRefreshMonitoring(): {
  ok: boolean;
  recovered: number;
  reenabled: number;
  watching: number;
  tracked: number;
  enabled: number;
  running: boolean;
  paused: boolean;
  wallets: Array<{
    name: string;
    address: string;
    source?: string;
    enabled: boolean;
    isActive: boolean;
  }>;
  message: string;
} {
  console.log('[monitor] Force refresh monitoring — re-subscribing all tracked wallets…');

  const { recovered } = recoverDisabledWallets();
  let reenabled = 0;
  const allAddresses: string[] = [];
  for (const wallet of config.smartWallets) {
    allAddresses.push(wallet.address);
    if (!wallet.enabled) {
      wallet.enabled = true;
      reenabled += 1;
      if (wallet.lastTradedAt == null && wallet.lastActive == null) {
        wallet.lastCheckedAt = undefined;
      }
      console.log(
        `[monitor] ✅ Force re-enabled for monitoring: ${wallet.name} (${wallet.address.slice(0, 8)}…)`
      );
    }
  }

  if (reenabled > 0) persistWallets();

  const sync = syncWalletsToMonitoring(allAddresses, 'force-refresh');
  const watchingList = getWalletsForPolling();

  const message =
    `Force refresh: watching ${watchingList.length}/${config.smartWallets.length} wallets` +
    (recovered ? ` · recovered ${recovered}` : '') +
    (reenabled ? ` · re-enabled ${reenabled}` : '') +
    (running ? (paused ? ' · monitor paused' : ' · poll kicked') : ' · monitor stopped');

  console.log(`[monitor] ${message}`);
  if (watchingList.length > 0) {
    console.log(
      `[monitor] Tracked watch list: ` +
        watchingList
          .slice(0, 30)
          .map((w) => w.name)
          .join(', ') +
        (watchingList.length > 30 ? ` … +${watchingList.length - 30} more` : '')
    );
  }

  return {
    ok: true,
    recovered,
    reenabled,
    watching: watchingList.length,
    tracked: config.smartWallets.length,
    enabled: config.smartWallets.filter((w) => w.enabled).length,
    running,
    paused,
    wallets: config.smartWallets.map((w) => ({
      name: w.name,
      address: w.address,
      source: w.source,
      enabled: w.enabled,
      isActive: isWalletActive(w),
    })),
    message,
  };
}

/**
 * Remove wallets with no (or stale) activity for longer than maxDaysInactive.
 * Default 14 days. Wallets never traded are pruned only after their
 * discoveredAt/import age exceeds the same window (import grace).
 */
export function pruneInactiveWallets(
  maxDaysInactive = 14
): {
  removed: number;
  kept: number;
  pruned: Array<{ name: string; address: string; reason: string }>;
} {
  const cutoff = Date.now() - maxDaysInactive * MS_PER_DAY;
  const pruned: Array<{ name: string; address: string; reason: string }> = [];
  const kept: typeof config.smartWallets = [];

  for (const wallet of config.smartWallets) {
    const last = wallet.lastTradedAt ?? wallet.lastActive ?? null;
    if (last != null) {
      if (last < cutoff) {
        const days = ((Date.now() - last) / MS_PER_DAY).toFixed(1);
        pruned.push({
          name: wallet.name,
          address: wallet.address,
          reason: `last activity ${days}d ago (>${maxDaysInactive}d)`,
        });
        console.log(
          `[monitor] Pruned inactive ${wallet.name} (${wallet.address.slice(0, 8)}…) — ` +
            `last activity ${days}d ago`
        );
        continue;
      }
      kept.push(wallet);
      continue;
    }

    // Never traded — only prune after import/discovery age exceeds window
    const ageRef = wallet.discoveredAt ?? wallet.lastCheckedAt ?? 0;
    if (ageRef > 0 && ageRef < cutoff) {
      const days = ((Date.now() - ageRef) / MS_PER_DAY).toFixed(1);
      pruned.push({
        name: wallet.name,
        address: wallet.address,
        reason: `never traded · imported/checked ${days}d ago`,
      });
      console.log(
        `[monitor] Pruned ${wallet.name} (${wallet.address.slice(0, 8)}…) — ` +
          `never traded, age ${days}d`
      );
      continue;
    }

    kept.push(wallet);
  }

  config.smartWallets = kept;
  persistWallets({ activeOnly: false });

  const watching = getWalletsForPolling();
  console.log(
    `[monitor] Prune >${maxDaysInactive}d: removed ${pruned.length}, kept ${kept.length}, ` +
      `now watching ${watching.length}`
  );

  if (running && !paused) {
    void pollAllWallets();
  }

  return {
    removed: pruned.length,
    kept: kept.length,
    pruned,
  };
}

export function isWalletActive(wallet: SmartWallet): boolean {
  if (!wallet.enabled) return false;
  if (!config.filters.enableActivityFilter) return true;
  return passesActivityRules(wallet);
}

async function pollWallet(wallet: SmartWallet): Promise<void> {
  try {
    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(wallet.address);
    } catch {
      console.warn(`[monitor] Skipping invalid address for ${wallet.name}`);
      return;
    }

    const conn = getConnection();
    const signatures = await conn.getSignaturesForAddress(pubkey, { limit: 10 });

    if (signatures.length === 0) {
      walletLastActivity.set(wallet.address, {
        timestamp: Date.now(),
        type: 'poll',
      });
      return;
    }

    const lastSeen = lastSignature.get(wallet.address);
    const newSigs: string[] = [];

    for (const sig of signatures) {
      if (sig.signature === lastSeen) break;
      newSigs.push(sig.signature);
    }

    if (newSigs.length === 0) return;

    lastSignature.set(wallet.address, signatures[0].signature);

    for (const sig of newSigs.reverse()) {
      const tx = await conn.getParsedTransaction(sig, {
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) continue;

      const buys = parseBuysFromTransaction(tx, wallet, sig);
      for (const buy of buys) {
        walletLastActivity.set(wallet.address, {
          timestamp: buy.timestamp,
          signature: buy.signature,
          symbol: buy.symbol,
          name: buy.name,
          type: 'buy',
        });
        await handleBuyEvent(buy);
      }
    }
  } catch (err) {
    console.error(`[monitor] Error polling ${wallet.name}:`, err);
  }
}

function parseBuysFromTransaction(
  tx: ParsedTransactionWithMeta,
  wallet: SmartWallet,
  signature: string
): WalletBuyEvent[] {
  const events: WalletBuyEvent[] = [];
  const blockTime = (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000;

  const instructions = tx.transaction.message.instructions;
  const innerInstructions = tx.meta?.innerInstructions ?? [];

  const allInstructions: (ParsedInstruction | PartiallyDecodedInstruction)[] = [
    ...instructions,
    ...innerInstructions.flatMap((inner) => inner.instructions),
  ];

  const programIds = allInstructions.map((ix) => getProgramId(ix));
  const onPumpCurve = programIds.includes(config.pumpFunProgramId);
  const onPumpSwap = programIds.includes(config.pumpSwapProgramId);
  const isPumpFun = onPumpCurve || onPumpSwap;
  const isMigration = onPumpSwap;

  const preBalances = tx.meta?.preTokenBalances ?? [];
  const postBalances = tx.meta?.postTokenBalances ?? [];

  for (const post of postBalances) {
    if (post.owner !== wallet.address) continue;

    const mint = post.mint;
    if (mint === config.solMint) continue;

    const pre = preBalances.find(
      (p) => p.mint === mint && p.owner === wallet.address
    );

    const preAmount = pre?.uiTokenAmount.uiAmount ?? 0;
    const postAmount = post.uiTokenAmount.uiAmount ?? 0;

    if (postAmount <= preAmount) continue;

    const prefix = mintPrefix(mint);
    const symbol = prefix;
    const name = prefix;

    events.push({
      wallet: wallet.address,
      walletName: wallet.name,
      mint,
      symbol,
      name,
      signature,
      timestamp: blockTime,
      isPumpFun,
      isMigration,
    });
  }

  return events;
}

function getProgramId(
  ix: ParsedInstruction | PartiallyDecodedInstruction
): string {
  if ('programId' in ix) {
    return ix.programId.toBase58();
  }
  return '';
}

/**
 * High-priority buy when migration WS detects a tracked smart wallet
 * or a volume spike on Pump.fun → PumpSwap/Raydium migrate.
 */
async function handleMigrationPriorityEvent(event: MigrationEvent): Promise<void> {
  if (paused) return;
  if (!config.strategy.enableMigrationPriority) {
    console.log(
      `[monitor] Migration priority signal ignored (toggle OFF) for ${event.mint.slice(0, 8)}…`
    );
    return;
  }

  // Volume-spike-only (no smart wallet) is weaker — still trade if enabled
  const strong =
    event.smartWalletsInvolved.length > 0 || event.volumeSpike;

  if (!strong) {
    console.log(
      `[monitor] Migration event skipped — no smart wallet / volume spike for ${event.mint.slice(0, 8)}…`
    );
    return;
  }

  if (tradedMints.has(event.mint) || pendingBuys.has(event.mint)) {
    console.log(
      `[monitor] Migration priority skipped — already traded ${event.mint.slice(0, 8)}…`
    );
    return;
  }

  if (!beginBuy(event.mint)) {
    console.log(
      `[monitor] Migration priority skipped — buy already in progress for ${event.mint.slice(0, 8)}…`
    );
    return;
  }

  try {
  const token = await resolveTokenMeta(event.mint);
  const label = formatTokenLabel(token.symbol, token.name, event.mint);
  const walletNames =
    event.smartWalletNames.length > 0
      ? event.smartWalletNames
      : ['volume-spike'];
  const wallets =
    event.smartWalletsInvolved.length > 0
      ? event.smartWalletsInvolved
      : ['volume-spike'];

  const signal: TradeSignal = {
    mint: event.mint,
    symbol: token.symbol,
    name: token.name,
    wallets,
    walletNames,
    isMigration: true,
    timestamp: Date.now(),
  };

  console.log(
    `[monitor] ⚡ STRONG BUY — migration + ${event.priorityReason ?? 'priority'} ` +
      `on ${label} (pool=${event.poolAddress?.slice(0, 8) ?? '?'}… vol=${event.volumeSol} SOL)`
  );

  markLaunchMigrated(event.mint);
  recordPumpSmartActivity({
    kind: 'migration',
    mint: event.mint,
    symbol: token.symbol,
    name: token.name,
    wallets,
    walletNames,
    isPumpFun: true,
    isMigration: true,
    priority: true,
    notes: event.priorityReason ?? 'migration_ws',
  });

  if (!(await passesFilters(signal))) {
    finishBuy(event.mint, false);
    return;
  }

  onSignalHandler?.(signal);

  const sizing = resolveTradeSize('migration', {
    riskScore: signal.antiRug?.riskScore,
    convictionScore: signal.convictionScore,
    sizeMultiplier: signal.sizeMultiplier,
  });
  recordSignalSizing(signal, sizing, true);
  console.log(`[monitor] ${sizing.reason}`);

  const slippageBps =
    config.strategy.migrationSlippageBps ?? config.paper.slippageBps;

  const result = await executeBuy(signal.mint, signal.symbol, {
    sourceWallets: signal.wallets,
    sourceNames: signal.walletNames,
    name: signal.name,
    solAmount: sizing.sizeSol,
    slippageBps,
    priority: true,
    strategyKind: 'migration',
    sizeReason: sizing.reason,
    antiRug: signal.antiRug
      ? {
          riskScore: signal.antiRug.riskScore,
          riskLevel: signal.antiRug.riskLevel,
          flags: signal.antiRug.flags,
          ok: signal.antiRug.ok,
        }
      : undefined,
  });
  finishBuy(event.mint, result.success);
  if (result.success) {
    recordTradeExecuted();
    console.log(
      `[monitor] Migration priority trade executed (${result.mode}): ${label} ` +
        `@ ${sizing.sizeSol.toFixed(3)} SOL`
    );
  } else {
    console.error(`[monitor] Migration priority trade failed: ${result.error}`);
  }
  } catch (err) {
    finishBuy(event.mint, false);
    throw err;
  }
}

async function enrichBuyEvent(buy: WalletBuyEvent): Promise<WalletBuyEvent> {
  const token = await resolveTokenMeta(buy.mint, {
    symbol: buy.symbol,
    name: buy.name,
  });
  buy.symbol = token.symbol;
  buy.name = token.name;
  cacheTokenMeta(buy.mint, token.symbol, token.name);
  return buy;
}

async function handleBuyEvent(buy: WalletBuyEvent): Promise<void> {
  await enrichBuyEvent(buy);
  const label = formatTokenLabel(buy.symbol, buy.name, buy.mint);

  // Enrich with migration listener data
  if (buy.isMigration) {
    markAsMigrated(buy.mint, buy.signature, [
      { address: buy.wallet, name: buy.walletName },
    ]);
  }
  const recentlyMigrated = isRecentlyMigrated(buy.mint);
  const isMigration = buy.isMigration || recentlyMigrated;

  console.log(
    `[monitor] 🔔 ${buy.walletName} bought ${label} (${buy.mint.slice(0, 8)}…) ` +
      `[pump: ${buy.isPumpFun}, migration: ${isMigration}]`
  );

  // Attach token metrics + anti-rug + bonding curve for dashboard (cached)
  try {
    const metrics = await fetchTokenMetrics(buy.mint);
    buy.metrics = summarizeTokenMetrics(metrics);
    const report = await evaluateAntiRug(buy.mint);
    buy.antiRug = summarizeAntiRug(report);
    if (report.sniper) buy.sniper = report.sniper;
    if (report.birdeye) buy.birdeye = report.birdeye;
  } catch {
    // non-fatal
  }

  // Dedicated sniper fetch if anti-rug didn't attach (filter off / fail)
  if (!buy.sniper && config.filters.enableSniperFilter !== false) {
    try {
      const sniper = await getTokenSniperActivity(buy.mint);
      if (sniper.source !== 'none') {
        buy.sniper = summarizeSniper(sniper);
      }
    } catch {
      // non-fatal
    }
  }

  // Birdeye fallback if anti-rug didn't attach overview
  if (!buy.birdeye) {
    try {
      const overview = await getTokenOverview(buy.mint);
      const signal = await getSmartMoneySignal(buy.mint);
      buy.birdeye = summarizeBirdeye(overview, signal);
    } catch {
      // non-fatal — dashboard shows Dex metrics only
    }
  }

  // Bonding curve for Pump.fun (pre-migration) candidates
  const onCurve =
    buy.isPumpFun && !isMigration && !recentlyMigrated;
  if (onCurve || buy.isPumpFun) {
    try {
      const curve = await fetchBondingCurve(buy.mint);
      if (curve.source !== 'none') {
        buy.bondingCurve = summarizeBondingCurve(curve);
        console.log(formatBondingCurveLog(label, curve));
      }
    } catch {
      // non-fatal
    }
  }

  // Early-buyer tracking on new Pump.fun launches
  if (buy.isPumpFun && !isMigration) {
    const progress = buy.bondingCurve?.progressPct ?? null;
    const earlyCount = recordEarlyBuyer({
      mint: buy.mint,
      symbol: buy.symbol,
      name: buy.name,
      wallet: buy.wallet,
      walletName: buy.walletName,
      signature: buy.signature,
      progressPct: progress,
    });
    buy.earlyBuyerCount = earlyCount;
    buy.earlyBuy = isEarlyCurveBuy(progress);
  }

  if (isMigration) markLaunchMigrated(buy.mint);

  if (!recentBuys.has(buy.mint)) {
    recentBuys.set(buy.mint, []);
  }
  const buys = recentBuys.get(buy.mint)!;

  if (!buys.some((b) => b.wallet === buy.wallet && b.signature === buy.signature)) {
    buys.push({
      ...buy,
      isMigration,
      metrics: buy.metrics,
      antiRug: buy.antiRug,
      bondingCurve: buy.bondingCurve,
      sniper: buy.sniper,
      birdeye: buy.birdeye,
      earlyBuy: buy.earlyBuy,
      earlyBuyerCount: buy.earlyBuyerCount,
    });
  }

  // Feed re-buy confirmation if we're watching this mint after a profit sell
  if (config.strategy.reBuyEnabled && isReBuyWatching(buy.mint)) {
    recordConfirmationBuy(buy.mint, buy.wallet, buy.walletName);
    const price = paperTrader.getTokenPrice(buy.mint);
    if (price != null) updateCandidatePrice(buy.mint, price);
    const triggered = await tryExecuteReBuy(buy.mint);
    if (triggered) return; // re-buy path handled entry
  }

  let signal: TradeSignal | null = null;
  let priority = false;

  // Migration + smart wallet activity = strong buy (larger size, tighter slip)
  if (config.strategy.enableMigrationPriority && isMigration) {
    signal = {
      mint: buy.mint,
      symbol: buy.symbol,
      name: buy.name,
      wallets: [buy.wallet],
      walletNames: [buy.walletName],
      isMigration: true,
      timestamp: Date.now(),
      bondingCurve: buy.bondingCurve,
      birdeye: buy.birdeye,
      earlyBuy: false,
      earlyBuyerCount: buy.earlyBuyerCount,
    };
    priority = true;
    console.log(
      `[monitor] 🚀 STRONG BUY — migration + smart wallet ${buy.walletName} on ${label}`
    );
    recordPumpSmartActivity({
      kind: 'migration',
      mint: buy.mint,
      symbol: buy.symbol,
      name: buy.name,
      wallets: [buy.wallet],
      walletNames: [buy.walletName],
      isPumpFun: true,
      isMigration: true,
      priority: true,
      curveProgressPct: buy.bondingCurve?.progressPct ?? null,
      birdeye: buy.birdeye,
      notes: `migration + ${buy.walletName}`,
    });
  } else if (
    config.strategy.enableBondingCurvePriority !== false &&
    buy.isPumpFun &&
    !isMigration &&
    buy.bondingCurve?.nearMigration
  ) {
    // Near-migration curve + smart money = prioritize like migration
    priority = true;
    signal = {
      mint: buy.mint,
      symbol: buy.symbol,
      name: buy.name,
      wallets: [buy.wallet],
      walletNames: [buy.walletName],
      isMigration: false,
      nearMigration: true,
      timestamp: Date.now(),
      bondingCurve: buy.bondingCurve,
      birdeye: buy.birdeye,
      earlyBuy: buy.earlyBuy,
      earlyBuyerCount: buy.earlyBuyerCount,
    };
    console.log(
      `[monitor] 📈 STRONG BUY — near-migration curve ${buy.bondingCurve.progressPct.toFixed(1)}% ` +
        `+ smart wallet ${buy.walletName} on ${label}`
    );
    recordPumpSmartActivity({
      kind: 'near_migration',
      mint: buy.mint,
      symbol: buy.symbol,
      name: buy.name,
      wallets: [buy.wallet],
      walletNames: [buy.walletName],
      isPumpFun: true,
      isMigration: false,
      priority: true,
      nearMigration: true,
      curveProgressPct: buy.bondingCurve.progressPct,
      birdeye: buy.birdeye,
      notes: `near-mig ${buy.bondingCurve.progressPct.toFixed(0)}%`,
    });
  } else if (buy.isPumpFun && !isMigration) {
    // Early-curve smart money priority (pre-migration launches)
    const walletMeta = config.smartWallets.find(
      (w) => w.address === buy.wallet
    );
    const earlyGate = shouldPrioritizeEarlyCurve({
      isPumpFun: true,
      isMigration: false,
      progressPct: buy.bondingCurve?.progressPct,
      nearMigration: buy.bondingCurve?.nearMigration,
      smartMoneyScore: buy.birdeye?.smartMoneyScore,
      earlyBuyerCount: buy.earlyBuyerCount ?? 1,
      walletTags: walletMeta?.tags,
    });

    if (earlyGate.prioritize) {
      priority = true;
      signal = {
        mint: buy.mint,
        symbol: buy.symbol,
        name: buy.name,
        wallets: [buy.wallet],
        walletNames: [buy.walletName],
        isMigration: false,
        nearMigration: false,
        earlyBuy: true,
        earlyBuyerCount: buy.earlyBuyerCount,
        timestamp: Date.now(),
        bondingCurve: buy.bondingCurve,
        birdeye: buy.birdeye,
      };
      console.log(
        `[monitor] 🎯 STRONG BUY — early Pump.fun curve (${earlyGate.reason}) ` +
          `+ smart wallet ${buy.walletName} on ${label}`
      );
      recordPumpSmartActivity({
        kind: 'early_buy',
        mint: buy.mint,
        symbol: buy.symbol,
        name: buy.name,
        wallets: [buy.wallet],
        walletNames: [buy.walletName],
        isPumpFun: true,
        isMigration: false,
        priority: true,
        curveProgressPct: buy.bondingCurve?.progressPct ?? null,
        birdeye: buy.birdeye,
        notes: earlyGate.reason,
      });
    } else if (config.strategy.enableConvergence) {
      signal = checkConvergence(buy.mint);
      if (signal?.nearMigration) {
        priority = true;
        console.log(
          `[monitor] 📈 STRONG BUY — convergence + near-migration curve ` +
            `${signal.bondingCurve?.progressPct?.toFixed(1) ?? '?'}% on ${label}`
        );
      } else if (signal?.earlyBuy) {
        priority = true;
        console.log(
          `[monitor] 🎯 STRONG BUY — convergence + early curve on ${label}`
        );
      }
      if (signal) {
        recordPumpSmartActivity({
          kind: signal.nearMigration
            ? 'near_migration'
            : signal.earlyBuy
              ? 'early_buy'
              : 'convergence',
          mint: signal.mint,
          symbol: signal.symbol,
          name: signal.name,
          wallets: signal.wallets,
          walletNames: signal.walletNames,
          isPumpFun: true,
          isMigration: false,
          priority,
          nearMigration: Boolean(signal.nearMigration),
          curveProgressPct: signal.bondingCurve?.progressPct ?? null,
          birdeye: signal.birdeye ?? buy.birdeye,
        });
      } else {
        // Still log non-priority pump curve activity for dashboard
        recordPumpSmartActivity({
          kind: buy.earlyBuy ? 'early_buy' : 'curve_buy',
          mint: buy.mint,
          symbol: buy.symbol,
          name: buy.name,
          wallets: [buy.wallet],
          walletNames: [buy.walletName],
          isPumpFun: true,
          isMigration: false,
          priority: false,
          curveProgressPct: buy.bondingCurve?.progressPct ?? null,
          birdeye: buy.birdeye,
          notes: earlyGate.reason,
        });
      }
    } else {
      signal = {
        mint: buy.mint,
        symbol: buy.symbol,
        name: buy.name,
        wallets: [buy.wallet],
        walletNames: [buy.walletName],
        isMigration,
        earlyBuy: buy.earlyBuy,
        earlyBuyerCount: buy.earlyBuyerCount,
        timestamp: Date.now(),
        bondingCurve: buy.bondingCurve,
        birdeye: buy.birdeye,
      };
      recordPumpSmartActivity({
        kind: buy.earlyBuy ? 'early_buy' : 'curve_buy',
        mint: buy.mint,
        symbol: buy.symbol,
        name: buy.name,
        wallets: [buy.wallet],
        walletNames: [buy.walletName],
        isPumpFun: true,
        isMigration: false,
        priority: false,
        curveProgressPct: buy.bondingCurve?.progressPct ?? null,
        birdeye: buy.birdeye,
      });
    }
  } else if (config.strategy.enableConvergence) {
    signal = checkConvergence(buy.mint);
    if (signal?.nearMigration) {
      priority = true;
      console.log(
        `[monitor] 📈 STRONG BUY — convergence + near-migration curve ` +
          `${signal.bondingCurve?.progressPct?.toFixed(1) ?? '?'}% on ${label}`
      );
    }
  } else {
    signal = {
      mint: buy.mint,
      symbol: buy.symbol,
      name: buy.name,
      wallets: [buy.wallet],
      walletNames: [buy.walletName],
      isMigration,
      timestamp: Date.now(),
      bondingCurve: buy.bondingCurve,
      birdeye: buy.birdeye,
    };
  }

  if (!signal) return;

  // Prefer enriched name/symbol from this buy if signal still has placeholders
  signal.symbol = buy.symbol || signal.symbol;
  signal.name = buy.name || signal.name;

  // Claim mint BEFORE slow filter awaits so concurrent wallet/migration
  // handlers cannot both open the same token.
  if (!beginBuy(buy.mint)) {
    if (isReBuyWatching(buy.mint)) {
      console.log(
        `[monitor] ${label} already traded — waiting for re-buy confirmation (dip + wallets/volume)`
      );
    } else {
      console.log(`[monitor] Signal skipped — already traded ${label}`);
    }
    return;
  }

  try {
  if (!(await passesFilters(signal))) {
    finishBuy(buy.mint, false);
    return;
  }

  console.log(
    `[monitor] ✅ SIGNAL${priority ? ' (priority)' : ''}: ${signal.walletNames.join(' + ')} → ${formatTokenLabel(signal.symbol, signal.name, signal.mint)}`
  );

  onSignalHandler?.(signal);

  const kind: 'migration' | 'normal' =
    signal.isMigration || signal.nearMigration || signal.earlyBuy
      ? 'migration'
      : 'normal';

  let sizing = resolveTradeSize(kind, {
    riskScore: signal.antiRug?.riskScore,
    convictionScore: signal.convictionScore,
    sizeMultiplier: signal.sizeMultiplier,
  });

  const buyOpts: {
    sourceWallets?: string[];
    sourceNames?: string[];
    name?: string;
    solAmount?: number;
    slippageBps?: number;
    priority?: boolean;
    strategyKind?: 'migration' | 'normal';
    sizeReason?: string;
    antiRug?: {
      riskScore: number;
      riskLevel: string;
      flags: string[];
      ok: boolean;
    };
  } = {
    sourceWallets: signal.wallets,
    sourceNames: signal.walletNames,
    name: signal.name,
    strategyKind: kind,
    solAmount: sizing.sizeSol,
    sizeReason: sizing.reason,
    antiRug: signal.antiRug
      ? {
          riskScore: signal.antiRug.riskScore,
          riskLevel: signal.antiRug.riskLevel,
          flags: signal.antiRug.flags,
          ok: signal.antiRug.ok,
        }
      : undefined,
  };

  if (
    priority &&
    (signal.isMigration
      ? config.strategy.enableMigrationPriority
      : signal.earlyBuy
        ? config.strategy.enableEarlyCurvePriority !== false
        : config.strategy.enableBondingCurvePriority !== false)
  ) {
    sizing = resolveTradeSize('migration', {
      riskScore: signal.antiRug?.riskScore,
      convictionScore: signal.convictionScore,
      sizeMultiplier: signal.sizeMultiplier,
    });
    buyOpts.solAmount = sizing.sizeSol;
    buyOpts.sizeReason = sizing.reason;
    buyOpts.slippageBps =
      config.strategy.migrationSlippageBps ?? config.paper.slippageBps;
    buyOpts.priority = true;
    buyOpts.strategyKind = 'migration';
  }

  recordSignalSizing(signal, sizing, true);
  console.log(`[monitor] ${sizing.reason}`);

  const result = await executeBuy(signal.mint, signal.symbol, buyOpts);
  finishBuy(buy.mint, result.success);

  if (result.success) {
    recordTradeExecuted();
    console.log(
      `[monitor] Copy trade executed (${result.mode}): ${formatTokenLabel(signal.symbol, signal.name, signal.mint)}` +
        (signal.convictionScore != null ? ` · conviction ${signal.convictionScore}` : '') +
        ` · ${sizing.sizeSol.toFixed(4)} SOL`
    );
  } else {
    console.error(`[monitor] Copy trade failed: ${result.error}`);
  }
  } catch (err) {
    finishBuy(buy.mint, false);
    throw err;
  }
}

/**
 * Refresh market data for watched mints and execute when confirmation is met.
 */
async function evaluateReBuyOpportunities(): Promise<void> {
  if (!config.strategy.reBuyEnabled || paused) return;

  const active = getReBuyCandidates().filter(
    (c) => c.status === 'watching' || c.status === 'dip_armed'
  );
  if (active.length === 0) return;

  for (const c of active) {
    // Prefer cached paper price; refresh from DexScreener periodically
    const cached = paperTrader.getTokenPrice(c.mint);
    if (cached != null) {
      updateCandidatePrice(c.mint, cached);
    }
    await refreshCandidateMarketData(c.mint);

    // Seed confirmation wallets from recentBuys in convergence window
    const recent = recentBuys.get(c.mint) ?? [];
    const windowMs = config.convergenceWindowMs;
    const cutoff = Date.now() - windowMs;
    for (const b of recent) {
      if (b.timestamp >= cutoff) {
        recordConfirmationBuy(c.mint, b.wallet, b.walletName);
      }
    }

    await tryExecuteReBuy(c.mint);
  }
}

/**
 * If dip + confirmation are ready, execute a re-buy (paper or live).
 * Returns true if a re-buy was attempted/executed.
 */
async function tryExecuteReBuy(mint: string): Promise<boolean> {
  if (!config.strategy.reBuyEnabled) return false;

  const conf = evaluateConfirmation(mint);
  if (!conf.ready) {
    // Periodic debug at low rate for armed candidates
    const c = getReBuyCandidates().find((x) => x.mint === mint);
    if (c?.status === 'dip_armed' && Math.random() < 0.15) {
      console.log(`[rebuy] ${c.symbol}: ${conf.reason}`);
    }
    return false;
  }

  // Already holding — don't double up
  if (paperTrader.hasOpenMint(mint)) {
    console.log(`[rebuy] Skip — already holding open position on ${mint.slice(0, 8)}…`);
    return false;
  }

  if (!beginBuy(mint, { allowRetrade: true })) {
    console.log(`[rebuy] Skip — buy already in progress for ${mint.slice(0, 8)}…`);
    return false;
  }

  try {
  const candidate = getReBuyCandidates().find((c) => c.mint === mint);
  if (!candidate) {
    finishBuy(mint, false);
    return false;
  }

  const label = formatTokenLabel(candidate.symbol, candidate.name, mint);
  const reason = conf.reason;

  console.log(
    `[monitor] 🔁 ${reason} — ${label} ` +
      `(dip ${conf.dipPct?.toFixed(1) ?? '?'}% from peak, ` +
      `${conf.walletCount} wallets` +
      (conf.volumeChangePct != null
        ? `, vol ${conf.volumeChangePct >= 0 ? '+' : ''}${conf.volumeChangePct.toFixed(0)}%`
        : '') +
      `)`
  );

  const signal: TradeSignal = {
    mint,
    symbol: candidate.symbol,
    name: candidate.name,
    wallets: candidate.confirmationWallets,
    walletNames: candidate.confirmationWalletNames,
    isMigration: isRecentlyMigrated(mint),
    timestamp: Date.now(),
  };

  if (!(await passesFilters(signal))) {
    console.log(`[rebuy] Filters blocked re-buy for ${label}`);
    finishBuy(mint, false);
    return false;
  }

  onSignalHandler?.(signal);

  const sizing = resolveTradeSize(signal.isMigration ? 'migration' : 'normal', {
    riskScore: signal.antiRug?.riskScore,
    convictionScore: signal.convictionScore,
    sizeMultiplier: signal.sizeMultiplier,
  });
  recordSignalSizing(signal, sizing, true);
  console.log(`[monitor] ${sizing.reason}`);

  const result = await executeBuy(mint, candidate.symbol, {
    sourceWallets: signal.wallets,
    sourceNames: signal.walletNames,
    name: candidate.name,
    solAmount: sizing.sizeSol,
    sizeReason: sizing.reason,
    strategyKind: signal.isMigration ? 'migration' : 'normal',
    antiRug: signal.antiRug
      ? {
          riskScore: signal.antiRug.riskScore,
          riskLevel: signal.antiRug.riskLevel,
          flags: signal.antiRug.flags,
          ok: signal.antiRug.ok,
        }
      : undefined,
  });

  finishBuy(mint, result.success);
  if (result.success) {
    recordTradeExecuted();
    markReBought(mint, reason);
    console.log(
      `[monitor] Re-buy executed (${result.mode}): ${label} — ${reason}`
    );
    return true;
  }

  console.error(`[monitor] Re-buy failed: ${result.error}`);
  return false;
  } catch (err) {
    finishBuy(mint, false);
    throw err;
  }
}

function resolveTradeSize(
  kind: 'migration' | 'normal',
  opts?: {
    riskScore?: number;
    convictionScore?: number;
    sizeMultiplier?: number;
  }
): DynamicSizeResult {
  return calculateDynamicPositionSize({
    equitySol: paperTrader.getEquitySol(),
    kind,
    riskScore: opts?.riskScore,
    convictionScore: opts?.convictionScore,
    sizeMultiplier: opts?.sizeMultiplier,
  });
}

function recordSignalSizing(
  signal: TradeSignal,
  sizing: DynamicSizeResult,
  accepted: boolean
): void {
  signal.dynamicSizeSol = sizing.sizeSol;
  signal.dynamicSizeReason = sizing.reason;
  recentSignals.unshift({
    mint: signal.mint,
    symbol: signal.symbol,
    name: signal.name,
    timestamp: Date.now(),
    wallets: signal.wallets,
    walletNames: signal.walletNames,
    isMigration: signal.isMigration,
    nearMigration: signal.nearMigration,
    earlyBuy: signal.earlyBuy,
    convictionScore: signal.convictionScore,
    riskScore: signal.antiRug?.riskScore,
    dynamicSizeSol: sizing.sizeSol,
    dynamicSizeReason: sizing.reason,
    accepted,
  });
  if (recentSignals.length > MAX_RECENT_SIGNALS) {
    recentSignals.length = MAX_RECENT_SIGNALS;
  }
}

export function getRecentSignals() {
  return recentSignals.slice(0, 30);
}

async function passesFilters(signal: TradeSignal): Promise<boolean> {
  const { filters, strategy } = config;

  if (isRiskHalted()) {
    console.log(`[monitor] Signal rejected — risk halt active`);
    return false;
  }

  // Refresh risk limits (may auto-pause)
  paperTrader.evaluateAndMaybeHaltRisk();
  if (isRiskHalted() || paused) {
    console.log(`[monitor] Signal rejected — risk/paused`);
    return false;
  }

  if (strategy.enableMigrationOnly && !signal.isMigration) {
    console.log(`[monitor] Signal rejected — migration-only enabled for ${signal.symbol}`);
    return false;
  }

  const openCount = paperTrader.getOpenPositions().length;
  if (openCount >= filters.maxConcurrentPositions) {
    console.log(
      `[monitor] Signal rejected — max concurrent positions (${filters.maxConcurrentPositions})`
    );
    return false;
  }

  if (paperTrader.hasOpenMint(signal.mint)) {
    console.log(
      `[monitor] Signal rejected — already holding ${signal.symbol || signal.mint.slice(0, 8)}`
    );
    return false;
  }

  const dailyPnl = paperTrader.getDailyPnlSol();
  if (dailyPnl <= -filters.dailyLossLimitSol) {
    console.log(
      `[monitor] Signal rejected — daily loss limit hit (${dailyPnl.toFixed(4)} SOL)`
    );
    return false;
  }

  if (filters.minWinRate > 0) {
    const winRate = paperTrader.getWinRatePct();
    if (winRate < filters.minWinRate) {
      console.log(
        `[monitor] Signal rejected — win rate ${winRate.toFixed(1)}% < ${filters.minWinRate}%`
      );
      return false;
    }
  }

  // On-chain / Dex metrics + comprehensive anti-rug
  const needsMetrics =
    config.filters.enableAntiRug !== false ||
    (filters.minLiquidity ?? 0) > 0 ||
    (filters.maxDevHoldPct ?? 0) > 0 ||
    (filters.maxDevPercent ?? 0) > 0 ||
    (filters.maxTopHolderPct ?? 0) > 0 ||
    (filters.maxHolderConcentration ?? 0) > 0 ||
    filters.skipIfMintAuthority;

  if (needsMetrics) {
    try {
      if (config.filters.enableAntiRug !== false) {
        const report: AntiRugReport = await evaluateAntiRug(signal.mint);
        signal.antiRug = summarizeAntiRug(report);
        signal.metrics = report.metricsSummary;
        if (report.sniper) signal.sniper = report.sniper;
        if (report.birdeye) signal.birdeye = report.birdeye;
        if (!report.ok) {
          console.log(formatAntiRugSkipLog(signal.symbol, report));
          for (const reason of report.skipReasons) {
            console.log(`[monitor] ${reason}`);
          }
          paperTrader.addLog(
            'info',
            `Anti-rug skip ${signal.symbol}: ${report.skipReasons.join('; ') || 'high risk'} (score ${report.riskScore})`,
            { mint: signal.mint, symbol: signal.symbol }
          );
          return false;
        }
        console.log(
          `[anti-rug] OK ${signal.symbol}: score=${report.riskScore} (${report.riskLevel}) ` +
            `liq=$${report.checks.liquidityUsd?.toFixed(0) ?? '?'} ` +
            `dev=${report.checks.devHoldPct?.toFixed(1) ?? '?'}% ` +
            `top10=${report.checks.top10HoldPct?.toFixed(1) ?? '?'}% ` +
            `lp=${report.checks.liquidityLockedOrBurned == null ? '?' : report.checks.liquidityLockedOrBurned ? 'locked' : 'unlocked'} ` +
            `sources=${report.sources.join('+')}`
        );
      } else {
        // Legacy metrics-only path when anti-rug master switch is off
        const { evaluateTokenMetricsFilters } = await import('./tokenMetrics');
        const metrics = await fetchTokenMetrics(signal.mint);
        signal.metrics = summarizeTokenMetrics(metrics);
        const verdict = evaluateTokenMetricsFilters(metrics);
        if (!verdict.ok) {
          console.log(
            `[monitor] Signal rejected — token metrics for ${signal.symbol}: ` +
              verdict.reasons.join('; ')
          );
          return false;
        }
      }
    } catch (err) {
      console.warn(
        `[monitor] Anti-rug / metrics fetch failed for ${signal.mint.slice(0, 8)}…:`,
        err instanceof Error ? err.message : err
      );
      if (
        config.filters.enableAntiRug !== false ||
        (filters.minLiquidity ?? 0) > 0 ||
        (filters.maxDevPercent ?? filters.maxDevHoldPct ?? 0) > 0
      ) {
        console.log(`[monitor] Skipped - anti-rug / metrics unavailable`);
        return false;
      }
    }
  }

  const rate = canExecuteTradeNow();
  if (!rate.ok) {
    console.log(`[monitor] Signal rejected — ${rate.reason}`);
    paperTrader.addLog(
      'info',
      `Trade rate limit: ${rate.reason}`,
      { mint: signal.mint, symbol: signal.symbol }
    );
    return false;
  }

  const conviction = evaluateSignalConviction(signal);
  signal.convictionScore = conviction.score;
  signal.sizeMultiplier = conviction.sizeMultiplier;
  if (!conviction.pass) {
    const detail = conviction.reasons.join('; ') || 'below threshold';
    const preview = resolveTradeSize(
      signal.isMigration || signal.nearMigration || signal.earlyBuy
        ? 'migration'
        : 'normal',
      {
        riskScore: signal.antiRug?.riskScore,
        convictionScore: conviction.score,
        sizeMultiplier: conviction.sizeMultiplier,
      }
    );
    recordSignalSizing(signal, preview, false);
    console.log(
      `[monitor] Signal rejected — conviction ${conviction.score}/${conviction.minRequired}: ${detail}`
    );
    paperTrader.addLog(
      'info',
      `Low conviction ${signal.symbol}: ${detail} (score ${conviction.score}) · would size ${preview.sizeSol.toFixed(4)} SOL`,
      { mint: signal.mint, symbol: signal.symbol }
    );
    return false;
  }
  console.log(
    `[monitor] Conviction OK ${signal.symbol}: score=${conviction.score} ` +
      `size×${conviction.sizeMultiplier.toFixed(2)} wallets=${signal.wallets.length}`
  );

  return true;
}

function checkConvergence(mint: string): TradeSignal | null {
  const buys = recentBuys.get(mint);
  if (!buys || buys.length === 0) return null;

  const now = Date.now();
  const windowStart = now - config.convergenceWindowMs;
  const recent = buys.filter((b) => b.timestamp >= windowStart);
  const uniqueWallets = [...new Set(recent.map((b) => b.wallet))];

  if (uniqueWallets.length < config.filters.convergenceRequired) return null;

  const walletNames = uniqueWallets.map((addr) => {
    const w = config.smartWallets.find((sw) => sw.address === addr);
    return w?.name ?? addr.slice(0, 8);
  });

  const isMigration = recent.some((b) => b.isMigration);
  const latestCurve = [...recent]
    .reverse()
    .find((b) => b.bondingCurve)?.bondingCurve;
  const nearMigration =
    !isMigration &&
    config.strategy.enableBondingCurvePriority !== false &&
    !!latestCurve?.nearMigration;
  const earlyBuy =
    !isMigration &&
    !nearMigration &&
    recent.some((b) => b.earlyBuy || isEarlyCurveBuy(b.bondingCurve?.progressPct));
  const earlyBuyerCount = Math.max(
    ...recent.map((b) => b.earlyBuyerCount ?? 0),
    uniqueWallets.length
  );
  const latestBirdeye = [...recent].reverse().find((b) => b.birdeye)?.birdeye;

  return {
    mint,
    symbol: recent[0].symbol,
    name: recent[0].name || recent[0].symbol,
    wallets: uniqueWallets,
    walletNames,
    isMigration,
    nearMigration,
    earlyBuy,
    earlyBuyerCount,
    bondingCurve: latestCurve,
    antiRug: recent[0].antiRug,
    metrics: recent[0].metrics,
    sniper: recent[0].sniper,
    birdeye: latestBirdeye ?? recent[0].birdeye,
    timestamp: now,
  };
}

function pruneOldBuys(): void {
  const cutoff = Date.now() - config.convergenceWindowMs * 2;

  for (const [mint, buys] of recentBuys.entries()) {
    const filtered = buys.filter((b) => b.timestamp >= cutoff);
    if (filtered.length === 0) {
      recentBuys.delete(mint);
    } else {
      recentBuys.set(mint, filtered);
    }
  }
}

export function getRecentActivity(): WalletBuyEvent[] {
  const all: WalletBuyEvent[] = [];
  for (const buys of recentBuys.values()) {
    all.push(...buys);
  }
  return all.sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);
}

export function getWalletLastActivity(address: string): WalletLastActivity | null {
  return walletLastActivity.get(address) ?? null;
}

export function getWalletsWithActivity() {
  const watchingSet = new Set(getWalletsForPolling().map((w) => w.address));
  return config.smartWallets.map((w) => {
    const activity = walletLastActivity.get(w.address) ?? null;
    const lastTradedAt =
      w.lastTradedAt ?? w.lastActive ?? activity?.timestamp ?? null;
    const daysSince =
      lastTradedAt != null
        ? (Date.now() - lastTradedAt) / MS_PER_DAY
        : null;
    const active = isWalletActive(w);
    const activityLabel = formatActivityLabel(lastTradedAt, active);
    const lastActiveDisplay =
      lastTradedAt != null
        ? `${new Date(lastTradedAt).toLocaleString()} (${activityLabel})`
        : activityLabel;

    return {
      ...w,
      lastActivity: activity,
      lastTradedAt,
      lastActive: lastTradedAt ?? w.lastActive,
      tradesLast30d: w.tradesLast30d ?? activity?.tradesLast30d,
      daysSinceTrade: daysSince,
      isActive: active,
      activityLabel,
      lastActiveDisplay,
      watching: watchingSet.has(w.address),
    };
  });
}

export function getMonitorStatus(): {
  running: boolean;
  paused: boolean;
  watchedWallets: number;
  trackedWallets: number;
  enabledWallets: number;
  watchingLabel: string;
  watchingList: Array<{
    name: string;
    address: string;
    source?: string;
    enabled: boolean;
    isActive: boolean;
  }>;
  recentSignals: number;
  dailyPnlSol: number;
  openPositions: number;
  migration: ReturnType<typeof getMigrationStatus>;
  autoSell: boolean;
  activityFilter: boolean;
  rebuy: ReturnType<typeof getReBuyStatus>;
  risk: ReturnType<typeof getRiskStatus>;
  walletDiscovery: ReturnType<typeof getDiscoveryStatus>;
  birdeye: ReturnType<typeof getBirdeyeStatus>;
  pumpSmart: ReturnType<typeof getPumpSmartStatus>;
  tradeRate: ReturnType<typeof getTradeRateStatus>;
  selectiveEnabled: boolean;
  recentSizedSignals: number;
} {
  const risk = getRiskStatus({
    equitySol: paperTrader.getEquitySol(),
    dailyPnlSol: paperTrader.getDailyPnlSol(),
    weeklyPnlSol: paperTrader.getWeeklyPnlSol(),
  });

  const watching = getWalletsForPolling();
  const tracked = config.smartWallets.length;
  const enabled = config.smartWallets.filter((w) => w.enabled).length;

  return {
    running,
    paused,
    watchedWallets: watching.length,
    trackedWallets: tracked,
    enabledWallets: enabled,
    watchingLabel: `Watching ${watching.length} of ${tracked} wallets`,
    watchingList: watching.slice(0, 50).map((w) => ({
      name: w.name,
      address: w.address,
      source: w.source,
      enabled: w.enabled,
      isActive: isWalletActive(w),
    })),
    recentSignals: recentBuys.size,
    dailyPnlSol: paperTrader.getDailyPnlSol(),
    openPositions: paperTrader.getOpenPositions().length,
    migration: getMigrationStatus(),
    autoSell: config.strategy.enableAutoSell,
    activityFilter: config.filters.enableActivityFilter,
    rebuy: getReBuyStatus(),
    risk,
    walletDiscovery: getDiscoveryStatus(),
    birdeye: getBirdeyeStatus(),
    pumpSmart: getPumpSmartStatus(),
    tradeRate: getTradeRateStatus(),
    selectiveEnabled: config.selective?.enabled !== false,
    recentSizedSignals: recentSignals.length,
  };
}

/** Allow resume after operator acknowledges risk halt */
export function clearMonitorRiskHalt(): void {
  clearRiskHalt();
}
