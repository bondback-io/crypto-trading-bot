/**
 * Smoke: Target Dip Entry MC must be support-side (at or below live MC).
 * Run: npx tsx scripts/smokeDipTargetMc.ts
 */
import {
  buildSupportSideMcTargets,
  fibPriceFromHigh,
  isSupportSideLevel,
  marketCapAtPriceLevel,
  pickDipRetracementLevels,
} from '../src/technicalLevels';
import fs from 'node:fs';
import path from 'node:path';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

check('overhead 2× level is not support-side', isSupportSideLevel(2, 1) === false);
check('level 5% below is support-side', isSupportSideLevel(0.95, 1) === true);
check(
  '2% undercut still support-side',
  isSupportSideLevel(1.02, 1) === true
);
check(
  '5% overhead is not support-side (4% slack)',
  isSupportSideLevel(1.05, 1) === false
);

const dumped = pickDipRetracementLevels({
  livePrice: 1.02,
  swingHigh: 2,
  swingLow: 1,
});
check(
  'dumped-to-low drops Fib 0.5 (midpoint above live)',
  dumped.fib05 == null,
  String(dumped.fib05)
);
check(
  'dumped-to-low drops Fib 0.618 from high when still above live',
  dumped.fib618 == null,
  String(dumped.fib618)
);

const waiting = pickDipRetracementLevels({
  livePrice: 1.7,
  swingHigh: 2,
  swingLow: 1,
});
const expect05 = fibPriceFromHigh(2, 1, 0.5);
check(
  'waiting-for-dip keeps Fib 0.5 below live',
  waiting.fib05 != null && Math.abs((waiting.fib05 ?? 0) - expect05) < 1e-9,
  String(waiting.fib05)
);
check(
  'waiting-for-dip keeps Fib 0.618 below live',
  waiting.fib618 != null && (waiting.fib618 ?? 0) < 1.7,
  String(waiting.fib618)
);

const jlLiveMc = 424_871_395;
const overhead = buildSupportSideMcTargets({
  marketCapUsd: jlLiveMc,
  lastPriceSol: 1,
  levels: [
    { label: 'Fib 0.5', priceSol: 747_787_994 / jlLiveMc },
    { label: 'Fib 0.618', priceSol: 770_429_213 / jlLiveMc },
  ],
});
check(
  'jlUSDC-style overhead Fibs omitted from Target Dip Entry',
  overhead.length === 0,
  JSON.stringify(overhead)
);

const dipBelow = buildSupportSideMcTargets({
  marketCapUsd: 42_699_250,
  lastPriceSol: 1,
  levels: [
    { label: 'Fib 0.5', priceSol: 0.82 },
    { label: 'Support', priceSol: 0.78 },
  ],
});
check('support-side Fib+S both shown', dipBelow.length === 2);
check(
  'target MC is below live MC',
  dipBelow.every((t) => t.mcUsd < 42_699_250),
  dipBelow.map((t) => Math.round(t.mcUsd)).join(',')
);

const atSupport = marketCapAtPriceLevel(10_000_000, 1, 1);
check('sitting on support ≈ live MC', atSupport === 10_000_000);

const src = (rel: string) =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const dipSrc = src('src/dipSetupWatch.ts');
check(
  'quality parks fetch 1h/4h OHLCV',
  dipSrc.includes("tfs: isQuality ? ['15m', '1h', '4h']")
);
check(
  'quality parks prefer 4h candles for Fib',
  /isQuality\s*\?\s*[\s\S]*multiByTf\['4h'\]/.test(dipSrc)
);
const trendSrc = src('src/trendSetupWatch.ts');
check(
  'trend parks fetch 1h/4h OHLCV',
  trendSrc.includes("tfs: ['15m', '1h', '4h']")
);

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll dip-target MC checks passed');
