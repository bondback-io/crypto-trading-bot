/**
 * Shared persistent data directory for config, wallets, paper state, and backtests.
 *
 * Canonical files (under DATA_DIR / ./data):
 *   config.json, wallets.json, paperBalance.json, backtestHistory.json
 *   (+ trading-wallets.json for live slot metadata)
 *
 * On Render Free the container filesystem is ephemeral — attach a disk or set DATA_DIR.
 */

import fs from 'fs';
import path from 'path';

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
  tradingWallets: 'trading-wallets.json',
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

/**
 * Atomic JSON write: write temp file then rename (safe across crashes).
 * On Windows, replaces destination if rename-over-existing fails.
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
    try {
      fs.renameSync(tmp, filePath);
    } catch {
      // Windows: rename onto existing file often fails
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      fs.renameSync(tmp, filePath);
    }
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
    PERSIST_FILES.tradingWallets,
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
  settingsPath: string;
  walletsPath: string;
  paperBalancePath: string;
  backtestHistoryPath: string;
  /** True when cloud host is detected and persisted files are missing — no volume/disk */
  ephemeralLikely: boolean;
  warning: string | null;
}

export function getPersistenceStatus(): PersistenceStatus {
  const dataDir = getDataDir();
  const settingsPath = dataFile(PERSIST_FILES.config);
  const walletsPath = dataFile(PERSIST_FILES.wallets);
  const paperBalancePath = dataFile(PERSIST_FILES.paperBalance);
  const backtestHistoryPath = dataFile(PERSIST_FILES.backtestHistory);
  const tradingWalletsPath = dataFile(PERSIST_FILES.tradingWallets);
  const onRender = isRunningOnRender();
  const onFly = isRunningOnFly();

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

  const ephemeralLikely =
    (onRender || onFly) && (!settingsExists || !walletsExists);

  let warning: string | null = null;
  if (!writable) {
    warning = `Data directory is not writable (${dataDir}). Settings and wallets cannot be saved.`;
  } else if (onFly && (!settingsExists || !walletsExists)) {
    warning =
      'Fly.io: mount a persistent volume at /data (fly.toml mounts.bot_data) and set DATA_DIR=/data. ' +
      'Without a volume, settings and wallets reset on every deploy. ' +
      'Create with: fly volumes create bot_data --region <region> --size 1';
  } else if (onRender && (!settingsExists || !walletsExists)) {
    warning =
      'Render Free has no persistent disk — the filesystem resets on every deploy and after idle spin-down. ' +
      'Upgrade to Starter (or higher), add a 1GB disk mounted at /opt/render/project/src/data, then re-import wallets and save settings. ' +
      'This is not a free-tier API limit; it is ephemeral storage.';
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
    settingsPath,
    walletsPath,
    paperBalancePath,
    backtestHistoryPath,
    ephemeralLikely,
    warning,
  };
}

/** Log persistence status once at boot. */
export function logPersistenceStatus(): void {
  const s = getPersistenceStatus();
  console.log(`[persist] data dir: ${s.dataDir}`);
  console.log(
    `[persist] writable=${s.writable} onRender=${s.onRender} onFly=${s.onFly} ` +
      `config=${s.settingsExists ? 'yes' : 'MISSING'} ` +
      `wallets=${s.walletsExists ? 'yes' : 'MISSING'} ` +
      `paper=${s.paperBalanceExists ? 'yes' : 'MISSING'} ` +
      `backtest=${s.backtestHistoryExists ? 'yes' : 'MISSING'}`
  );
  if (s.warning) {
    console.warn(`[persist] ⚠ ${s.warning}`);
  }
}
