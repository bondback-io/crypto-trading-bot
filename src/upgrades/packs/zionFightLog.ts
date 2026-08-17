import { dataFile, atomicWriteJson, readJsonFile } from '../../dataDir';

const FILE = () => dataFile('upgrade-zion-fight-log.json');
const MAX = 80;

export interface FightLogRow {
  ts: number;
  mint: string;
  winner: string;
  loser?: string;
  reason: string;
}

let ring: FightLogRow[] = [];
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  const raw = readJsonFile<{ ring?: FightLogRow[] }>(FILE());
  ring = Array.isArray(raw?.ring) ? raw!.ring!.slice(-MAX) : [];
}

function persist(): void {
  atomicWriteJson(FILE(), { ring: ring.slice(-MAX) });
}

export function recordZionFight(row: FightLogRow): void {
  load();
  ring.push(row);
  if (ring.length > MAX) ring = ring.slice(-MAX);
  persist();
}

export function getZionFightLog(limit = 20): FightLogRow[] {
  load();
  return ring.slice(-limit).reverse();
}

export function enableZionFightLog(): void {
  load();
  console.log(`[upgrades] zion_fight_log ON — ${ring.length} stored rows`);
}

export function disableZionFightLog(): void {
  console.log('[upgrades] zion_fight_log OFF (file kept)');
}
