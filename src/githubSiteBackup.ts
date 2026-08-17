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
  createAndSaveSiteBackup,
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
  lastUploadAtMs: number | null;
  lastUploadOk: boolean | null;
  lastUploadError: string | null;
  lastUploadBytes: number | null;
  lastRemoteSha: string | null;
  /**
   * Never auto-restore a remote backup on boot (1.2.21 restore core).
   * Persisted true from later builds is forced off.
   */
  autoImportOnBoot: boolean;
}

export interface GithubBackupStatus {
  configured: boolean;
  tokenConfigured: boolean;
  owner: string | null;
  repo: string | null;
  path: string;
  interval: GithubBackupInterval;
  lastUploadAtMs: number | null;
  lastUploadAt: string | null;
  lastUploadOk: boolean | null;
  lastUploadError: string | null;
  lastUploadBytes: number | null;
  nextDueAtMs: number | null;
  schedulerRunning: boolean;
}

let tickTimer: ReturnType<typeof setInterval> | null = null;
let uploadInFlight = false;

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

function defaultSettings(): GithubBackupSettings {
  return {
    interval: 'none',
    owner: '',
    repo: '',
    path: '',
    lastUploadAtMs: null,
    lastUploadOk: null,
    lastUploadError: null,
    lastUploadBytes: null,
    lastRemoteSha: null,
    autoImportOnBoot: false,
  };
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
    autoImportOnBoot: false,
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

function nextDueAtMs(s: GithubBackupSettings): number | null {
  if (s.interval === 'none') return null;
  const ms = INTERVAL_MS[s.interval];
  if (!s.lastUploadAtMs) return Date.now(); // due ASAP when never uploaded
  return s.lastUploadAtMs + ms;
}

export function getGithubBackupStatus(): GithubBackupStatus {
  const s = loadGithubBackupSettings();
  const target = resolveGithubBackupTarget(s);
  const tokenConfigured = Boolean(target.token);
  const configured = Boolean(
    tokenConfigured && target.owner && target.repo && target.path
  );
  const due = nextDueAtMs(s);
  return {
    configured,
    tokenConfigured,
    owner: target.owner || null,
    repo: target.repo || null,
    path: target.path,
    interval: s.interval,
    lastUploadAtMs: s.lastUploadAtMs,
    lastUploadAt: s.lastUploadAtMs
      ? new Date(s.lastUploadAtMs).toISOString()
      : null,
    lastUploadOk: s.lastUploadOk,
    lastUploadError: s.lastUploadError,
    lastUploadBytes: s.lastUploadBytes,
    nextDueAtMs: configured && s.interval !== 'none' ? due : null,
    schedulerRunning: tickTimer != null,
  };
}

export function updateGithubBackupSettings(partial: {
  interval?: GithubBackupInterval | string;
  owner?: string;
  repo?: string;
  path?: string;
}): GithubBackupStatus {
  const s = loadGithubBackupSettings();
  if (partial.interval != null) {
    s.interval = normalizeInterval(partial.interval);
  }
  if (partial.owner != null) s.owner = String(partial.owner).trim();
  if (partial.repo != null) s.repo = String(partial.repo).trim();
  if (partial.path != null) s.path = String(partial.path).trim();
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
 */
export async function uploadSiteBackupToGithub(opts?: {
  reason?: 'manual' | 'scheduled';
}): Promise<{
  ok: true;
  exportedAt: string;
  fileCount: number;
  bytes: number;
  path: string;
  sha: string;
  reason: string;
}> {
  if (uploadInFlight) {
    throw new Error('GitHub backup upload already in progress');
  }
  uploadInFlight = true;
  const reason = opts?.reason || 'manual';
  try {
    if (reason === 'scheduled') {
      try {
        const { isUpgradeEnabled } =
          require('./upgrades/registry') as typeof import('./upgrades/registry');
        if (isUpgradeEnabled('github_backup_hardening')) {
          const prev = loadGithubBackupSettings().lastUploadAtMs;
          if (prev != null && Date.now() - prev < 60_000) {
            throw new Error(
              'GitHub backup upload skipped — hardening 60s min gap'
            );
          }
        }
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.includes('hardening 60s min gap')
        ) {
          throw err;
        }
      }
    }
    const s = loadGithubBackupSettings();
    const target = resolveGithubBackupTarget(s);
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

    const created = createAndSaveSiteBackup();
    const compact = JSON.stringify(created.backup);
    const bytes = Buffer.byteLength(compact, 'utf8');
    const content = Buffer.from(compact, 'utf8').toString('base64');
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
    const put = await githubApi<{
      content?: { sha?: string };
      message?: string;
    }>('PUT', `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/contents/${enc}`, target.token, {
      // [skip render] / [skip ci] prevent Render (and similar) auto-deploys when
      // backups land in the same repo as the web service.
      message: `[skip render] [skip ci] site-backup ${created.backup.exportedAt} (${reason})`,
      content,
      ...(sha ? { sha } : {}),
    });

    if (!put.ok) {
      throw new Error(
        `GitHub PUT failed (${put.status}): ${
          put.json?.message || put.text.slice(0, 240)
        }`
      );
    }

    const newSha = put.json?.content?.sha || sha || '';
    const next: GithubBackupSettings = {
      ...s,
      lastUploadAtMs: Date.now(),
      lastUploadOk: true,
      lastUploadError: null,
      lastUploadBytes: bytes,
      lastRemoteSha: newSha || null,
    };
    saveGithubBackupSettings(next);

    console.log(
      `[github-backup] uploaded ${target.owner}/${target.repo}/${target.path} ` +
        `(${bytes} bytes, ${created.backup.fileCount} files, ${reason})`
    );

    return {
      ok: true,
      exportedAt: created.backup.exportedAt,
      fileCount: created.backup.fileCount,
      bytes,
      path: target.path,
      sha: newSha,
      reason,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('hardening 60s min gap')) {
      throw err;
    }
    try {
      const s = loadGithubBackupSettings();
      s.lastUploadOk = false;
      s.lastUploadError = msg.slice(0, 400);
      saveGithubBackupSettings(s);
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    uploadInFlight = false;
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

  if (get.json.sha) {
    const next = loadGithubBackupSettings();
    next.lastRemoteSha = get.json.sha;
    saveGithubBackupSettings(next);
  }

  return {
    ok: true,
    written: result.written,
    exportedAt: result.exportedAt,
    fileCount: result.fileCount,
    path: target.path,
  };
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
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('hardening 60s min gap')) return;
    console.warn('[github-backup] scheduled upload failed:', msg);
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

/** Ensure settings file exists (boot). Always persist auto-import OFF. */
export function ensureGithubBackupSettingsFile(): void {
  ensureDataDir();
  const s = loadGithubBackupSettings();
  s.autoImportOnBoot = false;
  saveGithubBackupSettings(s);
}
