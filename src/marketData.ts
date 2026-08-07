/**
 * Live market data for paper simulation / backtesting.
 * Pulls recent Pump.fun / PumpSwap style launches from DexScreener + GMGN,
 * with synthetic fallbacks when APIs are unavailable.
 */

import { gmgnRequest } from './gmgn';
import { logger, errorToMeta, loggedFetch } from './logger';
import { isDeniedCopyMint } from './deniedMints';
import {
  applyCooldown,
  formatCooldownSecs,
  QuietLogGate,
} from './httpProviderGate';

export interface MarketCandle {
  /** Unix ms */
  time: number;
  /** Price in SOL per token (approx) */
  priceSol: number;
  high?: number;
  low?: number;
  volume?: number;
}

/** Supported OHLCV timeframes for multi-TF S/R. */
export type OhlcvTfLabel = '5m' | '15m' | '30m' | '1h' | '4h';
export const OHLCV_TF_LABELS: readonly OhlcvTfLabel[] = [
  '5m',
  '15m',
  '30m',
  '1h',
  '4h',
] as const;

export interface LaunchEvent {
  mint: string;
  symbol: string;
  name: string;
  /** Approx launch / first-seen time */
  launchedAt: number;
  /** Whether this looks post-migration */
  migrated: boolean;
  /** Entry price hint (SOL) */
  entryPriceSol: number;
  /** Current / last price (SOL) */
  lastPriceSol: number;
  /** Price change % over available window */
  priceChangePct: number;
  liquidityUsd?: number;
  volumeUsd?: number;
  /**
   * Circulating market cap USD at lastPriceSol (never FDV).
   * Scale with price for entry/exit MC — do not treat as entry MC.
   */
  marketCapUsd?: number;
  /** Soft risk heuristic 0–100 (higher = riskier) when anti-rug not run */
  riskScoreHint?: number;
  /** Still on / related to Pump.fun bonding curve */
  isPumpFun?: boolean;
  /** Price path for replay (oldest → newest) */
  candles: MarketCandle[];
  source: 'dexscreener' | 'gmgn' | 'birdeye' | 'jupiter' | 'kolscan' | 'synthetic';
  url?: string;
  /** SOL/USD used when this event was built (for PnL $ display) */
  solUsd?: number;
  /** Real OHLCV vs synthetic path */
  candleSource?: 'real' | 'synthetic';
  /** Multi-TF OHLCV (5m/15m/30m/1h/4h) when enrich fetched them */
  candlesByTf?: Partial<Record<OhlcvTfLabel, MarketCandle[]>>;
  volumeM5Usd?: number;
  volumeH1Usd?: number;
  volumeH6Usd?: number;
  /** Jupiter organic volume windows (when preferOrganicVolume) */
  volumeOrganicM5Usd?: number;
  volumeOrganicH1Usd?: number;
  volumeOrganicH6Usd?: number;
  volumeOrganicUsd?: number;
  /** Jupiter organicScore 0–100 when available */
  organicScore?: number;
  priceChangeH1Pct?: number;
  holderCount?: number;
  /** Per-profile specialty feed tags (additive; global scanner leaves unset) */
  preferredProfileId?: string;
  specialtyFeed?: 'jupiter' | 'kolscan' | 'alphascan';
}

function isValidMint(m: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m);
}

/** Valid mint that is not SOL / known stable / quote — safe as a copy target. */
function isCopyTargetMint(m: string): boolean {
  return isValidMint(m) && !isDeniedCopyMint(m);
}

/** Infer SOL/USD from a DexScreener pair (priceUsd / priceNative) */
export function solUsdFromPair(pair: Record<string, unknown>): number | undefined {
  const priceUsd = Number(pair.priceUsd ?? 0);
  const priceNative = Number(
    (pair as { priceNative?: string | number }).priceNative ?? 0
  );
  if (priceUsd > 0 && priceNative > 0) {
    const ratio = priceUsd / priceNative;
    if (Number.isFinite(ratio) && ratio > 10 && ratio < 10_000) return ratio;
  }
  return undefined;
}

let cachedSolUsd: { value: number; at: number } | null = null;

/** Forward-declared for Dex snapshot cache (full interface later). */
type LiveTokenSnapshotEarly = {
  priceSol: number | null;
  marketCapUsd: number | null;
  fdvUsd?: number | null;
  marketCapIsFdv?: boolean;
  volumeM5Usd: number | null;
  volumeH1Usd: number | null;
  volumeH24Usd: number | null;
  txnsH1: number | null;
};

/** Last known SOL/USD (sync). Falls back to 150 until a live fetch succeeds. */
export function getCachedSolUsdPrice(): number {
  return cachedSolUsd?.value ?? 150;
}

/** Live SOL/USD (cached ~5m). Falls back to 150. */
export async function fetchSolUsdPrice(): Promise<number> {
  if (cachedSolUsd && Date.now() - cachedSolUsd.at < 5 * 60_000) {
    return cachedSolUsd.value;
  }
  try {
    const data = await fetchJson(
      'https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112'
    );
    const pairs =
      (data as { pairs?: Record<string, unknown>[] } | null)?.pairs ?? [];
    const usdc = pairs.find((p) => {
      const q = String(
        (p.quoteToken as { symbol?: string } | undefined)?.symbol ?? ''
      ).toUpperCase();
      return q === 'USDC' || q === 'USDT';
    });
    const best = usdc ?? pairs[0];
    const px = Number(best?.priceUsd ?? 0);
    if (px > 10 && px < 10_000) {
      cachedSolUsd = { value: px, at: Date.now() };
      return px;
    }
  } catch {
    /* ignore */
  }
  return cachedSolUsd?.value ?? 150;
}

/** Soft risk 0–100 from liquidity / volume (higher = riskier) */
export function estimateRiskScoreHint(
  liquidityUsd?: number,
  volumeUsd?: number
): number {
  const liq = liquidityUsd ?? 0;
  const vol = volumeUsd ?? 0;
  let score = 35;
  if (liq <= 0) score += 30;
  else if (liq < 3_000) score += 25;
  else if (liq < 10_000) score += 12;
  else if (liq < 20_000) score += 6;
  else if (liq >= 50_000) score -= 12;
  if (vol > 0 && liq > 0 && vol / liq < 0.1) score += 8;
  if (vol >= 50_000) score -= 5;
  if (vol >= 100_000) score -= 5;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Circulating market cap vs FDV from a Dex/Gecko-style row.
 *
 * DexScreener often copies FDV into `marketCap` when circulating supply is
 * unknown (e.g. QUEST: API MC==FDV ~$254M while Jupiter `mcap` ~$10M).
 * Never promote FDV to marketCapUsd — that poisons MC gates, Live MC, and
 * any MC-scaled marks. Callers may read `fdvUsd` for FDV-labeled UI only.
 */
export function readMarketCapFields(row: Record<string, unknown>): {
  marketCapUsd?: number;
  fdvUsd?: number;
  /** True when provider MC is missing or equals FDV (circ supply unknown) */
  marketCapIsFdv: boolean;
} {
  const mc = Number(row.marketCap ?? row.market_cap ?? row.marketCapUsd ?? 0);
  const fdv = Number(row.fdv ?? row.fdvUsd ?? row.fdv_usd ?? 0);
  const hasMc = Number.isFinite(mc) && mc > 0;
  const hasFdv = Number.isFinite(fdv) && fdv > 0;

  if (hasMc && hasFdv) {
    const ratio = mc / fdv;
    // Same figure (within 5%) ⇒ circulating unknown; Dex mirrored FDV into MC
    if (ratio >= 0.95 && ratio <= 1.05) {
      return { fdvUsd: fdv, marketCapIsFdv: true };
    }
    return { marketCapUsd: mc, fdvUsd: fdv, marketCapIsFdv: false };
  }
  if (hasMc) {
    return { marketCapUsd: mc, marketCapIsFdv: false };
  }
  if (hasFdv) {
    return { fdvUsd: fdv, marketCapIsFdv: true };
  }
  return { marketCapIsFdv: false };
}

/** Circulating MC only — never FDV. */
export function readMarketCapUsd(row: Record<string, unknown>): number | undefined {
  return readMarketCapFields(row).marketCapUsd;
}

/**
 * Jupiter circulating mcap only. Do not fall back to `fdv` — that is total-supply
 * valuation and must not drive PnL, TP/SL, or MC gates.
 */
export function readJupiterMarketCapUsd(token: {
  mcap?: number | null;
  fdv?: number | null;
}): number | undefined {
  const mcap = Number(token?.mcap ?? 0);
  if (Number.isFinite(mcap) && mcap > 0) return mcap;
  return undefined;
}

/**
 * Max price multiple allowed when reconstructing a copy-trade path from
 * DexScreener % change. Stops h24 moons (+5000%) from inventing 50–100×
 * entry→exit MC rides inside a ≤90m simulation window.
 */
export const MAX_PATH_PRICE_MULTIPLE = 8;

/** Soft cap when scaling a Dex MC snapshot across prices (guards unit bugs). */
export const MAX_MC_PRICE_RATIO = 20;

/**
 * Max allowed mark/entry price multiple for paper MTM / exits.
 * Beyond this, prefer MC-scaled marks or reject the feed (unit bugs → absurd PnL).
 */
export const MAX_SANE_MARK_PRICE_RATIO = 50;

export interface ReconcileMarkPriceInput {
  entryPriceSol: number;
  markPriceSol: number;
  entryMarketCapUsd?: number;
  markMarketCapUsd?: number | null;
  /** Age of the open position (ms) — used to reject early phantom dumps/pumps */
  positionAgeMs?: number;
  /** Last accepted mark (tick spike guard) */
  prevMarkPriceSol?: number | null;
}

export interface ReconcileMarkPriceResult {
  priceSol: number;
  /** True when the raw mark was adjusted or rejected */
  adjusted: boolean;
  rejected: boolean;
  reason?: string;
}

/** Reject price dumps that Dex MC has not confirmed (flat/up) for this long after open. */
export const PHANTOM_DUMP_MC_GATE_MS = 120_000;

/** Same window for early phantom pumps (price green, MC flat). */
export const PHANTOM_PUMP_MC_GATE_MS = PHANTOM_DUMP_MC_GATE_MS;

/** Price PnL must not lead Dex MC PnL by more than this (percentage points). */
export const PHANTOM_PUMP_GAP_PCT = 8;

/** Max +% jump from previous accepted mark in one update unless MC confirms. */
export const MAX_MARK_TICK_PUMP_PCT = 12;

/**
 * Reconcile a live mark vs entry so paper PnL cannot explode from unit mismatches
 * (bonding-curve SOL/lamports, Dex native vs USD, decimal scale errors).
 *
 * Prefer MC-implied scale when price ratio disagrees with MC ratio by >10× —
 * but only when the MC ratio itself is within sane bounds. A bogus Dex FDV
 * (e.g. $119B vs $25M entry) must never force a 50× price mark.
 *
 * Early after open: if Dex MC is still near entry (or up) but the price mark shows a
 * steep dump, reject the mark (stops Dip Buyer inventing −17% SL exits while
 * live MC never moved).
 *
 * Symmetric phantom-pump: if price is strongly green but Dex MC has not confirmed
 * (flat/down), reject or clamp to MC-implied so Full TP cannot fire on junk marks.
 */
export function reconcileMarkPriceSol(
  input: ReconcileMarkPriceInput
): ReconcileMarkPriceResult {
  const entry = input.entryPriceSol;
  const mark = input.markPriceSol;
  if (!(entry > 0) || !Number.isFinite(entry)) {
    return {
      priceSol: mark,
      adjusted: false,
      rejected: !(mark > 0) || !Number.isFinite(mark),
      reason: 'bad-entry',
    };
  }
  if (!(mark > 0) || !Number.isFinite(mark)) {
    return { priceSol: entry, adjusted: true, rejected: true, reason: 'bad-mark' };
  }

  let priceSol = mark;
  let adjusted = false;
  let reason: string | undefined;

  const pxRatio = priceSol / entry;
  const ageMs =
    input.positionAgeMs != null && Number.isFinite(input.positionAgeMs)
      ? Math.max(0, Number(input.positionAgeMs))
      : null;
  const entryMc = input.entryMarketCapUsd;
  const markMc = input.markMarketCapUsd;
  const hasMc =
    entryMc != null &&
    Number.isFinite(entryMc) &&
    entryMc > 0 &&
    markMc != null &&
    Number.isFinite(markMc) &&
    markMc > 0;

  const pxPnlPct = (pxRatio - 1) * 100;
  const mcPnlPct = hasMc ? (markMc! / entryMc! - 1) * 100 : null;

  // Phantom-dump gate: price says −10%+ but Dex MC is still within ~5% of entry (or up)
  if (
    ageMs != null &&
    ageMs < PHANTOM_DUMP_MC_GATE_MS &&
    hasMc &&
    mcPnlPct != null
  ) {
    if (pxPnlPct <= -10 && mcPnlPct > -5) {
      return {
        priceSol: entry,
        adjusted: true,
        rejected: true,
        reason: `early mark/MC disagree (px ${pxPnlPct.toFixed(1)}% vs mc ${mcPnlPct.toFixed(1)}%)`,
      };
    }
  }

  // Phantom-pump gate (early): price +10%+ but Dex MC still flat/down (~within +5%)
  if (
    ageMs != null &&
    ageMs < PHANTOM_PUMP_MC_GATE_MS &&
    hasMc &&
    mcPnlPct != null
  ) {
    if (pxPnlPct >= 10 && mcPnlPct < 5) {
      return {
        priceSol: entry,
        adjusted: true,
        rejected: true,
        reason: `early phantom pump (px ${pxPnlPct.toFixed(1)}% vs mc ${mcPnlPct.toFixed(1)}%)`,
      };
    }
  }

  // Ongoing: price PnL leads MC PnL by ≥ gap → clamp mark down to MC-implied
  if (hasMc && mcPnlPct != null && pxPnlPct > mcPnlPct + PHANTOM_PUMP_GAP_PCT) {
    const mcImplied = entry * (markMc! / entryMc!);
    if (mcImplied > 0 && Number.isFinite(mcImplied) && mcImplied < priceSol) {
      priceSol = mcImplied;
      adjusted = true;
      reason = `clamp to MC (px ${pxPnlPct.toFixed(1)}% vs mc ${mcPnlPct.toFixed(1)}%)`;
    }
  }

  // NOTE: We intentionally do not scale the mark price UP from Dex MC.
  // Fresh pumps often have MC that disagrees with fill price; MC-scaling
  // previously invented fake moons when Dex mirrored FDV into marketCap
  // (e.g. circ MC $10M entry → FDV $250M "mark MC" ⇒ ~25× fake PnL).

  const rawRatio = mark / entry;
  if (
    rawRatio > MAX_SANE_MARK_PRICE_RATIO ||
    rawRatio < 1 / MAX_SANE_MARK_PRICE_RATIO
  ) {
    return {
      priceSol: entry,
      adjusted: true,
      rejected: true,
      reason: `absurd ratio ${rawRatio.toExponential(2)}`,
    };
  }

  // Large raw moves need circulating-MC confirmation aligned with price.
  // Checked on the *incoming* mark (before tick-cap) so a poisoned feed
  // cannot ratchet HWM via repeated +12% caps up to max-profit / FDV ratio.
  const LARGE_MOVE_RATIO = 3;
  if (rawRatio > LARGE_MOVE_RATIO || rawRatio < 1 / LARGE_MOVE_RATIO) {
    if (!hasMc || mcPnlPct == null) {
      return {
        priceSol: entry,
        adjusted: true,
        rejected: true,
        reason: `large move ${rawRatio.toFixed(2)}x without MC confirm`,
      };
    }
    const mcRatio = markMc! / entryMc!;
    const disagree =
      mcRatio / rawRatio > 2.5 || rawRatio / mcRatio > 2.5;
    if (disagree) {
      return {
        priceSol: entry,
        adjusted: true,
        rejected: true,
        reason: `price/MC disagree at large move (px ${rawRatio.toFixed(2)}x vs mc ${mcRatio.toFixed(2)}x)`,
      };
    }
  }

  // Tick spike: sudden jump from last accepted mark without MC confirmation.
  // Only runs after large-move gate so we never walk toward a rejected target.
  const prev = input.prevMarkPriceSol;
  if (
    prev != null &&
    Number.isFinite(prev) &&
    prev > 0 &&
    priceSol > prev * (1 + MAX_MARK_TICK_PUMP_PCT / 100)
  ) {
    const tickPct = (priceSol / prev - 1) * 100;
    const mcConfirmsTick =
      hasMc &&
      mcPnlPct != null &&
      Math.abs(mcPnlPct - (priceSol / entry - 1) * 100) <= PHANTOM_PUMP_GAP_PCT;
    if (!mcConfirmsTick) {
      const capped = prev * (1 + MAX_MARK_TICK_PUMP_PCT / 100);
      priceSol = Math.min(priceSol, capped);
      adjusted = true;
      reason = `tick pump cap ${tickPct.toFixed(1)}%→${MAX_MARK_TICK_PUMP_PCT}%`;
    }
  }

  return {
    priceSol,
    adjusted,
    rejected: false,
    reason,
  };
}

export interface ResolveExitMarketCapInput {
  entryMarketCapUsd?: number | null;
  entryPriceSol: number;
  /** Same mark used for PnL / fill (prefer pre-slip mark for implied MC) */
  exitPriceSol: number;
  liveMarketCapUsd?: number | null;
}

export interface ResolvedExitMarketCaps {
  /** Primary UI MC — fill-scaled so Buy→Exit MC tracks PnL */
  displayUsd?: number;
  /** Fill-scaled MC (entry × exit/entry) — matches PnL direction */
  impliedFromFillUsd?: number;
  /** Live Dex MC at exit (audit / tooltip only; may disagree with fill) */
  liveUsd?: number;
  source: 'live' | 'implied' | 'none';
}

/**
 * Resolve exit MC for display + audit.
 * Always prefer fill-implied (entry × exit/entry) when available so Closed Trades
 * Buy→Exit MC tracks the same mark basis as PnL. Live Dex is returned as `liveUsd`
 * for tooltips only — never as the column when it invents a pump against a dump fill.
 */
export function resolveExitMarketCaps(
  input: ResolveExitMarketCapInput
): ResolvedExitMarketCaps {
  const entry = input.entryPriceSol;
  const exit = input.exitPriceSol;
  const entryMc = input.entryMarketCapUsd;
  const liveMc =
    input.liveMarketCapUsd != null &&
    Number.isFinite(input.liveMarketCapUsd) &&
    input.liveMarketCapUsd > 0
      ? input.liveMarketCapUsd
      : undefined;

  const impliedFromFillUsd =
    entryMc != null &&
    Number.isFinite(entryMc) &&
    entryMc > 0 &&
    entry > 0 &&
    exit >= 0
      ? marketCapAtPrice(entryMc, entry, exit)
      : undefined;

  if (impliedFromFillUsd != null && impliedFromFillUsd > 0) {
    return {
      displayUsd: impliedFromFillUsd,
      impliedFromFillUsd,
      liveUsd: liveMc,
      source: 'implied',
    };
  }

  if (liveMc != null) {
    return {
      displayUsd: liveMc,
      impliedFromFillUsd,
      liveUsd: liveMc,
      source: 'live',
    };
  }

  return {
    displayUsd: undefined,
    impliedFromFillUsd,
    liveUsd: liveMc,
    source: 'none',
  };
}

/**
 * Full-trade Exit MC when a position closed in multiple legs (partials + final).
 * Cost-weighted average of leg Exit MCs so the summary tracks realized PnL,
 * not only the last bag's fade print. Falls back to Buy MC × (1 + totalPnl%).
 */
export function tradeLevelExitMarketCapUsd(input: {
  entryMarketCapUsd?: number;
  totalPnlPct?: number;
  legs: Array<{ exitMarketCapUsd?: number | null; costSol?: number | null }>;
}): number | undefined {
  let costSum = 0;
  let weighted = 0;
  for (const leg of input.legs || []) {
    const mc = Number(leg.exitMarketCapUsd);
    const cost = Number(leg.costSol);
    if (!(mc > 0) || !(cost > 0) || !Number.isFinite(mc) || !Number.isFinite(cost)) {
      continue;
    }
    weighted += mc * cost;
    costSum += cost;
  }
  if (costSum > 0 && weighted > 0) {
    return weighted / costSum;
  }
  const entry = Number(input.entryMarketCapUsd);
  const pct = Number(input.totalPnlPct);
  if (entry > 0 && Number.isFinite(entry) && Number.isFinite(pct)) {
    return entry * (1 + pct / 100);
  }
  return undefined;
}

/**
 * Exit MC tracks the PnL mark: entry×(exit/entry) when entry MC is known.
 */
export function resolveExitMarketCapUsd(
  input: ResolveExitMarketCapInput
): number | undefined {
  return resolveExitMarketCaps(input).displayUsd;
}

/**
 * One-shot / idempotent repair for historical closed rows where Exit MC preferred
 * live Dex while PnL used the fill mark. Rewrites Exit MC to fill-scaled only —
 * never touches pnlSol / pnlPct / cost (overview Realized stays correct).
 */
export function alignClosedExitMarketCapToFill<T extends {
  entryMarketCapUsd?: number;
  entryPriceSol?: number;
  exitPriceSol?: number;
  exitMarketCapUsd?: number;
  impliedExitMarketCapUsd?: number;
  liveExitMarketCapUsd?: number;
  pnlPct?: number;
}>(pos: T): { pos: T; changed: boolean } {
  const entryMc = pos.entryMarketCapUsd;
  const entryPx = pos.entryPriceSol;
  const exitPx = pos.exitPriceSol;
  if (
    entryMc == null ||
    !(entryMc > 0) ||
    entryPx == null ||
    !(entryPx > 0) ||
    exitPx == null ||
    !(exitPx >= 0)
  ) {
    return { pos, changed: false };
  }

  const fillImplied =
    pos.impliedExitMarketCapUsd != null &&
    Number.isFinite(pos.impliedExitMarketCapUsd) &&
    pos.impliedExitMarketCapUsd > 0
      ? pos.impliedExitMarketCapUsd
      : marketCapAtPrice(entryMc, entryPx, exitPx);

  if (fillImplied == null || !(fillImplied > 0)) {
    return { pos, changed: false };
  }

  const display = pos.exitMarketCapUsd;
  // Multi-leg rollups store a PnL/size-weighted Exit MC that intentionally
  // differs from the last bag's fill — don't "repair" those back to last-fill.
  const pnlPct = Number(pos.pnlPct);
  if (
    display != null &&
    Number.isFinite(display) &&
    display > 0 &&
    Number.isFinite(pnlPct) &&
    entryMc > 0
  ) {
    const pnlImplied = entryMc * (1 + pnlPct / 100);
    const vsPnl =
      Math.abs(display - pnlImplied) / Math.max(pnlImplied, 1);
    const vsFill =
      Math.abs(display - fillImplied) / Math.max(fillImplied, 1);
    if (vsPnl <= 0.08 && vsFill > 0.12) {
      return { pos, changed: false };
    }
  }

  const alreadyAligned =
    display != null &&
    Number.isFinite(display) &&
    display > 0 &&
    Math.abs(display - fillImplied) / Math.max(fillImplied, 1) <= 0.01;

  if (
    alreadyAligned &&
    pos.impliedExitMarketCapUsd != null &&
    Math.abs(Number(pos.impliedExitMarketCapUsd) - fillImplied) /
      Math.max(fillImplied, 1) <=
      0.01
  ) {
    return { pos, changed: false };
  }

  const next = { ...pos };
  // Preserve prior Dex/display as live tooltip when it disagreed with fill
  if (
    display != null &&
    Number.isFinite(display) &&
    display > 0 &&
    Math.abs(display - fillImplied) / Math.max(fillImplied, 1) > 0.05 &&
    (next.liveExitMarketCapUsd == null || !(next.liveExitMarketCapUsd > 0))
  ) {
    next.liveExitMarketCapUsd = display;
  }
  next.exitMarketCapUsd = fillImplied;
  next.impliedExitMarketCapUsd = fillImplied;
  return { pos: next, changed: true };
}

/** Align all closed rows; returns how many Exit MC values were rewritten. */
export function alignClosedExitMarketCapsToFill<T extends {
  entryMarketCapUsd?: number;
  entryPriceSol?: number;
  exitPriceSol?: number;
  exitMarketCapUsd?: number;
  impliedExitMarketCapUsd?: number;
  liveExitMarketCapUsd?: number;
  pnlPct?: number;
}>(closed: T[]): { closed: T[]; fixed: number } {
  let fixed = 0;
  const out = closed.map((p) => {
    const { pos, changed } = alignClosedExitMarketCapToFill(p);
    if (changed) fixed += 1;
    return pos;
  });
  return { closed: out, fixed };
}

/**
 * True when a candidate mark MC is usable vs an open entry (guards FDV bugs).
 * Rejects jumps that look like circ-MC → FDV swaps (~10–30×) unless caller
 * opts into a higher ceiling.
 */
export function isSaneMarkMarketCapUsd(
  entryMarketCapUsd: number | undefined | null,
  markMarketCapUsd: number | undefined | null,
  opts?: { maxRatio?: number; priceRatio?: number | null }
): boolean {
  if (
    markMarketCapUsd == null ||
    !Number.isFinite(markMarketCapUsd) ||
    markMarketCapUsd <= 0
  ) {
    return false;
  }
  if (
    entryMarketCapUsd == null ||
    !Number.isFinite(entryMarketCapUsd) ||
    entryMarketCapUsd <= 0
  ) {
    return true;
  }
  const maxRatio = opts?.maxRatio ?? MAX_SANE_MARK_PRICE_RATIO;
  const ratio = markMarketCapUsd / entryMarketCapUsd;
  if (
    !Number.isFinite(ratio) ||
    ratio <= 0 ||
    ratio > maxRatio ||
    ratio < 1 / maxRatio
  ) {
    return false;
  }
  // When price barely moved, reject huge MC jumps (classic FDV-as-MC poison)
  const pxRatio = opts?.priceRatio;
  if (
    pxRatio != null &&
    Number.isFinite(pxRatio) &&
    pxRatio > 0 &&
    ratio > 3 &&
    (ratio / pxRatio > 2.5 || pxRatio / ratio > 2.5)
  ) {
    return false;
  }
  return true;
}

export type PriceChangePick = {
  pct: number;
  windowMs: number;
  source: 'm5' | 'h1' | 'h6' | 'h24' | 'none';
};

/**
 * Prefer the shortest non-zero Dex change window so reconstructed *entry price*
 * stays aligned with the move that just happened (avoid h24 % as entry basis).
 * Path *duration* is handled separately in resolveLaunchPathWindow (floors m5).
 */
export function pickPriceChangeForPath(
  pair: Record<string, unknown>
): PriceChangePick {
  const pc = pair.priceChange as
    | { m5?: number; h1?: number; h6?: number; h24?: number }
    | undefined;
  const candidates: Array<{
    source: PriceChangePick['source'];
    pct: number;
    windowMs: number;
  }> = [
    { source: 'm5', pct: Number(pc?.m5), windowMs: 5 * 60_000 },
    { source: 'h1', pct: Number(pc?.h1), windowMs: 60 * 60_000 },
    { source: 'h6', pct: Number(pc?.h6), windowMs: 6 * 60 * 60_000 },
    { source: 'h24', pct: Number(pc?.h24), windowMs: 24 * 60 * 60_000 },
  ];
  for (const c of candidates) {
    if (Number.isFinite(c.pct) && c.pct !== 0) {
      return { pct: c.pct, windowMs: c.windowMs, source: c.source };
    }
  }
  return { pct: 0, windowMs: 60 * 60_000, source: 'none' };
}

/**
 * Reconstruct path-start price from current price + % change, clamped so
 * we never invent absurd copy-trade moons from a 24h Dex %.
 */
export function reconstructEntryPriceSol(
  lastPriceSol: number,
  changePct: number,
  opts?: { maxMultiple?: number; fallbackFactor?: number }
): number {
  const maxMult = opts?.maxMultiple ?? MAX_PATH_PRICE_MULTIPLE;
  const fallback = opts?.fallbackFactor ?? 0.7;
  if (!(lastPriceSol > 0) || !Number.isFinite(lastPriceSol)) return 0;

  // Near -100% would explode entry; treat as invalid
  if (!Number.isFinite(changePct) || changePct <= -95) {
    return lastPriceSol * fallback;
  }

  const denom = 1 + changePct / 100;
  if (!(denom > 0)) return lastPriceSol * fallback;

  let entry = lastPriceSol / denom;
  if (!(entry > 0) || !Number.isFinite(entry)) {
    return lastPriceSol * fallback;
  }

  const lo = lastPriceSol / maxMult;
  const hi = lastPriceSol * maxMult;
  return Math.min(hi, Math.max(lo, entry));
}

/** Effective % change after clamp (for storage / display). */
export function effectivePriceChangePct(
  entryPriceSol: number,
  lastPriceSol: number
): number {
  if (!(entryPriceSol > 0) || !Number.isFinite(lastPriceSol)) return 0;
  return ((lastPriceSol - entryPriceSol) / entryPriceSol) * 100;
}

/**
 * Scale a reference market cap from refPriceSol → atPriceSol.
 * DexScreener MC is always at the current/last price snapshot.
 */
export function marketCapAtPrice(
  referenceMcUsd: number | undefined,
  referencePriceSol: number,
  atPriceSol: number
): number | undefined {
  if (
    referenceMcUsd == null ||
    !Number.isFinite(referenceMcUsd) ||
    referenceMcUsd <= 0 ||
    !(referencePriceSol > 0) ||
    !Number.isFinite(atPriceSol) ||
    atPriceSol < 0
  ) {
    return undefined;
  }
  const ratio = atPriceSol / referencePriceSol;
  if (!Number.isFinite(ratio) || ratio < 0) return undefined;
  // Clamp pathological ratios (wrong units / tiny ref price) instead of
  // reporting hundreds of millions of exit MC from a bad scale factor.
  const clamped = Math.min(
    MAX_MC_PRICE_RATIO,
    Math.max(1 / MAX_MC_PRICE_RATIO, ratio)
  );
  return referenceMcUsd * clamped;
}

/**
 * Estimate liquidity USD at an earlier/later price from a DexScreener snapshot.
 * Uses sqrt scaling (AMM-like) so early-curve liq isn't overstated vs current pool.
 */
export function liquidityAtPrice(
  referenceLiqUsd: number | undefined,
  referencePriceSol: number,
  atPriceSol: number
): number | undefined {
  if (
    referenceLiqUsd == null ||
    !Number.isFinite(referenceLiqUsd) ||
    referenceLiqUsd <= 0 ||
    !(referencePriceSol > 0) ||
    !Number.isFinite(atPriceSol) ||
    atPriceSol <= 0
  ) {
    return undefined;
  }
  const ratio = atPriceSol / referencePriceSol;
  if (!Number.isFinite(ratio) || ratio <= 0) return undefined;
  const clamped = Math.min(
    MAX_MC_PRICE_RATIO,
    Math.max(1 / MAX_MC_PRICE_RATIO, ratio)
  );
  return referenceLiqUsd * Math.sqrt(Math.max(clamped, 1e-12));
}

/**
 * Backtest / paper replay path length after launch.
 *
 * IMPORTANT: DexScreener m5/h1 % is great for reconstructing entry price, but
 * must NOT shrink the sim path. A ≥1h floor still left Smart Money Mirror with
 * ~53m "Forced Lookback ended" holds: path = 1h from launch, entry ~12% in
 * (+ copy delay) → remaining candles run out before TP 30–50% / trail can arm.
 *
 * Floor path duration at ≥3h when the token is old enough (min ≥2h); cap at 6h
 * so we don't stretch pairCreated→now into multi-day holds for mature launches.
 *
 * Scalp timers top out around 7–8 minutes — these floors keep post-entry path
 * well beyond any scalp hardTimeLimit so timer/TP/SL/trail can fire first.
 */
export function resolveLaunchPathWindow(opts: {
  launchedAt: number;
  nowMs?: number;
  /**
   * Dex change window used for entry reconstruction (m5/h1/h6/h24).
   * Short windows (m5/h1) are floored for path *duration* only — see pathHintMs.
   */
  changeWindowMs?: number;
  maxPathMs?: number;
  minPathMs?: number;
}): { startMs: number; endMs: number; durationMs: number } {
  const now = opts.nowMs ?? Date.now();
  const startMs = opts.launchedAt > 0 ? opts.launchedAt : now - 30 * 60_000;
  const ageMs = Math.max(0, now - startMs);
  const changeWin = opts.changeWindowMs ?? 6 * 60 * 60 * 1000;
  // Never let m5/h1 reconstruction windows truncate swing replay — Mirror /
  // Trend / HWR need multi-hour post-entry candles for TP/SL/trail.
  const pathHintMs = Math.max(changeWin, 3 * 60 * 60_000); // ≥3h
  const maxPath = opts.maxPathMs ?? 6 * 60 * 60 * 1000; // 6 hours
  const minPath = opts.minPathMs ?? 2 * 60 * 60_000; // 2 hours

  let durationMs = Math.min(
    ageMs > 0 ? ageMs : pathHintMs,
    pathHintMs,
    maxPath
  );
  if (ageMs > 0 && ageMs < minPath) {
    // Truly young / near end of lookback — use remaining age (real EOW).
    // Cannot invent future beyond now; scalpCover (~12m) is informational only.
    durationMs = Math.max(3 * 60_000, ageMs);
  } else {
    durationMs = Math.max(minPath, durationMs);
  }
  // Never simulate past "now" / lookback end
  if (ageMs > 0) durationMs = Math.min(durationMs, ageMs);

  return { startMs, endMs: startMs + durationMs, durationMs };
}

/** Candle count so multi-hour paths keep ~1–2m resolution (cap for perf). */
export function pathStepsForDuration(
  durationMs: number,
  minSteps = 36
): number {
  const raw = Math.max(0, durationMs);
  const targetStepMs = raw <= 90 * 60_000 ? 45_000 : 90_000;
  return Math.max(minSteps, Math.min(240, Math.round(raw / targetStepMs) || minSteps));
}

/** Which change % window we used → duration hint for path compression */
export function changeWindowMsFromPair(
  pair: Record<string, unknown>
): number {
  return pickPriceChangeForPath(pair).windowMs;
}

/** Build a realistic candle path from entry → last with bounded noise */
export function buildPricePath(
  entryPriceSol: number,
  lastPriceSol: number,
  startMs: number,
  endMs: number,
  steps = 24
): MarketCandle[] {
  const candles: MarketCandle[] = [];
  const raw = Math.max(0, endMs - startMs);
  // Keep caller window length — do NOT inflate short ages up to steps*30s
  // (that previously stamped every thin path at ~12–18m and forced identical EOW holds).
  // Only pad empty/degenerate windows so we still get a usable series.
  const duration = raw > 0 ? raw : Math.max(steps * 30_000, 3 * 60_000);
  const hi = Math.max(entryPriceSol, lastPriceSol);
  const lo = Math.min(entryPriceSol, lastPriceSol);
  // Path magnitude drives local volatility (bigger moves → choppier mid-path)
  const movePct =
    entryPriceSol > 0
      ? Math.abs(lastPriceSol - entryPriceSol) / entryPriceSol
      : 0;
  const vol = Math.min(0.12, 0.03 + movePct * 0.08);
  // Modest room below path low for temporary drawdowns (not free moons)
  const floor = lo * Math.max(0.82, 1 - vol * 1.5);
  const ceiling = hi * Math.min(1.08, 1 + vol * 0.6);

  let px = entryPriceSol;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Geometric (log) blend — more realistic than linear for meme paths
    const logBlend =
      entryPriceSol > 0 && lastPriceSol > 0
        ? Math.exp(
            Math.log(entryPriceSol) * (1 - t) + Math.log(lastPriceSol) * t
          )
        : entryPriceSol + (lastPriceSol - entryPriceSol) * t;
    // Mean-revert noise toward the blend; occasional dump-then-recover
    const shock =
      1 +
      Math.sin(i * 2.1 + movePct * 3) * vol * 0.7 +
      (Math.random() - 0.5) * vol * 1.2;
    const dump =
      i > steps * 0.25 &&
      i < steps * 0.55 &&
      Math.random() < 0.22 + movePct * 0.15
        ? 0.88 + Math.random() * 0.07
        : 1;
    // Pull previous price toward blend (prevents random walk exploding)
    const target = logBlend * shock * dump;
    px = px * 0.35 + target * 0.65;
    px = Math.min(ceiling, Math.max(floor, px));
    candles.push({
      time: startMs + duration * t,
      priceSol: px,
    });
  }

  candles[0].priceSol = entryPriceSol;
  candles[0].time = startMs;
  candles[candles.length - 1].priceSol = lastPriceSol;
  candles[candles.length - 1].time = startMs + duration;
  return candles;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** —— DexScreener rate-limit guard (shared across mark / activity callers) —— */
const DEX_SNAPSHOT_CACHE_TTL_MS = 75_000;
const DEX_FALLBACK_REFRESH_MS = 100_000;
const DEX_HEALTHY_REFRESH_MS = 55_000;
const DEX_COOLDOWN_BASE_MS = 15_000;
const DEX_COOLDOWN_CAP_MS = 4 * 60_000;
const DEX_DEBUG =
  String(process.env.DEXSCREENER_DEBUG || '').toLowerCase() === '1' ||
  String(process.env.DEXSCREENER_DEBUG || '').toLowerCase() === 'true';

let dexRateLimitedUntil = 0;
let dexCooldownStreak = 0;
let lastDexCooldownLogAt = 0;
let lastMarkFailoverLogAt = 0;
let lastMarkFallbackLogAt = 0;
/** Last successful open-trade mark source (for health detail). */
let lastOpenMarkSource: OpenTradeMarkSource = 'none';
let lastOpenMarkSourceAt = 0;

const JUPITER_MARK_CACHE_TTL_MS = 25_000;
const jupiterMarkCache = new Map<
  string,
  {
    priceSol: number;
    marketCapUsd: number | null;
    source: 'jupiter_tokens' | 'jupiter_quote';
    at: number;
  }
>();
const jupiterMarkInflight = new Map<
  string,
  Promise<{
    priceSol: number;
    marketCapUsd: number | null;
    source: 'jupiter_tokens' | 'jupiter_quote';
  } | null>
>();

export function getLastOpenMarkSource(): {
  source: OpenTradeMarkSource;
  at: number;
} {
  return { source: lastOpenMarkSource, at: lastOpenMarkSourceAt };
}

function noteOpenMarkSource(source: OpenTradeMarkSource): void {
  lastOpenMarkSource = source;
  lastOpenMarkSourceAt = Date.now();
}

function logMarkFailover(from: string, to: string): void {
  const now = Date.now();
  if (now - lastMarkFailoverLogAt < 60_000) return;
  lastMarkFailoverLogAt = now;
  console.warn(`[mark] Failover: ${from} → ${to}`);
}

function logMarkFallbackInUse(source: string): void {
  const now = Date.now();
  if (now - lastMarkFallbackLogAt < 60_000) return;
  lastMarkFallbackLogAt = now;
  console.warn(`[mark] Open-trade mark fallback in use (${source})`);
}

const dexSnapshotCache = new Map<
  string,
  { snap: LiveTokenSnapshotEarly; at: number }
>();
const dexSnapshotInflight = new Map<
  string,
  Promise<LiveTokenSnapshotEarly | null>
>();

export function isDexScreenerInCooldown(): boolean {
  return Date.now() < dexRateLimitedUntil;
}

export function getDexScreenerCooldownRemainingMs(): number {
  return Math.max(0, dexRateLimitedUntil - Date.now());
}

export function getDexScreenerStatus(): {
  inCooldown: boolean;
  remainingMs: number;
  streak: number;
} {
  return {
    inCooldown: isDexScreenerInCooldown(),
    remainingMs: getDexScreenerCooldownRemainingMs(),
    streak: dexCooldownStreak,
  };
}

function enterDexCooldown(reason = '429'): void {
  dexCooldownStreak += 1;
  const ms = Math.min(
    DEX_COOLDOWN_CAP_MS,
    DEX_COOLDOWN_BASE_MS * Math.pow(2, Math.min(dexCooldownStreak - 1, 4))
  );
  const until = Date.now() + ms;
  if (until > dexRateLimitedUntil) dexRateLimitedUntil = until;
  const now = Date.now();
  if (now - lastDexCooldownLogAt >= 60_000) {
    lastDexCooldownLogAt = now;
    console.warn(
      `[DexScreener] rate-limited — cooldown ${Math.round(ms / 1000)}s (${reason})`
    );
  }
}

function clearDexCooldownOnSuccess(): void {
  if (dexCooldownStreak > 0 || dexRateLimitedUntil > 0) {
    dexCooldownStreak = 0;
    dexRateLimitedUntil = 0;
  }
}

function isDexUrl(url: string): boolean {
  return url.includes('dexscreener.com');
}

/** Fetch JSON with retries + backoff. Dex paths use cooldown + quieter 429 logs. */
async function fetchJson(
  url: string,
  timeoutMs = 12_000,
  maxAttempts = 3
): Promise<unknown | null> {
  const isDex = isDexUrl(url);
  const context = isDex
    ? 'DexScreener'
    : url.includes('gmgn')
      ? 'GMGN'
      : 'MarketData';

  if (isDex && isDexScreenerInCooldown()) {
    return null;
  }

  const attempts = isDex ? Math.min(2, maxAttempts) : maxAttempts;
  let lastErr = '';
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await loggedFetch(url, {
        context,
        label: 'marketData',
        timeoutMs,
        attempt: attempt + 1,
        maxAttempts: attempts,
        logBodyOnError: isDex ? DEX_DEBUG : true,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'solana-smart-copy-bot/1.0',
        },
      });
      if (res.status === 429) {
        lastErr = '429';
        if (isDex) {
          enterDexCooldown('429');
          return null;
        }
        logger.warn(context, 'rate limited — retrying', {
          attempt: attempt + 1,
          url: url.slice(0, 120),
        });
        await sleep(1_500 * (attempt + 1) + Math.random() * 500);
        continue;
      }
      if (res.status >= 500) {
        lastErr = `HTTP ${res.status}`;
        await sleep(400 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        return null;
      }
      const json = await res.json();
      if (isDex) clearDexCooldownOnSuccess();
      return json;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      if (!isDex || DEX_DEBUG) {
        logger.error(context, 'fetch attempt failed', {
          attempt: attempt + 1,
          maxAttempts: attempts,
          url: url.slice(0, 120),
          ...errorToMeta(err),
        });
      }
      await sleep(300 * (attempt + 1) + Math.random() * 200);
    }
  }
  if (lastErr && (!isDex || DEX_DEBUG)) {
    logger.warn(context, 'fetch exhausted', {
      url: url.slice(0, 120),
      lastErr,
      maxAttempts: attempts,
    });
  }
  return null;
}

/** Run async work with limited concurrency */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R | null>
): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      const result = await fn(items[idx]);
      if (result != null) out.push(result);
    }
  }
  const n = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

/** DexScreener — recent Solana pairs that look like pump / pumpswap */
async function fetchFromDexScreener(
  fromMs: number,
  toMs: number
): Promise<LaunchEvent[]> {
  const endpoints = [
    'https://api.dexscreener.com/token-boosts/latest/v1',
    'https://api.dexscreener.com/token-profiles/latest/v1',
  ];

  const events: LaunchEvent[] = [];
  const seen = new Set<string>();

  for (const url of endpoints) {
    const data = await fetchJson(url, 8_000, 2);
    if (!data || !Array.isArray(data)) continue;

    for (const row of data as Record<string, unknown>[]) {
      const chain = String(row.chainId ?? row.chain ?? '');
      if (chain && chain !== 'solana') continue;

      const tokenAddress = String(row.tokenAddress ?? row.address ?? '');
      if (!isCopyTargetMint(tokenAddress) || seen.has(tokenAddress)) continue;

      // Fetch pair details
      const pairData = await fetchJson(
        `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`
      );
      const pairs =
        (pairData as { pairs?: Record<string, unknown>[] } | null)?.pairs ?? [];
      if (!Array.isArray(pairs) || pairs.length === 0) continue;

      const solPairs = pairs.filter(
        (p) =>
          String(p.chainId) === 'solana' &&
          (String(p.dexId).toLowerCase().includes('pump') ||
            String(p.url ?? '').includes('pump') ||
            Number(p.liquidity && (p.liquidity as { usd?: number }).usd) < 500_000)
      );

      // Prefer deepest SOL pool (avoids stale bonding-curve pair MC)
      const ranked = (solPairs.length ? solPairs : pairs).slice().sort((a, b) => {
        const la = Number(
          (a.liquidity as { usd?: number } | undefined)?.usd ?? 0
        );
        const lb = Number(
          (b.liquidity as { usd?: number } | undefined)?.usd ?? 0
        );
        return lb - la;
      });
      const pair = ranked[0] as Record<string, unknown>;
      if (!pair) continue;

      const createdAt = Number(pair.pairCreatedAt ?? Date.now());
      if (createdAt < fromMs || createdAt > toMs) continue;

      const priceUsd = Number(pair.priceUsd ?? 0);
      const solFromPair = solUsdFromPair(pair as Record<string, unknown>);
      const solUsd = solFromPair ?? 150;
      const priceNative = Number(
        (pair as { priceNative?: string }).priceNative ?? priceUsd / solUsd
      );
      if (!priceNative || priceNative <= 0) continue;

      const picked = pickPriceChangeForPath(pair as Record<string, unknown>);
      const entry = reconstructEntryPriceSol(priceNative, picked.pct);
      const change = effectivePriceChangePct(entry, priceNative);
      const symbol = String(
        (pair.baseToken as { symbol?: string } | undefined)?.symbol ??
          tokenAddress.slice(0, 6)
      );
      const name = String(
        (pair.baseToken as { name?: string } | undefined)?.name ?? symbol
      );
      const dexId = String(pair.dexId ?? '').toLowerCase();
      const migrated = dexId.includes('pump') === false || dexId.includes('pumpswap');
      const pathWin = resolveLaunchPathWindow({
        launchedAt: createdAt,
        nowMs: Math.min(toMs, Date.now()),
        changeWindowMs: picked.windowMs,
      });

      seen.add(tokenAddress);
      events.push({
        mint: tokenAddress,
        symbol,
        name,
        launchedAt: createdAt,
        migrated: Boolean(migrated || dexId.includes('raydium')),
        entryPriceSol: entry > 0 ? entry : priceNative * 0.7,
        lastPriceSol: priceNative,
        priceChangePct: change,
        liquidityUsd: Number(
          (pair.liquidity as { usd?: number } | undefined)?.usd ?? 0
        ) || undefined,
        volumeUsd: Number(
          (pair.volume as { h24?: number } | undefined)?.h24 ?? 0
        ) || undefined,
        marketCapUsd: readMarketCapUsd(pair as Record<string, unknown>),
        riskScoreHint: estimateRiskScoreHint(
          Number((pair.liquidity as { usd?: number } | undefined)?.usd ?? 0) ||
            undefined,
          Number((pair.volume as { h24?: number } | undefined)?.h24 ?? 0) ||
            undefined
        ),
        isPumpFun:
          dexId.includes('pump') ||
          String(pair.url ?? '').includes('pump.fun'),
        candles: buildPricePath(
          entry > 0 ? entry : priceNative * 0.7,
          priceNative,
          pathWin.startMs,
          pathWin.endMs,
          pathStepsForDuration(pathWin.durationMs, 36)
        ),
        source: 'dexscreener',
        url: String(pair.url ?? ''),
        solUsd,
      });

      if (events.length >= 60) break;
    }
    if (events.length >= 60) break;
  }

  // Always search pump/solana pairs to widen the pool (boosts alone are thin)
  {
    const queries = [
      'pump%20solana',
      'pumpswap',
      'raydium%20solana',
    ];
    for (const q of queries) {
      if (events.length >= 60) break;
      const search = await fetchJson(
        `https://api.dexscreener.com/latest/dex/search?q=${q}`
      );
      const pairs =
        (search as { pairs?: Record<string, unknown>[] } | null)?.pairs ?? [];
      for (const pair of pairs.slice(0, 40)) {
        if (String(pair.chainId) !== 'solana') continue;
        const mint = String(
          (pair.baseToken as { address?: string } | undefined)?.address ?? ''
        );
        if (!isCopyTargetMint(mint) || seen.has(mint)) continue;

        const createdAt = Number(pair.pairCreatedAt ?? 0);
        if (!createdAt || createdAt < fromMs || createdAt > toMs) continue;

        const priceNative = Number(
          (pair as { priceNative?: string }).priceNative ?? 0
        );
        if (priceNative <= 0) continue;

        const picked = pickPriceChangeForPath(pair);
        const entry = reconstructEntryPriceSol(priceNative, picked.pct, {
          fallbackFactor: 0.6,
        });
        const change = effectivePriceChangePct(entry, priceNative);
        const symbol = String(
          (pair.baseToken as { symbol?: string } | undefined)?.symbol ??
            mint.slice(0, 6)
        );
        const name = String(
          (pair.baseToken as { name?: string } | undefined)?.name ?? symbol
        );
        const solUsd = solUsdFromPair(pair) ?? 150;
        const pathWin = resolveLaunchPathWindow({
          launchedAt: createdAt,
          nowMs: Math.min(toMs, Date.now()),
          changeWindowMs: picked.windowMs,
        });
        const liqUsd =
          Number(
            (pair.liquidity as { usd?: number } | undefined)?.usd ?? 0
          ) || undefined;
        const volUsd =
          Number((pair.volume as { h24?: number } | undefined)?.h24 ?? 0) ||
          undefined;

        seen.add(mint);
        events.push({
          mint,
          symbol,
          name,
          launchedAt: createdAt,
          migrated: String(pair.dexId).toLowerCase().includes('raydium'),
          entryPriceSol: entry > 0 ? entry : priceNative * 0.6,
          lastPriceSol: priceNative,
          priceChangePct: change,
          liquidityUsd: liqUsd,
          volumeUsd: volUsd,
          marketCapUsd: readMarketCapUsd(pair as Record<string, unknown>),
          riskScoreHint: estimateRiskScoreHint(liqUsd, volUsd),
          isPumpFun:
            String(pair.dexId ?? '')
              .toLowerCase()
              .includes('pump') ||
            String(pair.url ?? '').includes('pump.fun'),
          candles: buildPricePath(
            entry > 0 ? entry : priceNative * 0.6,
            priceNative,
            pathWin.startMs,
            pathWin.endMs,
            pathStepsForDuration(pathWin.durationMs, 48)
          ),
          source: 'dexscreener',
          url: String(pair.url ?? ''),
          solUsd,
        });
        if (events.length >= 60) break;
      }
    }
  }

  console.log(`[marketData] DexScreener: ${events.length} launch(es) in window`);
  return events;
}

/** GMGN-style new pairs via authenticated client + path fallbacks */
async function fetchFromGmgn(
  fromMs: number,
  toMs: number
): Promise<LaunchEvent[]> {
  const paths = [
    '/defi/quotation/v1/pairs/sol/new_pairs?limit=50&orderby=open_timestamp&direction=desc',
    '/defi/quotation/v1/rank/sol/pump/1h?orderby=progress&direction=desc',
    '/v1/pairs/sol/new_pairs?limit=50&orderby=open_timestamp&direction=desc',
  ];

  const events: LaunchEvent[] = [];

  for (const path of paths) {
    const res = await gmgnRequest(path, 15_000);
    if (!res.ok || !res.data) {
      if (res.error) {
        console.warn(`[marketData] GMGN path failed: ${res.error}`);
      }
      continue;
    }

    const data = res.data;
    const list =
      (data as { data?: unknown[] }).data ??
      (data as { data?: { rank?: unknown[] } }).data?.rank ??
      (Array.isArray(data) ? data : []);
    if (!Array.isArray(list)) continue;

    for (const item of list) {
      const row = item as Record<string, unknown>;
      const mint = String(
        row.address ?? row.base_address ?? row.token_address ?? ''
      );
      if (!isCopyTargetMint(mint)) continue;

      const openTs = Number(row.open_timestamp ?? row.created_timestamp ?? 0);
      const launchedAt = openTs < 1e12 ? openTs * 1000 : openTs;
      if (!launchedAt || launchedAt < fromMs || launchedAt > toMs) continue;

      const price = Number(row.price ?? row.price_sol ?? 0);
      if (price <= 0) continue;

      const rawChange = Number(row.price_change_percent ?? row.price_change ?? 0);
      const entry = reconstructEntryPriceSol(price, rawChange);
      const change = effectivePriceChangePct(entry, price);
      const symbol = String(row.symbol ?? mint.slice(0, 6));
      const pathWin = resolveLaunchPathWindow({
        launchedAt,
        nowMs: Math.min(toMs, Date.now()),
        changeWindowMs: 60 * 60_000,
      });

      events.push({
        mint,
        symbol,
        name: String(row.name ?? symbol),
        launchedAt,
        migrated: Boolean(row.migrated ?? row.is_migrated),
        entryPriceSol: entry > 0 ? entry : price * 0.7,
        lastPriceSol: price,
        priceChangePct: change,
        liquidityUsd: Number(row.liquidity ?? 0) || undefined,
        volumeUsd: Number(row.volume ?? 0) || undefined,
        marketCapUsd: readMarketCapUsd(row),
        riskScoreHint: estimateRiskScoreHint(
          Number(row.liquidity ?? 0) || undefined,
          Number(row.volume ?? 0) || undefined
        ),
        isPumpFun: !Boolean(row.migrated ?? row.is_migrated),
        candles: buildPricePath(
          entry > 0 ? entry : price * 0.7,
          price,
          pathWin.startMs,
          pathWin.endMs,
          pathStepsForDuration(pathWin.durationMs, 36)
        ),
        source: 'gmgn',
        solUsd: 150,
      });
    }

    if (events.length > 0) break;
  }

  console.log(`[marketData] GMGN: ${events.length} launch(es) in window`);
  return events;
}

/** Synthetic memecoin scenarios when live APIs fail */
export function generateSyntheticLaunches(
  fromMs: number,
  toMs: number,
  count = 12
): LaunchEvent[] {
  const events: LaunchEvent[] = [];
  const span = Math.max(toMs - fromMs, 60_000);
  const wallets = ['Cented', 'Theo', 'Decu', 'Megga', 'Unknown'];

  for (let i = 0; i < count; i++) {
    const launchedAt = fromMs + Math.floor((span * (i + 1)) / (count + 1));
    const entry = 1e-8 * (1 + Math.random() * 50);

    // Quality tier drives BOTH outcome distribution and liq/vol/risk —
    // so selective filters actually change which trades survive.
    const quality = Math.random(); // 0 = junk, 1 = high quality
    let mult: number;
    let liquidityUsd: number;
    let volumeUsd: number;
    let riskScoreHint: number;
    let migrated: boolean;

    if (quality < 0.4) {
      // Junk / dump — fails low-risk filters, often fails medium
      mult = 0.15 + Math.random() * 0.55;
      liquidityUsd = 800 + Math.random() * 4_000;
      volumeUsd = 200 + Math.random() * 2_500;
      riskScoreHint = Math.round(55 + Math.random() * 35);
      migrated = Math.random() > 0.75;
    } else if (quality < 0.7) {
      // Mid quality — flat to modest moves
      mult = 0.7 + Math.random() * 0.8;
      liquidityUsd = 4_000 + Math.random() * 12_000;
      volumeUsd = 3_000 + Math.random() * 15_000;
      riskScoreHint = Math.round(35 + Math.random() * 30);
      migrated = Math.random() > 0.45;
    } else if (quality < 0.9) {
      // Strong — more winners
      mult = 1.4 + Math.random() * 2.5;
      liquidityUsd = 12_000 + Math.random() * 40_000;
      volumeUsd = 12_000 + Math.random() * 60_000;
      riskScoreHint = Math.round(18 + Math.random() * 28);
      migrated = Math.random() > 0.35;
    } else {
      // Moon — rare
      mult = 3 + Math.random() * 10;
      liquidityUsd = 20_000 + Math.random() * 80_000;
      volumeUsd = 25_000 + Math.random() * 120_000;
      riskScoreHint = Math.round(10 + Math.random() * 25);
      migrated = Math.random() > 0.3;
    }

    const last = entry * mult;
    const mint = `SynthMint${String(i).padStart(2, '0')}${String(launchedAt).slice(-20)}`.slice(
      0,
      44
    );
    // 45m–4h so non-scalp profiles (Mirror etc.) can hit TP/SL/trail before EOW
    const holdMs = (45 + Math.random() * 195) * 60_000;

    events.push({
      mint,
      symbol: `SYN${i}`,
      name: `Synthetic ${wallets[i % wallets.length]} #${i}`,
      launchedAt,
      migrated,
      entryPriceSol: entry,
      lastPriceSol: last,
      priceChangePct: (mult - 1) * 100,
      liquidityUsd,
      volumeUsd,
      marketCapUsd: 20_000 + Math.random() * 500_000,
      riskScoreHint,
      isPumpFun: !migrated || Math.random() > 0.4,
      candles: buildPricePath(
        entry,
        last,
        launchedAt,
        launchedAt + holdMs,
        pathStepsForDuration(holdMs, 48)
      ),
      source: 'synthetic',
      solUsd: 150,
    });
  }

  console.log(`[marketData] Synthetic: ${events.length} scenario(s)`);
  return events;
}

export interface FetchLaunchesOptions {
  fromMs?: number;
  toMs?: number;
  /** Prefer live APIs; fall back to synthetic */
  allowSynthetic?: boolean;
  maxResults?: number;
}

/** Fetch recent launches/migrations for the given window.
 * Prefer GMGN when healthy, then Dex; scanner merges AlphaScan/Jupiter separately.
 */
export async function fetchRecentLaunches(
  options: FetchLaunchesOptions = {}
): Promise<{ events: LaunchEvent[]; source: string }> {
  const toMs = options.toMs ?? Date.now();
  const fromMs = options.fromMs ?? toMs - 24 * 60 * 60 * 1000;
  const allowSynthetic = options.allowSynthetic !== false;
  const maxResults = options.maxResults ?? 60;

  console.log(
    `[marketData] Fetching launches ${new Date(fromMs).toISOString()} → ${new Date(toMs).toISOString()}`
  );

  let events: LaunchEvent[] = [];
  const sources: string[] = [];

  const mergeUnique = (incoming: LaunchEvent[], label: string) => {
    if (incoming.length === 0) return;
    const seen = new Set(events.map((e) => e.mint));
    let added = 0;
    for (const e of incoming) {
      if (seen.has(e.mint)) continue;
      events.push(e);
      seen.add(e.mint);
      added += 1;
    }
    if (added > 0) sources.push(label);
  };

  // 1) GMGN when healthy (skip during provider cooldown)
  try {
    const { isGmgnInCooldown } =
      require('./gmgn') as typeof import('./gmgn');
    if (!isGmgnInCooldown()) {
      const gmgn = await fetchFromGmgn(fromMs, toMs);
      mergeUnique(gmgn, 'gmgn');
    }
  } catch (err) {
    console.warn('[marketData] GMGN failed:', err);
  }

  // 2) DexScreener trending/new enrichment when healthy
  try {
    if (!isDexScreenerInCooldown()) {
      const dex = await fetchFromDexScreener(fromMs, toMs);
      mergeUnique(dex, 'dexscreener');
    }
  } catch (err) {
    console.warn('[marketData] DexScreener failed:', err);
  }

  // Pad with synthetic when live pool is thin (not only when empty)
  if (allowSynthetic && events.length < Math.min(maxResults, 12)) {
    const need = Math.min(maxResults, 20) - events.length;
    if (need > 0) {
      const synth = generateSyntheticLaunches(fromMs, toMs, need);
      events.push(...synth);
      sources.push('synthetic');
    }
  }

  if (events.length === 0 && allowSynthetic) {
    events = generateSyntheticLaunches(fromMs, toMs, 16);
    sources.push('synthetic');
  }

  const source = sources.length > 0 ? sources.join('+') : 'none';
  events.sort((a, b) => a.launchedAt - b.launchedAt);
  console.log(
    `[marketData] Launch pool: ${events.length} event(s) from ${source}`
  );
  return { events: events.slice(0, maxResults), source };
}

/** Apply live last-price to an open mint (for live paper mode) */
export async function fetchLivePriceSol(mint: string): Promise<number | null> {
  const snap = await fetchLiveTokenSnapshot(mint);
  return snap?.priceSol ?? null;
}

export interface LiveTokenSnapshot {
  priceSol: number | null;
  /** Circulating market cap USD — never FDV */
  marketCapUsd: number | null;
  /** Fully diluted valuation when provided (UI / audit only) */
  fdvUsd?: number | null;
  /** True when provider only had FDV (MC left null) */
  marketCapIsFdv?: boolean;
  /** Rolling 5m USD volume from DexScreener best pool */
  volumeM5Usd: number | null;
  /** Rolling 1h USD volume from DexScreener best pool */
  volumeH1Usd: number | null;
  /** Rolling 24h USD volume */
  volumeH24Usd: number | null;
  /** Buys + sells in the last hour (DexScreener txns.h1) */
  txnsH1: number | null;
}

export type OpenTradeMarkSource =
  | 'dex'
  | 'dex_cache'
  | 'jupiter_tokens'
  | 'jupiter_quote'
  | 'onchain'
  | 'last_good'
  | 'none';

export interface OpenTradeMarkResult {
  priceSol: number | null;
  marketCapUsd: number | null;
  volumeM5Usd: number | null;
  volumeH1Usd: number | null;
  volumeH24Usd: number | null;
  txnsH1: number | null;
  source: OpenTradeMarkSource;
  stale: boolean;
  at: number;
}

function parseDexSnapshot(data: unknown): LiveTokenSnapshot | null {
  const pairs =
    (data as { pairs?: Record<string, unknown>[] } | null)?.pairs ?? [];
  const solPairs = pairs.filter((p) => String(p.chainId) === 'solana');
  if (solPairs.length === 0) return null;

  let best = solPairs[0]!;
  let bestLiq = Number(
    (best.liquidity as { usd?: number } | undefined)?.usd ??
      best.liquidityUsd ??
      0
  );
  for (const p of solPairs) {
    const liq = Number(
      (p.liquidity as { usd?: number } | undefined)?.usd ?? p.liquidityUsd ?? 0
    );
    if (liq > bestLiq) {
      best = p;
      bestLiq = liq;
    }
  }

  const priceNative = Number(
    (best as { priceNative?: string }).priceNative ?? 0
  );
  const priceUsd = Number((best as { priceUsd?: string }).priceUsd ?? 0);
  const solFromPair = solUsdFromPair(best as Record<string, unknown>);
  if (solFromPair != null) {
    cachedSolUsd = { value: solFromPair, at: Date.now() };
  }
  const solUsd = getCachedSolUsdPrice();
  const priceFromUsd =
    priceUsd > 0 && solUsd > 0 ? priceUsd / solUsd : null;

  let priceSol: number | null = null;
  if (priceNative > 0 && priceFromUsd != null && priceFromUsd > 0) {
    const r = priceNative / priceFromUsd;
    if (r > 1.25 || r < 0.8) {
      priceSol = priceFromUsd;
    } else {
      priceSol = Math.min(priceNative, priceFromUsd);
    }
  } else if (priceNative > 0) {
    priceSol = priceNative;
  } else if (priceFromUsd != null && priceFromUsd > 0) {
    priceSol = priceFromUsd;
  }

  const mcFields = readMarketCapFields(best);
  const marketCapUsd = mcFields.marketCapUsd ?? null;
  const volume = best.volume as
    | { m5?: number; h1?: number; h24?: number }
    | undefined;
  const txnsH1 = best.txns as
    | { h1?: { buys?: number; sells?: number } }
    | undefined;
  const buys = Number(txnsH1?.h1?.buys ?? 0);
  const sells = Number(txnsH1?.h1?.sells ?? 0);
  const volumeM5Usd = Number(volume?.m5 ?? NaN);
  const volumeH1Usd = Number(volume?.h1 ?? NaN);
  const volumeH24Usd = Number(volume?.h24 ?? NaN);
  const txnsTotal = buys + sells;

  return {
    priceSol,
    marketCapUsd: marketCapUsd != null && marketCapUsd > 0 ? marketCapUsd : null,
    fdvUsd:
      mcFields.fdvUsd != null && mcFields.fdvUsd > 0 ? mcFields.fdvUsd : null,
    marketCapIsFdv: mcFields.marketCapIsFdv,
    volumeM5Usd: Number.isFinite(volumeM5Usd) ? volumeM5Usd : null,
    volumeH1Usd: Number.isFinite(volumeH1Usd) ? volumeH1Usd : null,
    volumeH24Usd: Number.isFinite(volumeH24Usd) ? volumeH24Usd : null,
    txnsH1: Number.isFinite(txnsTotal) ? txnsTotal : null,
  };
}

async function fetchDexSnapshotUncached(
  mint: string
): Promise<LiveTokenSnapshot | null> {
  const data = await fetchJson(
    `https://api.dexscreener.com/latest/dex/tokens/${mint}`
  );
  if (!data) return null;
  return parseDexSnapshot(data);
}

/**
 * DexScreener snapshot: price + market cap + short-window activity.
 * Cached + in-flight deduped; serves last good during cooldown.
 */
export async function fetchLiveTokenSnapshot(
  mint: string
): Promise<LiveTokenSnapshot | null> {
  if (!isCopyTargetMint(mint)) return null;
  const key = String(mint);
  const now = Date.now();
  const cached = dexSnapshotCache.get(key);
  if (cached && now - cached.at < DEX_SNAPSHOT_CACHE_TTL_MS) {
    return cached.snap;
  }
  if (isDexScreenerInCooldown()) {
    return cached?.snap ?? null;
  }

  const existing = dexSnapshotInflight.get(key);
  if (existing) return existing;

  const job = (async () => {
    try {
      const snap = await fetchDexSnapshotUncached(key);
      if (snap && (snap.priceSol == null || snap.priceSol > 0)) {
        dexSnapshotCache.set(key, { snap, at: Date.now() });
      }
      return snap ?? cached?.snap ?? null;
    } catch {
      return cached?.snap ?? null;
    } finally {
      dexSnapshotInflight.delete(key);
    }
  })();
  dexSnapshotInflight.set(key, job);
  return job;
}

async function fetchJupiterTokenMark(
  mint: string
): Promise<{ priceSol: number; marketCapUsd: number | null } | null> {
  try {
    const { fetchJupiterTokenByMint, hasJupiterApiKey } =
      require('./jupiterTokens') as typeof import('./jupiterTokens');
    if (!hasJupiterApiKey()) return null;
    const tok = await fetchJupiterTokenByMint(mint);
    const usd = Number(tok?.usdPrice ?? 0);
    const solUsd = getCachedSolUsdPrice();
    if (!(usd > 0) || !(solUsd > 0)) return null;
    const priceSol = usd / solUsd;
    if (!(priceSol > 0) || !Number.isFinite(priceSol)) return null;
    const mcap = readJupiterMarketCapUsd(tok ?? {});
    return {
      priceSol,
      marketCapUsd: mcap != null && mcap > 0 ? mcap : null,
    };
  } catch {
    return null;
  }
}

async function fetchJupiterQuoteMark(
  mint: string
): Promise<number | null> {
  try {
    const { getQuote, quoteToPriceSol, resolveTokenDecimals } =
      require('./trade') as typeof import('./trade');
    const decimals = await resolveTokenDecimals(mint);
    const quote = await Promise.race([
      getQuote(mint, 0.01, undefined, { quiet: true }),
      sleep(8_000).then(() => null),
    ]);
    if (!quote) return null;
    const px = quoteToPriceSol(quote, decimals);
    return px > 0 && Number.isFinite(px) ? px : null;
  } catch {
    return null;
  }
}

/** Jupiter Tokens then quiet quote — cached + inflight-deduped. */
async function resolveJupiterMark(mint: string): Promise<{
  priceSol: number;
  marketCapUsd: number | null;
  source: 'jupiter_tokens' | 'jupiter_quote';
} | null> {
  const cached = jupiterMarkCache.get(mint);
  if (cached && Date.now() - cached.at < JUPITER_MARK_CACHE_TTL_MS) {
    return {
      priceSol: cached.priceSol,
      marketCapUsd: cached.marketCapUsd,
      source: cached.source,
    };
  }
  const pending = jupiterMarkInflight.get(mint);
  if (pending) return pending;

  const job = (async () => {
    try {
      const jTok = await fetchJupiterTokenMark(mint);
      if (jTok) {
        const hit = {
          priceSol: jTok.priceSol,
          marketCapUsd: jTok.marketCapUsd,
          source: 'jupiter_tokens' as const,
        };
        jupiterMarkCache.set(mint, { ...hit, at: Date.now() });
        return hit;
      }
      const jQuote = await fetchJupiterQuoteMark(mint);
      if (jQuote != null) {
        const hit = {
          priceSol: jQuote,
          marketCapUsd: null as number | null,
          source: 'jupiter_quote' as const,
        };
        jupiterMarkCache.set(mint, { ...hit, at: Date.now() });
        return hit;
      }
      return null;
    } finally {
      jupiterMarkInflight.delete(mint);
    }
  })();
  jupiterMarkInflight.set(mint, job);
  return job;
}

async function resolveOnchainBondingMark(
  mint: string
): Promise<{ priceSol: number; marketCapUsd: number | null } | null> {
  try {
    const { fetchBondingCurve, estimateBondingCurvePriceSol } =
      require('./bondingCurve') as typeof import('./bondingCurve');
    const state = await Promise.race([
      fetchBondingCurve(mint),
      sleep(4_000).then(() => null),
    ]);
    if (!state || state.source === 'none') return null;
    const priceSol = estimateBondingCurvePriceSol(state);
    if (priceSol == null || !(priceSol > 0)) return null;
    return { priceSol, marketCapUsd: null };
  } catch {
    return null;
  }
}

/**
 * Open-trade mark resolver: Jupiter → Dex → on-chain bonding curve → last good.
 */
export async function resolveOpenTradeMark(
  mint: string,
  opts?: { lastGoodPriceSol?: number | null }
): Promise<OpenTradeMarkResult> {
  const now = Date.now();
  const empty = (): OpenTradeMarkResult => ({
    priceSol: null,
    marketCapUsd: null,
    volumeM5Usd: null,
    volumeH1Usd: null,
    volumeH24Usd: null,
    txnsH1: null,
    source: 'none',
    stale: true,
    at: now,
  });

  if (!isCopyTargetMint(mint)) return empty();

  const cached = dexSnapshotCache.get(mint);
  const volBase = cached?.snap;

  // 1) Jupiter first (Tokens → quiet quote)
  const jup = await resolveJupiterMark(mint);
  if (jup) {
    noteOpenMarkSource(jup.source);
    return {
      priceSol: jup.priceSol,
      marketCapUsd: jup.marketCapUsd ?? volBase?.marketCapUsd ?? null,
      volumeM5Usd: volBase?.volumeM5Usd ?? null,
      volumeH1Usd: volBase?.volumeH1Usd ?? null,
      volumeH24Usd: volBase?.volumeH24Usd ?? null,
      txnsH1: volBase?.txnsH1 ?? null,
      source: jup.source,
      stale: false,
      at: now,
    };
  }

  // 2) DexScreener (live if healthy, else short-lived cache)
  logMarkFailover('Jupiter', 'DexScreener');
  const dexOk = !isDexScreenerInCooldown();
  if (dexOk) {
    const snap = await fetchLiveTokenSnapshot(mint);
    if (snap?.priceSol != null && snap.priceSol > 0) {
      const src: OpenTradeMarkSource =
        cached && now - cached.at < 5_000 ? 'dex_cache' : 'dex';
      noteOpenMarkSource(src);
      return {
        ...snap,
        source: src,
        stale: false,
        at: now,
      };
    }
  } else if (cached?.snap?.priceSol != null && cached.snap.priceSol > 0) {
    const age = now - cached.at;
    if (age < DEX_SNAPSHOT_CACHE_TTL_MS * 2) {
      noteOpenMarkSource('dex_cache');
      return {
        ...cached.snap,
        source: 'dex_cache',
        stale: age > DEX_SNAPSHOT_CACHE_TTL_MS,
        at: cached.at,
      };
    }
  }

  // 3) On-chain bonding-curve spot (Helius/Alchemy RPC lanes)
  logMarkFailover('DexScreener', 'on-chain');
  const onchain = await resolveOnchainBondingMark(mint);
  if (onchain) {
    logMarkFallbackInUse('onchain');
    noteOpenMarkSource('onchain');
    return {
      priceSol: onchain.priceSol,
      marketCapUsd: onchain.marketCapUsd ?? volBase?.marketCapUsd ?? null,
      volumeM5Usd: volBase?.volumeM5Usd ?? null,
      volumeH1Usd: volBase?.volumeH1Usd ?? null,
      volumeH24Usd: volBase?.volumeH24Usd ?? null,
      txnsH1: volBase?.txnsH1 ?? null,
      source: 'onchain',
      stale: false,
      at: now,
    };
  }

  // 4) Last known good
  const last =
    opts?.lastGoodPriceSol != null && opts.lastGoodPriceSol > 0
      ? opts.lastGoodPriceSol
      : cached?.snap?.priceSol != null && cached.snap.priceSol > 0
        ? cached.snap.priceSol
        : null;

  if (last != null) {
    logMarkFallbackInUse('last_good');
    noteOpenMarkSource('last_good');
    return {
      priceSol: last,
      marketCapUsd: volBase?.marketCapUsd ?? null,
      volumeM5Usd: volBase?.volumeM5Usd ?? null,
      volumeH1Usd: volBase?.volumeH1Usd ?? null,
      volumeH24Usd: volBase?.volumeH24Usd ?? null,
      txnsH1: volBase?.txnsH1 ?? null,
      source: 'last_good',
      stale: true,
      at: cached?.at ?? now,
    };
  }

  noteOpenMarkSource('none');
  return empty();
}

/** Fetch symbol + name for a mint from DexScreener (best-effort) */
export async function fetchTokenInfo(
  mint: string
): Promise<{ symbol: string; name: string } | null> {
  if (!isValidMint(mint)) return null;
  const data = await fetchJson(
    `https://api.dexscreener.com/latest/dex/tokens/${mint}`
  );
  const pairs =
    (data as { pairs?: Record<string, unknown>[] } | null)?.pairs ?? [];
  const sol =
    pairs.find((p) => String(p.chainId) === 'solana') ?? pairs[0];
  if (!sol) return null;
  const base = sol.baseToken as { symbol?: string; name?: string } | undefined;
  const symbol = String(base?.symbol ?? '').trim();
  const name = String(base?.name ?? '').trim();
  if (!symbol && !name) return null;
  return {
    symbol: symbol || name,
    name: name || symbol,
  };
}

const lastActivityFetchAt = new Map<string, number>();
const OPEN_MARK_BUDGET_MS = 6_000;

/**
 * Refresh open-position marks + activity.
 * Jupiter → Dex → on-chain → last good via resolveOpenTradeMark; per-mint fail-open.
 */
export async function refreshOpenMarketActivity(
  trader: {
    getOpenPositions: () => Array<{ mint: string }>;
    getTokenPrice?: (mint: string) => number | undefined;
    setMarketActivity: (
      mint: string,
      sample: {
        volumeH1Usd: number;
        txnsH1: number;
        updatedAt?: number;
        volumeM5Usd?: number | null;
      }
    ) => void;
    setTokenPrice?: (
      mint: string,
      priceSol: number,
      meta?: {
        marketCapUsd?: number | null;
        markSource?: string;
        stale?: boolean;
      }
    ) => void;
    setMarkMarketCapUsd?: (
      mint: string,
      marketCapUsd: number | null | undefined
    ) => void;
  },
  options: { force?: boolean; budgetMs?: number } = {}
): Promise<number> {
  const open = trader.getOpenPositions();
  if (open.length === 0) return 0;

  const now = Date.now();
  const mints = [...new Set(open.map((p) => p.mint))];
  let updated = 0;
  const minGap = isDexScreenerInCooldown()
    ? DEX_FALLBACK_REFRESH_MS
    : DEX_HEALTHY_REFRESH_MS;
  const budgetMs = Math.max(2_000, options.budgetMs ?? OPEN_MARK_BUDGET_MS);
  const deadline = now + budgetMs;

  void fetchSolUsdPrice();

  for (const mint of mints) {
    if (Date.now() > deadline) break;
    const last = lastActivityFetchAt.get(mint) ?? 0;
    if (!options.force && now - last < minGap) {
      continue;
    }
    lastActivityFetchAt.set(mint, Date.now());

    try {
      const lastGood =
        typeof trader.getTokenPrice === 'function'
          ? trader.getTokenPrice(mint)
          : undefined;
      const mark = await resolveOpenTradeMark(mint, {
        lastGoodPriceSol: lastGood,
      });
      if (!mark || mark.source === 'none') continue;

      if (mark.volumeH1Usd != null || mark.txnsH1 != null || mark.volumeM5Usd != null) {
        trader.setMarketActivity(mint, {
          volumeH1Usd: mark.volumeH1Usd ?? 0,
          txnsH1: mark.txnsH1 ?? 0,
          volumeM5Usd: mark.volumeM5Usd ?? null,
          updatedAt: mark.at,
        });
      }
      if (
        mark.priceSol != null &&
        mark.priceSol > 0 &&
        typeof trader.setTokenPrice === 'function'
      ) {
        trader.setTokenPrice(mint, mark.priceSol, {
          marketCapUsd: mark.marketCapUsd,
          markSource: mark.source,
          stale: mark.stale,
        });
      } else if (mark.marketCapUsd != null && mark.marketCapUsd > 0) {
        trader.setMarkMarketCapUsd?.(mint, mark.marketCapUsd);
      }
      updated += 1;
    } catch {
      /* best-effort — keep prior cache */
    }
  }

  return updated;
}

const OHLCV_CACHE_TTL_MS = 105_000;

const OHLCV_TF_MS: Record<OhlcvTfLabel, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
};

/** Gecko minute aggregate for ≤60m; hour aggregate for 4h. */
const GECKO_TF_SPEC: Record<
  OhlcvTfLabel,
  { path: 'minute' | 'hour'; aggregate: number; limit: number }
> = {
  '5m': { path: 'minute', aggregate: 5, limit: 100 },
  '15m': { path: 'minute', aggregate: 15, limit: 100 },
  '30m': { path: 'minute', aggregate: 30, limit: 100 },
  '1h': { path: 'minute', aggregate: 60, limit: 100 },
  '4h': { path: 'hour', aggregate: 4, limit: 48 },
};

function ohlcvCacheKey(mint: string, tf: OhlcvTfLabel = '5m'): string {
  return `${mint}:${tf}`;
}

const ohlcvCache = new Map<
  string,
  {
    candles: MarketCandle[];
    source: 'geckoterminal' | 'dex_sparse' | 'resampled' | 'none';
    solUsd?: number;
    at: number;
    tf: OhlcvTfLabel;
  }
>();

export interface FetchTokenOhlcvResult {
  candles: MarketCandle[];
  source: 'geckoterminal' | 'dex_sparse' | 'resampled' | 'none';
  solUsd?: number;
  tf?: OhlcvTfLabel;
}

const geckoOhlcvInflight = new Map<
  string,
  Promise<FetchTokenOhlcvResult>
>();

const GECKO_COOLDOWN_BASE_MS = 15_000;
const GECKO_COOLDOWN_CAP_MS = 4 * 60_000;
let geckoRateLimitedUntil = 0;
let geckoCooldownStreak = 0;
const geckoCooldownLog = new QuietLogGate(60_000);

export function isGeckoTerminalInCooldown(): boolean {
  return Date.now() < geckoRateLimitedUntil;
}

export function getGeckoTerminalCooldownRemainingMs(): number {
  return Math.max(0, geckoRateLimitedUntil - Date.now());
}

export function getGeckoTerminalStatus(): {
  inCooldown: boolean;
  remainingMs: number;
  streak: number;
} {
  return {
    inCooldown: isGeckoTerminalInCooldown(),
    remainingMs: getGeckoTerminalCooldownRemainingMs(),
    streak: geckoCooldownStreak,
  };
}

function enterGeckoCooldown(reason = '429'): void {
  geckoCooldownStreak += 1;
  const { until, durationMs } = applyCooldown({
    streak: geckoCooldownStreak,
    baseMs: GECKO_COOLDOWN_BASE_MS,
    capMs: GECKO_COOLDOWN_CAP_MS,
    currentUntil: geckoRateLimitedUntil,
  });
  geckoRateLimitedUntil = until;
  if (geckoCooldownLog.allow()) {
    const label = reason === '429' || reason.startsWith('http_')
      ? reason === '429'
        ? '429'
        : reason.replace('http_', '')
      : reason;
    logger.warn(
      'GeckoTerminal',
      `${label === '429' ? '429' : label} — cooldown ${formatCooldownSecs(durationMs)}`,
      { reason, streak: geckoCooldownStreak }
    );
  }
}

function clearGeckoCooldownOnSuccess(): void {
  if (geckoCooldownStreak > 0 || geckoRateLimitedUntil > 0) {
    geckoCooldownStreak = 0;
    geckoRateLimitedUntil = 0;
  }
}

function staleOhlcv(
  mint: string,
  tf: OhlcvTfLabel = '5m'
): FetchTokenOhlcvResult | null {
  const cached = ohlcvCache.get(ohlcvCacheKey(mint, tf));
  if (!cached || !cached.candles.length) return null;
  return {
    candles: cached.candles,
    source: cached.source,
    solUsd: cached.solUsd,
    tf: cached.tf,
  };
}

/** Aggregate lower-TF candles into a higher TF (OHLCV). */
export function resampleOhlcvCandles(
  candles: MarketCandle[],
  tf: OhlcvTfLabel
): MarketCandle[] {
  const bucketMs = OHLCV_TF_MS[tf];
  if (!(bucketMs > 0) || !candles.length) return [];
  const buckets = new Map<
    number,
    {
      time: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }
  >();
  for (const c of candles) {
    if (!(c.priceSol > 0) || !(c.time > 0)) continue;
    const key = Math.floor(c.time / bucketMs) * bucketMs;
    const high = c.high != null && c.high > 0 ? c.high : c.priceSol;
    const low = c.low != null && c.low > 0 ? c.low : c.priceSol;
    const vol = c.volume != null && Number.isFinite(c.volume) ? c.volume : 0;
    const prev = buckets.get(key);
    if (!prev) {
      buckets.set(key, {
        time: key,
        open: c.priceSol,
        high,
        low,
        close: c.priceSol,
        volume: vol,
      });
    } else {
      prev.high = Math.max(prev.high, high);
      prev.low = Math.min(prev.low, low);
      prev.close = c.priceSol;
      prev.volume += vol;
    }
  }
  return [...buckets.values()]
    .sort((a, b) => a.time - b.time)
    .map((b) => {
      const c: MarketCandle = { time: b.time, priceSol: b.close };
      if (b.high > 0) c.high = b.high;
      if (b.low > 0) c.low = b.low;
      if (b.volume > 0) c.volume = b.volume;
      return c;
    });
}

function usdClosesToSolCandles(
  rows: Array<{
    time: number;
    close: number;
    high?: number;
    low?: number;
    volume?: number;
  }>,
  solUsd: number
): MarketCandle[] {
  if (!(solUsd > 0)) return [];
  const out: MarketCandle[] = [];
  for (const r of rows) {
    if (!(r.close > 0) || !(r.time > 0)) continue;
    const priceSol = r.close / solUsd;
    const c: MarketCandle = { time: r.time, priceSol };
    if (r.high != null && r.high > 0) c.high = r.high / solUsd;
    if (r.low != null && r.low > 0) c.low = r.low / solUsd;
    if (r.volume != null && Number.isFinite(r.volume)) c.volume = r.volume;
    out.push(c);
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * Best-effort sparse candles from Dex pair snapshot (no official OHLCV API).
 * Anchors current priceNative and walks priceChange windows into ≥8 bars.
 */
async function fetchDexSparseOhlcv(
  mint: string,
  _solUsd: number
): Promise<MarketCandle[]> {
  if (isDexScreenerInCooldown()) {
    const cached = dexSnapshotCache.get(mint);
    if (cached?.snap?.priceSol != null && cached.snap.priceSol > 0) {
      return sparseCandlesFromPriceSol(cached.snap.priceSol, null);
    }
    return [];
  }
  try {
    const data = await fetchJson(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`
    );
    if (!data) return [];
    const pairs =
      (data as { pairs?: Record<string, unknown>[] } | null)?.pairs ?? [];
    const solPairs = pairs.filter((p) => String(p.chainId) === 'solana');
    if (solPairs.length === 0) return [];
    let best = solPairs[0]!;
    let bestLiq = Number(
      (best.liquidity as { usd?: number } | undefined)?.usd ?? 0
    );
    for (const p of solPairs) {
      const liq = Number(
        (p.liquidity as { usd?: number } | undefined)?.usd ?? 0
      );
      if (liq > bestLiq) {
        best = p;
        bestLiq = liq;
      }
    }
    const priceNative = Number(
      (best as { priceNative?: string }).priceNative ?? 0
    );
    if (!(priceNative > 0)) return [];
    const change = best.priceChange as
      | { m5?: number; h1?: number; h6?: number; h24?: number }
      | undefined;
    return sparseCandlesFromPriceSol(priceNative, change ?? null);
  } catch (err) {
    logger.warn('MarketData', 'Dex sparse OHLCV failed', errorToMeta(err));
    return [];
  }
}

function sparseCandlesFromPriceSol(
  lastPriceSol: number,
  change: { m5?: number; h1?: number; h6?: number; h24?: number } | null
): MarketCandle[] {
  if (!(lastPriceSol > 0)) return [];
  const now = Date.now();
  const windows: Array<{ ms: number; pct: number }> = [
    { ms: 24 * 60 * 60_000, pct: Number(change?.h24 ?? 0) },
    { ms: 6 * 60 * 60_000, pct: Number(change?.h6 ?? 0) },
    { ms: 60 * 60_000, pct: Number(change?.h1 ?? 0) },
    { ms: 5 * 60_000, pct: Number(change?.m5 ?? 0) },
    { ms: 0, pct: 0 },
  ];
  const anchors: Array<{ time: number; priceSol: number }> = [];
  for (const w of windows) {
    const pct = Number.isFinite(w.pct) ? w.pct : 0;
    const start =
      w.ms <= 0 ? lastPriceSol : lastPriceSol / (1 + pct / 100);
    if (!(start > 0) || !Number.isFinite(start)) continue;
    anchors.push({ time: now - w.ms, priceSol: start });
  }
  anchors.push({ time: now, priceSol: lastPriceSol });
  anchors.sort((a, b) => a.time - b.time);

  // Interpolate to ≥8 bars for soft TA consumers
  const out: MarketCandle[] = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i]!;
    const b = anchors[i + 1]!;
    const steps = i === anchors.length - 2 ? 3 : 2;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push({
        time: Math.round(a.time + (b.time - a.time) * t),
        priceSol: a.priceSol + (b.priceSol - a.priceSol) * t,
      });
    }
  }
  out.push({ time: now, priceSol: lastPriceSol });
  // Dedupe by time ascending
  out.sort((a, b) => a.time - b.time);
  const deduped: MarketCandle[] = [];
  for (const c of out) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(prev.time - c.time) < 1_000) {
      prev.priceSol = c.priceSol;
      continue;
    }
    deduped.push(c);
  }
  return deduped.length >= 8 ? deduped : [];
}

async function fetchGeckoOhlcv(
  mint: string,
  solUsd: number,
  tf: OhlcvTfLabel = '5m'
): Promise<MarketCandle[]> {
  if (isGeckoTerminalInCooldown()) {
    return [];
  }
  const spec = GECKO_TF_SPEC[tf] ?? GECKO_TF_SPEC['5m'];
  try {
    const url =
      `https://api.geckoterminal.com/api/v2/networks/solana/tokens/` +
      `${encodeURIComponent(mint)}/ohlcv/${spec.path}?aggregate=${spec.aggregate}&limit=${spec.limit}`;
    const res = await loggedFetch(url, {
      context: 'GeckoTerminal',
      label: `ohlcv:${tf}`,
      timeoutMs: 12_000,
      logBodyOnError: false,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'solana-smart-copy-bot/1.0',
      },
    });
    if (res.status === 429) {
      enterGeckoCooldown('429');
      return [];
    }
    if (!res.ok) {
      if (res.status >= 500) {
        // Soft pressure — brief cooldown without storming
        enterGeckoCooldown(`http_${res.status}`);
      }
      return [];
    }
    const json = (await res.json()) as {
      data?: { attributes?: { ohlcv_list?: unknown[] } };
    };
    const list = json?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(list)) return [];
    const rows = list.map((row) => {
      const a = row as unknown[];
      const t = Number(a[0] ?? 0);
      return {
        time: t > 1e12 ? t : t * 1000,
        close: Number(a[4] ?? 0),
        high: Number(a[2] ?? 0) || undefined,
        low: Number(a[3] ?? 0) || undefined,
        volume: Number(a[5] ?? 0) || undefined,
      };
    });
    clearGeckoCooldownOnSuccess();
    return usdClosesToSolCandles(rows, solUsd);
  } catch (err) {
    logger.warn('MarketData', 'GeckoTerminal OHLCV failed', {
      tf,
      ...errorToMeta(err),
    });
    return [];
  }
}

/**
 * Real OHLCV for scanner ranking / TA (single TF; default 5m).
 * GeckoTerminal → Dex sparse (5m) / resample from 5m → soft-fail.
 * Cached ~90–120s keyed by {mint, tf}; serves stale during cooldown.
 */
export async function fetchTokenOhlcvCandles(
  mint: string,
  opts?: { force?: boolean; solUsd?: number; tf?: OhlcvTfLabel }
): Promise<FetchTokenOhlcvResult> {
  if (!isCopyTargetMint(mint)) {
    return { candles: [], source: 'none', tf: opts?.tf ?? '5m' };
  }

  const tf: OhlcvTfLabel = opts?.tf ?? '5m';
  const key = ohlcvCacheKey(mint, tf);
  const cached = ohlcvCache.get(key);
  if (
    !opts?.force &&
    cached &&
    Date.now() - cached.at < OHLCV_CACHE_TTL_MS
  ) {
    return {
      candles: cached.candles,
      source: cached.source,
      solUsd: cached.solUsd,
      tf,
    };
  }

  if (!opts?.force) {
    const pending = geckoOhlcvInflight.get(key);
    if (pending) return pending;
  }

  const job = (async (): Promise<FetchTokenOhlcvResult> => {
    try {
      const solUsd = opts?.solUsd ?? (await fetchSolUsdPrice());
      let candles: MarketCandle[] = [];
      let source: FetchTokenOhlcvResult['source'] = 'none';

      if (!isGeckoTerminalInCooldown()) {
        candles = await fetchGeckoOhlcv(mint, solUsd, tf);
        if (candles.length >= 8) source = 'geckoterminal';
      } else {
        const stale = staleOhlcv(mint, tf);
        if (stale && stale.candles.length >= 8) return stale;
      }

      // Fallback: resample from 5m when higher TF fetch is thin
      if (candles.length < 8 && tf !== '5m') {
        const base = await fetchTokenOhlcvCandles(mint, {
          solUsd,
          tf: '5m',
          force: opts?.force,
        });
        if (base.candles.length >= 8) {
          const resampled = resampleOhlcvCandles(base.candles, tf);
          if (resampled.length >= 4) {
            candles = resampled;
            source =
              base.source === 'geckoterminal' || base.source === 'dex_sparse'
                ? 'resampled'
                : base.source;
          }
        }
      }

      if (candles.length < 8 && tf === '5m') {
        candles = await fetchDexSparseOhlcv(mint, solUsd);
        if (candles.length >= 8) {
          source = 'dex_sparse';
        } else {
          const stale = staleOhlcv(mint, tf);
          if (stale && stale.candles.length > 0) return stale;
          candles = [];
          source = 'none';
        }
      }

      if (candles.length < 4 && tf !== '5m') {
        const stale = staleOhlcv(mint, tf);
        if (stale && stale.candles.length > 0) return stale;
        candles = [];
        source = 'none';
      }

      ohlcvCache.set(key, { candles, source, solUsd, at: Date.now(), tf });
      return { candles, source, solUsd, tf };
    } finally {
      geckoOhlcvInflight.delete(key);
    }
  })();

  geckoOhlcvInflight.set(key, job);
  return job;
}

/** Fetch OHLCV for all multi-TF labels; 5m first so higher TFs can resample. */
export async function fetchMultiTfOhlcv(
  mint: string,
  opts?: { force?: boolean; solUsd?: number; tfs?: OhlcvTfLabel[] }
): Promise<{
  byTf: Partial<Record<OhlcvTfLabel, MarketCandle[]>>;
  solUsd?: number;
  primarySource: FetchTokenOhlcvResult['source'];
}> {
  const tfs = opts?.tfs?.length ? opts.tfs : [...OHLCV_TF_LABELS];
  const byTf: Partial<Record<OhlcvTfLabel, MarketCandle[]>> = {};
  let solUsd = opts?.solUsd;
  let primarySource: FetchTokenOhlcvResult['source'] = 'none';

  // Always resolve 5m first when requested or needed for resample
  const need5 = tfs.includes('5m') || tfs.some((t) => t !== '5m');
  if (need5) {
    const base = await fetchTokenOhlcvCandles(mint, {
      force: opts?.force,
      solUsd,
      tf: '5m',
    });
    solUsd = base.solUsd ?? solUsd;
    primarySource = base.source;
    if (tfs.includes('5m') && base.candles.length) {
      byTf['5m'] = base.candles;
    }
  }

  for (const tf of tfs) {
    if (tf === '5m') continue;
    const res = await fetchTokenOhlcvCandles(mint, {
      force: opts?.force,
      solUsd,
      tf,
    });
    solUsd = res.solUsd ?? solUsd;
    if (res.candles.length) byTf[tf] = res.candles;
  }

  return { byTf, solUsd, primarySource };
}

/** Best-effort DexScreener volume / change enrich onto a launch event. */
async function enrichDexPairMetrics(
  event: LaunchEvent
): Promise<LaunchEvent> {
  try {
    const data = await fetchJson(
      `https://api.dexscreener.com/latest/dex/tokens/${event.mint}`
    );
    const pairs =
      (data as { pairs?: Record<string, unknown>[] } | null)?.pairs ?? [];
    const solPairs = pairs.filter((p) => String(p.chainId) === 'solana');
    if (solPairs.length === 0) return event;
    let best = solPairs[0]!;
    let bestLiq = Number(
      (best.liquidity as { usd?: number } | undefined)?.usd ?? 0
    );
    for (const p of solPairs) {
      const liq = Number(
        (p.liquidity as { usd?: number } | undefined)?.usd ?? 0
      );
      if (liq > bestLiq) {
        best = p;
        bestLiq = liq;
      }
    }
    const vol = best.volume as { m5?: number; h1?: number; h24?: number } | undefined;
    const pc = best.priceChange as { h1?: number; h24?: number } | undefined;
    const next: LaunchEvent = { ...event };
    const m5 = Number(vol?.m5);
    const h1 = Number(vol?.h1);
    if (Number.isFinite(m5) && m5 >= 0) next.volumeM5Usd = m5;
    if (Number.isFinite(h1) && h1 >= 0) next.volumeH1Usd = h1;
    const chgH1 = Number(pc?.h1);
    if (Number.isFinite(chgH1)) next.priceChangeH1Pct = chgH1;
    if (!(next.volumeUsd && next.volumeUsd > 0)) {
      const h24 = Number(vol?.h24);
      if (Number.isFinite(h24) && h24 > 0) next.volumeUsd = h24;
    }
    return next;
  } catch {
    return event;
  }
}

/**
 * Replace synthetic candles with real OHLCV when preferRealCandles and ≥16 bars.
 * Also best-effort multi-TF OHLCV for S/R confluence (5m→4h).
 */
export async function enrichLaunchWithRealCandles(
  event: LaunchEvent
): Promise<LaunchEvent & { candleSource: 'real' | 'synthetic' }> {
  const prefer =
    (await import('./config')).config.marketScanner?.preferRealCandles !== false;
  let next = await enrichDexPairMetrics(event);

  if (!prefer) {
    return {
      ...next,
      candleSource: next.candleSource ?? 'synthetic',
    };
  }

  try {
    const multi = await fetchMultiTfOhlcv(next.mint, {
      solUsd: next.solUsd,
    });
    const primary = multi.byTf['5m'] ?? [];
    const candlesByTf =
      Object.keys(multi.byTf).length > 0 ? multi.byTf : undefined;
    if (primary.length >= 16) {
      const last = primary[primary.length - 1]!;
      return {
        ...next,
        candles: primary,
        candlesByTf,
        lastPriceSol: last.priceSol > 0 ? last.priceSol : next.lastPriceSol,
        solUsd: multi.solUsd ?? next.solUsd,
        candleSource: 'real',
      };
    }
    // Thin 5m but other TFs present — keep synthetic primary candles, attach MTF
    if (candlesByTf) {
      return {
        ...next,
        candlesByTf,
        solUsd: multi.solUsd ?? next.solUsd,
        candleSource: next.candleSource ?? 'synthetic',
      };
    }
  } catch (err) {
    logger.warn('MarketData', 'enrichLaunchWithRealCandles failed', {
      mint: next.mint,
      ...errorToMeta(err),
    });
  }

  return {
    ...next,
    candleSource: next.candleSource ?? 'synthetic',
  };
}
