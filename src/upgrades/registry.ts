/**
 * Persist and query which upgrade packs are enabled.
 * Missing / empty list = all off (stable 1.2.21 core).
 */

import { persistUserSettings } from './configBridge';
import {
  getUpgradePack,
  isReadyUpgradeId,
  UPGRADE_PACKS,
  type UpgradePackMeta,
} from './catalog';

let enabledIds = new Set<string>();

export function normalizeEnabledIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const id = String(item || '').trim();
    if (!id || seen.has(id)) continue;
    if (!getUpgradePack(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function getEnabledUpgradeIds(): string[] {
  return [...enabledIds];
}

export function isUpgradeEnabled(id: string): boolean {
  return enabledIds.has(id);
}

export function hydrateEnabledUpgrades(raw: unknown): string[] {
  const ids = normalizeEnabledIds(raw).filter(isReadyUpgradeId);
  enabledIds = new Set(ids);
  return getEnabledUpgradeIds();
}

export function setEnabledUpgradeIds(raw: unknown): {
  enabled: string[];
  rejected: string[];
} {
  const requested = normalizeEnabledIds(raw);
  const rejected = requested.filter((id) => !isReadyUpgradeId(id));
  if (rejected.length) {
    throw new Error(
      `Cannot enable packs that are not rebuilt yet: ${rejected.join(', ')}`
    );
  }
  enabledIds = new Set(requested);
  persistUserSettings();
  return { enabled: getEnabledUpgradeIds(), rejected: [] };
}

export function listUpgradePacks(): UpgradePackMeta[] {
  return [...UPGRADE_PACKS];
}
