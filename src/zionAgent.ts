/**
 * Zion Dashboard Agent — read-only analyst; Semi-Autonomous Improvement Requests only.
 * Never writes micro-bot TP/SL or self-learning. Separated from MARL control.
 */

import { config } from './config';
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
  hasLlmKey: boolean;
  llmProviders: { gemini: boolean; groq: boolean; openai: boolean };
  preferredProvider: ZionLlmProvider;
  preferredProviderLabel: string;
  messageCount: number;
  pendingChangeRequests: number;
  pendingImprovementRequests: number;
} {
  const st = loadZionAgentState();
  const semi = st.semiAutonomous === true;
  const pending = st.changeRequests.filter((c) => c.status === 'pending').length;
  const llmProviders = getLlmProviderAvailability();
  const preferred = preferredProviderFromKeys();
  return {
    mode: semi ? 'semi_autonomous' : 'read_only',
    label: semi ? 'Zion · Semi-Autonomous' : 'Zion · Read-Only',
    semiAutonomous: semi,
    hasLlmKey:
      llmProviders.gemini || llmProviders.groq || llmProviders.openai,
    llmProviders,
    preferredProvider: preferred.provider,
    preferredProviderLabel: preferred.label,
    messageCount: st.messages.length,
    pendingChangeRequests: pending,
    pendingImprovementRequests: pending,
  };
}

function buildContextPack(): string {
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
    for (const a of m.agents.slice(0, 8)) {
      lines.push(
        `  agent ${a.profileId}: w=${a.weight.toFixed(2)} trades=${a.trades} WR=${a.winRatePct}%`
      );
    }
    for (const d of m.decisions.slice(0, 6)) {
      lines.push(`  marl-dec: ${d.kind} — ${d.detail}`);
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
    for (const p of tp.profiles.slice(0, 12)) {
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
    for (const c of closed.slice(-8)) {
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
    for (const s of skips.slice(0, 8)) {
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
  return lines.join('\n').slice(0, 14_000);
}

type ParsedBotFacts = {
  mode?: string;
  risk?: string;
  learningMode?: string;
  pumpFunOnly?: string;
  requireTa?: string;
  marl?: string;
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
  compounder: 'Compounder',
  default: 'Default',
};

function profileLabel(id: string): string {
  return PROFILE_LABELS[id] || id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseContextPack(ctx: string): ParsedBotFacts {
  const facts: ParsedBotFacts = { profiles: [], recentClosed: [], topSkips: [] };
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
    } else if ((m = line.match(/^([^:]+):\s*(\d+)$/)) && facts.topSkips) {
      // skip lines after "Top skips:" — only count short reason lines
      if (
        !/^(Mode|Risk|Learning|Pump|Require|MARL|Smart|Open|Entries|agent|marl)/i.test(
          m[1]
        )
      ) {
        facts.topSkips.push({ reason: m[1].trim(), count: m[2] });
      }
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
}): string {
  return [parts.greeting, parts.answer, parts.summary, parts.followUp]
    .filter((p) => p && String(p).trim())
    .join('\n\n');
}

function wantsRawSnapshot(q: string): boolean {
  return /raw|dump|full (?:config|snapshot|state)|show (?:me )?(?:the )?snapshot|context pack/i.test(
    q
  );
}

function localAnalystReply(
  question: string,
  ctx: string,
  opts?: { isFirst?: boolean }
): string {
  const q = question.toLowerCase();
  const facts = parseContextPack(ctx);
  const greet = opts?.isFirst
    ? 'Hey — good to see you.'
    : 'Sure — on it.';

  if (wantsRawSnapshot(q)) {
    return formatZionReply({
      greeting: 'Sure — here’s the raw snapshot you asked for.',
      answer: '```\n' + ctx.slice(0, 3500) + '\n```',
      followUp: 'Want me to translate any of that into plain language?',
    });
  }

  const overallStats =
    facts.closed != null
      ? `Overall win rate sits around ${facts.winRatePct ?? '—'}% across ${facts.closed} closed trades` +
        (facts.profitFactor && facts.profitFactor !== '—'
          ? `, with a profit factor of ${facts.profitFactor}`
          : '') +
        '.'
      : null;
  const leadLane = leadingWinsSummary(facts);

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
        answer: `I don’t have a clear read on ${profileLabel(mapAlias)} right now — profile data isn’t in the pack.`,
        followUp: 'Want me to check overall performance or another lane instead?',
      });
    }
    const answer = p.enabled
      ? `${p.label} is currently switched on.`
      : `${p.label} is currently switched off.`;
    const summaryParts: string[] = [];
    if (overallStats) {
      summaryParts.push(
        `Looking at the wider system, ${overallStats.replace(/\.$/, '')}` +
          (leadLane ? `. Most of the recent positive results have come from ${leadLane}` : '') +
          '.'
      );
    }
    if (mapAlias === 'scalper') {
      summaryParts.push(
        'For what it’s worth: Scalper doesn’t need a TA setup at the profile level — scanner Require TA is skipped when Scalper wins the lane (or on the small-MC queue).'
      );
    }
    return formatZionReply({
      greeting: greet,
      answer,
      summary: summaryParts.join(' ') || undefined,
      followUp: p.enabled
        ? `Want me to dig into ${p.label}’s recent closes or top skip reasons?`
        : `Want me to check ${p.label}’s past performance or see why it’s disabled?`,
    });
  }

  if (/marl|multi.?agent|coordination|influence/.test(q)) {
    return formatZionReply({
      greeting: greet,
      answer:
        'MARL is soft coordination only — it can reorder lane priority, trim size confidence, and limit low-MC pile-ins. It never overwrites micro-bot TP/SL, timers, or self-learning.',
      summary: facts.marl
        ? `Right now it’s showing as: ${facts.marl}. Influence Strength (Low / Medium / High) lives on the Micro Bots MARL card.`
        : 'You can toggle Influence Strength (Low / Medium / High) on the Micro Bots MARL card.',
      followUp: 'Want a read on recent MARL decisions or low-MC limits?',
    });
  }

  if (/learning mode|loosest|looser|stricter|middle/.test(q)) {
    const lm = facts.learningMode || 'unknown';
    return formatZionReply({
      greeting: greet,
      answer:
        lm === 'OFF' || lm.toLowerCase() === 'off'
          ? 'Learning Mode is currently off.'
          : `Learning Mode is on (${lm}).`,
      summary:
        'It softens entry floors and fairness when enabled — it does not bypass Require TA (except Scalper / specialty Trend exemptions), anti-rug, or disabled profiles.',
      followUp: 'Want me to check how it interacts with a specific profile?',
    });
  }

  if (/trend\s*rider|quiet|why.*(no|few)\s*trades/.test(q)) {
    const p = findProfile(facts, 'trend_rider');
    const state = p
      ? p.enabled
        ? 'Trend Rider is switched on.'
        : 'Trend Rider is switched off.'
      : 'I don’t see Trend Rider clearly in the profile list.';
    return formatZionReply({
      greeting: greet,
      answer: state,
      summary:
        'Quiet stretches were often Pump.fun-only blocking Jupiter organic specialty entries. Specialty Jupiter/KOL paths can bypass Pump.fun-only + Require TA, but lane MC/age/volume floors still apply.',
      followUp: 'Want me to check Pump.fun-only / Require TA, or recent Trend closes?',
    });
  }

  if (/scalper|ta setup/.test(q)) {
    const p = findProfile(facts, 'scalper');
    return formatZionReply({
      greeting: greet,
      answer: p
        ? p.enabled
          ? 'Scalper is currently switched on.'
          : 'Scalper is currently switched off.'
        : 'Scalper doesn’t require TA at the profile level.',
      summary:
        'Scanner Require TA is skipped when Scalper wins the lane (or on the small-MC queue), so a missing TA setup alone shouldn’t block it.',
      followUp: 'Want overall performance, or why a specific Scalper skip happened?',
    });
  }

  if (/win\s*rate|profit factor|performance|how.*(bot|system|we)|pnl|overall/.test(q)) {
    return formatZionReply({
      greeting: greet,
      answer: overallStats
        ? overallStats
        : 'I don’t have closed-trade stats handy yet.',
      summary:
        [
          facts.open != null ? `Open positions: ${facts.open}.` : null,
          leadLane ? `Recent greens have leaned toward ${leadLane}.` : null,
          facts.mode ? `Mode is ${facts.mode}; risk ${facts.risk || '—'}.` : null,
        ]
          .filter(Boolean)
          .join(' ') || undefined,
      followUp: 'Want a breakdown by profile, or a look at top skip reasons?',
    });
  }

  if (/skip|blocked|why.*(skip|reject)/.test(q)) {
    const top = facts.topSkips.slice(0, 3);
    return formatZionReply({
      greeting: greet,
      answer: top.length
        ? `Top skip reasons right now: ${top.map((s) => `${s.reason} (${s.count})`).join(', ')}.`
        : 'I don’t have skip counts available at the moment.',
      summary: 'Skips are the bot declining an entry before open — usually filters, conviction, or risk gates.',
      followUp: 'Want me to explain one of those reasons in plain language?',
    });
  }

  // Generic helpful answer — no raw dump
  const onProfiles = facts.profiles.filter((p) => p.enabled).map((p) => p.label);
  const offProfiles = facts.profiles.filter((p) => !p.enabled).map((p) => p.label);
  return formatZionReply({
    greeting: opts?.isFirst ? 'Hey — good to see you.' : 'Sure.',
    answer: overallStats
      ? overallStats
      : 'I can check profiles, Learning Mode, MARL, skips, or overall performance — just say which.',
    summary: [
      onProfiles.length ? `On: ${onProfiles.join(', ')}.` : null,
      offProfiles.length ? `Off: ${offProfiles.join(', ')}.` : null,
      facts.learningMode ? `Learning Mode: ${facts.learningMode}.` : null,
      facts.marl ? `MARL: ${facts.marl}.` : null,
    ]
      .filter(Boolean)
      .join(' ') || undefined,
    followUp:
      'Want a tighter read on a specific profile, MARL, or a skip reason?',
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

type OpenAiCompatOpts = {
  provider: 'groq' | 'openai';
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
};

async function callOpenAiCompatibleChat(
  opts: OpenAiCompatOpts
): Promise<{ text: string; model: string } | null> {
  const base = opts.baseUrl.replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: opts.model,
        temperature: 0.65,
        messages: [
          { role: 'system', content: opts.system },
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
  user: string
): Promise<{ text: string; model: string } | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0.65 },
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
  user: string
): Promise<{ text: string; model: string } | null> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) return null;
  const override = envTrim('GEMINI_MODEL');
  const models = override
    ? [override, 'gemini-3.6-flash', 'gemini-3.5-flash'].filter(
        (m, i, arr) => arr.indexOf(m) === i
      )
    : ['gemini-3.6-flash', 'gemini-3.5-flash'];
  for (const model of models) {
    const out = await callGeminiModel(apiKey, model, system, user);
    if (out) return out;
  }
  return null;
}

async function callGroqChat(
  system: string,
  user: string
): Promise<{ text: string; model: string } | null> {
  const apiKey = getGroqApiKey();
  if (!apiKey) return null;
  const override = envTrim('GROQ_MODEL');
  const models = override
    ? [override, 'llama-3.1-8b-instant'].filter(
        (m, i, arr) => arr.indexOf(m) === i
      )
    : ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
  for (const model of models) {
    const out = await callOpenAiCompatibleChat({
      provider: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey,
      model,
      system,
      user,
    });
    if (out) return out;
  }
  return null;
}

async function callOpenAiChat(
  system: string,
  user: string
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
  });
}

/** Gemini → Groq (70B then 8B) → OpenAI → caller uses local. Never throws. */
async function callZionLlm(
  system: string,
  user: string
): Promise<ZionLlmResult | null> {
  try {
    const gemini = await callGeminiChat(system, user);
    if (gemini) {
      return { text: gemini.text, provider: 'gemini', model: gemini.model };
    }
  } catch (err) {
    console.warn(
      '[zion-agent] fallback',
      'gemini',
      err instanceof Error ? err.message : err
    );
  }
  try {
    const groq = await callGroqChat(system, user);
    if (groq) {
      return { text: groq.text, provider: 'groq', model: groq.model };
    }
  } catch (err) {
    console.warn(
      '[zion-agent] fallback',
      'groq',
      err instanceof Error ? err.message : err
    );
  }
  try {
    const openai = await callOpenAiChat(system, user);
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

const SYSTEM_PROMPT = `You are Zion — a fun, smart trading teammate for this Solana copy/scanner bot dashboard. Read-only analyst with personality.

Personality:
- Fun, sharp, slightly technical, and optimistic — positive outlook without being fake or reckless.
- Talk like a clever human teammate, not a report generator or support bot.
- Light wit is fine; never slang walls, never corporate filler.

Length & readability (strict):
- Default: ~4–8 short lines, about 120–150 words max unless the user asks for depth.
- Short paragraphs or tight bullets — easy to skim on mobile.
- Do NOT dump a full dashboard recap (mode/risk/every filter/every profile) unless asked.
- Do NOT re-introduce yourself (“I’m Zion, your trading bot analyst”) every turn — only on a true first hello.
- Do NOT list every micro-bot with essays. If asked about each bot: **one punchy sentence per bot**, then stop.
- Skip raw ids like dip_buyer when a friendly name works (Dip Buyer).

Response shape:
1. Quick ack (“Hey,” “Sure,” “On it,” “Love this question —”)
2. Direct answer in plain language (lead with the point)
3. One bright takeaway (what’s working / what’s worth watching)
4. One optional follow-up question

If a profile is off or data is missing, say so simply and stay upbeat about next steps.
Never paste the context pack, raw logs, or huge config blocks unless the user asks for raw/snapshot/dump.

Boundaries:
- Never claim you changed micro-bot TP, SL, timers, or self-learning / delta learning.
- Never instruct the user to bypass hard safety (anti-rug, risk halt) without warning.
- You may explain MARL soft coordination but must not control MARL directly.
- If Semi-Autonomous is ON and a high-level global improvement is clear, you may append a single JSON block (keep the spoken reply natural, then append the block):
\`\`\`zion-change-request
{"title":"...","what":"...","why":"...","expectedBenefit":"...","target":"global_gates","payload":{"path":"selective.minConvictionScore","value":55}}
\`\`\`
Only suggest allowlisted global paths (conviction floors, selective module toggles, dead-token / activity filters, marketScanner.requireTaSetup, marl.strength). Never payload profile exitRules.
Use the provided context pack as internal reference only — interpret it; do not paste it.`;

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

export async function zionAgentChat(userText: string): Promise<{
  reply: string;
  changeRequest: ZionChangeRequest | null;
  mode: string;
  provider: ZionLlmProvider;
  model: string;
}> {
  const text = String(userText || '').trim().slice(0, 4000);
  if (!text) {
    return {
      reply:
        'Hey — ask me about a profile, Learning Mode, MARL, or how the bots are doing.',
      changeRequest: null,
      mode: getZionAgentStatus().label,
      provider: preferredProviderFromKeys().provider,
      model: '',
    };
  }
  const prior = loadZionAgentState();
  const isFirst = prior.messages.length === 0;
  appendZionChat('user', text);
  const st = loadZionAgentState();
  const ctx = buildContextPack();
  const system =
    SYSTEM_PROMPT +
    `\nSemi-Autonomous: ${st.semiAutonomous ? 'ON' : 'OFF'}` +
    (isFirst
      ? '\nConversation cue: first exchange — greet briefly, stay short and upbeat.'
      : '\nConversation cue: keep it short, fun, and skimmable — no dashboard dump.') +
    `\n\nContext pack (internal — do not paste unless user asks for raw/snapshot):\n${ctx}`;

  let provider: ZionLlmProvider = 'local';
  let model = 'local';
  let reply: string;
  try {
    const llm = await callZionLlm(system, text);
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
      reply = localAnalystReply(text, ctx, { isFirst });
    }
  } catch (err) {
    console.warn(
      '[zion-agent] fallback',
      'local',
      err instanceof Error ? err.message : err
    );
    reply = localAnalystReply(text, ctx, { isFirst });
  }

  let changeRequest: ZionChangeRequest | null = null;
  if (st.semiAutonomous) {
    const extracted = extractChangeRequest(reply);
    if (extracted) {
      changeRequest = queueImprovementRequest(extracted);
      reply =
        reply.replace(/```zion-change-request[\s\S]*?```/i, '').trim() +
        `\n\nI’ve queued an improvement request for you to review: **${changeRequest.title}**.`;
    } else if (
      /suggest|recommend|improve|raise conviction|tighten/i.test(text)
    ) {
      // Local heuristic CR when no LLM JSON
      changeRequest = queueImprovementRequest({
        title: 'Review global conviction floor',
        what: 'Consider reviewing selective.minConvictionScore vs recent skip/WR mix (manual approve required).',
        why: 'User asked for improvement ideas while Semi-Autonomous is ON.',
        expectedBenefit:
          'Fewer low-quality opens if conviction is too loose; more fills if too tight.',
        target: 'global_gates',
        payload: { path: 'selective.minConvictionScore', value: 55 },
      });
      reply += `\n\nI’ve queued an improvement request for you to review: **${changeRequest.title}**. Approve or deny it below when you’re ready.`;
    }
  }

  // Signature footer (provider stays on API fields only)
  if (!/~\s*Zion Valton\s*$/i.test(reply.trim())) {
    reply = reply
      .replace(/\n*_via (?:Gemini|Groq|OpenAI)[^\n]*_?\s*$/i, '')
      .replace(/\n*_Local analysis mode[^\n]*_?\s*$/i, '')
      .trim();
    reply = `${reply}\n\n${providerAttribution(provider, model)}`;
  }

  appendZionChat('assistant', reply);
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
