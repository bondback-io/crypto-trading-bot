/**
 * Zion Agent chat history + Improvement Requests (DATA_DIR/zion-agent.json).
 * Persists Semi-Autonomous Change Requests as Improvement Requests.
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

export type ZionImprovementStatus = 'pending' | 'approved' | 'denied';

/** @deprecated Prefer ZionImprovementStatus — kept for callers that still say Change Request */
export type ZionChangeRequestStatus = ZionImprovementStatus;

export interface ZionChangeRequest {
  id: string;
  createdAt: number;
  status: ZionImprovementStatus;
  title: string;
  what: string;
  why: string;
  expectedBenefit: string;
  target: 'global_gates' | 'system';
  payload: Record<string, unknown>;
  decidedAt?: number;
  decideNote?: string;
  /** Set when approved — what the allowlisted apply did */
  applyDetail?: string;
}

/** Alias for product naming */
export type ZionImprovementRequest = ZionChangeRequest;

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

function normalizeStatus(raw: unknown): ZionImprovementStatus {
  if (raw === 'approved') return 'approved';
  if (raw === 'denied' || raw === 'rejected') return 'denied';
  return 'pending';
}

function normalizeChangeRequest(raw: unknown): ZionChangeRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (!c.id || !c.title) return null;
  const target =
    c.target === 'system' || c.target === 'global_gates'
      ? c.target
      : 'global_gates';
  return {
    id: String(c.id),
    createdAt: Number(c.createdAt) || Date.now(),
    status: normalizeStatus(c.status),
    title: String(c.title || '').slice(0, 120),
    what: String(c.what || '').slice(0, 800),
    why: String(c.why || '').slice(0, 800),
    expectedBenefit: String(c.expectedBenefit || '').slice(0, 400),
    target,
    payload:
      c.payload && typeof c.payload === 'object'
        ? (c.payload as Record<string, unknown>)
        : {},
    decidedAt: c.decidedAt != null ? Number(c.decidedAt) : undefined,
    decideNote: c.decideNote != null ? String(c.decideNote) : undefined,
    applyDetail: c.applyDetail != null ? String(c.applyDetail) : undefined,
  };
}

export function loadZionAgentState(): ZionAgentPersisted {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(path(), 'utf8');
    const parsed = JSON.parse(raw) as ZionAgentPersisted;
    if (parsed?.version === 1) {
      const crs = Array.isArray(parsed.changeRequests)
        ? parsed.changeRequests
            .map(normalizeChangeRequest)
            .filter((c): c is ZionChangeRequest => !!c)
        : [];
      cache = {
        version: 1,
        updatedAt: Number(parsed.updatedAt) || Date.now(),
        semiAutonomous: parsed.semiAutonomous === true,
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        changeRequests: crs,
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

export interface ZionChatArchiveEntry {
  id: string;
  clearedAt: number;
  messageCount: number;
  messages: ZionChatMessage[];
}

interface ZionChatArchivesFile {
  version: 1;
  updatedAt: number;
  archives: ZionChatArchiveEntry[];
}

const ARCHIVE_FILE = 'zion-chat-archives.json';
const MAX_ARCHIVES = 40;

function archivePath(): string {
  ensureDataDir();
  return dataFile(ARCHIVE_FILE);
}

function loadChatArchives(): ZionChatArchivesFile {
  try {
    const raw = fs.readFileSync(archivePath(), 'utf8');
    const parsed = JSON.parse(raw) as ZionChatArchivesFile;
    if (parsed?.version === 1 && Array.isArray(parsed.archives)) {
      return {
        version: 1,
        updatedAt: Number(parsed.updatedAt) || Date.now(),
        archives: parsed.archives.filter(
          (a) => a && Array.isArray(a.messages) && a.id
        ),
      };
    }
  } catch {
    /* */
  }
  return { version: 1, updatedAt: Date.now(), archives: [] };
}

function saveChatArchives(file: ZionChatArchivesFile): void {
  file.updatedAt = Date.now();
  try {
    fs.writeFileSync(archivePath(), JSON.stringify(file, null, 2), 'utf8');
  } catch (err) {
    console.warn(
      '[zion-agent] archive persist failed:',
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Archive the current thread to DATA_DIR/zion-chat-archives.json, then clear
 * the live chat. Improvement Requests are untouched.
 */
export function clearZionChat(): {
  cleared: number;
  archived: boolean;
  archiveId: string | null;
} {
  const st = loadZionAgentState();
  const msgs = Array.isArray(st.messages) ? st.messages.slice() : [];
  let archiveId: string | null = null;
  let archived = false;
  if (msgs.length > 0) {
    archiveId = `zarch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const file = loadChatArchives();
    file.archives.unshift({
      id: archiveId,
      clearedAt: Date.now(),
      messageCount: msgs.length,
      messages: msgs,
    });
    while (file.archives.length > MAX_ARCHIVES) file.archives.pop();
    saveChatArchives(file);
    archived = true;
  }
  st.messages = [];
  saveZionAgentState(st);
  return { cleared: msgs.length, archived, archiveId };
}

export function listZionChatArchives(limit = 20): Array<{
  id: string;
  clearedAt: number;
  messageCount: number;
}> {
  return loadChatArchives()
    .archives.slice(0, Math.max(1, limit))
    .map((a) => ({
      id: a.id,
      clearedAt: a.clearedAt,
      messageCount: a.messageCount,
    }));
}

export function getZionChatArchive(
  id: string
): ZionChatArchiveEntry | null {
  return loadChatArchives().archives.find((a) => a.id === id) || null;
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

export function getZionChangeRequest(id: string): ZionChangeRequest | null {
  const st = loadZionAgentState();
  return st.changeRequests.find((c) => c.id === id) || null;
}

export function listPendingZionImprovements(): ZionChangeRequest[] {
  return loadZionAgentState().changeRequests.filter((c) => c.status === 'pending');
}

/** Approved + denied history (newest first). */
export function listZionImprovementHistory(limit = 40): ZionChangeRequest[] {
  return loadZionAgentState()
    .changeRequests.filter((c) => c.status === 'approved' || c.status === 'denied')
    .slice(0, Math.max(1, limit));
}

export function decideZionChangeRequest(
  id: string,
  status: 'approved' | 'denied',
  note?: string,
  applyDetail?: string
): ZionChangeRequest | null {
  const st = loadZionAgentState();
  const row = st.changeRequests.find((c) => c.id === id);
  if (!row || row.status !== 'pending') return null;
  row.status = status;
  row.decidedAt = Date.now();
  row.decideNote = note || '';
  if (applyDetail) row.applyDetail = applyDetail;
  saveZionAgentState(st);
  return row;
}
