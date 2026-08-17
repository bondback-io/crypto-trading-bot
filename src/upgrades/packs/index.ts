import {
  disableGithubBackupHardening,
  enableGithubBackupHardening,
} from './githubBackupHardening';

export interface UpgradePackRuntime {
  enable: () => void;
  disable: () => void;
}

const RUNTIMES: Record<string, UpgradePackRuntime> = {
  github_backup_hardening: {
    enable: enableGithubBackupHardening,
    disable: disableGithubBackupHardening,
  },
};

export function getUpgradeRuntime(id: string): UpgradePackRuntime | undefined {
  return RUNTIMES[id];
}
