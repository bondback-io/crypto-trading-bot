/**
 * Smoke: Discovery Feeds canonical rows, cooldown skip, pump MC units.
 * Run: npx tsx scripts/smokeDiscoveryFeeds.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  canonicalizeScannerSource,
  getWatchPipelineSnapshot,
  listScannerSources,
  noteSourceWatchInsert,
  watchSourceFromCandidate,
} from '../src/watchPipeline';
import { isScannerMintOnCooldown, markScannerCooldown } from '../src/marketScanner';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

check(
  'lane-fight maps to graduating_feed',
  canonicalizeScannerSource('lane-fight-ms-watch') === 'graduating_feed'
);
check(
  'scanner/unknown/partial map to other',
  canonicalizeScannerSource('scanner') === 'other' &&
    canonicalizeScannerSource('unknown') === 'other' &&
    canonicalizeScannerSource('partial') === 'other'
);
check(
  'canonical sources unchanged',
  canonicalizeScannerSource('pump_stream') === 'pump_stream' &&
    canonicalizeScannerSource('onchain_helius') === 'onchain_helius'
);
check(
  'empty listScannerSources is other not unknown',
  listScannerSources({}).join(',') === 'other'
);
check(
  'watchSourceFromCandidate prefers launch source',
  watchSourceFromCandidate({
    specialtyFeed: 'scanner',
    scannerSources: ['jupiter'],
    source: 'scanner',
  }) === 'jupiter'
);

noteSourceWatchInsert('lane-fight-ms-watch', 'migration_sniper');
noteSourceWatchInsert('scanner', 'dip_buyer');
const snap = getWatchPipelineSnapshot();
const names = (snap.source_funnel || []).map((r) => r.source);
check(
  'funnel hides fake STALE keys',
  !names.includes('lane-fight-ms-watch') &&
    !names.includes('scanner') &&
    !names.includes('unknown') &&
    !names.includes('partial')
);
const grad = (snap.source_funnel || []).find((r) => r.source === 'graduating_feed');
check(
  'lane-fight watch counts on graduating_feed',
  (grad?.watch_inserted || 0) >= 1
);
const other = (snap.source_funnel || []).find((r) => r.source === 'other');
check(
  'untagged scanner watch is derived other',
  !!other && other.status === 'derived' && (other.watch_inserted || 0) >= 1
);

const mint = 'So11111111111111111111111111111111111111112';
markScannerCooldown(mint, false, { ms: 60_000 });
check('cooldown flag set', isScannerMintOnCooldown(mint) === true);

const msSrc = readSrc('src/marketScanner.ts');
check(
  'attach skips IN for cooled mints',
  /const cooled = isScannerMintOnCooldown\(e\.mint\)/.test(msSrc) &&
    /if \(cooled\) return/.test(msSrc)
);
check(
  'onchain skips cooled migrations',
  /if \(isScannerMintOnCooldown\(m\.mint\)\) continue/.test(msSrc)
);
check(
  'hard floor reasons split',
  /below_min_mc/.test(msSrc) &&
    /below_min_liq/.test(msSrc) &&
    /below_min_vol/.test(msSrc)
);
check(
  'hard floor sets short repeat skip',
  /PREFILTER_REPEAT_MS/.test(msSrc) &&
    /markScannerCooldown\(raw\.mint, false, \{ ms: PREFILTER_REPEAT_MS \}\)/.test(
      msSrc
    )
);
check(
  '$8k floors not lowered',
  /minMarketCapUsd: 8_000/.test(readSrc('src/config.ts'))
);

const pumpSrc = readSrc('src/pumpPortalStream.ts');
check(
  'pump does not treat marketCapSol as USD',
  !/Number\(row\.marketCapSol \?\? row\.usd_market_cap/.test(pumpSrc)
);
check(
  'pump converts SOL MC with cached SOL/USD',
  /getCachedSolUsdPrice/.test(pumpSrc) &&
    /ev\.marketCapSol \* solUsd/.test(pumpSrc)
);
check(
  'pump prefers usd_market_cap',
  /usd_market_cap/.test(pumpSrc)
);

const dash = readSrc('src/dashboard.ts');
check('derived chip CSS present', /src-chip-derived/.test(dash));

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll discovery-feeds smoke checks passed');
