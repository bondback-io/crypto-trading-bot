/**
 * Curated Bot Info prose shells.
 *
 * Lists (profiles, modules, modes, learning matrix) are injected via slots from
 * live catalogs — do not hardcode those inventories here.
 *
 * New top-level chapters (rare): add a chip in dashboardBotInfo SECTIONS and a
 * matching article shell below.
 */

import type { BotInfoSnapshot } from './botInfoSnapshot';

export interface BotInfoSlots {
  snapshot: BotInfoSnapshot;
  profilesGrid: string;
  modulesByGroup: string;
  presetsList: string;
  modesStrip: string;
  learningMatrix: string;
  durabilityCards: string;
  overviewSvg: string;
  pipelineFlow: string;
  openBtn: (tab: string, label: string) => string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Section articles only (hero + chips stay in dashboardBotInfo). */
export function renderBotInfoSectionArticles(slots: BotInfoSlots): string {
  const { snapshot: snap, openBtn: btn } = slots;
  const nProfiles = snap.counts.profiles;
  const nModules = snap.counts.modules;
  const nPresets = snap.counts.presets;
  const heuristicModes = snap.selfLearnModes.map((m) => `<code>${esc(m)}</code>`).join(' or ');
  const mlModes = snap.mlLearnModes.map((m) => `<code>${esc(m)}</code>`).join(' · ');

  return `
      <article class="botinfo-card" id="botinfo-sec-overview" data-botinfo-section="overview">
        <h3><span class="botinfo-sec-num">01</span> How the pieces connect</h3>
        <p>This bot combines <strong>copy trading</strong> (tracked smart wallets), <strong>market scanners</strong> (Dex/GMGN/Birdeye + Pump.fun), and <strong>${nProfiles} micro-bot trade profiles</strong> that compete for each entry. Risk recipes and <strong>${nModules} strategy modules</strong> set global floors; profiles refine entry/exit style.</p>
        ${slots.overviewSvg}
        ${slots.pipelineFlow}
        <ul>
          <li><strong>Overview</strong> — equity, open positions, risk badge, active profiles. The <strong>Entries</strong> light shows whether the buy path is clear (green) vs soft limits (amber) or abnormal blockers (red); lane no-match quietness stays green.</li>
          <li><strong>Live Feed</strong> — scanner universe, Pump activity, sizing / re-entry watches.</li>
          <li><strong>Micro Bots</strong> — enable profiles, knobs, self-learning / ML (${nProfiles} in catalog). Trend/Compounder/HWR can use Heikin-Ashi exit (green HA → red flip).</li>
          <li><strong>Cog menu</strong> — Smart Wallets, Settings, Config, Backtester, Logs, Back Up, and this manual.</li>
        </ul>
        <div class="botinfo-actions">
          ${btn('overview', 'Open Overview')}
          ${btn('scanner', 'Open Live Feed')}
          ${btn('microbots', 'Open Micro Bots')}
        </div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-modes" data-botinfo-section="modes">
        <h3><span class="botinfo-sec-num">02</span> Trading modes</h3>
        <p>Mode is set from the header (${snap.modes.map((m) => esc(m.label)).join(' / ')}). It changes whether fills are virtual or real — not which wallets or scanners you follow.</p>
        ${slots.modesStrip}
        <ul>
          ${snap.modes
            .map(
              (m) =>
                `<li><strong>${esc(m.label)}</strong> — ${esc(m.bullet)}</li>`
            )
            .join('\n          ')}
        </ul>
        <div class="botinfo-callout"><strong>Tip:</strong> Equity on Overview = Available + Positions. Reset clears session stats for module tests; it does not change Risk or modules.</div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-risk" data-botinfo-section="risk">
        <h3><span class="botinfo-sec-num">03</span> Risk On / Off &amp; strategy modules</h3>
        <p><strong>Risk On</strong> applies lean hard floors (liquidity, MC, holders, etc.) plus Copy/Scanner baseline. <strong>Risk Off</strong> is an ops soak: high entry volume, floors relaxed so you can collect signals — enable quality modules manually.</p>
        <ul>
          <li><strong>Settings tab</strong> — Risk toggle, ${nPresets} named strategy presets, module master ON/OFF by group (${snap.moduleGroups.map((g) => esc(g.label.toLowerCase())).join(' / ')}).</li>
          <li><strong>Config tab</strong> — trade size, TP/SL, anti-rug, conviction, MEV, notifications.</li>
          <li>Modules are kill switches for subsystems. Profiles can require a subset when Smart Bot Profiles is on.</li>
        </ul>
        <p class="mint" style="margin:0.35rem 0 0.45rem">Live module dictionary (${nModules}) from STRATEGY_REGISTRY:</p>
        ${slots.modulesByGroup}
        <p class="mint" style="margin:0.55rem 0 0.35rem">Named presets (${nPresets}):</p>
        ${slots.presetsList}
        <div class="botinfo-actions">
          ${btn('settings', 'Open Settings')}
          ${btn('config', 'Open Config')}
        </div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-microbots" data-botinfo-section="microbots">
        <h3><span class="botinfo-sec-num">04</span> Micro Bots (trade profiles)</h3>
        <p>When <strong>Smart Bot Profiles</strong> / multi-profile is enabled, eligible profiles score each signal; the winner stamps the trade (lane fight). Disabled profiles never enter. Default is the legacy global fallback. Catalog currently has <strong>${nProfiles}</strong> profiles.</p>
        ${slots.profilesGrid}
        <ul>
          <li><strong>Watchlists</strong> — Dip setup watch and Graduation (migration) watch live on the Micro Bots tab.</li>
          <li><strong>Migration Sniper</strong> — watch ~80% → fire ≥95% until complete → post-grad handoff (default ≤120s). Armed watches no longer vanish without a buy attempt on curve complete.</li>
          <li><strong>Turbo Mode</strong> — default ON for Scalper / Migration Sniper / Momentum Burst / Reversal (Exit &amp; sizing). Live: prefer Jito + higher prio/tip + wider buy slip. Paper &amp; Live Sim: same slip + TURBO log/stamp (no real bundles). Safer profiles stay OFF.</li>
          <li><strong>Min token age (h)</strong> — per-profile hard lane floor: hours since Pump.fun graduation (or Dex pair time if grad unknown). Empty = no gate. High values on Migration Sniper defeat ultra-fresh scalp.</li>
          <li><strong>Knobs</strong> — per-profile TP/SL/hold/size and match filters; Global TP override can force one TP style across bots.</li>
          <li>Lane decisions appear on Overview / Micro Bots so you can see why a profile won or skipped.</li>
        </ul>
        <div class="botinfo-actions">${btn('microbots', 'Open Micro Bots')}</div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-learning" data-botinfo-section="learning">
        <h3><span class="botinfo-sec-num">05</span> Self-learning &amp; ML</h3>
        <p>Closed trades become <strong>episodes</strong> (game film). Heuristic learning proposes small knob upgrades from patterns (TP/SL, conviction, min token age raise-only, etc.). Optional tabular ML ranks or leads those proposals. Neither invents new strategies — they nudge existing knobs inside clamps.</p>
        <div class="botinfo-callout"><strong>Analogy:</strong> like a sports coach reviewing game film and suggesting a slightly tighter defense — not inventing a new sport. Heuristic Mode = head coach. ML = assistant. <code>shadow</code> = advice only; <code>hybrid</code> = both vote; <code>lead</code> = assistant calls first.</div>
        ${slots.learningMatrix}
        <p class="mint" style="margin:0 0 0.55rem"><strong>Heuristic Mode</strong> (${heuristicModes}):</p>
        <ul>
          <li><code>shadow</code> — propose upgrades only; Level stays put until you Apply.</li>
          <li><code>auto</code> — apply Level upgrades + micro-tweaks when gates pass (rollback still on). Prefer this when you want Level to climb.</li>
        </ul>
        <p class="mint" style="margin:0 0 0.55rem"><strong>ML</strong> (${mlModes}):</p>
        <ul>
          <li><code>off</code> — heuristics only; no model advice.</li>
          <li><code>shadow</code> — model watches and advises; does not steer applied upgrades. <strong>Default / safest while soaking.</strong></li>
          <li><code>hybrid</code> — blend heuristic + ML ranks into applied patches. Use only after Min trades met and holdout looks healthy.</li>
          <li><code>lead</code> — ML can propose tiny continuous deltas first. Avoid until hybrid has been stable for many upgrades.</li>
        </ul>
        <p class="mint" style="margin:0 0 0.55rem"><strong>Per-bot ML recommendation:</strong></p>
        <ul>
          <li><strong>Scalper · Migration Sniper · Momentum · Reversal</strong> — stay on ML <code>shadow</code> longer (noisy labels).</li>
          <li><strong>Trend Rider · Steady Compounder · High Win-Rate · Smart Money Mirror</strong> — try <code>hybrid</code> after enough episodes + healthy holdout; keep Mode <code>auto</code> if you want Level growth.</li>
          <li>If status shows fewer than Min trades (e.g. 5 / 8), keep ML on <code>shadow</code> even with Mode <code>auto</code>.</li>
        </ul>
        <ul>
          <li>Level = applied upgrades only — not episode count.</li>
          <li>Heikin-Ashi Trend module (opt-in) + learning can enable/disable <code>heikinAshiExitEnabled</code> on Trend Rider / Steady Compounder / High Win-Rate.</li>
          <li>Learning data lives under DATA_DIR; inspect the journal on the Back Up tab. Ephemeral disks lose progress on deploy.</li>
        </ul>
        <div class="botinfo-actions">
          ${btn('microbots', 'Open learning controls')}
          ${btn('backup', 'Open learning journal')}
        </div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-scanners" data-botinfo-section="scanners">
        <h3><span class="botinfo-sec-num">06</span> Market scanners &amp; Pump.fun</h3>
        <p>The <strong>Live Feed</strong> tab is the market universe: autonomous scanner (Dex / GMGN / Birdeye + optional Jupiter trending), optional <strong>AlphaScan</strong> New/Soon/Bonded (default off), Pump.fun smart activity (early curve, near migration, migrations), playbooks, and re-entry watches.</p>
        <ul>
          <li><strong>Market Scanner</strong> — can buy without a wallet copy when TA / filters pass; often hybrid with copy convergence.</li>
          <li><strong>AlphaScan</strong> — additive Jupiter <code>/recent</code> + curve buckets: <strong>Soon</strong> = still on pump.fun curve → Migration Sniper grad-watch; <strong>Bonded</strong> = true post-grad (graduatedAt or curve-complete + min MC, default $25k) → Scalper / Reversal. Missing-curve alone is not Bonded. Does not replace Jupiter trending.</li>
          <li><strong>Pump.fun</strong> — bonding-curve progress, migration listener, Discover Pump SM for early smart money.</li>
          <li><strong>Regime / session</strong> — scanner can pause in risk-off; UTC Asia/EU/US session filter can block entries.</li>
          <li>Migrations and setup watches also surface on Overview.</li>
        </ul>
        <div class="botinfo-actions">${btn('scanner', 'Open Live Feed')}</div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-execution" data-botinfo-section="execution">
        <h3><span class="botinfo-sec-num">07</span> Jupiter, RPC &amp; MEV</h3>
        <p>Live buys/sells go through <strong>Jupiter</strong> swaps. Jupiter Tokens API also feeds organic score / trending for the scanner. Dual-lane RPC keeps trading/copy on a primary endpoint and Zion/KOL on a secondary with failover.</p>
        <ul>
          <li><strong>MEV / Jito</strong> — tip bundles and sandwich abort (live only; module <code>mev_protection</code>).</li>
          <li>Paper and Live Sim never send real swaps; they still use live marks when configured.</li>
          <li>Fund gate, denied mints, dead-token filters, and honeypot checks sit on the path before size/execute.</li>
        </ul>
        <div class="botinfo-actions">${btn('config', 'Open Config (MEV / RPC)')}</div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-zion" data-botinfo-section="zion">
        <h3><span class="botinfo-sec-num">08</span> Zion (KOL Token Scanner)</h3>
        <p>Zion is an isolated micro-bot: it watches KOL wallets and builds <strong>manual trade offers</strong> by default. Optional <strong>Auto-send Platinum to HWR</strong> can auto-execute Platinum-tier offers into High Win-Rate.</p>
        <ul>
          <li>Knobs: min KOL wallets, MC band, size / TP / SL / trail defaults, auto-offer, Auto-send Platinum to HWR.</li>
          <li>Popup tiers: <strong>Platinum</strong> (score ≥85, ≥10 KOLs, ≥$750k vol 1h — optional auto → HWR) · <strong>Gold</strong> (score ≥85, ≥8 KOLs, ≥$500k vol 1h) · <strong>Green</strong> (score 70–84, ≥4 KOLs, ≥$250k vol) · else default teal. Holders &amp; risk row shows top10 / bundle / insider / dev / snipers / pro traders when known.</li>
          <li>Uses the secondary RPC lane so KOL scanning does not starve copy/trading.</li>
          <li>Separate from copy-monitor and market scanner entry paths.</li>
        </ul>
        <div class="botinfo-actions">${btn('zion', 'Open Zion')}</div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-copy" data-botinfo-section="copy">
        <h3><span class="botinfo-sec-num">09</span> Copy trading &amp; smart wallets</h3>
        <p>The monitor loop polls tracked wallets, scores quality, detects convergence / smart-money flow, then runs the same filter → profile → size path as scanner entries.</p>
        <ul>
          <li><strong>Smart Wallets</strong> — discover via Kolscan, GMGN, Birdeye, Dex, Axiom, Photon, BullX, Nansen, or paste manually.</li>
          <li><strong>Live trading wallets</strong> — main/burner slots; private keys stay on the server (env), never in backups.</li>
          <li>Pause in the header stops the monitor without shutting down the process.</li>
        </ul>
        <div class="botinfo-actions">${btn('wallets', 'Open Smart Wallets')}</div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-backtester" data-botinfo-section="backtester">
        <h3><span class="botinfo-sec-num">10</span> Backtester</h3>
        <p>Replay historical launches with Live-Sim-style decisions and exits. Paper-only — no live capital. Compare KPIs to recent Live Sim runs; breakdowns by Risk On/Off and profile.</p>
        <ul>
          <li><strong>Smart Advisor</strong> — shadow proposals from BT results; does not auto-apply to live.</li>
          <li><strong>Risk Recipe Optimizer</strong> — bounded search for recipe tweaks; still manual apply.</li>
          <li>Match-live Strict and lookback settings control how close the replay is to current filters.</li>
        </ul>
        <div class="botinfo-actions">${btn('backtester', 'Open Backtester')}</div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-alerts" data-botinfo-section="alerts">
        <h3><span class="botinfo-sec-num">11</span> Email &amp; notifications</h3>
        <p>In-app bell feed plus optional email (Resend or SMTP via env). Events can still log when mail is not configured.</p>
        <ul>
          <li>Low equity, insufficient funds, profitable close, Zion offer / placed.</li>
          <li>Sounds and popups for Zion offers and profit closes (Config → Notifications).</li>
          <li>Set <code>RESEND_API_KEY</code> or <code>SMTP_*</code> on the host; secrets never belong in site-backup JSON.</li>
        </ul>
        <div class="botinfo-actions">
          ${btn('config', 'Open Notifications')}
          ${btn('logs', 'Open Logs')}
        </div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-backup" data-botinfo-section="backup">
        <h3><span class="botinfo-sec-num">12</span> Backup &amp; persistence</h3>
        <p>Settings, wallets, paper balance, profile knobs, learning episodes, and notifications save as JSON under <code>DATA_DIR</code>. Auto-saves on config changes, imports, top-ups, and backtests.</p>
        ${slots.durabilityCards}
        <ul>
          <li><strong>Backup Site / Load</strong> — download or restore a stamped full-site JSON.</li>
          <li><strong>GitHub Backup</strong> — optional Contents API upload (<code>GITHUB_BACKUP_TOKEN</code>); auto interval; load is always manual.</li>
          <li><strong>Bot performance email</strong> — optional digest (1h / 6h / 12h / 24h); first send anchors to 7pm Australia/Brisbane; Generate &amp; send now on Back Ups.</li>
          <li><strong>Learning journal</strong> — episode / knobs / upgrade / micro saves with export CSV/JSON.</li>
          <li>Private keys are never included in backups.</li>
        </ul>
        <div class="botinfo-actions">${btn('backup', 'Open Back Up')}</div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-knobs" data-botinfo-section="knobs">
        <h3><span class="botinfo-sec-num">13</span> High-impact knobs</h3>
        <p>Start here before fine-tuning individual micro-bots. Most controls have <code>?</code> tips on the live screens.</p>
        <ul>
          <li><strong>Mode + Risk On/Off</strong> — posture for the whole bot.</li>
          <li><strong>Base / Max trade SOL</strong> — hard size caps; risk &amp; conviction multipliers scale within them.</li>
          <li><strong>TP / SL + Profit Strategy</strong> — partial → recover → bag → trail lifecycle.</li>
          <li><strong>Max positions · daily loss · convergence · min conviction / wallet Q</strong>.</li>
          <li><strong>Hard floors</strong> — min liq / MC / holders / volume; <strong>Min token age</strong> (per micro-bot); pump.fun-only; anti-rug / honeypot / sniper.</li>
          <li><strong>Market Scanner enable + Require TA + Jupiter trending</strong>; optional AlphaScan for Soon/Bonded.</li>
          <li><strong>Smart Bot Profiles / Multi-profile / Global TP override</strong> — ${nProfiles} catalog profiles.</li>
          <li><strong>MEV + Jito tip</strong> (Live only).</li>
        </ul>
        <div class="botinfo-callout"><strong>Safe loop:</strong> Live Sim → tune Micro Bots → Backtester check → Back Up → only then Live with small size.</div>
        <div class="botinfo-actions">
          ${btn('config', 'Open Config')}
          ${btn('settings', 'Open Settings')}
          ${btn('microbots', 'Open Micro Bots')}
        </div>
      </article>
`;
}
