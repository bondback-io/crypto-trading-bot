/**
 * Durable MARL agent weights + decision ring (DATA_DIR/marl-state.json).
 * Never stores TP/SL or profile exit overrides — coordination weights only.
 */

import fs from 'fs';
import { dataFile, ensureDataDir } from './dataDir';

export type MarlStrength = 'low' | 'medium' | 'high';

export interface MarlAgentState {
  profileId: string;
  /** Soft preference weight (PPO-style clipped updates). */
  weight: number;
  trades: number;
  wins: number;
  sumReward: number;
  lastReward: number;
  updatedAt: number;
}

export interface MarlDecision {
  at: number;
  kind: string;
  mint?: string;
  symbol?: string;
  profileId?: string;
  detail: string;
}

/** Soft lagging-profile support counters (see marlLaggingSupport.ts). */
export interface MarlLaggingPersisted {
  boost: number;
  supportsGiven: number;
  poorAfterSupport: number;
  lastSupportAt: number;
  coolingUntil: number;
  status: 'normal' | 'lagging' | 'supported' | 'cooling';
}

export interface MarlPersistedState {
  version: 1;
  updatedAt: number;
  agents: Record<string, MarlAgentState>;
  decisions: MarlDecision[];
  /** Recent opens for low-MC coordination: mint → [{at, profileId}] */
  recentLowMcOpens: Record<string, Array<{ at: number; profileId: string }>>;
  /** Optional per-profile lagging-support state */
  lagging?: Record<string, MarlLaggingPersisted>;
}

const FILE = 'marl-state.json';
const MAX_DECISIONS = 120;
const MAX_OPENS_PER_MINT = 12;

let cache: MarlPersistedState | null = null;

function emptyState(): MarlPersistedState {
  return {
    version: 1,
    updatedAt: Date.now(),
    agents: {},
    decisions: [],
    recentLowMcOpens: {},
    lagging: {},
  };
}

function path(): string {
  ensureDataDir();
  return dataFile(FILE);
}

export function loadMarlState(): MarlPersistedState {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(path(), 'utf8');
    const parsed = JSON.parse(raw) as MarlPersistedState;
    if (parsed && parsed.version === 1 && parsed.agents) {
      cache = {
        version: 1,
        updatedAt: Number(parsed.updatedAt) || Date.now(),
        agents: parsed.agents || {},
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
        recentLowMcOpens:
          parsed.recentLowMcOpens && typeof parsed.recentLowMcOpens === 'object'
            ? parsed.recentLowMcOpens
            : {},
        lagging:
          parsed.lagging && typeof parsed.lagging === 'object'
            ? parsed.lagging
            : {},
      };
      return cache;
    }
  } catch {
    /* fresh */
  }
  cache = emptyState();
  return cache;
}

export function saveMarlState(state: MarlPersistedState = loadMarlState()): void {
  state.updatedAt = Date.now();
  cache = state;
  try {
    fs.writeFileSync(path(), JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn(
      '[marl] persist failed:',
      err instanceof Error ? err.message : err
    );
  }
}

export function getOrCreateAgent(profileId: string): MarlAgentState {
  const st = loadMarlState();
  if (!st.agents[profileId]) {
    st.agents[profileId] = {
      profileId,
      weight: 0,
      trades: 0,
      wins: 0,
      sumReward: 0,
      lastReward: 0,
      updatedAt: Date.now(),
    };
    saveMarlState(st);
  }
  return st.agents[profileId];
}

export function pushMarlDecision(d: Omit<MarlDecision, 'at'> & { at?: number }): void {
  const st = loadMarlState();
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
  saveMarlState(st);
  try {
    const { mirrorMarlDecision } =
      require('./agentDecisionLog') as typeof import('./agentDecisionLog');
    mirrorMarlDecision({
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

export function recordLowMcOpen(mint: string, profileId: string, at = Date.now()): void {
  const st = loadMarlState();
  const key = String(mint || '');
  if (!key) return;
  const list = st.recentLowMcOpens[key] || [];
  list.push({ at, profileId });
  while (list.length > MAX_OPENS_PER_MINT) list.shift();
  st.recentLowMcOpens[key] = list;
  saveMarlState(st);
}

export function getRecentLowMcOpens(
  mint: string,
  windowMs: number,
  now = Date.now()
): Array<{ at: number; profileId: string }> {
  const st = loadMarlState();
  const list = st.recentLowMcOpens[String(mint || '')] || [];
  const cutoff = now - Math.max(1_000, windowMs);
  return list.filter((x) => x.at >= cutoff);
}

export function getMarlDecisions(limit = 40): MarlDecision[] {
  return loadMarlState().decisions.slice(0, Math.max(1, Math.min(100, limit)));
}
