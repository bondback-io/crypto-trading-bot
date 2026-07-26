/**
 * Risk Recipe Win-Rate Optimizer — bounded search of module/setting combos
 * for Risk On on the same backtest window.
 *
 * Primary rank: constrained win rate (floors on trades / expectancy / PF).
 */

import fs from 'fs';
import {
  config,
  isRiskLevel,
  applyRiskLevel,
  persistUserSettings,
  RISK_LEVEL_PRESETS,
  type RiskLevel,
} from './config';
import {
  atomicWriteJson,
  dataFile,
  ensureDataDir,
  PERSIST_FILES,
} from './dataDir';
import type { BacktestOptions, BacktestResult } from './backtest';
import {
  applyAdvisorOverlay,
  analyzeBacktest,
  getLastAdvisor,
  mergeOverlays,
  type AdvisorOverlay,
} from './backtestAdvisor';
import { performanceScoreFromStats } from './performanceScore';

const DISCLAIMER =
  'Same-window counterfactual only — re-run on a second lookback before trusting winners.';

const RISK_LEVELS: Array<Exclude<RiskLevel, 'off'>> = ['on'];

export interface OptimizerCandidateMetrics {
  trades: number;
  winRatePct: number;
  expectancySol: number;
  profitFactor: number;
  maxDrawdownPct: number;
  totalPnlSol: number;
  performanceScore: number;
}

export interface OptimizerCandidate {
  id: string;
  riskLevel: RiskLevel;
  label: string;
  overlay: AdvisorOverlay;
  isBaseline?: boolean;
  passedFloors?: boolean;
  floorNotes?: string[];
  metrics?: OptimizerCandidateMetrics;
  rank?: number;
  scoreNote?: string;
  error?: string;
}

export interface OptimizerRiskResult {
  riskLevel: RiskLevel;
  baseline: OptimizerCandidate;
  ranked: OptimizerCandidate[];
  winnerId: string | null;
}

export interface OptimizerReport {
  id: string;
  generatedAt: number;
  period: { fromMs: number; toMs: number; hours: number };
  baselineBacktestId: string | null;
  risks: OptimizerRiskResult[];
  disclaimer: string;
  options: {
    maxCandidatesPerRisk: number;
    risks: RiskLevel[];
  };
}

export interface OptimizerProgress {
  running: boolean;
  phase: string;
  riskLevel: RiskLevel | null;
  /** Candidates completed so far */
  current: number;
  /** Alias of `current` for UI polling */
  done: number;
  total: number;
  candidateId: string | null;
  message: string;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}

export interface OptimizerRunOptions {
  fromMs?: number;
  toMs?: number;
  hours?: number;
  risks?: RiskLevel[];
  maxCandidatesPerRisk?: number;
  /** Inherit filters/window from last backtest when present */
  useLastBacktestWindow?: boolean;
}

export interface RiskRecipeOptimizationEntry {
  overlay: AdvisorOverlay;
  label: string;
  candidateId: string;
  appliedAt: number;
  metrics?: OptimizerCandidateMetrics;
}

let lastOptimizer: OptimizerReport | null = null;
let abortRequested = false;
let progress: OptimizerProgress = {
  running: false,
  phase: 'idle',
  riskLevel: null,
  current: 0,
  done: 0,
  total: 0,
  candidateId: null,
  message: '',
  startedAt: null,
  finishedAt: null,
  error: null,
};

function optimizerFile(): string {
  return dataFile(PERSIST_FILES.optimizerLast);
}

export function getOptimizerProgress(): OptimizerProgress {
  return { ...progress, done: progress.current };
}

/** Request graceful stop of the in-flight optimizer search. */
export function requestOptimizerStop(): { ok: boolean; message: string } {
  if (!progress.running) {
    return { ok: false, message: 'No optimizer running' };
  }
  abortRequested = true;
  setProgress({
    message: 'Stopping optimizer…',
  });
  return { ok: true, message: 'Stop requested' };
}

export function getLastOptimizer(): OptimizerReport | null {
  return lastOptimizer;
}

export function loadOptimizerFromDisk(): OptimizerReport | null {
  try {
    const p = optimizerFile();
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as OptimizerReport;
    if (raw && Array.isArray(raw.risks)) {
      lastOptimizer = raw;
      return raw;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function saveOptimizerToDisk(report: OptimizerReport): void {
  try {
    ensureDataDir();
    atomicWriteJson(optimizerFile(), report);
  } catch (err) {
    console.warn(
      '[optimizer] Failed to persist report:',
      err instanceof Error ? err.message : err
    );
  }
}

function setProgress(patch: Partial<OptimizerProgress>): void {
  progress = { ...progress, ...patch };
  if (patch.current != null) progress.done = patch.current;
  else progress.done = progress.current;
}

/** Pure floor check — constrained WR search. */
export function passesConstrainedFloors(
  baseline: OptimizerCandidateMetrics,
  candidate: OptimizerCandidateMetrics
): { pass: boolean; notes: string[] } {
  const notes: string[] = [];
  const minTrades = Math.max(8, Math.ceil(baseline.trades * 0.4));
  if (candidate.trades < minTrades) {
    notes.push(`trades ${candidate.trades} < floor ${minTrades}`);
  }

  const expFloor =
    baseline.expectancySol > 0 ? baseline.expectancySol * 0.7 : 0;
  if (candidate.expectancySol < expFloor - 1e-9) {
    notes.push(
      `expectancy ${candidate.expectancySol.toFixed(4)} < floor ${expFloor.toFixed(4)}`
    );
  }

  // PF ≥ 1.0, or ≥ baseline when baseline PF is positive but below 1
  const pfFloor =
    baseline.profitFactor > 0 && baseline.profitFactor < 1
      ? baseline.profitFactor
      : 1;
  if (candidate.profitFactor < pfFloor - 1e-9) {
    notes.push(
      `PF ${candidate.profitFactor.toFixed(2)} < floor ${pfFloor.toFixed(2)}`
    );
  }

  return { pass: notes.length === 0, notes };
}

/** Sort comparator: passers first, then WR, then expectancy, PF, DD, trade proximity. */
export function compareOptimizerCandidates(
  a: OptimizerCandidate,
  b: OptimizerCandidate,
  baselineTrades: number
): number {
  const ap = a.passedFloors === true ? 1 : 0;
  const bp = b.passedFloors === true ? 1 : 0;
  if (ap !== bp) return bp - ap;

  const aw = a.metrics?.winRatePct ?? -1;
  const bw = b.metrics?.winRatePct ?? -1;
  if (Math.abs(bw - aw) > 0.05) return bw - aw;

  const ae = a.metrics?.expectancySol ?? -999;
  const be = b.metrics?.expectancySol ?? -999;
  if (Math.abs(be - ae) > 1e-6) return be - ae;

  const af = a.metrics?.profitFactor ?? 0;
  const bf = b.metrics?.profitFactor ?? 0;
  if (Math.abs(bf - af) > 0.01) return bf - af;

  const ad = a.metrics?.maxDrawdownPct ?? 999;
  const bd = b.metrics?.maxDrawdownPct ?? 999;
  if (Math.abs(ad - bd) > 0.05) return ad - bd;

  const at = a.metrics?.trades ?? 0;
  const bt = b.metrics?.trades ?? 0;
  const da = Math.abs(at - baselineTrades);
  const db = Math.abs(bt - baselineTrades);
  return da - db;
}

function metricsFromResult(result: BacktestResult): OptimizerCandidateMetrics {
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

function cloneOverlay(o: AdvisorOverlay): AdvisorOverlay {
  return mergeOverlays([o]);
}

function bumpConviction(base: number, delta: number): number {
  return Math.min(85, Math.max(15, Math.round(base + delta)));
}

function bumpQuality(base: number, delta: number): number {
  return Math.min(85, Math.max(30, Math.round(base + delta)));
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
 * Bounded candidate set (~12–24) from recipe base + curated mutations.
 */
export function generateOptimizerCandidates(
  riskLevel: RiskLevel,
  maxCandidates: number,
  baseConviction: number,
  baseQuality: number
): Array<{ id: string; label: string; overlay: AdvisorOverlay }> {
  const out: Array<{ id: string; label: string; overlay: AdvisorOverlay }> = [];
  const push = (id: string, label: string, overlay: AdvisorOverlay) => {
    if (out.length >= maxCandidates) return;
    out.push({ id: `${riskLevel}-${id}`, label, overlay: cloneOverlay(overlay) });
  };

  push('baseline', 'Baseline recipe', {});

  push('elite-on', 'Elite Convergence ON', {
    toggles: { elite_convergence: true },
  });

  push('quality-pack', 'Quality pack (elite + hard gate + WQ+5)', {
    toggles: {
      elite_convergence: true,
      hard_quality_gate: true,
      wallet_quality_scoring: true,
    },
    minWalletQualityScore: bumpQuality(baseQuality, 5),
  });

  push('conv-p5', `Conviction +5 → ${bumpConviction(baseConviction, 5)}`, {
    toggles: { multi_factor_conviction: true },
    minConvictionScore: bumpConviction(baseConviction, 5),
  });

  push('conv-p10', `Conviction +10 → ${bumpConviction(baseConviction, 10)}`, {
    toggles: { multi_factor_conviction: true },
    minConvictionScore: bumpConviction(baseConviction, 10),
  });

  push('conv-wq', 'Conviction +8 + quality +5', {
    toggles: {
      multi_factor_conviction: true,
      wallet_quality_scoring: true,
      elite_convergence: true,
    },
    minConvictionScore: bumpConviction(baseConviction, 8),
    minWalletQualityScore: bumpQuality(baseQuality, 5),
  });

  push('early-mom', 'Early entry + momentum confirmation', {
    toggles: {
      early_entry_only: true,
      momentum_confirmation: true,
      time_based_entry: true,
    },
  });

  push('vol-liq-on', 'Volume / Liquidity filters ON', {
    toggles: { volume_liquidity_filters: true, min_holders_activity: true },
  });

  push('scanner-55', 'Scanner rank ≥ 55 + TA setup path', {
    toggles: { ta_market_scanner: true },
    minRankScore: 55,
  });

  push('scanner-65', 'Scanner rank ≥ 65 (tighter)', {
    toggles: { ta_market_scanner: true },
    minRankScore: 65,
  });

  push('scalps-off', 'All scalp engines OFF', {
    toggles: {
      micro_scalper: false,
      momentum_burst: false,
      post_migration_scalp: false,
      reversal_scalp: false,
      quick_scalper: false,
    },
  });

  push('post-mig-off', 'Post-migration scalp OFF', {
    toggles: { post_migration_scalp: false },
  });

  push('micro-mom-on', 'Micro + momentum scalp ON (others off)', {
    toggles: {
      micro_scalper: true,
      momentum_burst: true,
      post_migration_scalp: false,
      reversal_scalp: false,
      quick_scalper: false,
    },
  });

  push('profit-bond', 'Profit-protected + bonding health', {
    toggles: {
      profit_protected: true,
      bonding_curve_health: true,
    },
  });

  push('sniper-on', 'Sniper / bundler filters ON', {
    toggles: { sniper_bundler_filters: true },
  });

  push('mirror-sl', 'Widen Mirror SL 14–20%', {
    profileParamPatches: [
      {
        id: 'smart_money_mirror',
        params: {
          exitRules: {
            stopLossPctMin: 14,
            stopLossPctMax: 20,
          },
        },
      },
    ],
  });

  push('wr-combo', 'WR combo: elite + conv+10 + vol + scalps off', {
    toggles: {
      elite_convergence: true,
      multi_factor_conviction: true,
      volume_liquidity_filters: true,
      wallet_quality_scoring: true,
      micro_scalper: false,
      momentum_burst: false,
      post_migration_scalp: false,
      reversal_scalp: false,
    },
    minConvictionScore: bumpConviction(baseConviction, 10),
    minWalletQualityScore: bumpQuality(baseQuality, 5),
  });

  // Seed from Smart Advisor tips when available
  const advisor = getLastAdvisor();
  if (advisor?.recommendations?.length) {
    for (const rec of advisor.recommendations.slice(0, 4)) {
      if (!rec.overlay || Object.keys(rec.overlay).length === 0) continue;
      const sid = `adv-${rec.id}`.slice(0, 40);
      push(sid, `Advisor: ${rec.title}`.slice(0, 72), rec.overlay);
    }
  }

  return out.slice(0, Math.max(1, maxCandidates));
}

async function shadowRun(
  period: { fromMs: number; toMs: number; hours: number },
  baseOpts: BacktestResult['options'] | undefined,
  riskLevel: RiskLevel,
  overlay: AdvisorOverlay
): Promise<BacktestResult> {
  const { runBacktest } = await import('./backtest');
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
    useLiveData: baseOpts?.useLiveData !== false,
    allowSynthetic: false,
    startingBalanceSol: baseOpts?.startingBalanceSol,
    riskLevel,
    compareRiskLevels: false,
    useSavedConfigFilters: true,
    parityMode: true,
    persistResult: false,
    skipOptimizerOverlay: true,
    advisorOverlay: overlay,
    minConvictionScore: overlay.minConvictionScore,
    minWalletQualityScore: overlay.minWalletQualityScore,
  } as BacktestOptions);
}

function resolvePeriod(
  options: OptimizerRunOptions,
  last: BacktestResult | null
): { fromMs: number; toMs: number; hours: number } {
  if (
    options.useLastBacktestWindow !== false &&
    last?.period?.fromMs != null &&
    last?.period?.toMs != null
  ) {
    const hours =
      last.period.hours ??
      Math.max(1, (last.period.toMs - last.period.fromMs) / 3_600_000);
    return {
      fromMs: last.period.fromMs,
      toMs: last.period.toMs,
      hours,
    };
  }
  const toMs = options.toMs ?? Date.now();
  const hours = options.hours ?? last?.options?.hours ?? 24;
  const fromMs = options.fromMs ?? toMs - hours * 3_600_000;
  return { fromMs, toMs, hours };
}

function finalizeRiskBlock(
  level: RiskLevel,
  scored: OptimizerCandidate[],
  baselineMetrics: OptimizerCandidateMetrics | null
): OptimizerRiskResult {
  const baseTrades = baselineMetrics?.trades ?? 0;
  const baseline =
    scored.find((c) => c.isBaseline) ||
    scored[0] ||
    ({
      id: `${level}-missing`,
      riskLevel: level,
      label: 'Missing baseline',
      overlay: {},
      isBaseline: true,
      passedFloors: false,
    } as OptimizerCandidate);

  const ranked = [...scored].sort((a, b) =>
    compareOptimizerCandidates(a, b, baseTrades)
  );
  ranked.forEach((c, i) => {
    c.rank = i + 1;
  });

  const winner =
    ranked.find((c) => c.passedFloors && !c.isBaseline) ||
    ranked.find((c) => c.passedFloors) ||
    null;

  return {
    riskLevel: level,
    baseline,
    ranked,
    winnerId: winner?.id ?? null,
  };
}

/**
 * Run bounded optimizer across selected risk levels on one event window.
 */
export async function runRiskRecipeOptimizer(
  options: OptimizerRunOptions = {}
): Promise<OptimizerReport> {
  if (progress.running) {
    throw new Error('Optimizer already running');
  }

  abortRequested = false;

  // Claim the run immediately so POST /optimize + progress polls see running=true
  // before await points (last BT load, candidate gen, shadow runs).
  setProgress({
    running: true,
    phase: 'starting',
    riskLevel: null,
    current: 0,
    done: 0,
    total: 0,
    candidateId: null,
    message: 'Starting Risk Recipe Optimizer…',
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
  });

  try {
    const { getLastBacktest } = await import('./backtest');
    const last = getLastBacktest();
    if (!last) {
      throw new Error(
        'Run a backtest first so the optimizer can reuse the window'
      );
    }

    const risks = (options.risks?.length
      ? options.risks.filter(isRiskLevel)
      : RISK_LEVELS) as RiskLevel[];
    if (!risks.length) {
      throw new Error('Select at least one risk level');
    }

    const maxPer = Math.max(
      4,
      Math.min(24, Math.floor(options.maxCandidatesPerRisk ?? 16))
    );
    const period = resolvePeriod(options, last);

    // Prefetch advisor seeds from last BT (optional)
    try {
      if (!(getLastAdvisor()?.baselineId === last.id)) {
        analyzeBacktest(last);
      }
    } catch {
      /* non-fatal */
    }

    if (abortRequested) {
      setProgress({
        running: false,
        phase: 'cancelled',
        message: 'Optimizer stopped by user',
        error: null,
        finishedAt: Date.now(),
        candidateId: null,
      });
      abortRequested = false;
      return (
        lastOptimizer || {
          id: `opt-${Date.now().toString(36)}`,
          generatedAt: Date.now(),
          period,
          baselineBacktestId: last.id,
          risks: [],
          disclaimer: DISCLAIMER,
          options: { maxCandidatesPerRisk: maxPer, risks },
        }
      );
    }

    const specsByRisk = new Map<
      RiskLevel,
      Array<{ id: string; label: string; overlay: AdvisorOverlay }>
    >();
    let total = 0;
    for (const level of risks) {
      const floors = recipeBaseFloors(level);
      const specs = generateOptimizerCandidates(
        level,
        maxPer,
        floors.conviction,
        floors.quality
      );
      specsByRisk.set(level, specs);
      total += specs.length;
    }

    setProgress({
      phase: 'running',
      riskLevel: risks[0],
      current: 0,
      done: 0,
      total,
      message: 'Scoring candidates…',
    });

    const riskResults: OptimizerRiskResult[] = [];
    let done = 0;
    let cancelled = false;

    for (const level of risks) {
      if (abortRequested) {
        cancelled = true;
        break;
      }

      setProgress({
        riskLevel: level,
        message: `Scoring ${level.toUpperCase()} candidates…`,
      });

      const specs = specsByRisk.get(level) || [];
      const scored: OptimizerCandidate[] = [];
      let baselineMetrics: OptimizerCandidateMetrics | null = null;

      for (const spec of specs) {
        if (abortRequested) {
          cancelled = true;
          break;
        }

        setProgress({
          current: done,
          done,
          candidateId: spec.id,
          message: `${level.toUpperCase()}: ${spec.label}`,
        });

        const candidate: OptimizerCandidate = {
          id: spec.id,
          riskLevel: level,
          label: spec.label,
          overlay: spec.overlay,
          isBaseline: Object.keys(spec.overlay).length === 0,
        };

        try {
          const result = await shadowRun(
            period,
            last.options,
            level,
            spec.overlay
          );
          const metrics = metricsFromResult(result);
          candidate.metrics = metrics;

          if (candidate.isBaseline) {
            baselineMetrics = metrics;
            candidate.passedFloors = true;
            candidate.floorNotes = [];
            candidate.scoreNote = 'Baseline';
          } else if (baselineMetrics) {
            const floors = passesConstrainedFloors(baselineMetrics, metrics);
            candidate.passedFloors = floors.pass;
            candidate.floorNotes = floors.notes;
            candidate.scoreNote = floors.pass
              ? 'Passes constrained WR floors'
              : floors.notes.join('; ');
          } else {
            candidate.passedFloors = false;
            candidate.floorNotes = ['No baseline metrics to compare'];
            candidate.scoreNote = 'No baseline metrics';
          }
        } catch (err) {
          candidate.error =
            err instanceof Error ? err.message : 'Shadow run failed';
          candidate.passedFloors = false;
          candidate.floorNotes = [candidate.error];
          candidate.scoreNote = candidate.error;
        }

        scored.push(candidate);
        done += 1;
        setProgress({ current: done, done });
      }

      if (scored.length) {
        riskResults.push(
          finalizeRiskBlock(level, scored, baselineMetrics)
        );
      }

      if (cancelled) break;
    }

    const report: OptimizerReport = {
      id: `opt-${Date.now().toString(36)}`,
      generatedAt: Date.now(),
      period,
      baselineBacktestId: last.id,
      risks: riskResults,
      disclaimer: DISCLAIMER,
      options: {
        maxCandidatesPerRisk: maxPer,
        risks,
      },
    };

    if (cancelled || abortRequested) {
      abortRequested = false;
      if (riskResults.length) {
        lastOptimizer = report;
        saveOptimizerToDisk(report);
      }
      setProgress({
        running: false,
        phase: 'cancelled',
        message: 'Optimizer stopped by user',
        error: null,
        finishedAt: Date.now(),
        candidateId: null,
      });
      return report;
    }

    lastOptimizer = report;
    saveOptimizerToDisk(report);
    setProgress({
      running: false,
      phase: 'done',
      message: 'Optimizer finished',
      finishedAt: Date.now(),
      current: total,
      done: total,
      candidateId: null,
    });
    return report;
  } catch (err) {
    abortRequested = false;
    const message = err instanceof Error ? err.message : String(err);
    setProgress({
      running: false,
      phase: 'error',
      message,
      error: message,
      finishedAt: Date.now(),
      candidateId: null,
    });
    throw err;
  }
}

/**
 * Persist selected winners as per-risk recipe overlays.
 * Applied after synced recipe on Risk Level change; Strict stays untouched.
 */
export function applyOptimizerWinnersToRecipes(
  selections: Array<{ riskLevel: RiskLevel; candidateId: string }>
): {
  ok: boolean;
  applied: string[];
  message: string;
} {
  if (!lastOptimizer) {
    loadOptimizerFromDisk();
  }
  if (!lastOptimizer) {
    return { ok: false, applied: [], message: 'No optimizer report to apply' };
  }

  if (!config.riskRecipeOptimizations) {
    config.riskRecipeOptimizations = {};
  }

  const applied: string[] = [];
  for (const sel of selections) {
    if (!isRiskLevel(sel.riskLevel) || sel.riskLevel === 'off') continue;
    const block = lastOptimizer.risks.find(
      (r) => r.riskLevel === sel.riskLevel
    );
    if (!block) continue;
    const cand =
      block.ranked.find((c) => c.id === sel.candidateId) ||
      (block.winnerId
        ? block.ranked.find((c) => c.id === block.winnerId)
        : null);
    if (!cand) continue;

    config.riskRecipeOptimizations[sel.riskLevel] = {
      overlay: cloneOverlay(cand.overlay),
      label: cand.label,
      candidateId: cand.id,
      appliedAt: Date.now(),
      metrics: cand.metrics,
    };
    applied.push(`${sel.riskLevel}:${cand.id}`);
  }

  if (!applied.length) {
    return { ok: false, applied: [], message: 'No matching candidates' };
  }

  // Re-stack current risk recipe + stored overlay (Strict untouched)
  const current = config.riskLevel;
  if (isRiskLevel(current)) {
    config.strategyRecipeMode = 'synced';
    applyRiskLevel(current, { persist: false });
  }

  persistUserSettings();
  console.log(`[optimizer] Applied recipe overlays: ${applied.join(', ')}`);
  return {
    ok: true,
    applied,
    message: `Applied ${applied.length} risk recipe overlay(s). Strict Mode unchanged.`,
  };
}

/** Apply stored optimization overlay after risk recipe (called from applyRiskLevel). */
export function applyStoredRiskRecipeOptimization(level: RiskLevel): void {
  if (level === 'off') return;
  const entry = config.riskRecipeOptimizations?.[level];
  if (!entry?.overlay) return;
  applyAdvisorOverlay(entry.overlay, { persist: false });
}
