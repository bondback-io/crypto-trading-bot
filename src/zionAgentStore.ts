/**
 * Zion Agent chat history + Change Requests (DATA_DIR/zion-agent.json).
 */

import fs from 'fs';
import { dataFile, ensureDataDir } from './dataDir';

export type ZionAgentMode = 'read_only' | 'semi_autonomous';

export interface ZionChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  at: number;
}

export interface ZionChangeRequest {
  id: string;
  createdAt: number;
  status: 'pending' | 'approved' | 'rejected';
  title: string;
  what: string;
  why: string;
  expectedBenefit: string;
  target: 'global_gates' | 'system';
  payload: Record<string, unknown>;
  decidedAt?: number;
  decideNote?: string;
}

export interface ZionAgentPersisted {
  version: 1;
  updatedAt: number;
  semiAutonomous: boolean;
  messages: ZionChatMessage[];
  changeRequests: ZionChangeRequest[];
}

const FILE = 'zion-agent.json';
const MAX_MSG = 80;
const MAX_CR = 60;

let cache: ZionAgentPersisted | null = null;

function empty(): ZionAgentPersisted {
  return {
    version: 1,
    updatedAt: Date.now(),
    semiAutonomous: false,
    messages: [],
    changeRequests: [],
  };
}

function path(): string {
  ensureDataDir();
  return dataFile(FILE);
}

export function loadZionAgentState(): ZionAgentPersisted {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(path(), 'utf8');
    const parsed = JSON.parse(raw) as ZionAgentPersisted;
    if (parsed?.version === 1) {
      cache = {
        version: 1,
        updatedAt: Number(parsed.updatedAt) || Date.now(),
        semiAutonomous: parsed.semiAutonomous === true,
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        changeRequests: Array.isArray(parsed.changeRequests)
          ? parsed.changeRequests
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

export function saveZionAgentState(
  state: ZionAgentPersisted = loadZionAgentState()
): void {
  state.updatedAt = Date.now();
  cache = state;
  try {
    fs.writeFileSync(path(), JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn(
      '[zion-agent] persist failed:',
      err instanceof Error ? err.message : err
    );
  }
}

export function setZionSemiAutonomous(on: boolean): void {
  const st = loadZionAgentState();
  st.semiAutonomous = on === true;
  saveZionAgentState(st);
}

export function appendZionChat(
  role: 'user' | 'assistant' | 'system',
  text: string
): ZionChatMessage {
  const st = loadZionAgentState();
  const msg: ZionChatMessage = {
    id: `zmsg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    role,
    text: String(text || '').slice(0, 12_000),
    at: Date.now(),
  };
  st.messages.push(msg);
  while (st.messages.length > MAX_MSG) st.messages.shift();
  saveZionAgentState(st);
  return msg;
}

export function addZionChangeRequest(
  cr: Omit<ZionChangeRequest, 'id' | 'createdAt' | 'status'>
): ZionChangeRequest {
  const st = loadZionAgentState();
  const row: ZionChangeRequest = {
    id: `zcr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: Date.now(),
    status: 'pending',
    title: cr.title,
    what: cr.what,
    why: cr.why,
    expectedBenefit: cr.expectedBenefit,
    target: cr.target,
    payload: cr.payload || {},
  };
  st.changeRequests.unshift(row);
  while (st.changeRequests.length > MAX_CR) st.changeRequests.pop();
  saveZionAgentState(st);
  return row;
}

export function decideZionChangeRequest(
  id: string,
  status: 'approved' | 'rejected',
  note?: string
): ZionChangeRequest | null {
  const st = loadZionAgentState();
  const row = st.changeRequests.find((c) => c.id === id);
  if (!row || row.status !== 'pending') return null;
  row.status = status;
  row.decidedAt = Date.now();
  row.decideNote = note || '';
  saveZionAgentState(st);
  return row;
}
