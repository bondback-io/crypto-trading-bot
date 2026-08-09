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
  effectiveMaxTop10HolderPct,
  effectiveMaxInsiderPct,
  hardFilterFloorsActive,
} from './config';
import type { BondingCurveHealth } from './bondingCurve';
import {
  effectiveMaxDrawdownFromRecentHighPct,
  effectiveMaxEntryAgeMinutes,
  effectiveMaxEntryMarketCapUsd,
  effectiveRejectDumpingToken,
  effectiveStrictMinRecentBuyVolumeUsd,
  effectiveStrictMinRecentVolumeUsd,
  effectiveStrictMinVolume24hUsd,
} from './filterEffective';
import { isStrategyEnabled } from './strategies';

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
  /** Jupiter organicScore 0–100 when known */
  organicScore?: number | null;
  /** Launch / first-pool time (ms) when known — for fake-holder velocity */
  pairCreatedAtMs?: number | null;
}

export interface DeadTokenFloorContext {
  /** Graduated / migration entry */
  isMigrated?: boolean;
  /** Early pump, near-migration, or bonding-curve smart-money signal */
  earlyEntry?: boolean;
  /**
   * Migration Sniper pre-grad fire band — skip maxCurveProgressForEntry soft reject.
   * Also auto-applied when progress is in 95–100% pre-grad.
   */
  allowMigrationSniperCurve?: boolean;
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
    r.includes('top 10 holders too high') ||
    r.includes('top10 holders too high') ||
    r.includes('top 10 holders unknown') ||
    r.includes('high holder concentration') ||
    r.includes('holder correlation') ||
    r.includes('single holder') ||
    r.includes('insider % too high') ||
    r.includes('insider % unknown') ||
    r.includes('pro trader') ||
    r.includes('buy-heavy') ||
    r.includes('buy/sell txn ratio') ||
    r.includes('organic score too low') ||
    r.includes('organic / pro-quality') ||
    r.includes('market cap too low') ||
    r.includes('low mc with near-zero volume') ||
    r.includes('not a pump.fun mint') ||
    r.includes('fake holders') ||
    r.includes('holder velocity') ||
    r.includes('dumping from recent high') ||
    r.includes('signal too old') ||
    r.includes('entry age') ||
    r.includes('momentum confirmation failed') ||
    r.includes('wallet quality') ||
    r.includes('entry quality') ||
    r.includes('quality score too low') ||
    r.includes('cluster need')
  );
}

/** Pump.fun convention: mint address ends with `pump` (case-insensitive). */
export function isPumpFunMintSuffix(mint: string): boolean {
  return typeof mint === 'string' && mint.toLowerCase().endsWith('pump');
}

export function pumpFunMintSkipReason(mint: string): string {
  const short = mint && mint.length > 8 ? `${mint.slice(0, 8)}…` : mint || '?';
  return `Skipped — not a pump.fun mint (${short})`;
}

/** Mature specialty feeds intentionally include non-pump Jupiter/KOL/majors/medium names. */
export function isMatureSpecialtyPumpFunBypass(opts?: {
  specialtyFeed?: string | null;
  preferredProfileId?: string | null;
  candidateTradeProfileId?: string | null;
}): boolean {
  const feed = String(opts?.specialtyFeed || '').toLowerCase();
  if (
    feed !== 'jupiter' &&
    feed !== 'kolscan' &&
    feed !== 'majors' &&
    feed !== 'medium'
  ) {
    return false;
  }
  const pid = String(
    opts?.candidateTradeProfileId || opts?.preferredProfileId || ''
  );
  return pid === 'trend_rider' || pid === 'steady_compounder';
}

/**
 * Hard floor when filters.buyPumpFunOnly is ON — rejects non-`pump` suffix mints.
 * Non-bypassable by soft-pass / early path / Degen, except Trend Rider /
 * Steady Compounder Jupiter|KOL|majors|medium specialty handoffs.
 * Returns skip reason or null.
 */
export function evaluateBuyPumpFunOnlyGate(
  mint: string,
  opts?: {
    specialtyFeed?: string | null;
    preferredProfileId?: string | null;
    candidateTradeProfileId?: string | null;
  }
): string | null {
  if (config.filters.buyPumpFunOnly !== true) return null;
  if (isPumpFunMintSuffix(mint)) return null;
  if (isMatureSpecialtyPumpFunBypass(opts)) return null;
  return pumpFunMintSkipReason(mint);
}

/**
 * Fake-holder velocity hard floors (always on — Zion + all profiles / master bot).
 * Blocks inflated holder counts too soon after launch/migration:
 *   ≥2,000 within 15m · ≥5,000 within 30m · ≥10,000 within 1h
 * Unknown age or holders → fail-open (cannot evaluate).
 */
export const FAKE_HOLDER_VELOCITY_FLOORS = [
  { maxAgeMs: 15 * 60_000, maxHolders: 2_000, label: '15m' },
  { maxAgeMs: 30 * 60_000, maxHolders: 5_000, label: '30m' },
  { maxAgeMs: 60 * 60_000, maxHolders: 10_000, label: '1h' },
] as const;

export function evaluateFakeHolderVelocityGate(input: {
  holderCount?: number | null;
  launchedAtMs?: number | null;
  nowMs?: number;
}): string | null {
  const holders = Number(input.holderCount);
  const launchedAt = Number(input.launchedAtMs);
  if (!Number.isFinite(holders) || holders <= 0) return null;
  if (!Number.isFinite(launchedAt) || launchedAt <= 0) return null;
  const now = Number(input.nowMs) > 0 ? Number(input.nowMs) : Date.now();
  const ageMs = Math.max(0, now - launchedAt);
  for (const floor of FAKE_HOLDER_VELOCITY_FLOORS) {
    if (ageMs <= floor.maxAgeMs && holders >= floor.maxHolders) {
      const ageMin = Math.max(1, Math.round(ageMs / 60_000));
      return (
        `Skipped — fake holders suspected (${Math.round(holders).toLocaleString()} holders ` +
        `in ${ageMin}m · block ≥${floor.maxHolders.toLocaleString()} within ${floor.label})`
      );
    }
  }
  return null;
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
  // Fake-holder velocity always applies (Risk On/Off) — inflated holders near launch.
  const fakeHolders = evaluateFakeHolderVelocityGate({
    holderCount: snap.holderCount,
    launchedAtMs: snap.pairCreatedAtMs ?? null,
  });
  if (fakeHolders) {
    return {
      skipReasons: [fakeHolders],
      scorePenalty: 45,
      flags: [
        {
          id: 'hard_fake_holder_velocity',
          severity: 'critical',
          label: 'Fake holders suspected',
          detail: fakeHolders,
        },
      ],
    };
  }

  // Risk OFF: no liq/volume/MC/holder hard floors — entry engines decide.
  if (config.riskLevel === 'off') {
    return { skipReasons: [], scorePenalty: 0, flags: [] };
  }

  const skipReasons: string[] = [];
  const flags: DeadTokenFilterResult['flags'] = [];
  let scorePenalty = 0;

  const isMigrated = Boolean(ctx.isMigrated || snap.isMigrated);
  const earlyPath = Boolean(ctx.earlyEntry || isMigrated);

  const volumeFiltersOn = isStrategyEnabled('volume_liquidity_filters');
  const holderActivityOn = isStrategyEnabled('min_holders_activity');
  const minLiqFull = volumeFiltersOn
    ? effectiveMinLiquidityUsd()
    : HARD_FILTER_FLOORS.minLiquidityUsd;
  const minVol24 = volumeFiltersOn
    ? effectiveStrictMinVolume24hUsd()
    : HARD_FILTER_FLOORS.minVolume24hUsd;
  const minRecentVolFull = volumeFiltersOn
    ? effectiveStrictMinRecentVolumeUsd()
    : HARD_FILTER_FLOORS.minRecentVolumeUsd;
  const minRecentBuyFull = volumeFiltersOn
    ? effectiveStrictMinRecentBuyVolumeUsd()
    : HARD_FILTER_FLOORS.minRecentBuyVolumeUsd;
  const minHoldersFull = holderActivityOn
    ? effectiveMinHolders()
    : HARD_FILTER_FLOORS.minHolders;
  const minActivity = holderActivityOn
    ? effectiveMinRecentActivity()
    : HARD_FILTER_FLOORS.minRecentActivityTxns;

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

  // --- Non-bypassable entry market-cap floors (known values only) ---
  // Unknown MC soft-passes (Dex 429 / RPC gaps); known below min still hard-rejects.
  const minMc = effectiveMinMarketCapUsd();
  const maxMc = effectiveMaxEntryMarketCapUsd();
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
    } else if (maxMc > 0 && mc > maxMc) {
      scorePenalty += 35;
      flags.push({
        id: 'hard_high_market_cap',
        severity: 'critical',
        label: 'Market cap too high',
        detail: `MC $${Math.round(mc)} > max $${maxMc}`,
      });
      skipReasons.push(
        `Skipped — market cap too high (${formatMcShort(mc)} > ${formatMcShort(maxMc)}; already-pumped / dump risk)`
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
    scorePenalty += 12;
    flags.push({
      id: 'soft_unknown_market_cap',
      severity: 'medium',
      label: 'Market cap unknown',
      detail: `need ≥ $${minMc} when data available`,
    });
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

  // Bonding curve dead / stalled — pre-grad only.
  // Migrated / PumpSwap tokens often report progress 0% (no active curve); that
  // is not a dead early-curve signal. Also skip when curve data is unknown.
  const bc = config.bondingCurve;
  const requireHealthy =
    isStrategyEnabled('bonding_curve_health') &&
    bc.requireHealthyCurve === true;
  const progress = snap.bondingCurveProgressPct;
  const curveHealth = snap.curveHealth;
  const curveUnknown =
    !curveHealth ||
    curveHealth.status === 'unknown' ||
    /no curve data/i.test(curveHealth.detail || '');
  const looksPostGrad =
    isMigrated ||
    (progress != null &&
      progress <= 0 &&
      ((snap.liquidityUsd != null &&
        snap.liquidityUsd >= HARD_FILTER_FLOORS.earlyMinLiquidityUsd) ||
        curveUnknown));

  if (requireHealthy && !looksPostGrad) {
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
      progress > 0 &&
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

    // Only enforce min progress when we have a real early-curve reading (>0).
    // progress 0 on graduated / missing-curve tokens is meaningless.
    if (
      bc.minCurveProgress > 0 &&
      progress != null &&
      progress > 0 &&
      progress < bc.minCurveProgress
    ) {
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
      // Migration Sniper owns 95–98% (and near-complete) pre-grad — do not soft-penalize
      const sniperBand =
        ctx.allowMigrationSniperCurve === true ||
        (progress >= 95 && progress <= 100);
      if (!sniperBand) {
        scorePenalty += 4;
      }
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

  // Buy-heavy txn asymmetry (honeypot / wash-buy charts) — non-bypassable when sample enough
  if (
    buys != null &&
    sells != null &&
    Number.isFinite(buys) &&
    Number.isFinite(sells) &&
    sells >= HARD_FILTER_FLOORS.minSellsForBuyHeavyGate
  ) {
    const buyHeavyRatio = buys / Math.max(sells, 1);
    if (buyHeavyRatio >= HARD_FILTER_FLOORS.maxBuySellTxnRatio) {
      scorePenalty += 35;
      flags.push({
        id: 'hard_buy_heavy_txns',
        severity: 'critical',
        label: 'Buy-heavy txn ratio',
        detail: `${buys} buys / ${sells} sells = ${buyHeavyRatio.toFixed(1)}×`,
      });
      skipReasons.push(
        `Skipped — buy-heavy txn ratio (${buys} buys / ${sells} sells = ${buyHeavyRatio.toFixed(1)}× ≥ ${HARD_FILTER_FLOORS.maxBuySellTxnRatio}×)`
      );
    }
  }

  // Jupiter organic / pro-quality proxy — known-only (unknown fail-open for early Pump).
  // Treat score 0 as unavailable/blank (Jupiter often returns 0 when unknown);
  // hard-reject only trustworthy positive-but-low organic scores.
  const org = snap.organicScore;
  const minOrg = HARD_FILTER_FLOORS.minOrganicScore;
  if (
    minOrg > 0 &&
    org != null &&
    Number.isFinite(org) &&
    org > 0 &&
    org < minOrg
  ) {
    scorePenalty += 28;
    flags.push({
      id: 'hard_low_organic_score',
      severity: 'critical',
      label: 'Organic / pro-quality score too low',
      detail: `organicScore ${Math.round(org)} < ${minOrg}`,
    });
    skipReasons.push(
      `Skipped — organic score too low (${Math.round(org)} < ${minOrg}; organic / pro-quality proxy)`
    );
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
  const maxAge = isStrategyEnabled('time_based_entry')
    ? effectiveMaxEntryAgeMinutes()
    : 0;
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
  /**
   * Quality profiles (Steady Compounder / High Win-Rate): unknown top10 or
   * insider after fetch attempts hard-skip instead of soft-pass.
   */
  failClosedUnknown?: boolean;
  /** Known GMGN pro-trader / bluechip hold % (quality profiles). */
  proTraderPct?: number | null;
  /** Min pro-trader % when known (quality). 0 = ignore. */
  minProTraderPct?: number;
}

/**
 * Non-bypassable holder-dispersion / insider ceilings.
 * - Reject when top10 is **known** and below min (default 8%, hard ≥5%) or above max.
 * - Unknown top10 (after Jupiter + on-chain attempts): soft penalty only — lean Risk On must still enter.
 * - Unknown insider (after GMGN attempt): soft penalty only; known ≥ hard max still rejects.
 * - Risk OFF soak zeros min+max → gate inactive. If user sets min/max > 0, enforce known bounds.
 * - Reject when insider (or extreme ≥50% dev) hold is present and ≥ hard max (50%).
 */
export function evaluateHolderConcentrationHardFloors(
  snap: HolderConcentrationSnapshot
): DeadTokenFilterResult {
  const skipReasons: string[] = [];
  const flags: DeadTokenFilterResult['flags'] = [];
  let scorePenalty = 0;

  const minTop10 = effectiveMinTop10HolderPct();
  const maxTop10 = effectiveMaxTop10HolderPct();
  const top10GateActive = minTop10 > 0 || maxTop10 > 0;
  const maxInsider = effectiveMaxInsiderPct();
  // Insider hard cap is disabled under Risk OFF (effectiveMaxInsiderPct → 100).
  const insiderGateActive = maxInsider < 100;
  const failClosed = snap.failClosedUnknown === true;
  const minPro =
    snap.minProTraderPct != null && Number.isFinite(snap.minProTraderPct)
      ? Number(snap.minProTraderPct)
      : 0;

  if (!top10GateActive && !insiderGateActive && minPro <= 0) {
    return { skipReasons: [], scorePenalty: 0, flags: [] };
  }

  if (top10GateActive) {
    if (snap.top10HoldPct != null && Number.isFinite(snap.top10HoldPct)) {
      if (minTop10 > 0 && snap.top10HoldPct < minTop10) {
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
      if (maxTop10 > 0 && snap.top10HoldPct > maxTop10) {
        scorePenalty += 35;
        flags.push({
          id: 'hard_top10_too_high',
          severity: 'critical',
          label: 'Top-10 holders too high',
          detail: `${snap.top10HoldPct.toFixed(1)}% > ${maxTop10}%`,
        });
        skipReasons.push(
          `Skipped — top 10 holders too high (${snap.top10HoldPct.toFixed(1)}% > ${maxTop10}%)`
        );
      }
    } else if (failClosed) {
      scorePenalty += 35;
      flags.push({
        id: 'hard_unknown_top10',
        severity: 'critical',
        label: 'Top-10 holders unknown',
        detail: 'quality profile requires known top-10 %',
      });
      skipReasons.push(
        'Skipped — top 10 holders unknown (quality profile requires known concentration)'
      );
    } else {
      // Soft-pass unknown after Jupiter + on-chain (known band still hard above)
      scorePenalty += hardFilterFloorsActive() ? 18 : 12;
      const band =
        minTop10 > 0 && maxTop10 > 0
          ? `${minTop10}–${maxTop10}%`
          : minTop10 > 0
            ? `≥ ${minTop10}%`
            : `≤ ${maxTop10}%`;
      flags.push({
        id: 'soft_unknown_top10',
        severity: 'medium',
        label: 'Top-10 holders unknown',
        detail: `need ${band} when data available`,
      });
    }
  }

  if (insiderGateActive && snap.insiderPct != null && Number.isFinite(snap.insiderPct)) {
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
  } else if (insiderGateActive && failClosed) {
    scorePenalty += 35;
    flags.push({
      id: 'hard_unknown_insider',
      severity: 'critical',
      label: 'Insider % unknown',
      detail: 'quality profile requires known insider %',
    });
    skipReasons.push(
      'Skipped — insider % unknown (quality profile requires known insider data)'
    );
  } else if (insiderGateActive) {
    // Soft-pass unknown after GMGN attempt — known ≥ hard max still rejects above
    scorePenalty += hardFilterFloorsActive() ? 18 : 12;
    flags.push({
      id: 'soft_unknown_insider',
      severity: 'medium',
      label: 'Insider % unknown',
      detail: `need < ${maxInsider}% when data available`,
    });
  }

  if (
    minPro > 0 &&
    snap.proTraderPct != null &&
    Number.isFinite(snap.proTraderPct) &&
    snap.proTraderPct < minPro
  ) {
    scorePenalty += 28;
    flags.push({
      id: 'hard_pro_trader_too_low',
      severity: 'critical',
      label: 'Pro trader % too low',
      detail: `${snap.proTraderPct.toFixed(3)}% < ${minPro}%`,
    });
    skipReasons.push(
      `Skipped — pro trader % too low (${snap.proTraderPct.toFixed(3)}% < ${minPro}%)`
    );
  }

  // Extreme deployer hold (≥ hard insider cap) — same non-bypassable class
  if (
    insiderGateActive &&
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
