/**
 * Simple 2+2 RPC pool:
 * Trading = ALCHEMY_API_KEY
 * Data = HELIUS_API_KEY
 * Background = publicnode (or RPC_URL if publicnode unset)
 * Emergency = the other public (whichever Background is not using)
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
  /** @deprecated always null */
  tradingAlchemyFailover: RpcEndpointRef | null;
  /** @deprecated always null */
  tradingFailover: RpcEndpointRef | null;
  data: RpcEndpointRef | null;
  dataFailover: RpcEndpointRef | null;
  background: RpcEndpointRef | null;
  /** @deprecated always null — no paid emergency */
  emergencyPaid: RpcEndpointRef | null;
  /** Public not used by Background. */
  emergencyPublic: RpcEndpointRef | null;
  publics: RpcEndpointRef[];
  heliusCold: RpcEndpointRef[];
  heliusDisabled: false;
};

function resolvePublic(label: string, url: string): RpcEndpointRef {
  return { url: stripTrailingSlash(url), label };
}

/**
 * UI-assigned Main / Emergency per lane (source of truth via rpcInventory).
 * Falls back to env 2+2 defaults when inventory module unavailable.
 */
export function rpcEndpointsSimple(): SimpleRpcEndpoints {
  try {
    const {
      rpcEndpointsFromAssignments,
    } = require('./rpcInventory') as typeof import('./rpcInventory');
    const a = rpcEndpointsFromAssignments();
    const publics: RpcEndpointRef[] = [];
    const seen = new Set<string>();
    for (const e of [
      a.background,
      a.backgroundEmergency,
      a.tradingEmergency,
      a.dataEmergency,
    ]) {
      if (!e?.url) continue;
      const key = e.url.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      publics.push(e);
    }
    return {
      trading: a.trading,
      tradingAlchemyFailover: null,
      tradingFailover: null,
      data: a.data,
      dataFailover: a.dataEmergency,
      background: a.background,
      emergencyPaid: null,
      emergencyPublic: a.tradingEmergency,
      publics,
      heliusCold: [],
      heliusDisabled: false,
    };
  } catch {
    /* fall through */
  }

  const trading = resolveAlchemyEndpoint(
    process.env.ALCHEMY_RPC_URL,
    process.env.ALCHEMY_API_KEY,
    'alchemy'
  );
  const data = resolveHeliusEndpoint(
    process.env.HELIUS_RPC_URL,
    process.env.HELIUS_API_KEY,
    'helius'
  );
  const publicnodeEnv = (
    process.env.PUBLICNODE ||
    process.env.PUBLICNODE_RPC_URL ||
    ''
  ).trim();
  const publicnode = resolvePublic(
    'publicnode',
    publicnodeEnv && looksLikeFullHttpUrl(publicnodeEnv)
      ? publicnodeEnv
      : PUBLICNODE_RPC_URL
  );
  const rpcUrlRaw = (process.env.RPC_URL || '').trim();
  const rpcUrlEp =
    rpcUrlRaw && looksLikeFullHttpUrl(rpcUrlRaw)
      ? resolvePublic('rpc-url', rpcUrlRaw)
      : null;
  const emergencyPublic: RpcEndpointRef | null =
    rpcUrlEp && rpcUrlEp.url.toLowerCase() !== publicnode.url.toLowerCase()
      ? rpcUrlEp
      : null;
  const publics: RpcEndpointRef[] = [];
  const seen = new Set<string>();
  for (const e of [publicnode, emergencyPublic]) {
    if (!e?.url) continue;
    const key = e.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    publics.push(e);
  }
  return {
    trading,
    tradingAlchemyFailover: null,
    tradingFailover: null,
    data,
    dataFailover: null,
    background: publicnode,
    emergencyPaid: null,
    emergencyPublic,
    publics,
    heliusCold: [],
    heliusDisabled: false,
  };
}

/** Hot pool: Trading + Data + Emergency (+ Background when requested). */
export function rpcHotEndpointsFromEnv(
  includeBackground: boolean
): Array<{ url: string; label: string }> {
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
  push(s.data);
  if (includeBackground) push(s.background);
  push(s.emergencyPublic);
  // If only one public exists, keep it available as emergency even when also Background.
  if (!s.emergencyPublic && s.background) push(s.background);
  if (out.length === 0) {
    out.push({ url: PUBLICNODE_RPC_URL, label: 'publicnode' });
  }
  return out;
}

export function rpcEndpointsFromEnv(): Array<{ url: string; label: string }> {
  return rpcHotEndpointsFromEnv(true);
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
  const push = (
    e: RpcEndpointRef | null,
    paid: boolean,
    emergencyOnly: boolean
  ) => {
    if (!e) return;
    out.push({ ...e, paid, emergencyOnly });
  };
  push(s.trading, true, false);
  push(s.data, true, false);
  push(s.background, false, false);
  push(s.emergencyPublic, false, true);
  return out;
}
