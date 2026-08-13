/**
 * RPC load diagnostic — choke hints + Poll (ms) recommendations for Config > RPC.
 * Recommend-only (does not mutate intervals).
 */

import { config } from './config';
import { getRpcStats } from './connection';
import { getJitoStatus } from './jito';
import { isPublicRpcUrl } from './rpcUrl';
import { isStrategyEnabledGlobal } from './strategies';

export type RpcDiagTarget =
  | 'wallet_poll'
  | 'market_scanner'
  | 'alpha_scan'
  | 'zion_scanner'
  | 'health';

export interface RpcDiagLaneSnapshot {
  label: string;
  healthy: boolean;
  latencyMs: number | null;
  successRate: number | null;
  public: boolean;
  failover: boolean;
  downForMs: number;
}

export interface RpcDiagLoader {
  id: string;
  lane: 'primary' | 'secondary' | 'utility' | 'all' | 'http';
  intervalMs: number;
  note: string;
}

export interface RpcDiagRecommendation {
  target: RpcDiagTarget;
  fieldLabel: string;
  currentMs: number;
  suggestedMs: number;
  reason: string;
}

export interface RpcLoadDiagnostic {
  at: number;
  primary: RpcDiagLaneSnapshot;
  secondary: RpcDiagLaneSnapshot;
  utility: RpcDiagLaneSnapshot;
  shareLoad: boolean;
  softWatch?: ReturnType<
    typeof import('./monitor').getSoftWatchRuntimeSnapshot
  > | null;
  chokeHints: string[];
  loaders: RpcDiagLoader[];
  recommendations: RpcDiagRecommendation[];
  jito: { bundlesEnabled: boolean; note: string };
  turboNote: string;
  rpc: ReturnType<typeof getRpcStats>;
  callTraffic?: ReturnType<typeof getRpcStats>['callTraffic'];
}

function bumpMs(current: number, floor: number, cap: number): number {
  const c = Math.max(0, Math.round(current) || 0);
  return Math.min(cap, Math.max(c, floor));
}

function pickEndpointStats(
  rpc: ReturnType<typeof getRpcStats>,
  lane: 'primary' | 'secondary' | 'utility'
): {
  label: string;
  healthy: boolean;
  latencyMs: number | null;
  successRate: number | null;
  url: string;
  failover: boolean;
  downForMs: number;
} {
  const laneMeta =
    lane === 'primary'
      ? rpc.primary
      : lane === 'secondary'
        ? rpc.secondary
        : rpc.utility;
  // Prefer the preferred-lane endpoint (lane tag), not the active failover host label.
  const pref =
    rpc.endpoints.find((e) => e.lane === lane) ||
    rpc.endpoints.find((e) => e.label === lane && e.role === lane) ||
    rpc.endpoints.find((e) => e.role === lane) ||
    null;
  return {
    label: pref?.label || lane,
    healthy: Boolean(laneMeta?.healthy),
    latencyMs: pref?.latencyMs ?? null,
    successRate: pref != null ? Number(pref.successRate) : null,
    url: pref?.url || laneMeta?.url || '',
    failover: Boolean(laneMeta?.failover),
    downForMs: Number(laneMeta?.downForMs) || 0,
  };
}

function laneStressed(snap: {
  healthy: boolean;
  latencyMs: number | null;
  successRate: number | null;
}): boolean {
  if (!snap.healthy) return true;
  if (snap.successRate != null && snap.successRate < 50) return true;
  if (snap.latencyMs != null && snap.latencyMs > 500) return true;
  return false;
}

export function getRpcLoadDiagnostic(): RpcLoadDiagnostic {
  const rpc = getRpcStats();
  const jito = getJitoStatus();

  const pRaw = pickEndpointStats(rpc, 'primary');
  const sRaw = pickEndpointStats(rpc, 'secondary');
  const uRaw = pickEndpointStats(rpc, 'utility');
  const primary: RpcDiagLaneSnapshot = {
    label: pRaw.label,
    healthy: pRaw.healthy,
    latencyMs: pRaw.latencyMs,
    successRate: pRaw.successRate,
    public: isPublicRpcUrl(pRaw.url),
    failover: pRaw.failover,
    downForMs: pRaw.downForMs,
  };
  const secondary: RpcDiagLaneSnapshot = {
    label: sRaw.label,
    healthy: sRaw.healthy,
    latencyMs: sRaw.latencyMs,
    successRate: sRaw.successRate,
    public: isPublicRpcUrl(sRaw.url),
    failover: sRaw.failover,
    downForMs: sRaw.downForMs,
  };
  const utility: RpcDiagLaneSnapshot = {
    label: uRaw.label,
    healthy: uRaw.healthy,
    latencyMs: uRaw.latencyMs,
    successRate: uRaw.successRate,
    public: isPublicRpcUrl(uRaw.url),
    failover: uRaw.failover,
    downForMs: uRaw.downForMs,
  };

  const walletPoll = Math.max(3_000, Number(config.pollIntervalMs) || 8_000);
  const scannerPoll = Math.max(
    15_000,
    Number(config.marketScanner?.pollIntervalMs) || 15_000
  );
  const alphaPoll = Math.max(
    15_000,
    Number(config.alphaScan?.pollIntervalMs) || 45_000
  );
  const zionPoll = Math.max(
    30_000,
    Number(config.zion?.scanner?.pollIntervalMs) || 30_000
  );
  const healthPoll = Math.max(
    10_000,
    Number(config.rpc?.healthIntervalMs) || 30_000
  );
  const migrationPoll = 12_000;

  const scannerOn =
    config.marketScanner?.enabled !== false &&
    isStrategyEnabledGlobal('ta_market_scanner');
  const alphaOn = config.alphaScan?.enabled === true;
  const zionOn =
    config.zion?.enabled === true && config.zion?.scanner?.enabled !== false;

  let lastPollRateLimited = false;
  let softWatch: ReturnType<
    typeof import('./monitor').getSoftWatchRuntimeSnapshot
  > | null = null;
  try {
    const { getMonitorStatus, getSoftWatchRuntimeSnapshot } =
      require('./monitor') as typeof import('./monitor');
    lastPollRateLimited = Boolean(getMonitorStatus().lastPollRateLimited);
    softWatch = getSoftWatchRuntimeSnapshot();
  } catch {
    /* monitor may not be loaded */
  }

  let zionRpcCooldown = false;
  try {
    const { getZionScannerStatus } =
      require('./zionKolScanner') as typeof import('./zionKolScanner');
    const zs = getZionScannerStatus();
    zionRpcCooldown = /cooldown|rate.?limit|429|too many/i.test(
      String(zs.lastError || '')
    );
  } catch {
    /* optional */
  }

  const shareLoad = Boolean(config.rpc?.shareLoad);
  const scannerLane = shareLoad ? 'secondary' : 'primary';
  const activityLane = shareLoad ? 'utility' : 'secondary';
  const walletPollLane = shareLoad ? 'utility' : 'primary';
  const softCapNote = softWatch
    ? softWatch.softWatchPaused
      ? 'Favourites soft-watch PAUSED (cap 0)'
      : `soft watch cap ${softWatch.softWatchCap} (${softWatch.softWatchCapSource}), pool ${softWatch.watchPool}`
    : 'soft watch';

  const loaders: RpcDiagLoader[] = [
    {
      id: 'wallet_poll',
      lane: walletPollLane,
      intervalMs: walletPoll,
      note: shareLoad
        ? `Copy / wallet buy detection on public utility (${softCapNote})`
        : `Copy / wallet buy detection (${softCapNote})`,
    },
    {
      id: 'migration',
      lane: 'primary',
      intervalMs: migrationPoll,
      note: 'Migration listener poll (hardcoded 12s; WS off on public RPC)',
    },
    {
      id: 'market_scanner',
      lane: scannerLane,
      intervalMs: scannerPoll,
      note: scannerOn
        ? 'Market Scanner + curve enrich (Live Feed → Poll interval)'
        : 'Market Scanner off',
    },
    {
      id: 'alpha_scan',
      lane: scannerLane,
      intervalMs: alphaPoll,
      note: alphaOn
        ? 'AlphaScan curve enrich (Live Feed → Poll ms)'
        : 'AlphaScan off',
    },
    {
      id: 'zion_scanner',
      lane: 'secondary',
      intervalMs: zionPoll,
      note: zionOn
        ? 'Zion KOL scanner (Zion → Poll interval)'
        : 'Zion scanner off',
    },
    {
      id: 'activity',
      lane: activityLane,
      intervalMs: Math.max(walletPoll * 4, 60_000),
      note: shareLoad
        ? 'Wallet activity refresh (utility / public when Share ON)'
        : 'Wallet activity refresh (secondary)',
    },
    {
      id: 'health',
      lane: 'all',
      intervalMs: healthPoll,
      note: Boolean(config.rpc?.shareLoad)
        ? 'RPC health getSlot — public/utility every tick; Helius ~1/3; Alchemy ~1/2; fallback rare'
        : 'RPC health getSlot probes (all registered endpoints)',
    },
  ];

  const chokeHints: string[] = [];
  const recommendations: RpcDiagRecommendation[] = [];
  const addRec = (r: RpcDiagRecommendation) => {
    if (r.suggestedMs <= r.currentMs) return;
    if (recommendations.some((x) => x.target === r.target)) return;
    recommendations.push(r);
  };

  const primaryStressed = laneStressed(primary);
  const secondaryStressed = laneStressed(secondary);
  const utilityStressed = laneStressed(utility);
  const walletPollStressed = shareLoad
    ? utilityStressed || lastPollRateLimited
    : primaryStressed || lastPollRateLimited || primary.public;

  if (shareLoad && softWatch && !softWatch.softWatchPaused) {
    if (utilityStressed || lastPollRateLimited) {
      chokeHints.push(
        `Favourites soft-watch under Data pressure (cap ${softWatch.softWatchCap}, pool ${softWatch.watchPool}/${softWatch.enabledWallets}, last poll ${softWatch.lastPollElapsedMs ?? '—'}ms). Lower Soft watch cap in Stats → RPC (try 8–12, or 0 to pause Favourites watch).`
      );
    } else if (softWatch.softWatchCap >= 25 && softWatch.enabledWallets > softWatch.softWatchCap) {
      chokeHints.push(
        `Soft watch cap ${softWatch.softWatchCap} still large vs ${softWatch.enabledWallets} enabled wallets — consider 8–12 to ease Data/Favourites.`
      );
    }
  }
  if (softWatch?.softWatchPaused) {
    chokeHints.push(
      'Favourites soft-watch is PAUSED (cap 0) — Data wallet_poll idle; copy buys from Favourites will not fire until you raise the cap.'
    );
  }

  if (!primary.healthy) {
    chokeHints.push(
      `Primary preferred DOWN (${primary.label}${primary.downForMs ? `, down ${Math.round(primary.downForMs / 1000)}s` : ''}).`
    );
  } else if (primary.successRate != null && primary.successRate < 50) {
    chokeHints.push(
      `Primary success rate low (${primary.successRate.toFixed(0)}% on ${primary.label}).`
    );
  } else if (primary.latencyMs != null && primary.latencyMs > 500) {
    chokeHints.push(
      `Primary latency high (${primary.latencyMs}ms on ${primary.label}).`
    );
  }

  if (primary.failover) {
    chokeHints.push('Primary lane is piggybacking (failover active).');
  }
  if (primary.public && !shareLoad) {
    chokeHints.push(
      'Primary is a public/free RPC — rate limits commonly choke wallet poll + migration + scanner.'
    );
  }
  if (lastPollRateLimited) {
    chokeHints.push('Wallet poll recently hit RPC rate limits (429).');
  }
  if (rpc.lanesShareEndpoint) {
    chokeHints.push(
      'Primary and secondary share one URL — Zion steals CU from copy/signals. Set distinct RPC_SECONDARY.'
    );
  }
  if (rpc.warning) {
    chokeHints.push(rpc.warning);
  }

  if (secondaryStressed) {
    chokeHints.push(
      !secondary.healthy
        ? `Secondary preferred DOWN (${secondary.label}).`
        : `Secondary stressed (${secondary.latencyMs ?? '—'}ms, ${secondary.successRate != null ? secondary.successRate.toFixed(0) + '%' : 'n/a'}).`
    );
  }
  if (zionRpcCooldown) {
    chokeHints.push(
      'Zion KOL scanner is in an RPC cooldown (429 / too many requests).'
    );
  }

  if (walletPollStressed) {
    addRec({
      target: 'wallet_poll',
      fieldLabel: 'Wallet / monitor pollIntervalMs',
      currentMs: walletPoll,
      suggestedMs: bumpMs(
        walletPoll,
        lastPollRateLimited || (shareLoad ? !utility.healthy : !primary.healthy)
          ? 20_000
          : 15_000,
        60_000
      ),
      reason: shareLoad
        ? 'Favourites ride Data under soft-watch caps — longer interval eases Data lane pressure.'
        : 'Primary carries copy wallet polling — longer interval reduces getSignatures pressure.',
    });
  }
  if (primaryStressed || lastPollRateLimited || (primary.public && !shareLoad)) {
    if (scannerOn && !shareLoad) {
      addRec({
        target: 'market_scanner',
        fieldLabel: 'Market Scanner Poll interval (ms)',
        currentMs: scannerPoll,
        suggestedMs: bumpMs(scannerPoll, 25_000, 90_000),
        reason:
          'Scanner curve enrich stacks on primary with wallet + migration polls.',
      });
    }
    if (alphaOn && !shareLoad) {
      addRec({
        target: 'alpha_scan',
        fieldLabel: 'AlphaScan Poll (ms)',
        currentMs: alphaPoll,
        suggestedMs: bumpMs(alphaPoll, 60_000, 180_000),
        reason:
          'AlphaScan bonding-curve enrich hits primary; raise Poll or leave AlphaScan off when primary is stressed.',
      });
    }
  }

  if (secondaryStressed || zionRpcCooldown || rpc.lanesShareEndpoint) {
    if (zionOn) {
      addRec({
        target: 'zion_scanner',
        fieldLabel: 'Zion Poll interval (ms)',
        currentMs: zionPoll,
        suggestedMs: bumpMs(zionPoll, zionRpcCooldown ? 60_000 : 45_000, 180_000),
        reason: zionRpcCooldown
          ? 'Zion is rate-limited — slower KOL poll yields CU.'
          : 'Secondary lane stress — slow Zion poll so Place Trade / KOL share CU better.',
      });
    }
  }

  if (chokeHints.length === 0 && recommendations.length === 0) {
    chokeHints.push(
      'No abnormal RPC choke detected — lanes look healthy for current load.'
    );
  }


  return {
    at: Date.now(),
    primary,
    secondary,
    utility,
    shareLoad: Boolean(config.rpc?.shareLoad),
    softWatch,
    chokeHints,
    loaders,
    recommendations,
    jito: {
      bundlesEnabled: Boolean(jito.enabled),
      note: jito.enabled
        ? 'Jito bundle send path is ON (MEV jito bundles and/or rpc.jito.enabled).'
        : 'Jito bundles OFF — tip/prio multipliers and sandwich can still run under MEV; Turbo elevates priority fee + buy slip only (no bundles until enabled).',
    },
    turboNote:
      'Turbo Mode (per micro-bot) raises priority fee + buy slip. It does not turn Jito bundles ON. Live Sim stamps Turbo without real bundles.',
    rpc,
    callTraffic: rpc.callTraffic,
  };
}

export interface RpcDiagApplyUpdate {
  target: RpcDiagTarget;
  pollIntervalMs: number;
}

export interface RpcDiagApplyResult {
  ok: boolean;
  applied: Array<{
    target: RpcDiagTarget;
    pollIntervalMs: number;
    fieldLabel: string;
  }>;
  skipped: Array<{ target: string; reason: string }>;
  diagnostic: RpcLoadDiagnostic;
}

function clampPoll(
  target: RpcDiagTarget,
  n: number
): number | null {
  if (!Number.isFinite(n)) return null;
  const v = Math.round(n);
  switch (target) {
    case 'wallet_poll':
      return Math.max(3_000, Math.min(120_000, v));
    case 'market_scanner':
    case 'alpha_scan':
      return Math.max(15_000, Math.min(600_000, v));
    case 'zion_scanner':
      return Math.max(30_000, Math.min(600_000, v));
    case 'health':
      return Math.max(10_000, Math.min(300_000, v));
    default:
      return null;
  }
}

/**
 * Apply Poll (ms) recommendations from the RPC diagnostic panel.
 * Writes the same config fields as Live Feed / Zion / monitor settings.
 */
export function applyRpcDiagnosticPollUpdates(
  updates: RpcDiagApplyUpdate[]
): RpcDiagApplyResult {
  const { persistUserSettings } =
    require('./config') as typeof import('./config');

  const applied: RpcDiagApplyResult['applied'] = [];
  const skipped: RpcDiagApplyResult['skipped'] = [];
  let touchWallet = false;
  let touchScanner = false;
  let touchZion = false;
  let touchHealth = false;

  const labels: Record<RpcDiagTarget, string> = {
    wallet_poll: 'Wallet / monitor pollIntervalMs',
    market_scanner: 'Market Scanner Poll interval (ms)',
    alpha_scan: 'AlphaScan Poll (ms)',
    zion_scanner: 'Zion Poll interval (ms)',
    health: 'RPC healthIntervalMs',
  };

  for (const u of updates || []) {
    const target = u?.target;
    if (
      target !== 'wallet_poll' &&
      target !== 'market_scanner' &&
      target !== 'alpha_scan' &&
      target !== 'zion_scanner' &&
      target !== 'health'
    ) {
      skipped.push({ target: String(u?.target), reason: 'unknown target' });
      continue;
    }
    const clamped = clampPoll(target, Number(u.pollIntervalMs));
    if (clamped == null) {
      skipped.push({ target, reason: 'invalid pollIntervalMs' });
      continue;
    }

    if (target === 'wallet_poll') {
      config.pollIntervalMs = clamped;
      touchWallet = true;
    } else if (target === 'market_scanner') {
      if (!config.marketScanner) {
        skipped.push({ target, reason: 'marketScanner config missing' });
        continue;
      }
      config.marketScanner.pollIntervalMs = clamped;
      touchScanner = true;
    } else if (target === 'alpha_scan') {
      if (!config.alphaScan) {
        skipped.push({ target, reason: 'alphaScan config missing' });
        continue;
      }
      config.alphaScan.pollIntervalMs = clamped;
    } else if (target === 'zion_scanner') {
      if (!config.zion?.scanner) {
        skipped.push({ target, reason: 'zion.scanner config missing' });
        continue;
      }
      config.zion.scanner.pollIntervalMs = clamped;
      touchZion = true;
    } else if (target === 'health') {
      if (!config.rpc) {
        skipped.push({ target, reason: 'rpc config missing' });
        continue;
      }
      config.rpc.healthIntervalMs = clamped;
      touchHealth = true;
    }

    applied.push({
      target,
      pollIntervalMs: clamped,
      fieldLabel: labels[target],
    });
  }

  if (applied.length) {
    persistUserSettings();
  }

  if (touchWallet) {
    try {
      const mon = require('./monitor') as typeof import('./monitor');
      const wasRunning = mon.getMonitorStatus().running;
      if (wasRunning) {
        mon.stopMonitor();
        mon.startMonitor();
      }
    } catch {
      /* optional */
    }
  }
  if (touchScanner) {
    try {
      const { restartMarketScanner } =
        require('./marketScanner') as typeof import('./marketScanner');
      restartMarketScanner();
    } catch {
      /* optional */
    }
  }
  if (touchZion) {
    try {
      const { syncZionKolScannerLifecycle } =
        require('./zionKolScanner') as typeof import('./zionKolScanner');
      syncZionKolScannerLifecycle();
    } catch {
      /* optional */
    }
  }
  if (touchHealth) {
    try {
      const conn = require('./connection') as typeof import('./connection');
      conn.stopRpcHealthMonitor();
      conn.startRpcHealthMonitor();
    } catch {
      /* health interval may require process restart — still persisted */
    }
  }

  return {
    ok: true,
    applied,
    skipped,
    diagnostic: getRpcLoadDiagnostic(),
  };
}
