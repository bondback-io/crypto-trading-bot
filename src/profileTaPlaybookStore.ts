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
  PROFILE_TA_TOOL_IDS,
  type ProfileTaLearnedWeights,
  type ProfileTaPlaybook,
  type ProfileTaMode,
  type ProfileTaToolId,
  type ProfileTaWhaleMode,
} from './profileTaPlaybook';

export const PROFILE_TA_PLAYBOOKS_VERSION = 1 as const;
const MAX_LEARNED_HISTORY = 20;

export interface ProfileTaLearnedHistoryEntry {
  at: number;
  kind: 'nudge' | 'rollback' | 'manual';
  summary: string;
  previousLearned: ProfileTaLearnedWeights;
  learned: ProfileTaLearnedWeights;
  source?: 'auto' | 'manual';
}

export interface ProfileTaPlaybooksFile {
  version: typeof PROFILE_TA_PLAYBOOKS_VERSION;
  updatedAt: number;
  /** Partial overrides keyed by profileId */
  playbooks: Record<string, Partial<ProfileTaPlaybook>>;
  /** Reversible learned-weight ring per profile */
  learnedHistory?: Record<string, ProfileTaLearnedHistoryEntry[]>;
}

const FILE = () => dataFile(PERSIST_FILES.profileTaPlaybooks);

let cache: ProfileTaPlaybooksFile | null = null;
let loaded = false;

function emptyFile(): ProfileTaPlaybooksFile {
  return {
    version: PROFILE_TA_PLAYBOOKS_VERSION,
    updatedAt: 0,
    playbooks: {},
    learnedHistory: {},
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
      learnedHistory: isPlainObject(raw.learnedHistory)
        ? (raw.learnedHistory as ProfileTaPlaybooksFile['learnedHistory'])
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
  learnedHistory: Record<string, ProfileTaLearnedHistoryEntry[]>;
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
    learnedHistory: { ...(file.learnedHistory || {}) },
  };
}

export function getProfileTaLearnedHistory(
  profileId: string,
  limit = 10
): ProfileTaLearnedHistoryEntry[] {
  const file = loadFile();
  const ring = file.learnedHistory?.[profileId] || [];
  return ring.slice(-Math.max(1, limit));
}

function snapshotLearned(
  pb: ProfileTaPlaybook
): ProfileTaLearnedWeights {
  return clampLearnedWeights(pb.learned || {});
}

function pushLearnedHistory(
  profileId: string,
  entry: ProfileTaLearnedHistoryEntry
): void {
  const file = loadFile();
  if (!file.learnedHistory) file.learnedHistory = {};
  const ring = file.learnedHistory[profileId] || [];
  ring.push(entry);
  file.learnedHistory[profileId] = ring.slice(-MAX_LEARNED_HISTORY);
  persist(file);
}

/** Plain-language summary of TA playbook learned weights for diagnostics / Zion. */
export function formatProfileTaLearnedPlainLanguage(
  profileId: string
): string | null {
  const pb = getProfileTaPlaybook(profileId);
  if (!pb.learningEnabled || pb.taMode === 'off') return null;
  const L = clampLearnedWeights(pb.learned || {});
  const bits: string[] = [];
  if (L.minConfDelta) bits.push(`min-conf ${L.minConfDelta > 0 ? '+' : ''}${L.minConfDelta}`);
  if (L.haConsecutiveDelta) bits.push(`HA consec ${L.haConsecutiveDelta > 0 ? '+' : ''}${L.haConsecutiveDelta}`);
  const tw = L.toolWeights || {};
  const twKeys = Object.keys(tw).filter((k) => tw[k as ProfileTaToolId] !== 1);
  if (twKeys.length) {
    bits.push(
      twKeys
        .slice(0, 3)
        .map((k) => `${k}×${Number(tw[k as ProfileTaToolId]).toFixed(2)}`)
        .join(', ')
    );
  }
  if (L.divergenceSensitivity != null && L.divergenceSensitivity !== 1) {
    bits.push(`div×${L.divergenceSensitivity.toFixed(2)}`);
  }
  if (L.histSlopeSensitivity != null && L.histSlopeSensitivity !== 1) {
    bits.push(`hist×${L.histSlopeSensitivity.toFixed(2)}`);
  }
  const hist = getProfileTaLearnedHistory(profileId, 1)[0];
  if (hist?.summary) bits.push(hist.summary.slice(0, 80));
  return bits.length ? bits.join(' · ') : null;
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
  learned: Partial<ProfileTaLearnedWeights>,
  opts?: {
    historySummary?: string;
    historyKind?: ProfileTaLearnedHistoryEntry['kind'];
    historySource?: ProfileTaLearnedHistoryEntry['source'];
    skipHistory?: boolean;
  }
): ProfileTaPlaybook {
  const before = getProfileTaPlaybook(profileId);
  const previousLearned = snapshotLearned(before);
  const playbook = updateProfileTaPlaybook(profileId, {
    learned: clampLearnedWeights(learned),
  });
  if (!opts?.skipHistory && opts?.historySummary) {
    pushLearnedHistory(profileId, {
      at: Date.now(),
      kind: opts.historyKind || 'nudge',
      summary: opts.historySummary,
      previousLearned,
      learned: snapshotLearned(playbook),
      source: opts.historySource || 'auto',
    });
  }
  return playbook;
}

/** Roll back the last TA learned nudge for one profile. */
export function rollbackProfileTaLearned(
  profileId: string
): { ok: boolean; summary: string | null; playbook: ProfileTaPlaybook } {
  const file = loadFile();
  const ring = file.learnedHistory?.[profileId] || [];
  let idx = ring.length - 1;
  while (idx >= 0 && ring[idx]!.kind === 'rollback') idx--;
  const last = idx >= 0 ? ring[idx]! : null;
  if (!last || last.kind !== 'nudge') {
    return {
      ok: false,
      summary: null,
      playbook: getProfileTaPlaybook(profileId),
    };
  }
  const playbook = updateProfileTaPlaybook(profileId, {
    learned: clampLearnedWeights(last.previousLearned),
  });
  if (file.learnedHistory) {
    file.learnedHistory[profileId] = ring.filter((_, i) => i !== idx);
    persist(file);
  }
  pushLearnedHistory(profileId, {
    at: Date.now(),
    kind: 'rollback',
    summary: `Rolled back: ${last.summary}`,
    previousLearned: last.learned,
    learned: snapshotLearned(playbook),
    source: 'manual',
  });
  return {
    ok: true,
    summary: last.summary,
    playbook,
  };
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
 * Never touches TP/SL — only playbook weights / minConf / HA consecutive / whale / per-tool weights.
 */
export function maybeNudgeProfileTaFromEpisodes(profileId: string): {
  applied: boolean;
  summary: string | null;
  rolledBack?: boolean;
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

    // Auto-rollback if last nudge underperformed
    const hist = getProfileTaLearnedHistory(profileId, 3);
    const lastNudge = [...hist].reverse().find((h) => h.kind === 'nudge');
    if (lastNudge && lastNudge.at > 0) {
      const after = withConf.filter((e) => e.closedAt >= lastNudge.at);
      const before = withConf.filter((e) => e.closedAt < lastNudge.at);
      if (after.length >= 4 && before.length >= 4) {
        const afterAvg =
          after.reduce((s, e) => s + (e.pnlPct || 0), 0) / after.length;
        const beforeAvg =
          before.reduce((s, e) => s + (e.pnlPct || 0), 0) / before.length;
        if (afterAvg < beforeAvg - 3) {
          const rb = rollbackProfileTaLearned(profileId);
          if (rb.ok) {
            logger.info(
              'ProfileTaPlaybooks',
              `${profileId}: auto-rollback TA weights (${afterAvg.toFixed(1)}% vs ${beforeAvg.toFixed(1)}%)`
            );
            const summary = `Auto-rollback TA weights (${afterAvg.toFixed(1)}% vs ${beforeAvg.toFixed(1)}%)`;
            try {
              const { recordTaDecision } =
                require('./agentDecisionLog') as typeof import('./agentDecisionLog');
              recordTaDecision({
                profileId,
                summary,
                decisionType: 'warning',
                applied: 'applied',
                detail: 'auto-rollback',
                dedupeKey: `ta-rb:${profileId}`,
              });
            } catch {
              /* optional */
            }
            return {
              applied: true,
              summary,
              rolledBack: true,
            };
          }
        }
      }
    }

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

    const learned: ProfileTaLearnedWeights = {
      ...(pb.learned || {}),
      toolWeights: { ...(pb.learned?.toolWeights || {}) },
      minConfDelta: pb.learned?.minConfDelta ?? 0,
      haConsecutiveDelta: pb.learned?.haConsecutiveDelta ?? 0,
      resistanceExitSensitivity: pb.learned?.resistanceExitSensitivity ?? 1,
      whaleWeight: pb.learned?.whaleWeight ?? 1,
      divergenceSensitivity: pb.learned?.divergenceSensitivity ?? 1,
      histSlopeSensitivity: pb.learned?.histSlopeSensitivity ?? 1,
    };
    const summaryParts: string[] = [];

    if (highAvg != null && lowAvg != null && highAvg > lowAvg + 2) {
      learned.minConfDelta = Math.min(15, (learned.minConfDelta || 0) + 2);
      summaryParts.push(`Raise TA minConf delta → ${learned.minConfDelta}`);
    } else if (highAvg != null && lowAvg != null && lowAvg > highAvg + 3) {
      learned.minConfDelta = Math.max(-15, (learned.minConfDelta || 0) - 2);
      summaryParts.push(`Lower TA minConf delta → ${learned.minConfDelta}`);
    }

    const haEps = withConf.filter((e) => (e.haConsecutiveAtEntry || 0) > 0);
    if (haEps.length >= 6 && avgPnl < 0) {
      learned.haConsecutiveDelta = Math.min(
        2,
        (learned.haConsecutiveDelta || 0) + 1
      );
      summaryParts.push(`Stricter HA consecutive Δ${learned.haConsecutiveDelta}`);
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
        summaryParts.push(`Whale weight → ${learned.whaleWeight.toFixed(2)}`);
      } else if (wr <= 0.35) {
        learned.whaleWeight = Math.max(0.5, (learned.whaleWeight || 1) - 0.1);
        summaryParts.push(`Whale weight → ${learned.whaleWeight.toFixed(2)}`);
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
        summaryParts.push(
          `Resistance exit sens → ${learned.resistanceExitSensitivity.toFixed(2)}`
        );
      } else if (avg < -2) {
        learned.resistanceExitSensitivity = Math.max(
          0.5,
          (learned.resistanceExitSensitivity || 1) - 0.1
        );
        summaryParts.push(
          `Resistance exit sens → ${learned.resistanceExitSensitivity.toFixed(2)}`
        );
      }
    }

    // Divergence sensitivity from bullish div stamps
    const divBull = withConf.filter(
      (e) =>
        e.rsiDivergenceAtEntry === 'bullish' ||
        e.volumeDivergenceAtEntry === 'bullish'
    );
    const divOther = withConf.filter(
      (e) =>
        e.rsiDivergenceAtEntry !== 'bullish' &&
        e.volumeDivergenceAtEntry !== 'bullish'
    );
    if (divBull.length >= 4 && divOther.length >= 4) {
      const bullAvg =
        divBull.reduce((s, e) => s + (e.pnlPct || 0), 0) / divBull.length;
      const otherAvg =
        divOther.reduce((s, e) => s + (e.pnlPct || 0), 0) / divOther.length;
      if (bullAvg > otherAvg + 2) {
        learned.divergenceSensitivity = Math.min(
          1.5,
          (learned.divergenceSensitivity || 1) + 0.1
        );
        summaryParts.push(
          `Div sens → ${learned.divergenceSensitivity.toFixed(2)}`
        );
      } else if (otherAvg > bullAvg + 3) {
        learned.divergenceSensitivity = Math.max(
          0.5,
          (learned.divergenceSensitivity || 1) - 0.1
        );
        summaryParts.push(
          `Div sens → ${learned.divergenceSensitivity.toFixed(2)}`
        );
      }
    }

    // MACD hist slope sensitivity
    const histRising = withConf.filter((e) => e.macdHistSlopeAtEntry === 'rising');
    const histOther = withConf.filter((e) => e.macdHistSlopeAtEntry !== 'rising');
    if (histRising.length >= 4 && histOther.length >= 4) {
      const riseAvg =
        histRising.reduce((s, e) => s + (e.pnlPct || 0), 0) / histRising.length;
      const otherAvg =
        histOther.reduce((s, e) => s + (e.pnlPct || 0), 0) / histOther.length;
      if (riseAvg > otherAvg + 2) {
        learned.histSlopeSensitivity = Math.min(
          1.5,
          (learned.histSlopeSensitivity || 1) + 0.1
        );
        summaryParts.push(
          `Hist slope sens → ${learned.histSlopeSensitivity.toFixed(2)}`
        );
      } else if (otherAvg > riseAvg + 3) {
        learned.histSlopeSensitivity = Math.max(
          0.5,
          (learned.histSlopeSensitivity || 1) - 0.1
        );
        summaryParts.push(
          `Hist slope sens → ${learned.histSlopeSensitivity.toFixed(2)}`
        );
      }
    }

    // Per-tool weight correlation nudge (max 3 tools per cycle)
    const enabledTools = (PROFILE_TA_TOOL_IDS as readonly ProfileTaToolId[]).filter(
      (tool) => pb.entryTools[tool] === true
    );
    const toolNudges: Array<{ tool: ProfileTaToolId; delta: number; detail: string }> =
      [];
    for (const tool of enabledTools) {
      const passed = withConf.filter((e) =>
        (e.taToolsPassedAtEntry || []).includes(tool)
      );
      const failed = withConf.filter(
        (e) =>
          Array.isArray(e.taToolsAtOpen) &&
          e.taToolsAtOpen.includes(tool) &&
          !(e.taToolsPassedAtEntry || []).includes(tool)
      );
      if (passed.length < 3 || failed.length < 3) continue;
      const passAvg =
        passed.reduce((s, e) => s + (e.pnlPct || 0), 0) / passed.length;
      const failAvg =
        failed.reduce((s, e) => s + (e.pnlPct || 0), 0) / failed.length;
      if (passAvg > failAvg + 2) {
        toolNudges.push({
          tool,
          delta: 0.05,
          detail: `${tool}×+ (${passAvg.toFixed(1)} vs ${failAvg.toFixed(1)})`,
        });
      } else if (failAvg > passAvg + 3) {
        toolNudges.push({
          tool,
          delta: -0.05,
          detail: `${tool}×− (${passAvg.toFixed(1)} vs ${failAvg.toFixed(1)})`,
        });
      }
    }
    toolNudges.sort(
      (a, b) => Math.abs(b.delta) - Math.abs(a.delta)
    );
    for (const n of toolNudges.slice(0, 3)) {
      const cur = learned.toolWeights[n.tool] ?? 1;
      learned.toolWeights[n.tool] = Math.min(
        1.5,
        Math.max(0.5, cur + n.delta)
      );
      summaryParts.push(`${n.detail} → ${learned.toolWeights[n.tool]!.toFixed(2)}`);
    }

    if (summaryParts.length === 0) return { applied: false, summary: null };

    const summary = summaryParts.join(' · ');
    applyProfileTaLearnedWeights(profileId, learned, {
      historySummary: summary,
      historyKind: 'nudge',
      historySource: 'auto',
    });
    logger.info('ProfileTaPlaybooks', `${profileId}: ${summary}`);
    try {
      const { recordTaDecision } =
        require('./agentDecisionLog') as typeof import('./agentDecisionLog');
      recordTaDecision({
        profileId,
        summary,
        decisionType: 'soft_push',
        applied: 'applied',
        detail: 'ta weight nudge',
        dedupeKey: `ta-nudge:${profileId}:${summary.slice(0, 40)}`,
      });
    } catch {
      /* optional */
    }
    return { applied: true, summary };
  } catch (err) {
    logger.warn('ProfileTaPlaybooks', 'nudge failed', errorToMeta(err));
    return { applied: false, summary: null };
  }
}
