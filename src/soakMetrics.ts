/**
 * Post-rebuild soak / tuning metrics — baseline for Off soak and module A/B.
 * Entry volume first; exit mix + fee drag for hygiene (not profit optimization).
 */

export type ExitMixKey =
  | 'trail'
  | 'stall'
  | 'fade'
  | 'dead_market'
  | 'timer'
  | 'sl'
  | 'tp'
  | 'manual'
  | 'partial'
  | 'ha'
  | 'other';

export interface ExitMixBucket {
  key: ExitMixKey;
  label: string;
  count: number;
  pct: number;
}

export interface SoakMetrics {
  /** Buys opened in the last 60 minutes */
  opensLastHour: number;
  /** Closed representative trades in the last 60 minutes */
  closesLastHour: number;
  openCount: number;
  maxConcurrentHint: number;
  exitMix: ExitMixBucket[];
  /** Average fee-aware realized % across closed reps */
  avgRealizedPnlPct: number;
  /**
   * Average mark % (raw entry→exit price move) minus realized % —
   * positive means fees/slip ate edge vs mark.
   */
  avgFeeDragPct: number;
  /** Sum of (markPct - realizedPct) over closed with prices */
  totalFeeDragPctPoints: number;
  closedSampleSize: number;
  feeDragSampleSize: number;
  capturedAt: number;
}

export function classifyExitKey(reason: string | undefined | null): {
  key: ExitMixKey;
  label: string;
} {
  const r = String(reason || '')
    .replace(/^partial:\s*/i, '')
    .trim();
  if (!r) return { key: 'other', label: 'Unknown' };
  const low = r.toLowerCase();

  if (/manual\s*force\s*sell|force\s*sell|^manual$/i.test(r)) {
    return { key: 'manual', label: 'Manual' };
  }
  if (/stalled|stall\b|underwater after/i.test(low)) {
    return { key: 'stall', label: 'Stall' };
  }
  if (
    /momentum\s*(fail|fade)|fade\s*from\s*peak|drop\s*from\s*peak|from\s*peak|peak\s*protection/i.test(
      low
    )
  ) {
    if (/peak\s*protection/i.test(low)) {
      return { key: 'fade', label: 'Peak Protection' };
    }
    return { key: 'fade', label: 'Momentum Fade' };
  }
  if (/trailing\s*stop|trail\s*exit|bag exit/i.test(r)) {
    return { key: 'trail', label: 'Trailing Stop' };
  }
  if (
    /hard\s*stop|stop-?loss|stop loss|\bsl\s*-|profile\s*sl|sl\s*@/i.test(low)
  ) {
    return { key: 'sl', label: 'Hard Stop-Loss' };
  }
  if (/first\s*spike|mig_first_spike|migration\s*event/i.test(low)) {
    return { key: 'tp', label: 'Mig First Spike' };
  }
  if (/take-?profit|full\s*tp|\btp\b/i.test(low) && !/partial/i.test(low)) {
    return { key: 'tp', label: 'Full TP' };
  }
  if (/timer|time\s*exit|deadline|scalp.*time|hold\s*limit|end of window|eow/i.test(r)) {
    return { key: 'timer', label: 'Timer / EOW' };
  }
  if (/dead\s*market|dead.?vol|inactive\s*market|volume\s*dead/i.test(r)) {
    return { key: 'dead_market', label: 'Dead Market' };
  }
  if (/heikin-?ashi|ha red flip/i.test(r)) {
    return { key: 'ha', label: 'Heikin-Ashi' };
  }
  if (/bag\s*to|bag\s*trim/i.test(r)) return { key: 'partial', label: 'Bag Trim' };
  if (/recover|initial recovered/i.test(r)) {
    return { key: 'partial', label: 'Initial Recover' };
  }
  return { key: 'other', label: 'Other' };
}

/** Normalize skip reason strings for counter buckets. */
export function normalizeSkipReason(reason: string): string {
  const r = String(reason || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!r) return 'unknown';
  if (/^ms_late_chase|^migration_late_chase(?:_blocked)?/i.test(r)) {
    return 'migration_late_chase';
  }
  if (/^ms_setup_stage_low|^ms_setup_tag_missing|^migration_not_setup/i.test(r)) {
    return 'migration_not_setup';
  }
  if (/^ms_mc_band|^migration_mc_band/i.test(r)) return 'migration_mc_band';
  if (/^ms_quality|^migration_quality_reject/i.test(r)) {
    return 'migration_quality_reject';
  }
  if (/^ms_share_cap|^migration_share_cap/i.test(r)) return 'migration_share_cap';
  // Collapse numeric suffixes (e.g. max positions (40) → max positions)
  return r
    .replace(/\s*\(\d+(?:\.\d+)?%?\)\s*$/i, '')
    .replace(/\s+\d+(\.\d+)?%?\s*$/i, '')
    .slice(0, 80);
}

/** Diagnostics keys: keep park/watching codes; soak aliases stay in normalizeSkipReason. */
export function normalizeSkipDiagReason(reason: string): string {
  const r = String(reason || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!r) return 'unknown';
  if (/^ms_setup_stage_low/i.test(r)) return 'ms_setup_stage_low';
  if (/^ms_setup_tag_missing/i.test(r)) return 'ms_setup_tag_missing';
  const owned = r.match(/^(owned_\w+_watch:\s*waiting arm(?:\s*\([^)]+\))?)/i);
  if (owned) return owned[1].replace(/\s+/g, ' ').slice(0, 80);
  if (/^waiting_open_containment_pause/i.test(r)) {
    return 'waiting_open_containment_pause';
  }
  if (/^owned_\w+_watch/i.test(r)) return r.slice(0, 80);
  return normalizeSkipReason(reason);
}

export function isParkWatchSkipReason(reason: string): boolean {
  const r = String(reason || '');
  return /owned_\w+_watch|ms_setup_stage_low|ms_setup_tag_missing|waiting_open_containment_pause/i.test(r);
}

export function markPnlPct(entryPriceSol: number, exitPriceSol: number): number | null {
  if (
    !(entryPriceSol > 0) ||
    !(exitPriceSol > 0) ||
    !Number.isFinite(entryPriceSol) ||
    !Number.isFinite(exitPriceSol)
  ) {
    return null;
  }
  return ((exitPriceSol - entryPriceSol) / entryPriceSol) * 100;
}
