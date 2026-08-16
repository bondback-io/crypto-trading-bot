/**
 * PumpPortal WebSocket discovery (token create / trades / graduation).
 * Off Solana RPC — no logsSubscribe, no Trading-lane CU.
 */

import type { LaunchEvent } from './marketData';

const WS_URL = 'wss://pumpportal.fun/api/data';
const MAX_QUEUE = 200;
const EVENTS_PER_MIN_CAP = 80;
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

export type PumpStreamCategory = 'new' | 'trade_active' | 'graduated';

interface PumpStreamEvent {
  mint: string;
  symbol: string;
  name: string;
  category: PumpStreamCategory;
  at: number;
  marketCapUsd?: number;
  lastPriceSol?: number;
}

const queue: PumpStreamEvent[] = [];
const eventAt: number[] = [];
let ws: WebSocket | null = null;
let running = false;
let reconnectMs = RECONNECT_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lastError: string | null = null;
let connected = false;
let eventsAccepted = 0;
let eventsDropped = 0;

function bumpWindow(): number {
  const now = Date.now();
  eventAt.push(now);
  while (eventAt.length && now - eventAt[0] > 60_000) eventAt.shift();
  return eventAt.length;
}

function pushEvent(ev: PumpStreamEvent): void {
  if (!ev.mint) return;
  if (bumpWindow() > EVENTS_PER_MIN_CAP) {
    eventsDropped += 1;
    return;
  }
  queue.push(ev);
  eventsAccepted += 1;
  while (queue.length > MAX_QUEUE) queue.shift();
}

function coercePumpLabel(raw: unknown, fallback: string): string {
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s && !/^\[object /i.test(s)) return s;
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const nested = o.symbol || o.name || o.ticker;
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }
  return fallback;
}

function parseMsg(raw: unknown): PumpStreamEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const mint = String(
    row.mint || row.token || row.ca || row.bondingCurveKey || ''
  ).trim();
  if (!mint || mint.length < 32) return null;
  const txType = String(row.txType || row.type || row.method || '').toLowerCase();
  let category: PumpStreamCategory = 'trade_active';
  if (
    txType.includes('create') ||
    txType.includes('new') ||
    row.txType === 'create'
  ) {
    category = 'new';
  } else if (
    txType.includes('graduat') ||
    txType.includes('migrate') ||
    row.txType === 'migrate'
  ) {
    category = 'graduated';
  }
  const symbol = coercePumpLabel(row.symbol || row.ticker, mint.slice(0, 6)).slice(0, 24);
  const name = coercePumpLabel(row.name || row.symbol, 'Pump').slice(0, 64);
  const mc = Number(row.marketCapSol ?? row.usd_market_cap ?? row.marketCap);
  const px = Number(row.vSolInBondingCurve ?? row.priceSol ?? row.lastPrice);
  return {
    mint,
    symbol,
    name,
    category,
    at: Date.now(),
    marketCapUsd: Number.isFinite(mc) && mc > 0 ? mc : undefined,
    lastPriceSol: Number.isFinite(px) && px > 0 ? px : undefined,
  };
}

function scheduleReconnect(): void {
  if (!running) return;
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectMs);
  reconnectMs = Math.min(RECONNECT_MAX_MS, Math.round(reconnectMs * 1.8));
}

function connect(): void {
  if (!running) return;
  try {
    if (typeof WebSocket === 'undefined') {
      lastError = 'WebSocket unavailable';
      return;
    }
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      connected = true;
      reconnectMs = RECONNECT_MIN_MS;
      lastError = null;
      try {
        ws?.send(JSON.stringify({ method: 'subscribeNewToken' }));
        ws?.send(JSON.stringify({ method: 'subscribeMigration' }));
      } catch (err) {
        lastError = err instanceof Error ? err.message : 'subscribe failed';
      }
    };
    ws.onmessage = (ev) => {
      try {
        const data =
          typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
        const rows = Array.isArray(data) ? data : [data];
        for (const row of rows) {
          const parsed = parseMsg(row);
          if (parsed) pushEvent(parsed);
        }
      } catch {
        /* ignore malformed */
      }
    };
    ws.onerror = () => {
      lastError = 'PumpPortal WS error';
    };
    ws.onclose = () => {
      connected = false;
      ws = null;
      scheduleReconnect();
    };
  } catch (err) {
    lastError = err instanceof Error ? err.message : 'connect failed';
    scheduleReconnect();
  }
}

export function startPumpPortalStream(): void {
  if (running) return;
  running = true;
  connect();
}

export function stopPumpPortalStream(): void {
  running = false;
  connected = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  ws = null;
}

export function getPumpStreamLaunchEvents(limit = 40): LaunchEvent[] {
  const now = Date.now();
  const slice = queue.slice(-Math.max(1, limit));
  return slice.map((ev) => {
    const px = ev.lastPriceSol && ev.lastPriceSol > 0 ? ev.lastPriceSol : 0;
    return {
      mint: ev.mint,
      symbol: ev.symbol,
      name: ev.name,
      launchedAt: ev.at || now,
      migrated: ev.category === 'graduated',
      entryPriceSol: px,
      lastPriceSol: px,
      priceChangePct: 0,
      marketCapUsd: ev.marketCapUsd,
      isPumpFun: true,
      candles: [],
      source: 'pump_stream',
      scannerSources: ['pump_stream'],
      scannerCategories: [ev.category],
    };
  });
}

export function getPumpStreamStatus(): {
  running: boolean;
  connected: boolean;
  lastError: string | null;
  queue: number;
  eventsPerMin: number;
  eventsAccepted: number;
  eventsDropped: number;
} {
  const now = Date.now();
  while (eventAt.length && now - eventAt[0] > 60_000) eventAt.shift();
  return {
    running,
    connected,
    lastError,
    queue: queue.length,
    eventsPerMin: eventAt.length,
    eventsAccepted,
    eventsDropped,
  };
}
