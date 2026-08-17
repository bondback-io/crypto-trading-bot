/**
 * Endpoint inventories for RPC upgrade packs.
 * When no lane map is on, returns null so 1.2.21 dual-lane env parsing stays in charge.
 */

import type { NormalizedRpcEndpoint, RpcLaneRole } from '../../rpcUrl';
import { getActiveRpcLaneMap } from '../registry';
import {
  PUBLICNODE_HTTP,
  envAlchemyUrl,
  envHeliusUrl,
  envTrim,
  logMissingRpcSlot,
} from './keys';

export interface UpgradeRpcEndpoint {
  url: string;
  label: string;
  role: RpcLaneRole;
  emergency?: boolean;
}

function push(
  out: UpgradeRpcEndpoint[],
  url: string | null,
  label: string,
  role: RpcLaneRole,
  slot: string,
  envNames: string[],
  emergency = false
): void {
  if (!url) {
    logMissingRpcSlot(slot, envNames);
    return;
  }
  if (out.some((e) => e.url === url)) return;
  out.push({ url, label, role, emergency });
}

function emergencySlots(out: UpgradeRpcEndpoint[]): void {
  const publicnode =
    envTrim('PUBLICNODE_URL') || PUBLICNODE_HTTP;
  push(
    out,
    publicnode,
    'publicnode',
    'fallback',
    'emergency-publicnode',
    ['PUBLICNODE_URL'],
    true
  );
  const rpcUrl = envTrim('RPC_URL', 'RPC_PRIMARY');
  if (rpcUrl && rpcUrl !== publicnode) {
    push(out, rpcUrl, 'rpc-url', 'fallback', 'emergency-rpc-url', ['RPC_URL'], true);
  }
}

function fourLane(): UpgradeRpcEndpoint[] {
  const out: UpgradeRpcEndpoint[] = [];
  push(
    out,
    envAlchemyUrl('ALCHEMY_API_KEY_BACKUP', 'ALCHEMY_API_KEY'),
    'alchemy-backup',
    'primary',
    'Trading',
    ['ALCHEMY_API_KEY_BACKUP', 'ALCHEMY_API_KEY']
  );
  push(
    out,
    envHeliusUrl('HELIUS_API_KEY_BACKUP', 'HELIUS_API_KEY', 'HELIUS_RPC_URL'),
    'helius-backup',
    'secondary',
    'Scanner',
    ['HELIUS_API_KEY_BACKUP', 'HELIUS_API_KEY']
  );
  push(
    out,
    envAlchemyUrl('ALCHEMY_API_KEY_BACKUP2'),
    'alchemy-backup2',
    'data',
    'Data',
    ['ALCHEMY_API_KEY_BACKUP2']
  );
  push(
    out,
    envAlchemyUrl('ALCHEMY_API_KEY_BACKUP3'),
    'alchemy-backup3',
    'utility',
    'Utility',
    ['ALCHEMY_API_KEY_BACKUP3']
  );
  emergencySlots(out);
  return out;
}

function classicThreeLane(): UpgradeRpcEndpoint[] {
  const out: UpgradeRpcEndpoint[] = [];
  push(
    out,
    envHeliusUrl('HELIUS_API_KEY', 'HELIUS_RPC_URL', 'HELIUS_API_KEY_BACKUP'),
    'helius',
    'primary',
    'Critical',
    ['HELIUS_API_KEY']
  );
  push(
    out,
    envAlchemyUrl('ALCHEMY_API_KEY', 'ALCHEMY_API_KEY_BACKUP'),
    'alchemy',
    'secondary',
    'Scanners',
    ['ALCHEMY_API_KEY']
  );
  push(
    out,
    envTrim('PUBLICNODE_URL') || PUBLICNODE_HTTP,
    'publicnode',
    'utility',
    'Utility',
    ['PUBLICNODE_URL']
  );
  emergencySlots(out);
  return out;
}

function loadModeInventory(): UpgradeRpcEndpoint[] {
  const out: UpgradeRpcEndpoint[] = [];
  push(
    out,
    envAlchemyUrl('ALCHEMY_API_KEY_BACKUP', 'ALCHEMY_API_KEY'),
    'alchemy-backup',
    'primary',
    'Trading',
    ['ALCHEMY_API_KEY_BACKUP']
  );
  push(
    out,
    envAlchemyUrl('ALCHEMY_API_KEY_BACKUP2'),
    'alchemy-backup2',
    'secondary',
    'Scanner',
    ['ALCHEMY_API_KEY_BACKUP2']
  );
  push(
    out,
    envHeliusUrl('HELIUS_API_KEY', 'HELIUS_RPC_URL', 'HELIUS_API_KEY_BACKUP'),
    'helius',
    'utility',
    'Watcher',
    ['HELIUS_API_KEY']
  );
  push(
    out,
    envAlchemyUrl('ALCHEMY_API_KEY_BACKUP3'),
    'alchemy-backup3',
    'fallback',
    'Emergency',
    ['ALCHEMY_API_KEY_BACKUP3'],
    true
  );
  emergencySlots(out);
  return out;
}

function exclusiveKeys(): UpgradeRpcEndpoint[] {
  const out: UpgradeRpcEndpoint[] = [];
  const slots: Array<{
    env: string[];
    label: string;
    role: RpcLaneRole;
    kind: 'alchemy' | 'helius';
    emergency?: boolean;
  }> = [
    { env: ['ALCHEMY_API_KEY'], label: 'trading', role: 'primary', kind: 'alchemy' },
    {
      env: ['ALCHEMY_API_KEY_BACKUP'],
      label: 'favourites',
      role: 'utility',
      kind: 'alchemy',
    },
    {
      env: ['ALCHEMY_API_KEY_BACKUP2'],
      label: 'watches',
      role: 'data',
      kind: 'alchemy',
    },
    {
      env: ['ALCHEMY_API_KEY_BACKUP3'],
      label: 'market',
      role: 'secondary',
      kind: 'alchemy',
    },
    {
      env: ['ALCHEMY_API_KEY_BACKUP4'],
      label: 'zion',
      role: 'fallback',
      kind: 'alchemy',
    },
    {
      env: ['ALCHEMY_API_KEY_BACKUP5'],
      label: 'migration',
      role: 'fallback',
      kind: 'alchemy',
    },
    {
      env: ['ALCHEMY_API_KEY_BACKUP6'],
      label: 'alpha',
      role: 'fallback',
      kind: 'alchemy',
    },
    {
      env: ['ALCHEMY_API_KEY_BACKUP7'],
      label: 'anti-rug',
      role: 'fallback',
      kind: 'alchemy',
    },
    {
      env: ['HELIUS_API_KEY', 'HELIUS_RPC_URL'],
      label: 'activity',
      role: 'fallback',
      kind: 'helius',
    },
    {
      env: ['HELIUS_API_KEY_BACKUP'],
      label: 'utility-light',
      role: 'fallback',
      kind: 'helius',
    },
  ];
  for (const s of slots) {
    const url =
      s.kind === 'helius' ? envHeliusUrl(...s.env) : envAlchemyUrl(...s.env);
    push(out, url, s.label, s.role, s.label, s.env, s.emergency);
  }
  emergencySlots(out);
  return out;
}

export function getUpgradeRpcInventory(): UpgradeRpcEndpoint[] | null {
  const map = getActiveRpcLaneMap();
  if (!map) return null;
  if (map === 'rpc_four_lane') return fourLane();
  if (map === 'rpc_classic_three_lane') return classicThreeLane();
  if (map === 'rpc_load_mode_inventory') return loadModeInventory();
  if (map === 'rpc_exclusive_keys') return exclusiveKeys();
  return null;
}

export function toNormalizedInventory(
  list: UpgradeRpcEndpoint[]
): NormalizedRpcEndpoint[] {
  return list.map((e) => ({
    url: e.url,
    label: e.label,
    role: e.role,
    emergency: e.emergency === true,
  }));
}
