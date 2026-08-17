/**
 * Alchemy CU/s pacing — per-key soft cooldown + in-flight cap.
 * One key's 429 does not silence other Alchemy keys. Exit/send never blocked.
 */

import { QuietLogGate } from './httpProviderGate';
import {
  isAlchemyScannerCapacityLabel,
  listAlchemyApiKeysFromEnv,
  listAlchemyScannerUrlsFromEnv,
} from './rpcUrl';

const BACKOFF_MIN_MS = 15_000;
const BACKOFF_MAX_MS = 60_000;
/** Per-key in-flight cap (lane RPS remains the finer gate). */
const MAX_IN_FLIGHT_PER_KEY = 4;

type KeyPace = {
  id: string;
  label: string;
  cooldownUntil: number;
  backoffMs: number;
  inFlight: number;
  last429At: number;
  lastOkAt: number;
  lastStartAt: number;
};

const byKey = new Map<string, KeyPace>();
const switchLog = new QuietLogGate(60_000);
let rrCursor = 0;

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

/** Extract stable key id from Alchemy URL (path /v2/<key>). */
export function alchemyKeyIdFromUrl(url: string | null | undefined): string | null {
  const u = String(url || '');
  if (!isAlchemyRpcUrl(u)) return null;
  const m = u.match(/\/v2\/([^/?#]+)/i);
  if (m?.[1]) return m[1];
  try {
    const host = new URL(u).host;
    return host || 'alchemy';
  } catch {
    return 'alchemy';
  }
}

function labelForUrl(url: string): string {
  try {
    const keys = listAlchemyApiKeysFromEnv();
    const hit = keys.find((k) => k.url === url);
    if (hit) return hit.label;
  } catch {
    /* optional */
  }
  const id = alchemyKeyIdFromUrl(url);
  if (!id) return 'alchemy';
  return `alchemy-${id.slice(0, 6)}`;
}

function ensurePace(url: string): KeyPace | null {
  const id = alchemyKeyIdFromUrl(url);
  if (!id) return null;
  let p = byKey.get(id);
  if (!p) {
    p = {
      id,
      label: labelForUrl(url),
      cooldownUntil: 0,
      backoffMs: BACKOFF_MIN_MS,
      inFlight: 0,
      last429At: 0,
      lastOkAt: 0,
      lastStartAt: 0,
    };
    byKey.set(id, p);
  } else if (!p.label || p.label.startsWith('alchemy-')) {
    p.label = labelForUrl(url);
  }
  return p;
}

function ensureKnownScannerKeys(): void {
  try {
    for (const url of listAlchemyScannerUrlsFromEnv()) {
      ensurePace(url);
    }
  } catch {
    /* optional */
  }
}

function cooldownRemaining(p: KeyPace, now = Date.now()): number {
  return Math.max(0, p.cooldownUntil - now);
}

function isExitLikeFeature(feature?: string): boolean {
  return /send_tx|sendRawTransaction|sendLegacy|trade_exit|confirm_tx|confirmTransaction/i.test(
    String(feature || '')
  );
}

/** Max remaining cooldown across known keys (legacy helper). */
export function alchemyCooldownRemainingMs(now = Date.now()): number {
  ensureKnownScannerKeys();
  let max = 0;
  for (const p of byKey.values()) {
    max = Math.max(max, cooldownRemaining(p, now));
  }
  return max;
}

/** True when every scanner-capacity Alchemy key is cooling (or none configured). */
export function allScannerAlchemyKeysCooling(now = Date.now()): boolean {
  ensureKnownScannerKeys();
  const scannerLabels = new Set(
    listAlchemyApiKeysFromEnv()
      .filter((k) => k.role === 'scanner')
      .map((k) => k.label)
  );
  const scannerPaces = [...byKey.values()].filter(
    (p) =>
      scannerLabels.has(p.label) ||
      isAlchemyScannerCapacityLabel(p.label) ||
      p.label === 'alchemy'
  );
  if (scannerPaces.length === 0) {
    // No per-key state yet — fall back to any known cooldown
    return alchemyCooldownRemainingMs(now) > 0 && byKey.size > 0
      ? [...byKey.values()].every((p) => cooldownRemaining(p, now) > 0)
      : false;
  }
  return scannerPaces.every((p) => cooldownRemaining(p, now) > 0);
}

/**
 * Skip Alchemy for this feature.
 * - With URL: that key only.
 * - Without URL: only when all scanner keys are cooling.
 */
export function shouldSkipAlchemyRpc(
  feature?: string,
  url?: string | null
): boolean {
  if (isExitLikeFeature(feature)) return false;
  if (url) {
    const p = ensurePace(url);
    if (!p) return false;
    return cooldownRemaining(p) > 0;
  }
  return allScannerAlchemyKeysCooling();
}

function pickSwitchTarget(coolingId: string): string | null {
  ensureKnownScannerKeys();
  const now = Date.now();
  try {
    for (const url of listAlchemyScannerUrlsFromEnv()) {
      ensurePace(url);
    }
  } catch {
    /* optional */
  }
  for (const p of byKey.values()) {
    if (p.id === coolingId) continue;
    if (
      !isAlchemyScannerCapacityLabel(p.label) &&
      p.label !== 'alchemy'
    ) {
      continue;
    }
    if (cooldownRemaining(p, now) <= 0) return p.label;
  }
  for (const p of byKey.values()) {
    if (p.id === coolingId) continue;
    if (cooldownRemaining(p, now) <= 0) return p.label;
  }
  return null;
}

/** Cool this Alchemy key only. Returns true if this is the first log for the window. */
export function noteAlchemyCuLimit(endpoint?: string): boolean {
  const url = String(endpoint || '');
  const p = url ? ensurePace(url) : null;
  if (!p) {
    // No URL — do not invent a global blackout; ignore.
    return false;
  }
  const now = Date.now();
  if (cooldownRemaining(p, now) > 0) return false;
  const wait = Math.min(BACKOFF_MAX_MS, p.backoffMs);
  p.cooldownUntil = now + wait;
  p.backoffMs = Math.min(BACKOFF_MAX_MS, wait * 2);
  p.last429At = now;
  const switchingTo = pickSwitchTarget(p.id);
  if (!switchLog.allow(now)) return false;
  console.warn(
    `[alchemy_key_429] key=${p.label} cooldown=${Math.round(wait / 1000)}s` +
      (switchingTo ? ` switching_to=${switchingTo}` : ' switching_to=none')
  );
  return true;
}

export function noteAlchemyOk(url?: string | null): void {
  if (!url) return;
  const p = ensurePace(url);
  if (!p) return;
  if (cooldownRemaining(p) > 0) return;
  p.backoffMs = BACKOFF_MIN_MS;
  p.lastOkAt = Date.now();
}

export function acquireAlchemyPaceSlot(
  feature?: string,
  url?: string | null
): {
  allowed: boolean;
  release: () => void;
} {
  const noop = { allowed: true, release: () => undefined };
  if (isExitLikeFeature(feature)) return noop;
  if (!url) {
    if (shouldSkipAlchemyRpc(feature)) {
      return { allowed: false, release: () => undefined };
    }
    return noop;
  }
  const p = ensurePace(url);
  if (!p) return noop;
  if (cooldownRemaining(p) > 0) {
    return { allowed: false, release: () => undefined };
  }
  if (p.inFlight >= MAX_IN_FLIGHT_PER_KEY) {
    return { allowed: false, release: () => undefined };
  }
  p.inFlight += 1;
  p.lastStartAt = Date.now();
  let released = false;
  return {
    allowed: true,
    release: () => {
      if (released) return;
      released = true;
      p.inFlight = Math.max(0, p.inFlight - 1);
    },
  };
}

/**
 * Pick next scanner Alchemy URL among candidates (least-recently-429, then RR).
 * Serial only — caller must not fan-out in parallel.
 */
export function pickNextAlchemyScannerUrl(
  candidates: Array<string | null | undefined>
): string | null {
  const now = Date.now();
  const urls = [
    ...new Set(
      candidates
        .map((u) => String(u || '').trim())
        .filter((u) => u && isAlchemyRpcUrl(u))
    ),
  ];
  if (!urls.length) return null;
  const scored = urls.map((url, i) => {
    const p = ensurePace(url)!;
    const cool = cooldownRemaining(p, now);
    return {
      url,
      cool,
      last429At: p.last429At || 0,
      idx: i,
    };
  });
  const healthy = scored.filter((s) => s.cool <= 0);
  const pool = healthy.length ? healthy : scored;
  pool.sort((a, b) => {
    if (a.cool !== b.cool) return a.cool - b.cool;
    if (a.last429At !== b.last429At) return a.last429At - b.last429At;
    return a.idx - b.idx;
  });
  if (pool.length === 1) return pool[0].url;
  // Mild RR among equally least-429'd healthy keys
  const best429 = pool[0].last429At;
  const ties = pool.filter(
    (s) => s.cool <= 0 && s.last429At === best429
  );
  if (ties.length > 1) {
    rrCursor = (rrCursor + 1) % ties.length;
    return ties[rrCursor].url;
  }
  return pool[0].url;
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
  keysConfigured: number;
  keysHealthy: number;
  keysCooling: number;
  scannerConfigured: number;
  scannerHealthy: number;
  cooldownMs: number;
  inFlight: number;
  backoffMs: number;
  keys: AlchemyKeyPaceStatus[];
} {
  ensureKnownScannerKeys();
  const now = Date.now();
  let envKeys: ReturnType<typeof listAlchemyApiKeysFromEnv> = [];
  try {
    envKeys = listAlchemyApiKeysFromEnv();
    for (const k of envKeys) ensurePace(k.url);
  } catch {
    /* optional */
  }
  const roleByLabel = new Map(envKeys.map((k) => [k.label, k.role]));
  const keys: AlchemyKeyPaceStatus[] = [...byKey.values()].map((p) => {
    const cool = cooldownRemaining(p, now);
    return {
      id: p.id.slice(0, 8) + '…',
      label: p.label,
      cooldownMs: cool,
      inFlight: p.inFlight,
      backoffMs: p.backoffMs,
      last429At: p.last429At,
      healthy: cool <= 0,
      role: roleByLabel.get(p.label),
    };
  });
  const scannerKeys = keys.filter(
    (k) =>
      k.role === 'scanner' ||
      isAlchemyScannerCapacityLabel(k.label) ||
      k.label === 'alchemy'
  );
  const inFlight = keys.reduce((n, k) => n + k.inFlight, 0);
  const cooldownMs = Math.max(0, ...keys.map((k) => k.cooldownMs), 0);
  const backoffMs = Math.max(
    BACKOFF_MIN_MS,
    ...keys.map((k) => k.backoffMs),
    BACKOFF_MIN_MS
  );
  return {
    keysConfigured: envKeys.length || keys.length,
    keysHealthy: keys.filter((k) => k.healthy).length,
    keysCooling: keys.filter((k) => !k.healthy).length,
    scannerConfigured: scannerKeys.length || listAlchemyScannerUrlsFromEnv().length,
    scannerHealthy: scannerKeys.filter((k) => k.healthy).length,
    cooldownMs,
    inFlight,
    backoffMs,
    keys,
  };
}

export function __resetAlchemyPaceForTests(): void {
  byKey.clear();
  rrCursor = 0;
}
