/**
 * Structured events for setup-watch Phase A/B (arm → trigger → open/block).
 * Additive ring for diagnostics / Zion — no RPC.
 */

export type SetupWatchEventKind =
  | 'armed'
  | 'triggered'
  | 'trigger_blocked_safety'
  | 'trigger_opened'
  | 'watch_expired'
  | 'trigger_blocked_cooldown'
  | 'handoff_failed';

export interface SetupWatchEvent {
  at: number;
  kind: SetupWatchEventKind;
  family: 'scalper' | 'dip' | 'grad';
  mint: string;
  symbol: string;
  profileId?: string | null;
  reason?: string;
  qualityScore?: number | null;
  entryStyle?: string | null;
}

const MAX = 200;
const events: SetupWatchEvent[] = [];

export function recordSetupWatchEvent(
  e: Omit<SetupWatchEvent, 'at'> & { at?: number }
): void {
  const row: SetupWatchEvent = {
    at: e.at ?? Date.now(),
    kind: e.kind,
    family: e.family,
    mint: String(e.mint || '').trim(),
    symbol: String(e.symbol || e.mint || '').slice(0, 24),
    profileId: e.profileId ?? null,
    reason: e.reason ? String(e.reason).slice(0, 280) : undefined,
    qualityScore: e.qualityScore ?? null,
    entryStyle: e.entryStyle ?? null,
  };
  if (!row.mint) return;
  events.unshift(row);
  if (events.length > MAX) events.length = MAX;
  const tag =
    row.family === 'scalper'
      ? 'scalper-watch'
      : row.family === 'dip'
        ? 'dip-watch'
        : 'grad-watch';
  console.log(
    `[${tag}] ${row.kind.toUpperCase()} ${row.symbol}` +
      (row.profileId ? ` → ${row.profileId}` : '') +
      (row.reason ? ` · ${row.reason}` : '')
  );
}

export function listSetupWatchEvents(limit = 40): SetupWatchEvent[] {
  return events.slice(0, Math.max(1, Math.min(100, limit)));
}

export function setupWatchEventStats(
  windowMs = 6 * 60 * 60_000,
  family?: 'scalper' | 'dip' | 'grad'
): {
  armed: number;
  triggered: number;
  opened: number;
  blockedSafety: number;
  blockedCooldown: number;
  expired: number;
  handoffFailed: number;
  openRate: number | null;
} {
  const since = Date.now() - windowMs;
  const slice = events.filter(
    (e) => e.at >= since && (family == null || e.family === family)
  );
  const armed = slice.filter((e) => e.kind === 'armed').length;
  const triggered = slice.filter((e) => e.kind === 'triggered').length;
  const opened = slice.filter((e) => e.kind === 'trigger_opened').length;
  const blockedSafety = slice.filter(
    (e) => e.kind === 'trigger_blocked_safety'
  ).length;
  const blockedCooldown = slice.filter(
    (e) => e.kind === 'trigger_blocked_cooldown'
  ).length;
  const expired = slice.filter((e) => e.kind === 'watch_expired').length;
  const handoffFailed = slice.filter((e) => e.kind === 'handoff_failed').length;
  const denom = triggered + opened + blockedSafety + handoffFailed;
  return {
    armed,
    triggered,
    opened,
    blockedSafety,
    blockedCooldown,
    expired,
    handoffFailed,
    openRate: denom > 0 ? opened / denom : null,
  };
}
