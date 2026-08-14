/**
 * Cold-boot RPC overlap probe (1.2.338).
 *
 * Assumes the process just started (or operator restarted :3010 first).
 * Samples every 5s for 120s with NO settle kill — captures post-deploy overlap.
 *
 * Env:
 *   BASE_URL        default http://127.0.0.1:3010
 *   PROBE_SECONDS   default 120
 *   SAMPLE_MS       default 5000
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BASE_URL = String(process.env.BASE_URL || 'http://127.0.0.1:3010')
  .trim()
  .replace(/\/$/, '');
const PROBE_SECONDS = Math.max(30, Number(process.env.PROBE_SECONDS) || 120);
const SAMPLE_MS = Math.max(3_000, Number(process.env.SAMPLE_MS) || 5_000);

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

function topTraffic(rows, n = 10) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, n).map((r) => ({
    endpoint: r.endpoint,
    feature: r.feature,
    role: r.role,
    count: r.count,
  }));
}

async function main() {
  if (!BASE_URL) {
    console.error('BASE_URL required');
    process.exit(1);
  }

  console.log(`[cold-boot] BASE_URL=${BASE_URL}`);
  console.log(
    `[cold-boot] sampling every ${SAMPLE_MS}ms for ${PROBE_SECONDS}s (no settle kill)`
  );
  console.log(
    '[cold-boot] Close extra dashboard tabs. Prefer a fresh process restart first.'
  );

  const startedAt = Date.now();
  const samples = [];
  const deadline = startedAt + PROBE_SECONDS * 1000;

  while (Date.now() < deadline) {
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    const health = await timedFetch(`${BASE_URL}/health`);
    const status = await timedFetch(`${BASE_URL}/api/status?src=probe`);
    const rpc = await timedFetch(`${BASE_URL}/api/rpc`);

    const rpcBody = rpc.ok && rpc.body && typeof rpc.body === 'object' ? rpc.body : {};
    const statusBody =
      status.ok && status.body && typeof status.body === 'object' ? status.body : {};
    const rpcFromStatus =
      statusBody.rpc && typeof statusBody.rpc === 'object' ? statusBody.rpc : {};

    const callTrafficLast60s =
      rpcBody.callTrafficLast60s ||
      rpcFromStatus.callTrafficLast60s ||
      { rows: [], total: 0 };
    const bootTimeline =
      rpcBody.bootTimeline ||
      rpcFromStatus.bootTimeline ||
      { processStartedAt: 0, uptimeMs: 0, recent: [] };

    const row = {
      tSec: elapsedSec,
      at: Date.now(),
      healthMs: health.ms,
      healthOk: health.ok,
      statusMs: status.ms,
      statusOk: status.ok,
      feature_calls_per_min:
        rpcBody.feature_calls_per_min ??
        rpcFromStatus.feature_calls_per_min ??
        null,
      probe_calls_per_min:
        rpcBody.probe_calls_per_min ?? rpcFromStatus.probe_calls_per_min ?? null,
      dashboard_refresh_per_min:
        rpcBody.dashboard_refresh_per_min ??
        rpcFromStatus.dashboard_refresh_per_min ??
        null,
      idleIsolationActive: Boolean(
        rpcBody.idleIsolationActive ?? rpcFromStatus.idleIsolationActive
      ),
      callTrafficLast60sTotal: callTrafficLast60s.total ?? 0,
      callTrafficLast60sTop10: topTraffic(callTrafficLast60s.rows, 10),
      bootTimelineRecent: Array.isArray(bootTimeline.recent)
        ? bootTimeline.recent.slice(-20)
        : [],
      bootUptimeMs: bootTimeline.uptimeMs ?? null,
      appVersion:
        (statusBody.app && statusBody.app.version) ||
        rpcBody.appVersion ||
        null,
    };
    samples.push(row);

    const top = (row.callTrafficLast60sTop10 || [])
      .slice(0, 3)
      .map((x) => `${x.feature || x.endpoint}:${x.count}`)
      .join(', ');
    console.log(
      `[cold-boot] t=${elapsedSec}s health=${row.healthMs}ms status=${row.statusMs}ms ` +
        `feat/min=${row.feature_calls_per_min} traffic60=${row.callTrafficLast60sTotal}` +
        (top ? ` top=[${top}]` : '') +
        (row.idleIsolationActive ? ' IDLE' : '')
    );

    const remain = deadline - Date.now();
    if (remain <= 0) break;
    await sleep(Math.min(SAMPLE_MS, remain));
  }

  const peakTraffic = samples.reduce(
    (m, s) => Math.max(m, s.callTrafficLast60sTotal || 0),
    0
  );
  const peakFeat = samples.reduce(
    (m, s) => Math.max(m, Number(s.feature_calls_per_min) || 0),
    0
  );
  const statusMs = samples.map((s) => s.statusMs).filter((n) => n > 0);
  const statusP95 = (() => {
    if (!statusMs.length) return null;
    const sorted = statusMs.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  })();

  const stages = [];
  for (const s of samples) {
    for (const ev of s.bootTimelineRecent || []) {
      if (ev.event === 'boot_stage' && ev.detail) {
        const key = `${ev.uptimeMs}|${ev.detail}`;
        if (!stages.some((x) => x.key === key)) {
          stages.push({ key, uptimeMs: ev.uptimeMs, detail: ev.detail });
        }
      }
    }
  }

  const report = {
    kind: 'rpc-cold-boot',
    baseUrl: BASE_URL,
    startedAt,
    endedAt: Date.now(),
    probeSeconds: PROBE_SECONDS,
    sampleMs: SAMPLE_MS,
    summary: {
      samples: samples.length,
      peakCallTrafficLast60s: peakTraffic,
      peakFeatureCallsPerMin: peakFeat,
      statusMsP95: statusP95,
      bootStagesSeen: stages.map((s) => ({
        uptimeMs: s.uptimeMs,
        detail: s.detail,
      })),
      appVersion: samples.find((s) => s.appVersion)?.appVersion || null,
    },
    samples,
  };

  const dataDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const outName = `rpc-cold-boot-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const outPath = path.join(dataDir, outName);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('[cold-boot] ── summary ──');
  console.log(`  samples=${report.summary.samples}`);
  console.log(`  peak traffic60s=${peakTraffic}`);
  console.log(`  peak feat/min=${peakFeat}`);
  console.log(`  status p95=${statusP95}ms`);
  console.log(
    `  boot stages: ${
      stages.length
        ? stages.map((s) => `t=${Math.round(s.uptimeMs / 1000)}s ${s.detail}`).join(' | ')
        : '(none yet — process may have been warm)'
    }`
  );
  console.log(`[cold-boot] wrote ${outPath}`);
}

main().catch((err) => {
  console.error('[cold-boot] fatal:', err);
  process.exit(1);
});
