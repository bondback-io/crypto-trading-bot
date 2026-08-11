/**
 * Live wallet history — system-recorded live trades + on-chain balances.
 * Live mode only — never mixes paper / liveSimulation ledger rows.
 * Persists closed history per wallet pubkey for re-import after disconnect.
 */

import {
  atomicWriteJson,
  dataFile,
  ensureDataDir,
  PERSIST_FILES,
  readJsonFile,
} from './dataDir';
import {
  getKeypair,
  getLiveBalanceSol,
  peekTradingWalletPublicKey,
} from './connection';
import {
  getActiveTradingWallet,
  usesRealFunds,
  type TradingMode,
} from './config';
import type { Position } from './paperTrader';

export const LIVE_WALLET_IMPORT_MAX_TRADES = 1000;
/** Default min SOL on the live wallet before Live trading may fire */
export const DEFAULT_LIVE_MIN_WALLET_SOL = 0.05;

export interface LiveWalletBalances {
  availableSol: number;
  equitySol: number;
  positionsValueSol: number;
  at: number;
}

export interface LiveWalletBucket {
  closed: Position[];
  lastBalances?: LiveWalletBalances;
  walletName?: string;
  walletId?: string;
  updatedAt: number;
}

/** v2 per-wallet store with connected flag */
export interface LiveWalletHistoryFile {
  version: 2;
  updatedAt: number;
  /** When true, Live Overview shows imported wallet data */
  connected: boolean;
  connectedPubkey: string;
  byWallet: Record<string, LiveWalletBucket>;
  /** Legacy single-wallet fields (migrated on load) */
  walletPubkey?: string;
  closed?: Position[];
}

const FILE = () => dataFile(PERSIST_FILES.liveWalletHistory);

function emptyHistory(): LiveWalletHistoryFile {
  return {
    version: 2,
    updatedAt: 0,
    connected: false,
    connectedPubkey: '',
    byWallet: {},
  };
}

function migrateRaw(raw: LiveWalletHistoryFile | null): LiveWalletHistoryFile {
  if (!raw || typeof raw !== 'object') return emptyHistory();
  if (Number(raw.version) >= 2 && raw.byWallet && typeof raw.byWallet === 'object') {
    return {
      version: 2,
      updatedAt: Number(raw.updatedAt) || 0,
      connected: raw.connected === true,
      connectedPubkey: String(raw.connectedPubkey || ''),
      byWallet: raw.byWallet,
    };
  }
  // v1 → v2: single walletPubkey + closed
  const pubkey = String(raw.walletPubkey || '');
  const closed = Array.isArray(raw.closed) ? raw.closed : [];
  const byWallet: Record<string, LiveWalletBucket> = {};
  if (pubkey) {
    byWallet[pubkey] = {
      closed: closed.slice(0, LIVE_WALLET_IMPORT_MAX_TRADES),
      updatedAt: Number(raw.updatedAt) || Date.now(),
    };
  }
  return {
    version: 2,
    updatedAt: Number(raw.updatedAt) || 0,
    connected: false,
    connectedPubkey: '',
    byWallet,
  };
}

export function loadLiveWalletHistory(): LiveWalletHistoryFile {
  try {
    ensureDataDir();
    const raw = readJsonFile<LiveWalletHistoryFile>(FILE());
    return migrateRaw(raw);
  } catch {
    return emptyHistory();
  }
}

export function saveLiveWalletHistory(file: LiveWalletHistoryFile): void {
  ensureDataDir();
  file.version = 2;
  file.updatedAt = Date.now();
  for (const key of Object.keys(file.byWallet || {})) {
    const b = file.byWallet[key];
    if (b) b.closed = (b.closed || []).slice(0, LIVE_WALLET_IMPORT_MAX_TRADES);
  }
  atomicWriteJson(FILE(), file);
}

export function clearLiveWalletHistory(): void {
  saveLiveWalletHistory(emptyHistory());
}

export function isLiveWalletConnected(): boolean {
  const h = loadLiveWalletHistory();
  return h.connected === true && Boolean(h.connectedPubkey);
}

export function getConnectedLiveWalletMeta(): {
  connected: boolean;
  publicKey: string | null;
  walletName: string | null;
  walletId: string | null;
  lastBalances: LiveWalletBalances | null;
} {
  const h = loadLiveWalletHistory();
  if (!h.connected || !h.connectedPubkey) {
    return {
      connected: false,
      publicKey: null,
      walletName: null,
      walletId: null,
      lastBalances: null,
    };
  }
  const bucket = h.byWallet[h.connectedPubkey];
  return {
    connected: true,
    publicKey: h.connectedPubkey,
    walletName: bucket?.walletName || null,
    walletId: bucket?.walletId || null,
    lastBalances: bucket?.lastBalances || null,
  };
}

/** Persist closed history for a pubkey without changing connected flag. */
export function saveWalletClosedHistory(
  pubkey: string,
  closed: Position[],
  meta?: { walletName?: string; walletId?: string; balances?: LiveWalletBalances }
): void {
  const h = loadLiveWalletHistory();
  const prev = h.byWallet[pubkey] || {
    closed: [],
    updatedAt: 0,
  };
  const merged = mergeClosedById(prev.closed || [], closed);
  h.byWallet[pubkey] = {
    closed: merged.slice(0, LIVE_WALLET_IMPORT_MAX_TRADES),
    lastBalances: meta?.balances ?? prev.lastBalances,
    walletName: meta?.walletName ?? prev.walletName,
    walletId: meta?.walletId ?? prev.walletId,
    updatedAt: Date.now(),
  };
  saveLiveWalletHistory(h);
}

function mergeClosedById(a: Position[], b: Position[]): Position[] {
  const map = new Map<string, Position>();
  for (const p of [...a, ...b]) {
    if (!p?.id) continue;
    const prev = map.get(p.id);
    if (!prev || (Number(p.closedAt) || 0) >= (Number(prev.closedAt) || 0)) {
      map.set(p.id, p);
    }
  }
  return Array.from(map.values()).sort(
    (x, y) => (Number(y.closedAt) || 0) - (Number(x.closedAt) || 0)
  );
}

/**
 * Disconnect: clear session overlay is caller's job; keep disk history,
 * set connected=false so Live Overview zeros until re-import.
 */
export function disconnectLiveWallet(): {
  ok: true;
  publicKey: string | null;
} {
  const h = loadLiveWalletHistory();
  const prev = h.connectedPubkey || null;
  h.connected = false;
  h.connectedPubkey = '';
  saveLiveWalletHistory(h);
  return { ok: true, publicKey: prev };
}

export interface LiveTradingReadyResult {
  ok: boolean;
  reason: string;
  walletId: string | null;
  walletName: string | null;
  publicKey: string | null;
  hasKey: boolean;
  balanceSol: number | null;
  minSol: number;
}

export function getLiveMinWalletSol(): number {
  try {
    const { config } = require('./config') as typeof import('./config');
    const n = Number(
      (config as { live?: { minWalletSol?: number } }).live?.minWalletSol
    );
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* */
  }
  return DEFAULT_LIVE_MIN_WALLET_SOL;
}

let cachedLiveReady: LiveTradingReadyResult | null = null;
let cachedLiveReadyAt = 0;
const LIVE_READY_CACHE_MS = 8_000;

/** Last Live gate evaluation (updated by assertLiveTradingReady / status). */
export function getCachedLiveTradingReady(): LiveTradingReadyResult | null {
  return cachedLiveReady;
}

async function finishReady(
  result: LiveTradingReadyResult
): Promise<LiveTradingReadyResult> {
  cachedLiveReady = result;
  cachedLiveReadyAt = Date.now();
  return result;
}

/**
 * Live mode hard gate: real keypair loaded + min SOL balance.
 * Paper / Live Sim always pass.
 */
export async function assertLiveTradingReady(
  mode?: TradingMode
): Promise<LiveTradingReadyResult> {
  const { config } = require('./config') as typeof import('./config');
  const m = mode ?? config.mode;
  const minSol = getLiveMinWalletSol();
  if (m !== 'live') {
    return finishReady({
      ok: true,
      reason: 'not live',
      walletId: null,
      walletName: null,
      publicKey: null,
      hasKey: false,
      balanceSol: null,
      minSol,
    });
  }
  // Slim status polls: reuse recent balance gate for ~8s (one RPC, not two).
  if (
    cachedLiveReady &&
    Date.now() - cachedLiveReadyAt < LIVE_READY_CACHE_MS &&
    cachedLiveReady.reason !== 'not live'
  ) {
    return cachedLiveReady;
  }
  const slot = getActiveTradingWallet();
  if (!slot || !slot.enabled) {
    return finishReady({
      ok: false,
      reason:
        'Live trading blocked — no active trading wallet loaded in the dashboard',
      walletId: null,
      walletName: null,
      publicKey: null,
      hasKey: false,
      balanceSol: null,
      minSol,
    });
  }
  const kp = getKeypair(slot.id);
  const pub = peekTradingWalletPublicKey(slot.id);
  if (!kp || !pub) {
    return finishReady({
      ok: false,
      reason: `Live trading blocked — wallet "${slot.name}" has no private key in env (${slot.envVar})`,
      walletId: slot.id,
      walletName: slot.name,
      publicKey: null,
      hasKey: false,
      balanceSol: null,
      minSol,
    });
  }
  const balanceSol = await getLiveBalanceSol(slot.id);
  if (balanceSol == null || !Number.isFinite(balanceSol)) {
    return finishReady({
      ok: false,
      reason: `Live trading blocked — could not read SOL balance for ${slot.name}`,
      walletId: slot.id,
      walletName: slot.name,
      publicKey: pub,
      hasKey: true,
      balanceSol: null,
      minSol,
    });
  }
  if (balanceSol < minSol) {
    return finishReady({
      ok: false,
      reason: `Live trading blocked — need ≥ ${minSol} SOL on ${slot.name}, have ${balanceSol.toFixed(4)} SOL`,
      walletId: slot.id,
      walletName: slot.name,
      publicKey: pub,
      hasKey: true,
      balanceSol,
      minSol,
    });
  }
  return finishReady({
    ok: true,
    reason: 'ready',
    walletId: slot.id,
    walletName: slot.name,
    publicKey: pub,
    hasKey: true,
    balanceSol,
    minSol,
  });
}

/**
 * Import Live wallet: on-chain SOL for available/equity + bot-recorded
 * live opens/closes only (no random on-chain swaps). Merges with saved
 * per-wallet closed history and sets connected=true.
 */
export async function importLiveWalletTradeHistory(paperTrader: {
  getDurableClosedPositions: () => Position[];
  getDurableOpenPositions: () => Position[];
}): Promise<{
  ok: boolean;
  error?: string;
  message?: string;
  imported: number;
  importedOpen: number;
  scannedSigs: number;
  walletPubkey: string | null;
  walletName: string | null;
  walletId: string | null;
  closed: Position[];
  opens: Position[];
  balances: LiveWalletBalances | null;
  noSystemTrades: boolean;
}> {
  if (!usesRealFunds()) {
    return {
      ok: false,
      error: 'Import Live Wallet is only available in Live mode',
      imported: 0,
      importedOpen: 0,
      scannedSigs: 0,
      walletPubkey: null,
      walletName: null,
      walletId: null,
      closed: [],
      opens: [],
      balances: null,
      noSystemTrades: true,
    };
  }
  const slot = getActiveTradingWallet();
  const pub = slot ? peekTradingWalletPublicKey(slot.id) : null;
  if (!slot || !pub) {
    return {
      ok: false,
      error: 'No live trading wallet with a loaded key',
      imported: 0,
      importedOpen: 0,
      scannedSigs: 0,
      walletPubkey: null,
      walletName: null,
      walletId: null,
      closed: [],
      opens: [],
      balances: null,
      noSystemTrades: true,
    };
  }

  const systemClosed = (paperTrader.getDurableClosedPositions() || []).filter(
    (p) => p.tradeMode === 'live'
  );
  const systemOpens = (paperTrader.getDurableOpenPositions() || []).filter(
    (p) => p.tradeMode === 'live'
  );

  const store = loadLiveWalletHistory();
  const saved = store.byWallet[pub]?.closed || [];
  const closed = mergeClosedById(saved, systemClosed).slice(
    0,
    LIVE_WALLET_IMPORT_MAX_TRADES
  );
  const opens = systemOpens.slice(0, 200);

  let availableSol = 0;
  const balanceRead = await getLiveBalanceSol(slot.id);
  if (balanceRead != null && Number.isFinite(balanceRead)) {
    availableSol = Math.max(0, balanceRead);
  }

  let positionsValueSol = 0;
  for (const p of opens) {
    const cost =
      Number(p.costSol) > 0
        ? Number(p.costSol)
        : Number(p.initialCostSol) > 0
          ? Number(p.initialCostSol)
          : 0;
    positionsValueSol += cost;
  }
  const equitySol = availableSol + positionsValueSol;
  const balances: LiveWalletBalances = {
    availableSol,
    equitySol,
    positionsValueSol,
    at: Date.now(),
  };

  store.connected = true;
  store.connectedPubkey = pub;
  store.byWallet[pub] = {
    closed,
    lastBalances: balances,
    walletName: slot.name,
    walletId: slot.id,
    updatedAt: Date.now(),
  };
  saveLiveWalletHistory(store);

  const noSystemTrades = closed.length === 0 && opens.length === 0;

  return {
    ok: true,
    imported: closed.length,
    importedOpen: opens.length,
    scannedSigs: 0,
    walletPubkey: pub,
    walletName: slot.name,
    walletId: slot.id,
    closed,
    opens,
    balances,
    noSystemTrades,
    message: noSystemTrades
      ? 'no trades or transactions have been recorded for this wallet'
      : undefined,
  };
}
