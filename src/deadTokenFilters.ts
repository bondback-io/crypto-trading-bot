/**
 * Non-bypassable dead-token gates: volume, liquidity, holders/activity,
 * bonding-curve health, and net-negative + price-crash.
 * Used by antiRug before every buy (paper + live). High risk cannot skip these.
 */

import {
  HARD_FILTER_FLOORS,
  config,
  effectiveMinHolders,
  effectiveMinLiquidityUsd,
  effectiveMinRecentActivity,
  effectiveMinRecentBuyVolumeUsd,
  effectiveMinRecentVolumeUsd,
  effectiveMinVolume24hUsd,
} from './config';
import type { BondingCurveHealth } from './bondingCurve';

export interface DeadTokenMarketSnapshot {
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  volumeH1Usd: number | null;
  volumeM5Usd: number | null;
  recentBuyVolumeUsd: number | null;
  buysH1: number | null;
  sellsH1: number | null;
  txnsH1: number | null;
  holderCount: number | null;
  buySellRatio: number | null;
  priceChangeH1Pct: number | null;
  priceChange24hPct: number | null;
  bondingCurveProgressPct: number | null;
  isMigrated?: boolean;
  curveHealth?: BondingCurveHealth | null;
}

export interface DeadTokenFilterResult {
  skipReasons: string[];
  scorePenalty: number;
  flags: Array<{ id: string; severity: 'high' | 'critical' | 'medium'; label: string; detail?: string }>;
}

/** Prefixes / phrases that monitor must never soft-pass. */
export function isNonBypassableSkipReason(reason: string): boolean {
  const r = reason.toLowerCase();
  return (
    r.includes('near-zero volume') ||
    r.includes('dead liquidity') ||
    r.includes('low liquidity') ||
    r.includes('low 24h volume') ||
    r.includes('dead recent volume') ||
    r.includes('weak recent buy') ||
    r.includes('dead bonding curve') ||
    r.includes('stalled bonding curve') ||
    r.includes('dead/stalled bonding') ||
    r.includes('too few holders') ||
    r.includes('no activity') ||
    r.includes('no recent activity') ||
    r.includes('net volume heavily negative') ||
    r.includes('price crash') ||
    r.includes('low bonding curve + dead')
  );
}

function estimatedBuyVolume(snap: DeadTokenMarketSnapshot): number | null {
  if (snap.recentBuyVolumeUsd != null && Number.isFinite(snap.recentBuyVolumeUsd)) {
    return snap.recentBuyVolumeUsd;
  }
  const vol = snap.volumeH1Usd;
  const buys = snap.buysH1 ?? 0;
  const sells = snap.sellsH1 ?? 0;
  const total = buys + sells;
  if (vol == null || !Number.isFinite(vol)) return null;
  if (total <= 0) return vol > 0 ? vol * 0.5 : 0;
  return vol * (buys / total);
}

/**
 * Evaluate absolute floors. Always applies — independent of enableAntiRug /
 * risk level. Returns skip reasons + risk score penalties.
 */
export function evaluateDeadTokenHardFloors(
  snap: DeadTokenMarketSnapshot
): DeadTokenFilterResult {
  const skipReasons: string[] = [];
  const flags: DeadTokenFilterResult['flags'] = [];
  let scorePenalty = 0;

  const minLiq = effectiveMinLiquidityUsd();
  const minVol24 = effectiveMinVolume24hUsd();
  const minRecentVol = effectiveMinRecentVolumeUsd();
  const minRecentBuy = effectiveMinRecentBuyVolumeUsd();
  const minHolders = effectiveMinHolders();
  const minActivity = effectiveMinRecentActivity();

  const liq = snap.liquidityUsd;
  if (liq == null || liq < minLiq) {
    const shown = liq == null ? 0 : liq;
    scorePenalty += shown <= 0 ? 35 : 25;
    flags.push({
      id: 'hard_low_liquidity',
      severity: shown <= 0 ? 'critical' : 'high',
      label: shown <= 0 ? 'Dead liquidity' : 'Low liquidity',
      detail: `$${shown.toFixed(0)} < min $${minLiq}`,
    });
    skipReasons.push(
      shown <= HARD_FILTER_FLOORS.minLiquidityUsd * 0.1
        ? `Skipped — near-zero volume / dead liquidity (liq $${shown.toFixed(0)} < $${minLiq})`
        : `Skipped - low liquidity ($${shown.toFixed(0)} < min $${minLiq})`
    );
  } else if (liq < 8_000) {
    // Soft penalty inside recommended $5k–$8k band (still above absolute floor)
    scorePenalty += 6;
  }

  const vol24 = snap.volume24hUsd;
  if (vol24 == null || vol24 < minVol24) {
    const shown = vol24 == null ? 0 : vol24;
    scorePenalty += shown <= 0 ? 32 : 22;
    flags.push({
      id: 'hard_low_volume_24h',
      severity: shown <= 0 ? 'critical' : 'high',
      label: 'Low 24h volume',
      detail: `$${shown.toFixed(0)} < $${minVol24}`,
    });
    skipReasons.push(
      shown < 100
        ? `Skipped — near-zero volume / dead liquidity (vol24h $${shown.toFixed(0)} < $${minVol24})`
        : `Skipped - low 24h volume ($${shown.toFixed(0)} < min $${minVol24})`
    );
  }

  const recentVol = snap.volumeH1Usd ?? snap.volumeM5Usd;
  if (recentVol != null && recentVol < minRecentVol) {
    scorePenalty += recentVol <= 0 ? 28 : 18;
    flags.push({
      id: 'hard_dead_recent_volume',
      severity: recentVol <= 0 ? 'critical' : 'high',
      label: 'Dead recent volume',
      detail: `h1/m5 $${recentVol.toFixed(0)} < $${minRecentVol}`,
    });
    skipReasons.push(
      `Skipped — dead recent volume ($${recentVol.toFixed(0)} < min $${minRecentVol})`
    );
  } else if (recentVol == null && (vol24 == null || vol24 < minVol24)) {
    // No recent window data and weak 24h — already skipped above
  }

  const buyVol = estimatedBuyVolume(snap);
  if (buyVol != null && buyVol < minRecentBuy) {
    scorePenalty += buyVol <= 0 ? 24 : 14;
    flags.push({
      id: 'hard_weak_buy_volume',
      severity: 'high',
      label: 'Weak recent buy volume',
      detail: `$${buyVol.toFixed(0)} < $${minRecentBuy}`,
    });
    skipReasons.push(
      `Skipped — weak recent buy volume ($${buyVol.toFixed(0)} < min $${minRecentBuy})`
    );
  }

  // Require buys meaningful vs sells when we have txn counts
  const buys = snap.buysH1;
  const sells = snap.sellsH1;
  if (buys != null && sells != null && buys + sells > 0) {
    const buyShare = buys / (buys + sells);
    if (buyShare < 0.35 && (recentVol ?? 0) < minRecentVol * 2) {
      scorePenalty += 10;
      flags.push({
        id: 'hard_sell_dominated',
        severity: 'medium',
        label: 'Sell-dominated recent flow',
        detail: `buys ${buys} / sells ${sells}`,
      });
    }
  }

  const txns = snap.txnsH1 ?? (buys != null && sells != null ? buys + sells : null);
  const holders = snap.holderCount;
  const activityDead =
    (txns != null && txns < minActivity) ||
    (recentVol != null && recentVol < minRecentVol) ||
    (buyVol != null && buyVol < minRecentBuy);

  if (holders != null && holders < minHolders) {
    scorePenalty += 16;
    flags.push({
      id: 'hard_low_holders',
      severity: 'high',
      label: 'Too few holders',
      detail: `${holders} < ${minHolders}`,
    });
    if (activityDead || holders <= HARD_FILTER_FLOORS.extremeLowHolders) {
      skipReasons.push(
        `Skipped — too few holders / no activity (${holders} < ${minHolders})`
      );
      scorePenalty += 12;
    } else {
      skipReasons.push(
        `Skipped — too few holders / no activity (${holders} < min ${minHolders})`
      );
    }
  } else if (
    holders != null &&
    holders <= HARD_FILTER_FLOORS.extremeLowHolders &&
    activityDead
  ) {
    scorePenalty += 30;
    flags.push({
      id: 'hard_extreme_low_holders_dead',
      severity: 'critical',
      label: 'Extremely low holders + dead activity',
      detail: `holders ${holders}, txns ${txns ?? '?'}`,
    });
    skipReasons.push(
      `Skipped — too few holders / no activity (${holders} holders, dead volume)`
    );
  }

  if (txns != null && txns < minActivity && (recentVol == null || recentVol < minRecentVol)) {
    const already = skipReasons.some((r) => /no activity|dead recent/i.test(r));
    if (!already) {
      scorePenalty += 14;
      flags.push({
        id: 'hard_no_recent_activity',
        severity: 'high',
        label: 'No recent activity',
        detail: `h1 txns ${txns} < ${minActivity}`,
      });
      skipReasons.push(
        `Skipped — too few holders / no activity (h1 txns ${txns} < ${minActivity})`
      );
    }
  }

  // Bonding curve dead / stalled
  const bc = config.bondingCurve;
  const requireHealthy = bc.requireHealthyCurve === true;
  const progress = snap.bondingCurveProgressPct;
  const curveHealth = snap.curveHealth;

  if (requireHealthy && !snap.isMigrated) {
    if (curveHealth?.dead || curveHealth?.stalled) {
      scorePenalty += 28;
      flags.push({
        id: 'hard_dead_curve',
        severity: 'critical',
        label: curveHealth.dead ? 'Dead bonding curve' : 'Stalled bonding curve',
        detail: curveHealth.detail,
      });
      skipReasons.push(
        curveHealth.dead
          ? `Skipped — dead bonding curve (${curveHealth.detail ?? 'low progress + no activity'})`
          : `Skipped — stalled bonding curve (${curveHealth.detail ?? 'no recent activity'})`
      );
    } else if (
      progress != null &&
      progress <= (bc.minCurveProgress > 0
        ? bc.minCurveProgress
        : HARD_FILTER_FLOORS.deadBondingCurveMaxPct) &&
      activityDead
    ) {
      scorePenalty += 26;
      flags.push({
        id: 'hard_low_curve_dead_vol',
        severity: 'critical',
        label: 'Low bonding curve + dead volume',
        detail: `${progress.toFixed(0)}% curve`,
      });
      skipReasons.push(
        `Skipped — low bonding curve + dead volume (${progress.toFixed(0)}% + dead activity)`
      );
    }

    if (bc.minCurveProgress > 0 && progress != null && progress < bc.minCurveProgress) {
      const already = skipReasons.some((r) => /bonding curve/i.test(r));
      if (!already) {
        scorePenalty += 12;
        skipReasons.push(
          `Skipped — dead bonding curve (progress ${progress.toFixed(0)}% < min ${bc.minCurveProgress}%)`
        );
      }
    }

    if (
      bc.maxCurveProgressForEntry > 0 &&
      progress != null &&
      progress > bc.maxCurveProgressForEntry &&
      !snap.isMigrated
    ) {
      // Soft: nearly complete — usually OK for near-mig; only soft score unless requireHealthy
      scorePenalty += 4;
    }
  }

  // Net volume heavily negative + price already crashed
  const ratio =
    snap.buySellRatio ??
    (buys != null && sells != null && sells > 0 ? buys / sells : null);
  const crashH1 = snap.priceChangeH1Pct;
  const crash24 = snap.priceChange24hPct;
  const crashed =
    (crashH1 != null && crashH1 <= HARD_FILTER_FLOORS.priceCrashPct) ||
    (crash24 != null && crash24 <= HARD_FILTER_FLOORS.priceCrashPct);
  const heavilyNegative =
    (ratio != null && ratio < HARD_FILTER_FLOORS.maxNegativeBuySellRatio) ||
    (buys != null && sells != null && sells > 0 && buys / sells < HARD_FILTER_FLOORS.maxNegativeBuySellRatio);

  if (heavilyNegative && crashed) {
    scorePenalty += 30;
    flags.push({
      id: 'hard_net_negative_crash',
      severity: 'critical',
      label: 'Net volume negative + price crash',
      detail: `ratio ${ratio?.toFixed(2) ?? '?'} · Δ1h ${crashH1 ?? '?'}% · Δ24h ${crash24 ?? '?'}%`,
    });
    skipReasons.push(
      `Skipped — net volume heavily negative with price crash` +
        (ratio != null ? ` (buy/sell ${ratio.toFixed(2)})` : '')
    );
  } else if (heavilyNegative) {
    scorePenalty += 12;
    flags.push({
      id: 'hard_net_negative',
      severity: 'medium',
      label: 'Net sell pressure',
      detail: ratio != null ? `buy/sell ${ratio.toFixed(2)}` : undefined,
    });
  }

  // Prefer near-migration healthy curves — score bonus handled by caller via curveHealth.preferBoost
  if (curveHealth?.preferBoost) {
    scorePenalty = Math.max(0, scorePenalty - 8);
  }

  return { skipReasons, scorePenalty, flags };
}
