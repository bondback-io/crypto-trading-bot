/**
 * One-off 48h Risk Recipe Bake-in calibrator.
 *
 * Phase A: fresh LIVE DexScreener 48h BT (compareRiskLevels + parityMode)
 * Phase B: deep shadow search per Low/Medium/High/Degen with WR+profit composite
 * Phase C: same-window compareRiskLevels verify (after code bake-in)
 *
 * Usage:
 *   npx tsx scripts/calibrateRiskRecipes.ts
 *   npx tsx scripts/calibrateRiskRecipes.ts --phase=search
 *   npx tsx scripts/calibrateRiskRecipes.ts --phase=verify
 *   npx tsx scripts/calibrateRiskRecipes.ts --phase=all
 *   npx tsx scripts/calibrateRiskRecipes.ts --resume
 *   npx tsx scripts/calibrateRiskRecipes.ts --skip-degen
 *   npx tsx scripts/calibrateRiskRecipes.ts --phase=finalize-search
 *
 * Auto-skip: when High's winner is baseline, Degen search is skipped.
 * Strict Mode is forced OFF for search and bake-in verify.
 * Live data only — never falls back to synthetic for the calibration window.
 */

import fs from 'fs';
import path from 'path';
import {
  config,
  isRiskLevel,
  persistUserSettings,
  RISK_LEVEL_PRESETS,
  type RiskLevel,
} from '../src/config';
import { dataFile, ensureDataDir, atomicWriteJson } from '../src/dataDir';
import type { BacktestOptions, BacktestResult } from '../src/backtest';
import {
  mergeOverlays,
  type AdvisorOverlay,
} from '../src/backtestAdvisor';
import { performanceScoreFromStats } from '../src/performanceScore';
import type { StrategyKey } from '../src/strategies';

const RISK_LEVELS: RiskLevel[] = ['low', 'medium', 'high', 'degen'];
const HOURS = 48;
const MAX_CANDIDATES_PER_RISK = 36;
const OUT_FILE = 'recipeCalibration48h.json';

type Phase = 'all' | 'baseline' | 'search' | 'verify' | 'finalize-search';

interface CandidateMetrics {
  trades: number;
  winRatePct: number;
  expectancySol: number;
  profitFactor: number;
  maxDrawdownPct: number;
  totalPnlSol: number;
  performanceScore: number;
}

interface ScoredCandidate {
  id: string;
  riskLevel: RiskLevel;
  label: string;
  overlay: AdvisorOverlay;
  isBaseline?: boolean;
  passedFloors?: boolean;
  floorNotes?: string[];
  metrics?: CandidateMetrics;
  compositeScore?: number;
  profitScore?: number;
  rank?: number;
  scoreNote?: string;
  error?: string;
}

interface RiskBlock {
  riskLevel: RiskLevel;
  baseline: ScoredCandidate;
  ranked: ScoredCandidate[];
  winnerId: string | null;
  winner: ScoredCandidate | null;
  /** When true, search was not run / discarded for this risk */
  skipped?: boolean;
  skipReason?: string;
}

interface CalibrationReport {
  id: string;
  generatedAt: number;
  updatedAt: number;
  phase: string;
  period: { fromMs: number; toMs: number; hours: number };
  baselineBacktestId: string | null;
  baselineDataSource: string | null;
  baselineCompare: BacktestResult['riskComparison'] | null;
  risks: RiskBlock[];
  scoring: {
    composite: '0.55*winRatePct + 0.45*profitScore';
    strictMode: false;
    floors: Record<string, string>;
  };
  bakePlan: Array<{
    riskLevel: RiskLevel;
    candidateId: string;
    label: string;
    overlay: AdvisorOverlay;
    metrics?: CandidateMetrics;
    recipeTogglePatches: Partial<Record<StrategyKey, boolean>>;
    presetPatches: {
      minConvictionScore?: number;
      minWalletQualityScore?: number;
      minRankScore?: number;
      maxRiskScore?: number;
    };
  }>;
  /** Set when no non-baseline winners (or explicit no-op bake) */
  bakeNote?: string;
  verify?: {
    ranAt: number;
    backtestId: string | null;
    dataSource: string | null;
    before: BacktestResult['riskComparison'] | null;
    after: BacktestResult['riskComparison'] | null;
    message: string;
  };
  progress?: {
    completedCandidateIds: string[];
    lastRiskLevel: RiskLevel | null;
  };
  disclaimer: string;
}

function parseArgs(): { phase: Phase; resume: boolean; skipDegen: boolean } {
  const argv = process.argv.slice(2);
  let phase: Phase = 'all';
  let resume = false;
  let skipDegen = false;
  for (const a of argv) {
    if (a === '--resume') resume = true;
    if (a === '--skip-degen') skipDegen = true;
    if (a.startsWith('--phase=')) {
      const p = a.slice('--phase='.length) as Phase;
      if (
        ['all', 'baseline', 'search', 'verify', 'finalize-search'].includes(p)
      ) {
        phase = p;
      }
    }
  }
  return { phase, resume, skipDegen };
}

function isBaselineWinner(block: RiskBlock | undefined | null): boolean {
  if (!block) return false;
  if (block.winner?.isBaseline === true) return true;
  const id = block.winnerId || '';
  return id.endsWith('-baseline') || id.includes('-baseline');
}

/** Mark Degen skipped and discard any partial candidate scores. */
function markDegenSkipped(
  report: CalibrationReport,
  reason: string
): CalibrationReport {
  const skippedBlock: RiskBlock = {
    riskLevel: 'degen',
    baseline: {
      id: 'degen-skipped',
      riskLevel: 'degen',
      label: 'Skipped',
      overlay: {},
      isBaseline: true,
      scoreNote: reason,
    },
    ranked: [],
    winnerId: null,
    winner: null,
    skipped: true,
    skipReason: reason,
  };
  const others = (report.risks || []).filter((r) => r.riskLevel !== 'degen');
  report.risks = [...others, skippedBlock];
  // Drop any in-progress degen candidate ids from resume set
  if (report.progress?.completedCandidateIds?.length) {
    report.progress.completedCandidateIds =
      report.progress.completedCandidateIds.filter(
        (id) => !id.startsWith('degen-')
      );
  }
  return report;
}

function applyNoBakeNote(report: CalibrationReport): CalibrationReport {
  const nonBaseline = (report.risks || []).filter(
    (r) =>
      !r.skipped &&
      r.winner &&
      r.winnerId &&
      !r.winner.isBaseline &&
      !String(r.winnerId).endsWith('-baseline')
  );
  report.bakePlan = buildBakePlan(report.risks || []);
  if (!nonBaseline.length) {
    report.bakeNote = 'no bake - baselines won';
    report.bakePlan = [];
  } else {
    delete report.bakeNote;
  }
  return report;
}

/**
 * Finalize interrupted search: keep low/medium/high, skip degen when High
 * winner is baseline (or --skip-degen), set phase search_done + bake note.
 */
function finalizeSearchReport(
  report: CalibrationReport,
  opts: { forceSkipDegen?: boolean } = {}
): CalibrationReport {
  const high = (report.risks || []).find((r) => r.riskLevel === 'high');
  const shouldSkipDegen =
    opts.forceSkipDegen === true || isBaselineWinner(high);

  if (shouldSkipDegen) {
    const reason = isBaselineWinner(high)
      ? 'high-baseline'
      : 'skip-degen';
    markDegenSkipped(report, reason);
    log(`Degen marked skipped (${reason})`);
  }

  // Ensure low/medium/high blocks stay; strip incomplete pending placeholders
  report.risks = (report.risks || []).filter(
    (r) =>
      r.riskLevel === 'degen' ||
      (r.ranked && r.ranked.length > 0) ||
      r.winnerId
  );

  applyNoBakeNote(report);
  report.phase = 'search_done';
  report.progress = {
    completedCandidateIds: (report.progress?.completedCandidateIds || []).filter(
      (id) => !id.startsWith('degen-')
    ),
    lastRiskLevel: shouldSkipDegen
      ? 'high'
      : report.progress?.lastRiskLevel ?? null,
  };
  saveReport(report);
  return report;
}

function outPath(): string {
  ensureDataDir();
  return dataFile(OUT_FILE);
}

function log(msg: string, extra?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  if (extra) console.log(`[calibrate ${ts}] ${msg}`, extra);
  else console.log(`[calibrate ${ts}] ${msg}`);
}

function cloneOverlay(o: AdvisorOverlay): AdvisorOverlay {
  return mergeOverlays([o]);
}

function metricsFromResult(result: BacktestResult): CandidateMetrics {
  const trades = (result.trades || []).filter((t) => !t.forcedEndOfWindow);
  const wins = trades.filter((t) => t.pnlSol > 0);
  const wr = trades.length ? (wins.length / trades.length) * 100 : 0;
  const s = result.summary;
  const card = performanceScoreFromStats({
    winRatePct: wr,
    profitFactor: s?.profitFactor ?? 0,
    maxDrawdownPct: s?.maxDrawdownPct ?? 0,
    avgWinPct: s?.avgWinPct,
    avgLossPct: s?.avgLossPct,
    avgWinSol: s?.avgWinSol,
    avgLossSol: s?.avgLossSol,
    closedTrades: trades.length,
  });
  return {
    trades: trades.length,
    winRatePct: Number(wr.toFixed(2)),
    expectancySol: Number((s?.expectancySol ?? 0).toFixed(6)),
    profitFactor: Number((s?.profitFactor ?? 0).toFixed(3)),
    maxDrawdownPct: Number((s?.maxDrawdownPct ?? 0).toFixed(2)),
    totalPnlSol: Number((s?.totalPnlSol ?? 0).toFixed(6)),
    performanceScore: card.score,
  };
}

function bumpConviction(base: number, delta: number): number {
  return Math.min(85, Math.max(15, Math.round(base + delta)));
}

function bumpQuality(base: number, delta: number): number {
  return Math.min(85, Math.max(25, Math.round(base + delta)));
}

function recipeBaseFloors(riskLevel: RiskLevel): {
  conviction: number;
  quality: number;
} {
  const preset = RISK_LEVEL_PRESETS[riskLevel];
  return {
    conviction: preset?.selective?.minConvictionScore ?? 40,
    quality: preset?.filters?.minWalletQualityScore ?? 55,
  };
}

/**
 * Hard floors per risk (bake-in scoring — must match plan exactly).
 */
export function passesBakeInFloors(
  riskLevel: RiskLevel,
  baseline: CandidateMetrics,
  candidate: CandidateMetrics
): { pass: boolean; notes: string[] } {
  const notes: string[] = [];
  const bTrades = baseline.trades;
  const bWr = baseline.winRatePct;
  const bExp = baseline.expectancySol;
  const c = candidate;

  if (riskLevel === 'low') {
    const minTrades = Math.max(6, Math.ceil(bTrades * 0.35));
    if (c.trades < minTrades) notes.push(`trades ${c.trades} < floor ${minTrades}`);
    const wrOk = c.winRatePct >= bWr - 5 || c.winRatePct >= 55;
    if (!wrOk) {
      notes.push(
        `WR ${c.winRatePct.toFixed(1)}% < max(baseline−5=${(bWr - 5).toFixed(1)}, 55)`
      );
    }
    if (c.expectancySol < 0 - 1e-9) {
      notes.push(`expectancy ${c.expectancySol.toFixed(4)} < 0`);
    }
    if (c.profitFactor < 1.0 - 1e-9) {
      notes.push(`PF ${c.profitFactor.toFixed(2)} < 1.0`);
    }
  } else if (riskLevel === 'medium') {
    const minTrades = Math.max(8, Math.ceil(bTrades * 0.4));
    if (c.trades < minTrades) notes.push(`trades ${c.trades} < floor ${minTrades}`);
    if (c.expectancySol < 0 - 1e-9) {
      notes.push(`expectancy ${c.expectancySol.toFixed(4)} < 0`);
    }
    if (c.profitFactor < 1.0 - 1e-9) {
      notes.push(`PF ${c.profitFactor.toFixed(2)} < 1.0`);
    }
  } else if (riskLevel === 'high') {
    const minTrades = Math.max(10, Math.ceil(bTrades * 0.45));
    if (c.trades < minTrades) notes.push(`trades ${c.trades} < floor ${minTrades}`);
    if (c.expectancySol < 0 - 1e-9) {
      notes.push(`expectancy ${c.expectancySol.toFixed(4)} < 0`);
    }
    if (c.profitFactor < 0.95 - 1e-9) {
      notes.push(`PF ${c.profitFactor.toFixed(2)} < 0.95`);
    }
  } else {
    // degen
    const minTrades = Math.max(12, Math.ceil(bTrades * 0.5));
    if (c.trades < minTrades) notes.push(`trades ${c.trades} < floor ${minTrades}`);
    const expOk =
      c.expectancySol >= -1e-6 ||
      (bExp > 0 && c.expectancySol >= bExp * 0.7);
    if (!expOk) {
      notes.push(
        `expectancy ${c.expectancySol.toFixed(4)} fails degen floor (≥−1e-6 or ≥70% baseline)`
      );
    }
    if (c.profitFactor < 0.9 - 1e-9) {
      notes.push(`PF ${c.profitFactor.toFixed(2)} < 0.9`);
    }
  }

  return { pass: notes.length === 0, notes };
}

/**
 * Among passers: composite = 0.55*WR + 0.45*profitScore
 * profitScore normalizes expectancy (fallback total PnL) vs best passer (0–100).
 * Tie-break: higher PF → lower max DD → closer-to-baseline trade count.
 */
export function rankCandidates(
  scored: ScoredCandidate[],
  baselineTrades: number
): ScoredCandidate[] {
  const passers = scored.filter((c) => c.passedFloors && c.metrics && !c.error);
  const profitKey = (m: CandidateMetrics) =>
    Math.abs(m.expectancySol) > 1e-9 ? m.expectancySol : m.totalPnlSol;
  const bestProfit = passers.length
    ? Math.max(...passers.map((c) => profitKey(c.metrics!)))
    : 0;

  for (const c of scored) {
    if (!c.metrics || !c.passedFloors) {
      c.profitScore = 0;
      c.compositeScore = -1;
      continue;
    }
    const raw = profitKey(c.metrics);
    const profitScore =
      bestProfit > 0 ? Math.max(0, Math.min(100, (raw / bestProfit) * 100)) : raw >= 0 ? 50 : 0;
    c.profitScore = Number(profitScore.toFixed(2));
    c.compositeScore = Number(
      (0.55 * c.metrics.winRatePct + 0.45 * profitScore).toFixed(3)
    );
  }

  const ranked = [...scored].sort((a, b) => {
    const ap = a.passedFloors === true ? 1 : 0;
    const bp = b.passedFloors === true ? 1 : 0;
    if (ap !== bp) return bp - ap;

    const ac = a.compositeScore ?? -1;
    const bc = b.compositeScore ?? -1;
    if (Math.abs(bc - ac) > 0.01) return bc - ac;

    const af = a.metrics?.profitFactor ?? 0;
    const bf = b.metrics?.profitFactor ?? 0;
    if (Math.abs(bf - af) > 0.01) return bf - af;

    const ad = a.metrics?.maxDrawdownPct ?? 999;
    const bd = b.metrics?.maxDrawdownPct ?? 999;
    if (Math.abs(ad - bd) > 0.05) return ad - bd;

    const at = a.metrics?.trades ?? 0;
    const bt = b.metrics?.trades ?? 0;
    return Math.abs(at - baselineTrades) - Math.abs(bt - baselineTrades);
  });

  ranked.forEach((c, i) => {
    c.rank = i + 1;
  });
  return ranked;
}

function pushCandidate(
  out: Array<{ id: string; label: string; overlay: AdvisorOverlay }>,
  riskLevel: RiskLevel,
  id: string,
  label: string,
  overlay: AdvisorOverlay,
  max: number
): void {
  if (out.length >= max) return;
  const fullId = `${riskLevel}-${id}`;
  if (out.some((c) => c.id === fullId)) return;
  out.push({ id: fullId, label, overlay: cloneOverlay(overlay) });
}

/**
 * ~25–40 personality-aware candidates per risk.
 */
export function generateBakeInCandidates(
  riskLevel: RiskLevel,
  maxCandidates: number
): Array<{ id: string; label: string; overlay: AdvisorOverlay }> {
  const out: Array<{ id: string; label: string; overlay: AdvisorOverlay }> = [];
  const { conviction: baseC, quality: baseQ } = recipeBaseFloors(riskLevel);
  const push = (id: string, label: string, overlay: AdvisorOverlay) =>
    pushCandidate(out, riskLevel, id, label, overlay, maxCandidates);

  push('baseline', 'Baseline recipe', {});

  if (riskLevel === 'low') {
    // Quality ON bias; scalps OFF; higher conviction/WQ; scanner optional/OFF
    push('quality-full', 'Full quality pack ON', {
      toggles: {
        elite_convergence: true,
        hard_quality_gate: true,
        wallet_quality_scoring: true,
        bonding_curve_health: true,
        momentum_confirmation: true,
        profit_protected: true,
        early_entry_only: true,
        micro_scalper: false,
        momentum_burst: false,
        post_migration_scalp: false,
        reversal_scalp: false,
        quick_scalper: false,
      },
    });
    push('scanner-off', 'TA scanner OFF', {
      toggles: { ta_market_scanner: false },
    });
    push('scanner-65', 'Scanner rank ≥ 65', {
      toggles: { ta_market_scanner: true },
      minRankScore: 65,
    });
    push('scanner-70', 'Scanner rank ≥ 70', {
      toggles: { ta_market_scanner: true },
      minRankScore: 70,
    });
    for (const d of [5, 8, 10, 12]) {
      push(`conv-p${d}`, `Conviction +${d} → ${bumpConviction(baseC, d)}`, {
        toggles: { multi_factor_conviction: true },
        minConvictionScore: bumpConviction(baseC, d),
      });
    }
    for (const d of [3, 5, 8]) {
      push(`wq-p${d}`, `WQ +${d} → ${bumpQuality(baseQ, d)}`, {
        toggles: { wallet_quality_scoring: true },
        minWalletQualityScore: bumpQuality(baseQ, d),
      });
    }
    push('conv-wq', 'Conviction +8 + WQ +5 + elite', {
      toggles: {
        multi_factor_conviction: true,
        wallet_quality_scoring: true,
        elite_convergence: true,
        hard_quality_gate: true,
        micro_scalper: false,
        momentum_burst: false,
      },
      minConvictionScore: bumpConviction(baseC, 8),
      minWalletQualityScore: bumpQuality(baseQ, 5),
    });
    push('early-mom', 'Early entry + momentum', {
      toggles: {
        early_entry_only: true,
        momentum_confirmation: true,
        time_based_entry: true,
      },
    });
    push('vol-liq', 'Volume/liquidity + holders ON', {
      toggles: { volume_liquidity_filters: true, min_holders_activity: true },
    });
    push('sniper-on', 'Sniper/bundler filters ON', {
      toggles: { sniper_bundler_filters: true },
    });
    push('scalps-off', 'All scalps OFF (explicit)', {
      toggles: {
        micro_scalper: false,
        momentum_burst: false,
        post_migration_scalp: false,
        reversal_scalp: false,
        quick_scalper: false,
      },
    });
    push('profit-bond', 'Profit-protected + bonding', {
      toggles: { profit_protected: true, bonding_curve_health: true },
    });
    push('wr-combo', 'WR combo: quality + conv+10 + scalps off', {
      toggles: {
        elite_convergence: true,
        hard_quality_gate: true,
        multi_factor_conviction: true,
        wallet_quality_scoring: true,
        volume_liquidity_filters: true,
        ta_market_scanner: false,
        micro_scalper: false,
        momentum_burst: false,
        post_migration_scalp: false,
        reversal_scalp: false,
      },
      minConvictionScore: bumpConviction(baseC, 10),
      minWalletQualityScore: bumpQuality(baseQ, 5),
    });
    push('mirror-sl', 'Mirror SL 14–20%', {
      profileParamPatches: [
        {
          id: 'smart_money_mirror',
          params: { exitRules: { stopLossPctMin: 14, stopLossPctMax: 20 } },
        },
      ],
    });
    push('max-risk-40', 'Max risk score 40', { maxRiskScore: 40 });
    push('elite-mom-profit', 'Elite + momentum + profit pack', {
      toggles: {
        elite_convergence: true,
        momentum_confirmation: true,
        profit_protected: true,
        bonding_curve_health: true,
        hard_quality_gate: true,
      },
    });
  } else if (riskLevel === 'medium') {
    // Balanced; elite+scanner; scalps OFF unless clearly helps
    push('elite-on', 'Elite Convergence ON', {
      toggles: { elite_convergence: true },
    });
    push('scanner-55', 'Scanner rank ≥ 55', {
      toggles: { ta_market_scanner: true },
      minRankScore: 55,
    });
    push('scanner-60', 'Scanner rank ≥ 60', {
      toggles: { ta_market_scanner: true },
      minRankScore: 60,
    });
    push('scanner-65', 'Scanner rank ≥ 65', {
      toggles: { ta_market_scanner: true },
      minRankScore: 65,
    });
    push('elite-scanner', 'Elite + scanner ≥ 55', {
      toggles: { elite_convergence: true, ta_market_scanner: true },
      minRankScore: 55,
    });
    for (const d of [-5, 0, 5, 8, 10]) {
      if (d === 0) {
        push('conv-base', `Conviction base ${baseC}`, {
          toggles: { multi_factor_conviction: true },
          minConvictionScore: baseC,
        });
      } else {
        push(
          `conv-${d > 0 ? 'p' : 'm'}${Math.abs(d)}`,
          `Conviction ${d > 0 ? '+' : ''}${d} → ${bumpConviction(baseC, d)}`,
          {
            toggles: { multi_factor_conviction: true },
            minConvictionScore: bumpConviction(baseC, d),
          }
        );
      }
    }
    for (const d of [0, 3, 5, 8]) {
      push(`wq-p${d}`, `WQ +${d} → ${bumpQuality(baseQ, d)}`, {
        toggles: { wallet_quality_scoring: true },
        minWalletQualityScore: bumpQuality(baseQ, d),
      });
    }
    push('scalps-off', 'All scalp engines OFF', {
      toggles: {
        micro_scalper: false,
        momentum_burst: false,
        post_migration_scalp: false,
        reversal_scalp: false,
        quick_scalper: false,
      },
    });
    push('micro-mom-on', 'Micro + momentum scalp ON (probe)', {
      toggles: {
        micro_scalper: true,
        momentum_burst: true,
        post_migration_scalp: false,
        reversal_scalp: false,
        quick_scalper: false,
      },
    });
    push('quality-lite', 'Hard gate + WQ + bonding', {
      toggles: {
        hard_quality_gate: true,
        wallet_quality_scoring: true,
        bonding_curve_health: true,
      },
    });
    push('early-mom', 'Early entry + momentum', {
      toggles: {
        early_entry_only: true,
        momentum_confirmation: true,
        time_based_entry: true,
      },
    });
    push('vol-liq', 'Volume/liquidity + holders', {
      toggles: { volume_liquidity_filters: true, min_holders_activity: true },
    });
    push('profit-bond', 'Profit-protected + bonding', {
      toggles: { profit_protected: true, bonding_curve_health: true },
    });
    push('wr-combo', 'WR combo: elite + conv+8 + scalps off + scanner', {
      toggles: {
        elite_convergence: true,
        multi_factor_conviction: true,
        wallet_quality_scoring: true,
        ta_market_scanner: true,
        volume_liquidity_filters: true,
        micro_scalper: false,
        momentum_burst: false,
        post_migration_scalp: false,
        reversal_scalp: false,
      },
      minConvictionScore: bumpConviction(baseC, 8),
      minWalletQualityScore: bumpQuality(baseQ, 3),
      minRankScore: 55,
    });
    push('mirror-sl', 'Mirror SL 14–20%', {
      profileParamPatches: [
        {
          id: 'smart_money_mirror',
          params: { exitRules: { stopLossPctMin: 14, stopLossPctMax: 20 } },
        },
      ],
    });
    push('sniper-on', 'Sniper filters ON', {
      toggles: { sniper_bundler_filters: true },
    });
    push('balanced-tight', 'Elite + profit + scanner 60 + conv+5', {
      toggles: {
        elite_convergence: true,
        profit_protected: true,
        ta_market_scanner: true,
        multi_factor_conviction: true,
        micro_scalper: false,
        momentum_burst: false,
      },
      minConvictionScore: bumpConviction(baseC, 5),
      minRankScore: 60,
    });
  } else if (riskLevel === 'high') {
    // More entries; micro/momentum scalp OK; looser conviction
    push('micro-mom-on', 'Micro + momentum scalp ON', {
      toggles: {
        micro_scalper: true,
        momentum_burst: true,
        post_migration_scalp: false,
        reversal_scalp: false,
      },
    });
    push('micro-mom-rev', 'Micro + momentum + reversal ON', {
      toggles: {
        micro_scalper: true,
        momentum_burst: true,
        reversal_scalp: true,
        post_migration_scalp: false,
      },
    });
    push('post-mig-on', 'Post-migration scalp ON', {
      toggles: { post_migration_scalp: true },
    });
    push('scalps-off', 'All scalps OFF (control)', {
      toggles: {
        micro_scalper: false,
        momentum_burst: false,
        post_migration_scalp: false,
        reversal_scalp: false,
        quick_scalper: false,
      },
    });
    for (const d of [-8, -5, -3, 0, 5]) {
      push(
        `conv-${d >= 0 ? 'p' : 'm'}${Math.abs(d)}`,
        `Conviction ${d >= 0 ? '+' : ''}${d} → ${bumpConviction(baseC, d)}`,
        {
          toggles: { multi_factor_conviction: true },
          minConvictionScore: bumpConviction(baseC, d),
        }
      );
    }
    for (const d of [-5, 0, 3, 5]) {
      push(`wq-${d >= 0 ? 'p' : 'm'}${Math.abs(d)}`, `WQ ${d >= 0 ? '+' : ''}${d}`, {
        toggles: { wallet_quality_scoring: true },
        minWalletQualityScore: bumpQuality(baseQ, d),
      });
    }
    push('scanner-50', 'Scanner rank ≥ 50', {
      toggles: { ta_market_scanner: true },
      minRankScore: 50,
    });
    push('scanner-55', 'Scanner rank ≥ 55', {
      toggles: { ta_market_scanner: true },
      minRankScore: 55,
    });
    push('scanner-60', 'Scanner rank ≥ 60', {
      toggles: { ta_market_scanner: true },
      minRankScore: 60,
    });
    push('elite-off', 'Elite OFF (more entries)', {
      toggles: { elite_convergence: false },
    });
    push('elite-on', 'Elite ON (selectivity probe)', {
      toggles: { elite_convergence: true },
    });
    push('vol-liq-on', 'Volume/liquidity ON', {
      toggles: { volume_liquidity_filters: true, min_holders_activity: true },
    });
    push('mom-confirm', 'Momentum confirmation ON', {
      toggles: { momentum_confirmation: true },
    });
    push('entries-combo', 'Loose conv + micro/mom + scanner 50', {
      toggles: {
        multi_factor_conviction: true,
        micro_scalper: true,
        momentum_burst: true,
        ta_market_scanner: true,
        elite_convergence: false,
      },
      minConvictionScore: bumpConviction(baseC, -5),
      minRankScore: 50,
    });
    push('mirror-sl', 'Mirror SL 14–20%', {
      profileParamPatches: [
        {
          id: 'smart_money_mirror',
          params: { exitRules: { stopLossPctMin: 14, stopLossPctMax: 20 } },
        },
      ],
    });
    push('mirror-sl-wide', 'Mirror SL 16–24%', {
      profileParamPatches: [
        {
          id: 'smart_money_mirror',
          params: { exitRules: { stopLossPctMin: 16, stopLossPctMax: 24 } },
        },
      ],
    });
    push('wr-lite', 'Conv+5 + WQ + scalps micro/mom + scanner 55', {
      toggles: {
        multi_factor_conviction: true,
        wallet_quality_scoring: true,
        micro_scalper: true,
        momentum_burst: true,
        ta_market_scanner: true,
      },
      minConvictionScore: bumpConviction(baseC, 5),
      minWalletQualityScore: bumpQuality(baseQ, 3),
      minRankScore: 55,
    });
  } else {
    // degen — floors-first; cores can stay OFF; micro/momentum/reversal OK
    // Do NOT propose overlays that re-tighten Degen heal/loosen path floors.
    push('scalps-full', 'Micro + momentum + reversal ON', {
      toggles: {
        micro_scalper: true,
        momentum_burst: true,
        reversal_scalp: true,
        post_migration_scalp: false,
        quick_scalper: false,
      },
    });
    push('post-mig-on', 'Post-migration scalp ON', {
      toggles: { post_migration_scalp: true },
    });
    push('scalps-micro-mom', 'Micro + momentum only', {
      toggles: {
        micro_scalper: true,
        momentum_burst: true,
        reversal_scalp: false,
        post_migration_scalp: false,
      },
    });
    push('scalps-off', 'All scalps OFF (control)', {
      toggles: {
        micro_scalper: false,
        momentum_burst: false,
        post_migration_scalp: false,
        reversal_scalp: false,
        quick_scalper: false,
      },
    });
    push('cores-off', 'Keep quality cores OFF (floors path)', {
      toggles: {
        elite_convergence: false,
        hard_quality_gate: false,
        sniper_bundler_filters: false,
        wallet_quality_scoring: false,
        multi_factor_conviction: false,
        volume_liquidity_filters: false,
        bonding_curve_health: false,
        profit_protected: false,
      },
    });
    push('scanner-35', 'Scanner rank ≥ 35 (loose)', {
      toggles: { ta_market_scanner: true },
      minRankScore: 35,
    });
    push('scanner-40', 'Scanner rank ≥ 40', {
      toggles: { ta_market_scanner: true },
      minRankScore: 40,
    });
    push('scanner-45', 'Scanner rank ≥ 45', {
      toggles: { ta_market_scanner: true },
      minRankScore: 45,
    });
    for (const d of [-5, 0, 5, 10]) {
      push(
        `conv-${d >= 0 ? 'p' : 'm'}${Math.abs(d)}`,
        `Conviction ${d >= 0 ? '+' : ''}${d} → ${bumpConviction(baseC, d)}`,
        {
          toggles: { multi_factor_conviction: true },
          minConvictionScore: bumpConviction(baseC, d),
        }
      );
    }
    push('wq-on-lite', 'WQ gate ON lite (40)', {
      toggles: { wallet_quality_scoring: true },
      minWalletQualityScore: 40,
    });
    push('wq-45', 'WQ ≥ 45', {
      toggles: { wallet_quality_scoring: true },
      minWalletQualityScore: 45,
    });
    push('vol-on', 'Volume/liquidity ON (probe)', {
      toggles: { volume_liquidity_filters: true },
    });
    push('elite-on', 'Elite ON (selectivity probe)', {
      toggles: { elite_convergence: true },
    });
    push('mev-on', 'MEV protection ON', {
      toggles: { mev_protection: true },
    });
    push('entries-combo', 'Scalps full + scanner 35 + cores off', {
      toggles: {
        micro_scalper: true,
        momentum_burst: true,
        reversal_scalp: true,
        ta_market_scanner: true,
        elite_convergence: false,
        hard_quality_gate: false,
        sniper_bundler_filters: false,
        volume_liquidity_filters: false,
      },
      minRankScore: 35,
    });
    push('mirror-sl', 'Mirror SL 14–20%', {
      profileParamPatches: [
        {
          id: 'smart_money_mirror',
          params: { exitRules: { stopLossPctMin: 14, stopLossPctMax: 20 } },
        },
      ],
    });
    push('mirror-sl-wide', 'Mirror SL 18–28%', {
      profileParamPatches: [
        {
          id: 'smart_money_mirror',
          params: { exitRules: { stopLossPctMin: 18, stopLossPctMax: 28 } },
        },
      ],
    });
    push('rev-only', 'Reversal scalp focus', {
      toggles: {
        reversal_scalp: true,
        micro_scalper: true,
        momentum_burst: false,
        post_migration_scalp: false,
      },
    });
    push('mom-burst-focus', 'Momentum burst focus', {
      toggles: {
        momentum_burst: true,
        micro_scalper: true,
        reversal_scalp: false,
      },
    });
  }

  return out.slice(0, Math.max(1, maxCandidates));
}

async function shadowRun(
  period: { fromMs: number; toMs: number; hours: number },
  baseOpts: BacktestResult['options'] | undefined,
  riskLevel: RiskLevel,
  overlay: AdvisorOverlay
): Promise<BacktestResult> {
  const { runBacktest } = await import('../src/backtest');
  return runBacktest({
    fromMs: period.fromMs,
    toMs: period.toMs,
    hours: period.hours,
    maxTrades: baseOpts?.maxTrades,
    simulations: 1,
    migrationsOnly: baseOpts?.migrationsOnly,
    pumpFunOnly: baseOpts?.pumpFunOnly,
    reBuyEnabled: baseOpts?.reBuyEnabled,
    minVolumeUsd: baseOpts?.minVolumeUsd,
    strategyType: baseOpts?.strategyType,
    minLiquidityUsd: baseOpts?.minLiquidityUsd,
    minMarketCapUsd: baseOpts?.minMarketCapUsd,
    maxRiskScore: overlay.maxRiskScore ?? baseOpts?.maxRiskScore,
    useLiveData: true,
    allowSynthetic: false,
    startingBalanceSol: baseOpts?.startingBalanceSol,
    riskLevel,
    compareRiskLevels: false,
    useSavedConfigFilters: true,
    parityMode: true,
    persistResult: false,
    strictMode: false,
    skipOptimizerOverlay: true,
    advisorOverlay: overlay,
    minConvictionScore: overlay.minConvictionScore,
    minWalletQualityScore: overlay.minWalletQualityScore,
  } as BacktestOptions);
}

function assertLiveData(result: BacktestResult, label: string): void {
  const src = String(result.dataSource || '').toLowerCase();
  if (src.includes('synthetic') || src === 'synthetic') {
    throw new Error(
      `${label}: dataSource=${result.dataSource} — refused synthetic for calibration window`
    );
  }
  if (!result.ok && (result.eventsConsidered ?? 0) === 0) {
    throw new Error(
      `${label}: no events considered (dataSource=${result.dataSource}). Live fetch likely failed.`
    );
  }
}

function loadReport(): CalibrationReport | null {
  try {
    const p = outPath();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as CalibrationReport;
  } catch {
    return null;
  }
}

function saveReport(report: CalibrationReport): void {
  report.updatedAt = Date.now();
  const target = outPath();
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      atomicWriteJson(target, report);
      if (attempt === 1) log(`Wrote ${target}`);
      else log(`Wrote ${target} (attempt ${attempt})`);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`saveReport attempt ${attempt} failed: ${msg}`);
      // Direct write fallback for OneDrive locks
      try {
        fs.writeFileSync(target, JSON.stringify(report, null, 2), 'utf-8');
        log(`Wrote ${target} via direct write`);
        return;
      } catch {
        /* retry */
      }
      const waitUntil = Date.now() + 100 * attempt;
      while (Date.now() < waitUntil) {
        /* brief backoff for file unlock */
      }
    }
  }
  throw new Error(`Failed to persist calibration report to ${target}`);
}

function buildBakePlan(risks: RiskBlock[]): CalibrationReport['bakePlan'] {
  return risks
    .filter((r) => r.winner && r.winnerId && !r.winner.isBaseline)
    .map((r) => {
      const w = r.winner!;
      const o = w.overlay || {};
      return {
        riskLevel: r.riskLevel,
        candidateId: w.id,
        label: w.label,
        overlay: o,
        metrics: w.metrics,
        recipeTogglePatches: { ...(o.toggles || {}) },
        presetPatches: {
          ...(o.minConvictionScore != null
            ? { minConvictionScore: o.minConvictionScore }
            : {}),
          ...(o.minWalletQualityScore != null
            ? { minWalletQualityScore: o.minWalletQualityScore }
            : {}),
          ...(o.minRankScore != null ? { minRankScore: o.minRankScore } : {}),
          ...(o.maxRiskScore != null ? { maxRiskScore: o.maxRiskScore } : {}),
        },
      };
    });
}

function clearRiskRecipeOptimizations(): void {
  if (
    config.riskRecipeOptimizations &&
    Object.keys(config.riskRecipeOptimizations).length
  ) {
    log('Clearing config.riskRecipeOptimizations overlays');
    config.riskRecipeOptimizations = {};
    persistUserSettings();
  } else {
    config.riskRecipeOptimizations = {};
    persistUserSettings();
    log('riskRecipeOptimizations cleared/empty');
  }
}

async function phaseBaseline(
  existing: CalibrationReport | null
): Promise<CalibrationReport> {
  log('Phase A: fresh 48h LIVE backtest (compareRiskLevels, parityMode)…');
  const { runBacktest } = await import('../src/backtest');

  let result: BacktestResult | null = null;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      log(`Baseline attempt ${attempt}/3…`);
      result = await runBacktest({
        hours: HOURS,
        useLiveData: true,
        allowSynthetic: false,
        compareRiskLevels: true,
        parityMode: true,
        simulations: 1,
        persistResult: true,
        strictMode: false,
        skipOptimizerOverlay: true,
      });
      assertLiveData(result, 'Phase A baseline');
      break;
    } catch (err) {
      lastErr = err;
      log(`Baseline attempt ${attempt} failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }
  if (!result) {
    throw lastErr instanceof Error
      ? lastErr
      : new Error('Phase A baseline failed after retries');
  }

  const period = {
    fromMs: result.period.fromMs,
    toMs: result.period.toMs,
    hours: result.period.hours ?? HOURS,
  };

  log('Phase A complete', {
    id: result.id,
    dataSource: result.dataSource,
    period,
    compare: result.riskComparison?.map((r) => r.message),
  });

  const report: CalibrationReport = {
    id: `cal48-${Date.now().toString(36)}`,
    generatedAt: Date.now(),
    updatedAt: Date.now(),
    phase: 'baseline',
    period,
    baselineBacktestId: result.id,
    baselineDataSource: result.dataSource,
    baselineCompare: result.riskComparison ?? null,
    risks: existing?.risks ?? [],
    scoring: {
      composite: '0.55*winRatePct + 0.45*profitScore',
      strictMode: false,
      floors: {
        low: 'trades≥max(6,35%base); WR≥base−5pp OR ≥55%; exp≥0; PF≥1.0',
        medium: 'trades≥max(8,40%base); exp≥0; PF≥1.0',
        high: 'trades≥max(10,45%base); exp≥0; PF≥0.95',
        degen:
          'trades≥max(12,50%base); exp≥−1e-6 OR ≥70%base if base>0; PF≥0.9',
      },
    },
    bakePlan: [],
    progress: { completedCandidateIds: [], lastRiskLevel: null },
    disclaimer:
      'Same-window counterfactual only — Strict Mode OFF. Live DexScreener window; no synthetic fallback.',
  };
  saveReport(report);
  return report;
}

async function phaseSearch(
  report: CalibrationReport,
  resume: boolean,
  opts: { skipDegen?: boolean } = {}
): Promise<CalibrationReport> {
  log('Phase B: deep shadow search per risk…');
  const { getLastBacktest } = await import('../src/backtest');
  const last = getLastBacktest();
  if (!last) {
    throw new Error('No last backtest — run Phase A first');
  }
  if (
    last.period?.fromMs !== report.period.fromMs ||
    last.period?.toMs !== report.period.toMs
  ) {
    log('Warning: last backtest window differs from report period; using report period');
  }

  const completed = new Set(
    resume ? report.progress?.completedCandidateIds || [] : []
  );
  const riskBlocks = new Map<RiskLevel, RiskBlock>();
  if (resume && report.risks?.length) {
    for (const r of report.risks) {
      if (isRiskLevel(r.riskLevel)) riskBlocks.set(r.riskLevel, r);
    }
  }

  // Force-skip Degen up front when requested
  let skipDegen = opts.skipDegen === true;
  if (skipDegen) {
    markDegenSkipped(report, 'skip-degen');
    riskBlocks.set(
      'degen',
      report.risks.find((r) => r.riskLevel === 'degen')!
    );
  }

  const searchLevels = RISK_LEVELS.filter((l) => !(skipDegen && l === 'degen'));

  const specsByRisk = new Map<
    RiskLevel,
    Array<{ id: string; label: string; overlay: AdvisorOverlay }>
  >();
  let total = 0;
  for (const level of searchLevels) {
    const specs = generateBakeInCandidates(level, MAX_CANDIDATES_PER_RISK);
    specsByRisk.set(level, specs);
    total += specs.length;
  }
  log(
    `Candidates planned: ${total} (~${MAX_CANDIDATES_PER_RISK}/risk)` +
      (skipDegen ? ' · Degen skipped (--skip-degen)' : '')
  );

  let done = completed.size;
  for (const level of searchLevels) {
    // Auto-skip Degen when High winner is baseline (checked before entering degen)
    if (level === 'degen') {
      const high = riskBlocks.get('high');
      if (isBaselineWinner(high)) {
        log('High winner is baseline — skipping Degen search entirely');
        markDegenSkipped(report, 'high-baseline');
        riskBlocks.set(
          'degen',
          report.risks.find((r) => r.riskLevel === 'degen')!
        );
        break;
      }
    }

    const specs = specsByRisk.get(level) || [];
    const prior = riskBlocks.get(level);
    if (prior?.skipped) {
      log(`Skipping ${level} (already marked skipped: ${prior.skipReason})`);
      continue;
    }
    const scored: ScoredCandidate[] = prior?.ranked
      ? [...prior.ranked]
      : [];
    const scoredIds = new Set(scored.map((c) => c.id));

    let baselineMetrics: CandidateMetrics | null =
      scored.find((c) => c.isBaseline)?.metrics ?? null;

    for (const spec of specs) {
      if (completed.has(spec.id) && scoredIds.has(spec.id)) {
        continue;
      }

      log(`[${done + 1}/${total}] ${level.toUpperCase()}: ${spec.label}`);
      const candidate: ScoredCandidate = {
        id: spec.id,
        riskLevel: level,
        label: spec.label,
        overlay: spec.overlay,
        isBaseline: Object.keys(spec.overlay).length === 0,
      };

      try {
        let result: BacktestResult | null = null;
        let attemptErr: unknown = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            result = await shadowRun(
              report.period,
              last.options,
              level,
              spec.overlay
            );
            assertLiveData(result, `${spec.id} attempt ${attempt}`);
            break;
          } catch (err) {
            attemptErr = err;
            log(`Shadow retry ${attempt} for ${spec.id}`, {
              error: err instanceof Error ? err.message : String(err),
            });
            await new Promise((r) => setTimeout(r, 3_000 * attempt));
          }
        }
        if (!result) {
          throw attemptErr instanceof Error
            ? attemptErr
            : new Error('shadow run failed');
        }

        const metrics = metricsFromResult(result);
        candidate.metrics = metrics;

        if (candidate.isBaseline) {
          baselineMetrics = metrics;
          candidate.passedFloors = true;
          candidate.floorNotes = [];
          candidate.scoreNote = 'Baseline';
        } else if (baselineMetrics) {
          const floors = passesBakeInFloors(level, baselineMetrics, metrics);
          candidate.passedFloors = floors.pass;
          candidate.floorNotes = floors.notes;
          candidate.scoreNote = floors.pass
            ? 'Passes bake-in floors'
            : floors.notes.join('; ');
        } else {
          candidate.passedFloors = false;
          candidate.floorNotes = ['No baseline metrics'];
          candidate.scoreNote = 'No baseline metrics';
        }

        log(
          `  → trades=${metrics.trades} WR=${metrics.winRatePct}% exp=${metrics.expectancySol} PF=${metrics.profitFactor} pnl=${metrics.totalPnlSol} pass=${candidate.passedFloors}`
        );
      } catch (err) {
        candidate.error = err instanceof Error ? err.message : String(err);
        candidate.passedFloors = false;
        candidate.floorNotes = [candidate.error];
        candidate.scoreNote = candidate.error;
        log(`  → ERROR ${candidate.error}`);
      }

      // Replace if re-run
      const idx = scored.findIndex((c) => c.id === candidate.id);
      if (idx >= 0) scored[idx] = candidate;
      else scored.push(candidate);

      completed.add(spec.id);
      done += 1;

      const ranked = rankCandidates(scored, baselineMetrics?.trades ?? 0);
      const winner =
        ranked.find((c) => c.passedFloors && !c.isBaseline) ||
        ranked.find((c) => c.passedFloors) ||
        null;

      riskBlocks.set(level, {
        riskLevel: level,
        baseline:
          ranked.find((c) => c.isBaseline) ||
          ranked[0] ||
          candidate,
        ranked,
        winnerId: winner?.id ?? null,
        winner,
      });

      // Rebuild risks list: completed search levels + skipped degen if any
      report.risks = RISK_LEVELS.map((rl) => {
        const existing = riskBlocks.get(rl);
        if (existing) return existing;
        return {
          riskLevel: rl,
          baseline: {
            id: `${rl}-pending`,
            riskLevel: rl,
            label: 'Pending',
            overlay: {},
            isBaseline: true,
          },
          ranked: [],
          winnerId: null,
          winner: null,
        };
      });
      report.progress = {
        completedCandidateIds: [...completed],
        lastRiskLevel: level,
      };
      report.phase = 'search';
      applyNoBakeNote(report);
      saveReport(report);
    }

    // After High finishes: if baseline won, skip Degen for the rest of this run
    if (level === 'high' && isBaselineWinner(riskBlocks.get('high'))) {
      log('High winner is baseline — will not run Degen candidates');
      markDegenSkipped(report, 'high-baseline');
      riskBlocks.set(
        'degen',
        report.risks.find((r) => r.riskLevel === 'degen')!
      );
      skipDegen = true;
      break;
    }
  }

  finalizeSearchReport(report, { forceSkipDegen: skipDegen });

  log('Phase B complete — winners:');
  for (const r of report.risks) {
    if (r.skipped) {
      log(`  ${r.riskLevel}: SKIPPED (${r.skipReason})`);
      continue;
    }
    const w = r.winner;
    log(
      `  ${r.riskLevel}: ${w?.id ?? 'none'} (${w?.label ?? '—'}) composite=${w?.compositeScore ?? '—'}`
    );
  }
  return report;
}

async function phaseVerify(report: CalibrationReport): Promise<CalibrationReport> {
  log('Phase C: same-window compareRiskLevels verify…');
  clearRiskRecipeOptimizations();

  const { runBacktest } = await import('../src/backtest');
  const before = report.baselineCompare;

  let result: BacktestResult | null = null;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      result = await runBacktest({
        fromMs: report.period.fromMs,
        toMs: report.period.toMs,
        hours: report.period.hours,
        useLiveData: true,
        allowSynthetic: false,
        compareRiskLevels: true,
        parityMode: true,
        simulations: 1,
        persistResult: true,
        strictMode: false,
        skipOptimizerOverlay: true,
      });
      assertLiveData(result, 'Phase C verify');
      break;
    } catch (err) {
      lastErr = err;
      log(`Verify attempt ${attempt} failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }
  if (!result) {
    throw lastErr instanceof Error
      ? lastErr
      : new Error('Phase C verify failed');
  }

  report.verify = {
    ranAt: Date.now(),
    backtestId: result.id,
    dataSource: result.dataSource,
    before,
    after: result.riskComparison ?? null,
    message: 'Same-window before/after compareRiskLevels attached',
  };
  report.phase = 'verified';
  saveReport(report);

  log('Phase C compare after bake:');
  for (const row of result.riskComparison || []) {
    log(`  ${row.message}`);
  }
  return report;
}

function printBakeInstructions(report: CalibrationReport): void {
  console.log('\n========== BAKE PLAN ==========');
  if (report.bakeNote) {
    console.log(report.bakeNote);
  }
  if (!report.bakePlan.length) {
    console.log('No non-baseline winners — keep current recipe defaults.');
    console.log('Clear riskRecipeOptimizations only (no RISK_* code edits).');
    return;
  }
  for (const b of report.bakePlan) {
    console.log(`\n[${b.riskLevel.toUpperCase()}] ${b.candidateId} — ${b.label}`);
    console.log(
      `  metrics: WR=${b.metrics?.winRatePct}% trades=${b.metrics?.trades} exp=${b.metrics?.expectancySol} PF=${b.metrics?.profitFactor} pnl=${b.metrics?.totalPnlSol}`
    );
    console.log('  toggle patches:', JSON.stringify(b.recipeTogglePatches));
    console.log('  preset patches:', JSON.stringify(b.presetPatches));
    if (b.overlay.profileParamPatches?.length) {
      console.log(
        '  profile patches:',
        JSON.stringify(b.overlay.profileParamPatches)
      );
    }
  }
  console.log('\nApply patches to:');
  console.log('  - src/strategies.ts RISK_STRATEGY_RECIPES');
  console.log('  - src/config.ts RISK_LEVEL_PRESETS (conviction/WQ/filters)');
  console.log('  - clear config.riskRecipeOptimizations');
  console.log('Then re-run: npx tsx scripts/calibrateRiskRecipes.ts --phase=verify');
  console.log('===============================\n');
}

async function main(): Promise<void> {
  const { phase, resume, skipDegen } = parseArgs();
  log('Starting Risk Recipe 48h calibration', {
    phase,
    resume,
    skipDegen,
    riskLevel: config.riskLevel,
    cwd: process.cwd(),
  });

  // Ensure synced recipe mode + no stale overlays during search
  config.strategyRecipeMode = 'synced';
  if (phase !== 'verify' && phase !== 'finalize-search') {
    clearRiskRecipeOptimizations();
  }

  let report = loadReport();

  if (phase === 'finalize-search') {
    if (!report?.period?.fromMs) {
      throw new Error('Missing report — nothing to finalize');
    }
    report = finalizeSearchReport(report, { forceSkipDegen: skipDegen });
    clearRiskRecipeOptimizations();
    printBakeInstructions(report);
    log('Search finalized', { phase: report.phase, bakeNote: report.bakeNote });
    return;
  }

  if (phase === 'all' || phase === 'baseline') {
    report = await phaseBaseline(report);
    if (phase === 'baseline') {
      log('Baseline-only done');
      return;
    }
  }

  if (phase === 'all' || phase === 'search') {
    if (!report?.period?.fromMs) {
      throw new Error('Missing baseline period — run --phase=baseline first');
    }
    report = await phaseSearch(report, resume || phase === 'all', {
      skipDegen,
    });
    printBakeInstructions(report);
    if (phase === 'search') {
      log(
        report.bakeNote
          ? 'Search done. No recipe bake needed — run --phase=verify'
          : 'Search done. Bake winners into code defaults, then run --phase=verify'
      );
      return;
    }
  }

  if (phase === 'all' || phase === 'verify') {
    if (!report?.period?.fromMs) {
      throw new Error('Missing report — run search first');
    }
    // For --phase=all we pause after search so agent can bake code.
    // If bakePlan empty / bakeNote / BAKE_SKIP=1, verify immediately.
    if (
      phase === 'all' &&
      report.bakePlan.length > 0 &&
      !report.bakeNote &&
      process.env.BAKE_SKIP !== '1'
    ) {
      log(
        'Phase all: search complete. Bake code defaults from bakePlan, then re-run with --phase=verify'
      );
      printBakeInstructions(report);
      // Write a marker so the orchestrating agent knows to bake then verify
      const marker = path.join(ensureDataDir(), 'recipeCalibration48h.bake-needed');
      fs.writeFileSync(
        marker,
        JSON.stringify(
          {
            at: Date.now(),
            bakePlan: report.bakePlan,
            outFile: outPath(),
          },
          null,
          2
        ),
        'utf-8'
      );
      return;
    }
    clearRiskRecipeOptimizations();
    report = await phaseVerify(report);
    printBakeInstructions(report);
  }

  log('Calibration finished', { out: outPath(), phase: report?.phase });
}

main().catch((err) => {
  console.error('[calibrate] FATAL', err);
  process.exitCode = 1;
});
