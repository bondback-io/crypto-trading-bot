/**
 * GitHub upload cost probe (1.2.340).
 *
 * Samples /health every 1s while triggering POST /api/site-backup/github/upload
 * (or OBSERVE_ONLY=1 to watch without uploading). Records phase timings from status.
 *
 * Env:
 *   BASE_URL        default http://127.0.0.1:3010
 *   OBSERVE_ONLY    default 0 — set 1 to skip POST upload
 *   SAMPLE_MS       default 1000
 *   WATCH_SECONDS   default 90 (after upload starts / observe window)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BASE_URL = String(process.env.BASE_URL || 'http://127.0.0.1:3010')
  .trim()
  .replace(/\/$/, '');
const OBSERVE_ONLY = process.env.OBSERVE_ONLY === '1';
const SAMPLE_MS = Math.max(500, Number(process.env.SAMPLE_MS) || 1000);
const WATCH_SECONDS = Math.max(20, Number(process.env.WATCH_SECONDS) || 90);

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
  console.log(`[github-upload-cost] BASE_URL=${BASE_URL}`);
  console.log(
    `[github-upload-cost] observeOnly=${OBSERVE_ONLY} sample=${SAMPLE_MS}ms watch=${WATCH_SECONDS}s`
  );

  const startedAt = Date.now();
  const healthSamples = [];
  let uploadResult = null;
  let uploadMs = null;

  const watchDeadline = startedAt + WATCH_SECONDS * 1000;

  const sampler = (async () => {
    while (Date.now() < watchDeadline) {
      const h = await timedFetch(`${BASE_URL}/health`);
      const st = await timedFetch(`${BASE_URL}/api/site-backup/github/status`);
      const g = st.ok && st.body && typeof st.body === 'object' ? st.body : {};
      healthSamples.push({
        tSec: Math.round((Date.now() - startedAt) / 1000),
        healthMs: h.ms,
        healthOk: h.ok,
        phases: g.lastUploadPhases || null,
        lastUploadOk: g.lastUploadOk ?? null,
        lastUploadContentSha: g.lastUploadContentSha
          ? String(g.lastUploadContentSha).slice(0, 12)
          : null,
      });
      console.log(
        `[github-upload-cost] t=${healthSamples[healthSamples.length - 1].tSec}s ` +
          `health=${h.ms}ms ok=${h.ok}` +
          (g.lastUploadPhases
            ? ` phases.total=${g.lastUploadPhases.totalMs}ms` +
              (g.lastUploadPhases.skippedUnchanged ? ' skipped' : '')
            : '')
      );
      await sleep(SAMPLE_MS);
    }
  })();

  if (!OBSERVE_ONLY) {
    await sleep(1500);
    // Default dry=1 so local probes without token still measure export cost.
    // Set DRY_UPLOAD=0 to exercise a real GitHub PUT.
    const useDry = process.env.DRY_UPLOAD !== '0';
    const uploadUrl = useDry
      ? `${BASE_URL}/api/site-backup/github/upload?dry=1`
      : `${BASE_URL}/api/site-backup/github/upload`;
    console.log(
      `[github-upload-cost] triggering POST ${uploadUrl.replace(BASE_URL, '')} …`
    );
    const t0 = Date.now();
    uploadResult = await timedFetch(uploadUrl, {
      method: 'POST',
    });
    uploadMs = Date.now() - t0;
    console.log(
      `[github-upload-cost] upload HTTP ${uploadResult.status} in ${uploadMs}ms ` +
        `ok=${uploadResult.ok}` +
        (uploadResult.body && uploadResult.body.dryRun ? ' dryRun' : '') +
        (uploadResult.body && uploadResult.body.skippedUnchanged
          ? ' skippedUnchanged'
          : '') +
        (uploadResult.err ? ` err=${uploadResult.err}` : '')
    );
  }

  await sampler;

  const healthMs = healthSamples.map((s) => s.healthMs).filter((n) => n > 0);
  const peak = healthMs.length ? Math.max(...healthMs) : null;
  const p95 = (() => {
    if (!healthMs.length) return null;
    const sorted = healthMs.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  })();

  const finalStatus = await timedFetch(
    `${BASE_URL}/api/site-backup/github/status`
  );
  const phases =
    (finalStatus.body && finalStatus.body.lastUploadPhases) ||
    (uploadResult && uploadResult.body && uploadResult.body.phases) ||
    null;

  const report = {
    kind: 'github-upload-cost',
    baseUrl: BASE_URL,
    startedAt,
    endedAt: Date.now(),
    observeOnly: OBSERVE_ONLY,
    uploadMs,
    uploadHttpStatus: uploadResult?.status ?? null,
    uploadOk: uploadResult?.ok ?? null,
    uploadBodySummary: uploadResult?.body
      ? {
          skippedUnchanged: Boolean(uploadResult.body.skippedUnchanged),
          coalesced: Boolean(uploadResult.body.coalesced),
          bytes: uploadResult.body.bytes ?? null,
          fileCount: uploadResult.body.fileCount ?? null,
          reason: uploadResult.body.reason ?? null,
        }
      : null,
    phases,
    summary: {
      healthSamples: healthSamples.length,
      healthMsP95: p95,
      peakHealthMs: peak,
      verdict:
        peak != null && peak >= 2000
          ? 'STALL: /health peaked >=2s during window — export still blocking hard'
          : peak != null && peak >= 500
            ? 'SOFT: /health peaked >=500ms — improved but watch phases'
            : 'OK: /health stayed responsive during upload window',
    },
    healthSamples,
  };

  const dataDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const outName = `github-upload-cost-${new Date()
    .toISOString()
    .replace(/[:.]/g, '-')}.json`;
  const outPath = path.join(dataDir, outName);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('[github-upload-cost] ── summary ──');
  console.log(`  health p95=${p95}ms peak=${peak}ms`);
  console.log(`  uploadMs=${uploadMs}`);
  console.log(`  phases=${JSON.stringify(phases)}`);
  console.log(`  verdict: ${report.summary.verdict}`);
  console.log(`[github-upload-cost] wrote ${outPath}`);
}

main().catch((err) => {
  console.error('[github-upload-cost] fatal:', err);
  process.exit(1);
});
