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
  DEFAULT_POST_RUN_DIP,
  CONSERVATIVE_POST_RUN_DIP,
  AGGRESSIVE_POST_RUN_DIP,
  POST_RUN_DIP_PROFILE_LABEL,
  getActiveScalpParamRanges,
  getScalperSuiteVariantLabel,
  isScalperSuiteProfile,
  persistUserSettings,
  type QuickScalperConfig,
  type MicroScalperConfig,
  type MomentumBurstConfig,
  type PostMigrationScalpConfig,
  type ReversalScalpConfig,
  type PostRunDipConfig,
  type PostRunDipProfile,
} from './config';

export type ShortTermStrategyId =
  | 'quick_scalper'
  | 'micro_scalper'
  | 'momentum_burst'
  | 'post_migration_scalp'
  | 'migration_event'
  | 'reversal_scalp'
  | 'post_run_dip';

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
      'Sudden buy momentum. Profile timer ~2.5–7 min, TP 28–45%, SL 10–14%. Exit on TP/SL/fade/stall/trail — timer is last resort.',
    frequencyNote: 'Burst trades · multi-minute windows',
  },
  {
    id: 'post_migration_scalp',
    label: 'Post-Migration Scalp',
    description:
      'Fresh migrations with meaningful volume only. Profile timer ~1.5–7 min, TP 25–45%, trail after modest green. Timer is a backstop.',
    frequencyNote: 'Migration-only · short post-grad holds',
  },
  {
    id: 'migration_event',
    label: 'Migration Event',
    description:
      'Pre-mig sweet-spot entry: hold through graduation, exit on first price spike + volume step-up. Wider SL; post-mig max hold is the backstop.',
    frequencyNote: 'Event holds · minutes around migration',
  },
  {
    id: 'reversal_scalp',
    label: 'Reversal Scalp',
    description:
      'Optional selective wick snap-back. Timer 1–2.5 min (def 90s), TP 18–28% (def 22), SL 7–11% (def 9).',
    frequencyNote: 'Fewer trades · selective snap-back setups',
  },
  {
    id: 'post_run_dip',
    label: 'Post-Run Dip / Rotation',
    description:
      'Higher-timeframe dip after a strong early run. Profiles: Standard, Conservative, or Aggressive Post-Run Dip. Prefers Fib levels / support. Exit: TP / SL (invalidation) / timer. Not an early sniper.',
    frequencyNote: 'Fewer trades · multi-hour dip holds',
  },
] as const;

export type {
  QuickScalperConfig,
  MicroScalperConfig,
  MomentumBurstConfig,
  PostMigrationScalpConfig,
  ReversalScalpConfig,
  PostRunDipConfig,
  PostRunDipProfile,
};
export {
  DEFAULT_QUICK_SCALPER,
  DEFAULT_MICRO_SCALPER,
  DEFAULT_MOMENTUM_BURST,
  DEFAULT_POST_MIGRATION_SCALP,
  DEFAULT_REVERSAL_SCALP,
  DEFAULT_POST_RUN_DIP,
  CONSERVATIVE_POST_RUN_DIP,
  AGGRESSIVE_POST_RUN_DIP,
  POST_RUN_DIP_PROFILE_LABEL,
};

export interface ShortTermExitView {
  strategyId: ShortTermStrategyId;
  entryPriceSol: number;
  currentPriceSol: number;
  highWaterMarkSol?: number;
  openedAt: number;
  nowMs: number;
  deadlineMs: number;
  /**
   * Absolute max hold (soft deadline may defer a green trade to trail).
   * Defaults to 1.4× the primary timer window when omitted.
   */
  hardDeadlineMs?: number;
  tpPct: number;
  slPct: number;
  /** Momentum Burst / scalp protect: exit if drop from peak ≥ this % before TP */
  momentumFailDropPct?: number;
}

/** Intra-timer trail for scalp profiles that freeze trailingStopPct */
export interface ScalpProtectiveTrailView {
  entryPriceSol: number;
  currentPriceSol: number;
  highWaterMarkSol: number;
  trailingActive: boolean;
  trailingStopPct?: number;
  trailingActivationProfit?: number;
}

export type ScalpProtectiveTrailAction =
  | { type: 'none' }
  | { type: 'arm_trail'; reason: string; trailPct: number }
  | { type: 'trail_exit'; reason: string };

export type ShortTermExitKind =
  | 'scalp_tp'
  | 'scalp_sl'
  | 'scalp_timer'
  | 'scalp_signal_fail'
  | 'mig_first_spike';

export type ShortTermAction =
  | { type: 'none' }
  | { type: 'full'; reason: string; exitKind: ShortTermExitKind };

export interface ShortTermSeedFields {
  scalpMode: true;
  shortTermStrategyId: ShortTermStrategyId;
  scalpDeadlineMs: number;
  scalpHardDeadlineMs: number;
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
  /** Post-migration spike % vs entry (migration_event) */
  spikePct?: number;
  /** Volume multiple vs baseline to confirm spike (migration_event) */
  volumeMult?: number;
  /** Max hold after migration detected (migration_event) */
  maxHoldAfterMigrateMs?: number;
}

const LABEL: Record<ShortTermStrategyId, string> = {
  quick_scalper: 'Quick Scalper',
  micro_scalper: 'Micro-Scalper',
  momentum_burst: 'Momentum Burst',
  post_migration_scalp: 'Post-Migration Scalp',
  migration_event: 'Migration Event',
  reversal_scalp: 'Reversal Scalp',
  post_run_dip: 'Post-Run Dip',
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
    case 'migration_event': {
      // Hold through migrate → first spike + volume. Defaults match MS catalog.
      return {
        id,
        label: LABEL[id],
        takeProfitPct: 12,
        stopLossPct: -15,
        minVolumeUsd: 0,
        minBuyPressureUsd: 0,
        maxHoldMs: 12 * 60_000,
        spikePct: 10,
        volumeMult: 1.45,
        maxHoldAfterMigrateMs: 4 * 60_000,
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
    case 'post_run_dip': {
      const c = config.postRunDip ?? DEFAULT_POST_RUN_DIP;
      let mins = Number(c.timeLimitMinutes);
      if (!Number.isFinite(mins) || mins < 30) mins = DEFAULT_POST_RUN_DIP.timeLimitMinutes;
      mins = Math.max(30, Math.min(240, Math.round(mins)));
      const tp = Number(c.takeProfitPct);
      const sl = Number(c.stopLossPct);
      return {
        id,
        label: LABEL[id],
        takeProfitPct: clampTp(
          tp,
          DEFAULT_POST_RUN_DIP.takeProfitPct,
          { min: 15, max: 80 }
        ),
        stopLossPct: clampSl(
          sl,
          DEFAULT_POST_RUN_DIP.stopLossPct,
          { min: 8, max: 30 }
        ),
        minVolumeUsd: Math.max(0, Number(c.minVolumeUsd) || DEFAULT_POST_RUN_DIP.minVolumeUsd),
        minBuyPressureUsd: 0,
        maxHoldMs: mins * 60_000,
        minDropFromPeakPct: Number(c.minDipFromPeakPct) || DEFAULT_POST_RUN_DIP.minDipFromPeakPct,
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
    case 'migration_event':
      // Always available when Migration Sniper profile seeds it (no separate toggle).
      return true;
    case 'reversal_scalp':
      return config.reversalScalp?.enabled === true || isToggleOn(id);
    case 'post_run_dip':
      return config.postRunDip?.enabled === true || isToggleOn(id);
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

  // Momentum Burst: enforce volume + buy-pressure floors (no smart-money bypass)
  if (id === 'momentum_burst') {
    const vol = Math.max(
      Number(input.volume24hUsd) || 0,
      Number(input.recentVolumeUsd) || 0
    );
    const buy = Number(input.recentBuyVolumeUsd) || 0;
    if (p.minVolumeUsd > 0 && vol < p.minVolumeUsd) {
      return {
        ok: false,
        reason: `${p.label} volume $${vol.toFixed(0)} < $${p.minVolumeUsd}`,
      };
    }
    if (p.minBuyPressureUsd > 0 && buy < p.minBuyPressureUsd) {
      return {
        ok: false,
        reason: `${p.label} buy momentum $${buy.toFixed(0)} < $${p.minBuyPressureUsd}`,
      };
    }
    return { ok: true };
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
    scalpHardDeadlineMs: openedAtMs + Math.round(p.maxHoldMs * 1.4),
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

/** View for Migration Sniper event-lane exit (hold → spike + volume). */
export interface MigrationEventExitView {
  entryPriceSol: number;
  currentPriceSol: number;
  openedAt: number;
  nowMs: number;
  /** Absolute safety deadline (total hold) */
  deadlineMs: number;
  hardDeadlineMs?: number;
  slPct: number;
  /** True once bonding curve complete / migration listener saw mint */
  migrated: boolean;
  migratedAtMs: number | null;
  /** Mark price when migration first detected (optional) */
  migrateMarkSol?: number | null;
  /** Recent / H1 volume USD */
  volumeUsd?: number | null;
  /** Volume baseline stamped at entry */
  volumeBaselineUsd?: number | null;
  spikePct?: number;
  volumeMult?: number;
  maxHoldAfterMigrateMs?: number;
}

/**
 * Migration Event exit: SL always → hold pre-mig → first spike+volume post-mig
 * → post-mig max hold → total safety timer.
 */
export function evaluateMigrationEventExit(
  view: MigrationEventExitView
): ShortTermAction {
  if (!(view.entryPriceSol > 0) || !(view.currentPriceSol > 0)) {
    return { type: 'none' };
  }
  const label = LABEL.migration_event;
  const pnlPct =
    ((view.currentPriceSol - view.entryPriceSol) / view.entryPriceSol) * 100;
  const ageMs = Math.max(0, view.nowMs - view.openedAt);
  const SL_GRACE_MS = 15_000;
  const SL_GRACE_RUG_PCT = -35;
  const slPct = view.slPct > 0 ? -Math.abs(view.slPct) : view.slPct;
  const spikePct =
    view.spikePct != null && view.spikePct > 0 ? view.spikePct : 10;
  const volumeMult =
    view.volumeMult != null && view.volumeMult > 1 ? view.volumeMult : 1.45;
  const maxAfter =
    view.maxHoldAfterMigrateMs != null && view.maxHoldAfterMigrateMs > 0
      ? view.maxHoldAfterMigrateMs
      : 4 * 60_000;
  const hardDeadlineMs =
    view.hardDeadlineMs != null && view.hardDeadlineMs > view.deadlineMs
      ? view.hardDeadlineMs
      : view.deadlineMs;

  if (pnlPct <= slPct) {
    const inGrace = ageMs < SL_GRACE_MS && pnlPct > SL_GRACE_RUG_PCT;
    if (!inGrace) {
      return {
        type: 'full',
        exitKind: 'scalp_sl',
        reason: `${label} SL ${slPct}% (mark ${pnlPct.toFixed(1)}%)`,
      };
    }
  }

  if (!view.migrated) {
    // Pre-migration: hold (no spike exit yet). Total safety still applies.
    if (view.nowMs >= hardDeadlineMs) {
      const heldSec = Math.max(0, Math.round(ageMs / 1000));
      return {
        type: 'full',
        exitKind: 'scalp_timer',
        reason: `${label} safety timer ${heldSec}s — never migrated (mark ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`,
      };
    }
    return { type: 'none' };
  }

  const migAt = view.migratedAtMs != null ? view.migratedAtMs : view.openedAt;
  const sinceMig = Math.max(0, view.nowMs - migAt);
  const migrateMark =
    view.migrateMarkSol != null && view.migrateMarkSol > 0
      ? view.migrateMarkSol
      : view.entryPriceSol;
  const spikeFromEntry = pnlPct >= spikePct;
  const spikeFromMig =
    ((view.currentPriceSol - migrateMark) / migrateMark) * 100 >= spikePct;
  const priceSpike = spikeFromEntry || spikeFromMig;

  const vol = view.volumeUsd;
  const base = view.volumeBaselineUsd;
  const volKnown =
    vol != null &&
    Number.isFinite(vol) &&
    vol > 0 &&
    base != null &&
    Number.isFinite(base) &&
    base > 0;
  const volumeOk = !volKnown || vol! >= base! * volumeMult;
  // If volume unknown for >20s post-mig, allow price-only spike
  const volumeBypass = !volKnown && sinceMig >= 20_000;

  if (priceSpike && (volumeOk || volumeBypass)) {
    return {
      type: 'full',
      exitKind: 'mig_first_spike',
      reason: `${label} first spike +${pnlPct.toFixed(1)}%${volKnown ? ` · vol $${Math.round(vol!)}` : ''}`,
    };
  }

  if (sinceMig >= maxAfter) {
    const heldSec = Math.max(0, Math.round(sinceMig / 1000));
    return {
      type: 'full',
      exitKind: 'scalp_timer',
      reason: `${label} post-mig max hold ${heldSec}s (mark ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`,
    };
  }

  if (view.nowMs >= hardDeadlineMs) {
    const heldSec = Math.max(0, Math.round(ageMs / 1000));
    return {
      type: 'full',
      exitKind: 'scalp_timer',
      reason: `${label} safety timer ${heldSec}s (mark ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`,
    };
  }

  return { type: 'none' };
}

/**
 * Evaluate short-term exit: SL → TP → momentum fail → underwater stall → timer.
 * Stall only cuts slightly-red marks with no pop (never green marks / fee traps).
 * Call before tiered profit strategy when scalpMode is set.
 *
 * SL has a short grace after open so fill/Dex mark mismatches cannot
 * instantly stop out a Scalper (seen as 0.1s holds with −10% phantom marks).
 *
 * Soft timer: Momentum Burst / post-migration defer any green or near-flat
 * mark (pnl ≥ −2%) until hardDeadline; other strategies still require a
 * meaningful soft-green pop (~25% of TP) before deferring to trail.
 *
 * For Migration Sniper event lane use evaluateMigrationEventExit instead.
 */
export function evaluateShortTermExit(view: ShortTermExitView): ShortTermAction {
  if (view.strategyId === 'migration_event') {
    return evaluateMigrationEventExit({
      entryPriceSol: view.entryPriceSol,
      currentPriceSol: view.currentPriceSol,
      openedAt: view.openedAt,
      nowMs: view.nowMs,
      deadlineMs: view.deadlineMs,
      hardDeadlineMs: view.hardDeadlineMs,
      slPct: view.slPct,
      migrated: false,
      migratedAtMs: null,
    });
  }
  if (!(view.entryPriceSol > 0) || !(view.currentPriceSol > 0)) {
    return { type: 'none' };
  }
  const label = LABEL[view.strategyId] || 'Scalp';
  const pnlPct =
    ((view.currentPriceSol - view.entryPriceSol) / view.entryPriceSol) * 100;
  const ageMs = Math.max(0, view.nowMs - view.openedAt);
  const windowMs = Math.max(1_000, view.deadlineMs - view.openedAt);
  const hardDeadlineMs =
    view.hardDeadlineMs != null && view.hardDeadlineMs > view.deadlineMs
      ? view.hardDeadlineMs
      : view.openedAt + Math.round(windowMs * 1.4);
  /** Ignore modest SL marks until feeds settle; still honour violent rugs. */
  const SL_GRACE_MS = 15_000;
  const SL_GRACE_RUG_PCT = -35;
  // Profiles may stamp positive loss magnitude; exit compare needs negative %.
  const slPct = view.slPct > 0 ? -Math.abs(view.slPct) : view.slPct;
  const hwm =
    view.highWaterMarkSol != null && view.highWaterMarkSol > 0
      ? view.highWaterMarkSol
      : view.entryPriceSol;
  const peakPnlPct =
    ((hwm - view.entryPriceSol) / view.entryPriceSol) * 100;

  if (pnlPct <= slPct) {
    const inGrace = ageMs < SL_GRACE_MS && pnlPct > SL_GRACE_RUG_PCT;
    if (!inGrace) {
      return {
        type: 'full',
        exitKind: 'scalp_sl',
        reason: `${label} SL ${slPct}% (mark ${pnlPct.toFixed(1)}%)`,
      };
    }
  }
  if (pnlPct >= view.tpPct) {
    return {
      type: 'full',
      exitKind: 'scalp_tp',
      reason: `${label} TP +${view.tpPct}% (mark +${pnlPct.toFixed(1)}%)`,
    };
  }

  // Fade from peak before TP (Momentum Burst + any profile that stamps fail %)
  if (
    view.momentumFailDropPct != null &&
    view.momentumFailDropPct > 0 &&
    hwm > view.entryPriceSol
  ) {
    const dropFromPeak =
      ((view.currentPriceSol - hwm) / hwm) * 100;
    if (dropFromPeak <= -view.momentumFailDropPct) {
      return {
        type: 'full',
        exitKind: 'scalp_signal_fail',
        reason: `${label} momentum failure — ${dropFromPeak.toFixed(1)}% from peak (limit -${view.momentumFailDropPct}%, mark ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`,
      };
    }
  }

  // Early stall: no meaningful pop by ~35% of the timer (1.2.248 tighter 0-MFE)
  // → cut only when stuck slightly red (never force-exit a green mark into fee+slip losses).
  // Skip for Post-Run Dip — those holds are designed to wait through quiet periods.
  // Round-trip paper cost (fee×2 + slip×2) raises the "pop" bar so a peak that
  // still couldn't cover costs does not count as momentum.
  const stallAfterMs = Math.max(40_000, Math.round(windowMs * 0.35));
  if (
    view.strategyId !== 'post_run_dip' &&
    ageMs >= stallAfterMs &&
    view.nowMs < view.deadlineMs
  ) {
    const feeBps = Number(config.paper?.feeBps) || 30;
    const slipBps = Number(config.paper?.slippageBps) || 150;
    const roundTripCostPct = (feeBps * 2 + slipBps * 2) / 100;
    // Slightly higher pop bar so true 0-MFE stalls exit sooner
    const peakPopPct = Math.max(4.5, roundTripCostPct + 1.25);
    // Cost-aware: also refuse stall when mark already covers ~¼ of RT costs
    // (redundant with pnlPct >= 0 at default ~3.6% RT, but keeps the floor
    // if fees/slip are dialed down).
    const nearBreakevenAfterCosts = pnlPct >= roundTripCostPct * 0.25;
    const neverPopped = peakPnlPct < peakPopPct;
    // Allow slightly deeper red stall cut (−3.0% vs −2.5%) for 0-MFE spam
    const stuckSlightlyRed = pnlPct < 0 && pnlPct > -3.0;
    if (neverPopped && stuckSlightlyRed && !nearBreakevenAfterCosts) {
      const heldSec = Math.max(0, Math.round(ageMs / 1000));
      return {
        type: 'full',
        exitKind: 'scalp_signal_fail',
        reason: `${label} stalled underwater after ${heldSec}s (peak +${peakPnlPct.toFixed(1)}%, mark ${pnlPct.toFixed(1)}%, RT ~${roundTripCostPct.toFixed(1)}%)`,
      };
    }
  }

  if (view.nowMs >= view.deadlineMs) {
    const heldSec = Math.max(0, Math.round(ageMs / 1000));
    const burstStyle =
      view.strategyId === 'momentum_burst' ||
      view.strategyId === 'post_migration_scalp';
    if (burstStyle) {
      // Defer any green / near-flat until hard deadline — only Timer when red/dead
      const nearFlatOrGreen = pnlPct >= -2;
      if (nearFlatOrGreen && view.nowMs < hardDeadlineMs) {
        return { type: 'none' };
      }
    } else {
      // Soft green floor: ~25% of the way to TP (capped) — defer dump to trail
      const softGreen = Math.min(
        12,
        Math.max(5, Number.isFinite(view.tpPct) ? view.tpPct * 0.25 : 5)
      );
      const stillWorking =
        pnlPct >= softGreen && peakPnlPct >= softGreen && hwm > view.entryPriceSol;
      if (stillWorking && view.nowMs < hardDeadlineMs) {
        return { type: 'none' };
      }
    }
    return {
      type: 'full',
      exitKind: 'scalp_timer',
      reason: `${label} timer expired after ${heldSec}s (mark ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`,
    };
  }
  return { type: 'none' };
}

/**
 * Protective trail for scalp positions that carry profile trailingStopPct.
 * Previously scalpMode skipped all trail logic → Migration/Momentum always
 * waited for the hard timer and dumped near-flat marks.
 */
export function evaluateScalpProtectiveTrail(
  view: ScalpProtectiveTrailView
): ScalpProtectiveTrailAction {
  const trailPct = view.trailingStopPct;
  if (
    trailPct == null ||
    !Number.isFinite(trailPct) ||
    trailPct <= 0 ||
    !(view.entryPriceSol > 0) ||
    !(view.currentPriceSol > 0) ||
    !(view.highWaterMarkSol > 0)
  ) {
    return { type: 'none' };
  }
  const pnlPct =
    ((view.currentPriceSol - view.entryPriceSol) / view.entryPriceSol) * 100;
  const activation =
    view.trailingActivationProfit != null &&
    Number.isFinite(view.trailingActivationProfit) &&
    view.trailingActivationProfit > 0
      ? view.trailingActivationProfit
      : Math.max(8, trailPct);

  if (!view.trailingActive && pnlPct >= activation) {
    return {
      type: 'arm_trail',
      trailPct,
      reason: `Scalp trail ARMED at +${pnlPct.toFixed(1)}% — ${trailPct}% from peak`,
    };
  }
  if (!view.trailingActive) return { type: 'none' };

  const trailTrigger = view.highWaterMarkSol * (1 - trailPct / 100);
  if (view.currentPriceSol <= trailTrigger) {
    const dropFromPeak =
      ((view.currentPriceSol - view.highWaterMarkSol) /
        view.highWaterMarkSol) *
      100;
    return {
      type: 'trail_exit',
      reason: `scalp trailing stop ${trailPct}% (peak drop ${dropFromPeak.toFixed(1)}%)`,
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
    case 'mig_first_spike':
      return 'MIG_FIRST_SPIKE';
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

export function updatePostRunDipConfig(
  partial: Partial<PostRunDipConfig>,
  options?: { persist?: boolean }
): PostRunDipConfig {
  if (!config.postRunDip) {
    config.postRunDip = { ...DEFAULT_POST_RUN_DIP };
  }
  // Applying a named profile replaces thresholds (keeps enabled state)
  if (
    partial.profile === 'standard' ||
    partial.profile === 'conservative' ||
    partial.profile === 'aggressive'
  ) {
    return applyPostRunDipProfile(partial.profile, {
      persist: options?.persist,
      enabled: partial.enabled,
    });
  }
  if (partial.enabled !== undefined) {
    config.postRunDip.enabled = Boolean(partial.enabled);
    syncToggle('post_run_dip', config.postRunDip.enabled);
    config.filters.enablePostRunDip = config.postRunDip.enabled;
  }
  if (
    partial.sensitivity === 'low' ||
    partial.sensitivity === 'medium' ||
    partial.sensitivity === 'high'
  ) {
    config.postRunDip.sensitivity = partial.sensitivity;
    config.filters.postRunDipSensitivity = partial.sensitivity;
  }
  if (partial.timeLimitMinutes !== undefined) {
    const m = Number(partial.timeLimitMinutes);
    if (Number.isFinite(m)) {
      config.postRunDip.timeLimitMinutes = Math.max(30, Math.min(240, Math.round(m)));
    }
  }
  if (partial.setupWatchMinutes !== undefined) {
    const m = Number(partial.setupWatchMinutes);
    if (Number.isFinite(m)) {
      config.postRunDip.setupWatchMinutes = Math.max(15, Math.min(180, Math.round(m)));
    }
  }
  if (partial.takeProfitPct !== undefined) {
    const tp = Number(partial.takeProfitPct);
    if (Number.isFinite(tp) && tp > 0) {
      config.postRunDip.takeProfitPct = Math.min(80, Math.max(15, tp));
    }
  }
  applySl(partial.stopLossPct, (n) => {
    const abs = Math.min(30, Math.max(8, Math.abs(n)));
    config.postRunDip.stopLossPct = -abs;
  });
  for (const key of [
    'minRunPct',
    'maxRunPct',
    'minDipFromPeakPct',
    'maxDipFromPeakPct',
    'minTokenAgeHours',
    'maxTokenAgeHours',
    'minVolumeUsd',
    'minLiquidityUsd',
    'minHolders',
    'boostPoints',
    'boostPointsMax',
    'nearTechnicalPct',
    'minQualifyScore',
  ] as const) {
    if (partial[key] !== undefined) {
      const n = Number(partial[key]);
      if (!Number.isFinite(n)) continue;
      if (key === 'minRunPct')
        config.postRunDip.minRunPct = Math.max(20, Math.min(500, n));
      else if (key === 'maxRunPct')
        config.postRunDip.maxRunPct = Math.max(50, Math.min(1000, n));
      else if (key === 'minDipFromPeakPct')
        config.postRunDip.minDipFromPeakPct = Math.max(5, Math.min(80, n));
      else if (key === 'maxDipFromPeakPct')
        config.postRunDip.maxDipFromPeakPct = Math.max(20, Math.min(90, n));
      else if (key === 'minTokenAgeHours')
        config.postRunDip.minTokenAgeHours = Math.max(1, Math.min(72, n));
      else if (key === 'maxTokenAgeHours')
        config.postRunDip.maxTokenAgeHours = Math.max(6, Math.min(120, n));
      else if (key === 'minVolumeUsd')
        config.postRunDip.minVolumeUsd = Math.max(0, n);
      else if (key === 'minLiquidityUsd')
        config.postRunDip.minLiquidityUsd = Math.max(0, Math.min(250_000, n));
      else if (key === 'minHolders')
        config.postRunDip.minHolders = Math.max(0, Math.min(5000, Math.round(n)));
      else if (key === 'boostPoints')
        config.postRunDip.boostPoints = Math.max(1, Math.min(20, Math.round(n)));
      else if (key === 'boostPointsMax')
        config.postRunDip.boostPointsMax = Math.max(10, Math.min(25, Math.round(n)));
      else if (key === 'nearTechnicalPct')
        config.postRunDip.nearTechnicalPct = Math.max(0.5, Math.min(8, n));
      else if (key === 'minQualifyScore')
        config.postRunDip.minQualifyScore = Math.max(40, Math.min(90, Math.round(n)));
    }
  }
  if (partial.preferredFibLevels !== undefined) {
    const raw = partial.preferredFibLevels;
    const list = Array.isArray(raw)
      ? raw.map(Number)
      : String(raw)
          .split(',')
          .map((s) => Number(s.trim()));
    config.postRunDip.preferredFibLevels = list.filter((n) => Number.isFinite(n));
  }
  if (partial.preferredSessions !== undefined) {
    const raw = partial.preferredSessions;
    const list = Array.isArray(raw)
      ? raw.map(String)
      : String(raw)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
    config.postRunDip.preferredSessions = list;
  }
  if (partial.preferNearTechnicals !== undefined) {
    config.postRunDip.preferNearTechnicals = Boolean(partial.preferNearTechnicals);
  }
  if (partial.requireNearTechnicals !== undefined) {
    config.postRunDip.requireNearTechnicals = Boolean(
      partial.requireNearTechnicals
    );
  }
  if (partial.preferSmartMoney !== undefined) {
    config.postRunDip.preferSmartMoney = Boolean(partial.preferSmartMoney);
  }
  if (partial.stronglyPreferSmartMoney !== undefined) {
    config.postRunDip.stronglyPreferSmartMoney = Boolean(
      partial.stronglyPreferSmartMoney
    );
  }
  if (partial.requireSmartMoney !== undefined) {
    config.postRunDip.requireSmartMoney = Boolean(partial.requireSmartMoney);
  }
  if (partial.hardRequireSetup !== undefined) {
    config.postRunDip.hardRequireSetup = Boolean(partial.hardRequireSetup);
  }
  if (partial.invalidateOnZoneBreak !== undefined) {
    config.postRunDip.invalidateOnZoneBreak = Boolean(
      partial.invalidateOnZoneBreak
    );
  }
  if (partial.invalidateRequireVolume !== undefined) {
    config.postRunDip.invalidateRequireVolume = Boolean(
      partial.invalidateRequireVolume
    );
  }
  if (partial.requireClearVolumeDryUp !== undefined) {
    config.postRunDip.requireClearVolumeDryUp = Boolean(
      partial.requireClearVolumeDryUp
    );
  }
  if (partial.flexibleVolumeConfirmation !== undefined) {
    config.postRunDip.flexibleVolumeConfirmation = Boolean(
      partial.flexibleVolumeConfirmation
    );
  }
  if (partial.requirePreferredSession !== undefined) {
    config.postRunDip.requirePreferredSession = Boolean(
      partial.requirePreferredSession
    );
  }
  if (
    partial.smartWalletDipSensitivity === 'low' ||
    partial.smartWalletDipSensitivity === 'medium' ||
    partial.smartWalletDipSensitivity === 'high'
  ) {
    config.postRunDip.smartWalletDipSensitivity =
      partial.smartWalletDipSensitivity;
  }
  if (partial.smartWalletDipBoostPoints !== undefined) {
    const n = Number(partial.smartWalletDipBoostPoints);
    if (Number.isFinite(n)) {
      config.postRunDip.smartWalletDipBoostPoints = Math.max(
        0,
        Math.min(15, Math.round(n))
      );
    }
  }
  if (partial.hardRequireSmartMoneyInConservative !== undefined) {
    config.postRunDip.hardRequireSmartMoneyInConservative = Boolean(
      partial.hardRequireSmartMoneyInConservative
    );
  }
  if (options?.persist !== false) persistUserSettings();
  return { ...config.postRunDip };
}

/**
 * Apply Standard, Conservative, or Aggressive Post-Run Dip profile thresholds.
 * Enables the strategy unless `enabled: false` is passed.
 */
export function applyPostRunDipProfile(
  profile: PostRunDipProfile,
  options?: { persist?: boolean; enabled?: boolean }
): PostRunDipConfig {
  const base =
    profile === 'conservative'
      ? { ...CONSERVATIVE_POST_RUN_DIP }
      : profile === 'aggressive'
        ? { ...AGGRESSIVE_POST_RUN_DIP }
        : { ...DEFAULT_POST_RUN_DIP };
  const keepEnabled =
    options?.enabled !== undefined ? Boolean(options.enabled) : true;
  config.postRunDip = {
    ...base,
    enabled: keepEnabled,
    profile,
  };
  syncToggle('post_run_dip', config.postRunDip.enabled);
  config.filters.enablePostRunDip = config.postRunDip.enabled;
  config.filters.postRunDipSensitivity = config.postRunDip.sensitivity;
  // Align global session preference with profile
  if (profile === 'conservative') {
    config.filters.marketSessionPreferred = ['us', 'europe_us'];
  } else if (profile === 'aggressive') {
    config.filters.marketSessionPreferred = [
      'asia',
      'europe',
      'us',
      'asia_europe',
      'europe_us',
    ];
    config.filters.marketSessionAllowAsia = true;
    config.filters.marketSessionAllowEurope = true;
    config.filters.marketSessionAllowUs = true;
    config.filters.marketSessionAllowOverlap = true;
  }
  if (options?.persist !== false) persistUserSettings();
  console.log(
    `[post-run-dip] Applied profile: ${POST_RUN_DIP_PROFILE_LABEL[profile]}`
  );
  return { ...config.postRunDip };
}
