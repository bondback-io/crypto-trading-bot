/**
 * Shared support / Fib / multi-TF reclaim detector + late-chase helper.
 * Used by Dip / Scalper setup watches and lane entry-style DNA.
 * Fail soft when S/R data is missing — never force a block.
 */

export type SupportReclaimLevelKind =
  | 'support'
  | 'fib'
  | 'mtf'
  | 'session'
  | 'none';

export type SupportReclaimConfirmation = 'volume' | 'ha' | 'none';

export interface DetectSupportReclaimInput {
  priceSol?: number | null;
  supportPriceSol?: number | null;
  fib05PriceSol?: number | null;
  fib618PriceSol?: number | null;
  /** Multi-TF primary support when known */
  mtfSupportPriceSol?: number | null;
  nearSupport?: boolean | null;
  nearKeyFib?: boolean | null;
  nearMultiTfSupport?: boolean | null;
  /** Reclaim trigger % above level (Dip ~1.5, Scalper ~1.2) */
  reclaimTriggerPct?: number;
  /** Distance % above level that counts as late chase (default band 8–12) */
  lateChaseExtensionPct?: number;
  /** Strong completed leg without a reclaim level nearby */
  strongLegNoLevel?: boolean;
  /** Momentum-style path (MB / scalp burst) */
  momentumStyle?: boolean;
  /** Optional confirmation hints */
  volumeConfirm?: boolean;
  haConfirm?: boolean;
  /** Near-band: price within this % of level counts as near (default 3) */
  nearBandPct?: number;
  /** Undercut: price may dip this % below level and still count (default 1.5) */
  undercutBandPct?: number;
}

export interface SupportReclaimResult {
  nearLevel: boolean;
  undercut: boolean;
  reclaimed: boolean;
  reclaimPct: number;
  levelKind: SupportReclaimLevelKind;
  levelPrice: number | null;
  confirmation: SupportReclaimConfirmation;
  lateChase: boolean;
  extensionFromLevelPct: number;
}

const DEFAULT_RECLAIM_TRIGGER_PCT = 1.5;
const DEFAULT_LATE_CHASE_EXT_PCT = 10;
const DEFAULT_NEAR_BAND_PCT = 3;
const DEFAULT_UNDERCUT_BAND_PCT = 1.5;

function finitePos(n: unknown): number | null {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  return v;
}

function pickNearestLevel(input: DetectSupportReclaimInput): {
  price: number | null;
  kind: SupportReclaimLevelKind;
} {
  const px = finitePos(input.priceSol);
  const candidates: Array<{ price: number; kind: SupportReclaimLevelKind }> =
    [];
  const mtf = finitePos(input.mtfSupportPriceSol);
  if (mtf != null) candidates.push({ price: mtf, kind: 'mtf' });
  const sup = finitePos(input.supportPriceSol);
  if (sup != null) candidates.push({ price: sup, kind: 'support' });
  const f618 = finitePos(input.fib618PriceSol);
  if (f618 != null) candidates.push({ price: f618, kind: 'fib' });
  const f05 = finitePos(input.fib05PriceSol);
  if (f05 != null) candidates.push({ price: f05, kind: 'fib' });

  if (!candidates.length) return { price: null, kind: 'none' };
  if (px == null) {
    // Prefer mtf → support → fib order when price unknown
    const prefer =
      candidates.find((c) => c.kind === 'mtf') ||
      candidates.find((c) => c.kind === 'support') ||
      candidates[0]!;
    return { price: prefer.price, kind: prefer.kind };
  }
  let best = candidates[0]!;
  let bestDist = Math.abs(px - best.price) / best.price;
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i]!;
    const d = Math.abs(px - c.price) / c.price;
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return { price: best.price, kind: best.kind };
}

/**
 * Detect near-level / undercut / reclaim and late-chase extension.
 */
export function detectSupportReclaim(
  input: DetectSupportReclaimInput
): SupportReclaimResult {
  const px = finitePos(input.priceSol);
  const triggerPct =
    input.reclaimTriggerPct != null &&
    Number.isFinite(Number(input.reclaimTriggerPct))
      ? Math.max(0.2, Number(input.reclaimTriggerPct))
      : DEFAULT_RECLAIM_TRIGGER_PCT;
  const lateExtPct =
    input.lateChaseExtensionPct != null &&
    Number.isFinite(Number(input.lateChaseExtensionPct))
      ? Math.max(4, Number(input.lateChaseExtensionPct))
      : DEFAULT_LATE_CHASE_EXT_PCT;
  const nearBand =
    input.nearBandPct != null && Number.isFinite(Number(input.nearBandPct))
      ? Math.max(0.5, Number(input.nearBandPct))
      : DEFAULT_NEAR_BAND_PCT;
  const undercutBand =
    input.undercutBandPct != null &&
    Number.isFinite(Number(input.undercutBandPct))
      ? Math.max(0.2, Number(input.undercutBandPct))
      : DEFAULT_UNDERCUT_BAND_PCT;

  const { price: levelPrice, kind: levelKind } = pickNearestLevel(input);

  let nearLevel =
    input.nearSupport === true ||
    input.nearKeyFib === true ||
    input.nearMultiTfSupport === true;
  let undercut = false;
  let reclaimed = false;
  let reclaimPct = 0;
  let extensionFromLevelPct = 0;

  if (px != null && levelPrice != null && levelPrice > 0) {
    const distPct = ((px - levelPrice) / levelPrice) * 100;
    extensionFromLevelPct = distPct;
    const absDist = Math.abs(distPct);
    if (absDist <= nearBand || (distPct >= 0 && distPct <= nearBand)) {
      nearLevel = true;
    }
    if (distPct < 0 && Math.abs(distPct) <= undercutBand) {
      undercut = true;
      nearLevel = true;
    }
    if (distPct >= triggerPct) {
      reclaimed = true;
      reclaimPct = distPct;
    } else if (distPct >= 0 && nearLevel) {
      reclaimPct = distPct;
    }
  }

  // Fail soft: no level → no forced reclaim, but still evaluate late-chase
  const confirmation: SupportReclaimConfirmation = input.volumeConfirm
    ? 'volume'
    : input.haConfirm
      ? 'ha'
      : 'none';

  const lateChase = isLateChase({
    extensionFromLevelPct,
    lateChaseExtensionPct: lateExtPct,
    nearSupport: nearLevel || input.nearSupport === true,
    nearMultiTfSupport: input.nearMultiTfSupport === true,
    hasLevel: levelPrice != null,
    strongLegNoLevel: input.strongLegNoLevel === true,
    momentumStyle: input.momentumStyle === true,
  });

  return {
    nearLevel,
    undercut,
    reclaimed,
    reclaimPct,
    levelKind: levelPrice != null ? levelKind : 'none',
    levelPrice,
    confirmation,
    lateChase,
    extensionFromLevelPct,
  };
}

export function isLateChase(input: {
  extensionFromLevelPct?: number | null;
  lateChaseExtensionPct?: number;
  nearSupport?: boolean;
  nearMultiTfSupport?: boolean;
  hasLevel?: boolean;
  strongLegNoLevel?: boolean;
  momentumStyle?: boolean;
}): boolean {
  const lim =
    input.lateChaseExtensionPct != null &&
    Number.isFinite(Number(input.lateChaseExtensionPct))
      ? Number(input.lateChaseExtensionPct)
      : DEFAULT_LATE_CHASE_EXT_PCT;
  const ext = Number(input.extensionFromLevelPct);
  if (Number.isFinite(ext) && ext >= lim) return true;
  if (input.strongLegNoLevel === true && input.hasLevel !== true) return true;
  if (
    input.momentumStyle === true &&
    input.nearSupport !== true &&
    input.nearMultiTfSupport !== true
  ) {
    return true;
  }
  return false;
}

/** Canonical entry-style DNA tags (per-profile primary / allowed / forbidden). */
export type EntryStyleTag =
  | 'scalp_reclaim_burst'
  | 'reversal_reclaim'
  | 'level_momentum_expansion'
  | 'migration_hold_reclaim'
  | 'support_dip_reclaim'
  | 'trend_pullback_continuation'
  | 'quality_structure_reclaim'
  | 'smart_money_confirm'
  | 'late_chase'
  | 'unknown';

export const ENTRY_STYLE_LABELS: Record<EntryStyleTag, string> = {
  scalp_reclaim_burst: 'Scalp reclaim',
  reversal_reclaim: 'Reversal reclaim',
  level_momentum_expansion: 'Level momentum',
  migration_hold_reclaim: 'Mig hold/reclaim',
  support_dip_reclaim: 'Dip reclaim',
  trend_pullback_continuation: 'Trend pullback',
  quality_structure_reclaim: 'Quality structure',
  smart_money_confirm: 'SM confirm',
  late_chase: 'Late chase',
  unknown: 'Unknown',
};

export interface EntryStyleDna {
  primary: EntryStyleTag;
  allowed: EntryStyleTag[];
  /** Styles that hard-zero or heavily penalize this profile */
  forbidden: EntryStyleTag[];
  /** When true, late_chase zeros this profile (quality/Mirror/Trend) */
  hardLateChase: boolean;
}

export const PROFILE_ENTRY_STYLE_DNA: Record<string, EntryStyleDna> = {
  scalper: {
    primary: 'scalp_reclaim_burst',
    allowed: ['level_momentum_expansion', 'reversal_reclaim'],
    forbidden: ['support_dip_reclaim', 'late_chase'],
    hardLateChase: false,
  },
  reversal_scalper: {
    primary: 'reversal_reclaim',
    allowed: ['scalp_reclaim_burst', 'support_dip_reclaim'],
    forbidden: ['trend_pullback_continuation', 'late_chase'],
    hardLateChase: false,
  },
  momentum_burst: {
    primary: 'level_momentum_expansion',
    allowed: ['scalp_reclaim_burst', 'migration_hold_reclaim'],
    forbidden: ['support_dip_reclaim'],
    hardLateChase: false,
  },
  migration_sniper: {
    primary: 'migration_hold_reclaim',
    allowed: ['level_momentum_expansion', 'scalp_reclaim_burst'],
    forbidden: ['late_chase', 'support_dip_reclaim'],
    hardLateChase: false,
  },
  dip_buyer: {
    primary: 'support_dip_reclaim',
    allowed: ['quality_structure_reclaim', 'reversal_reclaim'],
    forbidden: ['level_momentum_expansion', 'late_chase'],
    hardLateChase: true,
  },
  trend_rider: {
    primary: 'trend_pullback_continuation',
    allowed: ['quality_structure_reclaim', 'support_dip_reclaim'],
    forbidden: ['scalp_reclaim_burst', 'late_chase'],
    hardLateChase: true,
  },
  high_win_rate: {
    primary: 'quality_structure_reclaim',
    allowed: ['trend_pullback_continuation', 'support_dip_reclaim'],
    forbidden: ['late_chase', 'scalp_reclaim_burst'],
    hardLateChase: true,
  },
  steady_compounder: {
    primary: 'quality_structure_reclaim',
    allowed: ['trend_pullback_continuation', 'support_dip_reclaim'],
    forbidden: ['late_chase', 'scalp_reclaim_burst'],
    hardLateChase: true,
  },
  smart_money_mirror: {
    primary: 'smart_money_confirm',
    allowed: [
      'quality_structure_reclaim',
      'trend_pullback_continuation',
      'support_dip_reclaim',
    ],
    forbidden: ['late_chase'],
    hardLateChase: true,
  },
};

/**
 * Detect once per fight from match context signals.
 */
export function resolveDetectedEntryStyle(ctx: {
  nearSupport?: boolean | null;
  nearKeyFib?: boolean | null;
  nearMultiTfSupport?: boolean | null;
  supportPriceSol?: number | null;
  srConfluenceScore?: number | null;
  dropFromPeakPct?: number | null;
  localPullbackPct?: number | null;
  priceChangeH1Pct?: number | null;
  isMigration?: boolean;
  migrationFresh?: boolean;
  nearMigration?: boolean;
  preferMigration?: boolean;
  shortTermStrategyId?: string | null;
  preferProfileId?: string | null;
  smartMoneyScore?: number | null;
  walletCount?: number | null;
  entrySource?: string | null;
  volumeM5Usd?: number | null;
  priceSol?: number | null;
  fib05PriceSol?: number | null;
  fib618PriceSol?: number | null;
}): { detectedEntryStyle: EntryStyleTag; lateChase: boolean } {
  const drop =
    ctx.dropFromPeakPct != null && Number.isFinite(Number(ctx.dropFromPeakPct))
      ? Number(ctx.dropFromPeakPct)
      : ctx.localPullbackPct != null &&
          Number.isFinite(Number(ctx.localPullbackPct))
        ? Number(ctx.localPullbackPct)
        : null;
  const chgH1 =
    ctx.priceChangeH1Pct != null && Number.isFinite(Number(ctx.priceChangeH1Pct))
      ? Number(ctx.priceChangeH1Pct)
      : null;
  const nearLevel =
    ctx.nearSupport === true ||
    ctx.nearKeyFib === true ||
    ctx.nearMultiTfSupport === true;
  const hasLevel =
    nearLevel ||
    (ctx.supportPriceSol != null && Number(ctx.supportPriceSol) > 0) ||
    (ctx.srConfluenceScore != null && Number(ctx.srConfluenceScore) >= 40);

  const reclaim = detectSupportReclaim({
    priceSol: ctx.priceSol,
    supportPriceSol: ctx.supportPriceSol,
    fib05PriceSol: ctx.fib05PriceSol,
    fib618PriceSol: ctx.fib618PriceSol,
    mtfSupportPriceSol:
      ctx.nearMultiTfSupport === true ? ctx.supportPriceSol : null,
    nearSupport: ctx.nearSupport,
    nearKeyFib: ctx.nearKeyFib,
    nearMultiTfSupport: ctx.nearMultiTfSupport,
    momentumStyle:
      ctx.shortTermStrategyId === 'momentum_burst' ||
      (chgH1 != null && chgH1 >= 12 && !nearLevel),
    strongLegNoLevel:
      ((chgH1 != null && chgH1 >= 18) || (drop == null && chgH1 != null && chgH1 >= 12)) &&
      !hasLevel,
  });

  // Fold Mirror late-copy: deep drop after SM peak into late_chase
  const mirrorLate = drop != null && drop > 22;

  let lateChase = reclaim.lateChase || mirrorLate;

  let style: EntryStyleTag = 'unknown';
  const sid = String(ctx.shortTermStrategyId || '');
  const prefer = String(ctx.preferProfileId || '');

  const scalperFamilyPrefer =
    prefer === 'scalper' ||
    prefer === 'momentum_burst' ||
    prefer === 'reversal_scalper' ||
    sid === 'quick_scalper' ||
    sid === 'micro_scalper' ||
    sid === 'momentum_burst' ||
    sid === 'reversal_scalp';
  const mbExpansionDominant =
    prefer === 'momentum_burst' ||
    sid === 'momentum_burst' ||
    (chgH1 != null && chgH1 >= 18 && !nearLevel);

  if (
    ctx.isMigration ||
    ctx.migrationFresh ||
    ctx.nearMigration ||
    sid === 'migration_event' ||
    prefer === 'migration_sniper'
  ) {
    style = 'migration_hold_reclaim';
    if (lateChase && !hasLevel) lateChase = true;
  } else if (
    sid === 'post_run_dip' ||
    prefer === 'dip_buyer' ||
    // Deep Fib dips stay Dip; Mode B scalper-family at support is scalp reclaim
    (drop != null && drop >= 8 && nearLevel && !scalperFamilyPrefer)
  ) {
    style = 'support_dip_reclaim';
  } else if (
    sid === 'reversal_scalp' ||
    prefer === 'reversal_scalper' ||
    (drop != null && drop >= 12 && nearLevel && prefer !== 'scalper')
  ) {
    style = 'reversal_reclaim';
  } else if (
    !mbExpansionDominant &&
    (prefer === 'scalper' ||
      sid === 'quick_scalper' ||
      sid === 'micro_scalper' ||
      (nearLevel &&
        (reclaim.reclaimed || reclaim.nearLevel) &&
        (chgH1 == null || chgH1 < 18)) ||
      (ctx.nearMultiTfSupport === true &&
        (reclaim.reclaimed || reclaim.nearLevel) &&
        (chgH1 == null || chgH1 < 22)))
  ) {
    style = 'scalp_reclaim_burst';
  } else if (
    mbExpansionDominant ||
    (chgH1 != null && chgH1 >= 10 && hasLevel)
  ) {
    style = 'level_momentum_expansion';
    if (!hasLevel) lateChase = true;
  } else if (
    prefer === 'smart_money_mirror' ||
    (ctx.smartMoneyScore != null &&
      Number(ctx.smartMoneyScore) >= 50 &&
      (ctx.walletCount == null || Number(ctx.walletCount) >= 2))
  ) {
    style = 'smart_money_confirm';
  } else if (
    prefer === 'trend_rider' ||
    (nearLevel && drop != null && drop >= 2 && drop <= 20)
  ) {
    style = 'trend_pullback_continuation';
  } else if (
    prefer === 'high_win_rate' ||
    prefer === 'steady_compounder' ||
    (nearLevel && reclaim.reclaimed)
  ) {
    style = 'quality_structure_reclaim';
  } else if (nearLevel && reclaim.reclaimed) {
    style = 'support_dip_reclaim';
  } else if (lateChase) {
    style = 'late_chase';
  }

  if (lateChase && style !== 'late_chase' && !hasLevel) {
    // Keep detected primary but flag lateChase separately on context
  }
  if (lateChase && !hasLevel && style === 'unknown') {
    style = 'late_chase';
  }

  return { detectedEntryStyle: style, lateChase };
}

/**
 * Score adjustment for entry-style DNA vs detected style.
 * Returns { scoreMult extras, hardZero, bits }.
 */
export function scoreEntryStyleDna(input: {
  profileId: string;
  detectedEntryStyle?: EntryStyleTag | string | null;
  lateChase?: boolean;
}): {
  hardZero: boolean;
  scoreDelta: number;
  bits: string[];
} {
  const dna = PROFILE_ENTRY_STYLE_DNA[String(input.profileId || '')];
  if (!dna) return { hardZero: false, scoreDelta: 0, bits: [] };

  const style = String(input.detectedEntryStyle || 'unknown') as EntryStyleTag;
  const late = input.lateChase === true || style === 'late_chase';
  const bits: string[] = [];

  if (late && (dna.hardLateChase || dna.forbidden.includes('late_chase'))) {
    if (dna.hardLateChase) {
      return { hardZero: true, scoreDelta: 0, bits: ['late_chase forbidden'] };
    }
    bits.push('late_chase penalty');
    return { hardZero: false, scoreDelta: -40, bits };
  }

  if (dna.forbidden.includes(style)) {
    if (dna.hardLateChase || style === 'late_chase') {
      return {
        hardZero: true,
        scoreDelta: 0,
        bits: [`forbidden style ${style}`],
      };
    }
    bits.push(`forbidden style ${style}`);
    return { hardZero: false, scoreDelta: -35, bits };
  }

  if (style === dna.primary) {
    bits.push(`primary ${style}`);
    return { hardZero: false, scoreDelta: 18, bits };
  }
  if (dna.allowed.includes(style)) {
    bits.push(`allowed ${style}`);
    return { hardZero: false, scoreDelta: 6, bits };
  }
  if (style !== 'unknown') {
    bits.push(`off-style ${style}`);
    return { hardZero: false, scoreDelta: -12, bits };
  }
  return { hardZero: false, scoreDelta: -4, bits: ['style unknown'] };
}
