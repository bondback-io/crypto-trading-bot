/**
 * Post-Run Dip / Rotation Buy — higher-timeframe dip after a strong early run.
 *
 * Looks for:
 *  - Strong run in the first ~12–24h (age window + 24h / Fib impulse)
 *  - Pullback / rotation (drop from peak, weakening H1 vs H24)
 *  - Dip near support or key Fib (0.5 / 0.618 preferred; 0.382 / 0.786 secondary)
 *  - Volume dry-up on the dip, then returning interest
 *  - Optional smart wallet activity on the dip
 *
 * Entry: qualifies setup → soft conviction boost (or hard-require when enabled)
 * Invalidation (open position): stop-loss / support break / timer
 * Exit: take-profit, stop-loss, or max-hold timer (longer than scalps)
 *
 * Distinct from early-MC sniping and pure migration scalps.
 * Fail-open when strategy OFF or insufficient data for a hard require.
 * Anti-rug / liquidity / dead-market protections stay on elsewhere.
 */

import { config } from './config';
import { isStrategyEnabled, logStrategyDecision } from './strategies';
import {
  evaluateBasicTechnicals,
  prefersTechnicalEntry,
  type TechnicalReport,
} from './basicTechnicals';
import { seedPriceHistoryFromCandles } from './technicalLevels';
import {
  detectMarketSession,
  resolveMarketSessionForEntry,
  type MarketSessionSnapshot,
} from './marketSession';
import {
  scoreDipSmartWalletActivity,
  dipSmartWalletConvictionBoost,
  type DipSmartWalletReport,
  type DipPriorBuy,
  type DipSmartWalletSensitivity,
} from './dipSmartWallet';

export type PostRunDipSensitivity = 'low' | 'medium' | 'high';

export interface PostRunDipReport {
  qualifies: boolean;
  score: number;
  reasons: string[];
  rejectReasons: string[];
  technicals: TechnicalReport;
  session: MarketSessionSnapshot;
  hadStrongRun: boolean;
  rotationSigns: boolean;
  dipConditions: boolean;
  volumeOk: boolean;
  volumeDryThenReturn: boolean;
  smartMoneyOnDip: boolean;
  /** Structured dip-phase smart wallet confirmation */
  dipSmartWallet: DipSmartWalletReport;
  ageOk: boolean;
  /** Human entry / invalidation / exit summary for logs */
  rulesSummary: string;
  detail: string;
}

export interface PostRunDipVerdict {
  convictionDelta: number;
  skip: boolean;
  skipReason?: string;
  /** Seed longer-hold post-run dip exit mode on fill */
  seedExitMode: boolean;
  influenced: boolean;
  /** True when dip SM confirmation moved conviction or skip */
  smartWalletInfluenced: boolean;
  report: PostRunDipReport;
  logLine: string;
}

export interface PostRunDipSignalInput {
  symbol?: string;
  mint?: string;
  isMigration?: boolean;
  nearMigration?: boolean;
  earlyBuy?: boolean;
  wallets?: unknown[];
  walletNames?: string[];
  convictionScore?: number;
  dropFromPeakPct?: number | null;
  signalAgeMinutes?: number | null;
  /** Token age hours when known (launch → now) */
  tokenAgeHours?: number | null;
  metrics?: {
    priceUsd?: number | null;
    priceChangeH1Pct?: number | null;
    priceChange24hPct?: number | null;
    volume24hUsd?: number | null;
    volumeH1Usd?: number | null;
    volumeM5Usd?: number | null;
    recentVolumeUsd?: number | null;
    recentBuyVolumeUsd?: number | null;
    buySellRatio?: number | null;
    pairCreatedAtMs?: number | null;
    liquidityUsd?: number | null;
    holderCountEstimate?: number | null;
  } | null;
  birdeye?: {
    smartMoneyScore?: number | null;
    volume24hUsd?: number | null;
  } | null;
  candles?: Array<{ time: number; priceSol?: number; price?: number }>;
  nowMs?: number;
  /** Optional prior mint buys for buyback detection */
  priorBuys?: DipPriorBuy[];
}

function sensitivity(): PostRunDipSensitivity {
  const s = config.postRunDip?.sensitivity ?? config.filters.postRunDipSensitivity;
  return s === 'low' || s === 'high' ? s : 'medium';
}

function cfg() {
  const c = config.postRunDip;
  const fibs = Array.isArray(c?.preferredFibLevels)
    ? c.preferredFibLevels.map(Number).filter((n) => Number.isFinite(n))
    : [];
  const sessions = Array.isArray(c?.preferredSessions)
    ? c.preferredSessions.map(String)
    : ['us', 'europe_us'];
  const profile: 'standard' | 'conservative' | 'aggressive' =
    c?.profile === 'conservative'
      ? 'conservative'
      : c?.profile === 'aggressive'
        ? 'aggressive'
        : 'standard';
  const defaults =
    profile === 'conservative'
      ? {
          minRunPct: 120,
          maxRunPct: 400,
          minTokenAgeHours: 8,
          maxTokenAgeHours: 18,
          minVolumeUsd: 8_000,
          minLiquidityUsd: 12_000,
          minHolders: 80,
          boostPoints: 15,
          nearTechnicalPct: 1.75,
          setupWatchMinutes: 45,
          timeLimitMinutes: 55,
          stopLossPct: -10,
          minQualifyScore: 72,
          preferredFibLevels: [0.5, 0.618],
        }
      : profile === 'aggressive'
        ? {
            minRunPct: 60,
            maxRunPct: 100,
            minTokenAgeHours: 6,
            maxTokenAgeHours: 36,
            minVolumeUsd: 3_000,
            minLiquidityUsd: 6_500,
            minHolders: 40,
            boostPoints: 10,
            nearTechnicalPct: 3.5,
            setupWatchMinutes: 90,
            timeLimitMinutes: 120,
            stopLossPct: -16,
            minQualifyScore: 45,
            preferredFibLevels: [0.382, 0.5, 0.618],
          }
        : {
            minRunPct: 80,
            maxRunPct: 150,
            minTokenAgeHours: 12,
            maxTokenAgeHours: 24,
            minVolumeUsd: 5_000,
            minLiquidityUsd: 10_000,
            minHolders: 60,
            boostPoints: 12,
            nearTechnicalPct: 2.5,
            setupWatchMinutes: 60,
            timeLimitMinutes: 90,
            stopLossPct: -14,
            minQualifyScore: 55,
            preferredFibLevels: [0.5, 0.618],
          };
  return {
    profile,
    minRunPct: Number(c?.minRunPct) || defaults.minRunPct,
    maxRunPct: Number(c?.maxRunPct) || defaults.maxRunPct,
    minDipFromPeakPct:
      Number(c?.minDipFromPeakPct) ||
      (profile === 'aggressive' ? 18 : profile === 'conservative' ? 28 : 25),
    maxDipFromPeakPct:
      Number(c?.maxDipFromPeakPct) ||
      (profile === 'aggressive' ? 70 : profile === 'conservative' ? 55 : 65),
    minTokenAgeHours: Number(c?.minTokenAgeHours) || defaults.minTokenAgeHours,
    maxTokenAgeHours: Number(c?.maxTokenAgeHours) || defaults.maxTokenAgeHours,
    preferNearTechnicals: c?.preferNearTechnicals !== false,
    requireNearTechnicals:
      c?.requireNearTechnicals === true || profile === 'conservative',
    preferredFibLevels: fibs.length ? fibs : defaults.preferredFibLevels,
    preferSmartMoney:
      profile === 'aggressive'
        ? c?.preferSmartMoney === true
        : c?.preferSmartMoney !== false,
    stronglyPreferSmartMoney:
      c?.stronglyPreferSmartMoney === true || profile === 'conservative',
    requireSmartMoney: c?.requireSmartMoney === true,
    minVolumeUsd: Number(c?.minVolumeUsd) || defaults.minVolumeUsd,
    minLiquidityUsd: Number(c?.minLiquidityUsd) || defaults.minLiquidityUsd,
    minHolders: Number(c?.minHolders) || defaults.minHolders,
    boostPoints: Number(c?.boostPoints) || defaults.boostPoints,
    boostPointsMax: Number(c?.boostPointsMax) || 20,
    hardRequireSetup: c?.hardRequireSetup === true,
    nearTechnicalPct: Number(c?.nearTechnicalPct) || defaults.nearTechnicalPct,
    setupWatchMinutes:
      Number(c?.setupWatchMinutes) || defaults.setupWatchMinutes,
    timeLimitMinutes: Number(c?.timeLimitMinutes) || defaults.timeLimitMinutes,
    takeProfitPct: Number(c?.takeProfitPct) || 35,
    stopLossPct: Number(c?.stopLossPct) || defaults.stopLossPct,
    invalidateOnZoneBreak: c?.invalidateOnZoneBreak !== false,
    invalidateRequireVolume:
      profile === 'conservative'
        ? c?.invalidateRequireVolume === true
        : c?.invalidateRequireVolume !== false,
    requireClearVolumeDryUp:
      c?.requireClearVolumeDryUp === true || profile === 'conservative',
    flexibleVolumeConfirmation:
      c?.flexibleVolumeConfirmation === true || profile === 'aggressive',
    preferredSessions: sessions.length
      ? sessions
      : profile === 'aggressive'
        ? ['asia', 'europe', 'us', 'asia_europe', 'europe_us']
        : ['us', 'europe_us'],
    requirePreferredSession:
      c?.requirePreferredSession === true || profile === 'conservative',
    minQualifyScore: Number(c?.minQualifyScore) || defaults.minQualifyScore,
    smartWalletDipSensitivity: ((): DipSmartWalletSensitivity => {
      const s = c?.smartWalletDipSensitivity;
      if (s === 'low' || s === 'high') return s;
      if (profile === 'conservative') return 'high';
      if (profile === 'aggressive') return 'low';
      return 'medium';
    })(),
    smartWalletDipBoostPoints:
      Number(c?.smartWalletDipBoostPoints) ||
      (profile === 'conservative' ? 10 : profile === 'aggressive' ? 5 : 8),
    hardRequireSmartMoneyInConservative:
      c?.hardRequireSmartMoneyInConservative === true,
  };
}

function sensScale(
  level: PostRunDipSensitivity,
  minQualifyScore: number
): {
  runMult: number;
  dipLoose: number;
  scoreGate: number;
} {
  if (level === 'low')
    return {
      runMult: 0.75,
      dipLoose: 0.85,
      scoreGate: Math.max(45, minQualifyScore - 10),
    };
  if (level === 'high')
    return {
      runMult: 1.05,
      dipLoose: 1.05,
      scoreGate: Math.max(68, minQualifyScore),
    };
  return { runMult: 1, dipLoose: 1, scoreGate: Math.max(55, minQualifyScore) };
}

function resolveTokenAgeHours(
  signal: PostRunDipSignalInput,
  nowMs: number
): number | null {
  const direct = Number(signal.tokenAgeHours);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const created = Number(signal.metrics?.pairCreatedAtMs);
  if (Number.isFinite(created) && created > 0) {
    return Math.max(0, (nowMs - created) / 3_600_000);
  }
  return null;
}

export function evaluatePostRunDip(
  signal: PostRunDipSignalInput
): PostRunDipReport {
  const level = sensitivity();
  const c = cfg();
  const scale = sensScale(level, c.minQualifyScore);
  const reasons: string[] = [];
  const rejectReasons: string[] = [];
  const nowMs = signal.nowMs ?? Date.now();
  const session = detectMarketSession(nowMs);

  const price =
    Number(signal.metrics?.priceUsd) ||
    Number(signal.candles?.[signal.candles.length - 1]?.priceSol) ||
    0;
  const chg24 = Number(signal.metrics?.priceChange24hPct);
  const chg1 = Number(signal.metrics?.priceChangeH1Pct);
  const dropHint = Number(signal.dropFromPeakPct);

  if (signal.mint && signal.candles?.length) {
    seedPriceHistoryFromCandles(signal.mint, signal.candles);
  }

  const technicals = evaluateBasicTechnicals({
    mint: signal.mint,
    priceUsd: price > 0 ? price : null,
    priceChangeH1Pct: Number.isFinite(chg1) ? chg1 : null,
    priceChange24hPct: Number.isFinite(chg24) ? chg24 : null,
    dropFromPeakPct: Number.isFinite(dropHint) ? dropHint : null,
    candles: signal.candles,
    nearPct: c.nearTechnicalPct,
    nowMs,
  });

  // Post-Run Dip uses Fib/S&R modules directly when prefer/require is on
  // (does not require the Technical Levels strategy toggle).
  const preferTech = c.preferNearTechnicals;
  const requireTech = c.requireNearTechnicals;

  const runPct =
    technicals.range?.runPct ??
    (Number.isFinite(chg24) && chg24 > 0 ? chg24 : 0);
  const dropFromHigh =
    technicals.range?.dropFromHighPct ??
    (Number.isFinite(dropHint)
      ? dropHint
      : Number.isFinite(chg1) && chg1 < 0
        ? -chg1
        : 0);

  const minRun = c.minRunPct * scale.runMult;
  const maxRun = c.maxRunPct;
  const hadStrongRun = runPct >= minRun;
  const runInStandardBand = hadStrongRun && runPct <= maxRun;
  if (hadStrongRun) {
    reasons.push(
      runInStandardBand
        ? `strong run ${runPct.toFixed(0)}% in ${minRun.toFixed(0)}–${maxRun}% band`
        : `strong run ${runPct.toFixed(0)}% ≥ ${minRun.toFixed(0)}% (above ${maxRun}% soft max)`
    );
  } else {
    rejectReasons.push(`run ${runPct.toFixed(0)}% < ${minRun.toFixed(0)}%`);
  }

  // Age window — Standard: 12–24h after launch
  const ageH = resolveTokenAgeHours(signal, nowMs);
  let ageOk = true;
  let ageKnown = Number.isFinite(ageH as number);
  if (ageKnown && ageH != null) {
    ageOk = ageH >= c.minTokenAgeHours && ageH <= c.maxTokenAgeHours;
    if (ageOk) reasons.push(`token age ${ageH.toFixed(1)}h in ${c.minTokenAgeHours}–${c.maxTokenAgeHours}h`);
    else
      rejectReasons.push(
        `token age ${ageH.toFixed(1)}h outside ${c.minTokenAgeHours}–${c.maxTokenAgeHours}h`
      );
  } else {
    ageOk =
      Number.isFinite(chg24) &&
      Math.abs(chg24) > 15 &&
      signal.earlyBuy !== true &&
      !(signal.isMigration && signal.nearMigration !== true);
    if (ageOk) reasons.push('age unknown — 24h history proxy ok');
    else rejectReasons.push('age unknown and looks like early/migration snipe');
  }

  // Setup watch — don't chase stale dips forever (Standard 45–90m)
  const signalAgeMin = Number(signal.signalAgeMinutes);
  if (Number.isFinite(signalAgeMin) && signalAgeMin > c.setupWatchMinutes) {
    rejectReasons.push(
      `setup wait ${signalAgeMin.toFixed(0)}m > ${c.setupWatchMinutes}m watch`
    );
  }
  const setupWatchOk =
    !Number.isFinite(signalAgeMin) || signalAgeMin <= c.setupWatchMinutes;

  const minDip = c.minDipFromPeakPct * scale.dipLoose;
  const maxDip = c.maxDipFromPeakPct;
  const dipped = dropFromHigh >= minDip && dropFromHigh <= maxDip;
  if (dipped) {
    reasons.push(
      `dip ${dropFromHigh.toFixed(1)}% from high (band ${minDip.toFixed(0)}–${maxDip}%)`
    );
  } else {
    rejectReasons.push(
      `dip ${dropFromHigh.toFixed(1)}% not in ${minDip.toFixed(0)}–${maxDip}% band`
    );
  }

  // Rotation / weakening momentum after the run
  const rotationSigns =
    (Number.isFinite(chg1) && chg1 < 5 && hadStrongRun && dipped) ||
    (Number.isFinite(chg24) &&
      Number.isFinite(chg1) &&
      chg24 > 40 &&
      chg1 < chg24 * 0.15) ||
    (dipped && dropFromHigh >= minDip && hadStrongRun && Number.isFinite(chg1) && chg1 < 8);
  if (rotationSigns) reasons.push('rotation / weakening momentum vs run');
  else rejectReasons.push('no clear rotation signature');

  const techPref = prefersTechnicalEntry(technicals, requireTech);
  const nearPreferredFib =
    technicals.fibs?.some(
      (f) =>
        f.near &&
        c.preferredFibLevels.some((r) => Math.abs(r - f.ratio) < 0.001)
    ) === true ||
    (technicals.nearestKeyFib?.near === true &&
      c.preferredFibLevels.some(
        (r) => Math.abs(r - (technicals.nearestKeyFib?.ratio ?? -1)) < 0.001
      ));
  // Conservative: only preferred Fibs (0.5/0.618) or support — not secondary Fibs
  const nearLevel =
    c.profile === 'conservative'
      ? nearPreferredFib || technicals.nearSupport === true
      : nearPreferredFib ||
        technicals.nearKeyFib ||
        technicals.nearSupport === true;
  if (nearPreferredFib) {
    reasons.push(
      `near preferred Fib ${technicals.nearestKeyFib?.ratio ?? '0.5/0.618'} (±${c.nearTechnicalPct}%)`
    );
  } else if (nearLevel) {
    reasons.push(techPref.reason);
  }
  if (nearLevel) {
    console.log(
      `[technicals] INFLUENCE ${signal.symbol || signal.mint || 'token'} — ${techPref.reason} · ${technicals.detail}`
    );
    logStrategyDecision(
      'technical_levels',
      'take',
      `${signal.symbol || 'token'}: post-run dip near level — ${techPref.reason}`
    );
  } else if (requireTech) {
    rejectReasons.push(techPref.reason || 'require near Fib/support');
  } else if (preferTech) {
    rejectReasons.push('not near Fib/support (preferred)');
  }

  const dipConditions = dipped && (!requireTech || nearLevel);

  // Liquidity + holders (Standard floors; fail-open when unknown)
  const liq = Number(signal.metrics?.liquidityUsd) || 0;
  const holders = Number(signal.metrics?.holderCountEstimate) || 0;
  const liqKnownOk = liq <= 0 || liq >= c.minLiquidityUsd;
  const holdersOk = holders <= 0 || holders >= c.minHolders;
  if (liq > 0 && liqKnownOk) {
    reasons.push(
      `liquidity $${Math.round(liq).toLocaleString()} ≥ $${c.minLiquidityUsd.toLocaleString()}`
    );
  } else if (liq > 0) {
    rejectReasons.push(
      `liquidity $${Math.round(liq).toLocaleString()} < $${c.minLiquidityUsd.toLocaleString()}`
    );
  }
  if (holders > 0 && holdersOk) {
    reasons.push(`holders ${holders} ≥ ${c.minHolders}`);
  } else if (holders > 0) {
    rejectReasons.push(`holders ${holders} < ${c.minHolders}`);
  }

  // Volume: decreasing on dip then stabilising / returning
  const vol24 =
    Number(signal.metrics?.volume24hUsd) ||
    Number(signal.birdeye?.volume24hUsd) ||
    0;
  const volH1 =
    Number(signal.metrics?.volumeH1Usd) ||
    Number(signal.metrics?.recentVolumeUsd) ||
    0;
  const volM5 = Number(signal.metrics?.volumeM5Usd) || 0;
  const buy = Number(signal.metrics?.recentBuyVolumeUsd) || 0;
  const floorOk = vol24 >= c.minVolumeUsd || volH1 >= c.minVolumeUsd * 0.15;
  // Clearer dry-up (Conservative): H1 well below 24h pace + M5 reclaim
  // Flexible (Aggressive): floor or soft returning interest is enough
  const volumeDecreasingOnDip = c.requireClearVolumeDryUp
    ? vol24 > 0 && volH1 > 0 && volH1 < vol24 / 22 && volM5 > 0
    : vol24 > 0 && volH1 > 0 && volH1 < vol24 / 16;
  const volumeStabilisingOrReturning = c.requireClearVolumeDryUp
    ? volM5 > 0 &&
      volH1 > 0 &&
      volM5 * 12 >= volH1 * 1.25 &&
      (buy > 0 || (Number(signal.metrics?.buySellRatio) || 0) >= 1.05)
    : (volM5 > 0 && volH1 > 0 && volM5 * 12 >= volH1 * 0.9) ||
      (buy > 0 && floorOk);
  const volumeDryThenReturn =
    volumeDecreasingOnDip && volumeStabilisingOrReturning;
  const volumeOk = c.flexibleVolumeConfirmation
    ? floorOk || volumeStabilisingOrReturning || buy > 0
    : c.requireClearVolumeDryUp
      ? floorOk && volumeDryThenReturn
      : floorOk && (volumeDryThenReturn || volumeStabilisingOrReturning);
  if (volumeOk) {
    reasons.push(
      c.flexibleVolumeConfirmation && !volumeDryThenReturn
        ? 'flexible volume confirmation'
        : volumeDryThenReturn
          ? 'clear volume dry-up then returning interest'
          : 'volume stabilising / returning interest'
    );
  } else {
    rejectReasons.push(
      floorOk
        ? c.requireClearVolumeDryUp
          ? 'need clearer volume dry-up then return'
          : 'no volume dry-up/stabilise/return pattern'
        : 'volume too thin'
    );
  }

  const walletCount = Array.isArray(signal.wallets) ? signal.wallets.length : 0;
  const sm = Number(signal.birdeye?.smartMoneyScore) || 0;

  // Structured dip-phase smart wallet scoring (HQ buys / buybacks / cluster / flow)
  const dipSmartWallet = scoreDipSmartWalletActivity({
    wallets: signal.wallets,
    walletNames: signal.walletNames,
    mint: signal.mint,
    nearSupportOrFib: nearLevel === true,
    birdeyeSmartMoneyScore: Number.isFinite(sm) && sm > 0 ? sm : null,
    buySellRatio: signal.metrics?.buySellRatio ?? null,
    recentBuyVolumeUsd: signal.metrics?.recentBuyVolumeUsd ?? null,
    volumeH1Usd:
      signal.metrics?.volumeH1Usd ?? signal.metrics?.recentVolumeUsd ?? null,
    priorBuys: signal.priorBuys,
    nowMs,
    sensitivity: c.smartWalletDipSensitivity,
  });

  const smartMoneyOnDip =
    dipSmartWallet.active ||
    (c.stronglyPreferSmartMoney
      ? walletCount >= 1 || sm >= 55
      : walletCount >= 1 || sm >= 40);

  if (dipSmartWallet.active) {
    reasons.push(
      dipSmartWallet.strong
        ? `dip SM strong confirm (score ${dipSmartWallet.score})`
        : `dip SM confirm (score ${dipSmartWallet.score})`
    );
    for (const r of dipSmartWallet.reasons.slice(0, 3)) {
      if (!reasons.includes(r)) reasons.push(r);
    }
  } else if (smartMoneyOnDip) {
    reasons.push(
      c.stronglyPreferSmartMoney
        ? 'smart money on dip (strongly preferred ✓)'
        : 'smart money / wallet activity on dip (preferred)'
    );
  } else if (c.requireSmartMoney) {
    rejectReasons.push('smart money required on dip');
  } else if (
    c.profile === 'conservative' &&
    c.hardRequireSmartMoneyInConservative
  ) {
    rejectReasons.push('Conservative hard-require: no dip smart wallet activity');
  } else if (c.stronglyPreferSmartMoney) {
    rejectReasons.push('no smart money on dip (strongly preferred)');
  } else if (c.preferSmartMoney) {
    rejectReasons.push('no smart money on dip (preferred soft)');
  }
  // Aggressive: SM optional — no soft reject when absent

  const prefSet = new Set(c.preferredSessions.map((s) => s.toLowerCase()));
  const preferredSession =
    prefSet.has(session.primary) ||
    session.active.some((a) => prefSet.has(a)) ||
    (prefSet.has('europe_us') && session.active.includes('europe_us')) ||
    (prefSet.has('us') && session.primary === 'us');
  // Peak US hours: UTC 14–20 when prefer US
  const peakUsHours =
    session.utcHour >= 14 && session.utcHour < 21 && preferredSession;
  if (preferredSession) {
    reasons.push(
      peakUsHours
        ? `peak US hours ${session.label}`
        : `preferred session ${session.label}`
    );
  } else if (c.requirePreferredSession) {
    rejectReasons.push(
      `session ${session.label} not in preferred (${c.preferredSessions.join(',')})`
    );
  }

  const freshMigration =
    signal.isMigration === true && (!ageKnown || (ageH != null && ageH < 2));
  const earlyMcChase =
    signal.earlyBuy === true &&
    (!ageKnown || (ageH != null && ageH < c.minTokenAgeHours));
  if (freshMigration) {
    rejectReasons.push('fresh migration — use migration strategies instead');
  }
  if (earlyMcChase) {
    rejectReasons.push('early-MC chase — not a post-run dip');
  }

  let score = 0;
  if (hadStrongRun) score += 24;
  if (runInStandardBand) score += 6;
  if (dipped) score += 16;
  if (rotationSigns) score += 12;
  if (nearPreferredFib) score += 18;
  else if (technicals.nearKeyFib) score += 14;
  else if (technicals.nearSupport) score += 12;
  if (volumeOk) score += 10;
  if (volumeDryThenReturn) score += 8;
  if (dipSmartWallet.strong) score += 16;
  else if (dipSmartWallet.active) score += 12;
  else if (smartMoneyOnDip) score += c.stronglyPreferSmartMoney ? 8 : 6;
  else if (c.stronglyPreferSmartMoney) score -= 12;
  else if (c.preferSmartMoney) score -= 4;
  if (dipSmartWallet.clusterNearLevel) score += 6;
  if (dipSmartWallet.buybacks > 0) score += Math.min(8, dipSmartWallet.buybacks * 4);
  if (dipSmartWallet.netFlow === 'in') score += 4;
  else if (dipSmartWallet.netFlow === 'out') score -= 4;
  if (ageOk && ageKnown) score += 6;
  else if (ageOk) score += 2;
  if (peakUsHours) score += 8;
  else if (preferredSession) score += 5;
  else if (c.requirePreferredSession) score -= 10;
  if (liqKnownOk && liq > 0) score += 4;
  if (holdersOk && holders > 0) score += 3;
  if (setupWatchOk) score += 2;
  if (preferTech && !nearLevel && !requireTech) score -= 8;
  score = Math.max(0, Math.min(100, score));

  const smOk =
    (!c.requireSmartMoney || smartMoneyOnDip) &&
    (!c.stronglyPreferSmartMoney ||
      smartMoneyOnDip ||
      dipSmartWallet.active ||
      score >= scale.scoreGate + 8);
  // Conservative strongly prefers SM: without SM need exceptional score
  const smGateOk = c.stronglyPreferSmartMoney
    ? smartMoneyOnDip ||
      dipSmartWallet.active ||
      score >= scale.scoreGate + 12
    : true;
  const conservativeSmHardOk =
    !(c.profile === 'conservative' && c.hardRequireSmartMoneyInConservative) ||
    dipSmartWallet.active ||
    smartMoneyOnDip;

  const qualifies =
    hadStrongRun &&
    dipped &&
    rotationSigns &&
    ageOk &&
    setupWatchOk &&
    dipConditions &&
    volumeOk &&
    liqKnownOk &&
    holdersOk &&
    smOk &&
    smGateOk &&
    conservativeSmHardOk &&
    (!c.requirePreferredSession || preferredSession) &&
    (!requireTech || (nearLevel && techPref.ok)) &&
    score >= scale.scoreGate &&
    !freshMigration &&
    !earlyMcChase &&
    (!(preferTech && !nearLevel) || score >= scale.scoreGate + 10);

  const profileLabel =
    c.profile === 'conservative'
      ? 'Conservative Post-Run Dip'
      : c.profile === 'aggressive'
        ? 'Aggressive Post-Run Dip'
        : 'Standard';
  const rulesSummary =
    `[${profileLabel}] ` +
    `ENTRY: run≥${minRun.toFixed(0)}% · dip ${minDip.toFixed(0)}–${maxDip}% · ` +
    `age ${c.minTokenAgeHours}–${c.maxTokenAgeHours}h · watch≤${c.setupWatchMinutes}m · ` +
    `Fib ${c.preferredFibLevels.join('/')} ±${c.nearTechnicalPct}% · ` +
    `liq≥$${c.minLiquidityUsd} · holders≥${c.minHolders}` +
    (c.flexibleVolumeConfirmation
      ? ' · flexible vol'
      : c.requireClearVolumeDryUp
        ? ' · clear vol↓↑'
        : ' · vol↓then↑') +
    (c.stronglyPreferSmartMoney
      ? ' · SM strongly preferred'
      : c.requireSmartMoney ||
          (c.profile === 'conservative' && c.hardRequireSmartMoneyInConservative)
        ? ' · SM required'
        : c.preferSmartMoney
          ? ' · SM preferred'
          : ' · SM optional') +
    ` · dipSM[${c.smartWalletDipSensitivity}]` +
    (c.requirePreferredSession
      ? ` · session ${c.preferredSessions.join('|')}`
      : ' · wide sessions') +
    ` · score≥${scale.scoreGate}` +
    ` | INVALIDATION: zone break` +
    (c.invalidateRequireVolume ? '+vol' : ' (fast)') +
    ` / SL ${c.stopLossPct}% | EXIT: TP +${c.takeProfitPct}% or timer ${c.timeLimitMinutes}m`;

  const detail =
    `qualifies=${qualifies} score=${score} [${level}] run=${runPct.toFixed(0)}% ` +
    `drop=${dropFromHigh.toFixed(1)}% · ${technicals.detail} · ${session.label}` +
    (reasons.length ? ` ✓${reasons.slice(0, 5).join('; ')}` : '') +
    (rejectReasons.length ? ` ✗${rejectReasons.slice(0, 4).join('; ')}` : '');

  return {
    qualifies,
    score,
    reasons,
    rejectReasons,
    technicals,
    session,
    hadStrongRun,
    rotationSigns,
    dipConditions,
    volumeOk,
    volumeDryThenReturn,
    smartMoneyOnDip,
    dipSmartWallet,
    ageOk,
    rulesSummary,
    detail,
  };
}

export function applyPostRunDipVerdict(
  report: PostRunDipReport
): PostRunDipVerdict {
  const level = sensitivity();
  const c = cfg();
  const baseBoost = Math.max(10, Math.min(20, Math.round(c.boostPoints)));
  const boostMax = Math.max(baseBoost, Math.min(20, Math.round(c.boostPointsMax)));
  const sensMult = level === 'low' ? 0.85 : level === 'high' ? 1.15 : 1;

  let convictionDelta = 0;
  let skip = false;
  let skipReason: string | undefined;
  let seedExitMode = false;
  let smartWalletInfluenced = false;

  if (report.qualifies) {
    convictionDelta = Math.round(baseBoost * sensMult);
    // +extra when near key Fib/S + volume confirmation (Standard +10–20 total)
    if (report.technicals.nearKeyFib || report.technicals.nearSupport) {
      convictionDelta += report.volumeDryThenReturn ? 6 : 4;
    }
    if (report.volumeOk) convictionDelta += 2;
    const smBoost = dipSmartWalletConvictionBoost(
      report.dipSmartWallet,
      c.smartWalletDipBoostPoints
    );
    if (smBoost > 0) {
      convictionDelta += smBoost;
      smartWalletInfluenced = true;
    } else if (report.smartMoneyOnDip) {
      convictionDelta += 1;
    }
    // Cap: base boostPointsMax + room for SM confirmation bump
    convictionDelta = Math.min(boostMax + 6, Math.max(10, convictionDelta));
    seedExitMode = true;
  } else if (c.hardRequireSetup) {
    const hadData =
      report.technicals.range != null ||
      report.hadStrongRun ||
      report.rejectReasons.length > 0;
    if (hadData) {
      skip = true;
      skipReason =
        report.rejectReasons[0] ||
        `post-run dip setup not qualified (score ${report.score})`;
    }
  }

  // SM hard-require / Conservative hard gate → skip when no dip SM
  const needSmHard =
    c.requireSmartMoney ||
    (c.profile === 'conservative' && c.hardRequireSmartMoneyInConservative);
  if (
    needSmHard &&
    !report.dipSmartWallet.active &&
    !report.smartMoneyOnDip &&
    (report.hadStrongRun || report.dipConditions)
  ) {
    skip = true;
    skipReason =
      report.rejectReasons.find((r) => /smart money|dip smart wallet/i.test(r)) ||
      'dip smart wallet activity required';
    smartWalletInfluenced = true;
  }

  const influenced = skip || convictionDelta > 0;
  const logLine =
    `post-run dip ${level}: score=${report.score} Δconv=${
      convictionDelta > 0 ? '+' : ''
    }${convictionDelta}` +
    (skip ? ' SKIP' : report.qualifies ? ' TAKE' : ' no-setup') +
    (smartWalletInfluenced
      ? ` · SM→${skip ? 'skip' : 'boost'} (${report.dipSmartWallet.detail})`
      : ` · ${report.dipSmartWallet.detail}`) +
    ` · ${report.detail}` +
    (report.qualifies ? ` · ${report.rulesSummary}` : '');

  return {
    convictionDelta,
    skip,
    skipReason,
    seedExitMode,
    influenced,
    smartWalletInfluenced,
    report,
    logLine,
  };
}

export function resolvePostRunDipForSignal(
  signal: PostRunDipSignalInput
): PostRunDipVerdict | null {
  if (!isStrategyEnabled('post_run_dip')) return null;
  if (config.postRunDip?.enabled === false) return null;

  const report = evaluatePostRunDip(signal);
  const verdict = applyPostRunDipVerdict(report);

  const sessionVerdict = resolveMarketSessionForEntry(signal.nowMs);
  if (sessionVerdict?.preferred && verdict.convictionDelta > 0) {
    verdict.convictionDelta = Math.min(
      26,
      verdict.convictionDelta + 1
    );
    verdict.logLine += ` · session preferred`;
  }

  pushDipSmartWalletEvent(signal.symbol || signal.mint || 'token', verdict);

  return verdict;
}

export interface DipSmartWalletDashboardEvent {
  timestamp: number;
  symbol: string;
  mint?: string;
  outcome: 'boost' | 'skip' | 'take' | 'reject' | 'info';
  influenced: boolean;
  qualifies: boolean;
  convictionDelta: number;
  dipSmScore: number;
  dipSmActive: boolean;
  dipSmStrong: boolean;
  hqNewBuys: number;
  buybacks: number;
  clusterNearLevel: boolean;
  netFlow: string;
  detail: string;
  logLine: string;
}

const MAX_DIP_SM_EVENTS = 40;
const recentDipSmartWalletEvents: DipSmartWalletDashboardEvent[] = [];

function pushDipSmartWalletEvent(
  symbol: string,
  verdict: PostRunDipVerdict,
  outcome?: DipSmartWalletDashboardEvent['outcome']
): void {
  const sm = verdict.report.dipSmartWallet;
  const resolvedOutcome: DipSmartWalletDashboardEvent['outcome'] =
    outcome ??
    (verdict.skip
      ? 'skip'
      : verdict.report.qualifies
        ? verdict.convictionDelta > 0
          ? 'boost'
          : 'take'
        : 'reject');
  recentDipSmartWalletEvents.unshift({
    timestamp: Date.now(),
    symbol,
    mint: undefined,
    outcome: resolvedOutcome,
    influenced: verdict.smartWalletInfluenced,
    qualifies: verdict.report.qualifies,
    convictionDelta: verdict.convictionDelta,
    dipSmScore: sm.score,
    dipSmActive: sm.active,
    dipSmStrong: sm.strong,
    hqNewBuys: sm.hqNewBuys,
    buybacks: sm.buybacks,
    clusterNearLevel: sm.clusterNearLevel,
    netFlow: sm.netFlow,
    detail: sm.detail,
    logLine: verdict.logLine,
  });
  if (recentDipSmartWalletEvents.length > MAX_DIP_SM_EVENTS) {
    recentDipSmartWalletEvents.length = MAX_DIP_SM_EVENTS;
  }
}

export function getRecentDipSmartWalletActivity(
  limit = 25
): DipSmartWalletDashboardEvent[] {
  return recentDipSmartWalletEvents.slice(0, Math.max(1, Math.min(40, limit)));
}

export function logPostRunDipDecision(
  symbol: string,
  verdict: PostRunDipVerdict,
  outcome: 'boost' | 'skip' | 'take' | 'reject'
): void {
  logStrategyDecision(
    'post_run_dip',
    outcome === 'skip' || outcome === 'reject' ? 'skip' : 'take',
    `${symbol}: ${verdict.logLine}`
  );
  const tag =
    outcome === 'skip' || outcome === 'reject'
      ? 'SKIP'
      : outcome === 'boost' || outcome === 'take'
        ? 'TAKE'
        : 'INFO';
  console.log(`[post-run-dip] ${tag} ${symbol} — ${verdict.logLine}`);
  if (verdict.smartWalletInfluenced) {
    console.log(
      `[post-run-dip] SM-INFLUENCE ${symbol} — ${
        verdict.skip ? 'SKIP' : 'ENTER/BOOST'
      } · ${verdict.report.dipSmartWallet.detail}`
    );
    logStrategyDecision(
      'post_run_dip',
      verdict.skip ? 'skip' : 'take',
      `${symbol}: smart wallet dip ${verdict.skip ? 'blocked' : 'confirmed'} entry — ${verdict.report.dipSmartWallet.detail}`
    );
  }
  // Refresh dashboard ring with explicit outcome
  const top = recentDipSmartWalletEvents[0];
  if (
    top &&
    top.symbol === symbol &&
    Date.now() - top.timestamp < 2_000
  ) {
    top.outcome = outcome;
    top.influenced = verdict.smartWalletInfluenced;
  } else {
    pushDipSmartWalletEvent(symbol, verdict, outcome);
  }
}

/**
 * Position invalidation: clear break below Fib/support zone,
 * optionally requiring elevated volume (Standard default).
 */
export function shouldInvalidatePostRunDipPosition(input: {
  mint: string;
  priceSol: number;
  volumeH1Usd?: number | null;
  volumeM5Usd?: number | null;
  volume24hUsd?: number | null;
}): { invalidate: boolean; reason?: string } {
  const c = cfg();
  if (!c.invalidateOnZoneBreak) return { invalidate: false };
  if (!(input.priceSol > 0) || !input.mint) return { invalidate: false };

  const snap = evaluateBasicTechnicals({
    mint: input.mint,
    priceSol: input.priceSol,
    nearPct: c.nearTechnicalPct,
  });
  const supportLow = snap.snapshot?.nearestSupport?.low;
  const fib = snap.nearestKeyFib ?? snap.fibs.find((f) => f.near) ?? snap.fibs[0];
  const fibLow = fib?.zoneLow ?? (fib?.price != null ? fib.price * (1 - c.nearTechnicalPct / 100) : undefined);
  const zoneLow = Math.min(
    supportLow != null && supportLow > 0 ? supportLow : Infinity,
    fibLow != null && fibLow > 0 ? fibLow : Infinity
  );
  if (!(zoneLow > 0) || !Number.isFinite(zoneLow)) {
    return { invalidate: false };
  }

  // Clear break: Conservative = faster/tighter; Aggressive = more patient
  const breakNeed =
    c.profile === 'conservative'
      ? Math.max(0.6, c.nearTechnicalPct * 0.35)
      : c.profile === 'aggressive'
        ? c.nearTechnicalPct * 0.7
        : c.nearTechnicalPct * 0.5;
  const breakPct = ((zoneLow - input.priceSol) / zoneLow) * 100;
  if (breakPct < breakNeed) {
    return { invalidate: false };
  }

  if (c.invalidateRequireVolume) {
    const volH1 = Number(input.volumeH1Usd) || 0;
    const volM5 = Number(input.volumeM5Usd) || 0;
    const vol24 = Number(input.volume24hUsd) || 0;
    const elevated =
      (volM5 > 0 && volH1 > 0 && volM5 * 12 >= volH1 * 1.2) ||
      (volH1 > 0 && vol24 > 0 && volH1 >= vol24 / 20);
    if (!elevated) {
      return { invalidate: false };
    }
    return {
      invalidate: true,
      reason: `post-run dip invalidation — broke Fib/S zone $${zoneLow.toPrecision(4)} with volume (mark ${breakPct.toFixed(1)}% below)`,
    };
  }

  return {
    invalidate: true,
    reason: `post-run dip invalidation — clear break below Fib/S zone $${zoneLow.toPrecision(4)} (${breakPct.toFixed(1)}% below)`,
  };
}
