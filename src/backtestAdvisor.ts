/**
 * Backtester Smart Advisor — cluster losers / skips, propose one-knob and
 * multi-knob counterfactuals, shadow re-score on the same window, apply to live.
 */

import { config, effectiveMinMarketCapUsd, persistUserSettings } from './config';
import type {
  BacktestResult,
  BacktestOptions,
  BacktestTradeResult,
} from './backtest';
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
  updateTradeProfileParams,
  type TradeProfileId,
  type TradeProfileParamOverride,
} from './tradeProfiles';

export interface AdvisorOverlay {
  toggles?: Partial<Record<StrategyKey, boolean>>;
  /** Absolute selective min conviction for this run / apply */
  minConvictionScore?: number;
  /** Absolute wallet quality floor */
  minWalletQualityScore?: number;
  /** Absolute min market-cap USD override */
  minMarketCapUsd?: number;
  /** Absolute min liquidity USD (filters.minLiquidity) */
  minLiquidityUsd?: number;
  /** Absolute max risk score (filters.maxRiskScore) — lower = tighter */
  maxRiskScore?: number;
  /** Market Scanner min rank score (when scanner ON) */
  minRankScore?: number;
  /** Trade Profile ids to disable */
  disableProfileIds?: TradeProfileId[];
  /** Per-profile exit/match param patches (widen SL, raise min wallets, …) */
  profileParamPatches?: Array<{
    id: TradeProfileId;
    params: TradeProfileParamOverride;
  }>;
}

export type AdvisorFamily =
  | 'tighten'
  | 'loosen'
  | 'toggle_off'
  | 'toggle_on'
  | 'profile'
  | 'multi';

export interface AdvisorRecommendation {
  id: string;
  title: string;
  family: AdvisorFamily;
  rationale: string;
  evidenceCount: number;
  overlay: AdvisorOverlay;
  /** Extra actionable bullets for richer UI */
  detailTips?: string[];
  /** Sort weight (higher first); defaults from evidenceCount */
  priority?: number;
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

/** Holds under this are treated as ultra-short (first candle / SL-sign cluster). */
const ULTRA_SHORT_HOLD_MS = 45_000;
/** Mild adverse mark that should NOT trip a true −9…−14% hard SL */
const MILD_ADVERSE_PNL = -5;

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
  const patches: NonNullable<AdvisorOverlay['profileParamPatches']> = [];
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
    if (o.minLiquidityUsd != null) {
      out.minLiquidityUsd = o.minLiquidityUsd;
    }
    if (o.maxRiskScore != null) {
      out.maxRiskScore = o.maxRiskScore;
    }
    if (o.minRankScore != null) {
      out.minRankScore = o.minRankScore;
    }
    if (o.disableProfileIds?.length) {
      for (const id of o.disableProfileIds) profiles.add(id);
    }
    if (o.profileParamPatches?.length) {
      patches.push(...o.profileParamPatches);
    }
  }
  if (profiles.size) out.disableProfileIds = [...profiles];
  if (patches.length) out.profileParamPatches = patches;
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
  if (overlay.minLiquidityUsd != null && overlay.minLiquidityUsd > 0) {
    config.filters.minLiquidity = Number(overlay.minLiquidityUsd);
  }
  if (overlay.maxRiskScore != null && overlay.maxRiskScore > 0) {
    config.filters.maxRiskScore = Number(overlay.maxRiskScore);
  }
  if (
    overlay.minRankScore != null &&
    overlay.minRankScore > 0 &&
    config.marketScanner
  ) {
    config.marketScanner.minRankScore = Number(overlay.minRankScore);
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

  if (overlay.profileParamPatches?.length) {
    for (const patch of overlay.profileParamPatches) {
      if (persist) {
        updateTradeProfileParams(patch.id, patch.params);
      } else if (config.tradeProfiles) {
        if (!config.tradeProfiles.overrides) config.tradeProfiles.overrides = {};
        const prev = config.tradeProfiles.overrides[patch.id] || {};
        config.tradeProfiles.overrides[patch.id] = {
          exitRules: {
            ...(prev.exitRules || {}),
            ...(patch.params.exitRules || {}),
          },
          match: {
            ...(prev.match || {}),
            ...(patch.params.match || {}),
          },
        };
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

function isStopLossExit(t: BacktestTradeResult): boolean {
  return normalizeExitReason(t.reason) === 'stop-loss';
}

function holdMs(t: BacktestTradeResult): number {
  if (t.holdingTimeMs != null && Number.isFinite(t.holdingTimeMs)) {
    return Math.max(0, t.holdingTimeMs);
  }
  if (t.closedAt != null && t.openedAt != null) {
    return Math.max(0, t.closedAt - t.openedAt);
  }
  return 0;
}

/** Positive SL magnitude wrongly stamped → fires when mark ≤ +SL% (near-instant). */
function looksLikeSlSignBug(t: BacktestTradeResult): boolean {
  if (!isStopLossExit(t)) return false;
  const hold = holdMs(t);
  if (hold > ULTRA_SHORT_HOLD_MS) return false;
  const m = String(t.reason || '').match(
    /(?:stop-loss|SL)\s+([+-]?\d+(?:\.\d+)?)/i
  );
  const slShown = m ? Number(m[1]) : NaN;
  const mildMark =
    t.pnlPct > MILD_ADVERSE_PNL ||
    (t.maxDrawdownPct != null && t.maxDrawdownPct > MILD_ADVERSE_PNL);
  if (Number.isFinite(slShown) && slShown > 0 && mildMark) return true;
  return mildMark && hold < ULTRA_SHORT_HOLD_MS;
}

function avg(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function mcGapPct(t: BacktestTradeResult): number | null {
  const wallet = t.smartWalletEntryMarketCapUsd;
  const ours = t.entryMarketCapUsd ?? t.marketCapUsd;
  if (wallet == null || ours == null || !(wallet > 0) || !(ours > 0)) {
    return null;
  }
  return ((ours - wallet) / wallet) * 100;
}

function overlayHasEffect(o: AdvisorOverlay): boolean {
  return Boolean(
    (o.toggles && Object.keys(o.toggles).length > 0) ||
      o.minConvictionScore != null ||
      o.minWalletQualityScore != null ||
      o.minMarketCapUsd != null ||
      o.minLiquidityUsd != null ||
      o.maxRiskScore != null ||
      o.minRankScore != null ||
      (o.disableProfileIds && o.disableProfileIds.length > 0) ||
      (o.profileParamPatches && o.profileParamPatches.length > 0)
  );
}

/** Propose recipes from loser / skip clusters (not yet scored). */
export function analyzeBacktest(result: BacktestResult): AdvisorReport {
  const trades = result.trades || [];
  const losers = trades.filter((t) => t.pnlSol <= 0 && !t.forcedEndOfWindow);
  const wins = trades.filter((t) => t.pnlSol > 0);
  const eow = trades.filter((t) => t.forcedEndOfWindow);
  const skips = result.skipped || [];

  const exitMap = new Map<string, number>();
  const scalpMap = new Map<string, number>();
  const skipMap = new Map<string, number>();

  for (const t of losers) {
    bumpCount(exitMap, normalizeExitReason(t.reason));
    if (t.shortTermStrategyId) {
      bumpCount(scalpMap, t.shortTermStrategyId);
    }
    if ((t.smartWalletCount ?? t.sourceNames?.length ?? 0) <= 1) {
      bumpCount(exitMap, 'single-wallet entry');
    }
    if (holdMs(t) < ULTRA_SHORT_HOLD_MS && isStopLossExit(t)) {
      bumpCount(exitMap, 'ultra-short SL exit');
    }
    if (looksLikeSlSignBug(t)) {
      bumpCount(exitMap, 'SL polarity / early exit');
    }
  }
  for (const s of skips) {
    bumpCount(skipMap, normalizeSkipReason(s.reason));
  }

  const loserClusters = topClusters(exitMap, 10);
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
  const liqBase = Number(config.filters.minLiquidity ?? 0);
  const riskBase = Number(
    result.configUsed?.maxRiskScore ?? config.filters.maxRiskScore ?? 80
  );
  const mcBase = Math.max(
    Number(result.configUsed?.minMarketCapUsd ?? 0),
    effectiveMinMarketCapUsd() || 0
  );

  const ultraShortSl = losers.filter(
    (t) => holdMs(t) < ULTRA_SHORT_HOLD_MS && isStopLossExit(t)
  );
  const slSignCluster = losers.filter(looksLikeSlSignBug);
  const mirrorLosers = losers.filter(
    (t) =>
      t.tradeProfileId === 'smart_money_mirror' ||
      /smart money mirror/i.test(String(t.tradeProfileName || ''))
  );
  const mirrorUltraShort = mirrorLosers.filter(
    (t) => holdMs(t) < ULTRA_SHORT_HOLD_MS
  );
  const scannerLosers = losers.filter(
    (t) =>
      t.entrySource === 'scanner' ||
      t.entrySource === 'hybrid' ||
      (t.sourceNames || []).some((n) => /market\s*scanner/i.test(String(n)))
  );
  const walletLosers = losers.filter(
    (t) =>
      t.entrySource === 'wallet' ||
      (!t.entrySource &&
        !(t.sourceNames || []).some((n) => /market\s*scanner/i.test(String(n))))
  );
  const migScalpSl = losers.filter(
    (t) =>
      t.shortTermStrategyId === 'post_migration_scalp' && isStopLossExit(t)
  );
  const highDelayLosers = losers.filter((t) => (t.copyDelayMs ?? 0) >= 8_000);
  const thinLiqLosers = losers.filter(
    (t) =>
      t.liquidityUsd != null && t.liquidityUsd > 0 && t.liquidityUsd < 12_000
  );
  const highRiskLosers = losers.filter(
    (t) => t.riskScoreHint != null && t.riskScoreHint >= 55
  );
  const bigMcGapLosers = losers.filter((t) => {
    const g = mcGapPct(t);
    return g != null && g >= 25;
  });
  const singleN = exitMap.get('single-wallet entry') || 0;

  // ── SL polarity / ultra-short early exits ──
  if (slSignCluster.length >= 2 || ultraShortSl.length >= 3) {
    const n = Math.max(slSignCluster.length, ultraShortSl.length);
    const sample = slSignCluster.length ? slSignCluster : ultraShortSl;
    const avgHoldSec = avg(sample.map((t) => holdMs(t) / 1000));
    const avgPnl = avg(sample.map((t) => t.pnlPct));
    push({
      id: 'fix-sl-polarity-verify',
      title: 'Verify SL polarity (profile SL must be negative)',
      family: 'tighten',
      priority: 1000 + n,
      rationale: `${n} ultra-short SL exits (~${avgHoldSec.toFixed(0)}s holds, avg mark ${avgPnl.toFixed(1)}%) — catalog SL is a positive loss amount but exit engines need −SL%. After the polarity fix, re-run BT; residual losers need wider SL or stricter entries.`,
      evidenceCount: n,
      detailTips: [
        'All profiles share materializeExitRules + applyTradeProfileExitRules normalizeStopLossPct — not Mirror-only.',
        'UI min/max stay positive (e.g. 9–14); runtime stamps −9…−14.',
        'If reasons still show "Hard stop-loss 12%" with mark −2%, polarity is still wrong somewhere.',
      ],
      overlay: {},
    });
  }

  if (
    mirrorUltraShort.length >= 2 ||
    (mirrorLosers.length >= 3 && ultraShortSl.length >= 2)
  ) {
    const n = Math.max(mirrorUltraShort.length, mirrorLosers.length);
    push({
      id: 'profile-widen-sl-smart_money_mirror',
      title: 'Widen Smart Money Mirror SL to 14–20%',
      family: 'profile',
      priority: 900 + n,
      rationale: `${mirrorLosers.length} Mirror losers (${mirrorUltraShort.length} ultra-short) — give copy trades room past first-candle noise; widen profile SL magnitude and keep trail ~11%.`,
      evidenceCount: n,
      detailTips: [
        'Tweak: Trade Profiles → Smart Money Mirror → SL min 14 / SL max 20 (positive magnitudes).',
        'Expected: fewer 20–30s stop-outs; holds until true adverse move, trail, or TP.',
      ],
      overlay: {
        profileParamPatches: [
          {
            id: 'smart_money_mirror',
            params: {
              exitRules: {
                stopLossPctMin: 14,
                stopLossPctMax: 20,
                trailingStopPct: 11,
              },
              match: { minWalletCount: 2, minConviction: 52 },
            },
          },
        ],
      },
    });
  }

  if (
    mirrorLosers.length >= 3 &&
    mirrorLosers.filter(
      (t) => (t.smartWalletCount ?? t.sourceNames?.length ?? 0) <= 1
    ).length >= 2
  ) {
    push({
      id: 'profile-mirror-min-wallets-3',
      title: 'Smart Money Mirror: require 3+ wallets',
      family: 'profile',
      priority: 850,
      rationale: `Mirror losers include weak single/dual-wallet copies — raise cluster floor to cut low-conviction mirrors.`,
      evidenceCount: mirrorLosers.length,
      detailTips: [
        'Tweak: match.minWalletCount = 3, requireCluster = true.',
        'Pairs well with Elite Convergence ON.',
      ],
      overlay: {
        profileParamPatches: [
          {
            id: 'smart_money_mirror',
            params: {
              match: {
                minWalletCount: 3,
                requireCluster: true,
                minWalletQuality: 60,
              },
            },
          },
        ],
      },
    });
  }

  if (migScalpSl.length >= 2) {
    push({
      id: 'profile-widen-sl-migration-scalp',
      title: 'Widen Post-Migration Scalp / Migration Sniper SL',
      family: 'profile',
      priority: 880 + migScalpSl.length,
      rationale: `${migScalpSl.length} Post-Migration Scalp SL losers — early marks often −2–4% while stamped SL looked like +13%. Widen SL magnitude and/or disable migration scalp if churn continues after polarity fix.`,
      evidenceCount: migScalpSl.length,
      detailTips: [
        'Tweak Migration Sniper: stopLossPctMin 16 / stopLossPctMax 22 (positive magnitudes → −16…−22 at runtime).',
        'Or turn OFF post_migration_scalp if most migration entries are noise.',
      ],
      overlay: {
        profileParamPatches: [
          {
            id: 'migration_sniper',
            params: {
              exitRules: {
                stopLossPctMin: 16,
                stopLossPctMax: 22,
              },
            },
          },
        ],
        toggles: isStrategyEnabled('post_migration_scalp')
          ? { post_migration_scalp: false }
          : undefined,
      },
    });
  }

  // Any profile with many ultra-short SL losers → widen that profile's SL
  const profileUltraShort = new Map<string, BacktestTradeResult[]>();
  for (const t of ultraShortSl) {
    const id = t.tradeProfileId || 'unassigned';
    if (id === 'unassigned' || id === 'default') continue;
    const arr = profileUltraShort.get(id) || [];
    arr.push(t);
    profileUltraShort.set(id, arr);
  }
  for (const [pid, arr] of profileUltraShort.entries()) {
    if (arr.length < 2) continue;
    if (pid === 'smart_money_mirror' || pid === 'migration_sniper') continue;
    push({
      id: `profile-widen-sl-${pid}`,
      title: `Widen ${arr[0].tradeProfileName || pid} SL (+4%)`,
      family: 'profile',
      priority: 820 + arr.length,
      rationale: `${arr.length} ultra-short SL exits on ${arr[0].tradeProfileName || pid} — after polarity fix, residual noise may still need a wider magnitude.`,
      evidenceCount: arr.length,
      detailTips: [
        'Raises stopLossPctMin/Max by ~4 (still stored as positive magnitudes).',
        'Runtime normalizeStopLossPct stamps them negative for all profiles.',
      ],
      overlay: {
        profileParamPatches: [
          {
            id: pid as TradeProfileId,
            params: {
              exitRules: {
                stopLossPctMin: 12,
                stopLossPctMax: 18,
              },
            },
          },
        ],
      },
    });
  }

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
        priority: 500 + p.losses,
        rationale: `${p.icon || ''} ${p.name} went ${p.wins}W/${p.losses}L (WR ${p.winRatePct.toFixed(0)}%, PnL ${p.totalPnlSol.toFixed(3)} SOL) on this window`.trim(),
        evidenceCount: p.losses,
        detailTips: [
          `Consider disabling ${p.name} for this regime, or tighten its match filters instead of a blanket off.`,
        ],
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
          priority: 400 + n,
          rationale: `${n} losing trade(s) used short-term engine ${engine}`,
          evidenceCount: n,
          detailTips: [
            `Evidence cluster: ${n} losers tagged ${engine}.`,
            'If only early SL remains after polarity fix, prefer widening that engine SL over disabling.',
          ],
          overlay: { toggles: { [engine as StrategyKey]: false } },
        });
      }
    }
  }

  const timerN = exitMap.get('scalp timer') || 0;
  if (timerN >= 3) {
    if (isStrategyEnabled('micro_scalper')) {
      push({
        id: 'toggle-off-micro_scalper-timer',
        title: 'Turn OFF micro scalper (timer losses)',
        family: 'toggle_off',
        priority: 420,
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
        priority: 410,
        rationale: `${timerN} losers closed on scalp timer — consider disabling momentum burst`,
        evidenceCount: timerN,
        overlay: { toggles: { momentum_burst: false } },
      });
    }
  }

  const slN = exitMap.get('stop-loss') || 0;
  if (slN >= 2 || losers.length >= 3) {
    push({
      id: 'tighten-conviction-5',
      title: 'Raise min conviction +5',
      family: 'tighten',
      priority: 350 + slN,
      rationale: `${losers.length} strategy losers (${slN} via stop-loss) — raise selective floor to ${convBase + 5}`,
      evidenceCount: Math.max(slN, losers.length),
      detailTips: [
        `Setting: selective.minConvictionScore → ${convBase + 5}`,
        'Expected: fewer weak entries; sample size may drop — check shadow score.',
      ],
      overlay: { minConvictionScore: convBase + 5 },
    });
    push({
      id: 'tighten-wallet-q-5',
      title: 'Raise min wallet quality +5',
      family: 'tighten',
      priority: 340 + losers.length,
      rationale: `Lift wallet quality floor to ${wqBase + 5} to skip weaker copy sources`,
      evidenceCount: losers.length,
      detailTips: [
        `Setting: filters.minWalletQualityScore → ${wqBase + 5} (gate ON)`,
      ],
      overlay: { minWalletQualityScore: wqBase + 5 },
    });
  }

  if (losers.length >= 4 && mcBase > 0) {
    const raised = Math.round(mcBase * 1.25);
    push({
      id: 'tighten-min-mc',
      title: `Raise min market cap to $${raised.toLocaleString()}`,
      family: 'tighten',
      priority: 330,
      rationale: `Many losers entered; raise MC floor ~25% above current effective $${Math.round(mcBase).toLocaleString()}`,
      evidenceCount: losers.length,
      overlay: { minMarketCapUsd: raised },
    });
  }

  if (highDelayLosers.length >= 3) {
    const avgDelay = avg(highDelayLosers.map((t) => t.copyDelayMs || 0));
    push({
      id: 'tighten-conviction-delay-cluster',
      title: 'Tighten entries for late copy fills',
      family: 'multi',
      priority: 700 + highDelayLosers.length,
      rationale: `${highDelayLosers.length} losers had copy delay ≥8s (avg ${(avgDelay / 1000).toFixed(1)}s) — late fills often buy worse marks vs wallet entry.`,
      evidenceCount: highDelayLosers.length,
      detailTips: [
        'Raise conviction +8 and wallet quality +5 so only strong signals survive delay.',
        'Prefer multi-wallet clusters (Elite Convergence) when delay is unavoidable.',
      ],
      overlay: {
        minConvictionScore: convBase + 8,
        minWalletQualityScore: wqBase + 5,
        toggles: !isStrategyEnabled('elite_convergence')
          ? { elite_convergence: true }
          : undefined,
      },
    });
  }

  if (bigMcGapLosers.length >= 2) {
    push({
      id: 'tighten-mc-gap-chase',
      title: 'Filter chase entries (wallet→you MC gap)',
      family: 'multi',
      priority: 720 + bigMcGapLosers.length,
      rationale: `${bigMcGapLosers.length} losers entered ≥25% higher MC than the smart-wallet fill — classic chase after pump.`,
      evidenceCount: bigMcGapLosers.length,
      detailTips: [
        'Raise min conviction and MC floor so you skip extended marks.',
        'Widen SL only helps if you still enter; better to skip the chase.',
      ],
      overlay: {
        minConvictionScore: convBase + 10,
        minMarketCapUsd: mcBase > 0 ? Math.round(mcBase * 1.15) : undefined,
      },
    });
  }

  if (thinLiqLosers.length >= 2) {
    const raisedLiq = Math.max(
      liqBase > 0 ? Math.round(liqBase * 1.4) : 15_000,
      15_000
    );
    push({
      id: 'tighten-min-liquidity',
      title: `Raise min liquidity to $${raisedLiq.toLocaleString()}`,
      family: 'tighten',
      priority: 680 + thinLiqLosers.length,
      rationale: `${thinLiqLosers.length} losers had liquidity under ~$12k — thin books stop out on noise.`,
      evidenceCount: thinLiqLosers.length,
      detailTips: [
        `Setting: filters.minLiquidity → $${raisedLiq.toLocaleString()}`,
        'Enable volume/liquidity filters if off.',
      ],
      overlay: {
        minLiquidityUsd: raisedLiq,
        toggles: !isStrategyEnabled('volume_liquidity_filters')
          ? { volume_liquidity_filters: true }
          : undefined,
      },
    });
  }

  if (highRiskLosers.length >= 2 && riskBase > 40) {
    const tighter = Math.max(35, Math.min(riskBase - 10, 55));
    push({
      id: 'tighten-max-risk-score',
      title: `Lower max risk score to ${tighter}`,
      family: 'tighten',
      priority: 660 + highRiskLosers.length,
      rationale: `${highRiskLosers.length} losers had riskScoreHint ≥55 — cut the riskiest rugs earlier.`,
      evidenceCount: highRiskLosers.length,
      detailTips: [
        `Setting: filters.maxRiskScore → ${tighter} (was ~${riskBase})`,
      ],
      overlay: { maxRiskScore: tighter },
    });
  }

  if (singleN >= 3 && !isStrategyEnabled('elite_convergence')) {
    push({
      id: 'toggle-on-elite_convergence',
      title: 'Turn ON Elite Convergence',
      family: 'toggle_on',
      priority: 640,
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
      priority: 630,
      rationale: `${singleN} weak-wallet losers — raise quality floor via Hard Quality Gate`,
      evidenceCount: singleN,
      overlay: { toggles: { hard_quality_gate: true } },
    });
  }

  const deadN = exitMap.get('dead market') || 0;
  if (deadN >= 2 && !isStrategyEnabled('dead_market_exit')) {
    push({
      id: 'toggle-on-dead_market_exit',
      title: 'Turn ON Dead Market Exit',
      family: 'toggle_on',
      priority: 500,
      rationale: `${deadN} losers look like stalled books — enable dead-market exit`,
      evidenceCount: deadN,
      overlay: { toggles: { dead_market_exit: true } },
    });
  }

  const volSkips = skipMap.get('volume') || 0;
  if (
    (volSkips >= 3 || losers.length >= 3) &&
    !isStrategyEnabled('volume_liquidity_filters')
  ) {
    push({
      id: 'toggle-on-volume_liquidity_filters',
      title: 'Turn ON Volume / Liquidity Filters',
      family: 'toggle_on',
      priority: 520,
      rationale: `${volSkips} volume skips and ${losers.length} losers — enforce vol/liq floors`,
      evidenceCount: Math.max(volSkips, losers.length),
      overlay: { toggles: { volume_liquidity_filters: true } },
    });
  }

  const migProfileLosses = losers.filter(
    (t) => t.tradeProfileId === 'migration_sniper'
  ).length;
  if (migProfileLosses >= 2 && isStrategyEnabled('migration_sniper')) {
    push({
      id: 'toggle-off-migration_sniper-module',
      title: 'Turn OFF Migration Sniper Mode',
      family: 'toggle_off',
      priority: 550 + migProfileLosses,
      rationale: `${migProfileLosses} Migration Sniper profile losers — disable migration-only entry mode`,
      evidenceCount: migProfileLosses,
      overlay: { toggles: { migration_sniper: false } },
    });
  }

  if (scannerLosers.length >= 3) {
    push({
      id: 'scanner-raise-rank-ta',
      title: 'Tighten Market Scanner TA floors',
      family: 'tighten',
      priority: 720 + scannerLosers.length,
      rationale: `${scannerLosers.length} Market Scanner losers — raise minRankScore / require stronger Fib·pattern setups`,
      evidenceCount: scannerLosers.length,
      detailTips: [
        'Increase marketScanner.minRankScore (e.g. 42 → 55).',
        'Keep requireTaSetup ON so scanner-only entries need Fib/support/pattern.',
        'Compare scanner vs wallet win rate after next BT run.',
      ],
      overlay: {
        minConvictionScore: convBase + 8,
      },
    });
  }
  if (
    scannerLosers.length >= 2 &&
    walletLosers.length >= 2 &&
    scannerLosers.length > walletLosers.length * 1.4
  ) {
    push({
      id: 'prefer-wallet-over-scanner',
      title: 'Prefer wallet copy over scanner (temporarily)',
      family: 'toggle_off',
      priority: 680,
      rationale: `Scanner losers (${scannerLosers.length}) outpace wallet losers (${walletLosers.length}) — pause TA Market Scanner while copy stays ON`,
      evidenceCount: scannerLosers.length,
      overlay: { toggles: { ta_market_scanner: false } },
    });
  }
  if (
    walletLosers.length >= 2 &&
    scannerLosers.length >= 2 &&
    walletLosers.length > scannerLosers.length * 1.4
  ) {
    push({
      id: 'boost-scanner-vs-wallet',
      title: 'Lean on Market Scanner (wallet cluster weaker)',
      family: 'toggle_on',
      priority: 660,
      rationale: `Wallet losers (${walletLosers.length}) outpace scanner (${scannerLosers.length}) — keep Market Scanner ON and tighten wallet quality`,
      evidenceCount: walletLosers.length,
      overlay: {
        toggles: { ta_market_scanner: true },
        minWalletQualityScore: wqBase + 8,
      },
    });
  }

  const shortHoldLosers = losers.filter((t) => holdMs(t) < 120_000);
  if (
    losers.length >= 5 &&
    shortHoldLosers.length >= Math.ceil(losers.length * 0.6)
  ) {
    push({
      id: 'multi-short-hold-loser-pack',
      title: 'Multi-knob: cut short-hold loser pack',
      family: 'multi',
      priority: 950,
      rationale: `${shortHoldLosers.length}/${losers.length} losers held <2m — combine stricter entries + (if Mirror) wider SL so remaining copies can breathe.`,
      evidenceCount: shortHoldLosers.length,
      detailTips: [
        '1) Confirm SL polarity fix is live, then re-run BT before trusting scores.',
        '2) Raise conviction +5 and wallet quality +5.',
        '3) Widen Mirror SL to 14–20% if Mirror is in the short-hold cluster.',
        '4) Turn on Elite Convergence if single-wallet entries dominate.',
      ],
      overlay: mergeOverlays([
        { minConvictionScore: convBase + 5 },
        { minWalletQualityScore: wqBase + 5 },
        mirrorLosers.length >= 2
          ? {
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
            }
          : {},
        !isStrategyEnabled('elite_convergence') && singleN >= 2
          ? { toggles: { elite_convergence: true } }
          : {},
      ]),
    });
  }

  if (skips.length >= 8 && skips.length > losers.length * 2) {
    const topSkip = skipClusters[0]?.key || 'filters';
    if (topSkip === 'conviction' || convBase > 40) {
      push({
        id: 'loosen-conviction-5',
        title: 'Lower min conviction −5',
        family: 'loosen',
        priority: 200,
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
        priority: 190,
        rationale: `High skip rate (${skips.length}) — ease wallet quality to ${Math.max(20, wqBase - 5)}`,
        evidenceCount: skips.length,
        overlay: { minWalletQualityScore: Math.max(20, wqBase - 5) },
      });
    }
  }

  recommendations.sort((a, b) => {
    const pa = a.priority ?? a.evidenceCount;
    const pb = b.priority ?? b.evidenceCount;
    if (pb !== pa) return pb - pa;
    return b.evidenceCount - a.evidenceCount;
  });
  const capped = recommendations.slice(0, 18);

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
    if (!overlayHasEffect(rec.overlay || {})) {
      scored.push({
        ...rec,
        scored: true,
        keep: false,
        scoreNote:
          'Informational tip — re-run BT after verifying SL polarity; no shadow overlay',
      });
      continue;
    }

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
        minLiquidityUsd:
          rec.overlay.minLiquidityUsd ?? baseOpts.minLiquidityUsd,
        minMarketCapUsd:
          rec.overlay.minMarketCapUsd ?? baseOpts.minMarketCapUsd,
        maxRiskScore: rec.overlay.maxRiskScore ?? baseOpts.maxRiskScore,
        useLiveData: baseOpts.useLiveData,
        allowSynthetic: false,
        startingBalanceSol: baseOpts.startingBalanceSol,
        riskLevel: 'current',
        compareRiskLevels: false,
        useSavedConfigFilters: true,
        parityMode: true,
        persistResult: false,
        advisorOverlay: rec.overlay,
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
    minLiquidityUsd: overlay.minLiquidityUsd ?? baseOpts.minLiquidityUsd,
    minMarketCapUsd: overlay.minMarketCapUsd ?? baseOpts.minMarketCapUsd,
    maxRiskScore: overlay.maxRiskScore ?? baseOpts.maxRiskScore,
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
