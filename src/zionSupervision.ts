/**
 * Zion system supervision — classifies collectSystemHealthIssues() into
 * Normal / Watch / Action needed with sustained escalation, adaptive schedule,
 * rate-limited email. Additive monitoring only — no mutations.
 * DATA_DIR/zion-supervision.json
 */

import fs from 'fs';
import { config } from './config';
import { dataFile, ensureDataDir } from './dataDir';
import { logger } from './logger';
import {
  collectSystemHealthIssues,
  formatHealthIssuesForZion,
  type HealthIssue,
  type HealthSeverity,
} from './systemHealthChecks';

export type ZionSupervisionLevel = 'Normal' | 'Watch' | 'Action needed';

export interface ZionSupervisionIssue {
  key: string;
  summary: string;
  why: string;
  recommendation: string;
  area?: string;
  severity?: HealthSeverity;
}

export interface ZionSupervisionOpenIssue extends ZionSupervisionIssue {
  firstSeenAt: number;
  lastSeenAt: number;
  tickCount: number;
}

export interface ZionSupervisionState {
  version: 2;
  updatedAt: number;
  classification: ZionSupervisionLevel;
  issues: ZionSupervisionIssue[];
  openIssues: ZionSupervisionOpenIssue[];
  resolvedKeys: Array<{ key: string; at: number; summary: string }>;
  lastCheckAt: number;
  nextCheckAt: number;
  lastActionEmailAt: number;
  lastActionEmailKey: string;
  /** Rate-limit Zion chat health nudges (do not spam). */
  lastChatNudgeAt: number;
  lastChatNudgeKey: string;
  checkCount: number;
  actionRechecksLeft: number;
  lastEventCheckAt: number;
}

const FILE = 'zion-supervision.json';
const EMAIL_COOLDOWN_MS = 3 * 60 * 60 * 1000;
/** Chat nudges: same issue ≥90m; different issue ≥45m. Recovery ≥60m. */
const CHAT_NUDGE_SAME_MS = 90 * 60 * 1000;
const CHAT_NUDGE_DIFF_MS = 45 * 60 * 1000;
const CHAT_RECOVERY_MS = 60 * 60 * 1000;
const EVENT_DEBOUNCE_MS = 60_000;
const DEFAULT_HEALTHY_MS = 900_000; // 15m
const DEFAULT_WATCH_MS = 600_000; // 10m
const DEFAULT_ACTION_MS = 300_000; // 5m

let cache: ZionSupervisionState | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function path(): string {
  ensureDataDir();
  return dataFile(FILE);
}

function intervalHealthy(): number {
  return Math.max(
    60_000,
    Number(config.zionAgent?.healthCheckIntervalMsHealthy) || DEFAULT_HEALTHY_MS
  );
}
function intervalWatch(): number {
  return Math.max(
    60_000,
    Number(config.zionAgent?.healthCheckIntervalMsWatch) || DEFAULT_WATCH_MS
  );
}
function intervalAction(): number {
  return Math.max(
    60_000,
    Number(config.zionAgent?.healthCheckIntervalMsAction) || DEFAULT_ACTION_MS
  );
}

function empty(): ZionSupervisionState {
  return {
    version: 2,
    updatedAt: Date.now(),
    classification: 'Normal',
    issues: [],
    openIssues: [],
    resolvedKeys: [],
    lastCheckAt: 0,
    nextCheckAt: 0,
    lastActionEmailAt: 0,
    lastActionEmailKey: '',
    lastChatNudgeAt: 0,
    lastChatNudgeKey: '',
    checkCount: 0,
    actionRechecksLeft: 0,
    lastEventCheckAt: 0,
  };
}

export function loadZionSupervisionState(): ZionSupervisionState {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(path(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<
      Omit<ZionSupervisionState, 'version'>
    > & { version?: number };
    if (parsed && (parsed.version === 1 || parsed.version === 2)) {
      cache = {
        ...empty(),
        ...parsed,
        version: 2,
        openIssues: Array.isArray(parsed.openIssues) ? parsed.openIssues : [],
        resolvedKeys: Array.isArray(parsed.resolvedKeys)
          ? parsed.resolvedKeys
          : [],
      };
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

function toIssue(h: HealthIssue): ZionSupervisionIssue {
  return {
    key: h.key,
    summary: h.title,
    why: h.detail || h.title,
    recommendation: h.recommendation,
    area: h.area,
    severity: h.severity,
  };
}

function classifyOverall(
  open: ZionSupervisionOpenIssue[],
  collected: HealthIssue[]
): ZionSupervisionLevel {
  const byKey = new Map(collected.map((c) => [c.key, c]));
  let hasAction = false;
  let hasWatch = false;
  for (const o of open) {
    const src = byKey.get(o.key);
    const sev = src?.severity || o.severity || 'watch';
    const sustained = (o.tickCount >= 2 || src?.sustainedHint === true) && sev === 'action';
    const hardAction =
      sev === 'action' &&
      (src?.sustainedHint === true ||
        o.key === 'risk_halt' ||
        o.key === 'rpc_multi_lane_down');
    if (hardAction || sustained) hasAction = true;
    else if (sev === 'action' && o.tickCount < 2) hasWatch = true; // first sighting
    else if (sev === 'watch') hasWatch = true;
  }
  if (hasAction) return 'Action needed';
  if (hasWatch || open.length > 0) return 'Watch';
  return 'Normal';
}

function scheduleNext(st: ZionSupervisionState): void {
  let ms = intervalHealthy();
  if (st.classification === 'Action needed' || st.actionRechecksLeft > 0) {
    ms = intervalAction();
  } else if (st.classification === 'Watch') {
    ms = intervalWatch();
  }
  st.nextCheckAt = Date.now() + ms;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    try {
      runZionSupervisionCheck();
    } catch {
      /* */
    }
  }, ms);
}

export function runZionSupervisionCheck(opts?: {
  reason?: 'schedule' | 'event' | 'force';
}): ZionSupervisionState {
  const st = loadZionSupervisionState();
  const now = Date.now();
  st.lastCheckAt = now;
  st.checkCount += 1;

  const collected = collectSystemHealthIssues();
  const collectedKeys = new Set(collected.map((c) => c.key));
  const prevOpen = new Map(st.openIssues.map((o) => [o.key, o]));

  const nextOpen: ZionSupervisionOpenIssue[] = [];
  for (const h of collected) {
    const prev = prevOpen.get(h.key);
    nextOpen.push({
      ...toIssue(h),
      firstSeenAt: prev?.firstSeenAt ?? now,
      lastSeenAt: now,
      tickCount: (prev?.tickCount ?? 0) + 1,
    });
  }

  // Recoveries
  for (const [key, prev] of prevOpen) {
    if (!collectedKeys.has(key)) {
      st.resolvedKeys = [
        { key, at: now, summary: prev.summary },
        ...st.resolvedKeys,
      ].slice(0, 20);
      logger.info('Zion', `Supervision recovered: ${prev.summary}`);
    }
  }

  st.openIssues = nextOpen;
  st.issues = nextOpen.slice(0, 8).map((o) => ({
    key: o.key,
    summary: o.summary,
    why: o.why,
    recommendation: o.recommendation,
    area: o.area,
    severity: o.severity,
  }));

  const classification = classifyOverall(nextOpen, collected);
  const wasAction = st.classification === 'Action needed';
  st.classification = classification;
  if (classification === 'Action needed') {
    st.actionRechecksLeft = 3;
  } else if (st.actionRechecksLeft > 0) {
    st.actionRechecksLeft -= 1;
  }

  scheduleNext(st);
  save(st);

  if (
    classification === 'Action needed' &&
    config.zionAgent?.supervisionEnabled !== false &&
    config.zionAgent?.supervisionEmailEnabled !== false
  ) {
    void maybeSendActionEmail(st);
  }

  if (config.zionAgent?.supervisionEnabled !== false) {
    if (classification === 'Action needed') {
      maybePostSupervisionChatNudge(st);
    } else if (wasAction && classification === 'Normal') {
      maybePostRecoveryChatNudge(st);
    }
  }

  if (st.checkCount % 3 === 0 || classification !== 'Normal' || wasAction) {
    logger.info(
      'Zion',
      `Supervision: ${classification}${st.issues.length ? ` (${st.issues.length} open)` : ''} · next ${Math.round((st.nextCheckAt - now) / 60000)}m` +
        (opts?.reason ? ` · ${opts.reason}` : '')
    );
  }

  return st;
}

/** Debounced event-triggered check (risk halt / quarantine enter). */
export function requestZionSupervisionEventCheck(reason: string): void {
  if (config.zionAgent?.supervisionEnabled === false) return;
  const st = loadZionSupervisionState();
  const now = Date.now();
  if (now - st.lastEventCheckAt < EVENT_DEBOUNCE_MS) return;
  st.lastEventCheckAt = now;
  save(st);
  try {
    runZionSupervisionCheck({ reason: 'event' });
  } catch {
    /* */
  }
  void reason;
}

function pickPrimaryIssue(
  st: ZionSupervisionState
): ZionSupervisionIssue | null {
  return (
    st.openIssues.find(
      (i) =>
        (i.severity === 'action' && (i.tickCount >= 2 || i.key === 'risk_halt')) ||
        i.key === 'rpc_multi_lane_down'
    ) ||
    st.issues[0] ||
    null
  );
}

/** Short chat nudge — never opens UI; dashboard unread/shake picks it up. */
function maybePostSupervisionChatNudge(st: ZionSupervisionState): void {
  const primary = pickPrimaryIssue(st);
  if (!primary) return;
  const now = Date.now();
  const sameKey = st.lastChatNudgeKey === primary.key;
  if (sameKey && now - st.lastChatNudgeAt < CHAT_NUDGE_SAME_MS) return;
  if (!sameKey && now - st.lastChatNudgeAt < CHAT_NUDGE_DIFF_MS) return;

  const fix = String(primary.recommendation || primary.why || '').trim();
  const text = [
    'Heads-up — Action needed',
    '',
    `Problem: ${primary.summary}`,
    fix ? `Fix: ${fix}` : null,
    '',
    '~ Zion',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 900);

  try {
    const { appendZionChat } =
      require('./zionAgentStore') as typeof import('./zionAgentStore');
    appendZionChat('assistant', text);
    st.lastChatNudgeAt = now;
    st.lastChatNudgeKey = primary.key;
    save(st);
    logger.info('Zion', `Supervision chat nudge: ${primary.key}`);
  } catch (err) {
    console.warn(
      '[zion-supervision] chat nudge failed:',
      err instanceof Error ? err.message : err
    );
  }
}

function maybePostRecoveryChatNudge(st: ZionSupervisionState): void {
  const now = Date.now();
  if (now - st.lastChatNudgeAt < CHAT_RECOVERY_MS) return;
  const key = 'recovery_ok';
  if (st.lastChatNudgeKey === key && now - st.lastChatNudgeAt < CHAT_RECOVERY_MS) {
    return;
  }
  const text = [
    'All clear — system health is back to Normal.',
    'No action needed right now.',
    '',
    '~ Zion',
  ].join('\n');
  try {
    const { appendZionChat } =
      require('./zionAgentStore') as typeof import('./zionAgentStore');
    appendZionChat('assistant', text);
    st.lastChatNudgeAt = now;
    st.lastChatNudgeKey = key;
    save(st);
    logger.info('Zion', 'Supervision recovery chat nudge');
  } catch {
    /* fail-open */
  }
}

async function maybeSendActionEmail(st: ZionSupervisionState): Promise<void> {
  // Prefer issues that are sustained Action
  const primary = pickPrimaryIssue(st);
  if (!primary) return;

  const now = Date.now();
  const sameKey = st.lastActionEmailKey === primary.key;
  if (sameKey && now - st.lastActionEmailAt < EMAIL_COOLDOWN_MS) return;
  if (!sameKey && now - st.lastActionEmailAt < EMAIL_COOLDOWN_MS / 2) return;

  try {
    const { sendCustomEmail, resolveOperatorNotifyEmail } =
      require('./emailNotifications') as typeof import('./emailNotifications');
    const to = resolveOperatorNotifyEmail(config.notifications?.email);

    const body = [
      'Hey — Zion here with a system heads-up.',
      '',
      `Problem: ${primary.summary}`,
      '',
      `Why it matters: ${primary.why}`,
      '',
      `Recommended fix: ${primary.recommendation}`,
      '',
      st.issues.length > 1
        ? `Also watching: ${st.issues
            .slice(1, 4)
            .map((i) => i.summary)
            .join('; ')}`
        : '',
      '',
      '— Zion Valton (supervision alert; no changes were made automatically)',
    ]
      .filter(Boolean)
      .join('\n');

    const {
      renderDarkEmail,
      emailCard,
      emailParagraphsFromText,
      emailListItems,
    } = require('./emailTheme') as typeof import('./emailTheme');
    const html = renderDarkEmail({
      eyebrow: 'Zion Supervision',
      title: 'Action needed',
      subtitle: primary.summary.slice(0, 100),
      bodyHtml:
        emailCard({
          title: 'Problem',
          bodyHtml: emailParagraphsFromText(primary.summary),
        }) +
        emailCard({
          title: 'Why it matters',
          bodyHtml: emailParagraphsFromText(primary.why),
        }) +
        emailCard({
          title: 'Recommended fix',
          bodyHtml: emailParagraphsFromText(primary.recommendation),
        }) +
        (st.issues.length > 1
          ? emailCard({
              title: 'Also watching',
              bodyHtml: emailListItems(
                st.issues.slice(1, 4).map((i) => i.summary)
              ),
            })
          : ''),
    });

    const result = await sendCustomEmail({
      to,
      subject: `[Zion] Action needed — ${primary.summary.slice(0, 60)}`,
      text: body,
      html,
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
  openIssues: ZionSupervisionOpenIssue[];
  resolvedKeys: ZionSupervisionState['resolvedKeys'];
  lastCheckAt: number;
  nextCheckAt: number;
  enabled: boolean;
  plainLines: string[];
} {
  const st = loadZionSupervisionState();
  const healthish: HealthIssue[] = st.openIssues.map((o) => ({
    key: o.key,
    area: (o.area as HealthIssue['area']) || 'trading',
    severity: o.severity || 'watch',
    title: o.summary,
    detail: o.why,
    recommendation: o.recommendation,
  }));
  return {
    classification: st.classification,
    issues: st.issues,
    openIssues: st.openIssues,
    resolvedKeys: st.resolvedKeys.slice(0, 8),
    lastCheckAt: st.lastCheckAt,
    nextCheckAt: st.nextCheckAt,
    enabled: config.zionAgent?.supervisionEnabled !== false,
    plainLines: formatHealthIssuesForZion(healthish, st.classification),
  };
}

export function startZionSupervisionScheduler(): void {
  if (timer) return;
  if (config.zionAgent?.supervisionEnabled === false) return;

  setTimeout(() => {
    try {
      runZionSupervisionCheck({ reason: 'schedule' });
    } catch {
      /* */
    }
  }, 12_000);
}

export function stopZionSupervisionScheduler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
