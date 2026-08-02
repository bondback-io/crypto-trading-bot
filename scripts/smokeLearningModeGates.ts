/**
 * Smoke: Learning Mode Middle/Looser never tighten vs baseline; concurrent floors.
 * Run: npx tsx scripts/smokeLearningModeGates.ts
 * Mutates in-memory config only (does not call persist helpers).
 */
import { config } from '../src/config';
import {
  applyLearningMaxOverlay,
  applyLearningMinOverlay,
  learningModeAdjustedMaxConcurrent,
  learningModeAdjustedMaxTradesPerHour,
  learningModeAdjustedMinMsBetweenTrades,
} from '../src/learningMode';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

function setLm(
  enabled: boolean,
  strictness: 'stricter' | 'middle' | 'looser'
): void {
  config.learningMode = {
    enabled,
    strictness,
    snapshot: null,
    fairnessBoost: true,
  };
}

setLm(true, 'middle');

const softConv = applyLearningMinOverlay(40, 'minConviction');
check(
  'Middle: baseline conviction 40 stays ≤40',
  softConv <= 40,
  String(softConv)
);

const softHigh = applyLearningMinOverlay(80, 'minConviction');
check(
  'Middle: baseline conviction 80 softens toward matrix (≤68)',
  softHigh <= 68 && softHigh < 80,
  String(softHigh)
);

const softWq = applyLearningMinOverlay(35, 'minWalletQuality');
check(
  'Middle: profile WQ 35 not raised',
  softWq <= 35,
  String(softWq)
);

const softSniper = applyLearningMaxOverlay(40, 'sniperCountMax');
check(
  'Middle: sniper max never tightens below baseline',
  softSniper >= 40,
  String(softSniper)
);

const concFrom3 = learningModeAdjustedMaxConcurrent(3);
check(
  'Middle: concurrent floor ≥16 when baseline 3',
  concFrom3 >= 16,
  String(concFrom3)
);

const concFrom20 = learningModeAdjustedMaxConcurrent(20);
check(
  'Middle: concurrent keeps higher baseline',
  concFrom20 === 20,
  String(concFrom20)
);

const rate = learningModeAdjustedMaxTradesPerHour(12);
check('Middle: hourly cap floor ≥18', rate >= 18, String(rate));

const cool = learningModeAdjustedMinMsBetweenTrades(45_000);
check('Middle: cooldown ≤20s', cool <= 20_000, String(cool));

setLm(true, 'looser');
check(
  'Looser: concurrent floor ≥24',
  learningModeAdjustedMaxConcurrent(3) >= 24,
  String(learningModeAdjustedMaxConcurrent(3))
);
check(
  'Looser: conviction 40 stays ≤40',
  applyLearningMinOverlay(40, 'minConviction') <= 40,
  String(applyLearningMinOverlay(40, 'minConviction'))
);

setLm(true, 'stricter');
const tight = applyLearningMinOverlay(40, 'minConviction');
check(
  'Stricter: raises conviction above 40',
  tight > 40,
  String(tight)
);
check(
  'Stricter: concurrent unchanged at 3',
  learningModeAdjustedMaxConcurrent(3) === 3,
  String(learningModeAdjustedMaxConcurrent(3))
);

setLm(false, 'middle');
check(
  'OFF: overlay is passthrough',
  applyLearningMinOverlay(40, 'minConviction') === 40,
  String(applyLearningMinOverlay(40, 'minConviction'))
);
check(
  'OFF: concurrent passthrough',
  learningModeAdjustedMaxConcurrent(3) === 3,
  String(learningModeAdjustedMaxConcurrent(3))
);

console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
