/**
 * System Load Mode — gates extra background services only (no RPC remap).
 * Pack OFF: 1.2.21 extras run as usual. Pack ON: Basic / Premium / Full.
 */

import { atomicWriteJson, dataFile, readJsonFile } from '../../dataDir';
import { isUpgradeEnabled } from '../registry';

export type SystemLoadMode = 'basic' | 'premium' | 'full';

export type LoadServiceId =
  | 'zion_kol_scanner'
  | 'github_backup'
  | 'email_botperf'
  | 'influencer_mirror';

const FILE = () => dataFile('upgrade-system-load-mode.json');

const PREMIUM = new Set<LoadServiceId>(['github_backup', 'email_botperf']);

let mode: SystemLoadMode = 'basic';
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  const raw = readJsonFile<{ mode?: string }>(FILE());
  mode =
    raw?.mode === 'premium' || raw?.mode === 'full' ? raw.mode : 'basic';
}

export function getSystemLoadMode(): SystemLoadMode {
  load();
  return mode;
}

export function setSystemLoadMode(v: unknown): SystemLoadMode {
  load();
  mode = v === 'premium' || v === 'full' ? v : 'basic';
  atomicWriteJson(FILE(), { mode });
  return mode;
}

/** Pack OFF → every extra service stays on (1.2.21). */
export function isLoadServiceEnabled(id: LoadServiceId): boolean {
  if (!isUpgradeEnabled('system_load_mode')) return true;
  load();
  if (mode === 'full') return true;
  if (mode === 'premium') return PREMIUM.has(id);
  return false;
}

export function enableSystemLoadMode(): void {
  load();
  console.log(`[upgrades] system_load_mode ON — extras=${mode}`);
}

export function disableSystemLoadMode(): void {
  console.log('[upgrades] system_load_mode OFF — extras unrestricted');
}
