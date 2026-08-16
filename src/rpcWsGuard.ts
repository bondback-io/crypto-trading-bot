/**
 * WebSocket JSON-RPC guard: stop logsSubscribe retry storms (-32601) and
 * rate-limit identical WS errors. Does not touch HTTP RPC / trading lanes.
 */

import type { Connection } from '@solana/web3.js';

export const RPC_WS_ERROR_LOG_COOLDOWN_MS = 60_000;

type ConnPriv = Connection & {
  _rpcWebSocket?: {
    call: (...args: unknown[]) => Promise<unknown>;
    on?: (event: string, fn: (...args: unknown[]) => void) => void;
  };
  _wsOnError?: (err: Error) => void;
  _setSubscription?: (hash: string, next: { method?: string; state?: string }) => void;
  _subscriptionsByHash?: Record<
    string,
    { method?: string; callbacks?: Set<unknown>; state?: string }
  >;
  _updateSubscriptions?: () => Promise<void>;
  __rpcWsGuardAttached?: boolean;
};

const unsupportedByProvider = new Map<string, string>();
let globalDisableReason: string | null = null;
const lastErrorLogAt = new Map<string, number>();
let consoleFilterInstalled = false;
const origConsoleError = console.error.bind(console);

function envDisableLogsSubscribe(): boolean {
  return /^(1|true|yes|on)$/i.test(
    String(process.env.DISABLE_LOGS_SUBSCRIBE || '').trim()
  );
}

export function rpcProviderKey(url: string | null | undefined): string {
  const raw = String(url || '').trim();
  if (!raw) return 'rpc';
  if (raw === '*') return '*';
  try {
    const u = new URL(raw);
    return (u.host || raw).toLowerCase();
  } catch {
    return raw.replace(/\/\/.*@/, '//***@').slice(0, 64).toLowerCase();
  }
}

function flattenConsoleArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (a == null) return '';
      if (typeof a === 'string') return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      if (typeof a === 'object') {
        try {
          const rec = a as Record<string, unknown>;
          const err = rec.error ?? rec.message ?? rec.code;
          if (err instanceof Error) return err.message;
          if (typeof err === 'string') return err;
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      }
      return String(a);
    })
    .filter(Boolean)
    .join(' ');
}

export function isLogsSubscribeUnsupportedError(err: unknown): boolean {
  if (err == null) return false;
  const code =
    typeof err === 'object' && err != null && 'code' in err
      ? Number((err as { code?: unknown }).code)
      : NaN;
  const msg = flattenConsoleArgs([err]);
  if (code === -32601 && /logsSubscribe|method not found/i.test(msg)) {
    return true;
  }
  if (/-32601/.test(msg) && /logsSubscribe|method not found/i.test(msg)) {
    return true;
  }
  if (/logsSubscribe/i.test(msg) && /not found|method not found/i.test(msg)) {
    return true;
  }
  return false;
}

export function isJsonRpcMethodNotFoundNoise(text: string): boolean {
  const t = String(text || '');
  if (!t) return false;
  if (isLogsSubscribeUnsupportedError(t)) return true;
  return /logsSubscribe/i.test(t) && /JSON-RPC error calling|not found|-32601/i.test(t);
}

export function disableLogsSubscribe(
  urlOrProvider: string,
  reason: string
): boolean {
  const provider = rpcProviderKey(urlOrProvider);
  if (provider === '*') {
    if (globalDisableReason) return false;
    globalDisableReason = reason || 'disabled';
    console.warn(
      `[rpc] logs_subscribe_disabled reason=${globalDisableReason} provider=*`
    );
    return true;
  }
  if (unsupportedByProvider.has(provider)) return false;
  unsupportedByProvider.set(provider, reason || 'method_not_found');
  console.warn(
    `[rpc] logs_subscribe_disabled reason=${reason || 'method_not_found'} provider=${provider}`
  );
  return true;
}

export function isLogsSubscribeDisabled(
  urlOrProvider?: string | null
): boolean {
  if (globalDisableReason) return true;
  if (envDisableLogsSubscribe()) return true;
  if (!urlOrProvider) return false;
  return unsupportedByProvider.has(rpcProviderKey(urlOrProvider));
}

export function getLogsSubscribeDisableReason(
  urlOrProvider?: string | null
): string | null {
  if (globalDisableReason) return globalDisableReason;
  if (envDisableLogsSubscribe()) return 'env';
  if (!urlOrProvider) return null;
  return unsupportedByProvider.get(rpcProviderKey(urlOrProvider)) ?? null;
}

export function shouldAttemptLogsSubscribe(url?: string | null): boolean {
  return !isLogsSubscribeDisabled(url);
}

/** Rate-limit identical WS/JSON-RPC error lines. Returns true if this call should log. */
export function logRpcWsErrorOnce(
  provider: string,
  err: unknown,
  cooldownMs = RPC_WS_ERROR_LOG_COOLDOWN_MS
): boolean {
  const key = `${rpcProviderKey(provider)}|${flattenConsoleArgs([err]).slice(0, 180)}`;
  const now = Date.now();
  const last = lastErrorLogAt.get(key) ?? 0;
  if (now - last < cooldownMs) return false;
  lastErrorLogAt.set(key, now);
  return true;
}

export function dropLogsSubscriptions(conn: Connection): void {
  const c = conn as ConnPriv;
  const byHash = c._subscriptionsByHash;
  if (!byHash) return;
  for (const hash of Object.keys(byHash)) {
    const sub = byHash[hash];
    if (sub?.method === 'logsSubscribe') {
      try {
        sub.callbacks?.clear();
      } catch {
        /* ignore */
      }
      delete byHash[hash];
    }
  }
}

function installConsoleErrorFilter(): void {
  if (consoleFilterInstalled) return;
  consoleFilterInstalled = true;
  console.error = (...args: unknown[]) => {
    const text = flattenConsoleArgs(args);
    if (isJsonRpcMethodNotFoundNoise(text) || isLogsSubscribeUnsupportedError(text)) {
      if (logRpcWsErrorOnce('rpc', text)) {
        origConsoleError(
          '[rpc] logsSubscribe unsupported — WS logs disabled for this provider (poll fallback). Further -32601 suppressed 60s.'
        );
      }
      return;
    }
    origConsoleError(...(args as Parameters<typeof console.error>));
  };
}

/**
 * Patch a web3.js Connection so logsSubscribe -32601 cannot tight-loop
 * `_updateSubscriptions` (library retries with no delay).
 */
export function guardRpcWebSocket(
  conn: Connection,
  opts: { url: string; label?: string }
): void {
  const c = conn as ConnPriv;
  if (c.__rpcWsGuardAttached) return;
  c.__rpcWsGuardAttached = true;
  installConsoleErrorFilter();

  const url = opts.url;
  const label = opts.label || rpcProviderKey(url);

  if (envDisableLogsSubscribe()) {
    disableLogsSubscribe('*', 'env');
  }

  const origCall = c._rpcWebSocket?.call?.bind(c._rpcWebSocket);
  if (origCall && c._rpcWebSocket) {
    c._rpcWebSocket.call = async (...callArgs: unknown[]) => {
      const method = String(callArgs[0] || '');
      if (method === 'logsSubscribe' && isLogsSubscribeDisabled(url)) {
        dropLogsSubscriptions(conn);
        const err = Object.assign(
          new Error("Method 'logsSubscribe' not found"),
          { code: -32601 }
        );
        throw err;
      }
      try {
        return await origCall(...callArgs);
      } catch (e) {
        if (method === 'logsSubscribe' && isLogsSubscribeUnsupportedError(e)) {
          disableLogsSubscribe(url, 'method_not_found');
          dropLogsSubscriptions(conn);
        }
        throw e;
      }
    };
  }

  const origSet = c._setSubscription?.bind(c);
  if (origSet) {
    c._setSubscription = (hash, next) => {
      if (
        next?.method === 'logsSubscribe' &&
        isLogsSubscribeDisabled(url)
      ) {
        dropLogsSubscriptions(conn);
        return;
      }
      return origSet(hash, next);
    };
  }

  const origUpdate = c._updateSubscriptions?.bind(c);
  if (origUpdate) {
    c._updateSubscriptions = async () => {
      if (isLogsSubscribeDisabled(url)) {
        dropLogsSubscriptions(conn);
      }
      return origUpdate();
    };
  }

  const origWsOnError = c._wsOnError?.bind(c);
  if (origWsOnError) {
    c._wsOnError = (err: Error) => {
      if (isLogsSubscribeUnsupportedError(err)) {
        disableLogsSubscribe(url, 'method_not_found');
        dropLogsSubscriptions(conn);
        if (logRpcWsErrorOnce(label, err)) {
          origConsoleError(
            `[rpc] logsSubscribe unsupported on ${label} — WS logs disabled`
          );
        }
        return;
      }
      if (!logRpcWsErrorOnce(label, err)) return;
      origWsOnError(err);
    };
  }
}

export function getLogsSubscribeGuardStatus(): {
  disabled: boolean;
  globalReason: string | null;
  providers: Array<{ provider: string; reason: string }>;
} {
  return {
    disabled:
      Boolean(globalDisableReason) ||
      envDisableLogsSubscribe() ||
      unsupportedByProvider.size > 0,
    globalReason: globalDisableReason || (envDisableLogsSubscribe() ? 'env' : null),
    providers: [...unsupportedByProvider.entries()].map(([provider, reason]) => ({
      provider,
      reason,
    })),
  };
}

export function __resetLogsSubscribeGuardForTests(): void {
  unsupportedByProvider.clear();
  globalDisableReason = null;
  lastErrorLogAt.clear();
}

if (envDisableLogsSubscribe()) {
  disableLogsSubscribe('*', 'env');
  installConsoleErrorFilter();
}
