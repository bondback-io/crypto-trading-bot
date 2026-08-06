/**
 * Zion ambient nudges — market / trending / weather chat pings.
 * Sibling to zionSupervision; uses appendZionChat + dashboard unread/shake.
 * Never auto-buys; never claims X virality without X_BEARER_TOKEN.
 */

import { config } from './config';
import { logger } from './logger';

const MARKET_MS = 4 * 60 * 60 * 1000;
const TRENDING_MS_MIN = 30 * 60 * 1000;
const TRENDING_MS_MAX = 45 * 60 * 1000;
const WEATHER_MS = 6 * 60 * 60 * 1000;
const CHAT_FLOOD_GAP_MS = 8 * 60 * 1000;

interface NudgeRuntime {
  lastMarketAt: number;
  lastTrendingAt: number;
  lastWeatherAt: number;
  lastAnyChatNudgeAt: number;
  weatherLocaleIdx: number;
}

const runtime: NudgeRuntime = {
  lastMarketAt: 0,
  lastTrendingAt: 0,
  lastWeatherAt: 0,
  lastAnyChatNudgeAt: 0,
  weatherLocaleIdx: 0,
};

let marketTimer: ReturnType<typeof setTimeout> | null = null;
let trendingTimer: ReturnType<typeof setTimeout> | null = null;
let weatherTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

const WEATHER_LOCALES: Array<{
  name: string;
  lat: number;
  lon: number;
  tz: string;
}> = [
  {
    name: 'Sunshine Coast',
    lat: -26.65,
    lon: 153.0667,
    tz: 'Australia/Brisbane',
  },
  { name: 'Auckland', lat: -36.8509, lon: 174.7645, tz: 'Pacific/Auckland' },
  { name: 'New Lynn', lat: -36.907, lon: 174.685, tz: 'Pacific/Auckland' },
  { name: 'Te Kuiti', lat: -38.333, lon: 175.165, tz: 'Pacific/Auckland' },
  { name: 'Matamata', lat: -37.8106, lon: 175.7736, tz: 'Pacific/Auckland' },
  {
    name: 'Sölvesborg',
    lat: 56.052,
    lon: 14.586,
    tz: 'Europe/Stockholm',
  },
];

function ambientCfg(): {
  marketUpdatesEnabled: boolean;
  trendingNudgesEnabled: boolean;
  weatherNudgesEnabled: boolean;
} {
  const a = config.zionAgent?.ambientNudges;
  return {
    marketUpdatesEnabled: a?.marketUpdatesEnabled !== false,
    trendingNudgesEnabled: a?.trendingNudgesEnabled !== false,
    weatherNudgesEnabled: a?.weatherNudgesEnabled !== false,
  };
}

function canPostChat(): boolean {
  return Date.now() - runtime.lastAnyChatNudgeAt >= CHAT_FLOOD_GAP_MS;
}

function postNudge(text: string, kind: string): boolean {
  if (!canPostChat()) return false;
  try {
    const { appendZionChat } =
      require('./zionAgentStore') as typeof import('./zionAgentStore');
    appendZionChat('assistant', text.slice(0, 900));
    runtime.lastAnyChatNudgeAt = Date.now();
    logger.info('Zion', `Ambient nudge: ${kind}`);
    return true;
  } catch (err) {
    console.warn(
      '[zion-nudges] append failed:',
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

function fmtUsd(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1000) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return `$${n.toPrecision(3)}`;
}

function fmtChg(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '';
  return ` (${n >= 0 ? '+' : ''}${n.toFixed(1)}% 24h)`;
}

async function runMarketNudge(): Promise<void> {
  if (!ambientCfg().marketUpdatesEnabled) return;
  if (Date.now() - runtime.lastMarketAt < MARKET_MS - 60_000) return;
  try {
    const { fetchBtcSolBrief } =
      require('./zionDomainKnowledge') as typeof import('./zionDomainKnowledge');
    const brief = await fetchBtcSolBrief();
    if (!brief) return;
    const btc = brief.btc;
    const sol = brief.sol;
    const btcLine = btc
      ? `BTC ${fmtUsd(btc.priceUsd)}${fmtChg(btc.change24hPct)}`
      : null;
    const solLine = sol
      ? `SOL ${fmtUsd(sol.priceUsd)}${fmtChg(sol.change24hPct)}`
      : null;
    if (!btcLine && !solLine) return;
    const tone =
      (sol?.change24hPct ?? 0) >= 2
        ? 'SOL has some bounce — still no auto-trades from this ping.'
        : (sol?.change24hPct ?? 0) <= -2
          ? 'SOL soft on the day — watch risk, not FOMO.'
          : 'Quiet tape — just a pulse check.';
    const text = [
      'Market brief',
      '',
      [btcLine, solLine].filter(Boolean).join(' · '),
      tone,
      '',
      '~ Zion',
    ].join('\n');
    if (postNudge(text, 'market')) {
      runtime.lastMarketAt = Date.now();
    }
  } catch (err) {
    console.warn(
      '[zion-nudges] market failed:',
      err instanceof Error ? err.message : err
    );
  }
}

async function fetchTrendingCandidate(): Promise<{
  symbol: string;
  mint?: string;
  why: string;
  source: string;
} | null> {
  // Prefer Jupiter toptrending when API key available
  try {
    const { fetchJupiterTopTokens, hasJupiterApiKey } =
      require('./jupiterTokens') as typeof import('./jupiterTokens');
    if (hasJupiterApiKey()) {
      const tokens = await fetchJupiterTopTokens('toptrending', '1h', 12);
      const t = (tokens || []).find(
        (x: { id?: string; symbol?: string; name?: string }) => x?.id && x?.symbol
      );
      if (t) {
        return {
          symbol: String(t.symbol || '').toUpperCase(),
          mint: String(t.id),
          why: 'on Jupiter toptrending (1h)',
          source: 'jupiter',
        };
      }
    }
  } catch {
    /* try dex */
  }

  try {
    const res = await fetch(
      'https://api.dexscreener.com/token-boosts/top/v1',
      {
        headers: { Accept: 'application/json' },
        signal:
          typeof AbortSignal !== 'undefined' &&
          typeof AbortSignal.timeout === 'function'
            ? AbortSignal.timeout(10_000)
            : undefined,
      }
    );
    if (res.ok) {
      const data = (await res.json()) as Array<{
        chainId?: string;
        tokenAddress?: string;
        description?: string;
      }>;
      const sol = (Array.isArray(data) ? data : []).find(
        (x) => x.chainId === 'solana' && x.tokenAddress
      );
      if (sol) {
        return {
          symbol: String(sol.tokenAddress).slice(0, 6),
          mint: String(sol.tokenAddress),
          why: 'DexScreener boost / attention',
          source: 'dexscreener',
        };
      }
    }
  } catch {
    /* try scanner */
  }

  try {
    const { getScannerFeed } =
      require('./marketScanner') as typeof import('./marketScanner');
    const feed = getScannerFeed?.(8) || [];
    const cand = feed[0] as
      | {
          symbol?: string;
          mint?: string;
          reasons?: string[];
          skipReason?: string;
        }
      | undefined;
    if (cand?.symbol || cand?.mint) {
      return {
        symbol: String(cand.symbol || cand.mint?.slice(0, 6) || '?'),
        mint: cand.mint,
        why: String(
          (cand.reasons && cand.reasons[0]) ||
            cand.skipReason ||
            'scanner attention'
        ),
        source: 'scanner',
      };
    }
  } catch {
    /* */
  }
  return null;
}

async function runTrendingNudge(): Promise<void> {
  if (!ambientCfg().trendingNudgesEnabled) return;
  const gap =
    TRENDING_MS_MIN +
    Math.floor(Math.random() * (TRENDING_MS_MAX - TRENDING_MS_MIN));
  if (Date.now() - runtime.lastTrendingAt < gap - 60_000) return;
  try {
    const cand = await fetchTrendingCandidate();
    if (!cand) return;
    const hasX = Boolean(
      String(process.env.X_BEARER_TOKEN || process.env.TWITTER_BEARER_TOKEN || '').trim()
    );
    const lines = [
      'Trending attention (info only — not a buy)',
      '',
      `${cand.symbol}${cand.mint ? ` · ${cand.mint.slice(0, 8)}…` : ''}`,
      `Why: ${cand.why} (${cand.source})`,
    ];
    if (!hasX) {
      lines.push('No X feed configured — not claiming Twitter virality.');
    }
    lines.push('', '~ Zion');
    if (postNudge(lines.join('\n'), 'trending')) {
      runtime.lastTrendingAt = Date.now();
    }
  } catch (err) {
    console.warn(
      '[zion-nudges] trending failed:',
      err instanceof Error ? err.message : err
    );
  }
}

function localTimeIn(tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-AU', {
      timeZone: tz,
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(new Date());
  } catch {
    return new Date().toUTCString();
  }
}

async function fetchWeatherLine(loc: (typeof WEATHER_LOCALES)[0]): Promise<string> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,weather_code&timezone=${encodeURIComponent(loc.tz)}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal:
        typeof AbortSignal !== 'undefined' &&
        typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(10_000)
          : undefined,
    });
    if (!res.ok) {
      return `${loc.name}: ${localTimeIn(loc.tz)} (weather n/a)`;
    }
    const data = (await res.json()) as {
      current?: { temperature_2m?: number; weather_code?: number };
    };
    const temp = data.current?.temperature_2m;
    const code = data.current?.weather_code;
    const sky =
      code == null
        ? ''
        : code === 0
          ? 'clear'
          : code <= 3
            ? 'partly cloudy'
            : code <= 67
              ? 'rainy'
              : code <= 77
                ? 'snowy'
                : 'stormy';
    const tempS =
      temp != null && Number.isFinite(temp) ? `${Math.round(temp)}°C` : '—';
    return `${loc.name}: ${localTimeIn(loc.tz)} · ${tempS}${sky ? ` ${sky}` : ''}`;
  } catch {
    return `${loc.name}: ${localTimeIn(loc.tz)} (weather n/a)`;
  }
}

async function runWeatherNudge(): Promise<void> {
  if (!ambientCfg().weatherNudgesEnabled) return;
  if (Date.now() - runtime.lastWeatherAt < WEATHER_MS - 60_000) return;
  try {
    // Soft enhancement: prefer ephemeral device location when Dad has shared it
    let deviceLine: string | null = null;
    try {
      const {
        getLastZionLocation,
        getLastZionTimeZone,
        getWeather,
      } = require('./zionLifestyle') as typeof import('./zionLifestyle');
      const last = getLastZionLocation();
      if (
        last &&
        last.source === 'device' &&
        Number.isFinite(last.lat) &&
        Date.now() - (last.at || 0) < 3 * 60 * 60 * 1000
      ) {
        const w = await getWeather(
          last.lat,
          last.lon,
          getLastZionTimeZone()
        );
        if (w.ok) {
          deviceLine = `Your area (device): ${localTimeIn(getLastZionTimeZone() || 'Australia/Brisbane')} · ${w.line}`;
        }
      }
    } catch {
      /* optional */
    }

    const idx = runtime.weatherLocaleIdx % WEATHER_LOCALES.length;
    runtime.weatherLocaleIdx = idx + 1;
    // Rotate 2 locales per nudge for compact family coverage
    const a = WEATHER_LOCALES[idx];
    const b = WEATHER_LOCALES[(idx + 1) % WEATHER_LOCALES.length];
    const [lineA, lineB] = await Promise.all([
      fetchWeatherLine(a),
      fetchWeatherLine(b),
    ]);
    const text = [
      'Family local weather / time',
      '',
      ...(deviceLine ? [deviceLine, ''] : []),
      lineA,
      lineB,
      '',
      '~ Zion',
    ].join('\n');
    if (postNudge(text, 'weather')) {
      runtime.lastWeatherAt = Date.now();
    }
  } catch (err) {
    console.warn(
      '[zion-nudges] weather failed:',
      err instanceof Error ? err.message : err
    );
  }
}

function scheduleMarket(): void {
  if (marketTimer) clearTimeout(marketTimer);
  marketTimer = setTimeout(() => {
    void runMarketNudge().finally(() => scheduleMarket());
  }, MARKET_MS);
}

function scheduleTrending(): void {
  if (trendingTimer) clearTimeout(trendingTimer);
  const gap =
    TRENDING_MS_MIN +
    Math.floor(Math.random() * (TRENDING_MS_MAX - TRENDING_MS_MIN));
  trendingTimer = setTimeout(() => {
    void runTrendingNudge().finally(() => scheduleTrending());
  }, gap);
}

function scheduleWeather(): void {
  if (weatherTimer) clearTimeout(weatherTimer);
  weatherTimer = setTimeout(() => {
    void runWeatherNudge().finally(() => scheduleWeather());
  }, WEATHER_MS);
}

export function getZionAmbientNudgeStatus(): {
  marketUpdatesEnabled: boolean;
  trendingNudgesEnabled: boolean;
  weatherNudgesEnabled: boolean;
  lastMarketAt: number;
  lastTrendingAt: number;
  lastWeatherAt: number;
} {
  const c = ambientCfg();
  return {
    ...c,
    lastMarketAt: runtime.lastMarketAt,
    lastTrendingAt: runtime.lastTrendingAt,
    lastWeatherAt: runtime.lastWeatherAt,
  };
}

export function startZionAmbientNudgeScheduler(): void {
  if (started) return;
  started = true;
  // Stagger first runs so boot isn't a spam burst
  setTimeout(() => {
    void runMarketNudge();
  }, 90_000);
  setTimeout(() => {
    void runTrendingNudge();
  }, 180_000);
  setTimeout(() => {
    void runWeatherNudge();
  }, 240_000);
  scheduleMarket();
  scheduleTrending();
  scheduleWeather();
  logger.info('Zion', 'Ambient nudge scheduler started');
}

export function stopZionAmbientNudgeScheduler(): void {
  started = false;
  if (marketTimer) clearTimeout(marketTimer);
  if (trendingTimer) clearTimeout(trendingTimer);
  if (weatherTimer) clearTimeout(weatherTimer);
  marketTimer = null;
  trendingTimer = null;
  weatherTimer = null;
}
