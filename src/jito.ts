/**
 * Jito bundle support for atomic landing + MEV protection.
 * Sends signed versioned transactions to a Jito block engine with tip.
 */

import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { config } from './config';
import { getConnection, estimatePriorityFeeMicroLamports } from './connection';
import { logger, errorToMeta, loggedFetch } from './logger';

const DEFAULT_BLOCK_ENGINE = 'https://mainnet.block-engine.jito.wtf';

/** Well-known Jito tip accounts (mainnet) */
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4bVmkzs47Zvb3pFnuAxBxv4',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvZqfPctjRoB2TLX8mXmHJk',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

interface JitoStats {
  bundlesAttempted: number;
  bundlesSucceeded: number;
  bundlesFailed: number;
  lastTipLamports: number | null;
  lastBundleId: string | null;
  lastError: string | null;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
}

const stats: JitoStats = {
  bundlesAttempted: 0,
  bundlesSucceeded: 0,
  bundlesFailed: 0,
  lastTipLamports: null,
  lastBundleId: null,
  lastError: null,
  lastSuccessAt: null,
  lastAttemptAt: null,
};

function jitoEnabled(): boolean {
  // Master MEV toggle can force Jito on
  if (config.mev?.enableMEVProtection && config.mev?.useJitoBundles !== false) {
    return true;
  }
  return Boolean(config.rpc?.jito?.enabled);
}

function blockEngineUrl(): string {
  return (
    process.env.JITO_BLOCK_ENGINE?.trim() ||
    config.rpc?.jito?.blockEngineUrl ||
    DEFAULT_BLOCK_ENGINE
  );
}

function baseTipLamports(): number {
  return (
    config.rpc?.jito?.tipLamports ??
    (Number(process.env.JITO_TIP_LAMPORTS) || 10_000)
  );
}

/** Tip with optional MEV multiplier */
export function effectiveTipLamports(): number {
  const base = baseTipLamports();
  const mult =
    config.mev?.enableMEVProtection && config.mev?.tipMultiplier
      ? config.mev.tipMultiplier
      : 1;
  return Math.max(1_000, Math.floor(base * mult));
}

function pickTipAccount(): PublicKey {
  const idx = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
  return new PublicKey(JITO_TIP_ACCOUNTS[idx]);
}

/**
 * Build a tip-only versioned transaction for bundling after the swap.
 */
export async function buildJitoTipTransaction(
  payer: Keypair,
  tipAmount = effectiveTipLamports()
): Promise<VersionedTransaction> {
  const conn = getConnection();
  const { blockhash } = await conn.getLatestBlockhash('confirmed');

  const tipIx = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: pickTipAccount(),
    lamports: tipAmount,
  });

  const tipMessage = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [tipIx],
  }).compileToV0Message();

  const tipTx = new VersionedTransaction(tipMessage);
  tipTx.sign([payer]);
  return tipTx;
}

/** @deprecated use buildJitoTipTransaction */
export async function addJitoTipInstruction(
  vtx: VersionedTransaction,
  payer: Keypair,
  tipAmount = effectiveTipLamports()
): Promise<VersionedTransaction> {
  void vtx;
  return buildJitoTipTransaction(payer, tipAmount);
}

export interface JitoSendResult {
  success: boolean;
  bundleId?: string;
  signature?: string;
  tipLamports?: number;
  error?: string;
  method: 'jito' | 'rpc';
}

/**
 * Send one or more signed versioned transactions via Jito bundle.
 */
export async function sendJitoBundle(
  signedTransactions: VersionedTransaction[],
  payer: Keypair
): Promise<JitoSendResult> {
  if (!jitoEnabled()) {
    return { success: false, method: 'jito', error: 'Jito disabled' };
  }

  if (signedTransactions.length === 0) {
    return { success: false, method: 'jito', error: 'No transactions' };
  }

  const tip = effectiveTipLamports();
  stats.bundlesAttempted += 1;
  stats.lastAttemptAt = Date.now();
  stats.lastTipLamports = tip;

  try {
    const tipTx = await buildJitoTipTransaction(payer, tip);
    const bundle = [...signedTransactions, tipTx];

    const encoded = bundle.map((tx) =>
      Buffer.from(tx.serialize()).toString('base64')
    );

    const engine = blockEngineUrl().replace(/\/$/, '');
    const uuid =
      process.env.JITO_UUID?.trim() ||
      config.rpc?.jito?.uuid ||
      '';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (uuid) headers['x-jito-auth'] = uuid;

    console.log(
      `[jito] Submitting bundle (${bundle.length} tx) tip=${tip} lamports ` +
        `(${(tip / 1e9).toFixed(6)} SOL) → ${engine}`
    );

    const res = await loggedFetch(`${engine}/api/v1/bundles`, {
      context: 'Jito',
      label: 'sendBundle',
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [encoded],
      }),
      timeoutMs: 15_000,
    });

    const json = (await res.json()) as {
      result?: string;
      error?: { message?: string };
    };

    if (!res.ok || json.error) {
      const errMsg = json.error?.message || `HTTP ${res.status}`;
      stats.bundlesFailed += 1;
      stats.lastError = errMsg;
      logger.error('Jito', 'bundle rejected', {
        status: res.status,
        error: errMsg,
        tipLamports: tip,
        body: JSON.stringify(json).slice(0, 300),
      });
      return { success: false, method: 'jito', error: errMsg, tipLamports: tip };
    }

    const bundleId = json.result;
    stats.bundlesSucceeded += 1;
    stats.lastBundleId = bundleId ?? null;
    stats.lastSuccessAt = Date.now();
    stats.lastError = null;

    logger.info('Jito', 'bundle success', {
      bundleId,
      tipLamports: tip,
      rate: `${stats.bundlesSucceeded}/${stats.bundlesAttempted}`,
    });

    return {
      success: true,
      method: 'jito',
      bundleId,
      signature: bundleId,
      tipLamports: tip,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stats.bundlesFailed += 1;
    stats.lastError = message;
    logger.error('Jito', 'bundle send failed', {
      tipLamports: tip,
      ...errorToMeta(err),
    });
    return { success: false, method: 'jito', error: message, tipLamports: tip };
  }
}

/**
 * High-level: try Jito bundle first; return bundle id or null for RPC fallback.
 */
export async function trySendViaJito(
  signedTx: VersionedTransaction,
  payer: Keypair
): Promise<{ bundleId: string; tipLamports: number } | null> {
  if (!jitoEnabled()) return null;

  await estimatePriorityFeeMicroLamports(payer.publicKey).catch(() => undefined);

  const result = await sendJitoBundle([signedTx], payer);
  if (result.success && result.bundleId) {
    return {
      bundleId: result.bundleId,
      tipLamports: result.tipLamports ?? effectiveTipLamports(),
    };
  }
  return null;
}

export function getJitoStatus() {
  return {
    enabled: jitoEnabled(),
    blockEngine: blockEngineUrl(),
    tipLamports: effectiveTipLamports(),
    baseTipLamports: baseTipLamports(),
    hasUuid: Boolean(
      process.env.JITO_UUID?.trim() || config.rpc?.jito?.uuid
    ),
  };
}

export function getJitoStats() {
  return { ...stats };
}
