/**
 * MEV protection helpers — sandwich risk scan + status aggregation.
 */

import { PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import { config, persistUserSettings } from './config';
import { getConnection } from './connection';
import { getJitoStatus, getJitoStats } from './jito';

export interface SandwichCheckResult {
  safe: boolean;
  /** When false, caller should abort or delay the trade */
  reason: string;
  recentTxCount: number;
  suspiciousBuys: number;
  windowMs: number;
  checkedAt: number;
}

export interface MevStatus {
  enableMEVProtection: boolean;
  useJitoBundles: boolean;
  sandwichProtection: boolean;
  jito: ReturnType<typeof getJitoStatus>;
  jitoStats: ReturnType<typeof getJitoStats>;
  lastSandwichCheck: SandwichCheckResult | null;
  priorityFeeMultiplier: number;
  tipMultiplier: number;
}

let lastSandwichCheck: SandwichCheckResult | null = null;

export function isMevProtectionEnabled(): boolean {
  return Boolean(config.mev?.enableMEVProtection);
}

export function shouldUseJitoBundles(): boolean {
  if (!isMevProtectionEnabled()) {
    return Boolean(config.rpc?.jito?.enabled);
  }
  return config.mev?.useJitoBundles !== false;
}

export function shouldRunSandwichCheck(): boolean {
  return (
    isMevProtectionEnabled() && config.mev?.sandwichProtection !== false
  );
}

/**
 * Lightweight sandwich heuristic: many distinct buyers of the same mint
 * in a short lookback window → elevated sandwich / front-run risk.
 */
export async function checkSandwichRisk(
  mint: string
): Promise<SandwichCheckResult> {
  const windowMs = config.mev?.sandwichWindowMs ?? 12_000;
  const maxBuys = config.mev?.sandwichMaxRecentBuys ?? 3;
  const lookback = config.mev?.sandwichLookbackTxs ?? 16;
  const now = Date.now();

  const empty = (safe: boolean, reason: string): SandwichCheckResult => {
    const result: SandwichCheckResult = {
      safe,
      reason,
      recentTxCount: 0,
      suspiciousBuys: 0,
      windowMs,
      checkedAt: now,
    };
    lastSandwichCheck = result;
    return result;
  };

  if (!shouldRunSandwichCheck()) {
    return empty(true, 'Sandwich protection disabled');
  }

  if (!mint || mint.length < 32) {
    return empty(true, 'Invalid mint — skip sandwich check');
  }

  try {
    const conn = getConnection();
    const mintKey = new PublicKey(mint);
    const sigs = await conn.getSignaturesForAddress(mintKey, {
      limit: lookback,
    });

    if (sigs.length === 0) {
      return empty(true, 'No recent mint activity');
    }

    const cutoffSec = Math.floor((now - windowMs) / 1000);
    const recentSigs = sigs.filter(
      (s) => s.blockTime != null && s.blockTime >= cutoffSec && !s.err
    );

    const buyerOwners = new Set<string>();
    let inspected = 0;

    for (const sig of recentSigs.slice(0, 8)) {
      try {
        const tx = await conn.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
        });
        if (!tx?.meta || tx.meta.err) continue;
        inspected += 1;
        const buyers = extractMintBuyers(tx, mint);
        for (const b of buyers) buyerOwners.add(b);
      } catch {
        // ignore individual parse failures
      }
    }

    const suspiciousBuys = buyerOwners.size;
    const safe = suspiciousBuys < maxBuys;

    const result: SandwichCheckResult = {
      safe,
      reason: safe
        ? `OK — ${suspiciousBuys} distinct buyer(s) in last ${Math.round(windowMs / 1000)}s`
        : `Elevated sandwich risk — ${suspiciousBuys} distinct buyers of mint in last ${Math.round(windowMs / 1000)}s (max ${maxBuys - 1})`,
      recentTxCount: recentSigs.length,
      suspiciousBuys,
      windowMs,
      checkedAt: now,
    };

    lastSandwichCheck = result;

    if (!safe) {
      console.warn(`[mev] ⚠️ Sandwich check FAIL for ${mint.slice(0, 8)}…: ${result.reason}`);
    } else {
      console.log(
        `[mev] Sandwich check OK for ${mint.slice(0, 8)}… ` +
          `(${suspiciousBuys} buyers / ${inspected} txs inspected)`
      );
    }

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Fail-open with warning so RPC blips don't halt trading entirely
    console.warn(`[mev] Sandwich check error (allowing trade): ${message}`);
    return empty(true, `Check failed (allowed): ${message}`);
  }
}

function extractMintBuyers(
  tx: ParsedTransactionWithMeta,
  mint: string
): string[] {
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  const preMap = new Map<string, number>();

  for (const b of pre) {
    if (b.mint !== mint || !b.owner) continue;
    preMap.set(b.owner, Number(b.uiTokenAmount?.uiAmount ?? 0));
  }

  const buyers: string[] = [];
  for (const b of post) {
    if (b.mint !== mint || !b.owner) continue;
    const after = Number(b.uiTokenAmount?.uiAmount ?? 0);
    const before = preMap.get(b.owner) ?? 0;
    if (after > before + 1e-9) {
      buyers.push(b.owner);
    }
  }
  return buyers;
}

export function getMevStatus(): MevStatus {
  return {
    enableMEVProtection: isMevProtectionEnabled(),
    useJitoBundles: shouldUseJitoBundles(),
    sandwichProtection: shouldRunSandwichCheck(),
    jito: getJitoStatus(),
    jitoStats: getJitoStats(),
    lastSandwichCheck,
    priorityFeeMultiplier: config.mev?.priorityFeeMultiplier ?? 1.5,
    tipMultiplier: config.mev?.tipMultiplier ?? 1.5,
  };
}

export function updateMevConfig(
  partial: Partial<typeof config.mev>
): typeof config.mev {
  config.mev = { ...config.mev, ...partial };
  // Keep rpc.jito.enabled in sync when master MEV toggle turns bundles on
  if (partial.enableMEVProtection === true && config.mev.useJitoBundles) {
    config.rpc.jito.enabled = true;
  }
  if (partial.useJitoBundles !== undefined && isMevProtectionEnabled()) {
    config.rpc.jito.enabled = Boolean(partial.useJitoBundles);
  }
  console.log(
    `[mev] Config updated — protection=${config.mev.enableMEVProtection} ` +
      `jito=${config.mev.useJitoBundles} sandwich=${config.mev.sandwichProtection}`
  );
  persistUserSettings();
  return config.mev;
}
