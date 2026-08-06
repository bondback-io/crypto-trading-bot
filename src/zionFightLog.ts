/**
 * Occasional Zion commentary on Smart Bot lane fights — capped frequency.
 */

import { config } from './config';

type FightEvent = 'open' | 'close' | 'cascade_open' | 'cascade_skip';

let fightsSinceComment = 0;
let lastCommentAt = 0;
const MIN_FIGHTS = 10;
const MIN_MS = 15 * 60 * 1000;

const OPEN_LINES = [
  'Zion: Lane fight! May the best bot win — I\'m rooting for discipline over drama.',
  'Zion: Micro-bots squaring off. Dad, popcorn optional; risk gates mandatory.',
  'Zion: Another bout in the arena. Smart money says read the skip reasons first.',
  'Zion: Fight night — profiles talking smack, MARL playing referee.',
];

const CASCADE_OPEN = [
  'Zion: Cascade stamped a buy — bold move. I\'ll watch the exit like a hawk.',
  'Zion: Gates cleared and we\'re in. Steady hands, Dad.',
  'Zion: Winner got through cascade — may your TP be reachable and your rug be absent.',
];

const CASCADE_SKIP = [
  'Zion: Cascade said “nice try” and skipped — filters doing their job.',
  'Zion: Won the lane, lost the cascade. Better a skip than a bad fill.',
  'Zion: Post-win veto — patience is a strategy too (Psalm 27:14 vibes).',
];

const GATE_BLOCK = [
  'Zion: Gatekeeper waved them off — volume/safety first, drama never.',
  'Zion: HMC Gate said no. Dad, the door stayed shut for a reason.',
  'Zion: Gatekeeper block — collapsed tape or crowded low-MC, not our circus.',
];

const CLOSE_WIN = [
  'Zion: Green close — tell the bots I said well played (quietly, so they don\'t get cocky).',
  'Zion: Winner winner — compound the wisdom, not just the SOL.',
  'Zion: Profitable exit. Even the Trend Rider would crack a smile.',
];

const CLOSE_LOSS = [
  'Zion: Red close — data for learning, not doom. Next lane.',
  'Zion: Loss logged. The bots will pretend they meant to do that. We won\'t.',
  'Zion: Tough one. Morning joy still comes — we iterate.',
];

function pick(lines: string[]): string {
  return lines[Math.floor(Math.random() * lines.length)] || lines[0]!;
}

function shouldComment(): boolean {
  if (config.zionAgent?.fightLogCommentsEnabled === false) return false;
  if (config.zionAgent?.personalityEnabled === false) return false;
  fightsSinceComment += 1;
  const now = Date.now();
  if (fightsSinceComment < MIN_FIGHTS && now - lastCommentAt < MIN_MS) {
    return false;
  }
  if (now - lastCommentAt < MIN_MS) return false;
  if (Math.random() > 0.35) return false;
  fightsSinceComment = 0;
  lastCommentAt = now;
  return true;
}

function appendThought(mint: string, thought: string): void {
  try {
    const { appendLaneFightZionThought } =
      require('./laneOutcomes') as typeof import('./laneOutcomes');
    appendLaneFightZionThought({ mint, thought });
  } catch {
    /* optional */
  }
  try {
    const { appendZionThoughtToLaneFight } =
      require('./monitor') as typeof import('./monitor');
    appendZionThoughtToLaneFight(mint, thought);
  } catch {
    /* optional */
  }
}

export function maybeZionFightLogComment(input: {
  mint: string;
  event: FightEvent;
  winnerId?: string | null;
  win?: boolean;
  /** Gatekeeper plain-language summary when present */
  hmcGateSummary?: string | null;
}): void {
  if (!shouldComment()) return;
  const mint = String(input.mint || '').trim();
  if (!mint) return;

  let line: string;
  const gate = String(input.hmcGateSummary || '').trim();
  if (gate && /Gatekeeper BLOCK/i.test(gate)) {
    line = `${pick(GATE_BLOCK)} (${gate.slice(0, 80)})`;
  } else {
    switch (input.event) {
      case 'cascade_open':
        line = pick(CASCADE_OPEN);
        break;
      case 'cascade_skip':
        line = gate
          ? `${pick(CASCADE_SKIP)} · ${gate.slice(0, 72)}`
          : pick(CASCADE_SKIP);
        break;
      case 'close':
        line = pick(input.win ? CLOSE_WIN : CLOSE_LOSS);
        break;
      default:
        line = gate
          ? `${pick(OPEN_LINES)} · ${gate.slice(0, 72)}`
          : pick(OPEN_LINES);
    }
  }

  appendThought(mint, line);
}
