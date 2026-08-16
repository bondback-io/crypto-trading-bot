/**
 * Smoke: watch/arm selectivity 1.2.381 — Mode B owns $150k–Dip min,
 * MS setup uses runtime max MC, late-chase and Scalper disc stay blocked.
 * Run: npx tsx scripts/smokeWatchArmSelectivity.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  evaluateMsSetup,
  getDipBuyerMcBand,
  getMigrationSniperMaxMcUsd,
  getScalperMcBand,
  remapPreferredToMcBandOwner,
  resolveMcBandOwner,
  resolveTop10SoftAllow,
  resolveTradeProfileDefinition,
} from '../src/tradeProfiles';
import { shouldSoftSkipUnarmedScalperHabit } from '../src/profileAttention';
import { ARMED_LATE_CHASE_BLOCK } from '../src/profileWatchRegistry';
import { noteNoneMcGap, getConversionDiagnostics } from '../src/watchPipeline';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

const scalper = getScalperMcBand();
const dip = getDipBuyerMcBand();
const msMax = getMigrationSniperMaxMcUsd();

check('Dip catalog min stays $1M', dip.min >= 1_000_000, `min=${dip.min}`);
check(
  'Scalper band covers $150k–$1M',
  scalper.min <= 150_000 && scalper.max >= 1_000_000,
  `${scalper.min}-${scalper.max}`
);

const owner400 = resolveMcBandOwner(400_000);
check(
  '$400k owner is scalper (Mode B), not none/Dip',
  owner400.primary === 'scalper',
  owner400.primary
);
check(
  '$400k preferred Dip remaps to Scalper',
  remapPreferredToMcBandOwner('dip_buyer', 400_000) === 'scalper'
);
check(
  '$2M preferred Dip stays Dip',
  remapPreferredToMcBandOwner('dip_buyer', 2_000_000) === 'dip_buyer'
);

const tagged120 = evaluateMsSetup({
  nearMigration: true,
  scannerCategories: ['graduating'],
  scannerSources: ['graduating_feed'],
  marketCapUsd: 120_000,
});
check(
  'tagged graduating $120k without rules is watch, not buy',
  tagged120.watchOk === true &&
    tagged120.buyOk === false &&
    tagged120.reason.startsWith('ms_setup_stage_low'),
  `${tagged120.reason} (msMax=${msMax})`
);
check(
  'evaluateMsSetup default max is runtime MS max, not $100k',
  msMax > 100_000 && 120_000 <= msMax,
  `msMax=${msMax}`
);

const lateMs = evaluateMsSetup({
  nearMigration: true,
  scannerCategories: ['graduating'],
  marketCapUsd: 50_000,
  detectedEntryStyle: 'late_chase',
});
check(
  'MS late_chase still blocks watch and buy',
  lateMs.watchOk === false &&
    lateMs.buyOk === false &&
    lateMs.reason === 'ms_late_chase'
);

const disc = shouldSoftSkipUnarmedScalperHabit({
  profileId: 'scalper',
  armedWatch: false,
  nearSupport: false,
  volumeDecayState: 'stable',
});
check(
  'unarmed Scalper still prefer-armed disc skip',
  disc.skip === true && /scalper_discretionary_skipped/i.test(disc.reason),
  disc.reason
);
check(
  'armed Scalper does not disc-skip',
  shouldSoftSkipUnarmedScalperHabit({
    profileId: 'scalper',
    armedWatch: true,
    nearSupport: true,
    volumeDecayState: 'expanding',
  }).skip === false
);

const hwrDef = resolveTradeProfileDefinition('high_win_rate');
const hwrFib = resolveTop10SoftAllow(
  hwrDef,
  { marketCapUsd: 90_000_000, nearKeyFib: true },
  40,
  32
);
check(
  'HWR age_unknown + Fib substitute grants',
  hwrFib.allow === true &&
    hwrFib.grantTag === 'top10_soft_allow_age_unknown_quality_pass',
  hwrFib.detail
);
const hwrEmpty = resolveTop10SoftAllow(
  hwrDef,
  { marketCapUsd: 90_000_000 },
  40,
  32
);
check(
  'HWR age_unknown with no quality still denies',
  hwrEmpty.allow === false && hwrEmpty.rejectKey === 'age_unknown_fallback'
);

noteNoneMcGap(400_000, 'GapMint111111', {
  classifier: 'unknown',
  rejects: [{ profileId: 'scalper', reason: 'modeb_park_failed' }],
});
const diag = getConversionDiagnostics();
check(
  'none_mc_gap_count records mid-band examples',
  diag.none_mc_gap_count >= 1 &&
    Array.isArray(diag.none_mc_gap_examples) &&
    diag.none_mc_gap_examples[0]?.mint === 'GapMint11111',
  String(diag.none_mc_gap_count)
);
check(
  'resolved Steady minHolders is catalog 80 not 2000',
  Number(diag.resolved_min_holders.steady_compounder) === 80
);
check(
  'fake-holder velocity max 15m is 2000 (anti-rug max, not min)',
  Number(diag.fake_holder_velocity_max_15m) === 2000
);

const monitorSrc = readSrc('src/monitor.ts');
check(
  'fight-none always tries Mode B park in Scalper band',
  /tryParkModeBFromFight/.test(monitorSrc) &&
    /modeBOwner && inScalperBand/.test(monitorSrc)
);
check(
  'restricted Dip below catalog min parks Mode B',
  /gov_dip_disc_blocked[\s\S]{0,900}mcPark < dipMin/.test(monitorSrc)
);
check(
  'late-chase armed block constant unchanged',
  ARMED_LATE_CHASE_BLOCK === 'armed_late_chase_blocked'
);

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll 1.2.381 watch/arm selectivity smoke checks passed.');
