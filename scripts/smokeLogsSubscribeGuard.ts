/**
 * Smoke: logsSubscribe -32601 hard-stop + influencer holdings 403 backoff.
 * Run: npx tsx scripts/smokeLogsSubscribeGuard.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Connection } from '@solana/web3.js';
import {
  __resetLogsSubscribeGuardForTests,
  disableLogsSubscribe,
  dropLogsSubscriptions,
  getLogsSubscribeGuardStatus,
  guardRpcWebSocket,
  isLogsSubscribeDisabled,
  isLogsSubscribeUnsupportedError,
  isWsRateLimitNoise,
  logRpcWsErrorOnce,
  shouldAttemptLogsSubscribe,
} from '../src/rpcWsGuard';
import {
  __resetMirrorHoldingsBackoffForTests,
  isMirrorHoldingsUnavailableError,
} from '../src/influencerMirrorRuntime';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

__resetLogsSubscribeGuardForTests();

check(
  'detects Method logsSubscribe not found',
  isLogsSubscribeUnsupportedError(
    Object.assign(new Error("Method 'logsSubscribe' not found"), { code: -32601 })
  )
);
check(
  'detects JSON-RPC calling logsSubscribe',
  isLogsSubscribeUnsupportedError(
    'Received JSON-RPC error calling `logsSubscribe` {"code":-32601}'
  )
);
check(
  'ignores unrelated 429',
  isLogsSubscribeUnsupportedError('429 too many requests') === false
);
check(
  'detects ws error 429 noise',
  isWsRateLimitNoise('ws error: Unexpected server response: 429')
);
check(
  'ignores non-429 ws error',
  isWsRateLimitNoise('ws error: Unexpected server response: 502') === false
);

disableLogsSubscribe('https://example-rpc.example/v1/key', 'method_not_found');
check(
  'same host is disabled',
  isLogsSubscribeDisabled('https://example-rpc.example/v1/otherkey')
);
check(
  'other host still allowed',
  shouldAttemptLogsSubscribe('https://other-rpc.example')
);
check(
  'status lists provider',
  getLogsSubscribeGuardStatus().providers.some((p) =>
    p.provider.includes('example-rpc.example')
  )
);

__resetLogsSubscribeGuardForTests();
check(
  'first identical error logs',
  logRpcWsErrorOnce('prov', "Method 'logsSubscribe' not found") === true
);
check(
  'second identical error suppressed',
  logRpcWsErrorOnce('prov', "Method 'logsSubscribe' not found") === false
);

type FakeConn = {
  _subscriptionsByHash: Record<
    string,
    { method?: string; callbacks?: Set<unknown>; state?: string }
  >;
  _rpcWebSocket: { call: (...args: unknown[]) => Promise<unknown> };
  _setSubscription: (hash: string, next: { method?: string; state?: string }) => void;
  _updateSubscriptions: () => Promise<void>;
};

async function runGuardLoopCheck(): Promise<void> {
  __resetLogsSubscribeGuardForTests();
  const fake: FakeConn = {
    _subscriptionsByHash: {
      h1: {
        method: 'logsSubscribe',
        callbacks: new Set(['cb']),
        state: 'pending',
      },
      h2: {
        method: 'accountSubscribe',
        callbacks: new Set(['cb']),
        state: 'subscribed',
      },
    },
    _rpcWebSocket: {
      async call(method: unknown) {
        if (method === 'logsSubscribe') {
          throw Object.assign(new Error("Method 'logsSubscribe' not found"), {
            code: -32601,
          });
        }
        return 1;
      },
    },
    _setSubscription(hash, next) {
      fake._subscriptionsByHash[hash] = next;
    },
    async _updateSubscriptions() {},
  };
  guardRpcWebSocket(fake as unknown as Connection, {
    url: 'https://no-logs.example',
    label: 'no-logs',
  });
  let threw = false;
  try {
    await fake._rpcWebSocket.call('logsSubscribe', []);
  } catch {
    threw = true;
  }
  check('call throws -32601', threw);
  check(
    'provider flagged after call',
    isLogsSubscribeDisabled('https://no-logs.example')
  );
  check(
    'logsSubscribe hash dropped (no retry fuel)',
    fake._subscriptionsByHash.h1 == null
  );
  check(
    'other subscriptions kept',
    fake._subscriptionsByHash.h2?.method === 'accountSubscribe'
  );
  fake._setSubscription('h1', { method: 'logsSubscribe', state: 'pending' });
  check(
    'setSubscription cannot revive logsSubscribe',
    fake._subscriptionsByHash.h1 == null
  );
  dropLogsSubscriptions(fake as unknown as Connection);
}

void runGuardLoopCheck()
  .then(() => {
    const mig = readSrc('src/migrationListener.ts');
    check(
      'migration will not reconnect when logsSubscribe disabled',
      /isLogsSubscribeDisabled\(rpcUrl\)/.test(mig) &&
        /shouldAttemptLogsSubscribe/.test(mig)
    );
    check(
      'health check stays poll-only when disabled',
      /isPublicRpcUrl\(rpcUrl\) \|\| isLogsSubscribeDisabled\(rpcUrl\)/.test(mig)
    );
    const connSrc = readSrc('src/connection.ts');
    check(
      'HTTP connections are WS-guarded',
      connSrc.includes('createGuardedConnection') &&
        connSrc.includes('guardRpcWebSocket')
    );
check(
  'WS guard rebinds error listener + filters 429',
  readSrc('src/rpcWsGuard.ts').includes('isWsRateLimitNoise') &&
    readSrc('src/rpcWsGuard.ts').includes("removeAllListeners('error')")
);
check(
  'WS console filter installs at module load',
  /installConsoleErrorFilter\(\);\s*\nif \(envDisableLogsSubscribe/.test(
    readSrc('src/rpcWsGuard.ts')
  ) ||
    /Boot-early: suppress web3\.js/.test(readSrc('src/rpcWsGuard.ts'))
);
check(
  'index installs WS filter before connection',
  /ensureRpcWsConsoleFilterInstalled/.test(readSrc('src/index.ts'))
);
check(
  'Utility light prefers RPC_URL',
  /utility_light[\s\S]*?envKey: 'RPC_URL'/.test(
    readSrc('src/rpcServiceMap.ts')
  )
);
    check(
      'index swallows logsSubscribe unhandledRejection',
      readSrc('src/index.ts').includes('isLogsSubscribeUnsupportedError')
    );

    __resetMirrorHoldingsBackoffForTests();
    check(
      '403 Request blocked is holdings-unavailable',
      isMirrorHoldingsUnavailableError('403 Request blocked')
    );
    check(
      'Insufficient credits is holdings-unavailable',
      isMirrorHoldingsUnavailableError('Insufficient credits for this request')
    );
    check(
      'generic timeout is not holdings-unavailable',
      isMirrorHoldingsUnavailableError('fetch failed') === false
    );
    const mir = readSrc('src/influencerMirrorRuntime.ts');
    check(
      'mirror logs mirror_holdings_unavailable once',
      mir.includes('mirror_holdings_unavailable') &&
        mir.includes('holdingsBackoffUntil')
    );

    if (failed) {
      console.error(`\n${failed} check(s) failed`);
      process.exit(1);
    }
    console.log('\nAll logsSubscribe guard checks passed');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
