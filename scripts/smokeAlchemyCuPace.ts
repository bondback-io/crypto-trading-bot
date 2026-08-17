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
  'scanner capacity labels',
  isAlchemyScannerCapacityLabel('alchemy') &&
    isAlchemyScannerCapacityLabel('alchemy-backup3') &&
    !isAlchemyScannerCapacityLabel('alchemy-backup') &&
    !isAlchemyScannerCapacityLabel('alchemy-backup2')
);

check(
  'share-on migration is scanners not Trading',
  getRpcRoleFor('migration', true) === 'secondary'
);
check(
  'share-off migration stays primary (skip when busy)',
  getRpcRoleFor('migration', false) === 'primary'
);
check(
  'exits stay primary on share-on',
  getRpcRoleFor('trade_exit', true) === 'primary' &&
    getRpcRoleFor('send_tx', true) === 'primary'
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
  'migration pauses only when all scanner keys cool',
  /allScannerAlchemyKeysCooling/.test(mig)
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
  /pickNextAlchemyScannerUrl/.test(conn)
);
check(
  'alchemyPace exposed in getRpcStats',
  /alchemyPace:\s*getAlchemyPaceStatus/.test(conn)
);

const rpcUrl = readSrc('src/rpcUrl.ts');
check(
  'BACKUP3 builder + discovery present',
  /buildAlchemyBackup3RpcUrl/.test(rpcUrl) &&
    /listAlchemyApiKeysFromEnv/.test(rpcUrl) &&
    /ALCHEMY_API_KEY_BACKUP3/.test(rpcUrl)
);
check(
  'alchemy_key_429 log format',
  /alchemy_key_429/.test(readSrc('src/rpcProviderPace.ts'))
);

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
