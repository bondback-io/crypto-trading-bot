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
}

export const DEFAULT_EXIT_POLICIES: Record<string, ProfileExitPolicy> = {
  scalper: {
    earlyPartialTpPct: 12,
    earlyPartialFraction: 0.45,
    trailTightenFactor: 0.7,
    momentumFadeDropPct: 5,
    aggressiveDeadMarket: true,
    qualityBreakdownExit: false,
  },
  reversal_scalper: {
    earlyPartialTpPct: 10,
    earlyPartialFraction: 0.5,
    trailTightenFactor: 0.65,
    momentumFadeDropPct: 5,
    aggressiveDeadMarket: true,
    qualityBreakdownExit: false,
  },
  momentum_burst: {
    earlyPartialTpPct: 18,
    earlyPartialFraction: 0.35,
    trailTightenFactor: 0.75,
    momentumFadeDropPct: 6,
    aggressiveDeadMarket: true,
    qualityBreakdownExit: false,
  },
  dip_buyer: {
    earlyPartialTpPct: 15,
    earlyPartialFraction: 0.3,
    trailTightenFactor: 0.85,
    momentumFadeDropPct: 8,
    aggressiveDeadMarket: false,
    qualityBreakdownExit: false,
  },
  trend_rider: {
    earlyPartialTpPct: 0,
    earlyPartialFraction: 0,
    trailTightenFactor: 0.9,
    momentumFadeDropPct: 10,
    aggressiveDeadMarket: false,
    qualityBreakdownExit: false,
  },
  steady_compounder: {
    earlyPartialTpPct: 6,
    earlyPartialFraction: 0.4,
    trailTightenFactor: 0.85,
    momentumFadeDropPct: 7,
    aggressiveDeadMarket: false,
    qualityBreakdownExit: true,
  },
  high_win_rate: {
    earlyPartialTpPct: 20,
    earlyPartialFraction: 0.35,
    trailTightenFactor: 0.8,
    momentumFadeDropPct: 8,
    aggressiveDeadMarket: false,
    qualityBreakdownExit: true,
  },
  smart_money_mirror: {
    earlyPartialTpPct: 15,
    earlyPartialFraction: 0.3,
    trailTightenFactor: 0.85,
    momentumFadeDropPct: 9,
    aggressiveDeadMarket: false,
    qualityBreakdownExit: false,
  },
  migration_sniper: {
    earlyPartialTpPct: 14,
    earlyPartialFraction: 0.4,
    trailTightenFactor: 0.7,
    momentumFadeDropPct: 6,
    aggressiveDeadMarket: true,
    qualityBreakdownExit: false,
  },
  default: {
    earlyPartialTpPct: 0,
    earlyPartialFraction: 0,
    trailTightenFactor: 1,
    momentumFadeDropPct: 0,
    aggressiveDeadMarket: false,
    qualityBreakdownExit: false,
  },
};

export function resolveExitPolicy(
  profileId: string | null | undefined,
  rules?: TradeProfileExitRules | null
): ProfileExitPolicy {
  const base =
    DEFAULT_EXIT_POLICIES[String(profileId || 'default')] ||
    DEFAULT_EXIT_POLICIES.default;
  const ep = rules?.exitPolicy;
  if (!ep || typeof ep !== 'object') return { ...base };
  return {
    earlyPartialTpPct:
      ep.earlyPartialTpPct != null && Number.isFinite(Number(ep.earlyPartialTpPct))
        ? Math.max(0, Number(ep.earlyPartialTpPct))
        : base.earlyPartialTpPct,
    earlyPartialFraction:
      ep.earlyPartialFraction != null &&
      Number.isFinite(Number(ep.earlyPartialFraction))
        ? Math.min(0.9, Math.max(0, Number(ep.earlyPartialFraction)))
        : base.earlyPartialFraction,
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

const MIN_SAMPLE_STABILIZE = 15;

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
}): AdaptiveExitAction {
  const now = input.nowMs ?? Date.now();
  const pol = input.policy;
  const pnl = input.pnlPct;

  // Early partial — once, before full TP
  if (
    pol.earlyPartialTpPct > 0 &&
    pol.earlyPartialFraction > 0 &&
    !input.partialSellDone &&
    !input.bagTrimDone &&
    pnl >= pol.earlyPartialTpPct &&
    pnl < input.takeProfitPct
  ) {
    return {
      type: 'partial',
      fraction: pol.earlyPartialFraction,
      reason: `Profile early partial @ +${pnl.toFixed(1)}% (policy ${pol.earlyPartialTpPct}%)`,
    };
  }

  // Tighten trail after armed
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

  // Momentum fade from peak while still green
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
    if (dropFromPeak >= pol.momentumFadeDropPct) {
      return {
        type: 'full',
        reason: `Profile momentum fade −${dropFromPeak.toFixed(1)}% from peak (policy ${pol.momentumFadeDropPct}%)`,
      };
    }
  }

  // Quality breakdown: green but conviction collapsed + held a bit
  if (
    pol.qualityBreakdownExit &&
    pnl > 0 &&
    pnl < input.takeProfitPct * 0.85 &&
    input.convictionScore != null &&
    input.convictionScore < 35 &&
    now - input.openedAt > 90_000
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
  scoreboard: TradeProfileScoreboard
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
  return out;
}

/** Merge learning patch into existing exit rules with safe clamps. */
export function mergeLearningExitPatch(
  current: TradeProfileExitRules,
  patch: Partial<TradeProfileExitRules>
): TradeProfileExitRules {
  const next = { ...current, ...patch };
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
