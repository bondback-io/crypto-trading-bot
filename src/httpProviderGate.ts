/**
 * Shared helpers for external HTTP provider cooldowns / quarantine.
 * Providers keep their own state; this standardizes backoff math and quiet logs.
 */

export function computeCooldownMs(
  streak: number,
  baseMs: number,
  capMs: number
): number {
  const s = Math.max(1, Math.floor(streak));
  return Math.min(capMs, baseMs * Math.pow(2, Math.min(s - 1, 4)));
}

/** Apply streak-based cooldown; returns new until + duration used. */
export function applyCooldown(opts: {
  streak: number;
  baseMs: number;
  capMs: number;
  currentUntil?: number;
  now?: number;
}): { until: number; durationMs: number; streak: number } {
  const now = opts.now ?? Date.now();
  const streak = Math.max(1, Math.floor(opts.streak));
  const durationMs = computeCooldownMs(streak, opts.baseMs, opts.capMs);
  const until = Math.max(opts.currentUntil ?? 0, now + durationMs);
  return { until, durationMs, streak };
}

export class QuietLogGate {
  private lastAt = 0;
  constructor(private readonly minGapMs: number) {}

  /** Returns true if a log should be emitted now. */
  allow(now = Date.now()): boolean {
    if (now - this.lastAt < this.minGapMs) return false;
    this.lastAt = now;
    return true;
  }
}

/** Key → quarantine-until map with prune on read. */
export class QuarantineMap {
  private readonly map = new Map<string, number>();

  quarantine(key: string, durationMs: number, now = Date.now()): void {
    const until = now + durationMs;
    const prev = this.map.get(key) ?? 0;
    if (until > prev) this.map.set(key, until);
  }

  isQuarantined(key: string, now = Date.now()): boolean {
    const until = this.map.get(key);
    if (until == null) return false;
    if (until <= now) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  remainingMs(key: string, now = Date.now()): number {
    const until = this.map.get(key);
    if (until == null) return 0;
    return Math.max(0, until - now);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

export function formatCooldownSecs(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}
