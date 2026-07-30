/**
 * Fail if Bot Info snapshot drifts from live catalogs.
 * Runs against compiled dist/ (no tsx) — safe for Render production builds.
 *
 * Run: npm run check:botinfo   (after tsc)
 * Or:  npm run build           (tsc then this)
 */
const path = require('path');
const fs = require('fs');

const distFile = path.join(__dirname, '..', 'dist', 'botInfoSnapshot.js');
if (!fs.existsSync(distFile)) {
  console.error(
    'Bot Info drift check: dist/botInfoSnapshot.js missing. Run tsc first.'
  );
  process.exit(1);
}

const {
  buildBotInfoSnapshot,
  collectBotInfoDriftErrors,
} = require(distFile);

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
