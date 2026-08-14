/**
 * Main entry point — bootstraps connection, paper trader, monitor, and dashboard.
 */

// MUST be first: stub Connection.onLogs before any RPC / migration module loads.
import './disableLogsSubscribe';

import dotenv from 'dotenv';
import { config, setMode, initWallets, hasPersistedSettings } from './config';
import { env, logEnvSummary, validateDeploymentEnv } from './env';
import {
  logPersistenceStatus,
  migrateLegacyRenderDataDir,
  touchPersistMarker,
} from './dataDir';
import { testConnection } from './connection';
import { paperTrader } from './paperTrader';
import { startMonitor, onSignal, TradeSignal } from './monitor';
import { startMigrationListener, stopMigrationListener } from './migrationListener';
import { startServer } from './server';

dotenv.config();

/**
 * Resolve trading mode after settings load.
 * - Fresh / wiped disk → Live Sim (unless TRADING_MODE=live for real funds)
 * - Saved settings win (migrations may have already upgraded stale paper → Live Sim)
 * - A stale TRADING_MODE=paper secret must not defeat Live Sim on empty disk
 */
function resolveBootTradingMode(): void {
  if (!hasPersistedSettings()) {
    // Prefer Live Sim on empty DATA_DIR; only honor env when requesting real live.
    const mode = env.tradingMode === 'live' ? 'live' : 'liveSimulation';
    setMode(mode, { persist: true });
    console.log(
      `[boot] No saved settings — mode=${config.mode}` +
        ` (env TRADING_MODE=${env.tradingMode})`
    );
    return;
  }

  if (config.mode !== env.tradingMode) {
    console.log(
      `[boot] Keeping saved mode=${config.mode} (env TRADING_MODE=${env.tradingMode})`
    );
  }
}

async function main(): Promise<void> {
  logEnvSummary();
  for (const w of validateDeploymentEnv()) {
    console.warn(`[env] ⚠ ${w}`);
  }
  // Prefer /var/data: copy from legacy Render src/data if new dir is empty
  migrateLegacyRenderDataDir();

  // Fresh/wiped volume: seed from bundled site-backup BEFORE migrations write defaults.
  const dataDirEmptyAtBoot = !hasPersistedSettings();
  let bootSeeded = false;
  try {
    const { maybeSeedDataDirFromBundledSiteBackup } =
      require('./siteBackup') as typeof import('./siteBackup');
    const seed = maybeSeedDataDirFromBundledSiteBackup();
    bootSeeded = seed.seeded === true;
  } catch (err) {
    console.warn(
      '[boot-seed] hook failed:',
      err instanceof Error ? err.message : err
    );
  }
  if (bootSeeded || dataDirEmptyAtBoot) {
    try {
      const { markForceGithubAutoImportOnce } =
        require('./githubSiteBackup') as typeof import('./githubSiteBackup');
      markForceGithubAutoImportOnce(
        bootSeeded ? 'post-bundled-seed' : 'empty-data-dir-boot'
      );
    } catch (err) {
      console.warn(
        '[boot-seed] force GitHub auto-import arm failed:',
        err instanceof Error ? err.message : err
      );
    }
  }

  touchPersistMarker();
  logPersistenceStatus();

  initWallets();

  // Config present but still on code defaults for HMC/FPR/DBR/Zion/caps →
  // overlay preferred values from bundled backup (Upload was poisoning remote).
  try {
    const {
      reconcileCriticalSettingsFromBundledBackup,
      criticalSettingsLookLikeCodeDefaults,
    } = require('./siteBackup') as typeof import('./siteBackup');
    if (criticalSettingsLookLikeCodeDefaults()) {
      try {
        const { markForceGithubAutoImportOnce } =
          require('./githubSiteBackup') as typeof import('./githubSiteBackup');
        markForceGithubAutoImportOnce('critical-settings-look-default');
      } catch {
        /* optional */
      }
    }
    reconcileCriticalSettingsFromBundledBackup({ reason: 'post-initWallets' });
  } catch (err) {
    console.warn(
      '[boot-reconcile] hook failed:',
      err instanceof Error ? err.message : err
    );
  }

  paperTrader.loadPersistedState();
  resolveBootTradingMode();
  try {
    const { ensureLearningHygieneMigration } =
      require('./profileLearningEpisodes') as typeof import('./profileLearningEpisodes');
    ensureLearningHygieneMigration();
  } catch (err) {
    console.warn(
      '[boot] learning hygiene migration failed:',
      err instanceof Error ? err.message : err
    );
  }

  console.log('═══════════════════════════════════════════════════');
  console.log('  Solana Smart Money Copy Trading Bot');
  console.log('  Pump.fun launches & migrations');
  console.log('═══════════════════════════════════════════════════');
  console.log(
    `  Mode: ${
      config.mode === 'liveSimulation'
        ? 'LIVE SIMULATION (no real funds)'
        : config.mode.toUpperCase()
    }`
  );
  console.log(`  Risk level: ${(config.riskLevel || 'medium').toUpperCase()}`);
  console.log(
    `  Buy size: base ${config.trade.baseTradeAmountSol ?? config.trade.tradeAmountSol} SOL` +
      ` (risk×${config.trade.riskMultiplier ?? 0.4}, conviction×${config.trade.convictionMultiplier ?? 1.45})`
  );
  console.log(`  Convergence: ${config.filters.convergenceRequired}+ wallets`);
  console.log(`  Take profit: ${config.trade.minProfitPercent}–${config.trade.maxProfitPercent}%`);
  console.log(`  Stop loss: ${config.trade.stopLossPercent}%`);
  console.log(`  Migration priority: ${config.strategy.enableMigrationPriority}`);
  console.log(`  Auto-sell: ${config.strategy.enableAutoSell}`);
  console.log(`  Trading wallets: ${config.tradingWallets.length} (active=${config.activeTradingWalletId ?? 'none'})`);
  console.log(`  Wallets loaded: ${config.smartWallets.length}`);
  console.log('═══════════════════════════════════════════════════\n');

  // Bind /health FIRST so Render/Fly health checks never see 502 while RPC/GMGN boot.
  // Public Solana RPC 429 retries can hang getSlot for minutes otherwise.
  startServer();
  try {
    const { startHeapWatchdog } =
      require('./heapWatchdog') as typeof import('./heapWatchdog');
    startHeapWatchdog();
  } catch (err) {
    console.warn(
      '[boot] heap watchdog failed to start:',
      err instanceof Error ? err.message : err
    );
  }

  try {
    const { getAppVersion } = require('./version') as typeof import('./version');
    const { maybeNotifyAppVersionUpdate } =
      require('./dashboardNotifications') as typeof import('./dashboardNotifications');
    const app = getAppVersion();
    maybeNotifyAppVersionUpdate(app.label || `v${app.version}`);
    try {
      const { ingestBotInfoGrowthNotes } =
        require('./zionContinuousLearning') as typeof import('./zionContinuousLearning');
      ingestBotInfoGrowthNotes(false);
    } catch {
      /* optional */
    }
  } catch {
    /* optional */
  }

  // Never let async RPC/WS work take down the process (Render → 502 crash loop).
  process.on('unhandledRejection', (reason) => {
    const msg = String(reason);
    if (/EPIPE|ECONNRESET/i.test(msg)) {
      console.warn('[boot] Ignored pipe rejection:', msg.slice(0, 120));
      return;
    }
    console.error('[boot] Unhandled rejection (kept alive):', reason);
    try {
      const { pushDashboardNotification } =
        require('./dashboardNotifications') as typeof import('./dashboardNotifications');
      pushDashboardNotification({
        kind: 'error',
        title: 'Unhandled rejection',
        body: msg.slice(0, 200),
      });
    } catch {
      /* optional */
    }
  });
  process.on('uncaughtException', (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (/EPIPE|ECONNRESET/i.test(msg)) {
      console.warn('[boot] Ignored pipe exception:', msg.slice(0, 120));
      return;
    }
    console.error('[boot] Uncaught exception (kept alive):', err);
    try {
      const { pushDashboardNotification } =
        require('./dashboardNotifications') as typeof import('./dashboardNotifications');
      pushDashboardNotification({
        kind: 'error',
        title: 'System error',
        body: msg.slice(0, 200),
      });
    } catch {
      /* optional */
    }
  });

  // Heavy I/O after listen — failures here must not take the process down.
  // BootPhase (1.2.345): Trading → Scanners → Background priority + time stagger.
  void (async () => {
    const noteStage = (n: number | string, detail: string) => {
      console.log(`[boot-seq] stage=${n} ${detail}`);
      try {
        const { noteBootTimeline } =
          require('./rpcBootTimeline') as typeof import('./rpcBootTimeline');
        noteBootTimeline({
          event: 'boot_stage',
          detail: `stage=${n} ${detail}`,
        });
      } catch {
        /* */
      }
    };

    try {
      // Stage 0: listen already done (server + health monitor only)
      noteStage(0, 'listen — server + health monitor only');
      try {
        const { noteBootPhaseIfChanged } =
          require('./bootPhase') as typeof import('./bootPhase');
        noteBootPhaseIfChanged();
      } catch {
        /* */
      }

      // Stage 1 (+5s): skip duplicate testConnection if health probe recently OK
      await new Promise((r) => setTimeout(r, 5_000));
      noteStage(1, 'rpc probe (skip if recent health OK)');
      const { recentHealthProbeOk } =
        require('./connection') as typeof import('./connection');
      let rpcOk = recentHealthProbeOk(30_000);
      if (rpcOk) {
        console.log(
          '[boot-seq] Skipping testConnection — health probe OK in last 30s'
        );
      } else {
        rpcOk = await testConnection();
        if (!rpcOk) {
          console.warn(
            '[boot] RPC connection failed — monitor may not work until RPC is fixed'
          );
        }
      }

      // Stage 2 (+15s): Live Sim / paper auto-check (marks allowed in Phase T)
      await new Promise((r) => setTimeout(r, 10_000));
      noteStage(2, 'Live Sim / paper auto-check (BootPhase trading)');
      if (
        (config.mode === 'paper' || config.mode === 'liveSimulation') &&
        config.strategy.enableAutoSell
      ) {
        paperTrader.startAutoCheck();
      }

      onSignal((signal: TradeSignal) => {
        console.log(
          `[signal] 🎯 ${signal.walletNames.join(' + ')} → ${signal.symbol}` +
            (signal.name && signal.name !== signal.symbol
              ? ` (${signal.name})`
              : '') +
            (signal.isMigration ? ' (post-migration)' : '')
        );
      });

      try {
        const { ensureFavouritesAutoImportOnBoot } =
          await import('./walletDiscovery');
        await ensureFavouritesAutoImportOnBoot();
      } catch (err) {
        console.warn(
          '[boot] Favourites auto-import error:',
          err instanceof Error ? err.message : err
        );
      }

      // Stage 3 (+25s): monitor only — scanner deferred to Phase D
      await new Promise((r) => setTimeout(r, 10_000));
      noteStage(3, 'startMonitor (scanner deferred to Phase D)');
      startMonitor();
      try {
        const { emailDeliveryStatus } = await import('./emailNotifications');
        const d = emailDeliveryStatus();
        console.log(
          `[boot] Email delivery: provider=${d.provider} configured=${d.configured} ` +
            `to=${d.to || '(none)'} from=${d.from || '(none)'} · ${d.hint}`
        );
      } catch (err) {
        console.warn(
          '[boot] Email delivery status error:',
          err instanceof Error ? err.message : err
        );
      }

      // Stage 4 (+40s): was migration — deferred to +210s so Pump program
      // getSignatures do not saturate Trading (Alchemy) during boot.
      await new Promise((r) => setTimeout(r, 15_000));
      noteStage(4, 'skip migration until +210s (Trading settle)');
      console.log(
        '[boot] Monitor started — migration listener deferred to +210s (Trading-lane settle)'
      );

      // Stage 3b (+90s): BootPhase scanners — Market Scanner
      await new Promise((r) => setTimeout(r, 50_000));
      noteStage('3b', 'BootPhase scanners — Market Scanner');
      try {
        const { noteBootPhaseIfChanged } =
          require('./bootPhase') as typeof import('./bootPhase');
        noteBootPhaseIfChanged();
      } catch {
        /* */
      }
      try {
        const { startMarketScanner } =
          await import('./marketScanner');
        startMarketScanner();
      } catch (err) {
        console.warn(
          '[boot] Market Scanner start error:',
          err instanceof Error ? err.message : err
        );
      }

      // Stage 3c (+120s): Zion KOL — staggered after Market Scanner
      await new Promise((r) => setTimeout(r, 30_000));
      noteStage('3c', 'BootPhase scanners — Zion KOL');
      try {
        const { syncZionKolScannerLifecycle } = await import('./zionKolScanner');
        syncZionKolScannerLifecycle();
        console.log(
          `[boot] Zion KOL scanner lifecycle synced (enabled=${config.zion?.enabled === true})`
        );
      } catch (err) {
        console.warn(
          '[boot] Zion scanner sync error:',
          err instanceof Error ? err.message : err
        );
      }

      // Stage 5 (+210s): migration after GitHub import window (180s)
      await new Promise((r) => setTimeout(r, 90_000));
      noteStage(5, 'BootPhase ready window — migration listener (seed-only first poll)');
      try {
        const { noteBootPhaseIfChanged } =
          require('./bootPhase') as typeof import('./bootPhase');
        noteBootPhaseIfChanged();
      } catch {
        /* */
      }
      startMigrationListener();
      console.log('[boot] Migration listener started (+210s — first poll seed-only)');
    } catch (err) {
      console.error('[boot] Post-listen startup error (server still up):', err);
    }
  })();

  // Graceful shutdown
  const shutdown = (): void => {
    console.log('\n[boot] Shutting down…');
    try {
      const { stopHeapWatchdog } =
        require('./heapWatchdog') as typeof import('./heapWatchdog');
      stopHeapWatchdog();
    } catch {
      /* ignore */
    }
    try {
      const { stopRpcHealthMonitor } =
        require('./connection') as typeof import('./connection');
      stopRpcHealthMonitor();
    } catch {
      /* ignore */
    }
    try {
      const { stopMonitor } = require('./monitor') as typeof import('./monitor');
      stopMonitor();
    } catch {
      /* ignore */
    }
    try {
      const { stopMarketScanner } =
        require('./marketScanner') as typeof import('./marketScanner');
      stopMarketScanner();
    } catch {
      /* ignore */
    }
    try {
      const { stopZionKolScanner } = require('./zionKolScanner') as typeof import('./zionKolScanner');
      stopZionKolScanner();
    } catch {
      /* ignore */
    }
    try {
      const { stopFastPoll } =
        require('./migrationGradWatch') as typeof import('./migrationGradWatch');
      stopFastPoll();
    } catch {
      /* ignore */
    }
    stopMigrationListener();
    paperTrader.stopAutoCheck();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[boot] Fatal error:', err);
  process.exit(1);
});
