/**
 * Zion KOL Token Scanner — independent of watch-list copy trading.
 * Builds a KOL universe (Kolscan + GMGN), rotates RPC activity polls,
 * aggregates by mint, and feeds candidates / offers into Zion.
 */

import { PublicKey } from '@solana/web3.js';
import { config } from './config';
import { getConnection } from './connection';
import { logger, errorToMeta } from './logger';
import {
  atomicWriteJson,
  dataFile,
  PERSIST_FILES,
  readJsonFile,
} from './dataDir';
import { findSmartWallets } from './walletDiscovery';
import { getTopSmartWallets } from './gmgn';
import { isDeniedCopyMint } from './deniedMints';
import {
  maybeCreateOffer,
  getPendingOfferForMint,
  type ZionKolWalletRef,
  type ZionOfferSource,
} from './zion';

export type ZionKolCandidateStatus = 'seen' | 'offered' | 'skipped';

export interface ZionKolCandidate {
  id: string;
  mint: string;
  symbol: string;
  name: string;
  timestamp: number;
  status: ZionKolCandidateStatus;
  /** Linked pending offer id when status is offered */
  offerId?: string;
  score: number;
  reasons: string[];
  skipReason?: string;
  kolCount: number;
  kolWallets: ZionKolWalletRef[];
  trackedBoostCount: number;
  mcUsd?: number;
  volumeH1Usd?: number;
  liquidityUsd?: number;
  holders?: number;
}

interface UniverseWallet {
  address: string;
  name: string;
  quality: number;
  source: string;
}

interface MintAgg {
  mint: string;
  symbol: string;
  name: string;
  wallets: Map<string, ZionKolWalletRef>;
  trackedBoost: Set<string>;
  lastBuyAt: number;
  mcUsd?: number;
  volumeH1Usd?: number;
  liquidityUsd?: number;
  holders?: number;
}

const UNIVERSE_FILE = dataFile(PERSIST_FILES.zionKolUniverse);
const UNIVERSE_REFRESH_MS = 30 * 60_000;

let universe: UniverseWallet[] = [];
let universeLoadedAt = 0;
let rotationIndex = 0;
let lastSignature = new Map<string, string>();
let mintAggs = new Map<string, MintAgg>();
let candidates: ZionKolCandidate[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;
let running = false;
let pollInFlight = false;
let lastPollAt = 0;
let lastError: string | null = null;
let lastUniverseMessage = '';

function zionCfg() {
  return config.zion;
}

function loadUniverseCache(): void {
  try {
    const raw = readJsonFile<{
      wallets?: UniverseWallet[];
      loadedAt?: number;
    }>(UNIVERSE_FILE);
    if (raw?.wallets?.length) {
      universe = raw.wallets;
      universeLoadedAt = Number(raw.loadedAt) || 0;
    }
  } catch {
    /* ignore */
  }
}

function persistUniverse(): void {
  try {
    atomicWriteJson(UNIVERSE_FILE, {
      loadedAt: universeLoadedAt,
      wallets: universe.slice(0, 120),
    });
  } catch (err) {
    logger.warn('ZionScanner', 'Universe persist failed', errorToMeta(err));
  }
}

async function refreshUniverse(force = false): Promise<void> {
  const size = Math.max(20, Math.min(100, Number(zionCfg().scanner.universeSize) || 60));
  if (
    !force &&
    universe.length >= Math.min(15, size) &&
    Date.now() - universeLoadedAt < UNIVERSE_REFRESH_MS
  ) {
    return;
  }

  const byAddr = new Map<string, UniverseWallet>();

  try {
    const kol = await findSmartWallets({
      source: 'kolscan',
      limit: size,
      force: true,
    });
    for (const w of kol.wallets || []) {
      const address = String(w.address || '').trim();
      if (!address || byAddr.has(address)) continue;
      byAddr.set(address, {
        address,
        name: String(w.name || address.slice(0, 8)),
        quality: Math.max(0, Number(w.smartFlowScore) || Number(w.winRate) || 40),
        source: 'kolscan',
      });
    }
    lastUniverseMessage = kol.message || `Kolscan ${kol.wallets?.length || 0}`;
  } catch (err) {
    lastUniverseMessage = err instanceof Error ? err.message : String(err);
    logger.warn('ZionScanner', 'Kolscan universe failed', errorToMeta(err));
  }

  try {
    const gmgn = await getTopSmartWallets(size, '30d', 0);
    for (const w of gmgn.wallets || []) {
      const address = String(w.address || '').trim();
      if (!address) continue;
      const tags = (w.tags || []).map((t) => String(t).toLowerCase());
      const looksKol =
        tags.some((t) => /kol|renowned|influencer/.test(t)) ||
        /kol/i.test(String(w.name || ''));
      if (!looksKol && byAddr.size >= size) continue;
      const prev = byAddr.get(address);
      const quality = Math.max(
        prev?.quality ?? 0,
        Math.round(Number(w.winRate) || 0),
        45
      );
      byAddr.set(address, {
        address,
        name: String(w.name || prev?.name || address.slice(0, 8)),
        quality,
        source: prev ? `${prev.source}+gmgn` : 'gmgn',
      });
    }
  } catch (err) {
    logger.warn('ZionScanner', 'GMGN KOL universe failed', errorToMeta(err));
  }

  universe = [...byAddr.values()]
    .sort((a, b) => b.quality - a.quality)
    .slice(0, size);
  universeLoadedAt = Date.now();
  persistUniverse();
  logger.info(
    'ZionScanner',
    `Universe refreshed: ${universe.length} KOL wallets`,
    { message: lastUniverseMessage }
  );
}

async function fetchDexMetrics(mint: string): Promise<{
  symbol?: string;
  name?: string;
  mcUsd?: number;
  volumeH1Usd?: number;
  liquidityUsd?: number;
}> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6_000);
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { signal: ctrl.signal }
    );
    clearTimeout(t);
    if (!res.ok) return {};
    const data = (await res.json()) as {
      pairs?: Array<Record<string, unknown>>;
    };
    const pairs = data.pairs || [];
    const sol =
      pairs.find((p) => String(p.chainId) === 'solana') || pairs[0];
    if (!sol) return {};
    const base = sol.baseToken as { symbol?: string; name?: string } | undefined;
    const vol = sol.volume as { h1?: number } | undefined;
    const liq = sol.liquidity as { usd?: number } | undefined;
    const mc = Number(sol.marketCap ?? sol.fdv ?? NaN);
    return {
      symbol: base?.symbol,
      name: base?.name,
      mcUsd: Number.isFinite(mc) && mc > 0 ? mc : undefined,
      volumeH1Usd:
        vol?.h1 != null && Number.isFinite(Number(vol.h1))
          ? Number(vol.h1)
          : undefined,
      liquidityUsd:
        liq?.usd != null && Number.isFinite(Number(liq.usd))
          ? Number(liq.usd)
          : undefined,
    };
  } catch {
    return {};
  }
}

function recordBuy(input: {
  mint: string;
  symbol?: string;
  name?: string;
  wallet: UniverseWallet | ZionKolWalletRef;
  tracked?: boolean;
  timestamp?: number;
}): void {
  const mint = input.mint.trim();
  if (!mint || isDeniedCopyMint(mint, config.solMint)) return;
  let agg = mintAggs.get(mint);
  if (!agg) {
    agg = {
      mint,
      symbol: input.symbol || mint.slice(0, 6),
      name: input.name || input.symbol || mint.slice(0, 6),
      wallets: new Map(),
      trackedBoost: new Set(),
      lastBuyAt: 0,
    };
    mintAggs.set(mint, agg);
  }
  const addr = input.wallet.address;
  const ref: ZionKolWalletRef = {
    address: addr,
    name: input.wallet.name || addr.slice(0, 8),
    quality: 'quality' in input.wallet ? Number(input.wallet.quality) || undefined : undefined,
    source: 'source' in input.wallet ? String(input.wallet.source || '') : undefined,
  };
  if (!input.tracked) {
    agg.wallets.set(addr, ref);
  } else {
    agg.trackedBoost.add(addr);
    if (!agg.wallets.has(addr)) {
      agg.wallets.set(addr, { ...ref, source: ref.source || 'tracked' });
    }
  }
  const ts = input.timestamp || Date.now();
  if (ts > agg.lastBuyAt) agg.lastBuyAt = ts;
  if (input.symbol) agg.symbol = input.symbol;
  if (input.name) agg.name = input.name;
}

async function parseBuysFromSig(
  wallet: UniverseWallet,
  signature: string
): Promise<number> {
  const conn = getConnection();
  const tx = await conn.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  });
  if (!tx?.meta) return 0;

  const pre = tx.meta.preTokenBalances ?? [];
  const post = tx.meta.postTokenBalances ?? [];
  let n = 0;
  const blockTime = (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000;

  for (const p of post) {
    if (p.owner !== wallet.address) continue;
    const mint = p.mint;
    if (isDeniedCopyMint(mint, config.solMint)) continue;
    const before = pre.find(
      (x) => x.mint === mint && x.owner === wallet.address
    );
    const preAmt = before?.uiTokenAmount.uiAmount ?? 0;
    const postAmt = p.uiTokenAmount.uiAmount ?? 0;
    if (postAmt <= preAmt) continue;
    recordBuy({
      mint,
      wallet,
      timestamp: blockTime,
      symbol: mint.slice(0, 6),
    });
    n++;
  }
  return n;
}

async function pollUniverseBatch(): Promise<number> {
  if (!universe.length) return 0;
  const batchSize = Math.max(
    2,
    Math.min(12, Number(zionCfg().scanner.batchSize) || 6)
  );
  const start = rotationIndex % universe.length;
  const batch: UniverseWallet[] = [];
  for (let i = 0; i < batchSize && i < universe.length; i++) {
    batch.push(universe[(start + i) % universe.length]);
  }
  rotationIndex = (start + batch.length) % Math.max(1, universe.length);

  const conn = getConnection();
  let buys = 0;

  for (const wallet of batch) {
    try {
      const pubkey = new PublicKey(wallet.address);
      const sigs = await conn.getSignaturesForAddress(pubkey, { limit: 8 });
      if (!sigs.length) continue;
      const lastSeen = lastSignature.get(wallet.address);
      if (lastSeen == null) {
        lastSignature.set(wallet.address, sigs[0].signature);
        continue;
      }
      const newer: string[] = [];
      for (const s of sigs) {
        if (s.signature === lastSeen) break;
        newer.push(s.signature);
      }
      if (!newer.length) continue;
      const chronological = newer.reverse().slice(0, 3);
      let lastOk: string | null = null;
      for (const sig of chronological) {
        const n = await parseBuysFromSig(wallet, sig);
        buys += n;
        lastOk = sig;
      }
      if (lastOk) lastSignature.set(wallet.address, lastOk);
    } catch (err) {
      logger.warn(
        'ZionScanner',
        `Poll fail ${wallet.name}`,
        errorToMeta(err)
      );
    }
  }
  return buys;
}

function pruneAggs(): void {
  const lookback =
    Math.max(10, Number(zionCfg().scanner.activityLookbackMinutes) || 45) *
    60_000;
  const cutoff = Date.now() - lookback;
  for (const [mint, agg] of mintAggs) {
    if (agg.lastBuyAt < cutoff) mintAggs.delete(mint);
  }
}

function scoreAgg(agg: MintAgg): {
  score: number;
  reasons: string[];
  source: ZionOfferSource;
  ok: boolean;
  skipReason?: string;
} {
  const reasons: string[] = [];
  const minKol = Math.max(1, Number(zionCfg().minKolWallets) || 2);
  const minQ = Math.max(0, Number(zionCfg().minWalletQuality) || 0);
  const kolWallets = [...agg.wallets.values()].filter(
    (w) => (w.quality ?? 50) >= minQ || minQ <= 0
  );
  const tracked = agg.trackedBoost.size;
  // Hard floor: real KOL wallets only. Tracked boost never fills this gap.
  if (kolWallets.length < minKol) {
    return {
      score: Math.min(40, kolWallets.length * 14),
      reasons,
      source: 'kol_scanner',
      ok: false,
      skipReason: `Need ${minKol} KOLs (have ${kolWallets.length}${
        tracked > 0 ? `, tracked +${tracked} boost only` : ''
      })`,
    };
  }

  let score = Math.min(40, kolWallets.length * 14);
  reasons.push(`${kolWallets.length} KOL wallet(s)`);
  if (
    tracked > 0 &&
    zionCfg().useTrackedWalletsAsBoost !== false
  ) {
    score += Math.min(15, tracked * 8);
    reasons.push(`${tracked} tracked boost`);
  }
  if (agg.mcUsd != null) {
    const minMc = Number(zionCfg().minMcUsd) || 0;
    const maxMc = Number(zionCfg().maxMcUsd) || 0;
    if (minMc > 0 && agg.mcUsd < minMc) {
      return {
        score,
        reasons,
        source: 'kol_scanner',
        ok: false,
        skipReason: `MC $${Math.round(agg.mcUsd)} < min`,
      };
    }
    if (maxMc > 0 && agg.mcUsd > maxMc) {
      return {
        score,
        reasons,
        source: 'kol_scanner',
        ok: false,
        skipReason: `MC $${Math.round(agg.mcUsd)} > max`,
      };
    }
    score += 10;
    reasons.push(`MC $${Math.round(agg.mcUsd).toLocaleString()}`);
  }
  if (agg.volumeH1Usd != null && agg.volumeH1Usd > 5_000) {
    score += 8;
    reasons.push(`vol1h $${Math.round(agg.volumeH1Usd).toLocaleString()}`);
  }
  const ageMin = (Date.now() - agg.lastBuyAt) / 60_000;
  if (ageMin <= 15) {
    score += 12;
    reasons.push('fresh <15m');
  } else if (ageMin <= 45) {
    score += 6;
    reasons.push('fresh <45m');
  }

  const source: ZionOfferSource =
    tracked > 0 && kolWallets.length > 0
      ? 'hybrid'
      : tracked > 0
        ? 'tracked_boost'
        : 'kol_scanner';

  return { score: Math.min(100, score), reasons, source, ok: true };
}

async function rebuildCandidates(): Promise<void> {
  pruneAggs();
  const next: ZionKolCandidate[] = [];
  const sorted = [...mintAggs.values()].sort(
    (a, b) => b.wallets.size - a.wallets.size || b.lastBuyAt - a.lastBuyAt
  );

  for (const agg of sorted.slice(0, 40)) {
    if (agg.mcUsd == null) {
      const m = await fetchDexMetrics(agg.mint);
      if (m.symbol) agg.symbol = m.symbol;
      if (m.name) agg.name = m.name;
      if (m.mcUsd != null) agg.mcUsd = m.mcUsd;
      if (m.volumeH1Usd != null) agg.volumeH1Usd = m.volumeH1Usd;
      if (m.liquidityUsd != null) agg.liquidityUsd = m.liquidityUsd;
    }

    const ranked = scoreAgg(agg);
    const minQ = Math.max(0, Number(zionCfg().minWalletQuality) || 0);
    const kolWallets = [...agg.wallets.values()].filter(
      (w) => (w.quality ?? 50) >= minQ || minQ <= 0
    );
    const cand: ZionKolCandidate = {
      id: `zion-${agg.mint.slice(0, 12)}`,
      mint: agg.mint,
      symbol: agg.symbol,
      name: agg.name,
      timestamp: agg.lastBuyAt,
      status: ranked.ok ? 'seen' : 'skipped',
      score: ranked.score,
      reasons: ranked.reasons,
      skipReason: ranked.skipReason,
      kolCount: kolWallets.length,
      kolWallets,
      trackedBoostCount: agg.trackedBoost.size,
      mcUsd: agg.mcUsd,
      volumeH1Usd: agg.volumeH1Usd,
      liquidityUsd: agg.liquidityUsd,
      holders: agg.holders,
    };

    if (
      ranked.ok &&
      zionCfg().autoOfferFromScanner !== false &&
      zionCfg().enabled
    ) {
      const offer = maybeCreateOffer({
        mint: agg.mint,
        symbol: agg.symbol,
        name: agg.name,
        source: ranked.source,
        score: ranked.score,
        reasons: ranked.reasons,
        kolWallets,
        trackedBoostCount: agg.trackedBoost.size,
        mcUsd: agg.mcUsd,
        volumeH1Usd: agg.volumeH1Usd,
        liquidityUsd: agg.liquidityUsd,
        holders: agg.holders,
      });
      if (offer) {
        cand.status = 'offered';
        cand.offerId = offer.id;
      }
    } else {
      const pending = getPendingOfferForMint(agg.mint);
      if (pending) {
        cand.status = 'offered';
        cand.offerId = pending.id;
      }
    }

    next.push(cand);
  }

  candidates = next.sort((a, b) => b.score - a.score || b.timestamp - a.timestamp);
}

export async function runZionScannerPollOnce(): Promise<void> {
  if (pollInFlight) return;
  if (!zionCfg()?.enabled || zionCfg().scanner?.enabled === false) return;
  pollInFlight = true;
  try {
    if (!universe.length) loadUniverseCache();
    await refreshUniverse(false);
    await pollUniverseBatch();
    await rebuildCandidates();
    lastPollAt = Date.now();
    lastError = null;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    logger.warn('ZionScanner', 'Poll failed', errorToMeta(err));
  } finally {
    pollInFlight = false;
  }
}

/** Observe-only: tracked wallet buy boosts an existing/new mint agg. Never buys. */
export function noteTrackedBuy(input: {
  mint: string;
  symbol?: string;
  name?: string;
  walletAddress: string;
  walletName?: string;
  timestamp?: number;
}): void {
  if (!zionCfg()?.enabled) return;
  if (zionCfg().useTrackedWalletsAsBoost === false) return;
  const mint = String(input.mint || '').trim();
  if (!mint) return;
  recordBuy({
    mint,
    symbol: input.symbol,
    name: input.name,
    tracked: true,
    timestamp: input.timestamp,
    wallet: {
      address: input.walletAddress,
      name: input.walletName || input.walletAddress.slice(0, 8),
      quality: 55,
      source: 'tracked',
    },
  });
}

export function getZionScannerFeed(limit = 40): ZionKolCandidate[] {
  return candidates.slice(0, Math.max(1, Math.min(80, limit)));
}

export function getZionScannerStatus(): {
  running: boolean;
  enabled: boolean;
  universeSize: number;
  lastPollAt: number;
  lastError: string | null;
  candidateCount: number;
  universeMessage: string;
} {
  return {
    running,
    enabled: zionCfg()?.enabled === true && zionCfg().scanner?.enabled !== false,
    universeSize: universe.length,
    lastPollAt,
    lastError,
    candidateCount: candidates.length,
    universeMessage: lastUniverseMessage,
  };
}

export function startZionKolScanner(): void {
  if (running) return;
  if (!zionCfg()?.enabled || zionCfg().scanner?.enabled === false) return;
  running = true;
  loadUniverseCache();
  const interval = Math.max(
    30_000,
    Number(zionCfg().scanner.pollIntervalMs) || 60_000
  );
  console.log(
    `[zion] KOL Token Scanner starting — poll every ${interval}ms, universe≤${zionCfg().scanner.universeSize}`
  );
  setTimeout(() => {
    void runZionScannerPollOnce();
  }, 18_000);
  pollTimer = setInterval(() => {
    void runZionScannerPollOnce();
  }, interval);
}

export function stopZionKolScanner(): void {
  running = false;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Start or stop based on current config (no strategy toggle side effects). */
export function syncZionKolScannerLifecycle(): void {
  const want =
    zionCfg()?.enabled === true && zionCfg().scanner?.enabled !== false;
  if (want && !running) startZionKolScanner();
  else if (!want && running) stopZionKolScanner();
  else if (want && running) {
    stopZionKolScanner();
    startZionKolScanner();
  }
}
