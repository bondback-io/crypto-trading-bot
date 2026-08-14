/**
 * Workloads-ON latency isolator.
 *
 * Turns feature groups ON one phase at a time, samples /health + /api/status
 * + RPC counters, ranks statusMs p95 delta vs all-OFF baseline, then restores.
 *
 * Env:
 *   BASE_URL        required
 *   RESTORE         default 1
 *   SETTLE_MS       default 10000
 *   SAMPLE_MS       default 8000
 *   PHASE_SECONDS   default 60 (baseline uses 45)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BASE_URL = String(process.env.BASE_URL || '')
  .trim()
  .replace(/\/$/, '');
const RESTORE = process.env.RESTORE !== '0';
const SETTLE_MS = Math.max(0, Number(process.env.SETTLE_MS) || 10_000);
const SAMPLE_MS = Math.max(4_000, Number(process.env.SAMPLE_MS) || 8_000);
const PHASE_SECONDS = Math.max(30, Number(process.env.PHASE_SECONDS) || 60);
const BASELINE_SECONDS = Math.max(20, Number(process.env.BASELINE_SECONDS) || 45);

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

const PHASES = [
  {
    id: 'baseline_off',
    seconds: BASELINE_SECONDS,
    on: [],
  },
  {
    id: 'scanners',
    seconds: PHASE_SECONDS,
    on: [
      'market_scanner',
      'alpha_scan',
      'zion_scanner',
      'bonding_curve',
      'token_metrics',
      'anti_rug',
      'open_mark',
    ],
  },
  {
    id: 'setup_watches',
    seconds: PHASE_SECONDS,
    on: ['dip_setup_watch', 'trend_setup_watch', 'majors_armed_watch'],
  },
  {
    id: 'favourites_bg',
    seconds: PHASE_SECONDS,
    on: [
      'wallet_poll',
      'activity',
      'influencer_holdings',
      'zion_wallet_read',
    ],
  },
  {
    id: 'migration_control',
    seconds: PHASE_SECONDS,
    on: [
      'migration',
      'mev',
      'health_probe',
      'live_balance',
      'priority_fee',
    ],
  },
  {
    id: 'all_on',
    seconds: PHASE_SECONDS,
    on: [...ALL_WORKLOAD_IDS],
  },
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
  return { ms: Date.now() - t0, status, ok, body, err };
}

function workloadsFromSnapshot(snap) {
  const map = {};
  const list = Array.isArray(snap?.workloads) ? snap.workloads : [];
  for (const w of list) {
    if (w && typeof w.id === 'string') map[w.id] = w.enabled !== false;
  }
  for (const id of ALL_WORKLOAD_IDS) {
    if (typeof map[id] !== 'boolean') map[id] = true;
  }
  return map;
}

function mapForPhase(onIds) {
  const map = {};
  for (const id of ALL_WORKLOAD_IDS) map[id] = false;
  for (const id of onIds) {
    if (ALL_WORKLOAD_IDS.includes(id)) map[id] = true;
  }
  return map;
}

function summaryStats(samples) {
  if (!samples.length) {
    return { n: 0, min: null, max: null, avg: null, p95: null };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const p95 =
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return {
    n: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round(sum / sorted.length),
    p95,
  };
}

function laneEwma(rpcBody, lane) {
  try {
    const L = rpcBody?.lanes?.[lane];
    if (!L) return null;
    const ms = L.latencyMs ?? L.ewmaMs ?? null;
    return ms != null && Number.isFinite(Number(ms)) ? Number(ms) : null;
  } catch {
    return null;
  }
}

async function setWorkloads(map) {
  return timedFetch(`${BASE_URL}/api/rpc/workloads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workloads: map }),
  });
}

async function samplePhase(phaseId, seconds) {
  const samples = [];
  const deadline = Date.now() + seconds * 1000;
  let i = 0;
  while (Date.now() < deadline) {
    i += 1;
    const [health, status, rpc] = await Promise.all([
      timedFetch(`${BASE_URL}/health`),
      timedFetch(`${BASE_URL}/api/status`),
      timedFetch(`${BASE_URL}/api/rpc`),
    ]);
    const rpcBody = rpc.body && typeof rpc.body === 'object' ? rpc.body : {};
    const row = {
      i,
      at: new Date().toISOString(),
      healthMs: health.ms,
      healthOk: health.ok,
      statusMs: status.ms,
      statusOk: status.ok,
      rpcMs: rpc.ms,
      idleIsolationActive: Boolean(rpcBody.idleIsolationActive),
      feature_calls_per_min: rpcBody.feature_calls_per_min ?? null,
      probe_calls_per_min: rpcBody.probe_calls_per_min ?? null,
      watcher_polls_per_min: rpcBody.watcher_polls_per_min ?? null,
      dip_watcher_polls_per_min: rpcBody.dip_watcher_polls_per_min ?? null,
      rpc_calls_last_60s: rpcBody.rpc_calls_last_60s ?? null,
      tradingEwmaMs: laneEwma(rpcBody, 'trading'),
      dataEwmaMs: laneEwma(rpcBody, 'data'),
      warning: rpcBody.warning ?? null,
    };
    samples.push(row);
    console.log(
      `[rpc-on-isolate] ${phaseId} #${i}` +
        ` health=${row.healthMs}ms status=${row.statusMs}ms` +
        ` idle=${row.idleIsolationActive}` +
        ` feat/min=${row.feature_calls_per_min}` +
        ` watch/min=${row.watcher_polls_per_min}` +
        ` dataEwma=${row.dataEwmaMs ?? '—'}` +
        ` tradeEwma=${row.tradingEwmaMs ?? '—'}`
    );
    if (Date.now() + SAMPLE_MS < deadline) await sleep(SAMPLE_MS);
    else break;
  }
  return samples;
}

function summarizePhase(phaseId, on, samples) {
  const health = summaryStats(samples.map((s) => s.healthMs));
  const status = summaryStats(samples.map((s) => s.statusMs));
  const maxFeat = Math.max(
    0,
    ...samples.map((s) => Number(s.feature_calls_per_min) || 0)
  );
  const maxWatch = Math.max(
    0,
    ...samples.map((s) => Number(s.watcher_polls_per_min) || 0)
  );
  const maxProbe = Math.max(
    0,
    ...samples.map((s) => Number(s.probe_calls_per_min) || 0)
  );
  const maxRpc60 = Math.max(
    0,
    ...samples.map((s) => Number(s.rpc_calls_last_60s) || 0)
  );
  const dataEwmas = samples
    .map((s) => s.dataEwmaMs)
    .filter((n) => n != null && Number.isFinite(n));
  const tradeEwmas = samples
    .map((s) => s.tradingEwmaMs)
    .filter((n) => n != null && Number.isFinite(n));
  return {
    id: phaseId,
    on,
    health,
    status,
    max_feature_calls_per_min: maxFeat,
    max_watcher_polls_per_min: maxWatch,
    max_probe_calls_per_min: maxProbe,
    max_rpc_calls_last_60s: maxRpc60,
    dataEwmaAvg: dataEwmas.length
      ? Math.round(dataEwmas.reduce((a, b) => a + b, 0) / dataEwmas.length)
      : null,
    tradingEwmaAvg: tradeEwmas.length
      ? Math.round(tradeEwmas.reduce((a, b) => a + b, 0) / tradeEwmas.length)
      : null,
    samples,
  };
}

async function main() {
  if (!BASE_URL) {
    console.error('[rpc-on-isolate] BASE_URL required');
    process.exit(2);
  }
  console.log(`[rpc-on-isolate] BASE_URL=${BASE_URL}`);
  console.log(
    `[rpc-on-isolate] PHASE_SECONDS=${PHASE_SECONDS} SETTLE_MS=${SETTLE_MS} RESTORE=${RESTORE ? 1 : 0}`
  );

  const health0 = await timedFetch(`${BASE_URL}/health`);
  if (!health0.ok) {
    console.error(
      `[rpc-on-isolate] /health failed status=${health0.status} err=${health0.err || ''}`
    );
    process.exit(1);
  }

  const wlGet = await timedFetch(`${BASE_URL}/api/rpc/workloads`);
  if (!wlGet.ok) {
    console.error(
      `[rpc-on-isolate] GET /api/rpc/workloads failed status=${wlGet.status}`
    );
    process.exit(1);
  }
  const prior = workloadsFromSnapshot(wlGet.body);

  const report = {
    at: new Date().toISOString(),
    baseUrl: BASE_URL,
    priorWorkloads: prior,
    phases: [],
    ranking: [],
    verdict: null,
    nextAction: null,
    restored: false,
    restoreError: null,
  };

  let restoreDone = false;
  const restore = async () => {
    if (restoreDone || !RESTORE) return;
    restoreDone = true;
    const r = await setWorkloads(prior);
    report.restored = r.ok;
    if (!r.ok) {
      report.restoreError = `status=${r.status} err=${r.err || ''}`;
      console.error(`[rpc-on-isolate] RESTORE FAILED ${report.restoreError}`);
    } else {
      console.log(`[rpc-on-isolate] restored prior workloads (${r.ms}ms)`);
    }
  };
  process.on('SIGINT', () => {
    void restore().then(() => process.exit(130));
  });
  process.on('SIGTERM', () => {
    void restore().then(() => process.exit(143));
  });

  try {
    for (const phase of PHASES) {
      const map = mapForPhase(phase.on);
      console.log(
        `\n[rpc-on-isolate] === phase ${phase.id} ON=[${phase.on.join(',') || 'none'}] ===`
      );
      const setRes = await setWorkloads(map);
      if (!setRes.ok) {
        throw new Error(
          `set workloads failed for ${phase.id}: status=${setRes.status}`
        );
      }
      console.log(`[rpc-on-isolate] settle ${SETTLE_MS}ms…`);
      await sleep(SETTLE_MS);
      const samples = await samplePhase(phase.id, phase.seconds);
      const summary = summarizePhase(phase.id, phase.on, samples);
      report.phases.push(summary);
      console.log(
        `[rpc-on-isolate] ${phase.id} status p95=${summary.status.p95} avg=${summary.status.avg}` +
          ` featMax=${summary.max_feature_calls_per_min} watchMax=${summary.max_watcher_polls_per_min}`
      );
    }
  } catch (err) {
    console.error('[rpc-on-isolate] fatal during phases', err);
    await restore();
    process.exit(1);
  }

  await restore();

  const baseline = report.phases.find((p) => p.id === 'baseline_off');
  // Trim one outlier from baseline p95 (cold first sample / GC spike).
  const baseSamples = (baseline?.samples || []).map((s) => s.statusMs).sort((a, b) => a - b);
  const baseTrimmed =
    baseSamples.length >= 4 ? baseSamples.slice(0, -1) : baseSamples;
  const baseP95 = summaryStats(baseTrimmed).p95 ?? baseline?.status?.p95 ?? 0;
  const ranking = report.phases
    .filter((p) => p.id !== 'baseline_off')
    .map((p) => ({
      id: p.id,
      statusP95: p.status.p95,
      statusAvg: p.status.avg,
      deltaP95: (p.status.p95 ?? 0) - baseP95,
      deltaAvg: (p.status.avg ?? 0) - (baseline?.status?.avg ?? 0),
      max_feature_calls_per_min: p.max_feature_calls_per_min,
      max_watcher_polls_per_min: p.max_watcher_polls_per_min,
      dataEwmaAvg: p.dataEwmaAvg,
      tradingEwmaAvg: p.tradingEwmaAvg,
    }))
    .sort((a, b) => {
      // Prefer positive status delta; fall back to absolute p95 then feature calls.
      if (b.deltaP95 !== a.deltaP95) return b.deltaP95 - a.deltaP95;
      if ((b.statusP95 ?? 0) !== (a.statusP95 ?? 0)) {
        return (b.statusP95 ?? 0) - (a.statusP95 ?? 0);
      }
      return b.max_feature_calls_per_min - a.max_feature_calls_per_min;
    });
  report.ranking = ranking;
  report.baselineStatusP95Trimmed = baseP95;

  const top = ranking[0];
  let verdict = 'unknown';
  let nextAction = '';
  if (!top) {
    verdict = 'no_phases';
  } else if (top.deltaP95 < 50 && (ranking.find((r) => r.id === 'all_on')?.deltaP95 ?? 0) < 80) {
    verdict = 'no_significant_status_latency';
    nextAction =
      'Status path stays fast; production lag may be external CU/CF under sustained load — keep 1.2.335 gates';
  } else if (top.id === 'scanners') {
    verdict = 'scanners_primary';
    nextAction =
      'Cut Market enrichBudget / stretch poll when Data EWMA high; pause enrichCurve under Data pressure';
  } else if (top.id === 'setup_watches') {
    verdict = 'setup_watches_primary';
    nextAction = 'Lower dip full-refresh / tighten HTTP watcher cadence';
  } else if (top.id === 'favourites_bg') {
    verdict = 'favourites_primary';
    nextAction = 'Tighten soft-watch cap / Favourites shed';
  } else if (top.id === 'migration_control') {
    verdict = 'migration_control_primary';
    nextAction = 'Back off migration poll / health probe rate';
  } else if (top.id === 'all_on') {
    const second = ranking[1];
    if (second && second.deltaP95 > 40) {
      verdict = `stacking_with_${second.id}`;
      nextAction = `Combined load worst; also mitigate ${second.id}`;
    } else {
      verdict = 'interaction_stacking_only';
      nextAction =
        'Only all_on is bad — reduce concurrent scanner+watch overlap';
    }
  } else {
    verdict = `primary_${top.id}`;
    nextAction = `Mitigate ${top.id}`;
  }

  // Prefer scanners if they nearly tie all_on (within 20% of top delta)
  const scanners = ranking.find((r) => r.id === 'scanners');
  if (
    top &&
    top.id === 'all_on' &&
    scanners &&
    scanners.deltaP95 >= top.deltaP95 * 0.7 &&
    scanners.deltaP95 >= 50
  ) {
    verdict = 'scanners_primary';
    nextAction =
      'Scanners explain most of all_on delta — cut enrichBudget / poll stretch';
  }

  report.verdict = verdict;
  report.nextAction = nextAction;
  report.baselineStatusP95 = baseP95;

  console.log('\n[rpc-on-isolate] === RANKING (status p95 delta vs OFF) ===');
  console.log(JSON.stringify(ranking, null, 2));
  console.log(`[rpc-on-isolate] verdict=${verdict}`);
  console.log(`[rpc-on-isolate] next=${nextAction}`);

  const outName = `rpc-on-isolate-${Date.now()}.json`;
  const candidates = [
    path.join(process.cwd(), 'data', outName),
    path.join(process.cwd(), outName),
  ];
  for (const p of candidates) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(report, null, 2));
      console.log(`[rpc-on-isolate] wrote ${p}`);
      break;
    } catch {
      /* try next */
    }
  }

  if (RESTORE && !report.restored) process.exit(3);
}

main().catch((err) => {
  console.error('[rpc-on-isolate] fatal', err);
  process.exit(1);
});
