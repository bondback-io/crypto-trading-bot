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
  lifecycleSvg: string;
  tradeCraftTradeSvg: string;
  tradeCraftLearnSvg: string;
  tradeCraftLive: string;
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

function stageIco(kind: string): string {
  const common =
    'fill="none" stroke="#34d399" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
  const paths: Record<string, string> = {
    wait: `<circle cx="12" cy="12" r="7" ${common}/><path d="M12 8v4l2.5 1.5" ${common}/>`,
    signal: `<path d="M4 12a8 8 0 0 1 16 0" ${common}/><path d="M7 12a5 5 0 0 1 10 0" ${common}/><circle cx="12" cy="12" r="1.5" fill="#34d399"/>`,
    enrich: `<circle cx="11" cy="11" r="6" ${common}/><path d="M16 16l4 4" ${common}/>`,
    gate: `<path d="M6 20V8l6-3 6 3v12" ${common}/><path d="M12 11v5" ${common}/>`,
    classy: `<path d="M5 7h6v6H5zM13 11h6v6h-6z" ${common}/>`,
    lanes: `<path d="M5 6h14M5 12h14M5 18h10" ${common}/>`,
    coach: `<path d="M12 4l7 4v5c0 4-3 7-7 8-4-1-7-4-7-8V8l7-4z" ${common}/>`,
    filter: `<path d="M5 6h14l-5 6v5l-4 2v-7L5 6z" ${common}/>`,
    chart: `<path d="M5 19V5M5 19h14" ${common}/><path d="M8 14l3-3 3 2 4-5" ${common}/>`,
    buy: `<circle cx="12" cy="12" r="7" ${common}/><path d="M12 8v8M9 11h6" ${common}/>`,
    manage: `<path d="M12 4l7 3v5c0 4-3.2 7.2-7 8-3.8-.8-7-4-7-8V7l7-3z" ${common}/>`,
    exit: `<path d="M6 12h10M12 8l4 4-4 4" ${common}/><path d="M5 5v14" ${common}/>`,
    learn: `<path d="M5 7c3-2 5-2 7 0s4 2 7 0v10c-3 2-5 2-7 0s-4-2-7 0V7z" ${common}/>`,
  };
  return `<div class="bi-ico" aria-hidden="true"><svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">${paths[kind] || paths.signal}</svg></div>`;
}

function lifecycleStage(
  num: string,
  title: string,
  body: string,
  example: string,
  ico: string
): string {
  return `<div class="botinfo-lifecycle-stage">
          ${stageIco(ico)}
          <div class="bi-step">Step ${esc(num)}</div>
          <div class="bi-title">${title}</div>
          <p class="bi-body">${body}</p>
          <p class="bi-ex"><strong>$RIVER:</strong> ${example}</p>
        </div>`;
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
      <article class="botinfo-card" id="botinfo-sec-lifecycle" data-botinfo-section="lifecycle">
        <h3><span class="botinfo-sec-num">01</span> Trading Bot Lifecycle</h3>
        <p>Follow one micro-bot from <strong>waiting for a signal</strong> to <strong>closing and learning</strong>. This is the shared path for Market Scanner and Copy entries (enrich → Gatekeeper → Classifier → lane fight → filters → TA → buy → manage → learn).</p>
        <img class="botinfo-hero-img" src="/botinfo/trading-lifecycle-hero.jpg" width="920" height="518" alt="Isometric trading bot lifecycle: a token travels through signal, enrich, gatekeeper, classifier, lane fight, coaches, filters, TA, buy, protect, and learn checkpoints" loading="lazy" decoding="async" />
        ${slots.lifecycleSvg}
        <div class="botinfo-callout"><strong>Running story:</strong> Token <em>$RIVER</em> pops onto the Live Feed. <strong>Trend Rider</strong> is enabled and waiting. We walk $RIVER through every checkpoint — like a shopper going from “spotted on the shelf” to “receipt in the bag,” with coaches whispering along the way.</div>

        <div class="botinfo-lifecycle-stages">
          ${lifecycleStage(
            '01',
            'Waiting — profiles ON',
            'Enabled micro-bots sit ready. Smart Bot Profiles must be ON for the full lane fight + coach ranking. Nothing happens until a signal arrives.',
            'Trend Rider is ON. Scalper and Steady Compounder are also watching, but Trend Rider fits mature continuation best.',
            'wait'
          )}
          ${lifecycleStage(
            '02',
            'Signal — scanner or copy',
            'A candidate appears from the Market Scanner (Live Feed) or a tracked smart-wallet buy. Early kills can stop here (scanner/copy OFF, risk halt, denied mint, pump.fun-only gate).',
            'Scanner flags $RIVER with rising volume and a clean-enough MC band. The signal enters the shared filter path.',
            'signal'
          )}
          ${lifecycleStage(
            '03',
            'Enrich — look up the basics',
            'Best-effort fill-in before coaches and lanes: market cap, holders, volume, dip/pullback, Fib/support snapshot, confirmation, KOL count. Soft / informational — not a hard veto.',
            'Enrich stamps $RIVER as mid-MC with a mild pullback into support — useful context for Trend Rider scoring.',
            'enrich'
          )}
          ${lifecycleStage(
            '04',
            'HMC Gatekeeper — bouncer at the door',
            'Allow/block before lanes fight. Hard safety (honeypot / known high risk) never fails open. Soft activity/liquidity issues may block or only advise, depending on strictness.',
            'Door check: not a honeypot, liquidity OK. Gatekeeper allows $RIVER through with a short plain-language note in the lane fight / Agent Decision Log.',
            'gate'
          )}
          ${lifecycleStage(
            '05',
            'HMC Classifier — which specialists may fight',
            'Labels the setup (dip, momentum, migration, slow quality, …) and maps preferred lanes. Soft eligibility deprioritizes non-preferred bots; hard eligibility (soft OFF) can exclude them.',
            'Setup reads as trend/continuation. Trend Rider preferred; Scalper soft-deprioritized so it does not steal the mint as easily.',
            'classy'
          )}
          ${lifecycleStage(
            '06',
            'Lane fight — profiles compete',
            `${nProfiles} trade profiles score the mint against their floors and style. Hard floors can fail a lane; scores rank who may try first.`,
            'Trend Rider tops the passer list. Migration Sniper never matched. Steady Compounder is second.',
            'lanes'
          )}
          ${lifecycleStage(
            '07',
            'MARL — team coach nudge',
            'Shared team coach softly bumps lane ranking and later size confidence. Never writes TP/SL. Default often OFF until you enable it on Micro Bots.',
            'MARL gives Trend Rider a small score lift because the team has been under-using quality continuation lately.',
            'coach'
          )}
          ${lifecycleStage(
            '08',
            'Profile RL — personal coach nudge',
            'Each bot’s soft personal coach: setup-worth, size confidence, TA sensitivity. Soft only. Default often OFF until enabled.',
            'Trend Rider’s RL is mildly confident on this pullback-into-trend shape → tiny size/score nudge.',
            'coach'
          )}
          ${lifecycleStage(
            '09',
            'Cascade filters + anti-rug',
            'Winner walks the safety checklist: wallet quality, timing, max positions, daily loss, conviction, and full anti-rug metrics. First passer that clears modules wins. (Full anti-rug runs here — after lane fight.)',
            '$RIVER clears holder/liquidity floors and anti-rug. Trend Rider keeps the mint.',
            'filter'
          )}
          ${lifecycleStage(
            '10',
            'TA playbook — chart confirmation',
            'Per-lane Off/Soft/Hard confluence (HA, Fib/S-R, RSI/EMA/VWAP, patterns…). Soft nudges size/conviction; Hard can skip the buy.',
            'Trend Rider Soft playbook likes the support bounce. Buy continues with a TA stamp on the decision.',
            'chart'
          )}
          ${lifecycleStage(
            '11',
            'Buy — stamp exits + PPP / PCL',
            'Order goes through Jupiter (Live) or virtual fill (Paper / Live Sim). Open stamps hard TP/SL from the profile, Peak Protect params, and Profit Capture Layer permission window by family.',
            'Trend Rider opens $RIVER with its TP/SL, a ~90s quality-family PCL permission window, and Peak Protect arm settings ready.',
            'buy'
          )}
          ${lifecycleStage(
            '12',
            'Manage — soft harvest while open',
            'While open: Peak Protect arms on peak profit; PCL can defer early scratch and allow meaningful partials + runner. Hard stop-loss is never softened.',
            '$RIVER runs +12%. PPP arms. PCL lets a partial bank some green, then trails a runner instead of scratching at +2%.',
            'manage'
          )}
          ${lifecycleStage(
            '13',
            'Exit — hard SL first, then soft exits',
            'Hard SL always wins. Soft exits (Peak Protect giveback, PCL partials, TA exit hints, profit strategy) harvest or cut without replacing the hard floor.',
            'Price gives back from the peak → Peak Protect full-exits the runner. Hard SL never triggered.',
            'exit'
          )}
          ${lifecycleStage(
            '14',
            'Learn — film after the close',
            'Final close → episode (“game film”). Then Profile RL update, self-learn / ML proposals (shadow or auto), and MARL team reward. Self-learn and ML are <em>not</em> mid-pipeline vetoes — they reshape future knobs.',
            'Trend Rider stores the $RIVER episode. Self-learn may later nudge trail/hold slightly; ML stays in shadow until enough samples.',
            'learn'
          )}
        </div>

        <div class="botinfo-callout"><strong>Zion side door:</strong> KOL offers (manual Place Trade or Platinum/Gold auto-send) go straight to buy with a Zion / target profile. They <em>bypass</em> the shared enrich → HMC → cascade stack — a separate entrance, not this hallway.</div>
        <div class="botinfo-callout"><strong>Remember:</strong> MARL, Profile RL, Accelerators, and Self-learn Mode <code>shadow</code> can look “idle” until enabled or until enough closed episodes exist. Safety and hard TP/SL always outrank soft coaches.</div>

        <p class="botinfo-where"><strong>Where to find:</strong> Live Feed (signals) · Micro Bots → HMC Gatekeeper / Classifier, MARL, Profile RL, Peak Protect, Profit Capture Layer · Overview → lane fight log · Bot Performance → Agent Decision Log · Back Up → learning journal.</p>
        <div class="botinfo-actions">
          ${btn('scanner', 'Open Live Feed')}
          ${btn('microbots', 'Open Micro Bots')}
          ${btn('overview', 'Open Overview')}
          ${btn('botperf', 'Open Bot Performance')}
        </div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-overview" data-botinfo-section="overview">
        <h3><span class="botinfo-sec-num">02</span> How the pieces connect</h3>
        <p>This bot combines <strong>copy trading</strong> (tracked smart wallets), <strong>market scanners</strong> (Dex/GMGN/Birdeye + Pump.fun), and <strong>${nProfiles} micro-bot trade profiles</strong> that compete for each entry. Risk recipes and <strong>${nModules} strategy modules</strong> set global floors; profiles refine entry/exit style. For the full start-to-finish story with pictures, open the <em>Lifecycle</em> chip above.</p>
        ${slots.overviewSvg}
        ${slots.pipelineFlow}
        ${slots.whatsNew || ''}
        <ul>
          <li><strong>Overview</strong> — equity, open positions, risk badge, active profiles. The <strong>Entries</strong> light shows whether the buy path is clear (green) vs soft limits (amber) or abnormal blockers (red); lane no-match quietness stays green.</li>
          <li><strong>Live Feed</strong> — scanner universe, Pump activity, sizing / re-entry watches.</li>
          <li><strong>Micro Bots</strong> — enable profiles, knobs, self-learning / ML (${nProfiles} in catalog). Trend/Compounder/HWR can use Heikin-Ashi exit (green HA → red flip). Coach stack (MARL, Profile RL, TA, accelerators) is documented under <em>Coaches &amp; Stack</em>.</li>
          <li><strong>Newer stack pieces</strong> — <em>HMC Gatekeeper</em> (door check before lanes) · <em>HMC Setup Classifier</em> (which specialists may fight) · <em>Peak Profit Protection</em> + <em>Profit Capture Layer</em> (soft harvest while open) · Zion <em>Gold → Smart Money Mirror</em> auto-send. Full guides live under Coaches, Risk, and Zion.</li>
          <li><strong>Cog menu</strong> — Smart Wallets, Settings, Config, Backtester, Logs, Back Up, and this manual.</li>
        </ul>
        <div class="botinfo-actions">
          ${btn('overview', 'Open Overview')}
          ${btn('scanner', 'Open Live Feed')}
          ${btn('microbots', 'Open Micro Bots')}
        </div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-modes" data-botinfo-section="modes">
        <h3><span class="botinfo-sec-num">03</span> Trading modes</h3>
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
        <h3><span class="botinfo-sec-num">04</span> Risk On / Off &amp; strategy modules</h3>
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

        <div class="botinfo-callout"><strong>Multi-TF S/R + Scalper watch (Mode B):</strong> Scalper / Momentum Burst / Reversal only immediate-buy when price is already at multi-TF support confluence (≥2 TFs including 15m/30m/1h/4h). Otherwise they park on the Scalper-family watchlist until touch + reclaim (~1.2%). Dip Buyer Fib watch stays separate (~1.5% reclaim). Shared support-reclaim detector fails soft if S/R is missing.</div>
        <div class="botinfo-callout"><strong>Entry-style DNA + late-chase:</strong> Each micro-bot has primary / allowed / forbidden entry styles (reclaim, dip, trend pullback, SM confirm, etc.). Late chase (extended ~8–12% above support/Fib, or momentum with no nearby level) hard-zeros quality / Mirror / Trend / Dip and strongly penalizes Scalper / MB. Opens stamp <code>entryStyle</code> + <code>lateChaseAtEntry</code>; high-quality valid styles stretch PCL permission and delay PPP arm; marginal / late-chase tighten. Badges + Trade Craft Decisions KPIs + Zion call out elevated late-chase rates.</div>

        <p class="mint" style="margin:0.75rem 0 0.45rem"><strong>Exit harvest layers</strong> (soft — never replace hard TP/SL)</p>

        <p class="mint" style="margin:0.55rem 0 0.35rem"><strong>Peak Profit Protection</strong> — soft exit when price gives back a share of the peak after arming</p>
        <ul>
          <li>Arms when unrealized peak reaches a % of the lane’s target TP (global + optional scalper-style / per-bot overrides).</li>
          <li>Once armed, full-exits if price gives back a % of that peak. Stale-peak can tighten giveback if no new high.</li>
          <li>Never overwrites hard TP, hard SL, trail, anti-rug, or dead-market exits. Self-learn / ML may nudge arm/giveback (±3–5%) from denser profit-protection film; Profile RL rewards beat/near-miss without rewriting cores.</li>
          <li>Fast lanes (Scalper, Momentum Burst, Reversal, Migration Sniper) use tighter scalper-style defaults; PCL can retune arm/giveback by family when enabled.</li>
        </ul>
        <div class="botinfo-callout"><strong>Live example:</strong> Target TP is +40%. PPP arms at 65% of that (~+26%). Price spikes to +30%, then slips back 45% of the peak move — Peak Protect banks the runner so a round-trip fade does not erase the win. Hard TP still fires if price rips straight to target.</div>
        <p class="botinfo-where"><strong>Where to find:</strong> Dashboard → Micro Bots → scroll to <em>Peak Profit Protection</em> card (near Profit Capture Layer). Open positions show Armed / Waiting. Bot Performance → Agent Decision Log → filter Peak Protect. Per-bot arm/giveback: Micro Bots → profile Exit &amp; sizing.</p>

        <p class="mint" style="margin:0.55rem 0 0.35rem"><strong>Profit Capture Layer (PCL)</strong> — short permission window + partial/runner harvest coach</p>
        <ul>
          <li>After entry, a family permission window softens over-early tiny green scratches: fast ~35s · dip/trend ~120s · quality ~90s (high entry quality ≥70 extends ~+40%).</li>
          <li>Retunes PPP (fast ~60/40 arm/giveback; dip-trend &amp; quality ~65/45) with min-open / min-profit floors; defers arming while permission is active.</li>
          <li>Banks a meaningful early partial, then manages the runner (post-partial giveback ×0.85; trail nudge toward small green). Anti-scratch blocks tiny green exits on medium+ quality setups.</li>
          <li>Learning reshape boosts MFE capture / partials and penalizes scratchy tiny greens (strength 0–1, default 0.35). Never disables hard SL or anti-rug.</li>
        </ul>
        <div class="botinfo-flow" aria-label="PCL harvest flow">
          <div class="botinfo-flow-step"><span class="k">1. Entry</span><span class="v">Quality stamp</span></div>
          <span class="botinfo-flow-arrow" aria-hidden="true">→</span>
          <div class="botinfo-flow-step"><span class="k">2. Permission</span><span class="v">Hold the scratch</span></div>
          <span class="botinfo-flow-arrow" aria-hidden="true">→</span>
          <div class="botinfo-flow-step"><span class="k">3. Partial</span><span class="v">Bank + runner</span></div>
          <span class="botinfo-flow-arrow" aria-hidden="true">→</span>
          <div class="botinfo-flow-step"><span class="k">4. PPP</span><span class="v">Protect peak</span></div>
        </div>
        <div class="botinfo-callout"><strong>Live example:</strong> Scalper catches a hot mint. For ~35s PCL says “don’t scratch +1.5% yet.” Price runs; PCL banks ~half near the early partial, leaves a runner, then Peak Protect watches the peak. Hard SL still cuts a real dump immediately.</div>
        <p class="botinfo-where"><strong>Where to find:</strong> Dashboard → Micro Bots → <em>Profit Capture Layer</em> card (directly under Peak Protect). Open-trade rows show permission / partial / PPP lines. Zion comments when PCL is active. Learning strength + family permission seconds are on that same card. <strong>Progress:</strong> Bot Performance → <em>Trade Craft Progress</em> (Harvest tab + Combined) · full guide in <a href="#botinfo-sec-tradecraft" onclick="showBotInfoSection('tradecraft'); return false;">Trade Craft</a>.</p>

        <div class="botinfo-actions">
          ${btn('settings', 'Open Settings')}
          ${btn('config', 'Open Config')}
          ${btn('microbots', 'Open PPP / PCL')}
        </div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-microbots" data-botinfo-section="microbots">
        <h3><span class="botinfo-sec-num">05</span> Micro Bots (trade profiles)</h3>
        <p>When <strong>Smart Bot Profiles</strong> / multi-profile is enabled, eligible profiles score each signal; the winner stamps the trade (lane fight). Disabled profiles never enter. Default is the legacy global fallback. Catalog currently has <strong>${nProfiles}</strong> profiles.</p>
        ${slots.profilesGrid}
        <ul>
          <li><strong>Watchlists</strong> — Dip setup watch, Scalper-family multi-TF S/R watch (Mode B), and Graduation (migration) watch live on the Live Feed / Micro Bots strip.</li>
          <li><strong>Migration Sniper / Reversal Scalper</strong> — Reversal may show <em>Paused (perf)</em> after the v1.2.91 review. Migration Sniper is an <strong>event lane</strong> (default ON at conservative size): no TA required.</li>
          <li><strong>Trend Rider</strong> — mature continuation (age ≥1.5h · MC ≥$75k · holders/vol floors). Quiet wins were often Pump.fun-only blocking Jupiter <code>toporganicscore</code> (non-<code>pump</code> mints), not Learning Mode. Specialty Jupiter/KOL can bypass Pump.fun-only + Require TA.</li>
          <li><strong>Migration Sniper</strong> — watch ~80% → arm on quality → enter from ~90% → hold through migration → exit on first spike + volume (SL ~15%, post-mig max ~4m). Grad-watch funnel tallies show watch/arm/trigger blockers.</li>
          <li><strong>Turbo Mode</strong> — default ON for Scalper / Migration Sniper / Momentum Burst / Reversal (Exit &amp; sizing). Live: prefer Jito + higher prio/tip + wider buy slip. Paper &amp; Live Sim: same slip + TURBO log/stamp (no real bundles). Safer profiles stay OFF.</li>
          <li><strong>Min token age (h)</strong> — per-profile hard lane floor: hours since Pump.fun graduation (or Dex pair time if grad unknown). Empty = no gate. High values on Migration Sniper defeat ultra-fresh scalp.</li>
          <li><strong>Knobs</strong> — per-profile TP/SL/hold/size and match filters; Global TP override can force one TP style across bots.</li>
          <li>Lane decisions appear on Overview / Micro Bots so you can see why a profile won or skipped.</li>
          <li><strong>Coaches</strong> — each bot has personal self-learn / ML / TA / Profile RL; MARL is the shared team coach. See <em>Coaches &amp; Stack</em> for how they cooperate and which toggles must be ON.</li>
          <li><strong>HMC · PCL · Peak Protect</strong> — Gatekeeper + Setup Classifier live under Micro Bots → <em>Learning</em> routing tab; Peak Protect + Profit Capture Layer cards sit just below (same Micro Bots page). Full process + examples under <em>Coaches</em> and <em>Risk</em>.</li>
        </ul>
        <div class="botinfo-callout"><strong>Live example:</strong> A thin low-MC mint hits the feed. Gatekeeper may soft-block congestion before any lane scores it. If allowed, Classifier may prefer dip specialists; the winner stamps TP/SL; while open, PCL + Peak Protect harvest without rewriting those hard exits.</div>
        <p class="botinfo-where"><strong>Where to find:</strong> Dashboard → Micro Bots → Profile routing tabs <em>Profiles</em> / <em>Scoring</em> / <em>Learning</em>. Learning tab → HMC Gatekeeper, HMC Setup Classifier, MARL, Profile RL. Scroll for Peak Profit Protection + Profit Capture Layer. Lane fight log on Overview and Micro Bots.</p>
        <div class="botinfo-actions">${btn('microbots', 'Open Micro Bots')}</div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-learning" data-botinfo-section="learning">
        <h3><span class="botinfo-sec-num">06</span> Self-learning &amp; ML</h3>
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
          <li><strong>PCL learning reshape</strong> — when Profit Capture Layer is ON, episode timing rewards boost good MFE capture / meaningful partials and penalize tiny green scratches (scaled by Learning strength). Entry <em>quality stamp</em> also stretches permission windows and can block scratchy exits. Does not invent new knobs — reshapes how film scores exits.</li>
          <li><strong>Full coach stack</strong> — how episodes, self-learn, ML, Profile TA, Profile RL, MARL, accelerators, Peak Protect, and PCL fit together (priority, defaults, activation checklist) lives in <em>Coaches &amp; Stack</em>. Scorecard of harvest / exits / TA craft: <a href="#botinfo-sec-tradecraft" onclick="showBotInfoSection('tradecraft'); return false;">Trade Craft</a>.</li>
        </ul>
        <div class="botinfo-callout"><strong>Live example:</strong> Two closes both finish +2%. One scratched immediately; one banked a partial then trailed the runner. With PCL reshape ON, the second episode “looks smarter” to learning — the first gets a tiny-scratch penalty — so future upgrades favor harvest habits, not panic taps.</div>
        <p class="botinfo-where"><strong>Where to find:</strong> Micro Bots → Learning strength on the <em>Profit Capture Layer</em> card · Back Up → learning journal · Bot Performance → Learning Progress + <em>Trade Craft Progress</em> · manual chapter <a href="#botinfo-sec-tradecraft" onclick="showBotInfoSection('tradecraft'); return false;">Trade Craft</a>.</p>
        <div class="botinfo-actions">
          ${btn('microbots', 'Open learning controls')}
          ${btn('backup', 'Open learning journal')}
        </div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-tradecraft" data-botinfo-section="tradecraft">
        <h3><span class="botinfo-sec-num">07</span> Trade Craft</h3>
        <p>Trade Craft is a <strong>scorecard of recent closes</strong> — the same episode “game film” Self-Learn already uses, re-scored into harvest / hold / profit / exit / TA / decision skills. It is <strong>diagnostics only</strong>: it does not change strategy, TP/SL, or lane rules by itself. Self-Learn may soft-align Timing/PPP/PCL micro candidates when Harvest or Exits early→late move ±4 or more.</p>

        <p class="mint" style="margin:0 0 0.45rem"><strong>Easy version</strong></p>
        <ul>
          <li><strong>Seven traits</strong> — Harvest (PCL capture vs scratch), Holding time, Profit-taking, Profit improvement, Exit efficiency, TA craft, Decision stack.</li>
          <li><strong>Combined</strong> pools all micro-bots; pick a profile to isolate one lane. Window 20 / 50 / 100 = how many recent closes feed the score.</li>
          <li><strong>Early → late</strong> splits the window in half. <code>STABLE</code> / <code>IMPROVING</code> / <code>DECLINING</code> comes from craft delta (~±4 points).</li>
          <li>Craft never invents knobs. Tip: open Bot Performance → <em>Trade Craft Progress</em> for charts + film table.</li>
        </ul>
        <div class="botinfo-callout"><strong>Plain language:</strong> Think report card after the game — not a new playbook. Coaches still propose the tweaks; Craft tells you whether harvest and exits are getting cleaner.</div>

        <p class="mint" style="margin:0.75rem 0 0.45rem"><strong>Deep manual — traits → film fields</strong></p>
        <div class="botinfo-traits-wrap">
          <table class="botinfo-traits-table">
            <thead>
              <tr><th>Trait</th><th>Watches</th><th>Episode / film fields</th></tr>
            </thead>
            <tbody>
              <tr><td><strong>Harvest (PCL)</strong></td><td>MFE capture, giveback, scratchy greens, partials, timing reward</td><td><code>mfeCaptureRatio</code> · <code>givebackFromPeakPct</code> · <code>pclPartialTaken</code> · <code>timingReward</code></td></tr>
              <tr><td><strong>Holding time</strong></td><td>Win vs loss hold, premature exits</td><td><code>holdSec</code> · peak vs capture on short holds</td></tr>
              <tr><td><strong>Profit-taking</strong></td><td>Exit quality, partials, left-on-table, PPP beat rate</td><td><code>exitQualityScore</code> · <code>peakProtectBeatFullTp</code> · max runup vs exit</td></tr>
              <tr><td><strong>Profit improve</strong></td><td>Avg PnL, win rate, timing</td><td><code>pnlPct</code> · <code>timingReward</code></td></tr>
              <tr><td><strong>Exits</strong></td><td>Hard SL vs soft/scared, quick SL, CF wider-SL survive</td><td><code>exitKey</code> · <code>cfSlWiderWouldSurvive</code></td></tr>
              <tr><td><strong>TA craft</strong></td><td>Confluence, tool pass, held into profit</td><td><code>taModeAtOpen</code> · <code>taConfluenceAtEntry</code> · TA tool stamps</td></tr>
              <tr><td><strong>Decisions</strong></td><td>Entry quality, conviction, HMC, <strong>CF peak gap</strong></td><td><code>entryQualityScore</code> · <code>hmcConfidence</code> · <code>cfActualVsPeakGapPct</code></td></tr>
            </tbody>
          </table>
        </div>
        <ul>
          <li>Film columns also show PPP arm timing, near-miss, permission exits, PCL family, and CF preference flags (<code>cfTighterPppBetter</code>, <code>cfLooserPppBetter</code>, <code>cfLaterArmBetter</code>, <code>cfSkipPartialBetter</code>).</li>
          <li>Naming: use <strong>PCL</strong> (Profit Capture Layer) and <strong>CF peak gap</strong> — not “PCI”.</li>
          <li><code>pclFamilyOverride</code> from Self-Learn is <em>family-global</em> (fast / dip_trend / quality), not a full per-profile PCL rewrite.</li>
        </ul>

        <p class="mint" style="margin:0.75rem 0 0.45rem"><strong>Workflows</strong></p>
        ${slots.tradeCraftTradeSvg}
        ${slots.tradeCraftLearnSvg}

        ${slots.tradeCraftLive}

        <p class="mint" style="margin:0.75rem 0 0.45rem"><strong>Operator checklist</strong></p>
        <ul>
          <li>Self-learn ON + Mode <code>auto</code> if you want micro/Level applies.</li>
          <li>Enable Learning Accelerators + CF apply hints when you want counterfactual preferences to steer soft ranks.</li>
          <li>Enable Profile RL if you want personal harvest soft coaching.</li>
          <li>Toggle <em>Live Mode Learning</em> only when intentionally training on Live (default OFF).</li>
          <li>Verify Harvest / Exits early→late on Bot Performance → Trade Craft Progress (Combined or per bot).</li>
        </ul>
        <p class="botinfo-where"><strong>Where to find:</strong> Bot Performance → <em>Trade Craft Progress</em> · Micro Bots → Peak Protect + Profit Capture Layer · Learning journal on Back Up · related chapters <em>Learning &amp; ML</em>, <em>Coaches &amp; Stack</em>, <em>Risk</em>.</p>
        <div class="botinfo-actions">
          ${btn('botperf', 'Open Trade Craft Progress')}
          ${btn('microbots', 'Open PPP / PCL')}
          ${btn('backup', 'Open learning journal')}
        </div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-coaches" data-botinfo-section="coaches">
        <h3><span class="botinfo-sec-num">08</span> Coaches &amp; learning stack</h3>
        <p>Every micro-bot can grow from closed trades with a layered coach stack. Layers are <strong>additive</strong>: safety wins first, stamped TP/SL stay hard, then soft coaches nudge ranking, size, TA, and learning signals. They are designed to support each other — not rewrite each other’s cores.</p>
        <div class="botinfo-callout"><strong>Isolation:</strong> each profile keeps its own episodes, self-learn overrides, ML model, TA playbook weights, and Profile RL agent. <strong>MARL</strong> is the shared team coach (per-profile preference weights in one team state) — not a clone of any bot’s private memory.</div>

        <p class="mint" style="margin:0 0 0.45rem"><strong>Who does what</strong></p>
        <ul>
          <li><strong>Episodes</strong> — durable “game film” on final closes (PnL, peak/giveback, TA stamps, timing quality). Source of truth for all learners.</li>
          <li><strong>Self-learning (delta)</strong> — mutates TP/SL/trail/hold/entry floors inside clamps (Level + micro); rollback on degradation. Primary hard mutator when Mode = <code>auto</code>.</li>
          <li><strong>ML advisor</strong> — ranks / blends patch ideas; shadow → hybrid → lead as sample grows. Never invents new strategies.</li>
          <li><strong>Profile TA + weight learning</strong> — per-lane Off/Soft/Hard confluence; learns tool weights / sensitivities only — never TP/SL or Peak Protect cores.</li>
          <li><strong>Profile RL</strong> — personal soft coach (setup-worth, size confidence, TA sensitivity, exit-hint aggressiveness). Shadow / Hybrid / Lead via readiness score (not trade count alone). Default global OFF.</li>
          <li><strong>HMC Gatekeeper</strong> — Phase 1 hierarchical coordination: allow/block before lane fight (volume, liquidity, safety, low-MC congestion). Hard safety never fails open. Soft blocks optional. Default ON · medium. High-MC <em>majors</em> Dip-watch handoffs soft-pass activity floors only (anti-rug / hard SL still absolute).</li>
          <li><strong>HMC Setup Classifier</strong> — Phase 2: setup → eligible specialist lanes (momentum / dip / migration / slow_quality). Soft eligibility ON = preferred lanes score normally, others still compete with a penalty; OFF = hard maps. Default classifier OFF.</li>
          <li><strong>MARL</strong> — team coach: lane ranking, size confidence, low-MC pile-in, lagging support. Soft only; never writes TP/SL. Default OFF.</li>
          <li><strong>Learning Accelerators</strong> — experience replay, counterfactual exit what-ifs, teacher→student soft TA tips. Offline/soft hints only. Master default OFF.</li>
          <li><strong>Peak Profit Protection</strong> — soft exit on peak giveback; arm/giveback can learn via self-learn exitPolicy. Never replaces hard TP. Detail under <em>Risk</em>.</li>
          <li><strong>Profit Capture Layer</strong> — exit-side harvest coach (permission window, partial+runner, PPP retune, learning reshape). Never disables hard SL / anti-rug. Detail under <em>Risk</em>.</li>
          <li><strong>Learning Mode</strong> — softens entry gates + fairness for low-sample bots. Does not bypass anti-rug or Require TA (except documented specialty exemptions).</li>
          <li><strong>Anti-rug / risk / Require TA</strong> — hard safety. Always win conflicts.</li>
          <li><strong>Zion</strong> — explains and supervises; does not mutate learning knobs or TP/SL.</li>
        </ul>

        <p class="mint" style="margin:0 0 0.45rem"><strong>Priority when layers overlap</strong></p>
        <ul>
          <li>0 · <strong>HMC Gatekeeper</strong> allow/block (before lanes)</li>
          <li>0b · <strong>HMC Setup Classifier</strong> eligible / preferred specialists (after allow)</li>
          <li>1 · Safety / anti-rug</li>
          <li>2 · Micro-bot hard rules &amp; stamped TP/SL</li>
          <li>3 · MARL team assignment / low-MC coordination</li>
          <li>4 · Profile RL soft confidence / TA / exit hints</li>
          <li>5 · TA playbooks, accelerators, Learning Mode</li>
          <li>6 · Self-learn + ML (actual knob mutations)</li>
          <li>Open · Peak Protect + PCL harvest (soft exits only)</li>
        </ul>
        <p>MARL and Profile RL both add soft score/size deltas (MARL first, then RL). Bounded stack — not a race to overwrite strategy. <strong>Global Micro-Bot TP</strong>, if set, pauses exit self-learning so one global TP does not fight per-bot exit evolution.</p>

        <p class="mint" style="margin:0.75rem 0 0.45rem"><strong>Major feature guides</strong></p>

        <p class="mint" style="margin:0.55rem 0 0.35rem"><strong>HMC Gatekeeper</strong> — door check before any lane fight</p>
        <ul>
          <li>Runs after enrich, before profiles compete. Allow = lanes may fight; Block = skip the mint.</li>
          <li>Checks volume (5m / 1h), liquidity, safety / anti-rug signals, and low-MC congestion-style soft findings.</li>
          <li>Hard safety never fails open. Soft blocks: Enforce soft blocks ON (medium/high) can block; Low strictness keeps soft findings advisory even when enforce is ON.</li>
          <li>Default ON · medium. Strictness Low / Medium / High scales activity floors. No TP/SL changes.</li>
        </ul>
        <div class="botinfo-callout"><strong>Live example:</strong> Think bouncer at a club. A mint with almost no 5m volume and thin liquidity gets a polite “not tonight” before Scalper and Dip Buyer even argue. A clean, liquid setup walks in and the lane fight starts.</div>
        <p class="botinfo-where"><strong>Where to find:</strong> Dashboard → Micro Bots → Profile routing <em>Learning</em> → <em>HMC Gatekeeper</em> card. Overview / Micro Bots lane fight log (HMC gate line). Bot Performance → Agent Decision Log → source HMC Gatekeeper.</p>

        <p class="mint" style="margin:0.55rem 0 0.35rem"><strong>HMC Setup Classifier</strong> — which specialists get to compete</p>
        <ul>
          <li>Phase 2, after Gatekeeper allow. Labels momentum / dip / migration / slow_quality (or unknown) and maps preferred + eligible specialist lanes.</li>
          <li>Maps (widened): momentum → MB / Scalper / Trend / Reversal / Steady · dip → Dip Buyer / Reversal / Scalper / Trend / Steady · migration → Sniper / Scalper / MB / Trend · slow_quality → HWR / Steady / SMM / Trend.</li>
          <li><strong>Soft eligibility ON</strong> (code default): preferred lanes score normally; others still fight with ~−15% score. <strong>OFF</strong> = hard maps (only eligible specialists). Many operators leave Soft OFF for sharper specialty focus.</li>
          <li>High-confidence clear winner (~≥0.65) can narrow; ambiguous / close-second / low conf widens to all specialists. Unknown setups can trade (default ON) keeps everyone in; OFF blocks unknown. Classifier master default OFF. No TP/SL changes.</li>
        </ul>
        <div class="botinfo-callout"><strong>Live example:</strong> A clear dip pullback: Classifier prefers Dip Buyer &amp; friends. With Soft ON, Trend Rider can still “raise a hand” but starts behind. With Soft OFF, only the dip map lanes enter the fight — like assigning the right specialist team, not letting every lane shout.</div>
        <p class="botinfo-where"><strong>Where to find:</strong> Micro Bots → <em>Learning</em> → <em>HMC Setup Classifier</em> card (under Gatekeeper). Lane fight rows show setup + eligible list. Agent Decision Log → HMC Classifier.</p>

        <p class="mint" style="margin:0.55rem 0 0.35rem"><strong>MARL</strong> — shared team coach for lane priority &amp; size</p>
        <ul>
          <li>Soft coordination only: reorders who should win the fight, trims size confidence, limits low-MC pile-ins, can support lagging lanes.</li>
          <li>One shared team state with per-profile preference weights — not a clone of each bot’s private episodes.</li>
          <li>Never writes TP/SL, timers, or self-learn overrides. Default OFF until you enable it.</li>
        </ul>
        <div class="botinfo-callout"><strong>Live example:</strong> Three bots all like the same tiny mint. MARL nudges “don’t all pile in at full size” and bumps the lane that has been earning lately — like a captain rotating who takes the shot.</div>
        <p class="botinfo-where"><strong>Where to find:</strong> Micro Bots → <em>Learning</em> → Multi-Agent RL card. Lane fight log + Agent Decision Log (MARL).</p>

        <p class="mint" style="margin:0.55rem 0 0.35rem"><strong>Profile RL</strong> — each bot’s personal soft coach</p>
        <ul>
          <li>Per-profile policy: setup-worth lane bump, size confidence, TA sensitivity, exit-hint aggressiveness.</li>
          <li>Shadow / Hybrid / Lead by readiness score (not trade count alone). Isolated memory per lane.</li>
          <li>Never mutates TP/SL, Peak Protect cores, or self-learn overrides. Default global OFF.</li>
        </ul>
        <div class="botinfo-callout"><strong>Live example:</strong> High Win-Rate’s private coach whispers “this setup looks like your winners — size up a touch / trust TA more,” while Scalper’s coach stays cautious. Same mint, different personal taste — without rewriting hard exits.</div>
        <p class="botinfo-where"><strong>Where to find:</strong> Micro Bots → <em>Learning</em> → Profile RL Agents card. Bot Performance → Agent Decision Log (Profile RL) + Learning Progress readiness.</p>

        <p class="mint" style="margin:0.55rem 0 0.35rem"><strong>Profit Capture Layer (as exit coach)</strong> — harvest habits while open</p>
        <ul>
          <li>Sits with Peak Protect on the open path: permission window → meaningful partial + runner → PPP protect. Learning reshape grades the film afterward.</li>
          <li>Additive with Peak Protect (detail + family timings under <em>Risk</em>). Hard SL / anti-rug always win.</li>
        </ul>
        <div class="botinfo-callout"><strong>Live example:</strong> Entry coaches picked the lane; PCL is the “don’t leave money on the table / don’t scratch too early” coach once you’re in. See Risk for the full harvest flow.</div>
        <p class="botinfo-where"><strong>Where to find:</strong> Micro Bots → Peak Protect + Profit Capture Layer cards · Risk chapter in this manual · open-position PCL/PPP lines · Bot Performance → <em>Trade Craft Progress</em>.</p>

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
          <li><strong>HMC Gatekeeper</strong> (after enrich) → <strong>Setup Classifier</strong> (if ON) → lane floors / match → Learning Mode fairness → <strong>MARL rank</strong> → <strong>Profile RL rank</strong> → filters / anti-rug → MARL/RL size → TA playbook gate → buy → <strong>PCL + Peak Protect</strong> while open.</li>
          <li><strong>Smart Bot Profiles</strong> must be ON for full lane + MARL/RL ranking. Size multipliers still apply at buy when coaches are enabled.</li>
        </ul>

        <p class="mint" style="margin:0.55rem 0 0.45rem"><strong>Why learning can look idle (gates, not fights)</strong></p>
        <ul>
          <li>Self-learn needs ~<strong>8+</strong> closed episodes; ML stays shadow longer (~50+ before hybrid).</li>
          <li>MARL, Profile RL, and Accelerators often default <strong>OFF</strong> until you enable them on Micro Bots.</li>
          <li>HMC Classifier defaults <strong>OFF</strong>; Gatekeeper defaults ON.</li>
          <li>Counterfactuals may stamp without steering unless apply-hints is ON.</li>
          <li>Self-learn Mode <code>shadow</code> = proposals only; use <code>auto</code> to apply.</li>
          <li>Partials do not create episodes — only final closes.</li>
          <li>Require TA / risk halt / max positions can limit how fast episode rings fill.</li>
        </ul>

        <div class="botinfo-callout"><strong>Activation checklist:</strong> Self-learn ON + Mode <code>auto</code> · ≥8 episodes per bot · Smart Bot Profiles ON · enable MARL / Profile RL if you want live coaching · review HMC Gatekeeper / Classifier · enable Peak Protect + PCL for harvest · enable Accelerators (+ CF apply hints if desired) · clear Global TP if exit evolution should run · review Require TA if scanners never open. Then more closed trades are what grow readiness, Level, and win quality.</div>
        <p class="mint" style="margin:0.45rem 0 0.55rem"><strong>Profit-protection learning film → Self-Learn / ML / RL:</strong> closed trades stamp denser PPP/PCL process fields (arm timing, near-miss, partial milestones, permission exits, CF looser/later/skip-partial). Self-Learn + ML nudge arm/giveback / permission / early partial on the exit-policy <em>micro</em> path; Profile RL rewards harvest outcomes and biases exit aggressiveness; MARL may soft-rank by avg capture/giveback only (never writes PPP). Soft craft alignment: when Trade Craft Harvest/Exits early→late slips ≥4, matching Timing/PPP/PCL candidates get a bounded soft boost (see <a href="#botinfo-sec-tradecraft" onclick="showBotInfoSection('tradecraft'); return false;">Trade Craft</a>). <strong>Checklist:</strong> Self-learn Mode <code>auto</code> · enable Profile RL / Accelerators (+ CF apply hints) for harvest · toggle Live Mode Learning only if training on Live (default OFF) · use Bot Performance → Trade Craft Progress to verify early→late Harvest/Exits improving.</p>
        <p class="mint" style="margin:0.45rem 0 0.55rem"><strong>Two logs:</strong> Overview / Micro Bots <em>lane fight log</em> = execution &amp; conflict feed (includes HMC Gate / Classifier when present). Bot Performance <em>Agent Decision Log</em> = coach reasoning/advice (HMC Gatekeeper, HMC Classifier, MARL, Profile RL, accelerators, TA, ML, Peak Protect, sparse Zion) — logging only.</p>
        <p class="mint" style="margin:0.45rem 0 0.55rem">Live status: Bot Performance → Learning Progress &amp; System Diagnostics + Agent Decision Log. Controls: Micro Bots → Learning → HMC / Self-Learn / Profile TA / Profile RL / MARL / Accelerators · Peak Protect / PCL cards below.</p>
        <div class="botinfo-actions">
          ${btn('microbots', 'Open Micro Bots coaches')}
          ${btn('botperf', 'Open Bot Performance')}
          ${btn('backup', 'Open learning journal')}
        </div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-scanners" data-botinfo-section="scanners">
        <h3><span class="botinfo-sec-num">09</span> Market scanners &amp; Pump.fun</h3>
        <p>The <strong>Live Feed</strong> tab is the market universe: autonomous scanner (Dex / GMGN / Birdeye + optional Jupiter trending), optional <strong>AlphaScan</strong> New/Soon/Bonded (default off), Pump.fun smart activity (early curve, near migration, migrations), playbooks, and re-entry watches.</p>
        <ul>
          <li><strong>Market Scanner</strong> — can buy without a wallet copy when TA / filters pass; often hybrid with copy convergence.</li>
          <li><strong>High-MC majors</strong> — additive Jupiter toptraded/organic feed (circulating MC ≥$100M, never FDV) → Dip support-dip watch (longer TTL, <em>majors</em> badge). On reclaim, soft-prefer Dip Buyer; Steady/Trend/HWR still share via lane fight. Never routed into Scalper Mode B. Launch/pump scanner for Scalper-family stays unchanged.</li>
          <li><strong>AlphaScan</strong> — additive Jupiter <code>/recent</code> + curve buckets: <strong>Soon</strong> = still on pump.fun curve → Migration Sniper grad-watch; <strong>Bonded</strong> = true post-grad (graduatedAt or curve-complete + min MC, default $25k) → Scalper / Reversal. Missing-curve alone is not Bonded. Does not replace Jupiter trending.</li>
          <li><strong>Pump.fun</strong> — bonding-curve progress, migration listener, Discover Pump SM for early smart money.</li>
          <li><strong>Regime / session</strong> — scanner can pause in risk-off; UTC Asia/EU/US session filter can block entries.</li>
          <li>Migrations and setup watches also surface on Overview.</li>
        </ul>
        <div class="botinfo-actions">${btn('scanner', 'Open Live Feed')}</div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-execution" data-botinfo-section="execution">
        <h3><span class="botinfo-sec-num">10</span> Jupiter, RPC &amp; MEV</h3>
        <p>Live buys/sells go through <strong>Jupiter</strong> swaps. Jupiter Tokens API also feeds organic score / trending for the scanner. Dual-lane RPC prefers free <strong>Helius</strong> (primary) + <strong>Alchemy</strong> (secondary / Zion) with automatic failover to <code>RPC_URL</code>, public Solana, then <code>RPC_SECONDARY</code>.</p>
        <ul>
          <li><strong>MEV / Jito</strong> — tip bundles and sandwich abort (live only; module <code>mev_protection</code>).</li>
          <li>Paper and Live Sim never send real swaps; they still use live marks when configured.</li>
          <li>Fund gate, denied mints, dead-token filters, and honeypot checks sit on the path before size/execute.</li>
        </ul>
        <div class="botinfo-actions">${btn('config', 'Open Config (MEV / RPC)')}</div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-zion" data-botinfo-section="zion">
        <h3><span class="botinfo-sec-num">11</span> Zion (KOL Token Scanner)</h3>
        <p>Zion is an isolated micro-bot: it watches KOL wallets and builds <strong>manual trade offers</strong> by default. Optional auto-send routes can execute top tiers into specialist profiles without changing Zion’s knobs.</p>
        <ul>
          <li>Knobs: min KOL wallets, MC band, size / TP / SL / trail defaults, auto-offer, Auto-send Platinum to HWR, Auto-send Gold to Smart Money.</li>
          <li>Popup tiers: <strong>Platinum</strong> (score ≥85, ≥10 KOLs, ≥$750k vol 1h — optional auto → HWR) · <strong>Gold</strong> (score ≥85, ≥8 KOLs, ≥$500k vol 1h — optional auto → Smart Money Mirror) · <strong>Green</strong> (score 70–84, ≥4 KOLs, ≥$250k vol) · else default teal. Holders &amp; risk row shows top10 / bundle / insider / dev / snipers / pro traders when known.</li>
          <li><strong>Gold → SMM auto-send</strong> (default OFF): when ON, Gold offers auto-open on Smart Money Mirror with SMM sizing/exits, synthetic decision, and lane-fight open; OFF stays manual Place Trade. Platinum → HWR stays exclusive (Platinum never routes to Gold/SMM). Both toggles work independently.</li>
          <li>Uses the secondary RPC lane so KOL scanning does not starve copy/trading.</li>
          <li>Separate from copy-monitor and market scanner entry paths. PCL/PPP still apply once a Zion-routed trade is open (same harvest stack).</li>
        </ul>
        <div class="botinfo-callout"><strong>Live example:</strong> Eight KOLs pile into a liquid mint at Gold tier. With Auto-send Gold ON, Smart Money Mirror opens it for you with SMM exits — you are not forced to tap Place Trade. Platinum still only auto-routes to High Win-Rate if that toggle is ON.</div>
        <p class="botinfo-where"><strong>Where to find:</strong> Dashboard → Zion → toggles <em>Auto-send Platinum to HWR</em> and <em>Auto-send Gold to Smart Money</em>. Offers appear as Zion popups; opens show on Overview / lane fight like other profiles.</p>
        <div class="botinfo-actions">${btn('zion', 'Open Zion')}</div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-copy" data-botinfo-section="copy">
        <h3><span class="botinfo-sec-num">12</span> Copy trading &amp; smart wallets</h3>
        <p>The monitor loop polls tracked wallets, scores quality, detects convergence / smart-money flow, then runs the same filter → profile → size path as scanner entries.</p>
        <ul>
          <li><strong>Smart Wallets</strong> — discover via Kolscan, GMGN, Birdeye, Dex, Axiom, Photon, BullX, Nansen, or paste manually.</li>
          <li><strong>Influencer Mirror</strong> (default OFF) — tagged influencer / top_pnl / whale / smart wallets with copyEnabled use a fast Smart Money Mirror buy path (optional copy-sells on matching positions only). Requires <code>smart_money_copy</code> + <code>smart_money_mirror</code>. Anti-rug / hard SL absolute. CSV + GMGN fail-soft import on the Smart Wallets tab.</li>
          <li><strong>Live trading wallets</strong> — main/burner slots; private keys stay on the server (env), never in backups.</li>
          <li>Pause in the header stops the monitor without shutting down the process.</li>
        </ul>
        <div class="botinfo-actions">${btn('wallets', 'Open Smart Wallets')}</div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-backtester" data-botinfo-section="backtester">
        <h3><span class="botinfo-sec-num">13</span> Backtester</h3>
        <p>Replay historical launches with Live-Sim-style decisions and exits. Paper-only — no live capital. Compare KPIs to recent Live Sim runs; breakdowns by Risk On/Off and profile.</p>
        <ul>
          <li><strong>Smart Advisor</strong> — shadow proposals from BT results; does not auto-apply to live.</li>
          <li><strong>Risk Recipe Optimizer</strong> — bounded search for recipe tweaks; still manual apply.</li>
          <li>Match-live Strict and lookback settings control how close the replay is to current filters.</li>
        </ul>
        <div class="botinfo-actions">${btn('backtester', 'Open Backtester')}</div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-alerts" data-botinfo-section="alerts">
        <h3><span class="botinfo-sec-num">14</span> Email &amp; notifications</h3>
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
        <h3><span class="botinfo-sec-num">15</span> Backup &amp; persistence</h3>
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
        <h3><span class="botinfo-sec-num">16</span> High-impact knobs</h3>
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
