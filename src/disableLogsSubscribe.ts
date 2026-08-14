/**
 * Emergency: globally disable Solana web3.js WS subscribe APIs.
 * @solana/web3.js retries failed *Subscribe forever (max_reconnects: Infinity)
 * which storms Alchemy and OOMs Render. Import this module before any RPC work.
 *
 * Confirmations must use HTTP getSignatureStatuses (see confirmSignatureHttp).
 */

import { Connection } from '@solana/web3.js';

let stubInstalled = false;
const onceLogged = new Set<string>();

function logOnce(key: string, message: string): void {
  if (onceLogged.has(key)) return;
  onceLogged.add(key);
  console.warn(message);
}

function isMethodNotFound(err: unknown): boolean {
  const any = err as { code?: unknown; message?: unknown };
  if (any?.code === -32601 || any?.code === '-32601') return true;
  const msg = String(any?.message ?? err ?? '');
  return (
    /-32601/.test(msg) ||
    /method not found/i.test(msg) ||
    /method ['`]?\w+Subscribe['`]? not found/i.test(msg)
  );
}

export function installLogsSubscribeGlobalDisable(): void {
  if (stubInstalled) return;
  stubInstalled = true;

  const proto = Connection.prototype as unknown as {
    onLogs: (...args: unknown[]) => number;
    removeOnLogsListener: (id: number) => Promise<void>;
    onSignature: (...args: unknown[]) => number;
    onSignatureWithOptions: (...args: unknown[]) => number;
    removeSignatureListener: (id: number) => Promise<void>;
    onAccountChange: (...args: unknown[]) => number;
    removeAccountChangeListener: (id: number) => Promise<void>;
    onProgramAccountChange: (...args: unknown[]) => number;
    removeProgramAccountChangeListener: (id: number) => Promise<void>;
  };

  proto.onLogs = function onLogsDisabled(): number {
    logOnce(
      'logsSubscribe',
      '[rpc] logsSubscribe_unsupported_disabled — Connection.onLogs stubbed (poll-only; no WS)'
    );
    return -1;
  };
  proto.removeOnLogsListener = async function removeOnLogsDisabled(): Promise<void> {
    /* no-op */
  };

  proto.onSignature = function onSignatureDisabled(): number {
    logOnce(
      'signatureSubscribe',
      '[rpc] signatureSubscribe_unsupported_disabled — Connection.onSignature stubbed (HTTP confirm only)'
    );
    return -1;
  };
  proto.onSignatureWithOptions = function onSignatureWithOptionsDisabled(): number {
    logOnce(
      'signatureSubscribe',
      '[rpc] signatureSubscribe_unsupported_disabled — Connection.onSignatureWithOptions stubbed (HTTP confirm only)'
    );
    return -1;
  };
  proto.removeSignatureListener = async function removeSignatureDisabled(): Promise<void> {
    /* no-op */
  };

  proto.onAccountChange = function onAccountChangeDisabled(): number {
    logOnce(
      'accountSubscribe',
      '[rpc] accountSubscribe_unsupported_disabled — Connection.onAccountChange stubbed'
    );
    return -1;
  };
  proto.removeAccountChangeListener = async function removeAccountChangeDisabled(): Promise<void> {
    /* no-op */
  };

  proto.onProgramAccountChange = function onProgramAccountChangeDisabled(): number {
    logOnce(
      'programSubscribe',
      '[rpc] programSubscribe_unsupported_disabled — Connection.onProgramAccountChange stubbed'
    );
    return -1;
  };
  proto.removeProgramAccountChangeListener =
    async function removeProgramAccountChangeDisabled(): Promise<void> {
      /* no-op */
    };

  // If web3.js internals still emit method-not-found, log once and never reconnect.
  const origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    const joined = args.map((a) => String(a)).join(' ');
    if (/Received JSON-RPC error calling/.test(joined) && /Subscribe/.test(joined)) {
      const method = joined.match(/calling ['`](\w+)['`]/)?.[1] || 'subscribe';
      if (isMethodNotFound(args[1]) || /-32601/.test(joined)) {
        logOnce(
          `${method}_32601`,
          `[rpc] ${method}_unsupported_disabled — method-not-found (-32601); no reconnect`
        );
        return;
      }
    }
    origError(...args);
  };
}

// Install on import so any early Connection use is covered.
installLogsSubscribeGlobalDisable();
