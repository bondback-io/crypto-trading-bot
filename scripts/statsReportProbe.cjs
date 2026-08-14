/**
 * Stats / Generate-report smoke probe (1.2.339).
 *
 * Times heavy Stats endpoints and proves Generate report does not bump
 * Solana RPC counters (CPU-only local joins).
 *
 * Env:
 *   BASE_URL   default http://127.0.0.1:3010
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BASE_URL = String(process.env.BASE_URL || 'http://127.0.0.1:3010')
  .trim()
  .replace(/\/$/, '');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function timedFetch(url, opts = {}) {
  const t0 = Date.now();
  let status = 0;
  let ok = false;
  let body = null;
  let err = null;
  try {
    const res = await fetch(url, {
      ...opts,
      headers: {
        Accept: 'application/json',
        ...(opts.headers || {}),
      },
    });
    status = res.status;
    ok = res.ok;
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 400);
    }
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  return { ms: Date.now() - t0, status, ok, body, err };
}

function rpcSnap(rpcBody) {
  const r = rpcBody && typeof rpcBody === 'object' ? rpcBody : {};
  return {
    feature_calls_per_min: r.feature_calls_per_min ?? null,
    probe_calls_per_min: r.probe_calls_per_min ?? null,
    rpc_calls_last_60s: r.rpc_calls_last_60s ?? null,
    health_page_refresh_calls_per_min: r.health_page_refresh_calls_per_min ?? null,
  };
}

async function main() {
  console.log(`[stats-reports] BASE_URL=${BASE_URL}`);

  const beforeRpc = await timedFetch(`${BASE_URL}/api/rpc`);
  const before = rpcSnap(beforeRpc.body);
  console.log('[stats-reports] RPC before:', JSON.stringify(before));

  const endpoints = [
    { id: 'trade-profiles-performance', path: '/api/trade-profiles/performance' },
    { id: 'expectancy-lift', path: '/api/expectancy-lift' },
    { id: 'trade-craft-performance', path: '/api/trade-craft-performance' },
    { id: 'learning-diagnostics', path: '/api/learning-diagnostics' },
    { id: 'learning-metrics', path: '/api/learning-metrics' },
    {
      id: 'system-diagnostics-export',
      path: '/api/system-diagnostics-export?window=20',
    },
    { id: 'learning-report', path: '/api/learning-report?window=50' },
  ];

  const results = [];
  for (const ep of endpoints) {
    console.log(`[stats-reports] timing ${ep.id}…`);
    const r = await timedFetch(`${BASE_URL}${ep.path}`);
    const row = {
      id: ep.id,
      path: ep.path,
      ms: r.ms,
      status: r.status,
      ok: r.ok,
      err: r.err,
      bytes:
        r.body != null
          ? Buffer.byteLength(
              typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
              'utf8'
            )
          : 0,
    };
    results.push(row);
    console.log(
      `[stats-reports]   ${ep.id}: ${r.ms}ms status=${r.status} ok=${r.ok} bytes=${row.bytes}`
    );
    // Brief yield so /api/rpc counters can settle between heavy sync builds.
    await sleep(500);
  }

  const afterRpc = await timedFetch(`${BASE_URL}/api/rpc`);
  const after = rpcSnap(afterRpc.body);
  console.log('[stats-reports] RPC after:', JSON.stringify(after));

  const delta = {
    feature_calls_per_min:
      (after.feature_calls_per_min ?? 0) - (before.feature_calls_per_min ?? 0),
    probe_calls_per_min:
      (after.probe_calls_per_min ?? 0) - (before.probe_calls_per_min ?? 0),
    rpc_calls_last_60s:
      (after.rpc_calls_last_60s ?? 0) - (before.rpc_calls_last_60s ?? 0),
  };

  // Allow tiny ambient drift; Generate report itself must not drive CU.
  const rpcBumpSuspect =
    delta.feature_calls_per_min >= 5 ||
    delta.probe_calls_per_min >= 3 ||
    delta.rpc_calls_last_60s >= 10;

  const exportRow = results.find((r) => r.id === 'system-diagnostics-export');
  const learningRow = results.find((r) => r.id === 'learning-report');

  const verdict = !results.every((r) => r.ok)
    ? 'PARTIAL: one or more Stats endpoints failed'
    : rpcBumpSuspect
      ? 'RPC_BUMP: counters rose during report window — investigate'
      : 'CPU_ONLY: reports OK; no meaningful Solana RPC bump';

  const report = {
    kind: 'stats-report-probe',
    baseUrl: BASE_URL,
    at: Date.now(),
    before,
    after,
    delta,
    results,
    summary: {
      verdict,
      systemDiagnosticsMs: exportRow?.ms ?? null,
      learningReportMs: learningRow?.ms ?? null,
      slowest: results.slice().sort((a, b) => b.ms - a.ms)[0] || null,
    },
  };

  const dataDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const outName = `stats-report-probe-${new Date()
    .toISOString()
    .replace(/[:.]/g, '-')}.json`;
  const outPath = path.join(dataDir, outName);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('[stats-reports] ── summary ──');
  console.log(`  verdict: ${verdict}`);
  console.log(
    `  system-diagnostics=${exportRow?.ms}ms learning-report=${learningRow?.ms}ms`
  );
  console.log(`  rpc delta: ${JSON.stringify(delta)}`);
  console.log(`[stats-reports] wrote ${outPath}`);

  if (!results.every((r) => r.ok)) process.exitCode = 2;
}

main().catch((err) => {
  console.error('[stats-reports] fatal:', err);
  process.exit(1);
});
