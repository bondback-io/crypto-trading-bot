/**
 * Backtester Smart Advisor — cluster losers / skips, propose one-knob
 * counterfactuals, shadow re-score on the same window, apply to live.
 */

import { config, effectiveMinMarketCapUsd, persistUserSettings } from './config';
import type { BacktestResult, BacktestOptions } from './backtest';
import {
  ensureStrategyToggles,
  isStrategyEnabled,
  isStrategyKey,
  updateStrategyToggles,
  type StrategyKey,
  type StrategyToggleMap,
} from './strategies';
import {
  ensureTradeProfilesInitialized,
  setTradeProfileEnabled,
  type TradeProfileId,
} from './tradeProfiles';

export interface AdvisorOverlay {
  toggles?: Partial<Record<StrategyKey, boolean>>;
  /** Absolute selective min conviction for this run / apply */
  minConvictionScore?: number;
  /** Absolute wallet quality floor */
  minWalletQualityScore?: number;
  /** Absolute min market-cap USD override */
  minMarketCapUsd?: number;
  /** Trade Profile ids to disable */
  disableProfileIds?: TradeProfileId[];
}

export type AdvisorFamily =
  | 'tighten'
  | 'loosen'
  | 'toggle_off'
  | 'toggle_on'
  | 'profile';

export interface AdvisorRecommendation {
  id: string;
  title: string;
  family: AdvisorFamily;
  rationale: string;
  evidenceCount: number;
  overlay: AdvisorOverlay;
  scored?: boolean;
  keep?: boolean;
  deltaWinRatePct?: number;
  deltaProfitFactor?: number;
  deltaPnlSol?: number;
  deltaLoserCount?: number;
  baselineTrades?: number;
  candidateTrades?: number;
  candidateWinRatePct?: number;
  candidateProfitFactor?: number;
  candidatePnlSol?: number;
  scoreNote?: string;
}

export interface AdvisorCluster {
  key: string;
  label: string;
  count: number;
}

export interface AdvisorReport {
  generatedAt: number;
  baselineId: string;
  loserCount: number;
  winCount: number;
  eowCount: number;
  skipCount: number;
  loserClusters: AdvisorCluster[];
  skipClusters: AdvisorCluster[];
  recommendations: AdvisorRecommendation[];
  disclaimer: string;
}

const DISCLAIMER =
  'Counterfactual on this backtest window only — not a live forward guarantee. Review before applying to Strategies.';

let lastAdvisor: AdvisorReport | null = null;

export function getLastAdvisor(): AdvisorReport | null {
  return lastAdvisor;
}

export function setLastAdvisor(report: AdvisorReport | null): void {
  lastAdvisor = report;
}

/** Merge multiple one-knob overlays into a single overlay (last write wins per field). */
export function mergeOverlays(overlays: AdvisorOverlay[]): AdvisorOverlay {
  const out: AdvisorOverlay = { toggles: {} };
  const profiles = new Set<TradeProfileId>();
  for (const o of overlays) {
    if (o.toggles) {
      out.toggles = { ...(out.toggles || {}), ...o.toggles };
    }
    if (o.minConvictionScore != null) {
      out.minConvictionScore = o.minConvictionScore;
    }
    if (o.minWalletQualityScore != null) {
      out.minWalletQualityScore = o.minWalletQualityScore;
    }
    if (o.minMarketCapUsd != null) {
      out.minMarketCapUsd = o.minMarketCapUsd;
    }
    if (o.disableProfileIds?.length) {
      for (const id of o.disableProfileIds) profiles.add(id);
    }
  }
  if (profiles.size) out.disableProfileIds = [...profiles];
  if (out.toggles && Object.keys(out.toggles).length === 0) {
    delete out.toggles;
  }
  return out;
}

/**
 * Apply overlay onto live `config` for a backtest run or permanent apply.
 * When persist=false, snapshot/restore in runBacktest cleans up.
 */
export function applyAdvisorOverlay(
  overlay: AdvisorOverlay,
  options: { persist?: boolean } = {}
): void {
  const persist = options.persist === true;
  ensureStrategyToggles();
  ensureTradeProfilesInitialized();

  if (overlay.toggles && Object.keys(overlay.toggles).length) {
    const partial: Partial<StrategyToggleMap> = {};
    for (const [k, v] of Object.entries(overlay.toggles)) {
      if (isStrategyKey(k) && typeof v === 'boolean') {
        partial[k] = v;
      }
    }
    if (Object.keys(partial).length) {
      updateStrategyToggles(partial, {
        persist,
        markCustom: persist,
        syncUnderlying: true,
      });
    }
  }

  if (overlay.minConvictionScore != null && overlay.minConvictionScore > 0) {
    config.selective.minConvictionScore = Number(overlay.minConvictionScore);
  }
  if (
    overlay.minWalletQualityScore != null &&
    overlay.minWalletQualityScore > 0
  ) {
    config.filters.minWalletQualityScore = Number(
      overlay.minWalletQualityScore
    );
    config.filters.enableWalletQualityGate = true;
  }
  if (overlay.minMarketCapUsd != null && overlay.minMarketCapUsd > 0) {
    config.filters.minMarketCapUsd = Number(overlay.minMarketCapUsd);
  }

  if (overlay.disableProfileIds?.length) {
    for (const id of overlay.disableProfileIds) {
      if (persist) {
        setTradeProfileEnabled(id, false);
      } else if (config.tradeProfiles?.profiles) {
        config.tradeProfiles.profiles[id] = false;
      }
    }
  }

  if (persist) {
    persistUserSettings();
  }
}

function bumpCount(map: Map<string, number>, key: string, n = 1): void {
  map.set(key, (map.get(key) || 0) + n);
}

function topClusters(
  map: Map<string, number>,
  limit: number
): AdvisorCluster[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({
      key,
      label: key,
      count,
    }));
}

function normalizeExitReason(reason: string): string {
  const r = String(reason || '').trim();
  if (/SCALP_TIMER|timer/i.test(r)) return 'scalp timer';
  if (/SCALP_SL|stop-loss|stop loss/i.test(r)) return 'stop-loss';
  if (/SCALP_TP|take-profit|take profit/i.test(r)) return 'take-profit';
  if (/trail/i.test(r)) return 'trailing stop';
  if (/dead.?market|dead.?volume/i.test(r)) return 'dead market';
  if (/end-of-window/i.test(r)) return 'end-of-window';
  if (/momentum fail|SCALP_SIGNAL_FAIL/i.test(r)) return 'momentum fail';
  return r.replace(/\s*\(.*$/, '').slice(0, 40) || 'other';
}

function normalizeSkipReason(reason: string): string {
  let key = String(reason || '');
  if (key.startsWith('conviction')) return 'conviction';
  if (key.startsWith('low volume') || key.startsWith('missing volume'))
    return 'volume';
  if (key.startsWith('low liquidity') || key.startsWith('missing liquidity'))
    return 'liquidity';
  if (key.startsWith('missing market cap') || key.startsWith('low MC'))
    return 'market cap';
  if (key.startsWith('risk score')) return 'risk';
  if (key.startsWith('trade profile')) return 'trade profile';
  if (key.startsWith('trade cap') || key.startsWith('cooldown'))
    return 'rate limit';
  if (key.startsWith('max concurrent')) return 'concurrent';
  return key.replace(/\s*\(.*$/, '').slice(0, 36);
}

/** Propose one-knob recipes from loser / skip clusters (not yet scored). */
export function analyzeBacktest(result: BacktestResult): AdvisorReport {
  const trades = result.trades || [];
  const losers = trades.filter((t) => t.pnlSol <= 0 && !t.forcedEndOfWindow);
  const wins = trades.filter((t) => t.pnlSol > 0);
  const eow = trades.filter((t) => t.forcedEndOfWindow);
  const skips = result.skipped || [];

  const exitMap = new Map<string, number>();
  const profileMap = new Map<string, number>();
  const scalpMap = new Map<string, number>();
  const skipMap = new Map<string, number>();

  for (const t of losers) {
    bumpCount(exitMap, normalizeExitReason(t.reason));
    bumpCount(
      profileMap,
      t.tradeProfileId || t.tradeProfileName || 'unassigned'
    );
    if (t.shortTermStrategyId) {
      bumpCount(scalpMap, t.shortTermStrategyId);
    }
    if ((t.smartWalletCount ?? t.sourceNames?.length ?? 0) <= 1) {
      bumpCount(exitMap, 'single-wallet entry');
    }
  }
  for (const s of skips) {
    bumpCount(skipMap, normalizeSkipReason(s.reason));
  }

  const loserClusters = topClusters(exitMap, 6);
  const skipClusters = topClusters(skipMap, 6);
  const recommendations: AdvisorRecommendation[] = [];
  const seen = new Set<string>();

  const push = (rec: AdvisorRecommendation) => {
    if (seen.has(rec.id)) return;
    seen.add(rec.id);
    recommendations.push(rec);
  };

  const convBase = Number(config.selective.minConvictionScore ?? 50);
  const wqBase = Number(config.filters.minWalletQualityScore ?? 50);
  const mcBase = Math.max(
    Number(result.configUsed?.minMarketCapUsd ?? 0),
    effectiveMinMarketCapUsd() || 0
  );

  // Profile underperformers
  for (const p of result.summary?.profileBreakdown || []) {
    if (
      p.trades >= 3 &&
      p.winRatePct < 35 &&
      p.profileId &&
      p.profileId !== 'default' &&
      p.profileId !== 'unassigned' &&
      p.profileId !== 'skipped'
    ) {
      push({
        id: `profile-off-${p.profileId}`,
        title: `Disable Trade Profile: ${p.name}`,
        family: 'profile',
        rationale: `${p.icon || ''} ${p.name} went ${p.wins}W/${p.losses}L (WR ${p.winRatePct.toFixed(0)}%, PnL ${p.totalPnlSol.toFixed(3)} SOL) on this window`.trim(),
        evidenceCount: p.losses,
        overlay: { disableProfileIds: [p.profileId as TradeProfileId] },
      });
    }
  }

  // Scalp engines dominating losses
  for (const [engine, n] of scalpMap.entries()) {
    if (n < 2) continue;
    if (
      engine === 'momentum_burst' ||
      engine === 'micro_scalper' ||
      engine === 'post_migration_scalp' ||
      engine === 'quick_scalper' ||
      engine === 'reversal_scalp'
    ) {
      if (isStrategyEnabled(engine as StrategyKey)) {
        push({
          id: `toggle-off-${engine}`,
          title: `Turn OFF ${engine.replace(/_/g, ' ')}`,
          family: 'toggle_off',
          rationale: `${n} losing trade(s) used short-term engine ${engine}`,
          evidenceCount: n,
          overlay: { toggles: { [engine as StrategyKey]: false } },
        });
      }
    }
  }

  // Timer exits → often scalp packs too aggressive
  const timerN = exitMap.get('scalp timer') || 0;
  if (timerN >= 3) {
    if (isStrategyEnabled('micro_scalper')) {
      push({
        id: 'toggle-off-micro_scalper-timer',
        title: 'Turn OFF micro scalper (timer losses)',
        family: 'toggle_off',
        rationale: `${timerN} losers closed on scalp timer — micro scalper often over-trades`,
        evidenceCount: timerN,
        overlay: { toggles: { micro_scalper: false } },
      });
    }
    if (isStrategyEnabled('momentum_burst')) {
      push({
        id: 'toggle-off-momentum_burst-timer',
        title: 'Turn OFF momentum burst (timer losses)',
        family: 'toggle_off',
        rationale: `${timerN} losers closed on scalp timer — consider disabling momentum burst`,
        evidenceCount: timerN,
        overlay: { toggles: { momentum_burst: false } },
      });
    }
  }

  // Stop-loss cluster → tighten conviction / quality
  const slN = exitMap.get('stop-loss') || 0;
  if (slN >= 2 || losers.length >= 3) {
    push({
      id: 'tighten-conviction-5',
      title: 'Raise min conviction +5',
      family: 'tighten',
      rationale: `${losers.length} strategy losers (${slN} via stop-loss) — raise selective floor to ${convBase + 5}`,
      evidenceCount: Math.max(slN, losers.length),
      overlay: { minConvictionScore: convBase + 5 },
    });
    push({
      id: 'tighten-wallet-q-5',
      title: 'Raise min wallet quality +5',
      family: 'tighten',
      rationale: `Lift wallet quality floor to ${wqBase + 5} to skip weaker copy sources`,
      evidenceCount: losers.length,
      overlay: { minWalletQualityScore: wqBase + 5 },
    });
  }

  if (losers.length >= 4 && mcBase > 0) {
    const raised = Math.round(mcBase * 1.25);
    push({
      id: 'tighten-min-mc',
      title: `Raise min market cap to $${raised.toLocaleString()}`,
      family: 'tighten',
      rationale: `Many losers entered; raise MC floor ~25% above current effective $${Math.round(mcBase).toLocaleString()}`,
      evidenceCount: losers.length,
      overlay: { minMarketCapUsd: raised },
    });
  }

  // Single-wallet losers → elite convergence
  const singleN = exitMap.get('single-wallet entry') || 0;
  if (singleN >= 3 && !isStrategyEnabled('elite_convergence')) {
    push({
      id: 'toggle-on-elite_convergence',
      title: 'Turn ON Elite Convergence',
      family: 'toggle_on',
      rationale: `${singleN} losers were single-wallet entries — require multi-wallet clusters`,
      evidenceCount: singleN,
      overlay: { toggles: { elite_convergence: true } },
    });
  }

  if (singleN >= 2 && !isStrategyEnabled('hard_quality_gate')) {
    push({
      id: 'toggle-on-hard_quality_gate',
      title: 'Turn ON Hard Quality Gate',
      family: 'toggle_on',
      rationale: `${singleN} weak-wallet losers — raise quality floor via Hard Quality Gate`,
      evidenceCount: singleN,
      overlay: { toggles: { hard_quality_gate: true } },
    });
  }

  // Dead market exits → ensure module on
  const deadN = exitMap.get('dead market') || 0;
  if (deadN >= 2 && !isStrategyEnabled('dead_market_exit')) {
    push({
      id: 'toggle-on-dead_market_exit',
      title: 'Turn ON Dead Market Exit',
      family: 'toggle_on',
      rationale: `${deadN} losers look like stalled books — enable dead-market exit`,
      evidenceCount: deadN,
      overlay: { toggles: { dead_market_exit: true } },
    });
  }

  // Thin volume skips / losers
  const volSkips = skipMap.get('volume') || 0;
  if (
    (volSkips >= 3 || losers.length >= 3) &&
    !isStrategyEnabled('volume_liquidity_filters')
  ) {
    push({
      id: 'toggle-on-volume_liquidity_filters',
      title: 'Turn ON Volume / Liquidity Filters',
      family: 'toggle_on',
      rationale: `${volSkips} volume skips and ${losers.length} losers — enforce vol/liq floors`,
      evidenceCount: Math.max(volSkips, losers.length),
      overlay: { toggles: { volume_liquidity_filters: true } },
    });
  }

  // Migration sniper module when migration profile loses heavily
  const migProfileLosses = losers.filter(
    (t) => t.tradeProfileId === 'migration_sniper'
  ).length;
  if (
    migProfileLosses >= 2 &&
    isStrategyEnabled('migration_sniper')
  ) {
    push({
      id: 'toggle-off-migration_sniper-module',
      title: 'Turn OFF Migration Sniper Mode',
      family: 'toggle_off',
      rationale: `${migProfileLosses} Migration Sniper profile losers — disable migration-only entry mode`,
      evidenceCount: migProfileLosses,
      overlay: { toggles: { migration_sniper: false } },
    });
  }

  // Loosen when skips dominate (starved sample)
  if (skips.length >= 8 && skips.length > losers.length * 2) {
    const topSkip = skipClusters[0]?.key || 'filters';
    if (topSkip === 'conviction' || convBase > 40) {
      push({
        id: 'loosen-conviction-5',
        title: 'Lower min conviction −5',
        family: 'loosen',
        rationale: `${skips.length} skips (top: ${topSkip}) vs ${losers.length} losers — sample may be over-filtered`,
        evidenceCount: skips.length,
        overlay: { minConvictionScore: Math.max(20, convBase - 5) },
      });
    }
    if (topSkip === 'volume' || wqBase > 40) {
      push({
        id: 'loosen-wallet-q-5',
        title: 'Lower min wallet quality −5',
        family: 'loosen',
        rationale: `High skip rate (${skips.length}) — ease wallet quality to ${Math.max(20, wqBase - 5)}`,
        evidenceCount: skips.length,
        overlay: { minWalletQualityScore: Math.max(20, wqBase - 5) },
      });
    }
  }

  // Cap candidate list; prefer higher evidence
  recommendations.sort((a, b) => b.evidenceCount - a.evidenceCount);
  const capped = recommendations.slice(0, 12);

  const report: AdvisorReport = {
    generatedAt: Date.now(),
    baselineId: result.id,
    loserCount: losers.length,
    winCount: wins.length,
    eowCount: eow.length,
    skipCount: skips.length,
    loserClusters,
    skipClusters,
    recommendations: capped,
    disclaimer: DISCLAIMER,
  };
  lastAdvisor = report;
  return report;
}

function metricsFromResult(result: BacktestResult): {
  wr: number;
  pf: number;
  pnl: number;
  losers: number;
  trades: number;
} {
  const trades = result.trades || [];
  const scored = trades.filter((t) => !t.forcedEndOfWindow);
  const wins = scored.filter((t) => t.pnlSol > 0);
  const losers = scored.filter((t) => t.pnlSol <= 0);
  const wr = scored.length ? (wins.length / scored.length) * 100 : 0;
  const pf = Number(result.summary?.profitFactor ?? 0);
  const pnl = Number(result.summary?.totalPnlSol ?? 0);
  return {
    wr,
    pf,
    pnl,
    losers: losers.length,
    trades: scored.length,
  };
}

function shouldKeepCandidate(
  baseline: ReturnType<typeof metricsFromResult>,
  candidate: ReturnType<typeof metricsFromResult>
): { keep: boolean; note: string } {
  if (baseline.trades > 0 && candidate.trades < baseline.trades * 0.5) {
    return {
      keep: false,
      note: `Sample collapsed (${candidate.trades} vs ${baseline.trades} trades)`,
    };
  }
  const pfBetter = candidate.pf > baseline.pf + 0.02;
  const pfNotWorse = candidate.pf >= baseline.pf - 0.05;
  const wrBetter = candidate.wr > baseline.wr + 0.5;
  const pnlBetter = candidate.pnl > baseline.pnl + 0.0001;
  const fewerLosers = candidate.losers < baseline.losers;

  if (pfBetter || (wrBetter && pfNotWorse) || (pnlBetter && pfNotWorse)) {
    return { keep: true, note: 'Improves PF / WR / PnL on this window' };
  }
  if (fewerLosers && pfNotWorse && candidate.trades >= baseline.trades * 0.7) {
    return { keep: true, note: 'Fewer losers with stable PF' };
  }
  return { keep: false, note: 'No clear improvement vs baseline' };
}

/**
 * Shadow re-run top candidates on the same window (sequential).
 * Does not overwrite last backtest when persistResult=false.
 */
export async function scoreRecommendations(
  baseline: BacktestResult,
  candidates?: AdvisorRecommendation[],
  opts: { maxScore?: number } = {}
): Promise<AdvisorReport> {
  const report =
    lastAdvisor && lastAdvisor.baselineId === baseline.id
      ? { ...lastAdvisor, recommendations: [...lastAdvisor.recommendations] }
      : analyzeBacktest(baseline);

  const pool = (candidates?.length
    ? candidates
    : report.recommendations
  ).slice(0, opts.maxScore ?? 6);

  const { runBacktest } = await import('./backtest');
  const baseMetrics = metricsFromResult(baseline);
  const baseOpts = baseline.options || {};
  const period = baseline.period;

  const scored: AdvisorRecommendation[] = [];

  for (let i = 0; i < pool.length; i++) {
    const rec = pool[i];
    try {
      const shadow = await runBacktest({
        fromMs: period?.fromMs,
        toMs: period?.toMs,
        hours: period?.hours ?? baseOpts.hours,
        maxTrades: baseOpts.maxTrades,
        simulations: 1,
        migrationsOnly: baseOpts.migrationsOnly,
        pumpFunOnly: baseOpts.pumpFunOnly,
        reBuyEnabled: baseOpts.reBuyEnabled,
        minVolumeUsd: baseOpts.minVolumeUsd,
        strategyType: baseOpts.strategyType,
        minLiquidityUsd: baseOpts.minLiquidityUsd,
        minMarketCapUsd:
          rec.overlay.minMarketCapUsd ?? baseOpts.minMarketCapUsd,
        maxRiskScore: baseOpts.maxRiskScore,
        useLiveData: baseOpts.useLiveData,
        allowSynthetic: false,
        startingBalanceSol: baseOpts.startingBalanceSol,
        riskLevel: 'current',
        compareRiskLevels: false,
        useSavedConfigFilters: true,
        parityMode: true,
        persistResult: false,
        advisorOverlay: rec.overlay,
        // Absolute floors from overlay also via advisorOverlay apply
        minConvictionScore: rec.overlay.minConvictionScore,
        minWalletQualityScore: rec.overlay.minWalletQualityScore,
      } as BacktestOptions);

      const m = metricsFromResult(shadow);
      const verdict = shouldKeepCandidate(baseMetrics, m);
      scored.push({
        ...rec,
        scored: true,
        keep: verdict.keep,
        deltaWinRatePct: Number((m.wr - baseMetrics.wr).toFixed(2)),
        deltaProfitFactor: Number((m.pf - baseMetrics.pf).toFixed(3)),
        deltaPnlSol: Number((m.pnl - baseMetrics.pnl).toFixed(6)),
        deltaLoserCount: m.losers - baseMetrics.losers,
        baselineTrades: baseMetrics.trades,
        candidateTrades: m.trades,
        candidateWinRatePct: Number(m.wr.toFixed(2)),
        candidateProfitFactor: Number(m.pf.toFixed(3)),
        candidatePnlSol: Number(m.pnl.toFixed(6)),
        scoreNote: verdict.note,
      });
    } catch (err) {
      scored.push({
        ...rec,
        scored: true,
        keep: false,
        scoreNote:
          err instanceof Error ? err.message : 'Shadow re-run failed',
      });
    }
  }

  // Keep unscored remainder for UI transparency
  const scoredIds = new Set(scored.map((r) => r.id));
  const rest = report.recommendations.filter((r) => !scoredIds.has(r.id));
  const merged = [...scored, ...rest].sort((a, b) => {
    if (a.keep === b.keep) {
      return (b.deltaPnlSol ?? 0) - (a.deltaPnlSol ?? 0);
    }
    return a.keep ? -1 : 1;
  });

  const out: AdvisorReport = {
    ...report,
    generatedAt: Date.now(),
    recommendations: merged,
  };
  lastAdvisor = out;
  return out;
}

export function getRecommendationsByIds(
  ids: string[]
): AdvisorRecommendation[] {
  if (!lastAdvisor) return [];
  const set = new Set(ids);
  return lastAdvisor.recommendations.filter((r) => set.has(r.id));
}

/** Persist selected recommendation overlays to live Strategies / filters / profiles. */
export function applyRecommendationsToLive(
  ids: string[]
): { ok: boolean; applied: string[]; message: string } {
  const recs = getRecommendationsByIds(ids);
  if (!recs.length) {
    return { ok: false, applied: [], message: 'No matching recommendations' };
  }
  const overlay = mergeOverlays(recs.map((r) => r.overlay));
  applyAdvisorOverlay(overlay, { persist: true });
  const applied = recs.map((r) => r.id);
  console.log(
    `[backtest-advisor] Applied to live: ${applied.join(', ')}`
  );
  return {
    ok: true,
    applied,
    message: `Applied ${applied.length} recommendation(s) to live Strategies`,
  };
}

/** Build BacktestOptions for a combined re-run of selected tips. */
export function buildRerunOptionsFromRecommendations(
  baseline: BacktestResult,
  ids: string[]
): BacktestOptions {
  const recs = getRecommendationsByIds(ids);
  const overlay = mergeOverlays(recs.map((r) => r.overlay));
  const baseOpts = baseline.options || {};
  const period = baseline.period;
  return {
    fromMs: period?.fromMs,
    toMs: period?.toMs,
    hours: period?.hours ?? baseOpts.hours,
    maxTrades: baseOpts.maxTrades,
    simulations: 1,
    migrationsOnly: baseOpts.migrationsOnly,
    pumpFunOnly: baseOpts.pumpFunOnly,
    reBuyEnabled: baseOpts.reBuyEnabled,
    minVolumeUsd: baseOpts.minVolumeUsd,
    strategyType: baseOpts.strategyType,
    minLiquidityUsd: baseOpts.minLiquidityUsd,
    minMarketCapUsd: overlay.minMarketCapUsd ?? baseOpts.minMarketCapUsd,
    maxRiskScore: baseOpts.maxRiskScore,
    useLiveData: baseOpts.useLiveData,
    allowSynthetic: false,
    startingBalanceSol: baseOpts.startingBalanceSol,
    riskLevel: 'current',
    compareRiskLevels: false,
    useSavedConfigFilters: true,
    parityMode: true,
    persistResult: true,
    advisorOverlay: overlay,
    minConvictionScore: overlay.minConvictionScore,
    minWalletQualityScore: overlay.minWalletQualityScore,
  };
}
