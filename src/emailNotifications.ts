/**
 * Email notifications via Resend API (preferred on Render) or SMTP (nodemailer).
 * Without either configured, events still hit Logs; send is skipped with a warning.
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { config } from './config';
import { logger } from './logger';

export type NotificationKind =
  | 'lowEquity'
  | 'insufficientFunds'
  | 'profitableClose'
  | 'zionTradeOffer'
  | 'zionTradePlaced';

type CooldownMap = Partial<Record<NotificationKind, number>>;

const lastSentAt: CooldownMap = {};
let transporter: Transporter | null = null;
let transporterKey = '';

function resendConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

function smtpConfigured(): boolean {
  return Boolean(
    process.env.SMTP_HOST?.trim() &&
      process.env.SMTP_USER?.trim() &&
      process.env.SMTP_PASS?.trim()
  );
}

/** True when at least one delivery backend is configured. */
export function emailDeliveryConfigured(): boolean {
  return resendConfigured() || smtpConfigured();
}

export function emailDeliveryStatus(): {
  configured: boolean;
  provider: 'resend' | 'smtp' | 'none';
  to: string;
  hint: string;
} {
  const to = String(config.notifications?.email || '').trim();
  if (resendConfigured()) {
    return {
      configured: true,
      provider: 'resend',
      to,
      hint: 'Resend API key detected',
    };
  }
  if (smtpConfigured()) {
    return {
      configured: true,
      provider: 'smtp',
      to,
      hint: `SMTP ${process.env.SMTP_HOST}`,
    };
  }
  return {
    configured: false,
    provider: 'none',
    to,
    hint:
      'Set RESEND_API_KEY (recommended on Render) or SMTP_HOST / SMTP_USER / SMTP_PASS',
  };
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

function resolveFromAddress(): string {
  if (process.env.SMTP_FROM?.trim()) return process.env.SMTP_FROM.trim();
  if (process.env.RESEND_FROM?.trim()) return process.env.RESEND_FROM.trim();
  // Resend onboarding sender works without verifying a domain
  if (resendConfigured()) return 'Crypto Trading Bot <onboarding@resend.dev>';
  if (process.env.SMTP_USER?.trim()) return process.env.SMTP_USER.trim();
  return 'crypto-trading-bot@localhost';
}

function cooldownMs(kind: NotificationKind): number {
  const n = config.notifications;
  if (kind === 'lowEquity')
    return Math.max(60_000, Number(n.lowEquityCooldownMs) || 6 * 3600_000);
  if (kind === 'insufficientFunds')
    return Math.max(
      60_000,
      Number(n.insufficientFundsCooldownMs) || 30 * 60_000
    );
  return 0; // profitable closes: always send when enabled
}

function kindEnabled(kind: NotificationKind): boolean {
  const n = config.notifications;
  if (!n?.enabled) return false;
  if (kind === 'lowEquity') return n.lowEquityEnabled !== false;
  if (kind === 'insufficientFunds') return n.insufficientFundsEnabled !== false;
  if (kind === 'profitableClose') return n.profitableCloseEnabled !== false;
  if (kind === 'zionTradeOffer') return config.zion?.notifyEmailOnOffer !== false;
  if (kind === 'zionTradePlaced') return config.zion?.notifyEmailOnPlaced !== false;
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

async function sendViaResend(opts: {
  to: string;
  subject: string;
  text: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY!.trim();
  const from = resolveFromAddress();
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [opts.to],
      subject: opts.subject,
      text: opts.text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Resend HTTP ${res.status}: ${body.slice(0, 300) || res.statusText}`
    );
  }
}

async function sendViaSmtp(opts: {
  to: string;
  subject: string;
  text: string;
}): Promise<void> {
  const transport = getTransporter();
  if (!transport) throw new Error('SMTP transport unavailable');
  await transport.sendMail({
    from: resolveFromAddress(),
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
  });
}

async function deliverEmail(opts: {
  to: string;
  subject: string;
  text: string;
}): Promise<'resend' | 'smtp'> {
  if (resendConfigured()) {
    await sendViaResend(opts);
    return 'resend';
  }
  if (smtpConfigured()) {
    await sendViaSmtp(opts);
    return 'smtp';
  }
  throw new Error(
    'Email not configured — set RESEND_API_KEY (recommended) or SMTP_HOST / SMTP_USER / SMTP_PASS on Render'
  );
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

  if (!emailDeliveryConfigured()) {
    logger.warn('Notify', emailDeliveryStatus().hint, {
      kind: opts.kind,
      to,
      subject: opts.subject,
    });
    return false;
  }

  try {
    const provider = await deliverEmail({
      to,
      subject: opts.subject,
      text: opts.text,
    });
    lastSentAt[opts.kind] = Date.now();
    logger.info('Notify', `Email sent via ${provider}: ${opts.subject}`, {
      kind: opts.kind,
      to,
      provider,
    });
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

/** Zion pending trade offer — deep link opens dashboard approval modal. */
export async function notifyZionTradeOffer(offer: {
  id: string;
  mint: string;
  symbol: string;
  name?: string;
  score: number;
  kolCount: number;
  mcUsd?: number;
  reasons?: string[];
  kolWallets?: Array<{ name: string; address: string }>;
}): Promise<void> {
  const { dashboardBaseUrl } =
    require('./zion') as typeof import('./zion');
  const label = offer.symbol || offer.name || offer.mint.slice(0, 8);
  const link = `${dashboardBaseUrl()}/dashboard?tab=zion&offer=${encodeURIComponent(offer.id)}`;
  const kols = (offer.kolWallets || [])
    .slice(0, 8)
    .map((w) => `  - ${w.name} (${w.address.slice(0, 8)}…)`)
    .join('\n');
  const subject = `[Zion] Trade offer — ${label} (score ${offer.score})`;
  const text = [
    `Zion found a KOL-converging token. Approve manually in the dashboard.`,
    '',
    `Token: ${label}`,
    `Mint: ${offer.mint}`,
    offer.mcUsd != null ? `Market cap: $${Math.round(offer.mcUsd).toLocaleString()}` : null,
    `KOL wallets: ${offer.kolCount}`,
    offer.reasons?.length ? `Reasons: ${offer.reasons.join(' · ')}` : null,
    kols ? `KOLs:\n${kols}` : null,
    '',
    `Open trade request: ${link}`,
    `Time: ${new Date().toISOString()}`,
  ]
    .filter(Boolean)
    .join('\n');

  await sendMail({ subject, text, kind: 'zionTradeOffer' });
}

/** Zion trade placed confirmation. */
export async function notifyZionTradePlaced(
  offer: {
    id: string;
    mint: string;
    symbol: string;
    name?: string;
    mcUsd?: number;
  },
  solAmount: number
): Promise<void> {
  const label = offer.symbol || offer.name || offer.mint.slice(0, 8);
  const subject = `[Zion] Trade placed — ${label} (${solAmount.toFixed(4)} SOL)`;
  const text = [
    `Zion Place Trade executed.`,
    '',
    `Mode: ${config.mode}`,
    `Token: ${label}`,
    `Mint: ${offer.mint}`,
    `Size: ${solAmount.toFixed(4)} SOL`,
    offer.mcUsd != null ? `MC at offer: $${Math.round(offer.mcUsd).toLocaleString()}` : null,
    `Offer id: ${offer.id}`,
    '',
    `Time: ${new Date().toISOString()}`,
  ]
    .filter(Boolean)
    .join('\n');

  await sendMail({ subject, text, kind: 'zionTradePlaced' });
}

/** Test email from dashboard/API. */
export async function sendTestNotificationEmail(): Promise<{
  ok: boolean;
  error?: string;
  provider?: string;
}> {
  const to = String(config.notifications?.email || '').trim();
  if (!to) return { ok: false, error: 'No notification email configured' };
  if (!emailDeliveryConfigured()) {
    return {
      ok: false,
      error: emailDeliveryStatus().hint,
    };
  }
  try {
    const provider = await deliverEmail({
      to,
      subject: '[Bot] Test notification',
      text: `Test email from crypto trading bot at ${new Date().toISOString()}\n\nIf you received this, delivery is working.`,
    });
    logger.info('Notify', `Test email sent via ${provider}`, { to, provider });
    return { ok: true, provider };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Notify', `Test email failed: ${message}`);
    return { ok: false, error: message };
  }
}
