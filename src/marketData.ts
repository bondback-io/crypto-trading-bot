/**
 * Live market data for paper simulation / backtesting.
 * Pulls recent Pump.fun / PumpSwap style launches from DexScreener + GMGN,
 * with synthetic fallbacks when APIs are unavailable.
 */

import { gmgnRequest } from './gmgn';
import { logger, errorToMeta, loggedFetch } from './logger';

export interface MarketCandle {
  /** Unix ms */
  time: number;
  /** Price in SOL per token (approx) */
  priceSol: number;
}

export interface LaunchEvent {
  mint: string;
  symbol: string;
  name: string;
  /** Approx launch / first-seen time */
  launchedAt: number;
  /** Whether this looks post-migration */
  migrated: boolean;
  /** Entry price hint (SOL) */
  entryPriceSol: number;
  /** Current / last price (SOL) */
  lastPriceSol: number;
  /** Price change % over available window */
  priceChangePct: number;
  liquidityUsd?: number;
  volumeUsd?: number;
  /**
   * Circulating market cap USD at lastPriceSol (DexScreener snapshot).
   * Scale with price for entry/exit MC — do not treat as entry MC.
   */
  marketCapUsd?: number;
  /** Soft risk heuristic 0–100 (higher = riskier) when anti-rug not run */
  riskScoreHint?: number;
  /** Still on / related to Pump.fun bonding curve */
  isPumpFun?: boolean;
  /** Price path for replay (oldest → newest) */
  candles: MarketCandle[];
  source: 'dexscreener' | 'gmgn' | 'birdeye' | 'synthetic';
  url?: string;
  /** SOL/USD used when this event was built (for PnL $ display) */
  solUsd?: number;
}

function isValidMint(m: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m);
}

/** Infer SOL/USD from a DexScreener pair (priceUsd / priceNative) */
export function solUsdFromPair(pair: Record<string, unknown>): number | undefined {
  const priceUsd = Number(pair.priceUsd ?? 0);
  const priceNative = Number(
    (pair as { priceNative?: string | number }).priceNative ?? 0
  );
  if (priceUsd > 0 && priceNative > 0) {
    const ratio = priceUsd / priceNative;
    if (Number.isFinite(ratio) && ratio > 10 && ratio < 10_000) return ratio;
  }
  return undefined;
}

let cachedSolUsd: { value: number; at: number } | null = null;

/** Live SOL/USD (cached ~5m). Falls back to 150. */
export async function fetchSolUsdPrice(): Promise<number> {
  if (cachedSolUsd && Date.now() - cachedSolUsd.at < 5 * 60_000) {
    return cachedSolUsd.value;
  }
  try {
    const data = await fetchJson(
      'https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112'
    );
    const pairs =
      (data as { pairs?: Record<string, unknown>[] } | null)?.pairs ?? [];
    const usdc = pairs.find((p) => {
      const q = String(
        (p.quoteToken as { symbol?: string } | undefined)?.symbol ?? ''
      ).toUpperCase();
      return q === 'USDC' || q === 'USDT';
    });
    const best = usdc ?? pairs[0];
    const px = Number(best?.priceUsd ?? 0);
    if (px > 10 && px < 10_000) {
      cachedSolUsd = { value: px, at: Date.now() };
      return px;
    }
  } catch {
    /* ignore */
  }
  return cachedSolUsd?.value ?? 150;
}

/** Soft risk 0–100 from liquidity / volume (higher = riskier) */
export function estimateRiskScoreHint(
  liquidityUsd?: number,
  volumeUsd?: number
): number {
  const liq = liquidityUsd ?? 0;
  const vol = volumeUsd ?? 0;
  let score = 35;
  if (liq <= 0) score += 30;
  else if (liq < 3_000) score += 25;
  else if (liq < 10_000) score += 12;
  else if (liq < 20_000) score += 6;
  else if (liq >= 50_000) score -= 12;
  if (vol > 0 && liq > 0 && vol / liq < 0.1) score += 8;
  if (vol >= 50_000) score -= 5;
  if (vol >= 100_000) score -= 5;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Prefer circulating marketCap; fall back to FDV only if MC missing */
function readMarketCapUsd(row: Record<string, unknown>): number | undefined {
  const mc = Number(row.marketCap ?? row.market_cap ?? 0);
  if (Number.isFinite(mc) && mc > 0) return mc;
  const fdv = Number(row.fdv ?? 0);
  if (Number.isFinite(fdv) && fdv > 0) return fdv;
  return undefined;
}

/**
 * Max price multiple allowed when reconstructing a copy-trade path from
 * DexScreener % change. Stops h24 moons (+5000%) from inventing 50–100×
 * entry→exit MC rides inside a ≤90m simulation window.
 */
export const MAX_PATH_PRICE_MULTIPLE = 8;

/** Soft cap when scaling a Dex MC snapshot across prices (guards unit bugs). */
export const MAX_MC_PRICE_RATIO = 20;

export type PriceChangePick = {
  pct: number;
  windowMs: number;
  source: 'm5' | 'h1' | 'h6' | 'h24' | 'none';
};

/**
 * Prefer the shortest non-zero Dex change window so reconstructed entry
 * and path duration stay aligned (avoid h24 % compressed into ~1h).
 */
export function pickPriceChangeForPath(
  pair: Record<string, unknown>
): PriceChangePick {
  const pc = pair.priceChange as
    | { m5?: number; h1?: number; h6?: number; h24?: number }
    | undefined;
  const candidates: Array<{
    source: PriceChangePick['source'];
    pct: number;
    windowMs: number;
  }> = [
    { source: 'm5', pct: Number(pc?.m5), windowMs: 5 * 60_000 },
    { source: 'h1', pct: Number(pc?.h1), windowMs: 60 * 60_000 },
    { source: 'h6', pct: Number(pc?.h6), windowMs: 6 * 60 * 60_000 },
    { source: 'h24', pct: Number(pc?.h24), windowMs: 24 * 60 * 60_000 },
  ];
  for (const c of candidates) {
    if (Number.isFinite(c.pct) && c.pct !== 0) {
      return { pct: c.pct, windowMs: c.windowMs, source: c.source };
    }
  }
  return { pct: 0, windowMs: 60 * 60_000, source: 'none' };
}

/**
 * Reconstruct path-start price from current price + % change, clamped so
 * we never invent absurd copy-trade moons from a 24h Dex %.
 */
export function reconstructEntryPriceSol(
  lastPriceSol: number,
  changePct: number,
  opts?: { maxMultiple?: number; fallbackFactor?: number }
): number {
  const maxMult = opts?.maxMultiple ?? MAX_PATH_PRICE_MULTIPLE;
  const fallback = opts?.fallbackFactor ?? 0.7;
  if (!(lastPriceSol > 0) || !Number.isFinite(lastPriceSol)) return 0;

  // Near -100% would explode entry; treat as invalid
  if (!Number.isFinite(changePct) || changePct <= -95) {
    return lastPriceSol * fallback;
  }

  const denom = 1 + changePct / 100;
  if (!(denom > 0)) return lastPriceSol * fallback;

  let entry = lastPriceSol / denom;
  if (!(entry > 0) || !Number.isFinite(entry)) {
    return lastPriceSol * fallback;
  }

  const lo = lastPriceSol / maxMult;
  const hi = lastPriceSol * maxMult;
  return Math.min(hi, Math.max(lo, entry));
}

/** Effective % change after clamp (for storage / display). */
export function effectivePriceChangePct(
  entryPriceSol: number,
  lastPriceSol: number
): number {
  if (!(entryPriceSol > 0) || !Number.isFinite(lastPriceSol)) return 0;
  return ((lastPriceSol - entryPriceSol) / entryPriceSol) * 100;
}

/**
 * Scale a reference market cap from refPriceSol → atPriceSol.
 * DexScreener MC is always at the current/last price snapshot.
 */
export function marketCapAtPrice(
  referenceMcUsd: number | undefined,
  referencePriceSol: number,
  atPriceSol: number
): number | undefined {
  if (
    referenceMcUsd == null ||
    !Number.isFinite(referenceMcUsd) ||
    referenceMcUsd <= 0 ||
    !(referencePriceSol > 0) ||
    !Number.isFinite(atPriceSol) ||
    atPriceSol < 0
  ) {
    return undefined;
  }
  const ratio = atPriceSol / referencePriceSol;
  if (!Number.isFinite(ratio) || ratio < 0) return undefined;
  // Clamp pathological ratios (wrong units / tiny ref price) instead of
  // reporting hundreds of millions of exit MC from a bad scale factor.
  const clamped = Math.min(
    MAX_MC_PRICE_RATIO,
    Math.max(1 / MAX_MC_PRICE_RATIO, ratio)
  );
  return referenceMcUsd * clamped;
}

/**
 * Estimate liquidity USD at an earlier/later price from a DexScreener snapshot.
 * Uses sqrt scaling (AMM-like) so early-curve liq isn't overstated vs current pool.
 */
export function liquidityAtPrice(
  referenceLiqUsd: number | undefined,
  referencePriceSol: number,
  atPriceSol: number
): number | undefined {
  if (
    referenceLiqUsd == null ||
    !Number.isFinite(referenceLiqUsd) ||
    referenceLiqUsd <= 0 ||
    !(referencePriceSol > 0) ||
    !Number.isFinite(atPriceSol) ||
    atPriceSol <= 0
  ) {
    return undefined;
  }
  const ratio = atPriceSol / referencePriceSol;
  if (!Number.isFinite(ratio) || ratio <= 0) return undefined;
  const clamped = Math.min(
    MAX_MC_PRICE_RATIO,
    Math.max(1 / MAX_MC_PRICE_RATIO, ratio)
  );
  return referenceLiqUsd * Math.sqrt(Math.max(clamped, 1e-12));
}

/**
 * Memecoin copy trades usually resolve in minutes–~2h.
 * Don't stretch synthetic candles from pairCreated → now (that inflates hold times
 * to many hours for older launches in the lookback window).
 */
export function resolveLaunchPathWindow(opts: {
  launchedAt: number;
  nowMs?: number;
  /** DexScreener change window used for entry reconstruction (h1/h6/h24) */
  changeWindowMs?: number;
  maxPathMs?: number;
  minPathMs?: number;
}): { startMs: number; endMs: number; durationMs: number } {
  const now = opts.nowMs ?? Date.now();
  const startMs = opts.launchedAt > 0 ? opts.launchedAt : now - 30 * 60_000;
  const ageMs = Math.max(0, now - startMs);
  const changeWin = opts.changeWindowMs ?? 6 * 60 * 60 * 1000;
  const maxPath = opts.maxPathMs ?? 90 * 60_000; // 90 minutes
  const minPath = opts.minPathMs ?? 10 * 60_000; // 10 minutes

  let durationMs = Math.min(
    ageMs > 0 ? ageMs : changeWin,
    changeWin,
    maxPath
  );
  if (ageMs > 0 && ageMs < minPath) {
    durationMs = Math.max(3 * 60_000, ageMs);
  } else {
    durationMs = Math.max(minPath, durationMs);
  }
  // Never simulate past "now"
  if (ageMs > 0) durationMs = Math.min(durationMs, ageMs);

  return { startMs, endMs: startMs + durationMs, durationMs };
}

/** Which change % window we used → duration hint for path compression */
export function changeWindowMsFromPair(
  pair: Record<string, unknown>
): number {
  return pickPriceChangeForPath(pair).windowMs;
}

/** Build a realistic candle path from entry → last with bounded noise */
export function buildPricePath(
  entryPriceSol: number,
  lastPriceSol: number,
  startMs: number,
  endMs: number,
  steps = 24
): MarketCandle[] {
  const candles: MarketCandle[] = [];
  const raw = Math.max(0, endMs - startMs);
  // Prefer ≥30s/step so hold times stay realistic; pad short windows lightly
  const duration = Math.max(raw, steps * 30_000);
  const hi = Math.max(entryPriceSol, lastPriceSol);
  const lo = Math.min(entryPriceSol, lastPriceSol);
  // Path magnitude drives local volatility (bigger moves → choppier mid-path)
  const movePct =
    entryPriceSol > 0
      ? Math.abs(lastPriceSol - entryPriceSol) / entryPriceSol
      : 0;
  const vol = Math.min(0.12, 0.03 + movePct * 0.08);
  // Modest room below path low for temporary drawdowns (not free moons)
  const floor = lo * Math.max(0.82, 1 - vol * 1.5);
  const ceiling = hi * Math.min(1.08, 1 + vol * 0.6);

  let px = entryPriceSol;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Geometric (log) blend — more realistic than linear for meme paths
    const logBlend =
      entryPriceSol > 0 && lastPriceSol > 0
        ? Math.exp(
            Math.log(entryPriceSol) * (1 - t) + Math.log(lastPriceSol) * t
          )
        : entryPriceSol + (lastPriceSol - entryPriceSol) * t;
    // Mean-revert noise toward the blend; occasional dump-then-recover
    const shock =
      1 +
      Math.sin(i * 2.1 + movePct * 3) * vol * 0.7 +
      (Math.random() - 0.5) * vol * 1.2;
    const dump =
      i > steps * 0.25 &&
      i < steps * 0.55 &&
      Math.random() < 0.22 + movePct * 0.15
        ? 0.88 + Math.random() * 0.07
        : 1;
    // Pull previous price toward blend (prevents random walk exploding)
    const target = logBlend * shock * dump;
    px = px * 0.35 + target * 0.65;
    px = Math.min(ceiling, Math.max(floor, px));
    candles.push({
      time: startMs + duration * t,
      priceSol: px,
    });
  }

  candles[0].priceSol = entryPriceSol;
  candles[0].time = startMs;
  candles[candles.length - 1].priceSol = lastPriceSol;
  candles[candles.length - 1].time = startMs + duration;
  return candles;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Fetch JSON with retries + backoff (fixes transient "failed to fetch") */
async function fetchJson(
  url: string,
  timeoutMs = 12_000,
  maxAttempts = 3
): Promise<unknown | null> {
  const context = url.includes('dexscreener')
    ? 'DexScreener'
    : url.includes('gmgn')
      ? 'GMGN'
      : 'MarketData';
  let lastErr = '';
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await loggedFetch(url, {
        context,
        label: 'marketData',
        timeoutMs,
        attempt: attempt + 1,
        maxAttempts,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'solana-smart-copy-bot/1.0',
        },
      });
      if (res.status === 429) {
        lastErr = '429';
        logger.warn(context, 'rate limited — retrying', {
          attempt: attempt + 1,
          url: url.slice(0, 120),
        });
        await sleep(1_500 * (attempt + 1) + Math.random() * 500);
        continue;
      }
      if (res.status >= 500) {
        lastErr = `HTTP ${res.status}`;
        await sleep(400 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        return null;
      }
      return await res.json();
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      logger.error(context, 'fetch attempt failed', {
        attempt: attempt + 1,
        maxAttempts,
        url: url.slice(0, 120),
        ...errorToMeta(err),
      });
      await sleep(300 * (attempt + 1) + Math.random() * 200);
    }
  }
  if (lastErr) {
    logger.warn(context, 'fetch exhausted', {
      url: url.slice(0, 120),
      lastErr,
      maxAttempts,
    });
  }
  return null;
}

/** Run async work with limited concurrency */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R | null>
): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      const result = await fn(items[idx]);
      if (result != null) out.push(result);
    }
  }
  const n = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

/** DexScreener — recent Solana pairs that look like pump / pumpswap */
async function fetchFromDexScreener(
  fromMs: number,
  toMs: number
): Promise<LaunchEvent[]> {
  const endpoints = [
    'https://api.dexscreener.com/token-boosts/latest/v1',
    'https://api.dexscreener.com/token-profiles/latest/v1',
  ];

  const events: LaunchEvent[] = [];
  const seen = new Set<string>();

  for (const url of endpoints) {
    const data = await fetchJson(url);
    if (!data || !Array.isArray(data)) continue;

    for (const row of data as Record<string, unknown>[]) {
      const chain = String(row.chainId ?? row.chain ?? '');
      if (chain && chain !== 'solana') continue;

      const tokenAddress = String(row.tokenAddress ?? row.address ?? '');
      if (!isValidMint(tokenAddress) || seen.has(tokenAddress)) continue;

      // Fetch pair details
      const pairData = await fetchJson(
        `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`
      );
      const pairs =
        (pairData as { pairs?: Record<string, unknown>[] } | null)?.pairs ?? [];
      if (!Array.isArray(pairs) || pairs.length === 0) continue;

      const solPairs = pairs.filter(
        (p) =>
          String(p.chainId) === 'solana' &&
          (String(p.dexId).toLowerCase().includes('pump') ||
            String(p.url ?? '').includes('pump') ||
            Number(p.liquidity && (p.liquidity as { usd?: number }).usd) < 500_000)
      );

      // Prefer deepest SOL pool (avoids stale bonding-curve pair MC)
      const ranked = (solPairs.length ? solPairs : pairs).slice().sort((a, b) => {
        const la = Number(
          (a.liquidity as { usd?: number } | undefined)?.usd ?? 0
        );
        const lb = Number(
          (b.liquidity as { usd?: number } | undefined)?.usd ?? 0
        );
        return lb - la;
      });
      const pair = ranked[0] as Record<string, unknown>;
      if (!pair) continue;

      const createdAt = Number(pair.pairCreatedAt ?? Date.now());
      if (createdAt < fromMs || createdAt > toMs) continue;

      const priceUsd = Number(pair.priceUsd ?? 0);
      const solFromPair = solUsdFromPair(pair as Record<string, unknown>);
      const solUsd = solFromPair ?? 150;
      const priceNative = Number(
        (pair as { priceNative?: string }).priceNative ?? priceUsd / solUsd
      );
      if (!priceNative || priceNative <= 0) continue;

      const picked = pickPriceChangeForPath(pair as Record<string, unknown>);
      const entry = reconstructEntryPriceSol(priceNative, picked.pct);
      const change = effectivePriceChangePct(entry, priceNative);
      const symbol = String(
        (pair.baseToken as { symbol?: string } | undefined)?.symbol ??
          tokenAddress.slice(0, 6)
      );
      const name = String(
        (pair.baseToken as { name?: string } | undefined)?.name ?? symbol
      );
      const dexId = String(pair.dexId ?? '').toLowerCase();
      const migrated = dexId.includes('pump') === false || dexId.includes('pumpswap');
      const pathWin = resolveLaunchPathWindow({
        launchedAt: createdAt,
        nowMs: Math.min(toMs, Date.now()),
        changeWindowMs: picked.windowMs,
      });

      seen.add(tokenAddress);
      events.push({
        mint: tokenAddress,
        symbol,
        name,
        launchedAt: createdAt,
        migrated: Boolean(migrated || dexId.includes('raydium')),
        entryPriceSol: entry > 0 ? entry : priceNative * 0.7,
        lastPriceSol: priceNative,
        priceChangePct: change,
        liquidityUsd: Number(
          (pair.liquidity as { usd?: number } | undefined)?.usd ?? 0
        ) || undefined,
        volumeUsd: Number(
          (pair.volume as { h24?: number } | undefined)?.h24 ?? 0
        ) || undefined,
        marketCapUsd: readMarketCapUsd(pair as Record<string, unknown>),
        riskScoreHint: estimateRiskScoreHint(
          Number((pair.liquidity as { usd?: number } | undefined)?.usd ?? 0) ||
            undefined,
          Number((pair.volume as { h24?: number } | undefined)?.h24 ?? 0) ||
            undefined
        ),
        isPumpFun:
          dexId.includes('pump') ||
          String(pair.url ?? '').includes('pump.fun'),
        candles: buildPricePath(
          entry > 0 ? entry : priceNative * 0.7,
          priceNative,
          pathWin.startMs,
          pathWin.endMs,
          24
        ),
        source: 'dexscreener',
        url: String(pair.url ?? ''),
        solUsd,
      });

      if (events.length >= 60) break;
    }
    if (events.length >= 60) break;
  }

  // Always search pump/solana pairs to widen the pool (boosts alone are thin)
  {
    const queries = [
      'pump%20solana',
      'pumpswap',
      'raydium%20solana',
    ];
    for (const q of queries) {
      if (events.length >= 60) break;
      const search = await fetchJson(
        `https://api.dexscreener.com/latest/dex/search?q=${q}`
      );
      const pairs =
        (search as { pairs?: Record<string, unknown>[] } | null)?.pairs ?? [];
      for (const pair of pairs.slice(0, 40)) {
        if (String(pair.chainId) !== 'solana') continue;
        const mint = String(
          (pair.baseToken as { address?: string } | undefined)?.address ?? ''
        );
        if (!isValidMint(mint) || seen.has(mint)) continue;

        const createdAt = Number(pair.pairCreatedAt ?? 0);
        if (!createdAt || createdAt < fromMs || createdAt > toMs) continue;

        const priceNative = Number(
          (pair as { priceNative?: string }).priceNative ?? 0
        );
        if (priceNative <= 0) continue;

        const picked = pickPriceChangeForPath(pair);
        const entry = reconstructEntryPriceSol(priceNative, picked.pct, {
          fallbackFactor: 0.6,
        });
        const change = effectivePriceChangePct(entry, priceNative);
        const symbol = String(
          (pair.baseToken as { symbol?: string } | undefined)?.symbol ??
            mint.slice(0, 6)
        );
        const name = String(
          (pair.baseToken as { name?: string } | undefined)?.name ?? symbol
        );
        const solUsd = solUsdFromPair(pair) ?? 150;
        const pathWin = resolveLaunchPathWindow({
          launchedAt: createdAt,
          nowMs: Math.min(toMs, Date.now()),
          changeWindowMs: picked.windowMs,
        });
        const liqUsd =
          Number(
            (pair.liquidity as { usd?: number } | undefined)?.usd ?? 0
          ) || undefined;
        const volUsd =
          Number((pair.volume as { h24?: number } | undefined)?.h24 ?? 0) ||
          undefined;

        seen.add(mint);
        events.push({
          mint,
          symbol,
          name,
          launchedAt: createdAt,
          migrated: String(pair.dexId).toLowerCase().includes('raydium'),
          entryPriceSol: entry > 0 ? entry : priceNative * 0.6,
          lastPriceSol: priceNative,
          priceChangePct: change,
          liquidityUsd: liqUsd,
          volumeUsd: volUsd,
          marketCapUsd: readMarketCapUsd(pair as Record<string, unknown>),
          riskScoreHint: estimateRiskScoreHint(liqUsd, volUsd),
          isPumpFun:
            String(pair.dexId ?? '')
              .toLowerCase()
              .includes('pump') ||
            String(pair.url ?? '').includes('pump.fun'),
          candles: buildPricePath(
            entry > 0 ? entry : priceNative * 0.6,
            priceNative,
            pathWin.startMs,
            pathWin.endMs,
            36
          ),
          source: 'dexscreener',
          url: String(pair.url ?? ''),
          solUsd,
        });
        if (events.length >= 60) break;
      }
    }
  }

  console.log(`[marketData] DexScreener: ${events.length} launch(es) in window`);
  return events;
}

/** GMGN-style new pairs via authenticated client + path fallbacks */
async function fetchFromGmgn(
  fromMs: number,
  toMs: number
): Promise<LaunchEvent[]> {
  const paths = [
    '/defi/quotation/v1/pairs/sol/new_pairs?limit=50&orderby=open_timestamp&direction=desc',
    '/defi/quotation/v1/rank/sol/pump/1h?orderby=progress&direction=desc',
    '/v1/pairs/sol/new_pairs?limit=50&orderby=open_timestamp&direction=desc',
  ];

  const events: LaunchEvent[] = [];

  for (const path of paths) {
    const res = await gmgnRequest(path, 15_000);
    if (!res.ok || !res.data) {
      if (res.error) {
        console.warn(`[marketData] GMGN path failed: ${res.error}`);
      }
      continue;
    }

    const data = res.data;
    const list =
      (data as { data?: unknown[] }).data ??
      (data as { data?: { rank?: unknown[] } }).data?.rank ??
      (Array.isArray(data) ? data : []);
    if (!Array.isArray(list)) continue;

    for (const item of list) {
      const row = item as Record<string, unknown>;
      const mint = String(
        row.address ?? row.base_address ?? row.token_address ?? ''
      );
      if (!isValidMint(mint)) continue;

      const openTs = Number(row.open_timestamp ?? row.created_timestamp ?? 0);
      const launchedAt = openTs < 1e12 ? openTs * 1000 : openTs;
      if (!launchedAt || launchedAt < fromMs || launchedAt > toMs) continue;

      const price = Number(row.price ?? row.price_sol ?? 0);
      if (price <= 0) continue;

      const rawChange = Number(row.price_change_percent ?? row.price_change ?? 0);
      const entry = reconstructEntryPriceSol(price, rawChange);
      const change = effectivePriceChangePct(entry, price);
      const symbol = String(row.symbol ?? mint.slice(0, 6));
      const pathWin = resolveLaunchPathWindow({
        launchedAt,
        nowMs: Math.min(toMs, Date.now()),
        changeWindowMs: 60 * 60_000,
      });

      events.push({
        mint,
        symbol,
        name: String(row.name ?? symbol),
        launchedAt,
        migrated: Boolean(row.migrated ?? row.is_migrated),
        entryPriceSol: entry > 0 ? entry : price * 0.7,
        lastPriceSol: price,
        priceChangePct: change,
        liquidityUsd: Number(row.liquidity ?? 0) || undefined,
        volumeUsd: Number(row.volume ?? 0) || undefined,
        marketCapUsd: readMarketCapUsd(row),
        riskScoreHint: estimateRiskScoreHint(
          Number(row.liquidity ?? 0) || undefined,
          Number(row.volume ?? 0) || undefined
        ),
        isPumpFun: !Boolean(row.migrated ?? row.is_migrated),
        candles: buildPricePath(
          entry > 0 ? entry : price * 0.7,
          price,
          pathWin.startMs,
          pathWin.endMs,
          24
        ),
        source: 'gmgn',
        solUsd: 150,
      });
    }

    if (events.length > 0) break;
  }

  console.log(`[marketData] GMGN: ${events.length} launch(es) in window`);
  return events;
}

/** Synthetic memecoin scenarios when live APIs fail */
export function generateSyntheticLaunches(
  fromMs: number,
  toMs: number,
  count = 12
): LaunchEvent[] {
  const events: LaunchEvent[] = [];
  const span = Math.max(toMs - fromMs, 60_000);
  const wallets = ['Cented', 'Theo', 'Decu', 'Unknown'];

  for (let i = 0; i < count; i++) {
    const launchedAt = fromMs + Math.floor((span * (i + 1)) / (count + 1));
    const entry = 1e-8 * (1 + Math.random() * 50);
    // Realistic outcome distribution: many dumps, some moons
    const roll = Math.random();
    let mult: number;
    if (roll < 0.45) mult = 0.2 + Math.random() * 0.5; // rug/dump
    else if (roll < 0.7) mult = 0.8 + Math.random() * 0.4; // flat
    else if (roll < 0.9) mult = 1.5 + Math.random() * 2; // 50–250%
    else mult = 3 + Math.random() * 8; // moon

    const last = entry * mult;
    const mint = `SynthMint${String(i).padStart(2, '0')}${String(launchedAt).slice(-20)}`.slice(0, 44);
    // Synthetic holds: 15–90 minutes typical for memecoin sims
    const holdMs = (15 + Math.random() * 75) * 60_000;

    events.push({
      mint,
      symbol: `SYN${i}`,
      name: `Synthetic ${wallets[i % wallets.length]} #${i}`,
      launchedAt,
      migrated: Math.random() > 0.4,
      entryPriceSol: entry,
      lastPriceSol: last,
      priceChangePct: (mult - 1) * 100,
      liquidityUsd: 5_000 + Math.random() * 40_000,
      volumeUsd: 2_000 + Math.random() * 80_000,
      marketCapUsd: 20_000 + Math.random() * 500_000,
      riskScoreHint: Math.round(25 + Math.random() * 50),
      isPumpFun: Math.random() > 0.35,
      candles: buildPricePath(entry, last, launchedAt, launchedAt + holdMs, 24),
      source: 'synthetic',
      solUsd: 150,
    });
  }

  console.log(`[marketData] Synthetic: ${events.length} scenario(s)`);
  return events;
}

export interface FetchLaunchesOptions {
  fromMs?: number;
  toMs?: number;
  /** Prefer live APIs; fall back to synthetic */
  allowSynthetic?: boolean;
  maxResults?: number;
}

/** Fetch recent launches/migrations for the given window */
export async function fetchRecentLaunches(
  options: FetchLaunchesOptions = {}
): Promise<{ events: LaunchEvent[]; source: string }> {
  const toMs = options.toMs ?? Date.now();
  const fromMs = options.fromMs ?? toMs - 24 * 60 * 60 * 1000;
  const allowSynthetic = options.allowSynthetic !== false;
  const maxResults = options.maxResults ?? 60;

  console.log(
    `[marketData] Fetching launches ${new Date(fromMs).toISOString()} → ${new Date(toMs).toISOString()}`
  );

  let events: LaunchEvent[] = [];
  const sources: string[] = [];

  try {
    const dex = await fetchFromDexScreener(fromMs, toMs);
    if (dex.length > 0) {
      events = dex;
      sources.push('dexscreener');
    }
  } catch (err) {
    console.warn('[marketData] DexScreener failed:', err);
  }

  // Always try GMGN to widen coverage (not only when Dex is nearly empty)
  try {
    const gmgn = await fetchFromGmgn(fromMs, toMs);
    if (gmgn.length > 0) {
      const seen = new Set(events.map((e) => e.mint));
      let added = 0;
      for (const e of gmgn) {
        if (!seen.has(e.mint)) {
          events.push(e);
          seen.add(e.mint);
          added += 1;
        }
      }
      if (added > 0) sources.push('gmgn');
    }
  } catch (err) {
    console.warn('[marketData] GMGN failed:', err);
  }

  // Optional Birdeye trending enrichment
  try {
    const { hasBirdeyeKey, getTrendingTokens } = await import('./birdeye');
    if (hasBirdeyeKey()) {
      const trend = await getTrendingTokens(30, { interval: '1h' });
      if (trend.tokens.length > 0) {
        const seen = new Set(events.map((e) => e.mint));
        let added = 0;
        for (const t of trend.tokens) {
          const mint = String(t.mint || '');
          if (!isValidMint(mint) || seen.has(mint)) continue;
          const launchedAt =
            Number(t.liquidityUsd || 0) > 0 ? toMs - 60 * 60_000 : 0;
          // Only keep if we can get a Dex pair in window
          const snap = await fetchJson(
            `https://api.dexscreener.com/latest/dex/tokens/${mint}`
          );
          const pairs =
            (snap as { pairs?: Record<string, unknown>[] } | null)?.pairs ?? [];
          const sol = pairs.find((p) => String(p.chainId) === 'solana');
          if (!sol) continue;
          const createdAt = Number(sol.pairCreatedAt ?? 0);
          if (!createdAt || createdAt < fromMs || createdAt > toMs) continue;
          const priceNative = Number(
            (sol as { priceNative?: string }).priceNative ?? 0
          );
          if (!(priceNative > 0)) continue;
          const picked = pickPriceChangeForPath(sol);
          const entry = reconstructEntryPriceSol(priceNative, picked.pct);
          const pathWin = resolveLaunchPathWindow({
            launchedAt: createdAt,
            nowMs: Math.min(toMs, Date.now()),
            changeWindowMs: picked.windowMs,
          });
          const liqUsd =
            Number(
              (sol.liquidity as { usd?: number } | undefined)?.usd ?? 0
            ) || undefined;
          const volUsd =
            Number((sol.volume as { h24?: number } | undefined)?.h24 ?? 0) ||
            undefined;
          seen.add(mint);
          events.push({
            mint,
            symbol: String(t.symbol || mint.slice(0, 6)),
            name: String(t.name || t.symbol || mint.slice(0, 6)),
            launchedAt: createdAt || launchedAt,
            migrated: String(sol.dexId ?? '')
              .toLowerCase()
              .includes('raydium'),
            entryPriceSol: entry > 0 ? entry : priceNative * 0.7,
            lastPriceSol: priceNative,
            priceChangePct: effectivePriceChangePct(entry, priceNative),
            liquidityUsd: liqUsd,
            volumeUsd: volUsd,
            marketCapUsd: readMarketCapUsd(sol),
            riskScoreHint: estimateRiskScoreHint(liqUsd, volUsd),
            isPumpFun: String(sol.dexId ?? '')
              .toLowerCase()
              .includes('pump'),
            candles: buildPricePath(
              entry > 0 ? entry : priceNative * 0.7,
              priceNative,
              pathWin.startMs,
              pathWin.endMs,
              36
            ),
            source: 'birdeye',
            url: String(sol.url ?? ''),
            solUsd: solUsdFromPair(sol) ?? 150,
          });
          added += 1;
          if (added >= 20) break;
        }
        if (added > 0) sources.push('birdeye');
      }
    }
  } catch (err) {
    console.warn('[marketData] Birdeye trending enrich failed:', err);
  }

  // Pad with synthetic when live pool is thin (not only when empty)
  if (allowSynthetic && events.length < Math.min(maxResults, 12)) {
    const need = Math.min(maxResults, 20) - events.length;
    if (need > 0) {
      const synth = generateSyntheticLaunches(fromMs, toMs, need);
      events.push(...synth);
      sources.push('synthetic');
    }
  }

  if (events.length === 0 && allowSynthetic) {
    events = generateSyntheticLaunches(fromMs, toMs, 16);
    sources.push('synthetic');
  }

  const source = sources.length > 0 ? sources.join('+') : 'none';
  events.sort((a, b) => a.launchedAt - b.launchedAt);
  console.log(
    `[marketData] Launch pool: ${events.length} event(s) from ${source}`
  );
  return { events: events.slice(0, maxResults), source };
}

/** Apply live last-price to an open mint (for live paper mode) */
export async function fetchLivePriceSol(mint: string): Promise<number | null> {
  const snap = await fetchLiveTokenSnapshot(mint);
  return snap?.priceSol ?? null;
}

/**
 * DexScreener snapshot: price + market cap for an open/minted token.
 * Picks the deepest Solana pool; MC prefers circulating over FDV.
 */
export async function fetchLiveTokenSnapshot(
  mint: string
): Promise<{ priceSol: number | null; marketCapUsd: number | null } | null> {
  if (!isValidMint(mint)) return null;
  const data = await fetchJson(
    `https://api.dexscreener.com/latest/dex/tokens/${mint}`
  );
  const pairs =
    (data as { pairs?: Record<string, unknown>[] } | null)?.pairs ?? [];
  const solPairs = pairs.filter((p) => String(p.chainId) === 'solana');
  if (solPairs.length === 0) return null;

  let best = solPairs[0];
  let bestLiq = Number(
    (best.liquidity as { usd?: number } | undefined)?.usd ??
      best.liquidityUsd ??
      0
  );
  for (const p of solPairs) {
    const liq = Number(
      (p.liquidity as { usd?: number } | undefined)?.usd ?? p.liquidityUsd ?? 0
    );
    if (liq > bestLiq) {
      best = p;
      bestLiq = liq;
    }
  }

  const priceNative = Number(
    (best as { priceNative?: string }).priceNative ?? 0
  );
  const marketCapUsd = readMarketCapUsd(best) ?? null;
  return {
    priceSol: priceNative > 0 ? priceNative : null,
    marketCapUsd: marketCapUsd != null && marketCapUsd > 0 ? marketCapUsd : null,
  };
}

/** Fetch symbol + name for a mint from DexScreener (best-effort) */
export async function fetchTokenInfo(
  mint: string
): Promise<{ symbol: string; name: string } | null> {
  if (!isValidMint(mint)) return null;
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
    symbol: symbol || name,
    name: name || symbol,
  };
}
