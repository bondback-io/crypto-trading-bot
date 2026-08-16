/**
 * Credit-exhaustion guard for paid HTTP/RPC providers (Helius, Birdeye, Nansen,
 * Solana Tracker). Stops tight retries and `body:` log storms.
 *
 * Backoff is per provider (credits are account-wide). Exhausted logs are per
 * source (function/label) at most once per 60s.
 */

export const CREDITS_LOG_COOLDOWN_MS = 60_000;
export const CREDITS_GUARD_HEADER = 'x-credits-guard';
const BACKOFF_MIN_MS = 20_000;
const BACKOFF_MAX_MS = 15 * 60_000;

export type CreditsProvider =
  | 'helius'
  | 'birdeye'
  | 'nansen'
  | 'solanatracker'
  | 'other';

const backoffUntil = new Map<string, number>();
const backoffMs = new Map<string, number>();
const lastExhaustedLogAt = new Map<string, number>();

export function isInsufficientCreditsBody(text: unknown): boolean {
  const s = String(text || '');
  if (!s) return false;
  return /insufficient credits for this request|insufficient credits|not enough credits|credit limit exceeded|credit usage limit/i.test(
    s
  );
}

export function isInsufficientCreditsError(err: unknown): boolean {
  if (err == null) return false;
  if (typeof err === 'object' && err !== null) {
    const rec = err as { message?: unknown; body?: unknown; status?: unknown };
    if (isInsufficientCreditsBody(rec.message)) return true;
    if (isInsufficientCreditsBody(rec.body)) return true;
    if (Number(rec.status) === 402) return true;
  }
  return isInsufficientCreditsBody(err);
}

export function classifyCreditsProvider(
  url: string | null | undefined
): CreditsProvider {
  const u = String(url || '').toLowerCase();
  if (/helius-rpc\.com|api\.helius\.xyz|helius\.xyz/.test(u)) return 'helius';
  if (/birdeye\.so/.test(u)) return 'birdeye';
  if (/nansen\.ai/.test(u)) return 'nansen';
  if (/solanatracker\.io/.test(u)) return 'solanatracker';
  return 'other';
}

export function redactCreditsEndpoint(url: string | null | undefined): string {
  const raw = String(url || '').trim();
  if (!raw) return 'unknown';
  try {
    const parsed = new URL(raw);
    if (parsed.searchParams.has('api-key')) parsed.searchParams.set('api-key', '***');
    if (parsed.searchParams.has('apiKey')) parsed.searchParams.set('apiKey', '***');
    return `${parsed.host}${parsed.pathname}`.slice(0, 96);
  } catch {
    return raw
      .replace(/api-key=[^&]+/gi, 'api-key=***')
      .replace(/\/\/.*@/, '//***@')
      .slice(0, 96);
  }
}

export function shouldSkipCreditsProvider(provider: CreditsProvider): boolean {
  if (provider === 'other') return false;
  const until = backoffUntil.get(provider) ?? 0;
  return Date.now() < until;
}

/** @deprecated use shouldSkipCreditsProvider */
export function shouldSkipCreditsSource(source: string): boolean {
  const until = backoffUntil.get(source) ?? 0;
  return Date.now() < until;
}

export function logCreditsRequest(
  source: string,
  provider: CreditsProvider,
  endpoint: string
): void {
  if (provider === 'other') return;
  if (shouldSkipCreditsProvider(provider)) return;
  console.log(
    `[credits_request] source=${source} provider=${provider} endpoint=${redactCreditsEndpoint(endpoint)}`
  );
}

/** Returns true if this is the first exhausted log for the source in 60s. */
export function noteCreditsExhausted(
  source: string,
  provider: CreditsProvider,
  endpoint: string
): boolean {
  const now = Date.now();
  const key = provider === 'other' ? source : provider;
  const existingUntil = backoffUntil.get(key) ?? 0;
  if (existingUntil <= now) {
    const wait = Math.min(
      BACKOFF_MAX_MS,
      backoffMs.get(key) ?? BACKOFF_MIN_MS
    );
    backoffUntil.set(key, now + wait);
    backoffMs.set(key, Math.min(BACKOFF_MAX_MS, wait * 2));
  }
  const waitLeft = Math.max(0, (backoffUntil.get(key) ?? 0) - now);
  const last = lastExhaustedLogAt.get(source) ?? 0;
  if (now - last < CREDITS_LOG_COOLDOWN_MS) return false;
  lastExhaustedLogAt.set(source, now);
  console.warn(
    `[credits_exhausted] source=${source} provider=${provider} endpoint=${redactCreditsEndpoint(endpoint)} backoff=${Math.round(waitLeft / 1000)}s`
  );
  return true;
}

export function creditsBackoffResponse(): Response {
  return new Response(JSON.stringify({ error: 'credits_backoff' }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      [CREDITS_GUARD_HEADER]: '1',
    },
  });
}

export function isCreditsGuardResponse(res: Response): boolean {
  return res.headers.get(CREDITS_GUARD_HEADER) === '1';
}

export function getCreditsGuardStatus(): {
  sources: Array<{ source: string; backoffMs: number }>;
} {
  const now = Date.now();
  const sources: Array<{ source: string; backoffMs: number }> = [];
  for (const [source, until] of backoffUntil) {
    const remaining = until - now;
    if (remaining > 0) sources.push({ source, backoffMs: remaining });
  }
  return { sources };
}

export function __resetCreditsGuardForTests(): void {
  backoffUntil.clear();
  backoffMs.clear();
  lastExhaustedLogAt.clear();
}
