/**
 * Smoke: 1.2.385 Micro Bot MC bands + arm pipeline.
 * Overlay >0 is the only band; empty uses catalog. No Dip MC ease / Scalper-max pull.
 * Run: npx tsx scripts/smokeMcBandArmPipeline.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config';
import {
  evaluateLaneEntryFloors,
  getEffectiveMcBand,
  getTradeProfilesStatus,
  remapPreferredToMcBandOwner,
  resolveMcBandOwner,
  resolveTradeProfileDefinition,
} from '../src/tradeProfiles';
import { shouldSoftSkipUnarmedScalperHabit } from '../src/profileAttention';
import {
  canTriggerArmed,
  formatArmingParkFailedReason,
} from '../src/profileWatchRegistry';
import {
  getLastScalperAdmitReject,
  isMcInScalperWatchBand,
  offerScalperWatchFromCandidate,
} from '../src/scalperSetupWatch';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

type OverlayState = {
  overrides?: Record<string, { match?: Record<string, unknown> }>;
};

function tpState(): OverlayState {
  return (config as { tradeProfiles: OverlayState }).tradeProfiles;
}

const overlaySnap = JSON.parse(
  JSON.stringify(tpState().overrides || {})
) as OverlayState['overrides'];

function setMcOverlay(
  id: string,
  match: { minMarketCapUsd?: number; maxMarketCapUsd?: number }
): void {
  const tp = tpState();
  if (!tp.overrides) tp.overrides = {};
  const prev = tp.overrides[id] || {};
  tp.overrides[id] = {
    ...prev,
    match: { ...(prev.match || {}), ...match },
  };
}

function restoreOverlays(): void {
  tpState().overrides = JSON.parse(JSON.stringify(overlaySnap || {}));
}

try {
  setMcOverlay('dip_buyer', {
    minMarketCapUsd: 500_000,
    maxMarketCapUsd: 20_000_000,
  });
  const dipOv = getEffectiveMcBand('dip_buyer');
  check(
    'overlay Dip min 500k is micro_bot 500000',
    dipOv.min === 500_000 && dipOv.source === 'micro_bot' && dipOv.minSource === 'micro_bot',
    JSON.stringify(dipOv)
  );
  const statusBand = getTradeProfilesStatus().effectiveBand.dip_buyer;
  check(
    'status.effectiveBand.dip.min === card min',
    statusBand.min === 500_000 && statusBand.source === 'micro_bot',
    JSON.stringify(statusBand)
  );
  const dipDef = resolveTradeProfileDefinition('dip_buyer');
  const fight400 = evaluateLaneEntryFloors(dipDef, {
    marketCapUsd: 400_000,
    hmcSetup: 'dip',
    nearSupport: true,
  });
  check(
    'fight reject never cites 700k/800k',
    fight400.ok === false &&
      !/700\s*000|\$700k|800\s*000|\$800k/.test(fight400.reason || '') &&
      /\$500000/.test(fight400.reason || '') &&
      /micro_bot/.test(fight400.reason || ''),
    fight400.reason
  );
  const fight600 = evaluateLaneEntryFloors(dipDef, {
    marketCapUsd: 600_000,
    hmcSetup: 'dip',
  });
  check(
    'in-band Dip $600k is not remapped to Scalper',
    remapPreferredToMcBandOwner('dip_buyer', 600_000) === 'dip_buyer' &&
      fight600.ok !== false,
    `remap=${remapPreferredToMcBandOwner('dip_buyer', 600_000)} fight=${fight600.reason}`
  );

  setMcOverlay('dip_buyer', { minMarketCapUsd: 0, maxMarketCapUsd: 0 });
  const dipCat = getEffectiveMcBand('dip_buyer');
  check(
    'empty Dip min uses catalog 1M',
    dipCat.min === 1_000_000 && dipCat.source === 'catalog',
    JSON.stringify(dipCat)
  );

  setMcOverlay('scalper', {
    minMarketCapUsd: 150_000,
    maxMarketCapUsd: 1_500_000,
  });
  setMcOverlay('dip_buyer', {
    minMarketCapUsd: 500_000,
    maxMarketCapUsd: 20_000_000,
  });
  const scOv = getEffectiveMcBand('scalper');
  check(
    'overlay Scalper max 1.5M is micro_bot',
    scOv.max === 1_500_000 && scOv.source === 'micro_bot',
    JSON.stringify(scOv)
  );
  check(
    'watch admit $200k in Scalper overlay band',
    isMcInScalperWatchBand(200_000) === true
  );
  check(
    'watch admit $1.2M in Scalper overlay band',
    isMcInScalperWatchBand(1_200_000) === true
  );
  check(
    'watch reject $1.6M above Scalper overlay max',
    isMcInScalperWatchBand(1_600_000) === false
  );

  const dipDna = resolveMcBandOwner(800_000, {
    detectedEntryStyle: 'support_dip_reclaim',
    hmcSetup: 'dip',
  });
  check(
    'overlap DNA dip parks Dip',
    dipDna.primary === 'dip_buyer',
    dipDna.primary
  );
  const scDna = resolveMcBandOwner(800_000, {
    detectedEntryStyle: 'scalp_reclaim_burst',
    setupWatchFamily: 'mode_b',
  });
  check(
    'overlap DNA Mode B S/R parks Scalper',
    scDna.primary === 'scalper',
    scDna.primary
  );
  const noDna = resolveMcBandOwner(800_000);
  check(
    'overlap with no DNA is Scalper (Mode B), never none',
    noDna.primary === 'scalper',
    noDna.primary
  );

  const disc = shouldSoftSkipUnarmedScalperHabit({
    profileId: 'scalper',
    armedWatch: false,
    nearSupport: false,
    volumeDecayState: 'stable',
  });
  check(
    'disc skip still no immediate Scalper buy',
    disc.skip === true && /scalper_discretionary_skipped/i.test(disc.reason),
    disc.reason
  );

  offerScalperWatchFromCandidate({
    mint: 'SmokeMcBand1p6Mint111111111111111111111111111',
    symbol: 'SM16',
    marketCapUsd: 1_600_000,
    nearSupport: true,
  });
  const parkWhy = formatArmingParkFailedReason('scalper');
  check(
    'park failure string includes admit reason',
    /park failed/.test(parkWhy) &&
      (parkWhy.includes(getLastScalperAdmitReject()) ||
        /rejected_mc/.test(parkWhy)),
    parkWhy
  );

  const levelGate = canTriggerArmed({
    profileId: 'scalper',
    score: {
      toolsEvaluated: [],
      passedIds: [],
      confluenceCount: 0,
      hardLevelEvidence: false,
      lateChase: false,
    },
    watch: {
      status: 'armed',
      armed: true,
      nearSupport: true,
    },
  });
  check(
    'known level counts as ≥1 TA confluence (not have=0)',
    levelGate.ok === true ||
      (levelGate.score.confluenceCount >= 1 &&
        !/have 0/.test(levelGate.reason)),
    `${levelGate.ok} ${levelGate.reason} have=${levelGate.score.confluenceCount}`
  );
  const lateGate = canTriggerArmed({
    profileId: 'scalper',
    score: {
      toolsEvaluated: [],
      passedIds: [],
      confluenceCount: 0,
      hardLevelEvidence: true,
      lateChase: true,
    },
    watch: { status: 'armed', armed: true, nearSupport: true, lateChase: true },
  });
  check(
    'late_chase still blocks armed trigger',
    lateGate.ok === false && /late_chase/.test(lateGate.reason),
    lateGate.reason
  );

  const monitorSrc = readSrc('src/monitor.ts');
  check(
    'maybeParkArmingOpen uses precise park-failed reason',
    /formatArmingParkFailedReason/.test(monitorSrc)
  );
  const fightSrc = readSrc('src/tradeProfiles.ts');
  check(
    'Dip MC ease ×0.7 removed',
    !/minMarketCapUsd:\s*Math\.round\(baseMc \* 0\.7\)/.test(fightSrc)
  );
} finally {
  restoreOverlays();
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll 1.2.385 MC band / arm pipeline checks passed');
