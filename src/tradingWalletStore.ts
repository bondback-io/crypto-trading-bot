/**
 * Live trading wallet registry (main + burner + custom).
 * Persists metadata only — private keys stay in env vars, never on disk or in API responses.
 */

import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'trading-wallets.json');

/** Only these env name patterns may be used as key sources */
export const ALLOWED_KEY_ENV =
  /^(PRIVATE_KEY|TRADING_WALLET_[A-Z0-9_]+)$/;

export type TradingWalletRole = 'main' | 'burner' | 'custom';

export interface TradingWalletSlot {
  id: string;
  name: string;
  role: TradingWalletRole;
  /** Env var that holds the base58 private key — never the key itself */
  envVar: string;
  enabled: boolean;
  createdAt: number;
}

export interface TradingWalletsFile {
  activeId: string | null;
  wallets: TradingWalletSlot[];
}

const DEFAULT_WALLETS: TradingWalletSlot[] = [
  {
    id: 'main',
    name: 'Main',
    role: 'main',
    envVar: 'TRADING_WALLET_1',
    enabled: true,
    createdAt: 0,
  },
  {
    id: 'burner',
    name: 'Burner',
    role: 'burner',
    envVar: 'TRADING_WALLET_2',
    enabled: true,
    createdAt: 0,
  },
];

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function isAllowedKeyEnvVar(name: string): boolean {
  return ALLOWED_KEY_ENV.test(name.trim().toUpperCase());
}

export function normalizeEnvVarName(name: string): string {
  return name.trim().toUpperCase();
}

function migrateLegacyPrivateKeyHint(wallets: TradingWalletSlot[]): TradingWalletSlot[] {
  // If TRADING_WALLET_1 empty but PRIVATE_KEY set, main still points at TRADING_WALLET_1
  // Connection layer falls back to PRIVATE_KEY for main role.
  return wallets;
}

export function loadTradingWalletsFile(): TradingWalletsFile {
  ensureDir();

  if (!fs.existsSync(FILE)) {
    const initial: TradingWalletsFile = {
      activeId: 'main',
      wallets: DEFAULT_WALLETS.map((w) => ({
        ...w,
        createdAt: Date.now(),
      })),
    };
    saveTradingWalletsFile(initial);
    return initial;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf-8')) as TradingWalletsFile;
    if (!raw || !Array.isArray(raw.wallets) || raw.wallets.length === 0) {
      throw new Error('invalid trading-wallets.json');
    }

    const wallets = migrateLegacyPrivateKeyHint(
      raw.wallets.map((w) => ({
        ...w,
        envVar: normalizeEnvVarName(w.envVar),
        enabled: w.enabled !== false,
      }))
    );

    const activeId =
      raw.activeId && wallets.some((w) => w.id === raw.activeId)
        ? raw.activeId
        : wallets[0].id;

    return { activeId, wallets };
  } catch (err) {
    console.error('[trading-wallets] Failed to load, using defaults:', err);
    return {
      activeId: 'main',
      wallets: DEFAULT_WALLETS.map((w) => ({
        ...w,
        createdAt: Date.now(),
      })),
    };
  }
}

export function saveTradingWalletsFile(data: TradingWalletsFile): void {
  ensureDir();
  // Strip any accidental secret fields before write
  const safe: TradingWalletsFile = {
    activeId: data.activeId,
    wallets: data.wallets.map((w) => ({
      id: w.id,
      name: w.name,
      role: w.role,
      envVar: normalizeEnvVarName(w.envVar),
      enabled: w.enabled !== false,
      createdAt: w.createdAt ?? Date.now(),
    })),
  };
  fs.writeFileSync(FILE, JSON.stringify(safe, null, 2), 'utf-8');
}

export function makeTradingWalletId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
  return `${base || 'wallet'}-${Date.now().toString(36)}`;
}
