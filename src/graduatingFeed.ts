/**
 * Graduating / near-grad HTTP merge. Fail-soft if Tracker has no endpoint.
 * Prefers AlphaScan Soon/Bonded + optional Solana Tracker probe.
 * No naked curve buys — tags only for scanner merge / Migration watch.
 */

import type { LaunchEvent } from './marketData';
import { hasSolanaTrackerKey, getSolanaTrackerApiKey, getSolanaTrackerBaseUrl } from './solanaTracker';
import { loggedFetch } from './logger';

const MAX_ROWS = 40;
let lastTrackerAt = 0;
let cachedTracker: LaunchEvent[] = [];
let lastError: string | null = null;
let graduatingCount = 0;

    function rowToEvent(
  mint: string,
  extra: {
    symbol?: string;
    name?: string;
    curvePct?: number;
    marketCapUsd?: number;
    category?: string;
  }
): LaunchEvent {
  const category = extra.category || 'soon';
  const bonded =
    category === 'bonded' || category === 'graduated';
  const soon =
    category === 'soon' || category === 'graduating' || category === 'near-grad';
  return {
    mint,
    symbol: String(extra.symbol || mint.slice(0, 6)).slice(0, 24),
    name: String(extra.name || extra.symbol || 'Graduating').slice(0, 64),
    launchedAt: Date.now(),
    migrated: bonded,
    entryPriceSol: 0,
    lastPriceSol: 0,
    priceChangePct: 0,
    marketCapUsd: extra.marketCapUsd,
    candles: [],
    source: 'graduating_feed',
    isPumpFun: true,
    nearMigration: soon,
    scannerSources: ['graduating_feed'],
    scannerCategories: [category],
    curvePct: extra.curvePct,
  };
}

async function probeSolanaTrackerGraduating(): Promise<LaunchEvent[]> {
  if (!hasSolanaTrackerKey()) return [];
  const now = Date.now();
  if (now - lastTrackerAt < 45_000) return cachedTracker;
  lastTrackerAt = now;
  const base = getSolanaTrackerBaseUrl().replace(/\/$/, '');
  const key = getSolanaTrackerApiKey();
  const urls = [
    `${base}/tokens/graduating`,
    `${base}/tokens/multi/graduating`,
    `${base}/search?query=graduating`,
  ];
  for (const url of urls) {
    try {
      const res = await loggedFetch(url, {
        context: 'MarketData',
        label: 'tracker-graduating',
        timeoutMs: 8_000,
        headers: { 'x-api-key': key, accept: 'application/json' },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as unknown;
      const list = Array.isArray(data)
        ? data
        : Array.isArray((data as { tokens?: unknown[] })?.tokens)
          ? (data as { tokens: unknown[] }).tokens
          : Array.isArray((data as { data?: unknown[] })?.data)
            ? (data as { data: unknown[] }).data
            : [];
      const out: LaunchEvent[] = [];
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue;
        const row = raw as Record<string, unknown>;
        const mint = String(row.mint || row.token || row.address || '').trim();
        if (!mint) continue;
        const curve = Number(
          row.curvePct ?? row.bondingCurveProgress ?? row.progress
        );
        out.push(
          rowToEvent(mint, {
            symbol: String(row.symbol || ''),
            name: String(row.name || ''),
            curvePct: Number.isFinite(curve) ? curve : undefined,
            marketCapUsd: Number(row.marketCapUsd ?? row.mcap) || undefined,
            category: 'graduating',
          })
        );
        if (out.length >= MAX_ROWS) break;
      }
      cachedTracker = out;
      lastError = null;
      return out;
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'tracker graduating failed';
    }
  }
  cachedTracker = [];
  return [];
}

export function getGraduatingLaunchEvents(): LaunchEvent[] {
  const out: LaunchEvent[] = [];
  const seen = new Set<string>();
  try {
    const { getAlphaScanSnapshot } =
      require('./alphaScanFeed') as typeof import('./alphaScanFeed');
    const snap = getAlphaScanSnapshot();
    for (const row of [...(snap.soon || []), ...(snap.bonded || [])]) {
      const mint = String(row.mint || '').trim();
      if (!mint || seen.has(mint)) continue;
      seen.add(mint);
      const bonded = (snap.bonded || []).some((b) => b.mint === mint);
      out.push(
        rowToEvent(mint, {
          symbol: row.symbol,
          name: row.name,
          curvePct: row.curveProgressPct ?? undefined,
          marketCapUsd: row.marketCapUsd,
          category: bonded ? 'bonded' : 'soon',
        })
      );
      if (out.length >= MAX_ROWS) break;
    }
  } catch {
    /* AlphaScan optional */
  }
  for (const ev of cachedTracker) {
    if (seen.has(ev.mint)) continue;
    seen.add(ev.mint);
    out.push(ev);
    if (out.length >= MAX_ROWS) break;
  }
  graduatingCount = out.length;
  return out;
}

export async function refreshGraduatingFeed(): Promise<number> {
  try {
    await probeSolanaTrackerGraduating();
  } catch {
    /* fail soft */
  }
  return getGraduatingLaunchEvents().length;
}

export function getGraduatingFeedStatus(): {
  lastError: string | null;
  graduatingCandidates: number;
  trackerCached: number;
} {
  return {
    lastError,
    graduatingCandidates: graduatingCount,
    trackerCached: cachedTracker.length,
  };
}
