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
  | 'handoff_failed'
  | 'touch_fail';

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
  touchFail: number;
  openRate: number | null;
  /** touch_fail / (armed || 1) in window — elevated when conversion rejects dominate. */
  touchFailRate: number | null;
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
  const touchFail = slice.filter((e) => e.kind === 'touch_fail').length;
  const denom = triggered + opened + blockedSafety + handoffFailed;
  return {
    armed,
    triggered,
    opened,
    blockedSafety,
    blockedCooldown,
    expired,
    handoffFailed,
    touchFail,
    openRate: denom > 0 ? opened / denom : null,
    touchFailRate: armed > 0 || touchFail > 0 ? touchFail / Math.max(armed, 1) : null,
  };
}

/** Per-mint expire-unused loosen: ≥3 expires + 0 opens → shorten remaining TTL 25% once. */
const expireUnusedByMint = new Map<
  string,
  { expires: number; opens: number; loosened: boolean }
>();

export function noteSetupWatchExpiredUnused(mint: string): void {
  const m = String(mint || '').trim();
  if (!m) return;
  const row = expireUnusedByMint.get(m) || {
    expires: 0,
    opens: 0,
    loosened: false,
  };
  row.expires += 1;
  expireUnusedByMint.set(m, row);
}

export function noteSetupWatchOpenedFromArm(mint: string): void {
  const m = String(mint || '').trim();
  if (!m) return;
  const row = expireUnusedByMint.get(m) || {
    expires: 0,
    opens: 0,
    loosened: false,
  };
  row.opens += 1;
  expireUnusedByMint.set(m, row);
}

/**
 * If mint has ≥3 unused expires and 0 opens, shorten remaining TTL by 25% once.
 * Returns new expiresAt when applied, else null.
 */
export function maybeLoosenExpireUnusedTtl(
  mint: string,
  expiresAt: number,
  now = Date.now()
): number | null {
  const m = String(mint || '').trim();
  if (!m) return null;
  const row = expireUnusedByMint.get(m);
  if (!row || row.loosened || row.opens > 0 || row.expires < 3) return null;
  const remain = Math.max(0, expiresAt - now);
  if (remain < 30_000) return null;
  const next = now + Math.floor(remain * 0.75);
  row.loosened = true;
  expireUnusedByMint.set(m, row);
  console.log(
    `[setup-watch] expire-loosen ${m.slice(0, 8)}… · ${row.expires} unused expires → TTL −25% (once)`
  );
  return next;
}

/** Touch-and-fail undercut depth (1.8%); disabled when openRate < 0.20. */
export function touchFailUndercutPct(): number {
  try {
    const stats = setupWatchEventStats();
    if (stats.openRate != null && stats.openRate < 0.2) return Number.POSITIVE_INFINITY;
  } catch {
    /* soft */
  }
  return 1.8;
}
