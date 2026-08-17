/** Build Helius / Alchemy HTTP URLs from env keys. Missing key → skip slot. */

const ALCHEMY_HTTP = 'https://solana-mainnet.g.alchemy.com/v2/';
const HELIUS_HTTP = 'https://mainnet.helius-rpc.com/?api-key=';
export const PUBLICNODE_HTTP = 'https://solana-rpc.publicnode.com';

export function envTrim(...names: string[]): string {
  for (const name of names) {
    const v = String(process.env[name] || '').trim();
    if (v) return v;
  }
  return '';
}

export function alchemyUrlFromKey(key: string): string | null {
  const k = key.trim();
  if (!k) return null;
  if (/^https?:\/\//i.test(k)) return k;
  return `${ALCHEMY_HTTP}${k}`;
}

export function heliusUrlFromKey(key: string): string | null {
  const k = key.trim();
  if (!k) return null;
  if (/^https?:\/\//i.test(k)) return k;
  return `${HELIUS_HTTP}${k}`;
}

export function envAlchemyUrl(...keyNames: string[]): string | null {
  return alchemyUrlFromKey(envTrim(...keyNames));
}

export function envHeliusUrl(...keyNames: string[]): string | null {
  return heliusUrlFromKey(envTrim(...keyNames));
}

let missingLogged = new Set<string>();

export function logMissingRpcSlot(slot: string, envNames: string[]): void {
  const key = `${slot}:${envNames.join('|')}`;
  if (missingLogged.has(key)) return;
  missingLogged.add(key);
  console.warn(
    `[rpc-upgrade] ${slot} empty — set ${envNames.join(' or ')} (slot skipped, no key steal)`
  );
}
