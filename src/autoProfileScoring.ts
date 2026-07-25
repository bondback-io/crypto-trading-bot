/**
 * Automatic Profile Scoring — factor affinities + weights on top of
 * existing per-profile match rules (scoreProfile). Display-oriented 0–100 scores.
 */

import { detectMarketSession } from './marketSession';
import type {
  TradeProfileDefinition,
  TradeProfileId,
  TradeProfileMatchContext,
} from './tradeProfiles';
import {
  evaluateFreshMigrationEligibility,
  FRESH_MIGRATION_MAX_AGE_HOURS,
  FRESH_MIGRATION_MAX_MC_USD,
} from './tradeProfiles';
import {
  evaluateHwrQualityFilter,
  normalizeHwrQualityFilter,
} from './hwrQualityFilter';

export interface AutoScoringWeights {
  /** Volume behaviour */
  volume: number;
  /** Smart wallet activity */
  smartMoney: number;
  /** Token age / stage (includes MC stage signal) */
  tokenAge: number;
  /** Volatility / speed of move */
  volatility: number;
  /** Support / Fib proximity */
  supportFib: number;
  /** Chart pattern fit (primary / secondary profile assignments) */
  chartPatterns: number;
  /** Migration status */
  migration: number;
  /** Combined liquidity + holders */
  liquidityHolders: number;
  /** Market session */
  session: number;
}

/** Official default weights (sum = 100) */
export const DEFAULT_AUTO_SCORING_WEIGHTS: AutoScoringWeights = {
  volume: 20,
  smartMoney: 16,
  tokenAge: 12,
  volatility: 11,
  supportFib: 10,
  chartPatterns: 10,
  migration: 9,
  liquidityHolders: 7,
  session: 5,
};

/** Friendly labels for settings UI */
export const AUTO_SCORING_WEIGHT_LABELS: Record<
  keyof AutoScoringWeights,
  string
> = {
  volume: 'Volume Behaviour',
  smartMoney: 'Smart Wallet Activity',
  tokenAge: 'Token Age / Stage',
  volatility: 'Volatility / Speed of Move',
  supportFib: 'Support / Fib Proximity',
  chartPatterns: 'Chart Pattern Fit',
  migration: 'Migration Status',
  liquidityHolders: 'Liquidity + Holders',
  session: 'Market Session',
};

export const AUTO_SCORING_WEIGHT_KEYS = Object.keys(
  DEFAULT_AUTO_SCORING_WEIGHTS
) as (keyof AutoScoringWeights)[];

export interface AutoScoringConfig {
  /** When false, use legacy match-only assignment (no min-score skip) */
  enabled: boolean;
  /** Minimum 0–100 score to accept a trade when skipBelowMin is true */
  minScore: number;
  skipBelowMin: boolean;
  /** Force this profile when it is ON (bypasses scoring) */
  forceProfileId: TradeProfileId | null;
  weights: AutoScoringWeights;
}

export const DEFAULT_AUTO_SCORING: AutoScoringConfig = {
  enabled: true,
  minScore: 45,
  skipBelowMin: true,
  forceProfileId: null,
  weights: { ...DEFAULT_AUTO_SCORING_WEIGHTS },
};

export interface ProfileScoreBreakdown {
  profileId: TradeProfileId;
  name: string;
  icon: string;
  color: string;
  /** 0–100 final score */
  score: number;
  reason: string;
  /** Raw match-rule score before weighting */
  matchRaw: number;
  factors: Partial<Record<keyof AutoScoringWeights, number>>;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function num(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) ? Number(v) : null;
}

/** Soft preference: value near `ideal` within `span` → 1 */
function nearIdeal(
  value: number | null,
  ideal: number,
  span: number
): number {
  if (value == null || span <= 0) return 0.45;
  return clamp01(1 - Math.abs(value - ideal) / span);
}

function highIsBetter(
  value: number | null,
  low: number,
  high: number
): number {
  if (value == null) return 0.45;
  if (value <= low) return 0;
  if (value >= high) return 1;
  return clamp01((value - low) / (high - low));
}

function lowIsBetter(
  value: number | null,
  low: number,
  high: number
): number {
  if (value == null) return 0.45;
  if (value <= low) return 1;
  if (value >= high) return 0;
  return clamp01(1 - (value - low) / (high - low));
}

function sessionAffinity(preferred: boolean): number {
  return preferred ? 1 : 0.55;
}

/**
 * Per-factor affinities 0–1 for how well the setup suits this profile.
 */
export function computeFactorAffinities(
  def: TradeProfileDefinition,
  ctx: TradeProfileMatchContext
): Record<keyof AutoScoringWeights, number> {
  const m = def.match;
  const mc = num(ctx.marketCapUsd);
  const age = num(ctx.tokenAgeHours);
  const volH1 = num(ctx.volumeH1Usd);
  const volM5 =
    num(ctx.volumeM5Usd) ?? num(ctx.recentBuyVolumeUsd);
  const holders = num(ctx.holderCount);
  const liq = num(ctx.liquidityUsd);
  const chg24 = num(ctx.priceChange24hPct);
  const chgH1 = num(ctx.priceChangeH1Pct);
  const drop = num(ctx.dropFromPeakPct);
  const sm = num(ctx.smartMoneyScore);
  const wq = num(ctx.walletQualityAvg);
  const wallets = num(ctx.walletCount);

  const freshMig = evaluateFreshMigrationEligibility(ctx, {
    maxTokenAgeHours:
      m.maxTokenAgeHours ?? FRESH_MIGRATION_MAX_AGE_HOURS,
    maxMarketCapUsd: m.maxMarketCapUsd ?? FRESH_MIGRATION_MAX_MC_USD,
  });
  const isMig = freshMig.ok;

  const session = detectMarketSession();
  const preferredSession =
    session.primary === 'us' ||
    session.primary === 'europe' ||
    session.isOverlap;

  // Market cap
  let marketCap = 0.5;
  if (m.preferSmallMc || m.preferScalp) {
    marketCap = lowIsBetter(mc, 5_000, m.maxMarketCapUsd ?? 150_000);
  } else if (m.preferTrend || m.preferSteadyCompounder) {
    marketCap = highIsBetter(mc, 50_000, 2_000_000);
  } else if (m.preferMigration) {
    marketCap = lowIsBetter(mc, 10_000, m.maxMarketCapUsd ?? FRESH_MIGRATION_MAX_MC_USD);
  } else if (m.preferHighWinRate || m.preferSmartMoneyMirror) {
    marketCap = nearIdeal(mc, 400_000, 800_000);
  }

  // Token age
  let tokenAge = 0.5;
  if (m.preferMigration || m.preferScalp || m.preferMomentumBurst) {
    tokenAge = lowIsBetter(
      age,
      0.05,
      m.maxTokenAgeHours ?? FRESH_MIGRATION_MAX_AGE_HOURS
    );
  } else if (m.preferTrend || m.preferSteadyCompounder) {
    const minH = m.minTokenAgeHours ?? 6;
    tokenAge = highIsBetter(age, minH * 0.5, minH * 4);
  } else if (m.preferDip) {
    tokenAge = nearIdeal(age, 18, 36);
  }

  // Volume
  let volume = 0.5;
  if (m.preferMomentumBurst || m.preferVolumeSpike || m.preferScalp) {
    volume = highIsBetter(volM5, 400, m.minVolumeM5Usd ?? 2_000);
  } else if (m.preferMigration) {
    volume = highIsBetter(volH1, 1_000, m.minVolumeH1Usd ?? 4_000);
  } else if (m.preferSteadyCompounder || m.preferTrend) {
    volume = highIsBetter(volH1, 2_000, m.minVolumeH1Usd ?? 10_000);
  } else {
    volume = highIsBetter(volH1 ?? volM5, 500, 5_000);
  }

  // Volatility / speed
  let volatility = 0.5;
  const speed = Math.max(
    Math.abs(chgH1 ?? 0),
    Math.abs(chg24 ?? 0) / 4,
    drop ?? 0
  );
  if (m.preferReversal) {
    volatility = highIsBetter(drop, 12, 35);
  } else if (m.preferMomentumBurst || m.preferScalp) {
    volatility = highIsBetter(speed, 5, 40);
  } else if (m.preferDip) {
    volatility = highIsBetter(drop, 10, 30);
  } else if (m.preferSteadyCompounder || m.preferHighWinRate) {
    volatility = lowIsBetter(speed, 3, 25);
  }

  // Market-cap fit already computed — crush Scalper affinity on larger tokens
  if (m.preferScalp || m.preferSmallMc) {
    if (mc != null && m.maxMarketCapUsd != null && mc > m.maxMarketCapUsd) {
      // Force near-zero so auto-score cannot pick Scalper on mid/high MC
      return {
        volume: 0.15,
        smartMoney: 0.35,
        tokenAge: 0.2,
        volatility: 0.2,
        supportFib: 0.2,
        chartPatterns: 0.15,
        migration: 0.2,
        liquidityHolders: 0.2,
        session: sessionAffinity(preferredSession),
      };
    }
  }

  // Crush Migration Sniper affinity on stale / mature PumpSwap tokens
  if (m.preferMigration && !isMig) {
    return {
      volume: 0.25,
      smartMoney: 0.35,
      tokenAge: 0.1,
      volatility: 0.25,
      supportFib: 0.25,
      chartPatterns: 0.2,
      migration: 0.05,
      liquidityHolders: 0.3,
      session: sessionAffinity(preferredSession),
    };
  }

  // Support / Fib
  let supportFib = 0.5;
  if (m.preferFibOrSupport || m.preferDip) {
    supportFib =
      ctx.nearKeyFib || ctx.nearSupport ? 1 : 0.25;
  } else if (m.preferReversal) {
    supportFib = drop != null && drop >= 15 ? 0.75 : 0.4;
  }

  // Chart pattern fit (primary / secondary + quality gates)
  const patternHits = Array.isArray(ctx.chartPatternHits)
    ? ctx.chartPatternHits
    : (Array.isArray(ctx.chartPatternIds)
        ? ctx.chartPatternIds.map((id) => ({
            id,
            confidence: 60,
            breakout: false,
          }))
        : []);
  const primaryIds = new Set(
    m.primaryPatternIds?.length
      ? m.primaryPatternIds
      : m.preferPatternIds || []
  );
  const secondaryIds = new Set(m.secondaryPatternIds || []);
  const sens = m.patternSensitivity || 'medium';
  const confFloor =
    m.patternMinConfidence != null
      ? Number(m.patternMinConfidence)
      : sens === 'high'
        ? 48
        : sens === 'low'
          ? 65
          : 55;

  let chartPatterns = 0.45;
  let hwrQualityBlocked = false;
  // HWR Quality Filter affinity — crush chartPatterns when technicals fail floors
  if (m.preferHighWinRate) {
    const qf = normalizeHwrQualityFilter(m.qualityFilter);
    const verdict = evaluateHwrQualityFilter(
      {
        symbol: ctx.symbol,
        marketCapUsd: ctx.marketCapUsd,
        liquidityUsd: ctx.liquidityUsd,
        volumeH1Usd: ctx.volumeH1Usd,
        holderCount: ctx.holderCount,
        nearKeyFib: ctx.nearKeyFib,
        nearSupport: ctx.nearSupport,
        chartPatternIds: ctx.chartPatternIds,
        chartPatternHits: patternHits,
      },
      qf
    );
    if (verdict.applicable && !verdict.pass) {
      hwrQualityBlocked = true;
      chartPatterns = qf.mode === 'reject' ? 0.05 : 0.15;
      if (ctx.nearKeyFib || ctx.nearSupport) {
        supportFib = Math.min(supportFib, 0.2);
      }
    } else if (verdict.applicable && verdict.soft) {
      chartPatterns = 0.45;
    } else if (verdict.applicable && verdict.pass) {
      chartPatterns = 0.75;
    }
  }
  if (!hwrQualityBlocked && (primaryIds.size || secondaryIds.size)) {
    if (!patternHits.length) {
      // No patterns detected — neutral-low; HWR stays selective
      chartPatterns =
        m.preferCleanPatterns || m.preferHighWinRate ? 0.28 : 0.42;
    } else {
      let best = 0;
      let anyGatedReject = false;
      for (const hit of patternHits) {
        const isPrimary = primaryIds.has(hit.id);
        const isSecondary = secondaryIds.has(hit.id);
        if (!isPrimary && !isSecondary) continue;

        if (hit.confidence < confFloor) {
          anyGatedReject = true;
          continue;
        }
        if (m.patternRequireBreakout && !hit.breakout) {
          if (
            hit.id !== 'structured_pullback' &&
            hit.id !== 'volume_dryup_return'
          ) {
            anyGatedReject = true;
            continue;
          }
        }
        if (
          m.patternRequireFibOrSupport &&
          hit.id === 'structured_pullback' &&
          !(ctx.nearKeyFib || ctx.nearSupport) &&
          (m.preferCleanPatterns || m.preferHighWinRate)
        ) {
          anyGatedReject = true;
          continue;
        }
        if (
          m.patternMinLiquidityUsd != null &&
          liq != null &&
          liq < m.patternMinLiquidityUsd
        ) {
          anyGatedReject = true;
          continue;
        }
        if (
          m.patternMinHolders != null &&
          holders != null &&
          holders < m.patternMinHolders
        ) {
          anyGatedReject = true;
          continue;
        }
        if (
          m.patternMinVolumeH1Usd != null &&
          volH1 != null &&
          volH1 < m.patternMinVolumeH1Usd
        ) {
          anyGatedReject = true;
          continue;
        }
        if (
          m.patternMinMarketCapUsd != null &&
          mc != null &&
          mc < m.patternMinMarketCapUsd &&
          (isSecondary || m.preferCleanPatterns || m.preferHighWinRate)
        ) {
          anyGatedReject = true;
          continue;
        }

        const confBoost = clamp01((hit.confidence - confFloor) / 35);
        const breakBoost = hit.breakout ? 0.15 : 0;
        const tier = isPrimary ? 0.72 : 0.48;
        best = Math.max(best, clamp01(tier + confBoost * 0.25 + breakBoost));
      }
      if (best > 0) {
        chartPatterns = best;
        if (m.preferCleanPatterns && best >= 0.7) {
          chartPatterns = clamp01(best + 0.08);
        }
      } else if (anyGatedReject && (m.preferCleanPatterns || m.preferHighWinRate)) {
        chartPatterns = 0.18;
      } else {
        chartPatterns = 0.38;
      }
    }
  } else if (m.preferBullishPatterns && patternHits.length) {
    const bullish = patternHits.filter((h) =>
      [
        'falling_wedge',
        'structured_pullback',
        'volume_dryup_return',
        'bull_flag',
        'trend_continuation',
        'ascending_triangle',
      ].includes(h.id)
    );
    chartPatterns = bullish.length
      ? clamp01(0.55 + bullish.length * 0.1)
      : 0.4;
  }

  // Soft Fib boost when structured pullback + near level (non-HWR already handled)
  if (
    patternHits.some((h) => h.id === 'structured_pullback') &&
    (ctx.nearKeyFib || ctx.nearSupport)
  ) {
    supportFib = Math.max(supportFib, 0.9);
  }

  // Smart money
  let smartMoney = 0.5;
  const smBlend =
    ((sm != null ? sm : 40) + (wq != null ? wq : 40)) / 2;
  if (
    m.preferSmartMoney ||
    m.preferSmartMoneyMirror ||
    m.preferHighWinRate
  ) {
    smartMoney = highIsBetter(smBlend, 35, 80);
    if (wallets != null && wallets >= (m.minWalletCount ?? 2)) {
      smartMoney = clamp01(smartMoney + 0.15);
    }
  } else {
    smartMoney = highIsBetter(smBlend, 20, 70);
  }

  // Migration
  let migration = 0.5;
  if (m.preferMigration) {
    migration = isMig ? 1 : 0.05;
  } else if (isMig && (m.preferScalp || m.preferMomentumBurst)) {
    migration = 0.35;
  } else if (isMig && (m.preferTrend || m.preferSteadyCompounder)) {
    migration = 0.15;
  } else {
    // Stale PumpSwap / near-mig should not suppress trend/HWR affinity
    migration = isMig ? 0.4 : 0.65;
  }

  // Holders
  let holdersFit = 0.5;
  if (m.preferTrend || m.preferSteadyCompounder) {
    holdersFit = highIsBetter(holders, m.minHolders ?? 60, (m.minHolders ?? 60) * 3);
  } else if (m.preferScalp || m.preferMigration || m.preferMomentumBurst) {
    holdersFit = lowIsBetter(holders, 20, 400);
  } else if (m.preferHighWinRate) {
    holdersFit = highIsBetter(holders, 40, 300);
  }

  // Liquidity
  let liquidity = highIsBetter(liq, 2_000, 40_000);
  if (m.preferHighWinRate || m.preferSteadyCompounder || m.preferTrend) {
    liquidity = highIsBetter(liq, 8_000, 80_000);
  } else if (m.preferScalp || m.preferMigration) {
    liquidity = nearIdeal(liq, 15_000, 40_000);
  }

  const sessionFit = sessionAffinity(preferredSession);

  // Token Age / Stage blends age + MC stage
  const tokenAgeStage = clamp01(tokenAge * 0.55 + marketCap * 0.45);
  // Liquidity + Holders combined
  const liquidityHolders = clamp01((holdersFit + liquidity) / 2);

  return {
    volume,
    smartMoney,
    tokenAge: tokenAgeStage,
    volatility,
    supportFib,
    chartPatterns,
    migration,
    liquidityHolders,
    session: sessionFit,
  };
}

export function combineAutoScore(
  weights: AutoScoringWeights,
  factors: Record<keyof AutoScoringWeights, number>,
  matchRaw: number,
  matchReason: string
): { score: number; reason: string; factors: Record<keyof AutoScoringWeights, number> } {
  const f = { ...factors };

  let wSum = 0;
  let acc = 0;
  for (const key of AUTO_SCORING_WEIGHT_KEYS) {
    const w = Number(weights[key]);
    if (!Number.isFinite(w) || w <= 0) continue;
    wSum += w;
    acc += w * clamp01(f[key] ?? 0);
  }
  const affinity =
    wSum > 0 ? clamp01(acc / wSum) : 0;
  // Specialty match strength must matter — ignoring matchRaw made soft affinities
  // dominate and over-favored Migration Sniper whenever migrationFresh was sticky.
  const matchFit = clamp01(Number(matchRaw) / 110);
  const blended = affinity * 0.55 + matchFit * 0.45;
  const score = Math.round(blended * 1000) / 10;

  const topFactors = AUTO_SCORING_WEIGHT_KEYS
    .map((k) => [k, f[k] ?? 0] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${AUTO_SCORING_WEIGHT_LABELS[k]} ${(v * 100).toFixed(0)}`)
    .join(', ');

  const reasonParts = [
    matchReason || 'match',
    `matchFit ${(matchFit * 100).toFixed(0)}`,
    topFactors ? `factors: ${topFactors}` : null,
  ].filter(Boolean);

  return { score, reason: reasonParts.join(' · '), factors: f };
}

function looksLikeLegacyDefaultWeights(w: Record<string, unknown>): boolean {
  // Prior shipped defaults: matchFit 40 + volume 12
  if (Number(w.matchFit) === 40 && Number(w.volume) === 12) return true;
  // Pre-chartPatterns official defaults (sum 100, no chartPatterns key)
  return (
    Number(w.volume) === 22 &&
    Number(w.smartMoney) === 18 &&
    Number(w.supportFib) === 12 &&
    w.chartPatterns == null
  );
}

export function normalizeAutoScoringConfig(
  raw: Partial<AutoScoringConfig> | null | undefined
): AutoScoringConfig {
  const base = {
    ...DEFAULT_AUTO_SCORING,
    weights: { ...DEFAULT_AUTO_SCORING_WEIGHTS },
  };
  if (!raw || typeof raw !== 'object') return base;
  if (typeof raw.enabled === 'boolean') base.enabled = raw.enabled;
  if (raw.minScore != null && Number.isFinite(Number(raw.minScore))) {
    base.minScore = Math.max(0, Math.min(100, Number(raw.minScore)));
  }
  if (typeof raw.skipBelowMin === 'boolean') {
    base.skipBelowMin = raw.skipBelowMin;
  }
  if (raw.forceProfileId === null) {
    base.forceProfileId = null;
  } else if (
    typeof raw.forceProfileId === 'string' &&
    raw.forceProfileId.length > 0
  ) {
    base.forceProfileId = raw.forceProfileId as TradeProfileId;
  }
  if (raw.weights && typeof raw.weights === 'object') {
    const rw = raw.weights as unknown as Record<string, unknown>;
    if (looksLikeLegacyDefaultWeights(rw)) {
      // Upgrade old built-in defaults → official % weights
      base.weights = { ...DEFAULT_AUTO_SCORING_WEIGHTS };
    } else {
      for (const key of AUTO_SCORING_WEIGHT_KEYS) {
        const v = Number(rw[key]);
        if (Number.isFinite(v) && v >= 0) base.weights[key] = v;
      }
      // Migrate split holders/liquidity → combined if needed
      if (
        (base.weights.liquidityHolders == null ||
          !Number.isFinite(Number(rw.liquidityHolders))) &&
        (rw.holders != null || rw.liquidity != null)
      ) {
        const h = Number(rw.holders);
        const l = Number(rw.liquidity);
        base.weights.liquidityHolders =
          (Number.isFinite(h) ? h : 0) + (Number.isFinite(l) ? l : 0);
      }
      // Inject chartPatterns weight when missing from older saved configs
      if (!Number.isFinite(Number(rw.chartPatterns))) {
        base.weights.chartPatterns =
          DEFAULT_AUTO_SCORING_WEIGHTS.chartPatterns;
      }
    }
  }
  return base;
}
