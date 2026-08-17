/**
 * RPC URL sanitization + free-tier multi-RPC manager.
 *
 * Priority order (failover pool):
 *   1. Helius Free     — HELIUS_API_KEY  → https://mainnet.helius-rpc.com/?api-key=…
 *   2. Alchemy Free    — ALCHEMY_API_KEY → https://solana-mainnet.g.alchemy.com/v2/…
 *   3. QuickNode       — QUICKNODE_RPC_URL (mid-tier paid failover for Critical/Scanners)
 *   4. RPC_URL / RPC_PRIMARY             — Triton api.mainnet.solana.com preferred for Utility
 *   5. Public Solana                     — https://solana-rpc.publicnode.com
 *   6. Official public fallback          — https://api.mainnet-beta.solana.com (last resort)
 *   7. RPC_SECONDARY                     — extra fallback (+ Zion lane when Alchemy unset)
 *   8. remaining RPC_FALLBACKS
 *
 * Triple-lane layout (Share RPC load ON):
 *   Primary (critical) → Helius — entries, migration, wallet buy detection
 *   Secondary (scanners) → Alchemy — Market / Alpha / Zion
 *   Utility → official mainnet-beta (api.mainnet-beta.solana.com), then publicnode / Triton
 * Paid-lane failover: preferred → other paid → QuickNode → public (bypass QuickNode if unset).
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

/** True for Helius hosted Solana HTTP endpoints. */
export function isHeliusRpcUrl(url: string | null | undefined): boolean {
  const u = (url || '').toLowerCase();
  return u.includes('helius-rpc.com') || u.includes('helius.com');
}

/** Build Alchemy Solana mainnet HTTP RPC URL from API key (null if unset/placeholder). */
export function buildAlchemyRpcUrl(apiKey?: string | null): string | null {
  const key = (apiKey ?? process.env.ALCHEMY_API_KEY)?.trim();
  if (!isUsableApiKey(key)) return null;
  return `https://solana-mainnet.g.alchemy.com/v2/${key}`;
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
  /** Idle until preferred Trading/Scanner/Watcher fails -- do not health-probe. */
  emergency?: boolean;
}

/**
 * Build a sanitized endpoint list from env/config candidates.
 * Drops placeholders, dedupes. Public last-resort only when the list is empty.
 */
export function normalizeRpcEndpoints(
  candidates: Array<{
    url: string;
    label?: string;
    wsUrl?: string;
    role?: RpcLaneRole;
    emergency?: boolean;
  }>,
  opts?: { allowPublicLastResort?: boolean }
): NormalizedRpcEndpoint[] {
  const seen = new Set<string>();
  const out: NormalizedRpcEndpoint[] = [];
  let droppedPlaceholder = false;

  const push = (
    url: string,
    label: string,
    role: RpcLaneRole,
    wsUrl?: string,
    emergency?: boolean
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
    out.push({
      url: trimmed,
      label,
      wsUrl,
      role,
      emergency: emergency === true,
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
      c.emergency === true
    );
  }

  if (out.length === 0 || opts?.allowPublicLastResort === true) {
    const hasPublic = out.some((e) => isPublicRpcUrl(e.url));
    if (!hasPublic) {
      push(
        PUBLIC_SOLANA_RPC,
        out.length === 0 ? 'primary' : 'publicnode',
        out.length === 0 ? 'primary' : 'fallback',
        undefined,
        out.length > 0
      );
    }
  }

  if (droppedPlaceholder && out.length > 0) {
    console.warn(
      `[rpc] Using ${out[0].label} -- set ALCHEMY_API_KEY_BACKUP / BACKUP2 / HELIUS_API_KEY`
    );
  }

  return out;
}

function loadModeForRpc(): 'basic' | 'premium' | 'full' {
  try {
    const { parseSystemLoadMode } =
      require('./systemLoadMode') as typeof import('./systemLoadMode');
    const { config } = require('./config') as typeof import('./config');
    return parseSystemLoadMode(
      (config as { systemLoadMode?: unknown }).systemLoadMode
    );
  } catch {
    return 'basic';
  }
}

function envAlchemyKey(name: string): string | null {
  return buildAlchemyRpcUrl(process.env[name]);
}

function envHeliusWatcher(): string | null {
  const fromKey = buildHeliusRpcUrl();
  if (fromKey) return fromKey;
  const raw = (process.env.HELIUS_RPC_URL || '').trim();
  if (raw && isUsableRpcUrl(raw)) return raw;
  return null;
}

/**
 * System Load Mode inventory:
 *   Trading  = ALCHEMY_API_KEY_BACKUP (alias ALCHEMY_API_KEY)
 *   Scanner  = ALCHEMY_API_KEY_BACKUP2
 *   Watcher  = HELIUS_API_KEY / HELIUS_RPC_URL
 *   Emergency = BACKUP3 (+ BACKUP4 Premium, + BACKUP5 Full) -- idle until failover
 */
export function rpcEndpointsFromEnv(
  _primaryEnv?: string | null,
  _fallbacksEnv?: string | null,
  _secondaryEnv?: string | null
): NormalizedRpcEndpoint[] {
  void _primaryEnv;
  void _fallbacksEnv;
  void _secondaryEnv;
  const mode = loadModeForRpc();
  const emergencyN = mode === 'full' ? 3 : mode === 'premium' ? 2 : 1;

  const trading =
    envAlchemyKey('ALCHEMY_API_KEY_BACKUP') || envAlchemyKey('ALCHEMY_API_KEY');
  const scanner = envAlchemyKey('ALCHEMY_API_KEY_BACKUP2');
  const watcher = envHeliusWatcher();
  const emergencyKeys = [
    envAlchemyKey('ALCHEMY_API_KEY_BACKUP3'),
    emergencyN >= 2 ? envAlchemyKey('ALCHEMY_API_KEY_BACKUP4') : null,
    emergencyN >= 3 ? envAlchemyKey('ALCHEMY_API_KEY_BACKUP5') : null,
  ];

  type Cand = {
    url: string;
    label: string;
    role: RpcLaneRole;
    emergency?: boolean;
  };
  const candidates: Cand[] = [];
  const seen = new Set<string>();
  const add = (
    url: string | null,
    label: string,
    role: RpcLaneRole,
    emergency = false
  ) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    candidates.push({ url, label, role, emergency });
  };

  if (trading) add(trading, 'alchemy-backup', 'primary');
  else {
    console.warn(
      '[rpc] Trading slot empty -- set ALCHEMY_API_KEY_BACKUP (or ALCHEMY_API_KEY)'
    );
  }
  if (scanner && scanner !== trading) {
    add(scanner, 'alchemy-backup2', 'secondary');
  } else if (!scanner) {
    console.warn(
      '[rpc] Scanner slot empty -- set ALCHEMY_API_KEY_BACKUP2 (scanner shares Trading until set)'
    );
  }
  if (watcher && watcher !== trading && watcher !== scanner) {
    add(watcher, 'helius', 'utility');
  } else if (!watcher) {
    console.warn(
      '[rpc] Watcher slot empty -- set HELIUS_API_KEY (or HELIUS_RPC_URL)'
    );
  }

  const emergencyLabels = [
    'alchemy-backup3',
    'alchemy-backup4',
    'alchemy-backup5',
  ];
  for (let i = 0; i < emergencyKeys.length; i++) {
    const u = emergencyKeys[i];
    if (!u) continue;
    add(u, emergencyLabels[i] || `emergency-${i + 1}`, 'fallback', true);
  }

  if (candidates.length === 0) {
    console.warn(
      '[rpc] No System Load Mode keys -- last-resort publicnode as Trading'
    );
  }

  const out = normalizeRpcEndpoints(candidates, {
    allowPublicLastResort: candidates.length === 0,
  });

  const chain = out
    .map((e) => `${e.label}[${e.role}${e.emergency ? '/emergency' : ''}]`)
    .join(' -> ');
  console.log(`[rpc] Load-mode ${mode} chain: ${chain || '(empty)'}`);
  return out;
}

/** Human-readable lane assignments for Stats -> RPC. */
export const RPC_LANE_SUPPORTS = {
  primary: [
    'Trading: entries, migration, send/exits',
    'Preferred: ALCHEMY_API_KEY_BACKUP (alias ALCHEMY_API_KEY)',
  ],
  secondary: [
    'Data / Scanner: Market Scanner, Alpha, bonding, anti-rug metrics',
    'Preferred: ALCHEMY_API_KEY_BACKUP2',
  ],
  utility: [
    'Watcher: setup-watch / arm ticks + Favourites signature poll',
    'Preferred: HELIUS_API_KEY (or HELIUS_RPC_URL)',
  ],
  httpOnly: [
    'Email notifications (Resend / SMTP -- no Solana RPC)',
    'Wallet discovery / search (GMGN, Kolscan, etc. -- HTTP APIs)',
    'Open-trade mark prices (DexScreener HTTP)',
  ],
} as const;

/** Copy when System Load Mode inventory is active. */
export const RPC_SHARE_LOAD_SUPPORTS = {
  critical: [
    'Alchemy BACKUP -- trade entries, turbo, migration, send/exits',
  ],
  scanners: [
    'Alchemy BACKUP2 -- Market Scanner, AlphaScan, bonding, metrics',
  ],
  utility: ['Helius -- watch/arm ticks + Favourites wallet poll'],
} as const;
