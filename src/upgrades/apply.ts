/**
 * Boot apply: disable every pack that is not enabled, then enable ready packs.
 */

import { UPGRADE_PACKS } from './catalog';
import { getUpgradeRuntime } from './packs';
import { getEnabledUpgradeIds, isUpgradeEnabled } from './registry';

export function applyEnabledUpgrades(): {
  enabled: string[];
  skippedPending: string[];
} {
  const enabled = getEnabledUpgradeIds();
  const skippedPending: string[] = [];

  for (const pack of UPGRADE_PACKS) {
    const runtime = getUpgradeRuntime(pack.id);
    const on = isUpgradeEnabled(pack.id) && pack.status === 'ready';
    if (!on) {
      if (isUpgradeEnabled(pack.id) && pack.status !== 'ready') {
        skippedPending.push(pack.id);
      }
      try {
        runtime?.disable();
      } catch (err) {
        console.warn(
          `[upgrades] disable ${pack.id} failed:`,
          err instanceof Error ? err.message : err
        );
      }
      continue;
    }
    try {
      runtime?.enable();
    } catch (err) {
      console.warn(
        `[upgrades] enable ${pack.id} failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  console.log(
    `[upgrades] applied · on=${enabled.length ? enabled.join(',') : '(none)'}` +
      (skippedPending.length
        ? ` · skipped pending ${skippedPending.join(',')}`
        : '')
  );
  return { enabled, skippedPending };
}
