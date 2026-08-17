/**
 * Optional hard restart. Upgrades apply in-process — do not call this from
 * /api/upgrades/apply. SIGTERM + exit looks like a crash on Render ("Instance failed").
 */

export function scheduleUpgradeReboot(delayMs = 800): void {
  setTimeout(() => {
    console.log('[upgrades] Hard restart — exiting for process restart');
    try {
      process.emit('SIGTERM');
    } catch {
      /* ignore */
    }
    setTimeout(() => process.exit(0), 400);
  }, delayMs);
}
