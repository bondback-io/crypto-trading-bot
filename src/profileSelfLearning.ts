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
import type { MlAdvice, MlLearnMode } from './profileLearningMl';

export type SelfLearnMode = 'shadow' | 'auto';
export type { MlLearnMode };
export type MutationSource = 'heuristic' | 'hybrid' | 'ml';

export interface LearningProposalPatch {
  exitRules?: Partial<TradeProfileExitRules>;
  match?: Partial<TradeProfileMatchRules>;
  /**
   * Bounded PCL family override (permission / early partial).
   * Applied via setProfitCaptureLayerConfig — never writes hard SL/anti-rug.
   */
  pclFamilyOverride?: {
    family: 'fast' | 'dip_trend' | 'quality';
    permissionSec?: number;
    earlyPartialTpPct?: number;
  };
}

export interface LearningProposal {
  at: number;
  summary: string;
  patch: LearningProposalPatch;
  scoreBefore: number;
  scoreAfter: number;
  kind: 'exit' | 'entry' | 'mixed';
  source?: MutationSource;
  heuristicDelta?: number;
  mlDelta?: number;
  blendWeight?: number;
}

export interface SelfLearnHistoryEntry {
  version: number;
  at: number;
  summary: string;
  patch: LearningProposalPatch;
  scoreBefore: number;
  scoreAfter: number;
  rolledBack?: boolean;
  /** Closed episodes counted when this upgrade was applied */
  episodeCountAtUpgrade?: number;
  winsAtUpgrade?: number;
  lossesAtUpgrade?: number;
}

/** Best candidate that almost cleared the upgrade margin (for UI). */
export interface SelfLearnNearMiss {
  summary: string;
  scoreBefore: number;
  scoreAfter: number;
  scoreDelta: number;
  scoreMargin: number;
  /** How much more Δscore needed to pass (0 if already at/above). */
  needed: number;
  patternHint: string;
}

export interface SelfLearnLastMutation {
  at: number;
  kind: 'upgrade' | 'micro';
  summary: string;
  changes: string;
  scoreBefore?: number;
  scoreAfter?: number;
  version?: number;
  microVersion?: number;
  source?: MutationSource;
}

/** Score window for upgrade / near-miss evaluation (episodes ring still larger). */
export const LEARNING_SCORE_WINDOW = 80;

export const LEARNING_PROGRESS_GOAL = 400;

export interface LearningUpgradeMilestone {
  level: number;
  at: number;
  episodeCount: number;
  wins: number;
  losses: number;
  summary: string;
  /** Short humanized list of knob changes from the patch */
  changes: string;
  /** Hover / title line */
  label: string;
}

export interface LearningProgressSnapshot {
  episodes: number;
  wins: number;
  losses: number;
  goal: number;
  pct: number;
  level: number;
  upgrades: LearningUpgradeMilestone[];
  /** Closed trades for this profile in the current session list (≤200 rows). */
  sessionClosed?: number;
}

export interface ProfileSelfLearningState {
  enabled: boolean;
  mode: SelfLearnMode;
  /** ML advisor: off | shadow advice | hybrid blend | lead deltas */
  mlMode: MlLearnMode;
  /** Who last set mlMode — auto-promote vs operator UI/API */
  mlModeSource: 'auto' | 'manual';
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
  /** Multi-step rollback stack (newest last; max 8) */
  previousOverrideStack?: TradeProfileParamOverride[];
  /** Tiny tweaks between Level upgrades (does not bump version) */
  microVersion: number;
  /** Apply a micro nudge every N closes when no full upgrade candidate */
  microEveryTrades: number;
  tradesSinceMicro: number;
  lastMutation: SelfLearnLastMutation | null;
  nearMiss: SelfLearnNearMiss | null;
  /** Closes until next micro eligibility (0 = eligible now) */
  nextEligibleIn: number;
  /** Latest ML advisor snapshot for UI */
  mlAdvice: MlAdvice | null;
  /** True when paper soak validated ML enough to recommend hybrid */
  mlValidatedInPaper: boolean;
}

export const DEFAULT_SELF_LEARNING: ProfileSelfLearningState = {
  enabled: true,
  mode: 'auto',
  mlMode: 'shadow',
  mlModeSource: 'manual',
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
  previousOverrideStack: [],
  microVersion: 0,
  microEveryTrades: 4,
  tradesSinceMicro: 0,
  lastMutation: null,
  nearMiss: null,
  nextEligibleIn: 0,
  mlAdvice: null,
  mlValidatedInPaper: false,
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
      scoreMargin: 0.75,
      nudgeScale: 0.5,
    };
  }
  if (n < 12) {
    return {
      n,
      allowExit: true,
      allowEntry: true,
      scoreMargin: 0.5,
      nudgeScale: 0.75,
    };
  }
  return {
    n,
    allowExit: true,
    allowEntry: true,
    scoreMargin: 0.35,
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
    pclFamilyOverride: patch.pclFamilyOverride
      ? {
          family: patch.pclFamilyOverride.family,
          permissionSec:
            patch.pclFamilyOverride.permissionSec != null
              ? Math.round(
                  Number(
                    scaleNum(patch.pclFamilyOverride.permissionSec) ??
                      patch.pclFamilyOverride.permissionSec
                  )
                )
              : undefined,
          earlyPartialTpPct:
            patch.pclFamilyOverride.earlyPartialTpPct != null
              ? Math.round(
                  Number(
                    scaleNum(patch.pclFamilyOverride.earlyPartialTpPct) ??
                      patch.pclFamilyOverride.earlyPartialTpPct
                  ) * 10
                ) / 10
              : undefined,
        }
      : undefined,
  };
}

export function normalizeSelfLearning(
  raw?: Partial<ProfileSelfLearningState> | null
): ProfileSelfLearningState {
  const d = DEFAULT_SELF_LEARNING;
  if (!raw || typeof raw !== 'object') {
    return {
      ...d,
      history: [],
      lastMutation: null,
      nearMiss: null,
      mlAdvice: null,
    };
  }
  const hasEnabled = Object.prototype.hasOwnProperty.call(raw, 'enabled');
  const hasMode = Object.prototype.hasOwnProperty.call(raw, 'mode');
  let normalizeMlMode: (v: unknown) => MlLearnMode = (v) =>
    v === 'hybrid' || v === 'lead' || v === 'off' || v === 'shadow'
      ? v
      : 'shadow';
  let normalizeMlModeSource: (v: unknown) => 'auto' | 'manual' = (v) =>
    v === 'auto' ? 'auto' : 'manual';
  try {
    const ml = require('./profileLearningMl') as typeof import('./profileLearningMl');
    normalizeMlMode = ml.normalizeMlMode;
    normalizeMlModeSource = ml.normalizeMlModeSource;
  } catch {
    /* bootstrap */
  }
  return {
    // Default ON when unset; only explicit false turns it off
    enabled: hasEnabled ? raw.enabled === true : d.enabled,
    // Default auto for new installs; explicit shadow stays shadow
    mode: hasMode
      ? raw.mode === 'auto'
        ? 'auto'
        : 'shadow'
      : d.mode,
    mlMode: normalizeMlMode(raw.mlMode),
    mlModeSource: normalizeMlModeSource(
      (raw as { mlModeSource?: unknown }).mlModeSource
    ),
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
    history: Array.isArray(raw.history)
      ? raw.history.slice(-40).map((h) => normalizeHistoryEntry(h))
      : [],
    previousOverrideSnapshot:
      raw.previousOverrideSnapshot &&
      typeof raw.previousOverrideSnapshot === 'object'
        ? raw.previousOverrideSnapshot
        : null,
    previousOverrideStack: Array.isArray(
      (raw as { previousOverrideStack?: unknown }).previousOverrideStack
    )
      ? (
          (raw as { previousOverrideStack: TradeProfileParamOverride[] })
            .previousOverrideStack || []
        )
          .filter((x) => x && typeof x === 'object')
          .slice(-8)
      : raw.previousOverrideSnapshot &&
          typeof raw.previousOverrideSnapshot === 'object'
        ? [raw.previousOverrideSnapshot]
        : [],
    microVersion: Math.max(0, Math.round(Number(raw.microVersion) || 0)),
    microEveryTrades: clamp(
      Number(raw.microEveryTrades) || d.microEveryTrades,
      2,
      20
    ),
    tradesSinceMicro: Math.max(
      0,
      Math.round(Number(raw.tradesSinceMicro) || 0)
    ),
    lastMutation: normalizeLastMutation(raw.lastMutation),
    nearMiss: normalizeNearMiss(raw.nearMiss),
    nextEligibleIn: Math.max(0, Math.round(Number(raw.nextEligibleIn) || 0)),
    mlAdvice:
      raw.mlAdvice && typeof raw.mlAdvice === 'object'
        ? (raw.mlAdvice as MlAdvice)
        : null,
    mlValidatedInPaper: raw.mlValidatedInPaper === true,
  };
}

function normalizeNearMiss(
  raw: Partial<SelfLearnNearMiss> | null | undefined
): SelfLearnNearMiss | null {
  if (!raw || typeof raw !== 'object') return null;
  const scoreBefore = Number(raw.scoreBefore) || 0;
  const scoreAfter = Number(raw.scoreAfter) || 0;
  const scoreMargin = Number(raw.scoreMargin) || 0;
  const scoreDelta = Number.isFinite(Number(raw.scoreDelta))
    ? Number(raw.scoreDelta)
    : scoreAfter - scoreBefore;
  const needed = Math.max(0, scoreMargin - scoreDelta);
  return {
    summary: String(raw.summary || ''),
    scoreBefore,
    scoreAfter,
    scoreDelta,
    scoreMargin,
    needed: Number.isFinite(Number(raw.needed))
      ? Math.max(0, Number(raw.needed))
      : needed,
    patternHint: String(raw.patternHint || ''),
  };
}

function normalizeLastMutation(
  raw: Partial<SelfLearnLastMutation> | null | undefined
): SelfLearnLastMutation | null {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind === 'micro' ? 'micro' : 'upgrade';
  const source: MutationSource | undefined =
    raw.source === 'ml' || raw.source === 'hybrid' || raw.source === 'heuristic'
      ? raw.source
      : undefined;
  return {
    at: Number(raw.at) || 0,
    kind,
    summary: String(raw.summary || ''),
    changes: String(raw.changes || ''),
    scoreBefore:
      raw.scoreBefore != null && Number.isFinite(Number(raw.scoreBefore))
        ? Number(raw.scoreBefore)
        : undefined,
    scoreAfter:
      raw.scoreAfter != null && Number.isFinite(Number(raw.scoreAfter))
        ? Number(raw.scoreAfter)
        : undefined,
    version:
      raw.version != null && Number.isFinite(Number(raw.version))
        ? Math.max(0, Math.round(Number(raw.version)))
        : undefined,
    microVersion:
      raw.microVersion != null && Number.isFinite(Number(raw.microVersion))
        ? Math.max(0, Math.round(Number(raw.microVersion)))
        : undefined,
    source,
  };
}

function normalizeHistoryEntry(
  raw: Partial<SelfLearnHistoryEntry> | null | undefined
): SelfLearnHistoryEntry {
  const h = raw && typeof raw === 'object' ? raw : {};
  return {
    version: Math.max(0, Math.round(Number(h.version) || 0)),
    at: Number(h.at) || 0,
    summary: String(h.summary || ''),
    patch: (h.patch && typeof h.patch === 'object' ? h.patch : {}) as LearningProposalPatch,
    scoreBefore: Number(h.scoreBefore) || 0,
    scoreAfter: Number(h.scoreAfter) || 0,
    rolledBack: h.rolledBack === true,
    episodeCountAtUpgrade:
      h.episodeCountAtUpgrade != null && Number.isFinite(Number(h.episodeCountAtUpgrade))
        ? Math.max(0, Math.round(Number(h.episodeCountAtUpgrade)))
        : undefined,
    winsAtUpgrade:
      h.winsAtUpgrade != null && Number.isFinite(Number(h.winsAtUpgrade))
        ? Math.max(0, Math.round(Number(h.winsAtUpgrade)))
        : undefined,
    lossesAtUpgrade:
      h.lossesAtUpgrade != null && Number.isFinite(Number(h.lossesAtUpgrade))
        ? Math.max(0, Math.round(Number(h.lossesAtUpgrade)))
        : undefined,
  };
}

/** Win/loss totals for a profile's learning episodes (optionally filtered). */
export function countEpisodeWinLoss(
  profileId: string,
  opts?: { beforeVersion?: number }
): { episodes: number; wins: number; losses: number } {
  const eps = getProfileLearningEpisodes(profileId, 500);
  const filtered =
    opts?.beforeVersion != null
      ? eps.filter((e) => (e.paramVersion ?? 0) < opts.beforeVersion!)
      : eps;
  let wins = 0;
  let losses = 0;
  for (const e of filtered) {
    if ((e.pnlPct || 0) > 0) wins += 1;
    else losses += 1;
  }
  return { episodes: filtered.length, wins, losses };
}

function formatUpgradeLabel(
  profileName: string,
  level: number,
  episodeCount: number,
  wins: number,
  losses: number,
  summary?: string,
  changes?: string
): string {
  const base =
    `${profileName} · Level ${level} after ${episodeCount} trade` +
    (episodeCount === 1 ? '' : 's') +
    ` (${wins} win${wins === 1 ? '' : 's'} / ${losses} loss${losses === 1 ? '' : 'es'})`;
  const parts = [base];
  if (summary && String(summary).trim()) parts.push(String(summary).trim());
  if (changes && String(changes).trim()) parts.push('Changed: ' + String(changes).trim());
  return parts.join(' — ');
}

const PATCH_LABELS: Record<string, string> = {
  profitLockArmPct: 'profit lock arm %',
  profitGivebackPts: 'giveback pts',
  profitFloorPct: 'profit floor %',
  peakProtectArmOfTpPct: 'peak protect arm % of TP',
  peakProtectGivebackOfPeakPct: 'peak protect giveback % of peak',
  earlyPartialTpPct: 'early partial TP %',
  earlyPartialFraction: 'early partial fraction',
  momentumFadeDropPct: 'momentum fade drop %',
  hardTimeLimitSecMax: 'hard time limit sec',
  hardTimeLimitSecMin: 'hard time limit min sec',
  stopLossPct: 'stop loss %',
  trailingActivationProfit: 'trail activate %',
  trailingStopPct: 'trail %',
  minProfitPercent: 'min profit %',
  maxProfitPercent: 'max profit %',
  minConviction: 'min conviction',
  minWallets: 'min wallets',
  minWalletQuality: 'min wallet quality',
  minWalletCount: 'min wallet count',
  minTokenAgeHours: 'min token age (h)',
  minMarketCapUsd: 'min MC $',
  maxMarketCapUsd: 'max MC $',
  minLiquidityUsd: 'min liq $',
  sizeMultiplier: 'size ×',
  requireConvergence: 'require convergence',
  requireCluster: 'require cluster',
  heikinAshiExitEnabled: 'Heikin-Ashi exit',
  trailTightenFactor: 'trail tighten ×',
  permissionSec: 'PCL permission sec',
};

/** Flatten a learning patch into a short "knob: value" list for UI hover. */
export function humanizeLearningPatch(patch: LearningProposalPatch | null | undefined): string {
  if (!patch || typeof patch !== 'object') return '';
  const bits: string[] = [];
  const pushObj = (obj: Record<string, unknown> | null | undefined, prefix = '') => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (v == null) continue;
      if (typeof v === 'object' && !Array.isArray(v)) {
        pushObj(v as Record<string, unknown>, prefix);
        continue;
      }
      const label = PATCH_LABELS[k] || k;
      if (typeof v === 'boolean') {
        bits.push(`${label}=${v ? 'on' : 'off'}`);
      } else if (typeof v === 'number' && Number.isFinite(v)) {
        bits.push(`${label}=${Number(v)}`);
      } else if (typeof v === 'string' && v.trim()) {
        bits.push(`${label}=${v.trim()}`);
      }
    }
  };
  if (patch.exitRules) {
    pushObj(patch.exitRules as Record<string, unknown>);
  }
  if (patch.match) {
    pushObj(patch.match as Record<string, unknown>);
  }
  if (patch.pclFamilyOverride) {
    const fo = patch.pclFamilyOverride;
    bits.push(`PCL ${fo.family}`);
    if (fo.permissionSec != null) bits.push(`permission=${fo.permissionSec}s`);
    if (fo.earlyPartialTpPct != null) {
      bits.push(`early partial=${fo.earlyPartialTpPct}%`);
    }
  }
  return bits.slice(0, 8).join(', ');
}

/**
 * Visual progress toward the 200-episode learning goal + upgrade milestones.
 */
export function getLearningProgressSnapshot(
  profileId: string,
  state: ProfileSelfLearningState,
  profileName?: string
): LearningProgressSnapshot {
  const name = profileName || profileId;
  const totals = countEpisodeWinLoss(profileId);
  const goal = LEARNING_PROGRESS_GOAL;
  const pct =
    goal > 0
      ? Math.min(100, Math.round((totals.episodes / goal) * 1000) / 10)
      : 0;
  const upgrades: LearningUpgradeMilestone[] = [];
  for (const h of state.history || []) {
    if (h.rolledBack) continue;
    let episodeCount = h.episodeCountAtUpgrade;
    let wins = h.winsAtUpgrade;
    let losses = h.lossesAtUpgrade;
    if (episodeCount == null || wins == null || losses == null) {
      const reconstructed = countEpisodeWinLoss(profileId, {
        beforeVersion: h.version,
      });
      episodeCount = episodeCount ?? reconstructed.episodes;
      wins = wins ?? reconstructed.wins;
      losses = losses ?? reconstructed.losses;
    }
    const changes = humanizeLearningPatch(h.patch);
    const summary = h.summary || '';
    upgrades.push({
      level: h.version,
      at: h.at,
      episodeCount,
      wins,
      losses,
      summary,
      changes,
      label: formatUpgradeLabel(
        name,
        h.version,
        episodeCount,
        wins,
        losses,
        summary,
        changes
      ),
    });
  }
  return {
    episodes: totals.episodes,
    wins: totals.wins,
    losses: totals.losses,
    goal,
    pct,
    level: Math.max(0, state.version || 0),
    upgrades,
    sessionClosed: (() => {
      try {
        const { paperTrader } =
          require('./paperTrader') as typeof import('./paperTrader');
        return paperTrader.getSessionClosedCountForProfile(profileId);
      } catch {
        return 0;
      }
    })(),
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
    // Prefer enriched timing reward when present (new closes); else pnl/MFE path
    if (e.timingReward != null && Number.isFinite(e.timingReward)) {
      sum += Number(e.timingReward);
      if ((e.exitQualityScore ?? 50) < 35) penalty += 1.2;
      if ((e.entryQualityScore ?? 50) < 35) penalty += 0.8;
    } else {
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
  const pppArm =
    pol.peakProtectArmOfTpPct != null
      ? Number(pol.peakProtectArmOfTpPct)
      : null;
  const pppGive =
    pol.peakProtectGivebackOfPeakPct != null
      ? Number(pol.peakProtectGivebackOfPeakPct)
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

    // Peak Protect arm (% of TP) + giveback (% of peak) — shadow parity with Timing candidates
    if (pppArm != null && pppGive != null && peak > 0) {
      const tpProxy = Math.max(peak, Number(e.pnlPct) || 0, 20);
      const armPct = (pppArm / 100) * tpProxy;
      if (peak >= armPct * 0.85) {
        const allowedGive = (pppGive / 100) * peak;
        const actualGive = Math.max(0, peak - (e.exitUnrealizedPct || pnl));
        if (actualGive > allowedGive + 1.5) {
          const locked = Math.max(armPct * 0.5, peak - allowedGive);
          pnl = Math.max(pnl, locked * 0.8);
        }
        if (
          e.peakProtectNearMiss === true &&
          pppArm > 40 &&
          (e.pnlPct || 0) < peak * 0.55
        ) {
          // Later/earlier arm hint: mild credit when near-miss film is dense
          pnl += 0.4;
        }
        if (
          e.peakProtectBeatFullTp === false &&
          pppGive < 40 &&
          actualGive > allowedGive
        ) {
          pnl += 0.6;
        }
      }
    } else if (pppGive != null && peak > 0 && e.peakProtectArmed === true) {
      const allowedGive = (pppGive / 100) * peak;
      const actualGive = Math.max(0, Number(e.givebackFromPeakPct) || 0);
      if (actualGive > allowedGive + 2) {
        pnl = Math.max(pnl, (peak - allowedGive) * 0.75);
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

/**
 * Shadow-score an entry (match) tighten: credit avoided losers, mild penalty for
 * skipped winners. Uses filtered replay vs flat +0.8 credit that could never beat margin.
 */
export function shadowScoreEntryCandidate(
  episodes: ProfileLearningEpisode[],
  patch: LearningProposalPatch
): number {
  if (episodes.length === 0) return 0;
  const match = patch.match || {};
  const minConv =
    match.minConviction != null ? Number(match.minConviction) : null;
  const minWc =
    match.minWalletCount != null ? Number(match.minWalletCount) : null;
  const requireCluster = match.requireCluster === true;

  const kept: ProfileLearningEpisode[] = [];
  let skippedLoserCredit = 0;
  let skippedWinnerPenalty = 0;

  for (const e of episodes) {
    let wouldSkip = false;
    if (
      minConv != null &&
      e.convictionScore != null &&
      Number.isFinite(e.convictionScore) &&
      e.convictionScore < minConv
    ) {
      wouldSkip = true;
    }
    if (
      minWc != null &&
      e.walletCount != null &&
      Number.isFinite(e.walletCount) &&
      e.walletCount < minWc
    ) {
      wouldSkip = true;
    }
    if (requireCluster && (e.walletCount == null || e.walletCount < 2)) {
      wouldSkip = true;
    }

    if (wouldSkip) {
      const pnl = e.pnlPct || 0;
      if (pnl <= 0) skippedLoserCredit += Math.abs(pnl) * 0.55;
      else skippedWinnerPenalty += pnl * 0.3;
      continue;
    }
    kept.push(e);
  }

  const filterScore =
    kept.length > 0
      ? scoreEpisodesHeuristic(kept)
      : 0;
  const skipAdj =
    (skippedLoserCredit - skippedWinnerPenalty) / episodes.length;
  // Weight kept expectancy by coverage so all-filter doesn't look artificially flat
  const coverage = kept.length / episodes.length;
  return filterScore * Math.max(0.35, coverage) + skipAdj;
}

/** Combined shadow score for exit and/or entry patches. */
export function shadowScoreCandidate(
  episodes: ProfileLearningEpisode[],
  patch: LearningProposalPatch,
  scoreBefore: number
): number {
  const hasExit = patch.exitRules != null && Object.keys(patch.exitRules).length > 0;
  const hasMatch = patch.match != null && Object.keys(patch.match).length > 0;
  if (hasExit && hasMatch) {
    const exitScore = shadowScoreExitCandidate(episodes, patch);
    const entryScore = shadowScoreEntryCandidate(episodes, patch);
    return (exitScore + entryScore) / 2;
  }
  if (hasExit) return shadowScoreExitCandidate(episodes, patch);
  if (hasMatch) return shadowScoreEntryCandidate(episodes, patch);
  return scoreBefore;
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
    heikinAshiExitEnabled?: boolean;
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

  // Failure-category-aware candidates
  const categorised = episodes.filter((e) => e.failureCategory);
  if (categorised.length >= 6) {
    const losers = categorised.filter((e) => (e.pnlPct || 0) <= 0);
    if (losers.length > 0) {
      const catCount = (cat: string) => losers.filter((e) => e.failureCategory === cat).length;
      const missedTp = catCount('missed_tp');
      const fadeAfter = catCount('fade_after_pump');
      const earlySl = catCount('early_sl');

      if (missedTp / losers.length >= 0.32) {
        const nextGive = clamp((currentPolicy.profitGivebackPts || 25) - 6, 6, 40);
        const nextPartial = clampLearnedEarlyPartial(
          profileId,
          clamp(
            Math.round((currentPolicy.earlyPartialTpPct || 15) - 4), 6, 35
          )
        );
        out.push({
          summary: `Missed-TP pattern (${missedTp}/${losers.length} losses) — tighten giveback→${nextGive}, partial→${nextPartial}%`,
          patch: {
            exitRules: {
              exitPolicy: {
                profitGivebackPts: nextGive,
                earlyPartialTpPct: nextPartial,
                earlyPartialFraction: clamp((currentPolicy.earlyPartialFraction || 0.4) + 0.1, 0.25, 0.6),
              },
            },
          },
        });
      }

      if (fadeAfter / losers.length >= 0.22) {
        const nextArm = clamp(Math.round((currentPolicy.profitLockArmPct || 40) * 0.7), 12, 60);
        out.push({
          summary: `Fade-after-pump pattern (${fadeAfter}/${losers.length}) — arm profit-lock earlier→${nextArm}%, larger partial`,
          patch: {
            exitRules: {
              exitPolicy: {
                profitLockArmPct: nextArm,
                earlyPartialFraction: clamp((currentPolicy.earlyPartialFraction || 0.4) + 0.1, 0.25, 0.6),
              },
            },
          },
        });
      }

      if (earlySl / losers.length >= 0.18) {
        out.push({
          summary: `Early-SL pattern (${earlySl}/${losers.length}) — raise conviction floor`,
          patch: {
            match: {
              minConviction: clamp(
                Math.max(Number((episodes[0] as any)?.convictionScore || 40), 40) + 5, 30, 85
              ),
            },
          },
        });
      }
    }
  }

  // Tighten giveback when leaving MFE on table
  if (leftOnTable / episodes.length >= 0.22) {
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
  if (fadeHeavy / episodes.length >= 0.22 && avgPeak > 40) {
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
    const partial = clampLearnedEarlyPartial(
      profileId,
      clamp(
        Math.round((currentPolicy.earlyPartialTpPct || 15) - 3),
        8,
        40
      )
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
    timerLosers / episodes.length >= 0.18 &&
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
    timerGreens / episodes.length >= 0.15 &&
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

  // Swing HA exit: enable when trail/fade/left-on-table heavy and HA off
  const haSwing =
    profileId === 'trend_rider' ||
    profileId === 'steady_compounder' ||
    profileId === 'high_win_rate';
  const trailShare =
    episodes.filter((e) => e.exitKey === 'trail').length / episodes.length;
  const fadeShare =
    categorised.length > 0
      ? categorised.filter(
          (e) =>
            (e.pnlPct || 0) <= 0 && e.failureCategory === 'fade_after_pump'
        ).length / Math.max(1, categorised.filter((e) => (e.pnlPct || 0) <= 0).length)
      : 0;
  const haOn = currentPolicy.heikinAshiExitEnabled === true;
  if (
    haSwing &&
    !haOn &&
    (trailShare >= 0.25 || fadeShare >= 0.22 || leftOnTable / episodes.length >= 0.22)
  ) {
    out.push({
      summary: `Enable Heikin-Ashi exit (trail ${Math.round(trailShare * 100)}% / left-on-table ${leftOnTable})`,
      patch: {
        exitRules: {
          exitPolicy: { heikinAshiExitEnabled: true },
        },
      },
    });
  }

  // Swing HA exit: disable when many early HA exits with poor expectancy
  const haExits = episodes.filter((e) => e.exitKey === 'ha');
  if (haSwing && haOn && haExits.length >= 4) {
    const haExpect =
      haExits.reduce((s, e) => s + (e.pnlPct || 0), 0) / haExits.length;
    const earlyHa = haExits.filter((e) => (e.holdSec || 0) < 180).length;
    if (haExpect < 0 && earlyHa / haExits.length >= 0.4) {
      out.push({
        summary: `Disable Heikin-Ashi exit (avg ${haExpect.toFixed(1)}% · early cuts ${earlyHa}/${haExits.length})`,
        patch: {
          exitRules: {
            exitPolicy: { heikinAshiExitEnabled: false },
          },
        },
      });
    }
  }

  // Mild always-on exit nudge when recent expectancy is weak or MFE left on table
  const expectancy =
    episodes.reduce((s, e) => s + (e.pnlPct || 0), 0) / episodes.length;
  const leftShare = leftOnTable / episodes.length;
  // Raise sensitivity: was 0.18 — catch scratchy soft-exits sooner
  if (expectancy < 0 || leftShare >= 0.14) {
    const nextGive = clamp(
      (currentPolicy.profitGivebackPts || 25) - (leftShare >= 0.22 ? 3 : 2),
      8,
      45
    );
    const nextPartial = clampLearnedEarlyPartial(
      profileId,
      clamp(
        Math.round((currentPolicy.earlyPartialTpPct || 15) - (leftShare >= 0.22 ? 3 : 2)),
        6,
        40
      )
    );
    const nextArm = clamp(
      Math.round((currentPolicy.profitLockArmPct || 40) * (leftShare >= 0.22 ? 0.9 : 0.92)),
      12,
      90
    );
    out.push({
      summary:
        expectancy < 0
          ? `Mild expectancy nudge (${expectancy.toFixed(1)}%) — tighten trail/giveback`
          : `Mild left-on-table nudge (${Math.round(leftShare * 100)}%) — small trail/TP tweak`,
      patch: {
        exitRules: {
          exitPolicy: {
            profitGivebackPts: nextGive,
            earlyPartialTpPct: nextPartial,
            profitLockArmPct: nextArm,
          },
        },
      },
    });
  }

  return out.slice(0, 5);
}

/**
 * Soft exit-feedback report (scoring / logs only — does not write overrides).
 */
export interface SoftExitFeedbackReport {
  n: number;
  avgGivebackPct: number;
  largeGivebackRate: number;
  deadMarketShare: number;
  deadMarketAvgPnl: number;
  earlySlRate: number;
  normalSlRate: number;
  avgMaeAbs: number;
  avgEntryQuality: number | null;
  avgExitQuality: number | null;
  /** Hint weights for ranking candidates (not applied as patches by themselves) */
  preferTightenGiveback: boolean;
  preferLoosenGiveback: boolean;
  preferLaterArm: boolean;
  preferSkipPartial: boolean;
  preferTighterTrail: boolean;
  preferLooserFade: boolean;
  preferEarlierTrailArm: boolean;
}

export function buildSoftExitFeedback(
  episodes: ProfileLearningEpisode[]
): SoftExitFeedbackReport {
  const n = episodes.length;
  if (n === 0) {
    return {
      n: 0,
      avgGivebackPct: 0,
      largeGivebackRate: 0,
      deadMarketShare: 0,
      deadMarketAvgPnl: 0,
      earlySlRate: 0,
      normalSlRate: 0,
      avgMaeAbs: 0,
      avgEntryQuality: null,
      avgExitQuality: null,
      preferTightenGiveback: false,
      preferLoosenGiveback: false,
      preferLaterArm: false,
      preferSkipPartial: false,
      preferTighterTrail: false,
      preferLooserFade: false,
      preferEarlierTrailArm: false,
    };
  }
  const give = episodes.map((e) => e.givebackFromPeakPct || 0);
  const avgGivebackPct = give.reduce((a, b) => a + b, 0) / n;
  const largeGivebackRate =
    give.filter((g) => g >= 12).length / n;
  const dead = episodes.filter((e) => e.exitKey === 'dead_market');
  const deadMarketShare = dead.length / n;
  const deadMarketAvgPnl = dead.length
    ? dead.reduce((s, e) => s + (e.pnlPct || 0), 0) / dead.length
    : 0;
  const earlySlRate =
    episodes.filter((e) => e.failureCategory === 'early_sl').length / n;
  const normalSlRate =
    episodes.filter((e) => e.failureCategory === 'normal_sl').length / n;
  const avgMaeAbs =
    episodes.reduce((s, e) => s + Math.abs(e.maxDrawdownPct || 0), 0) / n;
  const entryQs = episodes
    .map((e) => e.entryQualityScore)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const exitQs = episodes
    .map((e) => e.exitQualityScore)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const avgEntryQuality = entryQs.length
    ? entryQs.reduce((a, b) => a + b, 0) / entryQs.length
    : null;
  const avgExitQuality = exitQs.length
    ? exitQs.reduce((a, b) => a + b, 0) / exitQs.length
    : null;

  const preferTightenGiveback =
    largeGivebackRate >= 0.28 || avgGivebackPct >= 14;
  const preferEarlierTrailArm =
    preferTightenGiveback ||
    (avgExitQuality != null && avgExitQuality < 42);
  const preferTighterTrail =
    preferTightenGiveback ||
    episodes.filter(
      (e) =>
        (e.maxRunupPct || 0) >= 30 &&
        (e.exitUnrealizedPct || 0) < (e.maxRunupPct || 0) * 0.4
    ).length /
      n >=
      0.22;
  // Early stops with shallow MAE → fade threshold may be too tight (looser fade)
  const preferLooserFade = earlySlRate >= 0.2 && avgMaeAbs < 9;
  const nearMissRate =
    episodes.filter((e) => e.peakProtectNearMiss === true).length / n;
  const looserScratchRate =
    episodes.filter(
      (e) =>
        (e.givebackFromPeakPct || 0) < 6 &&
        (e.maxRunupPct || 0) >= 12 &&
        (e.pnlPct || 0) > 0 &&
        (e.pnlPct || 0) < (e.maxRunupPct || 0) * 0.55
    ).length / n;
  const preferLoosenGiveback =
    !preferTightenGiveback && looserScratchRate >= 0.2;
  const preferLaterArm =
    nearMissRate >= 0.15 ||
    episodes.filter((e) => e.cfLaterArmBetter === true).length / n >= 0.18;
  const preferSkipPartial =
    episodes.filter((e) => e.cfSkipPartialBetter === true).length / n >= 0.15 ||
    (episodes.filter((e) => e.pclPartialTaken === true).length / n >= 0.2 &&
      episodes.filter(
        (e) =>
          e.pclPartialTaken === true &&
          (e.pclPostPartialMfePct == null || e.pclPostPartialMfePct < 2) &&
          (e.givebackFromPeakPct || 0) >= 8
      ).length /
        Math.max(
          1,
          episodes.filter((e) => e.pclPartialTaken === true).length
        ) >=
        0.4);

  return {
    n,
    avgGivebackPct,
    largeGivebackRate,
    deadMarketShare,
    deadMarketAvgPnl,
    earlySlRate,
    normalSlRate,
    avgMaeAbs,
    avgEntryQuality,
    avgExitQuality,
    preferTightenGiveback,
    preferLoosenGiveback,
    preferLaterArm,
    preferSkipPartial,
    preferTighterTrail,
    preferLooserFade,
    preferEarlierTrailArm,
  };
}

/**
 * Timing-only micro deltas (±3–5%): trail tighten, momentum fade, trail arm.
 * Never emits takeProfitPct* / stopLossPct*.
 */
export function buildTimingLearningCandidates(
  episodes: ProfileLearningEpisode[],
  current: {
    trailTightenFactor: number;
    momentumFadeDropPct: number;
    trailingActivationProfit: number;
    peakProtectArmOfTpPct?: number;
    peakProtectGivebackOfPeakPct?: number;
  },
  soft?: SoftExitFeedbackReport | null
): Array<{ summary: string; patch: LearningProposalPatch }> {
  const out: Array<{ summary: string; patch: LearningProposalPatch }> = [];
  if (episodes.length < 6) return out;

  const fb = soft || buildSoftExitFeedback(episodes);
  const leftOnTable =
    episodes.filter(
      (e) =>
        (e.maxRunupPct || 0) >= 30 &&
        (e.exitUnrealizedPct || 0) < (e.maxRunupPct || 0) * 0.4
    ).length / episodes.length;

  if (fb.preferTighterTrail || leftOnTable >= 0.22) {
    const next = clamp(current.trailTightenFactor * 0.95, 0.4, 1);
    if (Math.abs(next - current.trailTightenFactor) >= 0.01) {
      out.push({
        summary: `Timing: tighten trail after profit ${current.trailTightenFactor.toFixed(2)}→${next.toFixed(2)} (giveback/MFE leave-on-table)`,
        patch: {
          exitRules: {
            exitPolicy: { trailTightenFactor: next },
          },
        },
      });
    }
  }

  if (fb.preferEarlierTrailArm || leftOnTable >= 0.25) {
    const next = clamp(
      Math.round(current.trailingActivationProfit * 0.95),
      3,
      80
    );
    if (next !== Math.round(current.trailingActivationProfit)) {
      out.push({
        summary: `Timing: arm trail earlier ${current.trailingActivationProfit}→${next}% after green`,
        patch: {
          exitRules: { trailingActivationProfit: next },
        },
      });
    }
  }

  if (fb.preferLooserFade && current.momentumFadeDropPct > 0) {
    const next = clamp(
      Number((current.momentumFadeDropPct * 1.05).toFixed(2)),
      3,
      25
    );
    if (next > current.momentumFadeDropPct + 0.05) {
      out.push({
        summary: `Timing: slightly looser momentum-fade ${current.momentumFadeDropPct}→${next}% (early-SL + shallow MAE)`,
        patch: {
          exitRules: {
            exitPolicy: { momentumFadeDropPct: next },
          },
        },
      });
    }
  } else if (
    !fb.preferLooserFade &&
    (fb.preferTighterTrail || leftOnTable >= 0.28) &&
    current.momentumFadeDropPct > 0
  ) {
    const next = clamp(
      Number((current.momentumFadeDropPct * 0.95).toFixed(2)),
      3,
      25
    );
    if (next < current.momentumFadeDropPct - 0.05) {
      out.push({
        summary: `Timing: slightly tighter momentum-fade ${current.momentumFadeDropPct}→${next}%`,
        patch: {
          exitRules: {
            exitPolicy: { momentumFadeDropPct: next },
          },
        },
      });
    }
  }

  // Peak Profit Protection — ±3–5% on arm % of TP / giveback % of peak only
  const pppLeft =
    episodes.filter((e) => e.peakProtectBeatFullTp === false).length /
    episodes.length;
  const pppBanked =
    episodes.filter((e) => e.peakProtectBeatFullTp === true).length /
    episodes.length;
  const pppExits =
    episodes.filter((e) =>
      /peak\s*protection/i.test(String(e.exitReason || ''))
    ).length / episodes.length;
  const curArm =
    current.peakProtectArmOfTpPct != null &&
    Number.isFinite(current.peakProtectArmOfTpPct) &&
    current.peakProtectArmOfTpPct > 0
      ? Number(current.peakProtectArmOfTpPct)
      : 50;
  const curGive =
    current.peakProtectGivebackOfPeakPct != null &&
    Number.isFinite(current.peakProtectGivebackOfPeakPct) &&
    current.peakProtectGivebackOfPeakPct > 0
      ? Number(current.peakProtectGivebackOfPeakPct)
      : 33;

  if (pppLeft >= 0.18 || (fb.preferTightenGiveback && pppExits >= 0.12)) {
    const nextGive = clamp(Math.round(curGive * 0.95), 10, 80);
    if (nextGive !== Math.round(curGive)) {
      out.push({
        summary: `Timing: tighten peak-protect giveback ${curGive}→${nextGive}% of peak`,
        patch: {
          exitRules: {
            exitPolicy: { peakProtectGivebackOfPeakPct: nextGive },
          },
        },
      });
    }
  } else if (fb.preferLoosenGiveback || (pppExits >= 0.28 && leftOnTable < 0.15)) {
    const nextGive = clamp(Math.round(curGive * 1.05), 10, 80);
    if (nextGive !== Math.round(curGive)) {
      out.push({
        summary: `Timing: slightly looser peak-protect giveback ${curGive}→${nextGive}% of peak`,
        patch: {
          exitRules: {
            exitPolicy: { peakProtectGivebackOfPeakPct: nextGive },
          },
        },
      });
    }
  } else if (pppBanked >= 0.2 && pppExits >= 0.15 && !fb.preferLaterArm) {
    const nextArm = clamp(Math.round(curArm * 0.95), 10, 95);
    if (nextArm !== Math.round(curArm)) {
      out.push({
        summary: `Timing: arm peak-protect earlier ${curArm}→${nextArm}% of TP`,
        patch: {
          exitRules: {
            exitPolicy: { peakProtectArmOfTpPct: nextArm },
          },
        },
      });
    }
  } else if (fb.preferLaterArm) {
    const nextArm = clamp(Math.round(curArm * 1.05), 10, 95);
    if (nextArm !== Math.round(curArm)) {
      out.push({
        summary: `Timing: arm peak-protect later ${curArm}→${nextArm}% of TP`,
        patch: {
          exitRules: {
            exitPolicy: { peakProtectArmOfTpPct: nextArm },
          },
        },
      });
    }
  }

  // Profit Capture Layer harvest film → bounded permission / early-partial nudges
  const n = episodes.length;
  const partialRate =
    episodes.filter((e) => e.pclPartialTaken === true).length / n;
  const permExitRate =
    episodes.filter((e) => e.exitedDuringPermission === true).length / n;
  const deferredArmRate =
    episodes.filter((e) => e.pclPppArmDeferred === true).length / n;
  const scratchBlocked =
    episodes.reduce((s, e) => s + (Number(e.pclScratchBlockedCount) || 0), 0) /
    n;
  const familyCounts = {
    fast: 0,
    dip_trend: 0,
    quality: 0,
    default: 0,
  };
  for (const e of episodes) {
    const f = e.pclFamily || 'default';
    if (f in familyCounts) familyCounts[f as keyof typeof familyCounts] += 1;
  }
  const dominantFamily = (
    Object.entries(familyCounts).sort((a, b) => b[1] - a[1])[0] || [
      'default',
      0,
    ]
  )[0] as 'fast' | 'dip_trend' | 'quality' | 'default';

  if (permExitRate >= 0.18 || scratchBlocked >= 0.4) {
    const basePerm =
      dominantFamily === 'fast'
        ? 35
        : dominantFamily === 'dip_trend'
          ? 120
          : dominantFamily === 'quality'
            ? 90
            : 60;
    const nextPerm = clamp(Math.round(basePerm * 1.1), 20, 180);
    if (dominantFamily !== 'default') {
      out.push({
        summary: `Timing: lengthen PCL ${dominantFamily} permission → ${nextPerm}s (permission exits / scratch blocks)`,
        patch: {
          pclFamilyOverride: {
            family: dominantFamily,
            permissionSec: nextPerm,
          },
        },
      });
    }
  }

  const earlyPartialHint = episodes
    .map((e) => e.pclPartialAtPct)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const avgPartialAt = earlyPartialHint.length
    ? earlyPartialHint.reduce((a, b) => a + b, 0) / earlyPartialHint.length
    : null;

  if (
    fb.preferSkipPartial ||
    (partialRate >= 0.25 &&
      episodes.filter(
        (e) =>
          e.pclPartialTaken === true &&
          (e.pclPostPartialMfePct == null || Number(e.pclPostPartialMfePct) < 2)
      ).length /
        Math.max(1, episodes.filter((e) => e.pclPartialTaken === true).length) >=
        0.35)
  ) {
    const nextPartial = clampLearnedEarlyPartial(
      dominantFamily === 'fast' ? 'migration_sniper' : '',
      clamp(
        Math.round((avgPartialAt != null ? avgPartialAt : 15) * 1.08),
        8,
        60
      )
    );
    out.push({
      summary: `Timing: delay early partial → ${nextPartial}% (skip/weak post-partial MFE)`,
      patch: {
        exitRules: {
          exitPolicy: { earlyPartialTpPct: nextPartial },
        },
        ...(dominantFamily !== 'default'
          ? {
              pclFamilyOverride: {
                family: dominantFamily as 'fast' | 'dip_trend' | 'quality',
                earlyPartialTpPct: nextPartial,
              },
            }
          : {}),
      },
    });
  } else if (
    partialRate < 0.12 &&
    leftOnTable >= 0.2 &&
    episodes.filter((e) => (e.maxRunupPct || 0) >= 20).length / n >= 0.25
  ) {
    const nextPartial = clampLearnedEarlyPartial(
      dominantFamily === 'fast' ? 'migration_sniper' : '',
      clamp(
        Math.round((avgPartialAt != null ? avgPartialAt : 18) * 0.92),
        8,
        50
      )
    );
    out.push({
      summary: `Timing: earlier early partial → ${nextPartial}% (low partial rate + leave-on-table)`,
      patch: {
        exitRules: {
          exitPolicy: { earlyPartialTpPct: nextPartial },
        },
      },
    });
  }

  if (deferredArmRate >= 0.25 && fb.preferLaterArm) {
    const nextArm = clamp(Math.round(curArm * 1.04), 10, 95);
    if (nextArm !== Math.round(curArm)) {
      out.push({
        summary: `Timing: later peak-protect arm ${curArm}→${nextArm}% (deferred arm + CF)`,
        patch: {
          exitRules: {
            exitPolicy: { peakProtectArmOfTpPct: nextArm },
          },
        },
      });
    }
  }

  return out.slice(0, 5);
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
  if (loserRate < 0.32) return out;

  // Failure-category: weak_entry pattern
  const weakEntries = losers.filter((e) => e.failureCategory === 'weak_entry');
  if (weakEntries.length / Math.max(1, losers.length) >= 0.18) {
    out.push({
      summary: `Weak-entry pattern (${weakEntries.length}/${losers.length}) — raise conviction + wallet quality`,
      patch: {
        match: {
          minConviction: clamp(
            Math.max(Number(currentMatch.minConviction) || 40, 40) + 8, 30, 85
          ),
          minWalletQuality: clamp(
            Math.max(Number(currentMatch.minWalletQuality) || 35, 35) + 5, 25, 85
          ),
        },
      },
    });
  }

  const lowConvLosers = losers.filter(
    (e) => e.convictionScore != null && e.convictionScore < 45
  ).length;
  if (lowConvLosers / Math.max(1, losers.length) >= 0.32) {
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
    lowWallets / Math.max(1, losers.length) >= 0.28
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
    loserRate >= 0.45
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

  // Raise Min token age: young losers vs older winners
  const aged = episodes.filter(
    (e) =>
      e.tokenAgeHoursAtEntry != null &&
      Number.isFinite(e.tokenAgeHoursAtEntry)
  );
  if (aged.length >= 6) {
    const youngLosers = losers.filter(
      (e) =>
        e.tokenAgeHoursAtEntry != null &&
        Number.isFinite(e.tokenAgeHoursAtEntry) &&
        Number(e.tokenAgeHoursAtEntry) < 2
    );
    const winners = episodes.filter((e) => (e.pnlPct || 0) > 0);
    const winnerAges = winners
      .map((e) => Number(e.tokenAgeHoursAtEntry))
      .filter((n) => Number.isFinite(n));
    const medianWinAge =
      winnerAges.length >= 3
        ? [...winnerAges].sort((a, b) => a - b)[
            Math.floor(winnerAges.length / 2)
          ]
        : null;
    if (
      youngLosers.length / Math.max(1, losers.length) >= 0.28 &&
      (medianWinAge == null || medianWinAge >= 1.5)
    ) {
      const cat =
        currentMatch.minTokenAgeHours != null &&
        Number.isFinite(Number(currentMatch.minTokenAgeHours))
          ? Number(currentMatch.minTokenAgeHours)
          : 0;
      const next = clamp(Math.max(cat, 2) + (cat >= 2 ? 1 : 0), 0, 24);
      if (next > cat + 0.01) {
        out.push({
          summary: `Raise min token age → ${next}h (young losers ${youngLosers.length}/${losers.length})`,
          patch: { match: { minTokenAgeHours: next } },
        });
      }
    }
  }

  const armedZeroMfe = losers.filter(
    (e) =>
      e.zeroMfeAfterArmedOpen === true ||
      ((e.armedWatch === true || e.entryPath === 'armed_trigger') &&
        (Number(e.maxRunupPct) || 0) <= 0.05)
  ).length;
  if (
    armedZeroMfe / Math.max(1, losers.length) >= 0.22 &&
    (profileId === 'dip_buyer' ||
      profileId === 'trend_rider' ||
      profileId === 'steady_compounder' ||
      profileId === 'high_win_rate' ||
      profileId === 'scalper')
  ) {
    const cur = Number(currentMatch.minTaPlaybookConfluences);
    const base = Number.isFinite(cur) ? cur : 1;
    const next = clamp(base + 1, 0, 4);
    if (next > base) {
      out.push({
        summary: `Raise min TA playbook confluences → ${next} (armed zero-MFE)`,
        patch: { match: { minTaPlaybookConfluences: next } },
      });
    }
  }

  // Small loosen entry deltas when evidence supports (healthy WR, floors too tight)
  const winners = episodes.filter((e) => (e.pnlPct || 0) > 0);
  const winRate = winners.length / Math.max(1, episodes.length);
  if (episodes.length >= 12 && winRate >= 0.58 && loserRate <= 0.35) {
    const convWins = winners
      .map((e) => Number(e.convictionScore))
      .filter((n) => Number.isFinite(n));
    const curConv = Number(currentMatch.minConviction) || 0;
    if (convWins.length >= 5 && curConv >= 40) {
      const medianWinConv = [...convWins].sort((a, b) => a - b)[
        Math.floor(convWins.length / 2)
      ];
      if (medianWinConv + 8 < curConv) {
        const next = clamp(curConv - 3, 30, 85);
        if (next < curConv - 0.5) {
          out.push({
            summary: `Loosen min conviction → ${next} (winners median ${medianWinConv.toFixed(0)})`,
            patch: { match: { minConviction: next } },
          });
        }
      }
    }
    const wqWins = winners
      .map((e) => Number((e as { walletQuality?: number }).walletQuality))
      .filter((n) => Number.isFinite(n));
    // Prefer walletCount signal when WQ not on episode: loosen cluster if many 1-wallet winners
    const curWallets = Number(currentMatch.minWalletCount) || 1;
    if (curWallets >= 2) {
      const oneWalletWins = winners.filter(
        (e) => e.walletCount != null && Number(e.walletCount) <= 1
      ).length;
      if (oneWalletWins / Math.max(1, winners.length) >= 0.35) {
        out.push({
          summary: `Loosen cluster floor → ${curWallets - 1} (many 1-wallet winners)`,
          patch: { match: { minWalletCount: curWallets - 1 } },
        });
      }
    }
    void wqWins;
  }

  return out.slice(0, 3);
}

const FAST_LEARN_EARLY_PARTIAL_MAX = 10;

function isFastFamilyProfileId(profileId: string | null | undefined): boolean {
  const id = String(profileId || '');
  return (
    id === 'migration_sniper' ||
    id === 'scalper' ||
    id === 'reversal_scalper' ||
    id === 'momentum_burst'
  );
}

function clampLearnedEarlyPartial(
  profileId: string | null | undefined,
  next: number
): number {
  if (isFastFamilyProfileId(profileId)) {
    return Math.min(next, FAST_LEARN_EARLY_PARTIAL_MAX);
  }
  return next;
}

/** Clamp a numeric patch to catalog ±5% (with absolute safety band). */
function clampDeltaPct(
  proposed: number,
  catalog: number,
  absLo: number,
  absHi: number,
  pctBand = 0.05
): number {
  const cat = Number.isFinite(catalog) ? catalog : proposed;
  const lo = Math.min(cat * (1 - pctBand), cat - Math.abs(cat) * pctBand);
  const hi = Math.max(cat * (1 + pctBand), cat + Math.abs(cat) * pctBand);
  return clamp(proposed, Math.max(absLo, lo), Math.min(absHi, hi));
}

/** Clamp learning patches to tight ±5% / small-step bands vs catalog. */
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
    const cat = catalogExit.sizeMultiplier ?? 1;
    exitRules.sizeMultiplier = clampDeltaPct(
      Number(exitRules.sizeMultiplier),
      cat,
      0.4,
      1.2
    );
  }
  if (exitRules.hardTimeLimitSecMax != null) {
    const catMax = catalogExit.hardTimeLimitSecMax ?? 600;
    exitRules.hardTimeLimitSecMax = clampDeltaPct(
      Number(exitRules.hardTimeLimitSecMax),
      catMax,
      Math.max(40, catMax * 0.5),
      catMax * 1.6
    );
  }
  if (exitRules.stopLossPctMax != null) {
    const cat = Math.abs(catalogExit.stopLossPctMax ?? 14);
    exitRules.stopLossPctMax = clampDeltaPct(
      Number(exitRules.stopLossPctMax),
      cat,
      cat * 0.7,
      cat * 1.5
    );
  }
  if (exitRules.takeProfitPctMin != null) {
    const cat = catalogExit.takeProfitPctMin ?? 15;
    exitRules.takeProfitPctMin = clampDeltaPct(
      Number(exitRules.takeProfitPctMin),
      cat,
      cat * 0.5,
      cat * 1.4
    );
  }

  const ep = exitRules.exitPolicy;
  if (ep) {
    const catPol = catalogExit.exitPolicy || {};
    if (ep.profitLockArmPct != null) {
      ep.profitLockArmPct = clampDeltaPct(
        Number(ep.profitLockArmPct),
        Number(catPol.profitLockArmPct) || 40,
        12,
        100
      );
    }
    if (ep.profitGivebackPts != null) {
      ep.profitGivebackPts = clampDeltaPct(
        Number(ep.profitGivebackPts),
        Number(catPol.profitGivebackPts) || 25,
        6,
        55
      );
    }
    if (ep.profitFloorPct != null) {
      ep.profitFloorPct = clampDeltaPct(
        Number(ep.profitFloorPct),
        Number(catPol.profitFloorPct) || 0,
        0,
        60
      );
    }
    if (ep.earlyPartialTpPct != null) {
      ep.earlyPartialTpPct = clampLearnedEarlyPartial(
        profileId,
        clampDeltaPct(
          Number(ep.earlyPartialTpPct),
          Number(catPol.earlyPartialTpPct) || 15,
          0,
          80
        )
      );
    }
    if (ep.earlyPartialFraction != null) {
      ep.earlyPartialFraction = clampDeltaPct(
        Number(ep.earlyPartialFraction),
        Number(catPol.earlyPartialFraction) || 0.4,
        0.2,
        0.6
      );
    }
    if (ep.trailTightenFactor != null) {
      ep.trailTightenFactor = clampDeltaPct(
        Number(ep.trailTightenFactor),
        Number(catPol.trailTightenFactor) || 0.85,
        0.4,
        1
      );
    }
    if (ep.momentumFadeDropPct != null) {
      ep.momentumFadeDropPct = clampDeltaPct(
        Number(ep.momentumFadeDropPct),
        Number(catPol.momentumFadeDropPct) || 8,
        3,
        25
      );
    }
    if (ep.peakProtectArmOfTpPct != null) {
      ep.peakProtectArmOfTpPct = clampDeltaPct(
        Number(ep.peakProtectArmOfTpPct),
        Number(catPol.peakProtectArmOfTpPct) || 50,
        10,
        95
      );
    }
    if (ep.peakProtectGivebackOfPeakPct != null) {
      ep.peakProtectGivebackOfPeakPct = clampDeltaPct(
        Number(ep.peakProtectGivebackOfPeakPct),
        Number(catPol.peakProtectGivebackOfPeakPct) || 33,
        10,
        80
      );
    }
    exitRules.exitPolicy = ep;
  }

  if (exitRules.trailingActivationProfit != null) {
    const cat = catalogExit.trailingActivationProfit ?? 12;
    exitRules.trailingActivationProfit = clampDeltaPct(
      Number(exitRules.trailingActivationProfit),
      cat,
      3,
      80
    );
  }

  if (match.minConviction != null) {
    const cat = catalogMatch.minConviction ?? 40;
    // Small step: ±5 points from catalog, within absolute band
    const absLo = SCALP_PROFILES.has(profileId) ? Math.min(25, cat - 10) : Math.max(30, cat - 8);
    match.minConviction = clamp(
      Number(match.minConviction),
      Math.max(absLo, cat - 5),
      Math.min(90, cat + 5)
    );
  }
  if (match.minWalletQuality != null) {
    const cat = catalogMatch.minWalletQuality ?? (SCALP_PROFILES.has(profileId) ? 35 : 45);
    const absLo = SCALP_PROFILES.has(profileId) ? 25 : 35;
    match.minWalletQuality = clamp(
      Number(match.minWalletQuality),
      Math.max(absLo, cat - 5),
      Math.min(85, cat + 5)
    );
  }
  if (match.minWalletCount != null) {
    const cat = catalogMatch.minWalletCount ?? 1;
    match.minWalletCount = clamp(
      Number(match.minWalletCount),
      Math.max(1, cat - 1),
      Math.min(5, cat + 1)
    );
  }
  if (match.minTokenAgeHours != null) {
    const cat =
      catalogMatch.minTokenAgeHours != null &&
      Number.isFinite(catalogMatch.minTokenAgeHours)
        ? Number(catalogMatch.minTokenAgeHours)
        : 0;
    const n = Number(match.minTokenAgeHours);
    if (Number.isFinite(n)) {
      // Allow small loosen (down to 80% of catalog) or tighten (+20% / +1h)
      const lo = cat > 0 ? Math.max(0, cat * 0.8) : 0;
      const hi = cat > 0 ? Math.min(48, Math.max(cat + 1, cat * 1.2)) : 48;
      match.minTokenAgeHours = clamp(n, lo, hi);
    } else {
      delete match.minTokenAgeHours;
    }
  }

  if (match.minTaPlaybookConfluences != null) {
    const cat = Number(catalogMatch.minTaPlaybookConfluences);
    const base = Number.isFinite(cat) ? cat : 0;
    match.minTaPlaybookConfluences = clamp(
      Math.round(Number(match.minTaPlaybookConfluences)),
      Math.max(0, base - 1),
      Math.min(4, base + 1)
    );
  }

  let pclFamilyOverride = patch.pclFamilyOverride;
  if (pclFamilyOverride) {
    const fam = pclFamilyOverride.family;
    if (fam !== 'fast' && fam !== 'dip_trend' && fam !== 'quality') {
      pclFamilyOverride = undefined;
    } else {
      const next: NonNullable<LearningProposalPatch['pclFamilyOverride']> = {
        family: fam,
      };
      if (pclFamilyOverride.permissionSec != null) {
        next.permissionSec = clamp(
          Math.round(Number(pclFamilyOverride.permissionSec)),
          20,
          180
        );
      }
      if (pclFamilyOverride.earlyPartialTpPct != null) {
        const raw = clamp(
          Math.round(Number(pclFamilyOverride.earlyPartialTpPct)),
          8,
          60
        );
        next.earlyPartialTpPct =
          fam === 'fast' ? Math.min(raw, FAST_LEARN_EARLY_PARTIAL_MAX) : raw;
      }
      pclFamilyOverride =
        next.permissionSec != null || next.earlyPartialTpPct != null
          ? next
          : undefined;
    }
  }

  return {
    exitRules: Object.keys(exitRules).length ? exitRules : undefined,
    match: Object.keys(match).length ? match : undefined,
    pclFamilyOverride,
  };
}

export function refreshSelfLearnMetrics(
  state: ProfileSelfLearningState,
  profileId: string
): ProfileSelfLearningState {
  const next = { ...state };
  const exp = getProfileEpisodeExpectancy(profileId, { lastN: LEARNING_SCORE_WINDOW });
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
 * `applyKind`: full Level upgrade vs continuous micro tweak (no Level bump).
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
  applyKind?: 'upgrade' | 'micro';
  rollback?: boolean;
} {
  let state = normalizeSelfLearning(input.state);
  if (!state.enabled) {
    return { state };
  }

  const episodes = getProfileLearningEpisodes(input.profileId, 120);
  state = refreshSelfLearnMetrics(state, input.profileId);

  const microEveryBase = state.microEveryTrades || 4;
  // Denser exit-policy micro for PPP/PCL harvest when enough film exists
  const harvestFilmN = episodes.filter(
    (e) =>
      e.pclPartialTaken === true ||
      e.peakProtectArmed === true ||
      e.peakProtectNearMiss === true ||
      e.exitedDuringPermission === true ||
      e.pclPppArmDeferred === true ||
      e.peakProtectBeatFullTp != null
  ).length;
  const harvestDense = episodes.length >= 6 && harvestFilmN >= 4;
  const microEvery = harvestDense
    ? Math.min(microEveryBase, 3)
    : microEveryBase;
  state.nextEligibleIn = Math.max(0, microEvery - (state.tradesSinceMicro || 0));

  // Rollback check: post-upgrade window (~12 trades) worse than previous score
  if (
    state.version > 0 &&
    state.tradesSinceUpgrade >= Math.max(12, state.upgradeCooldownTrades) &&
    state.history.length > 0
  ) {
    const last = state.history[state.history.length - 1];
    if (!last.rolledBack) {
      const recent = getProfileLearningEpisodes(input.profileId, 80).filter(
        (e) => e.paramVersion === state.version
      );
      const needTrades = Math.max(
        12,
        Math.floor(state.upgradeCooldownTrades * 0.75)
      );
      if (recent.length >= needTrades) {
        const after = scoreEpisodesHeuristic(recent);
        const lastSource = state.lastMutation?.source;
        const margin =
          lastSource === 'ml' || lastSource === 'hybrid' ? 1.5 : 2.5;
        if (after < last.scoreBefore - margin) {
          state.pendingProposal = null;
          try {
            const { appendLearningSave } =
              require('./profileLearningSaveLog') as typeof import('./profileLearningSaveLog');
            appendLearningSave({
              profileId: input.profileId,
              kind: 'rollback',
              summary: `Auto-rollback v${state.version}: score ${after.toFixed(1)} < ${last.scoreBefore.toFixed(1)} − ${margin} after ${recent.length} trades`,
              version: state.version,
              episodeCount: recent.length,
            });
          } catch {
            /* optional */
          }
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
    state.nearMiss = null;
    return { state };
  }

  const confidence = learningSampleConfidence(episodes.length);
  if (!confidence.allowExit && !confidence.allowEntry) {
    return { state };
  }

  const inUpgradeCooldown =
    state.tradesSinceUpgrade < state.upgradeCooldownTrades && state.version > 0;

  const pol = input.currentExit.exitPolicy || {};
  const currentPolicy = {
    profitLockArmPct: Number(pol.profitLockArmPct) || 40,
    profitGivebackPts: Number(pol.profitGivebackPts) || 25,
    profitFloorPct: Number(pol.profitFloorPct) || 0,
    earlyPartialTpPct: Number(pol.earlyPartialTpPct) || 15,
    earlyPartialFraction: Number(pol.earlyPartialFraction) || 0.4,
    momentumFadeDropPct: Number(pol.momentumFadeDropPct) || 8,
    hardTimeLimitSecMax: input.currentExit.hardTimeLimitSecMax,
    heikinAshiExitEnabled: pol.heikinAshiExitEnabled === true,
    trailTightenFactor: Number(pol.trailTightenFactor) || 0.85,
    trailingActivationProfit:
      Number(input.currentExit.trailingActivationProfit) || 12,
    peakProtectArmOfTpPct: Number(pol.peakProtectArmOfTpPct) || 0,
    peakProtectGivebackOfPeakPct:
      Number(pol.peakProtectGivebackOfPeakPct) || 0,
  };

  // Global Micro-Bot TP: skip exit delta learning only; entry continues
  let allowExitDeltas = confidence.allowExit;
  try {
    const { getGlobalMicroBotTakeProfitPct } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    if (getGlobalMicroBotTakeProfitPct() != null) {
      allowExitDeltas = false;
    }
  } catch {
    /* ignore */
  }

  const softExit = buildSoftExitFeedback(episodes);
  let craftHints: {
    harvestDelta: number | null;
    exitsDelta: number | null;
    craftDelta: number | null;
    trend: string;
    summary: string;
  } = {
    harvestDelta: null,
    exitsDelta: null,
    craftDelta: null,
    trend: 'stable',
    summary: '',
  };
  try {
    const { craftLearningHints } =
      require('./tradeCraftPerformance') as typeof import('./tradeCraftPerformance');
    const h = craftLearningHints(episodes.slice(-LEARNING_SCORE_WINDOW));
    craftHints = {
      harvestDelta: h.harvestDelta,
      exitsDelta: h.exitsDelta,
      craftDelta: h.craftDelta,
      trend: h.trend,
      summary: h.summary,
    };
  } catch {
    /* craft optional */
  }
  let accelSoftExit = softExit;
  try {
    const { applyReplayBatchHints } =
      require('./learningReplayBuffer') as typeof import('./learningReplayBuffer');
    const { refreshCounterfactualHints } =
      require('./learningCounterfactual') as typeof import('./learningCounterfactual');
    const { getTeacherStudentHints } =
      require('./learningTeacherStudent') as typeof import('./learningTeacherStudent');
    const replay = applyReplayBatchHints(input.profileId);
    const cf = refreshCounterfactualHints(input.profileId, episodes);
    const ts = getTeacherStudentHints(input.profileId);
    if (replay || cf?.summary || ts) {
      accelSoftExit = {
        ...softExit,
        preferTightenGiveback:
          softExit.preferTightenGiveback ||
          replay?.preferTightenGiveback ||
          cf?.preferTightenGiveback ||
          ts?.preferTightenGiveback ||
          false,
        preferLoosenGiveback:
          softExit.preferLoosenGiveback ||
          cf?.preferLoosenGiveback ||
          false,
        preferLaterArm:
          softExit.preferLaterArm || cf?.preferLaterArm || false,
        preferSkipPartial:
          softExit.preferSkipPartial || cf?.preferSkipPartial || false,
        preferTighterTrail:
          softExit.preferTighterTrail ||
          replay?.preferTighterTrail ||
          cf?.preferTighterTrail ||
          ts?.preferTighterTrail ||
          false,
        preferEarlierTrailArm:
          softExit.preferEarlierTrailArm ||
          cf?.preferEarlierTp ||
          false,
      };
    }
  } catch {
    /* accelerators optional */
  }
  if (accelSoftExit.n >= 6) {
    console.log(
      `[learning-exit-feedback] ${input.profileId} n=${softExit.n} ` +
        `giveback=${softExit.avgGivebackPct.toFixed(1)} large=${(softExit.largeGivebackRate * 100).toFixed(0)}% ` +
        `dead=${(softExit.deadMarketShare * 100).toFixed(0)}%/${softExit.deadMarketAvgPnl.toFixed(1)}% ` +
        `earlySl=${(softExit.earlySlRate * 100).toFixed(0)}% maeAbs=${softExit.avgMaeAbs.toFixed(1)} ` +
        `entryQ=${softExit.avgEntryQuality != null ? softExit.avgEntryQuality.toFixed(0) : 'n/a'} ` +
        `exitQ=${softExit.avgExitQuality != null ? softExit.avgExitQuality.toFixed(0) : 'n/a'}`
    );
  }

  const candidates = [
    ...(allowExitDeltas
      ? buildExitLearningCandidates(input.profileId, episodes, currentPolicy)
      : []),
    ...(allowExitDeltas
      ? buildTimingLearningCandidates(episodes, currentPolicy, accelSoftExit)
      : []),
    ...(confidence.allowEntry
      ? buildEntryLearningCandidates(
          input.profileId,
          episodes,
          input.currentMatch
        )
      : []),
  ] as Array<{ summary: string; patch: LearningProposalPatch }>;

  // Auto-promote ML mode (shadow→hybrid→lead) before lead candidates / scoring
  try {
    const mlMod = require('./profileLearningMl') as typeof import('./profileLearningMl');
    const model = mlMod.maybeRetrainProfileMl(input.profileId);
    const stale = mlMod.isModelStale(model, episodes.length);
    const advanced = mlMod.maybeAutoAdvanceMlMode({
      enabled: state.enabled,
      mlMode: state.mlMode,
      mlValidatedInPaper: state.mlValidatedInPaper,
      level: state.version,
      episodeCount: episodes.length,
      holdoutAuc: model?.holdoutAuc ?? 0,
      hasModel: !!model,
      stale,
    });
    if (advanced) {
      state.mlMode = advanced.mlMode;
      state.mlModeSource = 'auto';
      console.log(
        `[learning-ml] ${input.profileId} ${advanced.from}→${advanced.mlMode} (${advanced.reason})`
      );
      try {
        const { appendLearningSave } =
          require('./profileLearningSaveLog') as typeof import('./profileLearningSaveLog');
        appendLearningSave({
          profileId: input.profileId,
          kind: 'toggle',
          summary: `ML auto ${advanced.from}→${advanced.mlMode} (${advanced.reason})`,
          version: state.version,
        });
      } catch {
        /* optional */
      }
    }
    if (state.mlMode === 'lead' && allowExitDeltas) {
      candidates.push(
        ...mlMod.buildMlLedCandidates(episodes, {
          ...currentPolicy,
          minConviction: Number(input.currentMatch.minConviction) || 40,
        })
      );
    }
  } catch {
    /* ML optional */
  }

  const window = episodes.slice(-LEARNING_SCORE_WINDOW);
  const scoreBefore = scoreEpisodesHeuristic(window);
  const mlCurrent = {
    profitGivebackPts: currentPolicy.profitGivebackPts,
    profitLockArmPct: currentPolicy.profitLockArmPct,
    earlyPartialTpPct: currentPolicy.earlyPartialTpPct,
    minConviction: Number(input.currentMatch.minConviction) || 40,
    hardTimeLimitSecMax: currentPolicy.hardTimeLimitSecMax,
    peakProtectArmOfTpPct: currentPolicy.peakProtectArmOfTpPct,
    peakProtectGivebackOfPeakPct: currentPolicy.peakProtectGivebackOfPeakPct,
  };

  let mlAdvice: import('./profileLearningMl').MlAdvice | null = null;
  try {
    const mlMod = require('./profileLearningMl') as typeof import('./profileLearningMl');
    mlAdvice = mlMod.buildMlAdvice(input.profileId, window, candidates, {
      mlMode: state.mlMode,
      current: mlCurrent,
    });
  } catch {
    mlAdvice = null;
  }
  state.mlAdvice = mlAdvice;
  if (
    mlAdvice &&
    !mlAdvice.stale &&
    mlAdvice.holdoutAuc >= 0.58 &&
    mlAdvice.nTrain >= 80
  ) {
    state.mlValidatedInPaper = true;
  }

  let best: LearningProposal | null = null;
  let nearMiss: SelfLearnNearMiss | null = null;
  let bestNearProposal: LearningProposal | null = null;

  for (const c of candidates) {
    const isMlLed = /^ML-led:/i.test(c.summary);
    let nudge = confidence.nudgeScale;
    // Source-aware tighter scale for ML/hybrid until large sample
    if (isMlLed || state.mlMode === 'hybrid' || state.mlMode === 'lead') {
      if (episodes.length < 150) nudge = Math.min(nudge, confidence.nudgeScale * 0.5);
    }
    const scaled = scaleLearningPatch(c.patch, nudge);
    // Timing candidates stay milder until Level upgrades prove out
    const timingMild = /^Timing:/i.test(c.summary);
    const scaledFinal = timingMild
      ? scaleLearningPatch(scaled, Math.min(nudge, 0.45))
      : scaled;
    const clamped = clampLearningPatch(
      input.profileId,
      input.catalogExit,
      input.catalogMatch,
      scaledFinal
    );
    if (!clamped.exitRules && !clamped.match && !clamped.pclFamilyOverride) continue;

    const hAfter = shadowScoreCandidate(window, clamped, scoreBefore);
    let hDelta = hAfter - scoreBefore;
    // Soft exit-feedback weights only (does not write patches by itself)
    const sum = String(c.summary || '');
    if (softExit.preferTightenGiveback && /giveback|profit-lock|partial|peak.?protect/i.test(sum)) {
      hDelta += 0.35;
    }
    if (accelSoftExit.preferTightenGiveback && !softExit.preferTightenGiveback && /giveback|peak.?protect/i.test(sum)) {
      hDelta += 0.2;
    }
    if (
      (softExit.preferLoosenGiveback || accelSoftExit.preferLoosenGiveback) &&
      /looser peak-protect|looser.*giveback/i.test(sum)
    ) {
      hDelta += 0.3;
    }
    if (
      (softExit.preferLaterArm || accelSoftExit.preferLaterArm) &&
      /later.*peak-protect|arm peak-protect later/i.test(sum)
    ) {
      hDelta += 0.3;
    }
    if (
      (softExit.preferSkipPartial || accelSoftExit.preferSkipPartial) &&
      /delay early partial|skip/i.test(sum)
    ) {
      hDelta += 0.28;
    }
    if (/PCL.*permission|early partial|peak-protect/i.test(sum) && harvestDense) {
      hDelta += 0.15;
    }
    if (softExit.preferTighterTrail && /tighten trail|momentum-fade.*tighter|Timing:/i.test(sum)) {
      hDelta += 0.3;
    }
    if (accelSoftExit.preferTighterTrail && !softExit.preferTighterTrail && /tighten|trail|Timing:/i.test(sum)) {
      hDelta += 0.15;
    }
    if (softExit.preferLooserFade && /looser momentum-fade/i.test(sum)) {
      hDelta += 0.25;
    }
    if (
      softExit.preferEarlierTrailArm &&
      /arm trail earlier/i.test(sum)
    ) {
      hDelta += 0.25;
    }
    if (
      softExit.avgEntryQuality != null &&
      softExit.avgEntryQuality < 40 &&
      clamped.match
    ) {
      hDelta += 0.2;
    }

    // Soft craft alignment (diagnostics → rank only; never hard Level margin)
    const harvestLike =
      /peak.?protect|PCL|giveback|early partial|Timing:|profit-lock|partial/i.test(
        sum
      );
    const exitsLike =
      /Timing:|trail|momentum-fade|hard.?SL|timer|fade/i.test(sum);
    const tightenLike =
      /tighten|earlier peak-protect|lengthen PCL|delay early partial/i.test(sum);
    const loosenLike =
      /looser peak-protect|looser.*giveback|arm peak-protect later/i.test(sum);
    const hDeltaCraft = craftHints.harvestDelta;
    const eDeltaCraft = craftHints.exitsDelta;
    if (hDeltaCraft != null && hDeltaCraft <= -4 && harvestLike) {
      if (tightenLike) hDelta += 0.32;
      else if (loosenLike) hDelta -= 0.22;
      else hDelta += 0.18;
    } else if (hDeltaCraft != null && hDeltaCraft >= 4 && harvestLike) {
      if (tightenLike || /PCL|peak.?protect|Timing:/i.test(sum)) hDelta += 0.15;
      if (loosenLike) hDelta -= 0.12;
    }
    if (eDeltaCraft != null && eDeltaCraft <= -4 && exitsLike) {
      if (/tighten|earlier|shorten/i.test(sum)) hDelta += 0.28;
      else if (/looser/i.test(sum)) hDelta -= 0.18;
      else hDelta += 0.14;
    } else if (eDeltaCraft != null && eDeltaCraft >= 4 && exitsLike) {
      hDelta += 0.12;
    }

    let mDelta = 0;
    let w = 0;
    let source: MutationSource = isMlLed ? 'ml' : 'heuristic';
    try {
      const mlMod = require('./profileLearningMl') as typeof import('./profileLearningMl');
      const scored = mlMod.scorePatchWithMl(
        input.profileId,
        window,
        clamped,
        { mlMode: state.mlMode, current: mlCurrent }
      );
      mDelta = scored.predictedDelta;
      w = scored.weight;
      if (w > 0.05 && !isMlLed) source = 'hybrid';
      if (isMlLed) source = 'ml';
    } catch {
      /* heuristic only */
    }

    const blendDelta = (1 - w) * hDelta + w * mDelta;
    const scoreAfter = scoreBefore + blendDelta;
    const scoreDelta = blendDelta;

    const proposal: LearningProposal = {
      at: Date.now(),
      summary:
        c.summary +
        (confidence.nudgeScale < 1
          ? ` (sample×${confidence.nudgeScale.toFixed(2)})`
          : '') +
        (w > 0.05 ? ` [blend w=${w.toFixed(2)}]` : ''),
      patch: clamped,
      scoreBefore,
      scoreAfter,
      kind:
        clamped.exitRules && clamped.match
          ? 'mixed'
          : clamped.exitRules || clamped.pclFamilyOverride
            ? 'exit'
            : 'entry',
      source,
      heuristicDelta: hDelta,
      mlDelta: mDelta,
      blendWeight: w,
    };

    if (!nearMiss || scoreDelta > nearMiss.scoreDelta) {
      nearMiss = {
        summary: proposal.summary,
        scoreBefore,
        scoreAfter,
        scoreDelta,
        scoreMargin: confidence.scoreMargin,
        needed: Math.max(0, confidence.scoreMargin - scoreDelta),
        patternHint: c.summary,
      };
      bestNearProposal = proposal;
    }

    // Soft pass on blended score
    if (scoreAfter >= scoreBefore + confidence.scoreMargin) {
      // Holdout gate for Level upgrades
      let holdoutOk = true;
      try {
        const mlMod = require('./profileLearningMl') as typeof import('./profileLearningMl');
        const gate = mlMod.holdoutPatchPasses(
          window,
          (eps) => scoreEpisodesHeuristic(eps),
          (eps) => shadowScoreCandidate(eps, clamped, scoreEpisodesHeuristic(eps))
        );
        holdoutOk = gate.ok;
      } catch {
        holdoutOk = true;
      }
      if (!holdoutOk) {
        // Keep as near-miss only — refuse Level++
        continue;
      }
      if (!best || scoreAfter > best.scoreAfter) {
        best = proposal;
      }
    }
  }

  state.nearMiss = nearMiss;

  // Full upgrade path (skip while in post-upgrade cooldown)
  if (best && !inUpgradeCooldown) {
    state.pendingProposal = best;
    state.nextEligibleIn = Math.max(
      0,
      microEvery - (state.tradesSinceMicro || 0)
    );
    if (/^Timing:/i.test(best.summary)) {
      console.log(
        `[learning-timing] ${input.profileId} propose: ${best.summary} ` +
          `Δ=${(best.scoreAfter - best.scoreBefore).toFixed(2)}`
      );
    }
    try {
      const { appendLearningSave } =
        require('./profileLearningSaveLog') as typeof import('./profileLearningSaveLog');
      appendLearningSave({
        profileId: input.profileId,
        kind: 'proposal',
        summary: `${state.mode === 'auto' ? 'Accept' : 'Propose'}: ${best.summary}`,
        version: state.version,
      });
    } catch {
      /* optional */
    }

    if (state.mode === 'auto') {
      return { state, applyPatch: best.patch, applyKind: 'upgrade' };
    }
    return { state };
  }

  // No full upgrade — clear stale proposal unless shadow still holding one that passed
  if (!best || inUpgradeCooldown) {
    if (!(state.mode === 'shadow' && state.pendingProposal && best)) {
      state.pendingProposal = inUpgradeCooldown ? state.pendingProposal : null;
    }
  }

  // Continuous micro-evolve (auto only): tiny nudge every N closes
  // When Global TP is on, still allow entry-only micro; skip if bestNear is exit-only
  const microDue = (state.tradesSinceMicro || 0) >= microEvery;
  const microAllow =
    confidence.allowExit || confidence.allowEntry;
  if (state.mode === 'auto' && microDue && microAllow && !best) {
    let microPatch: LearningProposalPatch | null = null;
    let microSummary = '';
    let microScoreAfter = scoreBefore;
    let microSource: MutationSource =
      bestNearProposal?.source || 'heuristic';

    if (bestNearProposal) {
      const harvestMicro =
        harvestDense &&
        /peak.?protect|PCL|early partial|giveback|Timing:/i.test(
          String(bestNearProposal.summary || '')
        );
      const microScaled = scaleLearningPatch(
        bestNearProposal.patch,
        Math.min(
          harvestMicro ? 0.28 : 0.4,
          confidence.nudgeScale * (harvestMicro ? 0.28 : 0.35)
        )
      );
      microPatch = clampLearningPatch(
        input.profileId,
        input.catalogExit,
        input.catalogMatch,
        microScaled
      );
      microSummary = bestNearProposal.summary.startsWith('Micro:')
        ? bestNearProposal.summary
        : `Micro: ${bestNearProposal.summary}`;
      if (
        microPatch.exitRules ||
        microPatch.match ||
        microPatch.pclFamilyOverride
      ) {
        microScoreAfter = shadowScoreCandidate(window, microPatch, scoreBefore);
        microSource = bestNearProposal.source || 'heuristic';
      } else {
        microPatch = null;
      }
    }

    if (!microPatch) {
      const mildPool = [
        ...buildTimingLearningCandidates(episodes, currentPolicy, accelSoftExit),
        ...buildExitLearningCandidates(
          input.profileId,
          episodes,
          currentPolicy
        ),
      ];
      const mild =
        (harvestDense
          ? mildPool.find((c) =>
              /peak.?protect|PCL|early partial|Timing:/i.test(c.summary)
            )
          : null) || mildPool.slice(-1)[0];
      if (mild) {
        const microScaled = scaleLearningPatch(
          mild.patch,
          Math.min(
            harvestDense ? 0.28 : 0.4,
            confidence.nudgeScale * (harvestDense ? 0.28 : 0.35)
          )
        );
        const clamped = clampLearningPatch(
          input.profileId,
          input.catalogExit,
          input.catalogMatch,
          microScaled
        );
        if (clamped.exitRules || clamped.match || clamped.pclFamilyOverride) {
          microPatch = clamped;
          microSummary = `Micro: ${mild.summary}`;
          microScoreAfter = shadowScoreCandidate(window, clamped, scoreBefore);
          microSource = 'heuristic';
        }
      }
    }

    if (microPatch) {
      if (/Timing:|peak.?protect|PCL|early partial/i.test(microSummary)) {
        console.log(
          `[learning-timing] ${input.profileId} micro: ${microSummary} ` +
            `Δ=${(microScoreAfter - scoreBefore).toFixed(2)}` +
            (harvestDense ? ' · harvest-dense' : '') +
            (craftHints.summary ? ` · ${craftHints.summary}` : '')
        );
      } else if (craftHints.summary) {
        console.log(
          `[learning-craft] ${input.profileId} micro: ${microSummary} · ${craftHints.summary}`
        );
      }
      state.pendingProposal = {
        at: Date.now(),
        summary: microSummary,
        patch: microPatch,
        scoreBefore,
        scoreAfter: microScoreAfter,
        kind:
          microPatch.exitRules && microPatch.match
            ? 'mixed'
            : microPatch.exitRules || microPatch.pclFamilyOverride
              ? 'exit'
              : 'entry',
        source: microSource,
      };
      state.nextEligibleIn = 0;
      return {
        state,
        applyPatch: microPatch,
        applyKind: 'micro',
      };
    }
  }

  state.nextEligibleIn = Math.max(0, microEvery - (state.tradesSinceMicro || 0));
  return { state };
}

export function applySelfLearnMicro(
  state: ProfileSelfLearningState,
  proposal: LearningProposal
): ProfileSelfLearningState {
  const microVersion = (state.microVersion || 0) + 1;
  return normalizeSelfLearning({
    ...state,
    microVersion,
    tradesSinceMicro: 0,
    pendingProposal: null,
    nextEligibleIn: state.microEveryTrades || 4,
    lastMutation: {
      at: Date.now(),
      kind: 'micro',
      summary: proposal.summary,
      changes: humanizeLearningPatch(proposal.patch),
      scoreBefore: proposal.scoreBefore,
      scoreAfter: proposal.scoreAfter,
      microVersion,
      version: state.version,
      source: proposal.source || 'heuristic',
    },
  });
}

export function applySelfLearnUpgrade(
  state: ProfileSelfLearningState,
  proposal: LearningProposal,
  previousOverrides: TradeProfileParamOverride | null,
  opts?: { profileId?: string }
): ProfileSelfLearningState {
  const nextVersion = state.version + 1;
  let episodeCountAtUpgrade: number | undefined;
  let winsAtUpgrade: number | undefined;
  let lossesAtUpgrade: number | undefined;
  if (opts?.profileId) {
    const snap = countEpisodeWinLoss(opts.profileId);
    episodeCountAtUpgrade = snap.episodes;
    winsAtUpgrade = snap.wins;
    lossesAtUpgrade = snap.losses;
  }
  const stack = [
    ...(Array.isArray(state.previousOverrideStack)
      ? state.previousOverrideStack
      : []),
    ...(previousOverrides ? [previousOverrides] : []),
  ].slice(-8);

  return normalizeSelfLearning({
    ...state,
    version: nextVersion,
    lastUpgradedAt: Date.now(),
    tradesSinceUpgrade: 0,
    tradesSinceMicro: 0,
    pendingProposal: null,
    nearMiss: null,
    mode: state.mode === 'shadow' ? 'auto' : state.mode,
    previousOverrideSnapshot: previousOverrides,
    previousOverrideStack: stack,
    lastMutation: {
      at: Date.now(),
      kind: 'upgrade',
      summary: proposal.summary,
      changes: humanizeLearningPatch(proposal.patch),
      scoreBefore: proposal.scoreBefore,
      scoreAfter: proposal.scoreAfter,
      version: nextVersion,
      microVersion: state.microVersion,
      source: proposal.source || 'heuristic',
    },
    history: [
      ...state.history,
      {
        version: nextVersion,
        at: Date.now(),
        summary: proposal.summary,
        patch: proposal.patch,
        scoreBefore: proposal.scoreBefore,
        scoreAfter: proposal.scoreAfter,
        episodeCountAtUpgrade,
        winsAtUpgrade,
        lossesAtUpgrade,
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
