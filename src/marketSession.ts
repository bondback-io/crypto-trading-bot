/**
 * Market session awareness (UTC wall-clock).
 *
 * Sessions (approximate):
 *  - Asia:     00:00–08:00 UTC
 *  - Europe:   07:00–16:00 UTC
 *  - US:       13:00–22:00 UTC
 *  - Overlaps: Asia–Europe 07–08, Europe–US 13–16
 *
 * Fail-open when the market-session filter strategy is OFF.
 */

import { config } from './config';
import { isStrategyEnabled, logStrategyDecision } from './strategies';

export type MarketSessionId =
  | 'asia'
  | 'europe'
  | 'us'
  | 'asia_europe'
  | 'europe_us'
  | 'off_hours';

export interface MarketSessionSnapshot {
  /** UTC hour 0–23 */
  utcHour: number;
  /** Active named sessions (may include overlap tags) */
  active: MarketSessionId[];
  /** Primary bucket for UI / preferred matching */
  primary: 'asia' | 'europe' | 'us' | 'off_hours';
  isOverlap: boolean;
  label: string;
}

export interface MarketSessionVerdict {
  allowed: boolean;
  preferred: boolean;
  /** Soft conviction boost when in a preferred session */
  convictionDelta: number;
  skip: boolean;
  skipReason?: string;
  influenced: boolean;
  snapshot: MarketSessionSnapshot;
  logLine: string;
}

function inRange(hour: number, start: number, end: number): boolean {
  // [start, end) on 0–23 clock
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

export function detectMarketSession(nowMs: number = Date.now()): MarketSessionSnapshot {
  const utcHour = new Date(nowMs).getUTCHours();
  const asia = inRange(utcHour, 0, 8);
  const europe = inRange(utcHour, 7, 16);
  const us = inRange(utcHour, 13, 22);
  const asiaEurope = asia && europe;
  const europeUs = europe && us;

  const active: MarketSessionId[] = [];
  if (asiaEurope) active.push('asia_europe');
  if (europeUs) active.push('europe_us');
  if (asia) active.push('asia');
  if (europe) active.push('europe');
  if (us) active.push('us');
  if (active.length === 0) active.push('off_hours');

  let primary: MarketSessionSnapshot['primary'] = 'off_hours';
  if (us) primary = 'us';
  else if (europe) primary = 'europe';
  else if (asia) primary = 'asia';

  const isOverlap = asiaEurope || europeUs;
  const label = isOverlap
    ? asiaEurope
      ? 'Asia–Europe overlap'
      : 'Europe–US overlap'
    : primary === 'off_hours'
      ? 'Off-hours'
      : primary === 'asia'
        ? 'Asia'
        : primary === 'europe'
          ? 'Europe'
          : 'US';

  return { utcHour, active, primary, isOverlap, label };
}

function allowList(): {
  asia: boolean;
  europe: boolean;
  us: boolean;
  overlap: boolean;
  offHours: boolean;
} {
  return {
    asia: config.filters.marketSessionAllowAsia !== false,
    europe: config.filters.marketSessionAllowEurope !== false,
    us: config.filters.marketSessionAllowUs !== false,
    overlap: config.filters.marketSessionAllowOverlap !== false,
    offHours: config.filters.marketSessionAllowOffHours === true,
  };
}

function preferredSet(): Set<string> {
  const raw = config.filters.marketSessionPreferred;
  const list = Array.isArray(raw) ? raw.map(String) : ['us', 'europe_us'];
  return new Set(list.map((s) => s.toLowerCase()));
}

function sessionAllowed(snap: MarketSessionSnapshot): boolean {
  const allow = allowList();
  if (snap.active.includes('off_hours')) return allow.offHours;
  if (snap.isOverlap) {
    if (!allow.overlap) {
      // Overlap disabled → still allow if a non-overlap leg is allowed
      if (snap.active.includes('asia') && allow.asia) return true;
      if (snap.active.includes('europe') && allow.europe) return true;
      if (snap.active.includes('us') && allow.us) return true;
      return false;
    }
    return true;
  }
  if (snap.primary === 'asia') return allow.asia;
  if (snap.primary === 'europe') return allow.europe;
  if (snap.primary === 'us') return allow.us;
  return allow.offHours;
}

function isPreferred(snap: MarketSessionSnapshot): boolean {
  const pref = preferredSet();
  if (pref.size === 0) return false;
  for (const a of snap.active) {
    if (pref.has(a)) return true;
  }
  if (pref.has(snap.primary)) return true;
  if (snap.isOverlap && pref.has('overlap')) return true;
  return false;
}

export function applyMarketSessionVerdict(
  snap: MarketSessionSnapshot = detectMarketSession()
): MarketSessionVerdict {
  const allowed = sessionAllowed(snap);
  const preferred = isPreferred(snap);
  const boost = Number(config.filters.marketSessionPreferBoostPoints);
  const preferBoost =
    Number.isFinite(boost) && boost > 0 ? Math.min(10, Math.round(boost)) : 3;

  let skip = false;
  let skipReason: string | undefined;
  let convictionDelta = 0;

  if (!allowed) {
    skip = true;
    skipReason = `market session blocked (${snap.label}, UTC ${String(snap.utcHour).padStart(2, '0')}:00)`;
  } else if (preferred) {
    convictionDelta = preferBoost;
  }

  const influenced = skip || convictionDelta > 0;
  const logLine =
    `session ${snap.label} UTC=${snap.utcHour} ` +
    `allowed=${allowed} preferred=${preferred} Δconv=${
      convictionDelta > 0 ? '+' : ''
    }${convictionDelta}` +
    (skip ? ' SKIP' : '');

  return {
    allowed,
    preferred,
    convictionDelta,
    skip,
    skipReason,
    influenced,
    snapshot: snap,
    logLine,
  };
}

export function resolveMarketSessionForEntry(
  nowMs: number = Date.now()
): MarketSessionVerdict | null {
  if (!isStrategyEnabled('market_session_filter')) return null;
  if (config.filters.enableMarketSessionFilter === false) return null;
  return applyMarketSessionVerdict(detectMarketSession(nowMs));
}

export function logMarketSessionDecision(
  symbol: string,
  verdict: MarketSessionVerdict,
  outcome: 'boost' | 'skip' | 'neutral'
): void {
  if (!verdict.influenced && outcome === 'neutral') return;
  logStrategyDecision(
    'market_session_filter',
    outcome === 'skip' ? 'skip' : 'take',
    `${symbol}: ${verdict.logLine}`
  );
  const tag =
    outcome === 'skip' ? 'SKIP' : outcome === 'boost' ? 'BOOST' : 'INFO';
  console.log(`[session] ${tag} ${symbol} — ${verdict.logLine}`);
}

/** Compact payload for dashboard /api/status */
export function marketSessionPublic(nowMs: number = Date.now()): {
  label: string;
  primary: string;
  utcHour: number;
  isOverlap: boolean;
  active: MarketSessionId[];
  allowed: boolean;
  preferred: boolean;
  filterEnabled: boolean;
} {
  const snap = detectMarketSession(nowMs);
  const filterEnabled =
    isStrategyEnabled('market_session_filter') &&
    config.filters.enableMarketSessionFilter !== false;
  const verdict = applyMarketSessionVerdict(snap);
  return {
    label: snap.label,
    primary: snap.primary,
    utcHour: snap.utcHour,
    isOverlap: snap.isOverlap,
    active: snap.active,
    allowed: filterEnabled ? verdict.allowed : true,
    preferred: verdict.preferred,
    filterEnabled,
  };
}
