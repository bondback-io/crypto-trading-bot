/**
 * Smoke: Alchemy per-key CU/s pace + BACKUP3 scanner capacity.
 * Run: npx tsx scripts/smokeAlchemyCuPace.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  __resetAlchemyPaceForTests,
  acquireAlchemyPaceSlot,
  allScannerAlchemyKeysCooling,
  alchemyCooldownRemainingMs,
  getAlchemyPaceStatus,
  isAlchemyCuLimitMessage,
  isAlchemyRpcUrl,
  noteAlchemyCuLimit,
  pickNextAlchemyScannerUrl,
  shouldSkipAlchemyRpc,
} from '../src/rpcProviderPace';
import {
  buildAlchemyBackup3RpcUrl,
  isAlchemyScannerCapacityLabel,
  listAlchemyApiKeysFromEnv,
} from '../src/rpcUrl';
import { getRpcRoleFor } from '../src/rpcRouting';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

__resetAlchemyPaceForTests();

check(
  'detects Alchemy CU/s JSON',
  isAlchemyCuLimitMessage(
    '429 Too Many Requests: Your app has exceeded its compute units per second capacity'
  )
);
check(
  'ignores generic timeout',
  isAlchemyCuLimitMessage('fetch failed') === false
);
check(
  'classifies Alchemy URL',
  isAlchemyRpcUrl('https://solana-mainnet.g.alchemy.com/v2/abc') === true
);
check(
  'Helius is not Alchemy',
  isAlchemyRpcUrl('https://mainnet.helius-rpc.com/?api-key=x') === false
);

const urlA = 'https://solana-mainnet.g.alchemy.com/v2/keyAAAA1111';
const urlB = 'https://solana-mainnet.g.alchemy.com/v2/keyBBBB2222';

check('no skip initially', shouldSkipAlchemyRpc('market_scanner', urlA) === false);
noteAlchemyCuLimit(urlA);
check('skip after CU limit on A', shouldSkipAlchemyRpc('market_scanner', urlA) === true);
check(
  'B still allowed after A 429',
  shouldSkipAlchemyRpc('market_scanner', urlB) === false
);
check('exit/send not skipped', shouldSkipAlchemyRpc('trade_exit', urlA) === false);
check('cooldown in 15–60s on A', (() => {
  const st = getAlchemyPaceStatus();
  const a = st.keys.find((k) => !k.healthy);
  return a != null && a.cooldownMs >= 14_000 && a.cooldownMs <= 60_000;
})());
const firstCool = alchemyCooldownRemainingMs();
noteAlchemyCuLimit(urlA);
check(
  'repeat CU note does not stack cooldown',
  alchemyCooldownRemainingMs() <= firstCool + 80
);
check(
  'not all scanner keys cooling while B healthy',
  allScannerAlchemyKeysCooling() === false
);

__resetAlchemyPaceForTests();
const slots = Array.from({ length: 5 }, () =>
  acquireAlchemyPaceSlot('market_scanner', urlA)
);
check(
  'per-key in-flight cap 4',
  slots.slice(0, 4).every((s) => s.allowed) && slots[4].allowed === false
);
slots.forEach((s) => s.release());

const slotB = acquireAlchemyPaceSlot('market_scanner', urlB);
check('other key not blocked by A in-flight', slotB.allowed === true);
slotB.release();

__resetAlchemyPaceForTests();
noteAlchemyCuLimit(urlA);
const next = pickNextAlchemyScannerUrl([urlA, urlB]);
check('pickNext prefers non-cooling B', next === urlB, String(next));
check(
  'scanner capacity labels include all alchemy-backup*',
  isAlchemyScannerCapacityLabel('alchemy') &&
    isAlchemyScannerCapacityLabel('alchemy-backup') &&
    isAlchemyScannerCapacityLabel('alchemy-backup2') &&
    isAlchemyScannerCapacityLabel('alchemy-backup3') &&
    isAlchemyScannerCapacityLabel('alchemy-backup7')
);

check(
  'migration gate role is secondary (exclusive BACKUP5)',
  getRpcRoleFor('migration', true) === 'secondary' &&
    getRpcRoleFor('migration', false) === 'secondary'
);
check(
  'trading stays primary gate on share-on',
  getRpcRoleFor('trade_exit', true) === 'primary' &&
    getRpcRoleFor('send_tx', true) === 'primary' &&
    getRpcRoleFor('trade_entry', true) === 'primary'
);
check(
  'favourites utility / watches watchers / activity utility',
  getRpcRoleFor('wallet_poll', true) === 'utility' &&
    getRpcRoleFor('setup_watch', true) === 'watchers' &&
    getRpcRoleFor('activity', true) === 'utility' &&
    getRpcRoleFor('signal_safety', true) === 'secondary'
);

const gate = readSrc('src/rpcGate.ts');
const critBlock = gate.slice(
  gate.indexOf('const CRITICAL_FEATURES'),
  gate.indexOf('function envInt')
);
check(
  'migration is not a critical gate feature',
  critBlock.includes('trade_exit') && !critBlock.includes("'migration'")
);
check(
  'secondary default rps restored (not 4)',
  /RPC_LANE_RPS_SECONDARY',\s*6/.test(gate) &&
    !/RPC_LANE_RPS_SECONDARY',\s*4/.test(gate)
);

const mig = readSrc('src/migrationListener.ts');
check(
  'migration poll uses resolveMigrationRpcRole',
  /resolveMigrationRpcRole\(/.test(mig)
);
check(
  'gate skip is not console.error',
  /noteMigrationBusySkip/.test(mig) &&
    /poll skipped \(lane busy\)/.test(mig)
);
check(
  'migration busy skip uses console.log (stdout)',
  /console\.log\(/.test(mig) &&
    /poll skipped \(lane busy\)/.test(mig) &&
    /expected skip/.test(mig) &&
    !/not an error/.test(mig) &&
    !/console\.warn\(\s*\n?\s*`\[migration\] poll skipped/.test(mig)
);
check(
  'migration pauses only when all scanner keys cool',
  /allScannerAlchemyKeysCooling/.test(mig)
);
check(
  'armRateLimitBackoff passes Alchemy URL',
  /noteAlchemyCuLimit\(url\)/.test(mig)
);

const conn = readSrc('src/connection.ts');
check(
  'withRpc stops after 2 rate-limit hits',
  /rateLimitHits >= 2/.test(conn)
);
check(
  'cooldown skip throws RpcGateSkipError not fake 429',
  /shouldSkipAlchemyRpc\(feature/.test(conn) &&
    /RpcGateSkipError/.test(conn) &&
    !/throw new Error\(\s*'429 Too Many Requests: compute units per second capacity'/.test(
      conn
    )
);
check(
  'scanner interval is not stretched to cooldown+5s',
  !/cool \+ 5_000/.test(readSrc('src/rpcLoadControl.ts'))
);
check(
  'serial scanner Alchemy pick in withRpc',
  /RPC_EMERGENCY_LABELS/.test(conn) &&
    /resolveExclusiveServiceIndex/.test(conn)
);
check(
  'withRpc soft-fails without logger.error',
  /soft fail \$\{label\}/.test(conn) ||
    (/\[rpc\] soft fail/.test(conn) && /console\.log\(/.test(conn))
);
check(
  'soft fail does not require !critical',
  /!exitSend &&\s*\(isRpcSoftFailureMessage/.test(conn) ||
    (!/!exitSend &&\s*!critical &&/.test(conn) &&
      /isRpcSoftFailureMessage\(failMsg\)/.test(conn))
);
check(
  'soft fail uses console.log stdout',
  /console\.log\(\s*\n?\s*`\[rpc\] soft fail/.test(conn) ||
    /console\.log\(\s*\n?\s*'\[rpc\] soft fail/.test(conn) ||
    (/\[rpc\] soft fail/.test(conn) &&
      conn.includes('console.log') &&
      !/logger\.warn\('RPC', `\$\{label\} soft fail/.test(conn))
);
check(
  'soft blocked classifier exported',
  /export function isRpcSoftBlockedMessage/.test(conn)
);
check(
  'exit-send still logger.error on hard fail',
  /logger\.error\('RPC', `\$\{label\} all endpoints failed`/.test(conn)
);
check(
  'isRpcSoftFailureError + logSoftRpcFailure exported',
  /export function isRpcSoftFailureError/.test(conn) &&
    /export function logSoftRpcFailure/.test(conn) &&
    /formatSoftRpcFailBrief/.test(conn) &&
    /console\.log\(`\[\$\{tag\}\] soft RPC fail/.test(conn)
);
check(
  'soft fail brief has no JSON error substring',
  /export function formatSoftRpcFailBrief/.test(conn) &&
    /429 CU\/s capacity/.test(conn) &&
    /403 soft blocked/.test(conn) &&
    !/formatSoftRpcFailBrief[\s\S]{0,800}msg\.slice\(0,\s*180\)/.test(conn)
);
check(
  'secondary exclusive resolve never piggybacks other exclusives',
  /resolveExclusiveServiceIndex/.test(conn) &&
    /RPC_EMERGENCY_LABELS/.test(conn) &&
    /never another exclusive/.test(conn)
);

const scanner = readSrc('src/marketScanner.ts');
check(
  'MarketScanner soft-catches Poll failed',
  /isRpcSoftFailureError\(err\)[\s\S]{0,80}logSoftRpcFailure\('MarketScanner'[\s\S]{0,200}'Poll failed'/.test(
    scanner
  ) ||
    /'Poll failed'[\s\S]{0,200}isRpcSoftFailureError\(err\)[\s\S]{0,80}logSoftRpcFailure\('MarketScanner'/.test(
      scanner
    )
);
check(
  'MarketScanner Poll failed still warns hard errors',
  /else \{\s*logger\.warn\(\s*'MarketScanner',\s*'Poll failed'/.test(scanner)
);

const alpha = readSrc('src/alphaScanFeed.ts');
check(
  'AlphaScan soft-catches Feed pass failed',
  /isRpcSoftFailureError\(err\)/.test(alpha) &&
    /logSoftRpcFailure\('AlphaScan'/.test(alpha)
);

const zion = readSrc('src/zionKolScanner.ts');
check(
  'ZionScanner soft-catches Poll failed',
  /isRpcSoftFailureError\(err\)/.test(zion) &&
    /logSoftRpcFailure\('ZionScanner'/.test(zion)
);

const indexSrc = readSrc('src/index.ts');
check(
  'unhandledRejection soft RPC → stdout helper',
  /isRpcSoftFailureError\(reason\)/.test(indexSrc) &&
    /logSoftRpcFailure\('boot'/.test(indexSrc)
);

const loggerSrc = readSrc('src/logger.ts');
check(
  'errorToMeta optional stack:false',
  /opts\?: \{ stack\?: boolean \}/.test(loggerSrc) &&
    /withStack = opts\?\.stack !== false/.test(loggerSrc)
);
check(
  'logger.warn mirrors to console.log stdout',
  /entry\.level === 'warn'/.test(loggerSrc) &&
    /\/\/ stdout — Node console\.warn is stderr/.test(loggerSrc) &&
    /if \(extra\) console\.log\(prefix, extra\);/.test(loggerSrc) &&
    !/entry\.level === 'warn'[\s\S]{0,120}console\.warn\(prefix/.test(loggerSrc)
);

check(
  'MarketScanner soft-catches Candidate handler failed',
  /Candidate handler failed[\s\S]{0,200}isRpcSoftFailureError\(err\)/.test(
    scanner
  ) ||
    /isRpcSoftFailureError\(err\)[\s\S]{0,120}Candidate handler failed/.test(
      scanner
    )
);

check(
  'Zion noteRpcRateLimit uses logSoftRpcFailure not errorToMeta',
  /function noteRpcRateLimit[\s\S]{0,400}logSoftRpcFailure\('ZionScanner'/.test(
    zion
  ) &&
    !/function noteRpcRateLimit[\s\S]{0,500}errorToMeta\(err\)/.test(zion)
);
check(
  'Zion isRpcRateLimitError delegates to soft failure',
  /function isRpcRateLimitError[\s\S]{0,80}isRpcSoftFailureError\(err\)/.test(
    zion
  )
);

const rpcUrl = readSrc('src/rpcUrl.ts');
check(
  'BACKUP3 builder + discovery present',
  /buildAlchemyBackup3RpcUrl/.test(rpcUrl) &&
    /listAlchemyApiKeysFromEnv/.test(rpcUrl) &&
    /ALCHEMY_API_KEY_BACKUP3/.test(rpcUrl)
);
check(
  'exclusive service map BACKUP4–7 + PUBLICNODE (utility → PUBLICNODE)',
  /alchemy-backup4/.test(rpcUrl) &&
    /alchemy-backup7/.test(rpcUrl) &&
    /resolvePublicnodeRpcUrl/.test(rpcUrl) &&
    /Exclusive multi-RPC chain/.test(rpcUrl) &&
    /utility_light[\s\S]*?envKey: 'PUBLICNODE_URL'/.test(
      readSrc('src/rpcServiceMap.ts')
    )
);
check(
  'rpcServiceMap locks Trading to ALCHEMY_API_KEY',
  (() => {
    const m = readSrc('src/rpcServiceMap.ts');
    return (
      /trading_critical[\s\S]*ALCHEMY_API_KEY/.test(m) &&
      /favourites_watch[\s\S]*ALCHEMY_API_KEY_BACKUP'/.test(m) &&
      /setup_watch[\s\S]*BACKUP2/.test(m) &&
      /zion[\s\S]*BACKUP4/.test(m) &&
      /RPC_EMERGENCY_LABELS/.test(m)
    );
  })()
);
check(
  'utility exclusive map uses PUBLICNODE_URL (not RPC_URL preferred)',
  (() => {
    const m = readSrc('src/rpcServiceMap.ts');
    const block =
      /service: 'utility_light',\s*label: 'publicnode',\s*envKey: 'PUBLICNODE_URL'/.test(
        m
      );
    return block && !/service: 'utility_light',\s*label: 'rpc-url'/.test(m);
  })()
);
check(
  'utility_light latency failover between publicnode and rpc-url',
  /pickUtilityLightLatencyAlternate/.test(readSrc('src/connection.ts')) &&
    /utility_light latency failover/.test(readSrc('src/connection.ts'))
);
check(
  'mirror holdings timeout + utility spike shed',
  /HOLDINGS_TIMEOUT_MS/.test(readSrc('src/influencerMirrorRuntime.ts')) &&
    /isLaneSpiking\('utility'\)/.test(readSrc('src/influencerMirrorRuntime.ts'))
);
check(
  'alchemy_key_429 log format',
  /alchemy_key_429/.test(readSrc('src/rpcProviderPace.ts'))
);

// Runtime: formatSoftRpcFailBrief never embeds "error" / JSON
{
  const { formatSoftRpcFailBrief } = require('../src/connection') as typeof import('../src/connection');
  const brief = formatSoftRpcFailBrief(
    new Error(
      '429 Too Many Requests: {"jsonrpc":"2.0","error":{"code":429,"message":"compute units per second capacity"}}'
    )
  );
  check(
    'formatSoftRpcFailBrief strips Alchemy JSON',
    brief === '429 CU/s capacity' && !/"error"/.test(brief) && !/\{/.test(brief)
  );
  const brief503 = formatSoftRpcFailBrief(
    new Error(
      '503 Service Unavailable: {"jsonrpc":"2.0","error":{"code":-32001,"message":"Unable to complete request at this time."}}'
    )
  );
  check(
    'formatSoftRpcFailBrief 503 provider unavailable',
    brief503 === '503 provider unavailable' && !/"error"/.test(brief503)
  );
  check(
    'tokenMetrics sticky 503 cooldown for largest accounts',
    /LARGEST_ACCOUNTS_COOLDOWN_MS/.test(readSrc('src/tokenMetrics.ts')) &&
      /isRpcProviderUnavailableMessage/.test(readSrc('src/tokenMetrics.ts'))
  );
}

// Env discovery (may be empty in CI)
const keys = listAlchemyApiKeysFromEnv();
const b3 = buildAlchemyBackup3RpcUrl();
if (process.env.ALCHEMY_API_KEY_BACKUP3?.trim()) {
  check('BACKUP3 URL when env set', Boolean(b3), String(b3));
  check(
    'BACKUP3 in discovered keys',
    keys.some((k) => k.env === 'ALCHEMY_API_KEY_BACKUP3' || k.label === 'alchemy-backup3')
  );
} else {
  check('BACKUP3 unset → null URL', b3 == null);
  console.log('INFO BACKUP3 not in env — discovery checked empty path');
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll alchemy CU pace smoke checks passed');
console.log(
  `Alchemy keys from env: ${keys.length}` +
    (keys.length
      ? ` [${keys.map((k) => `${k.label}:${k.role}`).join(', ')}]`
      : '')
);
