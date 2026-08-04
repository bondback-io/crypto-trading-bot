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
  whatsNew?: string;
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
        ${slots.whatsNew || ''}
        <ul>
          <li><strong>Overview</strong> — equity, open positions, risk badge, active profiles. The <strong>Entries</strong> light shows whether the buy path is clear (green) vs soft limits (amber) or abnormal blockers (red); lane no-match quietness stays green.</li>
          <li><strong>Live Feed</strong> — scanner universe, Pump activity, sizing / re-entry watches.</li>
          <li><strong>Micro Bots</strong> — enable profiles, knobs, self-learning / ML (${nProfiles} in catalog). Trend/Compounder/HWR can use Heikin-Ashi exit (green HA → red flip). Coach stack (MARL, Profile RL, TA, accelerators) is documented under <em>Coaches &amp; Stack</em>.</li>
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
          <li><strong>Migration Sniper / Reversal Scalper</strong> — Reversal may show <em>Paused (perf)</em> after the v1.2.91 review. Migration Sniper is an <strong>event lane</strong> (default ON at conservative size): no TA required.</li>
          <li><strong>Trend Rider</strong> — mature continuation (age ≥1.5h · MC ≥$75k · holders/vol floors). Quiet wins were often Pump.fun-only blocking Jupiter <code>toporganicscore</code> (non-<code>pump</code> mints), not Learning Mode. Specialty Jupiter/KOL can bypass Pump.fun-only + Require TA.</li>
          <li><strong>Migration Sniper</strong> — watch ~80% → arm on quality → enter from ~90% → hold through migration → exit on first spike + volume (SL ~15%, post-mig max ~4m). Grad-watch funnel tallies show watch/arm/trigger blockers.</li>
          <li><strong>Turbo Mode</strong> — default ON for Scalper / Migration Sniper / Momentum Burst / Reversal (Exit &amp; sizing). Live: prefer Jito + higher prio/tip + wider buy slip. Paper &amp; Live Sim: same slip + TURBO log/stamp (no real bundles). Safer profiles stay OFF.</li>
          <li><strong>Min token age (h)</strong> — per-profile hard lane floor: hours since Pump.fun graduation (or Dex pair time if grad unknown). Empty = no gate. High values on Migration Sniper defeat ultra-fresh scalp.</li>
          <li><strong>Knobs</strong> — per-profile TP/SL/hold/size and match filters; Global TP override can force one TP style across bots.</li>
          <li>Lane decisions appear on Overview / Micro Bots so you can see why a profile won or skipped.</li>
          <li><strong>Coaches</strong> — each bot has personal self-learn / ML / TA / Profile RL; MARL is the shared team coach. See <em>Coaches &amp; Stack</em> for how they cooperate and which toggles must be ON.</li>
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
          <li><strong>Profile TA Playbooks</strong> — per-lane Off/Soft/Hard identity (HA, Fib/S-R, RSI/EMA/VWAP, patterns, optional whale). Soft = confirmation/conviction only; Hard = confluence gate. Global Require TA remains scanner master. Learning nudges tool weights / minConf only — never TP/SL or Peak Protect cores.</li>
          <li>Learning data lives under DATA_DIR; inspect the journal on the Back Up tab. Ephemeral disks lose progress on deploy.</li>
          <li><strong>Learning Mode (global)</strong> softens conviction / wallet-quality / cluster / some MC floors and raises throughput — it does <em>not</em> bypass Require TA setup, anti-rug floors, daily-loss halts, or disabled profiles. Scalper scanner entries are exempt from Require TA when that lane wins. Trend Rider / Steady Compounder <em>specialty</em> Jupiter/KOL handoffs also bypass Require TA and Pump.fun-only (lane floors still apply).</li>
          <li><strong>Full coach stack</strong> — how episodes, self-learn, ML, Profile TA, Profile RL, MARL, accelerators, and Peak Protect fit together (priority, defaults, activation checklist) lives in the next chapter: <em>Coaches &amp; Stack</em>.</li>
        </ul>
        <div class="botinfo-actions">
          ${btn('microbots', 'Open learning controls')}
          ${btn('backup', 'Open learning journal')}
        </div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-coaches" data-botinfo-section="coaches">
        <h3><span class="botinfo-sec-num">06</span> Coaches &amp; learning stack</h3>
        <p>Every micro-bot can grow from closed trades with a layered coach stack. Layers are <strong>additive</strong>: safety wins first, stamped TP/SL stay hard, then soft coaches nudge ranking, size, TA, and learning signals. They are designed to support each other — not rewrite each other’s cores.</p>
        <div class="botinfo-callout"><strong>Isolation:</strong> each profile keeps its own episodes, self-learn overrides, ML model, TA playbook weights, and Profile RL agent. <strong>MARL</strong> is the shared team coach (per-profile preference weights in one team state) — not a clone of any bot’s private memory.</div>

        <p class="mint" style="margin:0 0 0.45rem"><strong>Who does what</strong></p>
        <ul>
          <li><strong>Episodes</strong> — durable “game film” on final closes (PnL, peak/giveback, TA stamps, timing quality). Source of truth for all learners.</li>
          <li><strong>Self-learning (delta)</strong> — mutates TP/SL/trail/hold/entry floors inside clamps (Level + micro); rollback on degradation. Primary hard mutator when Mode = <code>auto</code>.</li>
          <li><strong>ML advisor</strong> — ranks / blends patch ideas; shadow → hybrid → lead as sample grows. Never invents new strategies.</li>
          <li><strong>Profile TA + weight learning</strong> — per-lane Off/Soft/Hard confluence; learns tool weights / sensitivities only — never TP/SL or Peak Protect cores.</li>
          <li><strong>Profile RL</strong> — personal soft coach (setup-worth, size confidence, TA sensitivity, exit-hint aggressiveness). Shadow / Hybrid / Lead via readiness score (not trade count alone). Default global OFF.</li>
          <li><strong>MARL</strong> — team coach: lane ranking, size confidence, low-MC pile-in, lagging support. Soft only; never writes TP/SL. Default OFF.</li>
          <li><strong>Learning Accelerators</strong> — experience replay, counterfactual exit what-ifs, teacher→student soft TA tips. Offline/soft hints only. Master default OFF.</li>
          <li><strong>Peak Profit Protection</strong> — soft exit on peak giveback; arm/giveback can learn via self-learn exitPolicy. Never replaces hard TP.</li>
          <li><strong>Learning Mode</strong> — softens entry gates + fairness for low-sample bots. Does not bypass anti-rug or Require TA (except documented specialty exemptions).</li>
          <li><strong>Anti-rug / risk / Require TA</strong> — hard safety. Always win conflicts.</li>
          <li><strong>Zion</strong> — explains and supervises; does not mutate learning knobs or TP/SL.</li>
        </ul>

        <p class="mint" style="margin:0 0 0.45rem"><strong>Priority when layers overlap</strong></p>
        <ul>
          <li>1 · Safety / anti-rug</li>
          <li>2 · Micro-bot hard rules &amp; stamped TP/SL</li>
          <li>3 · MARL team assignment / low-MC coordination</li>
          <li>4 · Profile RL soft confidence / TA / exit hints</li>
          <li>5 · TA playbooks, accelerators, Learning Mode</li>
          <li>6 · Self-learn + ML (actual knob mutations)</li>
        </ul>
        <p>MARL and Profile RL both add soft score/size deltas (MARL first, then RL). Bounded stack — not a race to overwrite strategy. <strong>Global Micro-Bot TP</strong>, if set, pauses exit self-learning so one global TP does not fight per-bot exit evolution.</p>

        <p class="mint" style="margin:0.55rem 0 0.45rem"><strong>Close path (final exit → learn)</strong></p>
        <div class="botinfo-flow" aria-label="Learning close path">
          <div class="botinfo-flow-step"><span class="k">1. Episode</span><span class="v">Stamp film</span></div>
          <span class="botinfo-flow-arrow" aria-hidden="true">→</span>
          <div class="botinfo-flow-step"><span class="k">2. Accelerators</span><span class="v">CF · replay · transfer</span></div>
          <span class="botinfo-flow-arrow" aria-hidden="true">→</span>
          <div class="botinfo-flow-step"><span class="k">3. Profile RL</span><span class="v">Policy update</span></div>
          <span class="botinfo-flow-arrow" aria-hidden="true">→</span>
          <div class="botinfo-flow-step"><span class="k">4. TA nudge</span><span class="v">Tool weights</span></div>
          <span class="botinfo-flow-arrow" aria-hidden="true">→</span>
          <div class="botinfo-flow-step"><span class="k">5. Self-learn</span><span class="v">Heuristics + ML</span></div>
          <span class="botinfo-flow-arrow" aria-hidden="true">→</span>
          <div class="botinfo-flow-step"><span class="k">6. MARL</span><span class="v">Team reward</span></div>
        </div>

        <p class="mint" style="margin:0 0 0.45rem"><strong>Entry path (who gets the mint)</strong></p>
        <ul>
          <li>Lane floors / match → Learning Mode fairness → <strong>MARL rank</strong> → <strong>Profile RL rank</strong> → filters / anti-rug → MARL/RL size → TA playbook gate → buy → Peak Protect while open.</li>
          <li><strong>Smart Bot Profiles</strong> must be ON for full lane + MARL/RL ranking. Size multipliers still apply at buy when coaches are enabled.</li>
        </ul>

        <p class="mint" style="margin:0.55rem 0 0.45rem"><strong>Why learning can look idle (gates, not fights)</strong></p>
        <ul>
          <li>Self-learn needs ~<strong>8+</strong> closed episodes; ML stays shadow longer (~50+ before hybrid).</li>
          <li>MARL, Profile RL, and Accelerators often default <strong>OFF</strong> until you enable them on Micro Bots.</li>
          <li>Counterfactuals may stamp without steering unless apply-hints is ON.</li>
          <li>Self-learn Mode <code>shadow</code> = proposals only; use <code>auto</code> to apply.</li>
          <li>Partials do not create episodes — only final closes.</li>
          <li>Require TA / risk halt / max positions can limit how fast episode rings fill.</li>
        </ul>

        <div class="botinfo-callout"><strong>Activation checklist:</strong> Self-learn ON + Mode <code>auto</code> · ≥8 episodes per bot · Smart Bot Profiles ON · enable MARL / Profile RL if you want live coaching · enable Accelerators (+ CF apply hints if desired) · clear Global TP if exit evolution should run · review Require TA if scanners never open. Then more closed trades are what grow readiness, Level, and win quality.</div>
        <p class="mint" style="margin:0.45rem 0 0.55rem"><strong>Two logs:</strong> Overview / Micro Bots <em>lane fight log</em> = execution &amp; conflict feed. Bot Performance <em>Agent Decision Log</em> = coach reasoning/advice (MARL, Profile RL, accelerators, TA, ML, sparse Zion) — logging only.</p>
        <p class="mint" style="margin:0.45rem 0 0.55rem">Live status: Bot Performance → Learning Progress &amp; System Diagnostics + Agent Decision Log. Controls: Micro Bots → Self-Learn / Profile TA / Profile RL / MARL / Accelerators.</p>
        <div class="botinfo-actions">
          ${btn('microbots', 'Open Micro Bots coaches')}
          ${btn('botperf', 'Open Bot Performance')}
          ${btn('backup', 'Open learning journal')}
        </div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-scanners" data-botinfo-section="scanners">
        <h3><span class="botinfo-sec-num">07</span> Market scanners &amp; Pump.fun</h3>
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
        <h3><span class="botinfo-sec-num">08</span> Jupiter, RPC &amp; MEV</h3>
        <p>Live buys/sells go through <strong>Jupiter</strong> swaps. Jupiter Tokens API also feeds organic score / trending for the scanner. Dual-lane RPC prefers free <strong>Helius</strong> (primary) + <strong>Alchemy</strong> (secondary / Zion) with automatic failover to <code>RPC_URL</code>, public Solana, then <code>RPC_SECONDARY</code>.</p>
        <ul>
          <li><strong>MEV / Jito</strong> — tip bundles and sandwich abort (live only; module <code>mev_protection</code>).</li>
          <li>Paper and Live Sim never send real swaps; they still use live marks when configured.</li>
          <li>Fund gate, denied mints, dead-token filters, and honeypot checks sit on the path before size/execute.</li>
        </ul>
        <div class="botinfo-actions">${btn('config', 'Open Config (MEV / RPC)')}</div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-zion" data-botinfo-section="zion">
        <h3><span class="botinfo-sec-num">09</span> Zion (KOL Token Scanner)</h3>
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
        <h3><span class="botinfo-sec-num">10</span> Copy trading &amp; smart wallets</h3>
        <p>The monitor loop polls tracked wallets, scores quality, detects convergence / smart-money flow, then runs the same filter → profile → size path as scanner entries.</p>
        <ul>
          <li><strong>Smart Wallets</strong> — discover via Kolscan, GMGN, Birdeye, Dex, Axiom, Photon, BullX, Nansen, or paste manually.</li>
          <li><strong>Live trading wallets</strong> — main/burner slots; private keys stay on the server (env), never in backups.</li>
          <li>Pause in the header stops the monitor without shutting down the process.</li>
        </ul>
        <div class="botinfo-actions">${btn('wallets', 'Open Smart Wallets')}</div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-backtester" data-botinfo-section="backtester">
        <h3><span class="botinfo-sec-num">11</span> Backtester</h3>
        <p>Replay historical launches with Live-Sim-style decisions and exits. Paper-only — no live capital. Compare KPIs to recent Live Sim runs; breakdowns by Risk On/Off and profile.</p>
        <ul>
          <li><strong>Smart Advisor</strong> — shadow proposals from BT results; does not auto-apply to live.</li>
          <li><strong>Risk Recipe Optimizer</strong> — bounded search for recipe tweaks; still manual apply.</li>
          <li>Match-live Strict and lookback settings control how close the replay is to current filters.</li>
        </ul>
        <div class="botinfo-actions">${btn('backtester', 'Open Backtester')}</div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-alerts" data-botinfo-section="alerts">
        <h3><span class="botinfo-sec-num">12</span> Email &amp; notifications</h3>
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
        <h3><span class="botinfo-sec-num">13</span> Backup &amp; persistence</h3>
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
        <h3><span class="botinfo-sec-num">14</span> High-impact knobs</h3>
        <p>Start here before fine-tuning individual micro-bots. Most controls have <code>?</code> tips on the live screens.</p>
        <ul>
          <li><strong>Mode + Risk On/Off</strong> — posture for the whole bot.</li>
          <li><strong>Base / Max trade SOL</strong> — hard size caps; risk &amp; conviction multipliers scale within them.</li>
          <li><strong>TP / SL + Profit Strategy</strong> — partial → recover → bag → trail lifecycle.</li>
          <li><strong>Max positions · daily loss · convergence · min conviction / wallet Q</strong>.</li>
          <li><strong>Hard floors</strong> — min liq / MC / holders / volume; <strong>Min token age</strong> (per micro-bot); pump.fun-only; anti-rug / honeypot / sniper.</li>
          <li><strong>Market Scanner enable + Require TA + Jupiter trending</strong>; optional AlphaScan for Soon/Bonded. Learning Mode does not bypass Require TA — Scalper (small-MC) and Trend/Compounder specialty Jupiter|KOL are exempt.</li>
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
