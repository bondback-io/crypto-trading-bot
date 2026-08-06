/**
 * Zion domain knowledge — curated crypto/Solana curriculum + live top-coin refresh.
 * DATA_DIR/zion-domain-knowledge.json. Fail soft; never invent prices.
 */

import { atomicWriteJson, dataFile, ensureDataDir, readJsonFile } from './dataDir';

const FILE = 'zion-domain-knowledge.json';
const REFRESH_MS = 6 * 60 * 60 * 1000;

export interface ZionDomainCoin {
  symbol: string;
  name: string;
  rank?: number;
  priceUsd?: number;
  change24hPct?: number;
}

export interface ZionDomainKnowledge {
  version: 1;
  updatedAt: number;
  lastRefreshAt: number;
  topCoins: ZionDomainCoin[];
  curriculum: {
    majors: string[];
    exchanges: string[];
    solanaStack: string[];
    tradingApps: string[];
    txNotes: string[];
  };
}

let cache: ZionDomainKnowledge | null = null;

function seededCurriculum(): ZionDomainKnowledge['curriculum'] {
  return {
    majors: [
      'BTC',
      'ETH',
      'SOL',
      'BNB',
      'XRP',
      'ADA',
      'DOGE',
      'AVAX',
      'DOT',
      'LINK',
      'TRX',
      'POL (MATIC)',
      'TON',
      'SHIB',
      'LTC',
      'BCH',
      'NEAR',
      'UNI',
      'APT',
      'ATOM',
    ],
    exchanges: [
      'Binance',
      'Coinbase',
      'Bybit',
      'OKX',
      'Kraken',
      'Bitget',
      'KuCoin',
      'Gate',
      'MEXC',
      'Crypto.com',
      'Jupiter (Solana DEX aggregator)',
      'Raydium',
      'Orca',
    ],
    solanaStack: [
      'pump.fun — memecoin launch / bonding curve',
      'GMGN — Solana memecoin analytics / smart money',
      'Jupiter — swap aggregator + trending tokens API',
      'Phantom — primary Solana wallet',
      'Birdeye — Solana token charts / liquidity',
      'DexScreener — multi-chain pair discovery',
      'TradingView — charting (price action)',
      'Magic Eden / Tensor — Solana NFTs (high level)',
      'Solflare — alternate Solana wallet',
    ],
    tradingApps: [
      'Phantom',
      'Solflare',
      'Jupiter',
      'Raydium',
      'pump.fun',
      'GMGN',
      'Birdeye',
      'DexScreener',
      'TradingView',
    ],
    txNotes: [
      'SOL transfers need enough balance for amount + fee; rent-exempt min ~0.001–0.002 SOL on empty accounts.',
      'SPL tokens need an Associated Token Account (ATA); first receive can fail if ATA missing / empty rent.',
      'Confirmations: wait for commitment; failed txs often wrong mint, insufficient SOL, or phishing approve.',
      'Zion can explain and run whitelist transfers only via password path — never invent balances or addresses.',
      'Never invent live prices — use the domain snapshot / bot context pack.',
    ],
  };
}

function empty(): ZionDomainKnowledge {
  return {
    version: 1,
    updatedAt: Date.now(),
    lastRefreshAt: 0,
    topCoins: [
      { symbol: 'BTC', name: 'Bitcoin', rank: 1 },
      { symbol: 'ETH', name: 'Ethereum', rank: 2 },
      { symbol: 'SOL', name: 'Solana', rank: 3 },
      { symbol: 'BNB', name: 'BNB', rank: 4 },
      { symbol: 'XRP', name: 'XRP', rank: 5 },
    ],
    curriculum: seededCurriculum(),
  };
}

function path(): string {
  ensureDataDir();
  return dataFile(FILE);
}

function save(state: ZionDomainKnowledge): void {
  state.updatedAt = Date.now();
  cache = state;
  try {
    atomicWriteJson(path(), state);
  } catch (err) {
    console.warn(
      '[zion-domain] persist failed:',
      err instanceof Error ? err.message : err
    );
  }
}

export function loadZionDomainKnowledge(): ZionDomainKnowledge {
  if (cache) return cache;
  const parsed = readJsonFile<Partial<ZionDomainKnowledge>>(path());
  if (parsed?.version === 1) {
    cache = {
      ...empty(),
      ...parsed,
      version: 1,
      curriculum: {
        ...seededCurriculum(),
        ...(parsed.curriculum || {}),
      },
      topCoins: Array.isArray(parsed.topCoins) ? parsed.topCoins : empty().topCoins,
    };
    return cache;
  }
  const seeded = empty();
  save(seeded);
  return seeded;
}

/** Compact digest for LLM prompt (prices only when present from live refresh). */
export function formatDomainKnowledgeForPrompt(maxChars = 1400): string {
  const d = loadZionDomainKnowledge();
  const lines: string[] = [
    'Domain knowledge (crypto / Solana — do not invent prices beyond live snapshot):',
    `Majors: ${d.curriculum.majors.slice(0, 20).join(', ')}.`,
    `Exchanges: ${d.curriculum.exchanges.slice(0, 12).join(', ')}.`,
    'Solana stack:',
    ...d.curriculum.solanaStack.slice(0, 8).map((s) => `  - ${s}`),
    'Tx notes:',
    ...d.curriculum.txNotes.slice(0, 4).map((s) => `  - ${s}`),
  ];
  if (d.topCoins.length) {
    const ageH =
      d.lastRefreshAt > 0
        ? Math.round((Date.now() - d.lastRefreshAt) / 3_600_000)
        : null;
    lines.push(
      `Live top coins${ageH != null ? ` (~${ageH}h old)` : ''} (prefer these over guesses):`
    );
    for (const c of d.topCoins.slice(0, 12)) {
      const price =
        c.priceUsd != null && Number.isFinite(c.priceUsd)
          ? ` $${c.priceUsd < 1 ? c.priceUsd.toPrecision(3) : c.priceUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
          : '';
      const ch =
        c.change24hPct != null && Number.isFinite(c.change24hPct)
          ? ` 24h ${c.change24hPct >= 0 ? '+' : ''}${c.change24hPct.toFixed(1)}%`
          : '';
      lines.push(
        `  #${c.rank ?? '?'} ${c.symbol}${price}${ch}`
      );
    }
  }
  let out = lines.join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars - 1) + '…';
  return out;
}

async function fetchCoinGeckoTop(): Promise<ZionDomainCoin[] | null> {
  try {
    const url =
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=25&page=1&sparkline=false&price_change_percentage=24h';
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal:
        typeof AbortSignal !== 'undefined' &&
        typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(12_000)
          : undefined,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{
      symbol?: string;
      name?: string;
      market_cap_rank?: number;
      current_price?: number;
      price_change_percentage_24h?: number;
    }>;
    if (!Array.isArray(data) || !data.length) return null;
    return data.slice(0, 25).map((c, i) => ({
      symbol: String(c.symbol || '').toUpperCase(),
      name: String(c.name || ''),
      rank: Number(c.market_cap_rank) || i + 1,
      priceUsd:
        typeof c.current_price === 'number' ? c.current_price : undefined,
      change24hPct:
        typeof c.price_change_percentage_24h === 'number'
          ? c.price_change_percentage_24h
          : undefined,
    }));
  } catch {
    return null;
  }
}

async function fetchDexBtcSol(): Promise<ZionDomainCoin[] | null> {
  try {
    const url =
      'https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112';
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal:
        typeof AbortSignal !== 'undefined' &&
        typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(10_000)
          : undefined,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      pairs?: Array<{
        priceUsd?: string;
        priceChange?: { h24?: number };
        baseToken?: { symbol?: string };
      }>;
    };
    const pair = (data.pairs || [])[0];
    if (!pair) return null;
    const price = Number(pair.priceUsd);
    return [
      {
        symbol: 'SOL',
        name: 'Solana',
        rank: 3,
        priceUsd: Number.isFinite(price) ? price : undefined,
        change24hPct:
          typeof pair.priceChange?.h24 === 'number'
            ? pair.priceChange.h24
            : undefined,
      },
    ];
  } catch {
    return null;
  }
}

/** Refresh top coins from CoinGecko (fallback DexScreener SOL). Fail soft. */
export async function refreshZionDomainKnowledge(force = false): Promise<{
  ok: boolean;
  source: string;
  count: number;
}> {
  const st = loadZionDomainKnowledge();
  if (
    !force &&
    st.lastRefreshAt > 0 &&
    Date.now() - st.lastRefreshAt < REFRESH_MS
  ) {
    return { ok: true, source: 'cached', count: st.topCoins.length };
  }
  const cg = await fetchCoinGeckoTop();
  if (cg?.length) {
    st.topCoins = cg;
    st.lastRefreshAt = Date.now();
    st.curriculum = seededCurriculum();
    save(st);
    return { ok: true, source: 'coingecko', count: cg.length };
  }
  const dex = await fetchDexBtcSol();
  if (dex?.length) {
    const bySym = new Map(st.topCoins.map((c) => [c.symbol, c]));
    for (const c of dex) bySym.set(c.symbol, { ...bySym.get(c.symbol), ...c });
    st.topCoins = Array.from(bySym.values()).sort(
      (a, b) => (a.rank || 99) - (b.rank || 99)
    );
    st.lastRefreshAt = Date.now();
    save(st);
    return { ok: true, source: 'dexscreener', count: st.topCoins.length };
  }
  return { ok: false, source: 'none', count: st.topCoins.length };
}

/** BTC + SOL snapshot for market briefs (prefer live domain, else fetch). */
export async function fetchBtcSolBrief(): Promise<{
  btc?: ZionDomainCoin;
  sol?: ZionDomainCoin;
  source: string;
} | null> {
  await refreshZionDomainKnowledge(false);
  const d = loadZionDomainKnowledge();
  const btc = d.topCoins.find((c) => c.symbol === 'BTC');
  const sol = d.topCoins.find((c) => c.symbol === 'SOL');
  if (btc || sol) {
    return {
      btc,
      sol,
      source: d.lastRefreshAt ? 'domain' : 'seed',
    };
  }
  try {
    const url =
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,solana&vs_currencies=usd&include_24hr_change=true';
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal:
        typeof AbortSignal !== 'undefined' &&
        typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(10_000)
          : undefined,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<
      string,
      { usd?: number; usd_24h_change?: number }
    >;
    return {
      btc: {
        symbol: 'BTC',
        name: 'Bitcoin',
        priceUsd: data.bitcoin?.usd,
        change24hPct: data.bitcoin?.usd_24h_change,
      },
      sol: {
        symbol: 'SOL',
        name: 'Solana',
        priceUsd: data.solana?.usd,
        change24hPct: data.solana?.usd_24h_change,
      },
      source: 'coingecko-simple',
    };
  } catch {
    return null;
  }
}
