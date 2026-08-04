/**
 * Durable per-profile RL soft policy state (DATA_DIR/profile-rl-state.json).
 * Never stores TP/SL, exit overrides, or MARL weights — intra-profile biases only.
 */

import fs from 'fs';
import { dataFile, ensureDataDir } from './dataDir';

export type ProfileRlMode = 'shadow' | 'hybrid' | 'lead';
export type ProfileRlStrength = 'low' | 'medium' | 'high';

export interface ProfileRlPolicy {
  setupWorthBias: number;
  confidenceBias: number;
  taSensitivityBias: number;
  exitAggressiveness: number;
}

export interface ProfileRlPolicyHistoryEntry {
  at: number;
  before: ProfileRlPolicy;
  after: ProfileRlPolicy;
  summary: string;
  sampleSize: number;
  avgReward: number;
}

export interface ProfileRlAgentState {
  profileId: string;
  mode: ProfileRlMode;
  /** Manual override — skips automatic mode promote/demote */
  modeLocked?: boolean;
  enabled: boolean;
  policy: ProfileRlPolicy;
  trades: number;
  wins: number;
  sumReward: number;
  lastReward: number;
  rewardEma: number;
  /** Prior EMA snapshot for trend slope */
  prevRewardEma?: number;
  /** Set once after first 10 trades — baseline for outperformance */
  baselineRewardEma?: number;
  /** Cached readiness 0–100 */
  readinessScore?: number;
  readinessUpdatedAt?: number;
  /** Rolling instability tally (auto-rollbacks, wild swings) */
  unstableCount?: number;
  /** Trades since last policy update (for rollback window) */
  tradesSinceUpdate: number;
  /** EMA before last update baseline */
  preUpdateRewardEma: number;
  policyHistory: ProfileRlPolicyHistoryEntry[];
  updatedAt: number;
}

export interface ProfileRlDecision {
  at: number;
  kind: string;
  mint?: string;
  symbol?: string;
  profileId?: string;
  detail: string;
}

export interface ProfileRlPersistedState {
  version: 1;
  updatedAt: number;
  agents: Record<string, ProfileRlAgentState>;
  decisions: ProfileRlDecision[];
}

const FILE = 'profile-rl-state.json';
const MAX_DECISIONS = 120;
const MAX_HISTORY = 8;

let cache: ProfileRlPersistedState | null = null;

export const DEFAULT_PROFILE_RL_POLICY: ProfileRlPolicy = {
  setupWorthBias: 0,
  confidenceBias: 0,
  taSensitivityBias: 0,
  exitAggressiveness: 0,
};

export function emptyProfileRlPolicy(): ProfileRlPolicy {
  return { ...DEFAULT_PROFILE_RL_POLICY };
}

function emptyState(): ProfileRlPersistedState {
  return {
    version: 1,
    updatedAt: Date.now(),
    agents: {},
    decisions: [],
  };
}

function path(): string {
  ensureDataDir();
  return dataFile(FILE);
}

export function loadProfileRlState(): ProfileRlPersistedState {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(path(), 'utf8');
    const parsed = JSON.parse(raw) as ProfileRlPersistedState;
    if (parsed && parsed.version === 1 && parsed.agents) {
      const agents: Record<string, ProfileRlAgentState> = {};
      for (const [id, a] of Object.entries(parsed.agents || {})) {
        agents[id] = normalizeAgent(a as ProfileRlAgentState);
      }
      cache = {
        version: 1,
        updatedAt: Number(parsed.updatedAt) || Date.now(),
        agents,
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
      };
      return cache;
    }
  } catch {
    /* fresh */
  }
  cache = emptyState();
  return cache;
}

export function saveProfileRlState(
  state: ProfileRlPersistedState = loadProfileRlState()
): void {
  state.updatedAt = Date.now();
  cache = state;
  try {
    fs.writeFileSync(path(), JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn(
      '[profile-rl] persist failed:',
      err instanceof Error ? err.message : err
    );
  }
}

function normalizePolicy(p: Partial<ProfileRlPolicy> | undefined): ProfileRlPolicy {
  const d = emptyProfileRlPolicy();
  if (!p) return d;
  return {
    setupWorthBias: clampBias(Number(p.setupWorthBias) || 0),
    confidenceBias: clampBias(Number(p.confidenceBias) || 0),
    taSensitivityBias: clampBias(Number(p.taSensitivityBias) || 0),
    exitAggressiveness: clampBias(Number(p.exitAggressiveness) || 0),
  };
}

function clampBias(n: number): number {
  return Math.max(-1, Math.min(1, n));
}

function normalizeAgent(raw: ProfileRlAgentState): ProfileRlAgentState {
  return {
    ...raw,
    modeLocked: raw.modeLocked === true,
    prevRewardEma: Number(raw.prevRewardEma) || raw.rewardEma || 0,
    baselineRewardEma:
      raw.baselineRewardEma != null ? Number(raw.baselineRewardEma) : undefined,
    readinessScore:
      raw.readinessScore != null ? Number(raw.readinessScore) : undefined,
    readinessUpdatedAt:
      raw.readinessUpdatedAt != null ? Number(raw.readinessUpdatedAt) : undefined,
    unstableCount: Math.max(0, Number(raw.unstableCount) || 0),
  };
}

export function getOrCreateProfileRlAgent(
  profileId: string,
  opts?: { defaultMode?: ProfileRlMode }
): ProfileRlAgentState {
  const st = loadProfileRlState();
  if (!st.agents[profileId]) {
    st.agents[profileId] = {
      profileId,
      mode: opts?.defaultMode ?? 'shadow',
      modeLocked: false,
      enabled: true,
      policy: emptyProfileRlPolicy(),
      trades: 0,
      wins: 0,
      sumReward: 0,
      lastReward: 0,
      rewardEma: 0,
      prevRewardEma: 0,
      tradesSinceUpdate: 0,
      preUpdateRewardEma: 0,
      policyHistory: [],
      updatedAt: Date.now(),
    };
    saveProfileRlState(st);
  }
  return st.agents[profileId];
}

export function pushProfileRlDecision(
  d: Omit<ProfileRlDecision, 'at'> & { at?: number }
): void {
  const st = loadProfileRlState();
  st.decisions.unshift({
    at: d.at ?? Date.now(),
    kind: d.kind,
    mint: d.mint,
    symbol: d.symbol,
    profileId: d.profileId,
    detail: d.detail,
  });
  if (st.decisions.length > MAX_DECISIONS) {
    st.decisions = st.decisions.slice(0, MAX_DECISIONS);
  }
  saveProfileRlState(st);
  try {
    const { mirrorProfileRlDecision } =
      require('./agentDecisionLog') as typeof import('./agentDecisionLog');
    mirrorProfileRlDecision({
      kind: d.kind,
      detail: d.detail,
      profileId: d.profileId,
      mint: d.mint,
      symbol: d.symbol,
    });
  } catch {
    /* optional */
  }
}

export function getProfileRlDecisions(limit = 40): ProfileRlDecision[] {
  return loadProfileRlState().decisions.slice(0, Math.max(1, Math.min(100, limit)));
}

export function pushProfileRlPolicyHistory(
  profileId: string,
  entry: Omit<ProfileRlPolicyHistoryEntry, 'at'> & { at?: number }
): void {
  const st = loadProfileRlState();
  const agent = getOrCreateProfileRlAgent(profileId);
  agent.policyHistory.unshift({
    at: entry.at ?? Date.now(),
    before: normalizePolicy(entry.before),
    after: normalizePolicy(entry.after),
    summary: entry.summary,
    sampleSize: entry.sampleSize,
    avgReward: entry.avgReward,
  });
  if (agent.policyHistory.length > MAX_HISTORY) {
    agent.policyHistory = agent.policyHistory.slice(0, MAX_HISTORY);
  }
  st.agents[profileId] = agent;
  saveProfileRlState(st);
}

export function setProfileRlAgentMode(
  profileId: string,
  mode: ProfileRlMode,
  opts?: { modeLocked?: boolean }
): ProfileRlAgentState {
  const st = loadProfileRlState();
  const agent = getOrCreateProfileRlAgent(profileId);
  agent.mode = mode;
  if (typeof opts?.modeLocked === 'boolean') {
    agent.modeLocked = opts.modeLocked;
  }
  agent.updatedAt = Date.now();
  st.agents[profileId] = agent;
  saveProfileRlState(st);
  return agent;
}

export function rollbackProfileRlPolicyTo(
  profileId: string,
  index = 0
): { ok: boolean; detail: string } {
  const st = loadProfileRlState();
  const agent = st.agents[profileId];
  if (!agent || !agent.policyHistory.length) {
    return { ok: false, detail: 'No policy history to rollback' };
  }
  const entry = agent.policyHistory[index];
  if (!entry) return { ok: false, detail: 'Invalid history index' };
  agent.policy = { ...entry.before };
  agent.tradesSinceUpdate = 0;
  agent.preUpdateRewardEma = agent.rewardEma;
  agent.updatedAt = Date.now();
  pushProfileRlDecision({
    kind: 'rollback',
    profileId,
    detail: `Rolled back policy · ${entry.summary}`,
  });
  saveProfileRlState(st);
  return { ok: true, detail: `Restored policy from ${new Date(entry.at).toISOString()}` };
}
