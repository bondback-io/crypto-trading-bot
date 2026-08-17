/**
 * Alchemy CU/s pacing — classic no-op stubs (no exclusive BACKUP key map).
 */

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

export function listAlchemyScannerUrlsFromEnv(): string[] {
  return [];
}

export function alchemyCooldownRemainingMs(_now = Date.now()): number {
  void _now;
  return 0;
}

export function allScannerAlchemyKeysCooling(_now = Date.now()): boolean {
  void _now;
  return false;
}

export function shouldSkipAlchemyRpc(
  _feature?: string,
  _url?: string | null
): boolean {
  void _feature;
  void _url;
  return false;
}

export function noteAlchemyCuLimit(_endpoint?: string): boolean {
  void _endpoint;
  return false;
}

export function noteAlchemyOk(_url?: string | null): void {
  void _url;
}

export function acquireAlchemyPaceSlot(
  _feature?: string,
  _url?: string | null
): {
  allowed: boolean;
  release: () => void;
} {
  void _feature;
  void _url;
  return { allowed: true, release: () => undefined };
}

export function pickNextAlchemyScannerUrl(
  candidates: Array<string | null | undefined>
): string | null {
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
  return {
    keys: [],
    anyCooling: false,
    scannerCooling: false,
    scannerConfigured: 0,
  };
}

export function __resetAlchemyPaceForTests(): void {
  /* noop */
}
