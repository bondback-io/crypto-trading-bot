/**
 * Profile TA Expansion — per-lane Off/Soft/Hard playbooks.
 * Additive confluence over existing HA / Fib / S-R / indicators / whale flags.
 * Does not replace scanner playbooks, Require TA master, Peak Protection, or TP/SL.
 */

import {
  evaluateHaState,
  type HaBias,
  type HaCandleInput,
  type HaState,
} from './heikinAshi';
import type { IndicatorReport } from './indicators';
import type {
  ProfileTaIndicatorReport,
  MacdCross,
  HistSlope,
  ZigZagStructure,
  DivergenceBias,
} from './profileTaIndicators';
import { evaluateProfileTaIndicators } from './profileTaIndicators';
import type { TradeProfileId } from './tradeProfiles';

export type ProfileTaMode = 'off' | 'soft' | 'hard';
export type ProfileTaWhaleMode = 'off' | 'soft' | 'hard';
export type ProfileTaTimeframe = '5m' | '15m' | '30m' | '1h' | '4h';

export type ProfileTaToolId =
  | 'ha'
  | 'supportResistance'
  | 'fib'
  | 'rsi'
  | 'ema'
  | 'vwap'
  | 'volumeExpansion'
  | 'patterns'
  | 'whale'
  | 'macd'
  | 'macdHistSlope'
  | 'zigzag'
  | 'rsiDivergence'
  | 'volumeDivergence'
  | 'bollinger';

export const PROFILE_TA_TOOL_IDS: readonly ProfileTaToolId[] = [
  'ha',
  'supportResistance',
  'fib',
  'rsi',
  'ema',
  'vwap',
  'volumeExpansion',
  'patterns',
  'whale',
  'macd',
  'macdHistSlope',
  'zigzag',
  'rsiDivergence',
  'volumeDivergence',
  'bollinger',
] as const;

export const PROFILE_TA_TOOL_LABELS: Record<ProfileTaToolId, string> = {
  ha: 'Heikin Ashi',
  supportResistance: 'Support / Resistance',
  fib: 'Fibonacci',
  rsi: 'RSI',
  ema: 'EMA cross',
  vwap: 'VWAP',
  volumeExpansion: 'Volume expansion',
  patterns: 'Chart patterns',
  whale: 'Whale / smart money',
  macd: 'MACD 12/26/9',
  macdHistSlope: 'MACD hist slope',
  zigzag: 'ZigZag structure',
  rsiDivergence: 'RSI divergence',
  volumeDivergence: 'Volume divergence',
  bollinger: 'Bollinger 20/2',
};

export interface ProfileTaToolFlags {
  ha: boolean;
  supportResistance: boolean;
  fib: boolean;
  rsi: boolean;
  ema: boolean;
  vwap: boolean;
  volumeExpansion: boolean;
  patterns: boolean;
  whale: boolean;
  macd: boolean;
  macdHistSlope: boolean;
  zigzag: boolean;
  rsiDivergence: boolean;
  volumeDivergence: boolean;
  bollinger: boolean;
}

export interface ProfileTaHeikinPrefs {
  /** Prefer ≥N consecutive HA candles (Hard profiles typically 2+) */
  minConsecutive: number;
  preferStrengthening: boolean;
}

export interface ProfileTaSrPrefs {
  preferNearSupport: boolean;
  avoidNearResistance: boolean;
  preferFibConfluence: boolean;
}

/** Soft learned deltas — clamped; never touch TP/SL. */
export interface ProfileTaLearnedWeights {
  /** Per-tool score multipliers (default 1) */
  toolWeights: Partial<Record<ProfileTaToolId, number>>;
  /** Added to minConfluenceScore (−15…+15) */
  minConfDelta: number;
  /** Added to HA minConsecutive (−1…+2) */
  haConsecutiveDelta: number;
  /** Extra score weight for resistance-exit sensitivity (0.5…1.5) */
  resistanceExitSensitivity: number;
  /** Whale tool multiplier (0.5…1.5) */
  whaleWeight: number;
  /** RSI/volume divergence score multiplier (0.5…1.5) */
  divergenceSensitivity: number;
  /** MACD histogram slope score multiplier (0.5…1.5) */
  histSlopeSensitivity: number;
}

export interface ProfileTaPlaybook {
  profileId: string;
  taMode: ProfileTaMode;
  entryTools: ProfileTaToolFlags;
  exitTools: ProfileTaToolFlags;
  timeframes: ProfileTaTimeframe[];
  minConfluenceScore: number;
  heikinAshi: ProfileTaHeikinPrefs;
  supportResistance: ProfileTaSrPrefs;
  whaleMode: ProfileTaWhaleMode;
  learningEnabled: boolean;
  learned?: ProfileTaLearnedWeights;
}

export interface ProfileTaEntryContext {
  candles?: HaCandleInput[] | null;
  nearSupport?: boolean | null;
  nearResistance?: boolean | null;
  nearKeyFib?: boolean | null;
  nearStrongSupport?: boolean | null;
  /** Multi-TF S/R confluence (from scanner enrich / watch) */
  nearMultiTfSupport?: boolean | null;
  nearMultiTfResistance?: boolean | null;
  srConfluenceScore?: number | null;
  supportTfHits?: string[] | null;
  chartPatternIds?: string[] | null;
  indicators?: IndicatorReport | null;
  /** Precomputed HA state (optional — computed from candles if missing) */
  haState?: HaState | null;
  /** Whale / smart-money soft flags already on the signal */
  whaleBullish?: boolean | null;
  whaleBearish?: boolean | null;
  whaleAvailable?: boolean | null;
  smartMoneyScore?: number | null;
  volumeExpanding?: boolean | null;
  holdersExpanding?: boolean | null;
  /** Precomputed Profile TA pack (MACD/BB/ZigZag/div) — computed from candles if missing */
  profileTaIndicators?: ProfileTaIndicatorReport | null;
}

export interface ProfileTaCondition {
  id: ProfileTaToolId | string;
  passed: boolean;
  score: number;
  detail: string;
  required: boolean;
}

export interface ProfileTaEntryResult {
  profileId: string;
  mode: ProfileTaMode;
  score: number;
  minScore: number;
  allowed: boolean;
  /** Soft: multiply conviction / size (1 = neutral) */
  convictionMult: number;
  conditions: ProfileTaCondition[];
  passed: string[];
  failed: string[];
  reason: string;
  plainLanguage: string;
  haBias?: HaBias;
  haConsecutive?: number;
  nearSupport?: boolean;
  nearResistance?: boolean;
  whaleState?: 'bullish' | 'bearish' | 'neutral' | 'unavailable';
  snapshot: {
    taMode: ProfileTaMode;
    tools: ProfileTaToolId[];
    confluence: number;
    haBias: HaBias | null;
    haConsecutive: number;
    nearSupport: boolean;
    nearResistance: boolean;
    whaleState: string;
  };
}

export interface ProfileTaExitHint {
  suggestExit: boolean;
  tightenTrail: boolean;
  reason: string | null;
  plainLanguage: string;
  conditions: string[];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function emptyTools(allOff = true): ProfileTaToolFlags {
  const on = !allOff;
  return {
    ha: on,
    supportResistance: on,
    fib: on,
    rsi: on,
    ema: on,
    vwap: on,
    volumeExpansion: on,
    patterns: on,
    whale: on,
    macd: on,
    macdHistSlope: on,
    zigzag: on,
    rsiDivergence: on,
    volumeDivergence: on,
    bollinger: on,
  };
}

function tools(partial: Partial<ProfileTaToolFlags>): ProfileTaToolFlags {
  return { ...emptyTools(true), ...partial };
}

function defaultLearned(): ProfileTaLearnedWeights {
  return {
    toolWeights: {},
    minConfDelta: 0,
    haConsecutiveDelta: 0,
    resistanceExitSensitivity: 1,
    whaleWeight: 1,
    divergenceSensitivity: 1,
    histSlopeSensitivity: 1,
  };
}

function basePlaybook(
  profileId: string,
  patch: Partial<ProfileTaPlaybook>
): ProfileTaPlaybook {
  const entryTools = patch.entryTools
    ? { ...emptyTools(true), ...patch.entryTools }
    : emptyTools(true);
  const exitTools = patch.exitTools
    ? { ...emptyTools(true), ...patch.exitTools }
    : emptyTools(true);
  return {
    profileId,
    taMode: patch.taMode ?? 'soft',
    entryTools,
    exitTools,
    timeframes: patch.timeframes ?? ['5m', '1h'],
    minConfluenceScore: patch.minConfluenceScore ?? 40,
    heikinAshi: {
      minConsecutive: 1,
      preferStrengthening: false,
      ...(patch.heikinAshi || {}),
    },
    supportResistance: {
      preferNearSupport: false,
      avoidNearResistance: false,
      preferFibConfluence: false,
      ...(patch.supportResistance || {}),
    },
    whaleMode: patch.whaleMode ?? 'off',
    learningEnabled: patch.learningEnabled ?? true,
    learned: { ...defaultLearned(), ...(patch.learned || {}) },
  };
}

/** Catalog defaults — unique TA identity per lane. */
export const DEFAULT_PROFILE_TA_PLAYBOOKS: Record<string, ProfileTaPlaybook> = {
  scalper: basePlaybook('scalper', {
    taMode: 'soft',
    entryTools: tools({
      supportResistance: true,
      volumeExpansion: true,
      rsi: true,
    }),
    exitTools: tools({ supportResistance: true }),
    timeframes: ['5m', '15m', '30m'],
    minConfluenceScore: 28,
    supportResistance: {
      preferNearSupport: true,
      avoidNearResistance: false,
      preferFibConfluence: false,
    },
    whaleMode: 'off',
    learningEnabled: false,
  }),
  migration_sniper: basePlaybook('migration_sniper', {
    taMode: 'soft',
    entryTools: tools({ volumeExpansion: true, macd: true, rsi: true }),
    exitTools: tools({ volumeExpansion: true, macd: true }),
    timeframes: ['5m', '15m'],
    minConfluenceScore: 30,
    whaleMode: 'soft',
    learningEnabled: true,
  }),
  momentum_burst: basePlaybook('momentum_burst', {
    taMode: 'soft',
    entryTools: tools({
      volumeExpansion: true,
      macd: true,
      macdHistSlope: true,
      ha: true,
      rsi: true,
      supportResistance: true,
    }),
    exitTools: tools({
      ha: true,
      volumeExpansion: true,
      macdHistSlope: true,
      macd: true,
      supportResistance: true,
    }),
    timeframes: ['5m', '15m', '30m', '1h'],
    minConfluenceScore: 40,
    heikinAshi: { minConsecutive: 1, preferStrengthening: true },
    supportResistance: {
      preferNearSupport: true,
      avoidNearResistance: true,
      preferFibConfluence: false,
    },
    whaleMode: 'soft',
    learningEnabled: true,
  }),
  reversal_scalper: basePlaybook('reversal_scalper', {
    taMode: 'hard',
    entryTools: tools({
      patterns: true,
      supportResistance: true,
      fib: true,
      rsi: true,
      ha: true,
      rsiDivergence: true,
      bollinger: true,
    }),
    exitTools: tools({
      patterns: true,
      ha: true,
      supportResistance: true,
      rsiDivergence: true,
    }),
    timeframes: ['5m', '15m', '30m', '1h'],
    minConfluenceScore: 50,
    heikinAshi: { minConsecutive: 1, preferStrengthening: false },
    supportResistance: {
      preferNearSupport: true,
      avoidNearResistance: false,
      preferFibConfluence: true,
    },
    whaleMode: 'soft',
    learningEnabled: true,
  }),
  dip_buyer: basePlaybook('dip_buyer', {
    taMode: 'hard',
    entryTools: tools({
      fib: true,
      supportResistance: true,
      ha: true,
      rsi: true,
      rsiDivergence: true,
      volumeDivergence: true,
      whale: true,
      bollinger: true,
    }),
    exitTools: tools({
      ha: true,
      supportResistance: true,
      fib: true,
      rsiDivergence: true,
    }),
    timeframes: ['15m', '1h', '4h'],
    minConfluenceScore: 55,
    heikinAshi: { minConsecutive: 2, preferStrengthening: true },
    supportResistance: {
      preferNearSupport: true,
      avoidNearResistance: true,
      preferFibConfluence: true,
    },
    whaleMode: 'soft',
    learningEnabled: true,
  }),
  trend_rider: basePlaybook('trend_rider', {
    taMode: 'hard',
    entryTools: tools({
      ha: true,
      zigzag: true,
      macdHistSlope: true,
      volumeExpansion: true,
      ema: true,
      rsi: true,
      vwap: true,
      macd: true,
    }),
    exitTools: tools({
      ha: true,
      supportResistance: true,
      macd: true,
      macdHistSlope: true,
      rsiDivergence: true,
      volumeDivergence: true,
    }),
    timeframes: ['15m', '1h', '4h'],
    minConfluenceScore: 55,
    heikinAshi: { minConsecutive: 2, preferStrengthening: true },
    supportResistance: {
      preferNearSupport: false,
      avoidNearResistance: true,
      preferFibConfluence: false,
    },
    whaleMode: 'soft',
    learningEnabled: true,
  }),
  steady_compounder: basePlaybook('steady_compounder', {
    taMode: 'hard',
    entryTools: tools({
      ha: true,
      supportResistance: true,
      fib: true,
      ema: true,
      rsi: true,
      vwap: true,
      patterns: true,
      macd: true,
      zigzag: true,
      bollinger: true,
    }),
    exitTools: tools({
      ha: true,
      supportResistance: true,
      rsi: true,
      macd: true,
      rsiDivergence: true,
    }),
    timeframes: ['1h', '4h'],
    minConfluenceScore: 60,
    heikinAshi: { minConsecutive: 2, preferStrengthening: true },
    supportResistance: {
      preferNearSupport: true,
      avoidNearResistance: true,
      preferFibConfluence: true,
    },
    whaleMode: 'soft',
    learningEnabled: true,
  }),
  high_win_rate: basePlaybook('high_win_rate', {
    taMode: 'hard',
    entryTools: tools({
      ha: true,
      supportResistance: true,
      fib: true,
      ema: true,
      rsi: true,
      vwap: true,
      patterns: true,
      whale: true,
      macd: true,
      macdHistSlope: true,
      zigzag: true,
      rsiDivergence: true,
      volumeDivergence: true,
      bollinger: true,
    }),
    exitTools: tools({
      ha: true,
      supportResistance: true,
      rsi: true,
      whale: true,
      macd: true,
      macdHistSlope: true,
      rsiDivergence: true,
      volumeDivergence: true,
    }),
    timeframes: ['1h', '4h'],
    minConfluenceScore: 65,
    heikinAshi: { minConsecutive: 2, preferStrengthening: true },
    supportResistance: {
      preferNearSupport: true,
      avoidNearResistance: true,
      preferFibConfluence: true,
    },
    whaleMode: 'hard',
    learningEnabled: true,
  }),
  smart_money_mirror: basePlaybook('smart_money_mirror', {
    taMode: 'soft',
    entryTools: tools({
      whale: true,
      volumeExpansion: true,
      ha: true,
      rsi: true,
      macd: true,
    }),
    exitTools: tools({ whale: true, ha: true, macd: true }),
    timeframes: ['15m', '1h'],
    minConfluenceScore: 35,
    heikinAshi: { minConsecutive: 1, preferStrengthening: false },
    whaleMode: 'hard',
    learningEnabled: true,
  }),
  zion: basePlaybook('zion', {
    taMode: 'soft',
    entryTools: tools({ whale: true, ha: true }),
    exitTools: tools({}),
    timeframes: ['15m', '1h'],
    minConfluenceScore: 30,
    whaleMode: 'soft',
    learningEnabled: false,
  }),
  default: basePlaybook('default', {
    taMode: 'off',
    learningEnabled: false,
  }),
};

export function getDefaultProfileTaPlaybook(
  profileId: string
): ProfileTaPlaybook {
  const hit = DEFAULT_PROFILE_TA_PLAYBOOKS[profileId];
  if (hit) return clonePlaybook(hit);
  return clonePlaybook(DEFAULT_PROFILE_TA_PLAYBOOKS.default!);
}

export function clonePlaybook(p: ProfileTaPlaybook): ProfileTaPlaybook {
  return JSON.parse(JSON.stringify(p)) as ProfileTaPlaybook;
}

export function deepMergePlaybook(
  base: ProfileTaPlaybook,
  patch: Partial<ProfileTaPlaybook> | null | undefined
): ProfileTaPlaybook {
  if (!patch) return clonePlaybook(base);
  const out = clonePlaybook(base);
  if (patch.taMode) out.taMode = patch.taMode;
  if (patch.whaleMode) out.whaleMode = patch.whaleMode;
  if (typeof patch.minConfluenceScore === 'number') {
    out.minConfluenceScore = clamp(patch.minConfluenceScore, 0, 100);
  }
  if (typeof patch.learningEnabled === 'boolean') {
    out.learningEnabled = patch.learningEnabled;
  }
  if (Array.isArray(patch.timeframes)) {
    out.timeframes = patch.timeframes.filter(
      (t): t is ProfileTaTimeframe =>
        t === '5m' || t === '15m' || t === '30m' || t === '1h' || t === '4h'
    );
  }
  if (patch.entryTools) out.entryTools = { ...out.entryTools, ...patch.entryTools };
  if (patch.exitTools) out.exitTools = { ...out.exitTools, ...patch.exitTools };
  if (patch.heikinAshi) out.heikinAshi = { ...out.heikinAshi, ...patch.heikinAshi };
  if (patch.supportResistance) {
    out.supportResistance = {
      ...out.supportResistance,
      ...patch.supportResistance,
    };
  }
  if (patch.learned) {
    out.learned = {
      ...defaultLearned(),
      ...out.learned,
      ...patch.learned,
      toolWeights: {
        ...(out.learned?.toolWeights || {}),
        ...(patch.learned.toolWeights || {}),
      },
    };
  }
  return out;
}

function toolWeight(
  pb: ProfileTaPlaybook,
  tool: ProfileTaToolId,
  base: number
): number {
  const w = pb.learned?.toolWeights?.[tool];
  const mult = typeof w === 'number' && Number.isFinite(w) ? clamp(w, 0.5, 1.5) : 1;
  const whaleExtra =
    tool === 'whale' ? clamp(pb.learned?.whaleWeight ?? 1, 0.5, 1.5) : 1;
  return base * mult * whaleExtra;
}

function resolveWhaleState(ctx: ProfileTaEntryContext): {
  state: 'bullish' | 'bearish' | 'neutral' | 'unavailable';
  available: boolean;
} {
  if (ctx.whaleAvailable === false) {
    return { state: 'unavailable', available: false };
  }
  if (ctx.whaleBullish === true) return { state: 'bullish', available: true };
  if (ctx.whaleBearish === true) return { state: 'bearish', available: true };
  const sm = Number(ctx.smartMoneyScore);
  if (Number.isFinite(sm)) {
    if (sm >= 60) return { state: 'bullish', available: true };
    if (sm <= 35) return { state: 'bearish', available: true };
    return { state: 'neutral', available: true };
  }
  if (ctx.whaleAvailable === true) return { state: 'neutral', available: true };
  return { state: 'unavailable', available: false };
}

function resolveProfileTaIndicators(
  ctx: ProfileTaEntryContext
): ProfileTaIndicatorReport {
  if (ctx.profileTaIndicators?.available === true) {
    return ctx.profileTaIndicators;
  }
  if (ctx.candles && ctx.candles.length >= 20) {
    return evaluateProfileTaIndicators(ctx.candles);
  }
  return ctx.profileTaIndicators ?? evaluateProfileTaIndicators(null);
}

/**
 * Evaluate per-profile TA confluence for entry.
 * Soft never hard-blocks; Hard blocks below min when required tools fail or score low.
 */
export function evaluateProfileTaEntry(
  playbook: ProfileTaPlaybook,
  ctx: ProfileTaEntryContext
): ProfileTaEntryResult {
  let mode = playbook.taMode || 'off';
  try {
    const { effectiveTaModeForRecovery } =
      require('./fastProfileRecovery') as typeof import('./fastProfileRecovery');
    mode = effectiveTaModeForRecovery(playbook.profileId, mode);
  } catch {
    /* optional */
  }
  try {
    const { effectiveTaModeForDipBuyerRecovery } =
      require('./dipBuyerRecovery') as typeof import('./dipBuyerRecovery');
    mode = effectiveTaModeForDipBuyerRecovery(playbook.profileId, mode);
  } catch {
    /* optional */
  }
  const learned = playbook.learned || defaultLearned();
  let rlTaScale = 1;
  try {
    const { profileRlTaSensitivityScale } =
      require('./profileRlAgent') as typeof import('./profileRlAgent');
    rlTaScale = profileRlTaSensitivityScale(playbook.profileId).scale;
  } catch {
    /* optional */
  }
  let dbrConfBump = 0;
  try {
    const {
      dipBuyerRecoveryConfluenceBump,
      dipBuyerRecoverySupportFibMode,
    } = require('./dipBuyerRecovery') as typeof import('./dipBuyerRecovery');
    dbrConfBump = dipBuyerRecoveryConfluenceBump(playbook.profileId);
    void dipBuyerRecoverySupportFibMode;
  } catch {
    /* optional */
  }
  const minScore = clamp(
    (playbook.minConfluenceScore + (learned.minConfDelta || 0) + dbrConfBump) /
      rlTaScale,
    0,
    100
  );
  const haMin = clamp(
    (playbook.heikinAshi?.minConsecutive ?? 1) +
      (learned.haConsecutiveDelta || 0),
    1,
    6
  );

  const emptySnap = {
    taMode: mode,
    tools: [] as ProfileTaToolId[],
    confluence: 0,
    haBias: null as HaBias | null,
    haConsecutive: 0,
    nearSupport: Boolean(ctx.nearSupport),
    nearResistance: Boolean(ctx.nearResistance),
    whaleState: 'unavailable',
  };

  if (mode === 'off') {
    return {
      profileId: playbook.profileId,
      mode,
      score: 0,
      minScore,
      allowed: true,
      convictionMult: 1,
      conditions: [],
      passed: [],
      failed: [],
      reason: 'TA playbook Off — ignored',
      plainLanguage: 'TA Off',
      snapshot: emptySnap,
    };
  }

  const conditions: ProfileTaCondition[] = [];
  let score = 0;
  const enabledTools: ProfileTaToolId[] = [];

  const ha =
    ctx.haState?.available === true
      ? ctx.haState
      : evaluateHaState(ctx.candles);
  const whale = resolveWhaleState(ctx);
  const ind = ctx.indicators;
  const nearMultiTfSupport = ctx.nearMultiTfSupport === true;
  const nearMultiTfResistance = ctx.nearMultiTfResistance === true;
  const supportTfHits = Array.isArray(ctx.supportTfHits)
    ? ctx.supportTfHits.filter(Boolean)
    : [];
  const nearSupport =
    ctx.nearSupport === true ||
    ctx.nearStrongSupport === true ||
    nearMultiTfSupport;
  const nearResistance =
    ctx.nearResistance === true || nearMultiTfResistance;
  const nearFib = ctx.nearKeyFib === true;
  const patterns = Array.isArray(ctx.chartPatternIds)
    ? ctx.chartPatternIds.filter(Boolean)
    : [];
  const pta = resolveProfileTaIndicators(ctx);
  const divSens = clamp(learned.divergenceSensitivity ?? 1, 0.5, 1.5);
  const histSens = clamp(learned.histSlopeSensitivity ?? 1, 0.5, 1.5);
  const tfLabels = Array.isArray(playbook.timeframes)
    ? playbook.timeframes
    : [];
  const hitOnPlaybookTf =
    supportTfHits.length > 0 &&
    (tfLabels.length === 0 ||
      supportTfHits.some((t) => tfLabels.includes(t as ProfileTaTimeframe)));

  const et = playbook.entryTools;

  if (et.ha) {
    enabledTools.push('ha');
    const required = mode === 'hard';
    if (!ha.available) {
      const penalty = mode === 'soft' ? -6 : 0;
      score += penalty;
      conditions.push({
        id: 'ha',
        passed: false,
        score: penalty,
        detail: 'HA data missing',
        required,
      });
    } else {
      const consec =
        ha.bias === 'bullish' ? ha.consecutiveBull : ha.consecutiveBear;
      const bullOk =
        ha.bias === 'bullish' &&
        ha.consecutiveBull >= haMin &&
        (!playbook.heikinAshi.preferStrengthening ||
          ha.momentum !== 'weakening');
      const pts = toolWeight(playbook, 'ha', bullOk ? 22 : ha.bias === 'bullish' ? 10 : 0);
      if (bullOk || ha.bias === 'bullish') score += pts;
      else if (mode === 'soft' && ha.bias === 'bearish') score -= 4;
      conditions.push({
        id: 'ha',
        passed: bullOk,
        score: bullOk ? pts : ha.bias === 'bullish' ? pts : 0,
        detail: `HA ${ha.bias} ×${consec} ${ha.momentum}${ha.flip !== 'none' ? ` flip:${ha.flip}` : ''}`,
        required,
      });
    }
  }

  if (et.supportResistance) {
    enabledTools.push('supportResistance');
    const wantMtf =
      playbook.profileId === 'reversal_scalper' ||
      playbook.profileId === 'scalper' ||
      playbook.profileId === 'momentum_burst';
    const mtfAvailable = supportTfHits.length > 0 || ctx.srConfluenceScore != null;
    const supportOk = nearMultiTfSupport
      ? true
      : hitOnPlaybookTf
        ? nearSupport
        : nearSupport;
    // Reversal Hard: require multi-TF confluence when film is available
    const requireMtf =
      mode === 'hard' &&
      playbook.profileId === 'reversal_scalper' &&
      mtfAvailable &&
      playbook.supportResistance.preferNearSupport;
    const required =
      requireMtf ||
      (mode === 'hard' && playbook.supportResistance.preferNearSupport);
    if (playbook.supportResistance.preferNearSupport) {
      const basePts = nearMultiTfSupport ? 24 : supportOk ? 18 : 0;
      const pts = toolWeight(playbook, 'supportResistance', basePts);
      const passed = requireMtf ? nearMultiTfSupport : supportOk;
      score += passed ? pts : mode === 'soft' ? -3 : 0;
      // Soft size boost when confluence high (scalper family)
      if (mode === 'soft' && nearMultiTfSupport && wantMtf) {
        score += 4;
      }
      // Dip buyer: optional multi-TF as extra score
      if (
        playbook.profileId === 'dip_buyer' &&
        nearMultiTfSupport &&
        Number(ctx.srConfluenceScore ?? 0) >= 40
      ) {
        score += 6;
      }
      conditions.push({
        id: 'supportResistance',
        passed,
        score: passed ? pts : 0,
        detail: nearMultiTfSupport
          ? `multi-TF support (${supportTfHits.join('+') || 'conf'})`
          : supportOk
            ? tfLabels.length
              ? `near support (${tfLabels.join('/')})`
              : 'near support'
            : requireMtf
              ? 'need multi-TF support'
              : 'not near support',
        required,
      });
    }
    if (
      playbook.supportResistance.avoidNearResistance &&
      (nearResistance || nearMultiTfResistance)
    ) {
      const sens = clamp(learned.resistanceExitSensitivity || 1, 0.5, 1.5);
      const pen = Math.round((nearMultiTfResistance ? 14 : 10) * sens);
      score -= pen;
      conditions.push({
        id: 'resistance',
        passed: false,
        score: -pen,
        detail: nearMultiTfResistance
          ? 'multi-TF resistance (avoid)'
          : 'near resistance (avoid)',
        required: false,
      });
    }
  }

  if (et.fib) {
    enabledTools.push('fib');
    const want =
      playbook.supportResistance.preferFibConfluence || et.fib;
    if (want) {
      const pts = toolWeight(playbook, 'fib', nearFib ? 16 : 0);
      score += nearFib ? pts : 0;
      conditions.push({
        id: 'fib',
        passed: nearFib,
        score: nearFib ? pts : 0,
        detail: nearFib ? 'near key Fib' : 'no Fib confluence',
        required: mode === 'hard' && playbook.supportResistance.preferFibConfluence,
      });
    }
  }

  if (et.rsi) {
    enabledTools.push('rsi');
    const flags = ind?.flags || [];
    const ok =
      flags.includes('rsi_oversold') ||
      flags.includes('rsi_reset') ||
      flags.includes('mom_dip') ||
      (ind?.rsi14 != null && ind.rsi14 >= 45 && ind.rsi14 <= 70);
    const pts = toolWeight(playbook, 'rsi', ok ? 10 : 0);
    score += ok ? pts : 0;
    conditions.push({
      id: 'rsi',
      passed: ok,
      score: ok ? pts : 0,
      detail:
        ind?.rsi14 != null
          ? `RSI ${ind.rsi14.toFixed(0)}${ok ? ' ok' : ''}`
          : 'RSI unavailable',
      required: false,
    });
  }

  if (et.ema) {
    enabledTools.push('ema');
    const ok = ind?.emaBullishCross === true;
    const pts = toolWeight(playbook, 'ema', ok ? 12 : 0);
    score += ok ? pts : 0;
    conditions.push({
      id: 'ema',
      passed: ok,
      score: ok ? pts : 0,
      detail: ok ? 'EMA bullish cross' : 'no EMA cross',
      required: false,
    });
  }

  if (et.vwap) {
    enabledTools.push('vwap');
    const ok = ind?.vwapBias === 'above_vwap';
    const pts = toolWeight(playbook, 'vwap', ok ? 8 : 0);
    score += ok ? pts : 0;
    conditions.push({
      id: 'vwap',
      passed: ok,
      score: ok ? pts : 0,
      detail: ind?.vwapBias ? String(ind.vwapBias) : 'VWAP unavailable',
      required: false,
    });
  }

  if (et.volumeExpansion) {
    enabledTools.push('volumeExpansion');
    const ok =
      ctx.volumeExpanding === true ||
      ind?.flags?.includes('vol_expand') === true ||
      ctx.holdersExpanding === true;
    const pts = toolWeight(playbook, 'volumeExpansion', ok ? 14 : 0);
    score += ok ? pts : 0;
    conditions.push({
      id: 'volumeExpansion',
      passed: ok,
      score: ok ? pts : 0,
      detail: ok ? 'volume/activity expansion' : 'no volume expansion',
      required: false,
    });
  }

  if (et.patterns) {
    enabledTools.push('patterns');
    const ok = patterns.length > 0 || ind?.setup === true;
    const pts = toolWeight(playbook, 'patterns', ok ? 14 : 0);
    score += ok ? pts : 0;
    conditions.push({
      id: 'patterns',
      passed: ok,
      score: ok ? pts : 0,
      detail: ok
        ? patterns.length
          ? `patterns: ${patterns.slice(0, 3).join(',')}`
          : 'indicator setup'
        : 'no pattern/setup',
      required: mode === 'hard' && playbook.profileId === 'reversal_scalper',
    });
  }

  const whaleMode = playbook.whaleMode || 'off';
  if (et.whale && whaleMode !== 'off') {
    enabledTools.push('whale');
    const required = whaleMode === 'hard' && mode === 'hard';
    if (!whale.available) {
      const penalty = whaleMode === 'soft' || mode === 'soft' ? -4 : 0;
      score += penalty;
      conditions.push({
        id: 'whale',
        passed: false,
        score: penalty,
        detail: 'whale data missing',
        required,
      });
    } else {
      const ok = whale.state === 'bullish';
      const pts = toolWeight(playbook, 'whale', ok ? 16 : whale.state === 'neutral' ? 4 : 0);
      score += ok || whale.state === 'neutral' ? pts : mode === 'soft' ? -5 : 0;
      conditions.push({
        id: 'whale',
        passed: ok || (whaleMode === 'soft' && whale.state === 'neutral'),
        score: pts,
        detail: `whale ${whale.state}`,
        required,
      });
    }
  }

  if (et.macd) {
    enabledTools.push('macd');
    const m = pta.macd;
    const ok =
      m.available &&
      (m.cross === 'bull' ||
        m.histSlope === 'rising' ||
        (m.histogram != null && m.histogram > 0 && m.expansion === 'expanding'));
    const pts = toolWeight(playbook, 'macd', ok ? 14 : 0);
    score += ok ? pts : mode === 'soft' && m.available && m.cross === 'bear' ? -4 : 0;
    conditions.push({
      id: 'macd',
      passed: ok,
      score: ok ? pts : 0,
      detail: m.available
        ? `MACD ${m.cross !== 'none' ? m.cross : 'flat'} hist ${m.histSlope}`
        : 'MACD unavailable',
      required: false,
    });
  }

  if (et.macdHistSlope) {
    enabledTools.push('macdHistSlope');
    const m = pta.macd;
    const ok =
      m.available &&
      m.histSlope === 'rising' &&
      (m.expansion === 'expanding' || m.expansion === 'steady');
    const base = Math.round(12 * histSens);
    const pts = toolWeight(playbook, 'macdHistSlope', ok ? base : 0);
    score += ok ? pts : 0;
    const required =
      mode === 'hard' &&
      (playbook.profileId === 'trend_rider' ||
        playbook.profileId === 'high_win_rate');
    conditions.push({
      id: 'macdHistSlope',
      passed: ok,
      score: ok ? pts : 0,
      detail: m.available ? `hist ${m.histSlope} ${m.expansion}` : 'hist slope n/a',
      required,
    });
  }

  if (et.zigzag) {
    enabledTools.push('zigzag');
    const zz = pta.zigzag;
    const ok = zz.available && zz.intact && (zz.structure === 'HH' || zz.structure === 'HL');
    const pts = toolWeight(playbook, 'zigzag', ok ? 16 : zz.available && zz.structure !== 'unknown' ? 6 : 0);
    score += ok ? pts : zz.available && zz.structure === 'LL' && mode === 'soft' ? -5 : 0;
    const required = mode === 'hard' && playbook.profileId === 'trend_rider';
    conditions.push({
      id: 'zigzag',
      passed: ok,
      score: ok ? pts : 0,
      detail: zz.available
        ? `ZZ ${zz.structure}${zz.intact ? ' intact' : ''}`
        : 'ZigZag unavailable',
      required,
    });
  }

  if (et.rsiDivergence) {
    enabledTools.push('rsiDivergence');
    const div = pta.rsiDivergence;
    const ok = div.available && div.bias === 'bullish';
    const base = Math.round(14 * divSens);
    const pts = toolWeight(playbook, 'rsiDivergence', ok ? base : 0);
    score += ok ? pts : 0;
    conditions.push({
      id: 'rsiDivergence',
      passed: ok,
      score: ok ? pts : 0,
      detail: div.available ? div.detail : 'RSI div n/a',
      required: false,
    });
  }

  if (et.volumeDivergence) {
    enabledTools.push('volumeDivergence');
    const div = pta.volumeDivergence;
    const ok = div.available && div.bias === 'bullish';
    const base = Math.round(12 * divSens);
    const pts = toolWeight(playbook, 'volumeDivergence', ok ? base : 0);
    score += ok ? pts : 0;
    conditions.push({
      id: 'volumeDivergence',
      passed: ok,
      score: ok ? pts : 0,
      detail: div.available ? div.detail : 'vol div n/a',
      required: false,
    });
  }

  if (et.bollinger) {
    enabledTools.push('bollinger');
    const bb = pta.bollinger;
    const ok = bb.available && bb.bullishBias;
    const pts = toolWeight(playbook, 'bollinger', ok ? 8 : 0);
    score += ok ? pts : 0;
    conditions.push({
      id: 'bollinger',
      passed: ok,
      score: ok ? pts : 0,
      detail: bb.available
        ? bb.bullishBias
          ? 'BB soft-bull (mid/lower reclaim)'
          : `BB pos ${bb.bandPos != null ? bb.bandPos.toFixed(2) : 'n/a'}`
        : 'Bollinger unavailable',
      required: false,
    });
  }

  score = clamp(Math.round(score), 0, 100);

  // Dip Buyer Recovery: support + Fib confluence overlay
  try {
    const { dipBuyerRecoverySupportFibMode } =
      require('./dipBuyerRecovery') as typeof import('./dipBuyerRecovery');
    const sfMode = dipBuyerRecoverySupportFibMode(playbook.profileId);
    if (sfMode === 'required' || sfMode === 'preferred') {
      const both = nearSupport && nearFib;
      const pts = both ? (sfMode === 'required' ? 12 : 8) : 0;
      if (both) score = clamp(score + pts, 0, 100);
      conditions.push({
        id: 'dbr_support_fib',
        passed: both,
        score: pts,
        detail: both
          ? 'DBR support+Fib ok'
          : `DBR ${sfMode}: need support + Fib`,
        required: sfMode === 'required' && mode === 'hard',
      });
      if (sfMode === 'preferred' && !both && mode === 'soft') {
        // Soft preferred: mild conviction haircut, never hard-block
      }
    }
  } catch {
    /* optional */
  }

  const passed = conditions.filter((c) => c.passed).map((c) => c.id);
  const failed = conditions.filter((c) => !c.passed).map((c) => c.id);
  const requiredFailed = conditions.filter((c) => c.required && !c.passed);

  let allowed = true;
  let convictionMult = 1;
  let reason: string;

  if (mode === 'soft') {
    allowed = true;
    const effScore = score * rlTaScale;
    // DBR preferred support+fib: soft haircut when missing
    let dbrSoftPen = 1;
    try {
      const { dipBuyerRecoverySupportFibMode } =
        require('./dipBuyerRecovery') as typeof import('./dipBuyerRecovery');
      const sfMode = dipBuyerRecoverySupportFibMode(playbook.profileId);
      if (
        (sfMode === 'preferred' || sfMode === 'required') &&
        !(nearSupport && nearFib)
      ) {
        dbrSoftPen = sfMode === 'required' ? 0.82 : 0.9;
      }
    } catch {
      /* optional */
    }
    if (effScore < minScore) {
      convictionMult = clamp(
        (0.75 + (effScore / Math.max(1, minScore)) * 0.2) * dbrSoftPen,
        0.65,
        1
      );
      reason = `TA Soft below min (${Math.round(effScore)}/${Math.round(minScore)}) — conviction ×${convictionMult.toFixed(2)}`;
    } else {
      convictionMult = clamp(
        (1 + (effScore - minScore) / 200) * dbrSoftPen,
        0.7,
        1.12
      );
      reason = `TA Soft pass (${Math.round(effScore)}/${Math.round(minScore)})`;
    }
  } else {
    // hard
    const effScore = score * rlTaScale;
    if (requiredFailed.length > 0) {
      allowed = false;
      reason = `TA Hard blocked — required failed: ${requiredFailed.map((c) => c.id).join(',')}`;
    } else if (effScore < minScore) {
      allowed = false;
      reason = `TA Hard blocked — confluence ${Math.round(effScore)} < ${Math.round(minScore)}`;
    } else {
      allowed = true;
      convictionMult = clamp(1 + (effScore - minScore) / 250, 1, 1.1);
      reason = `TA Hard pass (${Math.round(effScore)}/${Math.round(minScore)})`;
    }
  }

  const haBias = ha.available ? ha.bias : undefined;
  const haConsecutive = ha.available
    ? ha.bias === 'bullish'
      ? ha.consecutiveBull
      : ha.consecutiveBear
    : undefined;

  const plainLanguage = [
    `TA ${mode === 'hard' ? 'Hard' : 'Soft'} ${Math.round(score * rlTaScale)}/${Math.round(minScore)}`,
    ha.available ? `HA ${ha.bias} ${ha.consecutiveBull || ha.consecutiveBear}` : null,
    nearSupport ? 'near support' : null,
    nearResistance ? 'near resistance' : null,
    pta.macd.available
      ? `MACD ${pta.macd.cross !== 'none' ? pta.macd.cross : 'flat'}`
      : null,
    pta.zigzag.available && pta.zigzag.structure !== 'unknown'
      ? `ZZ ${pta.zigzag.structure}`
      : null,
    pta.rsiDivergence.bias !== 'none' ? `RSI ${pta.rsiDivergence.bias} div` : null,
    pta.volumeDivergence.bias !== 'none' ? `Vol ${pta.volumeDivergence.bias} div` : null,
    whale.available ? `whale ${whale.state}` : null,
    allowed ? 'allowed' : 'blocked',
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    profileId: playbook.profileId,
    mode,
    score,
    minScore,
    allowed,
    convictionMult,
    conditions,
    passed,
    failed,
    reason,
    plainLanguage,
    haBias,
    haConsecutive,
    nearSupport,
    nearResistance,
    whaleState: whale.state,
    snapshot: {
      taMode: mode,
      tools: enabledTools,
      confluence: score,
      haBias: haBias ?? null,
      haConsecutive: haConsecutive ?? 0,
      nearSupport,
      nearResistance,
      whaleState: whale.state,
    },
  };
}

/**
 * Additive exit hints — never replaces TP/SL / Peak Protection.
 */
export function evaluateProfileTaExitHints(
  playbook: ProfileTaPlaybook,
  ctx: ProfileTaEntryContext & { unrealizedPct?: number | null }
): ProfileTaExitHint {
  if (playbook.taMode === 'off') {
    return {
      suggestExit: false,
      tightenTrail: false,
      reason: null,
      plainLanguage: 'TA Off',
      conditions: [],
    };
  }
  const xt = playbook.exitTools;
  const conditions: string[] = [];
  let suggestExit = false;
  let tightenTrail = false;
  const ha =
    ctx.haState?.available === true
      ? ctx.haState
      : evaluateHaState(ctx.candles);
  const sens = clamp(
    playbook.learned?.resistanceExitSensitivity ?? 1,
    0.5,
    1.5
  );
  let rlExitShift = 0;
  try {
    const { profileRlExitAggressivenessShift } =
      require('./profileRlAgent') as typeof import('./profileRlAgent');
    rlExitShift = profileRlExitAggressivenessShift(playbook.profileId).shift;
  } catch {
    /* optional */
  }
  const adjSens = clamp(sens * (1 + rlExitShift), 0.5, 1.5);
  const divSens = clamp(
    (playbook.learned?.divergenceSensitivity ?? 1) * (1 + rlExitShift * 0.5),
    0.5,
    1.5
  );
  const histSens = clamp(
    (playbook.learned?.histSlopeSensitivity ?? 1) * (1 + rlExitShift * 0.5),
    0.5,
    1.5
  );
  const whale = resolveWhaleState(ctx);
  const pta = resolveProfileTaIndicators(ctx);

  if (xt.ha && ha.available) {
    if (ha.flip === 'to_bear' || (ha.bias === 'bearish' && ha.momentum === 'strengthening')) {
      conditions.push(`HA ${ha.flip !== 'none' ? ha.flip : 'bearish weaken'}`);
      if (playbook.taMode === 'hard') suggestExit = true;
      else tightenTrail = true;
    } else if (ha.bias === 'bullish' && ha.momentum === 'weakening') {
      conditions.push('HA weakening');
      tightenTrail = true;
    }
  }

  if (
    (xt.supportResistance || playbook.supportResistance.avoidNearResistance) &&
    (ctx.nearResistance === true || ctx.nearMultiTfResistance === true)
  ) {
    conditions.push(
      ctx.nearMultiTfResistance === true
        ? 'multi-TF resistance'
        : 'near resistance'
    );
    if (adjSens >= 1 && playbook.taMode === 'hard') {
      tightenTrail = true;
      if (adjSens >= 1.2) suggestExit = true;
    } else {
      tightenTrail = true;
    }
  }

  if (xt.whale && playbook.whaleMode !== 'off' && whale.state === 'bearish') {
    conditions.push('whale distribution');
    if (playbook.whaleMode === 'hard') suggestExit = true;
    else tightenTrail = true;
  }

  if (xt.rsi && ctx.indicators?.flags?.includes('rsi_overbought')) {
    conditions.push('RSI overbought');
    tightenTrail = true;
  }

  if (xt.macd && pta.macd.available) {
    if (pta.macd.cross === 'bear') {
      conditions.push('MACD bear cross');
      if (playbook.taMode === 'hard') suggestExit = true;
      else tightenTrail = true;
    } else if (pta.macd.histSlope === 'falling' && (pta.macd.histogram ?? 0) < 0) {
      conditions.push('MACD hist falling');
      tightenTrail = true;
    }
  }

  if (xt.macdHistSlope && pta.macd.available) {
    if (
      pta.macd.histSlope === 'falling' ||
      (pta.macd.expansion === 'contracting' && (pta.macd.histogram ?? 0) <= 0)
    ) {
      conditions.push('MACD hist slope fail');
      if (playbook.taMode === 'hard' && histSens >= 1) {
        tightenTrail = true;
        if (histSens >= 1.2) suggestExit = true;
      } else {
        tightenTrail = true;
      }
    }
  }

  if (xt.rsiDivergence && pta.rsiDivergence.available) {
    if (pta.rsiDivergence.bias === 'bearish') {
      conditions.push('RSI bearish div');
      if (playbook.taMode === 'hard' && divSens >= 1) {
        tightenTrail = true;
        if (divSens >= 1.2) suggestExit = true;
      } else {
        tightenTrail = true;
      }
    }
  }

  if (xt.volumeDivergence && pta.volumeDivergence.available) {
    if (pta.volumeDivergence.bias === 'bearish') {
      conditions.push('volume bearish div');
      tightenTrail = true;
      if (playbook.taMode === 'hard' && divSens >= 1.15) suggestExit = true;
    }
  }

  const reason =
    suggestExit || tightenTrail
      ? `Profile TA exit: ${conditions.join(', ') || 'signal'}`
      : null;

  return {
    suggestExit,
    tightenTrail,
    reason,
    plainLanguage: reason
      ? `${suggestExit ? 'exit' : 'tighten'} · ${conditions.join(' · ')}`
      : 'TA exit quiet',
    conditions,
  };
}

export function formatProfileTaPlainLanguage(
  result: ProfileTaEntryResult
): string {
  return result.plainLanguage;
}

export function listProfileTaPlaybookIds(): string[] {
  return Object.keys(DEFAULT_PROFILE_TA_PLAYBOOKS).filter((id) => id !== 'default');
}

export function isTradeProfileIdForTa(id: string): id is TradeProfileId {
  return id in DEFAULT_PROFILE_TA_PLAYBOOKS;
}

/** Clamp learned weight patches (reversible, small). */
export function clampLearnedWeights(
  patch: Partial<ProfileTaLearnedWeights>
): ProfileTaLearnedWeights {
  const cur = defaultLearned();
  const toolWeights: Partial<Record<ProfileTaToolId, number>> = {};
  if (patch.toolWeights) {
    for (const [k, v] of Object.entries(patch.toolWeights)) {
      if ((PROFILE_TA_TOOL_IDS as readonly string[]).includes(k) && typeof v === 'number') {
        toolWeights[k as ProfileTaToolId] = clamp(v, 0.5, 1.5);
      }
    }
  }
  return {
    toolWeights,
    minConfDelta: clamp(
      Number(patch.minConfDelta ?? cur.minConfDelta) || 0,
      -15,
      15
    ),
    haConsecutiveDelta: clamp(
      Math.round(Number(patch.haConsecutiveDelta ?? cur.haConsecutiveDelta) || 0),
      -1,
      2
    ),
    resistanceExitSensitivity: clamp(
      Number(
        patch.resistanceExitSensitivity ?? cur.resistanceExitSensitivity
      ) || 1,
      0.5,
      1.5
    ),
    whaleWeight: clamp(
      Number(patch.whaleWeight ?? cur.whaleWeight) || 1,
      0.5,
      1.5
    ),
    divergenceSensitivity: clamp(
      Number(patch.divergenceSensitivity ?? cur.divergenceSensitivity) || 1,
      0.5,
      1.5
    ),
    histSlopeSensitivity: clamp(
      Number(patch.histSlopeSensitivity ?? cur.histSlopeSensitivity) || 1,
      0.5,
      1.5
    ),
  };
}

/** Stamp fields carried on BuyOptions / Position / episodes. */
export interface ProfileTaOpenStamp {
  taModeAtOpen?: ProfileTaMode;
  taToolsAtOpen?: ProfileTaToolId[];
  taToolsPassedAtEntry?: ProfileTaToolId[];
  taToolScoresAtEntry?: Partial<Record<ProfileTaToolId | string, number>>;
  taConfluenceAtEntry?: number;
  haBiasAtEntry?: HaBias | null;
  haConsecutiveAtEntry?: number;
  nearSupportAtEntry?: boolean;
  nearResistanceAtEntry?: boolean;
  nearMultiTfSupport?: boolean;
  nearMultiTfResistance?: boolean;
  supportTfHits?: string[];
  srConfluenceScore?: number;
  scalperWatchTriggered?: boolean;
  whaleStateAtEntry?: string;
  profileTaPlainLanguage?: string;
  zigzagStructureAtEntry?: ZigZagStructure | string;
  macdCrossAtEntry?: MacdCross | string;
  macdHistSlopeAtEntry?: HistSlope | string;
  rsiDivergenceAtEntry?: DivergenceBias | string;
  volumeDivergenceAtEntry?: DivergenceBias | string;
}

export interface ProfileTaGateResult {
  skip: boolean;
  reason: string;
  convictionMult: number;
  stamp: ProfileTaOpenStamp;
  plainLanguage: string;
  result: ProfileTaEntryResult | null;
}

/**
 * Fail-open gate for monitor buy paths. Loads playbook + evaluates confluence.
 */
export function runProfileTaEntryGate(
  profileId: string | null | undefined,
  ctx: ProfileTaEntryContext,
  getPlaybook: (id: string) => ProfileTaPlaybook
): ProfileTaGateResult {
  const id = String(profileId || 'default');
  try {
    const playbook = getPlaybook(id);
    const pta = resolveProfileTaIndicators(ctx);
    const result = evaluateProfileTaEntry(playbook, { ...ctx, profileTaIndicators: pta });
    const passedTools = result.passed.filter((id): id is ProfileTaToolId =>
      (PROFILE_TA_TOOL_IDS as readonly string[]).includes(id)
    );
    const toolScores: Partial<Record<ProfileTaToolId | string, number>> = {};
    for (const c of result.conditions) {
      if (typeof c.score === 'number' && Number.isFinite(c.score)) {
        toolScores[c.id] = c.score;
      }
    }
    const stamp: ProfileTaOpenStamp = {
      taModeAtOpen: result.snapshot.taMode,
      taToolsAtOpen: result.snapshot.tools,
      taToolsPassedAtEntry: passedTools,
      taToolScoresAtEntry: toolScores,
      taConfluenceAtEntry: result.snapshot.confluence,
      haBiasAtEntry: result.snapshot.haBias,
      haConsecutiveAtEntry: result.snapshot.haConsecutive,
      nearSupportAtEntry: result.snapshot.nearSupport,
      nearResistanceAtEntry: result.snapshot.nearResistance,
      nearMultiTfSupport: ctx.nearMultiTfSupport === true,
      nearMultiTfResistance: ctx.nearMultiTfResistance === true,
      supportTfHits: Array.isArray(ctx.supportTfHits)
        ? ctx.supportTfHits.filter(Boolean).map(String)
        : undefined,
      srConfluenceScore:
        ctx.srConfluenceScore != null && Number.isFinite(ctx.srConfluenceScore)
          ? Number(ctx.srConfluenceScore)
          : undefined,
      whaleStateAtEntry: result.snapshot.whaleState,
      profileTaPlainLanguage: result.plainLanguage,
      zigzagStructureAtEntry: pta.zigzag.structure,
      macdCrossAtEntry: pta.macd.cross,
      macdHistSlopeAtEntry: pta.macd.histSlope,
      rsiDivergenceAtEntry: pta.rsiDivergence.bias,
      volumeDivergenceAtEntry: pta.volumeDivergence.bias,
    };
    if (!result.allowed) {
      try {
        const { recordTaDecision } =
          require('./agentDecisionLog') as typeof import('./agentDecisionLog');
        recordTaDecision({
          profileId: id,
          summary: `Hard block: ${result.reason || result.plainLanguage || 'TA gate'}`,
          decisionType: 'warning',
          applied: 'applied',
          detail: result.plainLanguage,
          dedupeKey: `ta-hard:${id}`,
        });
      } catch {
        /* optional */
      }
      return {
        skip: true,
        reason: result.reason,
        convictionMult: result.convictionMult,
        stamp,
        plainLanguage: result.plainLanguage,
        result,
      };
    }
    if (
      result.convictionMult < 0.92 ||
      result.convictionMult > 1.08
    ) {
      try {
        const { recordTaDecision } =
          require('./agentDecisionLog') as typeof import('./agentDecisionLog');
        recordTaDecision({
          profileId: id,
          summary: `Soft conviction ×${result.convictionMult.toFixed(2)} — ${result.plainLanguage || result.reason}`,
          decisionType: 'soft_push',
          applied: 'applied',
          detail: result.reason,
          dedupeKey: `ta-soft:${id}:${result.convictionMult.toFixed(2)}`,
        });
      } catch {
        /* optional */
      }
    }
    return {
      skip: false,
      reason: result.reason,
      convictionMult: result.convictionMult,
      stamp,
      plainLanguage: result.plainLanguage,
      result,
    };
  } catch {
    return {
      skip: false,
      reason: 'TA playbook fail-open',
      convictionMult: 1,
      stamp: {},
      plainLanguage: 'TA fail-open',
      result: null,
    };
  }
}
