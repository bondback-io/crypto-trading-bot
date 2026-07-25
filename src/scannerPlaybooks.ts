/**
 * Scanner playbook classifier — maps TA / pattern / indicator evidence into
 * named setups with confluence scores. Quality over frequency.
 */

import type { IndicatorReport } from './indicators';
import type { ChartPatternReport } from './chartPatterns';
import type { TechnicalSnapshot } from './technicalLevels';
import { getPlaybookWeights, type ScannerPlaybookId } from './scannerOutcomes';

export type { ScannerPlaybookId };

export const SCANNER_PLAYBOOKS = [
  'dip_reclaim',
  'bull_flag_break',
  'curve_migration_sniper',
  'momentum_continuation',
  'failed_breakdown_reclaim',
] as const;

export interface ScannerPlaybookInput {
  migrated?: boolean;
  isPumpFun?: boolean;
  nearMigration?: boolean;
  curveProgressPct?: number | null;
  priceChangePct?: number | null;
  priceChangeH1Pct?: number | null;
  nearKeyFib?: boolean;
  nearSupport?: boolean;
  nearResistance?: boolean;
  tech?: TechnicalSnapshot | null;
  patterns?: ChartPatternReport | null;
  indicators?: IndicatorReport | null;
  postRunDipQualifies?: boolean;
  mtfAligned?: boolean;
  structureBearish?: boolean;
  rsiReset?: boolean;
  /** Soft weight from outcome stats (default 1) */
  outcomeWeight?: number;
  minConfluence?: number;
}

export interface ScannerPlaybookResult {
  playbook: ScannerPlaybookId | null;
  confluence: number;
  reasons: string[];
  mtfAligned: boolean;
  allowed: boolean;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function hasPattern(
  patterns: ChartPatternReport | null | undefined,
  id: string,
  minConf = 50
): { hit: boolean; conf: number; breakout: boolean } {
  const all = [
    ...(patterns?.bullish ?? []),
    ...(patterns?.patterns ?? []),
  ];
  let best = { hit: false, conf: 0, breakout: false };
  for (const p of all) {
    if (p.id === id && p.confidence >= minConf && p.confidence >= best.conf) {
      best = { hit: true, conf: p.confidence, breakout: Boolean(p.breakout) };
    }
  }
  return best;
}

/**
 * Classify a ranked launch into the best matching playbook.
 * Does not re-fetch — uses TA already computed by the scanner.
 */
export function classifyScannerPlaybook(
  input: ScannerPlaybookInput
): ScannerPlaybookResult {
  const reasons: string[] = [];
  const ind = input.indicators;
  const mtfAligned = input.mtfAligned === true;
  const weights = getPlaybookWeights();
  const minConf = input.minConfluence ?? 55;

  type Candidate = {
    id: ScannerPlaybookId;
    raw: number;
    why: string[];
  };
  const candidates: Candidate[] = [];

  // dip_reclaim — pullback + support/Fib + RSI reset / PRD
  {
    const chg = Number(input.priceChangePct ?? input.priceChangeH1Pct ?? 0);
    const pullback = (Number.isFinite(chg) && chg < -12 && chg > -60) ||
      ind?.flags?.includes('mom_dip') === true ||
      ind?.flags?.includes('rsi_oversold') === true ||
      ind?.flags?.includes('rsi_reset') === true;
    let raw = 0;
    const why: string[] = [];
    if (pullback) {
      raw += 28;
      why.push('pullback');
    }
    if (input.nearSupport || input.nearKeyFib) {
      raw += 22;
      why.push(input.nearKeyFib ? 'fib' : 'support');
    }
    if (input.postRunDipQualifies) {
      raw += 18;
      why.push('prd');
    }
    if (ind?.flags?.includes('rsi_reset') || ind?.flags?.includes('rsi_oversold')) {
      raw += 12;
      why.push('rsi');
    }
    if (input.structureBearish && input.rsiReset) {
      raw += 8;
      why.push('struct soft-bear + rsi');
    }
    if (raw >= 40) {
      candidates.push({ id: 'dip_reclaim', raw, why });
    }
  }

  // bull_flag_break
  {
    const flag = hasPattern(input.patterns, 'bull_flag', 50);
    const cont = hasPattern(input.patterns, 'trend_continuation', 50);
    let raw = 0;
    const why: string[] = [];
    if (flag.hit) {
      raw += flag.breakout ? 40 : 28;
      why.push(flag.breakout ? 'flag break' : 'flag forming');
      raw += Math.min(15, Math.round(flag.conf / 8));
    }
    if (cont.hit && cont.breakout) {
      raw += 18;
      why.push('trend cont');
    }
    if (ind?.flags?.includes('above_vwap')) {
      raw += 10;
      why.push('above_vwap');
    }
    if (ind?.emaBullishCross) {
      raw += 10;
      why.push('ema↑');
    }
    if (input.nearResistance && !flag.breakout && !cont.breakout) {
      raw -= 12;
      why.push('resist w/o break');
    }
    if (raw >= 40) {
      candidates.push({ id: 'bull_flag_break', raw, why });
    }
  }

  // curve_migration_sniper
  {
    let raw = 0;
    const why: string[] = [];
    if (input.migrated) {
      raw += 35;
      why.push('migrated');
    }
    if (input.nearMigration || (input.curveProgressPct != null && input.curveProgressPct >= 70)) {
      raw += 30;
      why.push('near migrate');
    }
    if (input.isPumpFun && !input.migrated) {
      raw += 10;
      why.push('pump curve');
    }
    if (input.nearKeyFib || input.nearSupport) {
      raw += 12;
      why.push('ta zone');
    }
    if (raw >= 40) {
      candidates.push({ id: 'curve_migration_sniper', raw, why });
    }
  }

  // momentum_continuation
  {
    const chg = Number(input.priceChangeH1Pct ?? input.priceChangePct ?? 0);
    let raw = 0;
    const why: string[] = [];
    if (Number.isFinite(chg) && chg >= 12 && chg <= 90) {
      raw += 28;
      why.push('mom');
    }
    if (ind?.flags?.includes('mom_up')) {
      raw += 14;
      why.push('mom_up');
    }
    if (ind?.emaBullishCross) {
      raw += 12;
      why.push('ema↑');
    }
    if (hasPattern(input.patterns, 'trend_continuation', 55).hit) {
      raw += 16;
      why.push('trend pat');
    }
    if (mtfAligned) {
      raw += 12;
      why.push('mtf');
    }
    if (input.structureBearish) {
      raw -= 20;
      why.push('struct bear');
    }
    if (raw >= 42) {
      candidates.push({ id: 'momentum_continuation', raw, why });
    }
  }

  // failed_breakdown_reclaim
  {
    const cap = hasPattern(input.patterns, 'capitulation', 50);
    const wedge = hasPattern(input.patterns, 'falling_wedge', 50);
    let raw = 0;
    const why: string[] = [];
    if (cap.hit || wedge.hit) {
      raw += 30;
      why.push(cap.hit ? 'capitulation' : 'wedge');
    }
    if (input.nearSupport || input.nearKeyFib) {
      raw += 18;
      why.push('reclaim zone');
    }
    if (ind?.flags?.includes('rsi_oversold') || ind?.flags?.includes('rsi_reset')) {
      raw += 14;
      why.push('rsi reclaim');
    }
    const chg = Number(input.priceChangePct ?? 0);
    if (Number.isFinite(chg) && chg < -20 && chg > -70) {
      raw += 12;
      why.push('failed dump');
    }
    if (raw >= 40) {
      candidates.push({ id: 'failed_breakdown_reclaim', raw, why });
    }
  }

  if (candidates.length === 0) {
    return {
      playbook: null,
      confluence: 0,
      reasons: ['no playbook'],
      mtfAligned,
      allowed: false,
    };
  }

  // Soft weight from outcome WR
  for (const c of candidates) {
    const w = input.outcomeWeight ?? weights[c.id] ?? 1;
    c.raw = c.raw * clamp(w, 0.55, 1.15);
  }
  candidates.sort((a, b) => b.raw - a.raw);
  const best = candidates[0]!;
  let confluence = clamp(Math.round(best.raw), 0, 100);
  if (mtfAligned) {
    confluence = clamp(confluence + 4, 0, 100);
    reasons.push('mtf aligned');
  }
  reasons.push(...best.why.slice(0, 4));
  reasons.push(`pb:${best.id}`);

  const allowed = confluence >= minConf;
  return {
    playbook: best.id,
    confluence,
    reasons,
    mtfAligned,
    allowed,
  };
}
