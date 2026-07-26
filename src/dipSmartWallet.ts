/**
 * Dip-phase Smart Wallet scoring for Post-Run Dip / Rotation.
 *
 * Detects and scores behaviour specifically during the dip:
 *  - New buys from high-quality wallets
 *  - Previous sellers / earlier buyers buying back
 *  - Clustering of quality wallets near Fib/support
 *  - Net smart-money flow direction
 *
 * Fail-open when wallet history / Birdeye is thin.
 * Does not replace wallet quality gates or convergence — confirmation only
 * (unless Post-Run Dip requireSmartMoney / Conservative hard-require is on).
 */

import { config } from './config';
import { applyQualityToWallet } from './walletQuality';
import { effectiveMinWalletQualityScore } from './filterEffective';

export type DipSmartWalletSensitivity = 'low' | 'medium' | 'high';

export interface DipWalletRef {
  address: string;
  name?: string;
  qualityScore?: number | null;
}

export interface DipPriorBuy {
  wallet: string;
  timestamp: number;
}

export interface DipSmartWalletInput {
  wallets?: unknown[] | null;
  walletNames?: string[] | null;
  mint?: string | null;
  nearSupportOrFib?: boolean;
  birdeyeSmartMoneyScore?: number | null;
  buySellRatio?: number | null;
  recentBuyVolumeUsd?: number | null;
  volumeH1Usd?: number | null;
  /** Older buys on this mint (for buyback / re-entry detection) */
  priorBuys?: DipPriorBuy[] | null;
  nowMs?: number;
  sensitivity?: DipSmartWalletSensitivity;
  /** Override HQ floor (else from sensitivity / wallet quality gate) */
  hqMinQuality?: number;
}

export interface DipSmartWalletReport {
  score: number;
  /** Meaningful dip-phase SM activity */
  active: boolean;
  /** High-conviction confirmation */
  strong: boolean;
  hqNewBuys: number;
  buybacks: number;
  clusterNearLevel: boolean;
  clusterSize: number;
  netFlow: 'in' | 'out' | 'neutral' | 'unknown';
  netFlowScore: number;
  avgQuality: number | null;
  reasons: string[];
  detail: string;
  sensitivity: DipSmartWalletSensitivity;
}

type BuyHistoryFn = (mint: string) => DipPriorBuy[];

let buyHistoryProvider: BuyHistoryFn | null = null;

/** Monitor registers live buy history without circular imports. */
export function registerDipBuyHistoryProvider(fn: BuyHistoryFn | null): void {
  buyHistoryProvider = fn;
}

export function getDipBuyHistory(mint: string): DipPriorBuy[] {
  if (!mint || !buyHistoryProvider) return [];
  try {
    return buyHistoryProvider(mint) ?? [];
  } catch {
    return [];
  }
}

function sensDefaults(level: DipSmartWalletSensitivity): {
  hqMin: number;
  activeGate: number;
  strongGate: number;
  clusterMin: number;
  buybackWindowMs: number;
} {
  if (level === 'low') {
    return {
      hqMin: 50,
      activeGate: 32,
      strongGate: 58,
      clusterMin: 2,
      buybackWindowMs: 48 * 3_600_000,
    };
  }
  if (level === 'high') {
    return {
      hqMin: 70,
      activeGate: 52,
      strongGate: 72,
      clusterMin: 2,
      buybackWindowMs: 24 * 3_600_000,
    };
  }
  return {
    hqMin: 60,
    activeGate: 42,
    strongGate: 65,
    clusterMin: 2,
    buybackWindowMs: 36 * 3_600_000,
  };
}

function normalizeWalletToken(w: unknown): string {
  if (typeof w === 'string') return w.trim();
  if (w && typeof w === 'object') {
    const o = w as Record<string, unknown>;
    return String(o.address || o.wallet || o.name || '').trim();
  }
  return '';
}

/** Resolve wallet refs from signal wallets + config.smartWallets quality. */
export function resolveDipWalletRefs(
  wallets: unknown[] | null | undefined,
  walletNames?: string[] | null
): DipWalletRef[] {
  const raw = Array.isArray(wallets) ? wallets : [];
  const names = Array.isArray(walletNames) ? walletNames : [];
  const out: DipWalletRef[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < raw.length; i++) {
    const token = normalizeWalletToken(raw[i]);
    if (!token) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    let address = token;
    let name = names[i] || undefined;
    let qualityScore: number | null | undefined;

    if (raw[i] && typeof raw[i] === 'object') {
      const o = raw[i] as Record<string, unknown>;
      if (o.qualityScore != null && Number.isFinite(Number(o.qualityScore))) {
        qualityScore = Number(o.qualityScore);
      }
      if (typeof o.name === 'string') name = o.name;
      if (typeof o.address === 'string') address = o.address;
    }

    const byAddr = config.smartWallets.find(
      (sw) => sw.address.toLowerCase() === address.toLowerCase()
    );
    const byName = !byAddr
      ? config.smartWallets.find(
          (sw) =>
            sw.name.toLowerCase() === token.toLowerCase() ||
            (name != null && sw.name.toLowerCase() === name.toLowerCase())
        )
      : undefined;
    const sw = byAddr || byName;
    if (sw) {
      address = sw.address;
      name = sw.name;
      if (qualityScore == null) {
        if (sw.qualityScore == null) applyQualityToWallet(sw);
        qualityScore = sw.qualityScore ?? null;
      }
    }

    out.push({ address, name, qualityScore: qualityScore ?? null });
  }
  return out;
}

function scoreNetFlow(input: DipSmartWalletInput): {
  netFlow: DipSmartWalletReport['netFlow'];
  netFlowScore: number;
  reason?: string;
} {
  const sm = Number(input.birdeyeSmartMoneyScore);
  const ratio = Number(input.buySellRatio);
  const buyVol = Number(input.recentBuyVolumeUsd);
  const volH1 = Number(input.volumeH1Usd);

  let netFlowScore = 0;
  let known = false;

  if (Number.isFinite(sm) && sm > 0) {
    known = true;
    if (sm >= 70) netFlowScore += 8;
    else if (sm >= 55) netFlowScore += 5;
    else if (sm >= 40) netFlowScore += 2;
    else if (sm < 25) netFlowScore -= 4;
  }
  if (Number.isFinite(ratio) && ratio > 0) {
    known = true;
    if (ratio >= 1.4) netFlowScore += 4;
    else if (ratio >= 1.1) netFlowScore += 2;
    else if (ratio < 0.85) netFlowScore -= 3;
  }
  if (
    Number.isFinite(buyVol) &&
    buyVol > 0 &&
    Number.isFinite(volH1) &&
    volH1 > 0
  ) {
    known = true;
    const share = buyVol / volH1;
    if (share >= 0.55) netFlowScore += 2;
    else if (share < 0.3) netFlowScore -= 2;
  }

  netFlowScore = Math.max(-10, Math.min(10, netFlowScore));
  if (!known) return { netFlow: 'unknown', netFlowScore: 0 };
  if (netFlowScore >= 3) {
    return {
      netFlow: 'in',
      netFlowScore,
      reason: `net SM flow in (${netFlowScore > 0 ? '+' : ''}${netFlowScore})`,
    };
  }
  if (netFlowScore <= -3) {
    return {
      netFlow: 'out',
      netFlowScore,
      reason: `net SM flow out (${netFlowScore})`,
    };
  }
  return {
    netFlow: 'neutral',
    netFlowScore,
    reason: `net SM flow neutral (${netFlowScore})`,
  };
}

/**
 * Score smart-wallet behaviour on a Post-Run Dip setup.
 * Fail-open: empty wallets + no Birdeye → score 0, active=false.
 */
export function scoreDipSmartWalletActivity(
  input: DipSmartWalletInput
): DipSmartWalletReport {
  const sensitivity: DipSmartWalletSensitivity =
    input.sensitivity === 'low' || input.sensitivity === 'high'
      ? input.sensitivity
      : 'medium';
  const d = sensDefaults(sensitivity);
  const gateFloor = effectiveMinWalletQualityScore();
  const hqMin =
    Number.isFinite(input.hqMinQuality as number) &&
    (input.hqMinQuality as number) > 0
      ? Math.max(40, Number(input.hqMinQuality))
      : Math.max(d.hqMin, Math.min(gateFloor, d.hqMin + 5));

  const refs = resolveDipWalletRefs(input.wallets, input.walletNames);
  const nowMs = input.nowMs ?? Date.now();
  const reasons: string[] = [];

  const qualities = refs
    .map((r) => Number(r.qualityScore))
    .filter((n) => Number.isFinite(n) && n > 0);
  const avgQuality =
    qualities.length > 0
      ? Math.round(qualities.reduce((a, b) => a + b, 0) / qualities.length)
      : null;

  const hqRefs = refs.filter((r) => (Number(r.qualityScore) || 0) >= hqMin);
  const hqNewBuys = hqRefs.length;
  if (hqNewBuys > 0) {
    reasons.push(
      `${hqNewBuys} HQ wallet buy${hqNewBuys > 1 ? 's' : ''} (q≥${hqMin})`
    );
  }

  const prior =
    (Array.isArray(input.priorBuys) && input.priorBuys.length
      ? input.priorBuys
      : input.mint
        ? getDipBuyHistory(input.mint)
        : []) || [];

  const currentAddrs = new Set(refs.map((r) => r.address.toLowerCase()));
  let buybacks = 0;
  for (const addr of currentAddrs) {
    const older = prior.some(
      (p) =>
        p.wallet.toLowerCase() === addr &&
        p.timestamp < nowMs - 5 * 60_000 &&
        nowMs - p.timestamp <= d.buybackWindowMs
    );
    if (older) buybacks += 1;
  }
  if (buybacks > 0) {
    reasons.push(
      `${buybacks} prior seller/buyer buyback${buybacks > 1 ? 's' : ''}`
    );
  }

  const clusterSize = Math.max(refs.length, hqNewBuys);
  const clusterNearLevel =
    input.nearSupportOrFib === true &&
    hqNewBuys >= d.clusterMin &&
    clusterSize >= d.clusterMin;
  if (clusterNearLevel) {
    reasons.push(
      `HQ cluster×${hqNewBuys} near Fib/support`
    );
  } else if (input.nearSupportOrFib && clusterSize >= d.clusterMin) {
    reasons.push(`wallet cluster×${clusterSize} near level (mixed quality)`);
  }

  const flow = scoreNetFlow(input);
  if (flow.reason) reasons.push(flow.reason);

  let score = 0;
  score += Math.min(36, hqNewBuys * 14);
  score += Math.min(20, buybacks * 12);
  if (clusterNearLevel) score += 18;
  else if (input.nearSupportOrFib && clusterSize >= d.clusterMin) score += 8;
  score += Math.max(-12, Math.min(16, flow.netFlowScore * 1.5));
  if (avgQuality != null) {
    if (avgQuality >= 75) score += 8;
    else if (avgQuality >= 60) score += 4;
  }
  // Soft credit when only Birdeye SM is present (backtester / thin wallet lists)
  if (refs.length === 0 && flow.netFlow === 'in') score += 22;
  else if (refs.length === 0 && Number(input.birdeyeSmartMoneyScore) >= 50) {
    score += 14;
    reasons.push('Birdeye SM proxy (no wallet list)');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const active = score >= d.activeGate;
  const strong = score >= d.strongGate && (hqNewBuys >= 1 || buybacks >= 1 || flow.netFlow === 'in');

  const detail =
    `dipSM[${sensitivity}] score=${score} hq=${hqNewBuys} buybacks=${buybacks} ` +
    `cluster=${clusterSize}${clusterNearLevel ? '@level' : ''} ` +
    `flow=${flow.netFlow}` +
    (avgQuality != null ? ` avgQ=${avgQuality}` : '') +
    (reasons.length ? ` · ${reasons.slice(0, 4).join('; ')}` : '');

  return {
    score,
    active,
    strong,
    hqNewBuys,
    buybacks,
    clusterNearLevel,
    clusterSize,
    netFlow: flow.netFlow,
    netFlowScore: flow.netFlowScore,
    avgQuality,
    reasons,
    detail,
    sensitivity,
  };
}

/** Extra conviction points from dip SM report (0 … boostMax). */
export function dipSmartWalletConvictionBoost(
  report: DipSmartWalletReport,
  boostMax: number
): number {
  const cap = Math.max(0, Math.min(15, Math.round(boostMax)));
  if (cap <= 0 || !report.active) return 0;
  if (report.strong) return cap;
  if (report.clusterNearLevel || report.buybacks > 0) {
    return Math.max(2, Math.round(cap * 0.75));
  }
  return Math.max(1, Math.round(cap * 0.5));
}
