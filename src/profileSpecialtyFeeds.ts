/**
 * Per-profile specialty token feeds — Kolscan/KOL mint universe + Jupiter
 * category×interval slices — injected into the existing Market Scanner handler
 * so lane fight / Smart Bot architecture stays unchanged.
 */

import { config } from './config';
import type { LaunchEvent } from './marketData';
import {
  fetchJupiterTopTokens,
  hasJupiterApiKey,
  jupiterTokenToLaunchEvent,
  type JupiterCategory,
  type JupiterInterval,
} from './jupiterTokens';
import {
  handOffScannerCandidate,
  isScannerMintOnCooldown,
  type ScannerCandidate,
} from './marketScanner';
import { isStrategyEnabledGlobal } from './strategies';
import {
  isSmartBotProfilesEnabled,
  resolveTradeProfileDefinition,
  TRADE_PROFILE_CATALOG,
  type TradeProfileId,
} from './tradeProfiles';
import { getZionScannerFeed } from './zionKolScanner';
import { MEDIUM_MIN_MC_USD } from './majorsUniverse';

const PER_PROFILE_CAP = 6;
const JUPITER_FETCH_LIMIT = 40;

/** Quality lanes soft-prefer the same mint as Dip / others — don't share-block. */
const QUALITY_SOFT_PREFER_IDS = new Set<TradeProfileId>([
  'trend_rider',
  'high_win_rate',
  'steady_compounder',
]);

const VALID_CATEGORIES = new Set<JupiterCategory>([
  'toptraded',
  'toptrending',
  'toporganicscore',
]);
const VALID_INTERVALS = new Set<JupiterInterval>(['5m', '1h', '6h', '24h']);

function normalizeCategory(raw: unknown): JupiterCategory | null {
  const s = String(raw || '').trim().toLowerCase() as JupiterCategory;
  return VALID_CATEGORIES.has(s) ? s : null;
}

function normalizeInterval(raw: unknown): JupiterInterval | null {
  const s = String(raw || '').trim().toLowerCase() as JupiterInterval;
  return VALID_INTERVALS.has(s) ? s : null;
}

function solUsd(): number {
  return 150;
}

function buildCandidate(
  event: LaunchEvent,
  profileId: string,
  feed: 'jupiter' | 'kolscan',
  rankScore: number,
  reasons: string[],
  kolCount?: number
): ScannerCandidate & { launch: LaunchEvent } {
  const now = Date.now();
  // Only Migration Sniper specialty may carry migrated=true into lane fight.
  // Other profiles ingest Jupiter/KOL as normal scanner TA — not migration events.
  const migratedForLane =
    profileId === 'migration_sniper' ? Boolean(event.migrated) : false;
  return {
    id: `feed-${profileId}-${event.mint.slice(0, 8)}-${now}`,
    mint: event.mint,
    symbol: event.symbol,
    name: event.name,
    timestamp: now,
    status: 'seen',
    rankScore,
    reasons,
    source: event.source,
    migrated: migratedForLane,
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
    specialtyFeed: feed,
    kolCount: kolCount != null && kolCount > 0 ? kolCount : undefined,
    candleSource: event.candleSource ?? 'synthetic',
    launch: {
      ...event,
      migrated: migratedForLane,
      preferredProfileId: profileId,
      specialtyFeed: feed,
    },
  };
}

function kolCandidateToLaunch(c: {
  mint: string;
  symbol: string;
  name: string;
  mcUsd?: number;
  volumeH1Usd?: number;
  liquidityUsd?: number;
  holders?: number;
  timestamp: number;
}): LaunchEvent {
  return {
    mint: c.mint,
    symbol: c.symbol || c.mint.slice(0, 6),
    name: c.name || c.symbol || 'KOL token',
    launchedAt: c.timestamp || Date.now(),
    migrated: true,
    entryPriceSol: 0,
    lastPriceSol: 0,
    priceChangePct: 0,
    liquidityUsd: c.liquidityUsd,
    volumeH1Usd: c.volumeH1Usd,
    volumeUsd: c.volumeH1Usd,
    marketCapUsd: c.mcUsd,
    holderCount: c.holders,
    candles: [],
    source: 'kolscan',
    candleSource: 'synthetic',
    solUsd: solUsd(),
  };
}

function candidateInProfileMcBand(
  mc: number | null | undefined,
  minMc: number | null | undefined,
  maxMc: number | null | undefined
): boolean {
  if (mc == null || !Number.isFinite(mc) || mc <= 0) {
    // Unknown MC: allow soft profiles; migration/scalper hard-caps need a number
    return minMc == null && maxMc == null;
  }
  if (minMc != null && Number.isFinite(minMc) && minMc > 0 && mc < minMc) {
    return false;
  }
  if (maxMc != null && Number.isFinite(maxMc) && maxMc > 0 && mc > maxMc) {
    return false;
  }
  return true;
}

function offerTrendWatchFromSpecialty(
  c: ScannerCandidate,
  feed: 'jupiter' | 'kolscan'
): void {
  try {
    const { offerTrendWatchFromCandidate } =
      require('./trendSetupWatch') as typeof import('./trendSetupWatch');
    offerTrendWatchFromCandidate({
      mint: c.mint,
      symbol: c.symbol,
      name: c.name,
      marketCapUsd: c.marketCapUsd,
      volumeH1Usd: c.volumeH1Usd,
      volumeM5Usd: c.volumeM5Usd,
      volumeH6Usd: c.volumeH6Usd,
      holderCount: c.holderCount,
      priceChangeH1Pct: c.priceChangeH1Pct,
      priceChangePct: c.priceChangePct,
      lastPriceSol: c.lastPriceSol ?? null,
      kolCount: c.kolCount,
      specialtyFeed: feed,
      chartPatternIds: c.chartPatternIds,
    });
  } catch {
    /* optional */
  }
}

/**
 * One specialty pass for all enabled profiles with kolscanFeedEnabled.
 * Returns number of candidates handed to the scanner handler.
 */
export async function runProfileSpecialtyFeedPass(): Promise<number> {
  if (!isStrategyEnabledGlobal('ta_market_scanner')) return 0;
  if (!isSmartBotProfilesEnabled()) return 0;
  if (config.tradeProfiles?.enabled === false) return 0;

  const profiles = TRADE_PROFILE_CATALOG.filter((p) => {
    if (p.id === 'default') return false;
    if (config.tradeProfiles?.profiles?.[p.id] === false) return false;
    const def = resolveTradeProfileDefinition(p.id);
    return def.match.kolscanFeedEnabled === true;
  });
  if (!profiles.length) return 0;

  // Coalesce Jupiter fetches by category×interval
  type PairKey = string;
  const pairToProfiles = new Map<
    PairKey,
    { category: JupiterCategory; interval: JupiterInterval; ids: TradeProfileId[] }
  >();
  for (const p of profiles) {
    const def = resolveTradeProfileDefinition(p.id);
    const category = normalizeCategory(def.match.jupiterCategory);
    const interval = normalizeInterval(def.match.jupiterInterval);
    if (!category || !interval) continue;
    const key = `${category}|${interval}`;
    const row = pairToProfiles.get(key) || {
      category,
      interval,
      ids: [] as TradeProfileId[],
    };
    row.ids.push(p.id);
    pairToProfiles.set(key, row);
  }

  const jupiterByPair = new Map<PairKey, LaunchEvent[]>();
  if (hasJupiterApiKey()) {
    const preferOrganic =
      config.marketScanner?.preferOrganicVolume !== false;
    await Promise.all(
      [...pairToProfiles.entries()].map(async ([key, spec]) => {
        try {
          const tokens = await fetchJupiterTopTokens(
            spec.category,
            spec.interval,
            JUPITER_FETCH_LIMIT
          );
          const events = tokens.map((t) =>
            jupiterTokenToLaunchEvent(t, solUsd(), {
              preferOrganicVolume: preferOrganic,
            })
          );
          jupiterByPair.set(key, events);
        } catch (err) {
          console.warn(
            `[profile-feed] Jupiter ${spec.category}/${spec.interval} failed:`,
            err instanceof Error ? err.message : err
          );
        }
      })
    );
  }

  const kolFeed = getZionScannerFeed(80);
  let handed = 0;
  const handedMints = new Set<string>();

  for (const p of profiles) {
    const def = resolveTradeProfileDefinition(p.id);
    const m = def.match;
    const softPrefer = QUALITY_SOFT_PREFER_IDS.has(p.id);
    const profileHandedMints = new Set<string>();
    const minKol = Math.max(
      1,
      Math.min(20, Math.round(Number(m.minKolWallets) || 3))
    );
    const minQ = Math.max(
      0,
      Math.min(100, Math.round(Number(m.minWalletQuality) || 40))
    );
    let profileHanded = 0;
    const minMc =
      m.minMarketCapUsd != null &&
      Number.isFinite(m.minMarketCapUsd) &&
      m.minMarketCapUsd > 0
        ? Number(m.minMarketCapUsd)
        : null;
    const maxMc =
      m.maxMarketCapUsd != null &&
      Number.isFinite(m.maxMarketCapUsd) &&
      m.maxMarketCapUsd > 0
        ? Number(m.maxMarketCapUsd)
        : null;
    const minVolH1 =
      m.minVolumeH1Usd != null &&
      Number.isFinite(m.minVolumeH1Usd) &&
      m.minVolumeH1Usd > 0
        ? Number(m.minVolumeH1Usd)
        : null;

    // Jupiter slice
    const category = normalizeCategory(m.jupiterCategory);
    const interval = normalizeInterval(m.jupiterInterval);
    if (category && interval) {
      const key = `${category}|${interval}`;
      const events = jupiterByPair.get(key) || [];
      for (const ev of events) {
        if (profileHanded >= PER_PROFILE_CAP) break;
        if (!ev.mint) continue;
        // Quality lanes only dedupe within-profile so Trend/Compounder can
        // soft-prefer alongside Dip on overlapping organics.
        if (softPrefer) {
          if (profileHandedMints.has(ev.mint)) continue;
        } else if (handedMints.has(ev.mint)) {
          continue;
        }
        if (isScannerMintOnCooldown(ev.mint)) continue;
        const mc = Number(ev.marketCapUsd);
        if (!candidateInProfileMcBand(mc, minMc, maxMc)) continue;
        // Skip dead tape for specialty handoffs (H1 vol known and far below floor)
        const volH1 = Number(ev.volumeH1Usd);
        if (
          minVolH1 != null &&
          Number.isFinite(volH1) &&
          volH1 > 0 &&
          volH1 < minVolH1 * 0.35
        ) {
          continue;
        }
        // Migration Sniper specialty: never ingest stale high-MC Jupiter names
        if (p.id === 'migration_sniper') {
          const ageH =
            ev.launchedAt > 0
              ? (Date.now() - ev.launchedAt) / 3_600_000
              : null;
          if (ageH != null && ageH > 6) continue;
          if (!ev.migrated && !ev.isPumpFun) continue;
        }
        const c = buildCandidate(
          ev,
          p.id,
          'jupiter',
          70,
          [`specialty:${p.id}`, `jupiter:${category}/${interval}`]
        );
        c.jupiterCategory = category;
        if (p.id === 'trend_rider') {
          offerTrendWatchFromSpecialty(c, 'jupiter');
        }
        if (handOffScannerCandidate(c)) {
          handed += 1;
          profileHanded += 1;
          profileHandedMints.add(ev.mint);
          if (!softPrefer) handedMints.add(ev.mint);
          // Dip minor supply from Jupiter specialty (non-quality MC only).
          // Medium/majors parks stay on majorsUniverse Steady pass.
          // Trend-band names go to Trend watch above — not Dip minors.
          try {
            const mcN = Number(c.marketCapUsd) || 0;
            const isQualityMc = mcN >= MEDIUM_MIN_MC_USD;
            if (
              p.id !== 'trend_rider' &&
              !isQualityMc &&
              (p.id === 'dip_buyer' || !softPrefer)
            ) {
              const { offerDipWatchFromCandidate } =
                require('./dipSetupWatch') as typeof import('./dipSetupWatch');
              offerDipWatchFromCandidate({
                mint: c.mint,
                symbol: c.symbol,
                name: c.name,
                marketCapUsd: c.marketCapUsd,
                volumeH1Usd: c.volumeH1Usd,
                holderCount: c.holderCount,
                priceChangeH1Pct: c.priceChangeH1Pct,
                lastPriceSol: c.lastPriceSol ?? null,
                specialtyFeed: 'jupiter',
                preferredProfileId: 'dip_buyer',
              });
            }
          } catch {
            /* optional */
          }
        }
      }
      console.log(
        `[profile-feed] ${p.id} jupiter:${category}/${interval} → ` +
          `${Math.min(events.length, PER_PROFILE_CAP)} considered`
      );
    }

    // Kolscan / KOL mint universe
    for (const kc of kolFeed) {
      if (profileHanded >= PER_PROFILE_CAP) break;
      if (!kc.mint) continue;
      if (softPrefer) {
        if (profileHandedMints.has(kc.mint)) continue;
      } else if (handedMints.has(kc.mint)) {
        continue;
      }
      if (isScannerMintOnCooldown(kc.mint)) continue;
      if ((kc.kolCount || 0) < minKol) continue;
      const quals = (kc.kolWallets || [])
        .map((w) => Number(w.quality))
        .filter((q) => Number.isFinite(q));
      const avgQ =
        quals.length > 0
          ? quals.reduce((a, b) => a + b, 0) / quals.length
          : 0;
      if (avgQ < minQ) continue;
      const ev = kolCandidateToLaunch(kc);
      const mc = Number(ev.marketCapUsd);
      if (!candidateInProfileMcBand(mc, minMc, maxMc)) continue;
      if (p.id === 'migration_sniper') {
        const ageH =
          ev.launchedAt > 0
            ? (Date.now() - ev.launchedAt) / 3_600_000
            : null;
        if (ageH != null && ageH > 6) continue;
      }
      const c = buildCandidate(
        ev,
        p.id,
        'kolscan',
        Math.min(95, 55 + (kc.kolCount || 0) * 4),
        [
          `specialty:${p.id}`,
          `kolscan:${kc.kolCount} KOLs`,
          `WQ ${avgQ.toFixed(0)}`,
        ],
        kc.kolCount
      );
      if (p.id === 'trend_rider') {
        offerTrendWatchFromSpecialty(c, 'kolscan');
      }
      if (handOffScannerCandidate(c)) {
        handed += 1;
        profileHanded += 1;
        profileHandedMints.add(kc.mint);
        if (!softPrefer) handedMints.add(kc.mint);
        if (p.id !== 'trend_rider') {
          try {
            const { offerDipWatchFromCandidate } =
              require('./dipSetupWatch') as typeof import('./dipSetupWatch');
            offerDipWatchFromCandidate({
              mint: c.mint,
              symbol: c.symbol,
              name: c.name,
              marketCapUsd: c.marketCapUsd,
              volumeH1Usd: c.volumeH1Usd,
              holderCount: c.holderCount,
              priceChangeH1Pct: c.priceChangeH1Pct,
              kolCount: c.kolCount,
              specialtyFeed: 'kolscan',
              preferredProfileId: 'dip_buyer',
            });
          } catch {
            /* optional */
          }
        }
      }
    }
  }

  return handed;
}
