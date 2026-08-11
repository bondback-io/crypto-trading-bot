/**
 * Minimal assert: Grad remapped reclaim + late detector must not get LC relief.
 * Run after tsc (uses dist/). Fail soft if dist missing.
 */
'use strict';
const path = require('path');
const dist = path.join(__dirname, '..', 'dist', 'expectancyLift.js');
let mod;
try {
  mod = require(dist);
} catch (err) {
  console.warn('[checkLateChaseRelief] dist not built — skip:', err.message);
  process.exit(0);
}

const { shouldLimitLateChaseShare } = mod;
if (typeof shouldLimitLateChaseShare !== 'function') {
  console.error('[checkLateChaseRelief] shouldLimitLateChaseShare missing');
  process.exit(1);
}

// Near-level armed reclaim (ext 2%) — relief OK (limit false via LC_ARMED_RECLAIM_RELIEF or not late)
{
  const r = shouldLimitLateChaseShare({
    armedWatch: true,
    entryStyle: 'migration_hold_reclaim',
    lateChase: false,
    extensionFromLevelPct: 2,
    profileId: 'migration_sniper',
  });
  if (r.limit) {
    console.error('[checkLateChaseRelief] near-level reclaim should not hard-limit', r);
    process.exit(1);
  }
}

// Detector late + remapped reclaim + ext 12% — must NOT get relief; should hard-limit
{
  const r = shouldLimitLateChaseShare({
    armedWatch: true,
    entryStyle: 'migration_hold_reclaim',
    entryStyleSecondary: 'late_chase',
    lateChase: true,
    extensionFromLevelPct: 12,
    profileId: 'migration_sniper',
  });
  if (!r.limit) {
    console.error(
      '[checkLateChaseRelief] late Grad remap must hard-limit (got relief)',
      r
    );
    process.exit(1);
  }
}

console.log('[checkLateChaseRelief] OK');
