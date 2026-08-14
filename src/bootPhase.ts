/**
 * Post-deploy BootPhase priority (1.2.345).
 * Trading first → scanners → background last. Time stagger alone still overlapped CU.
 */

import { getProcessUptimeMs, noteBootTimeline } from './rpcBootTimeline';

export type BootPhase = 'trading' | 'scanners' | 'background';

export const PHASE_SCANNERS_MS = 90_000;
export const PHASE_BACKGROUND_MS = 180_000;

const PHASE_RANK: Record<BootPhase, number> = {
  trading: 0,
  scanners: 1,
  background: 2,
};

/** Minimum phase required before the feature may hit Solana RPC. */
const FEATURE_MIN_PHASE: Record<string, BootPhase> = {
  // Always (Phase T)
  trade_entry: 'trading',
  zion_place_trade: 'trading',
  live_balance: 'trading',
  send: 'trading',
  priority_fee: 'trading',
  mev: 'trading',
  open_mark: 'trading',
  health_probe: 'trading',
  bonding_curve: 'trading',
  default: 'trading',
  // Migration allowed early but soft-seeded until Phase D (listener handles soft)
  migration: 'trading',
  // Phase D — scanners / data discovery
  market_scanner: 'scanners',
  alpha_scan: 'scanners',
  zion: 'scanners',
  zion_scanner: 'scanners',
  token_metrics: 'scanners',
  anti_rug: 'scanners',
  // Phase B — background / favourites / import CPU
  wallet_poll: 'background',
  wallet_import: 'background',
  activity: 'background',
  favourites: 'background',
  influencer_holdings: 'background',
  zion_wallet_read: 'background',
};

let lastLoggedPhase: BootPhase | null = null;

export function getBootPhase(uptimeMs = getProcessUptimeMs()): BootPhase {
  if (uptimeMs < PHASE_SCANNERS_MS) return 'trading';
  if (uptimeMs < PHASE_BACKGROUND_MS) return 'scanners';
  return 'background';
}

export function getFeatureMinBootPhase(feature: string): BootPhase {
  const key = String(feature || 'default').trim().toLowerCase();
  return FEATURE_MIN_PHASE[key] || FEATURE_MIN_PHASE[feature] || 'trading';
}

export function isBootFeatureAllowed(
  feature: string,
  uptimeMs = getProcessUptimeMs()
): boolean {
  const need = getFeatureMinBootPhase(feature);
  const have = getBootPhase(uptimeMs);
  return PHASE_RANK[have] >= PHASE_RANK[need];
}

export function bootPhaseSkipReason(feature: string): string | null {
  if (isBootFeatureAllowed(feature)) return null;
  const need = getFeatureMinBootPhase(feature);
  const have = getBootPhase();
  return `boot_phase_${have}_blocks_${need}:${feature}`;
}

/** Log phase transitions once (call from health tick / boot-seq). */
export function noteBootPhaseIfChanged(): BootPhase {
  const phase = getBootPhase();
  if (phase !== lastLoggedPhase) {
    lastLoggedPhase = phase;
    noteBootTimeline({
      event: 'boot_phase',
      detail: phase,
    });
    console.log(`[boot-phase] entered ${phase} (uptime=${Math.round(getProcessUptimeMs() / 1000)}s)`);
  }
  return phase;
}

export function getBootPhaseSnapshot(): {
  bootPhase: BootPhase;
  uptimeMs: number;
  phaseScannersAtMs: number;
  phaseBackgroundAtMs: number;
  untilScannersMs: number;
  untilBackgroundMs: number;
} {
  const uptimeMs = getProcessUptimeMs();
  return {
    bootPhase: getBootPhase(uptimeMs),
    uptimeMs,
    phaseScannersAtMs: PHASE_SCANNERS_MS,
    phaseBackgroundAtMs: PHASE_BACKGROUND_MS,
    untilScannersMs: Math.max(0, PHASE_SCANNERS_MS - uptimeMs),
    untilBackgroundMs: Math.max(0, PHASE_BACKGROUND_MS - uptimeMs),
  };
}
