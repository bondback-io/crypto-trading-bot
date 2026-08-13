/**
 * RPC URL sanitization + multi-RPC manager.
 *
 * Sticky 2-lane layout (Share RPC load ON):
 *   Trading (primary)  → ALCHEMY_API_KEY_BACKUP
 *   Data (secondary)   → ALCHEMY_API_KEY
 * Emergency (Trading hard-fail only) → publicnode / public RPC_URL
 *
 * Helius / Helius-backup / Alchemy BACKUP2 / QuickNode may be parsed for
 * diagnostics but are never preferred, probed, or used for soft/hard hops.
 * Favourites / activity ride the Data lane (never Trading).
 */

/** Official Solana public RPC — last-resort only (often slow from Render/cloud). */
export const PUBLIC_SOLANA_RPC_OFFICIAL =
  'https://api.mainnet-beta.solana.com';

/**
 * Triton-operated public mainnet — optional public emergency host.
 * @see https://api.mainnet.solana.com
 */
export const PUBLIC_SOLANA_RPC_TRITON = 'https://api.mainnet.solana.com';

/**
 * Preferred public emergency endpoint (Trading hard-fail only).
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

/** Build Helius mainnet HTTP RPC URL from HELIUS_RPC_URL or API key. */
export function buildHeliusRpcUrl(apiKey?: string | null): string | null {
  const fromUrl = (process.env.HELIUS_RPC_URL || '').trim();
  if (fromUrl && isUsableRpcUrl(fromUrl)) return fromUrl;
  if (fromUrl && isUsableApiKey(fromUrl)) {
    return `https://mainnet.helius-rpc.com/?api-key=${fromUrl}`;
  }
  const key = (apiKey ?? process.env.HELIUS_API_KEY)?.trim();
  if (!isUsableApiKey(key)) return null;
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

/** Build Alchemy Solana mainnet HTTP RPC URL from ALCHEMY_RPC_URL or API key. */
export function buildAlchemyRpcUrl(apiKey?: string | null): string | null {
  const fromUrl = (process.env.ALCHEMY_RPC_URL || '').trim();
  if (fromUrl && isUsableRpcUrl(fromUrl)) return fromUrl;
  if (fromUrl && isUsableApiKey(fromUrl)) {
    return `https://solana-mainnet.g.alchemy.com/v2/${fromUrl}`;
  }
  const key = (apiKey ?? process.env.ALCHEMY_API_KEY)?.trim();
  if (!isUsableApiKey(key)) return null;
  return `https://solana-mainnet.g.alchemy.com/v2/${key}`;
}

function coerceUrlOrBareKey(
  raw: string | undefined,
  wrapKey: (key: string) => string
): string | null {
  const v = (raw || '').trim();
  if (!v) return null;
  if (isUsableRpcUrl(v)) return v;
  if (isUsableApiKey(v)) return wrapKey(v);
  return null;
}

/** Emergency-only Helius sibling (HELIUS_RPC_URL_BACKUP / HELIUS_API_KEY_BACKUP). */
export function buildHeliusBackupRpcUrl(): string | null {
  const wrap = (k: string) => `https://mainnet.helius-rpc.com/?api-key=${k}`;
  return (
    coerceUrlOrBareKey(
      process.env.HELIUS_RPC_URL_BACKUP || process.env.HELIUS_RPC_URLBACKUP,
      wrap
    ) || coerceUrlOrBareKey(process.env.HELIUS_API_KEY_BACKUP, wrap)
  );
}

/** Sticky Trading Alchemy (ALCHEMY_API_KEY_BACKUP). Distinct from Data. */
export function buildAlchemyBackupRpcUrl(): string | null {
  const wrap = (k: string) => `https://solana-mainnet.g.alchemy.com/v2/${k}`;
  return (
    coerceUrlOrBareKey(
      process.env.ALCHEMY_RPC_URL_BACKUP || process.env.ALCHEMY_RPC_URLBACKUP,
      wrap
    ) || coerceUrlOrBareKey(process.env.ALCHEMY_API_KEY_BACKUP, wrap)
  );
}

/** Unused in 2-lane mode (ALCHEMY_API_KEY_BACKUP2). Parsed only; never preferred/hopped. */
export function buildAlchemyBackup2RpcUrl(): string | null {
  const wrap = (k: string) => `https://solana-mainnet.g.alchemy.com/v2/${k}`;
  return (
    coerceUrlOrBareKey(
      process.env.ALCHEMY_RPC_URL_BACKUP2 || process.env.ALCHEMY_RPC_URLBACKUP2,
      wrap
    ) || coerceUrlOrBareKey(process.env.ALCHEMY_API_KEY_BACKUP2, wrap)
  );
}

export function isEmergencyBackupLabel(label: string | null | undefined): boolean {
  const l = (label || '').toLowerCase();
  return (
    l === 'helius' ||
    l === 'helius-backup' ||
    l === 'alchemy-backup2'
  );
}

/** Legacy Critical provider switch — Helius sticky is disabled in 2-lane mode. */
export function getRpcCriticalProvider(): 'alchemy' | 'helius' {
  return 'alchemy';
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
 * Resolve Trading + Data sticky lanes + public emergency from env.
 *
 * Preferred Trading: ALCHEMY_API_KEY_BACKUP → else ALCHEMY_API_KEY → else RPC_URL → else public
 * Preferred Data: ALCHEMY_API_KEY (if ≠ Trading) → else RPC_SECONDARY → else next non-paid distinct
 * Emergency public registered as fallback (not a third sticky lane).
 * Helius / BACKUP2 / QuickNode are NOT registered in the active chain (parsed unused).
 */
export function rpcEndpointsFromEnv(
  primaryEnv?: string | null,
  fallbacksEnv?: string | null,
  secondaryEnv?: string | null
): NormalizedRpcEndpoint[] {
  const helius = buildHeliusRpcUrl();
  const alchemy = buildAlchemyRpcUrl();
  const heliusBackup = buildHeliusBackupRpcUrl();
  const alchemyBackup = buildAlchemyBackupRpcUrl();
  const alchemyBackup2 = buildAlchemyBackup2RpcUrl();
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

  type Cand = { url: string; label: string; role: RpcLaneRole; wsUrl?: string };
  const pool: Cand[] = [];

  // Active pool: Alchemy Trading/Data + public emergency only (no Helius/BACKUP2/QN hops).
  if (alchemy) pool.push({ url: alchemy, label: 'alchemy', role: 'fallback' });
  if (alchemyBackup && alchemyBackup !== alchemy) {
    pool.push({
      url: alchemyBackup,
      label: 'alchemy-critical',
      role: 'fallback',
    });
  } else if (
    alchemyBackup &&
    alchemy &&
    alchemyBackup === alchemy &&
    (process.env.ALCHEMY_API_KEY_BACKUP || process.env.ALCHEMY_RPC_URL_BACKUP)
  ) {
    console.warn(
      '[rpc] ALCHEMY_API_KEY_BACKUP matches Data ALCHEMY_API_KEY — ignored. Use a distinct Alchemy app key for Trading.'
    );
  }
  if (rpcUrl) pool.push({ url: rpcUrl, label: 'rpc-url', role: 'fallback' });
  pool.push({
    url: PUBLIC_SOLANA_RPC,
    label: 'publicnode',
    role: 'fallback',
  });
  pool.push({
    url: PUBLIC_SOLANA_RPC_OFFICIAL,
    label: 'mainnet-beta',
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

  const alchemyCritical =
    alchemyBackup && alchemyBackup !== alchemy ? alchemyBackup : null;
  const primaryUrl =
    alchemyCritical || alchemy || rpcUrl || PUBLIC_SOLANA_RPC;
  let secondaryUrl = '';
  if (alchemy && alchemy !== primaryUrl) {
    secondaryUrl = alchemy;
  } else if (rpcSecondary && rpcSecondary !== primaryUrl) {
    secondaryUrl = rpcSecondary;
  } else {
    for (const c of pool) {
      if (c.url === primaryUrl) continue;
      if (c.label === 'alchemy-critical') continue;
      secondaryUrl = c.url;
      break;
    }
  }

  // Public emergency host (not a sticky Utility lane).
  let emergencyUrl = '';
  const emergencyPrefs = [
    PUBLIC_SOLANA_RPC,
    rpcUrl && isTritonMainnetRpcUrl(rpcUrl) ? rpcUrl : '',
    rpcUrl &&
    isUsableRpcUrl(rpcUrl) &&
    !isOfficialMainnetBetaRpcUrl(rpcUrl) &&
    rpcUrl !== primaryUrl &&
    rpcUrl !== secondaryUrl
      ? rpcUrl
      : '',
    PUBLIC_SOLANA_RPC_OFFICIAL,
  ].filter((u) => u && isUsableRpcUrl(u));
  for (const u of emergencyPrefs) {
    if (u !== primaryUrl && u !== secondaryUrl) {
      emergencyUrl = u;
      break;
    }
  }
  if (!emergencyUrl) {
    emergencyUrl =
      PUBLIC_SOLANA_RPC !== primaryUrl && PUBLIC_SOLANA_RPC !== secondaryUrl
        ? PUBLIC_SOLANA_RPC
        : PUBLIC_SOLANA_RPC_OFFICIAL !== primaryUrl &&
            PUBLIC_SOLANA_RPC_OFFICIAL !== secondaryUrl
          ? PUBLIC_SOLANA_RPC_OFFICIAL
          : '';
  }

  if (secondaryUrl && secondaryUrl === primaryUrl) {
    console.warn(
      '[rpc] Trading and Data resolve to the same URL — scanners share CU with entries.'
    );
  }

  const candidates: Cand[] = [];
  const seen = new Set<string>();
  const add = (
    url: string,
    label: string,
    role: RpcLaneRole,
    wsUrl?: string
  ) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    candidates.push({ url, label, role, wsUrl });
  };

  const labelFor = (url: string, fallback: string): string => {
    if (url === alchemy) return 'alchemy';
    if (url === alchemyBackup) return 'alchemy-critical';
    if (url === rpcUrl) return 'rpc-url';
    if (url === rpcSecondary) return 'rpc-secondary';
    if (url === PUBLIC_SOLANA_RPC) return 'publicnode';
    if (url === PUBLIC_SOLANA_RPC_OFFICIAL) return 'mainnet-beta';
    if (isTritonMainnetRpcUrl(url)) return 'mainnet-triton';
    return fallback;
  };

  // Sticky Trading + Data, then public emergency as fallback (never utility role).
  add(primaryUrl, labelFor(primaryUrl, 'primary'), 'primary');
  if (secondaryUrl) {
    add(secondaryUrl, labelFor(secondaryUrl, 'secondary'), 'secondary');
  }
  if (emergencyUrl) {
    add(emergencyUrl, labelFor(emergencyUrl, 'publicnode'), 'fallback');
  }

  for (const c of pool) {
    add(c.url, c.label, 'fallback', c.wsUrl);
  }

  const out = normalizeRpcEndpoints(candidates);

  const chain = out.map((e) => e.label).join(' → ');
  console.log(
    `[rpc] Multi-RPC chain: ${chain}` +
      (alchemyCritical ? ' (Alchemy BACKUP sticky Trading)' : '') +
      (alchemy && alchemy !== primaryUrl ? ' (Alchemy sticky Data)' : '') +
      (emergencyUrl === PUBLIC_SOLANA_RPC
        ? ' (publicnode emergency)'
        : emergencyUrl
          ? ` (${labelFor(emergencyUrl, 'public')} emergency)`
          : '') +
      (helius || heliusBackup || alchemyBackup2 || quicknode
        ? ' (Helius/BACKUP2/QN unused)'
        : '')
  );
  if (helius || heliusBackup) {
    console.warn(
      '[rpc_helius_disabled] HELIUS_API_KEY present but unused — 2-lane Trading/Data + public emergency only'
    );
  }
  if (!alchemyCritical && !alchemy) {
    console.warn(
      '[rpc] ALCHEMY_API_KEY_BACKUP / ALCHEMY_API_KEY unset — Trading/Data fall back to RPC_URL / public. Set dual Alchemy keys for sticky lanes.'
    );
  } else if (!alchemyCritical) {
    console.warn(
      '[rpc] ALCHEMY_API_KEY_BACKUP unset — Trading using ' +
        (primaryUrl === alchemy ? 'ALCHEMY_API_KEY' : labelFor(primaryUrl, 'primary')) +
        '. Set BACKUP as dedicated Trading key.'
    );
  } else if (!alchemy) {
    console.warn(
      '[rpc] ALCHEMY_API_KEY unset — Data shares Trading Alchemy until a distinct Data key is set.'
    );
  }

  return out;
}

/** Human-readable lane assignments for Config > RPC UI (Share OFF defaults). */
export const RPC_LANE_SUPPORTS = {
  primary: [
    'Trading: trade entries / turbo / migration sniper / copy buys',
    'Live balance / open marks',
    'Preferred: ALCHEMY_API_KEY_BACKUP sticky; public emergency after hard-fail',
  ],
  secondary: [
    'Data: Market Scanner + AlphaScan + Zion',
    'Favourites soft-watch / activity / wallet import',
    'Preferred: ALCHEMY_API_KEY sticky; never borrows Trading key',
  ],
  utility: [
    '(Legacy) Favourites now ride Data — no separate Utility sticky lane',
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
    'Trading — ALCHEMY_API_KEY_BACKUP sticky: entries, turbo, migration, live balance / marks',
  ],
  scanners: [
    'Data — ALCHEMY_API_KEY sticky: scanners, Zion, Favourites / activity (shed-first under pressure)',
  ],
  utility: [
    'Favourites ride Data (no separate Utility lane)',
  ],
  emergency: [
    'Public (publicnode / RPC_URL) — Trading hard-fail only; Helius unused',
  ],
} as const;

