/**
 * RPC URL sanitization + free-tier multi-RPC manager.
 *
 * Priority order (failover pool):
 *   1. Helius Free     — HELIUS_API_KEY  → https://mainnet.helius-rpc.com/?api-key=…
 *   2. Alchemy Free    — ALCHEMY_API_KEY → https://solana-mainnet.g.alchemy.com/v2/…
 *   3. RPC_URL / RPC_PRIMARY             — legacy / extra paid endpoint
 *   4. Public Solana                     — https://api.mainnet-beta.solana.com
 *   5. RPC_SECONDARY                     — final fallback (+ Zion lane when Alchemy unset)
 *   6. remaining RPC_FALLBACKS
 *
 * Triple-lane layout (Share RPC load ON):
 *   Primary (critical) → Helius — entries, migration, wallet buy detection
 *   Secondary (scanners) → Alchemy — Market / Alpha / Zion
 *   Utility → Public Solana — wallet import / activity / light polls
 * Health monitor + piggyback failover live in connection.ts.
 */

export const PUBLIC_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';

/**
 * @deprecated Extra free hosts are no longer auto-registered (noisy / often dead).
 * Kept for isPublicRpcUrl detection only.
 */
export const PUBLIC_RPC_FALLBACKS = [
  'https://solana-rpc.publicnode.com',
  'https://solana.drpc.org',
  'https://rpc.ankr.com/solana',
  'https://solana.api.onfinality.io/public',
] as const;

const PLACEHOLDER_RE =
  /your-helius|your-quicknode|your-alchemy|example\.com|changeme|replace.?me|TODO|xxx+|<.*>|localhost:8899/i;

const KEY_PLACEHOLDER_RE =
  /^(your[-_]?|changeme|replace.?me|todo|xxx+|<.*>|demo)$/i;

export function isPlaceholderRpcUrl(url: string | null | undefined): boolean {
  const u = (url || '').trim();
  if (!u) return true;
  if (!/^https?:\/\//i.test(u)) return true;
  if (PLACEHOLDER_RE.test(u)) return true;
  try {
    const parsed = new URL(u);
    if (!parsed.hostname || parsed.hostname === 'localhost') return true;
    if (/^your[-.]/i.test(parsed.hostname)) return true;
    // Reject bare Alchemy demo path
    if (/\/v2\/demo$/i.test(parsed.pathname)) return true;
  } catch {
    return true;
  }
  return false;
}

export function isUsableRpcUrl(url: string | null | undefined): boolean {
  return !isPlaceholderRpcUrl(url);
}

function isUsableApiKey(key: string | null | undefined): boolean {
  const k = (key || '').trim();
  if (!k || k.length < 8) return false;
  if (KEY_PLACEHOLDER_RE.test(k)) return false;
  if (PLACEHOLDER_RE.test(k)) return false;
  return true;
}

/** Build Helius mainnet HTTP RPC URL from API key (null if unset/placeholder). */
export function buildHeliusRpcUrl(apiKey?: string | null): string | null {
  const key = (apiKey ?? process.env.HELIUS_API_KEY)?.trim();
  if (!isUsableApiKey(key)) return null;
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

/** Build Alchemy Solana mainnet HTTP RPC URL from API key (null if unset/placeholder). */
export function buildAlchemyRpcUrl(apiKey?: string | null): string | null {
  const key = (apiKey ?? process.env.ALCHEMY_API_KEY)?.trim();
  if (!isUsableApiKey(key)) return null;
  return `https://solana-mainnet.g.alchemy.com/v2/${key}`;
}

/** True for free/public endpoints that rate-limit and cannot sustain program log WS. */
export function isPublicRpcUrl(url: string | null | undefined): boolean {
  const u = (url || '').toLowerCase();
  if (!u) return true;
  // Free-tier Helius / Alchemy with a real key are not "public Solana RPC"
  if (u.includes('helius-rpc.com') && u.includes('api-key=')) {
    const key = u.split('api-key=')[1]?.split('&')[0] || '';
    if (isUsableApiKey(key)) return false;
  }
  if (u.includes('g.alchemy.com/v2/') && !u.endsWith('/demo')) {
    const parts = u.split('/v2/');
    const key = parts[1]?.split(/[/?#]/)[0] || '';
    if (isUsableApiKey(key)) return false;
  }
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

/**
 * Free / metered providers that look "private" but rate-limit hard under burst
 * (Helius free, Alchemy free, public Solana). Use soft poll concurrency.
 */
export function isSoftThrottleRpcUrl(url: string | null | undefined): boolean {
  if (isPublicRpcUrl(url)) return true;
  const u = (url || '').toLowerCase();
  if (!u) return true;
  if (u.includes('helius-rpc.com')) return true;
  if (u.includes('g.alchemy.com')) return true;
  // Explicit override for paid dedicated URLs that still need gentle polling
  if (process.env.RPC_SOFT_THROTTLE === '1') return true;
  // Paid / custom RPC_URL — allow higher concurrency unless forced soft
  if (process.env.RPC_SOFT_THROTTLE === '0') return false;
  return false;
}

export type RpcLaneRole = 'primary' | 'secondary' | 'utility' | 'fallback';

export interface NormalizedRpcEndpoint {
  url: string;
  label: string;
  wsUrl?: string;
  role?: RpcLaneRole;
}

/**
 * Build a sanitized endpoint list from env/config candidates.
 * Drops placeholders, dedupes. Ensures public Solana is present as last resort
 * when not already in the list.
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
          : c.label === 'utility'
            ? 'utility'
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
            : role === 'utility'
              ? 'utility'
              : `rpc-${i + 1}`),
      role,
      c.wsUrl
    );
  }

  // Always keep public Solana as last-resort if missing
  const hasPublic = out.some((e) =>
    e.url.toLowerCase().includes('mainnet-beta.solana.com')
  );
  if (!hasPublic) {
    push(
      PUBLIC_SOLANA_RPC,
      out.length === 0 ? 'primary' : 'public-fallback',
      out.length === 0 ? 'primary' : 'fallback'
    );
  }

  if (droppedPlaceholder && out.length > 0) {
    console.warn(
      `[rpc] Using ${out[0].label} — set HELIUS_API_KEY / ALCHEMY_API_KEY (or RPC_URL) for reliability`
    );
  }

  return out;
}

/**
 * Resolve dual-lane + free-tier multi-RPC list from env.
 *
 * Preferred primary:  Helius → else RPC_URL → else Alchemy → else public
 * Preferred secondary: Alchemy (if ≠ primary) → else RPC_SECONDARY → else next distinct
 * Failover scan order follows the candidate array (see module header).
 */
export function rpcEndpointsFromEnv(
  primaryEnv?: string | null,
  fallbacksEnv?: string | null,
  secondaryEnv?: string | null
): NormalizedRpcEndpoint[] {
  const helius = buildHeliusRpcUrl();
  const alchemy = buildAlchemyRpcUrl();

  const rpcUrlRaw = (
    primaryEnv ??
    process.env.RPC_PRIMARY ??
    process.env.RPC_URL ??
    ''
  ).trim();
  const rpcUrl = isUsableRpcUrl(rpcUrlRaw) ? rpcUrlRaw : '';

  const fromRpcSecondary = process.env.RPC_SECONDARY?.trim() || '';
  const fromAlias = process.env.SECONDARY_RPC?.trim() || '';
  let rpcSecondary =
    secondaryEnv != null
      ? String(secondaryEnv).trim()
      : fromRpcSecondary || fromAlias;
  if (!fromRpcSecondary && fromAlias && secondaryEnv == null) {
    console.warn(
      '[rpc] Using SECONDARY_RPC as secondary lane — prefer renaming to RPC_SECONDARY'
    );
  }
  if (rpcSecondary && !isUsableRpcUrl(rpcSecondary)) {
    rpcSecondary = '';
  }

  const fallbacks = (fallbacksEnv ?? process.env.RPC_FALLBACKS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((u) => u && isUsableRpcUrl(u));

  // Failover priority pool (deduped later by normalizeRpcEndpoints)
  type Cand = { url: string; label: string; role: RpcLaneRole };
  const pool: Cand[] = [];

  if (helius) pool.push({ url: helius, label: 'helius', role: 'fallback' });
  if (alchemy) pool.push({ url: alchemy, label: 'alchemy', role: 'fallback' });
  if (rpcUrl) pool.push({ url: rpcUrl, label: 'rpc-url', role: 'fallback' });
  pool.push({
    url: PUBLIC_SOLANA_RPC,
    label: 'public-fallback',
    role: 'fallback',
  });
  if (rpcSecondary) {
    pool.push({
      url: rpcSecondary,
      label: 'rpc-secondary',
      role: 'fallback',
    });
  }
  for (let i = 0; i < fallbacks.length; i++) {
    pool.push({
      url: fallbacks[i],
      label: `fallback-${i + 1}`,
      role: 'fallback',
    });
  }

  // Pick preferred primary / secondary / utility URLs
  const primaryUrl =
    helius || rpcUrl || alchemy || PUBLIC_SOLANA_RPC;
  let secondaryUrl = '';
  if (alchemy && alchemy !== primaryUrl) {
    secondaryUrl = alchemy;
  } else if (rpcSecondary && rpcSecondary !== primaryUrl) {
    secondaryUrl = rpcSecondary;
  } else {
    for (const c of pool) {
      if (c.url !== primaryUrl) {
        secondaryUrl = c.url;
        break;
      }
    }
  }

  // Utility lane prefers public Solana when distinct from primary/secondary
  let utilityUrl = '';
  if (
    PUBLIC_SOLANA_RPC !== primaryUrl &&
    PUBLIC_SOLANA_RPC !== secondaryUrl
  ) {
    utilityUrl = PUBLIC_SOLANA_RPC;
  } else {
    for (const c of pool) {
      if (c.url !== primaryUrl && c.url !== secondaryUrl) {
        utilityUrl = c.url;
        break;
      }
    }
    // Last resort: share secondary or primary if no third URL exists
    if (!utilityUrl) {
      utilityUrl = secondaryUrl || primaryUrl;
    }
  }

  if (secondaryUrl && secondaryUrl === primaryUrl) {
    console.warn(
      '[rpc] Primary and secondary resolve to the same URL — Zion shares CU with copy/signals.'
    );
  }

  const candidates: Cand[] = [];
  const seen = new Set<string>();
  const add = (url: string, label: string, role: RpcLaneRole) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    candidates.push({ url, label, role });
  };

  const labelFor = (url: string, fallback: string): string => {
    if (url === helius) return 'helius';
    if (url === alchemy) return 'alchemy';
    if (url === rpcUrl) return 'rpc-url';
    if (url === rpcSecondary) return 'rpc-secondary';
    if (url === PUBLIC_SOLANA_RPC) return 'public-fallback';
    return fallback;
  };

  // Preferred lanes first (sticky until unhealthy), then remaining failover order
  add(primaryUrl, labelFor(primaryUrl, 'primary'), 'primary');
  if (secondaryUrl) {
    add(secondaryUrl, labelFor(secondaryUrl, 'secondary'), 'secondary');
  }
  if (utilityUrl) {
    add(utilityUrl, labelFor(utilityUrl, 'utility'), 'utility');
  }

  for (const c of pool) {
    add(c.url, c.label, 'fallback');
  }

  const out = normalizeRpcEndpoints(candidates);

  const chain = out.map((e) => e.label).join(' → ');
  console.log(
    `[rpc] Multi-RPC chain: ${chain}` +
      (helius ? ' (Helius free primary)' : '') +
      (alchemy ? ' (Alchemy free secondary)' : '') +
      (utilityUrl === PUBLIC_SOLANA_RPC ? ' (public utility)' : '')
  );
  if (!helius && !alchemy) {
    console.warn(
      '[rpc] HELIUS_API_KEY / ALCHEMY_API_KEY unset — using RPC_URL / public. ' +
        'Set free Helius + Alchemy keys for better speed and automatic failover.'
    );
  }

  return out;
}

/** Human-readable lane assignments for Config > RPC UI (Share OFF defaults). */
export const RPC_LANE_SUPPORTS = {
  primary: [
    'Critical: trade entries / turbo / migration sniper / copy buys',
    'Wallet buy detection (signal poll)',
    'Migration listener parses',
    'Preferred: Helius Free (HELIUS_API_KEY) → failover Alchemy → public',
  ],
  secondary: [
    'Market Scanner + AlphaScan (Share ON)',
    'Zion micro-bot + KOL Token Scanner',
    'Zion Place Trade on-chain bits',
    'Preferred: Alchemy Free (ALCHEMY_API_KEY) → else RPC_SECONDARY',
  ],
  utility: [
    'Wallet favourites / import on-chain checks (Share ON)',
    'Wallet activity refresh / last-trade polls (Share ON)',
    'Other light non-entry polls',
    'Preferred: Public Solana (api.mainnet-beta.solana.com)',
  ],
  httpOnly: [
    'Email notifications (Resend / SMTP — no Solana RPC)',
    'Wallet discovery / search (GMGN, Kolscan, etc. — HTTP APIs)',
    'Open-trade mark prices (DexScreener HTTP)',
  ],
} as const;

/** Copy when Share RPC load is enabled. */
export const RPC_SHARE_LOAD_SUPPORTS = {
  critical: [
    'Helius — trade entries, turbo profiles, migration sniper/parses',
  ],
  scanners: [
    'Alchemy — Market Scanner, AlphaScan, Zion KOL scanner, Zion Place Trade',
  ],
  utility: [
    'Public Solana — wallet buy watch (Favourites), import checks, activity refresh, light polls',
  ],
} as const;
