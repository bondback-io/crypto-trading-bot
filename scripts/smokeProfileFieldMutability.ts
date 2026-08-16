/**
 * Smoke: Micro Bot param-field mutability icons (used / self-learn / ML).
 * Run: npx tsx scripts/smokeProfileFieldMutability.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  describeProfileFieldMutability,
  PROFILE_FIELD_MUTABILITY,
} from '../src/profileFieldMutability';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

const src = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

const dash = src('src/dashboard.ts');

check(
  'dashboard injects field mutability JSON',
  dash.includes('/*TP_FIELD_MUTABILITY_JSON*/') &&
    dash.includes('tpFieldFlagHtml') &&
    dash.includes('tpFieldLabel')
);
check(
  'numField and selectField use flag labels',
  dash.includes('tpFieldLabel(p.id, cfg.flagKey || cfg.key, cfg.label)')
);
check(
  'policy fields have flags',
  dash.includes("tpFieldLabel(p.id, 'profitLockArmPct'") &&
    dash.includes("tpFieldLabel(p.id, 'peakProtectArmOfTpPct'")
);
check(
  'legend explains the three icons',
  dash.includes('tp-field-legend') && dash.includes('self-learn / Level upgrades')
);

const frozen = [
  'takeProfitPctMin',
  'takeProfitPctMax',
  'stopLossPctMin',
  'stopLossPctMax',
  'watchEnabled',
  'armingEnabled',
  'minMarketCapUsd',
  'maxMarketCapUsd',
  'turboMode',
  'trailingStopPct',
  'kolscanFeedEnabled',
];
for (const key of frozen) {
  const d = describeProfileFieldMutability('scalper', key);
  check(`${key} is used and frozen`, d.used && !d.selfLearn && !d.mlSteer);
}

const learn = describeProfileFieldMutability('scalper', 'minConviction');
check(
  'min conviction is used + self-learn + ML steer',
  learn.used && learn.selfLearn && learn.mlSteer
);

const trail = describeProfileFieldMutability('trend_rider', 'trailingActivationProfit');
check(
  'trail arm is self-learn but not ML-led',
  trail.used && trail.selfLearn && !trail.mlSteer
);

const vol = describeProfileFieldMutability('scalper', 'minVolumeH1Usd');
check('min vol H1 unused on Scalper', !vol.used && !vol.selfLearn);

const volTrend = describeProfileFieldMutability('trend_rider', 'minVolumeH1Usd');
check('min vol H1 used on Trend, frozen', volTrend.used && !volTrend.selfLearn);

const qf = describeProfileFieldMutability('high_win_rate', 'qf.minHolders');
check('HWR quality min holders used and frozen', qf.used && !qf.selfLearn);

const qfScalp = describeProfileFieldMutability('scalper', 'qf.minHolders');
check('HWR quality min holders unused on Scalper', !qfScalp.used);

check(
  'catalog covers dashboard param keys',
  (() => {
    const keys = new Set<string>();
    const start = dash.indexOf('function renderTradeProfilesUi');
    const end = dash.indexOf('function saveTradeProfileParams');
    const chunk = dash.slice(start, end > start ? end : start + 80_000);
    const add = (re: RegExp, prefix = '') => {
      let m: RegExpExecArray | null;
      const r = new RegExp(re.source, 'g');
      while ((m = r.exec(chunk))) keys.add(prefix + m[1]);
    };
    add(/key: '([A-Za-z][A-Za-z0-9]*)'/);
    add(/data-policy="([A-Za-z][A-Za-z0-9]*)"/);
    add(/tpFieldLabel\(p\.id, '([A-Za-z][A-Za-z0-9.]*)'/);
    add(/tpFieldFlagHtml\(p\.id, '([A-Za-z][A-Za-z0-9.]*)'/);
    add(/data-qf="([A-Za-z][A-Za-z0-9]*)"/, 'qf.');
    const missing = [...keys].filter((k) => !PROFILE_FIELD_MUTABILITY[k]);
    if (missing.length) {
      console.log('  missing keys:', missing.join(', '));
    }
    if (keys.size <= 20) {
      console.log('  key count', keys.size, [...keys].slice(0, 30).join(', '));
    }
    return missing.length === 0 && keys.size > 20;
  })()
);

check(
  'package.json is 1.2.383',
  /"version": "1.2.383"/.test(src('package.json'))
);
check(
  'changelog has 1.2.383',
  src('src/botInfoChangelog.ts').includes("version: '1.2.383'")
);

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll profile field mutability smoke checks passed.');
