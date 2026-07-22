/**
 * Shared persistent data directory for wallets, settings, and backtest history.
 *
 * On Render Free the container filesystem is ephemeral — wiped on every deploy
 * and after idle spin-down. Attach a persistent disk (Starter+) at
 * /opt/render/project/src/data (see render.yaml) or set DATA_DIR.
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

/** Absolute path to the bot data directory (wallets, settings, history). */
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

export interface PersistenceStatus {
  dataDir: string;
  writable: boolean;
  onRender: boolean;
  onFly: boolean;
  settingsExists: boolean;
  walletsExists: boolean;
  tradingWalletsExists: boolean;
  settingsPath: string;
  walletsPath: string;
  /** True when cloud host is detected and persisted files are missing — no volume/disk */
  ephemeralLikely: boolean;
  warning: string | null;
}

export function getPersistenceStatus(): PersistenceStatus {
  const dataDir = getDataDir();
  const settingsPath = dataFile('bot-settings.json');
  const walletsPath = dataFile('wallets.json');
  const tradingWalletsPath = dataFile('trading-wallets.json');
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

  const settingsExists = fs.existsSync(settingsPath);
  const walletsExists = fs.existsSync(walletsPath);
  const tradingWalletsExists = fs.existsSync(tradingWalletsPath);

  const ephemeralLikely =
    (onRender || onFly) && (!settingsExists || !walletsExists);

  let warning: string | null = null;
  if (!writable) {
    warning =
      `Data directory is not writable (${dataDir}). Settings and wallets cannot be saved.`;
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
    tradingWalletsExists,
    settingsPath,
    walletsPath,
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
      `settings=${s.settingsExists ? 'yes' : 'MISSING'} ` +
      `wallets=${s.walletsExists ? 'yes' : 'MISSING'}`
  );
  if (s.warning) {
    console.warn(`[persist] ⚠ ${s.warning}`);
  }
}
