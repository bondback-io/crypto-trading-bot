/**
 * Full-site backup / restore for dashboard-owned DATA_DIR state.
 * Private keys stay in env and are never included.
 *
 * Backup uses denylist auto-discovery: every parseable *.json under DATA_DIR
 * is included unless excluded (backups/, markers, calibration tooling, temps).
 * New feature files are picked up automatically without editing this module.
 */

import fs from 'fs';
import path from 'path';
import {
  atomicWriteJson,
  dataFile,
  ensureDataDir,
  getDataDir,
  getPersistenceStatus,
  readJsonFile,
} from './dataDir';

export const SITE_BACKUP_KIND = 'site-backup' as const;
export const SITE_BACKUP_VERSION = 1 as const;

const BACKUPS_DIR = () => dataFile('backups');
const LATEST_NAME = 'site-backup-latest.json';
const MAX_STAMPED = 10;

/**
 * Relative paths / prefixes / exact names skipped during auto-discovery.
 * Prefer denylist growth over allowlist — new feature JSON under DATA_DIR
 * is included by default.
 */
const BACKUP_DENY_EXACT = new Set([
  '.persist-marker.json',
  '.write-probe',
  'recipeCalibration48h.json',
]);

const BACKUP_DENY_PREFIXES = [
  'backups/',
];

const BACKUP_DENY_SUFFIXES = [
  '.log',
  '.tmp',
  '.bak',
];

const BACKUP_DENY_NAME_PARTS = [
  'calibrateRiskRecipes',
  'recipeCalibration',
];

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

function toPosixRel(rel: string): string {
  return String(rel || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
}

/** Whether a relative DATA_DIR path should be excluded from backup. */
export function isDeniedBackupRelPath(relPath: string): boolean {
  const cleaned = toPosixRel(relPath);
  if (!cleaned || cleaned.includes('..')) return true;
  const base = path.posix.basename(cleaned);
  if (BACKUP_DENY_EXACT.has(cleaned) || BACKUP_DENY_EXACT.has(base)) {
    return true;
  }
  for (const prefix of BACKUP_DENY_PREFIXES) {
    if (cleaned === prefix.replace(/\/$/, '') || cleaned.startsWith(prefix)) {
      return true;
    }
  }
  const lower = cleaned.toLowerCase();
  for (const suffix of BACKUP_DENY_SUFFIXES) {
    if (lower.endsWith(suffix)) return true;
  }
  for (const part of BACKUP_DENY_NAME_PARTS) {
    if (lower.includes(part.toLowerCase())) return true;
  }
  // Atomic-write leftovers: foo.json.123.456.tmp already caught by .tmp;
  // also skip hidden probe/dotfiles that are not real app state.
  if (base.startsWith('.') && base !== '.env.example') return true;
  return false;
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

/**
 * Recursively collect every parseable *.json under DATA_DIR except denylist.
 */
function collectDiscoverableJsonFiles(
  files: Record<string, unknown>
): void {
  const root = getDataDir();
  if (!fs.existsSync(root)) return;

  const walk = (absDir: string, relDir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const name = ent.name;
      const rel = relDir ? `${relDir}/${name}` : name;
      const abs = path.join(absDir, name);
      if (ent.isDirectory()) {
        if (isDeniedBackupRelPath(rel + '/')) continue;
        walk(abs, rel);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!name.toLowerCase().endsWith('.json')) continue;
      if (isDeniedBackupRelPath(rel)) continue;
      const data = readJsonIfPresent(rel);
      if (data != null) files[toPosixRel(rel)] = data;
    }
  };

  walk(root, '');
}

export function buildSiteBackup(): SiteBackup {
  ensureDataDir();
  const exportedAtMs = Date.now();
  const files: Record<string, unknown> = {};
  collectDiscoverableJsonFiles(files);

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
  const cleaned = toPosixRel(rel);
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
    // Skip denylisted paths even if present in an older/hand-edited archive
    if (isDeniedBackupRelPath(safe)) continue;
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
  const { invalidateFastProfileRecoveryCache } =
    require('./fastProfileRecovery') as typeof import('./fastProfileRecovery');
  const { invalidateDipBuyerRecoveryCache } =
    require('./dipBuyerRecovery') as typeof import('./dipBuyerRecovery');

  clearDashboardStateCache();
  invalidateDashboardNotificationsCache();
  invalidateProfileLearningEpisodeCache();
  invalidateLearningSaveCache();
  invalidateLaneOutcomesCache();
  invalidateScannerOutcomesCache();
  invalidateFastProfileRecoveryCache();
  invalidateDipBuyerRecoveryCache();
  reloadZionOffersFromDisk();

  applyPersistedSettings({ replaceStrategyToggles: true });
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

/**
 * Bundled repo copy of site-backup-latest.json (shipped with the deploy image).
 * Used to seed a fresh/wiped DATA_DIR before migrations write code defaults.
 */
export function resolveBundledRepoSiteBackupPath(): string | null {
  const candidates = [
    path.join(process.cwd(), 'site-backups', LATEST_NAME),
    path.join(__dirname, '..', 'site-backups', LATEST_NAME),
    path.join(__dirname, '..', '..', 'site-backups', LATEST_NAME),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* try next */
    }
  }
  return null;
}

export function loadBundledRepoSiteBackup(): SiteBackup | null {
  const filePath = resolveBundledRepoSiteBackupPath();
  if (!filePath) return null;
  try {
    const raw = JSON.parse(
      fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')
    ) as unknown;
    if (!isValidSiteBackup(raw)) return null;
    return raw;
  } catch (err) {
    console.warn(
      '[boot-seed] failed to read bundled site-backup-latest.json:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * When config.json is missing (fresh / wiped volume), synchronously restore from
 * the repo-bundled site-backup-latest.json BEFORE migrations persist defaults.
 */
export function maybeSeedDataDirFromBundledSiteBackup(): {
  seeded: boolean;
  reason: string;
  written?: string[];
  exportedAt?: string;
  fileCount?: number;
  path?: string | null;
} {
  const { hasPersistedSettings } =
    require('./settingsStore') as typeof import('./settingsStore');
  if (hasPersistedSettings()) {
    console.log('[boot-seed] skipped: config.json already present');
    return { seeded: false, reason: 'config present' };
  }

  const bundledPath = resolveBundledRepoSiteBackupPath();
  const backup = loadBundledRepoSiteBackup();
  if (!backup) {
    console.log(
      '[boot-seed] skipped: no valid bundled site-backups/site-backup-latest.json'
    );
    return { seeded: false, reason: 'no bundled backup', path: bundledPath };
  }

  console.log(
    `[boot-seed] seeding DATA_DIR from bundled backup` +
      (bundledPath ? ` (${bundledPath})` : '') +
      ` · exportedAt=${backup.exportedAt} · files=${backup.fileCount || Object.keys(backup.files || {}).length}`
  );
  try {
    const result = restoreSiteBackup(backup);
    console.log(
      `[boot-seed] seeded ok · ${result.fileCount} file(s) · ${result.exportedAt}`
    );
    return {
      seeded: true,
      reason: 'seeded from bundled backup',
      written: result.written,
      exportedAt: result.exportedAt,
      fileCount: result.fileCount,
      path: bundledPath,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[boot-seed] restore failed:', msg);
    return {
      seeded: false,
      reason: `seed failed: ${msg.slice(0, 160)}`,
      path: bundledPath,
    };
  }
}
