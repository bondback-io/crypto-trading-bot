/**
 * High-conviction signal scoring — gates entries to reduce low-quality trades.
 */

import { config, type SelectiveTradingConfig } from './config';
import type { TradeSignal } from './monitor';

export interface ConvictionVerdict {
  pass: boolean;
  score: number;
  minRequired: number;
  reasons: string[];
  sizeMultiplier: number;
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
    signal.birdeye?.volume24hUsd ??
    signal.antiRug?.birdeye?.volume24hUsd ??
    null
  );
}

function holderCount(signal: TradeSignal): number | null {
  return signal.birdeye?.holder ?? signal.antiRug?.birdeye?.holder ?? null;
}

function isPrioritySignal(signal: TradeSignal): boolean {
  if (signal.isMigration) return true;
  if (signal.nearMigration) return true;
  if (signal.earlyBuy && (signal.earlyBuyerCount ?? 0) >= 2) return true;
  return false;
}

/**
 * Score a candidate signal 0–100 and decide if it meets selective thresholds.
 */
export function evaluateSignalConviction(signal: TradeSignal): ConvictionVerdict {
  const sel: SelectiveTradingConfig = config.selective;
  const minRequired = sel.minConvictionScore ?? 55;
  const reasons: string[] = [];
  let score = 0;

  const walletCount = signal.wallets.length;
  const riskScore = signal.antiRug?.riskScore;
  const maxRisk = config.filters.maxRiskScore || 70;

  // --- Wallet convergence (0–30) ---
  const baseRequired = config.filters.convergenceRequired ?? 2;
  let requiredWallets = Math.max(sel.minWalletsForTrade ?? 2, baseRequired);
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
    (signal.isMigration || signal.nearMigration);

  if (walletCount >= requiredWallets) {
    score += clamp(15 + (walletCount - requiredWallets) * 5, 15, 30);
  } else if (allowSingle && walletCount >= 1) {
    score += 12;
    reasons.push(`single-wallet ${priority ? 'priority' : ''} migration allowed`);
  } else if (
    sel.requireConvergenceForNormal !== false &&
    !priority &&
    walletCount < requiredWallets
  ) {
    reasons.push(
      `need ${requiredWallets} wallets (have ${walletCount})`
    );
  } else if (walletCount >= 1) {
    score += clamp(walletCount * 8, 8, 20);
  }

  // --- Migration / momentum (0–25) ---
  if (signal.isMigration) {
    score += 25;
    reasons.push('migration momentum');
  } else if (signal.nearMigration) {
    score += 18;
    reasons.push('near-migration curve');
  } else if (signal.earlyBuy) {
    score += 10;
    if ((signal.earlyBuyerCount ?? 0) >= 2) score += 5;
  }

  // --- Risk quality inverse (0–25) ---
  if (riskScore != null) {
    const riskQuality = clamp(((maxRisk - riskScore) / maxRisk) * 25, 0, 25);
    score += riskQuality;
    if (riskScore > maxRisk * 0.7) {
      reasons.push(`elevated risk score ${riskScore}`);
    }
  } else {
    score += 8;
  }

  // --- Volume / liquidity (0–10) ---
  const vol = volumeUsd(signal);
  const minVol = Math.max(
    sel.minVolume24hUsd ?? 0,
    config.filters.minVolume24hUsd ?? 0
  );
  if (minVol > 0) {
    if (vol != null && vol >= minVol) {
      score += clamp(5 + (vol / minVol) * 2, 5, 10);
    } else if (vol != null) {
      score += clamp((vol / minVol) * 4, 0, 4);
      reasons.push(`low volume $${vol.toFixed(0)} < $${minVol}`);
    } else if (priority) {
      score += 3;
    } else {
      reasons.push('volume unknown');
    }
  } else if (vol != null && vol > 0) {
    score += vol >= 10_000 ? 8 : 4;
  }

  // --- Birdeye smart money / holders (0–10) ---
  const sm = signal.birdeye?.smartMoneyScore;
  if (sm != null && sm >= 50) score += clamp(sm / 10, 3, 8);
  else if (sm != null && sm >= 30) score += 3;

  const holders = holderCount(signal);
  const minHolders = Math.max(
    sel.minHolderCount ?? 0,
    config.filters.minHolderCount ?? 0
  );
  if (minHolders > 0) {
    if (holders != null && holders >= minHolders) score += 5;
    else if (holders != null) {
      reasons.push(`holders ${holders} < ${minHolders}`);
    } else if (!priority) {
      reasons.push('holder count unknown');
    }
  }

  score = Math.round(clamp(score, 0, 100));
  const sizeMultiplier = riskScoreSizeMultiplier(riskScore);

  if (!sel.enabled) {
    return { pass: true, score, minRequired: 0, reasons, sizeMultiplier };
  }

  const walletOk =
    walletCount >= requiredWallets ||
    allowSingle ||
    (priority && walletCount >= 1);

  if (!walletOk) {
    const msg = `need ${requiredWallets} wallets (have ${walletCount})`;
    if (!reasons.includes(msg)) reasons.push(msg);
  }

  if (minVol > 0 && vol != null && vol < minVol) {
    const msg = `low volume $${vol.toFixed(0)} < $${minVol}`;
    if (!reasons.some((r) => r.startsWith('low volume'))) reasons.push(msg);
  }

  if (minHolders > 0 && holders != null && holders < minHolders) {
    const msg = `holders ${holders} < ${minHolders}`;
    if (!reasons.some((r) => r.startsWith('holders'))) reasons.push(msg);
  }

  if (score < minRequired) {
    reasons.push(`conviction ${score} < min ${minRequired}`);
  }

  const hardFail = !walletOk ||
    (minVol > 0 && vol != null && vol < minVol) ||
    (minHolders > 0 && holders != null && holders < minHolders);

  return {
    pass: !hardFail && score >= minRequired,
    score,
    minRequired,
    reasons,
    sizeMultiplier,
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
  const sel = config.selective;
  if (!sel?.enabled) return { ok: true };

  const now = Date.now();
  const maxPerHour = sel.maxTradesPerHour ?? 0;
  if (maxPerHour > 0) {
    const hourAgo = now - 3_600_000;
    const recent = recentTradeTimes.filter((t) => t >= hourAgo);
    if (recent.length >= maxPerHour) {
      return {
        ok: false,
        reason: `trade cap ${recent.length}/${maxPerHour} per hour`,
      };
    }
  }

  const minGap = sel.minMsBetweenTrades ?? 0;
  if (minGap > 0 && recentTradeTimes.length > 0) {
    const last = recentTradeTimes[recentTradeTimes.length - 1];
    if (now - last < minGap) {
      return {
        ok: false,
        reason: `cooldown ${Math.ceil((minGap - (now - last)) / 1000)}s remaining`,
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
