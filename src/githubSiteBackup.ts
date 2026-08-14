/**
 * Optional GitHub remote for site backups (Contents API).
 * Local Backup Site / Load Last Backup stay unchanged — this is transport only.
 * Token is env-only (GITHUB_BACKUP_TOKEN); never returned to the UI.
 */

import fs from 'fs';
import {
  atomicWriteJson,
  dataFile,
  ensureDataDir,
  readJsonFile,
} from './dataDir';
import {
  buildSiteBackupForGithubUpload,
  isValidSiteBackup,
  restoreSiteBackup,
  saveSiteBackup,
  type SiteBackup,
} from './siteBackup';

export type GithubBackupInterval = 'none' | '1h' | '4h' | '12h' | '24h';

export const GITHUB_BACKUP_INTERVALS: readonly GithubBackupInterval[] = [
  'none',
  '1h',
  '4h',
  '12h',
  '24h',
] as const;

const SETTINGS_FILE = () => dataFile('github-backup-settings.json');
const DEFAULT_REMOTE_PATH = 'site-backups/site-backup-latest.json';
const TICK_MS = 60_000;

const INTERVAL_MS: Record<Exclude<GithubBackupInterval, 'none'>, number> = {
  '1h': 1 * 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

export interface GithubBackupSettings {
  interval: GithubBackupInterval;
  /** Optional overrides; env GITHUB_BACKUP_* wins as default when empty */
  owner: string;
  repo: string;
  path: string;
  /**
   * When true (default if unset), restore from GitHub on boot/restart if remote
   * SHA differs from lastAutoImportSha. Explicit false stays off. Also enabled
   * by GITHUB_BACKUP_AUTO_IMPORT=1|true|yes|on.
   */
  autoImportOnBoot: boolean;
  /** Last successful upload only (not advanced on failure). */
  lastUploadAtMs: number | null;
  lastUploadOk: boolean | null;
  lastUploadError: string | null;
  lastUploadBytes: number | null;
  lastRemoteSha: string | null;
  /** Start of every upload attempt (success or fail) — drives failure backoff. */
  lastUploadAttemptAtMs: number | null;
  /** Consecutive failed uploads since last success. */
  consecutiveFailures: number;
  /** Current failure backoff window in ms (exponential, capped at schedule interval). */
  uploadBackoffMs: number | null;
  /** sha256 of backup.files — skip GitHub PUT when unchanged. */
  lastUploadContentSha: string | null;
  /** Blob SHA of the last successful auto-import (or manual GitHub restore). */
  lastAutoImportSha: string | null;
  lastAutoImportAtMs: number | null;
  lastAutoImportOk: boolean | null;
  lastAutoImportError: string | null;
  lastAutoImportSkippedReason: string | null;
}

export type GithubUploadPhaseTimings = {
  reconcileMs: number;
  buildMs: number;
  writeMs: number;
  encodeMs: number;
  putMs: number;
  totalMs: number;
  skippedUnchanged?: boolean;
  coalesced?: boolean;
  reason: string;
  at: number;
};

export interface GithubBackupStatus {
  configured: boolean;
  tokenConfigured: boolean;
  owner: string | null;
  repo: string | null;
  path: string;
  interval: GithubBackupInterval;
  autoImportOnBoot: boolean;
  /** Effective: setting OR GITHUB_BACKUP_AUTO_IMPORT env */
  autoImportEffective: boolean;
  autoImportEnvOverride: boolean;
  lastUploadAtMs: number | null;
  lastUploadAt: string | null;
  lastUploadOk: boolean | null;
  lastUploadError: string | null;
  lastUploadBytes: number | null;
  lastUploadAttemptAtMs: number | null;
  lastUploadAttemptAt: string | null;
  consecutiveFailures: number;
  uploadBackoffMs: number | null;
  lastUploadContentSha: string | null;
  lastUploadPhases: GithubUploadPhaseTimings | null;
  sameRepoAsDeployHint: boolean;
  lastAutoImportSha: string | null;
  lastAutoImportAtMs: number | null;
  lastAutoImportAt: string | null;
  lastAutoImportOk: boolean | null;
  lastAutoImportError: string | null;
  lastAutoImportSkippedReason: string | null;
  nextDueAtMs: number | null;
  schedulerRunning: boolean;
}

let tickTimer: ReturnType<typeof setInterval> | null = null;
let uploadInFlight = false;
/** When an upload is requested while another runs, coalesce one follow-up. */
let pendingUploadReason: string | null = null;
let autoImportInFlight = false;
/** One-shot: after empty DATA_DIR / bundled seed, do not skip on sha match. */
let forceAutoImportOnce = false;
let forceAutoImportReason: string | null = null;
let criticalUploadTimer: ReturnType<typeof setTimeout> | null = null;
let criticalUploadQueuedReason: string | null = null;
/** Min gap between critical-save uploads — prevents HMC/FPR save storms from stalling the event loop. */
const CRITICAL_UPLOAD_MIN_GAP_MS = 60_000;
/** Defer critical uploads when scheduled tick is due soon. */
const CRITICAL_DEFER_IF_DUE_WITHIN_MS = 15 * 60 * 1000;
/** First failure wait before another full export+PUT (was every 60s forever). */
const FAILURE_BACKOFF_BASE_MS = 5 * 60 * 1000;
let lastCriticalUploadStartedAt = 0;

let lastUploadPhases: GithubUploadPhaseTimings | null = null;

function envToken(): string {
  return String(process.env.GITHUB_BACKUP_TOKEN || '').trim();
}

function envOwner(): string {
  return String(process.env.GITHUB_BACKUP_OWNER || '').trim();
}

function envRepo(): string {
  return String(process.env.GITHUB_BACKUP_REPO || '').trim();
}

function envPath(): string {
  return String(process.env.GITHUB_BACKUP_PATH || '').trim();
}

/** Env force-on for ephemeral DATA_DIR wipe (Render disk missing, etc.). */
export function envGithubBackupAutoImportEnabled(): boolean {
  const v = String(process.env.GITHUB_BACKUP_AUTO_IMPORT || '')
    .trim()
    .toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function defaultSettings(): GithubBackupSettings {
  return {
    interval: 'none',
    owner: '',
    repo: '',
    path: '',
    autoImportOnBoot: true,
    lastUploadAtMs: null,
    lastUploadOk: null,
    lastUploadError: null,
    lastUploadBytes: null,
    lastRemoteSha: null,
    lastUploadAttemptAtMs: null,
    consecutiveFailures: 0,
    uploadBackoffMs: null,
    lastUploadContentSha: null,
    lastAutoImportSha: null,
    lastAutoImportAtMs: null,
    lastAutoImportOk: null,
    lastAutoImportError: null,
    lastAutoImportSkippedReason: null,
  };
}

function isAutoImportEnabled(s: GithubBackupSettings): boolean {
  return s.autoImportOnBoot === true || envGithubBackupAutoImportEnabled();
}

function normalizeInterval(raw: unknown): GithubBackupInterval {
  const s = String(raw || 'none').trim().toLowerCase();
  if (
    s === '1h' ||
    s === '4h' ||
    s === '12h' ||
    s === '24h' ||
    s === 'none'
  ) {
    return s;
  }
  return 'none';
}

function normalizePath(raw: string): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\\/g, '/');
  return cleaned || DEFAULT_REMOTE_PATH;
}

export function loadGithubBackupSettings(): GithubBackupSettings {
  ensureDataDir();
  const raw = readJsonFile<Partial<GithubBackupSettings>>(SETTINGS_FILE());
  const base = defaultSettings();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    interval: normalizeInterval(raw.interval),
    owner: String(raw.owner || '').trim(),
    repo: String(raw.repo || '').trim(),
    path: String(raw.path || '').trim(),
    // Missing/undefined → true (new default); explicit false stays false.
    autoImportOnBoot:
      typeof raw.autoImportOnBoot === 'boolean'
        ? raw.autoImportOnBoot
        : true,
    lastUploadAtMs:
      raw.lastUploadAtMs != null && Number.isFinite(Number(raw.lastUploadAtMs))
        ? Number(raw.lastUploadAtMs)
        : null,
    lastUploadOk:
      typeof raw.lastUploadOk === 'boolean' ? raw.lastUploadOk : null,
    lastUploadError:
      raw.lastUploadError != null ? String(raw.lastUploadError) : null,
    lastUploadBytes:
      raw.lastUploadBytes != null && Number.isFinite(Number(raw.lastUploadBytes))
        ? Number(raw.lastUploadBytes)
        : null,
    lastRemoteSha:
      raw.lastRemoteSha != null ? String(raw.lastRemoteSha) : null,
    lastUploadAttemptAtMs:
      raw.lastUploadAttemptAtMs != null &&
      Number.isFinite(Number(raw.lastUploadAttemptAtMs))
        ? Number(raw.lastUploadAttemptAtMs)
        : null,
    consecutiveFailures:
      raw.consecutiveFailures != null &&
      Number.isFinite(Number(raw.consecutiveFailures))
        ? Math.max(0, Math.round(Number(raw.consecutiveFailures)))
        : 0,
    uploadBackoffMs:
      raw.uploadBackoffMs != null && Number.isFinite(Number(raw.uploadBackoffMs))
        ? Math.max(0, Math.round(Number(raw.uploadBackoffMs)))
        : null,
    lastUploadContentSha:
      raw.lastUploadContentSha != null
        ? String(raw.lastUploadContentSha)
        : null,
    lastAutoImportSha:
      raw.lastAutoImportSha != null ? String(raw.lastAutoImportSha) : null,
    lastAutoImportAtMs:
      raw.lastAutoImportAtMs != null &&
      Number.isFinite(Number(raw.lastAutoImportAtMs))
        ? Number(raw.lastAutoImportAtMs)
        : null,
    lastAutoImportOk:
      typeof raw.lastAutoImportOk === 'boolean' ? raw.lastAutoImportOk : null,
    lastAutoImportError:
      raw.lastAutoImportError != null
        ? String(raw.lastAutoImportError)
        : null,
    lastAutoImportSkippedReason:
      raw.lastAutoImportSkippedReason != null
        ? String(raw.lastAutoImportSkippedReason)
        : null,
  };
}

function saveGithubBackupSettings(s: GithubBackupSettings): void {
  ensureDataDir();
  atomicWriteJson(SETTINGS_FILE(), s);
}

export function resolveGithubBackupTarget(settings?: GithubBackupSettings): {
  owner: string;
  repo: string;
  path: string;
  token: string;
} {
  const s = settings || loadGithubBackupSettings();
  return {
    owner: s.owner || envOwner(),
    repo: s.repo || envRepo(),
    path: normalizePath(s.path || envPath() || DEFAULT_REMOTE_PATH),
    token: envToken(),
  };
}

function scheduleIntervalMs(interval: GithubBackupInterval): number | null {
  if (interval === 'none') return null;
  return INTERVAL_MS[interval];
}

/**
 * Next scheduled upload time.
 * Success → lastUploadAtMs + interval.
 * Sticky failure → lastUploadAttemptAtMs + min(interval, exponential backoff)
 * so failed ticks do not re-run multi-MB export every 60s forever.
 */
function nextDueAtMs(s: GithubBackupSettings): number | null {
  if (s.interval === 'none') return null;
  const scheduleMs = scheduleIntervalMs(s.interval);
  if (scheduleMs == null) return null;

  if (s.lastUploadOk === false && s.lastUploadAttemptAtMs != null) {
    const backoff = Math.max(
      FAILURE_BACKOFF_BASE_MS,
      Number(s.uploadBackoffMs) || FAILURE_BACKOFF_BASE_MS
    );
    return s.lastUploadAttemptAtMs + Math.min(scheduleMs, backoff);
  }

  if (!s.lastUploadAtMs) return Date.now(); // due ASAP when never uploaded
  return s.lastUploadAtMs + scheduleMs;
}

function computeFailureBackoffMs(
  consecutiveFailures: number,
  interval: GithubBackupInterval
): number {
  const scheduleMs = scheduleIntervalMs(interval) ?? FAILURE_BACKOFF_BASE_MS;
  const exp = Math.max(0, consecutiveFailures - 1);
  const raw = FAILURE_BACKOFF_BASE_MS * Math.pow(2, exp);
  return Math.min(scheduleMs, raw);
}

export function getGithubBackupStatus(): GithubBackupStatus {
  const s = loadGithubBackupSettings();
  const target = resolveGithubBackupTarget(s);
  const tokenConfigured = Boolean(target.token);
  const configured = Boolean(
    tokenConfigured && target.owner && target.repo && target.path
  );
  const due = nextDueAtMs(s);
  const envOverride = envGithubBackupAutoImportEnabled();
  return {
    configured,
    tokenConfigured,
    owner: target.owner || null,
    repo: target.repo || null,
    path: target.path,
    interval: s.interval,
    autoImportOnBoot: s.autoImportOnBoot === true,
    autoImportEffective: isAutoImportEnabled(s),
    autoImportEnvOverride: envOverride,
    lastUploadAtMs: s.lastUploadAtMs,
    lastUploadAt: s.lastUploadAtMs
      ? new Date(s.lastUploadAtMs).toISOString()
      : null,
    lastUploadOk: s.lastUploadOk,
    lastUploadError: s.lastUploadError,
    lastUploadBytes: s.lastUploadBytes,
    lastUploadAttemptAtMs: s.lastUploadAttemptAtMs,
    lastUploadAttemptAt: s.lastUploadAttemptAtMs
      ? new Date(s.lastUploadAttemptAtMs).toISOString()
      : null,
    consecutiveFailures: s.consecutiveFailures || 0,
    uploadBackoffMs: s.uploadBackoffMs,
    lastUploadContentSha: s.lastUploadContentSha,
    lastUploadPhases,
    sameRepoAsDeployHint: (() => {
      const repo = (target.repo || '').toLowerCase();
      // Same repo as the live deploy → Render shows Deploy skipped for backup commits.
      return repo === 'crypto-trading-bot' || repo.includes('crypto-trading-bot');
    })(),
    lastAutoImportSha: s.lastAutoImportSha,
    lastAutoImportAtMs: s.lastAutoImportAtMs,
    lastAutoImportAt: s.lastAutoImportAtMs
      ? new Date(s.lastAutoImportAtMs).toISOString()
      : null,
    lastAutoImportOk: s.lastAutoImportOk,
    lastAutoImportError: s.lastAutoImportError,
    lastAutoImportSkippedReason: s.lastAutoImportSkippedReason,
    nextDueAtMs: configured && s.interval !== 'none' ? due : null,
    schedulerRunning: tickTimer != null,
  };
}

export function updateGithubBackupSettings(partial: {
  interval?: GithubBackupInterval | string;
  owner?: string;
  repo?: string;
  path?: string;
  autoImportOnBoot?: boolean;
}): GithubBackupStatus {
  const s = loadGithubBackupSettings();
  if (partial.interval != null) {
    s.interval = normalizeInterval(partial.interval);
  }
  if (partial.owner != null) s.owner = String(partial.owner).trim();
  if (partial.repo != null) s.repo = String(partial.repo).trim();
  if (partial.path != null) s.path = String(partial.path).trim();
  if (partial.autoImportOnBoot != null) {
    s.autoImportOnBoot = partial.autoImportOnBoot === true;
  }
  saveGithubBackupSettings(s);
  return getGithubBackupStatus();
}

async function githubApi<T>(
  method: string,
  urlPath: string,
  token: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; json: T | null; text: string }> {
  const res = await fetch(`https://api.github.com${urlPath}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'crypto-trading-bot-site-backup',
      ...(body != null ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: T | null = null;
  try {
    json = text ? (JSON.parse(text) as T) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

async function fetchRemoteSha(
  owner: string,
  repo: string,
  filePath: string,
  token: string
): Promise<string | null> {
  const enc = filePath
    .split('/')
    .map((p) => encodeURIComponent(p))
    .join('/');
  const r = await githubApi<{ sha?: string; message?: string }>(
    'GET',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${enc}`,
    token
  );
  if (r.status === 404) return null;
  if (!r.ok) {
    throw new Error(
      `GitHub GET contents failed (${r.status}): ${
        (r.json as { message?: string } | null)?.message || r.text.slice(0, 200)
      }`
    );
  }
  return r.json?.sha || null;
}

/**
 * Build local latest backup and push compact JSON to GitHub (overwrite path).
 * Yields during export so /health stays responsive; skips PUT when file payload unchanged.
 */
export async function uploadSiteBackupToGithub(opts?: {
  reason?: string;
  /** Build+write only — skip GitHub network (probe / local cost measure). */
  dryRun?: boolean;
}): Promise<{
  ok: true;
  exportedAt: string;
  fileCount: number;
  bytes: number;
  path: string;
  sha: string;
  reason: string;
  skippedUnchanged?: boolean;
  coalesced?: boolean;
  dryRun?: boolean;
  phases?: GithubUploadPhaseTimings;
}> {
  const reason = opts?.reason || 'manual';
  const dryRun = opts?.dryRun === true;
  if (uploadInFlight) {
    pendingUploadReason = reason;
    console.log(
      `[github-backup] upload coalesced (${reason}) — will run after in-flight`
    );
    lastUploadPhases = {
      reconcileMs: 0,
      buildMs: 0,
      writeMs: 0,
      encodeMs: 0,
      putMs: 0,
      totalMs: 0,
      coalesced: true,
      reason,
      at: Date.now(),
    };
    return {
      ok: true,
      exportedAt: new Date().toISOString(),
      fileCount: 0,
      bytes: 0,
      path: resolveGithubBackupTarget().path,
      sha: '',
      reason,
      coalesced: true,
      phases: lastUploadPhases,
    };
  }
  uploadInFlight = true;
  const totalT0 = Date.now();
  try {
    const s = loadGithubBackupSettings();
    s.lastUploadAttemptAtMs = Date.now();
    saveGithubBackupSettings(s);

    const target = resolveGithubBackupTarget(s);
    if (!dryRun) {
      if (!target.token) {
        throw new Error(
          'GITHUB_BACKUP_TOKEN not set — add a fine-grained PAT with Contents write'
        );
      }
      if (!target.owner || !target.repo) {
        throw new Error(
          'GitHub owner/repo not configured — set GITHUB_BACKUP_OWNER/REPO or save them in Backup settings'
        );
      }
    }

    const exported = await buildSiteBackupForGithubUpload();
    const { backup, compactJson, contentSha256, bytes, phases: exportPhases } =
      exported;

    if (dryRun) {
      const content = Buffer.from(compactJson, 'utf8').toString('base64');
      const phases: GithubUploadPhaseTimings = {
        ...exportPhases,
        encodeMs: exportPhases.encodeMs,
        putMs: 0,
        totalMs: Date.now() - totalT0,
        reason: `dry:${reason}`,
        at: Date.now(),
      };
      // Touch encode cost of base64 without network.
      void content.length;
      lastUploadPhases = phases;
      console.log(
        `[github-backup] dry-run export ok (${bytes} bytes, ${backup.fileCount} files) ` +
          `phases reconcile=${phases.reconcileMs}ms build=${phases.buildMs}ms ` +
          `encode=${phases.encodeMs}ms write=${phases.writeMs}ms total=${phases.totalMs}ms`
      );
      return {
        ok: true,
        exportedAt: backup.exportedAt,
        fileCount: backup.fileCount,
        bytes,
        path: target.path,
        sha: '',
        reason,
        dryRun: true,
        phases,
      };
    }

    // Unchanged DATA_DIR → skip GitHub PUT (still advance lastUploadAtMs).
    if (
      s.lastUploadContentSha &&
      s.lastUploadContentSha === contentSha256 &&
      s.lastRemoteSha
    ) {
      const phases: GithubUploadPhaseTimings = {
        ...exportPhases,
        putMs: 0,
        totalMs: Date.now() - totalT0,
        skippedUnchanged: true,
        reason,
        at: Date.now(),
      };
      lastUploadPhases = phases;
      const next: GithubBackupSettings = {
        ...s,
        lastUploadAtMs: Date.now(),
        lastUploadOk: true,
        lastUploadError: null,
        lastUploadBytes: bytes,
        lastUploadContentSha: contentSha256,
        consecutiveFailures: 0,
        uploadBackoffMs: null,
        // Local state matches what was already pushed — treat as imported.
        lastAutoImportSha: s.lastRemoteSha || s.lastAutoImportSha,
      };
      saveGithubBackupSettings(next);
      console.log(
        `[github-backup] skipped unchanged PUT ` +
          `(${bytes} bytes, ${backup.fileCount} files, ${reason}) ` +
          `phases reconcile=${exportPhases.reconcileMs}ms build=${exportPhases.buildMs}ms ` +
          `encode=${exportPhases.encodeMs}ms write=${exportPhases.writeMs}ms total=${phases.totalMs}ms`
      );
      return {
        ok: true,
        exportedAt: backup.exportedAt,
        fileCount: backup.fileCount,
        bytes,
        path: target.path,
        sha: s.lastRemoteSha || '',
        reason,
        skippedUnchanged: true,
        phases,
      };
    }

    const encodeT0 = Date.now();
    const content = Buffer.from(compactJson, 'utf8').toString('base64');
    const encodeExtraMs = Date.now() - encodeT0;

    const sha = await fetchRemoteSha(
      target.owner,
      target.repo,
      target.path,
      target.token
    );

    const enc = target.path
      .split('/')
      .map((p) => encodeURIComponent(p))
      .join('/');
    const putT0 = Date.now();
    const put = await githubApi<{
      content?: { sha?: string };
      message?: string;
    }>('PUT', `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/contents/${enc}`, target.token, {
      // [skip render] / [skip ci] prevent Render (and similar) auto-deploys when
      // backups land in the same repo as the web service.
      message: `[skip render] [skip ci] site-backup ${backup.exportedAt} (${reason})`,
      content,
      ...(sha ? { sha } : {}),
    });
    const putMs = Date.now() - putT0;

    if (!put.ok) {
      throw new Error(
        `GitHub PUT failed (${put.status}): ${
          put.json?.message || put.text.slice(0, 240)
        }`
      );
    }

    const newSha = put.json?.content?.sha || sha || '';
    const phases: GithubUploadPhaseTimings = {
      reconcileMs: exportPhases.reconcileMs,
      buildMs: exportPhases.buildMs,
      writeMs: exportPhases.writeMs,
      encodeMs: exportPhases.encodeMs + encodeExtraMs,
      putMs,
      totalMs: Date.now() - totalT0,
      reason,
      at: Date.now(),
    };
    lastUploadPhases = phases;

    const next: GithubBackupSettings = {
      ...s,
      lastUploadAtMs: Date.now(),
      lastUploadOk: true,
      lastUploadError: null,
      lastUploadBytes: bytes,
      lastRemoteSha: newSha || null,
      lastUploadContentSha: contentSha256,
      // Local state *is* what was just pushed — boot auto-import should skip.
      lastAutoImportSha: newSha || s.lastAutoImportSha,
      consecutiveFailures: 0,
      uploadBackoffMs: null,
    };
    saveGithubBackupSettings(next);

    console.log(
      `[github-backup] uploaded ${target.owner}/${target.repo}/${target.path} ` +
        `(${bytes} bytes, ${backup.fileCount} files, ${reason}) ` +
        `phases reconcile=${phases.reconcileMs}ms build=${phases.buildMs}ms ` +
        `encode=${phases.encodeMs}ms write=${phases.writeMs}ms put=${phases.putMs}ms total=${phases.totalMs}ms`
    );

    return {
      ok: true,
      exportedAt: backup.exportedAt,
      fileCount: backup.fileCount,
      bytes,
      path: target.path,
      sha: newSha,
      reason,
      phases,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      const s = loadGithubBackupSettings();
      const failures = (s.consecutiveFailures || 0) + 1;
      const backoff = computeFailureBackoffMs(failures, s.interval);
      s.lastUploadOk = false;
      s.lastUploadError = msg.slice(0, 400);
      s.consecutiveFailures = failures;
      s.uploadBackoffMs = backoff;
      if (s.lastUploadAttemptAtMs == null) {
        s.lastUploadAttemptAtMs = Date.now();
      }
      saveGithubBackupSettings(s);
      console.warn(
        `[github-backup] upload failed (failures=${failures}, backoff=${Math.round(backoff / 1000)}s):`,
        msg.slice(0, 200)
      );
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    uploadInFlight = false;
    if (pendingUploadReason) {
      const r = pendingUploadReason;
      pendingUploadReason = null;
      void uploadSiteBackupToGithub({ reason: `coalesced:${r}` }).catch((err) => {
        console.warn(
          '[github-backup] coalesced follow-up failed:',
          err instanceof Error ? err.message : err
        );
      });
    }
  }
}

/**
 * Download latest remote backup and restore into DATA_DIR.
 */
export async function restoreSiteBackupFromGithub(): Promise<{
  ok: true;
  written: string[];
  exportedAt: string;
  fileCount: number;
  path: string;
  sha: string | null;
}> {
  const s = loadGithubBackupSettings();
  const target = resolveGithubBackupTarget(s);
  if (!target.token) {
    throw new Error('GITHUB_BACKUP_TOKEN not set');
  }
  if (!target.owner || !target.repo) {
    throw new Error('GitHub owner/repo not configured');
  }

  const enc = target.path
    .split('/')
    .map((p) => encodeURIComponent(p))
    .join('/');
  const get = await githubApi<{
    content?: string;
    encoding?: string;
    sha?: string;
    message?: string;
    download_url?: string | null;
  }>(
    'GET',
    `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/contents/${enc}`,
    target.token
  );

  if (!get.ok || !get.json) {
    throw new Error(
      get.status === 404
        ? `No backup at ${target.path} on ${target.owner}/${target.repo}`
        : `GitHub GET failed (${get.status}): ${
            get.json?.message || get.text.slice(0, 200)
          }`
    );
  }

  let rawText: string;
  if (get.json.encoding === 'base64' && get.json.content) {
    rawText = Buffer.from(
      get.json.content.replace(/\n/g, ''),
      'base64'
    ).toString('utf8');
  } else if (get.json.download_url) {
    const dl = await fetch(get.json.download_url, {
      headers: {
        Authorization: `Bearer ${target.token}`,
        'User-Agent': 'crypto-trading-bot-site-backup',
      },
    });
    if (!dl.ok) {
      throw new Error(`GitHub download_url failed (${dl.status})`);
    }
    rawText = await dl.text();
  } else {
    throw new Error('GitHub response missing file content');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('Remote file is not valid JSON');
  }
  if (!isValidSiteBackup(parsed)) {
    throw new Error('Remote file is not a valid site-backup (kind/version)');
  }

  const backup = parsed as SiteBackup;
  // Keep a local copy so Load Last Backup works after a GitHub restore
  saveSiteBackup(backup);
  const result = restoreSiteBackup(backup);

  const sha = get.json.sha ? String(get.json.sha) : null;
  const next = loadGithubBackupSettings();
  if (sha) {
    next.lastRemoteSha = sha;
    next.lastAutoImportSha = sha;
  }
  next.lastAutoImportAtMs = Date.now();
  next.lastAutoImportOk = true;
  next.lastAutoImportError = null;
  next.lastAutoImportSkippedReason = null;
  saveGithubBackupSettings(next);

  return {
    ok: true,
    written: result.written,
    exportedAt: result.exportedAt,
    fileCount: result.fileCount,
    path: target.path,
    sha,
  };
}

function recordAutoImportSkip(reason: string): void {
  try {
    const s = loadGithubBackupSettings();
    s.lastAutoImportSkippedReason = reason.slice(0, 200);
    saveGithubBackupSettings(s);
  } catch {
    /* ignore */
  }
}

/**
 * After empty DATA_DIR / bundled seed, force the next boot auto-import to run
 * even if lastAutoImportSha was copied from the restore artifact.
 */
export function markForceGithubAutoImportOnce(reason: string): void {
  forceAutoImportOnce = true;
  forceAutoImportReason = String(reason || 'empty-boot').slice(0, 120);
  console.log(
    `[github-backup] force auto-import once armed (${forceAutoImportReason})`
  );
}

export function consumeForceGithubAutoImportOnce(): {
  force: boolean;
  reason: string | null;
} {
  const force = forceAutoImportOnce;
  const reason = forceAutoImportReason;
  forceAutoImportOnce = false;
  forceAutoImportReason = null;
  return { force, reason };
}

/**
 * Best-effort queue a GitHub backup upload after a critical settings save.
 * Debounced + min gap; failures log only (never throw to callers).
 */
export function queueGithubBackupUploadAfterCriticalSave(reason: string): void {
  criticalUploadQueuedReason = String(reason || 'critical-save').slice(0, 120);
  if (criticalUploadTimer) return;
  const since = Date.now() - lastCriticalUploadStartedAt;
  const delay = Math.max(
    4_000,
    CRITICAL_UPLOAD_MIN_GAP_MS - Math.max(0, since)
  );
  criticalUploadTimer = setTimeout(() => {
    criticalUploadTimer = null;
    const r = criticalUploadQueuedReason || 'critical-save';
    criticalUploadQueuedReason = null;
    void (async () => {
      try {
        const st = getGithubBackupStatus();
        if (!st.configured) {
          console.log(
            `[github-backup] critical-save upload skipped (${r}): not configured`
          );
          return;
        }
        // Defer to scheduler when hourly (etc.) tick is due within 15 minutes.
        if (
          st.interval !== 'none' &&
          st.nextDueAtMs != null &&
          st.nextDueAtMs - Date.now() <= CRITICAL_DEFER_IF_DUE_WITHIN_MS
        ) {
          console.log(
            `[github-backup] critical-save upload deferred (${r}): scheduled due in ` +
              `${Math.max(0, Math.round((st.nextDueAtMs - Date.now()) / 1000))}s`
          );
          return;
        }
        lastCriticalUploadStartedAt = Date.now();
        await uploadSiteBackupToGithub({ reason: `critical:${r}` });
      } catch (err) {
        console.warn(
          `[github-backup] critical-save upload failed (${r}):`,
          err instanceof Error ? err.message : err
        );
      }
    })();
  }, delay);
}

/**
 * Boot/restart auto-import: restore from GitHub when enabled and remote SHA
 * differs from lastAutoImportSha. Never throws — logs and returns.
 * Call AFTER app.listen so the dashboard stays available.
 */
export async function maybeAutoImportGithubBackupOnBoot(): Promise<{
  skipped: boolean;
  reason?: string;
  ok?: boolean;
  sha?: string | null;
  fileCount?: number;
  exportedAt?: string;
  error?: string;
}> {
  if (autoImportInFlight) {
    return { skipped: true, reason: 'in flight' };
  }
  const forced = consumeForceGithubAutoImportOnce();
  const s = loadGithubBackupSettings();
  if (!isAutoImportEnabled(s)) {
    console.log(
      `[github-backup] auto-import skipped: disabled` +
        (forced.force ? ` (force was armed: ${forced.reason})` : '')
    );
    recordAutoImportSkip('disabled');
    return { skipped: true, reason: 'disabled' };
  }
  const target = resolveGithubBackupTarget(s);
  if (!target.token || !target.owner || !target.repo) {
    console.log(
      '[github-backup] auto-import skipped: not fully configured (token/owner/repo)'
    );
    recordAutoImportSkip('not configured');
    return { skipped: true, reason: 'not configured' };
  }

  autoImportInFlight = true;
  const source = envGithubBackupAutoImportEnabled()
    ? s.autoImportOnBoot
      ? 'setting+env'
      : 'env'
    : 'setting';
  try {
    console.log(
      `[github-backup] auto-import checking remote (${source}) · ${target.owner}/${target.repo}/${target.path}` +
        (forced.force
          ? ` · forceOnce=${forced.reason || 'yes'}`
          : '')
    );
    const remoteSha = await fetchRemoteSha(
      target.owner,
      target.repo,
      target.path,
      target.token
    );
    if (!remoteSha) {
      console.log('[github-backup] auto-import skipped: no remote backup file');
      recordAutoImportSkip('no remote file');
      return { skipped: true, reason: 'no remote file' };
    }
    // Prefer dedicated import SHA; do not treat upload-only lastRemoteSha as imported
    // unless we never recorded an import (legacy: allow lastRemoteSha match to skip).
    const lastImported =
      s.lastAutoImportSha ||
      (s.lastAutoImportAtMs != null ? s.lastRemoteSha : null);
    if (lastImported && lastImported === remoteSha && !forced.force) {
      console.log(
        `[github-backup] auto-import skipped: sha unchanged (${remoteSha.slice(0, 7)})`
      );
      recordAutoImportSkip('sha unchanged');
      return { skipped: true, reason: 'sha unchanged', sha: remoteSha };
    }
    if (forced.force && lastImported && lastImported === remoteSha) {
      console.log(
        `[github-backup] auto-import forced despite sha match (${remoteSha.slice(0, 7)}) · ${forced.reason}`
      );
    }

    console.log(
      `[github-backup] auto-import restoring (remote ${remoteSha.slice(0, 7)} ≠ last ${
        lastImported ? lastImported.slice(0, 7) : 'none'
      })…`
    );
    const result = await restoreSiteBackupFromGithub();
    console.log(
      `[github-backup] auto-import ok · ${result.fileCount} files · ${result.exportedAt}` +
        (result.sha ? ` · sha ${result.sha.slice(0, 7)}` : '')
    );
    return {
      skipped: false,
      ok: true,
      sha: result.sha,
      fileCount: result.fileCount,
      exportedAt: result.exportedAt,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[github-backup] auto-import failed:', msg);
    try {
      const next = loadGithubBackupSettings();
      next.lastAutoImportAtMs = Date.now();
      next.lastAutoImportOk = false;
      next.lastAutoImportError = msg.slice(0, 400);
      next.lastAutoImportSkippedReason = null;
      saveGithubBackupSettings(next);
    } catch {
      /* ignore */
    }
    return { skipped: false, ok: false, error: msg };
  } finally {
    autoImportInFlight = false;
  }
}

async function scheduledTick(): Promise<void> {
  const s = loadGithubBackupSettings();
  if (s.interval === 'none') return;
  const target = resolveGithubBackupTarget(s);
  if (!target.token || !target.owner || !target.repo) return;
  const due = nextDueAtMs(s);
  if (due == null || Date.now() < due) return;
  if (uploadInFlight) return;
  try {
    await uploadSiteBackupToGithub({ reason: 'scheduled' });
  } catch (err) {
    console.warn(
      '[github-backup] scheduled upload failed:',
      err instanceof Error ? err.message : err
    );
  }
}

/** Start background interval checker (safe to call multiple times). */
export function startGithubSiteBackupScheduler(): void {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    void scheduledTick();
  }, TICK_MS);
  // Opportunistic first check shortly after boot
  setTimeout(() => {
    void scheduledTick();
  }, 15_000);
  const st = getGithubBackupStatus();
  console.log(
    `[github-backup] scheduler on · interval=${st.interval}` +
      (st.configured
        ? ` · ${st.owner}/${st.repo}/${st.path}`
        : ' · not fully configured')
  );
}

export function stopGithubSiteBackupScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

/** Test helper: interval ms map */
export function githubBackupIntervalMs(
  interval: GithubBackupInterval
): number | null {
  if (interval === 'none') return null;
  return INTERVAL_MS[interval];
}

/** Ensure settings file exists (boot). */
export function ensureGithubBackupSettingsFile(): void {
  ensureDataDir();
  if (!fs.existsSync(SETTINGS_FILE())) {
    saveGithubBackupSettings(defaultSettings());
  }
}
