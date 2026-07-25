/**
 * High Win-Rate Quality Filter — stricter gates when HWR evaluates
 * technical patterns (chart patterns, Fib, support).
 * Other profiles keep their normal sensitivity.
 */

export interface HighWinRateQualityFilter {
  /** Master switch — when false, HWR uses base pattern match only */
  enabled: boolean;
  /**
   * reject = HWR score 0 when technicals present but below floors
   * penalize = keep scoring but subtract weakSetupPenalty
   */
  mode: 'reject' | 'penalize';
  /** Hard floor — below this is low-MC noise */
  minMarketCapUsd: number;
  /** Prefer / bonus band — above this is higher-quality MC */
  preferMarketCapUsd: number;
  minLiquidityUsd: number;
  minVolumeH1Usd: number;
  minHolders: number;
  /** Score subtracted in penalize mode (or half when only soft-fail) */
  weakSetupPenalty: number;
  /** When true, Fib/support technicals also require quality floors */
  applyToFibSupport: boolean;
  /** Prefer Fib or strong support on pullback-style technicals */
  preferFibOrSupport: boolean;
  /** Min pattern confidence for HWR technical hits */
  minPatternConfidence: number;
  /** Soft bonus when all prefer floors are met */
  cleanSetupBonus: number;
}

/** Official defaults — selective, higher MC / liquidity / volume / holders */
export const DEFAULT_HWR_QUALITY_FILTER: HighWinRateQualityFilter = {
  enabled: true,
  mode: 'reject',
  minMarketCapUsd: 200_000,
  preferMarketCapUsd: 400_000,
  minLiquidityUsd: 12_000,
  minVolumeH1Usd: 6_000,
  minHolders: 80,
  weakSetupPenalty: 40,
  applyToFibSupport: true,
  preferFibOrSupport: true,
  minPatternConfidence: 68,
  cleanSetupBonus: 10,
};

export interface HwrQualityContext {
  symbol?: string;
  marketCapUsd?: number | null;
  liquidityUsd?: number | null;
  volumeH1Usd?: number | null;
  holderCount?: number | null;
  nearKeyFib?: boolean;
  nearSupport?: boolean;
  chartPatternIds?: string[] | null;
  chartPatternHits?: Array<{
    id: string;
    confidence: number;
    breakout: boolean;
  }> | null;
}

export interface HwrQualityVerdict {
  /** Hard floors passed (or filter disabled / not applicable) */
  pass: boolean;
  /** Above mins but below prefer band */
  soft: boolean;
  /** Filter was applicable (technicals present) */
  applicable: boolean;
  reasons: string[];
  /** Human summary for logs */
  summary: string;
}

function num(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) ? Number(v) : null;
}

export function normalizeHwrQualityFilter(
  raw: Partial<HighWinRateQualityFilter> | null | undefined
): HighWinRateQualityFilter {
  const base: HighWinRateQualityFilter = { ...DEFAULT_HWR_QUALITY_FILTER };
  if (!raw || typeof raw !== 'object') return base;
  if (typeof raw.enabled === 'boolean') base.enabled = raw.enabled;
  if (raw.mode === 'reject' || raw.mode === 'penalize') base.mode = raw.mode;
  if (typeof raw.applyToFibSupport === 'boolean') {
    base.applyToFibSupport = raw.applyToFibSupport;
  }
  if (typeof raw.preferFibOrSupport === 'boolean') {
    base.preferFibOrSupport = raw.preferFibOrSupport;
  }
  const intKeys: Array<keyof HighWinRateQualityFilter> = [
    'minMarketCapUsd',
    'preferMarketCapUsd',
    'minLiquidityUsd',
    'minVolumeH1Usd',
    'minHolders',
    'weakSetupPenalty',
    'minPatternConfidence',
    'cleanSetupBonus',
  ];
  for (const k of intKeys) {
    const v = Number(raw[k]);
    if (Number.isFinite(v) && v >= 0) {
      (base as unknown as Record<string, unknown>)[k] = v;
    }
  }
  if (base.preferMarketCapUsd < base.minMarketCapUsd) {
    base.preferMarketCapUsd = base.minMarketCapUsd;
  }
  if (base.minPatternConfidence > 95) base.minPatternConfidence = 95;
  return base;
}

/** True when the setup has technical pattern / Fib / support context */
export function hasHwrTechnicalContext(ctx: HwrQualityContext): boolean {
  const hits = Array.isArray(ctx.chartPatternHits)
    ? ctx.chartPatternHits
    : [];
  const ids = Array.isArray(ctx.chartPatternIds) ? ctx.chartPatternIds : [];
  if (hits.length > 0 || ids.length > 0) return true;
  if (ctx.nearKeyFib || ctx.nearSupport) return true;
  return false;
}

/**
 * Evaluate HWR quality floors against MC / liquidity / volume / holders.
 * Does not run when filter disabled or no technical context.
 */
export function evaluateHwrQualityFilter(
  ctx: HwrQualityContext,
  filterInput?: Partial<HighWinRateQualityFilter> | null
): HwrQualityVerdict {
  const filter = normalizeHwrQualityFilter(filterInput);
  const applicable = hasHwrTechnicalContext(ctx);

  if (!filter.enabled || !applicable) {
    return {
      pass: true,
      soft: false,
      applicable: false,
      reasons: [],
      summary: 'n/a',
    };
  }

  // Fib/support-only setups: optional skip via applyToFibSupport
  const onlyFibSupport =
    !(
      (Array.isArray(ctx.chartPatternHits) && ctx.chartPatternHits.length) ||
      (Array.isArray(ctx.chartPatternIds) && ctx.chartPatternIds.length)
    ) &&
    Boolean(ctx.nearKeyFib || ctx.nearSupport);
  if (onlyFibSupport && !filter.applyToFibSupport) {
    return {
      pass: true,
      soft: false,
      applicable: false,
      reasons: [],
      summary: 'fib/support exempt',
    };
  }

  const mc = num(ctx.marketCapUsd);
  const liq = num(ctx.liquidityUsd);
  const vol = num(ctx.volumeH1Usd);
  const holders = num(ctx.holderCount);
  const hard: string[] = [];
  const soft: string[] = [];

  if (mc != null && mc < filter.minMarketCapUsd) {
    hard.push(`MC $${Math.round(mc)} < $${filter.minMarketCapUsd}`);
  } else if (
    mc != null &&
    mc < filter.preferMarketCapUsd &&
    mc >= filter.minMarketCapUsd
  ) {
    soft.push(`MC $${Math.round(mc)} < prefer $${filter.preferMarketCapUsd}`);
  }

  if (liq != null && liq < filter.minLiquidityUsd) {
    hard.push(`liq $${Math.round(liq)} < $${filter.minLiquidityUsd}`);
  }

  if (vol != null && vol < filter.minVolumeH1Usd) {
    hard.push(`vol1h $${Math.round(vol)} < $${filter.minVolumeH1Usd}`);
  }

  if (holders != null && holders < filter.minHolders) {
    hard.push(`holders ${holders} < ${filter.minHolders}`);
  }

  if (
    filter.preferFibOrSupport &&
    ((Array.isArray(ctx.chartPatternIds) &&
      ctx.chartPatternIds.includes('structured_pullback')) ||
      (Array.isArray(ctx.chartPatternHits) &&
        ctx.chartPatternHits.some((h) => h.id === 'structured_pullback')))
  ) {
    if (!(ctx.nearKeyFib || ctx.nearSupport)) {
      hard.push('structured pullback needs Fib/support');
    }
  }

  const pass = hard.length === 0;
  const isSoft = pass && soft.length > 0;
  const reasons = pass ? soft : hard;
  const summary = reasons.length
    ? reasons.join('; ')
    : 'clean higher-MC setup';

  return {
    pass,
    soft: isSoft,
    applicable: true,
    reasons,
    summary,
  };
}

/** Console + optional strategy-style log when HWR Quality Filter rejects */
export function logHwrQualityFilterReject(
  ctx: HwrQualityContext,
  verdict: HwrQualityVerdict,
  detail?: string
): void {
  const sym = ctx.symbol || 'token';
  const line =
    `[hwr-quality] REJECTED ${sym} — Quality Filter: ${verdict.summary}` +
    (detail ? ` (${detail})` : '');
  console.log(line);
}

export function logHwrQualityFilterSoft(
  ctx: HwrQualityContext,
  verdict: HwrQualityVerdict
): void {
  const sym = ctx.symbol || 'token';
  console.log(
    `[hwr-quality] SOFT ${sym} — below prefer band: ${verdict.summary}`
  );
}
