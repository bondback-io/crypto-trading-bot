/**
 * Soft multi-agent coordinator — PPO-style clipped preference weights.
 * Influences lane ranking, entry size confidence, and low-MC pile-in rules only.
 * Never mutates TP/SL, timers, or profile self-learning overrides.
 */

import { config } from './config';
import {
  getMarlDecisions,
  getOrCreateAgent,
  getRecentLowMcOpens,
  loadMarlState,
  pushMarlDecision,
  recordLowMcOpen,
  saveMarlState,
  type MarlAgentState,
  type MarlStrength,
} from './marlStore';

export type MarlEventKind = 'entry_intent' | 'trade_result' | 'perf_snapshot';

export interface MarlEvent {
  kind: MarlEventKind;
  at: number;
  mint?: string;
  symbol?: string;
  profileId?: string;
  payload?: Record<string, unknown>;
}

type MarlListener = (ev: MarlEvent) => void;

const listeners = new Set<MarlListener>();

export function marlSubscribe(fn: MarlListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function marlPublish(ev: Omit<MarlEvent, 'at'> & { at?: number }): void {
  const full: MarlEvent = { ...ev, at: ev.at ?? Date.now() };
  for (const fn of listeners) {
    try {
      fn(full);
    } catch {
      /* isolate */
    }
  }
}

export interface MarlConfig {
  enabled: boolean;
  strength: MarlStrength;
  lowMcUsd: number;
  lowMcWindowMin: number;
  maxAgentsPerLowMc: number;
}

export const DEFAULT_MARL_CONFIG: MarlConfig = {
  enabled: false,
  strength: 'medium',
  lowMcUsd: 175_000,
  lowMcWindowMin: 10,
  maxAgentsPerLowMc: 1,
};

export function getMarlConfig(): MarlConfig {
  const m = (config as { marl?: Partial<MarlConfig> }).marl;
  const strength =
    m?.strength === 'low' || m?.strength === 'high' || m?.strength === 'medium'
      ? m.strength
      : 'medium';
  return {
    enabled: m?.enabled === true,
    strength,
    lowMcUsd: Math.max(10_000, Number(m?.lowMcUsd) || 175_000),
    lowMcWindowMin: Math.max(1, Math.min(120, Number(m?.lowMcWindowMin) || 10)),
    maxAgentsPerLowMc: Math.max(
      1,
      Math.min(5, Math.round(Number(m?.maxAgentsPerLowMc) || 1))
    ),
  };
}

export function setMarlConfig(patch: Partial<MarlConfig>): MarlConfig {
  const cur = getMarlConfig();
  const next: MarlConfig = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
    strength:
      patch.strength === 'low' ||
      patch.strength === 'medium' ||
      patch.strength === 'high'
        ? patch.strength
        : cur.strength,
    lowMcUsd:
      patch.lowMcUsd != null && Number.isFinite(Number(patch.lowMcUsd))
        ? Math.max(10_000, Number(patch.lowMcUsd))
        : cur.lowMcUsd,
    lowMcWindowMin:
      patch.lowMcWindowMin != null && Number.isFinite(Number(patch.lowMcWindowMin))
        ? Math.max(1, Math.min(120, Number(patch.lowMcWindowMin)))
        : cur.lowMcWindowMin,
    maxAgentsPerLowMc:
      patch.maxAgentsPerLowMc != null &&
      Number.isFinite(Number(patch.maxAgentsPerLowMc))
        ? Math.max(1, Math.min(5, Math.round(Number(patch.maxAgentsPerLowMc))))
        : cur.maxAgentsPerLowMc,
  };
  (config as { marl: MarlConfig }).marl = next;
  try {
    const { persistUserSettings } = require('./config') as typeof import('./config');
    persistUserSettings();
  } catch {
    /* */
  }
  pushMarlDecision({
    kind: 'config',
    detail: `MARL ${next.enabled ? 'ON' : 'OFF'} · strength ${next.strength} · lowMC $${Math.round(next.lowMcUsd)}`,
  });
  return next;
}

function strengthScale(s: MarlStrength): number {
  if (s === 'low') return 0.35;
  if (s === 'high') return 1.6;
  return 1;
}

const SCORE_CAP = 8;
const SIZE_LO = 0.85;
const SIZE_HI = 1.15;
const PPO_EPS = 0.08;

/** Additive lane score delta for a profile (0 when MARL off). */
export function marlLaneScoreDelta(profileId: string): {
  delta: number;
  note: string;
} {
  const cfg = getMarlConfig();
  if (!cfg.enabled) return { delta: 0, note: '' };
  const agent = getOrCreateAgent(profileId);
  const scale = strengthScale(cfg.strength);
  const raw = agent.weight * 10 * scale;
  const delta = Math.max(-SCORE_CAP, Math.min(SCORE_CAP, raw));
  if (Math.abs(delta) < 0.05) return { delta: 0, note: '' };
  const note = `MARL ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`;
  return { delta: Math.round(delta * 10) / 10, note };
}

/** Soft entry size multiplier from agent confidence (1 when off). */
export function marlSizeMultiplier(profileId: string | null | undefined): {
  mult: number;
  note: string;
} {
  const cfg = getMarlConfig();
  if (!cfg.enabled || !profileId) return { mult: 1, note: '' };
  const agent = getOrCreateAgent(profileId);
  const scale = strengthScale(cfg.strength);
  const avg =
    agent.trades > 0 ? agent.sumReward / Math.max(1, agent.trades) : 0;
  const raw = 1 + agent.weight * 0.25 * scale + avg * 0.05 * scale;
  const mult = Math.max(SIZE_LO, Math.min(SIZE_HI, raw));
  if (Math.abs(mult - 1) < 0.01) return { mult: 1, note: '' };
  return {
    mult: Math.round(mult * 1000) / 1000,
    note: `MARL size×${mult.toFixed(2)}`,
  };
}

export type MarlLowMcAction = 'allow' | 'skip' | 'size_down';

export function evaluateMarlLowMcCoordination(input: {
  mint: string;
  symbol?: string;
  profileId: string;
  marketCapUsd: number | null;
}): { action: MarlLowMcAction; sizeMult: number; reason: string } {
  const cfg = getMarlConfig();
  if (!cfg.enabled) {
    return { action: 'allow', sizeMult: 1, reason: '' };
  }
  const mc = input.marketCapUsd;
  if (mc == null || !(mc > 0) || mc >= cfg.lowMcUsd) {
    return { action: 'allow', sizeMult: 1, reason: '' };
  }
  const windowMs = cfg.lowMcWindowMin * 60_000;
  const recent = getRecentLowMcOpens(input.mint, windowMs);
  if (recent.length < cfg.maxAgentsPerLowMc) {
    return {
      action: 'allow',
      sizeMult: 1,
      reason: `MARL low-MC slot ${recent.length + 1}/${cfg.maxAgentsPerLowMc}`,
    };
  }
  // Prefer strongest agent already in; later agents skip or size down
  const bestId = [...recent]
    .map((r) => ({ id: r.profileId, w: getOrCreateAgent(r.profileId).weight }))
    .sort((a, b) => b.w - a.w)[0]?.id;
  const me = getOrCreateAgent(input.profileId);
  const best = bestId ? getOrCreateAgent(bestId) : null;
  if (best && me.weight + 0.05 < best.weight) {
    const scale = strengthScale(cfg.strength);
    if (cfg.strength === 'high' || scale >= 1) {
      const detail = `MARL low-MC skip — prefer ${bestId} (w=${best.weight.toFixed(2)} > ${me.weight.toFixed(2)})`;
      pushMarlDecision({
        kind: 'low_mc_skip',
        mint: input.mint,
        symbol: input.symbol,
        profileId: input.profileId,
        detail,
      });
      marlPublish({
        kind: 'entry_intent',
        mint: input.mint,
        symbol: input.symbol,
        profileId: input.profileId,
        payload: { action: 'skip', detail },
      });
      return { action: 'skip', sizeMult: 1, reason: detail };
    }
    const sizeMult = cfg.strength === 'low' ? 0.7 : 0.55;
    const detail = `MARL low-MC size×${sizeMult} — ${bestId} already in`;
    pushMarlDecision({
      kind: 'low_mc_size_down',
      mint: input.mint,
      symbol: input.symbol,
      profileId: input.profileId,
      detail,
    });
    return { action: 'size_down', sizeMult, reason: detail };
  }
  return {
    action: 'allow',
    sizeMult: 1,
    reason: 'MARL low-MC allow (competitive weight)',
  };
}

export function notifyMarlEntryOpened(input: {
  mint: string;
  symbol?: string;
  profileId: string;
  marketCapUsd?: number | null;
}): void {
  const cfg = getMarlConfig();
  if (!cfg.enabled) return;
  const mc = input.marketCapUsd;
  if (mc != null && mc > 0 && mc < cfg.lowMcUsd) {
    recordLowMcOpen(input.mint, input.profileId);
  }
  pushMarlDecision({
    kind: 'entry',
    mint: input.mint,
    symbol: input.symbol,
    profileId: input.profileId,
    detail: `Opened via ${input.profileId}${mc != null ? ` · MC $${Math.round(mc)}` : ''}`,
  });
  marlPublish({
    kind: 'entry_intent',
    mint: input.mint,
    symbol: input.symbol,
    profileId: input.profileId,
    payload: { opened: true },
  });
}

/** Risk-adjusted reward + clipped PPO-style weight update. */
export function notifyMarlTradeClosed(input: {
  profileId: string | null | undefined;
  pnlSol: number;
  costSol?: number | null;
  mint?: string;
  symbol?: string;
}): void {
  const pid = input.profileId;
  if (!pid || pid === 'default' || pid === 'zion') return;
  const cfg = getMarlConfig();
  const risk = Math.max(0.01, Number(input.costSol) || 0.1);
  const reward = Math.max(-3, Math.min(3, Number(input.pnlSol) / risk));
  const agent = getOrCreateAgent(pid);
  agent.trades += 1;
  if (reward > 0) agent.wins += 1;
  agent.sumReward += reward;
  agent.lastReward = reward;
  agent.updatedAt = Date.now();
  if (cfg.enabled) {
    const scale = strengthScale(cfg.strength);
    const delta = Math.max(-PPO_EPS, Math.min(PPO_EPS, reward * 0.04 * scale));
    agent.weight = Math.max(-1, Math.min(1, agent.weight + delta));
  }
  saveMarlState();
  pushMarlDecision({
    kind: 'trade_result',
    mint: input.mint,
    symbol: input.symbol,
    profileId: pid,
    detail: `reward ${reward >= 0 ? '+' : ''}${reward.toFixed(2)} · w=${agent.weight.toFixed(3)} · ${cfg.enabled ? 'updated' : 'frozen (MARL off)'}`,
  });
  marlPublish({
    kind: 'trade_result',
    mint: input.mint,
    symbol: input.symbol,
    profileId: pid,
    payload: { reward, weight: agent.weight, pnlSol: input.pnlSol },
  });
}

export function getMarlStatus(): {
  enabled: boolean;
  strength: MarlStrength;
  lowMcUsd: number;
  lowMcWindowMin: number;
  maxAgentsPerLowMc: number;
  label: string;
  agents: Array<
    MarlAgentState & { winRatePct: number; avgReward: number }
  >;
  decisions: ReturnType<typeof getMarlDecisions>;
} {
  const cfg = getMarlConfig();
  const st = loadMarlState();
  const agents = Object.values(st.agents)
    .map((a) => ({
      ...a,
      winRatePct:
        a.trades > 0 ? Math.round((a.wins / a.trades) * 1000) / 10 : 0,
      avgReward:
        a.trades > 0
          ? Math.round((a.sumReward / a.trades) * 1000) / 1000
          : 0,
    }))
    .sort((a, b) => b.weight - a.weight || b.trades - a.trades);
  return {
    ...cfg,
    label: cfg.enabled
      ? `MARL · ${cfg.strength}`
      : 'MARL OFF',
    agents,
    decisions: getMarlDecisions(40),
  };
}

/** Apply MARL ranking bump to lane results in-place (passed lanes only). */
export function applyMarlLaneRanking<
  T extends { profileId: string; passed: boolean; score: number; reason: string },
>(results: T[]): T[] {
  const cfg = getMarlConfig();
  if (!cfg.enabled) return results;
  for (const row of results) {
    if (!row.passed) continue;
    const { delta, note } = marlLaneScoreDelta(row.profileId);
    if (!note) continue;
    row.score = Math.round((row.score + delta) * 10) / 10;
    row.reason = `${row.reason} · ${note}`;
  }
  results.sort(
    (a, b) =>
      Number(b.passed) - Number(a.passed) || b.score - a.score
  );
  return results;
}
