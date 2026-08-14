/**
 * Boot / spike timeline — proves overlapping callers in the first minutes after deploy.
 */

import fs from 'fs';
import path from 'path';
import { getDataDir } from './dataDir';

export type RpcBootTimelineEvent = {
  at: number;
  uptimeMs: number;
  event: string;
  feature?: string;
  method?: string;
  endpoint?: string;
  ms?: number;
  detail?: string;
};

const RING_MAX = 200;
const ring: RpcBootTimelineEvent[] = [];
const processStartedAt = Date.now();

let ndjsonPath: string | null = null;
let ndjsonFailed = false;

function ensureNdjsonPath(): string | null {
  if (ndjsonFailed) return null;
  if (ndjsonPath) return ndjsonPath;
  try {
    const dir = getDataDir();
    fs.mkdirSync(dir, { recursive: true });
    ndjsonPath = path.join(dir, 'rpc-boot-timeline.ndjson');
    return ndjsonPath;
  } catch {
    ndjsonFailed = true;
    return null;
  }
}

export function noteBootTimeline(opts: {
  event: string;
  feature?: string;
  method?: string;
  endpoint?: string;
  ms?: number;
  detail?: string;
}): void {
  const row: RpcBootTimelineEvent = {
    at: Date.now(),
    uptimeMs: Date.now() - processStartedAt,
    event: opts.event,
    feature: opts.feature,
    method: opts.method,
    endpoint: opts.endpoint,
    ms: opts.ms,
    detail: opts.detail,
  };
  ring.push(row);
  while (ring.length > RING_MAX) ring.shift();

  const p = ensureNdjsonPath();
  if (p) {
    try {
      fs.appendFileSync(p, `${JSON.stringify(row)}\n`, 'utf8');
    } catch {
      /* best-effort */
    }
  }

  if (
    opts.event === 'boot_stage' ||
    (opts.ms != null && opts.ms >= 200) ||
    /poll|probe|mark/i.test(opts.event)
  ) {
    console.log(
      `[boot-timeline] t=${Math.round(row.uptimeMs / 1000)}s ${opts.event}` +
        (opts.feature ? ` feature=${opts.feature}` : '') +
        (opts.method ? ` method=${opts.method}` : '') +
        (opts.ms != null ? ` ms=${opts.ms}` : '') +
        (opts.detail ? ` ${opts.detail}` : '')
    );
  }
}

export function getBootTimelineSnapshot(limit = 80): {
  processStartedAt: number;
  uptimeMs: number;
  recent: RpcBootTimelineEvent[];
} {
  const n = Math.max(1, Math.min(RING_MAX, limit));
  return {
    processStartedAt,
    uptimeMs: Date.now() - processStartedAt,
    recent: ring.slice(-n),
  };
}

export function getProcessUptimeMs(): number {
  return Date.now() - processStartedAt;
}
