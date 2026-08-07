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

  console.log(`[monitor] Influencer ${name} bought ${label}`);

  const prereq = influencerMirrorPrereqsOk();
  if (!prereq.ok) {
    console.log(`[influencer-mirror] Skip buy ${label} — ${prereq.reason}`);
    return { handled: true, taken: false, skipReason: prereq.reason };
  }

  if (isDeniedCopyMint(buy.mint, config.solMint)) {
    return { handled: true, taken: false, skipReason: 'denied mint' };
  }

  if (!markSeenSig(buy.signature, buy.wallet.address, buy.mint)) {
    return { handled: true, taken: false, skipReason: 'duplicate sig' };
  }

  if (withinDelayWindow(buy.wallet.address, buy.mint, im.maxCopyDelayMs)) {
    console.log(
      `[influencer-mirror] Ignoring spam/duplicate window for ${name}/${label}`
    );
    return { handled: true, taken: false, skipReason: 'delay window' };
  }

  const detected = buy.detectedAt ?? Date.now();
  const ageMs = detected - (buy.timestamp || detected);
  if (ageMs > im.maxCopyDelayMs) {
    console.log(
      `[influencer-mirror] Skip late buy ${label} age=${Math.round(ageMs / 1000)}s`
    );
    return { handled: true, taken: false, skipReason: 'late signal' };
  }

  if (
    paperTrader.hasOpenMint(buy.mint) ||
    countOpenMirrored() >= im.maxConcurrentMirrored
  ) {
    const reason = paperTrader.hasOpenMint(buy.mint)
      ? 'already holding'
      : `max concurrent mirrored (${im.maxConcurrentMirrored})`;
    console.log(`[influencer-mirror] Skip ${label} — ${reason}`);
    return { handled: true, taken: false, skipReason: reason };
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
      console.log(`[influencer-mirror] Skip ${label} — anti-rug fail`);
      return { handled: true, taken: false, skipReason: 'anti-rug' };
    }
  } catch {
    /* fail soft */
  }

  const liq = metrics?.liquidityUsd;
  const volM5 = metrics?.volumeM5Usd;
  if (liq != null && liq > 0 && liq < im.minLiquidityUsd) {
    return { handled: true, taken: false, skipReason: 'thin liquidity' };
  }
  if (volM5 != null && volM5 > 0 && volM5 < im.minVolumeM5Usd) {
    return { handled: true, taken: false, skipReason: 'thin volume m5' };
  }

  const drop = metrics?.priceChangeH1Pct;
  if (drop != null && drop < -22) {
    return { handled: true, taken: false, skipReason: 'extended dump' };
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
    return {
      handled: true,
      taken: false,
      skipReason: assignment.skipReason || 'profile skip',
    };
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

  if (!im.gatekeeperOptional) {
    try {
      const { evaluateGatekeeper, isGatekeeperActive } =
        require('./hierarchicalCoordination') as typeof import('./hierarchicalCoordination');
      if (isGatekeeperActive()) {
        const gk = evaluateGatekeeper({
          mint: buy.mint,
          symbol: buy.symbol,
          profileHint: 'smart_money_mirror',
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
          return {
            handled: true,
            taken: false,
            skipReason: gk.plainLanguage,
          };
        }
      }
    } catch {
      /* fail open soft */
    }
  }

  const result = await executeBuy(buy.mint, buy.symbol, buyOpts);
  if (result.success) {
    console.log(
      `[influencer-mirror] Mirrored buy ${label} from ${name} ` +
        `via ${buyOpts.tradeProfileId} (${sizing.sizeSol.toFixed(3)} SOL)`
    );
    return { handled: true, taken: true };
  }
  return {
    handled: true,
    taken: false,
    skipReason: result.error || 'executeBuy failed',
  };
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
