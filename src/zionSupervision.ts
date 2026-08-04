/**
 * Zion system supervision — periodic health classification + Dad-friendly alerts.
 * DATA_DIR/zion-supervision.json
 */

import fs from 'fs';
import { config } from './config';
import { dataFile, ensureDataDir } from './dataDir';
import { logger } from './logger';

export type ZionSupervisionLevel = 'Normal' | 'Watch' | 'Action needed';

export interface ZionSupervisionIssue {
  key: string;
  summary: string;
  why: string;
  recommendation: string;
}

export interface ZionSupervisionState {
  version: 1;
  updatedAt: number;
  classification: ZionSupervisionLevel;
  issues: ZionSupervisionIssue[];
  lastCheckAt: number;
  lastActionEmailAt: number;
  lastActionEmailKey: string;
  checkCount: number;
}

const FILE = 'zion-supervision.json';
const CHECK_MS = 150_000; // ~2.5 min
const EMAIL_COOLDOWN_MS = 3 * 60 * 60 * 1000; // 3 hours between action emails

let cache: ZionSupervisionState | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function path(): string {
  ensureDataDir();
  return dataFile(FILE);
}

function empty(): ZionSupervisionState {
  return {
    version: 1,
    updatedAt: Date.now(),
    classification: 'Normal',
    issues: [],
    lastCheckAt: 0,
    lastActionEmailAt: 0,
    lastActionEmailKey: '',
    checkCount: 0,
  };
}

export function loadZionSupervisionState(): ZionSupervisionState {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(path(), 'utf8');
    const parsed = JSON.parse(raw) as ZionSupervisionState;
    if (parsed?.version === 1) {
      cache = { ...empty(), ...parsed };
      return cache;
    }
  } catch {
    /* */
  }
  cache = empty();
  return cache;
}

function save(state: ZionSupervisionState): void {
  state.updatedAt = Date.now();
  cache = state;
  try {
    fs.writeFileSync(path(), JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn(
      '[zion-supervision] persist failed:',
      err instanceof Error ? err.message : err
    );
  }
}

function isShortLatencySpike(snap: {
  healthy: boolean;
  latencyMs: number | null;
  downForMs: number;
}): boolean {
  if (snap.healthy) return true;
  if (snap.downForMs > 0 && snap.downForMs < 90_000) return true;
  if (snap.latencyMs != null && snap.latencyMs < 800 && snap.downForMs < 60_000) {
    return true;
  }
  return false;
}

export function runZionSupervisionCheck(): ZionSupervisionState {
  const st = loadZionSupervisionState();
  st.lastCheckAt = Date.now();
  st.checkCount += 1;

  const issues: ZionSupervisionIssue[] = [];

  try {
    const { getRpcLoadDiagnostic } =
      require('./rpcDiagnostic') as typeof import('./rpcDiagnostic');
    const rpc = getRpcLoadDiagnostic();
    const lanes = [rpc.primary, rpc.secondary, rpc.utility];
    const badLanes = lanes.filter(
      (l) => !l.healthy && !isShortLatencySpike(l)
    );
    if (badLanes.length >= 2) {
      issues.push({
        key: 'rpc_multi_lane_down',
        summary: `${badLanes.length} RPC lanes unhealthy (sustained)`,
        why: 'Entries, scans, and wallet polls depend on RPC — sustained failures stall the bot.',
        recommendation:
          'Check Config → RPC: verify endpoints, failover, and Poll intervals. Consider pausing entries until primary recovers.',
      });
    } else if (badLanes.length === 1) {
      issues.push({
        key: `rpc_lane_${badLanes[0]!.label}`,
        summary: `RPC lane "${badLanes[0]!.label}" degraded`,
        why: 'One lane down increases load on others and may cause skips or stale quotes.',
        recommendation:
          'Watch the RPC diagnostic card; if it persists >5 min, review endpoint health or enable share-load.',
      });
    }
  } catch {
    /* optional */
  }

  try {
    const { getMonitorStatus } =
      require('./monitor') as typeof import('./monitor');
    const ms = getMonitorStatus();
    if (ms.risk?.halted) {
      issues.push({
        key: 'risk_halt',
        summary: `Risk halt active: ${ms.risk.haltReason || 'unknown'}`,
        why: 'New entries are blocked until the halt clears — protects capital during drawdown or limits.',
        recommendation:
          'Review Overview risk / daily PnL. Clear halt only after you understand the trigger (POST /api/risk/clear-halt).',
      });
    }
    if (ms.paused && !ms.risk?.halted) {
      issues.push({
        key: 'monitor_paused',
        summary: 'Monitor is paused',
        why: 'Wallet polling and new signals are not running.',
        recommendation: 'Resume monitor from the dashboard when you are ready to trade again.',
      });
    }
    const topSkip = ms.skipReasonCounts?.[0];
    if (topSkip && topSkip.count >= 25) {
      issues.push({
        key: `skip_spike_${topSkip.reason.slice(0, 40)}`,
        summary: `High skip volume: ${topSkip.reason} (${topSkip.count})`,
        why: 'Many candidates are failing the same gate — opportunity cost or mis-tuned filters.',
        recommendation:
          'Ask Zion about top skips, or review Learning Mode / Require TA / conviction floors in Config.',
      });
    }
  } catch {
    /* optional */
  }

  try {
    const { getLearningSystemDiagnostics } =
      require('./learningSystemDiagnostics') as typeof import('./learningSystemDiagnostics');
    const diag = getLearningSystemDiagnostics();
    for (const w of diag.warnings || []) {
      const text = String(w || '');
      if (!text) continue;
      issues.push({
        key: `learn_${text.slice(0, 36).replace(/\W+/g, '_')}`,
        summary: `Learning warning: ${text.slice(0, 120)}`,
        why: 'Learning subsystems may be starved, stuck, or rolling back — affects soft policy quality.',
        recommendation:
          'Open Bot Performance / Micro Bots learning cards; consider shadow mode or pausing auto-promote until stable.',
      });
      if (issues.length >= 6) break;
    }
  } catch {
    /* optional */
  }

  let classification: ZionSupervisionLevel = 'Normal';
  const hasAction = issues.some(
    (i) =>
      i.key === 'risk_halt' ||
      i.key === 'rpc_multi_lane_down' ||
      i.key.startsWith('learn_')
  );
  if (hasAction) classification = 'Action needed';
  else if (issues.length > 0) classification = 'Watch';

  st.classification = classification;
  st.issues = issues.slice(0, 8);
  save(st);

  if (
    classification === 'Action needed' &&
    config.zionAgent?.supervisionEnabled !== false &&
    config.zionAgent?.supervisionEmailEnabled !== false
  ) {
    void maybeSendActionEmail(st);
  }

  if (st.checkCount % 5 === 0) {
    logger.info(
      'Zion',
      `Supervision: ${classification}${issues.length ? ` (${issues.length} issue${issues.length === 1 ? '' : 's'})` : ''}`
    );
  }

  return st;
}

async function maybeSendActionEmail(st: ZionSupervisionState): Promise<void> {
  const primary = st.issues[0];
  if (!primary) return;

  const now = Date.now();
  const sameKey = st.lastActionEmailKey === primary.key;
  if (
    sameKey &&
    now - st.lastActionEmailAt < EMAIL_COOLDOWN_MS
  ) {
    return;
  }
  if (!sameKey && now - st.lastActionEmailAt < EMAIL_COOLDOWN_MS / 2) {
    return;
  }

  try {
    const { sendCustomEmail } =
      require('./emailNotifications') as typeof import('./emailNotifications');
    const to =
      String(config.notifications?.email || '').trim() ||
      'bondback2026@gmail.com';

    const body = [
      'Hey Dad — Zion here with a system heads-up.',
      '',
      `**Problem:** ${primary.summary}`,
      '',
      `**Why it matters:** ${primary.why}`,
      '',
      `**Recommended fix:** ${primary.recommendation}`,
      '',
      st.issues.length > 1
        ? `Also watching: ${st.issues.slice(1, 4).map((i) => i.summary).join('; ')}`
        : '',
      '',
      '— Zion Valton (supervision alert; no changes were made automatically)',
    ]
      .filter(Boolean)
      .join('\n');

    const result = await sendCustomEmail({
      to,
      subject: `[Zion] Action needed — ${primary.summary.slice(0, 60)}`,
      text: body,
    });

    if (result.ok) {
      st.lastActionEmailAt = now;
      st.lastActionEmailKey = primary.key;
      save(st);
      logger.info('Zion', `Supervision email sent: ${primary.key}`);
    }
  } catch (err) {
    console.warn(
      '[zion-supervision] email failed:',
      err instanceof Error ? err.message : err
    );
  }
}

export function getZionSupervisionStatus(): {
  classification: ZionSupervisionLevel;
  issues: ZionSupervisionIssue[];
  lastCheckAt: number;
  enabled: boolean;
} {
  const st = loadZionSupervisionState();
  return {
    classification: st.classification,
    issues: st.issues,
    lastCheckAt: st.lastCheckAt,
    enabled: config.zionAgent?.supervisionEnabled !== false,
  };
}

export function startZionSupervisionScheduler(): void {
  if (timer) return;
  if (config.zionAgent?.supervisionEnabled === false) return;

  setTimeout(() => {
    try {
      runZionSupervisionCheck();
    } catch {
      /* */
    }
  }, 8000);

  timer = setInterval(() => {
    try {
      runZionSupervisionCheck();
    } catch {
      /* */
    }
  }, CHECK_MS);
}

export function stopZionSupervisionScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
