/**
 * Per-key 429 / CU/s cooldown for Alchemy and Helius.
 * Cools that key only (15–60s) so spillover can use siblings in the same pool.
 * Never skips trade exit / send. Repeat notes while cooling do not stack.
 */

import {
  buildAlchemyRpcUrl,
  isHeliusRpcUrl,
} from './rpcUrl';

const COOL_MIN_MS = 15_000;
const COOL_MAX_MS = 60_000;
const MAX_INFLIGHT_PER_KEY = 4;

const CRITICAL_FEATURES = new Set([
  'trade_entry',
  'trade_exit',
  'send_tx',
  'confirm_tx',
  'sendRawTransaction',
  'sendLegacy',
]);

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

export function isKeyedRpcLimitMessage(text: unknown): boolean {
  const s = String(text || '');
  if (!s) return false;
  if (isAlchemyCuLimitMessage(s)) return true;
  return (
    /429|rate.?limit|-32429|too many requests|insufficient credits|credit usage limit|compute units per second/i.test(
      s
    )
  );
}

export function alchemyKeyIdFromUrl(url: string | null | undefined): string | null {
  return keyedRpcIdFromUrl(url);
}

export function keyedRpcIdFromUrl(url: string | null | undefined): string | null {
  const u = String(url || '');
  if (!u) return null;
  if (isAlchemyRpcUrl(u)) {
    const m = u.match(/\/v2\/([^/?#]+)/i);
    if (m?.[1]) return `alchemy:${m[1]}`;
    try {
      return `alchemy:${new URL(u).host}`;
    } catch {
      return 'alchemy';
    }
  }
  if (isHeliusRpcUrl(u)) {
    const key = u.split('api-key=')[1]?.split('&')[0] || '';
    if (key) return `helius:${key}`;
    try {
      return `helius:${new URL(u).host}`;
    } catch {
      return 'helius';
    }
  }
  return null;
}

type KeyPace = {
  id: string;
  label: string;
  cooldownUntil: number;
  backoffMs: number;
  inFlight: number;
  last429At: number;
};

const keys = new Map<string, KeyPace>();

function emptyKey(id: string, label: string): KeyPace {
  return {
    id,
    label,
    cooldownUntil: 0,
    backoffMs: COOL_MIN_MS,
    inFlight: 0,
    last429At: 0,
  };
}

function getOrCreate(url: string): KeyPace | null {
  const id = keyedRpcIdFromUrl(url);
  if (!id) return null;
  let st = keys.get(id);
  if (!st) {
    const label = isHeliusRpcUrl(url)
      ? 'helius'
      : isAlchemyRpcUrl(url)
        ? 'alchemy'
        : id;
    st = emptyKey(id, label);
    keys.set(id, st);
  }
  return st;
}

function isCriticalFeature(feature?: string): boolean {
  if (!feature) return false;
  return CRITICAL_FEATURES.has(feature) || feature.startsWith('trade_');
}

export function isKeyedRpcCooling(
  url: string | null | undefined,
  now = Date.now()
): boolean {
  const st = url ? keys.get(keyedRpcIdFromUrl(url) || '') : undefined;
  return Boolean(st && st.cooldownUntil > now);
}

export function shouldSkipKeyedRpc(
  feature?: string,
  url?: string | null
): boolean {
  if (isCriticalFeature(feature)) return false;
  return isKeyedRpcCooling(url);
}

/** Returns true if a new cooldown window started. */
export function noteKeyedRpcLimit(endpoint?: string): boolean {
  if (!endpoint) return false;
  const st = getOrCreate(endpoint);
  if (!st) return false;
  const now = Date.now();
  if (st.cooldownUntil > now) return false;
  const wait = Math.min(COOL_MAX_MS, st.backoffMs || COOL_MIN_MS);
  st.cooldownUntil = now + wait;
  st.last429At = now;
  st.backoffMs = Math.min(COOL_MAX_MS, wait * 2);
  return true;
}

export function noteKeyedRpcOk(url?: string | null): void {
  if (!url) return;
  const st = getOrCreate(url);
  if (!st) return;
  if (st.cooldownUntil && Date.now() >= st.cooldownUntil) {
    st.cooldownUntil = 0;
    st.backoffMs = COOL_MIN_MS;
  }
}

export function listAlchemyScannerUrlsFromEnv(): string[] {
  const urls = [
    buildAlchemyRpcUrl(),
    buildAlchemyRpcUrl(process.env.ALCHEMY_API_KEY_BACKUP2),
    buildAlchemyRpcUrl(process.env.ALCHEMY_API_KEY_BACKUP3),
    buildAlchemyRpcUrl(process.env.ALCHEMY_API_KEY_BACKUP4),
  ].filter((u): u is string => Boolean(u));
  return [...new Set(urls)];
}

export function alchemyCooldownRemainingMs(now = Date.now()): number {
  let max = 0;
  for (const st of keys.values()) {
    max = Math.max(max, Math.max(0, st.cooldownUntil - now));
  }
  return max;
}

export function allScannerAlchemyKeysCooling(now = Date.now()): boolean {
  const urls = listAlchemyScannerUrlsFromEnv();
  if (urls.length === 0) return false;
  return urls.every((u) => isKeyedRpcCooling(u, now));
}

export function shouldSkipAlchemyRpc(
  feature?: string,
  url?: string | null
): boolean {
  return shouldSkipKeyedRpc(feature, url);
}

export function noteAlchemyCuLimit(endpoint?: string): boolean {
  return noteKeyedRpcLimit(endpoint);
}

export function noteAlchemyOk(url?: string | null): void {
  noteKeyedRpcOk(url);
}

export function acquireAlchemyPaceSlot(
  _feature?: string,
  url?: string | null
): {
  allowed: boolean;
  release: () => void;
} {
  if (isCriticalFeature(_feature)) {
    return { allowed: true, release: () => undefined };
  }
  if (!url) return { allowed: true, release: () => undefined };
  const st = getOrCreate(url);
  if (!st) return { allowed: true, release: () => undefined };
  if (st.inFlight >= MAX_INFLIGHT_PER_KEY) {
    return { allowed: false, release: () => undefined };
  }
  st.inFlight += 1;
  let released = false;
  return {
    allowed: true,
    release: () => {
      if (released) return;
      released = true;
      st.inFlight = Math.max(0, st.inFlight - 1);
    },
  };
}

export function pickNextAlchemyScannerUrl(
  candidates: Array<string | null | undefined>
): string | null {
  const now = Date.now();
  for (const c of candidates) {
    const u = String(c || '').trim();
    if (u && isAlchemyRpcUrl(u) && !isKeyedRpcCooling(u, now)) return u;
  }
  for (const c of candidates) {
    const u = String(c || '').trim();
    if (u && isAlchemyRpcUrl(u)) return u;
  }
  return null;
}

export type AlchemyKeyPaceStatus = {
  id: string;
  label: string;
  cooldownMs: number;
  inFlight: number;
  backoffMs: number;
  last429At: number;
  healthy: boolean;
  role?: string;
};

export function getAlchemyPaceStatus(): {
  keys: AlchemyKeyPaceStatus[];
  anyCooling: boolean;
  scannerCooling: boolean;
  scannerConfigured: number;
} {
  const now = Date.now();
  const rows: AlchemyKeyPaceStatus[] = [];
  for (const st of keys.values()) {
    const cooldownMs = Math.max(0, st.cooldownUntil - now);
    rows.push({
      id: st.id,
      label: st.label,
      cooldownMs,
      inFlight: st.inFlight,
      backoffMs: st.backoffMs,
      last429At: st.last429At,
      healthy: cooldownMs <= 0,
    });
  }
  return {
    keys: rows,
    anyCooling: rows.some((k) => !k.healthy),
    scannerCooling: allScannerAlchemyKeysCooling(now),
    scannerConfigured: listAlchemyScannerUrlsFromEnv().length,
  };
}

export function __resetAlchemyPaceForTests(): void {
  keys.clear();
}
