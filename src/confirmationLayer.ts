/**
 * Volume + Sentiment + Narrative Confirmation Layer.
 *
 * Combines three supporting signals into one confirmation status:
 *   Weak | Moderate | Strong | Very Strong
 *
 * - Soft boost to conviction when confirmation is Strong / Very Strong
 * - Optional hard filter when confirmation is Very Weak (configurable)
 * - Missing sentiment / narrative never blocks (fail-open; weights renormalize)
 * - Volume usually weighted highest (Pump.fun default)
 */

import { config } from './config';
import { isStrategyEnabled, logStrategyDecision } from './strategies';
import { evaluateVolumeSpike } from './volumeSpike';
import { evaluateSocialSentimentFromSignal } from './socialSentiment';
import { evaluateTrendingNarrative } from './trendingNarrative';

export type ConfirmationSensitivity = 'low' | 'medium' | 'high';

export type ConfirmationStatus =
  | 'weak'
  | 'moderate'
  | 'strong'
  | 'very_strong';

export interface ConfirmationComponent {
  key: 'volume' | 'sentiment' | 'narrative';
  /** Raw 0–100 component score (0 when unavailable) */
  score: number;
  /** Configured weight before renormalization */
  weight: number;
  /** Weight after dropping unavailable inputs */
  effectiveWeight: number;
  /** Contribution to combined score (0–100 scale share) */
  contribution: number;
  available: boolean;
  detail: string;
}

export interface ConfirmationReport {
  status: ConfirmationStatus;
  /** Combined 0–100 confirmation score */
  score: number;
  components: ConfirmationComponent[];
  availableCount: number;
  /** True when at least volume (or any) data was usable */
  hasUsableData: boolean;
  detail: string;
}

export interface ConfirmationVerdict {
  convictionDelta: number;
  skip: boolean;
  skipReason?: string;
  influenced: boolean;
  report: ConfirmationReport;
  logLine: string;
}

export const CONFIRMATION_DEFAULTS = {
  sensitivity: 'medium' as ConfirmationSensitivity,
  volumeWeight: 50,
  sentimentWeight: 25,
  narrativeWeight: 25,
  boostPoints: 10,
  hardFilter: false,
} as const;

type SignalLike = {
  mint?: string;
  symbol?: string;
  isMigration?: boolean;
  nearMigration?: boolean;
  wallets?: unknown[];
  metrics?: Record<string, unknown> | null;
  birdeye?: Record<string, unknown> | null;
  antiRug?: Record<string, unknown> | null;
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function sensitivity(): ConfirmationSensitivity {
  const s = config.filters.confirmationSensitivity;
  return s === 'low' || s === 'high' ? s : 'medium';
}

function weightOf(
  key: 'volume' | 'sentiment' | 'narrative'
): number {
  const defaults = CONFIRMATION_DEFAULTS;
  const raw =
    key === 'volume'
      ? Number(config.filters.confirmationVolumeWeight)
      : key === 'sentiment'
        ? Number(config.filters.confirmationSentimentWeight)
        : Number(config.filters.confirmationNarrativeWeight);
  const fallback =
    key === 'volume'
      ? defaults.volumeWeight
      : key === 'sentiment'
        ? defaults.sentimentWeight
        : defaults.narrativeWeight;
  if (!Number.isFinite(raw) || raw < 0) return fallback;
  return Math.max(0, Math.min(100, raw));
}

function boostPoints(level: ConfirmationSensitivity): number {
  const configured = Number(config.filters.confirmationBoostPoints);
  const base =
    Number.isFinite(configured) && configured > 0
      ? configured
      : CONFIRMATION_DEFAULTS.boostPoints;
  const sens = level === 'low' ? 0.65 : level === 'high' ? 1.35 : 1;
  return Math.max(1, Math.min(22, Math.round(base * sens)));
}

function hardFilterEnabled(): boolean {
  return config.filters.confirmationHardFilter === true;
}

function statusFromScore(
  score: number,
  level: ConfirmationSensitivity
): ConfirmationStatus {
  // High sensitivity: harder to reach Strong+
  const veryStrong =
    level === 'high' ? 80 : level === 'low' ? 68 : 75;
  const strong = level === 'high' ? 60 : level === 'low' ? 48 : 55;
  const moderate = level === 'high' ? 40 : level === 'low' ? 28 : 35;
  if (score >= veryStrong) return 'very_strong';
  if (score >= strong) return 'strong';
  if (score >= moderate) return 'moderate';
  return 'weak';
}

function statusLabel(s: ConfirmationStatus): string {
  switch (s) {
    case 'very_strong':
      return 'Very Strong';
    case 'strong':
      return 'Strong';
    case 'moderate':
      return 'Moderate';
    default:
      return 'Weak';
  }
}

/** Volume component 0–100 from spike strength + buy-side dominance. */
function scoreVolume(signal: SignalLike): {
  score: number;
  available: boolean;
  detail: string;
} {
  const report = evaluateVolumeSpike(signal as Parameters<
    typeof evaluateVolumeSpike
  >[0]);
  if (report.source === 'none') {
    return { score: 0, available: false, detail: 'volume unavailable' };
  }
  let score = report.strength;
  if (report.flags.buyDominance) score = Math.min(100, score + 8);
  if (report.flags.suddenSurge || report.flags.relativeVolume) {
    score = Math.min(100, score + 5);
  }
  if (report.flags.acceleration) score = Math.min(100, score + 4);
  if (!report.flags.absoluteFloor) score = Math.max(0, score - 25);
  return {
    score: clamp(Math.round(score), 0, 100),
    available: true,
    detail: `vol strength=${report.strength} buy%=${
      report.buySidePct != null ? report.buySidePct.toFixed(0) : '—'
    } rel×${report.relativeMult != null ? report.relativeMult.toFixed(2) : '—'}`,
  };
}

/** Sentiment −100…+100 → 0…100. */
function scoreSentiment(signal: SignalLike): {
  score: number;
  available: boolean;
  detail: string;
} {
  const report = evaluateSocialSentimentFromSignal(
    signal as Parameters<typeof evaluateSocialSentimentFromSignal>[0]
  );
  if (report.source === 'none') {
    return { score: 0, available: false, detail: 'sentiment unavailable' };
  }
  const mapped = clamp(Math.round((report.score + 100) / 2), 0, 100);
  return {
    score: mapped,
    available: true,
    detail: `sent raw=${report.score} mapped=${mapped} heat=${report.mentionHeat}`,
  };
}

/** Narrative heat when theme matches; unavailable otherwise (fail-open). */
function scoreNarrative(signal: SignalLike): {
  score: number;
  available: boolean;
  detail: string;
} {
  const report = evaluateTrendingNarrative(
    signal as Parameters<typeof evaluateTrendingNarrative>[0]
  );
  if (report.source === 'none' || report.themes.length === 0) {
    return {
      score: 0,
      available: false,
      detail: report.detail || 'narrative unavailable',
    };
  }
  return {
    score: clamp(Math.round(report.heat), 0, 100),
    available: true,
    detail: `narr themes=${report.themes.join(',')} heat=${report.heat}`,
  };
}

export function evaluateConfirmationLayer(
  signal: SignalLike
): ConfirmationReport {
  const level = sensitivity();
  const specs: Array<{
    key: ConfirmationComponent['key'];
    scored: { score: number; available: boolean; detail: string };
    weight: number;
  }> = [
    {
      key: 'volume',
      scored: scoreVolume(signal),
      weight: weightOf('volume'),
    },
    {
      key: 'sentiment',
      scored: scoreSentiment(signal),
      weight: weightOf('sentiment'),
    },
    {
      key: 'narrative',
      scored: scoreNarrative(signal),
      weight: weightOf('narrative'),
    },
  ];

  const available = specs.filter((s) => s.scored.available && s.weight > 0);
  const weightSum = available.reduce((a, s) => a + s.weight, 0);

  const components: ConfirmationComponent[] = specs.map((s) => {
    const effectiveWeight =
      s.scored.available && weightSum > 0 && s.weight > 0
        ? s.weight
        : 0;
    const contribution =
      effectiveWeight > 0 && weightSum > 0
        ? (s.scored.score * effectiveWeight) / weightSum
        : 0;
    return {
      key: s.key,
      score: s.scored.score,
      weight: s.weight,
      effectiveWeight,
      contribution: Math.round(contribution * 10) / 10,
      available: s.scored.available,
      detail: s.scored.detail,
    };
  });

  const hasUsableData = available.length > 0;
  const score = hasUsableData
    ? clamp(
        Math.round(components.reduce((a, c) => a + c.contribution, 0)),
        0,
        100
      )
    : 0;
  const status = hasUsableData
    ? statusFromScore(score, level)
    : 'moderate'; // neutral placeholder when no data (fail-open)

  const breakdownParts = components.map(
    (c) =>
      `${c.key}=${c.available ? c.score : 'n/a'}(w${c.weight}${
        c.available ? `→${c.contribution.toFixed(1)}` : ''
      })`
  );

  const detail =
    `status=${statusLabel(status)} score=${score} [${level}] ` +
    breakdownParts.join(' ') +
    ` available=${available.length}/3`;

  return {
    status: hasUsableData ? status : 'moderate',
    score,
    components,
    availableCount: available.length,
    hasUsableData,
    detail,
  };
}

export function applyConfirmationVerdict(
  report: ConfirmationReport,
  options?: { sensitivity?: ConfirmationSensitivity }
): ConfirmationVerdict {
  if (!report.hasUsableData) {
    return {
      convictionDelta: 0,
      skip: false,
      influenced: false,
      report,
      logLine: 'confirmation: no usable data (fail-open)',
    };
  }

  const level = options?.sensitivity ?? sensitivity();
  const hardOn = hardFilterEnabled();
  const volumeAvailable =
    report.components.find((c) => c.key === 'volume')?.available === true;

  let skip = false;
  let skipReason: string | undefined;

  // Optional hard filter only when confirmation is Weak AND we have volume
  // (never block solely because sentiment/narrative are missing).
  if (
    hardOn &&
    report.status === 'weak' &&
    volumeAvailable &&
    report.availableCount >= 1
  ) {
    // High: always skip Weak; Medium: skip if score very low; Low: rarely
    const skipFloor = level === 'high' ? 45 : level === 'low' ? 18 : 30;
    if (report.score < skipFloor) {
      skip = true;
      skipReason = `confirmation very weak (${statusLabel(report.status)}, score ${report.score})`;
    }
  }

  let convictionDelta = 0;
  const base = boostPoints(level);
  if (report.status === 'very_strong') {
    convictionDelta = Math.min(22, Math.round(base * 1.35));
  } else if (report.status === 'strong') {
    convictionDelta = base;
  } else if (report.status === 'moderate' && level === 'low') {
    convictionDelta = Math.max(1, Math.round(base * 0.35));
  }

  // Alignment bonus: all three available and Strong+
  if (
    report.availableCount === 3 &&
    (report.status === 'strong' || report.status === 'very_strong')
  ) {
    convictionDelta = Math.min(22, convictionDelta + 2);
  }

  const influenced = skip || convictionDelta > 0;
  const contribLog = report.components
    .map(
      (c) =>
        `${c.key}:${c.available ? `+${c.contribution.toFixed(1)}` : 'skip'}`
    )
    .join(' ');
  const logLine =
    `confirmation ${level}: ${statusLabel(report.status)} score=${report.score} ` +
    `Δconv=${convictionDelta > 0 ? '+' : ''}${convictionDelta}` +
    (skip ? ' SKIP' : '') +
    ` · ${contribLog} · ${report.detail}`;

  return {
    convictionDelta,
    skip,
    skipReason,
    influenced,
    report,
    logLine,
  };
}

export function resolveConfirmationLayerForSignal(
  signal: SignalLike
): ConfirmationVerdict | null {
  if (!isStrategyEnabled('confirmation_layer')) return null;
  if (config.filters.enableConfirmationLayer === false) return null;

  const report = evaluateConfirmationLayer(signal);
  return applyConfirmationVerdict(report);
}

export function logConfirmationDecision(
  symbol: string,
  verdict: ConfirmationVerdict,
  outcome: 'boost' | 'skip' | 'neutral'
): void {
  if (!verdict.influenced && outcome === 'neutral') return;
  logStrategyDecision(
    'confirmation_layer',
    outcome === 'skip' ? 'skip' : 'take',
    `${symbol}: ${verdict.logLine}`
  );
  const tag =
    outcome === 'skip' ? 'SKIP' : outcome === 'boost' ? 'BOOST' : 'INFO';
  console.log(`[confirm] ${tag} ${symbol} — ${verdict.logLine}`);
}
