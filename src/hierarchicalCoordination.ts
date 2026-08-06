/**
 * Hierarchical Multi-Agent Coordination (HMC) — Phase 1 Gatekeeper.
 * Additive allow/block before setup classification and lane fight.
 * No TP/SL mutation; hard safety never fails open; Paper / Live Sim / Live share path.
 */

import { config, persistUserSettings } from './config';
import {
  evaluateVolumeIntelligence,
  isVolumeIntelFastProfile,
} from './volumeIntelligence';

export type GatekeeperStrictness = 'low' | 'medium' | 'high';
export type HmcDebugLogging = 'off' | 'normal' | 'verbose';
export type GatekeeperDecision = 'allow' | 'block';
export type GatekeeperSeverity = 'soft' | 'hard';

export interface HierarchicalCoordinationConfig {
  enabled: boolean;
  gatekeeperEnabled: boolean;
  gatekeeperStrictness: GatekeeperStrictness;
  softBlocksEnforced: boolean;
  minVolumeM5Usd: number;
  minVolumeH1Usd: number;
  minLiquidityUsd: number;
  debugLogging: HmcDebugLogging;
  /** Reserved — Phase 2+ */
  classifierEnabled: boolean;
  /** Reserved — Phase 2+ */
  unknownSetupsCanTrade: boolean;
}

/** Strictness-scaled activity floors (medium = baseline). */
export const GATEKEEPER_STRICTNESS_FLOORS: Record<
  GatekeeperStrictness,
  { minVolumeM5Usd: number; minVolumeH1Usd: number; minLiquidityUsd: number }
> = {
  low: { minVolumeM5Usd: 400, minVolumeH1Usd: 1_200, minLiquidityUsd: 5_000 },
  medium: { minVolumeM5Usd: 800, minVolumeH1Usd: 2_500, minLiquidityUsd: 8_000 },
  high: { minVolumeM5Usd: 1_500, minVolumeH1Usd: 5_000, minLiquidityUsd: 12_000 },
};

export const DEFAULT_HIERARCHICAL_COORDINATION: HierarchicalCoordinationConfig =
  {
    enabled: true,
    gatekeeperEnabled: true,
    gatekeeperStrictness: 'medium',
    softBlocksEnforced: true,
    ...GATEKEEPER_STRICTNESS_FLOORS.medium,
    debugLogging: 'normal',
    classifierEnabled: false,
    unknownSetupsCanTrade: true,
  };

export interface GatekeeperResult {
  decision: GatekeeperDecision;
  severity: GatekeeperSeverity;
  reasonCodes: string[];
  plainLanguage: string;
  /** Soft findings present but softBlocksEnforced=false → advisory allow */
  advisory?: boolean;
}

export interface GatekeeperInput {
  mint: string;
  symbol?: string;
  profileHint?: string | null;
  metrics?: {
    liquidityUsd?: number | null;
    volumeM5Usd?: number | null;
    volumeH1Usd?: number | null;
    marketCapUsd?: number | null;
    priceChangeH1Pct?: number | null;
    priceChange24hPct?: number | null;
  } | null;
  antiRug?: {
    ok?: boolean;
    riskLevel?: string;
    riskScore?: number;
    honeypot?: boolean | null;
    skipReasons?: string[];
    flags?: string[];
  } | null;
  /** Already-known open / traded / exhausted signals (no new RPC). */
  alreadyTraded?: boolean;
  hasOpenPosition?: boolean;
  exhausted?: boolean;
  /** Optional candles for volume intel (reuse if present). */
  candles?: unknown[] | null;
}

/** Stub for later setup-classifier phase. */
export type SetupClassStub =
  | 'unknown'
  | 'momentum'
  | 'dip'
  | 'migration'
  | 'slow_quality';

export interface SetupClassifierStubResult {
  setup: SetupClassStub;
  confidence: number;
  note: string;
}

export function classifySetupStub(_input: GatekeeperInput): SetupClassifierStubResult {
  return {
    setup: 'unknown',
    confidence: 0,
    note: 'Classifier deferred — Phase 2+',
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function fin(n: unknown): number | null {
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

function parseStrictness(v: unknown): GatekeeperStrictness {
  return v === 'low' || v === 'high' || v === 'medium' ? v : 'medium';
}

function parseDebug(v: unknown): HmcDebugLogging {
  return v === 'off' || v === 'verbose' || v === 'normal' ? v : 'normal';
}

export function getHierarchicalCoordinationConfig(): HierarchicalCoordinationConfig {
  const raw = (
    config as { hierarchicalCoordination?: Partial<HierarchicalCoordinationConfig> }
  ).hierarchicalCoordination;
  const d = DEFAULT_HIERARCHICAL_COORDINATION;
  const strictness = parseStrictness(
    raw?.gatekeeperStrictness ?? d.gatekeeperStrictness
  );
  const floors = GATEKEEPER_STRICTNESS_FLOORS[strictness];
  return {
    enabled: raw?.enabled !== false,
    gatekeeperEnabled: raw?.gatekeeperEnabled !== false,
    gatekeeperStrictness: strictness,
    softBlocksEnforced: raw?.softBlocksEnforced !== false,
    minVolumeM5Usd: clamp(
      Number(raw?.minVolumeM5Usd) || floors.minVolumeM5Usd,
      0,
      500_000
    ),
    minVolumeH1Usd: clamp(
      Number(raw?.minVolumeH1Usd) || floors.minVolumeH1Usd,
      0,
      2_000_000
    ),
    minLiquidityUsd: clamp(
      Number(raw?.minLiquidityUsd) || floors.minLiquidityUsd,
      0,
      5_000_000
    ),
    debugLogging: parseDebug(raw?.debugLogging ?? d.debugLogging),
    classifierEnabled: raw?.classifierEnabled === true,
    unknownSetupsCanTrade: raw?.unknownSetupsCanTrade !== false,
  };
}

export function setHierarchicalCoordinationConfig(
  patch: Partial<HierarchicalCoordinationConfig>
): HierarchicalCoordinationConfig {
  const cur = getHierarchicalCoordinationConfig();
  const nextStrictness = parseStrictness(
    patch.gatekeeperStrictness ?? cur.gatekeeperStrictness
  );
  const floors = GATEKEEPER_STRICTNESS_FLOORS[nextStrictness];
  const strictnessChanged =
    patch.gatekeeperStrictness != null &&
    parseStrictness(patch.gatekeeperStrictness) !== cur.gatekeeperStrictness;

  const next: HierarchicalCoordinationConfig = {
    enabled:
      typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
    gatekeeperEnabled:
      typeof patch.gatekeeperEnabled === 'boolean'
        ? patch.gatekeeperEnabled
        : cur.gatekeeperEnabled,
    gatekeeperStrictness: nextStrictness,
    softBlocksEnforced:
      typeof patch.softBlocksEnforced === 'boolean'
        ? patch.softBlocksEnforced
        : cur.softBlocksEnforced,
    minVolumeM5Usd:
      patch.minVolumeM5Usd != null && Number.isFinite(Number(patch.minVolumeM5Usd))
        ? clamp(Number(patch.minVolumeM5Usd), 0, 500_000)
        : strictnessChanged
          ? floors.minVolumeM5Usd
          : cur.minVolumeM5Usd,
    minVolumeH1Usd:
      patch.minVolumeH1Usd != null && Number.isFinite(Number(patch.minVolumeH1Usd))
        ? clamp(Number(patch.minVolumeH1Usd), 0, 2_000_000)
        : strictnessChanged
          ? floors.minVolumeH1Usd
          : cur.minVolumeH1Usd,
    minLiquidityUsd:
      patch.minLiquidityUsd != null &&
      Number.isFinite(Number(patch.minLiquidityUsd))
        ? clamp(Number(patch.minLiquidityUsd), 0, 5_000_000)
        : strictnessChanged
          ? floors.minLiquidityUsd
          : cur.minLiquidityUsd,
    debugLogging: parseDebug(patch.debugLogging ?? cur.debugLogging),
    classifierEnabled:
      typeof patch.classifierEnabled === 'boolean'
        ? patch.classifierEnabled
        : cur.classifierEnabled,
    unknownSetupsCanTrade:
      typeof patch.unknownSetupsCanTrade === 'boolean'
        ? patch.unknownSetupsCanTrade
        : cur.unknownSetupsCanTrade,
  };
  (
    config as {
      hierarchicalCoordination: HierarchicalCoordinationConfig;
    }
  ).hierarchicalCoordination = next;
  try {
    persistUserSettings();
  } catch {
    /* */
  }
  return getHierarchicalCoordinationConfig();
}

export function isGatekeeperActive(): boolean {
  const cfg = getHierarchicalCoordinationConfig();
  return cfg.enabled && cfg.gatekeeperEnabled;
}

/** Brief mint-keyed cache (5–15s TTL). */
const CACHE_TTL_MS = 10_000;
const resultCache = new Map<
  string,
  { at: number; result: GatekeeperResult; key: string }
>();

function cacheKey(input: GatekeeperInput, cfg: HierarchicalCoordinationConfig): string {
  const m = input.metrics || {};
  const ar = input.antiRug || {};
  return [
    input.mint,
    cfg.gatekeeperStrictness,
    cfg.softBlocksEnforced ? '1' : '0',
    cfg.minVolumeM5Usd,
    cfg.minVolumeH1Usd,
    cfg.minLiquidityUsd,
    input.profileHint || '',
    fin(m.volumeM5Usd),
    fin(m.volumeH1Usd),
    fin(m.liquidityUsd),
    fin(m.marketCapUsd),
    ar.ok === false ? '0' : '1',
    ar.honeypot === true ? '1' : '0',
    String(ar.riskLevel || ''),
    input.alreadyTraded ? '1' : '0',
    input.hasOpenPosition ? '1' : '0',
    input.exhausted ? '1' : '0',
  ].join('|');
}

function getCached(
  mint: string,
  key: string
): GatekeeperResult | null {
  const hit = resultCache.get(mint);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    resultCache.delete(mint);
    return null;
  }
  if (hit.key !== key) return null;
  return hit.result;
}

function setCached(mint: string, key: string, result: GatekeeperResult): void {
  resultCache.set(mint, { at: Date.now(), key, result });
  if (resultCache.size > 400) {
    const now = Date.now();
    for (const [k, v] of resultCache) {
      if (now - v.at > CACHE_TTL_MS) resultCache.delete(k);
    }
  }
}

/** Clear gatekeeper cache (tests / config change). */
export function clearGatekeeperCache(): void {
  resultCache.clear();
}

function recoveryStrictFloorMult(profileHint?: string | null): number {
  try {
    const {
      getRecoveryConstraints,
      isFastProfileRecovering,
      getProfileRecoveryStage,
    } = require('./fastProfileRecovery') as typeof import('./fastProfileRecovery');
    const hint = String(profileHint || '');
    if (hint) {
      const rc = getRecoveryConstraints(hint);
      if (rc.active && rc.stage <= 1) return 1.35;
      return 1;
    }
    // No hint: if only Stage 0–1 recovering fast profiles would compete → stricter
    const fastIds = [
      'scalper',
      'reversal_scalper',
      'momentum_burst',
      'migration_sniper',
    ];
    let recoveringEarly = 0;
    let recoveringAny = 0;
    for (const id of fastIds) {
      if (!isFastProfileRecovering(id)) continue;
      recoveringAny += 1;
      if (getProfileRecoveryStage(id) <= 1) recoveringEarly += 1;
    }
    if (recoveringAny > 0 && recoveringEarly === recoveringAny) return 1.25;
  } catch {
    /* optional */
  }
  return 1;
}

function profileActivityMult(profileHint?: string | null): number {
  const id = String(profileHint || '');
  if (isVolumeIntelFastProfile(id)) return 1.2;
  if (
    id === 'trend_rider' ||
    id === 'steady_compounder' ||
    id === 'high_win_rate' ||
    id === 'smart_money_mirror'
  ) {
    return 0.85;
  }
  return 1;
}

function plainFromCodes(
  decision: GatekeeperDecision,
  codes: string[],
  advisory: boolean
): string {
  const map: Record<string, string> = {
    SAFETY_HONEYPOT: 'honeypot flag',
    SAFETY_ANTI_RUG: 'anti-rug fail',
    SAFETY_HIGH_RISK: 'severe safety risk',
    ACTIVITY_LOW_VOLUME_M5: 'thin 5m volume',
    ACTIVITY_LOW_VOLUME_H1: 'thin 1h volume',
    ACTIVITY_LOW_LIQUIDITY: 'low liquidity',
    ACTIVITY_VOLUME_COLLAPSED: 'collapsed volume',
    EXECUTION_ILLIQUID: 'illiquid / not tradable',
    COORD_LOW_MC_CONGESTION: 'low-MC congestion',
    FRESHNESS_ALREADY_TRADED: 'already traded',
    FRESHNESS_OPEN_POSITION: 'open position',
    FRESHNESS_EXHAUSTED: 'exhausted setup',
  };
  const bits = codes.map((c) => map[c] || c.toLowerCase().replace(/_/g, ' '));
  if (decision === 'allow') {
    if (advisory && bits.length) {
      return `Gatekeeper ALLOW (advisory): ${bits.join(', ')}`;
    }
    return bits.length
      ? `Gatekeeper ALLOW: ${bits.join(', ')}`
      : 'Gatekeeper ALLOW: volume and safety passed';
  }
  return `Gatekeeper BLOCK: ${bits.join(', ') || 'gate failed'}`;
}

/**
 * Evaluate Gatekeeper. Hard safety never fails open.
 * Soft blocks become advisory ALLOW when softBlocksEnforced=false.
 */
export function evaluateGatekeeper(input: GatekeeperInput): GatekeeperResult {
  const cfg = getHierarchicalCoordinationConfig();
  if (!cfg.enabled || !cfg.gatekeeperEnabled) {
    return {
      decision: 'allow',
      severity: 'soft',
      reasonCodes: [],
      plainLanguage: 'Gatekeeper off',
    };
  }

  const mint = String(input.mint || '').trim();
  if (!mint) {
    return {
      decision: 'block',
      severity: 'hard',
      reasonCodes: ['SAFETY_ANTI_RUG'],
      plainLanguage: 'Gatekeeper BLOCK: missing mint',
    };
  }

  const key = cacheKey(input, cfg);
  const cached = getCached(mint, key);
  if (cached) return cached;

  const hardCodes: string[] = [];
  const softCodes: string[] = [];

  // —— Safety (hard; never fail open when known bad) ——
  const ar = input.antiRug;
  if (ar) {
    if (ar.honeypot === true) hardCodes.push('SAFETY_HONEYPOT');
    if (ar.ok === false) hardCodes.push('SAFETY_ANTI_RUG');
    const lvl = String(ar.riskLevel || '').toLowerCase();
    const score = Number(ar.riskScore);
    if (
      lvl === 'critical' ||
      lvl === 'extreme' ||
      lvl === 'high' ||
      (Number.isFinite(score) && score >= 75)
    ) {
      if (!hardCodes.includes('SAFETY_HIGH_RISK') && !hardCodes.includes('SAFETY_ANTI_RUG')) {
        hardCodes.push('SAFETY_HIGH_RISK');
      }
    }
    if (Array.isArray(ar.skipReasons) && ar.skipReasons.length && ar.ok === false) {
      if (!hardCodes.includes('SAFETY_ANTI_RUG')) hardCodes.push('SAFETY_ANTI_RUG');
    }
  }

  // —— Freshness ——
  if (input.hasOpenPosition) softCodes.push('FRESHNESS_OPEN_POSITION');
  if (input.alreadyTraded) softCodes.push('FRESHNESS_ALREADY_TRADED');
  if (input.exhausted) softCodes.push('FRESHNESS_EXHAUSTED');

  // —— Activity floors (strictness + profile + recovery) ——
  const actMult =
    profileActivityMult(input.profileHint) *
    recoveryStrictFloorMult(input.profileHint);
  const minM5 = cfg.minVolumeM5Usd * actMult;
  const minH1 = cfg.minVolumeH1Usd * actMult;
  const minLiq = cfg.minLiquidityUsd * Math.min(actMult, 1.15);

  const volM5 = fin(input.metrics?.volumeM5Usd);
  const volH1 = fin(input.metrics?.volumeH1Usd);
  const liq = fin(input.metrics?.liquidityUsd);
  const mc = fin(input.metrics?.marketCapUsd);

  if (volM5 != null && volM5 > 0 && volM5 < minM5) {
    softCodes.push('ACTIVITY_LOW_VOLUME_M5');
  } else if (volM5 == null && cfg.gatekeeperStrictness === 'high') {
    softCodes.push('ACTIVITY_LOW_VOLUME_M5');
  }

  if (volH1 != null && volH1 > 0 && volH1 < minH1) {
    softCodes.push('ACTIVITY_LOW_VOLUME_H1');
  } else if (volH1 == null && cfg.gatekeeperStrictness === 'high') {
    softCodes.push('ACTIVITY_LOW_VOLUME_H1');
  }

  if (liq != null && liq > 0 && liq < minLiq) {
    softCodes.push('ACTIVITY_LOW_LIQUIDITY');
  } else if (liq == null && cfg.gatekeeperStrictness === 'high') {
    softCodes.push('ACTIVITY_LOW_LIQUIDITY');
  }

  // Volume intelligence collapse (reuse; no new RPC)
  try {
    const snap = evaluateVolumeIntelligence({
      volumeM5Usd: volM5,
      volumeH1Usd: volH1,
      priceChangePct:
        input.metrics?.priceChangeH1Pct ??
        input.metrics?.priceChange24hPct ??
        null,
      profileId: input.profileHint || null,
      candles: (input.candles as import('./profileTaIndicators').ProfileTaCandle[]) || null,
    });
    if (snap.decayState === 'collapsed' || snap.hardFloorFailFast) {
      softCodes.push('ACTIVITY_VOLUME_COLLAPSED');
    }
  } catch {
    /* fail soft on VI gaps */
  }

  // —— Execution: obvious illiquid junk when known ——
  if (
    (liq != null && liq > 0 && liq < 1_500 && cfg.gatekeeperStrictness !== 'low') ||
    (volM5 != null &&
      volM5 > 0 &&
      volM5 < 100 &&
      volH1 != null &&
      volH1 > 0 &&
      volH1 < 300)
  ) {
    softCodes.push('EXECUTION_ILLIQUID');
  }

  // —— Coordination: low-MC congestion (MARL helpers; mint-level) ——
  try {
    const { getMarlConfig } =
      require('./marlCoordinator') as typeof import('./marlCoordinator');
    const { getRecentLowMcOpens } =
      require('./marlStore') as typeof import('./marlStore');
    const marl = getMarlConfig();
    if (marl.enabled && mc != null && mc > 0 && mc < marl.lowMcUsd) {
      const recent = getRecentLowMcOpens(
        mint,
        marl.lowMcWindowMin * 60_000
      );
      if (recent.length >= marl.maxAgentsPerLowMc) {
        softCodes.push('COORD_LOW_MC_CONGESTION');
      }
    }
  } catch {
    /* optional */
  }

  let result: GatekeeperResult;
  if (hardCodes.length) {
    const reasonCodes = [...hardCodes, ...softCodes];
    result = {
      decision: 'block',
      severity: 'hard',
      reasonCodes,
      plainLanguage: plainFromCodes('block', hardCodes, false),
    };
  } else if (softCodes.length) {
    if (cfg.softBlocksEnforced) {
      result = {
        decision: 'block',
        severity: 'soft',
        reasonCodes: softCodes,
        plainLanguage: plainFromCodes('block', softCodes, false),
      };
    } else {
      result = {
        decision: 'allow',
        severity: 'soft',
        reasonCodes: softCodes,
        plainLanguage: plainFromCodes('allow', softCodes, true),
        advisory: true,
      };
    }
  } else {
    result = {
      decision: 'allow',
      severity: 'soft',
      reasonCodes: [],
      plainLanguage: plainFromCodes('allow', [], false),
    };
  }

  setCached(mint, key, result);

  if (cfg.debugLogging === 'verbose') {
    console.log(
      `[hmc_gatekeeper] ${input.symbol || mint.slice(0, 8)}… ` +
        `${result.decision}/${result.severity} ` +
        `codes=${result.reasonCodes.join(',') || 'none'} · ${result.plainLanguage}`
    );
  } else if (
    cfg.debugLogging === 'normal' &&
    (result.decision === 'block' || result.advisory)
  ) {
    console.log(
      `[hmc_gatekeeper] ${input.symbol || mint.slice(0, 8)}… ${result.plainLanguage}`
    );
  }

  return result;
}

/** Log Gatekeeper ALLOW/BLOCK to Agent Decision Log. */
export function recordGatekeeperDecision(input: {
  result: GatekeeperResult;
  mint: string;
  symbol?: string;
  profileHint?: string | null;
}): void {
  try {
    const { recordAgentDecision } =
      require('./agentDecisionLog') as typeof import('./agentDecisionLog');
    const r = input.result;
    const allow = r.decision === 'allow';
    recordAgentDecision({
      agent: 'HMC Gatekeeper',
      source: 'hmc_gatekeeper',
      decisionType: allow ? (r.advisory ? 'hint' : 'recommendation') : 'warning',
      profileId: input.profileHint || undefined,
      target: 'Entry gate',
      summary: r.plainLanguage,
      detail:
        r.reasonCodes.length > 0
          ? `codes=${r.reasonCodes.join(',')}`
          : allow
            ? 'passed'
            : 'blocked',
      applied: allow
        ? r.advisory
          ? 'observation_only'
          : 'observation_only'
        : 'applied',
      mint: input.mint,
      symbol: input.symbol,
      dedupeKey: `hmc_gk:${input.mint}:${allow ? 'allow' : 'block'}:${r.reasonCodes.slice(0, 3).join('+')}`,
    });
  } catch {
    /* fail-open logging */
  }
}
