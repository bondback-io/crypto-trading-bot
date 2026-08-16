/**
 * Smoke: credits guard — classify, backoff, no tight retry, no body: spam path.
 * Run: npx tsx scripts/smokeCreditsGuard.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  __resetCreditsGuardForTests,
  classifyCreditsProvider,
  getCreditsGuardStatus,
  isCreditsGuardResponse,
  isInsufficientCreditsBody,
  isInsufficientCreditsError,
  logCreditsRequest,
  noteCreditsExhausted,
  redactCreditsEndpoint,
  shouldSkipCreditsProvider,
} from '../src/creditsGuard';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

__resetCreditsGuardForTests();

check(
  'detects exact Helius JSON',
  isInsufficientCreditsBody('{"error":"Insufficient credits for this request"}')
);
check(
  'detects credit usage limit',
  isInsufficientCreditsBody('Credit usage limit exceeded')
);
check(
  'ignores generic 429',
  isInsufficientCreditsBody('429 too many requests') === false
);
check(
  'error object with message',
  isInsufficientCreditsError(
    Object.assign(new Error('Insufficient credits for this request'), { status: 429 })
  )
);

check(
  'classifies Helius RPC',
  classifyCreditsProvider('https://mainnet.helius-rpc.com/?api-key=secret') === 'helius'
);
check(
  'classifies Birdeye',
  classifyCreditsProvider('https://public-api.birdeye.so/defi/token_overview') === 'birdeye'
);
check(
  'classifies Nansen',
  classifyCreditsProvider('https://api.nansen.ai/api/v1/smart-money/dex-trades') === 'nansen'
);
check(
  'classifies Solana Tracker',
  classifyCreditsProvider('https://data.solanatracker.io/tokens/graduating') === 'solanatracker'
);
check(
  'DexScreener is other',
  classifyCreditsProvider('https://api.dexscreener.com/latest/dex/tokens/x') === 'other'
);
check(
  'redacts api-key',
  !redactCreditsEndpoint('https://mainnet.helius-rpc.com/?api-key=supersecret').includes(
    'supersecret'
  )
);

__resetCreditsGuardForTests();
check('not skipped initially', shouldSkipCreditsProvider('solanatracker') === false);
const first = noteCreditsExhausted(
  'tracker-graduating',
  'solanatracker',
  'https://data.solanatracker.io/tokens/graduating'
);
check('first exhausted logs', first === true);
check('provider now skipped', shouldSkipCreditsProvider('solanatracker') === true);
check(
  'other providers not skipped',
  shouldSkipCreditsProvider('helius') === false &&
    shouldSkipCreditsProvider('birdeye') === false
);
const second = noteCreditsExhausted(
  'tracker-graduating',
  'solanatracker',
  'https://data.solanatracker.io/tokens/multi/graduating'
);
check('second exhausted log suppressed (60s)', second === false);
check(
  'new source still logs once',
  noteCreditsExhausted(
    'leaderboard:axiom',
    'solanatracker',
    'https://data.solanatracker.io/v2/pnl/leaderboard/top'
  ) === true
);
check(
  'concurrent sources do not escalate backoff',
  getCreditsGuardStatus().sources.some(
    (s) => s.source === 'solanatracker' && s.backoffMs <= 25_000
  )
);

logCreditsRequest(
  'tracker-graduating',
  'solanatracker',
  'https://data.solanatracker.io/tokens/graduating'
);

const loggerSrc = readSrc('src/logger.ts');
check(
  'loggedFetch skips credit providers in backoff',
  /shouldSkipCreditsProvider\(provider\)/.test(loggerSrc) &&
    /creditsBackoffResponse\(/.test(loggerSrc)
);
check(
  'loggedFetch suppresses body: on credits',
  /creditsHit/.test(loggerSrc) && /noteCreditsExhausted/.test(loggerSrc)
);

const gradSrc = readSrc('src/graduatingFeed.ts');
check(
  'graduating probe stops after credits',
  /shouldSkipCreditsProvider\('solanatracker'\)/.test(gradSrc)
);
check(
  'graduating still has 3 URL fallbacks',
  /tokens\/graduating/.test(gradSrc) &&
    /tokens\/multi\/graduating/.test(gradSrc) &&
    /search\?query=graduating/.test(gradSrc)
);

const connSrc = readSrc('src/connection.ts');
check(
  'Helius credits treated as rate limit',
  /insufficient credits/.test(connSrc)
);
check(
  'meteredFetch peeks Helius error body',
  /noteCreditsExhausted\(source, 'helius'/.test(connSrc)
);
check(
  'exit/send not skipped on Helius credits backoff',
  /!isExitRpcFeature\(feature\)/.test(connSrc) &&
    /shouldSkipCreditsProvider\('helius'\)/.test(connSrc)
);

const birdeyeSrc = readSrc('src/birdeye.ts');
check(
  'birdeye does not retry credits',
  /isCreditsGuardResponse/.test(birdeyeSrc) &&
    /HTTP \$\{res.status\} credits/.test(birdeyeSrc)
);

const nansenSrc = readSrc('src/nansen.ts');
check('nansenPost wired to credits guard', /noteCreditsExhausted\('nansenPost'/.test(nansenSrc));

const holdingsSrc = readSrc('src/influencerMirrorRuntime.ts');
check(
  'holdings uses withRpc utility (failover, not lane merge)',
  /withRpc\(/.test(holdingsSrc) && /mirror_holdings/.test(holdingsSrc)
);

check(
  'creditsBackoffResponse marked',
  isCreditsGuardResponse(
    new Response('{}', { status: 429, headers: { 'x-credits-guard': '1' } })
  )
);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll credits-guard smoke checks passed');
