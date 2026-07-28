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
        } catch (renameErr) {
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
  /** True when cloud host is detected and persisted files are missing — no volume/disk */
  ephemeralLikely: boolean;
  /**
   * True when the data dir looks durable enough that saves should survive deploys:
   * writable, and not flagged ephemeralLikely.
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

  const ephemeralLikely =
    (onRender || onFly) && (!settingsExists || !walletsExists);
  const durableLikely = writable && !ephemeralLikely;

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
    tradeProfilesUserExists,
    profileLearningExists,
    lastSettingsSavedAt,
    settingsPath,
    walletsPath,
    paperBalancePath,
    backtestHistoryPath,
    tradeProfilesUserPath,
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
  } else if (s.durableLikely) {
    console.log(
      '[persist] Durable data dir OK — saved settings/learning should survive code deploys'
    );
  }
}
