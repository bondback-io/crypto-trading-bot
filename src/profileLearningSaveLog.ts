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
  | 'toggle'
  | 'reset'
  | 'min_trades';

export interface LearningSaveEntry {
  id: string;
  at: number;
  profileId: string;
  botName: string;
  kind: LearningSaveKind;
  summary: string;
  episodeCount?: number;
  version?: number;
}

interface SaveLogFile {
  version: 1;
  updatedAt: number;
  entries: LearningSaveEntry[];
}

const MAX_ENTRIES = 200;
const FILE = () => dataFile('profile-learning-saves.json');

let cache: LearningSaveEntry[] | null = null;

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
        ? Math.max(0, Math.round(input.episodeCount))
        : undefined,
    version:
      input.version != null && Number.isFinite(input.version)
        ? Math.max(0, Math.round(input.version))
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
}): {
  items: LearningSaveEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
} {
  const all = [...loadEntries()].sort((a, b) => b.at - a.at);
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
}): {
  health: 'ok' | 'degraded' | 'at_risk';
  reason: string;
  persistence: ReturnType<typeof getPersistenceStatus>;
  learningOnCount: number;
  profilesWithEpisodes: number;
  totalEpisodes: number;
  userFileUpdatedAt: number | null;
  lastSaveAt: number | null;
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
  saves: ReturnType<typeof listLearningSaves>;
} {
  const persistence = getPersistenceStatus();
  const saves = listLearningSaves({
    offset: options?.offset,
    limit: options?.limit,
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

  const lastSaveAt = saves.items[0]?.at ?? null;

  let health: 'ok' | 'degraded' | 'at_risk' = 'ok';
  let reason = '';
  if (!persistence.writable) {
    health = 'at_risk';
    reason = 'Data directory is not writable — learning cannot be saved.';
  } else if (persistence.onRender || persistence.onFly) {
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

  return {
    health,
    reason,
    persistence,
    learningOnCount,
    profilesWithEpisodes,
    totalEpisodes,
    userFileUpdatedAt,
    lastSaveAt,
    bots,
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
