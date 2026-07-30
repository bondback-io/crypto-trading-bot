/**
 * Live Bot Info inventory — derived from catalogs so the dashboard manual
 * stays in sync when profiles / modules / modes change.
 */

import type { TradingMode } from './config';
import type { MlLearnMode } from './profileLearningMl';
import type { SelfLearnMode } from './profileSelfLearning';
import {
  NAMED_STRATEGY_PROFILES,
  STRATEGY_GROUP_LABELS,
  STRATEGY_GROUP_ORDER,
  STRATEGY_PRESET_META,
  STRATEGY_REGISTRY,
  type StrategyGroup,
} from './strategies';
import { TRADE_PROFILE_CATALOG } from './tradeProfiles';

/** Canonical mode order — must match TradingMode union. */
export const TRADING_MODE_ORDER = [
  'paper',
  'liveSimulation',
  'live',
] as const satisfies readonly TradingMode[];

export const SELF_LEARN_MODE_ORDER = [
  'shadow',
  'auto',
] as const satisfies readonly SelfLearnMode[];

export const ML_LEARN_MODE_ORDER = [
  'off',
  'shadow',
  'hybrid',
  'lead',
] as const satisfies readonly MlLearnMode[];

const MODE_BLURBS: Record<
  TradingMode,
  { label: string; cssClass: string; blurb: string; bullet: string }
> = {
  paper: {
    label: 'Paper',
    cssClass: 'paper',
    blurb:
      'Virtual fills. Optional live marks. Safest place to test sizing and exits — no real SOL.',
    bullet:
      'practice ledger; good for UI and exit logic without live filter pressure.',
  },
  liveSimulation: {
    label: 'Live Sim',
    cssClass: 'livesim',
    blurb:
      'Same live filters and market path as Live, but a paper ledger only. Default training mode.',
    bullet:
      'recommended daily mode: live market data + live filters, zero real SOL.',
  },
  live: {
    label: 'Live',
    cssClass: 'live',
    blurb:
      'Real Jupiter swaps with your trading wallet. Confirm carefully — real funds move.',
    bullet:
      'Jupiter execution path with MEV options; needs funded trading wallet keys on the server.',
  },
};

/** Heuristic × ML cell labels for the learning matrix. */
const MATRIX_CELL: Record<
  SelfLearnMode,
  Record<MlLearnMode, { label: string; tone: 'ok' | 'warn' | 'off' }>
> = {
  shadow: {
    off: { label: 'propose only', tone: 'off' },
    shadow: { label: 'advise + ML watch', tone: 'ok' },
    hybrid: { label: 'blend ranks', tone: 'warn' },
    lead: { label: 'ML ranks first', tone: 'warn' },
  },
  auto: {
    off: { label: 'apply upgrades', tone: 'ok' },
    shadow: { label: 'apply + ML advise', tone: 'ok' },
    hybrid: { label: 'apply + blend', tone: 'warn' },
    lead: { label: 'ML can lead deltas', tone: 'warn' },
  },
};

export interface BotInfoProfileEntry {
  id: string;
  name: string;
  color: string;
  description: string;
  style: string;
  rulesSummary: string[];
}

export interface BotInfoModuleEntry {
  key: string;
  name: string;
  group: StrategyGroup;
  description: string;
}

export interface BotInfoModuleGroup {
  group: StrategyGroup;
  label: string;
  modules: BotInfoModuleEntry[];
}

export interface BotInfoPresetEntry {
  id: string;
  label: string;
  description: string;
}

export interface BotInfoModeEntry {
  id: TradingMode;
  label: string;
  cssClass: string;
  blurb: string;
  bullet: string;
}

export interface BotInfoSnapshot {
  profiles: BotInfoProfileEntry[];
  modules: BotInfoModuleEntry[];
  moduleGroups: BotInfoModuleGroup[];
  presets: BotInfoPresetEntry[];
  modes: BotInfoModeEntry[];
  selfLearnModes: readonly SelfLearnMode[];
  mlLearnModes: readonly MlLearnMode[];
  matrixCell: typeof MATRIX_CELL;
  counts: {
    profiles: number;
    modules: number;
    presets: number;
  };
}

export function buildBotInfoSnapshot(): BotInfoSnapshot {
  const profiles: BotInfoProfileEntry[] = TRADE_PROFILE_CATALOG.map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    description: String(p.description || '').trim(),
    style: p.style,
    rulesSummary: [...(p.rulesSummary || [])],
  }));

  const modules: BotInfoModuleEntry[] = STRATEGY_REGISTRY.map((s) => ({
    key: s.key,
    name: s.name,
    group: s.group,
    description: String(s.description || '').trim(),
  }));

  const moduleGroups: BotInfoModuleGroup[] = STRATEGY_GROUP_ORDER.map(
    (group) => ({
      group,
      label: STRATEGY_GROUP_LABELS[group],
      modules: modules.filter((m) => m.group === group),
    })
  ).filter((g) => g.modules.length > 0);

  const presets: BotInfoPresetEntry[] = NAMED_STRATEGY_PROFILES.map((id) => {
    const meta = STRATEGY_PRESET_META[id];
    return {
      id,
      label: meta?.label || id,
      description: String(meta?.description || '').trim(),
    };
  });

  const modes: BotInfoModeEntry[] = TRADING_MODE_ORDER.map((id) => ({
    id,
    ...MODE_BLURBS[id],
  }));

  return {
    profiles,
    modules,
    moduleGroups,
    presets,
    modes,
    selfLearnModes: SELF_LEARN_MODE_ORDER,
    mlLearnModes: ML_LEARN_MODE_ORDER,
    matrixCell: MATRIX_CELL,
    counts: {
      profiles: profiles.length,
      modules: modules.length,
      presets: presets.length,
    },
  };
}

/**
 * Returns human-readable drift / quality errors (empty = OK).
 * Used by scripts/checkBotInfoDrift.ts and can be called in tests.
 */
export function collectBotInfoDriftErrors(
  snap: BotInfoSnapshot = buildBotInfoSnapshot()
): string[] {
  const errors: string[] = [];

  const catalogIds = TRADE_PROFILE_CATALOG.map((p) => p.id).sort();
  const snapIds = snap.profiles.map((p) => p.id).sort();
  if (catalogIds.join('\0') !== snapIds.join('\0')) {
    errors.push(
      `Profile IDs drifted: catalog=[${catalogIds.join(',')}] snapshot=[${snapIds.join(',')}]`
    );
  }

  const regKeys = STRATEGY_REGISTRY.map((s) => s.key).sort();
  const snapKeys = snap.modules.map((m) => m.key).sort();
  if (regKeys.join('\0') !== snapKeys.join('\0')) {
    errors.push(
      `Module keys drifted: registry=[${regKeys.join(',')}] snapshot=[${snapKeys.join(',')}]`
    );
  }

  const modeIds = snap.modes.map((m) => m.id);
  if (
    modeIds.length !== TRADING_MODE_ORDER.length ||
    TRADING_MODE_ORDER.some((m, i) => modeIds[i] !== m)
  ) {
    errors.push(
      `Trading modes drifted: expected [${TRADING_MODE_ORDER.join(',')}] got [${modeIds.join(',')}]`
    );
  }

  for (const p of TRADE_PROFILE_CATALOG) {
    if (!String(p.description || '').trim()) {
      errors.push(`Profile "${p.id}" has empty description`);
    }
  }
  for (const s of STRATEGY_REGISTRY) {
    if (!String(s.description || '').trim()) {
      errors.push(`Module "${s.key}" has empty description`);
    }
  }

  for (const id of NAMED_STRATEGY_PROFILES) {
    const meta = STRATEGY_PRESET_META[id];
    if (!meta || !String(meta.description || '').trim()) {
      errors.push(`Preset "${id}" missing description in STRATEGY_PRESET_META`);
    }
  }

  for (const h of SELF_LEARN_MODE_ORDER) {
    for (const ml of ML_LEARN_MODE_ORDER) {
      if (!snap.matrixCell[h]?.[ml]?.label) {
        errors.push(`Learning matrix missing cell ${h}×${ml}`);
      }
    }
  }

  return errors;
}
