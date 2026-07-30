/**
 * Fail if Bot Info snapshot drifts from live catalogs.
 * Run: npm run check:botinfo
 */
import {
  buildBotInfoSnapshot,
  collectBotInfoDriftErrors,
} from '../src/botInfoSnapshot';

const snap = buildBotInfoSnapshot();
const errors = collectBotInfoDriftErrors(snap);

console.log(
  `Bot Info snapshot: ${snap.counts.profiles} profiles, ${snap.counts.modules} modules, ${snap.counts.presets} presets, ${snap.modes.length} modes`
);

if (errors.length) {
  console.error('Bot Info drift check FAILED:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log('Bot Info drift check OK');
