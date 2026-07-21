/**
 * Persistent smart wallet storage — loads/saves to data/wallets.json.
 *
 * On Render Free this file is wiped on every deploy unless a persistent disk
 * is mounted (Starter+). See dataDir.ts / README.
 */

import fs from 'fs';
import { dataFile, ensureDataDir } from './dataDir';

const WALLETS_FILE = dataFile('wallets.json');

export type WalletCategory = 'smart' | 'scalper' | 'sniper' | 'kol';

export interface SmartWallet {
  name: string;
  address: string;
  enabled: boolean;
  /** Unix ms of most recent trade (alias: lastActive) */
  lastTradedAt?: number;
  /** Preferred metadata field — same as lastTradedAt */
  lastActive?: number;
  /** Win rate % from GMGN / activity scan */
  winRate?: number;
  /** Free-form notes */
  notes?: string;
  /** Approximate tx count in last 30 days */
  tradesLast30d?: number;
  /** Trades in last 7 days */
  tradesLast7d?: number;
  /** Pump.fun related trade count if known */
  pumpFunTradeCount?: number;
  /** Tags e.g. scalper, pump.fun, kol */
  tags?: string[];
  /** Discovery category for dashboard grouping */
  category?: WalletCategory;
  /** Where this wallet came from */
  source?: 'gmgn' | 'birdeye' | 'dexscreener' | 'curated' | 'manual' | 'bulk';
  /** When first discovered / imported */
  discoveredAt?: number;
  /** When activity was last checked */
  lastCheckedAt?: number;
}

/** Infer category from tags / trade frequency */
export function inferWalletCategory(
  tags?: string[],
  tradesLast7d?: number
): WalletCategory {
  const t = (tags ?? []).map((x) => x.toLowerCase());
  if (t.includes('scalper') || (tradesLast7d != null && tradesLast7d >= 20)) {
    return 'scalper';
  }
  if (t.includes('sniper')) return 'sniper';
  if (t.includes('kol')) return 'kol';
  return 'smart';
}

export interface WalletRecord extends SmartWallet {
  addedAt?: number;
}

/** Default smart wallets — used when wallets.json is first created */
export const defaultSmartWallets: SmartWallet[] = [
  {
    name: 'Cented',
    address: 'CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o',
    enabled: true,
    tags: ['kol', 'pump.fun'],
    notes: 'Default tracked KOL',
  },
  {
    name: 'Theo',
    address: 'Bi4rd5FH5bYEN8scZ7wevxNZyNmKHdaBcvewdPFxYdLt',
    enabled: true,
    tags: ['kol', 'sniper'],
  },
  {
    name: 'Decu',
    address: '4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9',
    enabled: true,
    tags: ['kol'],
  },
];

/** Normalize lastActive ↔ lastTradedAt for persistence */
export function normalizeWalletRecord(w: WalletRecord): WalletRecord {
  const lastActive = w.lastActive ?? w.lastTradedAt;
  return {
    ...w,
    lastActive,
    lastTradedAt: w.lastTradedAt ?? lastActive,
  };
}

/** Load wallets from disk, falling back to defaults */
export function loadWalletsFromDisk(): WalletRecord[] {
  ensureDataDir();

  if (!fs.existsSync(WALLETS_FILE)) {
    const initial = defaultSmartWallets.map((w) =>
      normalizeWalletRecord({ ...w, addedAt: Date.now() })
    );
    saveWalletsToDisk(initial);
    console.log(`[wallets] Created ${WALLETS_FILE} with defaults`);
    return initial;
  }

  try {
    const raw = fs.readFileSync(WALLETS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as WalletRecord[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('Invalid wallets file');
    }
    console.log(`[wallets] Loaded ${parsed.length} wallet(s) from disk`);
    return parsed.map(normalizeWalletRecord);
  } catch (err) {
    console.error('[wallets] Failed to load wallets.json, using defaults:', err);
    return defaultSmartWallets.map((w) =>
      normalizeWalletRecord({ ...w, addedAt: Date.now() })
    );
  }
}

/** Persist wallets to disk */
export function saveWalletsToDisk(wallets: WalletRecord[]): void {
  ensureDataDir();
  const normalized = wallets.map(normalizeWalletRecord);
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(normalized, null, 2), 'utf-8');
}

/** Validate a Solana address string */
export function isValidSolanaAddress(address: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}
