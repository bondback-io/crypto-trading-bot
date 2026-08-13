/**
 * Emergency: globally disable Solana web3.js logsSubscribe / onLogs.
 * @solana/web3.js retries failed logsSubscribe forever (max_reconnects: Infinity)
 * which storms Alchemy and OOMs Render. Import this module before any RPC work.
 */

import { Connection } from '@solana/web3.js';

let stubInstalled = false;
let onceLogged = false;

export function installLogsSubscribeGlobalDisable(): void {
  if (stubInstalled) return;
  stubInstalled = true;

  const proto = Connection.prototype as unknown as {
    onLogs: (...args: unknown[]) => number;
    removeOnLogsListener: (id: number) => Promise<void>;
  };

  proto.onLogs = function onLogsDisabled(): number {
    if (!onceLogged) {
      onceLogged = true;
      console.warn(
        '[rpc] logsSubscribe_globally_disabled — Connection.onLogs stubbed (poll-only; no WS)'
      );
    }
    return -1;
  };

  proto.removeOnLogsListener = async function removeOnLogsDisabled(): Promise<void> {
    /* no-op */
  };
}

// Install on import so any early Connection use is covered.
installLogsSubscribeGlobalDisable();
