/**
 * Smoke: RPC Spike Inspector + containment (1.2.378).
 * Run: npx tsx scripts/smokeRpcSpikeInspector.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config';
import {
  __resetRpcSpikeInspectorForTests,
  buildRpcSpikeDiagnosis,
  getSpikeInspectorSnapshot,
  isLaneSpiking,
  noteRpcCall,
  shouldSoftPauseNewEntries,
  withRpcAttemptCap,
} from '../src/rpcSpikeInspector';
import {
  isRpcWorkloadEnabled,
  shouldIdleIsolate,
} from '../src/rpcWorkloadControl';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

const prevContainment = config.rpc.containmentEnabled;
config.rpc.containmentEnabled = true;
__resetRpcSpikeInspectorForTests();

noteRpcCall({
  lane: 'watchers',
  provider: 'https://solana-mainnet.g.alchemy.com/v2/SECRETKEY',
  method: 'getAccountInfo',
  queueWaitMs: 12,
  networkMs: 1800,
  totalMs: 1812,
  outcome: 'success',
  inFlight: 3,
});

check(
  'watchers hard call starts spike',
  isLaneSpiking('watchers'),
  `status=${getSpikeInspectorSnapshot().watchers.status}`
);
check(
  'watchers spike does not pause Trading entries',
  shouldSoftPauseNewEntries() === false
);
check(
  'watchers spike idles isolate / sheds enrich',
  shouldIdleIsolate() === true && isRpcWorkloadEnabled('dip_setup_watch') === false
);
check(
  'watchers spike does not cap Trading retries',
  withRpcAttemptCap(true, 4) === 4 && withRpcAttemptCap(false, 3) === 3
);

const snap1 = getSpikeInspectorSnapshot();
check(
  'provider labels never leak URLs',
  snap1.watchers.provider === 'Alchemy' ||
    snap1.watchers.provider === 'Alchemy-backup' ||
    snap1.spikes.every((s) => !/^https?:/i.test(s.provider)),
  snap1.watchers.provider
);

noteRpcCall({
  lane: 'primary',
  provider: 'Helius',
  method: 'sendTransaction',
  queueWaitMs: 20,
  networkMs: 2100,
  totalMs: 2120,
  outcome: 'timeout',
  inFlight: 5,
});

check('trading hard call starts spike', isLaneSpiking('primary'));
check(
  'trading spike soft-pauses new entries only',
  shouldSoftPauseNewEntries() === true
);
check(
  'trading spike retry cap 1–2',
  withRpcAttemptCap(true, 4) === 2 && withRpcAttemptCap(false, 3) === 1
);
check(
  'watchers isolate still independent of trading spike',
  shouldIdleIsolate() === true
);

const before = JSON.stringify(getSpikeInspectorSnapshot());
const diag1 = buildRpcSpikeDiagnosis();
const after = JSON.stringify(getSpikeInspectorSnapshot());
const diag2 = buildRpcSpikeDiagnosis();
check('diagnosis GET is side-effect free', before === after);
check(
  'diagnosis includes Cursor preamble',
  diag1.cursorPackage.startsWith('Plan mode only first.') &&
    diag1.cursorPackage.includes('# RPC Spike Diagnosis')
);
check(
  'diagnosis has no secret URLs',
  !/https?:\/\/[^\s]*api[_-]?key/i.test(diag1.reportText) &&
    !/SECRETKEY/i.test(diag1.reportText)
);
check(
  'second diagnosis is stable',
  diag2.reportText.includes('Last 10 spikes') &&
    diag2.cursorPackage.includes(diag1.reportText.slice(0, 40))
);

config.rpc.containmentEnabled = false;
check(
  'containment OFF still records spikes but does not pause/shed',
  isLaneSpiking('primary') &&
    shouldSoftPauseNewEntries() === false &&
    shouldIdleIsolate() === false &&
    isRpcWorkloadEnabled('dip_setup_watch') === true
);
config.rpc.containmentEnabled = true;

const tradeSrc = readSrc('src/trade.ts');
check(
  'executeSell wraps live path on primary send_tx',
  /export async function executeSell[\s\S]*runWithRpcRole\(\s*'primary'[\s\S]{0,180}'send_tx'/.test(
    tradeSrc
  )
);
check(
  'executeSell paper path stays local before wrap',
  /export async function executeSell[\s\S]*usesPaperAccounting\(\)[\s\S]*simulateSell[\s\S]*hasRpcRoleContext/.test(
    tradeSrc
  )
);
check(
  'executeBuy pauses entries; executeSell does not',
  /shouldSoftPauseNewEntries/.test(tradeSrc) &&
    !/export async function executeSell[\s\S]*shouldSoftPauseNewEntries/.test(
      tradeSrc
    )
);

const dashSrc = readSrc('src/dashboard.ts');
check(
  'Spike Inspector lives on Stats → RPC panel',
  dashSrc.includes('id="botperf-panel-rpc"') &&
    dashSrc.includes('id="rpc-spike-inspector"') &&
    dashSrc.includes('id="rpc-spike-viewer"')
);
check(
  'diagnosis is generate/copy on-screen, not download-primary',
  dashSrc.includes('generateRpcSpikeDiagnosis') &&
    dashSrc.includes('copyRpcSpikeDiagnosis') &&
    !/rpc-spike[\s\S]{0,400}download/i.test(dashSrc)
);

const serverSrc = readSrc('src/server.ts');
check(
  'GET /api/rpc/spike-diagnosis is read-only',
  /app\.get\('\/api\/rpc\/spike-diagnosis'/.test(serverSrc) &&
    /buildRpcSpikeDiagnosis/.test(serverSrc)
);

const gateSrc = readSrc('src/rpcGate.ts');
check(
  'watchers counted in runDedupedRpcJob',
  /roleHint === 'watchers'/.test(gateSrc)
);
check(
  'acquireRpcLane returns queueWaitMs',
  /queueWaitMs: Math\.max\(0, Date\.now\(\) - waitStartedAt\)/.test(gateSrc)
);

__resetRpcSpikeInspectorForTests();
config.rpc.containmentEnabled = prevContainment;

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll RPC spike inspector smoke checks passed.');
