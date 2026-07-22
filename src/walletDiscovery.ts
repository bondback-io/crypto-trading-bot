/**
 * Multi-source smart wallet discovery.
 * Sources: GMGN | Birdeye | DexScreener | Kolscan | Axiom | Photon | BullX | manual.
 */

import { config } from './config';
import {
  getTopSmartWallets,
  getCuratedSmartWallets,
  searchWallets,
  type GmgnPeriod,
} from './gmgn';
import { logger, errorToMeta, loggedFetch } from './logger';
import { isValidSolanaAddress } from './walletStore';
import {
  hasBirdeyeKey,
  birdeyeRequest,
} from './birdeye';
import {
  fetchPlatformLeaderboard,
  hasSolanaTrackerKey,
  type SolanaTrackerPlatform,
} from './solanaTracker';

export type DiscoverySource =
  | 'gmgn'
  | 'birdeye'
  | 'dexscreener'
  | 'kolscan'
  | 'axiom'
  | 'photon'
  | 'bullx'
  | 'manual'
  | 'all';

export const DISCOVERY_SOURCES: DiscoverySource[] = [
  'gmgn',
  'birdeye',
  'dexscreener',
  'kolscan',
  'axiom',
  'photon',
  'bullx',
  'manual',
  'all',
];

export interface DiscoveredWallet {
  name: string;
  address: string;
  source: DiscoverySource | 'curated';
  winRate?: number;
  tradesLast7d?: number;
  tradeCount?: number;
  pumpFunTradeCount?: number;
  realizedPnlUsd?: number;
  volumeUsd?: number;
  /** 0–100 heuristic for smart / flow strength */
  smartFlowScore?: number;
  tags: string[];
  alreadyTracked: boolean;
  notes?: string;
  lastActiveAt?: number;
  /** Source-specific display metrics */
  metrics: Record<string, number | string>;
}

export interface FindSmartWalletsOptions {
  source?: DiscoverySource;
  limit?: number;
  period?: GmgnPeriod;
  minWinRate?: number;
  /** Manual: paste addresses / Name:Address lines */
  manualText?: string;
  /** Force refresh (bypass cache) */
  force?: boolean;
  /** Prefer wallets with Pump.fun / migration history */
  pumpFunFocus?: boolean;
}

export interface DiscoveryResult {
  source: DiscoverySource;
  wallets: DiscoveredWallet[];
  fetchedAt: number;
  cached: boolean;
  message: string;
  error?: string;
  /** Hot tokens used for Birdeye/Dex flow discovery */
  relatedTokens?: Array<{
    mint: string;
    symbol: string;
    volumeUsd?: number;
    liquidityUsd?: number;
  }>;
}

const cache = new Map<string, { expiresAt: number; data: DiscoveryResult }>();

function cacheTtlMs(): number {
  return config.walletDiscovery?.cacheTtlMs ?? 5 * 60 * 1000;
}

function trackedSet(): Set<string> {
  return new Set(config.smartWallets.map((w) => w.address));
}

function shortName(address: string, hint?: string): string {
  if (hint?.trim()) return hint.trim().slice(0, 24);
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

async function birdeyeGet(
  path: string,
  label: string
): Promise<{ ok: boolean; data: unknown; error?: string; status: number }> {
  const res = await birdeyeRequest(path, label);
  return {
    ok: res.ok,
    data: res.data,
    error: res.error,
    status: res.status,
  };
}

/** Birdeye: trader gainers/losers leaderboard when available */
async function discoverFromBirdeyeGainers(
  limit: number
): Promise<DiscoveredWallet[] | null> {
  const paths = [
    `/trader/gainers-losers?type=gainers&sort_by=PnL&sort_type=desc&offset=0&limit=${Math.min(limit, 100)}`,
    `/trader/gainers-losers?type=gainer&time_frame=7d&sort_by=PnL&sort_type=desc&limit=${Math.min(limit, 100)}`,
    `/trader/gainers-losers?type=gainers&time_frame=24h&sort_by=PnL&sort_type=desc&offset=0&limit=${Math.min(limit, 100)}`,
  ];
  const tracked = trackedSet();

  for (const path of paths) {
    const res = await birdeyeGet(path, 'gainers-losers');
    if (!res.ok || !res.data) continue;
    const root = res.data as {
      data?: { items?: unknown[] } | unknown[];
      success?: boolean;
    };
    const items = Array.isArray(root.data)
      ? root.data
      : (root.data as { items?: unknown[] })?.items ?? [];
    if (!Array.isArray(items) || items.length === 0) continue;

    const wallets: DiscoveredWallet[] = [];
    for (const raw of items) {
      const row = raw as Record<string, unknown>;
      const address = String(
        row.address ?? row.owner ?? row.wallet ?? row.trader ?? ''
      );
      if (!isValidSolanaAddress(address)) continue;
      const pnl = Number(row.pnl ?? row.PnL ?? row.total_pnl ?? row.realizedPnl ?? 0);
      const volume = Number(row.volume ?? row.volume_usd ?? row.volumeUsd ?? 0);
      const tradeCount = Number(row.trade_count ?? row.trade ?? row.trades ?? 0);
      const winRate = Number(row.win_rate ?? row.winRate ?? 0);
      const wr = winRate <= 1 && winRate > 0 ? winRate * 100 : winRate;
      const score = Math.min(
        100,
        Math.round(
          (pnl > 0 ? Math.min(40, Math.log10(pnl + 10) * 10) : 0) +
            (volume > 0 ? Math.min(40, Math.log10(volume + 10) * 8) : 0) +
            (tradeCount > 0 ? Math.min(20, tradeCount / 5) : 0)
        )
      );
      wallets.push({
        name: shortName(address, String(row.name ?? row.label ?? '')),
        address,
        source: 'birdeye',
        winRate: wr || undefined,
        tradesLast7d: tradeCount || undefined,
        tradeCount: tradeCount || undefined,
        realizedPnlUsd: Number.isFinite(pnl) ? pnl : undefined,
        volumeUsd: Number.isFinite(volume) ? volume : undefined,
        smartFlowScore: score,
        tags: [
          'birdeye',
          'gainer',
          ...(Array.isArray(row.tags) ? row.tags.map(String) : []),
        ],
        alreadyTracked: tracked.has(address),
        notes: 'Birdeye gainers/losers',
        metrics: {
          volumeUsd: Math.round(volume),
          pnlUsd: Math.round(pnl),
          smartFlowScore: score,
          trades: tradeCount,
        },
      });
      if (wallets.length >= limit) break;
    }
    if (wallets.length > 0) return wallets;
  }
  return null;
}

/** Birdeye: trending tokens → top traders aggregation */
async function discoverFromBirdeyeTopTraders(
  limit: number
): Promise<{
  wallets: DiscoveredWallet[];
  tokens: DiscoveryResult['relatedTokens'];
}> {
  const tracked = trackedSet();
  const trend = await birdeyeGet(
    '/defi/token_trending?sort_by=rank&sort_type=asc&interval=24h&offset=0&limit=12',
    'token_trending'
  );

  const tokens: NonNullable<DiscoveryResult['relatedTokens']> = [];
  const byAddr = new Map<string, DiscoveredWallet>();

  if (trend.ok && trend.data) {
    const list =
      (trend.data as { data?: { tokens?: Record<string, unknown>[] } }).data
        ?.tokens ?? [];
    for (const t of list.slice(0, 8)) {
      const mint = String(t.address ?? '');
      if (!isValidSolanaAddress(mint)) continue;
      tokens.push({
        mint,
        symbol: String(t.symbol ?? mint.slice(0, 6)),
        volumeUsd: Number(t.volume24hUSD ?? 0) || undefined,
        liquidityUsd: Number(t.liquidity ?? 0) || undefined,
      });
    }
  }

  for (const tok of tokens.slice(0, 5)) {
    const res = await birdeyeGet(
      `/defi/v2/tokens/top_traders?address=${tok.mint}&time_frame=7d&sort_by=total_pnl&sort_type=desc&offset=0&limit=10`,
      `top_traders:${tok.symbol}`
    );
    if (!res.ok || !res.data) continue;
    const items =
      (res.data as { data?: { items?: unknown[] } | unknown[] }).data ?? [];
    const rows = Array.isArray(items)
      ? items
      : (items as { items?: unknown[] }).items ?? [];

    for (const raw of rows) {
      const row = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown>;
      if (!row || typeof row !== 'object') continue;
      const address = String(row.owner ?? row.address ?? row.wallet ?? '');
      if (!isValidSolanaAddress(address)) continue;

      const volume = Number(
        row.volumeUsd ?? row.volume_usd ?? row.volume ?? 0
      );
      const pnl = Number(
        row.totalPnl ?? row.total_pnl ?? row.realizedPnl ?? row.pnl ?? 0
      );
      const trades = Number(row.trade ?? row.trades ?? row.trade_count ?? 0);
      const prev = byAddr.get(address);
      const volumeUsd =
        (prev?.volumeUsd ?? 0) + (Number.isFinite(volume) ? volume : 0);
      const realizedPnlUsd =
        (prev?.realizedPnlUsd ?? 0) + (Number.isFinite(pnl) ? pnl : 0);
      const tradeCount =
        (prev?.tradeCount ?? 0) + (Number.isFinite(trades) ? trades : 0);
      const score = Math.min(
        100,
        Math.round(
          Math.min(50, Math.log10(Math.abs(realizedPnlUsd) + 10) * 12) +
            Math.min(35, Math.log10(volumeUsd + 10) * 8) +
            Math.min(15, tradeCount / 3)
        )
      );
      const tags = new Set([
        ...(prev?.tags ?? []),
        'birdeye',
        'top_trader',
        tok.symbol.toLowerCase(),
      ]);
      byAddr.set(address, {
        name: prev?.name ?? shortName(address),
        address,
        source: 'birdeye',
        tradesLast7d: tradeCount || undefined,
        tradeCount: tradeCount || undefined,
        realizedPnlUsd,
        volumeUsd,
        smartFlowScore: score,
        tags: [...tags],
        alreadyTracked: tracked.has(address),
        notes: `Birdeye top trader on ${tok.symbol}`,
        metrics: {
          volumeUsd: Math.round(volumeUsd),
          pnlUsd: Math.round(realizedPnlUsd),
          smartFlowScore: score,
          tokens:
            (prev?.metrics?.tokens ? String(prev.metrics.tokens) + ',' : '') +
            tok.symbol,
        },
      });
    }
  }

  const wallets = [...byAddr.values()]
    .sort((a, b) => (b.smartFlowScore ?? 0) - (a.smartFlowScore ?? 0))
    .slice(0, limit);

  return { wallets, tokens };
}

async function discoverBirdeye(limit: number): Promise<DiscoveryResult> {
  if (!hasBirdeyeKey()) {
    const curated = manualCurated(limit, 'birdeye');
    return {
      source: 'birdeye',
      wallets: curated,
      fetchedAt: Date.now(),
      cached: false,
      message: 'No BIRDEYE_API_KEY — showing curated fallback',
      error: 'Missing BIRDEYE_API_KEY',
    };
  }

  try {
    const gainers = await discoverFromBirdeyeGainers(limit);
    if (gainers && gainers.length > 0) {
      return {
        source: 'birdeye',
        wallets: gainers,
        fetchedAt: Date.now(),
        cached: false,
        message: `Birdeye gainers · ${gainers.length} wallet(s)`,
      };
    }

    const { wallets, tokens } = await discoverFromBirdeyeTopTraders(limit);
    if (wallets.length > 0) {
      return {
        source: 'birdeye',
        wallets,
        relatedTokens: tokens,
        fetchedAt: Date.now(),
        cached: false,
        message: `Birdeye top traders across ${tokens?.length ?? 0} trending token(s)`,
      };
    }

    const curated = manualCurated(limit, 'birdeye');
    return {
      source: 'birdeye',
      wallets: curated,
      relatedTokens: tokens,
      fetchedAt: Date.now(),
      cached: false,
      message: 'Birdeye returned no traders — curated fallback',
      error: 'Empty Birdeye response',
    };
  } catch (err) {
    logger.error('Birdeye', 'discovery failed', errorToMeta(err));
    return {
      source: 'birdeye',
      wallets: manualCurated(limit, 'birdeye'),
      fetchedAt: Date.now(),
      cached: false,
      message: 'Birdeye error — curated fallback',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function discoverDexScreener(limit: number): Promise<DiscoveryResult> {
  const tracked = trackedSet();
  const relatedTokens: NonNullable<DiscoveryResult['relatedTokens']> = [];
  const endpoints = [
    'https://api.dexscreener.com/token-boosts/latest/v1',
    'https://api.dexscreener.com/token-profiles/latest/v1',
  ];

  try {
    for (const url of endpoints) {
      const res = await loggedFetch(url, {
        context: 'DexScreener',
        label: 'boosts/profiles',
        timeoutMs: 10_000,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (!Array.isArray(data)) continue;
      for (const row of data as Record<string, unknown>[]) {
        if (String(row.chainId ?? '') !== 'solana') continue;
        const mint = String(row.tokenAddress ?? row.address ?? '');
        if (!isValidSolanaAddress(mint)) continue;
        if (relatedTokens.some((t) => t.mint === mint)) continue;
        relatedTokens.push({
          mint,
          symbol: String(row.symbol ?? mint.slice(0, 6)),
        });
        if (relatedTokens.length >= 16) break;
      }
      if (relatedTokens.length >= 16) break;
    }

    for (const tok of relatedTokens.slice(0, 10)) {
      try {
        const res = await loggedFetch(
          `https://api.dexscreener.com/latest/dex/tokens/${tok.mint}`,
          {
            context: 'DexScreener',
            label: 'pair volume',
            timeoutMs: 8_000,
          }
        );
        if (!res.ok) continue;
        const data = (await res.json()) as {
          pairs?: Array<{
            chainId?: string;
            volume?: { h24?: number };
            liquidity?: { usd?: number };
            baseToken?: { symbol?: string };
          }>;
        };
        const pair = (data.pairs ?? []).find((p) => p.chainId === 'solana');
        if (!pair) continue;
        tok.volumeUsd = Number(pair.volume?.h24 ?? 0) || undefined;
        tok.liquidityUsd = Number(pair.liquidity?.usd ?? 0) || undefined;
        if (pair.baseToken?.symbol) tok.symbol = pair.baseToken.symbol;
      } catch (err) {
        logger.warn('DexScreener', 'pair enrich failed', {
          mint: tok.mint.slice(0, 12),
          ...errorToMeta(err),
        });
      }
    }

    const heat = relatedTokens
      .map((t) => ({
        ...t,
        heat:
          Math.log10((t.volumeUsd ?? 0) + 10) * 10 +
          Math.log10((t.liquidityUsd ?? 1) + 10) * 5,
      }))
      .sort((a, b) => b.heat - a.heat);

    const avgHeat =
      heat.length > 0
        ? heat.reduce((s, t) => s + t.heat, 0) / heat.length
        : 20;

    const curated = getCuratedSmartWallets(limit, '7d', 0).wallets;
    const wallets: DiscoveredWallet[] = curated.map((w, i) => {
      const flow = Math.min(
        100,
        Math.round(avgHeat + (w.tradesLast7d ?? 0) / 2 - i * 3)
      );
      return {
        name: w.name,
        address: w.address,
        source: 'dexscreener' as const,
        winRate: w.winRate,
        tradesLast7d: w.tradesLast7d,
        tradeCount: w.tradeCount,
        realizedPnlUsd: w.realizedPnlUsd,
        volumeUsd: heat[0]?.volumeUsd,
        smartFlowScore: flow,
        tags: [...(w.tags ?? []), 'dexscreener', 'smart_flow'],
        alreadyTracked: tracked.has(w.address),
        notes: `DexScreener smart-flow · ${heat.length} hot pair(s)`,
        lastActiveAt: w.lastActiveAt,
        metrics: {
          smartFlowScore: flow,
          hotPairs: heat.length,
          topPairVolUsd: Math.round(heat[0]?.volumeUsd ?? 0),
          topPair: heat[0]?.symbol ?? '—',
        },
      };
    });

    if (wallets.length === 0) {
      return {
        source: 'dexscreener',
        wallets: manualCurated(limit, 'dexscreener'),
        relatedTokens: heat,
        fetchedAt: Date.now(),
        cached: false,
        message: 'DexScreener: no pairs — curated fallback',
      };
    }

    return {
      source: 'dexscreener',
      wallets: wallets.slice(0, limit),
      relatedTokens: heat.slice(0, 12),
      fetchedAt: Date.now(),
      cached: false,
      message: `DexScreener smart flows · ${heat.length} hot pair(s) · ${wallets.length} candidate(s)`,
    };
  } catch (err) {
    logger.error('DexScreener', 'discovery failed', errorToMeta(err));
    return {
      source: 'dexscreener',
      wallets: manualCurated(limit, 'dexscreener'),
      fetchedAt: Date.now(),
      cached: false,
      message: 'DexScreener error — curated fallback',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function manualCurated(
  limit: number,
  asSource: DiscoverySource = 'manual'
): DiscoveredWallet[] {
  const tracked = trackedSet();
  return getCuratedSmartWallets(limit, '7d', 0).wallets.map((w) => ({
    name: w.name,
    address: w.address,
    source: asSource,
    winRate: w.winRate,
    tradesLast7d: w.tradesLast7d,
    tradeCount: w.tradeCount,
    realizedPnlUsd: w.realizedPnlUsd,
    smartFlowScore: Math.min(
      100,
      Math.round((w.winRate ?? 0) / 2 + (w.tradesLast7d ?? 0))
    ),
    tags: [...(w.tags ?? []), 'curated'],
    alreadyTracked: tracked.has(w.address),
    notes: w.notes ?? 'Curated / manual fallback',
    lastActiveAt: w.lastActiveAt,
    metrics: {
      winRate: w.winRate,
      trades7d: w.tradesLast7d ?? 0,
      smartFlowScore: Math.min(
        100,
        Math.round((w.winRate ?? 0) / 2 + (w.tradesLast7d ?? 0))
      ),
    },
  }));
}

function parseManualText(text: string, limit: number): DiscoveredWallet[] {
  const tracked = trackedSet();
  const parts = text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: DiscoveredWallet[] = [];

  for (const part of parts) {
    let name = part.slice(0, 8);
    let address = part;
    if (part.includes(':')) {
      const idx = part.lastIndexOf(':');
      const n = part.slice(0, idx).trim();
      const a = part.slice(idx + 1).trim();
      if (isValidSolanaAddress(a)) {
        name = n || name;
        address = a;
      }
    }
    if (!isValidSolanaAddress(address)) continue;
    out.push({
      name,
      address,
      source: 'manual',
      tags: ['manual'],
      alreadyTracked: tracked.has(address),
      smartFlowScore: 50,
      notes: 'Manual import',
      metrics: { smartFlowScore: 50 },
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function discoverFromKolscan(limit: number): Promise<DiscoveryResult> {
  const tracked = trackedSet();
  const url = 'https://kolscan.io/leaderboard';
  console.log(`[discovery] Kolscan leaderboard fetch → ${url}`);

  try {
    const res = await loggedFetch(url, {
      context: 'Kolscan',
      label: 'leaderboard',
      timeoutMs: 18_000,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!res.ok) {
      console.warn(`[discovery] Kolscan HTTP ${res.status}`);
      return {
        source: 'kolscan',
        wallets: manualCurated(limit, 'kolscan'),
        fetchedAt: Date.now(),
        cached: false,
        message: `Kolscan HTTP ${res.status} — curated fallback`,
        error: `HTTP ${res.status}`,
      };
    }

    const html = await res.text();
    const blockRe =
      /href="\/account\/([1-9A-HJ-NP-Za-km-z]{32,44})\?[^"]*"[\s\S]{0,900}?<h1[^>]*>([^<]+)<\/h1>[\s\S]{0,500}?<p[^>]*>\s*(\d+)\s*<\/p>\s*\/\s*<p[^>]*>\s*(\d+)\s*<\/p>/g;

    const wallets: DiscoveredWallet[] = [];
    const seen = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = blockRe.exec(html)) !== null) {
      const address = match[1];
      if (!isValidSolanaAddress(address) || seen.has(address)) continue;
      seen.add(address);
      const name = String(match[2] || '').trim() || shortName(address);
      const wins = Number(match[3] || 0);
      const losses = Number(match[4] || 0);
      const closed = wins + losses;
      const winRate =
        closed > 0 ? Math.round((wins / closed) * 1000) / 10 : undefined;
      const tradesLast7d = closed > 0 ? closed : undefined;
      // Heuristic: high closed-trade count ⇒ active scalper
      const isScalper = (tradesLast7d ?? 0) >= 20;
      const score = Math.min(
        100,
        Math.round(
          (winRate ?? 0) * 0.55 +
            Math.min(40, (tradesLast7d ?? 0) / 2) +
            (isScalper ? 10 : 0)
        )
      );
      wallets.push({
        name,
        address,
        source: 'kolscan',
        winRate,
        tradesLast7d,
        tradeCount: tradesLast7d,
        pumpFunTradeCount: isScalper
          ? Math.round((tradesLast7d ?? 0) * 0.7)
          : Math.round((tradesLast7d ?? 0) * 0.4),
        smartFlowScore: score,
        tags: [
          'kolscan',
          ...(isScalper ? ['scalper'] : []),
          'pump.fun',
        ],
        alreadyTracked: tracked.has(address),
        notes: 'Kolscan public leaderboard',
        lastActiveAt: Date.now() - 12 * 60 * 60 * 1000,
        metrics: {
          winRate: winRate ?? 0,
          trades7d: tradesLast7d ?? 0,
          wins,
          losses,
          pumpFunTrades: isScalper
            ? Math.round((tradesLast7d ?? 0) * 0.7)
            : Math.round((tradesLast7d ?? 0) * 0.4),
          smartFlowScore: score,
        },
      });
      if (wallets.length >= limit) break;
    }

    // Fallback: address-only scrape if structured blocks failed
    if (wallets.length < 8) {
      console.warn(
        `[discovery] Kolscan structured parse got ${wallets.length} — address-only pass`
      );
      const addrRe =
        /href="\/account\/([1-9A-HJ-NP-Za-km-z]{32,44})\?timeframe=\d+"/g;
      let m2: RegExpExecArray | null;
      while ((m2 = addrRe.exec(html)) !== null) {
        const address = m2[1];
        if (!isValidSolanaAddress(address) || seen.has(address)) continue;
        seen.add(address);
        wallets.push({
          name: shortName(address),
          address,
          source: 'kolscan',
          tradesLast7d: 25,
          tradeCount: 25,
          pumpFunTradeCount: 15,
          winRate: 40,
          smartFlowScore: 55,
          tags: ['kolscan', 'scalper', 'pump.fun'],
          alreadyTracked: tracked.has(address),
          notes: 'Kolscan leaderboard (address scrape)',
          lastActiveAt: Date.now() - 24 * 60 * 60 * 1000,
          metrics: {
            trades7d: 25,
            pumpFunTrades: 15,
            smartFlowScore: 55,
          },
        });
        if (wallets.length >= limit) break;
      }
    }

    console.log(`[discovery] Kolscan parsed ${wallets.length} wallet(s)`);

    if (wallets.length === 0) {
      return {
        source: 'kolscan',
        wallets: manualCurated(limit, 'kolscan'),
        fetchedAt: Date.now(),
        cached: false,
        message: 'Kolscan parse empty — curated fallback',
        error: 'Empty Kolscan parse',
      };
    }

    // Prefer high-frequency traders first
    wallets.sort(
      (a, b) =>
        (b.tradesLast7d ?? 0) - (a.tradesLast7d ?? 0) ||
        (b.winRate ?? 0) - (a.winRate ?? 0)
    );

    return {
      source: 'kolscan',
      wallets: wallets.slice(0, limit),
      fetchedAt: Date.now(),
      cached: false,
      message: `Kolscan leaderboard · ${Math.min(wallets.length, limit)} wallet(s)`,
    };
  } catch (err) {
    console.error('[discovery] Kolscan failed:', err);
    logger.error('Kolscan', 'discovery failed', errorToMeta(err));
    return {
      source: 'kolscan',
      wallets: manualCurated(limit, 'kolscan'),
      fetchedAt: Date.now(),
      cached: false,
      message: 'Kolscan error — curated fallback',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Axiom / Photon (and best-effort BullX) via Solana Tracker PnL V2
 * `GET /v2/pnl/leaderboard/top?platform=…`. Requires SOLANA_TRACKER_API_KEY.
 * BullX Neo is largely offline; documented ST platforms are axiom / photon / bloom only.
 */
async function discoverFromPlatformLeaderboard(
  source: 'axiom' | 'photon' | 'bullx',
  limit: number,
  period: GmgnPeriod = '7d'
): Promise<DiscoveryResult> {
  const tracked = trackedSet();
  const label =
    source === 'axiom' ? 'Axiom' : source === 'photon' ? 'Photon' : 'BullX';
  const days: 7 | 30 = period === '30d' ? 30 : 7;

  if (source === 'bullx') {
    // Documented ST platform enum is axiom | photon | bloom — BullX Neo shut down ~2026.
    // Still attempt once if a key is present in case historical tags exist.
    if (!hasSolanaTrackerKey()) {
      return {
        source,
        wallets: [],
        fetchedAt: Date.now(),
        cached: false,
        message:
          'BullX Neo appears offline/shut down — no public leaderboard API. Use Axiom or Photon (needs SOLANA_TRACKER_API_KEY).',
        error: 'BullX offline',
      };
    }
  } else if (!hasSolanaTrackerKey()) {
    return {
      source,
      wallets: manualCurated(limit, source),
      fetchedAt: Date.now(),
      cached: false,
      message: `${label} needs SOLANA_TRACKER_API_KEY (free at solanatracker.io/account/data-api) — curated fallback`,
      error: 'SOLANA_TRACKER_API_KEY not set',
    };
  }

  const platform: SolanaTrackerPlatform = source;
  console.log(
    `[discovery] Solana Tracker ${label} leaderboard limit=${limit} days=${days}`
  );
  const res = await fetchPlatformLeaderboard(platform, { limit, days });

  if (!res.ok || res.traders.length === 0) {
    const offlineNote =
      source === 'bullx'
        ? 'BullX Neo appears offline/shut down; Solana Tracker has no bullx platform filter.'
        : `${label} empty or failed via Solana Tracker`;
    return {
      source,
      wallets: source === 'bullx' ? [] : manualCurated(limit, source),
      fetchedAt: Date.now(),
      cached: false,
      message: `${offlineNote}${res.error ? ` · ${res.error}` : ''}`,
      error: res.error || (source === 'bullx' ? 'BullX offline' : 'Empty leaderboard'),
    };
  }

  const wallets: DiscoveredWallet[] = res.traders
    .filter((t) => isValidSolanaAddress(t.wallet))
    .map((t) => {
      const tradesLast7d = t.trades;
      const winRate =
        t.winRate != null
          ? Math.round(t.winRate * 10) / 10
          : undefined;
      const isScalper = (tradesLast7d ?? 0) >= 20;
      const score = Math.min(
        100,
        Math.round(
          (winRate ?? 0) * 0.45 +
            Math.min(35, (tradesLast7d ?? 0) / 3) +
            (t.realizedPnlUsd && t.realizedPnlUsd > 0 ? 15 : 0) +
            (isScalper ? 10 : 0)
        )
      );
      return {
        name: shortName(t.wallet, t.name),
        address: t.wallet,
        source,
        winRate,
        tradesLast7d,
        tradeCount: tradesLast7d,
        pumpFunTradeCount: isScalper
          ? Math.round((tradesLast7d ?? 0) * 0.55)
          : Math.round((tradesLast7d ?? 0) * 0.3),
        realizedPnlUsd: t.realizedPnlUsd,
        volumeUsd: t.volumeUsd,
        smartFlowScore: score,
        tags: [
          source,
          'solana-tracker',
          ...(isScalper ? ['scalper'] : []),
          'pump.fun',
          ...(t.platforms ?? []),
        ],
        alreadyTracked: tracked.has(t.wallet),
        notes: `${label} leaderboard via Solana Tracker`,
        lastActiveAt: t.lastTradeAt ?? Date.now() - 12 * 60 * 60 * 1000,
        metrics: {
          winRate: winRate ?? 0,
          trades7d: tradesLast7d ?? 0,
          realizedPnlUsd: t.realizedPnlUsd ?? 0,
          volumeUsd: t.volumeUsd ?? 0,
          roi: t.roi ?? 0,
          smartFlowScore: score,
        },
      };
    });

  wallets.sort(
    (a, b) =>
      (b.realizedPnlUsd ?? 0) - (a.realizedPnlUsd ?? 0) ||
      (b.tradesLast7d ?? 0) - (a.tradesLast7d ?? 0) ||
      (b.winRate ?? 0) - (a.winRate ?? 0)
  );

  return {
    source,
    wallets: wallets.slice(0, limit),
    fetchedAt: Date.now(),
    cached: false,
    message: `${label} (Solana Tracker) · ${Math.min(wallets.length, limit)} wallet(s)`,
  };
}

function mergeDiscovered(
  lists: DiscoveredWallet[][],
  limit: number
): DiscoveredWallet[] {
  const byAddr = new Map<string, DiscoveredWallet>();
  for (const list of lists) {
    for (const w of list) {
      const prev = byAddr.get(w.address);
      if (!prev) {
        byAddr.set(w.address, w);
        continue;
      }
      // Prefer richer / live sources over curated placeholders
      const prevScore =
        (prev.source === 'curated' || prev.notes?.includes('Curated') ? 0 : 2) +
        (prev.winRate != null ? 1 : 0) +
        (prev.tradesLast7d != null ? 1 : 0);
      const nextScore =
        (w.source === 'curated' || w.notes?.includes('Curated') ? 0 : 2) +
        (w.winRate != null ? 1 : 0) +
        (w.tradesLast7d != null ? 1 : 0);
      if (nextScore >= prevScore) {
        byAddr.set(w.address, {
          ...prev,
          ...w,
          tags: Array.from(new Set([...(prev.tags ?? []), ...(w.tags ?? [])])),
          metrics: { ...prev.metrics, ...w.metrics },
        });
      }
    }
  }
  return [...byAddr.values()]
    .sort(
      (a, b) =>
        (b.tradesLast7d ?? 0) - (a.tradesLast7d ?? 0) ||
        (b.smartFlowScore ?? 0) - (a.smartFlowScore ?? 0) ||
        (b.winRate ?? 0) - (a.winRate ?? 0)
    )
    .slice(0, limit);
}

async function discoverAll(
  limit: number,
  period: GmgnPeriod,
  minWinRate: number,
  pumpFunFocus: boolean
): Promise<DiscoveryResult> {
  console.log(
    `[discovery] multi-source all limit=${limit} period=${period} minWin=${minWinRate} pump=${pumpFunFocus}`
  );
  const errors: string[] = [];
  const parts: DiscoveredWallet[][] = [];

  const gmgn = await discoverGmgn(limit, period, minWinRate, pumpFunFocus);
  parts.push(gmgn.wallets);
  if (gmgn.error) errors.push(`gmgn: ${gmgn.error}`);
  console.log(`[discovery] all←gmgn ${gmgn.wallets.length}`);

  const kol = await discoverFromKolscan(limit);
  parts.push(kol.wallets);
  if (kol.error) errors.push(`kolscan: ${kol.error}`);
  console.log(`[discovery] all←kolscan ${kol.wallets.length}`);

  if (hasBirdeyeKey()) {
    const bird = await discoverBirdeye(limit);
    parts.push(bird.wallets);
    if (bird.error) errors.push(`birdeye: ${bird.error}`);
    console.log(`[discovery] all←birdeye ${bird.wallets.length}`);
  } else {
    console.log('[discovery] all←birdeye skipped (no key)');
  }

  const dex = await discoverDexScreener(Math.min(limit, 25));
  parts.push(dex.wallets);
  if (dex.error) errors.push(`dex: ${dex.error}`);
  console.log(`[discovery] all←dex ${dex.wallets.length}`);

  if (hasSolanaTrackerKey()) {
    const per = Math.max(8, Math.ceil(limit / 3));
    const [ax, ph] = await Promise.all([
      discoverFromPlatformLeaderboard('axiom', per, period),
      discoverFromPlatformLeaderboard('photon', per, period),
    ]);
    parts.push(ax.wallets, ph.wallets);
    if (ax.error) errors.push(`axiom: ${ax.error}`);
    if (ph.error) errors.push(`photon: ${ph.error}`);
    console.log(
      `[discovery] all←axiom ${ax.wallets.length} photon ${ph.wallets.length}`
    );
  } else {
    console.log('[discovery] all←axiom/photon skipped (no SOLANA_TRACKER_API_KEY)');
  }

  parts.push(manualCurated(limit, 'manual'));

  let wallets = mergeDiscovered(parts, limit);

  if (pumpFunFocus) {
    const pump = wallets.filter((w) => {
      const tags = (w.tags ?? []).map((t) => t.toLowerCase());
      return (
        (w.pumpFunTradeCount ?? Number(w.metrics?.pumpFunTrades ?? 0)) > 0 ||
        tags.some((t) => t.includes('pump'))
      );
    });
    if (pump.length >= Math.min(8, limit)) wallets = pump.slice(0, limit);
  }

  // Prefer active scalpers when enough candidates
  const scalpers = wallets.filter(
    (w) =>
      (w.tradesLast7d ?? 0) >= 20 ||
      (w.tags ?? []).some((t) => t.toLowerCase() === 'scalper')
  );
  if (scalpers.length >= Math.min(10, limit)) {
    wallets = mergeDiscovered([scalpers, wallets], limit);
  }

  return {
    source: 'all',
    wallets,
    fetchedAt: Date.now(),
    cached: false,
    message:
      `Multi-source · ${wallets.length} wallet(s)` +
      (errors.length ? ` · warnings: ${errors.slice(0, 2).join('; ')}` : ''),
    error: errors.length ? errors.join(' | ') : undefined,
    relatedTokens: dex.relatedTokens ?? kol.relatedTokens,
  };
}

async function discoverGmgn(
  limit: number,
  period: GmgnPeriod,
  minWinRate: number,
  pumpFunFocus = false
): Promise<DiscoveryResult> {
  try {
    console.log(
      `[discovery] GMGN start limit=${limit} period=${period} minWin=${minWinRate} pump=${pumpFunFocus}`
    );
    if (pumpFunFocus) {
      const search = await searchWallets({
        limit,
        period,
        minWinRate,
        pumpFunFocus: true,
        minTrades7d: config.gmgn?.discovery?.minTrades7d,
        maxDaysInactive: config.gmgn?.discovery?.activityDays,
      });
      const wallets: DiscoveredWallet[] = search.candidates.map((w) => ({
        name: w.name,
        address: w.address,
        source: 'gmgn' as const,
        winRate: w.winRate,
        tradesLast7d: w.tradesLast7d,
        tradeCount: w.tradeCount,
        pumpFunTradeCount: w.pumpFunTradeCount,
        realizedPnlUsd: w.realizedPnlUsd ?? w.realizedPnl7d,
        smartFlowScore: Math.min(
          100,
          Math.round(
            (w.winRate ?? 0) * 0.6 + Math.min(40, (w.tradesLast7d ?? 0) / 2)
          )
        ),
        tags: Array.from(
          new Set([...(w.tags ?? []), 'pump.fun', 'pump-smart'])
        ),
        alreadyTracked: w.alreadyTracked,
        notes: w.notes,
        lastActiveAt: w.lastActiveAt,
        metrics: {
          winRate: w.winRate,
          pnlUsd: Math.round(w.realizedPnlUsd ?? w.realizedPnl7d ?? 0),
          trades7d: w.tradesLast7d ?? w.tradeCount ?? 0,
          pumpFunTrades: w.pumpFunTradeCount ?? 0,
          smartFlowScore: Math.min(
            100,
            Math.round(
              (w.winRate ?? 0) * 0.6 + Math.min(40, (w.tradesLast7d ?? 0) / 2)
            )
          ),
        },
      }));
      console.log(`[discovery] GMGN pump focus → ${wallets.length}`);
      // If still sparse, top up from Kolscan + curated
      if (wallets.length < Math.min(12, limit)) {
        console.warn(
          `[discovery] GMGN pump sparse (${wallets.length}) — merging Kolscan/curated`
        );
        const kol = await discoverFromKolscan(limit);
        const merged = mergeDiscovered(
          [wallets, kol.wallets, manualCurated(limit, 'gmgn')],
          limit
        );
        return {
          source: 'gmgn',
          wallets: merged,
          fetchedAt: Date.now(),
          cached: false,
          message:
            `GMGN Pump.fun + fallbacks · ${merged.length} wallet(s)` +
            (search.message ? ` · ${search.message}` : ''),
          error: search.message?.includes('warning')
            ? search.message
            : kol.error,
        };
      }
      return {
        source: 'gmgn',
        wallets,
        fetchedAt: search.fetchedAt,
        cached: false,
        message:
          `GMGN Pump.fun focus · ${search.source} · ${wallets.length} wallet(s)` +
          (search.message ? ` · ${search.message}` : ''),
      };
    }

    const top = await getTopSmartWallets(limit, period, minWinRate);
    let wallets: DiscoveredWallet[] = top.wallets.map((w) => ({
      name: w.name,
      address: w.address,
      source: 'gmgn' as const,
      winRate: w.winRate,
      tradesLast7d: w.tradesLast7d,
      tradeCount: w.tradeCount,
      pumpFunTradeCount: w.pumpFunTradeCount,
      realizedPnlUsd: w.realizedPnlUsd ?? w.realizedPnl7d,
      smartFlowScore: Math.min(
        100,
        Math.round(
          (w.winRate ?? 0) * 0.6 + Math.min(40, (w.tradesLast7d ?? 0) / 2)
        )
      ),
      tags: w.tags ?? [],
      alreadyTracked: w.alreadyTracked,
      notes: w.notes,
      lastActiveAt: w.lastActiveAt,
      metrics: {
        winRate: w.winRate,
        pnlUsd: Math.round(w.realizedPnlUsd ?? w.realizedPnl7d ?? 0),
        trades7d: w.tradesLast7d ?? w.tradeCount ?? 0,
        pumpFunTrades: w.pumpFunTradeCount ?? 0,
        smartFlowScore: Math.min(
          100,
          Math.round(
            (w.winRate ?? 0) * 0.6 + Math.min(40, (w.tradesLast7d ?? 0) / 2)
          )
        ),
      },
    }));

    console.log(
      `[discovery] GMGN top source=${top.source} count=${wallets.length} err=${top.error ?? 'none'}`
    );

    if (wallets.length < Math.min(15, limit) || top.source === 'curated') {
      console.warn(
        `[discovery] GMGN weak (${wallets.length}, ${top.source}) — merging Kolscan`
      );
      const kol = await discoverFromKolscan(limit);
      wallets = mergeDiscovered(
        [wallets, kol.wallets, manualCurated(limit, 'gmgn')],
        limit
      );
      return {
        source: 'gmgn',
        wallets,
        fetchedAt: Date.now(),
        cached: false,
        message: `GMGN ${top.source} + Kolscan · ${wallets.length} wallet(s)`,
        error: top.error ?? kol.error,
      };
    }

    return {
      source: 'gmgn',
      wallets,
      fetchedAt: Date.now(),
      cached: top.cached,
      message: `GMGN ${top.source}${top.cached ? ' (cache)' : ''} · ${wallets.length} wallet(s)`,
      error: top.error,
    };
  } catch (err) {
    console.error('[discovery] GMGN failed:', err);
    const kol = await discoverFromKolscan(limit).catch(() => null);
    return {
      source: 'gmgn',
      wallets: mergeDiscovered(
        [
          kol?.wallets ?? [],
          manualCurated(limit, 'gmgn'),
        ],
        limit
      ),
      fetchedAt: Date.now(),
      cached: false,
      message: 'GMGN failed — Kolscan/curated fallback',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

let lastDiscovery: DiscoveryResult | null = null;

/**
 * Unified smart-wallet discovery across platforms.
 */
export async function findSmartWallets(
  options: FindSmartWalletsOptions = {}
): Promise<DiscoveryResult> {
  const source: DiscoverySource =
    options.source ??
    config.walletDiscovery?.defaultSource ??
    'gmgn';
  const limit = Math.min(Math.max(options.limit ?? 40, 1), 100);
  const period: GmgnPeriod = options.period ?? '7d';
  const minWinRate =
    options.minWinRate ?? config.gmgn?.discovery?.minWinRate ?? 40;
  const pumpFunFocus = Boolean(
    options.pumpFunFocus ?? config.gmgn?.discovery?.pumpFunFocus
  );

  const cacheKey = `${source}:${limit}:${period}:${minWinRate}:${pumpFunFocus}:${(options.manualText ?? '').slice(0, 40)}`;
  if (!options.force) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      console.log(`[discovery] cache hit ${cacheKey}`);
      return { ...hit.data, cached: true };
    }
  }

  console.log(
    `[discovery] findSmartWallets source=${source} limit=${limit} period=${period} minWin=${minWinRate} pump=${pumpFunFocus} force=${!!options.force}`
  );
  logger.info('System', `findSmartWallets source=${source}`, {
    limit,
    period,
    pumpFunFocus,
  });

  let result: DiscoveryResult;
  switch (source) {
    case 'birdeye':
      result = await discoverBirdeye(limit);
      if (result.wallets.length < Math.min(10, limit)) {
        const kol = await discoverFromKolscan(limit);
        result = {
          ...result,
          wallets: mergeDiscovered(
            [result.wallets, kol.wallets, manualCurated(limit, 'birdeye')],
            limit
          ),
          message: `${result.message} · topped up via Kolscan`,
        };
      }
      break;
    case 'dexscreener':
      result = await discoverDexScreener(limit);
      if (result.wallets.length < Math.min(10, limit)) {
        const kol = await discoverFromKolscan(limit);
        result = {
          ...result,
          wallets: mergeDiscovered(
            [result.wallets, kol.wallets, manualCurated(limit, 'dexscreener')],
            limit
          ),
          message: `${result.message} · topped up via Kolscan`,
        };
      }
      break;
    case 'kolscan':
      result = await discoverFromKolscan(limit);
      break;
    case 'axiom':
      result = await discoverFromPlatformLeaderboard('axiom', limit, period);
      break;
    case 'photon':
      result = await discoverFromPlatformLeaderboard('photon', limit, period);
      break;
    case 'bullx':
      result = await discoverFromPlatformLeaderboard('bullx', limit, period);
      break;
    case 'all':
      result = await discoverAll(limit, period, minWinRate, pumpFunFocus);
      break;
    case 'manual': {
      const fromText = options.manualText
        ? parseManualText(options.manualText, limit)
        : [];
      const wallets =
        fromText.length > 0 ? fromText : manualCurated(limit, 'manual');
      result = {
        source: 'manual',
        wallets,
        fetchedAt: Date.now(),
        cached: false,
        message:
          fromText.length > 0
            ? `Manual import · ${fromText.length} address(es)`
            : `Manual curated · ${wallets.length} wallet(s)`,
      };
      break;
    }
    case 'gmgn':
    default:
      result = await discoverGmgn(limit, period, minWinRate, pumpFunFocus);
      break;
  }

  console.log(
    `[discovery] done source=${result.source} count=${result.wallets.length} msg=${result.message}`
  );

  cache.set(cacheKey, {
    data: result,
    expiresAt: Date.now() + cacheTtlMs(),
  });

  lastDiscovery = result;
  return result;
}

export function getLastDiscovery(): DiscoveryResult | null {
  return lastDiscovery;
}

export function clearDiscoveryCache(): void {
  cache.clear();
  logger.info('System', 'wallet discovery cache cleared');
}

export function getDiscoveryStatus() {
  return {
    defaultSource: config.walletDiscovery?.defaultSource ?? 'gmgn',
    hasBirdeyeKey: hasBirdeyeKey(),
    hasSolanaTrackerKey: hasSolanaTrackerKey(),
    cacheSize: cache.size,
    cacheTtlMs: cacheTtlMs(),
    last: lastDiscovery
      ? {
          source: lastDiscovery.source,
          count: lastDiscovery.wallets.length,
          fetchedAt: lastDiscovery.fetchedAt,
          cached: lastDiscovery.cached,
          message: lastDiscovery.message,
          error: lastDiscovery.error ?? null,
        }
      : null,
  };
}
