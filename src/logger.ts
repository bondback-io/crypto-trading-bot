/**
 * Centralized non-blocking logger — ring buffer + async file append.
 * Use for fetch/RPC debugging with context tags (GMGN, RPC, Jupiter, …).
 */

import fs from 'fs';
import path from 'path';

export type LogLevel = 'info' | 'warn' | 'error';

export type LogContext =
  | 'GMGN'
  | 'RPC'
  | 'Jupiter'
  | 'Jito'
  | 'DexScreener'
  | 'RugCheck'
  | 'Pump'
  | 'MarketData'
  | 'Server'
  | 'Monitor'
  | 'Trade'
  | 'MEV'
  | 'System'
  | string;

export interface LogEntry {
  id: number;
  ts: number;
  level: LogLevel;
  context: string;
  message: string;
  /** Extra fields: status, url, attempt, body snippet, stack, … */
  meta?: Record<string, unknown>;
}

export interface LogQuery {
  level?: LogLevel | 'all';
  context?: string;
  q?: string;
  limit?: number;
}

const MAX_RING = 200;
const MAX_BODY = 400;
const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');

const ring: LogEntry[] = [];
let nextId = 1;
let writeChain: Promise<void> = Promise.resolve();
let dirReady = false;

function ensureLogDir(): void {
  if (dirReady) return;
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    dirReady = true;
  } catch {
    // ignore — console still works
  }
}

function serializeMeta(meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) return '';
  try {
    return ' ' + JSON.stringify(meta);
  } catch {
    return ' [meta:unserializable]';
  }
}

function formatLine(entry: LogEntry): string {
  const iso = new Date(entry.ts).toISOString();
  return `${iso} [${entry.level.toUpperCase()}] [${entry.context}] ${entry.message}${serializeMeta(entry.meta)}\n`;
}

function enqueueFileWrite(line: string): void {
  writeChain = writeChain
    .then(() => {
      ensureLogDir();
      return new Promise<void>((resolve) => {
        fs.appendFile(LOG_FILE, line, (err) => {
          if (err) {
            // Avoid recursive logging loops
            try {
              console.error('[logger] Failed to write app.log:', err.message);
            } catch {
              /* ignore */
            }
          }
          resolve();
        });
      });
    })
    .catch(() => {
      /* keep chain alive */
    });
}

function consoleMirror(entry: LogEntry): void {
  const prefix = `[${entry.context}] ${entry.message}`;
  const extra = entry.meta ? entry.meta : undefined;
  if (entry.level === 'error') {
    if (extra) console.error(prefix, extra);
    else console.error(prefix);
  } else if (entry.level === 'warn') {
    if (extra) console.warn(prefix, extra);
    else console.warn(prefix);
  } else {
    if (extra) console.log(prefix, extra);
    else console.log(prefix);
  }
}

function push(
  level: LogLevel,
  context: LogContext,
  message: string,
  meta?: Record<string, unknown>
): LogEntry {
  const entry: LogEntry = {
    id: nextId++,
    ts: Date.now(),
    level,
    context: String(context),
    message,
    meta: meta && Object.keys(meta).length ? sanitizeMeta(meta) : undefined,
  };

  ring.push(entry);
  while (ring.length > MAX_RING) ring.shift();

  // Non-blocking: mirror + queue disk write without awaiting
  try {
    consoleMirror(entry);
  } catch {
    /* ignore */
  }
  enqueueFileWrite(formatLine(entry));
  return entry;
}

function sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v == null) continue;
    if (typeof v === 'string') {
      out[k] = v.length > MAX_BODY ? v.slice(0, MAX_BODY) + '…' : v;
    } else if (v instanceof Error) {
      out[k] = {
        name: v.name,
        message: v.message,
        stack: v.stack?.split('\n').slice(0, 6).join('\n'),
      };
    } else if (typeof v === 'object') {
      try {
        const s = JSON.stringify(v);
        out[k] = s.length > MAX_BODY ? s.slice(0, MAX_BODY) + '…' : v;
      } catch {
        out[k] = String(v);
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Normalize unknown thrown values for logging */
export function errorToMeta(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      errorName: err.name,
      errorMessage: err.message,
      stack: err.stack?.split('\n').slice(0, 8).join('\n'),
    };
  }
  return { error: String(err) };
}

export const logger = {
  info(context: LogContext, message: string, meta?: Record<string, unknown>) {
    return push('info', context, message, meta);
  },
  warn(context: LogContext, message: string, meta?: Record<string, unknown>) {
    return push('warn', context, message, meta);
  },
  error(context: LogContext, message: string, meta?: Record<string, unknown>) {
    return push('error', context, message, meta);
  },

  /** Query recent in-memory entries (newest last; returned newest-first) */
  query(options: LogQuery = {}): LogEntry[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), MAX_RING);
    const level = options.level ?? 'all';
    const ctx = (options.context ?? '').trim().toLowerCase();
    const q = (options.q ?? '').trim().toLowerCase();

    let list = ring.slice();
    if (level !== 'all') {
      list = list.filter((e) => e.level === level);
    }
    if (ctx) {
      list = list.filter((e) => e.context.toLowerCase().includes(ctx));
    }
    if (q) {
      list = list.filter((e) => {
        const hay = `${e.message} ${JSON.stringify(e.meta ?? {})}`.toLowerCase();
        return hay.includes(q);
      });
    }
    return list.slice(-limit).reverse();
  },

  getRecentErrors(limit = 100): LogEntry[] {
    return this.query({ level: 'error', limit });
  },

  getStats(): {
    total: number;
    errors: number;
    warnings: number;
    logFile: string;
  } {
    return {
      total: ring.length,
      errors: ring.filter((e) => e.level === 'error').length,
      warnings: ring.filter((e) => e.level === 'warn').length,
      logFile: LOG_FILE,
    };
  },

  clear(): void {
    ring.length = 0;
  },
};

export interface LoggedFetchOptions extends RequestInit {
  /** Log context tag */
  context: LogContext;
  /** Human label for this call */
  label?: string;
  timeoutMs?: number;
  attempt?: number;
  maxAttempts?: number;
  /** Log response body snippet on non-OK (default true for errors) */
  logBodyOnError?: boolean;
}

/**
 * fetch() wrapper with structured before/after/error logging.
 * Non-throwing helper for callers that prefer null on failure — use loggedFetchThrow for throw.
 */
export async function loggedFetch(
  url: string,
  options: LoggedFetchOptions
): Promise<Response> {
  const {
    context,
    label,
    timeoutMs,
    attempt,
    maxAttempts,
    logBodyOnError = true,
    ...init
  } = options;

  const tag = label ?? 'request';
  const metaBase: Record<string, unknown> = {
    url: url.slice(0, 180),
    method: (init.method ?? 'GET').toUpperCase(),
  };
  if (attempt != null) metaBase.attempt = attempt;
  if (maxAttempts != null) metaBase.maxAttempts = maxAttempts;

  logger.info(context, `${tag} →`, metaBase);

  const signal =
    init.signal ??
    (timeoutMs != null ? AbortSignal.timeout(timeoutMs) : undefined);

  try {
    const res = await fetch(url, { ...init, signal });
    const okMeta: Record<string, unknown> = {
      ...metaBase,
      status: res.status,
      ok: res.ok,
    };

    if (!res.ok) {
      let body: string | undefined;
      if (logBodyOnError) {
        try {
          body = (await res.clone().text()).slice(0, MAX_BODY);
        } catch {
          body = undefined;
        }
      }
      logger.warn(context, `${tag} ← HTTP ${res.status}`, {
        ...okMeta,
        body,
      });
    } else {
      logger.info(context, `${tag} ← ${res.status}`, okMeta);
    }
    return res;
  } catch (err) {
    logger.error(context, `${tag} failed`, {
      ...metaBase,
      ...errorToMeta(err),
    });
    throw err;
  }
}

/** Convenience: JSON GET/POST with retries + logging */
export async function loggedFetchJson<T = unknown>(
  url: string,
  options: LoggedFetchOptions & { maxAttempts?: number } = {
    context: 'System',
  }
): Promise<{ ok: true; data: T; status: number } | { ok: false; error: string; status: number }> {
  const maxAttempts = options.maxAttempts ?? 1;
  let lastError = 'Unknown error';
  let lastStatus = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await loggedFetch(url, {
        ...options,
        attempt,
        maxAttempts,
      });
      lastStatus = res.status;
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        if (attempt < maxAttempts) continue;
        return { ok: false, error: lastError, status: lastStatus };
      }
      const data = (await res.json()) as T;
      return { ok: true, data, status: res.status };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < maxAttempts) {
        logger.warn(options.context, `retry ${attempt}/${maxAttempts}`, {
          url: url.slice(0, 120),
          error: lastError,
        });
        await new Promise((r) => setTimeout(r, 200 * attempt));
        continue;
      }
    }
  }

  return { ok: false, error: lastError, status: lastStatus };
}

export default logger;
