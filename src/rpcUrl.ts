/**
 * Slim RPC pool builders.
 * Trading = Alchemy BACKUP, Data = Alchemy, Emergency = public.
 * Background = Alchemy BACKUP2 (or public) only when background workloads are ON.
 * Helius keys stay cold / emergency-only — never hot or probed while idle.
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
  /** Trading primary — Alchemy BACKUP. */
  trading: RpcEndpointRef | null;
  /** @deprecated mid-hop removed; always null. */
  tradingAlchemyFailover: RpcEndpointRef | null;
  /** @deprecated mid-hop removed; always null. */
  tradingFailover: RpcEndpointRef | null;
  data: RpcEndpointRef | null;
  dataFailover: RpcEndpointRef | null;
  background: RpcEndpointRef | null;
  /** Cold Helius paid — never in hot pool / never probed while idle. */
  emergencyPaid: RpcEndpointRef | null;
  /** Single hot emergency public (prefer publicnode). */
  emergencyPublic: RpcEndpointRef | null;
  publics: RpcEndpointRef[];
  /** Cold Helius refs for diagnostics only. */
  heliusCold: RpcEndpointRef[];
  heliusDisabled: true;
};

function resolvePublic(label: string, url: string): RpcEndpointRef {
  return { url: stripTrailingSlash(url), label };
}

/**
 * Trading ← ALCHEMY_API_KEY_BACKUP → Emergency public
 * Data ← ALCHEMY_API_KEY
 * Background ← ALCHEMY_API_KEY_BACKUP2 (or public) when workloads ON
 * Helius ← cold / emergency-only (not hot, not probed idle)
 */
export function rpcEndpointsSimple(): SimpleRpcEndpoints {
  const trading = resolveAlchemyEndpoint(
    process.env.ALCHEMY_RPC_URL_BACKUP,
    process.env.ALCHEMY_API_KEY_BACKUP,
    'alchemy-backup'
  );
  const data = resolveAlchemyEndpoint(
    process.env.ALCHEMY_RPC_URL,
    process.env.ALCHEMY_API_KEY,
    'alchemy'
  );
  const background =
    resolveAlchemyEndpoint(
      process.env.ALCHEMY_RPC_URL_BACKUP2,
      process.env.ALCHEMY_API_KEY_BACKUP2,
      'alchemy-backup2'
    ) || null;

  const heliusCold: RpcEndpointRef[] = [];
  const pushCold = (e: RpcEndpointRef | null) => {
    if (!e?.url) return;
    if (heliusCold.some((x) => x.url.toLowerCase() === e.url.toLowerCase())) return;
    heliusCold.push(e);
  };
  pushCold(
    resolveHeliusEndpoint(
      process.env.HELIUS_RPC_URL,
      process.env.HELIUS_API_KEY,
      'helius'
    )
  );
  pushCold(
    resolveHeliusEndpoint(
      process.env.HELIUS_RPC_URL_BACKUP,
      process.env.HELIUS_API_KEY_BACKUP,
      'helius-backup'
    )
  );
  const emergencyPaid = resolveHeliusEndpoint(
    process.env.HELIUS_RPC_URL_BACKUP2,
    process.env.HELIUS_API_KEY_BACKUP2,
    'helius-backup2'
  );
  pushCold(emergencyPaid);

  const publics: RpcEndpointRef[] = [];
  const seen = new Set<string>();
  const pushPublic = (e: RpcEndpointRef | null) => {
    if (!e?.url) return;
    const key = e.url.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    publics.push(e);
  };

  const publicnodeEnv = (
    process.env.PUBLICNODE ||
    process.env.PUBLICNODE_RPC_URL ||
    ''
  ).trim();
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

  const emergencyPublic = publics[0] || null;

  return {
    trading,
    tradingAlchemyFailover: null,
    tradingFailover: null,
    data,
    dataFailover: null,
    background,
    emergencyPaid,
    emergencyPublic,
    publics,
    heliusCold,
    heliusDisabled: true,
  };
}

/** Hot pool only: Trading + Data + Emergency public (+ Background when requested). */
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
  push(s.emergencyPublic);
  if (includeBackground) {
    push(s.background || s.emergencyPublic);
  }
  if (out.length === 0) {
    out.push({ url: PUBLICNODE_RPC_URL, label: 'publicnode' });
  }
  return out;
}

/** Boot/config listing — same as hot pool with Background included (default workloads ON). */
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
  push(s.background, true, false);
  push(s.emergencyPublic, false, true);
  for (const h of s.heliusCold) {
    out.push({ ...h, paid: true, emergencyOnly: true });
  }
  for (const p of s.publics.slice(1)) {
    out.push({ ...p, paid: false, emergencyOnly: true });
  }
  return out;
}
