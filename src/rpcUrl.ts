/**
 * RPC URL sanitization + spillover-first 3-lane manager.
 *
 * Day-to-day (keyed pools, target 20–40ms):
 *   Critical  → HELIUS_API_KEY + HELIUS_API_KEY_BACKUP + HELIUS_API_KEY_BACKUP2
 *   Scanners  → ALCHEMY_API_KEY + ALCHEMY_API_KEY_BACKUP2 (+ BACKUP3/4 if set)
 *   Utility   → ALCHEMY_API_KEY_BACKUP (never Helius; never public while BACKUP is up)
 *
 * Emergency only (never preferred when a keyed pool member is healthy):
 *   RPC_URL (Triton) → PUBLICNODE_URL → RPC_URL_BETA / mainnet-beta → QuickNode
 *
 * Spillover stays inside the lane pool (least-conn). Cross-lane failover and
 * public emergency are last resort. Dual-dispatch piggyback is not used for load.
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

/** True for Helius hosted Solana HTTP endpoints. */
export function isHeliusRpcUrl(url: string | null | undefined): boolean {
  return (url || '').toLowerCase().includes('helius-rpc.com');
}

/** PUBLICNODE_URL if set, else the hardcoded publicnode host. */
export function resolvePublicnodeUrl(): string {
  const raw = (process.env.PUBLICNODE_URL || '').trim();
  return isUsableRpcUrl(raw) ? raw : PUBLIC_SOLANA_RPC;
}

/** RPC_URL_BETA if set, else official mainnet-beta. */
export function resolveOfficialBetaUrl(): string {
  const raw = (process.env.RPC_URL_BETA || '').trim();
  return isUsableRpcUrl(raw) ? raw : PUBLIC_SOLANA_RPC_OFFICIAL;
}

export function isAlchemyScannerCapacityLabel(label: string): boolean {
  const l = String(label || '').toLowerCase();
  return l === 'alchemy' || /^alchemy-backup\d*$/.test(l);
}

export function buildAlchemyBackup3RpcUrl(): string | null {
  return buildAlchemyRpcUrl(process.env.ALCHEMY_API_KEY_BACKUP3);
}

export function listAlchemyApiKeysFromEnv(): string[] {
  return [
    process.env.ALCHEMY_API_KEY,
    process.env.ALCHEMY_API_KEY_BACKUP,
    process.env.ALCHEMY_API_KEY_BACKUP2,
    process.env.ALCHEMY_API_KEY_BACKUP3,
    process.env.ALCHEMY_API_KEY_BACKUP4,
  ]
    .map((k) => (k || '').trim())
    .filter((k) => isUsableApiKey(k));
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

/** Workload lane a keyed endpoint belongs to for in-lane spillover. */
export type RpcPoolLane = 'primary' | 'secondary' | 'utility';

export interface NormalizedRpcEndpoint {
  url: string;
  label: string;
  wsUrl?: string;
  role?: RpcLaneRole;
  /** Lane pool membership (preferred + spillover siblings). */
  pool?: RpcPoolLane;
  /** Public / Triton / QuickNode — last-resort only. */
  emergency?: boolean;
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
    pool?: RpcPoolLane;
    emergency?: boolean;
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
    pool?: RpcPoolLane,
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
    out.push({ url: trimmed, label, wsUrl, role, pool, emergency });
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
      c.pool,
      c.emergency
    );
  }

  // Always keep a public endpoint as last resort if missing
  const hasPublic = out.some((e) => isPublicRpcUrl(e.url));
  if (!hasPublic) {
    const asPrimary = out.length === 0;
    push(
      PUBLIC_SOLANA_RPC,
      asPrimary ? 'primary' : 'publicnode',
      asPrimary ? 'primary' : 'fallback',
      undefined,
      asPrimary ? 'primary' : undefined,
      !asPrimary
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
 * Resolve 3-lane keyed pools + emergency publics from env.
 *
 * Preferred: Helius (Critical) / Alchemy (Scanners) / Alchemy BACKUP (Utility).
 * Spillover siblings stay in-pool. Publics and QuickNode are emergency-only.
 */
export function rpcEndpointsFromEnv(
  primaryEnv?: string | null,
  fallbacksEnv?: string | null,
  secondaryEnv?: string | null
): NormalizedRpcEndpoint[] {
  const helius = buildHeliusRpcUrl();
  const heliusBackup = buildHeliusRpcUrl(process.env.HELIUS_API_KEY_BACKUP);
  const heliusBackup2 = buildHeliusRpcUrl(process.env.HELIUS_API_KEY_BACKUP2);
  const alchemy = buildAlchemyRpcUrl();
  const alchemyBackup = buildAlchemyRpcUrl(process.env.ALCHEMY_API_KEY_BACKUP);
  const alchemyBackup2 = buildAlchemyRpcUrl(process.env.ALCHEMY_API_KEY_BACKUP2);
  const alchemyBackup3 = buildAlchemyRpcUrl(process.env.ALCHEMY_API_KEY_BACKUP3);
  const alchemyBackup4 = buildAlchemyRpcUrl(process.env.ALCHEMY_API_KEY_BACKUP4);
  const quicknode = buildQuicknodeRpcUrl();
  const publicnode = resolvePublicnodeUrl();
  const officialBeta = resolveOfficialBetaUrl();

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

  const extraFallbacks = (fallbacksEnv ?? process.env.RPC_FALLBACKS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((u) => u && isUsableRpcUrl(u));

  type Cand = {
    url: string;
    label: string;
    role: RpcLaneRole;
    wsUrl?: string;
    pool?: RpcPoolLane;
    emergency?: boolean;
  };

  const primaryUrl = helius || rpcUrl || alchemy || publicnode;
  let secondaryUrl = '';
  if (alchemy && alchemy !== primaryUrl) {
    secondaryUrl = alchemy;
  } else if (rpcSecondary && rpcSecondary !== primaryUrl) {
    secondaryUrl = rpcSecondary;
  } else if (alchemyBackup2 && alchemyBackup2 !== primaryUrl) {
    secondaryUrl = alchemyBackup2;
  }

  let utilityUrl = '';
  const utilityPrefs = [
    alchemyBackup,
    alchemyBackup2 && alchemyBackup2 !== secondaryUrl ? alchemyBackup2 : '',
  ].filter((u): u is string => Boolean(u) && isUsableRpcUrl(u));
  for (const u of utilityPrefs) {
    if (u !== primaryUrl && u !== secondaryUrl) {
      utilityUrl = u;
      break;
    }
  }
  if (!utilityUrl) {
    // Last resort: emergency public — never steal Helius Critical keys.
    if (publicnode !== primaryUrl && publicnode !== secondaryUrl) {
      utilityUrl = publicnode;
    } else if (officialBeta !== primaryUrl && officialBeta !== secondaryUrl) {
      utilityUrl = officialBeta;
    } else {
      utilityUrl = secondaryUrl || primaryUrl;
    }
  }

  if (secondaryUrl && secondaryUrl === primaryUrl) {
    console.warn(
      '[rpc] Primary and secondary resolve to the same URL — Zion shares CU with copy/signals.'
    );
  }
  if (utilityUrl && isPublicRpcUrl(utilityUrl) && alchemyBackup) {
    console.warn(
      '[rpc] Utility fell through to public despite ALCHEMY_API_KEY_BACKUP — check key collision.'
    );
  }

  const candidates: Cand[] = [];
  const seen = new Set<string>();
  const add = (
    url: string,
    label: string,
    role: RpcLaneRole,
    opts?: { wsUrl?: string; pool?: RpcPoolLane; emergency?: boolean }
  ) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    candidates.push({
      url,
      label,
      role,
      wsUrl: opts?.wsUrl,
      pool: opts?.pool,
      emergency: opts?.emergency,
    });
  };

  const labelFor = (url: string, fallback: string): string => {
    if (url === helius) return 'helius';
    if (url === heliusBackup) return 'helius-backup';
    if (url === heliusBackup2) return 'helius-backup2';
    if (url === alchemy) return 'alchemy';
    if (url === alchemyBackup) return 'alchemy-backup';
    if (url === alchemyBackup2) return 'alchemy-backup2';
    if (url === alchemyBackup3) return 'alchemy-backup3';
    if (url === alchemyBackup4) return 'alchemy-backup4';
    if (url === quicknode) return 'quicknode';
    if (url === rpcUrl) return 'rpc-url';
    if (url === rpcSecondary) return 'rpc-secondary';
    if (url === publicnode || url === PUBLIC_SOLANA_RPC) return 'publicnode';
    if (url === officialBeta || url === PUBLIC_SOLANA_RPC_OFFICIAL) {
      return 'mainnet-beta';
    }
    if (isTritonMainnetRpcUrl(url)) return 'mainnet-triton';
    return fallback;
  };

  add(primaryUrl, labelFor(primaryUrl, 'primary'), 'primary', {
    pool: 'primary',
  });
  if (heliusBackup && heliusBackup !== primaryUrl) {
    add(heliusBackup, 'helius-backup', 'fallback', { pool: 'primary' });
  }
  if (heliusBackup2 && heliusBackup2 !== primaryUrl) {
    add(heliusBackup2, 'helius-backup2', 'fallback', { pool: 'primary' });
  }

  if (secondaryUrl) {
    add(secondaryUrl, labelFor(secondaryUrl, 'secondary'), 'secondary', {
      pool: 'secondary',
    });
  }
  for (const [url, label] of [
    [alchemyBackup2, 'alchemy-backup2'],
    [alchemyBackup3, 'alchemy-backup3'],
    [alchemyBackup4, 'alchemy-backup4'],
  ] as const) {
    if (!url || url === primaryUrl || url === secondaryUrl || url === utilityUrl) {
      continue;
    }
    add(url, label, 'fallback', { pool: 'secondary' });
  }

  if (utilityUrl) {
    add(utilityUrl, labelFor(utilityUrl, 'utility'), 'utility', {
      pool: isPublicRpcUrl(utilityUrl) ? undefined : 'utility',
      emergency: isPublicRpcUrl(utilityUrl) || undefined,
    });
  }

  const qnWs = process.env.QUICKNODE_WSS_URL?.trim();
  if (quicknode) {
    add(quicknode, 'quicknode', 'fallback', {
      emergency: true,
      wsUrl: qnWs && isUsableRpcUrl(qnWs) ? qnWs : undefined,
    });
  }
  if (rpcUrl) {
    add(rpcUrl, labelFor(rpcUrl, 'rpc-url'), 'fallback', {
      emergency: true,
    });
  }
  add(publicnode, 'publicnode', 'fallback', { emergency: true });
  add(officialBeta, 'mainnet-beta', 'fallback', { emergency: true });
  if (rpcSecondary) {
    add(rpcSecondary, 'rpc-secondary', 'fallback', { emergency: true });
  }
  for (let i = 0; i < extraFallbacks.length; i++) {
    add(extraFallbacks[i], `fallback-${i + 1}`, 'fallback', { emergency: true });
  }

  const out = normalizeRpcEndpoints(candidates);

  const poolSummary = (lane: RpcPoolLane) =>
    out
      .filter((e) => e.pool === lane)
      .map((e) => e.label)
      .join('+') || '—';
  const emerg = out
    .filter((e) => e.emergency)
    .map((e) => e.label)
    .join(' → ');
  console.log(
    `[rpc] Pools — Critical:${poolSummary('primary')} · Scanners:${poolSummary('secondary')} · Utility:${poolSummary('utility')}` +
      (emerg ? ` · emergency ${emerg}` : '') +
      (heliusBackup || heliusBackup2 ? ' (Helius spillover ON)' : '') +
      (alchemyBackup2 || alchemyBackup3 || alchemyBackup4
        ? ' (Alchemy scanner spillover ON)'
        : '')
  );
  if (!helius && !alchemy) {
    console.warn(
      '[rpc] HELIUS_API_KEY / ALCHEMY_API_KEY unset — using RPC_URL / public. ' +
        'Set free Helius + Alchemy keys for 20–40ms lanes and spillover.'
    );
  }
  if (utilityUrl && isPublicRpcUrl(utilityUrl)) {
    console.warn(
      '[rpc] Utility is on a public RPC — set ALCHEMY_API_KEY_BACKUP to keep Favourites at keyed latency.'
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
    'Pool: HELIUS_API_KEY + HELIUS_API_KEY_BACKUP + HELIUS_API_KEY_BACKUP2 (spillover). Emergency: Triton → publicnode',
  ],
  secondary: [
    'Market Scanner + AlphaScan (Share ON)',
    'Zion micro-bot + KOL Token Scanner',
    'Zion Place Trade on-chain bits',
    'Pool: ALCHEMY_API_KEY + ALCHEMY_API_KEY_BACKUP2 (spillover). Emergency last.',
  ],
  utility: [
    'Wallet favourites / import on-chain checks (Share ON)',
    'Wallet activity refresh / last-trade polls (Share ON)',
    'Other light non-entry polls',
    'Preferred: ALCHEMY_API_KEY_BACKUP. Spillover to BACKUP2 only when Scanners are idle. Public is emergency-only.',
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
    'Helius pool — trade entries, turbo, migration sniper/parses; BACKUP/BACKUP2 spillover; 40ms hedge on send',
  ],
  scanners: [
    'Alchemy pool — Market Scanner, AlphaScan, Zion KOL + Place Trade; BACKUP2 spillover',
  ],
  utility: [
    'ALCHEMY_API_KEY_BACKUP — Favourites / import / activity. Never public while BACKUP is healthy.',
  ],
} as const;
