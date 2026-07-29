/**
 * Full-site backup / restore for dashboard-owned DATA_DIR state.
 * Private keys stay in env and are never included.
 */

import fs from 'fs';
import path from 'path';
import {
  atomicWriteJson,
  dataFile,
  ensureDataDir,
  getDataDir,
  getPersistenceStatus,
  PERSIST_FILES,
  readJsonFile,
} from './dataDir';

export const SITE_BACKUP_KIND = 'site-backup' as const;
export const SITE_BACKUP_VERSION = 1 as const;

const BACKUPS_DIR = () => dataFile('backups');
const LATEST_NAME = 'site-backup-latest.json';
const MAX_STAMPED = 10;

/** Flat relative paths under DATA_DIR to include when present. */
const ROOT_BACKUP_FILES = [
  PERSIST_FILES.config,
  PERSIST_FILES.wallets,
  PERSIST_FILES.paperBalance,
  PERSIST_FILES.backtestHistory,
  PERSIST_FILES.optimizerLast,
  PERSIST_FILES.tradingWallets,
  PERSIST_FILES.dashboardState,
  PERSIST_FILES.zionOffers,
  PERSIST_FILES.zionKolUniverse,
  PERSIST_FILES.laneOutcomes,
  PERSIST_FILES.tradeProfilesUser,
  'profile-learning-saves.json',
  'dashboard-notifications.json',
  'scanner-outcomes.json',
  'nansen-wallets-cache.json',
] as const;

export interface SiteBackup {
  version: typeof SITE_BACKUP_VERSION;
  kind: typeof SITE_BACKUP_KIND;
  exportedAt: string;
  exportedAtMs: number;
  appVersion: string;
  dataDir: string;
  fileCount: number;
  files: Record<string, unknown>;
}

export interface SiteBackupMeta {
  exists: boolean;
  exportedAt: string | null;
  exportedAtMs: number | null;
  filename: string | null;
  fileCount: number;
  appVersion: string | null;
  path: string | null;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function stampFilename(ms: number): string {
  const d = new Date(ms);
  const stamp =
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return `site-backup-${stamp}.json`;
}

function readJsonIfPresent(relPath: string): unknown | null {
  const full = dataFile(...relPath.split('/'));
  if (!fs.existsSync(full)) return null;
  try {
    const raw = fs.readFileSync(full, 'utf8');
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function collectProfileLearningFiles(
  files: Record<string, unknown>
): void {
  try {
    const dir = dataFile('profile-learning');
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const rel = `profile-learning/${name}`;
      const data = readJsonIfPresent(rel);
      if (data != null) files[rel] = data;
    }
  } catch {
    /* optional */
  }
}

export function buildSiteBackup(): SiteBackup {
  ensureDataDir();
  const exportedAtMs = Date.now();
  const files: Record<string, unknown> = {};
  for (const name of ROOT_BACKUP_FILES) {
    const data = readJsonIfPresent(name);
    if (data != null) files[name] = data;
  }
  collectProfileLearningFiles(files);

  let appVersion = 'unknown';
  try {
    const { getAppVersion } = require('./version') as typeof import('./version');
    appVersion = getAppVersion().label || getAppVersion().version || 'unknown';
  } catch {
    /* optional */
  }

  return {
    version: SITE_BACKUP_VERSION,
    kind: SITE_BACKUP_KIND,
    exportedAt: new Date(exportedAtMs).toISOString(),
    exportedAtMs,
    appVersion,
    dataDir: getDataDir(),
    fileCount: Object.keys(files).length,
    files,
  };
}

function pruneOldStampedBackups(): void {
  try {
    const dir = BACKUPS_DIR();
    if (!fs.existsSync(dir)) return;
    const stamped = fs
      .readdirSync(dir)
      .filter(
        (n) =>
          n.startsWith('site-backup-') &&
          n.endsWith('.json') &&
          n !== LATEST_NAME
      )
      .map((n) => ({
        name: n,
        mtime: fs.statSync(path.join(dir, n)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of stamped.slice(MAX_STAMPED)) {
      try {
        fs.unlinkSync(path.join(dir, old.name));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* optional */
  }
}

export function saveSiteBackup(backup: SiteBackup): {
  stampedPath: string;
  latestPath: string;
  filename: string;
} {
  ensureDataDir();
  const dir = BACKUPS_DIR();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filename = stampFilename(backup.exportedAtMs);
  const stampedPath = path.join(dir, filename);
  const latestPath = path.join(dir, LATEST_NAME);
  atomicWriteJson(stampedPath, backup);
  atomicWriteJson(latestPath, backup);
  pruneOldStampedBackups();
  return { stampedPath, latestPath, filename };
}

export function getLatestSiteBackupMeta(): SiteBackupMeta {
  const latestPath = path.join(BACKUPS_DIR(), LATEST_NAME);
  const empty: SiteBackupMeta = {
    exists: false,
    exportedAt: null,
    exportedAtMs: null,
    filename: null,
    fileCount: 0,
    appVersion: null,
    path: null,
  };
  try {
    if (!fs.existsSync(latestPath)) return empty;
    const raw = readJsonFile<SiteBackup>(latestPath);
    if (!raw || raw.kind !== SITE_BACKUP_KIND) return empty;
    return {
      exists: true,
      exportedAt: raw.exportedAt || null,
      exportedAtMs: raw.exportedAtMs ?? null,
      filename: stampFilename(raw.exportedAtMs || Date.now()),
      fileCount: raw.fileCount || Object.keys(raw.files || {}).length,
      appVersion: raw.appVersion || null,
      path: latestPath,
    };
  } catch {
    return empty;
  }
}

export function loadLatestSiteBackup(): SiteBackup | null {
  const latestPath = path.join(BACKUPS_DIR(), LATEST_NAME);
  const raw = readJsonFile<SiteBackup>(latestPath);
  if (!raw || raw.kind !== SITE_BACKUP_KIND) return null;
  if (!raw.files || typeof raw.files !== 'object') return null;
  return raw;
}

export function isValidSiteBackup(raw: unknown): raw is SiteBackup {
  if (!raw || typeof raw !== 'object') return false;
  const b = raw as SiteBackup;
  return (
    b.kind === SITE_BACKUP_KIND &&
    Number(b.version) === SITE_BACKUP_VERSION &&
    b.files != null &&
    typeof b.files === 'object' &&
    !Array.isArray(b.files)
  );
}

function safeRelPath(rel: string): string | null {
  const cleaned = String(rel || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('..')) return null;
  if (cleaned.startsWith('backups/')) return null;
  return cleaned;
}

function writeBackupFiles(backup: SiteBackup): string[] {
  ensureDataDir();
  const written: string[] = [];
  for (const [rel, data] of Object.entries(backup.files || {})) {
    const safe = safeRelPath(rel);
    if (!safe) continue;
    const full = dataFile(...safe.split('/'));
    const dir = path.dirname(full);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    atomicWriteJson(full, data);
    written.push(safe);
  }
  return written;
}

/**
 * Hot-reload in-memory runtime from DATA_DIR after files were restored.
 */
export function reloadPersistedRuntimeFromDisk(): void {
  const {
    applyPersistedSettings,
    initWallets,
    initTradingWallets,
  } = require('./config') as typeof import('./config');
  const { clearDashboardStateCache } =
    require('./dashboardState') as typeof import('./dashboardState');
  const { applyTradeProfilesUserStateOnBoot } =
    require('./tradeProfilesUserStore') as typeof import('./tradeProfilesUserStore');
  const { ensureTradeProfilesInitialized } =
    require('./tradeProfiles') as typeof import('./tradeProfiles');
  const { paperTrader } =
    require('./paperTrader') as typeof import('./paperTrader');
  const { invalidateDashboardNotificationsCache } =
    require('./dashboardNotifications') as typeof import('./dashboardNotifications');
  const { invalidateProfileLearningEpisodeCache } =
    require('./profileLearningEpisodes') as typeof import('./profileLearningEpisodes');
  const { invalidateLearningSaveCache } =
    require('./profileLearningSaveLog') as typeof import('./profileLearningSaveLog');
  const { reloadZionOffersFromDisk } =
    require('./zion') as typeof import('./zion');
  const { invalidateLaneOutcomesCache } =
    require('./laneOutcomes') as typeof import('./laneOutcomes');
  const { invalidateScannerOutcomesCache } =
    require('./scannerOutcomes') as typeof import('./scannerOutcomes');

  clearDashboardStateCache();
  invalidateDashboardNotificationsCache();
  invalidateProfileLearningEpisodeCache();
  invalidateLearningSaveCache();
  invalidateLaneOutcomesCache();
  invalidateScannerOutcomesCache();
  reloadZionOffersFromDisk();

  applyPersistedSettings();
  initWallets();
  initTradingWallets();
  ensureTradeProfilesInitialized();
  applyTradeProfilesUserStateOnBoot();
  try {
    paperTrader.loadPersistedState();
  } catch {
    /* paper mode may differ */
  }
}

export function restoreSiteBackup(
  source: SiteBackup | 'latest'
): {
  ok: true;
  written: string[];
  exportedAt: string;
  fileCount: number;
} {
  const backup =
    source === 'latest' ? loadLatestSiteBackup() : source;
  if (!backup || !isValidSiteBackup(backup)) {
    throw new Error(
      source === 'latest'
        ? 'No site-backup-latest.json found — run Backup Site first, or upload a backup file.'
        : 'Invalid backup: expected kind=site-backup version=1'
    );
  }
  const written = writeBackupFiles(backup);
  reloadPersistedRuntimeFromDisk();
  try {
    const { pushDashboardNotification } =
      require('./dashboardNotifications') as typeof import('./dashboardNotifications');
    pushDashboardNotification({
      kind: 'system',
      title: 'Site backup restored',
      body: `${backup.exportedAt} · ${written.length} file(s)`,
    });
  } catch {
    /* optional */
  }
  return {
    ok: true,
    written,
    exportedAt: backup.exportedAt,
    fileCount: written.length,
  };
}

export function createAndSaveSiteBackup(): {
  backup: SiteBackup;
  filename: string;
  meta: SiteBackupMeta;
  persistence: ReturnType<typeof getPersistenceStatus>;
} {
  const backup = buildSiteBackup();
  const saved = saveSiteBackup(backup);
  return {
    backup,
    filename: saved.filename,
    meta: getLatestSiteBackupMeta(),
    persistence: getPersistenceStatus(),
  };
}
