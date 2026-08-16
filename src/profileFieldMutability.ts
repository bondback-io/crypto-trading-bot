/**
 * Per-field flags for Micro Bots → Details · Params & rules.
 * Mirrors what self-learn / Level upgrades / ML actually persist — not runtime
 * coaches (MARL, Profile RL) and not Learning Mode’s unsaved floor soften.
 */

export type ProfileFieldUsedOn = 'all' | readonly string[];

export interface ProfileFieldMutability {
  /** Which bots consume this knob. */
  usedOn: ProfileFieldUsedOn;
  /** Shown on every card but only gates when that optional path is ON. */
  optional?: boolean;
  /**
   * Heuristic self-learn can persist this key (auto apply, or shadow + Apply).
   * Same keys as Level upgrades and micro/delta nudges.
   */
  selfLearn: boolean;
  /**
   * ML-led candidates emit this key. Hybrid/lead can write it (still needs
   * self-learn auto or Apply). ML shadow is advice-only and never writes.
   */
  mlSteer: boolean;
}

const HWR_SMM = ['high_win_rate', 'smart_money_mirror'] as const;
const TREND_STEADY = ['trend_rider', 'steady_compounder'] as const;
const TREND_STEADY_SMM = [
  'trend_rider',
  'steady_compounder',
  'smart_money_mirror',
] as const;
const DIP_REV = ['dip_buyer', 'reversal_scalper'] as const;
const BUY_PRESSURE = [
  'momentum_burst',
  'migration_sniper',
  'reversal_scalper',
] as const;

function frozen(
  usedOn: ProfileFieldUsedOn = 'all',
  extra?: Partial<ProfileFieldMutability>
): ProfileFieldMutability {
  return { usedOn, selfLearn: false, mlSteer: false, ...extra };
}

function learn(
  usedOn: ProfileFieldUsedOn = 'all',
  extra?: Partial<ProfileFieldMutability>
): ProfileFieldMutability {
  return { usedOn, selfLearn: true, mlSteer: false, ...extra };
}

function learnMl(
  usedOn: ProfileFieldUsedOn = 'all',
  extra?: Partial<ProfileFieldMutability>
): ProfileFieldMutability {
  return { usedOn, selfLearn: true, mlSteer: true, ...extra };
}

/**
 * Keys match dashboard `data-k`, `data-policy`, `data-qf` (as `qf.*`),
 * and self-learn UI controls.
 */
export const PROFILE_FIELD_MUTABILITY: Record<string, ProfileFieldMutability> = {
  // Entry / lane fit
  watchEnabled: frozen(),
  armingEnabled: frozen(),
  minTaPlaybookConfluences: learn(),
  minConviction: learnMl(),
  minTokenAgeHours: learn(),
  minMarketCapUsd: frozen(),
  maxMarketCapUsd: frozen(),
  minHolders: frozen(),
  maxTop10HoldPct: frozen(),
  minVolumeH1Usd: frozen(TREND_STEADY),
  patternSensitivity: frozen(TREND_STEADY_SMM),
  patternMinConfidence: frozen(TREND_STEADY_SMM),
  minVolumeM5Usd: frozen(['momentum_burst']),
  minBuyPressureUsd: frozen(BUY_PRESSURE),
  minDropFromPeakPct: frozen(DIP_REV),
  minPriceChange24hPct: frozen(['dip_buyer']),
  minWalletCount: learn(HWR_SMM),
  minWalletQuality: learn(),
  requireCluster: learn(HWR_SMM),
  gradWatchPct: frozen(['migration_sniper']),
  minCurveProgressPct: frozen(['migration_sniper']),
  maxCurveProgressPct: frozen(['migration_sniper']),
  maxMigrationAgeSec: frozen(['migration_sniper']),

  // Specialty feed (all bots; active when feed is ON)
  kolscanFeedEnabled: frozen('all', { optional: true }),
  minKolWallets: frozen('all', { optional: true }),
  jupiterCategory: frozen('all', { optional: true }),
  jupiterInterval: frozen('all', { optional: true }),

  // Exit & sizing — TP/SL are never emitted by learning candidates
  takeProfitPctMin: frozen(),
  takeProfitPctMax: frozen(),
  stopLossPctMin: frozen(),
  stopLossPctMax: frozen(),
  hardTimeLimitSecMin: frozen(),
  hardTimeLimitSecMax: learnMl(),
  sizeMultiplier: frozen(),
  maxTradeOverrideSol: frozen(),
  trailingActivationProfit: learn(),
  trailingStopPct: frozen(),
  momentumFailDropPct: frozen(),
  turboMode: frozen(),
  profitLockArmPct: learnMl(),
  profitGivebackPts: learnMl(),
  profitFloorPct: learn(),
  peakProtectArmOfTpPct: learnMl(),
  peakProtectGivebackOfPeakPct: learnMl(),
  earlyPartialTpPct: learnMl(),

  // Operator learning controls (not learned themselves)
  learningModeOptIn: frozen(),
  selfLearningEnabled: frozen(),
  selfLearningMode: frozen(),
  selfLearningMlMode: frozen(),
  selfLearningMinTrades: frozen(),

  // HWR quality filter — operator only
  'qf.enabled': frozen(['high_win_rate']),
  'qf.mode': frozen(['high_win_rate']),
  'qf.minMarketCapUsd': frozen(['high_win_rate']),
  'qf.preferMarketCapUsd': frozen(['high_win_rate']),
  'qf.minLiquidityUsd': frozen(['high_win_rate']),
  'qf.minVolumeH1Usd': frozen(['high_win_rate']),
  'qf.minHolders': frozen(['high_win_rate']),
  'qf.minPatternConfidence': frozen(['high_win_rate']),
  'qf.weakSetupPenalty': frozen(['high_win_rate']),
  'qf.cleanSetupBonus': frozen(['high_win_rate']),
  'qf.applyToFibSupport': frozen(['high_win_rate']),
  'qf.preferFibOrSupport': frozen(['high_win_rate']),
};

export function isProfileFieldUsed(
  profileId: string,
  spec: ProfileFieldMutability
): boolean {
  if (spec.usedOn === 'all') return true;
  return spec.usedOn.includes(profileId);
}

export function resolveProfileFieldMutability(
  key: string
): ProfileFieldMutability {
  return (
    PROFILE_FIELD_MUTABILITY[key] || {
      usedOn: 'all',
      selfLearn: false,
      mlSteer: false,
    }
  );
}

export function describeProfileFieldMutability(
  profileId: string,
  key: string
): {
  used: boolean;
  optional: boolean;
  selfLearn: boolean;
  mlSteer: boolean;
  title: string;
} {
  const spec = resolveProfileFieldMutability(key);
  const used = isProfileFieldUsed(profileId, spec);
  const optional = spec.optional === true;
  const usedTip = used
    ? optional
      ? 'Used by this bot when this optional path is ON (for example specialty feed).'
      : 'Used by this bot.'
    : 'Not used by this bot — this lane ignores the value.';
  const learnTip = spec.selfLearn
    ? 'Self-learn (auto, or shadow + Apply) and Level upgrades can nudge this. Micro/delta learning uses the same key. Global Micro-Bot TP pauses exit deltas only.'
    : 'Operator / catalog only — self-learn, delta learning, and Level upgrades never write this field.';
  const mlTip = spec.mlSteer
    ? 'ML hybrid/lead can steer this key. ML shadow is advice-only and does not write knobs.'
    : spec.selfLearn
      ? 'ML-led candidates do not target this key. Hybrid may still apply a heuristic candidate that includes it. ML shadow never writes.'
      : 'ML (shadow / hybrid / lead) does not write this field.';
  return {
    used,
    optional,
    selfLearn: spec.selfLearn,
    mlSteer: spec.mlSteer,
    title: `${usedTip} ${learnTip} ${mlTip}`,
  };
}
