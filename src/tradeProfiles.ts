/**
 * Multi-Profile trade assignment layer.
 *
 * Upgrade on top of the existing single strategyProfile / Risk / Strict stack:
 * - Multiple named profiles can be ON at once
 * - At entry, the best-matching enabled profile is chosen and stamped on the Position
 * - Exit params (TP/SL/trail/timer) are frozen from that profile onto the trade
 * - Risk Level + Strict Mode remain global modifiers when resolving effective rules
 * - When multi-profile is OFF (or only Default is relevant), behaviour matches today
 *
 * Concrete profiles (Scalper / Dip Buyer / Trend Rider) ship complete rule sets.
 * Add new profiles by extending TRADE_PROFILE_CATALOG.
 */

import { config, persistUserSettings } from './config';
import type { ShortTermStrategyId } from './shortTermStrategies';

export type TradeProfileId =
  | 'default'
  | 'scalper'
  | 'dip_buyer'
  | 'trend_rider'
  | 'migration'
  | 'high_win_rate';

export interface TradeProfileExitRules {
  /** Freeze take-profit % on the position */
  takeProfitPct?: number;
  /** Randomize TP in [min, max] at assignment (inclusive) */
  takeProfitPctMin?: number;
  takeProfitPctMax?: number;
  stopLossPct?: number;
  trailingStopPct?: number;
  /** When trail arms (% profit) — informational / future use on position */
  trailingActivationProfit?: number;
  /** Force scalp-style timed exit when assigned */
  forceScalp?: boolean;
  shortTermStrategyId?: ShortTermStrategyId;
  /** After seeding scalp, overwrite TP/SL/timer with profile values */
  overrideScalpParams?: boolean;
  /** Exact hard time limit (seconds) */
  hardTimeLimitSec?: number;
  hardTimeLimitSecMin?: number;
  hardTimeLimitSecMax?: number;
  /** Optional size multiplier vs dynamic size (1 = unchanged) */
  sizeMultiplier?: number;
}

export interface TradeProfileMatchRules {
  preferScalp?: boolean;
  preferDip?: boolean;
  preferMigration?: boolean;
  preferTrend?: boolean;
  preferHighWinRate?: boolean;
  always?: boolean;
  minConviction?: number;
  /** Prefer small-cap tokens (Scalper) */
  preferSmallMc?: boolean;
  maxMarketCapUsd?: number;
  /** Prefer established tokens (Trend Rider) */
  minTokenAgeHours?: number;
  minHolders?: number;
  minVolumeH1Usd?: number;
  /** Dip: require prior strong run / peak drop */
  minDropFromPeakPct?: number;
  minPriceChange24hPct?: number;
  /** Dip: bonus when near Fib 0.5/0.618 or support */
  preferFibOrSupport?: boolean;
  /** Optional smart-money score floor (bonus, not hard fail if missing) */
  preferSmartMoney?: boolean;
}

export interface TradeProfileDefinition {
  id: TradeProfileId;
  name: string;
  icon: string;
  color: string;
  description: string;
  /** Short bullet list shown in Strategies UI */
  rulesSummary: string[];
  priority: number;
  defaultEnabled: boolean;
  match: TradeProfileMatchRules;
  exitRules: TradeProfileExitRules;
}

/** Catalog — extend here to add profiles later */
export const TRADE_PROFILE_CATALOG: readonly TradeProfileDefinition[] = [
  {
    id: 'default',
    name: 'Default',
    icon: '◆',
    color: '#94a3b8',
    description:
      'Current global Strategy Profile + Risk/Strict — backward-compatible fallback',
    rulesSummary: [
      'Uses live global TP/SL/trail/scalp settings',
      'Risk Level + Strict Mode stack as usual',
    ],
    priority: 0,
    defaultEnabled: true,
    match: { always: true },
    exitRules: {},
  },

  // ── Concrete profile 1: Scalper ──────────────────────────────────────────
  {
    id: 'scalper',
    name: 'Scalper',
    icon: '⚡',
    color: '#fbbf24',
    description:
      'Fast entries on small-MC tokens — tight SL, TP 15–35%, hard 1–4 min timer, smaller size',
    rulesSummary: [
      'Fast entries · prefer small market-cap tokens',
      'Tight stop-loss (~10%)',
      'Take-profit 15–35% (rolled per trade)',
      'Hard time limit 1–4 minutes',
      'Smaller position size (~70%)',
      'Optimised for quick scalps',
    ],
    priority: 80,
    defaultEnabled: true,
    match: {
      preferScalp: true,
      preferSmallMc: true,
      maxMarketCapUsd: 150_000,
    },
    exitRules: {
      forceScalp: true,
      shortTermStrategyId: 'quick_scalper',
      overrideScalpParams: true,
      takeProfitPctMin: 15,
      takeProfitPctMax: 35,
      stopLossPct: 10,
      hardTimeLimitSecMin: 60,
      hardTimeLimitSecMax: 240,
      sizeMultiplier: 0.7,
    },
  },

  // ── Concrete profile 2: Dip Buyer ────────────────────────────────────────
  {
    id: 'dip_buyer',
    name: 'Dip Buyer',
    icon: '↘',
    color: '#22d3ee',
    description:
      'Post-run dips near Fib 0.5/0.618 + support — volume/SM confirmation, moderate TP + trail',
    rulesSummary: [
      'Designed for post-run dips',
      'Prefers Fib 0.5 & 0.618 + support levels',
      'Requires a prior strong run (12–24h / peak drop)',
      'Volume confirmation + optional smart-money activity',
      'Moderate take-profit (~38%) with trailing stop (~12%)',
      'Higher quality filters (conviction floor)',
    ],
    priority: 85,
    defaultEnabled: true,
    match: {
      preferDip: true,
      preferFibOrSupport: true,
      preferSmartMoney: true,
      minConviction: 40,
      minDropFromPeakPct: 12,
      minPriceChange24hPct: 12,
    },
    exitRules: {
      // Keep post_run_dip timed path when already armed; else normal TP+trail
      shortTermStrategyId: 'post_run_dip',
      overrideScalpParams: true,
      takeProfitPct: 38,
      stopLossPct: 15,
      trailingStopPct: 12,
      trailingActivationProfit: 20,
      sizeMultiplier: 0.85,
    },
  },

  // ── Concrete profile 3: Trend Rider ──────────────────────────────────────
  {
    id: 'trend_rider',
    name: 'Trend Rider',
    icon: '▲',
    color: '#34d399',
    description:
      'Longer-lived tokens with holders/volume — steady 5–12% gains, tight risk, longer holds',
    rulesSummary: [
      'Focuses on tokens that have been trading longer',
      'Prefers higher holders and volume',
      'Targets smaller consistent gains (5–12%)',
      'Tighter risk controls (~8% SL, ~6% trail)',
      'Allows longer hold times than Scalper (no hard timer)',
      'Aimed at steady trend continuation',
    ],
    priority: 55,
    defaultEnabled: true,
    match: {
      preferTrend: true,
      minConviction: 50,
      minTokenAgeHours: 6,
      minHolders: 60,
      minVolumeH1Usd: 3_000,
    },
    exitRules: {
      forceScalp: false,
      takeProfitPctMin: 5,
      takeProfitPctMax: 12,
      stopLossPct: 8,
      trailingStopPct: 6,
      trailingActivationProfit: 5,
      sizeMultiplier: 1.0,
    },
  },

  {
    id: 'migration',
    name: 'Migration',
    icon: '↗',
    color: '#a78bfa',
    description: 'Migration / near-migration priority entries',
    rulesSummary: [
      'Priority sizing on migration / near-migration / early curve',
      'Wider TP with trail for graduation volatility',
    ],
    priority: 75,
    defaultEnabled: true,
    match: { preferMigration: true },
    exitRules: {
      takeProfitPct: 80,
      stopLossPct: 18,
      trailingStopPct: 14,
      sizeMultiplier: 1.15,
    },
  },
  {
    id: 'high_win_rate',
    name: 'High Win-Rate',
    icon: '◎',
    color: '#fb7185',
    description: 'Selective high-quality entries — tighter SL, disciplined TP',
    rulesSummary: [
      'High conviction selective entries',
      'Tighter SL / disciplined TP',
      'Smaller size for quality over quantity',
    ],
    priority: 60,
    defaultEnabled: true,
    match: { preferHighWinRate: true, minConviction: 65 },
    exitRules: {
      takeProfitPct: 55,
      stopLossPct: 12,
      trailingStopPct: 10,
      sizeMultiplier: 0.75,
    },
  },
] as const;

export interface TradeProfileRuntimeState {
  enabled: boolean;
  profiles: Record<TradeProfileId, boolean>;
}

export interface TradeProfileAssignment {
  profileId: TradeProfileId;
  name: string;
  icon: string;
  color: string;
  score: number;
  reason: string;
  exitRules: TradeProfileExitRules;
  legacy: boolean;
}

export interface TradeProfileMatchContext {
  isMigration?: boolean;
  nearMigration?: boolean;
  earlyBuy?: boolean;
  scalpMode?: boolean;
  shortTermStrategyId?: string | null;
  convictionScore?: number | null;
  dropFromPeakPct?: number | null;
  strategyKind?: 'migration' | 'normal';
  symbol?: string;
  marketCapUsd?: number | null;
  holderCount?: number | null;
  volumeH1Usd?: number | null;
  tokenAgeHours?: number | null;
  priceChange24hPct?: number | null;
  nearKeyFib?: boolean;
  nearSupport?: boolean;
  smartMoneyScore?: number | null;
}

const ALL_IDS: TradeProfileId[] = TRADE_PROFILE_CATALOG.map((p) => p.id);

function randBetween(min: number, max: number): number {
  const a = Math.min(min, max);
  const b = Math.max(min, max);
  return a + Math.random() * (b - a);
}

/** Turn range fields into concrete frozen values for one trade */
export function materializeExitRules(
  rules: TradeProfileExitRules
): TradeProfileExitRules {
  const out: TradeProfileExitRules = { ...rules };
  if (
    out.takeProfitPct == null &&
    out.takeProfitPctMin != null &&
    out.takeProfitPctMax != null
  ) {
    out.takeProfitPct =
      Math.round(randBetween(out.takeProfitPctMin, out.takeProfitPctMax) * 10) /
      10;
  }
  if (
    out.hardTimeLimitSec == null &&
    out.hardTimeLimitSecMin != null &&
    out.hardTimeLimitSecMax != null
  ) {
    out.hardTimeLimitSec = Math.round(
      randBetween(out.hardTimeLimitSecMin, out.hardTimeLimitSecMax)
    );
  }
  return out;
}

function defaultRuntimeState(): TradeProfileRuntimeState {
  const profiles = {} as Record<TradeProfileId, boolean>;
  for (const p of TRADE_PROFILE_CATALOG) {
    profiles[p.id] = p.defaultEnabled;
  }
  return { enabled: true, profiles };
}

function ensureState(): TradeProfileRuntimeState {
  const raw = (config as { tradeProfiles?: Partial<TradeProfileRuntimeState> })
    .tradeProfiles;
  if (!raw || typeof raw !== 'object') {
    (config as { tradeProfiles: TradeProfileRuntimeState }).tradeProfiles =
      defaultRuntimeState();
    return (config as { tradeProfiles: TradeProfileRuntimeState }).tradeProfiles;
  }
  if (typeof raw.enabled !== 'boolean') raw.enabled = true;
  if (!raw.profiles || typeof raw.profiles !== 'object') {
    raw.profiles = defaultRuntimeState().profiles;
  }
  for (const id of ALL_IDS) {
    if (typeof raw.profiles[id] !== 'boolean') {
      const def = TRADE_PROFILE_CATALOG.find((p) => p.id === id);
      raw.profiles[id] = def?.defaultEnabled ?? true;
    }
  }
  (config as { tradeProfiles: TradeProfileRuntimeState }).tradeProfiles =
    raw as TradeProfileRuntimeState;
  return raw as TradeProfileRuntimeState;
}

export function getTradeProfileDefinition(
  id: TradeProfileId | string | null | undefined
): TradeProfileDefinition {
  const hit = TRADE_PROFILE_CATALOG.find((p) => p.id === id);
  return hit ?? TRADE_PROFILE_CATALOG[0];
}

export function getTradeProfilesStatus(): {
  enabled: boolean;
  profiles: Array<
    TradeProfileDefinition & { enabled: boolean; active: boolean }
  >;
  active: Array<{ id: TradeProfileId; name: string; icon: string; color: string }>;
} {
  const state = ensureState();
  const profiles = TRADE_PROFILE_CATALOG.map((p) => ({
    ...p,
    enabled: state.profiles[p.id] !== false,
    active: state.enabled && state.profiles[p.id] !== false,
  }));
  return {
    enabled: state.enabled,
    profiles,
    active: profiles
      .filter((p) => p.active)
      .map((p) => ({
        id: p.id,
        name: p.name,
        icon: p.icon,
        color: p.color,
      })),
  };
}

export function isMultiProfileEnabled(): boolean {
  return ensureState().enabled !== false;
}

export function setMultiProfileEnabled(enabled: boolean): TradeProfileRuntimeState {
  const state = ensureState();
  state.enabled = Boolean(enabled);
  persistUserSettings();
  console.log(
    `[trade-profiles] Multi-profile ${state.enabled ? 'ENABLED' : 'DISABLED (legacy Default only)'}`
  );
  return state;
}

export function setTradeProfileEnabled(
  id: TradeProfileId,
  enabled: boolean
): TradeProfileRuntimeState {
  const state = ensureState();
  if (!ALL_IDS.includes(id)) return state;
  if (id === 'default' && !enabled) {
    console.log('[trade-profiles] Default profile cannot be fully disabled');
    state.profiles.default = true;
  } else {
    state.profiles[id] = Boolean(enabled);
  }
  persistUserSettings();
  console.log(`[trade-profiles] ${id} → ${state.profiles[id] ? 'ON' : 'OFF'}`);
  return state;
}

export function updateTradeProfilesConfig(partial: {
  enabled?: boolean;
  profiles?: Partial<Record<TradeProfileId, boolean>>;
}): ReturnType<typeof getTradeProfilesStatus> {
  const state = ensureState();
  if (partial.enabled != null) state.enabled = Boolean(partial.enabled);
  if (partial.profiles) {
    for (const [id, on] of Object.entries(partial.profiles)) {
      if (!ALL_IDS.includes(id as TradeProfileId)) continue;
      if (id === 'default' && on === false) {
        state.profiles.default = true;
        continue;
      }
      state.profiles[id as TradeProfileId] = Boolean(on);
    }
  }
  persistUserSettings();
  return getTradeProfilesStatus();
}

function scoreProfile(
  def: TradeProfileDefinition,
  ctx: TradeProfileMatchContext
): { score: number; reason: string } {
  const m = def.match;
  let score = 0;
  const bits: string[] = [];

  const conv =
    ctx.convictionScore != null && Number.isFinite(ctx.convictionScore)
      ? Number(ctx.convictionScore)
      : null;
  if (m.minConviction != null && (conv == null || conv < m.minConviction)) {
    return { score: 0, reason: `conviction < ${m.minConviction}` };
  }

  const mc =
    ctx.marketCapUsd != null && Number.isFinite(ctx.marketCapUsd)
      ? Number(ctx.marketCapUsd)
      : null;
  const holders =
    ctx.holderCount != null && Number.isFinite(ctx.holderCount)
      ? Number(ctx.holderCount)
      : null;
  const volH1 =
    ctx.volumeH1Usd != null && Number.isFinite(ctx.volumeH1Usd)
      ? Number(ctx.volumeH1Usd)
      : null;
  const ageH =
    ctx.tokenAgeHours != null && Number.isFinite(ctx.tokenAgeHours)
      ? Number(ctx.tokenAgeHours)
      : null;
  const chg24 =
    ctx.priceChange24hPct != null && Number.isFinite(ctx.priceChange24hPct)
      ? Number(ctx.priceChange24hPct)
      : null;
  const drop =
    ctx.dropFromPeakPct != null && Number.isFinite(ctx.dropFromPeakPct)
      ? Number(ctx.dropFromPeakPct)
      : null;

  const isDip =
    ctx.shortTermStrategyId === 'post_run_dip' ||
    (drop != null && drop >= (m.minDropFromPeakPct ?? 12));
  const isScalp =
    ctx.scalpMode === true &&
    ctx.shortTermStrategyId != null &&
    ctx.shortTermStrategyId !== 'post_run_dip';
  const isMig =
    ctx.isMigration === true ||
    ctx.nearMigration === true ||
    ctx.strategyKind === 'migration' ||
    ctx.earlyBuy === true;

  if (m.preferDip) {
    if (!isDip) return { score: 0, reason: 'not a dip setup' };
    score += 100;
    bits.push('dip setup');
    if (ctx.shortTermStrategyId === 'post_run_dip') {
      score += 25;
      bits.push('post_run_dip');
    }
    // Prior strong run (12–24h) or large peak drop
    const strongRun =
      (chg24 != null && chg24 >= (m.minPriceChange24hPct ?? 12)) ||
      (drop != null && drop >= (m.minDropFromPeakPct ?? 12));
    if (strongRun) {
      score += 15;
      bits.push('prior strong run');
    }
    if (m.preferFibOrSupport && (ctx.nearKeyFib || ctx.nearSupport)) {
      score += 20;
      bits.push(ctx.nearKeyFib ? 'near Fib 0.5/0.618' : 'near support');
    }
    if (volH1 != null && volH1 >= 2000) {
      score += 8;
      bits.push('volume confirm');
    }
    if (
      m.preferSmartMoney &&
      ctx.smartMoneyScore != null &&
      ctx.smartMoneyScore >= 40
    ) {
      score += 10;
      bits.push(`SM ${ctx.smartMoneyScore}`);
    }
  }

  if (m.preferScalp) {
    // Match armed scalps, or small-MC opportunistic scalps when not dip/migration
    const smallMc =
      m.preferSmallMc &&
      mc != null &&
      m.maxMarketCapUsd != null &&
      mc > 0 &&
      mc <= m.maxMarketCapUsd;
    if (isScalp) {
      score += 90;
      bits.push(`scalp:${ctx.shortTermStrategyId}`);
      if (smallMc) {
        score += 12;
        bits.push(`small MC $${Math.round(mc!)}`);
      }
    } else if (smallMc && !isDip && !isMig) {
      score += 55;
      bits.push(`small-MC scalp candidate $${Math.round(mc!)}`);
    } else {
      return { score: 0, reason: 'not a scalp / small-MC setup' };
    }
  }

  if (m.preferMigration) {
    if (!isMig) return { score: 0, reason: 'not a migration setup' };
    score += 85;
    bits.push(
      ctx.isMigration
        ? 'migration'
        : ctx.nearMigration
          ? 'near-migration'
          : 'early/priority'
    );
  }

  if (m.preferTrend) {
    if (isScalp || isDip || isMig) {
      return { score: 0, reason: 'not a trend hold setup' };
    }
    if (conv == null || conv < (m.minConviction ?? 50)) {
      return { score: 0, reason: 'conviction too low for trend' };
    }
    // Soft gates: age / holders / volume — missing data doesn't hard-fail
    let quality = 0;
    if (m.minTokenAgeHours != null) {
      if (ageH != null && ageH >= m.minTokenAgeHours) {
        quality += 1;
        bits.push(`age ${ageH.toFixed(1)}h`);
      } else if (ageH != null && ageH < m.minTokenAgeHours) {
        return { score: 0, reason: `token too young (${ageH.toFixed(1)}h)` };
      }
    }
    if (m.minHolders != null) {
      if (holders != null && holders >= m.minHolders) {
        quality += 1;
        bits.push(`${holders} holders`);
      } else if (holders != null && holders < m.minHolders) {
        return { score: 0, reason: `holders ${holders} < ${m.minHolders}` };
      }
    }
    if (m.minVolumeH1Usd != null) {
      if (volH1 != null && volH1 >= m.minVolumeH1Usd) {
        quality += 1;
        bits.push(`1h vol $${Math.round(volH1)}`);
      } else if (volH1 != null && volH1 < m.minVolumeH1Usd) {
        return {
          score: 0,
          reason: `1h vol $${Math.round(volH1)} < $${m.minVolumeH1Usd}`,
        };
      }
    }
    score += 50 + Math.min(35, (conv - 50) * 0.7) + quality * 8;
    bits.push(`trend conviction ${conv}`);
  }

  if (m.preferHighWinRate) {
    if (isScalp || isDip) {
      return { score: 0, reason: 'not high-win-rate selective' };
    }
    if (conv == null || conv < (m.minConviction ?? 65)) {
      return { score: 0, reason: 'conviction too low' };
    }
    score += 55 + Math.min(30, (conv - 65) * 0.6);
    bits.push(`high-quality conviction ${conv}`);
    if (config.strategyProfile === 'high_win_rate') {
      score += 15;
      bits.push('high_win_rate preset');
    }
  }

  if (m.always) {
    score += 1;
    bits.push('fallback');
  }

  if (score <= 0) return { score: 0, reason: 'no match' };
  return {
    score: score + def.priority * 0.01,
    reason: bits.join(', ') || def.name,
  };
}

function legacyDefaultAssignment(reason: string): TradeProfileAssignment {
  const def = getTradeProfileDefinition('default');
  const preset = String(config.strategyProfile || 'custom').replace(/_/g, ' ');
  return {
    profileId: def.id,
    name: def.name,
    icon: def.icon,
    color: def.color,
    score: 0,
    reason: `${reason} · global preset: ${preset}`,
    exitRules: {},
    legacy: true,
  };
}

/**
 * Choose which enabled profile owns this trade.
 * Does not mutate global config — exit rules are returned for freezing on Position.
 */
export function assignTradeProfile(
  ctx: TradeProfileMatchContext
): TradeProfileAssignment {
  const state = ensureState();

  if (!state.enabled) {
    const a = legacyDefaultAssignment('multi-profile off');
    logTradeProfileAssignment(a, ctx);
    return a;
  }

  const candidates = TRADE_PROFILE_CATALOG.filter(
    (p) => state.profiles[p.id] !== false
  );

  const scored = candidates
    .map((p) => {
      const s = scoreProfile(p, ctx);
      return { def: p, ...s };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.def.priority - a.def.priority);

  const winner = scored[0];
  if (!winner) {
    const a = legacyDefaultAssignment('no profile matched');
    logTradeProfileAssignment(a, ctx);
    return a;
  }

  let exitRules = materializeExitRules({ ...winner.def.exitRules });

  // Prefer the armed short-term id when Scalper/Dip wins
  if (winner.def.id === 'scalper') {
    exitRules.forceScalp = true;
    exitRules.overrideScalpParams = true;
    if (ctx.shortTermStrategyId && ctx.shortTermStrategyId !== 'post_run_dip') {
      exitRules.shortTermStrategyId =
        ctx.shortTermStrategyId as ShortTermStrategyId;
    } else {
      exitRules.shortTermStrategyId = 'quick_scalper';
    }
  }

  if (winner.def.id === 'dip_buyer') {
    // Keep dip timed path when post_run_dip already armed; else TP+trail only
    if (
      ctx.shortTermStrategyId === 'post_run_dip' ||
      (ctx.scalpMode && ctx.shortTermStrategyId === 'post_run_dip')
    ) {
      exitRules.forceScalp = true;
      exitRules.shortTermStrategyId = 'post_run_dip';
      exitRules.overrideScalpParams = true;
    } else {
      exitRules.forceScalp = false;
    }
  }

  const assignment: TradeProfileAssignment = {
    profileId: winner.def.id,
    name: winner.def.name,
    icon: winner.def.icon,
    color: winner.def.color,
    score: winner.score,
    reason: winner.reason,
    exitRules,
    legacy: winner.def.id === 'default',
  };
  logTradeProfileAssignment(assignment, ctx);
  return assignment;
}

function logTradeProfileAssignment(
  a: TradeProfileAssignment,
  ctx: TradeProfileMatchContext
): void {
  const sym = ctx.symbol || 'token';
  const er = a.exitRules;
  const exitBits = [
    er.takeProfitPct != null ? `TP ${er.takeProfitPct}%` : null,
    er.stopLossPct != null ? `SL ${er.stopLossPct}%` : null,
    er.trailingStopPct != null ? `trail ${er.trailingStopPct}%` : null,
    er.hardTimeLimitSec != null ? `timer ${er.hardTimeLimitSec}s` : null,
    er.sizeMultiplier != null && er.sizeMultiplier !== 1
      ? `size ×${er.sizeMultiplier}`
      : null,
  ]
    .filter(Boolean)
    .join(', ');
  console.log(
    `[trade-profiles] ASSIGN ${a.icon} ${a.name} (${a.profileId}) → ${sym}` +
      ` · score=${a.score.toFixed(2)} · ${a.reason}` +
      (exitBits ? ` · rules: ${exitBits}` : '') +
      (a.legacy ? ' · legacy' : '')
  );
}

export interface TradeProfileStamp {
  tradeProfileId: TradeProfileId;
  tradeProfileName: string;
  tradeProfileIcon: string;
  tradeProfileColor: string;
}

export function stampFromAssignment(
  a: TradeProfileAssignment
): TradeProfileStamp {
  return {
    tradeProfileId: a.profileId,
    tradeProfileName: a.name,
    tradeProfileIcon: a.icon,
    tradeProfileColor: a.color,
  };
}

/**
 * Apply profile exit overrides onto a freshly built position.
 * Scalp seed runs first when forced; then concrete TP/SL/timer overrides freeze.
 */
export function applyTradeProfileExitRules(
  position: {
    takeProfitPct: number;
    stopLossPct: number;
    trailingStopPct: number;
    scalpMode?: boolean;
    shortTermStrategyId?: ShortTermStrategyId;
    scalpDeadlineMs?: number;
    scalpTpPct?: number;
    scalpSlPct?: number;
    scalpMomentumFailDropPct?: number;
    openedAt: number;
  },
  rules: TradeProfileExitRules,
  seedShortTerm?: (
    id: ShortTermStrategyId,
    openedAt: number
  ) => Partial<{
    scalpMode: boolean;
    shortTermStrategyId: ShortTermStrategyId;
    scalpDeadlineMs: number;
    scalpTpPct: number;
    scalpSlPct: number;
    scalpMomentumFailDropPct: number;
    takeProfitPct: number;
    stopLossPct: number;
  }>
): void {
  if (rules.forceScalp && rules.shortTermStrategyId && seedShortTerm) {
    if (!position.scalpMode) {
      Object.assign(
        position,
        seedShortTerm(rules.shortTermStrategyId, position.openedAt)
      );
    } else if (!position.shortTermStrategyId && rules.shortTermStrategyId) {
      position.shortTermStrategyId = rules.shortTermStrategyId;
    }
  }

  if (rules.takeProfitPct != null && Number.isFinite(rules.takeProfitPct)) {
    position.takeProfitPct = rules.takeProfitPct;
    if (position.scalpMode || rules.overrideScalpParams) {
      position.scalpTpPct = rules.takeProfitPct;
    }
  }
  if (rules.stopLossPct != null && Number.isFinite(rules.stopLossPct)) {
    position.stopLossPct = rules.stopLossPct;
    if (position.scalpMode || rules.overrideScalpParams) {
      position.scalpSlPct = rules.stopLossPct;
    }
  }
  if (rules.trailingStopPct != null && Number.isFinite(rules.trailingStopPct)) {
    position.trailingStopPct = rules.trailingStopPct;
  }
  if (
    rules.hardTimeLimitSec != null &&
    Number.isFinite(rules.hardTimeLimitSec) &&
    rules.hardTimeLimitSec > 0 &&
    (position.scalpMode || rules.forceScalp)
  ) {
    position.scalpMode = true;
    position.scalpDeadlineMs =
      position.openedAt + Math.round(rules.hardTimeLimitSec) * 1000;
  }
}

export function hydrateTradeProfilesFromSettings(
  saved: { tradeProfiles?: Partial<TradeProfileRuntimeState> } | null | undefined
): void {
  const base = defaultRuntimeState();
  if (!saved?.tradeProfiles) {
    (config as { tradeProfiles: TradeProfileRuntimeState }).tradeProfiles = base;
    return;
  }
  const s = saved.tradeProfiles;
  if (typeof s.enabled === 'boolean') base.enabled = s.enabled;
  if (s.profiles && typeof s.profiles === 'object') {
    for (const id of ALL_IDS) {
      if (typeof s.profiles[id] === 'boolean') {
        base.profiles[id] = s.profiles[id]!;
      }
    }
  }
  base.profiles.default = true;
  (config as { tradeProfiles: TradeProfileRuntimeState }).tradeProfiles = base;
}

export function serializeTradeProfilesForPersist(): TradeProfileRuntimeState {
  return JSON.parse(JSON.stringify(ensureState())) as TradeProfileRuntimeState;
}

export function ensureTradeProfilesInitialized(): void {
  ensureState();
}
