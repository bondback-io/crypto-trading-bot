/**
 * Trending Narrative Boost — soft confirmation for hot themes.
 *
 * Description: Boosts tokens tied to currently hot narratives – used as
 * confirmation, not a primary signal.
 *
 * Soft boost only (never hard-skips). Fail-open when narrative data is
 * unavailable so existing profiles keep working unchanged.
 */

import { config } from './config';
import { isStrategyEnabled, logStrategyDecision } from './strategies';

export type NarrativeSensitivity = 'low' | 'medium' | 'high';

export type NarrativeSource = 'none' | 'proxy' | 'theme_match';

export interface NarrativeReport {
  source: NarrativeSource;
  /** Matched theme labels (e.g. ai, pepe, election) */
  themes: string[];
  /** 0–100 how “hot” the narrative looks from available proxies */
  heat: number;
  detail: string;
}

export interface NarrativeBoostVerdict {
  /** Conviction points to add (always ≥ 0 for this feature) */
  convictionDelta: number;
  influenced: boolean;
  report: NarrativeReport;
  logLine: string;
}

const EMPTY: NarrativeReport = {
  source: 'none',
  themes: [],
  heat: 0,
  detail: 'narrative data unavailable',
};

/**
 * Built-in hot-theme keywords. Matched against symbol + name (case-insensitive).
 * Users can extend via config.filters.trendingNarrativeKeywords.
 */
export const DEFAULT_NARRATIVE_KEYWORDS: Record<string, string[]> = {
  ai: ['ai', 'gpt', 'claude', 'agent', 'llm', 'openai', 'neural'],
  pepe: ['pepe', 'frog', 'kek'],
  doge: ['doge', 'shib', 'inu', 'woof', 'puppy', 'dog'],
  cat: ['cat', 'neko', 'meow', 'kitten'],
  trump: ['trump', 'maga', 'election', 'potus', '45', '47'],
  elon: ['elon', 'musk', 'mars', 'tesla', 'xai'],
  meme: ['meme', 'viral', 'chad', 'wojak', 'based'],
  animal: ['monkey', 'ape', 'bear', 'bull', 'whale', 'fox', 'wolf'],
  solana: ['sol', 'solana', 'pump'],
  rwa: ['rwa', 'realworld', 'treasury'],
  depin: ['depin', 'iot', 'render', 'gpu'],
};

type SignalLike = {
  mint?: string;
  symbol?: string;
  name?: string;
  wallets?: unknown[];
  metrics?: {
    volume24hUsd?: number | null;
    recentVolumeUsd?: number | null;
    recentBuyVolumeUsd?: number | null;
  } | null;
  birdeye?: {
    smartMoneyScore?: number | null;
    volume24hUsd?: number | null;
  } | null;
  antiRug?: {
    birdeye?: { smartMoneyScore?: number | null } | null;
  } | null;
};

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sensitivity(): NarrativeSensitivity {
  const s = config.filters.trendingNarrativeSensitivity;
  return s === 'low' || s === 'high' ? s : 'medium';
}

function keywordMap(): Record<string, string[]> {
  const extra = config.filters.trendingNarrativeKeywords;
  if (!extra || typeof extra !== 'object') return DEFAULT_NARRATIVE_KEYWORDS;
  return { ...DEFAULT_NARRATIVE_KEYWORDS, ...extra };
}

/** Base boost points from config, clamped. */
function configuredBoostPoints(): number {
  const n = Number(config.filters.trendingNarrativeBoostPoints);
  if (!Number.isFinite(n) || n <= 0) return 6;
  return Math.max(1, Math.min(20, Math.round(n)));
}

function sensitivityMultiplier(level: NarrativeSensitivity): number {
  switch (level) {
    case 'low':
      return 0.55;
    case 'high':
      return 1.45;
    case 'medium':
    default:
      return 1;
  }
}

function matchThemes(symbol: string, name: string): string[] {
  const hay = `${symbol} ${name}`.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const tokens = new Set(hay.split(/\s+/).filter(Boolean));
  // also check contiguous symbol without spaces
  const compact = hay.replace(/\s+/g, '');
  const matched: string[] = [];
  const map = keywordMap();
  for (const [theme, keys] of Object.entries(map)) {
    for (const key of keys) {
      const k = key.toLowerCase();
      if (!k) continue;
      if (tokens.has(k) || compact.includes(k) || hay.includes(k)) {
        matched.push(theme);
        break;
      }
    }
  }
  return matched;
}

/**
 * Detect narrative linkage + heat from symbol/name + on-chain proxies.
 */
export function evaluateTrendingNarrative(
  signal: SignalLike
): NarrativeReport {
  const symbol = String(signal.symbol || '').trim();
  const name = String(signal.name || '').trim();
  const themes = matchThemes(symbol, name);

  const vol24 =
    num(signal.metrics?.volume24hUsd) ?? num(signal.birdeye?.volume24hUsd);
  const recent =
    num(signal.metrics?.recentVolumeUsd) ??
    num(signal.metrics?.recentBuyVolumeUsd);
  const sm =
    num(signal.birdeye?.smartMoneyScore) ??
    num(signal.antiRug?.birdeye?.smartMoneyScore);
  const wallets = Array.isArray(signal.wallets) ? signal.wallets.length : 0;

  let heat = 0;
  if (recent != null && recent > 0) {
    heat += Math.min(45, Math.round(Math.log10(recent + 10) * 14));
  } else if (vol24 != null && vol24 > 0) {
    heat += Math.min(30, Math.round(Math.log10(vol24 + 10) * 10));
  }
  if (sm != null && sm >= 50) heat += Math.min(35, Math.round((sm - 40) * 0.7));
  else if (sm != null && sm > 0) heat += 8;
  if (wallets >= 3) heat += 12;
  else if (wallets >= 2) heat += 6;
  if (themes.length >= 2) heat += 10;
  else if (themes.length === 1) heat += 5;
  heat = Math.max(0, Math.min(100, heat));

  if (themes.length === 0 && heat < 25) {
    return { ...EMPTY };
  }

  if (themes.length === 0) {
    // Heat without a named theme — not a narrative boost
    return {
      source: 'none',
      themes: [],
      heat,
      detail: 'no narrative theme matched',
    };
  }

  // Require some activity so we don't boost dead themed tickers
  if (heat < 20) {
    return {
      source: 'none',
      themes,
      heat,
      detail: `theme=${themes.join(',')} but narrative heat too low (${heat})`,
    };
  }

  return {
    source: 'theme_match',
    themes,
    heat,
    detail: `themes=${themes.join(',')} heat=${heat}`,
  };
}

/** Soft boost only — never skips. */
export function applyNarrativeBoost(
  report: NarrativeReport,
  options?: { sensitivity?: NarrativeSensitivity }
): NarrativeBoostVerdict {
  if (report.source === 'none' || report.themes.length === 0) {
    return {
      convictionDelta: 0,
      influenced: false,
      report,
      logLine: `narrative: ${report.detail}`,
    };
  }

  const level = options?.sensitivity ?? sensitivity();
  const base = configuredBoostPoints();
  const heatScale = 0.55 + (report.heat / 100) * 0.45; // 0.55–1.0
  const multiTheme = report.themes.length >= 2 ? 1.15 : 1;
  let delta = Math.round(
    base * sensitivityMultiplier(level) * heatScale * multiTheme
  );
  delta = Math.max(1, Math.min(20, delta));

  const logLine =
    `narrative boost ${level}: +${delta} conv · ${report.detail} · base=${base}`;

  return {
    convictionDelta: delta,
    influenced: true,
    report,
    logLine,
  };
}

export function resolveTrendingNarrativeBoost(
  signal: SignalLike
): NarrativeBoostVerdict | null {
  if (!isStrategyEnabled('trending_narrative_boost')) return null;
  if (config.filters.enableTrendingNarrativeBoost === false) return null;

  const report = evaluateTrendingNarrative(signal);
  return applyNarrativeBoost(report);
}

export function logNarrativeBoostDecision(
  symbol: string,
  verdict: NarrativeBoostVerdict
): void {
  if (!verdict.influenced) return;
  logStrategyDecision(
    'trending_narrative_boost',
    'take',
    `${symbol}: ${verdict.logLine}`
  );
  console.log(`[narrative] BOOST ${symbol} — ${verdict.logLine}`);
}
