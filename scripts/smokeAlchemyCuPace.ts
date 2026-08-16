/**
 * Smoke: Alchemy CU/s pace + migration not treated as Trading-critical.
 * Run: npx tsx scripts/smokeAlchemyCuPace.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  __resetAlchemyPaceForTests,
  acquireAlchemyPaceSlot,
  alchemyCooldownRemainingMs,
  isAlchemyCuLimitMessage,
  isAlchemyRpcUrl,
  noteAlchemyCuLimit,
  shouldSkipAlchemyRpc,
} from '../src/rpcProviderPace';
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

check('no skip initially', shouldSkipAlchemyRpc('market_scanner') === false);
noteAlchemyCuLimit('https://solana-mainnet.g.alchemy.com/v2/secret');
check('skip after CU limit', shouldSkipAlchemyRpc('market_scanner') === true);
check('exit/send not skipped', shouldSkipAlchemyRpc('trade_exit') === false);
check('cooldown in 15–60s', (() => {
  const ms = alchemyCooldownRemainingMs();
  return ms >= 14_000 && ms <= 60_000;
})());

__resetAlchemyPaceForTests();
const a = acquireAlchemyPaceSlot('market_scanner');
const b = acquireAlchemyPaceSlot('market_scanner');
const c = acquireAlchemyPaceSlot('market_scanner');
check('first pace slot allowed', a.allowed === true);
check('in-flight cap 2', b.allowed === true && c.allowed === false);
a.release();
b.release();

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
  'secondary default rps lowered',
  /RPC_LANE_RPS_SECONDARY',\s*4/.test(gate)
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

const conn = readSrc('src/connection.ts');
check(
  'withRpc stops after 2 rate-limit hits',
  /rateLimitHits >= 2/.test(conn)
);
check(
  'compute units treated as rate limit',
  /compute units per second/.test(conn)
);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll alchemy CU pace smoke checks passed');
