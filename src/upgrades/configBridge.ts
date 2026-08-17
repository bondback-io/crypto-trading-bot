/**
 * Late bind persist so upgrades/registry does not import config at module load
 * (config.ts imports settingsStore; we keep that one-way).
 */

export function persistUserSettings(): boolean {
  const { persistUserSettings: persist } =
    require('../config') as typeof import('../config');
  return persist();
}
