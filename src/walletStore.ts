/**
 * Persistent smart wallet storage — loads/saves to data/wallets.json.
 *
 * On Render Free this file is wiped on every deploy unless a persistent disk
 * is mounted (Starter+). See dataDir.ts / README.
 */

import {
  atomicWriteJson,
  dataFile,
  ensureDataDir,
  PERSIST_FILES,
  readJsonFile,
} from './dataDir';

const WALLETS_FILE = dataFile(PERSIST_FILES.wallets);

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
  /** Composite wallet quality 0–100 */
  qualityScore?: number;
  /** elite | good | medium | low | inactive | unknown */
  qualityStatus?: string;
  /** Copy size / convergence weight (1 = normal) */
  copyWeight?: number;
  /** When qualityScore was last computed */
  qualityScoredAt?: number;
  /** Average hold time in seconds (GMGN / discovery) */
  avgHoldTimeSec?: number;
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

/** Default smart wallets — empty so fresh installs / reset start with none */
export const defaultSmartWallets: SmartWallet[] = [];

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

  const parsed = readJsonFile<WalletRecord[]>(WALLETS_FILE);
  if (!parsed || !Array.isArray(parsed) || parsed.length === 0) {
    const initial = defaultSmartWallets.map((w) =>
      normalizeWalletRecord({ ...w, addedAt: Date.now() })
    );
    saveWalletsToDisk(initial);
    console.log(`[wallets] Created ${WALLETS_FILE} with defaults`);
    return initial;
  }

  console.log(`[wallets] Loaded ${parsed.length} wallet(s) from disk`);
  return parsed.map(normalizeWalletRecord);
}

/** Persist wallets to disk (atomic) */
export function saveWalletsToDisk(wallets: WalletRecord[]): void {
  ensureDataDir();
  const normalized = wallets.map(normalizeWalletRecord);
  atomicWriteJson(WALLETS_FILE, normalized);
}

/** Validate a Solana address string */
export function isValidSolanaAddress(address: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}
