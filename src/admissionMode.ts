/**
 * Admission / Entry Mode — Selective | Flow | Hybrid timing (1.2.392).
 * Independent of Entry Skill (admissionBaseline v235/governed).
 * Selective = Arming-ON park-all. Hybrid/Flow can fast-arm when near a playbook level.
 */

import { config, persistUserSettings } from './config';

export type AdmissionMode = 'selective' | 'flow' | 'hybrid';

export type FastArmEntryPath = 'hybrid_fast_arm' | 'flow_fast_arm';

export const ADMISSION_MODE_IDS: readonly AdmissionMode[] = [
  'selective',
  'flow',
  'hybrid',
];

export const ADMISSION_OVERRIDE_PROFILE_IDS = [
  'scalper',
  'dip_buyer',
  'trend_rider',
  'migration_sniper',
  'high_win_rate',
  'momentum_burst',
  'steady_compounder',
  'reversal_scalper',
] as const;

export type AdmissionOverrideProfileId =
  (typeof ADMISSION_OVERRIDE_PROFILE_IDS)[number];

export const DEFAULT_FAST_ARM_PROXIMITY_PCT = 12;
export const DEFAULT_FLOW_MAX_WAITING_ARM_MINUTES = 10;
export const SELECTIVE_WAITING_ARM_TIMEOUT_MS = 20 * 60_000;

export function isAdmissionMode(raw: unknown): raw is AdmissionMode {
  return raw === 'selective' || raw === 'flow' || raw === 'hybrid';
}

export function normalizeAdmissionMode(raw: unknown): AdmissionMode {
  return isAdmissionMode(raw) ? raw : 'hybrid';
}

export function clampFastArmProximityPct(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_FAST_ARM_PROXIMITY_PCT;
  return Math.min(20, Math.max(5, Math.round(n)));
}

export function clampFlowMaxWaitingArmMinutes(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_FLOW_MAX_WAITING_ARM_MINUTES;
  return Math.min(20, Math.max(5, Math.round(n)));
}

export function getAdmissionMode(): AdmissionMode {
  return normalizeAdmissionMode(config.admissionMode);
}

export function getFastArmProximityPct(): number {
  return clampFastArmProximityPct(config.fastArmProximityPct);
}

export function getFlowMaxWaitingArmMinutes(): number {
  return clampFlowMaxWaitingArmMinutes(config.flowMaxWaitingArmMinutes);
}

export function getAdmissionModeByProfile(): Partial<
  Record<AdmissionOverrideProfileId, AdmissionMode>
> {
  const raw = config.admissionModeByProfile;
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<Record<AdmissionOverrideProfileId, AdmissionMode>> = {};
  for (const id of ADMISSION_OVERRIDE_PROFILE_IDS) {
    const v = raw[id];
    if (isAdmissionMode(v)) out[id] = v;
  }
  return out;
}

export function resolveProfileAdmissionMode(
  profileId?: string | null
): AdmissionMode {
  const id = String(profileId || '').trim();
  const overrides = getAdmissionModeByProfile();
  if (
    id &&
    (ADMISSION_OVERRIDE_PROFILE_IDS as readonly string[]).includes(id)
  ) {
    const ov = overrides[id as AdmissionOverrideProfileId];
    if (ov) return ov;
  }
  return getAdmissionMode();
}

export function waitingArmTimeoutMs(profileId?: string | null): number {
  const mode = resolveProfileAdmissionMode(profileId);
  if (mode === 'selective') return SELECTIVE_WAITING_ARM_TIMEOUT_MS;
  return getFlowMaxWaitingArmMinutes() * 60_000;
}

export function shouldSkipMarlReorder(profileId?: string | null): boolean {
  return resolveProfileAdmissionMode(profileId) === 'flow';
}

export function isArmedLikeEntryPath(entryPath?: string | null): boolean {
  const p = String(entryPath || '').toLowerCase();
  return (
    p === 'armed_trigger' ||
    p === 'hybrid_fast_arm' ||
    p === 'flow_fast_arm' ||
    p === 'selective_arm'
  );
}

export function fastArmEntryPathForMode(mode: AdmissionMode): FastArmEntryPath {
  return mode === 'flow' ? 'flow_fast_arm' : 'hybrid_fast_arm';
}

export function isWithinFastArmProximity(
  price: number | null | undefined,
  level: number | null | undefined,
  pct?: number | null
): boolean {
  const px = Number(price);
  const lv = Number(level);
  const p = clampFastArmProximityPct(
    pct == null ? getFastArmProximityPct() : pct
  );
  if (!(px > 0) || !(lv > 0)) return false;
  return Math.abs(px - lv) / lv <= p / 100;
}

export function playbookLevelsForFastArm(opts: {
  supportPriceSol?: number | null;
  fib05PriceSol?: number | null;
  fib618PriceSol?: number | null;
  resistancePriceSol?: number | null;
}): number[] {
  const out: number[] = [];
  for (const n of [
    opts.supportPriceSol,
    opts.fib05PriceSol,
    opts.fib618PriceSol,
  ]) {
    const v = Number(n);
    if (v > 0) out.push(v);
  }
  return out;
}

export function nearestProximityPct(
  price: number | null | undefined,
  levels: number[]
): number | null {
  const px = Number(price);
  if (!(px > 0) || !levels.length) return null;
  let best: number | null = null;
  for (const lv of levels) {
    if (!(lv > 0)) continue;
    const pct = (Math.abs(px - lv) / lv) * 100;
    if (best == null || pct < best) best = pct;
  }
  return best;
}

export type FastArmEval = {
  fastArm: boolean;
  reason: string;
  proximityPct: number | null;
  mode: AdmissionMode;
  entryPath: string;
};

export function shouldFastArmOpen(opts: {
  profileId?: string | null;
  armedWatch?: boolean;
  lateChase?: boolean;
  lastPriceSol?: number | null;
  supportPriceSol?: number | null;
  fib05PriceSol?: number | null;
  fib618PriceSol?: number | null;
  nearKeyFib?: boolean;
  nearSupport?: boolean;
  nearMultiTfSupport?: boolean;
  hasLevelEvidence?: boolean;
  confluenceCount?: number | null;
  minConfluence?: number | null;
}): FastArmEval {
  const mode = resolveProfileAdmissionMode(opts.profileId);
  const entryPath = fastArmEntryPathForMode(mode);
  if (opts.armedWatch === true) {
    return {
      fastArm: false,
      reason: 'armed_handoff',
      proximityPct: null,
      mode,
      entryPath: 'armed_trigger',
    };
  }
  if (mode === 'selective') {
    return {
      fastArm: false,
      reason: 'selective_park',
      proximityPct: null,
      mode,
      entryPath: 'selective_arm',
    };
  }
  if (opts.lateChase === true) {
    return {
      fastArm: false,
      reason: 'late_chase',
      proximityPct: null,
      mode,
      entryPath,
    };
  }
  const levels = playbookLevelsForFastArm(opts);
  const px = Number(opts.lastPriceSol);
  const proximityPct = nearestProximityPct(px, levels);
  const pctLimit = getFastArmProximityPct();
  const nearByPrice =
    proximityPct != null && proximityPct <= pctLimit;
  const nearByFlag =
    opts.nearKeyFib === true ||
    opts.nearSupport === true ||
    opts.nearMultiTfSupport === true;
  const hasLevel =
    opts.hasLevelEvidence === true ||
    nearByFlag ||
    levels.length > 0;
  const minC = Number(opts.minConfluence);
  const haveC = Number(opts.confluenceCount);
  const confluenceOk =
    !(Number.isFinite(minC) && minC > 0) ||
    (Number.isFinite(haveC) && haveC >= minC) ||
    hasLevel;
  if (!hasLevel) {
    return {
      fastArm: false,
      reason: 'no_level',
      proximityPct,
      mode,
      entryPath,
    };
  }
  if (!confluenceOk) {
    return {
      fastArm: false,
      reason: 'confluence',
      proximityPct,
      mode,
      entryPath,
    };
  }
  if (!nearByPrice && !nearByFlag) {
    return {
      fastArm: false,
      reason: 'not_near',
      proximityPct,
      mode,
      entryPath,
    };
  }
  return {
    fastArm: true,
    reason: 'fast_arm',
    proximityPct: proximityPct ?? (nearByFlag ? 0 : null),
    mode,
    entryPath,
  };
}

export function setAdmissionMode(next: AdmissionMode): AdmissionMode {
  const mode = normalizeAdmissionMode(next);
  config.admissionMode = mode;
  persistUserSettings();
  return mode;
}

export function setFastArmProximityPct(raw: unknown): number {
  const n = clampFastArmProximityPct(raw);
  config.fastArmProximityPct = n;
  persistUserSettings();
  return n;
}

export function setFlowMaxWaitingArmMinutes(raw: unknown): number {
  const n = clampFlowMaxWaitingArmMinutes(raw);
  config.flowMaxWaitingArmMinutes = n;
  persistUserSettings();
  return n;
}

export function setAdmissionModeByProfile(
  next: Partial<Record<string, AdmissionMode | '' | null>> | null | undefined
): Partial<Record<AdmissionOverrideProfileId, AdmissionMode>> {
  const out: Partial<Record<AdmissionOverrideProfileId, AdmissionMode>> = {};
  if (next && typeof next === 'object') {
    for (const id of ADMISSION_OVERRIDE_PROFILE_IDS) {
      const v = next[id];
      if (isAdmissionMode(v)) out[id] = v;
    }
  }
  config.admissionModeByProfile = out;
  persistUserSettings();
  return out;
}

export function getAdmissionModeStatus(): {
  admissionMode: AdmissionMode;
  fastArmProximityPct: number;
  flowMaxWaitingArmMinutes: number;
  admissionModeByProfile: Partial<
    Record<AdmissionOverrideProfileId, AdmissionMode>
  >;
} {
  return {
    admissionMode: getAdmissionMode(),
    fastArmProximityPct: getFastArmProximityPct(),
    flowMaxWaitingArmMinutes: getFlowMaxWaitingArmMinutes(),
    admissionModeByProfile: getAdmissionModeByProfile(),
  };
}
