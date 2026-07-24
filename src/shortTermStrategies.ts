/**
 * Short-term / scalper strategy framework.
 *
 * Shared seed + evaluate path for Quick Scalper and sibling timed modes.
 * Paper, Live Simulation, and backtester all call evaluateShortTermExit.
 */

import {
  config,
  DEFAULT_QUICK_SCALPER,
  DEFAULT_MICRO_SCALPER,
  DEFAULT_MOMENTUM_BURST,
  DEFAULT_POST_MIGRATION_SCALP,
  DEFAULT_REVERSAL_SCALP,
  getActiveScalpParamRanges,
  getScalperSuiteVariantLabel,
  isScalperSuiteProfile,
  persistUserSettings,
  type QuickScalperConfig,
  type MicroScalperConfig,
  type MomentumBurstConfig,
  type PostMigrationScalpConfig,
  type ReversalScalpConfig,
} from './config';

export type ShortTermStrategyId =
  | 'quick_scalper'
  | 'micro_scalper'
  | 'momentum_burst'
  | 'post_migration_scalp'
  | 'reversal_scalp';

export interface ShortTermStrategyDefinition {
  id: ShortTermStrategyId;
  label: string;
  description: string;
  frequencyNote: string;
}

/** Registry — extend here for future short-term modes. */
export const SHORT_TERM_STRATEGIES: readonly ShortTermStrategyDefinition[] = [
  {
    id: 'quick_scalper',
    label: 'Quick Scalper',
    description:
      'Fast entries on volume / buy pressure / smart money. Fixed TP, tight SL, hard time limit — auto-closes if neither hit.',
    frequencyNote: 'More short trades · holds measured in minutes',
  },
  {
    id: 'micro_scalper',
    label: 'Micro-Scalper',
    description:
      'Ultra-fast volume/buy spikes. Timer 60–90s (def 75), TP 15–22% (def 18), SL 6–10% (def 8).',
    frequencyNote: 'Many micro holds · seconds, not minutes',
  },
  {
    id: 'momentum_burst',
    label: 'Momentum Burst',
    description:
      'Sudden buy momentum. Timer 2–4 min (def 3), TP 28–40% (def 32), SL 10–14% (def 12). Exit on TP/SL/timer/fade.',
    frequencyNote: 'Burst trades · 2–4 minute windows',
  },
  {
    id: 'post_migration_scalp',
    label: 'Post-Migration Scalp',
    description:
      'Fresh migrations with meaningful volume only. Timer 90s–3 min (def 2 min), TP 25–38% (def 30), SL 9–13% (def 11).',
    frequencyNote: 'Migration-only · short post-grad holds',
  },
  {
    id: 'reversal_scalp',
    label: 'Reversal Scalp',
    description:
      'Optional selective wick snap-back. Timer 1–2.5 min (def 90s), TP 18–28% (def 22), SL 7–11% (def 9).',
    frequencyNote: 'Fewer trades · selective snap-back setups',
  },
] as const;

export type { QuickScalperConfig, MicroScalperConfig, MomentumBurstConfig, PostMigrationScalpConfig, ReversalScalpConfig };
export {
  DEFAULT_QUICK_SCALPER,
  DEFAULT_MICRO_SCALPER,
  DEFAULT_MOMENTUM_BURST,
  DEFAULT_POST_MIGRATION_SCALP,
  DEFAULT_REVERSAL_SCALP,
};

export interface ShortTermExitView {
  strategyId: ShortTermStrategyId;
  entryPriceSol: number;
  currentPriceSol: number;
  highWaterMarkSol?: number;
  openedAt: number;
  nowMs: number;
  deadlineMs: number;
  tpPct: number;
  slPct: number;
  /** Momentum Burst: exit if drop from peak ≥ this % before TP */
  momentumFailDropPct?: number;
}

export type ShortTermExitKind =
  | 'scalp_tp'
  | 'scalp_sl'
  | 'scalp_timer'
  | 'scalp_signal_fail';

export type ShortTermAction =
  | { type: 'none' }
  | { type: 'full'; reason: string; exitKind: ShortTermExitKind };

export interface ShortTermSeedFields {
  scalpMode: true;
  shortTermStrategyId: ShortTermStrategyId;
  scalpDeadlineMs: number;
  scalpTpPct: number;
  scalpSlPct: number;
  takeProfitPct: number;
  stopLossPct: number;
  scalpMomentumFailDropPct?: number;
}

export interface ShortTermEntryInput {
  volume24hUsd?: number | null;
  recentVolumeUsd?: number | null;
  recentBuyVolumeUsd?: number | null;
  isSmartMoney?: boolean;
  isMigration?: boolean;
  /** Drop from recent peak % (positive number, e.g. 30 = dumped 30%) */
  dropFromPeakPct?: number | null;
  convictionScore?: number | null;
  /** Prefer this id when profile is set */
  preferredId?: ShortTermStrategyId | null;
}

export interface ShortTermParams {
  id: ShortTermStrategyId;
  label: string;
  takeProfitPct: number;
  stopLossPct: number;
  minVolumeUsd: number;
  minBuyPressureUsd: number;
  maxHoldMs: number;
  momentumFailDropPct?: number;
  minDropFromPeakPct?: number;
  minConvictionScore?: number;
  requireMigration?: boolean;
}

const LABEL: Record<ShortTermStrategyId, string> = {
  quick_scalper: 'Quick Scalper',
  micro_scalper: 'Micro-Scalper',
  momentum_burst: 'Momentum Burst',
  post_migration_scalp: 'Post-Migration Scalp',
  reversal_scalp: 'Reversal Scalp',
};

function clampTp(tp: number, fallback: number, range?: { min: number; max: number }): number {
  if (!(Number.isFinite(tp) && tp > 0)) return fallback;
  if (range) return Math.min(range.max, Math.max(range.min, tp));
  return Math.min(200, tp);
}

function clampSl(sl: number, fallback: number, rangeAbs?: { min: number; max: number }): number {
  if (!(Number.isFinite(sl) && sl < 0)) return fallback;
  if (rangeAbs) {
    const abs = Math.abs(sl);
    const clamped = Math.min(rangeAbs.max, Math.max(rangeAbs.min, abs));
    return -clamped;
  }
  return Math.max(-80, sl);
}

function resolveHoldSeconds(
  seconds: number | undefined,
  legacyMinutes: number | undefined,
  range: { min: number; max: number; default: number }
): number {
  let sec = Number(seconds);
  if (!Number.isFinite(sec) || sec <= 0) {
    const mins = Number(legacyMinutes);
    sec = Number.isFinite(mins) && mins > 0 ? mins * 60 : range.default;
  }
  return Math.max(range.min, Math.min(range.max, Math.round(sec)));
}

export function getShortTermParams(id: ShortTermStrategyId): ShortTermParams {
  const ranges = getActiveScalpParamRanges();
  switch (id) {
    case 'micro_scalper': {
      const c = config.microScalper ?? DEFAULT_MICRO_SCALPER;
      const r = ranges.micro_scalper;
      const sec = resolveHoldSeconds(c.timeLimitSeconds, undefined, r.timerSec);
      return {
        id,
        label: LABEL[id],
        takeProfitPct: clampTp(Number(c.takeProfitPct), r.takeProfitPct.default, r.takeProfitPct),
        stopLossPct: clampSl(Number(c.stopLossPct), -r.stopLossAbs.default, r.stopLossAbs),
        minVolumeUsd: Math.max(0, Number(c.minVolumeUsd) || DEFAULT_MICRO_SCALPER.minVolumeUsd),
        minBuyPressureUsd: Math.max(
          0,
          Number(c.minBuyPressureUsd) || DEFAULT_MICRO_SCALPER.minBuyPressureUsd
        ),
        maxHoldMs: sec * 1000,
      };
    }
    case 'momentum_burst': {
      const c = config.momentumBurst ?? DEFAULT_MOMENTUM_BURST;
      const r = ranges.momentum_burst;
      const sec = resolveHoldSeconds(
        c.timeLimitSeconds,
        c.timeLimitMinutes,
        r.timerSec
      );
      const fail = Number(c.momentumFailDropPct);
      return {
        id,
        label: LABEL[id],
        takeProfitPct: clampTp(Number(c.takeProfitPct), r.takeProfitPct.default, r.takeProfitPct),
        stopLossPct: clampSl(Number(c.stopLossPct), -r.stopLossAbs.default, r.stopLossAbs),
        minVolumeUsd: Math.max(0, Number(c.minVolumeUsd) || DEFAULT_MOMENTUM_BURST.minVolumeUsd),
        minBuyPressureUsd: Math.max(
          0,
          Number(c.minBuyPressureUsd) || DEFAULT_MOMENTUM_BURST.minBuyPressureUsd
        ),
        maxHoldMs: sec * 1000,
        momentumFailDropPct:
          Number.isFinite(fail) && fail > 0
            ? Math.min(40, fail)
            : DEFAULT_MOMENTUM_BURST.momentumFailDropPct,
      };
    }
    case 'post_migration_scalp': {
      const c = config.postMigrationScalp ?? DEFAULT_POST_MIGRATION_SCALP;
      const r = ranges.post_migration_scalp;
      const sec = resolveHoldSeconds(
        c.timeLimitSeconds,
        c.timeLimitMinutes,
        r.timerSec
      );
      return {
        id,
        label: LABEL[id],
        takeProfitPct: clampTp(Number(c.takeProfitPct), r.takeProfitPct.default, r.takeProfitPct),
        stopLossPct: clampSl(Number(c.stopLossPct), -r.stopLossAbs.default, r.stopLossAbs),
        minVolumeUsd: Math.max(
          0,
          Number(c.minVolumeUsd) || DEFAULT_POST_MIGRATION_SCALP.minVolumeUsd
        ),
        minBuyPressureUsd: Math.max(
          0,
          Number(c.minBuyPressureUsd) || DEFAULT_POST_MIGRATION_SCALP.minBuyPressureUsd
        ),
        maxHoldMs: sec * 1000,
        requireMigration: true,
      };
    }
    case 'reversal_scalp': {
      const c = config.reversalScalp ?? DEFAULT_REVERSAL_SCALP;
      const r = ranges.reversal_scalp;
      const sec = resolveHoldSeconds(
        c.timeLimitSeconds,
        c.timeLimitMinutes,
        r.timerSec
      );
      const drop = Number(c.minDropFromPeakPct);
      const conv = Number(c.minConvictionScore);
      return {
        id,
        label: LABEL[id],
        takeProfitPct: clampTp(Number(c.takeProfitPct), r.takeProfitPct.default, r.takeProfitPct),
        stopLossPct: clampSl(Number(c.stopLossPct), -r.stopLossAbs.default, r.stopLossAbs),
        minVolumeUsd: Math.max(0, Number(c.minVolumeUsd) || DEFAULT_REVERSAL_SCALP.minVolumeUsd),
        minBuyPressureUsd: Math.max(
          0,
          Number(c.minBuyPressureUsd) || DEFAULT_REVERSAL_SCALP.minBuyPressureUsd
        ),
        maxHoldMs: sec * 1000,
        minDropFromPeakPct:
          Number.isFinite(drop) && drop > 0
            ? Math.min(90, drop)
            : DEFAULT_REVERSAL_SCALP.minDropFromPeakPct,
        minConvictionScore:
          Number.isFinite(conv) && conv >= 0
            ? Math.min(100, conv)
            : DEFAULT_REVERSAL_SCALP.minConvictionScore,
      };
    }
    case 'quick_scalper':
    default: {
      const qs = config.quickScalper ?? DEFAULT_QUICK_SCALPER;
      let mins = Number(qs.timeLimitMinutes);
      if (mins !== 1 && mins !== 2 && mins !== 3) mins = 2;
      return {
        id: 'quick_scalper',
        label: LABEL.quick_scalper,
        takeProfitPct: clampTp(Number(qs.takeProfitPct), DEFAULT_QUICK_SCALPER.takeProfitPct),
        stopLossPct: clampSl(Number(qs.stopLossPct), DEFAULT_QUICK_SCALPER.stopLossPct),
        minVolumeUsd: Math.max(0, Number(qs.minVolumeUsd) || DEFAULT_QUICK_SCALPER.minVolumeUsd),
        minBuyPressureUsd: Math.max(
          0,
          Number(qs.minBuyPressureUsd) || DEFAULT_QUICK_SCALPER.minBuyPressureUsd
        ),
        maxHoldMs: mins * 60_000,
      };
    }
  }
}

function isToggleOn(key: ShortTermStrategyId): boolean {
  return config.strategyToggles?.[key] === true;
}

export function isShortTermStrategyActive(id: ShortTermStrategyId): boolean {
  if (config.strategyProfile === id) return true;
  switch (id) {
    case 'quick_scalper':
      return config.quickScalper?.enabled === true || isToggleOn(id);
    case 'micro_scalper':
      return config.microScalper?.enabled === true || isToggleOn(id);
    case 'momentum_burst':
      return config.momentumBurst?.enabled === true || isToggleOn(id);
    case 'post_migration_scalp':
      return config.postMigrationScalp?.enabled === true || isToggleOn(id);
    case 'reversal_scalp':
      return config.reversalScalp?.enabled === true || isToggleOn(id);
    default:
      return false;
  }
}

/** Any short-term mode active (used for Strict speed overrides). */
export function isAnyShortTermScalperActive(): boolean {
  return SHORT_TERM_STRATEGIES.some((s) => isShortTermStrategyActive(s.id));
}

/** @deprecated use isAnyShortTermScalperActive / isShortTermStrategyActive */
export function isQuickScalperActive(): boolean {
  return isAnyShortTermScalperActive();
}

export function getQuickScalperParams() {
  const p = getShortTermParams('quick_scalper');
  const mins = Math.round(p.maxHoldMs / 60_000) as 1 | 2 | 3;
  return {
    timeLimitMinutes: (mins === 1 || mins === 3 ? mins : 2) as 1 | 2 | 3,
    takeProfitPct: p.takeProfitPct,
    stopLossPct: p.stopLossPct,
    minVolumeUsd: p.minVolumeUsd,
    minBuyPressureUsd: p.minBuyPressureUsd,
    maxHoldMs: p.maxHoldMs,
  };
}

function volumeOk(
  p: ShortTermParams,
  input: ShortTermEntryInput
): { ok: boolean; reason?: string } {
  const vol = Math.max(
    Number(input.volume24hUsd) || 0,
    Number(input.recentVolumeUsd) || 0
  );
  const buyPressure = Number(input.recentBuyVolumeUsd) || 0;

  if (p.minVolumeUsd > 0 && vol < p.minVolumeUsd && !input.isSmartMoney) {
    return {
      ok: false,
      reason: `${p.label} volume $${vol.toFixed(0)} < $${p.minVolumeUsd}`,
    };
  }
  if (
    p.minBuyPressureUsd > 0 &&
    buyPressure > 0 &&
    buyPressure < p.minBuyPressureUsd &&
    vol < p.minVolumeUsd
  ) {
    return {
      ok: false,
      reason: `${p.label} buy pressure $${buyPressure.toFixed(0)} < $${p.minBuyPressureUsd}`,
    };
  }
  if (vol <= 0 && buyPressure <= 0 && !input.isSmartMoney) {
    return {
      ok: false,
      reason: `${p.label} needs volume, buy pressure, or smart money`,
    };
  }
  return { ok: true };
}

export function qualifiesShortTermEntry(
  id: ShortTermStrategyId,
  input: ShortTermEntryInput
): { ok: boolean; reason?: string } {
  if (!isShortTermStrategyActive(id)) {
    return { ok: false, reason: `${LABEL[id]} off` };
  }
  const p = getShortTermParams(id);

  if (p.requireMigration && !input.isMigration) {
    return { ok: false, reason: `${p.label} requires fresh migration` };
  }

  if (p.minDropFromPeakPct != null && p.minDropFromPeakPct > 0) {
    const drop = Number(input.dropFromPeakPct) || 0;
    if (drop < p.minDropFromPeakPct) {
      return {
        ok: false,
        reason: `${p.label} needs ≥${p.minDropFromPeakPct}% wick/drop (have ${drop.toFixed(0)}%)`,
      };
    }
  }

  if (p.minConvictionScore != null && p.minConvictionScore > 0) {
    const conv = Number(input.convictionScore);
    if (!Number.isFinite(conv) || conv < p.minConvictionScore) {
      return {
        ok: false,
        reason: `${p.label} conviction ${Number.isFinite(conv) ? conv : '?'} < ${p.minConvictionScore}`,
      };
    }
  }

  // Momentum Burst requires meaningful buy pressure when available
  if (id === 'momentum_burst') {
    const buy = Number(input.recentBuyVolumeUsd) || 0;
    if (p.minBuyPressureUsd > 0 && buy > 0 && buy < p.minBuyPressureUsd) {
      return {
        ok: false,
        reason: `${p.label} buy momentum $${buy.toFixed(0)} < $${p.minBuyPressureUsd}`,
      };
    }
  }

  return volumeOk(p, input);
}

/** @deprecated use qualifiesShortTermEntry('quick_scalper', …) */
export function qualifiesQuickScalperEntry(
  input: ShortTermEntryInput
): { ok: boolean; reason?: string } {
  return qualifiesShortTermEntry('quick_scalper', input);
}

/**
 * Pick the best active short-term strategy for this signal.
 * Profile preference wins for single-mode presets; Scalper Suite uses
 * post-migration → micro → momentum → reversal priority across enabled members.
 */
export function resolveShortTermEntry(
  input: ShortTermEntryInput
): { id: ShortTermStrategyId; reason: string } | null {
  const suiteActive = isScalperSuiteProfile(config.strategyProfile);
  const suiteLabel = suiteActive
    ? getScalperSuiteVariantLabel(config.strategyProfile)
    : '';
  const preferred =
    input.preferredId ||
    (isShortTermProfileId(config.strategyProfile)
      ? (config.strategyProfile as ShortTermStrategyId)
      : null);

  const suiteOrder: ShortTermStrategyId[] = [
    'post_migration_scalp',
    'micro_scalper',
    'momentum_burst',
    'reversal_scalp',
  ];

  const order: ShortTermStrategyId[] = preferred
    ? [preferred]
    : suiteActive
      ? suiteOrder
      : [
          'post_migration_scalp',
          'reversal_scalp',
          'micro_scalper',
          'momentum_burst',
          'quick_scalper',
        ];

  for (const id of order) {
    if (!isShortTermStrategyActive(id)) continue;
    const q = qualifiesShortTermEntry(id, input);
    if (q.ok) {
      const suiteTag = suiteActive ? ` [${suiteLabel}]` : '';
      return {
        id,
        reason: `${LABEL[id]} entry qualified${suiteTag}`,
      };
    }
  }

  // If a named short-term profile is active but signal didn't qualify, no scalp
  if (preferred && isShortTermStrategyActive(preferred)) {
    return null;
  }

  // Suite profile: no fallback to quick_scalper
  if (suiteActive) return null;

  // Any active toggle that qualifies (re-scan if preferred failed)
  if (preferred) {
    for (const id of [
      'post_migration_scalp',
      'reversal_scalp',
      'micro_scalper',
      'momentum_burst',
      'quick_scalper',
    ] as ShortTermStrategyId[]) {
      if (id === preferred) continue;
      if (!isShortTermStrategyActive(id)) continue;
      const q = qualifiesShortTermEntry(id, input);
      if (q.ok) return { id, reason: `${LABEL[id]} entry qualified` };
    }
  }

  return null;
}

export function isShortTermProfileId(
  value: string | null | undefined
): value is ShortTermStrategyId {
  return SHORT_TERM_STRATEGIES.some((s) => s.id === value);
}

export function seedShortTermPosition(
  id: ShortTermStrategyId,
  openedAtMs: number
): ShortTermSeedFields {
  const p = getShortTermParams(id);
  const seed: ShortTermSeedFields = {
    scalpMode: true,
    shortTermStrategyId: id,
    scalpDeadlineMs: openedAtMs + p.maxHoldMs,
    scalpTpPct: p.takeProfitPct,
    scalpSlPct: p.stopLossPct,
    takeProfitPct: p.takeProfitPct,
    stopLossPct: p.stopLossPct,
  };
  if (p.momentumFailDropPct != null && p.momentumFailDropPct > 0) {
    seed.scalpMomentumFailDropPct = p.momentumFailDropPct;
  }
  return seed;
}

/** @deprecated use seedShortTermPosition('quick_scalper', …) */
export function seedQuickScalperPosition(openedAtMs: number): ShortTermSeedFields {
  return seedShortTermPosition('quick_scalper', openedAtMs);
}

/**
 * Evaluate short-term exit: SL → TP → momentum fail → timer.
 * Call before tiered profit strategy when scalpMode is set.
 */
export function evaluateShortTermExit(view: ShortTermExitView): ShortTermAction {
  if (!(view.entryPriceSol > 0) || !(view.currentPriceSol > 0)) {
    return { type: 'none' };
  }
  const label = LABEL[view.strategyId] || 'Scalp';
  const pnlPct =
    ((view.currentPriceSol - view.entryPriceSol) / view.entryPriceSol) * 100;

  if (pnlPct <= view.slPct) {
    return {
      type: 'full',
      exitKind: 'scalp_sl',
      reason: `${label} SL ${view.slPct}% (mark ${pnlPct.toFixed(1)}%)`,
    };
  }
  if (pnlPct >= view.tpPct) {
    return {
      type: 'full',
      exitKind: 'scalp_tp',
      reason: `${label} TP +${view.tpPct}% (mark +${pnlPct.toFixed(1)}%)`,
    };
  }

  // Momentum Burst: fade from peak before TP
  if (
    view.momentumFailDropPct != null &&
    view.momentumFailDropPct > 0 &&
    view.highWaterMarkSol != null &&
    view.highWaterMarkSol > view.entryPriceSol
  ) {
    const dropFromPeak =
      ((view.currentPriceSol - view.highWaterMarkSol) / view.highWaterMarkSol) *
      100;
    if (dropFromPeak <= -view.momentumFailDropPct) {
      return {
        type: 'full',
        exitKind: 'scalp_signal_fail',
        reason: `${label} momentum failure — ${dropFromPeak.toFixed(1)}% from peak (limit -${view.momentumFailDropPct}%, mark ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`,
      };
    }
  }

  if (view.nowMs >= view.deadlineMs) {
    const heldSec = Math.max(0, Math.round((view.nowMs - view.openedAt) / 1000));
    return {
      type: 'full',
      exitKind: 'scalp_timer',
      reason: `${label} timer expired after ${heldSec}s (mark ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`,
    };
  }
  return { type: 'none' };
}

export function shortTermExitLogTag(exitKind: ShortTermExitKind): string {
  switch (exitKind) {
    case 'scalp_tp':
      return 'SCALP_TP';
    case 'scalp_sl':
      return 'SCALP_SL';
    case 'scalp_timer':
      return 'SCALP_TIMER';
    case 'scalp_signal_fail':
      return 'SCALP_SIGNAL_FAIL';
    default:
      return 'SCALP_EXIT';
  }
}

function syncToggle(id: ShortTermStrategyId, enabled: boolean): void {
  if (!config.strategyToggles) config.strategyToggles = {};
  config.strategyToggles[id] = enabled;
}

function applySl(partial: number | undefined, assign: (n: number) => void): void {
  if (partial === undefined) return;
  let sl = Number(partial);
  if (!Number.isFinite(sl)) return;
  if (sl > 0) sl = -sl;
  if (sl < 0) assign(Math.max(-80, sl));
}

/** Update Quick Scalper knobs (Strategies tab settings). */
export function updateQuickScalperConfig(
  partial: Partial<QuickScalperConfig>,
  options?: { persist?: boolean }
): QuickScalperConfig {
  if (partial.enabled !== undefined) {
    config.quickScalper.enabled = Boolean(partial.enabled);
    syncToggle('quick_scalper', config.quickScalper.enabled);
  }
  if (partial.timeLimitMinutes !== undefined) {
    const m = Number(partial.timeLimitMinutes);
    config.quickScalper.timeLimitMinutes = m === 1 || m === 3 ? m : 2;
  }
  if (partial.takeProfitPct !== undefined) {
    const tp = Number(partial.takeProfitPct);
    if (Number.isFinite(tp) && tp > 0) {
      config.quickScalper.takeProfitPct = Math.min(200, tp);
    }
  }
  applySl(partial.stopLossPct, (n) => {
    config.quickScalper.stopLossPct = n;
  });
  if (partial.minVolumeUsd !== undefined) {
    config.quickScalper.minVolumeUsd = Math.max(0, Number(partial.minVolumeUsd) || 0);
  }
  if (partial.minBuyPressureUsd !== undefined) {
    config.quickScalper.minBuyPressureUsd = Math.max(
      0,
      Number(partial.minBuyPressureUsd) || 0
    );
  }
  if (options?.persist !== false) persistUserSettings();
  return { ...config.quickScalper };
}

export function updateMicroScalperConfig(
  partial: Partial<MicroScalperConfig>,
  options?: { persist?: boolean }
): MicroScalperConfig {
  const ranges = getActiveScalpParamRanges();
  if (partial.enabled !== undefined) {
    config.microScalper.enabled = Boolean(partial.enabled);
    syncToggle('micro_scalper', config.microScalper.enabled);
  }
  if (partial.timeLimitSeconds !== undefined) {
    let s = Number(partial.timeLimitSeconds);
    if (!Number.isFinite(s)) s = ranges.micro_scalper.timerSec.default;
    const r = ranges.micro_scalper.timerSec;
    config.microScalper.timeLimitSeconds = Math.max(r.min, Math.min(r.max, Math.round(s)));
  }
  if (partial.takeProfitPct !== undefined) {
    const tp = Number(partial.takeProfitPct);
    const r = ranges.micro_scalper.takeProfitPct;
    if (Number.isFinite(tp) && tp > 0) {
      config.microScalper.takeProfitPct = Math.min(r.max, Math.max(r.min, tp));
    }
  }
  applySl(partial.stopLossPct, (n) => {
    const r = ranges.micro_scalper.stopLossAbs;
    const abs = Math.min(r.max, Math.max(r.min, Math.abs(n)));
    config.microScalper.stopLossPct = -abs;
  });
  if (partial.minVolumeUsd !== undefined) {
    config.microScalper.minVolumeUsd = Math.max(0, Number(partial.minVolumeUsd) || 0);
  }
  if (partial.minBuyPressureUsd !== undefined) {
    config.microScalper.minBuyPressureUsd = Math.max(
      0,
      Number(partial.minBuyPressureUsd) || 0
    );
  }
  if (options?.persist !== false) persistUserSettings();
  return { ...config.microScalper };
}

export function updateMomentumBurstConfig(
  partial: Partial<MomentumBurstConfig>,
  options?: { persist?: boolean }
): MomentumBurstConfig {
  const ranges = getActiveScalpParamRanges();
  if (partial.enabled !== undefined) {
    config.momentumBurst.enabled = Boolean(partial.enabled);
    syncToggle('momentum_burst', config.momentumBurst.enabled);
  }
  if (partial.timeLimitSeconds !== undefined) {
    const r = ranges.momentum_burst.timerSec;
    let s = Number(partial.timeLimitSeconds);
    if (!Number.isFinite(s)) s = r.default;
    config.momentumBurst.timeLimitSeconds = Math.max(
      r.min,
      Math.min(r.max, Math.round(s))
    );
  } else if (partial.timeLimitMinutes !== undefined) {
    const m = Number(partial.timeLimitMinutes);
    const sec = (Number.isFinite(m) && m > 0 ? m : 3) * 60;
    const r = ranges.momentum_burst.timerSec;
    config.momentumBurst.timeLimitSeconds = Math.max(
      r.min,
      Math.min(r.max, Math.round(sec))
    );
  }
  if (partial.takeProfitPct !== undefined) {
    const tp = Number(partial.takeProfitPct);
    const r = ranges.momentum_burst.takeProfitPct;
    if (Number.isFinite(tp) && tp > 0) {
      config.momentumBurst.takeProfitPct = Math.min(r.max, Math.max(r.min, tp));
    }
  }
  applySl(partial.stopLossPct, (n) => {
    const r = ranges.momentum_burst.stopLossAbs;
    const abs = Math.min(r.max, Math.max(r.min, Math.abs(n)));
    config.momentumBurst.stopLossPct = -abs;
  });
  if (partial.minVolumeUsd !== undefined) {
    config.momentumBurst.minVolumeUsd = Math.max(0, Number(partial.minVolumeUsd) || 0);
  }
  if (partial.minBuyPressureUsd !== undefined) {
    config.momentumBurst.minBuyPressureUsd = Math.max(
      0,
      Number(partial.minBuyPressureUsd) || 0
    );
  }
  if (partial.momentumFailDropPct !== undefined) {
    const d = Number(partial.momentumFailDropPct);
    if (Number.isFinite(d) && d > 0) {
      config.momentumBurst.momentumFailDropPct = Math.min(40, d);
    }
  }
  if (options?.persist !== false) persistUserSettings();
  return { ...config.momentumBurst };
}

export function updatePostMigrationScalpConfig(
  partial: Partial<PostMigrationScalpConfig>,
  options?: { persist?: boolean }
): PostMigrationScalpConfig {
  const ranges = getActiveScalpParamRanges();
  if (partial.enabled !== undefined) {
    config.postMigrationScalp.enabled = Boolean(partial.enabled);
    syncToggle('post_migration_scalp', config.postMigrationScalp.enabled);
  }
  if (partial.timeLimitSeconds !== undefined) {
    const r = ranges.post_migration_scalp.timerSec;
    let s = Number(partial.timeLimitSeconds);
    if (!Number.isFinite(s)) s = r.default;
    config.postMigrationScalp.timeLimitSeconds = Math.max(
      r.min,
      Math.min(r.max, Math.round(s))
    );
  } else if (partial.timeLimitMinutes !== undefined) {
    const m = Number(partial.timeLimitMinutes);
    const sec = ([1, 2, 3].includes(m) ? m : 2) * 60;
    const r = ranges.post_migration_scalp.timerSec;
    config.postMigrationScalp.timeLimitSeconds = Math.max(
      r.min,
      Math.min(r.max, sec)
    );
  }
  if (partial.takeProfitPct !== undefined) {
    const tp = Number(partial.takeProfitPct);
    const r = ranges.post_migration_scalp.takeProfitPct;
    if (Number.isFinite(tp) && tp > 0) {
      config.postMigrationScalp.takeProfitPct = Math.min(r.max, Math.max(r.min, tp));
    }
  }
  applySl(partial.stopLossPct, (n) => {
    const r = ranges.post_migration_scalp.stopLossAbs;
    const abs = Math.min(r.max, Math.max(r.min, Math.abs(n)));
    config.postMigrationScalp.stopLossPct = -abs;
  });
  if (partial.minVolumeUsd !== undefined) {
    config.postMigrationScalp.minVolumeUsd = Math.max(
      0,
      Number(partial.minVolumeUsd) || 0
    );
  }
  if (partial.minBuyPressureUsd !== undefined) {
    config.postMigrationScalp.minBuyPressureUsd = Math.max(
      0,
      Number(partial.minBuyPressureUsd) || 0
    );
  }
  if (options?.persist !== false) persistUserSettings();
  return { ...config.postMigrationScalp };
}

export function updateReversalScalpConfig(
  partial: Partial<ReversalScalpConfig>,
  options?: { persist?: boolean }
): ReversalScalpConfig {
  const ranges = getActiveScalpParamRanges();
  if (partial.enabled !== undefined) {
    config.reversalScalp.enabled = Boolean(partial.enabled);
    syncToggle('reversal_scalp', config.reversalScalp.enabled);
  }
  if (partial.timeLimitSeconds !== undefined) {
    const r = ranges.reversal_scalp.timerSec;
    let s = Number(partial.timeLimitSeconds);
    if (!Number.isFinite(s)) s = r.default;
    config.reversalScalp.timeLimitSeconds = Math.max(
      r.min,
      Math.min(r.max, Math.round(s))
    );
  } else if (partial.timeLimitMinutes !== undefined) {
    const m = Number(partial.timeLimitMinutes);
    const sec = ([1, 2].includes(m) ? m : 1.5) * 60;
    const r = ranges.reversal_scalp.timerSec;
    config.reversalScalp.timeLimitSeconds = Math.max(
      r.min,
      Math.min(r.max, Math.round(sec))
    );
  }
  if (partial.takeProfitPct !== undefined) {
    const tp = Number(partial.takeProfitPct);
    const r = ranges.reversal_scalp.takeProfitPct;
    if (Number.isFinite(tp) && tp > 0) {
      config.reversalScalp.takeProfitPct = Math.min(r.max, Math.max(r.min, tp));
    }
  }
  applySl(partial.stopLossPct, (n) => {
    const r = ranges.reversal_scalp.stopLossAbs;
    const abs = Math.min(r.max, Math.max(r.min, Math.abs(n)));
    config.reversalScalp.stopLossPct = -abs;
  });
  if (partial.minVolumeUsd !== undefined) {
    config.reversalScalp.minVolumeUsd = Math.max(0, Number(partial.minVolumeUsd) || 0);
  }
  if (partial.minBuyPressureUsd !== undefined) {
    config.reversalScalp.minBuyPressureUsd = Math.max(
      0,
      Number(partial.minBuyPressureUsd) || 0
    );
  }
  if (partial.minDropFromPeakPct !== undefined) {
    const d = Number(partial.minDropFromPeakPct);
    if (Number.isFinite(d) && d > 0) {
      config.reversalScalp.minDropFromPeakPct = Math.min(90, d);
    }
  }
  if (partial.minConvictionScore !== undefined) {
    const c = Number(partial.minConvictionScore);
    if (Number.isFinite(c) && c >= 0) {
      config.reversalScalp.minConvictionScore = Math.min(100, c);
    }
  }
  if (options?.persist !== false) persistUserSettings();
  return { ...config.reversalScalp };
}
