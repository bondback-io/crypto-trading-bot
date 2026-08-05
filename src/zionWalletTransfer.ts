/**
 * Zion whitelist wallet transfers + balance/history assistant.
 * Separate from trading / Jupiter execution. Live sends only via SystemProgram.transfer.
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import fs from 'fs';
import { config, usesRealFunds } from './config';
import {
  getKeypair,
  withRpc,
} from './connection';
import { dataFile, ensureDataDir } from './dataDir';
import { logger } from './logger';
import { fetchSolUsdPrice, getCachedSolUsdPrice } from './marketData';

export interface ZionSavedWallet {
  id: string;
  name: string;
  address: string;
  aliases: string[];
  /** If true, allowed as transfer destination (Coinspot + Savings). Main is source-only. */
  allowSendTo: boolean;
}

export interface ZionTransfersConfig {
  enabled: boolean;
  savedWallets: ZionSavedWallet[];
  defaultSavingsWalletId: string;
  confirmThresholdSol: number;
  maxSingleTransferSol: number;
  dailyTransferCapSol: number;
  cooldownMs: number;
}

/** Retired Main pubkey — scrubbed from config/chat so Zion never references it. */
export const RETIRED_MAIN_WALLET_ADDRESS =
  '294hBvq3qpoqPLRugMj26egk6r5Tgj7LV6x3aaGZAmtX';

export const SEED_ZION_WALLETS: ZionSavedWallet[] = [
  {
    id: 'main',
    name: 'Main',
    address: '4bMvt1kbybbUTZk4MjHNHPvRYBqtYnL9timFYVwhZ3Mm',
    aliases: ['main', 'primary', 'trading bot', 'tradingbot', 'dad main'],
    allowSendTo: false,
  },
  {
    id: 'savings',
    name: 'Savings',
    address: 'GPHmLGBVyRunGw6buStKV5ydBCqmMrneT4XAU5WS5fRo',
    aliases: [
      'profit',
      'burner',
      'savings',
      'trading profit',
      'tradingprofit',
    ],
    allowSendTo: true,
  },
  {
    id: 'coinspot',
    name: 'Coinspot',
    address: '8YRT22hKQUUgetJ3RGmW6TaiDAzhf8jtq1KJ797VhxWe',
    aliases: ['coinspot', 'external'],
    allowSendTo: true,
  },
];

export const DEFAULT_ZION_TRANSFERS: ZionTransfersConfig = {
  enabled: false,
  savedWallets: SEED_ZION_WALLETS.map((w) => ({ ...w, aliases: [...w.aliases] })),
  defaultSavingsWalletId: 'savings',
  confirmThresholdSol: 2,
  maxSingleTransferSol: 5,
  dailyTransferCapSol: 10,
  cooldownMs: 60_000,
};

const FEE_RESERVE_SOL = 0.02;
const PENDING_TTL_MS = 5 * 60_000;
const MAX_PASSWORD_TRIES = 3;
const AUDIT_FILE = 'zion-transfer-audit.jsonl';
const DEFAULT_PASSWORD = 'Zion2024!!';

type PendingStep = 'confirm' | 'password';

interface PendingTransfer {
  step: PendingStep;
  amountSol: number;
  fromAddress: string;
  fromName: string;
  toAddress: string;
  toName: string;
  toId: string;
  createdAt: number;
  passwordTries: number;
  aboveThreshold: boolean;
}

interface AuditRow {
  at: number;
  event: string;
  amountSol?: number;
  from?: string;
  to?: string;
  toName?: string;
  signature?: string;
  detail?: string;
  mode?: string;
}

let pending: PendingTransfer | null = null;
let lastTransferAt = 0;

function transferPassword(): string {
  const env = process.env.ZION_TRANSFER_PASSWORD?.trim();
  return env || DEFAULT_PASSWORD;
}

export function getZionTransfersConfig(): ZionTransfersConfig {
  ensureSeededWallets();
  const zt = config.zionTransfers || DEFAULT_ZION_TRANSFERS;
  return {
    enabled: zt.enabled === true,
    savedWallets: Array.isArray(zt.savedWallets)
      ? zt.savedWallets
      : SEED_ZION_WALLETS,
    defaultSavingsWalletId: zt.defaultSavingsWalletId || 'savings',
    confirmThresholdSol: Number(zt.confirmThresholdSol) || 2,
    maxSingleTransferSol: Number(zt.maxSingleTransferSol) || 5,
    dailyTransferCapSol: Number(zt.dailyTransferCapSol) || 10,
    cooldownMs: Number(zt.cooldownMs) || 60_000,
  };
}

/** Merge seed wallets if missing; migrate Main id/address off the retired pubkey. */
export function ensureSeededWallets(): void {
  if (!config.zionTransfers) {
    config.zionTransfers = cloneTransfers(DEFAULT_ZION_TRANSFERS);
    return;
  }
  const list = Array.isArray(config.zionTransfers.savedWallets)
    ? [...config.zionTransfers.savedWallets]
    : [];
  let changed = false;
  const mainSeed = SEED_ZION_WALLETS.find((w) => w.id === 'main');
  for (let i = 0; i < list.length; i++) {
    const w = list[i]!;
    if (
      w.id === 'main' ||
      w.address === RETIRED_MAIN_WALLET_ADDRESS ||
      (mainSeed && w.address === mainSeed.address && w.id !== 'main')
    ) {
      if (
        mainSeed &&
        (w.address === RETIRED_MAIN_WALLET_ADDRESS ||
          (w.id === 'main' && w.address !== mainSeed.address))
      ) {
        list[i] = {
          ...w,
          id: 'main',
          name: w.name || mainSeed.name,
          address: mainSeed.address,
          aliases: Array.from(
            new Set([...(w.aliases || []), ...mainSeed.aliases])
          ),
          allowSendTo: false,
        };
        changed = true;
      }
    }
  }
  // Drop any leftover row that still holds only the retired address
  const filtered = list.filter((w) => w.address !== RETIRED_MAIN_WALLET_ADDRESS);
  if (filtered.length !== list.length) {
    changed = true;
  }
  const byId = new Set(filtered.map((w) => w.id));
  const byAddr = new Set(filtered.map((w) => w.address));
  for (const seed of SEED_ZION_WALLETS) {
    if (byId.has(seed.id) || byAddr.has(seed.address)) continue;
    filtered.push({ ...seed, aliases: [...seed.aliases] });
    changed = true;
  }
  if (changed || !Array.isArray(config.zionTransfers.savedWallets)) {
    config.zionTransfers.savedWallets = filtered;
  }
  if (config.zionTransfers.defaultSavingsWalletId == null) {
    config.zionTransfers.defaultSavingsWalletId = 'savings';
  }
}

/** Replace retired Main pubkey in free text (chat history / backups). */
export function scrubRetiredMainWalletText(text: string): string {
  if (!text || !text.includes(RETIRED_MAIN_WALLET_ADDRESS)) return text;
  const main =
    SEED_ZION_WALLETS.find((w) => w.id === 'main')?.address ||
    '4bMvt1kbybbUTZk4MjHNHPvRYBqtYnL9timFYVwhZ3Mm';
  return text.split(RETIRED_MAIN_WALLET_ADDRESS).join(main);
}

function cloneTransfers(c: ZionTransfersConfig): ZionTransfersConfig {
  return JSON.parse(JSON.stringify(c)) as ZionTransfersConfig;
}

function audit(row: AuditRow): void {
  try {
    ensureDataDir();
    const line = JSON.stringify({ ...row, at: row.at || Date.now() }) + '\n';
    fs.appendFileSync(dataFile(AUDIT_FILE), line, 'utf8');
  } catch (err) {
    logger.warn(
      'ZionTransfer',
      `audit write failed: ${err instanceof Error ? err.message : err}`
    );
  }
  logger.info('ZionTransfer', row.event, {
    amountSol: row.amountSol,
    to: row.toName || row.to,
    signature: row.signature,
    detail: row.detail,
  });
}

export function readTransferAudit(limit = 200): AuditRow[] {
  try {
    const p = dataFile(AUDIT_FILE);
    if (!fs.existsSync(p)) return [];
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    return lines
      .slice(-Math.max(1, limit))
      .map((l) => {
        try {
          return JSON.parse(l) as AuditRow;
        } catch {
          return null;
        }
      })
      .filter((x): x is AuditRow => Boolean(x));
  } catch {
    return [];
  }
}

export function totalTransferredSol(): number {
  return readTransferAudit(5_000)
    .filter((r) => r.event === 'transfer_ok' && Number(r.amountSol) > 0)
    .reduce((s, r) => s + Number(r.amountSol || 0), 0);
}

export function dailyTransferredSol(): number {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const t0 = start.getTime();
  return readTransferAudit(5_000)
    .filter(
      (r) =>
        r.event === 'transfer_ok' &&
        Number(r.at) >= t0 &&
        Number(r.amountSol) > 0
    )
    .reduce((s, r) => s + Number(r.amountSol || 0), 0);
}

export function peekPendingTransfer(): PendingTransfer | null {
  if (pending && Date.now() - pending.createdAt > PENDING_TTL_MS) {
    audit({
      at: Date.now(),
      event: 'transfer_cancel',
      detail: 'pending timed out',
      amountSol: pending.amountSol,
      to: pending.toAddress,
      toName: pending.toName,
    });
    pending = null;
  }
  return pending;
}

function clearPending(reason: string): void {
  if (pending) {
    audit({
      at: Date.now(),
      event: 'transfer_cancel',
      detail: reason,
      amountSol: pending.amountSol,
      from: pending.fromAddress,
      to: pending.toAddress,
      toName: pending.toName,
    });
  }
  pending = null;
}

function normalizeAlias(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function resolveSavedWallet(
  query: string
): ZionSavedWallet | null {
  const zt = getZionTransfersConfig();
  const q = normalizeAlias(query);
  if (!q) return null;
  // Exact address match
  for (const w of zt.savedWallets) {
    if (w.address === query.trim()) return w;
  }
  for (const w of zt.savedWallets) {
    const names = [w.name, w.id, ...w.aliases].map(normalizeAlias);
    if (names.some((n) => n === q || q.includes(n) || n.includes(q))) {
      return w;
    }
  }
  return null;
}

function isValidSolanaAddress(addr: string): boolean {
  try {
    const pk = new PublicKey(addr);
    return pk.toBase58() === addr;
  } catch {
    return false;
  }
}

async function balanceForAddress(address: string): Promise<number | null> {
  try {
    const pk = new PublicKey(address);
    const lamports = await withRpc('zionWalletBalance', (conn: Connection) =>
      conn.getBalance(pk)
    );
    return lamports / LAMPORTS_PER_SOL;
  } catch (err) {
    logger.warn(
      'ZionTransfer',
      `balance failed: ${err instanceof Error ? err.message : err}`
    );
    return null;
  }
}

async function recentTxs(
  address: string,
  limit: number
): Promise<Array<{ signature: string; slot: number; err: unknown; blockTime: number | null }>> {
  try {
    const pk = new PublicKey(address);
    const sigs = await withRpc('zionWalletSigs', (conn: Connection) =>
      conn.getSignaturesForAddress(pk, { limit })
    );
    return (sigs || []).map((s) => ({
      signature: s.signature,
      slot: s.slot,
      err: s.err,
      blockTime: s.blockTime ?? null,
    }));
  } catch (err) {
    logger.warn(
      'ZionTransfer',
      `history failed: ${err instanceof Error ? err.message : err}`
    );
    return [];
  }
}

function formatSolUsd(sol: number | null, solUsd: number): string {
  if (sol == null || !Number.isFinite(sol)) return 'unavailable';
  const usd =
    solUsd > 0 ? ` (~$${(sol * solUsd).toFixed(2)})` : '';
  return `${sol.toFixed(4)} SOL${usd}`;
}

function footer(): string {
  return '\n\n~ Zion Valton';
}

/** Whether this chat turn should redact the stored user message (password entry). */
export function shouldRedactWalletChatUserText(userText: string): boolean {
  const p = peekPendingTransfer();
  return p?.step === 'password';
}

/**
 * Process wallet balance / history / price / send confirmation intents.
 * Returns handled=true when Zion should skip the LLM path.
 */
export async function processZionWalletChat(
  userText: string
): Promise<{ handled: boolean; reply: string }> {
  const text = String(userText || '').trim();
  if (!text) return { handled: false, reply: '' };

  ensureSeededWallets();
  const p = peekPendingTransfer();

  // ——— Pending confirmation / password ———
  if (p) {
    if (p.step === 'confirm') {
      if (/^(no|n|cancel|stop|abort)\b/i.test(text) || /^no[.!]*$/i.test(text)) {
        clearPending('user said no');
        return {
          handled: true,
          reply:
            'Transfer cancelled. Nothing was sent.' + footer(),
        };
      }
      if (
        /^(yes|y|yeah|yep|confirm|continue|ok|okay)\b/i.test(text) ||
        /^yes[.!]*$/i.test(text)
      ) {
        audit({
          at: Date.now(),
          event: 'transfer_confirmed_yes',
          amountSol: p.amountSol,
          from: p.fromAddress,
          to: p.toAddress,
          toName: p.toName,
          detail: p.aboveThreshold
            ? 'above confirmation threshold'
            : 'below threshold',
        });
        pending = { ...p, step: 'password', passwordTries: 0 };
        return {
          handled: true,
          reply:
            `Confirmed details:\n` +
            `• Amount: ${p.amountSol.toFixed(4)} SOL` +
            (p.aboveThreshold
              ? ` (≥ ${getZionTransfersConfig().confirmThresholdSol} SOL threshold)`
              : '') +
            `\n• From: ${p.fromName}\n  ${p.fromAddress}` +
            `\n• To: ${p.toName}\n  ${p.toAddress}` +
            `\n\nEnter the confirmation password to complete the transfer (3 tries).` +
            footer(),
        };
      }
      return {
        handled: true,
        reply:
          'Please reply Yes to continue with the transfer, or No to cancel.' +
          footer(),
      };
    }

    if (p.step === 'password') {
      if (/^(no|n|cancel|stop|abort)\b/i.test(text) || /^no[.!]*$/i.test(text)) {
        clearPending('user cancelled at password');
        return {
          handled: true,
          reply: 'Transfer cancelled. Nothing was sent.' + footer(),
        };
      }
      const ok = text === transferPassword();
      if (!ok) {
        const tries = p.passwordTries + 1;
        audit({
          at: Date.now(),
          event: 'transfer_password_fail',
          amountSol: p.amountSol,
          to: p.toAddress,
          toName: p.toName,
          detail: `try ${tries}/${MAX_PASSWORD_TRIES}`,
        });
        if (tries >= MAX_PASSWORD_TRIES) {
          clearPending('password failed 3 times');
          return {
            handled: true,
            reply:
              'Password incorrect 3 times. Transfer request cancelled.' +
              footer(),
          };
        }
        pending = { ...p, passwordTries: tries };
        return {
          handled: true,
          reply:
            `Password incorrect (${tries}/${MAX_PASSWORD_TRIES}). Try again, or say No to cancel.` +
            footer(),
        };
      }
      audit({
        at: Date.now(),
        event: 'transfer_password_ok',
        amountSol: p.amountSol,
        to: p.toAddress,
        toName: p.toName,
      });
      const snap = { ...p };
      pending = null;
      const result = await executeTransfer(snap);
      return { handled: true, reply: result + footer() };
    }
  }

  // ——— SOL price ———
  if (
    /\b(sol(ana)?\s*price|price\s+of\s+sol|current\s+sol|how\s+much\s+is\s+sol)\b/i.test(
      text
    )
  ) {
    const solUsd =
      (await fetchSolUsdPrice().catch(() => 0)) || getCachedSolUsdPrice();
    return {
      handled: true,
      reply:
        solUsd > 0
          ? `Current Solana price used: **$${solUsd.toFixed(2)}** USD per SOL.` +
            footer()
          : 'SOL/USD price is temporarily unavailable.' + footer(),
    };
  }

  // ——— Total transferred ———
  if (
    /\b(total\s+(amount\s+)?(zion\s+)?(has\s+)?transfer|how\s+much\s+(have\s+you|zion)\s+transfer|transfer(red)?\s+total)\b/i.test(
      text
    )
  ) {
    const total = totalTransferredSol();
    const today = dailyTransferredSol();
    const solUsd = getCachedSolUsdPrice();
    return {
      handled: true,
      reply:
        `Zion transfer audit:\n` +
        `• Lifetime sent: ${formatSolUsd(total, solUsd)}\n` +
        `• Today: ${formatSolUsd(today, solUsd)}\n` +
        `• Daily cap remaining: ${formatSolUsd(
          Math.max(0, getZionTransfersConfig().dailyTransferCapSol - today),
          solUsd
        )}` +
        footer(),
    };
  }

  // ——— Transaction history ———
  const histMatch = text.match(
    /\b(?:last|recent)\s+(5|10|20)\s+(?:tx|txs|transactions?|trades?)\b(?:\s+(?:on|for|from|of)\s+(.+))?/i
  );
  if (histMatch || /\b(transaction\s+history|tx\s+history|recent\s+transactions?)\b/i.test(text)) {
    const n = histMatch ? Number(histMatch[1]) : 10;
    const limit = n === 5 || n === 20 ? n : 10;
    let walletQ =
      (histMatch && histMatch[2] && histMatch[2].trim()) ||
      '';
    if (!walletQ) {
      const m2 = text.match(
        /\b(?:on|for|from|of)\s+(main|primary|savings|profit|burner|coinspot|external|trading\s+bot|trading\s+profit)\b/i
      );
      walletQ = m2 ? m2[1] : 'main';
    }
    const w = resolveSavedWallet(walletQ) || resolveSavedWallet('main');
    if (!w) {
      return {
        handled: true,
        reply: 'I could not resolve that wallet name.' + footer(),
      };
    }
    const txs = await recentTxs(w.address, limit);
    if (txs.length === 0) {
      return {
        handled: true,
        reply:
          `No recent transactions found for **${w.name}** (${w.address}), or RPC is busy.` +
          footer(),
      };
    }
    const lines = txs.map((t, i) => {
      const when = t.blockTime
        ? new Date(t.blockTime * 1000).toISOString()
        : `slot ${t.slot}`;
      const status = t.err ? 'fail' : 'ok';
      return `${i + 1}. ${status} · ${when}\n   ${t.signature}`;
    });
    return {
      handled: true,
      reply:
        `Last ${txs.length} transaction(s) for **${w.name}**\n${w.address}\n\n` +
        lines.join('\n') +
        footer(),
    };
  }

  // ——— Balances ———
  if (
    /\b(balance|balances|how\s+much|wallet\s+check|check\s+wallet|funds\s+on)\b/i.test(
      text
    ) &&
    !/\bsend\b/i.test(text)
  ) {
    const solUsd =
      (await fetchSolUsdPrice().catch(() => 0)) || getCachedSolUsdPrice();
    const zt = getZionTransfersConfig();
    const all =
      /\b(all|every|each)\b/i.test(text) ||
      /\bwallets\b/i.test(text) ||
      (!resolveSavedWallet(text) &&
        !/\b(main|primary|savings|profit|burner|coinspot|external)\b/i.test(
          text
        ));

    const targets = all
      ? zt.savedWallets
      : (() => {
          const hit =
            resolveSavedWallet(text) ||
            (/\b(main|primary|trading\s*bot)\b/i.test(text)
              ? resolveSavedWallet('main')
              : null) ||
            (/\b(savings|profit|burner)\b/i.test(text)
              ? resolveSavedWallet('savings')
              : null) ||
            (/\b(coinspot|external)\b/i.test(text)
              ? resolveSavedWallet('coinspot')
              : null);
          return hit ? [hit] : zt.savedWallets;
        })();

    const lines: string[] = [];
    for (const w of targets) {
      const bal = await balanceForAddress(w.address);
      lines.push(
        `**${w.name}** (${w.aliases.slice(0, 3).join(', ')})\n` +
          `${w.address}\n` +
          `Balance: ${formatSolUsd(bal, solUsd)}`
      );
    }
    return {
      handled: true,
      reply:
        `Live wallet balances (RPC):\n\n` + lines.join('\n\n') + footer(),
    };
  }

  // ——— Send intent ———
  const sendMatch = text.match(
    /\bsend\s+([\d.]+)\s*(?:sol(?:ana)?)?\s+to\s+(.+?)(?:\s*[.!]?\s*)$/i
  );
  if (sendMatch || /\b(transfer|sweep)\s+([\d.]+)\s*(?:sol)?\s+to\s+/i.test(text)) {
    const m =
      sendMatch ||
      text.match(
        /\b(?:transfer|sweep)\s+([\d.]+)\s*(?:sol(?:ana)?)?\s+to\s+(.+?)(?:\s*[.!]?\s*)$/i
      );
    if (!m) return { handled: false, reply: '' };
    const amount = Number(m[1]);
    const destQ = String(m[2] || '').trim();
    return {
      handled: true,
      reply: (await beginTransferRequest(amount, destQ)) + footer(),
    };
  }

  // Soft help
  if (
    /\b(send\s+sol|transfer\s+sol|zion\s+transfer|whitelist\s+wallet)\b/i.test(
      text
    )
  ) {
    const zt = getZionTransfersConfig();
    return {
      handled: true,
      reply:
        `I can check balances / last 5|10|20 txs / SOL price, and (when enabled) send SOL from the live trading wallet to whitelisted destinations only.\n` +
        `Transfers enabled: ${zt.enabled ? 'YES' : 'NO (enable in Config → Zion Transfers)'}\n` +
        `Example: "send 1.5 SOL to Savings" or "send 0.5 SOL to Coinspot".` +
        footer(),
    };
  }

  return { handled: false, reply: '' };
}

async function beginTransferRequest(
  amountSol: number,
  destQuery: string
): Promise<string> {
  const zt = getZionTransfersConfig();
  if (!zt.enabled) {
    audit({
      at: Date.now(),
      event: 'transfer_reject',
      detail: 'transfers disabled',
      amountSol,
    });
    return 'Zion transfers are disabled. Enable them under Config → Zion Transfers.';
  }
  if (!(amountSol > 0) || !Number.isFinite(amountSol)) {
    return 'Please specify a valid SOL amount (e.g. send 1.5 SOL to Savings).';
  }
  if (amountSol > zt.maxSingleTransferSol) {
    audit({
      at: Date.now(),
      event: 'transfer_reject',
      detail: 'above max single',
      amountSol,
    });
    return `Amount ${amountSol} SOL exceeds the single-transfer cap of ${zt.maxSingleTransferSol} SOL.`;
  }
  const today = dailyTransferredSol();
  if (today + amountSol > zt.dailyTransferCapSol) {
    audit({
      at: Date.now(),
      event: 'transfer_reject',
      detail: 'daily cap',
      amountSol,
    });
    return `That would exceed the daily transfer cap (${zt.dailyTransferCapSol} SOL). Already sent today: ${today.toFixed(4)} SOL.`;
  }
  if (Date.now() - lastTransferAt < zt.cooldownMs) {
    const wait = Math.ceil((zt.cooldownMs - (Date.now() - lastTransferAt)) / 1000);
    audit({
      at: Date.now(),
      event: 'transfer_reject',
      detail: 'cooldown',
      amountSol,
    });
    return `Transfer cooldown active — wait ~${wait}s before another send.`;
  }

  let dest = resolveSavedWallet(destQuery);
  if (!dest && isValidSolanaAddress(destQuery.trim())) {
    dest = zt.savedWallets.find((w) => w.address === destQuery.trim()) || null;
  }
  if (!dest) {
    audit({
      at: Date.now(),
      event: 'transfer_reject',
      detail: 'destination not on whitelist',
      amountSol,
    });
    return (
      'I can only send to whitelisted wallets (Savings / Profit / Burner, or Coinspot / External). ' +
      'That destination is not on the saved list.'
    );
  }
  if (!dest.allowSendTo) {
    audit({
      at: Date.now(),
      event: 'transfer_reject',
      detail: 'destination not allowSendTo',
      amountSol,
      to: dest.address,
      toName: dest.name,
    });
    return `**${dest.name}** is the trading / source wallet — I cannot send TO it. Use Savings or Coinspot.`;
  }

  const kp = getKeypair();
  const fromAddress = kp?.publicKey.toBase58() || '';
  if (!fromAddress) {
    return 'No live trading wallet keypair is loaded — cannot send.';
  }
  if (fromAddress === dest.address) {
    return 'Source and destination are the same address.';
  }

  const bal = await balanceForAddress(fromAddress);
  if (bal == null) {
    return 'Could not read source wallet balance (RPC). Try again shortly.';
  }
  if (bal < amountSol + FEE_RESERVE_SOL) {
    audit({
      at: Date.now(),
      event: 'transfer_reject',
      detail: 'insufficient balance',
      amountSol,
      from: fromAddress,
      to: dest.address,
    });
    return (
      `Insufficient balance. Source has ${bal.toFixed(4)} SOL; need ${amountSol.toFixed(4)} + ${FEE_RESERVE_SOL} fee reserve.`
    );
  }

  const fromName =
    resolveSavedWallet(fromAddress)?.name ||
    resolveSavedWallet('main')?.name ||
    'Trading wallet';

  const aboveThreshold = amountSol >= zt.confirmThresholdSol;
  pending = {
    step: 'confirm',
    amountSol,
    fromAddress,
    fromName,
    toAddress: dest.address,
    toName: dest.name,
    toId: dest.id,
    createdAt: Date.now(),
    passwordTries: 0,
    aboveThreshold,
  };
  audit({
    at: Date.now(),
    event: 'transfer_request',
    amountSol,
    from: fromAddress,
    to: dest.address,
    toName: dest.name,
    mode: config.mode,
    detail: aboveThreshold ? 'needs Yes + password (threshold)' : 'needs Yes + password',
  });

  return (
    `Transfer request ready:\n` +
    `• Amount: **${amountSol.toFixed(4)} SOL**` +
    (aboveThreshold
      ? ` (above ${zt.confirmThresholdSol} SOL confirmation threshold)`
      : '') +
    `\n• From: **${fromName}**\n  ${fromAddress}` +
    `\n• To: **${dest.name}**\n  ${dest.address}` +
    `\n\nDo you want to continue with the transfer? Reply **Yes** or **No**.`
  );
}

async function executeTransfer(p: PendingTransfer): Promise<string> {
  const zt = getZionTransfersConfig();
  if (!zt.enabled) {
    return 'Transfers were disabled before execution — cancelled.';
  }

  if (!usesRealFunds()) {
    audit({
      at: Date.now(),
      event: 'transfer_dry_run',
      amountSol: p.amountSol,
      from: p.fromAddress,
      to: p.toAddress,
      toName: p.toName,
      mode: config.mode,
      detail: 'Paper/Live Sim — no real send',
    });
    return (
      `Mode is **${config.mode}** — I will not send real funds.\n` +
      `Dry-run: would send ${p.amountSol.toFixed(4)} SOL\n` +
      `From ${p.fromName} (${p.fromAddress})\n` +
      `To ${p.toName} (${p.toAddress}).\n` +
      `Switch to Live to execute real transfers.`
    );
  }

  const kp = getKeypair();
  if (!kp) {
    audit({
      at: Date.now(),
      event: 'transfer_fail',
      detail: 'no keypair',
      amountSol: p.amountSol,
    });
    return 'No trading keypair available — transfer aborted.';
  }
  if (kp.publicKey.toBase58() !== p.fromAddress) {
    audit({
      at: Date.now(),
      event: 'transfer_fail',
      detail: 'source key mismatch',
      amountSol: p.amountSol,
    });
    return 'Active wallet changed since confirmation — transfer aborted. Start again.';
  }

  // Re-validate whitelist + caps
  const dest = getZionTransfersConfig().savedWallets.find(
    (w) => w.address === p.toAddress && w.allowSendTo
  );
  if (!dest) {
    return 'Destination no longer allowed — transfer aborted.';
  }
  const today = dailyTransferredSol();
  if (today + p.amountSol > zt.dailyTransferCapSol) {
    return 'Daily cap would be exceeded — transfer aborted.';
  }

  try {
    const lamports = Math.round(p.amountSol * LAMPORTS_PER_SOL);
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: kp.publicKey,
        toPubkey: new PublicKey(p.toAddress),
        lamports,
      })
    );
    tx.feePayer = kp.publicKey;
    const sig = await withRpc('zionTransferSend', async (conn: Connection) => {
      const { blockhash, lastValidBlockHeight } =
        await conn.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.sign(kp);
      const signature = await conn.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      await conn.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed'
      );
      return signature;
    });
    lastTransferAt = Date.now();
    audit({
      at: Date.now(),
      event: 'transfer_ok',
      amountSol: p.amountSol,
      from: p.fromAddress,
      to: p.toAddress,
      toName: p.toName,
      signature: sig,
      mode: 'live',
    });
    return (
      `Transfer complete.\n` +
      `• Sent **${p.amountSol.toFixed(4)} SOL**\n` +
      `• To **${p.toName}**\n  ${p.toAddress}\n` +
      `• Signature: ${sig}`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    audit({
      at: Date.now(),
      event: 'transfer_fail',
      amountSol: p.amountSol,
      from: p.fromAddress,
      to: p.toAddress,
      toName: p.toName,
      detail: msg.slice(0, 200),
    });
    return `Transfer failed: ${msg.slice(0, 180)}`;
  }
}

export function getZionTransferStatusPublic(): {
  enabled: boolean;
  confirmThresholdSol: number;
  maxSingleTransferSol: number;
  dailyTransferCapSol: number;
  dailyUsedSol: number;
  cooldownMs: number;
  pending: null | {
    step: string;
    amountSol: number;
    toName: string;
    toAddress: string;
    fromName: string;
    fromAddress: string;
  };
  savedWallets: Array<{
    id: string;
    name: string;
    address: string;
    aliases: string[];
    allowSendTo: boolean;
  }>;
  totalTransferredSol: number;
} {
  const zt = getZionTransfersConfig();
  const p = peekPendingTransfer();
  return {
    enabled: zt.enabled,
    confirmThresholdSol: zt.confirmThresholdSol,
    maxSingleTransferSol: zt.maxSingleTransferSol,
    dailyTransferCapSol: zt.dailyTransferCapSol,
    dailyUsedSol: dailyTransferredSol(),
    cooldownMs: zt.cooldownMs,
    pending: p
      ? {
          step: p.step,
          amountSol: p.amountSol,
          toName: p.toName,
          toAddress: p.toAddress,
          fromName: p.fromName,
          fromAddress: p.fromAddress,
        }
      : null,
    savedWallets: zt.savedWallets.map((w) => ({
      id: w.id,
      name: w.name,
      address: w.address,
      aliases: w.aliases,
      allowSendTo: w.allowSendTo,
    })),
    totalTransferredSol: totalTransferredSol(),
  };
}
