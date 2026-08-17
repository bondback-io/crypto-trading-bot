/**
 * Scheduled micro-bot performance digest email (Back Ups tab).
 * Default: daily at 7pm Australia/Brisbane → bondback2026@gmail.com
 */

import {
  atomicWriteJson,
  dataFile,
  ensureDataDir,
  readJsonFile,
} from './dataDir';
import { logger, errorToMeta } from './logger';
import { getProfileLearningEpisodes } from './profileLearningEpisodes';
import { getAppVersion } from './version';

export type BotPerfEmailInterval = '1h' | '6h' | '12h' | '24h';

export const BOT_PERF_EMAIL_INTERVALS: readonly BotPerfEmailInterval[] = [
  '1h',
  '6h',
  '12h',
  '24h',
] as const;

const DEFAULT_EMAIL = 'bondback2026@gmail.com';
const TIMEZONE = 'Australia/Brisbane';
const DEFAULT_SEND_HOUR = 19;
const SETTINGS_FILE = () => dataFile('bot-performance-email-settings.json');
const TICK_MS = 60_000;

const INTERVAL_MS: Record<BotPerfEmailInterval, number> = {
  '1h': 1 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

export interface BotPerfSnapshotRow {
  profileId: string;
  periodExpectancyPct: number;
  periodPnlSol: number;
  periodWinRatePct: number;
  overallPnlSol: number;
}

export interface BotPerfEmailSettings {
  enabled: boolean;
  interval: BotPerfEmailInterval;
  email: string;
  /** Local hour in Australia/Brisbane (default 19 = 7pm QLD) */
  sendHour: number;
  lastSentAtMs: number | null;
  lastSentOk: boolean | null;
  lastSentError: string | null;
  lastPeriodStartMs: number | null;
  previousSnapshot: BotPerfSnapshotRow[] | null;
}

export interface BotPerfEmailStatus {
  enabled: boolean;
  interval: BotPerfEmailInterval;
  email: string;
  sendHour: number;
  timezone: string;
  emailDeliveryConfigured: boolean;
  lastSentAtMs: number | null;
  lastSentAt: string | null;
  lastSentOk: boolean | null;
  lastSentError: string | null;
  nextDueAtMs: number | null;
  nextDueAt: string | null;
  nextDueLabel: string | null;
  schedulerRunning: boolean;
}

interface PeriodStats {
  episodes: number;
  wins: number;
  losses: number;
  pnlSol: number;
  avgPnlPct: number;
  winRatePct: number;
}

export interface BotPerfReportRow {
  profileId: string;
  name: string;
  enabled: boolean;
  learningEnabled: boolean;
  level: number;
  mode: string;
  mlMode: string;
  period: PeriodStats;
  overall: PeriodStats;
  overallExpectancyPct: number;
  improvementVsBaselinePct: number | null;
  pctChangeSinceLastReport: number | null;
  rankOverall: number;
  improved: string;
  needsWork: string;
  lastUpgradeSummary: string | null;
}

export interface BotPerfReport {
  generatedAt: number;
  periodStartMs: number;
  periodEndMs: number;
  periodLabel: string;
  timezone: string;
  bots: BotPerfReportRow[];
  totals: {
    periodEpisodes: number;
    periodWins: number;
    periodLosses: number;
    periodPnlSol: number;
    overallPnlSol: number;
  };
  text: string;
}

let settingsCache: BotPerfEmailSettings | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let sendInFlight = false;

function defaultSettings(): BotPerfEmailSettings {
  return {
    enabled: false,
    interval: '24h',
    email: DEFAULT_EMAIL,
    sendHour: DEFAULT_SEND_HOUR,
    lastSentAtMs: null,
    lastSentOk: null,
    lastSentError: null,
    lastPeriodStartMs: null,
    previousSnapshot: null,
  };
}

function clampHour(h: number): number {
  if (!Number.isFinite(h)) return DEFAULT_SEND_HOUR;
  return Math.max(0, Math.min(23, Math.round(h)));
}

function normalizeSettings(raw: Partial<BotPerfEmailSettings> | null | undefined): BotPerfEmailSettings {
  const d = defaultSettings();
  if (!raw || typeof raw !== 'object') return d;
  const interval = BOT_PERF_EMAIL_INTERVALS.includes(
    raw.interval as BotPerfEmailInterval
  )
    ? (raw.interval as BotPerfEmailInterval)
    : d.interval;
  const email = String(raw.email || '').trim() || DEFAULT_EMAIL;
  return {
    enabled: raw.enabled === true,
    interval,
    email,
    sendHour: clampHour(
      raw.sendHour != null ? Number(raw.sendHour) : DEFAULT_SEND_HOUR
    ),
    lastSentAtMs:
      raw.lastSentAtMs != null && Number.isFinite(Number(raw.lastSentAtMs))
        ? Number(raw.lastSentAtMs)
        : null,
    lastSentOk: typeof raw.lastSentOk === 'boolean' ? raw.lastSentOk : null,
    lastSentError:
      raw.lastSentError != null ? String(raw.lastSentError).slice(0, 400) : null,
    lastPeriodStartMs:
      raw.lastPeriodStartMs != null &&
      Number.isFinite(Number(raw.lastPeriodStartMs))
        ? Number(raw.lastPeriodStartMs)
        : null,
    previousSnapshot: Array.isArray(raw.previousSnapshot)
      ? raw.previousSnapshot
      : null,
  };
}

function loadSettings(): BotPerfEmailSettings {
  if (settingsCache) return settingsCache;
  try {
    const raw = readJsonFile<Partial<BotPerfEmailSettings>>(SETTINGS_FILE());
    settingsCache = normalizeSettings(raw);
  } catch {
    settingsCache = defaultSettings();
  }
  return settingsCache;
}

function saveSettings(next: BotPerfEmailSettings): void {
  ensureDataDir();
  settingsCache = normalizeSettings(next);
  atomicWriteJson(SETTINGS_FILE(), settingsCache);
}

export function ensureBotPerfEmailSettingsFile(): void {
  ensureDataDir();
  const fs = require('fs') as typeof import('fs');
  if (!fs.existsSync(SETTINGS_FILE())) {
    saveSettings(defaultSettings());
  } else {
    loadSettings();
  }
}

function brisbaneParts(ms: number): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type: string): number => {
    const v = parts.find((p) => p.type === type)?.value;
    return Number(v) || 0;
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') === 24 ? 0 : get('hour'),
    minute: get('minute'),
  };
}

/** Find next timestamp where Brisbane local clock is sendHour:00 (or soon after). */
function nextBrisbaneSendMs(fromMs: number, sendHour: number): number {
  const hour = clampHour(sendHour);
  // Search forward up to 48h in 1-minute steps from the next minute
  const start = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  for (let t = start; t < fromMs + 50 * 60 * 60 * 1000; t += 60_000) {
    const p = brisbaneParts(t);
    if (p.hour === hour && p.minute === 0) return t;
  }
  return fromMs + INTERVAL_MS['24h'];
}

function isPastTodaysSendWindow(nowMs: number, sendHour: number): boolean {
  const p = brisbaneParts(nowMs);
  return p.hour > sendHour || (p.hour === sendHour && p.minute >= 0);
}

export function botPerfEmailIntervalMs(interval: BotPerfEmailInterval): number {
  return INTERVAL_MS[interval];
}

export function computeNextDueAtMs(
  settings: BotPerfEmailSettings,
  nowMs = Date.now()
): number | null {
  if (!settings.enabled) return null;
  const intervalMs = INTERVAL_MS[settings.interval];
  if (settings.lastSentAtMs != null) {
    return settings.lastSentAtMs + intervalMs;
  }
  if (isPastTodaysSendWindow(nowMs, settings.sendHour)) {
    return nowMs;
  }
  return nextBrisbaneSendMs(nowMs, settings.sendHour);
}

function fmtSol(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(4)} SOL`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function periodStatsFromEpisodes(
  episodes: { pnlPct: number; pnlSol: number }[]
): PeriodStats {
  if (!episodes.length) {
    return {
      episodes: 0,
      wins: 0,
      losses: 0,
      pnlSol: 0,
      avgPnlPct: 0,
      winRatePct: 0,
    };
  }
  let wins = 0;
  let losses = 0;
  let pnlSol = 0;
  let sumPct = 0;
  for (const e of episodes) {
    const pct = Number(e.pnlPct) || 0;
    const sol = Number(e.pnlSol) || 0;
    sumPct += pct;
    pnlSol += sol;
    if (pct > 0) wins += 1;
    else losses += 1;
  }
  return {
    episodes: episodes.length,
    wins,
    losses,
    pnlSol,
    avgPnlPct: sumPct / episodes.length,
    winRatePct: (wins / episodes.length) * 100,
  };
}

function plainImproved(input: {
  period: PeriodStats;
  overall: PeriodStats;
  improvementVsBaselinePct: number | null;
  lastMutationSummary?: string | null;
  lastUpgradeSummary?: string | null;
  learningEnabled: boolean;
}): string {
  const bits: string[] = [];
  if (
    input.improvementVsBaselinePct != null &&
    input.improvementVsBaselinePct >= 5
  ) {
    bits.push(
      `learning is about ${fmtPct(input.improvementVsBaselinePct)} better than when it started`
    );
  }
  if (
    input.period.episodes >= 3 &&
    input.period.winRatePct >= input.overall.winRatePct + 5
  ) {
    bits.push('win rate this period is stronger than its long-run average');
  }
  if (input.period.episodes >= 2 && input.period.pnlSol > 0) {
    bits.push('made a profit this period');
  }
  if (input.lastUpgradeSummary && String(input.lastUpgradeSummary).trim()) {
    bits.push(`recent upgrade: ${String(input.lastUpgradeSummary).trim()}`);
  } else if (
    input.lastMutationSummary &&
    String(input.lastMutationSummary).trim()
  ) {
    bits.push(`recent tweak: ${String(input.lastMutationSummary).trim()}`);
  }
  if (!input.learningEnabled) {
    return 'Learning is off for this bot — enable it if you want it to improve.';
  }
  if (!bits.length) {
    if (input.period.episodes === 0) return 'Quiet period — no closed trades yet.';
    return 'Holding steady — no big standout improvements this period.';
  }
  return bits.slice(0, 3).join('; ') + '.';
}

function plainNeedsWork(input: {
  period: PeriodStats;
  overall: PeriodStats;
  nearMissHint?: string | null;
  pendingSummary?: string | null;
  learningEnabled: boolean;
  episodeGoalPct: number;
}): string {
  const bits: string[] = [];
  if (!input.learningEnabled) {
    bits.push('turn learning on so the bot can adjust');
  }
  if (input.period.episodes >= 3 && input.period.pnlSol < 0) {
    bits.push('lost money this period — exits or entries may need tightening');
  }
  if (
    input.period.episodes >= 4 &&
    input.period.winRatePct + 8 < input.overall.winRatePct
  ) {
    bits.push('win rate dipped vs its usual level');
  }
  if (input.period.losses > input.period.wins && input.period.episodes >= 3) {
    bits.push('more losses than wins lately');
  }
  if (input.nearMissHint && String(input.nearMissHint).trim()) {
    bits.push(`almost ready to upgrade: ${String(input.nearMissHint).trim()}`);
  }
  if (input.pendingSummary && String(input.pendingSummary).trim()) {
    bits.push(`idea waiting: ${String(input.pendingSummary).trim()}`);
  }
  if (input.episodeGoalPct < 25 && input.overall.episodes < 40) {
    bits.push('still early — needs more trades before big conclusions');
  }
  if (!bits.length) {
    return 'Nothing urgent — keep watching size and risk.';
  }
  return bits.slice(0, 3).join('; ') + '.';
}

export function buildBotPerformanceReport(opts?: {
  periodStartMs?: number;
  periodEndMs?: number;
  previousSnapshot?: BotPerfSnapshotRow[] | null;
}): BotPerfReport {
  const periodEndMs = opts?.periodEndMs ?? Date.now();
  const settings = loadSettings();
  const intervalMs = INTERVAL_MS[settings.interval];
  const periodStartMs =
    opts?.periodStartMs ??
    settings.lastSentAtMs ??
    periodEndMs - intervalMs;
  const prevMap = new Map<string, BotPerfSnapshotRow>();
  for (const row of opts?.previousSnapshot ?? settings.previousSnapshot ?? []) {
    if (row?.profileId) prevMap.set(row.profileId, row);
  }

  const { getTradeProfilesStatus } =
    require('./tradeProfiles') as typeof import('./tradeProfiles');
  const status = getTradeProfilesStatus();

  const bots: BotPerfReportRow[] = [];
  for (const p of status.profiles) {
    const allEps = getProfileLearningEpisodes(p.id, 400);
    const periodEps = allEps.filter(
      (e) => e.closedAt >= periodStartMs && e.closedAt <= periodEndMs
    );
    const period = periodStatsFromEpisodes(periodEps);
    const overall = periodStatsFromEpisodes(allEps);
    const sl = p.selfLearning;
    const lp = p.learningProgress;
    const prev = prevMap.get(p.id);
    let pctChangeSinceLastReport: number | null = null;
    if (prev && Number.isFinite(prev.periodExpectancyPct) && period.episodes > 0) {
      pctChangeSinceLastReport =
        period.avgPnlPct - Number(prev.periodExpectancyPct);
    }

    const lastUpgrade = (lp.upgrades || []).length
      ? lp.upgrades[lp.upgrades.length - 1]
      : null;

    bots.push({
      profileId: p.id,
      name: p.name,
      enabled: p.enabled,
      learningEnabled: sl.enabled === true,
      level: lp.level ?? sl.version ?? 0,
      mode: String(sl.mode || 'shadow'),
      mlMode: String(sl.mlMode || 'off'),
      period,
      overall,
      overallExpectancyPct: Number(sl.currentExpectancyPct) || overall.avgPnlPct,
      improvementVsBaselinePct:
        sl.baselineExpectancyPct != null
          ? Number(sl.improvementPct) || 0
          : null,
      pctChangeSinceLastReport,
      rankOverall: 0,
      improved: '',
      needsWork: '',
      lastUpgradeSummary: lastUpgrade?.summary || sl.lastMutation?.summary || null,
    });
  }

  // Rank by lifetime SOL profit (then expectancy, then episodes)
  const ranked = [...bots].sort((a, b) => {
    if (b.overall.pnlSol !== a.overall.pnlSol) {
      return b.overall.pnlSol - a.overall.pnlSol;
    }
    if (b.overallExpectancyPct !== a.overallExpectancyPct) {
      return b.overallExpectancyPct - a.overallExpectancyPct;
    }
    return b.overall.episodes - a.overall.episodes;
  });
  ranked.forEach((row, i) => {
    row.rankOverall = i + 1;
  });
  const rankMap = new Map(ranked.map((r) => [r.profileId, r.rankOverall]));

  for (const row of bots) {
    row.rankOverall = rankMap.get(row.profileId) || bots.length;
    const p = status.profiles.find((x) => x.id === row.profileId);
    const sl = p?.selfLearning;
    const lp = p?.learningProgress;
    row.improved = plainImproved({
      period: row.period,
      overall: row.overall,
      improvementVsBaselinePct: row.improvementVsBaselinePct,
      lastMutationSummary: sl?.lastMutation?.summary,
      lastUpgradeSummary: row.lastUpgradeSummary,
      learningEnabled: row.learningEnabled,
    });
    row.needsWork = plainNeedsWork({
      period: row.period,
      overall: row.overall,
      nearMissHint: sl?.nearMiss?.patternHint || sl?.nearMiss?.summary,
      pendingSummary: sl?.pendingProposal?.summary,
      learningEnabled: row.learningEnabled,
      episodeGoalPct: lp?.pct ?? 0,
    });
  }

  // Sort report by rank for reading
  bots.sort((a, b) => a.rankOverall - b.rankOverall);

  const totals = {
    periodEpisodes: bots.reduce((s, b) => s + b.period.episodes, 0),
    periodWins: bots.reduce((s, b) => s + b.period.wins, 0),
    periodLosses: bots.reduce((s, b) => s + b.period.losses, 0),
    periodPnlSol: bots.reduce((s, b) => s + b.period.pnlSol, 0),
    overallPnlSol: bots.reduce((s, b) => s + b.overall.pnlSol, 0),
  };

  const startLabel = new Date(periodStartMs).toLocaleString('en-AU', {
    timeZone: TIMEZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const endLabel = new Date(periodEndMs).toLocaleString('en-AU', {
    timeZone: TIMEZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const periodLabel = `${startLabel} → ${endLabel} (${TIMEZONE})`;

  const ver = getAppVersion();
  const lines: string[] = [];
  lines.push('BondBack · Micro-bot performance digest');
  lines.push(`App ${ver.label || ver.version}`);
  lines.push(`Period: ${periodLabel}`);
  lines.push('');
  lines.push('—— Overview ——');
  lines.push(
    `This period: ${totals.periodEpisodes} trades · ${totals.periodWins}W / ${totals.periodLosses}L · ${fmtSol(totals.periodPnlSol)}`
  );
  lines.push(`All-time bot PnL (sum): ${fmtSol(totals.overallPnlSol)}`);
  lines.push('');

  for (const b of bots) {
    lines.push(`#${b.rankOverall}  ${b.name}${b.enabled ? '' : ' (disabled)'}`);
    lines.push(
      `  Level ${b.level} · Learning ${b.learningEnabled ? 'ON' : 'OFF'} (${b.mode} / ML ${b.mlMode})`
    );
    lines.push(
      `  This period: ${b.period.episodes} trades · ${b.period.wins}W / ${b.period.losses}L · ${fmtSol(b.period.pnlSol)} · avg ${fmtPct(b.period.avgPnlPct)} · WR ${b.period.winRatePct.toFixed(0)}%`
    );
    lines.push(
      `  Overall: ${b.overall.episodes} trades · ${b.overall.wins}W / ${b.overall.losses}L · ${fmtSol(b.overall.pnlSol)} · expectancy ${fmtPct(b.overallExpectancyPct)}`
    );
    lines.push(
      `  vs baseline: ${fmtPct(b.improvementVsBaselinePct)} · vs last report: ${fmtPct(b.pctChangeSinceLastReport)}`
    );
    lines.push(`  Improved: ${b.improved}`);
    lines.push(`  Needs work: ${b.needsWork}`);
    lines.push('');
  }

  lines.push('—— Notes ——');
  lines.push(
    'Ranks use lifetime SOL profit from learning episodes. “vs last report” compares average trade % this period vs the previous email’s period.'
  );
  lines.push(
    'Manage this digest in Dashboard → Back Ups → Bot performance email.'
  );
  lines.push(`Generated ${new Date(periodEndMs).toISOString()}`);

  return {
    generatedAt: periodEndMs,
    periodStartMs,
    periodEndMs,
    periodLabel,
    timezone: TIMEZONE,
    bots,
    totals,
    text: lines.join('\n'),
  };
}

function snapshotFromReport(report: BotPerfReport): BotPerfSnapshotRow[] {
  return report.bots.map((b) => ({
    profileId: b.profileId,
    periodExpectancyPct: b.period.avgPnlPct,
    periodPnlSol: b.period.pnlSol,
    periodWinRatePct: b.period.winRatePct,
    overallPnlSol: b.overall.pnlSol,
  }));
}

export function getBotPerfEmailStatus(): BotPerfEmailStatus {
  const s = loadSettings();
  const {
    emailDeliveryConfigured,
  } = require('./emailNotifications') as typeof import('./emailNotifications');
  const nextDueAtMs = computeNextDueAtMs(s);
  return {
    enabled: s.enabled,
    interval: s.interval,
    email: s.email,
    sendHour: s.sendHour,
    timezone: TIMEZONE,
    emailDeliveryConfigured: emailDeliveryConfigured(),
    lastSentAtMs: s.lastSentAtMs,
    lastSentAt:
      s.lastSentAtMs != null ? new Date(s.lastSentAtMs).toISOString() : null,
    lastSentOk: s.lastSentOk,
    lastSentError: s.lastSentError,
    nextDueAtMs,
    nextDueAt:
      nextDueAtMs != null ? new Date(nextDueAtMs).toISOString() : null,
    nextDueLabel:
      nextDueAtMs != null
        ? new Date(nextDueAtMs).toLocaleString('en-AU', {
            timeZone: TIMEZONE,
            dateStyle: 'medium',
            timeStyle: 'short',
          }) + ` (${TIMEZONE})`
        : null,
    schedulerRunning: tickTimer != null,
  };
}

export function updateBotPerfEmailSettings(patch: {
  enabled?: boolean;
  interval?: string;
  email?: string;
  sendHour?: number;
}): BotPerfEmailStatus {
  const cur = loadSettings();
  const next: BotPerfEmailSettings = { ...cur };
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (
    patch.interval != null &&
    BOT_PERF_EMAIL_INTERVALS.includes(patch.interval as BotPerfEmailInterval)
  ) {
    next.interval = patch.interval as BotPerfEmailInterval;
  }
  if (patch.email != null) {
    const e = String(patch.email).trim();
    next.email = e.includes('@') ? e : DEFAULT_EMAIL;
  }
  if (patch.sendHour != null) next.sendHour = clampHour(Number(patch.sendHour));
  saveSettings(next);
  return getBotPerfEmailStatus();
}

export async function sendBotPerformanceEmail(opts?: {
  reason?: 'manual' | 'scheduled';
  to?: string;
}): Promise<{
  ok: boolean;
  error?: string;
  provider?: string;
  report?: BotPerfReport;
  status: BotPerfEmailStatus;
}> {
  const s = loadSettings();
  const to = String(opts?.to || s.email || DEFAULT_EMAIL).trim();
  const report = buildBotPerformanceReport({
    periodStartMs: s.lastSentAtMs ?? undefined,
    previousSnapshot: s.previousSnapshot,
  });
  const subject = `[BondBack] Bot performance · ${report.bots.length} bots · ${fmtSol(report.totals.periodPnlSol)} this period`;

  const { sendCustomEmail } =
    require('./emailNotifications') as typeof import('./emailNotifications');
  const result = await sendCustomEmail({
    to,
    subject,
    text: report.text,
  });

  const now = Date.now();
  if (result.ok) {
    saveSettings({
      ...s,
      email: to,
      lastSentAtMs: now,
      lastSentOk: true,
      lastSentError: null,
      lastPeriodStartMs: report.periodStartMs,
      previousSnapshot: snapshotFromReport(report),
    });
    logger.info('BotPerfEmail', `Sent (${opts?.reason || 'manual'})`, {
      to,
      provider: result.provider,
      bots: report.bots.length,
      periodEpisodes: report.totals.periodEpisodes,
    });
    try {
      const { pushDashboardNotification } =
        require('./dashboardNotifications') as typeof import('./dashboardNotifications');
      pushDashboardNotification({
        kind: 'email',
        title: 'Bot performance email sent',
        body: subject,
      });
    } catch {
      /* optional */
    }
  } else {
    saveSettings({
      ...s,
      lastSentOk: false,
      lastSentError: result.error || 'send failed',
    });
    logger.warn('BotPerfEmail', `Send failed: ${result.error}`, {
      to,
    });
  }

  return {
    ok: !!result.ok,
    error: result.error,
    provider: result.provider,
    report,
    status: getBotPerfEmailStatus(),
  };
}

function shouldSendNow(nowMs = Date.now()): boolean {
  const s = loadSettings();
  if (!s.enabled) return false;
  const due = computeNextDueAtMs(s, nowMs);
  if (due == null) return false;
  return nowMs >= due;
}

async function scheduledTick(): Promise<void> {
  if (sendInFlight) return;
  if (!shouldSendNow()) return;
  sendInFlight = true;
  try {
    await sendBotPerformanceEmail({ reason: 'scheduled' });
  } catch (err) {
    logger.warn('BotPerfEmail', 'Scheduled send error', errorToMeta(err));
    const s = loadSettings();
    saveSettings({
      ...s,
      lastSentOk: false,
      lastSentError: err instanceof Error ? err.message : String(err),
    });
  } finally {
    sendInFlight = false;
  }
}

export function startBotPerfEmailScheduler(): void {
  try {
    const { isLoadServiceEnabled } =
      require('./upgrades/packs/systemLoadMode') as typeof import('./upgrades/packs/systemLoadMode');
    if (!isLoadServiceEnabled('email_botperf')) {
      console.log('[bot-perf-email] scheduler skipped — System Load Mode extras off');
      return;
    }
  } catch {
    /* pack optional */
  }
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    void scheduledTick();
  }, TICK_MS);
  setTimeout(() => {
    void scheduledTick();
  }, 20_000);
  const st = getBotPerfEmailStatus();
  console.log(
    `[bot-perf-email] scheduler on · enabled=${st.enabled} · interval=${st.interval} · sendHour=${st.sendHour} ${TIMEZONE}` +
      (st.nextDueLabel ? ` · next=${st.nextDueLabel}` : '')
  );
}

export function stopBotPerfEmailScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}
