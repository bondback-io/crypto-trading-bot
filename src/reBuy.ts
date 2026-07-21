/**
 * Re-buy on dip with multi-wallet / volume confirmation.
 *
 * After a profitable sell (e.g. 100%+), watch the mint for a dip from peak,
 * then only re-enter when confirmationThreshold smart wallets buy
 * or volume rises sharply in a short window.
 */

import { config } from './config';
import { fetchLivePriceSol } from './marketData';
import { logger, errorToMeta, loggedFetch } from './logger';

export interface SellHistoryEntry {
  mint: string;
  symbol: string;
  name: string;
  positionId: string;
  soldAt: number;
  sellPriceSol: number;
  /** Highest price seen since sell (starts at sell price) */
  peakPriceSol: number;
  pnlPct: number;
  pnlSol: number;
  reason: string;
  sourceWallets?: string[];
  sourceNames?: string[];
}

export type ReBuyStatus =
  | 'watching'
  | 'dip_armed'
  | 'rebought'
  | 'expired'
  | 'cancelled';

export interface ReBuyCandidate {
  mint: string;
  symbol: string;
  name: string;
  sell: SellHistoryEntry;
  status: ReBuyStatus;
  peakPriceSol: number;
  lastPriceSol: number | null;
  dipPctFromPeak: number | null;
  dipArmedAt: number | null;
  confirmationWallets: string[];
  confirmationWalletNames: string[];
  volumeBaselineUsd: number | null;
  volumeLatestUsd: number | null;
  volumeChangePct: number | null;
  rebuyCount: number;
  lastReason?: string;
  createdAt: number;
  updatedAt: number;
}

/** Sell history keyed by mint (newest last) */
const sellHistoryByMint = new Map<string, SellHistoryEntry[]>();
const candidates = new Map<string, ReBuyCandidate>();

const MAX_HISTORY_PER_MINT = 20;
const CANDIDATE_TTL_MS = 6 * 60 * 60 * 1000; // 6h watch window

export function getSellHistory(mint?: string): SellHistoryEntry[] {
  if (mint) return [...(sellHistoryByMint.get(mint) ?? [])];
  const all: SellHistoryEntry[] = [];
  for (const list of sellHistoryByMint.values()) {
    all.push(...list);
  }
  return all.sort((a, b) => b.soldAt - a.soldAt);
}

export function getReBuyCandidates(): ReBuyCandidate[] {
  pruneExpired();
  return Array.from(candidates.values()).sort(
    (a, b) => b.updatedAt - a.updatedAt
  );
}

export function getReBuyCandidate(mint: string): ReBuyCandidate | undefined {
  return candidates.get(mint);
}

export function isReBuyWatching(mint: string): boolean {
  const c = candidates.get(mint);
  return Boolean(c && (c.status === 'watching' || c.status === 'dip_armed'));
}

/**
 * Record a profitable sell and start dip watch (if enabled + meets min profit).
 */
export function registerProfitSell(entry: Omit<SellHistoryEntry, 'peakPriceSol'> & {
  peakPriceSol?: number;
}): ReBuyCandidate | null {
  const peak = entry.peakPriceSol ?? entry.sellPriceSol;
  const full: SellHistoryEntry = { ...entry, peakPriceSol: peak };

  const list = sellHistoryByMint.get(entry.mint) ?? [];
  list.push(full);
  if (list.length > MAX_HISTORY_PER_MINT) {
    list.splice(0, list.length - MAX_HISTORY_PER_MINT);
  }
  sellHistoryByMint.set(entry.mint, list);

  const { reBuyEnabled, reBuyMinProfitPct } = config.strategy;
  if (!reBuyEnabled) {
    console.log(
      `[rebuy] Sell recorded for ${entry.symbol} (+${entry.pnlPct.toFixed(0)}%) — reBuyEnabled=OFF`
    );
    return null;
  }

  if (entry.pnlPct < (reBuyMinProfitPct ?? 100)) {
    console.log(
      `[rebuy] Sell recorded for ${entry.symbol} (+${entry.pnlPct.toFixed(0)}%) ` +
        `< min profit ${reBuyMinProfitPct ?? 100}% — not watching for dip`
    );
    return null;
  }

  const existing = candidates.get(entry.mint);
  const rebuyCount = existing?.rebuyCount ?? 0;
  const maxPer = config.strategy.reBuyMaxPerMint ?? 2;
  if (rebuyCount >= maxPer) {
    console.log(
      `[rebuy] ${entry.symbol} already re-bought ${rebuyCount}× (max ${maxPer}) — skip watch`
    );
    return null;
  }

  const candidate: ReBuyCandidate = {
    mint: entry.mint,
    symbol: entry.symbol,
    name: entry.name,
    sell: full,
    status: 'watching',
    peakPriceSol: peak,
    lastPriceSol: entry.sellPriceSol,
    dipPctFromPeak: 0,
    dipArmedAt: null,
    confirmationWallets: [],
    confirmationWalletNames: [],
    volumeBaselineUsd: null,
    volumeLatestUsd: null,
    volumeChangePct: null,
    rebuyCount,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastReason: `Watching for ${config.strategy.reBuyDipPercent}% dip after +${entry.pnlPct.toFixed(0)}% sell`,
  };

  candidates.set(entry.mint, candidate);
  console.log(
    `[rebuy] 👀 Watching ${entry.symbol} (${entry.mint.slice(0, 8)}…) ` +
      `after +${entry.pnlPct.toFixed(0)}% sell @ ${entry.sellPriceSol.toExponential(3)} SOL — ` +
      `dip target ${config.strategy.reBuyDipPercent}% from peak, ` +
      `need ${config.strategy.confirmationThreshold}+ wallets or ` +
      `+${config.strategy.reBuyVolumeIncreasePct}% volume`
  );

  return candidate;
}

export function cancelReBuy(mint: string, reason: string): void {
  const c = candidates.get(mint);
  if (!c) return;
  if (c.status === 'rebought') return;
  c.status = 'cancelled';
  c.lastReason = reason;
  c.updatedAt = Date.now();
  console.log(`[rebuy] Cancelled ${c.symbol}: ${reason}`);
}

export function markReBought(
  mint: string,
  reason: string
): ReBuyCandidate | null {
  const c = candidates.get(mint);
  if (!c) return null;
  c.status = 'rebought';
  c.rebuyCount += 1;
  c.lastReason = reason;
  c.updatedAt = Date.now();
  return c;
}

/**
 * Update peak / dip state from a new price sample.
 * Returns true if dip is newly armed.
 */
export function updateCandidatePrice(
  mint: string,
  priceSol: number
): { dipNewlyArmed: boolean; candidate: ReBuyCandidate | null } {
  const c = candidates.get(mint);
  if (!c || (c.status !== 'watching' && c.status !== 'dip_armed')) {
    return { dipNewlyArmed: false, candidate: null };
  }

  c.lastPriceSol = priceSol;
  c.updatedAt = Date.now();

  if (priceSol > c.peakPriceSol) {
    c.peakPriceSol = priceSol;
    c.sell.peakPriceSol = priceSol;
  }

  const dipPct =
    c.peakPriceSol > 0
      ? ((priceSol - c.peakPriceSol) / c.peakPriceSol) * 100
      : 0;
  c.dipPctFromPeak = dipPct;

  const target = config.strategy.reBuyDipPercent ?? -30;
  let dipNewlyArmed = false;

  if (c.status === 'watching' && dipPct <= target) {
    c.status = 'dip_armed';
    c.dipArmedAt = Date.now();
    dipNewlyArmed = true;
    c.lastReason = `Dip armed at ${dipPct.toFixed(1)}% from peak (target ${target}%)`;
    console.log(
      `[rebuy] 📉 Dip armed for ${c.symbol}: ${dipPct.toFixed(1)}% from peak ` +
        `(price ${priceSol.toExponential(3)}, peak ${c.peakPriceSol.toExponential(3)}) — ` +
        `awaiting confirmation`
    );
  }

  return { dipNewlyArmed, candidate: c };
}

/** Record a smart-wallet buy toward confirmation (only while dip_armed). */
export function recordConfirmationBuy(
  mint: string,
  wallet: string,
  walletName: string
): ReBuyCandidate | null {
  const c = candidates.get(mint);
  if (!c || c.status !== 'dip_armed') return null;

  if (!c.confirmationWallets.includes(wallet)) {
    c.confirmationWallets.push(wallet);
    c.confirmationWalletNames.push(walletName);
    c.updatedAt = Date.now();
    console.log(
      `[rebuy] Confirmation wallet ${walletName} on ${c.symbol} ` +
        `(${c.confirmationWallets.length}/${config.strategy.confirmationThreshold})`
    );
  }
  return c;
}

export function updateCandidateVolume(
  mint: string,
  volumeUsd: number
): ReBuyCandidate | null {
  const c = candidates.get(mint);
  if (!c || (c.status !== 'watching' && c.status !== 'dip_armed')) return null;

  if (c.volumeBaselineUsd == null || c.volumeBaselineUsd <= 0) {
    c.volumeBaselineUsd = volumeUsd;
    c.volumeLatestUsd = volumeUsd;
    c.volumeChangePct = 0;
  } else {
    c.volumeLatestUsd = volumeUsd;
    c.volumeChangePct =
      ((volumeUsd - c.volumeBaselineUsd) / c.volumeBaselineUsd) * 100;
  }
  c.updatedAt = Date.now();
  return c;
}

export interface ReBuyConfirmation {
  ready: boolean;
  reason: string;
  walletCount: number;
  volumeChangePct: number | null;
  dipPct: number | null;
}

/** Check if dip + confirmation thresholds are met */
export function evaluateConfirmation(mint: string): ReBuyConfirmation {
  const c = candidates.get(mint);
  const threshold = config.strategy.confirmationThreshold ?? 4;
  const volNeed = config.strategy.reBuyVolumeIncreasePct ?? 50;

  if (!c || c.status !== 'dip_armed') {
    return {
      ready: false,
      reason: c
        ? `status=${c.status}, waiting for dip ${config.strategy.reBuyDipPercent}%`
        : 'no candidate',
      walletCount: c?.confirmationWallets.length ?? 0,
      volumeChangePct: c?.volumeChangePct ?? null,
      dipPct: c?.dipPctFromPeak ?? null,
    };
  }

  const walletCount = c.confirmationWallets.length;
  const volPct = c.volumeChangePct;
  const walletOk = walletCount >= threshold;
  const volumeOk = volPct != null && volPct >= volNeed;

  if (walletOk) {
    return {
      ready: true,
      reason: `Re-buy on dip with ${walletCount} wallet confirmation`,
      walletCount,
      volumeChangePct: volPct,
      dipPct: c.dipPctFromPeak,
    };
  }

  if (volumeOk) {
    return {
      ready: true,
      reason: `Re-buy on dip with volume +${volPct!.toFixed(0)}% confirmation`,
      walletCount,
      volumeChangePct: volPct,
      dipPct: c.dipPctFromPeak,
    };
  }

  return {
    ready: false,
    reason:
      `Dip armed (${c.dipPctFromPeak?.toFixed(1)}%) — need ${threshold}+ wallets ` +
      `(have ${walletCount}) or +${volNeed}% volume (have ${volPct != null ? volPct.toFixed(0) + '%' : 'n/a'})`,
    walletCount,
    volumeChangePct: volPct,
    dipPct: c.dipPctFromPeak,
  };
}

export async function refreshCandidateMarketData(
  mint: string
): Promise<ReBuyCandidate | null> {
  const c = candidates.get(mint);
  if (!c || (c.status !== 'watching' && c.status !== 'dip_armed')) return null;

  const price = await fetchLivePriceSol(mint);
  if (price != null) {
    updateCandidatePrice(mint, price);
  }

  const vol = await fetchTokenVolumeUsd(mint);
  if (vol != null) {
    updateCandidateVolume(mint, vol);
  }

  return candidates.get(mint) ?? null;
}

async function fetchTokenVolumeUsd(mint: string): Promise<number | null> {
  try {
    const res = await loggedFetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      {
        context: 'DexScreener',
        label: 'rebuy volume',
        timeoutMs: 8_000,
      }
    );
    if (!res.ok) {
      logger.warn('DexScreener', 'rebuy volume HTTP', {
        mint: mint.slice(0, 12),
        status: res.status,
      });
      return null;
    }
    const data = (await res.json()) as {
      pairs?: Array<{
        chainId?: string;
        volume?: { h1?: number; h6?: number; h24?: number; m5?: number };
      }>;
    };
    const pairs = (data.pairs ?? []).filter((p) => p.chainId === 'solana');
    if (pairs.length === 0) return null;
    // Prefer short-window volume for "increase in short time"
    let best = 0;
    for (const p of pairs) {
      const v =
        Number(p.volume?.m5 ?? 0) ||
        Number(p.volume?.h1 ?? 0) ||
        Number(p.volume?.h6 ?? 0) ||
        Number(p.volume?.h24 ?? 0);
      if (v > best) best = v;
    }
    return best > 0 ? best : null;
  } catch (err) {
    logger.error('DexScreener', 'rebuy volume failed', {
      mint: mint.slice(0, 12),
      ...errorToMeta(err),
    });
    return null;
  }
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [mint, c] of candidates.entries()) {
    if (c.status === 'rebought' || c.status === 'cancelled') continue;
    if (now - c.createdAt > CANDIDATE_TTL_MS) {
      c.status = 'expired';
      c.lastReason = 'Watch window expired';
      c.updatedAt = now;
      console.log(`[rebuy] Expired watch on ${c.symbol}`);
    }
  }
}

export function getReBuyStatus() {
  pruneExpired();
  const active = getReBuyCandidates().filter(
    (c) => c.status === 'watching' || c.status === 'dip_armed'
  );
  return {
    enabled: config.strategy.reBuyEnabled,
    watching: active.length,
    dipArmed: active.filter((c) => c.status === 'dip_armed').length,
    sellHistoryCount: getSellHistory().length,
    config: {
      reBuyDipPercent: config.strategy.reBuyDipPercent,
      confirmationThreshold: config.strategy.confirmationThreshold,
      reBuyVolumeIncreasePct: config.strategy.reBuyVolumeIncreasePct,
      reBuyMinProfitPct: config.strategy.reBuyMinProfitPct,
    },
  };
}
