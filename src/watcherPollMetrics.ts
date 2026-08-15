/**
 * Rolling watcher poll counters for A/B isolation (Dip/Steady / Trend / Majors).
 * These are mostly HTTP (Dex/Gecko/Jupiter), not Solana RPC — still useful for site thrash.
 */

export type WatcherPollKind = 'dip' | 'trend' | 'majors';

const buckets: Record<WatcherPollKind, number[]> = {
  dip: [],
  trend: [],
  majors: [],
};

function trim(bucket: number[], now: number): void {
  while (bucket.length && bucket[0]! < now - 60_000) bucket.shift();
}

export function noteWatcherPoll(kind: WatcherPollKind): void {
  const now = Date.now();
  const b = buckets[kind];
  b.push(now);
  trim(b, now);
}

export function getWatcherPollsPerMin(): {
  dip: number;
  trend: number;
  majors: number;
  total: number;
} {
  const now = Date.now();
  trim(buckets.dip, now);
  trim(buckets.trend, now);
  trim(buckets.majors, now);
  const dip = buckets.dip.length;
  const trend = buckets.trend.length;
  const majors = buckets.majors.length;
  return { dip, trend, majors, total: dip + trend + majors };
}
