/**
 * 6 paid + 3 public Solana RPC builders.
 * Trading=Helius, Data=Alchemy, Background=Alchemy BACKUP2→publics,
 * Emergency=Helius BACKUP2→publics.
 */

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function looksLikeFullHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function urlAlreadyHasKeyPath(url: string): boolean {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    return last.length >= 20 && !/^(v2|solana|mainnet|devnet)$/i.test(last);
  } catch {
    return false;
  }
}

export const PUBLICNODE_RPC_URL = 'https://solana-rpc.publicnode.com';
export const MAINNET_BETA_RPC_URL = 'https://api.mainnet-beta.solana.com';

export function buildAlchemyRpcUrl(apiKeyOrUrl: string): string {
  const raw = apiKeyOrUrl.trim();
  if (!raw) return '';
  if (looksLikeFullHttpUrl(raw)) return stripTrailingSlash(raw);
  return `https://solana-mainnet.g.alchemy.com/v2/${raw}`;
}

export function buildHeliusRpcUrl(apiKeyOrUrl: string): string {
  const raw = apiKeyOrUrl.trim();
  if (!raw) return '';
  if (looksLikeFullHttpUrl(raw)) return stripTrailingSlash(raw);
  return `https://mainnet.helius-rpc.com/?api-key=${raw}`;
}

export function resolveKeyedEndpoint(
  builder: (key: string) => string,
  urlEnv: string | undefined,
  keyEnv: string | undefined,
  label: string
): { url: string; label: string } | null {
  const urlRaw = (urlEnv || '').trim();
  const keyRaw = (keyEnv || '').trim();
  if (urlRaw && looksLikeFullHttpUrl(urlRaw)) {
    if (keyRaw && !urlAlreadyHasKeyPath(urlRaw) && !/[?&]api-key=/i.test(urlRaw)) {
      const sep = urlRaw.includes('?') ? '&' : '?';
      // Helius-style query key append only when URL looks like helius host
      if (/helius/i.test(urlRaw)) {
        return {
          url: stripTrailingSlash(`${urlRaw}${sep}api-key=${keyRaw}`),
          label,
        };
      }
      return {
        url: stripTrailingSlash(`${stripTrailingSlash(urlRaw)}/${keyRaw}`),
        label,
      };
    }
    return { url: stripTrailingSlash(urlRaw), label };
  }
  if (keyRaw) {
    return { url: builder(keyRaw), label };
  }
  return null;
}

export function resolveAlchemyEndpoint(
  urlEnv: string | undefined,
  keyEnv: string | undefined,
  label: string
): { url: string; label: string } | null {
  return resolveKeyedEndpoint(buildAlchemyRpcUrl, urlEnv, keyEnv, label);
}

export function resolveHeliusEndpoint(
  urlEnv: string | undefined,
  keyEnv: string | undefined,
  label: string
): { url: string; label: string } | null {
  return resolveKeyedEndpoint(buildHeliusRpcUrl, urlEnv, keyEnv, label);
}

export function isPublicRpcUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /mainnet-beta\.solana\.com|publicnode\.com|api\.mainnet/i.test(url);
}

export function isSoftThrottleRpcUrl(url: string | null | undefined): boolean {
  return isPublicRpcUrl(url);
}

export type RpcEndpointRef = { url: string; label: string };

export type SimpleRpcEndpoints = {
  trading: RpcEndpointRef | null;
  /** First Trading failover — Alchemy BACKUP (not Helius-only). */
  tradingAlchemyFailover: RpcEndpointRef | null;
  /** Second Trading failover — Helius BACKUP. */
  tradingFailover: RpcEndpointRef | null;
  data: RpcEndpointRef | null;
  dataFailover: RpcEndpointRef | null;
  background: RpcEndpointRef | null;
  emergencyPaid: RpcEndpointRef | null;
  publics: RpcEndpointRef[];
  heliusDisabled: false;
};

function resolvePublic(label: string, url: string): RpcEndpointRef {
  return { url: stripTrailingSlash(url), label };
}

/**
 * Nine-slot pool:
 * Trading ← HELIUS_API_KEY → ALCHEMY_API_KEY_BACKUP → HELIUS_API_KEY_BACKUP → Emergency
 * Data ← ALCHEMY_API_KEY (+ ALCHEMY_API_KEY_BACKUP)
 * Background ← ALCHEMY_API_KEY_BACKUP2 → publics
 * Emergency ← HELIUS_API_KEY_BACKUP2 → publics
 */
export function rpcEndpointsSimple(): SimpleRpcEndpoints {
  const trading = resolveHeliusEndpoint(
    process.env.HELIUS_RPC_URL,
    process.env.HELIUS_API_KEY,
    'helius'
  );
  const tradingAlchemyFailover = resolveAlchemyEndpoint(
    process.env.ALCHEMY_RPC_URL_BACKUP,
    process.env.ALCHEMY_API_KEY_BACKUP,
    'alchemy-backup'
  );
  const tradingFailover = resolveHeliusEndpoint(
    process.env.HELIUS_RPC_URL_BACKUP,
    process.env.HELIUS_API_KEY_BACKUP,
    'helius-backup'
  );
  const data = resolveAlchemyEndpoint(
    process.env.ALCHEMY_RPC_URL,
    process.env.ALCHEMY_API_KEY,
    'alchemy'
  );
  // Data sticky failover prefers a distinct Alchemy key; may share BACKUP with Trading hop.
  const dataFailover =
    resolveAlchemyEndpoint(
      process.env.ALCHEMY_RPC_URL_BACKUP,
      process.env.ALCHEMY_API_KEY_BACKUP,
      'alchemy-backup'
    ) ||
    resolveAlchemyEndpoint(
      process.env.ALCHEMY_RPC_URL_BACKUP2,
      process.env.ALCHEMY_API_KEY_BACKUP2,
      'alchemy-backup2'
    );
  const background = resolveAlchemyEndpoint(
    process.env.ALCHEMY_RPC_URL_BACKUP2,
    process.env.ALCHEMY_API_KEY_BACKUP2,
    'alchemy-backup2'
  );
  const emergencyPaid = resolveHeliusEndpoint(
    process.env.HELIUS_RPC_URL_BACKUP2,
    process.env.HELIUS_API_KEY_BACKUP2,
    'helius-backup2'
  );

  const publics: RpcEndpointRef[] = [];
  const seen = new Set<string>();
  const pushPublic = (e: RpcEndpointRef | null) => {
    if (!e?.url) return;
    const key = e.url.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    publics.push(e);
  };

  const publicnodeEnv = (process.env.PUBLICNODE || process.env.PUBLICNODE_RPC_URL || '').trim();
  if (publicnodeEnv && looksLikeFullHttpUrl(publicnodeEnv)) {
    pushPublic(resolvePublic('publicnode', publicnodeEnv));
  } else {
    pushPublic(resolvePublic('publicnode', PUBLICNODE_RPC_URL));
  }

  const rpcUrl = (process.env.RPC_URL || '').trim();
  if (rpcUrl && looksLikeFullHttpUrl(rpcUrl)) {
    pushPublic(resolvePublic('rpc-url', rpcUrl));
  }

  const beta = (process.env.RPC_BETA_URL || '').trim();
  if (beta && looksLikeFullHttpUrl(beta)) {
    pushPublic(resolvePublic('rpc-beta', beta));
  } else {
    pushPublic(resolvePublic('mainnet-beta', MAINNET_BETA_RPC_URL));
  }

  return {
    trading,
    tradingAlchemyFailover,
    tradingFailover,
    data,
    dataFailover,
    background,
    emergencyPaid,
    publics,
    heliusDisabled: false,
  };
}

export function rpcEndpointsFromEnv(): Array<{ url: string; label: string }> {
  const s = rpcEndpointsSimple();
  const out: Array<{ url: string; label: string }> = [];
  const seen = new Set<string>();
  const push = (e: RpcEndpointRef | null | undefined) => {
    if (!e?.url) return;
    const key = e.url.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };
  push(s.trading);
  push(s.tradingAlchemyFailover);
  push(s.tradingFailover);
  push(s.data);
  push(s.dataFailover);
  push(s.background);
  push(s.emergencyPaid);
  for (const p of s.publics) push(p);
  if (out.length === 0) {
    out.push({ url: PUBLICNODE_RPC_URL, label: 'publicnode' });
  }
  return out;
}

/** @deprecated — kept for import compatibility. */
export function discoverAllRpcEndpoints(): Array<{
  url: string;
  label: string;
  paid: boolean;
  emergencyOnly: boolean;
}> {
  const s = rpcEndpointsSimple();
  const out: Array<{
    url: string;
    label: string;
    paid: boolean;
    emergencyOnly: boolean;
  }> = [];
  const push = (e: RpcEndpointRef | null, paid: boolean, emergencyOnly: boolean) => {
    if (!e) return;
    out.push({ ...e, paid, emergencyOnly });
  };
  push(s.trading, true, false);
  push(s.tradingAlchemyFailover, true, false);
  push(s.tradingFailover, true, false);
  push(s.data, true, false);
  push(s.dataFailover, true, false);
  push(s.background, true, false);
  push(s.emergencyPaid, true, true);
  for (const p of s.publics) {
    out.push({ ...p, paid: false, emergencyOnly: true });
  }
  return out;
}
