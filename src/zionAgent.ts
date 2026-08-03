/**
 * Zion Dashboard Agent — read-only analyst; Semi-Autonomous Change Requests only.
 * Never writes micro-bot TP/SL or self-learning. Separated from MARL control.
 */

import { config } from './config';
import {
  addZionChangeRequest,
  appendZionChat,
  decideZionChangeRequest,
  loadZionAgentState,
  saveZionAgentState,
  setZionSemiAutonomous,
  type ZionChangeRequest,
} from './zionAgentStore';

export function getZionAgentStatus(): {
  mode: 'read_only' | 'semi_autonomous';
  label: string;
  semiAutonomous: boolean;
  hasLlmKey: boolean;
  messageCount: number;
  pendingChangeRequests: number;
} {
  const st = loadZionAgentState();
  const semi = st.semiAutonomous === true;
  return {
    mode: semi ? 'semi_autonomous' : 'read_only',
    label: semi ? 'Zion · Semi-Autonomous' : 'Zion · Read-Only',
    semiAutonomous: semi,
    hasLlmKey: Boolean(
      (process.env.OPENAI_API_KEY || '').trim() ||
        (config as { zionAgent?: { apiKey?: string } }).zionAgent?.apiKey
    ),
    messageCount: st.messages.length,
    pendingChangeRequests: st.changeRequests.filter((c) => c.status === 'pending')
      .length,
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

function localAnalystReply(question: string, ctx: string): string {
  const q = question.toLowerCase();
  const bits: string[] = [];
  bits.push('**(Local analysis mode — no OpenAI key)**');
  bits.push('');
  if (/marl|multi.?agent|coordination|influence/.test(q)) {
    bits.push(
      'MARL softly reorders lane scores and may trim size / skip pile-ins on low-MC tokens. It never edits micro-bot TP/SL or self-learning. Influence Strength is Low / Medium / High on the Micro Bots MARL card.'
    );
  }
  if (/learning mode|loosest|looser/.test(q)) {
    bits.push(
      'Learning Mode softens entry floors and fairness; it does not bypass Require TA (except Scalper / specialty Trend exemptions), anti-rug, or disabled profiles.'
    );
  }
  if (/trend|quiet|no trades|win/.test(q)) {
    bits.push(
      'Quiet Trend Rider was often Pump.fun-only vs Jupiter organic specialty. Specialty Jupiter/KOL can bypass Pump.fun-only + Require TA; lane MC/age/vol floors still apply.'
    );
  }
  if (/scalper|ta setup/.test(q)) {
    bits.push(
      'Scalper does not require TA at the profile level; scanner Require TA is skipped when Scalper wins (or small-MC queue).'
    );
  }
  bits.push('');
  bits.push('### Snapshot');
  bits.push('```');
  bits.push(ctx.slice(0, 3500));
  bits.push('```');
  bits.push('');
  bits.push(
    'Ask about a profile, MARL decision, or skip reason for a tighter read. Semi-Autonomous mode can propose global gate Change Requests for your Approve/Reject — never auto-applied.'
  );
  return bits.join('\n');
}

async function callOpenAiChat(
  system: string,
  user: string
): Promise<string | null> {
  const apiKey =
    (process.env.OPENAI_API_KEY || '').trim() ||
    String(
      (config as { zionAgent?: { apiKey?: string } }).zionAgent?.apiKey || ''
    ).trim();
  if (!apiKey) return null;
  const base = (
    process.env.OPENAI_BASE_URL ||
    (config as { zionAgent?: { baseUrl?: string } }).zionAgent?.baseUrl ||
    'https://api.openai.com/v1'
  ).replace(/\/$/, '');
  const model =
    process.env.OPENAI_MODEL ||
    (config as { zionAgent?: { model?: string } }).zionAgent?.model ||
    'gpt-4o-mini';
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.warn('[zion-agent] LLM HTTP', res.status, t.slice(0, 200));
      return null;
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return String(data.choices?.[0]?.message?.content || '').trim() || null;
  } catch (err) {
    console.warn(
      '[zion-agent] LLM failed:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

const SYSTEM_PROMPT = `You are Zion, a read-only analyst for a Solana copy/scanner trading bot dashboard.
Boundaries:
- Never claim you changed micro-bot TP, SL, timers, or self-learning / delta learning.
- Never instruct the user to bypass hard safety (anti-rug, risk halt) without warning.
- You may explain MARL soft coordination but must not control MARL directly.
- If Semi-Autonomous is ON and a high-level global improvement is clear, you may append a single JSON block:
\`\`\`zion-change-request
{"title":"...","what":"...","why":"...","expectedBenefit":"...","target":"global_gates","payload":{"path":"filters.minConviction","value":55}}
\`\`\`
Only suggest allowlisted global paths (conviction floors, selective module toggles, dead-token / activity filters, marketScanner.requireTaSetup, marl.strength). Never payload profile exitRules.
Be concise and practical. Use the provided context pack.`;

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
}> {
  const text = String(userText || '').trim().slice(0, 4000);
  if (!text) {
    return {
      reply: 'Ask a question about the bot, profiles, MARL, or performance.',
      changeRequest: null,
      mode: getZionAgentStatus().label,
    };
  }
  appendZionChat('user', text);
  const st = loadZionAgentState();
  const ctx = buildContextPack();
  const system =
    SYSTEM_PROMPT +
    `\nSemi-Autonomous: ${st.semiAutonomous ? 'ON' : 'OFF'}\n\nContext pack:\n${ctx}`;
  let reply =
    (await callOpenAiChat(system, text)) || localAnalystReply(text, ctx);
  let changeRequest: ZionChangeRequest | null = null;
  if (st.semiAutonomous) {
    const extracted = extractChangeRequest(reply);
    if (extracted) {
      changeRequest = addZionChangeRequest(extracted);
      reply =
        reply.replace(/```zion-change-request[\s\S]*?```/i, '').trim() +
        `\n\n_Change Request queued for your Approve/Reject: **${changeRequest.title}**_`;
    } else if (
      /suggest|recommend|improve|raise conviction|tighten/i.test(text)
    ) {
      // Local heuristic CR when no LLM JSON
      changeRequest = addZionChangeRequest({
        title: 'Review global conviction floor',
        what: 'Consider reviewing filters.minConviction vs recent skip/WR mix (manual approve required).',
        why: 'User asked for improvement ideas while Semi-Autonomous is ON.',
        expectedBenefit: 'Fewer low-quality opens if conviction is too loose; more fills if too tight.',
        target: 'global_gates',
        payload: { path: 'selective.minConvictionScore', value: 55 },
      });
      reply += `\n\n_Queued Change Request: **${changeRequest.title}** (Approve/Reject below)._`;
    }
  }
  appendZionChat('assistant', reply);
  return { reply, changeRequest, mode: getZionAgentStatus().label };
}

export function zionAgentDecideChangeRequest(
  id: string,
  approve: boolean
): { ok: boolean; detail: string; request: ZionChangeRequest | null } {
  const row = decideZionChangeRequest(
    id,
    approve ? 'approved' : 'rejected',
    approve ? 'user approved' : 'user rejected'
  );
  if (!row) return { ok: false, detail: 'Not found or not pending', request: null };
  if (!approve) {
    return { ok: true, detail: 'Rejected — nothing applied', request: row };
  }
  const applied = applyZionChangePayload(row.payload || {});
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
};
