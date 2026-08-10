/**
 * Dip Buyer minor-lane health, lane-compare diagnostics, and starvation monitor (1.2.262).
 */

import {
  collectExpectancyTrades,
  computeExpectancyMetrics,
  getRecentMixShares,
  type ExpectancyMetrics,
} from './expectancyLift';

const MINORS_CAP_DEFAULT = 16;
/** Inventory below this fraction of cap → starved candidate. */
const STARVED_FILL_FRAC = 0.25;
const STARVED_WINDOW_MS = 35 * 60_000;
const PERF_COLLAPSE_WR_DROP = 0.12;
const PERF_COLLAPSE_MIN_N = 8;

let starvedSince: number | null = null;
let lastStarvedLogAt = 0;
let lastPerfCollapseLogAt = 0;
let baselineMinorWr: number | null = null;

function topDipNativeBlockReason(funnel: Record<string, number>): string | null {
  const keys: Array<{ key: string; label: string }> = [
    { key: 'no_setup', label: 'no_setup' },
    { key: 'mx_trend', label: 'trend mutual-exclude' },
    { key: 'mx_scalper', label: 'scalper mutual-exclude' },
    { key: 'vol', label: 'vol' },
    { key: 'liq', label: 'holders/liq' },
    { key: 'mc', label: 'mc' },
    { key: 'max_drop', label: 'max_drop' },
    { key: 'unwatch_cd', label: 'unwatch cooldown' },
    { key: 'at_cap', label: 'at_cap' },
  ];
  let best: { label: string; n: number } | null = null;
  for (const k of keys) {
    const n = Number(funnel[k.key] || 0);
    if (n <= 0) continue;
    if (!best || n > best.n) best = { label: k.label, n };
  }
  return best ? `${best.label}×${best.n}` : null;
}

function isDipMinorTrade(t: {
  profileId: string;
  entryStyle?: string;
  family?: string;
}): boolean {
  if (String(t.profileId || '') !== 'dip_buyer') return false;
  const style = String(t.entryStyle || '').toLowerCase();
  const fam = String(t.family || '').toLowerCase();
  if (/quality_structure|majors:|medium:/.test(style)) return false;
  if (fam === 'steady' || fam === 'quality') return false;
  return true;
}

function avgArmToTriggerMs(): number | null {
  try {
    const { listSetupWatchEvents } =
      require('./setupWatchEvents') as typeof import('./setupWatchEvents');
    const events = listSetupWatchEvents(120).filter((e) => e.family === 'dip');
    const armedAt = new Map<string, number>();
    const latencies: number[] = [];
    for (const e of [...events].reverse()) {
      const key = e.mint;
      if (e.kind === 'armed') armedAt.set(key, e.at);
      if (e.kind === 'triggered' || e.kind === 'trigger_opened') {
        const a = armedAt.get(key);
        if (a != null && e.at >= a) latencies.push(e.at - a);
      }
    }
    if (!latencies.length) return null;
    return Math.round(
      latencies.reduce((s, x) => s + x, 0) / latencies.length
    );
  } catch {
    return null;
  }
}

export interface DipMinorLaneHealth {
  minorsCap: number;
  minorsFilled: number;
  minorsWatchingNow: number;
  minorsArmedNow: number;
  starved: boolean;
  recoveryActive: boolean;
  topBlockReason: string | null;
  funnel: {
    candidatesSeen: number;
    armed: number;
    triggered: number;
    opened: number;
    expired: number;
    leakPreferRemapped: number;
    leakSoftAllowSkipped: number;
  };
  performance: {
    n20: number;
    wr20: number | null;
    expectancyPct20: number | null;
    avgWinPct20: number | null;
    avgLossPct20: number | null;
    mfeCapturePct20: number | null;
    n50: number;
    wr50: number | null;
    armedShare: number | null;
    discShare: number | null;
    avgArmToTriggerMs: number | null;
  };
  plainLanguage: string[];
}

export interface DipLaneCompareDiagnostics {
  steadyHwr: {
    mediumCandidatesSeen: number;
    majorsCandidatesSeen: number;
    mediumArmed: number;
    majorsArmed: number;
    mediumTriggered: number;
    majorsTriggered: number;
    mediumOpened: number;
    majorsOpened: number;
    softAllow: Record<
      string,
      { granted: number; denied: number; lastDenyKey: string | null }
    >;
    qualityExceptionSkippedNonBand: number;
  };
  dipMinors: {
    candidatesSeen: number;
    armed: number;
    triggered: number;
    opened: number;
    expired: number;
    blockedMajorLeak: number;
    watchingNow: number;
    armedNow: number;
    cap: number;
    topNativeBlock: string | null;
  };
}

export function getDipLaneCompareDiagnostics(): DipLaneCompareDiagnostics {
  let funnel: Record<string, number> = {};
  let minorsWatchingNow = 0;
  let minorsArmedNow = 0;
  let minorsCap = MINORS_CAP_DEFAULT;
  try {
    const { getDipFunnelCounters } =
      require('./dipSetupWatch') as typeof import('./dipSetupWatch');
    const f = getDipFunnelCounters();
    funnel = f as unknown as Record<string, number>;
    minorsWatchingNow = Number(f.minorsWatchingNow) || 0;
    minorsArmedNow = Number(f.minorsArmedNow) || 0;
    minorsCap = Number(f.minorsCap) || MINORS_CAP_DEFAULT;
  } catch {
    /* soft */
  }
  let softAllow: DipLaneCompareDiagnostics['steadyHwr']['softAllow'] = {
    high_win_rate: { granted: 0, denied: 0, lastDenyKey: null },
    steady_compounder: { granted: 0, denied: 0, lastDenyKey: null },
  };
  let skippedNonBand = 0;
  try {
    const {
      getQualitySoftAllowCounters,
      getQualityExceptionSkippedNonBandCount,
    } = require('./tradeProfiles') as typeof import('./tradeProfiles');
    softAllow = getQualitySoftAllowCounters();
    skippedNonBand = getQualityExceptionSkippedNonBandCount();
  } catch {
    /* soft */
  }
  return {
    steadyHwr: {
      mediumCandidatesSeen: Number(funnel.medium_candidates_seen) || 0,
      majorsCandidatesSeen: Number(funnel.majors_candidates_seen) || 0,
      mediumArmed: Number(funnel.medium_armed) || 0,
      majorsArmed: Number(funnel.majors_armed) || 0,
      mediumTriggered: Number(funnel.medium_triggered) || 0,
      majorsTriggered: Number(funnel.majors_triggered) || 0,
      mediumOpened: Number(funnel.medium_opened) || 0,
      majorsOpened: Number(funnel.majors_opened) || 0,
      softAllow,
      qualityExceptionSkippedNonBand: skippedNonBand,
    },
    dipMinors: {
      candidatesSeen: Number(funnel.minors_candidates_seen) || 0,
      armed: Number(funnel.minors_armed) || 0,
      triggered: Number(funnel.minors_triggered) || 0,
      opened: Number(funnel.minors_opened) || 0,
      expired: Number(funnel.minors_expired) || 0,
      blockedMajorLeak:
        (Number(funnel.minors_leak_prefer_remapped) || 0) +
        (Number(funnel.minors_leak_soft_allow_skipped) || 0),
      watchingNow: minorsWatchingNow,
      armedNow: minorsArmedNow,
      cap: minorsCap,
      topNativeBlock: topDipNativeBlockReason(funnel),
    },
  };
}

export function getDipMinorLaneHealth(): DipMinorLaneHealth {
  const compare = getDipLaneCompareDiagnostics();
  const cap = compare.dipMinors.cap;
  const filled =
    compare.dipMinors.watchingNow + compare.dipMinors.armedNow;
  let recoveryActive = false;
  try {
    const { isDipBuyerRecovering } =
      require('./dipBuyerRecovery') as typeof import('./dipBuyerRecovery');
    recoveryActive = Boolean(isDipBuyerRecovering?.());
  } catch {
    recoveryActive = false;
  }

  const all = collectExpectancyTrades().filter(isDipMinorTrade);
  const last20 = all.slice(-20);
  const last50 = all.slice(-50);
  const m20: ExpectancyMetrics = computeExpectancyMetrics(last20);
  const m50: ExpectancyMetrics = computeExpectancyMetrics(last50);

  let armedShare: number | null = null;
  let discShare: number | null = null;
  try {
    const mix = getRecentMixShares(50);
    // Approximate Dip armed vs disc from mix when available
    armedShare =
      mix.total > 0 ? Math.round(mix.armedShare * 1000) / 10 : null;
    discShare =
      mix.total > 0 ? Math.round(mix.discShare * 1000) / 10 : null;
  } catch {
    /* soft */
  }

  const candidatesRising = compare.dipMinors.candidatesSeen > 0;
  const belowFill = filled < Math.max(1, Math.floor(cap * STARVED_FILL_FRAC));
  const starved =
    belowFill &&
    candidatesRising &&
    (starvedSince != null
      ? Date.now() - starvedSince >= STARVED_WINDOW_MS
      : false);

  const topBlock = compare.dipMinors.topNativeBlock;
  const plain: string[] = [];
  plain.push(
    starved
      ? `Dip minors starved: ${compare.dipMinors.armedNow}/${cap} armed`
      : `Dip minors ${filled}/${cap} filled · ${compare.dipMinors.armedNow} armed`
  );
  if (m20.tradeCount > 0 && m20.winRate != null) {
    plain.push(
      `Dip minor WR ${Math.round(m20.winRate * 100)}% on last ${m20.tradeCount}`
    );
  }
  if (topBlock) {
    plain.push(`Top Dip minor block: ${topBlock}`);
  }
  if (compare.dipMinors.blockedMajorLeak > 0) {
    plain.push(
      `Major-filter leak remaps/skips: ×${compare.dipMinors.blockedMajorLeak}`
    );
  }

  let funnelLeakPrefer = 0;
  let funnelLeakSoft = 0;
  try {
    const { getDipFunnelCounters } =
      require('./dipSetupWatch') as typeof import('./dipSetupWatch');
    const f = getDipFunnelCounters();
    funnelLeakPrefer = Number(f.minors_leak_prefer_remapped) || 0;
    funnelLeakSoft = Number(f.minors_leak_soft_allow_skipped) || 0;
  } catch {
    /* soft */
  }

  return {
    minorsCap: cap,
    minorsFilled: filled,
    minorsWatchingNow: compare.dipMinors.watchingNow,
    minorsArmedNow: compare.dipMinors.armedNow,
    starved,
    recoveryActive,
    topBlockReason: topBlock,
    funnel: {
      candidatesSeen: compare.dipMinors.candidatesSeen,
      armed: compare.dipMinors.armed,
      triggered: compare.dipMinors.triggered,
      opened: compare.dipMinors.opened,
      expired: compare.dipMinors.expired,
      leakPreferRemapped: funnelLeakPrefer,
      leakSoftAllowSkipped: funnelLeakSoft,
    },
    performance: {
      n20: m20.tradeCount,
      wr20: m20.winRate,
      expectancyPct20: m20.expectancyPct,
      avgWinPct20: m20.avgWinPct,
      avgLossPct20: m20.avgLossPct,
      mfeCapturePct20: m20.mfeCapturePct,
      n50: m50.tradeCount,
      wr50: m50.winRate,
      armedShare,
      discShare,
      avgArmToTriggerMs: avgArmToTriggerMs(),
    },
    plainLanguage: plain,
  };
}

/** Session tick: starved / perf-collapse alerts (no auto-loosen). */
export function tickDipMinorLaneMonitor(): void {
  const health = getDipMinorLaneHealth();
  const now = Date.now();
  const fill =
    health.minorsWatchingNow + health.minorsArmedNow;
  const below =
    fill < Math.max(1, Math.floor(health.minorsCap * STARVED_FILL_FRAC));
  const candidates = health.funnel.candidatesSeen;

  if (below && candidates > 0) {
    if (starvedSince == null) starvedSince = now;
  } else {
    starvedSince = null;
  }

  if (
    starvedSince != null &&
    now - starvedSince >= STARVED_WINDOW_MS &&
    now - lastStarvedLogAt > 10 * 60_000
  ) {
    lastStarvedLogAt = now;
    console.log(
      `[dip-minor] STARVED fill=${fill}/${health.minorsCap} ` +
        `armed=${health.minorsArmedNow} seen=${candidates} ` +
        `topBlock=${health.topBlockReason || 'none'} ` +
        `(≥${Math.round(STARVED_WINDOW_MS / 60_000)}m)`
    );
  }

  const wr = health.performance.wr20;
  const n = health.performance.n20;
  if (wr != null && n >= PERF_COLLAPSE_MIN_N) {
    if (baselineMinorWr == null) {
      baselineMinorWr = wr;
    } else if (
      fill >= Math.floor(health.minorsCap * STARVED_FILL_FRAC) &&
      baselineMinorWr - wr >= PERF_COLLAPSE_WR_DROP &&
      now - lastPerfCollapseLogAt > 15 * 60_000
    ) {
      lastPerfCollapseLogAt = now;
      console.log(
        `[dip-minor] PERF_COLLAPSE wr=${Math.round(wr * 100)}% ` +
          `baseline=${Math.round(baselineMinorWr * 100)}% n=${n} ` +
          `(inventory restored — no auto-loosen)`
      );
    }
  }
}

export function formatDipMinorLanePlainLanguage(): string {
  try {
    return getDipMinorLaneHealth().plainLanguage.join(' · ');
  } catch {
    return '';
  }
}

/** Steady / HWR medium-major lane boards (1.2.263). */
export function getQualityParkLaneHealth(): {
  steady: {
    armedNow: number;
    watchingNow: number;
    funnel: ReturnType<
      typeof import('./qualityParkPlaybook').getQualityParkFunnelCounters
    >['steady_compounder'];
    topDeny: string | null;
  };
  hwr: {
    armedNow: number;
    watchingNow: number;
    funnel: ReturnType<
      typeof import('./qualityParkPlaybook').getQualityParkFunnelCounters
    >['high_win_rate'];
    topDeny: string | null;
  };
  rotatedStaleSession: number;
  plainLanguage: string[];
} {
  let steadyArmed = 0;
  let steadyWatch = 0;
  let hwrArmed = 0;
  let hwrWatch = 0;
  let mediumActive = 0;
  try {
    const { getActiveDipWatchesSnapshot } =
      require('./dipSetupWatch') as typeof import('./dipSetupWatch');
    const snap = getActiveDipWatchesSnapshot();
    mediumActive = (snap.medium || []).length;
    for (const e of snap.allActive || []) {
      const src = String(e.source || '');
      if (src !== 'medium' && src !== 'majors') continue;
      const pid = String(e.preferredProfileId || 'steady_compounder');
      if (pid === 'high_win_rate') {
        if (e.status === 'armed') hwrArmed += 1;
        else hwrWatch += 1;
      } else {
        if (e.status === 'armed') steadyArmed += 1;
        else steadyWatch += 1;
      }
    }
  } catch {
    /* soft */
  }
  const {
    getQualityParkFunnelCounters,
    topQualityParkDeny,
  } = require('./qualityParkPlaybook') as typeof import('./qualityParkPlaybook');
  const funnel = getQualityParkFunnelCounters();
  const dipF = (() => {
    try {
      const { getDipFunnelCounters } =
        require('./dipSetupWatch') as typeof import('./dipSetupWatch');
      return getDipFunnelCounters();
    } catch {
      return null;
    }
  })();
  const rotated =
    (funnel.steady_compounder.rotated_stale || 0) +
    (funnel.high_win_rate.rotated_stale || 0) +
    (Number(dipF?.steady_rotated_stale) || 0) +
    (Number(dipF?.hwr_rotated_stale) || 0);
  const plain: string[] = [];
  const exclProxy = Number(dipF?.quality_excluded_proxy) || 0;
  const exclStock = Number(dipF?.quality_excluded_stock) || 0;
  let univExclProxy = 0;
  let univExclStock = 0;
  let univLowMov = 0;
  let univVol = 0;
  try {
    const { getMajorsUniverseStatus } =
      require('./majorsUniverse') as typeof import('./majorsUniverse');
    const st = getMajorsUniverseStatus();
    univExclProxy = Number(st.rejects?.excluded_stable_or_major_asset_proxy) || 0;
    univExclStock = Number(st.rejects?.excluded_stock_name_token) || 0;
    univLowMov = Number(st.rejects?.low_movement) || 0;
    univVol = Number(st.rejects?.vol) || 0;
  } catch {
    /* soft */
  }
  const exclProxyTotal = exclProxy + univExclProxy;
  const exclStockTotal = exclStock + univExclStock;

  plain.push(
    `Steady medium now $20M–$200M, ${mediumActive} active watched`
  );
  if (exclProxyTotal > 0) {
    plain.push(
      `Excluded ${exclProxyTotal} stable/major-asset proxies from medium watch`
    );
  }
  if (exclStockTotal > 0) {
    plain.push(`Excluded ${exclStockTotal} stock-name tokens from medium watch`);
  }
  if (univLowMov > 0) {
    plain.push(`Rejected ${univLowMov} low-movement medium/majors`);
  }
  if (univVol > 0) {
    plain.push(`Rejected ${univVol} low-volume medium/majors`);
  }

  if (steadyArmed === 0 && (funnel.steady_compounder.low_movement || 0) > 0) {
    plain.push(
      `Steady majors full of low-movement names — rotated ${funnel.steady_compounder.rotated_stale || rotated} stale`
    );
  } else if (steadyArmed === 0) {
    const deny = topQualityParkDeny('steady_compounder');
    plain.push(
      deny
        ? `Steady has 0 medium arms: ${deny}`
        : `Steady has 0 medium arms`
    );
  } else {
    plain.push(`Steady armed ${steadyArmed} active structure setups`);
  }
  if (hwrArmed > 0) {
    plain.push(`HWR armed ${hwrArmed} majors, waiting trigger`);
  } else {
    const deny = topQualityParkDeny('high_win_rate');
    if (deny) plain.push(`HWR blocked: ${deny}`);
  }
  try {
    const minors = getDipMinorLaneHealth();
    if (!minors.starved && minors.minorsFilled > 0) {
      plain.push(
        `Dip minors healthy at ${minors.minorsFilled}/${minors.minorsCap}`
      );
    } else if (minors.starved && rotated > 0) {
      plain.push(
        'Dip minors starved; Steady blocked by dead tape, not strategy'
      );
    } else if (minors.starved) {
      plain.push(minors.plainLanguage[0] || 'Dip minors starved');
    }
  } catch {
    /* soft */
  }
  if (
    rotated > 0 &&
    !plain.some((p) => /rotated|dead tape/i.test(p))
  ) {
    plain.push(`Quality parks rotated ${rotated} stale`);
  }
  return {
    steady: {
      armedNow: steadyArmed,
      watchingNow: steadyWatch,
      funnel: funnel.steady_compounder,
      topDeny: topQualityParkDeny('steady_compounder'),
    },
    hwr: {
      armedNow: hwrArmed,
      watchingNow: hwrWatch,
      funnel: funnel.high_win_rate,
      topDeny: topQualityParkDeny('high_win_rate'),
    },
    rotatedStaleSession: rotated,
    plainLanguage: plain,
  };
}

export function formatQualityParkLanePlainLanguage(): string {
  try {
    return getQualityParkLaneHealth().plainLanguage.join(' · ');
  } catch {
    return '';
  }
}
