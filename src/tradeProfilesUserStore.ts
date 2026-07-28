/**
 * Dedicated durable store for user-owned micro-bot knobs.
 *
 * Survives baked strategy-default re-imports on deploy. Always reloaded on boot
 * after config.json + bake, so overrides / self-learning / profile enables win.
 */

import {
  atomicWriteJson,
  dataFile,
  ensureDataDir,
  PERSIST_FILES,
  readJsonFile,
} from './dataDir';
import type { TradeProfileRuntimeState } from './tradeProfiles';

export const TRADE_PROFILES_USER_VERSION = 1 as const;

export interface TradeProfilesUserState {
  version: typeof TRADE_PROFILES_USER_VERSION;
  updatedAt: number;
  enabled?: boolean;
  smartBotProfiles?: boolean;
  profiles?: TradeProfileRuntimeState['profiles'];
  overrides?: TradeProfileRuntimeState['overrides'];
  selfLearning?: TradeProfileRuntimeState['selfLearning'];
}

const USER_FILE = () => dataFile(PERSIST_FILES.tradeProfilesUser);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function tradeProfilesUserFilePath(): string {
  return USER_FILE();
}

export function loadTradeProfilesUserState(): TradeProfilesUserState | null {
  try {
    ensureDataDir();
    const raw = readJsonFile<TradeProfilesUserState>(USER_FILE());
    if (!raw || !isPlainObject(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Snapshot runtime trade-profile user knobs → data/trade-profiles-user.json */
export function saveTradeProfilesUserState(
  state: Partial<TradeProfileRuntimeState> | null | undefined
): void {
  if (!state || typeof state !== 'object') return;
  try {
    ensureDataDir();
    const payload: TradeProfilesUserState = {
      version: TRADE_PROFILES_USER_VERSION,
      updatedAt: Date.now(),
      enabled: state.enabled !== false,
      smartBotProfiles: state.smartBotProfiles === true,
      profiles: state.profiles
        ? (JSON.parse(JSON.stringify(state.profiles)) as TradeProfilesUserState['profiles'])
        : undefined,
      overrides: state.overrides
        ? (JSON.parse(
            JSON.stringify(state.overrides)
          ) as TradeProfilesUserState['overrides'])
        : undefined,
      selfLearning: state.selfLearning
        ? (JSON.parse(
            JSON.stringify(state.selfLearning)
          ) as TradeProfilesUserState['selfLearning'])
        : undefined,
    };
    atomicWriteJson(USER_FILE(), payload);
  } catch (err) {
    console.error(
      '[trade-profiles-user] Failed to save:',
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Seed trade-profiles-user.json from in-memory / config state when missing.
 * Returns true if a new file was written.
 */
export function migrateTradeProfilesUserStateFromRuntime(
  state: Partial<TradeProfileRuntimeState> | null | undefined
): boolean {
  if (loadTradeProfilesUserState()) return false;
  if (!state) return false;
  const hasOverrides =
    state.overrides && Object.keys(state.overrides).length > 0;
  const hasSelfLearn =
    state.selfLearning && Object.keys(state.selfLearning).length > 0;
  const hasProfiles =
    state.profiles && Object.keys(state.profiles).length > 0;
  if (!hasOverrides && !hasSelfLearn && !hasProfiles) return false;
  saveTradeProfilesUserState(state);
  console.log(
    '[trade-profiles-user] Migrated user knobs from runtime → trade-profiles-user.json'
  );
  return true;
}

/**
 * Apply dedicated user file on top of current runtime (wins over bake/defaults).
 * Call after applyPersistedSettings + baked defaults on boot.
 */
export function applyTradeProfilesUserStateOnBoot(): boolean {
  try {
    const {
      ensureTradeProfilesInitialized,
      serializeTradeProfilesForPersist,
      hydrateTradeProfilesFromSettings,
    } = require('./tradeProfiles') as typeof import('./tradeProfiles');

    ensureTradeProfilesInitialized();
    migrateTradeProfilesUserStateFromRuntime(
      serializeTradeProfilesForPersist()
    );

    const user = loadTradeProfilesUserState();
    if (!user) return false;

    const current = serializeTradeProfilesForPersist();
    hydrateTradeProfilesFromSettings({
      tradeProfiles: {
        enabled:
          typeof user.enabled === 'boolean' ? user.enabled : current.enabled,
        smartBotProfiles:
          typeof user.smartBotProfiles === 'boolean'
            ? user.smartBotProfiles
            : current.smartBotProfiles,
        profiles: user.profiles
          ? { ...current.profiles, ...user.profiles }
          : current.profiles,
        overrides: user.overrides
          ? { ...(current.overrides || {}), ...user.overrides }
          : current.overrides,
        selfLearning: user.selfLearning
          ? { ...(current.selfLearning || {}), ...user.selfLearning }
          : current.selfLearning,
        autoScoring: current.autoScoring,
      },
    });

    console.log(
      `[trade-profiles-user] Restored user knobs from ${PERSIST_FILES.tradeProfilesUser}` +
        ` · overrides=${Object.keys(user.overrides || {}).length}` +
        ` · selfLearn=${Object.keys(user.selfLearning || {}).length}`
    );

    try {
      const { ensureSelfLearningDefaultsForAllProfiles } =
        require('./tradeProfiles') as typeof import('./tradeProfiles');
      const seeded = ensureSelfLearningDefaultsForAllProfiles({ persist: true });
      if (seeded > 0) {
        console.log(
          `[trade-profiles-user] Seeded self-learning ON for ${seeded} profile(s)`
        );
      }
    } catch {
      /* optional */
    }
    return true;
  } catch (err) {
    console.warn(
      '[trade-profiles-user] Boot restore skipped:',
      err instanceof Error ? err.message : err
    );
    return false;
  }
}
