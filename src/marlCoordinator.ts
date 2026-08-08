/**
 * Soft multi-agent coordinator — PPO-style clipped preference weights.
 * Influences lane ranking, entry size confidence, and low-MC pile-in rules only.
 * Never mutates TP/SL, timers, or profile self-learning overrides.
 */

import { config } from './config';
import {
  evaluateLaggingProfiles,
  getLaggingProfile,
  laggingScoreBoost,
  listLaggingProfiles,
  noteLaggingSupportApplied,
  updateLaggingAfterTrade,
  type LaggingProfileRuntime,
} from './marlLaggingSupport';
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

export {
  evaluateLaggingProfiles,
  getLaggingProfile,
  laggingScoreBoost,
  listLaggingProfiles,
  noteLaggingSupportApplied,
  updateLaggingAfterTrade,
};
export type { LaggingProfileRuntime };

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
  /** Soft help for quiet/under-utilised profiles (default on when field unset). */
  laggingSupportEnabled: boolean;
}

export const DEFAULT_MARL_CONFIG: MarlConfig = {
  enabled: false,
  strength: 'medium',
  lowMcUsd: 175_000,
  lowMcWindowMin: 10,
  maxAgentsPerLowMc: 1,
  laggingSupportEnabled: true,
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
    laggingSupportEnabled: m?.laggingSupportEnabled !== false,
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
    laggingSupportEnabled:
      typeof patch.laggingSupportEnabled === 'boolean'
        ? patch.laggingSupportEnabled
        : cur.laggingSupportEnabled,
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
    detail: `MARL ${next.enabled ? 'ON' : 'OFF'} · strength ${next.strength} · lowMC $${Math.round(next.lowMcUsd)} · lagSupport ${next.laggingSupportEnabled ? 'ON' : 'OFF'}`,
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
  let delta = Math.max(-SCORE_CAP, Math.min(SCORE_CAP, raw));
  let noteExtra = '';
  try {
    const { getRecoveryConstraints } =
      require('./fastProfileRecovery') as typeof import('./fastProfileRecovery');
    const rc = getRecoveryConstraints(profileId);
    if (rc.active && rc.marlDownrank) {
      delta = Math.max(-SCORE_CAP, Math.min(SCORE_CAP, delta + rc.marlDownrank));
      noteExtra = ` · recovery ${rc.marlDownrank}`;
    }
  } catch {
    /* optional */
  }
  try {
    const { scalperExpectancyMarlDelta } =
      require('./profileAttention') as typeof import('./profileAttention');
    const exp = scalperExpectancyMarlDelta(profileId);
    if (exp !== 0) {
      delta = Math.max(-SCORE_CAP, Math.min(SCORE_CAP, delta + exp));
      noteExtra += ` · scalperExp ${exp}`;
    }
  } catch {
    /* optional */
  }
  // Soft harvest context (avg capture / giveback) — ranking only, no PPP writes
  try {
    const harvest = softHarvestRankingNudge(profileId);
    if (Math.abs(harvest.delta) >= 0.05) {
      delta = Math.max(
        -SCORE_CAP,
        Math.min(SCORE_CAP, delta + harvest.delta * scale)
      );
      noteExtra += harvest.note ? ` · ${harvest.note}` : '';
    }
  } catch {
    /* optional */
  }
  if (Math.abs(delta) < 0.05) return { delta: 0, note: '' };
  const note = `MARL ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}${noteExtra}`;
  return { delta: Math.round(delta * 10) / 10, note };
}

/**
 * Lightweight in-memory harvest nudge from recent episodes.
 * Ranking only — never mutates PPP/PCL/TP/SL.
 */
function softHarvestRankingNudge(profileId: string): {
  delta: number;
  note: string;
} {
  try {
    const { getProfileLearningEpisodes } =
      require('./profileLearningEpisodes') as typeof import('./profileLearningEpisodes');
    // Cached ring read — keep small to avoid request-path stalls
    const eps = getProfileLearningEpisodes(profileId, 24);
    if (eps.length < 6) return { delta: 0, note: '' };
    const caps = eps
      .map((e) =>
        e.mfeCaptureRatio != null && Number.isFinite(e.mfeCaptureRatio)
          ? Number(e.mfeCaptureRatio)
          : null
      )
      .filter((v): v is number => v != null);
    const gbs = eps.map((e) => Math.max(0, Number(e.givebackFromPeakPct) || 0));
    const avgCap =
      caps.length > 0
        ? caps.reduce((a, b) => a + b, 0) / caps.length
        : null;
    const avgGb = gbs.reduce((a, b) => a + b, 0) / gbs.length;
    let delta = 0;
    if (avgCap != null) delta += (avgCap - 0.55) * 2.5;
    delta -= Math.min(1.5, Math.max(0, avgGb - 10) * 0.08);
    delta = Math.max(-1.2, Math.min(1.2, delta));
    if (Math.abs(delta) < 0.08) return { delta: 0, note: '' };
    return {
      delta: Math.round(delta * 10) / 10,
      note: `harvest ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`,
    };
  } catch {
    return { delta: 0, note: '' };
  }
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
    const lagRt =
      cfg.laggingSupportEnabled
        ? getLaggingProfile(input.profileId)
        : null;
    const laggingSoft =
      lagRt != null &&
      (lagRt.status === 'lagging' || lagRt.status === 'supported');
    // Lagging/supported: prefer size_down over hard skip at high strength
    if ((cfg.strength === 'high' || scale >= 1) && !laggingSoft) {
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
    const sizeMult = laggingSoft
      ? cfg.strength === 'high'
        ? 0.5
        : cfg.strength === 'low'
          ? 0.75
          : 0.6
      : cfg.strength === 'low'
        ? 0.7
        : 0.55;
    const detail = laggingSoft
      ? `MARL low-MC size×${sizeMult} — lagging ${input.profileId} soft route (${bestId} already in)`
      : `MARL low-MC size×${sizeMult} — ${bestId} already in`;
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
  if (cfg.laggingSupportEnabled) {
    try {
      updateLaggingAfterTrade(pid, reward);
    } catch {
      /* non-fatal */
    }
  }
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
  laggingSupportEnabled: boolean;
  label: string;
  agents: Array<
    MarlAgentState & { winRatePct: number; avgReward: number }
  >;
  laggingProfiles: LaggingProfileRuntime[];
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
  let laggingProfiles: LaggingProfileRuntime[] = [];
  if (cfg.enabled && cfg.laggingSupportEnabled) {
    try {
      laggingProfiles = listLaggingProfiles();
    } catch {
      laggingProfiles = [];
    }
  }
  return {
    ...cfg,
    label: cfg.enabled
      ? `MARL · ${cfg.strength}`
      : 'MARL OFF',
    agents,
    laggingProfiles,
    decisions: getMarlDecisions(40),
  };
}

const LAGGING_LEAPFROG_GAP = 5;

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

  if (cfg.laggingSupportEnabled) {
    const scale = strengthScale(cfg.strength);
    const lagBoosts = new Map<string, { delta: number; note: string }>();
    for (const row of results) {
      if (!row.passed) continue;
      const { delta, note } = laggingScoreBoost(row.profileId, scale);
      if (delta > 0 && note) lagBoosts.set(row.profileId, { delta, note });
    }
    const nonLagMax = Math.max(
      -Infinity,
      ...results
        .filter((r) => r.passed && !lagBoosts.has(r.profileId))
        .map((r) => r.score)
    );
    const hasStrongNonLag = Number.isFinite(nonLagMax);
    const applied: string[] = [];
    for (const row of results) {
      if (!row.passed) continue;
      const boost = lagBoosts.get(row.profileId);
      if (!boost) continue;
      let delta = boost.delta;
      // Cap leapfrog: lagging stays behind / closes gap modestly vs clear winner
      if (hasStrongNonLag && nonLagMax - row.score > LAGGING_LEAPFROG_GAP) {
        const maxClose = Math.max(0, nonLagMax - row.score - 0.5);
        delta = Math.min(delta, Math.min(maxClose, 2.5));
      } else if (hasStrongNonLag && row.score + delta > nonLagMax) {
        delta = Math.max(0, Math.min(delta, nonLagMax - row.score + 0.3));
      }
      delta = Math.round(delta * 10) / 10;
      if (delta < 0.15) continue;
      row.score = Math.round((row.score + delta) * 10) / 10;
      row.reason = `${row.reason} · MARL lag+${delta.toFixed(1)}`;
      applied.push(`${row.profileId}+${delta.toFixed(1)}`);
      try {
        noteLaggingSupportApplied(row.profileId, '', { log: false });
      } catch {
        /* non-fatal */
      }
    }
    if (applied.length) {
      const detail = `Lane lag boost · ${applied.join(', ')} (scale ${scale.toFixed(2)})`;
      try {
        pushMarlDecision({
          kind: 'lagging_support',
          profileId: applied[0]?.split('+')[0],
          detail: detail.slice(0, 280),
        });
        console.log(`[marl] lagging-support: ${detail}`);
      } catch {
        /* */
      }
    }
  }

  results.sort(
    (a, b) =>
      Number(b.passed) - Number(a.passed) || b.score - a.score
  );
  return results;
}

export type MarlLaneFightThoughts = {
  enabled: boolean;
  strength?: MarlStrength;
  thoughts: string[];
};

/**
 * Human-readable team-manager narrative for a lane fight (after MARL ranking).
 * Pure / observational — does not mutate lanes or TP/SL.
 */
export function buildMarlLaneFightThoughts(
  lanes: Array<{
    profileId?: string;
    id?: string;
    name?: string;
    passed: boolean;
    score: number;
  }>
): MarlLaneFightThoughts {
  const cfg = getMarlConfig();
  if (!cfg.enabled) {
    return { enabled: false, thoughts: [] };
  }
  const strengthLabel =
    cfg.strength === 'low'
      ? 'Low'
      : cfg.strength === 'high'
        ? 'High'
        : 'Medium';
  const thoughts: string[] = [
    `Strength ${strengthLabel} · team manager ON`,
  ];

  type Row = {
    id: string;
    name: string;
    score: number;
    base: number;
    delta: number;
    weight: number;
  };
  const passed: Row[] = [];
  for (const lane of lanes) {
    if (!lane.passed) continue;
    const id = String(lane.profileId || lane.id || '');
    if (!id) continue;
    const { delta } = marlLaneScoreDelta(id);
    const score = Number(lane.score) || 0;
    const base = Math.round((score - delta) * 10) / 10;
    const agent = getOrCreateAgent(id);
    passed.push({
      id,
      name: String(lane.name || id),
      score,
      base,
      delta,
      weight: agent.weight,
    });
  }

  for (const row of passed) {
    if (Math.abs(row.delta) < 0.05) continue;
    const sign = row.delta >= 0 ? '+' : '';
    const verb = row.delta >= 0 ? 'Boost' : 'Trim';
    thoughts.push(
      `${verb} ${row.name} ${sign}${row.delta.toFixed(1)} (w=${row.weight.toFixed(2)})`
    );
  }

  if (cfg.laggingSupportEnabled) {
    try {
      const lagNames: string[] = [];
      for (const row of passed) {
        const rt = getLaggingProfile(row.id);
        if (
          rt &&
          (rt.status === 'lagging' || rt.status === 'supported') &&
          rt.boost >= 0.12
        ) {
          lagNames.push(row.name);
        }
      }
      if (lagNames.length) {
        thoughts.push(
          `Lagging support soft-boost: ${lagNames.slice(0, 3).join(', ')}`
        );
      }
    } catch {
      /* */
    }
  }

  const after = [...passed].sort((a, b) => b.score - a.score);
  if (after.length) {
    thoughts.push(
      `Priority after MARL: ${after
        .slice(0, 4)
        .map((r) => r.name)
        .join(' > ')}`
    );
  }

  const before = [...passed].sort((a, b) => b.base - a.base);
  const beforeWinner = before[0];
  const afterWinner = after[0];
  if (
    beforeWinner &&
    afterWinner &&
    beforeWinner.id !== afterWinner.id
  ) {
    const suggestion = `Suggestion: prefer ${afterWinner.name} over ${beforeWinner.name} this fight`;
    thoughts.push(suggestion);
    try {
      const { recordMarlRankSuggestion } =
        require('./agentDecisionLog') as typeof import('./agentDecisionLog');
      recordMarlRankSuggestion({
        summary: `Preferred ${afterWinner.name} over ${beforeWinner.name} on this setup due to stronger MARL weight fit.`,
        detail: suggestion,
      });
    } catch {
      /* optional */
    }
  }

  try {
    pushMarlDecision({
      kind: 'lane_rank',
      profileId: afterWinner?.id,
      detail: thoughts.slice(0, 4).join(' · ').slice(0, 280),
    });
  } catch {
    /* non-fatal */
  }

  return {
    enabled: true,
    strength: cfg.strength,
    thoughts: thoughts.slice(0, 8),
  };
}
