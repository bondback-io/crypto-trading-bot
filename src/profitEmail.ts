/**
 * Configurable profit trade emails — instant and/or clustered summaries.
 * Additive; uses sendCustomEmail. DATA_DIR/profit-email-queue.json
 */

import {
  atomicWriteJson,
  dataFile,
  ensureDataDir,
  readJsonFile,
} from './dataDir';
import { config } from './config';
import { logger, errorToMeta } from './logger';

export type ProfitEmailMode = 'instant' | 'cluster' | 'both';
export type ProfitEmailClusterInterval =
  | '1h'
  | '2h'
  | '4h'
  | '12h'
  | '24h';

export const PROFIT_EMAIL_MODES: readonly ProfitEmailMode[] = [
  'instant',
  'cluster',
  'both',
] as const;

export const PROFIT_EMAIL_INTERVALS: readonly ProfitEmailClusterInterval[] = [
  '1h',
  '2h',
  '4h',
  '12h',
  '24h',
] as const;

const DEFAULT_TO = 'bondback2026@gmail.com';
const QUEUE_FILE = () => dataFile('profit-email-queue.json');
const TICK_MS = 30_000;
const MAX_QUEUE = 200;

const INTERVAL_MS: Record<ProfitEmailClusterInterval, number> = {
  '1h': 1 * 60 * 60 * 1000,
  '2h': 2 * 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

const INTERVAL_LABEL: Record<ProfitEmailClusterInterval, string> = {
  '1h': 'Last 1 Hour',
  '2h': 'Last 2 Hours',
  '4h': 'Last 4 Hours',
  '12h': 'Last 12 Hours',
  '24h': 'Last 24 Hours',
};

export interface ProfitEmailTradeEvent {
  id: string;
  at: number;
  closedAt: number;
  mint: string;
  symbol: string;
  name?: string;
  profileName?: string;
  pnlSol: number;
  pnlPct: number;
  mode: string;
  reason?: string;
}

interface ProfitEmailQueueFile {
  version: 1;
  windowStartMs: number;
  lastFlushAtMs: number | null;
  events: ProfitEmailTradeEvent[];
}

let timer: ReturnType<typeof setInterval> | null = null;
let flushInFlight = false;

function normalizeMode(v: unknown): ProfitEmailMode {
  const s = String(v || '').toLowerCase();
  if (s === 'cluster' || s === 'both' || s === 'instant') return s;
  return 'instant';
}

function normalizeInterval(v: unknown): ProfitEmailClusterInterval {
  const s = String(v || '').toLowerCase();
  if (
    s === '1h' ||
    s === '2h' ||
    s === '4h' ||
    s === '12h' ||
    s === '24h'
  ) {
    return s;
  }
  return '1h';
}

export function getProfitEmailMode(): ProfitEmailMode {
  return normalizeMode(config.notifications?.profitEmailMode);
}

export function getProfitEmailClusterInterval(): ProfitEmailClusterInterval {
  return normalizeInterval(config.notifications?.profitEmailClusterInterval);
}

export function getProfitEmailRecipient(): string {
  const override = String(config.notifications?.profitEmailTo || '').trim();
  if (override.includes('@')) return override.slice(0, 200);
  const fallback = String(config.notifications?.email || '').trim();
  if (fallback.includes('@')) return fallback;
  return DEFAULT_TO;
}

function profitEmailsEnabled(): boolean {
  const n = config.notifications;
  return n?.enabled !== false && n?.profitableCloseEnabled !== false;
}

function wantsInstant(mode: ProfitEmailMode): boolean {
  return mode === 'instant' || mode === 'both';
}

function wantsCluster(mode: ProfitEmailMode): boolean {
  return mode === 'cluster' || mode === 'both';
}

function modeLabel(mode: string): string {
  const m = String(mode || '').toLowerCase();
  if (m === 'live') return 'Live Mode';
  if (m === 'livesimulation' || m === 'live_simulation' || m === 'live-sim') {
    return 'Live Sim Mode';
  }
  if (m === 'paper') return 'Paper Mode';
  return mode || 'Unknown Mode';
}

function emptyQueue(): ProfitEmailQueueFile {
  return {
    version: 1,
    windowStartMs: Date.now(),
    lastFlushAtMs: null,
    events: [],
  };
}

function loadQueue(): ProfitEmailQueueFile {
  ensureDataDir();
  const raw = readJsonFile<ProfitEmailQueueFile>(QUEUE_FILE());
  if (!raw || raw.version !== 1 || !Array.isArray(raw.events)) {
    return emptyQueue();
  }
  return {
    version: 1,
    windowStartMs: Number(raw.windowStartMs) || Date.now(),
    lastFlushAtMs:
      raw.lastFlushAtMs != null && Number.isFinite(Number(raw.lastFlushAtMs))
        ? Number(raw.lastFlushAtMs)
        : null,
    events: raw.events.slice(-MAX_QUEUE),
  };
}

function saveQueue(q: ProfitEmailQueueFile): void {
  ensureDataDir();
  atomicWriteJson(QUEUE_FILE(), {
    ...q,
    events: q.events.slice(-MAX_QUEUE),
  });
}

async function resolveSolUsd(): Promise<number | null> {
  try {
    const { fetchSolUsdPrice, getCachedSolUsdPrice } =
      require('./marketData') as typeof import('./marketData');
    const live = await fetchSolUsdPrice();
    if (live > 0 && Number.isFinite(live)) return live;
    const cached = getCachedSolUsdPrice();
    return cached > 0 ? cached : null;
  } catch {
    return null;
  }
}

function esc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatUsd(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return 'USD unavailable';
  const sign = n > 0 ? '+' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function formatSolSigned(n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(4)} SOL`;
}

function buildInstantHtml(input: {
  label: string;
  profileName?: string;
  pnlSol: number;
  pnlPct: number;
  pnlUsd: number | null;
  solUsd: number | null;
  mode: string;
  closedAt: number;
  reason?: string;
}): string {
  const modeTag = modeLabel(input.mode);
  const closed = new Date(input.closedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const usdLine =
    input.pnlUsd != null
      ? formatUsd(input.pnlUsd)
      : 'USD unavailable';
  const solPx =
    input.solUsd != null
      ? `$${input.solUsd.toFixed(2)}`
      : 'unavailable';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>ZION Profit</title></head>
<body style="margin:0;padding:0;background:#0b1220;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#e8eefc;">
<div style="max-width:640px;margin:0 auto;padding:20px;">
  <div style="background:linear-gradient(135deg,#1a2744,#122033);border:1px solid #2b3b5c;border-radius:16px;padding:20px 22px;margin-bottom:16px;">
    <div style="font-size:12px;letter-spacing:1px;color:#8fb0ff;text-transform:uppercase;margin-bottom:6px;">ZION Profit Alert</div>
    <div style="font-size:22px;font-weight:700;color:#ffffff;margin-bottom:6px;">${esc(input.label)}</div>
    <div style="font-size:13px;color:#9db0d0;">${esc(modeTag)} · Closed ${esc(closed)}</div>
  </div>
  <div style="background:#121a2b;border:1px solid #2b3b5c;border-radius:16px;padding:18px 20px;margin-bottom:16px;">
    <div style="font-size:22px;font-weight:700;color:#3dffb5;">${esc(formatSolSigned(input.pnlSol))} · ${esc(usdLine)}</div>
    <div style="font-size:13px;color:#9db0d0;margin-top:8px;">${input.pnlPct.toFixed(1)}% · Profile: ${esc(input.profileName || '—')}</div>
    <div style="font-size:12px;color:#9db0d0;margin-top:8px;">SOL Price Used: <strong style="color:#e8eefc;">${esc(solPx)}</strong></div>
    ${input.reason ? `<div style="font-size:12px;color:#9db0d0;margin-top:6px;">Exit: ${esc(input.reason)}</div>` : ''}
  </div>
  <div style="text-align:center;font-size:12px;color:#7f91b3;line-height:1.5;padding:8px 6px 20px;">
    ZION · Zeal, Insight, Order, Navigation<br/>Instant profit alert
  </div>
</div></body></html>`;
}

function buildClusterHtml(input: {
  periodLabel: string;
  events: ProfitEmailTradeEvent[];
  solUsd: number | null;
  to: string;
  modeHint: string;
  windowStartMs: number;
  windowEndMs: number;
}): { html: string; text: string; totalSol: number; totalUsd: number | null } {
  const totalSol = input.events.reduce((s, e) => s + (e.pnlSol || 0), 0);
  const totalUsd =
    input.solUsd != null && input.solUsd > 0
      ? totalSol * input.solUsd
      : null;
  const solPx =
    input.solUsd != null ? `$${input.solUsd.toFixed(2)}` : 'unavailable';

  const rows = input.events
    .slice()
    .sort((a, b) => a.closedAt - b.closedAt)
    .map((e) => {
      const label = e.name
        ? `${e.symbol} · ${e.name}`
        : e.symbol || e.mint.slice(0, 8);
      const closed = new Date(e.closedAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
      const usd =
        input.solUsd != null && input.solUsd > 0
          ? formatUsd(e.pnlSol * input.solUsd)
          : 'USD unavailable';
      return `<div style="background:#0e1626;border-radius:12px;padding:14px;margin-bottom:10px;">
        <div style="font-size:15px;font-weight:700;color:#ffffff;">${esc(label)}</div>
        <div style="font-size:12px;color:#9db0d0;margin-top:3px;">Profile: ${esc(e.profileName || '—')} · Closed ${esc(closed)}</div>
        <div style="margin-top:10px;font-size:14px;color:#3dffb5;font-weight:600;">${esc(formatSolSigned(e.pnlSol))} · ${esc(usd)}</div>
      </div>`;
    })
    .join('\n');

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ZION Profit Summary</title>
</head>
<body style="margin:0;padding:0;background:#0b1220;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#e8eefc;">
  <div style="max-width:640px;margin:0 auto;padding:20px;">
    <div style="background:linear-gradient(135deg,#1a2744,#122033);border:1px solid #2b3b5c;border-radius:16px;padding:20px 22px;margin-bottom:16px;">
      <div style="font-size:12px;letter-spacing:1px;color:#8fb0ff;text-transform:uppercase;margin-bottom:6px;">ZION Profit Summary</div>
      <div style="font-size:24px;font-weight:700;color:#ffffff;margin-bottom:6px;">${esc(input.periodLabel)} Review</div>
      <div style="font-size:13px;color:#9db0d0;">Delivered to ${esc(input.to)} · ${esc(input.modeHint)}</div>
    </div>
    <div style="background:#121a2b;border:1px solid #2b3b5c;border-radius:16px;padding:18px 20px;margin-bottom:16px;">
      <div style="font-size:13px;color:#9db0d0;margin-bottom:12px;">Totals</div>
      <div style="overflow:hidden;margin-bottom:10px;">
        <div style="float:left;width:48%;background:#0e1626;border-radius:12px;padding:14px;box-sizing:border-box;">
          <div style="font-size:12px;color:#9db0d0;">Total Profit (SOL)</div>
          <div style="font-size:22px;font-weight:700;color:#3dffb5;margin-top:4px;">${esc(formatSolSigned(totalSol))}</div>
        </div>
        <div style="float:right;width:48%;background:#0e1626;border-radius:12px;padding:14px;box-sizing:border-box;">
          <div style="font-size:12px;color:#9db0d0;">Total Profit (USD)</div>
          <div style="font-size:22px;font-weight:700;color:#3dffb5;margin-top:4px;">${esc(formatUsd(totalUsd))}</div>
        </div>
      </div>
      <div style="clear:both;background:#0e1626;border-radius:12px;padding:14px;">
        <div style="font-size:12px;color:#9db0d0;">Profitable Trades</div>
        <div style="font-size:18px;font-weight:700;color:#ffffff;margin-top:4px;">${input.events.length}</div>
        <div style="font-size:12px;color:#9db0d0;margin-top:8px;">
          SOL Price Used: <strong style="color:#e8eefc;">${esc(solPx)}</strong>
        </div>
      </div>
    </div>
    <div style="background:#121a2b;border:1px solid #2b3b5c;border-radius:16px;padding:18px 20px;margin-bottom:16px;">
      <div style="font-size:13px;color:#9db0d0;margin-bottom:14px;">Individual Profitable Trades</div>
      ${rows}
    </div>
    <div style="text-align:center;font-size:12px;color:#7f91b3;line-height:1.5;padding:8px 6px 20px;">
      ZION · Zeal, Insight, Order, Navigation<br />
      Clustered profit report · ${esc(new Date(input.windowEndMs).toISOString())}<br />
      Please review in dashboard for full trade details
    </div>
  </div>
</body>
</html>`;

  const textLines = [
    `ZION Profit Summary — ${input.periodLabel}`,
    `To: ${input.to} · ${input.modeHint}`,
    `Trades: ${input.events.length}`,
    `Total: ${formatSolSigned(totalSol)} · ${formatUsd(totalUsd)}`,
    `SOL/USD: ${solPx}`,
    '',
    ...input.events.map((e) => {
      const label = e.name
        ? `${e.symbol} (${e.name})`
        : e.symbol || e.mint.slice(0, 8);
      const usd =
        input.solUsd != null
          ? formatUsd(e.pnlSol * input.solUsd)
          : 'USD n/a';
      return `• ${label} · ${e.profileName || '—'} · ${formatSolSigned(e.pnlSol)} · ${usd}`;
    }),
  ];

  return { html, text: textLines.join('\n'), totalSol, totalUsd };
}

async function sendHtmlEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { sendCustomEmail } =
    require('./emailNotifications') as typeof import('./emailNotifications');
  return sendCustomEmail({
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
  });
}

/** Record a profitable close for instant and/or cluster delivery. */
export async function handleProfitEmailClose(input: {
  symbol: string;
  name?: string;
  mint: string;
  pnlSol: number;
  pnlPct: number;
  profileName?: string;
  mode: string;
  reason?: string;
  closedAt?: number;
}): Promise<void> {
  if (!(input.pnlSol > 0)) return;
  if (!profitEmailsEnabled()) return;

  const mode = getProfitEmailMode();
  const to = getProfitEmailRecipient();
  const closedAt = input.closedAt || Date.now();
  const label = input.name
    ? `${input.symbol} (${input.name})`
    : input.symbol || input.mint.slice(0, 8);

  const event: ProfitEmailTradeEvent = {
    id: `${input.mint}-${closedAt}-${Math.random().toString(36).slice(2, 7)}`,
    at: Date.now(),
    closedAt,
    mint: input.mint,
    symbol: input.symbol,
    name: input.name,
    profileName: input.profileName,
    pnlSol: input.pnlSol,
    pnlPct: input.pnlPct,
    mode: input.mode,
    reason: input.reason,
  };

  if (wantsCluster(mode)) {
    const q = loadQueue();
    const dup = q.events.some(
      (e) =>
        e.mint === event.mint &&
        Math.abs(e.closedAt - event.closedAt) < 2_000 &&
        Math.abs(e.pnlSol - event.pnlSol) < 1e-9
    );
    if (!dup) {
      q.events.push(event);
      saveQueue(q);
    }
  }

  if (wantsInstant(mode)) {
    const solUsd = await resolveSolUsd();
    const pnlUsd =
      solUsd != null && solUsd > 0 ? input.pnlSol * solUsd : null;
    const html = buildInstantHtml({
      label,
      profileName: input.profileName,
      pnlSol: input.pnlSol,
      pnlPct: input.pnlPct,
      pnlUsd,
      solUsd,
      mode: input.mode,
      closedAt,
      reason: input.reason,
    });
    const text = [
      `ZION Profit Alert — ${label}`,
      modeLabel(input.mode),
      formatSolSigned(input.pnlSol),
      pnlUsd != null ? formatUsd(pnlUsd) : 'USD unavailable',
      `Profile: ${input.profileName || '—'}`,
      `SOL/USD: ${solUsd != null ? solUsd.toFixed(2) : 'n/a'}`,
    ].join('\n');
    const result = await sendHtmlEmail({
      to,
      subject: `[ZION] Profit — ${label} ${formatSolSigned(input.pnlSol)}`,
      text,
      html,
    });
    if (!result.ok) {
      logger.warn('Notify', `Instant profit email failed: ${result.error}`);
    }
  }
}

export async function flushProfitEmailCluster(opts?: {
  force?: boolean;
}): Promise<{
  sent: boolean;
  skipped?: string;
  count?: number;
  error?: string;
}> {
  if (flushInFlight) return { sent: false, skipped: 'in_flight' };
  if (!profitEmailsEnabled()) return { sent: false, skipped: 'disabled' };
  const mode = getProfitEmailMode();
  if (!wantsCluster(mode) && !opts?.force) {
    return { sent: false, skipped: 'mode' };
  }

  flushInFlight = true;
  try {
    const interval = getProfitEmailClusterInterval();
    const intervalMs = INTERVAL_MS[interval];
    const q = loadQueue();
    const now = Date.now();
    const dueAt =
      (q.lastFlushAtMs ?? q.windowStartMs) + intervalMs;
    if (!opts?.force && now < dueAt) {
      return { sent: false, skipped: 'not_due' };
    }

    const events = q.events.filter((e) => e.pnlSol > 0);
    if (!events.length) {
      q.events = [];
      q.windowStartMs = now;
      q.lastFlushAtMs = now;
      saveQueue(q);
      return { sent: false, skipped: 'empty', count: 0 };
    }

    const to = getProfitEmailRecipient();
    const solUsd = await resolveSolUsd();
    const modes = [...new Set(events.map((e) => modeLabel(e.mode)))];
    const modeHint =
      modes.length === 1 ? modes[0]! : `${modes.join(' + ')} (mixed)`;
    const periodLabel = INTERVAL_LABEL[interval];
    const built = buildClusterHtml({
      periodLabel,
      events,
      solUsd,
      to,
      modeHint,
      windowStartMs: q.windowStartMs,
      windowEndMs: now,
    });

    const result = await sendHtmlEmail({
      to,
      subject: `[ZION] Profit Summary — ${periodLabel} · ${formatSolSigned(built.totalSol)} · ${events.length} trade${events.length === 1 ? '' : 's'}`,
      text: built.text,
      html: built.html,
    });

    if (!result.ok) {
      logger.error('Notify', `Cluster profit email failed: ${result.error}`, {
        count: events.length,
      });
      return { sent: false, error: result.error, count: events.length };
    }

    q.events = [];
    q.windowStartMs = now;
    q.lastFlushAtMs = now;
    saveQueue(q);
    logger.info(
      'Notify',
      `Cluster profit email sent: ${events.length} trades · ${formatSolSigned(built.totalSol)}`
    );
    return { sent: true, count: events.length };
  } catch (err) {
    logger.error('Notify', 'Cluster profit flush failed', errorToMeta(err));
    return {
      sent: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    flushInFlight = false;
  }
}

export function getProfitEmailStatus(): {
  enabled: boolean;
  mode: ProfitEmailMode;
  interval: ProfitEmailClusterInterval;
  email: string;
  queued: number;
  windowStartMs: number;
  lastFlushAtMs: number | null;
  nextDueAtMs: number | null;
  schedulerRunning: boolean;
} {
  const q = loadQueue();
  const interval = getProfitEmailClusterInterval();
  const intervalMs = INTERVAL_MS[interval];
  const base = q.lastFlushAtMs ?? q.windowStartMs;
  return {
    enabled: profitEmailsEnabled(),
    mode: getProfitEmailMode(),
    interval,
    email: getProfitEmailRecipient(),
    queued: q.events.length,
    windowStartMs: q.windowStartMs,
    lastFlushAtMs: q.lastFlushAtMs,
    nextDueAtMs: wantsCluster(getProfitEmailMode())
      ? base + intervalMs
      : null,
    schedulerRunning: timer != null,
  };
}

export function startProfitEmailScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    void flushProfitEmailCluster().catch(() => undefined);
  }, TICK_MS);
  // First check shortly after boot
  setTimeout(() => {
    void flushProfitEmailCluster().catch(() => undefined);
  }, 20_000);
}

export function stopProfitEmailScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
