/**
 * Zion continuous learning — working / long-term / growth memory + versioned personality.
 * Never invents family facts; never rewrites TP/SL/ML. Personality deltas clamped.
 * DATA_DIR: zion-working-memory.json, zion-long-term-memory.json,
 * zion-system-growth.json, zion-personality-profile.json, zion-personality-versions.json
 */

import { atomicWriteJson, dataFile, ensureDataDir, readJsonFile } from './dataDir';
import { logger } from './logger';

const WORKING_FILE = 'zion-working-memory.json';
const LONG_TERM_FILE = 'zion-long-term-memory.json';
const GROWTH_FILE = 'zion-system-growth.json';
const PERSONALITY_FILE = 'zion-personality-profile.json';
const VERSIONS_FILE = 'zion-personality-versions.json';

const SELF_UPDATE_MS = 6 * 60 * 60 * 1000;
const LLM_CHATS_BEFORE_UPDATE = 20;
const MAX_VERSIONS = 10;
const PROMPT_CAP = 3800;

export type ZionFeedbackSignal =
  | 'good'
  | 'too_technical'
  | 'forgot_context'
  | 'better';

export interface ZionWorkingMemory {
  version: 1;
  updatedAt: number;
  threadSummary: string;
  openTopics: string[];
  lastDecisions: string[];
  activeWarnings: string[];
  needContextRefresh: boolean;
}

export interface ZionLongTermMemory {
  version: 1;
  updatedAt: number;
  prefs: string[];
  styleNotes: string[];
  recurringIssues: string[];
  changeRequestSnippets: string[];
  explanationFormats: string[];
}

export interface ZionSystemGrowthNote {
  version: string;
  title: string;
  plainEnglish: string;
  at: number;
}

export interface ZionSystemGrowth {
  version: 1;
  updatedAt: number;
  notes: ZionSystemGrowthNote[];
  lastIngestedPackageVersion: string;
}

export interface ZionPersonalityProfile {
  version: number;
  updatedAt: number;
  warmth: number;
  humour: number;
  clarity: number;
  technicality: number;
  brevity: number;
  vocabNotes: string[];
}

export interface ZionPersonalityVersions {
  version: 1;
  updatedAt: number;
  ring: ZionPersonalityProfile[];
}

interface LearningMeta {
  version: 1;
  updatedAt: number;
  llmChatCountSinceUpdate: number;
  lastSelfUpdateAt: number;
  totalSelfUpdates: number;
}

const META_FILE = 'zion-learning-meta.json';

let workingCache: ZionWorkingMemory | null = null;
let longTermCache: ZionLongTermMemory | null = null;
let growthCache: ZionSystemGrowth | null = null;
let personalityCache: ZionPersonalityProfile | null = null;
let versionsCache: ZionPersonalityVersions | null = null;
let metaCache: LearningMeta | null = null;
let selfUpdateTimer: ReturnType<typeof setTimeout> | null = null;

function clampWeight(n: number, lo = 0.1, hi = 0.9): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(hi, Math.max(lo, n));
}

function pathOf(file: string): string {
  ensureDataDir();
  return dataFile(file);
}

function saveJson(file: string, data: unknown): void {
  try {
    atomicWriteJson(pathOf(file), data);
  } catch (err) {
    console.warn(
      `[zion-learning] persist ${file} failed:`,
      err instanceof Error ? err.message : err
    );
  }
}

function emptyWorking(): ZionWorkingMemory {
  return {
    version: 1,
    updatedAt: Date.now(),
    threadSummary: '',
    openTopics: [],
    lastDecisions: [],
    activeWarnings: [],
    needContextRefresh: false,
  };
}

function emptyLongTerm(): ZionLongTermMemory {
  return {
    version: 1,
    updatedAt: Date.now(),
    prefs: [],
    styleNotes: [],
    recurringIssues: [],
    changeRequestSnippets: [],
    explanationFormats: [],
  };
}

function emptyGrowth(): ZionSystemGrowth {
  return {
    version: 1,
    updatedAt: Date.now(),
    notes: [],
    lastIngestedPackageVersion: '',
  };
}

function defaultPersonality(ver = 1): ZionPersonalityProfile {
  return {
    version: ver,
    updatedAt: Date.now(),
    warmth: 0.62,
    humour: 0.48,
    clarity: 0.72,
    technicality: 0.52,
    brevity: 0.58,
    vocabNotes: [],
  };
}

function emptyVersions(): ZionPersonalityVersions {
  return { version: 1, updatedAt: Date.now(), ring: [] };
}

function emptyMeta(): LearningMeta {
  return {
    version: 1,
    updatedAt: Date.now(),
    llmChatCountSinceUpdate: 0,
    lastSelfUpdateAt: 0,
    totalSelfUpdates: 0,
  };
}

export function loadZionWorkingMemory(): ZionWorkingMemory {
  if (workingCache) return workingCache;
  const p = readJsonFile<Partial<ZionWorkingMemory>>(pathOf(WORKING_FILE));
  if (p?.version === 1) {
    workingCache = {
      ...emptyWorking(),
      ...p,
      version: 1,
      openTopics: Array.isArray(p.openTopics) ? p.openTopics : [],
      lastDecisions: Array.isArray(p.lastDecisions) ? p.lastDecisions : [],
      activeWarnings: Array.isArray(p.activeWarnings) ? p.activeWarnings : [],
    };
    return workingCache;
  }
  workingCache = emptyWorking();
  return workingCache;
}

export function saveZionWorkingMemory(
  state: ZionWorkingMemory = loadZionWorkingMemory()
): void {
  state.updatedAt = Date.now();
  workingCache = state;
  saveJson(WORKING_FILE, state);
}

export function loadZionLongTermMemory(): ZionLongTermMemory {
  if (longTermCache) return longTermCache;
  const p = readJsonFile<Partial<ZionLongTermMemory>>(pathOf(LONG_TERM_FILE));
  if (p?.version === 1) {
    longTermCache = {
      ...emptyLongTerm(),
      ...p,
      version: 1,
      prefs: Array.isArray(p.prefs) ? p.prefs : [],
      styleNotes: Array.isArray(p.styleNotes) ? p.styleNotes : [],
      recurringIssues: Array.isArray(p.recurringIssues) ? p.recurringIssues : [],
      changeRequestSnippets: Array.isArray(p.changeRequestSnippets)
        ? p.changeRequestSnippets
        : [],
      explanationFormats: Array.isArray(p.explanationFormats)
        ? p.explanationFormats
        : [],
    };
    return longTermCache;
  }
  longTermCache = emptyLongTerm();
  return longTermCache;
}

export function saveZionLongTermMemory(
  state: ZionLongTermMemory = loadZionLongTermMemory()
): void {
  state.updatedAt = Date.now();
  longTermCache = state;
  saveJson(LONG_TERM_FILE, state);
}

export function loadZionSystemGrowth(): ZionSystemGrowth {
  if (growthCache) return growthCache;
  const p = readJsonFile<Partial<ZionSystemGrowth>>(pathOf(GROWTH_FILE));
  if (p?.version === 1) {
    growthCache = {
      ...emptyGrowth(),
      ...p,
      version: 1,
      notes: Array.isArray(p.notes) ? p.notes : [],
    };
    return growthCache;
  }
  growthCache = emptyGrowth();
  return growthCache;
}

export function saveZionSystemGrowth(
  state: ZionSystemGrowth = loadZionSystemGrowth()
): void {
  state.updatedAt = Date.now();
  growthCache = state;
  saveJson(GROWTH_FILE, state);
}

export function loadZionPersonality(): ZionPersonalityProfile {
  if (personalityCache) return personalityCache;
  const p = readJsonFile<Partial<ZionPersonalityProfile>>(
    pathOf(PERSONALITY_FILE)
  );
  if (p && typeof p.version === 'number') {
    personalityCache = {
      ...defaultPersonality(p.version),
      ...p,
      warmth: clampWeight(Number(p.warmth) || 0.62),
      humour: clampWeight(Number(p.humour) || 0.48),
      clarity: clampWeight(Number(p.clarity) || 0.72),
      technicality: clampWeight(Number(p.technicality) || 0.52),
      brevity: clampWeight(Number(p.brevity) || 0.58),
      vocabNotes: Array.isArray(p.vocabNotes) ? p.vocabNotes.slice(0, 12) : [],
    };
    return personalityCache;
  }
  personalityCache = defaultPersonality(1);
  saveJson(PERSONALITY_FILE, personalityCache);
  return personalityCache;
}

export function saveZionPersonality(
  state: ZionPersonalityProfile = loadZionPersonality()
): void {
  state.updatedAt = Date.now();
  state.warmth = clampWeight(state.warmth);
  state.humour = clampWeight(state.humour);
  state.clarity = clampWeight(state.clarity);
  state.technicality = clampWeight(state.technicality);
  state.brevity = clampWeight(state.brevity);
  personalityCache = state;
  saveJson(PERSONALITY_FILE, state);
}

export function loadZionPersonalityVersions(): ZionPersonalityVersions {
  if (versionsCache) return versionsCache;
  const p = readJsonFile<Partial<ZionPersonalityVersions>>(
    pathOf(VERSIONS_FILE)
  );
  if (p?.version === 1) {
    versionsCache = {
      version: 1,
      updatedAt: Number(p.updatedAt) || Date.now(),
      ring: Array.isArray(p.ring) ? p.ring.slice(0, MAX_VERSIONS) : [],
    };
    return versionsCache;
  }
  versionsCache = emptyVersions();
  return versionsCache;
}

function saveVersions(state: ZionPersonalityVersions): void {
  state.updatedAt = Date.now();
  versionsCache = state;
  saveJson(VERSIONS_FILE, state);
}

function loadMeta(): LearningMeta {
  if (metaCache) return metaCache;
  const p = readJsonFile<Partial<LearningMeta>>(pathOf(META_FILE));
  if (p?.version === 1) {
    metaCache = { ...emptyMeta(), ...p, version: 1 };
    return metaCache;
  }
  metaCache = emptyMeta();
  return metaCache;
}

function saveMeta(state: LearningMeta): void {
  state.updatedAt = Date.now();
  metaCache = state;
  saveJson(META_FILE, state);
}

function pushUnique(list: string[], item: string, max: number): string[] {
  const t = String(item || '').trim().slice(0, 200);
  if (!t) return list;
  const next = [t, ...list.filter((x) => x !== t)];
  return next.slice(0, max);
}

/** Light working-memory touch after chat (incl. social smalltalk). */
export function touchZionWorkingMemory(opts: {
  userText: string;
  assistantText?: string;
  isSocial?: boolean;
  decisionNote?: string;
}): void {
  const wm = loadZionWorkingMemory();
  const topic = String(opts.userText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  if (topic) {
    wm.openTopics = pushUnique(wm.openTopics, topic, 6);
  }
  if (opts.decisionNote) {
    wm.lastDecisions = pushUnique(wm.lastDecisions, opts.decisionNote, 5);
  }
  if (opts.isSocial) {
    wm.threadSummary = wm.threadSummary
      ? wm.threadSummary
      : 'Casual check-in with Dad.';
  } else if (topic) {
    const asst = String(opts.assistantText || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
    wm.threadSummary = asst
      ? `Dad asked about “${topic.slice(0, 60)}…”; Zion: ${asst.slice(0, 100)}`
      : `Open: ${topic.slice(0, 100)}`;
  }
  if (wm.needContextRefresh) {
    wm.needContextRefresh = false;
  }
  saveZionWorkingMemory(wm);
}

function formatPersonalityForPrompt(p: ZionPersonalityProfile): string {
  const lean = (name: string, v: number, lo: string, hi: string) =>
    `${name}=${v.toFixed(2)} (${v < 0.4 ? lo : v > 0.65 ? hi : 'balanced'})`;
  return [
    `Personality profile v${p.version} (clamped style weights — not trading knobs):`,
    `  ${lean('warmth', p.warmth, 'cooler', 'warmer')}; ${lean('humour', p.humour, 'dry', 'witty')}; ${lean('clarity', p.clarity, 'dense', 'plain')};`,
    `  ${lean('technicality', p.technicality, 'simpler', 'more technical')}; ${lean('brevity', p.brevity, 'longer', 'shorter')}.`,
    p.vocabNotes.length
      ? `  Style cues: ${p.vocabNotes.slice(0, 4).join('; ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Inject after family memory when personality ON.
 * Cap ~3–4k chars total for working + long-term + growth + domain + personality.
 */
export function formatLearningMemoryForPrompt(): string {
  const blocks: string[] = [];
  const wm = loadZionWorkingMemory();
  const wmLines = [
    'Working memory (this thread — do not invent beyond chat/context):',
    wm.threadSummary ? `  Summary: ${wm.threadSummary}` : '  Summary: (none yet)',
    wm.openTopics.length
      ? `  Open topics: ${wm.openTopics.slice(0, 4).join(' · ')}`
      : '',
    wm.lastDecisions.length
      ? `  Last decisions: ${wm.lastDecisions.slice(0, 2).join(' · ')}`
      : '',
    wm.activeWarnings.length
      ? `  Active warnings: ${wm.activeWarnings.slice(0, 3).join(' · ')}`
      : '',
    wm.needContextRefresh
      ? '  Cue: Dad said you forgot context — re-anchor to open topics before answering.'
      : '',
  ].filter(Boolean);
  blocks.push(wmLines.join('\n'));

  const lt = loadZionLongTermMemory();
  const ltBits: string[] = ['Long-term memory (prefs / style — not family facts):'];
  if (lt.prefs.length) ltBits.push(`  Prefs: ${lt.prefs.slice(0, 4).join('; ')}`);
  if (lt.styleNotes.length)
    ltBits.push(`  Style: ${lt.styleNotes.slice(0, 4).join('; ')}`);
  if (lt.recurringIssues.length)
    ltBits.push(`  Recurring: ${lt.recurringIssues.slice(0, 3).join('; ')}`);
  if (lt.explanationFormats.length)
    ltBits.push(
      `  Formats Dad liked: ${lt.explanationFormats.slice(0, 3).join('; ')}`
    );
  if (lt.changeRequestSnippets.length)
    ltBits.push(
      `  CR notes: ${lt.changeRequestSnippets.slice(0, 2).join('; ')}`
    );
  if (ltBits.length > 1) blocks.push(ltBits.join('\n'));

  const growth = loadZionSystemGrowth();
  const notes = growth.notes.slice(0, 8);
  if (notes.length) {
    blocks.push(
      [
        'System growth (Bot Info — accurate feature notes only):',
        ...notes.map(
          (n) => `  v${n.version} ${n.title}: ${n.plainEnglish.slice(0, 140)}`
        ),
      ].join('\n')
    );
  }

  try {
    const { formatDomainKnowledgeForPrompt } =
      require('./zionDomainKnowledge') as typeof import('./zionDomainKnowledge');
    blocks.push(formatDomainKnowledgeForPrompt(1200));
  } catch {
    /* optional */
  }

  blocks.push(formatPersonalityForPrompt(loadZionPersonality()));

  let out = blocks.join('\n\n');
  if (out.length > PROMPT_CAP) out = out.slice(0, PROMPT_CAP - 1) + '…';
  return out;
}

export function recordZionFeedback(opts: {
  messageId: string;
  signal: ZionFeedbackSignal;
}): { ok: boolean; detail: string; personalityVersion: number } {
  const signal = opts.signal;
  if (
    signal !== 'good' &&
    signal !== 'too_technical' &&
    signal !== 'forgot_context' &&
    signal !== 'better'
  ) {
    return {
      ok: false,
      detail: 'Invalid signal',
      personalityVersion: loadZionPersonality().version,
    };
  }

  const p = { ...loadZionPersonality() };
  const lt = loadZionLongTermMemory();
  const delta = 0.04;

  if (signal === 'good' || signal === 'better') {
    p.clarity = clampWeight(p.clarity + delta * 0.5);
    p.warmth = clampWeight(p.warmth + delta * 0.35);
    p.brevity = clampWeight(p.brevity + (signal === 'better' ? delta : 0));
    lt.styleNotes = pushUnique(
      lt.styleNotes,
      signal === 'better'
        ? 'Prefer clearer, tighter explanations'
        : 'Recent reply landed well',
      10
    );
    if (signal === 'good') {
      lt.explanationFormats = pushUnique(
        lt.explanationFormats,
        `Liked message ${String(opts.messageId || '').slice(0, 24)}`,
        8
      );
    }
  } else if (signal === 'too_technical') {
    p.technicality = clampWeight(p.technicality - delta);
    p.clarity = clampWeight(p.clarity + delta);
    p.brevity = clampWeight(p.brevity + delta * 0.5);
    lt.styleNotes = pushUnique(
      lt.styleNotes,
      'Dial back jargon; more plain English',
      10
    );
  } else if (signal === 'forgot_context') {
    const wm = loadZionWorkingMemory();
    wm.needContextRefresh = true;
    wm.activeWarnings = pushUnique(
      wm.activeWarnings,
      'Forgot context — re-read open topics',
      5
    );
    saveZionWorkingMemory(wm);
    lt.recurringIssues = pushUnique(
      lt.recurringIssues,
      'Context continuity slip',
      8
    );
  }

  saveZionPersonality(p);
  saveZionLongTermMemory(lt);

  try {
    const { recordAgentDecision } =
      require('./agentDecisionLog') as typeof import('./agentDecisionLog');
    recordAgentDecision({
      agent: 'Zion',
      source: 'zion',
      decisionType: 'hint',
      target: 'zion_learning',
      summary: `Feedback: ${signal}`,
      detail: `messageId=${opts.messageId}`,
      applied: 'observation_only',
      dedupeKey: `zion-fb-${signal}-${opts.messageId}`,
    });
  } catch {
    /* */
  }

  return {
    ok: true,
    detail: `Recorded ${signal}`,
    personalityVersion: p.version,
  };
}

/** Ingest newest BOT_INFO_CHANGELOG entries into system-growth notes. */
export function ingestBotInfoGrowthNotes(force = false): {
  added: number;
  packageVersion: string;
} {
  let packageVersion = '';
  try {
    const { getAppVersion } = require('./version') as typeof import('./version');
    packageVersion = String(getAppVersion().version || '');
  } catch {
    packageVersion = '';
  }

  const growth = loadZionSystemGrowth();
  if (
    !force &&
    packageVersion &&
    growth.lastIngestedPackageVersion === packageVersion &&
    growth.notes.length > 0
  ) {
    return { added: 0, packageVersion };
  }

  let added = 0;
  try {
    const { BOT_INFO_CHANGELOG } =
      require('./botInfoChangelog') as typeof import('./botInfoChangelog');
    const existing = new Set(growth.notes.map((n) => n.version));
    for (const entry of BOT_INFO_CHANGELOG.slice(0, 14)) {
      const ver = String(entry.version || '');
      if (!ver || existing.has(ver)) continue;
      const plain = String(entry.items?.[0] || entry.title || '').slice(0, 280);
      growth.notes.unshift({
        version: ver,
        title: String(entry.title || '').slice(0, 120),
        plainEnglish: plain,
        at: Date.now(),
      });
      existing.add(ver);
      added += 1;
    }
    growth.notes = growth.notes.slice(0, 40);
    if (packageVersion) growth.lastIngestedPackageVersion = packageVersion;
    saveZionSystemGrowth(growth);
  } catch (err) {
    console.warn(
      '[zion-learning] growth ingest failed:',
      err instanceof Error ? err.message : err
    );
  }
  return { added, packageVersion };
}

function snapshotPersonalityToVersions(p: ZionPersonalityProfile): void {
  const vers = loadZionPersonalityVersions();
  const copy: ZionPersonalityProfile = { ...p, vocabNotes: [...p.vocabNotes] };
  vers.ring = [
    copy,
    ...vers.ring.filter((x) => x.version !== p.version),
  ].slice(0, MAX_VERSIONS);
  saveVersions(vers);
}

function heuristicCompressChatIntoMemory(): void {
  try {
    const { loadZionAgentState } =
      require('./zionAgentStore') as typeof import('./zionAgentStore');
    const msgs = loadZionAgentState().messages.slice(-24);
    const lt = loadZionLongTermMemory();
    const wm = loadZionWorkingMemory();
    const userBits = msgs
      .filter((m) => m.role === 'user')
      .map((m) => m.text.replace(/\s+/g, ' ').trim().slice(0, 80))
      .filter(Boolean);
    for (const u of userBits.slice(-4)) {
      wm.openTopics = pushUnique(wm.openTopics, u, 6);
    }
    const techAsk = userBits.find((u) =>
      /MARL|learning|TP|SL|profile|WR|PF|skip/i.test(u)
    );
    if (techAsk) {
      lt.prefs = pushUnique(lt.prefs, `Often asks about: ${techAsk}`, 8);
    }
    const lastUser = userBits[userBits.length - 1];
    const lastAsst = [...msgs]
      .reverse()
      .find((m) => m.role === 'assistant');
    if (lastUser) {
      wm.threadSummary = `Recent focus: ${lastUser}${
        lastAsst
          ? ` → ${String(lastAsst.text).replace(/\s+/g, ' ').slice(0, 100)}`
          : ''
      }`;
    }
    saveZionWorkingMemory(wm);
    saveZionLongTermMemory(lt);
  } catch {
    /* fail soft */
  }
}

export async function runZionSelfUpdate(reason = 'schedule'): Promise<{
  ok: boolean;
  personalityVersion: number;
  detail: string;
}> {
  const meta = loadMeta();
  const p = loadZionPersonality();
  snapshotPersonalityToVersions(p);

  heuristicCompressChatIntoMemory();

  let domainDetail = '';
  try {
    const { refreshZionDomainKnowledge } =
      require('./zionDomainKnowledge') as typeof import('./zionDomainKnowledge');
    const r = await refreshZionDomainKnowledge(true);
    domainDetail = `domain=${r.source}/${r.count}`;
  } catch {
    domainDetail = 'domain=skip';
  }

  ingestBotInfoGrowthNotes(false);

  const next: ZionPersonalityProfile = {
    ...p,
    version: p.version + 1,
    // Tiny drift toward clarity/brevity from idle learning; still clamped
    clarity: clampWeight(p.clarity + 0.01),
    brevity: clampWeight(p.brevity + 0.005),
    updatedAt: Date.now(),
  };
  saveZionPersonality(next);

  meta.llmChatCountSinceUpdate = 0;
  meta.lastSelfUpdateAt = Date.now();
  meta.totalSelfUpdates += 1;
  saveMeta(meta);

  try {
    const { recordAgentDecision } =
      require('./agentDecisionLog') as typeof import('./agentDecisionLog');
    recordAgentDecision({
      agent: 'Zion',
      source: 'zion',
      decisionType: 'mode_change',
      target: 'zion_learning',
      summary: `Self-update → personality v${next.version}`,
      detail: `${reason}; ${domainDetail}`,
      applied: 'observation_only',
      dedupeKey: `zion-self-${next.version}`,
    });
  } catch {
    /* */
  }

  logger.info(
    'Zion',
    `Learning self-update v${next.version} (${reason}; ${domainDetail})`
  );

  return {
    ok: true,
    personalityVersion: next.version,
    detail: `Personality v${next.version}; ${domainDetail}`,
  };
}

export function rollbackPersonality(toVersion?: number): {
  ok: boolean;
  detail: string;
  personalityVersion: number;
} {
  const vers = loadZionPersonalityVersions();
  const current = loadZionPersonality();
  let target: ZionPersonalityProfile | undefined;
  if (toVersion != null) {
    target = vers.ring.find((v) => v.version === toVersion);
  } else {
    target = vers.ring.find((v) => v.version !== current.version) || vers.ring[0];
  }
  if (!target) {
    return {
      ok: false,
      detail: 'No snapshot to roll back to',
      personalityVersion: current.version,
    };
  }
  snapshotPersonalityToVersions(current);
  const restored: ZionPersonalityProfile = {
    ...target,
    version: current.version + 1,
    updatedAt: Date.now(),
    warmth: clampWeight(target.warmth),
    humour: clampWeight(target.humour),
    clarity: clampWeight(target.clarity),
    technicality: clampWeight(target.technicality),
    brevity: clampWeight(target.brevity),
    vocabNotes: Array.isArray(target.vocabNotes)
      ? target.vocabNotes.slice(0, 12)
      : [],
  };
  // Keep weights from snapshot; bump version for audit trail
  restored.warmth = clampWeight(target.warmth);
  saveZionPersonality(restored);
  return {
    ok: true,
    detail: `Rolled back weights from v${target.version} → now v${restored.version}`,
    personalityVersion: restored.version,
  };
}

/** Call after a successful external LLM chat turn. */
export function noteZionLlmChatCompleted(): void {
  const meta = loadMeta();
  meta.llmChatCountSinceUpdate += 1;
  saveMeta(meta);
  if (meta.llmChatCountSinceUpdate >= LLM_CHATS_BEFORE_UPDATE) {
    void runZionSelfUpdate('after_20_chats').catch(() => {});
  }
}

export function getZionLearningStatus(): {
  personalityVersion: number;
  personality: ZionPersonalityProfile;
  versionsAvailable: number[];
  lastSelfUpdateAt: number;
  llmChatCountSinceUpdate: number;
  totalSelfUpdates: number;
  workingTopics: number;
  growthNotes: number;
  lastIngestedPackageVersion: string;
  domainUpdatedAt: number;
  domainCoinCount: number;
} {
  const p = loadZionPersonality();
  const vers = loadZionPersonalityVersions();
  const meta = loadMeta();
  const wm = loadZionWorkingMemory();
  const growth = loadZionSystemGrowth();
  let domainUpdatedAt = 0;
  let domainCoinCount = 0;
  try {
    const { loadZionDomainKnowledge } =
      require('./zionDomainKnowledge') as typeof import('./zionDomainKnowledge');
    const d = loadZionDomainKnowledge();
    domainUpdatedAt = d.lastRefreshAt || d.updatedAt;
    domainCoinCount = d.topCoins.length;
  } catch {
    /* */
  }
  return {
    personalityVersion: p.version,
    personality: p,
    versionsAvailable: vers.ring.map((v) => v.version),
    lastSelfUpdateAt: meta.lastSelfUpdateAt,
    llmChatCountSinceUpdate: meta.llmChatCountSinceUpdate,
    totalSelfUpdates: meta.totalSelfUpdates,
    workingTopics: wm.openTopics.length,
    growthNotes: growth.notes.length,
    lastIngestedPackageVersion: growth.lastIngestedPackageVersion,
    domainUpdatedAt,
    domainCoinCount,
  };
}

function scheduleNextSelfUpdate(): void {
  if (selfUpdateTimer) clearTimeout(selfUpdateTimer);
  selfUpdateTimer = setTimeout(() => {
    void (async () => {
      try {
        await runZionSelfUpdate('schedule_6h');
      } catch (err) {
        console.warn(
          '[zion-learning] scheduled self-update failed:',
          err instanceof Error ? err.message : err
        );
      } finally {
        scheduleNextSelfUpdate();
      }
    })();
  }, SELF_UPDATE_MS);
}

export function startZionLearningScheduler(): void {
  try {
    ingestBotInfoGrowthNotes(false);
  } catch {
    /* */
  }
  setTimeout(() => {
    void (async () => {
      try {
        const { refreshZionDomainKnowledge } =
          require('./zionDomainKnowledge') as typeof import('./zionDomainKnowledge');
        await refreshZionDomainKnowledge(false);
      } catch {
        /* */
      }
    })();
  }, 25_000);

  const meta = loadMeta();
  const dueIn =
    meta.lastSelfUpdateAt > 0
      ? Math.max(60_000, SELF_UPDATE_MS - (Date.now() - meta.lastSelfUpdateAt))
      : SELF_UPDATE_MS;
  if (selfUpdateTimer) clearTimeout(selfUpdateTimer);
  selfUpdateTimer = setTimeout(() => {
    void (async () => {
      try {
        await runZionSelfUpdate('schedule_6h');
      } catch {
        /* */
      } finally {
        scheduleNextSelfUpdate();
      }
    })();
  }, dueIn);
}

export function stopZionLearningScheduler(): void {
  if (selfUpdateTimer) {
    clearTimeout(selfUpdateTimer);
    selfUpdateTimer = null;
  }
}
