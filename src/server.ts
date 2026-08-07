/**
 * Express API + dashboard for monitoring and configuration.
 */

import path from 'node:path';
import zlib from 'node:zlib';
import express, { Request, Response } from 'express';
import {
  config,
  addSmartWallet,
  upsertSmartWallet,
  removeSmartWallet,
  clearAllSmartWallets,
  toggleSmartWallet,
  setMode,
  updateTradeConfig,
  updateFilterConfig,
  updateStrategyConfig,
  updateSelectiveConfig,
  updatePaperConfig,
  persistUserSettings,
  persistWallets,
  getConfigSnapshot,
  applyRiskLevel,
  getRiskLevelSummary,
  RISK_LEVEL_PRESETS,
  OFF_RISK_WARNING,
  normalizeRiskLevel,
  isRiskLevel,
  isTradingMode,
  usesPaperAccounting,
  forcesLiveMarketData,
  setActiveTradingWallet,
  addTradingWallet,
  removeTradingWallet,
  getActiveTradingWallet,
  resetToDefaults,
  TradingMode,
  RiskLevel,
} from './config';
import { performanceScoreFromStats } from './performanceScore';
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
import { getPersistenceStatus } from './dataDir';
import {
  ensureDashboardResetTimerForBuild,
  getLastDashboardResetAt,
  markDashboardReset,
} from './dashboardState';
import { paperTrader } from './paperTrader';
import { updateProfitStrategyConfig } from './profitStrategy';
import {
  getRecentActivity,
  getRecentSignals,
  getMonitorStatus,
  getScannerFeed,
  getScannerStatus,
  getLaneDecisionLog,
  getWalletsWithActivity,
  pauseMonitor,
  resumeMonitor,
  isMonitorPaused,
  refreshAllWalletActivity,
  filterActiveWallets,
  clearMonitorRiskHalt,
  clearTradedMints,
  recoverDisabledWallets,
  syncWalletsToMonitoring,
  forceRefreshMonitoring,
  pruneInactiveWallets,
  refreshWalletActivity,
  pruneLowQualityWallets,
  refreshAllWalletQualityScores,
  resetSkipReasonCounts,
  resetMonitorSession,
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
  getNansenStatus,
  discoverNansenSmartWallets,
  enrichNansenWalletsWithPnl,
  importNansenWalletList,
  getCachedNansenWallets,
  clearNansenCache,
  nansenWalletsToCsv,
  parseNansenCsv,
  parseNansenJson,
  importNansenToTracked,
  NANSEN_FILTER_PRESETS,
  type NansenSmartMoneyLabel,
} from './nansen';
import {
  getMigrationStatus,
  getRecentMigrations,
} from './migrationListener';
import {
  findSmartWallets,
  getDiscoveryStatus,
  clearDiscoveryCache,
  importFavouritesSmartWallets,
  FAVOURITES_DISCOVER_PRESET,
  type DiscoverySource,
} from './walletDiscovery';
import { getSolanaTrackerStatus } from './solanaTracker';
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
import { getAppVersion } from './version';

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
  // Site-backup restore posts the full snapshot (~1MB+); default 100kb is too small.
  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: true, limit: '25mb' }));
  // Browser-served alert assets are kept in the repository so Render deploys them
  // alongside the dashboard instead of depending on a local machine path.
  app.use(
    '/sounds',
    express.static(path.join(process.cwd(), 'public', 'sounds'), {
      immutable: true,
      maxAge: '1y',
    })
  );
  // Bot Info lifecycle hero + future chapter images (repo-served for cloud deploys).
  app.use(
    '/botinfo',
    express.static(path.join(process.cwd(), 'public', 'botinfo'), {
      immutable: true,
      maxAge: '7d',
    })
  );

  const bootedAt = Date.now();

  /**
   * Cloud / load-balancer health check — always 200 when the process is up.
   * Used by Render, etc. Response: { status: "ok", uptime }
   */
  app.get('/health', (_req: Request, res: Response) => {
    const app = getAppVersion();
    res.status(200).json({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      version: app.version,
      updatedAt: app.updatedAt,
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
    const active = getActiveTradingWallet();
    const pubkey = getWalletPublicKey();
    let liveTradingReady = null;
    let liveWalletConnected = true;
    let liveWalletMeta: {
      connected: boolean;
      publicKey: string | null;
      walletName: string | null;
      walletId: string | null;
      lastBalances: {
        availableSol: number;
        equitySol: number;
        positionsValueSol: number;
        at: number;
      } | null;
    } | null = null;
    if (config.mode === 'live') {
      try {
        const {
          assertLiveTradingReady,
          getConnectedLiveWalletMeta,
          isLiveWalletConnected,
        } = require('./liveWalletHistory') as typeof import('./liveWalletHistory');
        liveTradingReady = await assertLiveTradingReady('live');
        liveWalletConnected = isLiveWalletConnected();
        liveWalletMeta = getConnectedLiveWalletMeta();
      } catch {
        liveTradingReady = null;
        liveWalletConnected = false;
      }
    }
    const liveBalance =
      config.mode === 'live' && liveWalletConnected
        ? await getLiveBalanceSol()
        : null;
    const paperStats = paperTrader.getStats();
    const liveSimScore = usesPaperAccounting()
      ? performanceScoreFromStats(paperStats)
      : null;

    const { marketSessionPublic } = require('./marketSession') as typeof import('./marketSession');

    const zeroPortfolio = {
      availableBalanceSol: 0,
      positionsValueSol: 0,
      positionsCostSol: 0,
      unrealizedPnlSol: 0,
      realizedPnlSol: 0,
      totalEquitySol: 0,
      openCount: 0,
      markedCount: 0,
      startingBalanceSol: 0,
      returnPct: 0,
    };

    const liveNeedsImport = config.mode === 'live' && !liveWalletConnected;
    if (
      config.mode === 'live' &&
      liveWalletConnected &&
      !liveNeedsImport
    ) {
      try {
        paperTrader.syncLiveWalletSessionOverlay();
      } catch {
        /* overlay sync best-effort */
      }
    }
    const availableBalance = liveNeedsImport
      ? 0
      : usesPaperAccounting()
        ? paperTrader.getBalance()
        : liveBalance;
    const portfolio = liveNeedsImport
      ? zeroPortfolio
      : paperTrader.getPortfolioSummary(
          usesPaperAccounting() ? null : liveBalance
        );

    let solUsd: number | null = null;
    try {
      const { getCachedSolUsdPrice } =
        require('./marketData') as typeof import('./marketData');
      const px = getCachedSolUsdPrice();
      solUsd = Number.isFinite(px) && px > 0 ? px : null;
    } catch {
      solUsd = null;
    }

    const zeroedStats = liveNeedsImport
      ? {
          ...paperStats,
          totalTrades: 0,
          closedTrades: 0,
          openTrades: 0,
          openCount: 0,
          winRatePct: 0,
          wins: 0,
          losses: 0,
          netPnlSol: 0,
          dailyPnlSol: 0,
          lifetimeClosed: 0,
          lifetimeWins: 0,
          lifetimeLosses: 0,
          sessionClosed: 0,
          profitFactor: 0,
          maxDrawdownPct: 0,
          avgHoldSec: 0,
          balanceSol: 0,
          bestTrade: null,
          worstTrade: null,
        }
      : paperStats;

    res.json({
      mode: config.mode,
      modeLabel:
        config.mode === 'liveSimulation'
          ? 'LIVE SIM'
          : config.mode === 'live'
            ? 'LIVE'
            : 'PAPER',
      usesRealFunds: config.mode === 'live',
      usesPaperAccounting: usesPaperAccounting(),
      forcesLiveMarketData: forcesLiveMarketData(),
      monitor,
      app: getAppVersion(),
      marketSession: marketSessionPublic(),
      /** Available cash (not in open trades) — Paper/Live Sim ledger or live wallet */
      balance: availableBalance,
      equity: portfolio.totalEquitySol,
      portfolio,
      /** Cached SOL/USD for overview equity USD hints */
      solUsd,
      winRate: liveNeedsImport ? 0 : paperTrader.getWinRatePct(),
      stats: zeroedStats,
      soak: paperTrader.getSoakMetrics(),
      performanceScore: liveSimScore,
      // Charts live on /paper-status only — avoid duplicating ~40KB every 5s
      charts: null,
      rpc: getRpcStats(),
      jito: getJitoStatus(),
      mev: getMevStatus(),
      gmgn: getGmgnStatus(),
      persistence: getPersistenceStatus(),
      tradingWallet: active
        ? {
            id: active.id,
            name: active.name,
            role: active.role,
            envVar: active.envVar,
            publicKey: pubkey?.toBase58() ?? null,
          }
        : null,
      liveBalance: liveNeedsImport ? null : liveBalance,
      liveTradingReady,
      liveWalletConnected: config.mode === 'live' ? liveWalletConnected : true,
      liveWallet: liveWalletMeta,
      sessionImport: liveNeedsImport
        ? { source: null, at: 0, count: 0, openCount: 0 }
        : paperTrader.getSessionImportMeta(),
      lastDashboardResetAt: getLastDashboardResetAt(),
      /** When live && !connected, clients must not paint paper/sim lists */
      liveWalletEmpty: liveNeedsImport,
      learning: {
        includeLiveModeEpisodes:
          config.learning?.includeLiveModeEpisodes === true,
      },
      fastProfileRecovery: (() => {
        try {
          const { getFastRecoveryUiHints } =
            require('./fastProfileRecovery') as typeof import('./fastProfileRecovery');
          return getFastRecoveryUiHints();
        } catch {
          return { groupEnabled: false, byProfile: {} };
        }
      })(),
      dipBuyerRecovery: (() => {
        try {
          const { getDipBuyerRecoveryUiHints } =
            require('./dipBuyerRecovery') as typeof import('./dipBuyerRecovery');
          return getDipBuyerRecoveryUiHints();
        } catch {
          return {
            enabled: false,
            stage: 4,
            stageName: 'Normal Operation',
            inRecovery: false,
          };
        }
      })(),
    });
  });

  app.get('/api/persistence', (_req: Request, res: Response) => {
    res.json(getPersistenceStatus());
  });

  app.get('/api/site-backup/latest', (_req: Request, res: Response) => {
    try {
      const { getLatestSiteBackupMeta } =
        require('./siteBackup') as typeof import('./siteBackup');
      res.json({ ok: true, ...getLatestSiteBackupMeta() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/site-backup/download-latest', (_req: Request, res: Response) => {
    try {
      const { loadLatestSiteBackup, stampFilename } = (() => {
        const m = require('./siteBackup') as typeof import('./siteBackup');
        return {
          loadLatestSiteBackup: m.loadLatestSiteBackup,
          stampFilename: (ms: number) => {
            const d = new Date(ms);
            const p = (n: number) => String(n).padStart(2, '0');
            return (
              `site-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
              `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`
            );
          },
        };
      })();
      const backup = loadLatestSiteBackup();
      if (!backup) {
        res.status(404).json({ ok: false, error: 'No latest backup on server' });
        return;
      }
      const filename = stampFilename(backup.exportedAtMs || Date.now());
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`
      );
      res.send(JSON.stringify(backup, null, 2));
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/site-backup', (_req: Request, res: Response) => {
    try {
      const { createAndSaveSiteBackup } =
        require('./siteBackup') as typeof import('./siteBackup');
      const result = createAndSaveSiteBackup();
      res.json({
        ok: true,
        filename: result.filename,
        backup: result.backup,
        meta: result.meta,
        persistence: result.persistence,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/site-backup/restore', (req: Request, res: Response) => {
    try {
      const {
        restoreSiteBackup,
        isValidSiteBackup,
        getLatestSiteBackupMeta,
      } = require('./siteBackup') as typeof import('./siteBackup');
      const body = (req.body ?? {}) as { backup?: unknown } & Record<string, unknown>;
      let result;
      // Accept either { backup: {...} } or the site-backup object at the root.
      const payload =
        body.backup != null
          ? body.backup
          : body.kind === 'site-backup'
            ? body
            : null;
      if (payload != null) {
        if (!isValidSiteBackup(payload)) {
          res.status(400).json({
            ok: false,
            error: 'Invalid backup payload (need kind=site-backup version=1)',
          });
          return;
        }
        result = restoreSiteBackup(payload as import('./siteBackup').SiteBackup);
      } else {
        result = restoreSiteBackup('latest');
      }
      res.json({
        ok: true,
        written: result.written,
        exportedAt: result.exportedAt,
        fileCount: result.fileCount,
        meta: getLatestSiteBackupMeta(),
        persistence: getPersistenceStatus(),
        config: getConfigSnapshot(),
        wallets: getWalletsWithActivity(),
        message: `Restored backup ${result.exportedAt} (${result.fileCount} files)`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const tooLarge =
        /entity too large|request entity too large|payload too large/i.test(msg);
      res.status(tooLarge ? 413 : 400).json({
        ok: false,
        error: tooLarge
          ? 'Backup file too large for server JSON limit — raise limit or use a smaller export'
          : msg,
      });
    }
  });

  /**
   * Restore from an uploaded site-backup JSON (body = backup object, or { backup }).
   * Uses the global 25mb JSON limit so ~1MB+ downloads succeed.
   */
  app.post('/api/site-backup/restore-upload', (req: Request, res: Response) => {
    try {
      const {
        restoreSiteBackup,
        isValidSiteBackup,
        getLatestSiteBackupMeta,
      } = require('./siteBackup') as typeof import('./siteBackup');
      const body = req.body as unknown;
      let payload: unknown = null;
      if (Buffer.isBuffer(body)) {
        try {
          payload = JSON.parse(body.toString('utf8'));
        } catch {
          res.status(400).json({ ok: false, error: 'Upload is not valid JSON' });
          return;
        }
      } else if (typeof body === 'string') {
        try {
          payload = JSON.parse(body);
        } catch {
          res.status(400).json({ ok: false, error: 'Upload is not valid JSON' });
          return;
        }
      } else if (body && typeof body === 'object') {
        const obj = body as { backup?: unknown; kind?: string };
        payload = obj.backup != null ? obj.backup : obj;
      }
      if (!isValidSiteBackup(payload)) {
        res.status(400).json({
          ok: false,
          error: 'Invalid backup payload (need kind=site-backup version=1)',
        });
        return;
      }
      const result = restoreSiteBackup(
        payload as import('./siteBackup').SiteBackup
      );
      res.json({
        ok: true,
        written: result.written,
        exportedAt: result.exportedAt,
        fileCount: result.fileCount,
        meta: getLatestSiteBackupMeta(),
        persistence: getPersistenceStatus(),
        config: getConfigSnapshot(),
        wallets: getWalletsWithActivity(),
        message: `Restored backup ${result.exportedAt} (${result.fileCount} files)`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const tooLarge =
        /entity too large|request entity too large|payload too large/i.test(msg);
      res.status(tooLarge ? 413 : 400).json({
        ok: false,
        error: tooLarge
          ? 'Backup file too large for server upload limit (25mb)'
          : msg,
      });
    }
  });

  // ── GitHub remote site backup (optional) ─────────────────────────────────
  app.get('/api/site-backup/github/status', (_req: Request, res: Response) => {
    try {
      const { getGithubBackupStatus, ensureGithubBackupSettingsFile } =
        require('./githubSiteBackup') as typeof import('./githubSiteBackup');
      ensureGithubBackupSettingsFile();
      res.json({ ok: true, ...getGithubBackupStatus() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/site-backup/github/settings', (req: Request, res: Response) => {
    try {
      const { updateGithubBackupSettings, GITHUB_BACKUP_INTERVALS } =
        require('./githubSiteBackup') as typeof import('./githubSiteBackup');
      const body = (req.body ?? {}) as {
        interval?: string;
        owner?: string;
        repo?: string;
        path?: string;
        autoImportOnBoot?: boolean;
      };
      if (
        body.interval != null &&
        !GITHUB_BACKUP_INTERVALS.includes(
          body.interval as (typeof GITHUB_BACKUP_INTERVALS)[number]
        )
      ) {
        res.status(400).json({
          ok: false,
          error: `interval must be one of: ${GITHUB_BACKUP_INTERVALS.join(', ')}`,
        });
        return;
      }
      const status = updateGithubBackupSettings({
        interval: body.interval,
        owner: body.owner,
        repo: body.repo,
        path: body.path,
        autoImportOnBoot:
          body.autoImportOnBoot != null
            ? body.autoImportOnBoot === true
            : undefined,
      });
      res.json({ ok: true, ...status });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/site-backup/github/upload', async (_req: Request, res: Response) => {
    try {
      const { uploadSiteBackupToGithub, getGithubBackupStatus } =
        require('./githubSiteBackup') as typeof import('./githubSiteBackup');
      const result = await uploadSiteBackupToGithub({ reason: 'manual' });
      res.json({
        ...result,
        ok: true,
        status: getGithubBackupStatus(),
        meta: (() => {
          const { getLatestSiteBackupMeta } =
            require('./siteBackup') as typeof import('./siteBackup');
          return getLatestSiteBackupMeta();
        })(),
        message: `Uploaded to GitHub (${result.bytes} bytes, ${result.fileCount} files)`,
      });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/site-backup/github/restore', async (_req: Request, res: Response) => {
    try {
      const { restoreSiteBackupFromGithub, getGithubBackupStatus } =
        require('./githubSiteBackup') as typeof import('./githubSiteBackup');
      const { getLatestSiteBackupMeta } =
        require('./siteBackup') as typeof import('./siteBackup');
      const result = await restoreSiteBackupFromGithub();
      res.json({
        ok: true,
        written: result.written,
        exportedAt: result.exportedAt,
        fileCount: result.fileCount,
        path: result.path,
        status: getGithubBackupStatus(),
        meta: getLatestSiteBackupMeta(),
        persistence: getPersistenceStatus(),
        config: getConfigSnapshot(),
        wallets: getWalletsWithActivity(),
        message: `Restored from GitHub ${result.exportedAt} (${result.fileCount} files)`,
      });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/site-backup/bot-perf-email/status', (_req: Request, res: Response) => {
    try {
      const {
        getBotPerfEmailStatus,
        ensureBotPerfEmailSettingsFile,
      } = require('./botPerformanceEmail') as typeof import('./botPerformanceEmail');
      ensureBotPerfEmailSettingsFile();
      res.json({ ok: true, ...getBotPerfEmailStatus() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/site-backup/bot-perf-email/settings', (req: Request, res: Response) => {
    try {
      const {
        updateBotPerfEmailSettings,
        BOT_PERF_EMAIL_INTERVALS,
      } = require('./botPerformanceEmail') as typeof import('./botPerformanceEmail');
      const body = (req.body ?? {}) as {
        enabled?: boolean;
        interval?: string;
        email?: string;
        sendHour?: number;
      };
      if (
        body.interval != null &&
        !BOT_PERF_EMAIL_INTERVALS.includes(
          body.interval as (typeof BOT_PERF_EMAIL_INTERVALS)[number]
        )
      ) {
        res.status(400).json({
          ok: false,
          error: `interval must be one of: ${BOT_PERF_EMAIL_INTERVALS.join(', ')}`,
        });
        return;
      }
      const status = updateBotPerfEmailSettings({
        enabled: body.enabled,
        interval: body.interval,
        email: body.email,
        sendHour: body.sendHour,
      });
      res.json({ ok: true, ...status });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/site-backup/bot-perf-email/send', async (req: Request, res: Response) => {
    try {
      const { sendBotPerformanceEmail } =
        require('./botPerformanceEmail') as typeof import('./botPerformanceEmail');
      const body = (req.body ?? {}) as { email?: string };
      const result = await sendBotPerformanceEmail({
        reason: 'manual',
        to: body.email,
      });
      if (!result.ok) {
        res.status(400).json({
          ok: false,
          error: result.error || 'Send failed',
          status: result.status,
        });
        return;
      }
      res.json({
        ok: true,
        provider: result.provider,
        status: result.status,
        message: `Performance email sent via ${result.provider}`,
        periodLabel: result.report?.periodLabel,
        totals: result.report?.totals,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/microbots/learning-health', (req: Request, res: Response) => {
    try {
      const { getLearningHealthSummary } =
        require('./profileLearningSaveLog') as typeof import('./profileLearningSaveLog');
      const offset = Number(req.query.offset) || 0;
      const limit = Number(req.query.limit) || 10;
      const bot = String(req.query.bot || '').trim();
      const kind = String(req.query.kind || '').trim();
      const date = String(req.query.date || '').trim();
      const q = String(req.query.q || '').trim();
      res.json({
        ok: true,
        ...getLearningHealthSummary({ offset, limit, bot, kind, date, q }),
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/microbots/learning-export', (req: Request, res: Response) => {
    try {
      const { exportLearningBundle } =
        require('./profileLearningSaveLog') as typeof import('./profileLearningSaveLog');
      const format =
        String(req.query.format || 'json').toLowerCase() === 'csv'
          ? 'csv'
          : 'json';
      const bundle = exportLearningBundle(format);
      res.setHeader('Content-Type', bundle.contentType);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${bundle.filename}"`
      );
      res.send(bundle.body);
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/rpc', (_req: Request, res: Response) => {
    try {
      const { getSoftWatchRuntimeSnapshot } =
        require('./monitor') as typeof import('./monitor');
      res.json({
        ...getRpcStats(),
        jito: getJitoStatus(),
        mev: getMevStatus(),
        softWatch: getSoftWatchRuntimeSnapshot(),
      });
    } catch {
      res.json({
        ...getRpcStats(),
        jito: getJitoStatus(),
        mev: getMevStatus(),
      });
    }
  });

  app.post('/api/rpc/share-load', (req: Request, res: Response) => {
    try {
      const { setRpcShareLoad } = require('./config') as typeof import('./config');
      const enabled =
        req.body?.enabled === true ||
        req.body?.enabled === 'true' ||
        req.body?.enabled === 1 ||
        req.body?.shareLoad === true;
      const shareLoad = setRpcShareLoad(enabled);
      let softWatch: unknown = null;
      try {
        const { getSoftWatchRuntimeSnapshot } =
          require('./monitor') as typeof import('./monitor');
        softWatch = getSoftWatchRuntimeSnapshot();
      } catch {
        /* */
      }
      res.json({
        ...getRpcStats(),
        jito: getJitoStatus(),
        mev: getMevStatus(),
        ok: true,
        shareLoad,
        softWatch,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/rpc/soft-watch-cap', (req: Request, res: Response) => {
    try {
      const { setRpcSoftWatchCap } =
        require('./config') as typeof import('./config');
      const { getSoftWatchRuntimeSnapshot } =
        require('./monitor') as typeof import('./monitor');
      const body = (req.body ?? {}) as Record<string, unknown>;
      let next: number | null;
      if (body.softWatchCap === null || body.softWatchCap === '') {
        next = null;
      } else if (body.softWatchCap != null && Number.isFinite(Number(body.softWatchCap))) {
        next = Number(body.softWatchCap);
      } else if (body.cap != null && Number.isFinite(Number(body.cap))) {
        next = Number(body.cap);
      } else {
        next = null;
      }
      const saved = setRpcSoftWatchCap(next);
      const softWatch = getSoftWatchRuntimeSnapshot();
      res.json({
        ok: true,
        softWatchCap: saved,
        softWatch,
        rpc: getRpcStats(),
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/rpc/diagnostic', (_req: Request, res: Response) => {
    try {
      const { getRpcLoadDiagnostic } =
        require('./rpcDiagnostic') as typeof import('./rpcDiagnostic');
      res.json({ ok: true, ...getRpcLoadDiagnostic() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/rpc/diagnostic', (_req: Request, res: Response) => {
    try {
      const { getRpcLoadDiagnostic } =
        require('./rpcDiagnostic') as typeof import('./rpcDiagnostic');
      res.json({ ok: true, ...getRpcLoadDiagnostic() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/rpc/diagnostic/apply', (req: Request, res: Response) => {
    try {
      const { applyRpcDiagnosticPollUpdates } =
        require('./rpcDiagnostic') as typeof import('./rpcDiagnostic');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const raw = Array.isArray(body.updates) ? body.updates : [];
      const updates = raw
        .map((u) => {
          const row = (u || {}) as Record<string, unknown>;
          return {
            target: String(row.target || '') as import('./rpcDiagnostic').RpcDiagTarget,
            pollIntervalMs: Number(row.pollIntervalMs),
          };
        })
        .filter((u) => u.target && Number.isFinite(u.pollIntervalMs));
      const result = applyRpcDiagnosticPollUpdates(updates);
      res.json(result);
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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

  /**
   * Cap + slim closed rows on dashboard polls.
   * Full fat objects (~3–4KB each × 100) were ~275KB every 2–5s and froze the UI.
   */
  const DASHBOARD_CLOSED_LIMIT = 80;

  function slimClosedPositionForDashboard(p: Record<string, unknown>) {
    return {
      id: p.id,
      mint: p.mint,
      symbol: p.symbol,
      name: p.name,
      entryPriceSol: p.entryPriceSol,
      amountTokens: p.amountTokens,
      costSol: p.costSol,
      initialCostSol: p.initialCostSol,
      initialAmountTokens: p.initialAmountTokens,
      openedAt: p.openedAt,
      closedAt: p.closedAt,
      exitPriceSol: p.exitPriceSol,
      pnlSol: p.pnlSol,
      pnlPct: p.pnlPct,
      reason: p.reason,
      status: p.status,
      parentPositionId: p.parentPositionId,
      entryMarketCapUsd: p.entryMarketCapUsd,
      exitMarketCapUsd: p.exitMarketCapUsd,
      impliedExitMarketCapUsd: p.impliedExitMarketCapUsd,
      liveExitMarketCapUsd: p.liveExitMarketCapUsd,
      costUsd: p.costUsd,
      solUsd: p.solUsd,
      sourceNames: p.sourceNames,
      entrySource: p.entrySource,
      entryStyle: p.entryStyle,
      entryStyleSecondary: p.entryStyleSecondary,
      lateChaseAtEntry: p.lateChaseAtEntry,
      entryQualityScore: p.entryQualityScore,
      strategyKind: p.strategyKind,
      tradeProfileId: p.tradeProfileId,
      tradeProfileName: p.tradeProfileName,
      tradeProfileIcon: p.tradeProfileIcon,
      tradeProfileColor: p.tradeProfileColor,
      tradeProfileScore: p.tradeProfileScore,
      tradeProfileReason: p.tradeProfileReason,
      scannerPlaybook: p.scannerPlaybook,
      realizedPnlSol: p.realizedPnlSol,
      maxRunupPct: p.maxRunupPct,
      maxDrawdownPct: p.maxDrawdownPct,
    };
  }

  function dashboardClosedSlice() {
    const closedAll = paperTrader.getClosedPositions();
    return {
      closed: closedAll
        .slice(-DASHBOARD_CLOSED_LIMIT)
        .map((p) => slimClosedPositionForDashboard(p as unknown as Record<string, unknown>)),
      closedTotal: closedAll.length,
    };
  }

  /** Paper trading status + Chart.js data */
  app.get('/paper-status', (_req: Request, res: Response) => {
    const stats = paperTrader.getStats();
    const charts = paperTrader.getChartData({ lite: true });
    const portfolio = paperTrader.getPortfolioSummary();
    const closedMeta = dashboardClosedSlice();
    res.json({
      mode: config.mode,
      balance: paperTrader.getBalance(),
      equity: portfolio.totalEquitySol,
      portfolio,
      stats,
      charts,
      useLiveData: config.paper.useLiveData,
      open: paperTrader.getOpenPositions(),
      // Closed list comes from /api/positions — omit duplicate ~fat array here
      closed: [],
      closedTotal: closedMeta.closedTotal,
      logs: paperTrader.getLogs(50),
    });
  });

  app.get('/api/paper-status', (_req: Request, res: Response) => {
    const stats = paperTrader.getStats();
    const charts = paperTrader.getChartData({ lite: true });
    const portfolio = paperTrader.getPortfolioSummary();
    const closedMeta = dashboardClosedSlice();
    res.json({
      mode: config.mode,
      balance: paperTrader.getBalance(),
      equity: portfolio.totalEquitySol,
      portfolio,
      stats,
      charts,
      useLiveData: config.paper.useLiveData,
      open: paperTrader.getOpenPositions(),
      closed: [],
      closedTotal: closedMeta.closedTotal,
      logs: paperTrader.getLogs(50),
    });
  });

  /** Overview strip stats for a time window (Now / 1h / 24h / 7d / 30d / all). */
  app.get('/api/overview-stats', (req: Request, res: Response) => {
    try {
      const {
        buildOverviewWindowStats,
        parseOverviewStatsWindow,
      } = require('./microBotPerformance') as typeof import('./microBotPerformance');
      const { getTradeProfilesStatus } =
        require('./tradeProfiles') as typeof import('./tradeProfiles');
      const window = parseOverviewStatsWindow(req.query.window, 'all');

      // Live mode without connected wallet: never paint Paper/Sim session stats
      if (config.mode === 'live') {
        try {
          const { isLiveWalletConnected } =
            require('./liveWalletHistory') as typeof import('./liveWalletHistory');
          if (!isLiveWalletConnected()) {
            const empty = buildOverviewWindowStats({
              closed: [],
              openCount: 0,
              window: window === 'now' ? 'now' : window,
              catalogIds: [],
              episodesByProfile: new Map(),
              lifetime: null,
            });
            return res.json({ ok: true, overview: empty, liveWalletEmpty: true });
          }
        } catch {
          /* fall through to normal stats */
        }
      }

      const stats = paperTrader.getStats();
      const closed = paperTrader.getClosedPositions();
      const open = paperTrader.getOpenPositions();
      let solUsd: number | null = null;
      try {
        const { getCachedSolUsdPrice } =
          require('./marketData') as typeof import('./marketData');
        const px = getCachedSolUsdPrice();
        solUsd = Number.isFinite(px) && px > 0 ? px : null;
      } catch {
        solUsd = null;
      }
      let catalogIds: string[] = [];
      try {
        const tp = getTradeProfilesStatus();
        catalogIds = (tp.profiles || [])
          .map((p: { id?: string }) => String(p.id || ''))
          .filter(Boolean);
      } catch {
        catalogIds = [];
      }
      const overview = buildOverviewWindowStats({
        closed,
        openCount: open.length,
        window,
        solUsd,
        catalogIds,
        lifetime:
          window === 'now'
            ? null
            : {
                closed: Number(stats.lifetimeClosed) || Number(stats.closedTrades) || 0,
                wins: Number(stats.lifetimeWins) || Number(stats.wins) || 0,
                losses: Number(stats.lifetimeLosses) || Number(stats.losses) || 0,
              },
      });
      res.json({ ok: true, overview });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * Import closed + open trades for the selected Overview stats window into
   * the session overlay. Cap 1000 closed. Cleared by Overview Reset.
   */
  app.post('/api/overview/import-trades', (req: Request, res: Response) => {
    try {
      const { collectOverviewWindowTrades } =
        require('./overviewTradeImport') as typeof import('./overviewTradeImport');
      const { parseOverviewStatsWindow } =
        require('./microBotPerformance') as typeof import('./microBotPerformance');
      const { getTradeProfilesStatus } =
        require('./tradeProfiles') as typeof import('./tradeProfiles');
      const { loadLiveWalletHistory } =
        require('./liveWalletHistory') as typeof import('./liveWalletHistory');
      const window = parseOverviewStatsWindow(
        req.body?.window ?? req.query.window,
        'all'
      );
      if (window === 'now') {
        return res.status(400).json({
          ok: false,
          error:
            'Import trades is not available for Now — switch to 1h/24h/7d/30d/All',
        });
      }
      let catalogIds: string[] = [];
      try {
        const tp = getTradeProfilesStatus();
        catalogIds = (tp.profiles || [])
          .map((p: { id?: string }) => String(p.id || ''))
          .filter(Boolean);
      } catch {
        catalogIds = [];
      }
      let solUsd: number | null = null;
      try {
        const { getCachedSolUsdPrice } =
          require('./marketData') as typeof import('./marketData');
        const px = getCachedSolUsdPrice();
        solUsd = Number.isFinite(px) && px > 0 ? px : null;
      } catch {
        solUsd = null;
      }
      let extraClosed: ReturnType<typeof paperTrader.getDurableClosedPositions> =
        [];
      if (config.mode === 'live') {
        const hist = loadLiveWalletHistory();
        const pk = hist.connectedPubkey;
        extraClosed = pk && hist.byWallet[pk]?.closed
          ? hist.byWallet[pk]!.closed
          : [];
      }
      // Use durable rings before session overlay for re-import source
      const closedSrc = [
        ...paperTrader.getDurableClosedPositions(),
        ...extraClosed,
      ];
      const collected = collectOverviewWindowTrades({
        closed: closedSrc,
        open: paperTrader.getDurableOpenPositions(),
        window,
        catalogIds,
        solUsd,
        extraClosed,
      });
      const applied = paperTrader.importSessionOverlay({
        closed: collected.closed,
        opens: collected.opens,
        meta: { source: 'window', window: collected.window },
      });
      const overview = (() => {
        const {
          buildOverviewWindowStats,
        } = require('./microBotPerformance') as typeof import('./microBotPerformance');
        const stats = paperTrader.getStats();
        return buildOverviewWindowStats({
          closed: paperTrader.getClosedPositions(),
          openCount: paperTrader.getOpenPositions().length,
          window: collected.window,
          solUsd,
          catalogIds,
          lifetime: {
            closed: Number(stats.lifetimeClosed) || 0,
            wins: Number(stats.lifetimeWins) || 0,
            losses: Number(stats.lifetimeLosses) || 0,
          },
        });
      })();
      res.json({
        ok: true,
        window: collected.window,
        importedClosed: collected.importedClosed,
        openInWindow: collected.openInWindow,
        capped: collected.capped,
        openHints: collected.openHints,
        imported: applied.imported,
        importedOpen: applied.importedOpen,
        overview,
        sessionImport: paperTrader.getSessionImportMeta(),
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** Import system live trades + on-chain balances for active Live wallet. */
  app.post('/api/live/import-wallet-history', async (_req: Request, res: Response) => {
    try {
      if (config.mode !== 'live') {
        res.status(400).json({
          ok: false,
          error: 'Import Live Wallet is only available in Live mode',
        });
        return;
      }
      const { importLiveWalletTradeHistory, assertLiveTradingReady } =
        require('./liveWalletHistory') as typeof import('./liveWalletHistory');
      await assertLiveTradingReady('live');
      const result = await importLiveWalletTradeHistory(paperTrader);
      if (!result.ok) {
        res.status(400).json(result);
        return;
      }
      paperTrader.importSessionOverlay({
        closed: result.closed,
        opens: result.opens,
        meta: { source: 'live_wallet', window: 'all' },
      });
      res.json({
        ok: true,
        imported: result.imported,
        importedOpen: result.importedOpen,
        scannedSigs: result.scannedSigs,
        walletPubkey: result.walletPubkey,
        walletName: result.walletName,
        walletId: result.walletId,
        balances: result.balances,
        noSystemTrades: result.noSystemTrades,
        message: result.message,
        sessionImport: paperTrader.getSessionImportMeta(),
        liveWalletConnected: true,
        overviewHint: result.noSystemTrades
          ? result.message
          : 'Imported live wallet system trades into session',
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** Disconnect live wallet from Overview (keeps per-address history on disk). */
  app.post('/api/live/disconnect-wallet', (_req: Request, res: Response) => {
    try {
      const { disconnectLiveWallet } =
        require('./liveWalletHistory') as typeof import('./liveWalletHistory');
      const result = disconnectLiveWallet();
      paperTrader.clearSessionImportedTrades();
      res.json({
        ...result,
        liveWalletConnected: false,
        sessionImport: paperTrader.getSessionImportMeta(),
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
        riskLevel?: 'on' | 'off' | 'current';
        compareRiskLevels?: boolean;
        useSavedConfigFilters?: boolean;
        minConvictionScore?: number;
        minWalletQualityScore?: number;
        /** Live-Sim parity (default true). Synthetic / multi-sim are Advanced. */
        parityMode?: boolean;
      };

      const { runBacktest } = await import('./backtest');

      const result = await runBacktest({
        hours: body.hours != null ? Number(body.hours) : undefined,
        fromMs: body.fromMs != null ? Number(body.fromMs) : undefined,
        toMs: body.toMs != null ? Number(body.toMs) : undefined,
        maxTrades: body.maxTrades != null ? Number(body.maxTrades) : 25,
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
        minConvictionScore:
          body.minConvictionScore != null
            ? Number(body.minConvictionScore)
            : undefined,
        minWalletQualityScore:
          body.minWalletQualityScore != null
            ? Number(body.minWalletQualityScore)
            : undefined,
        useLiveData:
          body.useLiveData !== undefined
            ? Boolean(body.useLiveData)
            : config.paper.useLiveData || config.mode === 'liveSimulation',
        // Parity default: synthetic off unless Advanced checkbox explicitly on
        allowSynthetic: body.allowSynthetic === true,
        parityMode: body.parityMode !== false,
        startingBalanceSol:
          body.startingBalanceSol != null
            ? Number(body.startingBalanceSol)
            : undefined,
        riskLevel: body.riskLevel ?? 'current',
        compareRiskLevels: Boolean(body.compareRiskLevels),
        useSavedConfigFilters: body.useSavedConfigFilters !== false,
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
      const riskQ = String(req.query.riskLevel || 'current').toLowerCase();
      const result = await runBacktest({
        hours,
        useLiveData,
        migrationsOnly,
        pumpFunOnly:
          req.query.pumpFunOnly === '1' || req.query.pumpFunOnly === 'true',
        reBuyEnabled:
          req.query.reBuy === '1' || req.query.reBuy === 'true',
        minVolumeUsd: Number(req.query.minVolume) || 0,
        maxTrades: Number(req.query.maxTrades) || 25,
        simulations: Number(req.query.simulations) || 1,
        strategyType: (req.query.strategy as
          | 'convergence'
          | 'migration'
          | 'single'
          | 'auto') || undefined,
        minLiquidityUsd: Number(req.query.minLiquidity) || 0,
        minMarketCapUsd: Number(req.query.minMc) || 0,
        maxRiskScore: Number(req.query.maxRisk) || 0,
        allowSynthetic: req.query.synthetic === '1' || req.query.synthetic === 'true',
        parityMode: req.query.parity !== '0',
        riskLevel: isRiskLevel(riskQ) ? riskQ : 'current',
        compareRiskLevels:
          req.query.compareRisk === '1' || req.query.compareRisk === 'true',
        useSavedConfigFilters: req.query.useSaved !== '0',
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

  /** Analyze last backtest losers and score one-knob counterfactuals */
  app.post('/backtest/advise', async (req: Request, res: Response) => {
    try {
      const { getLastBacktest } = await import('./backtest');
      const {
        analyzeBacktest,
        scoreRecommendations,
        getLastAdvisor,
      } = await import('./backtestAdvisor');
      const last = getLastBacktest();
      if (!last || !(last.trades || []).length) {
        res.status(404).json({
          ok: false,
          error: 'Run a backtest first (need closed trades to analyze)',
        });
        return;
      }
      const body = (req.body ?? {}) as {
        score?: boolean;
        maxScore?: number;
      };
      analyzeBacktest(last);
      const score = body.score !== false;
      const report = score
        ? await scoreRecommendations(last, undefined, {
            maxScore: body.maxScore != null ? Number(body.maxScore) : 6,
          })
        : getLastAdvisor();
      res.json({ ok: true, advisor: report, baselineId: last.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[backtest/advise]', message);
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.get('/backtest/advise', async (_req: Request, res: Response) => {
    const { getLastAdvisor } = await import('./backtestAdvisor');
    const advisor = getLastAdvisor();
    if (!advisor) {
      res.status(404).json({ ok: false, error: 'No advisor report yet' });
      return;
    }
    res.json({ ok: true, advisor });
  });

  /** Re-run last window with selected recommendation overlays merged */
  app.post('/backtest/advise/rerun', async (req: Request, res: Response) => {
    try {
      const { getLastBacktest, runBacktest } = await import('./backtest');
      const {
        getRecommendationsByIds,
        buildRerunOptionsFromRecommendations,
        analyzeBacktest,
      } = await import('./backtestAdvisor');
      const last = getLastBacktest();
      if (!last) {
        res.status(404).json({ ok: false, error: 'No backtest to re-run from' });
        return;
      }
      const body = (req.body ?? {}) as { recommendationIds?: string[] };
      const ids = Array.isArray(body.recommendationIds)
        ? body.recommendationIds.map(String)
        : [];
      if (!ids.length) {
        res.status(400).json({ ok: false, error: 'Select at least one recommendation' });
        return;
      }
      const recs = getRecommendationsByIds(ids);
      if (!recs.length) {
        res.status(400).json({
          ok: false,
          error: 'Unknown recommendation ids — run Analyze first',
        });
        return;
      }
      const opts = buildRerunOptionsFromRecommendations(last, ids);
      const result = await runBacktest(opts);
      const baseline = {
        winRatePct: last.summary?.winRatePct ?? 0,
        profitFactor: last.summary?.profitFactor ?? 0,
        totalPnlSol: last.summary?.totalPnlSol ?? 0,
        trades: last.tradesExecuted ?? last.trades?.length ?? 0,
      };
      const candidate = {
        winRatePct: result.summary?.winRatePct ?? 0,
        profitFactor: result.summary?.profitFactor ?? 0,
        totalPnlSol: result.summary?.totalPnlSol ?? 0,
        trades: result.tradesExecuted ?? result.trades?.length ?? 0,
      };
      // Refresh advisor clusters on the new result (unscored tips for next pass)
      const advisor = analyzeBacktest(result);
      res.json({
        ok: true,
        result,
        advisor,
        comparison: {
          baseline,
          candidate,
          delta: {
            winRatePct: candidate.winRatePct - baseline.winRatePct,
            profitFactor: candidate.profitFactor - baseline.profitFactor,
            totalPnlSol: candidate.totalPnlSol - baseline.totalPnlSol,
            trades: candidate.trades - baseline.trades,
          },
          appliedIds: ids,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[backtest/advise/rerun]', message);
      res.status(500).json({ ok: false, error: message });
    }
  });

  /** Persist selected recommendations to live Strategies / filters / profiles */
  app.post('/backtest/advise/apply', async (req: Request, res: Response) => {
    try {
      const { applyRecommendationsToLive } = await import('./backtestAdvisor');
      const { getStrategiesStatus } = await import('./strategies');
      const { getTradeProfilesStatus } = await import('./tradeProfiles');
      const body = (req.body ?? {}) as { recommendationIds?: string[] };
      const ids = Array.isArray(body.recommendationIds)
        ? body.recommendationIds.map(String)
        : [];
      if (!ids.length) {
        res.status(400).json({ ok: false, error: 'Select at least one recommendation' });
        return;
      }
      const applied = applyRecommendationsToLive(ids);
      if (!applied.ok) {
        res.status(400).json(applied);
        return;
      }
      res.json({
        ...applied,
        strategies: getStrategiesStatus(),
        tradeProfiles: getTradeProfilesStatus(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[backtest/advise/apply]', message);
      res.status(500).json({ ok: false, error: message });
    }
  });

  /** Risk Recipe Optimizer — bounded search for Risk On overlays */
  app.post('/backtest/optimize', async (req: Request, res: Response) => {
    try {
      const {
        runRiskRecipeOptimizer,
        getOptimizerProgress,
      } = await import('./backtestOptimizer');
      const prog = getOptimizerProgress();
      if (prog.running) {
        res.status(409).json({
          ok: false,
          error: 'Optimizer already running',
          progress: prog,
        });
        return;
      }
      const body = (req.body ?? {}) as {
        hours?: number;
        fromMs?: number;
        toMs?: number;
        risks?: string[];
        maxCandidatesPerRisk?: number;
        /** Alias used by dashboard UI */
        maxCandidates?: number;
        useLastBacktestWindow?: boolean;
      };
      const risks = Array.isArray(body.risks)
        ? body.risks
            .map((r) => normalizeRiskLevel(r))
            .filter((r): r is 'on' => r === 'on')
        : undefined;
      const maxCandidatesPerRisk =
        body.maxCandidatesPerRisk != null
          ? Number(body.maxCandidatesPerRisk)
          : body.maxCandidates != null
            ? Number(body.maxCandidates)
            : 16;
      // Async kick so UI can poll progress (long-running)
      void runRiskRecipeOptimizer({
        hours: body.hours != null ? Number(body.hours) : undefined,
        fromMs: body.fromMs != null ? Number(body.fromMs) : undefined,
        toMs: body.toMs != null ? Number(body.toMs) : undefined,
        risks,
        maxCandidatesPerRisk,
        useLastBacktestWindow: body.useLastBacktestWindow !== false,
      }).catch((err) => {
        console.error(
          '[backtest/optimize]',
          err instanceof Error ? err.message : err
        );
      });
      res.json({
        ok: true,
        started: true,
        progress: getOptimizerProgress(),
        message:
          'Optimizer started — poll GET /backtest/optimize/progress then /last',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[backtest/optimize]', message);
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.get('/backtest/optimize/progress', async (_req: Request, res: Response) => {
    const { getOptimizerProgress } = await import('./backtestOptimizer');
    res.json(getOptimizerProgress());
  });

  app.post('/backtest/optimize/stop', async (_req: Request, res: Response) => {
    const {
      requestOptimizerStop,
      getOptimizerProgress,
    } = await import('./backtestOptimizer');
    const result = requestOptimizerStop();
    res.json({
      ok: result.ok,
      message: result.message,
      ...(result.ok ? {} : { error: result.message }),
      progress: getOptimizerProgress(),
    });
  });

  app.get('/backtest/optimize/last', async (_req: Request, res: Response) => {
    const {
      getLastOptimizer,
      loadOptimizerFromDisk,
    } = await import('./backtestOptimizer');
    const report = getLastOptimizer() || loadOptimizerFromDisk();
    if (!report) {
      res.status(404).json({ ok: false, error: 'No optimizer report yet' });
      return;
    }
    res.json({ ok: true, optimizer: report });
  });

  app.post('/backtest/optimize/apply', async (req: Request, res: Response) => {
    try {
      const { applyOptimizerWinnersToRecipes } = await import(
        './backtestOptimizer'
      );
      const { getStrategiesStatus } = await import('./strategies');
      const body = (req.body ?? {}) as {
        selections?: Array<{ riskLevel?: string; candidateId?: string }>;
        /** When true, apply each risk's winnerId automatically */
        applyWinners?: boolean;
      };
      let selections: Array<{
        riskLevel: 'on';
        candidateId: string;
      }> = [];

      if (body.applyWinners) {
        const {
          getLastOptimizer,
          loadOptimizerFromDisk,
        } = await import('./backtestOptimizer');
        const report = getLastOptimizer() || loadOptimizerFromDisk();
        if (!report) {
          res.status(404).json({ ok: false, error: 'No optimizer report' });
          return;
        }
        for (const r of report.risks) {
          if (r.winnerId && normalizeRiskLevel(r.riskLevel) === 'on') {
            selections.push({
              riskLevel: 'on',
              candidateId: r.winnerId,
            });
          }
        }
      } else if (Array.isArray(body.selections)) {
        for (const s of body.selections) {
          const level = normalizeRiskLevel(s.riskLevel);
          if (level === 'on' && s.candidateId) {
            selections.push({
              riskLevel: 'on',
              candidateId: String(s.candidateId),
            });
          }
        }
      }

      if (!selections.length) {
        res.status(400).json({
          ok: false,
          error: 'Provide selections[] or applyWinners: true',
        });
        return;
      }
      const applied = applyOptimizerWinnersToRecipes(selections);
      if (!applied.ok) {
        res.status(400).json(applied);
        return;
      }
      res.json({
        ...applied,
        strategies: getStrategiesStatus(),
        riskRecipeOptimizations: (
          await import('./config')
        ).config.riskRecipeOptimizations,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[backtest/optimize/apply]', message);
      res.status(500).json({ ok: false, error: message });
    }
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

  app.get('/backtest/export.json', async (_req: Request, res: Response) => {
    const { exportLastBacktestJson, getLastBacktest } = await import(
      './backtest'
    );
    const json = exportLastBacktestJson();
    if (!json) {
      res.status(404).json({ ok: false, error: 'No backtest to export' });
      return;
    }
    const id = getLastBacktest()?.id ?? 'backtest';
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${id}-report.json"`
    );
    res.send(json);
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
    clearTradedMints();
    res.json({
      ok: true,
      ...result,
      startingBalanceSol: config.paper.startingBalanceSol,
      stats: paperTrader.getStats(),
      open: paperTrader.getOpenPositions(),
      closed: paperTrader.getClosedPositions(),
    });
  });

  /**
   * Clear closed trades from the session view only.
   * Does not wipe learning episodes, open positions, or balance.
   */
  app.post('/api/paper/clear-closed', (_req: Request, res: Response) => {
    const result = paperTrader.clearClosedHistory();
    res.json({
      ok: true,
      cleared: result.cleared,
      closed: [],
      stats: paperTrader.getStats(),
    });
  });

  /**
   * Full Overview session reset for module A/B tests:
   * balance, equity, open/closed trades, logs, signals, skip tallies, trade-rate,
   * scanner mint cooldowns / feed, buy-queue backlog, poll 429 pause.
   * Clears risk halt and resumes the monitor so Halt→Reset does not leave
   * scanning paused (deploy starts unpaused; Reset must match).
   * Does not change risk level or strategy modules.
   */
  app.post('/api/dashboard/reset', (_req: Request, res: Response) => {
    const paper = paperTrader.reset({ clearHistory: true });
    const monitor = resetMonitorSession();
    clearRiskHalt();
    clearMonitorRiskHalt();
    // Must run after clearRiskHalt — resumeMonitor refuses while halted.
    if (isMonitorPaused()) {
      resumeMonitor();
    }
    const lastDashboardResetAt = markDashboardReset();
    res.json({
      ok: true,
      paper,
      monitor,
      startingBalanceSol: config.paper.startingBalanceSol,
      balance: paperTrader.getBalance(),
      equity: paperTrader.getEquitySol(),
      stats: paperTrader.getStats(),
      soak: paperTrader.getSoakMetrics(),
      monitorStatus: getMonitorStatus(),
      lastDashboardResetAt,
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

  /** Re-subscribe all tracked wallets to the poll loop */
  app.post('/api/monitor/force-refresh', (_req: Request, res: Response) => {
    const result = forceRefreshMonitoring();
    res.json({
      ...result,
      monitor: getMonitorStatus(),
      wallets: getWalletsWithActivity(),
    });
  });

  app.get('/api/monitor/watching', (_req: Request, res: Response) => {
    const status = getMonitorStatus();
    res.json({
      watching: status.watchedWallets,
      tracked: status.trackedWallets,
      enabled: status.enabledWallets,
      label: status.watchingLabel,
      wallets: status.watchingList,
      running: status.running,
      paused: status.paused,
    });
  });

  app.get('/api/risk', (_req: Request, res: Response) => {
    res.json({
      config: config.risk,
      status: getRiskStatus({
        equitySol: paperTrader.getEquitySol(),
        dailyPnlSol: paperTrader.getDailyPnlSol(),
        weeklyPnlSol: paperTrader.getWeeklyPnlSol(),
      }),
      riskLevel: config.riskLevel,
      riskLevelSummary: getRiskLevelSummary(),
      presets: {
        on: {
          label: RISK_LEVEL_PRESETS.on.label,
          description: RISK_LEVEL_PRESETS.on.description,
        },
        off: {
          label: RISK_LEVEL_PRESETS.off.label,
          description: RISK_LEVEL_PRESETS.off.description,
          warning: OFF_RISK_WARNING,
        },
      },
    });
  });

  app.post('/api/config/risk-level', (req: Request, res: Response) => {
    const level = normalizeRiskLevel(
      String((req.body as { riskLevel?: string }).riskLevel || '')
        .toLowerCase()
        .trim()
    );
    if (!isRiskLevel(level)) {
      res.status(400).json({
        error: "riskLevel must be 'on' | 'off'",
      });
      return;
    }
    try {
      const result = applyRiskLevel(level);
      if (level === 'off') {
        resetSkipReasonCounts();
      }
      res.json({
        ok: true,
        ...result,
        config: getConfigSnapshot(),
        soak: paperTrader.getSoakMetrics(),
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** One-click signal soak: Risk Off + recipe reset + clear skip counters. */
  app.post('/api/tuning/soak', (_req: Request, res: Response) => {
    try {
      const result = applyRiskLevel('off');
      resetSkipReasonCounts();
      res.json({
        ok: true,
        mode: 'soak',
        ...result,
        config: getConfigSnapshot(),
        soak: paperTrader.getSoakMetrics(),
        monitor: getMonitorStatus(),
        hint: 'Risk Off soak active — Copy + Scanner, max concurrent 40, small size, ops-only gates. Watch Overview soak strip + skip reasons.',
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/tuning/skip-reasons/reset', (_req: Request, res: Response) => {
    resetSkipReasonCounts();
    res.json({ ok: true, skipReasonCounts: [] });
  });

  app.post('/api/tuning/module-next', (_req: Request, res: Response) => {
    const { enableNextTuneModule, getModuleTuneStatus } =
      require('./strategies') as typeof import('./strategies');
    const result = enableNextTuneModule();
    res.json({
      ok: true,
      ...result,
      moduleTune: getModuleTuneStatus(),
      strategies: (
        require('./strategies') as typeof import('./strategies')
      ).getStrategiesStatus(),
    });
  });

  app.get('/api/tuning/status', (_req: Request, res: Response) => {
    const { getModuleTuneStatus } =
      require('./strategies') as typeof import('./strategies');
    res.json({
      soak: paperTrader.getSoakMetrics(),
      skipReasonCounts: getMonitorStatus().skipReasonCounts,
      lastFilterSkipReason: getMonitorStatus().lastFilterSkipReason,
      moduleTune: getModuleTuneStatus(),
      riskLevel: normalizeRiskLevel(config.riskLevel),
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
      'deadVolumeUsdPerHour',
      'deadVolumeConsecutiveHours',
      'deadVolumeMinHoldMinutes',
    ] as const) {
      if (body[key] !== undefined) {
        (partial as Record<string, number>)[key] = Number(body[key]);
      }
    }
    for (const key of ['enableDeadVolumeExit'] as const) {
      if (body[key] !== undefined) {
        (partial as Record<string, unknown>)[key] = Boolean(body[key]);
      }
    }
    if (body.normal && typeof body.normal === 'object') {
      partial.normal = body.normal as typeof config.risk.normal;
    }
    if (body.migration && typeof body.migration === 'object') {
      partial.migration = body.migration as typeof config.risk.migration;
    }

    const prevAutoPause = Boolean(config.risk?.autoPauseOnLimit);
    const risk = updateRiskConfig(partial);

    // Risk card can also set Filters daily loss (0 = off)
    if (body.dailyLossLimitSol !== undefined) {
      const n = Number(body.dailyLossLimitSol);
      if (Number.isFinite(n)) {
        config.filters.dailyLossLimitSol = Math.max(0, Math.min(50, n));
        persistUserSettings();
      }
    }

    // Turning Auto-pause OFF must clear sticky halt so trading resumes.
    // Also turn Daily Loss Off (0) — operators treat Auto-pause OFF as
    // "stop daily blocking"; leaving filters.dailyLossLimitSol at 0.5 still
    // rejects every buy while day PnL is underwater. Always zero even when
    // the Risk card POSTs the old slider value alongside autoPauseOnLimit:false.
    if (risk.autoPauseOnLimit === false) {
      if (prevAutoPause) {
        clearRiskHalt();
        clearMonitorRiskHalt();
        resumeMonitor();
      }
      if (config.filters.dailyLossLimitSol !== 0) {
        config.filters.dailyLossLimitSol = 0;
        persistUserSettings();
        console.log(
          '[risk] Auto-pause OFF → Daily Loss SOL set to 0 (Off) so buys are not filter-blocked'
        );
      }
    }

    res.json({
      ok: true,
      risk,
      filters: { dailyLossLimitSol: config.filters.dailyLossLimitSol },
    });
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

  app.get('/api/quick-scalper', (_req: Request, res: Response) => {
    res.json({ quickScalper: config.quickScalper });
  });

  app.post('/api/quick-scalper', (req: Request, res: Response) => {
    const { updateQuickScalperConfig } =
      require('./shortTermStrategies') as typeof import('./shortTermStrategies');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const partial: Partial<typeof config.quickScalper> = {};
    if (body.enabled !== undefined) partial.enabled = Boolean(body.enabled);
    if (body.timeLimitMinutes !== undefined) {
      partial.timeLimitMinutes = Number(body.timeLimitMinutes) as 1 | 2 | 3;
    }
    if (body.takeProfitPct !== undefined) {
      partial.takeProfitPct = Number(body.takeProfitPct);
    }
    if (body.stopLossPct !== undefined) {
      partial.stopLossPct = Number(body.stopLossPct);
    }
    if (body.minVolumeUsd !== undefined) {
      partial.minVolumeUsd = Number(body.minVolumeUsd);
    }
    if (body.minBuyPressureUsd !== undefined) {
      partial.minBuyPressureUsd = Number(body.minBuyPressureUsd);
    }
    const quickScalper = updateQuickScalperConfig(partial);
    res.json({ ok: true, quickScalper });
  });

  app.get('/api/short-term', (_req: Request, res: Response) => {
    res.json({
      quickScalper: config.quickScalper,
      microScalper: config.microScalper,
      momentumBurst: config.momentumBurst,
      postMigrationScalp: config.postMigrationScalp,
      reversalScalp: config.reversalScalp,
      postRunDip: config.postRunDip,
    });
  });

  app.post('/api/short-term/:id', (req: Request, res: Response) => {
    const id = String(req.params.id || '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const st =
      require('./shortTermStrategies') as typeof import('./shortTermStrategies');
    try {
      if (id === 'quick_scalper' || id === 'quickScalper') {
        res.json({
          ok: true,
          config: st.updateQuickScalperConfig(body as never),
        });
        return;
      }
      if (id === 'micro_scalper' || id === 'microScalper') {
        res.json({
          ok: true,
          config: st.updateMicroScalperConfig(body as never),
        });
        return;
      }
      if (id === 'momentum_burst' || id === 'momentumBurst') {
        res.json({
          ok: true,
          config: st.updateMomentumBurstConfig(body as never),
        });
        return;
      }
      if (id === 'post_migration_scalp' || id === 'postMigrationScalp') {
        res.json({
          ok: true,
          config: st.updatePostMigrationScalpConfig(body as never),
        });
        return;
      }
      if (id === 'reversal_scalp' || id === 'reversalScalp') {
        res.json({
          ok: true,
          config: st.updateReversalScalpConfig(body as never),
        });
        return;
      }
      if (id === 'post_run_dip' || id === 'postRunDip') {
        res.json({
          ok: true,
          config: st.updatePostRunDipConfig(body as never),
        });
        return;
      }
      res.status(400).json({ error: `Unknown short-term strategy: ${id}` });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/risk/clear-halt', (_req: Request, res: Response) => {
    clearRiskHalt();
    clearMonitorRiskHalt();
    resumeMonitor();
    res.json({ ok: true, status: getMonitorStatus() });
  });

  // --- Positions & logs ---

  app.get('/api/positions', (req: Request, res: Response) => {
    const fast =
      req.query.fast === '1' ||
      req.query.fast === 'true' ||
      req.query.lite === '1';
    let liveEmpty = false;
    if (config.mode === 'live') {
      try {
        const { isLiveWalletConnected } =
          require('./liveWalletHistory') as typeof import('./liveWalletHistory');
        liveEmpty = !isLiveWalletConnected();
      } catch {
        liveEmpty = true;
      }
    }
    if (liveEmpty) {
      res.json({
        open: [],
        closed: [],
        sellHistory: [],
        rebuy: { status: null, candidates: [] },
        liveWalletEmpty: true,
        ...(fast ? { fast: true } : {}),
      });
      return;
    }
    const openRaw = paperTrader.getOpenPositions();
    // Always attach technicalLevels so fast (2s) and full (5s) polls paint
    // the same TOKEN meta height — omitting it caused open-row flicker/resize.
    const {
      getTechnicalSnapshot,
      technicalLevelsPublic,
    } = require('./technicalLevels') as typeof import('./technicalLevels');
    const open = openRaw.map((p) => {
      const priceSol = paperTrader.getTokenPrice(p.mint);
      const snap = getTechnicalSnapshot(p.mint, {
        priceSol,
      });
      return {
        ...p,
        technicalLevels: technicalLevelsPublic(snap),
      };
    });
    // Fast poll: open rows only — closed was ~275KB every 2s and froze the UI.
    if (fast) {
      res.json({
        open,
        closed: [],
        closedTotal: paperTrader.getClosedPositions().length,
        sellHistory: [],
        rebuy: {
          status: getReBuyStatus(),
          candidates: getReBuyCandidates().slice(0, 20),
        },
        fast: true,
      });
      return;
    }
    const closedSlice = dashboardClosedSlice();
    res.json({
      open,
      closed: closedSlice.closed,
      closedTotal: closedSlice.closedTotal,
      sellHistory: getSellHistory().slice(0, 50),
      rebuy: {
        status: getReBuyStatus(),
        candidates: getReBuyCandidates().slice(0, 20),
      },
    });
  });

  app.get('/api/technicals/:mint', (req: Request, res: Response) => {
    const mint = String(req.params.mint || '').trim();
    if (!mint) {
      res.status(400).json({ error: 'mint required' });
      return;
    }
    const {
      getTechnicalSnapshot,
      getFibLevels,
      getNearestSupport,
      getNearestResistance,
      technicalLevelsPublic,
    } = require('./technicalLevels') as typeof import('./technicalLevels');
    const priceSol = paperTrader.getTokenPrice(mint);
    const snap = getTechnicalSnapshot(mint, { priceSol });
    res.json({
      mint,
      priceSol: priceSol ?? null,
      snapshot: technicalLevelsPublic(snap),
      fibLevels: getFibLevels(mint, { priceSol }),
      nearestSupport: getNearestSupport(mint, priceSol),
      nearestResistance: getNearestResistance(mint, priceSol),
      detail: snap.detail,
    });
  });

  /** Force-sell entire open position (paper simulate or live on-chain). */
  app.post('/api/positions/:id/sell', async (req: Request, res: Response) => {
    const id = String(req.params.id ?? '').trim();
    if (!id) {
      res.status(400).json({ error: 'Missing position id' });
      return;
    }
    try {
      const result = await paperTrader.forceSellPosition(
        id,
        'manual force sell'
      );
      if (!result.ok) {
        res.status(400).json({ error: result.error ?? 'Sell failed' });
        return;
      }
      res.json({
        ok: true,
        position: result.position,
        open: paperTrader.getOpenPositions(),
        closed: paperTrader.getClosedPositions(),
        balanceSol: paperTrader.getBalance(),
        stats: paperTrader.getStats(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
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

  app.get('/api/signals', (_req: Request, res: Response) => {
    res.json({
      signals: getRecentSignals(),
      trade: {
        baseTradeAmountSol:
          config.trade.baseTradeAmountSol ?? config.trade.tradeAmountSol,
        maxAllowedTradeSol: config.trade.maxAllowedTradeSol ?? 1.5,
        riskMultiplier: config.trade.riskMultiplier ?? 0.4,
        convictionMultiplier: config.trade.convictionMultiplier ?? 1.45,
      },
    });
  });

  app.get('/api/market-scanner', (_req: Request, res: Response) => {
    res.json({
      status: getScannerStatus(),
      candidates: getScannerFeed(40),
      config: { ...(config.marketScanner || {}) },
    });
  });

  app.post('/api/config/market-scanner', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!config.marketScanner) {
      config.marketScanner = {
        enabled: true,
        pollIntervalMs: 15_000,
        lookbackHours: 6,
        maxCandidatesPerPoll: 15,
        cooldownMs: 45 * 60_000,
        minRankScore: 42,
        requireTaSetup: true,
        minPatternConfidence: 55,
        preferRealCandles: true,
        syntheticPenalty: 8,
        minConfluenceScore: 40,
        playbookMode: 'auto',
        pauseScannerOnlyInRiskOff: true,
        requireRsForMomentum: true,
        requireMtfAligned: false,
        minLiquidityUsd: 8000,
        minOrganicScore: 0,
        preferOrganicVolume: true,
        jupiterTrendingEnabled: true,
        jupiterCategory: 'toptraded',
        jupiterPumpFunOnly: true,
        jupiterLimit: 100,
        jupiterMergeIntervals: true,
        minVolumeM5Usd: 1000,
        minVolumeH1Usd: 2500,
        minVolumeH6Usd: 10000,
        minVolumeH24Usd: 15000,
      };
    }
    const ms = config.marketScanner;
    let enabledChanged = false;
    if (body.enabled !== undefined) {
      const next = Boolean(body.enabled);
      enabledChanged = next !== Boolean(ms.enabled);
      ms.enabled = next;
    }
    if (body.pollIntervalMs !== undefined) {
      const n = Number(body.pollIntervalMs);
      if (Number.isFinite(n)) {
        ms.pollIntervalMs = Math.max(15_000, Math.min(600_000, Math.round(n)));
      }
    }
    if (body.lookbackHours !== undefined) {
      const n = Number(body.lookbackHours);
      if (Number.isFinite(n)) {
        ms.lookbackHours = Math.max(0.5, Math.min(48, n));
      }
    }
    if (body.maxCandidatesPerPoll !== undefined) {
      const n = Number(body.maxCandidatesPerPoll);
      if (Number.isFinite(n)) {
        ms.maxCandidatesPerPoll = Math.max(1, Math.min(50, Math.round(n)));
      }
    }
    if (body.cooldownMs !== undefined) {
      const n = Number(body.cooldownMs);
      if (Number.isFinite(n)) {
        ms.cooldownMs = Math.max(60_000, Math.min(24 * 60 * 60_000, Math.round(n)));
      }
    }
    if (body.minRankScore !== undefined) {
      const n = Number(body.minRankScore);
      if (Number.isFinite(n)) {
        ms.minRankScore = Math.max(0, Math.min(100, Math.round(n)));
      }
    }
    if (body.requireTaSetup !== undefined) {
      ms.requireTaSetup = Boolean(body.requireTaSetup);
    }
    if (body.minPatternConfidence !== undefined) {
      const n = Number(body.minPatternConfidence);
      if (Number.isFinite(n)) {
        ms.minPatternConfidence = Math.max(0, Math.min(100, Math.round(n)));
      }
    }
    if (body.preferRealCandles !== undefined) {
      ms.preferRealCandles = Boolean(body.preferRealCandles);
    }
    if (body.syntheticPenalty !== undefined) {
      const n = Number(body.syntheticPenalty);
      if (Number.isFinite(n)) {
        ms.syntheticPenalty = Math.max(0, Math.min(40, Math.round(n)));
      }
    }
    if (body.minConfluenceScore !== undefined) {
      const n = Number(body.minConfluenceScore);
      if (Number.isFinite(n)) {
        ms.minConfluenceScore = Math.max(0, Math.min(100, Math.round(n)));
      }
    }
    if (body.playbookMode !== undefined) {
      ms.playbookMode = 'auto';
    }
    if (body.pauseScannerOnlyInRiskOff !== undefined) {
      ms.pauseScannerOnlyInRiskOff = Boolean(body.pauseScannerOnlyInRiskOff);
    }
    if (body.requireRsForMomentum !== undefined) {
      ms.requireRsForMomentum = Boolean(body.requireRsForMomentum);
    }
    if (body.requireMtfAligned !== undefined) {
      ms.requireMtfAligned = Boolean(body.requireMtfAligned);
    }
    if (body.minLiquidityUsd !== undefined) {
      const n = Number(body.minLiquidityUsd);
      if (Number.isFinite(n)) {
        ms.minLiquidityUsd = Math.max(0, Math.min(5_000_000, Math.round(n)));
      }
    }
    if (body.minOrganicScore !== undefined) {
      const n = Number(body.minOrganicScore);
      if (Number.isFinite(n)) {
        ms.minOrganicScore = Math.max(0, Math.min(100, Math.round(n)));
      }
    }
    if (body.preferOrganicVolume !== undefined) {
      ms.preferOrganicVolume = Boolean(body.preferOrganicVolume);
    }
    if (body.jupiterTrendingEnabled !== undefined) {
      ms.jupiterTrendingEnabled = Boolean(body.jupiterTrendingEnabled);
    }
    if (body.jupiterCategory !== undefined) {
      const cat = String(body.jupiterCategory);
      if (
        cat === 'toptraded' ||
        cat === 'toptrending' ||
        cat === 'toporganicscore'
      ) {
        ms.jupiterCategory = cat;
      }
    }
    if (body.jupiterPumpFunOnly !== undefined) {
      ms.jupiterPumpFunOnly = Boolean(body.jupiterPumpFunOnly);
    }
    if (body.jupiterLimit !== undefined) {
      const n = Number(body.jupiterLimit);
      if (Number.isFinite(n)) {
        ms.jupiterLimit = Math.max(10, Math.min(100, Math.round(n)));
      }
    }
    if (body.jupiterMergeIntervals !== undefined) {
      ms.jupiterMergeIntervals = Boolean(body.jupiterMergeIntervals);
    }
    if (body.minVolumeM5Usd !== undefined) {
      const n = Number(body.minVolumeM5Usd);
      if (Number.isFinite(n)) {
        ms.minVolumeM5Usd = Math.max(0, Math.min(10_000_000, Math.round(n)));
      }
    }
    if (body.minVolumeH1Usd !== undefined) {
      const n = Number(body.minVolumeH1Usd);
      if (Number.isFinite(n)) {
        ms.minVolumeH1Usd = Math.max(0, Math.min(50_000_000, Math.round(n)));
      }
    }
    if (body.minVolumeH6Usd !== undefined) {
      const n = Number(body.minVolumeH6Usd);
      if (Number.isFinite(n)) {
        ms.minVolumeH6Usd = Math.max(0, Math.min(100_000_000, Math.round(n)));
      }
    }
    if (body.minVolumeH24Usd !== undefined) {
      const n = Number(body.minVolumeH24Usd);
      if (Number.isFinite(n)) {
        ms.minVolumeH24Usd = Math.max(0, Math.min(200_000_000, Math.round(n)));
      }
    }

    // Strategy toggle is the live gate — keep soft preference + toggle in sync.
    // Use updateStrategyToggles so underlying flags stay aligned and recipe
    // mode marks custom (user preference wins over synced recipes).
    try {
      const { updateStrategyToggles } =
        require('./strategies') as typeof import('./strategies');
      updateStrategyToggles(
        { ta_market_scanner: ms.enabled !== false },
        { persist: false, syncUnderlying: true, markCustom: true }
      );
    } catch {
      if (config.strategyToggles) {
        config.strategyToggles.ta_market_scanner = ms.enabled !== false;
      }
    }
    persistUserSettings();

    // Restart so pollIntervalMs (set once at start) picks up new values
    try {
      const { restartMarketScanner } =
        require('./marketScanner') as typeof import('./marketScanner');
      restartMarketScanner();
    } catch {
      /* monitor may not have started yet */
    }

    res.json({
      ok: true,
      enabledChanged,
      config: { ...ms },
      status: getScannerStatus(),
    });
  });

  // ——— AlphaScan (additive New/Soon/Bonded; default OFF) ———
  app.get('/api/alphascan', async (_req: Request, res: Response) => {
    try {
      const alpha =
        require('./alphaScanFeed') as typeof import('./alphaScanFeed');
      // Serve cache; refresh only when stale (dashboard polls ~5s — must not
      // re-run bonding-curve RPC on every hit).
      if (config.alphaScan?.enabled) {
        await alpha.refreshAlphaScanBuckets().catch(() => null);
      }
      res.json({ ok: true, ...alpha.getAlphaScanSnapshot() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/config/alphascan', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!config.alphaScan) {
        config.alphaScan = {
          enabled: false,
          pollIntervalMs: 45_000,
          feedNew: true,
          feedSoon: true,
          feedBonded: true,
          routeSoonToMigrationSniper: true,
          routeBondedToScalper: true,
          routeBondedToReversalScalper: true,
          soonMinCurvePct: 70,
          bondedMaxAgeMinutes: 45,
          bondedMinMarketCapUsd: 25_000,
          maxHandOffPerPoll: 8,
          includeNewInScannerUniverse: false,
          recentLimit: 40,
        };
      }
      const a = config.alphaScan;
      if (body.enabled !== undefined) a.enabled = Boolean(body.enabled);
      if (body.feedNew !== undefined) a.feedNew = Boolean(body.feedNew);
      if (body.feedSoon !== undefined) a.feedSoon = Boolean(body.feedSoon);
      if (body.feedBonded !== undefined) a.feedBonded = Boolean(body.feedBonded);
      if (body.routeSoonToMigrationSniper !== undefined) {
        a.routeSoonToMigrationSniper = Boolean(body.routeSoonToMigrationSniper);
      }
      if (body.routeBondedToScalper !== undefined) {
        a.routeBondedToScalper = Boolean(body.routeBondedToScalper);
      }
      if (body.routeBondedToReversalScalper !== undefined) {
        a.routeBondedToReversalScalper = Boolean(
          body.routeBondedToReversalScalper
        );
      }
      if (body.includeNewInScannerUniverse !== undefined) {
        a.includeNewInScannerUniverse = Boolean(
          body.includeNewInScannerUniverse
        );
      }
      if (body.pollIntervalMs !== undefined) {
        const n = Number(body.pollIntervalMs);
        if (Number.isFinite(n)) {
          a.pollIntervalMs = Math.max(15_000, Math.min(600_000, Math.round(n)));
        }
      }
      if (body.soonMinCurvePct !== undefined) {
        const n = Number(body.soonMinCurvePct);
        if (Number.isFinite(n)) {
          a.soonMinCurvePct = Math.max(50, Math.min(95, Math.round(n)));
        }
      }
      if (body.bondedMaxAgeMinutes !== undefined) {
        const n = Number(body.bondedMaxAgeMinutes);
        if (Number.isFinite(n)) {
          a.bondedMaxAgeMinutes = Math.max(5, Math.min(360, Math.round(n)));
        }
      }
      if (body.bondedMinMarketCapUsd !== undefined) {
        const n = Number(body.bondedMinMarketCapUsd);
        if (Number.isFinite(n)) {
          a.bondedMinMarketCapUsd = Math.max(0, Math.min(5_000_000, Math.round(n)));
        }
      }
      if (body.maxHandOffPerPoll !== undefined) {
        const n = Number(body.maxHandOffPerPoll);
        if (Number.isFinite(n)) {
          a.maxHandOffPerPoll = Math.max(1, Math.min(20, Math.round(n)));
        }
      }
      if (body.recentLimit !== undefined) {
        const n = Number(body.recentLimit);
        if (Number.isFinite(n)) {
          a.recentLimit = Math.max(10, Math.min(100, Math.round(n)));
        }
      }
      persistUserSettings();
      const alpha =
        require('./alphaScanFeed') as typeof import('./alphaScanFeed');
      res.json({ ok: true, config: { ...a }, status: alpha.getAlphaScanSnapshot() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ——— Zion micro-bot (isolated; no strategy toggle coupling) ———
  app.get('/api/zion', (_req: Request, res: Response) => {
    try {
      const zion = require('./zion') as typeof import('./zion');
      const scan = require('./zionKolScanner') as typeof import('./zionKolScanner');
      res.json({
        ok: true,
        config: { ...config.zion },
        status: zion.getZionStatus(),
        scanner: scan.getZionScannerStatus(),
        offers: zion.listOffers(40),
        candidates: scan.getZionScannerFeed(40),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.get('/api/zion/scanner', (_req: Request, res: Response) => {
    try {
      const scan = require('./zionKolScanner') as typeof import('./zionKolScanner');
      res.json({
        ok: true,
        status: scan.getZionScannerStatus(),
        candidates: scan.getZionScannerFeed(40),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.post('/api/config/zion', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!config.zion) {
        res.status(500).json({ ok: false, error: 'zion config missing' });
        return;
      }
      const z = config.zion;
      if (typeof body.enabled === 'boolean') z.enabled = body.enabled;
      if (body.scanner && typeof body.scanner === 'object') {
        const s = body.scanner as Record<string, unknown>;
        if (typeof s.enabled === 'boolean') z.scanner.enabled = s.enabled;
        if (s.pollIntervalMs != null && Number.isFinite(Number(s.pollIntervalMs))) {
          z.scanner.pollIntervalMs = Math.max(
            30_000,
            Math.min(600_000, Math.round(Number(s.pollIntervalMs)))
          );
        }
        if (s.universeSize != null && Number.isFinite(Number(s.universeSize))) {
          z.scanner.universeSize = Math.max(
            20,
            Math.min(100, Math.round(Number(s.universeSize)))
          );
        }
        if (
          s.activityLookbackMinutes != null &&
          Number.isFinite(Number(s.activityLookbackMinutes))
        ) {
          z.scanner.activityLookbackMinutes = Math.max(
            10,
            Math.min(240, Math.round(Number(s.activityLookbackMinutes)))
          );
        }
        if (s.batchSize != null && Number.isFinite(Number(s.batchSize))) {
          z.scanner.batchSize = Math.max(
            2,
            Math.min(12, Math.round(Number(s.batchSize)))
          );
        }
      }
      if (body.minKolWallets != null && Number.isFinite(Number(body.minKolWallets))) {
        z.minKolWallets = Math.max(1, Math.min(20, Math.round(Number(body.minKolWallets))));
      }
      if (body.minWalletQuality != null && Number.isFinite(Number(body.minWalletQuality))) {
        z.minWalletQuality = Math.max(0, Math.min(100, Math.round(Number(body.minWalletQuality))));
      }
      if (body.minMcUsd != null && Number.isFinite(Number(body.minMcUsd))) {
        z.minMcUsd = Math.max(0, Number(body.minMcUsd));
      }
      if (body.maxMcUsd != null && Number.isFinite(Number(body.maxMcUsd))) {
        z.maxMcUsd = Math.max(0, Number(body.maxMcUsd));
      }
      if (body.offerTtlMinutes != null && Number.isFinite(Number(body.offerTtlMinutes))) {
        z.offerTtlMinutes = Math.max(5, Math.min(240, Math.round(Number(body.offerTtlMinutes))));
      }
      if (body.mintCooldownMinutes != null && Number.isFinite(Number(body.mintCooldownMinutes))) {
        z.mintCooldownMinutes = Math.max(5, Math.min(1440, Math.round(Number(body.mintCooldownMinutes))));
      }
      if (typeof body.useTrackedWalletsAsBoost === 'boolean') {
        z.useTrackedWalletsAsBoost = body.useTrackedWalletsAsBoost;
      }
      if (typeof body.autoOfferFromScanner === 'boolean') {
        z.autoOfferFromScanner = body.autoOfferFromScanner;
      }
      if (typeof body.autoSendPlatinumToHwr === 'boolean') {
        z.autoSendPlatinumToHwr = body.autoSendPlatinumToHwr;
      }
      if (typeof body.autoSendGoldToSmartMoney === 'boolean') {
        z.autoSendGoldToSmartMoney = body.autoSendGoldToSmartMoney;
      }
      if (typeof body.notifyEmailOnOffer === 'boolean') {
        z.notifyEmailOnOffer = body.notifyEmailOnOffer;
      }
      if (typeof body.notifyEmailOnPlaced === 'boolean') {
        z.notifyEmailOnPlaced = body.notifyEmailOnPlaced;
      }
      if (body.defaults && typeof body.defaults === 'object') {
        const d = body.defaults as Record<string, unknown>;
        if (d.sizeMode === 'sol' || d.sizeMode === 'usd') z.defaults.sizeMode = d.sizeMode;
        if (d.solAmount != null && Number.isFinite(Number(d.solAmount))) {
          z.defaults.solAmount = Math.max(0.01, Math.min(50, Number(d.solAmount)));
        }
        if (d.usdAmount != null && Number.isFinite(Number(d.usdAmount))) {
          z.defaults.usdAmount = Math.max(1, Math.min(50_000, Number(d.usdAmount)));
        }
        if (d.takeProfitPct != null && Number.isFinite(Number(d.takeProfitPct))) {
          z.defaults.takeProfitPct = Math.max(5, Math.min(5000, Number(d.takeProfitPct)));
        }
        if (d.stopLossPct != null && Number.isFinite(Number(d.stopLossPct))) {
          z.defaults.stopLossPct = Math.max(-95, Math.min(-1, Number(d.stopLossPct)));
        }
        if (d.trailingStopPct != null && Number.isFinite(Number(d.trailingStopPct))) {
          z.defaults.trailingStopPct = Math.max(1, Math.min(80, Number(d.trailingStopPct)));
        }
        if (
          d.trailingActivationProfit != null &&
          Number.isFinite(Number(d.trailingActivationProfit))
        ) {
          z.defaults.trailingActivationProfit = Math.max(
            1,
            Math.min(500, Number(d.trailingActivationProfit))
          );
        }
        if (typeof d.useExitPresets === 'boolean') {
          z.defaults.useExitPresets = d.useExitPresets;
        }
      }

      persistUserSettings();
      const scan = require('./zionKolScanner') as typeof import('./zionKolScanner');
      scan.syncZionKolScannerLifecycle();

      res.json({
        ok: true,
        config: { ...config.zion },
        scanner: scan.getZionScannerStatus(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.post('/api/zion/offers/:id/approve', async (req: Request, res: Response) => {
    try {
      const { executeApprovedOffer } = require('./zion') as typeof import('./zion');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await executeApprovedOffer(String(req.params.id), {
        solAmount: body.solAmount != null ? Number(body.solAmount) : undefined,
        usdAmount: body.usdAmount != null ? Number(body.usdAmount) : undefined,
        useExitPresets:
          typeof body.useExitPresets === 'boolean' ? body.useExitPresets : undefined,
        takeProfitPct:
          body.takeProfitPct != null ? Number(body.takeProfitPct) : undefined,
        stopLossPct: body.stopLossPct != null ? Number(body.stopLossPct) : undefined,
        trailingStopPct:
          body.trailingStopPct != null ? Number(body.trailingStopPct) : undefined,
        trailingActivationProfit:
          body.trailingActivationProfit != null
            ? Number(body.trailingActivationProfit)
            : undefined,
      });
      if (!result.ok) {
        res.status(400).json(result);
        return;
      }
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.post('/api/zion/offers/:id/decline', (req: Request, res: Response) => {
    try {
      const { declineOffer } = require('./zion') as typeof import('./zion');
      const offer = declineOffer(String(req.params.id));
      if (!offer) {
        res.status(404).json({ ok: false, error: 'Offer not found or not pending' });
        return;
      }
      res.json({ ok: true, offer });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.post('/api/zion/offers/:id/dismiss', (req: Request, res: Response) => {
    try {
      const { markOfferPopupDismissed, getOffer } =
        require('./zion') as typeof import('./zion');
      markOfferPopupDismissed(String(req.params.id));
      const offer = getOffer(String(req.params.id));
      if (!offer) {
        res.status(404).json({ ok: false, error: 'Offer not found' });
        return;
      }
      res.json({ ok: true, offer });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.post('/api/zion/offers/:id/open', (req: Request, res: Response) => {
    try {
      const { markOfferOpened, getOffer } = require('./zion') as typeof import('./zion');
      markOfferOpened(String(req.params.id));
      const offer = getOffer(String(req.params.id));
      if (!offer) {
        res.status(404).json({ ok: false, error: 'Offer not found' });
        return;
      }
      res.json({ ok: true, offer });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.get('/api/post-run-dip/smart-wallet', (_req: Request, res: Response) => {
    const { getRecentDipSmartWalletActivity } =
      require('./postRunDip') as typeof import('./postRunDip');
    res.json({
      events: getRecentDipSmartWalletActivity(30),
      config: {
        sensitivity: config.postRunDip?.smartWalletDipSensitivity ?? 'medium',
        boostPoints: config.postRunDip?.smartWalletDipBoostPoints ?? 8,
        preferSmartMoney: config.postRunDip?.preferSmartMoney !== false,
        stronglyPreferSmartMoney:
          config.postRunDip?.stronglyPreferSmartMoney === true,
        requireSmartMoney: config.postRunDip?.requireSmartMoney === true,
        hardRequireSmartMoneyInConservative:
          config.postRunDip?.hardRequireSmartMoneyInConservative === true,
        profile: config.postRunDip?.profile ?? 'standard',
        enabled: config.postRunDip?.enabled === true,
      },
    });
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
    const snap = getConfigSnapshot();
    try {
      const { emailDeliveryStatus } =
        require('./emailNotifications') as typeof import('./emailNotifications');
      res.json({ ...snap, emailDelivery: emailDeliveryStatus() });
    } catch {
      res.json(snap);
    }
  });

  /** Micro-bot Learning Mode — gate overlays + fairness (not position sizing). */
  app.get('/api/config/learning-mode', (_req: Request, res: Response) => {
    try {
      const { getLearningModeStatus } =
        require('./learningMode') as typeof import('./learningMode');
      res.json({ ok: true, learningMode: getLearningModeStatus() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/config/learning-mode', (req: Request, res: Response) => {
    try {
      const {
        setLearningModeEnabled,
        setLearningModeStrictness,
        resetLearningMode,
        getLearningModeStatus,
      } = require('./learningMode') as typeof import('./learningMode');
      const body = (req.body ?? {}) as {
        enabled?: boolean;
        strictness?: 'stricter' | 'middle' | 'looser';
        reset?: boolean;
      };
      if (body.reset === true) {
        resetLearningMode();
      } else {
        if (typeof body.enabled === 'boolean') {
          setLearningModeEnabled(body.enabled);
        }
        if (
          body.strictness === 'stricter' ||
          body.strictness === 'middle' ||
          body.strictness === 'looser'
        ) {
          setLearningModeStrictness(body.strictness);
        }
      }
      res.json({
        ok: true,
        learningMode: getLearningModeStatus(),
        config: getConfigSnapshot(),
      });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/config/live-mode-learning', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      includeLiveModeEpisodes:
        config.learning?.includeLiveModeEpisodes === true,
    });
  });

  app.post('/api/config/live-mode-learning', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { includeLiveModeEpisodes?: boolean };
      if (typeof body.includeLiveModeEpisodes !== 'boolean') {
        res.status(400).json({
          ok: false,
          error: 'includeLiveModeEpisodes boolean required',
        });
        return;
      }
      config.learning = {
        includeLiveModeEpisodes: body.includeLiveModeEpisodes === true,
      };
      persistUserSettings();
      res.json({
        ok: true,
        includeLiveModeEpisodes: config.learning.includeLiveModeEpisodes,
        config: getConfigSnapshot(),
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** Soft MARL coordinator */
  app.get('/api/marl/status', (_req: Request, res: Response) => {
    try {
      const { getMarlStatus } =
        require('./marlCoordinator') as typeof import('./marlCoordinator');
      res.json({ ok: true, marl: getMarlStatus() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/marl/decisions', (req: Request, res: Response) => {
    try {
      const { getMarlDecisions } =
        require('./marlStore') as typeof import('./marlStore');
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
      res.json({ ok: true, decisions: getMarlDecisions(limit) });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/config/marl', (req: Request, res: Response) => {
    try {
      const { setMarlConfig, getMarlStatus } =
        require('./marlCoordinator') as typeof import('./marlCoordinator');
      const body = (req.body ?? {}) as Record<string, unknown>;
      setMarlConfig({
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        strength:
          body.strength === 'low' ||
          body.strength === 'medium' ||
          body.strength === 'high'
            ? body.strength
            : undefined,
        lowMcUsd: body.lowMcUsd != null ? Number(body.lowMcUsd) : undefined,
        lowMcWindowMin:
          body.lowMcWindowMin != null ? Number(body.lowMcWindowMin) : undefined,
        maxAgentsPerLowMc:
          body.maxAgentsPerLowMc != null
            ? Number(body.maxAgentsPerLowMc)
            : undefined,
        laggingSupportEnabled:
          typeof body.laggingSupportEnabled === 'boolean'
            ? body.laggingSupportEnabled
            : undefined,
      });
      res.json({ ok: true, marl: getMarlStatus() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** Per-profile RL soft agents */
  app.get('/api/profile-rl/status', (_req: Request, res: Response) => {
    try {
      const { getProfileRlStatus } =
        require('./profileRlAgent') as typeof import('./profileRlAgent');
      res.json({ ok: true, profileRl: getProfileRlStatus() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/profile-rl/decisions', (req: Request, res: Response) => {
    try {
      const { getProfileRlDecisions } =
        require('./profileRlStore') as typeof import('./profileRlStore');
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
      res.json({ ok: true, decisions: getProfileRlDecisions(limit) });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/config/profile-rl', (req: Request, res: Response) => {
    try {
      const { setProfileRlConfig, getProfileRlStatus, setProfileRlAgentMode } =
        require('./profileRlAgent') as typeof import('./profileRlAgent');
      const body = (req.body ?? {}) as Record<string, unknown>;
      setProfileRlConfig({
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        strength:
          body.strength === 'low' ||
          body.strength === 'medium' ||
          body.strength === 'high'
            ? body.strength
            : undefined,
      });
      if (
        typeof body.profileId === 'string' &&
        (body.mode === 'shadow' || body.mode === 'hybrid' || body.mode === 'lead')
      ) {
        setProfileRlAgentMode(body.profileId, body.mode, {
          modeLocked:
            typeof body.modeLocked === 'boolean' ? body.modeLocked : undefined,
        });
      } else if (
        typeof body.profileId === 'string' &&
        typeof body.modeLocked === 'boolean'
      ) {
        const { loadProfileRlState, saveProfileRlState, getOrCreateProfileRlAgent } =
          require('./profileRlStore') as typeof import('./profileRlStore');
        const st = loadProfileRlState();
        const agent = getOrCreateProfileRlAgent(body.profileId);
        agent.modeLocked = body.modeLocked;
        agent.updatedAt = Date.now();
        st.agents[body.profileId] = agent;
        saveProfileRlState(st);
      }
      res.json({ ok: true, profileRl: getProfileRlStatus() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/profile-rl/rollback', (req: Request, res: Response) => {
    try {
      const { rollbackProfileRlPolicyTo, getProfileRlStatus } =
        require('./profileRlAgent') as typeof import('./profileRlAgent');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const profileId = String(body.profileId || '');
      const result = rollbackProfileRlPolicyTo(profileId, Number(body.index) || 0);
      res.json({ ok: result.ok, detail: result.detail, profileRl: getProfileRlStatus() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** Learning accelerators trio */
  app.get('/api/learning-accelerators', (_req: Request, res: Response) => {
    try {
      const { getLearningAcceleratorsStatus } =
        require('./learningReplayBuffer') as typeof import('./learningReplayBuffer');
      const { getTeacherStudentStatus } =
        require('./learningTeacherStudent') as typeof import('./learningTeacherStudent');
      res.json({
        ok: true,
        accelerators: getLearningAcceleratorsStatus(),
        teacherStudent: getTeacherStudentStatus(),
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/learning-accelerators', (req: Request, res: Response) => {
    try {
      const { setLearningAcceleratorsConfig, getLearningAcceleratorsStatus } =
        require('./learningReplayBuffer') as typeof import('./learningReplayBuffer');
      const { getTeacherStudentStatus } =
        require('./learningTeacherStudent') as typeof import('./learningTeacherStudent');
      const body = (req.body ?? {}) as Record<string, unknown>;
      setLearningAcceleratorsConfig({
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        replayEnabled:
          typeof body.replayEnabled === 'boolean' ? body.replayEnabled : undefined,
        counterfactualEnabled:
          typeof body.counterfactualEnabled === 'boolean'
            ? body.counterfactualEnabled
            : undefined,
        counterfactualApplyHints:
          typeof body.counterfactualApplyHints === 'boolean'
            ? body.counterfactualApplyHints
            : undefined,
        teacherStudentEnabled:
          typeof body.teacherStudentEnabled === 'boolean'
            ? body.teacherStudentEnabled
            : undefined,
        strength:
          body.strength === 'low' ||
          body.strength === 'medium' ||
          body.strength === 'high'
            ? body.strength
            : undefined,
        replayBatchSize:
          body.replayBatchSize != null ? Number(body.replayBatchSize) : undefined,
        replayMaxPerHour:
          body.replayMaxPerHour != null ? Number(body.replayMaxPerHour) : undefined,
      });
      res.json({
        ok: true,
        accelerators: getLearningAcceleratorsStatus(),
        teacherStudent: getTeacherStudentStatus(),
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** Learning enhancements — additive scheduler / quality / explore / watchdog */
  app.get('/api/config/learning-enhancements', (_req: Request, res: Response) => {
    try {
      const { getLearningEnhancementsConfig } =
        require('./learningEnhancements') as typeof import('./learningEnhancements');
      res.json({ ok: true, learningEnhancements: getLearningEnhancementsConfig() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/config/learning-enhancements', (req: Request, res: Response) => {
    try {
      const { setLearningEnhancementsConfig, getLearningEnhancementsStatus } =
        require('./learningEnhancements') as typeof import('./learningEnhancements');
      const body = (req.body ?? {}) as Record<string, unknown>;
      setLearningEnhancementsConfig({
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        schedulerEnabled:
          typeof body.schedulerEnabled === 'boolean' ? body.schedulerEnabled : undefined,
        qualityWeightingEnabled:
          typeof body.qualityWeightingEnabled === 'boolean'
            ? body.qualityWeightingEnabled
            : undefined,
        dualRewardEnabled:
          typeof body.dualRewardEnabled === 'boolean' ? body.dualRewardEnabled : undefined,
        explorationEnabled:
          typeof body.explorationEnabled === 'boolean' ? body.explorationEnabled : undefined,
        explorationRate:
          body.explorationRate != null ? Number(body.explorationRate) : undefined,
        watchdogEnabled:
          typeof body.watchdogEnabled === 'boolean' ? body.watchdogEnabled : undefined,
        schedulerIntervalMs:
          body.schedulerIntervalMs != null ? Number(body.schedulerIntervalMs) : undefined,
      });
      res.json({
        ok: true,
        learningEnhancements: getLearningEnhancementsStatus(),
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/learning-enhancements/status', (_req: Request, res: Response) => {
    try {
      const { getLearningEnhancementsStatus } =
        require('./learningEnhancements') as typeof import('./learningEnhancements');
      res.json({ ok: true, ...getLearningEnhancementsStatus() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/peak-profit-protection', (_req: Request, res: Response) => {
    try {
      const { getPeakProfitProtectionConfig } =
        require('./peakProfitProtection') as typeof import('./peakProfitProtection');
      res.json({ ok: true, peakProfitProtection: getPeakProfitProtectionConfig() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/profit-capture-layer', (_req: Request, res: Response) => {
    try {
      const { getProfitCaptureLayerConfig } =
        require('./profitCaptureLayer') as typeof import('./profitCaptureLayer');
      res.json({ ok: true, profitCaptureLayer: getProfitCaptureLayerConfig() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/config/profit-capture-layer', (req: Request, res: Response) => {
    try {
      const {
        setProfitCaptureLayerConfig,
        getProfitCaptureLayerConfig,
      } = require('./profitCaptureLayer') as typeof import('./profitCaptureLayer');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const familyOverrides =
        body.familyOverrides && typeof body.familyOverrides === 'object'
          ? (body.familyOverrides as Record<string, unknown>)
          : undefined;
      setProfitCaptureLayerConfig({
        enabled:
          typeof body.enabled === 'boolean' ? body.enabled : undefined,
        learningStrength:
          body.learningStrength != null
            ? Number(body.learningStrength)
            : undefined,
        familyOverrides: familyOverrides as
          | import('./profitCaptureLayer').ProfitCaptureLayerConfig['familyOverrides']
          | undefined,
      });
      res.json({
        ok: true,
        profitCaptureLayer: getProfitCaptureLayerConfig(),
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/fast-profile-recovery', (_req: Request, res: Response) => {
    try {
      const { getFastProfileRecoveryPublic } =
        require('./fastProfileRecovery') as typeof import('./fastProfileRecovery');
      res.json({ ok: true, ...getFastProfileRecoveryPublic() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/fast-profile-recovery', (req: Request, res: Response) => {
    try {
      const {
        setFastProfileRecoveryConfig,
        getFastProfileRecoveryPublic,
        forceProfileRecoveryStage,
      } = require('./fastProfileRecovery') as typeof import('./fastProfileRecovery');
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.forceProfileId != null && body.forceStage != null) {
        forceProfileRecoveryStage(
          String(body.forceProfileId),
          Math.round(Number(body.forceStage)) as 0 | 1 | 2 | 3 | 4,
          { lock: body.lock === true }
        );
      } else {
        setFastProfileRecoveryConfig(body as never);
      }
      try {
        const { queueGithubBackupUploadAfterCriticalSave } =
          require('./githubSiteBackup') as typeof import('./githubSiteBackup');
        queueGithubBackupUploadAfterCriticalSave('fast-profile-recovery');
      } catch {
        /* optional */
      }
      res.json({ ok: true, ...getFastProfileRecoveryPublic() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/dip-buyer-recovery', (_req: Request, res: Response) => {
    try {
      const { getDipBuyerRecoveryPublic } =
        require('./dipBuyerRecovery') as typeof import('./dipBuyerRecovery');
      res.json({ ok: true, ...getDipBuyerRecoveryPublic() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/dip-buyer-recovery', (req: Request, res: Response) => {
    try {
      const {
        setDipBuyerRecoveryConfig,
        getDipBuyerRecoveryPublic,
        forceDipBuyerRecoveryStage,
        promoteDipBuyerRecoveryStage,
        demoteDipBuyerRecoveryStage,
      } = require('./dipBuyerRecovery') as typeof import('./dipBuyerRecovery');
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.forceStage != null) {
        forceDipBuyerRecoveryStage(
          Math.round(Number(body.forceStage)) as 0 | 1 | 2 | 3 | 4,
          { lock: body.lock === true }
        );
      } else if (body.promote === true) {
        promoteDipBuyerRecoveryStage();
      } else if (body.demote === true) {
        demoteDipBuyerRecoveryStage();
      } else {
        setDipBuyerRecoveryConfig(body as never);
      }
      try {
        const { queueGithubBackupUploadAfterCriticalSave } =
          require('./githubSiteBackup') as typeof import('./githubSiteBackup');
        queueGithubBackupUploadAfterCriticalSave('dip-buyer-recovery');
      } catch {
        /* optional */
      }
      res.json({ ok: true, ...getDipBuyerRecoveryPublic() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/profile-performance-trend', (req: Request, res: Response) => {
    try {
      const { buildProfilePerformanceTrend } =
        require('./profilePerformanceTrend') as typeof import('./profilePerformanceTrend');
      const profileId = String(req.query.profileId || 'scalper');
      const window = Math.max(10, Math.min(50, Number(req.query.window) || 20));
      const trend = buildProfilePerformanceTrend(profileId, window);
      res.json({ ok: true, trend });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** Trade Craft Progress — harvest/PCL + hold/TA/exit skill scores (read-only). */
  app.get('/api/trade-craft-performance', (req: Request, res: Response) => {
    try {
      const { buildTradeCraftPerformance } =
        require('./tradeCraftPerformance') as typeof import('./tradeCraftPerformance');
      const profileId = String(req.query.profileId || 'all');
      const window = Math.max(20, Math.min(100, Number(req.query.window) || 50));
      const craft = buildTradeCraftPerformance(profileId, window);
      res.json({ ok: true, craft });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/config/peak-profit-protection', (req: Request, res: Response) => {
    try {
      const { setPeakProfitProtectionConfig, getPeakProfitProtectionConfig } =
        require('./peakProfitProtection') as typeof import('./peakProfitProtection');
      const body = (req.body ?? {}) as Record<string, unknown>;
      setPeakProfitProtectionConfig({
        enabled:
          typeof body.enabled === 'boolean' ? body.enabled : undefined,
        armOfTpPct:
          body.armOfTpPct != null ? Number(body.armOfTpPct) : undefined,
        givebackOfPeakPct:
          body.givebackOfPeakPct != null
            ? Number(body.givebackOfPeakPct)
            : undefined,
        scalperArmOfTpPct:
          body.scalperArmOfTpPct != null
            ? Number(body.scalperArmOfTpPct)
            : undefined,
        scalperGivebackOfPeakPct:
          body.scalperGivebackOfPeakPct != null
            ? Number(body.scalperGivebackOfPeakPct)
            : undefined,
        stalePeakTightenSec:
          body.stalePeakTightenSec != null
            ? Number(body.stalePeakTightenSec)
            : undefined,
        staleGivebackTightenMult:
          body.staleGivebackTightenMult != null
            ? Number(body.staleGivebackTightenMult)
            : undefined,
      });
      res.json({
        ok: true,
        peakProfitProtection: getPeakProfitProtectionConfig(),
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/config/volume-intelligence', (_req: Request, res: Response) => {
    try {
      const { getVolumeIntelligenceConfig } =
        require('./volumeIntelligence') as typeof import('./volumeIntelligence');
      res.json({ ok: true, volumeIntelligence: getVolumeIntelligenceConfig() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/config/volume-intelligence', (req: Request, res: Response) => {
    try {
      const { setVolumeIntelligenceConfig, getVolumeIntelligenceConfig } =
        require('./volumeIntelligence') as typeof import('./volumeIntelligence');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const boolOrUndef = (v: unknown): boolean | undefined =>
        typeof v === 'boolean' ? v : undefined;
      const numOrUndef = (v: unknown): number | undefined =>
        v != null && Number.isFinite(Number(v)) ? Number(v) : undefined;
      setVolumeIntelligenceConfig({
        enabled: boolOrUndef(body.enabled),
        blockCollapsedOnFastProfiles: boolOrUndef(
          body.blockCollapsedOnFastProfiles
        ),
        fastMinVolumeM5Usd: numOrUndef(body.fastMinVolumeM5Usd),
        fastMinVolumeH1Usd: numOrUndef(body.fastMinVolumeH1Usd),
        healthyM5Usd: numOrUndef(body.healthyM5Usd),
        healthyH1Usd: numOrUndef(body.healthyH1Usd),
        strongM5Usd: numOrUndef(body.strongM5Usd),
        strongH1Usd: numOrUndef(body.strongH1Usd),
        shortTermDecayRatio: numOrUndef(body.shortTermDecayRatio),
        postSpikeDropRatio: numOrUndef(body.postSpikeDropRatio),
        collapseAbsM5Usd: numOrUndef(body.collapseAbsM5Usd),
        collapseAbsH1Usd: numOrUndef(body.collapseAbsH1Usd),
        decayTightenMult: numOrUndef(body.decayTightenMult),
        collapseTightenMult: numOrUndef(body.collapseTightenMult),
        exitUrgencyOnDecay: boolOrUndef(body.exitUrgencyOnDecay),
        divergenceEnabled: boolOrUndef(body.divergenceEnabled),
        divergenceVolDropRatio: numOrUndef(body.divergenceVolDropRatio),
        divergenceMinSwingPct: numOrUndef(body.divergenceMinSwingPct),
        exitUrgencyOnBearishDivergence: boolOrUndef(
          body.exitUrgencyOnBearishDivergence
        ),
        learningAdjustEnabled: boolOrUndef(body.learningAdjustEnabled),
        profileSoft:
          body.profileSoft != null && typeof body.profileSoft === 'object'
            ? (body.profileSoft as Record<
                string,
                {
                  decaySensitivity?: number;
                  entryDecayWeight?: number;
                  exitUrgencyMult?: number;
                  divergenceWeight?: number;
                }
              >)
            : undefined,
      });
      res.json({
        ok: true,
        volumeIntelligence: getVolumeIntelligenceConfig(),
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get(
    '/api/config/hierarchical-coordination',
    (_req: Request, res: Response) => {
      try {
        const { getHierarchicalCoordinationConfig } =
          require('./hierarchicalCoordination') as typeof import('./hierarchicalCoordination');
        res.json({
          ok: true,
          hierarchicalCoordination: getHierarchicalCoordinationConfig(),
        });
      } catch (err) {
        res.status(500).json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  app.post(
    '/api/config/hierarchical-coordination',
    (req: Request, res: Response) => {
      try {
        const {
          setHierarchicalCoordinationConfig,
          getHierarchicalCoordinationConfig,
        } =
          require('./hierarchicalCoordination') as typeof import('./hierarchicalCoordination');
        const body = (req.body ?? {}) as Record<string, unknown>;
        const boolOrUndef = (v: unknown): boolean | undefined =>
          typeof v === 'boolean' ? v : undefined;
        const numOrUndef = (v: unknown): number | undefined =>
          v != null && Number.isFinite(Number(v)) ? Number(v) : undefined;
        const strictness =
          body.gatekeeperStrictness === 'low' ||
          body.gatekeeperStrictness === 'medium' ||
          body.gatekeeperStrictness === 'high'
            ? body.gatekeeperStrictness
            : undefined;
        const debugLogging =
          body.debugLogging === 'off' ||
          body.debugLogging === 'normal' ||
          body.debugLogging === 'verbose'
            ? body.debugLogging
            : undefined;
        setHierarchicalCoordinationConfig({
          enabled: boolOrUndef(body.enabled),
          gatekeeperEnabled: boolOrUndef(body.gatekeeperEnabled),
          gatekeeperStrictness: strictness,
          softBlocksEnforced: boolOrUndef(body.softBlocksEnforced),
          minVolumeM5Usd: numOrUndef(body.minVolumeM5Usd),
          minVolumeH1Usd: numOrUndef(body.minVolumeH1Usd),
          minLiquidityUsd: numOrUndef(body.minLiquidityUsd),
          debugLogging,
          classifierEnabled: boolOrUndef(body.classifierEnabled),
          unknownSetupsCanTrade: boolOrUndef(body.unknownSetupsCanTrade),
          classifierSoftEligibility: boolOrUndef(body.classifierSoftEligibility),
        });
        try {
          const { queueGithubBackupUploadAfterCriticalSave } =
            require('./githubSiteBackup') as typeof import('./githubSiteBackup');
          queueGithubBackupUploadAfterCriticalSave('hierarchical-coordination');
        } catch {
          /* optional */
        }
        res.json({
          ok: true,
          hierarchicalCoordination: getHierarchicalCoordinationConfig(),
        });
      } catch (err) {
        res.status(500).json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  app.get('/api/profile-ta-playbooks', (_req: Request, res: Response) => {
    try {
      const { getProfileTaPlaybooksPublic } =
        require('./profileTaPlaybookStore') as typeof import('./profileTaPlaybookStore');
      const { PROFILE_TA_TOOL_LABELS, PROFILE_TA_TOOL_IDS } =
        require('./profileTaPlaybook') as typeof import('./profileTaPlaybook');
      res.json({
        ok: true,
        ...getProfileTaPlaybooksPublic(),
        toolIds: PROFILE_TA_TOOL_IDS,
        toolLabels: PROFILE_TA_TOOL_LABELS,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/profile-ta-playbooks', (req: Request, res: Response) => {
    try {
      const {
        updateProfileTaPlaybook,
        resetProfileTaPlaybook,
        resetAllProfileTaPlaybooks,
        getProfileTaPlaybooksPublic,
        rollbackProfileTaLearned,
      } = require('./profileTaPlaybookStore') as typeof import('./profileTaPlaybookStore');
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.resetAll === true) {
        resetAllProfileTaPlaybooks();
        res.json({ ok: true, ...getProfileTaPlaybooksPublic() });
        return;
      }
      const profileId = String(body.profileId || '').trim();
      if (!profileId) {
        res.status(400).json({ ok: false, error: 'profileId required' });
        return;
      }
      if (body.rollbackLearned === true) {
        const result = rollbackProfileTaLearned(profileId);
        res.json({
          ok: result.ok,
          rollback: result,
          playbook: result.playbook,
          ...getProfileTaPlaybooksPublic(),
        });
        return;
      }
      if (body.reset === true) {
        const playbook = resetProfileTaPlaybook(profileId);
        res.json({ ok: true, playbook, ...getProfileTaPlaybooksPublic() });
        return;
      }
      const patch = (body.playbook || body.patch || body) as Record<string, unknown>;
      const playbook = updateProfileTaPlaybook(profileId, {
        taMode: patch.taMode as 'off' | 'soft' | 'hard' | undefined,
        whaleMode: patch.whaleMode as 'off' | 'soft' | 'hard' | undefined,
        minConfluenceScore:
          patch.minConfluenceScore != null
            ? Number(patch.minConfluenceScore)
            : undefined,
        learningEnabled:
          typeof patch.learningEnabled === 'boolean'
            ? patch.learningEnabled
            : undefined,
        timeframes: Array.isArray(patch.timeframes)
          ? (patch.timeframes as ('5m' | '15m' | '1h' | '4h')[])
          : undefined,
        entryTools: patch.entryTools as never,
        exitTools: patch.exitTools as never,
        heikinAshi: patch.heikinAshi as never,
        supportResistance: patch.supportResistance as never,
        learned: patch.learned as never,
      });
      res.json({ ok: true, playbook, ...getProfileTaPlaybooksPublic() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/zion/agent', (_req: Request, res: Response) => {
    try {
      const {
        getZionAgentStatus,
        loadZionAgentState,
        listPendingZionImprovements,
        listZionImprovementHistory,
      } = require('./zionAgent') as typeof import('./zionAgent');
      const { formatFamilyMemoryForPrompt } =
        require('./zionFamilyMemory') as typeof import('./zionFamilyMemory');
      const { getZionSupervisionStatus } =
        require('./zionSupervision') as typeof import('./zionSupervision');
      const st = loadZionAgentState();
      const pending = listPendingZionImprovements();
      const history = listZionImprovementHistory(40);
      const status = getZionAgentStatus();
      const supervision = getZionSupervisionStatus();
      let learning = status.learning;
      try {
        if (!learning) {
          const { getZionLearningStatus } =
            require('./zionContinuousLearning') as typeof import('./zionContinuousLearning');
          learning = getZionLearningStatus();
        }
      } catch {
        /* optional */
      }
      let ambientNudges = status.ambientNudges;
      try {
        const { getZionAmbientNudgeStatus } =
          require('./zionAmbientNudges') as typeof import('./zionAmbientNudges');
        ambientNudges = {
          ...getZionAmbientNudgeStatus(),
          ...(ambientNudges || {}),
        };
      } catch {
        /* optional */
      }
      res.json({
        ok: true,
        status,
        familyMemory: {
          summary: formatFamilyMemoryForPrompt().slice(0, 1200),
          score: status.familyMemoryScore,
        },
        supervision,
        learning,
        ambientNudges,
        messages: st.messages.slice(-40),
        changeRequests: st.changeRequests.slice(0, 40),
        improvementRequests: pending,
        improvementHistory: history,
        pendingImprovementCount: pending.length,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  const sendZionSupervisionStatus = (_req: Request, res: Response) => {
    try {
      const { getZionSupervisionStatus, runZionSupervisionCheck } =
        require('./zionSupervision') as typeof import('./zionSupervision');
      const force = String((_req.query ?? {}).force || '') === '1';
      const snap = force ? runZionSupervisionCheck() : null;
      const status = getZionSupervisionStatus();
      res.json({
        ok: true,
        ...status,
        state: status.classification,
        lastRun: snap
          ? {
              classification: snap.classification,
              issues: snap.issues,
              at: snap.lastCheckAt,
            }
          : undefined,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  app.get('/api/zion/supervision', sendZionSupervisionStatus);
  app.get('/api/health/system', sendZionSupervisionStatus);

  app.get(
    '/api/zion/agent/improvements/:id',
    (req: Request, res: Response) => {
      try {
        const { getZionChangeRequest } =
          require('./zionAgentStore') as typeof import('./zionAgentStore');
        const row = getZionChangeRequest(String(req.params.id));
        if (!row) {
          res.status(404).json({ ok: false, error: 'Not found' });
          return;
        }
        res.json({ ok: true, request: row });
      } catch (err) {
        res.status(500).json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  app.post('/api/zion/agent/config', (req: Request, res: Response) => {
    try {
      const { setZionSemiAutonomous, getZionAgentStatus } =
        require('./zionAgent') as typeof import('./zionAgent');
      const { persistUserSettings, config: cfg } =
        require('./config') as typeof import('./config');
      const body = (req.body ?? {}) as {
        semiAutonomous?: boolean;
        personalityEnabled?: boolean;
        supervisionEnabled?: boolean;
        fightLogCommentsEnabled?: boolean;
        supervisionEmailEnabled?: boolean;
        ambientNudges?: {
          marketUpdatesEnabled?: boolean;
          trendingNudgesEnabled?: boolean;
          weatherNudgesEnabled?: boolean;
        };
      };
      if (typeof body.semiAutonomous === 'boolean') {
        setZionSemiAutonomous(body.semiAutonomous);
      }
      const prevAmbient = cfg.zionAgent?.ambientNudges;
      cfg.zionAgent = {
        semiAutonomous:
          typeof body.semiAutonomous === 'boolean'
            ? body.semiAutonomous
            : cfg.zionAgent?.semiAutonomous === true,
        personalityEnabled:
          typeof body.personalityEnabled === 'boolean'
            ? body.personalityEnabled
            : cfg.zionAgent?.personalityEnabled !== false,
        supervisionEnabled:
          typeof body.supervisionEnabled === 'boolean'
            ? body.supervisionEnabled
            : cfg.zionAgent?.supervisionEnabled !== false,
        fightLogCommentsEnabled:
          typeof body.fightLogCommentsEnabled === 'boolean'
            ? body.fightLogCommentsEnabled
            : cfg.zionAgent?.fightLogCommentsEnabled !== false,
        supervisionEmailEnabled:
          typeof body.supervisionEmailEnabled === 'boolean'
            ? body.supervisionEmailEnabled
            : cfg.zionAgent?.supervisionEmailEnabled !== false,
        healthCheckIntervalMsHealthy:
          Number(cfg.zionAgent?.healthCheckIntervalMsHealthy) || 900_000,
        healthCheckIntervalMsWatch:
          Number(cfg.zionAgent?.healthCheckIntervalMsWatch) || 600_000,
        healthCheckIntervalMsAction:
          Number(cfg.zionAgent?.healthCheckIntervalMsAction) || 300_000,
        ambientNudges: {
          marketUpdatesEnabled:
            typeof body.ambientNudges?.marketUpdatesEnabled === 'boolean'
              ? body.ambientNudges.marketUpdatesEnabled
              : prevAmbient?.marketUpdatesEnabled !== false,
          trendingNudgesEnabled:
            typeof body.ambientNudges?.trendingNudgesEnabled === 'boolean'
              ? body.ambientNudges.trendingNudgesEnabled
              : prevAmbient?.trendingNudgesEnabled !== false,
          weatherNudgesEnabled:
            typeof body.ambientNudges?.weatherNudgesEnabled === 'boolean'
              ? body.ambientNudges.weatherNudgesEnabled
              : prevAmbient?.weatherNudgesEnabled !== false,
        },
      };
      if (typeof body.semiAutonomous === 'boolean') {
        setZionSemiAutonomous(body.semiAutonomous);
      }
      persistUserSettings();
      res.json({ ok: true, status: getZionAgentStatus() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** Archive live chat to DATA_DIR/zion-chat-archives.json, then clear the thread. */
  app.post('/api/zion/agent/clear-chat', (_req: Request, res: Response) => {
    try {
      const { clearZionChat, listZionChatArchives } =
        require('./zionAgentStore') as typeof import('./zionAgentStore');
      const result = clearZionChat();
      res.json({
        ok: true,
        ...result,
        archives: listZionChatArchives(10),
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/zion/agent/chat', async (req: Request, res: Response) => {
    try {
      const { zionAgentChat } =
        require('./zionAgent') as typeof import('./zionAgent');
      const body = (req.body ?? {}) as {
        message?: string;
        timeZone?: string;
        location?: {
          lat?: number;
          lon?: number;
          accuracy?: number;
          at?: number;
          source?: string;
          areaLabel?: string;
        };
      };
      const text = String(body.message || '');
      const locRaw = body.location;
      const lat = locRaw != null ? Number(locRaw.lat) : NaN;
      const lon = locRaw != null ? Number(locRaw.lon) : NaN;
      let location: {
        lat: number;
        lon: number;
        accuracy?: number;
        at: number;
        source: 'device' | 'fallback' | 'denied';
        areaLabel?: string;
      } | null = null;
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        const src =
          locRaw?.source === 'fallback' || locRaw?.source === 'denied'
            ? locRaw.source
            : 'device';
        const areaLabel = String((locRaw as { areaLabel?: string })?.areaLabel || '')
          .trim()
          .slice(0, 120);
        location = {
          lat,
          lon,
          accuracy:
            locRaw?.accuracy != null && Number.isFinite(Number(locRaw.accuracy))
              ? Number(locRaw.accuracy)
              : undefined,
          at:
            locRaw?.at != null && Number.isFinite(Number(locRaw.at))
              ? Number(locRaw.at)
              : Date.now(),
          source: src,
          areaLabel: areaLabel || undefined,
        };
      }
      const timeZone = String(body.timeZone || '').trim().slice(0, 80) || undefined;
      const out = await zionAgentChat(text, { location, timeZone });
      res.json({ ok: true, ...out });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/zion/feedback', (req: Request, res: Response) => {
    try {
      const { recordZionFeedback } =
        require('./zionContinuousLearning') as typeof import('./zionContinuousLearning');
      const body = (req.body ?? {}) as {
        messageId?: string;
        signal?: string;
      };
      const signal = String(body.signal || '');
      if (
        signal !== 'good' &&
        signal !== 'too_technical' &&
        signal !== 'forgot_context' &&
        signal !== 'better'
      ) {
        res.status(400).json({ ok: false, error: 'Invalid signal' });
        return;
      }
      const out = recordZionFeedback({
        messageId: String(body.messageId || ''),
        signal,
      });
      res.json(out);
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/zion/personality/rollback', (req: Request, res: Response) => {
    try {
      const { rollbackPersonality, getZionLearningStatus } =
        require('./zionContinuousLearning') as typeof import('./zionContinuousLearning');
      const toVersion = (req.body ?? {}).toVersion;
      const out = rollbackPersonality(
        toVersion != null ? Number(toVersion) : undefined
      );
      res.json({
        ...out,
        learning: getZionLearningStatus(),
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/zion/transfers/status', (_req: Request, res: Response) => {
    try {
      const { getZionTransferStatusPublic, ensureSeededWallets } =
        require('./zionWalletTransfer') as typeof import('./zionWalletTransfer');
      ensureSeededWallets();
      res.json({ ok: true, ...getZionTransferStatusPublic() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/config/zion-transfers', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { ensureSeededWallets } =
        require('./zionWalletTransfer') as typeof import('./zionWalletTransfer');
      ensureSeededWallets();
      const zt = config.zionTransfers;
      if (typeof body.enabled === 'boolean') zt.enabled = body.enabled;
      if (body.confirmThresholdSol != null && Number.isFinite(Number(body.confirmThresholdSol))) {
        zt.confirmThresholdSol = Math.max(0.01, Math.min(100, Number(body.confirmThresholdSol)));
      }
      if (body.maxSingleTransferSol != null && Number.isFinite(Number(body.maxSingleTransferSol))) {
        zt.maxSingleTransferSol = Math.max(0.01, Math.min(100, Number(body.maxSingleTransferSol)));
      }
      if (body.dailyTransferCapSol != null && Number.isFinite(Number(body.dailyTransferCapSol))) {
        zt.dailyTransferCapSol = Math.max(0.01, Math.min(500, Number(body.dailyTransferCapSol)));
      }
      if (body.cooldownMs != null && Number.isFinite(Number(body.cooldownMs))) {
        zt.cooldownMs = Math.max(5_000, Math.min(3_600_000, Number(body.cooldownMs)));
      }
      if (typeof body.defaultSavingsWalletId === 'string' && body.defaultSavingsWalletId.trim()) {
        zt.defaultSavingsWalletId = body.defaultSavingsWalletId.trim();
      }
      if (Array.isArray(body.savedWallets)) {
        const next = (body.savedWallets as Array<Record<string, unknown>>)
          .map((w) => ({
            id: String(w.id || '').trim() || 'wallet',
            name: String(w.name || '').trim() || 'Wallet',
            address: String(w.address || '').trim(),
            aliases: Array.isArray(w.aliases)
              ? w.aliases.map((a) => String(a)).filter(Boolean)
              : [],
            allowSendTo: w.allowSendTo === true,
          }))
          .filter((w) => w.address.length >= 32);
        if (next.length > 0) zt.savedWallets = next;
      }
      ensureSeededWallets();
      const ok = persistUserSettings();
      if (ok) {
        try {
          const { queueGithubBackupUploadAfterCriticalSave } =
            require('./githubSiteBackup') as typeof import('./githubSiteBackup');
          queueGithubBackupUploadAfterCriticalSave('zion-transfers');
        } catch {
          /* optional */
        }
      }
      const { getZionTransferStatusPublic } =
        require('./zionWalletTransfer') as typeof import('./zionWalletTransfer');
      res.json({ ok, ...getZionTransferStatusPublic() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post(
    '/api/zion/agent/change-requests/:id/decide',
    (req: Request, res: Response) => {
      try {
        const { zionAgentDecideChangeRequest } =
          require('./zionAgent') as typeof import('./zionAgent');
        const approve = (req.body ?? {}).approve === true;
        const out = zionAgentDecideChangeRequest(String(req.params.id), approve);
        res.json(out);
      } catch (err) {
        res.status(500).json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  app.get('/api/strategies', (_req: Request, res: Response) => {
    const { getStrategiesStatus, ensureStrategyToggles } = require('./strategies') as typeof import('./strategies');
    ensureStrategyToggles();
    const { getTradeProfilesStatus, ensureTradeProfilesInitialized } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    ensureTradeProfilesInitialized();
    res.json({
      ...getStrategiesStatus(),
      tradeProfiles: getTradeProfilesStatus(),
    });
  });

  app.get('/api/trade-profiles', (_req: Request, res: Response) => {
    const { getTradeProfilesStatus, ensureTradeProfilesInitialized } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    ensureTradeProfilesInitialized();
    res.json(getTradeProfilesStatus());
  });

  /** Lightweight dip + graduation + scalper-family watchlist status for Micro Bots UI. */
  app.get('/api/setup-watches', (_req: Request, res: Response) => {
    try {
      const { getDipSetupWatchStatus } =
        require('./dipSetupWatch') as typeof import('./dipSetupWatch');
      const { getMigrationGradWatchStatus, getMigrationSniperFunnel } =
        require('./migrationGradWatch') as typeof import('./migrationGradWatch');
      const { getScalperSetupWatchStatus } =
        require('./scalperSetupWatch') as typeof import('./scalperSetupWatch');
      res.json({
        dipWatch: getDipSetupWatchStatus(16),
        gradWatch: getMigrationGradWatchStatus(16),
        scalperWatch: getScalperSetupWatchStatus(16),
        migSniperFunnel: getMigrationSniperFunnel(),
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        dipWatch: { active: 0, entries: [] },
        gradWatch: { active: 0, entries: [] },
        scalperWatch: { active: 0, entries: [] },
        migSniperFunnel: null,
      });
    }
  });

  /** Manual unwatch from Micro Bots setup watchlists (15m bot re-add cooldown). */
  app.post('/api/setup-watches/unwatch', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const kind = String(body.kind || '').trim().toLowerCase();
      const mint = String(body.mint || '').trim();
      if (!mint) {
        res.status(400).json({ ok: false, error: 'mint required' });
        return;
      }
      if (kind === 'dip' || kind === 'dip_buyer') {
        const { unwatchDipSetup } =
          require('./dipSetupWatch') as typeof import('./dipSetupWatch');
        res.json(unwatchDipSetup(mint));
        return;
      }
      if (
        kind === 'grad' ||
        kind === 'graduation' ||
        kind === 'migration' ||
        kind === 'migration_sniper'
      ) {
        const { unwatchMigrationGrad } =
          require('./migrationGradWatch') as typeof import('./migrationGradWatch');
        res.json(unwatchMigrationGrad(mint));
        return;
      }
      if (
        kind === 'scalper' ||
        kind === 'scalper_family' ||
        kind === 'momentum_burst' ||
        kind === 'reversal_scalper'
      ) {
        const { unwatchScalperSetup } =
          require('./scalperSetupWatch') as typeof import('./scalperSetupWatch');
        res.json(unwatchScalperSetup(mint));
        return;
      }
      res
        .status(400)
        .json({ ok: false, error: 'kind must be dip, grad, or scalper' });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/lane-decisions', (req: Request, res: Response) => {
    const limit = Math.max(
      1,
      Math.min(200, Number(req.query.limit) || 40)
    );
    res.json({ decisions: getLaneDecisionLog(limit) });
  });

  app.get('/api/agent-decisions', (req: Request, res: Response) => {
    try {
      const { listAgentDecisions } =
        require('./agentDecisionLog') as typeof import('./agentDecisionLog');
      const q = req.query || {};
      const range = String(q.range || q.window || '').toLowerCase();
      let since = Number(q.since) || 0;
      if (!since && range && range !== 'all') {
        const now = Date.now();
        if (range === '1h') since = now - 3600_000;
        else if (range === '24h') since = now - 86_400_000;
        else if (range === '7d') since = now - 7 * 86_400_000;
      }
      const decisions = listAgentDecisions({
        limit: Number(q.limit) || 50,
        source: String(q.source || '') || undefined,
        profileId: String(q.profileId || q.profile || '') || undefined,
        decisionType: String(q.decisionType || q.type || '') || undefined,
        applied: String(q.applied || '') || undefined,
        since: since || undefined,
        until: Number(q.until) || undefined,
      });
      res.json({ ok: true, decisions, generatedAt: Date.now() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/trade-profiles/intelligence', (req: Request, res: Response) => {
    try {
      const { parsePerformanceWindow } =
        require('./microBotPerformance') as typeof import('./microBotPerformance');
      const includePerformance =
        String(req.query.includePerformance || '') === '1' ||
        String(req.query.includePerformance || '') === 'true';
      const window = parsePerformanceWindow(req.query.window, '7d');
      const intel = paperTrader.getTradeProfileIntelligence({
        performanceWindow: window,
        includePerformance,
      });
      res.json(intel);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/trade-profiles/performance', (req: Request, res: Response) => {
    try {
      const { parsePerformanceWindow } =
        require('./microBotPerformance') as typeof import('./microBotPerformance');
      const window = parsePerformanceWindow(req.query.window, '7d');
      const performance = paperTrader.getMicroBotPerformance(window);
      res.json({ ok: true, performance });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/learning-diagnostics', (_req: Request, res: Response) => {
    try {
      const { getLearningSystemDiagnostics } =
        require('./learningSystemDiagnostics') as typeof import('./learningSystemDiagnostics');
      const diagnostics = getLearningSystemDiagnostics();
      res.json({ ok: true, diagnostics });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/trade-profiles/learning', (req: Request, res: Response) => {
    const {
      applyTradeProfileLearning,
      applyStabilizedQualityEntryTightenments,
      getTradeProfilesStatus,
      ensureTradeProfilesInitialized,
      setProfileSelfLearningEnabled,
      setProfileLearningModeOptIn,
      applyProfileSelfLearnProposal,
      rejectProfileSelfLearnProposal,
      resetProfileSelfLearning,
      setProfileSelfLearningMinTrades,
      evaluateProfileSelfLearn,
      setProfileSelfLearningMlMode,
    } = require('./tradeProfiles') as typeof import('./tradeProfiles');
    ensureTradeProfilesInitialized();
    const body = (req.body ?? {}) as {
      applyAll?: boolean;
      applyStabilizedEntries?: boolean;
      profileId?: string;
      selfLearningEnabled?: boolean;
      selfLearningMode?: 'shadow' | 'auto';
      selfLearningMlMode?: 'off' | 'shadow' | 'hybrid' | 'lead';
      /** Per-profile Participate in Learning Mode (distinct from Self-Learning). */
      learningModeOptIn?: boolean;
      minTrades?: number;
      applySelfLearnProposal?: boolean;
      rejectSelfLearnProposal?: boolean;
      evaluateSelfLearn?: boolean;
      resetSelfLearning?: boolean;
      wipeEpisodes?: boolean;
      resetParams?: boolean;
      suggestion?: {
        patch?: {
          exitRules?: Record<string, unknown>;
          match?: Record<string, number | boolean>;
        };
        entryTighten?: Record<string, number | boolean>;
      };
    };
    try {
      if (body.profileId && typeof body.learningModeOptIn === 'boolean') {
        setProfileLearningModeOptIn(body.profileId, body.learningModeOptIn);
        res.json({
          ok: true,
          tradeProfiles: getTradeProfilesStatus(),
          intelligence: paperTrader.getTradeProfileIntelligence(),
        });
        return;
      }
      if (
        body.profileId &&
        body.selfLearningMlMode &&
        typeof body.selfLearningEnabled !== 'boolean'
      ) {
        setProfileSelfLearningMlMode(body.profileId, body.selfLearningMlMode);
        res.json({
          ok: true,
          tradeProfiles: getTradeProfilesStatus(),
          intelligence: paperTrader.getTradeProfileIntelligence(),
        });
        return;
      }
      if (body.profileId && typeof body.selfLearningEnabled === 'boolean') {
        setProfileSelfLearningEnabled(
          body.profileId,
          body.selfLearningEnabled,
          body.selfLearningMode
        );
        if (body.selfLearningMlMode) {
          setProfileSelfLearningMlMode(body.profileId, body.selfLearningMlMode);
        }
        if (body.minTrades != null && Number.isFinite(Number(body.minTrades))) {
          setProfileSelfLearningMinTrades(body.profileId, Number(body.minTrades));
        }
        res.json({
          ok: true,
          tradeProfiles: getTradeProfilesStatus(),
          intelligence: paperTrader.getTradeProfileIntelligence(),
        });
        return;
      }
      if (
        body.profileId &&
        body.minTrades != null &&
        Number.isFinite(Number(body.minTrades))
      ) {
        setProfileSelfLearningMinTrades(body.profileId, Number(body.minTrades));
        res.json({
          ok: true,
          tradeProfiles: getTradeProfilesStatus(),
          intelligence: paperTrader.getTradeProfileIntelligence(),
        });
        return;
      }
      if (body.profileId && body.applySelfLearnProposal) {
        applyProfileSelfLearnProposal(body.profileId);
        res.json({
          ok: true,
          tradeProfiles: getTradeProfilesStatus(),
          intelligence: paperTrader.getTradeProfileIntelligence(),
        });
        return;
      }
      if (body.profileId && body.rejectSelfLearnProposal) {
        rejectProfileSelfLearnProposal(body.profileId);
        res.json({ ok: true, tradeProfiles: getTradeProfilesStatus() });
        return;
      }
      if (body.profileId && body.evaluateSelfLearn) {
        const evaluated = evaluateProfileSelfLearn(body.profileId);
        res.json({
          ok: true,
          result: evaluated.result,
          message: evaluated.message,
          proposalSummary: evaluated.proposalSummary,
          nearMiss: evaluated.nearMiss ?? null,
          lastMutation: evaluated.lastMutation ?? null,
          nextEligibleIn: evaluated.nextEligibleIn ?? 0,
          mlAdvice: evaluated.mlAdvice ?? null,
          mlMode: evaluated.mlMode ?? 'shadow',
          tradeProfiles: evaluated.status,
          intelligence: paperTrader.getTradeProfileIntelligence(),
        });
        return;
      }
      if (body.profileId && body.resetSelfLearning) {
        resetProfileSelfLearning(body.profileId, {
          wipeEpisodes: body.wipeEpisodes === true,
          resetParams: body.resetParams === true,
        });
        res.json({ ok: true, tradeProfiles: getTradeProfilesStatus() });
        return;
      }

      const intel = paperTrader.getTradeProfileIntelligence();
      const applied: string[] = [];
      if (body.applyStabilizedEntries) {
        applied.push(
          ...applyStabilizedQualityEntryTightenments(intel.suggestions)
        );
      }
      if (body.applyAll) {
        for (const s of intel.suggestions) {
          applyTradeProfileLearning(s.profileId, s);
          applied.push(s.profileId);
        }
      } else if (body.profileId && body.suggestion) {
        applyTradeProfileLearning(body.profileId, body.suggestion);
        applied.push(body.profileId);
      } else if (body.profileId) {
        const hit = intel.suggestions.find((s) => s.profileId === body.profileId);
        if (hit) {
          applyTradeProfileLearning(body.profileId, hit);
          applied.push(body.profileId);
        }
      }
      res.json({
        ok: true,
        applied: [...new Set(applied)],
        tradeProfiles: getTradeProfilesStatus(),
        intelligence: paperTrader.getTradeProfileIntelligence(),
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/trade-profiles', (req: Request, res: Response) => {
    const {
      updateTradeProfilesConfig,
      setTradeProfileEnabled,
      updateTradeProfileParams,
      resetTradeProfileParams,
      updateAutoScoringConfig,
      getTradeProfilesStatus,
      ensureTradeProfilesInitialized,
    } = require('./tradeProfiles') as typeof import('./tradeProfiles');
    ensureTradeProfilesInitialized();
    const body = (req.body ?? {}) as {
      enabled?: boolean;
      smartBotProfiles?: boolean;
      profiles?: Record<string, boolean>;
      globalTakeProfit?: { enabled?: boolean; takeProfitPct?: number };
      id?: string;
      profileEnabled?: boolean;
      params?: {
        exitRules?: Record<string, unknown>;
        match?: Record<string, unknown>;
        modules?: Record<string, boolean>;
      };
      resetParams?: boolean | 'all';
      autoScoring?: Record<string, unknown>;
    };
    if (body.autoScoring && typeof body.autoScoring === 'object') {
      updateAutoScoringConfig(
        body.autoScoring as unknown as import('./tradeProfiles').AutoScoringConfig
      );
    } else if (body.resetParams === 'all') {
      resetTradeProfileParams('all');
    } else if (body.id != null && body.resetParams === true) {
      resetTradeProfileParams(
        body.id as import('./tradeProfiles').TradeProfileId
      );
    } else if (body.id != null && body.params && typeof body.params === 'object') {
      updateTradeProfileParams(
        body.id as import('./tradeProfiles').TradeProfileId,
        {
          exitRules: body.params.exitRules as
            | import('./tradeProfiles').TradeProfileExitRules
            | undefined,
          match: body.params.match as
            | import('./tradeProfiles').TradeProfileMatchRules
            | undefined,
          modules: body.params.modules as
            | import('./tradeProfiles').TradeProfileModules
            | undefined,
        }
      );
    } else if (body.id != null && typeof body.profileEnabled === 'boolean') {
      setTradeProfileEnabled(
        body.id as import('./tradeProfiles').TradeProfileId,
        body.profileEnabled
      );
    } else {
      updateTradeProfilesConfig({
        enabled: body.enabled,
        smartBotProfiles: body.smartBotProfiles,
        profiles: body.profiles as
          | Partial<Record<import('./tradeProfiles').TradeProfileId, boolean>>
          | undefined,
        globalTakeProfit: body.globalTakeProfit,
      });
    }
    res.json({ ok: true, ...getTradeProfilesStatus() });
  });

  app.post('/api/strategies', (req: Request, res: Response) => {
    const {
      updateStrategyToggles,
      setAllStrategyToggles,
      applyStrategyPreset,
      restorePreviousStrategyProfile,
      getStrategiesStatus,
      isStrategyKey,
      getStrategyDefinition,
      isNamedStrategyProfile,
    } = require('./strategies') as typeof import('./strategies');

    const body = (req.body ?? {}) as {
      toggles?: Record<string, boolean>;
      key?: string;
      enabled?: boolean;
      action?:
        | 'set'
        | 'enable_all'
        | 'disable_all'
        | 'high_win_rate'
        | 'win_rate_55_60'
        | 'balanced'
        | 'aggressive'
        | 'quick_scalper'
        | 'micro_scalper'
        | 'momentum_burst'
        | 'post_migration_scalp'
        | 'reversal_scalp'
        | 'scalper_suite'
        | 'aggressive_scalper'
        | 'conservative_scalper'
        | 'restore'
        | 'reset_recipe';
      profile?: string;
    };

    const action = body.action || 'set';

    if (action === 'reset_recipe') {
      const {
        resetStrategyRecipeToRisk,
        getStrategiesStatus,
      } = require('./strategies') as typeof import('./strategies');
      const applied = resetStrategyRecipeToRisk();
      res.json({ ok: true, applied, ...getStrategiesStatus() });
      return;
    }

    if (action === 'enable_all') {
      setAllStrategyToggles(true);
      res.json({ ok: true, ...getStrategiesStatus() });
      return;
    }
    if (action === 'disable_all') {
      setAllStrategyToggles(false);
      res.json({ ok: true, ...getStrategiesStatus() });
      return;
    }

    const presetId =
      action === 'high_win_rate' ||
      action === 'win_rate_55_60' ||
      action === 'balanced' ||
      action === 'aggressive' ||
      action === 'quick_scalper' ||
      action === 'micro_scalper' ||
      action === 'momentum_burst' ||
      action === 'post_migration_scalp' ||
      action === 'reversal_scalp' ||
      action === 'scalper_suite' ||
      action === 'aggressive_scalper' ||
      action === 'conservative_scalper'
        ? action
        : isNamedStrategyProfile(body.profile)
          ? body.profile
          : null;
    if (presetId) {
      const result = applyStrategyPreset(presetId);
      res.json({
        ok: true,
        ...getStrategiesStatus(),
        applied: result,
        warning: result.warning,
      });
      return;
    }

    if (action === 'restore') {
      const restored = restorePreviousStrategyProfile();
      res.json({ ok: restored.ok, message: restored.message, ...getStrategiesStatus() });
      return;
    }

    // Single toggle or partial map
    const partial: Record<string, boolean> = {};
    if (body.key && typeof body.enabled === 'boolean') {
      if (!isStrategyKey(body.key)) {
        res.status(400).json({ error: `Unknown strategy key: ${body.key}` });
        return;
      }
      const def = getStrategyDefinition(body.key);
      if (def?.criticalSafety && body.enabled === false) {
        // Allow — UI already confirmed; server trusts client confirm
      }
      partial[body.key] = body.enabled;
    }
    if (body.toggles && typeof body.toggles === 'object') {
      for (const [k, v] of Object.entries(body.toggles)) {
        if (isStrategyKey(k) && typeof v === 'boolean') partial[k] = v;
      }
    }
    if (Object.keys(partial).length === 0) {
      res.status(400).json({
        error:
          'Provide action (enable_all|disable_all|reset_recipe|high_win_rate|win_rate_55_60|balanced|aggressive|quick_scalper|micro_scalper|momentum_burst|post_migration_scalp|reversal_scalp|scalper_suite|aggressive_scalper|conservative_scalper|restore) or key/enabled or toggles',
      });
      return;
    }
    updateStrategyToggles(partial);
    res.json({ ok: true, ...getStrategiesStatus() });
  });

  /** Download Strategy Control Center toggles + internal settings as JSON. */
  app.get('/api/strategies/export', (req: Request, res: Response) => {
    const {
      exportStrategyModulesBundle,
    } = require('./strategies') as typeof import('./strategies');
    const label =
      typeof req.query.label === 'string' && req.query.label.trim()
        ? req.query.label.trim().slice(0, 120)
        : undefined;
    const bundle = exportStrategyModulesBundle({ label });
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="strategy-modules-${day}.json"`
    );
    res.send(JSON.stringify(bundle, null, 2));
  });

  /** Import Strategy Control Center JSON (toggles + settings + trade profiles). */
  app.post('/api/strategies/import', (req: Request, res: Response) => {
    const {
      importStrategyModulesBundle,
      getStrategiesStatus,
    } = require('./strategies') as typeof import('./strategies');
    const { getTradeProfilesStatus, ensureTradeProfilesInitialized } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Accept either raw export object or { bundle: export }
      const payload =
        body && typeof body === 'object' && body.bundle && typeof body.bundle === 'object'
          ? body.bundle
          : body;
      const result = importStrategyModulesBundle(payload);
      ensureTradeProfilesInitialized();
      res.json({
        ...getStrategiesStatus(),
        tradeProfiles: getTradeProfilesStatus(),
        import: result,
        ok: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ ok: false, error: message });
    }
  });

  /**
   * Strategy-scoped reset: modules + Trade Profiles → code/catalog defaults,
   * Risk On lean recipe. Does not wipe wallets / paper / backtest history.
   */
  app.post('/api/strategies/reset-defaults', (req: Request, res: Response) => {
    try {
      const {
        resetStrategyModulesToDefaults,
        getStrategiesStatus,
        ensureStrategyToggles,
      } = require('./strategies') as typeof import('./strategies');
      const { getTradeProfilesStatus, ensureTradeProfilesInitialized } =
        require('./tradeProfiles') as typeof import('./tradeProfiles');
      ensureStrategyToggles();
      ensureTradeProfilesInitialized();
      const result = resetStrategyModulesToDefaults();
      res.json({
        ok: true,
        ...getStrategiesStatus(),
        tradeProfiles: getTradeProfilesStatus(),
        reset: result,
        message: result.message,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  /**
   * Wipe data/*.json persistence files and reload code defaults.
   * Also resets paper balance/history and clears backtest history.
   */
  app.post('/api/config/reset-defaults', async (_req: Request, res: Response) => {
    try {
      const result = resetToDefaults();
      paperTrader.reset({ clearHistory: true });
      const { clearBacktestHistory } = await import('./backtest');
      clearBacktestHistory();
      const monitoring = forceRefreshMonitoring();
      res.json({
        ok: true,
        deleted: result.deleted,
        dataDir: result.dataDir,
        config: getConfigSnapshot(),
        persistence: getPersistenceStatus(),
        paper: {
          balanceSol: paperTrader.getBalance(),
          stats: paperTrader.getStats(),
        },
        wallets: getWalletsWithActivity(),
        monitoring,
        message:
          'All saved settings cleared. Defaults restored (wallets, paper, backtest history).',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.post('/api/config/mode', (req: Request, res: Response) => {
    const { mode } = req.body as { mode: TradingMode };
    if (!isTradingMode(mode)) {
      res.status(400).json({
        error: 'mode must be paper, liveSimulation, or live',
      });
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
    if (usesPaperAccounting() && config.strategy.enableAutoSell) {
      paperTrader.startAutoCheck();
    }
    res.json({
      mode: config.mode,
      modeLabel:
        config.mode === 'liveSimulation'
          ? 'LIVE SIM'
          : config.mode === 'live'
            ? 'LIVE'
            : 'PAPER',
      usesRealFunds: config.mode === 'live',
      useLiveData: config.paper.useLiveData,
      tradingWallet: getActiveTradingWallet()
        ? {
            id: getActiveTradingWallet()!.id,
            name: getActiveTradingWallet()!.name,
            publicKey: getWalletPublicKey()?.toBase58() ?? null,
          }
        : null,
    });
  });

  /** Live Simulation (paper ledger) vs last Backtest — side-by-side metrics + charts */
  app.get('/api/performance/compare', async (_req: Request, res: Response) => {
    try {
      const { getLastBacktest } = await import('./backtest');
      const liveStats = paperTrader.getStats();
      const liveCharts = paperTrader.getChartData();
      const liveScore = performanceScoreFromStats(liveStats);
      const bt = getLastBacktest();
      const btStats = bt?.stats ?? null;
      const btScore = btStats ? performanceScoreFromStats(btStats) : null;

      const metric = (
        key: string,
        liveVal: number | null | undefined,
        btVal: number | null | undefined,
        higherIsBetter: boolean
      ) => {
        const l = liveVal != null && Number.isFinite(liveVal) ? Number(liveVal) : null;
        const b = btVal != null && Number.isFinite(btVal) ? Number(btVal) : null;
        let winner: 'liveSim' | 'backtest' | 'tie' | null = null;
        if (l != null && b != null) {
          if (Math.abs(l - b) < 1e-9) winner = 'tie';
          else if (higherIsBetter) winner = l > b ? 'liveSim' : 'backtest';
          else winner = l < b ? 'liveSim' : 'backtest';
        }
        return { key, liveSim: l, backtest: b, delta: l != null && b != null ? l - b : null, winner, higherIsBetter };
      };

      const metrics = [
        metric('winRatePct', liveStats.winRatePct, btStats?.winRatePct, true),
        metric('profitFactor', liveStats.profitFactor, btStats?.profitFactor, true),
        metric('netPnlSol', liveStats.netPnlSol, btStats?.netPnlSol, true),
        metric('maxDrawdownPct', liveStats.maxDrawdownPct, btStats?.maxDrawdownPct, false),
        metric('closedTrades', liveStats.closedTrades, btStats?.closedTrades, true),
        metric('avgHoldSec', liveStats.avgHoldSec, btStats?.avgHoldSec, false),
        metric('score', liveScore.score, btScore?.score ?? null, true),
      ];

      const wins = { liveSim: 0, backtest: 0, tie: 0 };
      for (const m of metrics) {
        if (m.winner === 'liveSim') wins.liveSim += 1;
        else if (m.winner === 'backtest') wins.backtest += 1;
        else if (m.winner === 'tie') wins.tie += 1;
      }
      const overallWinner =
        wins.liveSim === wins.backtest
          ? 'tie'
          : wins.liveSim > wins.backtest
            ? 'liveSim'
            : 'backtest';

      res.json({
        ok: true,
        mode: config.mode,
        liveSim: {
          label:
            config.mode === 'liveSimulation'
              ? 'Live Simulation'
              : config.mode === 'paper'
                ? 'Paper (live marks)'
                : 'Paper ledger',
          stats: liveStats,
          score: liveScore,
          charts: liveCharts,
          riskLevel: normalizeRiskLevel(config.riskLevel),
        },
        backtest: bt
          ? {
              id: bt.id,
              ranAt: bt.ranAt,
              message: bt.message,
              stats: bt.stats,
              summary: bt.summary,
              score: btScore,
              charts: bt.charts,
              configUsed: bt.configUsed,
              period: bt.period,
            }
          : null,
        metrics,
        overallWinner,
        wins,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
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
    const {
      tradeAmountSol,
      baseTradeAmountSol,
      maxAllowedTradeSol,
      riskMultiplier,
      convictionMultiplier,
      minProfitPercent,
      maxProfitPercent,
      stopLossPercent,
    } = req.body as Record<string, number>;

    updateTradeConfig({
      ...(baseTradeAmountSol !== undefined && {
        baseTradeAmountSol: Number(baseTradeAmountSol),
      }),
      ...(tradeAmountSol !== undefined && {
        tradeAmountSol: Number(tradeAmountSol),
      }),
      ...(maxAllowedTradeSol !== undefined && {
        maxAllowedTradeSol: Number(maxAllowedTradeSol),
      }),
      ...(riskMultiplier !== undefined && {
        riskMultiplier: Number(riskMultiplier),
      }),
      ...(convictionMultiplier !== undefined && {
        convictionMultiplier: Number(convictionMultiplier),
      }),
      ...(minProfitPercent !== undefined && {
        minProfitPercent: Number(minProfitPercent),
      }),
      ...(maxProfitPercent !== undefined && {
        maxProfitPercent: Number(maxProfitPercent),
      }),
      ...(stopLossPercent !== undefined && {
        stopLossPercent: Number(stopLossPercent),
      }),
    });

    res.json(config.trade);
  });

  app.post('/api/config/notifications', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const n = config.notifications;
    if (typeof body.enabled === 'boolean') n.enabled = body.enabled;
    if (typeof body.email === 'string' && body.email.trim()) {
      const next = body.email.trim().slice(0, 200);
      // Never persist the retired isaac default (stale env / UI / restore).
      n.email =
        next.toLowerCase() === 'isaacpascua87@gmail.com'
          ? 'bondback2026@gmail.com'
          : next;
    }
    if (body.lowEquitySol != null && Number.isFinite(Number(body.lowEquitySol))) {
      n.lowEquitySol = Math.max(0.01, Number(body.lowEquitySol));
    }
    if (typeof body.lowEquityEnabled === 'boolean') {
      n.lowEquityEnabled = body.lowEquityEnabled;
    }
    if (typeof body.insufficientFundsEnabled === 'boolean') {
      n.insufficientFundsEnabled = body.insufficientFundsEnabled;
    }
    if (typeof body.profitableCloseEnabled === 'boolean') {
      n.profitableCloseEnabled = body.profitableCloseEnabled;
    }
    if (typeof body.profitEmailMode === 'string') {
      const mode = String(body.profitEmailMode).toLowerCase();
      if (mode === 'instant' || mode === 'cluster' || mode === 'both') {
        n.profitEmailMode = mode;
      }
    }
    if (typeof body.profitEmailClusterInterval === 'string') {
      const iv = String(body.profitEmailClusterInterval).toLowerCase();
      if (
        iv === '1h' ||
        iv === '2h' ||
        iv === '4h' ||
        iv === '12h' ||
        iv === '24h'
      ) {
        n.profitEmailClusterInterval = iv;
      }
    }
    if (typeof body.profitEmailTo === 'string') {
      const to = body.profitEmailTo.trim().slice(0, 200);
      if (!to || to.includes('@')) {
        n.profitEmailTo =
          !to || to.toLowerCase() === 'isaacpascua87@gmail.com'
            ? 'bondback2026@gmail.com'
            : to;
      }
    }
    if (typeof body.dashboardEnabled === 'boolean') {
      n.dashboardEnabled = body.dashboardEnabled;
    }
    if (typeof body.tradeRequestSound === 'boolean') {
      n.tradeRequestSound = body.tradeRequestSound;
    }
    if (typeof body.profitCloseSound === 'boolean') {
      n.profitCloseSound = body.profitCloseSound;
    }
    if (typeof body.zionPlaceTradeSound === 'boolean') {
      n.zionPlaceTradeSound = body.zionPlaceTradeSound;
    }
    if (typeof body.zionChatReplySound === 'boolean') {
      n.zionChatReplySound = body.zionChatReplySound;
    }
    if (typeof body.tradeOpenSound === 'boolean') {
      n.tradeOpenSound = body.tradeOpenSound;
    }
    if (typeof body.tradeCloseSound === 'boolean') {
      n.tradeCloseSound = body.tradeCloseSound;
    }
    if (typeof body.tradeRequestPopups === 'boolean') {
      n.tradeRequestPopups = body.tradeRequestPopups;
    }
    const ok = persistUserSettings();
    if (!ok) {
      res.status(500).json({
        ok: false,
        error:
          'Failed to write config.json — check DATA_DIR is writable. In-memory values updated but may not survive restart.',
        notifications: { ...config.notifications },
      });
      return;
    }
    res.json({ ok: true, notifications: { ...config.notifications } });
  });

  app.get('/api/dashboard-notifications', (req: Request, res: Response) => {
    try {
      const {
        listDashboardNotifications,
        isDashboardNotifyEnabled,
        isTradeRequestSoundEnabled,
        isTradeRequestPopupEnabled,
        isProfitCloseSoundEnabled,
        isZionPlaceTradeSoundEnabled,
        isZionChatReplySoundEnabled,
        isTradeOpenSoundEnabled,
        isTradeCloseSoundEnabled,
      } = require('./dashboardNotifications') as typeof import('./dashboardNotifications');
      const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 40));
      const feed = listDashboardNotifications(limit);
      res.json({
        ok: true,
        enabled: isDashboardNotifyEnabled(),
        tradeRequestSound: isTradeRequestSoundEnabled(),
        tradeRequestPopups: isTradeRequestPopupEnabled(),
        profitCloseSound: isProfitCloseSoundEnabled(),
        zionPlaceTradeSound: isZionPlaceTradeSoundEnabled(),
        zionChatReplySound: isZionChatReplySoundEnabled(),
        tradeOpenSound: isTradeOpenSoundEnabled(),
        tradeCloseSound: isTradeCloseSoundEnabled(),
        ...feed,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/dashboard-notifications/read', (req: Request, res: Response) => {
    try {
      const { markDashboardNotificationRead, listDashboardNotifications } =
        require('./dashboardNotifications') as typeof import('./dashboardNotifications');
      const body = (req.body ?? {}) as { id?: string; all?: boolean };
      const result = markDashboardNotificationRead(
        body.all ? undefined : body.id
      );
      res.json({
        ...result,
        ...listDashboardNotifications(40),
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/dashboard-notifications/clear', (_req: Request, res: Response) => {
    try {
      const { clearDashboardNotifications } =
        require('./dashboardNotifications') as typeof import('./dashboardNotifications');
      clearDashboardNotifications();
      res.json({ ok: true, items: [], unread: 0 });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/notifications/test', async (_req: Request, res: Response) => {
    try {
      const { sendTestNotificationEmail, emailDeliveryStatus } =
        require('./emailNotifications') as typeof import('./emailNotifications');
      const result = await sendTestNotificationEmail();
      if (!result.ok) {
        res.status(400).json({ ...result, delivery: emailDeliveryStatus() });
        return;
      }
      res.json({ ...result, delivery: emailDeliveryStatus() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.get('/api/notifications/status', (_req: Request, res: Response) => {
    try {
      const { emailDeliveryStatus } =
        require('./emailNotifications') as typeof import('./emailNotifications');
      res.json({ ok: true, delivery: emailDeliveryStatus() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.post('/api/config/technical-levels', (req: Request, res: Response) => {
    if (!config.technicalLevels) {
      const { DEFAULT_TECHNICAL_LEVELS } = require('./config') as typeof import('./config');
      config.technicalLevels = { ...DEFAULT_TECHNICAL_LEVELS };
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.enabled !== undefined) {
      config.technicalLevels.enabled = Boolean(body.enabled);
      if (config.strategyToggles) {
        config.strategyToggles.technical_levels = config.technicalLevels.enabled;
      }
    }
    if (
      body.sensitivity === 'low' ||
      body.sensitivity === 'medium' ||
      body.sensitivity === 'high'
    ) {
      config.technicalLevels.sensitivity = body.sensitivity;
    }
    if (body.lookbackBars !== undefined) {
      const n = Number(body.lookbackBars);
      if (Number.isFinite(n)) {
        config.technicalLevels.lookbackBars = Math.max(8, Math.min(400, Math.round(n)));
      }
    }
    if (body.lookbackHours !== undefined) {
      const n = Number(body.lookbackHours);
      if (Number.isFinite(n)) {
        config.technicalLevels.lookbackHours = Math.max(0.5, Math.min(48, n));
      }
    }
    if (body.lookbackHoursMin !== undefined) {
      const n = Number(body.lookbackHoursMin);
      if (Number.isFinite(n)) {
        config.technicalLevels.lookbackHoursMin = Math.max(0.5, Math.min(24, n));
      }
    }
    if (body.lookbackHoursMax !== undefined) {
      const n = Number(body.lookbackHoursMax);
      if (Number.isFinite(n)) {
        config.technicalLevels.lookbackHoursMax = Math.max(1, Math.min(48, n));
      }
    }
    if (body.minImpulsePct !== undefined) {
      const n = Number(body.minImpulsePct);
      if (Number.isFinite(n)) {
        config.technicalLevels.minImpulsePct = Math.max(10, Math.min(500, n));
      }
    }
    if (body.preferRecentImpulse !== undefined) {
      config.technicalLevels.preferRecentImpulse = Boolean(
        body.preferRecentImpulse
      );
    }
    if (body.pivotWindow !== undefined) {
      const n = Number(body.pivotWindow);
      if (Number.isFinite(n)) {
        config.technicalLevels.pivotWindow = Math.max(1, Math.min(6, Math.round(n)));
      }
    }
    if (body.clusterPct !== undefined || body.zoneWidthPct !== undefined) {
      const n = Number(
        body.zoneWidthPct !== undefined ? body.zoneWidthPct : body.clusterPct
      );
      if (Number.isFinite(n)) {
        const w = Math.max(0.5, Math.min(8, n));
        config.technicalLevels.clusterPct = w;
        config.technicalLevels.zoneWidthPct = w;
      }
    }
    if (body.nearPct !== undefined) {
      const n = Number(body.nearPct);
      if (Number.isFinite(n)) {
        config.technicalLevels.nearPct = Math.max(0.5, Math.min(12, n));
      }
    }
    if (body.minTouchesForValid !== undefined) {
      const n = Number(body.minTouchesForValid);
      if (Number.isFinite(n)) {
        config.technicalLevels.minTouchesForValid = Math.max(
          1,
          Math.min(8, Math.round(n))
        );
      }
    }
    if (body.minTouchesForStrong !== undefined) {
      const n = Number(body.minTouchesForStrong);
      if (Number.isFinite(n)) {
        config.technicalLevels.minTouchesForStrong = Math.max(
          1,
          Math.min(8, Math.round(n))
        );
      }
    }
    if (body.srLookbackHours !== undefined) {
      const n = Number(body.srLookbackHours);
      if (Number.isFinite(n)) {
        config.technicalLevels.srLookbackHours = Math.max(0.5, Math.min(6, n));
      }
    }
    if (body.srLookbackHoursMin !== undefined) {
      const n = Number(body.srLookbackHoursMin);
      if (Number.isFinite(n)) {
        config.technicalLevels.srLookbackHoursMin = Math.max(0.5, Math.min(6, n));
      }
    }
    if (body.srLookbackHoursMax !== undefined) {
      const n = Number(body.srLookbackHoursMax);
      if (Number.isFinite(n)) {
        config.technicalLevels.srLookbackHoursMax = Math.max(1, Math.min(6, n));
      }
    }
    if (body.srLookbackHoursHardMax !== undefined) {
      const n = Number(body.srLookbackHoursHardMax);
      if (Number.isFinite(n)) {
        config.technicalLevels.srLookbackHoursHardMax = Math.max(
          1,
          Math.min(24, n)
        );
      }
    }
    if (
      body.swingStrength === 'low' ||
      body.swingStrength === 'medium' ||
      body.swingStrength === 'high'
    ) {
      config.technicalLevels.swingStrength = body.swingStrength;
    }
    if (body.preferRecentSupport !== undefined) {
      config.technicalLevels.preferRecentSupport = Boolean(
        body.preferRecentSupport
      );
    }
    if (body.favourVolumeReaction !== undefined) {
      config.technicalLevels.favourVolumeReaction = Boolean(
        body.favourVolumeReaction
      );
    }
    if (body.requireBreakCloseInvalidation !== undefined) {
      config.technicalLevels.requireBreakCloseInvalidation = Boolean(
        body.requireBreakCloseInvalidation
      );
    }
    if (body.fibTreatAsZones !== undefined) {
      config.technicalLevels.fibTreatAsZones = Boolean(body.fibTreatAsZones);
    }
    if (body.hardFilter !== undefined) {
      config.technicalLevels.hardFilter = Boolean(body.hardFilter);
    }
    if (body.prioritizeFibLevels !== undefined) {
      const raw = body.prioritizeFibLevels;
      const list = Array.isArray(raw)
        ? raw.map(Number)
        : String(raw)
            .split(',')
            .map((s) => Number(s.trim()));
      config.technicalLevels.prioritizeFibLevels = list.filter((n) =>
        Number.isFinite(n)
      );
    }
    if (body.secondaryFibLevels !== undefined) {
      const raw = body.secondaryFibLevels;
      const list = Array.isArray(raw)
        ? raw.map(Number)
        : String(raw)
            .split(',')
            .map((s) => Number(s.trim()));
      config.technicalLevels.secondaryFibLevels = list.filter((n) =>
        Number.isFinite(n)
      );
    }
    // Keep Fib lookbackHours inside configured min/max band
    config.technicalLevels.lookbackHours = Math.max(
      config.technicalLevels.lookbackHoursMin,
      Math.min(
        config.technicalLevels.lookbackHoursMax,
        config.technicalLevels.lookbackHours
      )
    );
    // Keep S&R lookback inside preferred band and hard max (≤6 default)
    const srHard = Math.min(
      24,
      Number(config.technicalLevels.srLookbackHoursHardMax) || 6
    );
    config.technicalLevels.srLookbackHoursMax = Math.min(
      srHard,
      config.technicalLevels.srLookbackHoursMax
    );
    config.technicalLevels.srLookbackHoursMin = Math.min(
      config.technicalLevels.srLookbackHoursMax,
      config.technicalLevels.srLookbackHoursMin
    );
    config.technicalLevels.srLookbackHours = Math.max(
      config.technicalLevels.srLookbackHoursMin,
      Math.min(
        config.technicalLevels.srLookbackHoursMax,
        config.technicalLevels.srLookbackHours
      )
    );
    // Keep zone width aliases in sync
    if (config.technicalLevels.zoneWidthPct == null) {
      config.technicalLevels.zoneWidthPct = config.technicalLevels.clusterPct;
    } else {
      config.technicalLevels.clusterPct = config.technicalLevels.zoneWidthPct;
    }
    persistUserSettings();
    res.json({ ok: true, technicalLevels: { ...config.technicalLevels } });
  });

  app.get('/api/config/technical-levels', (_req: Request, res: Response) => {
    res.json({ technicalLevels: { ...config.technicalLevels } });
  });

  app.post('/api/config/chart-patterns', (req: Request, res: Response) => {
    const { DEFAULT_CHART_PATTERNS } = require('./config') as typeof import('./config');
    if (!config.chartPatterns) {
      config.chartPatterns = {
        ...DEFAULT_CHART_PATTERNS,
        patterns: { ...DEFAULT_CHART_PATTERNS.patterns },
      };
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.enabled !== undefined) {
      config.chartPatterns.enabled = Boolean(body.enabled);
      if (config.strategyToggles) {
        config.strategyToggles.chart_patterns = config.chartPatterns.enabled;
      }
    }
    if (
      body.sensitivity === 'low' ||
      body.sensitivity === 'medium' ||
      body.sensitivity === 'high'
    ) {
      config.chartPatterns.sensitivity = body.sensitivity;
    }
    if (body.mode === 'confirm' || body.mode === 'entry' || body.mode === 'both') {
      config.chartPatterns.mode = body.mode;
    }
    if (body.lookbackBars !== undefined) {
      const n = Number(body.lookbackBars);
      if (Number.isFinite(n)) {
        config.chartPatterns.lookbackBars = Math.max(12, Math.min(240, Math.round(n)));
      }
    }
    if (body.minConfidence !== undefined) {
      const n = Number(body.minConfidence);
      if (Number.isFinite(n)) config.chartPatterns.minConfidence = Math.max(30, Math.min(90, n));
    }
    if (body.breakoutPct !== undefined) {
      const n = Number(body.breakoutPct);
      if (Number.isFinite(n)) config.chartPatterns.breakoutPct = Math.max(0.3, Math.min(8, n));
    }
    if (body.pullbackNearPct !== undefined) {
      const n = Number(body.pullbackNearPct);
      if (Number.isFinite(n)) config.chartPatterns.pullbackNearPct = Math.max(0.5, Math.min(12, n));
    }
    if (body.minPoleRunPct !== undefined) {
      const n = Number(body.minPoleRunPct);
      if (Number.isFinite(n)) config.chartPatterns.minPoleRunPct = Math.max(10, Math.min(200, n));
    }
    if (body.maxFlagRangePct !== undefined) {
      const n = Number(body.maxFlagRangePct);
      if (Number.isFinite(n)) config.chartPatterns.maxFlagRangePct = Math.max(4, Math.min(40, n));
    }
    if (body.minStructuredDropPct !== undefined) {
      const n = Number(body.minStructuredDropPct);
      if (Number.isFinite(n)) config.chartPatterns.minStructuredDropPct = Math.max(3, Math.min(40, n));
    }
    if (body.maxStructuredDropPct !== undefined) {
      const n = Number(body.maxStructuredDropPct);
      if (Number.isFinite(n)) config.chartPatterns.maxStructuredDropPct = Math.max(10, Math.min(60, n));
    }
    if (body.volumeDryupRatio !== undefined) {
      const n = Number(body.volumeDryupRatio);
      if (Number.isFinite(n)) config.chartPatterns.volumeDryupRatio = Math.max(0.2, Math.min(0.9, n));
    }
    if (body.volumeReturnRatio !== undefined) {
      const n = Number(body.volumeReturnRatio);
      if (Number.isFinite(n)) config.chartPatterns.volumeReturnRatio = Math.max(1.05, Math.min(4, n));
    }
    if (body.holderDropPct !== undefined) {
      const n = Number(body.holderDropPct);
      if (Number.isFinite(n)) config.chartPatterns.holderDropPct = Math.max(2, Math.min(40, n));
    }
    if (body.capitulationDropPct !== undefined) {
      const n = Number(body.capitulationDropPct);
      if (Number.isFinite(n)) config.chartPatterns.capitulationDropPct = Math.max(12, Math.min(70, n));
    }
    if (body.bearishPenalty !== undefined) {
      const n = Number(body.bearishPenalty);
      if (Number.isFinite(n)) config.chartPatterns.bearishPenalty = Math.max(0, Math.min(20, n));
    }
    if (body.hardFilter !== undefined) {
      config.chartPatterns.hardFilter = Boolean(body.hardFilter);
    }
    if (body.blockOnBearish !== undefined) {
      config.chartPatterns.blockOnBearish = Boolean(body.blockOnBearish);
    }
    if (body.patterns && typeof body.patterns === 'object') {
      const incoming = body.patterns as Record<string, { enabled?: boolean }>;
      const next = { ...config.chartPatterns.patterns };
      for (const id of Object.keys(DEFAULT_CHART_PATTERNS.patterns)) {
        if (incoming[id] && typeof incoming[id].enabled === 'boolean') {
          next[id as keyof typeof next] = { enabled: incoming[id].enabled };
        }
      }
      config.chartPatterns.patterns = next;
    }
    persistUserSettings();
    res.json({
      ok: true,
      chartPatterns: {
        ...config.chartPatterns,
        patterns: { ...config.chartPatterns.patterns },
      },
    });
  });

  app.get('/api/config/chart-patterns', (_req: Request, res: Response) => {
    res.json({
      chartPatterns: {
        ...(config.chartPatterns || {}),
        patterns: { ...(config.chartPatterns?.patterns || {}) },
      },
    });
  });

  app.post('/api/config/filters', (req: Request, res: Response) => {
    const keys = [
      'minWinRate',
      'minLiquidity',
      'minMarketCapUsd',
      'maxEntryMarketCapUsd',
      'maxDevHoldPct',
      'minDevHoldPct',
      'maxDevPercent',
      'maxTopHolderPct',
      'minTopHolderPct',
      'maxHolderConcentration',
      'minTop10HolderPct',
      'maxEstimatedTaxPct',
      'minEstimatedTaxPct',
      'maxRiskScore',
      'minRiskScore',
      'convergenceRequired',
      'maxConcurrentPositions',
      'dailyLossLimitSol',
      'minActivityDays',
      'minTradesLast30d',
      'minVolume24hUsd',
      'minRecentVolumeUsd',
      'minRecentBuyVolumeUsd',
      'minHolderCount',
      'minHolders',
      'minRecentActivity',
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
    if (req.body.enableWalletQualityGate !== undefined) {
      config.filters.enableWalletQualityGate = Boolean(
        req.body.enableWalletQualityGate
      );
    }
    if (req.body.enableWalletQualityAutoPrune !== undefined) {
      config.filters.enableWalletQualityAutoPrune = Boolean(
        req.body.enableWalletQualityAutoPrune
      );
    }
    if (req.body.enableEntryTimingGate !== undefined) {
      config.filters.enableEntryTimingGate = Boolean(
        req.body.enableEntryTimingGate
      );
    }
    if (req.body.rejectDumpingToken !== undefined) {
      config.filters.rejectDumpingToken = Boolean(req.body.rejectDumpingToken);
    }
    if (req.body.requireMomentumConfirmation !== undefined) {
      config.filters.requireMomentumConfirmation = Boolean(
        req.body.requireMomentumConfirmation
      );
    }
    if (req.body.allowSingleWalletTopPerformerMigration !== undefined) {
      config.filters.allowSingleWalletTopPerformerMigration = Boolean(
        req.body.allowSingleWalletTopPerformerMigration
      );
    }
    for (const key of [
      'minWalletQualityScore',
      'walletQualityInactiveDays',
      'maxEntryAgeMinutes',
      'preferEntryWithinMinutes',
      'maxDrawdownFromRecentHighPct',
      'clusterMinWallets',
      'clusterWindowMinutes',
      'smartMoneyFlowWeight',
      'momentumLookbackMinutes',
      'momentumMinHoldPct',
    ] as const) {
      if (req.body[key] !== undefined) {
        (partial as Record<string, number>)[key] = Number(req.body[key]);
      }
    }
    if (
      req.body.sniperSensitivity !== undefined &&
      ['low', 'medium', 'high'].includes(String(req.body.sniperSensitivity))
    ) {
      config.filters.sniperSensitivity = String(
        req.body.sniperSensitivity
      ) as 'low' | 'medium' | 'high';
    }
    if (
      req.body.socialSentimentSensitivity !== undefined &&
      ['low', 'medium', 'high'].includes(
        String(req.body.socialSentimentSensitivity)
      )
    ) {
      config.filters.socialSentimentSensitivity = String(
        req.body.socialSentimentSensitivity
      ) as 'low' | 'medium' | 'high';
    }
    if (req.body.enableSocialSentimentFilter !== undefined) {
      config.filters.enableSocialSentimentFilter = Boolean(
        req.body.enableSocialSentimentFilter
      );
    }
    if (
      req.body.trendingNarrativeSensitivity !== undefined &&
      ['low', 'medium', 'high'].includes(
        String(req.body.trendingNarrativeSensitivity)
      )
    ) {
      config.filters.trendingNarrativeSensitivity = String(
        req.body.trendingNarrativeSensitivity
      ) as 'low' | 'medium' | 'high';
    }
    if (req.body.enableTrendingNarrativeBoost !== undefined) {
      config.filters.enableTrendingNarrativeBoost = Boolean(
        req.body.enableTrendingNarrativeBoost
      );
    }
    if (req.body.trendingNarrativeBoostPoints !== undefined) {
      const n = Number(req.body.trendingNarrativeBoostPoints);
      if (Number.isFinite(n)) {
        config.filters.trendingNarrativeBoostPoints = Math.max(
          1,
          Math.min(20, Math.round(n))
        );
      }
    }
    if (
      req.body.volumeSpikeSensitivity !== undefined &&
      ['low', 'medium', 'high'].includes(String(req.body.volumeSpikeSensitivity))
    ) {
      config.filters.volumeSpikeSensitivity = String(
        req.body.volumeSpikeSensitivity
      ) as 'low' | 'medium' | 'high';
    }
    if (req.body.enableVolumeSpikeFilter !== undefined) {
      config.filters.enableVolumeSpikeFilter = Boolean(
        req.body.enableVolumeSpikeFilter
      );
    }
    if (req.body.volumeSpikeHardFilter !== undefined) {
      config.filters.volumeSpikeHardFilter = Boolean(
        req.body.volumeSpikeHardFilter
      );
    }
    if (req.body.volumeSpikeWindowMinutes !== undefined) {
      const n = Number(req.body.volumeSpikeWindowMinutes);
      if (Number.isFinite(n)) {
        config.filters.volumeSpikeWindowMinutes = Math.max(
          1,
          Math.min(15, Math.round(n))
        );
      }
    }
    if (req.body.volumeSpikeMultiplier !== undefined) {
      const n = Number(req.body.volumeSpikeMultiplier);
      if (Number.isFinite(n)) {
        config.filters.volumeSpikeMultiplier = Math.max(
          1.5,
          Math.min(8, n)
        );
      }
    }
    if (req.body.volumeSpikeBuySidePct !== undefined) {
      const n = Number(req.body.volumeSpikeBuySidePct);
      if (Number.isFinite(n)) {
        config.filters.volumeSpikeBuySidePct = Math.max(
          50,
          Math.min(90, Math.round(n))
        );
      }
    }
    if (req.body.volumeSpikeMinUsd !== undefined) {
      const n = Number(req.body.volumeSpikeMinUsd);
      if (Number.isFinite(n)) {
        config.filters.volumeSpikeMinUsd = Math.max(0, Math.round(n));
      }
    }
    if (req.body.volumeSpikeBoostPoints !== undefined) {
      const n = Number(req.body.volumeSpikeBoostPoints);
      if (Number.isFinite(n)) {
        config.filters.volumeSpikeBoostPoints = Math.max(
          1,
          Math.min(20, Math.round(n))
        );
      }
    }
    if (
      req.body.confirmationSensitivity !== undefined &&
      ['low', 'medium', 'high'].includes(
        String(req.body.confirmationSensitivity)
      )
    ) {
      config.filters.confirmationSensitivity = String(
        req.body.confirmationSensitivity
      ) as 'low' | 'medium' | 'high';
    }
    if (req.body.enableConfirmationLayer !== undefined) {
      config.filters.enableConfirmationLayer = Boolean(
        req.body.enableConfirmationLayer
      );
    }
    if (req.body.confirmationHardFilter !== undefined) {
      config.filters.confirmationHardFilter = Boolean(
        req.body.confirmationHardFilter
      );
    }
    if (req.body.confirmationVolumeWeight !== undefined) {
      const n = Number(req.body.confirmationVolumeWeight);
      if (Number.isFinite(n)) {
        config.filters.confirmationVolumeWeight = Math.max(
          0,
          Math.min(100, Math.round(n))
        );
      }
    }
    if (req.body.confirmationSentimentWeight !== undefined) {
      const n = Number(req.body.confirmationSentimentWeight);
      if (Number.isFinite(n)) {
        config.filters.confirmationSentimentWeight = Math.max(
          0,
          Math.min(100, Math.round(n))
        );
      }
    }
    if (req.body.confirmationNarrativeWeight !== undefined) {
      const n = Number(req.body.confirmationNarrativeWeight);
      if (Number.isFinite(n)) {
        config.filters.confirmationNarrativeWeight = Math.max(
          0,
          Math.min(100, Math.round(n))
        );
      }
    }
    if (req.body.confirmationBoostPoints !== undefined) {
      const n = Number(req.body.confirmationBoostPoints);
      if (Number.isFinite(n)) {
        config.filters.confirmationBoostPoints = Math.max(
          1,
          Math.min(22, Math.round(n))
        );
      }
    }
    if (req.body.enableMarketSessionFilter !== undefined) {
      config.filters.enableMarketSessionFilter = Boolean(
        req.body.enableMarketSessionFilter
      );
    }
    for (const key of [
      'marketSessionAllowAsia',
      'marketSessionAllowEurope',
      'marketSessionAllowUs',
      'marketSessionAllowOverlap',
      'marketSessionAllowOffHours',
    ] as const) {
      if (req.body[key] !== undefined) {
        config.filters[key] = Boolean(req.body[key]);
      }
    }
    if (req.body.marketSessionPreferred !== undefined) {
      const raw = req.body.marketSessionPreferred;
      if (Array.isArray(raw)) {
        config.filters.marketSessionPreferred = raw.map(String);
      } else if (typeof raw === 'string') {
        config.filters.marketSessionPreferred = raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }
    if (req.body.marketSessionPreferBoostPoints !== undefined) {
      const n = Number(req.body.marketSessionPreferBoostPoints);
      if (Number.isFinite(n)) {
        config.filters.marketSessionPreferBoostPoints = Math.max(
          0,
          Math.min(10, Math.round(n))
        );
      }
    }
    if (req.body.enablePostRunDip !== undefined) {
      config.filters.enablePostRunDip = Boolean(req.body.enablePostRunDip);
      config.postRunDip.enabled = config.filters.enablePostRunDip;
    }
    if (
      req.body.postRunDipSensitivity !== undefined &&
      ['low', 'medium', 'high'].includes(String(req.body.postRunDipSensitivity))
    ) {
      const s = String(req.body.postRunDipSensitivity) as
        | 'low'
        | 'medium'
        | 'high';
      config.filters.postRunDipSensitivity = s;
      config.postRunDip.sensitivity = s;
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
    if (req.body.buyPumpFunOnly !== undefined) {
      config.filters.buyPumpFunOnly = Boolean(req.body.buyPumpFunOnly);
    }
    if (req.body.requireHealthyCurve !== undefined) {
      config.bondingCurve.requireHealthyCurve = Boolean(
        req.body.requireHealthyCurve
      );
    }
    if (req.body.requireRecentCurveActivity !== undefined) {
      config.bondingCurve.requireRecentCurveActivity = Boolean(
        req.body.requireRecentCurveActivity
      );
    }
    if (req.body.minCurveProgress !== undefined) {
      config.bondingCurve.minCurveProgress = Number(req.body.minCurveProgress);
    }
    if (req.body.maxCurveProgressForEntry !== undefined) {
      config.bondingCurve.maxCurveProgressForEntry = Number(
        req.body.maxCurveProgressForEntry
      );
    }
    // Auto-pause OFF ⇒ Daily Loss Off (same rule as /api/risk + boot heal)
    if (
      config.risk?.autoPauseOnLimit === false &&
      Number(config.filters.dailyLossLimitSol) > 0
    ) {
      config.filters.dailyLossLimitSol = 0;
    }
    persistUserSettings();
    res.json({
      ...config.filters,
      requireHealthyCurve: config.bondingCurve.requireHealthyCurve,
      buyPumpFunOnly: config.filters.buyPumpFunOnly === true,
      bondingCurve: { ...config.bondingCurve },
    });
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
      postStopReentryEnabled,
      reEntryMaxPerMint,
      reEntryWatchMinutes,
      reEntryMinReclaimPct,
      reEntryMinVolumeIncreasePct,
      reEntryConfirmationWallets,
      reEntrySizeMultiplier,
      reEntryCooldownMinutes,
      reEntryAfterMaxProfitEnabled,
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
      postStopReentryEnabled?: boolean;
      reEntryMaxPerMint?: number;
      reEntryWatchMinutes?: number;
      reEntryMinReclaimPct?: number;
      reEntryMinVolumeIncreasePct?: number;
      reEntryConfirmationWallets?: number;
      reEntrySizeMultiplier?: number;
      reEntryCooldownMinutes?: number;
      reEntryAfterMaxProfitEnabled?: boolean;
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
      ...(postStopReentryEnabled !== undefined && {
        postStopReentryEnabled: Boolean(postStopReentryEnabled),
      }),
      ...(reEntryMaxPerMint !== undefined && {
        reEntryMaxPerMint: Number(reEntryMaxPerMint),
      }),
      ...(reEntryWatchMinutes !== undefined && {
        reEntryWatchMinutes: Number(reEntryWatchMinutes),
      }),
      ...(reEntryMinReclaimPct !== undefined && {
        reEntryMinReclaimPct: Number(reEntryMinReclaimPct),
      }),
      ...(reEntryMinVolumeIncreasePct !== undefined && {
        reEntryMinVolumeIncreasePct: Number(reEntryMinVolumeIncreasePct),
      }),
      ...(reEntryConfirmationWallets !== undefined && {
        reEntryConfirmationWallets: Number(reEntryConfirmationWallets),
      }),
      ...(reEntrySizeMultiplier !== undefined && {
        reEntrySizeMultiplier: Number(reEntrySizeMultiplier),
      }),
      ...(reEntryCooldownMinutes !== undefined && {
        reEntryCooldownMinutes: Number(reEntryCooldownMinutes),
      }),
      ...(reEntryAfterMaxProfitEnabled !== undefined && {
        reEntryAfterMaxProfitEnabled: Boolean(reEntryAfterMaxProfitEnabled),
      }),
    });

    res.json(config.strategy);
  });

  app.post('/api/config/selective', (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const partial: Parameters<typeof updateSelectiveConfig>[0] = {};
    const boolKeys = [
      'enabled',
      'requireConvergenceForNormal',
      'allowSingleWalletMigration',
    ] as const;
    const numKeys = [
      'minConvictionScore',
      'minWalletsForTrade',
      'minVolume24hUsd',
      'minHolderCount',
      'maxTradesPerHour',
      'minMsBetweenTrades',
      'riskScoreSizeCutoff',
      'minRiskSizeMultiplier',
      'extraConvergenceAboveRisk',
      'highRiskConvergenceThreshold',
    ] as const;

    for (const key of boolKeys) {
      if (body[key] !== undefined) {
        partial[key] = Boolean(body[key]);
      }
    }
    for (const key of numKeys) {
      if (body[key] !== undefined) {
        partial[key] = Number(body[key]);
      }
    }

    const selective = updateSelectiveConfig(partial);
    try {
      const { queueGithubBackupUploadAfterCriticalSave } =
        require('./githubSiteBackup') as typeof import('./githubSiteBackup');
      queueGithubBackupUploadAfterCriticalSave('selective-trade-caps');
    } catch {
      /* optional */
    }
    res.json(selective);
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
        'axiom',
        'photon',
        'bullx',
        'manual',
        'all',
      ];
      const limit = req.query.limit != null ? Number(req.query.limit) : 100;
      const period = (req.query.period === '7d' ? '7d' : '30d') as '7d' | '30d';
      const minWinRate =
        req.query.minWinRate != null ? Number(req.query.minWinRate) : undefined;
      const work = findSmartWallets({
        source: allowed.includes(source) ? source : 'gmgn',
        limit,
        period,
        minWinRate,
        manualText:
          req.query.manualText != null ? String(req.query.manualText) : undefined,
        force: req.query.force === '1' || req.query.force === 'true',
        pumpFunFocus:
          req.query.pumpFunFocus === '1' ||
          req.query.pumpFunFocus === 'true',
      });
      const result = await Promise.race([
        work,
        new Promise<Awaited<ReturnType<typeof findSmartWallets>>>((resolve) => {
          setTimeout(() => {
            const curated = getCuratedSmartWallets(limit, period, minWinRate ?? 0);
            resolve({
              source: allowed.includes(source) ? source : 'gmgn',
              wallets: curated.wallets.map((w) => ({
                name: w.name,
                address: w.address,
                source: 'manual' as const,
                winRate: w.winRate,
                tradesLast7d: w.tradesLast7d,
                tradesLast30d: w.tradesLast30d,
                tradeCount: w.tradeCount,
                pumpFunTradeCount: w.pumpFunTradeCount,
                tags: [...(w.tags ?? []), 'curated'],
                alreadyTracked: w.alreadyTracked,
                notes: w.notes ?? 'Curated / timeout fallback',
                lastActiveAt: w.lastActiveAt,
                metrics: {
                  winRate: w.winRate,
                  ...(w.tradesLast7d != null ? { trades7d: w.tradesLast7d } : {}),
                  ...(w.tradesLast30d != null ? { trades30d: w.tradesLast30d } : {}),
                },
              })),
              fetchedAt: Date.now(),
              cached: false,
              message: 'Discover timed out — curated fallback',
              error: 'timeout',
            });
          }, 12_000);
        }),
      ]);
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
        'axiom',
        'photon',
        'bullx',
        'manual',
        'all',
      ];
      if (body.defaultSource && allowed.includes(body.defaultSource)) {
        config.walletDiscovery.defaultSource = body.defaultSource;
        persistUserSettings();
      }
      const limit = body.limit ?? 100;
      const period = body.period === '7d' ? '7d' : '30d';
      const source =
        body.source && allowed.includes(body.source) ? body.source : undefined;
      const work = findSmartWallets({
        source,
        limit,
        period,
        minWinRate: body.minWinRate,
        manualText: body.manualText,
        force: body.force,
        pumpFunFocus: body.pumpFunFocus,
      });
      work.catch((err) => {
        console.warn(
          '[discover] late error after race:',
          err instanceof Error ? err.message : err
        );
      });
      const result = await Promise.race([
        work,
        new Promise<Awaited<ReturnType<typeof findSmartWallets>>>((resolve) => {
          setTimeout(() => {
            const curated = getCuratedSmartWallets(
              limit,
              period,
              body.minWinRate ?? 0
            );
            resolve({
              source: source ?? 'all',
              wallets: curated.wallets.map((w) => ({
                name: w.name,
                address: w.address,
                source: 'manual' as const,
                winRate: w.winRate,
                tradesLast7d: w.tradesLast7d,
                tradesLast30d: w.tradesLast30d,
                tradeCount: w.tradeCount,
                pumpFunTradeCount: w.pumpFunTradeCount,
                tags: [...(w.tags ?? []), 'curated'],
                alreadyTracked: w.alreadyTracked,
                notes: w.notes ?? 'Curated / timeout fallback',
                lastActiveAt: w.lastActiveAt,
                metrics: {
                  winRate: w.winRate,
                  ...(w.tradesLast7d != null ? { trades7d: w.tradesLast7d } : {}),
                  ...(w.tradesLast30d != null ? { trades30d: w.tradesLast30d } : {}),
                },
              })),
              fetchedAt: Date.now(),
              cached: false,
              message: 'Discover timed out — curated fallback',
              error: 'timeout',
            });
          }, 12_000);
        }),
      ]);
      res.json({
        ...result,
        discovery: getDiscoveryStatus(),
        gmgn: getGmgnStatus(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const curated = getCuratedSmartWallets(
        Number((req.body as { limit?: number })?.limit) || 20,
        '7d',
        0
      );
      res.status(200).json({
        source: 'manual',
        wallets: curated.wallets,
        fetchedAt: Date.now(),
        cached: false,
        message: 'Discover error — curated fallback',
        error: message,
        discovery: getDiscoveryStatus(),
        gmgn: getGmgnStatus(),
      });
    }
  });

  app.get('/api/discover-wallets/status', (_req: Request, res: Response) => {
    const st = getSolanaTrackerStatus();
    const nansen = getNansenStatus();
    res.json({
      ...getDiscoveryStatus(),
      gmgn: getGmgnStatus(),
      birdeye: getBirdeyeStatus(),
      solanaTracker: st,
      nansen,
      sources: {
        gmgn: getGmgnStatus().ok ? 'ok' : getGmgnStatus().hasApiKey ? 'degraded' : 'missing_key',
        birdeye: getBirdeyeStatus().ok ? 'ok' : 'missing_key',
        kolscan: 'ok',
        dexscreener: 'ok',
        axiom: st.hasApiKey ? 'ok' : 'missing_key',
        photon: st.hasApiKey ? 'ok' : 'missing_key',
        bullx: 'offline',
        curated: 'ok',
        nansen: nansen.hasApiKey ? (nansen.lastError ? 'degraded' : 'ok') : 'missing_key',
      },
    });
  });

  app.post('/api/discover-wallets/clear-cache', (_req: Request, res: Response) => {
    clearDiscoveryCache();
    res.json({ ok: true, discovery: getDiscoveryStatus() });
  });

  /** One-click favourites: discover preset sources + Nansen seed, merge into tracked. */
  app.post(
    '/api/discover-wallets/import-favourites',
    async (req: Request, res: Response) => {
      try {
        const force = req.body?.force !== false;
        try {
          const { setSkipFavouritesAutoImport } =
            require('./dashboardState') as typeof import('./dashboardState');
          setSkipFavouritesAutoImport(false);
        } catch {
          /* ignore */
        }
        const result = await importFavouritesSmartWallets({ force });
        const monitoring = syncWalletsToMonitoring(
          result.addedAddresses,
          'import-favourites'
        );
        console.log(
          `[discover] Favourites import · added ${result.imported}` +
            ` · skipped ${result.skipped} · errors ${result.errors}` +
            ` · watching ${monitoring.watching}/${monitoring.tracked}`
        );
        res.json({
          ...result,
          preset: FAVOURITES_DISCOVER_PRESET,
          monitoring,
          wallets: getWalletsWithActivity(),
          discovery: getDiscoveryStatus(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({
          ok: false,
          error: message,
          imported: 0,
          skipped: 0,
          errors: 1,
          message,
        });
      }
    }
  );

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
      const work = getTopSmartWallets(limit, period, minWinRate);
      work.catch(() => undefined);
      const result = await Promise.race([
        work,
        new Promise<Awaited<ReturnType<typeof getTopSmartWallets>>>((resolve) => {
          setTimeout(() => {
            const curated = getCuratedSmartWallets(limit, period, minWinRate);
            curated.error = 'GMGN timed out — curated fallback';
            resolve(curated);
          }, 8_000);
        }),
      ]);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const curated = getCuratedSmartWallets(
        Number(req.query.limit) || 20,
        req.query.period === '30d' ? '30d' : '7d',
        Number(req.query.minWinRate) || 45
      );
      curated.error = message;
      res.json(curated);
    }
  });

  app.post('/api/gmgn/import', async (req: Request, res: Response) => {
    try {
      const minWinRate = Number(req.body?.minWinRate) || 45;
      const period = (req.body?.period === '30d' ? '30d' : '7d') as GmgnPeriod;
      const limit = Number(req.body?.limit) || 20;
      const { wallets, source } = await getTopSmartWallets(limit, period, minWinRate);
      const result = importSuggestedWallets(wallets, { minWinRate, onlyNew: true });
      const monitoring = syncWalletsToMonitoring(
        [...result.added, ...result.updated],
        `gmgn-import:${source}`
      );
      console.log(
        `[gmgn] Imported ${result.added.length} wallet(s) from ${source} (${period})` +
          ` · now watching ${monitoring.watching}/${monitoring.tracked}`
      );
      res.json({
        ...result,
        source,
        period,
        monitoring,
        wallets: getWalletsWithActivity(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // --- Nansen.ai Smart Money discovery ---

  app.get('/api/nansen/status', (_req: Request, res: Response) => {
    res.json({
      nansen: getNansenStatus(),
      presets: NANSEN_FILTER_PRESETS,
      wallets: getCachedNansenWallets(),
    });
  });

  app.post('/api/nansen/discover', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        presetId?: string;
        labels?: NansenSmartMoneyLabel[];
        minTradeUsd?: number;
        limit?: number;
        maxPages?: number;
        force?: boolean;
      };
      const result = await discoverNansenSmartWallets({
        presetId: body.presetId,
        labels: body.labels,
        minTradeUsd: body.minTradeUsd,
        limit: body.limit,
        maxPages: body.maxPages,
        force: Boolean(body.force),
      });
      const status = result.ok ? 200 : result.error?.includes('API key') ? 401 : 200;
      res.status(status).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        ok: false,
        error: message,
        wallets: getCachedNansenWallets(),
        nansen: getNansenStatus(),
      });
    }
  });

  app.post('/api/nansen/enrich', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        addresses?: string[];
        days?: number;
      };
      const addresses = Array.isArray(body.addresses) ? body.addresses : [];
      if (addresses.length === 0) {
        res.status(400).json({
          ok: false,
          error: 'Select at least one wallet address to enrich (costs ~1 credit each)',
          nansen: getNansenStatus(),
        });
        return;
      }
      if (addresses.length > 10) {
        res.status(400).json({
          ok: false,
          error: 'Max 10 wallets per enrich call to protect credits',
          nansen: getNansenStatus(),
        });
        return;
      }
      const result = await enrichNansenWalletsWithPnl(addresses, {
        days: body.days,
      });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        ok: false,
        error: message,
        nansen: getNansenStatus(),
      });
    }
  });

  app.post('/api/nansen/import-tracked', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        addresses?: string[];
        onlyNew?: boolean;
      };
      const addresses = Array.isArray(body.addresses) ? body.addresses : [];
      if (addresses.length === 0) {
        res.status(400).json({ error: 'No addresses provided' });
        return;
      }
      const result = importNansenToTracked(addresses, {
        onlyNew: body.onlyNew !== false,
      });
      const monitoring = syncWalletsToMonitoring(
        [...result.added, ...result.updated],
        'nansen-import'
      );
      console.log(
        `[nansen] Imported ${result.added.length} wallet(s)` +
          ` · now watching ${monitoring.watching}/${monitoring.tracked}`
      );
      res.json({
        ...result,
        monitoring,
        wallets: getWalletsWithActivity(),
        nansen: getNansenStatus(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/nansen/export', (req: Request, res: Response) => {
    const format = String(req.query.format ?? 'json').toLowerCase();
    const wallets = getCachedNansenWallets();
    if (format === 'csv') {
      const csv = nansenWalletsToCsv(wallets);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="nansen-smart-wallets.csv"'
      );
      res.send(csv);
      return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="nansen-smart-wallets.json"'
    );
    res.json({
      exportedAt: new Date().toISOString(),
      count: wallets.length,
      wallets,
    });
  });

  app.post('/api/nansen/import-file', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        format?: string;
        content?: string;
        wallets?: unknown[];
      };
      let parsed: ReturnType<typeof parseNansenCsv> = [];
      if (Array.isArray(body.wallets) && body.wallets.length) {
        parsed = parseNansenJson(JSON.stringify({ wallets: body.wallets }));
      } else if (typeof body.content === 'string' && body.content.trim()) {
        const fmt = String(body.format ?? 'auto').toLowerCase();
        const text = body.content.trim();
        if (fmt === 'csv' || (fmt === 'auto' && !text.startsWith('{') && !text.startsWith('['))) {
          parsed = parseNansenCsv(text);
        } else {
          parsed = parseNansenJson(text);
        }
      } else {
        res.status(400).json({
          ok: false,
          error: 'Provide content (CSV/JSON string) or wallets array',
        });
        return;
      }
      const result = importNansenWalletList(parsed);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ ok: false, error: message, nansen: getNansenStatus() });
    }
  });

  app.post('/api/nansen/clear-cache', (_req: Request, res: Response) => {
    clearNansenCache();
    res.json({ ok: true, nansen: getNansenStatus() });
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
      tradesLast30d?: number;
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
      tradesLast30d: body.tradesLast30d,
      pumpFunTradeCount: body.pumpFunTradeCount,
      notes: body.notes,
      tags,
      category: inferWalletCategory(tags, body.tradesLast7d),
      source: 'gmgn',
      discoveredAt: Date.now(),
    });
    const monitoring = syncWalletsToMonitoring(
      [body.address.trim()],
      'gmgn-top-add'
    );
    res.json({
      ok: true,
      added: result.added,
      updated: result.updated,
      monitoring,
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
      source: 'manual',
      discoveredAt: Date.now(),
    });
    if (!added) {
      res.status(409).json({ error: 'Wallet already tracked' });
      return;
    }
    const monitoring = syncWalletsToMonitoring([address.trim()], 'top-wallets-add');
    res.json({ ok: true, monitoring, wallets: getWalletsWithActivity() });
  });

  app.post('/api/wallets/refresh-activity', async (_req: Request, res: Response) => {
    try {
      const reports = await refreshAllWalletActivity();
      const filter = filterActiveWallets({ persistActiveOnly: false });
      const recovered = recoverDisabledWallets();
      // Kick poll so any recovered/enabled wallets are picked up
      const monitoring = syncWalletsToMonitoring([], 'refresh-activity');
      res.json({
        reports,
        filter,
        recovered,
        monitoring,
        wallets: getWalletsWithActivity(),
        watchedWallets: getMonitorStatus().watchedWallets,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /** Re-enable wallets that still look recently active (after bad RPC scans). */
  app.post('/api/wallets/recover', (_req: Request, res: Response) => {
    const recovered = recoverDisabledWallets();
    res.json({
      ...recovered,
      wallets: getWalletsWithActivity(),
      watchedWallets: getMonitorStatus().watchedWallets,
    });
  });

  app.post('/api/wallets/prune-inactive', (req: Request, res: Response) => {
    const maxDays =
      req.body?.maxDays != null
        ? Number(req.body.maxDays)
        : req.query.maxDays != null
          ? Number(req.query.maxDays)
          : 14;
    const days = Number.isFinite(maxDays) && maxDays > 0 ? maxDays : 14;
    const result = pruneInactiveWallets(days);
    const monitoring = syncWalletsToMonitoring([], 'after-prune');
    res.json({
      ...result,
      maxDaysInactive: days,
      monitoring,
      watchedWallets: getMonitorStatus().watchedWallets,
      wallets: getWalletsWithActivity(),
    });
  });

  app.post('/api/wallets/prune-low-quality', (req: Request, res: Response) => {
    const remove = req.body?.remove === true || req.body?.delete === true;
    const minScore =
      req.body?.minScore != null ? Number(req.body.minScore) : undefined;
    refreshAllWalletQualityScores();
    const result = pruneLowQualityWallets({
      remove,
      minScore: Number.isFinite(minScore as number) ? minScore : undefined,
    });
    const monitoring = syncWalletsToMonitoring([], 'after-quality-prune');
    res.json({
      ...result,
      remove,
      monitoring,
      watchedWallets: getMonitorStatus().watchedWallets,
      wallets: getWalletsWithActivity(),
    });
  });

  app.post('/api/wallets/refresh-quality', (_req: Request, res: Response) => {
    const scored = refreshAllWalletQualityScores();
    res.json({
      ...scored,
      wallets: getWalletsWithActivity(),
    });
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
      tradesLast30d?: number;
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
      tradesLast30d: body.tradesLast30d,
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

    const monitoring = syncWalletsToMonitoring(
      [body.address.trim()],
      `wallets-add:${body.source ?? 'manual'}`
    );

    res.json({
      ok: true,
      added: result.added,
      updated: result.updated,
      monitoring,
      wallets: getWalletsWithActivity(),
    });
  });

  /** Bulk import addresses (one per line / comma-separated; optional Name:Address) */
  app.post('/wallets/bulk-import', async (req: Request, res: Response) => {
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
      // Always force-enable on bulk import (even updates of previously disabled)
      const wallet = config.smartWallets.find((w) => w.address === address);
      if (wallet) {
        wallet.enabled = true;
        if (!wallet.discoveredAt) wallet.discoveredAt = Date.now();
      }
      if (result.added) added.push(address);
      else if (result.updated) updated.push(address);
      else skipped.push(address);
    }

    if (added.length + updated.length > 0) {
      persistWallets();
    }

    const toActivate = [...added, ...updated];
    const monitoring = syncWalletsToMonitoring(toActivate, 'bulk-import');

    // Background activity refresh so Last Active fills in soon (throttled)
    if (toActivate.length > 0) {
      void (async () => {
        const concurrency = 3;
        let i = 0;
        const workers = Array.from({ length: concurrency }, async () => {
          while (i < toActivate.length) {
            const idx = i++;
            const addr = toActivate[idx];
            const w = config.smartWallets.find((x) => x.address === addr);
            if (!w) continue;
            try {
              await refreshWalletActivity(w);
            } catch {
              /* ignore per-wallet failures */
            }
          }
        });
        await Promise.all(workers);
        console.log(
          `[monitor] Bulk-import activity refresh done for ${toActivate.length} wallet(s)`
        );
      })();
    }

    console.log(
      `[wallets] Bulk import: +${added.length} updated ${updated.length} skipped ${skipped.length} · ` +
        `activated for monitoring ${monitoring.watching}/${monitoring.tracked}`
    );

    res.json({
      ok: true,
      added,
      updated,
      skipped,
      activated: toActivate.length,
      monitoring,
      message:
        `Imported ${added.length} new, updated ${updated.length}. ` +
        `Activated ${toActivate.length} for monitoring ` +
        `(watching ${monitoring.watching}/${monitoring.tracked}).`,
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
    addSmartWallet({
      name,
      address,
      enabled: true,
      source: 'manual',
      discoveredAt: Date.now(),
    });
    const monitoring = syncWalletsToMonitoring([address], 'api-wallets-add');
    res.json({ wallets: config.smartWallets, monitoring });
  });

  app.delete('/api/wallets/:address', (req: Request, res: Response) => {
    removeSmartWallet(String(req.params.address));
    res.json({ wallets: config.smartWallets });
  });

  /** Wipe all tracked smart wallets (Watch list). Boot never auto-imports favourites. */
  app.post('/api/wallets/reset-tracker', (_req: Request, res: Response) => {
    const removed = clearAllSmartWallets();
    try {
      const { setSkipFavouritesAutoImport } =
        require('./dashboardState') as typeof import('./dashboardState');
      setSkipFavouritesAutoImport(true);
    } catch {
      /* ignore */
    }
    const monitoring = syncWalletsToMonitoring([], 'reset-tracker');
    console.log(
      `[wallets] Reset Wallet Tracker — removed ${removed} wallet(s)`
    );
    res.json({
      ok: true,
      removed,
      wallets: getWalletsWithActivity(),
      monitoring,
      message: `Removed ${removed} tracked wallet(s). Import Favourites when you want a watch list again.`,
    });
  });

  app.patch('/api/wallets/:address', (req: Request, res: Response) => {
    const address = String(req.params.address);
    const { enabled } = req.body as { enabled: boolean };
    toggleSmartWallet(address, enabled);
    const monitoring = enabled
      ? syncWalletsToMonitoring([address], 'toggle-enable')
      : syncWalletsToMonitoring([], 'toggle-disable');
    res.json({ wallets: config.smartWallets, monitoring });
  });

  // --- Dashboard (tabbed Tailwind UI) ---

  let dashboardGzipCache: Buffer | null = null;
  function getDashboardGzip(): Buffer {
    if (!dashboardGzipCache) {
      dashboardGzipCache = zlib.gzipSync(Buffer.from(DASHBOARD_HTML, 'utf8'), {
        level: 6,
      });
    }
    return dashboardGzipCache;
  }

  app.get('/dashboard', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html');
    const ae = String(req.headers['accept-encoding'] || '');
    if (/\bgzip\b/i.test(ae)) {
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.send(getDashboardGzip());
      return;
    }
    res.send(DASHBOARD_HTML);
  });

  app.get('/', (_req: Request, res: Response) => {
    res.redirect('/dashboard');
  });

  return app;
}

export function startServer(port?: number, host?: string): void {
  try {
    startRpcHealthMonitor();
  } catch (err) {
    console.warn(
      '[server] RPC health monitor failed to start:',
      err instanceof Error ? err.message : err
    );
  }
  try {
    startDiscoveryAutoRefresh();
  } catch (err) {
    console.warn(
      '[server] Discovery auto-refresh failed to start:',
      err instanceof Error ? err.message : err
    );
  }
  try {
    // New deploy / first run: start Overview elapsed timer without wiping trades
    ensureDashboardResetTimerForBuild();
  } catch (err) {
    console.warn(
      '[server] Dashboard reset timer ensure failed:',
      err instanceof Error ? err.message : err
    );
  }
  try {
    const {
      ensureGithubBackupSettingsFile,
      startGithubSiteBackupScheduler,
    } = require('./githubSiteBackup') as typeof import('./githubSiteBackup');
    ensureGithubBackupSettingsFile();
    startGithubSiteBackupScheduler();
  } catch (err) {
    console.warn(
      '[server] GitHub site-backup scheduler failed to start:',
      err instanceof Error ? err.message : err
    );
  }
  try {
    const {
      ensureBotPerfEmailSettingsFile,
      startBotPerfEmailScheduler,
    } = require('./botPerformanceEmail') as typeof import('./botPerformanceEmail');
    ensureBotPerfEmailSettingsFile();
    startBotPerfEmailScheduler();
  } catch (err) {
    console.warn(
      '[server] Bot performance email scheduler failed to start:',
      err instanceof Error ? err.message : err
    );
  }
  try {
    const { startProfitEmailScheduler } =
      require('./profitEmail') as typeof import('./profitEmail');
    startProfitEmailScheduler();
  } catch (err) {
    console.warn(
      '[server] Profit email scheduler failed to start:',
      err instanceof Error ? err.message : err
    );
  }
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

    try {
      const { startZionSupervisionScheduler } =
        require('./zionSupervision') as typeof import('./zionSupervision');
      startZionSupervisionScheduler();
    } catch (err) {
      console.warn(
        '[zion-supervision] scheduler start failed:',
        err instanceof Error ? err.message : err
      );
    }

    try {
      const { startZionLearningScheduler, ingestBotInfoGrowthNotes } =
        require('./zionContinuousLearning') as typeof import('./zionContinuousLearning');
      ingestBotInfoGrowthNotes(false);
      startZionLearningScheduler();
    } catch (err) {
      console.warn(
        '[zion-learning] scheduler start failed:',
        err instanceof Error ? err.message : err
      );
    }

    try {
      const { startZionAmbientNudgeScheduler } =
        require('./zionAmbientNudges') as typeof import('./zionAmbientNudges');
      startZionAmbientNudgeScheduler();
    } catch (err) {
      console.warn(
        '[zion-nudges] scheduler start failed:',
        err instanceof Error ? err.message : err
      );
    }

    try {
      const { startLearningEnhancementsScheduler } =
        require('./learningEnhancements') as typeof import('./learningEnhancements');
      startLearningEnhancementsScheduler();
    } catch (err) {
      console.warn(
        '[learning-enhancements] scheduler start failed:',
        err instanceof Error ? err.message : err
      );
    }

    // Auto-import after listen so a slow GitHub restore cannot block the dashboard.
    setTimeout(() => {
      void (async () => {
        try {
          const { maybeAutoImportGithubBackupOnBoot } =
            require('./githubSiteBackup') as typeof import('./githubSiteBackup');
          await maybeAutoImportGithubBackupOnBoot();
          try {
            const { reconcileCriticalSettingsFromBundledBackup } =
              require('./siteBackup') as typeof import('./siteBackup');
            reconcileCriticalSettingsFromBundledBackup({
              reason: 'post-github-auto-import',
            });
          } catch (err) {
            console.warn(
              '[boot-reconcile] post-import hook failed:',
              err instanceof Error ? err.message : err
            );
          }
          // Late pass: migrations / hydrate can re-stamp defaults after first reconcile.
          setTimeout(() => {
            try {
              const { reconcileCriticalSettingsFromBundledBackup } =
                require('./siteBackup') as typeof import('./siteBackup');
              reconcileCriticalSettingsFromBundledBackup({
                reason: 'boot-delayed',
              });
            } catch (err) {
              console.warn(
                '[boot-reconcile] delayed hook failed:',
                err instanceof Error ? err.message : err
              );
            }
          }, 8_000);
        } catch (err) {
          console.warn(
            '[github-backup] auto-import boot hook failed:',
            err instanceof Error ? err.message : err
          );
        }
      })();
    }, 2500);
  });
}
