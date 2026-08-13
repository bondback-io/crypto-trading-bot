/**
 * Idle-mode RPC tracer — proves residual callers when feature workloads are OFF.
 */

export type RpcIdleTraceRow = {
  at: number;
  label: string;
  endpoint: string;
  method: string;
  stack: string;
};

const RING_MAX = 200;
const ring: RpcIdleTraceRow[] = [];

function wantsTraceAlways(): boolean {
  return process.env.RPC_IDLE_TRACE === '1' || process.env.RPC_IDLE_TRACE === 'true';
}

export function shouldTraceIdleRpc(featuresOff: boolean): boolean {
  return featuresOff || wantsTraceAlways();
}

function firstAppFrame(): string {
  try {
    const stack = new Error().stack || '';
    const lines = stack.split('\n').slice(2);
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (/rpcIdleTrace|node:internal|node_modules/.test(t)) continue;
      if (/at (withRpcInner|probeState|noteIdleRpcCall|runWithRpcRole)/.test(t)) {
        continue;
      }
      return t.replace(/^at\s+/, '').slice(0, 160);
    }
  } catch {
    /* */
  }
  return '';
}

export function noteIdleRpcCall(opts: {
  label: string;
  endpoint: string;
  method: string;
  featuresOff: boolean;
}): void {
  if (!shouldTraceIdleRpc(opts.featuresOff)) return;
  const row: RpcIdleTraceRow = {
    at: Date.now(),
    label: opts.label || 'unknown',
    endpoint: opts.endpoint || 'none',
    method: opts.method || 'rpc',
    stack: firstAppFrame(),
  };
  ring.push(row);
  while (ring.length > RING_MAX) ring.shift();
  console.warn(
    `[rpc-idle-trace] label=${row.label} endpoint=${row.endpoint} method=${row.method}` +
      (row.stack ? ` @ ${row.stack}` : '')
  );
}

export function getIdleRpcTraceSnapshot(): {
  rpc_calls_last_60s: number;
  top_callers_when_workloads_off: Array<{
    label: string;
    count: number;
    method: string;
    lastAt: number;
  }>;
  recent: RpcIdleTraceRow[];
} {
  const now = Date.now();
  const recent = ring.filter((r) => r.at >= now - 60_000);
  const byKey = new Map<
    string,
    { label: string; method: string; count: number; lastAt: number }
  >();
  for (const r of recent) {
    const key = `${r.label}|${r.method}`;
    const prev = byKey.get(key);
    if (prev) {
      prev.count += 1;
      prev.lastAt = Math.max(prev.lastAt, r.at);
    } else {
      byKey.set(key, {
        label: r.label,
        method: r.method,
        count: 1,
        lastAt: r.at,
      });
    }
  }
  const top = [...byKey.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  return {
    rpc_calls_last_60s: recent.length,
    top_callers_when_workloads_off: top,
    recent: recent.slice(-40),
  };
}
