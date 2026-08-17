/**
 * Main entry point — bootstraps connection, paper trader, monitor, and dashboard.
 */

import dotenv from 'dotenv';
import { config, setMode, initWallets, hasPersistedSettings } from './config';
import { env, logEnvSummary, validateDeploymentEnv } from './env';
import {
  logPersistenceStatus,
  migrateLegacyRenderDataDir,
  touchPersistMarker,
  getPersistenceStatus,
  isCloudHost,
  PREFERRED_RENDER_DATA_DIR,
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
  touchPersistMarker();
  logPersistenceStatus();

  initWallets();
  paperTrader.loadPersistedState();
  resolveBootTradingMode();
  try {
    const { applyEnabledUpgrades } =
      require('./upgrades/apply') as typeof import('./upgrades/apply');
    applyEnabledUpgrades();
  } catch (err) {
    console.warn(
      '[boot] Upgrades apply error:',
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
    const { getAppVersion } = require('./version') as typeof import('./version');
    const { maybeNotifyAppVersionUpdate, pushDashboardNotification } =
      require('./dashboardNotifications') as typeof import('./dashboardNotifications');
    const app = getAppVersion();
    maybeNotifyAppVersionUpdate(app.label || `v${app.version}`);
    const persist = getPersistenceStatus();
    if (isCloudHost() && !persist.volumeMounted) {
      pushDashboardNotification({
        kind: 'system',
        title: 'Persistence at risk — disk not mounted',
        body:
          `DATA_DIR (${persist.dataDir}) is not a volume. All Config / Micro Bots / learning saves wipe on the next deploy. ` +
          `Attach a Starter+ Disk at ${PREFERRED_RENDER_DATA_DIR} (or Fly /data) matching DATA_DIR.`,
      });
    }
  } catch {
    /* optional */
  }

  // Never let async RPC/WS work take down the process (Render → 502 crash loop).
  process.on('unhandledRejection', (reason) => {
    console.error('[boot] Unhandled rejection (kept alive):', reason);
    try {
      const { pushDashboardNotification } =
        require('./dashboardNotifications') as typeof import('./dashboardNotifications');
      pushDashboardNotification({
        kind: 'error',
        title: 'Unhandled rejection',
        body: String(reason).slice(0, 200),
      });
    } catch {
      /* optional */
    }
  });
  process.on('uncaughtException', (err) => {
    console.error('[boot] Uncaught exception (kept alive):', err);
    try {
      const { pushDashboardNotification } =
        require('./dashboardNotifications') as typeof import('./dashboardNotifications');
      pushDashboardNotification({
        kind: 'error',
        title: 'System error',
        body: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    } catch {
      /* optional */
    }
  });

  // Heavy I/O after listen — failures here must not take the process down.
  // Defer monitor/migration briefly so /health stays hot during deploy probes.
  void (async () => {
    try {
      await new Promise((r) => setTimeout(r, 2_500));

      const rpcOk = await testConnection();
      if (!rpcOk) {
        console.warn(
          '[boot] RPC connection failed — monitor may not work until RPC is fixed'
        );
      }

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

      // Stagger: wallet polling first, migration listener a few seconds later
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

      startMonitor();
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
      await new Promise((r) => setTimeout(r, 3_000));
      startMigrationListener();
      console.log('[boot] Monitor + migration listener started');
    } catch (err) {
      console.error('[boot] Post-listen startup error (server still up):', err);
    }
  })();

  // Graceful shutdown
  const shutdown = (): void => {
    console.log('\n[boot] Shutting down…');
    try {
      const { stopZionKolScanner } = require('./zionKolScanner') as typeof import('./zionKolScanner');
      stopZionKolScanner();
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
