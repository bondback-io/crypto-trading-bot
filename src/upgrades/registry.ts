/**
 * Persist and query which upgrade packs are enabled.
 * Missing / empty list = all off (stable 1.2.21 core).
 */

import { persistUserSettings } from './configBridge';
import {
  getUpgradePack,
  isReadyUpgradeId,
  isRpcLaneMapId,
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

/** Keep the last selected RPC lane map; drop earlier ones. */
export function enforceRpcLaneExclusion(ids: string[]): string[] {
  let lastMap: string | null = null;
  for (const id of ids) {
    if (isRpcLaneMapId(id)) lastMap = id;
  }
  if (!lastMap) return ids;
  return ids.filter((id) => !isRpcLaneMapId(id) || id === lastMap);
}

export function getEnabledUpgradeIds(): string[] {
  return [...enabledIds];
}

export function isUpgradeEnabled(id: string): boolean {
  return enabledIds.has(id);
}

export function getActiveRpcLaneMap(): string | null {
  for (const id of enabledIds) {
    if (isRpcLaneMapId(id)) return id;
  }
  return null;
}

export function hydrateEnabledUpgrades(raw: unknown): string[] {
  const ids = enforceRpcLaneExclusion(
    normalizeEnabledIds(raw).filter(isReadyUpgradeId)
  );
  enabledIds = new Set(ids);
  return getEnabledUpgradeIds();
}

export function setEnabledUpgradeIds(raw: unknown): {
  enabled: string[];
  rejected: string[];
  droppedLaneMaps: string[];
} {
  const requested = normalizeEnabledIds(raw);
  const rejected = requested.filter((id) => !isReadyUpgradeId(id));
  if (rejected.length) {
    throw new Error(
      `Cannot enable packs that are not rebuilt yet: ${rejected.join(', ')}`
    );
  }
  const unknown = Array.isArray(raw)
    ? raw
        .map((x) => String(x || '').trim())
        .filter((id) => id && !getUpgradePack(id))
    : [];
  if (unknown.length) {
    throw new Error(`Unknown upgrade pack(s): ${unknown.join(', ')}`);
  }
  const laneRequested = requested.filter(isRpcLaneMapId);
  const enabled = enforceRpcLaneExclusion(requested);
  const droppedLaneMaps = laneRequested.filter((id) => !enabled.includes(id));
  enabledIds = new Set(enabled);
  persistUserSettings();
  return { enabled: getEnabledUpgradeIds(), rejected: [], droppedLaneMaps };
}

export function listUpgradePacks(): UpgradePackMeta[] {
  return [...UPGRADE_PACKS];
}
