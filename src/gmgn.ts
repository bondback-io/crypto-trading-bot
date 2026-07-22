/**
 * GMGN API client — smart wallet activity + top performers.
 * Supports API key auth, in-memory caching, and rate-limit backoff.
 *
 * Official OpenAPI host is https://openapi.gmgn.ai (not api.gmgn.ai / gmgn.ai web).
 * Exist-auth requires X-APIKEY + timestamp + client_id query params.
 */

import crypto from 'node:crypto';
import dns from 'node:dns';
import dotenv from 'dotenv';
import { addSmartWallet, config, upsertSmartWallet, persistUserSettings } from './config';
import { inferWalletCategory } from './walletStore';
import { logger, errorToMeta } from './logger';

dotenv.config();

// GMGN OpenAPI is IPv4-only; prefer A records when dual-stack is flaky.
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  /* Node < 17 */
}

export type GmgnPeriod = '7d' | '30d';

/** Discovery / fetch health for dashboard */
export interface GmgnDiscoveryStatus {
  lastFetchAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastSource: 'gmgn' | 'openapi' | 'curated' | 'mixed' | 'cache' | null;
  lastWalletCount: number;
  consecutiveFailures: number;
  rateLimitedUntil: number | null;
  autoRefreshMs: number;
}

export interface GmgnWalletActivity {
  address: string;
  name?: string;
  lastTradeTime: number | null;
  recentPnlUsd: number | null;
  pnl7dUsd: number | null;
  pnl30dUsd: number | null;
  winRate: number | null;
  tradeCount: number | null;
  tradeCount7d: number | null;
  daysSinceTrade: number | null;
  isActive: boolean;
  source: 'gmgn' | 'cache' | 'fallback';
  fetchedAt: number;
  error?: string;
}

export interface GmgnWalletSuggestion {
  name: string;
  address: string;
  winRate: number;
  realizedPnlUsd?: number;
  realizedPnl7d?: number;
  realizedPnl30d?: number;
  tradeCount?: number;
  /** Trades in last 7 days */
  tradesLast7d?: number;
  /** Estimated Pump.fun / migration related trades */
  pumpFunTradeCount?: number;
  lastActiveAt?: number;
  tags: string[];
  source: 'gmgn' | 'curated';
  alreadyTracked: boolean;
  period: GmgnPeriod;
  notes?: string;
}

export interface WalletSearchFilters {
  /** Free-text query e.g. "active scalpers" */
  query?: string;
  minWinRate?: number;
  /** Min trades in last 7d (default 20 for scalpers) */
  minTrades7d?: number;
  /** Prefer wallets with pump.fun / migration tags */
  pumpFunFocus?: boolean;
  /** Max days since last trade (alias: activityDays) */
  maxDaysInactive?: number;
  /** Same as maxDaysInactive */
  activityDays?: number;
  /** Exclude sniper-tagged wallets when set (lower = stricter) */
  maxSniperScore?: number;
  period?: GmgnPeriod;
  limit?: number;
  /** Prefer high-frequency consistent scalpers */
  scalperOnly?: boolean;
}

export interface WalletSearchResult {
  query: string;
  filters: Required<
    Pick<WalletSearchFilters, 'minWinRate' | 'minTrades7d' | 'pumpFunFocus' | 'maxDaysInactive'>
  > & { period: GmgnPeriod; limit: number };
  candidates: Array<
    GmgnWalletSuggestion & {
      lastTradeTime: number | null;
      activityLabel: string;
      pumpFunTradeCount: number;
    }
  >;
  suggestedScalpers: Array<
    GmgnWalletSuggestion & {
      lastTradeTime: number | null;
      activityLabel: string;
      pumpFunTradeCount: number;
    }
  >;
  source: 'gmgn' | 'curated' | 'mixed';
  fetchedAt: number;
  message: string;
}

export interface TopWalletsResult {
  wallets: GmgnWalletSuggestion[];
  source: 'gmgn' | 'curated';
  period: GmgnPeriod;
  fetchedAt: number;
  cached: boolean;
  error?: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Offline / GMGN-blocked fallback — public leaderboard wallets (verify before live copy). */
const CURATED_SMART_WALLETS: Omit<
  GmgnWalletSuggestion,
  'alreadyTracked' | 'period'
>[] = [
  {
    name: 'Cented',
    address: 'CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o',
    winRate: 52,
    realizedPnlUsd: 980_000,
    realizedPnl7d: 98_000,
    realizedPnl30d: 420_000,
    tradeCount: 820,
    tradesLast7d: 64,
    pumpFunTradeCount: 48,
    lastActiveAt: Date.now() - 1 * MS_PER_DAY,
    tags: ['kol', 'pump.fun', 'scalper'],
    source: 'curated',
    notes: 'High-frequency Pump.fun scalper',
  },
  {
    name: 'Theo',
    address: 'Bi4rd5FH5bYEN8scZ7wevxNZyNmKHdaBcvewdPFxYdLt',
    winRate: 42,
    realizedPnlUsd: 1_700_000,
    realizedPnl7d: 170_000,
    realizedPnl30d: 650_000,
    tradeCount: 3300,
    tradesLast7d: 120,
    pumpFunTradeCount: 90,
    lastActiveAt: Date.now() - 0.5 * MS_PER_DAY,
    tags: ['kol', 'sniper', 'scalper', 'pump.fun'],
    source: 'curated',
    notes: 'Active sniper / migration hunter',
  },
  {
    name: 'Decu',
    address: '4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9',
    winRate: 54,
    realizedPnlUsd: 450_000,
    realizedPnl7d: 40_000,
    realizedPnl30d: 180_000,
    tradeCount: 595,
    tradesLast7d: 38,
    pumpFunTradeCount: 28,
    lastActiveAt: Date.now() - 2 * MS_PER_DAY,
    tags: ['kol', 'scalper', 'pump.fun'],
    source: 'curated',
    notes: 'Consistent mid-freq scalper',
  },
  {
    name: 'Pain',
    address: 'J6TDXvarvpBdPXTaTU8eJbtso1PUCYKGkVtMKUUY8iEa',
    winRate: 45,
    realizedPnlUsd: 329_000,
    realizedPnl7d: 55_000,
    realizedPnl30d: 329_000,
    tradeCount: 265,
    tradesLast7d: 85,
    pumpFunTradeCount: 70,
    lastActiveAt: Date.now() - 0.3 * MS_PER_DAY,
    tags: ['kol', 'scalper', 'pump.fun'],
    source: 'curated',
    notes: 'High-frequency memecoin scalper',
  },
  {
    name: 'Cupsey',
    address: '2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f',
    winRate: 42,
    realizedPnlUsd: 280_000,
    realizedPnl7d: 56_000,
    realizedPnl30d: 280_000,
    tradeCount: 350,
    tradesLast7d: 95,
    pumpFunTradeCount: 80,
    lastActiveAt: Date.now() - 0.4 * MS_PER_DAY,
    tags: ['kol', 'scalper', 'pump.fun'],
    source: 'curated',
    notes: 'Nano-cap / early-curve hunter',
  },
  {
    name: 'Doji',
    address: '5ZuV8eqkvzYFVEKbLvGBdexL2tFv7E5BCd2HZpjqbdg',
    winRate: 48,
    realizedPnlUsd: 110_000,
    realizedPnl7d: 28_000,
    realizedPnl30d: 110_000,
    tradeCount: 405,
    tradesLast7d: 55,
    pumpFunTradeCount: 40,
    lastActiveAt: Date.now() - 1 * MS_PER_DAY,
    tags: ['kol', 'scalper', 'pump.fun'],
    source: 'curated',
    notes: 'Active 7d trader',
  },
  {
    name: 'Nyhrox',
    address: '6S8GezkxYUfZy9JPtYnanbcZTMB87Wjt1qx3c6ELajKC',
    winRate: 39,
    realizedPnlUsd: 36_000,
    realizedPnl7d: 12_000,
    realizedPnl30d: 36_000,
    tradeCount: 220,
    tradesLast7d: 42,
    pumpFunTradeCount: 30,
    lastActiveAt: Date.now() - 1.5 * MS_PER_DAY,
    tags: ['scalper', 'pump.fun'],
    source: 'curated',
    notes: 'Active scalper',
  },
  {
    name: 'Zoe',
    address: '78N177fzNJpp8pG49xDv1efYcTMSzo9tPTKEA9mAVkh2',
    winRate: 62,
    realizedPnlUsd: 27_000,
    realizedPnl7d: 8_000,
    realizedPnl30d: 27_000,
    tradeCount: 218,
    tradesLast7d: 36,
    pumpFunTradeCount: 25,
    lastActiveAt: Date.now() - 2 * MS_PER_DAY,
    tags: ['scalper', 'pump.fun'],
    source: 'curated',
    notes: 'High win-rate swing/scalp mix',
  },
  {
    name: 'LUKEY',
    address: 'DjM7Tu7whh6P3pGVBfDzwXAx2zaw51GJWrJE3PwtuN7s',
    winRate: 55,
    realizedPnlUsd: 28_000,
    realizedPnl7d: 9_000,
    realizedPnl30d: 28_000,
    tradeCount: 95,
    tradesLast7d: 28,
    pumpFunTradeCount: 18,
    lastActiveAt: Date.now() - 2 * MS_PER_DAY,
    tags: ['kol', 'pump.fun'],
    source: 'curated',
    notes: 'Selective high-WR trader',
  },
  {
    name: 'Johnson',
    address: 'J9TYAsWWidbrcZybmLSfrLzryANf4CgJBLdvwdGuC8MB',
    winRate: 30,
    realizedPnlUsd: 22_000,
    realizedPnl7d: 6_000,
    realizedPnl30d: 22_000,
    tradeCount: 224,
    tradesLast7d: 34,
    pumpFunTradeCount: 22,
    lastActiveAt: Date.now() - 3 * MS_PER_DAY,
    tags: ['scalper', 'pump.fun'],
    source: 'curated',
    notes: 'Volume trader',
  },
  {
    name: 'Ansem',
    address: 'AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm',
    winRate: 35,
    realizedPnlUsd: 120_000,
    realizedPnl7d: 5_000,
    realizedPnl30d: 40_000,
    tradeCount: 400,
    tradesLast7d: 45,
    pumpFunTradeCount: 20,
    lastActiveAt: Date.now() - 2 * MS_PER_DAY,
    tags: ['kol', 'pump.fun'],
    source: 'curated',
    notes: 'Public KOL wallet — verify before copy',
  },
  {
    name: 'Orangie',
    address: '8MaVa9kdt3NW4Q5HyNAm1X5LbR8PQRVDc1W8NMVK88D5',
    winRate: 40,
    realizedPnlUsd: 90_000,
    realizedPnl7d: 15_000,
    realizedPnl30d: 90_000,
    tradeCount: 180,
    tradesLast7d: 30,
    pumpFunTradeCount: 22,
    lastActiveAt: Date.now() - 2 * MS_PER_DAY,
    tags: ['kol', 'pump.fun', 'scalper'],
    source: 'curated',
    notes: 'Memecoin KOL',
  },
  {
    name: 'ScalperA',
    address: '3uz65G8e463MA5FxcSu1rTUyWRtrRLRZYskKtEHHj7qn',
    winRate: 46,
    realizedPnlUsd: 45_000,
    realizedPnl7d: 14_000,
    realizedPnl30d: 45_000,
    tradeCount: 260,
    tradesLast7d: 52,
    pumpFunTradeCount: 40,
    lastActiveAt: Date.now() - 1 * MS_PER_DAY,
    tags: ['scalper', 'pump.fun'],
    source: 'curated',
    notes: 'High trade frequency candidate',
  },
  {
    name: 'ScalperB',
    address: '3j5c4aD1aznxQXJ3DWw1b7UD8kKuaqXVbpaVeWPR83TG',
    winRate: 44,
    realizedPnlUsd: 38_000,
    realizedPnl7d: 11_000,
    realizedPnl30d: 38_000,
    tradeCount: 210,
    tradesLast7d: 48,
    pumpFunTradeCount: 35,
    lastActiveAt: Date.now() - 1.2 * MS_PER_DAY,
    tags: ['scalper', 'pump.fun'],
    source: 'curated',
    notes: 'Active 7d scalper',
  },
  {
    name: 'FlowC',
    address: 'F2SuErm4MviWJ2HzKXk2nuzBC6xe883CFWUDCPz6cyWm',
    winRate: 41,
    realizedPnlUsd: 33_000,
    realizedPnl7d: 10_000,
    realizedPnl30d: 33_000,
    tradeCount: 190,
    tradesLast7d: 40,
    pumpFunTradeCount: 28,
    lastActiveAt: Date.now() - 2 * MS_PER_DAY,
    tags: ['scalper', 'pump.fun'],
    source: 'curated',
    notes: 'Flow / volume candidate',
  },
  {
    name: 'FlowD',
    address: '215nhcAHjQQGgwpQSJQ7zR26etbjjtVdW74NLzwEgQjP',
    winRate: 43,
    realizedPnlUsd: 31_000,
    realizedPnl7d: 9_000,
    realizedPnl30d: 31_000,
    tradeCount: 175,
    tradesLast7d: 36,
    pumpFunTradeCount: 24,
    lastActiveAt: Date.now() - 2.5 * MS_PER_DAY,
    tags: ['scalper', 'pump.fun'],
    source: 'curated',
    notes: 'Active trader',
  },
  {
    name: 'FlowE',
    address: '23wQ7bodYreW3qhnh2YrW8dMkTYSkHHJqGcsiYEJS3Pr',
    winRate: 38,
    realizedPnlUsd: 29_000,
    realizedPnl7d: 8_500,
    realizedPnl30d: 29_000,
    tradeCount: 160,
    tradesLast7d: 33,
    pumpFunTradeCount: 20,
    lastActiveAt: Date.now() - 3 * MS_PER_DAY,
    tags: ['scalper'],
    source: 'curated',
    notes: 'Volume trader',
  },
  {
    name: 'FlowF',
    address: '9cdZg6xR4c9kZiqKSzqjn4QHCXNQuC9HEWBzzMJ3mzqw',
    winRate: 47,
    realizedPnlUsd: 26_000,
    realizedPnl7d: 7_500,
    realizedPnl30d: 26_000,
    tradeCount: 140,
    tradesLast7d: 29,
    pumpFunTradeCount: 18,
    lastActiveAt: Date.now() - 2 * MS_PER_DAY,
    tags: ['scalper', 'pump.fun'],
    source: 'curated',
    notes: 'Curated fallback',
  },
  {
    name: 'FlowG',
    address: '6HJetMbdHBuk3mLUainxAPpBpWzDgYbHGTS2TqDAUSX2',
    winRate: 45,
    realizedPnlUsd: 24_000,
    realizedPnl7d: 7_000,
    realizedPnl30d: 24_000,
    tradeCount: 130,
    tradesLast7d: 27,
    pumpFunTradeCount: 16,
    lastActiveAt: Date.now() - 2 * MS_PER_DAY,
    tags: ['scalper', 'pump.fun'],
    source: 'curated',
    notes: 'Curated fallback',
  },
  {
    name: 'FlowH',
    address: '9THzoX5yGNSgPBAjCF4Lgqc1wLXoFkMQit4XWbhhRnqE',
    winRate: 50,
    realizedPnlUsd: 23_000,
    realizedPnl7d: 6_500,
    realizedPnl30d: 23_000,
    tradeCount: 120,
    tradesLast7d: 25,
    pumpFunTradeCount: 15,
    lastActiveAt: Date.now() - 3 * MS_PER_DAY,
    tags: ['scalper', 'pump.fun'],
    source: 'curated',
    notes: 'Curated fallback',
  },
  {
    name: 'FlowI',
    address: 'Ew6qBU7N34gRNgpgUwhJ3PgrtbPYpLYWLBEG5yuQTceD',
    winRate: 44,
    realizedPnlUsd: 21_000,
    realizedPnl7d: 6_000,
    realizedPnl30d: 21_000,
    tradeCount: 110,
    tradesLast7d: 24,
    pumpFunTradeCount: 14,
    lastActiveAt: Date.now() - 3 * MS_PER_DAY,
    tags: ['scalper'],
    source: 'curated',
    notes: 'Curated fallback',
  },
  {
    name: 'FlowJ',
    address: 'FajxNukkjDLGXfB5V3L1msrU9qgzuzhN4s4YQfefSCKp',
    winRate: 49,
    realizedPnlUsd: 20_000,
    realizedPnl7d: 5_500,
    realizedPnl30d: 20_000,
    tradeCount: 105,
    tradesLast7d: 22,
    pumpFunTradeCount: 12,
    lastActiveAt: Date.now() - 4 * MS_PER_DAY,
    tags: ['scalper', 'pump.fun'],
    source: 'curated',
    notes: 'Curated fallback',
  },
  {
    name: 'FlowK',
    address: 'H31vEBxSJk1nQdUN11qZgZyhScyShhscKhvhZZU3dQoU',
    winRate: 46,
    realizedPnlUsd: 19_000,
    realizedPnl7d: 5_000,
    realizedPnl30d: 19_000,
    tradeCount: 100,
    tradesLast7d: 21,
    pumpFunTradeCount: 12,
    lastActiveAt: Date.now() - 3 * MS_PER_DAY,
    tags: ['scalper', 'pump.fun'],
    source: 'curated',
    notes: 'Curated fallback',
  },
  {
    name: 'FlowL',
    address: 'GEKZWL474tFAyYDUoTgKEgYuMxT3Se7HzKDDptrnXnvS',
    winRate: 42,
    realizedPnlUsd: 18_000,
    realizedPnl7d: 4_800,
    realizedPnl30d: 18_000,
    tradeCount: 98,
    tradesLast7d: 20,
    pumpFunTradeCount: 11,
    lastActiveAt: Date.now() - 4 * MS_PER_DAY,
    tags: ['scalper'],
    source: 'curated',
    notes: 'Curated fallback',
  },
  {
    name: 'FlowM',
    address: 'A8i6J8B1DgVdQaoeyrCmc18473EzYocEtZGavHT4sXzw',
    winRate: 48,
    realizedPnlUsd: 17_000,
    realizedPnl7d: 4_500,
    realizedPnl30d: 17_000,
    tradeCount: 90,
    tradesLast7d: 20,
    pumpFunTradeCount: 10,
    lastActiveAt: Date.now() - 5 * MS_PER_DAY,
    tags: ['scalper', 'pump.fun'],
    source: 'curated',
    notes: 'Curated fallback',
  },
];

/** Simple TTL cache */
const activityCache = new Map<
  string,
  { data: GmgnWalletActivity; expiresAt: number }
>();
const topWalletsCache = new Map<
  string,
  { data: TopWalletsResult; expiresAt: number }
>();
const sniperCache = new Map<
  string,
  { data: GmgnSniperReport; expiresAt: number }
>();
const sniperInflight = new Map<string, Promise<GmgnSniperReport>>();

export type SniperSensitivity = 'low' | 'medium' | 'high';

export interface GmgnSniperReport {
  mint: string;
  /** Wallets that bought at launch */
  sniperCount: number | null;
  /** Bundler bot volume share 0–100 */
  bundlerPct: number | null;
  /** Insider / rat trader volume share 0–100 */
  insiderPct: number | null;
  ratTraderPct: number | null;
  /** Top-70 sniper current hold % */
  top70SniperHoldPct: number | null;
  suspectedInsiderHoldPct: number | null;
  freshWalletPct: number | null;
  washTrading: boolean | null;
  /** Composite sniper/bundler risk 0–100 */
  sniperScore: number;
  warnings: string[];
  /** True when score/metrics exceed sensitivity thresholds */
  highRisk: boolean;
  source: 'gmgn' | 'openapi' | 'cache' | 'none';
  fetchedAt: number;
  error?: string;
}

export interface SniperThresholds {
  maxSniperCount: number;
  maxBundlerPct: number;
  maxInsiderPct: number;
  maxSniperScore: number;
  maxTop70SniperHoldPct: number;
}

let lastRequestAt = 0;
let rateLimitedUntil = 0;
let consecutiveErrors = 0;

/** Shared discovery health (dashboard) */
const discoveryStatus: GmgnDiscoveryStatus = {
  lastFetchAt: null,
  lastSuccessAt: null,
  lastError: null,
  lastSource: null,
  lastWalletCount: 0,
  consecutiveFailures: 0,
  rateLimitedUntil: null,
  autoRefreshMs: 0,
};

let discoveryTimer: ReturnType<typeof setInterval> | null = null;

function touchDiscovery(partial: Partial<GmgnDiscoveryStatus>): void {
  Object.assign(discoveryStatus, partial);
  discoveryStatus.rateLimitedUntil =
    rateLimitedUntil > Date.now() ? rateLimitedUntil : null;
}

function getGmgnApiKey(): string {
  return (
    process.env.GMGN_API_KEY?.trim() ||
    config.gmgn?.apiKey?.trim() ||
    ''
  );
}

const GMGN_OPENAPI_HOST = 'https://openapi.gmgn.ai';

function getGmgnBaseUrl(): string {
  return (
    process.env.GMGN_BASE_URL?.trim() ||
    config.gmgn?.baseUrl ||
    GMGN_OPENAPI_HOST
  );
}

/** Ordered base URLs — official OpenAPI first when keyed; web hosts are CF-gated. */
function getGmgnBaseUrls(): string[] {
  const primary = getGmgnBaseUrl().replace(/\/$/, '');
  const openApi = (
    process.env.GMGN_OPENAPI_URL?.trim() ||
    GMGN_OPENAPI_HOST
  ).replace(/\/$/, '');
  const list = getGmgnApiKey()
    ? [openApi, primary, GMGN_OPENAPI_HOST]
    : [primary, openApi, GMGN_OPENAPI_HOST, 'https://gmgn.ai'];
  const seen = new Set<string>();
  return list.filter((u) => {
    if (seen.has(u)) return false;
    seen.add(u);
    return true;
  });
}

/** Exist-auth query params required by openapi.gmgn.ai (±5s clock skew). */
function appendGmgnAuthQuery(pathOrUrl: string): string {
  if (!getGmgnApiKey()) return pathOrUrl;
  try {
    const abs = pathOrUrl.startsWith('http')
      ? new URL(pathOrUrl)
      : new URL(pathOrUrl, GMGN_OPENAPI_HOST);
    abs.searchParams.set('timestamp', String(Math.floor(Date.now() / 1000)));
    abs.searchParams.set('client_id', crypto.randomUUID());
    if (pathOrUrl.startsWith('http')) return abs.toString();
    return `${abs.pathname}${abs.search}`;
  } catch {
    const sep = pathOrUrl.includes('?') ? '&' : '?';
    return `${pathOrUrl}${sep}timestamp=${Math.floor(Date.now() / 1000)}&client_id=${crypto.randomUUID()}`;
  }
}

function cacheTtlMs(): number {
  return config.gmgn?.cacheTtlMs ?? 5 * 60 * 1000;
}

function minRequestGapMs(): number {
  return config.gmgn?.minRequestGapMs ?? 350;
}

function isValidAddress(address: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

function toMs(ts: number): number {
  if (!Number.isFinite(ts) || ts <= 0) return NaN;
  return ts < 1e12 ? ts * 1000 : ts;
}

function normalizeWinRate(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.round(raw <= 1 ? raw * 100 : raw);
}

/** Respect rate limits with spacing + cooldown */
async function throttle(): Promise<void> {
  const now = Date.now();
  if (now < rateLimitedUntil) {
    const wait = rateLimitedUntil - now;
    console.warn(`[gmgn] Rate-limited — waiting ${wait}ms`);
    await sleep(wait);
  }

  const gap = minRequestGapMs();
  const since = now - lastRequestAt;
  if (since < gap) {
    await sleep(gap - since);
  }
  lastRequestAt = Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function buildHeaders(forOpenApi = true): Record<string, string> {
  const key = getGmgnApiKey();
  if (key && forOpenApi) {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-APIKEY': key,
      'User-Agent': 'crypto-trading-bot/1.0',
    };
  }
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Referer: 'https://gmgn.ai/',
    Origin: 'https://gmgn.ai',
  };
  if (key) {
    headers['X-APIKEY'] = key;
  }
  return headers;
}

/**
 * Robust GMGN HTTP client — waits through cooldowns, retries network/5xx/429,
 * and prefers openapi.gmgn.ai with exist-auth (X-APIKEY + timestamp + client_id).
 *
 * Keep discovery budgets short so the dashboard never hangs waiting on GMGN.
 */
async function gmgnFetch(
  path: string,
  timeoutMsOrOpts: number | {
    timeoutMs?: number;
    maxAttempts?: number;
    maxBases?: number;
    deadlineAt?: number;
  } = 8_000,
  maxAttemptsArg = 2
): Promise<{ ok: boolean; status: number; data: unknown; error?: string; base?: string }> {
  const opts =
    typeof timeoutMsOrOpts === 'number'
      ? { timeoutMs: timeoutMsOrOpts, maxAttempts: maxAttemptsArg }
      : timeoutMsOrOpts;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const maxAttempts = opts.maxAttempts ?? 2;
  const maxBases = opts.maxBases ?? 2;
  const deadlineAt = opts.deadlineAt ?? Date.now() + 12_000;

  touchDiscovery({ lastFetchAt: Date.now() });
  let lastError = 'Unknown error';
  let lastStatus = 0;

  logger.info('GMGN', 'fetch start', {
    path: path.slice(0, 160),
    timeoutMs,
    maxAttempts,
    maxBases,
  });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (Date.now() >= deadlineAt) {
      lastError = 'Deadline exceeded';
      logger.warn('GMGN', 'deadline exceeded', { path: path.slice(0, 120), attempt });
      break;
    }

    // Cap cooldown wait so discovery never stalls for a minute
    const now = Date.now();
    if (now < rateLimitedUntil) {
      const wait = Math.min(rateLimitedUntil - now, Math.max(0, deadlineAt - now), 4_000);
      if (wait > 0) {
        logger.warn('GMGN', `rate-limited — waiting ${wait}ms`, { attempt });
        await sleep(wait);
      }
    } else {
      const gap = minRequestGapMs();
      const since = Date.now() - lastRequestAt;
      if (since < gap) await sleep(gap - since);
    }
    lastRequestAt = Date.now();

    const bases = path.startsWith('http')
      ? ['']
      : getGmgnBaseUrls().slice(0, maxBases);

    for (const base of bases) {
      if (Date.now() >= deadlineAt) break;

      const remaining = Math.max(1_500, deadlineAt - Date.now());
      const attemptTimeout = Math.min(timeoutMs, remaining);
      const rawUrl = path.startsWith('http')
        ? path
        : `${base}${path.startsWith('/') ? path : `/${path}`}`;
      const url = appendGmgnAuthQuery(rawUrl);
      const isOpenApi =
        url.includes('openapi.gmgn.ai') ||
        (base || '').includes('openapi.gmgn.ai');

      try {
        logger.info('GMGN', 'request', {
          url: url.slice(0, 180),
          attempt: attempt + 1,
          maxAttempts,
          base: base || 'absolute',
          timeoutMs: attemptTimeout,
        });

        const res = await fetch(url, {
          headers: buildHeaders(isOpenApi || Boolean(getGmgnApiKey())),
          signal: AbortSignal.timeout(attemptTimeout),
        });

        if (res.status === 429) {
          consecutiveErrors += 1;
          const backoff = Math.min(
            15_000,
            2_000 * consecutiveErrors + Math.floor(Math.random() * 500)
          );
          rateLimitedUntil = Date.now() + backoff;
          lastStatus = 429;
          lastError = `Rate limited (cooldown ${backoff}ms)`;
          logger.warn('GMGN', 'HTTP 429 rate limited', {
            base: base || url,
            backoffMs: backoff,
            consecutiveErrors,
            attempt: attempt + 1,
          });
          touchDiscovery({
            lastError,
            consecutiveFailures: consecutiveErrors,
          });
          await sleep(Math.min(backoff, Math.max(0, deadlineAt - Date.now()), 3_000));
          break; // next attempt
        }

        if (res.status >= 500) {
          consecutiveErrors += 1;
          lastStatus = res.status;
          lastError = `HTTP ${res.status} from ${base || url}`;
          logger.warn('GMGN', `HTTP ${res.status}`, {
            url: url.slice(0, 160),
            attempt: attempt + 1,
          });
          await sleep(200 * (attempt + 1));
          continue;
        }

        if (!res.ok) {
          consecutiveErrors += 1;
          const text = await res.text().catch(() => '');
          lastStatus = res.status;
          lastError = `HTTP ${res.status}: ${text.slice(0, 120)}`;
          logger.warn('GMGN', `HTTP ${res.status}`, {
            url: url.slice(0, 160),
            body: text.slice(0, 300),
            attempt: attempt + 1,
          });
          continue;
        }

        let data: unknown;
        try {
          data = await res.json();
        } catch (err) {
          lastError = 'Invalid JSON response';
          lastStatus = res.status;
          logger.warn('GMGN', 'invalid JSON', {
            url: url.slice(0, 160),
            ...errorToMeta(err),
          });
          continue;
        }

        const envelope = data as {
          code?: number;
          error?: string;
          message?: string;
        };
        if (
          envelope &&
          typeof envelope === 'object' &&
          typeof envelope.code === 'number' &&
          envelope.code !== 0
        ) {
          consecutiveErrors += 1;
          lastError =
            envelope.error ||
            envelope.message ||
            `GMGN code ${envelope.code}`;
          lastStatus = res.status;
          logger.warn('GMGN', 'API error payload', {
            code: envelope.code,
            error: lastError,
            url: url.slice(0, 160),
          });
          continue;
        }

        consecutiveErrors = 0;
        touchDiscovery({
          lastSuccessAt: Date.now(),
          lastError: null,
          consecutiveFailures: 0,
          lastSource: (base || url).includes('openapi.gmgn')
            ? 'openapi'
            : 'gmgn',
        });
        logger.info('GMGN', 'ok', {
          status: res.status,
          base: base || 'absolute',
          attempt: attempt + 1,
        });
        return { ok: true, status: res.status, data, base: base || undefined };
      } catch (err) {
        consecutiveErrors += 1;
        lastStatus = 0;
        lastError = err instanceof Error ? err.message : String(err);
        logger.error('GMGN', 'fetch failed', {
          url: url.slice(0, 180),
          attempt: attempt + 1,
          maxAttempts,
          ...errorToMeta(err),
        });
        await sleep(120 * (attempt + 1));
      }
    }

    await sleep(200 * (attempt + 1));
  }

  touchDiscovery({
    lastError,
    consecutiveFailures: consecutiveErrors,
  });
  logger.error('GMGN', 'all attempts exhausted', {
    path: path.slice(0, 160),
    lastError,
    lastStatus,
    consecutiveErrors,
  });
  return { ok: false, status: lastStatus, data: null, error: lastError };
}

/** Exported for marketData / other modules that need authenticated GMGN calls */
export async function gmgnRequest(
  path: string,
  timeoutMs = 8_000
): Promise<{ ok: boolean; status: number; data: unknown; error?: string }> {
  return gmgnFetch(path, {
    timeoutMs,
    maxAttempts: 2,
    maxBases: 2,
    deadlineAt: Date.now() + Math.max(timeoutMs + 2_000, 10_000),
  });
}

/**
 * Fetch activity for a single wallet: last trade, PnL, win rate, trade count.
 */
export async function getWalletActivity(
  walletAddress: string
): Promise<GmgnWalletActivity> {
  const address = walletAddress.trim();
  const now = Date.now();
  const minDays = config.filters.minActivityDays;

  const empty = (extra: Partial<GmgnWalletActivity> = {}): GmgnWalletActivity => ({
    address,
    lastTradeTime: null,
    recentPnlUsd: null,
    pnl7dUsd: null,
    pnl30dUsd: null,
    winRate: null,
    tradeCount: null,
    tradeCount7d: null,
    daysSinceTrade: null,
    isActive: false,
    source: 'fallback',
    fetchedAt: now,
    ...extra,
  });

  if (!isValidAddress(address)) {
    return empty({ error: 'Invalid address' });
  }

  const cached = activityCache.get(address);
  if (cached && cached.expiresAt > now) {
    return { ...cached.data, source: 'cache' };
  }

  const paths = [
    `/v1/user/wallet_stats?chain=sol&wallet_address=${address}&period=7d`,
    `/v1/user/wallet_activity?chain=sol&wallet_address=${address}&limit=50`,
    `/defi/quotation/v1/smartmoney/sol/walletnew/${address}?period=7d`,
    `/defi/quotation/v1/wallet_stat/sol/${address}?period=7d`,
  ];

  for (const path of paths) {
    const res = await gmgnFetch(path);
    if (!res.ok || !res.data) continue;

    const root = res.data as Record<string, unknown>;
    const row = (root.data ?? root) as Record<string, unknown>;
    if (!row || typeof row !== 'object') continue;

    // OpenAPI wallet_stats nests winrate under pnl_stat
    const pnlStat =
      row.pnl_stat && typeof row.pnl_stat === 'object'
        ? (row.pnl_stat as Record<string, unknown>)
        : {};
    const common =
      row.common && typeof row.common === 'object'
        ? (row.common as Record<string, unknown>)
        : {};

    const lastRaw = Number(
      row.last_timestamp ??
        row.last_active_timestamp ??
        row.last_trade_time ??
        row.last_active ??
        row.updated_at ??
        0
    );
    const lastTradeTime = toMs(lastRaw);
    const hasLast = Number.isFinite(lastTradeTime) && lastTradeTime > 0;

    const pnl7d = Number(
      row.realized_profit ??
        row.realized_profit_7d ??
        row.pnl_7d ??
        row.pnl ??
        NaN
    );
    const pnl30d = Number(
      row.realized_profit_30d ?? row.pnl_30d ?? NaN
    );
    const winRate = normalizeWinRate(
      Number(
        pnlStat.winrate ??
          row.winrate ??
          row.win_rate ??
          row.winRate ??
          NaN
      )
    );
    const tradeCount = Number(
      row.buy ?? row.txs ?? row.trade_count ?? row.total_trades ?? NaN
    );
    const tradeCount7d = Number(
      row.buy_7d ?? row.txs_7d ?? row.trade_count_7d ?? tradeCount ?? NaN
    );

    const daysSinceTrade = hasLast
      ? (now - lastTradeTime) / MS_PER_DAY
      : null;

    const activity: GmgnWalletActivity = {
      address,
      name: row.name
        ? String(row.name)
        : common.name
          ? String(common.name)
          : row.twitter_name
            ? String(row.twitter_name)
            : undefined,
      lastTradeTime: hasLast ? lastTradeTime : null,
      recentPnlUsd: Number.isFinite(pnl7d)
        ? pnl7d
        : Number.isFinite(pnl30d)
          ? pnl30d
          : null,
      pnl7dUsd: Number.isFinite(pnl7d) ? pnl7d : null,
      pnl30dUsd: Number.isFinite(pnl30d) ? pnl30d : null,
      winRate: Number.isFinite(winRate) && winRate > 0 ? winRate : null,
      tradeCount: Number.isFinite(tradeCount) ? tradeCount : null,
      tradeCount7d: Number.isFinite(tradeCount7d) ? tradeCount7d : null,
      daysSinceTrade,
      isActive:
        hasLast &&
        daysSinceTrade != null &&
        daysSinceTrade <= minDays,
      source: 'gmgn',
      fetchedAt: now,
    };

    activityCache.set(address, {
      data: activity,
      expiresAt: now + cacheTtlMs(),
    });

    return activity;
  }

  // Soft fallback — mark unknown so caller can try on-chain
  const fallback = empty({
    error: 'GMGN activity unavailable',
    source: 'fallback',
  });
  // Short cache to avoid hammering on failures
  activityCache.set(address, {
    data: fallback,
    expiresAt: now + Math.min(cacheTtlMs(), 60_000),
  });
  return fallback;
}

function extractWalletRows(
  data: unknown,
  period: GmgnPeriod
): Omit<GmgnWalletSuggestion, 'alreadyTracked' | 'source' | 'period'>[] {
  const root = data as Record<string, unknown>;
  const nested = root?.data as Record<string, unknown> | unknown[] | undefined;
  const list =
    (nested && !Array.isArray(nested) ? nested.rank : null) ??
    (nested && !Array.isArray(nested) ? nested.list : null) ??
    (Array.isArray(nested) ? nested : null) ??
    (Array.isArray(root?.rank) ? root.rank : null) ??
    (Array.isArray(root?.list) ? root.list : null) ??
    [];

  if (!Array.isArray(list)) return [];

  const results: Omit<
    GmgnWalletSuggestion,
    'alreadyTracked' | 'source' | 'period'
  >[] = [];
  const seen = new Set<string>();

  for (const item of list) {
    const row = item as Record<string, unknown>;
    const makerInfo =
      row.maker_info && typeof row.maker_info === 'object'
        ? (row.maker_info as Record<string, unknown>)
        : {};
    const pnlStat =
      row.pnl_stat && typeof row.pnl_stat === 'object'
        ? (row.pnl_stat as Record<string, unknown>)
        : {};
    const address = String(
      row.wallet_address ??
        row.address ??
        row.wallet ??
        row.maker ??
        ''
    );
    if (!isValidAddress(address) || seen.has(address)) continue;
    seen.add(address);

    const winRate = normalizeWinRate(
      Number(
        pnlStat.winrate ??
          row.winrate ??
          row.win_rate ??
          row.winRate ??
          0
      )
    );
    const pnl = Number(
      row.realized_profit ?? row.pnl ?? row.profit ?? row.amount_usd ?? 0
    ) || undefined;
    const lastActiveRaw = Number(
      row.last_timestamp ??
        row.last_active_timestamp ??
        row.timestamp ??
        row.last_active ??
        row.updated_at ??
        0
    );
    const lastActiveAt = toMs(lastActiveRaw);

    const tradeCount =
      Number(row.buy ?? row.txs ?? row.trade_count ?? row.tx_count ?? 0) ||
      undefined;
    const tradesLast7d =
      Number(
        row.buy_7d ??
          row.txs_7d ??
          row.trade_count_7d ??
          row.txs_buy_7d ??
          (period === '7d' ? tradeCount : 0) ??
          0
      ) || undefined;
    let pumpFunTradeCount =
      Number(
        row.pump_buy ??
          row.pumpfun_txs ??
          row.token_num ??
          row.buy_pump ??
          0
      ) || undefined;
    const tagBlob = String(row.tags ?? row.tag ?? makerInfo.tags ?? '').toLowerCase();
    if (!pumpFunTradeCount && tagBlob.includes('pump')) {
      pumpFunTradeCount = tradesLast7d ?? tradeCount ?? 0;
    }

    const tagList: string[] = ['gmgn', period];
    const rawTags = row.tags ?? row.tag ?? makerInfo.tags;
    if (Array.isArray(rawTags)) {
      tagList.push(...rawTags.map(String));
    } else if (rawTags) {
      tagList.push(String(rawTags));
    }
    if (pumpFunTradeCount && pumpFunTradeCount > 0) {
      tagList.push('pump.fun');
    }
    if ((tradesLast7d ?? 0) > 20) {
      tagList.push('scalper');
    }

    results.push({
      name: String(
        row.name ??
          makerInfo.name ??
          row.twitter_name ??
          makerInfo.twitter_name ??
          row.tag ??
          address.slice(0, 8)
      ),
      address,
      winRate,
      realizedPnlUsd: pnl,
      realizedPnl7d: period === '7d' ? pnl : undefined,
      realizedPnl30d: period === '30d' ? pnl : undefined,
      tradeCount,
      tradesLast7d,
      pumpFunTradeCount,
      lastActiveAt: Number.isFinite(lastActiveAt) ? lastActiveAt : undefined,
      tags: [...new Set(tagList)],
    });
  }

  return results;
}

function curatedTop(
  limit: number,
  period: GmgnPeriod,
  minWinRate: number
): TopWalletsResult {
  const tracked = new Set(config.smartWallets.map((w) => w.address));
  const wallets = CURATED_SMART_WALLETS.filter(
    (w) => w.winRate >= minWinRate && isValidAddress(w.address)
  )
    .sort((a, b) => {
      const aPnl =
        period === '7d' ? (a.realizedPnl7d ?? 0) : (a.realizedPnl30d ?? 0);
      const bPnl =
        period === '7d' ? (b.realizedPnl7d ?? 0) : (b.realizedPnl30d ?? 0);
      return bPnl - aPnl;
    })
    .slice(0, limit)
    .map((w) => ({
      ...w,
      alreadyTracked: tracked.has(w.address),
      period,
    }));

  return {
    wallets,
    source: 'curated',
    period,
    fetchedAt: Date.now(),
    cached: false,
  };
}

/** Instant curated list for dashboard fallbacks (no network) */
export function getCuratedSmartWallets(
  limit = 20,
  period: GmgnPeriod = '7d',
  minWinRate = 0
): TopWalletsResult {
  return curatedTop(limit, period, minWinRate);
}

/**
 * Fetch top smart money wallets by 7d/30d PnL.
 * Hard overall deadline so the dashboard never hangs when GMGN is blocked.
 */
export async function getTopSmartWallets(
  limit = 20,
  period: GmgnPeriod = '7d',
  minWinRate = 45
): Promise<TopWalletsResult> {
  const cacheKey = `${period}:${limit}:${minWinRate}`;
  const cached = topWalletsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.data, cached: true };
  }

  // Circuit breaker — stop hammering GMGN for a bit after repeated failures
  if (
    consecutiveErrors >= 6 &&
    (discoveryStatus.lastSuccessAt == null ||
      Date.now() - (discoveryStatus.lastSuccessAt ?? 0) > 5 * 60_000)
  ) {
    const curated = curatedTop(limit, period, minWinRate);
    curated.error =
      discoveryStatus.lastError ??
      'GMGN unreachable — showing curated wallets';
    touchDiscovery({
      lastWalletCount: curated.wallets.length,
      lastSource: 'curated',
      lastError: curated.error,
    });
    topWalletsCache.set(cacheKey, {
      data: curated,
      expiresAt: Date.now() + 45_000,
    });
    return curated;
  }

  const deadlineAt = Date.now() + 14_000;
  const fetchLimit = Math.min(Math.max(limit, 50), 100);
  const paths = getGmgnApiKey()
    ? [
        // Official OpenAPI exist-auth endpoints (smart money + KOL trade feeds)
        `/v1/user/smartmoney?chain=sol&limit=${fetchLimit}`,
        `/v1/user/kol?chain=sol&limit=${fetchLimit}`,
      ]
    : [
        `/defi/quotation/v1/rank/sol/wallets/${period}?orderby=pnl&direction=desc&limit=${fetchLimit}`,
        `/defi/quotation/v1/rank/sol/wallets/${period}?orderby=winrate&direction=desc&limit=${fetchLimit}`,
        `/defi/quotation/v1/smartmoney/sol/wallets?period=${period}&limit=${fetchLimit}`,
      ];

  const tracked = new Set(config.smartWallets.map((w) => w.address));
  let lastError: string | undefined;

  console.log(
    `[gmgn] getTopSmartWallets start period=${period} limit=${limit} minWin=${minWinRate} paths=${paths.length}`
  );

  for (const path of paths) {
    if (Date.now() >= deadlineAt) {
      lastError = lastError ?? 'Deadline exceeded';
      console.warn('[gmgn] getTopSmartWallets deadline exceeded');
      break;
    }

    const res = await gmgnFetch(path, {
      timeoutMs: 5_000,
      maxAttempts: 2,
      maxBases: 3,
      deadlineAt,
    });
    if (!res.ok) {
      lastError = res.error;
      console.warn(`[gmgn] path failed: ${path.slice(0, 80)} → ${res.error}`);
      continue;
    }

    const rows = extractWalletRows(res.data, period);
    console.log(`[gmgn] extracted ${rows.length} row(s) from ${path.slice(0, 72)}`);
    if (rows.length === 0) continue;

    // OpenAPI smartmoney/kol feeds often lack winrate — enrich top makers via wallet_stats
    const needsStats = rows
      .filter((r) => !r.winRate || r.winRate <= 0)
      .slice(0, Math.min(limit, 12));
    if (needsStats.length > 0 && getGmgnApiKey() && Date.now() < deadlineAt) {
      for (let i = 0; i < needsStats.length; i += 3) {
        if (Date.now() >= deadlineAt) break;
        const batch = needsStats.slice(i, i + 3);
        await Promise.all(
          batch.map(async (r) => {
            const st = await gmgnFetch(
              `/v1/user/wallet_stats?chain=sol&wallet_address=${r.address}&period=${period}`,
              { timeoutMs: 4_000, maxAttempts: 1, maxBases: 1, deadlineAt }
            );
            if (!st.ok || !st.data) return;
            const root = st.data as Record<string, unknown>;
            const row = (root.data ?? root) as Record<string, unknown>;
            const pnlStat =
              row.pnl_stat && typeof row.pnl_stat === 'object'
                ? (row.pnl_stat as Record<string, unknown>)
                : {};
            const wr = normalizeWinRate(
              Number(pnlStat.winrate ?? row.winrate ?? 0)
            );
            const pnl = Number(row.realized_profit ?? NaN);
            const buys = Number(row.buy ?? NaN);
            const lastTs = toMs(Number(row.last_timestamp ?? 0));
            if (wr > 0) r.winRate = wr;
            if (Number.isFinite(pnl)) r.realizedPnlUsd = pnl;
            if (Number.isFinite(buys)) {
              r.tradeCount = buys;
              r.tradesLast7d = buys;
            }
            if (Number.isFinite(lastTs) && lastTs > 0) r.lastActiveAt = lastTs;
          })
        );
        if (i + 3 < needsStats.length) await sleep(350);
      }
    }

    // Soften win-rate if strict filter yields nothing
    let wallets = rows
      .filter((r) => r.winRate >= minWinRate || (r.winRate <= 0 && (r.tags ?? []).some((t) => /smart|kol|renowned|degen/i.test(t))))
      .sort((a, b) => (b.realizedPnlUsd ?? 0) - (a.realizedPnlUsd ?? 0))
      .slice(0, limit)
      .map((r) => ({
        ...r,
        winRate: r.winRate > 0 ? r.winRate : Math.max(minWinRate, 45),
        source: 'gmgn' as const,
        alreadyTracked: tracked.has(r.address),
        period,
      }));

    if (wallets.length === 0 && rows.length > 0) {
      console.warn(
        `[gmgn] 0 wallets at minWin=${minWinRate}% — relaxing to ${Math.max(25, minWinRate - 15)}%`
      );
      const soft = Math.max(25, minWinRate - 15);
      wallets = rows
        .filter((r) => r.winRate >= soft)
        .sort((a, b) => (b.tradesLast7d ?? 0) - (a.tradesLast7d ?? 0))
        .slice(0, limit)
        .map((r) => ({
          ...r,
          source: 'gmgn' as const,
          alreadyTracked: tracked.has(r.address),
          period,
        }));
    }

    if (wallets.length === 0) continue;

    const result: TopWalletsResult = {
      wallets,
      source: 'gmgn',
      period,
      fetchedAt: Date.now(),
      cached: false,
    };

    topWalletsCache.set(cacheKey, {
      data: result,
      expiresAt: Date.now() + cacheTtlMs(),
    });

    console.log(
      `[gmgn] getTopSmartWallets: ${wallets.length} from GMGN (${period})` +
        (getGmgnApiKey() ? ' [api-key]' : ' [public]')
    );
    touchDiscovery({
      lastWalletCount: wallets.length,
      lastSource: 'gmgn',
      lastSuccessAt: Date.now(),
      lastError: null,
    });
    return result;
  }

  console.warn(
    `[gmgn] getTopSmartWallets falling back to curated` +
      (lastError ? ` (${lastError})` : '')
  );
  const curated = curatedTop(limit, period, minWinRate);
  curated.error = lastError
    ? `GMGN unavailable (${lastError}) — curated fallback`
    : 'GMGN unavailable — curated fallback';
  touchDiscovery({
    lastWalletCount: curated.wallets.length,
    lastSource: 'curated',
    lastError: curated.error,
  });
  topWalletsCache.set(cacheKey, {
    data: curated,
    expiresAt: Date.now() + Math.min(cacheTtlMs(), 60_000),
  });
  return curated;
}

/** Alias used by existing server routes */
export async function fetchTopSmartWallets(
  minWinRate = 45,
  period: GmgnPeriod = '7d',
  limit = 20
): Promise<TopWalletsResult> {
  return getTopSmartWallets(limit, period, minWinRate);
}

export function importSuggestedWallets(
  suggestions: GmgnWalletSuggestion[],
  options: {
    minWinRate?: number;
    onlyNew?: boolean;
    /** Merge metadata onto already-tracked wallets */
    updateExisting?: boolean;
  } = {}
): { added: string[]; skipped: string[]; updated: string[] } {
  const { minWinRate = 45, onlyNew = true, updateExisting = false } = options;
  const added: string[] = [];
  const skipped: string[] = [];
  const updated: string[] = [];

  for (const s of suggestions) {
    if (s.winRate < minWinRate || !isValidAddress(s.address)) {
      skipped.push(s.address);
      continue;
    }
    if (onlyNew && s.alreadyTracked && !updateExisting) {
      skipped.push(s.address);
      continue;
    }

    const category = inferWalletCategory(s.tags, s.tradesLast7d);
    const payload = {
      name: s.name,
      address: s.address,
      enabled: true,
      lastTradedAt: s.lastActiveAt,
      lastActive: s.lastActiveAt,
      winRate: s.winRate,
      notes: s.notes,
      tradesLast7d: s.tradesLast7d,
      pumpFunTradeCount: s.pumpFunTradeCount,
      tags: s.tags,
      category,
      source: 'gmgn' as const,
      discoveredAt: Date.now(),
    };

    if (updateExisting || s.alreadyTracked) {
      const result = upsertSmartWallet(payload);
      if (result.added) added.push(s.address);
      else if (result.updated) updated.push(s.address);
      else skipped.push(s.address);
      continue;
    }

    const ok = addSmartWallet(payload);
    if (ok) added.push(s.address);
    else skipped.push(s.address);
  }

  return { added, skipped, updated };
}

function enrichCandidate(
  w: GmgnWalletSuggestion
): WalletSearchResult['candidates'][number] {
  const lastTradeTime = w.lastActiveAt ?? null;
  return {
    ...w,
    lastTradeTime,
    activityLabel: formatActivityLabel(lastTradeTime, true),
    pumpFunTradeCount: w.pumpFunTradeCount ?? 0,
  };
}

function parseSearchIntent(query: string): {
  wantScalpers: boolean;
  wantPump: boolean;
  wantActive: boolean;
  tokens: string[];
} {
  const q = query.toLowerCase().trim();
  const tokens = q.split(/\s+/).filter(Boolean);
  return {
    wantScalpers: /scalp|frequent|high.?freq|active.?trad/.test(q),
    wantPump: /pump|migrat|launch/.test(q),
    wantActive: /active|recent|hot/.test(q) || tokens.length === 0,
    tokens,
  };
}

function matchesQuery(
  w: GmgnWalletSuggestion,
  intent: ReturnType<typeof parseSearchIntent>
): boolean {
  if (intent.tokens.length === 0) return true;
  const blob = [
    w.name,
    w.address,
    ...(w.tags ?? []),
    w.notes ?? '',
  ]
    .join(' ')
    .toLowerCase();

  // Intent keywords are filter hints, not hard name matches
  const soft = new Set([
    'active',
    'scalper',
    'scalpers',
    'pump',
    'pump.fun',
    'migration',
    'consistent',
    'trader',
    'traders',
    'wallet',
    'wallets',
    'fun',
  ]);
  const hard = intent.tokens.filter((t) => !soft.has(t));
  if (hard.length === 0) return true;
  return hard.every((t) => blob.includes(t));
}

function applyWalletFilters(
  wallets: GmgnWalletSuggestion[],
  filters: {
    minWinRate: number;
    minTrades7d: number;
    pumpFunFocus: boolean;
    maxDaysInactive: number;
    maxSniperScore?: number;
    scalperOnly?: boolean;
  },
  intent?: ReturnType<typeof parseSearchIntent>
): GmgnWalletSuggestion[] {
  const now = Date.now();
  const pumpFocus = filters.pumpFunFocus || intent?.wantPump;
  const scalperOnly = filters.scalperOnly || intent?.wantScalpers;
  const maxSniper = filters.maxSniperScore;

  return wallets.filter((w) => {
    if (w.winRate < filters.minWinRate) return false;

    const trades7d = w.tradesLast7d ?? w.tradeCount ?? 0;
    const minTrades = scalperOnly
      ? Math.max(filters.minTrades7d, 20)
      : filters.minTrades7d;
    if (trades7d < minTrades) return false;

    if (w.lastActiveAt != null) {
      const days = (now - w.lastActiveAt) / MS_PER_DAY;
      if (days > filters.maxDaysInactive) return false;
    } else if (intent?.wantActive || scalperOnly) {
      // Allow curated without timestamp when not forcing "active"
      if (w.source !== 'curated') return false;
    }

    if (pumpFocus) {
      const tags = (w.tags ?? []).map((t) => t.toLowerCase());
      const hasPump =
        (w.pumpFunTradeCount ?? 0) > 0 ||
        tags.some((t) => t.includes('pump') || t.includes('migrat'));
      if (!hasPump) return false;
    }

    if (scalperOnly) {
      const tags = (w.tags ?? []).map((t) => t.toLowerCase());
      const isScalper =
        tags.includes('scalper') ||
        trades7d >= Math.max(filters.minTrades7d, 20);
      if (!isScalper) return false;
    }

    // Soft sniper filter: exclude sniper-heavy wallets when maxSniperScore set
    if (maxSniper != null && maxSniper > 0) {
      const tags = (w.tags ?? []).map((t) => t.toLowerCase());
      const sniperTag = tags.includes('sniper');
      // Heuristic score: sniper tag ≈ 80, otherwise 0
      const score = sniperTag ? 80 : 0;
      if (score > maxSniper) return false;
    }

    if (intent && !matchesQuery(w, intent)) return false;
    return true;
  });
}

/**
 * Search top active traders with advanced filters.
 * Defaults: trades 7d > 20, win rate > 45%, optional Pump.fun focus.
 * Always merges curated + already-tracked wallets so discovery works offline.
 */
export async function searchWallets(
  filters: WalletSearchFilters = {}
): Promise<WalletSearchResult> {
  const query = (filters.query ?? '').trim();
  const intent = parseSearchIntent(query);
  const period: GmgnPeriod = filters.period ?? '7d';
  const limit = Math.min(Math.max(filters.limit ?? 20, 1), 100);
  const disc = config.gmgn?.discovery;
  const minWinRate = filters.minWinRate ?? disc?.minWinRate ?? 45;
  const minTrades7d = filters.minTrades7d ?? disc?.minTrades7d ?? 20;
  const pumpFunFocus =
    filters.pumpFunFocus ?? disc?.pumpFunFocus ?? intent.wantPump;
  const maxDaysInactive =
    filters.maxDaysInactive ??
    filters.activityDays ??
    disc?.activityDays ??
    (intent.wantActive ? 7 : 14);
  const maxSniperScore =
    filters.maxSniperScore ?? disc?.maxSniperScore ?? undefined;
  const scalperOnly = filters.scalperOnly ?? intent.wantScalpers;

  const resolved = {
    minWinRate,
    minTrades7d,
    pumpFunFocus,
    maxDaysInactive,
    period,
    limit,
  };

  let topError: string | undefined;
  let top: TopWalletsResult;
  try {
    top = await getTopSmartWallets(
      Math.max(limit * 2, 40),
      period,
      Math.min(minWinRate, 40)
    );
    if (top.error) topError = top.error;
  } catch (err) {
    topError = err instanceof Error ? err.message : String(err);
    top = curatedTop(Math.max(limit * 2, 40), period, Math.min(minWinRate, 40));
    top.error = topError;
  }

  const tracked = new Set(config.smartWallets.map((w) => w.address));
  const fromTracked: GmgnWalletSuggestion[] = config.smartWallets.map((w) => ({
    name: w.name,
    address: w.address,
    winRate: w.winRate ?? 0,
    tradesLast7d: w.tradesLast7d,
    tradeCount: w.tradesLast30d,
    pumpFunTradeCount: w.pumpFunTradeCount,
    lastActiveAt: w.lastTradedAt ?? w.lastActive,
    tags: w.tags ?? [],
    source: 'curated' as const,
    alreadyTracked: true,
    period,
    notes: w.notes,
  }));

  const pool: GmgnWalletSuggestion[] = [
    ...top.wallets,
    ...fromTracked,
    ...CURATED_SMART_WALLETS.map((w) => ({
      ...w,
      alreadyTracked: tracked.has(w.address),
      period,
    })),
  ];

  const byAddr = new Map<string, GmgnWalletSuggestion>();
  for (const w of pool) {
    const prev = byAddr.get(w.address);
    if (!prev || (prev.source === 'curated' && w.source === 'gmgn')) {
      byAddr.set(w.address, {
        ...w,
        alreadyTracked: tracked.has(w.address),
      });
    }
  }

  const filteredStrict = applyWalletFilters(
    [...byAddr.values()],
    {
      minWinRate,
      minTrades7d,
      pumpFunFocus,
      maxDaysInactive,
      maxSniperScore,
      scalperOnly,
    },
    intent
  );

  let filtered = filteredStrict;
  // Progressive relaxation so discovery never collapses to 0–2 wallets
  if (filtered.length < Math.min(8, limit)) {
    console.warn(
      `[gmgn] searchWallets strict matched ${filtered.length} — relaxing filters`
    );
    filtered = applyWalletFilters(
      [...byAddr.values()],
      {
        minWinRate: Math.max(25, minWinRate - 15),
        minTrades7d: Math.max(5, Math.floor(minTrades7d / 2)),
        pumpFunFocus: false,
        maxDaysInactive: Math.max(maxDaysInactive, 21),
        maxSniperScore: undefined,
        scalperOnly: false,
      },
      intent
    );
  }

  filtered = filtered
    .sort((a, b) => {
      const aT = a.lastActiveAt ?? 0;
      const bT = b.lastActiveAt ?? 0;
      if (bT !== aT) return bT - aT;
      const aTr = a.tradesLast7d ?? 0;
      const bTr = b.tradesLast7d ?? 0;
      if (bTr !== aTr) return bTr - aTr;
      return b.winRate - a.winRate;
    })
    .slice(0, limit);

  console.log(
    `[gmgn] searchWallets pool=${byAddr.size} strict=${filteredStrict.length} final=${filtered.length} pumpFocus=${pumpFunFocus}`
  );

  for (const w of filtered) {
    const trades = w.tradesLast7d ?? 0;
    if (trades >= 20 && !(w.tags ?? []).includes('scalper')) {
      w.tags = [...(w.tags ?? []), 'scalper'];
    }
  }

  const candidates = filtered.map(enrichCandidate);
  const suggestedScalpers = applyWalletFilters(
    [...byAddr.values()],
    {
      minWinRate: Math.max(minWinRate, 45),
      minTrades7d: Math.max(minTrades7d, 20),
      pumpFunFocus: false,
      maxDaysInactive: Math.min(maxDaysInactive, 7),
      maxSniperScore: maxSniperScore ?? 50,
      scalperOnly: true,
    },
    { wantScalpers: true, wantPump: false, wantActive: true, tokens: [] }
  )
    .sort((a, b) => (b.tradesLast7d ?? 0) - (a.tradesLast7d ?? 0))
    .slice(0, Math.min(10, limit))
    .map(enrichCandidate);

  const source: WalletSearchResult['source'] =
    candidates.length === 0
      ? top.source === 'gmgn'
        ? 'gmgn'
        : 'curated'
      : candidates.every((c) => c.source === 'curated')
        ? 'curated'
        : candidates.every((c) => c.source === 'gmgn')
          ? 'gmgn'
          : 'mixed';

  const errNote = topError ? ` · warning: ${topError}` : '';
  const message =
    candidates.length === 0
      ? `No wallets matched filters (minWin ${minWinRate}%, minTrades7d ${minTrades7d}, activity ≤${maxDaysInactive}d)${errNote}`
      : `Found ${candidates.length} wallet(s) from ${source}${top.cached ? ' (cache)' : ''}` +
        (query ? ` for "${query}"` : '') +
        ` · ${suggestedScalpers.length} scalper suggestion(s)${errNote}`;

  touchDiscovery({
    lastWalletCount: candidates.length,
    lastSource:
      source === 'curated'
        ? 'curated'
        : source === 'mixed'
          ? 'mixed'
          : 'gmgn',
    lastError: topError ?? null,
    autoRefreshMs: config.gmgn?.discovery?.autoRefreshMs ?? 0,
  });

  return {
    query,
    filters: resolved,
    candidates,
    suggestedScalpers,
    source,
    fetchedAt: Date.now(),
    message,
  };
}

/** Auto-suggest consistent scalpers (trades7d>20, win>45%, recent) */
export async function suggestConsistentScalpers(
  limit = 10
): Promise<WalletSearchResult> {
  const disc = config.gmgn?.discovery;
  return searchWallets({
    query: 'consistent scalpers',
    minWinRate: disc?.minWinRate ?? 45,
    minTrades7d: Math.max(disc?.minTrades7d ?? 20, 20),
    pumpFunFocus: false,
    maxDaysInactive: Math.min(disc?.activityDays ?? 7, 7),
    maxSniperScore: disc?.maxSniperScore ?? 50,
    scalperOnly: true,
    period: '7d',
    limit,
  });
}

/** Warm GMGN rank cache on an interval so discovery stays fresh */
export function startDiscoveryAutoRefresh(): void {
  const ms = config.gmgn?.discovery?.autoRefreshMs ?? 0;
  discoveryStatus.autoRefreshMs = ms;
  if (discoveryTimer) {
    clearInterval(discoveryTimer);
    discoveryTimer = null;
  }
  if (ms <= 0) {
    console.log('[gmgn] Discovery auto-refresh disabled');
    return;
  }
  console.log(`[gmgn] Discovery auto-refresh every ${Math.round(ms / 1000)}s`);
  discoveryTimer = setInterval(() => {
    const disc = config.gmgn?.discovery;
    void getTopSmartWallets(
      20,
      '7d',
      disc?.minWinRate ?? 45
    ).catch((err) => {
      console.warn(
        '[gmgn] Auto-refresh failed:',
        err instanceof Error ? err.message : err
      );
    });
  }, ms);
  // Unref so it doesn't keep the process alive alone in tests
  if (typeof discoveryTimer === 'object' && 'unref' in discoveryTimer) {
    (discoveryTimer as NodeJS.Timeout).unref?.();
  }
}

export function stopDiscoveryAutoRefresh(): void {
  if (discoveryTimer) {
    clearInterval(discoveryTimer);
    discoveryTimer = null;
  }
}

export function updateDiscoveryConfig(
  partial: Partial<NonNullable<typeof config.gmgn.discovery>>
): typeof config.gmgn.discovery {
  Object.assign(config.gmgn.discovery, partial);
  if (partial.autoRefreshMs != null) {
    startDiscoveryAutoRefresh();
  }
  discoveryStatus.autoRefreshMs = config.gmgn.discovery.autoRefreshMs;
  persistUserSettings();
  return { ...config.gmgn.discovery };
}

/** Clear GMGN caches (useful after config changes) */
export function clearGmgnCache(): void {
  activityCache.clear();
  topWalletsCache.clear();
  sniperCache.clear();
  sniperInflight.clear();
  rateLimitedUntil = 0;
  consecutiveErrors = 0;
  console.log('[gmgn] Cache cleared');
}

export function getGmgnStatus() {
  const hasApiKey = Boolean(getGmgnApiKey());
  const lastError = discoveryStatus.lastError;
  let setupHint: string | null = null;
  if (!hasApiKey) {
    setupHint =
      'Set GMGN_API_KEY on Render (Environment) or in .env. Without a key, GMGN.ai is Cloudflare-blocked and discovery falls back to Kolscan/curated. Get a key at https://gmgn.ai/ai';
  } else if (lastError && /403|401|cloudflare|cf-|blocked|AUTH_/i.test(lastError)) {
    setupHint =
      'GMGN key present but requests are rejected. Use GMGN_BASE_URL=https://openapi.gmgn.ai (not api.gmgn.ai / gmgn.ai web). Confirm the key is valid and egress is IPv4.';
  } else if ((discoveryStatus.consecutiveFailures ?? 0) >= 3) {
    setupHint =
      'GMGN is failing repeatedly — use Discover source "All sources" or "Kolscan" until the API recovers.';
  }
  return {
    hasApiKey,
    baseUrl: getGmgnBaseUrl(),
    baseUrls: getGmgnBaseUrls(),
    cacheTtlMs: cacheTtlMs(),
    activityCacheSize: activityCache.size,
    topCacheSize: topWalletsCache.size,
    sniperCacheSize: sniperCache.size,
    rateLimitedUntil:
      rateLimitedUntil > Date.now() ? rateLimitedUntil : null,
    discovery: { ...discoveryStatus },
    discoveryConfig: { ...config.gmgn.discovery },
    setupHint,
    ok: hasApiKey && (discoveryStatus.consecutiveFailures ?? 0) < 3,
  };
}

/** Human-readable activity label e.g. "Active 2d ago" */
export function formatActivityLabel(
  lastTradeTime: number | null | undefined,
  isActive?: boolean
): string {
  if (lastTradeTime == null) return 'Never traded';
  const days = (Date.now() - lastTradeTime) / MS_PER_DAY;
  if (days < 1 / 24) return 'Active just now';
  if (days < 1) {
    const hours = Math.max(1, Math.round(days * 24));
    return `Active ${hours}h ago`;
  }
  const d = Math.round(days * 10) / 10;
  if (isActive === false || days > config.filters.minActivityDays) {
    return `Inactive ${d}d ago`;
  }
  return `Active ${d}d ago`;
}

// ---------------------------------------------------------------------------
// Sniper / bundler / insider detection
// ---------------------------------------------------------------------------

function asPct(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  // GMGN often returns 0–1 ratios
  const pct = n <= 1 ? n * 100 : n;
  return Math.round(pct * 10) / 10;
}

function asCount(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function asBool(raw: unknown): boolean | null {
  if (raw === true || raw === 'true' || raw === 'yes' || raw === 1) return true;
  if (raw === false || raw === 'false' || raw === 'no' || raw === 0) return false;
  return null;
}

/** Thresholds by sensitivity (overridable via config.filters) */
export function getSniperThresholds(
  sensitivity?: SniperSensitivity
): SniperThresholds {
  const s =
    sensitivity ??
    (config.filters.sniperSensitivity as SniperSensitivity) ??
    'medium';
  const base: Record<SniperSensitivity, SniperThresholds> = {
    low: {
      maxSniperCount: 40,
      maxBundlerPct: 50,
      maxInsiderPct: 40,
      maxSniperScore: 85,
      maxTop70SniperHoldPct: 45,
    },
    medium: {
      maxSniperCount: 20,
      maxBundlerPct: 30,
      maxInsiderPct: 25,
      maxSniperScore: 70,
      maxTop70SniperHoldPct: 30,
    },
    high: {
      maxSniperCount: 10,
      maxBundlerPct: 20,
      maxInsiderPct: 15,
      maxSniperScore: 55,
      maxTop70SniperHoldPct: 20,
    },
  };
  const t = { ...base[s] };
  const f = config.filters;
  if (f.maxSniperCount != null && f.maxSniperCount > 0) {
    t.maxSniperCount = f.maxSniperCount;
  }
  if (f.maxBundlerPct != null && f.maxBundlerPct > 0) {
    t.maxBundlerPct = f.maxBundlerPct;
  }
  if (f.maxInsiderPct != null && f.maxInsiderPct > 0) {
    t.maxInsiderPct = f.maxInsiderPct;
  }
  if (f.maxSniperScore != null && f.maxSniperScore > 0) {
    t.maxSniperScore = f.maxSniperScore;
  }
  return t;
}

function emptySniper(mint: string, error?: string): GmgnSniperReport {
  return {
    mint,
    sniperCount: null,
    bundlerPct: null,
    insiderPct: null,
    ratTraderPct: null,
    top70SniperHoldPct: null,
    suspectedInsiderHoldPct: null,
    freshWalletPct: null,
    washTrading: null,
    sniperScore: 0,
    warnings: error ? [error] : [],
    highRisk: false,
    source: 'none',
    fetchedAt: Date.now(),
    error,
  };
}

function computeSniperScore(partial: {
  sniperCount: number | null;
  bundlerPct: number | null;
  insiderPct: number | null;
  top70SniperHoldPct: number | null;
  washTrading: boolean | null;
}): number {
  let score = 0;
  if (partial.sniperCount != null) {
    // 0 → 0, 20 → ~40, 40+ → ~60
    score += Math.min(60, (partial.sniperCount / 20) * 40);
  }
  if (partial.bundlerPct != null) {
    score += Math.min(35, partial.bundlerPct * 0.7);
  }
  if (partial.insiderPct != null) {
    score += Math.min(35, partial.insiderPct * 0.8);
  }
  if (partial.top70SniperHoldPct != null) {
    score += Math.min(25, partial.top70SniperHoldPct * 0.5);
  }
  if (partial.washTrading) score += 20;
  return Math.min(100, Math.round(score));
}

/** Build warning strings from sniper metrics */
export function getSniperWarnings(
  report: GmgnSniperReport,
  thresholds?: SniperThresholds
): string[] {
  const t = thresholds ?? getSniperThresholds();
  const warnings: string[] = [];
  if (report.sniperCount != null && report.sniperCount > t.maxSniperCount) {
    warnings.push(
      `High sniper count (${report.sniperCount} > ${t.maxSniperCount})`
    );
  } else if (report.sniperCount != null && report.sniperCount >= 5) {
    warnings.push(`${report.sniperCount} sniper wallets at launch`);
  }
  if (report.bundlerPct != null && report.bundlerPct > t.maxBundlerPct) {
    warnings.push(
      `High bundler activity (${report.bundlerPct.toFixed(0)}% > ${t.maxBundlerPct}%)`
    );
  }
  if (report.insiderPct != null && report.insiderPct > t.maxInsiderPct) {
    warnings.push(
      `High insider/rat volume (${report.insiderPct.toFixed(0)}% > ${t.maxInsiderPct}%)`
    );
  }
  if (
    report.top70SniperHoldPct != null &&
    report.top70SniperHoldPct > t.maxTop70SniperHoldPct
  ) {
    warnings.push(
      `Snipers still hold ${report.top70SniperHoldPct.toFixed(0)}% (top70)`
    );
  }
  if (report.washTrading) warnings.push('Wash trading detected');
  if (report.sniperScore >= t.maxSniperScore) {
    warnings.push(
      `Sniper score ${report.sniperScore} ≥ ${t.maxSniperScore}`
    );
  }
  return warnings;
}

function parseSniperFromRow(
  mint: string,
  row: Record<string, unknown>,
  source: GmgnSniperReport['source']
): GmgnSniperReport {
  const stat = (row.stat ?? row.security ?? row) as Record<string, unknown>;
  const tags = (row.wallet_tags_stat ?? row.walletTagsStat ?? {}) as Record<
    string,
    unknown
  >;
  const security = (row.security ?? row) as Record<string, unknown>;

  const sniperCount =
    asCount(stat.sniper_count) ??
    asCount(security.sniper_count) ??
    asCount(row.sniper_count) ??
    asCount(tags.sniper_wallets) ??
    asCount(tags.sniper);

  const bundlerPct =
    asPct(stat.bundler_trader_amount_rate) ??
    asPct(stat.top_bundler_trader_percentage) ??
    asPct(stat.bundler_rate) ??
    asPct(security.bundler_trader_amount_rate) ??
    asPct(row.bundler_trader_amount_rate) ??
    asPct(row.bundler_rate);

  const ratPct =
    asPct(stat.rat_trader_amount_rate) ??
    asPct(stat.top_rat_trader_percentage) ??
    asPct(security.rat_trader_amount_rate) ??
    asPct(row.rat_trader_amount_rate);

  const insiderPct =
    asPct(stat.suspected_insider_hold_rate) ??
    asPct(security.suspected_insider_hold_rate) ??
    asPct(row.suspected_insider_hold_rate) ??
    asPct(row.insider_rate) ??
    ratPct;

  const top70SniperHoldPct =
    asPct(stat.top70_sniper_hold_rate) ??
    asPct(security.top70_sniper_hold_rate) ??
    asPct(row.top70_sniper_hold_rate);

  const freshWalletPct =
    asPct(stat.fresh_wallet_rate) ?? asPct(row.fresh_wallet_rate);

  const washTrading =
    asBool(stat.is_wash_trading) ??
    asBool(security.is_wash_trading) ??
    asBool(row.is_wash_trading) ??
    asBool(row.wash_trading);

  const sniperScore = computeSniperScore({
    sniperCount,
    bundlerPct,
    insiderPct,
    top70SniperHoldPct,
    washTrading,
  });

  const draft: GmgnSniperReport = {
    mint,
    sniperCount,
    bundlerPct,
    insiderPct,
    ratTraderPct: ratPct,
    top70SniperHoldPct,
    suspectedInsiderHoldPct: asPct(stat.suspected_insider_hold_rate),
    freshWalletPct,
    washTrading,
    sniperScore,
    warnings: [],
    highRisk: false,
    source,
    fetchedAt: Date.now(),
  };

  const thresholds = getSniperThresholds();
  draft.warnings = getSniperWarnings(draft, thresholds);
  draft.highRisk =
    draft.sniperScore >= thresholds.maxSniperScore ||
    (draft.sniperCount != null &&
      draft.sniperCount > thresholds.maxSniperCount) ||
    (draft.bundlerPct != null && draft.bundlerPct > thresholds.maxBundlerPct) ||
    (draft.insiderPct != null && draft.insiderPct > thresholds.maxInsiderPct);

  return draft;
}

/**
 * Detect sniper / bundler / insider activity for a mint via GMGN.
 * Tries OpenAPI `/v1/token/security` (API key) then public quotation paths.
 */
export async function getTokenSniperActivity(
  mint: string,
  options: { force?: boolean } = {}
): Promise<GmgnSniperReport> {
  if (!isValidAddress(mint)) {
    return emptySniper(mint, 'Invalid mint');
  }

  const now = Date.now();
  if (!options.force) {
    const cached = sniperCache.get(mint);
    if (cached && cached.expiresAt > now) {
      return { ...cached.data, source: 'cache' };
    }
    const pending = sniperInflight.get(mint);
    if (pending) return pending;
  }

  const job = (async () => {
    try {
      const report = await fetchSniperFromGmgn(mint);
      sniperCache.set(mint, {
        data: report,
        expiresAt: Date.now() + Math.min(cacheTtlMs(), 90_000),
      });
      return report;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const fail = emptySniper(mint, message);
      sniperCache.set(mint, {
        data: fail,
        expiresAt: Date.now() + 20_000,
      });
      return fail;
    } finally {
      sniperInflight.delete(mint);
    }
  })();

  sniperInflight.set(mint, job);
  return job;
}

async function fetchSniperFromGmgn(mint: string): Promise<GmgnSniperReport> {
  // Prefer OpenAPI when key present
  const openApiBases = [
    process.env.GMGN_OPENAPI_URL?.trim(),
    GMGN_OPENAPI_HOST,
    getGmgnBaseUrl(),
  ].filter(Boolean) as string[];

  const openPaths = [
    `/v1/token/security?chain=sol&address=${mint}`,
    `/v1/token/info?chain=sol&address=${mint}`,
  ];

  for (const base of openApiBases) {
    for (const path of openPaths) {
      const url = `${base.replace(/\/$/, '')}${path}`;
      const res = await gmgnFetch(url);
      if (!res.ok || !res.data) continue;
      const root = res.data as Record<string, unknown>;
      const row = (root.data ?? root) as Record<string, unknown>;
      if (!row || typeof row !== 'object') continue;
      const parsed = parseSniperFromRow(mint, row, 'openapi');
      if (hasAnySniperSignal(parsed)) {
        console.log(
          `[gmgn] Sniper ${mint.slice(0, 8)}… score=${parsed.sniperScore} ` +
            `snipers=${parsed.sniperCount ?? '?'} bundler=${parsed.bundlerPct ?? '?'}% ` +
            `insider=${parsed.insiderPct ?? '?'}%`
        );
        return parsed;
      }
    }
  }

  // Public quotation / web endpoints (best-effort)
  const publicPaths = [
    `/defi/quotation/v1/tokens/sol/${mint}`,
    `/api/v1/mutil_window_token_info_launchpad/sol/${mint}`,
    `/defi/quotation/v1/tokens/sol/security/${mint}`,
    `/vas/api/v1/token_stat/sol/${mint}`,
  ];

  for (const path of publicPaths) {
    const res = await gmgnFetch(path);
    if (!res.ok || !res.data) continue;
    const root = res.data as Record<string, unknown>;
    const row = (root.data ?? root) as Record<string, unknown>;
    if (!row || typeof row !== 'object') continue;
    const parsed = parseSniperFromRow(mint, row, 'gmgn');
    if (hasAnySniperSignal(parsed)) {
      console.log(
        `[gmgn] Sniper ${mint.slice(0, 8)}… score=${parsed.sniperScore} ` +
          `snipers=${parsed.sniperCount ?? '?'} bundler=${parsed.bundlerPct ?? '?'}%`
      );
      return parsed;
    }
  }

  return emptySniper(mint, 'Sniper data unavailable');
}

function hasAnySniperSignal(r: GmgnSniperReport): boolean {
  return (
    r.sniperCount != null ||
    r.bundlerPct != null ||
    r.insiderPct != null ||
    r.top70SniperHoldPct != null ||
    r.washTrading != null ||
    r.sniperScore > 0
  );
}

/** Compact payload for dashboard / anti-rug */
export function summarizeSniper(report: GmgnSniperReport): {
  sniperScore: number;
  sniperCount: number | null;
  bundlerPct: number | null;
  insiderPct: number | null;
  highRisk: boolean;
  warnings: string[];
  source: string;
} {
  return {
    sniperScore: report.sniperScore,
    sniperCount: report.sniperCount,
    bundlerPct: report.bundlerPct,
    insiderPct: report.insiderPct,
    highRisk: report.highRisk,
    warnings: report.warnings.slice(0, 4),
    source: report.source,
  };
}

/** Whether buy should be skipped given current sniper filter config */
export function shouldSkipForSnipers(report: GmgnSniperReport): {
  skip: boolean;
  reason?: string;
} {
  if (config.filters.enableSniperFilter === false) {
    return { skip: false };
  }
  if (report.source === 'none') {
    // Fail-open when data missing (network / no key)
    return { skip: false };
  }
  if (!report.highRisk) return { skip: false };

  const top =
    report.warnings[0] ||
    `sniper score ${report.sniperScore}`;
  return {
    skip: true,
    reason: `Skipped - heavy sniper/bundler activity (${top})`,
  };
}
