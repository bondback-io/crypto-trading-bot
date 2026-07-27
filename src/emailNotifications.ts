/**
 * Basic email notifications (SMTP via nodemailer).
 * Disabled gracefully when SMTP is not configured — events still hit Logs.
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { config } from './config';
import { logger } from './logger';

export type NotificationKind =
  | 'lowEquity'
  | 'insufficientFunds'
  | 'profitableClose';

type CooldownMap = Partial<Record<NotificationKind, number>>;

const lastSentAt: CooldownMap = {};
let transporter: Transporter | null = null;
let transporterKey = '';

function smtpConfigured(): boolean {
  return Boolean(
    process.env.SMTP_HOST?.trim() &&
      process.env.SMTP_USER?.trim() &&
      process.env.SMTP_PASS?.trim()
  );
}

function getTransporter(): Transporter | null {
  if (!smtpConfigured()) return null;
  const host = process.env.SMTP_HOST!.trim();
  const port = Number(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER!.trim();
  const pass = process.env.SMTP_PASS!.trim();
  const secure =
    process.env.SMTP_SECURE === '1' ||
    process.env.SMTP_SECURE === 'true' ||
    port === 465;
  const key = `${host}|${port}|${user}|${secure}`;
  if (transporter && transporterKey === key) return transporter;
  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
  transporterKey = key;
  return transporter;
}

function cooldownMs(kind: NotificationKind): number {
  const n = config.notifications;
  if (kind === 'lowEquity') return Math.max(60_000, Number(n.lowEquityCooldownMs) || 6 * 3600_000);
  if (kind === 'insufficientFunds')
    return Math.max(60_000, Number(n.insufficientFundsCooldownMs) || 30 * 60_000);
  return 0; // profitable closes: always send when enabled
}

function kindEnabled(kind: NotificationKind): boolean {
  const n = config.notifications;
  if (!n?.enabled) return false;
  if (kind === 'lowEquity') return n.lowEquityEnabled !== false;
  if (kind === 'insufficientFunds') return n.insufficientFundsEnabled !== false;
  if (kind === 'profitableClose') return n.profitableCloseEnabled !== false;
  return false;
}

function underCooldown(kind: NotificationKind): boolean {
  const ms = cooldownMs(kind);
  if (ms <= 0) return false;
  const last = lastSentAt[kind] ?? 0;
  return Date.now() - last < ms;
}

function formatSol(n: number, digits = 4): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)} SOL`;
}

async function sendMail(opts: {
  subject: string;
  text: string;
  kind: NotificationKind;
}): Promise<boolean> {
  if (!kindEnabled(opts.kind)) return false;
  if (underCooldown(opts.kind)) {
    logger.info('Notify', `Skip email (${opts.kind}) — cooldown`, {
      subject: opts.subject,
    });
    return false;
  }

  const to = String(config.notifications?.email || '').trim();
  if (!to || !to.includes('@')) {
    logger.warn('Notify', 'Email notifications enabled but no valid recipient', {
      kind: opts.kind,
    });
    return false;
  }

  const transport = getTransporter();
  if (!transport) {
    logger.warn(
      'Notify',
      'Email not sent — configure SMTP_HOST / SMTP_USER / SMTP_PASS in .env',
      { kind: opts.kind, to, subject: opts.subject }
    );
    return false;
  }

  const from =
    process.env.SMTP_FROM?.trim() ||
    process.env.SMTP_USER!.trim() ||
    'crypto-trading-bot@localhost';

  try {
    await transport.sendMail({
      from,
      to,
      subject: opts.subject,
      text: opts.text,
    });
    lastSentAt[opts.kind] = Date.now();
    logger.info('Notify', `Email sent: ${opts.subject}`, { kind: opts.kind, to });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Notify', `Email failed: ${message}`, {
      kind: opts.kind,
      to,
      subject: opts.subject,
    });
    return false;
  }
}

/** Fire when total equity drops below threshold (default 1 SOL). */
export async function notifyLowEquity(input: {
  totalEquitySol: number;
  availableSol: number;
  positionsSol: number;
  openCount: number;
  mode: string;
}): Promise<void> {
  const threshold = Number(config.notifications?.lowEquitySol) || 1;
  if (!(input.totalEquitySol < threshold)) return;

  const subject = `[Bot] Total equity low — ${input.totalEquitySol.toFixed(4)} SOL`;
  const text = [
    `Total equity is below ${threshold} SOL.`,
    '',
    `Mode: ${input.mode}`,
    `Total equity: ${input.totalEquitySol.toFixed(4)} SOL`,
    `Available: ${input.availableSol.toFixed(4)} SOL`,
    `In open trades (marked): ${input.positionsSol.toFixed(4)} SOL`,
    `Open positions: ${input.openCount}`,
    '',
    'Top up paper/live-sim balance or close open trades to free capital.',
    `Time: ${new Date().toISOString()}`,
  ].join('\n');

  logger.warn(
    'Trade',
    `Low equity warning: ${input.totalEquitySol.toFixed(4)} SOL < ${threshold} SOL ` +
      `(available ${input.availableSol.toFixed(4)}, open ${input.openCount})`,
    {
      totalEquitySol: input.totalEquitySol,
      availableSol: input.availableSol,
      positionsSol: input.positionsSol,
      openCount: input.openCount,
    }
  );

  await sendMail({ subject, text, kind: 'lowEquity' });
}

/** Fire when a buy is blocked because available SOL is too low. */
export async function notifyInsufficientFunds(input: {
  neededSol: number;
  availableSol: number;
  totalEquitySol: number;
  positionsCostSol: number;
  positionsValueSol: number;
  openCount: number;
  mint?: string;
  symbol?: string;
  mode: string;
}): Promise<void> {
  const subject = `[Bot] Insufficient available funds — need ${input.neededSol.toFixed(4)} SOL`;
  const text = [
    'The bot tried to open a trade but available funds were insufficient.',
    '',
    `Mode: ${input.mode}`,
    input.symbol || input.mint
      ? `Token: ${input.symbol || ''} ${input.mint ? `(${input.mint.slice(0, 8)}…)` : ''}`.trim()
      : null,
    `Needed: ${input.neededSol.toFixed(4)} SOL`,
    `Available: ${input.availableSol.toFixed(4)} SOL`,
    `Total equity: ${input.totalEquitySol.toFixed(4)} SOL`,
    `Open trades cost: ${input.positionsCostSol.toFixed(4)} SOL`,
    `Open trades value: ${input.positionsValueSol.toFixed(4)} SOL`,
    `Open positions: ${input.openCount}`,
    '',
    'Top up available balance or close open trades to free capital for new opportunities.',
    `Time: ${new Date().toISOString()}`,
  ]
    .filter(Boolean)
    .join('\n');

  await sendMail({ subject, text, kind: 'insufficientFunds' });
}

/** Fire when a full close finishes in profit. */
export async function notifyProfitableClose(input: {
  symbol: string;
  name?: string;
  mint: string;
  pnlSol: number;
  pnlPct: number;
  costSol: number;
  reason: string;
  holdSeconds?: number;
  mode: string;
  /** Optional slice breakdown text */
  breakdown?: string;
  dailyWinRatePct: number;
  dailyPnlSol: number;
  dailyWins: number;
  dailyLosses: number;
  allTimeWinRatePct: number;
}): Promise<void> {
  if (!(input.pnlSol > 0)) return;

  const label = input.name
    ? `${input.symbol} (${input.name})`
    : input.symbol || input.mint.slice(0, 8);
  const subject = `[Bot] Profit closed — ${label} ${formatSol(input.pnlSol)} (${input.pnlPct.toFixed(1)}%)`;
  const text = [
    `Closed trade in profit.`,
    '',
    `Mode: ${input.mode}`,
    `Token: ${label}`,
    `Mint: ${input.mint}`,
    `PnL: ${formatSol(input.pnlSol)} (${input.pnlPct.toFixed(1)}%)`,
    `Cost basis: ${input.costSol.toFixed(4)} SOL`,
    `Exit reason: ${input.reason}`,
    input.holdSeconds != null
      ? `Hold time: ${Math.round(input.holdSeconds)}s`
      : null,
    input.breakdown ? `Breakdown:\n${input.breakdown}` : null,
    '',
    '— Day stats —',
    `Daily PnL: ${formatSol(input.dailyPnlSol)}`,
    `Daily win rate: ${input.dailyWinRatePct.toFixed(0)}% (${input.dailyWins}W / ${input.dailyLosses}L)`,
    `All-time win rate: ${input.allTimeWinRatePct.toFixed(0)}%`,
    '',
    `Time: ${new Date().toISOString()}`,
  ]
    .filter(Boolean)
    .join('\n');

  await sendMail({ subject, text, kind: 'profitableClose' });
}

/** Test SMTP from dashboard/API (optional). */
export async function sendTestNotificationEmail(): Promise<{
  ok: boolean;
  error?: string;
}> {
  const to = String(config.notifications?.email || '').trim();
  if (!to) return { ok: false, error: 'No notification email configured' };
  if (!smtpConfigured()) {
    return {
      ok: false,
      error: 'SMTP not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS)',
    };
  }
  // Bypass kind toggles / cooldown for explicit test
  const prev = { ...lastSentAt };
  try {
    const transport = getTransporter();
    if (!transport) return { ok: false, error: 'SMTP transport unavailable' };
    const from =
      process.env.SMTP_FROM?.trim() ||
      process.env.SMTP_USER!.trim() ||
      'crypto-trading-bot@localhost';
    await transport.sendMail({
      from,
      to,
      subject: '[Bot] Test notification',
      text: `Test email from crypto trading bot at ${new Date().toISOString()}`,
    });
    logger.info('Notify', 'Test email sent', { to });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Notify', `Test email failed: ${message}`);
    Object.assign(lastSentAt, prev);
    return { ok: false, error: message };
  }
}
