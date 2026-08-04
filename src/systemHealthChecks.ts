/**
 * Additive system health collector — read-only issue list for Zion supervision.
 * No trade/learning/RPC mutations. Fail-open per area.
 *
 * Priority of concern (monitoring only):
 * Safety → hard bot rules → MARL → soft coaches → clamped self-learn
 */

import { config } from './config';

export type HealthSeverity = 'normal' | 'watch' | 'action';
export type HealthArea = 'rpc' | 'trading' | 'learning' | 'risk';

export interface HealthIssue {
  key: string;
  area: HealthArea;
  severity: HealthSeverity;
  title: string;
  detail: string;
  recommendation: string;
  /** True when counters/age already imply sustained fault */
  sustainedHint?: boolean;
}

function isShortLatencySpike(snap: {
  healthy: boolean;
  latencyMs: number | null;
  downForMs: number;
}): boolean {
  if (snap.healthy) return true;
  if (snap.downForMs > 0 && snap.downForMs < 90_000) return true;
  if (
    snap.latencyMs != null &&
    snap.latencyMs < 800 &&
    snap.downForMs < 60_000
  ) {
    return true;
  }
  return false;
}

function checkRpc(): HealthIssue[] {
  const out: HealthIssue[] = [];
  try {
    const { getRpcLoadDiagnostic } =
      require('./rpcDiagnostic') as typeof import('./rpcDiagnostic');
    const { getRpcStats } =
      require('./connection') as typeof import('./connection');
    const rpc = getRpcLoadDiagnostic();
    const stats = getRpcStats();
    const lanes = [rpc.primary, rpc.secondary, rpc.utility];
    const badLanes = lanes.filter(
      (l) => !l.healthy && !isShortLatencySpike(l)
    );

    if (badLanes.length >= 2) {
      out.push({
        key: 'rpc_multi_lane_down',
        area: 'rpc',
        severity: 'action',
        title: `${badLanes.length} RPC lanes unhealthy (sustained)`,
        detail: badLanes.map((l) => l.label).join(', '),
        recommendation:
          'Check Config → RPC endpoints and failover. Pause entries until primary recovers if needed.',
        sustainedHint: true,
      });
    } else if (badLanes.length === 1) {
      out.push({
        key: `rpc_lane_${badLanes[0]!.label}`,
        area: 'rpc',
        severity: 'watch',
        title: `RPC lane "${badLanes[0]!.label}" degraded`,
        detail: `downForMs=${badLanes[0]!.downForMs}`,
        recommendation:
          'Watch the RPC diagnostic card; if it persists >5–10 min, review that endpoint.',
      });
    }

    const q = stats.quarantine || [];
    if (q.length > 0) {
      const top = q[0]!;
      out.push({
        key: 'rpc_quarantine_active',
        area: 'rpc',
        severity: q.length >= 2 || (top.streak || 0) >= 3 ? 'action' : 'watch',
        title: `${q.length} RPC endpoint(s) quarantined`,
        detail: q
          .slice(0, 3)
          .map(
            (x) =>
              `${x.label} ~${Math.round((x.remainingMs || 0) / 1000)}s streak=${x.streak || 0}`
          )
          .join('; '),
        recommendation:
          'Dead endpoints are auto-quarantined — verify provider keys/URLs; avoid thrashing by letting cooldown finish.',
        sustainedHint: (top.streak || 0) >= 3,
      });
    }

    if (stats.gate?.stressed) {
      out.push({
        key: 'rpc_gate_stressed',
        area: 'rpc',
        severity: 'watch',
        title: 'RPC gate stressed (backlog / concurrency)',
        detail: `utility queued=${stats.gate.lanes?.utility?.queued ?? '?'}`,
        recommendation:
          'Raise Poll intervals slightly or enable share-load; utility/scanner backlog is growing.',
      });
    }

    const lc = stats.loadControl;
    if (
      lc &&
      lc.scannerSlowFactor >= 3 &&
      (lc.secondarySkipsRecent ?? 0) >= 6
    ) {
      out.push({
        key: 'rpc_scanner_slowdown',
        area: 'rpc',
        severity: 'watch',
        title: 'Scanner/utility auto-slowed (high skips)',
        detail: `slowFactor=${lc.scannerSlowFactor} secondarySkips=${lc.secondarySkipsRecent}/60s`,
        recommendation:
          'Normal under congestion — if sustained, check Secondary/Utility RPC health.',
      });
    }
  } catch {
    /* fail-open */
  }
  return out;
}

function checkTrading(): HealthIssue[] {
  const out: HealthIssue[] = [];
  try {
    const {
      getMonitorStatus,
      getEntryPathLightStatus,
      getSoftWatchRuntimeSnapshot,
    } = require('./monitor') as typeof import('./monitor');
    const ms = getMonitorStatus();
    const entry = getEntryPathLightStatus();

    if (ms.risk?.halted || entry.blockers.some((b) => /risk halt/i.test(b))) {
      out.push({
        key: 'risk_halt',
        area: 'risk',
        severity: 'action',
        title: `Risk halt: ${ms.risk?.haltReason || entry.detail || 'active'}`,
        detail: 'New entries blocked until halt clears.',
        recommendation:
          'Review Overview risk / daily PnL. Clear halt only after you understand the trigger.',
        sustainedHint: true,
      });
    }

    if (entry.state === 'off' && !ms.risk?.halted) {
      const fundsBlock = entry.blockers.some((b) =>
        /fund|wallet|rpc unhealthy|monitor not running/i.test(b)
      );
      out.push({
        key: 'entry_path_off',
        area: 'trading',
        severity: fundsBlock ? 'action' : 'watch',
        title: entry.label || 'Entries off',
        detail: entry.blockers.slice(0, 4).join('; ') || entry.detail || '',
        recommendation:
          'Fix blockers (RPC, funds, engines, max positions) before expecting new opens.',
        sustainedHint: fundsBlock,
      });
    } else if (entry.state === 'paused' || ms.paused) {
      out.push({
        key: 'monitor_paused',
        area: 'trading',
        severity: 'watch',
        title: 'Monitor is paused',
        detail: 'Wallet polling / new signals idle.',
        recommendation: 'Resume monitor from the dashboard when ready to trade.',
      });
    }

    // Poll stall while monitor should be running
    if (ms.running && !ms.paused) {
      const pollInterval = Math.max(
        5_000,
        Number(config.pollIntervalMs) || 15_000
      );
      const stallMs = Math.max(3 * pollInterval, 10 * 60_000);
      const lastDone = Number(ms.lastPollCompleted) || 0;
      if (lastDone > 0 && Date.now() - lastDone > stallMs) {
        out.push({
          key: 'poll_stall',
          area: 'trading',
          severity: 'watch',
          title: 'Open-trade / wallet poll appears stalled',
          detail: `lastPollCompleted ${Math.round((Date.now() - lastDone) / 1000)}s ago (threshold ${Math.round(stallMs / 1000)}s)`,
          recommendation:
            'Check Logs for hung polls or RPC quarantine. Restart monitor if it persists next check.',
        });
      }
    }

    const topSkip = ms.skipReasonCounts?.[0];
    if (topSkip && topSkip.count >= 25) {
      out.push({
        key: `skip_spike_${String(topSkip.reason).slice(0, 40).replace(/\W+/g, '_')}`,
        area: 'trading',
        severity: 'watch',
        title: `High skip volume: ${topSkip.reason} (${topSkip.count})`,
        detail: 'Many candidates fail the same gate.',
        recommendation:
          'Ask Zion about top skips, or review Require TA / conviction / Learning Mode floors.',
      });
    }

    try {
      const soft = getSoftWatchRuntimeSnapshot();
      if (
        soft &&
        soft.enabledWallets > soft.softWatchCap &&
        soft.softWatchCap > 0 &&
        soft.coveragePct30m != null &&
        soft.coveragePct30m < 25 &&
        !soft.softWatchPaused
      ) {
        out.push({
          key: 'soft_watch_coverage_low',
          area: 'trading',
          severity: 'watch',
          title: `Soft-watch coverage low (${Math.round(soft.coveragePct30m)}%)`,
          detail: `cap ${soft.softWatchCap} / ${soft.enabledWallets} enabled wallets`,
          recommendation:
            'Utility RPC may be congested — raise soft-watch cap or check utility lane load.',
        });
      }
    } catch {
      /* optional soft watch fields */
    }
  } catch {
    /* fail-open */
  }
  return out;
}

function checkLearning(): HealthIssue[] {
  const out: HealthIssue[] = [];
  try {
    const { getTradeProfilesStatus, getGlobalMicroBotTakeProfitPct } =
      require('./tradeProfiles') as typeof import('./tradeProfiles');
    const { getProfileLearningEpisodes } =
      require('./profileLearningEpisodes') as typeof import('./profileLearningEpisodes');

    const tp = getTradeProfilesStatus();
    const enabled = (tp.profiles || []).filter(
      (p: { enabled: boolean; id: string }) =>
        p.enabled && p.id !== 'default' && p.id !== 'zion'
    );
    const globalTp = getGlobalMicroBotTakeProfitPct();

    if (globalTp != null && enabled.length > 0) {
      out.push({
        key: 'learn_global_tp_freeze',
        area: 'learning',
        severity: 'watch',
        title: 'Global TP pausing Self-Learn exit deltas',
        detail: `Global TP ${globalTp}%`,
        recommendation:
          'Clear Global Micro-Bot TP if you want per-bot exit evolution to resume.',
      });
    }

    // No recent episodes across enabled bots
    let newestAt = 0;
    let totalEps = 0;
    const counts: Array<{ id: string; n: number }> = [];
    for (const p of enabled) {
      const eps = getProfileLearningEpisodes(p.id, 5);
      totalEps += getProfileLearningEpisodes(p.id, 80).length;
      counts.push({
        id: p.id,
        n: getProfileLearningEpisodes(p.id, 500).length,
      });
      for (const e of eps) {
        const t = Number(e.closedAt || e.at) || 0;
        if (t > newestAt) newestAt = t;
      }
    }
    if (
      enabled.length > 0 &&
      newestAt > 0 &&
      Date.now() - newestAt > 50 * 60_000
    ) {
      out.push({
        key: 'learn_no_new_episodes',
        area: 'learning',
        severity: 'watch',
        title: 'No new closed episodes in ~50+ min',
        detail: `${enabled.length} enabled bots; last episode ${Math.round((Date.now() - newestAt) / 60000)}m ago`,
        recommendation:
          'Check entry path light, Require TA skips, max positions, and risk halt.',
      });
    }

    if (counts.length >= 3) {
      const sum = counts.reduce((s, c) => s + c.n, 0);
      const max = Math.max(...counts.map((c) => c.n));
      const top = counts.find((c) => c.n === max);
      if (sum >= 40 && max / sum > 0.65 && top) {
        out.push({
          key: 'learn_sample_monopoly',
          area: 'learning',
          severity: 'watch',
          title: `One profile monopolising samples (${top.id})`,
          detail: `${top.id} has ${max}/${sum} episodes (>65%)`,
          recommendation:
            'Enable quieter bots or Learning Mode fairness; review lane ranking / MARL.',
        });
      }
    }

    // Profile RL stuck shadow
    try {
      const { getProfileRlConfig, getProfileRlStatus } =
        require('./profileRlAgent') as typeof import('./profileRlAgent');
      if (getProfileRlConfig().enabled) {
        const prl = getProfileRlStatus({
          persist: false,
          ensureKeyAgents: false,
        });
        for (const a of prl.agents.slice(0, 8)) {
          if (
            a.mode === 'shadow' &&
            !a.modeLocked &&
            (a.readinessScore ?? 0) >= 70 &&
            (a.trades ?? 0) >= 12
          ) {
            out.push({
              key: `learn_prl_shadow_${a.profileId}`,
              area: 'learning',
              severity: 'watch',
              title: `Profile RL ${a.profileId} stuck Shadow`,
              detail: `readiness ${a.readinessScore}/100 · n=${a.trades}`,
              recommendation:
                'Wait for auto-promote thresholds or unlock/review Profile RL mode on Micro Bots.',
            });
          }
        }
      }
    } catch {
      /* */
    }

    // Accelerators ON but CF hints off
    try {
      const { getLearningAcceleratorsConfig } =
        require('./learningReplayBuffer') as typeof import('./learningReplayBuffer');
      const acc = getLearningAcceleratorsConfig();
      if (
        acc.enabled &&
        acc.counterfactualEnabled &&
        !acc.counterfactualApplyHints
      ) {
        out.push({
          key: 'learn_cf_hints_off',
          area: 'learning',
          severity: 'watch',
          title: 'Accelerators ON but CF apply-hints OFF',
          detail: 'Counterfactuals stamp but do not steer self-learn.',
          recommendation:
            'Enable counterfactual apply-hints on Learning Accelerators if you want CF to influence exits.',
        });
      }
    } catch {
      /* */
    }

    // Enhancements scheduler freeze (only if master ON)
    try {
      const { getLearningEnhancementsStatus } =
        require('./learningEnhancements') as typeof import('./learningEnhancements');
      const le = getLearningEnhancementsStatus();
      if (
        le.config.enabled &&
        le.config.schedulerEnabled &&
        le.lastSchedulerTickAt > 0 &&
        Date.now() - le.lastSchedulerTickAt >
          (le.config.schedulerIntervalMs || 120_000) * 3
      ) {
        out.push({
          key: 'learn_enhancements_scheduler_freeze',
          area: 'learning',
          severity: 'watch',
          title: 'Learning Enhancements scheduler may be frozen',
          detail: `last tick ${Math.round((Date.now() - le.lastSchedulerTickAt) / 1000)}s ago`,
          recommendation:
            'Toggle Learning Enhancements off/on or check server logs for scheduler errors.',
        });
      }
      for (const w of (le.watchdogWarnings || []).slice(0, 3)) {
        if (out.some((i) => i.detail.includes(w) || i.title.includes(w))) continue;
        out.push({
          key: `learn_enh_wd_${w.slice(0, 28).replace(/\W+/g, '_')}`,
          area: 'learning',
          severity: 'watch',
          title: 'Learning Enhancements watchdog',
          detail: w,
          recommendation: 'Open Micro Bots → Learning Enhancements status.',
        });
      }
    } catch {
      /* */
    }

    // Advisory learning warnings stay Normal/omitted — do not escalate MARL-off etc.
    void totalEps;
  } catch {
    /* fail-open */
  }
  return out;
}

function checkRiskNearLimits(): HealthIssue[] {
  const out: HealthIssue[] = [];
  try {
    const { getMonitorStatus } =
      require('./monitor') as typeof import('./monitor');
    const ms = getMonitorStatus();
    const risk = ms.risk;
    if (!risk || risk.halted) return out;

    const dailyLoss = Math.abs(Number(risk.dailyPnlSol));
    const dailyLimit = Number(risk.dailyLossLimitSol);
    if (
      Number.isFinite(dailyLoss) &&
      Number.isFinite(dailyLimit) &&
      dailyLimit > 0 &&
      risk.dailyPnlSol < 0 &&
      dailyLoss / dailyLimit >= 0.8
    ) {
      out.push({
        key: 'risk_near_daily_loss',
        area: 'risk',
        severity: 'watch',
        title: 'Approaching daily loss limit',
        detail: `${(-risk.dailyPnlSol).toFixed(3)} / ${dailyLimit.toFixed(3)} SOL`,
        recommendation:
          'Reduce size or pause entries before hard halt; review losing lanes.',
      });
    }

    const dd = Number(risk.drawdownPct);
    if (Number.isFinite(dd) && dd >= 15) {
      out.push({
        key: 'risk_elevated_drawdown',
        area: 'risk',
        severity: 'watch',
        title: `Elevated drawdown (~${dd.toFixed(1)}%)`,
        detail: 'Session drawdown elevated',
        recommendation: 'Tighten risk or pause Soft lanes until equity recovers.',
      });
    }
  } catch {
    /* fail-open */
  }
  return out;
}

/**
 * Collect additive health issues. Caller classifies overall Normal/Watch/Action
 * and applies sustained-escalation rules.
 */
export function collectSystemHealthIssues(): HealthIssue[] {
  const issues: HealthIssue[] = [
    ...checkRpc(),
    ...checkTrading(),
    ...checkLearning(),
    ...checkRiskNearLimits(),
  ];
  // Dedupe by key
  const seen = new Set<string>();
  const out: HealthIssue[] = [];
  for (const i of issues) {
    if (seen.has(i.key)) continue;
    seen.add(i.key);
    out.push(i);
  }
  return out.slice(0, 16);
}

export function formatHealthIssuesForZion(
  issues: HealthIssue[],
  classification: string
): string[] {
  const lines = [`System health: ${classification}`];
  for (const i of issues.slice(0, 5)) {
    lines.push(
      `  ${i.severity}: ${i.title} — ${i.recommendation.slice(0, 100)}`
    );
  }
  return lines;
}
