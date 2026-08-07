/**
 * Smoke: Dip Buyer phantom mark + exit MC display hardening.
 * Run: npx tsx scripts/smokeDipExitMc.ts
 */
import {
  MAX_MARK_TICK_PUMP_PCT,
  PHANTOM_DUMP_MC_GATE_MS,
  isHardStopLossMarkTrusted,
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

const rMid = reconcileMarkPriceSol({
  entryPriceSol: 1,
  markPriceSol: 0.83,
  entryMarketCapUsd: 2.9e6,
  markMarketCapUsd: 2.85e6,
  positionAgeMs: 60_000,
});
check(
  'within 120s mark/MC disagree still rejected',
  rMid.rejected === true,
  rMid.reason
);

const r2 = reconcileMarkPriceSol({
  entryPriceSol: 1,
  markPriceSol: 0.83,
  entryMarketCapUsd: 2.9e6,
  markMarketCapUsd: 2.85e6,
  positionAgeMs: PHANTOM_DUMP_MC_GATE_MS + 1_000,
});
check(
  'after 120s flat-MC dump still rejected',
  r2.rejected === true,
  r2.reason
);

const rConfirmDump = reconcileMarkPriceSol({
  entryPriceSol: 1,
  markPriceSol: 0.83,
  entryMarketCapUsd: 2.9e6,
  markMarketCapUsd: 2.4e6,
  positionAgeMs: 30_000,
});
check(
  'dump + Dex also down accepted',
  rConfirmDump.rejected === false,
  String(rConfirmDump.priceSol)
);

// No circ MC + hard-SL-depth dump → reject (FDV-stripped markMc path)
const noMcDump = reconcileMarkPriceSol({
  entryPriceSol: 1,
  markPriceSol: 0.62,
  entryMarketCapUsd: 2.9e6,
  markMarketCapUsd: null,
  positionAgeMs: 180_000,
});
check(
  'unconfirmed dump without MC rejected',
  noMcDump.rejected === true,
  noMcDump.reason
);

// TROLL-class: price +37% but Dex MC still ~flat → early phantom pump rejected
const pumpEarly = reconcileMarkPriceSol({
  entryPriceSol: 0.000521,
  markPriceSol: 0.000716,
  entryMarketCapUsd: 37.35e6,
  markMarketCapUsd: 37.5e6,
  positionAgeMs: 30_000,
});
check(
  'early phantom pump rejected (px +37% vs flat MC)',
  pumpEarly.rejected === true,
  pumpEarly.reason
);

// Price leads MC by >8pp after gate window → clamp to MC-implied
const pumpClamp = reconcileMarkPriceSol({
  entryPriceSol: 1,
  markPriceSol: 1.37,
  entryMarketCapUsd: 37e6,
  markMarketCapUsd: 40e6, // +8.1% MC vs +37% price
  positionAgeMs: PHANTOM_DUMP_MC_GATE_MS + 5_000,
});
check(
  'price-ahead-of-MC clamped to MC-implied',
  pumpClamp.rejected === false &&
    pumpClamp.adjusted === true &&
    Math.abs(pumpClamp.priceSol - 1 * (40e6 / 37e6)) < 0.01,
  String(pumpClamp.priceSol)
);

// Confirmed pump (price + MC both up ~same) accepted
const pumpOk = reconcileMarkPriceSol({
  entryPriceSol: 1,
  markPriceSol: 1.2,
  entryMarketCapUsd: 37e6,
  markMarketCapUsd: 44e6,
  positionAgeMs: 60_000,
});
check(
  'confirmed pump accepted',
  pumpOk.rejected === false && pumpOk.adjusted === false,
  String(pumpOk.priceSol)
);

// Tick spike without MC confirmation
const tick = reconcileMarkPriceSol({
  entryPriceSol: 1,
  markPriceSol: 1.3,
  entryMarketCapUsd: 37e6,
  markMarketCapUsd: 37.2e6,
  positionAgeMs: PHANTOM_DUMP_MC_GATE_MS + 1_000,
  prevMarkPriceSol: 1.0,
});
check(
  'tick pump capped',
  tick.adjusted === true &&
    tick.priceSol <= 1 * (1 + MAX_MARK_TICK_PUMP_PCT / 100) + 1e-9,
  String(tick.priceSol)
);

// Confirmed dump with prior mark: MC-aligned clamp / tick floor — must not reject
const tickDump = reconcileMarkPriceSol({
  entryPriceSol: 1,
  markPriceSol: 0.7,
  entryMarketCapUsd: 37e6,
  markMarketCapUsd: 30e6,
  positionAgeMs: PHANTOM_DUMP_MC_GATE_MS + 1_000,
  prevMarkPriceSol: 1.0,
});
check(
  'confirmed dump accepted (MC also down)',
  tickDump.rejected === false && tickDump.priceSol > 0.65,
  String(tickDump.priceSol)
);

const tickDumpFlatMc = reconcileMarkPriceSol({
  entryPriceSol: 1,
  markPriceSol: 0.7,
  entryMarketCapUsd: 37e6,
  markMarketCapUsd: 36.5e6,
  positionAgeMs: 60_000,
  prevMarkPriceSol: 1.0,
});
check(
  'tick dump with flat MC rejected',
  tickDumpFlatMc.rejected === true,
  tickDumpFlatMc.reason
);

const caps = resolveExitMarketCaps({
  entryMarketCapUsd: 2.9e6,
  entryPriceSol: 1,
  exitPriceSol: 0.83,
  liveMarketCapUsd: 2.85e6,
});
check(
  'display prefers fill-implied (not Dex live)',
  Math.abs((caps.displayUsd || 0) - 2.9e6 * 0.83) < 1e3,
  `display=${caps.displayUsd} src=${caps.source}`
);
check(
  'implied still fill-scaled',
  Math.abs((caps.impliedFromFillUsd || 0) - 2.9e6 * 0.83) < 1e3,
  String(caps.impliedFromFillUsd)
);
check(
  'liveUsd preserved for tooltip',
  Math.abs((caps.liveUsd || 0) - 2.85e6) < 1,
  String(caps.liveUsd)
);

// fomodog-class: −19% fill vs +39% Dex MC → column must follow fill
const fomo = resolveExitMarketCaps({
  entryMarketCapUsd: 23_000,
  entryPriceSol: 1,
  exitPriceSol: 0.81,
  liveMarketCapUsd: 32_000,
});
check(
  'fomodog: Exit MC tracks −19% fill not Dex $32K',
  Math.abs((fomo.displayUsd || 0) - 23_000 * 0.81) < 1,
  `display=${fomo.displayUsd} live=${fomo.liveUsd}`
);
check('fomodog source is implied', fomo.source === 'implied', fomo.source);

// Hard SL trust: flat MC must not authorize −38% floor fills
const slTrustBad = isHardStopLossMarkTrusted({
  entryPriceSol: 1,
  markPriceSol: 0.6,
  entryMarketCapUsd: 10e6,
  markMarketCapUsd: 9.8e6,
  hardSlPct: -34,
});
check(
  'hard SL deferred when MC flat',
  slTrustBad.trusted === false,
  slTrustBad.reason
);

const slTrustOk = isHardStopLossMarkTrusted({
  entryPriceSol: 1,
  markPriceSol: 0.6,
  entryMarketCapUsd: 10e6,
  markMarketCapUsd: 6.2e6,
  hardSlPct: -34,
});
check(
  'hard SL allowed when MC confirms dump',
  slTrustOk.trusted === true,
  slTrustOk.reason
);

const slTrustNoMc = isHardStopLossMarkTrusted({
  entryPriceSol: 1,
  markPriceSol: 0.6,
  entryMarketCapUsd: 10e6,
  markMarketCapUsd: null,
  hardSlPct: -34,
});
check(
  'hard SL deferred without mark MC',
  slTrustNoMc.trusted === false,
  slTrustNoMc.reason
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
