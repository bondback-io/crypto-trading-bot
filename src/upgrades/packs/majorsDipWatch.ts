import { isUpgradeEnabled } from '../registry';

/** Majors Dip parks: circulating MC at/above $100M. */
export const MAJORS_MIN_MC_USD = 100_000_000;

export function majorsDipWatchAllows(input: {
  marketCapUsd?: number;
  source?: string;
}): boolean {
  if (!isUpgradeEnabled('majors_dip_watch')) return false;
  const mc = input.marketCapUsd ?? 0;
  if (mc < MAJORS_MIN_MC_USD) return false;
  const src = String(input.source || '').toLowerCase();
  return (
    src.includes('major') ||
    src.includes('jupiter') ||
    src === 'majors' ||
    mc >= MAJORS_MIN_MC_USD
  );
}

export function enableMajorsDipWatch(): void {
  console.log('[upgrades] majors_dip_watch ON — Dip admits MC ≥ $100M majors');
}

export function disableMajorsDipWatch(): void {
  console.log('[upgrades] majors_dip_watch OFF');
}
