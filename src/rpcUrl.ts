/**
 * Simple Alchemy Trading / Data / Emergency URL builders.
 * Helius is never registered for routing (env may still exist unused).
 */

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function looksLikeFullHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/** True if URL already ends with a path segment that looks like an API key. */
function urlAlreadyHasKeyPath(url: string): boolean {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    return last.length >= 20 && !/^(v2|solana|mainnet|devnet)$/i.test(last);
  } catch {
    return false;
  }
}

/**
 * Build a complete Alchemy Solana mainnet RPC URL from a bare API key,
 * or return a full URL unchanged (without double-appending the key).
 */
export function buildAlchemyRpcUrl(apiKeyOrUrl: string): string {
  const raw = apiKeyOrUrl.trim();
  if (!raw) return '';
  if (looksLikeFullHttpUrl(raw)) {
    return stripTrailingSlash(raw);
  }
  return `https://solana-mainnet.g.alchemy.com/v2/${raw}`;
}

/** Resolve Alchemy URL from optional full URL env or API key env. */
export function resolveAlchemyEndpoint(
  urlEnv: string | undefined,
  keyEnv: string | undefined,
  label: string
): { url: string; label: string } | null {
  const urlRaw = (urlEnv || '').trim();
  const keyRaw = (keyEnv || '').trim();
  if (urlRaw && looksLikeFullHttpUrl(urlRaw)) {
    if (keyRaw && !urlAlreadyHasKeyPath(urlRaw)) {
      return {
        url: stripTrailingSlash(`${stripTrailingSlash(urlRaw)}/${keyRaw}`),
        label,
      };
    }
    return { url: stripTrailingSlash(urlRaw), label };
  }
  if (keyRaw) {
    return { url: buildAlchemyRpcUrl(keyRaw), label };
  }
  return null;
}

export function isPublicRpcUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /mainnet-beta\.solana\.com|publicnode\.com|api\.mainnet/i.test(url);
}

/** Soft-throttle host check (Favourites / activity volume). */
export function isSoftThrottleRpcUrl(url: string | null | undefined): boolean {
  return isPublicRpcUrl(url);
}

export type SimpleRpcEndpoints = {
  trading: { url: string; label: string } | null;
  data: { url: string; label: string } | null;
  emergency: { url: string; label: string };
  heliusDisabled: true;
};

/**
 * Exactly three lanes for the simple router:
 * - Trading ← ALCHEMY_API_KEY_BACKUP (or ALCHEMY_RPC_URL_BACKUP)
 * - Data ← ALCHEMY_API_KEY (or ALCHEMY_RPC_URL)
 * - Emergency ← RPC_URL or publicnode
 * Helius is never included.
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

  const emergencyRaw = (process.env.RPC_URL || '').trim();
  let emergency: { url: string; label: string };
  if (
    emergencyRaw &&
    looksLikeFullHttpUrl(emergencyRaw) &&
    isPublicRpcUrl(emergencyRaw)
  ) {
    emergency = { url: stripTrailingSlash(emergencyRaw), label: 'public' };
  } else if (emergencyRaw && looksLikeFullHttpUrl(emergencyRaw) && !trading) {
    // Non-public RPC_URL used only as last-resort emergency if no Alchemy backup.
    emergency = { url: stripTrailingSlash(emergencyRaw), label: 'rpc-url' };
  } else {
    emergency = {
      url: 'https://solana-rpc.publicnode.com',
      label: 'publicnode',
    };
  }

  return {
    trading,
    data,
    emergency,
    heliusDisabled: true,
  };
}

/**
 * Flat list for config.rpc.endpoints boot wiring:
 * [0] Trading (or Data if Trading missing, or Emergency)
 * [1] Data (distinct from Trading when possible)
 * [2+] Emergency
 */
export function rpcEndpointsFromEnv(): Array<{ url: string; label: string }> {
  const s = rpcEndpointsSimple();
  const out: Array<{ url: string; label: string }> = [];
  const seen = new Set<string>();
  const push = (e: { url: string; label: string } | null) => {
    if (!e?.url) return;
    const key = e.url.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };
  push(s.trading);
  push(s.data);
  push(s.emergency);
  if (out.length === 0) {
    out.push({
      url: 'https://solana-rpc.publicnode.com',
      label: 'publicnode',
    });
  }
  return out;
}

/** @deprecated — classic/multiLane discovery unused; kept for import compatibility. */
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
  if (s.trading) {
    out.push({ ...s.trading, paid: true, emergencyOnly: false });
  }
  if (s.data) {
    out.push({ ...s.data, paid: true, emergencyOnly: false });
  }
  out.push({ ...s.emergency, paid: false, emergencyOnly: true });
  return out;
}
