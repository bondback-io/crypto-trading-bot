/**
 * RPC URL sanitization + free-tier multi-RPC manager.
 *
 * Priority order (failover pool):
 *   1. Helius pool     — HELIUS_RPC_URL (+ BACKUP) or HELIUS_API_KEY
 *   2. Alchemy pool    — ALCHEMY_RPC_URL (+ BACKUP) or ALCHEMY_API_KEY
 *   3. QuickNode       — QUICKNODE_RPC_URL (mid-tier paid failover for Critical/Scanners)
 *   4. RPC_URL / RPC_PRIMARY             — Triton api.mainnet.solana.com preferred for Utility
 *   5. Public Solana                     — https://solana-rpc.publicnode.com
 *   6. Official public fallback          — https://api.mainnet-beta.solana.com (last resort)
 *   7. RPC_SECONDARY                     — extra fallback (+ Zion lane when Alchemy unset)
 *   8. remaining RPC_FALLBACKS
 *
 * Triple-lane layout (Share RPC load ON):
 *   Primary (critical) → Helius pool (RR among healthy) — entries, migration, wallet buy detection
 *   Secondary (scanners) → Alchemy pool (RR among healthy) — Market / Alpha / Zion
 *   Utility → official mainnet-beta (api.mainnet-beta.solana.com), then publicnode / Triton
 * Paid-lane failover: preferred sibling → other provider → QuickNode → public.
 * Health monitor + piggyback failover live in connection.ts.
 */

/** Official Solana public RPC — last-resort only (often slow from Render/cloud). */
export const PUBLIC_SOLANA_RPC_OFFICIAL =
  'https://api.mainnet-beta.solana.com';

/**
 * Triton-operated public mainnet — preferred Utility host when configured.
 * @see https://api.mainnet.solana.com
 */
export const PUBLIC_SOLANA_RPC_TRITON = 'https://api.mainnet.solana.com';

/**
 * Fallback free public endpoint for the Utility lane when Triton is unset.
 * publicnode is typically much faster from cloud hosts than official mainnet-beta.
 */
export const PUBLIC_SOLANA_RPC = 'https://solana-rpc.publicnode.com';

/**
 * @deprecated Extra free hosts are no longer auto-registered (noisy / often dead).
 * Kept for isPublicRpcUrl detection only.
 */
export const PUBLIC_RPC_FALLBACKS = [
  PUBLIC_SOLANA_RPC,
  PUBLIC_SOLANA_RPC_OFFICIAL,
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

export type RpcProviderKind = 'helius' | 'alchemy' | 'other';
export type RpcPoolSlot = 'primary' | 'backup' | 'solo';

export interface RpcPoolMember {
  url: string;
  label: string;
  provider: RpcProviderKind;
  slot: RpcPoolSlot;
}

function stripEnvQuotes(raw: string): string {
  let u = raw.trim();
  // Render / dotenv sometimes wraps secrets in quotes
  if (
    (u.startsWith('"') && u.endsWith('"')) ||
    (u.startsWith("'") && u.endsWith("'"))
  ) {
    u = u.slice(1, -1).trim();
  }
  return u;
}

function normalizeExplicitRpcUrl(raw: string | null | undefined): string | null {
  const u = stripEnvQuotes(raw || '');
  if (!u || !isUsableRpcUrl(u)) return null;
  return u;
}

/**
 * Accept full HTTPS RPC URLs or bare API keys in HELIUS_RPC_URL / ALCHEMY_RPC_URL
 * (and backups). Bare keys are coerced to the provider HTTP URL.
 */
function coerceProviderRpcEnvValue(
  provider: 'helius' | 'alchemy',
  raw: string | null | undefined
): string | null {
  const u = stripEnvQuotes(raw || '');
  if (!u) return null;
  if (isUsableRpcUrl(u)) return u;
  // Bare key pasted into *_RPC_URL (common after renaming HELIUS_API_KEY → HELIUS_RPC_URL)
  if (!/^https?:\/\//i.test(u) && isUsableApiKey(u)) {
    return provider === 'helius' ? buildHeliusRpcUrl(u) : buildAlchemyRpcUrl(u);
  }
  return null;
}

/** First env key that has a non-empty raw value (may still be invalid). */
function firstPresentEnvKey(...keys: string[]): string | null {
  for (const key of keys) {
    if (stripEnvQuotes(process.env[key] || '')) return key;
  }
  return null;
}

function rpcHostOnly(url: string | null | undefined): string {
  const u = (url || '').trim();
  if (!u) return '—';
  try {
    return new URL(u).host || '—';
  } catch {
    return u.slice(0, 40);
  }
}

type BackupSkipReason = 'missing' | 'invalid' | 'duplicate';

/**
 * Resolve a provider pool (primary + optional backup) with structured boot logs.
 * New Render names are preferred; legacy API keys / typo aliases remain as fallbacks.
 * HELIUS_RPC_URL / ALCHEMY_RPC_URL may be a full URL or a bare API key.
 */
function resolveProviderPoolMembers(opts: {
  provider: 'helius' | 'alchemy';
  primaryKeys: string[];
  backupKeys: string[];
  buildFromApiKey: () => string | null;
  apiKeyEnv: string;
}): RpcPoolMember[] {
  const { provider, primaryKeys, backupKeys, buildFromApiKey, apiKeyEnv } = opts;
  let primarySource: string | null = null;
  let primary: string | null = null;
  for (const key of primaryKeys) {
    const v = coerceProviderRpcEnvValue(provider, process.env[key]);
    if (v) {
      primary = v;
      primarySource = key;
      break;
    }
  }
  if (!primary) {
    const fromKey = buildFromApiKey();
    if (fromKey) {
      primary = fromKey;
      primarySource = apiKeyEnv;
    }
  }

  const backupPresentKey = firstPresentEnvKey(...backupKeys);
  let backup: string | null = null;
  let backupSource: string | null = null;
  for (const key of backupKeys) {
    const v = coerceProviderRpcEnvValue(provider, process.env[key]);
    if (v) {
      backup = v;
      backupSource = key;
      break;
    }
  }

  const out: RpcPoolMember[] = [];
  const dual = Boolean(primary && backup && backup !== primary);
  if (primary) {
    out.push({
      url: primary,
      label: dual ? `${provider}-primary` : provider,
      provider,
      slot: dual ? 'primary' : 'solo',
    });
  }
  if (dual && backup) {
    out.push({
      url: backup,
      label: `${provider}-backup`,
      provider,
      slot: 'backup',
    });
  }

  console.log(
    `rpc_env_loaded provider=${provider} primary=${primary ? 'set' : 'unset'}` +
      ` source=${primarySource || '—'}` +
      ` host=${rpcHostOnly(primary)}`
  );

  if (dual && backup) {
    console.log(
      `rpc_backup_loaded provider=${provider} source=${backupSource || '—'}` +
        ` host=${rpcHostOnly(backup)}`
    );
  } else {
    let reason: BackupSkipReason = 'missing';
    if (backupPresentKey && !backup) reason = 'invalid';
    else if (backup && primary && backup === primary) reason = 'duplicate';
    else if (!backupPresentKey) reason = 'missing';
    console.log(`rpc_backup_unset provider=${provider} reason=${reason}`);
  }

  return out;
}

/**
 * Resolve Helius pool members: HELIUS_RPC_URL (+ BACKUP), else HELIUS_API_KEY.
 * Also accepts HELIUS_RPC_URLBACKUP (no underscore) as a temporary alias.
 * 0–2 members; duplicate URLs collapsed; invalid backup → solo (no throw).
 */
export function resolveHeliusPoolMembers(): RpcPoolMember[] {
  return resolveProviderPoolMembers({
    provider: 'helius',
    primaryKeys: ['HELIUS_RPC_URL', 'HELIUS_RPC_PRIMARY'],
    backupKeys: [
      'HELIUS_RPC_URL_BACKUP',
      'HELIUS_RPC_URLBACKUP',
      'HELIUS_RPC_BACKUP',
    ],
    buildFromApiKey: () => buildHeliusRpcUrl(),
    apiKeyEnv: 'HELIUS_API_KEY',
  });
}

/**
 * Resolve Alchemy pool members: ALCHEMY_RPC_URL (+ BACKUP), else ALCHEMY_API_KEY.
 * Also accepts ALCHEMY_RPC_URLBACKUP (no underscore) as a temporary alias.
 */
export function resolveAlchemyPoolMembers(): RpcPoolMember[] {
  return resolveProviderPoolMembers({
    provider: 'alchemy',
    primaryKeys: ['ALCHEMY_RPC_URL', 'ALCHEMY_RPC_PRIMARY'],
    backupKeys: [
      'ALCHEMY_RPC_URL_BACKUP',
      'ALCHEMY_RPC_URLBACKUP',
      'ALCHEMY_RPC_BACKUP',
    ],
    buildFromApiKey: () => buildAlchemyRpcUrl(),
    apiKeyEnv: 'ALCHEMY_API_KEY',
  });
}

/** Infer provider from URL / label when metadata missing. */
export function inferRpcProvider(
  url: string | null | undefined,
  label?: string | null
): RpcProviderKind {
  const l = String(label || '').toLowerCase();
  if (l.startsWith('helius')) return 'helius';
  if (l.startsWith('alchemy')) return 'alchemy';
  const u = (url || '').toLowerCase();
  if (u.includes('helius-rpc.com') || u.includes('helius')) return 'helius';
  if (u.includes('g.alchemy.com') || u.includes('alchemy')) return 'alchemy';
  return 'other';
}

export function inferRpcPoolSlot(
  label?: string | null,
  provider?: RpcProviderKind
): RpcPoolSlot {
  const l = String(label || '').toLowerCase();
  if (l.includes('backup')) return 'backup';
  if (l.includes('primary') && (provider === 'helius' || provider === 'alchemy')) {
    return 'primary';
  }
  if (l === 'helius' || l === 'alchemy') return 'solo';
  return 'solo';
}

/** True for QuickNode hosted Solana HTTP endpoints. */
export function isQuicknodeRpcUrl(url: string | null | undefined): boolean {
  const u = (url || '').toLowerCase();
  return u.includes('quiknode.pro') || u.includes('quicknode.com');
}

/**
 * Paid mid-tier failover endpoint (full HTTPS URL from QuickNode dashboard).
 * Env: QUICKNODE_RPC_URL or QUICKNODE_HTTP_URL.
 */
export function buildQuicknodeRpcUrl(
  explicit?: string | null
): string | null {
  const raw = (
    explicit ??
    process.env.QUICKNODE_RPC_URL ??
    process.env.QUICKNODE_HTTP_URL ??
    ''
  ).trim();
  if (!raw || !isUsableRpcUrl(raw)) return null;
  return raw;
}

/** Official Solana Labs public mainnet-beta (often slow from cloud). */
export function isOfficialMainnetBetaRpcUrl(
  url: string | null | undefined
): boolean {
  return (url || '').toLowerCase().includes('mainnet-beta.solana.com');
}

/** Triton public mainnet host (api.mainnet.solana.com). */
export function isTritonMainnetRpcUrl(url: string | null | undefined): boolean {
  const u = (url || '').toLowerCase();
  return (
    u.includes('api.mainnet.solana.com') && !u.includes('mainnet-beta.solana.com')
  );
}

/** True for free/public endpoints that rate-limit and cannot sustain program log WS. */
export function isPublicRpcUrl(url: string | null | undefined): boolean {
  const u = (url || '').toLowerCase();
  if (!u) return true;
  // Paid QuickNode is never "public"
  if (isQuicknodeRpcUrl(u)) return false;
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
 * QuickNode is paid mid-tier — not soft-throttled unless RPC_SOFT_THROTTLE=1.
 */
export function isSoftThrottleRpcUrl(url: string | null | undefined): boolean {
  if (isPublicRpcUrl(url)) return true;
  const u = (url || '').toLowerCase();
  if (!u) return true;
  if (isQuicknodeRpcUrl(u)) {
    return process.env.RPC_SOFT_THROTTLE === '1';
  }
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
  provider?: RpcProviderKind;
  slot?: RpcPoolSlot;
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
    provider?: RpcProviderKind;
    slot?: RpcPoolSlot;
  }>
): NormalizedRpcEndpoint[] {
  const seen = new Set<string>();
  const out: NormalizedRpcEndpoint[] = [];
  let droppedPlaceholder = false;

  const push = (
    url: string,
    label: string,
    role: RpcLaneRole,
    wsUrl?: string,
    provider?: RpcProviderKind,
    slot?: RpcPoolSlot
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
    const prov = provider || inferRpcProvider(trimmed, label);
    const poolSlot = slot || inferRpcPoolSlot(label, prov);
    out.push({
      url: trimmed,
      label,
      wsUrl,
      role,
      provider: prov,
      slot: poolSlot,
    });
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
      c.wsUrl,
      c.provider,
      c.slot
    );
  }

  // Always keep a public endpoint as last resort if missing
  const hasPublic = out.some((e) => isPublicRpcUrl(e.url));
  if (!hasPublic) {
    push(
      PUBLIC_SOLANA_RPC,
      out.length === 0 ? 'primary' : 'publicnode',
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
 * Preferred primary:  Helius pool → else RPC_URL → else Alchemy → else public
 * Preferred secondary: Alchemy pool (if ≠ primary) → else RPC_SECONDARY → else next distinct
 * Failover scan order follows the candidate array (see module header).
 */
export function rpcEndpointsFromEnv(
  primaryEnv?: string | null,
  fallbacksEnv?: string | null,
  secondaryEnv?: string | null
): NormalizedRpcEndpoint[] {
  const heliusPool = resolveHeliusPoolMembers();
  const alchemyPool = resolveAlchemyPoolMembers();
  const helius = heliusPool[0]?.url || null;
  const alchemy = alchemyPool[0]?.url || null;
  const quicknode = buildQuicknodeRpcUrl();

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
  type Cand = {
    url: string;
    label: string;
    role: RpcLaneRole;
    wsUrl?: string;
    provider?: RpcProviderKind;
    slot?: RpcPoolSlot;
  };
  const pool: Cand[] = [];

  for (const m of heliusPool) {
    pool.push({
      url: m.url,
      label: m.label,
      role: 'fallback',
      provider: m.provider,
      slot: m.slot,
    });
  }
  for (const m of alchemyPool) {
    pool.push({
      url: m.url,
      label: m.label,
      role: 'fallback',
      provider: m.provider,
      slot: m.slot,
    });
  }
  if (quicknode) {
    const qnWs = process.env.QUICKNODE_WSS_URL?.trim();
    pool.push({
      url: quicknode,
      label: 'quicknode',
      role: 'fallback',
      wsUrl: qnWs && isUsableRpcUrl(qnWs) ? qnWs : undefined,
      provider: 'other',
      slot: 'solo',
    });
  }
  if (rpcUrl) {
    pool.push({
      url: rpcUrl,
      label: 'rpc-url',
      role: 'fallback',
      provider: inferRpcProvider(rpcUrl, 'rpc-url'),
      slot: 'solo',
    });
  }
  pool.push({
    url: PUBLIC_SOLANA_RPC,
    label: 'publicnode',
    role: 'fallback',
    provider: 'other',
    slot: 'solo',
  });
  pool.push({
    url: PUBLIC_SOLANA_RPC_OFFICIAL,
    label: 'mainnet-beta',
    role: 'fallback',
    provider: 'other',
    slot: 'solo',
  });
  if (rpcSecondary) {
    pool.push({
      url: rpcSecondary,
      label: 'rpc-secondary',
      role: 'fallback',
      provider: inferRpcProvider(rpcSecondary, 'rpc-secondary'),
      slot: 'solo',
    });
  }
  for (let i = 0; i < fallbacks.length; i++) {
    pool.push({
      url: fallbacks[i],
      label: `fallback-${i + 1}`,
      role: 'fallback',
      provider: inferRpcProvider(fallbacks[i], `fallback-${i + 1}`),
      slot: 'solo',
    });
  }

  // Pick preferred primary / secondary / utility URLs (first member of each pool)
  const primaryUrl = helius || rpcUrl || alchemy || PUBLIC_SOLANA_RPC;
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

  // Utility lane prefers official mainnet-beta, then publicnode / Triton.
  let utilityUrl = '';
  const utilityPrefs = [
    PUBLIC_SOLANA_RPC_OFFICIAL,
    rpcUrl && isOfficialMainnetBetaRpcUrl(rpcUrl) ? rpcUrl : '',
    PUBLIC_SOLANA_RPC,
    rpcUrl && isTritonMainnetRpcUrl(rpcUrl) ? rpcUrl : '',
    rpcSecondary && isTritonMainnetRpcUrl(rpcSecondary) ? rpcSecondary : '',
    rpcSecondary && !isOfficialMainnetBetaRpcUrl(rpcSecondary) ? rpcSecondary : '',
  ].filter((u) => u && isUsableRpcUrl(u));
  for (const u of utilityPrefs) {
    if (u !== primaryUrl && u !== secondaryUrl) {
      utilityUrl = u;
      break;
    }
  }
  if (!utilityUrl) {
    for (const c of pool) {
      if (c.url === primaryUrl || c.url === secondaryUrl) continue;
      utilityUrl = c.url;
      break;
    }
  }
  if (!utilityUrl) {
    utilityUrl =
      PUBLIC_SOLANA_RPC_OFFICIAL !== primaryUrl &&
      PUBLIC_SOLANA_RPC_OFFICIAL !== secondaryUrl
        ? PUBLIC_SOLANA_RPC_OFFICIAL
        : PUBLIC_SOLANA_RPC !== primaryUrl && PUBLIC_SOLANA_RPC !== secondaryUrl
          ? PUBLIC_SOLANA_RPC
          : secondaryUrl || primaryUrl;
  }

  if (secondaryUrl && secondaryUrl === primaryUrl) {
    console.warn(
      '[rpc] Primary and secondary resolve to the same URL — Zion shares CU with copy/signals.'
    );
  }

  const candidates: Cand[] = [];
  const seen = new Set<string>();
  const add = (
    url: string,
    label: string,
    role: RpcLaneRole,
    wsUrl?: string,
    provider?: RpcProviderKind,
    slot?: RpcPoolSlot
  ) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    candidates.push({ url, label, role, wsUrl, provider, slot });
  };

  const metaFor = (
    url: string
  ): { label: string; provider?: RpcProviderKind; slot?: RpcPoolSlot } => {
    const fromPool = pool.find((c) => c.url === url);
    if (fromPool) {
      return {
        label: fromPool.label,
        provider: fromPool.provider,
        slot: fromPool.slot,
      };
    }
    if (url === quicknode) return { label: 'quicknode', provider: 'other', slot: 'solo' };
    if (url === rpcUrl) return { label: 'rpc-url', provider: inferRpcProvider(url), slot: 'solo' };
    if (url === rpcSecondary) {
      return { label: 'rpc-secondary', provider: inferRpcProvider(url), slot: 'solo' };
    }
    if (url === PUBLIC_SOLANA_RPC) {
      return { label: 'publicnode', provider: 'other', slot: 'solo' };
    }
    if (url === PUBLIC_SOLANA_RPC_OFFICIAL) {
      return { label: 'mainnet-beta', provider: 'other', slot: 'solo' };
    }
    if (isTritonMainnetRpcUrl(url)) {
      return { label: 'mainnet-triton', provider: 'other', slot: 'solo' };
    }
    return { label: 'rpc', provider: inferRpcProvider(url), slot: 'solo' };
  };

  // Preferred lanes first — include full Helius/Alchemy pools as fallbacks next
  {
    const m = metaFor(primaryUrl);
    add(primaryUrl, m.label, 'primary', undefined, m.provider, m.slot);
  }
  if (secondaryUrl) {
    const m = metaFor(secondaryUrl);
    add(secondaryUrl, m.label, 'secondary', undefined, m.provider, m.slot);
  }
  if (utilityUrl) {
    const m = metaFor(utilityUrl);
    add(utilityUrl, m.label, 'utility', undefined, m.provider, m.slot);
  }

  // Remaining Helius / Alchemy siblings (backup) + other failover order
  for (const c of pool) {
    add(c.url, c.label, 'fallback', c.wsUrl, c.provider, c.slot);
  }

  const out = normalizeRpcEndpoints(candidates);

  const heliusN = heliusPool.length;
  const alchemyN = alchemyPool.length;
  const chain = out.map((e) => e.label).join(' → ');
  console.log(
    `[rpc] Multi-RPC chain: ${chain}` +
      (heliusN
        ? ` (Helius pool×${heliusN})`
        : '') +
      (alchemyN ? ` (Alchemy pool×${alchemyN})` : '') +
      (quicknode ? ' (QuickNode mid-tier)' : '') +
      (utilityUrl && isOfficialMainnetBetaRpcUrl(utilityUrl)
        ? ' (mainnet-beta utility)'
        : utilityUrl && isTritonMainnetRpcUrl(utilityUrl)
          ? ' (Triton api.mainnet.solana.com utility)'
          : utilityUrl === PUBLIC_SOLANA_RPC
            ? ' (publicnode utility)'
            : '')
  );
  if (!helius && !alchemy) {
    console.warn(
      '[rpc] No Helius/Alchemy pool — using RPC_URL / public. ' +
        'Set HELIUS_RPC_URL (+ HELIUS_RPC_URL_BACKUP) and ALCHEMY_RPC_URL (+ ALCHEMY_RPC_URL_BACKUP), ' +
        'or HELIUS_API_KEY / ALCHEMY_API_KEY.'
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
    'Preferred: Helius → Alchemy → QuickNode → public',
  ],
  secondary: [
    'Market Scanner + AlphaScan (Share ON)',
    'Zion micro-bot + KOL Token Scanner',
    'Zion Place Trade on-chain bits',
    'Preferred: Alchemy → Helius → QuickNode → public',
  ],
  utility: [
    'Wallet favourites / import on-chain checks (Share ON)',
    'Wallet activity refresh / last-trade polls (Share ON)',
    'Other light non-entry polls',
    'Preferred: official mainnet-beta → publicnode → Triton → last-resort fallbacks',
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
    'mainnet-beta — wallet buy watch (Favourites), import checks, activity refresh, light polls',
  ],
} as const;
