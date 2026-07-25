/**
 * Multi-Profile trade assignment layer.
 *
 * Upgrade on top of the existing single strategyProfile / Risk / Strict stack:
 * - Multiple named profiles can be ON at once
 * - At entry, the best-matching enabled profile is chosen and stamped on the Position
 * - Exit params (TP/SL/trail/scalp) are frozen from that profile onto the trade
 * - Risk Level + Strict Mode remain global modifiers when resolving effective rules
 * - When multi-profile is OFF (or only Default is relevant), behaviour matches today
 *
 * Add new profiles by extending TRADE_PROFILE_CATALOG — no rewrite of monitor/exits.
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
  /** Freeze take-profit % on the position (omit = use global config at open) */
  takeProfitPct?: number;
  stopLossPct?: number;
  trailingStopPct?: number;
  /** Force scalp-style timed exit when assigned (uses shortTermStrategyId) */
  forceScalp?: boolean;
  shortTermStrategyId?: ShortTermStrategyId;
  /** Optional size multiplier vs dynamic size (1 = unchanged) */
  sizeMultiplier?: number;
}

export interface TradeProfileDefinition {
  id: TradeProfileId;
  name: string;
  /** Short emoji / glyph for dashboard badges */
  icon: string;
  /** CSS color for badge */
  color: string;
  description: string;
  /** Higher = preferred when scores tie */
  priority: number;
  /** Default enabled on fresh install */
  defaultEnabled: boolean;
  /** Soft match hints — scored at assignment time */
  match: {
    /** Prefer when resolveScalpBuyFlag armed a scalp (not dip) */
    preferScalp?: boolean;
    /** Prefer post_run_dip / peak drop setups */
    preferDip?: boolean;
    /** Prefer migration / near-migration / early curve */
    preferMigration?: boolean;
    /** Prefer high-conviction normal trend holds */
    preferTrend?: boolean;
    /** Prefer selective high-quality entries */
    preferHighWinRate?: boolean;
    /** Always eligible as fallback (Default) */
    always?: boolean;
    minConviction?: number;
  };
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
    priority: 0,
    defaultEnabled: true,
    match: { always: true },
    exitRules: {},
  },
  {
    id: 'scalper',
    name: 'Scalper',
    icon: '⚡',
    color: '#fbbf24',
    description: 'Timed scalps — quick TP/SL/timer from short-term strategies',
    priority: 80,
    defaultEnabled: true,
    match: { preferScalp: true },
    exitRules: {
      forceScalp: true,
      shortTermStrategyId: 'quick_scalper',
      sizeMultiplier: 0.85,
    },
  },
  {
    id: 'dip_buyer',
    name: 'Dip Buyer',
    icon: '↘',
    color: '#22d3ee',
    description: 'Post-run dip / mean-reversion entries with dip exit seeds',
    priority: 85,
    defaultEnabled: true,
    match: { preferDip: true, minConviction: 35 },
    exitRules: {
      forceScalp: true,
      shortTermStrategyId: 'post_run_dip',
      sizeMultiplier: 0.9,
    },
  },
  {
    id: 'migration',
    name: 'Migration',
    icon: '↗',
    color: '#a78bfa',
    description: 'Migration / near-migration priority entries',
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
    id: 'trend_rider',
    name: 'Trend Rider',
    icon: '▲',
    color: '#34d399',
    description: 'Higher-conviction holds with wider TP and trailing',
    priority: 55,
    defaultEnabled: true,
    match: { preferTrend: true, minConviction: 55 },
    exitRules: {
      takeProfitPct: 120,
      stopLossPct: 22,
      trailingStopPct: 16,
      sizeMultiplier: 1.0,
    },
  },
  {
    id: 'high_win_rate',
    name: 'High Win-Rate',
    icon: '◎',
    color: '#fb7185',
    description: 'Selective high-quality entries — tighter SL, disciplined TP',
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
  /** Master switch — when false, always assign Default (legacy behaviour) */
  enabled: boolean;
  /** Per-profile ON/OFF */
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
  /** True when multi-profile was OFF or only fallback used */
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
}

const ALL_IDS: TradeProfileId[] = TRADE_PROFILE_CATALOG.map((p) => p.id);

function defaultRuntimeState(): TradeProfileRuntimeState {
  const profiles = {} as Record<TradeProfileId, boolean>;
  for (const p of TRADE_PROFILE_CATALOG) {
    profiles[p.id] = p.defaultEnabled;
  }
  return {
    // ON by default so concurrent profiles work; Default always available as fallback
    enabled: true,
    profiles,
  };
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
  // Default must stay available as fallback when multi-profile is on
  if (id === 'default' && !enabled) {
    console.log('[trade-profiles] Default profile cannot be fully disabled');
    state.profiles.default = true;
  } else {
    state.profiles[id] = Boolean(enabled);
  }
  persistUserSettings();
  console.log(
    `[trade-profiles] ${id} → ${state.profiles[id] ? 'ON' : 'OFF'}`
  );
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

  const isDip =
    ctx.shortTermStrategyId === 'post_run_dip' ||
    (ctx.dropFromPeakPct != null && ctx.dropFromPeakPct >= 12);
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
    if (isDip) {
      score += 100;
      bits.push('dip setup');
      if (ctx.shortTermStrategyId === 'post_run_dip') {
        score += 20;
        bits.push('post_run_dip');
      }
    } else {
      return { score: 0, reason: 'not a dip setup' };
    }
  }

  if (m.preferScalp) {
    if (isScalp) {
      score += 90;
      bits.push(`scalp:${ctx.shortTermStrategyId}`);
    } else {
      return { score: 0, reason: 'not a scalp setup' };
    }
  }

  if (m.preferMigration) {
    if (isMig) {
      score += 85;
      bits.push(
        ctx.isMigration
          ? 'migration'
          : ctx.nearMigration
            ? 'near-migration'
            : 'early/priority'
      );
    } else {
      return { score: 0, reason: 'not a migration setup' };
    }
  }

  if (m.preferTrend) {
    if (!isScalp && !isDip && !isMig && conv != null && conv >= (m.minConviction ?? 55)) {
      score += 50 + Math.min(40, (conv - 55) * 0.8);
      bits.push(`trend conviction ${conv}`);
    } else {
      return { score: 0, reason: 'not a trend hold setup' };
    }
  }

  if (m.preferHighWinRate) {
    if (!isScalp && !isDip && conv != null && conv >= (m.minConviction ?? 65)) {
      score += 55 + Math.min(30, (conv - 65) * 0.6);
      bits.push(`high-quality conviction ${conv}`);
      if (config.strategyProfile === 'high_win_rate') {
        score += 15;
        bits.push('high_win_rate preset');
      }
    } else {
      return { score: 0, reason: 'not high-win-rate selective' };
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

  // Prefer the armed short-term id when Scalper/Dip wins
  const exitRules: TradeProfileExitRules = { ...winner.def.exitRules };
  if (
    (winner.def.id === 'scalper' || winner.def.id === 'dip_buyer') &&
    ctx.shortTermStrategyId
  ) {
    exitRules.shortTermStrategyId = ctx.shortTermStrategyId as ShortTermStrategyId;
    exitRules.forceScalp = true;
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
  console.log(
    `[trade-profiles] ASSIGN ${a.icon} ${a.name} (${a.profileId}) → ${sym}` +
      ` · score=${a.score.toFixed(2)} · ${a.reason}` +
      (a.legacy ? ' · legacy' : '')
  );
}

/** Fields stamped onto Position / BuyOptions */
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
 * Only overrides fields the profile specifies — leaves global-derived values otherwise.
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
  if (rules.takeProfitPct != null && Number.isFinite(rules.takeProfitPct)) {
    position.takeProfitPct = rules.takeProfitPct;
  }
  if (rules.stopLossPct != null && Number.isFinite(rules.stopLossPct)) {
    position.stopLossPct = rules.stopLossPct;
  }
  if (rules.trailingStopPct != null && Number.isFinite(rules.trailingStopPct)) {
    position.trailingStopPct = rules.trailingStopPct;
  }

  if (rules.forceScalp && rules.shortTermStrategyId && seedShortTerm) {
    // Only seed if not already armed by resolveScalpBuyFlag path
    if (!position.scalpMode) {
      Object.assign(
        position,
        seedShortTerm(rules.shortTermStrategyId, position.openedAt)
      );
    } else if (
      !position.shortTermStrategyId &&
      rules.shortTermStrategyId
    ) {
      position.shortTermStrategyId = rules.shortTermStrategyId;
    }
  }
}

/** Parse persisted settings blob into runtime state */
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

/** Ensure config.tradeProfiles exists after config load */
export function ensureTradeProfilesInitialized(): void {
  ensureState();
}
