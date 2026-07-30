/**
 * Zion micro-bot — offer store + manual approve → executeBuy.
 * Isolated from copy trading / market scanner auto-queues.
 */

import { randomUUID } from 'crypto';
import {
  atomicWriteJson,
  dataFile,
  PERSIST_FILES,
  readJsonFile,
} from './dataDir';
import { config } from './config';
import { logger, errorToMeta } from './logger';
import { executeBuy } from './trade';
import { runWithRpcRole } from './connection';
import { getCachedSolUsdPrice } from './marketData';
import { paperTrader } from './paperTrader';
import { clampToMaxAllowedTradeSol } from './risk';
import { isPumpFunMintSuffix } from './deadTokenFilters';

export type ZionOfferStatus =
  | 'pending'
  | 'approved'
  | 'declined'
  | 'expired'
  | 'executed'
  | 'failed';

export type ZionOfferSource = 'kol_scanner' | 'tracked_boost' | 'hybrid';

export interface ZionKolWalletRef {
  address: string;
  name: string;
  quality?: number;
  source?: string;
}

export interface ZionOffer {
  id: string;
  mint: string;
  symbol: string;
  name: string;
  source: ZionOfferSource;
  status: ZionOfferStatus;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  /** Snapshot at offer creation (entry / request-time) */
  mcUsd?: number;
  volumeH1Usd?: number;
  liquidityUsd?: number;
  holders?: number;
  /** Live refresh while offer is pending */
  liveMcUsd?: number;
  liveVolumeH1Usd?: number;
  liveLiquidityUsd?: number;
  liveHolders?: number;
  score: number;
  reasons: string[];
  kolWallets: ZionKolWalletRef[];
  kolCount: number;
  trackedBoostCount: number;
  skipReason?: string;
  error?: string;
  /** Set when user explicitly declines (vs TTL expiry) */
  declinedByUser?: boolean;
  /** Popup was dismissed by user (offer may still be Active) */
  popupDismissed?: boolean;
  executedAt?: number;
  solAmount?: number;
}

const OFFERS_FILE = dataFile(PERSIST_FILES.zionOffers);

let offers: ZionOffer[] = [];
const mintCooldownUntil = new Map<string, number>();
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readJsonFile<{ offers?: ZionOffer[] }>(OFFERS_FILE);
    if (raw?.offers && Array.isArray(raw.offers)) {
      offers = raw.offers.filter((o) => o && typeof o.id === 'string');
    }
  } catch (err) {
    logger.warn('Zion', 'Failed to load offers', errorToMeta(err));
    offers = [];
  }
}

/** Reload offers from disk after an external restore. */
export function reloadZionOffersFromDisk(): void {
  loaded = false;
  offers = [];
  mintCooldownUntil.clear();
  ensureLoaded();
}

function persist(): void {
  ensureLoaded();
  try {
    atomicWriteJson(OFFERS_FILE, {
      updatedAt: Date.now(),
      offers: offers.slice(0, 200),
    });
  } catch (err) {
    logger.warn('Zion', 'Failed to persist offers', errorToMeta(err));
  }
}

export function expireStaleOffers(): number {
  ensureLoaded();
  const now = Date.now();
  let n = 0;
  const minKol = Math.max(1, Number(config.zion?.minKolWallets) || 5);
  for (const o of offers) {
    if (o.status !== 'pending') continue;
    if (o.expiresAt <= now) {
      o.status = 'expired';
      o.updatedAt = now;
      n++;
      continue;
    }
    // Drop pending offers that no longer meet the hard KOL floor (e.g. created
    // when tracked boost was incorrectly allowed to satisfy minKolWallets).
    if ((o.kolCount || 0) < minKol) {
      o.status = 'expired';
      o.updatedAt = now;
      o.error = `Below min KOL wallets (${o.kolCount || 0} < ${minKol})`;
      n++;
    }
  }
  if (n) persist();
  return n;
}

export function listOffers(limit = 40): ZionOffer[] {
  ensureLoaded();
  expireStaleOffers();
  return [...offers]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, Math.max(1, Math.min(100, limit)));
}

export function getOffer(id: string): ZionOffer | null {
  ensureLoaded();
  return offers.find((o) => o.id === id) ?? null;
}

export function hasPendingOfferForMint(mint: string): boolean {
  return getPendingOfferForMint(mint) != null;
}

export function getPendingOfferForMint(mint: string): ZionOffer | null {
  ensureLoaded();
  expireStaleOffers();
  const m = String(mint || '').trim();
  if (!m) return null;
  return (
    offers.find((o) => o.mint === m && o.status === 'pending') ?? null
  );
}

function isMintCoolingDown(mint: string): boolean {
  const until = mintCooldownUntil.get(mint) ?? 0;
  return Date.now() < until;
}

function armMintCooldown(mint: string): void {
  const mins = Math.max(5, Number(config.zion?.mintCooldownMinutes) || 120);
  mintCooldownUntil.set(mint, Date.now() + mins * 60_000);
}

export function dashboardBaseUrl(): string {
  const fromEnv =
    process.env.DASHBOARD_BASE_URL?.trim() ||
    process.env.RENDER_EXTERNAL_URL?.trim() ||
    '';
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const port = config.port || 3000;
  return `http://localhost:${port}`;
}

export interface CreateOfferInput {
  mint: string;
  symbol: string;
  name?: string;
  source: ZionOfferSource;
  score: number;
  reasons: string[];
  kolWallets: ZionKolWalletRef[];
  trackedBoostCount?: number;
  mcUsd?: number;
  volumeH1Usd?: number;
  liquidityUsd?: number;
  holders?: number;
}

function looksLikeMintPrefix(symbol: string | undefined, mint: string): boolean {
  const s = String(symbol || '').trim();
  const m = String(mint || '').trim();
  if (!s || !m) return true;
  if (s.length > 12) return false;
  return m.toLowerCase().startsWith(s.toLowerCase());
}

/** Prefer a real ticker over a CA prefix fallback. */
export function pickZionDisplaySymbol(
  symbol: string | undefined,
  name: string | undefined,
  mint: string
): string {
  const sym = String(symbol || '').trim();
  const nm = String(name || '').trim();
  if (sym && !looksLikeMintPrefix(sym, mint)) return sym;
  if (nm && !looksLikeMintPrefix(nm, mint)) return nm;
  return sym || nm || mint.slice(0, 6);
}

function isConsiderableImprovement(
  prev: ZionOffer,
  next: CreateOfferInput
): boolean {
  let hits = 0;
  const prevVol = Number(prev.liveVolumeH1Usd ?? prev.volumeH1Usd) || 0;
  const nextVol = Number(next.volumeH1Usd) || 0;
  if (nextVol > 0 && prevVol > 0) {
    if (nextVol >= prevVol * 1.4 || nextVol - prevVol >= 10_000) hits += 1;
  } else if (nextVol >= 15_000 && nextVol > prevVol) {
    hits += 1;
  }

  const prevMc = Number(prev.liveMcUsd ?? prev.mcUsd) || 0;
  const nextMc = Number(next.mcUsd) || 0;
  if (nextMc > 0 && prevMc > 0) {
    if (nextMc >= prevMc * 1.3 || nextMc - prevMc >= 20_000) hits += 1;
  }

  const prevHold = Number(prev.liveHolders ?? prev.holders) || 0;
  const nextHold = Number(next.holders) || 0;
  if (nextHold > 0 && prevHold > 0) {
    if (nextHold >= prevHold * 1.25 || nextHold - prevHold >= 50) hits += 1;
  } else if (nextHold >= prevHold + 40) {
    hits += 1;
  }

  const prevKol = Number(prev.kolCount) || 0;
  const nextKol = next.kolWallets?.length ?? 0;
  if (nextKol > prevKol) hits += 1;

  const prevScore = Number(prev.score) || 0;
  const nextScore = Number(next.score) || 0;
  if (nextScore >= prevScore + 8) hits += 1;

  // Need meaningful multi-signal lift, or a strong single KOL+volume combo
  if (hits >= 2) return true;
  if (nextKol > prevKol && nextVol >= prevVol * 1.25 && nextVol - prevVol >= 5_000) {
    return true;
  }
  return false;
}

function getLatestClosedOfferForMint(mint: string): ZionOffer | null {
  const m = String(mint || '').trim();
  if (!m) return null;
  for (const o of offers) {
    if (o.mint !== m) continue;
    if (o.status === 'declined' || o.status === 'expired') return o;
  }
  return null;
}

/**
 * Refresh live metrics / KOL score on an existing pending offer.
 * Also upgrades symbol/name when we discover a real ticker.
 */
export function refreshPendingOfferLive(
  mint: string,
  input: Partial<CreateOfferInput> & { mint?: string }
): ZionOffer | null {
  ensureLoaded();
  const o = getPendingOfferForMint(mint);
  if (!o) return null;
  let changed = false;
  if (input.mcUsd != null && Number.isFinite(input.mcUsd)) {
    o.liveMcUsd = Number(input.mcUsd);
    changed = true;
  }
  if (input.volumeH1Usd != null && Number.isFinite(input.volumeH1Usd)) {
    o.liveVolumeH1Usd = Number(input.volumeH1Usd);
    changed = true;
  }
  if (input.liquidityUsd != null && Number.isFinite(input.liquidityUsd)) {
    o.liveLiquidityUsd = Number(input.liquidityUsd);
    changed = true;
  }
  if (input.holders != null && Number.isFinite(input.holders)) {
    o.liveHolders = Number(input.holders);
    changed = true;
  }
  if (input.score != null && Number.isFinite(input.score)) {
    o.score = Number(input.score);
    changed = true;
  }
  if (Array.isArray(input.reasons) && input.reasons.length) {
    o.reasons = input.reasons;
    changed = true;
  }
  if (Array.isArray(input.kolWallets) && input.kolWallets.length) {
    o.kolWallets = input.kolWallets;
    o.kolCount = input.kolWallets.length;
    changed = true;
  }
  if (input.trackedBoostCount != null) {
    o.trackedBoostCount = Math.max(0, Number(input.trackedBoostCount) || 0);
    changed = true;
  }
  const betterSym = pickZionDisplaySymbol(
    input.symbol || o.symbol,
    input.name || o.name,
    o.mint
  );
  if (betterSym && betterSym !== o.symbol) {
    o.symbol = betterSym;
    changed = true;
  }
  if (
    input.name &&
    !looksLikeMintPrefix(input.name, o.mint) &&
    input.name !== o.name
  ) {
    o.name = input.name;
    changed = true;
  }
  if (changed) {
    o.updatedAt = Date.now();
    persist();
  }
  return o;
}

export function maybeCreateOffer(
  input: CreateOfferInput
): ZionOffer | null {
  if (!config.zion?.enabled) return null;
  ensureLoaded();
  expireStaleOffers();

  const mint = String(input.mint || '').trim();
  if (!mint) return null;

  if (!isPumpFunMintSuffix(mint)) {
    return null;
  }

  if (hasPendingOfferForMint(mint)) {
    return refreshPendingOfferLive(mint, input);
  }

  const closed = getLatestClosedOfferForMint(mint);
  if (isMintCoolingDown(mint)) {
    // Allow a fresh request only after decline/expiry AND a considerable lift
    if (
      !closed ||
      (closed.status !== 'declined' && closed.status !== 'expired') ||
      !isConsiderableImprovement(closed, input)
    ) {
      return null;
    }
    mintCooldownUntil.delete(mint);
    logger.info(
      'Zion',
      `Re-offer allowed for ${mint.slice(0, 8)}… after considerable improvement`,
      {
        prevStatus: closed.status,
        prevScore: closed.score,
        nextScore: input.score,
      }
    );
  }

  const open = paperTrader.getOpenPositions().some((p) => p.mint === mint);
  if (open) return null;

  const minKol = Math.max(1, Number(config.zion.minKolWallets) || 5);
  const kolCount = input.kolWallets?.length ?? 0;
  const tracked = Math.max(0, Number(input.trackedBoostCount) || 0);
  // Min KOL wallets is a hard floor on real KOL wallets only.
  // Tracked smart wallets are a secondary score boost — they never satisfy this gate.
  if (kolCount < minKol) {
    return null;
  }

  const minMc = Number(config.zion.minMcUsd) || 0;
  const maxMc = Number(config.zion.maxMcUsd) || 0;
  if (input.mcUsd != null && Number.isFinite(input.mcUsd)) {
    if (minMc > 0 && input.mcUsd < minMc) return null;
    if (maxMc > 0 && input.mcUsd > maxMc) return null;
  }

  const displaySym = pickZionDisplaySymbol(input.symbol, input.name, mint);
  const displayName =
    input.name && !looksLikeMintPrefix(input.name, mint)
      ? input.name
      : displaySym;

  const ttlMin = Math.max(5, Number(config.zion.offerTtlMinutes) || 60);
  const now = Date.now();
  const offer: ZionOffer = {
    id: randomUUID(),
    mint,
    symbol: displaySym,
    name: displayName,
    source: input.source,
    status: 'pending',
    createdAt: now,
    expiresAt: now + ttlMin * 60_000,
    updatedAt: now,
    mcUsd: input.mcUsd,
    volumeH1Usd: input.volumeH1Usd,
    liquidityUsd: input.liquidityUsd,
    holders: input.holders,
    liveMcUsd: input.mcUsd,
    liveVolumeH1Usd: input.volumeH1Usd,
    liveLiquidityUsd: input.liquidityUsd,
    liveHolders: input.holders,
    score: input.score,
    reasons: input.reasons || [],
    kolWallets: input.kolWallets || [],
    kolCount,
    trackedBoostCount: tracked,
  };

  offers.unshift(offer);
  if (offers.length > 200) offers.length = 200;
  armMintCooldown(mint);
  persist();

  logger.info(
    'Zion',
    `Offer created ${offer.symbol} (${mint.slice(0, 8)}…) kol=${kolCount} score=${offer.score}`,
    { offerId: offer.id, source: offer.source }
  );

  try {
    const { pushDashboardNotification } =
      require('./dashboardNotifications') as typeof import('./dashboardNotifications');
    pushDashboardNotification({
      kind: 'trade_request',
      title: `Trade request · ${offer.symbol}`,
      body:
        (offer.reasons || []).slice(0, 2).join(' · ') ||
        `Score ${offer.score} · ${offer.source}`,
      offerId: offer.id,
      mint: offer.mint,
      symbol: offer.symbol,
      meta: { score: offer.score, source: offer.source },
    });
  } catch {
    /* optional */
  }

  if (config.zion.notifyEmailOnOffer !== false) {
    void notifyOfferEmail(offer);
  }

  return offer;
}

async function notifyOfferEmail(offer: ZionOffer): Promise<void> {
  try {
    const { notifyZionTradeOffer } =
      require('./emailNotifications') as typeof import('./emailNotifications');
    await notifyZionTradeOffer(offer);
  } catch (err) {
    logger.warn('Zion', 'Offer email failed', errorToMeta(err));
  }
}

export function declineOffer(id: string): ZionOffer | null {
  ensureLoaded();
  const o = getOffer(id);
  if (!o || o.status !== 'pending') return null;
  o.status = 'declined';
  o.declinedByUser = true;
  o.updatedAt = Date.now();
  persist();
  return o;
}

/** User closed the popup — offer stays Active but should not auto-popup again. */
export function markOfferPopupDismissed(id: string): ZionOffer | null {
  ensureLoaded();
  const o = getOffer(id);
  if (!o) return null;
  o.popupDismissed = true;
  o.updatedAt = Date.now();
  persist();
  return o;
}

export function markOfferOpened(id: string): ZionOffer | null {
  ensureLoaded();
  return getOffer(id);
}

export interface ApproveOfferOverrides {
  solAmount?: number;
  usdAmount?: number;
  useExitPresets?: boolean;
  takeProfitPct?: number;
  stopLossPct?: number;
  trailingStopPct?: number;
  trailingActivationProfit?: number;
}

export async function executeApprovedOffer(
  id: string,
  overrides: ApproveOfferOverrides = {}
): Promise<{
  ok: boolean;
  offer?: ZionOffer;
  error?: string;
  positionId?: string;
  open?: ReturnType<typeof paperTrader.getOpenPositions>;
}> {
  ensureLoaded();
  expireStaleOffers();
  const offer = getOffer(id);
  if (!offer) return { ok: false, error: 'Offer not found' };
  if (offer.status === 'executed') {
    return { ok: false, error: 'Already executed', offer };
  }
  if (offer.status !== 'pending' && offer.status !== 'approved') {
    return { ok: false, error: `Offer is ${offer.status}`, offer };
  }

  const d = config.zion.defaults;
  const useExit =
    overrides.useExitPresets != null
      ? Boolean(overrides.useExitPresets)
      : d.useExitPresets !== false;

  let solAmount = Number(overrides.solAmount);
  if (!(solAmount > 0)) {
    if (
      (overrides.usdAmount != null && Number(overrides.usdAmount) > 0) ||
      d.sizeMode === 'usd'
    ) {
      const usd =
        Number(overrides.usdAmount) > 0
          ? Number(overrides.usdAmount)
          : Number(d.usdAmount) || 50;
      const px = getCachedSolUsdPrice() || 150;
      solAmount = usd / px;
    } else {
      solAmount = Number(d.solAmount) || 0.25;
    }
  }
  solAmount = clampToMaxAllowedTradeSol(solAmount);

  offer.status = 'approved';
  offer.updatedAt = Date.now();
  offer.solAmount = solAmount;
  persist();

  const buyOpts: Parameters<typeof executeBuy>[2] = {
    solAmount,
    name: `Zion · ${offer.symbol}`,
    entrySource: 'zion',
    sourceNames: offer.kolWallets.map((w) => w.name || w.address.slice(0, 8)),
    sourceWallets: offer.kolWallets.map((w) => w.address),
    tradeProfileId: 'zion',
    tradeProfileName: 'Zion',
    tradeProfileIcon: '◈',
    tradeProfileColor: '#f2ae66',
    tradeProfileScore:
      offer.score != null && Number.isFinite(offer.score)
        ? Math.round(Math.max(0, Math.min(100, offer.score)))
        : undefined,
    tradeProfileReason:
      offer.reasons.slice(0, 3).join(' · ') ||
      'Triggered manually via Zion / KOL Scan',
    entryMarketCapUsd: offer.mcUsd,
  };

  if (useExit) {
    buyOpts.profileTakeProfitPct =
      overrides.takeProfitPct != null
        ? Number(overrides.takeProfitPct)
        : Number(d.takeProfitPct);
    buyOpts.profileStopLossPct =
      overrides.stopLossPct != null
        ? Number(overrides.stopLossPct)
        : Number(d.stopLossPct);
    buyOpts.profileTrailingStopPct =
      overrides.trailingStopPct != null
        ? Number(overrides.trailingStopPct)
        : Number(d.trailingStopPct);
    buyOpts.profileTrailingActivationProfit =
      overrides.trailingActivationProfit != null
        ? Number(overrides.trailingActivationProfit)
        : Number(d.trailingActivationProfit);
  }

  try {
    const result = await runWithRpcRole('secondary', () =>
      executeBuy(offer.mint, offer.symbol, buyOpts)
    );
    if (!result?.success) {
      offer.status = 'failed';
      offer.error = result?.error || 'executeBuy failed';
      offer.updatedAt = Date.now();
      persist();
      return { ok: false, offer, error: offer.error };
    }

    offer.status = 'executed';
    offer.executedAt = Date.now();
    offer.updatedAt = Date.now();
    offer.error = undefined;
    persist();

    // Don't block Place Trade response on email — fire and forget
    if (config.zion.notifyEmailOnPlaced !== false) {
      void Promise.resolve()
        .then(() => {
          const { notifyZionTradePlaced } =
            require('./emailNotifications') as typeof import('./emailNotifications');
          return notifyZionTradePlaced(offer, solAmount);
        })
        .catch((err) => {
          logger.warn('Zion', 'Placed email failed', errorToMeta(err));
        });
    }

    return {
      ok: true,
      offer,
      positionId: result.positionId,
      open: paperTrader.getOpenPositions(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    offer.status = 'failed';
    offer.error = message;
    offer.updatedAt = Date.now();
    persist();
    return { ok: false, offer, error: message };
  }
}

export function getZionStatus(): {
  enabled: boolean;
  pendingOffers: number;
  offerCount: number;
} {
  ensureLoaded();
  expireStaleOffers();
  return {
    enabled: config.zion?.enabled === true,
    pendingOffers: offers.filter((o) => o.status === 'pending').length,
    offerCount: offers.length,
  };
}
