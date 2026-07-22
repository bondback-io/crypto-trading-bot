/**
 * Solana Tracker Data API — platform leaderboards (Axiom / Photon / Bloom).
 * Free tier keys: https://www.solanatracker.io/account/data-api
 */

import { config } from './config';
import { logger, errorToMeta, loggedFetch } from './logger';

export type SolanaTrackerPlatform = 'axiom' | 'photon' | 'bloom' | 'bullx';

export interface SolanaTrackerTrader {
  wallet: string;
  winRate?: number;
  realizedPnlUsd?: number;
  volumeUsd?: number;
  trades?: number;
  tokensTraded?: number;
  roi?: number;
  name?: string;
  lastTradeAt?: number;
  platforms?: string[];
}

export function getSolanaTrackerApiKey(): string {
  return (
    process.env.SOLANA_TRACKER_API_KEY?.trim() ||
    config.solanaTracker?.apiKey?.trim() ||
    ''
  );
}

export function hasSolanaTrackerKey(): boolean {
  return Boolean(getSolanaTrackerApiKey());
}

export function getSolanaTrackerBaseUrl(): string {
  return (
    process.env.SOLANA_TRACKER_BASE_URL?.trim() ||
    config.solanaTracker?.baseUrl ||
    'https://data.solanatracker.io'
  );
}

export function getSolanaTrackerStatus() {
  const hasApiKey = hasSolanaTrackerKey();
  return {
    ok: hasApiKey,
    hasApiKey,
    baseUrl: getSolanaTrackerBaseUrl(),
    /** BullX Neo trading appears shut down; platform filter is not in ST docs. */
    bullxSupported: false,
  };
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseTraders(data: unknown): SolanaTrackerTrader[] {
  const root = data as {
    traders?: unknown[];
    data?: { traders?: unknown[] } | unknown[];
  };
  const list: unknown[] = Array.isArray(root.traders)
    ? root.traders
    : Array.isArray(root.data)
      ? root.data
      : Array.isArray((root.data as { traders?: unknown[] })?.traders)
        ? ((root.data as { traders: unknown[] }).traders)
        : [];

  const out: SolanaTrackerTrader[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const wallet = String(
      row.wallet ?? row.address ?? row.owner ?? ''
    ).trim();
    if (!wallet) continue;
    const period =
      row.period && typeof row.period === 'object'
        ? (row.period as Record<string, unknown>)
        : {};
    const counts =
      row.counts && typeof row.counts === 'object'
        ? (row.counts as Record<string, unknown>)
        : {};
    const identity =
      row.identity && typeof row.identity === 'object'
        ? (row.identity as Record<string, unknown>)
        : {};
    const platforms = Array.isArray(identity.platforms)
      ? identity.platforms.map(String)
      : undefined;
    const timing =
      row.timing && typeof row.timing === 'object'
        ? (row.timing as Record<string, unknown>)
        : {};
    out.push({
      wallet,
      winRate: num(row.winRate) ?? num(period.winRate),
      realizedPnlUsd: num(period.realized) ?? num(row.realized),
      volumeUsd: num(period.volume) ?? num(row.volume),
      trades: num(counts.trades) ?? num(row.trades),
      tokensTraded: num(counts.tokensTraded) ?? num(row.tokens),
      roi: num(period.roi) ?? num(row.roi),
      name:
        typeof identity.name === 'string' && identity.name.trim()
          ? identity.name.trim()
          : undefined,
      lastTradeAt: num(timing.lastTrade),
      platforms,
    });
  }
  return out;
}

/**
 * Top traders filtered by trading frontend (axiom / photon / bloom).
 * `bullx` is accepted for best-effort calls but is not a documented filter.
 */
export async function fetchPlatformLeaderboard(
  platform: SolanaTrackerPlatform,
  opts: { limit?: number; days?: 1 | 7 | 30 | 90 } = {}
): Promise<{
  ok: boolean;
  traders: SolanaTrackerTrader[];
  error?: string;
  status: number;
}> {
  const apiKey = getSolanaTrackerApiKey();
  if (!apiKey) {
    return {
      ok: false,
      traders: [],
      error: 'SOLANA_TRACKER_API_KEY not set',
      status: 0,
    };
  }

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const days = opts.days ?? 7;
  const base = getSolanaTrackerBaseUrl().replace(/\/$/, '');
  const qs = new URLSearchParams({
    platform,
    days: String(days),
    sort: 'realized',
    direction: 'desc',
    limit: String(limit),
    excludeArbitrage: 'true',
    pnlMode: 'strict',
    minTrades: '10',
  });
  const url = `${base}/v2/pnl/leaderboard/top?${qs.toString()}`;

  try {
    const res = await loggedFetch(url, {
      context: 'SolanaTracker',
      label: `leaderboard:${platform}`,
      timeoutMs: 20_000,
      headers: {
        Accept: 'application/json',
        'x-api-key': apiKey,
        'User-Agent': 'crypto-trading-bot/1.0',
      },
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const errObj = data as { error?: string; message?: string } | null;
      const error =
        errObj?.error ||
        errObj?.message ||
        `HTTP ${res.status}`;
      console.warn(
        `[solana-tracker] ${platform} HTTP ${res.status}: ${error}`
      );
      return { ok: false, traders: [], error, status: res.status };
    }
    const traders = parseTraders(data).slice(0, limit);
    console.log(
      `[solana-tracker] ${platform} → ${traders.length} trader(s)`
    );
    return { ok: true, traders, status: res.status };
  } catch (err) {
    logger.error('SolanaTracker', `${platform} leaderboard failed`, errorToMeta(err));
    return {
      ok: false,
      traders: [],
      error: err instanceof Error ? err.message : String(err),
      status: 0,
    };
  }
}
