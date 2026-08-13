/**
 * RPC-off idle isolation probe.
 *
 * Turns ALL RPC workloads OFF (including health_probe), samples /health +
 * /api/status latency and residual Solana RPC via idle tracer, then restores.
 *
 * Env:
 *   BASE_URL        required (e.g. https://your-service.onrender.com)
 *   PROBE_SECONDS   default 150
 *   RESTORE         default 1 (restore prior workloads)
 *   SETTLE_MS       default 15000
 *   SAMPLE_MS       default 10000
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BASE_URL = String(process.env.BASE_URL || '')
  .trim()
  .replace(/\/$/, '');
const PROBE_SECONDS = Math.max(
  30,
  Number(process.env.PROBE_SECONDS) || 150
);
const RESTORE = process.env.RESTORE !== '0';
const SETTLE_MS = Math.max(0, Number(process.env.SETTLE_MS) || 15_000);
const SAMPLE_MS = Math.max(5_000, Number(process.env.SAMPLE_MS) || 10_000);

/** Full catalog — must match src/rpcWorkloadControl.ts RPC_WORKLOAD_CATALOG ids. */
const ALL_WORKLOAD_IDS = [
  'trade_entry',
  'migration',
  'live_balance',
  'mev',
  'priority_fee',
  'zion_place_trade',
  'market_scanner',
  'dip_setup_watch',
  'trend_setup_watch',
  'majors_armed_watch',
  'alpha_scan',
  'zion_scanner',
  'token_metrics',
  'anti_rug',
  'open_mark',
  'bonding_curve',
  'wallet_poll',
  'activity',
  'influencer_holdings',
  'health_probe',
  'zion_wallet_read',
];

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
  return {
    ms: Date.now() - t0,
    status,
    ok,
    body,
    err,
  };
}

function workloadsFromSnapshot(snap) {
  const map = {};
  const list = Array.isArray(snap?.workloads) ? snap.workloads : [];
  for (const w of list) {
    if (w && typeof w.id === 'string') {
      map[w.id] = w.enabled !== false;
    }
  }
  for (const id of ALL_WORKLOAD_IDS) {
    if (typeof map[id] !== 'boolean') map[id] = true;
  }
  return map;
}

function summaryStats(samples) {
  if (!samples.length) return { n: 0, min: null, max: null, avg: null, p95: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return {
    n: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round(sum / sorted.length),
    p95,
  };
}

async function main() {
  if (!BASE_URL) {
    console.error(
      '[rpc-idle-probe] BASE_URL required (e.g. https://your-service.onrender.com)'
    );
    process.exit(2);
  }

  console.log(`[rpc-idle-probe] BASE_URL=${BASE_URL}`);
  console.log(
    `[rpc-idle-probe] PROBE_SECONDS=${PROBE_SECONDS} RESTORE=${RESTORE ? 1 : 0}`
  );

  const health0 = await timedFetch(`${BASE_URL}/health`);
  if (!health0.ok && health0.status !== 200) {
    console.error(
      `[rpc-idle-probe] site unreachable /health status=${health0.status} err=${health0.err || ''} ms=${health0.ms}`
    );
    process.exit(1);
  }
  console.log(`[rpc-idle-probe] /health baseline ${health0.ms}ms status=${health0.status}`);

  const wlGet = await timedFetch(`${BASE_URL}/api/rpc/workloads`);
  if (!wlGet.ok) {
    console.error(
      `[rpc-idle-probe] GET /api/rpc/workloads failed status=${wlGet.status} err=${wlGet.err || ''}`
    );
    process.exit(1);
  }
  const prior = workloadsFromSnapshot(wlGet.body);
  console.log(
    `[rpc-idle-probe] saved ${Object.keys(prior).length} workloads; enabled=` +
      Object.entries(prior)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(',')
  );

  const allOff = {};
  for (const id of ALL_WORKLOAD_IDS) allOff[id] = false;

  const kill = await timedFetch(`${BASE_URL}/api/rpc/workloads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workloads: allOff }),
  });
  if (!kill.ok) {
    console.error(
      `[rpc-idle-probe] POST kill-all failed status=${kill.status} err=${kill.err || ''} body=${JSON.stringify(kill.body).slice(0, 300)}`
    );
    process.exit(1);
  }
  console.log(`[rpc-idle-probe] all workloads OFF (${kill.ms}ms)`);

  const report = {
    at: new Date().toISOString(),
    baseUrl: BASE_URL,
    probeSeconds: PROBE_SECONDS,
    priorWorkloads: prior,
    baseline: { healthMs: health0.ms },
    samples: [],
    restored: false,
    restoreError: null,
  };

  let restoreDone = false;
  const restore = async () => {
    if (restoreDone || !RESTORE) return;
    restoreDone = true;
    try {
      const r = await timedFetch(`${BASE_URL}/api/rpc/workloads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workloads: prior }),
      });
      report.restored = r.ok;
      if (!r.ok) {
        report.restoreError = `status=${r.status} err=${r.err || ''}`;
        console.error(`[rpc-idle-probe] RESTORE FAILED ${report.restoreError}`);
      } else {
        console.log(`[rpc-idle-probe] restored prior workloads (${r.ms}ms)`);
      }
    } catch (e) {
      report.restoreError = e instanceof Error ? e.message : String(e);
      console.error(`[rpc-idle-probe] RESTORE FAILED ${report.restoreError}`);
    }
  };

  process.on('SIGINT', () => {
    void restore().then(() => process.exit(130));
  });
  process.on('SIGTERM', () => {
    void restore().then(() => process.exit(143));
  });

  console.log(`[rpc-idle-probe] settling ${SETTLE_MS}ms…`);
  await sleep(SETTLE_MS);

  const deadline = Date.now() + PROBE_SECONDS * 1000;
  let n = 0;
  while (Date.now() < deadline) {
    n += 1;
    const [health, status, rpc] = await Promise.all([
      timedFetch(`${BASE_URL}/health`),
      timedFetch(`${BASE_URL}/api/status`),
      timedFetch(`${BASE_URL}/api/rpc`),
    ]);
    const rpcBody = rpc.body && typeof rpc.body === 'object' ? rpc.body : {};
    const row = {
      i: n,
      at: new Date().toISOString(),
      healthMs: health.ms,
      healthOk: health.ok,
      statusMs: status.ms,
      statusOk: status.ok,
      rpcMs: rpc.ms,
      idleIsolationActive: Boolean(rpcBody.idleIsolationActive),
      probe_calls_per_min: rpcBody.probe_calls_per_min ?? null,
      feature_calls_per_min: rpcBody.feature_calls_per_min ?? null,
      health_page_refresh_calls_per_min:
        rpcBody.health_page_refresh_calls_per_min ?? null,
      watcher_polls_per_min: rpcBody.watcher_polls_per_min ?? null,
      rpc_calls_last_60s: rpcBody.rpc_calls_last_60s ?? null,
      top_callers_when_workloads_off:
        rpcBody.top_callers_when_workloads_off ?? [],
      controlPlaneThrash: rpcBody.controlPlaneThrash ?? null,
      warning: rpcBody.warning ?? null,
    };
    report.samples.push(row);
    console.log(
      `[rpc-idle-probe] #${n}` +
        ` health=${row.healthMs}ms` +
        ` status=${row.statusMs}ms` +
        ` idle=${row.idleIsolationActive}` +
        ` rpc60s=${row.rpc_calls_last_60s}` +
        ` feat/min=${row.feature_calls_per_min}` +
        ` probe/min=${row.probe_calls_per_min}` +
        ` watch/min=${row.watcher_polls_per_min}` +
        (row.top_callers_when_workloads_off?.length
          ? ` top=${row.top_callers_when_workloads_off
              .slice(0, 3)
              .map((c) => `${c.label}:${c.count}`)
              .join(',')}`
          : '')
    );
    await sleep(SAMPLE_MS);
  }

  await restore();

  const healthMs = report.samples.map((s) => s.healthMs);
  const statusMs = report.samples.map((s) => s.statusMs);
  const maxRpc60 = Math.max(
    0,
    ...report.samples.map((s) => Number(s.rpc_calls_last_60s) || 0)
  );
  const maxFeat = Math.max(
    0,
    ...report.samples.map((s) => Number(s.feature_calls_per_min) || 0)
  );
  const maxProbe = Math.max(
    0,
    ...report.samples.map((s) => Number(s.probe_calls_per_min) || 0)
  );
  const idleOk = report.samples.every((s) => s.idleIsolationActive);
  const topMerged = new Map();
  for (const s of report.samples) {
    for (const c of s.top_callers_when_workloads_off || []) {
      const key = `${c.label}|${c.method}`;
      const prev = topMerged.get(key) || {
        label: c.label,
        method: c.method,
        count: 0,
      };
      prev.count = Math.max(prev.count, Number(c.count) || 0);
      topMerged.set(key, prev);
    }
  }
  const topCallers = [...topMerged.values()].sort((a, b) => b.count - a.count);

  report.summary = {
    health: summaryStats(healthMs),
    status: summaryStats(statusMs),
    idleIsolationAlways: idleOk,
    max_rpc_calls_last_60s: maxRpc60,
    max_feature_calls_per_min: maxFeat,
    max_probe_calls_per_min: maxProbe,
    topCallers,
  };

  // Decision tree verdict
  let verdict = 'unknown';
  let nextAction = '';
  if (maxRpc60 === 0 && report.summary.health.avg != null && report.summary.health.avg < 500) {
    if (report.summary.status.avg != null && report.summary.status.avg > 1500) {
      verdict = 'status_assembly_slow_not_solana_rpc';
      nextAction =
        'Profile /api/status hot path; reduce sync work when idleIsolation';
    } else if (maxFeat > 0 || maxProbe > 0) {
      verdict = 'control_plane_counter_noise';
      nextAction =
        'Counters may be UI polls (health-refresh) — not Solana; confirm feature_calls=0';
    } else {
      verdict = 'clean_idle_no_residual_rpc';
      nextAction = 'Latency when workloads ON is from feature RPC/HTTP — keep 1.2.335 gates';
    }
  } else if (maxRpc60 > 0 || topCallers.length) {
    verdict = 'residual_rpc_while_idle';
    nextAction = `Hard-gate callers: ${topCallers
      .slice(0, 5)
      .map((c) => c.label)
      .join(', ')}`;
  } else if (report.summary.health.max != null && report.summary.health.max > 40_000) {
    verdict = 'hosting_cold_start';
    nextAction = 'Render/Fly cold start — hosting only';
  }

  report.verdict = verdict;
  report.nextAction = nextAction;

  console.log('\n[rpc-idle-probe] === SUMMARY ===');
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`[rpc-idle-probe] verdict=${verdict}`);
  console.log(`[rpc-idle-probe] next=${nextAction}`);

  const outName = `rpc-idle-probe-${Date.now()}.json`;
  const candidates = [
    path.join(process.cwd(), 'data', outName),
    path.join(process.cwd(), outName),
  ];
  let written = null;
  for (const p of candidates) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(report, null, 2));
      written = p;
      break;
    } catch {
      /* try next */
    }
  }
  if (written) console.log(`[rpc-idle-probe] wrote ${written}`);
  else console.log('[rpc-idle-probe] (could not write JSON file — stdout only)');

  if (RESTORE && !report.restored) {
    process.exit(3);
  }
}

main().catch((err) => {
  console.error('[rpc-idle-probe] fatal', err);
  process.exit(1);
});
