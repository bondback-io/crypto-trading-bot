/**
 * Isolated GitHub backup hardening pack.
 * ON: 60s min gap on scheduled uploads. Auto-import stays off either way.
 */

let enabled = false;

export function isGithubBackupHardeningEnabled(): boolean {
  return enabled;
}

export function enableGithubBackupHardening(): void {
  enabled = true;
  console.log('[upgrades] github_backup_hardening ON — 60s scheduled upload gap');
}

export function disableGithubBackupHardening(): void {
  enabled = false;
  console.log('[upgrades] github_backup_hardening OFF');
}
