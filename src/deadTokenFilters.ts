/**
 * Non-bypassable dead-token gates: volume, liquidity, holders/activity,
 * bonding-curve health, and net-negative + price-crash.
 * Used by antiRug before every buy (paper + live). High risk cannot skip these.
 *
 * Early pump / migration entries use an alternate path: recent window volume +
 * a lower liquidity/holder floor instead of the full $10k 24h volume gate
 * (which brand-new launches often cannot meet). Truly dead tokens still fail.
 */

import {
  HARD_FILTER_FLOORS,
  config,
  effectiveMinHolders,
  effectiveMinLiquidityUsd,
  effectiveMinMarketCapUsd,
  effectiveMinRecentActivity,
  effectiveMinTop10HolderPct,
  effectiveMaxInsiderPct,
} from './config';
import type { BondingCurveHealth } from './bondingCurve';
import {
  effectiveMaxDrawdownFromRecentHighPct,
  effectiveMaxEntryAgeMinutes,
  effectiveRejectDumpingToken,
  effectiveStrictMinRecentBuyVolumeUsd,
  effectiveStrictMinRecentVolumeUsd,
  effectiveStrictMinVolume24hUsd,
} from './strictMode';

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
  /** Circulating / FDV market cap USD when known */
  marketCapUsd?: number | null;
  isMigrated?: boolean;
  curveHealth?: BondingCurveHealth | null;
}

export interface DeadTokenFloorContext {
  /** Graduated / migration entry */
  isMigrated?: boolean;
  /** Early pump, near-migration, or bonding-curve smart-money signal */
  earlyEntry?: boolean;
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
    r.includes('low bonding curve + dead') ||
    r.includes('top 10 holders too low') ||
    r.includes('top10 holders too low') ||
    r.includes('top 10 holders unknown') ||
    r.includes('top10 holders unknown') ||
    r.includes('insider % too high') ||
    r.includes('market cap too low') ||
    r.includes('market cap unknown') ||
    r.includes('low mc with near-zero volume') ||
    r.includes('not a pump.fun mint') ||
    r.includes('dumping from recent high') ||
    r.includes('signal too old') ||
    r.includes('entry age') ||
    r.includes('momentum confirmation failed') ||
    r.includes('wallet quality') ||
    r.includes('cluster need')
  );
}

/** Pump.fun convention: mint address ends with case-sensitive `pump`. */
export function isPumpFunMintSuffix(mint: string): boolean {
  return typeof mint === 'string' && mint.endsWith('pump');
}

export function pumpFunMintSkipReason(mint: string): string {
  const short = mint && mint.length > 8 ? `${mint.slice(0, 8)}…` : mint || '?';
  return `Skipped — not a pump.fun mint (${short})`;
}

/**
 * Hard floor when filters.buyPumpFunOnly is ON — rejects non-`pump` suffix mints.
 * Non-bypassable by soft-pass / early path / Degen. Returns skip reason or null.
 */
export function evaluateBuyPumpFunOnlyGate(mint: string): string | null {
  if (config.filters.buyPumpFunOnly !== true) return null;
  if (isPumpFunMintSuffix(mint)) return null;
  return pumpFunMintSkipReason(mint);
}

function formatMcShort(usd: number): string {
  if (usd >= 1_000_000) {
    const m = usd / 1_000_000;
    return `$${m >= 10 ? m.toFixed(0) : m.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (usd >= 1_000) {
    const k = usd / 1_000;
    return `$${k >= 10 ? k.toFixed(0) : k.toFixed(1).replace(/\.0$/, '')}K`;
  }
  return `$${Math.round(usd)}`;
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
 *
 * When `earlyEntry` / `isMigrated`, 24h volume may be satisfied by meaningful
 * recent (h1/m5) activity + liquidity instead of the full $10k 24h floor.
 */
export function evaluateDeadTokenHardFloors(
  snap: DeadTokenMarketSnapshot,
  ctx: DeadTokenFloorContext = {}
): DeadTokenFilterResult {
  const skipReasons: string[] = [];
  const flags: DeadTokenFilterResult['flags'] = [];
  let scorePenalty = 0;

  const isMigrated = Boolean(ctx.isMigrated || snap.isMigrated);
  const earlyPath = Boolean(ctx.earlyEntry || isMigrated);

  const minLiqFull = effectiveMinLiquidityUsd();
  const minVol24 = effectiveStrictMinVolume24hUsd();
  const minRecentVolFull = effectiveStrictMinRecentVolumeUsd();
  const minRecentBuyFull = effectiveStrictMinRecentBuyVolumeUsd();
  const minHoldersFull = effectiveMinHolders();
  const minActivity = effectiveMinRecentActivity();

  // Early pre-migration: lower liq floor (curve pools). Migrated keeps full $5k+.
  const minLiq =
    earlyPath && !isMigrated
      ? Math.min(minLiqFull, HARD_FILTER_FLOORS.earlyMinLiquidityUsd)
      : minLiqFull;
  const minHolders = earlyPath
    ? Math.min(minHoldersFull, HARD_FILTER_FLOORS.earlyMinHolders)
    : minHoldersFull;
  // Fresh pump/migration: Dex h1 often lags — use softer recent floors; only
  // near-zero remains a hard reject on the early path.
  const minRecentVol = earlyPath
    ? Math.min(minRecentVolFull, HARD_FILTER_FLOORS.earlyMinRecentVolumeUsd)
    : minRecentVolFull;
  const minRecentBuy = earlyPath
    ? Math.min(minRecentBuyFull, HARD_FILTER_FLOORS.earlyMinRecentBuyVolumeUsd)
    : minRecentBuyFull;

  const recentVol = snap.volumeH1Usd ?? snap.volumeM5Usd;
  const buyVol = estimatedBuyVolume(snap);
  const buys = snap.buysH1;
  const sells = snap.sellsH1;
  const txns = snap.txnsH1 ?? (buys != null && sells != null ? buys + sells : null);
  const nearZeroVolThreshold = HARD_FILTER_FLOORS.nearZeroRecentVolumeUsd;
  const recentNearZero =
    recentVol != null && Number.isFinite(recentVol) && recentVol < nearZeroVolThreshold;

  // --- Non-bypassable entry market-cap floors (all risk levels, no early soft-pass) ---
  // Fail closed when MC is unknown — never allow a sub-$5k entry via missing Dex MC.
  const minMc = effectiveMinMarketCapUsd();
  const mc = snap.marketCapUsd;
  if (mc != null && Number.isFinite(mc) && mc > 0) {
    if (mc < minMc) {
      scorePenalty += 35;
      flags.push({
        id: 'hard_low_market_cap',
        severity: 'critical',
        label: 'Market cap too low',
        detail: `MC $${Math.round(mc)} < min $${minMc}`,
      });
      skipReasons.push(
        `Skipped — market cap too low (${formatMcShort(mc)} < ${formatMcShort(minMc)}; MC $${Math.round(mc)})`
      );
    } else if (
      mc < HARD_FILTER_FLOORS.lowMcNearZeroVolumeComboUsd &&
      recentNearZero
    ) {
      scorePenalty += 32;
      flags.push({
        id: 'hard_low_mc_near_zero_vol',
        severity: 'critical',
        label: 'Low MC with near-zero volume',
        detail: `MC $${Math.round(mc)} · h1/m5 $${(recentVol ?? 0).toFixed(0)}`,
      });
      skipReasons.push(
        `Skipped — low MC with near-zero volume (MC $${Math.round(mc)}, vol $${(recentVol ?? 0).toFixed(0)})`
      );
    }
  } else {
    scorePenalty += 35;
    flags.push({
      id: 'hard_unknown_market_cap',
      severity: 'critical',
      label: 'Market cap unknown',
      detail: `need ≥ $${minMc}`,
    });
    skipReasons.push(
      `Skipped — market cap unknown (min ${formatMcShort(minMc)})`
    );
  }

  // Post-dump / low-MC tokens never get early soft-pass on thin recent volume.
  const blockEarlySoftVol =
    mc != null &&
    Number.isFinite(mc) &&
    mc > 0 &&
    mc < HARD_FILTER_FLOORS.lowMcNearZeroVolumeComboUsd;

  const recentHealthy =
    (recentVol != null && recentVol >= minRecentVol) ||
    (buyVol != null && buyVol >= minRecentBuy && (txns == null || txns >= minActivity)) ||
    (earlyPath &&
      !blockEarlySoftVol &&
      !recentNearZero &&
      txns != null &&
      txns >= minActivity &&
      (recentVol == null || recentVol > 0));
  const activityDead =
    (txns != null && txns < minActivity) ||
    (recentVol != null && recentVol < minRecentVol) ||
    (buyVol != null && buyVol < minRecentBuy);

  const liq = snap.liquidityUsd;
  if (liq == null) {
    // Unknown liquidity ≠ dead pool. Dex/Birdeye often lag on fresh mints.
    // Soft penalty only — never hard-kill on missing data.
    scorePenalty += earlyPath ? 6 : 12;
    flags.push({
      id: 'unknown_liquidity',
      severity: earlyPath ? 'medium' : 'high',
      label: 'Liquidity unknown',
      detail: 'metrics not indexed yet',
    });
  } else if (liq < minLiq) {
    const shown = liq;
    // Early path: thin liq is a soft penalty when recent flow is healthy
    // (Dex often lags on brand-new pump mints). Still reject near-zero dead pools.
    const nearZero =
      shown <= HARD_FILTER_FLOORS.earlyMinLiquidityUsd * 0.2;
    if (earlyPath && recentHealthy && !nearZero) {
      scorePenalty += 10;
      flags.push({
        id: 'early_thin_liquidity',
        severity: 'medium',
        label: 'Thin liquidity (early)',
        detail: `$${shown.toFixed(0)} < min $${minLiq}`,
      });
    } else {
      scorePenalty += shown <= 0 ? 35 : 25;
      flags.push({
        id: 'hard_low_liquidity',
        severity: shown <= 0 ? 'critical' : 'high',
        label: shown <= 0 ? 'Dead liquidity' : 'Low liquidity',
        detail: `$${shown.toFixed(0)} < min $${minLiq}`,
      });
      skipReasons.push(
        shown <= HARD_FILTER_FLOORS.minLiquidityUsd * 0.1 || nearZero
          ? `Skipped — near-zero volume / dead liquidity (liq $${shown.toFixed(0)} < $${minLiq})`
          : `Skipped - low liquidity ($${shown.toFixed(0)} < min $${minLiq})`
      );
    }
  } else if (liq < 8_000) {
    scorePenalty += 6;
  }

  const vol24 = snap.volume24hUsd;
  const vol24Ok = vol24 != null && vol24 >= minVol24;
  const vol24EarlyOk =
    earlyPath &&
    ((vol24 != null && vol24 >= HARD_FILTER_FLOORS.earlyMinVolume24hUsd) ||
      recentHealthy);

  if (vol24 == null && !vol24EarlyOk) {
    // Unknown 24h volume — soft only (indexing lag). Do not paint as $0 dead.
    scorePenalty += earlyPath ? 8 : 14;
    flags.push({
      id: 'unknown_volume_24h',
      severity: 'medium',
      label: '24h volume unknown',
      detail: `need ≥ $${minVol24}`,
    });
  } else if (!vol24Ok && !vol24EarlyOk) {
    const shown = vol24 as number;
    const nearZeroVol = shown < 100 && !recentHealthy;
    // Early/migration with non-dead pool: soft-penalty missing 24h (indexing lag)
    // instead of hard-blocking the buy. Near-zero + no recent flow still hard-fails.
    if (
      earlyPath &&
      !nearZeroVol &&
      liq != null &&
      liq >= Math.min(minLiq, HARD_FILTER_FLOORS.earlyMinLiquidityUsd) * 0.5
    ) {
      scorePenalty += 12;
      flags.push({
        id: 'early_low_volume_24h',
        severity: 'medium',
        label: 'Low 24h volume (early)',
        detail: `$${shown.toFixed(0)} < $${minVol24}`,
      });
    } else {
      scorePenalty += shown <= 0 ? 32 : 22;
      flags.push({
        id: 'hard_low_volume_24h',
        severity: shown <= 0 ? 'critical' : 'high',
        label: 'Low 24h volume',
        detail: `$${shown.toFixed(0)} < $${minVol24}`,
      });
      skipReasons.push(
        nearZeroVol
          ? `Skipped — near-zero volume / dead liquidity (vol24h $${shown.toFixed(0)} < $${minVol24})`
          : `Skipped - low 24h volume ($${shown.toFixed(0)} < min $${minVol24})`
      );
    }
  } else if (earlyPath && !vol24Ok && recentHealthy) {
    // Alternate path used — soft penalty only
    scorePenalty += 4;
    flags.push({
      id: 'early_volume_via_recent',
      severity: 'medium',
      label: '24h vol via recent activity',
      detail: `h1/m5 $${(recentVol ?? 0).toFixed(0)} (24h $${(vol24 ?? 0).toFixed(0)})`,
    });
  }

  if (recentVol != null && recentVol < minRecentVol) {
    const nearZeroRecent = recentVol < nearZeroVolThreshold;
    // Early/migration: soft-penalty thin but non-zero recent vol (Dex lag).
    // Mature entries, true near-zero, and low-MC post-dump ghosts hard-fail.
    if (earlyPath && !nearZeroRecent && !blockEarlySoftVol) {
      scorePenalty += 10;
      flags.push({
        id: 'early_thin_recent_volume',
        severity: 'medium',
        label: 'Thin recent volume (early)',
        detail: `h1/m5 $${recentVol.toFixed(0)} < $${minRecentVolFull}`,
      });
    } else {
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
    }
  } else if (
    recentVol == null &&
    !vol24Ok &&
    !vol24EarlyOk &&
    (vol24 == null || vol24 < (earlyPath ? HARD_FILTER_FLOORS.earlyMinVolume24hUsd : minVol24))
  ) {
    // No recent window and weak 24h — already skipped above when applicable
  }

  if (buyVol != null && buyVol < minRecentBuy) {
    const nearZeroBuy = buyVol < 15;
    // Early path with any recent flow / non-zero buy: soft-penalty only
    // (blocked for known low-MC post-dump tokens)
    if (
      earlyPath &&
      !blockEarlySoftVol &&
      (!nearZeroBuy || (recentVol != null && recentVol >= minRecentVol))
    ) {
      scorePenalty += 6;
      flags.push({
        id: 'early_weak_buy_volume',
        severity: 'medium',
        label: 'Weak recent buy volume (early)',
        detail: `$${buyVol.toFixed(0)} < $${minRecentBuyFull}`,
      });
    } else {
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
  }

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

  const holders = snap.holderCount;

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
    } else if (!earlyPath || !recentHealthy) {
      skipReasons.push(
        `Skipped — too few holders / no activity (${holders} < min ${minHolders})`
      );
    }
    // Early + healthy recent + above extreme-low: soft flag only (already scored)
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

  if (requireHealthy && !isMigrated) {
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
      !isMigrated
    ) {
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

  // Dumping from recent high (short-term drawdown proxy) — non-bypassable when enabled
  if (effectiveRejectDumpingToken()) {
    const maxDd = effectiveMaxDrawdownFromRecentHighPct();
    const dumpMove =
      (crashH1 != null && crashH1 <= -maxDd) ||
      (crash24 != null &&
        crash24 <= -maxDd &&
        (ratio == null || ratio < 1));
    if (dumpMove) {
      scorePenalty += 32;
      flags.push({
        id: 'hard_dumping_token',
        severity: 'critical',
        label: 'Dumping from recent high',
        detail: `Δ1h ${crashH1 ?? '?'}% · Δ24h ${crash24 ?? '?'}% · max ${maxDd}%`,
      });
      skipReasons.push(
        `Skipped — dumping from recent high` +
          (crashH1 != null
            ? ` (Δ1h ${crashH1.toFixed(0)}% ≤ -${maxDd}%)`
            : crash24 != null
              ? ` (Δ24h ${crash24.toFixed(0)}% ≤ -${maxDd}%)`
              : '')
      );
    }
  }

  if (curveHealth?.preferBoost) {
    scorePenalty = Math.max(0, scorePenalty - 8);
  }

  return { skipReasons, scorePenalty, flags };
}

/**
 * Entry timing gate: reject if smart-wallet signal is older than maxEntryAgeMinutes.
 * Non-bypassable when enableEntryTimingGate is on.
 */
export function evaluateEntryTimingGate(signalAgeMinutes: number | null | undefined): string | null {
  if (config.filters.enableEntryTimingGate === false) return null;
  const maxAge = effectiveMaxEntryAgeMinutes();
  if (signalAgeMinutes == null || !Number.isFinite(signalAgeMinutes)) return null;
  if (signalAgeMinutes > maxAge) {
    return `Skipped — signal too old / entry age ${signalAgeMinutes.toFixed(1)}m > max ${maxAge}m`;
  }
  return null;
}

export interface HolderConcentrationSnapshot {
  top10HoldPct: number | null;
  insiderPct: number | null;
  /** Extreme dev hold treated as insider-cluster when ≥ hard max */
  devHoldPct?: number | null;
}

/**
 * Non-bypassable holder-dispersion / insider ceilings.
 * - Reject when top10 is present and below min (default 8%, hard ≥5%).
 * - Fail closed when top10 is unknown after metrics fetch (mirror MC unknown gate).
 * - Reject when insider (or extreme ≥50% dev) hold is present and ≥ hard max (50%).
 */
export function evaluateHolderConcentrationHardFloors(
  snap: HolderConcentrationSnapshot
): DeadTokenFilterResult {
  const skipReasons: string[] = [];
  const flags: DeadTokenFilterResult['flags'] = [];
  let scorePenalty = 0;

  const minTop10 = effectiveMinTop10HolderPct();
  const maxInsider = effectiveMaxInsiderPct();

  if (snap.top10HoldPct != null && Number.isFinite(snap.top10HoldPct)) {
    if (snap.top10HoldPct < minTop10) {
      scorePenalty += 35;
      flags.push({
        id: 'hard_top10_too_low',
        severity: 'critical',
        label: 'Top-10 holders too low',
        detail: `${snap.top10HoldPct.toFixed(1)}% < ${minTop10}%`,
      });
      skipReasons.push(
        `Skipped — top 10 holders too low (${snap.top10HoldPct.toFixed(1)}% < ${minTop10}%)`
      );
    }
  } else {
    // Fail closed — never allow dispersed honeypots via missing top-10 data.
    scorePenalty += 35;
    flags.push({
      id: 'hard_unknown_top10',
      severity: 'critical',
      label: 'Top-10 holders unknown',
      detail: `need ≥ ${minTop10}%`,
    });
    skipReasons.push(
      `Skipped — top 10 holders unknown (min ${minTop10}%)`
    );
  }

  if (snap.insiderPct != null && Number.isFinite(snap.insiderPct)) {
    if (snap.insiderPct >= maxInsider) {
      scorePenalty += 35;
      flags.push({
        id: 'hard_insider_too_high',
        severity: 'critical',
        label: 'Insider % too high',
        detail: `${snap.insiderPct.toFixed(0)}% ≥ ${maxInsider}%`,
      });
      skipReasons.push(
        `Skipped — insider % too high (${snap.insiderPct.toFixed(0)}% ≥ ${maxInsider}%)`
      );
    }
  }

  // Extreme deployer hold (≥ hard insider cap) — same non-bypassable class
  if (
    snap.devHoldPct != null &&
    Number.isFinite(snap.devHoldPct) &&
    snap.devHoldPct >= maxInsider
  ) {
    const already = skipReasons.some((r) => r.toLowerCase().includes('insider % too high'));
    if (!already) {
      scorePenalty += 35;
      flags.push({
        id: 'hard_dev_insider_cluster',
        severity: 'critical',
        label: 'Dev/insider cluster too high',
        detail: `dev ${snap.devHoldPct.toFixed(0)}% ≥ ${maxInsider}%`,
      });
      skipReasons.push(
        `Skipped — insider % too high (dev ${snap.devHoldPct.toFixed(0)}% ≥ ${maxInsider}%)`
      );
    }
  }

  return { skipReasons, scorePenalty, flags };
}
