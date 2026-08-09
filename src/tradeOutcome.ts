/**
 * Shared closed-trade outcome classifier for WR / W-L display surfaces.
 *
 * - win  iff pnlSol > 0
 * - loss iff pnlSol < 0
 * - scratch (≈0) excluded from WR denominator (wins + losses)
 */

/** Absolute SOL epsilon treated as scratch (flat) PnL. */
export const TRADE_OUTCOME_SCRATCH_EPS_SOL = 1e-9;

export type TradeOutcomeKind = 'win' | 'loss' | 'scratch';

export function classifyTradeOutcomePnlSol(
  pnlSol: number | null | undefined
): TradeOutcomeKind {
  const n = Number(pnlSol);
  if (!Number.isFinite(n) || Math.abs(n) <= TRADE_OUTCOME_SCRATCH_EPS_SOL) {
    return 'scratch';
  }
  return n > 0 ? 'win' : 'loss';
}

export function isWinPnlSol(pnlSol: number | null | undefined): boolean {
  return classifyTradeOutcomePnlSol(pnlSol) === 'win';
}

export function isLossPnlSol(pnlSol: number | null | undefined): boolean {
  return classifyTradeOutcomePnlSol(pnlSol) === 'loss';
}

export function isScratchPnlSol(pnlSol: number | null | undefined): boolean {
  return classifyTradeOutcomePnlSol(pnlSol) === 'scratch';
}

/** Win rate % from W/L only (scratches excluded). */
export function winRatePctFromWl(
  wins: number,
  losses: number
): number {
  const w = Math.max(0, Math.round(Number(wins) || 0));
  const l = Math.max(0, Math.round(Number(losses) || 0));
  const d = w + l;
  return d > 0 ? (w / d) * 100 : 0;
}

/**
 * True when displayed WR matches round(wins/(wins+losses)*100).
 * When there are no decided trades, consistent iff displayed is 0/nullish.
 */
export function wrDisplayConsistent(input: {
  wins: number;
  losses: number;
  winRatePct: number | null | undefined;
}): boolean {
  const w = Math.max(0, Number(input.wins) || 0);
  const l = Math.max(0, Number(input.losses) || 0);
  const decided = w + l;
  const displayed = Number(input.winRatePct);
  if (decided <= 0) {
    return !Number.isFinite(displayed) || displayed === 0;
  }
  if (!Number.isFinite(displayed)) return false;
  const expected = Math.round((w / decided) * 100);
  return Math.round(displayed) === expected;
}
