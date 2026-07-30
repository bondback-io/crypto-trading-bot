/**
 * Smoke: Dip Buyer phantom mark + exit MC display hardening.
 * Run: npx tsx scripts/smokeDipExitMc.ts
 */
import {
  reconcileMarkPriceSol,
  resolveExitMarketCaps,
} from '../src/marketData';
import {
  evaluateProfitAction,
  SWING_HARD_SL_GRACE_MS,
  type ProfitPositionView,
} from '../src/profitStrategy';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

const r = reconcileMarkPriceSol({
  entryPriceSol: 1,
  markPriceSol: 0.83,
  entryMarketCapUsd: 2.9e6,
  markMarketCapUsd: 2.85e6,
  positionAgeMs: 5_000,
});
check('early mark/MC disagree rejected', r.rejected === true, r.reason);

const r2 = reconcileMarkPriceSol({
  entryPriceSol: 1,
  markPriceSol: 0.83,
  entryMarketCapUsd: 2.9e6,
  markMarketCapUsd: 2.85e6,
  positionAgeMs: 60_000,
});
check('after grace mark accepted', r2.rejected === false, String(r2.priceSol));

const caps = resolveExitMarketCaps({
  entryMarketCapUsd: 2.9e6,
  entryPriceSol: 1,
  exitPriceSol: 0.83,
  liveMarketCapUsd: 2.85e6,
});
check(
  'display prefers live Dex MC',
  Math.abs((caps.displayUsd || 0) - 2.85e6) < 1,
  `display=${caps.displayUsd} src=${caps.source}`
);
check(
  'implied still fill-scaled',
  Math.abs((caps.impliedFromFillUsd || 0) - 2.9e6 * 0.83) < 1e3,
  String(caps.impliedFromFillUsd)
);

const base: ProfitPositionView = {
  entryPriceSol: 1,
  currentPriceSol: 0.83,
  highWaterMarkSol: 1,
  amountTokens: 100,
  initialAmountTokens: 100,
  initialCostSol: 1,
  solReturned: 0,
  trailingActive: false,
  trailingStopPct: 14,
  stopLossPct: -15,
  maxProfitPct: 50,
  initialRecovered: false,
  partialSellDone: false,
  bagTrimDone: false,
  openedAt: Date.now() - 3_000,
  tradeProfileId: 'dip_buyer',
  scalpMode: false,
};
const act = evaluateProfitAction(base);
check(
  'dip swing SL grace blocks instant hard_sl',
  act.type === 'none',
  act.type === 'hard_sl' ? act.reason : act.type
);

const act2 = evaluateProfitAction({
  ...base,
  openedAt: Date.now() - (SWING_HARD_SL_GRACE_MS + 1000),
});
check('after grace hard_sl fires', act2.type === 'hard_sl', act2.type);

console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
