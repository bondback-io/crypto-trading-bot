/**
 * RPC URL sanitization — reject .env.example placeholders and ensure a
 * working public fallback so wallet polling never sits on a dead endpoint.
 */

export const PUBLIC_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';

/** Extra free/public endpoints used only as last-resort failover */
export const PUBLIC_RPC_FALLBACKS = [
  'https://solana-rpc.publicnode.com',
] as const;

const PLACEHOLDER_RE =
  /your-helius|your-quicknode|example\.com|changeme|replace.?me|TODO|xxx+|<.*>|localhost:8899/i;

export function isPlaceholderRpcUrl(url: string | null | undefined): boolean {
  const u = (url || '').trim();
  if (!u) return true;
  if (!/^https?:\/\//i.test(u)) return true;
  if (PLACEHOLDER_RE.test(u)) return true;
  try {
    const parsed = new URL(u);
    if (!parsed.hostname || parsed.hostname === 'localhost') return true;
    // Bare template host from older .env.example copies
    if (/^your[-.]/i.test(parsed.hostname)) return true;
  } catch {
    return true;
  }
  return false;
}

export function isUsableRpcUrl(url: string | null | undefined): boolean {
  return !isPlaceholderRpcUrl(url);
}

export interface NormalizedRpcEndpoint {
  url: string;
  label: string;
  wsUrl?: string;
}

/**
 * Build a sanitized endpoint list from env/config candidates.
 * Drops placeholders, dedupes, and always appends public fallbacks.
 */
export function normalizeRpcEndpoints(
  candidates: Array<{ url: string; label?: string; wsUrl?: string }>
): NormalizedRpcEndpoint[] {
  const seen = new Set<string>();
  const out: NormalizedRpcEndpoint[] = [];
  let droppedPlaceholder = false;

  const push = (url: string, label: string, wsUrl?: string) => {
    const trimmed = url.trim();
    if (!trimmed || seen.has(trimmed)) return;
    if (!isUsableRpcUrl(trimmed)) {
      droppedPlaceholder = true;
      console.warn(
        `[rpc] Ignoring invalid/placeholder RPC_URL: ${trimmed.slice(0, 64)}`
      );
      return;
    }
    seen.add(trimmed);
    out.push({ url: trimmed, label, wsUrl });
  };

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    push(c.url, c.label || (i === 0 ? 'primary' : `rpc-${i + 1}`), c.wsUrl);
  }

  // Always keep at least one working public endpoint
  push(PUBLIC_SOLANA_RPC, out.length === 0 ? 'primary' : 'public-fallback');
  for (let i = 0; i < PUBLIC_RPC_FALLBACKS.length; i++) {
    push(PUBLIC_RPC_FALLBACKS[i], `public-fallback-${i + 2}`);
  }

  if (droppedPlaceholder && out.length > 0) {
    console.warn(
      `[rpc] Using ${out[0].label} (${out[0].url}) — set a real Helius/QuickNode RPC_URL on Render for reliability`
    );
  }

  return out;
}

/** Resolve primary + comma-separated fallbacks from process env / defaults */
export function rpcEndpointsFromEnv(
  primaryEnv?: string | null,
  fallbacksEnv?: string | null
): NormalizedRpcEndpoint[] {
  const primary =
    (primaryEnv ?? process.env.RPC_URL)?.trim() || PUBLIC_SOLANA_RPC;
  const fallbacks = (fallbacksEnv ?? process.env.RPC_FALLBACKS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return normalizeRpcEndpoints([
    { url: primary, label: 'primary' },
    ...fallbacks.map((url, i) => ({ url, label: `fallback-${i + 1}` })),
  ]);
}
