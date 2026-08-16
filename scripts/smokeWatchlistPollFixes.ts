/**
 * Smoke: same-mint lock, TA copy, watchlist diagnostics (1.2.379).
 * Run: npx tsx scripts/smokeWatchlistPollFixes.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  __resetExecuteBuyMintLockForTests,
  releaseExecuteBuyMint,
  tryAcquireExecuteBuyMint,
} from '../src/trade';
import { getMinTaPlaybookConfluences } from '../src/tradeProfiles';
import { coerceTokenLabel } from '../src/migrationGradWatch';
import { canTriggerArmed } from '../src/profileWatchRegistry';
import { scoreTaConfluence } from '../src/profileTaPlaybook';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

__resetExecuteBuyMintLockForTests();
const mint = 'SoLcatMintLockTest111111111111111111111111';
check('first acquire wins', tryAcquireExecuteBuyMint(mint) === true);
check('overlapping acquire skipped', tryAcquireExecuteBuyMint(mint) === false);
releaseExecuteBuyMint(mint);
check('release allows next acquire', tryAcquireExecuteBuyMint(mint) === true);
releaseExecuteBuyMint(mint);
__resetExecuteBuyMintLockForTests();

const tradeSrc = readSrc('src/trade.ts');
check(
  'executeBuy re-checks hasOpenMint before simulateBuy and live send',
  (tradeSrc.match(/paperTrader\.hasOpenMint\(mint\)/g) || []).length >= 3
);
check(
  'stop-reentry defaults untouched in trade.ts',
  !/reEntryMaxPerMint\s*=/.test(tradeSrc)
);

const dipMin = getMinTaPlaybookConfluences('dip_buyer');
const migMin = getMinTaPlaybookConfluences('migration_sniper');
check('Dip Micro Bots min is an integer floor', Number.isInteger(dipMin) && dipMin >= 0);
check('Migration Micro Bots min is an integer floor', Number.isInteger(migMin) && migMin >= 0);

const score = scoreTaConfluence({
  profileId: 'dip_buyer',
  watch: {
    status: 'armed',
    armed: true,
    nearSupport: true,
    nearKeyFib: false,
    volOk: false,
    mint,
  },
});
const gate = canTriggerArmed({
  profileId: 'dip_buyer',
  score,
  watch: { status: 'armed', armed: true, nearSupport: true, mint },
});
if (dipMin >= 2 && score.confluenceCount < dipMin) {
  check(
    'Dip min 2 still blocks have < min (no loosen)',
    gate.ok === false && /need .* TA confluences/.test(gate.reason)
  );
} else {
  check('Dip confluence gate ran', typeof gate.ok === 'boolean');
}

const serverSrc = readSrc('src/server.ts');
check(
  'slim closed keeps confluence stamps',
  /confluenceCountAtTrigger: p\.confluenceCountAtTrigger/.test(serverSrc) &&
    /playbookPassed: p\.playbookPassed/.test(serverSrc)
);

const dashSrc = readSrc('src/dashboard.ts');
check(
  'watchlist copy binds live min N',
  dashSrc.includes('id="dip-watch-rules"') &&
    dashSrc.includes('minTaPlaybookConfluences') &&
    dashSrc.includes('id="grad-watch-rules"')
);
check(
  'dashboard uses mon for watchedWallets',
  /mon\.watchedWallets/.test(dashSrc) &&
    !/status\.monitor\.watchedWallets/.test(dashSrc)
);
check(
  'dashboard 429 backoff + GET coalesce',
  dashSrc.includes('_dashBackoffUntil') && dashSrc.includes('_dashInflightGets')
);
check(
  'refresh skips when tab hidden',
  /setInterval\(function \(\) \{\s*try \{\s*if \(document\.hidden\) return;/s.test(
    dashSrc
  )
);

check(
  'object symbol coerces to readable label',
  coerceTokenLabel({ symbol: 'SOLCAT' }, 'fb') === 'SOLCAT' &&
    coerceTokenLabel('[object Object]', 'fb') === 'fb'
);

const readySrc = readSrc('src/watchSystemsReadiness.ts');
check(
  'Migration amber copy is live-empty',
  readySrc.includes('No live graduation watches') &&
    !readySrc.includes('No graduation watches yet')
);

const rebuySrc = readSrc('src/reBuy.ts');
check(
  'stop-reentry engine still present',
  /postStopReentryEnabled|reEntryMaxPerMint/.test(rebuySrc)
);

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll 1.2.379 watchlist/poll smoke checks passed.');
