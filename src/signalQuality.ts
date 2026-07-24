/**
 * High-conviction multi-factor signal scoring — gates entries to reduce
 * low-quality trades. Unified selective gate (do not duplicate elsewhere).
 *
 * Factors (0–100):
 * - Smart wallet cluster / convergence
 * - Bonding curve health + migration proximity
 * - Recent volume / net buy pressure
 * - Holder growth
 * - Inverse risk score
 * - Time since launch / entry freshness
 * - Birdeye / GMGN smart-money flow (heavier weight)
 * - Momentum confirmation (price holding after smart buy)
 * - Social sentiment (supporting filter; fail-open when unavailable)
 * - Trending narrative soft boost (confirmation only; fail-open when unavailable)
 * - Volume spike hard filter + soft boost (fail-open when unavailable)
 * - Combined Volume+Sentiment+Narrative confirmation layer
 */

import {
  config,
  effectiveMinHolders,
  type SelectiveTradingConfig,
} from './config';
import type { TradeSignal } from './monitor';
import {
  effectiveClusterMinWalletsForMc,
  effectiveMaxEntryAgeMinutes,
  effectiveMinConvictionScoreForMc,
  effectiveMomentumMinHoldPct,
  effectivePreferEntryWithinMinutes,
  effectiveRequireMomentumConfirmation,
  effectiveStrictMinVolume24hUsd,
} from './strictMode';
import { isStrategyEnabled } from './strategies';
import {
  resolveSocialSentimentForSignal,
  logSocialSentimentDecision,
} from './socialSentiment';
import {
  resolveTrendingNarrativeBoost,
  logNarrativeBoostDecision,
} from './trendingNarrative';
import {
  resolveVolumeSpikeForSignal,
  logVolumeSpikeDecision,
} from './volumeSpike';
import {
  resolveConfirmationLayerForSignal,
  logConfirmationDecision,
} from './confirmationLayer';

export interface ConvictionBreakdown {
  wallets: number;
  curve: number;
  volume: number;
  holders: number;
  risk: number;
  timing: number;
  smartFlow: number;
  momentum: number;
  /** Supporting social sentiment (± points folded into score) */
  social: number;
  /** Soft trending-narrative confirmation boost (≥ 0) */
  narrative: number;
  /** Volume spike soft boost (≥ 0; hard skip tracked separately) */
  volumeSpike: number;
  /** Combined Volume+Sentiment+Narrative confirmation boost (≥ 0) */
  confirmation: number;
}

export interface ConvictionVerdict {
  pass: boolean;
  score: number;
  minRequired: number;
  reasons: string[];
  sizeMultiplier: number;
  breakdown: ConvictionBreakdown;
  /** Human-readable factor line for logs */
  breakdownLine: string;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Scale position size down as anti-rug risk score rises. */
export function riskScoreSizeMultiplier(riskScore?: number): number {
  const sel = config.selective;
  if (!sel?.enabled || riskScore == null || !Number.isFinite(riskScore)) {
    return 1;
  }
  const cutoff = sel.riskScoreSizeCutoff ?? 35;
  const maxRisk = config.filters.maxRiskScore || 70;
  if (riskScore <= cutoff) return 1;
  const t = clamp((riskScore - cutoff) / Math.max(1, maxRisk - cutoff), 0, 1);
  const minMult = sel.minRiskSizeMultiplier ?? 0.3;
  return 1 - t * (1 - minMult);
}

function volumeUsd(signal: TradeSignal): number | null {
  return (
    signal.metrics?.volume24hUsd ??
    signal.birdeye?.volume24hUsd ??
    signal.antiRug?.birdeye?.volume24hUsd ??
    signal.antiRug?.volume24hUsd ??
    null
  );
}

function recentVolumeUsd(signal: TradeSignal): number | null {
  return (
    signal.metrics?.volumeH1Usd ??
    signal.metrics?.volumeM5Usd ??
    signal.antiRug?.volumeH1Usd ??
    null
  );
}

function holderCount(signal: TradeSignal): number | null {
  return (
    signal.metrics?.holderCountEstimate ??
    signal.birdeye?.holder ??
    signal.antiRug?.birdeye?.holder ??
    signal.antiRug?.holderCount ??
    null
  );
}

function buySellRatio(signal: TradeSignal): number | null {
  return (
    signal.metrics?.buySellRatio ??
    signal.birdeye?.buySellRatio ??
    signal.antiRug?.birdeyeBuySellRatio ??
    signal.antiRug?.buySellRatio ??
    null
  );
}

function priceChangeH1(signal: TradeSignal): number | null {
  return (
    signal.metrics?.priceChangeH1Pct ??
    signal.birdeye?.priceChange24hPct ??
    signal.antiRug?.priceChangeH1Pct ??
    null
  );
}

function isPrioritySignal(signal: TradeSignal): boolean {
  if (signal.isMigration) return true;
  if (signal.nearMigration) return true;
  if (signal.earlyBuy) return true;
  return false;
}

function formatBreakdown(b: ConvictionBreakdown): string {
  const social =
    b.social !== 0
      ? ` social=${b.social >= 0 ? '+' : ''}${b.social}`
      : '';
  const narrative =
    b.narrative !== 0 ? ` narr=+${b.narrative}` : '';
  const volumeSpike =
    b.volumeSpike !== 0 ? ` volSpike=+${b.volumeSpike}` : '';
  const confirmation =
    b.confirmation !== 0 ? ` confirm=+${b.confirmation}` : '';
  return (
    `wallets=${b.wallets} curve=${b.curve} vol=${b.volume} ` +
    `holders=${b.holders} risk=${b.risk} timing=${b.timing} ` +
    `flow=${b.smartFlow} mom=${b.momentum}` +
    social +
    narrative +
    volumeSpike +
    confirmation
  );
}

/**
 * Score a candidate signal 0–100 and decide if it meets selective thresholds.
 * Per-risk-level minConvictionScore lives on config.selective (set by presets).
 */
export function evaluateSignalConviction(signal: TradeSignal): ConvictionVerdict {
  const sel: SelectiveTradingConfig = config.selective;
  const entryMcHint =
    signal.sourceEntryMcUsd ??
    (signal.metrics as { marketCapUsd?: number | null } | undefined)?.marketCapUsd ??
    (signal.antiRug as { marketCapUsd?: number | null } | undefined)?.marketCapUsd ??
    null;
  const minRequired = effectiveMinConvictionScoreForMc(entryMcHint);
  const reasons: string[] = [];
  const breakdown: ConvictionBreakdown = {
    wallets: 0,
    curve: 0,
    volume: 0,
    holders: 0,
    risk: 0,
    timing: 0,
    smartFlow: 0,
    momentum: 0,
    social: 0,
    narrative: 0,
    volumeSpike: 0,
    confirmation: 0,
  };

  const walletCount = signal.wallets.length;
  const riskScore = signal.antiRug?.riskScore;
  const maxRisk = config.filters.maxRiskScore || 70;
  const flowWeight = isStrategyEnabled('smart_money_flow_weighting')
    ? clamp(config.filters.smartMoneyFlowWeight ?? 1.35, 0.5, 2.5)
    : 1;

  // --- Wallet convergence / cluster (0–28) ---
  const baseRequired = effectiveClusterMinWalletsForMc(entryMcHint);
  let requiredWallets = baseRequired;
  if (
    sel.enabled &&
    riskScore != null &&
    riskScore >= (sel.highRiskConvergenceThreshold ?? 45)
  ) {
    requiredWallets += sel.extraConvergenceAboveRisk ?? 1;
  }

  const priority = isPrioritySignal(signal);
  const allowSingle =
    priority &&
    sel.allowSingleWalletMigration !== false &&
    (signal.isMigration || signal.nearMigration || signal.earlyBuy) &&
    (signal.allowSingleWalletException === true ||
      walletCount >= 1);

  if (walletCount >= requiredWallets) {
    breakdown.wallets = clamp(14 + (walletCount - requiredWallets) * 5, 14, 28);
  } else if (allowSingle && walletCount >= 1) {
    breakdown.wallets = 11;
    reasons.push('single-wallet priority/migration allowed');
  } else if (
    sel.requireConvergenceForNormal !== false &&
    !priority &&
    walletCount < requiredWallets
  ) {
    reasons.push(`need ${requiredWallets} wallets (have ${walletCount})`);
    breakdown.wallets = clamp(walletCount * 4, 0, 10);
  } else if (walletCount >= 1) {
    breakdown.wallets = clamp(walletCount * 7, 7, 18);
  }

  // --- Bonding curve / migration proximity (0–18) ---
  const curvePct = signal.bondingCurve?.progressPct;
  const curveHealth = signal.bondingCurve?.health;
  if (signal.isMigration) {
    breakdown.curve = 18;
    reasons.push('migration momentum');
  } else if (signal.nearMigration) {
    breakdown.curve = 14;
    reasons.push('near-migration curve');
  } else if (signal.earlyBuy) {
    breakdown.curve = 12;
    if ((signal.earlyBuyerCount ?? 0) >= 2) breakdown.curve += 3;
    reasons.push('early-curve priority');
  } else if (
    curveHealth === 'preferred' ||
    (curvePct != null && curvePct >= 70 && curvePct <= 95)
  ) {
    breakdown.curve = 10;
    reasons.push('near-migration curve preference');
  } else if (curveHealth === 'dead' || curveHealth === 'stalled') {
    breakdown.curve = 0;
    reasons.push(`unhealthy curve (${curveHealth})`);
  } else if (curvePct != null) {
    breakdown.curve = clamp(curvePct / 12, 2, 8);
  } else {
    breakdown.curve = priority ? 6 : 3;
  }
  breakdown.curve = clamp(breakdown.curve, 0, 18);

  // --- Recent volume / buy pressure (0–12) ---
  const vol = volumeUsd(signal);
  const recentVol = recentVolumeUsd(signal);
  const minVol = effectiveStrictMinVolume24hUsd();
  const ratio = buySellRatio(signal);
  if (recentVol != null && recentVol >= (config.filters.minRecentVolumeUsd || 800)) {
    breakdown.volume += 6;
  } else if (recentVol != null && recentVol > 0) {
    breakdown.volume += 3;
  }
  if (minVol > 0) {
    if (vol != null && vol >= minVol) {
      breakdown.volume += clamp(3 + (vol / minVol), 3, 5);
    } else if (vol != null) {
      breakdown.volume += priority ? 2 : 1;
      if (!priority) reasons.push(`low volume $${vol.toFixed(0)} < $${minVol}`);
    } else {
      breakdown.volume += priority ? 2 : 1;
    }
  }
  if (ratio != null && ratio >= 1.2) breakdown.volume += 2;
  else if (ratio != null && ratio < 0.7) {
    breakdown.volume = Math.max(0, breakdown.volume - 2);
    reasons.push(`sell pressure buy/sell ${ratio.toFixed(2)}`);
  }
  breakdown.volume = clamp(breakdown.volume, 0, 12);

  // --- Holders (0–8) ---
  const holders = holderCount(signal);
  const minHolders = effectiveMinHolders();
  if (minHolders > 0) {
    if (holders != null && holders >= minHolders) breakdown.holders = 8;
    else if (holders != null) {
      breakdown.holders = clamp((holders / minHolders) * 5, 1, 5);
      reasons.push(`holders ${holders} < ${minHolders}`);
    } else {
      breakdown.holders = priority ? 3 : 2;
    }
  } else if (holders != null && holders >= 30) {
    breakdown.holders = 6;
  }

  // --- Risk quality inverse (0–14) ---
  if (riskScore != null) {
    breakdown.risk = clamp(((maxRisk - riskScore) / maxRisk) * 14, 0, 14);
    if (riskScore > maxRisk * 0.7) {
      reasons.push(`elevated risk score ${riskScore}`);
    }
  } else {
    breakdown.risk = priority ? 8 : 5;
  }

  // --- Timing / entry freshness (0–8) ---
  const preferMin = effectivePreferEntryWithinMinutes();
  const maxAge = effectiveMaxEntryAgeMinutes();
  const ageMin = signal.signalAgeMinutes;
  if (ageMin != null && Number.isFinite(ageMin)) {
    if (ageMin <= preferMin) {
      breakdown.timing = 8;
    } else if (ageMin <= maxAge) {
      breakdown.timing = clamp(8 - ((ageMin - preferMin) / Math.max(1, maxAge - preferMin)) * 5, 3, 7);
    } else {
      breakdown.timing = 0;
      reasons.push(`signal age ${ageMin.toFixed(1)}m > max ${maxAge}m`);
    }
  } else {
    breakdown.timing = priority ? 5 : 4;
  }

  // --- Birdeye / GMGN smart money flow (0–14 × weight, capped) ---
  const sm =
    signal.birdeye?.smartMoneyScore ??
    signal.antiRug?.birdeye?.smartMoneyScore ??
    null;
  let flowRaw = 0;
  if (sm != null && sm >= 70) flowRaw = 14;
  else if (sm != null && sm >= 50) flowRaw = 10;
  else if (sm != null && sm >= 30) flowRaw = 6;
  else if (sm != null && sm > 0) flowRaw = 3;
  // Wallet count as soft flow proxy when Birdeye missing
  if (flowRaw === 0 && walletCount >= 3) flowRaw = 5;
  breakdown.smartFlow = clamp(Math.round(flowRaw * flowWeight), 0, 18);

  // --- Momentum confirmation (0–8) ---
  const requireMom =
    isStrategyEnabled('momentum_confirmation') &&
    effectiveRequireMomentumConfirmation();
  const momLookback = config.filters.momentumLookbackMinutes ?? 15;
  const momMinHold = effectiveMomentumMinHoldPct();
  const chg = priceChangeH1(signal);
  const momOk =
    signal.momentumOk === true ||
    (signal.momentumOk !== false &&
      chg != null &&
      chg >= momMinHold);
  if (signal.momentumOk === true) {
    breakdown.momentum = 8;
  } else if (momOk && chg != null && chg >= 0) {
    breakdown.momentum = 7;
  } else if (momOk) {
    breakdown.momentum = 4;
  } else if (requireMom) {
    breakdown.momentum = 0;
    reasons.push(
      `momentum failed (need hold ≥ ${momMinHold}% over ~${momLookback}m)`
    );
  } else {
    breakdown.momentum = 2;
  }

  // --- Social sentiment (supporting filter; fail-open when no data) ---
  let socialSkip = false;
  let socialSkipReason: string | undefined;
  const socialVerdict = resolveSocialSentimentForSignal(signal);
  if (socialVerdict) {
    breakdown.social = socialVerdict.convictionDelta;
    if (socialVerdict.influenced) {
      if (socialVerdict.convictionDelta > 0) {
        reasons.push(
          `social boost +${socialVerdict.convictionDelta} (score ${socialVerdict.report.score})`
        );
        logSocialSentimentDecision(signal.symbol || 'token', socialVerdict, 'boost');
      } else if (socialVerdict.convictionDelta < 0) {
        reasons.push(
          `social reduce ${socialVerdict.convictionDelta} (score ${socialVerdict.report.score})`
        );
        logSocialSentimentDecision(
          signal.symbol || 'token',
          socialVerdict,
          socialVerdict.skip ? 'skip' : 'reduce'
        );
      }
    } else if (socialVerdict.report.source === 'none') {
      // Fail-open — do not log as influence
    }
    if (socialVerdict.skip) {
      socialSkip = true;
      socialSkipReason = socialVerdict.skipReason;
      reasons.push(socialVerdict.skipReason || 'social sentiment skip');
    }
  }

  // --- Trending narrative (soft boost only; fail-open when no match) ---
  const narrativeVerdict = resolveTrendingNarrativeBoost(signal);
  if (narrativeVerdict?.influenced) {
    breakdown.narrative = narrativeVerdict.convictionDelta;
    reasons.push(
      `narrative boost +${narrativeVerdict.convictionDelta} (${narrativeVerdict.report.themes.join(',')})`
    );
    logNarrativeBoostDecision(signal.symbol || 'token', narrativeVerdict);
  }

  // --- Volume spike (hard filter + soft boost; fail-open when no data) ---
  let volumeSpikeSkip = false;
  let volumeSpikeSkipReason: string | undefined;
  const volumeSpikeVerdict = resolveVolumeSpikeForSignal(signal);
  if (volumeSpikeVerdict) {
    if (volumeSpikeVerdict.convictionDelta > 0) {
      breakdown.volumeSpike = volumeSpikeVerdict.convictionDelta;
      const migTag = volumeSpikeVerdict.report.isMigration
        ? ' post-mig combo'
        : '';
      reasons.push(
        `volume spike boost +${volumeSpikeVerdict.convictionDelta}${migTag} (hits ${volumeSpikeVerdict.report.hitCount}, strength ${volumeSpikeVerdict.report.strength})`
      );
      logVolumeSpikeDecision(
        signal.symbol || 'token',
        volumeSpikeVerdict,
        'boost'
      );
    }
    if (volumeSpikeVerdict.skip) {
      volumeSpikeSkip = true;
      volumeSpikeSkipReason = volumeSpikeVerdict.skipReason;
      reasons.push(
        volumeSpikeVerdict.skipReason || 'volume spike filter skip'
      );
      logVolumeSpikeDecision(
        signal.symbol || 'token',
        volumeSpikeVerdict,
        'skip'
      );
    }
  }

  // --- Combined Volume+Sentiment+Narrative confirmation layer ---
  let confirmationSkip = false;
  let confirmationSkipReason: string | undefined;
  const confirmationVerdict = resolveConfirmationLayerForSignal(signal);
  if (confirmationVerdict) {
    if (confirmationVerdict.convictionDelta > 0) {
      breakdown.confirmation = confirmationVerdict.convictionDelta;
      const parts = confirmationVerdict.report.components
        .map((c) =>
          c.available
            ? `${c.key}:${c.contribution.toFixed(1)}`
            : `${c.key}:n/a`
        )
        .join(',');
      reasons.push(
        `confirmation ${confirmationVerdict.report.status} +${confirmationVerdict.convictionDelta} (score ${confirmationVerdict.report.score}; ${parts})`
      );
      logConfirmationDecision(
        signal.symbol || 'token',
        confirmationVerdict,
        'boost'
      );
    }
    if (confirmationVerdict.skip) {
      confirmationSkip = true;
      confirmationSkipReason = confirmationVerdict.skipReason;
      reasons.push(
        confirmationVerdict.skipReason || 'confirmation layer skip'
      );
      logConfirmationDecision(
        signal.symbol || 'token',
        confirmationVerdict,
        'skip'
      );
    }
  }

  let score =
    breakdown.wallets +
    breakdown.curve +
    breakdown.volume +
    breakdown.holders +
    breakdown.risk +
    breakdown.timing +
    breakdown.smartFlow +
    breakdown.momentum +
    breakdown.social +
    breakdown.narrative +
    breakdown.volumeSpike +
    breakdown.confirmation;
  score = Math.round(clamp(score, 0, 100));
  const sizeMultiplier = riskScoreSizeMultiplier(riskScore);
  const breakdownLine = formatBreakdown(breakdown);

  if (!sel.enabled) {
    return {
      pass: !socialSkip && !volumeSpikeSkip && !confirmationSkip,
      score,
      minRequired: 0,
      reasons,
      sizeMultiplier,
      breakdown,
      breakdownLine,
    };
  }

  const walletOk =
    walletCount >= requiredWallets ||
    allowSingle ||
    (priority && walletCount >= 1);

  if (!walletOk) {
    const msg = `need ${requiredWallets} wallets (have ${walletCount})`;
    if (!reasons.includes(msg)) reasons.push(msg);
  }

  if (requireMom && !momOk) {
    const msg = `momentum confirmation failed`;
    if (!reasons.some((r) => r.startsWith('momentum'))) reasons.push(msg);
  }

  if (score < minRequired) {
    reasons.push(`conviction ${score} < min ${minRequired}`);
  }

  const requireHealthyCurve = config.bondingCurve?.requireHealthyCurve === true;
  const hardFail =
    !walletOk ||
    (requireMom && !momOk) ||
    socialSkip ||
    volumeSpikeSkip ||
    confirmationSkip ||
    (requireHealthyCurve &&
      (curveHealth === 'dead' || curveHealth === 'stalled'));

  if (socialSkip && socialSkipReason) {
    // already in reasons
  }
  if (volumeSpikeSkip && volumeSpikeSkipReason) {
    // already in reasons
  }
  if (confirmationSkip && confirmationSkipReason) {
    // already in reasons
  }

  return {
    pass: !hardFail && score >= minRequired,
    score,
    minRequired,
    reasons,
    sizeMultiplier,
    breakdown,
    breakdownLine,
  };
}

const recentTradeTimes: number[] = [];

export function recordTradeExecuted(): void {
  recentTradeTimes.push(Date.now());
  const cutoff = Date.now() - 3_600_000;
  while (recentTradeTimes.length > 0 && recentTradeTimes[0] < cutoff) {
    recentTradeTimes.shift();
  }
}

/** Rate-limit gate — max trades/hour and min gap between buys. */
export function canExecuteTradeNow(): { ok: boolean; reason?: string } {
  return canExecuteTradeAt(Date.now(), recentTradeTimes);
}

/**
 * Pure rate-limit check for a simulated clock (backtests).
 * Does not mutate the live recentTradeTimes buffer.
 */
export function canExecuteTradeAt(
  nowMs: number,
  recentTimes: number[],
  sel: SelectiveTradingConfig = config.selective
): { ok: boolean; reason?: string } {
  if (!sel?.enabled) return { ok: true };

  const prior = recentTimes.filter((t) => t <= nowMs);

  const maxPerHour = sel.maxTradesPerHour ?? 0;
  if (maxPerHour > 0) {
    const hourAgo = nowMs - 3_600_000;
    const recent = prior.filter((t) => t >= hourAgo);
    if (recent.length >= maxPerHour) {
      return {
        ok: false,
        reason: `trade cap ${recent.length}/${maxPerHour} per hour`,
      };
    }
  }

  const minGap = sel.minMsBetweenTrades ?? 0;
  if (minGap > 0 && prior.length > 0) {
    const last = prior.reduce((m, t) => (t > m ? t : m), 0);
    if (nowMs - last < minGap) {
      return {
        ok: false,
        reason: `cooldown ${Math.ceil((minGap - (nowMs - last)) / 1000)}s remaining`,
      };
    }
  }

  return { ok: true };
}

export function getTradeRateStatus(): {
  tradesLastHour: number;
  maxTradesPerHour: number;
  msSinceLastTrade: number | null;
} {
  const now = Date.now();
  const hourAgo = now - 3_600_000;
  const recent = recentTradeTimes.filter((t) => t >= hourAgo);
  const last = recentTradeTimes[recentTradeTimes.length - 1];
  return {
    tradesLastHour: recent.length,
    maxTradesPerHour: config.selective?.maxTradesPerHour ?? 0,
    msSinceLastTrade: last != null ? now - last : null,
  };
}
