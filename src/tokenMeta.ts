/**
 * Resolve token ticker (symbol) + full name from DexScreener / Jupiter.
 * Falls back to mint prefix when metadata is unavailable.
 */

import { logger, errorToMeta, loggedFetch } from './logger';

export interface TokenMeta {
  mint: string;
  /** Ticker / ticket, e.g. "BONK" */
  symbol: string;
  /** Full token name, e.g. "Bonk" */
  name: string;
  source: 'dexscreener' | 'jupiter' | 'cache' | 'fallback';
}

const cache = new Map<string, TokenMeta>();
const inflight = new Map<string, Promise<TokenMeta>>();

function isValidMint(m: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m);
}

/** Short mint label used when symbol/name are unknown */
export function mintPrefix(mint: string, len = 6): string {
  return mint.slice(0, len);
}

/** Display helper: "TICKER — Full Name" or just ticker when name matches */
export function formatTokenLabel(
  symbol: string,
  name?: string | null,
  mint?: string
): string {
  const tick = (symbol || '').trim() || (mint ? mintPrefix(mint) : '?');
  const full = (name || '').trim();
  if (!full || full.toLowerCase() === tick.toLowerCase()) return tick;
  return `${tick} — ${full}`;
}

function fallbackMeta(mint: string): TokenMeta {
  const prefix = mintPrefix(mint);
  return { mint, symbol: prefix, name: prefix, source: 'fallback' };
}

async function fetchJson(url: string, timeoutMs = 8_000): Promise<unknown | null> {
  const context = url.includes('dexscreener')
    ? 'DexScreener'
    : url.includes('jup') || url.includes('jupiter')
      ? 'Jupiter'
      : 'System';
  try {
    const res = await loggedFetch(url, {
      context,
      label: 'tokenMeta',
      timeoutMs,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'solana-smart-copy-bot/1.0',
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    logger.error(context, 'tokenMeta fetch failed', {
      url: url.slice(0, 120),
      ...errorToMeta(err),
    });
    return null;
  }
}

async function fromDexScreener(mint: string): Promise<TokenMeta | null> {
  const data = await fetchJson(
    `https://api.dexscreener.com/latest/dex/tokens/${mint}`
  );
  const pairs =
    (data as { pairs?: Record<string, unknown>[] } | null)?.pairs ?? [];
  const sol =
    pairs.find((p) => String(p.chainId) === 'solana') ?? pairs[0];
  if (!sol) return null;

  const base = sol.baseToken as { symbol?: string; name?: string } | undefined;
  const symbol = String(base?.symbol ?? '').trim();
  const name = String(base?.name ?? '').trim();
  if (!symbol && !name) return null;

  return {
    mint,
    symbol: symbol || name || mintPrefix(mint),
    name: name || symbol || mintPrefix(mint),
    source: 'dexscreener',
  };
}

async function fromJupiter(mint: string): Promise<TokenMeta | null> {
  // Jupiter token search (lite API)
  const data = await fetchJson(
    `https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`
  );
  if (!data || !Array.isArray(data) || data.length === 0) return null;

  const exact =
    (data as Record<string, unknown>[]).find(
      (t) => String(t.id ?? t.address ?? '') === mint
    ) ?? (data as Record<string, unknown>[])[0];

  const symbol = String(exact.symbol ?? '').trim();
  const name = String(exact.name ?? '').trim();
  if (!symbol && !name) return null;

  return {
    mint,
    symbol: symbol || name || mintPrefix(mint),
    name: name || symbol || mintPrefix(mint),
    source: 'jupiter',
  };
}

/**
 * Resolve symbol + name for a mint. Cached; concurrent calls share one request.
 */
export async function resolveTokenMeta(
  mint: string,
  hint?: { symbol?: string; name?: string }
): Promise<TokenMeta> {
  if (!mint) return fallbackMeta('');

  const cached = cache.get(mint);
  if (cached && cached.source !== 'fallback') return { ...cached, source: 'cache' };

  // If hint already looks like real metadata (not mint prefix), use it
  const hintSymbol = hint?.symbol?.trim();
  const hintName = hint?.name?.trim();
  if (
    hintSymbol &&
    hintName &&
    hintSymbol !== mintPrefix(mint) &&
    !hintSymbol.startsWith(mint.slice(0, 4))
  ) {
    const meta: TokenMeta = {
      mint,
      symbol: hintSymbol,
      name: hintName,
      source: 'cache',
    };
    cache.set(mint, meta);
    return meta;
  }

  if (!isValidMint(mint)) {
    const fb = hintSymbol
      ? {
          mint,
          symbol: hintSymbol,
          name: hintName || hintSymbol,
          source: 'fallback' as const,
        }
      : fallbackMeta(mint);
    cache.set(mint, fb);
    return fb;
  }

  const pending = inflight.get(mint);
  if (pending) return pending;

  const promise = (async (): Promise<TokenMeta> => {
    try {
      const dex = await fromDexScreener(mint);
      if (dex) {
        cache.set(mint, dex);
        return dex;
      }

      const jup = await fromJupiter(mint);
      if (jup) {
        cache.set(mint, jup);
        return jup;
      }
    } catch (err) {
      console.warn(
        `[tokenMeta] Resolve failed for ${mint.slice(0, 8)}…:`,
        err instanceof Error ? err.message : err
      );
    }

    const fb: TokenMeta = hintSymbol
      ? {
          mint,
          symbol: hintSymbol,
          name: hintName || hintSymbol,
          source: 'fallback',
        }
      : fallbackMeta(mint);
    cache.set(mint, fb);
    return fb;
  })();

  inflight.set(mint, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(mint);
  }
}

/** Seed cache when we already know metadata (e.g. from market data / backtest) */
export function cacheTokenMeta(
  mint: string,
  symbol: string,
  name?: string
): TokenMeta {
  const meta: TokenMeta = {
    mint,
    symbol: symbol || mintPrefix(mint),
    name: (name || symbol || mintPrefix(mint)).trim(),
    source: 'cache',
  };
  cache.set(mint, meta);
  return meta;
}

export function getCachedTokenMeta(mint: string): TokenMeta | null {
  return cache.get(mint) ?? null;
}
