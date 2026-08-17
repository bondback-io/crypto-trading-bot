/** Exit so Render/PM2 starts a fresh process with the saved upgrade set. */

export function scheduleUpgradeReboot(delayMs = 800): void {
  setTimeout(() => {
    console.log('[upgrades] Save & reboot — exiting for process restart');
    try {
      process.emit('SIGTERM');
    } catch {
      /* ignore */
    }
    setTimeout(() => process.exit(0), 400);
  }, delayMs);
}
