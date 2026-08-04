/**
 * Durable store for Profile TA Playbooks (user overrides over catalog defaults).
 * Survives bake/deploy like trade-profiles-user.json.
 */

import {
  atomicWriteJson,
  dataFile,
  ensureDataDir,
  PERSIST_FILES,
  readJsonFile,
} from './dataDir';
import { logger, errorToMeta } from './logger';
import {
  clampLearnedWeights,
  clonePlaybook,
  deepMergePlaybook,
  DEFAULT_PROFILE_TA_PLAYBOOKS,
  getDefaultProfileTaPlaybook,
  listProfileTaPlaybookIds,
  type ProfileTaLearnedWeights,
  type ProfileTaPlaybook,
  type ProfileTaMode,
  type ProfileTaWhaleMode,
} from './profileTaPlaybook';

export const PROFILE_TA_PLAYBOOKS_VERSION = 1 as const;

export interface ProfileTaPlaybooksFile {
  version: typeof PROFILE_TA_PLAYBOOKS_VERSION;
  updatedAt: number;
  /** Partial overrides keyed by profileId */
  playbooks: Record<string, Partial<ProfileTaPlaybook>>;
}

const FILE = () => dataFile(PERSIST_FILES.profileTaPlaybooks);

let cache: ProfileTaPlaybooksFile | null = null;
let loaded = false;

function emptyFile(): ProfileTaPlaybooksFile {
  return {
    version: PROFILE_TA_PLAYBOOKS_VERSION,
    updatedAt: 0,
    playbooks: {},
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function loadFile(): ProfileTaPlaybooksFile {
  if (loaded && cache) return cache;
  loaded = true;
  try {
    ensureDataDir();
    const raw = readJsonFile<ProfileTaPlaybooksFile>(FILE());
    if (!raw || !isPlainObject(raw)) {
      cache = emptyFile();
      return cache;
    }
    cache = {
      version: PROFILE_TA_PLAYBOOKS_VERSION,
      updatedAt: Number(raw.updatedAt) || 0,
      playbooks: isPlainObject(raw.playbooks)
        ? (raw.playbooks as ProfileTaPlaybooksFile['playbooks'])
        : {},
    };
    return cache;
  } catch (err) {
    logger.warn('ProfileTaPlaybooks', 'load failed', errorToMeta(err));
    cache = emptyFile();
    return cache;
  }
}

function persist(file: ProfileTaPlaybooksFile): void {
  try {
    ensureDataDir();
    file.updatedAt = Date.now();
    atomicWriteJson(FILE(), file);
    cache = file;
    loaded = true;
  } catch (err) {
    logger.warn('ProfileTaPlaybooks', 'persist failed', errorToMeta(err));
  }
}

export function invalidateProfileTaPlaybookCache(): void {
  cache = null;
  loaded = false;
}

export function getProfileTaPlaybook(profileId: string): ProfileTaPlaybook {
  const file = loadFile();
  const base = getDefaultProfileTaPlaybook(profileId);
  const overlay = file.playbooks[profileId];
  return deepMergePlaybook(base, overlay);
}

export function getAllProfileTaPlaybooks(): Record<string, ProfileTaPlaybook> {
  const out: Record<string, ProfileTaPlaybook> = {};
  for (const id of listProfileTaPlaybookIds()) {
    out[id] = getProfileTaPlaybook(id);
  }
  // Always include default for completeness
  out.default = getProfileTaPlaybook('default');
  return out;
}

export function getProfileTaPlaybooksPublic(): {
  version: number;
  updatedAt: number;
  defaults: Record<string, ProfileTaPlaybook>;
  playbooks: Record<string, ProfileTaPlaybook>;
  overrides: Record<string, Partial<ProfileTaPlaybook>>;
} {
  const file = loadFile();
  const defaults: Record<string, ProfileTaPlaybook> = {};
  for (const [id, pb] of Object.entries(DEFAULT_PROFILE_TA_PLAYBOOKS)) {
    defaults[id] = clonePlaybook(pb);
  }
  return {
    version: file.version,
    updatedAt: file.updatedAt,
    defaults,
    playbooks: getAllProfileTaPlaybooks(),
    overrides: { ...file.playbooks },
  };
}

function sanitizePatch(
  patch: Partial<ProfileTaPlaybook>
): Partial<ProfileTaPlaybook> {
  const out: Partial<ProfileTaPlaybook> = {};
  if (
    patch.taMode === 'off' ||
    patch.taMode === 'soft' ||
    patch.taMode === 'hard'
  ) {
    out.taMode = patch.taMode as ProfileTaMode;
  }
  if (
    patch.whaleMode === 'off' ||
    patch.whaleMode === 'soft' ||
    patch.whaleMode === 'hard'
  ) {
    out.whaleMode = patch.whaleMode as ProfileTaWhaleMode;
  }
  if (typeof patch.minConfluenceScore === 'number') {
    out.minConfluenceScore = Math.min(
      100,
      Math.max(0, Math.round(patch.minConfluenceScore))
    );
  }
  if (typeof patch.learningEnabled === 'boolean') {
    out.learningEnabled = patch.learningEnabled;
  }
  if (Array.isArray(patch.timeframes)) {
    out.timeframes = patch.timeframes;
  }
  if (patch.entryTools && isPlainObject(patch.entryTools)) {
    out.entryTools = patch.entryTools as ProfileTaPlaybook['entryTools'];
  }
  if (patch.exitTools && isPlainObject(patch.exitTools)) {
    out.exitTools = patch.exitTools as ProfileTaPlaybook['exitTools'];
  }
  if (patch.heikinAshi && isPlainObject(patch.heikinAshi)) {
    out.heikinAshi = patch.heikinAshi as ProfileTaPlaybook['heikinAshi'];
  }
  if (patch.supportResistance && isPlainObject(patch.supportResistance)) {
    out.supportResistance =
      patch.supportResistance as ProfileTaPlaybook['supportResistance'];
  }
  if (patch.learned && isPlainObject(patch.learned)) {
    out.learned = clampLearnedWeights(
      patch.learned as Partial<ProfileTaLearnedWeights>
    );
  }
  return out;
}

/** Merge user patch for one profile and persist. */
export function updateProfileTaPlaybook(
  profileId: string,
  patch: Partial<ProfileTaPlaybook>
): ProfileTaPlaybook {
  const file = loadFile();
  const prev = file.playbooks[profileId] || {};
  const sanitized = sanitizePatch(patch);
  file.playbooks[profileId] = {
    ...prev,
    ...sanitized,
    entryTools: sanitized.entryTools
      ? { ...(prev.entryTools || {}), ...sanitized.entryTools }
      : prev.entryTools,
    exitTools: sanitized.exitTools
      ? { ...(prev.exitTools || {}), ...sanitized.exitTools }
      : prev.exitTools,
    heikinAshi: sanitized.heikinAshi
      ? { ...(prev.heikinAshi || {}), ...sanitized.heikinAshi }
      : prev.heikinAshi,
    supportResistance: sanitized.supportResistance
      ? { ...(prev.supportResistance || {}), ...sanitized.supportResistance }
      : prev.supportResistance,
    learned: sanitized.learned
      ? {
          ...(prev.learned || {}),
          ...sanitized.learned,
          toolWeights: {
            ...(prev.learned?.toolWeights || {}),
            ...(sanitized.learned.toolWeights || {}),
          },
        }
      : prev.learned,
    profileId,
  };
  persist(file);
  return getProfileTaPlaybook(profileId);
}

/** Apply learned weight nudge only (clamped). */
export function applyProfileTaLearnedWeights(
  profileId: string,
  learned: Partial<ProfileTaLearnedWeights>
): ProfileTaPlaybook {
  return updateProfileTaPlaybook(profileId, {
    learned: clampLearnedWeights(learned),
  });
}

export function resetProfileTaPlaybook(profileId: string): ProfileTaPlaybook {
  const file = loadFile();
  delete file.playbooks[profileId];
  persist(file);
  return getProfileTaPlaybook(profileId);
}

export function resetAllProfileTaPlaybooks(): void {
  persist(emptyFile());
}

/**
 * Small reversible learned nudges from recent episodes.
 * Never touches TP/SL — only playbook weights / minConf / HA consecutive / whale.
 */
export function maybeNudgeProfileTaFromEpisodes(profileId: string): {
  applied: boolean;
  summary: string | null;
} {
  try {
    const pb = getProfileTaPlaybook(profileId);
    if (!pb.learningEnabled || pb.taMode === 'off') {
      return { applied: false, summary: null };
    }
    const { getProfileLearningEpisodes } =
      require('./profileLearningEpisodes') as typeof import('./profileLearningEpisodes');
    const episodes = getProfileLearningEpisodes(profileId, 40).filter(
      (e) => e.taModeAtOpen && e.taModeAtOpen !== 'off'
    );
    if (episodes.length < 8) return { applied: false, summary: null };

    const withConf = episodes.filter(
      (e) => e.taConfluenceAtEntry != null && Number.isFinite(e.taConfluenceAtEntry)
    );
    if (withConf.length < 6) return { applied: false, summary: null };

    const avgPnl =
      withConf.reduce((s, e) => s + (e.pnlPct || 0), 0) / withConf.length;
    const highConf = withConf.filter((e) => (e.taConfluenceAtEntry || 0) >= 55);
    const lowConf = withConf.filter((e) => (e.taConfluenceAtEntry || 0) < 40);
    const highAvg =
      highConf.length >= 3
        ? highConf.reduce((s, e) => s + (e.pnlPct || 0), 0) / highConf.length
        : null;
    const lowAvg =
      lowConf.length >= 3
        ? lowConf.reduce((s, e) => s + (e.pnlPct || 0), 0) / lowConf.length
        : null;

    const learned = {
      ...(pb.learned || {}),
      toolWeights: { ...(pb.learned?.toolWeights || {}) },
    };
    let summary: string | null = null;

    if (highAvg != null && lowAvg != null && highAvg > lowAvg + 2) {
      learned.minConfDelta = Math.min(
        15,
        (learned.minConfDelta || 0) + 2
      );
      summary = `Raise TA minConf delta → ${learned.minConfDelta} (high-conf beats low)`;
    } else if (highAvg != null && lowAvg != null && lowAvg > highAvg + 3) {
      learned.minConfDelta = Math.max(
        -15,
        (learned.minConfDelta || 0) - 2
      );
      summary = `Lower TA minConf delta → ${learned.minConfDelta} (low-conf not worse)`;
    }

    const haEps = withConf.filter((e) => (e.haConsecutiveAtEntry || 0) > 0);
    if (haEps.length >= 6 && avgPnl < 0) {
      learned.haConsecutiveDelta = Math.min(
        2,
        (learned.haConsecutiveDelta || 0) + 1
      );
      summary =
        (summary ? summary + ' · ' : '') +
        `Stricter HA consecutive Δ${learned.haConsecutiveDelta}`;
    }

    const whaleWins = withConf.filter(
      (e) => e.whaleStateAtEntry === 'bullish' && (e.pnlPct || 0) > 0
    ).length;
    const whaleLoss = withConf.filter(
      (e) => e.whaleStateAtEntry === 'bullish' && (e.pnlPct || 0) <= 0
    ).length;
    if (whaleWins + whaleLoss >= 6) {
      const wr = whaleWins / (whaleWins + whaleLoss);
      if (wr >= 0.55) {
        learned.whaleWeight = Math.min(1.5, (learned.whaleWeight || 1) + 0.1);
        summary =
          (summary ? summary + ' · ' : '') +
          `Whale weight → ${learned.whaleWeight.toFixed(2)}`;
      } else if (wr <= 0.35) {
        learned.whaleWeight = Math.max(0.5, (learned.whaleWeight || 1) - 0.1);
        summary =
          (summary ? summary + ' · ' : '') +
          `Whale weight → ${learned.whaleWeight.toFixed(2)}`;
      }
    }

    const resistExits = withConf.filter((e) =>
      /resistance|profile.?ta/i.test(String(e.exitReason || ''))
    );
    if (resistExits.length >= 4) {
      const avg =
        resistExits.reduce((s, e) => s + (e.pnlPct || 0), 0) /
        resistExits.length;
      if (avg > 2) {
        learned.resistanceExitSensitivity = Math.min(
          1.5,
          (learned.resistanceExitSensitivity || 1) + 0.1
        );
        summary =
          (summary ? summary + ' · ' : '') +
          `Resistance exit sens → ${learned.resistanceExitSensitivity.toFixed(2)}`;
      } else if (avg < -2) {
        learned.resistanceExitSensitivity = Math.max(
          0.5,
          (learned.resistanceExitSensitivity || 1) - 0.1
        );
        summary =
          (summary ? summary + ' · ' : '') +
          `Resistance exit sens → ${learned.resistanceExitSensitivity.toFixed(2)}`;
      }
    }

    if (!summary) return { applied: false, summary: null };

    applyProfileTaLearnedWeights(profileId, learned);
    logger.info('ProfileTaPlaybooks', `${profileId}: ${summary}`);
    return { applied: true, summary };
  } catch (err) {
    logger.warn('ProfileTaPlaybooks', 'nudge failed', errorToMeta(err));
    return { applied: false, summary: null };
  }
}
