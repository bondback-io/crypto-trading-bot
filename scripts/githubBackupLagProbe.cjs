/**
 * GitHub backup lag / retry-loop probe (1.2.339).
 *
 * Detects overdue scheduled uploads + lastUploadOk=false (failure never
 * advances lastUploadAtMs → 60s full-export retry storm).
 *
 * Env:
 *   BASE_URL        default http://127.0.0.1:3010
 *   PROBE_SECONDS   default 180
 *   SAMPLE_MS       default 10000
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BASE_URL = String(process.env.BASE_URL || 'http://127.0.0.1:3010')
  .trim()
  .replace(/\/$/, '');
const PROBE_SECONDS = Math.max(60, Number(process.env.PROBE_SECONDS) || 180);
const SAMPLE_MS = Math.max(5_000, Number(process.env.SAMPLE_MS) || 10_000);

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

async function main() {
  console.log(`[github-backup-lag] BASE_URL=${BASE_URL}`);
  console.log(
    `[github-backup-lag] sampling every ${SAMPLE_MS}ms for ${PROBE_SECONDS}s`
  );

  const startedAt = Date.now();
  const deadline = startedAt + PROBE_SECONDS * 1000;
  const samples = [];
  let loopSuspectHits = 0;

  while (Date.now() < deadline) {
    const tSec = Math.round((Date.now() - startedAt) / 1000);
    const health = await timedFetch(`${BASE_URL}/health`);
    const gh = await timedFetch(`${BASE_URL}/api/site-backup/github/status`);
    const site = await timedFetch(`${BASE_URL}/api/site-backup/latest`);

    const g = gh.ok && gh.body && typeof gh.body === 'object' ? gh.body : {};
    const now = Date.now();
    const nextDue = g.nextDueAtMs != null ? Number(g.nextDueAtMs) : null;
    const overdue =
      g.interval &&
      g.interval !== 'none' &&
      nextDue != null &&
      now >= nextDue;
    const failSticky =
      g.lastUploadOk === false &&
      Boolean(g.lastUploadError) &&
      overdue;
    if (failSticky) loopSuspectHits += 1;

    const row = {
      tSec,
      at: now,
      healthMs: health.ms,
      healthOk: health.ok,
      githubStatusMs: gh.ms,
      siteLatestMs: site.ms,
      interval: g.interval ?? null,
      configured: Boolean(g.configured),
      schedulerRunning: Boolean(g.schedulerRunning),
      lastUploadOk: g.lastUploadOk ?? null,
      lastUploadError: g.lastUploadError ?? null,
      lastUploadAtMs: g.lastUploadAtMs ?? null,
      lastUploadAttemptAtMs: g.lastUploadAttemptAtMs ?? null,
      consecutiveFailures: g.consecutiveFailures ?? null,
      uploadBackoffMs: g.uploadBackoffMs ?? null,
      nextDueAtMs: nextDue,
      overdue,
      failStickyOverdue: failSticky,
      nextDueInSec:
        nextDue != null ? Math.round((nextDue - now) / 1000) : null,
    };
    samples.push(row);

    console.log(
      `[github-backup-lag] t=${tSec}s health=${row.healthMs}ms ` +
        `interval=${row.interval} overdue=${row.overdue} ` +
        `ok=${row.lastUploadOk} failSticky=${row.failStickyOverdue}` +
        (row.lastUploadError
          ? ` err=${String(row.lastUploadError).slice(0, 80)}`
          : '') +
        (row.uploadBackoffMs != null ? ` backoffMs=${row.uploadBackoffMs}` : '')
    );

    const remain = deadline - Date.now();
    if (remain <= 0) break;
    await sleep(Math.min(SAMPLE_MS, remain));
  }

  const healthMs = samples.map((s) => s.healthMs).filter((n) => n > 0);
  const healthP95 = (() => {
    if (!healthMs.length) return null;
    const sorted = healthMs.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  })();

  const last = samples[samples.length - 1] || {};
  const verdict =
    loopSuspectHits >= 2
      ? 'LOOP_SUSPECT: overdue + lastUploadOk=false across multiple samples (pre-fix 60s retry pattern)'
      : last.interval === 'none'
        ? 'IDLE: interval=none (scheduler not uploading)'
        : last.uploadBackoffMs != null && last.uploadBackoffMs > 60_000
          ? 'BACKOFF_OK: failure path has backoff > 60s'
          : last.overdue && last.lastUploadOk === false
            ? 'WATCH: currently overdue after failure — confirm backoff fields after 1.2.339'
            : 'OK: no sticky overdue-failure pattern observed in this window';

  const report = {
    kind: 'github-backup-lag',
    baseUrl: BASE_URL,
    startedAt,
    endedAt: Date.now(),
    probeSeconds: PROBE_SECONDS,
    sampleMs: SAMPLE_MS,
    summary: {
      samples: samples.length,
      loopSuspectHits,
      healthMsP95: healthP95,
      peakHealthMs: healthMs.length ? Math.max(...healthMs) : null,
      verdict,
      lastStatus: {
        interval: last.interval,
        lastUploadOk: last.lastUploadOk,
        lastUploadError: last.lastUploadError,
        overdue: last.overdue,
        consecutiveFailures: last.consecutiveFailures,
        uploadBackoffMs: last.uploadBackoffMs,
        nextDueInSec: last.nextDueInSec,
      },
    },
    samples,
  };

  const dataDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const outName = `github-backup-lag-${new Date()
    .toISOString()
    .replace(/[:.]/g, '-')}.json`;
  const outPath = path.join(dataDir, outName);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('[github-backup-lag] ── summary ──');
  console.log(`  loopSuspectHits=${loopSuspectHits}`);
  console.log(`  health p95=${healthP95}ms peak=${report.summary.peakHealthMs}ms`);
  console.log(`  verdict: ${verdict}`);
  console.log(`[github-backup-lag] wrote ${outPath}`);
}

main().catch((err) => {
  console.error('[github-backup-lag] fatal:', err);
  process.exit(1);
});
