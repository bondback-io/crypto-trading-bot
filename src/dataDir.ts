/**
 * Shared persistent data directory for config, wallets, paper state, and backtests.
 *
 * Canonical files (under DATA_DIR / ./data):
 *   config.json, wallets.json, paperBalance.json, backtestHistory.json
 *   (+ trading-wallets.json for live slot metadata)
 *
 * On Render/Fly the container filesystem is ephemeral unless DATA_DIR is a
 * real mounted volume (Render Disk at /var/data, Fly volume at /data).
 */

import fs from 'fs';
import path from 'path';

/** Legacy Render path (pre-/var/data). Used only for one-shot migration. */
export const LEGACY_RENDER_DATA_DIR = '/opt/render/project/src/data';
/** Preferred Render disk mount (standalone; safer than under src/). */
export const PREFERRED_RENDER_DATA_DIR = '/var/data';

const PERSIST_MARKER = '.persist-marker.json';

function resolveDataDir(): string {
  const fromEnv = (
    process.env.DATA_DIR ||
    process.env.RENDER_DISK_PATH ||
    ''
  ).trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(process.cwd(), 'data');
}

let cached: string | null = null;

/** Absolute path to the bot data directory. */
export function getDataDir(): string {
  if (!cached) cached = resolveDataDir();
  return cached;
}

export function ensureDataDir(): string {
  const dir = getDataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function dataFile(...parts: string[]): string {
  return path.join(getDataDir(), ...parts);
}

/** Canonical persisted filenames */
export const PERSIST_FILES = {
  config: 'config.json',
  wallets: 'wallets.json',
  paperBalance: 'paperBalance.json',
  backtestHistory: 'backtestHistory.json',
  optimizerLast: 'optimizerLast.json',
  tradingWallets: 'trading-wallets.json',
  /** Overview Reset timestamp + session meta */
  dashboardState: 'dashboardState.json',
  /** Zion micro-bot pending/executed trade offers */
  zionOffers: 'zion-offers.json',
  /** Cached KOL universe for Zion scanner (not watch list) */
  zionKolUniverse: 'zion-kol-universe.json',
  /** Smart Bot lane fight outcomes + closed PnL join */
  laneOutcomes: 'lane-outcomes.json',
  /**
   * User-owned trade profile knobs (enables, overrides, self-learning).
   * Survives baked-defaults re-import on deploy; always reloaded on boot.
   */
  tradeProfilesUser: 'trade-profiles-user.json',
  /** Per-profile TA playbooks (Off/Soft/Hard + tools) — survives bake */
  profileTaPlaybooks: 'profile-ta-playbooks.json',
  /** Legacy names — migrated once on load */
  legacyConfig: 'bot-settings.json',
  legacyBacktest: 'backtest-history.json',
} as const;

export function isRunningOnRender(): boolean {
  return (
    process.env.RENDER === 'true' ||
    Boolean(process.env.RENDER_SERVICE_ID) ||
    Boolean(process.env.RENDER_EXTERNAL_URL)
  );
}

export function isRunningOnFly(): boolean {
  return Boolean(process.env.FLY_APP_NAME || process.env.FLY_MACHINE_ID);
}

/** True when running on a known cloud host that needs a mounted volume for data/ */
export function isCloudHost(): boolean {
  return isRunningOnRender() || isRunningOnFly();
}

function sleepSyncMs(ms: number): void {
  const end = Date.now() + Math.max(0, ms);
  while (Date.now() < end) {
    /* busy-wait — only used for short OneDrive lock retries */
  }
}

function isBusyFsError(err: unknown): boolean {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: string }).code || '')
      : '';
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

/**
 * Atomic JSON write: write temp file then rename (safe across crashes).
 * On Windows, replaces destination if rename-over-existing fails.
 * Retries unlink/rename briefly for OneDrive / AV file locks (EBUSY).
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  ensureDataDir();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const payload =
    typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, payload, 'utf-8');
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        try {
          fs.renameSync(tmp, filePath);
          return;
        } catch {
          // Windows: rename onto existing file often fails
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
          fs.renameSync(tmp, filePath);
          return;
        }
      } catch (err) {
        lastErr = err;
        if (!isBusyFsError(err) || attempt === 7) break;
        sleepSyncMs(40 * (attempt + 1));
      }
    }
    // Last resort: direct overwrite (still better than losing progress)
    try {
      fs.writeFileSync(filePath, payload, 'utf-8');
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      return;
    } catch {
      /* fall through */
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error('atomicWriteJson failed');
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore cleanup */
    }
    throw err;
  }
}

/** Read JSON file or return null on missing/corrupt. */
export function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error(
      `[persist] Failed to read ${path.basename(filePath)}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * If `newPath` is missing and `oldPath` exists, rename (or copy) for one-time migration.
 */
export function migrateLegacyFile(oldPath: string, newPath: string): boolean {
  try {
    if (fs.existsSync(newPath) || !fs.existsSync(oldPath)) return false;
    ensureDataDir();
    try {
      fs.renameSync(oldPath, newPath);
    } catch {
      fs.copyFileSync(oldPath, newPath);
      try {
        fs.unlinkSync(oldPath);
      } catch {
        /* keep legacy copy if unlink fails */
      }
    }
    console.log(
      `[persist] Migrated ${path.basename(oldPath)} → ${path.basename(newPath)}`
    );
    return true;
  } catch (err) {
    console.warn(
      `[persist] Migration ${path.basename(oldPath)} failed:`,
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

/** Safely delete a data file if present. */
export function deleteDataFile(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  } catch (err) {
    console.warn(
      `[persist] Could not delete ${path.basename(filePath)}:`,
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

/**
 * Clear all bot persistence files (config, wallets, paper, backtest, trading slots).
 * Caller must reload defaults into memory afterward.
 */
export function resetAllPersistedData(): {
  deleted: string[];
  dataDir: string;
} {
  ensureDataDir();
  const names = [
    PERSIST_FILES.config,
    PERSIST_FILES.legacyConfig,
    PERSIST_FILES.wallets,
    PERSIST_FILES.paperBalance,
    PERSIST_FILES.backtestHistory,
    PERSIST_FILES.legacyBacktest,
    PERSIST_FILES.optimizerLast,
    PERSIST_FILES.tradingWallets,
    PERSIST_FILES.dashboardState,
    PERSIST_FILES.tradeProfilesUser,
    PERSIST_FILES.profileTaPlaybooks,
    'profile-learning-saves.json',
    PERSIST_MARKER,
  ];
  const deleted: string[] = [];
  for (const name of names) {
    if (deleteDataFile(dataFile(name))) deleted.push(name);
  }
  console.log(
    `[persist] Reset to defaults — deleted ${deleted.length} file(s): ${deleted.join(', ') || 'none'}`
  );
  return { deleted, dataDir: getDataDir() };
}

function normalizeFsPath(p: string): string {
  const resolved = path.resolve(p);
  const unix = resolved.replace(/\\/g, '/');
  if (unix.length > 1 && unix.endsWith('/')) return unix.slice(0, -1);
  return unix;
}

/**
 * True when DATA_DIR is on a real mount point (Render Disk / Fly volume).
 * Local/dev (non-cloud): always true. Linux cloud: parse /proc/self/mountinfo.
 */
export function isDataDirVolumeMounted(dataDir = getDataDir()): boolean {
  if (!isCloudHost()) return true;
  if (process.platform !== 'linux') {
    return false;
  }
  const target = normalizeFsPath(dataDir);
  let mountinfo: string;
  try {
    mountinfo = fs.readFileSync('/proc/self/mountinfo', 'utf-8');
  } catch {
    return false;
  }
  const mounts: string[] = [];
  for (const line of mountinfo.split('\n')) {
    if (!line.trim()) continue;
    const sep = line.indexOf(' - ');
    const left = sep >= 0 ? line.slice(0, sep) : line;
    const parts = left.split(' ');
    if (parts.length < 5) continue;
    const mountPoint = parts[4]?.replace(/\\040/g, ' ');
    if (!mountPoint) continue;
    const mp = normalizeFsPath(mountPoint);
    if (mp === '/') continue;
    mounts.push(mp);
  }
  for (const mp of mounts) {
    if (target === mp) return true;
    if (target.startsWith(mp + '/')) return true;
  }
  return false;
}

interface PersistMarker {
  version: 1;
  commit: string | null;
  dataDir: string;
  updatedAt: number;
  volumeMounted: boolean;
}

function currentDeployId(): string | null {
  return (
    process.env.RENDER_GIT_COMMIT?.trim() ||
    process.env.FLY_IMAGE_REF?.trim() ||
    process.env.GIT_COMMIT?.trim() ||
    null
  );
}

export type SurvivedLastDeploy = 'yes' | 'no' | 'unknown';

let cachedSurvived: SurvivedLastDeploy | null = null;

/**
 * Read/update cross-deploy marker. Call once early on boot after ensureDataDir.
 * Returns whether DATA_DIR contents survived a prior deploy (marker from older commit).
 */
export function touchPersistMarker(): SurvivedLastDeploy {
  ensureDataDir();
  const markerPath = dataFile(PERSIST_MARKER);
  const commit = currentDeployId();
  const volumeMounted = isDataDirVolumeMounted();
  const prev = readJsonFile<PersistMarker>(markerPath);

  let survived: SurvivedLastDeploy = 'unknown';
  if (prev?.commit && commit && prev.commit !== commit) {
    survived = 'yes';
  } else if (isCloudHost() && !volumeMounted) {
    survived = prev?.commit ? 'unknown' : 'no';
  }

  const next: PersistMarker = {
    version: 1,
    commit: commit || prev?.commit || null,
    dataDir: getDataDir(),
    updatedAt: Date.now(),
    volumeMounted,
  };
  try {
    atomicWriteJson(markerPath, next);
  } catch (err) {
    console.warn(
      '[persist] Failed to write persist marker:',
      err instanceof Error ? err.message : err
    );
  }
  cachedSurvived = survived;
  return survived;
}

export function getSurvivedLastDeploy(): SurvivedLastDeploy {
  if (cachedSurvived) return cachedSurvived;
  return touchPersistMarker();
}

/**
 * Copy durable files from legacy Render path → current DATA_DIR when upgrading
 * to /var/data (or any empty new dir) while old src/data still has content.
 */
export function migrateLegacyRenderDataDir(): {
  migrated: boolean;
  from: string;
  to: string;
  copied: string[];
} {
  const to = getDataDir();
  const from = LEGACY_RENDER_DATA_DIR;
  const copied: string[] = [];
  const result = { migrated: false, from, to, copied };

  try {
    if (normalizeFsPath(to) === normalizeFsPath(from)) return result;
    if (!fs.existsSync(from)) return result;
    const legacyConfig = path.join(from, PERSIST_FILES.config);
    if (!fs.existsSync(legacyConfig)) return result;

    ensureDataDir();
    const destConfig = dataFile(PERSIST_FILES.config);
    if (fs.existsSync(destConfig)) return result;

    const entries = fs.readdirSync(from, { withFileTypes: true });
    for (const ent of entries) {
      const src = path.join(from, ent.name);
      const dest = path.join(to, ent.name);
      if (fs.existsSync(dest)) continue;
      try {
        if (ent.isDirectory()) {
          fs.cpSync(src, dest, { recursive: true });
        } else {
          fs.copyFileSync(src, dest);
        }
        copied.push(ent.name);
      } catch (err) {
        console.warn(
          `[persist] Skip migrate ${ent.name}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
    if (copied.length) {
      result.migrated = true;
      console.log(
        `[persist] Migrated ${copied.length} item(s) from ${from} → ${to}: ${copied.join(', ')}`
      );
    }
  } catch (err) {
    console.warn(
      '[persist] Legacy Render data migrate failed:',
      err instanceof Error ? err.message : err
    );
  }
  return result;
}

export interface PersistenceStatus {
  dataDir: string;
  writable: boolean;
  onRender: boolean;
  onFly: boolean;
  settingsExists: boolean;
  walletsExists: boolean;
  paperBalanceExists: boolean;
  backtestHistoryExists: boolean;
  tradingWalletsExists: boolean;
  /** Dedicated micro-bot user knobs file */
  tradeProfilesUserExists: boolean;
  /** At least one profile-learning episode file */
  profileLearningExists: boolean;
  /** Last config.json updatedAt (ms), if present */
  lastSettingsSavedAt: number | null;
  settingsPath: string;
  walletsPath: string;
  paperBalancePath: string;
  backtestHistoryPath: string;
  tradeProfilesUserPath: string;
  /** DATA_DIR is a real mount (Render Disk / Fly volume), or local non-cloud */
  volumeMounted: boolean;
  /** Marker from a previous deploy commit was still present */
  survivedLastDeploy: SurvivedLastDeploy;
  /** True when cloud host and DATA_DIR is not a mounted volume */
  ephemeralLikely: boolean;
  /**
   * True when saves should survive deploys:
   * writable, and (local OR volume mounted).
   */
  durableLikely: boolean;
  warning: string | null;
}

export function getPersistenceStatus(): PersistenceStatus {
  const dataDir = getDataDir();
  const settingsPath = dataFile(PERSIST_FILES.config);
  const walletsPath = dataFile(PERSIST_FILES.wallets);
  const paperBalancePath = dataFile(PERSIST_FILES.paperBalance);
  const backtestHistoryPath = dataFile(PERSIST_FILES.backtestHistory);
  const tradingWalletsPath = dataFile(PERSIST_FILES.tradingWallets);
  const tradeProfilesUserPath = dataFile(PERSIST_FILES.tradeProfilesUser);
  const onRender = isRunningOnRender();
  const onFly = isRunningOnFly();
  const onCloud = onRender || onFly;

  let writable = false;
  try {
    ensureDataDir();
    const probe = dataFile('.write-probe');
    fs.writeFileSync(probe, String(Date.now()), 'utf-8');
    fs.unlinkSync(probe);
    writable = true;
  } catch {
    writable = false;
  }

  const settingsExists =
    fs.existsSync(settingsPath) ||
    fs.existsSync(dataFile(PERSIST_FILES.legacyConfig));
  const walletsExists = fs.existsSync(walletsPath);
  const paperBalanceExists = fs.existsSync(paperBalancePath);
  const backtestHistoryExists =
    fs.existsSync(backtestHistoryPath) ||
    fs.existsSync(dataFile(PERSIST_FILES.legacyBacktest));
  const tradingWalletsExists = fs.existsSync(tradingWalletsPath);
  const tradeProfilesUserExists = fs.existsSync(tradeProfilesUserPath);

  let profileLearningExists = false;
  try {
    const learnDir = dataFile('profile-learning');
    if (fs.existsSync(learnDir)) {
      profileLearningExists = fs
        .readdirSync(learnDir)
        .some((f) => f.endsWith('.json'));
    }
  } catch {
    profileLearningExists = false;
  }

  let lastSettingsSavedAt: number | null = null;
  if (settingsExists) {
    try {
      const parsed = readJsonFile<{ updatedAt?: number }>(settingsPath);
      if (parsed?.updatedAt != null && Number.isFinite(Number(parsed.updatedAt))) {
        lastSettingsSavedAt = Number(parsed.updatedAt);
      } else {
        lastSettingsSavedAt = fs.statSync(settingsPath).mtimeMs;
      }
    } catch {
      lastSettingsSavedAt = null;
    }
  }

  const volumeMounted = isDataDirVolumeMounted(dataDir);
  const survivedLastDeploy =
    cachedSurvived ??
    (() => {
      const prev = readJsonFile<PersistMarker>(dataFile(PERSIST_MARKER));
      const commit = currentDeployId();
      if (prev?.commit && commit && prev.commit !== commit) return 'yes' as const;
      if (onCloud && !volumeMounted) return 'no' as const;
      return 'unknown' as const;
    })();

  const ephemeralLikely = onCloud && !volumeMounted;
  const durableLikely = writable && (!onCloud || volumeMounted);

  let warning: string | null = null;
  if (!writable) {
    warning = `Data directory is not writable (${dataDir}). Settings and wallets cannot be saved.`;
  } else if (onFly && !volumeMounted) {
    warning =
      'Fly.io: DATA_DIR is not a mounted volume. Mount bot_data at /data (fly.toml) and set DATA_DIR=/data. ' +
      'Without a volume, email, config, micro-bot knobs, and learning wipe on every deploy. ' +
      'Create with: fly volumes create bot_data --region <region> --size 1';
  } else if (onRender && !volumeMounted) {
    warning =
      'Render: DATA_DIR is not a mounted Disk — saves look fine until the next deploy, then wipe. ' +
      `Attach a Starter+ Disk with mount path exactly matching DATA_DIR (prefer ${PREFERRED_RENDER_DATA_DIR}). ` +
      'Dashboard → Disks → Add disk. Env DATA_DIR alone does not create a volume.';
  }

  return {
    dataDir,
    writable,
    onRender,
    onFly,
    settingsExists,
    walletsExists,
    paperBalanceExists,
    backtestHistoryExists,
    tradingWalletsExists,
    tradeProfilesUserExists,
    profileLearningExists,
    lastSettingsSavedAt,
    settingsPath,
    walletsPath,
    paperBalancePath,
    backtestHistoryPath,
    tradeProfilesUserPath,
    volumeMounted,
    survivedLastDeploy,
    ephemeralLikely,
    durableLikely,
    warning,
  };
}

/** Log persistence status once at boot. */
export function logPersistenceStatus(): void {
  const s = getPersistenceStatus();
  console.log(`[persist] data dir: ${s.dataDir}`);
  console.log(
    `[persist] writable=${s.writable} durableLikely=${s.durableLikely} ` +
      `volumeMounted=${s.volumeMounted} survivedLastDeploy=${s.survivedLastDeploy} ` +
      `onRender=${s.onRender} onFly=${s.onFly} ` +
      `config=${s.settingsExists ? 'yes' : 'MISSING'} ` +
      `profilesUser=${s.tradeProfilesUserExists ? 'yes' : 'MISSING'} ` +
      `wallets=${s.walletsExists ? 'yes' : 'MISSING'} ` +
      `paper=${s.paperBalanceExists ? 'yes' : 'MISSING'} ` +
      `learning=${s.profileLearningExists ? 'yes' : 'none'} ` +
      `backtest=${s.backtestHistoryExists ? 'yes' : 'MISSING'}`
  );
  if (s.warning) {
    console.warn(`[persist] ⚠ ${s.warning}`);
  }
  if (isCloudHost() && !s.volumeMounted) {
    console.error(
      `[persist] AT RISK: DATA_DIR is not a mounted volume — all dashboard saves will wipe on next deploy. ` +
        `Attach a Render Disk at DATA_DIR (${PREFERRED_RENDER_DATA_DIR}) or Fly volume at /data.`
    );
  } else if (s.durableLikely) {
    console.log(
      '[persist] Durable data dir OK — saved settings/learning should survive code deploys'
    );
  }
}
