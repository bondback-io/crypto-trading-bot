/**
 * Live wallet on-chain trade history import.
 * Live mode only — never mixes paper / liveSimulation ledger rows.
 */

import {
  atomicWriteJson,
  dataFile,
  ensureDataDir,
  PERSIST_FILES,
  readJsonFile,
} from './dataDir';
import {
  withRpc,
  getKeypair,
  getLiveBalanceSol,
  peekTradingWalletPublicKey,
} from './connection';
import {
  getActiveTradingWallet,
  usesRealFunds,
  type TradingMode,
} from './config';
import { logger, errorToMeta } from './logger';
import type { Position } from './paperTrader';
import { PublicKey, type ParsedTransactionWithMeta } from '@solana/web3.js';

export const LIVE_WALLET_IMPORT_MAX_SIGS = 400;
export const LIVE_WALLET_IMPORT_MAX_TRADES = 1000;
/** Default min SOL on the live wallet before Live trading may fire */
export const DEFAULT_LIVE_MIN_WALLET_SOL = 0.05;

export interface LiveWalletHistoryFile {
  version: 1;
  updatedAt: number;
  walletPubkey: string;
  closed: Position[];
}

const FILE = () => dataFile(PERSIST_FILES.liveWalletHistory);

function emptyHistory(walletPubkey = ''): LiveWalletHistoryFile {
  return {
    version: 1,
    updatedAt: 0,
    walletPubkey,
    closed: [],
  };
}

export function loadLiveWalletHistory(): LiveWalletHistoryFile {
  try {
    ensureDataDir();
    const raw = readJsonFile<LiveWalletHistoryFile>(FILE());
    if (!raw || typeof raw !== 'object') return emptyHistory();
    return {
      version: 1,
      updatedAt: Number(raw.updatedAt) || 0,
      walletPubkey: String(raw.walletPubkey || ''),
      closed: Array.isArray(raw.closed) ? raw.closed : [],
    };
  } catch {
    return emptyHistory();
  }
}

export function saveLiveWalletHistory(file: LiveWalletHistoryFile): void {
  ensureDataDir();
  file.updatedAt = Date.now();
  file.closed = file.closed.slice(0, LIVE_WALLET_IMPORT_MAX_TRADES);
  atomicWriteJson(FILE(), file);
}

export function clearLiveWalletHistory(): void {
  saveLiveWalletHistory(emptyHistory());
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

/** Last Live gate evaluation (updated by assertLiveTradingReady / status). */
export function getCachedLiveTradingReady(): LiveTradingReadyResult | null {
  return cachedLiveReady;
}

async function finishReady(
  result: LiveTradingReadyResult
): Promise<LiveTradingReadyResult> {
  cachedLiveReady = result;
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

type MintLeg = {
  mint: string;
  symbol: string;
  signedSol: number;
  slot: number;
  blockTime: number;
  signature: string;
};

function extractLegs(
  tx: ParsedTransactionWithMeta,
  owner: string
): MintLeg[] {
  const meta = tx.meta;
  if (!meta || meta.err) return [];
  const msg = tx.transaction.message;
  const accountKeys = msg.accountKeys.map((k) =>
    typeof k === 'string' ? k : k.pubkey.toBase58()
  );
  const ownerIdx = accountKeys.indexOf(owner);
  if (ownerIdx < 0) return [];

  const preSol = (meta.preBalances?.[ownerIdx] ?? 0) / 1e9;
  const postSol = (meta.postBalances?.[ownerIdx] ?? 0) / 1e9;
  const solDelta = postSol - preSol;

  const preTok = meta.preTokenBalances || [];
  const postTok = meta.postTokenBalances || [];
  const byMint = new Map<string, { pre: number; post: number; decimals: number }>();

  for (const b of preTok) {
    if (b.owner !== owner || !b.mint) continue;
    const ui = Number(b.uiTokenAmount?.uiAmount ?? 0);
    const cur = byMint.get(b.mint) || {
      pre: 0,
      post: 0,
      decimals: b.uiTokenAmount?.decimals ?? 0,
    };
    cur.pre = ui;
    byMint.set(b.mint, cur);
  }
  for (const b of postTok) {
    if (b.owner !== owner || !b.mint) continue;
    const ui = Number(b.uiTokenAmount?.uiAmount ?? 0);
    const cur = byMint.get(b.mint) || {
      pre: 0,
      post: 0,
      decimals: b.uiTokenAmount?.decimals ?? 0,
    };
    cur.post = ui;
    byMint.set(b.mint, cur);
  }

  const blockTime = (tx.blockTime || 0) * 1000;
  const signature =
    tx.transaction.signatures?.[0] ||
    `slot-${tx.slot}`;
  const legs: MintLeg[] = [];

  for (const [mint, bal] of byMint) {
    const delta = bal.post - bal.pre;
    if (Math.abs(delta) < 1e-12) continue;
    // Attribute SOL delta to the dominant mint change in this tx
    legs.push({
      mint,
      symbol: mint.slice(0, 4),
      signedSol: delta > 0 ? -Math.abs(solDelta) : Math.abs(solDelta),
      slot: tx.slot,
      blockTime: blockTime || Date.now(),
      signature,
    });
  }

  // Prefer single-mint swaps
  if (legs.length > 1) {
    legs.sort(
      (a, b) => Math.abs(b.signedSol) - Math.abs(a.signedSol)
    );
    return [legs[0]!];
  }
  return legs;
}

function pairLegsToClosed(legs: MintLeg[]): Position[] {
  // Group by mint: buys (token in / SOL out → signedSol < 0) then sells
  const byMint = new Map<string, MintLeg[]>();
  for (const leg of legs) {
    const arr = byMint.get(leg.mint) || [];
    arr.push(leg);
    byMint.set(leg.mint, arr);
  }
  const closed: Position[] = [];
  for (const [mint, arr] of byMint) {
    arr.sort((a, b) => a.blockTime - b.blockTime);
    const buys = arr.filter((l) => l.signedSol < 0);
    const sells = arr.filter((l) => l.signedSol > 0);
    let bi = 0;
    let si = 0;
    while (bi < buys.length && si < sells.length) {
      const buy = buys[bi]!;
      const sell = sells[si]!;
      if (sell.blockTime < buy.blockTime) {
        si++;
        continue;
      }
      const costSol = Math.abs(buy.signedSol);
      const proceeds = Math.abs(sell.signedSol);
      const pnlSol = proceeds - costSol;
      const pnlPct = costSol > 0 ? (pnlSol / costSol) * 100 : 0;
      closed.push({
        id: `liveimp-${sell.signature.slice(0, 16)}`,
        mint,
        symbol: buy.symbol || mint.slice(0, 6),
        name: '',
        entryPriceSol: 1,
        amountTokens: 0,
        costSol: costSol || 0.001,
        initialAmountTokens: 0,
        initialCostSol: costSol || 0.001,
        takeProfitPct: 0,
        stopLossPct: 0,
        highWaterMarkSol: 1,
        trailingStopPct: 0,
        trailingActive: false,
        tiersHit: [],
        initialRecovered: false,
        partialSellDone: false,
        bagTrimDone: false,
        solReturned: proceeds,
        strategyKind: 'normal',
        tradeMode: 'live',
        realizedPnlSol: pnlSol,
        openedAt: buy.blockTime,
        closedAt: sell.blockTime,
        exitPriceSol: costSol > 0 ? proceeds / costSol : 1,
        pnlSol,
        pnlPct,
        status: 'closed',
        reason: 'live_wallet_import',
        entrySource: 'wallet',
        tradeProfileId: 'default',
      });
      bi++;
      si++;
    }
  }
  closed.sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
  return closed.slice(0, LIVE_WALLET_IMPORT_MAX_TRADES);
}

/**
 * Scan the active live wallet for swap-like token balance changes and
 * pair buy→sell legs into closed Position rows. Live mode only.
 */
export async function importLiveWalletTradeHistory(): Promise<{
  ok: boolean;
  error?: string;
  imported: number;
  scannedSigs: number;
  walletPubkey: string | null;
  closed: Position[];
}> {
  if (!usesRealFunds()) {
    return {
      ok: false,
      error: 'Import Live Wallet is only available in Live mode',
      imported: 0,
      scannedSigs: 0,
      walletPubkey: null,
      closed: [],
    };
  }
  const slot = getActiveTradingWallet();
  const pub = slot ? peekTradingWalletPublicKey(slot.id) : null;
  if (!slot || !pub) {
    return {
      ok: false,
      error: 'No live trading wallet with a loaded key',
      imported: 0,
      scannedSigs: 0,
      walletPubkey: null,
      closed: [],
    };
  }

  const owner = pub;
  let sigInfos: Array<{ signature: string }> = [];
  try {
    sigInfos = await withRpc('getSignaturesForAddress', (conn) =>
      conn.getSignaturesForAddress(new PublicKey(owner), {
        limit: LIVE_WALLET_IMPORT_MAX_SIGS,
      })
    );
  } catch (err) {
    logger.warn('LiveWalletImport', 'signatures failed', errorToMeta(err));
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      imported: 0,
      scannedSigs: 0,
      walletPubkey: owner,
      closed: [],
    };
  }

  const legs: MintLeg[] = [];
  const batchSize = 25;
  for (let i = 0; i < sigInfos.length; i += batchSize) {
    const batch = sigInfos.slice(i, i + batchSize).map((s) => s.signature);
    try {
      const txs = await withRpc('getParsedTransactions', (conn) =>
        conn.getParsedTransactions(batch, {
          maxSupportedTransactionVersion: 0,
        })
      );
      for (const tx of txs) {
        if (!tx) continue;
        legs.push(...extractLegs(tx as ParsedTransactionWithMeta, owner));
      }
    } catch (err) {
      logger.warn('LiveWalletImport', 'batch parse failed', errorToMeta(err));
    }
  }

  const closed = pairLegsToClosed(legs);
  saveLiveWalletHistory({
    version: 1,
    updatedAt: Date.now(),
    walletPubkey: owner,
    closed,
  });

  return {
    ok: true,
    imported: closed.length,
    scannedSigs: sigInfos.length,
    walletPubkey: owner,
    closed,
  };
}
