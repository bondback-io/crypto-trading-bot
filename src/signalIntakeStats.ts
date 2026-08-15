/**
 * Rolling signal-intake diagnostics (15m) — independent of 24h LIVE count.
 * Used so operators can see fresh scanner admission vs gate blocks.
 */

const WINDOW_MS = 15 * 60_000;
const admittedAt: number[] = [];
const blockedAt: number[] = [];
const blockedReasons = new Map<string, number>();
let lastBlockedLogAt = 0;

function prune(arr: number[], now: number): void {
  const cutoff = now - WINDOW_MS;
  let w = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i]! >= cutoff) arr[w++] = arr[i]!;
  }
  arr.length = w;
}

export function noteSignalAdmitted(): void {
  const now = Date.now();
  admittedAt.push(now);
  prune(admittedAt, now);
}

const BLOCKED_REASONS_CAP = 32;

export function noteSignalBlockedByGate(reason: string): void {
  const now = Date.now();
  blockedAt.push(now);
  prune(blockedAt, now);
  const key = (reason || 'unknown').slice(0, 96);
  blockedReasons.set(key, (blockedReasons.get(key) || 0) + 1);
  if (blockedReasons.size > BLOCKED_REASONS_CAP) {
    let worstKey: string | null = null;
    let worstN = Infinity;
    for (const [k, v] of blockedReasons) {
      if (v < worstN) {
        worstN = v;
        worstKey = k;
      }
    }
    if (worstKey) blockedReasons.delete(worstKey);
  }
  if (now - lastBlockedLogAt > 15_000) {
    lastBlockedLogAt = now;
    console.warn(`[signals_blocked_by_gate] ${key}`);
  }
}

export function getSignalIntakeStats(now = Date.now()): {
  signalsAdmitted15m: number;
  signalsBlockedByGate15m: number;
  signalsPerMin: number;
  topBlockReasons: Array<{ reason: string; count: number }>;
  windowMs: number;
} {
  prune(admittedAt, now);
  prune(blockedAt, now);
  const admitted = admittedAt.length;
  const blocked = blockedAt.length;
  const signalsPerMin =
    admitted > 0 ? Math.round((admitted / (WINDOW_MS / 60_000)) * 10) / 10 : 0;
  const topBlockReasons = [...blockedReasons.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  return {
    signalsAdmitted15m: admitted,
    signalsBlockedByGate15m: blocked,
    signalsPerMin,
    topBlockReasons,
    windowMs: WINDOW_MS,
  };
}

/**
 * Generation-token lock so a hung await cannot pin pollInFlight forever.
 * Force-unlock increments the epoch so a late `finally` cannot clear a new poll.
 */
export function createPollInFlightLock(name: string, hangMs: number): {
  isInFlight: () => boolean;
  hungForMs: () => number;
  begin: () => number;
  end: (token: number) => void;
  reset: () => void;
  forceUnlockIfHung: () => boolean;
} {
  let inFlight = false;
  let startedAt = 0;
  let epoch = 0;
  return {
    isInFlight: () => inFlight,
    hungForMs: () => (inFlight && startedAt > 0 ? Date.now() - startedAt : 0),
    begin(): number {
      inFlight = true;
      startedAt = Date.now();
      epoch += 1;
      return epoch;
    },
    end(token: number): void {
      if (token === epoch) {
        inFlight = false;
        startedAt = 0;
      }
    },
    reset(): void {
      epoch += 1;
      inFlight = false;
      startedAt = 0;
    },
    forceUnlockIfHung(): boolean {
      if (!inFlight || startedAt <= 0) return false;
      const hungFor = Date.now() - startedAt;
      if (hungFor <= hangMs) return false;
      epoch += 1;
      inFlight = false;
      startedAt = 0;
      console.warn(
        `[${name}] pollInFlight hung ${hungFor}ms — forcing unlock so intake can resume`
      );
      try {
        noteSignalBlockedByGate(`${name}_poll_hung_unlock`);
      } catch {
        /* */
      }
      return true;
    },
  };
}

export async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timeout ${ms}ms`)),
          ms
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
