/**
 * Curated short Psalm / scripture cues for Zion chat — sparing use only.
 */

export type PsalmCueKind =
  | 'encouragement'
  | 'patience'
  | 'wisdom'
  | 'correction'
  | 'gratitude'
  | 'calm_under_pressure'
  | 'recovery';

const CUES: Record<PsalmCueKind, string[]> = {
  encouragement: [
    '“Be strong and courageous.” — Joshua 1:9 (paraphrase)',
    '“The Lord is my strength and my shield.” — Psalm 28:7',
  ],
  patience: [
    '“Wait for the Lord; be strong and take heart.” — Psalm 27:14',
    '“Be still, and know that I am God.” — Psalm 46:10',
  ],
  wisdom: [
    '“Trust in the Lord with all your heart… He will make your paths straight.” — Proverbs 3:5–6',
    '“If any of you lacks wisdom, let him ask God.” — James 1:5',
  ],
  correction: [
    '“A gentle answer turns away wrath.” — Proverbs 15:1',
    '“Let the wise listen and add to their learning.” — Proverbs 1:5 (paraphrase)',
  ],
  gratitude: [
    '“Give thanks to the Lord, for he is good.” — Psalm 107:1',
    '“Every good and perfect gift is from above.” — James 1:17',
  ],
  calm_under_pressure: [
    '“God is our refuge and strength, an ever-present help in trouble.” — Psalm 46:1',
    '“Cast your cares on the Lord and he will sustain you.” — Psalm 55:22',
  ],
  recovery: [
    '“Weeping may stay for the night, but rejoicing comes in the morning.” — Psalm 30:5',
    '“He restores my soul.” — Psalm 23:3',
  ],
};

export function pickPsalmCue(kind: PsalmCueKind): string {
  const pool = CUES[kind] || CUES.encouragement;
  return pool[Math.floor(Math.random() * pool.length)] || pool[0]!;
}

/** ~15% base rate; higher on fitting intents. Never dodge technical duty. */
export function shouldAppendPsalm(opts: {
  question: string;
  reply: string;
  intentKind?: PsalmCueKind | null;
}): PsalmCueKind | null {
  const q = String(opts.question || '').toLowerCase();
  const r = String(opts.reply || '').toLowerCase();

  if (/raw|dump|snapshot|technical|rpc|marl|skip reason|config/.test(q)) {
    return null;
  }
  if (r.length < 40) return null;

  let kind: PsalmCueKind | null = opts.intentKind || null;

  if (!kind) {
    if (/recover|bounce|drawdown|red day|tough|rough|loss|losing/.test(q + r)) {
      kind = 'recovery';
    } else if (/patience|wait|slow|quiet|no trades/.test(q + r)) {
      kind = 'patience';
    } else if (/thank|grateful|blessed|good day|green/.test(q + r)) {
      kind = 'gratitude';
    } else if (/stress|pressure|halt|panic|scared/.test(q + r)) {
      kind = 'calm_under_pressure';
    } else if (/why|explain|learn|wisdom|should i/.test(q)) {
      kind = 'wisdom';
    } else if (/encourage|keep going|motivat/.test(q)) {
      kind = 'encouragement';
    }
  }

  if (!kind) {
    if (Math.random() > 0.15) return null;
    kind = 'encouragement';
  } else if (Math.random() > 0.45) {
    return null;
  }

  return kind;
}

export function maybeAppendPsalmToReply(
  question: string,
  reply: string
): string {
  const kind = shouldAppendPsalm({ question, reply });
  if (!kind) return reply;
  const cue = pickPsalmCue(kind);
  if (reply.includes(cue)) return reply;
  return `${reply.trim()}\n\n_${cue}_`;
}
