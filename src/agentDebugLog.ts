/**
 * Debug-session NDJSON logger (session 8695ba). Remove after diagnosis.
 * Writes workspace + .cursor paths so Cursor can read logs; keeps an in-memory
 * ring for Render (fetch 127.0.0.1 ingest fails remotely — use /api/debug/agent-log).
 */
import fs from 'fs';
import path from 'path';

const SESSION_ID = '8695ba';
const LOG_NAME = `debug-${SESSION_ID}.log`;
const INGEST =
  'http://127.0.0.1:7866/ingest/fc734c21-8b91-4271-9f04-a522317b1ea4';

const RING_MAX = 400;
const ring: string[] = [];

function logPaths(): string[] {
  const cwd = process.cwd();
  const paths = [
    path.join(cwd, LOG_NAME),
    path.join(cwd, '.cursor', LOG_NAME),
  ];
  try {
    const { getDataDir } =
      require('./dataDir') as typeof import('./dataDir');
    const dataPath = path.join(getDataDir(), LOG_NAME);
    if (!paths.includes(dataPath)) paths.push(dataPath);
  } catch {
    /* dataDir may not be ready */
  }
  return paths;
}

function appendLine(line: string): void {
  ring.push(line);
  while (ring.length > RING_MAX) ring.shift();
  for (const p of logPaths()) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, line + '\n');
    } catch {
      /* ignore — ephemeral FS / missing .cursor on Render */
    }
  }
}

export function agentDebugLog(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown> = {}
): void {
  const payload = {
    sessionId: SESSION_ID,
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  };
  const line = JSON.stringify(payload);
  try {
    appendLine(line);
  } catch {
    /* ignore */
  }
  try {
    fetch(INGEST, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Debug-Session-Id': SESSION_ID,
      },
      body: line,
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}

/** Recent NDJSON lines (newest last) for /api/debug/agent-log. */
export function getAgentDebugLogSnapshot(limit = 200): {
  sessionId: string;
  count: number;
  lines: string[];
} {
  const n = Math.max(1, Math.min(RING_MAX, Math.round(limit)));
  const lines = ring.slice(-n);
  return { sessionId: SESSION_ID, count: lines.length, lines };
}
