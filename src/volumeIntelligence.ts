/**
 * Additive Volume Intelligence — strength score, decay state, price-volume divergence.
 * Soft layer only: does not override hard SL, anti-rug, or TA playbook defaults.
 */

import { config, persistUserSettings } from './config';
import {
  computeVolumeDivergence,
  computeZigZag,
  type DivergenceBias,
  type ProfileTaCandle,
  ZIGZAG_MIN_PCT,
} from './profileTaIndicators';

export const VOLUME_INTEL_FAST_PROFILES = new Set([
  'scalper',
  'reversal_scalper',
  'momentum_burst',
  'migration_sniper',
]);

export type VolumeDecayState =
  | 'expanding'
  | 'stable'
  | 'decaying'
  | 'collapsed';

export type VolumeDivergenceSupportState =
  | 'bullish_divergence'
  | 'bearish_divergence'
  | 'confirming'
  | 'none'
  | 'insufficient';

export interface VolumeIntelligenceConfig {
  enabled: boolean;
  blockCollapsedOnFastProfiles: boolean;
  fastMinVolumeM5Usd: number;
  fastMinVolumeH1Usd: number;
  healthyM5Usd: number;
  healthyH1Usd: number;
  strongM5Usd: number;
  strongH1Usd: number;
  shortTermDecayRatio: number;
  postSpikeDropRatio: number;
  collapseAbsM5Usd: number;
  collapseAbsH1Usd: number;
  decayTightenMult: number;
  collapseTightenMult: number;
  exitUrgencyOnDecay: boolean;
  divergenceEnabled: boolean;
  divergenceVolDropRatio: number;
  divergenceMinSwingPct: number;
  exitUrgencyOnBearishDivergence: boolean;
  learningAdjustEnabled: boolean;
  /** Clamped per-profile soft knobs (reversible learning). */
  profileSoft?: Record<
    string,
    {
      decaySensitivity?: number;
      entryDecayWeight?: number;
      exitUrgencyMult?: number;
      divergenceWeight?: number;
    }
  >;
}

export const DEFAULT_VOLUME_INTELLIGENCE: VolumeIntelligenceConfig = {
  enabled: true,
  blockCollapsedOnFastProfiles: true,
  fastMinVolumeM5Usd: 800,
  fastMinVolumeH1Usd: 2000,
  healthyM5Usd: 2500,
  healthyH1Usd: 15000,
  strongM5Usd: 5000,
  strongH1Usd: 50000,
  shortTermDecayRatio: 0.55,
  postSpikeDropRatio: 0.4,
  collapseAbsM5Usd: 400,
  collapseAbsH1Usd: 1500,
  decayTightenMult: 0.85,
  collapseTightenMult: 0.7,
  // Exit urgency defaults OFF — tighten/affinity still available; soft full
  // exits were too eager with the v1.2.175 H1/12 false-decay path.
  exitUrgencyOnDecay: false,
  divergenceEnabled: true,
  divergenceVolDropRatio: 0.85,
  divergenceMinSwingPct: 2.5,
  exitUrgencyOnBearishDivergence: false,
  learningAdjustEnabled: false,
  profileSoft: {},
};

export interface VolumeIntelInput {
  volumeM5Usd?: number | null;
  volumeH1Usd?: number | null;
  /** Recent M5 samples newest-last (for slope / prior-5m). */
  recentM5Slices?: number[] | null;
  txnsH1?: number | null;
  /** Optional short-horizon price change % for passive-tape detection. */
  priceChangePct?: number | null;
  profileId?: string | null;
  /** Candles for ZigZag divergence (optional). */
  candles?: ProfileTaCandle[] | null;
}

export interface VolumeDivergenceSnapshot {
  state: VolumeDivergenceSupportState;
  bias: DivergenceBias;
  detail: string;
  plainLanguage: string;
}

export interface VolumeIntelligenceSnapshot {
  enabled: boolean;
  score01: number;
  decayState: VolumeDecayState;
  divergence: VolumeDivergenceSnapshot;
  volM5: number | null;
  volH1: number | null;
  expansionRatio: number | null;
  plainLanguage: string;
  /** Fast-profile ultra-thin / collapsed soft block. */
  hardFloorFailFast: boolean;
  logs: string[];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function clamp01(n: number): number {
  return clamp(n, 0, 1);
}

function fin(n: unknown): number | null {
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

export function getVolumeIntelligenceConfig(): VolumeIntelligenceConfig {
  const raw = (config as { volumeIntelligence?: Partial<VolumeIntelligenceConfig> })
    .volumeIntelligence;
  const d = DEFAULT_VOLUME_INTELLIGENCE;
  return {
    enabled: raw?.enabled !== false,
    blockCollapsedOnFastProfiles: raw?.blockCollapsedOnFastProfiles !== false,
    fastMinVolumeM5Usd: clamp(
      Number(raw?.fastMinVolumeM5Usd) || d.fastMinVolumeM5Usd,
      0,
      100_000
    ),
    fastMinVolumeH1Usd: clamp(
      Number(raw?.fastMinVolumeH1Usd) || d.fastMinVolumeH1Usd,
      0,
      500_000
    ),
    healthyM5Usd: clamp(Number(raw?.healthyM5Usd) || d.healthyM5Usd, 100, 100_000),
    healthyH1Usd: clamp(
      Number(raw?.healthyH1Usd) || d.healthyH1Usd,
      500,
      1_000_000
    ),
    strongM5Usd: clamp(Number(raw?.strongM5Usd) || d.strongM5Usd, 500, 500_000),
    strongH1Usd: clamp(
      Number(raw?.strongH1Usd) || d.strongH1Usd,
      1000,
      5_000_000
    ),
    shortTermDecayRatio: clamp(
      Number(raw?.shortTermDecayRatio) || d.shortTermDecayRatio,
      0.2,
      0.95
    ),
    postSpikeDropRatio: clamp(
      Number(raw?.postSpikeDropRatio) || d.postSpikeDropRatio,
      0.15,
      0.9
    ),
    collapseAbsM5Usd: clamp(
      Number(raw?.collapseAbsM5Usd) || d.collapseAbsM5Usd,
      0,
      50_000
    ),
    collapseAbsH1Usd: clamp(
      Number(raw?.collapseAbsH1Usd) || d.collapseAbsH1Usd,
      0,
      100_000
    ),
    decayTightenMult: clamp(
      Number(raw?.decayTightenMult) || d.decayTightenMult,
      0.4,
      1
    ),
    collapseTightenMult: clamp(
      Number(raw?.collapseTightenMult) || d.collapseTightenMult,
      0.3,
      1
    ),
    exitUrgencyOnDecay: raw?.exitUrgencyOnDecay === true,
    divergenceEnabled: raw?.divergenceEnabled !== false,
    divergenceVolDropRatio: clamp(
      Number(raw?.divergenceVolDropRatio) || d.divergenceVolDropRatio,
      0.5,
      0.99
    ),
    divergenceMinSwingPct: clamp(
      Number(raw?.divergenceMinSwingPct) || d.divergenceMinSwingPct,
      1,
      12
    ),
    exitUrgencyOnBearishDivergence:
      raw?.exitUrgencyOnBearishDivergence === true,
    learningAdjustEnabled: raw?.learningAdjustEnabled === true,
    profileSoft:
      raw?.profileSoft && typeof raw.profileSoft === 'object'
        ? raw.profileSoft
        : {},
  };
}

export function setVolumeIntelligenceConfig(
  patch: Partial<VolumeIntelligenceConfig>
): VolumeIntelligenceConfig {
  const cur = getVolumeIntelligenceConfig();
  const cleaned: Partial<VolumeIntelligenceConfig> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (cleaned as Record<string, unknown>)[k] = v;
  }
  const next: VolumeIntelligenceConfig = {
    ...cur,
    ...cleaned,
    profileSoft:
      cleaned.profileSoft != null
        ? { ...(cur.profileSoft || {}), ...cleaned.profileSoft }
        : cur.profileSoft,
  };
  (config as { volumeIntelligence: VolumeIntelligenceConfig }).volumeIntelligence =
    next;
  try {
    persistUserSettings();
  } catch {
    /* */
  }
  return getVolumeIntelligenceConfig();
}

export function isVolumeIntelFastProfile(
  profileId: string | null | undefined
): boolean {
  return VOLUME_INTEL_FAST_PROFILES.has(String(profileId || ''));
}

/** Relative weight for how strongly decay/div affect affinity (1 = full). */
export function volumeWeightForProfile(
  profileId: string | null | undefined
): number {
  const id = String(profileId || '');
  if (VOLUME_INTEL_FAST_PROFILES.has(id)) return 1;
  if (id === 'dip_buyer') return 0.75;
  if (id === 'trend_rider' || id === 'high_win_rate') return 0.7;
  if (id === 'migration_sniper') return 0.55;
  if (id === 'steady_compounder' || id === 'smart_money_mirror') return 0.5;
  return 0.55;
}

function strengthScore01(
  volM5: number | null,
  volH1: number | null,
  cfg: VolumeIntelligenceConfig
): { score: number; log: string | null } {
  if (volM5 == null && volH1 == null) {
    return { score: 0.45, log: null };
  }
  const m5 = volM5 ?? 0;
  const h1 = volH1 ?? 0;

  if (
    (volM5 != null && m5 > 0 && m5 < cfg.collapseAbsM5Usd) ||
    (volH1 != null && h1 > 0 && h1 < cfg.collapseAbsH1Usd) ||
    (h1 > 0 && h1 <= 2000 && m5 > 0 && m5 < 1000)
  ) {
    return {
      score: 0.12,
      log: `Volume score low: 5m $${fmtK(m5)} / 1h $${fmtK(h1)}`,
    };
  }

  let score = 0.4;
  if (m5 >= cfg.strongM5Usd && h1 >= cfg.strongH1Usd) score = 0.95;
  else if (m5 >= cfg.healthyM5Usd && h1 >= cfg.healthyH1Usd) score = 0.78;
  else if (m5 >= cfg.healthyM5Usd || h1 >= cfg.healthyH1Usd) score = 0.62;
  else if (h1 >= 5000 || m5 >= 1500) score = 0.48;
  else score = 0.28;

  const log =
    score >= 0.7
      ? `Volume score strong: 5m $${fmtK(m5)} / 1h $${fmtK(h1)}`
      : score <= 0.35
        ? `Volume score low: 5m $${fmtK(m5)} / 1h $${fmtK(h1)}`
        : null;
  return { score, log };
}

function fmtK(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return Math.round(n).toString();
}

function detectDecay(
  volM5: number | null,
  volH1: number | null,
  slices: number[],
  priceChangePct: number | null,
  cfg: VolumeIntelligenceConfig
): { state: VolumeDecayState; logs: string[]; expansionRatio: number | null } {
  const logs: string[] = [];
  const expansionRatio =
    volM5 != null && volH1 != null && volH1 > 0 ? volM5 / volH1 : null;

  const collapsedAbs =
    (volM5 != null && volM5 > 0 && volM5 < cfg.collapseAbsM5Usd) ||
    (volH1 != null && volH1 > 0 && volH1 < cfg.collapseAbsH1Usd);

  if (collapsedAbs) {
    logs.push('Volume collapsed — entry penalised');
    return { state: 'collapsed', logs, expansionRatio };
  }

  let shortTermDecay = false;
  let postSpike = false;
  let negativeSlope = false;
  let expanding = false;

  // Prefer time-bucketed M5 ring (successive prints), not a single Dex snapshot.
  if (slices.length >= 2) {
    const cur = slices[slices.length - 1]!;
    const prior = slices[slices.length - 2]!;
    const avg =
      slices.slice(0, -1).reduce((a, b) => a + b, 0) /
      Math.max(1, slices.length - 1);
    if (avg > 0 && cur < avg * cfg.shortTermDecayRatio) shortTermDecay = true;
    if (
      prior > 0 &&
      prior >= (volM5 != null ? Math.max(volM5, prior) : prior) * 0.9 &&
      cur < prior * cfg.postSpikeDropRatio
    ) {
      postSpike = true;
      logs.push('Volume decaying after spike');
    }
    if (slices.length >= 3) {
      const a = slices[slices.length - 3]!;
      const b = slices[slices.length - 2]!;
      const c = slices[slices.length - 1]!;
      if (a > 0 && b < a * 0.9 && c < b * 0.9) negativeSlope = true;
      if (c > b * 1.15 && b >= a * 0.95) expanding = true;
    }
    if (cur > prior * 1.2) expanding = true;
  }

  // M5 vs H1 pace: expansion only from this heuristic. Do NOT mark decaying
  // solely because quiet 5m << busy hour (normal after a pump) — that was
  // false-triggering exit urgency on almost every open bag.
  if (volM5 != null && volH1 != null && volH1 > 0) {
    const implied5 = volH1 / 12;
    if (volM5 > implied5 * 1.4 || (expansionRatio != null && expansionRatio > 0.2)) {
      expanding = true;
    }
  }

  // Passive tape: price moving hard on thin 5m relative to hour — keep as decay.
  const passiveTape =
    priceChangePct != null &&
    Math.abs(priceChangePct) >= 3 &&
    volM5 != null &&
    volH1 != null &&
    volH1 > 0 &&
    volM5 < (volH1 / 12) * 0.5 &&
    volM5 < cfg.healthyM5Usd;

  if (shortTermDecay || postSpike || negativeSlope || passiveTape) {
    if (!logs.some((l) => l.includes('decaying'))) {
      logs.push(
        postSpike
          ? 'Volume decaying after spike'
          : passiveTape
            ? 'Volume decaying (passive tape)'
            : 'Volume decaying'
      );
    }
    return { state: 'decaying', logs, expansionRatio };
  }

  if (expanding) {
    logs.push('Volume expanding');
    return { state: 'expanding', logs, expansionRatio };
  }

  return { state: 'stable', logs, expansionRatio };
}

function mapDivergence(
  bias: DivergenceBias,
  available: boolean,
  detail: string
): VolumeDivergenceSnapshot {
  if (!available) {
    return {
      state: 'insufficient',
      bias: 'none',
      detail: detail || 'insufficient swing/volume data',
      plainLanguage: 'No volume divergence',
    };
  }
  if (bias === 'bullish') {
    return {
      state: 'bullish_divergence',
      bias,
      detail,
      plainLanguage: 'Bullish volume divergence detected',
    };
  }
  if (bias === 'bearish') {
    return {
      state: 'bearish_divergence',
      bias,
      detail,
      plainLanguage: 'Bearish volume divergence detected',
    };
  }
  if (/relative volume rising/i.test(detail)) {
    return {
      state: 'confirming',
      bias: 'none',
      detail,
      plainLanguage: 'Volume confirming price',
    };
  }
  return {
    state: 'none',
    bias: 'none',
    detail: detail || 'no volume divergence',
    plainLanguage: 'No volume divergence',
  };
}

function detectDivergence(
  input: VolumeIntelInput,
  cfg: VolumeIntelligenceConfig
): VolumeDivergenceSnapshot {
  if (!cfg.divergenceEnabled) {
    return {
      state: 'none',
      bias: 'none',
      detail: 'divergence disabled',
      plainLanguage: 'No volume divergence',
    };
  }

  const candles = input.candles;
  if (candles && candles.length >= 24) {
    const prices = candles
      .map((c) => Number(c.priceSol ?? c.price ?? 0))
      .filter((p) => p > 0);
    const vols = candles.map((c) => {
      const v = Number(c.volume);
      return Number.isFinite(v) && v > 0 ? v : 0;
    });
    if (prices.length >= 24) {
      const zzPct =
        cfg.divergenceMinSwingPct > 0
          ? cfg.divergenceMinSwingPct
          : ZIGZAG_MIN_PCT;
      const times = prices.map((_, i) => i);
      const zigzag = computeZigZag(prices, times, zzPct);
      const raw = computeVolumeDivergence(prices, vols, zigzag.pivots);
      return mapDivergence(raw.bias, raw.available, raw.detail);
    }
  }

  // Coarse fallback: price change vs M5/H1 without candles
  const m5 = fin(input.volumeM5Usd);
  const h1 = fin(input.volumeH1Usd);
  const chg = input.priceChangePct;
  if (m5 == null || h1 == null || chg == null) {
    return {
      state: 'insufficient',
      bias: 'none',
      detail: 'insufficient volume/price windows',
      plainLanguage: 'No volume divergence',
    };
  }
  const implied = h1 / 12;
  if (chg <= -5 && m5 < implied * cfg.divergenceVolDropRatio) {
    return {
      state: 'bullish_divergence',
      bias: 'bullish',
      detail: 'fallback: dump on light 5m volume',
      plainLanguage: 'Bullish volume divergence detected',
    };
  }
  if (chg >= 5 && m5 < implied * cfg.divergenceVolDropRatio) {
    return {
      state: 'bearish_divergence',
      bias: 'bearish',
      detail: 'fallback: push on light 5m volume',
      plainLanguage: 'Bearish volume divergence detected',
    };
  }
  if (m5 > implied * 1.25) {
    return {
      state: 'confirming',
      bias: 'none',
      detail: 'fallback: 5m confirms move',
      plainLanguage: 'Volume confirming price',
    };
  }
  return {
    state: 'none',
    bias: 'none',
    detail: 'fallback: no clear divergence',
    plainLanguage: 'No volume divergence',
  };
}

/**
 * Pure evaluator — fail soft when data sparse.
 */
export function evaluateVolumeIntelligence(
  input: VolumeIntelInput
): VolumeIntelligenceSnapshot {
  const cfg = getVolumeIntelligenceConfig();
  if (!cfg.enabled) {
    return {
      enabled: false,
      score01: 0.5,
      decayState: 'stable',
      divergence: {
        state: 'none',
        bias: 'none',
        detail: 'volume intelligence off',
        plainLanguage: 'No volume divergence',
      },
      volM5: fin(input.volumeM5Usd),
      volH1: fin(input.volumeH1Usd),
      expansionRatio: null,
      plainLanguage: 'Volume intelligence off',
      hardFloorFailFast: false,
      logs: [],
    };
  }

  const volM5 = fin(input.volumeM5Usd);
  const volH1 = fin(input.volumeH1Usd);
  const slices = Array.isArray(input.recentM5Slices)
    ? input.recentM5Slices.filter((n) => Number.isFinite(n) && n >= 0)
    : [];
  // Do not synthesize a 1-sample ring from a lone Dex print — that used to
  // pair with H1/12 pace checks and false-flag “decaying”.

  const soft = cfg.profileSoft?.[String(input.profileId || '')] || {};
  const decaySens = clamp(Number(soft.decaySensitivity) || 1, 0.5, 1.5);

  const strength = strengthScore01(volM5, volH1, cfg);
  const decay = detectDecay(
    volM5,
    volH1,
    slices,
    input.priceChangePct != null && Number.isFinite(Number(input.priceChangePct))
      ? Number(input.priceChangePct)
      : null,
    {
      ...cfg,
      shortTermDecayRatio: clamp(
        cfg.shortTermDecayRatio / decaySens,
        0.2,
        0.95
      ),
    }
  );
  const divergence = detectDivergence(input, cfg);

  let score01 = strength.score;
  if (decay.state === 'expanding') score01 = clamp01(score01 + 0.08);
  else if (decay.state === 'decaying') score01 = clamp01(score01 - 0.12 * decaySens);
  else if (decay.state === 'collapsed') score01 = clamp01(score01 - 0.35);

  const logs = [
    ...(strength.log ? [strength.log] : []),
    ...decay.logs,
    divergence.plainLanguage,
  ];

  const fast = isVolumeIntelFastProfile(input.profileId);
  const hardFloorFailFast =
    cfg.blockCollapsedOnFastProfiles &&
    fast &&
    (decay.state === 'collapsed' ||
      (volM5 != null &&
        volM5 > 0 &&
        volM5 < cfg.fastMinVolumeM5Usd &&
        (volH1 == null || volH1 < cfg.fastMinVolumeH1Usd)) ||
      (volH1 != null && volH1 > 0 && volH1 < cfg.fastMinVolumeH1Usd && (volM5 == null || volM5 < cfg.fastMinVolumeM5Usd)));

  const plain =
    decay.state === 'collapsed'
      ? 'Volume collapsed — entry penalised'
      : decay.state === 'decaying'
        ? logs.find((l) => /decaying/i.test(l)) || 'Volume decaying'
        : decay.state === 'expanding'
          ? 'Volume expanding'
          : strength.log || divergence.plainLanguage;

  return {
    enabled: true,
    score01,
    decayState: decay.state,
    divergence,
    volM5,
    volH1,
    expansionRatio: decay.expansionRatio,
    plainLanguage: plain,
    hardFloorFailFast,
    logs,
  };
}

/** Extra affinity multiplier from decay (1 = neutral). */
export function decayAffinityFactor(
  state: VolumeDecayState,
  profileId: string | null | undefined
): number {
  const w = volumeWeightForProfile(profileId);
  const cfg = getVolumeIntelligenceConfig();
  const soft = cfg.profileSoft?.[String(profileId || '')];
  const entryW = clamp(Number(soft?.entryDecayWeight) || 1, 0.5, 1.5);
  switch (state) {
    case 'expanding':
      return 1 + 0.08 * w * entryW;
    case 'stable':
      return 1;
    case 'decaying':
      return 1 - 0.18 * w * entryW;
    case 'collapsed':
      return 1 - 0.45 * w * entryW;
    default:
      return 1;
  }
}

/** Extra affinity delta from divergence by profile style (−0.25…+0.2). */
export function divergenceAffinityDelta(
  state: VolumeDivergenceSupportState,
  profileId: string | null | undefined
): number {
  const id = String(profileId || '');
  const cfg = getVolumeIntelligenceConfig();
  if (!cfg.divergenceEnabled) return 0;
  const soft = cfg.profileSoft?.[id];
  const dw = clamp(Number(soft?.divergenceWeight) || 1, 0.4, 1.6);
  const baseW = volumeWeightForProfile(id);

  if (state === 'insufficient') return -0.03 * baseW;
  if (state === 'none') return 0;

  if (id === 'dip_buyer') {
    if (state === 'bullish_divergence') return 0.16 * dw;
    if (state === 'confirming') return 0.06 * dw;
    if (state === 'bearish_divergence') return -0.06 * dw;
  }
  if (id === 'trend_rider' || id === 'high_win_rate') {
    if (state === 'confirming') return 0.1 * dw;
    if (state === 'bearish_divergence') return -0.14 * dw;
    if (state === 'bullish_divergence') return 0.04 * dw;
    if (state === 'none') return -0.04 * dw;
  }
  if (
    id === 'scalper' ||
    id === 'momentum_burst' ||
    id === 'reversal_scalper'
  ) {
    if (state === 'confirming') return 0.08 * dw * baseW;
    if (state === 'bearish_divergence') return -0.18 * dw * baseW;
    if (state === 'bullish_divergence') return 0.05 * dw;
  }
  if (id === 'migration_sniper') {
    if (state === 'confirming') return 0.04 * dw;
    if (state === 'bearish_divergence') return -0.06 * dw;
    if (state === 'bullish_divergence') return 0.03 * dw;
  }
  // default mild
  if (state === 'confirming') return 0.05 * dw * baseW;
  if (state === 'bearish_divergence') return -0.08 * dw * baseW;
  if (state === 'bullish_divergence') return 0.05 * dw * baseW;
  return 0;
}

/** PPP giveback multiplier from volume state (1 = no change). */
export function volumeExitTightenMult(
  decayState: VolumeDecayState,
  divergenceState?: VolumeDivergenceSupportState | null,
  profileId?: string | null
): number {
  const cfg = getVolumeIntelligenceConfig();
  if (!cfg.enabled) return 1;
  const soft = cfg.profileSoft?.[String(profileId || '')];
  const urg = clamp(Number(soft?.exitUrgencyMult) || 1, 0.5, 1.5);
  let m = 1;
  // Absolute collapse always mildly tightens PPP (safe). Soft “decaying” /
  // bearish-div tighten only when exit-urgency knobs are explicitly on.
  if (decayState === 'collapsed') {
    m = Math.min(m, cfg.collapseTightenMult);
  } else if (cfg.exitUrgencyOnDecay && decayState === 'decaying') {
    m = Math.min(m, cfg.decayTightenMult);
  }
  if (
    cfg.exitUrgencyOnBearishDivergence &&
    divergenceState === 'bearish_divergence'
  ) {
    m = Math.min(m, 0.88);
  }
  // urg > 1 → tighter (smaller mult)
  if (m < 1 && urg !== 1) {
    m = 1 - (1 - m) * urg;
  }
  return clamp(m, 0.3, 1);
}

export function logVolumeIntelligence(
  snap: VolumeIntelligenceSnapshot,
  context: string
): void {
  if (!snap.enabled || !snap.logs.length) return;
  for (const line of snap.logs.slice(0, 4)) {
    console.log(`[VolIntel] ${context}: ${line}`);
  }
}
