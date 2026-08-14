/** Emergency heap containment — drop oldest Map/Set entries when over cap. */

export function trimMapToCap<K, V>(map: Map<K, V>, cap: number): void {
  if (cap <= 0) {
    map.clear();
    return;
  }
  while (map.size > cap) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
}

export function trimSetToCap<T>(set: Set<T>, cap: number): void {
  if (cap <= 0) {
    set.clear();
    return;
  }
  while (set.size > cap) {
    const first = set.values().next().value;
    if (first === undefined) break;
    set.delete(first);
  }
}

const sweepers: Array<() => Record<string, number> | void> = [];

export function registerCacheSweep(
  fn: () => Record<string, number> | void
): void {
  sweepers.push(fn);
}

export function runRegisteredCacheSweeps(): Record<string, number> {
  const sizes: Record<string, number> = {};
  for (const fn of sweepers) {
    try {
      const extra = fn();
      if (extra) Object.assign(sizes, extra);
    } catch {
      /* */
    }
  }
  return sizes;
}
