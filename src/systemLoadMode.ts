/**
 * Operator System Load Mode — Basic / Premium / Full.
 * Trading fleet (scanner core → gates → watch/arm/open → exits → learning)
 * stays on in every mode. Optional background services and RPC emergency
 * slots scale with the selected mode.
 */

export type SystemLoadMode = 'basic' | 'premium' | 'full';

export const SYSTEM_LOAD_MODES: readonly SystemLoadMode[] = [
  'basic',
  'premium',
  'full',
] as const;

export type LoadServiceId =
  | 'pump_stream'
  | 'graduating_feed'
  | 'majors_medium'
  | 'specialty_feeds'
  | 'alpha_scan'
  | 'onchain_helius'
  | 'zion_kol_scanner'
  | 'zion_ambient'
  | 'zion_supervision'
  | 'zion_self_update'
  | 'zion_fight_log'
  | 'zion_dashboard_poll'
  | 'zion_chat_poll'
  | 'zion_offer_email'
  | 'email_alerts'
  | 'email_profit'
  | 'email_botperf'
  | 'github_backup'
  | 'gmgn_discovery'
  | 'monitor_activity'
  | 'spike_inspector'
  | 'influencer_mirror'
  | 'botperf_cells';

const PREMIUM_SERVICES = new Set<LoadServiceId>([
  'pump_stream',
  'graduating_feed',
  'majors_medium',
  'specialty_feeds',
  'email_alerts',
  'email_profit',
  'email_botperf',
  'github_backup',
  'gmgn_discovery',
  'monitor_activity',
  'spike_inspector',
  'botperf_cells',
]);

const FULL_ONLY_SERVICES = new Set<LoadServiceId>([
  'alpha_scan',
  'onchain_helius',
  'zion_kol_scanner',
  'zion_ambient',
  'zion_supervision',
  'zion_self_update',
  'zion_fight_log',
  'zion_dashboard_poll',
  'zion_chat_poll',
  'zion_offer_email',
  'influencer_mirror',
]);

export function isSystemLoadMode(v: unknown): v is SystemLoadMode {
  return v === 'basic' || v === 'premium' || v === 'full';
}

export function parseSystemLoadMode(v: unknown): SystemLoadMode {
  return isSystemLoadMode(v) ? v : 'basic';
}

export function systemLoadModeLabel(mode: SystemLoadMode): string {
  if (mode === 'premium') return 'Premium';
  if (mode === 'full') return 'Full';
  return 'Basic';
}

export function emergencySlotCount(mode: SystemLoadMode): number {
  if (mode === 'full') return 3;
  if (mode === 'premium') return 2;
  return 1;
}

function currentMode(): SystemLoadMode {
  try {
    const { config } = require('./config') as typeof import('./config');
    return parseSystemLoadMode(
      (config as { systemLoadMode?: unknown }).systemLoadMode
    );
  } catch {
    return 'basic';
  }
}

/** Mode forces OFF even if a leftover feature knob is ON. */
export function isLoadServiceEnabled(
  id: LoadServiceId,
  mode?: SystemLoadMode
): boolean {
  const m = mode ?? currentMode();
  if (m === 'full') return true;
  if (m === 'premium') return PREMIUM_SERVICES.has(id);
  return false;
}

export function getLoadServiceFlags(
  mode?: SystemLoadMode
): Record<LoadServiceId, boolean> {
  const m = mode ?? currentMode();
  const ids: LoadServiceId[] = [
    ...PREMIUM_SERVICES,
    ...FULL_ONLY_SERVICES,
  ];
  const out = {} as Record<LoadServiceId, boolean>;
  for (const id of ids) out[id] = isLoadServiceEnabled(id, m);
  return out;
}

function syncLoadModeTimers(): void {
  try {
    const { applyRpcGateLoadMode } =
      require('./rpcGate') as typeof import('./rpcGate');
    applyRpcGateLoadMode(currentMode());
  } catch {
    /* optional */
  }
  try {
    const { syncZionKolScannerLifecycle } =
      require('./zionKolScanner') as typeof import('./zionKolScanner');
    syncZionKolScannerLifecycle();
  } catch {
    /* optional */
  }
  try {
    const {
      startZionAmbientNudgeScheduler,
      stopZionAmbientNudgeScheduler,
    } = require('./zionAmbientNudges') as typeof import('./zionAmbientNudges');
    if (isLoadServiceEnabled('zion_ambient')) startZionAmbientNudgeScheduler();
    else stopZionAmbientNudgeScheduler();
  } catch {
    /* optional */
  }
  try {
    const {
      startZionSupervisionScheduler,
      stopZionSupervisionScheduler,
    } = require('./zionSupervision') as typeof import('./zionSupervision');
    if (isLoadServiceEnabled('zion_supervision')) {
      startZionSupervisionScheduler();
    } else {
      stopZionSupervisionScheduler();
    }
  } catch {
    /* optional */
  }
  try {
    const {
      startZionLearningScheduler,
      stopZionLearningScheduler,
    } =
      require('./zionContinuousLearning') as typeof import('./zionContinuousLearning');
    if (isLoadServiceEnabled('zion_self_update')) startZionLearningScheduler();
    else stopZionLearningScheduler();
  } catch {
    /* optional */
  }
  try {
    const {
      startProfitEmailScheduler,
      stopProfitEmailScheduler,
    } = require('./profitEmail') as typeof import('./profitEmail');
    if (isLoadServiceEnabled('email_profit')) startProfitEmailScheduler();
    else stopProfitEmailScheduler();
  } catch {
    /* optional */
  }
  try {
    const {
      startBotPerfEmailScheduler,
      stopBotPerfEmailScheduler,
    } =
      require('./botPerformanceEmail') as typeof import('./botPerformanceEmail');
    if (isLoadServiceEnabled('email_botperf')) startBotPerfEmailScheduler();
    else stopBotPerfEmailScheduler();
  } catch {
    /* optional */
  }
  try {
    const {
      startGithubSiteBackupScheduler,
      stopGithubSiteBackupScheduler,
    } = require('./githubSiteBackup') as typeof import('./githubSiteBackup');
    if (isLoadServiceEnabled('github_backup')) startGithubSiteBackupScheduler();
    else stopGithubSiteBackupScheduler();
  } catch {
    /* optional */
  }
  try {
    const {
      startDiscoveryAutoRefresh,
      stopDiscoveryAutoRefresh,
    } = require('./gmgn') as typeof import('./gmgn');
    if (isLoadServiceEnabled('gmgn_discovery')) startDiscoveryAutoRefresh();
    else stopDiscoveryAutoRefresh();
  } catch {
    /* optional */
  }
  try {
    const { startPumpPortalStream, stopPumpPortalStream } =
      require('./pumpPortalStream') as typeof import('./pumpPortalStream');
    if (isLoadServiceEnabled('pump_stream')) startPumpPortalStream();
    else stopPumpPortalStream();
  } catch {
    /* optional */
  }
}

/**
 * Rebuild RPC inventory + optional scheduler sync.
 * Does not stop monitor, exits, or learning.
 */
export function applySystemLoadMode(opts?: {
  restartTimers?: boolean;
}): {
  mode: SystemLoadMode;
  flags: Record<LoadServiceId, boolean>;
} {
  const mode = currentMode();
  try {
    const { config } = require('./config') as typeof import('./config');
    const { rpcEndpointsFromEnv } = require('./rpcUrl') as typeof import('./rpcUrl');
    config.rpc.endpoints = rpcEndpointsFromEnv();
    config.rpc.shareLoad = true;
  } catch {
    /* config may still be initializing */
  }
  try {
    const { applyRpcGateLoadMode } =
      require('./rpcGate') as typeof import('./rpcGate');
    applyRpcGateLoadMode(mode);
  } catch {
    /* optional */
  }
  try {
    const { rebuildRpcEndpoints } =
      require('./connection') as typeof import('./connection');
    rebuildRpcEndpoints();
  } catch {
    /* connection may not be loaded yet */
  }
  if (opts?.restartTimers !== false) {
    syncLoadModeTimers();
  }
  console.log(
    `[load-mode] ${systemLoadModeLabel(mode)} — trading fleet on; ` +
      `optional services ${mode === 'full' ? 'all' : mode === 'premium' ? 'ops/monitoring' : 'off'}`
  );
  return { mode, flags: getLoadServiceFlags(mode) };
}
