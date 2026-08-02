/**
 * Append-only journal of micro-bot self-learning / knobs persist events.
 * Stored at DATA_DIR/profile-learning-saves.json — survives deploys when DATA_DIR is durable.
 */

import fs from 'fs';
import path from 'path';
import {
  atomicWriteJson,
  dataFile,
  ensureDataDir,
  getPersistenceStatus,
  readJsonFile,
} from './dataDir';

export type LearningSaveKind =
  | 'knobs'
  | 'episode'
  | 'upgrade'
  | 'micro'
  | 'toggle'
  | 'reset'
  | 'min_trades'
  | 'learning_mode'
  | 'proposal'
  | 'rollback';

export interface LearningSaveEntry {
  id: string;
  at: number;
  profileId: string;
  botName: string;
  kind: LearningSaveKind;
  summary: string;
  episodeCount?: number;
  version?: number;
  /** True when the closed episode was opened under Learning Mode */
  learningMode?: boolean;
  learningStrictness?: 'stricter' | 'middle' | 'looser';
}

interface SaveLogFile {
  version: 1;
  updatedAt: number;
  entries: LearningSaveEntry[];
}

const MAX_ENTRIES = 200;
const FILE = () => dataFile('profile-learning-saves.json');

let cache: LearningSaveEntry[] | null = null;

/** Drop journal cache so next read reloads from disk. */
export function invalidateLearningSaveCache(): void {
  cache = null;
}

function loadEntries(): LearningSaveEntry[] {
  if (cache) return cache;
  try {
    ensureDataDir();
    const raw = readJsonFile<SaveLogFile>(FILE());
    if (raw && Array.isArray(raw.entries)) {
      cache = raw.entries
        .filter((e) => e && typeof e === 'object' && e.at)
        .slice(-MAX_ENTRIES);
      return cache;
    }
  } catch {
    /* fresh */
  }
  cache = [];
  return cache;
}

function persistEntries(entries: LearningSaveEntry[]): void {
  cache = entries.slice(-MAX_ENTRIES);
  try {
    ensureDataDir();
    const payload: SaveLogFile = {
      version: 1,
      updatedAt: Date.now(),
      entries: cache,
    };
    atomicWriteJson(FILE(), payload);
  } catch (err) {
    console.warn(
      '[learning-saves] Failed to write journal:',
      err instanceof Error ? err.message : err
    );
  }
}

function botNameFor(profileId: string): string {
  try {
    const { TRADE_PROFILE_CATALOG } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    const hit = TRADE_PROFILE_CATALOG.find((p) => p.id === profileId);
    if (hit?.name) return hit.name;
  } catch {
    /* catalog may not be ready */
  }
  if (!profileId || profileId === 'all') return 'All bots';
  return profileId;
}

export function appendLearningSave(input: {
  profileId?: string;
  botName?: string;
  kind: LearningSaveKind;
  summary: string;
  episodeCount?: number;
  version?: number;
  learningMode?: boolean;
  learningStrictness?: 'stricter' | 'middle' | 'looser';
}): LearningSaveEntry {
  const profileId = String(input.profileId || 'all').trim() || 'all';
  const entry: LearningSaveEntry = {
    id: `ls-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: Date.now(),
    profileId,
    botName: input.botName || botNameFor(profileId),
    kind: input.kind,
    summary: String(input.summary || '').slice(0, 240),
    episodeCount:
      input.episodeCount != null && Number.isFinite(input.episodeCount)
        ? Number(input.episodeCount)
        : undefined,
    version:
      input.version != null && Number.isFinite(input.version)
        ? Number(input.version)
        : undefined,
    learningMode: input.learningMode === true ? true : undefined,
    learningStrictness:
      input.learningStrictness === 'stricter' ||
      input.learningStrictness === 'middle' ||
      input.learningStrictness === 'looser'
        ? input.learningStrictness
        : undefined,
  };
  const entries = loadEntries();
  entries.push(entry);
  persistEntries(entries);
  return entry;
}

export function listLearningSaves(options?: {
  offset?: number;
  limit?: number;
  /** Profile id exact match, or bot name substring (case-insensitive) */
  bot?: string;
  /** Episode / knobs / upgrade / … */
  kind?: string;
  /** YYYY-MM-DD local calendar day (UTC day window from server) */
  date?: string;
  /** Free-text match against summary / bot / kind */
  q?: string;
}): {
  items: LearningSaveEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
} {
  let all = [...loadEntries()].sort((a, b) => b.at - a.at);

  const bot = String(options?.bot || '').trim().toLowerCase();
  if (bot && bot !== 'all') {
    all = all.filter((e) => {
      const id = String(e.profileId || '').toLowerCase();
      const name = String(e.botName || '').toLowerCase();
      return id === bot || name === bot || name.includes(bot) || id.includes(bot);
    });
  }

  const kind = String(options?.kind || '').trim().toLowerCase();
  if (kind && kind !== 'all') {
    all = all.filter((e) => String(e.kind || '').toLowerCase() === kind);
  }

  const date = String(options?.date || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [y, m, d] = date.split('-').map((x) => Number(x));
    const start = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
    const end = start + 24 * 60 * 60 * 1000;
    // Also accept local-day interpretation: match either UTC day or local day for the entry
    all = all.filter((e) => {
      const t = Number(e.at) || 0;
      if (t >= start && t < end) return true;
      const local = new Date(t);
      const localKey =
        local.getFullYear() +
        '-' +
        String(local.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(local.getDate()).padStart(2, '0');
      return localKey === date;
    });
  }

  const q = String(options?.q || '').trim().toLowerCase();
  if (q) {
    all = all.filter((e) => {
      const hay = [
        e.summary,
        e.botName,
        e.profileId,
        e.kind,
        learningKindSearchBlob(e),
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }

  const offset = Math.max(0, Math.round(Number(options?.offset) || 0));
  const limit = Math.max(1, Math.min(50, Math.round(Number(options?.limit) || 10)));
  const items = all.slice(offset, offset + limit);
  return {
    items,
    total: all.length,
    offset,
    limit,
    hasMore: offset + items.length < all.length,
  };
}

function learningKindSearchBlob(e: LearningSaveEntry): string {
  const map: Record<string, string> = {
    knobs: 'knobs settings',
    episode: 'episode trade closed',
    upgrade: 'upgrade level',
    micro: 'micro tweak mutation',
    toggle: 'toggle learning',
    reset: 'reset',
    min_trades: 'min trades',
  };
  return map[e.kind] || e.kind || '';
}

function listEpisodeFiles(): Array<{
  profileId: string;
  path: string;
  updatedAt: number;
  episodeCount: number;
  sizeBytes: number;
  recent: unknown[];
}> {
  const out: Array<{
    profileId: string;
    path: string;
    updatedAt: number;
    episodeCount: number;
    sizeBytes: number;
    recent: unknown[];
  }> = [];
  try {
    const dir = dataFile('profile-learning');
    if (!fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        const raw = JSON.parse(fs.readFileSync(full, 'utf8')) as {
          profileId?: string;
          ring?: unknown[];
          updatedAt?: number;
        };
        const ring = Array.isArray(raw.ring) ? raw.ring : [];
        const profileId =
          String(raw.profileId || name.replace(/\.json$/i, '')).trim() ||
          name;
        out.push({
          profileId,
          path: full,
          updatedAt:
            raw.updatedAt != null && Number.isFinite(Number(raw.updatedAt))
              ? Number(raw.updatedAt)
              : st.mtimeMs,
          episodeCount: ring.length,
          sizeBytes: st.size,
          recent: ring.slice(-50),
        });
      } catch {
        /* skip bad file */
      }
    }
  } catch {
    /* none */
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getLearningHealthSummary(options?: {
  offset?: number;
  limit?: number;
  bot?: string;
  kind?: string;
  date?: string;
  q?: string;
}): {
  health: 'ok' | 'degraded' | 'at_risk';
  reason: string;
  persistence: ReturnType<typeof getPersistenceStatus>;
  learningOnCount: number;
  profilesWithEpisodes: number;
  totalEpisodes: number;
  userFileUpdatedAt: number | null;
  lastSaveAt: number | null;
  /** Journal remembers learning but episode files are empty/gone */
  episodesDroppedLikely: boolean;
  learningFilesMissing: boolean;
  bots: Array<{
    id: string;
    name: string;
    learningEnabled: boolean;
    episodeCount: number;
    fileUpdatedAt: number | null;
    version: number;
    lastUpgradedAt: number | null;
    tradesSinceUpgrade: number;
  }>;
  filterBots: Array<{ id: string; name: string }>;
  saves: ReturnType<typeof listLearningSaves>;
} {
  const persistence = getPersistenceStatus();
  const saves = listLearningSaves({
    offset: options?.offset,
    limit: options?.limit,
    bot: options?.bot,
    kind: options?.kind,
    date: options?.date,
    q: options?.q,
  });
  const episodeFiles = listEpisodeFiles();
  const episodeById = new Map(episodeFiles.map((e) => [e.profileId, e]));

  let learningOnCount = 0;
  const bots: Array<{
    id: string;
    name: string;
    learningEnabled: boolean;
    episodeCount: number;
    fileUpdatedAt: number | null;
    version: number;
    lastUpgradedAt: number | null;
    tradesSinceUpgrade: number;
  }> = [];

  try {
    const {
      TRADE_PROFILE_CATALOG,
      getProfileSelfLearning,
      ensureTradeProfilesInitialized,
    } = require('./tradeProfiles') as typeof import('./tradeProfiles');
    ensureTradeProfilesInitialized();
    for (const p of TRADE_PROFILE_CATALOG) {
      if (p.id === 'default' || p.id === 'migration') continue;
      const sl = getProfileSelfLearning(p.id);
      const ep = episodeById.get(p.id);
      if (sl.enabled) learningOnCount += 1;
      bots.push({
        id: p.id,
        name: p.name,
        learningEnabled: sl.enabled === true,
        episodeCount: ep?.episodeCount ?? 0,
        fileUpdatedAt: ep?.updatedAt ?? null,
        version: sl.version || 0,
        lastUpgradedAt: sl.lastUpgradedAt,
        tradesSinceUpgrade: sl.tradesSinceUpgrade || 0,
      });
    }
  } catch {
    /* trade profiles unavailable */
  }

  const totalEpisodes = episodeFiles.reduce((s, e) => s + e.episodeCount, 0);
  const profilesWithEpisodes = episodeFiles.filter((e) => e.episodeCount > 0)
    .length;

  let userFileUpdatedAt: number | null = null;
  try {
    const { loadTradeProfilesUserState } =
      require('./tradeProfilesUserStore') as typeof import('./tradeProfilesUserStore');
    const user = loadTradeProfilesUserState();
    if (user?.updatedAt != null && Number.isFinite(Number(user.updatedAt))) {
      userFileUpdatedAt = Number(user.updatedAt);
    }
  } catch {
    /* optional */
  }

  const journal = loadEntries();
  const lastSaveAt =
    journal.reduce((max, e) => Math.max(max, Number(e.at) || 0), 0) || null;
  const journalHadLearning = journal.some(
    (e) =>
      e.kind === 'episode' ||
      e.kind === 'upgrade' ||
      e.kind === 'micro' ||
      (e.episodeCount != null && e.episodeCount > 0)
  );
  const journalMaxEpisodes = journal.reduce(
    (max, e) => Math.max(max, Number(e.episodeCount) || 0),
    0
  );
  /** Episodes vanished after boot/deploy while journal still remembers prior learning */
  const episodesDroppedLikely =
    journalHadLearning &&
    totalEpisodes === 0 &&
    (journalMaxEpisodes > 0 ||
      journal.some((e) => e.kind === 'episode' || e.kind === 'upgrade'));
  const learningFilesMissing =
    !persistence.profileLearningExists &&
    (learningOnCount > 0 || journalHadLearning);

  let health: 'ok' | 'degraded' | 'at_risk' = 'ok';
  let reason = '';
  if (!persistence.writable) {
    health = 'at_risk';
    reason = 'Data directory is not writable — learning cannot be saved.';
  } else if (episodesDroppedLikely || learningFilesMissing) {
    health = 'at_risk';
    reason = episodesDroppedLikely
      ? 'Learning episodes missing after boot — prior journal exists but episode files are empty/gone. Mount DATA_DIR on a durable disk and restore a backup.'
      : 'Learning episode files missing — self-learning progress will not persist. Attach a Disk at DATA_DIR.';
  } else if (persistence.onRender) {
    if (!persistence.volumeMounted || !persistence.durableLikely || persistence.warning) {
      health = 'at_risk';
      reason =
        'Volume not mounted — email, knobs, and learning wipe on deploy. Attach a Disk at DATA_DIR (/var/data on Render).';
    } else if (!persistence.tradeProfilesUserExists && totalEpisodes === 0) {
      health = 'degraded';
      reason =
        'Durable disk OK, but no micro-bot knobs or episode files yet.';
    } else {
      health = 'ok';
      reason = `Durable — ${learningOnCount} bots learning ON — ${totalEpisodes} episodes`;
    }
  } else if (!persistence.tradeProfilesUserExists && totalEpisodes === 0) {
    health = 'degraded';
    reason = 'Local data OK, but no learning knobs or episodes stored yet.';
  } else {
    health = 'ok';
    reason = `Local — ${learningOnCount} bots learning ON — ${totalEpisodes} episodes`;
  }

  const filterBotMap = new Map<string, string>();
  for (const b of bots) {
    filterBotMap.set(b.id, b.name);
  }
  for (const e of journal) {
    if (e.profileId && !filterBotMap.has(e.profileId)) {
      filterBotMap.set(e.profileId, e.botName || e.profileId);
    }
  }
  const filterBots = [...filterBotMap.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    health,
    reason,
    persistence,
    learningOnCount,
    profilesWithEpisodes,
    totalEpisodes,
    userFileUpdatedAt,
    lastSaveAt,
    episodesDroppedLikely,
    learningFilesMissing,
    bots,
    filterBots,
    saves,
  };
}

export function exportLearningBundle(format: 'json' | 'csv'): {
  format: 'json' | 'csv';
  filename: string;
  contentType: string;
  body: string;
} {
  const health = getLearningHealthSummary({ offset: 0, limit: 200 });
  const episodeFiles = listEpisodeFiles();
  const allSaves = listLearningSaves({ offset: 0, limit: 200 }).items;

  let selfLearning: Record<string, unknown> = {};
  try {
    const { serializeTradeProfilesForPersist } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    const state = serializeTradeProfilesForPersist();
    selfLearning = (state.selfLearning || {}) as Record<string, unknown>;
  } catch {
    selfLearning = {};
  }

  if (format === 'csv') {
    const header = [
      'at',
      'profileId',
      'botName',
      'kind',
      'summary',
      'episodeCount',
      'version',
      'learningMode',
      'learningStrictness',
    ];
    const rows = allSaves.map((e) =>
      [
        new Date(e.at).toISOString(),
        e.profileId,
        e.botName,
        e.kind,
        JSON.stringify(e.summary),
        e.episodeCount ?? '',
        e.version ?? '',
        e.learningMode === true ? '1' : e.learningMode === false ? '0' : '',
        e.learningStrictness ?? '',
      ].join(',')
    );
    const botHeader =
      '\n\n# bots\nid,name,learningEnabled,episodeCount,version,lastUpgradedAt\n';
    const botRows = health.bots
      .map((b) =>
        [
          b.id,
          JSON.stringify(b.name),
          b.learningEnabled,
          b.episodeCount,
          b.version,
          b.lastUpgradedAt != null
            ? new Date(b.lastUpgradedAt).toISOString()
            : '',
        ].join(',')
      )
      .join('\n');
    const body =
      header.join(',') +
      '\n' +
      rows.join('\n') +
      botHeader +
      botRows +
      '\n';
    return {
      format: 'csv',
      filename: `microbot-learning-${Date.now()}.csv`,
      contentType: 'text/csv; charset=utf-8',
      body,
    };
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    health: {
      health: health.health,
      reason: health.reason,
      learningOnCount: health.learningOnCount,
      profilesWithEpisodes: health.profilesWithEpisodes,
      totalEpisodes: health.totalEpisodes,
      userFileUpdatedAt: health.userFileUpdatedAt,
      lastSaveAt: health.lastSaveAt,
      durableLikely: health.persistence.durableLikely,
      dataDir: health.persistence.dataDir,
    },
    bots: health.bots,
    saves: allSaves,
    selfLearning,
    episodes: episodeFiles.map((e) => ({
      profileId: e.profileId,
      updatedAt: e.updatedAt,
      episodeCount: e.episodeCount,
      sizeBytes: e.sizeBytes,
      recent: e.recent,
    })),
  };
  return {
    format: 'json',
    filename: `microbot-learning-${Date.now()}.json`,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(payload, null, 2),
  };
}
