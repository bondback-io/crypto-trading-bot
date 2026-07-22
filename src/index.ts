/**
 * Main entry point — bootstraps connection, paper trader, monitor, and dashboard.
 */

import dotenv from 'dotenv';
import { config, setMode, initWallets, hasPersistedSettings } from './config';
import { env, logEnvSummary, validateDeploymentEnv } from './env';
import { logPersistenceStatus } from './dataDir';
import { testConnection } from './connection';
import { paperTrader } from './paperTrader';
import { startMonitor, onSignal, TradeSignal } from './monitor';
import { startMigrationListener, stopMigrationListener } from './migrationListener';
import { startServer } from './server';

dotenv.config();

async function main(): Promise<void> {
  logEnvSummary();
  for (const w of validateDeploymentEnv()) {
    console.warn(`[env] ⚠ ${w}`);
  }
  logPersistenceStatus();

  initWallets();
  paperTrader.loadPersistedState();

  console.log('═══════════════════════════════════════════════════');
  console.log('  Solana Smart Money Copy Trading Bot');
  console.log('  Pump.fun launches & migrations');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Mode: ${config.mode.toUpperCase()}`);
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

  // TRADING_MODE env only applies when no saved settings yet (don't override dashboard saves)
  if (env.tradingMode) {
    if (!hasPersistedSettings()) {
      setMode(env.tradingMode, { persist: false });
    } else if (config.mode !== env.tradingMode) {
      console.log(
        `[boot] Keeping saved mode=${config.mode} (ignoring TRADING_MODE=${env.tradingMode})`
      );
    }
  }

  const rpcOk = await testConnection();
  if (!rpcOk) {
    console.warn('[boot] RPC connection failed — monitor may not work until RPC is fixed');
  }

  // Paper trading auto-check for TP/SL
  if (config.mode === 'paper' && config.strategy.enableAutoSell) {
    paperTrader.startAutoCheck();
  }

  // Log signals (monitor also auto-executes)
  onSignal((signal: TradeSignal) => {
    console.log(
      `[signal] 🎯 ${signal.walletNames.join(' + ')} → ${signal.symbol}` +
        (signal.name && signal.name !== signal.symbol ? ` (${signal.name})` : '') +
        (signal.isMigration ? ' (post-migration)' : '')
    );
  });

  startMonitor();
  // Start migration listener after monitor so priority handler is registered
  startMigrationListener();
  startServer();

  // Graceful shutdown
  const shutdown = (): void => {
    console.log('\n[boot] Shutting down…');
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
