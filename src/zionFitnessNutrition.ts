/**
 * Zion fitness + nutrition — built-in curriculum, Mifflin–St Jeor BMR/TDEE/macros,
 * session builders, and meal plan templates. General wellness framing (not clinical).
 * Consult state is ephemeral module memory only.
 */

export interface NutritionProfile {
  heightCm?: number;
  weightKg?: number;
  age?: number;
  sex?: 'male' | 'female' | 'unspecified';
  activity?:
    | 'sedentary'
    | 'light'
    | 'moderate'
    | 'active'
    | 'very_active';
  goal?: 'lose' | 'maintain' | 'gain';
  targetKg?: number;
  dietStyle?: 'omnivore' | 'vegan' | 'low_carb' | 'shred' | 'bulk';
}

export interface MacroPlan {
  bmr: number;
  tdee: number;
  recommendedKcal: number;
  aggressiveKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  waterMl: number;
  note: string;
}

export interface ZionFitnessChatResult {
  handled: boolean;
  reply?: string;
  facts?: string;
}

type ConsultStep =
  | 'idle'
  | 'height'
  | 'weight'
  | 'age'
  | 'sex'
  | 'activity'
  | 'goal'
  | 'target'
  | 'done';

interface ConsultState {
  step: ConsultStep;
  profile: NutritionProfile;
  updatedAt: number;
}

let consult: ConsultState = {
  step: 'idle',
  profile: {},
  updatedAt: 0,
};

const ACTIVITY_FACTOR: Record<NonNullable<NutritionProfile['activity']>, number> =
  {
    sedentary: 1.2,
    light: 1.375,
    moderate: 1.55,
    active: 1.725,
    very_active: 1.9,
  };

/** Exercise library by muscle group (machines + free weights). */
export const EXERCISE_LIBRARY: Record<
  string,
  Array<{ name: string; equipment: 'machine' | 'free' | 'bodyweight'; cues: string }>
> = {
  chest: [
    { name: 'Barbell bench press', equipment: 'free', cues: 'scapula set, controlled eccentric' },
    { name: 'Dumbbell incline press', equipment: 'free', cues: '~30° incline, full ROM' },
    { name: 'Chest press machine', equipment: 'machine', cues: 'wrists stacked, no bounce' },
    { name: 'Cable fly', equipment: 'machine', cues: 'soft elbows, squeeze midline' },
    { name: 'Push-up', equipment: 'bodyweight', cues: 'ribs down, full lockout optional' },
  ],
  back: [
    { name: 'Lat pulldown', equipment: 'machine', cues: 'pull elbows to hips, no shrug' },
    { name: 'Seated cable row', equipment: 'machine', cues: 'neutral spine, pause squeeze' },
    { name: 'Barbell row', equipment: 'free', cues: 'hinge, bar to lower chest/upper abs' },
    { name: 'One-arm DB row', equipment: 'free', cues: 'hip stable, full stretch' },
    { name: 'Face pull', equipment: 'machine', cues: 'external rotation, rear delt focus' },
  ],
  shoulders: [
    { name: 'Seated DB shoulder press', equipment: 'free', cues: 'ribs down, don’t flare' },
    { name: 'Shoulder press machine', equipment: 'machine', cues: 'path in front of face line' },
    { name: 'Lateral raise', equipment: 'free', cues: 'lead with elbows, light load' },
    { name: 'Cable rear-delt fly', equipment: 'machine', cues: 'soft elbows, squeeze rear' },
  ],
  legs: [
    { name: 'Back squat', equipment: 'free', cues: 'brace, knees track toes' },
    { name: 'Leg press', equipment: 'machine', cues: 'full foot, don’t lock harshly' },
    { name: 'Romanian deadlift', equipment: 'free', cues: 'hinge, soft knees, hamstring stretch' },
    { name: 'Walking lunge', equipment: 'free', cues: 'upright torso, controlled steps' },
    { name: 'Leg curl', equipment: 'machine', cues: 'hips pinned, full squeeze' },
    { name: 'Calf raise', equipment: 'machine', cues: 'pause at top' },
  ],
  arms: [
    { name: 'Barbell curl', equipment: 'free', cues: 'elbows pinned, no swing' },
    { name: 'Cable pushdown', equipment: 'machine', cues: 'elbows glued to sides' },
    { name: 'Incline DB curl', equipment: 'free', cues: 'stretch at bottom' },
    { name: 'Overhead triceps extension', equipment: 'free', cues: 'upper arms still' },
  ],
  core: [
    { name: 'Dead bug', equipment: 'bodyweight', cues: 'low back pressed down' },
    { name: 'Cable woodchop', equipment: 'machine', cues: 'rotate through ribs, hips quiet' },
    { name: 'Hanging knee raise', equipment: 'bodyweight', cues: 'posterior tilt, no swing' },
  ],
};

type SessionKey =
  | 'back'
  | 'push'
  | 'pull'
  | 'legs'
  | 'chest'
  | 'shoulders'
  | 'arms'
  | 'full'
  | 'weekly';

function pickExercises(
  groups: string[],
  perGroup: number
): Array<{ group: string; name: string; equipment: string; cues: string }> {
  const out: Array<{
    group: string;
    name: string;
    equipment: string;
    cues: string;
  }> = [];
  for (const g of groups) {
    const list = EXERCISE_LIBRARY[g] || [];
    for (const ex of list.slice(0, perGroup)) {
      out.push({ group: g, name: ex.name, equipment: ex.equipment, cues: ex.cues });
    }
  }
  return out;
}

export function buildTrainingSession(kind: SessionKey): string {
  const plans: Record<
    Exclude<SessionKey, 'weekly'>,
    { title: string; groups: string[]; per: number; note: string }
  > = {
    back: {
      title: 'Back focus',
      groups: ['back', 'core'],
      per: 3,
      note: '3–4 sets × 8–12. Rest 90–120s on compounds.',
    },
    push: {
      title: 'Push (chest / shoulders / triceps)',
      groups: ['chest', 'shoulders', 'arms'],
      per: 2,
      note: 'Prioritize pressing; finish with laterals + pushdowns.',
    },
    pull: {
      title: 'Pull (back / biceps / rear delts)',
      groups: ['back', 'arms', 'core'],
      per: 2,
      note: 'Horizontal + vertical pull; keep elbows driving.',
    },
    legs: {
      title: 'Legs',
      groups: ['legs', 'core'],
      per: 3,
      note: 'Warm up progressively. Squats/hinge first.',
    },
    chest: {
      title: 'Chest',
      groups: ['chest', 'shoulders'],
      per: 3,
      note: 'Flat + incline; leave 1–2 reps in reserve.',
    },
    shoulders: {
      title: 'Shoulders',
      groups: ['shoulders', 'arms'],
      per: 3,
      note: 'Press then laterals; go light on raises.',
    },
    arms: {
      title: 'Arms',
      groups: ['arms'],
      per: 4,
      note: 'Superset curl + pushdown if short on time.',
    },
    full: {
      title: 'Full body',
      groups: ['legs', 'back', 'chest', 'core'],
      per: 2,
      note: 'One hard compound per pattern; 45–60 min.',
    },
  };

  if (kind === 'weekly') {
    return [
      '**Weekly template (men 30+ fat-loss friendly)**',
      '• Mon — Push',
      '• Tue — Pull',
      '• Wed — Walk 8–12k steps / mobility',
      '• Thu — Legs',
      '• Fri — Full body or upper pump',
      '• Sat — Optional sport (futsal / hike)',
      '• Sun — Rest + protein-forward meals',
      '',
      'Keep 7k–10k+ steps most days; sleep 7–8h. This is general wellness, not a medical plan.',
      '',
      buildTrainingSession('push'),
      '',
      buildTrainingSession('pull'),
      '',
      buildTrainingSession('legs'),
    ].join('\n');
  }

  const p = plans[kind];
  const moves = pickExercises(p.groups, p.per);
  const lines = moves.map(
    (m, i) =>
      `${i + 1}. **${m.name}** (${m.equipment}) — ${m.cues}`
  );
  return [`**${p.title} session**`, p.note, '', ...lines].join('\n');
}

/**
 * Mifflin–St Jeor BMR → TDEE → recommended (~15–20% deficit) and aggressive (~25% max).
 */
export function computeMacroPlan(profile: NutritionProfile): MacroPlan | null {
  const { heightCm, weightKg, age, sex, activity, goal } = profile;
  if (
    heightCm == null ||
    weightKg == null ||
    age == null ||
    !activity ||
    heightCm < 120 ||
    heightCm > 230 ||
    weightKg < 35 ||
    weightKg > 250 ||
    age < 14 ||
    age > 90
  ) {
    return null;
  }
  const s = sex === 'female' ? -161 : 5; // male / unspecified → male equation (call out)
  const bmr = 10 * weightKg + 6.25 * heightCm - 5 * age + s;
  const tdee = bmr * ACTIVITY_FACTOR[activity];
  const g = goal || 'lose';
  let recommended = tdee;
  let aggressive = tdee;
  if (g === 'lose') {
    recommended = tdee * 0.82; // ~18% deficit
    aggressive = tdee * 0.75; // 25% max
  } else if (g === 'gain') {
    recommended = tdee * 1.1;
    aggressive = tdee * 1.15;
  }
  const proteinG = Math.round(Math.max(1.6, g === 'lose' ? 2.0 : 1.8) * weightKg);
  const fatG = Math.round((recommended * 0.25) / 9);
  const carbsG = Math.round(
    Math.max(0, (recommended - proteinG * 4 - fatG * 9) / 4)
  );
  const waterMl = Math.round(weightKg * 35);
  const sexNote =
    sex === 'unspecified' || !sex
      ? 'Used male Mifflin–St Jeor constant (+5); say if you want the female equation (−161).'
      : sex === 'female'
        ? 'Female Mifflin–St Jeor (−161).'
        : 'Male Mifflin–St Jeor (+5).';
  return {
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    recommendedKcal: Math.round(recommended),
    aggressiveKcal: Math.round(aggressive),
    proteinG,
    carbsG,
    fatG,
    waterMl,
    note: `${sexNote} General wellness estimates — not medical advice.`,
  };
}

export function mealPlanTemplate(
  style: NonNullable<NutritionProfile['dietStyle']>,
  kcal: number
): string {
  const p = Math.round(kcal * 0.3);
  const templates: Record<string, string[]> = {
    omnivore: [
      'Breakfast — eggs + oats or Greek yogurt + fruit + coffee',
      'Lunch — chicken/beef bowl, rice or potato, big salad',
      'Snack — cottage cheese or tuna + fruit',
      'Dinner — fish or lean mince, veg, olive oil measured',
    ],
    vegan: [
      'Breakfast — tofu scramble or overnight oats + soy yogurt',
      'Lunch — lentil/chickpea bowl, quinoa, tahini drizzle',
      'Snack — protein smoothie (pea/soy) + banana',
      'Dinner — tempeh stir-fry, rice, mixed veg',
    ],
    low_carb: [
      'Breakfast — eggs + avocado + spinach',
      'Lunch — large salad + chicken/salmon, olive oil',
      'Snack — Greek yogurt or beef jerky + nuts (portioned)',
      'Dinner — steak/fish + non-starchy veg + butter/olive oil',
    ],
    shred: [
      'Breakfast — high-protein eggs + berries',
      'Lunch — lean protein + volume veg + small carbs post-train',
      'Snack — casein/cottage cheese',
      'Dinner — lean protein + salad; carbs earlier if training PM',
    ],
    bulk: [
      'Breakfast — oats + whey/eggs + peanut butter',
      'Lunch — rice + chicken + olive oil',
      'Snack — sandwich or smoothie + banana',
      'Dinner — pasta or potatoes + beef + veg',
    ],
  };
  const day = templates[style] || templates.omnivore;
  const weekFocus =
    style === 'shred' || style === 'low_carb'
      ? 'Week focus: protein every meal, steps high, lift 3–5×, keep oils measured.'
      : style === 'bulk'
        ? 'Week focus: progressive overload, surplus from food first, not junk only.'
        : 'Week focus: consistent protein, mostly whole foods, 1–2 flexible meals.';
  return [
    `**${style.replace('_', ' ')} day template** (~${kcal} kcal ballpark)`,
    ...day.map((l) => `• ${l}`),
    '',
    `**Week sketch** — repeat structure; rotate proteins/veg. Target ~${p} kcal from protein-forward plates.`,
    weekFocus,
    'General wellness only — not clinical dietetics.',
  ].join('\n');
}

function formatMacroReply(plan: MacroPlan, profile: NutritionProfile): string {
  const target =
    profile.targetKg != null
      ? `\nTarget weight note: ~${profile.targetKg} kg (pace via the recommended deficit first).`
      : '';
  return [
    '**Nutrition consult (Mifflin–St Jeor)**',
    `• BMR ~ **${plan.bmr}** kcal`,
    `• TDEE ~ **${plan.tdee}** kcal`,
    `• Recommended (≈15–20% cut if losing) ~ **${plan.recommendedKcal}** kcal`,
    `• Aggressive ceiling (≤25% cut) ~ **${plan.aggressiveKcal}** kcal — don’t go lower casually`,
    `• Protein ~ **${plan.proteinG} g** · Carbs ~ **${plan.carbsG} g** · Fat ~ **${plan.fatG} g**`,
    `• Water ~ **${plan.waterMl} ml**/day (≈35 ml/kg)`,
    target,
    '',
    plan.note,
    '',
    'Strong default for men 30+ fat loss: hit protein, walk daily, lift 3–4×/week, sleep, and prefer the recommended calories before aggressive.',
    '',
    mealPlanTemplate(profile.dietStyle || 'shred', plan.recommendedKcal),
  ]
    .filter((l) => l !== '')
    .join('\n');
}

function parseNumber(text: string): number | null {
  const m = text.replace(',', '.').match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parseActivity(
  text: string
): NutritionProfile['activity'] | null {
  const t = text.toLowerCase();
  if (/sedentary|desk|none|low\s*activity/.test(t)) return 'sedentary';
  if (/light|walk|1[-–]?3/.test(t)) return 'light';
  if (/moderate|3[-–]?5|few\s*times/.test(t)) return 'moderate';
  if (/very\s*active|athlete|2x\s*day/.test(t)) return 'very_active';
  if (/active|train|gym|5[-–]?7/.test(t)) return 'active';
  return null;
}

function parseGoal(text: string): NutritionProfile['goal'] | null {
  const t = text.toLowerCase();
  if (/lose|cut|fat\s*loss|shred|slim|deficit/.test(t)) return 'lose';
  if (/gain|bulk|muscle|surplus/.test(t)) return 'gain';
  if (/maintain|recomp|same/.test(t)) return 'maintain';
  return null;
}

function parseSex(text: string): NutritionProfile['sex'] | null {
  const t = text.toLowerCase();
  if (/^f\b|female|woman|she/.test(t)) return 'female';
  if (/^m\b|male|man|he/.test(t)) return 'male';
  if (/skip|unspecified|prefer\s*not|n\/?a/.test(t)) return 'unspecified';
  return null;
}

function parseDietStyle(
  text: string
): NutritionProfile['dietStyle'] | null {
  const t = text.toLowerCase();
  if (/\bvegan\b/.test(t)) return 'vegan';
  if (/low\s*carb|keto/.test(t)) return 'low_carb';
  if (/\bshred\b|cut\s*meal/.test(t)) return 'shred';
  if (/\bbulk\b/.test(t)) return 'bulk';
  if (/omnivore|normal|regular|meat/.test(t)) return 'omnivore';
  return null;
}

function detectSession(text: string): SessionKey | null {
  const t = text.toLowerCase();
  if (/weekly|week\s*plan|split\s*for\s*the\s*week/.test(t)) return 'weekly';
  if (/\bfull\s*body\b/.test(t)) return 'full';
  if (/\bpush\b/.test(t)) return 'push';
  if (/\bpull\b/.test(t)) return 'pull';
  if (/\blegs?\b|lower\s*body/.test(t)) return 'legs';
  if (/\bchest\b/.test(t)) return 'chest';
  if (/\bshoulders?\b|delts?\b/.test(t)) return 'shoulders';
  if (/\barms?\b|biceps|triceps/.test(t)) return 'arms';
  if (/\bback\b|lats?\b/.test(t)) return 'back';
  if (/\bworkout|training\s*session|gym\s*session|what\s*should\s*i\s*train/.test(t))
    return 'full';
  return null;
}

function looksLikeNutritionStart(text: string): boolean {
  return /\b(nutrition|macros?|calories|tdee|bmr|meal\s*plan|diet\s*plan|how\s*much\s*should\s*i\s*eat|fat\s*loss\s*plan|calorie\s*target|protein\s*target)\b/i.test(
    text
  );
}

function looksLikeFitness(text: string): boolean {
  return (
    detectSession(text) != null ||
    /\b(workout|training|gym\s*routine|exercise|lift|hypertrophy|program)\b/i.test(
      text
    )
  );
}

function promptFor(step: ConsultStep): string {
  switch (step) {
    case 'height':
      return 'Nutrition consult — general wellness only (not medical advice).\n\nWhat’s your **height in cm**?';
    case 'weight':
      return 'Thanks. Current **weight in kg**?';
    case 'age':
      return 'Got it. **Age**?';
    case 'sex':
      return 'Sex for the equation? (**male** / **female** / **skip**) — optional.';
    case 'activity':
      return 'Activity level? **sedentary / light / moderate / active / very_active**';
    case 'goal':
      return 'Goal? **lose / maintain / gain** (and optional target kg, e.g. “lose to 85”).';
    case 'target':
      return 'Any **target weight in kg**, or say **skip**?';
    default:
      return 'Tell me height (cm), weight (kg), age, activity, and goal when you’re ready.';
  }
}

function footer(): string {
  return '\n\n~ Zion Valton';
}

function advanceConsult(text: string): string | null {
  if (consult.step === 'idle' || consult.step === 'done') return null;

  if (/^(cancel|stop|nevermind|never mind)\b/i.test(text)) {
    consult = { step: 'idle', profile: {}, updatedAt: Date.now() };
    return 'Nutrition consult cancelled.' + footer();
  }

  const p = { ...consult.profile };

  if (consult.step === 'height') {
    const n = parseNumber(text);
    if (n == null || n < 120 || n > 230) {
      return 'Need height in cm (e.g. 178).' + footer();
    }
    p.heightCm = n;
    consult = { step: 'weight', profile: p, updatedAt: Date.now() };
    return promptFor('weight') + footer();
  }
  if (consult.step === 'weight') {
    const n = parseNumber(text);
    if (n == null || n < 35 || n > 250) {
      return 'Need weight in kg (e.g. 92).' + footer();
    }
    p.weightKg = n;
    consult = { step: 'age', profile: p, updatedAt: Date.now() };
    return promptFor('age') + footer();
  }
  if (consult.step === 'age') {
    const n = parseNumber(text);
    if (n == null || n < 14 || n > 90) {
      return 'Need age as a number.' + footer();
    }
    p.age = Math.round(n);
    consult = { step: 'sex', profile: p, updatedAt: Date.now() };
    return promptFor('sex') + footer();
  }
  if (consult.step === 'sex') {
    const s = parseSex(text) || 'unspecified';
    p.sex = s;
    consult = { step: 'activity', profile: p, updatedAt: Date.now() };
    return promptFor('activity') + footer();
  }
  if (consult.step === 'activity') {
    const a = parseActivity(text);
    if (!a) {
      return 'Pick sedentary / light / moderate / active / very_active.' + footer();
    }
    p.activity = a;
    consult = { step: 'goal', profile: p, updatedAt: Date.now() };
    return promptFor('goal') + footer();
  }
  if (consult.step === 'goal') {
    const g = parseGoal(text) || 'lose';
    p.goal = g;
    const tgt = text.match(/\bto\s+(\d{2,3})\b/i) || text.match(/\b(\d{2,3})\s*kg\b/i);
    if (tgt) p.targetKg = Number(tgt[1]);
    const diet = parseDietStyle(text);
    if (diet) p.dietStyle = diet;
    if (p.targetKg == null && g === 'lose') {
      consult = { step: 'target', profile: p, updatedAt: Date.now() };
      return promptFor('target') + footer();
    }
    if (!p.dietStyle) {
      p.dietStyle = g === 'gain' ? 'bulk' : g === 'lose' ? 'shred' : 'omnivore';
    }
    const plan = computeMacroPlan(p);
    consult = { step: 'done', profile: p, updatedAt: Date.now() };
    if (!plan) {
      return 'Couldn’t compute macros from that — check the numbers.' + footer();
    }
    return formatMacroReply(plan, p) + footer();
  }
  if (consult.step === 'target') {
    if (!/skip|none|no\b/i.test(text)) {
      const n = parseNumber(text);
      if (n != null && n >= 35 && n <= 250) p.targetKg = n;
    }
    if (!p.dietStyle) {
      p.dietStyle = p.goal === 'gain' ? 'bulk' : 'shred';
    }
    const plan = computeMacroPlan(p);
    consult = { step: 'done', profile: p, updatedAt: Date.now() };
    if (!plan) {
      return 'Couldn’t compute macros from that — check the numbers.' + footer();
    }
    return formatMacroReply(plan, p) + footer();
  }
  return null;
}

export async function processZionFitnessNutritionChat(
  userText: string
): Promise<ZionFitnessChatResult> {
  const text = String(userText || '').trim();
  if (!text) return { handled: false };

  // Mid-consult always wins
  if (consult.step !== 'idle' && consult.step !== 'done') {
    const reply = advanceConsult(text);
    if (reply) return { handled: true, reply };
  }

  const dietStyle = parseDietStyle(text);
  if (
    dietStyle &&
    /\b(meal\s*plan|day\s*plan|week\s*of\s*meals|what\s*should\s*i\s*eat)\b/i.test(
      text
    )
  ) {
    const kcal = parseNumber(text) || 2000;
    return {
      handled: true,
      reply: mealPlanTemplate(dietStyle, kcal) + footer(),
    };
  }

  if (looksLikeNutritionStart(text)) {
    // Try one-shot if enough numbers present
    const cmM = text.match(/(\d+(?:\.\d+)?)\s*cm\b/i);
    const kgM = text.match(/(\d+(?:\.\d+)?)\s*kg\b/i);
    const nums = [...text.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    const heightCm =
      (cmM ? Number(cmM[1]) : undefined) ||
      nums.find((n) => n >= 140 && n <= 210);
    const weightKg =
      (kgM ? Number(kgM[1]) : undefined) ||
      nums.find((n) => n >= 45 && n <= 200 && n !== heightCm);
    const age = nums.find(
      (n) => n >= 18 && n <= 80 && n !== heightCm && n !== weightKg
    );
    const activity = parseActivity(text) || undefined;
    const goal = parseGoal(text) || 'lose';
    const sex = parseSex(text) || undefined;
    const style = dietStyle || (goal === 'gain' ? 'bulk' : 'shred');

    if (heightCm && weightKg && age && activity) {
      const profile: NutritionProfile = {
        heightCm,
        weightKg,
        age,
        sex: sex || 'unspecified',
        activity,
        goal,
        dietStyle: style,
      };
      const tgt = text.match(/\bto\s+(\d{2,3})\b/i);
      if (tgt) profile.targetKg = Number(tgt[1]);
      const plan = computeMacroPlan(profile);
      if (plan) {
        consult = { step: 'done', profile, updatedAt: Date.now() };
        return { handled: true, reply: formatMacroReply(plan, profile) + footer() };
      }
    }

    consult = {
      step: 'height',
      profile: {
        goal: goal || 'lose',
        dietStyle: style,
        sex: sex || undefined,
      },
      updatedAt: Date.now(),
    };
    return { handled: true, reply: promptFor('height') + footer() };
  }

  const session = detectSession(text);
  if (session && looksLikeFitness(text)) {
    return {
      handled: true,
      reply:
        buildTrainingSession(session) +
        '\n\nGeneral wellness programming — not physiotherapy or medical advice.' +
        footer(),
    };
  }

  if (looksLikeFitness(text) || looksLikeNutritionStart(text)) {
    return {
      handled: false,
      facts: [
        'Fitness/nutrition curriculum available: session builders (push/pull/legs/full/weekly), Mifflin–St Jeor macros, meal templates (omnivore/vegan/low-carb/shred/bulk).',
        'Frame as general wellness, not clinical. Strong on men 30+ fat loss: protein, steps, lifting, sleep.',
        'If Dad wants numbers, ask height/weight/age/activity/goal or start a consult.',
      ].join('\n'),
    };
  }

  return { handled: false };
}

/** Test/helper reset */
export function resetZionNutritionConsult(): void {
  consult = { step: 'idle', profile: {}, updatedAt: 0 };
}
