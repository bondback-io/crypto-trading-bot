/**
 * Agent Decision Log — additive reasoning/advice feed for soft/hard coaches.
 * Separate from lane fight execution log. Logging only; fail-open.
 * DATA_DIR/agent-decisions.json
 */

import fs from 'fs';
import { atomicWriteJson, dataFile, ensureDataDir } from './dataDir';

export type AgentSource =
  | 'marl'
  | 'profile_rl'
  | 'ml'
  | 'self_learn'
  | 'ta_playbook'
  | 'accel_replay'
  | 'accel_cf'
  | 'accel_teacher'
  | 'peak_protect'
  | 'zion'
  | 'hmc_gatekeeper';

export type AgentDecisionType =
  | 'advice'
  | 'soft_push'
  | 'recommendation'
  | 'rank'
  | 'mode_change'
  | 'hint'
  | 'warning'
  | 'comment';

export type AgentApplyStatus =
  | 'applied'
  | 'queued'
  | 'rejected'
  | 'observation_only';

export interface AgentDecisionEntry {
  id: string;
  at: number;
  agent: string;
  source: AgentSource;
  decisionType: AgentDecisionType;
  profileId?: string;
  target: string;
  summary: string;
  detail?: string;
  strength?: number;
  applied: AgentApplyStatus;
  mint?: string;
  symbol?: string;
  dedupeKey?: string;
  /** Aggregation count when identical advice repeats */
  count?: number;
}

export interface AgentDecisionInput {
  agent: string;
  source: AgentSource;
  decisionType: AgentDecisionType;
  profileId?: string;
  target?: string;
  summary: string;
  detail?: string;
  strength?: number;
  applied?: AgentApplyStatus;
  mint?: string;
  symbol?: string;
  dedupeKey?: string;
  at?: number;
}

export interface AgentDecisionQuery {
  limit?: number;
  source?: string;
  profileId?: string;
  decisionType?: string;
  applied?: string;
  since?: number;
  until?: number;
}

interface AgentDecisionFile {
  version: 1;
  updatedAt: number;
  ring: AgentDecisionEntry[];
}

const FILE = 'agent-decisions.json';
const MAX_RING = 400;
const DEDUPE_MS = 10 * 60 * 1000;
const MIN_WRITE_GAP_MS = 200; // soft burst cap ~5/sec

let cache: AgentDecisionEntry[] | null = null;
let lastWriteAt = 0;
let pendingPersist: ReturnType<typeof setTimeout> | null = null;

function path(): string {
  ensureDataDir();
  return dataFile(FILE);
}

function profileLabel(profileId?: string): string {
  if (!profileId || profileId === 'all' || profileId === 'system') {
    return profileId === 'system' ? 'System' : 'All bots';
  }
  try {
    const { getTradeProfilesStatus } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    const p = (getTradeProfilesStatus().profiles || []).find(
      (x: { id: string }) => x.id === profileId
    );
    if (p?.name) return String(p.name);
  } catch {
    /* */
  }
  return profileId;
}

function loadRing(): AgentDecisionEntry[] {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(path(), 'utf8');
    const parsed = JSON.parse(raw) as AgentDecisionFile;
    if (parsed?.version === 1 && Array.isArray(parsed.ring)) {
      cache = parsed.ring;
      return cache;
    }
  } catch {
    /* fresh */
  }
  cache = [];
  return cache;
}

function schedulePersist(): void {
  if (pendingPersist) return;
  pendingPersist = setTimeout(() => {
    pendingPersist = null;
    try {
      const ring = loadRing();
      atomicWriteJson(path(), {
        version: 1,
        updatedAt: Date.now(),
        ring: ring.slice(0, MAX_RING),
      } satisfies AgentDecisionFile);
    } catch {
      /* fail-open */
    }
  }, 400);
}

/**
 * Record a coach/agent decision. Fail-open; never throws to callers.
 */
export function recordAgentDecision(
  input: AgentDecisionInput
): AgentDecisionEntry | null {
  try {
    const now = Date.now();
    if (now - lastWriteAt < MIN_WRITE_GAP_MS && !input.dedupeKey && input.source !== 'zion') {
      // Soft drop burst noise without a dedupe key
      return null;
    }

    const summary = String(input.summary || '').trim().slice(0, 320);
    if (!summary) return null;

    const ring = loadRing();
    const dedupeKey = input.dedupeKey
      ? String(input.dedupeKey).slice(0, 160)
      : undefined;

    if (dedupeKey) {
      const existing = ring.find(
        (e) => e.dedupeKey === dedupeKey && now - e.at < DEDUPE_MS
      );
      if (existing) {
        existing.at = now;
        existing.count = (existing.count || 1) + 1;
        existing.summary = summary;
        if (input.detail) existing.detail = String(input.detail).slice(0, 600);
        schedulePersist();
        return existing;
      }
    }

    const profileId = input.profileId
      ? String(input.profileId).trim() || undefined
      : undefined;
    const entry: AgentDecisionEntry = {
      id: `adl-${now}-${Math.random().toString(36).slice(2, 8)}`,
      at: input.at ?? now,
      agent: String(input.agent || 'Agent').slice(0, 64),
      source: input.source,
      decisionType: input.decisionType,
      profileId,
      target: String(input.target || profileLabel(profileId)).slice(0, 80),
      summary,
      detail: input.detail ? String(input.detail).slice(0, 600) : undefined,
      strength:
        input.strength != null && Number.isFinite(input.strength)
          ? Math.max(0, Math.min(1, Number(input.strength)))
          : undefined,
      applied: input.applied || 'observation_only',
      mint: input.mint ? String(input.mint).slice(0, 64) : undefined,
      symbol: input.symbol ? String(input.symbol).slice(0, 32) : undefined,
      dedupeKey,
      count: 1,
    };

    ring.unshift(entry);
    if (ring.length > MAX_RING) ring.length = MAX_RING;
    cache = ring;
    lastWriteAt = now;
    schedulePersist();

    if (input.source !== 'zion') {
      try {
        const { maybeZionAgentDecisionComment } =
          require('./zionAgentDecisionLog') as typeof import('./zionAgentDecisionLog');
        maybeZionAgentDecisionComment(entry);
      } catch {
        /* optional */
      }
    }

    return entry;
  } catch {
    return null;
  }
}

export function listAgentDecisions(
  query?: AgentDecisionQuery
): AgentDecisionEntry[] {
  let all = [...loadRing()];

  const source = String(query?.source || '').trim().toLowerCase();
  if (source && source !== 'all') {
    all = all.filter((e) => e.source === source);
  }

  const profileId = String(query?.profileId || '').trim().toLowerCase();
  if (profileId && profileId !== 'all') {
    all = all.filter(
      (e) =>
        String(e.profileId || '').toLowerCase() === profileId ||
        String(e.target || '').toLowerCase().includes(profileId)
    );
  }

  const decisionType = String(query?.decisionType || '').trim().toLowerCase();
  if (decisionType && decisionType !== 'all') {
    all = all.filter((e) => e.decisionType === decisionType);
  }

  const applied = String(query?.applied || '').trim().toLowerCase();
  if (applied && applied !== 'all') {
    if (applied === 'observation' || applied === 'observation_only') {
      all = all.filter((e) => e.applied === 'observation_only');
    } else if (applied === 'live' || applied === 'applied') {
      all = all.filter(
        (e) =>
          e.applied === 'applied' ||
          e.applied === 'queued' ||
          e.applied === 'rejected'
      );
    } else {
      all = all.filter((e) => e.applied === applied);
    }
  }

  const since = Number(query?.since) || 0;
  if (since > 0) all = all.filter((e) => e.at >= since);
  const until = Number(query?.until) || 0;
  if (until > 0) all = all.filter((e) => e.at <= until);

  const limit = Math.max(1, Math.min(200, Number(query?.limit) || 50));
  return all.slice(0, limit);
}

/** Fan-in from MARL decision ring — meaningful kinds only. */
export function mirrorMarlDecision(d: {
  kind: string;
  detail: string;
  profileId?: string;
  mint?: string;
  symbol?: string;
}): void {
  const kind = String(d.kind || '');
  const map: Record<
    string,
    { decisionType: AgentDecisionType; applied: AgentApplyStatus; agent?: string }
  > = {
    low_mc_skip: {
      decisionType: 'recommendation',
      applied: 'applied',
    },
    low_mc_size_down: {
      decisionType: 'soft_push',
      applied: 'applied',
    },
    lagging_support: {
      decisionType: 'soft_push',
      applied: 'applied',
    },
    lagging_cooling: {
      decisionType: 'warning',
      applied: 'applied',
    },
    lagging_status: {
      decisionType: 'hint',
      applied: 'observation_only',
    },
  };
  let m = map[kind];
  if (
    !m &&
    kind === 'lagging_support' &&
    /cooling/i.test(String(d.detail || ''))
  ) {
    m = map.lagging_cooling;
  }
  if (!m) return;
  recordAgentDecision({
    agent: 'MARL',
    source: 'marl',
    decisionType: m.decisionType,
    profileId: d.profileId,
    target: profileLabel(d.profileId),
    summary: d.detail || kind,
    detail: `kind=${kind}`,
    applied: m.applied,
    mint: d.mint,
    symbol: d.symbol,
    dedupeKey: `marl:${kind}:${d.profileId || ''}:${d.mint || ''}`,
  });
}

/** Fan-in from Profile RL — mode changes only. */
export function mirrorProfileRlDecision(d: {
  kind: string;
  detail: string;
  profileId?: string;
  mint?: string;
  symbol?: string;
}): void {
  const kind = String(d.kind || '');
  if (
    kind !== 'auto_promote' &&
    kind !== 'auto_demote' &&
    kind !== 'auto_rollback' &&
    kind !== 'rollback'
  ) {
    return;
  }
  const name = profileLabel(d.profileId);
  recordAgentDecision({
    agent: `Profile RL (${name})`,
    source: 'profile_rl',
    decisionType: 'mode_change',
    profileId: d.profileId,
    target: name,
    summary: d.detail || kind,
    detail: `kind=${kind}`,
    applied: 'applied',
    mint: d.mint,
    symbol: d.symbol,
    dedupeKey: `prl:${kind}:${d.profileId || ''}`,
  });
}

/** Fan-in from accelerators ring. */
export function mirrorAccelDecision(
  kind: string,
  profileId: string | undefined,
  detail: string
): void {
  const k = String(kind || '');
  if (k === 'teacher_student' || k === 'teacher_student_rollback') {
    recordAgentDecision({
      agent: 'Learning Accelerators',
      source: 'accel_teacher',
      decisionType: k.includes('rollback') ? 'hint' : 'soft_push',
      profileId,
      target: profileLabel(profileId),
      summary: detail || k,
      applied: 'applied',
      dedupeKey: `accel:${k}:${profileId || ''}:${detail.slice(0, 40)}`,
    });
    return;
  }
  if (k === 'replay_batch') {
    const d = String(detail || '');
    if (!d || /empty|no hint|skipped/i.test(d)) return;
    recordAgentDecision({
      agent: 'Experience Replay',
      source: 'accel_replay',
      decisionType: 'hint',
      profileId,
      target: profileLabel(profileId),
      summary: d,
      applied: 'observation_only',
      dedupeKey: `replay:${profileId || ''}:${d.slice(0, 48)}`,
    });
    return;
  }
  // counterfactual stamps are noisy — CF flips go through recordCfPreferenceFlip
}

/** Fan-in from learning-save journal for ML / proposals. */
export function mirrorLearningSave(d: {
  kind: string;
  summary: string;
  profileId?: string;
  botName?: string;
}): void {
  const kind = String(d.kind || '');
  const summary = String(d.summary || '');
  const name = d.botName || profileLabel(d.profileId);

  if (kind === 'toggle' && /ml|mode|shadow|hybrid|lead/i.test(summary)) {
    recordAgentDecision({
      agent: `ML (${name})`,
      source: 'ml',
      decisionType: 'mode_change',
      profileId: d.profileId,
      target: name,
      summary,
      applied: 'applied',
      dedupeKey: `ml-mode:${d.profileId || ''}:${summary.slice(0, 40)}`,
    });
    return;
  }

  if (kind === 'proposal' || kind === 'upgrade' || kind === 'micro') {
    const isPpp = /peak.?protect|ppp|timing:/i.test(summary);
    const applied: AgentApplyStatus =
      kind === 'proposal' ? 'queued' : 'applied';
    recordAgentDecision({
      agent: isPpp ? 'Peak Protect Learning' : `Self-Learn (${name})`,
      source: isPpp ? 'peak_protect' : 'self_learn',
      decisionType: kind === 'proposal' ? 'recommendation' : 'soft_push',
      profileId: d.profileId,
      target: name,
      summary,
      detail: `kind=${kind}`,
      applied,
      dedupeKey: `learn:${kind}:${d.profileId || ''}:${summary.slice(0, 48)}`,
    });
  }
}

/** CF aggregated preference flip (not every stamp). */
export function recordCfPreferenceFlip(input: {
  profileId: string;
  summary: string;
  detail?: string;
}): void {
  recordAgentDecision({
    agent: 'Counterfactual Coach',
    source: 'accel_cf',
    decisionType: 'hint',
    profileId: input.profileId,
    target: profileLabel(input.profileId),
    summary: input.summary,
    detail: input.detail,
    applied: 'observation_only',
    dedupeKey: `cf-flip:${input.profileId}:${input.summary.slice(0, 48)}`,
  });
}

/** MARL lane preference suggestion (not every lane_rank). */
export function recordMarlRankSuggestion(input: {
  summary: string;
  mint?: string;
  symbol?: string;
  detail?: string;
}): void {
  recordAgentDecision({
    agent: 'MARL',
    source: 'marl',
    decisionType: 'rank',
    target: 'Lane ranking',
    summary: input.summary,
    detail: input.detail,
    applied: 'observation_only',
    mint: input.mint,
    symbol: input.symbol,
    dedupeKey: `marl-rank:${input.mint || ''}:${input.summary.slice(0, 40)}`,
  });
}

export function recordTaDecision(input: {
  profileId: string;
  summary: string;
  decisionType: AgentDecisionType;
  applied: AgentApplyStatus;
  detail?: string;
  mint?: string;
  symbol?: string;
  dedupeKey?: string;
}): void {
  const name = profileLabel(input.profileId);
  recordAgentDecision({
    agent: `Profile TA (${name})`,
    source: 'ta_playbook',
    decisionType: input.decisionType,
    profileId: input.profileId,
    target: name,
    summary: input.summary,
    detail: input.detail,
    applied: input.applied,
    mint: input.mint,
    symbol: input.symbol,
    dedupeKey:
      input.dedupeKey ||
      `ta:${input.profileId}:${input.summary.slice(0, 40)}`,
  });
}
