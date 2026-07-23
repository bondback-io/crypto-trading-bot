/**
 * Pump.fun bonding curve analysis — progress %, SOL raised, migration proximity.
 * Reads on-chain bonding-curve PDA (seeds: ["bonding-curve", mint]).
 */

import { PublicKey } from '@solana/web3.js';
import { config, HARD_FILTER_FLOORS } from './config';
import { getConnection } from './connection';
import { logger, errorToMeta, loggedFetch } from './logger';

/** Canonical initial real token reserves (raw, 6 decimals) from Pump.fun Global */
const DEFAULT_INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000n;
/** Typical SOL raised when curve completes / migrates */
const DEFAULT_MIGRATION_THRESHOLD_SOL = 85;
/** Initial virtual SOL (pricing baseline) */
const DEFAULT_INITIAL_VIRTUAL_SOL = 30;

export interface BondingCurveState {
  mint: string;
  bondingCurve: string;
  /** 0–100 curve fill (tokens sold from initial real reserves) */
  progressPct: number;
  /** SOL currently in the curve (real reserves) */
  solRaised: number;
  /** Tokens still in the bonding curve pool (UI amount, 6dp assumption) */
  tokensInPool: number;
  /** Raw real token reserves */
  realTokenReserves: number;
  /** Raw virtual token reserves */
  virtualTokenReserves: number;
  /** Raw virtual SOL reserves (lamports) */
  virtualSolReserves: number;
  /** Raw real SOL reserves (lamports) */
  realSolReserves: number;
  tokenTotalSupply: number;
  /** Curve marked complete — ready / migrated */
  complete: boolean;
  /** SOL still needed to hit migration threshold (approx) */
  solToMigration: number;
  /** Progress toward migration by SOL raised */
  solProgressPct: number;
  /** True when progress ≥ nearMigrationCurvePct or complete */
  nearMigration: boolean;
  /** How close: 'far' | 'approaching' | 'near' | 'ready' */
  proximity: 'far' | 'approaching' | 'near' | 'ready' | 'unknown';
  source: 'onchain' | 'api' | 'cache' | 'none';
  fetchedAt: number;
  error?: string;
}

interface CacheEntry {
  state: BondingCurveState;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<BondingCurveState>>();

function cacheTtlMs(): number {
  return config.bondingCurve?.cacheTtlMs ?? 12_000;
}

function migrationThresholdSol(): number {
  return (
    config.bondingCurve?.migrationThresholdSol ??
    DEFAULT_MIGRATION_THRESHOLD_SOL
  );
}

function nearMigrationPct(): number {
  return config.strategy.nearMigrationCurvePct ?? 80;
}

function initialRealTokenReserves(): bigint {
  const n = config.bondingCurve?.initialRealTokenReserves;
  if (n != null && n > 0) return BigInt(Math.floor(n));
  return DEFAULT_INITIAL_REAL_TOKEN_RESERVES;
}

function isValidMint(m: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m);
}

function readU64LE(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset);
}

export function getBondingCurvePda(mint: string): PublicKey {
  const programId = new PublicKey(config.pumpFunProgramId);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
    programId
  );
  return pda;
}

export function getCachedBondingCurve(mint: string): BondingCurveState | null {
  const hit = cache.get(mint);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(mint);
    return null;
  }
  return { ...hit.state, source: 'cache' };
}

export function clearBondingCurveCache(mint?: string): void {
  if (mint) cache.delete(mint);
  else cache.clear();
}

export function getBondingCurveCacheStats() {
  return { size: cache.size, ttlMs: cacheTtlMs() };
}

/** Compact summary for dashboard / activity */
export function summarizeBondingCurve(s: BondingCurveState): {
  progressPct: number;
  solRaised: number;
  tokensInPool: number;
  solToMigration: number;
  nearMigration: boolean;
  proximity: BondingCurveState['proximity'];
  complete: boolean;
  health?: BondingCurveHealthStatus;
  healthDetail?: string;
} {
  const health = assessBondingCurveHealth(s);
  return {
    progressPct: s.progressPct,
    solRaised: s.solRaised,
    tokensInPool: s.tokensInPool,
    solToMigration: s.solToMigration,
    nearMigration: s.nearMigration,
    proximity: s.proximity,
    complete: s.complete,
    health: health.status,
    healthDetail: health.detail,
  };
}

export type BondingCurveHealthStatus =
  | 'healthy'
  | 'preferred'
  | 'stalled'
  | 'dead'
  | 'unknown';

export interface BondingCurveHealth {
  status: BondingCurveHealthStatus;
  dead: boolean;
  stalled: boolean;
  preferBoost: boolean;
  detail?: string;
  progressPct: number;
  solRaised: number;
  solToMigration: number;
}

export interface CurveActivityHints {
  volumeH1Usd?: number | null;
  txnsH1?: number | null;
  recentBuyVolumeUsd?: number | null;
}

/**
 * Detect dead / stalled curves and preferred near-migration band.
 * Fast — uses cached curve state + optional Dex activity hints.
 */
export function assessBondingCurveHealth(
  state: BondingCurveState | null | undefined,
  activity?: CurveActivityHints | null
): BondingCurveHealth {
  if (!state || state.source === 'none') {
    return {
      status: 'unknown',
      dead: false,
      stalled: false,
      preferBoost: false,
      detail: 'no curve data',
      progressPct: 0,
      solRaised: 0,
      solToMigration: migrationThresholdSol(),
    };
  }

  const bc = config.bondingCurve;
  const deadMax = HARD_FILTER_FLOORS.deadBondingCurveMaxPct;
  const progress = state.progressPct;
  const vol = activity?.volumeH1Usd;
  const txns = activity?.txnsH1;
  const buyVol = activity?.recentBuyVolumeUsd;
  const requireActivity = bc.requireRecentCurveActivity !== false;
  const activityDead =
    requireActivity &&
    ((vol != null && vol < (config.filters.minRecentVolumeUsd ?? 800)) ||
      (txns != null && txns < (config.filters.minRecentActivity ?? 3)) ||
      (buyVol != null && buyVol < (config.filters.minRecentBuyVolumeUsd ?? 500)) ||
      (vol == null && txns == null && buyVol == null && progress <= deadMax && state.solRaised < 2));

  const preferMin = bc.preferNearMigrationMinPct ?? 70;
  const preferMax = bc.preferNearMigrationMaxPct ?? 95;

  if (state.complete) {
    return {
      status: 'healthy',
      dead: false,
      stalled: false,
      preferBoost: false,
      detail: 'curve complete / migrated',
      progressPct: progress,
      solRaised: state.solRaised,
      solToMigration: state.solToMigration,
    };
  }

  if (progress <= deadMax && activityDead) {
    return {
      status: 'dead',
      dead: true,
      stalled: false,
      preferBoost: false,
      detail: `${progress.toFixed(0)}% progress + no recent volume/activity`,
      progressPct: progress,
      solRaised: state.solRaised,
      solToMigration: state.solToMigration,
    };
  }

  // Stalled: mid-curve but activity gone (post-pump death)
  if (
    progress > deadMax &&
    progress < preferMin &&
    requireActivity &&
    ((vol != null && vol < 200) || (txns != null && txns === 0))
  ) {
    return {
      status: 'stalled',
      dead: false,
      stalled: true,
      preferBoost: false,
      detail: `${progress.toFixed(0)}% stalled — abrupt volume drop`,
      progressPct: progress,
      solRaised: state.solRaised,
      solToMigration: state.solToMigration,
    };
  }

  if (progress >= preferMin && progress <= preferMax) {
    return {
      status: activityDead ? 'stalled' : 'preferred',
      dead: false,
      stalled: Boolean(activityDead),
      preferBoost: !activityDead,
      detail: activityDead
        ? `${progress.toFixed(0)}% near-mig but dead activity`
        : `${progress.toFixed(0)}% near migration with activity`,
      progressPct: progress,
      solRaised: state.solRaised,
      solToMigration: state.solToMigration,
    };
  }

  return {
    status: 'healthy',
    dead: false,
    stalled: false,
    preferBoost: false,
    detail: `${progress.toFixed(0)}% · ${state.solRaised.toFixed(1)} SOL raised · ${state.solToMigration.toFixed(1)} to mig`,
    progressPct: progress,
    solRaised: state.solRaised,
    solToMigration: state.solToMigration,
  };
}

function emptyState(mint: string, error?: string): BondingCurveState {
  return {
    mint,
    bondingCurve: '',
    progressPct: 0,
    solRaised: 0,
    tokensInPool: 0,
    realTokenReserves: 0,
    virtualTokenReserves: 0,
    virtualSolReserves: 0,
    realSolReserves: 0,
    tokenTotalSupply: 0,
    complete: false,
    solToMigration: migrationThresholdSol(),
    solProgressPct: 0,
    nearMigration: false,
    proximity: 'unknown',
    source: 'none',
    fetchedAt: Date.now(),
    error,
  };
}

function computeProximity(
  progressPct: number,
  complete: boolean
): BondingCurveState['proximity'] {
  if (complete || progressPct >= 99) return 'ready';
  const near = nearMigrationPct();
  if (progressPct >= near) return 'near';
  if (progressPct >= near * 0.7) return 'approaching';
  return 'far';
}

function buildStateFromReserves(input: {
  mint: string;
  bondingCurve: string;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  source: BondingCurveState['source'];
}): BondingCurveState {
  const initialTokens = initialRealTokenReserves();
  const sold =
    initialTokens > input.realTokenReserves
      ? initialTokens - input.realTokenReserves
      : 0n;
  const tokenProgress =
    initialTokens > 0n
      ? Number((sold * 10000n) / initialTokens) / 100
      : 0;

  const solRaised = Number(input.realSolReserves) / 1e9;
  const threshold = migrationThresholdSol();
  const solProgress = Math.min(100, (solRaised / threshold) * 100);
  // Prefer token-sold progress; blend with SOL when token calc looks off
  let progressPct = tokenProgress;
  if (tokenProgress <= 0 && solRaised > 0) {
    progressPct = solProgress;
  } else if (Math.abs(tokenProgress - solProgress) > 40 && solRaised > 1) {
    // If accounts disagree wildly, average (API/on-chain drift)
    progressPct = (tokenProgress + solProgress) / 2;
  }
  if (input.complete) progressPct = 100;
  progressPct = Math.min(100, Math.max(0, Math.round(progressPct * 10) / 10));

  const solToMigration = Math.max(0, threshold - solRaised);
  const proximity = computeProximity(progressPct, input.complete);
  const near =
    input.complete ||
    progressPct >= nearMigrationPct() ||
    proximity === 'near' ||
    proximity === 'ready';

  // UI tokens (assume 6 decimals — Pump.fun standard)
  const tokensInPool = Number(input.realTokenReserves) / 1e6;

  return {
    mint: input.mint,
    bondingCurve: input.bondingCurve,
    progressPct,
    solRaised: Math.round(solRaised * 1000) / 1000,
    tokensInPool,
    realTokenReserves: Number(input.realTokenReserves),
    virtualTokenReserves: Number(input.virtualTokenReserves),
    virtualSolReserves: Number(input.virtualSolReserves),
    realSolReserves: Number(input.realSolReserves),
    tokenTotalSupply: Number(input.tokenTotalSupply),
    complete: input.complete,
    solToMigration: Math.round(solToMigration * 1000) / 1000,
    solProgressPct: Math.round(solProgress * 10) / 10,
    nearMigration: near,
    proximity,
    source: input.source,
    fetchedAt: Date.now(),
  };
}

/**
 * Fetch / calculate bonding curve state for a mint.
 * Cached + inflight-deduped for speed in the monitor hot path.
 */
export async function fetchBondingCurve(
  mint: string,
  options: { force?: boolean } = {}
): Promise<BondingCurveState> {
  if (!isValidMint(mint)) {
    return emptyState(mint, 'Invalid mint');
  }

  if (!options.force) {
    const cached = getCachedBondingCurve(mint);
    if (cached) return cached;
    const pending = inflight.get(mint);
    if (pending) return pending;
  }

  const job = (async () => {
    try {
      let state = await fetchBondingCurveOnChain(mint);
      if (state.source === 'none' || state.error) {
        const api = await fetchBondingCurveFromApi(mint).catch(() => null);
        if (api) state = api;
      }
      cache.set(mint, {
        state,
        expiresAt: Date.now() + cacheTtlMs(),
      });
      return state;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const fail = emptyState(mint, message);
      cache.set(mint, {
        state: fail,
        expiresAt: Date.now() + Math.min(cacheTtlMs(), 8_000),
      });
      return fail;
    } finally {
      inflight.delete(mint);
    }
  })();

  inflight.set(mint, job);
  return job;
}

async function fetchBondingCurveOnChain(
  mint: string
): Promise<BondingCurveState> {
  const conn = getConnection();
  const pda = getBondingCurvePda(mint);
  const info = await conn.getAccountInfo(pda, 'confirmed');
  if (!info?.data || info.data.length < 49) {
    return emptyState(mint, 'No bonding curve account');
  }

  const data = Buffer.from(info.data);
  // Layout after 8-byte Anchor discriminator:
  // virtualToken, virtualSol, realToken, realSol, tokenTotalSupply (u64 each), complete (bool)
  const virtualTokenReserves = readU64LE(data, 8);
  const virtualSolReserves = readU64LE(data, 16);
  const realTokenReserves = readU64LE(data, 24);
  const realSolReserves = readU64LE(data, 32);
  const tokenTotalSupply = readU64LE(data, 40);
  const complete = data[48] === 1;

  return buildStateFromReserves({
    mint,
    bondingCurve: pda.toBase58(),
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete,
    source: 'onchain',
  });
}

/** Fallback: pump.fun frontend API (when RPC account missing / rate limited) */
async function fetchBondingCurveFromApi(
  mint: string
): Promise<BondingCurveState | null> {
  const urls = [
    `https://frontend-api.pump.fun/coins/${mint}`,
    `https://frontend-api-v3.pump.fun/coins/${mint}`,
  ];

  for (const url of urls) {
    try {
      const res = await loggedFetch(url, {
        context: 'Pump',
        label: 'bonding-curve api',
        timeoutMs: 6_000,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        logger.warn('Pump', 'bonding-curve api HTTP', {
          status: res.status,
          url: url.slice(0, 100),
        });
        continue;
      }
      const row = (await res.json()) as Record<string, unknown>;
      const realSol = BigInt(
        Math.floor(Number(row.real_sol_reserves ?? row.realSolReserves ?? 0))
      );
      const realToken = BigInt(
        Math.floor(
          Number(row.real_token_reserves ?? row.realTokenReserves ?? 0)
        )
      );
      const virtualSol = BigInt(
        Math.floor(
          Number(row.virtual_sol_reserves ?? row.virtualSolReserves ?? 0)
        )
      );
      const virtualToken = BigInt(
        Math.floor(
          Number(row.virtual_token_reserves ?? row.virtualTokenReserves ?? 0)
        )
      );
      const supply = BigInt(
        Math.floor(Number(row.total_supply ?? row.token_total_supply ?? 0))
      );
      const complete = Boolean(row.complete);

      // Some APIs expose progress 0–1 or 0–100
      const apiProgress = Number(row.progress ?? row.bonding_curve_progress);
      const state = buildStateFromReserves({
        mint,
        bondingCurve: String(row.bonding_curve ?? row.bondingCurve ?? ''),
        virtualTokenReserves: virtualToken,
        virtualSolReserves: virtualSol,
        realTokenReserves: realToken,
        realSolReserves: realSol,
        tokenTotalSupply: supply,
        complete,
        source: 'api',
      });

      if (Number.isFinite(apiProgress) && apiProgress > 0) {
        const pct = apiProgress <= 1 ? apiProgress * 100 : apiProgress;
        state.progressPct = Math.min(100, Math.round(pct * 10) / 10);
        state.proximity = computeProximity(state.progressPct, complete);
        state.nearMigration =
          complete || state.progressPct >= nearMigrationPct();
      }
      return state;
    } catch (err) {
      logger.error('Pump', 'bonding-curve api failed', {
        url: url.slice(0, 100),
        ...errorToMeta(err),
      });
    }
  }
  return null;
}

/**
 * True when smart-money should treat this as near-migration priority.
 */
export function isNearMigrationPriority(
  state: BondingCurveState | null | undefined
): boolean {
  if (!state || state.source === 'none') return false;
  if (config.strategy.enableBondingCurvePriority === false) return false;
  return state.nearMigration;
}

/**
 * Spot price in SOL per whole token from virtual reserves (6dp tokens).
 * Used for paper simulation when Jupiter has no route yet.
 *
 * Reserves may arrive as on-chain raw (lamports / 1e6 base units) or already
 * in UI units from some APIs — detect and avoid double-scaling (which underprices
 * by ~1e9 and blows up paper token amounts / exit PnL).
 */
export function estimateBondingCurvePriceSol(
  state: BondingCurveState | null | undefined
): number | null {
  if (!state || state.source === 'none') return null;
  const vSol = state.virtualSolReserves;
  const vTok = state.virtualTokenReserves;
  if (!(vSol > 0) || !(vTok > 0)) return null;
  // Lamports are typically >= 1e7 (~0.01 SOL); UI SOL on the curve is ~1–120.
  const sol = vSol > 1e6 ? vSol / 1e9 : vSol;
  // Raw token reserves ~1e15; UI tokens ~1e9. Threshold separates the two.
  const tokens = vTok > 1e12 ? vTok / 1e6 : vTok;
  if (!(sol > 0) || !(tokens > 0)) return null;
  const price = sol / tokens;
  return Number.isFinite(price) && price > 0 ? price : null;
}

/** Human log line */
export function formatBondingCurveLog(
  symbol: string,
  state: BondingCurveState
): string {
  return (
    `[curve] ${symbol}: ${state.progressPct.toFixed(1)}% ` +
    `(${state.solRaised.toFixed(2)} SOL raised, ` +
    `${state.solToMigration.toFixed(2)} SOL to migration, ` +
    `tokensInPool≈${state.tokensInPool.toExponential(2)}, ` +
    `${state.proximity}${state.complete ? ', complete' : ''})`
  );
}

export { DEFAULT_MIGRATION_THRESHOLD_SOL, DEFAULT_INITIAL_VIRTUAL_SOL };
