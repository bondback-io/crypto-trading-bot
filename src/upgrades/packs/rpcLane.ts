import { makeFlagPack } from './flagPack';

function rebuildRpc(): void {
  try {
    const { rebuildRpcEndpoints } =
      require('../../connection') as typeof import('../../connection');
    rebuildRpcEndpoints();
  } catch (err) {
    console.warn(
      '[upgrades] RPC rebuild failed:',
      err instanceof Error ? err.message : err
    );
  }
}

export function makeRpcLanePack(id: string, label: string) {
  const inner = makeFlagPack(id, label);
  let live = false;
  return {
    enable() {
      inner.enable();
      live = true;
      rebuildRpc();
    },
    disable() {
      inner.disable();
      if (live) {
        live = false;
        rebuildRpc();
      }
    },
  };
}
