/**
 * Per-influencer wallet learning — nudge copyWeight / auto-disable after poor expectancy.
 * Bounded + reversible; never touches hard SL / anti-rug.
 */

import {
  config,
  persistWallets,
  type SmartWallet,
} from './config';
import {
  applyInfluencerWalletDefaults,
  hasInfluencerFamilyTag,
  isInfluencerMirrorEnabled,
} from './influencerMirror';
import { dataFile, ensureDataDir, atomicWriteJson, readJsonFile } from './dataDir';

const STATE_FILE = dataFile('influencer-mirror-learning.json');

const MIN_TRADES_BEFORE_NUDGE = 5;
const AUTO_DISABLE_AFTER = 8;
const POOR_EXPECTANCY_PCT = -2.5;
const COPY_WEIGHT_FLOOR = 0.35;
const COPY_WEIGHT_CEIL = 1.5;

export interface InfluencerWalletLearningRow {
  walletAddress: string;
  walletName?: string;
  trades: number;
  wins: number;
  losses: number;
  sumPnlPct: number;
  lastPnlPct?: number;
  lastAt?: number;
  autoDisabledAt?: number;
  notes?: string;
}

interface LearningState {
  byWallet: Record<string, InfluencerWalletLearningRow>;
  updatedAt: number;
}

function loadState(): LearningState {
  ensureDataDir();
  const parsed = readJsonFile<LearningState>(STATE_FILE);
  if (parsed && parsed.byWallet && typeof parsed.byWallet === 'object') {
    return parsed;
  }
  return { byWallet: {}, updatedAt: Date.now() };
}

function saveState(state: LearningState): void {
  ensureDataDir();
  state.updatedAt = Date.now();
  atomicWriteJson(STATE_FILE, state);
}

function findWallet(address: string): SmartWallet | undefined {
  return config.smartWallets.find((w) => w.address === address);
}

/**
 * Record a closed mirrored trade outcome and optionally nudge copyWeight /
 * auto-disable copyEnabled after sustained poor expectancy.
 */
export function recordInfluencerMirrorOutcome(input: {
  mirrorWalletId?: string | null;
  mirrorWalletName?: string | null;
  pnlPct: number;
  exitReason?: string;
}): InfluencerWalletLearningRow | null {
  if (!isInfluencerMirrorEnabled()) return null;
  const addr = String(input.mirrorWalletId || '').trim();
  if (!addr) return null;
  const pnl = Number(input.pnlPct);
  if (!Number.isFinite(pnl)) return null;

  const state = loadState();
  const row: InfluencerWalletLearningRow = state.byWallet[addr] || {
    walletAddress: addr,
    walletName: input.mirrorWalletName || undefined,
    trades: 0,
    wins: 0,
    losses: 0,
    sumPnlPct: 0,
  };
  row.walletName = input.mirrorWalletName || row.walletName;
  row.trades += 1;
  row.sumPnlPct += pnl;
  row.lastPnlPct = pnl;
  row.lastAt = Date.now();
  if (pnl > 0) row.wins += 1;
  else if (pnl < 0) row.losses += 1;
  state.byWallet[addr] = row;
  saveState(state);

  try {
    applyLearningNudge(row);
  } catch (err) {
    console.warn(
      '[influencer-mirror-learn] nudge failed:',
      err instanceof Error ? err.message : err
    );
  }
  return row;
}

function applyLearningNudge(row: InfluencerWalletLearningRow): void {
  const w = findWallet(row.walletAddress);
  if (!w || !hasInfluencerFamilyTag(w)) return;

  const expectancy =
    row.trades > 0 ? row.sumPnlPct / row.trades : 0;

  // Soft copyWeight nudge after enough samples
  if (row.trades >= MIN_TRADES_BEFORE_NUDGE) {
    let weight = Number(w.copyWeight);
    if (!Number.isFinite(weight) || weight <= 0) weight = 1;
    if (expectancy <= POOR_EXPECTANCY_PCT) {
      weight = Math.max(COPY_WEIGHT_FLOOR, weight * 0.85);
    } else if (expectancy >= 3) {
      weight = Math.min(COPY_WEIGHT_CEIL, weight * 1.05);
    }
    w.copyWeight = Math.round(weight * 100) / 100;
  }

  // Auto-disable copy after sustained poor expectancy (reversible)
  if (
    row.trades >= AUTO_DISABLE_AFTER &&
    expectancy <= POOR_EXPECTANCY_PCT &&
    w.copyEnabled !== false
  ) {
    w.copyEnabled = false;
    row.autoDisabledAt = Date.now();
    row.notes = `auto-disabled after ${row.trades} trades · expectancy ${expectancy.toFixed(1)}%`;
    console.log(
      `[influencer-mirror-learn] Auto-disabled copy for ${w.displayName || w.name} ` +
        `(${row.walletAddress.slice(0, 8)}…) · expectancy ${expectancy.toFixed(1)}%`
    );
    const state = loadState();
    state.byWallet[row.walletAddress] = row;
    saveState(state);
  }

  applyInfluencerWalletDefaults(w);
  persistWallets();
}

export function getInfluencerMirrorLearningSummary(limit = 40): {
  wallets: Array<
    InfluencerWalletLearningRow & { expectancyPct: number; copyEnabled?: boolean }
  >;
} {
  const state = loadState();
  const wallets = Object.values(state.byWallet)
    .map((r) => {
      const w = findWallet(r.walletAddress);
      return {
        ...r,
        expectancyPct: r.trades > 0 ? r.sumPnlPct / r.trades : 0,
        copyEnabled: w?.copyEnabled,
      };
    })
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
    .slice(0, limit);
  return { wallets };
}
