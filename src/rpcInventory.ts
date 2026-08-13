/**
 * RPC inventory discovery + exclusive lane Main/Emergency assignments.
 * Assignments are the routing source of truth when set.
 */

import {
  resolveAlchemyEndpoint,
  resolveHeliusEndpoint,
  PUBLICNODE_RPC_URL,
  type RpcEndpointRef,
} from './rpcUrl';

export type RpcInventoryProvider = 'alchemy' | 'helius' | 'public';

export type RpcInventoryItem = {
  id: string;
  label: string;
  provider: RpcInventoryProvider;
  host: string;
  /** Full URL — server only; never send raw keys to UI. */
  url: string;
};

export type RpcLaneId = 'trading' | 'data' | 'background';

export type RpcLaneSlot = {
  main: string | null;
  emergency: string | null;
};

export type RpcLaneAssignments = {
  trading: RpcLaneSlot;
  data: RpcLaneSlot;
  background: RpcLaneSlot;
};

export type RpcLaneAssignmentsPublic = RpcLaneAssignments;

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function looksLikeFullHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function resolvePublic(label: string, url: string): RpcEndpointRef {
  return { url: stripTrailingSlash(url), label };
}

/** Discover configured env slots (deduped by URL). */
export function discoverRpcInventory(): RpcInventoryItem[] {
  const raw: RpcInventoryItem[] = [];

  const pushKeyed = (
    id: string,
    label: string,
    provider: RpcInventoryProvider,
    ep: RpcEndpointRef | null
  ) => {
    if (!ep?.url) return;
    raw.push({
      id,
      label,
      provider,
      host: hostOf(ep.url),
      url: ep.url,
    });
  };

  pushKeyed(
    'alchemy',
    'Alchemy (ALCHEMY_API_KEY)',
    'alchemy',
    resolveAlchemyEndpoint(
      process.env.ALCHEMY_RPC_URL,
      process.env.ALCHEMY_API_KEY,
      'alchemy'
    )
  );
  pushKeyed(
    'alchemy-backup',
    'Alchemy BACKUP',
    'alchemy',
    resolveAlchemyEndpoint(
      process.env.ALCHEMY_RPC_URL_BACKUP,
      process.env.ALCHEMY_API_KEY_BACKUP,
      'alchemy-backup'
    )
  );
  pushKeyed(
    'alchemy-backup2',
    'Alchemy BACKUP2',
    'alchemy',
    resolveAlchemyEndpoint(
      process.env.ALCHEMY_RPC_URL_BACKUP2,
      process.env.ALCHEMY_API_KEY_BACKUP2,
      'alchemy-backup2'
    )
  );
  pushKeyed(
    'helius',
    'Helius (HELIUS_API_KEY)',
    'helius',
    resolveHeliusEndpoint(
      process.env.HELIUS_RPC_URL,
      process.env.HELIUS_API_KEY,
      'helius'
    )
  );
  pushKeyed(
    'helius-backup',
    'Helius BACKUP',
    'helius',
    resolveHeliusEndpoint(
      process.env.HELIUS_RPC_URL_BACKUP,
      process.env.HELIUS_API_KEY_BACKUP,
      'helius-backup'
    )
  );
  pushKeyed(
    'helius-backup2',
    'Helius BACKUP2',
    'helius',
    resolveHeliusEndpoint(
      process.env.HELIUS_RPC_URL_BACKUP2,
      process.env.HELIUS_API_KEY_BACKUP2,
      'helius-backup2'
    )
  );

  const publicnodeEnv = (
    process.env.PUBLICNODE ||
    process.env.PUBLICNODE_RPC_URL ||
    ''
  ).trim();
  // Always offer publicnode (default URL if env unset) so Background has a pick.
  pushKeyed(
    'publicnode',
    'PublicNode',
    'public',
    resolvePublic(
      'publicnode',
      publicnodeEnv && looksLikeFullHttpUrl(publicnodeEnv)
        ? publicnodeEnv
        : PUBLICNODE_RPC_URL
    )
  );

  const rpcUrl = (process.env.RPC_URL || '').trim();
  if (rpcUrl && looksLikeFullHttpUrl(rpcUrl)) {
    pushKeyed('rpc-url', 'RPC_URL', 'public', resolvePublic('rpc-url', rpcUrl));
  }

  const beta = (process.env.RPC_BETA_URL || '').trim();
  if (beta && looksLikeFullHttpUrl(beta)) {
    pushKeyed(
      'rpc-beta',
      'RPC_BETA_URL',
      'public',
      resolvePublic('rpc-beta', beta)
    );
  }

  // Deduplicate by URL — keep first id (preferred slot names first).
  const seen = new Set<string>();
  const out: RpcInventoryItem[] = [];
  for (const item of raw) {
    const key = item.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function getInventoryById(id: string | null | undefined): RpcInventoryItem | null {
  if (!id) return null;
  return discoverRpcInventory().find((i) => i.id === id) || null;
}

export function emptyLaneAssignments(): RpcLaneAssignments {
  return {
    trading: { main: null, emergency: null },
    data: { main: null, emergency: null },
    background: { main: null, emergency: null },
  };
}

/** Boot defaults matching prior 2+2 behaviour when inventory allows. */
export function defaultLaneAssignments(): RpcLaneAssignments {
  const inv = discoverRpcInventory();
  const has = (id: string) => inv.some((i) => i.id === id);
  const tradingMain = has('alchemy')
    ? 'alchemy'
    : has('alchemy-backup')
      ? 'alchemy-backup'
      : has('helius')
        ? 'helius'
        : inv[0]?.id || null;
  const dataMain = has('helius')
    ? 'helius'
    : has('alchemy') && tradingMain !== 'alchemy'
      ? 'alchemy'
      : inv.find((i) => i.id !== tradingMain)?.id || null;
  const backgroundMain = has('publicnode')
    ? 'publicnode'
    : has('rpc-url')
      ? 'rpc-url'
      : inv.find((i) => i.id !== tradingMain && i.id !== dataMain)?.id || null;
  let tradingEmergency: string | null = null;
  if (
    has('rpc-url') &&
    'rpc-url' !== tradingMain &&
    'rpc-url' !== dataMain &&
    'rpc-url' !== backgroundMain
  ) {
    tradingEmergency = 'rpc-url';
  } else if (
    has('rpc-beta') &&
    'rpc-beta' !== tradingMain &&
    'rpc-beta' !== dataMain &&
    'rpc-beta' !== backgroundMain
  ) {
    tradingEmergency = 'rpc-beta';
  }
  return {
    trading: { main: tradingMain, emergency: tradingEmergency },
    data: { main: dataMain, emergency: null },
    background: { main: backgroundMain, emergency: null },
  };
}

let currentAssignments: RpcLaneAssignments | null = null;

export function getRpcLaneAssignments(): RpcLaneAssignments {
  if (!currentAssignments) {
    currentAssignments = defaultLaneAssignments();
  }
  return cloneAssignments(currentAssignments);
}

function cloneAssignments(a: RpcLaneAssignments): RpcLaneAssignments {
  return {
    trading: { ...a.trading },
    data: { ...a.data },
    background: { ...a.background },
  };
}

export function applyRpcLaneAssignmentsSaved(
  saved: Partial<RpcLaneAssignments> | null | undefined
): void {
  if (!saved || typeof saved !== 'object') return;
  const base = defaultLaneAssignments();
  const next = cloneAssignments(base);
  for (const lane of ['trading', 'data', 'background'] as RpcLaneId[]) {
    const s = saved[lane];
    if (!s || typeof s !== 'object') continue;
    if (s.main === null || typeof s.main === 'string') next[lane].main = s.main;
    if (s.emergency === null || typeof s.emergency === 'string') {
      next[lane].emergency = s.emergency;
    }
  }
  const v = validateLaneAssignments(next);
  if (v.ok) {
    currentAssignments = cloneAssignments(next);
  } else {
    // Keep valid subset: drop unknown / duplicate ids
    currentAssignments = sanitizeAssignments(next);
  }
}

function sanitizeAssignments(a: RpcLaneAssignments): RpcLaneAssignments {
  const inv = new Set(discoverRpcInventory().map((i) => i.id));
  const used = new Set<string>();
  const out = emptyLaneAssignments();
  for (const lane of ['trading', 'data', 'background'] as RpcLaneId[]) {
    const main = a[lane].main;
    if (main && inv.has(main) && !used.has(main)) {
      out[lane].main = main;
      used.add(main);
    }
    const em = a[lane].emergency;
    if (em && inv.has(em) && !used.has(em)) {
      out[lane].emergency = em;
      used.add(em);
    }
  }
  // Fill missing mains from defaults if still free
  const def = defaultLaneAssignments();
  for (const lane of ['trading', 'data', 'background'] as RpcLaneId[]) {
    if (!out[lane].main && def[lane].main && !used.has(def[lane].main!)) {
      out[lane].main = def[lane].main;
      used.add(def[lane].main!);
    }
  }
  return out;
}

export function validateLaneAssignments(
  a: RpcLaneAssignments
): { ok: true } | { ok: false; error: string } {
  const inv = discoverRpcInventory();
  const known = new Set(inv.map((i) => i.id));
  const used = new Map<string, string>();
  for (const lane of ['trading', 'data', 'background'] as RpcLaneId[]) {
    for (const slot of ['main', 'emergency'] as const) {
      const id = a[lane][slot];
      if (id == null || id === '') continue;
      if (!known.has(id)) {
        return { ok: false, error: `Unknown RPC inventory id: ${id}` };
      }
      if (used.has(id)) {
        return {
          ok: false,
          error: `${id} already assigned to ${used.get(id)} — exclusive ownership`,
        };
      }
      used.set(id, `${lane}.${slot}`);
    }
  }
  return { ok: true };
}

/** Set assignments in memory (caller persists + rebuilds pool). */
export function setRpcLaneAssignmentsInMemory(
  next: RpcLaneAssignments
): { ok: true; assignments: RpcLaneAssignments } | { ok: false; error: string } {
  const v = validateLaneAssignments(next);
  if (!v.ok) return v;
  currentAssignments = cloneAssignments(next);
  return { ok: true, assignments: getRpcLaneAssignments() };
}

export function inventoryPublicView(): Array<{
  id: string;
  label: string;
  provider: RpcInventoryProvider;
  host: string;
}> {
  return discoverRpcInventory().map(({ id, label, provider, host }) => ({
    id,
    label,
    provider,
    host,
  }));
}

export function assignedInventoryIds(a?: RpcLaneAssignments): Set<string> {
  const asg = a || getRpcLaneAssignments();
  const s = new Set<string>();
  for (const lane of ['trading', 'data', 'background'] as RpcLaneId[]) {
    if (asg[lane].main) s.add(asg[lane].main!);
    if (asg[lane].emergency) s.add(asg[lane].emergency!);
  }
  return s;
}

export function resolveAssignedEndpoint(
  inventoryId: string | null
): RpcEndpointRef | null {
  const item = getInventoryById(inventoryId);
  if (!item) return null;
  return { url: item.url, label: item.id };
}

/** Materialize lane Main/Emergency refs from current assignments (no auto-share). */
export function rpcEndpointsFromAssignments(): {
  trading: RpcEndpointRef | null;
  tradingEmergency: RpcEndpointRef | null;
  data: RpcEndpointRef | null;
  dataEmergency: RpcEndpointRef | null;
  background: RpcEndpointRef | null;
  backgroundEmergency: RpcEndpointRef | null;
} {
  const a = getRpcLaneAssignments();
  return {
    trading: resolveAssignedEndpoint(a.trading.main),
    tradingEmergency: resolveAssignedEndpoint(a.trading.emergency),
    data: resolveAssignedEndpoint(a.data.main),
    dataEmergency: resolveAssignedEndpoint(a.data.emergency),
    background: resolveAssignedEndpoint(a.background.main),
    backgroundEmergency: resolveAssignedEndpoint(a.background.emergency),
  };
}

export function exclusivityMap(
  a?: RpcLaneAssignments
): Record<string, string> {
  const asg = a || getRpcLaneAssignments();
  const map: Record<string, string> = {};
  for (const lane of ['trading', 'data', 'background'] as RpcLaneId[]) {
    if (asg[lane].main) map[asg[lane].main!] = `${lane}.main`;
    if (asg[lane].emergency) map[asg[lane].emergency!] = `${lane}.emergency`;
  }
  return map;
}
