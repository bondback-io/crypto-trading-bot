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

/** Optional Helius backup URL. Null if HELIUS_API_KEY_BACKUP unset (not an exclusive preferred). */
export function buildHeliusBackupRpcUrl(apiKey?: string | null): string | null {
  const key = (apiKey ?? process.env.HELIUS_API_KEY_BACKUP)?.trim();
  if (!isUsableApiKey(key)) return null;
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

/** Build Alchemy Solana mainnet HTTP RPC URL from API key (null if unset/placeholder). */
export function buildAlchemyRpcUrl(apiKey?: string | null): string | null {
  const key = (apiKey ?? process.env.ALCHEMY_API_KEY)?.trim();
  if (!isUsableApiKey(key)) return null;
  return `https://solana-mainnet.g.alchemy.com/v2/${key}`;
}

/** Exclusive Favourites-lane Alchemy URL. Null if ALCHEMY_API_KEY_BACKUP unset. */
export function buildAlchemyBackupRpcUrl(apiKey?: string | null): string | null {
  return buildAlchemyRpcUrl(apiKey ?? process.env.ALCHEMY_API_KEY_BACKUP);
}

/** Market Scanner exclusive Alchemy URL (BACKUP3). */
export function buildAlchemyBackup3RpcUrl(apiKey?: string | null): string | null {
  return buildAlchemyRpcUrl(apiKey ?? process.env.ALCHEMY_API_KEY_BACKUP3);
}

/** PUBLICNODE_URL env or hardcoded publicnode default. */
export function resolvePublicnodeRpcUrl(): string {
  const fromEnv = String(process.env.PUBLICNODE_URL || '').trim();
  if (fromEnv && isUsableRpcUrl(fromEnv)) return fromEnv;
  return PUBLIC_SOLANA_RPC;
}

export type AlchemyKeyRole = 'scanner' | 'watchers' | 'critical_extra' | 'other';

export type AlchemyEnvKey = {
  env: string;
  key: string;
  label: string;
  role: AlchemyKeyRole;
  url: string;
};

const ALCHEMY_ENV_ROLE: Record<string, AlchemyKeyRole> = {
  ALCHEMY_API_KEY: 'scanner',
  ALCHEMY_API_KEY_BACKUP: 'watchers',
  ALCHEMY_API_KEY_BACKUP2: 'other',
  ALCHEMY_API_KEY_BACKUP3: 'scanner',
  ALCHEMY_API_KEY_BACKUP4: 'other',
  ALCHEMY_API_KEY_BACKUP5: 'other',
  ALCHEMY_API_KEY_BACKUP6: 'other',
  ALCHEMY_API_KEY_BACKUP7: 'other',
};

const ALCHEMY_ENV_LABEL: Record<string, string> = {
  ALCHEMY_API_KEY: 'alchemy',
  ALCHEMY_API_KEY_BACKUP: 'alchemy-backup',
  ALCHEMY_API_KEY_BACKUP2: 'alchemy-backup2',
  ALCHEMY_API_KEY_BACKUP3: 'alchemy-backup3',
  ALCHEMY_API_KEY_BACKUP4: 'alchemy-backup4',
  ALCHEMY_API_KEY_BACKUP5: 'alchemy-backup5',
  ALCHEMY_API_KEY_BACKUP6: 'alchemy-backup6',
  ALCHEMY_API_KEY_BACKUP7: 'alchemy-backup7',
};

/** Discover all usable ALCHEMY_API_KEY* env vars (deduped by key string). */
export function listAlchemyApiKeysFromEnv(): AlchemyEnvKey[] {
  const names = new Set<string>([
    'ALCHEMY_API_KEY',
    'ALCHEMY_API_KEY_BACKUP',
    'ALCHEMY_API_KEY_BACKUP2',
    'ALCHEMY_API_KEY_BACKUP3',
    'ALCHEMY_API_KEY_BACKUP4',
    'ALCHEMY_API_KEY_BACKUP5',
    'ALCHEMY_API_KEY_BACKUP6',
    'ALCHEMY_API_KEY_BACKUP7',
  ]);
  for (const k of Object.keys(process.env)) {
    if (/^ALCHEMY_API_KEY(_|$)/i.test(k)) names.add(k);
  }
  const ordered = [...names].sort((a, b) => {
    const rank = (n: string) => {
      if (n === 'ALCHEMY_API_KEY') return 0;
      const m = /^ALCHEMY_API_KEY_BACKUP(\d*)$/i.exec(n);
      if (m) return 1 + (m[1] ? Number(m[1]) : 0);
      return 20;
    };
    const d = rank(a) - rank(b);
    return d !== 0 ? d : a.localeCompare(b);
  });
  const seenKeys = new Set<string>();
  const out: AlchemyEnvKey[] = [];
  for (const env of ordered) {
    const key = String(process.env[env] || '').trim();
    if (!isUsableApiKey(key) || seenKeys.has(key)) continue;
    seenKeys.add(key);
    const url = buildAlchemyRpcUrl(key);
    if (!url) continue;
    const role = ALCHEMY_ENV_ROLE[env] || 'other';
    const label =
      ALCHEMY_ENV_LABEL[env] ||
      `alchemy-${env.replace(/^ALCHEMY_API_KEY_?/i, '').toLowerCase() || 'extra'}`;
    out.push({ env, key, label, role, url });
  }
  return out;
}

/** Scanner-capacity Alchemy URLs (primary + BACKUP3 + other scanner-role keys). */
export function listAlchemyScannerUrlsFromEnv(): string[] {
  return listAlchemyApiKeysFromEnv()
    .filter((k) => k.role === 'scanner')
    .map((k) => k.url);
}

/** True when label is a paced Alchemy endpoint (per-key CU/s). */
export function isAlchemyScannerCapacityLabel(label: string | null | undefined): boolean {
  const l = String(label || '').toLowerCase();
  return l === 'alchemy' || l.startsWith('alchemy-backup');
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
/**
 * Soft-throttle only true public RPCs (or RPC_SOFT_THROTTLE=1).
 * Exclusive Alchemy/Helius service keys are paid capacity — do not gentle-poll them.
 */
export function isSoftThrottleRpcUrl(url: string | null | undefined): boolean {
  if (process.env.RPC_SOFT_THROTTLE === '1') return true;
  if (process.env.RPC_SOFT_THROTTLE === '0') return false;
  if (isPublicRpcUrl(url)) return true;
  const u = (url || '').toLowerCase();
  if (!u) return true;
  // Helius / Alchemy exclusive keys — full pace.
  if (u.includes('helius-rpc.com') || u.includes('g.alchemy.com')) return false;
  if (isQuicknodeRpcUrl(u)) return false;
  return false;
}

export type RpcLaneRole = 'primary' | 'secondary' | 'utility' | 'watchers' | 'fallback';

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
            : c.label === 'watchers' || c.label === 'alchemy-backup'
              ? 'watchers'
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
              : role === 'watchers'
                ? 'watchers'
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
 * Resolve exclusive service endpoints + emergency fallbacks from env.
 *
 * Preferred: one Alchemy/Helius key per service (see rpcServiceMap).
 * Emergency only: RPC_URL → PUBLICNODE_URL (never preferred for exclusives).
 */
export function rpcEndpointsFromEnv(
  primaryEnv?: string | null,
  fallbacksEnv?: string | null,
  secondaryEnv?: string | null
): NormalizedRpcEndpoint[] {
  const {
    RPC_EXCLUSIVE_SERVICES,
  } = require('./rpcServiceMap') as typeof import('./rpcServiceMap');

  const rpcUrlRaw = (
    primaryEnv ??
    process.env.RPC_PRIMARY ??
    process.env.RPC_URL ??
    ''
  ).trim();
  const rpcUrl = isUsableRpcUrl(rpcUrlRaw) ? rpcUrlRaw : '';
  const publicnode = resolvePublicnodeRpcUrl();

  type Cand = { url: string; label: string; role: RpcLaneRole; wsUrl?: string };
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

  const urlForEnv = (envKey: string): string | null => {
    if (envKey === 'ALCHEMY_API_KEY') return buildAlchemyRpcUrl();
    if (envKey.startsWith('ALCHEMY_API_KEY')) {
      return buildAlchemyRpcUrl(process.env[envKey]);
    }
    if (envKey === 'HELIUS_API_KEY') return buildHeliusRpcUrl();
    if (envKey === 'HELIUS_API_KEY_BACKUP') return buildHeliusBackupRpcUrl();
    if (envKey === 'RPC_URL') return rpcUrl || null;
    if (envKey === 'PUBLICNODE_URL') return publicnode;
    const raw = String(process.env[envKey] || '').trim();
    if (raw && isUsableRpcUrl(raw)) return raw;
    if (raw && isUsableApiKey(raw) && /ALCHEMY/i.test(envKey)) {
      return buildAlchemyRpcUrl(raw);
    }
    if (raw && isUsableApiKey(raw) && /HELIUS/i.test(envKey)) {
      return buildHeliusRpcUrl(raw);
    }
    return null;
  };

  // Exclusive preferred endpoints first (gate role from service map).
  for (const svc of RPC_EXCLUSIVE_SERVICES) {
    const url = urlForEnv(svc.envKey);
    if (!url) continue;
    add(url, svc.label, svc.gateRole);
  }

  // Emergency publics (rpc-url may already be Utility light preferred above).
  if (rpcUrl) add(rpcUrl, 'rpc-url', 'fallback');
  add(publicnode, 'publicnode', 'fallback');

  // Optional QuickNode — emergency mid-tier only (not exclusive preferred).
  const quicknode = buildQuicknodeRpcUrl();
  if (quicknode) {
    const qnWs = process.env.QUICKNODE_WSS_URL?.trim();
    add(
      quicknode,
      'quicknode',
      'fallback',
      qnWs && isUsableRpcUrl(qnWs) ? qnWs : undefined
    );
  }

  // Legacy secondary / fallbacks env — emergency only.
  const fromRpcSecondary = process.env.RPC_SECONDARY?.trim() || '';
  const fromAlias = process.env.SECONDARY_RPC?.trim() || '';
  let rpcSecondary =
    secondaryEnv != null
      ? String(secondaryEnv).trim()
      : fromRpcSecondary || fromAlias;
  if (rpcSecondary && isUsableRpcUrl(rpcSecondary)) {
    add(rpcSecondary, 'rpc-secondary', 'fallback');
  }
  const fallbacks = (fallbacksEnv ?? process.env.RPC_FALLBACKS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((u) => u && isUsableRpcUrl(u));
  for (let i = 0; i < fallbacks.length; i++) {
    add(fallbacks[i], `fallback-${i + 1}`, 'fallback');
  }

  // Absolute last resort if nothing configured.
  if (!candidates.length) {
    add(PUBLIC_SOLANA_RPC_OFFICIAL, 'mainnet-beta', 'primary');
  }

  const out = normalizeRpcEndpoints(candidates);
  const chain = out.map((e) => `${e.label}[${e.role}]`).join(' → ');
  console.log(`[rpc] Exclusive multi-RPC chain: ${chain}`);
  const missing = RPC_EXCLUSIVE_SERVICES.filter(
    (s) => !out.some((e) => e.label === s.label)
  );
  if (missing.length) {
    console.warn(
      `[rpc] Exclusive keys unset (will emergency-failover): ` +
        missing.map((m) => `${m.service}=${m.envKey}`).join(', ')
    );
  }
  if (!rpcUrl) {
    console.log('[rpc] RPC_URL unset — emergency failover uses PUBLICNODE_URL only');
  }

  return out;
}

/** Human-readable lane assignments for Config > RPC UI. */
export const RPC_LANE_SUPPORTS = {
  primary: [
    'Trading Critical + MEV — ALCHEMY_API_KEY (exclusive)',
    'Emergency failover: RPC_URL → PUBLICNODE_URL only',
  ],
  secondary: [
    'Market Scanner — ALCHEMY_API_KEY_BACKUP3',
    'Zion KOL — ALCHEMY_API_KEY_BACKUP4',
    'Migration — ALCHEMY_API_KEY_BACKUP5',
    'AlphaScan — ALCHEMY_API_KEY_BACKUP6',
    'Anti-rug / holders — ALCHEMY_API_KEY_BACKUP7',
    'Each exclusive; emergency: RPC_URL → PUBLICNODE_URL',
  ],
  utility: [
    'Favourites soft-watch — ALCHEMY_API_KEY_BACKUP',
    'Activity refresh — HELIUS_API_KEY',
    'Utility light — RPC_URL (public)',
  ],
  watchers: [
    'Setup watches (Dip/Trend/Scalper/Grad) — ALCHEMY_API_KEY_BACKUP2 (exclusive)',
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
    'ALCHEMY_API_KEY — Trading Critical + MEV (exclusive). Emergency: RPC_URL → PUBLICNODE_URL.',
  ],
  scanners: [
    'BACKUP3 Market Scanner · BACKUP4 Zion · BACKUP5 Migration · BACKUP6 AlphaScan · BACKUP7 anti-rug — each exclusive.',
  ],
  watchers: [
    'ALCHEMY_API_KEY_BACKUP2 — setup watch / arm / trigger (exclusive).',
  ],
  utility: [
    'ALCHEMY_API_KEY_BACKUP Favourites · HELIUS_API_KEY Activity · RPC_URL utility light (public).',
  ],
} as const;
