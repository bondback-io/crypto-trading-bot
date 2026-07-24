/**
 * Unified post-exit re-entry engine.
 *
 * Two watch kinds share the same candidate lifecycle:
 *  1) profit_dip — after a profitable TP sell, wait for a dip from peak + confirmation
 *  2) stop_reentry — after hard stop-loss / early defensive exit, wait for price reclaim
 *     + smart-wallet / volume confirmation (token still alive)
 *
 * Hard floors and risk/strict gates still apply on every re-entry buy.
 */

import { config, type RiskLevel } from './config';
import { fetchLivePriceSol } from './marketData';
import { logger, errorToMeta, loggedFetch } from './logger';
import {
  getStrictModeIntensity,
  isStrictMode,
  type StrictModeIntensity,
} from './strictMode';
import { isStrategyEnabled } from './strategies';

export interface SellHistoryEntry {
  mint: string;
  symbol: string;
  name: string;
  positionId: string;
  soldAt: number;
  sellPriceSol: number;
  /** Highest price seen since sell (starts at sell price) */
  peakPriceSol: number;
  /** Lowest price seen since sell (starts at sell price) */
  troughPriceSol: number;
  pnlPct: number;
  pnlSol: number;
  reason: string;
  /** Original position entry price (for reclaim-of-entry checks) */
  entryPriceSol?: number;
  sourceWallets?: string[];
  sourceNames?: string[];
}

export type ReEntryKind = 'profit_dip' | 'stop_reentry';

export type ReBuyStatus =
  | 'watching'
  | 'dip_armed'
  | 'reclaim_armed'
  | 'rebought'
  | 'expired'
  | 'cancelled'
  | 'cooldown';

export interface ReBuyCandidate {
  mint: string;
  symbol: string;
  name: string;
  sell: SellHistoryEntry;
  kind: ReEntryKind;
  status: ReBuyStatus;
  peakPriceSol: number;
  troughPriceSol: number;
  lastPriceSol: number | null;
  dipPctFromPeak: number | null;
  /** % reclaim from trough (positive when recovering) */
  reclaimPctFromTrough: number | null;
  dipArmedAt: number | null;
  reclaimArmedAt: number | null;
  confirmationWallets: string[];
  confirmationWalletNames: string[];
  volumeBaselineUsd: number | null;
  volumeLatestUsd: number | null;
  volumeChangePct: number | null;
  rebuyCount: number;
  /** Failed / blocked attempts since arm (cooldown bookkeeping) */
  attemptCount: number;
  lastAttemptAt: number | null;
  lastReason?: string;
  createdAt: number;
  updatedAt: number;
}

/** Effective knobs after risk level + Strict Mode intensity overlays. */
export interface ReEntryEffectiveParams {
  profitDipEnabled: boolean;
  stopReentryEnabled: boolean;
  afterMaxProfitEnabled: boolean;
  maxPerMint: number;
  watchMinutes: number;
  minReclaimPct: number;
  minVolumeIncreasePct: number;
  confirmationWallets: number;
  sizeMultiplier: number;
  cooldownMs: number;
  /** Min recent volume USD to treat token as still alive */
  minAliveVolumeUsd: number;
  dipPercent: number;
  minProfitPct: number;
}

export type ExitReentryClass =
  | 'profit_dip'
  | 'stop_reentry'
  | 'max_profit'
  | 'skip';

/** Sell history keyed by mint (newest last) */
const sellHistoryByMint = new Map<string, SellHistoryEntry[]>();
const candidates = new Map<string, ReBuyCandidate>();

const MAX_HISTORY_PER_MINT = 20;

const RISK_REENTRY_DEFAULTS: Record<
  RiskLevel,
  Omit<
    ReEntryEffectiveParams,
    | 'profitDipEnabled'
    | 'stopReentryEnabled'
    | 'afterMaxProfitEnabled'
    | 'dipPercent'
    | 'minProfitPct'
  >
> = {
  low: {
    maxPerMint: 1,
    watchMinutes: 45,
    minReclaimPct: 12,
    minVolumeIncreasePct: 80,
    confirmationWallets: 4,
    sizeMultiplier: 0.45,
    cooldownMs: 15 * 60_000,
    minAliveVolumeUsd: 800,
  },
  medium: {
    maxPerMint: 2,
    watchMinutes: 90,
    minReclaimPct: 8,
    minVolumeIncreasePct: 50,
    confirmationWallets: 3,
    sizeMultiplier: 0.65,
    cooldownMs: 8 * 60_000,
    minAliveVolumeUsd: 500,
  },
  high: {
    maxPerMint: 3,
    watchMinutes: 120,
    minReclaimPct: 5,
    minVolumeIncreasePct: 35,
    confirmationWallets: 2,
    sizeMultiplier: 0.8,
    cooldownMs: 4 * 60_000,
    minAliveVolumeUsd: 350,
  },
  degen: {
    maxPerMint: 4,
    watchMinutes: 180,
    minReclaimPct: 3,
    minVolumeIncreasePct: 25,
    confirmationWallets: 1,
    sizeMultiplier: 0.95,
    cooldownMs: 2 * 60_000,
    minAliveVolumeUsd: 250,
  },
};

/** Strict intensity overlays on top of risk defaults (when Strict Mode is ON). */
const STRICT_REENTRY_OVERLAY: Record<
  StrictModeIntensity,
  {
    maxPerMintDelta: number;
    watchMinutesFactor: number;
    reclaimAdd: number;
    volumeAdd: number;
    walletsAdd: number;
    sizeFactor: number;
    cooldownFactor: number;
    aliveVolumeFactor: number;
  }
> = {
  low: {
    maxPerMintDelta: -1,
    watchMinutesFactor: 0.75,
    reclaimAdd: 4,
    volumeAdd: 25,
    walletsAdd: 2,
    sizeFactor: 0.7,
    cooldownFactor: 1.5,
    aliveVolumeFactor: 1.4,
  },
  medium: {
    maxPerMintDelta: 0,
    watchMinutesFactor: 0.9,
    reclaimAdd: 2,
    volumeAdd: 15,
    walletsAdd: 1,
    sizeFactor: 0.85,
    cooldownFactor: 1.2,
    aliveVolumeFactor: 1.2,
  },
  high: {
    maxPerMintDelta: 0,
    watchMinutesFactor: 1.0,
    reclaimAdd: 0,
    volumeAdd: 5,
    walletsAdd: 0,
    sizeFactor: 0.95,
    cooldownFactor: 1.0,
    aliveVolumeFactor: 1.05,
  },
};

export function getReEntryEffectiveParams(): ReEntryEffectiveParams {
  const level: RiskLevel =
    config.riskLevel === 'low' ||
    config.riskLevel === 'high' ||
    config.riskLevel === 'degen'
      ? config.riskLevel
      : 'medium';
  const base = RISK_REENTRY_DEFAULTS[level];
  const s = config.strategy;

  let maxPerMint = s.reEntryMaxPerMint ?? s.reBuyMaxPerMint ?? base.maxPerMint;
  let watchMinutes = s.reEntryWatchMinutes ?? base.watchMinutes;
  let minReclaimPct = s.reEntryMinReclaimPct ?? base.minReclaimPct;
  let minVolumeIncreasePct =
    s.reEntryMinVolumeIncreasePct ??
    s.reBuyVolumeIncreasePct ??
    base.minVolumeIncreasePct;
  let confirmationWallets =
    s.reEntryConfirmationWallets ??
    s.confirmationThreshold ??
    base.confirmationWallets;
  let sizeMultiplier = s.reEntrySizeMultiplier ?? base.sizeMultiplier;
  let cooldownMs =
    s.reEntryCooldownMinutes != null
      ? Math.max(0, s.reEntryCooldownMinutes) * 60_000
      : base.cooldownMs;
  let minAliveVolumeUsd = base.minAliveVolumeUsd;

  if (isStrictMode()) {
    const o = STRICT_REENTRY_OVERLAY[getStrictModeIntensity()];
    maxPerMint = Math.max(1, maxPerMint + o.maxPerMintDelta);
    watchMinutes = Math.max(15, Math.round(watchMinutes * o.watchMinutesFactor));
    minReclaimPct = minReclaimPct + o.reclaimAdd;
    minVolumeIncreasePct = minVolumeIncreasePct + o.volumeAdd;
    confirmationWallets = Math.max(1, confirmationWallets + o.walletsAdd);
    sizeMultiplier = Math.max(0.2, sizeMultiplier * o.sizeFactor);
    cooldownMs = Math.round(cooldownMs * o.cooldownFactor);
    minAliveVolumeUsd = Math.round(minAliveVolumeUsd * o.aliveVolumeFactor);
  }

  return {
    profitDipEnabled:
      isStrategyEnabled('rebuy_on_dip') && s.reBuyEnabled !== false,
    stopReentryEnabled:
      isStrategyEnabled('rebuy_on_dip') && s.postStopReentryEnabled !== false,
    afterMaxProfitEnabled:
      isStrategyEnabled('rebuy_on_dip') &&
      s.reEntryAfterMaxProfitEnabled === true,
    maxPerMint: Math.max(1, maxPerMint),
    watchMinutes: Math.max(5, watchMinutes),
    minReclaimPct: Math.max(1, minReclaimPct),
    minVolumeIncreasePct: Math.max(5, minVolumeIncreasePct),
    confirmationWallets: Math.max(1, confirmationWallets),
    sizeMultiplier: Math.min(1.5, Math.max(0.15, sizeMultiplier)),
    cooldownMs: Math.max(0, cooldownMs),
    minAliveVolumeUsd: Math.max(50, minAliveVolumeUsd),
    dipPercent: s.reBuyDipPercent ?? -30,
    minProfitPct: s.reBuyMinProfitPct ?? 90,
  };
}

export function classifyExitForReentry(
  reason: string,
  pnlPct: number
): ExitReentryClass {
  const r = String(reason || '').toLowerCase();

  if (
    /max profit|max-profit|bag close|closing remaining|full runner|runner exit/.test(
      r
    )
  ) {
    return 'max_profit';
  }

  // Dead / illiquid / rug exits — do not re-arm
  if (
    /dead.?volume|dead.?market|dead.?token|no liquidity|honeypot|rug|force.?sell.*dead/.test(
      r
    )
  ) {
    return 'skip';
  }

  if (/stop-?loss|hard stop|stop loss/.test(r)) {
    return 'stop_reentry';
  }

  // Early defensive / negative full exits that aren't profit-taking
  if (
    pnlPct < 0 &&
    !/trail|trailing|take.?profit|partial|tier|initial recover|manual/.test(r)
  ) {
    return 'stop_reentry';
  }

  const params = getReEntryEffectiveParams();
  if (pnlPct >= params.minProfitPct) {
    return 'profit_dip';
  }

  return 'skip';
}

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
  return Boolean(
    c &&
      (c.status === 'watching' ||
        c.status === 'dip_armed' ||
        c.status === 'reclaim_armed')
  );
}

function pushSellHistory(
  entry: Omit<SellHistoryEntry, 'peakPriceSol' | 'troughPriceSol'> & {
    peakPriceSol?: number;
    troughPriceSol?: number;
  }
): SellHistoryEntry {
  const peak = entry.peakPriceSol ?? entry.sellPriceSol;
  const trough = entry.troughPriceSol ?? entry.sellPriceSol;
  const full: SellHistoryEntry = {
    ...entry,
    peakPriceSol: peak,
    troughPriceSol: trough,
  };

  const list = sellHistoryByMint.get(entry.mint) ?? [];
  list.push(full);
  if (list.length > MAX_HISTORY_PER_MINT) {
    list.splice(0, list.length - MAX_HISTORY_PER_MINT);
  }
  sellHistoryByMint.set(entry.mint, list);
  return full;
}

function canArmWatch(
  mint: string,
  symbol: string,
  params: ReEntryEffectiveParams
): { ok: boolean; rebuyCount: number; reason?: string } {
  const existing = candidates.get(mint);
  const rebuyCount = existing?.rebuyCount ?? 0;
  if (rebuyCount >= params.maxPerMint) {
    return {
      ok: false,
      rebuyCount,
      reason: `${symbol} already re-entered ${rebuyCount}× (max ${params.maxPerMint})`,
    };
  }

  if (
    existing &&
    (existing.status === 'watching' ||
      existing.status === 'dip_armed' ||
      existing.status === 'reclaim_armed')
  ) {
    return {
      ok: false,
      rebuyCount,
      reason: `${symbol} already has an active re-entry watch`,
    };
  }

  if (
    existing?.lastAttemptAt != null &&
    params.cooldownMs > 0 &&
    Date.now() - existing.lastAttemptAt < params.cooldownMs
  ) {
    const left = Math.ceil(
      (params.cooldownMs - (Date.now() - existing.lastAttemptAt)) / 60_000
    );
    return {
      ok: false,
      rebuyCount,
      reason: `${symbol} re-entry cooldown (${left}m left)`,
    };
  }

  return { ok: true, rebuyCount };
}

function armCandidate(
  full: SellHistoryEntry,
  kind: ReEntryKind,
  params: ReEntryEffectiveParams,
  rebuyCount: number
): ReBuyCandidate {
  const lastReason =
    kind === 'stop_reentry'
      ? `Stop re-entry watch after ${full.reason} (${full.pnlPct.toFixed(0)}%) — need +${params.minReclaimPct}% reclaim + confirmation`
      : `Watching for ${params.dipPercent}% dip after +${full.pnlPct.toFixed(0)}% sell`;

  const candidate: ReBuyCandidate = {
    mint: full.mint,
    symbol: full.symbol,
    name: full.name,
    sell: full,
    kind,
    status: 'watching',
    peakPriceSol: full.peakPriceSol,
    troughPriceSol: full.troughPriceSol,
    lastPriceSol: full.sellPriceSol,
    dipPctFromPeak: 0,
    reclaimPctFromTrough: 0,
    dipArmedAt: null,
    reclaimArmedAt: null,
    confirmationWallets: [],
    confirmationWalletNames: [],
    volumeBaselineUsd: null,
    volumeLatestUsd: null,
    volumeChangePct: null,
    rebuyCount,
    attemptCount: existingAttemptCount(full.mint),
    lastAttemptAt: candidates.get(full.mint)?.lastAttemptAt ?? null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastReason,
  };

  candidates.set(full.mint, candidate);
  return candidate;
}

function existingAttemptCount(mint: string): number {
  return candidates.get(mint)?.attemptCount ?? 0;
}

/**
 * Record any full exit and optionally arm profit-dip or stop re-entry watch.
 */
export function registerExitForReentry(
  entry: Omit<SellHistoryEntry, 'peakPriceSol' | 'troughPriceSol'> & {
    peakPriceSol?: number;
    troughPriceSol?: number;
  }
): ReBuyCandidate | null {
  const full = pushSellHistory(entry);
  const params = getReEntryEffectiveParams();
  const cls = classifyExitForReentry(full.reason, full.pnlPct);

  if (cls === 'skip') {
    console.log(
      `[reentry] Sell recorded for ${full.symbol} (${full.pnlPct >= 0 ? '+' : ''}${full.pnlPct.toFixed(0)}%) [${full.reason}] — no re-entry watch`
    );
    return null;
  }

  if (cls === 'max_profit') {
    if (!params.afterMaxProfitEnabled) {
      console.log(
        `[reentry] Max-profit exit on ${full.symbol} — reEntryAfterMaxProfitEnabled=OFF`
      );
      return null;
    }
    // Optional: treat as profit_dip watch when explicitly enabled
    if (!params.profitDipEnabled) {
      console.log(
        `[reentry] Max-profit exit on ${full.symbol} — profit dip re-buy OFF`
      );
      return null;
    }
    const gate = canArmWatch(full.mint, full.symbol, params);
    if (!gate.ok) {
      console.log(`[reentry] ${gate.reason}`);
      return null;
    }
    const c = armCandidate(full, 'profit_dip', params, gate.rebuyCount);
    console.log(
      `[reentry] 👀 Profit-dip watch (post max-profit) ${c.symbol} · ${params.watchMinutes}m window`
    );
    return c;
  }

  if (cls === 'stop_reentry') {
    if (!params.stopReentryEnabled) {
      console.log(
        `[reentry] Stop/defensive exit on ${full.symbol} — postStopReentryEnabled=OFF`
      );
      return null;
    }
    const gate = canArmWatch(full.mint, full.symbol, params);
    if (!gate.ok) {
      console.log(`[reentry] ${gate.reason}`);
      return null;
    }
    const c = armCandidate(full, 'stop_reentry', params, gate.rebuyCount);
    console.log(
      `[reentry] 👀 Stop re-entry armed ${c.symbol} (${c.mint.slice(0, 8)}…) ` +
        `after ${full.reason} @ ${full.sellPriceSol.toExponential(3)} SOL — ` +
        `reclaim +${params.minReclaimPct}%, need ${params.confirmationWallets}+ wallets or ` +
        `+${params.minVolumeIncreasePct}% volume · ${params.watchMinutes}m · size ×${params.sizeMultiplier.toFixed(2)}`
    );
    return c;
  }

  // profit_dip
  if (!params.profitDipEnabled) {
    console.log(
      `[reentry] Sell recorded for ${full.symbol} (+${full.pnlPct.toFixed(0)}%) — reBuyEnabled=OFF`
    );
    return null;
  }

  const gate = canArmWatch(full.mint, full.symbol, params);
  if (!gate.ok) {
    console.log(`[reentry] ${gate.reason}`);
    return null;
  }

  const c = armCandidate(full, 'profit_dip', params, gate.rebuyCount);
  console.log(
    `[reentry] 👀 Watching ${c.symbol} (${c.mint.slice(0, 8)}…) ` +
      `after +${full.pnlPct.toFixed(0)}% sell @ ${full.sellPriceSol.toExponential(3)} SOL — ` +
      `dip target ${params.dipPercent}% from peak, ` +
      `need ${params.confirmationWallets}+ wallets or ` +
      `+${params.minVolumeIncreasePct}% volume`
  );
  return c;
}

/**
 * Record a profitable sell and start dip watch (if enabled + meets min profit).
 * @deprecated Prefer registerExitForReentry — kept for callers/back-compat.
 */
export function registerProfitSell(
  entry: Omit<SellHistoryEntry, 'peakPriceSol' | 'troughPriceSol'> & {
    peakPriceSol?: number;
    troughPriceSol?: number;
  }
): ReBuyCandidate | null {
  return registerExitForReentry(entry);
}

export function cancelReBuy(mint: string, reason: string): void {
  const c = candidates.get(mint);
  if (!c) return;
  if (c.status === 'rebought') return;
  c.status = 'cancelled';
  c.lastReason = reason;
  c.updatedAt = Date.now();
  console.log(`[reentry] Cancelled ${c.symbol}: ${reason}`);
}

export function markReBought(
  mint: string,
  reason: string
): ReBuyCandidate | null {
  const c = candidates.get(mint);
  if (!c) return null;
  c.status = 'rebought';
  c.rebuyCount += 1;
  c.lastAttemptAt = Date.now();
  c.lastReason = reason;
  c.updatedAt = Date.now();
  return c;
}

/** Record a blocked / failed re-entry attempt (starts cooldown). */
export function markReEntryAttempt(
  mint: string,
  reason: string
): ReBuyCandidate | null {
  const c = candidates.get(mint);
  if (!c) return null;
  c.attemptCount += 1;
  c.lastAttemptAt = Date.now();
  c.lastReason = reason;
  c.updatedAt = Date.now();
  const params = getReEntryEffectiveParams();
  if (c.attemptCount >= params.maxPerMint + 2) {
    c.status = 'cancelled';
    c.lastReason = `Too many failed attempts — ${reason}`;
  }
  return c;
}

/**
 * Update peak / trough / arm state from a new price sample.
 */
export function updateCandidatePrice(
  mint: string,
  priceSol: number
): {
  dipNewlyArmed: boolean;
  reclaimNewlyArmed: boolean;
  candidate: ReBuyCandidate | null;
} {
  const c = candidates.get(mint);
  if (
    !c ||
    (c.status !== 'watching' &&
      c.status !== 'dip_armed' &&
      c.status !== 'reclaim_armed')
  ) {
    return { dipNewlyArmed: false, reclaimNewlyArmed: false, candidate: null };
  }

  const params = getReEntryEffectiveParams();
  c.lastPriceSol = priceSol;
  c.updatedAt = Date.now();

  if (priceSol > c.peakPriceSol) {
    c.peakPriceSol = priceSol;
    c.sell.peakPriceSol = priceSol;
  }
  if (priceSol < c.troughPriceSol) {
    c.troughPriceSol = priceSol;
    c.sell.troughPriceSol = priceSol;
  }

  const dipPct =
    c.peakPriceSol > 0
      ? ((priceSol - c.peakPriceSol) / c.peakPriceSol) * 100
      : 0;
  c.dipPctFromPeak = dipPct;

  const reclaimPct =
    c.troughPriceSol > 0
      ? ((priceSol - c.troughPriceSol) / c.troughPriceSol) * 100
      : 0;
  c.reclaimPctFromTrough = reclaimPct;

  let dipNewlyArmed = false;
  let reclaimNewlyArmed = false;

  if (c.kind === 'profit_dip') {
    const target = params.dipPercent;
    if (c.status === 'watching' && dipPct <= target) {
      c.status = 'dip_armed';
      c.dipArmedAt = Date.now();
      dipNewlyArmed = true;
      c.lastReason = `Dip armed at ${dipPct.toFixed(1)}% from peak (target ${target}%)`;
      console.log(
        `[reentry] 📉 Dip armed for ${c.symbol}: ${dipPct.toFixed(1)}% from peak ` +
          `(price ${priceSol.toExponential(3)}, peak ${c.peakPriceSol.toExponential(3)}) — ` +
          `awaiting confirmation`
      );
    }
  } else if (c.kind === 'stop_reentry') {
    const need = params.minReclaimPct;
    const sellPx = c.sell.sellPriceSol;
    const entryPx = c.sell.entryPriceSol;
    const reclaimFromTrough = reclaimPct >= need;
    const reclaimSell =
      sellPx > 0 && ((priceSol - sellPx) / sellPx) * 100 >= need * 0.5;
    const reclaimEntry =
      entryPx != null &&
      entryPx > 0 &&
      priceSol >= entryPx * (1 + need / 200); // half reclaim toward prior entry

    if (
      c.status === 'watching' &&
      (reclaimFromTrough || reclaimSell || reclaimEntry)
    ) {
      c.status = 'reclaim_armed';
      c.reclaimArmedAt = Date.now();
      reclaimNewlyArmed = true;
      const how = reclaimFromTrough
        ? `+${reclaimPct.toFixed(1)}% from trough`
        : reclaimSell
          ? `reclaimed sell zone`
          : `reclaimed toward entry`;
      c.lastReason = `Reclaim armed (${how}, need +${need}%) — awaiting confirmation`;
      console.log(
        `[reentry] 📈 Reclaim armed for ${c.symbol}: ${how} ` +
          `(price ${priceSol.toExponential(3)}, trough ${c.troughPriceSol.toExponential(3)}) — ` +
          `awaiting wallets/volume`
      );
    }
  }

  return { dipNewlyArmed, reclaimNewlyArmed, candidate: c };
}

/** Record a smart-wallet buy toward confirmation (only while armed). */
export function recordConfirmationBuy(
  mint: string,
  wallet: string,
  walletName: string
): ReBuyCandidate | null {
  const c = candidates.get(mint);
  if (!c || (c.status !== 'dip_armed' && c.status !== 'reclaim_armed')) {
    return null;
  }

  if (!c.confirmationWallets.includes(wallet)) {
    c.confirmationWallets.push(wallet);
    c.confirmationWalletNames.push(walletName);
    c.updatedAt = Date.now();
    const params = getReEntryEffectiveParams();
    console.log(
      `[reentry] Confirmation wallet ${walletName} on ${c.symbol} ` +
        `(${c.confirmationWallets.length}/${params.confirmationWallets})`
    );
  }
  return c;
}

export function updateCandidateVolume(
  mint: string,
  volumeUsd: number
): ReBuyCandidate | null {
  const c = candidates.get(mint);
  if (
    !c ||
    (c.status !== 'watching' &&
      c.status !== 'dip_armed' &&
      c.status !== 'reclaim_armed')
  ) {
    return null;
  }

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
  reclaimPct: number | null;
  kind: ReEntryKind | null;
  sizeMultiplier: number;
}

function isTokenAlive(c: ReBuyCandidate, params: ReEntryEffectiveParams): boolean {
  if (c.volumeLatestUsd == null) return true; // unknown — don't block yet
  return c.volumeLatestUsd >= params.minAliveVolumeUsd;
}

/** Check if arm + confirmation thresholds are met */
export function evaluateConfirmation(mint: string): ReBuyConfirmation {
  const c = candidates.get(mint);
  const params = getReEntryEffectiveParams();
  const empty: ReBuyConfirmation = {
    ready: false,
    reason: 'no candidate',
    walletCount: 0,
    volumeChangePct: null,
    dipPct: null,
    reclaimPct: null,
    kind: null,
    sizeMultiplier: params.sizeMultiplier,
  };

  if (!c) return empty;

  const armed =
    (c.kind === 'profit_dip' && c.status === 'dip_armed') ||
    (c.kind === 'stop_reentry' && c.status === 'reclaim_armed');

  if (!armed) {
    return {
      ready: false,
      reason:
        c.kind === 'stop_reentry'
          ? `status=${c.status}, waiting for +${params.minReclaimPct}% reclaim`
          : `status=${c.status}, waiting for dip ${params.dipPercent}%`,
      walletCount: c.confirmationWallets.length,
      volumeChangePct: c.volumeChangePct,
      dipPct: c.dipPctFromPeak,
      reclaimPct: c.reclaimPctFromTrough,
      kind: c.kind,
      sizeMultiplier: params.sizeMultiplier,
    };
  }

  if (!isTokenAlive(c, params)) {
    return {
      ready: false,
      reason: `Dead dump filter — volume $${c.volumeLatestUsd?.toFixed(0) ?? 0} < $${params.minAliveVolumeUsd} alive floor`,
      walletCount: c.confirmationWallets.length,
      volumeChangePct: c.volumeChangePct,
      dipPct: c.dipPctFromPeak,
      reclaimPct: c.reclaimPctFromTrough,
      kind: c.kind,
      sizeMultiplier: params.sizeMultiplier,
    };
  }

  const walletCount = c.confirmationWallets.length;
  const volPct = c.volumeChangePct;
  const walletOk = walletCount >= params.confirmationWallets;
  const volumeOk = volPct != null && volPct >= params.minVolumeIncreasePct;
  const label = c.kind === 'stop_reentry' ? 'Stop re-entry' : 'Re-buy on dip';

  if (walletOk) {
    return {
      ready: true,
      reason: `${label} with ${walletCount} wallet confirmation`,
      walletCount,
      volumeChangePct: volPct,
      dipPct: c.dipPctFromPeak,
      reclaimPct: c.reclaimPctFromTrough,
      kind: c.kind,
      sizeMultiplier: params.sizeMultiplier,
    };
  }

  if (volumeOk) {
    return {
      ready: true,
      reason: `${label} with volume +${volPct!.toFixed(0)}% confirmation`,
      walletCount,
      volumeChangePct: volPct,
      dipPct: c.dipPctFromPeak,
      reclaimPct: c.reclaimPctFromTrough,
      kind: c.kind,
      sizeMultiplier: params.sizeMultiplier,
    };
  }

  return {
    ready: false,
    reason:
      (c.kind === 'stop_reentry'
        ? `Reclaim armed (+${c.reclaimPctFromTrough?.toFixed(1) ?? '?'}% from trough)`
        : `Dip armed (${c.dipPctFromPeak?.toFixed(1)}%)`) +
      ` — need ${params.confirmationWallets}+ wallets ` +
      `(have ${walletCount}) or +${params.minVolumeIncreasePct}% volume ` +
      `(have ${volPct != null ? volPct.toFixed(0) + '%' : 'n/a'})`,
    walletCount,
    volumeChangePct: volPct,
    dipPct: c.dipPctFromPeak,
    reclaimPct: c.reclaimPctFromTrough,
    kind: c.kind,
    sizeMultiplier: params.sizeMultiplier,
  };
}

export async function refreshCandidateMarketData(
  mint: string
): Promise<ReBuyCandidate | null> {
  const c = candidates.get(mint);
  if (
    !c ||
    (c.status !== 'watching' &&
      c.status !== 'dip_armed' &&
      c.status !== 'reclaim_armed')
  ) {
    return null;
  }

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
        label: 'reentry volume',
        timeoutMs: 8_000,
      }
    );
    if (!res.ok) {
      logger.warn('DexScreener', 'reentry volume HTTP', {
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
    logger.error('DexScreener', 'reentry volume failed', {
      mint: mint.slice(0, 12),
      ...errorToMeta(err),
    });
    return null;
  }
}

function pruneExpired(): void {
  const now = Date.now();
  const params = getReEntryEffectiveParams();
  const ttlMs = params.watchMinutes * 60_000;
  for (const [, c] of candidates.entries()) {
    if (
      c.status === 'rebought' ||
      c.status === 'cancelled' ||
      c.status === 'expired'
    ) {
      continue;
    }
    if (now - c.createdAt > ttlMs) {
      c.status = 'expired';
      c.lastReason = `Watch window expired (${params.watchMinutes}m)`;
      c.updatedAt = now;
      console.log(`[reentry] Expired watch on ${c.symbol}`);
    }
  }
}

export function getReBuyStatus() {
  pruneExpired();
  const active = getReBuyCandidates().filter(
    (c) =>
      c.status === 'watching' ||
      c.status === 'dip_armed' ||
      c.status === 'reclaim_armed'
  );
  const params = getReEntryEffectiveParams();
  return {
    enabled: params.profitDipEnabled || params.stopReentryEnabled,
    profitDipEnabled: params.profitDipEnabled,
    stopReentryEnabled: params.stopReentryEnabled,
    watching: active.length,
    dipArmed: active.filter((c) => c.status === 'dip_armed').length,
    reclaimArmed: active.filter((c) => c.status === 'reclaim_armed').length,
    stopWatches: active.filter((c) => c.kind === 'stop_reentry').length,
    profitWatches: active.filter((c) => c.kind === 'profit_dip').length,
    sellHistoryCount: getSellHistory().length,
    effective: params,
    config: {
      reBuyDipPercent: config.strategy.reBuyDipPercent,
      confirmationThreshold: params.confirmationWallets,
      reBuyVolumeIncreasePct: params.minVolumeIncreasePct,
      reBuyMinProfitPct: params.minProfitPct,
      postStopReentryEnabled: params.stopReentryEnabled,
      reEntryMinReclaimPct: params.minReclaimPct,
      reEntryWatchMinutes: params.watchMinutes,
      reEntrySizeMultiplier: params.sizeMultiplier,
      reEntryMaxPerMint: params.maxPerMint,
      reEntryAfterMaxProfitEnabled: params.afterMaxProfitEnabled,
    },
  };
}
