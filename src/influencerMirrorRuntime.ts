/**
 * Influencer Mirror live path helpers — called from monitor poll/buy/sell.
 */

import { config, type SmartWallet } from './config';
import { executeBuy } from './trade';
import { paperTrader } from './paperTrader';
import { isDeniedCopyMint } from './deniedMints';
import { calculateDynamicPositionSize } from './risk';
import {
  clampSizeMult,
  getInfluencerMirrorConfig,
  influencerMirrorPrereqsOk,
  isInfluencerMirrorEnabled,
  isInfluencerMirrorWallet,
  walletDisplayName,
  walletFollowsSells,
} from './influencerMirror';
import { assignTradeProfile, stampFromAssignment } from './tradeProfiles';
import { evaluateAntiRug, summarizeAntiRug } from './antiRug';
import { fetchTokenMetrics, summarizeTokenMetrics } from './tokenMetrics';

/** mint+wallet → last event ms (spam / delay window) */
const recentMirrorEvents = new Map<string, number>();
/** sig+mint+wallet dedupe */
const seenMirrorSigs = new Set<string>();
const SEEN_SIG_CAP = 4_000;

export interface MirrorBuyInput {
  wallet: SmartWallet;
  mint: string;
  symbol: string;
  name: string;
  signature: string;
  timestamp: number;
  detectedAt?: number;
  isPumpFun: boolean;
  isMigration: boolean;
}

export interface MirrorSellInput {
  wallet: SmartWallet;
  mint: string;
  symbol: string;
  name: string;
  signature: string;
  timestamp: number;
}

function eventKey(wallet: string, mint: string): string {
  return `${wallet}:${mint}`;
}

function markSeenSig(sig: string, wallet: string, mint: string): boolean {
  const key = `${sig}:${wallet}:${mint}`;
  if (seenMirrorSigs.has(key)) return false;
  seenMirrorSigs.add(key);
  if (seenMirrorSigs.size > SEEN_SIG_CAP) {
    const drop = Math.floor(SEEN_SIG_CAP / 4);
    let i = 0;
    for (const k of seenMirrorSigs) {
      seenMirrorSigs.delete(k);
      if (++i >= drop) break;
    }
  }
  return true;
}

function withinDelayWindow(
  wallet: string,
  mint: string,
  maxDelayMs: number
): boolean {
  const k = eventKey(wallet, mint);
  const last = recentMirrorEvents.get(k);
  const now = Date.now();
  if (last != null && now - last < maxDelayMs) return true;
  recentMirrorEvents.set(k, now);
  return false;
}

function countOpenMirrored(): number {
  try {
    return paperTrader
      .getOpenPositions()
      .filter((p) => Boolean(p.mirrorWalletId))
      .length;
  } catch {
    return 0;
  }
}

export interface RecentMirrorCopy {
  walletAddress: string;
  mint: string;
  symbol: string;
  name: string;
  at: number;
  sizeSol?: number;
  taken: boolean;
  skipReason?: string;
}

const recentMirrorCopies: RecentMirrorCopy[] = [];
const MAX_RECENT_COPIES = 48;
const RECENT_COPY_TTL_MS = 2 * 60 * 60_000;

function noteRecentMirrorCopy(entry: RecentMirrorCopy): void {
  recentMirrorCopies.unshift(entry);
  if (recentMirrorCopies.length > MAX_RECENT_COPIES) {
    recentMirrorCopies.length = MAX_RECENT_COPIES;
  }
}

export function listRecentMirrorCopies(limit = 24): RecentMirrorCopy[] {
  const now = Date.now();
  return recentMirrorCopies
    .filter((c) => now - c.at < RECENT_COPY_TTL_MS)
    .slice(0, Math.max(1, Math.min(40, limit)));
}

function reportMirrorBuyFight(
  buy: MirrorBuyInput,
  walletName: string,
  taken: boolean,
  skipReason?: string,
  sizeSol?: number
): void {
  try {
    const { logInfluencerMirrorLaneFight } =
      require('./monitor') as typeof import('./monitor');
    logInfluencerMirrorLaneFight({
      mint: buy.mint,
      symbol: buy.symbol,
      opened: taken,
      walletName,
      skipReason,
      sizeSol,
    });
  } catch {
    /* optional */
  }
  if (taken) {
    noteRecentMirrorCopy({
      walletAddress: buy.wallet.address,
      mint: buy.mint,
      symbol: buy.symbol,
      name: buy.name,
      at: Date.now(),
      sizeSol,
      taken: true,
    });
  }
}

/**
 * Fast mirror buy via smart_money_mirror. Returns handled if this path owns the event.
 */
export async function tryInfluencerMirrorBuy(
  buy: MirrorBuyInput
): Promise<{ handled: boolean; taken?: boolean; skipReason?: string }> {
  if (!isInfluencerMirrorEnabled()) return { handled: false };
  if (!isInfluencerMirrorWallet(buy.wallet)) return { handled: false };

  const im = getInfluencerMirrorConfig();
  const name = walletDisplayName(buy.wallet);
  const label = buy.symbol || buy.mint.slice(0, 8);
  const skip = (reason: string) => {
    console.log(`[influencer-mirror] Skip buy ${label} — ${reason}`);
    reportMirrorBuyFight(buy, name, false, reason);
    return {
      handled: true as const,
      taken: false as const,
      skipReason: reason,
    };
  };

  console.log(`[monitor] Influencer ${name} bought ${label}`);

  const prereq = influencerMirrorPrereqsOk();
  if (!prereq.ok) return skip(prereq.reason || 'prereqs');

  if (isDeniedCopyMint(buy.mint, config.solMint)) {
    return skip('denied mint');
  }

  if (!markSeenSig(buy.signature, buy.wallet.address, buy.mint)) {
    // Quiet — duplicate polls should not spam fight log
    return { handled: true, taken: false, skipReason: 'duplicate sig' };
  }

  if (withinDelayWindow(buy.wallet.address, buy.mint, im.maxCopyDelayMs)) {
    return skip('delay window');
  }

  const detected = buy.detectedAt ?? Date.now();
  const ageMs = detected - (buy.timestamp || detected);
  const isManualWatchlist = String(buy.signature || '').startsWith(
    'watchlist-add-'
  );
  if (!isManualWatchlist && ageMs > im.maxCopyDelayMs) {
    return skip(`late signal (${Math.round(ageMs / 1000)}s)`);
  }

  if (
    paperTrader.hasOpenMint(buy.mint) ||
    countOpenMirrored() >= im.maxConcurrentMirrored
  ) {
    return skip(
      paperTrader.hasOpenMint(buy.mint)
        ? 'already holding'
        : `max concurrent mirrored (${im.maxConcurrentMirrored})`
    );
  }

  let metrics: ReturnType<typeof summarizeTokenMetrics> | undefined;
  let antiRug: ReturnType<typeof summarizeAntiRug> | undefined;
  try {
    const raw = await fetchTokenMetrics(buy.mint);
    metrics = summarizeTokenMetrics(raw);
  } catch {
    /* non-fatal */
  }
  try {
    const report = await evaluateAntiRug(buy.mint, {
      earlyEntry: Boolean(buy.isPumpFun && !buy.isMigration),
      isMigrated: buy.isMigration,
    });
    antiRug = summarizeAntiRug(report);
    if (antiRug && antiRug.ok === false) {
      return skip('anti-rug');
    }
  } catch {
    /* fail soft */
  }

  const liq = metrics?.liquidityUsd;
  const volM5 = metrics?.volumeM5Usd;
  if (liq != null && liq > 0 && liq < im.minLiquidityUsd) {
    return skip('thin liquidity');
  }
  if (volM5 != null && volM5 > 0 && volM5 < im.minVolumeM5Usd) {
    return skip('thin volume m5');
  }

  const drop = metrics?.priceChangeH1Pct;
  if (drop != null && drop < -22) {
    return skip('extended dump');
  }

  const walletMult = clampSizeMult(buy.wallet.sizeMult ?? 1);
  const copyW =
    Number.isFinite(Number(buy.wallet.copyWeight)) &&
    Number(buy.wallet.copyWeight) > 0
      ? Math.min(1.5, Math.max(0.35, Number(buy.wallet.copyWeight)))
      : 1;
  const sizeMult = walletMult * copyW;

  const sizing = calculateDynamicPositionSize({
    equitySol: paperTrader.getEquitySol(),
    kind: buy.isMigration ? 'migration' : 'normal',
    riskScore: antiRug?.riskScore,
    sizeMultiplier: sizeMult,
    openCount: paperTrader.getOpenPositions().length,
  });

  const buyOpts: NonNullable<Parameters<typeof executeBuy>[2]> = {
    sourceWallets: [buy.wallet.address],
    sourceNames: [name],
    name: buy.name,
    strategyKind: buy.isMigration ? 'migration' : 'normal',
    solAmount: sizing.sizeSol,
    sizeReason: `${sizing.reason} · influencer×${sizeMult.toFixed(2)}`,
    entrySource: 'wallet',
    entryStyle: 'smart_money_confirm',
    mirrorWalletId: buy.wallet.address,
    mirrorWalletName: name,
    antiRug: antiRug
      ? {
          riskScore: antiRug.riskScore,
          riskLevel: antiRug.riskLevel,
          flags: antiRug.flags,
          ok: antiRug.ok,
        }
      : undefined,
    top10HoldPct: metrics?.top10HoldPct ?? null,
  };

  if (im.useJito) {
    buyOpts.profileTurboMode = true;
  }

  const assignment = assignTradeProfile({
    isMigration: buy.isMigration,
    preferProfileId: 'smart_money_mirror',
    symbol: buy.symbol,
    marketCapUsd: metrics?.marketCapUsd ?? null,
    liquidityUsd: metrics?.liquidityUsd ?? null,
    volumeH1Usd: metrics?.volumeH1Usd ?? null,
    volumeM5Usd: metrics?.volumeM5Usd ?? null,
    walletCount: 1,
    entrySource: 'wallet',
    strategyKind: buyOpts.strategyKind,
  });

  if (assignment.skipped) {
    return skip(assignment.skipReason || 'profile skip');
  }

  Object.assign(buyOpts, stampFromAssignment(assignment));
  if (buyOpts.tradeProfileId !== 'smart_money_mirror') {
    try {
      const { resolveTradeProfileDefinition } =
        require('./tradeProfiles') as typeof import('./tradeProfiles');
      const def = resolveTradeProfileDefinition('smart_money_mirror');
      buyOpts.tradeProfileId = 'smart_money_mirror';
      buyOpts.tradeProfileName = def.name;
      buyOpts.tradeProfileIcon = def.icon;
      buyOpts.tradeProfileColor = def.color;
      buyOpts.tradeProfileReason = 'influencer mirror · prefer SMM';
    } catch {
      buyOpts.tradeProfileId = 'smart_money_mirror';
    }
  }
  buyOpts.entryStyle = 'smart_money_confirm';
  buyOpts.mirrorWalletId = buy.wallet.address;
  buyOpts.mirrorWalletName = name;

  // Soft GK (default): always evaluate when HMC on; soft activity advisory.
  // Hard safety still blocks. gatekeeperOptional=false → full soft enforce.
  try {
    const { evaluateGatekeeper, isGatekeeperActive } =
      require('./hierarchicalCoordination') as typeof import('./hierarchicalCoordination');
    if (isGatekeeperActive()) {
      const gk = evaluateGatekeeper({
        mint: buy.mint,
        symbol: buy.symbol,
        profileHint: 'smart_money_mirror',
        influencerMirrorSoftPass: im.gatekeeperOptional === true,
        metrics: metrics
          ? {
              liquidityUsd: metrics.liquidityUsd,
              volumeM5Usd: metrics.volumeM5Usd,
              volumeH1Usd: metrics.volumeH1Usd,
              marketCapUsd: metrics.marketCapUsd,
              priceChangeH1Pct: metrics.priceChangeH1Pct,
              priceChange24hPct: metrics.priceChange24hPct,
            }
          : null,
        antiRug: antiRug
          ? {
              ok: antiRug.ok,
              riskLevel: antiRug.riskLevel,
              riskScore: antiRug.riskScore,
              honeypot: antiRug.honeypot,
              skipReasons: antiRug.skipReasons,
              flags: antiRug.flags,
            }
          : null,
      });
      if (gk.decision === 'block') {
        return skip(gk.plainLanguage || 'gatekeeper block');
      }
    }
  } catch {
    /* fail open soft */
  }

  const result = await executeBuy(buy.mint, buy.symbol, buyOpts);
  if (result.success) {
    noteInfluencerTokenEvent(buy.wallet.address, buy.mint, 'buy', {
      symbol: buy.symbol,
      name: buy.name,
    });
    console.log(
      `[influencer-mirror] Mirrored buy ${label} from ${name} ` +
        `via ${buyOpts.tradeProfileId} (${sizing.sizeSol.toFixed(3)} SOL)`
    );
    reportMirrorBuyFight(buy, name, true, undefined, sizing.sizeSol);
    return { handled: true, taken: true };
  }
  return skip(result.error || 'executeBuy failed');
}

/**
 * Copy sell — only positions stamped with matching source/mirror wallet.
 */
export async function tryInfluencerMirrorSell(
  sell: MirrorSellInput
): Promise<{ handled: boolean; sold?: boolean; skipReason?: string }> {
  if (!isInfluencerMirrorEnabled()) return { handled: false };
  if (!isInfluencerMirrorWallet(sell.wallet)) return { handled: false };

  const im = getInfluencerMirrorConfig();
  if (!im.copySells) return { handled: false };
  if (!walletFollowsSells(sell.wallet)) {
    return { handled: true, sold: false, skipReason: 'followSells off' };
  }

  const name = walletDisplayName(sell.wallet);
  const label = sell.symbol || sell.mint.slice(0, 8);
  console.log(`[monitor] Influencer ${name} sold ${label}`);

  if (!markSeenSig(sell.signature, sell.wallet.address, sell.mint)) {
    return { handled: true, sold: false, skipReason: 'duplicate sig' };
  }
  if (withinDelayWindow(sell.wallet.address, sell.mint, im.maxCopyDelayMs)) {
    return { handled: true, sold: false, skipReason: 'delay window' };
  }

  const open = paperTrader.getOpenPositions().filter((p) => {
    if (p.mint !== sell.mint) return false;
    if (p.mirrorWalletId && p.mirrorWalletId === sell.wallet.address) {
      return true;
    }
    if (
      Array.isArray(p.sourceWallets) &&
      p.sourceWallets.includes(sell.wallet.address)
    ) {
      return (
        p.tradeProfileId === 'smart_money_mirror' ||
        Boolean(p.mirrorWalletId) ||
        p.entryStyle === 'smart_money_confirm'
      );
    }
    return false;
  });

  if (!open.length) {
    return { handled: true, sold: false, skipReason: 'no matching position' };
  }

  void im.sellUnrelated;

  // Prefer mirror sell over soft PPP — defer competing PPP briefly
  markMirrorSellPreferred(sell.mint);

  let soldAny = false;
  for (const pos of open) {
    const reason = 'influencer_mirror_sell';
    if (
      im.partialSellPct != null &&
      im.partialSellPct > 0 &&
      im.partialSellPct < 100
    ) {
      try {
        const price = paperTrader.getTokenPrice(pos.mint) ?? pos.entryPriceSol;
        paperTrader.simulateSell(pos.id, price, reason, {
          sellPctOfInitial: im.partialSellPct,
        });
        soldAny = true;
        noteInfluencerTokenEvent(sell.wallet.address, sell.mint, 'partial', {
          symbol: sell.symbol,
          name: sell.name,
        });
        console.log(
          `[influencer-mirror] Partial ${im.partialSellPct}% sell ${label} ` +
            `(mirrored ${name})`
        );
      } catch (err) {
        console.warn(
          `[influencer-mirror] Partial sell failed:`,
          err instanceof Error ? err.message : err
        );
      }
    } else {
      const r = await paperTrader.forceSellPosition(pos.id, reason);
      if (r.ok) {
        soldAny = true;
        noteInfluencerTokenEvent(sell.wallet.address, sell.mint, 'sell', {
          symbol: sell.symbol,
          name: sell.name,
        });
        console.log(
          `[influencer-mirror] Full exit ${label} (mirrored ${name})`
        );
      } else {
        console.warn(
          `[influencer-mirror] Exit failed ${label}: ${r.error || 'unknown'}`
        );
      }
    }
  }

  return { handled: true, sold: soldAny };
}

// ── Exit preference + soft SL overlay ─────────────────────────────────────

/** mint → prefer mirror-sell until this ms (defer soft PPP full-exit) */
const mirrorSellPreferredUntil = new Map<string, number>();
const MIRROR_SELL_DEFER_MS = 12_000;

export function markMirrorSellPreferred(mint: string, ms = MIRROR_SELL_DEFER_MS): void {
  const m = String(mint || '').trim();
  if (!m) return;
  mirrorSellPreferredUntil.set(m, Date.now() + Math.max(2_000, ms));
}

export function isMirrorSellPreferred(mint: string): boolean {
  const m = String(mint || '').trim();
  if (!m) return false;
  const until = mirrorSellPreferredUntil.get(m);
  if (until == null) return false;
  if (Date.now() > until) {
    mirrorSellPreferredUntil.delete(m);
    return false;
  }
  return true;
}

/** Soft SL multiplier for mirrored positions (tighter; hard floor unchanged). */
export const MIRROR_SOFT_SL_MULT = 0.9;

export function applyMirroredSoftSlOverlay(
  stopLossPct: number | null | undefined
): number | null {
  if (stopLossPct == null || !Number.isFinite(Number(stopLossPct))) return null;
  const raw = Number(stopLossPct);
  const abs = Math.abs(raw);
  if (!(abs > 0)) return raw;
  // Tighter = smaller abs magnitude (exit sooner on losses)
  const tightened = Math.max(4, abs * MIRROR_SOFT_SL_MULT);
  return raw > 0 ? tightened : -tightened;
}

/**
 * Poor signs → allow PPP/soft harvest earlier on mirrored positions.
 * (rising giveback, dead volume, structure break)
 */
export function mirroredPoorSignsAllowEarlierPpp(input: {
  peakUnrealizedPct?: number | null;
  pnlPct?: number | null;
  volumeDecayState?: string | null;
  taStructureBroken?: boolean;
}): boolean {
  const peak = Math.max(0, Number(input.peakUnrealizedPct) || 0);
  const pnl = Number(input.pnlPct) || 0;
  const givebackPctOfPeak = peak > 0 ? ((peak - pnl) / peak) * 100 : 0;
  if (givebackPctOfPeak >= 28 && peak >= 6) return true;
  if (
    input.volumeDecayState === 'collapsed' ||
    input.volumeDecayState === 'decaying'
  ) {
    return peak >= 4;
  }
  if (input.taStructureBroken === true && peak >= 5) return true;
  return false;
}

// ── Watchlist holdings cache ───────────────────────────────────────────────

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const HOLDINGS_CACHE_TTL_MS = 90_000;

export interface InfluencerTokenSnap {
  mint: string;
  symbol?: string;
  name?: string;
  status: 'holding' | 'sold' | 'partial';
  amountUi?: number;
  marketCapUsd?: number | null;
  holders?: number | null;
  updatedAt: number;
}

interface WalletHoldingsCache {
  fetchedAt: number;
  tokens: InfluencerTokenSnap[];
}

const holdingsCache = new Map<string, WalletHoldingsCache>();
/** wallet:mint → last known event */
const tokenEvents = new Map<
  string,
  { kind: 'buy' | 'sell' | 'partial'; at: number; symbol?: string; name?: string }
>();

export function noteInfluencerTokenEvent(
  wallet: string,
  mint: string,
  kind: 'buy' | 'sell' | 'partial',
  meta?: { symbol?: string; name?: string }
): void {
  const w = String(wallet || '').trim();
  const m = String(mint || '').trim();
  if (!w || !m) return;
  tokenEvents.set(`${w}:${m}`, {
    kind,
    at: Date.now(),
    symbol: meta?.symbol,
    name: meta?.name,
  });
  // Invalidate holdings cache so next watchlist refresh merges events
  holdingsCache.delete(w);
}

async function fetchWalletTokenMints(
  address: string
): Promise<InfluencerTokenSnap[]> {
  try {
    const { PublicKey } = require('@solana/web3.js') as typeof import('@solana/web3.js');
    const { getConnection, runWithRpcRole } =
      require('./connection') as typeof import('./connection');
    const owner = new PublicKey(address);
    const programId = new PublicKey(TOKEN_PROGRAM_ID);
    const resp = await runWithRpcRole('utility', async () => {
      const conn = getConnection();
      return conn.getParsedTokenAccountsByOwner(owner, { programId });
    });
    const out: InfluencerTokenSnap[] = [];
    const now = Date.now();
    for (const row of resp?.value || []) {
      try {
        const info = row.account.data.parsed?.info;
        const mint = String(info?.mint || '').trim();
        const amount = Number(info?.tokenAmount?.uiAmount ?? 0);
        if (!mint || !(amount > 0)) continue;
        // Skip obvious dust / wrapped SOL noise handled elsewhere
        out.push({
          mint,
          status: 'holding',
          amountUi: amount,
          updatedAt: now,
        });
      } catch {
        /* skip row */
      }
    }
    // Prefer largest balances first
    out.sort((a, b) => (b.amountUi || 0) - (a.amountUi || 0));
    return out.slice(0, 12);
  } catch (err) {
    console.warn(
      '[influencer-mirror] holdings RPC failed:',
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

async function getWalletHoldingsCached(
  address: string
): Promise<InfluencerTokenSnap[]> {
  const hit = holdingsCache.get(address);
  if (hit && Date.now() - hit.fetchedAt < HOLDINGS_CACHE_TTL_MS) {
    return hit.tokens;
  }
  const tokens = await fetchWalletTokenMints(address);
  // Merge recent sell/partial events for status
  const holdingMints = new Set(tokens.map((t) => t.mint));
  for (const [key, ev] of tokenEvents) {
    if (!key.startsWith(address + ':')) continue;
    const mint = key.slice(address.length + 1);
    if (ev.kind === 'sell' && !holdingMints.has(mint)) {
      tokens.push({
        mint,
        symbol: ev.symbol,
        name: ev.name,
        status: 'sold',
        updatedAt: ev.at,
      });
    } else if (ev.kind === 'partial' && holdingMints.has(mint)) {
      const row = tokens.find((t) => t.mint === mint);
      if (row) row.status = 'partial';
    } else if (ev.kind === 'buy' && holdingMints.has(mint)) {
      const row = tokens.find((t) => t.mint === mint);
      if (row) {
        row.symbol = row.symbol || ev.symbol;
        row.name = row.name || ev.name;
      }
    }
  }
  tokens.sort((a, b) => {
    const rank = (s: string) =>
      s === 'holding' ? 0 : s === 'partial' ? 1 : 2;
    const d = rank(a.status) - rank(b.status);
    if (d !== 0) return d;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  const sliced = tokens.slice(0, 8);
  holdingsCache.set(address, { fetchedAt: Date.now(), tokens: sliced });
  return sliced;
}

export interface SmartMirrorWatchlistToken {
  mint: string;
  symbol: string;
  name: string;
  status: 'holding' | 'sold' | 'partial' | 'copied';
  marketCapUsd: number | null;
  holders: number | null;
  youHold: boolean;
  /** We mirrored this mint from this influencer (open or recent). */
  copied: boolean;
  copiedAt: number | null;
  copiedSizeSol: number | null;
  crossHoldCount: number;
  canAdd: boolean;
}

export interface SmartMirrorWatchlistInfluencer {
  address: string;
  name: string;
  pnl30dUsd: number | null;
  winRate: number | null;
  tokens: SmartMirrorWatchlistToken[];
}

export async function buildSmartMirrorWatchlist(opts?: {
  topN?: number;
  tokensPerWallet?: number;
}): Promise<{
  influencers: SmartMirrorWatchlistInfluencer[];
  fetchedAt: number;
  error?: string;
}> {
  const {
    listTopInfluencerWallets,
    walletDisplayName,
  } = require('./influencerMirror') as typeof import('./influencerMirror');
  const topN = Math.min(Math.max(opts?.topN ?? 10, 1), 15);
  const per = Math.min(Math.max(opts?.tokensPerWallet ?? 3, 1), 8);
  const wallets = listTopInfluencerWallets(topN);
  const openMints = new Set(
    paperTrader.getOpenPositions().map((p) => p.mint)
  );
  // Stay under dashboard client timeout (60s) even when utility RPC is slow.
  // Reserve the last ~17s for MC/holders enrichment (was often starved).
  const started = Date.now();
  const holdingsDeadline = started + 28_000;
  const deadline = started + 45_000;

  // Fetch holdings with light concurrency (was fully sequential → easy 20s+ client abort)
  const holdingsByWallet = new Map<string, InfluencerTokenSnap[]>();
  const concurrency = 3;
  let cursor = 0;
  async function holdingsWorker(): Promise<void> {
    while (cursor < wallets.length) {
      const i = cursor++;
      const w = wallets[i]!;
      if (Date.now() > holdingsDeadline) {
        holdingsByWallet.set(w.address, []);
        continue;
      }
      holdingsByWallet.set(w.address, await getWalletHoldingsCached(w.address));
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(wallets.length, 1)) }, () =>
      holdingsWorker()
    )
  );

  // Cross-hold map (non-sold across full holdings snap)
  const mintHolders = new Map<string, Set<string>>();
  for (const [addr, toks] of holdingsByWallet) {
    for (const t of toks) {
      if (t.status === 'sold') continue;
      if (!mintHolders.has(t.mint)) mintHolders.set(t.mint, new Set());
      mintHolders.get(t.mint)!.add(addr);
    }
  }

  // Displayed tokens first (top N per influencer) — enrich these, not a random Map slice
  const displayByWallet = new Map<string, InfluencerTokenSnap[]>();
  const displayMints: string[] = [];
  const seenMint = new Set<string>();
  for (const w of wallets) {
    const toks = (holdingsByWallet.get(w.address) || []).slice(0, per);
    displayByWallet.set(w.address, toks);
    for (const t of toks) {
      if (seenMint.has(t.mint)) continue;
      seenMint.add(t.mint);
      displayMints.push(t.mint);
    }
  }

  // Light metrics (Dex/Jupiter/GMGN) in parallel — full on-chain walk was too slow
  const metricsMap = new Map<
    string,
    { marketCapUsd: number | null; holders: number | null }
  >();
  try {
    const { fetchTokenMetrics, summarizeTokenMetrics } =
      require('./tokenMetrics') as typeof import('./tokenMetrics');
    const metricsConcurrency = 5;
    let mCursor = 0;
    async function metricsWorker(): Promise<void> {
      while (mCursor < displayMints.length) {
        if (Date.now() > deadline) return;
        const mi = mCursor++;
        const mint = displayMints[mi]!;
        try {
          const raw = await fetchTokenMetrics(mint, { light: true });
          const s = summarizeTokenMetrics(raw);
          metricsMap.set(mint, {
            marketCapUsd: s.marketCapUsd ?? null,
            holders: s.holderCountEstimate ?? null,
          });
        } catch {
          /* skip */
        }
      }
    }
    if (displayMints.length > 0) {
      await Promise.all(
        Array.from(
          {
            length: Math.min(metricsConcurrency, displayMints.length),
          },
          () => metricsWorker()
        )
      );
    }
  } catch {
    /* optional */
  }

  const openByMirror = new Map<
    string,
    { mint: string; sizeSol: number | null; at: number }
  >();
  try {
    for (const p of paperTrader.getOpenPositions()) {
      const mid = String(p.mirrorWalletId || '').trim();
      if (!mid) continue;
      const cost =
        (p as { initialCostSol?: number; costSol?: number }).initialCostSol ??
        (p as { costSol?: number }).costSol;
      openByMirror.set(`${mid}:${p.mint}`, {
        mint: p.mint,
        sizeSol: cost != null && Number.isFinite(Number(cost)) ? Number(cost) : null,
        at: Number(p.openedAt) || Date.now(),
      });
    }
  } catch {
    /* optional */
  }
  const recentTaken = listRecentMirrorCopies(40).filter((c) => c.taken);

  const influencers: SmartMirrorWatchlistInfluencer[] = wallets.map((w) => {
    const toks = [...(displayByWallet.get(w.address) || [])];
    const seen = new Set(toks.map((t) => t.mint));
    // Surface freshly copied mints even if RPC holdings lag
    for (const c of recentTaken) {
      if (c.walletAddress !== w.address || seen.has(c.mint)) continue;
      toks.unshift({
        mint: c.mint,
        symbol: c.symbol,
        name: c.name,
        status: 'holding',
        updatedAt: c.at,
      });
      seen.add(c.mint);
    }
    for (const [key, op] of openByMirror) {
      if (!key.startsWith(w.address + ':') || seen.has(op.mint)) continue;
      toks.unshift({
        mint: op.mint,
        symbol: op.mint.slice(0, 6),
        name: op.mint.slice(0, 8),
        status: 'holding',
        updatedAt: op.at,
      });
      seen.add(op.mint);
    }
    const sliced = toks.slice(0, per);
    return {
      address: w.address,
      name: walletDisplayName(w),
      pnl30dUsd:
        w.pnl30dUsd != null && Number.isFinite(Number(w.pnl30dUsd))
          ? Number(w.pnl30dUsd)
          : null,
      winRate:
        w.winRate != null && Number.isFinite(Number(w.winRate))
          ? Number(w.winRate)
          : null,
      tokens: sliced.map((t) => {
        const meta = metricsMap.get(t.mint);
        const youHold = openMints.has(t.mint);
        const openCopy = openByMirror.get(`${w.address}:${t.mint}`);
        const recent = recentTaken.find(
          (c) => c.walletAddress === w.address && c.mint === t.mint
        );
        const copied = Boolean(openCopy || recent);
        const copiedAt = openCopy?.at ?? recent?.at ?? null;
        const copiedSizeSol =
          openCopy?.sizeSol ??
          (recent?.sizeSol != null ? Number(recent.sizeSol) : null);
        const cross = Math.max(
          0,
          (mintHolders.get(t.mint)?.size || 0) - 1
        );
        return {
          mint: t.mint,
          symbol: t.symbol || t.mint.slice(0, 6),
          name: t.name || t.symbol || t.mint.slice(0, 8),
          status: copied ? 'copied' : t.status,
          marketCapUsd: meta?.marketCapUsd ?? null,
          holders: meta?.holders ?? null,
          youHold,
          copied,
          copiedAt,
          copiedSizeSol,
          crossHoldCount: cross,
          canAdd: !youHold && !copied && t.status !== 'sold',
        };
      }),
    };
  });

  return { influencers, fetchedAt: Date.now() };
}

/**
 * Manual Add-token from Watchlist → same profile-sized mirror buy path.
 */
export async function mirrorBuyFromWatchlist(input: {
  walletAddress: string;
  mint: string;
  symbol?: string;
  name?: string;
}): Promise<{ ok: boolean; taken?: boolean; error?: string }> {
  const wallet = config.smartWallets.find(
    (w) => w.address === String(input.walletAddress || '').trim()
  );
  if (!wallet || !isInfluencerMirrorWallet(wallet)) {
    return { ok: false, error: 'Influencer wallet not found / not eligible' };
  }
  if (!isInfluencerMirrorEnabled()) {
    return { ok: false, error: 'Influencer Mirror master is OFF' };
  }
  const mint = String(input.mint || '').trim();
  if (!mint) return { ok: false, error: 'mint required' };
  const r = await tryInfluencerMirrorBuy({
    wallet,
    mint,
    symbol: String(input.symbol || mint.slice(0, 6)),
    name: String(input.name || input.symbol || mint.slice(0, 8)),
    signature: `watchlist-add-${mint}-${Date.now()}`,
    timestamp: Date.now(),
    detectedAt: Date.now(),
    isPumpFun: false,
    isMigration: false,
  });
  if (!r.handled) {
    return { ok: false, error: 'Mirror path inactive' };
  }
  return {
    ok: r.taken === true,
    taken: r.taken,
    error: r.taken ? undefined : r.skipReason || 'not taken',
  };
}
