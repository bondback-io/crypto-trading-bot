/**
 * Wallet quality scoring (0–100) + prune / copy-gate helpers.
 *
 * Factors: win rate, trade sample, Pump.fun consistency, recent activity,
 * optional avg hold time. Categories: scalper vs swing (smart/kol/sniper kept).
 */

import {
  config,
  persistWallets,
  type SmartWallet,
} from './config';
import {
  inferWalletCategory,
  type WalletCategory,
} from './walletStore';
import { effectiveMinWalletQualityScore } from './strictMode';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type WalletQualityStatus =
  | 'elite'
  | 'good'
  | 'medium'
  | 'low'
  | 'inactive'
  | 'unknown';

export interface WalletQualityInput {
  winRate?: number;
  tradesLast7d?: number;
  tradesLast30d?: number;
  pumpFunTradeCount?: number;
  tags?: string[];
  lastActive?: number;
  lastTradedAt?: number;
  avgHoldTimeSec?: number;
  category?: WalletCategory;
  enabled?: boolean;
}

export interface WalletQualityResult {
  score: number;
  status: WalletQualityStatus;
  category: WalletCategory;
  /** 0–1 size / convergence weight (down-weighted when weak) */
  copyWeight: number;
  breakdown: {
    winRate: number;
    sample: number;
    pump: number;
    activity: number;
    hold: number;
  };
  reasons: string[];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function lastActiveMs(w: WalletQualityInput): number | null {
  const t = w.lastTradedAt ?? w.lastActive;
  return t != null && Number.isFinite(t) && t > 0 ? t : null;
}

/** Infer scalper vs swing vs smart/kol/sniper from tags + frequency + hold. */
export function resolveWalletCategory(w: WalletQualityInput): WalletCategory {
  if (w.category === 'scalper' || w.category === 'sniper' || w.category === 'kol') {
    return w.category;
  }
  const tags = (w.tags ?? []).map((t) => t.toLowerCase());
  if (tags.some((t) => /swing/.test(t))) return 'smart';
  const inferred = inferWalletCategory(w.tags, w.tradesLast7d);
  if (inferred === 'scalper') return 'scalper';
  // Low frequency + longer holds → treat as swing (still category "smart")
  if (
    (w.avgHoldTimeSec != null && w.avgHoldTimeSec >= 3600) ||
    (w.tradesLast7d != null && w.tradesLast7d > 0 && w.tradesLast7d < 8)
  ) {
    return 'smart';
  }
  return inferred;
}

export function qualityStatusFromScore(
  score: number,
  inactive: boolean
): WalletQualityStatus {
  if (inactive) return 'inactive';
  if (score >= 80) return 'elite';
  if (score >= 65) return 'good';
  if (score >= 55) return 'medium';
  if (score > 0) return 'low';
  return 'unknown';
}

/**
 * Score a wallet 0–100.
 *
 * Weights (approx):
 * - Win rate 0–35
 * - Trade sample / consistency 0–20
 * - Pump.fun focus 0–15
 * - Recent activity 0–20
 * - Hold-time fit 0–10 (omitted → redistributed softly via activity)
 */
export function scoreWalletQuality(w: WalletQualityInput): WalletQualityResult {
  const reasons: string[] = [];
  const inactiveDays =
    config.filters.walletQualityInactiveDays ?? 5;
  const last = lastActiveMs(w);
  const daysSince =
    last != null ? (Date.now() - last) / MS_PER_DAY : null;
  const inactive =
    daysSince != null ? daysSince > inactiveDays : false;

  // --- Win rate (0–35) ---
  let winPts = 0;
  const wr = w.winRate;
  if (wr != null && Number.isFinite(wr) && wr > 0) {
    // 30% → 0, 55% → ~17.5, 80%+ → 35
    winPts = clamp(((wr - 30) / 50) * 35, 0, 35);
    if (wr < 40) reasons.push(`low win rate ${wr.toFixed(0)}%`);
  } else {
    winPts = 12; // unknown — neutral-low
    reasons.push('win rate unknown');
  }

  // --- Sample / consistency (0–20) ---
  const t7 = w.tradesLast7d ?? 0;
  const t30 = w.tradesLast30d ?? 0;
  let samplePts = 0;
  if (t7 >= 20) samplePts += 12;
  else if (t7 >= 10) samplePts += 9;
  else if (t7 >= 5) samplePts += 6;
  else if (t7 > 0) samplePts += 3;
  if (t30 >= 40) samplePts += 8;
  else if (t30 >= 15) samplePts += 5;
  else if (t30 >= 5) samplePts += 3;
  samplePts = clamp(samplePts, 0, 20);
  if (t7 === 0 && t30 === 0) reasons.push('no trade sample');

  // --- Pump.fun consistency (0–15) ---
  const tags = (w.tags ?? []).map((t) => t.toLowerCase());
  const pumpTagged = tags.some((t) => /pump/.test(t));
  const pumpCount = w.pumpFunTradeCount ?? 0;
  let pumpPts = 0;
  if (pumpCount >= 20 || (pumpTagged && t7 >= 10)) pumpPts = 15;
  else if (pumpCount >= 8 || pumpTagged) pumpPts = 10;
  else if (pumpCount > 0) pumpPts = 6;
  else if (t7 >= 15) pumpPts = 5; // active without pump tag — partial
  else pumpPts = 3;

  // --- Recent activity (0–20) ---
  let actPts = 0;
  if (daysSince == null) {
    actPts = 8;
    reasons.push('last active unknown');
  } else if (daysSince <= 1) actPts = 20;
  else if (daysSince <= 2) actPts = 16;
  else if (daysSince <= 3) actPts = 12;
  else if (daysSince <= inactiveDays) actPts = 6;
  else {
    actPts = 0;
    reasons.push(`inactive ${daysSince.toFixed(1)}d > ${inactiveDays}d`);
  }

  // --- Hold time (0–10) ---
  const category = resolveWalletCategory(w);
  let holdPts = 5; // neutral when unknown
  if (w.avgHoldTimeSec != null && Number.isFinite(w.avgHoldTimeSec)) {
    const hold = w.avgHoldTimeSec;
    if (category === 'scalper') {
      // Prefer short holds (< 30m)
      holdPts = hold <= 1800 ? 10 : hold <= 3600 ? 7 : 3;
    } else {
      // Swing / smart — prefer longer holds
      holdPts = hold >= 3600 ? 10 : hold >= 900 ? 7 : 4;
    }
  }

  const raw =
    winPts + samplePts + pumpPts + actPts + holdPts;
  const score = Math.round(clamp(raw, 0, 100));
  const status = qualityStatusFromScore(score, inactive);

  let copyWeight = 1;
  if (inactive || score < 40) copyWeight = 0.25;
  else if (score < 55) copyWeight = 0.55;
  else if (score < 65) copyWeight = 0.8;
  else if (score >= 80) copyWeight = 1.15;

  return {
    score,
    status,
    category,
    copyWeight: clamp(copyWeight, 0.1, 1.25),
    breakdown: {
      winRate: Math.round(winPts),
      sample: Math.round(samplePts),
      pump: Math.round(pumpPts),
      activity: Math.round(actPts),
      hold: Math.round(holdPts),
    },
    reasons,
  };
}

/** Apply score onto a tracked wallet object (mutates). */
export function applyQualityToWallet(wallet: SmartWallet): WalletQualityResult {
  const result = scoreWalletQuality(wallet);
  wallet.qualityScore = result.score;
  wallet.qualityStatus = result.status;
  wallet.copyWeight = result.copyWeight;
  wallet.qualityScoredAt = Date.now();
  if (!wallet.category) {
    wallet.category = result.category;
  }
  return result;
}

export function refreshAllWalletQualityScores(): {
  scored: number;
  belowMin: number;
} {
  let belowMin = 0;
  const min = effectiveMinWalletQualityScore();
  for (const w of config.smartWallets) {
    const r = applyQualityToWallet(w);
    if (r.score < min) belowMin += 1;
  }
  persistWallets();
  return { scored: config.smartWallets.length, belowMin };
}

export function passesWalletQualityGate(wallet: SmartWallet): {
  ok: boolean;
  reason?: string;
} {
  if (config.filters.enableWalletQualityGate === false) {
    return { ok: true };
  }
  const min = effectiveMinWalletQualityScore();
  // Score lazily if missing
  if (wallet.qualityScore == null) {
    applyQualityToWallet(wallet);
  }
  const score = wallet.qualityScore ?? 0;
  if (score < min) {
    return {
      ok: false,
      reason: `wallet quality ${score} < min ${min}${
        wallet.qualityStatus ? ` (${wallet.qualityStatus})` : ''
      }`,
    };
  }
  return { ok: true };
}

/** True when wallet is elite enough for single-wallet migration exception. */
export function isProvenTopPerformer(wallet: SmartWallet): boolean {
  const score =
    wallet.qualityScore ?? scoreWalletQuality(wallet).score;
  const wr = wallet.winRate ?? 0;
  return score >= 75 && wr >= 50;
}

/**
 * Down-weight / unwatch low-quality or inactive wallets.
 * Hard-delete only when remove=true (Prune Low Quality button).
 */
export function pruneLowQualityWallets(options: {
  remove?: boolean;
  minScore?: number;
  inactiveDays?: number;
} = {}): {
  unwatched: number;
  removed: number;
  downWeighted: number;
  pruned: Array<{ name: string; address: string; reason: string; score: number }>;
} {
  const min = options.minScore ?? effectiveMinWalletQualityScore();
  const inactiveDays =
    options.inactiveDays ?? config.filters.walletQualityInactiveDays ?? 5;
  const remove = options.remove === true;
  const pruned: Array<{
    name: string;
    address: string;
    reason: string;
    score: number;
  }> = [];
  let unwatched = 0;
  let removed = 0;
  let downWeighted = 0;

  const keep: SmartWallet[] = [];
  for (const w of config.smartWallets) {
    const result = applyQualityToWallet(w);
    const last = lastActiveMs(w);
    const daysSince =
      last != null ? (Date.now() - last) / MS_PER_DAY : null;
    const isInactive = daysSince != null && daysSince > inactiveDays;
    const low = result.score < min;

    if (!low && !isInactive) {
      keep.push(w);
      continue;
    }

    const reason = isInactive
      ? `inactive ${daysSince!.toFixed(1)}d · score ${result.score}`
      : `quality ${result.score} < ${min} (${result.status})`;

    pruned.push({
      name: w.name,
      address: w.address,
      reason,
      score: result.score,
    });

    if (remove) {
      removed += 1;
      console.log(
        `[wallet-quality] Pruned ${w.name} (${w.address.slice(0, 8)}…) — ${reason}`
      );
      continue;
    }

    // Default: unwatch + down-weight (do not hard-delete)
    if (w.enabled) {
      w.enabled = false;
      unwatched += 1;
    }
    w.copyWeight = Math.min(w.copyWeight ?? 1, 0.35);
    downWeighted += 1;
    keep.push(w);
    console.log(
      `[wallet-quality] Unwatched/down-weighted ${w.name} — ${reason}`
    );
  }

  config.smartWallets = keep;
  persistWallets();
  return { unwatched, removed, downWeighted, pruned };
}

/** Auto-prune pass when enableWalletQualityAutoPrune is on (unwatch, no delete). */
export function maybeAutoPruneLowQuality(): ReturnType<
  typeof pruneLowQualityWallets
> | null {
  if (!config.filters.enableWalletQualityAutoPrune) return null;
  return pruneLowQualityWallets({ remove: false });
}
