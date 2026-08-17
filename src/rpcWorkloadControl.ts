/**
 * Watchers-lane idle isolation — classic no-op (always allow workload).
 */

/** Classic: never idle-isolate on containment/watchers spike. */
export function shouldIdleIsolate(): boolean {
  return false;
}

/** Inverse of shouldIdleIsolate — used by dip / majors watch ticks. */
export function isRpcWorkloadEnabled(_id?: string): boolean {
  void _id;
  return true;
}
