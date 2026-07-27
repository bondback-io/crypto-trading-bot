/**
 * RPC URL sanitization — reject .env.example placeholders and ensure a
 * working public fallback so wallet polling never sits on a dead endpoint.
 *
 * Dual-lane layout (when two paid RPCs are configured):
 *   RPC_URL / RPC_PRIMARY     → primary lane
 *   RPC_SECONDARY (or first RPC_FALLBACKS entry) → secondary lane
 *   remaining RPC_FALLBACKS + public backups → last-resort fallbacks
 */

export const PUBLIC_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';

/**
 * Extra free/public Solana mainnet endpoints used as last-resort failover
 * after your RPC_URL / RPC_SECONDARY / RPC_FALLBACKS. No API keys required — rate-limited.
 * Prefer paid Helius/QuickNode/Alchemy for production.
 */
export const PUBLIC_RPC_FALLBACKS = [
  'https://solana-rpc.publicnode.com',
  'https://solana.drpc.org',
  'https://rpc.ankr.com/solana',
  'https://solana.api.onfinality.io/public',
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
    if (/^your[-.]/i.test(parsed.hostname)) return true;
  } catch {
    return true;
  }
  return false;
}

export function isUsableRpcUrl(url: string | null | undefined): boolean {
  return !isPlaceholderRpcUrl(url);
}

/** True for free/public endpoints that rate-limit and cannot sustain program log WS. */
export function isPublicRpcUrl(url: string | null | undefined): boolean {
  const u = (url || '').toLowerCase();
  if (!u) return true;
  return (
    u.includes('mainnet-beta.solana.com') ||
    u.includes('api.mainnet.solana.com') ||
    u.includes('api.devnet.solana.com') ||
    u.includes('publicnode.com') ||
    u.includes('solana.drpc.org') ||
    u.includes('rpc.ankr.com/solana') ||
    u.includes('onfinality.io') ||
    u.includes('1rpc.io/sol') ||
    u.includes('solana-mainnet.g.alchemy.com/v2/demo') ||
    isPlaceholderRpcUrl(url)
  );
}

export type RpcLaneRole = 'primary' | 'secondary' | 'fallback';

export interface NormalizedRpcEndpoint {
  url: string;
  label: string;
  wsUrl?: string;
  role?: RpcLaneRole;
}

/**
 * Build a sanitized endpoint list from env/config candidates.
 * Drops placeholders, dedupes, and always appends public fallbacks.
 */
export function normalizeRpcEndpoints(
  candidates: Array<{
    url: string;
    label?: string;
    wsUrl?: string;
    role?: RpcLaneRole;
  }>
): NormalizedRpcEndpoint[] {
  const seen = new Set<string>();
  const out: NormalizedRpcEndpoint[] = [];
  let droppedPlaceholder = false;

  const push = (
    url: string,
    label: string,
    role: RpcLaneRole,
    wsUrl?: string
  ) => {
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
    out.push({ url: trimmed, label, wsUrl, role });
  };

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const role: RpcLaneRole =
      c.role ||
      (c.label === 'primary'
        ? 'primary'
        : c.label === 'secondary'
          ? 'secondary'
          : i === 0
            ? 'primary'
            : 'fallback');
    push(
      c.url,
      c.label ||
        (role === 'primary'
          ? 'primary'
          : role === 'secondary'
            ? 'secondary'
            : `rpc-${i + 1}`),
      role,
      c.wsUrl
    );
  }

  // Always keep at least one working public endpoint
  push(
    PUBLIC_SOLANA_RPC,
    out.length === 0 ? 'primary' : 'public-fallback',
    out.length === 0 ? 'primary' : 'fallback'
  );
  for (let i = 0; i < PUBLIC_RPC_FALLBACKS.length; i++) {
    push(PUBLIC_RPC_FALLBACKS[i], `public-fallback-${i + 2}`, 'fallback');
  }

  if (droppedPlaceholder && out.length > 0) {
    console.warn(
      `[rpc] Using ${out[0].label} (${out[0].url}) — set a real Helius/QuickNode RPC_URL on Render for reliability`
    );
  }

  return out;
}

/**
 * Resolve dual-lane RPC list from env.
 * - RPC_URL / RPC_PRIMARY → primary
 * - RPC_SECONDARY (or SECONDARY_RPC alias), else first RPC_FALLBACKS entry → secondary
 * - remaining RPC_FALLBACKS → extra fallbacks
 */
export function rpcEndpointsFromEnv(
  primaryEnv?: string | null,
  fallbacksEnv?: string | null,
  secondaryEnv?: string | null
): NormalizedRpcEndpoint[] {
  const primary =
    (primaryEnv ?? process.env.RPC_PRIMARY ?? process.env.RPC_URL)?.trim() ||
    PUBLIC_SOLANA_RPC;
  const fallbacks = (fallbacksEnv ?? process.env.RPC_FALLBACKS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const fromRpcSecondary = process.env.RPC_SECONDARY?.trim() || '';
  const fromAlias = process.env.SECONDARY_RPC?.trim() || '';
  let secondary =
    secondaryEnv != null
      ? String(secondaryEnv).trim()
      : fromRpcSecondary || fromAlias;
  if (!fromRpcSecondary && fromAlias && secondaryEnv == null) {
    console.warn(
      '[rpc] Using SECONDARY_RPC as secondary lane — prefer renaming to RPC_SECONDARY'
    );
  }
  if (!secondary && fallbacks.length > 0) {
    secondary = fallbacks[0];
  }
  const rest = fallbacks.filter((u) => u !== secondary && u !== primary);

  if (secondary && secondary === primary) {
    console.warn(
      '[rpc] RPC_SECONDARY matches RPC_URL — both lanes share one endpoint. ' +
        'Set a distinct paid secondary URL so Zion/activity do not starve copy signals.'
    );
  }

  const candidates: Array<{
    url: string;
    label: string;
    role: RpcLaneRole;
  }> = [{ url: primary, label: 'primary', role: 'primary' }];

  if (secondary && secondary !== primary) {
    candidates.push({
      url: secondary,
      label: 'secondary',
      role: 'secondary',
    });
  }

  for (let i = 0; i < rest.length; i++) {
    candidates.push({
      url: rest[i],
      label: `fallback-${i + 1}`,
      role: 'fallback',
    });
  }

  return normalizeRpcEndpoints(candidates);
}

/** Human-readable lane assignments for Config > RPC UI. */
export const RPC_LANE_SUPPORTS = {
  primary: [
    'Trade profile bots / live execution',
    'Copy + signal scanner (wallet buy detection)',
    'Main market scanner entry RPC (filters / metrics)',
    'Pump.fun migrate scanner',
    'Open trades (on-chain needs; marks still use Dex HTTP)',
  ],
  secondary: [
    'Zion micro-bot + Place Trade',
    'KOL Token Scanner',
    'Zion open trades / trade requests (on-chain bits)',
    'Wallet on-chain activity refresh',
    'Non-critical enrichment',
  ],
  httpOnly: [
    'Email notifications (Resend / SMTP — no Solana RPC)',
    'Wallet discovery / search (GMGN, Kolscan, etc. — HTTP APIs)',
    'Open-trade mark prices (DexScreener HTTP)',
  ],
} as const;
