/**
 * Environment configuration for local dev and 24/7 deployment.
 * Loaded once at startup; secrets stay in process.env (never persisted to disk).
 */

import dotenv from 'dotenv';

dotenv.config();

export type NodeEnv = 'development' | 'production' | 'test';

export interface EnvConfig {
  nodeEnv: NodeEnv;
  isProduction: boolean;
  port: number;
  /** Bind address — use 0.0.0.0 on Fly / Railway / Render / PM2 */
  host: string;
  /** Comma-separated allowed origins; empty = same-origin only (no CORS headers) */
  corsOrigins: string[];
  tradingMode?: 'paper' | 'live';
  rpcUrl: string;
}

function parsePort(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < 65536 ? Math.floor(n) : fallback;
}

function parseCorsOrigins(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseNodeEnv(raw: string | undefined): NodeEnv {
  if (raw === 'production' || raw === 'test' || raw === 'development') {
    return raw;
  }
  return 'development';
}

const nodeEnv = parseNodeEnv(process.env.NODE_ENV);
const isProduction = nodeEnv === 'production';

export const env: EnvConfig = {
  nodeEnv,
  isProduction,
  port: parsePort(process.env.PORT, 3000),
  host:
    process.env.HOST?.trim() ||
    (isProduction ? '0.0.0.0' : '0.0.0.0'),
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGIN ?? process.env.CORS_ORIGINS),
  tradingMode:
    process.env.TRADING_MODE?.toLowerCase() === 'live'
      ? 'live'
      : process.env.TRADING_MODE?.toLowerCase() === 'paper'
        ? 'paper'
        : undefined,
  rpcUrl: (() => {
    const raw = process.env.RPC_URL?.trim() || '';
    // Defer to rpcUrl helper without circular import weight — inline check
    if (
      !raw ||
      /your-helius|your-quicknode|example\.com|changeme/i.test(raw)
    ) {
      return 'https://api.mainnet-beta.solana.com';
    }
    return raw;
  })(),
};

/** Log non-secret deployment context at boot */
export function logEnvSummary(): void {
  console.log(
    `[env] NODE_ENV=${env.nodeEnv} host=${env.host} port=${env.port}` +
      (env.corsOrigins.length
        ? ` cors=${env.corsOrigins.length} origin(s)`
        : ' cors=off') +
      (env.tradingMode ? ` TRADING_MODE=${env.tradingMode}` : '')
  );
}

/** Warn if live mode is requested without wallet keys */
export function validateDeploymentEnv(): string[] {
  const warnings: string[] = [];
  if (env.tradingMode === 'live') {
    const hasKey = Boolean(
      process.env.TRADING_WALLET_1?.trim() ||
        process.env.PRIVATE_KEY?.trim() ||
        process.env.WALLET_PRIVATE_KEY?.trim()
    );
    if (!hasKey) {
      warnings.push(
        'TRADING_MODE=live but no TRADING_WALLET_1 / PRIVATE_KEY / WALLET_PRIVATE_KEY in env'
      );
    }
  }
  const rawRpc = process.env.RPC_URL?.trim() || '';
  if (
    rawRpc &&
    /your-helius|your-quicknode|example\.com|changeme/i.test(rawRpc)
  ) {
    warnings.push(
      `RPC_URL looks like a placeholder (${rawRpc.slice(0, 48)}) — using public Solana RPC until you set a real Helius/QuickNode URL`
    );
  } else if (env.isProduction && env.rpcUrl.includes('mainnet-beta.solana.com')) {
    warnings.push(
      'Using public Solana RPC in production — set RPC_URL to a paid endpoint (Helius/QuickNode) for reliable wallet polling'
    );
  }
  return warnings;
}
