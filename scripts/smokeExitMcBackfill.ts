/**
 * Smoke: historical Exit MC backfill aligns to fill, leaves PnL alone.
 * Run: npx tsx scripts/smokeExitMcBackfill.ts
 */
import { alignClosedExitMarketCapToFill } from '../src/marketData';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

// fomodog-class: Dex Exit MC up, fill dump −19%
const fomo = alignClosedExitMarketCapToFill({
  entryMarketCapUsd: 23_000,
  entryPriceSol: 1,
  exitPriceSol: 0.81,
  exitMarketCapUsd: 32_000,
  pnlPct: -19,
});
check('fomodog Exit MC rewritten to fill', fomo.changed === true);
check(
  'fomodog display ~18630',
  Math.abs((fomo.pos.exitMarketCapUsd || 0) - 23_000 * 0.81) < 1,
  String(fomo.pos.exitMarketCapUsd)
);
check(
  'fomodog preserves Dex as liveExit',
  Math.abs((fomo.pos.liveExitMarketCapUsd || 0) - 32_000) < 1,
  String(fomo.pos.liveExitMarketCapUsd)
);
check('fomodog PnL untouched', fomo.pos.pnlPct === -19);

const already = alignClosedExitMarketCapToFill({
  entryMarketCapUsd: 100_000,
  entryPriceSol: 1,
  exitPriceSol: 1.05,
  exitMarketCapUsd: 105_000,
  impliedExitMarketCapUsd: 105_000,
  pnlPct: 3,
});
check('already aligned is no-op', already.changed === false);

const fromImplied = alignClosedExitMarketCapToFill({
  entryMarketCapUsd: 674_000,
  entryPriceSol: 1,
  exitPriceSol: 0.85,
  exitMarketCapUsd: 690_000,
  impliedExitMarketCapUsd: 674_000 * 0.85,
  pnlPct: -15,
});
check('uses stored implied when present', fromImplied.changed === true);
check(
  'SOLNUT-class Exit MC = implied',
  Math.abs((fromImplied.pos.exitMarketCapUsd || 0) - 674_000 * 0.85) < 1,
  String(fromImplied.pos.exitMarketCapUsd)
);
check('SOLNUT PnL untouched', fromImplied.pos.pnlPct === -15);

console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
