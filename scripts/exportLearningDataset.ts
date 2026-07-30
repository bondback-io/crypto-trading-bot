/**
 * Export profile-learning episode rings to CSV / JSONL for offline ML inspection.
 * Run: npx tsx scripts/exportLearningDataset.ts [--format=csv|jsonl] [--profile=id] [--out=path]
 */
import fs from 'fs';
import path from 'path';
import {
  getProfileLearningEpisodes,
  type ProfileLearningEpisode,
} from '../src/profileLearningEpisodes';
import { getDataDir, dataFile } from '../src/dataDir';

const args = process.argv.slice(2);
function arg(name: string, fallback?: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.slice(name.length + 3);
}

const format = (arg('format', 'csv') || 'csv').toLowerCase();
const profileFilter = arg('profile');
const outArg = arg('out');

const COLS: Array<keyof ProfileLearningEpisode | 'win'> = [
  'id',
  'at',
  'profileId',
  'mint',
  'symbol',
  'openedAt',
  'closedAt',
  'holdSec',
  'pnlPct',
  'pnlSol',
  'exitKey',
  'exitReason',
  'maxRunupPct',
  'maxDrawdownPct',
  'givebackFromPeakPct',
  'peakUnrealizedPct',
  'exitUnrealizedPct',
  'convictionScore',
  'walletCount',
  'entryMarketCapUsd',
  'tradeProfileScore',
  'paramVersion',
  'entrySource',
  'scannerPlaybook',
  'qualityTier',
  'failureCategory',
  'trailStopPctAtOpen',
  'trailingActivationProfitAtOpen',
  'profitLockArmAtOpen',
  'givebackPtsAtOpen',
  'holdMinAtEntry',
  'hourUtc',
  'microVersion',
  'laneScore',
  'top10HoldPct',
  'win',
];

function listProfileIds(): string[] {
  const dir = dataFile('profile-learning');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.replace(/\.json$/i, ''));
}

function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const ids = profileFilter ? [profileFilter] : listProfileIds();
const rows: Array<Record<string, unknown>> = [];
for (const id of ids) {
  const eps = getProfileLearningEpisodes(id, 500);
  for (const e of eps) {
    rows.push({
      ...e,
      win: (e.pnlPct || 0) > 0 ? 1 : 0,
    });
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const defaultName =
  format === 'jsonl'
    ? `learning-dataset-${stamp}.jsonl`
    : `learning-dataset-${stamp}.csv`;
const outPath = outArg
  ? path.resolve(outArg)
  : path.join(getDataDir(), defaultName);

if (format === 'jsonl') {
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  fs.writeFileSync(outPath, body, 'utf8');
} else {
  const lines = [COLS.join(',')];
  for (const r of rows) {
    lines.push(COLS.map((c) => csvEscape(r[c as string])).join(','));
  }
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
}

console.log(
  `Exported ${rows.length} episode(s) from ${ids.length} profile(s) → ${outPath}`
);
