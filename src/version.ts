/**
 * App version + last-updated stamp for the dashboard header.
 * Prefer package.json fields; fall back to git commit date when available.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface AppVersionInfo {
  /** Semver from package.json */
  version: string;
  /** ISO timestamp of last update */
  updatedAt: string;
  /** Compact display e.g. "v1.1.0 · Jul 23" */
  label: string;
  /** Optional short git sha */
  gitSha: string | null;
}

let cached: AppVersionInfo | null = null;

function readPackageJson(): {
  version?: string;
  updatedAt?: string;
  buildUpdatedAt?: string;
} {
  const candidates = [
    path.join(process.cwd(), 'package.json'),
    path.join(__dirname, '..', 'package.json'),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      return JSON.parse(fs.readFileSync(file, 'utf8')) as {
        version?: string;
        updatedAt?: string;
        buildUpdatedAt?: string;
      };
    } catch {
      /* try next */
    }
  }
  return {};
}

function gitValue(args: string): string | null {
  try {
    const out = execSync(`git ${args}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function getAppVersion(): AppVersionInfo {
  if (cached) return cached;

  const pkg = readPackageJson();
  const version = String(pkg.version || '0.0.0');
  const updatedAt =
    process.env.BUILD_UPDATED_AT?.trim() ||
    pkg.updatedAt ||
    pkg.buildUpdatedAt ||
    gitValue('log -1 --format=%cI') ||
    new Date().toISOString();
  const gitSha =
    process.env.RENDER_GIT_COMMIT?.slice(0, 7) ||
    process.env.FLY_ALLOC_ID?.slice(0, 7) ||
    gitValue('rev-parse --short HEAD');

  const label = `v${version} · ${formatShortDate(updatedAt)}${
    gitSha ? ` (${gitSha})` : ''
  }`;

  cached = { version, updatedAt, label, gitSha };
  return cached;
}
