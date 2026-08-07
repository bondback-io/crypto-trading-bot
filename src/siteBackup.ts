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

/** Avoid re-parsing multi‑MB latest backup on every meta poll. */
let latestMetaCache: { mtimeMs: number; path: string; meta: SiteBackupMeta } | null =
  null;

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
    if (!fs.existsSync(latestPath)) {
      latestMetaCache = null;
      return empty;
    }
    const mtimeMs = fs.statSync(latestPath).mtimeMs;
    if (
      latestMetaCache &&
      latestMetaCache.path === latestPath &&
      latestMetaCache.mtimeMs === mtimeMs
    ) {
      return latestMetaCache.meta;
    }
    const raw = readJsonFile<SiteBackup>(latestPath);
    if (!raw || raw.kind !== SITE_BACKUP_KIND) return empty;
    const meta: SiteBackupMeta = {
      exists: true,
      exportedAt: raw.exportedAt || null,
      exportedAtMs: raw.exportedAtMs ?? null,
      filename: stampFilename(raw.exportedAtMs || Date.now()),
      fileCount: raw.fileCount || Object.keys(raw.files || {}).length,
      appVersion: raw.appVersion || null,
      path: latestPath,
    };
    latestMetaCache = { mtimeMs, path: latestPath, meta };
    return meta;
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
  // Prevent Upload-to-GitHub from re-poisoning remote with code defaults when
  // DATA_DIR still has un-saved / reset HMC·FPR·DBR·Zion·Trade Caps.
  try {
    reconcileCriticalSettingsFromBundledBackup({ reason: 'pre-backup-export' });
  } catch (err) {
    console.warn(
      '[boot-reconcile] pre-backup reconcile failed:',
      err instanceof Error ? err.message : err
    );
  }
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

/** Repo bundled backup is multi‑MB — cache by mtime for reconcile / pre-upload. */
let bundledRepoBackupCache: {
  path: string;
  mtimeMs: number;
  backup: SiteBackup;
} | null = null;

export function loadBundledRepoSiteBackup(): SiteBackup | null {
  const filePath = resolveBundledRepoSiteBackupPath();
  if (!filePath) return null;
  try {
    const mtimeMs = fs.statSync(filePath).mtimeMs;
    if (
      bundledRepoBackupCache &&
      bundledRepoBackupCache.path === filePath &&
      bundledRepoBackupCache.mtimeMs === mtimeMs
    ) {
      return bundledRepoBackupCache.backup;
    }
    const raw = JSON.parse(
      fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')
    ) as unknown;
    if (!isValidSiteBackup(raw)) return null;
    bundledRepoBackupCache = { path: filePath, mtimeMs, backup: raw };
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

function parseBackupConfigJson(backup: SiteBackup): Record<string, unknown> | null {
  const raw = backup.files?.['config.json'];
  if (raw == null) return null;
  try {
    if (typeof raw === 'string') {
      return JSON.parse(raw) as Record<string, unknown>;
    }
    if (typeof raw === 'object') {
      return raw as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

/** True when live critical prefs still match shipped code defaults (poisoned disk). */
export function criticalSettingsLookLikeCodeDefaults(): boolean {
  try {
    const { config } = require('./config') as typeof import('./config');
    const hmc = config.hierarchicalCoordination as
      | {
          gatekeeperStrictness?: string;
          classifierEnabled?: boolean;
          minVolumeM5Usd?: number;
        }
      | undefined;
    const fpr = config.fastProfileRecovery as { enabled?: boolean } | undefined;
    const dbr = config.dipBuyerRecovery as { stage?: number } | undefined;
    const zt = config.zionTransfers as { enabled?: boolean } | undefined;
    const sel = config.selective as
      | { maxTradesPerHour?: number; minMsBetweenTrades?: number }
      | undefined;

    const hmcDefault =
      !hmc ||
      ((hmc.gatekeeperStrictness === 'medium' || !hmc.gatekeeperStrictness) &&
        hmc.classifierEnabled !== true &&
        (hmc.minVolumeM5Usd == null || Number(hmc.minVolumeM5Usd) === 800));
    const fprDefault = !fpr || fpr.enabled !== true;
    const dbrDefault = !dbr || Number(dbr.stage) === 0;
    const ztDefault = !zt || zt.enabled !== true;
    const capsDefault =
      !sel ||
      (Number(sel.maxTradesPerHour) === 16 &&
        Number(sel.minMsBetweenTrades) === 25_000);

    return hmcDefault || fprDefault || dbrDefault || ztDefault || capsDefault;
  } catch {
    return false;
  }
}

/**
 * When DATA_DIR config still has code-default critical knobs, overlay the
 * preferred values from the repo-bundled site-backup-latest.json and persist.
 * Runs on boot (config present) and before GitHub upload so Upload cannot
 * re-poison the remote with defaults.
 */
export function reconcileCriticalSettingsFromBundledBackup(opts?: {
  reason?: string;
}): {
  changed: boolean;
  applied: string[];
  reason: string;
} {
  const reason = String(opts?.reason || 'boot').slice(0, 80);
  // Re-read disk first — a later persist can stamp defaults after an earlier
  // in-memory reconcile, leaving memory "good" while config.json is poisoned.
  try {
    const { applyPersistedSettings } =
      require('./config') as typeof import('./config');
    applyPersistedSettings({ replaceStrategyToggles: true });
  } catch {
    /* optional */
  }
  const backup = loadBundledRepoSiteBackup();
  if (!backup) {
    return { changed: false, applied: [], reason: 'no bundled backup' };
  }
  const bundledCfg = parseBackupConfigJson(backup);
  if (!bundledCfg) {
    return { changed: false, applied: [], reason: 'bundled config.json missing' };
  }

  const { config, persistUserSettings } =
    require('./config') as typeof import('./config');
  const applied: string[] = [];

  // —— HMC Gatekeeper / Classifier ——
  try {
    const {
      getHierarchicalCoordinationConfig,
      setHierarchicalCoordinationConfig,
      DEFAULT_HIERARCHICAL_COORDINATION,
    } =
      require('./hierarchicalCoordination') as typeof import('./hierarchicalCoordination');
    const live = getHierarchicalCoordinationConfig();
    const src = bundledCfg.hierarchicalCoordination as
      | Record<string, unknown>
      | undefined;
    const looksDefault =
      live.gatekeeperStrictness === 'medium' &&
      live.classifierEnabled !== true &&
      Number(live.minVolumeM5Usd) ===
        Number(DEFAULT_HIERARCHICAL_COORDINATION.minVolumeM5Usd);
    if (
      looksDefault &&
      src &&
      typeof src === 'object' &&
      (src.gatekeeperStrictness === 'low' ||
        src.gatekeeperStrictness === 'high' ||
        src.classifierEnabled === true)
    ) {
      setHierarchicalCoordinationConfig({
        enabled: src.enabled !== false,
        gatekeeperEnabled: src.gatekeeperEnabled !== false,
        gatekeeperStrictness:
          src.gatekeeperStrictness === 'low' ||
          src.gatekeeperStrictness === 'high' ||
          src.gatekeeperStrictness === 'medium'
            ? (src.gatekeeperStrictness as 'low' | 'medium' | 'high')
            : 'low',
        softBlocksEnforced: src.softBlocksEnforced !== false,
        minVolumeM5Usd:
          Number(src.minVolumeM5Usd) ||
          (src.gatekeeperStrictness === 'low' ? 400 : live.minVolumeM5Usd),
        minVolumeH1Usd:
          Number(src.minVolumeH1Usd) ||
          (src.gatekeeperStrictness === 'low' ? 1200 : live.minVolumeH1Usd),
        minLiquidityUsd:
          Number(src.minLiquidityUsd) ||
          (src.gatekeeperStrictness === 'low' ? 5000 : live.minLiquidityUsd),
        debugLogging:
          src.debugLogging === 'off' ||
          src.debugLogging === 'verbose' ||
          src.debugLogging === 'normal'
            ? src.debugLogging
            : live.debugLogging,
        classifierEnabled: src.classifierEnabled === true,
        unknownSetupsCanTrade: src.unknownSetupsCanTrade !== false,
        classifierSoftEligibility: src.classifierSoftEligibility !== false,
      });
      applied.push('hierarchicalCoordination');
    }
  } catch (err) {
    console.warn(
      '[boot-reconcile] HMC overlay failed:',
      err instanceof Error ? err.message : err
    );
  }

  // —— Fast Profiles Recovery (Group ON + stages) ——
  try {
    const {
      getFastProfileRecoveryConfig,
      setFastProfileRecoveryConfig,
      FAST_RECOVERY_PROFILE_IDS,
    } =
      require('./fastProfileRecovery') as typeof import('./fastProfileRecovery');
    const live = getFastProfileRecoveryConfig();
    const src = bundledCfg.fastProfileRecovery as
      | {
          enabled?: boolean;
          autoTaper?: boolean;
          profiles?: Record<string, unknown>;
          stage0?: Record<string, unknown>;
        }
      | undefined;
    if (live.enabled !== true && src && src.enabled === true) {
      const profiles: Record<string, unknown> = { ...(live.profiles || {}) };
      for (const id of FAST_RECOVERY_PROFILE_IDS) {
        const p = (src.profiles?.[id] || {}) as {
          enabled?: boolean;
          stage?: number;
          stageLocked?: boolean;
          forcedStage?: number | null;
          learningModeOverride?: boolean;
        };
        const stageN = Math.round(Number(p.stage ?? 0));
        profiles[id] = {
          enabled: p.enabled !== false,
          stage: (stageN <= 0 ? 0 : stageN >= 4 ? 4 : stageN) as 0 | 1 | 2 | 3 | 4,
          stageLocked: p.stageLocked === true,
          forcedStage:
            p.forcedStage != null && Number.isFinite(Number(p.forcedStage))
              ? Math.round(Number(p.forcedStage))
              : null,
          learningModeOverride: p.learningModeOverride === true,
        };
      }
      setFastProfileRecoveryConfig({
        enabled: true,
        autoTaper: src.autoTaper !== false,
        profiles: profiles as never,
        ...(src.stage0 ? { stage0: src.stage0 as never } : {}),
      });
      applied.push('fastProfileRecovery');
    }
  } catch (err) {
    console.warn(
      '[boot-reconcile] FPR overlay failed:',
      err instanceof Error ? err.message : err
    );
  }

  // —— Dip Buyer Recovery stage ——
  try {
    const { getDipBuyerRecoveryConfig, setDipBuyerRecoveryConfig } =
      require('./dipBuyerRecovery') as typeof import('./dipBuyerRecovery');
    const live = getDipBuyerRecoveryConfig();
    const src = bundledCfg.dipBuyerRecovery as
      | {
          enabled?: boolean;
          autoTaper?: boolean;
          stage?: number;
          stageLocked?: boolean;
          forcedStage?: number | null;
          learningModeOverride?: boolean;
        }
      | undefined;
    const bundledStage = Math.round(Number(src?.stage ?? 0));
    if (
      Number(live.stage) === 0 &&
      src &&
      bundledStage >= 1 &&
      bundledStage <= 4
    ) {
      setDipBuyerRecoveryConfig({
        enabled: src.enabled !== false,
        autoTaper: src.autoTaper !== false,
        stage: bundledStage as 0 | 1 | 2 | 3 | 4,
        stageLocked: src.stageLocked === true,
        forcedStage:
          src.forcedStage != null && Number.isFinite(Number(src.forcedStage))
            ? (Math.round(Number(src.forcedStage)) as 0 | 1 | 2 | 3 | 4)
            : null,
        learningModeOverride: src.learningModeOverride === true,
      });
      applied.push('dipBuyerRecovery');
    }
  } catch (err) {
    console.warn(
      '[boot-reconcile] DBR overlay failed:',
      err instanceof Error ? err.message : err
    );
  }

  // —— Zion wallet transfers ——
  try {
    const src = bundledCfg.zionTransfers as
      | { enabled?: boolean; savedWallets?: unknown[] }
      | undefined;
    const live = config.zionTransfers;
    if (
      live?.enabled !== true &&
      src &&
      src.enabled === true
    ) {
      config.zionTransfers = {
        ...live,
        enabled: true,
        savedWallets:
          Array.isArray(src.savedWallets) && src.savedWallets.length
            ? (src.savedWallets as typeof live.savedWallets)
            : live.savedWallets,
      };
      applied.push('zionTransfers');
    }
  } catch (err) {
    console.warn(
      '[boot-reconcile] Zion transfers overlay failed:',
      err instanceof Error ? err.message : err
    );
  }

  // —— Trade Caps (selective rate limits) ——
  try {
    const src = bundledCfg.selective as
      | { maxTradesPerHour?: number; minMsBetweenTrades?: number }
      | undefined;
    const live = config.selective;
    if (
      live &&
      Number(live.maxTradesPerHour) === 16 &&
      Number(live.minMsBetweenTrades) === 25_000 &&
      src &&
      (Number(src.maxTradesPerHour) !== 16 ||
        Number(src.minMsBetweenTrades) !== 25_000)
    ) {
      if (src.maxTradesPerHour != null && Number.isFinite(Number(src.maxTradesPerHour))) {
        live.maxTradesPerHour = Math.round(Number(src.maxTradesPerHour));
      }
      if (
        src.minMsBetweenTrades != null &&
        Number.isFinite(Number(src.minMsBetweenTrades))
      ) {
        live.minMsBetweenTrades = Math.round(Number(src.minMsBetweenTrades));
      }
      applied.push('selective.tradeCaps');
    }
  } catch (err) {
    console.warn(
      '[boot-reconcile] Trade Caps overlay failed:',
      err instanceof Error ? err.message : err
    );
  }

  if (!applied.length) {
    console.log(`[boot-reconcile] skipped (${reason}): nothing default-like to overlay`);
    return { changed: false, applied: [], reason: 'no-op' };
  }

  try {
    persistUserSettings();
  } catch (err) {
    console.warn(
      '[boot-reconcile] persist failed:',
      err instanceof Error ? err.message : err
    );
  }
  try {
    const { invalidateFastProfileRecoveryCache } =
      require('./fastProfileRecovery') as typeof import('./fastProfileRecovery');
    invalidateFastProfileRecoveryCache();
  } catch {
    /* optional */
  }
  try {
    const { invalidateDipBuyerRecoveryCache } =
      require('./dipBuyerRecovery') as typeof import('./dipBuyerRecovery');
    invalidateDipBuyerRecoveryCache();
  } catch {
    /* optional */
  }

  console.log(
    `[boot-reconcile] applied from bundled backup (${reason}): ${applied.join(', ')}`
  );
  return { changed: true, applied, reason: 'applied' };
}
