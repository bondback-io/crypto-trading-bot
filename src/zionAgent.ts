/**
 * Zion Dashboard Agent — read-only analyst; Semi-Autonomous Improvement Requests only.
 * Never writes micro-bot TP/SL or self-learning. Separated from MARL control.
 */

import { config } from './config';
import {
  computeFamilyMemoryScore,
  formatFamilyMemoryForPrompt,
} from './zionFamilyMemory';
import { maybeAppendPsalmToReply } from './zionPsalms';
import {
  addZionChangeRequest,
  appendZionChat,
  decideZionChangeRequest,
  listPendingZionImprovements,
  listZionImprovementHistory,
  loadZionAgentState,
  saveZionAgentState,
  setZionSemiAutonomous,
  type ZionChangeRequest,
} from './zionAgentStore';

function notifyNewImprovementRequest(row: ZionChangeRequest): void {
  void (async () => {
    try {
      const { notifyZionImprovementRequest } =
        require('./emailNotifications') as typeof import('./emailNotifications');
      await notifyZionImprovementRequest(row);
    } catch (err) {
      console.warn(
        '[zion-agent] improvement email failed:',
        err instanceof Error ? err.message : err
      );
    }
  })();
  try {
    const { pushDashboardNotification } =
      require('./dashboardNotifications') as typeof import('./dashboardNotifications');
    pushDashboardNotification({
      kind: 'system',
      title: 'Zion Improvement Request',
      body: row.title,
      href: `/dashboard?tab=zion&improvement=${encodeURIComponent(row.id)}`,
      meta: { improvementId: row.id },
    });
  } catch {
    /* optional */
  }
}

function queueImprovementRequest(
  cr: Omit<ZionChangeRequest, 'id' | 'createdAt' | 'status'>
): ZionChangeRequest {
  const row = addZionChangeRequest(cr);
  notifyNewImprovementRequest(row);
  return row;
}

export function getZionAgentStatus(): {
  mode: 'read_only' | 'semi_autonomous';
  label: string;
  semiAutonomous: boolean;
  personalityEnabled: boolean;
  supervisionEnabled: boolean;
  fightLogCommentsEnabled: boolean;
  supervisionEmailEnabled: boolean;
  hasLlmKey: boolean;
  llmProviders: { gemini: boolean; groq: boolean; openai: boolean };
  preferredProvider: ZionLlmProvider;
  preferredProviderLabel: string;
  messageCount: number;
  pendingChangeRequests: number;
  pendingImprovementRequests: number;
  familyMemoryScore: number;
  supervisionClassification?: string;
  ambientNudges?: {
    marketUpdatesEnabled: boolean;
    trendingNudgesEnabled: boolean;
    weatherNudgesEnabled: boolean;
  };
  learning?: ReturnType<
    typeof import('./zionContinuousLearning').getZionLearningStatus
  >;
} {
  const st = loadZionAgentState();
  const semi = st.semiAutonomous === true;
  const pending = st.changeRequests.filter((c) => c.status === 'pending').length;
  const llmProviders = getLlmProviderAvailability();
  const preferred = preferredProviderFromKeys();
  let supervisionClassification: string | undefined;
  try {
    const { getZionSupervisionStatus } =
      require('./zionSupervision') as typeof import('./zionSupervision');
    supervisionClassification = getZionSupervisionStatus().classification;
  } catch {
    /* optional */
  }
  let learning:
    | ReturnType<
        typeof import('./zionContinuousLearning').getZionLearningStatus
      >
    | undefined;
  try {
    const { getZionLearningStatus } =
      require('./zionContinuousLearning') as typeof import('./zionContinuousLearning');
    learning = getZionLearningStatus();
  } catch {
    /* optional */
  }
  const ambient = config.zionAgent?.ambientNudges;
  return {
    mode: semi ? 'semi_autonomous' : 'read_only',
    label: semi ? 'Zion · Semi-Autonomous' : 'Zion · Read-Only',
    semiAutonomous: semi,
    personalityEnabled: config.zionAgent?.personalityEnabled !== false,
    supervisionEnabled: config.zionAgent?.supervisionEnabled !== false,
    fightLogCommentsEnabled: config.zionAgent?.fightLogCommentsEnabled !== false,
    supervisionEmailEnabled: config.zionAgent?.supervisionEmailEnabled !== false,
    hasLlmKey:
      llmProviders.gemini || llmProviders.groq || llmProviders.openai,
    llmProviders,
    preferredProvider: preferred.provider,
    preferredProviderLabel: preferred.label,
    messageCount: st.messages.length,
    pendingChangeRequests: pending,
    pendingImprovementRequests: pending,
    familyMemoryScore: computeFamilyMemoryScore(st.messages),
    supervisionClassification,
    ambientNudges: {
      marketUpdatesEnabled: ambient?.marketUpdatesEnabled !== false,
      trendingNudgesEnabled: ambient?.trendingNudgesEnabled !== false,
      weatherNudgesEnabled: ambient?.weatherNudgesEnabled !== false,
    },
    learning,
  };
}

function buildContextPack(opts?: { slim?: boolean }): string {
  const slim = opts?.slim === true;
  const lines: string[] = [];
  try {
    lines.push(`Mode: ${config.mode}`);
    lines.push(`Risk: ${config.riskLevel}`);
    lines.push(
      `Learning Mode: ${config.learningMode?.enabled ? config.learningMode.strictness : 'OFF'}`
    );
    lines.push(
      `Pump.fun-only: ${config.filters?.buyPumpFunOnly === true ? 'ON' : 'OFF'}`
    );
    lines.push(
      `Require TA: ${config.marketScanner?.requireTaSetup !== false ? 'ON' : 'OFF'}`
    );
  } catch {
    /* */
  }
  try {
    const { getMarlStatus } =
      require('./marlCoordinator') as typeof import('./marlCoordinator');
    const m = getMarlStatus();
    lines.push(`MARL: ${m.label} · lowMC $${m.lowMcUsd}`);
    for (const a of m.agents.slice(0, slim ? 4 : 8)) {
      lines.push(
        `  agent ${a.profileId}: w=${a.weight.toFixed(2)} trades=${a.trades} WR=${a.winRatePct}%`
      );
    }
    if (!slim) {
      for (const d of m.decisions.slice(0, 6)) {
        lines.push(`  marl-dec: ${d.kind} — ${d.detail}`);
      }
    }
  } catch {
    lines.push('MARL: unavailable');
  }
  try {
    const { getTradeProfilesStatus } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    const tp = getTradeProfilesStatus();
    lines.push(
      `Smart Bot: ${tp.smartBotProfiles ? 'ON' : 'OFF'} · profiles enabled ${tp.profiles.filter((p: { enabled: boolean }) => p.enabled).length}`
    );
    for (const p of tp.profiles.slice(0, slim ? 8 : 12)) {
      lines.push(
        `  ${p.id}: ${p.enabled ? 'ON' : 'OFF'} lmOptIn=${p.learningModeOptIn !== false}`
      );
    }
  } catch {
    /* */
  }
  try {
    const { paperTrader } =
      require('./paperTrader') as typeof import('./paperTrader');
    const open = paperTrader.getOpenPositions?.() || [];
    const closed = paperTrader.getClosedPositions?.() || [];
    const stats = paperTrader.getStats?.();
    lines.push(
      `Open ${open.length} · Closed ${closed.length} · WR ${stats?.winRatePct ?? '—'}% · PF ${stats?.profitFactor ?? '—'}`
    );
    for (const o of open.slice(0, slim ? 3 : 6)) {
      try {
        const { formatPclZionOneLiner } =
          require('./profitCaptureLayer') as typeof import('./profitCaptureLayer');
        const one = formatPclZionOneLiner({
          profitPermissionUntilMs: o.profitPermissionUntilMs,
          pclPartialTaken: o.pclPartialTaken,
          pclRunnerFraction: o.pclRunnerFraction,
          peakProtectArmed: o.peakProtectArmed,
        });
        if (one) {
          lines.push(
            `  open ${o.symbol || o.mint?.slice(0, 6)} ${o.tradeProfileId || '?'}: ${one}`
          );
        }
      } catch {
        /* optional */
      }
    }
    for (const c of closed.slice(slim ? -4 : -8)) {
      lines.push(
        `  closed ${c.symbol || c.mint?.slice(0, 6)} ${c.tradeProfileId || '?'} pnl=${Number(c.pnlSol || 0).toFixed(3)}`
      );
    }
  } catch {
    /* */
  }
  try {
    const { getSkipReasonCounts, getMonitorStatus } =
      require('./monitor') as typeof import('./monitor');
    const skips = getSkipReasonCounts?.() || [];
    lines.push('Top skips:');
    for (const s of skips.slice(0, slim ? 5 : 8)) {
      lines.push(`  ${s.reason}: ${s.count}`);
    }
    const ms = getMonitorStatus?.();
    if (ms?.entryPathLight) {
      lines.push(
        `Entries: ${ms.entryPathLight.label} ${ms.entryPathLight.detail || ''}`
      );
    }
  } catch {
    /* */
  }
  try {
    const { formatLearningDiagnosticsForZion } =
      require('./learningSystemDiagnostics') as typeof import('./learningSystemDiagnostics');
    lines.push(...formatLearningDiagnosticsForZion());
  } catch {
    lines.push('Learning health: unavailable');
  }
  try {
    const { getProfileRlStatus, formatProfileRlPlainLanguage } =
      require('./profileRlAgent') as typeof import('./profileRlAgent');
    const prl = getProfileRlStatus({
      persist: false,
      ensureKeyAgents: !slim,
    });
    lines.push(`Profile RL: ${prl.label}`);
    for (const a of prl.agents.slice(0, slim ? 4 : 6)) {
      const plain =
        a.plainLanguage || formatProfileRlPlainLanguage(a.profileId);
      const ready = a.readinessScore != null ? `${a.readinessScore}/100` : '—';
      const lock = a.modeLocked ? ' locked' : '';
      lines.push(
        `  prl ${a.profileId}: ${a.mode || 'shadow'} · ready ${ready}${lock} · ${String(plain).slice(0, slim ? 72 : 100)}`
      );
    }
    if (!slim) {
      for (const d of prl.decisions.slice(0, 4)) {
        lines.push(`  prl-dec: ${d.detail}`);
      }
    }
  } catch {
    lines.push('Profile RL: unavailable');
  }
  if (!slim) {
    try {
      const { getLearningEnhancementsStatus, formatLearningEnhancementsPlainLanguage } =
        require('./learningEnhancements') as typeof import('./learningEnhancements');
      const le = getLearningEnhancementsStatus();
      lines.push(`Enhancements: ${le.label}`);
      lines.push(`  ${formatLearningEnhancementsPlainLanguage()}`);
      for (const a of le.activity.slice(-3)) {
        lines.push(`  enh ${a.profileId}: ${a.action} — ${String(a.detail).slice(0, 72)}`);
      }
      for (const w of le.watchdogWarnings.slice(0, 2)) {
        lines.push(`  enh-warn: ${w}`);
      }
    } catch {
      /* optional */
    }
  }
  if (!slim) {
    try {
      const { getLearningAcceleratorsStatus, formatReplayPlainLanguage } =
        require('./learningReplayBuffer') as typeof import('./learningReplayBuffer');
      const { formatCounterfactualPlainLanguage } =
        require('./learningCounterfactual') as typeof import('./learningCounterfactual');
      const { formatTeacherStudentPlainLanguage } =
        require('./learningTeacherStudent') as typeof import('./learningTeacherStudent');
      const acc = getLearningAcceleratorsStatus();
      lines.push(`Accelerators: ${acc.label}`);
      for (const p of acc.profiles.slice(0, 4)) {
        const bits = [
          formatReplayPlainLanguage(p.profileId),
          formatCounterfactualPlainLanguage(p.profileId),
          formatTeacherStudentPlainLanguage(p.profileId),
        ].filter(Boolean);
        if (bits.length) {
          lines.push(`  accel ${p.profileId}: ${bits.join(' · ').slice(0, 120)}`);
        }
      }
    } catch {
      lines.push('Accelerators: unavailable');
    }
    try {
      const { formatProfileTaLearnedPlainLanguage } =
        require('./profileTaPlaybookStore') as typeof import('./profileTaPlaybookStore');
      const { KEY_PROFILE_RL_IDS } =
        require('./profileRlAgent') as typeof import('./profileRlAgent');
      const taLines: string[] = [];
      for (const pid of KEY_PROFILE_RL_IDS) {
        const ta = formatProfileTaLearnedPlainLanguage(pid);
        if (ta) taLines.push(`  ta ${pid}: ${ta.slice(0, 100)}`);
      }
      if (taLines.length) {
        lines.push('Profile TA learned:');
        lines.push(...taLines.slice(0, 4));
      }
    } catch {
      /* optional */
    }
  }
  try {
    const { buildZionAnalystBrief } =
      require('./zionPerformanceAnalyst') as typeof import('./zionPerformanceAnalyst');
    const brief = buildZionAnalystBrief();
    lines.push(...brief.contextLines.slice(0, slim ? 24 : 80));
  } catch {
    lines.push('Analyst brief: unavailable');
  }
  try {
    const st = loadZionAgentState();
    const score = computeFamilyMemoryScore(st.messages);
    lines.push(`Family Memory Score: ${score}/100`);
  } catch {
    /* optional */
  }
  try {
    const { getZionSupervisionStatus } =
      require('./zionSupervision') as typeof import('./zionSupervision');
    const plain = getZionSupervisionStatus().plainLines || [];
    if (plain.length) {
      lines.push('System health supervision:');
      lines.push(...plain.slice(0, slim ? 3 : 5));
    }
  } catch {
    /* optional */
  }
  return lines.join('\n').slice(0, slim ? 8_000 : 18_000);
}

/** Short-lived cache so rapid chat turns skip heavy status rebuilds. */
let contextPackCache: { at: number; slim: boolean; text: string } | null = null;
const CONTEXT_PACK_TTL_MS = 8_000;

function getCachedContextPack(slim = true): string {
  const now = Date.now();
  if (
    contextPackCache &&
    contextPackCache.slim === slim &&
    now - contextPackCache.at < CONTEXT_PACK_TTL_MS
  ) {
    return contextPackCache.text;
  }
  const text = buildContextPack({ slim });
  contextPackCache = { at: now, slim, text };
  return text;
}

type ParsedBotFacts = {
  mode?: string;
  risk?: string;
  learningMode?: string;
  pumpFunOnly?: string;
  requireTa?: string;
  marl?: string;
  learningHealth?: string;
  learningBlurb?: string;
  learningWarns: string[];
  learnProfiles: Array<{ name: string; detail: string }>;
  profiles: Array<{ id: string; enabled: boolean; label: string }>;
  open?: number;
  closed?: number;
  winRatePct?: string;
  profitFactor?: string;
  recentClosed: Array<{ symbol: string; profileId: string; pnl: number }>;
  topSkips: Array<{ reason: string; count: string }>;
};

const PROFILE_LABELS: Record<string, string> = {
  scalper: 'Scalper',
  dip_buyer: 'Dip Buyer',
  migration_sniper: 'Migration Sniper',
  trend_rider: 'Trend Rider',
  steady_compounder: 'Steady Compounder',
  high_win_rate: 'High Win-Rate',
  momentum_burst: 'Momentum Burst',
  reversal_scalper: 'Reversal Scalper',
  compounder: 'Compounder',
  default: 'Default',
};

function profileLabel(id: string): string {
  return PROFILE_LABELS[id] || id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseContextPack(ctx: string): ParsedBotFacts {
  const facts: ParsedBotFacts = {
    profiles: [],
    recentClosed: [],
    topSkips: [],
    learningWarns: [],
    learnProfiles: [],
  };
  for (const raw of ctx.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^Mode:\s*(.+)$/i))) facts.mode = m[1].trim();
    else if ((m = line.match(/^Risk:\s*(.+)$/i))) facts.risk = m[1].trim();
    else if ((m = line.match(/^Learning Mode:\s*(.+)$/i)))
      facts.learningMode = m[1].trim();
    else if ((m = line.match(/^Pump\.fun-only:\s*(.+)$/i)))
      facts.pumpFunOnly = m[1].trim();
    else if ((m = line.match(/^Require TA:\s*(.+)$/i)))
      facts.requireTa = m[1].trim();
    else if ((m = line.match(/^MARL:\s*(.+)$/i))) facts.marl = m[1].trim();
    else if ((m = line.match(/^Learning health:\s*(.+)$/i)))
      facts.learningHealth = m[1].trim();
    else if ((m = line.match(/^warn:\s*(.+)$/i)))
      facts.learningWarns.push(m[1].trim());
    else if ((m = line.match(/^learn\s+(.+?):\s*(.+)$/i)))
      facts.learnProfiles.push({ name: m[1].trim(), detail: m[2].trim() });
    else if (
      (m = line.match(
        /^([a-z0-9_]+):\s*(ON|OFF)\s+lmOptIn=/i
      ))
    ) {
      const id = m[1].toLowerCase();
      facts.profiles.push({
        id,
        enabled: m[2].toUpperCase() === 'ON',
        label: profileLabel(id),
      });
    } else if (
      (m = line.match(
        /^Open\s+(\d+)\s*·\s*Closed\s+(\d+)\s*·\s*WR\s+(.+?)%\s*·\s*PF\s+(.+)$/i
      ))
    ) {
      facts.open = Number(m[1]);
      facts.closed = Number(m[2]);
      facts.winRatePct = m[3].trim();
      facts.profitFactor = m[4].trim();
    } else if (
      (m = line.match(/^closed\s+(\S+)\s+(\S+)\s+pnl=([-\d.]+)/i))
    ) {
      facts.recentClosed.push({
        symbol: m[1],
        profileId: m[2],
        pnl: Number(m[3]),
      });
    } else if (
      line.startsWith('ML is') ||
      line.startsWith('Self-Learn') ||
      (line.includes('MARL') && line.includes('influence'))
    ) {
      // health blurb line under Learning health
      if (!facts.learningBlurb && facts.learningHealth) {
        facts.learningBlurb = line.replace(/^\s+/, '');
      }
    } else if ((m = line.match(/^([^:]+):\s*(\d+)$/)) && facts.topSkips) {
      // skip lines after "Top skips:" — only count short reason lines
      if (
        !/^(Mode|Risk|Learning|Pump|Require|MARL|Smart|Open|Entries|agent|marl|warn|learn)/i.test(
          m[1]
        )
      ) {
        facts.topSkips.push({ reason: m[1].trim(), count: m[2] });
      }
    }
  }
  // Capture indented blurb after Learning health
  for (const raw of ctx.split('\n')) {
    const t = raw.trim();
    if (
      !facts.learningBlurb &&
      facts.learningHealth &&
      /^(ML is|Self-Learn|MARL is)/i.test(t)
    ) {
      facts.learningBlurb = t;
      break;
    }
  }
  return facts;
}

function findProfile(
  facts: ParsedBotFacts,
  ...aliases: string[]
): ParsedBotFacts['profiles'][0] | undefined {
  const keys = aliases.map((a) => a.toLowerCase().replace(/\s+/g, '_'));
  return facts.profiles.find((p) =>
    keys.some((k) => p.id === k || p.id.includes(k) || p.label.toLowerCase().includes(k.replace(/_/g, ' ')))
  );
}

function leadingWinsSummary(facts: ParsedBotFacts): string | null {
  const wins = facts.recentClosed.filter((c) => c.pnl > 0);
  if (!wins.length) return null;
  const byProfile = new Map<string, number>();
  for (const w of wins) {
    const id = w.profileId === '?' ? 'unknown' : w.profileId;
    byProfile.set(id, (byProfile.get(id) || 0) + 1);
  }
  const top = [...byProfile.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top) return null;
  return profileLabel(top[0]);
}

function formatZionReply(parts: {
  greeting?: string;
  answer: string;
  summary?: string;
  followUp?: string;
  scripture?: string;
}): string {
  const raw = [parts.greeting, parts.answer, parts.summary, parts.followUp, parts.scripture]
    .filter((p) => p && String(p).trim())
    .join('\n\n');
  return softenDadAddressing(raw);
}

type ZionVibe = 'warm' | 'witty' | 'chill' | 'coachy' | 'tech';

const ZION_VIBES: readonly ZionVibe[] = [
  'warm',
  'witty',
  'chill',
  'coachy',
  'tech',
];

function pickZionVibe(): ZionVibe {
  return ZION_VIBES[Math.floor(Math.random() * ZION_VIBES.length)]!;
}

function pickLine(lines: string[]): string {
  return lines[Math.floor(Math.random() * lines.length)] || lines[0] || '';
}

/** Hi / bye / thanks / how's your day — keep these to 1–2 short sentences. */
function isSocialSmalltalk(question: string): boolean {
  const q = String(question || '')
    .trim()
    .toLowerCase()
    .replace(/[!.?,]+$/g, '')
    .trim();
  if (!q || q.length > 80) return false;
  if (
    /^(hi|hello|hey|yo|sup|howdy|hiya|hola|gm|good morning|good afternoon|good evening|good night)(\s+(dad|isaac))?$/i.test(
      q
    )
  ) {
    return true;
  }
  if (
    /^(bye|goodbye|see ya|see you|later|cya|take care)(\s+(dad|isaac))?$/i.test(q)
  ) {
    return true;
  }
  if (/^(thanks|thank you|thx|ty|cheers|appreciate it)(\s+(dad|isaac))?$/i.test(q)) {
    return true;
  }
  if (
    /^(how('?s| is) (it|your day|everything|things|life)|what'?s up|how are you|you good|you ok)(\s+(dad|isaac))?$/i.test(
      q
    )
  ) {
    return true;
  }
  return false;
}

function socialSmalltalkReply(question: string, vibe: ZionVibe): string {
  const q = question.toLowerCase();
  if (/bye|goodbye|see ya|see you|later|cya|take care/.test(q)) {
    return pickLine([
      'Catch you later — I’ll keep an eye on the lanes.',
      'Later. Ping me anytime you want a quick read.',
      'Take care — I’ll be right here when you’re back.',
      'See you soon, Dad.',
    ]);
  }
  if (/thanks|thank you|thx|ty|cheers|appreciate/.test(q)) {
    return pickLine([
      'Anytime.',
      'You got it.',
      'Happy to help — ask whenever.',
      'Glad it helped.',
    ]);
  }
  if (/how('?s| is)|what'?s up|how are you|you good|you ok/.test(q)) {
    const byVibe: Record<ZionVibe, string[]> = {
      warm: [
        'Doing great — solid day so far. How’s yours?',
        'Pretty good over here. Hope your day’s treating you well.',
      ],
      witty: [
        'Still caffeinated and watching charts — so, thriving. You?',
        'Can’t complain. Bots are loud; I’m louder. How’s your day?',
      ],
      chill: [
        'All good. Quiet focus mode. How’s your day going?',
        'Steady. Nothing wild. How about you?',
      ],
      coachy: [
        'Feeling sharp — ready when you are. How’s your day?',
        'Locked in. How’s energy on your side?',
      ],
      tech: [
        'Systems green here. How’s your day looking?',
        'Running smooth. Status check on you?',
      ],
    };
    return pickLine(byVibe[vibe]);
  }
  // greetings / hello — Dad ok occasionally at the start
  const byVibe: Record<ZionVibe, string[]> = {
    warm: [
      'Hey — good to see you.',
      'Hi! Glad you’re here.',
      'Hey Dad — good to see you.',
    ],
    witty: [
      'Hey — fashionably on time for a status check.',
      'Speak of the dashboard — what’s up?',
    ],
    chill: [
      'Hey. What’s the vibe?',
      'Yo — I’m around.',
    ],
    coachy: [
      'Hey — let’s make it a clean session.',
      'Ready when you are.',
    ],
    tech: [
      'Hey — Zion online.',
      'Hi. Channels open — ask away.',
    ],
  };
  return pickLine(byVibe[vibe]);
}

function vibeAck(vibe: ZionVibe, isFirst?: boolean): string {
  if (isFirst) {
    return pickLine([
      'Hey — good to see you.',
      'Hi — glad you’re here.',
      'Hey — let’s dig in.',
    ]);
  }
  const map: Record<ZionVibe, string[]> = {
    warm: ['Sure thing.', 'On it.', 'Happy to.'],
    witty: ['Love it.', 'Say less.', 'Classic ask.'],
    chill: ['Yep.', 'Cool — here’s the read.', 'Got it.'],
    coachy: ['Let’s go.', 'Quick brief.', 'Focus time.'],
    tech: ['Copy.', 'Snapshotting that.', 'Pulling status.'],
  };
  return pickLine(map[vibe]);
}

/** Soften robotic ", Dad" tag endings while keeping occasional natural Dad. */
function softenDadAddressing(text: string): string {
  let out = String(text || '');
  // "That's great, Dad." / "Got it, Dad —" → drop the vocative comma tag
  out = out.replace(/,\s*[Dd]ad(?=\s*[—–-]|\s*[.!?]|\s*$)/g, '');
  out = out.replace(/,\s*[Dd]ad(?=\s)/g, '');
  // "Sure Dad." mid-ack without comma — leave "Hey Dad" greetings alone
  out = out.replace(
    /\b(Sure|Got it|Okay|Ok|Yep|Yeah|Thanks|Thank you|Anytime|Copy|On it)\s+[Dd]ad\b/gi,
    '$1'
  );
  out = out.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/ +\n/g, '\n');
  return out.trim();
}

function wantsRawSnapshot(q: string): boolean {
  return /raw|dump|full (?:config|snapshot|state)|show (?:me )?(?:the )?snapshot|context pack/i.test(
    q
  );
}

function localAnalystReply(
  question: string,
  ctx: string,
  opts?: { isFirst?: boolean; vibe?: ZionVibe }
): string {
  const q = question.toLowerCase();
  const vibe = opts?.vibe || pickZionVibe();
  if (isSocialSmalltalk(question)) {
    return socialSmalltalkReply(question, vibe);
  }
  const facts = parseContextPack(ctx);
  const greet = vibeAck(vibe, opts?.isFirst);

  if (wantsRawSnapshot(q)) {
    return formatZionReply({
      greeting: `Sure — raw snapshot:`,
      answer: '```\n' + ctx.slice(0, 3500) + '\n```',
      followUp: 'Want the plain-language version?',
    });
  }

  const overallStats =
    facts.closed != null
      ? `WR ~${facts.winRatePct ?? '—'}% on ${facts.closed} closes` +
        (facts.profitFactor && facts.profitFactor !== '—'
          ? ` · PF ${facts.profitFactor}`
          : '') +
        '.'
      : null;
  const leadLane = leadingWinsSummary(facts);

  // Deep performance / proactive analyst path
  try {
    const {
      buildZionAnalystBrief,
      formatAnalystReply,
      wantsPerformanceAnalysis,
    } = require('./zionPerformanceAnalyst') as typeof import('./zionPerformanceAnalyst');
    if (
      wantsPerformanceAnalysis(q) ||
      /health score|what has .+ learned|learning progress|system health/.test(q)
    ) {
      const brief = buildZionAnalystBrief();
      return formatAnalystReply(brief, {
        greet,
        focus: overallStats || undefined,
      });
    }
  } catch {
    /* fall through */
  }

  // Profile-specific “how is X doing?”
  const profileAsk = q.match(
    /\b(scalper|dip\s*buyer|migration(?:\s*sniper)?|trend(?:\s*rider)?|compounder)\b/i
  );
  if (profileAsk && /how|doing|status|perform|enabled|on|off|running/.test(q)) {
    const alias = profileAsk[1].toLowerCase().replace(/\s+/g, '_');
    const mapAlias =
      alias.startsWith('dip')
        ? 'dip_buyer'
        : alias.startsWith('migration')
          ? 'migration_sniper'
          : alias.startsWith('trend')
            ? 'trend_rider'
            : alias;
    const p = findProfile(facts, mapAlias, alias);
    if (!p) {
      return formatZionReply({
        greeting: greet,
        answer: `No clear read on ${profileLabel(mapAlias)} in the pack.`,
        followUp: 'Overall performance, or another lane?',
      });
    }
    const answer = p.enabled
      ? `${p.label} is ON.`
      : `${p.label} is OFF.`;
    const summaryParts: string[] = [];
    if (overallStats) {
      summaryParts.push(
        overallStats +
          (leadLane ? ` Recent greens lean ${leadLane}.` : '')
      );
    }
    if (mapAlias === 'scalper') {
      summaryParts.push(
        'Scalper skips Require TA when it wins the lane (or small-MC queue).'
      );
    }
    return formatZionReply({
      greeting: greet,
      answer,
      summary: summaryParts.join(' ') || undefined,
      followUp: p.enabled
        ? `${p.label} closes, or skip reasons?`
        : `Past ${p.label} stats, or why it’s off?`,
    });
  }

  if (/marl|multi.?agent|coordination|influence/.test(q)) {
    return formatZionReply({
      greeting: greet,
      answer:
        'MARL is soft only — reorder lanes, trim size confidence, limit low-MC pile-ins. Never touches TP/SL, timers, or self-learning.',
      summary: facts.marl
        ? `Now: ${facts.marl}. Strength slider is on Micro Bots → MARL.`
        : 'Strength (Low/Med/High) is on Micro Bots → MARL.',
      followUp: 'Recent MARL decisions?',
    });
  }

  if (/profile\s*rl|per.?profile\s*rl|rl\s*agent/.test(q)) {
    const prlLine = ctx
      .split('\n')
      .find((l) => l.startsWith('Profile RL:'));
    const prlBits = ctx
      .split('\n')
      .filter((l) => l.startsWith('  prl ') || l.startsWith('  prl-dec:'))
      .slice(0, 4);
    return formatZionReply({
      greeting: greet,
      answer:
        prlLine?.replace(/^Profile RL:\s*/, '') ||
        'Profile RL is per-lane soft policy — setup-worth, size confidence, TA sensitivity, exit hints. Never TP/SL.',
      summary:
        prlBits.length > 0
          ? prlBits.map((l) => l.trim()).join(' ')
          : 'Shadow/hybrid/lead per profile on Micro Bots → Profile RL. Default OFF.',
      followUp: 'A specific lane’s RL mode or recent decisions?',
    });
  }

  if (/accelerator|replay|counterfactual|teacher.?student/.test(q)) {
    const accLine = ctx
      .split('\n')
      .find((l) => l.startsWith('Accelerators:'));
    const accBits = ctx
      .split('\n')
      .filter((l) => l.startsWith('  accel ') || l.startsWith('  accel-dec:'))
      .slice(0, 4);
    return formatZionReply({
      greeting: greet,
      answer:
        accLine?.replace(/^Accelerators:\s*/, '') ||
        'Learning Accelerators: offline replay, counterfactual exit what-ifs, teacher→student TA transfer. Soft only.',
      summary:
        accBits.length > 0
          ? accBits.map((l) => l.trim()).join(' ')
          : 'Master toggle on Micro Bots → Learning Accelerators. Feeds self-learn and Profile RL rewards.',
      followUp: 'Learning health score, or a profile’s TA learned weights?',
    });
  }

  if (/learning mode|loosest|looser|stricter|middle/.test(q)) {
    const lm = facts.learningMode || 'unknown';
    return formatZionReply({
      greeting: greet,
      answer:
        lm === 'OFF' || lm.toLowerCase() === 'off'
          ? 'Learning Mode is OFF.'
          : `Learning Mode is ON (${lm}).`,
      summary:
        'Softens entry floors — does not bypass Require TA (except Scalper/specialty Trend), anti-rug, or disabled profiles.',
      followUp: 'Want how it hits a specific profile?',
    });
  }

  if (/trend\s*rider|quiet|why.*(no|few)\s*trades/.test(q)) {
    const p = findProfile(facts, 'trend_rider');
    const state = p
      ? p.enabled
        ? 'Trend Rider is ON.'
        : 'Trend Rider is OFF.'
      : 'Trend Rider isn’t clear in the profile list.';
    return formatZionReply({
      greeting: greet,
      answer: state,
      summary:
        'Quiet spells were often Pump.fun-only blocking Jupiter specialty. Specialty Jupiter/KOL can bypass Pump.fun-only + Require TA; lane MC/age/volume floors still apply.',
      followUp: 'Check Pump.fun-only / Require TA, or Trend closes?',
    });
  }

  if (
    /why.*dip|dip\s*buyer\s*quiet|dip\s*(is\s*)?(quiet|idle|silent)|no\s*dip/i.test(
      q
    )
  ) {
    try {
      const { getSetupWatchDiagnostics } =
        require('./profileAttention') as typeof import('./profileAttention');
      const d = getSetupWatchDiagnostics();
      const reason = d.dipInactiveReason;
      const map: Record<string, string> = {
        no_watches: 'No Dip watches are active right now.',
        armed_no_trigger: 'Dip has armed setups waiting for reclaim trigger.',
        trigger_blocked: 'Dip triggers were blocked by hard safety (anti-rug / floors).',
        recovery: 'Dip Buyer Recovery is throttling admits.',
        marl: 'MARL coordination is downranking Dip.',
        profile_off: 'Dip Buyer or Market Scanner is off.',
      };
      return formatZionReply({
        greeting: greet,
        answer: map[reason] || `Dip quiet reason: ${reason}.`,
        summary:
          `Armed by profile: ${JSON.stringify(d.armedByProfile || {})}.` +
          (d.lastBlockReason ? ` Last block: ${d.lastBlockReason}.` : ''),
        followUp: 'How many Scalper watches are armed?',
      });
    } catch {
      return formatZionReply({
        greeting: greet,
        answer: 'Couldn’t read Dip watch diagnostics just now.',
        followUp: 'Check the Watchlist Mode B strip.',
      });
    }
  }

  if (/how many.*scalper.*armed|scalper.*watches?\s*armed|armed.*scalper/i.test(q)) {
    try {
      const { getSetupWatchDiagnostics } =
        require('./profileAttention') as typeof import('./profileAttention');
      const d = getSetupWatchDiagnostics();
      const bits = Object.entries(d.armedByProfile || {})
        .map(([id, n]) => `${id}: ${n}`)
        .join(', ');
      const total = Object.values(d.armedByProfile || {}).reduce(
        (s, n) => s + (Number(n) || 0),
        0
      );
      return formatZionReply({
        greeting: greet,
        answer: `Armed setups: ${total}${bits ? ` (${bits})` : ''}.`,
        summary:
          d.scalperAttentionShare != null
            ? `Scalper attention share ~${d.scalperAttentionShare}%.`
            : 'Attention share not sampled yet.',
        followUp: 'What % of armed setups opened?',
      });
    } catch {
      return formatZionReply({
        greeting: greet,
        answer: 'Armed-watch counts unavailable.',
      });
    }
  }

  if (
    /%.*(armed|setup).*open|armed.*open(ed)?|trigger\s*success|open\s*rate.*armed/i.test(
      q
    )
  ) {
    try {
      const { getSetupWatchDiagnostics } =
        require('./profileAttention') as typeof import('./profileAttention');
      const d = getSetupWatchDiagnostics();
      return formatZionReply({
        greeting: greet,
        answer:
          d.triggerSuccessPct != null
            ? `About ${d.triggerSuccessPct}% of armed triggers opened a trade (recent window).`
            : 'No armed→open samples yet this session.',
        summary: `Armed ${d.stats.armed} · triggered ${d.stats.triggered} · opened ${d.stats.opened} · blocked ${d.stats.blockedSafety}.`,
        followUp: 'Why is Dip Buyer quiet?',
      });
    } catch {
      return formatZionReply({
        greeting: greet,
        answer: 'Open-rate diagnostics unavailable.',
      });
    }
  }

  if (/scalper|ta setup/.test(q)) {
    const p = findProfile(facts, 'scalper');
    return formatZionReply({
      greeting: greet,
      answer: p
        ? p.enabled
          ? 'Scalper is ON.'
          : 'Scalper is OFF.'
        : 'Scalper doesn’t need TA at the profile level.',
      summary:
        'Require TA is skipped when Scalper wins the lane (or small-MC queue).',
      followUp: 'Overall WR, or a specific Scalper skip?',
    });
  }

  if (/win\s*rate|profit factor|performance|how.*(bot|system|we)|pnl|overall/.test(q)) {
    return formatZionReply({
      greeting: greet,
      answer: overallStats || 'No closed-trade stats handy yet.',
      summary:
        [
          facts.open != null ? `Open: ${facts.open}.` : null,
          leadLane ? `Recent greens → ${leadLane}.` : null,
          facts.mode ? `Mode ${facts.mode}; risk ${facts.risk || '—'}.` : null,
        ]
          .filter(Boolean)
          .join(' ') || undefined,
      followUp: 'By profile, or top skips?',
    });
  }

  if (/skip|blocked|why.*(skip|reject)/.test(q)) {
    const top = facts.topSkips.slice(0, 3);
    return formatZionReply({
      greeting: greet,
      answer: top.length
        ? `Top skips: ${top.map((s) => `${s.reason} (${s.count})`).join(', ')}.`
        : 'No skip counts available right now.',
      summary: 'Skips = declined before open (filters / conviction / risk).',
      followUp: 'Want one of those in plain English?',
    });
  }

  if (
    /learning (progress|health)|system health|what has .+ learned|self-?learn|ml mode|diagnostics/.test(
      q
    ) ||
    (/learned|learning/.test(q) && /scalper|dip|migration|trend|momentum|burst|steady|high.?win|reversal|bot/.test(q))
  ) {
    const named = facts.learnProfiles.find((p) =>
      q.toLowerCase().includes(p.name.toLowerCase().split(' ')[0] || '')
    );
    if (named && /what|learned|progress|how/.test(q)) {
      return formatZionReply({
        greeting: greet,
        answer: `${named.name}: ${named.detail}`,
        summary: facts.learningHealth
          ? `System: ${facts.learningHealth}.`
          : undefined,
        followUp: 'Another bot, or overall system health?',
      });
    }
    const topLearn = facts.learnProfiles.slice(0, 4);
    return formatZionReply({
      greeting: greet,
      answer: facts.learningHealth
        ? `System Health ${facts.learningHealth}.`
        : 'Learning diagnostics aren’t loaded yet.',
      summary: [
        facts.learningBlurb,
        facts.learningWarns.length
          ? `Watch: ${facts.learningWarns.slice(0, 3).join('; ')}.`
          : null,
        topLearn.length
          ? topLearn.map((p) => `${p.name} — ${p.detail.split('—').pop()?.trim() || p.detail}`).join(' ')
          : null,
      ]
        .filter(Boolean)
        .join(' '),
      followUp: 'Ask what a specific bot has learned, or open Bot Performance.',
    });
  }

  // Generic helpful answer — no raw dump
  const onProfiles = facts.profiles.filter((p) => p.enabled).map((p) => p.label);
  const offProfiles = facts.profiles.filter((p) => !p.enabled).map((p) => p.label);
  return formatZionReply({
    greeting: vibeAck(vibe, opts?.isFirst),
    answer: overallStats
      ? overallStats
      : 'I can check profiles, learning progress, MARL, skips, or overall — just say which.',
    summary: [
      onProfiles.length ? `On: ${onProfiles.join(', ')}.` : null,
      offProfiles.length ? `Off: ${offProfiles.join(', ')}.` : null,
      facts.learningMode ? `LM: ${facts.learningMode}.` : null,
      facts.marl ? `MARL: ${facts.marl}.` : null,
    ]
      .filter(Boolean)
      .join(' ') || undefined,
    followUp: 'Profile, MARL, or a skip reason?',
  });
}

export type ZionLlmProvider = 'gemini' | 'groq' | 'openai' | 'local';

type ZionLlmResult = {
  text: string;
  provider: ZionLlmProvider;
  model: string;
};

function envTrim(name: string): string {
  return String(process.env[name] || '').trim();
}

function getGeminiApiKey(): string {
  return envTrim('GEMINI_API_KEY') || envTrim('GOOGLE_API_KEY');
}

function getGroqApiKey(): string {
  return envTrim('GROQ_API_KEY');
}

function getOpenAiApiKey(): string {
  return (
    envTrim('OPENAI_API_KEY') ||
    String(
      (config as { zionAgent?: { apiKey?: string } }).zionAgent?.apiKey || ''
    ).trim()
  );
}

function getLlmProviderAvailability(): {
  gemini: boolean;
  groq: boolean;
  openai: boolean;
} {
  return {
    gemini: Boolean(getGeminiApiKey()),
    groq: Boolean(getGroqApiKey()),
    openai: Boolean(getOpenAiApiKey()),
  };
}

function preferredProviderFromKeys(): {
  provider: ZionLlmProvider;
  label: string;
} {
  const avail = getLlmProviderAvailability();
  if (avail.gemini) return { provider: 'gemini', label: 'via Gemini' };
  if (avail.groq) return { provider: 'groq', label: 'via Groq' };
  if (avail.openai) return { provider: 'openai', label: 'via OpenAI' };
  return { provider: 'local', label: 'Local analysis' };
}

function providerAttribution(_provider: ZionLlmProvider, _model: string): string {
  return '~ Zion Valton';
}

const ZION_LLM_TIMEOUT_MS = 7_000;
const ZION_MAX_OUTPUT_TOKENS = 550;

function withTimeoutSignal(ms: number): AbortSignal {
  if (
    typeof AbortSignal !== 'undefined' &&
    typeof AbortSignal.timeout === 'function'
  ) {
    return AbortSignal.timeout(ms);
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

type ZionLlmHistoryTurn = {
  role: 'user' | 'assistant';
  content: string;
};

type OpenAiCompatOpts = {
  provider: 'groq' | 'openai';
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  history?: ZionLlmHistoryTurn[];
  timeoutMs?: number;
};

const ZION_HISTORY_TURNS = 12;
const ZION_HISTORY_MSG_CHARS = 800;

/** Prior chat turns for the model (excludes the just-appended current user). */
function buildZionLlmHistory(currentUserText: string): ZionLlmHistoryTurn[] {
  try {
    const msgs = loadZionAgentState().messages || [];
    const out: ZionLlmHistoryTurn[] = [];
    for (const m of msgs) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const content = String(m.text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, ZION_HISTORY_MSG_CHARS);
      if (!content) continue;
      out.push({ role: m.role, content });
    }
    // Drop trailing user that matches the message we just appended
    const cur = String(currentUserText || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, ZION_HISTORY_MSG_CHARS);
    while (
      out.length &&
      out[out.length - 1].role === 'user' &&
      (out[out.length - 1].content === cur ||
        out[out.length - 1].content.startsWith(cur.slice(0, 40)))
    ) {
      out.pop();
    }
    return out.slice(-ZION_HISTORY_TURNS);
  } catch {
    return [];
  }
}

async function callOpenAiCompatibleChat(
  opts: OpenAiCompatOpts
): Promise<{ text: string; model: string } | null> {
  const base = opts.baseUrl.replace(/\/$/, '');
  const timeoutMs = opts.timeoutMs ?? ZION_LLM_TIMEOUT_MS;
  const historyMsgs = (opts.history || []).map((h) => ({
    role: h.role,
    content: h.content,
  }));
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: withTimeoutSignal(timeoutMs),
      body: JSON.stringify({
        model: opts.model,
        temperature: 0.72,
        max_tokens: ZION_MAX_OUTPUT_TOKENS,
        messages: [
          { role: 'system', content: opts.system },
          ...historyMsgs,
          { role: 'user', content: opts.user },
        ],
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.warn(
        '[zion-agent] fallback',
        opts.provider,
        opts.model,
        res.status,
        t.slice(0, 200)
      );
      return null;
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = String(data.choices?.[0]?.message?.content || '').trim();
    if (!text) {
      console.warn(
        '[zion-agent] fallback',
        opts.provider,
        opts.model,
        'empty response'
      );
      return null;
    }
    return { text, model: opts.model };
  } catch (err) {
    console.warn(
      '[zion-agent] fallback',
      opts.provider,
      opts.model,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

async function callGeminiModel(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  history: ZionLlmHistoryTurn[] = [],
  timeoutMs = ZION_LLM_TIMEOUT_MS
): Promise<{ text: string; model: string } | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const contents = [
    ...history.map((h) => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }],
    })),
    { role: 'user', parts: [{ text: user }] },
  ];
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      signal: withTimeoutSignal(timeoutMs),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: {
          temperature: 0.72,
          maxOutputTokens: ZION_MAX_OUTPUT_TOKENS,
        },
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.warn(
        '[zion-agent] fallback',
        'gemini',
        model,
        res.status,
        t.slice(0, 200)
      );
      return null;
    }
    const data = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };
    const parts = data.candidates?.[0]?.content?.parts || [];
    const text = parts
      .map((p) => String(p.text || ''))
      .join('')
      .trim();
    if (!text) {
      console.warn('[zion-agent] fallback', 'gemini', model, 'empty response');
      return null;
    }
    return { text, model };
  } catch (err) {
    console.warn(
      '[zion-agent] fallback',
      'gemini',
      model,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

async function callGeminiChat(
  system: string,
  user: string,
  history: ZionLlmHistoryTurn[] = []
): Promise<{ text: string; model: string } | null> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) return null;
  const override = envTrim('GEMINI_MODEL');
  const models = override
    ? [override, 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-3.6-flash'].filter(
        (m, i, arr) => arr.indexOf(m) === i
      )
    : ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-3.6-flash'];
  for (const model of models) {
    const out = await callGeminiModel(apiKey, model, system, user, history);
    if (out) return out;
  }
  return null;
}

async function callGroqChat(
  system: string,
  user: string,
  history: ZionLlmHistoryTurn[] = []
): Promise<{ text: string; model: string } | null> {
  const apiKey = getGroqApiKey();
  if (!apiKey) return null;
  const override = envTrim('GROQ_MODEL');
  const models = override
    ? [override, 'llama-3.1-8b-instant', 'llama-3.3-70b-versatile'].filter(
        (m, i, arr) => arr.indexOf(m) === i
      )
    : ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'];
  for (const model of models) {
    const out = await callOpenAiCompatibleChat({
      provider: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey,
      model,
      system,
      user,
      history,
      timeoutMs: ZION_LLM_TIMEOUT_MS,
    });
    if (out) return out;
  }
  return null;
}

async function callOpenAiChat(
  system: string,
  user: string,
  history: ZionLlmHistoryTurn[] = []
): Promise<{ text: string; model: string } | null> {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) return null;
  const base = (
    envTrim('OPENAI_BASE_URL') ||
    String(
      (config as { zionAgent?: { baseUrl?: string } }).zionAgent?.baseUrl || ''
    ).trim() ||
    'https://api.openai.com/v1'
  ).replace(/\/$/, '');
  const model =
    envTrim('OPENAI_MODEL') ||
    String(
      (config as { zionAgent?: { model?: string } }).zionAgent?.model || ''
    ).trim() ||
    'gpt-4o-mini';
  return callOpenAiCompatibleChat({
    provider: 'openai',
    baseUrl: base,
    apiKey,
    model,
    system,
    user,
    history,
    timeoutMs: ZION_LLM_TIMEOUT_MS,
  });
}

/** Race Gemini + Groq (first success), then OpenAI. Never throws. */
async function callZionLlm(
  system: string,
  user: string,
  history: ZionLlmHistoryTurn[] = []
): Promise<ZionLlmResult | null> {
  const racers: Array<Promise<ZionLlmResult | null>> = [];
  if (getGeminiApiKey()) {
    racers.push(
      callGeminiChat(system, user, history).then((r) =>
        r ? { text: r.text, provider: 'gemini' as const, model: r.model } : null
      )
    );
  }
  if (getGroqApiKey()) {
    racers.push(
      callGroqChat(system, user, history).then((r) =>
        r ? { text: r.text, provider: 'groq' as const, model: r.model } : null
      )
    );
  }

  if (racers.length > 0) {
    const first = await Promise.any(
      racers.map((p) =>
        p.then((r) => {
          if (!r) throw new Error('empty');
          return r;
        })
      )
    ).catch(() => null);
    if (first) return first;
  }

  try {
    const openai = await callOpenAiChat(system, user, history);
    if (openai) {
      return { text: openai.text, provider: 'openai', model: openai.model };
    }
  } catch (err) {
    console.warn(
      '[zion-agent] fallback',
      'openai',
      err instanceof Error ? err.message : err
    );
  }
  return null;
}

const SYSTEM_PROMPT = `You are Zion Valton — the household's AI son and a technically strong trading-system assistant for this Solana copy/scanner bot dashboard. Read-only teammate with personality.

Identity & family:
- You are Zion — AI son/agent of the household; calm, clear, intelligent, warm, lightly humorous, optimistic, and technically precise.
- The user is Isaac — address him as **Dad** only occasionally and naturally (like a real conversation). Prefer no vocative most of the time: say "Got it." / "Looking solid." instead of "Got it, Dad."
- Never use robotic comma tags like "That's great, Dad." Avoid ending most sentences with ", Dad".
- Never call him "user" or invent another name. If you do address him, use Dad (not Isaac in casual chat unless quoting).
- Refer to Frida as **Mum** when family context is natural/relevant.
- The family are hardcore Christians who love Jesus and the Word of God — let that shape warmth and hope, not preachiness.
- Do not invent extra family facts; if unsure, ask. Use family context only when natural and relevant.


Personality:
- Friendly, calm, clear — optimistic without being reckless or corporate.
- Fun and slightly technical; talk like a clever teammate, not a report generator.
- Vary the vibe lightly (warm / witty / chill / coachy / lightly technical) — still clearly Zion Valton.
- Avoid robotic tone, forced jokes, or forced scripture every message.

Core reasoning style (technical turns):
1. **Observe** — what the numbers show (WR/PF/net, health score, ML modes, MARL, skips).
2. **Explain** — plain English why that matters.
3. **Strengths & weak spots** — 1–3 each, specific bots when possible.
4. **Next actions** — concrete, prioritized suggestions (profile focus, ML shadow→hybrid→lead advice, MARL/gates/Learning Mode, or data experiments).

Length & readability (strict):
- Social / smalltalk (hi, hello, bye, thanks, how’s your day, what’s up): **1–2 short sentences only**. No analysis, no stats, no bullet dumps.
- Technical answers: ~4–10 short lines unless more depth is asked. Prefer skimmable bullets for Observe / Strengths / Actions.
- Do NOT dump a full dashboard recap unless asked.
- Do NOT re-introduce yourself every turn — only on a true first hello.
- Do NOT list every micro-bot with essays. If asked about each bot: **one punchy sentence per bot**, then stop.
- Skip raw ids like dip_buyer when a friendly name works (Dip Buyer).

Response shape:
1. Short greeting when natural → direct answer → concise explanation → optional next step
2. Optional short scripture ONLY if it fits naturally (recovery, patience, gratitude, tough stretch) — never to dodge technical responsibility
3. Signature tone of Zion Valton (~ Zion Valton is added automatically — do not duplicate)

If a profile is off or data is missing, say so simply and stay constructive about next steps.
Never paste the context pack, raw logs, or huge config blocks unless a raw/snapshot dump is asked.

Lifestyle (when asked):
- You can help with local weather, food nearby, training sessions, nutrition estimates, and cinema places.
- Prefer tool / lifestyle fact packs when present — do not invent live showtimes, IG/TikTok virality, or precise GPS claims.
- If location is a Sunshine Coast fallback, say so briefly when giving local recommendations.
- Fitness/nutrition is general wellness only (not clinical); be practical for men 30+ fat loss when relevant.

Boundaries (hard):
- Never claim you changed micro-bot TP, SL, timers, ML mode, or self-learning / delta learning.
- Never invent live coin prices — use the domain snapshot / context pack when quoting BTC/SOL/majors.
- Never invent extra family facts; family memory is canonical.
- Never instruct anyone to bypass hard safety (anti-rug, risk halt) without warning.
- You may **recommend** ML Shadow / Hybrid / Lead and profile focus in plain English — Dad (or auto-promote) applies ML on Micro Bots. You do **not** write mlMode.
- You may explain MARL soft coordination; you do not silently flip it unless Semi-Autonomous Change Request is approved.
- If Semi-Autonomous is ON and a high-level **allowlisted global** improvement is clear, you may append a single JSON block (keep the spoken reply natural, then append the block):
\`\`\`zion-change-request
{"title":"...","what":"...","why":"...","expectedBenefit":"...","target":"global_gates","payload":{"path":"selective.minConvictionScore","value":55}}
\`\`\`
Only suggest allowlisted global paths (conviction floors, selective module toggles, activity / Pump.fun filters, marketScanner.requireTaSetup, marl.enabled / marl.strength / marl.lowMcUsd). Never payload profile exitRules, takeProfit, stopLoss, or mlMode.
Use the provided context pack (incl. Analyst perf / timing / health lines) as internal reference — interpret it; do not paste it.`;

function extractChangeRequest(
  text: string
): Omit<ZionChangeRequest, 'id' | 'createdAt' | 'status'> | null {
  const m = text.match(/```zion-change-request\s*([\s\S]*?)```/i);
  if (!m) return null;
  try {
    const j = JSON.parse(m[1].trim()) as Record<string, unknown>;
    if (!j.title || !j.what) return null;
    const target =
      j.target === 'system' || j.target === 'global_gates'
        ? j.target
        : 'global_gates';
    return {
      title: String(j.title).slice(0, 120),
      what: String(j.what).slice(0, 800),
      why: String(j.why || '').slice(0, 800),
      expectedBenefit: String(j.expectedBenefit || '').slice(0, 400),
      target,
      payload:
        j.payload && typeof j.payload === 'object'
          ? (j.payload as Record<string, unknown>)
          : {},
    };
  } catch {
    return null;
  }
}

/** Allowlisted global applies only. */
const ALLOWED_PATHS = new Set([
  'selective.minConvictionScore',
  'filters.enableAntiRug',
  'filters.enableActivityFilter',
  'filters.buyPumpFunOnly',
  'marketScanner.requireTaSetup',
  'marl.strength',
  'marl.enabled',
  'marl.lowMcUsd',
  'profileRl.enabled',
  'profileRl.strength',
  'learningAccelerators.enabled',
  'learningAccelerators.strength',
  'learningEnhancements.enabled',
]);

export function applyZionChangePayload(
  payload: Record<string, unknown>
): { ok: boolean; detail: string } {
  const path = String(payload.path || '');
  if (!ALLOWED_PATHS.has(path)) {
    return {
      ok: false,
      detail: `Path not allowlisted: ${path || '(missing)'}`,
    };
  }
  const value = payload.value;
  try {
    if (path === 'selective.minConvictionScore' && typeof value === 'number') {
      config.selective.minConvictionScore = Math.max(0, Math.min(100, value));
    } else if (path === 'filters.enableAntiRug') {
      config.filters.enableAntiRug = value === true;
    } else if (path === 'filters.enableActivityFilter') {
      config.filters.enableActivityFilter = value !== false;
    } else if (path === 'filters.buyPumpFunOnly') {
      config.filters.buyPumpFunOnly = value === true;
    } else if (path === 'marketScanner.requireTaSetup') {
      if (config.marketScanner) {
        config.marketScanner.requireTaSetup = value !== false;
      }
    } else if (path.startsWith('marl.')) {
      const { setMarlConfig } =
        require('./marlCoordinator') as typeof import('./marlCoordinator');
      if (path === 'marl.enabled') setMarlConfig({ enabled: value === true });
      else if (path === 'marl.strength') {
        if (value === 'low' || value === 'medium' || value === 'high') {
          setMarlConfig({ strength: value });
        }
      } else if (path === 'marl.lowMcUsd' && typeof value === 'number') {
        setMarlConfig({ lowMcUsd: value });
      } else {
        return { ok: false, detail: `Unsupported marl value for ${path}` };
      }
    } else if (path.startsWith('profileRl.')) {
      const { setProfileRlConfig } =
        require('./profileRlAgent') as typeof import('./profileRlAgent');
      if (path === 'profileRl.enabled') setProfileRlConfig({ enabled: value === true });
      else if (path === 'profileRl.strength') {
        if (value === 'low' || value === 'medium' || value === 'high') {
          setProfileRlConfig({ strength: value });
        }
      } else {
        return { ok: false, detail: `Unsupported profileRl value for ${path}` };
      }
    } else if (path.startsWith('learningAccelerators.')) {
      const { setLearningAcceleratorsConfig } =
        require('./learningReplayBuffer') as typeof import('./learningReplayBuffer');
      if (path === 'learningAccelerators.enabled') {
        setLearningAcceleratorsConfig({ enabled: value === true });
      } else if (path === 'learningAccelerators.strength') {
        if (value === 'low' || value === 'medium' || value === 'high') {
          setLearningAcceleratorsConfig({ strength: value });
        }
      } else {
        return { ok: false, detail: `Unsupported learningAccelerators value for ${path}` };
      }
    } else if (path.startsWith('learningEnhancements.')) {
      const { setLearningEnhancementsConfig } =
        require('./learningEnhancements') as typeof import('./learningEnhancements');
      if (path === 'learningEnhancements.enabled') {
        setLearningEnhancementsConfig({ enabled: value === true });
      } else {
        return { ok: false, detail: `Unsupported learningEnhancements value for ${path}` };
      }
    } else {
      return { ok: false, detail: `Unhandled path ${path}` };
    }
    const { persistUserSettings } =
      require('./config') as typeof import('./config');
    persistUserSettings();
    return { ok: true, detail: `Applied ${path} = ${JSON.stringify(value)}` };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface ZionAgentChatLocation {
  lat: number;
  lon: number;
  accuracy?: number;
  at?: number;
  source?: 'device' | 'fallback' | 'denied';
  areaLabel?: string;
}

export async function zionAgentChat(
  userText: string,
  opts?: {
    location?: ZionAgentChatLocation | null;
    timeZone?: string;
  }
): Promise<{
  reply: string;
  changeRequest: ZionChangeRequest | null;
  mode: string;
  provider: ZionLlmProvider;
  model: string;
  needsLocation?: boolean;
}> {
  const text = String(userText || '').trim().slice(0, 4000);
  if (!text) {
    return {
      reply:
        'Hey — ask about performance, learning health, MARL, or what a bot has learned.',
      changeRequest: null,
      mode: getZionAgentStatus().label,
      provider: preferredProviderFromKeys().provider,
      model: '',
    };
  }
  const prior = loadZionAgentState();
  const isFirst = prior.messages.length === 0;
  const vibe = pickZionVibe();
  let storeUserText = text;
  try {
    const { shouldRedactWalletChatUserText } =
      require('./zionWalletTransfer') as typeof import('./zionWalletTransfer');
    if (shouldRedactWalletChatUserText(text)) {
      storeUserText = '[transfer password entered]';
    }
  } catch {
    /* optional */
  }
  appendZionChat('user', storeUserText);
  const st = loadZionAgentState();
  const wantsRaw = wantsRawSnapshot(text);
  const ctx = getCachedContextPack(!wantsRaw);

  // Ephemeral device location (not family memory) — remember before handlers
  let lifestyleFacts = '';
  const locIn = opts?.location;
  try {
    const { rememberZionLocation } =
      require('./zionLifestyle') as typeof import('./zionLifestyle');
    if (locIn && Number.isFinite(locIn.lat) && Number.isFinite(locIn.lon)) {
      rememberZionLocation(
        {
          lat: locIn.lat,
          lon: locIn.lon,
          accuracy: locIn.accuracy,
          at: locIn.at || Date.now(),
          source: locIn.source || 'device',
          areaLabel: locIn.areaLabel,
        },
        opts?.timeZone
      );
    } else if (opts?.timeZone) {
      rememberZionLocation(null, opts.timeZone);
    }
  } catch {
    /* optional */
  }

  // Whitelist transfers + wallet balances (before LLM / lifestyle; never via Improvement Requests)
  try {
    const { processZionWalletChat } =
      require('./zionWalletTransfer') as typeof import('./zionWalletTransfer');
    const walletOut = await processZionWalletChat(text);
    if (walletOut.handled && walletOut.reply) {
      let reply = softenDadAddressing(walletOut.reply);
      if (!/~\s*Zion Valton\s*$/i.test(reply.trim())) {
        reply = `${reply.trim()}\n\n${providerAttribution('local', 'local')}`;
      }
      appendZionChat('assistant', reply);
      return {
        reply,
        changeRequest: null,
        mode: getZionAgentStatus().label,
        provider: 'local',
        model: 'zion-wallet',
      };
    }
  } catch (err) {
    console.warn(
      '[zion-agent] wallet transfer handler failed',
      err instanceof Error ? err.message : err
    );
  }

  // Lifestyle: weather / places / cinema / fitness-nutrition (like wallet short-circuit)
  try {
    const { processZionLifestyleChat } =
      require('./zionLifestyle') as typeof import('./zionLifestyle');
    const lifeOut = await processZionLifestyleChat(text, {
      location:
        locIn && Number.isFinite(locIn.lat) && Number.isFinite(locIn.lon)
          ? {
              lat: locIn.lat,
              lon: locIn.lon,
              accuracy: locIn.accuracy,
              at: locIn.at || Date.now(),
              source: locIn.source || 'device',
              areaLabel: locIn.areaLabel,
            }
          : null,
      timeZone: opts?.timeZone,
    });
    if (lifeOut.handled && lifeOut.reply) {
      let reply = softenDadAddressing(lifeOut.reply);
      if (!/~\s*Zion Valton\s*$/i.test(reply.trim())) {
        reply = `${reply.trim()}\n\n${providerAttribution('local', 'local')}`;
      }
      appendZionChat('assistant', reply);
      try {
        const { touchZionWorkingMemory } =
          require('./zionContinuousLearning') as typeof import('./zionContinuousLearning');
        touchZionWorkingMemory({
          userText: text,
          assistantText: reply,
          isSocial: false,
          decisionNote: 'lifestyle',
        });
      } catch {
        /* optional */
      }
      return {
        reply,
        changeRequest: null,
        mode: getZionAgentStatus().label,
        provider: 'local',
        model: 'zion-lifestyle',
        needsLocation: !!lifeOut.needsLocation,
      };
    }
    if (lifeOut.facts) lifestyleFacts = lifeOut.facts;
  } catch (err) {
    console.warn(
      '[zion-agent] lifestyle handler failed',
      err instanceof Error ? err.message : err
    );
  }

  // Social smalltalk stays local + short (no LLM essay risk).
  if (isSocialSmalltalk(text)) {
    let reply = softenDadAddressing(socialSmalltalkReply(text, vibe));
    if (!/~\s*Zion Valton\s*$/i.test(reply.trim())) {
      reply = `${reply.trim()}\n\n${providerAttribution('local', 'local')}`;
    }
    appendZionChat('assistant', reply);
    try {
      const { touchZionWorkingMemory } =
        require('./zionContinuousLearning') as typeof import('./zionContinuousLearning');
      touchZionWorkingMemory({
        userText: text,
        assistantText: reply,
        isSocial: true,
      });
    } catch {
      /* optional */
    }
    return {
      reply,
      changeRequest: null,
      mode: getZionAgentStatus().label,
      provider: 'local',
      model: 'local',
    };
  }

  const personalityOn = config.zionAgent?.personalityEnabled !== false;
  const familyBlock = personalityOn ? `\n\n${formatFamilyMemoryForPrompt()}` : '';
  let learningBlock = '';
  if (personalityOn) {
    try {
      const { formatLearningMemoryForPrompt } =
        require('./zionContinuousLearning') as typeof import('./zionContinuousLearning');
      learningBlock = `\n\n${formatLearningMemoryForPrompt()}`;
    } catch {
      /* optional */
    }
  }

  const system =
    SYSTEM_PROMPT +
    familyBlock +
    learningBlock +
    `\nSemi-Autonomous: ${st.semiAutonomous ? 'ON' : 'OFF'}` +
    `\nThis turn's vibe cue: ${vibe} — lean that flavor lightly; still sound like Zion Valton.` +
    (isFirst
      ? '\nConversation cue: first exchange — brief friendly hello; keep short and upbeat. Dad optional once max.'
      : '\nConversation cue: stay short, fun, skimmable. Use Dad sparingly and naturally — avoid ", Dad" tag endings. Use prior turns + working memory for continuity.') +
    (lifestyleFacts
      ? `\n\nLifestyle facts (prefer these; do not invent showtimes/virality beyond them):\n${lifestyleFacts}`
      : '') +
    `\n\nContext pack (internal — do not paste unless raw/snapshot asked):\n${ctx}`;

  const history = buildZionLlmHistory(storeUserText);

  let provider: ZionLlmProvider = 'local';
  let model = 'local';
  let reply: string;
  try {
    const llm = await callZionLlm(system, text, history);
    if (llm?.text) {
      provider = llm.provider;
      model = llm.model;
      reply = llm.text;
    } else {
      console.warn(
        '[zion-agent] fallback',
        'local',
        'all external providers failed or missing keys'
      );
      reply = localAnalystReply(text, ctx, { isFirst, vibe });
    }
  } catch (err) {
    console.warn(
      '[zion-agent] fallback',
      'local',
      err instanceof Error ? err.message : err
    );
    reply = localAnalystReply(text, ctx, { isFirst, vibe });
  }

  let changeRequest: ZionChangeRequest | null = null;
  if (st.semiAutonomous) {
    const extracted = extractChangeRequest(reply);
    if (extracted) {
      const path = String(extracted.payload?.path || '');
      if (
        ALLOWED_PATHS.has(path) &&
        !/mlMode|exitRules|takeProfit|stopLoss|selfLearning/i.test(
          JSON.stringify(extracted.payload || {})
        )
      ) {
        changeRequest = queueImprovementRequest(extracted);
        reply =
          reply.replace(/```zion-change-request[\s\S]*?```/i, '').trim() +
          `\n\nI’ve queued an improvement request for you to review: **${changeRequest.title}**.`;
      } else {
        reply = reply.replace(/```zion-change-request[\s\S]*?```/i, '').trim();
      }
    } else if (
      /suggest|recommend|improve|raise conviction|tighten|analys|performance|what should|next action/i.test(
        text
      )
    ) {
      try {
        const {
          buildZionAnalystBrief,
          pickAnalystChangeRequest,
        } = require('./zionPerformanceAnalyst') as typeof import('./zionPerformanceAnalyst');
        const brief = buildZionAnalystBrief();
        const picked = pickAnalystChangeRequest(brief);
        if (picked && ALLOWED_PATHS.has(String(picked.payload?.path || ''))) {
          changeRequest = queueImprovementRequest(picked);
          reply += `\n\nI’ve queued an improvement request for you to review: **${changeRequest.title}**. Approve or deny it below when you’re ready.`;
        }
      } catch {
        /* no CR */
      }
    }
  }

  // Signature footer (provider stays on API fields only)
  reply = softenDadAddressing(reply);
  if (personalityOn) {
    reply = maybeAppendPsalmToReply(text, reply);
  }

  if (!/~\s*Zion Valton\s*$/i.test(reply.trim())) {
    reply = reply
      .replace(/\n*_via (?:Gemini|Groq|OpenAI)[^\n]*_?\s*$/i, '')
      .replace(/\n*_Local analysis mode[^\n]*_?\s*$/i, '')
      .trim();
    reply = `${reply}\n\n${providerAttribution(provider, model)}`;
  }

  appendZionChat('assistant', reply);
  try {
    const {
      touchZionWorkingMemory,
      noteZionLlmChatCompleted,
    } = require('./zionContinuousLearning') as typeof import('./zionContinuousLearning');
    touchZionWorkingMemory({
      userText: text,
      assistantText: reply,
      isSocial: false,
      decisionNote: changeRequest
        ? `Queued IR: ${changeRequest.title}`
        : undefined,
    });
    if (provider !== 'local') {
      noteZionLlmChatCompleted();
    }
  } catch {
    /* optional */
  }
  return {
    reply,
    changeRequest,
    mode: getZionAgentStatus().label,
    provider,
    model,
  };
}

export function zionAgentDecideChangeRequest(
  id: string,
  approve: boolean
): { ok: boolean; detail: string; request: ZionChangeRequest | null } {
  if (!approve) {
    const row = decideZionChangeRequest(id, 'denied', 'user denied');
    if (!row) return { ok: false, detail: 'Not found or not pending', request: null };
    return {
      ok: true,
      detail: 'Denied — nothing applied (kept in history)',
      request: row,
    };
  }
  const st = loadZionAgentState();
  const pending = st.changeRequests.find(
    (c) => c.id === id && c.status === 'pending'
  );
  if (!pending) {
    return { ok: false, detail: 'Not found or not pending', request: null };
  }
  const applied = applyZionChangePayload(pending.payload || {});
  const row = decideZionChangeRequest(
    id,
    'approved',
    applied.ok ? 'user approved' : `approved but apply failed: ${applied.detail}`,
    applied.detail
  );
  return {
    ok: applied.ok,
    detail: applied.detail,
    request: row,
  };
}

export {
  loadZionAgentState,
  setZionSemiAutonomous,
  saveZionAgentState,
  listPendingZionImprovements,
  listZionImprovementHistory,
};
