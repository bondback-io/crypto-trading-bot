/**
 * Alchemy CU/s pacing — sticky cooldown + in-flight cap for scanners/watchers.
 * Exit/send on Trading are never blocked here.
 */

import { computeCooldownMs, QuietLogGate } from './httpProviderGate';

const BACKOFF_MIN_MS = 15_000;
const BACKOFF_MAX_MS = 60_000;
const MAX_IN_FLIGHT = 2;

let cooldownUntil = 0;
let backoffMs = BACKOFF_MIN_MS;
let inFlight = 0;
let lastStartAt = 0;
const cuLog = new QuietLogGate(60_000);

export function isAlchemyRpcUrl(url: string | null | undefined): boolean {
  return /g\.alchemy\.com|alchemy\.com/i.test(String(url || ''));
}

export function isAlchemyCuLimitMessage(text: unknown): boolean {
  const s = String(text || '');
  if (!s) return false;
  return (
    /compute units per second/i.test(s) ||
    (/429/.test(s) && /alchemy/i.test(s) && /too many requests/i.test(s)) ||
    /exceeded its compute units/i.test(s)
  );
}

export function alchemyCooldownRemainingMs(now = Date.now()): number {
  return Math.max(0, cooldownUntil - now);
}

export function shouldSkipAlchemyRpc(feature?: string): boolean {
  if (isExitLikeFeature(feature)) return false;
  return alchemyCooldownRemainingMs() > 0;
}

function isExitLikeFeature(feature?: string): boolean {
  return /send_tx|sendRawTransaction|sendLegacy|trade_exit|confirm_tx|confirmTransaction/i.test(
    String(feature || '')
  );
}

/** Returns true if this is the first log for the current cooldown window. */
export function noteAlchemyCuLimit(endpoint?: string): boolean {
  const now = Date.now();
  const wait = Math.min(BACKOFF_MAX_MS, backoffMs);
  cooldownUntil = now + wait;
  backoffMs = Math.min(BACKOFF_MAX_MS, wait * 2);
  if (!cuLog.allow(now)) return false;
  const host = String(endpoint || 'alchemy')
    .replace(/\/\/.*@/, '//***@')
    .replace(/\/v2\/[^/?#]+/i, '/v2/***')
    .slice(0, 72);
  console.warn(
    `[alchemy_cu_s_limit] cooldown=${Math.round(wait / 1000)}s endpoint=${host}`
  );
  return true;
}

export function noteAlchemyOk(): void {
  if (alchemyCooldownRemainingMs() > 0) return;
  backoffMs = BACKOFF_MIN_MS;
}

export function acquireAlchemyPaceSlot(feature?: string): {
  allowed: boolean;
  release: () => void;
} {
  const noop = { allowed: true, release: () => undefined };
  if (isExitLikeFeature(feature)) return noop;
  if (shouldSkipAlchemyRpc(feature)) {
    return { allowed: false, release: () => undefined };
  }
  const now = Date.now();
  if (inFlight >= MAX_IN_FLIGHT) {
    return { allowed: false, release: () => undefined };
  }
  inFlight += 1;
  lastStartAt = now;
  let released = false;
  return {
    allowed: true,
    release: () => {
      if (released) return;
      released = true;
      inFlight = Math.max(0, inFlight - 1);
    },
  };
}

export function getAlchemyPaceStatus(): {
  cooldownMs: number;
  inFlight: number;
  backoffMs: number;
} {
  return {
    cooldownMs: alchemyCooldownRemainingMs(),
    inFlight,
    backoffMs,
  };
}

export function __resetAlchemyPaceForTests(): void {
  cooldownUntil = 0;
  backoffMs = BACKOFF_MIN_MS;
  inFlight = 0;
  lastStartAt = 0;
}
