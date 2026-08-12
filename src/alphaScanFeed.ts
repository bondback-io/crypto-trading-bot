/**
 * AlphaScan-style New / Soon / Bonded discovery.
 * Synthesized from Jupiter Tokens API `/recent` + bonding-curve checks.
 * Additive specialty feed — default OFF; does not alter Jupiter trending.
 */

import { config } from './config';
import { logger, errorToMeta } from './logger';
import { isRpcGateSkipError } from './connection';
import {
  shouldDeferBackgroundForCritical,
  logBackgroundDeferred,
} from './rpcGate';
import { shouldSkipScannerTick, adaptiveScannerIntervalMs } from './rpcLoadControl';
import {
  fetchBondingCurve,
  getCachedBondingCurve,
} from './bondingCurve';
import {
  fetchJupiterRecentTokens,
  hasJupiterApiKey,
  isJupiterPumpFunToken,
  jupiterTokenToLaunchEvent,
  getJupiterTokensStatus,
  type JupiterTokenInfo,
} from './jupiterTokens';
import type { LaunchEvent } from './marketData';
import { getCachedSolUsdPrice } from './marketData';
import {
  handOffScannerCandidate,
  isScannerMintOnCooldown,
  type ScannerCandidate,
} from './marketScanner';
import { isStrategyEnabledGlobal } from './strategies';
import {
  isSmartBotProfilesEnabled,
  resolveTradeProfileDefinition,
  type TradeProfileId,
} from './tradeProfiles';

export type AlphaScanColumn = 'new' | 'soon' | 'bonded';

export interface AlphaScanRow {
  mint: string;
  symbol: string;
  name: string;
  column: AlphaScanColumn;
  marketCapUsd?: number;
  volumeH1Usd?: number;
  liquidityUsd?: number;
  holderCount?: number;
  organicScore?: number;
  curveProgressPct?: number | null;
  graduatedAtMs?: number | null;
  ageMs?: number | null;
  isPumpFun?: boolean;
  launchpad?: string | null;
  reasons: string[];
  updatedAt: number;
}

export interface AlphaScanSnapshot {
  enabled: boolean;
  hasApiKey: boolean;
  lastPollAt: number | null;
  lastError: string | null;
  lastHanded: number;
  counts: { new: number; soon: number; bonded: number };
  new: AlphaScanRow[];
  soon: AlphaScanRow[];
  bonded: AlphaScanRow[];
  jupiter?: ReturnType<typeof getJupiterTokensStatus>;
  config: typeof config.alphaScan;
}

const MAX_ROWS_PER_COLUMN = 40;
/** Cap curve RPCs per AlphaScan refresh — parallel 40 blew Secondary (Alchemy) RPS. */
const CURVE_ENRICH_CAP = 16;
/** Max in-flight bonding-curve fetches (Secondary lane is ~3 concurrent / 6 RPS). */
const CURVE_ENRICH_CONCURRENCY = 2;

let lastPollAt: number | null = null;
let lastError: string | null = null;
let lastHanded = 0;
let lastPassAt = 0;
let cachedNew: AlphaScanRow[] = [];
let cachedSoon: AlphaScanRow[] = [];
let cachedBonded: AlphaScanRow[] = [];
let passInFlight = false;
let bucketsRefreshInFlight: Promise<{
  new: AlphaScanRow[];
  soon: AlphaScanRow[];
  bonded: AlphaScanRow[];
}> | null = null;

function asCfg() {
  return config.alphaScan || {
    enabled: false,
    pollIntervalMs: 45_000,
    feedNew: true,
    feedSoon: true,
    feedBonded: true,
    routeSoonToMigrationSniper: true,
    routeBondedToScalper: true,
    routeBondedToReversalScalper: true,
    soonMinCurvePct: 70,
    bondedMaxAgeMinutes: 45,
    bondedMinMarketCapUsd: 25_000,
    maxHandOffPerPoll: 8,
    includeNewInScannerUniverse: false,
    recentLimit: 40,
  };
}

function solUsd(): number {
  const p = getCachedSolUsdPrice();
  return p && p > 0 ? p : 150;
}

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function tokenAgeMs(token: JupiterTokenInfo): number | null {
  const first = parseMs(token.firstPool?.createdAt);
  if (first != null) return Math.max(0, Date.now() - first);
  const created = parseMs(token.createdAt);
  if (created != null) return Math.max(0, Date.now() - created);
  return null;
}

function profileEnabled(id: TradeProfileId): boolean {
  if (config.tradeProfiles?.enabled === false) return false;
  if (config.tradeProfiles?.profiles?.[id] === false) return false;
  try {
    resolveTradeProfileDefinition(id);
    return true;
  } catch {
    return false;
  }
}

function toRow(
  token: JupiterTokenInfo,
  column: AlphaScanColumn,
  extra: {
    curveProgressPct?: number | null;
    graduatedAtMs?: number | null;
    reasons?: string[];
  } = {}
): AlphaScanRow {
  const mint = String(token.id || '').trim();
  const graduatedAtMs =
    extra.graduatedAtMs ?? parseMs(token.graduatedAt ?? null);
  return {
    mint,
    symbol: String(token.symbol || mint.slice(0, 6)).slice(0, 24),
    name: String(token.name || token.symbol || 'Unknown').slice(0, 64),
    column,
    marketCapUsd:
      token.mcap != null && Number.isFinite(Number(token.mcap))
        ? Number(token.mcap)
        : undefined,
    volumeH1Usd: (() => {
      const buy = Number(token.stats1h?.buyVolume ?? 0);
      const sell = Number(token.stats1h?.sellVolume ?? 0);
      const v = buy + sell;
      return v > 0 ? v : undefined;
    })(),
    liquidityUsd:
      token.liquidity != null && Number.isFinite(Number(token.liquidity))
        ? Number(token.liquidity)
        : undefined,
    holderCount:
      token.holderCount != null && Number.isFinite(Number(token.holderCount))
        ? Number(token.holderCount)
        : undefined,
    organicScore:
      token.organicScore != null && Number.isFinite(Number(token.organicScore))
        ? Number(token.organicScore)
        : undefined,
    curveProgressPct: extra.curveProgressPct ?? null,
    graduatedAtMs,
    ageMs: tokenAgeMs(token),
    isPumpFun: isJupiterPumpFunToken(token),
    launchpad: token.launchpad ?? null,
    reasons: extra.reasons || [`alphascan:${column}`],
    updatedAt: Date.now(),
  };
}

function buildCandidate(
  event: LaunchEvent,
  profileId: string,
  column: AlphaScanColumn,
  rankScore: number,
  reasons: string[],
  curveProgressPct?: number | null
): ScannerCandidate & { launch: LaunchEvent } {
  const now = Date.now();
  return {
    id: `alphascan-${column}-${profileId}-${event.mint.slice(0, 8)}-${now}`,
    mint: event.mint,
    symbol: event.symbol,
    name: event.name,
    timestamp: now,
    status: 'seen',
    rankScore,
    reasons,
    source: event.source,
    migrated: Boolean(event.migrated),
    liquidityUsd: event.liquidityUsd,
    marketCapUsd: event.marketCapUsd,
    volumeUsd: event.volumeUsd,
    volumeH1Usd: event.volumeH1Usd,
    volumeM5Usd: event.volumeM5Usd,
    volumeH6Usd: event.volumeH6Usd,
    priceChangeH1Pct: event.priceChangeH1Pct,
    priceChangePct: event.priceChangePct,
    holderCount: event.holderCount,
    isPumpFun: event.isPumpFun,
    organicScore: event.organicScore,
    preferredProfileId: profileId,
    specialtyFeed: 'alphascan',
    nearMigration:
      curveProgressPct != null && curveProgressPct >= asCfg().soonMinCurvePct,
    curveProgressPct: curveProgressPct ?? null,
    candleSource: event.candleSource ?? 'synthetic',
    launch: {
      ...event,
      preferredProfileId: profileId,
      specialtyFeed: 'alphascan',
    },
  };
}

async function enrichCurves(
  tokens: JupiterTokenInfo[]
): Promise<
  Map<
    string,
    {
      progressPct: number | null;
      complete: boolean;
      nearMigration: boolean;
      missing: boolean;
    }
  >
> {
  const out = new Map<
    string,
    {
      progressPct: number | null;
      complete: boolean;
      nearMigration: boolean;
      missing: boolean;
    }
  >();
  const pumpish = tokens.filter(
    (t) =>
      isJupiterPumpFunToken(t) ||
      String(t.id || '')
        .toLowerCase()
        .endsWith('pump')
  );
  const slice = pumpish.slice(0, CURVE_ENRICH_CAP);
  // No outer runWithRpcRole + Promise.all(40) — that held one gate slot while
  // firing dozens of parallel getAccountInfo and starved Secondary RPS.
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(CURVE_ENRICH_CONCURRENCY, Math.max(1, slice.length)) },
    async () => {
      while (cursor < slice.length) {
        const t = slice[cursor++];
        if (!t) continue;
        const mint = String(t.id || '').trim();
        if (!mint) continue;
        try {
          const cached = getCachedBondingCurve(mint);
          const state = cached || (await fetchBondingCurve(mint));
          if (!state || state.source === 'none') {
            out.set(mint, {
              progressPct: null,
              complete: false,
              nearMigration: false,
              missing: true,
            });
            continue;
          }
          out.set(mint, {
            progressPct: state.progressPct,
            complete: state.complete === true,
            nearMigration: state.nearMigration === true,
            missing: false,
          });
        } catch (err) {
          if (isRpcGateSkipError(err)) {
            logBackgroundDeferred('AlphaScan', `lane gate ${err.kind}`, {
              role: err.role,
            });
            continue;
          }
          /* leave unset — stay New */
        }
      }
    }
  );
  await Promise.all(workers);
  return out;
}

/**
 * Refresh New/Soon/Bonded caches from Jupiter /recent + curve enrich.
 * Throttled — dashboard polls /api/alphascan every ~5s and must NOT re-hit RPC.
 */
export async function refreshAlphaScanBuckets(opts?: {
  /** Bypass throttle (background feed pass). */
  force?: boolean;
}): Promise<{
  new: AlphaScanRow[];
  soon: AlphaScanRow[];
  bonded: AlphaScanRow[];
}> {
  const cfg = asCfg();
  if (!hasJupiterApiKey()) {
    lastError = 'No JUPITER_API_KEY';
    return { new: cachedNew, soon: cachedSoon, bonded: cachedBonded };
  }

  const minGap = adaptiveScannerIntervalMs(
    Math.max(50_000, Number(cfg.pollIntervalMs) || 55_000)
  );
  if (
    !opts?.force &&
    lastPollAt != null &&
    Date.now() - lastPollAt < minGap
  ) {
    return { new: cachedNew, soon: cachedSoon, bonded: cachedBonded };
  }

  if (bucketsRefreshInFlight && !opts?.force) {
    return bucketsRefreshInFlight;
  }

  const doRefresh = async () => {
  const tokens = await fetchJupiterRecentTokens(cfg.recentLimit || 40);
  const curves = await enrichCurves(tokens);
  const now = Date.now();
  const bondedMaxMs = Math.max(1, cfg.bondedMaxAgeMinutes || 45) * 60_000;
  const soonMin = Math.max(0, Math.min(99, Number(cfg.soonMinCurvePct) || 70));
  const bondedMinMc = Math.max(
    0,
    Number(cfg.bondedMinMarketCapUsd) || 25_000
  );

  const news: AlphaScanRow[] = [];
  const soons: AlphaScanRow[] = [];
  const bondeds: AlphaScanRow[] = [];

  for (const token of tokens) {
    const mint = String(token.id || '').trim();
    if (!mint) continue;
    const graduatedAtMs = parseMs(token.graduatedAt ?? null);
    const ageMs = tokenAgeMs(token);
    const curve = curves.get(mint);
    const progress =
      curve?.progressPct != null && Number.isFinite(curve.progressPct)
        ? curve.progressPct
        : null;
    const complete = curve?.complete === true && curve?.missing !== true;
    const curveMissing = curve?.missing === true;
    const nearMig = curve?.nearMigration === true;
    const pumpish =
      isJupiterPumpFunToken(token) || mint.toLowerCase().endsWith('pump');
    const mcUsd =
      token.mcap != null && Number.isFinite(Number(token.mcap))
        ? Number(token.mcap)
        : null;
    const mcOk = mcUsd != null && mcUsd >= bondedMinMc;

    // Bonded = true post-grad only: graduatedAt in window OR real curve complete,
    // always with min MC (blocks ~$2k missing-curve false positives).
    const graduatedFresh =
      graduatedAtMs != null &&
      now - graduatedAtMs >= 0 &&
      now - graduatedAtMs <= bondedMaxMs;
    const firstPoolFresh =
      ageMs != null && ageMs >= 0 && ageMs <= bondedMaxMs;
    const looksBonded =
      mcOk &&
      (graduatedFresh ||
        (pumpish && firstPoolFresh && complete));

    if (looksBonded && cfg.feedBonded !== false) {
      bondeds.push(
        toRow(token, 'bonded', {
          curveProgressPct: progress ?? (complete ? 100 : null),
          graduatedAtMs,
          reasons: [
            'alphascan:bonded',
            graduatedFresh ? 'graduatedAt' : 'curve-complete',
          ],
        })
      );
      continue;
    }

    // Soon: still on curve, pump-like, near migration / ≥ Soon min %
    const soonOk =
      pumpish &&
      !graduatedAtMs &&
      !complete &&
      !curveMissing &&
      progress != null &&
      (progress >= soonMin || nearMig);

    if (soonOk && cfg.feedSoon !== false) {
      soons.push(
        toRow(token, 'soon', {
          curveProgressPct: progress,
          graduatedAtMs: null,
          reasons: [
            'alphascan:soon',
            nearMig && (progress == null || progress < soonMin)
              ? 'near-mig'
              : `curve ${progress!.toFixed(0)}%`,
          ],
        })
      );
      continue;
    }

    if (cfg.feedNew !== false) {
      news.push(
        toRow(token, 'new', {
          curveProgressPct: progress ?? null,
          graduatedAtMs,
          reasons: [
            'alphascan:new',
            progress != null ? `curve ${progress.toFixed(0)}%` : 'no-curve-yet',
          ],
        })
      );
    }
  }

  cachedNew = news.slice(0, MAX_ROWS_PER_COLUMN);
  cachedSoon = soons.slice(0, MAX_ROWS_PER_COLUMN);
  cachedBonded = bondeds.slice(0, MAX_ROWS_PER_COLUMN);
  lastPollAt = Date.now();
  lastError = null;
  return { new: cachedNew, soon: cachedSoon, bonded: cachedBonded };
  };

  if (opts?.force) {
    return doRefresh();
  }
  bucketsRefreshInFlight = doRefresh().finally(() => {
    bucketsRefreshInFlight = null;
  });
  return bucketsRefreshInFlight;
}

/**
 * Additive handoff: Soon → Migration Sniper grad-watch; Bonded → Scalper / Reversal.
 */
export async function runAlphaScanFeedPass(): Promise<number> {
  const cfg = asCfg();
  if (!cfg.enabled) return 0;
  if (!isStrategyEnabledGlobal('ta_market_scanner')) return 0;
  if (!isSmartBotProfilesEnabled()) return 0;
  if (config.tradeProfiles?.enabled === false) return 0;
  if (!hasJupiterApiKey()) {
    lastError = 'No JUPITER_API_KEY';
    return 0;
  }

  const interval = adaptiveScannerIntervalMs(
    Math.max(50_000, Number(cfg.pollIntervalMs) || 55_000)
  );
  if (passInFlight) return 0;
  if (lastPassAt && Date.now() - lastPassAt < interval * 0.85) {
    return 0;
  }

  const defer = shouldDeferBackgroundForCritical('scanner');
  if (defer.defer) {
    logBackgroundDeferred('AlphaScan', defer.reason || 'Scanners busy');
    return 0;
  }
  const adapt = shouldSkipScannerTick('alpha_scan');
  if (adapt.skip) {
    logBackgroundDeferred('AlphaScan', adapt.reason || 'adaptive');
    return 0;
  }

  passInFlight = true;
  let handed = 0;
  try {
    const buckets = await refreshAlphaScanBuckets({ force: true });
    const preferOrganic =
      config.marketScanner?.preferOrganicVolume !== false;
    const sol = solUsd();
    const maxHand = Math.max(1, Math.min(20, Number(cfg.maxHandOffPerPoll) || 8));
    const handedMints = new Set<string>();

    // Soon → Migration Sniper (grad-watch path)
    if (
      cfg.feedSoon !== false &&
      cfg.routeSoonToMigrationSniper !== false &&
      profileEnabled('migration_sniper')
    ) {
      const {
        offerMigrationGradWatchFromCandidate,
      } = require('./migrationGradWatch') as typeof import('./migrationGradWatch');

      for (const row of buckets.soon) {
        if (handed >= maxHand) break;
        if (!row.mint || handedMints.has(row.mint)) continue;
        if (isScannerMintOnCooldown(row.mint)) continue;

        offerMigrationGradWatchFromCandidate({
          mint: row.mint,
          symbol: row.symbol,
          name: row.name,
          marketCapUsd: row.marketCapUsd,
          volumeH1Usd: row.volumeH1Usd,
          holderCount: row.holderCount,
          curveProgressPct: row.curveProgressPct,
          nearMigration: true,
          preferredProfileId: 'migration_sniper',
          specialtyFeed: 'alphascan',
        });

        // Soft handoff so monitor can also see the mint
        const tokenLike: JupiterTokenInfo = {
          id: row.mint,
          symbol: row.symbol,
          name: row.name,
          mcap: row.marketCapUsd ?? null,
          liquidity: row.liquidityUsd ?? null,
          holderCount: row.holderCount ?? null,
          organicScore: row.organicScore,
          launchpad: row.launchpad,
        };
        const event = jupiterTokenToLaunchEvent(tokenLike, sol, {
          preferOrganicVolume: preferOrganic,
        });
        event.migrated = false;
        event.isPumpFun = true;
        const cand = buildCandidate(
          event,
          'migration_sniper',
          'soon',
          72,
          row.reasons,
          row.curveProgressPct
        );
        if (handOffScannerCandidate(cand)) {
          handed += 1;
          handedMints.add(row.mint);
        }
      }
    }

    // Bonded → Scalper / Reversal Scalper
    if (cfg.feedBonded !== false) {
      const targets: TradeProfileId[] = [];
      if (cfg.routeBondedToScalper !== false && profileEnabled('scalper')) {
        targets.push('scalper');
      }
      if (
        cfg.routeBondedToReversalScalper !== false &&
        profileEnabled('reversal_scalper')
      ) {
        targets.push('reversal_scalper');
      }

      for (const row of buckets.bonded) {
        if (handed >= maxHand) break;
        if (!row.mint || handedMints.has(row.mint)) continue;
        if (isScannerMintOnCooldown(row.mint)) continue;

        for (const profileId of targets) {
          if (handed >= maxHand) break;
          const tokenLike: JupiterTokenInfo = {
            id: row.mint,
            symbol: row.symbol,
            name: row.name,
            mcap: row.marketCapUsd ?? null,
            liquidity: row.liquidityUsd ?? null,
            holderCount: row.holderCount ?? null,
            organicScore: row.organicScore,
            graduatedAt: row.graduatedAtMs
              ? new Date(row.graduatedAtMs).toISOString()
              : null,
            launchpad: row.launchpad,
          };
          const event = jupiterTokenToLaunchEvent(tokenLike, sol, {
            preferOrganicVolume: preferOrganic,
          });
          event.migrated = true;
          const cand = buildCandidate(
            event,
            profileId,
            'bonded',
            68,
            [...row.reasons, `prefer:${profileId}`],
            row.curveProgressPct
          );
          if (handOffScannerCandidate(cand)) {
            handed += 1;
            handedMints.add(row.mint);
            break; // one profile handoff per mint per poll
          }
        }
      }
    }

    lastHanded = handed;
    lastPassAt = Date.now();
    if (handed > 0) {
      logger.info('AlphaScan', `Handed ${handed} candidate(s)`, {
        soon: buckets.soon.length,
        bonded: buckets.bonded.length,
        neu: buckets.new.length,
      });
    }
    return handed;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    logger.warn('AlphaScan', 'Feed pass failed', errorToMeta(err));
    return handed;
  } finally {
    passInFlight = false;
  }
}

/** Optional soft-merge of New column into scanner universe (when toggle on). */
export function getAlphaScanNewLaunchEvents(): LaunchEvent[] {
  const cfg = asCfg();
  if (!cfg.enabled || cfg.includeNewInScannerUniverse !== true) return [];
  if (!cachedNew.length) return [];
  const preferOrganic =
    config.marketScanner?.preferOrganicVolume !== false;
  const sol = solUsd();
  return cachedNew.map((row) => {
    const event = jupiterTokenToLaunchEvent(
      {
        id: row.mint,
        symbol: row.symbol,
        name: row.name,
        mcap: row.marketCapUsd ?? null,
        liquidity: row.liquidityUsd ?? null,
        holderCount: row.holderCount ?? null,
        organicScore: row.organicScore,
        launchpad: row.launchpad,
      },
      sol,
      { preferOrganicVolume: preferOrganic }
    );
    return event;
  });
}

export function getAlphaScanSnapshot(): AlphaScanSnapshot {
  const cfg = asCfg();
  return {
    enabled: cfg.enabled === true,
    hasApiKey: hasJupiterApiKey(),
    lastPollAt,
    lastError,
    lastHanded,
    counts: {
      new: cachedNew.length,
      soon: cachedSoon.length,
      bonded: cachedBonded.length,
    },
    new: cachedNew,
    soon: cachedSoon,
    bonded: cachedBonded,
    jupiter: getJupiterTokensStatus(),
    config: { ...cfg },
  };
}
