/**
 * Observe-only watch-system readiness for dashboard status lights.
 * Does not change admit / Entry Skill / open gates.
 */

import { config } from './config';
import { isStrategyEnabledGlobal } from './strategies';
import {
  getTradeProfileEnabledFlags,
  isSmartBotProfilesEnabled,
} from './tradeProfiles';

export type WatchReadinessColor = 'green' | 'amber' | 'red';

export interface WatchSystemLight {
  id: string;
  label: string;
  color: WatchReadinessColor;
  detail: string;
  enabled: boolean;
  active: number;
  ticking: boolean;
}

export interface WatchSystemsReadiness {
  overall: WatchReadinessColor;
  overallDetail: string;
  systems: WatchSystemLight[];
  at: number;
}

function worst(
  a: WatchReadinessColor,
  b: WatchReadinessColor
): WatchReadinessColor {
  const rank = { green: 0, amber: 1, red: 2 };
  return rank[a] >= rank[b] ? a : b;
}

function profileOn(
  flags: Record<string, boolean>,
  ids: string[]
): boolean {
  return ids.some((id) => flags[id] !== false);
}

function recentMs(at: number | null | undefined, windowMs: number): boolean {
  const t = Number(at) || 0;
  return t > 0 && Date.now() - t <= windowMs;
}

function maxUpdatedAt(
  entries: Array<{ updatedAt?: number; status?: string }> | undefined
): number {
  let max = 0;
  for (const e of entries || []) {
    const st = String(e.status || '');
    if (st !== 'watching' && st !== 'armed') continue;
    const u = Number(e.updatedAt) || 0;
    if (u > max) max = u;
  }
  return max;
}

/**
 * Snapshot readiness for Dip/Steady, Trend, ModeB/Scalper, Migration, Smart Mirror, HWR.
 */
export function getWatchSystemsReadiness(): WatchSystemsReadiness {
  const flags = getTradeProfileEnabledFlags();
  const smartOn = isSmartBotProfilesEnabled();
  const scannerOn = isStrategyEnabledGlobal('ta_market_scanner');
  const systems: WatchSystemLight[] = [];

  // --- Dip / Steady ---
  let dipActive = 0;
  let dipMedMaj = 0;
  let dipTickAt = 0;
  try {
    const { getActiveDipWatchesSnapshot } =
      require('./dipSetupWatch') as typeof import('./dipSetupWatch');
    const dw = getActiveDipWatchesSnapshot();
    dipActive = Number(dw.active) || 0;
    dipTickAt = maxUpdatedAt(dw.allActive as Array<{ updatedAt?: number; status?: string }>);
    for (const e of dw.allActive || []) {
      const src = String((e as { source?: string }).source || '').toLowerCase();
      if (
        (src === 'medium' || src === 'majors') &&
        (e.status === 'watching' || e.status === 'armed')
      ) {
        dipMedMaj += 1;
      }
    }
  } catch {
    /* soft */
  }
  let majorsPassAt: number | null = null;
  let majorsErr: string | null = null;
  let majorsCount = 0;
  try {
    const { getMajorsUniverseStatus } =
      require('./majorsUniverse') as typeof import('./majorsUniverse');
    const mu = getMajorsUniverseStatus();
    majorsPassAt = mu.lastPassAt;
    majorsErr = mu.lastError;
    majorsCount = mu.count;
  } catch {
    /* soft */
  }
  const dipEnabled =
    smartOn &&
    profileOn(flags, ['dip_buyer', 'steady_compounder']);
  const dipTicking =
    dipEnabled &&
    scannerOn &&
    (recentMs(dipTickAt, 10 * 60_000) ||
      recentMs(majorsPassAt, 15 * 60_000) ||
      dipActive > 0);
  let dipColor: WatchReadinessColor = 'green';
  let dipDetail = `${dipActive} active · med/maj ${dipMedMaj}`;
  if (!dipEnabled) {
    dipColor = 'red';
    dipDetail = smartOn
      ? 'Dip + Steady profiles off'
      : 'Smart Bot Profiles off';
  } else if (!scannerOn) {
    dipColor = 'red';
    dipDetail = 'Market scanner off';
  } else if (majorsErr) {
    dipColor = 'amber';
    dipDetail = `Majors feed: ${majorsErr}`;
  } else if (!dipTicking) {
    dipColor = 'amber';
    dipDetail = 'Waiting for scanner tick';
  } else if (dipMedMaj < 3 && majorsCount > 0) {
    dipColor = 'amber';
    dipDetail = `Thin medium/majors (${dipMedMaj}) · universe ${majorsCount}`;
  }
  systems.push({
    id: 'dip_steady',
    label: 'Dip / Steady',
    color: dipColor,
    detail: dipDetail,
    enabled: dipEnabled,
    active: dipActive,
    ticking: dipTicking,
  });

  // --- Trend Rider ---
  let trendActive = 0;
  let trendTickAt = 0;
  try {
    const { getTrendSetupWatchStatus } =
      require('./trendSetupWatch') as typeof import('./trendSetupWatch');
    const tw = getTrendSetupWatchStatus(20);
    trendActive = Number(tw.active) || 0;
    trendTickAt = maxUpdatedAt(tw.entries as Array<{ updatedAt?: number; status?: string }>);
  } catch {
    /* soft */
  }
  const trendEnabled = smartOn && flags.trend_rider !== false;
  const trendTicking =
    trendEnabled &&
    scannerOn &&
    (recentMs(trendTickAt, 10 * 60_000) || trendActive > 0 || scannerOn);
  let trendColor: WatchReadinessColor = 'green';
  let trendDetail = `${trendActive} active`;
  if (!trendEnabled) {
    trendColor = 'red';
    trendDetail = 'Trend Rider off';
  } else if (!scannerOn) {
    trendColor = 'red';
    trendDetail = 'Market scanner off';
  } else if (trendActive === 0) {
    trendColor = 'amber';
    trendDetail = 'No Trend watches yet';
  }
  systems.push({
    id: 'trend',
    label: 'Trend',
    color: trendColor,
    detail: trendDetail,
    enabled: trendEnabled,
    active: trendActive,
    ticking: trendTicking,
  });

  // --- Mode B / Scalper family ---
  let modeBActive = 0;
  let modeBTickAt = 0;
  try {
    const { getScalperSetupWatchStatus } =
      require('./scalperSetupWatch') as typeof import('./scalperSetupWatch');
    const sw = getScalperSetupWatchStatus(20);
    modeBActive = Number(sw.active) || 0;
    modeBTickAt = maxUpdatedAt(sw.entries as Array<{ updatedAt?: number; status?: string }>);
  } catch {
    /* soft */
  }
  const modeBEnabled =
    smartOn &&
    profileOn(flags, ['scalper', 'momentum_burst', 'reversal_scalper']);
  const modeBTicking =
    modeBEnabled &&
    scannerOn &&
    (recentMs(modeBTickAt, 10 * 60_000) || modeBActive > 0 || scannerOn);
  let modeBColor: WatchReadinessColor = 'green';
  let modeBDetail = `${modeBActive} active`;
  if (!modeBEnabled) {
    modeBColor = 'red';
    modeBDetail = 'Scalper family off';
  } else if (!scannerOn) {
    modeBColor = 'red';
    modeBDetail = 'Market scanner off';
  } else if (modeBActive === 0) {
    modeBColor = 'amber';
    modeBDetail = 'No Mode B watches yet';
  }
  systems.push({
    id: 'mode_b',
    label: 'Mode B / Scalper',
    color: modeBColor,
    detail: modeBDetail,
    enabled: modeBEnabled,
    active: modeBActive,
    ticking: modeBTicking,
  });

  // --- Migration Sniper ---
  let migActive = 0;
  let migTickAt = 0;
  try {
    const { getMigrationGradWatchStatus } =
      require('./migrationGradWatch') as typeof import('./migrationGradWatch');
    const gw = getMigrationGradWatchStatus(20);
    migActive = Number(gw.active) || 0;
    migTickAt = maxUpdatedAt(gw.entries as Array<{ updatedAt?: number; status?: string }>);
  } catch {
    /* soft */
  }
  const migEnabled = smartOn && flags.migration_sniper !== false;
  const migTicking =
    migEnabled &&
    (recentMs(migTickAt, 15 * 60_000) || migActive > 0 || scannerOn);
  let migColor: WatchReadinessColor = 'green';
  let migDetail = `${migActive} active`;
  if (!migEnabled) {
    migColor = 'red';
    migDetail = 'Migration Sniper off';
  } else if (migActive === 0) {
    migColor = 'amber';
    migDetail = 'No graduation watches yet';
  }
  systems.push({
    id: 'migration',
    label: 'Migration',
    color: migColor,
    detail: migDetail,
    enabled: migEnabled,
    active: migActive,
    ticking: migTicking,
  });

  // --- Smart Mirror (WIP prereqs → amber) ---
  let mirrorEnabled = false;
  let mirrorWallets = 0;
  let mirrorPrereqOk = false;
  let mirrorReason = '';
  try {
    const { getInfluencerMirrorStatusSummary } =
      require('./influencerMirror') as typeof import('./influencerMirror');
    const sm = getInfluencerMirrorStatusSummary();
    mirrorEnabled = sm.enabled === true;
    mirrorWallets = Number(sm.copyEnabledCount) || 0;
    mirrorPrereqOk = sm.prereqOk === true;
    mirrorReason = String(sm.prereqReason || '');
  } catch {
    /* soft */
  }
  let mirrorColor: WatchReadinessColor = 'green';
  let mirrorDetail = `${mirrorWallets} wallets`;
  if (!mirrorEnabled) {
    mirrorColor = 'amber';
    mirrorDetail = 'Master off (WIP)';
  } else if (!mirrorPrereqOk) {
    mirrorColor = 'amber';
    mirrorDetail = mirrorReason || 'Prereqs missing';
  } else if (mirrorWallets <= 0) {
    mirrorColor = 'amber';
    mirrorDetail = 'No copy-enabled wallets';
  }
  systems.push({
    id: 'smart_mirror',
    label: 'Smart Mirror',
    color: mirrorColor,
    detail: mirrorDetail,
    enabled: mirrorEnabled,
    active: mirrorWallets,
    ticking: mirrorEnabled && mirrorPrereqOk && mirrorWallets > 0,
  });

  // --- High Win-Rate (organic quality parks + Zion Platinum) ---
  const hwrEnabled = smartOn && flags.high_win_rate !== false;
  let hwrColor: WatchReadinessColor = 'green';
  let hwrDetail = 'Ready · organic parks + Zion Platinum';
  let hwrActive = 0;
  if (!hwrEnabled) {
    hwrColor = 'red';
    hwrDetail = 'High Win-Rate off';
  } else if (!smartOn) {
    hwrColor = 'red';
    hwrDetail = 'Smart Bot Profiles off';
  } else {
    try {
      const { getActiveDipWatchesSnapshot } =
        require('./dipSetupWatch') as typeof import('./dipSetupWatch');
      const snap = getActiveDipWatchesSnapshot();
      hwrActive = (snap.allActive || []).filter(
        (e) =>
          e.preferredProfileId === 'high_win_rate' &&
          (e.status === 'watching' || e.status === 'armed')
      ).length;
      if (hwrActive > 0) {
        hwrDetail = `Organic parks ${hwrActive} · Zion Platinum`;
      }
    } catch {
      /* soft */
    }
    try {
      const zion = (config as { zion?: { autoSendPlatinumToHwr?: boolean } }).zion;
      if (hwrEnabled && zion && zion.autoSendPlatinumToHwr === false && hwrActive === 0) {
        hwrDetail = 'Organic parks ready (Platinum auto-send off)';
      }
    } catch {
      /* soft */
    }
  }
  systems.push({
    id: 'hwr',
    label: 'HWR',
    color: hwrColor,
    detail: hwrDetail,
    enabled: hwrEnabled,
    active: hwrEnabled ? Math.max(1, hwrActive) : 0,
    ticking: hwrEnabled,
  });

  let overall: WatchReadinessColor = 'green';
  for (const s of systems) overall = worst(overall, s.color);
  const overallDetail =
    overall === 'green'
      ? 'All watch systems ready'
      : overall === 'amber'
        ? 'Some systems thin / WIP / cooling'
        : 'One or more systems off or faulted';

  return {
    overall,
    overallDetail,
    systems,
    at: Date.now(),
  };
}
