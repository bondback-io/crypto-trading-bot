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
import type { TradeProfileId } from './tradeProfiles';

export type ProfileTaMode = 'off' | 'soft' | 'hard';
export type ProfileTaWhaleMode = 'off' | 'soft' | 'hard';
export type ProfileTaTimeframe = '5m' | '15m' | '1h' | '4h';

export type ProfileTaToolId =
  | 'ha'
  | 'supportResistance'
  | 'fib'
  | 'rsi'
  | 'ema'
  | 'vwap'
  | 'volumeExpansion'
  | 'patterns'
  | 'whale';

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
    taMode: 'off',
    entryTools: tools({ volumeExpansion: true, rsi: true }),
    exitTools: tools({}),
    timeframes: ['5m'],
    minConfluenceScore: 25,
    whaleMode: 'off',
    learningEnabled: false,
  }),
  migration_sniper: basePlaybook('migration_sniper', {
    taMode: 'soft',
    entryTools: tools({ volumeExpansion: true, rsi: true }),
    exitTools: tools({ volumeExpansion: true }),
    timeframes: ['5m', '15m'],
    minConfluenceScore: 30,
    whaleMode: 'soft',
    learningEnabled: true,
  }),
  momentum_burst: basePlaybook('momentum_burst', {
    taMode: 'soft',
    entryTools: tools({
      volumeExpansion: true,
      ha: true,
      rsi: true,
      ema: true,
    }),
    exitTools: tools({ ha: true, volumeExpansion: true, rsi: true }),
    timeframes: ['5m', '15m', '1h'],
    minConfluenceScore: 40,
    heikinAshi: { minConsecutive: 1, preferStrengthening: true },
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
    }),
    exitTools: tools({ patterns: true, ha: true, supportResistance: true }),
    timeframes: ['5m', '15m', '1h'],
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
      whale: true,
    }),
    exitTools: tools({
      ha: true,
      supportResistance: true,
      fib: true,
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
      volumeExpansion: true,
      supportResistance: true,
      ema: true,
      rsi: true,
      vwap: true,
    }),
    exitTools: tools({
      ha: true,
      supportResistance: true,
      rsi: true,
      volumeExpansion: true,
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
    }),
    exitTools: tools({
      ha: true,
      supportResistance: true,
      rsi: true,
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
    }),
    exitTools: tools({
      ha: true,
      supportResistance: true,
      rsi: true,
      whale: true,
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
    }),
    exitTools: tools({ whale: true, ha: true }),
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
        t === '5m' || t === '15m' || t === '1h' || t === '4h'
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

/**
 * Evaluate per-profile TA confluence for entry.
 * Soft never hard-blocks; Hard blocks below min when required tools fail or score low.
 */
export function evaluateProfileTaEntry(
  playbook: ProfileTaPlaybook,
  ctx: ProfileTaEntryContext
): ProfileTaEntryResult {
  const mode = playbook.taMode || 'off';
  const learned = playbook.learned || defaultLearned();
  const minScore = clamp(
    playbook.minConfluenceScore + (learned.minConfDelta || 0),
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
  const nearSupport = ctx.nearSupport === true || ctx.nearStrongSupport === true;
  const nearResistance = ctx.nearResistance === true;
  const nearFib = ctx.nearKeyFib === true;
  const patterns = Array.isArray(ctx.chartPatternIds)
    ? ctx.chartPatternIds.filter(Boolean)
    : [];

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
    const required =
      mode === 'hard' && playbook.supportResistance.preferNearSupport;
    if (playbook.supportResistance.preferNearSupport) {
      const pts = toolWeight(playbook, 'supportResistance', nearSupport ? 18 : 0);
      score += nearSupport ? pts : mode === 'soft' ? -3 : 0;
      conditions.push({
        id: 'supportResistance',
        passed: nearSupport,
        score: nearSupport ? pts : 0,
        detail: nearSupport ? 'near support' : 'not near support',
        required,
      });
    }
    if (playbook.supportResistance.avoidNearResistance && nearResistance) {
      const sens = clamp(learned.resistanceExitSensitivity || 1, 0.5, 1.5);
      const pen = Math.round(10 * sens);
      score -= pen;
      conditions.push({
        id: 'resistance',
        passed: false,
        score: -pen,
        detail: 'near resistance (avoid)',
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

  score = clamp(Math.round(score), 0, 100);

  const passed = conditions.filter((c) => c.passed).map((c) => c.id);
  const failed = conditions.filter((c) => !c.passed).map((c) => c.id);
  const requiredFailed = conditions.filter((c) => c.required && !c.passed);

  let allowed = true;
  let convictionMult = 1;
  let reason: string;

  if (mode === 'soft') {
    allowed = true;
    if (score < minScore) {
      convictionMult = clamp(0.75 + (score / Math.max(1, minScore)) * 0.2, 0.7, 1);
      reason = `TA Soft below min (${score}/${minScore}) — conviction ×${convictionMult.toFixed(2)}`;
    } else {
      convictionMult = clamp(1 + (score - minScore) / 200, 1, 1.12);
      reason = `TA Soft pass (${score}/${minScore})`;
    }
  } else {
    // hard
    if (requiredFailed.length > 0) {
      allowed = false;
      reason = `TA Hard blocked — required failed: ${requiredFailed.map((c) => c.id).join(',')}`;
    } else if (score < minScore) {
      allowed = false;
      reason = `TA Hard blocked — confluence ${score} < ${minScore}`;
    } else {
      allowed = true;
      convictionMult = clamp(1 + (score - minScore) / 250, 1, 1.1);
      reason = `TA Hard pass (${score}/${minScore})`;
    }
  }

  const haBias = ha.available ? ha.bias : undefined;
  const haConsecutive = ha.available
    ? ha.bias === 'bullish'
      ? ha.consecutiveBull
      : ha.consecutiveBear
    : undefined;

  const plainLanguage = [
    `TA ${mode === 'hard' ? 'Hard' : 'Soft'} ${score}/${minScore}`,
    ha.available ? `HA ${ha.bias} ${ha.consecutiveBull || ha.consecutiveBear}` : null,
    nearSupport ? 'near support' : null,
    nearResistance ? 'near resistance' : null,
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
  const whale = resolveWhaleState(ctx);

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
    ctx.nearResistance === true
  ) {
    conditions.push('near resistance');
    if (sens >= 1 && playbook.taMode === 'hard') {
      tightenTrail = true;
      if (sens >= 1.2) suggestExit = true;
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
  };
}

/** Stamp fields carried on BuyOptions / Position / episodes. */
export interface ProfileTaOpenStamp {
  taModeAtOpen?: ProfileTaMode;
  taToolsAtOpen?: ProfileTaToolId[];
  taConfluenceAtEntry?: number;
  haBiasAtEntry?: HaBias | null;
  haConsecutiveAtEntry?: number;
  nearSupportAtEntry?: boolean;
  nearResistanceAtEntry?: boolean;
  whaleStateAtEntry?: string;
  profileTaPlainLanguage?: string;
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
    const result = evaluateProfileTaEntry(playbook, ctx);
    const stamp: ProfileTaOpenStamp = {
      taModeAtOpen: result.snapshot.taMode,
      taToolsAtOpen: result.snapshot.tools,
      taConfluenceAtEntry: result.snapshot.confluence,
      haBiasAtEntry: result.snapshot.haBias,
      haConsecutiveAtEntry: result.snapshot.haConsecutive,
      nearSupportAtEntry: result.snapshot.nearSupport,
      nearResistanceAtEntry: result.snapshot.nearResistance,
      whaleStateAtEntry: result.snapshot.whaleState,
      profileTaPlainLanguage: result.plainLanguage,
    };
    if (!result.allowed) {
      return {
        skip: true,
        reason: result.reason,
        convictionMult: result.convictionMult,
        stamp,
        plainLanguage: result.plainLanguage,
        result,
      };
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
