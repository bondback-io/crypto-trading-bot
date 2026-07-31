/**
 * Fail if Bot Info snapshot drifts from live catalogs, or if the changelog
 * is missing the current package.json version.
 * Runs against compiled dist/ (no tsx) — safe for Render production builds.
 *
 * Run: npm run check:botinfo   (after tsc)
 * Or:  npm run build           (tsc then this)
 */
const path = require('path');
const fs = require('fs');

const distSnap = path.join(__dirname, '..', 'dist', 'botInfoSnapshot.js');
const distChangelog = path.join(__dirname, '..', 'dist', 'botInfoChangelog.js');
const pkgPath = path.join(__dirname, '..', 'package.json');

if (!fs.existsSync(distSnap)) {
  console.error(
    'Bot Info drift check: dist/botInfoSnapshot.js missing. Run tsc first.'
  );
  process.exit(1);
}

const {
  buildBotInfoSnapshot,
  collectBotInfoDriftErrors,
} = require(distSnap);

const snap = buildBotInfoSnapshot();
const errors = collectBotInfoDriftErrors(snap);

console.log(
  `Bot Info snapshot: ${snap.counts.profiles} profiles, ${snap.counts.modules} modules, ${snap.counts.presets} presets, ${snap.modes.length} modes`
);

if (fs.existsSync(distChangelog) && fs.existsSync(pkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const ver = String(pkg.version || '').trim();
  const { botInfoChangelogVersions } = require(distChangelog);
  const versions = botInfoChangelogVersions();
  if (ver && !versions.includes(ver)) {
    errors.push(
      `BOT_INFO_CHANGELOG is missing package version ${ver} — add a top entry when shipping user-visible changes`
    );
  } else if (ver) {
    console.log(`Bot Info changelog: includes v${ver} (${versions.length} entries)`);
  }
} else if (!fs.existsSync(distChangelog)) {
  errors.push('dist/botInfoChangelog.js missing — run tsc first');
}

if (errors.length) {
  console.error('Bot Info drift check FAILED:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log('Bot Info drift check OK');
