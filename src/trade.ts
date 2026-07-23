/**
 * Jupiter aggregator swap execution.
 * Paper mode simulates; live mode uses dynamic priority fees + optional Jito MEV protection.
 */

import { createJupiterApiClient, QuoteGetRequest } from '@jup-ag/api';
import {
  Keypair,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import { config, getActiveTradingWallet, effectiveMinMarketCapUsd } from './config';
import { isDeniedCopyMint } from './deniedMints';
import {
  evaluateBuyPumpFunOnlyGate,
  evaluateHolderConcentrationHardFloors,
} from './deadTokenFilters';
import {
  getKeypair,
  estimatePriorityFeeMicroLamports,
  sendOptimizedTransaction,
  sendAndConfirmLegacyTx,
  getActiveEndpointLabel,
} from './connection';
import { trySendViaJito, effectiveTipLamports } from './jito';
import {
  checkSandwichRisk,
  isMevProtectionEnabled,
  shouldUseJitoBundles,
} from './mev';
import { paperTrader } from './paperTrader';
import { logger, errorToMeta } from './logger';
import {
  fetchLiveTokenSnapshot,
  getCachedSolUsdPrice,
  marketCapAtPrice,
} from './marketData';
import {
  fetchBondingCurve,
  estimateBondingCurvePriceSol,
  estimateBondingCurveMarketCapUsd,
} from './bondingCurve';
import { resolveTop10HoldPctForEntry } from './tokenMetrics';

const jupiter = createJupiterApiClient();

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
  mode: 'paper' | 'live';
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
  slippageBps?: number
): Promise<SwapQuote | null> {
  const amount = solToLamports(solAmount ?? config.trade.tradeAmountSol);

  const params: QuoteGetRequest = {
    inputMint: config.solMint,
    outputMint,
    amount,
    slippageBps: slippageBps ?? config.paper.slippageBps,
  };

  try {
    logger.info('Jupiter', 'quoteGet buy', {
      outputMint: outputMint.slice(0, 12),
      amount,
      slippageBps: params.slippageBps,
    });
    const quote = await jupiter.quoteGet(params);
    logger.info('Jupiter', 'quoteGet buy ok', {
      outAmount: (quote as SwapQuote).outAmount,
      priceImpactPct: (quote as SwapQuote).priceImpactPct,
    });
    return quote as SwapQuote;
  } catch (err) {
    logger.error('Jupiter', 'quoteGet buy failed', {
      outputMint: outputMint.slice(0, 12),
      amount,
      ...errorToMeta(err),
    });
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

export function quoteToPriceSol(quote: SwapQuote): number {
  const inSol = Number(quote.inAmount) / 1e9;
  const outTokens = Number(quote.outAmount);
  if (outTokens === 0) return 0;
  const tokenAmount = outTokens / 1e6;
  return inSol / tokenAmount;
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
   * Jupiter-style top-10 holder % (bonding curve / LP excluded) from anti-rug.
   * Re-checked at executeBuy; unknown fails closed.
   */
  top10HoldPct?: number | null;
}

/**
 * Resolve Buy MC at our fill.
 * Prefer active bonding-curve MC (pump truth) over Dex FDV/MC, which often
 * reports absurd tens-of-millions figures for early curve tokens when price
 * units disagree with Jupiter/curve fills.
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
        mc =
          marketCapAtPrice(mc, curvePx, fillPriceSol) ?? mc;
      }
      if (mc != null && Number.isFinite(mc) && mc > 0) curveMc = mc;
    }
  } catch {
    /* non-fatal */
  }

  let dexMc: number | undefined;
  try {
    const snap = await fetchLiveTokenSnapshot(mint);
    if (snap?.marketCapUsd && snap.marketCapUsd > 0) {
      if (snap.priceSol != null && snap.priceSol > 0 && fillPriceSol > 0) {
        const ratio = fillPriceSol / snap.priceSol;
        // Price-unit mismatch vs Dex → distrust Dex MC when we have curve.
        if (
          Number.isFinite(ratio) &&
          ratio >= 0.1 &&
          ratio <= 10
        ) {
          dexMc =
            marketCapAtPrice(
              snap.marketCapUsd,
              snap.priceSol,
              fillPriceSol
            ) ?? snap.marketCapUsd;
        } else if (curveMc == null) {
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

  // Prefer curve MC for active pumps (Dex FDV often missing/inflated).
  // Display + gate must use the same truth so Buy MC cannot show ~$2.5k
  // after a filter that saw a higher Dex MC.
  const resolved = curveMc ?? dexMc;

  if (provided != null && Number.isFinite(provided) && provided > 0) {
    // Reject provided values that look like Dex FDV blow-ups vs curve
    if (curveMc != null && provided / curveMc > 10) return curveMc;
    // Still prefer lower curve when provided is above curve on active pump
    if (curveMc != null && curveMc > 0) return Math.min(provided, curveMc);
    return provided;
  }

  return resolved;
}

/** Snapshot MC at signal / smart-wallet buy time (curve first, else Dex). */
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
  return undefined;
}

export async function executeBuy(
  mint: string,
  symbol: string,
  meta?: BuyOptions
): Promise<SwapResult> {
  if (isDeniedCopyMint(mint, config.solMint)) {
    return {
      success: false,
      mode: config.mode,
      error: `Denied mint (stable/quote) — not a copy target`,
    };
  }

  // Hard floor: only Pump.fun mints ending in `pump` when toggle is ON.
  // Covers paper + live + migration + re-buy (all executeBuy callers).
  const pumpFunGate = evaluateBuyPumpFunOnlyGate(mint);
  if (pumpFunGate) {
    console.log(
      `[trade] FILTER_SKIP mint=${mint.slice(0, 8)}… ${pumpFunGate}`
    );
    return { success: false, mode: config.mode, error: pumpFunGate };
  }

  const solAmount =
    meta?.solAmount ??
    config.trade.baseTradeAmountSol ??
    config.trade.tradeAmountSol;
  const slippageBps = meta?.slippageBps ?? config.paper.slippageBps;
  const strategyKind =
    meta?.strategyKind ?? (meta?.priority ? 'migration' : 'normal');

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

  const quote = await getQuote(mint, solAmount, slippageBps);
  let priceSol = quote ? quoteToPriceSol(quote) : null;

  // Paper: brand-new Pump.fun mints often have no Jupiter route yet —
  // fall back to bonding-curve / Dex price so signals still open positions.
  if (priceSol == null || !(priceSol > 0)) {
    if (config.mode === 'paper') {
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
  }

  if (priceSol == null || !(priceSol > 0)) {
    return {
      success: false,
      mode: config.mode,
      error: quote ? 'Invalid quote price' : 'No quote available',
    };
  }

  const entryMarketCapUsd = await resolveEntryMarketCapUsd(
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
  // Catches soft-pass / unknown-Dex cases where Buy MC would otherwise land under $5k.
  const minEntryMc = effectiveMinMarketCapUsd();
  if (entryMarketCapUsd == null || !(entryMarketCapUsd > 0)) {
    const reason = `Skipped — market cap unknown (min $${minEntryMc})`;
    console.log(
      `[trade] FILTER_SKIP mint=${mint.slice(0, 8)}… ${reason} (fill MC unresolved)`
    );
    return { success: false, mode: config.mode, error: reason };
  }
  if (entryMarketCapUsd < minEntryMc) {
    const reason =
      `Skipped — market cap too low ($${Math.round(entryMarketCapUsd)} < $${minEntryMc})`;
    console.log(
      `[trade] FILTER_SKIP mint=${mint.slice(0, 8)}… ${reason} ` +
        `(gate MC $${Math.round(entryMarketCapUsd)}, min $${minEntryMc})`
    );
    return { success: false, mode: config.mode, error: reason };
  }
  console.log(
    `[trade] Entry MC OK ${symbol}: $${Math.round(entryMarketCapUsd)} ≥ min $${minEntryMc}`
  );

  // Hard top-10 floor at execute (mirrors anti-rug). Soft-pass / early paper cannot bypass.
  const top10HoldPct = await resolveTop10HoldPctForEntry(
    mint,
    meta?.top10HoldPct
  );
  const holderGate = evaluateHolderConcentrationHardFloors({
    top10HoldPct,
    insiderPct: null,
  });
  if (holderGate.skipReasons.length > 0) {
    const reason = holderGate.skipReasons[0]!;
    console.log(
      `[trade] FILTER_SKIP mint=${mint.slice(0, 8)}… ${reason} ` +
        `(top10=${top10HoldPct != null ? top10HoldPct.toFixed(1) + '%' : '?'})`
    );
    return { success: false, mode: config.mode, error: reason };
  }
  console.log(
    `[trade] Entry top10 OK ${symbol}: ${top10HoldPct!.toFixed(1)}%`
  );

  if (config.mode === 'paper') {
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
      }
    );
    if (!position) {
      return { success: false, mode: 'paper', error: 'Paper buy failed' };
    }
    return {
      success: true,
      mode: 'paper',
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
        `MEV=${isMevProtectionEnabled() ? 'ON' : 'OFF'}`
    );
    const live = await executeLiveSwap(quote, keypair, mint);
    console.log(
      `[trade] Live buy via ${live.method} on ${getActiveEndpointLabel()}: ${live.txId}` +
        (live.tipLamports != null ? ` tip=${live.tipLamports}` : '') +
        (live.priorityFeeMicroLamports != null
          ? ` prio=${live.priorityFeeMicroLamports} µLamports/CU`
          : '')
    );

    // Track for dynamic trailing / TP-SL (does not touch paper balance)
    const outRaw = quote.outAmount;
    const amountTokens = Number(outRaw) / 1e6;
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
  if (config.mode === 'paper') {
    const price = paperTrader.getTokenPrice(mint);
    if (price === undefined) {
      return { success: false, mode: 'paper', error: 'No price for token' };
    }
    const closed = paperTrader.simulateSell(positionId, price, 'manual');
    if (!closed) {
      return { success: false, mode: 'paper', error: 'Paper sell failed' };
    }
    return { success: true, mode: 'paper', positionId };
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
 */
async function executeLiveSwap(
  quote: SwapQuote,
  keypair: Keypair,
  mint?: string
): Promise<{
  txId: string;
  method: 'jito' | 'rpc';
  tipLamports?: number;
  priorityFeeMicroLamports?: number;
}> {
  let priorityMicroLamports = await estimatePriorityFeeMicroLamports(
    keypair.publicKey
  );

  if (isMevProtectionEnabled()) {
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

    if (shouldUseJitoBundles()) {
      const jito = await trySendViaJito(vtx, keypair);
      if (jito) {
        console.log(
          `[mev] Atomic Jito landing tip=${jito.tipLamports} lamports ` +
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
        `[mev] Jito bundle failed — falling back to RPC (would-be tip ${effectiveTipLamports()} lamports)`
      );
    }

    const txId = await sendOptimizedTransaction(vtx.serialize());
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
  for (const mint of mints) {
    const quote = await getQuote(mint, 0.01);
    if (quote) {
      paperTrader.setTokenPrice(mint, quoteToPriceSol(quote));
    }
  }
}
