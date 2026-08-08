const path = require('path');
const fs = require('fs');
const { DASHBOARD_HTML: html } = require(path.join(
  __dirname,
  '..',
  'dist',
  'dashboard.js'
));

if (!html || typeof html !== 'string') {
  console.error('Could not obtain DASHBOARD_HTML');
  process.exit(1);
}

const scripts = [];
const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let m;
while ((m = re.exec(html))) {
  const attrs = m[1] || '';
  const body = m[2];
  if (/\bsrc\s*=/.test(attrs)) continue;
  if (/type\s*=\s*["']application\/json["']/i.test(attrs)) continue;
  if (!body || /^\s*$/.test(body)) continue;
  scripts.push(body);
}

console.log('Found', scripts.length, 'inline scripts, html length', html.length);

let failed = 0;
for (let i = 0; i < scripts.length; i++) {
  const body = scripts[i];
  try {
    // eslint-disable-next-line no-new-func
    new Function(body);
    console.log('OK script', i, 'len', body.length);
  } catch (err) {
    failed++;
    console.error('FAIL script', i, err.message);
    const out = path.join(__dirname, `dashboard-script-${i}-fail.js`);
    fs.writeFileSync(out, body);
    console.error('wrote', out);
    const lines = body.split(/\n/);
    let lo = 0;
    let hi = lines.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const chunk = lines.slice(0, mid + 1).join('\n');
      try {
        new Function(chunk);
        lo = mid + 1;
      } catch {
        hi = mid;
      }
    }
    const bad = lo;
    console.error('first failing around line', bad + 1);
    for (
      let j = Math.max(0, bad - 5);
      j < Math.min(lines.length, bad + 6);
      j++
    ) {
      console.error((j === bad ? '>>>' : '   ') + (j + 1) + '| ' + lines[j]);
    }
  }
}

const tipHits = html.match(/data-tip="[^"]*<[^a-zA-Z/!]/g);
if (tipHits) {
  console.error(
    'WARN: data-tip with raw < that looks like a tag:',
    tipHits.length
  );
  tipHits.slice(0, 3).forEach((t) => console.error(t.slice(0, 160)));
}

process.exit(failed ? 1 : 0);
