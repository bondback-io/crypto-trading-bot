/**
 * Smarter trade profiles — scoreboard, adaptive exit policies, learning nudges,
 * and stabilized entry tightenments for quality profiles.
 */

import { classifyExitKey, type ExitMixKey } from './soakMetrics';
import type { TradeProfileId, TradeProfileExitRules } from './tradeProfiles';

/** Avoid circular import with paperTrader — keep partial slices out of scoreboard. */
function representativeClosed<T extends { reason?: string; closedAt?: number }>(
  closed: T[]
): T[] {
  const finals = closed.filter(
    (p) => !/^partial:/i.test(String(p.reason || ''))
  );
  return finals.length > 0 ? finals : closed;
}

export interface ProfileExitPolicy {
  /** Take a partial at this unrealized % (0 = off) */
  earlyPartialTpPct: number;
  /** Fraction of remaining size to sell on early partial (0–1) */
  earlyPartialFraction: number;
  /** After trail arms, tighten trail stop by this factor (<1 = tighter) */
  trailTightenFactor: number;
  /** Exit when price drops this % from peak while green but before full TP */
  momentumFadeDropPct: number;
  /** Prefer aggressive dead-market (shorter min hold) */
  aggressiveDeadMarket: boolean;
  /** Exit on sustained quality breakdown while still green (HWR-style) */
  qualityBreakdownExit: boolean;
  /**
   * Profit-lock: arm after peak unrealized PnL % reaches this.
   * 0 = off. Example: 80 means lock logic starts once trade was +80%.
   */
  profitLockArmPct: number;
  /**
   * Once armed: full exit if unrealized falls this many percentage points
   * from peak (80% → 50% = 30 pts giveback).
   */
  profitGivebackPts: number;
  /**
   * Optional absolute floor once armed (never let unrealized fall below this %).
   * 0 = off.
   */
  profitFloorPct: number;
  /**
   * Peak Profit Protection — arm at this % of target TP (0 = use global default).
   */
  peakProtectArmOfTpPct: number;
  /**
   * Peak Profit Protection — exit when giveback reaches this % of peak
   * (0 = use global default).
   */
  peakProtectGivebackOfPeakPct: number;
  /** Swing bots: defer soft timer when Fib/support/pattern still valid */
  extendHoldIfTaOk: boolean;
  /** Swing bots: full exit when structure breaks while still green */
  cutIfStructureBroken: boolean;
  /**
   * Swing bots: exit on confirmed Heikin-Ashi red flip after ≥2 green HA.
   * Default true for trend_rider / steady_compounder / high_win_rate.
   */
  heikinAshiExitEnabled: boolean;
}

export const DEFAULT_EXIT_POLICIES: Record<string, ProfileExitPolicy> = {
  scalper: {
    earlyPartialTpPct: 13,
    earlyPartialFraction: 0.55,
    trailTightenFactor: 0.7,
    momentumFadeDropPct: 5,
    aggressiveDeadMarket: true,
    qualityBreakdownExit: false,
    profitLockArmPct: 28,
    profitGivebackPts: 14,
    profitFloorPct: 0,
    peakProtectArmOfTpPct: 60,
    peakProtectGivebackOfPeakPct: 40,
    extendHoldIfTaOk: false,
    cutIfStructureBroken: false,
    heikinAshiExitEnabled: false,
  },
  reversal_scalper: {
    earlyPartialTpPct: 12,
    earlyPartialFraction: 0.55,
    trailTightenFactor: 0.65,
    momentumFadeDropPct: 5,
    aggressiveDeadMarket: true,
    qualityBreakdownExit: false,
    profitLockArmPct: 22,
    profitGivebackPts: 12,
    profitFloorPct: 0,
    peakProtectArmOfTpPct: 60,
    peakProtectGivebackOfPeakPct: 40,
    extendHoldIfTaOk: false,
    cutIfStructureBroken: false,
    heikinAshiExitEnabled: false,
  },
  momentum_burst: {
    earlyPartialTpPct: 18,
    earlyPartialFraction: 0.4,
    trailTightenFactor: 0.75,
    momentumFadeDropPct: 6,
    aggressiveDeadMarket: true,
    qualityBreakdownExit: false,
    profitLockArmPct: 35,
    profitGivebackPts: 18,
    profitFloorPct: 0,
    peakProtectArmOfTpPct: 60,
    peakProtectGivebackOfPeakPct: 40,
    extendHoldIfTaOk: false,
    cutIfStructureBroken: false,
    heikinAshiExitEnabled: false,
  },
  dip_buyer: {
    earlyPartialTpPct: 15,
    earlyPartialFraction: 0.3,
    trailTightenFactor: 0.85,
    momentumFadeDropPct: 8,
    aggressiveDeadMarket: false,
    qualityBreakdownExit: false,
    profitLockArmPct: 40,
    profitGivebackPts: 22,
    profitFloorPct: 8,
    peakProtectArmOfTpPct: 65,
    peakProtectGivebackOfPeakPct: 45,
    extendHoldIfTaOk: true,
    cutIfStructureBroken: true,
    heikinAshiExitEnabled: false,
  },
  trend_rider: {
    earlyPartialTpPct: 18,
    earlyPartialFraction: 0.3,
    trailTightenFactor: 0.9,
    momentumFadeDropPct: 10,
    aggressiveDeadMarket: false,
    qualityBreakdownExit: false,
    profitLockArmPct: 25,
    profitGivebackPts: 12,
    profitFloorPct: 5,
    peakProtectArmOfTpPct: 65,
    peakProtectGivebackOfPeakPct: 45,
    extendHoldIfTaOk: true,
    cutIfStructureBroken: true,
    heikinAshiExitEnabled: true,
  },
  steady_compounder: {
    earlyPartialTpPct: 15,
    earlyPartialFraction: 0.3,
    trailTightenFactor: 0.85,
    momentumFadeDropPct: 7,
    aggressiveDeadMarket: false,
    qualityBreakdownExit: true,
    profitLockArmPct: 18,
    profitGivebackPts: 8,
    profitFloorPct: 3,
    peakProtectArmOfTpPct: 65,
    peakProtectGivebackOfPeakPct: 45,
    extendHoldIfTaOk: true,
    cutIfStructureBroken: true,
    heikinAshiExitEnabled: true,
  },
  high_win_rate: {
    earlyPartialTpPct: 20,
    earlyPartialFraction: 0.3,
    trailTightenFactor: 0.8,
    momentumFadeDropPct: 8,
    aggressiveDeadMarket: false,
    qualityBreakdownExit: true,
    profitLockArmPct: 45,
    profitGivebackPts: 20,
    profitFloorPct: 10,
    peakProtectArmOfTpPct: 65,
    peakProtectGivebackOfPeakPct: 45,
    extendHoldIfTaOk: true,
    cutIfStructureBroken: true,
    heikinAshiExitEnabled: true,
  },
  smart_money_mirror: {
    earlyPartialTpPct: 15,
    earlyPartialFraction: 0.3,
    trailTightenFactor: 0.85,
    momentumFadeDropPct: 9,
    aggressiveDeadMarket: false,
    qualityBreakdownExit: false,
    profitLockArmPct: 40,
    profitGivebackPts: 22,
    profitFloorPct: 8,
    peakProtectArmOfTpPct: 65,
    peakProtectGivebackOfPeakPct: 45,
    extendHoldIfTaOk: false,
    cutIfStructureBroken: false,
    heikinAshiExitEnabled: false,
  },
  migration_sniper: {
    earlyPartialTpPct: 16,
    earlyPartialFraction: 0.4,
    trailTightenFactor: 0.7,
    momentumFadeDropPct: 6,
    aggressiveDeadMarket: true,
    qualityBreakdownExit: false,
    profitLockArmPct: 30,
    profitGivebackPts: 16,
    profitFloorPct: 0,
    peakProtectArmOfTpPct: 60,
    peakProtectGivebackOfPeakPct: 40,
    extendHoldIfTaOk: false,
    cutIfStructureBroken: false,
    heikinAshiExitEnabled: false,
  },
  default: {
    earlyPartialTpPct: 0,
    earlyPartialFraction: 0,
    trailTightenFactor: 1,
    momentumFadeDropPct: 0,
    aggressiveDeadMarket: false,
    qualityBreakdownExit: false,
    profitLockArmPct: 0,
    profitGivebackPts: 0,
    profitFloorPct: 0,
    peakProtectArmOfTpPct: 0,
    peakProtectGivebackOfPeakPct: 0,
    extendHoldIfTaOk: false,
    cutIfStructureBroken: false,
    heikinAshiExitEnabled: false,
  },
};

export function resolveExitPolicy(
  profileId: string | null | undefined,
  rules?: TradeProfileExitRules | null,
  opts?: {
    armedWatch?: boolean;
    entryStyle?: string | null;
    entryQualityScore?: number | null;
    qualityTier?: 'low' | 'medium' | 'high' | null;
  }
): ProfileExitPolicy {
  const base =
    DEFAULT_EXIT_POLICIES[String(profileId || 'default')] ||
    DEFAULT_EXIT_POLICIES.default;
  let earlyPartialTpPct = base.earlyPartialTpPct;
  let earlyPartialFraction = base.earlyPartialFraction;
  // Wire PCL family / Self-Learn early-partial defaults when exitPolicy omits them
  try {
    const { resolvePclPartialDefaults, isProfitCaptureLayerEnabled } =
      require('./profitCaptureLayer') as typeof import('./profitCaptureLayer');
    if (isProfitCaptureLayerEnabled()) {
      const pcl = resolvePclPartialDefaults(profileId, {
        armedWatch: opts?.armedWatch === true,
        entryStyle: opts?.entryStyle,
        entryQualityScore: opts?.entryQualityScore,
        qualityTier: opts?.qualityTier,
      });
      earlyPartialTpPct = pcl.earlyPartialTpPct;
      earlyPartialFraction = pcl.earlyPartialFraction;
    }
  } catch {
    /* fail soft */
  }
  const ep = rules?.exitPolicy;
  if (!ep || typeof ep !== 'object') {
    return { ...base, earlyPartialTpPct, earlyPartialFraction };
  }
  return {
    earlyPartialTpPct:
      ep.earlyPartialTpPct != null && Number.isFinite(Number(ep.earlyPartialTpPct))
        ? Math.max(0, Number(ep.earlyPartialTpPct))
        : earlyPartialTpPct,
    earlyPartialFraction:
      ep.earlyPartialFraction != null &&
      Number.isFinite(Number(ep.earlyPartialFraction))
        ? Math.min(0.9, Math.max(0, Number(ep.earlyPartialFraction)))
        : earlyPartialFraction,
    trailTightenFactor:
      ep.trailTightenFactor != null &&
      Number.isFinite(Number(ep.trailTightenFactor))
        ? Math.min(1, Math.max(0.4, Number(ep.trailTightenFactor)))
        : base.trailTightenFactor,
    momentumFadeDropPct:
      ep.momentumFadeDropPct != null &&
      Number.isFinite(Number(ep.momentumFadeDropPct))
        ? Math.max(0, Number(ep.momentumFadeDropPct))
        : base.momentumFadeDropPct,
    aggressiveDeadMarket:
      typeof ep.aggressiveDeadMarket === 'boolean'
        ? ep.aggressiveDeadMarket
        : base.aggressiveDeadMarket,
    qualityBreakdownExit:
      typeof ep.qualityBreakdownExit === 'boolean'
        ? ep.qualityBreakdownExit
        : base.qualityBreakdownExit,
    profitLockArmPct:
      ep.profitLockArmPct != null && Number.isFinite(Number(ep.profitLockArmPct))
        ? Math.max(0, Number(ep.profitLockArmPct))
        : base.profitLockArmPct,
    profitGivebackPts:
      ep.profitGivebackPts != null &&
      Number.isFinite(Number(ep.profitGivebackPts))
        ? Math.max(0, Number(ep.profitGivebackPts))
        : base.profitGivebackPts,
    profitFloorPct:
      ep.profitFloorPct != null && Number.isFinite(Number(ep.profitFloorPct))
        ? Math.max(0, Number(ep.profitFloorPct))
        : base.profitFloorPct,
    peakProtectArmOfTpPct:
      ep.peakProtectArmOfTpPct != null &&
      Number.isFinite(Number(ep.peakProtectArmOfTpPct))
        ? Math.max(0, Number(ep.peakProtectArmOfTpPct))
        : base.peakProtectArmOfTpPct,
    peakProtectGivebackOfPeakPct:
      ep.peakProtectGivebackOfPeakPct != null &&
      Number.isFinite(Number(ep.peakProtectGivebackOfPeakPct))
        ? Math.max(0, Number(ep.peakProtectGivebackOfPeakPct))
        : base.peakProtectGivebackOfPeakPct,
    extendHoldIfTaOk:
      typeof ep.extendHoldIfTaOk === 'boolean'
        ? ep.extendHoldIfTaOk
        : base.extendHoldIfTaOk,
    cutIfStructureBroken:
      typeof ep.cutIfStructureBroken === 'boolean'
        ? ep.cutIfStructureBroken
        : base.cutIfStructureBroken,
    heikinAshiExitEnabled:
      typeof ep.heikinAshiExitEnabled === 'boolean'
        ? ep.heikinAshiExitEnabled
        : base.heikinAshiExitEnabled,
  };
}

export interface ProfileScoreboardRow {
  profileId: string;
  name: string;
  icon: string;
  color: string;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  netPnlSol: number;
  avgPnlPct: number;
  avgHoldSec: number;
  exitMix: Array<{ key: ExitMixKey; label: string; count: number; pct: number }>;
  /** Enough sample to trust learning / stabilize entries */
  stabilized: boolean;
}

export interface TradeProfileScoreboard {
  rows: ProfileScoreboardRow[];
  totalClosed: number;
  capturedAt: number;
  minSampleForStabilize: number;
}

const MIN_SAMPLE_STABILIZE = 12;

type ClosedLike = {
  tradeProfileId?: string;
  tradeProfileName?: string;
  tradeProfileIcon?: string;
  tradeProfileColor?: string;
  pnlSol?: number;
  pnlPct?: number;
  openedAt?: number;
  closedAt?: number;
  reason?: string;
  status?: string;
};

export function buildTradeProfileScoreboard(
  closedRaw: ClosedLike[],
  catalog: Array<{
    id: string;
    name: string;
    icon: string;
    color: string;
  }>
): TradeProfileScoreboard {
  const closed = representativeClosed(closedRaw);
  const byId = new Map<
    string,
    {
      trades: ClosedLike[];
      meta: { name: string; icon: string; color: string };
    }
  >();

  for (const p of catalog) {
    byId.set(p.id, {
      trades: [],
      meta: { name: p.name, icon: p.icon, color: p.color },
    });
  }

  for (const t of closed) {
    const id = String(t.tradeProfileId || 'default');
    let bucket = byId.get(id);
    if (!bucket) {
      bucket = {
        trades: [],
        meta: {
          name: t.tradeProfileName || id,
          icon: t.tradeProfileIcon || '•',
          color: t.tradeProfileColor || '#94a3b8',
        },
      };
      byId.set(id, bucket);
    }
    bucket.trades.push(t);
  }

  const rows: ProfileScoreboardRow[] = [];
  for (const [profileId, bucket] of byId) {
    const trades = bucket.trades;
    if (trades.length === 0 && !catalog.some((c) => c.id === profileId)) {
      continue;
    }
    const wins = trades.filter((t) => (t.pnlSol ?? 0) > 0);
    const losses = trades.filter((t) => (t.pnlSol ?? 0) <= 0);
    const netPnlSol = trades.reduce((s, t) => s + (t.pnlSol ?? 0), 0);
    const avgPnlPct =
      trades.length > 0
        ? trades.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / trades.length
        : 0;
    const holds = trades
      .filter((t) => t.closedAt && t.openedAt)
      .map((t) => (t.closedAt! - t.openedAt!) / 1000);
    const avgHoldSec =
      holds.length > 0 ? holds.reduce((a, b) => a + b, 0) / holds.length : 0;

    const mixCounts = new Map<ExitMixKey, { label: string; count: number }>();
    for (const t of trades) {
      const { key, label } = classifyExitKey(t.reason);
      const cur = mixCounts.get(key) || { label, count: 0 };
      cur.count += 1;
      mixCounts.set(key, cur);
    }
    const exitMix = [...mixCounts.entries()]
      .map(([key, v]) => ({
        key,
        label: v.label,
        count: v.count,
        pct: trades.length > 0 ? (v.count / trades.length) * 100 : 0,
      }))
      .sort((a, b) => b.count - a.count);

    rows.push({
      profileId,
      name: bucket.meta.name,
      icon: bucket.meta.icon,
      color: bucket.meta.color,
      trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRatePct:
        trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
      netPnlSol,
      avgPnlPct,
      avgHoldSec,
      exitMix,
      stabilized: trades.length >= MIN_SAMPLE_STABILIZE,
    });
  }

  rows.sort((a, b) => b.trades - a.trades || a.name.localeCompare(b.name));

  return {
    rows,
    totalClosed: closed.length,
    capturedAt: Date.now(),
    minSampleForStabilize: MIN_SAMPLE_STABILIZE,
  };
}

export interface AdaptiveExitAction {
  type: 'none' | 'partial' | 'full' | 'tighten_trail';
  reason?: string;
  fraction?: number;
  newTrailingStopPct?: number;
}

/**
 * Apply quality-tier multipliers so low-conviction trades extract profit fast
 * and high-conviction trades trail wider for larger runners.
 * Valid entry styles stretch high-tier further; late_chase tightens.
 */
function applyQualityTierMultipliers(
  pol: ProfileExitPolicy,
  tier: 'low' | 'medium' | 'high',
  opts?: {
    entryStyle?: string | null;
    lateChaseAtEntry?: boolean;
    armedWatch?: boolean;
  }
): ProfileExitPolicy {
  const late = opts?.lateChaseAtEntry === true;
  const style = String(opts?.entryStyle || '');
  const validStyle =
    style.length > 0 &&
    style !== 'late_chase' &&
    style !== 'unknown' &&
    !late;
  const armed =
    opts?.armedWatch === true ||
    /scalp_reclaim|support_dip_reclaim/i.test(style);
  // Armed / medium-high reclaim harvest retune
  if (armed && !late) {
    pol.earlyPartialTpPct = 9;
    pol.earlyPartialFraction = 0.45;
    pol.peakProtectArmOfTpPct = Math.max(pol.peakProtectArmOfTpPct || 0, 75);
    return pol;
  }
  if (tier === 'medium' && !late) {
    if (validStyle && /reclaim/i.test(style)) {
      pol.earlyPartialTpPct = clampNum(pol.earlyPartialTpPct, 8, 10);
      pol.earlyPartialFraction = clampNum(pol.earlyPartialFraction, 0.4, 0.5);
      pol.peakProtectArmOfTpPct = Math.max(pol.peakProtectArmOfTpPct || 0, 75);
    }
    return pol;
  }
  if (tier === 'low' || late) {
    pol.profitGivebackPts = Math.max(4, Math.round(pol.profitGivebackPts * 0.6));
    pol.earlyPartialTpPct = pol.earlyPartialTpPct > 0
      ? Math.max(4, Math.round(pol.earlyPartialTpPct * 0.7))
      : pol.earlyPartialTpPct;
    pol.earlyPartialFraction = Math.min(0.65, pol.earlyPartialFraction * 1.3);
    pol.profitLockArmPct = pol.profitLockArmPct > 0
      ? Math.max(8, Math.round(pol.profitLockArmPct * 0.7))
      : pol.profitLockArmPct;
    pol.extendHoldIfTaOk = false;
    return pol;
  }
  // high
  pol.profitGivebackPts = Math.min(60, Math.round(pol.profitGivebackPts * 1.25));
  pol.extendHoldIfTaOk = true;
  if (validStyle) {
    pol.earlyPartialTpPct = 9;
    pol.earlyPartialFraction = clampNum(0.45, 0.4, 0.5);
    pol.peakProtectArmOfTpPct = Math.max(pol.peakProtectArmOfTpPct || 0, 75);
    pol.profitGivebackPts = Math.min(
      60,
      Math.round(pol.profitGivebackPts * 1.1)
    );
  }
  return pol;
}

function clampNum(n: number, lo: number, hi: number): number {
  if (!(n > 0)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Adaptive exit brain for a live position (profile-stamped policy).
 */
export function evaluateAdaptiveProfileExit(input: {
  policy: ProfileExitPolicy;
  pnlPct: number;
  entryPriceSol: number;
  currentPriceSol: number;
  highWaterMarkSol: number;
  trailingActive: boolean;
  trailingStopPct: number;
  partialSellDone?: boolean;
  bagTrimDone?: boolean;
  takeProfitPct: number;
  /** Peak drop already used for scalp momentum — optional */
  convictionScore?: number;
  openedAt: number;
  nowMs?: number;
  /** Peak unrealized PnL % since entry (from HWM); derived if omitted */
  peakUnrealizedPct?: number;
  /** TA structure still intact (Fib/support/pattern) — swing hold extend */
  taStructureOk?: boolean;
  /** Structure broken — swing cut */
  taStructureBroken?: boolean;
  /** Soft timer would fire — allow defer when extendHoldIfTaOk */
  softTimerDue?: boolean;
  /** Quality tier from conviction at entry — drives dynamic TP aggression */
  qualityTier?: 'low' | 'medium' | 'high';
  tradeProfileId?: string | null;
  peakProtectArmedAt?: number | null;
  peakProtectLastPeakAt?: number | null;
  /** Volume Intelligence decay / divergence for soft exit urgency */
  volumeDecayState?:
    | 'expanding'
    | 'stable'
    | 'decaying'
    | 'collapsed'
    | null;
  volumeDivergenceState?:
    | 'bullish_divergence'
    | 'bearish_divergence'
    | 'confirming'
    | 'none'
    | 'insufficient'
    | null;
  volumeExitTightenMult?: number | null;
  /** Profit Capture Layer stamps */
  profitPermissionUntilMs?: number | null;
  entryQualityScore?: number | null;
  pclPartialTaken?: boolean;
  entryStyle?: string | null;
  lateChaseAtEntry?: boolean;
  armedWatch?: boolean;
  /** Influencer Mirror position stamps — exit preference vs PPP */
  mint?: string | null;
  mirrorWalletId?: string | null;
}): AdaptiveExitAction {
  const now = input.nowMs ?? Date.now();
  const tier = input.qualityTier || 'medium';
  const pol = applyQualityTierMultipliers({ ...input.policy }, tier, {
    entryStyle: input.entryStyle,
    lateChaseAtEntry: input.lateChaseAtEntry,
    armedWatch: input.armedWatch === true,
  });
  const pnl = input.pnlPct;
  const peakUnrealized =
    input.peakUnrealizedPct != null && Number.isFinite(input.peakUnrealizedPct)
      ? Number(input.peakUnrealizedPct)
      : input.entryPriceSol > 0 && input.highWaterMarkSol > 0
        ? ((input.highWaterMarkSol - input.entryPriceSol) /
            input.entryPriceSol) *
          100
        : Math.max(0, pnl);

  let pclOn = false;
  let permActive = false;
  try {
    const {
      isProfitCaptureLayerEnabled,
      isProfitPermissionActive,
      permissionFadeThresholdMult,
      shouldBlockTinyGreenScratch,
    } = require('./profitCaptureLayer') as typeof import('./profitCaptureLayer');
    pclOn = isProfitCaptureLayerEnabled();
    permActive =
      pclOn &&
      isProfitPermissionActive({
        profitPermissionUntilMs: input.profitPermissionUntilMs,
        nowMs: now,
      });
    // Scratch block helper kept for fade/quality soft exits below
    void permissionFadeThresholdMult;
    void shouldBlockTinyGreenScratch;
  } catch {
    pclOn = false;
    permActive = false;
  }

  // PCL priority: meaningful partial BEFORE PPP while harvesting
  const tryEarlyPartial = (): AdaptiveExitAction | null => {
    if (
      pol.earlyPartialTpPct > 0 &&
      pol.earlyPartialFraction > 0 &&
      !input.partialSellDone &&
      !input.bagTrimDone &&
      !input.pclPartialTaken &&
      pnl >= pol.earlyPartialTpPct &&
      pnl < input.takeProfitPct
    ) {
      return {
        type: 'partial',
        fraction: pol.earlyPartialFraction,
        reason: pclOn
          ? `partial TP (PCL) @ +${pnl.toFixed(1)}% (policy ${pol.earlyPartialTpPct}%, bank ${(pol.earlyPartialFraction * 100).toFixed(0)}%)`
          : `Profile early partial @ +${pnl.toFixed(1)}% (policy ${pol.earlyPartialTpPct}%)`,
      };
    }
    return null;
  };

  if (pclOn) {
    const partialFirst = tryEarlyPartial();
    if (partialFirst) return partialFirst;
  }

  // 1a) Peak Profit Protection (TP-relative arm + proportional giveback)
  try {
    const { evaluatePeakProfitProtection, getPeakProfitProtectionConfig } =
      require('./peakProfitProtection') as typeof import('./peakProfitProtection');
    if (getPeakProfitProtectionConfig().enabled) {
      let volTighten = input.volumeExitTightenMult;
      let deferPppFull = false;
      if (input.mirrorWalletId) {
        try {
          const {
            isMirrorSellPreferred,
            mirroredPoorSignsAllowEarlierPpp,
          } = require('./influencerMirrorRuntime') as typeof import('./influencerMirrorRuntime');
          const poor = mirroredPoorSignsAllowEarlierPpp({
            peakUnrealizedPct: peakUnrealized,
            pnlPct: pnl,
            volumeDecayState: input.volumeDecayState,
            taStructureBroken: input.taStructureBroken === true,
          });
          if (
            input.mint &&
            isMirrorSellPreferred(String(input.mint)) &&
            !poor
          ) {
            // Prefer influencer_mirror_sell — briefly defer soft PPP full-exit
            deferPppFull = true;
          } else if (poor) {
            const base =
              volTighten != null && Number.isFinite(Number(volTighten))
                ? Number(volTighten)
                : 1;
            volTighten = Math.min(base, 0.82);
          }
        } catch {
          /* optional */
        }
      }
      const ppp = evaluatePeakProfitProtection({
        peakUnrealizedPct: peakUnrealized,
        pnlPct: pnl,
        takeProfitPct: input.takeProfitPct,
        profileId: input.tradeProfileId,
        policyArmOfTpPct:
          pol.peakProtectArmOfTpPct > 0 ? pol.peakProtectArmOfTpPct : null,
        policyGivebackOfPeakPct:
          pol.peakProtectGivebackOfPeakPct > 0
            ? pol.peakProtectGivebackOfPeakPct
            : null,
        peakProtectArmedAt: input.peakProtectArmedAt,
        peakProtectLastPeakAt: input.peakProtectLastPeakAt,
        nowMs: now,
        volumeExitTightenMult: volTighten,
        openedAt: input.openedAt,
        deferArm: permActive,
        pclPartialTaken: input.pclPartialTaken === true,
        entryQualityScore: input.entryQualityScore,
      });
      if (ppp.shouldExit && ppp.reason && !deferPppFull) {
        return { type: 'full', reason: ppp.reason };
      }
    } else if (
      // 1b) Legacy absolute profit-lock when PPP is off
      pol.profitLockArmPct > 0 &&
      (pol.profitGivebackPts > 0 || pol.profitFloorPct > 0) &&
      peakUnrealized >= pol.profitLockArmPct
    ) {
      const givebackPts = peakUnrealized - pnl;
      if (pol.profitGivebackPts > 0 && givebackPts >= pol.profitGivebackPts) {
        return {
          type: 'full',
          reason: `Profile profit-lock giveback −${givebackPts.toFixed(1)} pts from peak +${peakUnrealized.toFixed(0)}% (policy ${pol.profitGivebackPts} pts)`,
        };
      }
      if (pol.profitFloorPct > 0 && pnl < pol.profitFloorPct) {
        return {
          type: 'full',
          reason: `Profile profit-lock floor +${pnl.toFixed(1)}% < +${pol.profitFloorPct}% (armed @ ${pol.profitLockArmPct}%)`,
        };
      }
    }
  } catch {
    /* fail-open to legacy below */
    if (
      pol.profitLockArmPct > 0 &&
      (pol.profitGivebackPts > 0 || pol.profitFloorPct > 0) &&
      peakUnrealized >= pol.profitLockArmPct
    ) {
      const givebackPts = peakUnrealized - pnl;
      if (pol.profitGivebackPts > 0 && givebackPts >= pol.profitGivebackPts) {
        return {
          type: 'full',
          reason: `Profile profit-lock giveback −${givebackPts.toFixed(1)} pts from peak +${peakUnrealized.toFixed(0)}% (policy ${pol.profitGivebackPts} pts)`,
        };
      }
      if (pol.profitFloorPct > 0 && pnl < pol.profitFloorPct) {
        return {
          type: 'full',
          reason: `Profile profit-lock floor +${pnl.toFixed(1)}% < +${pol.profitFloorPct}% (armed @ ${pol.profitLockArmPct}%)`,
        };
      }
    }
  }

  // 2) Swing structure cut while green
  if (
    pol.cutIfStructureBroken &&
    input.taStructureBroken === true &&
    pnl > 2 &&
    pnl < input.takeProfitPct * 0.9
  ) {
    return {
      type: 'full',
      reason: `Profile TA structure broken while +${pnl.toFixed(1)}%`,
    };
  }

  // Soft timer deferral is handled by caller when extendHoldIfTaOk + taStructureOk

  // 3) Early partial — once, before full TP (legacy order when PCL off)
  if (!pclOn) {
    const partialLegacy = tryEarlyPartial();
    if (partialLegacy) return partialLegacy;
  }

  // 4) Tighten trail after armed
  if (
    input.trailingActive &&
    pol.trailTightenFactor > 0 &&
    pol.trailTightenFactor < 1 &&
    input.trailingStopPct > 0
  ) {
    const tightened = Math.max(
      2,
      Number((input.trailingStopPct * pol.trailTightenFactor).toFixed(2))
    );
    if (tightened < input.trailingStopPct - 0.05) {
      return {
        type: 'tighten_trail',
        newTrailingStopPct: tightened,
        reason: `Profile trail tighten ${input.trailingStopPct}% → ${tightened}%`,
      };
    }
  }

  // 5) Momentum fade from peak while still green
  if (
    pol.momentumFadeDropPct > 0 &&
    pnl > 2 &&
    input.highWaterMarkSol > input.entryPriceSol &&
    input.currentPriceSol > 0
  ) {
    const dropFromPeak =
      ((input.highWaterMarkSol - input.currentPriceSol) /
        input.highWaterMarkSol) *
      100;
    // Soft urgency: only absolute collapse / confirmed bearish-div lower fade
    // threshold (not generic “decaying” — too common after pumps).
    let fadeThresh = pol.momentumFadeDropPct;
    if (pclOn) {
      try {
        const { permissionFadeThresholdMult, shouldBlockTinyGreenScratch } =
          require('./profitCaptureLayer') as typeof import('./profitCaptureLayer');
        fadeThresh *= permissionFadeThresholdMult({
          profitPermissionUntilMs: input.profitPermissionUntilMs,
          nowMs: now,
        });
        // High quality → wider first pullback
        const q = Number(input.entryQualityScore);
        if (Number.isFinite(q) && q >= 70) fadeThresh *= 1.15;
        if (
          shouldBlockTinyGreenScratch({
            pnlPct: pnl,
            profitPermissionUntilMs: input.profitPermissionUntilMs,
            pclPartialTaken: input.pclPartialTaken,
            qualityTier: input.qualityTier,
            entryQualityScore: input.entryQualityScore,
            maxRunupPct: peakUnrealized,
            armedWatch: input.armedWatch === true,
            entryStyle: input.entryStyle,
            nowMs: now,
          })
        ) {
          fadeThresh = Math.max(fadeThresh, pol.momentumFadeDropPct * 2);
        }
      } catch {
        /* fail soft */
      }
    }
    const decay = input.volumeDecayState;
    const div = input.volumeDivergenceState;
    let volUrgency = false;
    try {
      const { getVolumeIntelligenceConfig } =
        require('./volumeIntelligence') as typeof import('./volumeIntelligence');
      const viCfg = getVolumeIntelligenceConfig();
      if (viCfg.enabled && viCfg.exitUrgencyOnDecay && decay === 'collapsed') {
        fadeThresh *= 0.7;
        volUrgency = true;
      }
      if (
        viCfg.enabled &&
        viCfg.exitUrgencyOnBearishDivergence &&
        div === 'bearish_divergence'
      ) {
        fadeThresh *= 0.88;
        volUrgency = true;
      }
    } catch {
      /* no vol urgency */
    }
    if (dropFromPeak >= fadeThresh) {
      return {
        type: 'full',
        reason: `Profile momentum fade −${dropFromPeak.toFixed(1)}% from peak (policy ${pol.momentumFadeDropPct}%${
          volUrgency && fadeThresh < pol.momentumFadeDropPct
            ? `; vol-urgency ${fadeThresh.toFixed(1)}%`
            : ''
        })`,
      };
    }
  }

  // 5b) Soft volume-decay exit urgency while green (never overrides hard SL).
  // Collapsed only for decay path — “decaying” alone no longer force-exits.
  // Soften during PCL permission window.
  if (!permActive) {
    try {
      const {
        getVolumeIntelligenceConfig,
      } = require('./volumeIntelligence') as typeof import('./volumeIntelligence');
      const viCfg = getVolumeIntelligenceConfig();
      if (
        viCfg.enabled &&
        viCfg.exitUrgencyOnDecay &&
        pnl > 3 &&
        pnl < input.takeProfitPct * 0.9 &&
        input.volumeDecayState === 'collapsed' &&
        peakUnrealized >= Math.max(6, input.takeProfitPct * 0.35) &&
        peakUnrealized - pnl >= 4
      ) {
        return {
          type: 'full',
          reason: `Open trade volume decay — tighten exit bias (peak +${peakUnrealized.toFixed(1)}% → +${pnl.toFixed(1)}%)`,
        };
      }
      if (
        viCfg.enabled &&
        viCfg.exitUrgencyOnBearishDivergence &&
        input.volumeDivergenceState === 'bearish_divergence' &&
        pnl > 4 &&
        pnl < input.takeProfitPct * 0.85 &&
        peakUnrealized >= Math.max(8, input.takeProfitPct * 0.4) &&
        peakUnrealized - pnl >= 5
      ) {
        return {
          type: 'full',
          reason: `Bearish volume divergence detected — soft exit while +${pnl.toFixed(1)}% (peak +${peakUnrealized.toFixed(1)}%)`,
        };
      }
    } catch {
      /* fail soft */
    }
  }

  // 6) Quality breakdown: green but conviction collapsed + held a bit
  if (
    pol.qualityBreakdownExit &&
    pnl > 0 &&
    pnl < input.takeProfitPct * 0.85 &&
    input.convictionScore != null &&
    input.convictionScore < 35 &&
    now - input.openedAt > 90_000 &&
    !permActive
  ) {
    return {
      type: 'full',
      reason: `Profile quality breakdown (conviction ${input.convictionScore}) while +${pnl.toFixed(1)}%`,
    };
  }

  return { type: 'none' };
}

export interface ProfileLearningSuggestion {
  profileId: string;
  profileName: string;
  sampleSize: number;
  winRatePct: number;
  messages: string[];
  /** Patch to apply via updateTradeProfileParams */
  patch: {
    exitRules?: Partial<TradeProfileExitRules>;
    match?: Record<string, number | boolean>;
  };
  /** Entry tightenments for quality profiles once stabilized */
  entryTighten?: Record<string, number | boolean>;
}

export function buildProfileLearningSuggestions(
  scoreboard: TradeProfileScoreboard,
  laneStats?: Record<string, { n: number; wins: number; sumPnl: number }>
): ProfileLearningSuggestion[] {
  const out: ProfileLearningSuggestion[] = [];
  for (const row of scoreboard.rows) {
    if (row.trades < 8) continue;
    const messages: string[] = [];
    const exitRules: Partial<TradeProfileExitRules> = {};
    const match: Record<string, number | boolean> = {};
    const entryTighten: Record<string, number | boolean> = {};

    const mixPct = (key: ExitMixKey) =>
      row.exitMix.find((m) => m.key === key)?.pct ?? 0;

    const slPct = mixPct('sl');
    const timerPct = mixPct('timer');
    const trailPct = mixPct('trail');
    const deadPct = mixPct('dead_market');

    if (slPct >= 40 && row.winRatePct < 45) {
      messages.push(
        `High hard-SL share (${slPct.toFixed(0)}%) — nudge SL band slightly wider and trail activation later.`
      );
      exitRules.stopLossPctMin = undefined; // applied relative in apply layer
      exitRules.trailingActivationProfit = Math.round(
        Math.min(40, 12 + row.avgHoldSec / 60)
      );
    }
    if (timerPct >= 35 && row.avgPnlPct > 0) {
      messages.push(
        `Many timer exits while avg PnL positive — take profit earlier / tighten hold max.`
      );
      exitRules.hardTimeLimitSecMax = Math.max(
        60,
        Math.round(row.avgHoldSec * 0.85)
      );
    }
    if (trailPct >= 30 && row.winRatePct >= 50) {
      messages.push(
        `Trail exits working (${trailPct.toFixed(0)}%) — keep trail; optional earlier activation.`
      );
      exitRules.trailingActivationProfit = Math.max(
        5,
        Math.round(8 + (100 - row.winRatePct) / 10)
      );
    }
    if (
      trailPct >= 28 &&
      (row.profileId === 'trend_rider' ||
        row.profileId === 'steady_compounder' ||
        row.profileId === 'high_win_rate')
    ) {
      messages.push(
        `Trail-heavy swing exits (${trailPct.toFixed(0)}%) — try Heikin-Ashi exit (ride green HA, sell on red flip).`
      );
      exitRules.exitPolicy = {
        ...(exitRules.exitPolicy || {}),
        heikinAshiExitEnabled: true,
      };
    }
    if (deadPct >= 25 && row.avgPnlPct < 0) {
      messages.push(
        `Dead-market exits on losers — enable aggressive dead-market / shorter min hold.`
      );
      exitRules.aggressiveDeadMarket = true;
      exitRules.deadVolumeMinHoldMinutes = 2;
    }
    if (row.winRatePct < 40 && row.trades >= 12) {
      messages.push(
        `Win rate ${row.winRatePct.toFixed(0)}% — reduce Size × and prefer higher conviction.`
      );
      exitRules.sizeMultiplier = 0.75;
      match.minConviction = 50;
    }

    // Phase 4 — quality profiles once stabilized
    if (
      row.stabilized &&
      (row.profileId === 'high_win_rate' ||
        row.profileId === 'steady_compounder')
    ) {
      if (row.winRatePct < 55) {
        messages.push(
          `Stabilized sample — tighten entry quality (conviction / cluster) for ${row.name}.`
        );
        entryTighten.minConviction =
          row.profileId === 'high_win_rate' ? 80 : 55;
        entryTighten.requireCluster = true;
        if (row.profileId === 'high_win_rate') {
          entryTighten.minWalletCount = 3;
          entryTighten.minWalletQuality = 70;
        }
      } else {
        messages.push(
          `Stabilized with solid win rate — keep quality floors; no further entry tighten.`
        );
      }
    }

    if (messages.length === 0) continue;
    out.push({
      profileId: row.profileId,
      profileName: row.name,
      sampleSize: row.trades,
      winRatePct: row.winRatePct,
      messages,
      patch: {
        exitRules: Object.keys(exitRules).length ? exitRules : undefined,
        match: Object.keys(match).length ? match : undefined,
      },
      entryTighten:
        Object.keys(entryTighten).length > 0 ? entryTighten : undefined,
    });
  }

  mergeLaneFloorSuggestions(out, scoreboard, laneStats);
  return out;
}

const LANE_FLOOR_MIN_N = 6;
const LANE_FLOOR_SOFT_WR = 45;

/** Raise-only holders / MC / top-10 floors from soft lane-won closed samples. */
function mergeLaneFloorSuggestions(
  out: ProfileLearningSuggestion[],
  scoreboard: TradeProfileScoreboard,
  laneStats?: Record<string, { n: number; wins: number; sumPnl: number }>
): void {
  if (!laneStats) return;
  let resolveTradeProfileDefinition: typeof import('./tradeProfiles').resolveTradeProfileDefinition;
  try {
    ({ resolveTradeProfileDefinition } = require('./tradeProfiles') as typeof import('./tradeProfiles'));
  } catch {
    return;
  }
  const nameById = new Map(
    scoreboard.rows.map((r) => [r.profileId, r.name] as const)
  );

  for (const [profileId, st] of Object.entries(laneStats)) {
    if (st.n < LANE_FLOOR_MIN_N) continue;
    const wr = st.n > 0 ? (st.wins / st.n) * 100 : 0;
    if (wr >= LANE_FLOOR_SOFT_WR) continue;

    let def: ReturnType<typeof resolveTradeProfileDefinition>;
    try {
      def = resolveTradeProfileDefinition(profileId);
    } catch {
      continue;
    }
    const m = def.match || {};
    const curHolders =
      m.minHolders != null && Number(m.minHolders) > 0 ? Number(m.minHolders) : 0;
    const curMc =
      m.minMarketCapUsd != null && Number(m.minMarketCapUsd) > 0
        ? Number(m.minMarketCapUsd)
        : 0;
    const curTop10 =
      m.maxTop10HoldPct != null && Number(m.maxTop10HoldPct) > 0
        ? Number(m.maxTop10HoldPct)
        : 0;

    const match: Record<string, number | boolean> = {};
    const messages: string[] = [];
    const sampleNote = `Lane-won closes n=${st.n}, WR ${wr.toFixed(0)}%`;

    const nextHolders = Math.min(
      500,
      Math.max(curHolders + 20, curHolders > 0 ? Math.round(curHolders * 1.15) : 80)
    );
    if (nextHolders > curHolders) {
      match.minHolders = nextHolders;
      messages.push(
        `${sampleNote} — raise Min holders to ${nextHolders} (was ${curHolders || 'default'}).`
      );
    }

    const nextMc = Math.round(
      curMc > 0 ? Math.max(curMc * 1.2, curMc + 5_000) : 25_000
    );
    if (nextMc > curMc) {
      match.minMarketCapUsd = nextMc;
      messages.push(
        `${sampleNote} — raise Min MC Override to $${nextMc.toLocaleString()} (was ${
          curMc > 0 ? '$' + curMc.toLocaleString() : 'none'
        }).`
      );
    }

    // Tighter concentration = lower max top-10 % (never loosen)
    const nextTop10 =
      curTop10 > 0 ? Math.max(25, curTop10 - 5) : 45;
    if (curTop10 <= 0 || nextTop10 < curTop10) {
      match.maxTop10HoldPct = nextTop10;
      messages.push(
        `${sampleNote} — set Max Top-10 % to ${nextTop10} (tighter; was ${
          curTop10 > 0 ? curTop10 : 'none'
        }).`
      );
    }

    if (messages.length === 0 || Object.keys(match).length === 0) continue;

    const existing = out.find((s) => s.profileId === profileId);
    if (existing) {
      existing.messages.push(...messages);
      existing.patch = existing.patch || {};
      existing.patch.match = { ...(existing.patch.match || {}), ...match };
      existing.sampleSize = Math.max(existing.sampleSize, st.n);
      existing.winRatePct = wr;
    } else {
      out.push({
        profileId,
        profileName: nameById.get(profileId) || def.name || profileId,
        sampleSize: st.n,
        winRatePct: wr,
        messages,
        patch: { match },
      });
    }
  }
}

/** Merge learning patch into existing exit rules with safe clamps. */
export function mergeLearningExitPatch(
  current: TradeProfileExitRules,
  patch: Partial<TradeProfileExitRules>
): TradeProfileExitRules {
  const next = { ...current, ...patch };
  if (current.exitPolicy || patch.exitPolicy) {
    next.exitPolicy = {
      ...(current.exitPolicy || {}),
      ...(patch.exitPolicy || {}),
    };
  }
  if (patch.trailingActivationProfit != null) {
    next.trailingActivationProfit = Math.min(
      80,
      Math.max(3, Number(patch.trailingActivationProfit))
    );
  }
  if (patch.hardTimeLimitSecMax != null) {
    const max = Math.max(45, Number(patch.hardTimeLimitSecMax));
    next.hardTimeLimitSecMax = max;
    if (
      next.hardTimeLimitSecMin != null &&
      next.hardTimeLimitSecMin > max
    ) {
      next.hardTimeLimitSecMin = Math.max(30, Math.floor(max * 0.6));
    }
  }
  if (patch.sizeMultiplier != null) {
    next.sizeMultiplier = Math.min(
      1.2,
      Math.max(0.4, Number(patch.sizeMultiplier))
    );
  }
  if (patch.deadVolumeMinHoldMinutes != null) {
    next.deadVolumeMinHoldMinutes = Math.min(
      15,
      Math.max(1, Number(patch.deadVolumeMinHoldMinutes))
    );
  }
  return next;
}

export type { TradeProfileId };
