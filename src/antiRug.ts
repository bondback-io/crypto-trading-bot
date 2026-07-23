/**
 * Anti-rug risk checks for candidate tokens.
 * Combines cached token metrics, RugCheck (when available), Jupiter
 * buy/sell tax probe, LP lock heuristics, and recent-dev-sell detection.
 */

import { PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import { config } from './config';
import { getConnection } from './connection';
import {
  fetchTokenMetrics,
  getCachedTokenMetrics,
  TokenMetrics,
  summarizeTokenMetrics,
} from './tokenMetrics';
import { getQuote, getSellQuote } from './trade';
import {
  getTokenSniperActivity,
  summarizeSniper,
  shouldSkipForSnipers,
  type GmgnSniperReport,
} from './gmgn';
import {
  getTokenOverview,
  getSmartMoneySignal,
  summarizeBirdeye,
  type BirdeyeTokenOverview,
  type BirdeyeSmartMoneySignal,
} from './birdeye';
import {
  fetchBondingCurve,
  assessBondingCurveHealth,
  type BondingCurveHealth,
} from './bondingCurve';
import {
  evaluateDeadTokenHardFloors,
  evaluateHolderConcentrationHardFloors,
  isNonBypassableSkipReason,
} from './deadTokenFilters';
import { logger, errorToMeta, loggedFetch } from './logger';

export { isNonBypassableSkipReason };

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type FlagSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface AntiRugFlag {
  id: string;
  severity: FlagSeverity;
  label: string;
  detail?: string;
}

export interface AntiRugChecks {
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  volumeH1Usd: number | null;
  recentBuyVolumeUsd: number | null;
  txnsH1: number | null;
  holderCount: number | null;
  bondingCurveProgressPct: number | null;
  curveHealth: BondingCurveHealthStatus | null;
  devHoldPct: number | null;
  top10HoldPct: number | null;
  topHolderPct: number | null;
  liquidityLockedOrBurned: boolean | null;
  lpLockedPct: number | null;
  honeypot: boolean | null;
  estimatedBuyTaxPct: number | null;
  estimatedSellTaxPct: number | null;
  roundTripLossPct: number | null;
  recentDevSells: boolean | null;
  recentDevSellCount: number | null;
  mintAuthorityRenounced: boolean | null;
  freezeAuthorityRenounced: boolean | null;
  contractVerifiedHint: boolean | null;
  rugcheckScore: number | null;
  /** GMGN sniper composite 0–100 */
  sniperScore: number | null;
  sniperCount: number | null;
  bundlerPct: number | null;
  insiderPct: number | null;
  /** Birdeye enrichment (null when API unavailable) */
  birdeyeLiquidityUsd: number | null;
  birdeyeVolume24hUsd: number | null;
  birdeyeHolder: number | null;
  birdeyePrice: number | null;
  birdeyeSmartMoneyScore: number | null;
  birdeyeBuySellRatio: number | null;
}

type BondingCurveHealthStatus = BondingCurveHealth['status'];

export interface AntiRugReport {
  mint: string;
  ok: boolean;
  riskScore: number;
  riskLevel: RiskLevel;
  flags: AntiRugFlag[];
  /** Human skip lines e.g. "Skipped - high dev holdings (22% > 15%)" */
  skipReasons: string[];
  checks: AntiRugChecks;
  metricsSummary?: ReturnType<typeof summarizeTokenMetrics>;
  sniper?: ReturnType<typeof summarizeSniper>;
  birdeye?: ReturnType<typeof summarizeBirdeye>;
  fetchedAt: number;
  fromCache: boolean;
  sources: string[];
  error?: string;
}

interface CacheEntry {
  report: AntiRugReport;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<AntiRugReport>>();

const DEFAULT_TTL_MS = 90_000;
const BURN_ADDRESSES = new Set([
  '1nc1nerator11111111111111111111111111111111',
  '11111111111111111111111111111111',
  'dead1111111111111111111111111111111111111',
  'Burn111111111111111111111111111111111111111',
]);

function cacheTtlMs(): number {
  return config.tokenMetrics?.cacheTtlMs ?? DEFAULT_TTL_MS;
}

function isValidMint(m: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m);
}

function riskLevelFromScore(score: number): RiskLevel {
  if (score >= 75) return 'critical';
  if (score >= 55) return 'high';
  if (score >= 35) return 'medium';
  return 'low';
}

function emptyChecks(): AntiRugChecks {
  return {
    liquidityUsd: null,
    volume24hUsd: null,
    volumeH1Usd: null,
    recentBuyVolumeUsd: null,
    txnsH1: null,
    holderCount: null,
    bondingCurveProgressPct: null,
    curveHealth: null,
    devHoldPct: null,
    top10HoldPct: null,
    topHolderPct: null,
    liquidityLockedOrBurned: null,
    lpLockedPct: null,
    honeypot: null,
    estimatedBuyTaxPct: null,
    estimatedSellTaxPct: null,
    roundTripLossPct: null,
    recentDevSells: null,
    recentDevSellCount: null,
    mintAuthorityRenounced: null,
    freezeAuthorityRenounced: null,
    contractVerifiedHint: null,
    rugcheckScore: null,
    sniperScore: null,
    sniperCount: null,
    bundlerPct: null,
    insiderPct: null,
    birdeyeLiquidityUsd: null,
    birdeyeVolume24hUsd: null,
    birdeyeHolder: null,
    birdeyePrice: null,
    birdeyeSmartMoneyScore: null,
    birdeyeBuySellRatio: null,
  };
}

function antiRugCacheKey(
  mint: string,
  opts: { earlyEntry?: boolean; isMigrated?: boolean } = {}
): string {
  if (opts.earlyEntry || opts.isMigrated) {
    return `${mint}|e=${opts.earlyEntry ? 1 : 0}|m=${opts.isMigrated ? 1 : 0}`;
  }
  return mint;
}

export function getCachedAntiRug(mint: string): AntiRugReport | null {
  const hit = cache.get(mint);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(mint);
    return null;
  }
  return { ...hit.report, fromCache: true };
}

export function clearAntiRugCache(mint?: string): void {
  if (mint) cache.delete(mint);
  else cache.clear();
}

export function getAntiRugCacheStats() {
  return { size: cache.size, ttlMs: cacheTtlMs() };
}

/** Compact payload for dashboard / activity / positions */
export function summarizeAntiRug(report: AntiRugReport): {
  riskScore: number;
  riskLevel: RiskLevel;
  ok: boolean;
  flags: string[];
  skipReasons: string[];
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  volumeH1Usd: number | null;
  recentBuyVolumeUsd: number | null;
  holderCount: number | null;
  bondingCurveProgressPct: number | null;
  curveHealth: BondingCurveHealthStatus | null;
  liquidityLockedOrBurned: boolean | null;
  honeypot: boolean | null;
  recentDevSells: boolean | null;
  devHoldPct: number | null;
  top10HoldPct: number | null;
  sniperScore: number | null;
  sniperCount: number | null;
  bundlerPct: number | null;
  insiderPct: number | null;
  sniperHighRisk: boolean;
  birdeye: ReturnType<typeof summarizeBirdeye> | null;
} {
  return {
    riskScore: report.riskScore,
    riskLevel: report.riskLevel,
    ok: report.ok,
    flags: report.flags.map((f) => f.label),
    skipReasons: report.skipReasons,
    liquidityUsd: report.checks.liquidityUsd,
    volume24hUsd:
      report.checks.volume24hUsd ?? report.checks.birdeyeVolume24hUsd,
    volumeH1Usd: report.checks.volumeH1Usd,
    recentBuyVolumeUsd: report.checks.recentBuyVolumeUsd,
    holderCount: report.checks.holderCount ?? report.checks.birdeyeHolder,
    bondingCurveProgressPct: report.checks.bondingCurveProgressPct,
    curveHealth: report.checks.curveHealth,
    liquidityLockedOrBurned: report.checks.liquidityLockedOrBurned,
    honeypot: report.checks.honeypot,
    recentDevSells: report.checks.recentDevSells,
    devHoldPct: report.checks.devHoldPct,
    top10HoldPct: report.checks.top10HoldPct,
    sniperScore: report.checks.sniperScore,
    sniperCount: report.checks.sniperCount,
    bundlerPct: report.checks.bundlerPct,
    insiderPct: report.checks.insiderPct,
    sniperHighRisk: report.sniper?.highRisk ?? false,
    birdeye: report.birdeye ?? null,
  };
}

/**
 * Full anti-rug evaluation. Cached + inflight-deduped.
 * When enableAntiRug is false, still returns a soft report (ok=true) for UI.
 */
export interface AntiRugEvalOptions {
  force?: boolean;
  soft?: boolean;
  /** Early pump / near-migration / bonding-curve smart-money entry */
  earlyEntry?: boolean;
  /** Migration / graduated token */
  isMigrated?: boolean;
}

export async function evaluateAntiRug(
  mint: string,
  options: AntiRugEvalOptions = {}
): Promise<AntiRugReport> {
  if (!isValidMint(mint)) {
    return {
      mint,
      ok: false,
      riskScore: 100,
      riskLevel: 'critical',
      flags: [
        {
          id: 'invalid_mint',
          severity: 'critical',
          label: 'Invalid mint',
        },
      ],
      skipReasons: ['Skipped - invalid mint address'],
      checks: emptyChecks(),
      fetchedAt: Date.now(),
      fromCache: false,
      sources: [],
      error: 'Invalid mint',
    };
  }

  if (!options.force) {
    const key = antiRugCacheKey(mint, options);
    const hit = cache.get(key);
    if (hit) {
      if (hit.expiresAt < Date.now()) {
        cache.delete(key);
      } else {
        return { ...hit.report, fromCache: true };
      }
    }
    const pending = inflight.get(key);
    if (pending) return pending;
  }

  const cacheKey = antiRugCacheKey(mint, options);
  const job = (async () => {
    try {
      const report = await runAntiRugChecks(mint, {
        earlyEntry: options.earlyEntry,
        isMigrated: options.isMigrated,
      });
      cache.set(cacheKey, {
        report: { ...report, fromCache: false },
        expiresAt: Date.now() + cacheTtlMs(),
      });
      return report;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const fail: AntiRugReport = {
        mint,
        ok: false,
        riskScore: 80,
        riskLevel: 'high',
        flags: [
          {
            id: 'eval_error',
            severity: 'high',
            label: 'Anti-rug check failed',
            detail: message,
          },
        ],
        skipReasons: [`Skipped - anti-rug check failed (${message})`],
        checks: emptyChecks(),
        fetchedAt: Date.now(),
        fromCache: false,
        sources: [],
        error: message,
      };
      cache.set(cacheKey, {
        report: fail,
        expiresAt: Date.now() + Math.min(cacheTtlMs(), 30_000),
      });
      return fail;
    } finally {
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, job);
  return job;
}

async function runAntiRugChecks(
  mint: string,
  ctx: { earlyEntry?: boolean; isMigrated?: boolean } = {}
): Promise<AntiRugReport> {
  const filters = config.filters;
  const enabled = filters.enableAntiRug !== false;
  const flags: AntiRugFlag[] = [];
  const skipReasons: string[] = [];
  const hardSkipReasons: string[] = [];
  const sources: string[] = [];
  const checks = emptyChecks();
  let score = 0;

  const maxDev =
    filters.maxDevPercent ?? filters.maxDevHoldPct ?? 15;
  const maxConc =
    filters.maxHolderConcentration ??
    filters.maxTopHolderPct ??
    40;
  const maxTax = filters.maxEstimatedTaxPct ?? 25;
  const maxScore = filters.maxRiskScore ?? 70;
  const requireLock = filters.requireLiquidityLocked === true;
  const skipDevSells = filters.skipIfDevRecentSells !== false;
  const checkHoneypot = filters.checkHoneypot !== false;

  // --- Base metrics (shared cache with tokenMetrics) ---
  const metrics =
    getCachedTokenMetrics(mint) ?? (await fetchTokenMetrics(mint));
  sources.push(metrics.source || 'tokenMetrics');

  checks.liquidityUsd = metrics.liquidityUsd;
  checks.volume24hUsd = metrics.volume24hUsd;
  checks.volumeH1Usd = metrics.volumeH1Usd;
  checks.recentBuyVolumeUsd = metrics.recentBuyVolumeUsd;
  checks.txnsH1 = metrics.txnsH1;
  checks.holderCount = metrics.holderCountEstimate;
  checks.devHoldPct = metrics.devHoldPct;
  checks.top10HoldPct = metrics.top10HoldPct;
  checks.topHolderPct = metrics.topHolderPct;
  checks.mintAuthorityRenounced = metrics.mintAuthority == null;
  checks.freezeAuthorityRenounced = metrics.freezeAuthority == null;
  checks.contractVerifiedHint =
    metrics.mintAuthority == null && metrics.freezeAuthority == null;

  // --- Bonding curve health (cached) ---
  let curveHealth: BondingCurveHealth | null = null;
  let curveComplete = false;
  try {
    const curve = await fetchBondingCurve(mint);
    if (curve.source !== 'none') {
      sources.push('bonding-curve');
      checks.bondingCurveProgressPct = curve.progressPct;
      curveComplete = Boolean(curve.complete);
      curveHealth = assessBondingCurveHealth(curve, {
        volumeH1Usd: metrics.volumeH1Usd,
        txnsH1: metrics.txnsH1,
        recentBuyVolumeUsd: metrics.recentBuyVolumeUsd,
      });
      checks.curveHealth = curveHealth.status;
    }
  } catch (err) {
    logger.warn('anti-rug', 'bonding curve fetch failed', {
      mint: mint.slice(0, 12),
      ...errorToMeta(err),
    });
  }

  const isMigrated = Boolean(ctx.isMigrated || curveComplete);
  const earlyFromCurve =
    !isMigrated &&
    curveHealth != null &&
    checks.bondingCurveProgressPct != null &&
    checks.bondingCurveProgressPct < 99;
  const earlyEntry = Boolean(ctx.earlyEntry || earlyFromCurve);
  const floorCtx = { earlyEntry, isMigrated };

  // --- Non-bypassable dead-token floors (volume / liq / holders / curve) ---
  const hard = evaluateDeadTokenHardFloors(
    {
      liquidityUsd: checks.liquidityUsd,
      volume24hUsd: checks.volume24hUsd,
      volumeH1Usd: checks.volumeH1Usd,
      volumeM5Usd: metrics.volumeM5Usd,
      recentBuyVolumeUsd: checks.recentBuyVolumeUsd,
      buysH1: metrics.buysH1,
      sellsH1: metrics.sellsH1,
      txnsH1: checks.txnsH1,
      holderCount: checks.holderCount,
      buySellRatio: null,
      priceChangeH1Pct: metrics.priceChangeH1Pct,
      priceChange24hPct: metrics.priceChange24hPct,
      bondingCurveProgressPct: checks.bondingCurveProgressPct,
      isMigrated,
      curveHealth,
    },
    floorCtx
  );
  score += hard.scorePenalty;
  for (const f of hard.flags) {
    flags.push({
      id: f.id,
      severity: f.severity,
      label: f.label,
      detail: f.detail,
    });
  }
  hardSkipReasons.push(...hard.skipReasons);
  skipReasons.push(...hard.skipReasons);

  // Dev holdings
  if (maxDev > 0 && metrics.devHoldPct != null) {
    if (metrics.devHoldPct > maxDev) {
      score += 30;
      flags.push({
        id: 'high_dev_holdings',
        severity: 'critical',
        label: 'High dev holdings',
        detail: `${metrics.devHoldPct.toFixed(1)}% > ${maxDev}%`,
      });
      skipReasons.push(
        `Skipped - high dev holdings (${metrics.devHoldPct.toFixed(1)}% > ${maxDev}%)`
      );
    } else if (metrics.devHoldPct > maxDev * 0.7) {
      score += 10;
      flags.push({
        id: 'elevated_dev_holdings',
        severity: 'medium',
        label: 'Elevated dev holdings',
        detail: `${metrics.devHoldPct.toFixed(1)}%`,
      });
    }
  }

  // Top-10 concentration (max — min floor is a non-bypassable hard gate)
  if (maxConc > 0 && metrics.top10HoldPct != null) {
    if (metrics.top10HoldPct > maxConc) {
      score += 25;
      flags.push({
        id: 'holder_concentration',
        severity: 'high',
        label: 'High holder concentration',
        detail: `top10 ${metrics.top10HoldPct.toFixed(1)}% > ${maxConc}%`,
      });
      skipReasons.push(
        `Skipped - high holder concentration (top10 ${metrics.top10HoldPct.toFixed(1)}% > ${maxConc}%)`
      );
    }
  } else if (maxConc > 0 && metrics.topHolderPct != null) {
    // Fallback: single top holder vs concentration limit
    if (metrics.topHolderPct > maxConc) {
      score += 20;
      flags.push({
        id: 'top_holder',
        severity: 'high',
        label: 'Dominant top holder',
        detail: `${metrics.topHolderPct.toFixed(1)}% > ${maxConc}%`,
      });
      skipReasons.push(
        `Skipped - high top holder (${metrics.topHolderPct.toFixed(1)}% > ${maxConc}%)`
      );
    }
  }

  // Mint / freeze authority (basic contract check)
  if (metrics.mintAuthority) {
    score += 15;
    flags.push({
      id: 'mint_authority',
      severity: filters.skipIfMintAuthority ? 'critical' : 'medium',
      label: 'Mint authority active',
      detail: metrics.mintAuthority.slice(0, 8) + '…',
    });
    if (filters.skipIfMintAuthority) {
      skipReasons.push('Skipped - mint authority still set');
    }
  }
  if (metrics.freezeAuthority) {
    score += 10;
    flags.push({
      id: 'freeze_authority',
      severity: 'medium',
      label: 'Freeze authority active',
      detail: metrics.freezeAuthority.slice(0, 8) + '…',
    });
  }
  if (checks.contractVerifiedHint) {
    flags.push({
      id: 'authorities_renounced',
      severity: 'info',
      label: 'Mint & freeze renounced',
    });
  }

  // Burned supply in top holders (soft positive / LP heuristic)
  const burnedInTop = metrics.topHolders.some((h) =>
    BURN_ADDRESSES.has(h.address)
  );
  if (burnedInTop) {
    flags.push({
      id: 'burn_address_holder',
      severity: 'info',
      label: 'Burn address in top holders',
    });
  }

  // --- RugCheck enrichment (LP lock, risk list, score) ---
  const rug = await fetchRugcheckReport(mint).catch(() => null);
  if (rug) {
    sources.push('rugcheck');
    if (rug.score != null) checks.rugcheckScore = rug.score;
    if (rug.lpLockedPct != null) {
      checks.lpLockedPct = rug.lpLockedPct;
      checks.liquidityLockedOrBurned = rug.lpLockedPct >= 90 || rug.lpBurned;
    } else if (rug.lpBurned) {
      checks.liquidityLockedOrBurned = true;
      checks.lpLockedPct = 100;
    }

    for (const r of rug.risks.slice(0, 8)) {
      const sev = mapRugSeverity(r.level);
      flags.push({
        id: `rugcheck:${r.name}`,
        severity: sev,
        label: r.name,
        detail: r.description,
      });
      if (sev === 'critical') score += 20;
      else if (sev === 'high') score += 12;
      else if (sev === 'medium') score += 6;
    }
  }

  // Local LP burn heuristic if RugCheck missing
  if (checks.liquidityLockedOrBurned == null) {
    const lpHint = await inferLpLockFromDex(mint).catch(() => null);
    if (lpHint) {
      sources.push('dex-lp');
      checks.lpLockedPct = lpHint.lpLockedPct;
      checks.liquidityLockedOrBurned = lpHint.lockedOrBurned;
    }
  }

  if (requireLock && checks.liquidityLockedOrBurned === false) {
    score += 20;
    flags.push({
      id: 'lp_unlocked',
      severity: 'critical',
      label: 'Liquidity not locked/burned',
      detail:
        checks.lpLockedPct != null
          ? `LP locked ${checks.lpLockedPct.toFixed(0)}%`
          : 'unable to confirm lock',
    });
    skipReasons.push('Skipped - liquidity not locked or burned');
  } else if (checks.liquidityLockedOrBurned === false) {
    score += 12;
    flags.push({
      id: 'lp_unlocked_soft',
      severity: 'medium',
      label: 'Liquidity may be unlocked',
      detail:
        checks.lpLockedPct != null
          ? `LP locked ${checks.lpLockedPct.toFixed(0)}%`
          : undefined,
    });
  } else if (checks.liquidityLockedOrBurned === true) {
    flags.push({
      id: 'lp_locked',
      severity: 'info',
      label: 'Liquidity locked/burned',
      detail:
        checks.lpLockedPct != null
          ? `${checks.lpLockedPct.toFixed(0)}%`
          : undefined,
    });
    score = Math.max(0, score - 5);
  }

  // --- Recent dev sells ---
  if (metrics.devWallet) {
    const sells = await detectRecentDevSells(mint, metrics.devWallet).catch(
      () => ({ count: 0, sold: false })
    );
    checks.recentDevSells = sells.sold;
    checks.recentDevSellCount = sells.count;
    sources.push('dev-sells');

    if (sells.sold) {
      score += 22;
      flags.push({
        id: 'recent_dev_sells',
        severity: 'high',
        label: 'Recent dev sells',
        detail: `${sells.count} sell tx(s) in lookback`,
      });
      if (skipDevSells && enabled) {
        skipReasons.push(
          `Skipped - recent dev sells (${sells.count} in lookback)`
        );
      }
    } else if (metrics.devActiveRecently) {
      score += 5;
      flags.push({
        id: 'dev_active',
        severity: 'low',
        label: 'Dev wallet recently active',
        detail: `${metrics.devRecentTxCount ?? 0} txs`,
      });
    }
  }

  // --- Honeypot / tax via Jupiter round-trip ---
  if (checkHoneypot && enabled) {
    const tax = await probeBuySellTax(mint).catch(() => null);
    if (tax) {
      sources.push('jupiter-tax');
      checks.honeypot = tax.honeypot;
      checks.estimatedBuyTaxPct = tax.buyTaxPct;
      checks.estimatedSellTaxPct = tax.sellTaxPct;
      checks.roundTripLossPct = tax.roundTripLossPct;

      if (tax.noRoute) {
        // Soft signal only — do not hard-skip (bonding-curve / brand-new mints)
        score += 4;
        flags.push({
          id: 'no_jupiter_route',
          severity: 'low',
          label: 'No Jupiter route yet',
          detail: tax.reason,
        });
      } else if (tax.honeypot) {
        score += 40;
        flags.push({
          id: 'honeypot',
          severity: 'critical',
          label: 'Possible honeypot',
          detail: tax.reason,
        });
        skipReasons.push(
          `Skipped - possible honeypot (${tax.reason ?? 'no sell route'})`
        );
      } else if (
        tax.roundTripLossPct != null &&
        tax.roundTripLossPct > maxTax
      ) {
        score += 30;
        flags.push({
          id: 'high_tax',
          severity: 'critical',
          label: 'High buy/sell tax',
          detail: `round-trip loss ~${tax.roundTripLossPct.toFixed(1)}% > ${maxTax}%`,
        });
        skipReasons.push(
          `Skipped - high buy/sell tax (~${tax.roundTripLossPct.toFixed(1)}% round-trip)`
        );
      } else if (tax.roundTripLossPct != null && tax.roundTripLossPct > 10) {
        score += 8;
        flags.push({
          id: 'elevated_tax',
          severity: 'low',
          label: 'Elevated round-trip cost',
          detail: `~${tax.roundTripLossPct.toFixed(1)}%`,
        });
      }
    }
  }

  // --- GMGN sniper / bundler / insider ---
  let sniperSummary: ReturnType<typeof summarizeSniper> | undefined;
  if (filters.enableSniperFilter !== false) {
    try {
      const sniper: GmgnSniperReport = await getTokenSniperActivity(mint);
      if (sniper.source !== 'none') {
        sources.push(`gmgn-sniper:${sniper.source}`);
        checks.sniperScore = sniper.sniperScore;
        checks.sniperCount = sniper.sniperCount;
        checks.bundlerPct = sniper.bundlerPct;
        checks.insiderPct = sniper.insiderPct;
        sniperSummary = summarizeSniper(sniper);

        // Raise composite risk with sniper score (weighted)
        const sniperBoost = Math.round(sniper.sniperScore * 0.45);
        score += sniperBoost;

        if (sniper.highRisk || sniper.warnings.length > 0) {
          const sev: FlagSeverity = sniper.highRisk
            ? 'critical'
            : sniper.sniperScore >= 50
              ? 'high'
              : 'medium';
          flags.push({
            id: 'sniper_activity',
            severity: sev,
            label: sniper.highRisk
              ? 'Heavy sniper/bundler activity'
              : 'Sniper activity detected',
            detail: sniper.warnings.slice(0, 2).join('; ') ||
              `score ${sniper.sniperScore}`,
          });
        }

        if (sniper.bundlerPct != null && sniper.bundlerPct >= 20) {
          flags.push({
            id: 'bundlers',
            severity: sniper.bundlerPct >= 40 ? 'high' : 'medium',
            label: `Bundlers ${sniper.bundlerPct.toFixed(0)}%`,
          });
        }
        if (sniper.insiderPct != null && sniper.insiderPct >= 15) {
          flags.push({
            id: 'insiders',
            severity: sniper.insiderPct >= 30 ? 'high' : 'medium',
            label: `Insiders ${sniper.insiderPct.toFixed(0)}%`,
          });
        }

        const gate = shouldSkipForSnipers(sniper);
        if (gate.skip && enabled) {
          skipReasons.push(
            gate.reason ||
              `Skipped - heavy sniper activity (score ${sniper.sniperScore})`
          );
        }
      }
    } catch (err) {
      console.warn(
        `[anti-rug] Sniper fetch failed for ${mint.slice(0, 8)}…:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  // --- Non-bypassable holder dispersion / insider ceilings (all risk levels) ---
  const holderHard = evaluateHolderConcentrationHardFloors({
    top10HoldPct: checks.top10HoldPct,
    insiderPct: checks.insiderPct,
    devHoldPct: checks.devHoldPct,
  });
  score += holderHard.scorePenalty;
  for (const f of holderHard.flags) {
    flags.push({
      id: f.id,
      severity: f.severity,
      label: f.label,
      detail: f.detail,
    });
  }
  hardSkipReasons.push(...holderHard.skipReasons);
  skipReasons.push(...holderHard.skipReasons);

  // --- Birdeye token overview + smart-money signal (soft enrichment) ---
  let birdeyeSummary: ReturnType<typeof summarizeBirdeye> | undefined;
  try {
    // Sequential so smart-money reuses overview cache
    const overview: BirdeyeTokenOverview = await getTokenOverview(mint);
    const signal: BirdeyeSmartMoneySignal = await getSmartMoneySignal(mint);

    if (overview.source !== 'none' || signal.source !== 'none') {
      sources.push('birdeye');
      birdeyeSummary = summarizeBirdeye(overview, signal) ?? undefined;

      if (overview.liquidityUsd != null) {
        checks.birdeyeLiquidityUsd = overview.liquidityUsd;
        // Prefer Birdeye liquidity when Dex metrics missing or much lower
        if (
          checks.liquidityUsd == null ||
          checks.liquidityUsd <= 0 ||
          (overview.liquidityUsd > 0 &&
            overview.liquidityUsd > (checks.liquidityUsd ?? 0) * 0.5)
        ) {
          checks.liquidityUsd = overview.liquidityUsd;
        }
      }
      checks.birdeyeVolume24hUsd = overview.volume24hUsd;
      checks.birdeyeHolder = overview.holder;
      checks.birdeyePrice = overview.price;
      checks.birdeyeSmartMoneyScore = signal.smartMoneyScore;
      checks.birdeyeBuySellRatio = overview.buySellRatio ?? signal.buySellRatio;

      if (
        overview.volume24hUsd != null &&
        (checks.volume24hUsd == null || overview.volume24hUsd > checks.volume24hUsd)
      ) {
        checks.volume24hUsd = overview.volume24hUsd;
      }
      if (overview.holder != null) {
        checks.holderCount = overview.holder;
      }

      // Re-evaluate hard floors with Birdeye-enriched liquidity / volume / holders
      const hard2 = evaluateDeadTokenHardFloors(
        {
          liquidityUsd: checks.liquidityUsd,
          volume24hUsd: checks.volume24hUsd,
          volumeH1Usd: checks.volumeH1Usd,
          volumeM5Usd: metrics.volumeM5Usd,
          recentBuyVolumeUsd: checks.recentBuyVolumeUsd,
          buysH1: metrics.buysH1,
          sellsH1: metrics.sellsH1,
          txnsH1: checks.txnsH1,
          holderCount: checks.holderCount,
          buySellRatio: checks.birdeyeBuySellRatio,
          priceChangeH1Pct: metrics.priceChangeH1Pct,
          priceChange24hPct:
            overview.priceChange24hPct ?? metrics.priceChange24hPct,
          bondingCurveProgressPct: checks.bondingCurveProgressPct,
          isMigrated,
          curveHealth,
        },
        floorCtx
      );
      for (const reason of hard2.skipReasons) {
        if (!skipReasons.includes(reason)) {
          skipReasons.push(reason);
          hardSkipReasons.push(reason);
        }
      }
      for (const f of hard2.flags) {
        if (!flags.some((x) => x.id === f.id)) {
          flags.push({
            id: f.id,
            severity: f.severity,
            label: f.label,
            detail: f.detail,
          });
          score += Math.min(12, Math.round(hard2.scorePenalty / 4));
        }
      }

      // Soft sell-pressure / thin-liq signals (score only — floors already hard-gated)
      if (
        overview.liquidityUsd != null &&
        overview.liquidityUsd > 0 &&
        overview.liquidityUsd < 8_000
      ) {
        score += 8;
        flags.push({
          id: 'birdeye_thin_liq',
          severity: 'medium',
          label: 'Thin Birdeye liquidity',
          detail: `$${overview.liquidityUsd.toFixed(0)}`,
        });
      }

      if (signal.flags.includes('sell_pressure')) {
        score += 10;
        flags.push({
          id: 'birdeye_sell_pressure',
          severity: 'medium',
          label: 'Birdeye sell pressure',
          detail:
            signal.buySellRatio != null
              ? `buy/sell ${signal.buySellRatio}`
              : undefined,
        });
      }

      if (signal.flags.includes('wallet_outflow')) {
        score += 8;
        flags.push({
          id: 'birdeye_wallet_outflow',
          severity: 'low',
          label: 'Unique wallet outflow',
          detail:
            overview.uniqueWallet24hChangePct != null
              ? `${overview.uniqueWallet24hChangePct.toFixed(0)}%`
              : undefined,
        });
      }

      // Positive: smart money / buy pressure / trending
      if (signal.smartMoneyScore >= 60) {
        score = Math.max(0, score - 8);
        flags.push({
          id: 'birdeye_smart_flow',
          severity: 'info',
          label: 'Birdeye smart-money flow',
          detail: `score ${signal.smartMoneyScore}`,
        });
      } else if (signal.flags.includes('buy_pressure')) {
        score = Math.max(0, score - 4);
        flags.push({
          id: 'birdeye_buy_pressure',
          severity: 'info',
          label: 'Birdeye buy pressure',
        });
      }

      if (signal.trendingRank != null && signal.trendingRank <= 20) {
        flags.push({
          id: 'birdeye_trending',
          severity: 'info',
          label: `Birdeye trending #${signal.trendingRank}`,
        });
      }

      if (
        overview.volume24hUsd != null &&
        overview.volume24hUsd > 0 &&
        overview.volume24hUsd < 1_000 &&
        (overview.liquidityUsd ?? 0) > 0
      ) {
        score += 6;
        flags.push({
          id: 'birdeye_low_volume',
          severity: 'low',
          label: 'Low 24h volume (Birdeye)',
          detail: `$${overview.volume24hUsd.toFixed(0)}`,
        });
      }
    } else if (overview.error || signal.error) {
      // Soft fallback — do not fail the whole anti-rug check
      flags.push({
        id: 'birdeye_unavailable',
        severity: 'info',
        label: 'Birdeye unavailable',
        detail: overview.error || signal.error,
      });
    }
  } catch (err) {
    logger.warn('anti-rug', 'Birdeye enrichment failed', {
      mint: mint.slice(0, 12),
      ...errorToMeta(err),
    });
    flags.push({
      id: 'birdeye_error',
      severity: 'info',
      label: 'Birdeye check failed',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  score = Math.min(100, Math.max(0, Math.round(score)));

  // Aggregate risk-score gate (optional filters only — hard floors already applied)
  if (enabled && score >= maxScore) {
    const already = skipReasons.some((r) => r.includes('risk score'));
    if (!already) {
      skipReasons.push(
        `Skipped - high risk score (${score} ≥ ${maxScore})`
      );
    }
    if (!flags.some((f) => f.id === 'risk_score')) {
      flags.push({
        id: 'risk_score',
        severity: 'high',
        label: 'Risk score too high',
        detail: `${score} ≥ ${maxScore}`,
      });
    }
  }

  // Hard floors are never bypassable — even when enableAntiRug is off
  const hasHardSkip =
    hardSkipReasons.length > 0 ||
    skipReasons.some((r) => isNonBypassableSkipReason(r));
  const softSkips = skipReasons.filter((r) => !isNonBypassableSkipReason(r));
  const ok = !hasHardSkip && (!enabled || softSkips.length === 0);

  return {
    mint,
    ok,
    riskScore: score,
    riskLevel: riskLevelFromScore(score),
    flags,
    skipReasons,
    checks,
    metricsSummary: summarizeTokenMetrics(metrics),
    sniper: sniperSummary,
    birdeye: birdeyeSummary,
    fetchedAt: Date.now(),
    fromCache: false,
    sources,
  };
}

function mapRugSeverity(level?: string): FlagSeverity {
  const l = (level || '').toLowerCase();
  if (l.includes('danger') || l.includes('critical') || l === 'warn') {
    if (l.includes('danger') || l.includes('critical')) return 'critical';
    return 'high';
  }
  if (l.includes('warn') || l.includes('high')) return 'high';
  if (l.includes('medium') || l.includes('caution')) return 'medium';
  if (l.includes('info') || l.includes('low')) return 'low';
  return 'medium';
}

interface RugcheckParsed {
  score: number | null;
  lpLockedPct: number | null;
  lpBurned: boolean;
  risks: Array<{ name: string; level?: string; description?: string }>;
}

async function fetchRugcheckReport(
  mint: string
): Promise<RugcheckParsed | null> {
  try {
    const res = await loggedFetch(
      `https://api.rugcheck.xyz/v1/tokens/${mint}/report`,
      {
        context: 'RugCheck',
        label: 'token report',
        timeoutMs: 7_000,
        headers: { Accept: 'application/json' },
      }
    );
    if (!res.ok) {
      logger.warn('RugCheck', 'report not ok', {
        mint: mint.slice(0, 12),
        status: res.status,
      });
      return null;
    }
    const data = (await res.json()) as {
      score?: number;
      score_normalised?: number;
      risks?: Array<{
        name?: string;
        level?: string;
        description?: string;
      }>;
      markets?: Array<{
        lp?: {
          lpLockedPct?: number;
          lpLocked?: number;
          lpBurned?: boolean;
        };
        liquidityLocked?: boolean;
      }>;
    };

    let lpLockedPct: number | null = null;
    let lpBurned = false;
    for (const m of data.markets ?? []) {
      const pct =
        m.lp?.lpLockedPct ??
        (m.lp?.lpLocked != null ? Number(m.lp.lpLocked) : null);
      if (pct != null && (lpLockedPct == null || pct > lpLockedPct)) {
        lpLockedPct = Number(pct);
      }
      if (m.lp?.lpBurned || m.liquidityLocked) lpBurned = true;
    }

    return {
      score: data.score_normalised ?? data.score ?? null,
      lpLockedPct,
      lpBurned,
      risks: (data.risks ?? [])
        .filter((r) => r.name)
        .map((r) => ({
          name: String(r.name),
          level: r.level,
          description: r.description,
        })),
    };
  } catch (err) {
    logger.error('RugCheck', 'report fetch failed', {
      mint: mint.slice(0, 12),
      ...errorToMeta(err),
    });
    return null;
  }
}

async function inferLpLockFromDex(
  mint: string
): Promise<{ lockedOrBurned: boolean; lpLockedPct: number | null } | null> {
  try {
    const res = await loggedFetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      {
        context: 'DexScreener',
        label: 'lp lock probe',
        timeoutMs: 6_000,
        headers: { Accept: 'application/json' },
      }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      pairs?: Array<{
        chainId?: string;
        pairAddress?: string;
        labels?: string[];
        liquidity?: { usd?: number };
      }>;
    };
    const pairs = (data.pairs ?? []).filter((p) => p.chainId === 'solana');
    if (pairs.length === 0) return null;

    const labels = pairs.flatMap((p) => p.labels ?? []).map((l) => l.toLowerCase());
    if (labels.some((l) => l.includes('locked') || l.includes('burn'))) {
      return { lockedOrBurned: true, lpLockedPct: 100 };
    }

    // Heuristic: inspect top LP pair token accounts for burn ownership — expensive;
    // only check if we have a pair address and one quick largest-accounts call.
    const best = pairs.sort(
      (a, b) =>
        Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0)
    )[0];
    if (!best?.pairAddress) {
      return { lockedOrBurned: false, lpLockedPct: null };
    }

    // Without LP mint we can't prove lock; return unknown-as-unlocked soft signal
    return { lockedOrBurned: false, lpLockedPct: null };
  } catch {
    return null;
  }
}

async function detectRecentDevSells(
  mint: string,
  devWallet: string
): Promise<{ sold: boolean; count: number }> {
  const lookbackMs =
    config.tokenMetrics?.devActivityLookbackMs ?? 2 * 24 * 60 * 60 * 1000;
  const conn = getConnection();
  const cutoff = Math.floor((Date.now() - lookbackMs) / 1000);

  const sigs = await conn.getSignaturesForAddress(new PublicKey(devWallet), {
    limit: 12,
  });
  const recent = sigs.filter(
    (s) => s.blockTime != null && s.blockTime >= cutoff && !s.err
  );

  let sellCount = 0;
  // Cap parsed txs for speed
  for (const sig of recent.slice(0, 6)) {
    try {
      const tx = (await conn.getParsedTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0,
      })) as ParsedTransactionWithMeta | null;
      if (!tx?.meta) continue;
      if (tokenBalanceDecreased(tx, mint, devWallet)) {
        sellCount++;
      }
    } catch {
      // ignore single tx parse errors
    }
  }

  return { sold: sellCount > 0, count: sellCount };
}

function tokenBalanceDecreased(
  tx: ParsedTransactionWithMeta,
  mint: string,
  owner: string
): boolean {
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];

  const preAmt = sumOwnerMint(pre, mint, owner);
  const postAmt = sumOwnerMint(post, mint, owner);
  if (preAmt == null || postAmt == null) return false;
  return postAmt < preAmt * 0.99; // >1% decrease counts as sell
}

function sumOwnerMint(
  balances: NonNullable<ParsedTransactionWithMeta['meta']>['preTokenBalances'],
  mint: string,
  owner: string
): number | null {
  if (!balances) return null;
  let total = 0;
  let found = false;
  for (const b of balances) {
    if (b.mint !== mint) continue;
    if (b.owner && b.owner !== owner) continue;
    const ui = b.uiTokenAmount?.uiAmount;
    if (ui != null) {
      total += ui;
      found = true;
    }
  }
  return found ? total : null;
}

async function probeBuySellTax(mint: string): Promise<{
  honeypot: boolean;
  reason?: string;
  /** Jupiter has no route yet (common on early Pump bonding-curve tokens) */
  noRoute?: boolean;
  buyTaxPct: number | null;
  sellTaxPct: number | null;
  roundTripLossPct: number | null;
}> {
  // Small probe; high slippage tolerance so quote failures mean real issues.
  // Missing quotes are NOT treated as honeypots — early Pump.fun tokens often
  // have no Jupiter route until migration.
  const buy = await getQuote(mint, 0.05, 800);
  if (!buy?.outAmount || !buy?.inAmount) {
    return {
      honeypot: false,
      noRoute: true,
      reason: 'no buy quote (no Jupiter route yet)',
      buyTaxPct: null,
      sellTaxPct: null,
      roundTripLossPct: null,
    };
  }

  const sell = await getSellQuote(mint, buy.outAmount);
  if (!sell?.outAmount) {
    return {
      honeypot: true,
      reason: 'no sell quote',
      buyTaxPct: null,
      sellTaxPct: null,
      roundTripLossPct: null,
    };
  }

  const inLamports = Number(buy.inAmount);
  const outLamports = Number(sell.outAmount);
  if (!Number.isFinite(inLamports) || inLamports <= 0) {
    return {
      honeypot: false,
      buyTaxPct: null,
      sellTaxPct: null,
      roundTripLossPct: null,
    };
  }

  const roundTripLossPct = Math.max(
    0,
    (1 - outLamports / inLamports) * 100
  );

  // Jupiter priceImpactPct if present
  const buyImpact = Number(
    (buy as { priceImpactPct?: string }).priceImpactPct ?? 0
  );
  const sellImpact = Number(
    (sell as { priceImpactPct?: string }).priceImpactPct ?? 0
  );

  return {
    honeypot: false,
    // Jupiter priceImpactPct is already in percent units (e.g. "1.2" = 1.2%)
    buyTaxPct: Number.isFinite(buyImpact) ? buyImpact : null,
    sellTaxPct: Number.isFinite(sellImpact) ? sellImpact : null,
    roundTripLossPct,
  };
}

/** Attach-friendly log line */
export function formatAntiRugSkipLog(
  symbol: string,
  report: AntiRugReport
): string {
  const reasons =
    report.skipReasons.length > 0
      ? report.skipReasons.join('; ')
      : `Skipped - high risk (score ${report.riskScore})`;
  return `[anti-rug] ${symbol}: ${reasons} | score=${report.riskScore} (${report.riskLevel})`;
}
