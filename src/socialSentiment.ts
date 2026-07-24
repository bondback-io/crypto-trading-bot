/**
 * Social Sentiment Filter — supporting (not primary) entry signal.
 *
 * When social APIs are unavailable, builds a lightweight proxy from
 * on-chain / Birdeye metrics already on the trade signal:
 *  - mention surge ≈ recent volume / buy-pressure spike
 *  - pos/neg ratio ≈ buy/sell volume ratio
 *  - KOL / smart-money social ≈ Birdeye smartMoneyScore + wallet cluster
 *
 * Fail-open: if no usable data, never block the trade.
 */

import { config } from './config';
import { isStrategyEnabled, logStrategyDecision } from './strategies';

export type SocialSentimentSensitivity = 'low' | 'medium' | 'high';

export type SocialSentimentSource =
  | 'none'
  | 'proxy'
  | 'api';

export interface SocialSentimentReport {
  source: SocialSentimentSource;
  /** Composite −100 (toxic) … +100 (very bullish) */
  score: number;
  /** 0–100 inferred “mention / activity” intensity */
  mentionHeat: number;
  /** Positive share 0–1 (0.5 = balanced) */
  positiveRatio: number;
  /** Smart-money / KOL activity 0–100 */
  kolActivity: number;
  /** Human-readable flags */
  flags: string[];
  detail: string;
}

export interface SocialSentimentVerdict {
  /** Absolute conviction points to add (can be negative) */
  convictionDelta: number;
  /** Hard-skip only when sentiment is very negative and data is present */
  skip: boolean;
  skipReason?: string;
  influenced: boolean;
  report: SocialSentimentReport;
  logLine: string;
}

const EMPTY_REPORT: SocialSentimentReport = {
  source: 'none',
  score: 0,
  mentionHeat: 0,
  positiveRatio: 0.5,
  kolActivity: 0,
  flags: [],
  detail: 'social data unavailable',
};

type SignalLike = {
  mint?: string;
  symbol?: string;
  wallets?: unknown[];
  metrics?: {
    volume24hUsd?: number | null;
    recentVolumeUsd?: number | null;
    recentBuyVolumeUsd?: number | null;
    volumeBuy24hUsd?: number | null;
    volumeSell24hUsd?: number | null;
  } | null;
  birdeye?: {
    smartMoneyScore?: number | null;
    volume24hUsd?: number | null;
    volumeBuy24hUsd?: number | null;
    volumeSell24hUsd?: number | null;
  } | null;
  antiRug?: {
    birdeye?: {
      smartMoneyScore?: number | null;
    } | null;
  } | null;
};

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sensitivity(): SocialSentimentSensitivity {
  const s = config.filters.socialSentimentSensitivity;
  return s === 'low' || s === 'high' ? s : 'medium';
}

/** Thresholds by sensitivity — higher = more reactive / more skips. */
function bands(level: SocialSentimentSensitivity): {
  skipBelow: number;
  softNegBelow: number;
  softPosAbove: number;
  strongPosAbove: number;
  maxBoost: number;
  maxPenalty: number;
} {
  switch (level) {
    case 'low':
      return {
        skipBelow: -75,
        softNegBelow: -45,
        softPosAbove: 35,
        strongPosAbove: 60,
        maxBoost: 6,
        maxPenalty: 5,
      };
    case 'high':
      return {
        skipBelow: -40,
        softNegBelow: -20,
        softPosAbove: 20,
        strongPosAbove: 45,
        maxBoost: 12,
        maxPenalty: 12,
      };
    case 'medium':
    default:
      return {
        skipBelow: -55,
        softNegBelow: -30,
        softPosAbove: 28,
        strongPosAbove: 55,
        maxBoost: 9,
        maxPenalty: 8,
      };
  }
}

/**
 * Build a proxy social report from metrics already attached to the signal.
 * Returns source 'none' when there is not enough data to form an opinion.
 */
export function evaluateSocialSentimentFromSignal(
  signal: SignalLike
): SocialSentimentReport {
  const flags: string[] = [];
  const vol24 =
    num(signal.metrics?.volume24hUsd) ??
    num(signal.birdeye?.volume24hUsd);
  const recent =
    num(signal.metrics?.recentVolumeUsd) ??
    num(signal.metrics?.recentBuyVolumeUsd);
  const buy =
    num(signal.metrics?.volumeBuy24hUsd) ??
    num(signal.birdeye?.volumeBuy24hUsd) ??
    num(signal.metrics?.recentBuyVolumeUsd);
  const sell =
    num(signal.metrics?.volumeSell24hUsd) ??
    num(signal.birdeye?.volumeSell24hUsd);
  const sm =
    num(signal.birdeye?.smartMoneyScore) ??
    num(signal.antiRug?.birdeye?.smartMoneyScore);
  const walletCount = Array.isArray(signal.wallets) ? signal.wallets.length : 0;

  const hasVolume = (vol24 != null && vol24 > 0) || (recent != null && recent > 0);
  const hasFlow = sm != null && sm > 0;
  const hasRatio = buy != null && buy > 0 && sell != null && sell >= 0;

  if (!hasVolume && !hasFlow && !hasRatio && walletCount < 2) {
    return { ...EMPTY_REPORT };
  }

  // Mention heat — sudden activity vs quiet
  let mentionHeat = 0;
  if (recent != null && recent > 0) {
    const baseline = Math.max(vol24 ?? recent * 4, 1);
    const intensity = (recent * 6) / baseline; // recent vs 24h share
    mentionHeat = Math.max(0, Math.min(100, Math.round(intensity * 40)));
    if (mentionHeat >= 55) flags.push('mention_surge');
    else if (mentionHeat <= 15) flags.push('social_quiet');
  } else if (vol24 != null && vol24 > 0) {
    mentionHeat = Math.max(10, Math.min(70, Math.round(Math.log10(vol24 + 10) * 12)));
  }

  // Positive vs negative — buy/sell pressure
  let positiveRatio = 0.5;
  if (hasRatio && buy != null && sell != null) {
    const total = buy + sell;
    positiveRatio = total > 0 ? buy / total : 0.5;
    if (positiveRatio >= 0.62) flags.push('positive_bias');
    else if (positiveRatio <= 0.38) flags.push('negative_bias');
  }

  // KOL / smart-money social activity
  let kolActivity = 0;
  if (sm != null) {
    kolActivity = Math.max(0, Math.min(100, Math.round(sm)));
    if (kolActivity >= 60) flags.push('kol_smart_money_active');
  }
  if (walletCount >= 3) {
    kolActivity = Math.max(kolActivity, Math.min(100, 40 + walletCount * 8));
    flags.push('multi_wallet_social');
  }

  // Composite −100…+100
  const posComponent = (positiveRatio - 0.5) * 120; // −60…+60
  const heatComponent = (mentionHeat - 40) * 0.55; // quiet negative, surge positive
  const kolComponent = (kolActivity - 40) * 0.5;
  let score = Math.round(posComponent + heatComponent + kolComponent);
  score = Math.max(-100, Math.min(100, score));

  if (flags.includes('social_quiet') && flags.includes('negative_bias')) {
    score = Math.min(score, -40);
    flags.push('dead_or_toxic');
  }

  const detail =
    `proxy score=${score} heat=${mentionHeat} posRatio=${positiveRatio.toFixed(2)} ` +
    `kol=${kolActivity}` +
    (flags.length ? ` [${flags.join(',')}]` : '');

  return {
    source: 'proxy',
    score,
    mentionHeat,
    positiveRatio,
    kolActivity,
    flags,
    detail,
  };
}

/**
 * Apply sensitivity bands → conviction delta and optional hard skip.
 * Fail-open when report.source === 'none'.
 */
export function applySocialSentimentVerdict(
  report: SocialSentimentReport,
  options?: { sensitivity?: SocialSentimentSensitivity }
): SocialSentimentVerdict {
  if (report.source === 'none') {
    return {
      convictionDelta: 0,
      skip: false,
      influenced: false,
      report,
      logLine: 'social sentiment: no data (fail-open)',
    };
  }

  const level = options?.sensitivity ?? sensitivity();
  const b = bands(level);
  let convictionDelta = 0;
  let skip = false;
  let skipReason: string | undefined;

  if (report.score <= b.skipBelow) {
    skip = true;
    skipReason = `social sentiment very negative (score ${report.score}, ${level})`;
    convictionDelta = -b.maxPenalty;
  } else if (report.score <= b.softNegBelow) {
    const t =
      (b.softNegBelow - report.score) /
      Math.max(1, b.softNegBelow - b.skipBelow);
    convictionDelta = -Math.round(b.maxPenalty * (0.4 + 0.6 * t));
  } else if (report.score >= b.strongPosAbove) {
    convictionDelta = b.maxBoost;
  } else if (report.score >= b.softPosAbove) {
    const t =
      (report.score - b.softPosAbove) /
      Math.max(1, b.strongPosAbove - b.softPosAbove);
    convictionDelta = Math.round(b.maxBoost * (0.4 + 0.6 * t));
  }

  const influenced = convictionDelta !== 0 || skip;
  const logLine =
    `social sentiment ${level}: score=${report.score} Δconv=${
      convictionDelta >= 0 ? '+' : ''
    }${convictionDelta}` +
    (skip ? ' SKIP' : '') +
    ` · ${report.detail}`;

  return {
    convictionDelta,
    skip,
    skipReason,
    influenced,
    report,
    logLine,
  };
}

/** Convenience: evaluate + apply when strategy is enabled. */
export function resolveSocialSentimentForSignal(
  signal: SignalLike
): SocialSentimentVerdict | null {
  if (!isStrategyEnabled('social_sentiment_filter')) return null;
  if (config.filters.enableSocialSentimentFilter === false) return null;

  const report = evaluateSocialSentimentFromSignal(signal);
  const verdict = applySocialSentimentVerdict(report);
  return verdict;
}

/** Log take/skip when sentiment influenced the decision. */
export function logSocialSentimentDecision(
  symbol: string,
  verdict: SocialSentimentVerdict,
  outcome: 'boost' | 'reduce' | 'skip' | 'neutral'
): void {
  if (!verdict.influenced && outcome === 'neutral') return;
  const action =
    outcome === 'skip'
      ? 'skip'
      : outcome === 'boost' || outcome === 'reduce'
        ? 'take'
        : 'take';
  logStrategyDecision(
    'social_sentiment_filter',
    action,
    `${symbol}: ${verdict.logLine}`
  );
  const tag =
    outcome === 'skip'
      ? 'SKIP'
      : outcome === 'boost'
        ? 'BOOST'
        : outcome === 'reduce'
          ? 'REDUCE'
          : 'INFO';
  console.log(`[social] ${tag} ${symbol} — ${verdict.logLine}`);
}
