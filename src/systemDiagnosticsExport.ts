/**
 * Read-only system diagnostics export for AI agents (Grok / Cursor).
 * Aggregates Expectancy Lift, Learning Metrics, Trade Craft, funnel, governors,
 * exit/harvest, entry timing, size/risk, lane inventory, and learning mutations.
 * No trading-logic side effects.
 */

import { config } from './config';
import { paperTrader } from './paperTrader';
import {
  getExpectancyLiftStatus,
  parseExpectancyWindow,
  type ExpectancyWindow,
} from './expectancyLift';
import { getLearningMetricsPanel } from './learningMetricsPanel';
import { buildTradeCraftPerformance } from './tradeCraftPerformance';
import {
  getProfileLearningEpisodes,
  type ProfileLearningEpisode,
} from './profileLearningEpisodes';
import { TRADE_PROFILE_CATALOG } from './tradeProfiles';

/** Near-term / stretch targets for Target Gap panel. */
const TARGET_WR_NEAR_LO = 40;
const TARGET_WR_NEAR_HI = 45;
const TARGET_WR_STRETCH = 60;
const TARGET_ARMED_PCT = 90;
const TARGET_LATE_CHASE_PCT = 5;
const TARGET_CAPTURE_PCT = 35;
const TARGET_AVG_WL_RATIO = 1.2;

function pad(s: string, n: number): string {
  const t = String(s ?? '');
  if (t.length >= n) return t.slice(0, n);
  return t + ' '.repeat(n - t.length);
}

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return Number(n).toFixed(digits);
}

function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

function fmtSignedPct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const v = Number(n);
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

function fmtGapPp(current: number, target: number): string {
  const gap = current - target;
  return `${gap >= 0 ? '+' : ''}${gap.toFixed(1)}pp`;
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const a = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  if (a.length % 2 === 0) {
    return (a[mid - 1]! + a[mid]!) / 2;
  }
  return a[mid]!;
}

function modeLabel(): string {
  const m = String(config.mode || 'paper');
  if (m === 'liveSimulation') return 'live_sim';
  if (m === 'live') return 'live';
  return 'paper';
}

function collectWindowEpisodes(window: number): ProfileLearningEpisode[] {
  const all: ProfileLearningEpisode[] = [];
  for (const p of TRADE_PROFILE_CATALOG) {
    if (p.id === 'default' || p.id === 'zion') continue;
    try {
      const eps = getProfileLearningEpisodes(p.id, Math.max(window * 2, 100));
      all.push(...eps);
    } catch {
      /* soft */
    }
  }
  all.sort((a, b) => Number(a.closedAt || 0) - Number(b.closedAt || 0));
  return all.slice(-window);
}

function deriveOperatorFlags(input: {
  expectancyPct: number | null;
  armedShare: number | null;
  armedTarget: number;
  lateChaseShare: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  armToOpenPct: number | null;
  triggerToOpenPct: number | null;
  maxDrawdownPct: number | null;
  quietSteadyHwr: string[];
  restrictedPositiveNative: string[];
  winRatePct: number | null;
  capturePct: number | null;
  zeroMfePct: number | null;
  greenThenRedPct: number | null;
}): string[] {
  const flags: string[] = [];
  if (input.expectancyPct != null && input.expectancyPct < 0) {
    flags.push(`negative_expectancy E=${fmtSignedPct(input.expectancyPct)}`);
  }
  if (
    input.armedShare != null &&
    input.armedShare * 100 < input.armedTarget - 5
  ) {
    flags.push(
      `armed_below_target ${(input.armedShare * 100).toFixed(0)}% < ${input.armedTarget}%`
    );
  }
  if (input.lateChaseShare != null && input.lateChaseShare > 0.05) {
    flags.push(
      `late_chase_above_target ${(input.lateChaseShare * 100).toFixed(0)}% > 5%`
    );
  }
  if (
    input.avgWinPct != null &&
    input.avgLossPct != null &&
    Math.abs(input.avgLossPct) > Math.abs(input.avgWinPct)
  ) {
    flags.push(
      `avg_loss_gt_avg_win avgW=${fmtNum(input.avgWinPct, 1)}% avgL=${fmtNum(input.avgLossPct, 1)}%`
    );
  }
  for (const q of input.quietSteadyHwr) {
    flags.push(`quiet_steady_hwr ${q}`);
  }
  for (const r of input.restrictedPositiveNative) {
    flags.push(`restricted_positive_native ${r}`);
  }
  if (input.maxDrawdownPct != null && input.maxDrawdownPct > 100.5) {
    flags.push(`max_dd_anomaly ${fmtNum(input.maxDrawdownPct, 1)}%`);
  }
  if (
    (input.triggerToOpenPct != null && input.triggerToOpenPct < 15) ||
    (input.armToOpenPct != null && input.armToOpenPct < 10)
  ) {
    flags.push(
      `weak_open_conversion trig→open=${input.triggerToOpenPct ?? '—'}% arm→open=${input.armToOpenPct ?? '—'}%`
    );
  }
  if (input.winRatePct != null && input.winRatePct * 100 < TARGET_WR_NEAR_LO) {
    flags.push(
      `wr_below_near_target ${(input.winRatePct * 100).toFixed(1)}% < ${TARGET_WR_NEAR_LO}%`
    );
  }
  if (
    input.capturePct != null &&
    Number.isFinite(input.capturePct) &&
    input.capturePct < TARGET_CAPTURE_PCT
  ) {
    flags.push(
      `capture_below_target ${fmtNum(input.capturePct, 0)}% < ${TARGET_CAPTURE_PCT}%`
    );
  }
  if (
    input.avgWinPct != null &&
    input.avgLossPct != null &&
    Math.abs(input.avgLossPct) > 1e-9
  ) {
    const ratio = Math.abs(input.avgWinPct) / Math.abs(input.avgLossPct);
    if (ratio < TARGET_AVG_WL_RATIO) {
      flags.push(
        `avgWL_ratio_below_target ${ratio.toFixed(2)} < ${TARGET_AVG_WL_RATIO}`
      );
    }
  }
  if (input.zeroMfePct != null && input.zeroMfePct >= 0.25) {
    flags.push(`high_zero_mfe_share ${(input.zeroMfePct * 100).toFixed(0)}%`);
  }
  if (input.greenThenRedPct != null && input.greenThenRedPct >= 0.2) {
    flags.push(
      `high_green_then_red ${(input.greenThenRedPct * 100).toFixed(0)}%`
    );
  }
  return flags;
}

function buildTargetGapLines(input: {
  winRate: number | null;
  armedShare: number | null;
  lateChaseShare: number | null;
  capturePct: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
}): string[] {
  const lines: string[] = [];
  const wr =
    input.winRate != null && Number.isFinite(input.winRate)
      ? input.winRate * 100
      : null;
  if (wr != null) {
    lines.push(
      `WR ${wr.toFixed(1)}% → near-term ${TARGET_WR_NEAR_LO}–${TARGET_WR_NEAR_HI}% (gap ${fmtGapPp(wr, TARGET_WR_NEAR_LO)} to floor) · stretch ${TARGET_WR_STRETCH}% (gap ${fmtGapPp(wr, TARGET_WR_STRETCH)})`
    );
  } else {
    lines.push(`WR — → near-term ${TARGET_WR_NEAR_LO}–${TARGET_WR_NEAR_HI}% · stretch ${TARGET_WR_STRETCH}%`);
  }

  const armed =
    input.armedShare != null ? input.armedShare * 100 : null;
  lines.push(
    armed != null
      ? `armed ${armed.toFixed(0)}% → target ${TARGET_ARMED_PCT}% (gap ${fmtGapPp(armed, TARGET_ARMED_PCT)})`
      : `armed — → target ${TARGET_ARMED_PCT}%`
  );

  const late =
    input.lateChaseShare != null ? input.lateChaseShare * 100 : null;
  lines.push(
    late != null
      ? `late-chase ${late.toFixed(0)}% → target ≤${TARGET_LATE_CHASE_PCT}% (gap ${fmtGapPp(late, TARGET_LATE_CHASE_PCT)})`
      : `late-chase — → target ≤${TARGET_LATE_CHASE_PCT}%`
  );

  const cap = input.capturePct;
  lines.push(
    cap != null && Number.isFinite(cap)
      ? `capture ${fmtNum(cap, 0)}% → target ≥${TARGET_CAPTURE_PCT}% (gap ${fmtGapPp(cap, TARGET_CAPTURE_PCT)})`
      : `capture — → target ≥${TARGET_CAPTURE_PCT}%`
  );

  if (
    input.avgWinPct != null &&
    input.avgLossPct != null &&
    Math.abs(input.avgLossPct) > 1e-9
  ) {
    const ratio = Math.abs(input.avgWinPct) / Math.abs(input.avgLossPct);
    lines.push(
      `avgW/|avgL| ${ratio.toFixed(2)} (avgW=${fmtNum(input.avgWinPct, 1)}% avgL=${fmtNum(input.avgLossPct, 1)}%) → target ≥${TARGET_AVG_WL_RATIO} (gap ${fmtGapPp(ratio * 100, TARGET_AVG_WL_RATIO * 100)} scaled)`
    );
  } else {
    lines.push(
      `avgW/|avgL| — → target ≥${TARGET_AVG_WL_RATIO}`
    );
  }
  return lines;
}

function buildExitHarvestLines(
  eps: ProfileLearningEpisode[],
  craft: ReturnType<typeof buildTradeCraftPerformance> | null
): { lines: string[]; zeroMfePct: number | null; greenThenRedPct: number | null } {
  const lines: string[] = [];
  const n = eps.length;
  if (n <= 0) {
    lines.push('(no episodes in window)');
    return { lines, zeroMfePct: null, greenThenRedPct: null };
  }

  const reasonCounts = new Map<string, number>();
  for (const e of eps) {
    const key = String(e.exitKey || e.exitReason || 'unknown')
      .toLowerCase()
      .slice(0, 48);
    reasonCounts.set(key, (reasonCounts.get(key) || 0) + 1);
  }
  const ranked = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, 12);
  const topN = top.reduce((s, [, c]) => s + c, 0);
  const other = n - topN;
  lines.push('exitReason % (top 12):');
  for (const [k, c] of top) {
    lines.push(`  ${(c / n * 100).toFixed(1)}%  ${c}×  ${k}`);
  }
  if (other > 0) {
    lines.push(`  ${(other / n * 100).toFixed(1)}%  ${other}×  other`);
  }

  if (craft?.exitMix?.length) {
    lines.push(
      `craft exitMix: ${craft.exitMix
        .slice(0, 8)
        .map((b) => `${b.key}=${b.n}(${fmtNum(b.pct, 0)}%)`)
        .join(' · ')}`
    );
  }

  const partialSecs: number[] = [];
  for (const e of eps) {
    if (e.pclPartialTaken !== true) continue;
    const at = Number(e.pclPartialAtMs);
    const opened = Number(e.openedAt);
    if (Number.isFinite(at) && Number.isFinite(opened) && at > opened) {
      partialSecs.push((at - opened) / 1000);
    }
  }
  const medPartial = median(partialSecs);
  lines.push(
    `medianTimeToFirstPartialSec=${medPartial != null ? fmtNum(medPartial, 0) : 'n/a'} (n=${partialSecs.length})`
  );

  const pppArmSecs: number[] = [];
  for (const e of eps) {
    const t = Number(e.timeToArmSec);
    if (Number.isFinite(t) && t >= 0) pppArmSecs.push(t);
  }
  const medPpp = median(pppArmSecs);
  lines.push(
    `medianTimeToFirstMfeSec=n/a (HWM timestamp not stamped) · proxy medianTimeToPppArmSec=${medPpp != null ? fmtNum(medPpp, 0) : 'n/a'} (n=${pppArmSecs.length})`
  );

  const zeroMfe = eps.filter((e) => (Number(e.maxRunupPct) || 0) <= 0).length;
  const greenThenRed = eps.filter(
    (e) => (Number(e.maxRunupPct) || 0) >= 1 && (Number(e.pnlPct) || 0) < 0
  ).length;
  const zeroMfePct = zeroMfe / n;
  const greenThenRedPct = greenThenRed / n;
  lines.push(
    `%maxRunup<=0=${(zeroMfePct * 100).toFixed(1)}% (${zeroMfe}/${n}) · %greenThenClosedRed=${(greenThenRedPct * 100).toFixed(1)}% (${greenThenRed}/${n})`
  );
  lines.push(
    'capture by profile: see §2 PROFILE TABLE / §5 TRADE CRAFT'
  );
  return { lines, zeroMfePct, greenThenRedPct };
}

function buildEntryTimingLines(
  eps: ProfileLearningEpisode[],
  funnel: {
    armToTriggerMs?: number | null;
    blockedSecondPass?: number;
  },
  blockedSecondPass: number
): string[] {
  const lines: string[] = [];
  let armToTrigMs: number | null =
    funnel.armToTriggerMs != null && Number.isFinite(funnel.armToTriggerMs)
      ? Number(funnel.armToTriggerMs)
      : null;
  try {
    const { getSetupWatchDiagnostics } =
      require('./profileAttention') as typeof import('./profileAttention');
    const d = getSetupWatchDiagnostics();
    if (d.armToTriggerLatencyMs != null && Number.isFinite(d.armToTriggerLatencyMs)) {
      armToTrigMs = Number(d.armToTriggerLatencyMs);
    }
  } catch {
    /* soft */
  }
  lines.push(
    `median arm→trigger=${armToTrigMs != null ? fmtNum(armToTrigMs / 1000, 1) + 's' : 'n/a'} (${armToTrigMs != null ? Math.round(armToTrigMs) + 'ms' : '—'})`
  );

  let trigToOpenMed: number | null = null;
  try {
    const { listSetupWatchEvents } =
      require('./setupWatchEvents') as typeof import('./setupWatchEvents');
    const events = listSetupWatchEvents(100);
    const lastTrig = new Map<string, number>();
    const deltas: number[] = [];
    for (const e of [...events].reverse()) {
      const mint = String(e.mint || '');
      if (!mint) continue;
      if (e.kind === 'triggered') {
        lastTrig.set(mint, Number(e.at) || 0);
      } else if (e.kind === 'trigger_opened') {
        const t0 = lastTrig.get(mint);
        const t1 = Number(e.at) || 0;
        if (t0 != null && t1 > t0) deltas.push(t1 - t0);
        lastTrig.delete(mint);
      }
    }
    trigToOpenMed = median(deltas);
    lines.push(
      `median trigger→open=${trigToOpenMed != null ? fmtNum(trigToOpenMed / 1000, 1) + 's' : 'n/a'} (n=${deltas.length} pairs)`
    );
  } catch {
    lines.push('median trigger→open=n/a');
  }

  lines.push(
    'median signal→arm=n/a (candidate→armed timestamp not stamped)'
  );

  const n = eps.length;
  if (n > 0) {
    const late = eps.filter((e) => e.lateChaseAtEntry === true).length;
    const near = eps.filter(
      (e) =>
        e.nearSupportAtEntry === true ||
        (e as { nearMultiTfSupport?: boolean }).nearMultiTfSupport === true
    ).length;
    lines.push(
      `%entries lateChase/extended=${((late / n) * 100).toFixed(1)}% (${late}/${n}) · near-support=${((near / n) * 100).toFixed(1)}% (${near}/${n})`
    );
  } else {
    lines.push('%entries lateChase/extended=— · near-support=—');
  }

  lines.push(`blocked_second_pass count=${blockedSecondPass}`);
  try {
    const { getSetupWatchDiagnostics } =
      require('./profileAttention') as typeof import('./profileAttention');
    const d = getSetupWatchDiagnostics();
    const secondPass = (d.blockReasons || [])
      .filter((r: { reason: string }) =>
        /blocked_second_pass|hard-lock|failed floors|holders|min mc|token age|top10/i.test(
          String(r.reason || '')
        )
      )
      .slice(0, 8);
    if (secondPass.length) {
      lines.push('2nd-pass / floor reject reasons:');
      secondPass.forEach(
        (r: { reason: string; count: number }, i: number) => {
          lines.push(
            `  ${i + 1}. ${r.count}× ${String(r.reason).slice(0, 120)}`
          );
        }
      );
    } else {
      lines.push('2nd-pass top rejects: (none matched in blockReasons)');
    }
  } catch {
    lines.push('2nd-pass top rejects: (diagnostics unavailable)');
  }
  return lines;
}

function buildSizeRiskLines(
  eps: ProfileLearningEpisode[],
  profileIds: string[]
): string[] {
  const lines: string[] = [];
  const open = paperTrader.getOpenPositions?.() || [];
  const concurrent = new Map<string, number>();
  for (const p of open) {
    const id = String(
      (p as { tradeProfileId?: string }).tradeProfileId || 'unknown'
    );
    concurrent.set(id, (concurrent.get(id) || 0) + 1);
  }
  lines.push('open concurrent by profile:');
  if (!concurrent.size) {
    lines.push('  (none open)');
  } else {
    for (const [id, n] of [...concurrent.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    )) {
      lines.push(`  ${pad(id, 18)} ${n}`);
    }
  }

  // Catalog size mult + expectancy size-downrank
  lines.push('size / downrank by profile:');
  for (const id of profileIds) {
    const def = TRADE_PROFILE_CATALOG.find((p) => p.id === id);
    const catalogMult = def?.exitRules?.sizeMultiplier ?? null;
    let sizeNote = '—';
    let mult: number | null = null;
    try {
      const { expectancySizeMultiplier } =
        require('./expectancyLift') as typeof import('./expectancyLift');
      const sz = expectancySizeMultiplier({ profileId: id });
      mult = sz.mult;
      sizeNote = sz.note || '';
    } catch {
      /* soft */
    }
    const openCost = open
      .filter(
        (p) =>
          String((p as { tradeProfileId?: string }).tradeProfileId || '') ===
          id
      )
      .map(
        (p) =>
          Number((p as { costSol?: number }).costSol) ||
          Number((p as { initialCostSol?: number }).initialCostSol) ||
          0
      );
    const avgOpen =
      openCost.length > 0
        ? openCost.reduce((a, b) => a + b, 0) / openCost.length
        : null;
    const down =
      mult != null && mult < 0.99
        ? ` DOWNRANK×${fmtNum(mult, 2)}`
        : mult != null
          ? ` ×${fmtNum(mult, 2)}`
          : '';
    lines.push(
      `  ${pad(id, 18)} catalogMult=${fmtNum(catalogMult, 2)} avgOpenCostSol=${fmtNum(avgOpen, 4)}${down}${sizeNote && sizeNote !== 'expectancy size n/a' && sizeNote !== 'expectancy size' ? ` · ${sizeNote.slice(0, 60)}` : ''}`
    );
  }

  // Loss contribution
  const lossBy = new Map<string, number>();
  let totalLossAbs = 0;
  for (const e of eps) {
    const pnl = Number(e.pnlSol) || 0;
    if (pnl >= 0) continue;
    const abs = Math.abs(pnl);
    totalLossAbs += abs;
    const id = String(e.profileId || 'unknown');
    lossBy.set(id, (lossBy.get(id) || 0) + abs);
  }
  lines.push('% of total realized loss by profile:');
  if (totalLossAbs <= 1e-12) {
    lines.push('  (no losses in window)');
  } else {
    const ranked = [...lossBy.entries()].sort((a, b) => b[1] - a[1]);
    for (const [id, abs] of ranked) {
      lines.push(
        `  ${pad(id, 18)} ${((abs / totalLossAbs) * 100).toFixed(1)}% (${fmtNum(abs, 4)} SOL)`
      );
    }
  }
  return lines;
}

function buildLaneInventoryLines(): string[] {
  const lines: string[] = [];
  try {
    const { getDipMinorLaneHealth, getQualityParkLaneHealth } =
      require('./dipMinorLaneHealth') as typeof import('./dipMinorLaneHealth');
    const dip = getDipMinorLaneHealth();
    lines.push(
      `Dip minors: armed=${dip.minorsArmedNow} watching=${dip.minorsWatchingNow} cap=${dip.minorsCap} filled=${dip.minorsFilled} starved=${dip.starved ? 'yes' : 'no'} topBlock=${dip.topBlockReason ?? '—'}`
    );
    lines.push(
      `  funnel candidatesSeen=${dip.funnel.candidatesSeen} armed=${dip.funnel.armed} trig=${dip.funnel.triggered} open=${dip.funnel.opened} expired=${dip.funnel.expired}`
    );
  } catch (err) {
    lines.push(
      `Dip minors: unavailable (${err instanceof Error ? err.message : String(err)})`
    );
  }

  try {
    const { getQualityParkLaneHealth } =
      require('./dipMinorLaneHealth') as typeof import('./dipMinorLaneHealth');
    const { getQualityParkDenyCounters } =
      require('./qualityParkPlaybook') as typeof import('./qualityParkPlaybook');
    const q = getQualityParkLaneHealth();
    const deny = getQualityParkDenyCounters();
    lines.push(
      `Steady medium ($20M–$200M): armed=${q.steady.armedNow} watching=${q.steady.watchingNow} cand=${q.steady.funnel.candidates_seen} armedF=${q.steady.funnel.armed} trig=${q.steady.funnel.triggered} open=${q.steady.funnel.opened} low_movement=${q.steady.funnel.low_movement} denyTop=${q.steady.topDeny ?? '—'}`
    );
    lines.push(
      `  Steady denies: low_movement=${deny.steady_compounder.low_movement} no_level=${deny.steady_compounder.no_level} mc_band=${deny.steady_compounder.mc_band} soft_allow=${deny.steady_compounder.soft_allow_preview}`
    );
    lines.push(
      `HWR majors: armed=${q.hwr.armedNow} watching=${q.hwr.watchingNow} cand=${q.hwr.funnel.candidates_seen} armedF=${q.hwr.funnel.armed} trig=${q.hwr.funnel.triggered} open=${q.hwr.funnel.opened} low_movement=${q.hwr.funnel.low_movement} denyTop=${q.hwr.topDeny ?? '—'}`
    );
    lines.push(
      `  HWR denies: low_movement=${deny.high_win_rate.low_movement} no_level=${deny.high_win_rate.no_level} mc_band=${deny.high_win_rate.mc_band} soft_allow=${deny.high_win_rate.soft_allow_preview}`
    );
    lines.push(`rotated_stale session=${q.rotatedStaleSession}`);
    for (const p of (q.plainLanguage || []).slice(0, 6)) {
      lines.push(`  ${p}`);
    }
  } catch (err) {
    lines.push(
      `Steady/HWR parks: unavailable (${err instanceof Error ? err.message : String(err)})`
    );
  }

  try {
    const { getDipFunnelCounters } =
      require('./dipSetupWatch') as typeof import('./dipSetupWatch');
    const f = getDipFunnelCounters() as Record<string, number>;
    const exclProxy = Number(f.quality_excluded_proxy) || 0;
    const exclStock = Number(f.quality_excluded_stock) || 0;
    lines.push(
      `excluded stable/wrapper/stock-like (dip funnel): proxy=${exclProxy} stock=${exclStock}`
    );
  } catch {
    /* soft */
  }
  try {
    const { getMajorsUniverseStatus } =
      require('./majorsUniverse') as typeof import('./majorsUniverse');
    const st = getMajorsUniverseStatus();
    const r = st.rejects || {};
    lines.push(
      `excluded (majors universe): stable/proxy=${Number(r.excluded_stable_or_major_asset_proxy) || 0} stock=${Number(r.excluded_stock_name_token) || 0} low_movement=${Number(r.low_movement) || 0} vol=${Number(r.vol) || 0}`
    );
  } catch {
    /* soft */
  }
  return lines;
}

function buildLearningMutationLines(
  profileIds: string[],
  lm: ReturnType<typeof getLearningMetricsPanel>
): string[] {
  const lines: string[] = [];
  try {
    const { LEARNING_PROGRESS_GOAL } =
      require('./profileSelfLearning') as typeof import('./profileSelfLearning');
    const { getTradeProfilesStatus } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    const st = getTradeProfilesStatus();

    let totalEps = 0;
    let totalRollbacks = 0;
    const mutationLines: string[] = [];
    for (const p of st.profiles || []) {
      if (p.id === 'default' || p.id === 'zion') continue;
      if (!profileIds.includes(p.id)) continue;
      const sl = p.selfLearning;
      const prog = p.learningProgress;
      totalEps += prog?.episodes || 0;
      const hist = sl?.history || [];
      const rollbacks = hist.filter((h) => h.rolledBack === true).length;
      totalRollbacks += rollbacks;
      const last = sl?.lastMutation;
      const lastLine = last
        ? `${last.kind || 'tweak'}${last.source ? '/' + last.source : ''}: ${String(last.summary || '').slice(0, 80)}${last.changes ? ' · ' + String(last.changes).slice(0, 60) : ''}`
        : '—';
      mutationLines.push(
        `  ${pad(p.id, 18)} fill=${fmtNum(prog?.pct, 1)}% (${prog?.episodes ?? 0}/${LEARNING_PROGRESS_GOAL}) v${prog?.level ?? 0} rollbacks=${rollbacks} last=${lastLine}`
      );
    }
    const combinedFill =
      profileIds.length > 0
        ? Math.min(
            100,
            Math.round(
              (totalEps /
                (LEARNING_PROGRESS_GOAL * Math.max(1, profileIds.length))) *
                1000
            ) / 10
          )
        : 0;
    lines.push(
      `episode fill (combined across profiles ≈${fmtNum(combinedFill, 1)}% of per-bot goals) · total durable eps≈${totalEps} · rollbacks=${totalRollbacks}`
    );
    lines.push(...mutationLines);
  } catch (err) {
    lines.push(
      `self-learn: unavailable (${err instanceof Error ? err.message : String(err)})`
    );
  }

  lines.push('promotion blockers (LM + RL):');
  try {
    const { getProfileRlStatus } =
      require('./profileRlAgent') as typeof import('./profileRlAgent');
    const rl = getProfileRlStatus({ persist: false, ensureKeyAgents: false });
    const byId = new Map(rl.agents.map((a) => [a.profileId, a]));
    for (const p of lm.profiles) {
      const blockers = [...(p.blockers || [])];
      const agent = byId.get(p.profileId);
      if (agent?.modeBlocker) blockers.push(`RL: ${agent.modeBlocker}`);
      if (!blockers.length) continue;
      lines.push(
        `  ${pad(p.profileId, 18)} ${blockers.map((b) => String(b).slice(0, 90)).join(' | ')}`
      );
    }
  } catch {
    for (const p of lm.profiles) {
      if (!(p.blockers || []).length) continue;
      lines.push(
        `  ${pad(p.profileId, 18)} ${(p.blockers || []).map((b) => String(b).slice(0, 90)).join(' | ')}`
      );
    }
  }

  lines.push('recovery stages (fast profiles):');
  try {
    const { getFastProfileRecoveryPublic } =
      require('./fastProfileRecovery') as typeof import('./fastProfileRecovery');
    const fpr = getFastProfileRecoveryPublic();
    lines.push(
      `  FPR group enabled=${fpr.config?.enabled === true ? 'yes' : 'no'}`
    );
    for (const p of fpr.profiles || []) {
      lines.push(
        `  ${pad(p.profileId, 18)} stage=${p.stage} ${p.stageName || ''} enabled=${p.enabled !== false} recovering=${p.recovering === true ? 'yes' : 'no'}`
      );
    }
  } catch {
    lines.push('  FPR unavailable');
  }
  try {
    const { getDipBuyerRecoveryStatus } =
      require('./dipBuyerRecovery') as typeof import('./dipBuyerRecovery');
    const d = getDipBuyerRecoveryStatus();
    if (d) {
      lines.push(
        `  dip_buyer recovery stage=${d.stage ?? '—'} ${d.stageName || ''} recovering=${d.recovering === true ? 'yes' : 'no'} enabled=${d.enabled === true ? 'yes' : 'no'}`
      );
    }
  } catch {
    /* soft — Dip recovery optional */
  }
  return lines;
}

export interface SystemDiagnosticsExportResult {
  ok: true;
  generatedAt: number;
  mode: string;
  window: ExpectancyWindow;
  reportText: string;
  meta: {
    profileCount: number;
    familyCount: number;
    flagCount: number;
  };
}

/**
 * Build a full AI-readable plain-text system report (read-only).
 */
export function buildSystemDiagnosticsExport(
  windowRaw: unknown = 50
): SystemDiagnosticsExportResult {
  const window = parseExpectancyWindow(windowRaw);
  const generatedAt = Date.now();
  const el = getExpectancyLiftStatus(window);
  const lm = getLearningMetricsPanel(window);
  let craft: ReturnType<typeof buildTradeCraftPerformance> | null = null;
  try {
    craft = buildTradeCraftPerformance('all', window);
  } catch {
    craft = null;
  }

  const stats = paperTrader.getStats();
  const balance = Number(stats.balanceSol) || 0;
  const equity =
    Number((stats as { equitySol?: number }).equitySol) ||
    balance + (Number((stats as { unrealizedPnlSol?: number }).unrealizedPnlSol) || 0);
  const available =
    Number((stats as { availableSol?: number }).availableSol) || balance;
  const openCount = Number(stats.openCount ?? stats.openTrades) || 0;
  const realized =
    Number((stats as { realizedPnlSol?: number }).realizedPnlSol) ||
    Number(stats.netPnlSol) ||
    0;
  const unrealized =
    Number((stats as { unrealizedPnlSol?: number }).unrealizedPnlSol) || 0;
  const daily = Number(stats.dailyPnlSol) || 0;

  const overall = el.profiles.length
    ? {
        winRate: null as number | null,
        expectancyPct: null as number | null,
        profitFactor: null as number | null,
        avgWinPct: null as number | null,
        avgLossPct: null as number | null,
        mfeCapturePct: null as number | null,
        tradeCount: 0,
      }
    : null;

  try {
    const { collectExpectancyTrades, computeExpectancyMetrics } =
      require('./expectancyLift') as typeof import('./expectancyLift');
    const trades = collectExpectancyTrades().slice(-window);
    const m = computeExpectancyMetrics(trades);
    if (overall) {
      overall.winRate = m.winRate;
      overall.expectancyPct = m.expectancyPct;
      overall.profitFactor = m.profitFactor;
      overall.avgWinPct = m.avgWinPct;
      overall.avgLossPct = m.avgLossPct;
      overall.mfeCapturePct = m.mfeCapturePct;
      overall.tradeCount = m.tradeCount;
    }
  } catch {
    /* soft */
  }

  const mix = el.mix;
  const funnel = el.funnel;
  const armedTarget =
    el.entrySkillArmedTargetEffectivePct ??
    el.targets?.armedTargetPct ??
    el.entrySkillArmedTargetPct ??
    80;

  const quietSteadyHwr = (el.quietChips || [])
    .filter(
      (c) =>
        c.profileId === 'steady_compounder' || c.profileId === 'high_win_rate'
    )
    .map((c) => `${c.label}: ${c.reason}`);

  const restrictedPositiveNative = (el.familyRestrictionImpact || [])
    .filter(
      (r) =>
        r.state === 'restricted' &&
        r.expectancyPct != null &&
        r.expectancyPct > -0.5 &&
        (r.winRate == null || r.winRate >= 0.3)
    )
    .map(
      (r) =>
        `${r.family} E=${fmtSignedPct(r.expectancyPct)} natives=${(r.nativeProfiles || []).join('/')}`
    );

  const harvestTrait = craft?.traits?.find((t) => t.id === 'harvest');
  const exitsTrait = craft?.traits?.find((t) => t.id === 'exits');
  const captureCombined =
    harvestTrait?.kpis?.capturePct != null
      ? Number(harvestTrait.kpis.capturePct)
      : overall?.mfeCapturePct ?? mix.avgMfeCapture;
  const givebackCombined =
    harvestTrait?.kpis?.givebackPct != null
      ? Number(harvestTrait.kpis.givebackPct)
      : null;
  const scratchyCombined =
    harvestTrait?.kpis?.scratchPct != null
      ? Number(harvestTrait.kpis.scratchPct)
      : null;

  const windowEps = collectWindowEpisodes(window);
  const exitHarvest = buildExitHarvestLines(windowEps, craft);

  const flags = deriveOperatorFlags({
    expectancyPct: overall?.expectancyPct ?? null,
    armedShare: mix.armedShare,
    armedTarget,
    lateChaseShare: mix.lateChaseShare,
    avgWinPct: overall?.avgWinPct ?? null,
    avgLossPct: overall?.avgLossPct ?? null,
    armToOpenPct: funnel.armToOpenPct ?? null,
    triggerToOpenPct: funnel.triggerToOpenPct ?? null,
    maxDrawdownPct: Number(stats.maxDrawdownPct) || null,
    quietSteadyHwr,
    restrictedPositiveNative,
    winRatePct: overall?.winRate ?? null,
    capturePct:
      captureCombined != null && Number.isFinite(captureCombined)
        ? Number(captureCombined)
        : null,
    zeroMfePct: exitHarvest.zeroMfePct,
    greenThenRedPct: exitHarvest.greenThenRedPct,
  });

  const lines: string[] = [];
  lines.push('=== CRYPTO BOT SYSTEM DIAGNOSTICS EXPORT ===');
  lines.push(`generatedAt: ${new Date(generatedAt).toISOString()}`);
  lines.push(`window: last_${window}`);
  lines.push(`mode: ${modeLabel()}`);
  lines.push(
    `admission: ${el.admissionBaseline}${el.armedTargetEBoost ? ' · armed_target_e_boost' : ''}`
  );
  lines.push('');
  lines.push('--- 1. SNAPSHOT HEADER ---');
  lines.push(
    `equity=${fmtNum(equity, 4)} SOL · available=${fmtNum(available, 4)} · positions=${openCount} · openCount=${openCount}`
  );
  lines.push(
    `realized=${fmtNum(realized, 4)} · unrealized=${fmtNum(unrealized, 4)} · dailyPnL=${fmtNum(daily, 4)} SOL`
  );
  lines.push(
    `combined WR=${fmtPct(overall?.winRate ?? null, 1)} n=${overall?.tradeCount ?? 0} E=${fmtSignedPct(overall?.expectancyPct)} PF=${fmtNum(overall?.profitFactor, 2)} avgW=${fmtNum(overall?.avgWinPct, 1)}% avgL=${fmtNum(overall?.avgLossPct, 1)}%`
  );
  lines.push(
    `capture=${fmtNum(captureCombined, 0)}% giveback=${fmtNum(givebackCombined, 0)}% scratchy=${fmtNum(scratchyCombined, 0)}% softExit=${fmtNum(exitsTrait?.kpis?.softExitPct != null ? Number(exitsTrait.kpis.softExitPct) : null, 0)}% partial=${fmtPct(mix.firstPartialRate, 0)}`
  );
  lines.push(
    `armed=${fmtPct(mix.armedShare, 0)} (target ${armedTarget}%) disc=${fmtPct(mix.discretionaryShare, 0)} late-chase=${fmtPct(mix.lateChaseShare, 0)}`
  );
  lines.push(
    `funnel armed=${funnel.armed} trig=${funnel.triggered} open=${funnel.opened} blocked=${funnel.blocked} · arm→trig=${funnel.armToTriggerPct ?? '—'}% trig→open=${funnel.triggerToOpenPct ?? '—'}% arm→open=${funnel.armToOpenPct ?? '—'}% openRate=${funnel.openRatePct ?? '—'}%`
  );
  lines.push(`maxDD=${fmtNum(stats.maxDrawdownPct, 1)}% · 2nd-pass=${el.blockedSecondPass ?? 0}`);
  {
    const rs = el.repairSession;
    if (rs) {
      lines.push(
        `repair: 0-MFE=${fmtPct(rs.zeroMfeShare, 0)} green→red=${fmtPct(rs.greenThenRedShare, 0)} topLoss=${rs.topLossProfileId ?? '—'}(${fmtPct(rs.topLossShare, 0)}) · zeroMfeBlocked×${rs.zeroMfeEntryBlocked} earlyCut×${rs.zeroMfeEarlyCut} · gov softPass×${rs.govSoftAllow.softPassNative} dipCompare×${rs.govSoftAllow.dipComparativeSoftAllow} hardSkip×${rs.govSoftAllow.hardSkip} · softMove grants×${rs.softMovementGrants} live=${rs.softMovementArmsLive}`
      );
    }
  }
  lines.push('');

  lines.push('--- 2. PROFILE TABLE ---');
  lines.push(
    pad('profile', 18) +
      pad('n', 5) +
      pad('WR', 7) +
      pad('E%', 8) +
      pad('PF', 6) +
      pad('avgW', 7) +
      pad('avgL', 7) +
      pad('cap%', 6) +
      pad('gb%', 6) +
      pad('soft%', 6) +
      pad('arm%', 6) +
      pad('disc%', 6) +
      pad('late%', 6) +
      pad('RL', 8) +
      pad('ready', 6) +
      pad('EMA', 7) +
      pad('status', 8) +
      'blocker / funnel'
  );

  const lmById = new Map(lm.profiles.map((p) => [p.profileId, p]));
  const craftRows = craft?.bots || [];
  const craftById = new Map(craftRows.map((p) => [p.profileId, p]));

  const profilesSorted = [...el.profiles].sort((a, b) =>
    a.profileId.localeCompare(b.profileId)
  );
  const profileIds = profilesSorted.map((p) => p.profileId);
  for (const p of profilesSorted) {
    const lmP = lmById.get(p.profileId);
    const cr = craftById.get(p.profileId);
    const n = p.metrics.tradeCount;
    const status =
      p.quiet
        ? 'quiet'
        : lmP?.tone === 'weak'
          ? 'weak'
          : lmP?.tone === 'watch'
            ? 'watch'
            : n >= 5 && (p.metrics.expectancyPct ?? -1) >= 0
              ? 'healthy'
              : n > 0
                ? 'watch'
                : 'quiet';
    const disc =
      p.armedShare != null ? Math.max(0, 1 - p.armedShare) : null;
    const skill = el.entrySkillByProfile?.[p.profileId];
    const funnelStr = skill
      ? `a${skill.armed}/t${skill.triggered}/o${skill.opened}/x${skill.expired}`
      : lmP?.funnel
        ? `c${lmP.funnel.candidates ?? '—'}/a${lmP.funnel.armed ?? '—'}/t${lmP.funnel.triggered ?? '—'}/o${lmP.funnel.opened ?? '—'}/cl${lmP.funnel.closed ?? '—'}`
        : '—';
    const blocker = (lmP?.blockers || [])[0] || p.quietReason || '—';
    lines.push(
      pad(p.profileId, 18) +
        pad(String(n), 5) +
        pad(fmtPct(p.metrics.winRate, 0), 7) +
        pad(fmtSignedPct(p.metrics.expectancyPct), 8) +
        pad(fmtNum(p.metrics.profitFactor, 2), 6) +
        pad(fmtNum(p.metrics.avgWinPct, 1), 7) +
        pad(fmtNum(p.metrics.avgLossPct, 1), 7) +
        pad(fmtNum(cr?.capturePct ?? p.metrics.mfeCapturePct, 0), 6) +
        pad(fmtNum(cr?.givebackPct ?? lmP?.givebackPct, 0), 6) +
        pad(fmtNum(cr?.softExitPct ?? lmP?.softExitPct, 0), 6) +
        pad(fmtPct(p.armedShare, 0), 6) +
        pad(fmtPct(disc, 0), 6) +
        pad(fmtPct(p.lateChaseShare, 0), 6) +
        pad(String(lmP?.rlMode ?? '—'), 8) +
        pad(fmtNum(lmP?.readinessScore, 0), 6) +
        pad(fmtNum(lmP?.rewardEma, 2), 7) +
        pad(status, 8) +
        `${blocker} · ${funnelStr}`
    );
  }
  lines.push('');

  lines.push('--- 3. FAMILY GOVERNOR TABLE ---');
  lines.push(
    pad('family', 28) +
      pad('gov', 12) +
      pad('n', 5) +
      pad('WR', 7) +
      pad('E%', 8) +
      pad('avgW', 7) +
      pad('avgL', 7) +
      pad('cap%', 6) +
      'note'
  );
  const fams = [...(el.families || [])].sort((a, b) =>
    a.family.localeCompare(b.family)
  );
  for (const f of fams) {
    lines.push(
      pad(f.family, 28) +
        pad(f.state, 12) +
        pad(String(f.metrics.tradeCount), 5) +
        pad(fmtPct(f.metrics.winRate, 0), 7) +
        pad(fmtSignedPct(f.metrics.expectancyPct), 8) +
        pad(fmtNum(f.metrics.avgWinPct, 1), 7) +
        pad(fmtNum(f.metrics.avgLossPct, 1), 7) +
        pad(fmtNum(f.metrics.mfeCapturePct, 0), 6) +
        String(f.note || '—').slice(0, 80)
    );
  }
  if (el.familyRestrictionImpact?.length) {
    lines.push('restriction_impact:');
    for (const r of el.familyRestrictionImpact) {
      lines.push(
        `  ${r.family}=${r.state} natives=[${(r.nativeProfiles || []).join(', ')}] E=${fmtSignedPct(r.expectancyPct)} · ${r.note}`
      );
    }
  }
  lines.push('');

  lines.push('--- 4. TOP SKIP REASONS ---');
  try {
    const { getSetupWatchDiagnostics } =
      require('./profileAttention') as typeof import('./profileAttention');
    const d = getSetupWatchDiagnostics();
    const reasons = (d.blockReasons || []).slice(0, 15);
    if (!reasons.length) {
      lines.push('(none recorded in window)');
    } else {
      reasons.forEach((r: { reason: string; count: number }, i: number) => {
        lines.push(`${i + 1}. ${r.count}× ${String(r.reason).slice(0, 120)}`);
      });
    }
  } catch {
    lines.push('(diagnostics unavailable)');
  }
  lines.push('');

  lines.push('--- 5. TRADE CRAFT SUMMARY ---');
  if (craft) {
    lines.push(
      `combined craftScore=${fmtNum(craft.craftScore, 1)} trend=${craft.trend ?? '—'} n=${craft.n}`
    );
    lines.push(
      `capture=${fmtNum(captureCombined, 0)}% giveback=${fmtNum(givebackCombined, 0)}% scratchy=${fmtNum(scratchyCombined, 0)}%`
    );
    lines.push(craft.plainLanguage || '');
    const byP = [...(craft.bots || [])]
      .filter((p) => (p.n ?? 0) > 0 || p.craftScore != null)
      .sort((a, b) => String(a.profileId).localeCompare(String(b.profileId)));
    for (const p of byP) {
      lines.push(
        `  ${pad(p.profileId, 18)} craft=${fmtNum(p.craftScore, 1)} cap=${fmtNum(p.capturePct, 0)}% gb=${fmtNum(p.givebackPct, 0)}% soft=${fmtNum(p.softExitPct, 0)}% n=${p.n ?? 0}`
      );
    }
  } else {
    lines.push('(trade craft unavailable)');
  }
  lines.push('');

  lines.push('--- 6. TARGET GAP PANEL ---');
  lines.push(
    ...buildTargetGapLines({
      winRate: overall?.winRate ?? null,
      armedShare: mix.armedShare,
      lateChaseShare: mix.lateChaseShare,
      capturePct:
        captureCombined != null && Number.isFinite(captureCombined)
          ? Number(captureCombined)
          : null,
      avgWinPct: overall?.avgWinPct ?? null,
      avgLossPct: overall?.avgLossPct ?? null,
    })
  );
  lines.push('');

  lines.push('--- 7. EXIT & HARVEST BREAKDOWN ---');
  lines.push(...exitHarvest.lines);
  lines.push('');

  lines.push('--- 8. ENTRY TIMING DETAIL ---');
  lines.push(
    ...buildEntryTimingLines(
      windowEps,
      { armToTriggerMs: funnel.armToTriggerMs },
      el.blockedSecondPass ?? 0
    )
  );
  lines.push('');

  lines.push('--- 9. SIZE / RISK CONTRIBUTION ---');
  lines.push(...buildSizeRiskLines(windowEps, profileIds));
  lines.push('');

  lines.push('--- 10. LANE INVENTORY HEALTH ---');
  lines.push(...buildLaneInventoryLines());
  lines.push('');

  lines.push('--- 11. LEARNING MUTATION STATE ---');
  lines.push(...buildLearningMutationLines(profileIds, lm));
  lines.push('');

  lines.push('--- 12. KNOWN ISSUES / OPERATOR FLAGS ---');
  if (!flags.length) {
    lines.push('(none auto-derived)');
  } else {
    flags.forEach((f, i) => lines.push(`${i + 1}. ${f}`));
  }
  lines.push('');
  lines.push('--- FOOTER ---');
  lines.push(
    'Read-only export. No trading side effects. Paste into Grok/Cursor for next-upgrade prompts.'
  );
  lines.push(
    'Episode CSV offline: npx tsx scripts/exportLearningDataset.ts'
  );
  lines.push('=== END EXPORT ===');

  const reportText = lines.join('\n');
  return {
    ok: true,
    generatedAt,
    mode: modeLabel(),
    window,
    reportText,
    meta: {
      profileCount: profilesSorted.length,
      familyCount: fams.length,
      flagCount: flags.length,
    },
  };
}
