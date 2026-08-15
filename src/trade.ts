/**
 * Jupiter aggregator swap execution.
 * Paper mode simulates; live mode uses dynamic priority fees + optional Jito MEV protection.
 */

import { createJupiterApiClient, QuoteGetRequest } from '@jup-ag/api';
import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  config,
  getActiveTradingWallet,
  effectiveMinMarketCapUsd,
  hardFilterFloorsActive,
  usesPaperAccounting,
} from './config';
import { isDeniedCopyMint } from './deniedMints';
import {
  evaluateBuyPumpFunOnlyGate,
  evaluateHolderConcentrationHardFloors,
  evaluateFakeHolderVelocityGate,
  isMatureSpecialtyPumpFunBypass,
  isPumpFunMintSuffix,
} from './deadTokenFilters';
import { getTokenSniperActivity } from './gmgn';
import { effectiveMaxEntryMarketCapUsd } from './filterEffective';
import {
  getKeypair,
  getConnection,
  estimatePriorityFeeMicroLamports,
  sendOptimizedTransaction,
  sendAndConfirmLegacyTx,
  getActiveEndpointLabel,
  hasRpcRoleContext,
  runWithRpcRole,
} from './connection';
import { getRpcRoleFor } from './rpcRouting';
import { trySendViaJito, effectiveTipLamports, turboTipLamports } from './jito';
import {
  checkSandwichRisk,
  isMevProtectionEnabled,
  shouldUseJitoBundles,
} from './mev';
import { paperTrader } from './paperTrader';
import { logger, errorToMeta } from './logger';
import {
  resolveTurboSlippageBps,
  TURBO_DEFAULT_PRIORITY_FEE_MULT,
  isQualityLaneMicrocap,
  isQualityLaneProfileId,
  qualityLaneMicrocapNapReason,
  evaluateQualityTop10SoftAllowForGates,
  getTradeProfileDefinition,
  isSwingLaneMustKnowMc,
  swingLaneFillMinMarketCapUsd,
  type TradeProfileId,
} from './tradeProfiles';
import {
  fetchLiveTokenSnapshot,
  getCachedSolUsdPrice,
  marketCapAtPrice,
} from './marketData';
import { fetchTokenMetrics, getCachedTokenMetrics, resolveTop10HoldPctForEntry } from './tokenMetrics';
import {
  fetchBondingCurve,
  estimateBondingCurvePriceSol,
  estimateBondingCurveMarketCapUsd,
} from './bondingCurve';
import { clampToMaxAllowedTradeSol } from './risk';
import {
  evaluateAffordability,
  reportFundGateFailure,
} from './fundGate';
import {
  fetchJupiterTokenByMint,
  lookupCachedJupiterToken,
} from './jupiterTokens';

const jupiter = createJupiterApiClient();

const mintDecimalsCache = new Map<string, { decimals: number; at: number }>();
const MINT_DECIMALS_TTL_MS = 60 * 60_000;

/**
 * Resolve SPL mint decimals (Pump.fun default 6; some grads use 9).
 * Wrong decimals in quote→price make entry marks off by 10^(d-6) and can
 * invent multi-thousand-% PnL when marks later use Dex/Jupiter usdPrice.
 */
export async function resolveTokenDecimals(mint: string): Promise<number> {
  const key = String(mint || '').trim();
  if (!key) return 6;
  const hit = mintDecimalsCache.get(key);
  if (hit && Date.now() - hit.at < MINT_DECIMALS_TTL_MS) {
    return hit.decimals;
  }

  try {
    const jup =
      lookupCachedJupiterToken(key) ?? (await fetchJupiterTokenByMint(key));
    const d = Number(jup?.decimals);
    if (Number.isFinite(d) && d >= 0 && d <= 18) {
      mintDecimalsCache.set(key, { decimals: d, at: Date.now() });
      return d;
    }
  } catch {
    /* fall through */
  }

  try {
    const conn = getConnection();
    const supply = await conn.getTokenSupply(new PublicKey(key));
    const d = Number(supply?.value?.decimals);
    if (Number.isFinite(d) && d >= 0 && d <= 18) {
      mintDecimalsCache.set(key, { decimals: d, at: Date.now() });
      return d;
    }
  } catch {
    /* fall through */
  }

  const fallback = 6;
  mintDecimalsCache.set(key, { decimals: fallback, at: Date.now() });
  return fallback;
}

export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: unknown[];
}

export interface SwapResult {
  success: boolean;
  mode: 'paper' | 'liveSimulation' | 'live';
  txId?: string;
  quote?: SwapQuote;
  error?: string;
  positionId?: string;
  sendMethod?: 'jito' | 'rpc';
  tipLamports?: number;
  priorityFeeMicroLamports?: number;
  mevProtected?: boolean;
}

function solToLamports(sol: number): number {
  return Math.floor(sol * 1e9);
}

export async function getQuote(
  outputMint: string,
  solAmount?: number,
  slippageBps?: number,
  opts?: { quiet?: boolean }
): Promise<SwapQuote | null> {
  const amount = solToLamports(solAmount ?? config.trade.tradeAmountSol);
  const quiet = opts?.quiet === true;

  const params: QuoteGetRequest = {
    inputMint: config.solMint,
    outputMint,
    amount,
    slippageBps: slippageBps ?? config.paper.slippageBps,
  };

  try {
    if (!quiet) {
      logger.info('Jupiter', 'quoteGet buy', {
        outputMint: outputMint.slice(0, 12),
        amount,
        slippageBps: params.slippageBps,
      });
    }
    const quote = await jupiter.quoteGet(params);
    if (!quiet) {
      logger.info('Jupiter', 'quoteGet buy ok', {
        outAmount: (quote as SwapQuote).outAmount,
        priceImpactPct: (quote as SwapQuote).priceImpactPct,
      });
    }
    return quote as SwapQuote;
  } catch (err) {
    if (!quiet) {
      logger.error('Jupiter', 'quoteGet buy failed', {
        outputMint: outputMint.slice(0, 12),
        amount,
        ...errorToMeta(err),
      });
    }
    return null;
  }
}

export async function getSellQuote(
  inputMint: string,
  tokenAmount: string | number
): Promise<SwapQuote | null> {
  try {
    const amount =
      typeof tokenAmount === 'string' ? Number(tokenAmount) : tokenAmount;
    logger.info('Jupiter', 'quoteGet sell', {
      inputMint: inputMint.slice(0, 12),
      amount,
    });
    const quote = await jupiter.quoteGet({
      inputMint,
      outputMint: config.solMint,
      amount,
      slippageBps: config.paper.slippageBps,
    });
    logger.info('Jupiter', 'quoteGet sell ok', {
      outAmount: (quote as SwapQuote).outAmount,
    });
    return quote as SwapQuote;
  } catch (err) {
    logger.error('Jupiter', 'quoteGet sell failed', {
      inputMint: inputMint.slice(0, 12),
      ...errorToMeta(err),
    });
    return null;
  }
}

export function quoteToPriceSol(
  quote: SwapQuote,
  tokenDecimals: number = 6
): number {
  const inSol = Number(quote.inAmount) / 1e9;
  const outTokens = Number(quote.outAmount);
  if (!(outTokens > 0) || !Number.isFinite(outTokens)) return 0;
  const decimals =
    Number.isFinite(tokenDecimals) && tokenDecimals >= 0 && tokenDecimals <= 18
      ? Math.floor(tokenDecimals)
      : 6;
  const tokenAmount = outTokens / 10 ** decimals;
  if (!(tokenAmount > 0) || !Number.isFinite(tokenAmount)) return 0;
  const price = inSol / tokenAmount;
  return Number.isFinite(price) && price > 0 ? price : 0;
}

/** UI token amount from Jupiter raw outAmount. */
export function rawAmountToUiTokens(
  rawAmount: string | number,
  tokenDecimals: number = 6
): number {
  const raw = Number(rawAmount);
  if (!(raw > 0) || !Number.isFinite(raw)) return 0;
  const decimals =
    Number.isFinite(tokenDecimals) && tokenDecimals >= 0 && tokenDecimals <= 18
      ? Math.floor(tokenDecimals)
      : 6;
  const ui = raw / 10 ** decimals;
  return Number.isFinite(ui) && ui > 0 ? ui : 0;
}

export interface BuyOptions {
  sourceWallets?: string[];
  sourceNames?: string[];
  name?: string;
  solAmount?: number;
  /** Human-readable dynamic sizing reason (logged on buy) */
  sizeReason?: string;
  slippageBps?: number;
  priority?: boolean;
  strategyKind?: 'migration' | 'normal';
  antiRug?: {
    riskScore: number;
    riskLevel: string;
    flags: string[];
    ok: boolean;
  };
  /** Bot fill-time market cap USD (preferred when already resolved) */
  entryMarketCapUsd?: number;
  /**
   * Market cap when the copied smart wallet bought (signal-time snapshot).
   * Stored separately from our fill MC for wallet hover / analytics.
   */
  sourceEntryMcUsd?: number;
  /**
   * Jupiter-style top-10 holder % (bonding curve / LP excluded) from anti-rug /
   * Jupiter audit. Re-checked at executeBuy; known out-of-band hard-skips.
   * Unknown hard-skips under Risk On when min/max Top-10 gate is active.
   */
  top10HoldPct?: number | null;
  /**
   * Hours since Pump.fun graduation / Dex pair at signal time.
   * Stamped on the position for self-learning episodes.
   */
  tokenAgeHours?: number | null;
  /**
   * GMGN insider / rat hold % from anti-rug. Re-checked at executeBuy under Risk On
   * (unknown fail-closed via hard floors).
   */
  insiderPct?: number | null;
  /** Entry conviction 0–100 for exit discipline */
  convictionScore?: number;
  /** HMC / Profit Capture Layer stamps at open */
  hmcSetup?: string;
  hmcConfidence?: number;
  gateDecision?: string;
  entryQualityScore?: number;
  /** Seed Quick Scalper timed TP/SL/timer on open */
  scalpMode?: boolean;
  /** Which short-term strategy seeded the position */
  shortTermStrategyId?: import('./shortTermStrategies').ShortTermStrategyId;
  /**
   * Multi-profile assignment stamp
   */
  tradeProfileId?: string;
  tradeProfileName?: string;
  tradeProfileIcon?: string;
  tradeProfileColor?: string;
  tradeProfileScore?: number;
  tradeProfileReason?: string;
  /** Optional exit overrides from assigned profile */
  profileTakeProfitPct?: number;
  profileStopLossPct?: number;
  profileTrailingStopPct?: number;
  profileTrailingActivationProfit?: number;
  profileForceScalp?: boolean;
  profileSizeMultiplier?: number;
  /** Scalper hard timer (seconds) frozen from profile */
  profileHardTimeLimitSec?: number;
  profileOverrideScalpParams?: boolean;
  /** Scalp fade-from-peak % frozen from profile */
  profileMomentumFailDropPct?: number;
  /** Aggressive dead-market min-hold (minutes) from profile */
  profileDeadVolumeMinHoldMinutes?: number;
  profileAggressiveDeadMarket?: boolean;
  /** Turbo Mode from profile exitRules — speed over cost */
  profileTurboMode?: boolean;
  turboPriorityFeeMultiplier?: number;
  turboTipMultiplier?: number;
  turboSlippageBps?: number;
  /** wallet | scanner | migration | hybrid | zion */
  entrySource?: 'wallet' | 'scanner' | 'migration' | 'hybrid' | 'zion';
  /** Entry-style DNA tag (support reclaim / late chase / etc.) */
  entryStyle?: string;
  entryStyleSecondary?: string;
  lateChaseAtEntry?: boolean;
  /** Armed setup-watch handoff */
  armedWatch?: boolean;
  /** armed_trigger | discretionary */
  entryPath?: 'armed_trigger' | 'discretionary' | string;
  /** scalper | dip | grad when opened from a setup watch */
  setupWatchFamily?: 'scalper' | 'dip' | 'grad' | string;
  entryStyleHint?: string;
  qualityScoreHint?: number;
  /** Influencer Mirror source wallet stamps */
  mirrorWalletId?: string;
  mirrorWalletName?: string;
  scannerPlaybook?: string;
  scannerConfluence?: number;
  candleSource?: 'real' | 'synthetic';
  /** Profile TA playbook stamp at open */
  taModeAtOpen?: 'off' | 'soft' | 'hard';
  taToolsAtOpen?: string[];
  taToolsPassedAtEntry?: string[];
  taToolScoresAtEntry?: Record<string, number>;
  taConfluenceAtEntry?: number;
  haBiasAtEntry?: string | null;
  haConsecutiveAtEntry?: number;
  nearSupportAtEntry?: boolean;
  nearResistanceAtEntry?: boolean;
  nearMultiTfSupport?: boolean;
  nearMultiTfResistance?: boolean;
  supportTfHits?: string[];
  srConfluenceScore?: number;
  scalperWatchTriggered?: boolean;
  dipWatchTriggered?: boolean;
  playbookPassed?: string[];
  watchToArmMs?: number;
  armToTriggerMs?: number;
  confluenceCountAtTrigger?: number;
  watchScoreAtArm?: number;
  watchScoreAtTrigger?: number;
  watchScoreBreakdown?: { setup?: number; timing?: number; activity?: number; risk?: number; decay?: number };
  volumeStateAtWatch?: string;
  falseArmExpired?: boolean;
  /** Specialty feed stamp for pump.fun-only bypass (majors/medium/jupiter/kolscan) */
  specialtyFeed?: string | null;
  /** Set when non-pump open allowed via mature specialty bypass */
  nonPumpQualityAllow?: boolean;
  whaleStateAtEntry?: string;
  profileTaPlainLanguage?: string;
  zigzagStructureAtEntry?: string;
  macdCrossAtEntry?: string;
  macdHistSlopeAtEntry?: string;
  rsiDivergenceAtEntry?: string;
  volumeDivergenceAtEntry?: string;
}

/**
 * Same 0–100 quality used by Open Positions Reason → More Info.
 * Prefer trade-profile score; else estimate from conviction / confluence / risk / wallets.
 */
export function computeEntryQualityScore(meta?: BuyOptions | null): number | null {
  if (!meta) return null;
  if (meta.tradeProfileScore != null && Number.isFinite(Number(meta.tradeProfileScore))) {
    return Math.round(
      Math.max(0, Math.min(100, Number(meta.tradeProfileScore)))
    );
  }
  let score = 35;
  let used = false;
  if (meta.convictionScore != null && Number.isFinite(Number(meta.convictionScore))) {
    score += Math.min(30, Number(meta.convictionScore) * 0.3);
    used = true;
  }
  if (
    meta.scannerConfluence != null &&
    Number.isFinite(Number(meta.scannerConfluence))
  ) {
    score += Math.min(20, Number(meta.scannerConfluence) * 0.2);
    used = true;
  }
  if (
    meta.antiRug?.riskScore != null &&
    Number.isFinite(Number(meta.antiRug.riskScore))
  ) {
    score += Math.max(0, 15 - Number(meta.antiRug.riskScore) * 0.15);
    used = true;
  }
  const wallets =
    (meta.sourceNames && meta.sourceNames.length) ||
    (meta.sourceWallets && meta.sourceWallets.length) ||
    0;
  if (wallets > 0) {
    score += Math.min(10, wallets * 3);
    used = true;
  }
  if (meta.tradeProfileReason || meta.entrySource || meta.scannerPlaybook) {
    used = true;
  }
  if (!used) return null;
  return Math.round(Math.max(0, Math.min(100, score)));
}

/** Hard floor matching Reason-column quality — skip buys at 0–4. */
export const MIN_ENTRY_QUALITY_SCORE = 5;

export function evaluateEntryQualityHardFloor(
  meta?: BuyOptions | null
): string | null {
  const quality = computeEntryQualityScore(meta);
  if (quality == null) return null;
  if (quality < MIN_ENTRY_QUALITY_SCORE) {
    return `Skipped — entry quality score too low (${quality} < ${MIN_ENTRY_QUALITY_SCORE})`;
  }
  return null;
}

/**
 * Resolve Buy MC at our fill.
 * Prefer Dex circulating MC (what charts show) when its price agrees with the
 * fill; bonding-curve full-supply estimates often read ~1.5–2× high vs Dex.
 * Fall back to curve when Dex is missing or price-unit mismatched.
 */
async function resolveEntryMarketCapUsd(
  mint: string,
  fillPriceSol: number,
  provided?: number
): Promise<number | undefined> {
  let curveMc: number | undefined;
  try {
    const curve = await fetchBondingCurve(mint);
    if (curve.source !== 'none' && !curve.complete) {
      const solUsd = getCachedSolUsdPrice();
      let mc = estimateBondingCurveMarketCapUsd(curve, solUsd) ?? undefined;
      const curvePx = estimateBondingCurvePriceSol(curve);
      if (
        mc != null &&
        curvePx != null &&
        curvePx > 0 &&
        fillPriceSol > 0
      ) {
        mc = marketCapAtPrice(mc, curvePx, fillPriceSol) ?? mc;
      }
      if (mc != null && Number.isFinite(mc) && mc > 0) curveMc = mc;
    }
  } catch {
    /* non-fatal */
  }

  let dexMc: number | undefined;
  let dexPriceAgrees = false;
  try {
    const snap = await fetchLiveTokenSnapshot(mint);
    if (snap?.marketCapUsd && snap.marketCapUsd > 0) {
      if (snap.priceSol != null && snap.priceSol > 0 && fillPriceSol > 0) {
        const ratio = fillPriceSol / snap.priceSol;
        if (Number.isFinite(ratio) && ratio >= 0.7 && ratio <= 1.35) {
          dexPriceAgrees = true;
          dexMc =
            marketCapAtPrice(
              snap.marketCapUsd,
              snap.priceSol,
              fillPriceSol
            ) ?? snap.marketCapUsd;
        } else if (
          Number.isFinite(ratio) &&
          ratio >= 0.1 &&
          ratio <= 10 &&
          curveMc == null
        ) {
          // Wide mismatch — only use Dex when we have no curve truth
          dexMc =
            marketCapAtPrice(
              snap.marketCapUsd,
              snap.priceSol,
              fillPriceSol
            ) ?? undefined;
        }
      } else if (curveMc == null) {
        dexMc = snap.marketCapUsd;
      }
    }
  } catch {
    /* non-fatal */
  }

  // When Dex only exposes FDV-as-MC (left null), prefer Jupiter circulating mcap
  let jupMc: number | undefined;
  if (dexMc == null) {
    try {
      const {
        fetchJupiterTokenByMint,
        lookupCachedJupiterToken,
        hasJupiterApiKey,
      } = require('./jupiterTokens') as typeof import('./jupiterTokens');
      const tok =
        lookupCachedJupiterToken(mint) ??
        (hasJupiterApiKey() ? await fetchJupiterTokenByMint(mint) : null);
      const m = Number(tok?.mcap ?? 0);
      if (Number.isFinite(m) && m > 0) jupMc = m;
    } catch {
      /* non-fatal */
    }
  }

  // Dex (chart MC) first when price agrees; curve often overstates vs circulating.
  let resolved: number | undefined;
  if (dexMc != null && dexPriceAgrees) {
    resolved = dexMc;
    // If curve is much higher than Dex, keep Dex (full-supply inflation)
  } else if (
    curveMc != null &&
    dexMc != null &&
    curveMc > dexMc * 1.35
  ) {
    resolved = dexMc;
  } else {
    resolved = curveMc ?? dexMc ?? jupMc;
  }

  if (provided != null && Number.isFinite(provided) && provided > 0) {
    if (resolved != null && provided / resolved > 10) return resolved;
    if (dexMc != null && dexPriceAgrees) return Math.min(provided, dexMc);
    if (curveMc != null && curveMc > 0) return Math.min(provided, curveMc);
    return provided;
  }

  return resolved;
}

/** Snapshot MC at signal / smart-wallet buy time (curve → Dex → Jupiter → stale cache). */
export async function resolveSourceEntryMcUsd(
  mint: string
): Promise<number | undefined> {
  try {
    const curve = await fetchBondingCurve(mint);
    if (curve.source !== 'none' && !curve.complete) {
      const mc = estimateBondingCurveMarketCapUsd(
        curve,
        getCachedSolUsdPrice()
      );
      if (mc != null && mc > 0) return mc;
    }
  } catch {
    /* non-fatal */
  }
  try {
    const snap = await fetchLiveTokenSnapshot(mint);
    if (snap?.marketCapUsd != null && snap.marketCapUsd > 0) {
      return snap.marketCapUsd;
    }
  } catch {
    /* non-fatal */
  }
  // When Dex only exposes FDV-as-MC (left null), prefer Jupiter circulating mcap
  try {
    const {
      fetchJupiterTokenByMint,
      lookupCachedJupiterToken,
      hasJupiterApiKey,
    } = require('./jupiterTokens') as typeof import('./jupiterTokens');
    const tok =
      lookupCachedJupiterToken(mint) ??
      (hasJupiterApiKey() ? await fetchJupiterTokenByMint(mint) : null);
    const m = Number(tok?.mcap ?? 0);
    if (Number.isFinite(m) && m > 0) return m;
  } catch {
    /* non-fatal */
  }
  try {
    const cached = getCachedTokenMetrics(mint, { allowStale: true });
    if (cached?.marketCapUsd != null && cached.marketCapUsd > 0) {
      return cached.marketCapUsd;
    }
  } catch {
    /* non-fatal */
  }
  return undefined;
}

export async function executeBuy(
  mint: string,
  symbol: string,
  meta?: BuyOptions
): Promise<SwapResult> {
  if (!hasRpcRoleContext()) {
    return runWithRpcRole(
      getRpcRoleFor('trade_entry', Boolean(config.rpc?.shareLoad)),
      () => executeBuy(mint, symbol, meta),
      'trade_entry'
    );
  }
  if (isDeniedCopyMint(mint, config.solMint)) {
    return {
      success: false,
      mode: config.mode,
      error: `Denied mint (stable/quote) — not a copy target`,
    };
  }

  // Live mode hard gate: real wallet loaded + min SOL before any bot/trade fires
  if (config.mode === 'live') {
    try {
      const { assertLiveTradingReady } =
        require('./liveWalletHistory') as typeof import('./liveWalletHistory');
      const ready = await assertLiveTradingReady('live');
      if (!ready.ok) {
        console.log(`[trade] LIVE_GATE_SKIP ${ready.reason}`);
        return { success: false, mode: 'live', error: ready.reason };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        mode: 'live',
        error: `Live trading blocked — ${msg}`,
      };
    }
  }

  // Hard floor: only Pump.fun mints ending in `pump` when toggle is ON.
  // Covers paper + live + migration + re-buy (all executeBuy callers).
  // Mature specialty Steady/HWR/Trend handoffs pass via meta specialty stamps.
  const pumpFunGateOpts = {
    specialtyFeed: meta?.specialtyFeed,
    preferredProfileId: meta?.tradeProfileId,
    candidateTradeProfileId: meta?.tradeProfileId,
    tradeProfileId: meta?.tradeProfileId,
    armedWatch: meta?.armedWatch === true,
    dipWatchTriggered: meta?.dipWatchTriggered === true,
    symbol: symbol || meta?.name || null,
  };
  const pumpFunGate = evaluateBuyPumpFunOnlyGate(mint, pumpFunGateOpts);
  if (pumpFunGate) {
    console.log(
      `[trade] FILTER_SKIP mint=${mint.slice(0, 8)}… ${pumpFunGate}`
    );
    return { success: false, mode: config.mode, error: pumpFunGate };
  }
  if (
    meta &&
    !isPumpFunMintSuffix(mint) &&
    isMatureSpecialtyPumpFunBypass(pumpFunGateOpts)
  ) {
    meta.nonPumpQualityAllow = true;
    const reason = String(meta.tradeProfileReason || '');
    if (!/non_pump_quality_allow/i.test(reason)) {
      meta.tradeProfileReason = reason
        ? `${reason} · non_pump_quality_allow`
        : 'non_pump_quality_allow';
    }
  }

  // Hard floor: fake-holder velocity (always on — all profiles + Zion Place Trade).
  try {
    const metrics = await fetchTokenMetrics(mint);
    const fakeHolders = evaluateFakeHolderVelocityGate({
      holderCount: metrics.holderCountEstimate,
      launchedAtMs: metrics.pairCreatedAtMs,
    });
    if (fakeHolders) {
      console.log(
        `[trade] FILTER_SKIP mint=${mint.slice(0, 8)}… ${fakeHolders}`
      );
      return { success: false, mode: config.mode, error: fakeHolders };
    }
  } catch (err) {
    console.warn(
      `[trade] Fake-holder check failed for ${mint.slice(0, 8)}…:`,
      err instanceof Error ? err.message : err
    );
  }

  // Hard floor: Reason-column quality 0–4 never open (matches More Info score).
  const qualityGate = evaluateEntryQualityHardFloor(meta);
  if (qualityGate) {
    console.log(
      `[trade] FILTER_SKIP mint=${mint.slice(0, 8)}… ${qualityGate}`
    );
    return { success: false, mode: config.mode, error: qualityGate };
  }

  const baseSlippageBps = meta?.slippageBps ?? config.paper.slippageBps;
  const turboOn = meta?.profileTurboMode === true;
  const slippageBps = resolveTurboSlippageBps(baseSlippageBps, {
    turboMode: turboOn,
    turboSlippageBps: meta?.turboSlippageBps,
  });
  const strategyKind =
    meta?.strategyKind ?? (meta?.priority ? 'migration' : 'normal');
  const solAmount = clampToMaxAllowedTradeSol(
    meta?.solAmount ??
      config.trade.baseTradeAmountSol ??
      config.trade.tradeAmountSol,
    `executeBuy:${strategyKind}`
  );

  // Paper / Live Sim: refuse buys when available SOL or equity cannot fund the size.
  // Logs a clear warning in the Logs tab instead of opening a trade.
  if (usesPaperAccounting()) {
    const gate = evaluateAffordability(solAmount);
    if (!gate.ok) {
      void reportFundGateFailure(gate, { mint, symbol });
      return {
        success: false,
        mode: config.mode,
        error: gate.reason,
      };
    }
  }

  if (paperTrader.hasOpenMint(mint)) {
    return {
      success: false,
      mode: config.mode,
      error: `Already holding open position on ${mint.slice(0, 8)}…`,
    };
  }

  const sizeLog =
    meta?.sizeReason ??
    `Dynamic size: ${solAmount.toFixed(4)} SOL - ${strategyKind}${meta?.priority ? ' priority' : ''}`;
  console.log(`[trade] ${sizeLog}`);
  if (meta?.priority) {
    console.log(
      `[trade] Priority buy sizing: ${solAmount} SOL @ ${slippageBps} bps slip (${strategyKind})`
    );
  }
  if (turboOn && slippageBps > baseSlippageBps) {
    console.log(
      `[trade] TURBO slip floor ${baseSlippageBps}→${slippageBps} bps ` +
        `(profile=${meta?.tradeProfileId || '?'})`
    );
  }

  const quote = await getQuote(mint, solAmount, slippageBps);
  const tokenDecimals = await resolveTokenDecimals(mint);
  let priceSol = quote ? quoteToPriceSol(quote, tokenDecimals) : null;

  // Paper / Live Simulation: brand-new Pump.fun mints often have no Jupiter route yet —
  // fall back to bonding-curve / Dex price so signals still open virtual positions.
  if (priceSol == null || !(priceSol > 0)) {
    if (usesPaperAccounting()) {
      try {
        const curve = await fetchBondingCurve(mint);
        const curvePx = estimateBondingCurvePriceSol(curve);
        if (curvePx != null && curvePx > 0) {
          priceSol = curvePx;
          console.log(
            `[trade] Paper price from bonding curve: ${priceSol.toExponential(4)} SOL/token`
          );
        }
      } catch {
        /* non-fatal */
      }
      if (priceSol == null || !(priceSol > 0)) {
        try {
          const snap = await fetchLiveTokenSnapshot(mint);
          if (snap?.priceSol != null && snap.priceSol > 0) {
            priceSol = snap.priceSol;
            console.log(
              `[trade] Paper price from market snapshot: ${priceSol.toExponential(4)} SOL/token`
            );
          }
        } catch {
          /* non-fatal */
        }
      }
    }
  } else {
    // Cross-check quote vs Dex: catches residual decimal / unit bugs
    try {
      const snap = await fetchLiveTokenSnapshot(mint);
      if (
        snap?.priceSol != null &&
        snap.priceSol > 0 &&
        priceSol > 0
      ) {
        const ratio = priceSol / snap.priceSol;
        if (ratio > 5 || ratio < 0.2) {
          console.warn(
            `[trade] Quote price ${priceSol.toExponential(3)} vs Dex ${snap.priceSol.toExponential(3)} ` +
              `(${ratio.toFixed(2)}×) — preferring Dex mark`
          );
          priceSol = snap.priceSol;
        }
      }
    } catch {
      /* non-fatal */
    }
  }

  if (priceSol == null || !(priceSol > 0)) {
    return {
      success: false,
      mode: config.mode,
      error: quote ? 'Invalid quote price' : 'No quote available',
    };
  }

  let entryMarketCapUsd = await resolveEntryMarketCapUsd(
    mint,
    priceSol,
    meta?.entryMarketCapUsd
  );
  const sourceEntryMcUsd =
    meta?.sourceEntryMcUsd != null &&
    Number.isFinite(meta.sourceEntryMcUsd) &&
    meta.sourceEntryMcUsd > 0
      ? meta.sourceEntryMcUsd
      : undefined;

  // Hard entry-MC floor after MC is resolved (all paths: paper, live, migration, re-buy).
  // Known MC below min still hard-rejects. Unknown after fallbacks: MS/scalper
  // soft-pass (Dex 429); Dip/Trend hard-skip. Risk OFF: floors disabled.
  const minEntryMc = effectiveMinMarketCapUsd();
  const swingMustKnowMc = isSwingLaneMustKnowMc(meta?.tradeProfileId);
  const fillMinMc =
    minEntryMc > 0
      ? Math.max(
          minEntryMc,
          swingLaneFillMinMarketCapUsd(meta?.tradeProfileId)
        )
      : 0;
  if (
    minEntryMc > 0 &&
    (entryMarketCapUsd == null || !(entryMarketCapUsd > 0))
  ) {
    // Fallbacks when Dex/fill MC unresolved
    if (sourceEntryMcUsd != null && sourceEntryMcUsd > 0) {
      entryMarketCapUsd = sourceEntryMcUsd;
    } else {
      const cached = getCachedTokenMetrics(mint, { allowStale: true });
      if (cached?.marketCapUsd != null && cached.marketCapUsd > 0) {
        entryMarketCapUsd = cached.marketCapUsd;
      } else {
        try {
          const fromSource = await resolveSourceEntryMcUsd(mint);
          if (fromSource != null && fromSource > 0) {
            entryMarketCapUsd = fromSource;
          }
        } catch {
          /* non-fatal */
        }
      }
    }
  }
  if (minEntryMc > 0) {
    if (entryMarketCapUsd == null || !(entryMarketCapUsd > 0)) {
      if (swingMustKnowMc) {
        const reason =
          `Skipped — ${meta?.tradeProfileId || 'swing'} market cap unknown ` +
          `(lane min $${Math.round(fillMinMc)})`;
        logger.info('Trade', 'FILTER_SKIP entry MC unknown', {
          mint: mint.slice(0, 12),
          symbol,
          reason,
          minEntryMc: fillMinMc,
        });
        console.log(
          `[trade] FILTER_SKIP mint=${mint.slice(0, 8)}… ${reason}`
        );
        return { success: false, mode: config.mode, error: reason };
      }
      logger.info('Trade', 'FILTER_SKIP entry MC soft-pass unknown', {
        mint: mint.slice(0, 12),
        symbol,
        minEntryMc,
      });
      console.log(
        `[trade] Entry MC soft-pass ${symbol}: unknown after curve/Dex/cache ` +
          `(min $${minEntryMc}) — allowing fill`
      );
      // Soft-pass — MS/scalper only; known-below-min still hard below
    } else if (
      isQualityLaneMicrocap(meta?.tradeProfileId, entryMarketCapUsd, {
        specialtyFeed: meta?.specialtyFeed,
      })
    ) {
      const nap = qualityLaneMicrocapNapReason(
        meta?.tradeProfileId,
        entryMarketCapUsd
      );
      logger.info('Trade', 'FILTER_SKIP quality MC NAP', {
        mint: mint.slice(0, 12),
        symbol,
        reason: nap,
        entryMarketCapUsd,
      });
      console.log(`[trade] FILTER_SKIP mint=${mint.slice(0, 8)}… ${nap}`);
      return { success: false, mode: config.mode, error: nap };
    } else if (entryMarketCapUsd < fillMinMc) {
      const reason =
        `Skipped — market cap too low ($${Math.round(entryMarketCapUsd)} < $${fillMinMc})`;
      logger.info('Trade', 'FILTER_SKIP entry MC', {
        mint: mint.slice(0, 12),
        symbol,
        reason,
        entryMarketCapUsd,
      });
      console.log(
        `[trade] FILTER_SKIP mint=${mint.slice(0, 8)}… ${reason} ` +
          `(gate MC $${Math.round(entryMarketCapUsd)}, min $${fillMinMc})`
      );
      return { success: false, mode: config.mode, error: reason };
    }
  }
  const maxEntryMc = effectiveMaxEntryMarketCapUsd();
  if (
    maxEntryMc > 0 &&
    entryMarketCapUsd != null &&
    entryMarketCapUsd > maxEntryMc
  ) {
    const reason =
      `Skipped — market cap too high ($${Math.round(entryMarketCapUsd)} > $${maxEntryMc}; already-pumped / dump risk)`;
    logger.info('Trade', 'FILTER_SKIP entry MC', {
      mint: mint.slice(0, 12),
      symbol,
      reason,
      entryMarketCapUsd,
    });
    console.log(
      `[trade] FILTER_SKIP mint=${mint.slice(0, 8)}… ${reason}`
    );
    return { success: false, mode: config.mode, error: reason };
  }
  if (minEntryMc > 0 && entryMarketCapUsd != null) {
    console.log(
      `[trade] Entry MC OK ${symbol}: $${Math.round(entryMarketCapUsd)} ≥ min $${fillMinMc}` +
        (maxEntryMc > 0 ? ` · ≤ max $${maxEntryMc}` : '')
    );
  }

  // Hard top-10 + insider at execute (mirrors anti-rug). Soft-pass / early paper cannot
  // bypass known out-of-band values. Unknown top10 is soft-only after Jupiter + on-chain;
  // unknown insider is soft-only after GMGN attempt (known ≥50% still hard).
  const top10HoldPct = await resolveTop10HoldPctForEntry(
    mint,
    meta?.top10HoldPct
  );
  let insiderPct =
    meta?.insiderPct != null && Number.isFinite(meta.insiderPct)
      ? meta.insiderPct
      : null;
  if (insiderPct == null && hardFilterFloorsActive()) {
    try {
      const sniper = await getTokenSniperActivity(mint);
      if (sniper.source !== 'none' && sniper.insiderPct != null) {
        insiderPct = sniper.insiderPct;
      }
    } catch (err) {
      console.warn(
        `[trade] Insider fetch failed for ${mint.slice(0, 8)}…:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  const holderGate = evaluateHolderConcentrationHardFloors({
    top10HoldPct,
    insiderPct,
  });
  if (holderGate.skipReasons.length > 0) {
    const filtered: string[] = [];
    for (const reason of holderGate.skipReasons) {
      const isTop10TooHigh =
        /top 10 holders too high|top10 holders too high/i.test(reason);
      if (
        isTop10TooHigh &&
        isQualityLaneProfileId(meta?.tradeProfileId) &&
        top10HoldPct != null &&
        Number.isFinite(top10HoldPct)
      ) {
        const def = getTradeProfileDefinition(
          meta!.tradeProfileId as TradeProfileId
        );
        const catalogMax =
          def.match.maxTop10HoldPct != null &&
          Number.isFinite(def.match.maxTop10HoldPct)
            ? Number(def.match.maxTop10HoldPct)
            : 0;
        if (catalogMax > 0 && top10HoldPct <= catalogMax) {
          console.log(
            `[trade] top10_soft_allow GRANT ${symbol}: within lane hard max ${catalogMax}%`
          );
          continue;
        }
        const cachedMx = getCachedTokenMetrics(mint, { allowStale: true });
        const soft = evaluateQualityTop10SoftAllowForGates({
          profileId: meta?.tradeProfileId,
          top10HoldPct,
          maxTop10HoldPct: catalogMax > 0 ? catalogMax : undefined,
          marketCapUsd: entryMarketCapUsd ?? cachedMx?.marketCapUsd ?? null,
          volumeH1Usd: cachedMx?.volumeH1Usd ?? null,
          liquidityUsd: cachedMx?.liquidityUsd ?? null,
          holderCount: cachedMx?.holderCountEstimate ?? null,
          pairCreatedAtMs: cachedMx?.pairCreatedAtMs ?? null,
          tokenAgeHours: (() => {
            const pairMs = cachedMx?.pairCreatedAtMs;
            if (pairMs != null && Number.isFinite(pairMs) && pairMs > 0) {
              return Math.max(0, (Date.now() - Number(pairMs)) / 3_600_000);
            }
            return null;
          })(),
          symbol,
          specialtyFeed: meta?.specialtyFeed ?? null,
        });
        if (soft.granted) {
          console.log(
            `[trade] top10_soft_allow GRANT ${symbol}: ${soft.detail}`
          );
          continue;
        }
        if (soft.applicable && soft.denyDetail) {
          filtered.push(soft.denyDetail);
          console.log(
            `[trade] top10_soft_allow REJECT ${symbol}: ${soft.denyDetail}` +
              (soft.rejectKey ? ` · key=${soft.rejectKey}` : '')
          );
          continue;
        }
      }
      filtered.push(reason);
    }
    if (filtered.length > 0) {
      const reason = filtered[0]!;
      logger.info('Trade', 'FILTER_SKIP holder concentration', {
        mint: mint.slice(0, 12),
        symbol,
        reason,
        top10HoldPct: top10HoldPct ?? null,
        insiderPct: insiderPct ?? null,
      });
      console.log(
        `[trade] FILTER_SKIP mint=${mint.slice(0, 8)}… ${reason} ` +
          `(top10=${top10HoldPct != null ? top10HoldPct.toFixed(1) + '%' : '?'} · ` +
          `insider=${insiderPct != null ? insiderPct.toFixed(0) + '%' : '?'})`
      );
      return { success: false, mode: config.mode, error: reason };
    }
  }
  if (top10HoldPct != null) {
    logger.info('Trade', 'Entry top10 OK', {
      mint: mint.slice(0, 12),
      symbol,
      top10HoldPct,
    });
    console.log(
      `[trade] Entry top10 OK ${symbol}: ${top10HoldPct.toFixed(1)}%`
    );
  } else if (
    (Number(config.filters.minTop10HolderPct) || 0) > 0 ||
    (Number(config.filters.maxHolderConcentration) || 0) > 0
  ) {
    logger.info('Trade', 'Entry top10 soft-pass unknown', {
      mint: mint.slice(0, 12),
      symbol,
    });
    console.log(
      `[trade] Entry top10 soft-pass ${symbol}: unknown after Jupiter + on-chain`
    );
  }
  if (insiderPct != null && hardFilterFloorsActive()) {
    console.log(
      `[trade] Entry insider OK ${symbol}: ${insiderPct.toFixed(0)}%`
    );
  }

  if (usesPaperAccounting()) {
    if (turboOn) {
      const tipWould = turboTipLamports(meta?.turboTipMultiplier);
      const prioMult =
        meta?.turboPriorityFeeMultiplier != null &&
        Number.isFinite(meta.turboPriorityFeeMultiplier) &&
        meta.turboPriorityFeeMultiplier > 0
          ? meta.turboPriorityFeeMultiplier
          : Math.max(
              config.mev?.priorityFeeMultiplier ?? 1,
              TURBO_DEFAULT_PRIORITY_FEE_MULT
            );
      let prioWould: number | null = null;
      try {
        prioWould = await estimatePriorityFeeMicroLamports();
        if (prioWould != null && Number.isFinite(prioWould)) {
          prioWould = Math.floor(prioWould * prioMult);
        }
      } catch {
        prioWould = null;
      }
      console.log(
        `[trade] TURBO (${config.mode}) would-be jito tip=${tipWould} lamports ` +
          `prio=${prioWould != null ? prioWould + ' µLamports/CU' : 'n/a'} ` +
          `slip=${slippageBps}bps profile=${meta?.tradeProfileId || '?'} — no bundle sent`
      );
    }
    const position = paperTrader.simulateBuy(
      mint,
      symbol,
      priceSol,
      solAmount,
      {
        sourceWallets: meta?.sourceWallets,
        sourceNames: meta?.sourceNames,
        name: meta?.name,
        slippageBps,
        strategyKind,
        antiRug: meta?.antiRug,
        entryMarketCapUsd,
        sourceEntryMcUsd,
        convictionScore: meta?.convictionScore,
        hmcSetup: meta?.hmcSetup,
        hmcConfidence: meta?.hmcConfidence,
        gateDecision: meta?.gateDecision,
        entryQualityScore: meta?.entryQualityScore,
        scalpMode: meta?.scalpMode === true,
        shortTermStrategyId: meta?.shortTermStrategyId,
        tradeProfileId: meta?.tradeProfileId,
        tradeProfileName: meta?.tradeProfileName,
        tradeProfileIcon: meta?.tradeProfileIcon,
        tradeProfileColor: meta?.tradeProfileColor,
        tradeProfileScore: meta?.tradeProfileScore,
        tradeProfileReason: meta?.tradeProfileReason,
        profileTakeProfitPct: meta?.profileTakeProfitPct,
        profileStopLossPct: meta?.profileStopLossPct,
        profileTrailingStopPct: meta?.profileTrailingStopPct,
        profileTrailingActivationProfit: meta?.profileTrailingActivationProfit,
        profileForceScalp: meta?.profileForceScalp,
        profileHardTimeLimitSec: meta?.profileHardTimeLimitSec,
        profileOverrideScalpParams: meta?.profileOverrideScalpParams,
        profileMomentumFailDropPct: meta?.profileMomentumFailDropPct,
        profileDeadVolumeMinHoldMinutes: meta?.profileDeadVolumeMinHoldMinutes,
        profileAggressiveDeadMarket: meta?.profileAggressiveDeadMarket,
        profileTurboMode: turboOn,
        entrySource: meta?.entrySource,
        entryStyle: meta?.entryStyle,
        entryStyleSecondary: meta?.entryStyleSecondary,
        lateChaseAtEntry: meta?.lateChaseAtEntry === true,
        mirrorWalletId: meta?.mirrorWalletId,
        mirrorWalletName: meta?.mirrorWalletName,
        scannerPlaybook: meta?.scannerPlaybook,
        scannerConfluence: meta?.scannerConfluence,
        candleSource: meta?.candleSource,
        taModeAtOpen: meta?.taModeAtOpen,
        taToolsAtOpen: meta?.taToolsAtOpen,
        taToolsPassedAtEntry: meta?.taToolsPassedAtEntry,
        taToolScoresAtEntry: meta?.taToolScoresAtEntry,
        taConfluenceAtEntry: meta?.taConfluenceAtEntry,
        haBiasAtEntry: meta?.haBiasAtEntry,
        haConsecutiveAtEntry: meta?.haConsecutiveAtEntry,
        nearSupportAtEntry: meta?.nearSupportAtEntry,
        nearResistanceAtEntry: meta?.nearResistanceAtEntry,
        nearMultiTfSupport: meta?.nearMultiTfSupport,
        nearMultiTfResistance: meta?.nearMultiTfResistance,
        supportTfHits: meta?.supportTfHits,
        srConfluenceScore: meta?.srConfluenceScore,
        scalperWatchTriggered: meta?.scalperWatchTriggered,
        dipWatchTriggered: meta?.dipWatchTriggered,
        armedWatch: meta?.armedWatch === true,
        playbookPassed: Array.isArray(meta?.playbookPassed)
          ? meta.playbookPassed
          : Array.isArray(meta?.taToolsPassedAtEntry)
            ? meta.taToolsPassedAtEntry
            : undefined,
        watchToArmMs: meta?.watchToArmMs,
        armToTriggerMs: meta?.armToTriggerMs,
        watchScoreAtArm: meta?.watchScoreAtArm,
        watchScoreAtTrigger: meta?.watchScoreAtTrigger,
        watchScoreBreakdown: meta?.watchScoreBreakdown,
        volumeStateAtWatch: meta?.volumeStateAtWatch,
        confluenceCountAtTrigger:
          meta?.confluenceCountAtTrigger != null
            ? Number(meta.confluenceCountAtTrigger)
            : undefined,
        falseArmExpired: meta?.falseArmExpired === true,
        entryPath:
          meta?.entryPath ||
          (meta?.armedWatch === true ? 'armed_trigger' : 'discretionary'),
        setupWatchFamily: meta?.setupWatchFamily,
        whaleStateAtEntry: meta?.whaleStateAtEntry,
        profileTaPlainLanguage: meta?.profileTaPlainLanguage,
        zigzagStructureAtEntry: meta?.zigzagStructureAtEntry,
        macdCrossAtEntry: meta?.macdCrossAtEntry,
        macdHistSlopeAtEntry: meta?.macdHistSlopeAtEntry,
        rsiDivergenceAtEntry: meta?.rsiDivergenceAtEntry,
        volumeDivergenceAtEntry: meta?.volumeDivergenceAtEntry,
        top10HoldPct,
        tokenAgeHours: meta?.tokenAgeHours,
      }
    );
    if (!position) {
      // simulateBuy already logged; surface a clearer API error when funds were the cause
      const bal = paperTrader.getBalance();
      const err =
        solAmount > bal
          ? `Insufficient available funds: need ${solAmount.toFixed(4)} SOL, have ${bal.toFixed(4)} SOL`
          : 'Simulated buy failed';
      return {
        success: false,
        mode: config.mode,
        error: err,
      };
    }
    return {
      success: true,
      mode: config.mode,
      quote: quote ?? undefined,
      positionId: position.id,
      mevProtected: false,
    };
  }

  if (!quote) {
    return { success: false, mode: 'live', error: 'No quote available' };
  }
  const keypair = getKeypair();
  if (!keypair) {
    const slot = getActiveTradingWallet();
    return {
      success: false,
      mode: 'live',
      error: slot
        ? `No keypair for "${slot.name}" — set env ${slot.envVar}`
        : 'No active trading wallet configured for live trading',
    };
  }

  // Optional sandwich protection before broadcasting
  if (isMevProtectionEnabled()) {
    const sandwich = await checkSandwichRisk(mint);
    if (!sandwich.safe && config.mev.abortOnSandwichRisk) {
      console.warn(
        `[trade] MEV abort — sandwich risk on ${mint.slice(0, 8)}…: ${sandwich.reason}`
      );
      return {
        success: false,
        mode: 'live',
        error: `MEV sandwich risk: ${sandwich.reason}`,
        mevProtected: true,
      };
    }
  }

  try {
    const active = getActiveTradingWallet();
    console.log(
      `[trade] Live buy via wallet "${active?.name ?? 'unknown'}" ` +
        `(${keypair.publicKey.toBase58().slice(0, 8)}…) ` +
        `MEV=${isMevProtectionEnabled() ? 'ON' : 'OFF'}` +
        (turboOn ? ' · TURBO' : '')
    );
    const live = await executeLiveSwap(quote, keypair, mint, {
      turboMode: turboOn,
      turboPriorityFeeMultiplier: meta?.turboPriorityFeeMultiplier,
      turboTipMultiplier: meta?.turboTipMultiplier,
      tradeProfileId: meta?.tradeProfileId,
    });
    console.log(
      `[trade] ${turboOn ? 'TURBO LIVE' : 'Live'} buy via ${live.method} on ${getActiveEndpointLabel()}: ${live.txId}` +
        (live.tipLamports != null ? ` tip=${live.tipLamports}` : '') +
        (live.priorityFeeMicroLamports != null
          ? ` prio=${live.priorityFeeMicroLamports} µLamports/CU`
          : '')
    );

    // Track for dynamic trailing / TP-SL (does not touch paper balance)
    const outRaw = quote.outAmount;
    const amountTokens = rawAmountToUiTokens(outRaw, tokenDecimals);
    let position;
    try {
      position = paperTrader.registerLivePosition({
        mint,
        symbol,
        name: meta?.name,
        entryPriceSol: priceSol,
        costSol: solAmount,
        amountTokens: Number.isFinite(amountTokens) ? amountTokens : 0,
        tokenAmountRaw: outRaw,
        strategyKind,
        sourceWallets: meta?.sourceWallets,
        sourceNames: meta?.sourceNames,
        antiRug: meta?.antiRug,
        entryMarketCapUsd,
        sourceEntryMcUsd,
        convictionScore: meta?.convictionScore,
        hmcSetup: meta?.hmcSetup,
        hmcConfidence: meta?.hmcConfidence,
        gateDecision: meta?.gateDecision,
        entryQualityScore: meta?.entryQualityScore,
        scalpMode: meta?.scalpMode === true,
        shortTermStrategyId: meta?.shortTermStrategyId,
        tradeProfileId: meta?.tradeProfileId,
        tradeProfileName: meta?.tradeProfileName,
        tradeProfileIcon: meta?.tradeProfileIcon,
        tradeProfileColor: meta?.tradeProfileColor,
        tradeProfileScore: meta?.tradeProfileScore,
        tradeProfileReason: meta?.tradeProfileReason,
        profileTakeProfitPct: meta?.profileTakeProfitPct,
        profileStopLossPct: meta?.profileStopLossPct,
        profileTrailingStopPct: meta?.profileTrailingStopPct,
        profileTrailingActivationProfit: meta?.profileTrailingActivationProfit,
        profileForceScalp: meta?.profileForceScalp,
        profileHardTimeLimitSec: meta?.profileHardTimeLimitSec,
        profileOverrideScalpParams: meta?.profileOverrideScalpParams,
        profileMomentumFailDropPct: meta?.profileMomentumFailDropPct,
        profileDeadVolumeMinHoldMinutes: meta?.profileDeadVolumeMinHoldMinutes,
        profileAggressiveDeadMarket: meta?.profileAggressiveDeadMarket,
        profileTurboMode: turboOn,
        entrySource: meta?.entrySource,
        entryStyle: meta?.entryStyle,
        entryStyleSecondary: meta?.entryStyleSecondary,
        lateChaseAtEntry: meta?.lateChaseAtEntry === true,
        mirrorWalletId: meta?.mirrorWalletId,
        mirrorWalletName: meta?.mirrorWalletName,
        scannerPlaybook: meta?.scannerPlaybook,
        scannerConfluence: meta?.scannerConfluence,
        candleSource: meta?.candleSource,
        top10HoldPct,
        tokenAgeHours: meta?.tokenAgeHours,
        taModeAtOpen: meta?.taModeAtOpen,
        taToolsAtOpen: meta?.taToolsAtOpen,
        taToolsPassedAtEntry: meta?.taToolsPassedAtEntry,
        taToolScoresAtEntry: meta?.taToolScoresAtEntry,
        taConfluenceAtEntry: meta?.taConfluenceAtEntry,
        haBiasAtEntry: meta?.haBiasAtEntry,
        haConsecutiveAtEntry: meta?.haConsecutiveAtEntry,
        nearSupportAtEntry: meta?.nearSupportAtEntry,
        nearResistanceAtEntry: meta?.nearResistanceAtEntry,
        nearMultiTfSupport: meta?.nearMultiTfSupport,
        nearMultiTfResistance: meta?.nearMultiTfResistance,
        supportTfHits: meta?.supportTfHits,
        srConfluenceScore: meta?.srConfluenceScore,
        scalperWatchTriggered: meta?.scalperWatchTriggered,
        dipWatchTriggered: meta?.dipWatchTriggered,
        armedWatch: meta?.armedWatch === true,
        playbookPassed: Array.isArray(meta?.playbookPassed)
          ? meta.playbookPassed
          : Array.isArray(meta?.taToolsPassedAtEntry)
            ? meta.taToolsPassedAtEntry
            : undefined,
        watchToArmMs: meta?.watchToArmMs,
        armToTriggerMs: meta?.armToTriggerMs,
        watchScoreAtArm: meta?.watchScoreAtArm,
        watchScoreAtTrigger: meta?.watchScoreAtTrigger,
        watchScoreBreakdown: meta?.watchScoreBreakdown,
        volumeStateAtWatch: meta?.volumeStateAtWatch,
        confluenceCountAtTrigger:
          meta?.confluenceCountAtTrigger != null
            ? Number(meta.confluenceCountAtTrigger)
            : undefined,
        falseArmExpired: meta?.falseArmExpired === true,
        entryPath:
          meta?.entryPath ||
          (meta?.armedWatch === true ? 'armed_trigger' : 'discretionary'),
        setupWatchFamily: meta?.setupWatchFamily,
        whaleStateAtEntry: meta?.whaleStateAtEntry,
        profileTaPlainLanguage: meta?.profileTaPlainLanguage,
        zigzagStructureAtEntry: meta?.zigzagStructureAtEntry,
        macdCrossAtEntry: meta?.macdCrossAtEntry,
        macdHistSlopeAtEntry: meta?.macdHistSlopeAtEntry,
        rsiDivergenceAtEntry: meta?.rsiDivergenceAtEntry,
        volumeDivergenceAtEntry: meta?.volumeDivergenceAtEntry,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, mode: 'live', error: message, txId: live.txId };
    }

    return {
      success: true,
      mode: 'live',
      txId: live.txId,
      quote,
      positionId: position.id,
      sendMethod: live.method,
      tipLamports: live.tipLamports,
      priorityFeeMicroLamports: live.priorityFeeMicroLamports,
      mevProtected: isMevProtectionEnabled(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[trade] Live buy failed:', message);
    return { success: false, mode: 'live', error: message };
  }
}

export async function executeSell(
  positionId: string,
  mint: string,
  tokenAmount?: number | string
): Promise<SwapResult> {
  if (usesPaperAccounting()) {
    const price = paperTrader.getTokenPrice(mint);
    if (price === undefined) {
      return {
        success: false,
        mode: config.mode,
        error: 'No price for token',
      };
    }
    const closed = paperTrader.simulateSell(positionId, price, 'manual');
    if (!closed) {
      return {
        success: false,
        mode: config.mode,
        error: 'Simulated sell failed',
      };
    }
    return { success: true, mode: config.mode, positionId };
  }

  const keypair = getKeypair();
  if (!keypair) {
    return { success: false, mode: 'live', error: 'No keypair' };
  }

  // Prefer raw amount string (avoids JS number precision loss)
  const tracked = paperTrader
    .getOpenPositions()
    .find((p) => p.id === positionId || p.mint === mint);
  const amount =
    (typeof tokenAmount === 'string' && tokenAmount) ||
    (tokenAmount != null && tokenAmount !== ''
      ? String(tokenAmount)
      : undefined) ||
    tracked?.liveTokenAmount ||
    '0';
  const quote = await getSellQuote(mint, amount);
  if (!quote) {
    return { success: false, mode: 'live', error: 'No sell quote' };
  }

  try {
    if (isMevProtectionEnabled()) {
      const sandwich = await checkSandwichRisk(mint);
      if (!sandwich.safe && config.mev.abortOnSandwichRisk) {
        return {
          success: false,
          mode: 'live',
          error: `MEV sandwich risk on sell: ${sandwich.reason}`,
          mevProtected: true,
        };
      }
    }

    const live = await executeLiveSwap(quote, keypair, mint);
    return {
      success: true,
      mode: 'live',
      txId: live.txId,
      quote,
      sendMethod: live.method,
      tipLamports: live.tipLamports,
      priorityFeeMicroLamports: live.priorityFeeMicroLamports,
      mevProtected: isMevProtectionEnabled(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, mode: 'live', error: message };
  }
}

/**
 * Build Jupiter swap with congestion-aware priority fees; Jito bundle when MEV/Jito on.
 * Turbo Mode: prefer Jito + elevated prio/tip even if global MEV UI is off.
 */
async function executeLiveSwap(
  quote: SwapQuote,
  keypair: Keypair,
  mint?: string,
  opts?: {
    turboMode?: boolean;
    turboPriorityFeeMultiplier?: number;
    turboTipMultiplier?: number;
    tradeProfileId?: string;
  }
): Promise<{
  txId: string;
  method: 'jito' | 'rpc';
  tipLamports?: number;
  priorityFeeMicroLamports?: number;
}> {
  const turbo = opts?.turboMode === true;
  let priorityMicroLamports = await estimatePriorityFeeMicroLamports(
    keypair.publicKey
  );

  if (turbo) {
    const mult =
      opts?.turboPriorityFeeMultiplier != null &&
      Number.isFinite(opts.turboPriorityFeeMultiplier) &&
      opts.turboPriorityFeeMultiplier > 0
        ? opts.turboPriorityFeeMultiplier
        : Math.max(
            config.mev?.priorityFeeMultiplier ?? 1,
            TURBO_DEFAULT_PRIORITY_FEE_MULT
          );
    priorityMicroLamports = Math.floor(priorityMicroLamports * mult);
    console.log(
      `[trade] TURBO LIVE priority fee ${priorityMicroLamports} µLamports/CU ` +
        `(×${mult})` +
        (mint ? ` mint=${mint.slice(0, 8)}…` : '') +
        (opts?.tradeProfileId ? ` profile=${opts.tradeProfileId}` : '')
    );
  } else if (isMevProtectionEnabled()) {
    const mult = config.mev.priorityFeeMultiplier ?? 1.5;
    priorityMicroLamports = Math.floor(priorityMicroLamports * mult);
    console.log(
      `[mev] Dynamic priority fee ${priorityMicroLamports} µLamports/CU ` +
        `(×${mult} congestion boost)` +
        (mint ? ` mint=${mint.slice(0, 8)}…` : '')
    );
  }

  // Approximate total priority lamports for ~200k CU (Jupiter prioritizationFeeLamports)
  const priorityLamports = Math.max(
    1_000,
    Math.min(
      2_000_000,
      Math.ceil((priorityMicroLamports * 200_000) / 1_000_000)
    )
  );

  const swapResponse = await jupiter.swapPost({
    swapRequest: {
      quoteResponse: quote as Parameters<
        typeof jupiter.swapPost
      >[0]['swapRequest']['quoteResponse'],
      userPublicKey: keypair.publicKey.toBase58(),
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: priorityLamports as never,
    },
  });

  const swapTransactionBuf = Buffer.from(
    swapResponse.swapTransaction,
    'base64'
  );

  try {
    const vtx = VersionedTransaction.deserialize(swapTransactionBuf);
    vtx.sign([keypair]);

    const wantJito = turbo || shouldUseJitoBundles();
    const tipOverride = turbo
      ? turboTipLamports(opts?.turboTipMultiplier)
      : undefined;

    if (wantJito) {
      const jito = await trySendViaJito(
        vtx,
        keypair,
        tipOverride != null ? { tipLamports: tipOverride } : undefined
      );
      if (jito) {
        console.log(
          `[${turbo ? 'trade] TURBO LIVE' : 'mev]'} Atomic Jito landing tip=${jito.tipLamports} lamports ` +
            `(${(jito.tipLamports / 1e9).toFixed(6)} SOL) bundle=${jito.bundleId}`
        );
        return {
          txId: jito.bundleId,
          method: 'jito',
          tipLamports: jito.tipLamports,
          priorityFeeMicroLamports: priorityMicroLamports,
        };
      }
      console.warn(
        `[${turbo ? 'trade] TURBO LIVE' : 'mev]'} Jito bundle failed — falling back to RPC ` +
          `(would-be tip ${tipOverride ?? effectiveTipLamports()} lamports)`
      );
    }

    const txId = await sendOptimizedTransaction(vtx.serialize());
    if (turbo) {
      console.log(
        `[trade] TURBO LIVE send=rpc (elevated prio, no Jito) ` +
          `prio=${priorityMicroLamports} µLamports/CU`
      );
    }
    return {
      txId,
      method: 'rpc',
      priorityFeeMicroLamports: priorityMicroLamports,
    };
  } catch (versionedErr) {
    console.warn(
      '[trade] Versioned send failed, trying legacy:',
      versionedErr instanceof Error ? versionedErr.message : versionedErr
    );
    const legacyTx = Transaction.from(swapTransactionBuf);
    legacyTx.partialSign(keypair);
    const txId = await sendAndConfirmLegacyTx(legacyTx);
    return {
      txId,
      method: 'rpc',
      priorityFeeMicroLamports: priorityMicroLamports,
    };
  }
}

export async function refreshPositionPrices(mints: string[]): Promise<void> {
  // Marks are refreshed by refreshOpenMarketActivity via resolveOpenTradeMark
  // (Jupiter → Dex → on-chain → last good). Skip duplicate Jupiter stampede here.
  void mints;
}
