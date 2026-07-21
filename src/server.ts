/**
 * Express API + dashboard for monitoring and configuration.
 */

import express, { Request, Response } from 'express';
import {
  config,
  addSmartWallet,
  upsertSmartWallet,
  removeSmartWallet,
  toggleSmartWallet,
  setMode,
  updateTradeConfig,
  updateFilterConfig,
  updateStrategyConfig,
  updatePaperConfig,
  persistUserSettings,
  getConfigSnapshot,
  setActiveTradingWallet,
  addTradingWallet,
  removeTradingWallet,
  getActiveTradingWallet,
  TradingMode,
} from './config';
import { isValidSolanaAddress, inferWalletCategory } from './walletStore';
import {
  getLiveBalanceSol,
  getRpcStats,
  startRpcHealthMonitor,
  getTradingWalletsStatus,
  clearKeypairCache,
  getWalletPublicKey,
} from './connection';
import { getJitoStatus } from './jito';
import { getMevStatus, updateMevConfig } from './mev';
import { paperTrader } from './paperTrader';
import { updateProfitStrategyConfig } from './profitStrategy';
import {
  getRecentActivity,
  getMonitorStatus,
  getWalletsWithActivity,
  pauseMonitor,
  resumeMonitor,
  isMonitorPaused,
  refreshAllWalletActivity,
  filterActiveWallets,
  clearMonitorRiskHalt,
} from './monitor';
import {
  updateRiskConfig,
  clearRiskHalt,
  getRiskStatus,
} from './risk';
import {
  getTopSmartWallets,
  getCuratedSmartWallets,
  importSuggestedWallets,
  getGmgnStatus,
  clearGmgnCache,
  searchWallets,
  suggestConsistentScalpers,
  getTokenSniperActivity,
  summarizeSniper,
  getSniperThresholds,
  startDiscoveryAutoRefresh,
  updateDiscoveryConfig,
  GmgnPeriod,
} from './gmgn';
import {
  getMigrationStatus,
  getRecentMigrations,
} from './migrationListener';
import {
  findSmartWallets,
  getDiscoveryStatus,
  clearDiscoveryCache,
  type DiscoverySource,
} from './walletDiscovery';
import {
  getReBuyCandidates,
  getSellHistory,
  getReBuyStatus,
} from './reBuy';
import {
  fetchTokenMetrics,
  evaluateTokenMetricsFilters,
  summarizeTokenMetrics,
  getTokenMetricsCacheStats,
  clearTokenMetricsCache,
} from './tokenMetrics';
import {
  evaluateAntiRug,
  summarizeAntiRug,
  clearAntiRugCache,
  getAntiRugCacheStats,
} from './antiRug';
import {
  getTokenOverview,
  getSmartMoneySignal,
  getTrendingTokens,
  summarizeBirdeye,
  getBirdeyeStatus,
  clearBirdeyeCache,
} from './birdeye';
import {
  getPumpSmartActivity,
  getPumpSmartStatus,
  getPumpLaunchTracks,
  discoverPumpFunSmartMoney,
  clearPumpSmartActivity,
} from './pumpSmartActivity';
import {
  fetchBondingCurve,
  summarizeBondingCurve,
  clearBondingCurveCache,
  getBondingCurveCacheStats,
} from './bondingCurve';
import { DASHBOARD_HTML } from './dashboard';
import { logger } from './logger';
import { env } from './env';

/** Optional CORS for API access from external dashboards / tools */
function corsMiddleware(
  req: Request,
  res: Response,
  next: express.NextFunction
): void {
  const origins = env.corsOrigins;
  if (!origins.length) {
    next();
    return;
  }
  const origin = req.headers.origin;
  const allowAll = origins.includes('*');
  const allowed =
    allowAll || (origin != null && origins.includes(origin));
  if (allowed) {
    res.setHeader(
      'Access-Control-Allow-Origin',
      allowAll && origin ? origin : origin ?? origins[0]
    );
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET,POST,PUT,PATCH,DELETE,OPTIONS'
    );
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Requested-With'
    );
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

export function createServer(): express.Application {
  const app = express();
  app.use(corsMiddleware);
  app.use(express.json());

  const bootedAt = Date.now();

  /**
   * Render / load-balancer health check — always 200 when the process is up.
   * Response shape: { status: "ok", uptime }
   */
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
    });
  });

  /** Detailed readiness (RPC + monitor) — optional ops check */
  app.get('/health/ready', (_req: Request, res: Response) => {
    const rpc = getRpcStats();
    const monitor = getMonitorStatus();
    const rpcHealthy = rpc.endpoints.some((e) => e.healthy);
    const ok = rpcHealthy && !monitor.risk.halted;
    res.status(ok ? 200 : 503).json({
      ok,
      status: ok ? 'healthy' : 'degraded',
      uptime: Math.floor(process.uptime()),
      bootedAt,
      mode: config.mode,
      monitor: {
        running: monitor.running,
        paused: monitor.paused,
        riskHalted: monitor.risk.halted,
        watchedWallets: monitor.watchedWallets,
      },
      rpc: {
        active: rpc.active,
        healthy: rpcHealthy,
        endpoints: rpc.endpoints.length,
      },
    });
  });

  // --- Status ---

  app.get('/api/status', async (_req: Request, res: Response) => {
    const monitor = getMonitorStatus();
    const liveBalance =
      config.mode === 'live' ? await getLiveBalanceSol() : null;
    const active = getActiveTradingWallet();
    const pubkey = getWalletPublicKey();

    res.json({
      mode: config.mode,
      monitor,
      balance:
        config.mode === 'paper' ? paperTrader.getBalance() : liveBalance,
      winRate: paperTrader.getWinRatePct(),
      stats: paperTrader.getStats(),
      rpc: getRpcStats(),
      jito: getJitoStatus(),
      mev: getMevStatus(),
      gmgn: getGmgnStatus(),
      tradingWallet: active
        ? {
            id: active.id,
            name: active.name,
            role: active.role,
            envVar: active.envVar,
            publicKey: pubkey?.toBase58() ?? null,
          }
        : null,
    });
  });

  app.get('/api/rpc', (_req: Request, res: Response) => {
    res.json({
      ...getRpcStats(),
      jito: getJitoStatus(),
      mev: getMevStatus(),
    });
  });

  app.get('/api/mev', (_req: Request, res: Response) => {
    res.json(getMevStatus());
  });

  app.post('/api/mev', (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const partial: Parameters<typeof updateMevConfig>[0] = {};

    for (const key of [
      'enableMEVProtection',
      'useJitoBundles',
      'sandwichProtection',
      'abortOnSandwichRisk',
    ] as const) {
      if (body[key] !== undefined) {
        (partial as Record<string, boolean>)[key] = Boolean(body[key]);
      }
    }
    for (const key of [
      'sandwichMaxRecentBuys',
      'sandwichWindowMs',
      'sandwichLookbackTxs',
      'priorityFeeMultiplier',
      'tipMultiplier',
    ] as const) {
      if (body[key] !== undefined) {
        (partial as Record<string, number>)[key] = Number(body[key]);
      }
    }

    // Also allow toggling base Jito tip
    if (body.tipLamports !== undefined) {
      config.rpc.jito.tipLamports = Number(body.tipLamports);
    }
    if (body.jitoEnabled !== undefined) {
      config.rpc.jito.enabled = Boolean(body.jitoEnabled);
    }

    const mev = updateMevConfig(partial);
    res.json({ ok: true, mev: getMevStatus(), config: mev });
  });

  app.get('/api/stats', (_req: Request, res: Response) => {
    res.json(paperTrader.getStats());
  });

  /** Paper trading status + Chart.js data */
  app.get('/paper-status', (_req: Request, res: Response) => {
    const stats = paperTrader.getStats();
    const charts = paperTrader.getChartData();
    res.json({
      mode: config.mode,
      balance: paperTrader.getBalance(),
      stats,
      charts,
      useLiveData: config.paper.useLiveData,
      open: paperTrader.getOpenPositions(),
      closed: paperTrader.getClosedPositions(),
      logs: paperTrader.getLogs(50),
    });
  });

  app.get('/api/paper-status', (_req: Request, res: Response) => {
    const stats = paperTrader.getStats();
    const charts = paperTrader.getChartData();
    res.json({
      mode: config.mode,
      balance: paperTrader.getBalance(),
      stats,
      charts,
      useLiveData: config.paper.useLiveData,
      open: paperTrader.getOpenPositions(),
      closed: paperTrader.getClosedPositions(),
      logs: paperTrader.getLogs(50),
    });
  });

  /** Backtest: replay recent launches/migrations through paper engine */
  app.post('/backtest', async (req: Request, res: Response) => {
    try {
      const body = req.body as {
        hours?: number;
        fromMs?: number;
        toMs?: number;
        maxTrades?: number;
        simulations?: number;
        migrationsOnly?: boolean;
        pumpFunOnly?: boolean;
        reBuyEnabled?: boolean;
        minVolumeUsd?: number;
        strategyType?: 'convergence' | 'migration' | 'single' | 'auto';
        minLiquidityUsd?: number;
        minMarketCapUsd?: number;
        maxRiskScore?: number;
        useLiveData?: boolean;
        allowSynthetic?: boolean;
        startingBalanceSol?: number;
      };

      const { runBacktest } = await import('./backtest');
      const result = await runBacktest({
        hours: body.hours != null ? Number(body.hours) : undefined,
        fromMs: body.fromMs != null ? Number(body.fromMs) : undefined,
        toMs: body.toMs != null ? Number(body.toMs) : undefined,
        maxTrades: body.maxTrades != null ? Number(body.maxTrades) : 20,
        simulations:
          body.simulations != null ? Number(body.simulations) : undefined,
        migrationsOnly: body.migrationsOnly,
        pumpFunOnly: body.pumpFunOnly,
        reBuyEnabled: body.reBuyEnabled,
        minVolumeUsd:
          body.minVolumeUsd != null ? Number(body.minVolumeUsd) : undefined,
        strategyType: body.strategyType,
        minLiquidityUsd:
          body.minLiquidityUsd != null
            ? Number(body.minLiquidityUsd)
            : undefined,
        minMarketCapUsd:
          body.minMarketCapUsd != null
            ? Number(body.minMarketCapUsd)
            : undefined,
        maxRiskScore:
          body.maxRiskScore != null ? Number(body.maxRiskScore) : undefined,
        useLiveData:
          body.useLiveData !== undefined
            ? Boolean(body.useLiveData)
            : config.paper.useLiveData,
        allowSynthetic: body.allowSynthetic !== false,
        startingBalanceSol:
          body.startingBalanceSol != null
            ? Number(body.startingBalanceSol)
            : undefined,
      });

      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[backtest] Endpoint error:', message);
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.get('/backtest', async (req: Request, res: Response) => {
    try {
      const hours = Number(req.query.hours) || 24;
      const useLiveData =
        req.query.live === '0' || req.query.live === 'false'
          ? false
          : req.query.live === '1' || req.query.live === 'true'
            ? true
            : config.paper.useLiveData;
      const migrationsOnly =
        req.query.migrationsOnly === '1' || req.query.migrationsOnly === 'true';

      const { runBacktest } = await import('./backtest');
      const result = await runBacktest({
        hours,
        useLiveData,
        migrationsOnly,
        pumpFunOnly:
          req.query.pumpFunOnly === '1' || req.query.pumpFunOnly === 'true',
        reBuyEnabled:
          req.query.reBuy === '1' || req.query.reBuy === 'true',
        minVolumeUsd: Number(req.query.minVolume) || 0,
        maxTrades: Number(req.query.maxTrades) || 20,
        simulations: Number(req.query.simulations) || 1,
        strategyType: (req.query.strategy as
          | 'convergence'
          | 'migration'
          | 'single'
          | 'auto') || undefined,
        minLiquidityUsd: Number(req.query.minLiquidity) || 0,
        minMarketCapUsd: Number(req.query.minMc) || 0,
        maxRiskScore: Number(req.query.maxRisk) || 0,
        allowSynthetic: req.query.synthetic !== '0',
      });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.get('/backtest/last', async (_req: Request, res: Response) => {
    const { getLastBacktest } = await import('./backtest');
    const last = getLastBacktest();
    if (!last) {
      res.status(404).json({ ok: false, error: 'No backtest run yet' });
      return;
    }
    res.json(last);
  });

  app.get('/backtest/progress', async (_req: Request, res: Response) => {
    const { getBacktestProgress } = await import('./backtest');
    res.json(getBacktestProgress());
  });

  app.get('/backtest/export.csv', async (_req: Request, res: Response) => {
    const { exportLastBacktestCsv, getLastBacktest } = await import('./backtest');
    const csv = exportLastBacktestCsv();
    if (!csv) {
      res.status(404).json({ ok: false, error: 'No backtest to export' });
      return;
    }
    const id = getLastBacktest()?.id ?? 'backtest';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${id}.csv"`
    );
    res.send(csv);
  });

  app.get('/backtest/history', async (req: Request, res: Response) => {
    const { getBacktestHistory } = await import('./backtest');
    res.json({
      history: getBacktestHistory(Number(req.query.limit) || 10),
    });
  });

  app.post('/api/paper/live-data', (req: Request, res: Response) => {
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled boolean required' });
      return;
    }
    updatePaperConfig({ useLiveData: enabled });
    console.log(`[paper] useLiveData = ${enabled}`);
    res.json({ useLiveData: config.paper.useLiveData });
  });

  /** Add SOL to paper balance */
  app.post('/api/paper/topup', (req: Request, res: Response) => {
    const amountSol = Number((req.body as { amountSol?: number }).amountSol);
    if (!Number.isFinite(amountSol) || amountSol <= 0) {
      res.status(400).json({ error: 'amountSol must be a positive number' });
      return;
    }
    try {
      const balance = paperTrader.topUp(amountSol);
      res.json({
        ok: true,
        amountSol,
        balance,
        stats: paperTrader.getStats(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  /**
   * Reset paper balance to startingBalanceSol and clear open positions.
   * Pass clearHistory: true to also wipe closed trades + logs.
   */
  app.post('/api/paper/reset', (req: Request, res: Response) => {
    const clearHistory = Boolean(
      (req.body as { clearHistory?: boolean }).clearHistory
    );
    const result = paperTrader.reset({ clearHistory });
    res.json({
      ok: true,
      ...result,
      startingBalanceSol: config.paper.startingBalanceSol,
      stats: paperTrader.getStats(),
      open: paperTrader.getOpenPositions(),
      closed: paperTrader.getClosedPositions(),
    });
  });

  app.post('/api/monitor/toggle', (_req: Request, res: Response) => {
    if (isMonitorPaused()) {
      clearMonitorRiskHalt();
      resumeMonitor();
    } else {
      pauseMonitor();
    }
    res.json(getMonitorStatus());
  });

  app.post('/api/monitor/pause', (_req: Request, res: Response) => {
    pauseMonitor();
    res.json(getMonitorStatus());
  });

  app.post('/api/monitor/resume', (req: Request, res: Response) => {
    if (req.body?.clearRiskHalt || req.query.clearRiskHalt === '1') {
      clearMonitorRiskHalt();
    }
    resumeMonitor();
    res.json(getMonitorStatus());
  });

  app.get('/api/risk', (_req: Request, res: Response) => {
    res.json({
      config: config.risk,
      status: getRiskStatus({
        equitySol: paperTrader.getEquitySol(),
        dailyPnlSol: paperTrader.getDailyPnlSol(),
        weeklyPnlSol: paperTrader.getWeeklyPnlSol(),
      }),
    });
  });

  app.post('/api/risk', (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const partial: Parameters<typeof updateRiskConfig>[0] = {};

    for (const key of [
      'enabled',
      'useRiskSizing',
      'autoPauseOnLimit',
      'tieredSellEnabled',
    ] as const) {
      if (body[key] !== undefined) (partial as Record<string, unknown>)[key] = Boolean(body[key]);
    }
    for (const key of [
      'riskPercentPerTrade',
      'maxTradeSol',
      'minTradeSol',
      'weeklyLossLimitSol',
      'maxDrawdownPct',
      'trailingStopPct',
      'trailingStopPercent',
      'trailingActivationProfit',
    ] as const) {
      if (body[key] !== undefined) {
        (partial as Record<string, number>)[key] = Number(body[key]);
      }
    }
    if (body.normal && typeof body.normal === 'object') {
      partial.normal = body.normal as typeof config.risk.normal;
    }
    if (body.migration && typeof body.migration === 'object') {
      partial.migration = body.migration as typeof config.risk.migration;
    }

    const risk = updateRiskConfig(partial);
    res.json({ ok: true, risk });
  });

  app.get('/api/profit-strategy', (_req: Request, res: Response) => {
    res.json({ profitStrategy: config.profitStrategy });
  });

  app.post('/api/profit-strategy', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const partial: Partial<typeof config.profitStrategy> = {};
    if (body.enabled !== undefined) partial.enabled = Boolean(body.enabled);
    if (body.riskBasedAdjustment !== undefined) {
      partial.riskBasedAdjustment = Boolean(body.riskBasedAdjustment);
    }
    for (const key of [
      'takeInitialPercent',
      'partialSellAt',
      'partialSellPercent',
      'trailingStopAfter',
      'trailingStopPct',
      'bagPercent',
      'highRiskScoreThreshold',
    ] as const) {
      if (body[key] !== undefined) partial[key] = Number(body[key]);
    }
    const profitStrategy = updateProfitStrategyConfig(partial);
    res.json({ ok: true, profitStrategy });
  });

  app.post('/api/risk/clear-halt', (_req: Request, res: Response) => {
    clearRiskHalt();
    clearMonitorRiskHalt();
    resumeMonitor();
    res.json({ ok: true, status: getMonitorStatus() });
  });

  // --- Positions & logs ---

  app.get('/api/positions', (_req: Request, res: Response) => {
    res.json({
      open: paperTrader.getOpenPositions(),
      closed: paperTrader.getClosedPositions(),
      sellHistory: getSellHistory(),
      rebuy: {
        status: getReBuyStatus(),
        candidates: getReBuyCandidates(),
      },
    });
  });

  app.get('/api/rebuy', (_req: Request, res: Response) => {
    res.json({
      status: getReBuyStatus(),
      candidates: getReBuyCandidates(),
      sellHistory: getSellHistory().slice(0, 50),
    });
  });

  app.get('/api/logs', (req: Request, res: Response) => {
    const limit = Number(req.query.limit) || 100;
    res.json(paperTrader.getLogs(limit));
  });

  /** Structured system / fetch logs (GMGN, RPC, Jupiter, …) */
  app.get('/api/system-logs', (req: Request, res: Response) => {
    const limit = Number(req.query.limit) || 100;
    const level = String(req.query.level ?? 'all') as
      | 'all'
      | 'info'
      | 'warn'
      | 'error';
    const context = req.query.context != null ? String(req.query.context) : '';
    const q = req.query.q != null ? String(req.query.q) : '';
    res.json({
      entries: logger.query({ level, context, q, limit }),
      stats: logger.getStats(),
    });
  });

  /** Alias — recent errors/warnings for debugging fetch issues */
  app.get('/logs', (req: Request, res: Response) => {
    const limit = Number(req.query.limit) || 100;
    const levelRaw = String(req.query.level ?? 'all');
    const level =
      levelRaw === 'info' || levelRaw === 'warn' || levelRaw === 'error'
        ? levelRaw
        : 'all';
    // Default /logs to warn+error friendly view when no level specified
    const entries =
      levelRaw === 'all' || !req.query.level
        ? logger
            .query({ level: 'all', limit: Math.min(limit * 2, 200) })
            .filter((e) => e.level === 'warn' || e.level === 'error')
            .slice(0, limit)
        : logger.query({
            level,
            context: req.query.context != null ? String(req.query.context) : '',
            q: req.query.q != null ? String(req.query.q) : '',
            limit,
          });
    res.json({
      entries,
      stats: logger.getStats(),
    });
  });

  app.post('/api/system-logs/clear', (_req: Request, res: Response) => {
    logger.clear();
    logger.info('Server', 'system log ring cleared');
    res.json({ ok: true, stats: logger.getStats() });
  });

  app.get('/api/activity', (_req: Request, res: Response) => {
    res.json(getRecentActivity());
  });

  app.get('/api/pump-activity', (req: Request, res: Response) => {
    const kind = String(req.query.kind || 'all') as
      | 'all'
      | 'early_buy'
      | 'curve_buy'
      | 'near_migration'
      | 'migration'
      | 'convergence';
    const events = getPumpSmartActivity({
      limit: Number(req.query.limit) || 40,
      kind,
      onlyPriority:
        req.query.priority === '1' || req.query.priority === 'true',
      earlyOnly: req.query.early === '1' || req.query.early === 'true',
      nearMigrationOnly:
        req.query.nearMigration === '1' || req.query.nearMigration === 'true',
      migrationOnly:
        req.query.migration === '1' || req.query.migration === 'true',
      minSmartMoneyScore: Number(req.query.minSm) || 0,
    });
    res.json({
      events,
      launches: getPumpLaunchTracks(15),
      status: getPumpSmartStatus(),
    });
  });

  app.get('/api/pump-activity/status', (_req: Request, res: Response) => {
    res.json(getPumpSmartStatus());
  });

  app.post('/api/pump-activity/clear', (_req: Request, res: Response) => {
    clearPumpSmartActivity();
    res.json({ ok: true, status: getPumpSmartStatus() });
  });

  app.post('/api/discover-pump-smart', async (req: Request, res: Response) => {
    try {
      const limit = Number(req.body?.limit ?? req.query.limit) || 20;
      const force =
        req.body?.force === true ||
        req.query.force === '1' ||
        req.query.force === 'true';
      const result = await discoverPumpFunSmartMoney({ limit, force });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message, wallets: [], hotLaunches: [] });
    }
  });

  // --- Config ---

  app.get('/api/config', (_req: Request, res: Response) => {
    res.json(getConfigSnapshot());
  });

  app.post('/api/config/mode', (req: Request, res: Response) => {
    const { mode } = req.body as { mode: TradingMode };
    if (mode !== 'paper' && mode !== 'live') {
      res.status(400).json({ error: 'mode must be paper or live' });
      return;
    }
    if (mode === 'live') {
      const kp = getWalletPublicKey();
      if (!kp) {
        const slot = getActiveTradingWallet();
        res.status(400).json({
          error: slot
            ? `Cannot enable live — set ${slot.envVar} in .env for "${slot.name}"`
            : 'Cannot enable live — configure a trading wallet first',
        });
        return;
      }
    }
    setMode(mode);
    res.json({
      mode: config.mode,
      tradingWallet: getActiveTradingWallet()
        ? {
            id: getActiveTradingWallet()!.id,
            name: getActiveTradingWallet()!.name,
            publicKey: getWalletPublicKey()?.toBase58() ?? null,
          }
        : null,
    });
  });

  // --- Live trading wallets (keys never leave the backend) ---

  app.get('/api/trading-wallets', async (_req: Request, res: Response) => {
    try {
      const status = await getTradingWalletsStatus();
      res.json(status);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/trading-wallets/select', (req: Request, res: Response) => {
    const { id } = req.body as { id?: string };
    if (!id?.trim()) {
      res.status(400).json({ error: 'id required' });
      return;
    }
    const result = setActiveTradingWallet(id.trim());
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    // Keep prior keypairs cached but log new active pubkey
    const pubkey = getWalletPublicKey(id.trim());
    res.json({
      ok: true,
      activeId: config.activeTradingWalletId,
      publicKey: pubkey?.toBase58() ?? null,
      hasKey: Boolean(pubkey),
    });
  });

  app.post('/api/trading-wallets', (req: Request, res: Response) => {
    const { name, envVar, role } = req.body as {
      name?: string;
      envVar?: string;
      role?: 'main' | 'burner' | 'custom';
    };

    // Reject any attempt to submit private key material
    if (
      (req.body as { privateKey?: unknown }).privateKey != null ||
      (req.body as { secretKey?: unknown }).secretKey != null ||
      (req.body as { key?: unknown }).key != null
    ) {
      res.status(400).json({
        error:
          'Never send private keys to the API. Set the key in .env and pass envVar name only.',
      });
      return;
    }

    const result = addTradingWallet({
      name: name ?? '',
      envVar: envVar ?? '',
      role,
    });
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({
      ok: true,
      wallet: {
        id: result.wallet!.id,
        name: result.wallet!.name,
        role: result.wallet!.role,
        envVar: result.wallet!.envVar,
        enabled: result.wallet!.enabled,
      },
    });
  });

  app.delete('/api/trading-wallets/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const result = removeTradingWallet(id);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    clearKeypairCache(id);
    res.json({ ok: true, activeId: config.activeTradingWalletId });
  });

  app.post('/api/config/trade', (req: Request, res: Response) => {
    const { tradeAmountSol, minProfitPercent, maxProfitPercent, stopLossPercent } =
      req.body as Record<string, number>;

    updateTradeConfig({
      ...(tradeAmountSol !== undefined && { tradeAmountSol: Number(tradeAmountSol) }),
      ...(minProfitPercent !== undefined && { minProfitPercent: Number(minProfitPercent) }),
      ...(maxProfitPercent !== undefined && { maxProfitPercent: Number(maxProfitPercent) }),
      ...(stopLossPercent !== undefined && { stopLossPercent: Number(stopLossPercent) }),
    });

    res.json(config.trade);
  });

  app.post('/api/config/filters', (req: Request, res: Response) => {
    const keys = [
      'minWinRate',
      'minLiquidity',
      'maxDevHoldPct',
      'maxDevPercent',
      'maxTopHolderPct',
      'maxHolderConcentration',
      'maxEstimatedTaxPct',
      'maxRiskScore',
      'convergenceRequired',
      'maxConcurrentPositions',
      'dailyLossLimitSol',
      'minActivityDays',
      'minTradesLast30d',
    ] as const;

    const partial: Partial<Record<(typeof keys)[number], number>> = {};
    for (const key of keys) {
      if (req.body[key] !== undefined) {
        partial[key] = Number(req.body[key]);
      }
    }
    if (req.body.enableActivityFilter !== undefined) {
      config.filters.enableActivityFilter = Boolean(req.body.enableActivityFilter);
    }
    if (req.body.skipIfMintAuthority !== undefined) {
      config.filters.skipIfMintAuthority = Boolean(req.body.skipIfMintAuthority);
    }
    if (req.body.enableAntiRug !== undefined) {
      config.filters.enableAntiRug = Boolean(req.body.enableAntiRug);
    }
    if (req.body.requireLiquidityLocked !== undefined) {
      config.filters.requireLiquidityLocked = Boolean(req.body.requireLiquidityLocked);
    }
    if (req.body.skipIfDevRecentSells !== undefined) {
      config.filters.skipIfDevRecentSells = Boolean(req.body.skipIfDevRecentSells);
    }
    if (req.body.checkHoneypot !== undefined) {
      config.filters.checkHoneypot = Boolean(req.body.checkHoneypot);
    }
    if (req.body.enableSniperFilter !== undefined) {
      config.filters.enableSniperFilter = Boolean(req.body.enableSniperFilter);
    }
    if (
      req.body.sniperSensitivity !== undefined &&
      ['low', 'medium', 'high'].includes(String(req.body.sniperSensitivity))
    ) {
      config.filters.sniperSensitivity = String(
        req.body.sniperSensitivity
      ) as 'low' | 'medium' | 'high';
    }
    for (const key of [
      'maxSniperCount',
      'maxBundlerPct',
      'maxInsiderPct',
      'maxSniperScore',
    ] as const) {
      if (req.body[key] !== undefined) {
        (partial as Record<string, number>)[key] = Number(req.body[key]);
      }
    }
    updateFilterConfig(partial);
    res.json(config.filters);
  });

  app.get('/api/token-metrics/:mint', async (req: Request, res: Response) => {
    try {
      const mint = String(req.params.mint);
      const force = req.query.force === '1' || req.query.force === 'true';
      const metrics = await fetchTokenMetrics(mint, { force });
      const verdict = evaluateTokenMetricsFilters(metrics);
      const antiRug = await evaluateAntiRug(mint, { force });
      let birdeyeSummary = antiRug.birdeye ?? null;
      if (!birdeyeSummary) {
        try {
          const overview = await getTokenOverview(mint, { force });
          const signal = await getSmartMoneySignal(mint, { force });
          birdeyeSummary = summarizeBirdeye(overview, signal);
        } catch {
          birdeyeSummary = null;
        }
      }
      res.json({
        metrics,
        summary: summarizeTokenMetrics(metrics),
        filter: verdict,
        antiRug: {
          report: antiRug,
          summary: summarizeAntiRug(antiRug),
        },
        sniper: antiRug.sniper ?? null,
        birdeye: birdeyeSummary,
        birdeyeStatus: getBirdeyeStatus(),
        cache: getTokenMetricsCacheStats(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/anti-rug/:mint', async (req: Request, res: Response) => {
    try {
      const mint = String(req.params.mint);
      const force = req.query.force === '1' || req.query.force === 'true';
      const report = await evaluateAntiRug(mint, { force });
      res.json({
        report,
        summary: summarizeAntiRug(report),
        cache: getAntiRugCacheStats(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/birdeye/token/:mint', async (req: Request, res: Response) => {
    try {
      const mint = String(req.params.mint);
      const force = req.query.force === '1' || req.query.force === 'true';
      const overview = await getTokenOverview(mint, { force });
      const signal = await getSmartMoneySignal(mint, { force });
      res.json({
        overview,
        signal,
        summary: summarizeBirdeye(overview, signal),
        status: getBirdeyeStatus(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        error: message,
        overview: null,
        signal: null,
        summary: null,
        status: getBirdeyeStatus(),
      });
    }
  });

  app.get('/api/birdeye/trending', async (req: Request, res: Response) => {
    try {
      const limit = Number(req.query.limit) || 20;
      const force = req.query.force === '1' || req.query.force === 'true';
      const result = await getTrendingTokens(limit, { force });
      res.json({
        ...result,
        status: getBirdeyeStatus(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        tokens: [],
        source: 'none',
        error: message,
        status: getBirdeyeStatus(),
      });
    }
  });

  app.get('/api/birdeye/status', (_req: Request, res: Response) => {
    res.json(getBirdeyeStatus());
  });

  app.post('/api/birdeye/clear-cache', (_req: Request, res: Response) => {
    clearBirdeyeCache();
    res.json({ ok: true, status: getBirdeyeStatus() });
  });

  app.get('/api/bonding-curve/:mint', async (req: Request, res: Response) => {
    try {
      const mint = String(req.params.mint);
      const force = req.query.force === '1' || req.query.force === 'true';
      const state = await fetchBondingCurve(mint, { force });
      res.json({
        state,
        summary: summarizeBondingCurve(state),
        cache: getBondingCurveCacheStats(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/token-metrics/clear-cache', (_req: Request, res: Response) => {
    clearTokenMetricsCache();
    clearAntiRugCache();
    clearBondingCurveCache();
    clearBirdeyeCache();
    res.json({
      ok: true,
      cache: getTokenMetricsCacheStats(),
      antiRugCache: getAntiRugCacheStats(),
      bondingCurveCache: getBondingCurveCacheStats(),
      birdeye: getBirdeyeStatus(),
    });
  });

  app.post('/api/config/strategy', (req: Request, res: Response) => {
    const {
      enableConvergence,
      enableMigrationOnly,
      enableMigrationPriority,
      enableBondingCurvePriority,
      nearMigrationCurvePct,
      enableEarlyCurvePriority,
      earlyCurveMaxPct,
      minEarlyBirdeyeSmartMoneyScore,
      earlyCurveMinSmartWallets,
      enableAutoSell,
      migrationSizeMultiplier,
      migrationSlippageBps,
      migrationVolumeSpikeSol,
      reBuyEnabled,
      reBuyMinProfitPct,
      reBuyDipPercent,
      confirmationThreshold,
      reBuyVolumeIncreasePct,
      reBuyMaxPerMint,
    } = req.body as {
      enableConvergence?: boolean;
      enableMigrationOnly?: boolean;
      enableMigrationPriority?: boolean;
      enableBondingCurvePriority?: boolean;
      nearMigrationCurvePct?: number;
      enableEarlyCurvePriority?: boolean;
      earlyCurveMaxPct?: number;
      minEarlyBirdeyeSmartMoneyScore?: number;
      earlyCurveMinSmartWallets?: number;
      enableAutoSell?: boolean;
      migrationSizeMultiplier?: number;
      migrationSlippageBps?: number;
      migrationVolumeSpikeSol?: number;
      reBuyEnabled?: boolean;
      reBuyMinProfitPct?: number;
      reBuyDipPercent?: number;
      confirmationThreshold?: number;
      reBuyVolumeIncreasePct?: number;
      reBuyMaxPerMint?: number;
    };

    updateStrategyConfig({
      ...(enableConvergence !== undefined && { enableConvergence }),
      ...(enableMigrationOnly !== undefined && { enableMigrationOnly }),
      ...(enableMigrationPriority !== undefined && { enableMigrationPriority }),
      ...(enableBondingCurvePriority !== undefined && {
        enableBondingCurvePriority: Boolean(enableBondingCurvePriority),
      }),
      ...(nearMigrationCurvePct !== undefined && {
        nearMigrationCurvePct: Number(nearMigrationCurvePct),
      }),
      ...(enableEarlyCurvePriority !== undefined && {
        enableEarlyCurvePriority: Boolean(enableEarlyCurvePriority),
      }),
      ...(earlyCurveMaxPct !== undefined && {
        earlyCurveMaxPct: Number(earlyCurveMaxPct),
      }),
      ...(minEarlyBirdeyeSmartMoneyScore !== undefined && {
        minEarlyBirdeyeSmartMoneyScore: Number(minEarlyBirdeyeSmartMoneyScore),
      }),
      ...(earlyCurveMinSmartWallets !== undefined && {
        earlyCurveMinSmartWallets: Number(earlyCurveMinSmartWallets),
      }),
      ...(enableAutoSell !== undefined && { enableAutoSell }),
      ...(migrationSizeMultiplier !== undefined && {
        migrationSizeMultiplier: Number(migrationSizeMultiplier),
      }),
      ...(migrationSlippageBps !== undefined && {
        migrationSlippageBps: Number(migrationSlippageBps),
      }),
      ...(migrationVolumeSpikeSol !== undefined && {
        migrationVolumeSpikeSol: Number(migrationVolumeSpikeSol),
      }),
      ...(reBuyEnabled !== undefined && { reBuyEnabled: Boolean(reBuyEnabled) }),
      ...(reBuyMinProfitPct !== undefined && {
        reBuyMinProfitPct: Number(reBuyMinProfitPct),
      }),
      ...(reBuyDipPercent !== undefined && {
        reBuyDipPercent: Number(reBuyDipPercent),
      }),
      ...(confirmationThreshold !== undefined && {
        confirmationThreshold: Number(confirmationThreshold),
      }),
      ...(reBuyVolumeIncreasePct !== undefined && {
        reBuyVolumeIncreasePct: Number(reBuyVolumeIncreasePct),
      }),
      ...(reBuyMaxPerMint !== undefined && {
        reBuyMaxPerMint: Number(reBuyMaxPerMint),
      }),
    });

    res.json(config.strategy);
  });

  // --- GMGN smart wallet suggestions ---

  app.get('/api/gmgn/status', (_req: Request, res: Response) => {
    res.json(getGmgnStatus());
  });

  app.post('/api/gmgn/discovery', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const partial: Parameters<typeof updateDiscoveryConfig>[0] = {};
    if (body.minTrades7d != null) partial.minTrades7d = Number(body.minTrades7d);
    if (body.minWinRate != null) partial.minWinRate = Number(body.minWinRate);
    if (body.pumpFunFocus != null) partial.pumpFunFocus = Boolean(body.pumpFunFocus);
    if (body.activityDays != null) partial.activityDays = Number(body.activityDays);
    if (body.maxSniperScore != null) {
      partial.maxSniperScore = Number(body.maxSniperScore);
    }
    if (body.autoRefreshMs != null) {
      partial.autoRefreshMs = Number(body.autoRefreshMs);
    }
    const discovery = updateDiscoveryConfig(partial);
    res.json({ ok: true, discovery, gmgn: getGmgnStatus() });
  });

  /** Multi-source smart wallet discovery */
  app.get('/api/discover-wallets', async (req: Request, res: Response) => {
    try {
      const source = String(req.query.source ?? config.walletDiscovery.defaultSource) as DiscoverySource;
      const allowed: DiscoverySource[] = [
        'gmgn',
        'birdeye',
        'dexscreener',
        'kolscan',
        'manual',
        'all',
      ];
      const result = await findSmartWallets({
        source: allowed.includes(source) ? source : 'gmgn',
        limit: req.query.limit != null ? Number(req.query.limit) : 40,
        period: req.query.period === '30d' ? '30d' : '7d',
        minWinRate:
          req.query.minWinRate != null ? Number(req.query.minWinRate) : undefined,
        manualText:
          req.query.manualText != null ? String(req.query.manualText) : undefined,
        force: req.query.force === '1' || req.query.force === 'true',
        pumpFunFocus:
          req.query.pumpFunFocus === '1' ||
          req.query.pumpFunFocus === 'true',
      });
      res.json({
        ...result,
        discovery: getDiscoveryStatus(),
        gmgn: getGmgnStatus(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message, wallets: [], source: 'error' });
    }
  });

  app.post('/api/discover-wallets', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        source?: DiscoverySource;
        limit?: number;
        period?: '7d' | '30d';
        minWinRate?: number;
        manualText?: string;
        force?: boolean;
        defaultSource?: DiscoverySource;
        pumpFunFocus?: boolean;
        minTrades7d?: number;
      };
      const allowed: DiscoverySource[] = [
        'gmgn',
        'birdeye',
        'dexscreener',
        'kolscan',
        'manual',
        'all',
      ];
      if (body.defaultSource && allowed.includes(body.defaultSource)) {
        config.walletDiscovery.defaultSource = body.defaultSource;
        persistUserSettings();
      }
      const result = await findSmartWallets({
        source:
          body.source && allowed.includes(body.source) ? body.source : undefined,
        limit: body.limit ?? 40,
        period: body.period,
        minWinRate: body.minWinRate,
        manualText: body.manualText,
        force: body.force,
        pumpFunFocus: body.pumpFunFocus,
      });
      res.json({
        ...result,
        discovery: getDiscoveryStatus(),
        gmgn: getGmgnStatus(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message, wallets: [], source: 'error' });
    }
  });

  app.get('/api/discover-wallets/status', (_req: Request, res: Response) => {
    res.json(getDiscoveryStatus());
  });

  app.post('/api/discover-wallets/clear-cache', (_req: Request, res: Response) => {
    clearDiscoveryCache();
    res.json({ ok: true, discovery: getDiscoveryStatus() });
  });

  app.get('/api/gmgn/sniper/:mint', async (req: Request, res: Response) => {
    try {
      const mint = String(req.params.mint);
      const force = req.query.force === '1' || req.query.force === 'true';
      const report = await getTokenSniperActivity(mint, { force });
      res.json({
        report,
        summary: summarizeSniper(report),
        thresholds: getSniperThresholds(),
        gmgn: getGmgnStatus(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/gmgn/clear-cache', (_req: Request, res: Response) => {
    clearGmgnCache();
    res.json({ ok: true });
  });

  app.get('/api/gmgn/suggestions', async (req: Request, res: Response) => {
    try {
      const minWinRate = Number(req.query.minWinRate) || 45;
      const period = (req.query.period === '30d' ? '30d' : '7d') as GmgnPeriod;
      const limit = Number(req.query.limit) || 20;
      const result = await getTopSmartWallets(limit, period, minWinRate);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/gmgn/import', async (req: Request, res: Response) => {
    try {
      const minWinRate = Number(req.body?.minWinRate) || 45;
      const period = (req.body?.period === '30d' ? '30d' : '7d') as GmgnPeriod;
      const limit = Number(req.body?.limit) || 20;
      const { wallets, source } = await getTopSmartWallets(limit, period, minWinRate);
      const result = importSuggestedWallets(wallets, { minWinRate, onlyNew: true });
      console.log(
        `[gmgn] Imported ${result.added.length} wallet(s) from ${source} (${period})`
      );
      res.json({ ...result, source, period, wallets: getWalletsWithActivity() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /** Primary GMGN top-wallets endpoint — candidates with Add support */
  app.get('/gmgn/top-wallets', async (req: Request, res: Response) => {
    try {
      const minWinRate = Number(req.query.minWinRate) || 45;
      const period = (req.query.period === '30d' ? '30d' : '7d') as GmgnPeriod;
      const limit = Number(req.query.limit) || 20;
      const result = await Promise.race([
        getTopSmartWallets(limit, period, minWinRate),
        new Promise<Awaited<ReturnType<typeof getTopSmartWallets>>>((resolve) => {
          setTimeout(() => {
            const curated = getCuratedSmartWallets(limit, period, minWinRate);
            curated.error =
              'GMGN timed out — showing curated wallets (Cented / Theo / Decu)';
            resolve(curated);
          }, 8_000);
        }),
      ]);
      res.json({
        ...result,
        gmgn: getGmgnStatus(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const curated = getCuratedSmartWallets(
        Number(req.query.limit) || 20,
        req.query.period === '30d' ? '30d' : '7d',
        Number(req.query.minWinRate) || 45
      );
      curated.error = message;
      res.json({ ...curated, gmgn: getGmgnStatus() });
    }
  });

  app.post('/gmgn/top-wallets/add', (req: Request, res: Response) => {
    const body = req.body as {
      name?: string;
      address?: string;
      winRate?: number;
      lastActive?: number;
      lastTradeTime?: number;
      tradesLast7d?: number;
      pumpFunTradeCount?: number;
      notes?: string;
      tags?: string[];
    };
    if (!body.name?.trim() || !body.address?.trim()) {
      res.status(400).json({ error: 'name and address required' });
      return;
    }
    if (!isValidSolanaAddress(body.address.trim())) {
      res.status(400).json({ error: 'Invalid Solana address' });
      return;
    }
    const lastActive = body.lastActive ?? body.lastTradeTime;
    const tags = body.tags;
    const result = upsertSmartWallet({
      name: body.name.trim(),
      address: body.address.trim(),
      enabled: true,
      lastActive,
      lastTradedAt: lastActive,
      winRate: body.winRate,
      tradesLast7d: body.tradesLast7d,
      pumpFunTradeCount: body.pumpFunTradeCount,
      notes: body.notes,
      tags,
      category: inferWalletCategory(tags, body.tradesLast7d),
      source: 'gmgn',
      discoveredAt: Date.now(),
    });
    res.json({
      ok: true,
      added: result.added,
      updated: result.updated,
      wallets: getWalletsWithActivity(),
    });
  });

  /** Advanced wallet search — query + filters → candidates */
  app.get('/search-wallets', async (req: Request, res: Response) => {
    try {
      const result = await searchWallets({
        query: String(req.query.query ?? req.query.q ?? ''),
        minWinRate: req.query.minWinRate != null ? Number(req.query.minWinRate) : undefined,
        minTrades7d: req.query.minTrades7d != null ? Number(req.query.minTrades7d) : undefined,
        pumpFunFocus:
          req.query.pumpFunFocus === '1' ||
          req.query.pumpFunFocus === 'true',
        maxDaysInactive:
          req.query.maxDaysInactive != null
            ? Number(req.query.maxDaysInactive)
            : req.query.activityDays != null
              ? Number(req.query.activityDays)
              : undefined,
        activityDays:
          req.query.activityDays != null
            ? Number(req.query.activityDays)
            : undefined,
        maxSniperScore:
          req.query.maxSniperScore != null
            ? Number(req.query.maxSniperScore)
            : undefined,
        scalperOnly:
          req.query.scalperOnly === '1' ||
          req.query.scalperOnly === 'true',
        period: req.query.period === '30d' ? '30d' : '7d',
        limit: req.query.limit != null ? Number(req.query.limit) : 20,
      });
      res.json({ ...result, gmgn: getGmgnStatus() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message, candidates: [] });
    }
  });

  app.post('/search-wallets', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        query?: string;
        minWinRate?: number;
        minTrades7d?: number;
        pumpFunFocus?: boolean;
        maxDaysInactive?: number;
        activityDays?: number;
        maxSniperScore?: number;
        scalperOnly?: boolean;
        period?: GmgnPeriod;
        limit?: number;
      };
      const result = await searchWallets(body);
      res.json({ ...result, gmgn: getGmgnStatus() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message, candidates: [] });
    }
  });

  app.get('/search-wallets/suggest', async (req: Request, res: Response) => {
    try {
      const limit = Number(req.query.limit) || 10;
      const result = await suggestConsistentScalpers(limit);
      res.json({ ...result, gmgn: getGmgnStatus() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message, candidates: [] });
    }
  });

  /** Legacy aliases */
  app.get('/top-wallets', async (req: Request, res: Response) => {
    try {
      const minWinRate = Number(req.query.minWinRate) || 45;
      const period = (req.query.period === '30d' ? '30d' : '7d') as GmgnPeriod;
      const limit = Number(req.query.limit) || 20;
      const result = await getTopSmartWallets(limit, period, minWinRate);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.post('/top-wallets/add', (req: Request, res: Response) => {
    const { name, address } = req.body as { name?: string; address?: string };
    if (!name?.trim() || !address?.trim()) {
      res.status(400).json({ error: 'name and address required' });
      return;
    }
    if (!isValidSolanaAddress(address.trim())) {
      res.status(400).json({ error: 'Invalid Solana address' });
      return;
    }
    const added = addSmartWallet({
      name: name.trim(),
      address: address.trim(),
      enabled: true,
    });
    if (!added) {
      res.status(409).json({ error: 'Wallet already tracked' });
      return;
    }
    res.json({ ok: true, wallets: getWalletsWithActivity() });
  });

  app.post('/api/wallets/refresh-activity', async (_req: Request, res: Response) => {
    try {
      const reports = await refreshAllWalletActivity();
      const filter = filterActiveWallets({ persistActiveOnly: false });
      res.json({ reports, filter, wallets: getWalletsWithActivity() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/wallets/prune-inactive', (_req: Request, res: Response) => {
    const filter = filterActiveWallets({
      persistActiveOnly: true,
      pruneInactive: true,
    });
    res.json({ ...filter, wallets: getWalletsWithActivity() });
  });

  app.get('/api/migrations', (_req: Request, res: Response) => {
    res.json({
      status: getMigrationStatus(),
      recent: getRecentMigrations(),
    });
  });

  // --- Wallet management (primary routes) ---

  app.get('/wallets', (_req: Request, res: Response) => {
    res.json(getWalletsWithActivity());
  });

  app.post('/wallets/add', (req: Request, res: Response) => {
    const body = req.body as {
      name?: string;
      address?: string;
      winRate?: number;
      lastActive?: number;
      lastTradeTime?: number;
      tradesLast7d?: number;
      pumpFunTradeCount?: number;
      notes?: string;
      tags?: string[];
      category?: string;
      source?: string;
    };

    if (!body.name?.trim() || !body.address?.trim()) {
      res.status(400).json({ error: 'name and address required' });
      return;
    }

    if (!isValidSolanaAddress(body.address.trim())) {
      res.status(400).json({ error: 'Invalid Solana address' });
      return;
    }

    const lastActive = body.lastActive ?? body.lastTradeTime;
    const tags = body.tags;
    const category =
      (body.category as 'smart' | 'scalper' | 'sniper' | 'kol' | undefined) ??
      inferWalletCategory(tags, body.tradesLast7d);
    const result = upsertSmartWallet({
      name: body.name.trim(),
      address: body.address.trim(),
      enabled: true,
      lastActive,
      lastTradedAt: lastActive,
      winRate: body.winRate,
      tradesLast7d: body.tradesLast7d,
      pumpFunTradeCount: body.pumpFunTradeCount,
      notes: body.notes,
      tags,
      category,
      source: (body.source as
        | 'gmgn'
        | 'birdeye'
        | 'dexscreener'
        | 'curated'
        | 'manual'
        | 'bulk') ?? 'manual',
      discoveredAt: Date.now(),
    });

    res.json({
      ok: true,
      added: result.added,
      updated: result.updated,
      wallets: getWalletsWithActivity(),
    });
  });

  /** Bulk import addresses (one per line / comma-separated; optional Name:Address) */
  app.post('/wallets/bulk-import', (req: Request, res: Response) => {
    const raw = String(req.body?.text ?? req.body?.addresses ?? '');
    const categoryHint = req.body?.category as
      | 'smart'
      | 'scalper'
      | 'sniper'
      | 'kol'
      | undefined;
    const parts = raw
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const added: string[] = [];
    const updated: string[] = [];
    const skipped: string[] = [];

    for (const part of parts) {
      let name = part.slice(0, 8);
      let address = part;
      if (part.includes(':')) {
        const idx = part.lastIndexOf(':');
        const n = part.slice(0, idx).trim();
        const a = part.slice(idx + 1).trim();
        if (a && isValidSolanaAddress(a)) {
          name = n || name;
          address = a;
        }
      }
      if (!isValidSolanaAddress(address)) {
        skipped.push(part);
        continue;
      }
      const tags =
        categoryHint === 'scalper'
          ? ['scalper']
          : categoryHint === 'sniper'
            ? ['sniper']
            : categoryHint === 'kol'
              ? ['kol']
              : [];
      const result = upsertSmartWallet({
        name,
        address,
        enabled: true,
        tags,
        category: categoryHint ?? inferWalletCategory(tags),
        source: 'bulk',
        discoveredAt: Date.now(),
      });
      if (result.added) added.push(address);
      else if (result.updated) updated.push(address);
      else skipped.push(address);
    }

    res.json({
      ok: true,
      added,
      updated,
      skipped,
      wallets: getWalletsWithActivity(),
    });
  });

  app.post('/wallets/remove', (req: Request, res: Response) => {
    const { address } = req.body as { address?: string };

    if (!address?.trim()) {
      res.status(400).json({ error: 'address required' });
      return;
    }

    const removed = removeSmartWallet(address.trim());
    if (!removed) {
      res.status(404).json({ error: 'Wallet not found' });
      return;
    }

    res.json({ ok: true, wallets: getWalletsWithActivity() });
  });

  // --- Legacy wallet API (backward compat) ---

  app.post('/api/wallets', (req: Request, res: Response) => {
    const { name, address } = req.body as { name: string; address: string };
    if (!name || !address) {
      res.status(400).json({ error: 'name and address required' });
      return;
    }
    addSmartWallet({ name, address, enabled: true });
    res.json({ wallets: config.smartWallets });
  });

  app.delete('/api/wallets/:address', (req: Request, res: Response) => {
    removeSmartWallet(String(req.params.address));
    res.json({ wallets: config.smartWallets });
  });

  app.patch('/api/wallets/:address', (req: Request, res: Response) => {
    const address = String(req.params.address);
    const { enabled } = req.body as { enabled: boolean };
    toggleSmartWallet(address, enabled);
    res.json({ wallets: config.smartWallets });
  });

  // --- Dashboard (tabbed Tailwind UI) ---

  app.get('/dashboard', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(DASHBOARD_HTML);
  });

  app.get('/', (_req: Request, res: Response) => {
    res.redirect('/dashboard');
  });

  return app;
}

export function startServer(port?: number, host?: string): void {
  startRpcHealthMonitor();
  startDiscoveryAutoRefresh();
  const listenPort = port ?? env.port ?? config.port;
  const listenHost = host ?? env.host;
  logger.info('Server', 'starting dashboard', {
    port: listenPort,
    host: listenHost,
    nodeEnv: env.nodeEnv,
  });
  const app = createServer();

  app.listen(listenPort, listenHost, () => {
    const url = `http://${listenHost === '0.0.0.0' ? 'localhost' : listenHost}:${listenPort}/dashboard`;
    logger.info('Server', `Dashboard → ${url}`, { health: '/health' });
    console.log(`[server] Dashboard → ${url}`);
    console.log(`[server] Health    → http://${listenHost === '0.0.0.0' ? 'localhost' : listenHost}:${listenPort}/health`);
  });
}
