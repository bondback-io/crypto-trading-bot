/**
 * Smoke: Dip tab eligibility — in-band quality parks keep dip_buyer.
 * Run: npx tsx scripts/smokeDipWatchlistEligibility.ts
 */
import {
  ensureDipBuyerOnInBandWatch,
  resolveWatchEligibleProfileIds,
} from '../src/tradeProfiles';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

const inBandMc = 50_000_000;
const aboveMaxMc = 5_000_000_000;
const minorMc = 2_000_000;

const inBandIds = resolveWatchEligibleProfileIds({
  family: 'dip',
  dipQualityPark: true,
  source: 'medium',
  preferredProfileId: 'steady_compounder',
  marketCapUsd: inBandMc,
  liquidityUsd: 80_000,
  volumeH1Usd: 40_000,
  holderCount: 4000,
  nearKeyFib: true,
  nearSupport: false,
  dropFromPeakPct: 4,
});
check(
  'in-band medium quality includes dip_buyer',
  inBandIds.includes('dip_buyer'),
  inBandIds.join(',') || 'empty'
);

const aboveIds = resolveWatchEligibleProfileIds({
  family: 'dip',
  dipQualityPark: true,
  source: 'majors',
  preferredProfileId: 'steady_compounder',
  marketCapUsd: aboveMaxMc,
  liquidityUsd: 120_000,
  volumeH1Usd: 50_000,
  holderCount: 8000,
  nearKeyFib: true,
  dropFromPeakPct: 3,
});
check(
  'above Dip max does not force dip_buyer',
  !aboveIds.includes('dip_buyer'),
  aboveIds.join(',') || 'empty'
);

const minorIds = resolveWatchEligibleProfileIds({
  family: 'dip',
  source: 'dexscreener',
  preferredProfileId: 'dip_buyer',
  marketCapUsd: minorMc,
  volumeH1Usd: 12_000,
  holderCount: 200,
  nearKeyFib: true,
  dropFromPeakPct: 10,
});
check(
  'in-band minors stay dip_buyer',
  minorIds.includes('dip_buyer'),
  minorIds.join(',') || 'empty'
);

const restored = ensureDipBuyerOnInBandWatch(
  ['steady_compounder'],
  inBandMc
);
check(
  'stale Steady tag restamps dip_buyer in band',
  restored[0] === 'dip_buyer' && restored.includes('steady_compounder'),
  restored.join(',')
);

const aboveKeep = ensureDipBuyerOnInBandWatch(
  ['high_win_rate'],
  aboveMaxMc
);
check(
  'above-max exclusive HWR stays exclusive',
  aboveKeep.length === 1 && aboveKeep[0] === 'high_win_rate',
  aboveKeep.join(',')
);

const rejectedBoth = resolveWatchEligibleProfileIds({
  family: 'dip',
  dipQualityPark: true,
  source: 'medium',
  marketCapUsd: inBandMc,
});
check(
  'in-band quality with no Steady/HWR still lists Dip',
  rejectedBoth.includes('dip_buyer'),
  rejectedBoth.join(',') || 'empty'
);

if (failed > 0) {
  console.error(`FAILED ${failed} check(s)`);
  process.exit(1);
}
console.log('OK dip watchlist eligibility');
