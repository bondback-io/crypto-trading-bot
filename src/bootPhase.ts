/**
 * Post-deploy BootPhase priority (1.2.345+).
 * Trading first → scanners → background last. Per-feature uptime floors
 * unbunch the old 180s cliff (Favourites / GitHub / migration).
 */

import { getProcessUptimeMs, noteBootTimeline } from './rpcBootTimeline';

export type BootPhase = 'trading' | 'scanners' | 'background';

export type BootUiPhase =
  | 'warming_trading'
  | 'starting_scanners'
  | 'background'
  | 'ready';

export const PHASE_SCANNERS_MS = 90_000;
export const PHASE_BACKGROUND_MS = 180_000;
/** Overlay + Trading shed grace until migration start. */
export const PHASE_READY_MS = 210_000;

export const TRADING_GETSLOT_SKIP_MS = 60_000;
export const ZION_SCANNER_MIN_UPTIME_MS = 120_000;
export const FAVOURITES_FIRST_POLL_MS = 150_000;
export const GITHUB_AUTO_IMPORT_MIN_UPTIME_MS = 180_000;
export const MIGRATION_START_MS = 210_000;

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
  // Pump.fun/PumpSwap getSignatures on Trading during boot saturates Alchemy.
  // Phase min stays background; extra uptime floor is 210s.
  migration: 'background',
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

/**
 * Extra wall-clock floors (ms uptime) on top of phase rank.
 * Favourites at 150s is allowed during scanners phase (min phase still background
 * would block until 180s — so wallet_poll/favourites use scanners + 150s floor).
 */
const FEATURE_MIN_UPTIME_MS: Record<string, number> = {
  market_scanner: PHASE_SCANNERS_MS,
  alpha_scan: PHASE_SCANNERS_MS,
  token_metrics: PHASE_SCANNERS_MS,
  anti_rug: PHASE_SCANNERS_MS,
  zion: ZION_SCANNER_MIN_UPTIME_MS,
  zion_scanner: ZION_SCANNER_MIN_UPTIME_MS,
  wallet_poll: FAVOURITES_FIRST_POLL_MS,
  favourites: FAVOURITES_FIRST_POLL_MS,
  activity: PHASE_BACKGROUND_MS,
  wallet_import: PHASE_BACKGROUND_MS,
  influencer_holdings: PHASE_BACKGROUND_MS,
  zion_wallet_read: PHASE_BACKGROUND_MS,
  migration: MIGRATION_START_MS,
};

let lastLoggedPhase: BootPhase | null = null;
let lastLoggedUiPhase: BootUiPhase | null = null;

export function getBootPhase(uptimeMs = getProcessUptimeMs()): BootPhase {
  if (uptimeMs < PHASE_SCANNERS_MS) return 'trading';
  if (uptimeMs < PHASE_BACKGROUND_MS) return 'scanners';
  return 'background';
}

export function getBootUiPhase(uptimeMs = getProcessUptimeMs()): BootUiPhase {
  if (uptimeMs < PHASE_SCANNERS_MS) return 'warming_trading';
  if (uptimeMs < PHASE_BACKGROUND_MS) return 'starting_scanners';
  if (uptimeMs < PHASE_READY_MS) return 'background';
  return 'ready';
}

/** True until fully ready (overlay + Trading shed grace). */
export function isBootSettling(uptimeMs = getProcessUptimeMs()): boolean {
  return uptimeMs < PHASE_READY_MS;
}

export function getFeatureMinBootPhase(feature: string): BootPhase {
  const key = String(feature || 'default').trim().toLowerCase();
  return FEATURE_MIN_PHASE[key] || FEATURE_MIN_PHASE[feature] || 'trading';
}

function getFeatureMinUptimeMs(feature: string): number {
  const key = String(feature || 'default').trim().toLowerCase();
  if (FEATURE_MIN_UPTIME_MS[key] != null) return FEATURE_MIN_UPTIME_MS[key]!;
  if (FEATURE_MIN_UPTIME_MS[feature] != null) return FEATURE_MIN_UPTIME_MS[feature]!;
  return 0;
}

export function isBootFeatureAllowed(
  feature: string,
  uptimeMs = getProcessUptimeMs()
): boolean {
  const key = String(feature || 'default').trim().toLowerCase();
  // Favourites / wallet_poll: scanners phase + 150s floor (unbunch from 180s cliff).
  if (key === 'wallet_poll' || key === 'favourites') {
    return uptimeMs >= FAVOURITES_FIRST_POLL_MS;
  }
  const need = getFeatureMinBootPhase(feature);
  const have = getBootPhase(uptimeMs);
  if (PHASE_RANK[have] < PHASE_RANK[need]) return false;
  return uptimeMs >= getFeatureMinUptimeMs(feature);
}

export function bootPhaseSkipReason(feature: string): string | null {
  if (isBootFeatureAllowed(feature)) return null;
  const need = getFeatureMinBootPhase(feature);
  const have = getBootPhase();
  const minUptime = getFeatureMinUptimeMs(feature);
  const uptimeMs = getProcessUptimeMs();
  if (uptimeMs < minUptime) {
    return `boot_uptime_${Math.round(uptimeMs / 1000)}s_blocks_${Math.round(minUptime / 1000)}s:${feature}`;
  }
  return `boot_phase_${have}_blocks_${need}:${feature}`;
}

function bootProgressPct(uptimeMs: number): number {
  if (uptimeMs >= PHASE_READY_MS) return 100;
  return Math.max(0, Math.min(99, Math.round((uptimeMs / PHASE_READY_MS) * 100)));
}

function untilNextPhaseMs(uptimeMs: number): number {
  if (uptimeMs < PHASE_SCANNERS_MS) return PHASE_SCANNERS_MS - uptimeMs;
  if (uptimeMs < PHASE_BACKGROUND_MS) return PHASE_BACKGROUND_MS - uptimeMs;
  if (uptimeMs < PHASE_READY_MS) return PHASE_READY_MS - uptimeMs;
  return 0;
}

/** Overlay stays visible through Ready, then auto-hides after this grace. */
export const OVERLAY_HIDE_AFTER_READY_MS = 5_000;

export function isBootOverlayVisible(uptimeMs = getProcessUptimeMs()): boolean {
  return uptimeMs < PHASE_READY_MS + OVERLAY_HIDE_AFTER_READY_MS;
}

/** Log phase transitions once (call from health tick / boot-seq). */
export function noteBootPhaseIfChanged(): BootPhase {
  const phase = getBootPhase();
  const ui = getBootUiPhase();
  if (phase !== lastLoggedPhase) {
    lastLoggedPhase = phase;
    noteBootTimeline({
      event: 'boot_phase',
      detail: phase,
    });
    console.log(`[boot-phase] entered ${phase} (uptime=${Math.round(getProcessUptimeMs() / 1000)}s)`);
  }
  if (ui !== lastLoggedUiPhase) {
    lastLoggedUiPhase = ui;
    if (ui === 'ready') {
      noteBootTimeline({ event: 'boot_phase', detail: 'ready' });
      console.log(
        `[boot-phase] entered ready (uptime=${Math.round(getProcessUptimeMs() / 1000)}s)`
      );
    }
  }
  return phase;
}

export function getBootPhaseSnapshot(): {
  bootPhase: BootPhase;
  uiPhase: BootUiPhase;
  uiPhaseLabel: string;
  uptimeMs: number;
  phaseScannersAtMs: number;
  phaseBackgroundAtMs: number;
  phaseReadyAtMs: number;
  untilScannersMs: number;
  untilBackgroundMs: number;
  untilReadyMs: number;
  untilNextPhaseMs: number;
  progressPct: number;
  bootSettling: boolean;
  overlayVisible: boolean;
} {
  const uptimeMs = getProcessUptimeMs();
  const uiPhase = getBootUiPhase(uptimeMs);
  const uiPhaseLabel =
    uiPhase === 'warming_trading'
      ? 'Warming Trading'
      : uiPhase === 'starting_scanners'
        ? 'Starting Scanners'
        : uiPhase === 'background'
          ? 'Background'
          : 'Ready';
  return {
    bootPhase: getBootPhase(uptimeMs),
    uiPhase,
    uiPhaseLabel,
    uptimeMs,
    phaseScannersAtMs: PHASE_SCANNERS_MS,
    phaseBackgroundAtMs: PHASE_BACKGROUND_MS,
    phaseReadyAtMs: PHASE_READY_MS,
    untilScannersMs: Math.max(0, PHASE_SCANNERS_MS - uptimeMs),
    untilBackgroundMs: Math.max(0, PHASE_BACKGROUND_MS - uptimeMs),
    untilReadyMs: Math.max(0, PHASE_READY_MS - uptimeMs),
    untilNextPhaseMs: untilNextPhaseMs(uptimeMs),
    progressPct: bootProgressPct(uptimeMs),
    bootSettling: isBootSettling(uptimeMs),
    overlayVisible: isBootOverlayVisible(uptimeMs),
  };
}
