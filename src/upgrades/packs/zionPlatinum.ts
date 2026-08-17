import { isUpgradeEnabled } from '../registry';

let savedMax: number | null = null;

export function enableZionPlatinum(): void {
  try {
    const { config } = require('../../config') as typeof import('../../config');
    if (savedMax == null) savedMax = Number(config.zion.maxMcUsd) || 500_000_000;
    config.zion.maxMcUsd = 2_000_000_000;
    (config.zion as { autoHandoffToHwr?: boolean }).autoHandoffToHwr = true;
    console.log('[upgrades] zion_platinum ON — max MC $2B + HWR handoff flag');
  } catch (err) {
    console.warn(
      '[upgrades] zion_platinum enable failed:',
      err instanceof Error ? err.message : err
    );
  }
}

export function disableZionPlatinum(): void {
  try {
    const { config } = require('../../config') as typeof import('../../config');
    if (savedMax != null) config.zion.maxMcUsd = savedMax;
    (config.zion as { autoHandoffToHwr?: boolean }).autoHandoffToHwr = false;
    console.log('[upgrades] zion_platinum OFF');
  } catch {
    /* ignore */
  }
}

export function zionPlatinumHandoffEligible(mcUsd: number | undefined): boolean {
  if (!isUpgradeEnabled('zion_platinum')) return false;
  return (mcUsd ?? 0) >= 1_000_000_000;
}
