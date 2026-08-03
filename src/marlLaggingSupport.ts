/**
 * MARL lagging-profile support — soft priority help for quiet/under-utilised lanes.
 * Never bypasses profile filters, TP/SL, or self-learning. Additive score only.
 */

import {
  getOrCreateAgent,
  loadMarlState,
  saveMarlState,
  pushMarlDecision,
  type MarlAgentState,
  type MarlLaggingPersisted,
} from './marlStore';

export type { MarlLaggingPersisted };

export type LaggingStatus = 'normal' | 'lagging' | 'supported' | 'cooling';

export interface LaggingProfileRuntime {
  profileId: string;
  status: LaggingStatus;
  reason: string;
  /** 0–1 soft intensity used for score boost */
  boost: number;
  supportsGiven: number;
  poorAfterSupport: number;
  lastSupportAt: number;
  lastEvalAt: number;
  lastTradeAt: number | null;
  recentTrades7d: number;
}

export type LaggingProfilePersisted = MarlLaggingPersisted;

const SEVEN_D = 7 * 24 * 60 * 60 * 1000;
const QUIET_MS = 18 * 60 * 60 * 1000;
const COOLING_MS = 6 * 60 * 60 * 1000;
const EVAL_CACHE_MS = 45_000;

let evalCache: { at: number; map: Map<string, LaggingProfileRuntime> } | null =
  null;

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function readPersisted(profileId: string): LaggingProfilePersisted {
  const st = loadMarlState();
  const raw = st.lagging?.[profileId];
  if (!raw || typeof raw !== 'object') {
    return {
      boost: 0,
      supportsGiven: 0,
      poorAfterSupport: 0,
      lastSupportAt: 0,
      coolingUntil: 0,
      status: 'normal',
    };
  }
  return {
    boost: clamp01(Number(raw.boost) || 0),
    supportsGiven: Math.max(0, Math.round(Number(raw.supportsGiven) || 0)),
    poorAfterSupport: Math.max(
      0,
      Math.round(Number(raw.poorAfterSupport) || 0)
    ),
    lastSupportAt: Number(raw.lastSupportAt) || 0,
    coolingUntil: Number(raw.coolingUntil) || 0,
    status:
      raw.status === 'lagging' ||
      raw.status === 'supported' ||
      raw.status === 'cooling'
        ? raw.status
        : 'normal',
  };
}

function writePersisted(
  profileId: string,
  patch: Partial<LaggingProfilePersisted>
): void {
  const st = loadMarlState();
  if (!st.lagging) st.lagging = {};
  const cur = readPersisted(profileId);
  st.lagging[profileId] = { ...cur, ...patch };
  // Mutate in place so agents / decisions / recentLowMcOpens are preserved.
  saveMarlState(st);
}

function enabledCatalogIds(): string[] {
  try {
    const { getTradeProfilesStatus } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    const tp = getTradeProfilesStatus();
    return (tp.profiles || [])
      .filter(
        (p: { id: string; enabled?: boolean }) =>
          p.enabled !== false &&
          p.id !== 'default' &&
          p.id !== 'zion'
      )
      .map((p: { id: string }) => p.id);
  } catch {
    return [];
  }
}

function episodeStats(profileId: string): {
  recent7d: number;
  lastAt: number | null;
  recentAvg: number;
  olderAvg: number;
} {
  try {
    const { getProfileLearningEpisodes } =
      require('./profileLearningEpisodes') as typeof import('./profileLearningEpisodes');
    const eps = getProfileLearningEpisodes(profileId, 120);
    const now = Date.now();
    const recent = eps.filter((e) => (e.at || 0) >= now - SEVEN_D);
    const lastAt = eps.length
      ? Math.max(...eps.map((e) => Number(e.at) || 0))
      : null;
    const score = (e: {
      timingReward?: number;
      pnlPct?: number;
    }): number =>
      e.timingReward != null && Number.isFinite(e.timingReward)
        ? Number(e.timingReward)
        : Number(e.pnlPct) || 0;
    const half = Math.floor(eps.length / 2);
    const older = half > 0 ? eps.slice(0, half) : [];
    const newer = half > 0 ? eps.slice(half) : eps;
    const avg = (xs: typeof eps) =>
      xs.length
        ? xs.reduce((s, e) => s + score(e), 0) / xs.length
        : 0;
    return {
      recent7d: recent.length,
      lastAt: lastAt && lastAt > 0 ? lastAt : null,
      recentAvg: avg(newer),
      olderAvg: avg(older),
    };
  } catch {
    return { recent7d: 0, lastAt: null, recentAvg: 0, olderAvg: 0 };
  }
}

/**
 * Refresh lagging classifications for enabled profiles (cached ~45s).
 */
export function evaluateLaggingProfiles(opts?: {
  force?: boolean;
}): Map<string, LaggingProfileRuntime> {
  const now = Date.now();
  if (
    !opts?.force &&
    evalCache &&
    now - evalCache.at < EVAL_CACHE_MS
  ) {
    return evalCache.map;
  }

  const map = new Map<string, LaggingProfileRuntime>();
  const ids = enabledCatalogIds();
  // Peer activity for "under-utilised vs book"
  const peerTrades: number[] = [];
  for (const id of ids) {
    peerTrades.push(episodeStats(id).recent7d);
  }
  const peerMedian =
    peerTrades.length > 0
      ? [...peerTrades].sort((a, b) => a - b)[
          Math.floor(peerTrades.length / 2)
        ]
      : 0;

  for (const id of ids) {
    const stats = episodeStats(id);
    const persisted = readPersisted(id);
    const agent: MarlAgentState = getOrCreateAgent(id);
    const quietMs = stats.lastAt != null ? now - stats.lastAt : Infinity;
    const declining =
      stats.olderAvg !== 0 &&
      stats.recentAvg < stats.olderAvg - 2 &&
      stats.recent7d >= 2;

    let status: LaggingStatus = 'normal';
    let reason = '';
    let boost = persisted.boost;

    if (persisted.coolingUntil > now) {
      status = 'cooling';
      reason = 'Cooling after poor supported results';
      boost = 0;
    } else if (
      stats.recent7d <= 1 &&
      (quietMs >= QUIET_MS || stats.lastAt == null)
    ) {
      status = 'lagging';
      reason =
        stats.lastAt == null
          ? 'Enabled but almost no closed trades yet'
          : `Very quiet · ${stats.recent7d} close(s) in 7d · idle ${Math.round(quietMs / 3600000)}h`;
      boost = Math.max(boost, 0.55);
    } else if (
      stats.recent7d <= 2 &&
      peerMedian >= 5 &&
      stats.recent7d <= peerMedian * 0.35
    ) {
      status = 'lagging';
      reason = `Under-utilised vs peers (${stats.recent7d} vs median ${peerMedian} in 7d)`;
      boost = Math.max(boost, 0.45);
    } else if (declining && stats.recent7d <= 4) {
      status = 'lagging';
      reason = 'Declining recent episode scores with thin sample';
      boost = Math.max(boost, 0.35);
    } else if (persisted.supportsGiven > 0 && boost > 0.15) {
      status = 'supported';
      reason = 'Receiving soft MARL support';
    } else {
      status = 'normal';
      reason = '';
      boost = Math.max(0, boost * 0.85);
    }

    // Agent with very few MARL-tracked trades while peers active
    if (
      status === 'normal' &&
      agent.trades < 2 &&
      peerMedian >= 4 &&
      quietMs >= QUIET_MS
    ) {
      status = 'lagging';
      reason = 'Few MARL-tracked trades while book is active';
      boost = Math.max(boost, 0.4);
    }

    if (status === 'lagging' || status === 'supported') {
      writePersisted(id, {
        status,
        boost: clamp01(boost),
        supportsGiven: persisted.supportsGiven,
        poorAfterSupport: persisted.poorAfterSupport,
        lastSupportAt: persisted.lastSupportAt,
        coolingUntil: persisted.coolingUntil,
      });
    } else if (status === 'cooling') {
      writePersisted(id, {
        status: 'cooling',
        boost: 0,
        coolingUntil: persisted.coolingUntil,
      });
    } else if (persisted.status !== 'normal' || persisted.boost > 0.05) {
      writePersisted(id, {
        status: 'normal',
        boost: clamp01(boost),
      });
    }

    map.set(id, {
      profileId: id,
      status,
      reason,
      boost: clamp01(boost),
      supportsGiven: persisted.supportsGiven,
      poorAfterSupport: persisted.poorAfterSupport,
      lastSupportAt: persisted.lastSupportAt,
      lastEvalAt: now,
      lastTradeAt: stats.lastAt,
      recentTrades7d: stats.recent7d,
    });
  }

  evalCache = { at: now, map };
  return map;
}

export function getLaggingProfile(
  profileId: string
): LaggingProfileRuntime | null {
  return evaluateLaggingProfiles().get(profileId) || null;
}

export function listLaggingProfiles(): LaggingProfileRuntime[] {
  return [...evaluateLaggingProfiles().values()].filter(
    (p) => p.status === 'lagging' || p.status === 'supported' || p.status === 'cooling'
  );
}

/**
 * Soft additive score boost for a lagging profile (0 when not eligible).
 * Caller must only apply on already-passed lanes.
 */
export function laggingScoreBoost(
  profileId: string,
  strengthScale: number
): { delta: number; note: string; runtime: LaggingProfileRuntime | null } {
  const rt = getLaggingProfile(profileId);
  if (!rt || (rt.status !== 'lagging' && rt.status !== 'supported')) {
    return { delta: 0, note: '', runtime: rt };
  }
  if (rt.boost < 0.12) return { delta: 0, note: '', runtime: rt };
  const raw = rt.boost * 2.4 * Math.max(0.25, strengthScale);
  const delta = Math.round(Math.min(3.5, raw) * 10) / 10;
  if (delta < 0.15) return { delta: 0, note: '', runtime: rt };
  return {
    delta,
    note: `MARL lag+${delta.toFixed(1)}`,
    runtime: rt,
  };
}

/** Mark that support was applied on a fight (logging + counters). */
export function noteLaggingSupportApplied(
  profileId: string,
  detail: string,
  opts?: { log?: boolean }
): void {
  const cur = readPersisted(profileId);
  writePersisted(profileId, {
    status: cur.status === 'cooling' ? 'cooling' : 'supported',
    supportsGiven: cur.supportsGiven + 1,
    lastSupportAt: Date.now(),
    boost: Math.max(cur.boost, 0.4),
  });
  evalCache = null;
  if (opts?.log === false) return;
  pushMarlDecision({
    kind: 'lagging_support',
    profileId,
    detail: detail.slice(0, 280),
  });
  console.log(`[marl] lagging-support ${profileId}: ${detail}`);
}

/**
 * Performance gate after a close that may have been supported.
 */
export function updateLaggingAfterTrade(
  profileId: string,
  reward: number
): void {
  const cur = readPersisted(profileId);
  if (
    cur.status !== 'supported' &&
    cur.status !== 'lagging' &&
    cur.supportsGiven < 1
  ) {
    return;
  }
  if (reward < -0.15) {
    const poor = cur.poorAfterSupport + 1;
    if (poor >= 2) {
      writePersisted(profileId, {
        status: 'cooling',
        boost: 0,
        poorAfterSupport: poor,
        coolingUntil: Date.now() + COOLING_MS,
      });
      pushMarlDecision({
        kind: 'lagging_support',
        profileId,
        detail: `Cooling ${profileId} — poor results after support (reward ${reward.toFixed(2)})`,
      });
    } else {
      writePersisted(profileId, {
        boost: clamp01(cur.boost * 0.55),
        poorAfterSupport: poor,
        status: 'lagging',
      });
      pushMarlDecision({
        kind: 'lagging_support',
        profileId,
        detail: `Reduced lag boost for ${profileId} after weak close`,
      });
    }
  } else if (reward > 0.1) {
    writePersisted(profileId, {
      poorAfterSupport: 0,
      boost: clamp01(cur.boost * 0.75),
      status: cur.boost * 0.75 < 0.2 ? 'normal' : 'supported',
      coolingUntil: 0,
    });
  }
  evalCache = null;
}
