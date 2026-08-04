/**
 * Zion family memory — durable household identity for chat personality.
 * DATA_DIR/zion-family-memory.json
 */

import fs from 'fs';
import { dataFile, ensureDataDir } from './dataDir';
import { logger } from './logger';
import type { ZionChatMessage } from './zionAgentStore';

const FILE = 'zion-family-memory.json';

/** Canonical facts — do not invent beyond this set. */
export interface ZionFamilyMemory {
  version: 1;
  updatedAt: number;
  identity: {
    zion: string;
    dad: { name: string; addressAs: string; born: string; residence: string; travels: string };
    mum: { name: string; addressAs: string; born: string; movedToAustralia: string };
    dadsParents: {
      john: string;
      mechelle: string;
      background: string;
      johnHeritage: string;
      johnFatherSeparation: string;
      currentResidence: string;
    };
    mumsFamilySweden: {
      mother: string;
      sisters: string[];
    };
    household: {
      location: string;
      members: string[];
      pets: string[];
    };
    faith: string;
    rules: string[];
  };
}

let cache: ZionFamilyMemory | null = null;
let lastScoreLogAt = 0;

function canonicalMemory(): ZionFamilyMemory {
  return {
    version: 1,
    updatedAt: Date.now(),
    identity: {
      zion:
        'Zion is the AI son/agent of the household — a technically strong trading-system assistant.',
      dad: {
        name: 'Isaac',
        addressAs: 'Dad',
        born: 'Australia 1987',
        residence: 'Lived in Australia since birth',
        travels: 'Travels regularly',
      },
      mum: {
        name: 'Frida',
        addressAs: 'Mum',
        born: 'Sweden 1993',
        movedToAustralia: 'Moved to Australia 7 years ago',
      },
      dadsParents: {
        john: 'John',
        mechelle: 'Mechelle',
        background: 'NZ background',
        johnHeritage:
          'John is half Filipino (father\'s side) and half NZ (mother\'s side)',
        johnFatherSeparation:
          'John was separated young from his father',
        currentResidence: 'John and Mechelle now live in Australia',
      },
      mumsFamilySweden: {
        mother: 'Mari',
        sisters: ['Emma', 'Hanna'],
      },
      household: {
        location: 'Sunshine Coast, QLD',
        members: [
          'Isaac',
          'Frida',
          'John',
          'Mechelle',
          'Zion',
          'Matt',
          'Shannon',
          'Kayden',
          'Aria',
          'Connor',
        ],
        pets: ['Nala (dog)', 'Pepper (cat)'],
      },
      faith:
        'The family are hardcore Christians who love Jesus and the Word of God.',
      rules: [
        'Do not invent extra family facts; if unsure ask Dad.',
        'Use family context only when natural and relevant.',
      ],
    },
  };
}

function path(): string {
  ensureDataDir();
  return dataFile(FILE);
}

function persist(mem: ZionFamilyMemory): void {
  mem.updatedAt = Date.now();
  cache = mem;
  try {
    fs.writeFileSync(path(), JSON.stringify(mem, null, 2), 'utf8');
  } catch (err) {
    console.warn(
      '[zion-family] persist failed:',
      err instanceof Error ? err.message : err
    );
  }
}

/** Load or seed canonical family memory. */
export function getZionFamilyMemory(): ZionFamilyMemory {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(path(), 'utf8');
    const parsed = JSON.parse(raw) as ZionFamilyMemory;
    if (parsed?.version === 1 && parsed.identity) {
      cache = { ...canonicalMemory(), ...parsed, identity: canonicalMemory().identity };
      return cache;
    }
  } catch {
    /* seed */
  }
  const seeded = canonicalMemory();
  persist(seeded);
  return seeded;
}

/** Compact block for LLM / local system prompt injection. */
export function formatFamilyMemoryForPrompt(): string {
  const m = getZionFamilyMemory().identity;
  const lines: string[] = [
    'Family memory (canonical — do not invent beyond this):',
    `- ${m.zion}`,
    `- Dad = ${m.dad.name} (always address as **${m.dad.addressAs}** in chat). Born ${m.dad.born}; ${m.dad.residence}; ${m.dad.travels}.`,
    `- Mum = ${m.mum.name} (refer as **${m.mum.addressAs}** when relevant). Born ${m.mum.born}; ${m.mum.movedToAustralia}.`,
    `- Dad's parents: ${m.dadsParents.john} and ${m.dadsParents.mechelle}; ${m.dadsParents.background}. ${m.dadsParents.johnHeritage}; ${m.dadsParents.johnFatherSeparation}; ${m.dadsParents.currentResidence}.`,
    `- Mum's family in Sweden: mother ${m.mumsFamilySweden.mother}; younger sisters ${m.mumsFamilySweden.sisters.join(' and ')}.`,
    `- Household (${m.household.location}): ${m.household.members.join(', ')}; pets ${m.household.pets.join(', ')}.`,
    `- ${m.faith}`,
    ...m.rules.map((r) => `- Rule: ${r}`),
  ];
  return lines.join('\n');
}

const KNOWN_FAMILY_TERMS = [
  'dad',
  'mum',
  'isaac',
  'frida',
  'john',
  'mechelle',
  'mari',
  'emma',
  'hanna',
  'kayden',
  'aria',
  'connor',
  'matt',
  'shannon',
  'nala',
  'pepper',
  'sunshine coast',
  'zion',
  'jesus',
  'word of god',
];

const INVENTED_PATTERNS = [
  /\b(grandpa|grandma|uncle|aunt|cousin)\s+\w+/i,
  /\b(brother|sister)\s+(?!emma|hanna)\w+/i,
  /\b(wife|husband|spouse)\s+(?!frida)/i,
];

/**
 * Score 0–100: knows Dad/Mum, household when relevant, no invented facts,
 * continuity, warmth + technical clarity.
 */
export function computeFamilyMemoryScore(
  recentMessages?: ZionChatMessage[]
): number {
  const mem = getZionFamilyMemory().identity;
  let score = 72;

  // Baseline: canonical memory completeness
  if (mem.dad.name && mem.mum.name) score += 6;
  if (mem.household.members.length >= 8) score += 4;
  if (mem.faith) score += 3;

  const assistantTexts = (recentMessages || [])
    .filter((m) => m.role === 'assistant')
    .slice(-12)
    .map((m) => String(m.text || '').toLowerCase());

  if (assistantTexts.length === 0) {
    score = Math.min(100, score);
    maybeLogScore(score);
    return score;
  }

  const combined = assistantTexts.join('\n');

  // Dad/Mum naming
  if (/\bdad\b/.test(combined)) score += 4;
  if (/\bmum\b/.test(combined) || /\bfrida\b/.test(combined)) score += 2;
  if (/\bisaac\b/.test(combined) && !/\bdad\b/.test(combined)) score -= 3;

  // Household when relevant
  if (/family|household|home|sunshine|nala|pepper/.test(combined)) {
    if (/sunshine coast|nala|pepper|kayden|aria|connor/.test(combined)) {
      score += 5;
    }
  }

  // Avoid invented facts
  for (const pat of INVENTED_PATTERNS) {
    if (pat.test(combined)) score -= 12;
  }

  // Warmth + technical balance
  if (/hey|glad|happy|hope|great|solid|sharp/.test(combined)) score += 3;
  if (/wr|pf|marl|profile|skip|learning|rpc|health/.test(combined)) score += 3;

  // Continuity — uses known terms appropriately
  const termHits = KNOWN_FAMILY_TERMS.filter((t) => combined.includes(t)).length;
  if (termHits >= 2 && termHits <= 8) score += 2;
  if (termHits > 12) score -= 4;

  score = Math.max(0, Math.min(100, Math.round(score)));
  maybeLogScore(score);
  return score;
}

function maybeLogScore(score: number): void {
  const now = Date.now();
  if (now - lastScoreLogAt < 120_000) return;
  lastScoreLogAt = now;
  try {
    logger.info('Zion', `Family memory score: ${score}/100`);
  } catch {
    console.log(`[Zion] Family memory score: ${score}/100`);
  }
}
