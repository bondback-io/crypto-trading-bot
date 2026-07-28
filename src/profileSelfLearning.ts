/**
 * Micro-bot self-learning — per-profile toggle, shadow proposals, auto-apply,
 * exit/entry tuners, profit-lock learning, and progress vs baseline.
 */

import { persistUserSettings } from './config';
import {
  getProfileEpisodeExpectancy,
  getProfileLearningEpisodes,
  type ProfileLearningEpisode,
} from './profileLearningEpisodes';
import type {
  TradeProfileExitRules,
  TradeProfileId,
  TradeProfileMatchRules,
  TradeProfileParamOverride,
} from './tradeProfiles';

export type SelfLearnMode = 'shadow' | 'auto';

export interface LearningProposalPatch {
  exitRules?: Partial<TradeProfileExitRules>;
  match?: Partial<TradeProfileMatchRules>;
}

export interface LearningProposal {
  at: number;
  summary: string;
  patch: LearningProposalPatch;
  scoreBefore: number;
  scoreAfter: number;
  kind: 'exit' | 'entry' | 'mixed';
}

export interface SelfLearnHistoryEntry {
  version: number;
  at: number;
  summary: string;
  patch: LearningProposalPatch;
  scoreBefore: number;
  scoreAfter: number;
  rolledBack?: boolean;
}

export interface ProfileSelfLearningState {
  enabled: boolean;
  mode: SelfLearnMode;
  minTrades: number;
  upgradeCooldownTrades: number;
  lastUpgradedAt: number | null;
  version: number;
  tradesSinceUpgrade: number;
  baselineExpectancyPct: number | null;
  currentExpectancyPct: number;
  improvementPct: number;
  pendingProposal: LearningProposal | null;
  history: SelfLearnHistoryEntry[];
  /** Snapshot of overrides before last upgrade (for rollback) */
  previousOverrideSnapshot?: TradeProfileParamOverride | null;
}

export const DEFAULT_SELF_LEARNING: ProfileSelfLearningState = {
  enabled: true,
  mode: 'shadow',
  minTrades: 8,
  upgradeCooldownTrades: 6,
  lastUpgradedAt: null,
  version: 0,
  tradesSinceUpgrade: 0,
  baselineExpectancyPct: null,
  currentExpectancyPct: 0,
  improvementPct: 0,
  pendingProposal: null,
  history: [],
  previousOverrideSnapshot: null,
};

const SWING_PROFILES = new Set([
  'trend_rider',
  'steady_compounder',
  'dip_buyer',
  'high_win_rate',
]);

const SCALP_PROFILES = new Set([
  'scalper',
  'momentum_burst',
  'reversal_scalper',
  'migration_sniper',
]);

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Adaptive confidence from how many closed episodes have fed the bot.
 * Smaller samples → smaller nudges + harder score bar; 12+ → full strength.
 */
export function learningSampleConfidence(episodeCount: number): {
  n: number;
  allowExit: boolean;
  allowEntry: boolean;
  scoreMargin: number;
  nudgeScale: number;
} {
  const n = Math.max(0, Math.round(Number(episodeCount) || 0));
  if (n < 6) {
    return {
      n,
      allowExit: false,
      allowEntry: false,
      scoreMargin: 99,
      nudgeScale: 0,
    };
  }
  if (n < 8) {
    return {
      n,
      allowExit: true,
      allowEntry: false,
      scoreMargin: 1.5,
      nudgeScale: 0.5,
    };
  }
  if (n < 12) {
    return {
      n,
      allowExit: true,
      allowEntry: true,
      scoreMargin: 1.0,
      nudgeScale: 0.75,
    };
  }
  return {
    n,
    allowExit: true,
    allowEntry: true,
    scoreMargin: 0.8,
    nudgeScale: 1,
  };
}

/** Scale numeric deltas in a learning patch toward milder changes. */
export function scaleLearningPatch(
  patch: LearningProposalPatch,
  scale: number
): LearningProposalPatch {
  const s = clamp(scale, 0, 1);
  if (s >= 0.999) return patch;
  if (s <= 0) return {};

  const scaleNum = (v: unknown, toward = 0): number | undefined => {
    if (v == null || !Number.isFinite(Number(v))) return undefined;
    const n = Number(v);
    return toward + (n - toward) * s;
  };

  const exitRules: Partial<TradeProfileExitRules> = {};
  if (patch.exitRules) {
    for (const [k, v] of Object.entries(patch.exitRules)) {
      if (k === 'exitPolicy' && v && typeof v === 'object') {
        const ep: Record<string, number> = {};
        for (const [pk, pv] of Object.entries(
          v as Record<string, unknown>
        )) {
          if (typeof pv === 'boolean') {
            if (s >= 0.75) (ep as Record<string, unknown>)[pk] = pv;
            continue;
          }
          const scaled = scaleNum(pv);
          if (scaled != null) ep[pk] = Math.round(scaled * 10) / 10;
        }
        if (Object.keys(ep).length) {
          exitRules.exitPolicy = ep as TradeProfileExitRules['exitPolicy'];
        }
      } else if (typeof v === 'number') {
        const scaled = scaleNum(v, k === 'sizeMultiplier' ? 1 : 0);
        if (scaled != null) {
          (exitRules as Record<string, number>)[k] =
            Math.round(scaled * 100) / 100;
        }
      } else if (typeof v === 'boolean' && s >= 0.75) {
        (exitRules as Record<string, boolean>)[k] = v;
      }
    }
  }

  const match: Partial<TradeProfileMatchRules> = {};
  if (patch.match) {
    for (const [k, v] of Object.entries(patch.match)) {
      if (typeof v === 'number') {
        const scaled = scaleNum(v);
        if (scaled != null) {
          (match as Record<string, number>)[k] = Math.round(scaled);
        }
      } else if (typeof v === 'boolean' && s >= 0.75) {
        (match as Record<string, boolean>)[k] = v;
      }
    }
  }

  return {
    exitRules: Object.keys(exitRules).length ? exitRules : undefined,
    match: Object.keys(match).length ? match : undefined,
  };
}

export function normalizeSelfLearning(
  raw?: Partial<ProfileSelfLearningState> | null
): ProfileSelfLearningState {
  const d = DEFAULT_SELF_LEARNING;
  if (!raw || typeof raw !== 'object') return { ...d, history: [] };
  const hasEnabled = Object.prototype.hasOwnProperty.call(raw, 'enabled');
  return {
    // Default ON when unset; only explicit false turns it off
    enabled: hasEnabled ? raw.enabled === true : d.enabled,
    mode: raw.mode === 'auto' ? 'auto' : 'shadow',
    minTrades: clamp(Number(raw.minTrades) || d.minTrades, 6, 40),
    upgradeCooldownTrades: clamp(
      Number(raw.upgradeCooldownTrades) || d.upgradeCooldownTrades,
      4,
      30
    ),
    lastUpgradedAt:
      raw.lastUpgradedAt != null && Number.isFinite(Number(raw.lastUpgradedAt))
        ? Number(raw.lastUpgradedAt)
        : null,
    version: Math.max(0, Math.round(Number(raw.version) || 0)),
    tradesSinceUpgrade: Math.max(
      0,
      Math.round(Number(raw.tradesSinceUpgrade) || 0)
    ),
    baselineExpectancyPct:
      raw.baselineExpectancyPct != null &&
      Number.isFinite(Number(raw.baselineExpectancyPct))
        ? Number(raw.baselineExpectancyPct)
        : null,
    currentExpectancyPct: Number(raw.currentExpectancyPct) || 0,
    improvementPct: Number(raw.improvementPct) || 0,
    pendingProposal:
      raw.pendingProposal && typeof raw.pendingProposal === 'object'
        ? raw.pendingProposal
        : null,
    history: Array.isArray(raw.history) ? raw.history.slice(-40) : [],
    previousOverrideSnapshot:
      raw.previousOverrideSnapshot &&
      typeof raw.previousOverrideSnapshot === 'object'
        ? raw.previousOverrideSnapshot
        : null,
  };
}

/** Risk-adjusted score from episodes (higher = better). */
export function scoreEpisodesHeuristic(
  episodes: ProfileLearningEpisode[]
): number {
  if (episodes.length === 0) return 0;
  let sum = 0;
  let penalty = 0;
  for (const e of episodes) {
    sum += e.pnlPct || 0;
    if ((e.pnlPct || 0) < -15) penalty += Math.abs(e.pnlPct) * 0.15;
    if ((e.holdSec || 0) > 900 && (e.pnlPct || 0) < 2) penalty += 1.5;
    // Left a lot of MFE on the table
    if (
      (e.maxRunupPct || 0) >= 40 &&
      (e.exitUnrealizedPct || 0) < (e.maxRunupPct || 0) * 0.35
    ) {
      penalty += 2;
    }
  }
  return sum / episodes.length - penalty / episodes.length;
}

/**
 * Heuristic shadow score if candidate exit policy had been tighter/looser.
 * Uses stored MFE / giveback / exit mix — not full path replay (v1).
 */
export function shadowScoreExitCandidate(
  episodes: ProfileLearningEpisode[],
  patch: LearningProposalPatch
): number {
  const pol = patch.exitRules?.exitPolicy || {};
  const arm =
    pol.profitLockArmPct != null ? Number(pol.profitLockArmPct) : null;
  const giveback =
    pol.profitGivebackPts != null ? Number(pol.profitGivebackPts) : null;
  const earlyPartial =
    pol.earlyPartialTpPct != null ? Number(pol.earlyPartialTpPct) : null;
  const holdMax =
    patch.exitRules?.hardTimeLimitSecMax != null
      ? Number(patch.exitRules.hardTimeLimitSecMax)
      : null;

  if (episodes.length === 0) return 0;
  let simulated = 0;
  for (const e of episodes) {
    let pnl = e.pnlPct || 0;
    const peak = e.peakUnrealizedPct || e.maxRunupPct || 0;
    const give = e.givebackFromPeakPct || 0;

    // If we would have armed profit-lock and giveback from peak was large,
    // assume we banked closer to peak − givebackPts (in unrealized pts).
    if (arm != null && giveback != null && peak >= arm) {
      const peakPts = peak;
      const lockedPts = Math.max(arm - giveback, peakPts - giveback);
      // Only improve if actual exit gave back more than candidate would allow
      const actualGivebackPts = peakPts - (e.exitUnrealizedPct || 0);
      if (actualGivebackPts > giveback + 2) {
        pnl = Math.max(pnl, lockedPts * 0.85);
      }
    }

    if (earlyPartial != null && peak >= earlyPartial && pnl < earlyPartial * 0.5) {
      // Early partial would have banked something
      pnl = Math.max(pnl, earlyPartial * 0.35);
    }

    if (holdMax != null && (e.holdSec || 0) > holdMax && pnl < 0) {
      // Shorter timer might cut losers earlier — mild credit
      pnl = pnl * 0.7;
    }

    // Penalty if candidate giveback is too tight vs trades that ran to TP
    if (
      giveback != null &&
      giveback < 8 &&
      /tp|trail/i.test(e.exitKey) &&
      (e.pnlPct || 0) > 20
    ) {
      pnl -= 3;
    }

    simulated += pnl;
    void give;
  }
  return simulated / episodes.length;
}

export function buildExitLearningCandidates(
  profileId: string,
  episodes: ProfileLearningEpisode[],
  currentPolicy: {
    profitLockArmPct: number;
    profitGivebackPts: number;
    profitFloorPct: number;
    earlyPartialTpPct: number;
    earlyPartialFraction: number;
    momentumFadeDropPct: number;
    hardTimeLimitSecMax?: number;
  }
): Array<{ summary: string; patch: LearningProposalPatch }> {
  const out: Array<{ summary: string; patch: LearningProposalPatch }> = [];
  if (episodes.length < 6) return out;

  const avgPeak =
    episodes.reduce((s, e) => s + (e.peakUnrealizedPct || 0), 0) /
    episodes.length;
  const avgGive =
    episodes.reduce((s, e) => s + (e.givebackFromPeakPct || 0), 0) /
    episodes.length;
  const leftOnTable = episodes.filter(
    (e) =>
      (e.maxRunupPct || 0) >= 35 &&
      (e.exitUnrealizedPct || 0) < (e.maxRunupPct || 0) * 0.4
  ).length;
  const timerLosers = episodes.filter(
    (e) => e.exitKey === 'timer' && (e.pnlPct || 0) <= 0
  ).length;

  // Tighten giveback when leaving MFE on table
  if (leftOnTable / episodes.length >= 0.35) {
    const nextGive = clamp(
      (currentPolicy.profitGivebackPts || 25) - 4,
      8,
      45
    );
    const nextArm = clamp(
      Math.round(avgPeak * 0.55) || currentPolicy.profitLockArmPct || 40,
      15,
      90
    );
    out.push({
      summary: `Tighten profit-lock giveback ${currentPolicy.profitGivebackPts || 25}→${nextGive} pts (arm ${nextArm}%)`,
      patch: {
        exitRules: {
          exitPolicy: {
            profitLockArmPct: nextArm,
            profitGivebackPts: nextGive,
            profitFloorPct: currentPolicy.profitFloorPct || 0,
            earlyPartialTpPct: Math.max(
              8,
              Math.min(
                currentPolicy.earlyPartialTpPct || 15,
                Math.round(nextArm * 0.55)
              )
            ),
          },
        },
      },
    });
  }

  // Widen giveback if many fade exits while avg peak was high and final often recovered
  const fadeHeavy = episodes.filter((e) =>
    /fade|giveback|profit.lock|profit-lock/i.test(e.exitReason || '')
  ).length;
  if (fadeHeavy / episodes.length >= 0.3 && avgPeak > 40) {
    const nextGive = clamp(
      (currentPolicy.profitGivebackPts || 25) + 4,
      10,
      50
    );
    out.push({
      summary: `Widen profit giveback → ${nextGive} pts (fade exits cutting runners)`,
      patch: {
        exitRules: {
          exitPolicy: {
            profitLockArmPct: currentPolicy.profitLockArmPct || 40,
            profitGivebackPts: nextGive,
          },
        },
      },
    });
  }

  // Earlier partial when avg peak high but exit mediocre
  if (avgPeak >= 30 && avgGive >= 12) {
    const partial = clamp(
      Math.round((currentPolicy.earlyPartialTpPct || 15) - 3),
      8,
      40
    );
    out.push({
      summary: `Earlier partial @ ${partial}% (avg peak ${avgPeak.toFixed(0)}%)`,
      patch: {
        exitRules: {
          exitPolicy: {
            earlyPartialTpPct: partial,
            earlyPartialFraction: clamp(
              currentPolicy.earlyPartialFraction || 0.4,
              0.25,
              0.55
            ),
          },
        },
      },
    });
  }

  // Timer / hold for scalp family
  if (
    SCALP_PROFILES.has(profileId) &&
    timerLosers / episodes.length >= 0.25 &&
    currentPolicy.hardTimeLimitSecMax != null
  ) {
    const next = Math.max(
      45,
      Math.round(currentPolicy.hardTimeLimitSecMax * 0.85)
    );
    out.push({
      summary: `Shorten hold max ${currentPolicy.hardTimeLimitSecMax}→${next}s`,
      patch: {
        exitRules: { hardTimeLimitSecMax: next },
      },
    });
  }

  // Swing: slightly longer hold when timer cuts greens
  const timerGreens = episodes.filter(
    (e) => e.exitKey === 'timer' && (e.pnlPct || 0) > 5
  ).length;
  if (
    SWING_PROFILES.has(profileId) &&
    timerGreens / episodes.length >= 0.2 &&
    currentPolicy.hardTimeLimitSecMax != null
  ) {
    const next = Math.round(currentPolicy.hardTimeLimitSecMax * 1.15);
    out.push({
      summary: `Extend hold max → ${next}s (timer cutting greens)`,
      patch: {
        exitRules: {
          hardTimeLimitSecMax: next,
          exitPolicy: {
            extendHoldIfTaOk: true,
          },
        },
      },
    });
  }

  return out.slice(0, 4);
}

export function buildEntryLearningCandidates(
  profileId: string,
  episodes: ProfileLearningEpisode[],
  currentMatch: Partial<TradeProfileMatchRules>
): Array<{ summary: string; patch: LearningProposalPatch }> {
  const out: Array<{ summary: string; patch: LearningProposalPatch }> = [];
  // Soft floor — runSelfLearnTick still gates on minTrades + sample confidence
  if (episodes.length < 6) return out;

  const losers = episodes.filter((e) => (e.pnlPct || 0) <= 0);
  const loserRate = losers.length / episodes.length;
  if (loserRate < 0.45) return out;

  const lowConvLosers = losers.filter(
    (e) => e.convictionScore != null && e.convictionScore < 45
  ).length;
  if (lowConvLosers / Math.max(1, losers.length) >= 0.4) {
    const next = clamp(
      Math.max(Number(currentMatch.minConviction) || 40, 45) + 5,
      30,
      85
    );
    out.push({
      summary: `Raise min conviction → ${next} (weak-conviction losers)`,
      patch: { match: { minConviction: next } },
    });
  }

  const lowWallets = losers.filter(
    (e) => e.walletCount != null && e.walletCount <= 1
  ).length;
  if (
    (profileId === 'high_win_rate' ||
      profileId === 'smart_money_mirror' ||
      profileId === 'trend_rider' ||
      profileId === 'steady_compounder') &&
    lowWallets / Math.max(1, losers.length) >= 0.35
  ) {
    const floor = profileId === 'trend_rider' || profileId === 'steady_compounder' ? 2 : 3;
    out.push({
      summary: `Require cluster ≥ ${floor} wallets`,
      patch: {
        match: {
          requireCluster: true,
          minWalletCount: floor,
        },
      },
    });
  }

  if (
    (profileId === 'scalper' || profileId === 'momentum_burst') &&
    loserRate >= 0.55
  ) {
    const wq = clamp(
      Math.max(Number(currentMatch.minWalletQuality) || 35, 35) + 3,
      25,
      55
    );
    out.push({
      summary: `Raise wallet quality floor → ${wq}`,
      patch: { match: { minWalletQuality: wq } },
    });
  }

  return out.slice(0, 3);
}

/** Clamp learning patches to safety bands vs catalog. */
export function clampLearningPatch(
  profileId: string,
  catalogExit: TradeProfileExitRules,
  catalogMatch: TradeProfileMatchRules,
  patch: LearningProposalPatch
): LearningProposalPatch {
  const exitRules: Partial<TradeProfileExitRules> = {
    ...(patch.exitRules || {}),
  };
  const match: Partial<TradeProfileMatchRules> = { ...(patch.match || {}) };

  if (exitRules.sizeMultiplier != null) {
    exitRules.sizeMultiplier = clamp(Number(exitRules.sizeMultiplier), 0.4, 1.2);
  }
  if (exitRules.hardTimeLimitSecMax != null) {
    const catMax = catalogExit.hardTimeLimitSecMax ?? 600;
    exitRules.hardTimeLimitSecMax = clamp(
      Number(exitRules.hardTimeLimitSecMax),
      Math.max(40, catMax * 0.5),
      catMax * 1.6
    );
  }
  if (exitRules.stopLossPctMax != null) {
    const cat = Math.abs(catalogExit.stopLossPctMax ?? 14);
    exitRules.stopLossPctMax = clamp(Number(exitRules.stopLossPctMax), cat * 0.7, cat * 1.5);
  }
  if (exitRules.takeProfitPctMin != null) {
    const cat = catalogExit.takeProfitPctMin ?? 15;
    exitRules.takeProfitPctMin = clamp(
      Number(exitRules.takeProfitPctMin),
      cat * 0.5,
      cat * 1.4
    );
  }

  const ep = exitRules.exitPolicy;
  if (ep) {
    if (ep.profitLockArmPct != null) {
      ep.profitLockArmPct = clamp(Number(ep.profitLockArmPct), 12, 100);
    }
    if (ep.profitGivebackPts != null) {
      ep.profitGivebackPts = clamp(Number(ep.profitGivebackPts), 6, 55);
    }
    if (ep.profitFloorPct != null) {
      ep.profitFloorPct = clamp(Number(ep.profitFloorPct), 0, 60);
    }
    if (ep.earlyPartialTpPct != null) {
      ep.earlyPartialTpPct = clamp(Number(ep.earlyPartialTpPct), 0, 80);
    }
    if (ep.earlyPartialFraction != null) {
      ep.earlyPartialFraction = clamp(Number(ep.earlyPartialFraction), 0.2, 0.6);
    }
    exitRules.exitPolicy = ep;
  }

  if (match.minConviction != null) {
    const cat = catalogMatch.minConviction ?? 40;
    const lo = SCALP_PROFILES.has(profileId) ? Math.min(25, cat - 10) : cat - 5;
    match.minConviction = clamp(Number(match.minConviction), lo, 90);
  }
  if (match.minWalletQuality != null) {
    match.minWalletQuality = clamp(
      Number(match.minWalletQuality),
      SCALP_PROFILES.has(profileId) ? 25 : 40,
      85
    );
  }
  if (match.minWalletCount != null) {
    match.minWalletCount = clamp(Number(match.minWalletCount), 1, 5);
  }

  return {
    exitRules: Object.keys(exitRules).length ? exitRules : undefined,
    match: Object.keys(match).length ? match : undefined,
  };
}

export function refreshSelfLearnMetrics(
  state: ProfileSelfLearningState,
  profileId: string
): ProfileSelfLearningState {
  const next = { ...state };
  const exp = getProfileEpisodeExpectancy(profileId, { lastN: 40 });
  next.currentExpectancyPct = exp.expectancyPct;
  if (next.enabled && next.baselineExpectancyPct == null && exp.n >= next.minTrades) {
    next.baselineExpectancyPct = exp.expectancyPct;
  }
  if (next.baselineExpectancyPct != null && Math.abs(next.baselineExpectancyPct) > 0.01) {
    next.improvementPct =
      ((exp.expectancyPct - next.baselineExpectancyPct) /
        Math.abs(next.baselineExpectancyPct)) *
      100;
  } else if (next.baselineExpectancyPct != null) {
    next.improvementPct = exp.expectancyPct - next.baselineExpectancyPct;
  } else {
    next.improvementPct = 0;
  }
  return next;
}

export function formatSelfLearnBadge(state: ProfileSelfLearningState): string {
  if (!state.enabled) return '';
  const exp = state.currentExpectancyPct;
  if (state.baselineExpectancyPct == null) {
    return `Learning… need ${state.minTrades} trades`;
  }
  const sign = state.improvementPct >= 0 ? '+' : '';
  const upgraded =
    state.lastUpgradedAt != null
      ? ` · Upgraded ${new Date(state.lastUpgradedAt).toLocaleDateString()}`
      : state.version > 0
        ? ` · v${state.version}`
        : '';
  return `${sign}${state.improvementPct.toFixed(0)}% vs baseline${upgraded}`;
}

/**
 * Run one self-learn tick for a profile. Returns updated state + optional apply patch.
 */
export function runSelfLearnTick(input: {
  profileId: string;
  state: ProfileSelfLearningState;
  catalogExit: TradeProfileExitRules;
  catalogMatch: TradeProfileMatchRules;
  currentExit: TradeProfileExitRules;
  currentMatch: TradeProfileMatchRules;
}): {
  state: ProfileSelfLearningState;
  applyPatch?: LearningProposalPatch;
  rollback?: boolean;
} {
  let state = normalizeSelfLearning(input.state);
  if (!state.enabled) {
    return { state };
  }

  const episodes = getProfileLearningEpisodes(input.profileId, 120);
  state = refreshSelfLearnMetrics(state, input.profileId);
  state.tradesSinceUpgrade = Math.min(
    999,
    state.tradesSinceUpgrade + 0
  ); // caller increments on close

  // Rollback check: post-upgrade window worse than previous score
  if (
    state.version > 0 &&
    state.tradesSinceUpgrade >= state.upgradeCooldownTrades &&
    state.history.length > 0
  ) {
    const last = state.history[state.history.length - 1];
    if (!last.rolledBack) {
      const recent = getProfileLearningEpisodes(input.profileId, 80).filter(
        (e) => e.paramVersion === state.version
      );
      if (recent.length >= Math.max(5, Math.floor(state.upgradeCooldownTrades * 0.75))) {
        const after = scoreEpisodesHeuristic(recent);
        if (after < last.scoreBefore - 2.5) {
          state.pendingProposal = null;
          return {
            state: {
              ...state,
              history: [
                ...state.history.slice(0, -1),
                { ...last, rolledBack: true },
              ],
            },
            rollback: true,
          };
        }
      }
    }
  }

  if (episodes.length < state.minTrades) {
    return { state };
  }
  if (state.tradesSinceUpgrade < state.upgradeCooldownTrades && state.version > 0) {
    return { state };
  }

  const confidence = learningSampleConfidence(episodes.length);
  if (!confidence.allowExit && !confidence.allowEntry) {
    return { state };
  }

  const pol = input.currentExit.exitPolicy || {};
  const currentPolicy = {
    profitLockArmPct: Number(pol.profitLockArmPct) || 40,
    profitGivebackPts: Number(pol.profitGivebackPts) || 25,
    profitFloorPct: Number(pol.profitFloorPct) || 0,
    earlyPartialTpPct: Number(pol.earlyPartialTpPct) || 15,
    earlyPartialFraction: Number(pol.earlyPartialFraction) || 0.4,
    momentumFadeDropPct: Number(pol.momentumFadeDropPct) || 8,
    hardTimeLimitSecMax: input.currentExit.hardTimeLimitSecMax,
  };

  const candidates = [
    ...(confidence.allowExit
      ? buildExitLearningCandidates(input.profileId, episodes, currentPolicy)
      : []),
    ...(confidence.allowEntry
      ? buildEntryLearningCandidates(
          input.profileId,
          episodes,
          input.currentMatch
        )
      : []),
  ];

  const scoreBefore = scoreEpisodesHeuristic(episodes.slice(-40));
  let best: LearningProposal | null = null;

  for (const c of candidates) {
    const scaled = scaleLearningPatch(c.patch, confidence.nudgeScale);
    const clamped = clampLearningPatch(
      input.profileId,
      input.catalogExit,
      input.catalogMatch,
      scaled
    );
    if (!clamped.exitRules && !clamped.match) continue;
    const scoreAfter =
      clamped.exitRules != null
        ? shadowScoreExitCandidate(episodes.slice(-40), clamped)
        : scoreBefore + 0.8 * confidence.nudgeScale; // mild credit for entry tighten when losing
    if (scoreAfter > scoreBefore + confidence.scoreMargin) {
      if (!best || scoreAfter > best.scoreAfter) {
        best = {
          at: Date.now(),
          summary:
            c.summary +
            (confidence.nudgeScale < 1
              ? ` (sample×${confidence.nudgeScale.toFixed(2)})`
              : ''),
          patch: clamped,
          scoreBefore,
          scoreAfter,
          kind: clamped.exitRules && clamped.match ? 'mixed' : clamped.exitRules ? 'exit' : 'entry',
        };
      }
    }
  }

  if (!best) {
    state.pendingProposal = null;
    return { state };
  }

  state.pendingProposal = best;

  if (state.mode === 'auto') {
    return { state, applyPatch: best.patch };
  }

  // Shadow: promote to auto after first manual apply path — keep proposal visible
  return { state };
}

export function applySelfLearnUpgrade(
  state: ProfileSelfLearningState,
  proposal: LearningProposal,
  previousOverrides: TradeProfileParamOverride | null
): ProfileSelfLearningState {
  const nextVersion = state.version + 1;
  return normalizeSelfLearning({
    ...state,
    version: nextVersion,
    lastUpgradedAt: Date.now(),
    tradesSinceUpgrade: 0,
    pendingProposal: null,
    mode: state.mode === 'shadow' ? 'auto' : state.mode,
    previousOverrideSnapshot: previousOverrides,
    history: [
      ...state.history,
      {
        version: nextVersion,
        at: Date.now(),
        summary: proposal.summary,
        patch: proposal.patch,
        scoreBefore: proposal.scoreBefore,
        scoreAfter: proposal.scoreAfter,
      },
    ].slice(-40),
  });
}

export function isSwingProfile(profileId: string): boolean {
  return SWING_PROFILES.has(profileId);
}

export function isScalpFamilyProfile(profileId: string): boolean {
  return SCALP_PROFILES.has(profileId);
}

/** Persist helper used by tradeProfiles after mutating selfLearning map. */
export function touchPersist(): void {
  try {
    persistUserSettings();
  } catch {
    /* bootstrap */
  }
}

export type { TradeProfileId };
