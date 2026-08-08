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
import { config, SmartWallet, persistWallets, isScalperSuiteProfile, getScalperSuiteVariantLabel } from './config';
import { normalizeSkipReason } from './soakMetrics';
import { isDeniedCopyMint } from './deniedMints';
import {
  getConnection,
  getRpcStats,
  getRpcUrl,
  runWithRpcRole,
  isRpcGateSkipError,
  isUtilityOnWeakPublic,
} from './connection';
import {
  runDedupedRpcJob,
  shouldDeferBackgroundForCritical,
  logBackgroundDeferred,
} from './rpcGate';
import { utilityPollScale } from './rpcLoadControl';
import { isSoftThrottleRpcUrl } from './rpcUrl';
import { getRpcRoleFor } from './rpcRouting';
import { executeBuy, refreshPositionPrices, resolveSourceEntryMcUsd } from './trade';
import { paperTrader } from './paperTrader';
import { logger } from './logger';
import {
  assignTradeProfile,
  stampFromAssignment,
  applyProfileExitRulesToBuyOpts,
  isSmartBotProfilesEnabled,
  getTradeProfilesStatus,
  getTradeProfileEnabledFlags,
  withStrategyProfileGateAsync,
  applyTradeProfileSizing,
  evaluateTradeProfileLanes,
  pickWinningTradeProfileLane,
  type TradeProfileMatchContext,
  type TradeProfileLaneResult,
} from './tradeProfiles';
import { evaluateAffordability } from './fundGate';
import { refreshOpenMarketActivity } from './marketData';
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
  startMarketScanner,
  stopMarketScanner,
  onScannerCandidate,
  getScannerFeed,
  getScannerStatus,
  annotateScannerCandidate,
  markScannerCooldown,
  isMarketScannerSignal,
  isMarketScannerAddress,
  setScannerBuyQueueDepthFn,
  resetMarketScannerSession,
  MARKET_SCANNER_WALLET,
  MARKET_SCANNER_NAME,
  type ScannerCandidate,
} from './marketScanner';
import { seedPriceHistoryFromCandles } from './technicalLevels';
import { evaluateIndicators } from './indicators';
import {
  getWalletActivity,
  formatActivityLabel,
  getTokenSniperActivity,
  summarizeSniper,
  getGmgnStatus,
} from './gmgn';
import {
  isRecentlyMigrated,
  getMigrationEvent,
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
  markReEntryAttempt,
  refreshCandidateMarketData,
  getReBuyCandidates,
  updateCandidatePrice,
  getReBuyStatus,
  getReEntryEffectiveParams,
} from './reBuy';
import {
  calculateDynamicPositionSize,
  isRiskHalted,
  getRiskHaltReason,
  onRiskHalt,
  getRiskStatus,
  clearRiskHalt,
  clampToMaxAllowedTradeSol,
  type DynamicSizeResult,
} from './risk';
import {
  fetchTokenMetrics,
  getCachedTokenMetrics,
  summarizeTokenMetrics,
  clearTokenMetricsCache,
} from './tokenMetrics';
import {
  evaluateAntiRug,
  summarizeAntiRug,
  formatAntiRugSkipLog,
  isNonBypassableSkipReason,
  type AntiRugReport,
} from './antiRug';
import {
  evaluateBuyPumpFunOnlyGate,
  evaluateEntryTimingGate,
  evaluateHolderConcentrationHardFloors,
  isPumpFunMintSuffix,
} from './deadTokenFilters';
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
  clearRecentTradeTimes,
} from './signalQuality';
import {
  applyQualityToWallet,
  passesWalletQualityGate,
  isProvenTopPerformer,
  refreshAllWalletQualityScores,
  maybeAutoPruneLowQuality,
  pruneLowQualityWallets,
} from './walletQuality';
import {
  effectiveClusterMinWallets,
  effectiveMinWalletQualityScore,
  effectiveMomentumMinHoldPct,
} from './filterEffective';
import {
  isStrategyEnabled,
  isStrategyEnabledGlobal,
  logStrategyDecision,
  ensureStrategyToggles,
  getQualityModeOverlays,
} from './strategies';
import {
  isAnyShortTermScalperActive,
  resolveShortTermEntry,
  type ShortTermStrategyId,
} from './shortTermStrategies';
import {
  resolvePostRunDipForSignal,
  logPostRunDipDecision,
} from './postRunDip';
import { registerDipBuyHistoryProvider } from './dipSmartWallet';

export { pruneLowQualityWallets, refreshAllWalletQualityScores };

/** Build match context for early Soft Bot / final profile assignment. */
function buildTradeProfileMatchContext(
  signal: TradeSignal,
  extras?: {
    scalpMode?: boolean;
    shortTermStrategyId?: string | null;
    strategyKind?: 'migration' | 'normal';
  }
): TradeProfileMatchContext {
  const migEv = getMigrationEvent(signal.mint);
  const migrationAgeMs =
    migEv?.detectedAt != null ? Date.now() - migEv.detectedAt : null;
  const ctx: TradeProfileMatchContext = {
    isMigration: signal.isMigration,
    nearMigration: signal.nearMigration,
    earlyBuy: signal.earlyBuy,
    migrationFresh: isRecentlyMigrated(signal.mint),
    migrationAgeMs,
    curveProgressPct:
      signal.bondingCurve?.progressPct != null &&
      Number.isFinite(signal.bondingCurve.progressPct)
        ? Number(signal.bondingCurve.progressPct)
        : (signal as { curveProgressPct?: number | null }).curveProgressPct ??
          null,
    scalpMode: extras?.scalpMode,
    shortTermStrategyId: extras?.shortTermStrategyId,
    convictionScore: signal.convictionScore,
    dropFromPeakPct: signal.dropFromPeakPct,
    localPullbackPct: signal.localPullbackPct ?? signal.dropFromPeakPct,
    kolCount: signal.kolCount ?? null,
    holderGrowthPct: signal.holderGrowthPct ?? null,
    confirmationLevel: signal.confirmationLevel ?? null,
    strategyKind: extras?.strategyKind,
    symbol: signal.symbol,
    marketCapUsd:
      signal.sourceEntryMcUsd ?? signal.metrics?.marketCapUsd ?? null,
    holderCount: signal.metrics?.holderCountEstimate ?? null,
    top10HoldPct: signal.metrics?.top10HoldPct ?? null,
    volumeH1Usd: signal.metrics?.volumeH1Usd ?? null,
    volumeM5Usd: signal.metrics?.volumeM5Usd ?? null,
    recentBuyVolumeUsd: signal.metrics?.recentBuyVolumeUsd ?? null,
    tokenAgeHours: signal.tokenAgeHours ?? null,
    priceChange24hPct: signal.metrics?.priceChange24hPct ?? null,
    priceChangeH1Pct: signal.metrics?.priceChangeH1Pct ?? null,
    smartMoneyScore: signal.birdeye?.smartMoneyScore ?? null,
    liquidityUsd: signal.metrics?.liquidityUsd ?? null,
    walletCount: Array.isArray(signal.wallets)
      ? signal.wallets.filter((w) => !isMarketScannerAddress(w)).length ||
        signal.wallets.length
      : null,
    nearKeyFib: signal.nearKeyFib === true,
    nearSupport: signal.nearSupport === true,
    nearMultiTfSupport: signal.nearMultiTfSupport === true,
    nearMultiTfResistance: signal.nearMultiTfResistance === true,
    srConfluenceScore:
      signal.srConfluenceScore != null &&
      Number.isFinite(Number(signal.srConfluenceScore))
        ? Number(signal.srConfluenceScore)
        : null,
    supportTfHits: Array.isArray(signal.supportTfHits)
      ? signal.supportTfHits
      : null,
    supportPriceSol:
      signal.supportPriceSol != null &&
      Number.isFinite(Number(signal.supportPriceSol))
        ? Number(signal.supportPriceSol)
        : null,
    resistancePriceSol:
      signal.resistancePriceSol != null &&
      Number.isFinite(Number(signal.resistancePriceSol))
        ? Number(signal.resistancePriceSol)
        : null,
    fib05PriceSol:
      signal.fib05PriceSol != null &&
      Number.isFinite(Number(signal.fib05PriceSol))
        ? Number(signal.fib05PriceSol)
        : null,
    fib618PriceSol:
      signal.fib618PriceSol != null &&
      Number.isFinite(Number(signal.fib618PriceSol))
        ? Number(signal.fib618PriceSol)
        : null,
    priceSol:
      signal.priceSol != null && Number.isFinite(Number(signal.priceSol))
        ? Number(signal.priceSol)
        : signal.lastPriceSol != null &&
            Number.isFinite(Number(signal.lastPriceSol))
          ? Number(signal.lastPriceSol)
          : null,
    chartPatternIds: signal.chartPatternIds ?? null,
    chartPatternSummary: signal.chartPatternSummary ?? null,
    chartPatternHits: signal.chartPatternHits ?? null,
    scannerOrigin: isMarketScannerSignal(signal),
    entrySource: signal.entrySource,
    preferProfileId: signal.candidateTradeProfileId ?? null,
    specialtyFeed: signal.specialtyFeed ?? null,
    armedWatch:
      signal.armedWatch === true ||
      signal.dipWatchTriggered === true ||
      (Array.isArray(signal.scannerReasons) &&
        signal.scannerReasons.some((r) =>
          /scalper-watch:triggered|dip-watch:triggered|grad-watch:triggered|armedWatch/i.test(
            String(r)
          )
        )),
    setupWatchFamily:
      signal.setupWatchFamily ||
      (signal.dipWatchTriggered === true
        ? 'dip'
        : Array.isArray(signal.scannerReasons)
          ? /scalper-watch/i.test(signal.scannerReasons.join(' '))
            ? 'scalper'
            : /grad-watch/i.test(signal.scannerReasons.join(' '))
              ? 'grad'
              : /dip-watch/i.test(signal.scannerReasons.join(' '))
                ? 'dip'
                : null
          : null),
    dipWatchTriggered: signal.dipWatchTriggered === true,
    entryStyleHint: signal.entryStyleHint ?? null,
    walletQualityAvg: (() => {
      const addrs = Array.isArray(signal.wallets) ? signal.wallets : [];
      if (!addrs.length) return null;
      let sum = 0;
      let n = 0;
      for (const addr of addrs) {
        const w = config.smartWallets.find((sw) => sw.address === addr);
        if (!w) continue;
        if (w.qualityScore == null) applyQualityToWallet(w);
        if (w.qualityScore != null && Number.isFinite(w.qualityScore)) {
          sum += Number(w.qualityScore);
          n += 1;
        }
      }
      return n > 0 ? sum / n : null;
    })(),
  };
  // Stamp entry-style DNA once for lane fight + buy meta
  try {
    const { resolveDetectedEntryStyle, detectSupportReclaim } =
      require('./supportReclaim') as typeof import('./supportReclaim');
    const det = resolveDetectedEntryStyle({
      ...ctx,
      armedWatch: ctx.armedWatch,
      setupWatchFamily: ctx.setupWatchFamily,
      entryStyleHint: ctx.entryStyleHint,
      preferMigration: ctx.preferProfileId === 'migration_sniper',
    });
    ctx.detectedEntryStyle = det.detectedEntryStyle;
    ctx.lateChase = det.lateChase;
    try {
      const reclaim = detectSupportReclaim({
        priceSol: ctx.priceSol,
        supportPriceSol: ctx.supportPriceSol,
        nearSupport: ctx.nearSupport,
        nearKeyFib: ctx.nearKeyFib,
        nearMultiTfSupport: ctx.nearMultiTfSupport,
        mtfSupportPriceSol:
          ctx.nearMultiTfSupport === true ? ctx.supportPriceSol : null,
      });
      (ctx as { extensionFromLevelPct?: number }).extensionFromLevelPct =
        reclaim.extensionFromLevelPct;
      (signal as { extensionFromLevelPct?: number }).extensionFromLevelPct =
        reclaim.extensionFromLevelPct;
    } catch {
      /* soft */
    }
  } catch {
    /* fail soft */
  }
  return ctx;
}

/** Stamp entry-style DNA onto buy meta (fail soft). */
function stampEntryStyleOnBuyOpts(
  buyOpts: NonNullable<Parameters<typeof executeBuy>[2]>,
  signal: TradeSignal,
  ctx?: TradeProfileMatchContext | null
): void {
  try {
    let style = ctx?.detectedEntryStyle ?? null;
    let late = ctx?.lateChase;
    if (style == null || late == null) {
      const { resolveDetectedEntryStyle } =
        require('./supportReclaim') as typeof import('./supportReclaim');
      const det = resolveDetectedEntryStyle({
        nearSupport: signal.nearSupport,
        nearKeyFib: signal.nearKeyFib,
        nearMultiTfSupport: signal.nearMultiTfSupport,
        supportPriceSol: signal.supportPriceSol,
        srConfluenceScore: signal.srConfluenceScore,
        dropFromPeakPct: signal.dropFromPeakPct,
        localPullbackPct: signal.localPullbackPct,
        priceChangeH1Pct: signal.metrics?.priceChangeH1Pct,
        isMigration: signal.isMigration,
        migrationFresh: isRecentlyMigrated(signal.mint),
        nearMigration: signal.nearMigration,
        shortTermStrategyId: buyOpts.shortTermStrategyId,
        preferProfileId:
          buyOpts.tradeProfileId || signal.candidateTradeProfileId,
        smartMoneyScore: signal.birdeye?.smartMoneyScore,
        walletCount: Array.isArray(signal.wallets)
          ? signal.wallets.length
          : null,
        entrySource: signal.entrySource,
        volumeM5Usd: signal.metrics?.volumeM5Usd,
        priceSol: signal.priceSol,
      });
      if (style == null) style = det.detectedEntryStyle;
      if (late == null) late = det.lateChase;
    }
    const lateChase = late === true;
    // Prefer armed-watch entryStyle stamp over rediscovery
    const hint = signal.entryStyleHint || (signal as { entryStyleHint?: string }).entryStyleHint;
    const armed =
      signal.armedWatch === true ||
      (Array.isArray(signal.scannerReasons) &&
        signal.scannerReasons.some((r) =>
          /scalper-watch:triggered|dip-watch:triggered|grad-watch:triggered|armedWatch/i.test(
            String(r)
          )
        ));
    // Armed watches: prefer handoff entryStyleHint over rediscovered late_chase
    if (armed && hint) {
      (buyOpts as { entryStyle?: string }).entryStyle = String(hint);
      if (lateChase && String(hint).toLowerCase() !== 'late_chase') {
        (buyOpts as { entryStyleSecondary?: string }).entryStyleSecondary =
          'late_chase';
      }
    } else {
      (buyOpts as { entryStyle?: string }).entryStyle = lateChase
        ? style === 'late_chase'
          ? 'late_chase'
          : String(style || 'late_chase')
        : String(style || 'unknown');
    }
    if (
      lateChase &&
      style &&
      style !== 'late_chase' &&
      !(buyOpts as { entryStyleSecondary?: string }).entryStyleSecondary
    ) {
      (buyOpts as { entryStyleSecondary?: string }).entryStyleSecondary =
        'late_chase';
    }
    // Armed handoff with a reclaim hint is not a late-chase primary admit
    (buyOpts as { lateChaseAtEntry?: boolean }).lateChaseAtEntry =
      armed && hint && String(hint).toLowerCase() !== 'late_chase'
        ? false
        : lateChase;
    if (
      signal.dipWatchTriggered === true ||
      (Array.isArray(signal.scannerReasons) &&
        signal.scannerReasons.some((r) =>
          /dip-watch:triggered/i.test(String(r))
        ))
    ) {
      (buyOpts as { dipWatchTriggered?: boolean }).dipWatchTriggered = true;
    }
    if (armed) {
      (buyOpts as { armedWatch?: boolean }).armedWatch = true;
      (buyOpts as { entryPath?: string }).entryPath = 'armed_trigger';
      const fam =
        signal.setupWatchFamily ||
        (signal.dipWatchTriggered === true ||
        (buyOpts as { dipWatchTriggered?: boolean }).dipWatchTriggered === true
          ? 'dip'
          : Array.isArray(signal.scannerReasons)
            ? /scalper-watch/i.test(signal.scannerReasons.join(' '))
              ? 'scalper'
              : /grad-watch/i.test(signal.scannerReasons.join(' '))
                ? 'grad'
                : /dip-watch/i.test(signal.scannerReasons.join(' '))
                  ? 'dip'
                  : undefined
            : undefined);
      if (fam) {
        (buyOpts as { setupWatchFamily?: string }).setupWatchFamily = fam;
      }
    } else {
      (buyOpts as { entryPath?: string }).entryPath = 'discretionary';
    }
    // Expectancy Lift stamps (permission score / governor influence)
    const sigPerm = (signal as { tradePermissionScore?: number })
      .tradePermissionScore;
    if (sigPerm != null && Number.isFinite(sigPerm)) {
      (buyOpts as { tradePermissionScore?: number }).tradePermissionScore =
        Number(sigPerm);
    }
    if ((signal as { governorInfluenced?: boolean }).governorInfluenced === true) {
      (buyOpts as { governorInfluenced?: boolean }).governorInfluenced = true;
    }
    // Normalize MB alias onto buy meta
    const es = String((buyOpts as { entryStyle?: string }).entryStyle || '');
    if (es === 'momentum_continuation') {
      (buyOpts as { entryStyle?: string }).entryStyle =
        'level_momentum_expansion';
    }
  } catch {
    /* fail soft */
  }
}

/**
 * Best-effort MC / holders / volume / dip-pullback before Smart Bot lane fight.
 * Wallet signals often arrive without metrics; without this, minConviction /
 * Min MC Override / Scalper Max MC zero every lane.
 */
const holderGrowthSnapshots = new Map<
  string,
  { holders: number; at: number }
>();

function noteHolderGrowthPct(
  mint: string,
  holders: number | null | undefined
): number | null {
  if (holders == null || !Number.isFinite(holders) || holders <= 0) return null;
  const prev = holderGrowthSnapshots.get(mint);
  const now = Date.now();
  holderGrowthSnapshots.set(mint, { holders, at: now });
  if (!prev || prev.holders <= 0) return null;
  const hours = (now - prev.at) / 3_600_000;
  if (hours < 0.08) return null;
  return ((holders - prev.holders) / prev.holders) * 100;
}

function estimateDropFromPeakPct(signal: TradeSignal): number | null {
  if (
    signal.dropFromPeakPct != null &&
    Number.isFinite(signal.dropFromPeakPct) &&
    signal.dropFromPeakPct > 0
  ) {
    return Number(signal.dropFromPeakPct);
  }
  const h1 = signal.metrics?.priceChangeH1Pct;
  if (h1 != null && Number.isFinite(h1) && h1 < -1) {
    return Math.abs(Number(h1));
  }
  const candles = signal.candles;
  if (Array.isArray(candles) && candles.length >= 4) {
    const prices = candles
      .map((c) => Number(c.priceSol ?? c.price ?? 0))
      .filter((p) => p > 0);
    if (prices.length >= 4) {
      const peak = Math.max(...prices);
      const last = prices[prices.length - 1]!;
      if (peak > last) return ((peak - last) / peak) * 100;
    }
  }
  return null;
}

async function enrichSignalForLaneFight(signal: TradeSignal): Promise<void> {
  const needsMetrics =
    !signal.metrics ||
    signal.metrics.marketCapUsd == null ||
    signal.metrics.holderCountEstimate == null ||
    signal.metrics.volumeH1Usd == null;
  if (needsMetrics) {
    try {
      const raw =
        getCachedTokenMetrics(signal.mint) ??
        (await fetchTokenMetrics(signal.mint));
      const summary = summarizeTokenMetrics(raw);
      if (!signal.metrics) {
        signal.metrics = summary;
      } else {
        signal.metrics = {
          ...signal.metrics,
          marketCapUsd:
            signal.metrics.marketCapUsd ?? summary.marketCapUsd ?? null,
          holderCountEstimate:
            signal.metrics.holderCountEstimate ??
            summary.holderCountEstimate ??
            null,
          volumeH1Usd:
            signal.metrics.volumeH1Usd ?? summary.volumeH1Usd ?? null,
          volumeM5Usd:
            signal.metrics.volumeM5Usd ?? summary.volumeM5Usd ?? null,
          recentBuyVolumeUsd:
            signal.metrics.recentBuyVolumeUsd ??
            summary.recentBuyVolumeUsd ??
            null,
          liquidityUsd:
            signal.metrics.liquidityUsd ?? summary.liquidityUsd ?? null,
          priceChange24hPct:
            signal.metrics.priceChange24hPct ??
            summary.priceChange24hPct ??
            null,
          priceChangeH1Pct:
            signal.metrics.priceChangeH1Pct ??
            summary.priceChangeH1Pct ??
            null,
          top10HoldPct:
            signal.metrics.top10HoldPct ?? summary.top10HoldPct ?? null,
        };
      }
    } catch (err) {
      console.warn(
        `[monitor] Lane enrich metrics failed for ${signal.mint.slice(0, 8)}…:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  if (signal.sourceEntryMcUsd == null || !(signal.sourceEntryMcUsd > 0)) {
    const fromMetrics = signal.metrics?.marketCapUsd;
    if (fromMetrics != null && fromMetrics > 0) {
      signal.sourceEntryMcUsd = fromMetrics;
    } else {
      try {
        const mc = await resolveSourceEntryMcUsd(signal.mint);
        if (mc != null && mc > 0) signal.sourceEntryMcUsd = mc;
      } catch {
        /* non-fatal */
      }
    }
  }

  // Always mirror resolved MC into metrics for lane floors
  if (
    signal.sourceEntryMcUsd != null &&
    signal.sourceEntryMcUsd > 0
  ) {
    if (!signal.metrics) {
      signal.metrics = {
        liquidityUsd: null,
        marketCapUsd: signal.sourceEntryMcUsd,
        volume24hUsd: null,
        volumeH1Usd: null,
        volumeM5Usd: null,
        recentBuyVolumeUsd: null,
        txnsH1: null,
        buysH1: null,
        sellsH1: null,
        buySellRatio: null,
        priceUsd: null,
        priceChangeH1Pct: null,
        priceChange24hPct: null,
        holderCountEstimate: null,
        topHolderPct: null,
        top10HoldPct: null,
        devHoldPct: null,
        devActiveRecently: false,
        mintAuthority: null,
        source: 'enrich',
      };
    } else if (
      !(signal.metrics.marketCapUsd != null && signal.metrics.marketCapUsd > 0)
    ) {
      signal.metrics.marketCapUsd = signal.sourceEntryMcUsd;
    }
  }

  // Migration / grad / near-mig: retry resolve once if still unknown
  const needsMigMcRetry =
    (signal.isMigration === true ||
      signal.nearMigration === true ||
      signal.setupWatchFamily === 'grad' ||
      /grad-watch|migration/i.test((signal.scannerReasons || []).join(' '))) &&
    (!(signal.sourceEntryMcUsd != null && signal.sourceEntryMcUsd > 0) ||
      !(
        signal.metrics?.marketCapUsd != null && signal.metrics.marketCapUsd > 0
      ));
  if (needsMigMcRetry) {
    try {
      const mc = await resolveSourceEntryMcUsd(signal.mint);
      if (mc != null && mc > 0) {
        signal.sourceEntryMcUsd = mc;
        if (!signal.metrics) {
          signal.metrics = {
            liquidityUsd: null,
            marketCapUsd: mc,
            volume24hUsd: null,
            volumeH1Usd: null,
            volumeM5Usd: null,
            recentBuyVolumeUsd: null,
            txnsH1: null,
            buysH1: null,
            sellsH1: null,
            buySellRatio: null,
            priceUsd: null,
            priceChangeH1Pct: null,
            priceChange24hPct: null,
            holderCountEstimate: null,
            topHolderPct: null,
            top10HoldPct: null,
            devHoldPct: null,
            devActiveRecently: false,
            mintAuthority: null,
            source: 'enrich',
          };
        } else {
          signal.metrics.marketCapUsd = mc;
        }
      }
    } catch {
      /* non-fatal */
    }
  }

  // Dip / pullback enrich for Dip Buyer + Compounder lane fight
  const drop = estimateDropFromPeakPct(signal);
  if (drop != null) {
    signal.dropFromPeakPct = drop;
    signal.localPullbackPct = drop;
  }

  const growth = noteHolderGrowthPct(
    signal.mint,
    signal.metrics?.holderCountEstimate
  );
  if (growth != null) signal.holderGrowthPct = growth;

  // Soft Fib/S from cached technicals when missing
  if (signal.nearKeyFib == null && signal.nearSupport == null) {
    try {
      const { getTechnicalSnapshot } =
        require('./technicalLevels') as typeof import('./technicalLevels');
      const snap = getTechnicalSnapshot(signal.mint);
      if (snap) {
        if (snap.nearKeyFib) signal.nearKeyFib = true;
        if (snap.nearSupport) signal.nearSupport = true;
      }
    } catch {
      /* optional */
    }
  }

  // Lightweight confirmation level for HWR multi-TA (non-blocking)
  if (signal.confirmationLevel == null) {
    try {
      const { resolveConfirmationLayerForSignal } =
        require('./confirmationLayer') as typeof import('./confirmationLayer');
      const verdict = resolveConfirmationLayerForSignal(signal as never);
      const st = verdict?.report?.status;
      if (st === 'strong' || st === 'very_strong') {
        signal.confirmationLevel = 'strong';
      } else if (st === 'moderate') {
        signal.confirmationLevel = 'soft';
      } else if (st) {
        signal.confirmationLevel = 'none';
      }
    } catch {
      /* optional */
    }
  }

  // KOL count from Zion feed when missing
  if (signal.kolCount == null) {
    try {
      const { getZionScannerFeed } =
        require('./zionKolScanner') as typeof import('./zionKolScanner');
      const hit = getZionScannerFeed(80).find((c) => c.mint === signal.mint);
      if (hit?.kolCount != null) signal.kolCount = hit.kolCount;
    } catch {
      /* optional */
    }
  }

  console.log(
    `[monitor] Lane enrich ${signal.symbol}: ` +
      `MC=${signal.sourceEntryMcUsd != null ? `$${Math.round(signal.sourceEntryMcUsd)}` : '?'} · ` +
      `holders=${signal.metrics?.holderCountEstimate ?? '?'} · ` +
      `vol1h=${signal.metrics?.volumeH1Usd != null ? `$${Math.round(signal.metrics.volumeH1Usd)}` : '?'} · ` +
      `drop=${signal.dropFromPeakPct != null ? `${signal.dropFromPeakPct.toFixed(0)}%` : '?'} · ` +
      `kol=${signal.kolCount ?? '?'}`
  );
}

/** Attach short-term scalp / post-run dip seed when an active strategy qualifies. */
/**
 * Seed short-term / scalp hints before multi-profile assignment.
 *
 * When Multi-profile is ON we avoid blanket-tagging every smart-money buy as
 * Quick/Micro scalp — that used to force almost every trade onto the Scalper
 * profile and zero-out High Win-Rate / Trend / Compounder.
 *
 * Specialty engines (migration / momentum / reversal / post-run dip) still
 * pre-tag so their matching profiles can win. Generic quick/micro only pre-tag
 * when Multi-profile is OFF (legacy single-stack behaviour).
 */
function resolveScalpBuyFlag(signal: {
  mint?: string;
  symbol?: string;
  metrics?: {
    volume24hUsd?: number | null;
    recentVolumeUsd?: number | null;
    recentBuyVolumeUsd?: number | null;
    volumeH1Usd?: number | null;
    volumeM5Usd?: number | null;
    priceChangeH1Pct?: number | null;
    priceChange24hPct?: number | null;
    priceUsd?: number | null;
  } | null;
  birdeye?: { smartMoneyScore?: number | null; volume24hUsd?: number | null } | null;
  isMigration?: boolean;
  nearMigration?: boolean;
  wallets?: unknown[];
  walletNames?: string[];
  convictionScore?: number;
  dropFromPeakPct?: number | null;
  signalAgeMinutes?: number | null;
  tokenAgeHours?: number | null;
}): { scalpMode?: true; shortTermStrategyId?: ShortTermStrategyId } {
  // Prefer Post-Run Dip when it fully qualifies (higher-timeframe path)
  if (isStrategyEnabled('post_run_dip')) {
    const dip = resolvePostRunDipForSignal({
      symbol: signal.symbol,
      mint: signal.mint,
      isMigration: signal.isMigration,
      nearMigration: signal.nearMigration,
      wallets: signal.wallets,
      walletNames: signal.walletNames,
      convictionScore: signal.convictionScore,
      dropFromPeakPct: signal.dropFromPeakPct,
      signalAgeMinutes: signal.signalAgeMinutes,
      tokenAgeHours: signal.tokenAgeHours,
      metrics: signal.metrics,
      birdeye: signal.birdeye,
    });
    if (dip?.seedExitMode && dip.report.qualifies) {
      logPostRunDipDecision(signal.symbol || 'token', dip, 'take');
      console.log(
        `[post-run-dip] ENTRY ${signal.symbol} — ${dip.report.detail}`
      );
      return { scalpMode: true, shortTermStrategyId: 'post_run_dip' };
    }
  }

  if (!isAnyShortTermScalperActive()) return {};
  const resolved = resolveShortTermEntry({
    volume24hUsd: signal.metrics?.volume24hUsd,
    recentVolumeUsd: signal.metrics?.recentVolumeUsd ?? signal.metrics?.volumeH1Usd,
    recentBuyVolumeUsd: signal.metrics?.recentBuyVolumeUsd,
    isSmartMoney: true,
    isMigration: signal.isMigration === true,
    convictionScore: signal.convictionScore,
    dropFromPeakPct: signal.dropFromPeakPct,
  });
  if (!resolved) {
    logStrategyDecision(
      'quick_scalper',
      'skip',
      'no short-term strategy qualified'
    );
    return {};
  }

  const multiOn = config.tradeProfiles?.enabled !== false;
  const genericQuick =
    resolved.id === 'quick_scalper' || resolved.id === 'micro_scalper';
  // Multi-profile: leave generic quick/micro untagged so Scalper must win on
  // small-MC / volume match — not by pre-empting every copy trade.
  if (multiOn && genericQuick) {
    console.log(
      `[scalp] defer ${resolved.id} until profile assign — ${resolved.reason}`
    );
    return {};
  }

  const suite = isScalperSuiteProfile(config.strategyProfile)
    ? ` [${getScalperSuiteVariantLabel(config.strategyProfile)}]`
    : '';
  console.log(
    `[scalp] ENTRY strategy=${resolved.id}${suite} — ${resolved.reason}`
  );
  logStrategyDecision(
    resolved.id === 'migration_event' ? 'migration_sniper' : resolved.id,
    'take',
    resolved.reason
  );
  return { scalpMode: true, shortTermStrategyId: resolved.id };
}

export interface WalletBuyEvent {
  wallet: string;
  walletName: string;
  mint: string;
  /** Token ticker */
  symbol: string;
  /** Full token name */
  name: string;
  signature: string;
  /** On-chain block time (ms) */
  timestamp: number;
  /** Wall-clock when the monitor first recorded this buy */
  detectedAt?: number;
  isPumpFun: boolean;
  isMigration: boolean;
  solSpent?: number;
  /** Copy-trade outcome for Recent Signals */
  tradeStatus?: 'seen' | 'taken' | 'skipped' | 'waiting';
  skipReason?: string;
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
  /**
   * How the entry was discovered:
   * wallet copy | market scanner | migration | hybrid (scanner + wallets).
   */
  entrySource?: 'wallet' | 'scanner' | 'migration' | 'hybrid';
}

export interface WalletSellEvent {
  wallet: string;
  walletName: string;
  mint: string;
  symbol: string;
  name: string;
  signature: string;
  timestamp: number;
  detectedAt?: number;
  isPumpFun: boolean;
  isMigration: boolean;
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
  /** Factor breakdown for logs / dashboard */
  convictionBreakdown?: string;
  /** Position size multiplier from risk/conviction scoring */
  sizeMultiplier?: number;
  /** Calculated dynamic buy size in SOL */
  dynamicSizeSol?: number;
  /** Human-readable sizing reason for logs / dashboard */
  dynamicSizeReason?: string;
  /** Market cap when the smart wallet bought (signal-time) */
  sourceEntryMcUsd?: number;
  /** Minutes since earliest smart-wallet buy in cluster */
  signalAgeMinutes?: number;
  /** Momentum confirmation result */
  momentumOk?: boolean;
  /** Single-wallet top-performer migration exception */
  allowSingleWalletException?: boolean;
  /** Drop from recent peak % (positive) when known */
  dropFromPeakPct?: number | null;
  /** Local pullback % (alias / refined drop) */
  localPullbackPct?: number | null;
  /** Distinct KOL wallets on mint when known */
  kolCount?: number | null;
  /** Holder growth % vs prior snapshot */
  holderGrowthPct?: number | null;
  /** Confirmation layer level for HWR multi-TA */
  confirmationLevel?: 'none' | 'soft' | 'strong' | null;
  /** Estimated token age in hours when known */
  tokenAgeHours?: number | null;
  /** Soft-scored profile id when Smart Bot Profiles is ON (entry gating) */
  candidateTradeProfileId?: string;
  /** Optional candle path for Fib/S&R (backtester / Post-Run Dip) */
  candles?: Array<{
    time: number;
    priceSol?: number;
    price?: number;
    volume?: number;
  }>;
  /** Spot price in SOL when known (technicals / marks) */
  priceSol?: number | null;
  /**
   * How the entry was discovered:
   * wallet copy | market scanner | migration | hybrid (scanner + wallets).
   */
  entrySource?: 'wallet' | 'scanner' | 'migration' | 'hybrid';
  nearKeyFib?: boolean;
  nearSupport?: boolean;
  nearResistance?: boolean;
  /** Multi-TF S/R confluence stamps */
  nearMultiTfSupport?: boolean;
  nearMultiTfResistance?: boolean;
  srConfluenceScore?: number;
  supportTfHits?: string[];
  resistanceTfHits?: string[];
  supportPriceSol?: number | null;
  resistancePriceSol?: number | null;
  fib05PriceSol?: number | null;
  fib618PriceSol?: number | null;
  lastPriceSol?: number | null;
  chartPatternIds?: string[];
  chartPatternSummary?: string | null;
  chartPatternHits?: Array<{
    id: string;
    confidence: number;
    breakout: boolean;
    bias?: string;
  }>;
  scannerPlaybook?: string;
  scannerConfluence?: number;
  candleSource?: 'real' | 'synthetic';
  /** Jupiter organicScore when known (scanner / pro-quality proxy) */
  organicScore?: number | null;
  /** Specialty feed tag when from per-profile Kolscan/Jupiter pass */
  specialtyFeed?: 'jupiter' | 'kolscan' | 'alphascan' | 'majors' | null;
  /** Scanner / setup-watch reason tags (e.g. grad-watch:triggered) */
  scannerReasons?: string[];
  /** Armed setup-watch handoff (Mode B / Dip / Grad) */
  armedWatch?: boolean;
  entryStyleHint?: string;
  qualityScoreHint?: number;
  sizePlanSol?: number;
  /** scalper | dip | grad when opened from a setup watch */
  setupWatchFamily?: 'scalper' | 'dip' | 'grad';
  /** Dip watch trigger stamp (badge fallback) */
  dipWatchTriggered?: boolean;
  /** HMC stamps for Profit Capture Layer (set in passesFilters) */
  hmcSetup?: string;
  hmcConfidence?: number;
  gateDecision?: string;
}

/**
 * Additive Profile TA Playbook gate — Soft nudges size; Hard may skip.
 * Fail-open on throw. Stamps BuyOptions for episode learning.
 */
function applyProfileTaPlaybookGate(
  profileId: string | null | undefined,
  signal: TradeSignal,
  buyOpts: NonNullable<Parameters<typeof executeBuy>[2]>
): { skip: boolean; reason: string } {
  try {
    const pid = String(profileId || '');
    const speedPath =
      pid === 'scalper' ||
      pid === 'migration_sniper' ||
      pid === 'migration_event';
    const thinCandles =
      !Array.isArray(signal.candles) || signal.candles.length < 8;

    const { getProfileTaPlaybook } =
      require('./profileTaPlaybookStore') as typeof import('./profileTaPlaybookStore');
    const { runProfileTaEntryGate } =
      require('./profileTaPlaybook') as typeof import('./profileTaPlaybook');
    const ind = evaluateIndicators({
      mint: signal.mint,
      candles: signal.candles,
      priceSol: signal.priceSol,
    });
    const sm =
      signal.birdeye?.smartMoneyScore != null
        ? Number(signal.birdeye.smartMoneyScore)
        : null;
    const volH1 = Number(signal.metrics?.volumeH1Usd ?? 0);
    const volM5 = Number(signal.metrics?.volumeM5Usd ?? 0);
    const gate = runProfileTaEntryGate(
      profileId,
      {
        candles: signal.candles,
        nearSupport:
          signal.nearSupport === true || signal.nearMultiTfSupport === true,
        nearResistance:
          signal.nearResistance === true ||
          signal.nearMultiTfResistance === true,
        nearKeyFib: signal.nearKeyFib === true,
        nearMultiTfSupport: signal.nearMultiTfSupport === true,
        nearMultiTfResistance: signal.nearMultiTfResistance === true,
        srConfluenceScore: signal.srConfluenceScore,
        supportTfHits: signal.supportTfHits,
        chartPatternIds: signal.chartPatternIds ?? null,
        indicators: ind,
        smartMoneyScore: sm,
        whaleAvailable: sm != null && Number.isFinite(sm),
        whaleBullish: sm != null && sm >= 60,
        whaleBearish: sm != null && sm <= 35,
        volumeExpanding:
          (Number.isFinite(volM5) && volM5 > 0 && volH1 > volM5 * 3) ||
          (signal.holderGrowthPct != null && signal.holderGrowthPct > 5),
        holdersExpanding:
          signal.holderGrowthPct != null && signal.holderGrowthPct > 5,
      },
      getProfileTaPlaybook
    );
    Object.assign(buyOpts, gate.stamp);
    if (
      Array.isArray(signal.scannerReasons) &&
      signal.scannerReasons.some((r) =>
        /scalper-watch:triggered/i.test(String(r))
      )
    ) {
      (buyOpts as { scalperWatchTriggered?: boolean }).scalperWatchTriggered =
        true;
    }
    if (
      signal.dipWatchTriggered === true ||
      (Array.isArray(signal.scannerReasons) &&
        signal.scannerReasons.some((r) =>
          /dip-watch:triggered/i.test(String(r))
        ))
    ) {
      (buyOpts as { dipWatchTriggered?: boolean }).dipWatchTriggered = true;
    }
    if (
      signal.armedWatch === true ||
      (Array.isArray(signal.scannerReasons) &&
        signal.scannerReasons.some((r) =>
          /scalper-watch:triggered|dip-watch:triggered|grad-watch:triggered|armedWatch/i.test(
            String(r)
          )
        ))
    ) {
      (buyOpts as { armedWatch?: boolean }).armedWatch = true;
      (buyOpts as { entryPath?: string }).entryPath = 'armed_trigger';
      const fam =
        signal.setupWatchFamily ||
        (signal.dipWatchTriggered === true
          ? 'dip'
          : Array.isArray(signal.scannerReasons)
            ? /scalper-watch/i.test(signal.scannerReasons.join(' '))
              ? 'scalper'
              : /grad-watch/i.test(signal.scannerReasons.join(' '))
                ? 'grad'
                : /dip-watch/i.test(signal.scannerReasons.join(' '))
                  ? 'dip'
                  : undefined
            : undefined);
      if (fam) {
        (buyOpts as { setupWatchFamily?: string }).setupWatchFamily = fam;
      }
    }
    if (signal.entryStyleHint) {
      (buyOpts as { entryStyleHint?: string }).entryStyleHint =
        signal.entryStyleHint;
    }
    if (
      signal.qualityScoreHint != null &&
      Number.isFinite(signal.qualityScoreHint)
    ) {
      (buyOpts as { qualityScoreHint?: number }).qualityScoreHint = Number(
        signal.qualityScoreHint
      );
    }
    // Also stamp multi-TF fields directly from signal when gate was soft/off
    if (signal.nearMultiTfSupport === true) {
      (buyOpts as { nearMultiTfSupport?: boolean }).nearMultiTfSupport = true;
    }
    if (signal.nearMultiTfResistance === true) {
      (buyOpts as { nearMultiTfResistance?: boolean }).nearMultiTfResistance =
        true;
    }
    if (signal.srConfluenceScore != null) {
      (buyOpts as { srConfluenceScore?: number }).srConfluenceScore =
        signal.srConfluenceScore;
    }
    if (Array.isArray(signal.supportTfHits) && signal.supportTfHits.length) {
      (buyOpts as { supportTfHits?: string[] }).supportTfHits =
        signal.supportTfHits;
    }
    if (gate.result && gate.result.mode !== 'off') {
      console.log(
        `[monitor] ${gate.skip ? 'STRATEGY_SKIP' : 'STRATEGY_TAKE'} profile_ta_playbook — ` +
          `${signal.symbol} · ${gate.plainLanguage} · ${gate.reason}`
      );
      try {
        appendMarlThoughtToLaneFight(signal.mint, gate.plainLanguage);
      } catch {
        /* optional */
      }
    }
    // Scalper / Migration must not stall on candle-provider outages
    if (gate.skip && speedPath && thinCandles) {
      return {
        skip: false,
        reason: `${gate.reason} · speed-path soft-fail (thin candles)`,
      };
    }
    if (gate.skip) {
      return { skip: true, reason: gate.reason };
    }
    if (
      gate.convictionMult !== 1 &&
      buyOpts.solAmount != null &&
      Number.isFinite(buyOpts.solAmount)
    ) {
      buyOpts.solAmount = Number(buyOpts.solAmount) * gate.convictionMult;
      buyOpts.sizeReason =
        (buyOpts.sizeReason || '') +
        ` · TA ×${gate.convictionMult.toFixed(2)}`;
    }
    return { skip: false, reason: gate.reason };
  } catch (err) {
    console.warn('[profile-ta] gate fail-open', err);
    return { skip: false, reason: 'TA playbook fail-open' };
  }
}

/**
 * Fast-profile soft skip when volume is collapsed / ultra-thin.
 * Divergence never hard-blocks alone — only hardFloorFailFast (collapsed).
 */
function evaluateVolumeIntelFastSoftSkip(
  profileId: string | null | undefined,
  signal: TradeSignal
): { skip: boolean; reason: string } {
  try {
    const {
      evaluateVolumeIntelligence,
      logVolumeIntelligence,
      isVolumeIntelFastProfile,
      getVolumeIntelligenceConfig,
    } = require('./volumeIntelligence') as typeof import('./volumeIntelligence');
    if (!getVolumeIntelligenceConfig().enabled) {
      return { skip: false, reason: '' };
    }
    if (!isVolumeIntelFastProfile(profileId)) {
      return { skip: false, reason: '' };
    }
    const snap = evaluateVolumeIntelligence({
      volumeM5Usd: signal.metrics?.volumeM5Usd ?? null,
      volumeH1Usd: signal.metrics?.volumeH1Usd ?? null,
      priceChangePct:
        signal.metrics?.priceChangeH1Pct ??
        signal.metrics?.priceChange24hPct ??
        null,
      profileId,
      candles: Array.isArray(signal.candles) ? signal.candles : null,
    });
    logVolumeIntelligence(snap, signal.symbol || signal.mint.slice(0, 8));
    if (snap.hardFloorFailFast) {
      return {
        skip: true,
        reason: 'Volume collapsed — entry penalised',
      };
    }
  } catch {
    /* fail soft */
  }
  return { skip: false, reason: '' };
}

/**
 * Dip Buyer Recovery soft-skip for collapsed / ultra-thin volume (stages 0–2).
 */
function evaluateDipBuyerRecoveryVolumeSkip(
  profileId: string | null | undefined,
  signal: TradeSignal
): { skip: boolean; reason: string } {
  try {
    const {
      getDipBuyerRecoveryConstraints,
      isDipBuyerRecovering,
    } = require('./dipBuyerRecovery') as typeof import('./dipBuyerRecovery');
    if (!isDipBuyerRecovering(profileId)) {
      return { skip: false, reason: '' };
    }
    const c = getDipBuyerRecoveryConstraints(profileId);
    if (!c.active || !c.skipCollapsedVolume) {
      return { skip: false, reason: '' };
    }
    const {
      evaluateVolumeIntelligence,
      getVolumeIntelligenceConfig,
    } = require('./volumeIntelligence') as typeof import('./volumeIntelligence');
    if (!getVolumeIntelligenceConfig().enabled) {
      return { skip: false, reason: '' };
    }
    const snap = evaluateVolumeIntelligence({
      volumeM5Usd: signal.metrics?.volumeM5Usd ?? null,
      volumeH1Usd: signal.metrics?.volumeH1Usd ?? null,
      priceChangePct:
        signal.metrics?.priceChangeH1Pct ??
        signal.metrics?.priceChange24hPct ??
        null,
      profileId,
      candles: Array.isArray(signal.candles) ? signal.candles : null,
    });
    if (
      snap.decayState === 'collapsed' ||
      snap.hardFloorFailFast ||
      (snap.volM5 != null &&
        snap.volM5 > 0 &&
        snap.volM5 < c.minVolumeM5Usd * 0.25)
    ) {
      return {
        skip: true,
        reason: `Dip Buyer Recovery Stage ${c.stage}: skip collapsed/ultra-thin volume`,
      };
    }
  } catch {
    /* fail soft */
  }
  return { skip: false, reason: '' };
}

type SignalHandler = (signal: TradeSignal) => void;

const recentBuys = new Map<string, WalletBuyEvent[]>();
const lastSignature = new Map<string, string>();
const walletLastActivity = new Map<string, WalletLastActivity>();

// Dip SM buyback / prior-buy detection — live Paper + Live Sim path
registerDipBuyHistoryProvider((mint) => {
  const buys = recentBuys.get(mint) ?? [];
  return buys.map((b) => ({ wallet: b.wallet, timestamp: b.timestamp }));
});
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

/** Longer-lived feed for dashboard (separate from convergence window prune). */
const activityFeed: WalletBuyEvent[] = [];
const MAX_ACTIVITY_FEED = 200;
/** Keep Recent Signals for a full day; UI de-emphasizes stale rows. */
const ACTIVITY_FEED_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Rolling 24h signal timestamps for Overview count.
 * Separate from activityFeed (capped at 200) so the displayed total is not truncated.
 * Values are wall-clock detectedAt (not block time) so the signal light stays honest.
 */
const SIGNAL_COUNT_WINDOW_MS = 24 * 60 * 60 * 1000;
const signals24hTimestamps: number[] = [];

/** Parsed buys waiting for filter/trade handling — keeps pollWallet fast. */
const pendingBuyEvents: WalletBuyEvent[] = [];
let buyDrainInFlight = false;
const MAX_PENDING_BUY_EVENTS = 80;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let activityTimer: ReturnType<typeof setInterval> | null = null;
let running = false;
let paused = false;
let pollInFlight = false;
/** Rotates which wallets are polled first so a mid-cycle 429 cannot starve the same tail forever. */
let pollRotationOffset = 0;
/**
 * When soft-watch caps the poll set below enabled count, rotate colder wallets
 * through the non-sticky slots so Quiet wallets are not permanently ignored.
 */
let softWatchRotateOffset = 0;
/** address → last ms included in soft-watch set (fair coverage across full pool). */
const softWatchLastCoveredAt = new Map<string, number>();
let softWatchCoverageLogAt = 0;
let lastSoftWatchCoveragePct: number | null = null;
let lastSoftWatchStickyN = 0;
let lastSoftWatchRotateN = 0;
/** After a free-tier 429, skip poll cycles until this time (keeps /health responsive). */
let pollRateLimitedUntil = 0;
/** Last poll-cycle soak counters for /api/status. */
let lastPollAttempted = 0;
let lastPollCompleted = 0;
/** Unix ms when the last poll cycle finished (health stall detection). */
let lastPollCompletedAt = 0;
let lastOpenMarkRefreshAt = 0;
let lastPollRateLimited = false;
let onSignalHandler: SignalHandler | null = null;
let lastSoftThrottleLogAt = 0;

/** Detect Solana RPC / HTTP 429 rate-limit errors from web3.js or providers. */
function isRpcRateLimitError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? `${err.message} ${err.name}`
      : String(err ?? '');
  return (
    /\b429\b/i.test(msg) ||
    /too many requests/i.test(msg) ||
    /rate.?limit/i.test(msg) ||
    /-32429/.test(msg)
  );
}

/**
 * Soft-throttle Favourites poll when the resolved URL is free/public OR when
 * Share ON routes wallet_poll to Utility (even after piggyback onto paid rpc-url).
 * Without this, Utility failover to a custom RPC drops the soft-watch cap and
 * floods Critical/Scanners fallbacks after ~30–60s.
 */
function shouldSoftThrottleWalletPoll(rpcUrl: string): boolean {
  if (isSoftThrottleRpcUrl(rpcUrl)) return true;
  const share = Boolean(config.rpc?.shareLoad);
  if (!share) return false;
  return getRpcRoleFor('wallet_poll', true) === 'utility';
}

/** Free Helius/Alchemy/public — gentle concurrency so boot seeding cannot crash Render. */
function getWalletPollThrottle(rpcUrl: string): {
  soft: boolean;
  batchSize: number;
  batchGapMs: number;
  sigLimit: number;
  maxParse: number;
  pause429Ms: number;
  /** Max wallets touched per cycle (rotate remainder next tick). */
  maxWalletsPerCycle: number;
  abortCycleOn429: boolean;
  cycleBudgetMs: number;
} {
  const soft = shouldSoftThrottleWalletPoll(rpcUrl);
  const share = Boolean(config.rpc?.shareLoad);
  const envCap = Number(process.env.RPC_WALLET_POLL_PER_CYCLE);
  const scale = utilityPollScale();
  const weakUtil = share && isUtilityOnWeakPublic();
  const hardCycleCap = Number.isFinite(envCap)
    ? Math.max(1, Math.min(40, Math.round(envCap)))
    : Math.max(
        1,
        Math.round((share ? 5 : 8) * scale.cycleCapScale * (weakUtil ? 0.6 : 1))
      );

  if (soft) {
    const cap = resolveSoftWatchCap().effectiveCap;
    // When cap is low, poll fewer wallets per cycle to keep Utility cool.
    const maxPerCycle =
      cap === 0
        ? 0
        : Math.min(
            hardCycleCap,
            share ? (weakUtil ? 2 : 3) : 4,
            Math.max(1, Math.ceil(cap / 5))
          );
    return {
      soft: true,
      batchSize: 1,
      batchGapMs: Math.round((share ? 1_800 : 1_100) * scale.gapScale),
      sigLimit: 5,
      maxParse: 1,
      pause429Ms: 25_000,
      maxWalletsPerCycle: maxPerCycle,
      abortCycleOn429: true,
      /** Hard stop so pollInFlight cannot block the next tick / starve /health. */
      cycleBudgetMs: share ? (weakUtil ? 2_500 : 3_500) : 5_000,
    };
  }
  // Paid / non-soft: still hard-cap + stagger — never blast every favourite at once.
  return {
    soft: false,
    batchSize: share ? 2 : 3,
    batchGapMs: Math.round((share ? 280 : 140) * scale.gapScale),
    sigLimit: 12,
    maxParse: 4,
    pause429Ms: 400,
    maxWalletsPerCycle: hardCycleCap,
    abortCycleOn429: false,
    cycleBudgetMs: share ? 8_000 : 15_000,
  };
}

let lastPollElapsedMs: number | null = null;

/** Resolve Favourites soft-watch cap (env > config > code default). */
export function resolveSoftWatchCap(): {
  effectiveCap: number;
  source: 'env' | 'config' | 'default';
  paused: boolean;
  shareLoad: boolean;
  defaultCap: number;
} {
  const shareLoad = Boolean(config.rpc?.shareLoad);
  const defaultCap = shareLoad ? 8 : 16;
  if (
    process.env.RPC_SOFT_WATCH_CAP != null &&
    process.env.RPC_SOFT_WATCH_CAP !== '' &&
    Number.isFinite(Number(process.env.RPC_SOFT_WATCH_CAP))
  ) {
    const effectiveCap = Math.max(
      0,
      Math.min(200, Math.round(Number(process.env.RPC_SOFT_WATCH_CAP)))
    );
    return {
      effectiveCap,
      source: 'env',
      paused: effectiveCap === 0,
      shareLoad,
      defaultCap,
    };
  }
  if (
    config.rpc?.softWatchCap != null &&
    Number.isFinite(Number(config.rpc.softWatchCap))
  ) {
    const effectiveCap = Math.max(
      0,
      Math.min(200, Math.round(Number(config.rpc.softWatchCap)))
    );
    return {
      effectiveCap,
      source: 'config',
      paused: effectiveCap === 0,
      shareLoad,
      defaultCap,
    };
  }
  return {
    effectiveCap: defaultCap,
    source: 'default',
    paused: false,
    shareLoad,
    defaultCap,
  };
}

export function getSoftWatchRuntimeSnapshot(): {
  softWatchCap: number;
  softWatchCapSource: 'env' | 'config' | 'default';
  softWatchPaused: boolean;
  softWatchDefault: number;
  shareLoad: boolean;
  enabledWallets: number;
  watchPool: number;
  lastPollAttempted: number;
  lastPollCompleted: number;
  /** Unix ms — when last poll cycle finished (0 = never). */
  lastPollCompletedAt: number;
  lastOpenMarkRefreshAt: number;
  lastPollRateLimited: boolean;
  lastPollElapsedMs: number | null;
  pollRole: string;
  utilityHost: string | null;
  /** % of enabled pool covered by soft-watch in last ~30 min. */
  coveragePct30m: number | null;
  stickySlots: number;
  rotateSlots: number;
} {
  const cap = resolveSoftWatchCap();
  const pollRole = getRpcRoleFor('wallet_poll', cap.shareLoad);
  let utilityHost: string | null = null;
  try {
    utilityHost = new URL(getRpcUrl(pollRole)).hostname;
  } catch {
    utilityHost = null;
  }
  const enabledList = config.smartWallets.filter((w) => w.enabled);
  const since = Date.now() - 30 * 60_000;
  let covered = 0;
  for (const w of enabledList) {
    const t = softWatchLastCoveredAt.get(w.address);
    if (t != null && t >= since) covered += 1;
  }
  const coveragePct30m =
    enabledList.length > 0
      ? Math.round((covered / enabledList.length) * 1000) / 10
      : null;
  lastSoftWatchCoveragePct = coveragePct30m;

  return {
    softWatchCap: cap.effectiveCap,
    softWatchCapSource: cap.source,
    softWatchPaused: cap.paused,
    softWatchDefault: cap.defaultCap,
    shareLoad: cap.shareLoad,
    enabledWallets: enabledList.length,
    watchPool: getWalletsForPolling().length,
    lastPollAttempted,
    lastPollCompleted,
    lastPollCompletedAt,
    lastOpenMarkRefreshAt,
    lastPollRateLimited,
    lastPollElapsedMs: lastPollElapsedMs,
    pollRole,
    utilityHost,
    coveragePct30m,
    stickySlots: lastSoftWatchStickyN,
    rotateSlots: lastSoftWatchRotateN,
  };
}

/** Allow resume after operator acknowledges risk halt — soft watch helpers above */

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

/**
 * Wipe in-memory signal/session tallies for a fresh module soak test.
 * Also clears scanner mint cooldowns, buy-queue backlog, and poll 429 pause so
 * signal flow matches a clean process boot (without stopping the monitor).
 * Does not change risk/module settings. Caller should clear risk halt then
 * resumeMonitor() so a halt-induced pause does not leave scanning dead.
 */
export function resetMonitorSession(): {
  clearedActivity: number;
  clearedSizedSignals: number;
  clearedSignalTimestamps: number;
  clearedPendingBuys: number;
  scanner: ReturnType<typeof resetMarketScannerSession>;
} {
  const clearedActivity = activityFeed.length;
  const clearedSizedSignals = recentSignals.length;
  const clearedSignalTimestamps = signals24hTimestamps.length;
  const clearedPendingBuys = pendingBuyEvents.length;
  activityFeed.length = 0;
  recentSignals.length = 0;
  signals24hTimestamps.length = 0;
  recentBuys.clear();
  pendingBuyEvents.length = 0;
  clearTradedMints();
  resetSkipReasonCounts();
  clearRecentTradeTimes();
  // Unstick wallet-poll gates that a deploy would also clear.
  pollRateLimitedUntil = 0;
  pollInFlight = false;
  const scanner = resetMarketScannerSession();
  return {
    clearedActivity,
    clearedSizedSignals,
    clearedSignalTimestamps,
    clearedPendingBuys,
    scanner,
  };
}

const ACTIVITY_REFRESH_MS = 30 * 60 * 1000; // re-check activity every 30 min (was 15)
/** Min gap before re-checking the same wallet's activity on-chain/GMGN. */
const ACTIVITY_PER_WALLET_MIN_MS = 45 * 60 * 1000;
/** Cap how many wallets get a full activity refresh per timer tick. */
const ACTIVITY_MAX_PER_CYCLE = 8;
const activityRefreshAt = new Map<string, number>();
let activityRotationOffset = 0;
let lastFullActivityPassAt = 0;
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

  // Score tracked wallets + optional auto-prune (unwatch only)
  try {
    refreshAllWalletQualityScores();
    maybeAutoPruneLowQuality();
  } catch (err) {
    console.warn(
      '[monitor] Wallet quality refresh failed:',
      err instanceof Error ? err.message : err
    );
  }

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

  // Soft-throttle RPCs (free Helius/Alchemy): wait longer so Render health passes
  // before we seed wallets in small rotating batches.
  const shareBoot = Boolean(config.rpc?.shareLoad);
  const softBoot =
    isSoftThrottleRpcUrl(getRpcUrl()) ||
    (shareBoot && getRpcRoleFor('wallet_poll', true) === 'utility');
  // Share+Utility: delay first soft-watch so Critical/Scanners stay clean after deploy.
  const firstPollDelayMs = softBoot ? (shareBoot ? 45_000 : 15_000) : 5_000;
  setTimeout(() => {
    void pollAllWallets();
  }, firstPollDelayMs);

  // Activity refresh hits GMGN/RPC per wallet — defer heavily on free RPC or skip
  // the first pass entirely (import grace keeps wallets eligible without a scan).
  void (async () => {
    await new Promise((r) => setTimeout(r, softBoot ? 180_000 : 30_000));
    if (!running || paused) return;
    if (!config.filters.enableActivityFilter) return;
    if (softBoot) {
      console.log(
        '[monitor] Soft RPC — skipping heavy activity refresh for all wallets ' +
          '(keeps free Helius/Alchemy alive; import grace still watches wallets)'
      );
      return;
    }
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
  })();

  pollTimer = setInterval(() => {
    void pollAllWallets();
  }, config.pollIntervalMs);

  activityTimer = setInterval(() => {
    if (paused || !config.filters.enableActivityFilter) return;
    // Soft / Share Utility: activity refresh burns the same lane as Favourites — skip.
    if (
      isSoftThrottleRpcUrl(getRpcUrl()) ||
      (Boolean(config.rpc?.shareLoad) &&
        getRpcRoleFor('activity', true) === 'utility')
    ) {
      return;
    }
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

  // Autonomous Market Scanner (TA) — hybrid with wallet copy when both ON
  setScannerBuyQueueDepthFn(() => pendingBuyEvents.length);
  onScannerCandidate((candidate) => handleScannerCandidate(candidate));
  startMarketScanner();
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
  stopMarketScanner();
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
  if (Date.now() < pollRateLimitedUntil) return;
  if (pollInFlight) {
    console.log('[monitor] Skipping poll — previous cycle still running');
    return;
  }

  const deferCrit = shouldDeferBackgroundForCritical('utility');
  if (deferCrit.defer) {
    logBackgroundDeferred('Favourites wallet watch', deferCrit.reason || 'Critical busy', {
      pollIntervalMs: config.pollIntervalMs,
    });
    return;
  }

  pollInFlight = true;
  const cycleStarted = Date.now();
  try {
    // Soft-yield if buy queue already deep — don't block the whole cycle on enrich
    if (pendingBuyEvents.length > 8) {
      const startDrain = Date.now();
      const drainPromise = drainBuyEventQueue();
      await Promise.race([
        drainPromise,
        new Promise<void>((r) => setTimeout(r, 1500)),
      ]);
      if (Date.now() - startDrain >= 1500 && pendingBuyEvents.length > 0) {
        console.log(
          `[monitor] Proceeding with poll — buy drain still running ` +
            `(${pendingBuyEvents.length} queued)`
        );
      }
    } else if (pendingBuyEvents.length > 0) {
      void drainBuyEventQueue();
    }

    const wallets = getWalletsForPolling();
    const pollRole = getRpcRoleFor('wallet_poll', Boolean(config.rpc?.shareLoad));
    const rpcUrl = getRpcUrl(pollRole);
    const throttle = getWalletPollThrottle(rpcUrl);
    const { batchSize, batchGapMs, maxWalletsPerCycle, abortCycleOn429, pause429Ms, cycleBudgetMs } =
      throttle;
    if (throttle.soft && Date.now() - lastSoftThrottleLogAt > 120_000) {
      lastSoftThrottleLogAt = Date.now();
      console.log(
        `[monitor] Soft RPC throttle on (${batchSize}/batch, gap ${batchGapMs}ms, ` +
          `≤${maxWalletsPerCycle}/cycle, budget ${cycleBudgetMs}ms) — free Helius/Alchemy/public stay under rate limits`
      );
    }
    const n = wallets.length;
    const offset =
      n > 0 ? ((pollRotationOffset % n) + n) % n : 0;
    const orderedFull =
      n === 0 || offset === 0
        ? wallets
        : wallets.slice(offset).concat(wallets.slice(0, offset));
    const ordered = orderedFull.slice(
      0,
      Math.min(orderedFull.length, maxWalletsPerCycle)
    );
    if (orderedFull.length > ordered.length) {
      console.log(
        `[monitor] Wallet poll capped ${ordered.length}/${orderedFull.length} this cycle ` +
          `(rotate remainder next tick — load protection)`
      );
    }
    let hitRateLimit = false;
    let completed = 0;
    let advanced = 0;
    lastPollAttempted = ordered.length;
    lastPollRateLimited = false;
    for (let i = 0; i < ordered.length; i += batchSize) {
      if (Date.now() < pollRateLimitedUntil) break;
      if (Date.now() - cycleStarted > cycleBudgetMs) {
        console.warn(
          `[monitor] Poll cycle budget ${cycleBudgetMs}ms hit — rotating remaining wallets to next tick`
        );
        break;
      }
      const batch = ordered.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map((wallet) => pollWallet(wallet, throttle))
      );
      advanced += batch.length;
      let batchHad429 = false;
      for (const r of results) {
        if (r.status === 'fulfilled') completed += 1;
        if (r.status === 'rejected' && isRpcRateLimitError(r.reason)) {
          batchHad429 = true;
          hitRateLimit = true;
        }
      }
      if (batchHad429) {
        lastPollRateLimited = true;
        pollRateLimitedUntil = Date.now() + Math.max(pause429Ms, 15_000);
        console.warn(
          `[monitor] RPC 429 on wallet batch — pausing polls ${Math.round(
            (pollRateLimitedUntil - Date.now()) / 1000
          )}s` +
            (abortCycleOn429
              ? ' (aborting rest of cycle to protect free RPC /health)'
              : '')
        );
        await new Promise((r) => setTimeout(r, Math.min(pause429Ms, 2_000)));
        if (abortCycleOn429) break;
      }
      if (i + batchSize < ordered.length) {
        await new Promise((r) => setTimeout(r, batchGapMs));
      }
    }
    lastPollCompleted = completed;
    lastPollCompletedAt = Date.now();
    if (n > 0) {
      // Advance by wallets actually attempted so seeding rotates across cycles
      pollRotationOffset = (offset + Math.max(advanced, 1)) % n;
    }
    if (hitRateLimit) {
      lastPollRateLimited = true;
    }

    // Fire-and-forget drain so enrich/trade does not block the next poll tick
    void drainBuyEventQueue();

    const openMints = paperTrader.getOpenPositions().map((p) => p.mint);
    if (openMints.length > 0) {
      const markBudgetMs = 6_000;
      try {
        await Promise.race([
          (async () => {
            await refreshPositionPrices(openMints);
            await refreshOpenMarketActivity(paperTrader, {
              budgetMs: markBudgetMs,
            });
          })(),
          new Promise<void>((resolve) =>
            setTimeout(() => resolve(), markBudgetMs + 500)
          ),
        ]);
        lastOpenMarkRefreshAt = Date.now();
      } catch (err) {
        console.warn(
          '[monitor] Open-trade mark refresh failed:',
          err instanceof Error ? err.message : err
        );
      }
      paperTrader.checkPositions();
    }

    await evaluateReBuyOpportunities();

    pruneOldBuys();

    const elapsed = Date.now() - cycleStarted;
    lastPollElapsedMs = elapsed;
    if (elapsed > config.pollIntervalMs * 1.5) {
      console.warn(
        `[monitor] Poll cycle slow: ${elapsed}ms for ${ordered.length}/${wallets.length} wallet(s) ` +
          `(interval ${config.pollIntervalMs}ms)` +
          (throttle.soft ? ' — soft throttle active' : ' — consider a paid RPC_URL')
      );
    }
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
  const role = getRpcRoleFor('activity', Boolean(config.rpc?.shareLoad));
  try {
    return await runWithRpcRole(
      role,
      async () => {
    try {
      const pubkey = new PublicKey(address);
      const conn = getConnection();
      const cutoff30d = Math.floor((Date.now() - 30 * MS_PER_DAY) / 1000);

      const signatures = await conn.getSignaturesForAddress(pubkey, {
        limit: 40,
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
  },
      'activity'
    );
  } catch (err) {
    if (isRpcGateSkipError(err)) {
      return { lastTradedAt: null, tradesLast30d: 0, failed: true };
    }
    throw err;
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

  // Prefer GMGN when configured — skip when cooled / circuit open (avoids 403 storms)
  let gmgnWinRate: number | undefined;
  let tradesLast7d: number | undefined;
  const gmgnStatus = getGmgnStatus();
  let gmgnCooled = false;
  try {
    const { isGmgnInCooldown } =
      require('./gmgn') as typeof import('./gmgn');
    gmgnCooled = isGmgnInCooldown();
  } catch {
    gmgnCooled =
      gmgnStatus.rateLimitedUntil != null &&
      gmgnStatus.rateLimitedUntil > Date.now();
  }
  const gmgnUsable =
    config.gmgn.preferGmgnActivity &&
    gmgnStatus.hasApiKey &&
    !gmgnCooled &&
    (gmgnStatus.discovery?.consecutiveFailures ?? 0) < 8;

  if (gmgnUsable) {
    try {
      const gmgn = await getWalletActivity(wallet.address);
      if (gmgn.lastTradeTime != null) {
        lastTradedAt = gmgn.lastTradeTime;
        source = 'gmgn';
      }
      if (gmgn.tradeCount30d != null) {
        tradesLast30d = gmgn.tradeCount30d;
      } else if (gmgn.tradeCount != null) {
        tradesLast30d = gmgn.tradeCount;
      }
      if (gmgn.tradeCount7d != null) {
        tradesLast7d = gmgn.tradeCount7d;
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
      applyQualityToWallet(target);
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

  const defer = shouldDeferBackgroundForCritical('utility');
  if (defer.defer) {
    logBackgroundDeferred('Wallet activity refresh', defer.reason || 'load protection');
    return reports;
  }

  const utilScale = utilityPollScale();
  if (utilScale.skipActivity || isUtilityOnWeakPublic()) {
    console.log(
      '[monitor] Skipping activity refresh — Utility on weak public / adaptive slowdown'
    );
    logBackgroundDeferred(
      'Wallet activity refresh',
      'utility weak public or adaptive× high'
    );
    return reports;
  }

  // Skip a full pass if we just did one recently and nothing looks stale.
  const now = Date.now();
  if (
    lastFullActivityPassAt > 0 &&
    now - lastFullActivityPassAt < ACTIVITY_REFRESH_MS * 0.75
  ) {
    console.log(
      `[monitor] Skipping activity refresh — last full pass ${Math.round(
        (now - lastFullActivityPassAt) / 1000
      )}s ago (no change expected)`
    );
    return reports;
  }

  const n = config.smartWallets.length;
  if (n === 0) return reports;
  const offset = ((activityRotationOffset % n) + n) % n;
  const ordered =
    offset === 0
      ? [...config.smartWallets]
      : config.smartWallets.slice(offset).concat(config.smartWallets.slice(0, offset));

  const toRefresh: typeof config.smartWallets = [];
  let skippedFresh = 0;
  for (const wallet of ordered) {
    if (toRefresh.length >= ACTIVITY_MAX_PER_CYCLE) break;
    const last = activityRefreshAt.get(wallet.address) || 0;
    const age = now - last;
    // Still clearly active within filter window — skip redundant RPC/GMGN.
    const lastTrade = wallet.lastTradedAt ?? wallet.lastActive ?? null;
    const daysSince =
      lastTrade != null ? (now - lastTrade) / MS_PER_DAY : null;
    const clearlyActive =
      daysSince != null &&
      daysSince < Math.max(1, (config.filters.minActivityDays || 14) * 0.5) &&
      (wallet.tradesLast30d ?? 0) >= Math.max(1, config.filters.minTradesLast30d || 1);
    if (age < ACTIVITY_PER_WALLET_MIN_MS && clearlyActive) {
      skippedFresh += 1;
      continue;
    }
    if (age < ACTIVITY_PER_WALLET_MIN_MS * 0.5) {
      skippedFresh += 1;
      continue;
    }
    toRefresh.push(wallet);
  }

  if (toRefresh.length === 0) {
    console.log(
      `[monitor] Activity refresh: nothing due (${skippedFresh} still fresh) — skipping RPC`
    );
    activityRotationOffset = (offset + Math.max(1, ACTIVITY_MAX_PER_CYCLE)) % n;
    return reports;
  }

  console.log(
    `[monitor] Activity refresh: ${toRefresh.length}/${n} wallet(s)` +
      (skippedFresh ? ` (skipped ${skippedFresh} fresh)` : '') +
      ' — staggered'
  );

  try {
    return await runWithRpcRole(
      getRpcRoleFor('activity', Boolean(config.rpc?.shareLoad)),
      async () => {
      for (let i = 0; i < toRefresh.length; i++) {
        const midDefer = shouldDeferBackgroundForCritical('utility');
        if (midDefer.defer) {
          logBackgroundDeferred(
            'Wallet activity refresh',
            midDefer.reason || 'load protection',
            { done: i, remaining: toRefresh.length - i }
          );
          break;
        }
        const wallet = toRefresh[i];
        const report = await refreshWalletActivity(wallet);
        reports.push(report);
        activityRefreshAt.set(wallet.address, Date.now());
        // Stagger on-chain sweeps so Utility is not hit with a dump
        if (i + 1 < toRefresh.length) {
          await new Promise((r) => setTimeout(r, 220));
        }
      }
      activityRotationOffset =
        (offset + Math.max(toRefresh.length, 1)) % n;
      lastFullActivityPassAt = Date.now();
      return reports;
    },
      'activity'
    );
  } catch (err) {
    if (isRpcGateSkipError(err)) {
      logBackgroundDeferred(
        'Wallet activity refresh',
        `lane gate ${err.kind}`,
        { role: err.role }
      );
      return reports;
    }
    throw err;
  }
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
  if (
    !isStrategyEnabled('min_holders_activity') ||
    !config.filters.enableActivityFilter
  ) {
    return {
      kept: config.smartWallets.filter((w) => w.enabled).length,
      disabled: 0,
      removed: 0,
    };
  }

  let wouldDeprioritize = 0;
  let reenabled = 0;

  for (const wallet of config.smartWallets) {
    if (wallet.lastCheckedAt == null) continue;
    if (
      importGraceActive(wallet) &&
      wallet.lastTradedAt == null &&
      wallet.lastActive == null
    ) {
      continue;
    }

    const active = passesActivityRules(wallet);
    const last = wallet.lastTradedAt ?? wallet.lastActive;
    const daysSince =
      last != null ? (Date.now() - last) / MS_PER_DAY : Infinity;
    const trades = wallet.tradesLast30d ?? 0;

    // Soft filter only — do NOT permanently disable wallets (starves signals).
    // Explicit pruneInactive / persistActiveOnly still removes inactive below.
    if (!active && wallet.enabled) {
      wouldDeprioritize += 1;
      if (wouldDeprioritize <= 5) {
        console.log(
          `[monitor] Deprioritize ${wallet.name} (${wallet.address.slice(0, 8)}…) — ` +
            `last trade ${daysSince === Infinity ? 'never' : daysSince.toFixed(0) + 'd ago'}, ` +
            `${trades} txs/30d (still enabled; soft poll filter)`
        );
      }
    } else if (active && !wallet.enabled) {
      wallet.enabled = true;
      reenabled += 1;
      console.log(
        `[monitor] Re-enabled ${wallet.name} (${wallet.address.slice(0, 8)}…) — activity OK`
      );
    }
  }

  let removed = 0;
  let disabled = 0;
  if (options.pruneInactive || options.persistActiveOnly) {
    // Explicit operator prune — disable inactive then optionally remove
    for (const wallet of config.smartWallets) {
      if (wallet.lastCheckedAt == null) continue;
      if (!passesActivityRules(wallet) && wallet.enabled) {
        wallet.enabled = false;
        disabled += 1;
      }
    }
    const before = config.smartWallets.length;
    config.smartWallets = config.smartWallets.filter((w) => w.enabled);
    removed = before - config.smartWallets.length;
    persistWallets({ activeOnly: true });
  } else {
    persistWallets();
  }

  const kept = config.smartWallets.filter((w) => w.enabled).length;
  console.log(
    `[monitor] Activity filter: ${kept} enabled, ${wouldDeprioritize} soft-deprioritized` +
      (disabled ? `, ${disabled} pruned-disabled` : '') +
      (removed ? `, ${removed} removed` : '') +
      (reenabled ? `, ${reenabled} re-enabled` : '')
  );
  return { kept, disabled, removed };
}

/** Wallets that are enabled and pass activity filter (for polling).
 *  Prioritizes wallets with more recent activity. */
export function getWalletsForPolling(): SmartWallet[] {
  const enabled = config.smartWallets.filter((w) => w.enabled);
  let list = enabled;

  if (
    isStrategyEnabled('min_holders_activity') &&
    config.filters.enableActivityFilter
  ) {
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
  const sorted = list.slice().sort((a, b) => {
    // When Influencer Mirror is ON, prefer copy-enabled influencer-family wallets
    try {
      const {
        isInfluencerMirrorEnabled,
        isInfluencerMirrorWallet,
      } = require('./influencerMirror') as typeof import('./influencerMirror');
      if (isInfluencerMirrorEnabled()) {
        const aIm = isInfluencerMirrorWallet(a) ? 1 : 0;
        const bIm = isInfluencerMirrorWallet(b) ? 1 : 0;
        if (bIm !== aIm) return bIm - aIm;
      }
    } catch {
      /* optional */
    }
    const aT = a.lastTradedAt ?? a.lastActive ?? 0;
    const bT = b.lastTradedAt ?? b.lastActive ?? 0;
    return bT - aT;
  });

  // Free Helius/Alchemy/public — rotate a capped watch set across the FULL pool.
  // Small sticky-hot slice (recent/high-value); majority of slots rotate by least-recently-covered
  // so Quiet wallets are not permanently starved. Weak Utility → more conservative.
  // Cap 0 = pause Favourites soft-watch (utility relief).
  const capInfo = resolveSoftWatchCap();
  const softCap = capInfo.effectiveCap;
  const pollRoleForCap = getRpcRoleFor(
    'wallet_poll',
    Boolean(config.rpc?.shareLoad)
  );
  const rpcUrlForCap = getRpcUrl(pollRoleForCap);
  const softUrl = isSoftThrottleRpcUrl(rpcUrlForCap);
  // Cap must survive Utility failover onto paid rpc-url (softUrl becomes false).
  const applySoftCap = shouldSoftThrottleWalletPoll(rpcUrlForCap);
  let weakUtil = false;
  try {
    weakUtil = isUtilityOnWeakPublic();
  } catch {
    weakUtil = false;
  }

  // When Influencer Mirror master is ON, never starve tagged copy wallets —
  // soft-watch cap=0 or rotation previously dropped them → silent no-trades.
  let influencerPinned: SmartWallet[] = [];
  try {
    const {
      isInfluencerMirrorEnabled,
      isInfluencerMirrorWallet,
    } = require('./influencerMirror') as typeof import('./influencerMirror');
    if (isInfluencerMirrorEnabled()) {
      influencerPinned = sorted.filter((w) => isInfluencerMirrorWallet(w));
    }
  } catch {
    influencerPinned = [];
  }

  if (softCap === 0) {
    lastSoftWatchStickyN = 0;
    lastSoftWatchRotateN = 0;
    if (influencerPinned.length > 0) {
      const nowPin = Date.now();
      for (const w of influencerPinned) {
        softWatchLastCoveredAt.set(w.address, nowPin);
      }
      return influencerPinned;
    }
    return [];
  }

  if (
    applySoftCap &&
    Number.isFinite(softCap) &&
    softCap > 0 &&
    sorted.length > softCap
  ) {
    // Sticky fraction: ~35% normal, ~25% on weak public utility (more rotation + lower pressure).
    const stickyFrac = weakUtil ? 0.25 : 0.35;
    const stickyN = Math.max(1, Math.floor(softCap * stickyFrac));
    const rotateN = Math.max(0, softCap - stickyN);
    // Pin influencers first (up to ~40% of cap), then hot sticky, then rotate.
    const pinN = Math.min(
      influencerPinned.length,
      Math.max(1, Math.floor(softCap * 0.4))
    );
    const pinned = influencerPinned.slice(0, pinN);
    const pinSet = new Set(pinned.map((w) => w.address));
    const hot = sorted
      .filter((w) => !pinSet.has(w.address))
      .slice(0, Math.max(0, stickyN));
    const hotSet = new Set([...pinSet, ...hot.map((w) => w.address)]);
    // Fair coverage: least-recently covered first, then lower activity (spread the pool).
    const cold = sorted
      .filter((w) => !hotSet.has(w.address))
      .slice()
      .sort((a, b) => {
        const aSeen = softWatchLastCoveredAt.get(a.address) ?? 0;
        const bSeen = softWatchLastCoveredAt.get(b.address) ?? 0;
        if (aSeen !== bSeen) return aSeen - bSeen;
        const aQ = a.qualityScore ?? 0;
        const bQ = b.qualityScore ?? 0;
        if (bQ !== aQ) return bQ - aQ;
        const aT = a.lastTradedAt ?? a.lastActive ?? 0;
        const bT = b.lastTradedAt ?? b.lastActive ?? 0;
        return aT - bT;
      });
    const slotsLeft = Math.max(0, softCap - pinned.length - hot.length);
    const rotateTake = Math.min(rotateN, slotsLeft, cold.length);
    const rotated: typeof sorted = [];
    if (cold.length > 0 && rotateTake > 0) {
      const start =
        ((softWatchRotateOffset % cold.length) + cold.length) % cold.length;
      for (let i = 0; i < rotateTake; i++) {
        rotated.push(cold[(start + i) % cold.length]!);
      }
      softWatchRotateOffset = (start + Math.max(rotateTake, 1)) % cold.length;
    }
    const capped = pinned.concat(hot, rotated).slice(0, softCap);
    const now = Date.now();
    for (const w of capped) {
      softWatchLastCoveredAt.set(w.address, now);
    }
    lastSoftWatchStickyN = pinned.length + hot.length;
    lastSoftWatchRotateN = rotated.length;

    const since = now - 30 * 60_000;
    let covered30 = 0;
    for (const w of sorted) {
      const t = softWatchLastCoveredAt.get(w.address);
      if (t != null && t >= since) covered30 += 1;
    }
    const coveragePct =
      sorted.length > 0
        ? Math.round((covered30 / sorted.length) * 1000) / 10
        : 0;
    lastSoftWatchCoveragePct = coveragePct;

    if (now - softWatchCoverageLogAt > 60_000) {
      softWatchCoverageLogAt = now;
      console.log(
        `[monitor] Soft-watch rotation: cap ${softCap} · pinIM ${pinned.length} · sticky ${hot.length} · rotate ${rotated.length} · ` +
          `pool ${sorted.length} · coverage30m ${coveragePct}%` +
          (weakUtil ? ' · weak Utility (conservative)' : '')
      );
    }
    return capped;
  }
  return sorted;
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
  if (
    !isStrategyEnabled('min_holders_activity') ||
    !config.filters.enableActivityFilter
  ) {
    return true;
  }
  return passesActivityRules(wallet);
}

/**
 * Queue a detected buy for async filter/trade handling so the wallet poll
 * loop can keep scanning signatures without waiting on GMGN/Dex/Jupiter.
 */
function enqueueBuyEvent(buy: WalletBuyEvent): void {
  if (pendingBuyEvents.length >= MAX_PENDING_BUY_EVENTS) {
    console.warn(
      `[monitor] Buy queue full (${MAX_PENDING_BUY_EVENTS}) — dropping oldest`
    );
    pendingBuyEvents.shift();
  }
  pendingBuyEvents.push(buy);
}

async function drainBuyEventQueue(): Promise<void> {
  if (buyDrainInFlight) return;
  buyDrainInFlight = true;
  const CONCURRENCY = 3;
  try {
    while (pendingBuyEvents.length > 0 && !paused) {
      const batch: WalletBuyEvent[] = [];
      while (batch.length < CONCURRENCY && pendingBuyEvents.length > 0) {
        const buy = pendingBuyEvents.shift();
        if (buy) batch.push(buy);
      }
      if (!batch.length) break;
      await Promise.all(
        batch.map(async (buy) => {
          try {
            await handleBuyEvent(buy);
          } catch (err) {
            console.error(
              `[monitor] Buy handler error for ${buy.walletName}/${buy.mint.slice(0, 8)}…:`,
              err instanceof Error ? err.message : err
            );
          }
        })
      );
    }
  } finally {
    buyDrainInFlight = false;
  }
}

async function fetchParsedTx(
  signature: string
): Promise<ParsedTransactionWithMeta | null> {
  const conn = getConnection();
  try {
    const tx = await conn.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });
    if (tx) return tx;
  } catch (err) {
    console.warn(
      `[monitor] getParsedTransaction failed ${signature.slice(0, 8)}…:`,
      err instanceof Error ? err.message : err
    );
  }
  // Brief retry — public RPCs often return null under load
  await new Promise((r) => setTimeout(r, 250));
  try {
    return await getConnection().getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });
  } catch {
    return null;
  }
}

async function pollWallet(
  wallet: SmartWallet,
  throttle?: ReturnType<typeof getWalletPollThrottle>
): Promise<void> {
  const role = getRpcRoleFor('wallet_poll', Boolean(config.rpc?.shareLoad));
  const key = `${role}:wallet_poll:${wallet.address}`;
  try {
    await runDedupedRpcJob(key, () =>
      runWithRpcRole(role, () => pollWalletInner(wallet, throttle), 'wallet_poll'),
      { join: false }
    );
  } catch (err) {
    if (isRpcGateSkipError(err)) {
      logBackgroundDeferred(
        'Favourites wallet poll',
        `lane gate ${err.kind}`,
        { wallet: wallet.name, role: err.role }
      );
      return;
    }
    throw err;
  }
}

async function pollWalletInner(
  wallet: SmartWallet,
  throttle?: ReturnType<typeof getWalletPollThrottle>
): Promise<void> {
  try {
    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(wallet.address);
    } catch {
      console.warn(`[monitor] Skipping invalid address for ${wallet.name}`);
      return;
    }

    const conn = getConnection();
    const t = throttle ?? getWalletPollThrottle(getRpcUrl());
    const sigLimit = t.sigLimit;
    const signatures = await conn.getSignaturesForAddress(pubkey, {
      limit: sigLimit,
    });

    if (signatures.length === 0) {
      walletLastActivity.set(wallet.address, {
        timestamp: Date.now(),
        type: 'poll',
      });
      return;
    }

    const lastSeen = lastSignature.get(wallet.address);

    // First sight: seed cursor ONLY — never replay historical txs into the feed.
    // Replaying on restart was flooding Recent Signals with 9–14h-old buys and
    // advancing the cursor past live activity when parses failed.
    if (lastSeen == null) {
      lastSignature.set(wallet.address, signatures[0].signature);
      walletLastActivity.set(wallet.address, {
        timestamp: Date.now(),
        signature: signatures[0].signature,
        type: 'poll',
      });
      console.log(
        `[monitor] Seeded sig cursor for ${wallet.name} ` +
          `(${wallet.address.slice(0, 8)}…) — watching for new buys only`
      );
      return;
    }

    const newSigs: string[] = [];
    for (const sig of signatures) {
      if (sig.signature === lastSeen) break;
      newSigs.push(sig.signature);
    }

    if (newSigs.length === 0) return;

    // Oldest → newest so we can advance the cursor safely through successes
    const chronological = newSigs.reverse();
    const maxParse = t.maxParse;
    const toParse = chronological.slice(0, maxParse);

    let lastFullyProcessed: string | null = null;
    let stoppedEarly = false;

    for (const sig of toParse) {
      const tx = await fetchParsedTx(sig);
      if (!tx) {
        // Do NOT advance past a failed parse — retry next cycle
        stoppedEarly = true;
        console.warn(
          `[monitor] Parse miss for ${wallet.name} sig ${sig.slice(0, 8)}… — ` +
            `holding cursor (will retry)`
        );
        break;
      }

      const buys = parseBuysFromTransaction(tx, wallet, sig);
      for (const buy of buys) {
        buy.detectedAt = Date.now();
        walletLastActivity.set(wallet.address, {
          timestamp: buy.timestamp,
          signature: buy.signature,
          symbol: buy.symbol,
          name: buy.name,
          type: 'buy',
        });
        enqueueBuyEvent(buy);
      }
      try {
        const {
          isInfluencerMirrorEnabled,
          isInfluencerMirrorWallet,
        } = require('./influencerMirror') as typeof import('./influencerMirror');
        if (isInfluencerMirrorEnabled() && isInfluencerMirrorWallet(wallet)) {
          const sells = parseSellsFromTransaction(tx, wallet, sig);
          for (const sell of sells) {
            sell.detectedAt = Date.now();
            walletLastActivity.set(wallet.address, {
              timestamp: sell.timestamp,
              signature: sell.signature,
              symbol: sell.symbol,
              name: sell.name,
              type: 'buy', // activity stamp; sell handled below
            });
            void (async () => {
              try {
                const { tryInfluencerMirrorSell } =
                  require('./influencerMirrorRuntime') as typeof import('./influencerMirrorRuntime');
                await tryInfluencerMirrorSell({
                  wallet,
                  mint: sell.mint,
                  symbol: sell.symbol,
                  name: sell.name,
                  signature: sell.signature,
                  timestamp: sell.timestamp,
                });
              } catch (err) {
                console.warn(
                  `[monitor] Influencer sell handler error:`,
                  err instanceof Error ? err.message : err
                );
              }
            })();
          }
        }
      } catch {
        /* influencer mirror optional */
      }
      lastFullyProcessed = sig;
    }

    if (lastFullyProcessed) {
      if (!stoppedEarly && toParse.length >= chronological.length) {
        // Caught up with this fetch's tip
        lastSignature.set(wallet.address, signatures[0].signature);
      } else {
        // Partial progress (cap or parse miss) — resume from last success
        lastSignature.set(wallet.address, lastFullyProcessed);
      }
    }
    // If every parse failed, leave lastSeen unchanged so we retry the same tip
  } catch (err) {
    if (isRpcRateLimitError(err)) throw err;
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
    // Skip SOL + known stables/quotes (USDC balance bumps look like meme buys)
    if (isDeniedCopyMint(mint, config.solMint)) continue;

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

function parseSellsFromTransaction(
  tx: ParsedTransactionWithMeta,
  wallet: SmartWallet,
  signature: string
): WalletSellEvent[] {
  const events: WalletSellEvent[] = [];
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

  // Decreases on known mints
  for (const pre of preBalances) {
    if (pre.owner !== wallet.address) continue;
    const mint = pre.mint;
    if (isDeniedCopyMint(mint, config.solMint)) continue;

    const post = postBalances.find(
      (p) => p.mint === mint && p.owner === wallet.address
    );
    const preAmount = pre.uiTokenAmount.uiAmount ?? 0;
    const postAmount = post?.uiTokenAmount.uiAmount ?? 0;
    if (postAmount >= preAmount) continue;
    if (preAmount <= 0) continue;

    const prefix = mintPrefix(mint);
    events.push({
      wallet: wallet.address,
      walletName: wallet.name,
      mint,
      symbol: prefix,
      name: prefix,
      signature,
      timestamp: blockTime,
      isPumpFun,
      isMigration,
    });
  }

  // Also catch full exits where post balance row is missing
  for (const pre of preBalances) {
    if (pre.owner !== wallet.address) continue;
    const mint = pre.mint;
    if (isDeniedCopyMint(mint, config.solMint)) continue;
    if (events.some((e) => e.mint === mint)) continue;
    const post = postBalances.find(
      (p) => p.mint === mint && p.owner === wallet.address
    );
    if (post) continue;
    const preAmount = pre.uiTokenAmount.uiAmount ?? 0;
    if (preAmount <= 0) continue;
    const prefix = mintPrefix(mint);
    events.push({
      wallet: wallet.address,
      walletName: wallet.name,
      mint,
      symbol: prefix,
      name: prefix,
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
async function handleScannerCandidate(
  candidate: ScannerCandidate & { launch: import('./marketData').LaunchEvent }
): Promise<void> {
  if (paused) return;
  // Global toggle only — profile gate must not false-OFF the whole scanner path
  // when a lane without ta_market_scanner is mid-cascade.
  if (!isStrategyEnabledGlobal('ta_market_scanner')) {
    annotateScannerCandidate(candidate.mint, {
      status: 'skipped',
      skipReason: 'Market Scanner OFF',
    });
    return;
  }
  if (isDeniedCopyMint(candidate.mint, config.solMint)) {
    annotateScannerCandidate(candidate.mint, {
      status: 'skipped',
      skipReason: 'denied mint',
    });
    markScannerCooldown(candidate.mint, false);
    return;
  }
  const pumpFunGate = evaluateBuyPumpFunOnlyGate(candidate.mint, {
    specialtyFeed: candidate.specialtyFeed || candidate.launch?.specialtyFeed,
    preferredProfileId:
      candidate.preferredProfileId ||
      candidate.launch?.preferredProfileId ||
      null,
  });
  if (pumpFunGate) {
    annotateScannerCandidate(candidate.mint, {
      status: 'skipped',
      skipReason: pumpFunGate,
    });
    markScannerCooldown(candidate.mint, false);
    return;
  }
  if (
    !isPumpFunMintSuffix(candidate.mint) &&
    (candidate.specialtyFeed === 'jupiter' ||
      candidate.specialtyFeed === 'kolscan') &&
    (candidate.preferredProfileId === 'trend_rider' ||
      candidate.preferredProfileId === 'steady_compounder' ||
      candidate.launch?.preferredProfileId === 'trend_rider' ||
      candidate.launch?.preferredProfileId === 'steady_compounder')
  ) {
    console.log(
      `[monitor] Specialty pump.fun-only bypass · ${candidate.symbol || candidate.mint.slice(0, 8)} ` +
        `(${candidate.preferredProfileId || candidate.launch?.preferredProfileId}/${candidate.specialtyFeed})`
    );
  }

  // Overview feed early (mirror copy path) — before beginBuy / risk_off / requireTa
  const feedSig = candidate.id;
  const earlyTs = Date.now();
  let launch = candidate.launch;
  const earlyFeed: WalletBuyEvent = {
    wallet: MARKET_SCANNER_WALLET,
    walletName: MARKET_SCANNER_NAME,
    mint: candidate.mint,
    symbol: candidate.symbol,
    name: candidate.name,
    signature: feedSig,
    timestamp: earlyTs,
    detectedAt: earlyTs,
    isPumpFun: Boolean(launch.isPumpFun),
    isMigration: Boolean(candidate.migrated || launch.migrated),
    tradeStatus: 'seen',
    entrySource: 'scanner',
  };
  if (!recentBuys.has(candidate.mint)) recentBuys.set(candidate.mint, []);
  const alreadyFed = activityFeed.some(
    (e) => e.mint === candidate.mint && e.signature === feedSig
  );
  if (!alreadyFed) {
    recentBuys.get(candidate.mint)!.push(earlyFeed);
    pushActivityFeed(earlyFeed);
  }

  if (tradedMints.has(candidate.mint)) {
    annotateScannerCandidate(candidate.mint, {
      status: 'skipped',
      skipReason: 'already traded',
    });
    annotateActivityFeed(candidate.mint, feedSig, {
      tradeStatus: 'skipped',
      skipReason: 'already traded',
    });
    markScannerCooldown(candidate.mint, false);
    return;
  }
  if (pendingBuys.has(candidate.mint)) {
    annotateScannerCandidate(candidate.mint, {
      status: 'skipped',
      skipReason: 'buy in progress',
    });
    annotateActivityFeed(candidate.mint, feedSig, {
      tradeStatus: 'skipped',
      skipReason: 'buy in progress',
    });
    // Transient lock — do NOT apply the 45m scanner cooldown or the mint
    // disappears from Market Scanner for the whole cooldown window.
    markScannerCooldown(candidate.mint, false, { ms: 15_000 });
    return;
  }
  if (!beginBuy(candidate.mint)) {
    annotateScannerCandidate(candidate.mint, {
      status: 'skipped',
      skipReason: 'buy in progress',
    });
    annotateActivityFeed(candidate.mint, feedSig, {
      tradeStatus: 'skipped',
      skipReason: 'buy in progress',
    });
    markScannerCooldown(candidate.mint, false, { ms: 15_000 });
    return;
  }

  try {
    if (launch.candles?.length) {
      seedPriceHistoryFromCandles(candidate.mint, launch.candles);
    }

    // Hybrid boost — tracked wallets also active on this mint recently
    const cluster = recentBuys.get(candidate.mint) ?? [];
    const realWallets = cluster
      .filter((b) => !isMarketScannerAddress(b.wallet) && b.wallet !== 'volume-spike')
      .map((b) => ({ addr: b.wallet, name: b.walletName }));
    const uniqueWallets: { addr: string; name: string }[] = [];
    const seen = new Set<string>();
    for (const w of realWallets) {
      if (seen.has(w.addr)) continue;
      seen.add(w.addr);
      uniqueWallets.push(w);
    }
    const hybrid = uniqueWallets.length > 0;
    if (hybrid) {
      annotateActivityFeed(candidate.mint, feedSig, {
        walletName: `${MARKET_SCANNER_NAME}+wallets`,
        entrySource: 'hybrid',
      });
    }

    // Regime: pause scanner-only in risk_off (hybrid still OK)
    try {
      const { shouldAllowScannerOnly, getMarketRegime } = await import(
        './marketRegime'
      );
      await getMarketRegime({
        tokenChangeH1Pct: launch.priceChangeH1Pct ?? launch.priceChangePct,
      });
      if (!hybrid && !shouldAllowScannerOnly()) {
        finishBuy(candidate.mint, false);
        annotateScannerCandidate(candidate.mint, {
          status: 'skipped',
          skipReason: 'risk_off pause scanner-only',
        });
        annotateActivityFeed(candidate.mint, feedSig, {
          tradeStatus: 'skipped',
          skipReason: 'risk_off pause scanner-only',
        });
        markScannerCooldown(candidate.mint, false);
        return;
      }
    } catch {
      /* fail-open */
    }

    const minConfluence =
      config.marketScanner?.minConfluenceScore ?? 40;
    const requireTa =
      config.riskLevel === 'off'
        ? false
        : config.marketScanner?.requireTaSetup !== false;
    // Setup-watch handoffs are synthetic (no TA playbook) — lane floors still apply.
    const preferId =
      candidate.preferredProfileId ||
      (candidate as { launch?: { preferredProfileId?: string } }).launch
        ?.preferredProfileId ||
      '';
    const reasonBits = Array.isArray(candidate.reasons)
      ? candidate.reasons.join(' ')
      : '';
    const setupWatchHandoff =
      preferId === 'migration_sniper' ||
      preferId === 'dip_buyer' ||
      preferId === 'scalper' ||
      preferId === 'momentum_burst' ||
      preferId === 'reversal_scalper' ||
      reasonBits.includes('grad-watch:triggered') ||
      reasonBits.includes('dip-watch:triggered') ||
      reasonBits.includes('scalper-watch:triggered');
    // Mode B: mid-band Scalper immediate only when already at multi-TF support confluence.
    const nearMultiTfSupport =
      (candidate as { nearMultiTfSupport?: boolean }).nearMultiTfSupport ===
        true || reasonBits.includes('scalper-mtf-support');
    const scalperMcEligible =
      nearMultiTfSupport &&
      (preferId === 'scalper' ||
        reasonBits.includes('scalper-mc-eligible') ||
        reasonBits.includes('scalper-mtf-support') ||
        (candidate.marketCapUsd != null &&
          candidate.marketCapUsd >= 150_000 &&
          candidate.marketCapUsd <= 800_000));
    // Playbook / confluence only hard-gate when Require TA setup is ON
    // (Risk Off always skips these so scanner-only can still open).
    if (!hybrid && requireTa && !setupWatchHandoff && !scalperMcEligible) {
      if (!candidate.playbook) {
        finishBuy(candidate.mint, false);
        annotateScannerCandidate(candidate.mint, {
          status: 'skipped',
          skipReason: 'no playbook',
        });
        annotateActivityFeed(candidate.mint, feedSig, {
          tradeStatus: 'skipped',
          skipReason: 'no playbook',
        });
        markScannerCooldown(candidate.mint, false);
        return;
      }
      if (
        candidate.confluence == null ||
        candidate.confluence < minConfluence
      ) {
        finishBuy(candidate.mint, false);
        const reason = `confluence ${candidate.confluence ?? 0}<${minConfluence}`;
        annotateScannerCandidate(candidate.mint, {
          status: 'skipped',
          skipReason: reason,
        });
        annotateActivityFeed(candidate.mint, feedSig, {
          tradeStatus: 'skipped',
          skipReason: reason,
        });
        markScannerCooldown(candidate.mint, false);
        return;
      }
    }

    const wallets = hybrid
      ? [MARKET_SCANNER_WALLET, ...uniqueWallets.map((w) => w.addr)]
      : [MARKET_SCANNER_WALLET];
    const walletNames = hybrid
      ? [MARKET_SCANNER_NAME, ...uniqueWallets.map((w) => w.name)]
      : [MARKET_SCANNER_NAME];

    // Best-effort metrics enrich (Dex pair fields + Birdeye holders)
    let volumeH1Usd =
      launch.volumeH1Usd ??
      (candidate.volumeUsd != null
        ? candidate.volumeUsd / 18
        : launch.volumeUsd != null
          ? launch.volumeUsd / 18
          : null);
    let volumeM5Usd = launch.volumeM5Usd ?? null;
    let priceChangeH1Pct = launch.priceChangeH1Pct ?? null;
    let holderCountEstimate = launch.holderCount ?? null;
    try {
      const snap = await Promise.race([
        import('./marketData').then((m) =>
          m.fetchLiveTokenSnapshot(candidate.mint)
        ),
        new Promise<null>((r) => setTimeout(() => r(null), 2500)),
      ]);
      if (snap) {
        if (snap.volumeH1Usd != null) volumeH1Usd = snap.volumeH1Usd;
      }
    } catch {
      /* ignore */
    }
    try {
      const { hasBirdeyeKey, getTokenOverview } = await import('./birdeye');
      if (hasBirdeyeKey()) {
        const ov = await Promise.race([
          getTokenOverview(candidate.mint),
          new Promise<null>((r) => setTimeout(() => r(null), 2500)),
        ]);
        if (ov && ov.holder != null && ov.holder > 0) {
          holderCountEstimate = ov.holder;
        }
      }
    } catch {
      /* ignore */
    }

    const signal: TradeSignal = {
      mint: candidate.mint,
      symbol: candidate.symbol,
      name: candidate.name,
      wallets,
      walletNames,
      isMigration: Boolean(candidate.migrated || launch.migrated),
      nearMigration: Boolean(
        candidate.nearMigration ||
          (candidate.curveProgressPct != null &&
            candidate.curveProgressPct >= 80)
      ),
      timestamp: Date.now(),
      entrySource: hybrid ? 'hybrid' : 'scanner',
      nearKeyFib: candidate.nearKeyFib,
      nearSupport: candidate.nearSupport,
      nearResistance: candidate.nearResistance,
      nearMultiTfSupport: candidate.nearMultiTfSupport,
      nearMultiTfResistance: candidate.nearMultiTfResistance,
      srConfluenceScore: candidate.srConfluenceScore,
      supportTfHits: candidate.supportTfHits,
      resistanceTfHits: candidate.resistanceTfHits,
      supportPriceSol: candidate.supportPriceSol ?? null,
      resistancePriceSol: candidate.resistancePriceSol ?? null,
      fib05PriceSol: candidate.fib05PriceSol ?? null,
      fib618PriceSol: candidate.fib618PriceSol ?? null,
      lastPriceSol:
        candidate.lastPriceSol ?? launch.lastPriceSol ?? null,
      chartPatternIds: candidate.chartPatternIds,
      candles: launch.candles,
      priceSol:
        candidate.lastPriceSol ||
        launch.lastPriceSol ||
        launch.entryPriceSol,
      sourceEntryMcUsd: candidate.marketCapUsd ?? launch.marketCapUsd,
      scannerPlaybook: candidate.playbook,
      scannerConfluence: candidate.confluence,
      candleSource: candidate.candleSource ?? launch.candleSource,
      candidateTradeProfileId:
        candidate.preferredProfileId ||
        launch.preferredProfileId ||
        undefined,
      specialtyFeed:
        candidate.specialtyFeed || launch.specialtyFeed || null,
      scannerReasons: Array.isArray(candidate.reasons)
        ? candidate.reasons.map(String)
        : undefined,
      armedWatch:
        candidate.armedWatch === true ||
        (Array.isArray(candidate.reasons) &&
          candidate.reasons.some((r) =>
            /scalper-watch:triggered|dip-watch:triggered|grad-watch:triggered|armedWatch/i.test(
              String(r)
            )
          )) ||
        undefined,
      setupWatchFamily:
        candidate.setupWatchFamily ||
        (candidate.dipWatchTriggered === true
          ? 'dip'
          : Array.isArray(candidate.reasons)
            ? candidate.reasons.some((r) => /scalper-watch/i.test(String(r)))
              ? 'scalper'
              : candidate.reasons.some((r) => /grad-watch/i.test(String(r)))
                ? 'grad'
                : candidate.reasons.some((r) => /dip-watch/i.test(String(r)))
                  ? 'dip'
                  : undefined
            : undefined),
      dipWatchTriggered:
        candidate.dipWatchTriggered === true ||
        (Array.isArray(candidate.reasons) &&
          candidate.reasons.some((r) => /dip-watch:triggered/i.test(String(r))))
          ? true
          : undefined,
      entryStyleHint: candidate.entryStyleHint,
      qualityScoreHint: candidate.qualityScoreHint,
      sizePlanSol:
        candidate.sizePlanSol != null && Number.isFinite(candidate.sizePlanSol)
          ? Number(candidate.sizePlanSol)
          : undefined,
      kolCount:
        candidate.kolCount != null && Number.isFinite(candidate.kolCount)
          ? candidate.kolCount
          : undefined,
      organicScore:
        candidate.organicScore != null &&
        Number.isFinite(candidate.organicScore)
          ? candidate.organicScore
          : launch.organicScore != null && Number.isFinite(launch.organicScore)
            ? launch.organicScore
            : null,
      bondingCurve:
        candidate.curveProgressPct != null &&
        Number.isFinite(candidate.curveProgressPct)
          ? {
              progressPct: Number(candidate.curveProgressPct),
              solRaised: 0,
              tokensInPool: 0,
              solToMigration: 0,
              nearMigration: Number(candidate.curveProgressPct) >= 80,
              proximity: 'near' as const,
              complete: Boolean(candidate.migrated || launch.migrated),
            }
          : undefined,
      metrics: {
        liquidityUsd: candidate.liquidityUsd ?? launch.liquidityUsd ?? null,
        marketCapUsd: candidate.marketCapUsd ?? launch.marketCapUsd ?? null,
        volume24hUsd: candidate.volumeUsd ?? launch.volumeUsd ?? null,
        volumeH1Usd,
        volumeM5Usd,
        recentBuyVolumeUsd: null,
        txnsH1: null,
        buysH1: null,
        sellsH1: null,
        buySellRatio: null,
        priceUsd: null,
        priceChangeH1Pct,
        priceChange24hPct: launch.priceChangePct ?? null,
        holderCountEstimate,
        topHolderPct: null,
        top10HoldPct: null,
        devHoldPct: null,
        devActiveRecently: false,
        mintAuthority: null,
        source: launch.source,
      } as NonNullable<TradeSignal['metrics']>,
    };

    // Prefer Jupiter Terminal Top-10 when already cached from scanner universe
    try {
      const { lookupCachedJupiterToken, jupiterTopHoldersPercentage } =
        await import('./jupiterTokens');
      const jupTop = jupiterTopHoldersPercentage(
        lookupCachedJupiterToken(candidate.mint)
      );
      if (jupTop != null && signal.metrics) {
        signal.metrics.top10HoldPct = jupTop;
      }
    } catch {
      /* ignore */
    }

    // Upgrade early Overview row (do NOT pushActivityFeed again — would double-count)
    const feedEvent: WalletBuyEvent = {
      wallet: MARKET_SCANNER_WALLET,
      walletName: hybrid ? `${MARKET_SCANNER_NAME}+wallets` : MARKET_SCANNER_NAME,
      mint: candidate.mint,
      symbol: candidate.symbol,
      name: candidate.name,
      signature: feedSig,
      timestamp: signal.timestamp,
      detectedAt: earlyTs,
      isPumpFun: Boolean(launch.isPumpFun),
      isMigration: signal.isMigration,
      tradeStatus: 'seen',
      metrics: signal.metrics,
      entrySource: hybrid ? 'hybrid' : 'scanner',
    };
    annotateActivityFeed(candidate.mint, feedSig, {
      walletName: feedEvent.walletName,
      metrics: signal.metrics,
      entrySource: feedEvent.entrySource,
      isMigration: signal.isMigration,
      symbol: candidate.symbol,
      name: candidate.name,
    });

    console.log(
      `[monitor] 📡 SCANNER ${hybrid ? 'HYBRID' : 'TA'} — ${candidate.symbol} ` +
        `score=${candidate.rankScore} pb=${candidate.playbook ?? '—'} ` +
        `conf=${candidate.confluence ?? '—'} [${candidate.reasons.slice(0, 4).join(', ')}]`
    );

    if (!(await passesFilters(signal))) {
      finishBuy(candidate.mint, false);
      annotateScannerCandidate(candidate.mint, {
        status: 'skipped',
        skipReason: lastFilterSkipReason || 'filters',
      });
      markScannerCooldown(candidate.mint, false);
      return;
    }

    try {
      signal.sourceEntryMcUsd =
        signal.sourceEntryMcUsd ??
        (await resolveSourceEntryMcUsd(candidate.mint));
    } catch {
      /* non-fatal */
    }

    onSignalHandler?.(signal);

    const sizing = resolveTradeSize('normal', {
      riskScore: signal.antiRug?.riskScore,
      convictionScore: signal.convictionScore,
      sizeMultiplier:
        (signal.sizeMultiplier ?? 1) * (hybrid ? 1.15 : 0.9),
    });
    recordSignalSizing(signal, sizing, true);

    const buyEvent: WalletBuyEvent = {
      ...feedEvent,
      tradeStatus: 'seen',
    };
    await executeSignalBuy(signal, buyEvent, sizing, {
      priority: hybrid || signal.isMigration,
      strategyKind: signal.isMigration ? 'migration' : 'normal',
    });
  } catch (err) {
    finishBuy(candidate.mint, false);
    annotateScannerCandidate(candidate.mint, {
      status: 'skipped',
      skipReason: err instanceof Error ? err.message : 'scanner error',
    });
    annotateActivityFeed(candidate.mint, feedSig, {
      tradeStatus: 'skipped',
      skipReason: err instanceof Error ? err.message : 'scanner error',
    });
    markScannerCooldown(candidate.mint, false);
    throw err;
  }
}

type MarlRlSoftSizingInput = {
  profileId: string;
  profileName?: string;
  mint: string;
  symbol?: string;
  marketCapUsd: number | null;
  solAmount: number;
  sizeReason: string;
  clampTag: string;
  logThoughts?: boolean;
};

type MarlRlSoftSizingResult =
  | { ok: true; solAmount: number; sizeReason: string }
  | { ok: false; skipReason: string };

/** Soft MARL low-MC + MARL/Profile RL size multipliers (fail-open). */
function applyMarlRlSoftSizing(
  input: MarlRlSoftSizingInput
): MarlRlSoftSizingResult {
  try {
    const {
      evaluateMarlLowMcCoordination,
      marlSizeMultiplier,
    } = require('./marlCoordinator') as typeof import('./marlCoordinator');
    const { profileRlSizeMultiplier } =
      require('./profileRlAgent') as typeof import('./profileRlAgent');
    const low = evaluateMarlLowMcCoordination({
      mint: input.mint,
      symbol: input.symbol,
      profileId: String(input.profileId || 'default'),
      marketCapUsd: input.marketCapUsd,
    });
    if (low.action === 'skip') {
      if (input.logThoughts) {
        appendMarlThoughtToLaneFight(input.mint, low.reason);
      }
      return { ok: false, skipReason: low.reason };
    }
    if (input.logThoughts) {
      if (low.reason && low.action !== 'allow') {
        appendMarlThoughtToLaneFight(input.mint, low.reason);
      } else if (low.action === 'allow' && low.reason.includes('low-MC slot')) {
        appendMarlThoughtToLaneFight(input.mint, low.reason);
      }
    }
    let solAmt = input.solAmount;
    let sizeExtra = '';
    const marlSz = marlSizeMultiplier(input.profileId);
    if (marlSz.mult !== 1) {
      solAmt *= marlSz.mult;
      sizeExtra += ` · ${marlSz.note}`;
      if (input.logThoughts) {
        appendMarlThoughtToLaneFight(
          input.mint,
          `Size confidence ×${marlSz.mult.toFixed(2)} for ${input.profileName || input.profileId}`
        );
      }
    }
    const rlSz = profileRlSizeMultiplier(input.profileId);
    if (rlSz.mult !== 1) {
      solAmt *= rlSz.mult;
      sizeExtra += ` · ${rlSz.note}`;
      if (input.logThoughts) {
        appendMarlThoughtToLaneFight(
          input.mint,
          `Profile RL size ×${rlSz.mult.toFixed(2)} for ${input.profileName || input.profileId}`
        );
      }
    }
    if (low.action === 'size_down' && low.sizeMult < 1) {
      solAmt *= low.sizeMult;
      sizeExtra += ` · ${low.reason}`;
      if (input.logThoughts) {
        appendMarlThoughtToLaneFight(input.mint, low.reason);
      }
    }
    try {
      const { applyRecoverySizeMultiplier, isFastProfileRecovering } =
        require('./fastProfileRecovery') as typeof import('./fastProfileRecovery');
      if (isFastProfileRecovering(input.profileId)) {
        const before = solAmt;
        solAmt = applyRecoverySizeMultiplier(input.profileId, solAmt);
        if (solAmt !== before) {
          sizeExtra += ` · recovery size×${(solAmt / Math.max(before, 1e-9)).toFixed(2)}`;
          if (input.logThoughts) {
            appendMarlThoughtToLaneFight(
              input.mint,
              `Fast Recovery size adjust for ${input.profileName || input.profileId}`
            );
          }
        }
      }
    } catch {
      /* optional */
    }
    try {
      const {
        applyDipBuyerRecoverySizeMultiplier,
        isDipBuyerRecovering,
      } = require('./dipBuyerRecovery') as typeof import('./dipBuyerRecovery');
      if (isDipBuyerRecovering(input.profileId)) {
        const before = solAmt;
        solAmt = applyDipBuyerRecoverySizeMultiplier(input.profileId, solAmt);
        if (solAmt !== before) {
          sizeExtra += ` · DBR size×${(solAmt / Math.max(before, 1e-9)).toFixed(2)}`;
          if (input.logThoughts) {
            appendMarlThoughtToLaneFight(
              input.mint,
              `Dip Buyer Recovery size adjust`
            );
          }
        }
      }
    } catch {
      /* optional */
    }
    return {
      ok: true,
      solAmount: clampToMaxAllowedTradeSol(solAmt, input.clampTag),
      sizeReason: sizeExtra ? input.sizeReason + sizeExtra : input.sizeReason,
    };
  } catch {
    return {
      ok: true,
      solAmount: clampToMaxAllowedTradeSol(input.solAmount, input.clampTag),
      sizeReason: input.sizeReason,
    };
  }
}

/**
 * Shared execute after passesFilters for scanner (and reusable later).
 */
async function executeSignalBuy(
  signal: TradeSignal,
  buy: WalletBuyEvent,
  sizing: { sizeSol: number; reason: string },
  opts: { priority?: boolean; strategyKind?: 'migration' | 'normal' }
): Promise<void> {
  const buyOpts: Parameters<typeof executeBuy>[2] = {
    sourceWallets: signal.wallets,
    sourceNames: signal.walletNames,
    name: signal.name,
    strategyKind: opts.strategyKind ?? 'normal',
    solAmount: sizing.sizeSol,
    sizeReason: sizing.reason,
    sourceEntryMcUsd: signal.sourceEntryMcUsd,
    top10HoldPct: signal.metrics?.top10HoldPct ?? null,
    insiderPct:
      signal.antiRug?.insiderPct ?? signal.sniper?.insiderPct ?? null,
    convictionScore: signal.convictionScore,
    entrySource: signal.entrySource,
    scannerPlaybook: signal.scannerPlaybook,
    scannerConfluence: signal.scannerConfluence,
    candleSource: signal.candleSource,
    hmcSetup: signal.hmcSetup,
    hmcConfidence: signal.hmcConfidence,
    gateDecision: signal.gateDecision,
    ...resolveScalpBuyFlag(signal),
    tokenAgeHours: (() => {
      const ev = getMigrationEvent(signal.mint);
      if (ev?.detectedAt != null) {
        return Math.max(0, (Date.now() - ev.detectedAt) / 3_600_000);
      }
      return signal.tokenAgeHours ?? null;
    })(),
    antiRug: signal.antiRug
      ? {
          riskScore: signal.antiRug.riskScore,
          riskLevel: signal.antiRug.riskLevel,
          flags: signal.antiRug.flags,
          ok: signal.antiRug.ok,
        }
      : undefined,
  };
  if (opts.priority) {
    buyOpts.priority = true;
    buyOpts.slippageBps =
      config.strategy.migrationSlippageBps ?? config.paper.slippageBps;
  }

  const profileAssignment = assignTradeProfile({
    isMigration: signal.isMigration,
    nearMigration: signal.nearMigration,
    earlyBuy: signal.earlyBuy,
    migrationFresh: isRecentlyMigrated(signal.mint),
    migrationAgeMs: (() => {
      const ev = getMigrationEvent(signal.mint);
      return ev?.detectedAt != null ? Date.now() - ev.detectedAt : null;
    })(),
    curveProgressPct:
      signal.bondingCurve?.progressPct != null &&
      Number.isFinite(signal.bondingCurve.progressPct)
        ? Number(signal.bondingCurve.progressPct)
        : null,
    scalpMode: buyOpts.scalpMode,
    shortTermStrategyId: buyOpts.shortTermStrategyId,
    convictionScore: signal.convictionScore,
    dropFromPeakPct: signal.dropFromPeakPct,
    strategyKind: buyOpts.strategyKind,
    symbol: signal.symbol,
    marketCapUsd:
      signal.sourceEntryMcUsd ?? signal.metrics?.marketCapUsd ?? null,
    holderCount: signal.metrics?.holderCountEstimate ?? null,
    volumeH1Usd: signal.metrics?.volumeH1Usd ?? null,
    volumeM5Usd: signal.metrics?.volumeM5Usd ?? null,
    recentBuyVolumeUsd: signal.metrics?.recentBuyVolumeUsd ?? null,
    tokenAgeHours: signal.tokenAgeHours ?? null,
    priceChange24hPct: signal.metrics?.priceChange24hPct ?? null,
    priceChangeH1Pct: signal.metrics?.priceChangeH1Pct ?? null,
    smartMoneyScore: signal.birdeye?.smartMoneyScore ?? null,
    liquidityUsd: signal.metrics?.liquidityUsd ?? null,
    walletCount: signal.wallets.filter((w) => !isMarketScannerAddress(w)).length || null,
    nearKeyFib: signal.nearKeyFib === true,
    nearSupport: signal.nearSupport === true,
    chartPatternIds: signal.chartPatternIds ?? null,
    scannerOrigin: isMarketScannerSignal(signal),
    entrySource: signal.entrySource,
    preferProfileId: signal.candidateTradeProfileId ?? null,
  });

  if (profileAssignment.skipped) {
    finishBuy(buy.mint, false);
    markLaneFightCascadeResult(
      signal.mint,
      false,
      profileAssignment.skipReason || 'No trade profile scored high enough'
    );
    annotateActivityFeed(buy.mint, buy.signature, {
      tradeStatus: 'skipped',
      skipReason:
        profileAssignment.skipReason || 'No trade profile scored high enough',
    });
    annotateScannerCandidate(signal.mint, {
      status: 'skipped',
      skipReason: profileAssignment.skipReason || 'profile skip',
    });
    markScannerCooldown(signal.mint, false);
    return;
  }

  Object.assign(buyOpts, stampFromAssignment(profileAssignment));
  buyOpts.tradeProfileScore = profileAssignment.score;
  buyOpts.tradeProfileReason = profileAssignment.reason;
  stampEntryStyleOnBuyOpts(buyOpts, signal);
  const erScan = profileAssignment.exitRules;
  applyProfileExitRulesToBuyOpts(buyOpts, erScan);

  // Soft MARL low-MC coordination (skip / size-down) — never touches TP/SL.
  try {
    const {
      evaluateMarlLowMcCoordination,
      marlSizeMultiplier,
    } = require('./marlCoordinator') as typeof import('./marlCoordinator');
    const { profileRlSizeMultiplier } =
      require('./profileRlAgent') as typeof import('./profileRlAgent');
    const mcNum =
      signal.sourceEntryMcUsd != null
        ? Number(signal.sourceEntryMcUsd)
        : signal.metrics?.marketCapUsd != null
          ? Number(signal.metrics.marketCapUsd)
          : null;
    const low = evaluateMarlLowMcCoordination({
      mint: signal.mint,
      symbol: signal.symbol,
      profileId: String(profileAssignment.profileId || 'default'),
      marketCapUsd: mcNum,
    });
    if (low.action === 'skip') {
      appendMarlThoughtToLaneFight(signal.mint, low.reason);
      finishBuy(buy.mint, false);
      markLaneFightCascadeResult(signal.mint, false, low.reason);
      annotateActivityFeed(buy.mint, buy.signature, {
        tradeStatus: 'skipped',
        skipReason: low.reason,
      });
      annotateScannerCandidate(signal.mint, {
        status: 'skipped',
        skipReason: low.reason,
      });
      markScannerCooldown(signal.mint, false);
      return;
    }
    if (low.reason && low.action !== 'allow') {
      appendMarlThoughtToLaneFight(signal.mint, low.reason);
    } else if (low.action === 'allow' && low.reason.includes('low-MC slot')) {
      appendMarlThoughtToLaneFight(signal.mint, low.reason);
    }
    const sizedScan = applyTradeProfileSizing(
      buyOpts.solAmount ?? sizing.sizeSol,
      erScan
    );
    let solAmt = sizedScan.sizeSol;
    let sizeExtra = sizedScan.sizeNote
      ? ` · profile ${profileAssignment.name} ${sizedScan.sizeNote}`
      : '';
    const marlSz = marlSizeMultiplier(profileAssignment.profileId);
    if (marlSz.mult !== 1) {
      solAmt *= marlSz.mult;
      sizeExtra += ` · ${marlSz.note}`;
      appendMarlThoughtToLaneFight(
        signal.mint,
        `Size confidence ×${marlSz.mult.toFixed(2)} for ${profileAssignment.name || profileAssignment.profileId}`
      );
    }
    const rlSz = profileRlSizeMultiplier(profileAssignment.profileId);
    if (rlSz.mult !== 1) {
      solAmt *= rlSz.mult;
      sizeExtra += ` · ${rlSz.note}`;
      appendMarlThoughtToLaneFight(
        signal.mint,
        `Profile RL size ×${rlSz.mult.toFixed(2)} for ${profileAssignment.name || profileAssignment.profileId}`
      );
    }
    try {
      const { expectancySizeMultiplier } =
        require('./expectancyLift') as typeof import('./expectancyLift');
      const expSz = expectancySizeMultiplier({
        profileId: profileAssignment.profileId,
        family: String(buyOpts.entryStyle || ''),
        armedWatch: buyOpts.armedWatch === true || signal.armedWatch === true,
      });
      if (expSz.mult !== 1) {
        solAmt *= expSz.mult;
        sizeExtra += ` · ${expSz.note}`;
      }
    } catch {
      /* optional */
    }
    if (low.action === 'size_down' && low.sizeMult < 1) {
      solAmt *= low.sizeMult;
      sizeExtra += ` · ${low.reason}`;
      appendMarlThoughtToLaneFight(signal.mint, low.reason);
    }
    buyOpts.solAmount = clampToMaxAllowedTradeSol(
      solAmt,
      sizedScan.usedOverride ? 'profileOverride' : 'scannerProfileSize'
    );
    if (sizeExtra) {
      buyOpts.sizeReason = (buyOpts.sizeReason || sizing.reason) + sizeExtra;
    }
  } catch {
    const sizedScan = applyTradeProfileSizing(
      buyOpts.solAmount ?? sizing.sizeSol,
      erScan
    );
    buyOpts.solAmount = clampToMaxAllowedTradeSol(
      sizedScan.sizeSol,
      sizedScan.usedOverride ? 'profileOverride' : 'scannerProfileSize'
    );
    if (sizedScan.sizeNote) {
      buyOpts.sizeReason =
        (buyOpts.sizeReason || sizing.reason) +
        ` · profile ${profileAssignment.name} ${sizedScan.sizeNote}`;
    }
  }

  {
    const volSkip = evaluateVolumeIntelFastSoftSkip(
      String(profileAssignment.profileId || 'default'),
      signal
    );
    if (volSkip.skip) {
      finishBuy(buy.mint, false);
      markLaneFightCascadeResult(signal.mint, false, volSkip.reason);
      annotateActivityFeed(buy.mint, buy.signature, {
        tradeStatus: 'skipped',
        skipReason: volSkip.reason,
      });
      annotateScannerCandidate(signal.mint, {
        status: 'skipped',
        skipReason: volSkip.reason,
      });
      markScannerCooldown(signal.mint, false);
      console.log(`[monitor] ${volSkip.reason}`);
      return;
    }
  }

  try {
    const { checkDipBuyerRecoveryEntryGates } =
      require('./dipBuyerRecovery') as typeof import('./dipBuyerRecovery');
    const dbrGate = checkDipBuyerRecoveryEntryGates({
      profileId: String(profileAssignment.profileId || ''),
      openPositions: paperTrader.getOpenPositions().map((p) => ({
        tradeProfileId: p.tradeProfileId,
      })),
      volumeM5Usd: signal.metrics?.volumeM5Usd ?? null,
      volumeH1Usd: signal.metrics?.volumeH1Usd ?? null,
      recentVolumeUsd: signal.metrics?.recentBuyVolumeUsd ?? null,
      nearSupport: signal.nearSupport === true,
      nearFib:
        signal.nearKeyFib === true ||
        (signal as { nearFib?: boolean }).nearFib === true,
    });
    if (!dbrGate.ok) {
      finishBuy(buy.mint, false);
      markLaneFightCascadeResult(
        signal.mint,
        false,
        dbrGate.reason || 'dip buyer recovery'
      );
      annotateActivityFeed(buy.mint, buy.signature, {
        tradeStatus: 'skipped',
        skipReason: dbrGate.reason || 'Dip Buyer Recovery gate',
      });
      annotateScannerCandidate(signal.mint, {
        status: 'skipped',
        skipReason: dbrGate.reason || 'Dip Buyer Recovery gate',
      });
      markScannerCooldown(signal.mint, false);
      console.log(`[monitor] ${dbrGate.reason}`);
      return;
    }
  } catch {
    /* optional */
  }

  {
    const dbrVolSkip = evaluateDipBuyerRecoveryVolumeSkip(
      String(profileAssignment.profileId || 'default'),
      signal
    );
    if (dbrVolSkip.skip) {
      finishBuy(buy.mint, false);
      markLaneFightCascadeResult(signal.mint, false, dbrVolSkip.reason);
      annotateActivityFeed(buy.mint, buy.signature, {
        tradeStatus: 'skipped',
        skipReason: dbrVolSkip.reason,
      });
      annotateScannerCandidate(signal.mint, {
        status: 'skipped',
        skipReason: dbrVolSkip.reason,
      });
      markScannerCooldown(signal.mint, false);
      console.log(`[monitor] ${dbrVolSkip.reason}`);
      return;
    }
  }

  {
    const taGate = applyProfileTaPlaybookGate(
      String(profileAssignment.profileId || 'default'),
      signal,
      buyOpts
    );
    if (taGate.skip) {
      finishBuy(buy.mint, false);
      markLaneFightCascadeResult(signal.mint, false, taGate.reason);
      annotateActivityFeed(buy.mint, buy.signature, {
        tradeStatus: 'skipped',
        skipReason: taGate.reason,
      });
      annotateScannerCandidate(signal.mint, {
        status: 'skipped',
        skipReason: taGate.reason,
      });
      markScannerCooldown(signal.mint, false);
      return;
    }
  }

  const result = await executeBuy(signal.mint, signal.symbol, buyOpts);
  finishBuy(buy.mint, result.success);
  if (result.success) {
    markLaneFightCascadeResult(signal.mint, true);
    recordTradeExecuted();
    try {
      const armed =
        buyOpts.armedWatch === true ||
        signal.armedWatch === true ||
        (Array.isArray(signal.scannerReasons) &&
          signal.scannerReasons.some((r) =>
            /scalper-watch:triggered|dip-watch:triggered|grad-watch:triggered/i.test(
              String(r)
            )
          ));
      if (armed) {
        const { recordSetupWatchEvent } =
          require('./setupWatchEvents') as typeof import('./setupWatchEvents');
        const bits = (signal.scannerReasons || []).join(' ');
        const family = /scalper-watch/i.test(bits)
          ? 'scalper'
          : /grad-watch/i.test(bits)
            ? 'grad'
            : 'dip';
        recordSetupWatchEvent({
          kind: 'trigger_opened',
          family,
          mint: signal.mint,
          symbol: signal.symbol,
          profileId: String(profileAssignment.profileId || ''),
          reason: 'executeBuy ok',
          entryStyle: buyOpts.entryStyle,
          qualityScore:
            signal.qualityScoreHint ?? buyOpts.qualityScoreHint ?? null,
        });
      }
    } catch {
      /* optional */
    }
    try {
      const { noteDipBuyerRecoveryEntry } =
        require('./dipBuyerRecovery') as typeof import('./dipBuyerRecovery');
      if (String(profileAssignment.profileId || '') === 'dip_buyer') {
        noteDipBuyerRecoveryEntry('dip_buyer');
      }
    } catch {
      /* optional */
    }
    try {
      const { notifyMarlEntryOpened } =
        require('./marlCoordinator') as typeof import('./marlCoordinator');
      notifyMarlEntryOpened({
        mint: signal.mint,
        symbol: signal.symbol,
        profileId: String(profileAssignment.profileId || 'default'),
        marketCapUsd:
          signal.sourceEntryMcUsd != null
            ? Number(signal.sourceEntryMcUsd)
            : signal.metrics?.marketCapUsd != null
              ? Number(signal.metrics.marketCapUsd)
              : null,
      });
    } catch {
      /* */
    }
    annotateActivityFeed(buy.mint, buy.signature, {
      tradeStatus: 'taken',
      skipReason: undefined,
    });
    annotateScannerCandidate(signal.mint, { status: 'taken' });
    markScannerCooldown(signal.mint, true);
    console.log(
      `[monitor] Scanner trade executed (${result.mode}): ${signal.symbol} ` +
        `@ ${(buyOpts.solAmount ?? sizing.sizeSol).toFixed(3)} SOL · ${profileAssignment.name}`
    );
  } else {
    markLaneFightCascadeResult(
      signal.mint,
      false,
      result.error || 'executeBuy failed'
    );
    annotateActivityFeed(buy.mint, buy.signature, {
      tradeStatus: 'skipped',
      skipReason: result.error || 'executeBuy failed',
    });
    annotateScannerCandidate(signal.mint, {
      status: 'skipped',
      skipReason: result.error || 'executeBuy failed',
    });
    markScannerCooldown(signal.mint, false);
  }
}

async function handleMigrationPriorityEvent(event: MigrationEvent): Promise<void> {
  if (paused) return;
  if (isDeniedCopyMint(event.mint, config.solMint)) {
    console.log(
      `[monitor] Migration priority skipped — denied mint (stable/quote) ${event.mint.slice(0, 8)}…`
    );
    return;
  }
  const pumpFunGate = evaluateBuyPumpFunOnlyGate(event.mint);
  if (pumpFunGate) {
    console.log(
      `[monitor] Migration priority skipped — ${pumpFunGate}`
    );
    return;
  }
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
    entrySource: 'migration',
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

  try {
    signal.sourceEntryMcUsd = await resolveSourceEntryMcUsd(event.mint);
  } catch {
    /* non-fatal */
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

  const scalpFlag = resolveScalpBuyFlag(signal);
  const buyOpts: Parameters<typeof executeBuy>[2] = {
    sourceWallets: signal.wallets,
    sourceNames: signal.walletNames,
    name: signal.name,
    solAmount: sizing.sizeSol,
    slippageBps,
    priority: true,
    strategyKind: 'migration',
    sizeReason: sizing.reason,
    sourceEntryMcUsd: signal.sourceEntryMcUsd,
    top10HoldPct: signal.metrics?.top10HoldPct ?? null,
    insiderPct:
      signal.antiRug?.insiderPct ?? signal.sniper?.insiderPct ?? null,
    convictionScore: signal.convictionScore,
    hmcSetup: signal.hmcSetup,
    hmcConfidence: signal.hmcConfidence,
    gateDecision: signal.gateDecision,
    entrySource: signal.entrySource ?? 'migration',
    ...scalpFlag,
    tokenAgeHours: (() => {
      const ev = getMigrationEvent(signal.mint);
      if (ev?.detectedAt != null) {
        return Math.max(0, (Date.now() - ev.detectedAt) / 3_600_000);
      }
      return signal.tokenAgeHours ?? null;
    })(),
    antiRug: signal.antiRug
      ? {
          riskScore: signal.antiRug.riskScore,
          riskLevel: signal.antiRug.riskLevel,
          flags: signal.antiRug.flags,
          ok: signal.antiRug.ok,
        }
      : undefined,
  };

  const profileAssignment = assignTradeProfile(
    buildTradeProfileMatchContext(signal, {
      scalpMode: buyOpts.scalpMode,
      shortTermStrategyId: buyOpts.shortTermStrategyId,
      strategyKind: 'migration',
    })
  );
  if (!profileAssignment.skipped) {
    Object.assign(buyOpts, stampFromAssignment(profileAssignment));
    buyOpts.tradeProfileScore = profileAssignment.score;
    buyOpts.tradeProfileReason = profileAssignment.reason;
    stampEntryStyleOnBuyOpts(
      buyOpts,
      signal,
      buildTradeProfileMatchContext(signal, {
        scalpMode: buyOpts.scalpMode,
        shortTermStrategyId: buyOpts.shortTermStrategyId,
        strategyKind: 'migration',
      })
    );
    applyProfileExitRulesToBuyOpts(buyOpts, profileAssignment.exitRules);
    const sized = applyTradeProfileSizing(
      buyOpts.solAmount ?? sizing.sizeSol,
      profileAssignment.exitRules
    );
    let migSizeReason = buyOpts.sizeReason || sizing.reason;
    if (sized.sizeNote) {
      migSizeReason += ` · profile ${profileAssignment.name} ${sized.sizeNote}`;
    }
    const migMc =
      signal.sourceEntryMcUsd != null
        ? Number(signal.sourceEntryMcUsd)
        : signal.metrics?.marketCapUsd != null
          ? Number(signal.metrics.marketCapUsd)
          : null;
    const migMarlRl = applyMarlRlSoftSizing({
      profileId: String(profileAssignment.profileId || 'default'),
      profileName: profileAssignment.name,
      mint: signal.mint,
      symbol: signal.symbol,
      marketCapUsd: migMc,
      solAmount: sized.sizeSol,
      sizeReason: migSizeReason,
      clampTag: sized.usedOverride ? 'profileOverride' : 'migrationProfileSize',
      logThoughts: true,
    });
    if (!migMarlRl.ok) {
      finishBuy(event.mint, false);
      markLaneFightCascadeResult(signal.mint, false, migMarlRl.skipReason);
      annotateActivityFeedByMint(event.mint, {
        tradeStatus: 'skipped',
        skipReason: migMarlRl.skipReason,
      });
      return;
    }
    buyOpts.solAmount = migMarlRl.solAmount;
    buyOpts.sizeReason = migMarlRl.sizeReason;
    try {
      const {
        checkFastRecoveryEntryGates,
        getRecoveryConstraints,
      } = require('./fastProfileRecovery') as typeof import('./fastProfileRecovery');
      const pid = String(profileAssignment.profileId || 'migration_sniper');
      const gate = checkFastRecoveryEntryGates({
        profileId: pid,
        openPositions: paperTrader.getOpenPositions().map((p) => ({
          tradeProfileId: p.tradeProfileId,
        })),
        volumeM5Usd: signal.metrics?.volumeM5Usd ?? null,
        recentVolumeUsd: signal.metrics?.recentBuyVolumeUsd ?? null,
        tokenAgeMin:
          signal.tokenAgeHours != null
            ? Number(signal.tokenAgeHours) * 60
            : null,
      });
      if (!gate.ok) {
        finishBuy(event.mint, false);
        markLaneFightCascadeResult(signal.mint, false, gate.reason || 'recovery');
        annotateActivityFeedByMint(event.mint, {
          tradeStatus: 'skipped',
          skipReason: gate.reason || 'Fast Recovery gate',
        });
        console.log(`[monitor] ${gate.reason}`);
        return;
      }
      const rc = getRecoveryConstraints(pid);
      if (rc.active && rc.tpPctMaxSoft != null && buyOpts.profileTakeProfitPct != null) {
        buyOpts.profileTakeProfitPct = Math.min(
          Number(buyOpts.profileTakeProfitPct),
          rc.tpPctMaxSoft
        );
      }
      if (rc.active && rc.stopLossPctTight != null && buyOpts.profileStopLossPct != null) {
        const sl = Number(buyOpts.profileStopLossPct);
        const tight = rc.stopLossPctTight;
        buyOpts.profileStopLossPct =
          sl < 0 ? Math.max(sl, tight) : Math.min(sl, Math.abs(tight));
      }
    } catch {
      /* optional */
    }
    console.log(
      `[monitor] Profile ${profileAssignment.icon} ${profileAssignment.name} → ${signal.symbol}` +
        ` · score ${profileAssignment.score.toFixed(1)} (migration priority)`
    );
  } else {
    console.log(
      `[monitor] Migration priority — no profile stamp (${profileAssignment.skipReason || profileAssignment.reason})`
    );
  }

  {
    const volSkip = evaluateVolumeIntelFastSoftSkip(
      buyOpts.tradeProfileId ||
        String(profileAssignment.profileId || 'migration_sniper'),
      signal
    );
    if (volSkip.skip) {
      finishBuy(event.mint, false);
      markLaneFightCascadeResult(signal.mint, false, volSkip.reason);
      annotateActivityFeedByMint(event.mint, {
        tradeStatus: 'skipped',
        skipReason: volSkip.reason,
      });
      console.log(`[monitor] ${volSkip.reason}`);
      return;
    }
  }

  {
    const taGate = applyProfileTaPlaybookGate(
      buyOpts.tradeProfileId ||
        String(profileAssignment.profileId || 'migration_sniper'),
      signal,
      buyOpts
    );
    if (taGate.skip) {
      finishBuy(event.mint, false);
      markLaneFightCascadeResult(signal.mint, false, taGate.reason);
      annotateActivityFeedByMint(event.mint, {
        tradeStatus: 'skipped',
        skipReason: taGate.reason,
      });
      return;
    }
  }

  const result = await executeBuy(signal.mint, signal.symbol, buyOpts);
  finishBuy(event.mint, result.success);
  if (result.success) {
    markLaneFightCascadeResult(signal.mint, true);
    recordTradeExecuted();
    try {
      const { noteFastProfileEntry } =
        require('./fastProfileRecovery') as typeof import('./fastProfileRecovery');
      noteFastProfileEntry(
        String(profileAssignment.profileId || 'migration_sniper')
      );
    } catch {
      /* optional */
    }
    annotateActivityFeedByMint(event.mint, {
      tradeStatus: 'taken',
      skipReason: undefined,
    });
    console.log(
      `[monitor] Migration priority trade executed (${result.mode}): ${label} ` +
        `@ ${(buyOpts.solAmount ?? sizing.sizeSol).toFixed(3)} SOL` +
        (profileAssignment.skipped ? '' : ` · ${profileAssignment.name}`)
    );
  } else {
    markLaneFightCascadeResult(
      signal.mint,
      false,
      result.error || 'migration executeBuy failed'
    );
    annotateActivityFeedByMint(event.mint, {
      tradeStatus: 'skipped',
      skipReason: result.error || 'migration executeBuy failed',
    });
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
  if (isDeniedCopyMint(buy.mint, config.solMint)) {
    console.log(
      `[monitor] Ignoring denied mint (stable/quote) ${buy.mint.slice(0, 8)}…`
    );
    return;
  }
  buy.detectedAt = buy.detectedAt ?? Date.now();
  await enrichBuyEvent(buy);
  const label = formatTokenLabel(buy.symbol, buy.name, buy.mint);

  // Influencer / Top PnL Smart Mirror fast path (master ON + tagged wallet)
  try {
    const {
      isInfluencerMirrorEnabled,
      isInfluencerMirrorWallet,
    } = require('./influencerMirror') as typeof import('./influencerMirror');
    const sw = config.smartWallets.find((w) => w.address === buy.wallet);
    if (
      isInfluencerMirrorEnabled() &&
      sw &&
      isInfluencerMirrorWallet(sw)
    ) {
      const { tryInfluencerMirrorBuy } =
        require('./influencerMirrorRuntime') as typeof import('./influencerMirrorRuntime');
      const result = await tryInfluencerMirrorBuy({
        wallet: sw,
        mint: buy.mint,
        symbol: buy.symbol,
        name: buy.name,
        signature: buy.signature,
        timestamp: buy.timestamp,
        detectedAt: buy.detectedAt,
        isPumpFun: buy.isPumpFun,
        isMigration: buy.isMigration,
      });
      if (result.handled) {
        if (!recentBuys.has(buy.mint)) recentBuys.set(buy.mint, []);
        const buys = recentBuys.get(buy.mint)!;
        if (
          !buys.some(
            (b) => b.wallet === buy.wallet && b.signature === buy.signature
          )
        ) {
          const feedEvent: WalletBuyEvent = {
            ...buy,
            tradeStatus: result.taken ? 'taken' : 'skipped',
            skipReason: result.skipReason,
            entrySource: 'wallet',
            detectedAt: buy.detectedAt,
          };
          buys.push(feedEvent);
          pushActivityFeed(feedEvent);
        } else {
          annotateActivityFeed(buy.mint, buy.signature, {
            tradeStatus: result.taken ? 'taken' : 'skipped',
            skipReason: result.skipReason,
          });
        }
        return;
      }
    }
  } catch (err) {
    console.warn(
      `[monitor] Influencer mirror buy path error:`,
      err instanceof Error ? err.message : err
    );
  }

  // Only the migration listener (or explicit grad events) may stamp freshness.
  // PumpSwap venue buys set buy.isMigration for sizing/tags, but must NOT call
  // markAsMigrated — that falsely made migrationFresh=true and forced Migration Sniper.
  const recentlyMigrated = isRecentlyMigrated(buy.mint);
  const isMigration = buy.isMigration || recentlyMigrated;

  console.log(
    `[monitor] 🔔 ${buy.walletName} bought ${label} (${buy.mint.slice(0, 8)}…) ` +
      `[pump: ${buy.isPumpFun}, migration: ${isMigration}]`
  );

  // Zion observe-only boost — never skips or alters copy path
  try {
    if (config.zion?.enabled && config.zion.useTrackedWalletsAsBoost !== false) {
      const { noteTrackedBuy } =
        require('./zionKolScanner') as typeof import('./zionKolScanner');
      noteTrackedBuy({
        mint: buy.mint,
        symbol: buy.symbol,
        name: buy.name,
        walletAddress: buy.wallet,
        walletName: buy.walletName,
        timestamp: buy.timestamp || buy.detectedAt,
      });
    }
  } catch {
    /* Zion optional */
  }

  // Push to Recent Signals IMMEDIATELY so the feed stays live even when
  // anti-rug / Dex / Birdeye calls are slow or the trade is later skipped.
  if (!recentBuys.has(buy.mint)) {
    recentBuys.set(buy.mint, []);
  }
  const buys = recentBuys.get(buy.mint)!;
  let feedEvent: WalletBuyEvent | null = null;

  if (!buys.some((b) => b.wallet === buy.wallet && b.signature === buy.signature)) {
    feedEvent = {
      ...buy,
      isMigration,
      tradeStatus: 'seen',
      detectedAt: buy.detectedAt,
    };
    buys.push(feedEvent);
    pushActivityFeed(feedEvent);
  } else {
    feedEvent =
      buys.find(
        (b) => b.wallet === buy.wallet && b.signature === buy.signature
      ) ?? null;
  }

  // Attach token metrics + anti-rug + bonding curve for dashboard (cached)
  try {
    const metrics = await fetchTokenMetrics(buy.mint);
    buy.metrics = summarizeTokenMetrics(metrics);
    const report = await evaluateAntiRug(buy.mint, {
      earlyEntry: Boolean(buy.isPumpFun && !isMigration),
      isMigrated: isMigration,
    });
    buy.antiRug = summarizeAntiRug(report);
    if (report.sniper) buy.sniper = report.sniper;
    if (report.birdeye) buy.birdeye = report.birdeye;
    // Prefer Birdeye holders/liq on the feed row when Dex left them null
    if (buy.metrics && report.checks) {
      if (
        buy.metrics.holderCountEstimate == null &&
        report.checks.holderCount != null
      ) {
        buy.metrics.holderCountEstimate = report.checks.holderCount;
      }
      if (
        (buy.metrics.liquidityUsd == null || buy.metrics.liquidityUsd <= 0) &&
        report.checks.liquidityUsd != null
      ) {
        buy.metrics.liquidityUsd = report.checks.liquidityUsd;
      }
      if (
        buy.metrics.volume24hUsd == null &&
        report.checks.volume24hUsd != null
      ) {
        buy.metrics.volume24hUsd = report.checks.volume24hUsd;
      }
      if (
        buy.metrics.top10HoldPct == null &&
        report.checks.top10HoldPct != null
      ) {
        buy.metrics.top10HoldPct = report.checks.top10HoldPct;
      }
      if (buy.metrics.devHoldPct == null && report.checks.devHoldPct != null) {
        buy.metrics.devHoldPct = report.checks.devHoldPct;
      }
    }
  } catch {
    // non-fatal
  }

  // Dedicated sniper fetch if anti-rug didn't attach (filter off / fail)
  if (
    !buy.sniper &&
    isStrategyEnabled('sniper_bundler_filters') &&
    config.filters.enableSniperFilter !== false
  ) {
    try {
      const sniper = await getTokenSniperActivity(buy.mint);
      if (sniper.source !== 'none') {
        buy.sniper = summarizeSniper(sniper);
      }
    } catch {
      // non-fatal
    }
  }

  // Birdeye fallback only when anti-rug is ON (otherwise every buy hits Birdeye and stalls drain)
  if (!buy.birdeye && isStrategyEnabled('anti_rug_honeypot')) {
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

  // Sync heavy enrichment onto the live feed row
  if (feedEvent) {
    feedEvent.metrics = buy.metrics;
    feedEvent.antiRug = buy.antiRug;
    feedEvent.bondingCurve = buy.bondingCurve;
    feedEvent.sniper = buy.sniper;
    feedEvent.birdeye = buy.birdeye;
    feedEvent.earlyBuy = buy.earlyBuy;
    feedEvent.earlyBuyerCount = buy.earlyBuyerCount;
    feedEvent.isMigration = isMigration;
    feedEvent.symbol = buy.symbol;
    feedEvent.name = buy.name;
  }

  // Dex/Birdeye often lag on brand-new mints — refresh feed metrics shortly
  scheduleSignalMetricsRefresh(buy.mint, buy.signature);

  // Feed re-entry confirmation if we're watching this mint after exit
  {
    const reParams = getReEntryEffectiveParams();
    if (
      (reParams.profitDipEnabled || reParams.stopReentryEnabled) &&
      isReBuyWatching(buy.mint)
    ) {
      recordConfirmationBuy(buy.mint, buy.wallet, buy.walletName);
      const price = paperTrader.getTokenPrice(buy.mint);
      if (price != null) updateCandidatePrice(buy.mint, price);
      const triggered = await tryExecuteReBuy(buy.mint);
      if (triggered) {
        annotateActivityFeed(buy.mint, buy.signature, {
          tradeStatus: 'taken',
          skipReason: undefined,
        });
        return; // re-entry path handled entry
      }
    }
  }

  let signal: TradeSignal | null = null;
  let priority = false;

  // Migration + smart wallet activity = strong buy (larger size, tighter slip)
  if (config.strategy.enableMigrationPriority && isStrategyEnabled('migration_priority') && isMigration) {
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
    isStrategyEnabled('near_migration_curve') &&
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
      `[monitor] 📈 STRONG BUY — near-migration curve ${Number(buy.bondingCurve.progressPct ?? 0).toFixed(1)}% ` +
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
      notes: `near-mig ${Number(buy.bondingCurve.progressPct ?? 0).toFixed(0)}%`,
    });
    try {
      const { considerMigrationGradWatch } =
        require('./migrationGradWatch') as typeof import('./migrationGradWatch');
      considerMigrationGradWatch({
        mint: buy.mint,
        symbol: buy.symbol,
        name: buy.name,
        curveProgressPct: buy.bondingCurve.progressPct,
        source: 'near-mig-wallet',
      });
    } catch {
      /* ignore */
    }
  } else if (
    isStrategyEnabled('early_curve_smart_money') &&
    buy.isPumpFun &&
    !isMigration
  ) {
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
        // Single tracked wallet on Pump.fun — still form a candidate signal
        // (anti-rug + conviction decide take/skip). Without this, activity
        // appears but Signals/Trades stay empty until N-wallet convergence.
        const treatEarly =
          Boolean(buy.earlyBuy) ||
          buy.bondingCurve?.progressPct == null ||
          isEarlyCurveBuy(buy.bondingCurve?.progressPct);
        signal = {
          mint: buy.mint,
          symbol: buy.symbol,
          name: buy.name,
          wallets: [buy.wallet],
          walletNames: [buy.walletName],
          isMigration: false,
          nearMigration: Boolean(buy.bondingCurve?.nearMigration),
          earlyBuy: treatEarly,
          earlyBuyerCount: buy.earlyBuyerCount ?? 1,
          timestamp: Date.now(),
          bondingCurve: buy.bondingCurve,
          birdeye: buy.birdeye,
        };
        priority = treatEarly;
        console.log(
          `[monitor] ${priority ? '🎯' : '📡'} Pump single-wallet candidate ` +
            `${buy.walletName} on ${label}` +
            (treatEarly ? ' (early/unknown curve)' : '')
        );
        recordPumpSmartActivity({
          kind: treatEarly ? 'early_buy' : 'curve_buy',
          mint: buy.mint,
          symbol: buy.symbol,
          name: buy.name,
          wallets: [buy.wallet],
          walletNames: [buy.walletName],
          isPumpFun: true,
          isMigration: false,
          priority,
          curveProgressPct: buy.bondingCurve?.progressPct ?? null,
          birdeye: buy.birdeye,
          notes: earlyGate.reason || 'single_wallet_candidate',
        });
        if (
          buy.bondingCurve?.progressPct != null &&
          buy.bondingCurve.progressPct >= 80
        ) {
          try {
            const { considerMigrationGradWatch } =
              require('./migrationGradWatch') as typeof import('./migrationGradWatch');
            considerMigrationGradWatch({
              mint: buy.mint,
              symbol: buy.symbol,
              name: buy.name,
              curveProgressPct: buy.bondingCurve.progressPct,
              source: 'pump-wallet',
            });
          } catch {
            /* ignore */
          }
        }
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
    if (!signal) {
      // Form a single-wallet candidate (same as Pump path) so Medium can open
      // when selective/conviction allows — never hang forever on waiting 1/N.
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
      console.log(
        `[monitor] 📡 Single-wallet candidate ${buy.walletName} on ${label}` +
          ` (convergence ${config.filters.convergenceRequired ?? 2}+ optional)`
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

  if (!signal) {
    return;
  }

  // Prefer enriched name/symbol from this buy if signal still has placeholders
  signal.symbol = buy.symbol || signal.symbol;
  signal.name = buy.name || signal.name;

  // Claim mint BEFORE slow filter awaits so concurrent wallet/migration
  // handlers cannot both open the same token.
  if (!beginBuy(buy.mint)) {
    if (isReBuyWatching(buy.mint)) {
      console.log(
        `[monitor] ${label} already traded — waiting for re-entry confirmation (reclaim/dip + wallets/volume)`
      );
      annotateActivityFeed(buy.mint, buy.signature, {
        tradeStatus: 'waiting',
        skipReason: 'already traded — re-entry watch',
      });
    } else {
      console.log(`[monitor] Signal skipped — already traded ${label}`);
      annotateActivityFeed(buy.mint, buy.signature, {
        tradeStatus: 'skipped',
        skipReason: 'already traded',
      });
    }
    return;
  }

  try {
  if (!(await passesFilters(signal))) {
    finishBuy(buy.mint, false);
    // recordRejectedSignal already annotated the feed with skipReason
    return;
  }

  console.log(
    `[monitor] ✅ SIGNAL${priority ? ' (priority)' : ''}: ${signal.walletNames.join(' + ')} → ${formatTokenLabel(signal.symbol, signal.name, signal.mint)}`
  );

  // Snapshot MC at signal time (smart-wallet entry) before our fill
  if (signal.sourceEntryMcUsd == null) {
    try {
      signal.sourceEntryMcUsd = await resolveSourceEntryMcUsd(signal.mint);
    } catch {
      /* non-fatal */
    }
  }

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
    sourceEntryMcUsd?: number;
    top10HoldPct?: number | null;
    insiderPct?: number | null;
    convictionScore?: number;
    hmcSetup?: string;
    hmcConfidence?: number;
    gateDecision?: string;
    entryQualityScore?: number;
    tokenAgeHours?: number | null;
    scalpMode?: boolean;
    shortTermStrategyId?: ShortTermStrategyId;
    tradeProfileId?: string;
    tradeProfileName?: string;
    tradeProfileIcon?: string;
    tradeProfileColor?: string;
    tradeProfileScore?: number;
    tradeProfileReason?: string;
    profileTakeProfitPct?: number;
    profileStopLossPct?: number;
    profileTrailingStopPct?: number;
    profileTrailingActivationProfit?: number;
    profileForceScalp?: boolean;
    profileHardTimeLimitSec?: number;
    profileOverrideScalpParams?: boolean;
    profileMomentumFailDropPct?: number;
    profileDeadVolumeMinHoldMinutes?: number;
    profileAggressiveDeadMarket?: boolean;
    entrySource?: 'wallet' | 'scanner' | 'migration' | 'hybrid';
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
    sourceEntryMcUsd: signal.sourceEntryMcUsd,
    top10HoldPct: signal.metrics?.top10HoldPct ?? null,
    insiderPct:
      signal.antiRug?.insiderPct ?? signal.sniper?.insiderPct ?? null,
    convictionScore: signal.convictionScore,
    hmcSetup: signal.hmcSetup,
    hmcConfidence: signal.hmcConfidence,
    gateDecision: signal.gateDecision,
    entrySource:
      signal.entrySource ??
      (signal.isMigration || signal.nearMigration ? 'migration' : 'wallet'),
    ...resolveScalpBuyFlag(signal),
    tokenAgeHours: (() => {
      const ev = getMigrationEvent(signal.mint);
      if (ev?.detectedAt != null) {
        return Math.max(0, (Date.now() - ev.detectedAt) / 3_600_000);
      }
      return signal.tokenAgeHours ?? null;
    })(),
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
      ? config.strategy.enableMigrationPriority &&
        isStrategyEnabled('migration_priority')
      : signal.earlyBuy
        ? config.strategy.enableEarlyCurvePriority !== false &&
          isStrategyEnabled('early_curve_smart_money')
        : config.strategy.enableBondingCurvePriority !== false &&
          isStrategyEnabled('near_migration_curve'))
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

  // Multi-profile assignment — stamp + freeze profile exit rules on this trade
  const profileAssignment = assignTradeProfile({
    isMigration: signal.isMigration,
    nearMigration: signal.nearMigration,
    earlyBuy: signal.earlyBuy,
    migrationFresh: isRecentlyMigrated(signal.mint),
    migrationAgeMs: (() => {
      const ev = getMigrationEvent(signal.mint);
      return ev?.detectedAt != null ? Date.now() - ev.detectedAt : null;
    })(),
    curveProgressPct:
      signal.bondingCurve?.progressPct != null &&
      Number.isFinite(signal.bondingCurve.progressPct)
        ? Number(signal.bondingCurve.progressPct)
        : null,
    scalpMode: buyOpts.scalpMode,
    shortTermStrategyId: buyOpts.shortTermStrategyId,
    convictionScore: signal.convictionScore,
    dropFromPeakPct: signal.dropFromPeakPct,
    strategyKind: buyOpts.strategyKind,
    symbol: signal.symbol,
    marketCapUsd:
      signal.sourceEntryMcUsd ??
      signal.metrics?.marketCapUsd ??
      null,
    holderCount: signal.metrics?.holderCountEstimate ?? null,
    volumeH1Usd: signal.metrics?.volumeH1Usd ?? null,
    volumeM5Usd: signal.metrics?.volumeM5Usd ?? null,
    recentBuyVolumeUsd: signal.metrics?.recentBuyVolumeUsd ?? null,
    tokenAgeHours: signal.tokenAgeHours ?? null,
    priceChange24hPct: signal.metrics?.priceChange24hPct ?? null,
    priceChangeH1Pct: signal.metrics?.priceChangeH1Pct ?? null,
    smartMoneyScore: signal.birdeye?.smartMoneyScore ?? null,
    liquidityUsd: signal.metrics?.liquidityUsd ?? null,
    walletCount: Array.isArray(signal.wallets) ? signal.wallets.length : null,
    nearKeyFib: (signal as { nearKeyFib?: boolean }).nearKeyFib === true,
    nearSupport: (signal as { nearSupport?: boolean }).nearSupport === true,
    chartPatternIds:
      (signal as { chartPatternIds?: string[] }).chartPatternIds ?? null,
    chartPatternSummary:
      (signal as { chartPatternSummary?: string }).chartPatternSummary ?? null,
    chartPatternHits:
      (
        signal as {
          chartPatternHits?: Array<{
            id: string;
            confidence: number;
            breakout: boolean;
            bias?: string;
          }>;
        }
      ).chartPatternHits ?? null,
    scannerOrigin: isMarketScannerSignal(signal),
    entrySource: signal.entrySource,
    preferProfileId: signal.candidateTradeProfileId ?? null,
    walletQualityAvg: (() => {
      const addrs = Array.isArray(signal.wallets) ? signal.wallets : [];
      if (!addrs.length) return null;
      let sum = 0;
      let n = 0;
      for (const addr of addrs) {
        const w = config.smartWallets.find((sw) => sw.address === addr);
        if (!w) continue;
        if (w.qualityScore == null) applyQualityToWallet(w);
        if (w.qualityScore != null && Number.isFinite(w.qualityScore)) {
          sum += Number(w.qualityScore);
          n += 1;
        }
      }
      return n > 0 ? sum / n : null;
    })(),
  });

  if (profileAssignment.skipped) {
    finishBuy(buy.mint, false);
    markLaneFightCascadeResult(
      signal.mint,
      false,
      profileAssignment.skipReason || 'No trade profile scored high enough'
    );
    annotateActivityFeed(buy.mint, buy.signature, {
      tradeStatus: 'skipped',
      skipReason:
        profileAssignment.skipReason ||
        'No trade profile scored high enough',
    });
    console.log(
      `[monitor] Signal skipped — profile auto-score: ${profileAssignment.skipReason || profileAssignment.reason}`
    );
    if (profileAssignment.topScores?.length) {
      console.log(
        `[monitor] Top profile scores: ` +
          profileAssignment.topScores
            .map((t) => `${t.name}=${t.score.toFixed(1)}`)
            .join(' · ')
      );
    }
    return;
  }

  Object.assign(buyOpts, stampFromAssignment(profileAssignment));
  buyOpts.tradeProfileScore = profileAssignment.score;
  buyOpts.tradeProfileReason = profileAssignment.reason;
  stampEntryStyleOnBuyOpts(buyOpts, signal);
  const er = profileAssignment.exitRules;
  applyProfileExitRulesToBuyOpts(buyOpts, er);
  const sized = applyTradeProfileSizing(buyOpts.solAmount ?? sizing.sizeSol, er);
  let walletSizeReason = buyOpts.sizeReason || 'Dynamic size';
  if (sized.sizeNote) {
    walletSizeReason += ` · profile ${profileAssignment.name} ${sized.sizeNote}`;
  }
  const walletMc =
    signal.sourceEntryMcUsd != null
      ? Number(signal.sourceEntryMcUsd)
      : signal.metrics?.marketCapUsd != null
        ? Number(signal.metrics.marketCapUsd)
        : null;
  const walletMarlRl = applyMarlRlSoftSizing({
    profileId: String(profileAssignment.profileId || 'default'),
    profileName: profileAssignment.name,
    mint: signal.mint,
    symbol: signal.symbol,
    marketCapUsd: walletMc,
    solAmount: sized.sizeSol,
    sizeReason: walletSizeReason,
    clampTag: sized.usedOverride ? 'profileOverride' : 'profileSize',
    logThoughts: true,
  });
  if (!walletMarlRl.ok) {
    finishBuy(buy.mint, false);
    markLaneFightCascadeResult(signal.mint, false, walletMarlRl.skipReason);
    annotateActivityFeed(buy.mint, buy.signature, {
      tradeStatus: 'skipped',
      skipReason: walletMarlRl.skipReason,
    });
    return;
  }
  buyOpts.solAmount = walletMarlRl.solAmount;
  buyOpts.sizeReason = walletMarlRl.sizeReason;

  try {
    const {
      checkFastRecoveryEntryGates,
      getRecoveryConstraints,
    } = require('./fastProfileRecovery') as typeof import('./fastProfileRecovery');
    const gate = checkFastRecoveryEntryGates({
      profileId: String(profileAssignment.profileId || ''),
      openPositions: paperTrader.getOpenPositions().map((p) => ({
        tradeProfileId: p.tradeProfileId,
      })),
      volumeM5Usd: signal.metrics?.volumeM5Usd ?? null,
      recentVolumeUsd: signal.metrics?.recentBuyVolumeUsd ?? null,
      extensionPct:
        signal.metrics &&
        (signal.metrics as { priceChangeM5Pct?: number }).priceChangeM5Pct != null
          ? Number((signal.metrics as { priceChangeM5Pct?: number }).priceChangeM5Pct)
          : null,
      tokenAgeMin:
        signal.tokenAgeHours != null ? Number(signal.tokenAgeHours) * 60 : null,
    });
    if (!gate.ok) {
      finishBuy(buy.mint, false);
      markLaneFightCascadeResult(signal.mint, false, gate.reason || 'recovery gate');
      annotateActivityFeed(buy.mint, buy.signature, {
        tradeStatus: 'skipped',
        skipReason: gate.reason || 'Fast Recovery gate',
      });
      console.log(`[monitor] ${gate.reason}`);
      return;
    }
    const rc = getRecoveryConstraints(String(profileAssignment.profileId || ''));
    if (rc.active && rc.tpPctMaxSoft != null && buyOpts.profileTakeProfitPct != null) {
      buyOpts.profileTakeProfitPct = Math.min(
        Number(buyOpts.profileTakeProfitPct),
        rc.tpPctMaxSoft
      );
    }
    if (rc.active && rc.stopLossPctTight != null && buyOpts.profileStopLossPct != null) {
      const sl = Number(buyOpts.profileStopLossPct);
      const tight = rc.stopLossPctTight;
      buyOpts.profileStopLossPct =
        sl < 0 ? Math.max(sl, tight) : Math.min(sl, Math.abs(tight));
    }
  } catch {
    /* optional */
  }

  try {
    const { checkDipBuyerRecoveryEntryGates } =
      require('./dipBuyerRecovery') as typeof import('./dipBuyerRecovery');
    const dbrGate = checkDipBuyerRecoveryEntryGates({
      profileId: String(profileAssignment.profileId || ''),
      openPositions: paperTrader.getOpenPositions().map((p) => ({
        tradeProfileId: p.tradeProfileId,
      })),
      volumeM5Usd: signal.metrics?.volumeM5Usd ?? null,
      volumeH1Usd: signal.metrics?.volumeH1Usd ?? null,
      recentVolumeUsd: signal.metrics?.recentBuyVolumeUsd ?? null,
      nearSupport: signal.nearSupport === true,
      nearFib:
        signal.nearKeyFib === true ||
        (signal as { nearFib?: boolean }).nearFib === true,
    });
    if (!dbrGate.ok) {
      finishBuy(buy.mint, false);
      markLaneFightCascadeResult(
        signal.mint,
        false,
        dbrGate.reason || 'dip buyer recovery gate'
      );
      annotateActivityFeed(buy.mint, buy.signature, {
        tradeStatus: 'skipped',
        skipReason: dbrGate.reason || 'Dip Buyer Recovery gate',
      });
      console.log(`[monitor] ${dbrGate.reason}`);
      return;
    }
  } catch {
    /* optional */
  }

  recordSignalSizing(signal, sizing, true);
  console.log(`[monitor] ${sizing.reason}`);
  console.log(
    `[monitor] Profile ${profileAssignment.icon} ${profileAssignment.name} → ${signal.symbol}` +
      ` · score ${profileAssignment.score.toFixed(1)}` +
      ` (${profileAssignment.reason})` +
      (profileAssignment.forced ? ' · FORCED' : '') +
      (profileAssignment.autoScored ? ' · auto' : '')
  );
  if (profileAssignment.topScores && profileAssignment.topScores.length > 1) {
    console.log(
      `[monitor] Profile runners-up: ` +
        profileAssignment.topScores
          .slice(0, 4)
          .map((t) => `${t.name}=${t.score.toFixed(1)}`)
          .join(' · ')
    );
  }

  {
    const volSkip = evaluateVolumeIntelFastSoftSkip(
      String(profileAssignment.profileId || 'default'),
      signal
    );
    if (volSkip.skip) {
      finishBuy(buy.mint, false);
      markLaneFightCascadeResult(signal.mint, false, volSkip.reason);
      annotateActivityFeed(buy.mint, buy.signature, {
        tradeStatus: 'skipped',
        skipReason: volSkip.reason,
      });
      console.log(`[monitor] ${volSkip.reason}`);
      return;
    }
  }

  {
    const dbrVolSkip = evaluateDipBuyerRecoveryVolumeSkip(
      String(profileAssignment.profileId || 'default'),
      signal
    );
    if (dbrVolSkip.skip) {
      finishBuy(buy.mint, false);
      markLaneFightCascadeResult(signal.mint, false, dbrVolSkip.reason);
      annotateActivityFeed(buy.mint, buy.signature, {
        tradeStatus: 'skipped',
        skipReason: dbrVolSkip.reason,
      });
      console.log(`[monitor] ${dbrVolSkip.reason}`);
      return;
    }
  }

  {
    const taGate = applyProfileTaPlaybookGate(
      String(profileAssignment.profileId || 'default'),
      signal,
      buyOpts
    );
    if (taGate.skip) {
      finishBuy(buy.mint, false);
      markLaneFightCascadeResult(signal.mint, false, taGate.reason);
      annotateActivityFeed(buy.mint, buy.signature, {
        tradeStatus: 'skipped',
        skipReason: taGate.reason,
      });
      return;
    }
  }

  const result = await executeBuy(signal.mint, signal.symbol, buyOpts);
  finishBuy(buy.mint, result.success);

  if (result.success) {
    markLaneFightCascadeResult(signal.mint, true);
    recordTradeExecuted();
    try {
      const { noteFastProfileEntry } =
        require('./fastProfileRecovery') as typeof import('./fastProfileRecovery');
      noteFastProfileEntry(String(profileAssignment.profileId || ''));
    } catch {
      /* optional */
    }
    try {
      const { noteDipBuyerRecoveryEntry } =
        require('./dipBuyerRecovery') as typeof import('./dipBuyerRecovery');
      if (String(profileAssignment.profileId || '') === 'dip_buyer') {
        noteDipBuyerRecoveryEntry('dip_buyer');
      }
    } catch {
      /* optional */
    }
    annotateActivityFeed(buy.mint, buy.signature, {
      tradeStatus: 'taken',
      skipReason: undefined,
    });
    console.log(
      `[monitor] Copy trade executed (${result.mode}): ${formatTokenLabel(signal.symbol, signal.name, signal.mint)}` +
        (signal.convictionScore != null ? ` · conviction ${signal.convictionScore}` : '') +
        ` · ${sizing.sizeSol.toFixed(4)} SOL`
    );
  } else {
    markLaneFightCascadeResult(
      signal.mint,
      false,
      result.error || 'executeBuy failed'
    );
    annotateActivityFeed(buy.mint, buy.signature, {
      tradeStatus: 'skipped',
      skipReason: result.error || 'executeBuy failed',
    });
    console.error(`[monitor] Copy trade failed: ${result.error}`);
  }
  } catch (err) {
    finishBuy(buy.mint, false);
    annotateActivityFeed(buy.mint, buy.signature, {
      tradeStatus: 'skipped',
      skipReason: err instanceof Error ? err.message : 'handler error',
    });
    throw err;
  }
}

/**
 * Refresh market data for watched mints and execute when confirmation is met.
 */
async function evaluateReBuyOpportunities(): Promise<void> {
  const params = getReEntryEffectiveParams();
  if ((!params.profitDipEnabled && !params.stopReentryEnabled) || paused) {
    return;
  }

  const active = getReBuyCandidates().filter(
    (c) =>
      c.status === 'watching' ||
      c.status === 'dip_armed' ||
      c.status === 'reclaim_armed'
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
 * If arm + confirmation are ready, execute a re-entry (paper, live-sim, or live).
 * Returns true if a re-buy was attempted/executed.
 */
async function tryExecuteReBuy(mint: string): Promise<boolean> {
  const params = getReEntryEffectiveParams();
  if (!params.profitDipEnabled && !params.stopReentryEnabled) return false;

  const conf = evaluateConfirmation(mint);
  if (!conf.ready) {
    // Periodic debug at low rate for armed candidates
    const c = getReBuyCandidates().find((x) => x.mint === mint);
    if (
      (c?.status === 'dip_armed' || c?.status === 'reclaim_armed') &&
      Math.random() < 0.15
    ) {
      console.log(`[reentry] ${c.symbol}: ${conf.reason}`);
    }
    return false;
  }

  // Already holding — don't double up
  if (paperTrader.hasOpenMint(mint)) {
    console.log(
      `[reentry] Skip — already holding open position on ${mint.slice(0, 8)}…`
    );
    return false;
  }

  if (!beginBuy(mint, { allowRetrade: true })) {
    console.log(
      `[reentry] Skip — buy already in progress for ${mint.slice(0, 8)}…`
    );
    return false;
  }

  try {
    const candidate = getReBuyCandidates().find((c) => c.mint === mint);
    if (!candidate) {
      finishBuy(mint, false);
      return false;
    }

    // Kind-specific enable gates
    if (candidate.kind === 'profit_dip' && !params.profitDipEnabled) {
      finishBuy(mint, false);
      return false;
    }
    if (candidate.kind === 'stop_reentry' && !params.stopReentryEnabled) {
      finishBuy(mint, false);
      return false;
    }

    const label = formatTokenLabel(candidate.symbol, candidate.name, mint);
    const reason = conf.reason;

    console.log(
      `[monitor] 🔁 ${reason} — ${label} ` +
        `(${candidate.kind}` +
        (conf.reclaimPct != null
          ? `, reclaim +${conf.reclaimPct.toFixed(1)}%`
          : '') +
        (conf.dipPct != null ? `, dip ${conf.dipPct.toFixed(1)}%` : '') +
        `, ${conf.walletCount} wallets` +
        (conf.volumeChangePct != null
          ? `, vol ${conf.volumeChangePct >= 0 ? '+' : ''}${conf.volumeChangePct.toFixed(0)}%`
          : '') +
        `, size ×${conf.sizeMultiplier.toFixed(2)})`
    );

    const signal: TradeSignal = {
      mint,
      symbol: candidate.symbol,
      name: candidate.name,
      wallets: candidate.confirmationWallets,
      walletNames: candidate.confirmationWalletNames,
      isMigration: isRecentlyMigrated(mint),
      timestamp: Date.now(),
      sizeMultiplier: conf.sizeMultiplier,
    };

    if (!(await passesFilters(signal))) {
      console.log(`[reentry] Filters blocked re-entry for ${label}`);
      markReEntryAttempt(mint, `filters blocked: ${reason}`);
      finishBuy(mint, false);
      return false;
    }

    try {
      signal.sourceEntryMcUsd = await resolveSourceEntryMcUsd(mint);
    } catch {
      /* non-fatal */
    }

    onSignalHandler?.(signal);

    const sizing = resolveTradeSize(
      signal.isMigration ? 'migration' : 'normal',
      {
        riskScore: signal.antiRug?.riskScore,
        convictionScore: signal.convictionScore,
        sizeMultiplier: conf.sizeMultiplier,
      }
    );
    recordSignalSizing(signal, sizing, true);
    console.log(`[monitor] ${sizing.reason}`);

    const scalpFlag = resolveScalpBuyFlag(signal);
    const buyOpts: Parameters<typeof executeBuy>[2] = {
      sourceWallets: signal.wallets,
      sourceNames: signal.walletNames,
      name: candidate.name,
      solAmount: sizing.sizeSol,
      sizeReason: sizing.reason,
      strategyKind: signal.isMigration ? 'migration' : 'normal',
      sourceEntryMcUsd: signal.sourceEntryMcUsd,
      top10HoldPct: signal.metrics?.top10HoldPct ?? null,
      insiderPct:
        signal.antiRug?.insiderPct ?? signal.sniper?.insiderPct ?? null,
      convictionScore: signal.convictionScore,
      hmcSetup: signal.hmcSetup,
      hmcConfidence: signal.hmcConfidence,
      gateDecision: signal.gateDecision,
      ...scalpFlag,
      tokenAgeHours: (() => {
        const ev = getMigrationEvent(mint);
        if (ev?.detectedAt != null) {
          return Math.max(0, (Date.now() - ev.detectedAt) / 3_600_000);
        }
        return signal.tokenAgeHours ?? null;
      })(),
      antiRug: signal.antiRug
        ? {
            riskScore: signal.antiRug.riskScore,
            riskLevel: signal.antiRug.riskLevel,
            flags: signal.antiRug.flags,
            ok: signal.antiRug.ok,
          }
        : undefined,
    };

    const profileAssignment = assignTradeProfile(
      buildTradeProfileMatchContext(signal, {
        scalpMode: buyOpts.scalpMode,
        shortTermStrategyId: buyOpts.shortTermStrategyId,
        strategyKind: buyOpts.strategyKind,
      })
    );
    if (!profileAssignment.skipped) {
      Object.assign(buyOpts, stampFromAssignment(profileAssignment));
      buyOpts.tradeProfileScore = profileAssignment.score;
      buyOpts.tradeProfileReason = profileAssignment.reason;
      stampEntryStyleOnBuyOpts(buyOpts, signal);
      applyProfileExitRulesToBuyOpts(buyOpts, profileAssignment.exitRules);
      const sized = applyTradeProfileSizing(
        buyOpts.solAmount ?? sizing.sizeSol,
        profileAssignment.exitRules
      );
      buyOpts.solAmount = clampToMaxAllowedTradeSol(
        sized.sizeSol,
        sized.usedOverride ? 'profileOverride' : 'reentryProfileSize'
      );
      if (sized.sizeNote) {
        buyOpts.sizeReason =
          (buyOpts.sizeReason || sizing.reason) +
          ` · profile ${profileAssignment.name} ${sized.sizeNote}`;
      }
    }

    {
      const taGate = applyProfileTaPlaybookGate(
        buyOpts.tradeProfileId ||
          String(profileAssignment.profileId || 'default'),
        signal,
        buyOpts
      );
      if (taGate.skip) {
        finishBuy(mint, false);
        markReEntryAttempt(mint, taGate.reason);
        console.log(`[monitor] Re-entry skipped — ${taGate.reason}`);
        return false;
      }
    }

    const result = await executeBuy(mint, candidate.symbol, buyOpts);

    finishBuy(mint, result.success);
    if (result.success) {
      recordTradeExecuted();
      markReBought(mint, reason);
      console.log(
        `[monitor] Re-entry executed (${result.mode}): ${label} — ${reason}`
      );
      return true;
    }

    markReEntryAttempt(mint, result.error ?? 'buy failed');
    console.error(`[monitor] Re-entry failed: ${result.error}`);
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
    openCount: paperTrader.getOpenPositions().length,
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

/** Last reason from passesFilters / recordRejectedSignal (for scanner annotate). */
let lastFilterSkipReason: string | null = null;

/** Rolling skip-reason tallies for soak / module A/B tuning. */
const skipReasonCounts = new Map<string, number>();
const MAX_SKIP_REASON_KEYS = 40;

function bumpSkipReason(reason: string): void {
  const key = normalizeSkipReason(reason);
  skipReasonCounts.set(key, (skipReasonCounts.get(key) || 0) + 1);
  if (skipReasonCounts.size > MAX_SKIP_REASON_KEYS) {
    // Drop lowest-count keys when oversized
    const ranked = [...skipReasonCounts.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < ranked.length - MAX_SKIP_REASON_KEYS + 5; i++) {
      skipReasonCounts.delete(ranked[i][0]);
    }
  }
}

export function getSkipReasonCounts(): Array<{ reason: string; count: number }> {
  return [...skipReasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);
}

export function resetSkipReasonCounts(): void {
  skipReasonCounts.clear();
  lastFilterSkipReason = null;
}

/** Record a filter reject on the sizing panel so Signals tab isn't blank. */
let suppressRejectSideEffects = false;
function recordRejectedSignal(signal: TradeSignal, reason: string): void {
  lastFilterSkipReason = reason;
  // Cascade retries must not annotate/bump until the final passer fails
  if (suppressRejectSideEffects) return;
  bumpSkipReason(reason);
  logger.info('Trade', 'FILTER_SKIP', {
    mint: signal.mint.slice(0, 12),
    symbol: signal.symbol,
    reason,
    entrySource: signal.entrySource ?? null,
    profile: signal.candidateTradeProfileId ?? null,
  });
  const kind: 'migration' | 'normal' =
    signal.isMigration || signal.nearMigration || signal.earlyBuy
      ? 'migration'
      : 'normal';
  const preview = resolveTradeSize(kind, {
    riskScore: signal.antiRug?.riskScore,
    convictionScore: signal.convictionScore,
    sizeMultiplier: signal.sizeMultiplier,
  });
  preview.reason = reason;
  recordSignalSizing(signal, preview, false);
  // Annotate matching Recent Signals rows so skips are visible even when no open
  annotateActivityFeedByMint(signal.mint, {
    tradeStatus: 'skipped',
    skipReason: reason,
  });
}

function annotateActivityFeed(
  mint: string,
  signature: string,
  patch: Partial<WalletBuyEvent>
): void {
  for (const ev of activityFeed) {
    if (ev.mint === mint && ev.signature === signature) {
      Object.assign(ev, patch);
      return;
    }
  }
  for (const buys of recentBuys.values()) {
    for (const ev of buys) {
      if (ev.mint === mint && ev.signature === signature) {
        Object.assign(ev, patch);
        return;
      }
    }
  }
}

/** Annotate newest feed rows for a mint (filter rejects may not have this buy's sig). */
function annotateActivityFeedByMint(
  mint: string,
  patch: Partial<WalletBuyEvent>
): void {
  let patched = 0;
  for (const ev of activityFeed) {
    if (ev.mint !== mint) continue;
    if (ev.tradeStatus === 'taken') continue;
    Object.assign(ev, patch);
    patched += 1;
    if (patched >= 3) break;
  }
}

const metricsRefreshScheduled = new Set<string>();

/**
 * Re-fetch Dex/Birdeye metrics after a short delay so Recent Signals rows
 * painted with `?` get real liq/holders once indexers catch up.
 */
function scheduleSignalMetricsRefresh(mint: string, signature: string): void {
  const key = `${mint}:${signature}`;
  if (metricsRefreshScheduled.has(key)) return;
  metricsRefreshScheduled.add(key);
  const delayMs = 12_000;
  setTimeout(() => {
    void (async () => {
      try {
        clearTokenMetricsCache(mint);
        const metrics = await fetchTokenMetrics(mint, { force: true });
        const summary = summarizeTokenMetrics(metrics);
        let overviewHolders: number | null = null;
        let overviewLiq: number | null = null;
        let overviewVol: number | null = null;
        try {
          const overview = await getTokenOverview(mint);
          overviewHolders = overview.holder;
          overviewLiq = overview.liquidityUsd;
          overviewVol = overview.volume24hUsd;
        } catch {
          /* non-fatal */
        }
        if (summary.holderCountEstimate == null && overviewHolders != null) {
          summary.holderCountEstimate = overviewHolders;
        }
        if (
          (summary.liquidityUsd == null || summary.liquidityUsd <= 0) &&
          overviewLiq != null
        ) {
          summary.liquidityUsd = overviewLiq;
        }
        if (summary.volume24hUsd == null && overviewVol != null) {
          summary.volume24hUsd = overviewVol;
        }
        const hasData =
          summary.liquidityUsd != null ||
          summary.volume24hUsd != null ||
          summary.holderCountEstimate != null ||
          summary.top10HoldPct != null ||
          summary.devHoldPct != null;
        if (!hasData) return;
        annotateActivityFeed(mint, signature, { metrics: summary });
        // Also patch other recent rows for this mint
        for (const ev of activityFeed) {
          if (ev.mint !== mint) continue;
          if (!ev.metrics || ev.metrics.liquidityUsd == null) {
            ev.metrics = { ...summary };
          }
        }
      } catch {
        /* non-fatal */
      } finally {
        metricsRefreshScheduled.delete(key);
      }
    })();
  }, delayMs);
}

/** Resolve hung "waiting convergence" rows after the convergence window. */
function expireStaleWaitingSignals(now = Date.now()): void {
  const windowMs = config.convergenceWindowMs ?? 5 * 60 * 1000;
  for (const ev of activityFeed) {
    if (ev.tradeStatus !== 'waiting') continue;
    if (!ev.skipReason || !/waiting convergence/i.test(ev.skipReason)) continue;
    const age = now - (ev.detectedAt ?? ev.timestamp);
    if (age < windowMs) continue;
    ev.tradeStatus = 'skipped';
    ev.skipReason = (ev.skipReason || 'waiting convergence') + ' — timed out';
  }
}

export function getRecentSignals() {
  return recentSignals.slice(0, 30);
}

export { getScannerFeed, getScannerStatus };

/** Optional anti-rug reasons that early/migration soft-pass may ignore. */
function isSoftPassableEarlyReason(reason: string): boolean {
  const r = reason.toLowerCase();
  if (isNonBypassableSkipReason(reason)) return false;
  return (
    /mint authority/i.test(r) ||
    /honeypot.*no (buy|sell) quote/i.test(r) ||
    /no jupiter route/i.test(r) ||
    /high holder concentration/i.test(r) ||
    /dominant top holder/i.test(r) ||
    /high risk score/i.test(r) ||
    /high dev holdings/i.test(r) ||
    /sniper/i.test(r) ||
    /bundler/i.test(r) ||
    /insider\/rat/i.test(r) || // sensitivity sniper gate — hard insider floor is separate
    /estimated (tax|sell tax)/i.test(r) ||
    /liquidity not locked/i.test(r) ||
    /recent.*sell/i.test(r) ||
    /dev.*sell/i.test(r)
  );
}

/** Compact lane fight log for learning / soak (ring buffer). */
const LANE_DECISION_LOG_MAX = 200;
type LaneFightMarlSnap = {
  enabled: boolean;
  strength?: string;
  thoughts: string[];
};
const laneDecisionLog: Array<{
  at: number;
  mint: string;
  symbol: string;
  winnerId: string | null;
  opened?: boolean;
  cascadeSkipReason?: string;
  marl?: LaneFightMarlSnap;
  /** HMC Gatekeeper snapshot (Phase 1). */
  hmcGate?: {
    decision: 'allow' | 'block';
    severity: 'soft' | 'hard';
    reasonCodes: string[];
    plainLanguage: string;
    advisory?: boolean;
  };
  /** HMC Setup Classifier snapshot (Phase 2). */
  hmcClassifier?: {
    setup: string;
    confidence: number;
    reasonCodes: string[];
    plainLanguage: string;
    eligibleProfileIds: string[];
    blocked?: boolean;
  };
  lanes: Array<{
    id: string;
    name: string;
    passed: boolean;
    score: number;
    reason: string;
  }>;
}> = [];

function logLaneFightDecisions(
  signal: TradeSignal,
  lanes: TradeProfileLaneResult[],
  hmcGate?: {
    decision: 'allow' | 'block';
    severity: 'soft' | 'hard';
    reasonCodes: string[];
    plainLanguage: string;
    advisory?: boolean;
  },
  hmcClassifier?: {
    setup: string;
    confidence: number;
    reasonCodes: string[];
    plainLanguage: string;
    eligibleProfileIds: string[];
    preferredProfileIds?: string[];
    blocked?: boolean;
    softEligibility?: boolean;
  }
): void {
  const winner = pickWinningTradeProfileLane(lanes);
  let marl: LaneFightMarlSnap | undefined;
  try {
    const { buildMarlLaneFightThoughts } =
      require('./marlCoordinator') as typeof import('./marlCoordinator');
    const built = buildMarlLaneFightThoughts(
      lanes.map((l) => ({
        profileId: l.profileId,
        name: l.name,
        passed: l.passed,
        score: l.score,
      }))
    );
    if (built.enabled && built.thoughts.length) {
      marl = {
        enabled: true,
        strength: built.strength,
        thoughts: built.thoughts,
      };
    }
  } catch {
    /* optional */
  }
  const entry = {
    at: Date.now(),
    mint: signal.mint,
    symbol: signal.symbol,
    winnerId: winner?.profileId ?? null,
    marl,
    hmcGate,
    hmcClassifier,
    lanes: lanes.map((l) => ({
      id: l.profileId,
      name: l.name,
      passed: l.passed,
      score: l.score,
      reason: l.passed ? l.reason : l.failReason || l.reason,
    })),
  };
  laneDecisionLog.unshift(entry);
  if (laneDecisionLog.length > LANE_DECISION_LOG_MAX) {
    laneDecisionLog.length = LANE_DECISION_LOG_MAX;
  }
  try {
    const { recordLaneFightOpen } = require('./laneOutcomes') as typeof import('./laneOutcomes');
    recordLaneFightOpen({
      mint: entry.mint,
      symbol: entry.symbol,
      winnerId: entry.winnerId,
      lanes: entry.lanes,
      marl: entry.marl,
      hmcGate: entry.hmcGate,
      hmcClassifier: entry.hmcClassifier,
    });
  } catch {
    /* non-fatal */
  }
  try {
    const { maybeZionFightLogComment } =
      require('./zionFightLog') as typeof import('./zionFightLog');
    maybeZionFightLogComment({
      mint: entry.mint,
      event: 'open',
      winnerId: entry.winnerId,
      hmcGateSummary: entry.hmcGate?.plainLanguage,
      hmcClassifierSummary: entry.hmcClassifier?.plainLanguage,
    });
  } catch {
    /* optional */
  }
}

/** Record a Gatekeeper-only skip row (pre-lane-fight block). */
function logGatekeeperBlock(
  signal: TradeSignal,
  hmcGate: {
    decision: 'allow' | 'block';
    severity: 'soft' | 'hard';
    reasonCodes: string[];
    plainLanguage: string;
    advisory?: boolean;
  }
): void {
  const entry = {
    at: Date.now(),
    mint: signal.mint,
    symbol: signal.symbol,
    winnerId: null as string | null,
    opened: false,
    cascadeSkipReason: hmcGate.plainLanguage.slice(0, 280),
    hmcGate,
    lanes: [] as Array<{
      id: string;
      name: string;
      passed: boolean;
      score: number;
      reason: string;
    }>,
  };
  laneDecisionLog.unshift(entry);
  if (laneDecisionLog.length > LANE_DECISION_LOG_MAX) {
    laneDecisionLog.length = LANE_DECISION_LOG_MAX;
  }
  try {
    const { recordLaneFightOpen } =
      require('./laneOutcomes') as typeof import('./laneOutcomes');
    recordLaneFightOpen({
      mint: entry.mint,
      symbol: entry.symbol,
      winnerId: null,
      lanes: [],
      hmcGate: entry.hmcGate,
    });
  } catch {
    /* non-fatal */
  }
  markLaneFightCascadeResult(signal.mint, false, hmcGate.plainLanguage);
}

/** Record a Classifier-only skip row (unknown blocked / no eligibles). */
function logClassifierBlock(
  signal: TradeSignal,
  hmcClassifier: {
    setup: string;
    confidence: number;
    reasonCodes: string[];
    plainLanguage: string;
    eligibleProfileIds: string[];
    blocked?: boolean;
  },
  hmcGate?: {
    decision: 'allow' | 'block';
    severity: 'soft' | 'hard';
    reasonCodes: string[];
    plainLanguage: string;
    advisory?: boolean;
  }
): void {
  const entry = {
    at: Date.now(),
    mint: signal.mint,
    symbol: signal.symbol,
    winnerId: null as string | null,
    opened: false,
    cascadeSkipReason: hmcClassifier.plainLanguage.slice(0, 280),
    hmcGate,
    hmcClassifier,
    lanes: [] as Array<{
      id: string;
      name: string;
      passed: boolean;
      score: number;
      reason: string;
    }>,
  };
  laneDecisionLog.unshift(entry);
  if (laneDecisionLog.length > LANE_DECISION_LOG_MAX) {
    laneDecisionLog.length = LANE_DECISION_LOG_MAX;
  }
  try {
    const { recordLaneFightOpen } =
      require('./laneOutcomes') as typeof import('./laneOutcomes');
    recordLaneFightOpen({
      mint: entry.mint,
      symbol: entry.symbol,
      winnerId: null,
      lanes: [],
      hmcGate,
      hmcClassifier,
    });
  } catch {
    /* non-fatal */
  }
  markLaneFightCascadeResult(signal.mint, false, hmcClassifier.plainLanguage);
}

/** Append a MARL thought to the latest fight row for this mint (size / low-MC). */
export function appendMarlThoughtToLaneFight(
  mint: string,
  line: string
): void {
  const text = String(line || '').trim().slice(0, 200);
  if (!mint || !text) return;
  const hit = laneDecisionLog.find((e) => e.mint === mint);
  if (!hit) return;
  if (!hit.marl) {
    hit.marl = { enabled: true, thoughts: [] };
  }
  hit.marl.enabled = true;
  if (!hit.marl.thoughts.includes(text)) {
    hit.marl.thoughts.push(text);
    if (hit.marl.thoughts.length > 10) {
      hit.marl.thoughts = hit.marl.thoughts.slice(-10);
    }
  }
  try {
    const { appendLaneFightMarlThought } =
      require('./laneOutcomes') as typeof import('./laneOutcomes');
    appendLaneFightMarlThought({ mint, thought: text });
  } catch {
    /* optional */
  }
}

/** Append a Zion fight-log comment to the latest in-memory row for this mint. */
export function appendZionThoughtToLaneFight(
  mint: string,
  line: string
): void {
  const text = String(line || '').trim().slice(0, 200);
  if (!mint || !text) return;
  const prefixed = /^Zion:\s/i.test(text) ? text : `Zion: ${text}`;
  const hit = laneDecisionLog.find((e) => e.mint === mint);
  if (!hit) return;
  if (!hit.marl) {
    hit.marl = { enabled: true, thoughts: [] };
  }
  hit.marl.enabled = true;
  if (!hit.marl.thoughts.includes(prefixed)) {
    hit.marl.thoughts.push(prefixed);
    if (hit.marl.thoughts.length > 12) {
      hit.marl.thoughts = hit.marl.thoughts.slice(-12);
    }
  }
  try {
    const { appendLaneFightZionThought } =
      require('./laneOutcomes') as typeof import('./laneOutcomes');
    appendLaneFightZionThought({ mint, thought: prefixed });
  } catch {
    /* optional */
  }
}

/** Mark the latest in-memory + persisted lane fight with cascade buy/skip. */
function markLaneFightCascadeResult(
  mint: string,
  opened: boolean,
  cascadeSkipReason?: string
): void {
  const hit = laneDecisionLog.find((e) => e.mint === mint);
  if (hit) {
    hit.opened = opened;
    if (!opened && cascadeSkipReason) {
      hit.cascadeSkipReason = String(cascadeSkipReason).slice(0, 280);
    }
  }
  try {
    const { recordLaneFightCascadeResult } =
      require('./laneOutcomes') as typeof import('./laneOutcomes');
    recordLaneFightCascadeResult({ mint, opened, cascadeSkipReason });
  } catch {
    /* non-fatal */
  }
  try {
    const { maybeZionFightLogComment } =
      require('./zionFightLog') as typeof import('./zionFightLog');
    maybeZionFightLogComment({
      mint,
      event: opened ? 'cascade_open' : 'cascade_skip',
      hmcGateSummary: hit?.hmcGate?.plainLanguage || cascadeSkipReason,
      hmcClassifierSummary: hit?.hmcClassifier?.plainLanguage,
    });
  } catch {
    /* optional */
  }
}

export function getLaneDecisionLog(limit = 50): typeof laneDecisionLog {
  return laneDecisionLog.slice(0, Math.max(1, Math.min(200, limit)));
}

/**
 * Influencer Smart Mirror does not run full lane fight — still surface copy /
 * skip in Overview + Micro Bots lane fight log.
 */
export function logInfluencerMirrorLaneFight(input: {
  mint: string;
  symbol: string;
  opened: boolean;
  walletName: string;
  skipReason?: string;
  sizeSol?: number;
}): void {
  const mint = String(input.mint || '').trim();
  if (!mint) return;
  const symbol = String(input.symbol || mint.slice(0, 6));
  const name = String(input.walletName || 'influencer').slice(0, 48);
  const thought = input.opened
    ? `Influencer Mirror · copied ${name}` +
      (input.sizeSol != null && Number.isFinite(input.sizeSol)
        ? ` · ${Number(input.sizeSol).toFixed(3)} SOL`
        : '')
    : `Influencer Mirror · skip · ${name}: ${input.skipReason || 'not taken'}`;
  const entry = {
    at: Date.now(),
    mint,
    symbol,
    winnerId: input.opened ? ('smart_money_mirror' as string | null) : null,
    opened: input.opened,
    cascadeSkipReason: input.opened
      ? undefined
      : String(input.skipReason || 'mirror skip').slice(0, 280),
    marl: {
      enabled: true,
      thoughts: [thought.slice(0, 200)],
    },
    lanes: [
      {
        id: 'smart_money_mirror',
        name: 'Smart Money Mirror',
        passed: input.opened,
        score: input.opened ? 100 : 0,
        reason: input.opened
          ? `Influencer Mirror copy · ${name}`
          : String(input.skipReason || 'skipped').slice(0, 120),
      },
    ],
  };
  laneDecisionLog.unshift(entry);
  if (laneDecisionLog.length > LANE_DECISION_LOG_MAX) {
    laneDecisionLog.length = LANE_DECISION_LOG_MAX;
  }
  try {
    const { recordLaneFightOpen } =
      require('./laneOutcomes') as typeof import('./laneOutcomes');
    recordLaneFightOpen({
      mint: entry.mint,
      symbol: entry.symbol,
      winnerId: entry.winnerId,
      lanes: entry.lanes,
      marl: entry.marl,
    });
  } catch {
    /* non-fatal */
  }
  markLaneFightCascadeResult(
    mint,
    input.opened,
    input.opened ? undefined : input.skipReason
  );
}

async function passesFilters(signal: TradeSignal): Promise<boolean> {
  lastFilterSkipReason = null;
  ensureStrategyToggles();
  const { filters, strategy } = config;
  const signalKind =
    signal.isMigration || signal.nearMigration || signal.earlyBuy
      ? signal.isMigration
        ? 'migration'
        : signal.nearMigration
          ? 'near-migration'
          : 'early'
      : 'normal';

  if (isMarketScannerSignal(signal)) {
    // Use global toggle before cascade — profile-scoped isStrategyEnabled can
    // report OFF for lanes that omit ta_market_scanner and starve all scanner buys.
    if (!isStrategyEnabledGlobal('ta_market_scanner')) {
      logStrategyDecision(
        'ta_market_scanner',
        'skip',
        `${signal.symbol} — Market Scanner OFF`
      );
      recordRejectedSignal(signal, 'strategy:ta_market_scanner OFF');
      return false;
    }
  } else if (!isStrategyEnabled('smart_money_copy')) {
    logStrategyDecision(
      'smart_money_copy',
      'skip',
      `${signal.symbol} — Smart Money Copy OFF`
    );
    recordRejectedSignal(signal, 'strategy:smart_money_copy OFF');
    return false;
  }

  if (isRiskHalted()) {
    console.log(`[monitor] Signal rejected (${signalKind}) — risk halt active`);
    recordRejectedSignal(signal, 'risk halt');
    return false;
  }

  // Refresh risk limits (may auto-pause)
  paperTrader.evaluateAndMaybeHaltRisk();
  if (isRiskHalted() || paused) {
    console.log(
      `[monitor] Signal rejected (${signalKind}) — ${paused ? 'monitor paused' : 'risk halt'}`
    );
    recordRejectedSignal(signal, paused ? 'monitor paused' : 'risk halt');
    return false;
  }

  if (isDeniedCopyMint(signal.mint, config.solMint)) {
    console.log(
      `[monitor] Signal rejected (${signalKind}) — denied mint (stable/quote) ${signal.symbol}`
    );
    recordRejectedSignal(signal, 'denied stable/quote mint');
    return false;
  }

  const pumpFunGate = evaluateBuyPumpFunOnlyGate(signal.mint, {
    specialtyFeed: signal.specialtyFeed,
    candidateTradeProfileId: signal.candidateTradeProfileId,
    preferredProfileId: signal.candidateTradeProfileId,
  });
  if (pumpFunGate) {
    console.log(
      `[monitor] FILTER_SKIP kind=${signalKind} symbol=${signal.symbol} reason=${pumpFunGate}`
    );
    recordRejectedSignal(signal, pumpFunGate);
    return false;
  }
  if (
    !isPumpFunMintSuffix(signal.mint) &&
    (signal.specialtyFeed === 'jupiter' || signal.specialtyFeed === 'kolscan') &&
    (signal.candidateTradeProfileId === 'trend_rider' ||
      signal.candidateTradeProfileId === 'steady_compounder')
  ) {
    console.log(
      `[monitor] Specialty pump.fun-only bypass · ${signal.symbol} ` +
        `(${signal.candidateTradeProfileId}/${signal.specialtyFeed})`
    );
  }

  // Smart Bot Profiles ON: enrich → gatekeeper → classifier → lane fight → cascade
  // passers under each profile gate (CORE ∩ assigned modules). Smart Bot OFF:
  // legacy global modules only (gatekeeper / classifier still run when HMC enabled).
  let lanePassers: TradeProfileLaneResult[] | null = null;
  let lastHmcGate:
    | {
        decision: 'allow' | 'block';
        severity: 'soft' | 'hard';
        reasonCodes: string[];
        plainLanguage: string;
        advisory?: boolean;
      }
    | undefined;
  let lastHmcClassifier:
    | {
        setup: string;
        confidence: number;
        reasonCodes: string[];
        plainLanguage: string;
        eligibleProfileIds: string[];
        preferredProfileIds?: string[];
        blocked?: boolean;
        softEligibility?: boolean;
      }
    | undefined;
  let classifierEligibleIds: string[] | null = null;
  let classifierPreferredIds: string[] | null = null;
  let classifierSoftEligibility = false;
  {
    let gatekeeperActive = false;
    let classifierActive = false;
    try {
      const { isGatekeeperActive, isClassifierActive } =
        require('./hierarchicalCoordination') as typeof import('./hierarchicalCoordination');
      gatekeeperActive = isGatekeeperActive();
      classifierActive = isClassifierActive();
    } catch {
      gatekeeperActive = false;
      classifierActive = false;
    }

    if (isSmartBotProfilesEnabled() || gatekeeperActive || classifierActive) {
      await enrichSignalForLaneFight(signal);
    }

    if (gatekeeperActive) {
      try {
        const {
          evaluateGatekeeper,
          recordGatekeeperDecision,
        } =
          require('./hierarchicalCoordination') as typeof import('./hierarchicalCoordination');
        const profileHint = signal.candidateTradeProfileId || null;
        let hasOpen = false;
        try {
          hasOpen = paperTrader.hasOpenMint(signal.mint);
        } catch {
          hasOpen = false;
        }
        // Majors Dip-watch handoff: specialtyFeed / reason stamp from
        // majorsUniverse → dipSetupWatch. Missing stamp → normal Gatekeeper.
        const gkReasonBits = Array.isArray(signal.scannerReasons)
          ? signal.scannerReasons.join(' ')
          : '';
        const majorsStamp =
          signal.specialtyFeed === 'majors' ||
          /(^|\s)majors(?::\S+)?(\s|$)/i.test(gkReasonBits);
        const dipWatchHandoff =
          /dip-watch:triggered/i.test(gkReasonBits) ||
          (signal.candidateTradeProfileId === 'dip_buyer' &&
            /dip-watch/i.test(gkReasonBits));
        const majorsDipWatch = majorsStamp && dipWatchHandoff;
        const setupWatchSoftPass =
          /scalper-watch:triggered|dip-watch:triggered|grad-watch:triggered/i.test(
            gkReasonBits
          );
        const gk = evaluateGatekeeper({
          mint: signal.mint,
          symbol: signal.symbol,
          profileHint,
          metrics: signal.metrics
            ? {
                liquidityUsd: signal.metrics.liquidityUsd,
                volumeM5Usd: signal.metrics.volumeM5Usd,
                volumeH1Usd: signal.metrics.volumeH1Usd,
                marketCapUsd: signal.metrics.marketCapUsd,
                priceChangeH1Pct: signal.metrics.priceChangeH1Pct,
                priceChange24hPct: signal.metrics.priceChange24hPct,
              }
            : null,
          antiRug: signal.antiRug
            ? {
                ok: signal.antiRug.ok,
                riskLevel: signal.antiRug.riskLevel,
                riskScore: signal.antiRug.riskScore,
                honeypot: signal.antiRug.honeypot,
                skipReasons: signal.antiRug.skipReasons,
                flags: signal.antiRug.flags,
              }
            : null,
          alreadyTraded: tradedMints.has(signal.mint),
          hasOpenPosition: hasOpen,
          exhausted: false,
          candles: signal.candles || null,
          majorsDipWatch: majorsDipWatch || undefined,
          setupWatchSoftPass: setupWatchSoftPass || undefined,
        });
        lastHmcGate = gk;
        recordGatekeeperDecision({
          result: gk,
          mint: signal.mint,
          symbol: signal.symbol,
          profileHint,
        });
        signal.gateDecision = gk.decision;
        if (gk.decision === 'block') {
          const reason = gk.plainLanguage;
          logGatekeeperBlock(signal, gk);
          recordRejectedSignal(signal, reason);
          if (setupWatchSoftPass) {
            try {
              const { recordSetupWatchEvent } =
                require('./setupWatchEvents') as typeof import('./setupWatchEvents');
              const family = /scalper-watch/i.test(gkReasonBits)
                ? 'scalper'
                : /grad-watch/i.test(gkReasonBits)
                  ? 'grad'
                  : 'dip';
              recordSetupWatchEvent({
                kind: 'trigger_blocked_safety',
                family,
                mint: signal.mint,
                symbol: signal.symbol,
                profileId: profileHint,
                reason: `${gk.severity}: ${reason}`,
              });
            } catch {
              /* optional */
            }
          }
          console.log(
            `[monitor] FILTER_SKIP kind=${signalKind} symbol=${signal.symbol} ` +
              `reason=${reason}`
          );
          return false;
        }
      } catch (err) {
        console.warn(
          `[monitor] HMC Gatekeeper error (fail-open soft):`,
          err instanceof Error ? err.message : err
        );
      }
    }

    if (classifierActive) {
      try {
        const {
          classifySetup,
          recordClassifierDecision,
          getHierarchicalCoordinationConfig,
        } =
          require('./hierarchicalCoordination') as typeof import('./hierarchicalCoordination');
        const hmcClfCfg = getHierarchicalCoordinationConfig();
        classifierSoftEligibility = hmcClfCfg.classifierSoftEligibility !== false;
        const profileHint = signal.candidateTradeProfileId || null;
        const clf = classifySetup({
          mint: signal.mint,
          symbol: signal.symbol,
          profileHint,
          metrics: signal.metrics
            ? {
                liquidityUsd: signal.metrics.liquidityUsd,
                volumeM5Usd: signal.metrics.volumeM5Usd,
                volumeH1Usd: signal.metrics.volumeH1Usd,
                marketCapUsd: signal.metrics.marketCapUsd,
                priceChangeH1Pct: signal.metrics.priceChangeH1Pct,
                priceChange24hPct: signal.metrics.priceChange24hPct,
              }
            : null,
          antiRug: signal.antiRug
            ? {
                ok: signal.antiRug.ok,
                riskLevel: signal.antiRug.riskLevel,
                riskScore: signal.antiRug.riskScore,
                honeypot: signal.antiRug.honeypot,
                skipReasons: signal.antiRug.skipReasons,
                flags: signal.antiRug.flags,
              }
            : null,
          candles: signal.candles || null,
          isMigration: signal.isMigration === true,
          nearMigration: signal.nearMigration === true,
          earlyBuy: signal.earlyBuy === true,
          entrySource: signal.entrySource || null,
          tokenAgeHours: signal.tokenAgeHours ?? null,
          dropFromPeakPct: signal.dropFromPeakPct ?? null,
          localPullbackPct: signal.localPullbackPct ?? null,
          nearSupport: signal.nearSupport === true,
          scannerReasons: signal.scannerReasons || null,
        });
        if (!clf.inactive) {
          lastHmcClassifier = {
            setup: clf.setup,
            confidence: clf.confidence,
            reasonCodes: clf.reasonCodes,
            plainLanguage: clf.plainLanguage,
            eligibleProfileIds: clf.eligibleProfileIds,
            preferredProfileIds: clf.preferredProfileIds,
            blocked: clf.blocked,
            softEligibility: classifierSoftEligibility,
          };
          signal.hmcSetup = clf.setup;
          signal.hmcConfidence = clf.confidence;
          recordClassifierDecision({
            result: clf,
            mint: signal.mint,
            symbol: signal.symbol,
            profileHint,
          });
          if (clf.blocked) {
            const reasonBitsClf = Array.isArray(signal.scannerReasons)
              ? signal.scannerReasons.join(' ')
              : '';
            const setupWatchHandoffClf =
              /scalper-watch:triggered|dip-watch:triggered|grad-watch:triggered/i.test(
                reasonBitsClf
              );
            // Pre-vetted armed watches: classifier hard-block becomes soft advisory
            if (setupWatchHandoffClf) {
              console.log(
                `[monitor] setup-watch classifier soft-pass ${signal.symbol}: ${clf.plainLanguage}`
              );
              classifierEligibleIds = clf.eligibleProfileIds;
              classifierPreferredIds =
                clf.preferredProfileIds?.length
                  ? clf.preferredProfileIds
                  : signal.candidateTradeProfileId
                    ? [signal.candidateTradeProfileId]
                    : clf.preferredProfileIds;
            } else {
              const reason = clf.plainLanguage;
              logClassifierBlock(signal, lastHmcClassifier, lastHmcGate);
              recordRejectedSignal(signal, reason);
              console.log(
                `[monitor] FILTER_SKIP kind=${signalKind} symbol=${signal.symbol} ` +
                  `reason=${reason}`
              );
              return false;
            }
          } else {
            classifierEligibleIds = clf.eligibleProfileIds;
            classifierPreferredIds = clf.preferredProfileIds;
          }
        }
      } catch (err) {
        console.warn(
          `[monitor] HMC Classifier error (fail-open soft):`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  if (isSmartBotProfilesEnabled()) {
    const ctx = buildTradeProfileMatchContext(signal);
    if (lastHmcClassifier?.setup) {
      ctx.hmcSetup = lastHmcClassifier.setup;
    }
    const reasonBitsLane = (signal.scannerReasons || []).join(' ');
    const setupWatchPrefer =
      (/scalper-watch:triggered|dip-watch:triggered|grad-watch:triggered/i.test(
        reasonBitsLane
      ) ||
        signal.armedWatch === true) &&
      signal.candidateTradeProfileId;
    // Armed watch: hard-lock to stamped preferred profile (no silent reassignment).
    // Admission Baseline v235: fail-open to soft lane fight if preferred fails floors.
    if (setupWatchPrefer && signal.candidateTradeProfileId) {
      const prefId = signal.candidateTradeProfileId;
      const flags = getTradeProfileEnabledFlags();
      if (flags[prefId] === false) {
        const reason = `Armed watch preferred profile OFF (${prefId})`;
        recordRejectedSignal(signal, reason);
        console.log(
          `[monitor] FILTER_SKIP kind=${signalKind} symbol=${signal.symbol} ` +
            `reason=${reason}`
        );
        return false;
      }
      const lanes = evaluateTradeProfileLanes(ctx, {
        silent: false,
        eligibleProfileIds: [prefId],
        preferredProfileIds: [prefId],
        softEligibility: true,
      });
      logLaneFightDecisions(signal, lanes, lastHmcGate, lastHmcClassifier);
      lanePassers = lanes.filter((l) => l.passed && l.assignment);
      if (!lanePassers.length) {
        let v235FailOpen = false;
        try {
          const { isAdmissionBaselineV235 } =
            require('./expectancyLift') as typeof import('./expectancyLift');
          v235FailOpen = isAdmissionBaselineV235();
        } catch {
          v235FailOpen = false;
        }
        if (v235FailOpen) {
          console.log(
            `[monitor] armed hard-lock fail-open (baseline v235) ${signal.symbol}: ` +
              `preferred ${prefId} failed floors — soft lane fight`
          );
          const softLanes = evaluateTradeProfileLanes(ctx, {
            silent: false,
            eligibleProfileIds: null,
            preferredProfileIds: [prefId],
            softEligibility: true,
          });
          logLaneFightDecisions(
            signal,
            softLanes,
            lastHmcGate,
            lastHmcClassifier
          );
          lanePassers = softLanes.filter((l) => l.passed && l.assignment);
          if (!lanePassers.length) {
            const intended =
              softLanes.find((l) => l.profileId === prefId) ||
              softLanes.find((l) => !l.passed) ||
              lanes.find((l) => l.profileId === prefId) ||
              lanes.find((l) => !l.passed);
            const reason =
              intended != null
                ? `${intended.name}: ${intended.failReason || 'no match'}`
                : `Armed watch preferred profile failed floors (${prefId})`;
            recordRejectedSignal(signal, reason);
            console.log(
              `[monitor] FILTER_SKIP kind=${signalKind} symbol=${signal.symbol} ` +
                `reason=smart-bot lane fight: ${reason}`
            );
            return false;
          }
        } else {
          const intended =
            lanes.find((l) => l.profileId === prefId) ||
            lanes.find((l) => !l.passed);
          const reason =
            intended != null
              ? `${intended.name}: ${intended.failReason || 'no match'}`
              : `Armed watch preferred profile failed floors (${prefId})`;
          recordRejectedSignal(signal, reason);
          console.log(
            `[monitor] FILTER_SKIP kind=${signalKind} symbol=${signal.symbol} ` +
              `reason=smart-bot lane fight: ${reason}`
          );
          return false;
        }
      }
    } else {
      const softLaneMode =
        classifierSoftEligibility &&
        classifierPreferredIds != null &&
        classifierPreferredIds.length > 0;
      const preferIds = classifierPreferredIds;
      const lanes = evaluateTradeProfileLanes(ctx, {
        silent: false,
        eligibleProfileIds: softLaneMode ? null : classifierEligibleIds,
        preferredProfileIds: softLaneMode ? preferIds : null,
        softEligibility: softLaneMode,
      });
      logLaneFightDecisions(signal, lanes, lastHmcGate, lastHmcClassifier);
      lanePassers = lanes.filter((l) => l.passed && l.assignment);
      if (!lanePassers.length) {
        // Prefer top intended / first clear failer — avoid Migration+Dip concat noise
        const preferId =
          (preferIds && preferIds[0]) ||
          signal.candidateTradeProfileId ||
          null;
        const intended =
          (preferId
            ? lanes.find((l) => l.profileId === preferId)
            : null) ||
          lanes.find((l) => !l.passed && l.failReason) ||
          lanes[0];
        const reason =
          intended != null
            ? `${intended.name}: ${intended.failReason || 'no match'}`
            : 'No trade profile lane passed floors/match';
        recordRejectedSignal(signal, reason);
        console.log(
          `[monitor] FILTER_SKIP kind=${signalKind} symbol=${signal.symbol} ` +
            `reason=smart-bot lane fight: ${reason}`
        );
        return false;
      }
    }
    console.log(
      `[monitor] Smart Bot lane passers=${lanePassers.map((l) => `${l.name}:${l.score}`).join(', ')} ` +
        `· top=${lanePassers[0]!.name} (${lanePassers[0]!.profileId}) · ${signal.symbol}`
    );
    // Expectancy Lift Layer — evaluate per passer so a restricted top does not
    // kill the whole fight (late-chase share ceiling stays hard for late admits).
    // Admission Baseline v235: observe-only (metrics/status still run; no admit skips).
    try {
      const {
        shouldSkipFamilyGovernor,
        shouldLimitLateChaseShare,
        shouldLimitDiscretionaryMix,
        shouldBlockOtherProfileDiscretionary,
        computeTradePermissionScore,
        shouldSoftSkipPermissionScore,
        classifyTradeFamily,
        admitFamilyForGovernor,
        mintOneSetupProfileLock,
        syncOneSetupLocksFromWatches,
        isAdmissionBaselineV235,
      } = require('./expectancyLift') as typeof import('./expectancyLift');
      syncOneSetupLocksFromWatches();
      const baselineV235 = isAdmissionBaselineV235();
      const armedWatch =
        signal.armedWatch === true ||
        /scalper-watch:triggered|dip-watch:triggered|grad-watch:triggered/i.test(
          reasonBitsLane
        );
      const entryStyle = String(
        signal.entryStyleHint || ctx.detectedEntryStyle || ''
      );
      const lateChase = ctx.lateChase === true || entryStyle === 'late_chase';
      const ext =
        (signal as { extensionFromLevelPct?: number }).extensionFromLevelPct ??
        (ctx as { extensionFromLevelPct?: number }).extensionFromLevelPct ??
        null;
      const govFails: string[] = [];
      const admitted: typeof lanePassers = [];
      for (const passer of lanePassers) {
        const family = admitFamilyForGovernor({
          entryStyle,
          lateChase,
          profileId: passer.profileId,
          armedWatch,
          entryPath: armedWatch ? 'armed_trigger' : 'discretionary',
          setupWatchFamily: signal.setupWatchFamily,
        });
        const passerLate = family === 'late_chase';
        if (!baselineV235) {
          const lateLim = shouldLimitLateChaseShare({
            lateChase: passerLate,
            family,
            entryStyle: passerLate ? 'late_chase' : entryStyle,
            armedWatch,
            extensionFromLevelPct: ext,
          });
          if (lateLim.limit) {
            govFails.push(
              `${passer.name}: ${lateLim.reason || 'Late-chase share ceiling'}`
            );
            console.log(
              `[monitor] expectancy skip passer=${passer.name}: ${lateLim.reason}`
            );
            continue;
          }
        }
        const gov = shouldSkipFamilyGovernor({
          family,
          entryStyle: passerLate ? 'late_chase' : entryStyle,
          lateChase: passerLate,
          armedWatch,
          profileId: passer.profileId,
          entryPath: armedWatch ? 'armed_trigger' : 'discretionary',
          setupWatchFamily: signal.setupWatchFamily,
        });
        if (!baselineV235 && gov.softPassNative) {
          console.log(
            `[monitor] ${gov.reason || `governor:restricted soft-pass native ${passer.profileId}`}`
          );
        }
        if (!baselineV235 && gov.skip) {
          govFails.push(
            `${passer.name}: ${gov.reason || 'Family governor restrict'}`
          );
          console.log(
            `[monitor] expectancy skip passer=${passer.name}: ${gov.reason}`
          );
          continue;
        }
        if (!baselineV235) {
          const discMix = shouldLimitDiscretionaryMix({
            armedWatch,
            profileId: passer.profileId,
          });
          if (discMix.limit) {
            govFails.push(
              `${passer.name}: ${discMix.reason || 'Armed mix 70/30'}`
            );
            console.log(
              `[monitor] expectancy skip passer=${passer.name}: ${discMix.reason}`
            );
            continue;
          }
          const lock = shouldBlockOtherProfileDiscretionary({
            mint: signal.mint,
            profileId: passer.profileId,
            armedWatch,
          });
          if (lock.block) {
            govFails.push(
              `${passer.name}: ${lock.reason || 'One-setup-one-profile'}`
            );
            console.log(
              `[monitor] expectancy skip passer=${passer.name}: ${lock.reason}`
            );
            continue;
          }
        }
        const perm = computeTradePermissionScore({
          armedWatch,
          triggerConfirm:
            /scalper-watch:triggered|dip-watch:triggered|grad-watch:triggered/i.test(
              reasonBitsLane
            ),
          family: gov.family || family,
          entryStyle,
          lateChase,
          extensionFromLevelPct: ext,
          dnaMatch:
            ctx.detectedEntryStyle != null
              ? classifyTradeFamily({
                  entryStyle: ctx.detectedEntryStyle,
                  profileId: passer.profileId,
                  armedWatch,
                }) === (gov.family || family) ||
                String(ctx.detectedEntryStyle) === entryStyle
              : null,
          profileId: passer.profileId,
          tradeProfileScore: passer.score,
        });
        if (!baselineV235) {
          const softPerm = shouldSoftSkipPermissionScore(perm, armedWatch);
          if (softPerm.skip) {
            govFails.push(
              `${passer.name}: ${softPerm.reason || 'Permission score'}`
            );
            console.log(
              `[monitor] expectancy skip passer=${passer.name}: ${softPerm.reason}`
            );
            continue;
          }
        }
        // First admitted passer stamps permission / one-setup lock for cascade
        if (!admitted.length) {
          (signal as { tradePermissionScore?: number }).tradePermissionScore =
            perm;
          (signal as { governorInfluenced?: boolean }).governorInfluenced =
            !baselineV235 && (gov.state !== 'neutral' || perm < 55);
          if (armedWatch && signal.mint) {
            mintOneSetupProfileLock(
              signal.mint,
              String(
                passer.profileId || signal.candidateTradeProfileId || 'scalper'
              )
            );
          }
        }
        admitted.push(passer);
      }
      if (!admitted.length) {
        const why =
          govFails[0] || 'Expectancy governor blocked all lane passers';
        recordRejectedSignal(signal, why);
        markLaneFightCascadeResult(signal.mint, false, why);
        console.log(
          `[monitor] FILTER_SKIP kind=${signalKind} symbol=${signal.symbol} ` +
            `reason=expectancy: ${why}`
        );
        return false;
      }
      if (govFails.length) {
        console.log(
          `[monitor] expectancy continued past skipped passers · ${signal.symbol}: ` +
            govFails.slice(0, 3).join(' · ')
        );
      }
      lanePassers = admitted;
    } catch {
      /* optional — fail soft */
    }
    const top = lanePassers[0]!;
    // Scalper attention share throttle — per passer (armed reclaim bypasses)
    try {
      const {
        shouldThrottleScalperAdmit,
        shouldLimitScalperConcurrent,
        getProfileAttentionShare,
      } = require('./profileAttention') as typeof import('./profileAttention');
      const att = getProfileAttentionShare();
      console.log(
        `[monitor] attentionShare scalper=${(att.shares.scalper * 100).toFixed(0)}% ` +
          `dip=${(att.shares.dip * 100).toFixed(0)}% trend=${(att.shares.trend * 100).toFixed(0)}% ` +
          `mig=${(att.shares.migration * 100).toFixed(0)}%` +
          (att.scalperWinRatePct != null
            ? ` · scalperWR=${att.scalperWinRatePct.toFixed(0)}%`
            : '')
      );
      const armedForAttention =
        signal.armedWatch === true ||
        /scalper-watch:triggered|dip-watch:triggered|grad-watch:triggered/i.test(
          reasonBitsLane
        );
      const attFails: string[] = [];
      const attAdmitted: typeof lanePassers = [];
      for (const passer of lanePassers) {
        const conc = shouldLimitScalperConcurrent({
          profileId: passer.profileId,
          armedWatch: armedForAttention,
          scannerReasons: signal.scannerReasons,
        });
        if (conc.limit) {
          attFails.push(
            `${passer.name}: ${conc.reason || 'Scalper concurrent cap'}`
          );
          continue;
        }
        const th = shouldThrottleScalperAdmit({
          profileId: passer.profileId,
          armedWatch: armedForAttention,
          scannerReasons: signal.scannerReasons,
        });
        if (th.throttle) {
          attFails.push(
            `${passer.name}: ${th.reason || 'Scalper attention throttle'}`
          );
          continue;
        }
        attAdmitted.push(passer);
      }
      if (!attAdmitted.length) {
        const why = attFails[0] || 'Scalper attention blocked all lane passers';
        recordRejectedSignal(signal, why);
        markLaneFightCascadeResult(signal.mint, false, why);
        console.log(
          `[monitor] FILTER_SKIP kind=${signalKind} symbol=${signal.symbol} ` +
            `reason=attention: ${why}`
        );
        return false;
      }
      lanePassers = attAdmitted;
    } catch {
      /* optional */
    }
  }

  const runModuleFilters = async (): Promise<boolean> => {
  const reasonBitsEarly = (signal.scannerReasons || []).join(' ');
  const setupWatchHandoff =
    /grad-watch:triggered|dip-watch:triggered|scalper-watch:triggered/i.test(
      reasonBitsEarly
    ) ||
    (signal.candidateTradeProfileId === 'migration_sniper' &&
      /grad-watch/i.test(reasonBitsEarly)) ||
    (signal.candidateTradeProfileId === 'dip_buyer' &&
      /dip-watch/i.test(reasonBitsEarly)) ||
    ((signal.candidateTradeProfileId === 'scalper' ||
      signal.candidateTradeProfileId === 'momentum_burst' ||
      signal.candidateTradeProfileId === 'reversal_scalper') &&
      /scalper-watch/i.test(reasonBitsEarly));

  // Wallet quality gate — every source wallet must pass (or be unknown during grace)
  if (
    (isStrategyEnabled('wallet_quality_scoring') ||
      isStrategyEnabled('hard_quality_gate') ||
      isStrategyEnabled('elite_convergence') ||
      isStrategyEnabled('profit_protected')) &&
    config.filters.enableWalletQualityGate !== false
  ) {
    for (const addr of signal.wallets) {
      if (addr === 'volume-spike' || isMarketScannerAddress(addr)) continue;
      const w = config.smartWallets.find((sw) => sw.address === addr);
      if (!w) continue;
      const gate = passesWalletQualityGate(w);
      if (!gate.ok) {
        logStrategyDecision(
          'wallet_quality_scoring',
          'skip',
          `${signal.symbol} — ${gate.reason} wallet=${w.name}`
        );
        console.log(
          `[monitor] FILTER_SKIP kind=${signalKind} symbol=${signal.symbol} ` +
            `reason=${gate.reason} wallet=${w.name}`
        );
        recordRejectedSignal(signal, gate.reason || 'wallet quality');
        return false;
      }
    }
  }

  // Entry timing — age since earliest smart buy
  if (signal.signalAgeMinutes == null && signal.timestamp) {
    // Migration feed may lack cluster age — treat as fresh
    signal.signalAgeMinutes = 0;
  }
  if (
    isStrategyEnabled('time_based_entry') ||
    isStrategyEnabled('early_entry_only') ||
    isStrategyEnabled('elite_convergence')
  ) {
    const timingSkip = evaluateEntryTimingGate(signal.signalAgeMinutes);
    if (timingSkip) {
      // Post-run dip setups intentionally target older runs — allow past early age gate
      let dipBypass = false;
      if (isStrategyEnabled('post_run_dip')) {
        const dip = resolvePostRunDipForSignal({
          symbol: signal.symbol,
          mint: signal.mint,
          isMigration: signal.isMigration,
          nearMigration: signal.nearMigration,
          earlyBuy: signal.earlyBuy,
          wallets: signal.wallets,
          walletNames: signal.walletNames,
          dropFromPeakPct: signal.dropFromPeakPct,
          signalAgeMinutes: signal.signalAgeMinutes,
          tokenAgeHours: signal.tokenAgeHours,
          metrics: signal.metrics,
          birdeye: signal.birdeye,
          candles: signal.candles,
          nowMs: signal.timestamp,
        });
        dipBypass = dip?.report.qualifies === true;
        if (dipBypass) {
          console.log(
            `[monitor] post-run dip bypasses entry-age gate for ${signal.symbol}`
          );
          logStrategyDecision(
            'post_run_dip',
            'take',
            `${signal.symbol}: bypassed early age — ${dip?.report.detail}`
          );
        }
      }
      if (!dipBypass) {
        logStrategyDecision(
          isStrategyEnabled('early_entry_only')
            ? 'early_entry_only'
            : 'time_based_entry',
          'skip',
          `${signal.symbol} — ${timingSkip}`
        );
        console.log(
          `[monitor] FILTER_SKIP kind=${signalKind} symbol=${signal.symbol} reason=${timingSkip}`
        );
        recordRejectedSignal(signal, timingSkip);
        return false;
      }
    }
  }

  // Cluster floor (unified with selective min wallets + Strict overlay)
  // Market Scanner / hybrid: skip hard wallet-count floor (TA gated instead)
  const scannerSignal = isMarketScannerSignal(signal);
  const qualityModes = getQualityModeOverlays();
  const clusterMin =
    isStrategyEnabled('wallet_convergence') ||
    isStrategyEnabled('elite_convergence')
      ? effectiveClusterMinWallets()
      : 1;
  const priority =
    signal.isMigration || signal.nearMigration || signal.earlyBuy;
  const allowSingle =
    scannerSignal ||
    (!qualityModes.blockSingleWalletEntries &&
      ((signal.allowSingleWalletException &&
        signal.isMigration &&
        signal.wallets.length >= 1) ||
        (priority &&
          config.selective?.allowSingleWalletMigration !== false &&
          signal.wallets.length >= 1 &&
          clusterMin <= 2)));
  if (
    !scannerSignal &&
    (isStrategyEnabled('wallet_convergence') ||
      isStrategyEnabled('elite_convergence')) &&
    signal.wallets.length < clusterMin &&
    !allowSingle
  ) {
    let botPrefix = '';
    try {
      const { getActiveCascadeMatchFloors } =
        require('./tradeProfiles') as typeof import('./tradeProfiles');
      const floors = getActiveCascadeMatchFloors();
      if (floors.profileOwned && floors.profileName) {
        botPrefix = `${floors.profileName}: `;
      }
    } catch {
      /* ignore */
    }
    const msg = isStrategyEnabled('elite_convergence')
      ? `${botPrefix}elite convergence need ${clusterMin} wallets (have ${signal.wallets.length})`
      : `${botPrefix}cluster need ${clusterMin} wallets (have ${signal.wallets.length})`;
    logStrategyDecision(
      isStrategyEnabled('elite_convergence')
        ? 'elite_convergence'
        : 'wallet_convergence',
      'skip',
      `${signal.symbol} — ${msg}`
    );
    console.log(
      `[monitor] FILTER_SKIP kind=${signalKind} symbol=${signal.symbol} reason=${msg}`
    );
    recordRejectedSignal(signal, msg);
    return false;
  }

  if (qualityModes.requireMigrationOrNear) {
    if (!signal.isMigration && !signal.nearMigration) {
      logStrategyDecision(
        'migration_sniper',
        'skip',
        `${signal.symbol} — Migration Sniper requires migration / near-migration`
      );
      console.log(
        `[monitor] FILTER_SKIP kind=${signalKind} symbol=${signal.symbol} reason=migration_sniper`
      );
      recordRejectedSignal(signal, 'migration sniper — not migration/near');
      return false;
    }
  }

  if (strategy.enableMigrationOnly && !signal.isMigration) {
    console.log(
      `[monitor] Signal rejected (${signalKind}) — migration-only enabled for ${signal.symbol}`
    );
    recordRejectedSignal(signal, 'migration-only mode');
    return false;
  }

  const openCount = paperTrader.getOpenPositions().length;
  let maxConcurrent = Math.max(1, Number(filters.maxConcurrentPositions) || 1);
  try {
    const { learningModeAdjustedMaxConcurrent } =
      require('./learningMode') as typeof import('./learningMode');
    maxConcurrent = learningModeAdjustedMaxConcurrent(maxConcurrent);
  } catch {
    /* ignore */
  }
  if (openCount >= maxConcurrent) {
    console.log(
      `[monitor] Signal rejected (${signalKind}) — max concurrent positions (${maxConcurrent})`
    );
    recordRejectedSignal(signal, `max positions (${maxConcurrent})`);
    return false;
  }

  if (paperTrader.hasOpenMint(signal.mint)) {
    console.log(
      `[monitor] Signal rejected (${signalKind}) — already holding ${signal.symbol || signal.mint.slice(0, 8)}`
    );
    recordRejectedSignal(signal, 'already holding');
    return false;
  }

  const dailyPnl = paperTrader.getDailyPnlSol();
  const dailyLimit = Number(filters.dailyLossLimitSol) || 0;
  if (dailyLimit > 0 && dailyPnl <= -dailyLimit) {
    console.log(
      `[monitor] Signal rejected (${signalKind}) — daily loss limit hit (${dailyPnl.toFixed(4)} SOL)`
    );
    recordRejectedSignal(signal, 'daily loss limit');
    return false;
  }

  if (filters.minWinRate > 0) {
    const winRate = paperTrader.getWinRatePct();
    if (winRate < filters.minWinRate) {
      console.log(
        `[monitor] Signal rejected (${signalKind}) — win rate ${winRate.toFixed(1)}% < ${filters.minWinRate}%`
      );
      recordRejectedSignal(signal, `win rate ${winRate.toFixed(0)}%`);
      return false;
    }
  }

  // On-chain / Dex metrics + comprehensive anti-rug
  // Risk OFF: skip soft anti-rug / metrics hard gates — but still enforce
  // Top-10% min/max when configured (>0). Soak zeros both so this is a no-op.
  if (config.riskLevel === 'off') {
    const minTop10Cfg = Number(filters.minTop10HolderPct) || 0;
    const maxTop10Cfg = Number(filters.maxHolderConcentration) || 0;
    if (minTop10Cfg > 0 || maxTop10Cfg > 0) {
      try {
        const { resolveTop10HoldPctForEntry } = await import('./tokenMetrics');
        const top10HoldPct = await resolveTop10HoldPctForEntry(
          signal.mint,
          signal.metrics?.top10HoldPct
        );
        if (signal.metrics) signal.metrics.top10HoldPct = top10HoldPct;
        const holderGate = evaluateHolderConcentrationHardFloors({
          top10HoldPct,
          insiderPct: null,
        });
        if (holderGate.skipReasons.length > 0) {
          const reason = holderGate.skipReasons[0]!;
          console.log(
            `[monitor] FILTER_SKIP kind=${signalKind} symbol=${signal.symbol} ${reason}`
          );
          recordRejectedSignal(signal, reason);
          return false;
        }
      } catch (err) {
        console.warn(
          `[monitor] Top-10 holder gate failed for ${signal.mint.slice(0, 8)}…:`,
          err instanceof Error ? err.message : err
        );
        // Soft-pass — unknown top10 no longer fail-closed (align with hard floors).
        console.log(
          `[monitor] Top-10 soft-pass (${signalKind}) ${signal.symbol}: fetch failed, known-only enforce`
        );
      }
    }
  } else {
  const antiRugEnabled =
    isStrategyEnabled('anti_rug_honeypot') &&
    config.filters.enableAntiRug !== false;
  const needsMetrics =
    antiRugEnabled ||
    isStrategyEnabled('post_run_dip') ||
    isStrategyEnabled('technical_levels') ||
    (filters.minLiquidity ?? 0) > 0 ||
    (filters.maxDevHoldPct ?? 0) > 0 ||
    (filters.minDevHoldPct ?? 0) > 0 ||
    (filters.maxDevPercent ?? 0) > 0 ||
    (filters.maxTopHolderPct ?? 0) > 0 ||
    (filters.minTopHolderPct ?? 0) > 0 ||
    (filters.maxHolderConcentration ?? 0) > 0 ||
    (filters.minTop10HolderPct ?? 0) > 0 ||
    filters.skipIfMintAuthority;

  if (needsMetrics) {
    try {
      if (antiRugEnabled) {
        const earlyEntry =
          Boolean(signal.earlyBuy || signal.nearMigration) ||
          Boolean(signal.bondingCurve && !signal.isMigration) ||
          Boolean(signal.isMigration);
        const report: AntiRugReport = await evaluateAntiRug(signal.mint, {
          earlyEntry,
          isMigrated: Boolean(signal.isMigration),
          organicScore: signal.organicScore,
        });
        signal.antiRug = summarizeAntiRug(report);
        signal.metrics = report.metricsSummary;
        if (report.sniper) signal.sniper = report.sniper;
        if (report.birdeye) signal.birdeye = report.birdeye;
        if (!report.ok) {
          const softEarly =
            earlyEntry ||
            Boolean(signal.isMigration) ||
            Boolean(signal.nearMigration) ||
            Boolean(signal.earlyBuy);
          const hardReasons = report.skipReasons.filter((reason) => {
            if (isNonBypassableSkipReason(reason)) return true;
            if (!softEarly) return true;
            // Early/migration: ignore optional gates; keep honeypot/rug floors.
            return !isSoftPassableEarlyReason(reason);
          });
          if (hardReasons.length === 0) {
            console.log(
              `[monitor] Anti-rug soft-pass (${signalKind}) ${signal.symbol}: ` +
                `ignored optional [${report.skipReasons.join('; ') || 'soft flags'}] ` +
                `(score ${report.riskScore})`
            );
            paperTrader.addLog(
              'info',
              `Anti-rug soft-pass ${signal.symbol} (${signalKind}): ${report.skipReasons.join('; ') || 'soft flags'}`,
              { mint: signal.mint, symbol: signal.symbol }
            );
          } else {
            console.log(formatAntiRugSkipLog(signal.symbol, report));
            console.log(
              `[monitor] FILTER_SKIP kind=${signalKind} symbol=${signal.symbol} ` +
                `hard=[${hardReasons.join(' | ')}] ` +
                `all=[${report.skipReasons.join(' | ')}] score=${report.riskScore}`
            );
            for (const reason of hardReasons) {
              console.log(`[monitor] ${reason}`);
            }
            paperTrader.addLog(
              'info',
              `Anti-rug skip ${signal.symbol} (${signalKind}): ${hardReasons.join('; ') || 'high risk'} (score ${report.riskScore})`,
              { mint: signal.mint, symbol: signal.symbol }
            );
            recordRejectedSignal(
              signal,
              `anti-rug: ${hardReasons[0] || 'high risk'} (score ${report.riskScore})`
            );
            return false;
          }
        }
        console.log(
          `[anti-rug] OK ${signal.symbol}: score=${report.riskScore} (${report.riskLevel}) ` +
            `mc=$${report.checks.marketCapUsd != null ? Math.round(report.checks.marketCapUsd) : '?'} ` +
            `liq=$${report.checks.liquidityUsd?.toFixed(0) ?? '?'} ` +
            `dev=${report.checks.devHoldPct?.toFixed(1) ?? '?'}% ` +
            `top10=${report.checks.top10HoldPct?.toFixed(1) ?? '?'}% ` +
            `lp=${report.checks.liquidityLockedOrBurned == null ? '?' : report.checks.liquidityLockedOrBurned ? 'locked' : 'unlocked'} ` +
            `sources=${report.sources.join('+')}`
        );

        // Steady Compounder / High Win-Rate: fail-closed on unknown insider/top10
        // and reject near-zero pro-trader hold when GMGN reports it.
        const qualityLaneId =
          lanePassers && lanePassers[0] ? lanePassers[0].profileId : null;
        if (
          qualityLaneId === 'steady_compounder' ||
          qualityLaneId === 'high_win_rate'
        ) {
          const qualityGate = evaluateHolderConcentrationHardFloors({
            top10HoldPct: report.checks.top10HoldPct,
            insiderPct: report.checks.insiderPct,
            devHoldPct: report.checks.devHoldPct,
            failClosedUnknown: true,
            proTraderPct: report.sniper?.proTraderPct ?? null,
            minProTraderPct: 0.05,
          });
          if (qualityGate.skipReasons.length > 0) {
            const reason = qualityGate.skipReasons[0]!;
            console.log(
              `[monitor] FILTER_SKIP kind=${signalKind} symbol=${signal.symbol} ` +
                `quality=${qualityLaneId} ${reason}`
            );
            paperTrader.addLog(
              'info',
              `Quality holder gate ${signal.symbol} (${qualityLaneId}): ${reason}`,
              { mint: signal.mint, symbol: signal.symbol }
            );
            recordRejectedSignal(signal, reason);
            return false;
          }
        }
      } else {
        // Legacy metrics-only path when anti-rug master switch is off
        const { evaluateTokenMetricsFilters } = await import('./tokenMetrics');
        const metrics = await fetchTokenMetrics(signal.mint);
        signal.metrics = summarizeTokenMetrics(metrics);
        const verdict = evaluateTokenMetricsFilters(metrics);
        if (!verdict.ok) {
          console.log(
            `[monitor] Signal rejected (${signalKind}) — token metrics for ${signal.symbol}: ` +
              verdict.reasons.join('; ')
          );
          recordRejectedSignal(
            signal,
            `metrics: ${verdict.reasons[0] || 'failed'}`
          );
          return false;
        }
      }
    } catch (err) {
      console.warn(
        `[monitor] Anti-rug / metrics fetch failed for ${signal.mint.slice(0, 8)}…:`,
        err instanceof Error ? err.message : err
      );
      const softEarly =
        Boolean(signal.earlyBuy || signal.nearMigration || signal.isMigration) ||
        Boolean(signal.bondingCurve && !signal.isMigration);
      if (softEarly && config.mode === 'paper') {
        console.log(
          `[monitor] Anti-rug soft-pass (${signalKind}) ${signal.symbol}: metrics unavailable on early/curve paper signal`
        );
        paperTrader.addLog(
          'info',
          `Anti-rug soft-pass ${signal.symbol}: metrics unavailable (early paper)`,
          { mint: signal.mint, symbol: signal.symbol }
        );
      } else if (
        antiRugEnabled ||
        (filters.minLiquidity ?? 0) > 0 ||
        (filters.maxDevPercent ?? filters.maxDevHoldPct ?? 0) > 0
      ) {
        console.log(
          `[monitor] FILTER_SKIP kind=${signalKind} reason=anti-rug / metrics unavailable`
        );
        recordRejectedSignal(signal, 'anti-rug / metrics unavailable');
        return false;
      }
    }
  }
  } // end riskLevel !== 'off'

  const rate = canExecuteTradeNow();
  if (!rate.ok) {
    console.log(`[monitor] FILTER_SKIP kind=${signalKind} reason=${rate.reason}`);
    paperTrader.addLog(
      'info',
      `Trade rate limit: ${rate.reason}`,
      { mint: signal.mint, symbol: signal.symbol }
    );
    recordRejectedSignal(signal, rate.reason || 'rate limit');
    return false;
  }

  // Derive token age for Post-Run Dip (pairCreatedAt from Dex metrics)
  if (signal.tokenAgeHours == null) {
    const created = Number(
      (signal.metrics as { pairCreatedAtMs?: number | null } | undefined)
        ?.pairCreatedAtMs
    );
    if (Number.isFinite(created) && created > 0) {
      signal.tokenAgeHours = Math.max(0, (Date.now() - created) / 3_600_000);
    }
  }

  const conviction = evaluateSignalConviction(signal);
  signal.convictionScore = conviction.score;
  signal.sizeMultiplier = conviction.sizeMultiplier;
  signal.convictionBreakdown = conviction.breakdownLine;
  if (
    (isStrategyEnabled('multi_factor_conviction') ||
      isStrategyEnabled('elite_convergence') ||
      isStrategyEnabled('profit_protected') ||
      isStrategyEnabled('social_sentiment_filter') ||
      isStrategyEnabled('volume_spike_filter') ||
      isStrategyEnabled('confirmation_layer') ||
      isStrategyEnabled('market_session_filter') ||
      isStrategyEnabled('post_run_dip') ||
      isStrategyEnabled('technical_levels') ||
      isStrategyEnabled('chart_patterns') ||
      isStrategyEnabled('pattern_volume_dryup_return') ||
      isStrategyEnabled('pattern_falling_wedge') ||
      isStrategyEnabled('pattern_structured_pullback') ||
      isStrategyEnabled('pattern_bull_flag') ||
      isStrategyEnabled('pattern_trend_continuation')) &&
    !conviction.pass
  ) {
    const detail = conviction.reasons.join('; ') || 'below threshold';
    const socialHit = conviction.reasons.some((r) => /social/i.test(r));
    const volSpikeHit = conviction.reasons.some((r) =>
      /volume spike/i.test(r)
    );
    const confirmHit = conviction.reasons.some((r) =>
      /confirmation/i.test(r)
    );
    const sessionHit = conviction.reasons.some((r) =>
      /market session|session blocked/i.test(r)
    );
    const postDipHit = conviction.reasons.some((r) =>
      /post-run dip/i.test(r)
    );
    const chartOrVolHard =
      volSpikeHit ||
      conviction.reasons.some((r) =>
        /chart|pattern|bull.?flag|fib|technical/i.test(r)
      );
    // Grad-watch / dip-watch handoffs are synthetic — soft-pass chart/vol hard vetoes.
    // Migration Sniper event lane also soft-passes low conviction (still blocks social/session).
    const migEventHandoff =
      setupWatchHandoff &&
      (signal.candidateTradeProfileId === 'migration_sniper' ||
        /grad-watch/i.test(reasonBitsEarly));
    if (
      setupWatchHandoff &&
      ((chartOrVolHard && !socialHit && !sessionHit) ||
        (migEventHandoff && !socialHit && !sessionHit))
    ) {
      console.log(
        `[monitor] Setup-watch soft-pass conviction${migEventHandoff ? ' (MS event)' : ' chart/vol'} for ${signal.symbol}: ${detail}`
      );
    } else {
    logStrategyDecision(
      postDipHit
        ? 'post_run_dip'
        : sessionHit
          ? 'market_session_filter'
          : confirmHit
            ? 'confirmation_layer'
            : volSpikeHit
              ? 'volume_spike_filter'
              : socialHit
                ? 'social_sentiment_filter'
                : 'multi_factor_conviction',
      'skip',
      `${signal.symbol} score=${conviction.score}/${conviction.minRequired}: ${detail}`
    );
    console.log(
      `[monitor] FILTER_SKIP kind=${signalKind} reason=conviction ` +
        `${conviction.score}/${conviction.minRequired}: ${detail} · ${conviction.breakdownLine}`
    );
    paperTrader.addLog(
      'info',
      `Low conviction ${signal.symbol}: ${detail} (score ${conviction.score}) [${conviction.breakdownLine}]`,
      { mint: signal.mint, symbol: signal.symbol }
    );
    recordRejectedSignal(
      signal,
      `conviction ${conviction.score}/${conviction.minRequired}: ${detail}`
    );
    return false;
    }
  }
  if (
    !isStrategyEnabled('multi_factor_conviction') &&
    !isStrategyEnabled('elite_convergence') &&
    !isStrategyEnabled('profit_protected') &&
    !conviction.pass
  ) {
    // Conviction strategy OFF — do not hard-block on selective score
    console.log(
      `[monitor] STRATEGY_SKIP multi_factor_conviction OFF — allowing ${signal.symbol} ` +
        `(score ${conviction.score}, would need ${conviction.minRequired})`
    );
  } else if (conviction.pass) {
    logStrategyDecision(
      'multi_factor_conviction',
      'take',
      `${signal.symbol} score=${conviction.score} size×${Number(conviction.sizeMultiplier ?? 1).toFixed(2)}`
    );
  }
  console.log(
    `[monitor] Conviction OK ${signal.symbol}: score=${conviction.score} ` +
      `size×${Number(conviction.sizeMultiplier ?? 1).toFixed(2)} wallets=${signal.wallets.length} ` +
      `· ${conviction.breakdownLine}`
  );

  // Scanner-only: fail-closed when no TA setup (stricter than copy fail-open).
  // Risk Off always skips this gate (ops-only soak must not be vetoed by TA).
  // Setup-watch handoffs are synthetic (no Fib/candles) — lane floors still apply.
  // Scalper lane: Mode B — exempt only when multi-TF support confluence (or watch handoff).
  // Trend / Compounder Jupiter|KOL specialty handoffs are also exempt (mature feeds).
  // Learning Mode does not bypass Require TA for other profiles / generic scanner.
  const reasonBits = reasonBitsEarly;
  const scalperLaneWin =
    signal.candidateTradeProfileId === 'scalper' &&
    (signal.nearMultiTfSupport === true ||
      /scalper-mtf-support|scalper-watch:triggered/i.test(reasonBits));
  const matureSpecialtyTaExempt =
    (signal.candidateTradeProfileId === 'trend_rider' ||
      signal.candidateTradeProfileId === 'steady_compounder') &&
    (signal.specialtyFeed === 'jupiter' || signal.specialtyFeed === 'kolscan');
  if (
    scannerSignal &&
    signal.entrySource !== 'hybrid' &&
    config.riskLevel !== 'off' &&
    config.marketScanner?.requireTaSetup !== false &&
    !setupWatchHandoff &&
    !scalperLaneWin &&
    !matureSpecialtyTaExempt
  ) {
    const ind = evaluateIndicators({
      mint: signal.mint,
      candles: signal.candles,
      priceSol: signal.priceSol,
    });
    const hasTa =
      signal.nearKeyFib === true ||
      signal.nearSupport === true ||
      (Array.isArray(signal.chartPatternIds) &&
        signal.chartPatternIds.length > 0) ||
      ind.setup === true ||
      /fib|support|pattern|dip|pullback/i.test(
        signal.convictionBreakdown || ''
      );
    if (!hasTa) {
      logStrategyDecision(
        'ta_market_scanner',
        'skip',
        `${signal.symbol} — no TA setup (Fib/support/pattern/indicator; Learning Mode does not bypass Require TA)`
      );
      recordRejectedSignal(signal, 'scanner: no TA setup');
      return false;
    }
  } else if (
    matureSpecialtyTaExempt &&
    scannerSignal &&
    signal.entrySource !== 'hybrid' &&
    config.marketScanner?.requireTaSetup !== false &&
    config.riskLevel !== 'off'
  ) {
    console.log(
      `[monitor] ${signal.candidateTradeProfileId === 'steady_compounder' ? 'Steady Compounder' : 'Trend Rider'} specialty exempt from Require TA · ${signal.symbol}`
    );
  } else if (
    scalperLaneWin &&
    scannerSignal &&
    signal.entrySource !== 'hybrid' &&
    config.marketScanner?.requireTaSetup !== false &&
    config.riskLevel !== 'off'
  ) {
    console.log(
      `[monitor] Scalper lane exempt from Require TA setup · ${signal.symbol}`
    );
  }

  return true;
  };

  if (!lanePassers) {
    return withStrategyProfileGateAsync(undefined, runModuleFilters);
  }

  const cascadeFails: string[] = [];
  suppressRejectSideEffects = true;
  try {
    for (const passer of lanePassers) {
      signal.candidateTradeProfileId = passer.profileId;
      lastFilterSkipReason = null;
      console.log(
        `[monitor] Lane cascade try=${passer.name} (${passer.profileId}) ` +
          `score=${passer.score} · ${signal.symbol}`
      );
      const ok = await withStrategyProfileGateAsync(
        passer.profileId,
        runModuleFilters
      );
      if (ok) {
        console.log(
          `[monitor] Lane cascade win=${passer.name} (${passer.profileId}) · ${signal.symbol}`
        );
        // Do not mark opened yet — buy still pending. Fight log shows "win" until fill.
        return true;
      }
      const why = lastFilterSkipReason || 'module filters';
      cascadeFails.push(`${passer.name}: ${why}`);
      console.log(
        `[monitor] Lane cascade fail=${passer.name} · ${why}`
      );
      // CORE / hard floors fail every profile — no point trying the rest
      if (isNonBypassableSkipReason(why)) {
        console.log(
          `[monitor] Lane cascade stop — hard skip: ${why}`
        );
        break;
      }
    }
  } finally {
    suppressRejectSideEffects = false;
  }
  const cascadeReason =
    cascadeFails.slice(0, 4).join(' · ') ||
    'all lane passers failed modules';
  markLaneFightCascadeResult(signal.mint, false, cascadeReason);
  recordRejectedSignal(signal, `smart-bot cascade: ${cascadeReason}`);
  console.log(
    `[monitor] FILTER_SKIP kind=${signalKind} symbol=${signal.symbol} ` +
      `reason=smart-bot cascade: ${cascadeReason}`
  );
  return false;
}

function checkConvergence(mint: string): TradeSignal | null {
  const buys = recentBuys.get(mint);
  if (!buys || buys.length === 0) return null;

  const now = Date.now();
  const clusterMinMs = (config.filters.clusterWindowMinutes ?? 5) * 60_000;
  const windowMs = Math.max(config.convergenceWindowMs, clusterMinMs);
  const windowStart = now - windowMs;
  const recent = buys.filter((b) => b.timestamp >= windowStart);

  // Prefer high-quality wallets in the cluster when gate is on
  const qualityFiltered = recent.filter((b) => {
    const w = config.smartWallets.find((sw) => sw.address === b.wallet);
    if (!w) return true;
    if (config.filters.enableWalletQualityGate === false) return true;
    if (w.qualityScore == null) applyQualityToWallet(w);
    return (w.qualityScore ?? 0) >= effectiveMinWalletQualityScore();
  });
  const clusterBuys = qualityFiltered.length > 0 ? qualityFiltered : recent;
  const uniqueWallets = [...new Set(clusterBuys.map((b) => b.wallet))];

  const clusterMin = effectiveClusterMinWallets();
  const convRequired = clusterMin;

  const isMigration = recent.some((b) => b.isMigration);
  const latestCurve = [...recent]
    .reverse()
    .find((b) => b.bondingCurve)?.bondingCurve;
  const nearMigration =
    !isMigration &&
    isStrategyEnabled('near_migration_curve') &&
    config.strategy.enableBondingCurvePriority !== false &&
    !!latestCurve?.nearMigration;
  const earlyBuy =
    !isMigration &&
    !nearMigration &&
    isStrategyEnabled('early_curve_smart_money') &&
    recent.some((b) => b.earlyBuy || isEarlyCurveBuy(b.bondingCurve?.progressPct));

  // Single-wallet exception: proven top performer + migration only
  let allowSingle = false;
  if (
    uniqueWallets.length < convRequired &&
    uniqueWallets.length === 1 &&
    isMigration &&
    config.filters.allowSingleWalletTopPerformerMigration !== false
  ) {
    const w = config.smartWallets.find((sw) => sw.address === uniqueWallets[0]);
    if (w && isProvenTopPerformer(w)) {
      allowSingle = true;
    }
  }

  if (uniqueWallets.length < convRequired && !allowSingle) return null;

  const walletNames = uniqueWallets.map((addr) => {
    const w = config.smartWallets.find((sw) => sw.address === addr);
    return w?.name ?? addr.slice(0, 8);
  });

  const earlyBuyerCount = Math.max(
    ...recent.map((b) => b.earlyBuyerCount ?? 0),
    uniqueWallets.length
  );
  const latestBirdeye = [...recent].reverse().find((b) => b.birdeye)?.birdeye;
  const earliestBuyTs = Math.min(...clusterBuys.map((b) => b.timestamp));
  const signalAgeMinutes = (now - earliestBuyTs) / 60_000;

  // Momentum: prefer non-negative short-term change when metrics exist
  const latestMetrics = [...recent].reverse().find((b) => b.metrics)?.metrics;
  const chg = latestMetrics?.priceChangeH1Pct;
  const momMin = effectiveMomentumMinHoldPct();
  const momentumOk =
    chg == null || !Number.isFinite(chg) ? undefined : chg >= momMin;

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
    metrics: latestMetrics ?? recent[0].metrics,
    sniper: recent[0].sniper,
    birdeye: latestBirdeye ?? recent[0].birdeye,
    timestamp: now,
    signalAgeMinutes,
    momentumOk,
    allowSingleWalletException: allowSingle,
  };
}

function pushActivityFeed(event: WalletBuyEvent): void {
  activityFeed.unshift(event);
  if (activityFeed.length > MAX_ACTIVITY_FEED) {
    activityFeed.length = MAX_ACTIVITY_FEED;
  }
  // Wall-clock detection time — not blockTime — so LIVE/quiet reflects real monitor health
  const detected = event.detectedAt ?? Date.now();
  event.detectedAt = detected;
  signals24hTimestamps.push(detected);
  pruneSignals24hCount();
}

function pruneSignals24hCount(now = Date.now()): void {
  const cutoff = now - SIGNAL_COUNT_WINDOW_MS;
  let write = 0;
  for (let i = 0; i < signals24hTimestamps.length; i++) {
    if (signals24hTimestamps[i] >= cutoff) {
      signals24hTimestamps[write++] = signals24hTimestamps[i];
    }
  }
  signals24hTimestamps.length = write;
}

function getSignals24hCount(): number {
  pruneSignals24hCount();
  return signals24hTimestamps.length;
}

function getLastSignalAt(): number | null {
  pruneSignals24hCount();
  if (signals24hTimestamps.length === 0) return null;
  let max = signals24hTimestamps[0];
  for (let i = 1; i < signals24hTimestamps.length; i++) {
    if (signals24hTimestamps[i] > max) max = signals24hTimestamps[i];
  }
  return max;
}

/** Recent wallet-buy signal activity window for Overview signal light (15m). */
const SIGNAL_LIVE_WINDOW_MS = 15 * 60 * 1000;

export function getSignalLightStatus(now = Date.now()): {
  state: 'live' | 'quiet' | 'paused' | 'off';
  label: string;
  lastSignalAt: number | null;
  signals24h: number;
  ageMs: number | null;
} {
  const lastSignalAt = getLastSignalAt();
  const signals24h = getSignals24hCount();
  const ageMs = lastSignalAt != null ? now - lastSignalAt : null;
  const rpc = getRpcStats();
  const rpcHealthy = Boolean(rpc.ok);
  const watching = getWalletsForPolling().length;

  // Paused is distinct from broken/off so Overview doesn't look "dead"
  if (running && paused) {
    return {
      state: 'paused',
      label: 'Signals: paused',
      lastSignalAt,
      signals24h,
      ageMs,
    };
  }
  if (!running) {
    return {
      state: 'off',
      label: 'Signals: off',
      lastSignalAt,
      signals24h,
      ageMs,
    };
  }
  if (!rpcHealthy) {
    return {
      state: 'off',
      label: 'Signals: RPC down',
      lastSignalAt,
      signals24h,
      ageMs,
    };
  }
  if (watching === 0) {
    return {
      state: 'off',
      label: 'Signals: no wallets',
      lastSignalAt,
      signals24h,
      ageMs,
    };
  }
  if (ageMs != null && ageMs <= SIGNAL_LIVE_WINDOW_MS) {
    return {
      state: 'live',
      label: 'Signals: LIVE',
      lastSignalAt,
      signals24h,
      ageMs,
    };
  }
  const quietAge =
    ageMs == null
      ? 'none yet'
      : ageMs < 60_000
        ? `${Math.round(ageMs / 1000)}s ago`
        : ageMs < 3_600_000
          ? `${Math.round(ageMs / 60_000)}m ago`
          : `${Math.round(ageMs / 3_600_000)}h ago`;
  return {
    state: 'quiet',
    label: `Signals: quiet (${quietAge})`,
    lastSignalAt,
    signals24h,
    ageMs,
  };
}

/**
 * Overview entry-path light: abnormal blockers only (not lane no-match quietness).
 * Green = path clear; amber = soft limit; red = hard blocker / off.
 */
export function getEntryPathLightStatus(): {
  state: 'live' | 'quiet' | 'paused' | 'off';
  label: string;
  detail?: string;
  blockers: string[];
} {
  const blockers: string[] = [];
  const rpc = getRpcStats();
  const rpcHealthy = Boolean(rpc.ok);
  const openCount = paperTrader.getOpenPositions().length;
  let maxPos = Math.max(1, Number(config.filters?.maxConcurrentPositions) || 1);
  try {
    const { learningModeAdjustedMaxConcurrent } =
      require('./learningMode') as typeof import('./learningMode');
    maxPos = learningModeAdjustedMaxConcurrent(maxPos);
  } catch {
    /* ignore */
  }
  const copyOn = isStrategyEnabled('smart_money_copy');
  const scannerOn = isStrategyEnabledGlobal('ta_market_scanner');
  const scanner = getScannerStatus();
  const rate = canExecuteTradeNow();
  const minTrade = Math.max(
    0.001,
    Number(config.risk?.minTradeSol) || 0.01
  );
  const funds = evaluateAffordability(minTrade);
  let skipHint = lastFilterSkipReason
    ? /no TA setup/i.test(lastFilterSkipReason)
      ? `Last skip: ${lastFilterSkipReason} · Learning Mode does not bypass Require TA (Scalper + Trend/Compounder specialty exempt)`
      : /not a pump\.fun mint/i.test(lastFilterSkipReason)
        ? `Last skip: ${lastFilterSkipReason} · Trend/Compounder Jupiter|KOL specialty can bypass Pump.fun-only`
        : `Last skip: ${lastFilterSkipReason}`
    : undefined;
  try {
    const { getLastDipBuyerRecoverySkip } =
      require('./dipBuyerRecovery') as typeof import('./dipBuyerRecovery');
    const dbrSkip = getLastDipBuyerRecoverySkip();
    if (dbrSkip.reason) {
      const ageMs = dbrSkip.at != null ? Date.now() - dbrSkip.at : null;
      const fresh = ageMs == null || ageMs < 30 * 60_000;
      if (fresh) {
        const dbrBit = `Last DBR skip: ${dbrSkip.reason}`;
        if (!skipHint) {
          skipHint = dbrBit;
        } else if (!/Dip Buyer Recovery/i.test(skipHint)) {
          skipHint = `${skipHint} · ${dbrBit}`;
        }
      }
    }
  } catch {
    /* optional */
  }

  if (!running) {
    blockers.push('monitor not running');
    return {
      state: 'off',
      label: 'Entries: off',
      detail: skipHint,
      blockers,
    };
  }
  if (paused) {
    blockers.push('monitor paused');
    return {
      state: 'paused',
      label: 'Entries: paused',
      detail: skipHint,
      blockers,
    };
  }
  if (isRiskHalted()) {
    const reason = getRiskHaltReason() || 'risk halt';
    blockers.push(`risk halt: ${reason}`);
    return {
      state: 'off',
      label: 'Entries: risk halt',
      detail: String(reason),
      blockers,
    };
  }
  if (!rpcHealthy) {
    blockers.push('RPC unhealthy');
    return {
      state: 'off',
      label: 'Entries: RPC down',
      detail: skipHint,
      blockers,
    };
  }
  if (openCount >= maxPos) {
    blockers.push(`max concurrent positions ${openCount}/${maxPos}`);
    return {
      state: 'off',
      label: `Entries: max positions (${openCount}/${maxPos})`,
      detail: skipHint,
      blockers,
    };
  }
  if (!copyOn && !scannerOn) {
    blockers.push('copy + scanner engines off');
    return {
      state: 'off',
      label: 'Entries: engines off',
      detail: skipHint,
      blockers,
    };
  }
  if (isSmartBotProfilesEnabled()) {
    const profiles = getTradeProfilesStatus().profiles;
    const enabledCount = profiles.filter((p) => p.enabled).length;
    if (enabledCount === 0) {
      blockers.push('all Smart Bot profiles disabled');
      return {
        state: 'off',
        label: 'Entries: all bots off',
        detail: skipHint,
        blockers,
      };
    }
  }
  if (!funds.ok) {
    blockers.push(funds.reason);
    return {
      state: 'off',
      label: 'Entries: no funds',
      detail: funds.reason,
      blockers,
    };
  }
  if (config.mode === 'live') {
    try {
      const { getCachedLiveTradingReady } =
        require('./liveWalletHistory') as typeof import('./liveWalletHistory');
      const ready = getCachedLiveTradingReady();
      if (ready && !ready.ok) {
        blockers.push(ready.reason);
        return {
          state: 'off',
          label: 'Entries: no live wallet',
          detail: ready.reason,
          blockers,
        };
      }
    } catch {
      /* ignore */
    }
  }
  if (!rate.ok) {
    blockers.push(rate.reason || 'trade-rate / cooldown');
    return {
      state: 'quiet',
      label: 'Entries: cooldown',
      detail: rate.reason || skipHint,
      blockers,
    };
  }
  if (lastPollRateLimited) {
    blockers.push('wallet poll rate-limited');
    return {
      state: 'quiet',
      label: 'Entries: poll limited',
      detail: skipHint,
      blockers,
    };
  }
  if (scannerOn && !scanner.running && !copyOn) {
    blockers.push('scanner enabled but not running');
    return {
      state: 'quiet',
      label: 'Entries: scanner stopped',
      detail: skipHint,
      blockers,
    };
  }

  return {
    state: 'live',
    label: 'Entries: clear',
    detail: skipHint,
    blockers,
  };
}

function pruneActivityFeed(): void {
  const cutoff = Date.now() - ACTIVITY_FEED_TTL_MS;
  while (activityFeed.length > 0) {
    const oldest = activityFeed[activityFeed.length - 1];
    const ageBasis = oldest.detectedAt ?? oldest.timestamp;
    if (ageBasis >= cutoff) break;
    activityFeed.pop();
  }
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
  pruneActivityFeed();
  pruneSignals24hCount();
}

export function getRecentActivity(): WalletBuyEvent[] {
  pruneActivityFeed();
  expireStaleWaitingSignals();
  if (activityFeed.length > 0) {
    return activityFeed.slice(0, 80);
  }
  // Fallback if feed empty (e.g. mid-restart)
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
  lastSignalAt: number | null;
  signalLight: ReturnType<typeof getSignalLightStatus>;
  entryPathLight: ReturnType<typeof getEntryPathLightStatus>;
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
  skipReasonCounts: Array<{ reason: string; count: number }>;
  lastFilterSkipReason: string | null;
  pendingBuyQueueDepth: number;
  lastPollAttempted: number;
  lastPollCompleted: number;
  lastPollCompletedAt: number;
  lastOpenMarkRefreshAt: number;
  lastPollRateLimited: boolean;
  pollRotationOffset: number;
} {
  const risk = getRiskStatus({
    equitySol: paperTrader.getEquitySol(),
    dailyPnlSol: paperTrader.getDailyPnlSol(),
    weeklyPnlSol: paperTrader.getWeeklyPnlSol(),
  });

  const watching = getWalletsForPolling();
  const tracked = config.smartWallets.length;
  const enabled = config.smartWallets.filter((w) => w.enabled).length;
  const signalLight = getSignalLightStatus();
  const entryPathLight = getEntryPathLightStatus();

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
    recentSignals: getSignals24hCount(),
    lastSignalAt: signalLight.lastSignalAt,
    signalLight,
    entryPathLight,
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
    skipReasonCounts: getSkipReasonCounts(),
    lastFilterSkipReason,
    pendingBuyQueueDepth: pendingBuyEvents.length,
    lastPollAttempted,
    lastPollCompleted,
    lastPollCompletedAt,
    lastOpenMarkRefreshAt,
    lastPollRateLimited,
    pollRotationOffset,
  };
}

/** Allow resume after operator acknowledges risk halt */
export function clearMonitorRiskHalt(): void {
  clearRiskHalt();
}
